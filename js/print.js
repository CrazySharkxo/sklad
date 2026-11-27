// Друк документів через вікно друку браузера (там же — «Зберегти як PDF»):
// накладні по операціях журналу, картка замовлення, QR-етикетки виробів.
import { esc, fmtQty, fmtSigned, fmtDate, OP_TYPES, ORDER_STATUS, qrSvg } from './util.js';
import { state, userName, depName, shippedQty, shipLeft, openDebts } from './core.js';

const orgName = () => state.settings?.org_name || 'Склад';
const anyOrder = (id) => (id ? state.orders.find((o) => o.id === id) || state.trashOrders.find((o) => o.id === id) : null);
const fmtDue = (d) => (d ? fmtDate(`${d}T00:00:00`, false) : '—');
const box = (v) => (v ? '☑' : '☐');

// шапка документа: організація, тип, №, дата
function head(title, no, date) {
  return `<div class="doc-head">
    <div class="doc-org">${esc(orgName())}</div>
    <h1>${esc(title)}</h1>
    <div class="doc-no">№ ${esc(no)} від ${esc(fmtDate(date))}</div>
  </div>`;
}

// підписи в ряд: ['Видав', 'Отримав'] → лінії для підпису
const signRow = (names) => `<div class="sign-row">${names.map((n) => `<div class="sign"><span>${esc(n)}</span><i></i></div>`).join('')}</div>`;

// вставити документ у #print-area і відкрити вікно друку
function printDoc(html) {
  const host = document.getElementById('print-area');
  host.innerHTML = `<div class="doc">${html}</div>`;
  setTimeout(() => window.print(), 50);
}

// номер документа: дата + початок id
const docNo = (op) => `${(op.created_at || '').slice(0, 10).replace(/-/g, '')}-${String(op.id || '').slice(0, 8)}`;

// ------------------------------------------------------------------
// Накладна / акт по операції з журналу
// ------------------------------------------------------------------
export function printOperation(op) {
  const isAdj = op.type === 'adjust';
  const isIn = op.type === 'in';
  const title = isAdj ? 'Акт інвентаризації' : isIn ? 'Прибуткова накладна' : 'Видаткова накладна';
  const kit = op.kit_id ? state.kits.find((k) => k.id === op.kit_id) : null;
  const ord = anyOrder(op.order_id);
  const rows = (op.movements || []).map((m, n) => {
    const it = state.byId.get(m.item_id);
    return `<tr><td class="num">${n + 1}</td><td>${esc(it?.name || '(видалена позиція)')}</td><td>${esc(it?.code || '')}</td>
      <td class="num">${isAdj ? fmtSigned(m.qty) : fmtQty(Math.abs(m.qty))}</td><td>${esc(it?.unit || '')}</td></tr>`;
  }).join('');
  const props = [
    ['Тип', OP_TYPES[op.type]?.label || op.type],
    kit ? ['Комплект', `${kit.name} × ${fmtQty(op.kit_qty)}`] : null,
    op.counterparty ? [isIn ? 'Постачальник' : 'Кому / для чого', op.counterparty] : null,
    ord ? ['Замовлення', `№${ord.number} · ${ord.title}`] : null,
    op.comment ? ['Коментар', op.comment] : null,
    ['Провів', `${userName(op.created_by)}, ${fmtDate(op.created_at)}`],
  ].filter(Boolean);
  printDoc(`${head(title, docNo(op), op.created_at)}
    <dl class="doc-props">${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <table class="doc-tbl"><thead><tr><th>№</th><th>Назва</th><th>Код</th><th>${isAdj ? 'Розбіжність' : 'Кількість'}</th><th>Од.</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted-print">Розбіжностей не було</td></tr>'}</tbody></table>
    <p class="doc-total">Позицій: ${(op.movements || []).length}</p>
    ${signRow(isAdj ? ['Комісія', 'Комісія'] : isIn ? ['Здав', 'Прийняв'] : ['Видав', 'Отримав'])}`);
}

// ------------------------------------------------------------------
// Картка замовлення (виробниче завдання)
// ------------------------------------------------------------------
export function printOrder(o, { issued = {}, events = [] } = {}) {
  const who = (id, at) => (id ? `${userName(id)}${at ? `, ${fmtDate(at)}` : ''}` : '');
  const props = [
    ['Замовник', o.customer || '—'],
    ['Кількість', fmtQty(o.qty)],
    ['Термін', fmtDue(o.due_date)],
    ['Статус', ORDER_STATUS[o.status]?.label || o.status],
    ...(shippedQty(o) > 0 ? [['Видано замовнику', `${fmtQty(shippedQty(o))} з ${fmtQty(o.qty)}${shipLeft(o) > 0 ? `, лишилось ${fmtQty(shipLeft(o))}` : ''}`]] : []),
    ...(openDebts(o).length ? [['Борг замовнику', openDebts(o).map((d) => `${state.byId.get(d.item_id)?.name || '?'} × ${fmtQty(d.left_qty)}`).join(', ')]] : []),
    ['Відділ', depName(o.department_id)],
    ['Прийняв', who(o.created_by, o.created_at)],
  ];
  const tasks = (o.tasks || []).map((t, n) => `<li class="${t.done ? 'done' : ''}">${box(t.done)} ${n + 1}. ${esc(t.text)}
    ${t.done ? `<small>${esc(who(t.done_by, t.done_at))}</small>` : ''}</li>`).join('');
  const parts = (o.parts || []).map((p) => {
    const it = state.byId.get(p.item_id);
    return `<tr><td>${esc(it?.name || '?')}</td><td class="num">${fmtQty(p.qty)}</td><td class="num">${fmtQty(issued[p.item_id] || 0)}</td><td>${esc(it?.unit || '')}</td></tr>`;
  }).join('');
  const units = (o.units || []).map((u, n) => `<tr><td class="num">${n + 1}</td><td><b>${esc(u.serial)}</b></td>
    <td>${box(u.assembled)} ${esc(u.assembled ? who(u.assembled_by, u.assembled_at) : '')}</td>
    <td>${box(u.tested)} ${esc(u.tested ? who(u.tested_by, u.tested_at) : '')}</td><td>${esc(u.note || '')}</td></tr>`).join('');
  // остання передача з коментарем — щоб на папері було видно, чому замовлення тут
  const last = events.slice().reverse().find((e) => e.kind === 'move' && e.text);
  printDoc(`${head(`Замовлення №${o.number}`, String(o.number), o.created_at)}
    <h2>${esc(o.title)}</h2>
    <dl class="doc-props">${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${o.description ? `<h3>Опис продукту</h3><p class="doc-text">${esc(o.description)}</p>` : ''}
    ${tasks ? `<h3>Що потрібно зробити</h3><ul class="doc-tasks">${tasks}</ul>` : ''}
    ${parts ? `<h3>Деталі зі складу</h3><table class="doc-tbl"><thead><tr><th>Деталь</th><th>Потрібно</th><th>Видано</th><th>Од.</th></tr></thead><tbody>${parts}</tbody></table>` : ''}
    ${units ? `<h3>Вироби</h3><table class="doc-tbl"><thead><tr><th>№</th><th>Серійний номер</th><th>Зібрано</th><th>Протестовано</th><th>Примітка</th></tr></thead><tbody>${units}</tbody></table>` : ''}
    ${last ? `<p class="doc-text"><b>${esc(ORDER_STATUS[last.to_status]?.label || '')}</b> — ${esc(userName(last.created_by))}, ${esc(fmtDate(last.created_at))}: ${esc(last.text)}</p>` : ''}
    ${signRow(['Виконав', 'Прийняв'])}`);
}

// ------------------------------------------------------------------
// Простий список-таблиця (нестача під комплект / під замовлення).
// head — назви стовпців, rows — рядки значень, num — номери числових стовпців
// ------------------------------------------------------------------
export function printTable({ title, note = '', head: cols, rows, num = [] }) {
  const cell = (v, n) => `<td${num.includes(n) ? ' class="num"' : ''}>${esc(typeof v === 'number' ? fmtQty(v) : v)}</td>`;
  printDoc(`<div class="doc-head"><div class="doc-org">${esc(orgName())}</div><h1>${esc(title)}</h1>
      <div class="doc-no">станом на ${esc(fmtDate(new Date().toISOString()))}</div></div>
    ${note ? `<p class="doc-text">${esc(note)}</p>` : ''}
    <table class="doc-tbl"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table>
    <p class="doc-total">Позицій: ${rows.length}</p>`);
}

// ------------------------------------------------------------------
// QR-етикетки виробів: скан «SN:<серійний>» відкриває замовлення
// ------------------------------------------------------------------
export function printUnitLabels(o, units) {
  const host = document.getElementById('print-area');
  host.innerHTML = `<div class="labels">${units.map((u) => `
    <div class="label">
      <div class="label-qr">${qrSvg(`SN:${u.serial}`)}</div>
      <div class="label-text"><b>${esc(u.serial)}</b><small>${esc(o.title)}</small><small>Замовлення №${o.number}${o.customer ? ` · ${esc(o.customer)}` : ''}</small></div>
    </div>`).join('')}</div>`;
  setTimeout(() => window.print(), 50);
}
