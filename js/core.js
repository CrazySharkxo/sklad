// Спільний стан і компоненти, якими користуються всі екрани
import { api, isDemo, TRASH_DAYS } from './api.js';
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
  settings: { org_name: '', app_url: '', backup_at: null },  // несекретні налаштування (шапка документів)
  me: null,
  loaded: false,
  offline: false,    // дані взято з кешу на пристрої, сервер недоступний
  cachedAt: null,
};

// останній знімок даних — щоб програма відкривалася й без інтернету (лише спільна база)
const CACHE_KEY = 'sklad-cache-v1';
const isNetErr = (e) => /Немає зʼєднання|Failed to fetch|NetworkError|Load failed/i.test(e?.message || '');

function fill({ items, kits, profiles, departments, orders, perms, roles, settings }) {
  state.perms = new Set(perms);
  state.roles = roles;
  state.items = items.filter((i) => !i.deleted_at);
  state.trashItems = items.filter((i) => inTrash(i.deleted_at));
  state.byId = new Map(items.map((i) => [i.id, i]));
  state.kits = kits;
  state.profiles = Object.fromEntries(profiles.map((p) => [p.id, p.display_name]));
  state.depOf = Object.fromEntries(profiles.map((p) => [p.id, p.department_id]));
  state.departments = departments;
  state.orders = orders.filter((o) => !o.deleted_at);
  state.trashOrders = orders.filter((o) => inTrash(o.deleted_at));
  state.settings = settings || state.settings;
  state.loaded = true;
}

export async function reloadData() {
  let snap;
  try {
    const [items, kits, profiles, departments, orders, perms, roles, settings] = await Promise.all([
      api.items(), api.kits(), api.profiles(), api.departments(), api.orders(), api.myPerms(), api.roles(),
      api.settings().catch(() => null),  // стара схема без app_settings — не привід падати
    ]);
    snap = { items, kits, profiles, departments, orders, perms, roles, settings, me: state.me, at: new Date().toISOString() };
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
  ['orders.all', 'Замовлення всіх відділів', 'без цього людина бачить лише замовлення свого відділу'],
  ['admin', 'Адміністратор', 'користувачі, ролі, відділи — і всі інші права'],
];
export const can = (p) => state.perms.has('admin') || state.perms.has(p);
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
export const activeItems = () => state.items.filter((i) => !i.archived);
export const isLow = (i) => i.min_qty > 0 && i.qty < i.min_qty;
// резерв під активні замовлення і вільний залишок
export const reservedOf = (i) => Number(i?.reserved) || 0;
export const freeQty = (i) => round((i?.qty || 0) - reservedOf(i));
// замовлення, що тримають резерв на позицію (для картки позиції)
export const reservingOrders = (itemId) => state.orders.filter((o) => ACTIVE_ORDER.includes(o.status) && o.parts.some((p) => p.item_id === itemId));

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
export const categories = () => [...new Set(state.items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
export const locations = () => [...new Set(state.items.map((i) => i.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
export const units = () => [...new Set(['шт', 'м', 'кг', 'г', 'л', 'компл', 'уп', 'пара', ...state.items.map((i) => i.unit).filter(Boolean)])];

// скільки комплектів можна видати з поточних залишків
export function kitCapacity(kit) {
  if (!kit.components.length) return 0;
  let n = Infinity;
  for (const c of kit.components) {
    const it = state.byId.get(c.item_id);
    n = Math.min(n, it ? Math.floor(round(it.qty / c.qty)) : 0);
  }
  return Math.max(0, n === Infinity ? 0 : n);
}

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

  const render = () => {
    const q = input.value.trim();
    if (!q) { list.hidden = true; return; }
    const exact = findByCode(q);
    found = searchItems(q).slice(0, 8);
    if (exact && !found.includes(exact)) found.unshift(exact);
    active = 0;
    list.hidden = false;
    list.innerHTML = found.length
      ? found.map((i, n) => `<button type="button" class="picker-opt${n === 0 ? ' on' : ''}" data-id="${i.id}">
          <span>${esc(i.name)}${i.code ? ` <small>${esc(i.code)}</small>` : ''}</span>
          ${showQty ? `<small class="muted">${fmtQty(i.qty)} ${esc(i.unit)}${reservedOf(i) ? ` · вільно ${fmtQty(freeQty(i))}` : ''}</small>` : ''}</button>`).join('')
      : '<div class="picker-empty">Нічого не знайдено</div>';
  };
  const choose = (item) => {
    input.value = '';
    list.hidden = true;
    onPick(item);
    input.focus();
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!found.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
      list.querySelectorAll('.picker-opt').forEach((b, n) => b.classList.toggle('on', n === active));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const exact = findByCode(input.value);
      if (exact) choose(exact);
      else if (found[active]) choose(found[active]);
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
  // mousedown не забирає фокус у поля, тож blur не ховає список раніше за клік
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) choose(state.byId.get(b.dataset.id));
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  container.querySelector('.scan-btn').addEventListener('click', async () => {
    const code = await scanCode();
    if (!code) return;
    const item = findByCode(code);
    if (item) choose(item);
    else { input.value = code; render(); }
  });
  return input;
}

export const ICON_SCAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>';
export const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
export const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
