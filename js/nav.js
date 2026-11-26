// Меню розділів: бічне на широкому екрані (усі розділи), нижня панель на телефоні
// (перші BAR розділів + «Ще»). Порядок розділів спільний для всіх, міняє його лише
// головний адміністратор: app_settings.nav_order, set_nav_order().
import { api } from './api.js';
import { esc } from './util.js';
import { state, can, canOrder, waitingForMe, applyNavOrder } from './core.js';
import { sortable, commitOrder, afterDrag, ICON_GRIP } from './sortable.js';

// [ключ, адреса, назва, іконка, потрібне право] — у порядку за замовчуванням.
// Ключ — те, що зберігається в nav_order; новий розділ, якого там ще немає, стає в кінець.
export const SECTIONS = [
  ['kits', '#/kits', 'Комплекти', '<path d="M4 7h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 16h7v4H4z"/>', 'kits.view'],
  ['stock', '#/stock', 'Залишки', '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM12 13L3.5 8.3M12 13l8.5-4.7M12 13v8"/>', 'stock.view'],
  ['orders', '#/orders', 'Замовлення', '<path d="M9 3h6v4H9zM9 5H5v16h14V5h-4M8 12h8M8 16h5"/>', 'orders.view'],
  ['journal', '#/journal', 'Журнал', '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', 'ops.view'],
  ['inventory', '#/inventory', 'Інвентар', '<path d="M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>', 'ops.edit'],
  ['reorder', '#/reorder', 'Дозамовити', '<path d="M3 4h2l2.5 11h10L20 7H6.5M9 20h.01M17 20h.01"/>', 'stock.view'],
  ['departments', '#/departments', 'Відділи', '<path d="M4 20V6l8-3v17M12 9l8 2v9M3 20h18M8 9h.01M8 13h.01M16 14h.01"/>', null],
  ['labels', '#/labels', 'Етикетки', '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 19v1"/>', 'stock.view'],
  ['import', '#/import', 'Імпорт', '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>', 'stock.edit'],
  ['users', '#/users', 'Користувачі', '<path d="M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M16 4.5a3.5 3.5 0 010 6.5M18 14.8c2 .7 3.5 2.4 3.5 5.2"/>', 'admin'],
  ['notifications', '#/notifications', 'Сповіщення', '<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4l2-2zM10 21h4"/>', 'admin'],
  ['backups', '#/backups', 'Резервні копії', '<path d="M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>', 'admin'],
];
// «Ще» — завжди останнє й не переставляється
const MORE = ['more', '#/more', 'Ще', '<path d="M5 12h.01M12 12h.01M19 12h.01"/>', null];
const ICON_ORDER = '<path d="M8 4v16M8 4L4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>';
// скільки розділів уміщає нижня панель телефона поруч із «Ще»
const BAR = 4;
export const wide = matchMedia('(min-width: 900px)');

// усі розділи: спершу в збереженому порядку (невідомі ключі пропускаються), решта — як за замовчуванням
export function orderedSections() {
  const saved = [...new Set(state.settings.nav_order || [])].map((k) => SECTIONS.find((s) => s[0] === k)).filter(Boolean);
  return [...saved, ...SECTIONS.filter((s) => !saved.includes(s))];
}
// ті, що доступні цій людині
export const allowedSections = () => orderedSections().filter(([, , , , perm]) => !perm || can(perm));
// розділи, яким на вузькому екрані не вистачило місця на панелі, — їх показує сторінка «Ще»
export const restSections = () => (wide.matches ? [] : allowedSections().slice(BAR));
// стартова сторінка: перший доступний розділ за порядком меню; без жодного права — «Ще» (там пояснення)
export const homeHash = () => (state.perms.size ? allowedSections()[0]?.[1] : null) || '#/more';

// ------------------------------------------------------------------
// Режим «Порядок меню» (лише головний адміністратор). На широкому екрані пункти
// переставляються просто в бічному меню, на телефоні — списком на сторінці «Ще».
// ------------------------------------------------------------------
let ordering = false;
export const navOrdering = () => ordering && canOrder();
// сторінка «Ще» залежить від меню (режим порядку, ширина екрана) — app.js її перемальовує
const changed = () => document.dispatchEvent(new Event('sklad:nav'));
export function setNavOrdering(on) {
  ordering = !!on;
  renderNav();
  changed();
}
// пішли на інший екран — режим вимкнувся
addEventListener('hashchange', () => { if (ordering) { ordering = false; renderNav(); } });
wide.addEventListener('change', () => { renderNav(); changed(); });

// Список розділів з ручками і стрілками в box; порядок зберігається після кожної перестановки
export function mountNavOrder(box) {
  box.innerHTML = orderedSections().map(([k, , label]) => `
    <div class="row sort-row" data-id="${k}" data-sort>
      <span class="grip" data-grip title="Перетягнути">${ICON_GRIP}</span>
      <div class="row-main"><div class="row-title">${esc(label)}</div></div>
      <button type="button" class="icon-btn" data-mv="-1" aria-label="Вище: ${esc(label)}">▲</button>
      <button type="button" class="icon-btn" data-mv="1" aria-label="Нижче: ${esc(label)}">▼</button>
    </div>`).join('');
  const redraw = () => { renderNav(); changed(); };
  sortable(box, {
    autoScroll: !box.closest('#nav'),
    cancel: redraw,
    drop: () => {
      const ids = [...box.querySelectorAll(':scope > [data-sort]')].map((r) => r.dataset.id);
      commitOrder(() => applyNavOrder(ids), () => api.setNavOrder(ids), redraw);
      // на телефоні список — на сторінці, а нижня панель одразу показує новий порядок
      if (!box.closest('#nav')) renderNav();
    },
  });
}

// скільки замовлень чекає на мій відділ — число на вкладці
export function updateBadge() {
  const el = document.querySelector('#nav [data-tab="orders"] .nav-badge');
  if (!el) return;
  const n = waitingForMe().length;
  el.textContent = n > 99 ? '99+' : String(n);
  el.hidden = !n;
}

let currentTab = null;
// вкладка відкритого екрана; якщо її на панелі телефона немає — підсвічується «Ще»
function mark() {
  const links = [...document.querySelectorAll('#nav a[data-tab]')];
  const tab = links.some((a) => a.dataset.tab === currentTab) ? currentTab : 'more';
  links.forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
}
export function setNavTab(tab) {
  currentTab = tab;
  mark();
}

const BRAND = '<div class="brand"><svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM12 13L3.5 8.3M12 13l8.5-4.7M12 13v8"/></svg>Склад</div>';
const link = ([k, href, label, icon]) => `<a href="${href}" data-tab="${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>${k === 'orders' ? '<b class="nav-badge" hidden></b>' : ''}</a>`;

export function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  // зміни від інших не перемальовують меню під пальцем — лише після відпускання
  if (afterDrag('nav', renderNav)) return;
  nav.onclick = (e) => {
    const b = e.target.closest('[data-nav-order]');
    if (b) setNavOrdering(b.dataset.navOrder === 'on');
  };
  if (navOrdering() && wide.matches) {
    nav.classList.add('nav-sorting');
    nav.innerHTML = `${BRAND}
      <p class="muted small nav-hint">Тягніть за ${ICON_GRIP} або натискайте стрілки. Порядок однаковий у всіх.</p>
      <div class="nav-list" id="nav-list"></div>
      <div class="nav-fixed"><svg viewBox="0 0 24 24" aria-hidden="true">${MORE[3]}</svg><span>${MORE[2]} — завжди останнє</span></div>
      <button type="button" class="btn primary sm nav-order" data-nav-order="off">Готово</button>`;
    mountNavOrder(nav.querySelector('#nav-list'));
    return;
  }
  nav.classList.remove('nav-sorting');
  const list = allowedSections();
  nav.innerHTML = `${BRAND}${[...(wide.matches ? list : list.slice(0, BAR)), MORE].map(link).join('')}
    ${canOrder() && wide.matches ? `<button type="button" class="nav-order" data-nav-order="on"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_ORDER}</svg><span>Порядок меню</span></button>` : ''}`;
  mark();
  updateBadge();
}
// права чи порядок меню могли змінитися (адміністратор щойно змінив) — меню перебудовуємо разом із даними
document.addEventListener('sklad:data', renderNav);
