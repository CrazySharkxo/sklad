// Офлайн-черга: прихід / видаток / інвентаризація / видача комплекту, проведені
// без інтернету, лягають сюди (localStorage) і відправляються, щойно зʼявиться
// мережа. Кожен запис має свій op_id — сервер (post_operation p_op_id) не створить
// дубля, якщо відповідь загубилася і ми відправили те саме ще раз.
import { api, isDemo } from './api.js';
import { esc, fmtQty, fmtSigned, fmtDate, round, toast, confirmDialog, OP_TYPES } from './util.js';
import { state, userName } from './core.js';

export const OUTBOX_EVENT = 'sklad:outbox';
const KEY = 'sklad-outbox';

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* переповнене сховище — запис уже застосовано до state, не падаємо */ }
  document.dispatchEvent(new Event(OUTBOX_EVENT));
}

export function pending() { return load().map((r) => ({ ...r })); }

const isNetError = (err) => {
  const m = err?.message || String(err);
  return m === 'Немає зʼєднання з сервером' || /Failed to fetch|NetworkError|Load failed/i.test(m);
};

// рядки операції так, як їх проведе сервер: in +, out −, adjust — різниця, kit_out — компоненти × к-сть
function linesOf(payload, qtyOf) {
  const { type } = payload;
  let lines = payload.lines || [];
  if (type === 'kit_out') {
    const kit = state.kits.find((k) => k.id === payload.kit_id);
    lines = (kit?.components || []).map((c) => ({ item_id: c.item_id, qty: round(c.qty * Number(payload.kit_qty)) }));
  }
  const merged = new Map();
  for (const l of lines) merged.set(l.item_id, round((merged.get(l.item_id) || 0) + Number(l.qty)));
  return [...merged].map(([item_id, qty]) => {
    const have = qtyOf(item_id);
    const delta = type === 'in' ? qty : type === 'adjust' ? round(qty - have) : -qty;
    return { item_id, qty: delta };
  });
}

// застосувати один запис до набору позицій (мутує обʼєкти)
function applyTo(byId, payload) {
  for (const { item_id, qty } of linesOf(payload, (id) => byId.get(id)?.qty || 0)) {
    const it = byId.get(item_id);
    if (it) it.qty = round((it.qty || 0) + qty);
  }
}

// черга поверх завантаженого (кешованого) списку позицій — щоб цифри збігалися з тим, що людина бачила
export function applyPendingTo(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const r of load()) applyTo(byId, r.payload);
  return items;
}

function labelOf(payload) {
  const t = OP_TYPES[payload.type]?.label || payload.type;
  const n = payload.type === 'kit_out'
    ? `${state.kits.find((k) => k.id === payload.kit_id)?.name || 'Комплект'} × ${fmtQty(payload.kit_qty)}`
    : `${(payload.lines || []).length} ${plural((payload.lines || []).length, 'позиція', 'позиції', 'позицій')}`;
  return [t, n, payload.counterparty].filter(Boolean).join(' · ');
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function enqueue(payload, op_id) {
  applyTo(state.byId, payload);  // оптимістично: екрани одразу показують нові цифри
  const list = load();
  list.push({ op_id, payload, created_at: new Date().toISOString(), error: null, label: labelOf(payload) });
  save(list);
}

// провести операцію; без мережі — покласти в чергу
export async function postOrQueue(payload) {
  if (isDemo) return { queued: false, id: await api.postOperation(payload) };
  const op_id = crypto.randomUUID();
  if (!navigator.onLine) { enqueue(payload, op_id); return { queued: true, op_id }; }
  try {
    return { queued: false, id: await api.postOperation({ ...payload, op_id }) };
  } catch (err) {
    if (!isNetError(err)) throw err;
    enqueue(payload, op_id);
    return { queued: true, op_id };
  }
}

let flushing = false;
export async function flush() {
  const res = { sent: 0, failed: 0, left: 0 };
  if (flushing || isDemo) { res.left = load().length; return res; }
  flushing = true;
  try {
    for (const r of load()) {
      if (r.error) { res.failed++; continue; }   // чекає рішення людини («Повторити» / «Видалити»)
      try {
        await api.postOperation({ ...r.payload, op_id: r.op_id });
        save(load().filter((x) => x.op_id !== r.op_id));
        res.sent++;
      } catch (err) {
        if (isNetError(err)) { res.stopped = true; break; }
        const list = load();
        const rec = list.find((x) => x.op_id === r.op_id);
        if (rec) { rec.error = err.message || String(err); save(list); }
        res.failed++;
      }
    }
  } finally {
    flushing = false;
  }
  res.left = load().length;
  if (res.sent) document.dispatchEvent(new Event(OUTBOX_EVENT));
  return res;
}

export function remove(op_id) { save(load().filter((x) => x.op_id !== op_id)); }

export async function retry(op_id) {
  const list = load();
  const rec = list.find((x) => x.op_id === op_id);
  if (rec) { rec.error = null; save(list); }
  return await flush();
}

let autoStarted = false;
export function startAutoFlush() {
  if (autoStarted || isDemo) return;
  autoStarted = true;
  addEventListener('online', () => { flush().catch(() => {}); });
  if (navigator.onLine && load().length) flush().catch(() => {});
}

export function outboxBannerText() {
  const n = load().length;
  return n ? `${n} ${plural(n, 'операція чекає', 'операції чекають', 'операцій чекають')} на відправку` : '';
}

// ------------------------------------------------------------------
// Екран «Черга відправки»
// ------------------------------------------------------------------
export function viewOutbox(ctx) {
  ctx.header({ title: 'Черга відправки', back: '#/more' });
  ctx.main.innerHTML = '<div id="ob-status"></div><div id="ob-list"></div>';
  const statusEl = ctx.main.querySelector('#ob-status');
  const listEl = ctx.main.querySelector('#ob-list');

  const card = (r) => {
    const t = OP_TYPES[r.payload.type] || { label: r.payload.type, cls: '' };
    const kit = r.payload.type === 'kit_out' ? state.kits.find((k) => k.id === r.payload.kit_id) : null;
    const lines = linesOf(r.payload, (id) => state.byId.get(id)?.qty || 0).map((m) => {
      const it = state.byId.get(m.item_id);
      return `<div class="op-line"><span>${esc(it?.name || '(позиція)')}</span>
        <b class="${m.qty > 0 ? 'pos' : 'neg'}">${fmtSigned(m.qty)} ${esc(it?.unit || '')}</b></div>`;
    }).join('');
    return `<div class="op card${r.error ? ' line bad' : ''}" data-id="${esc(r.op_id)}">
      <div class="op-head"><span class="tag ${t.cls}">${t.label}</span>
        <small class="muted">${fmtDate(r.created_at)} · ${esc(userName(state.me))}</small></div>
      ${kit ? `<div><b>${esc(kit.name)}</b> × ${fmtQty(r.payload.kit_qty)}</div>` : ''}
      ${r.payload.counterparty || r.payload.comment ? `<div class="op-note">${esc([r.payload.counterparty, r.payload.comment].filter(Boolean).join(' — '))}</div>` : ''}
      <div class="op-lines">${lines}</div>
      ${r.error ? `<p class="err-text">Сервер відхилив: ${esc(r.error)}</p>` : ''}
      <div class="op-foot">
        ${r.error ? '<button type="button" class="btn ghost sm" data-retry>Повторити</button>' : ''}
        <button type="button" class="btn ghost sm del-btn" data-remove>Видалити</button>
      </div></div>`;
  };

  const render = () => {
    const list = load();
    const errs = list.filter((r) => r.error).length;
    statusEl.innerHTML = list.length ? `<div class="card hint">
        ${navigator.onLine
    ? `Операції, проведені без інтернету. ${errs ? `${errs} сервер відхилив — виправте або видаліть їх. ` : ''}
           <div class="form-actions"><span class="grow"></span><button type="button" class="btn primary sm" id="ob-send">Відправити зараз</button></div>`
    : 'Немає інтернету — відправимо, щойно зʼявиться. Залишки на цьому пристрої вже враховують ці операції.'}
      </div>` : '';
    listEl.innerHTML = list.length ? list.map(card).join('')
      : '<div class="empty-state"><p>Черга порожня.</p><p class="muted">Прихід чи видаток, проведений без інтернету, лягає сюди й відправляється сам, коли зʼявиться мережа.</p></div>';
    statusEl.querySelector('#ob-send')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await flush();
      toast(r.stopped ? 'Немає зʼєднання з сервером' : r.sent ? `Відправлено: ${r.sent}` : r.failed ? 'Є відхилені операції' : 'Нічого відправляти', r.stopped ? 'err' : 'ok');
      render();
    });
  };
  render();

  listEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.op');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('[data-remove]')) {
      if (!await confirmDialog('Видалити операцію з черги? На сервер вона не потрапить.', { ok: 'Видалити', danger: true })) return;
      remove(id);
      toast('Видалено з черги');
    } else if (e.target.closest('[data-retry]')) {
      const r = await retry(id);
      if (r.stopped) toast('Немає зʼєднання з сервером', 'err');
      else if (r.sent) toast('Відправлено');
    }
  });

  const onChange = () => { if (ctx.alive()) render(); else stop(); };
  const stop = () => {
    document.removeEventListener(OUTBOX_EVENT, onChange);
    removeEventListener('online', onChange);
    removeEventListener('offline', onChange);
  };
  document.addEventListener(OUTBOX_EVENT, onChange);
  addEventListener('online', onChange);
  addEventListener('offline', onChange);
}
