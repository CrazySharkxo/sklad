// Точка входу: вхід, маршрутизація, макет, живе оновлення
import { api, isDemo } from './api.js';
import { esc, toast, debounce } from './util.js';
import { state, reloadData, can, ICON_BACK } from './core.js';
import { renderNav, updateBadge, setNavTab, homeHash } from './nav.js';
import { viewStock, viewItem, viewItemEdit } from './views/stock.js';
import { viewOp, viewJournal } from './views/ops.js';
import { viewKits, viewKit, viewKitEdit } from './views/kits.js';
import { viewInventory } from './views/inventory.js';
import { viewMore, viewReorder, viewLabels, viewImport } from './views/more.js';
import { viewOrders, viewOrder, viewOrderEdit, viewDepartments } from './views/orders.js';
import { viewUsers, viewUserEdit, viewRoles, viewRoleEdit } from './views/users.js';
import { viewNotifications } from './views/settings.js';
import { viewOutbox, outboxBannerText, startAutoFlush, OUTBOX_EVENT } from './outbox.js';
import { viewBackups, runCloudBackup } from './backup.js';

const ROUTES = [
  // [шаблон, екран, вкладка меню, чи перемальовувати при змінах від інших, потрібне право]
  [/^\/stock$/, (c) => viewStock(c), 'stock', true, 'stock.view'],
  [/^\/orders$/, (c) => viewOrders(c), 'orders', true, 'orders.view'],
  [/^\/order\/([\w-]+)$/, (c, m, q) => viewOrder(c, m[1], q), 'orders', true, 'orders.view'],
  [/^\/notifications$/, (c) => viewNotifications(c), 'notifications', false, 'admin'],
  [/^\/backups$/, (c) => viewBackups(c), 'backups', false, 'admin'],
  [/^\/outbox$/, (c) => viewOutbox(c), 'more', false, 'ops.edit'],
  [/^\/order-edit\/([\w-]+)$/, (c, m) => viewOrderEdit(c, m[1]), 'orders', false, 'orders.edit'],
  [/^\/departments$/, (c) => viewDepartments(c), 'departments', true, null],
  [/^\/item\/([\w-]+)$/, (c, m) => viewItem(c, m[1]), 'stock', true, 'stock.view'],
  [/^\/item-edit\/([\w-]+)$/, (c, m, q) => viewItemEdit(c, m[1], q), 'stock', false, 'stock.edit'],
  [/^\/op\/(in|out)$/, (c, m, q) => viewOp(c, m[1], q), 'stock', false, 'ops.edit'],
  [/^\/journal$/, (c) => viewJournal(c), 'journal', 'reload', 'ops.view'],
  [/^\/kits$/, (c) => viewKits(c), 'kits', true, 'kits.view'],
  [/^\/kit\/([\w-]+)$/, (c, m) => viewKit(c, m[1]), 'kits', true, 'kits.view'],
  [/^\/kit-edit\/([\w-]+)$/, (c, m) => viewKitEdit(c, m[1]), 'kits', false, 'kits.edit'],
  [/^\/inventory$/, (c) => viewInventory(c), 'inventory', false, 'ops.edit'],
  [/^\/reorder$/, (c) => viewReorder(c), 'reorder', true, 'stock.view'],
  [/^\/labels$/, (c) => viewLabels(c), 'labels', false, 'stock.view'],
  [/^\/import$/, (c) => viewImport(c), 'import', false, 'stock.edit'],
  [/^\/users$/, (c) => viewUsers(c), 'users', false, 'admin'],
  [/^\/user\/([\w-]+)$/, (c, m) => viewUserEdit(c, m[1]), 'users', false, 'admin'],
  [/^\/roles$/, (c) => viewRoles(c), 'users', false, 'admin'],
  [/^\/role\/([\w-]+)$/, (c, m) => viewRoleEdit(c, m[1]), 'users', false, 'admin'],
  [/^\/more$/, (c) => viewMore(c), 'more', false, null],
];

// розділи меню, їх порядок і стартова сторінка — js/nav.js

const app = document.getElementById('app');
let current = null; // { token, route, ctx }
let token = 0;

function shell() {
  app.innerHTML = `
    ${isDemo ? '<div class="banner demo">Демо-режим: дані зберігаються лише в цьому браузері. Спільна база підключається в js/config.js (див. README).</div>' : ''}
    <div class="banner update" id="upd" hidden>Є нова версія програми
      <button type="button" class="btn sm" id="upd-go">Оновити</button></div>
    <div class="banner offline" id="offline" hidden>Немає інтернету — прихід і видаток збережуться на пристрої та відправляться з появою мережі; решта змін зачекає</div>
    <a class="banner outbox" id="outbox-banner" href="#/outbox" hidden></a>
    <div class="layout">
      <nav class="nav" id="nav"></nav>
      <div class="page">
        <header class="top" id="top"></header>
        <main id="main"></main>
      </div>
    </div>`;
  renderNav();
  document.getElementById('upd-go').addEventListener('click', applyUpdate);
  if (updateFound) document.getElementById('upd').hidden = false;
  const off = document.getElementById('offline');
  const ob = document.getElementById('outbox-banner');
  const upd = () => {
    off.hidden = navigator.onLine && !state.offline;
    const t = outboxBannerText();
    ob.hidden = !t;
    ob.textContent = t ? `${t} — ${navigator.onLine ? 'відправляємо…' : 'відправимо з появою мережі'} · переглянути` : '';
  };
  addEventListener('online', upd);
  addEventListener('offline', upd);
  document.addEventListener(OUTBOX_EVENT, upd);
  document.addEventListener('sklad:data', upd);
  upd();
}

function route() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw || raw === '/') { location.replace(homeHash()); return; }
  const [path, qs] = raw.split('?');
  const query = new URLSearchParams(qs || '');
  const main = document.getElementById('main');
  const headerEl = document.getElementById('top');
  const my = ++token;
  const ctx = {
    main, headerEl,
    alive: () => my === token,
    header({ title, back, actions = '' }) {
      headerEl.innerHTML = `${back ? `<a class="icon-btn back" href="${back}" aria-label="Назад">${ICON_BACK}</a>` : ''}
        <h1>${esc(title)}</h1><div class="top-actions">${actions}</div>`;
      document.title = `${title} — Склад`;
    },
    notFound() {
      this.header({ title: 'Не знайдено', back: homeHash() });
      main.innerHTML = `<div class="empty-state"><p>Запис не знайдено — можливо, його видалили.</p><p><a class="btn" href="${homeHash()}">На головну</a></p></div>`;
    },
  };
  const found = ROUTES.find(([re]) => re.test(path));
  if (!found) { location.replace(homeHash()); return; }
  const [re, , tab, , perm] = found;
  let [, fn, , live] = found;
  if (perm && !can(perm)) {
    fn = (c) => {
      c.header({ title: 'Немає доступу' });
      c.main.innerHTML = `<div class="empty-state"><p>У вас немає доступу до цього розділу.</p>
        <p class="muted">Права видає адміністратор складу.</p>
        <p><a class="btn" href="${homeHash()}">На головну</a></p></div>`;
    };
    live = false;
  }
  setNavTab(tab);
  current = { token: my, live, ctx, path, rerender: () => fn(ctx, path.match(re), query) };
  main.innerHTML = '';
  window.scrollTo(0, 0);
  Promise.resolve(fn(ctx, path.match(re), query)).catch((e) => {
    console.error(e);
    toast(e.message || String(e), 'err');
  });
}

// зміни від інших користувачів: оновлюємо дані й перемальовуємо «живі» екрани
const onRemoteChange = debounce(async () => {
  try {
    await reloadData();
  } catch { return; }
  if (!current || current.token !== token) return;
  if (current.live === 'reload') current.ctx.reload?.();
  else if (current.live === true) {
    // не чіпаємо екран, поки людина друкує в полі пошуку
    const ae = document.activeElement;
    if (ae && ae.matches('input, textarea, select') && document.getElementById('main').contains(ae)) return;
    const y = window.scrollY;
    current.rerender();
    window.scrollTo(0, y);
  }
}, 700);

// сторінка «Ще» показує розділи, яким не вистачило місця в меню, і режим «Порядок меню»
document.addEventListener('sklad:nav', () => {
  if (current && current.token === token && current.path === '/more') current.rerender();
});

function loginView() {
  app.innerHTML = `
    <div class="login">
      <form class="card form" id="lf">
        <div class="brand big"><svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM12 13L3.5 8.3M12 13l8.5-4.7M12 13v8"/></svg>Склад</div>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary wide">Увійти</button>
        <p class="muted small">Акаунт створює адміністратор складу: Ще → Користувачі.</p>
      </form>
    </div>`;
  const f = document.getElementById('lf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      await api.signIn(f.email.value.trim(), f.password.value);
      await start();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------
// Оновлення програми: порівнюємо свою версію з тією, що на сервері
// ------------------------------------------------------------------
let updateFound = false;
async function checkUpdate() {
  if (!navigator.onLine || !window.APP_VERSION) return;
  try {
    const r = await fetch(`version.js?check=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const m = (await r.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] !== window.APP_VERSION) {
      updateFound = true;
      const el = document.getElementById('upd');
      if (el) el.hidden = false;
    }
  } catch { /* без мережі — перевіримо пізніше */ }
}
async function applyUpdate() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch { /* не страшно: сторінка й так візьме файли з сервера */ }
  location.reload();
}

let started = false;
async function start() {
  state.me = await api.userId();
  if (!state.me) { loginView(); return; }
  app.innerHTML = '<div class="loading">Завантаження…</div>';
  // прибрати з кошика все старше 30 днів; не вийшло (стара схема, мережа) — не страшно
  if (navigator.onLine) await api.purgeTrash().catch(() => {});
  try {
    await reloadData();
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><p>Не вдалося завантажити дані.</p><p class="err-text">${esc(e.message)}</p>
      <p><button class="btn primary" onclick="location.reload()">Спробувати ще</button></p></div>`;
    return;
  }
  shell();
  updateBadge();
  if (state.offline) toast(`Немає зʼєднання — показано дані станом на ${new Date(state.cachedAt).toLocaleString('uk-UA')}`, 'err', 6000);
  if (!started) {
    started = true;
    // офлайн-черга, щоденні сповіщення про прострочені, резервна копія (лише адміністратор) — у фоні, без блокування
    startAutoFlush();
    if (!state.offline) {
      api.notifyOverdue().catch(() => {});
      runCloudBackup().then((r) => { if (r?.ok) toast('Резервну копію збережено'); }).catch((e) => console.warn('backup', e));
    }
    // при запуску, коли програма знову на екрані, з появою мережі і раз на 10 хвилин
    setTimeout(checkUpdate, 3000);
    setInterval(checkUpdate, 10 * 60e3);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
    addEventListener('online', checkUpdate);
    addEventListener('hashchange', route);
    api.subscribe(onRemoteChange);
    api.onAuth((uid) => { if (!uid && state.me) location.reload(); });
  }
  route();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();
