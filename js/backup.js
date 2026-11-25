// Резервні копії: JSON усіх таблиць + Excel для людей.
//   runCloudBackup  — у приватне сховище Supabase «backups» (лише адміністратор,
//                     раз на добу при вході; старші 30 днів прибираються)
//   downloadBackup  — ті самі файли на цей компʼютер
//   viewBackups     — екран «Ще → Резервні копії»
import { api, isDemo } from './api.js';
import { esc, fmtDate, fmtQty, toast, confirmDialog, OP_TYPES, ORDER_STATUS } from './util.js';
import { state, can } from './core.js';

const FRESH_HOURS = 20;   // копія молодша за це — нову не робимо
const KEEP_DAYS = 30;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 2026-11-25_0830 — місцевий час, щоб назва файлу збігалася з тим, що бачить людина
function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
// дата з назви sklad_2026-11-25_0830.json; null — чужий файл, його не чіпаємо
function stampDate(name) {
  const m = /^sklad_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\./.exec(name);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

// ------------------------------------------------------------------
// Знімок даних. У хмарі — admin_dump (усе, разом із кошиком і скасованими);
// у демо — те, що є в state (операції там не завантажені повністю).
// ------------------------------------------------------------------
async function dumpTables() {
  if (!isDemo) return await api.dump();
  const items = [...state.byId.values()];
  return {
    items,
    kits: state.kits.map(({ components, ...k }) => k),
    kit_components: state.kits.flatMap((k) => k.components.map((c) => ({ kit_id: k.id, item_id: c.item_id, qty: c.qty }))),
    operations: await api.allOperations().catch(() => []),
    movements: [],
    departments: state.departments,
    orders: [...state.orders, ...state.trashOrders].map(({ tasks, parts, units, ...o }) => o),
    order_tasks: state.orders.flatMap((o) => o.tasks),
    order_parts: state.orders.flatMap((o) => o.parts.map((p) => ({ order_id: o.id, ...p }))),
    order_events: [],
    order_units: state.orders.flatMap((o) => o.units || []),
    roles: state.roles,
    profiles: Object.entries(state.profiles).map(([id, display_name]) => ({ id, display_name, department_id: state.depOf[id] || null })),
    settings: state.settings || null,
  };
}

// ------------------------------------------------------------------
// Excel: назви беремо з таблиць знімка, не зі state — копія самодостатня
// ------------------------------------------------------------------
function xlsxFromDump(t) {
  const byId = (rows) => Object.fromEntries((rows || []).map((r) => [r.id, r]));
  const items = byId(t.items);
  const who = Object.fromEntries((t.profiles || []).map((p) => [p.id, p.display_name || p.email || '']));
  const deps = Object.fromEntries((t.departments || []).map((d) => [d.id, d.name]));
  const orders = byId(t.orders);
  const kits = byId(t.kits);
  const name = (id) => items[id]?.name || '';
  const num = (v) => (v === null || v === undefined || v === '' ? '' : Number(v));

  const stock = [['Назва', 'Код', 'Категорія', 'Місце', 'Од.', 'Залишок', 'Резерв', 'Мінімум', 'Примітка', 'Архів', 'У кошику']];
  // залишок рахуємо з руху, бо в знімку таблиця items без qty
  const qty = {};
  const live = new Set((t.operations || []).filter((o) => !o.cancelled_at).map((o) => o.id));
  for (const m of t.movements || []) if (live.has(m.operation_id)) qty[m.item_id] = (qty[m.item_id] || 0) + Number(m.qty);
  for (const i of (t.items || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'uk'))) {
    const fromState = isDemo ? state.byId.get(i.id) : null;
    stock.push([i.name, i.code || '', i.category || '', i.location || '', i.unit || '',
      fromState ? fromState.qty : Math.round((qty[i.id] || 0) * 1e6) / 1e6,
      num(fromState?.reserved ?? i.reserved), num(i.min_qty) || '', i.note || '',
      i.archived ? 'так' : '', i.deleted_at ? fmtDate(i.deleted_at) : '']);
  }

  const journal = [['Дата', 'Тип', 'Позиція', 'Код', 'Кількість', 'Од.', 'Контрагент', 'Коментар', 'Замовлення №', 'Хто', 'Скасовано']];
  const ops = (t.operations || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const movesByOp = {};
  for (const m of t.movements || []) (movesByOp[m.operation_id] ||= []).push(m);
  for (const op of ops) {
    const moves = movesByOp[op.id] || (op.movements || []);
    const base = [fmtDate(op.created_at), OP_TYPES[op.type]?.label || op.type];
    const tail = [op.counterparty || '', op.comment || '', op.order_id && orders[op.order_id] ? orders[op.order_id].number : '',
      who[op.created_by] || '', op.cancelled_at ? fmtDate(op.cancelled_at) : ''];
    if (!moves.length) journal.push([...base, op.type === 'kit_out' ? `${kits[op.kit_id]?.name || 'комплект'} × ${fmtQty(op.kit_qty)}` : '', '', '', '', ...tail]);
    for (const m of moves) journal.push([...base, name(m.item_id), items[m.item_id]?.code || '', num(m.qty), items[m.item_id]?.unit || '', ...tail]);
  }

  const ordersRows = [['№', 'Прийнято', 'Що замовили', 'К-сть', 'Замовник', 'Термін', 'Статус', 'Відділ', 'Опис', 'Прийняв', 'У кошику']];
  for (const o of (t.orders || []).slice().sort((a, b) => a.number - b.number)) {
    ordersRows.push([o.number, fmtDate(o.created_at), o.title, num(o.qty), o.customer || '',
      o.due_date ? fmtDate(`${o.due_date}T00:00:00`, false) : '', ORDER_STATUS[o.status]?.label || o.status,
      deps[o.department_id] || '', o.description || '', who[o.created_by] || '', o.deleted_at ? fmtDate(o.deleted_at) : '']);
  }

  const units = [['№ замовлення', 'Виріб', 'Серійний номер', 'Зібрано', 'Хто зібрав', 'Коли', 'Протестовано', 'Хто тестував', 'Коли', 'Примітка']];
  for (const u of (t.order_units || []).slice().sort((a, b) => (orders[a.order_id]?.number || 0) - (orders[b.order_id]?.number || 0) || a.position - b.position)) {
    units.push([orders[u.order_id]?.number || '', orders[u.order_id]?.title || '', u.serial,
      u.assembled ? 'так' : '', who[u.assembled_by] || '', u.assembled_at ? fmtDate(u.assembled_at) : '',
      u.tested ? 'так' : '', who[u.tested_by] || '', u.tested_at ? fmtDate(u.tested_at) : '', u.note || '']);
  }

  const kitRows = [['Комплект', 'Компонент', 'Код', 'К-сть на 1', 'Од.']];
  for (const c of (t.kit_components || []).slice().sort((a, b) => (kits[a.kit_id]?.name || '').localeCompare(kits[b.kit_id]?.name || '', 'uk'))) {
    kitRows.push([kits[c.kit_id]?.name || '', name(c.item_id), items[c.item_id]?.code || '', num(c.qty), items[c.item_id]?.unit || '']);
  }

  const wb = window.XLSX.utils.book_new();
  for (const [title, rows, widths] of [
    ['Залишки', stock, [36, 16, 16, 16, 7, 10, 9, 9, 30, 7, 17]],
    ['Журнал', journal, [17, 16, 34, 16, 10, 7, 22, 30, 12, 14, 17]],
    ['Замовлення', ordersRows, [6, 17, 34, 7, 22, 11, 17, 18, 50, 14, 17]],
    ['Вироби', units, [12, 30, 16, 9, 16, 17, 12, 16, 17, 30]],
    ['Комплекти', kitRows, [30, 34, 16, 10, 7]],
  ]) {
    const ws = window.XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    window.XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
  }
  return new Blob([window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: XLSX_MIME });
}

export async function buildBackupFiles() {
  const tables = await dumpTables();
  const now = new Date();
  const json = new Blob([JSON.stringify({ app: 'sklad', version: window.APP_VERSION || '', created_at: now.toISOString(), tables }, null, 1)],
    { type: 'application/json' });
  return { json, xlsx: xlsxFromDump(tables), stamp: stamp(now) };
}

// ------------------------------------------------------------------
export async function runCloudBackup({ force = false } = {}) {
  if (isDemo) return { skipped: true, reason: 'demo' };
  if (!navigator.onLine) return { skipped: true, reason: 'offline' };
  if (!can('admin')) return { skipped: true, reason: 'not-admin' };
  const s = await api.settings();
  if (!force && s.backup_at && Date.now() - Date.parse(s.backup_at) < FRESH_HOURS * 3600e3) return { skipped: true, reason: 'fresh' };
  const { json, xlsx, stamp: st } = await buildBackupFiles();
  await api.uploadBackup(`sklad_${st}.json`, json, 'application/json');
  await api.uploadBackup(`sklad_${st}.xlsx`, xlsx, XLSX_MIME);
  await api.saveSettings({ backup_at: new Date().toISOString() });
  // старі копії — геть; файли з незнайомою назвою не чіпаємо
  let removed = 0;
  try {
    const cut = Date.now() - KEEP_DAYS * 864e5;
    const old = (await api.backups()).filter((f) => { const d = stampDate(f.name); return d && d.getTime() < cut; }).map((f) => f.name);
    await api.deleteBackups(old);
    removed = old.length;
  } catch { /* не вийшло прибрати — наступного разу */ }
  return { ok: true, stamp: st, removed };
}

function saveAs(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export async function downloadBackup() {
  const { json, xlsx, stamp: st } = await buildBackupFiles();
  saveAs(json, `sklad_${st}.json`);
  // два завантаження підряд — браузер може проковтнути друге без паузи
  await new Promise((r) => setTimeout(r, 300));
  saveAs(xlsx, `sklad_${st}.xlsx`);
}

// ------------------------------------------------------------------
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

export async function viewBackups(ctx) {
  ctx.header({ title: 'Резервні копії', back: '#/more' });
  if (isDemo) {
    ctx.main.innerHTML = `
      <div class="card hint">У демо-режимі дані живуть лише в цьому браузері, хмарних копій немає.
        Можна завантажити копію на компʼютер: JSON з усіма таблицями і Excel із залишками, журналом, замовленнями, виробами й комплектами.</div>
      <div class="card"><div class="form-actions"><button class="btn primary" id="dl">Завантажити на цей компʼютер</button></div></div>`;
    ctx.main.querySelector('#dl').addEventListener('click', () => downloadBackup().catch((e) => toast(e.message, 'err')));
    return;
  }
  ctx.main.innerHTML = `
    <div class="card hint">Копія робиться сама раз на добу, коли адміністратор відкриває програму: JSON з усіма таблицями
      і Excel для людей. Зберігається ${KEEP_DAYS} днів у сховищі Supabase — у <b>тому ж проєкті</b>, що й база,
      тож раз на місяць варто завантажувати копію на свій диск.
      Відновлення: позиції й залишки — через «Імпорт з Excel»; усе інше — з JSON вручну, адміністратором бази. Автоматичного відновлення немає.</div>
    <div class="card">
      <div id="last" class="muted">Завантаження…</div>
      <div class="form-actions">
        <button class="btn primary" id="now">Зробити копію зараз</button>
        <button class="btn ghost" id="dl">Завантажити на цей компʼютер</button>
      </div>
    </div>
    <h3>Копії в хмарі</h3>
    <div id="list" class="list"><div class="muted pad">Завантаження…</div></div>`;

  const render = async () => {
    try {
      const [s, files] = await Promise.all([api.settings(), api.backups()]);
      if (!ctx.alive()) return;
      ctx.main.querySelector('#last').textContent = s.backup_at ? `Остання копія: ${fmtDate(s.backup_at)}` : 'Копій ще не було';
      ctx.main.querySelector('#list').innerHTML = files.length ? files.map((f) => `
        <div class="row" data-name="${esc(f.name)}">
          <div class="row-main"><div class="row-title">${esc(f.name)}</div>
            <div class="row-meta">${fmtSize(f.size)}${f.created_at ? ` · ${fmtDate(f.created_at)}` : ''}</div></div>
          <button type="button" class="btn ghost sm" data-get>Завантажити</button>
          <button type="button" class="btn ghost sm del-btn" data-del>Видалити</button>
        </div>`).join('') : '<div class="empty-state"><p>Копій у хмарі ще немає</p></div>';
    } catch (e) { if (ctx.alive()) toast(e.message, 'err'); }
  };
  await render();

  const busy = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'err', 8000); } finally { btn.disabled = false; }
  };
  ctx.main.querySelector('#now').addEventListener('click', (e) => busy(e.target, async () => {
    const r = await runCloudBackup({ force: true });
    if (r.skipped) return toast(r.reason === 'offline' ? 'Немає інтернету' : 'Копію може робити лише адміністратор', 'err');
    toast(`Копію збережено: sklad_${r.stamp}${r.removed ? ` · прибрано старих: ${r.removed}` : ''}`);
    await render();
  }));
  ctx.main.querySelector('#dl').addEventListener('click', (e) => busy(e.target, downloadBackup));
  ctx.main.querySelector('#list').addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    const btn = e.target.closest('[data-get], [data-del]');
    if (!row || !btn) return;
    const name = row.dataset.name;
    if ('get' in btn.dataset) {
      await busy(btn, async () => {
        const a = document.createElement('a');
        a.href = await api.backupUrl(name);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    } else {
      if (!await confirmDialog(`Видалити копію ${name}?`, { ok: 'Видалити', danger: true })) return;
      await busy(btn, async () => { await api.deleteBackups([name]); toast('Копію видалено'); await render(); });
    }
  });
}
