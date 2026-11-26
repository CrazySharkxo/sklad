// Залишки, картка позиції, створення/редагування позиції
import { api, isDemo, TRASH_DAYS } from '../api.js';
import { esc, norm, fmtQty, fmtSigned, fmtDate, parseNum, round, compressImage, toast, confirmDialog, OP_TYPES, qrSvg, labelPayload } from '../util.js';
import { scanCode } from '../scanner.js';
import { postOrQueue } from '../outbox.js';
import {
  state, go, reloadData, activeItems, isLow, categories, locations, units, searchItems, findByCode, resolveCode,
  hydratePhotos, thumb, comboInput, userName, ICON_SCAN, ICON_PLUS, trashRow, bindTrash, trashNote, TRASH_EMPTY, can,
  reservedOf, freeQty, reservingOrders, applyItemOrder, applyCategoryOrder,
} from '../core.js';

// пошук і фільтр запамʼятовуються в межах сесії
const ui = { q: '', cat: '', low: false, archived: false, trash: false, order: false };
// режим «Порядок» діє лише на екрані залишків: пішли з нього — вимкнувся
addEventListener('hashchange', () => { if (location.hash !== '#/stock') ui.order = false; });

export function viewStock(ctx) {
  // зміни від інших не перемальовують екран під пальцем — лише після відпускання
  if (drag) { drag.after = () => viewStock(ctx); return; }
  if (!can('stock.edit')) ui.order = false;
  if (ui.order) { viewStockOrder(ctx); return; }
  ctx.header({
    title: 'Залишки',
    actions: can('stock.edit') ? `${activeItems().length > 1 ? '<button class="btn ghost sm" data-order>Порядок</button>' : ''}
      <button class="btn primary sm" data-new>${ICON_PLUS}<span>Позиція</span></button>` : '',
  });
  const cats = categories();
  const lowCount = activeItems().filter(isLow).length;
  if (!state.trashItems.length || !can('stock.delete')) ui.trash = false;
  const plain = !ui.cat && !ui.low && !ui.trash;
  ctx.main.innerHTML = `
    <div class="toolbar">
      <div class="search"><input type="search" id="q" placeholder="Пошук: назва, код, категорія, місце" value="${esc(ui.q)}" autocomplete="off"></div>
      <button class="icon-btn big" id="scan" title="Сканувати" aria-label="Сканувати">${ICON_SCAN}</button>
    </div>
    <div class="chips" id="chips">
      <button class="chip${plain ? ' on' : ''}" data-cat="">Усі</button>
      ${lowCount ? `<button class="chip warn${ui.low ? ' on' : ''}" data-low>Мало: ${lowCount}</button>` : ''}
      ${cats.map((c) => `<button class="chip${ui.cat === c ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      ${state.trashItems.length && can('stock.delete') ? `<button class="chip trash-chip${ui.trash ? ' on' : ''}" data-trash>Кошик · ${state.trashItems.length}</button>` : ''}
    </div>
    <div id="list" class="list"></div>
    ${can('ops.edit') ? `<div class="bottom-actions">
      <a class="btn in" href="#/op/in">＋ Прихід</a>
      <a class="btn out" href="#/op/out">− Видаток</a>
    </div>` : ''}`;

  const listEl = ctx.main.querySelector('#list');
  const renderList = () => {
    if (ui.trash) {
      const list = searchItems(ui.q, state.trashItems);
      listEl.innerHTML = list.length ? list.map((i) => trashRow({
        id: i.id,
        title: esc(i.name),
        meta: [i.code, i.qty ? `${fmtQty(i.qty)} ${i.unit}` : ''].filter(Boolean).map(esc).join(' · '),
        deletedAt: i.deleted_at,
        deletedBy: i.deleted_by,
      })).join('') : TRASH_EMPTY;
      return;
    }
    let list = ui.archived ? state.items : activeItems();
    if (ui.cat) list = list.filter((i) => i.category === ui.cat);
    if (ui.low) list = list.filter(isLow);
    list = searchItems(ui.q, list);
    if (!state.items.length) {
      listEl.innerHTML = `<div class="empty-state"><p>Склад порожній.</p>${can('stock.edit') ? `
        <p><a class="btn primary" href="#/item-edit/new">Додати першу позицію</a></p>
        <p class="muted">Або завантажте список з Excel: <a href="#/import">Імпорт</a></p>` : ''}</div>`;
      return;
    }
    if (!list.length) { listEl.innerHTML = '<div class="empty-state"><p>Нічого не знайдено</p></div>'; return; }
    const shown = list.slice(0, 300);
    listEl.innerHTML = shown.map((i) => `
      <a class="row${i.archived ? ' archived' : ''}" href="#/item/${i.id}">
        ${thumb(i.photo_path)}
        <div class="row-main">
          <div class="row-title">${esc(i.name)}</div>
          <div class="row-meta">${[i.code, i.category, i.location].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div>
        </div>
        <div class="row-qty${isLow(i) ? ' low' : ''}${i.qty === 0 ? ' zero' : ''}">
          <b>${fmtQty(i.qty)}</b><small>${esc(i.unit)}</small>
          ${isLow(i) ? `<em>мін ${fmtQty(i.min_qty)}</em>` : reservedOf(i) ? `<em class="res">вільно ${fmtQty(freeQty(i))}</em>` : ''}
        </div>
      </a>`).join('') + (list.length > shown.length ? `<div class="muted center pad">Показано ${shown.length} з ${list.length} — уточніть пошук</div>` : '');
    hydratePhotos(listEl);
  };
  renderList();
  bindTrash(listEl, {
    restore: (id) => api.restoreItem(id),
    purge: (id) => api.purgeItem(id),
    purgeText: (id) => `Видалити «${state.byId.get(id)?.name}» назавжди? Відновити вже не вийде.`,
    after: () => viewStock(ctx),
  });

  const q = ctx.main.querySelector('#q');
  q.addEventListener('input', () => { ui.q = q.value; renderList(); });
  // USB-сканер друкує код + Enter: точний збіг коду відкриває позицію
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const r = resolveCode(q.value);
    if (r?.kind === 'item') { ui.q = ''; go(`#/item/${r.item.id}`); }
    else if (r?.kind === 'unit') { ui.q = ''; go(`#/order/${r.order.id}?unit=${r.unit.id}`); }
  });
  ctx.main.querySelector('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if ('trash' in b.dataset) { ui.trash = true; ui.low = false; ui.cat = ''; }
    else if ('low' in b.dataset) { ui.low = !ui.low; ui.cat = ''; ui.trash = false; }
    else { ui.cat = b.dataset.cat; ui.low = false; ui.trash = false; }
    ctx.main.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on',
      ('trash' in c.dataset) ? ui.trash
        : ('low' in c.dataset) ? ui.low
          : (!ui.low && !ui.trash && c.dataset.cat === ui.cat)));
    renderList();
  });
  ctx.main.querySelector('#scan').addEventListener('click', () => scanAndOpen());
  ctx.headerEl.querySelector('[data-new]')?.addEventListener('click', () => go('#/item-edit/new'));
  // порядок міняється в повному списку (або в межах однієї категорії) — пошук, «Мало» і «Кошик» скидаються
  ctx.headerEl.querySelector('[data-order]')?.addEventListener('click', () => {
    Object.assign(ui, { order: true, q: '', low: false, trash: false });
    viewStock(ctx);
  });
  if (!matchMedia('(pointer: coarse)').matches) q.focus();
}

// ------------------------------------------------------------------
// Режим «Порядок»: позиції й кнопки категорій перетягуються за ручку або
// пересуваються стрілками. Порядок спільний для всіх і зберігається після
// кожного відпускання; дотик до рядка картку не відкриває.
// ------------------------------------------------------------------
const ICON_GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg>';
const ORDER_LIMIT = 300;
let drag = null;                  // триває перетягування: { after } — що зробити після відпускання
let saving = Promise.resolve();   // збереження йдуть по черзі
let failures = 0;                 // після невдачі вже поставлені в чергу збереження не відправляються

function viewStockOrder(ctx) {
  ctx.header({ title: 'Залишки — порядок', actions: '<button class="btn primary sm" data-done>Готово</button>' });
  const cats = categories();
  if (ui.cat && !cats.includes(ui.cat)) ui.cat = '';
  const all = activeItems().filter((i) => !ui.cat || i.category === ui.cat);
  const list = all.slice(0, ORDER_LIMIT);
  ctx.main.innerHTML = `
    <p class="muted small order-hint">Тягніть за ${ICON_GRIP} або натискайте стрілки. Порядок зберігається одразу й однаковий у всіх.
      ${cats.length ? 'Натисніть категорію, щоб упорядкувати позиції всередині неї.' : ''}</p>
    <div class="chips sorting" id="chips">
      <button class="chip${ui.cat ? '' : ' on'}" data-cat="">Усі</button>
      ${cats.map((c) => `<span class="chip sort-chip${ui.cat === c ? ' on' : ''}" data-cat="${esc(c)}" data-sort>
        <button type="button" class="chip-mv" data-mv="-1" aria-label="Лівіше: ${esc(c)}">◀</button>
        <span class="chip-grip" data-grip>${ICON_GRIP}${esc(c)}</span>
        <button type="button" class="chip-mv" data-mv="1" aria-label="Правіше: ${esc(c)}">▶</button>
      </span>`).join('')}
    </div>
    <div id="list" class="list">${list.map((i) => `
      <div class="row sort-row${i.archived ? ' archived' : ''}" data-id="${i.id}" data-sort>
        <span class="grip" data-grip title="Перетягнути">${ICON_GRIP}</span>
        <div class="row-main">
          <div class="row-title">${esc(i.name)}</div>
          <div class="row-meta">${[i.code, i.category, i.location].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div>
        </div>
        <button type="button" class="icon-btn" data-mv="-1" aria-label="Вище: ${esc(i.name)}">▲</button>
        <button type="button" class="icon-btn" data-mv="1" aria-label="Нижче: ${esc(i.name)}">▼</button>
      </div>`).join('')}${all.length > list.length ? `<div class="muted center pad">Показано ${list.length} з ${all.length} — решту впорядкуйте в межах категорій</div>` : ''}
    </div>`;
  const chipsEl = ctx.main.querySelector('#chips');
  const listEl = ctx.main.querySelector('#list');
  const redraw = () => {
    if (!ctx.alive()) return;
    const y = window.scrollY;
    viewStock(ctx);
    window.scrollTo(0, y);
  };
  // новий порядок уже на екрані; apply оновлює стан і повертає «як було», send зберігає в базі
  const commit = (apply, send) => {
    if (!isDemo && (!navigator.onLine || state.offline)) {
      toast('Немає мережі — порядок не збережено', 'err', 5000);
      redraw();
      return;
    }
    const undo = apply();
    const mine = failures;
    saving = saving.then(() => (mine === failures ? send() : null)).catch((err) => {
      failures += 1;
      undo();
      toast(err.message, 'err', 8000);
      redraw();
      // кілька перестановок поспіль могли розійтися з базою — звіряємось
      reloadData().then(redraw, () => {});
    });
  };
  sortable(chipsEl, {
    horizontal: true,
    cancel: redraw,
    drop: () => {
      const names = [...chipsEl.querySelectorAll('[data-sort]')].map((c) => c.dataset.cat);
      commit(() => applyCategoryOrder(names), () => api.setCategoryOrder(names));
    },
  });
  sortable(listEl, {
    cancel: redraw,
    drop: () => {
      const ids = [...listEl.querySelectorAll('[data-sort]')].map((r) => r.dataset.id);
      commit(() => applyItemOrder(ids), () => api.setItemOrder(ids));
    },
  });
  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || e.target.closest('[data-mv]')) return;
    ui.cat = b.dataset.cat;
    viewStock(ctx);
  });
  ctx.headerEl.querySelector('[data-done]').addEventListener('click', () => { ui.order = false; viewStock(ctx); });
}

// Перестановка дітей box, позначених [data-sort]: перетягуванням за [data-grip]
// (Pointer Events — миша, палець, стилус) і кнопками [data-mv="-1|1"].
// Елемент, який тягнуть, у DOM не рухається (інакше браузер відпустив би вказівник) —
// місцями міняються сусіди. drop() — порядок змінився; cancel() — жест перервано.
function sortable(box, { horizontal = false, drop, cancel }) {
  const items = () => [...box.querySelectorAll(':scope > [data-sort]')];
  const ends = () => {
    const els = items();
    els.forEach((el, n) => {
      const [up, down] = el.querySelectorAll('[data-mv]');
      up.disabled = n === 0;
      down.disabled = n === els.length - 1;
    });
  };
  // el стає по той бік від t; усі, хто між ними, зсуваються на одне місце
  const moveTo = (el, t) => {
    if (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) {
      for (let n = el.nextElementSibling; n; n = el.nextElementSibling) { box.insertBefore(n, el); if (n === t) break; }
    } else {
      for (let n = el.previousElementSibling; n; n = el.previousElementSibling) { box.insertBefore(n, el.nextSibling); if (n === t) break; }
    }
  };
  ends();

  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mv]');
    const el = b?.closest('[data-sort]');
    if (!el || el.parentNode !== box) return;
    const els = items();
    const t = els[els.indexOf(el) + Number(b.dataset.mv)];
    if (!t) return;
    moveTo(el, t);
    ends();
    (b.disabled ? el.querySelector('[data-mv]:not(:disabled)') : b)?.focus();
    drop();
  });

  box.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    const el = grip?.closest('[data-sort]');
    if (!el || el.parentNode !== box || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const before = items();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let x = x0;
    let y = y0;
    let active = false;
    let raf = 0;
    const hit = () => {
      const r0 = box.getBoundingClientRect();
      // у списку важить лише висота: палець може зʼїхати з ручки вбік
      const t = document.elementFromPoint(horizontal ? x : r0.left + r0.width / 2, y)?.closest('[data-sort]');
      if (!t || t === el || t.parentNode !== box) return;
      const r = t.getBoundingClientRect();
      const d = el.getBoundingClientRect();
      const after = !!(el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      // сусід поступається місцем, коли вказівник перейшов його середину — інакше елементи різного розміру смикались би
      if (!horizontal && (after ? y < r.top + r.height / 2 : y > r.top + r.height / 2)) return;
      const sameLine = r.top < d.bottom && r.bottom > d.top;
      if (horizontal && sameLine && (after ? x < r.left + r.width / 2 : x > r.left + r.width / 2)) return;
      moveTo(el, t);
      ends();
    };
    // біля верхнього й нижнього краю екрана сторінка сама прокручується
    const scroll = () => {
      const zone = 110;
      const bottom = window.innerHeight - zone;
      const dy = y < zone ? -Math.min(18, (zone - y) / 5) : y > bottom ? Math.min(18, (y - bottom) / 5) : 0;
      if (active && dy) { window.scrollBy(0, dy); hit(); }
      raf = requestAnimationFrame(scroll);
    };
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
      if (!active) {
        if (Math.hypot(x - x0, y - y0) < 5) return;
        active = true;
        el.classList.add('dragging');
        if (!horizontal) raf = requestAnimationFrame(scroll);
      }
      ev.preventDefault();
      hit();
    };
    const finish = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      cancelAnimationFrame(raf);
      el.classList.remove('dragging');
      const { after } = drag;
      drag = null;
      if (active) {
        // після перетягування браузер ще надішле click — він не має вибрати категорію
        const eat = (c) => { c.stopPropagation(); c.preventDefault(); };
        box.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => box.removeEventListener('click', eat, { capture: true }), 80);
      }
      const changed = items().some((n, k) => n !== before[k]);
      if (ev.type === 'pointercancel') cancel();
      else if (changed) drop();
      after?.();
    };
    drag = { after: null };
    try { grip.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    if (e.pointerType === 'mouse') e.preventDefault(); // без виділення тексту під час перетягування
  });
}

// скан: позиція → її картка; серійний номер виробу → замовлення з підсвіченим виробом
export async function scanAndOpen() {
  const code = await scanCode();
  if (!code) return;
  const r = resolveCode(code);
  if (r?.kind === 'item') go(`#/item/${r.item.id}`);
  else if (r?.kind === 'unit') go(`#/order/${r.order.id}?unit=${r.unit.id}`);
  else if (can('stock.edit') && await confirmDialog(`Код «${code}» не знайдено. Створити нову позицію з цим кодом?`, { ok: 'Створити' })) {
    go(`#/item-edit/new?code=${encodeURIComponent(code)}`);
  } else if (!can('stock.edit')) toast(`Код «${code}» не знайдено`, 'err');
}

// ------------------------------------------------------------------
export async function viewItem(ctx, id) {
  const item = state.byId.get(id);
  if (!item) { ctx.notFound(); return; }
  ctx.header({ title: item.name, back: '#/stock' });
  const trashed = !!item.deleted_at;
  const inKits = state.kits.filter((k) => k.components.some((c) => c.item_id === id));
  ctx.main.innerHTML = `
    <div class="card item-card${item.photo_path ? ' has-photo' : ''}">
      ${item.photo_path ? `<div class="item-photo">${thumb(item.photo_path, 'photo')}</div>` : ''}
      <div class="item-info">
        <div class="big-qty${isLow(item) ? ' low' : ''}"><b>${fmtQty(item.qty)}</b> ${esc(item.unit)}
          ${reservedOf(item) ? `<span class="free">· вільно <b>${fmtQty(freeQty(item))}</b></span>` : ''}</div>
        ${isLow(item) ? `<div class="badge warn">Нижче мінімуму (${fmtQty(item.min_qty)}) — дозамовити ${fmtQty(item.min_qty - item.qty)}</div>` : ''}
        ${reservedOf(item) ? `<div class="badge res">Зарезервовано під замовлення: ${fmtQty(reservedOf(item))} ${esc(item.unit)} —
          ${reservingOrders(id).map((o) => `<a href="#/order/${o.id}">№${o.number}</a>`).join(', ')}</div>` : ''}
        ${item.archived ? '<div class="badge">В архіві</div>' : ''}
        ${trashed ? `<div class="badge warn">У кошику: ${trashNote(item.deleted_at, item.deleted_by)}</div>` : ''}
        <dl class="props">
          ${item.code ? `<dt>Код</dt><dd>${esc(item.code)}</dd>` : ''}
          ${item.category ? `<dt>Категорія</dt><dd>${esc(item.category)}</dd>` : ''}
          ${item.location ? `<dt>Місце</dt><dd>${esc(item.location)}</dd>` : ''}
          ${item.min_qty ? `<dt>Мінімум</dt><dd>${fmtQty(item.min_qty)} ${esc(item.unit)}</dd>` : ''}
          ${inKits.length ? `<dt>У комплектах</dt><dd>${inKits.map((k) => `<a href="#/kit/${k.id}">${esc(k.name)}</a>`).join(', ')}</dd>` : ''}
        </dl>
        ${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}
        ${item.photo_path || !can('stock.edit') ? '' : `<a class="muted small" href="#/item-edit/${id}">+ додати фото</a>`}
      </div>
    </div>
    <div class="action-grid">${trashed ? (can('stock.delete') ? `
      <button class="btn primary" data-restore>Відновити з кошика</button>
      <button class="btn ghost del-btn" data-purge>Видалити назавжди</button>` : '') : `
      ${can('ops.edit') ? `<a class="btn in" href="#/op/in?item=${id}">＋ Прихід</a>
      <a class="btn out" href="#/op/out?item=${id}">− Видаток</a>` : ''}
      ${can('stock.edit') ? `<a class="btn ghost" href="#/item-edit/${id}">Редагувати</a>` : ''}
      <button class="btn ghost" data-label>Етикетка</button>
      ${can('stock.delete') ? '<button class="btn ghost del-btn" data-del>Видалити</button>' : ''}`}
    </div>
    <h3>Історія руху</h3>
    <div id="hist" class="hist"><div class="muted pad">Завантаження…</div></div>`;
  hydratePhotos(ctx.main);
  ctx.main.querySelector('[data-label]')?.addEventListener('click', () => printLabels([item]));
  ctx.main.querySelector('[data-del]')?.addEventListener('click', () => trashItemFlow(item));
  ctx.main.querySelector('[data-restore]')?.addEventListener('click', async () => {
    try {
      await api.restoreItem(id);
      await reloadData();
      toast('Позицію відновлено');
      viewItem(ctx, id);
    } catch (err) { toast(err.message, 'err', 8000); }
  });
  ctx.main.querySelector('[data-purge]')?.addEventListener('click', async () => {
    if (!await confirmDialog(`Видалити «${item.name}» назавжди? Відновити вже не вийде.`, { ok: 'Видалити назавжди', danger: true })) return;
    try {
      await api.purgeItem(id);
      await reloadData();
      toast('Видалено назавжди');
      go('#/stock');
    } catch (err) { toast(err.message, 'err', 10000); }
  });

  const hist = await api.itemHistory(id).catch((e) => { toast(e.message, 'err'); return []; });
  if (!ctx.alive()) return;
  const el = ctx.main.querySelector('#hist');
  el.innerHTML = hist.length ? hist.map(({ qty, op }) => `
    <div class="hist-row${op?.cancelled_at ? ' cancelled' : ''}">
      <div><span class="tag ${OP_TYPES[op?.type]?.cls || ''}">${OP_TYPES[op?.type]?.label || ''}</span>
        <small class="muted">${fmtDate(op?.created_at)} · ${esc(userName(op?.created_by))}</small>
        ${op?.counterparty || op?.comment ? `<div class="muted">${esc([op.counterparty, op.comment].filter(Boolean).join(' — '))}</div>` : ''}
        ${op?.cancelled_at ? '<div class="muted">операцію видалено</div>' : ''}</div>
      <b class="${qty > 0 ? 'pos' : 'neg'}">${fmtSigned(qty)}</b>
    </div>`).join('') : '<div class="muted pad">Руху ще не було</div>';
}

// ------------------------------------------------------------------
export function viewItemEdit(ctx, id, query) {
  const isNew = id === 'new';
  const item = isNew ? { name: '', code: query.get('code') || '', category: '', unit: 'шт', location: '', min_qty: 0, note: '', photo_path: null }
    : state.byId.get(id);
  if (!item) { ctx.notFound(); return; }
  ctx.header({ title: isNew ? 'Нова позиція' : 'Редагування', back: isNew ? '#/stock' : `#/item/${id}` });
  let photoPath = item.photo_path;
  let newPhoto = null;
  // залишок рахується з журналу руху: у наявної позиції його править інвентаризація (adjust), а не saveItem
  const qtyText = isNew ? '' : fmtQty(item.qty);
  const qtyLocked = !isNew && (!can('ops.edit') || !!item.deleted_at);
  const qtyField = isNew
    ? (can('ops.edit') ? '<label class="field"><span>Кількість на складі зараз</span><input name="init_qty" inputmode="decimal" placeholder="напр. 100"></label>' : '')
    : `<label class="field"><span>Кількість на складі зараз</span><input name="init_qty" inputmode="decimal" value="${esc(qtyText)}"${qtyLocked ? ' disabled' : ''}></label>`;

  ctx.main.innerHTML = `
    <form class="form card" id="f" autocomplete="off">
      <div class="photo-edit">
        <div class="photo-box" id="pbox">${thumb(photoPath, 'photo')}</div>
        <div class="photo-btns">
          <label class="btn ghost sm">Сфотографувати<input type="file" accept="image/*" capture="environment" hidden data-photo-in></label>
          <label class="btn ghost sm">Вибрати файл<input type="file" accept="image/*" hidden data-photo-in></label>
          <button type="button" class="btn ghost sm" id="pdel" ${photoPath ? '' : 'hidden'}>Прибрати фото</button>
        </div>
      </div>
      <label class="field"><span>Назва *</span><input name="name" required value="${esc(item.name)}" placeholder="Напр. Мотор 2207 1750KV"></label>
      <div class="grid2">
        ${qtyField}
        <label class="field"><span>Одиниця виміру (без числа)</span><input name="unit" autocomplete="off" value="${esc(item.unit)}" placeholder="шт, м, кг…"></label>
        <label class="field"><span>Код / штрихкод / артикул</span>
          <div class="with-btn"><input name="code" value="${esc(item.code || '')}"><button type="button" class="icon-btn" id="scode" aria-label="Сканувати">${ICON_SCAN}</button></div></label>
        <label class="field"><span>Категорія</span><input name="category" autocomplete="off" value="${esc(item.category)}" placeholder="Мотори, Камери, Кабелі…"></label>
        <label class="field"><span>Місце зберігання</span><input name="location" autocomplete="off" value="${esc(item.location)}" placeholder="Стелаж 2, коробка 5"></label>
        <label class="field"><span>Мінімальний залишок</span><input name="min_qty" inputmode="decimal" value="${item.min_qty ? fmtQty(item.min_qty) : ''}" placeholder="0 — не стежити"></label>
      </div>
      <label class="field"><span>Примітка</span><textarea name="note" rows="2">${esc(item.note)}</textarea></label>
      ${!isNew ? `<label class="check"><input type="checkbox" name="archived" ${item.archived ? 'checked' : ''}> В архіві (сховати зі списку)</label>` : ''}
      <div class="form-actions">
        ${!isNew && can('stock.delete') ? '<button type="button" class="btn danger ghost" id="del">Видалити</button>' : ''}
        <span class="grow"></span>
        <a class="btn ghost" href="${isNew ? '#/stock' : `#/item/${id}`}">Скасувати</a>
        <button class="btn primary" id="save">Зберегти</button>
      </div>
    </form>`;
  hydratePhotos(ctx.main);
  const f = ctx.main.querySelector('#f');
  const pbox = ctx.main.querySelector('#pbox');
  const pdel = ctx.main.querySelector('#pdel');
  comboInput(f.unit, units);
  comboInput(f.category, categories);
  comboInput(f.location, locations);

  f.querySelectorAll('[data-photo-in]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0];
    inp.value = '';
    if (!file) return;
    try {
      newPhoto = await compressImage(file);
      pbox.innerHTML = `<img class="photo" src="${URL.createObjectURL(newPhoto)}" alt="">`;
      photoPath = null;
      pdel.hidden = false;
    } catch (e) { toast(e.message, 'err'); }
  }));
  pdel.addEventListener('click', () => { newPhoto = null; photoPath = null; pbox.innerHTML = thumb(null, 'photo'); pdel.hidden = true; });
  ctx.main.querySelector('#scode').addEventListener('click', async () => {
    const code = await scanCode();
    if (code) f.code.value = code;
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const min = parseNum(f.min_qty.value);
    const init = isNew && f.init_qty ? parseNum(f.init_qty.value) : null;
    if (Number.isNaN(min) || (min !== null && min < 0)) return toast('Мінімальний залишок — невідʼємне число', 'err');
    // наявна позиція: порожнє або не чіпане поле — залишок не міняється
    const fact = !isNew && !qtyLocked && f.init_qty.value.trim() !== qtyText ? parseNum(f.init_qty.value) : null;
    if (Number.isNaN(init) || (init !== null && init < 0)) return toast('Кількість на складі — невідʼємне число', 'err');
    if (Number.isNaN(fact) || (fact !== null && fact < 0)) return toast('Кількість на складі — невідʼємне число', 'err');
    const adjust = fact !== null && round(fact - item.qty) !== 0;
    // «100 шт» в одиниці виміру — це кількість не в тому полі: залишок лишився б 0
    if (/\d/.test(f.unit.value)) {
      f.unit.focus();
      return toast(`В «Одиниця виміру» — лише «шт», «м», «кг», без числа. Кількість — ${isNew || !qtyLocked ? 'у полі «Кількість на складі зараз»' : 'через «＋ Прихід» у картці позиції'}.`, 'err', 8000);
    }
    const btn = f.querySelector('#save');
    // така позиція вже є → не плодити дубль: кількість додається до наявної, фото лишається одне
    const twin = isNew && state.items.find((i) => norm(i.name) === norm(f.name.value));
    if (twin) {
      const add = init > 0 ? `Додати ${fmtQty(init)} ${twin.unit} до неї?` : 'Відкрити її?';
      if (!await confirmDialog(`Позиція «${twin.name}» вже є — на складі ${fmtQty(twin.qty)} ${twin.unit}. ${add}`,
        { ok: init > 0 ? 'Додати до наявної' : 'Відкрити' })) return;
      btn.disabled = true;
      try {
        if (init > 0) await api.postOperation({ type: 'in', lines: [{ item_id: twin.id, qty: init }], comment: 'Додано повторно' });
        const photo = !twin.photo_path && newPhoto ? await api.uploadPhoto(newPhoto) : twin.photo_path;
        if (photo !== twin.photo_path || twin.archived) await api.saveItem({ ...twin, photo_path: photo, archived: false });
        await reloadData();
        if (init > 0) toast(`Додано ${fmtQty(init)} ${twin.unit} — разом ${fmtQty(state.byId.get(twin.id)?.qty)}`);
        go(`#/item/${twin.id}`);
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
      return;
    }
    btn.disabled = true;
    try {
      let path = photoPath;
      if (newPhoto) path = await api.uploadPhoto(newPhoto);
      const saved = await api.saveItem({
        id: isNew ? undefined : id,
        name: f.name.value, code: f.code.value, category: f.category.value, unit: f.unit.value,
        location: f.location.value, min_qty: min || 0, note: f.note.value, photo_path: path,
        archived: isNew ? false : f.archived.checked,
      });
      if (item.photo_path && item.photo_path !== path) api.removePhoto(item.photo_path);
      if (isNew && init > 0) {
        await api.postOperation({ type: 'in', lines: [{ item_id: saved, qty: init }], comment: 'Початковий залишок' });
      }
      // як на екрані інвентаризації: рядок adjust несе фактичну кількість, різницю рахує сервер
      const adj = adjust
        ? await postOrQueue({ type: 'adjust', lines: [{ item_id: saved, qty: fact }], comment: 'Виправлено в картці позиції' })
        : null;
      await reloadData();
      if (adj?.queued) toast('Збережено. Кількість відправиться з появою мережі', 'ok', 6000);
      else toast(isNew ? 'Позицію додано' : 'Збережено');
      go(`#/item/${saved}`);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  ctx.main.querySelector('#del')?.addEventListener('click', () => trashItemFlow(item));
}

// позиція → кошик (історія руху лишається; відновлення повертає все як було)
async function trashItemFlow(item) {
  const left = item.qty ? ` На складі ще ${fmtQty(item.qty)} ${item.unit} — поки позиція в кошику, їх не видно в залишках.` : '';
  if (!await confirmDialog(`Видалити «${item.name}»?${left} ${TRASH_DAYS} днів її можна відновити: Залишки → Кошик.`,
    { ok: 'Видалити', danger: true })) return;
  try {
    await api.trashItem(item.id);
    await reloadData();
    toast('Позицію перенесено в кошик');
    go('#/stock');
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

// ------------------------------------------------------------------
// Друк етикеток з QR-кодом
// ------------------------------------------------------------------
export function printLabels(items) {
  const host = document.getElementById('print-area');
  host.innerHTML = `<div class="labels">${items.map((i) => `
    <div class="label">
      <div class="label-qr">${qrSvg(labelPayload(i))}</div>
      <div class="label-text"><b>${esc(i.name)}</b>${i.code ? `<small>${esc(i.code)}</small>` : ''}${i.location ? `<small>${esc(i.location)}</small>` : ''}</div>
    </div>`).join('')}</div>`;
  setTimeout(() => window.print(), 50);
}
