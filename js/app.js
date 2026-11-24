// Точка входу: вхід, маршрутизація, макет, живе оновлення
import { api, isDemo } from './api.js';
import { esc, toast, debounce } from './util.js';
import { state, reloadData, waitingForMe, can, ICON_BACK } from './core.js';
import { viewStock, viewItem, viewItemEdit } from './views/stock.js';
import { viewOp, viewJournal } from './views/ops.js';
import { viewKits, viewKit, viewKitEdit } from './views/kits.js';
import { viewInventory } from './views/inventory.js';
import { viewMore, viewReorder, viewLabels, viewImport } from './views/more.js';
import { viewOrders, viewOrder, viewOrderEdit, viewDepartments } from './views/orders.js';
import { viewUsers, viewUserEdit, viewRoles, viewRoleEdit } from './views/users.js';

const ROUTES = [
  // [шаблон, екран, вкладка меню, чи перемальовувати при змінах від інших, потрібне право]
  [/^\/stock$/, (c) => viewStock(c), 'stock', true, 'stock.view'],
  [/^\/orders$/, (c) => viewOrders(c), 'orders', true, 'orders.view'],
  [/^\/order\/([\w-]+)$/, (c, m) => viewOrder(c, m[1]), 'orders', true, 'orders.view'],
  [/^\/order-edit\/([\w-]+)$/, (c, m) => viewOrderEdit(c, m[1]), 'orders', false, 'orders.edit'],
  [/^\/departments$/, (c) => viewDepartments(c), 'more', true, null],
  [/^\/item\/([\w-]+)$/, (c, m) => viewItem(c, m[1]), 'stock', true, 'stock.view'],
  [/^\/item-edit\/([\w-]+)$/, (c, m, q) => viewItemEdit(c, m[1], q), 'stock', false, 'stock.edit'],
  [/^\/op\/(in|out)$/, (c, m, q) => viewOp(c, m[1], q), 'stock', false, 'ops.edit'],
  [/^\/journal$/, (c) => viewJournal(c), 'journal', 'reload', 'ops.view'],
  [/^\/kits$/, (c) => viewKits(c), 'kits', true, 'kits.view'],
  [/^\/kit\/([\w-]+)$/, (c, m) => viewKit(c, m[1]), 'kits', true, 'kits.view'],
  [/^\/kit-edit\/([\w-]+)$/, (c, m) => viewKitEdit(c, m[1]), 'kits', false, 'kits.edit'],
  [/^\/inventory$/, (c) => viewInventory(c), 'inventory', false, 'ops.edit'],
  [/^\/reorder$/, (c) => viewReorder(c), 'more', true, 'stock.view'],
  [/^\/labels$/, (c) => viewLabels(c), 'more', false, 'stock.view'],
  [/^\/import$/, (c) => viewImport(c), 'more', false, 'stock.edit'],
  [/^\/users$/, (c) => viewUsers(c), 'more', false, 'admin'],
  [/^\/user\/([\w-]+)$/, (c, m) => viewUserEdit(c, m[1]), 'more', false, 'admin'],
  [/^\/roles$/, (c) => viewRoles(c), 'more', false, 'admin'],
  [/^\/role\/([\w-]+)$/, (c, m) => viewRoleEdit(c, m[1]), 'more', false, 'admin'],
  [/^\/more$/, (c) => viewMore(c), 'more', false, null],
];

// [вкладка, адреса, назва, іконка, лише на широкому екрані]
const NAV = [
  ['orders', '#/orders', 'Замовлення', '<path d="M9 3h6v4H9zM9 5H5v16h14V5h-4M8 12h8M8 16h5"/>', false, 'orders.view'],
  ['stock', '#/stock', 'Залишки', '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM12 13L3.5 8.3M12 13l8.5-4.7M12 13v8"/>', false, 'stock.view'],
  ['journal', '#/journal', 'Журнал', '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', false, 'ops.view'],
  ['kits', '#/kits', 'Комплекти', '<path d="M4 7h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 16h7v4H4z"/>', false, 'kits.view'],
  // на телефоні інвентаризація — у «Ще», щоб нижнє меню не тіснилося
  ['inventory', '#/inventory', 'Інвентар', '<path d="M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>', true, 'ops.edit'],
  ['more', '#/more', 'Ще', '<path d="M5 12h.01M12 12h.01M19 12h.01"/>', false, null],
];

// скільки замовлень чекає на мій відділ — число на вкладці
function updateBadge() {
  const el = document.querySelector('#nav [data-tab="orders"] .nav-badge');
  if (!el) return;
  const n = waitingForMe().length;
  el.textContent = n > 99 ? '99+' : String(n);
  el.hidden = !n;
}

const allowedNav = () => NAV.filter(([, , , , , perm]) => !perm || can(perm));
// перша дозволена вкладка — туди ведемо замість порожньої адреси
const homeHash = () => (can('stock.view') ? '#/stock' : allowedNav()[0]?.[1] || '#/more');

let currentTab = null;
function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = `<div class="brand"><svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM12 13L3.5 8.3M12 13l8.5-4.7M12 13v8"/></svg>Склад</div>
    ${allowedNav().map(([k, href, label, icon, wide]) => `<a href="${href}" data-tab="${k}"${wide ? ' class="nav-wide"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>${k === 'orders' ? '<b class="nav-badge" hidden></b>' : ''}</a>`).join('')}`;
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === currentTab));
  updateBadge();
}
// права могли змінитися (адміністратор щойно змінив) — меню перебудовуємо разом із даними
document.addEventListener('sklad:data', renderNav);

const app = document.getElementById('app');
let current = null; // { token, route, ctx }
let token = 0;

function shell() {
  app.innerHTML = `
    ${isDemo ? '<div class="banner demo">Демо-режим: дані зберігаються лише в цьому браузері. Спільна база підключається в js/config.js (див. README).</div>' : ''}
    <div class="banner offline" id="offline" hidden>Немає інтернету — зміни не збережуться, доки зʼєднання не повернеться</div>
    <div class="layout">
      <nav class="nav" id="nav"></nav>
      <div class="page">
        <header class="top" id="top"></header>
        <main id="main"></main>
      </div>
    </div>`;
  renderNav();
  const off = document.getElementById('offline');
  const upd = () => { off.hidden = navigator.onLine; };
  addEventListener('online', upd);
  addEventListener('offline', upd);
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
  currentTab = tab;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  current = { token: my, live, ctx, rerender: () => fn(ctx, path.match(re), query) };
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

let started = false;
async function start() {
  state.me = await api.userId();
  if (!state.me) { loginView(); return; }
  app.innerHTML = '<div class="loading">Завантаження…</div>';
  // прибрати з кошика все старше 30 днів; не вийшло (стара схема, мережа) — не страшно
  await api.purgeTrash().catch(() => {});
  try {
    await reloadData();
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><p>Не вдалося завантажити дані.</p><p class="err-text">${esc(e.message)}</p>
      <p><button class="btn primary" onclick="location.reload()">Спробувати ще</button></p></div>`;
    return;
  }
  shell();
  updateBadge();
  if (!started) {
    started = true;
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
