// Нестача під замовлення: чого на складі менше, ніж обіцяно активним замовленням.
// Друга вкладка розділу «Дозамовити» (перша — «Нижче мінімуму», js/views/more.js).
//
// Числа — ті самі, що й «вільно» в залишках і в картці позиції:
//   під замовлення = резерв позиції (рахує сервер: деталі активних замовлень мінус уже видане під них,
//                    за всіма відділами);
//   не вистачає    = під замовлення − на складі (коли більше нуля), тобто «вільно» зі знаком мінус.
// Перелік замовлень під позицією складається на пристрої з того, що людина бачить.
import { api } from '../api.js';
import { esc, fmtQty, fmtDate, round, downloadXlsx, todayIso } from '../util.js';
import { state, can, ACTIVE_ORDER, activeItems, isLow, reservedOf, shortOf, shortItems, isOverdue, isDueSoon, dueText } from '../core.js';
import { printTable } from '../print.js';

const fmtDue = (d) => (d ? fmtDate(`${d}T00:00:00`, false) : '');
const ui = { all: false };

// перемикач двох списків розділу «Дозамовити»
export function reorderTabs(on) {
  const low = activeItems().filter(isLow).length;
  const short = shortItems().length;
  const tab = (k, href, label, n) => `<a class="chip${on === k ? ' on' : ''}" href="${href}" data-rtab="${k}">${label}${n ? ` · ${n}` : ''}</a>`;
  return `<div class="chips" id="rtabs">${tab('low', '#/reorder', 'Нижче мінімуму', low)}${tab('orders', '#/shortage', 'Під замовлення', short)}</div>`;
}

// Потреба за позиціями. issued — { id замовлення: { id позиції: видано } } або null, якщо не завантажилось.
// Повертає [{ item, need, have, lack, due, hidden, orders: [{ o, rest, miss }] }]
export function shortageRows(issued, { all = false } = {}) {
  const waits = new Map();
  if (can('orders.view')) {
    for (const o of state.orders) {
      if (!ACTIVE_ORDER.includes(o.status)) continue;
      for (const p of o.parts) {
        const rest = Math.max(0, round(p.qty - (issued?.[o.id]?.[p.item_id] || 0)));
        if (!(rest > 0)) continue;
        if (!waits.has(p.item_id)) waits.set(p.item_id, []);
        waits.get(p.item_id).push({ o, rest, miss: 0 });
      }
    }
  }
  const rows = [];
  for (const item of state.items) {
    const need = reservedOf(item);
    const lack = shortOf(item);
    if (!(need > 0) || (!all && !(lack > 0))) continue;
    const orders = (waits.get(item.id) || []).sort((a, b) => (a.o.due_date || '9999').localeCompare(b.o.due_date || '9999') || a.o.number - b.o.number);
    const seen = round(orders.reduce((s, w) => s + w.rest, 0));
    // частина резерву — під замовленнями, яких ця людина не бачить (інші відділи)
    const hidden = Math.max(0, round(need - seen));
    // кому не вистачить, якщо видавати в порядку термінів; має сенс лише коли видно всі замовлення
    if (issued && !hidden) {
      let left = Math.max(0, item.qty);
      for (const w of orders) {
        const got = Math.min(w.rest, left);
        left = round(left - got);
        w.miss = round(w.rest - got);
      }
    }
    rows.push({ item, need, have: item.qty, lack, due: orders[0]?.o.due_date || null, hidden, orders });
  }
  // спершу те, чого не вистачає; далі — за найближчим терміном, потім за розміром нестачі
  return rows.sort((a, b) => (b.lack > 0) - (a.lack > 0) || (a.due || '9999').localeCompare(b.due || '9999')
    || b.lack - a.lack || a.item.name.localeCompare(b.item.name, 'uk'));
}

function orderLine(w) {
  const { o } = w;
  const cls = isOverdue(o) ? 'overdue' : isDueSoon(o) ? 'soon' : 'due';
  return `<a class="short-order" href="#/order/${o.id}" data-order="${o.id}">
    <span class="so-title"><span class="no">№${o.number}</span>${esc(o.title)}</span>
    <span class="so-need">треба <b>${fmtQty(w.rest)}</b>${w.miss > 0 ? ` <small class="err-text">не вистачить ${fmtQty(w.miss)}</small>` : ''}</span>
    <em class="${cls}">${o.due_date ? `до ${fmtDue(o.due_date)}${dueText(o) ? ` · ${dueText(o)}` : ''}` : 'без терміну'}</em></a>`;
}

function itemCard(r) {
  const u = esc(r.item.unit || '');
  return `<div class="card short-card${r.lack > 0 ? ' bad' : ''}" data-item="${r.item.id}">
    <div class="short-head">
      <a class="short-name" href="#/item/${r.item.id}">${esc(r.item.name)}</a>
      ${r.lack > 0 ? `<div class="short-lack"><b data-c="lack">${fmtQty(r.lack)}</b><small>${u} не вистачає</small></div>`
    : '<div class="short-lack ok"><b data-c="lack">✓</b><small>вистачає</small></div>'}
    </div>
    <div class="short-nums">під замовлення <b data-c="need">${fmtQty(r.need)}</b> ${u} · на складі <b data-c="have">${fmtQty(r.have)}</b> ${u}</div>
    ${r.orders.length ? `<div class="short-orders">${r.orders.map(orderLine).join('')}</div>` : ''}
    ${r.hidden > 0 && can('orders.view') ? `<div class="muted small short-hidden">${r.orders.length ? 'ще ' : ''}${fmtQty(r.hidden)} ${u} — під замовленнями інших відділів (вам їх не видно)</div>` : ''}
  </div>`;
}

export async function viewShortage(ctx) {
  ctx.header({ title: 'Нестача під замовлення', back: '#/more' });
  const seeOrders = can('orders.view');
  const ids = seeOrders ? state.orders.filter((o) => ACTIVE_ORDER.includes(o.status) && o.parts.length).map((o) => o.id) : [];
  ctx.main.innerHTML = `${reorderTabs('orders')}
    <div class="toolbar short-bar">
      <label class="check"><input type="checkbox" id="all" ${ui.all ? 'checked' : ''}> усі позиції під замовлення</label>
      <span class="grow"></span>
      <button class="btn ghost sm" data-out="print">Друк</button>
      <button class="btn ghost sm" data-out="xls">Excel</button>
    </div>
    <div id="note"></div>
    <div id="list"><div class="muted pad center">Завантаження…</div></div>`;
  const listEl = ctx.main.querySelector('#list');
  const noteEl = ctx.main.querySelector('#note');

  let failed = false;
  const issued = ids.length ? await api.ordersIssued(ids).catch(() => { failed = true; return null; }) : {};
  if (!ctx.alive()) return;

  const notes = [];
  if (!seeOrders) notes.push('Кількості пораховано за всіма активними замовленнями складу. Самих замовлень тут немає — у вас немає права їх переглядати.');
  else if (!can('orders.all')) notes.push('Ви бачите лише замовлення свого відділу. «Не вистачає» пораховано за замовленнями всіх відділів, а в переліку під позицією — тільки ваші, тож він може бути неповний.');
  if (failed) notes.push('Не вдалося завантажити, що вже видано під замовлення, — «треба» біля замовлень показано без урахування виданого.');
  noteEl.innerHTML = notes.map((t) => `<div class="card hint">${esc(t)}</div>`).join('');

  let rows = [];
  const render = () => {
    rows = shortageRows(issued, { all: ui.all });
    const reserving = state.items.filter((i) => reservedOf(i) > 0).length;
    listEl.innerHTML = rows.length ? rows.map(itemCard).join('')
      : `<div class="empty-state"><p>${reserving ? 'Для активних замовлень на складі всього вистачає.' : 'Активні замовлення не чекають на деталі зі складу.'}</p>
          <p class="muted">Тут зʼявляються позиції, яких на складі менше, ніж треба під уже прийняті замовлення.
            Потреба береться з «Деталей зі складу» в замовленні мінус те, що вже видано.</p>
          ${reserving ? '<p class="muted">Щоб побачити все, що тримається під замовлення, позначте «усі позиції під замовлення».</p>' : ''}</div>`;
  };
  render();
  ctx.main.querySelector('#all').addEventListener('change', (e) => { ui.all = e.target.checked; render(); });
  ctx.main.querySelector('.short-bar').addEventListener('click', (e) => {
    const how = e.target.closest('[data-out]')?.dataset.out;
    if (!how) return;
    const head = ['Назва', 'Код', 'Одиниця', 'Під замовлення', 'На складі', 'Не вистачає', 'Найближчий термін', 'Замовлення'];
    const data = rows.map((r) => [r.item.name, r.item.code || '', r.item.unit || '', r.need, r.have, r.lack, fmtDue(r.due),
      r.orders.map((w) => `№${w.o.number} ${w.o.title} — ${fmtQty(w.rest)}`).concat(r.hidden > 0 && seeOrders ? [`інші відділи — ${fmtQty(r.hidden)}`] : []).join('; ')]);
    const title = ui.all ? 'Позиції під замовлення' : 'Нестача під замовлення';
    if (how === 'xls') downloadXlsx(`нестача_під_замовлення_${todayIso()}.xlsx`, [{ name: 'Нестача', rows: [head, ...data], widths: [36, 16, 9, 14, 10, 12, 16, 60] }]);
    else printTable({ title, head, rows: data, num: [3, 4, 5] });
  });
}
