// Замовлення: прийом і опис продукту, що зробити (чекліст), деталі зі складу,
// передача між відділами з історією. Тут же — список відділів.
import { api, TRASH_DAYS } from '../api.js';
import {
  esc, fmtQty, fmtDate, parseNum, round, norm, toast, confirmDialog, promptDialog,
  statusTag, ORDER_STATUS, todayIso, downloadXlsx,
} from '../util.js';
import {
  state, go, reloadData, itemPicker, userName, depName, myDepartment, ACTIVE_ORDER, ICON_PLUS,
  trashRow, bindTrash, TRASH_EMPTY, can,
} from '../core.js';

const findOrder = (id) => state.orders.find((o) => o.id === id);
const doneCount = (o) => o.tasks.filter((t) => t.done).length;
const isOverdue = (o) => !!o.due_date && ACTIVE_ORDER.includes(o.status) && o.due_date < todayIso();
const fmtDue = (d) => (d ? fmtDate(`${d}T00:00:00`, false) : '');
const isActive = (o) => ACTIVE_ORDER.includes(o.status);

// ------------------------------------------------------------------
// Список
// ------------------------------------------------------------------
const FILTERS = [
  ['mine', 'Мій відділ', (o) => isActive(o) && o.department_id === myDepartment()],
  ['active', 'Усі активні', isActive],
  ['testing', 'На тестуванні', (o) => o.status === 'testing'],
  ['rework', 'На доопрацюванні', (o) => o.status === 'rework'],
  ['done', 'Готові', (o) => o.status === 'done'],
  ['archive', 'Архів', (o) => !isActive(o)],
];
const ui = { q: '', f: null };

function orderRow(o) {
  const n = doneCount(o);
  const t = o.tasks.length;
  return `<a class="row order-row" href="#/order/${o.id}">
    <div class="row-main">
      <div class="row-title"><span class="no">№${o.number}</span>${esc(o.title)}${o.qty !== 1 ? ` <span class="muted">× ${fmtQty(o.qty)}</span>` : ''}</div>
      <div class="row-meta">${statusTag(o.status)}${esc(depName(o.department_id))}${o.customer ? ` · ${esc(o.customer)}` : ''}</div>
    </div>
    <div class="row-qty${t && n === t ? ' ok' : ''}">
      ${t ? `<b>${n}/${t}</b><small>пунктів</small>` : ''}
      ${o.due_date ? `<em class="${isOverdue(o) ? 'overdue' : 'due'}">до ${fmtDue(o.due_date)}</em>` : ''}
    </div>
  </a>`;
}

export function viewOrders(ctx) {
  ctx.header({ title: 'Замовлення', actions: can('orders.edit') ? `<a class="btn primary sm" href="#/order-edit/new">${ICON_PLUS}<span>Замовлення</span></a>` : '' });
  if (ui.f === 'trash' && !can('orders.delete')) ui.f = null;
  const mine = myDepartment();
  if (!ui.f) ui.f = mine ? 'mine' : 'active';
  const counts = Object.fromEntries(FILTERS.map(([k, , fn]) => [k, state.orders.filter(fn).length]));
  ctx.main.innerHTML = `
    <div class="toolbar"><div class="search">
      <input type="search" id="q" placeholder="Пошук: номер, виріб, замовник" value="${esc(ui.q)}" autocomplete="off"></div></div>
    <div class="chips" id="chips">${FILTERS.map(([k, label]) => `<button class="chip${ui.f === k ? ' on' : ''}" data-f="${k}">${label}${k !== 'archive' && counts[k] ? ` · ${counts[k]}` : ''}</button>`).join('')}
      ${can('orders.delete') && (state.trashOrders.length || ui.f === 'trash') ? `<button class="chip trash-chip${ui.f === 'trash' ? ' on' : ''}" data-f="trash">Кошик${state.trashOrders.length ? ` · ${state.trashOrders.length}` : ''}</button>` : ''}</div>
    <div id="list" class="list"></div>`;
  const listEl = ctx.main.querySelector('#list');

  const render = () => {
    const words = norm(ui.q).split(/\s+/).filter(Boolean);
    const match = (o) => {
      const hay = norm(`№${o.number} ${o.number} ${o.title} ${o.customer} ${o.description}`);
      return words.every((w) => hay.includes(w));
    };
    if (ui.f === 'trash') {
      const list = state.trashOrders.filter(match);
      listEl.innerHTML = list.length ? list.map((o) => trashRow({
        id: o.id,
        title: `<span class="no">№${o.number}</span>${esc(o.title)}`,
        meta: `${statusTag(o.status)}${esc(depName(o.department_id))}`,
        deletedAt: o.deleted_at,
        deletedBy: o.deleted_by,
      })).join('') : TRASH_EMPTY;
      return;
    }
    // підказка «з чого почати» — лише на головних вкладках, а не в архіві
    if (!state.orders.length && (ui.f === 'mine' || ui.f === 'active')) {
      listEl.innerHTML = `<div class="empty-state">
        <p>Замовлень ще немає.</p>
        <p>Прийміть замовлення: опишіть продукт, складіть список того, що треба зробити, вкажіть деталі зі складу.
           Далі передавайте його між відділами — напр. на тестування — і вся історія лишиться в картці.</p>
        ${can('orders.edit') ? '<p><a class="btn primary" href="#/order-edit/new">Прийняти перше замовлення</a></p>' : ''}</div>`;
      return;
    }
    if (ui.f === 'mine' && !mine) {
      listEl.innerHTML = `<div class="empty-state"><p>Ви ще не вказали свій відділ.</p>
        <p>${can('orders.all') ? '<a class="btn primary" href="#/departments">Вибрати відділ</a>' : 'Відділ вам призначає адміністратор.'}</p></div>`;
      return;
    }
    const fn = FILTERS.find(([k]) => k === ui.f)[2];
    let list = state.orders.filter(fn);
    if (words.length) list = list.filter(match);
    // активні — за терміном (без терміну в кінці), архів — найновіші зверху
    if (ui.f !== 'archive') {
      list.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || b.number - a.number);
    }
    listEl.innerHTML = list.length ? list.map(orderRow).join('')
      : `<div class="empty-state"><p>${words.length ? 'Нічого не знайдено' : ui.f === 'mine' ? 'На ваш відділ зараз нічого не чекає' : 'Тут порожньо'}</p></div>`;
  };
  render();
  bindTrash(listEl, {
    restore: (id) => api.restoreOrder(id),
    purge: (id) => api.purgeOrder(id),
    purgeText: (id) => {
      const o = state.trashOrders.find((x) => x.id === id);
      return `Видалити замовлення №${o?.number} назавжди? Зникнуть чекліст та історія. Видача зі складу лишиться в журналі.`;
    },
    after: () => viewOrders(ctx),
  });

  const q = ctx.main.querySelector('#q');
  q.addEventListener('input', () => { ui.q = q.value; render(); });
  ctx.main.querySelector('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    ui.f = b.dataset.f;
    ctx.main.querySelectorAll('#chips .chip').forEach((c) => c.classList.toggle('on', c === b));
    render();
  });
}

// ------------------------------------------------------------------
// Картка замовлення
// ------------------------------------------------------------------
const ACTIONS = {
  new: [['in_work', 'Взяти в роботу', 'primary'], ['testing', 'Передати на тестування', 'ghost']],
  in_work: [['testing', 'Передати на тестування', 'primary']],
  rework: [['testing', 'Передати на тестування', 'primary']],
  testing: [['done', 'Тест пройдено', 'in'], ['rework', 'Повернути на доопрацювання', 'out']],
  done: [['shipped', 'Відвантажено', 'primary'], ['rework', 'Повернути на доопрацювання', 'ghost']],
  shipped: [['in_work', 'Відновити', 'ghost']],
  cancelled: [['in_work', 'Відновити', 'ghost']],
};
const MOVE_TITLE = {
  in_work: 'Взяти в роботу',
  testing: 'Передати на тестування',
  done: 'Тест пройдено',
  rework: 'Повернути на доопрацювання',
  shipped: 'Відвантажено',
  cancelled: 'Скасувати замовлення',
};

function actionButtons(o) {
  const del = can('orders.delete') ? '<button type="button" class="btn ghost sm del-btn" data-delete>Видалити</button>' : '';
  if (!can('orders.edit')) return `<span class="grow"></span>${del}`;
  const main = (ACTIONS[o.status] || []).map(([to, label, cls]) => `<button type="button" class="btn ${cls}" data-to="${to}">${label}</button>`).join('');
  const extra = isActive(o) ? `<span class="grow"></span>
    <button type="button" class="link-btn plain" data-to="${o.status}" data-handoff>Передати в інший відділ</button>
    <button type="button" class="link-btn" data-to="cancelled">Скасувати замовлення</button>`
    : '<span class="grow"></span>';
  return `${main}${extra}${del}`;
}

// у який відділ найімовірніше піде замовлення — підставляємо, але людина може змінити
function defaultDept(o, to, events) {
  const lastMoveTo = (status) => events.slice().reverse().find((e) => e.kind === 'move' && e.to_status === status);
  let id = o.department_id;
  if (to === 'testing') id = state.departments.find((d) => /тест/i.test(d.name))?.id || id;
  else if (to === 'rework') id = lastMoveTo('testing')?.from_department || id;     // тому, хто передав на тест
  else if (to === 'done') id = events.find((e) => e.kind === 'created')?.to_department || id;  // тому, хто приймав
  else if (to === 'in_work' && o.status === 'new') id = myDepartment() || id;
  return state.departments.some((d) => d.id === id) ? id : o.department_id;
}

function moveDialog({ o, to, handoff, dep, warn }) {
  return new Promise((resolve) => {
    const reopen = to === 'in_work' && !isActive(o);
    const title = handoff ? 'Передати в інший відділ' : reopen ? 'Відновити замовлення' : MOVE_TITLE[to];
    const need = to === 'rework' || to === 'cancelled';
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal move-dialog" role="dialog" aria-modal="true" autocomplete="off">
      <h2 class="modal-title">${esc(title)}</h2>
      <p class="muted">№${o.number} · ${esc(o.title)}</p>
      ${handoff ? '' : `<p>${statusTag(o.status)} → ${statusTag(to)}</p>`}
      ${warn ? `<p class="badge warn">${esc(warn)}</p>` : ''}
      ${state.departments.length ? `<label class="field"><span>Відділ, куди переходить замовлення</span><select name="dep">
        ${state.departments.map((d) => `<option value="${d.id}"${d.id === dep ? ' selected' : ''}>${esc(d.name)}${d.id === o.department_id ? ' (зараз тут)' : ''}</option>`).join('')}
      </select></label>` : ''}
      <label class="field"><span>${to === 'rework' ? 'Що треба доопрацювати *' : to === 'cancelled' ? 'Причина скасування *' : 'Коментар'}</span>
        <textarea name="c" rows="3" placeholder="${to === 'testing' ? 'Що перевірити, на що звернути увагу' : ''}"></textarea></label>
      <p class="err-text" data-err hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-cancel>Назад</button>
        <button class="btn ${to === 'cancelled' ? 'danger' : 'primary'}">${esc(handoff ? 'Передати' : title)}</button>
      </div></form>`;
    const form = wrap.querySelector('form');
    const done = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    const err = form.querySelector('[data-err]');
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const depId = form.dep?.value || null;
      const comment = form.c.value.trim();
      if (need && !comment) return fail(to === 'rework' ? 'Напишіть, що треба доопрацювати' : 'Напишіть причину скасування', form.c);
      if (handoff && depId === o.department_id) return fail('Виберіть інший відділ', form.dep);
      done({ dep: depId, comment });
    });
    form.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    (handoff ? form.dep : form.c)?.focus();
  });
}

const taskRow = (t) => `<label class="task${t.done ? ' done' : ''}">
  <input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''}${can('orders.edit') ? '' : ' disabled'}>
  <span class="task-text"><span class="tt">${esc(t.text)}</span>${t.done ? `<small>${esc(userName(t.done_by))}, ${fmtDate(t.done_at)}</small>` : ''}</span></label>`;

function partsHtml(o, issued) {
  let short = 0;
  let left = 0;
  const rows = o.parts.map((p) => {
    const it = state.byId.get(p.item_id);
    const got = issued[p.item_id] || 0;
    const rest = Math.max(0, round(p.qty - got));
    const have = it?.qty || 0;
    const lack = rest > 0 && have < rest;
    if (rest > 0) left++;
    if (lack) short++;
    return `<tr class="${lack ? 'bad' : ''}"><td><a href="#/item/${p.item_id}">${esc(it?.name || '?')}</a></td>
      <td>${fmtQty(p.qty)} ${esc(it?.unit || '')}</td><td>${got ? fmtQty(got) : '—'}</td>
      <td>${fmtQty(have)}${lack ? ` <small class="err-text">бракує ${fmtQty(round(rest - have))}</small>` : ''}</td></tr>`;
  }).join('');
  return `<table class="tbl"><thead><tr><th>Деталь</th><th>потрібно</th><th>видано</th><th>на складі</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="form-actions">${left
    ? `<span class="muted">${short ? `Бракує на складі: ${short} поз.` : 'Усе потрібне є на складі'}</span><span class="grow"></span>
       ${can('ops.edit') ? `<a class="btn out" href="#/op/out?order=${o.id}">Видати зі складу</a>` : ''}`
    : '<span class="pos">Усі деталі видано</span>'}</div>`;
}

function eventHtml(e) {
  let head;
  if (e.kind === 'created') head = `<b>Замовлення прийнято</b> <span>→ ${esc(depName(e.to_department))}</span>`;
  else if (e.kind === 'comment') head = '<b>Коментар</b>';
  else {
    const st = e.from_status !== e.to_status ? `${statusTag(e.from_status)}<span>→</span>${statusTag(e.to_status)}` : '<b>Передано</b>';
    const dp = e.from_department !== e.to_department
      ? `<span>${esc(depName(e.from_department))} → <b>${esc(depName(e.to_department))}</b></span>` : '';
    head = st + dp;
  }
  return `<div class="ev ev-${e.kind}"><div class="ev-head">${head}</div>
    <small class="muted">${fmtDate(e.created_at)} · ${esc(userName(e.created_by))}</small>
    ${e.text ? `<div class="ev-text">${esc(e.text)}</div>` : ''}</div>`;
}

export async function viewOrder(ctx, id) {
  const o = findOrder(id);
  if (!o) { ctx.notFound(); return; }
  ctx.header({ title: `№${o.number} · ${o.title}`, back: '#/orders', actions: can('orders.edit') ? `<a class="btn ghost sm" href="#/order-edit/${id}">Редагувати</a>` : '' });
  const n = doneCount(o);
  const mineHere = isActive(o) && o.department_id && o.department_id === myDepartment();
  let events = [];
  let issued = {};

  ctx.main.innerHTML = `
    <div class="card order-card">
      <div class="order-head">${statusTag(o.status)}<b>${esc(depName(o.department_id))}</b>
        ${mineHere ? '<span class="badge warn">чекає на ваш відділ</span>' : ''}</div>
      <dl class="props">
        <dt>Замовник</dt><dd>${esc(o.customer) || '—'}</dd>
        <dt>Кількість</dt><dd>${fmtQty(o.qty)}</dd>
        ${o.due_date ? `<dt>Термін</dt><dd class="${isOverdue(o) ? 'overdue' : ''}">${fmtDue(o.due_date)}${isOverdue(o) ? ' — прострочено' : ''}</dd>` : ''}
        <dt>Прийняв</dt><dd>${esc(userName(o.created_by))}, ${fmtDate(o.created_at)}</dd>
      </dl>
      <div class="section-title">Опис продукту</div>
      ${o.description ? `<p class="note">${esc(o.description)}</p>` : `<p class="muted">Не заповнено${can('orders.edit') ? ` — <a href="#/order-edit/${id}">додати опис</a>` : ''}</p>`}
      <div class="order-actions" id="acts">${actionButtons(o)}</div>
    </div>

    <h3>Що потрібно зробити ${o.tasks.length ? `<span class="count${n === o.tasks.length ? ' pos' : ''}">${n} з ${o.tasks.length}</span>` : ''}</h3>
    <div class="card">
      ${o.tasks.length ? `<div class="progress"><i style="width:${Math.round((100 * n) / o.tasks.length)}%"></i></div>` : ''}
      <div class="tasks" id="tasks">${o.tasks.map(taskRow).join('') || '<div class="muted pad">Пунктів ще немає</div>'}</div>
      ${can('orders.edit') ? `<form class="add-task" id="addtask" autocomplete="off">
        <input name="t" placeholder="Додати пункт…"><button class="btn ghost sm">Додати</button></form>` : ''}
    </div>

    <h3>Деталі зі складу</h3>
    <div class="card" id="parts">${o.parts.length ? '<div class="muted">Завантаження…</div>'
      : `<p class="muted">Деталі не вказані.${can('orders.edit') ? ` <a href="#/order-edit/${id}">Додати</a> — тоді буде видно, чого бракує на складі, а видача спишеться під це замовлення.` : ''}</p>`}</div>

    <h3>Історія</h3>
    <div class="card">
      ${can('orders.edit') ? `<form class="comment-form" id="cmt" autocomplete="off">
        <textarea name="t" rows="2" placeholder="Коментар до замовлення…"></textarea>
        <div class="form-actions"><span class="grow"></span><button class="btn ghost sm">Додати коментар</button></div>
      </form>` : ''}
      <div class="timeline" id="events"><div class="muted pad">Завантаження…</div></div>
    </div>`;

  const refresh = async () => {
    await reloadData();
    if (!ctx.alive()) return;
    const y = window.scrollY;
    await viewOrder(ctx, id);
    window.scrollTo(0, y);
  };

  ctx.main.querySelector('#acts').addEventListener('click', async (e) => {
    if (e.target.closest('[data-delete]')) {
      const parts = Object.values(issued).some((q) => q > 0)
        ? ' Видані під нього деталі лишаться списаними — щоб повернути їх на склад, видаліть видачу в журналі.' : '';
      if (!await confirmDialog(`Видалити замовлення №${o.number} «${o.title}»?${parts} ${TRASH_DAYS} днів його можна відновити: Замовлення → Кошик.`,
        { ok: 'Видалити', danger: true })) return;
      try {
        await api.deleteOrder(id);
        await reloadData();
        toast(`Замовлення №${o.number} перенесено в кошик`);
        go('#/orders');
      } catch (err) { toast(err.message, 'err', 8000); }
      return;
    }
    const b = e.target.closest('[data-to]');
    if (!b) return;
    const to = b.dataset.to;
    const handoff = 'handoff' in b.dataset;
    let warn = '';
    if (to === 'testing' && o.tasks.length && n < o.tasks.length) warn = `Виконано ${n} з ${o.tasks.length} пунктів чекліста.`;
    if (to === 'shipped' && o.parts.some((p) => (issued[p.item_id] || 0) < p.qty)) warn = 'Не всі деталі видано зі складу.';
    const dep = handoff ? state.departments.find((d) => d.id !== o.department_id)?.id : defaultDept(o, to, events);
    const r = await moveDialog({ o, to, handoff, dep, warn });
    if (!r) return;
    try {
      await api.moveOrder(id, to, r.dep, r.comment);
      const where = r.dep && r.dep !== o.department_id ? ` → ${depName(r.dep)}` : '';
      toast(handoff ? `Передано${where}` : `${ORDER_STATUS[to].label}${where}`);
      await refresh();
    } catch (err) { toast(err.message, 'err', 6000); }
  });

  ctx.main.querySelector('#tasks').addEventListener('change', async (e) => {
    const taskId = e.target.dataset.task;
    if (!taskId) return;
    e.target.disabled = true;
    try {
      await api.setTaskDone(taskId, e.target.checked);
      await refresh();
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  });

  ctx.main.querySelector('#addtask')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = e.target.t.value.trim();
    if (!t) return;
    try {
      await api.addTask(id, t, o.tasks.length ? Math.max(...o.tasks.map((x) => x.position)) + 1 : 0);
      await refresh();
      ctx.main.querySelector('#addtask input')?.focus();
    } catch (err) { toast(err.message, 'err'); }
  });

  ctx.main.querySelector('#cmt')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = e.target.t.value.trim();
    if (!t) return toast('Порожній коментар', 'err');
    try {
      await api.addOrderComment(id, t);
      await refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  [events, issued] = await Promise.all([
    api.orderEvents(id).catch((err) => { toast(err.message, 'err'); return []; }),
    o.parts.length ? api.orderIssued(id).catch(() => ({})) : {},
  ]);
  if (!ctx.alive()) return;
  if (o.parts.length) ctx.main.querySelector('#parts').innerHTML = partsHtml(o, issued);
  ctx.main.querySelector('#events').innerHTML = events.slice().reverse().map(eventHtml).join('') || '<div class="muted">Записів немає</div>';
}

// ------------------------------------------------------------------
// Прийом / редагування
// ------------------------------------------------------------------
export function viewOrderEdit(ctx, id) {
  const isNew = id === 'new';
  const o = isNew
    ? { title: '', customer: '', qty: 1, due_date: '', description: '', department_id: myDepartment() || state.departments[0]?.id || null, tasks: [], parts: [] }
    : findOrder(id);
  if (!o) { ctx.notFound(); return; }
  const back = isNew ? '#/orders' : `#/order/${id}`;
  ctx.header({ title: isNew ? 'Нове замовлення' : `Редагування №${o.number}`, back });
  const tasks = o.tasks.map((t) => ({ id: t.id, text: t.text, done: t.done }));
  const parts = o.parts.map((p) => ({ item_id: p.item_id, qty: fmtQty(p.qty) }));
  const customers = [...new Set(state.orders.map((x) => x.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  const kits = state.kits.filter((k) => !k.archived && k.components.length);

  ctx.main.innerHTML = `
    <form class="form card" id="f" autocomplete="off">
      <label class="field"><span>Що замовили *</span>
        <input name="title" required value="${esc(o.title)}" placeholder='Напр. Дрон 7" з нічною камерою'></label>
      <div class="grid2">
        <label class="field"><span>Замовник</span><input name="customer" list="dl-cust" value="${esc(o.customer)}" placeholder="Хто замовив, контакт"></label>
        <label class="field"><span>Кількість</span><input name="qty" inputmode="decimal" value="${fmtQty(o.qty)}"></label>
        <label class="field"><span>Термін</span><input name="due_date" type="date" value="${esc(o.due_date || '')}"></label>
        ${isNew && state.departments.length ? `<label class="field"><span>Відділ, де буде замовлення</span><select name="dep">
          ${state.departments.filter((d) => can('orders.all') || d.id === myDepartment()).map((d) => `<option value="${d.id}"${d.id === o.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      <label class="field"><span>Опис продукту</span>
        <textarea name="description" rows="5" placeholder="Характеристики, комплектація, побажання замовника…">${esc(o.description)}</textarea></label>

      <h3>Що потрібно зробити</h3>
      <div id="tasks" class="lines"></div>
      <div class="add-task"><input id="newtask" placeholder="Новий пункт, напр. «Прошити польотник» і Enter">
        <button type="button" class="btn ghost sm" id="addtask">Додати</button></div>

      <h3>Деталі зі складу <small class="muted">— на все замовлення</small></h3>
      ${kits.length ? `<select id="kit" aria-label="Додати комплект"><option value="">＋ Додати всі деталі комплекту…</option>
        ${kits.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>` : ''}
      <div id="picker"></div>
      <div id="parts" class="lines"></div>

      <datalist id="dl-cust">${customers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="form-actions">
        <span class="grow"></span>
        <a class="btn ghost" href="${back}">Скасувати</a>
        <button class="btn primary" id="save">${isNew ? 'Прийняти замовлення' : 'Зберегти'}</button>
      </div>
    </form>`;
  const f = ctx.main.querySelector('#f');
  const tasksEl = ctx.main.querySelector('#tasks');
  const partsEl = ctx.main.querySelector('#parts');
  const newTask = ctx.main.querySelector('#newtask');

  // ---- чекліст ----
  const renderTasks = () => {
    tasksEl.innerHTML = tasks.length ? tasks.map((t, n) => `<div class="task-edit" data-n="${n}">
        <span class="task-n">${t.done ? '✓' : `${n + 1}.`}</span>
        <input class="ttext" value="${esc(t.text)}" aria-label="Пункт ${n + 1}">
        <button type="button" class="icon-btn" data-up aria-label="Вище" ${n ? '' : 'disabled'}>↑</button>
        <button type="button" class="icon-btn" data-rm aria-label="Прибрати">✕</button></div>`).join('')
      : '<div class="muted pad center">Додайте пункти — що саме треба зробити за замовленням</div>';
  };
  const addTask = () => {
    const t = newTask.value.trim();
    if (!t) return;
    tasks.push({ text: t });
    newTask.value = '';
    renderTasks();
    newTask.focus();
  };
  renderTasks();
  ctx.main.querySelector('#addtask').addEventListener('click', addTask);
  newTask.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } });
  tasksEl.addEventListener('input', (e) => { if (e.target.classList.contains('ttext')) tasks[+e.target.closest('.task-edit').dataset.n].text = e.target.value; });
  tasksEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('ttext')) { e.preventDefault(); newTask.focus(); } });
  tasksEl.addEventListener('click', (e) => {
    const row = e.target.closest('.task-edit');
    if (!row) return;
    const n = +row.dataset.n;
    if (e.target.closest('[data-rm]')) { tasks.splice(n, 1); renderTasks(); }
    if (e.target.closest('[data-up]') && n > 0) { [tasks[n - 1], tasks[n]] = [tasks[n], tasks[n - 1]]; renderTasks(); }
  });

  // ---- деталі ----
  const renderParts = (focus = -1) => {
    partsEl.innerHTML = parts.length ? parts.map((p, n) => {
      const it = state.byId.get(p.item_id);
      return `<div class="line" data-n="${n}"><div class="line-name"><b>${esc(it?.name || '?')}</b>
          <small class="muted">на складі ${fmtQty(it?.qty || 0)} ${esc(it?.unit || '')}</small></div>
        <input class="qty" inputmode="decimal" value="${esc(p.qty)}" placeholder="к-сть" aria-label="Кількість">
        <span class="unit">${esc(it?.unit || '')}</span>
        <button type="button" class="icon-btn" data-rm aria-label="Прибрати">✕</button></div>`;
    }).join('') : '<div class="muted pad center">Знайдіть деталь у полі вище або додайте цілий комплект</div>';
    if (focus >= 0) partsEl.querySelectorAll('.qty')[focus]?.focus();
  };
  const addPart = (itemId, qty) => {
    const i = parts.findIndex((p) => p.item_id === itemId);
    if (i >= 0) { parts[i].qty = fmtQty(round((parseNum(parts[i].qty) || 0) + qty)); return i; }
    parts.push({ item_id: itemId, qty: fmtQty(qty) });
    return parts.length - 1;
  };
  renderParts();
  itemPicker(ctx.main.querySelector('#picker'), (item) => {
    const i = parts.findIndex((p) => p.item_id === item.id);
    if (i >= 0) return renderParts(i);
    parts.push({ item_id: item.id, qty: '' });
    renderParts(parts.length - 1);
  }, { placeholder: 'Додати деталь: назва або код…' });
  ctx.main.querySelector('#kit')?.addEventListener('change', (e) => {
    const kit = state.kits.find((k) => k.id === e.target.value);
    e.target.value = '';
    if (!kit) return;
    const mult = parseNum(f.qty.value) > 0 ? parseNum(f.qty.value) : 1;
    for (const c of kit.components) if (state.byId.has(c.item_id)) addPart(c.item_id, round(c.qty * mult));
    renderParts();
    toast(`Додано деталі комплекту «${kit.name}» × ${fmtQty(mult)}`);
  });
  partsEl.addEventListener('input', (e) => { if (e.target.classList.contains('qty')) parts[+e.target.closest('.line').dataset.n].qty = e.target.value; });
  partsEl.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { parts.splice(+e.target.closest('.line').dataset.n, 1); renderParts(); } });

  // ---- збереження ----
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const qty = parseNum(f.qty.value);
    if (!f.title.value.trim()) return toast('Вкажіть, що замовили', 'err');
    if (!(qty > 0)) return toast('Кількість має бути більше 0', 'err');
    if (newTask.value.trim()) tasks.push({ text: newTask.value.trim() });  // набрали, але не натиснули «Додати»
    const outTasks = tasks.map((t) => ({ id: t.id, text: t.text.trim() })).filter((t) => t.text);
    const outParts = [];
    for (const p of parts) {
      const q = parseNum(p.qty);
      if (!(q > 0)) return toast(`Кількість для «${state.byId.get(p.item_id)?.name}» має бути більше 0`, 'err');
      outParts.push({ item_id: p.item_id, qty: q });
    }
    const btn = f.querySelector('#save');
    btn.disabled = true;
    try {
      const saved = await api.saveOrder({
        id: isNew ? undefined : id,
        title: f.title.value, customer: f.customer.value, qty, due_date: f.due_date.value || null,
        description: f.description.value, department_id: isNew ? (f.dep?.value || null) : undefined,
      }, outTasks, outParts);
      await reloadData();
      toast(isNew ? `Замовлення №${findOrder(saved)?.number ?? ''} прийнято` : 'Збережено');
      go(`#/order/${saved}`);
    } catch (err) {
      toast(err.message, 'err', 6000);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------
// Відділи
// ------------------------------------------------------------------
export function viewDepartments(ctx) {
  ctx.header({ title: 'Відділи', back: '#/more' });
  const mine = myDepartment();
  ctx.main.innerHTML = `
    <div class="card hint">Замовлення передаються між відділами. ${can('orders.all')
    ? 'Позначте свій відділ — тоді в «Замовлення → Мій відділ» буде видно, що чекає саме на вас.'
    : 'Ваш відділ призначає адміністратор.'}</div>
    <div class="list" id="deps">${state.departments.map((d) => {
      const n = state.orders.filter((o) => o.department_id === d.id && isActive(o)).length;
      const people = Object.entries(state.depOf).filter(([, dep]) => dep === d.id).map(([u]) => userName(u));
      return `<div class="row dep-row" data-id="${d.id}">
        <div class="row-main"><div class="row-title">${esc(d.name)}${d.id === mine ? ' <span class="tag st-done">мій</span>' : ''}</div>
          <div class="row-meta">активних замовлень: ${n}${people.length ? ` · ${esc(people.join(', '))}` : ''}</div></div>
        ${d.id === mine || !can('orders.all') ? '' : '<button class="btn ghost sm" data-mine>Мій відділ</button>'}
        ${can('admin') ? `<button class="icon-btn" data-ren title="Перейменувати" aria-label="Перейменувати">✎</button>
        <button class="icon-btn" data-del title="Видалити" aria-label="Видалити">✕</button>` : ''}
      </div>`;
    }).join('') || '<div class="muted pad">Відділів немає — додайте нижче</div>'}</div>
    ${can('admin') ? `<form class="add-task card" id="add" autocomplete="off">
      <input name="n" placeholder="Новий відділ, напр. «Пакування»"><button class="btn primary sm">Додати</button></form>` : ''}`;

  const done = async (msg) => {
    await reloadData();
    if (msg) toast(msg);
    if (ctx.alive()) viewDepartments(ctx);
  };
  ctx.main.querySelector('#deps').addEventListener('click', async (e) => {
    const row = e.target.closest('.dep-row');
    if (!row) return;
    const dep = state.departments.find((d) => d.id === row.dataset.id);
    try {
      if (e.target.closest('[data-mine]')) {
        await api.setMyDepartment(dep.id);
        await done(`Ваш відділ: ${dep.name}`);
      } else if (e.target.closest('[data-ren]')) {
        const name = await promptDialog('Нова назва відділу', dep.name);
        if (name && name !== dep.name) { await api.saveDepartment({ id: dep.id, name }); await done('Перейменовано'); }
      } else if (e.target.closest('[data-del]')) {
        if (!await confirmDialog(`Видалити відділ «${dep.name}»?`, { ok: 'Видалити', danger: true })) return;
        await api.deleteDepartment(dep.id);
        await done('Відділ видалено');
      }
    } catch (err) { toast(err.message, 'err', 6000); }
  });
  ctx.main.querySelector('#add')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.n.value.trim();
    if (!name) return;
    try {
      await api.saveDepartment({ name });
      await done('Відділ додано');
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ------------------------------------------------------------------
export function exportOrders() {
  const rows = [['№', 'Прийнято', 'Прийняв', 'Що замовили', 'К-сть', 'Замовник', 'Термін', 'Статус', 'Відділ', 'Виконано пунктів', 'Опис продукту']];
  for (const o of state.orders.slice().sort((a, b) => a.number - b.number)) {
    rows.push([o.number, fmtDate(o.created_at), userName(o.created_by), o.title, o.qty, o.customer, fmtDue(o.due_date),
      ORDER_STATUS[o.status]?.label || o.status, depName(o.department_id),
      o.tasks.length ? `${doneCount(o)}/${o.tasks.length}` : '', o.description]);
  }
  downloadXlsx(`замовлення_${todayIso()}.xlsx`, [{ name: 'Замовлення', rows, widths: [6, 17, 14, 34, 7, 22, 11, 17, 18, 10, 50] }]);
}
