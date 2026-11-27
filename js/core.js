// Спільний стан і компоненти, якими користуються всі екрани
import { api, isDemo, TRASH_DAYS, sortItems, permuteItems, attachExtras } from './api.js';
import { esc, fmtQty, fmtDate, norm, round, toast, confirmDialog } from './util.js';
import { scanCode } from './scanner.js';
import { applyPendingTo } from './outbox.js';

export const state = {
  items: [],         // живі позиції (без кошика)
  trashItems: [],    // у кошику, ще не старші TRASH_DAYS
  byId: new Map(),   // усі, разом із видаленими — щоб журнал показував назви
  kits: [],
  profiles: {},      // id → імʼя
  depOf: {},         // id користувача → id відділу
  departments: [],
  orders: [],
  trashOrders: [],
  perms: new Set(),  // права поточного користувача
  roles: [],
  owner: undefined,  // id головного адміністратора; null — не призначено; undefined — стара схема бази, без головного
  settings: { org_name: '', app_url: '', backup_at: null, category_order: [], nav_order: [] },  // несекретні налаштування (шапка документів, порядок категорій і меню)
  me: null,
  loaded: false,
  offline: false,    // дані взято з кешу на пристрої, сервер недоступний
  cachedAt: null,
};

// останній знімок даних — щоб програма відкривалася й без інтернету (лише спільна база)
const CACHE_KEY = 'sklad-cache-v1';
const isNetErr = (e) => /Немає зʼєднання|Failed to fetch|NetworkError|Load failed/i.test(e?.message || '');

function fill({ items, kits, profiles, departments, orders, perms, roles, settings, owner }) {
  state.perms = new Set(perms);
  state.roles = roles;
  state.owner = owner;
  state.items = items.filter((i) => !i.deleted_at);
  state.trashItems = items.filter((i) => inTrash(i.deleted_at));
  state.byId = new Map(items.map((i) => [i.id, i]));
  state.kits = kits;
  state.profiles = Object.fromEntries(profiles.map((p) => [p.id, p.display_name]));
  state.depOf = Object.fromEntries(profiles.map((p) => [p.id, p.department_id]));
  state.departments = departments;
  state.orders = orders.filter((o) => !o.deleted_at);
  // кошик — це дії (відновити / видалити назавжди): лише замовлення, з якими людина може діяти
  state.trashOrders = orders.filter((o) => inTrash(o.deleted_at) && canActOrder(o));
  state.settings = settings || state.settings;
  state.loaded = true;
}

export async function reloadData() {
  let snap;
  try {
    const [items, kits, profiles, departments, orders, perms, roles, settings, owner, extras] = await Promise.all([
      api.items(), api.kits(), api.profiles(), api.departments(), api.orders(), api.myPerms(), api.roles(),
      api.settings().catch(() => null),  // стара схема без app_settings — не привід падати
      api.ownerId(),                     // стара схема без головного адміністратора — undefined
      api.orderExtras(),                 // видачі замовнику й борги; стара схема без них — null
    ]);
    attachExtras(orders, extras);
    snap = { items, kits, profiles, departments, orders, perms, roles, settings, owner, me: state.me, at: new Date().toISOString() };
    state.offline = false;
    state.cachedAt = null;
    if (!isDemo) try { localStorage.setItem(CACHE_KEY, JSON.stringify(snap)); } catch { /* тісно — без кешу */ }
    // те, що ще в офлайн-черзі, сервер не бачить — показуємо так, як буде після відправки
    applyPendingTo(snap.items);
  } catch (e) {
    if (isDemo || !isNetErr(e)) throw e;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { /* */ }
    if (!cached || cached.me !== state.me) throw e;
    snap = cached;
    applyPendingTo(snap.items);
    state.offline = true;
    state.cachedAt = cached.at;
  }
  fill(snap);
  document.dispatchEvent(new Event('sklad:data'));
}

export const clearCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* */ } };

export const go = (hash) => { location.hash = hash; };

// ------------------------------------------------------------------
// Права: розділ × дія + окремі. Адміністратор може все.
// ------------------------------------------------------------------
export const PERM_SECTIONS = [
  ['stock', 'Склад', 'позиції й залишки'],
  ['ops', 'Прихід / видаток', 'журнал, інвентаризація'],
  ['kits', 'Комплекти', ''],
  ['orders', 'Замовлення', ''],
];
export const PERM_ACTIONS = [['view', 'Перегляд'], ['edit', 'Зміна'], ['delete', 'Видалення']];
export const PERM_EXTRA = [
  ['orders.all', 'Замовлення всіх відділів', 'без цього людина бачить лише замовлення свого відділу — ті, що він створив або що через нього проходили'],
  ['admin', 'Адміністратор', 'відділи, налаштування, копії — і всі інші права'],
];
export const can = (p) => state.perms.has('admin') || state.perms.has(p);
// Користувачами й ролями керує лише головний адміністратор (сервер перевіряє те саме).
// На базі зі старою схемою головного ще немає як поняття — тоді, як раніше, будь-який адміністратор.
export const isOwner = (id) => !!id && state.owner === id;
export const canManageUsers = () => can('admin') && (state.owner === undefined || state.owner === state.me);
// Порядок меню, позицій і категорій теж міняє лише головний (на старій схемі — будь-який адміністратор)
export const canOrder = canManageUsers;
export const roleName = (id) => state.roles.find((r) => r.id === id)?.name || 'без ролі';

// ------------------------------------------------------------------
// Кошик: видалене лежить TRASH_DAYS днів, потім прибирається (purge_trash)
// ------------------------------------------------------------------
export const inTrash = (ts) => !!ts && Date.now() - Date.parse(ts) < TRASH_DAYS * 864e5;
export const daysLeft = (ts) => Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - Date.parse(ts)) / 864e5));
export const trashNote = (ts, by) => `видалено ${fmtDate(ts)} · ${esc(userName(by))} · зникне через ${daysLeft(ts)} дн.`;

// рядок кошика: title/meta — уже готовий HTML
export const trashRow = ({ id, title, meta = '', deletedAt, deletedBy }) => `
  <div class="row trash-row" data-id="${esc(id)}">
    <div class="row-main"><div class="row-title">${title}</div>
      <div class="row-meta">${meta ? `${meta} · ` : ''}${trashNote(deletedAt, deletedBy)}</div></div>
    <div class="trash-acts">
      <button type="button" class="btn ghost sm" data-restore>Відновити</button>
      <button type="button" class="btn ghost sm del-btn" data-purge>Видалити назавжди</button>
    </div>
  </div>`;

// кнопки «Відновити» / «Видалити назавжди» у списку кошика
export function bindTrash(root, { restore, purge, purgeText, after }) {
  root.addEventListener('click', async (e) => {
    const row = e.target.closest('.trash-row');
    const btn = e.target.closest('[data-restore], [data-purge]');
    if (!row || !btn) return;
    const id = row.dataset.id;
    const isPurge = 'purge' in btn.dataset;
    if (isPurge && !await confirmDialog(purgeText(id), { ok: 'Видалити назавжди', danger: true })) return;
    btn.disabled = true;
    try {
      await (isPurge ? purge(id) : restore(id));
      await reloadData();
      toast(isPurge ? 'Видалено назавжди' : 'Відновлено');
      after();
    } catch (err) {
      toast(err.message, 'err', 8000);
      btn.disabled = false;
    }
  });
}

export const TRASH_EMPTY = `<div class="empty-state"><p>Кошик порожній.</p>
  <p class="muted">Видалене лежить тут ${TRASH_DAYS} днів — його можна відновити. Потім воно зникає саме.</p></div>`;
export const userName = (id) => (id && state.profiles[id]) || (id ? 'Користувач' : '—');
export const depName = (id) => state.departments.find((d) => d.id === id)?.name || (id ? 'відділ видалено' : 'без відділу');
export const myDepartment = () => {
  const id = state.depOf[state.me];
  return state.departments.some((d) => d.id === id) ? id : null;
};
// замовлення, що зараз чекають на мій відділ
export const ACTIVE_ORDER = ['new', 'in_work', 'testing', 'rework', 'done'];
export const waitingForMe = () => {
  const dep = myDepartment();
  return dep ? state.orders.filter((o) => o.department_id === dep && ACTIVE_ORDER.includes(o.status)) : [];
};
// причетність відділу: зараз у ньому, він створив, або замовлення через нього проходило
// (orders.dept_path / origin_department_id у schema.sql). На базі, де цих колонок ще немає
// (schema.sql не запускали), — лише «зараз у ньому», як було раніше.
export const hasDeptPath = (o) => Array.isArray(o.dept_path);
export const involvesDep = (o, dep) => !!dep && (o.department_id === dep
  || (hasDeptPath(o) && (o.dept_path.includes(dep) || o.origin_department_id === dep)));
// діяти із замовленням (передати, видати, змінити) може відділ, у якому воно зараз, або людина з orders.all —
// те саме, що can_see_order у schema.sql; причетний відділ, який уже передав замовлення далі, лише дивиться
export const canActOrder = (o) => can('orders.all') || (o.department_id || null) === (state.depOf[state.me] || null);
export const activeItems = () => state.items.filter((i) => !i.archived);
export const isLow = (i) => i.min_qty > 0 && i.qty < i.min_qty;
// резерв під активні замовлення і вільний залишок
export const reservedOf = (i) => Number(i?.reserved) || 0;
export const freeQty = (i) => round((i?.qty || 0) - reservedOf(i));
// видача готових виробів замовнику: скільки вже видано і скільки лишилось
export const shippedQty = (o) => round((o.shipments || []).reduce((s, x) => s + x.qty, 0));
export const shipLeft = (o) => Math.max(0, round(o.qty - shippedQty(o)));
// борг перед замовником: видано неповним комплектом, ще не все довидано (скасоване замовлення нікому не винне)
export const openDebts = (o) => (o.status === 'cancelled' ? [] : (o.debts || []).filter((d) => d.left_qty > 0));
export const hasDebt = (o) => openDebts(o).length > 0;
// замовлення, що тримають резерв на позицію (для картки позиції): деталі активних і борги замовникам
export const reservingOrders = (itemId) => state.orders.filter((o) => (ACTIVE_ORDER.includes(o.status) && o.parts.some((p) => p.item_id === itemId))
  || openDebts(o).some((d) => d.item_id === itemId));

// терміни замовлень
export const daysToDue = (o) => (o.due_date ? Math.round((Date.parse(`${o.due_date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5) : null);
export const isOverdue = (o) => ACTIVE_ORDER.includes(o.status) && daysToDue(o) < 0;
export const isDueSoon = (o) => ACTIVE_ORDER.includes(o.status) && daysToDue(o) !== null && daysToDue(o) >= 0 && daysToDue(o) <= 2;
// «сьогодні», «завтра», «через 5 дн.», «прострочено на 3 дн.»
export function dueText(o) {
  const d = daysToDue(o);
  if (d === null) return '';
  if (!ACTIVE_ORDER.includes(o.status)) return '';
  if (d < 0) return `прострочено на ${-d} дн.`;
  if (d === 0) return 'сьогодні';
  if (d === 1) return 'завтра';
  return `через ${d} дн.`;
}

// виріб за серійним номером (у всіх замовленнях, разом із кошиком)
export function findUnit(serial) {
  const s = String(serial || '').trim().toLowerCase();
  if (!s) return null;
  for (const o of [...state.orders, ...state.trashOrders]) {
    const u = o.units.find((x) => x.serial.toLowerCase() === s);
    if (u) return { order: o, unit: u };
  }
  return null;
}
// що означає відсканований код: позиція, виріб або нічого
export function resolveCode(code) {
  const c = String(code || '').trim();
  if (c.startsWith('SN:')) { const r = findUnit(c.slice(3)); return r ? { ...r, kind: 'unit' } : null; }
  const item = findByCode(c);
  if (item) return { kind: 'item', item };
  const r = findUnit(c);
  return r ? { ...r, kind: 'unit' } : null;
}
// категорії: спершу в збереженому порядку (спільному для всіх), решта — в кінці за абеткою
export const categories = () => {
  const all = [...new Set(state.items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  const saved = [...new Set(state.settings.category_order || [])].filter((c) => all.includes(c));
  return [...saved, ...all.filter((c) => !saved.includes(c))];
};
// Новий порядок одразу на екрані, ще до відповіді сервера; обидві повертають «повернути як було».
// ids — позиції в новому порядку (можна лише видиму частину списку, див. permuteItems)
export function applyItemOrder(ids) {
  const all = [...state.byId.values()];
  const snap = { items: state.items, places: all.map((i) => [i, i.sort_order]) };
  permuteItems(all, ids);
  state.items = sortItems(state.items.slice());
  return () => {
    for (const [i, place] of snap.places) i.sort_order = place;
    state.items = snap.items;
  };
}
export function applyCategoryOrder(names) {
  const old = state.settings;
  state.settings = { ...old, category_order: names };
  return () => { state.settings = old; };
}
// ids — ключі розділів меню в новому порядку (js/nav.js)
export function applyNavOrder(ids) {
  const old = state.settings;
  state.settings = { ...old, nav_order: ids };
  return () => { state.settings = old; };
}
export const locations = () => [...new Set(state.items.map((i) => i.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
export const units = () => [...new Set(['шт', 'м', 'кг', 'г', 'л', 'компл', 'уп', 'пара', ...state.items.map((i) => i.unit).filter(Boolean)])];

// на скільки комплектів вистачає одного компонента; free — рахувати від вільного (без резерву під замовлення)
export function componentCapacity(c, free = false) {
  const it = state.byId.get(c.item_id);
  if (!it || !(c.qty > 0)) return 0;
  return Math.max(0, Math.floor(round((free ? freeQty(it) : it.qty) / c.qty)));
}
// скільки комплектів можна видати з поточних залишків (free — з вільного, без резерву під замовлення)
export function kitCapacity(kit, free = false) {
  if (!kit.components.length) return 0;
  return Math.min(...kit.components.map((c) => componentCapacity(c, free)));
}
// позиції, яких на складі менше, ніж обіцяно активним замовленням і замовникам у борг (резерв рахує сервер — за всіма відділами)
export const shortOf = (i) => Math.max(0, round(reservedOf(i) - (i?.qty || 0)));
export const shortItems = () => state.items.filter((i) => shortOf(i) > 0);

// пошук: всі слова запиту мають знайтися в назві / коді / категорії / місці
export function searchItems(query, list = activeItems()) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((i) => {
    const hay = norm(`${i.name} ${i.code || ''} ${i.category} ${i.location} ${i.note}`);
    return words.every((w) => hay.includes(w));
  });
}

// позиція за відсканованим кодом (власний код або наша етикетка SKL:<id>)
export function findByCode(code) {
  if (!code) return null;
  const c = code.trim();
  if (c.startsWith('SKL:')) return state.byId.get(c.slice(4)) || null;
  const lc = c.toLowerCase();
  return state.items.find((i) => i.code && i.code.toLowerCase() === lc) || null;
}

// ------------------------------------------------------------------
// Фото: <img data-photo="path"> отримують адресу після рендеру
// ------------------------------------------------------------------
export async function hydratePhotos(root) {
  const imgs = [...root.querySelectorAll('img[data-photo]')];
  if (!imgs.length) return;
  try {
    const urls = await api.photoUrls(imgs.map((i) => i.dataset.photo));
    for (const img of imgs) {
      const u = urls[img.dataset.photo];
      if (u) { img.src = u; img.removeAttribute('data-photo'); }
    }
  } catch { /* без фото теж працює */ }
}

export function thumb(path, cls = 'thumb') {
  return path
    ? `<img class="${cls}" data-photo="${esc(path)}" alt="" loading="lazy">`
    : `<div class="${cls} empty" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM12 13L3.5 8.3M12 13l8.5-4.7M12 13v8"/></svg></div>`;
}

// ------------------------------------------------------------------
// Вибір позиції: поле пошуку з підказками + кнопка сканера
// ------------------------------------------------------------------
const PICKER_FIRST = 50;  // стільки позицій показує порожнє поле (список прокручується)
export function itemPicker(container, onPick, { placeholder = 'Додати позицію: назва або код…', showQty = true } = {}) {
  container.classList.add('picker');
  container.innerHTML = `<div class="picker-row">
      <input type="search" placeholder="${esc(placeholder)}" autocomplete="off">
      <button type="button" class="icon-btn scan-btn" title="Сканувати код" aria-label="Сканувати код">${ICON_SCAN}</button>
    </div><div class="picker-list" hidden></div>`;
  const input = container.querySelector('input');
  const list = container.querySelector('.picker-list');
  let found = [];
  let active = 0;
  let hideTimer = 0;
  let quiet = false;   // фокус повернули самі після вибору — список знову не розкриваємо

  const hide = () => { list.hidden = true; found = []; active = -1; };
  // Порожнє поле — перші позиції в порядку складу (видно, що можна вибрати), без підсвіченої:
  // Enter у порожньому полі нічого не додає. Далі — пошук за введеним.
  const render = () => {
    clearTimeout(hideTimer);
    const q = input.value.trim();
    let more = 0;
    if (q) {
      const exact = findByCode(q);
      found = searchItems(q).slice(0, 8);
      if (exact && !found.includes(exact)) found.unshift(exact);
      active = 0;
    } else {
      const all = activeItems();
      found = all.slice(0, PICKER_FIRST);
      more = all.length - found.length;
      active = -1;
    }
    list.hidden = false;
    list.innerHTML = found.length
      ? found.map((i, n) => `<button type="button" class="picker-opt${n === active ? ' on' : ''}" data-id="${i.id}" tabindex="-1">
          <span>${esc(i.name)}${i.code ? ` <small>${esc(i.code)}</small>` : ''}</span>
          ${showQty ? `<small class="muted">${fmtQty(i.qty)} ${esc(i.unit)}${reservedOf(i) ? ` · вільно ${fmtQty(freeQty(i))}` : ''}</small>` : ''}</button>`).join('')
        + (more > 0 ? `<div class="picker-empty">…і ще ${more} — введіть назву або код</div>` : '')
      : `<div class="picker-empty">${q ? 'Нічого не знайдено' : 'На складі ще немає позицій'}</div>`;
    list.scrollTop = 0;
  };
  const choose = (item) => {
    input.value = '';
    hide();
    onPick(item);
    quiet = true;
    input.focus();
    quiet = false;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => { if (!quiet) render(); });
  input.addEventListener('click', () => { if (list.hidden) render(); });  // повторний клік у вже сфокусоване поле
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) render();
      if (!found.length) return;
      const down = e.key === 'ArrowDown';
      active = active < 0 ? (down ? 0 : found.length - 1) : (active + (down ? 1 : found.length - 1)) % found.length;
      list.querySelectorAll('.picker-opt').forEach((b, n) => {
        b.classList.toggle('on', n === active);
        if (n === active) b.scrollIntoView({ block: 'nearest' });
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const exact = findByCode(input.value);
      if (exact) choose(exact);
      else if (found[active]) choose(found[active]);
    } else if (e.key === 'Escape') {
      hide();
    }
  });
  // mousedown не забирає фокус у поля, тож blur не ховає список раніше за клік
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) choose(state.byId.get(b.dataset.id));
  });
  input.addEventListener('blur', () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 150); });
  container.querySelector('.scan-btn').addEventListener('click', async () => {
    const code = await scanCode();
    if (!code) return;
    const item = findByCode(code);
    if (item) choose(item);
    else { input.value = code; render(); }
  });
  return input;
}

// ------------------------------------------------------------------
// Поле з випадним списком наявних значень (замість <datalist>, який на Android
// не розкривається під полем). Можна вибрати зі списку або надрукувати своє.
// getOptions() → масив рядків; викликається щоразу, тож список може підвантажитись пізніше.
// ------------------------------------------------------------------
export function comboInput(input, getOptions) {
  const wrap = document.createElement('div');
  wrap.className = 'picker combo';
  input.before(wrap);
  wrap.append(input);
  const list = document.createElement('div');
  list.className = 'picker-list combo-list';
  list.hidden = true;
  wrap.append(list);
  input.autocomplete = 'off';
  let found = [];
  let active = -1;

  const mark = () => list.querySelectorAll('.picker-opt').forEach((b, n) => {
    b.classList.toggle('on', n === active);
    if (n === active) b.scrollIntoView({ block: 'nearest' });
  });
  const hide = () => { list.hidden = true; active = -1; window.visualViewport?.removeEventListener('resize', fit); };
  // filter=false (дотик у вже заповнене поле) — показати всі варіанти, а не лише поточний
  const show = (filter) => {
    const q = filter ? norm(input.value) : '';
    const seen = new Set();
    found = (getOptions() || []).filter((o) => {
      const k = norm(o);
      if (!k || seen.has(k) || (q && !k.includes(q))) return false;
      seen.add(k);
      return true;
    });
    active = -1;
    if (!found.length) { list.hidden = true; return; }
    const cur = norm(input.value);
    list.innerHTML = found.map((o, n) => `<button type="button" class="picker-opt" data-n="${n}" tabindex="-1">
      <span>${esc(o)}</span>${norm(o) === cur ? '<small>✓</small>' : ''}</button>`).join('');
    list.hidden = false;
    list.scrollTop = 0;
    fit();
    window.visualViewport?.addEventListener('resize', fit); // клавіатура виїжджає вже після фокуса
  };
  // список не має ховатись за нижнім краєм екрана чи екранною клавіатурою: підкручуємо сторінку,
  // але не далі, ніж поле лишається видимим під шапкою
  const fit = () => {
    if (list.hidden) return;
    const vv = window.visualViewport;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const over = list.getBoundingClientRect().bottom + 8 - bottom;
    const room = input.getBoundingClientRect().top - (vv ? vv.offsetTop : 0) - 70;
    if (over > 0 && room > 0) window.scrollBy(0, Math.min(over, room));
  };
  const choose = (value) => {
    input.value = value;
    hide();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  input.addEventListener('focus', () => show(false));
  input.addEventListener('click', () => { if (list.hidden) show(false); });
  input.addEventListener('input', () => show(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) show(false);
      if (!found.length) return;
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      active = active < 0 ? (down ? 0 : found.length - 1) : (active + (down ? 1 : found.length - 1)) % found.length;
      mark();
    } else if (e.key === 'Enter') {
      // без підсвіченого варіанта Enter працює як завжди (відправляє форму)
      if (!list.hidden && found[active] !== undefined) { e.preventDefault(); choose(found[active]); }
    } else if (e.key === 'Escape') {
      hide();
    }
  });
  // mousedown не забирає фокус у поля, тож blur не ховає список раніше за клік
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    e.preventDefault(); // поле стоїть у <label>: клік по варіанту не має ще раз «натискати» поле
    const b = e.target.closest('[data-n]');
    if (b) choose(found[+b.dataset.n]);
  });
  input.addEventListener('blur', hide);
  return input;
}

export const ICON_SCAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>';
export const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
export const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
