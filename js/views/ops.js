// Прихід / видаток і журнал операцій
import { api, TRASH_DAYS } from '../api.js';
import { esc, fmtQty, fmtSigned, fmtDate, parseNum, round, toast, confirmDialog, OP_TYPES, downloadXlsx, todayIso } from '../util.js';
import { state, go, reloadData, itemPicker, userName, bindTrash, trashNote, TRASH_EMPTY } from '../core.js';

// контрагенти з недавніх операцій — підказки в полі
let recentCounterparties = null;
async function counterparties() {
  if (!recentCounterparties) {
    const ops = await api.operations({ limit: 300 }).catch(() => []);
    recentCounterparties = [...new Set(ops.map((o) => o.counterparty).filter(Boolean))];
  }
  return recentCounterparties;
}

export async function viewOp(ctx, type, query) {
  const isIn = type === 'in';
  if (type !== 'in' && type !== 'out') { ctx.notFound(); return; }
  const fromItem = query.get('item');
  // видача під замовлення: підставляємо те, що ще не видано
  const order = !isIn && query.get('order') ? state.orders.find((o) => o.id === query.get('order')) : null;
  const back = order ? `#/order/${order.id}` : fromItem ? `#/item/${fromItem}` : '#/stock';
  ctx.header({ title: isIn ? 'Прихід' : 'Видаток', back });
  const lines = []; // {item_id, qty: string}
  if (fromItem && state.byId.has(fromItem)) lines.push({ item_id: fromItem, qty: '' });
  if (order) {
    const issued = await api.orderIssued(order.id).catch(() => ({}));
    if (!ctx.alive()) return;
    for (const p of order.parts) {
      const rest = round(p.qty - (issued[p.item_id] || 0));
      if (rest > 0 && state.byId.has(p.item_id)) lines.push({ item_id: p.item_id, qty: fmtQty(rest) });
    }
  }
  const cpValue = order ? `Замовлення №${order.number} · ${order.title}` : '';

  ctx.main.innerHTML = `
    ${order ? `<div class="card hint">Видача під <a href="#/order/${order.id}">замовлення №${order.number}</a>.
      Підставлено деталі, які ще не видано; кількість можна змінити.</div>` : ''}
    <form class="form card op-form ${type}" id="f" autocomplete="off">
      <div id="picker"></div>
      <div id="lines" class="lines"></div>
      <div class="grid2">
        <label class="field"><span>${isIn ? 'Постачальник / звідки' : 'Кому / для чого'}</span>
          <input name="counterparty" list="dl-cp" value="${esc(cpValue)}" placeholder="${isIn ? 'Напр. магазин, замовлення №' : 'Напр. екіпаж, збірка, ремонт'}"></label>
        <label class="field"><span>Коментар</span><input name="comment"></label>
      </div>
      <datalist id="dl-cp"></datalist>
      <div class="form-actions">
        <span class="muted" id="sum"></span><span class="grow"></span>
        <a class="btn ghost" href="${back}">Скасувати</a>
        <button class="btn ${isIn ? 'in' : 'out'}" id="post">${isIn ? 'Провести прихід' : 'Провести видаток'}</button>
      </div>
    </form>`;
  const f = ctx.main.querySelector('#f');
  const linesEl = ctx.main.querySelector('#lines');
  counterparties().then((list) => {
    if (ctx.alive()) ctx.main.querySelector('#dl-cp').innerHTML = list.map((c) => `<option value="${esc(c)}">`).join('');
  });

  const updateSum = () => {
    const n = lines.filter((l) => parseNum(l.qty) > 0).length;
    ctx.main.querySelector('#sum').textContent = lines.length ? `Позицій: ${lines.length}${n !== lines.length ? `, заповнено ${n}` : ''}` : '';
  };
  const renderLines = (focusIdx = -1) => {
    linesEl.innerHTML = lines.length ? lines.map((l, n) => {
      const it = state.byId.get(l.item_id);
      const q = parseNum(l.qty);
      const short = !isIn && q > 0 && q > it.qty;
      const after = q > 0 ? round(isIn ? it.qty + q : it.qty - q) : null;
      return `<div class="line${short ? ' bad' : ''}" data-n="${n}">
        <div class="line-name"><b>${esc(it.name)}</b>
          <small class="muted">є ${fmtQty(it.qty)} ${esc(it.unit)}${after !== null ? ` → стане ${fmtQty(after)}` : ''}</small>
          ${short ? '<small class="err-text">Недостатньо на складі</small>' : ''}</div>
        <input class="qty" inputmode="decimal" value="${esc(l.qty)}" placeholder="к-сть" aria-label="Кількість">
        <span class="unit">${esc(it.unit)}</span>
        <button type="button" class="icon-btn" data-rm aria-label="Прибрати">✕</button>
      </div>`;
    }).join('') : '<div class="muted pad center">Знайдіть позицію в полі вище або відскануйте код</div>';
    updateSum();
    if (focusIdx >= 0) linesEl.querySelectorAll('.qty')[focusIdx]?.focus();
  };

  itemPicker(ctx.main.querySelector('#picker'), (item) => {
    const existing = lines.findIndex((l) => l.item_id === item.id);
    if (existing >= 0) {
      // повторне сканування того ж коду — +1
      const cur = parseNum(lines[existing].qty) || 0;
      lines[existing].qty = String(cur + 1);
      renderLines(existing);
    } else {
      lines.push({ item_id: item.id, qty: '' });
      renderLines(lines.length - 1);
    }
  }, { placeholder: 'Додати позицію: назва або код…' });
  renderLines(lines.length ? 0 : -1);

  linesEl.addEventListener('input', (e) => {
    if (!e.target.classList.contains('qty')) return;
    const n = +e.target.closest('.line').dataset.n;
    lines[n].qty = e.target.value;
    // оновлюємо лише підпис рядка, щоб не збивати курсор
    const it = state.byId.get(lines[n].item_id);
    const q = parseNum(lines[n].qty);
    const row = e.target.closest('.line');
    const short = !isIn && q > 0 && q > it.qty;
    row.classList.toggle('bad', short);
    const after = q > 0 ? round(isIn ? it.qty + q : it.qty - q) : null;
    row.querySelector('.line-name').innerHTML = `<b>${esc(it.name)}</b>
      <small class="muted">є ${fmtQty(it.qty)} ${esc(it.unit)}${after !== null ? ` → стане ${fmtQty(after)}` : ''}</small>
      ${short ? '<small class="err-text">Недостатньо на складі</small>' : ''}`;
    updateSum();
  });
  linesEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('qty')) {
      e.preventDefault();
      ctx.main.querySelector('#picker input').focus();
    }
  });
  linesEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-rm]')) return;
    lines.splice(+e.target.closest('.line').dataset.n, 1);
    renderLines();
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!lines.length) return toast('Додайте хоча б одну позицію', 'err');
    const out = [];
    for (const l of lines) {
      const q = parseNum(l.qty);
      const it = state.byId.get(l.item_id);
      if (!(q > 0)) return toast(`Вкажіть кількість для «${it.name}»`, 'err');
      out.push({ item_id: l.item_id, qty: q });
    }
    const btn = f.querySelector('#post');
    btn.disabled = true;
    try {
      await api.postOperation({ type, lines: out, counterparty: f.counterparty.value.trim(), comment: f.comment.value.trim(), order_id: order?.id || null });
      recentCounterparties = null;
      await reloadData();
      toast(isIn ? 'Прихід проведено' : 'Видаток проведено');
      go(back);
    } catch (err) {
      toast(err.message, 'err', 6000);
      btn.disabled = false;
      await reloadData().catch(() => {});
      if (ctx.alive()) renderLines();
    }
  });
}

// ------------------------------------------------------------------
// Журнал
// ------------------------------------------------------------------
const jf = { type: '', from: '', to: '' };
let journalTrash = false;

function opLines(op) {
  return op.movements.map((m) => {
    const it = state.byId.get(m.item_id);
    return `<div class="op-line"><span>${esc(it?.name || '(видалена позиція)')}</span>
      <b class="${m.qty > 0 ? 'pos' : 'neg'}">${fmtSigned(m.qty)} ${esc(it?.unit || '')}</b></div>`;
  }).join('') || '<div class="muted">Без змін (розбіжностей не було)</div>';
}

const anyOrder = (id) => (id ? state.orders.find((o) => o.id === id) || state.trashOrders.find((o) => o.id === id) : null);

// trash — картка в кошику: «Відновити / Видалити назавжди» замість «Видалити»
function opCard(op, trash = false) {
  const t = OP_TYPES[op.type] || { label: op.type, cls: '' };
  const kit = op.kit_id ? state.kits.find((k) => k.id === op.kit_id) : null;
  const ord = anyOrder(op.order_id);
  return `<div class="op card${trash ? ' trash-row in-trash' : ''}" data-id="${op.id}">
    <div class="op-head">
      <span class="tag ${t.cls}">${t.label}</span>
      <small class="muted">${fmtDate(op.created_at)} · ${esc(userName(op.created_by))}</small>
    </div>
    ${op.type === 'kit_out' ? `<div><b>${esc(kit?.name || 'Комплект')}</b> × ${fmtQty(op.kit_qty)}</div>` : ''}
    ${ord ? `<div><a href="#/order/${ord.id}">Замовлення №${ord.number} · ${esc(ord.title)}</a>${ord.deleted_at ? ' <small class="muted">(у кошику)</small>' : ''}</div>` : ''}
    ${op.counterparty || op.comment ? `<div class="op-note">${esc([op.counterparty, op.comment].filter(Boolean).join(' — '))}</div>` : ''}
    <div class="op-lines">${opLines(op)}</div>
    <div class="op-foot">${trash
      ? `<small class="muted grow">${trashNote(op.cancelled_at, op.cancelled_by)}</small>
         <button type="button" class="btn ghost sm" data-restore>Відновити</button>
         <button type="button" class="btn ghost sm del-btn" data-purge>Видалити назавжди</button>`
      : '<button type="button" class="btn ghost sm del-btn" data-cancel>Видалити</button>'}</div>
  </div>`;
}

export async function viewJournal(ctx) {
  ctx.header({ title: 'Журнал', actions: '<button class="btn ghost sm" data-xls>Excel</button>' });
  ctx.main.innerHTML = `
    <div class="chips" id="types">
      ${[['', 'Усі'], ['in', 'Прихід'], ['out', 'Видаток'], ['kit_out', 'Комплекти'], ['adjust', 'Інвентаризація']]
        .map(([v, l]) => `<button class="chip${!journalTrash && jf.type === v ? ' on' : ''}" data-t="${v}">${l}</button>`).join('')}
      <button class="chip trash-chip${journalTrash ? ' on' : ''}" data-trash>Кошик</button>
    </div>
    <div class="toolbar dates" id="dates"${journalTrash ? ' hidden' : ''}>
      <label>з <input type="date" id="from" value="${jf.from}"></label>
      <label>по <input type="date" id="to" value="${jf.to}"></label>
    </div>
    <div id="ops"></div>
    <div class="center pad"><button class="btn ghost" id="more" hidden>Показати ще</button></div>`;
  const opsEl = ctx.main.querySelector('#ops');
  const more = ctx.main.querySelector('#more');
  let last = null;

  const load = async (append) => {
    if (!append) { opsEl.innerHTML = '<div class="muted pad">Завантаження…</div>'; last = null; }
    if (journalTrash) {
      try {
        const ops = await api.trashOperations();
        if (!ctx.alive()) return;
        opsEl.innerHTML = ops.length ? ops.map((op) => opCard(op, true)).join('') : TRASH_EMPTY;
        more.hidden = true;
      } catch (e) { toast(e.message, 'err'); }
      return;
    }
    try {
      const ops = await api.operations({ ...jf, before: last, limit: 50 });
      if (!ctx.alive()) return;
      if (!append) opsEl.innerHTML = '';
      opsEl.insertAdjacentHTML('beforeend', ops.map((op) => opCard(op)).join(''));
      if (!append && !ops.length) opsEl.innerHTML = '<div class="empty-state"><p>Операцій немає</p></div>';
      last = ops.length ? ops[ops.length - 1].created_at : last;
      more.hidden = ops.length < 50;
    } catch (e) { toast(e.message, 'err'); }
  };
  ctx.reload = () => load(false);
  await load(false);

  ctx.main.querySelector('#types').addEventListener('click', (e) => {
    const b = e.target.closest('[data-t], [data-trash]');
    if (!b) return;
    journalTrash = 'trash' in b.dataset;
    if (!journalTrash) jf.type = b.dataset.t;
    ctx.main.querySelector('#dates').hidden = journalTrash;
    ctx.main.querySelectorAll('#types .chip').forEach((c) => c.classList.toggle('on', c === b));
    load(false);
  });
  for (const k of ['from', 'to']) {
    ctx.main.querySelector(`#${k}`).addEventListener('change', (e) => { jf[k] = e.target.value; load(false); });
  }
  more.addEventListener('click', () => load(true));
  opsEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cancel]');
    if (!b) return;
    const id = b.closest('.op').dataset.id;
    if (!await confirmDialog(`Видалити операцію? Залишки перерахуються без неї. ${TRASH_DAYS} днів її можна відновити: Журнал → Кошик.`,
      { ok: 'Видалити', danger: true })) return;
    try {
      await api.cancelOperation(id);
      await reloadData();
      toast('Операцію перенесено в кошик');
      load(false);
    } catch (err) { toast(err.message, 'err', 8000); }
  });
  bindTrash(opsEl, {
    restore: (id) => api.restoreOperation(id),
    purge: (id) => api.purgeOperation(id),
    purgeText: () => 'Видалити операцію назавжди? Відновити вже не вийде.',
    after: () => load(false),
  });
  ctx.headerEl.querySelector('[data-xls]').addEventListener('click', () => exportJournal());
}

export async function exportJournal() {
  try {
    const ops = await api.allOperations(jf);
    const rows = [['Дата', 'Тип', 'Позиція', 'Код', 'Кількість', 'Од.', 'Контрагент', 'Коментар', 'Замовлення', 'Хто']];
    for (const op of ops.slice().reverse()) {
      const ord = anyOrder(op.order_id);
      for (const m of op.movements) {
        const it = state.byId.get(m.item_id);
        rows.push([fmtDate(op.created_at), OP_TYPES[op.type]?.label || op.type, it?.name || '', it?.code || '', m.qty, it?.unit || '',
          op.counterparty, op.comment, ord ? `№${ord.number}` : '', userName(op.created_by)]);
      }
    }
    const period = jf.from || jf.to ? `_${jf.from || '...'}_${jf.to || '...'}` : '';
    downloadXlsx(`журнал${period}_${todayIso()}.xlsx`, [{ name: 'Журнал', rows, widths: [17, 16, 34, 16, 10, 7, 22, 30, 11, 14] }]);
  } catch (e) { toast(e.message, 'err'); }
}
