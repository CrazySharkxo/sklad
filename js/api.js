// Шар даних. Два бекенди з однаковим інтерфейсом:
//   SupaApi  — спільна хмарна база (Supabase), коли заповнено js/config.js
//   LocalApi — демо-режим: усе лише в цьому браузері
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { round, blobToDataUrl } from './util.js';

export const isDemo = !SUPABASE_URL || !SUPABASE_ANON_KEY;

// скільки днів видалене лежить у кошику (так само в supabase/schema.sql → purge_trash)
export const TRASH_DAYS = 30;
const trashCutoff = () => new Date(Date.now() - TRASH_DAYS * 864e5).toISOString();

const ITEM_FIELDS = ['name', 'code', 'category', 'unit', 'location', 'min_qty', 'note', 'photo_path', 'archived'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

function cleanItem(item) {
  const r = pick(item, ITEM_FIELDS);
  for (const k of ['name', 'category', 'unit', 'location', 'note']) if (k in r) r[k] = String(r[k] ?? '').trim();
  if ('code' in r) r.code = String(r.code ?? '').trim() || null;
  if ('unit' in r && !r.unit) r.unit = 'шт';
  if ('min_qty' in r) r.min_qty = Number(r.min_qty) || 0;
  return r;
}

const ORDER_FIELDS = ['title', 'customer', 'qty', 'due_date', 'description'];

function cleanOrder(o) {
  const r = pick(o, ORDER_FIELDS);
  for (const k of ['title', 'customer', 'description']) if (k in r) r[k] = String(r[k] ?? '').trim();
  if ('qty' in r) r.qty = Number(r.qty) || 1;
  if ('due_date' in r) r.due_date = r.due_date || null;
  return r;
}

function normOrder(o) {
  return {
    ...o,
    qty: Number(o.qty),
    tasks: (o.order_tasks || o.tasks || []).slice().sort((a, b) => a.position - b.position),
    parts: (o.order_parts || o.parts || []).map((p) => ({ item_id: p.item_id, qty: Number(p.qty) })),
    units: (o.order_units || o.units || []).slice().sort((a, b) => a.position - b.position || a.serial.localeCompare(b.serial)),
    order_tasks: undefined,
    order_parts: undefined,
    order_units: undefined,
  };
}

// серійний номер виробу за замовчуванням: 0012-03 (№ замовлення — порядковий)
export const defaultSerial = (orderNumber, n) => `${String(orderNumber).padStart(4, '0')}-${String(n).padStart(2, '0')}`;

const UNIT_FIELDS = ['position', 'serial', 'assembled', 'tested', 'note'];

// скільки кожної позиції вже видано під замовлення (без скасованих операцій)
function issuedMap(ops) {
  const out = {};
  for (const o of ops) {
    if (o.cancelled_at || o.type !== 'out') continue;
    for (const m of o.movements || []) out[m.item_id] = round((out[m.item_id] || 0) - Number(m.qty));
  }
  return out;
}

function friendly(error) {
  const msg = error?.message || String(error);
  if (error?.code === '23505' && /departments/.test(msg)) return new Error('Такий відділ уже є');
  if (error?.code === '23505' && /roles/.test(msg)) return new Error('Така роль уже є');
  if (error?.code === '42501' || /row-level security/i.test(msg)) return new Error('Немає права на цю дію — зверніться до адміністратора');
  if (error?.code === '23505' && /order_units/.test(msg)) return new Error('Такий серійний номер уже є в іншому виробі');
  if (error?.code === '23505') return new Error('Такий код уже є в іншої позиції');
  if (error?.code === '23503' && /departments|department_id/.test(msg)) return new Error('У відділі є замовлення — його можна лише перейменувати');
  if (error?.code === '23503') return new Error('Позиція має історію руху або є в комплекті чи замовленні — її можна лише архівувати');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return new Error('Немає зʼєднання з сервером');
  if (/JWT expired|invalid JWT/i.test(msg)) return new Error('Сесія застаріла — увійдіть знову');
  return new Error(msg);
}

// =====================================================================
//  Supabase
// =====================================================================
class SupaApi {
  constructor() {
    this.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    this.urlCache = new Map();
  }

  async q(promise) {
    const { data, error } = await promise;
    if (error) throw friendly(error);
    return data;
  }

  // Supabase віддає максимум 1000 рядків за запит — добираємо сторінками
  async all(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const page = await this.q(build().range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  // ---------- вхід ----------
  async userId() {
    const { data } = await this.sb.auth.getSession();
    return data.session?.user?.id || null;
  }
  async email() {
    const { data } = await this.sb.auth.getSession();
    return data.session?.user?.email || '';
  }
  onAuth(cb) { this.sb.auth.onAuthStateChange((_e, s) => cb(s?.user?.id || null)); }
  async signIn(email, password) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (/Invalid login/i.test(error.message)) throw new Error('Невірний email або пароль');
      throw friendly(error);
    }
  }
  async signOut() { await this.sb.auth.signOut(); }
  async changePassword(pw) {
    const { error } = await this.sb.auth.updateUser({ password: pw });
    if (error) throw friendly(error);
  }

  // [{id, display_name, department_id}]
  async profiles() {
    return await this.q(this.sb.from('profiles').select('id, display_name, department_id'));
  }
  async setMyName(name) {
    const id = await this.userId();
    await this.q(this.sb.from('profiles').update({ display_name: name }).eq('id', id));
  }
  async setMyDepartment(depId) { await this.q(this.sb.rpc('set_my_department', { p_dep: depId || null })); }

  // ---------- права, ролі, користувачі ----------
  async myPerms() { return (await this.q(this.sb.rpc('my_perms'))) || []; }
  async roles() { return await this.q(this.sb.from('roles').select('id, name, perms').order('name')); }
  async saveRole({ id, name, perms }) {
    const row = { name: String(name || '').trim(), perms };
    if (id) { await this.q(this.sb.from('roles').update(row).eq('id', id)); return id; }
    return (await this.q(this.sb.from('roles').insert(row).select('id').single())).id;
  }
  async deleteRole(id) { await this.q(this.sb.from('roles').delete().eq('id', id)); }
  async users() { return await this.q(this.sb.rpc('admin_users')); }
  async createUser({ email, password, name, role_id, department_id }) {
    return await this.q(this.sb.rpc('admin_create_user', {
      p_email: email, p_password: password, p_name: name || '', p_role: role_id || null, p_department: department_id || null,
    }));
  }
  // perms: null — як у ролі, масив — свої галочки
  async updateUser({ id, name, role_id, department_id, perms, active }) {
    await this.q(this.sb.rpc('admin_update_user', {
      p_user: id, p_name: name || '', p_role: role_id || null, p_department: department_id || null, p_perms: perms, p_active: active,
    }));
  }
  async setUserPassword(id, password) { await this.q(this.sb.rpc('admin_set_password', { p_user: id, p_password: password })); }
  async deleteUser(id) { await this.q(this.sb.rpc('admin_delete_user', { p_user: id })); }

  // ---------- відділи ----------
  async departments() {
    return await this.q(this.sb.from('departments').select('id, name, tg_chat').order('name'));
  }
  // tg_chat — необовʼязково: свій Telegram-чат відділу
  async saveDepartment({ id, name, tg_chat }) {
    const row = { name: String(name || '').trim() };
    if (tg_chat !== undefined) row.tg_chat = String(tg_chat || '').trim();
    if (id) { await this.q(this.sb.from('departments').update(row).eq('id', id)); return id; }
    return (await this.q(this.sb.from('departments').insert(row).select('id').single())).id;
  }
  async deleteDepartment(id) { await this.q(this.sb.from('departments').delete().eq('id', id)); }

  // ---------- налаштування, сповіщення ----------
  // несекретна частина — для всіх (шапка документів)
  async settings() {
    const rows = await this.q(this.sb.from('app_settings').select('org_name, app_url, backup_at').eq('id', 1));
    return rows?.[0] || { org_name: '', app_url: '', backup_at: null };
  }
  async adminSettings() { return await this.q(this.sb.rpc('admin_settings')); }
  async saveSettings(patch) { await this.q(this.sb.rpc('admin_save_settings', { p: patch })); }
  async tgTest() { return await this.q(this.sb.rpc('tg_test')); }
  async tgResult(id) { return await this.q(this.sb.rpc('tg_result', { p_id: id })); }
  async notifyOverdue() { return await this.q(this.sb.rpc('notify_overdue')); }

  // ---------- резервні копії (лише адміністратор) ----------
  async dump() { return await this.q(this.sb.rpc('admin_dump')); }
  async backups() {
    const rows = await this.q(this.sb.storage.from('backups').list('', { limit: 1000, sortBy: { column: 'name', order: 'desc' } }));
    return (rows || []).filter((r) => r.name && !r.name.startsWith('.')).map((r) => ({ name: r.name, size: r.metadata?.size || 0, created_at: r.created_at }));
  }
  async uploadBackup(name, blob, contentType) {
    await this.q(this.sb.storage.from('backups').upload(name, blob, { contentType, upsert: true }));
  }
  async backupUrl(name) {
    const { data, error } = await this.sb.storage.from('backups').createSignedUrl(name, 120, { download: true });
    if (error) throw friendly(error);
    return data.signedUrl;
  }
  async deleteBackups(names) { if (names.length) await this.q(this.sb.storage.from('backups').remove(names)); }

  // ---------- замовлення ----------
  async orders() {
    const rows = await this.all(() => this.sb.from('orders')
      .select('*, order_tasks(id, position, text, done, done_by, done_at), order_parts(item_id, qty), order_units(*)')
      .order('number', { ascending: false }));
    return rows.map(normOrder);
  }
  // вироби: додати кілька (rows: [{position, serial}]), змінити один, прибрати
  async addUnits(orderId, rows) {
    await this.q(this.sb.from('order_units').insert(rows.map((u) => ({ order_id: orderId, ...pick(u, UNIT_FIELDS), serial: String(u.serial).trim() }))));
  }
  async updateUnit(id, patch) {
    const row = pick(patch, UNIT_FIELDS);
    if ('serial' in row) row.serial = String(row.serial).trim();
    await this.q(this.sb.from('order_units').update(row).eq('id', id));
  }
  async deleteUnit(id) { await this.q(this.sb.from('order_units').delete().eq('id', id)); }
  // tasks: [{id?, text}] у потрібному порядку; parts: [{item_id, qty}]
  async saveOrder(order, tasks, parts) {
    const row = cleanOrder(order);
    let id = order.id;
    if (id) await this.q(this.sb.from('orders').update(row).eq('id', id));
    else {
      row.department_id = order.department_id || null;
      id = (await this.q(this.sb.from('orders').insert(row).select('id').single())).id;
    }
    // чекліст: зберігаємо відмітки в пунктах, що лишилися
    const keep = tasks.map((t, n) => ({ id: t.id || crypto.randomUUID(), order_id: id, position: n, text: t.text.trim() }));
    let del = this.sb.from('order_tasks').delete().eq('order_id', id);
    if (keep.length) del = del.not('id', 'in', `(${keep.map((t) => t.id).join(',')})`);
    await this.q(del);
    if (keep.length) await this.q(this.sb.from('order_tasks').upsert(keep));
    await this.q(this.sb.from('order_parts').delete().eq('order_id', id));
    if (parts.length) await this.q(this.sb.from('order_parts').insert(parts.map((p) => ({ order_id: id, item_id: p.item_id, qty: p.qty }))));
    return id;
  }
  async moveOrder(id, status, departmentId, comment = '') {
    await this.q(this.sb.rpc('move_order', { p_id: id, p_status: status, p_department: departmentId || null, p_comment: comment }));
  }
  async deleteOrder(id) { await this.q(this.sb.rpc('delete_order', { p_id: id })); }
  async restoreOrder(id) { await this.q(this.sb.rpc('restore_order', { p_id: id })); }
  async purgeOrder(id) { await this.q(this.sb.rpc('purge_order', { p_id: id })); }
  async addTask(orderId, text, position) {
    await this.q(this.sb.from('order_tasks').insert({ order_id: orderId, text: text.trim(), position }));
  }
  async setTaskDone(taskId, done) {
    await this.q(this.sb.from('order_tasks').update({ done }).eq('id', taskId));
  }
  async orderEvents(orderId) {
    return await this.q(this.sb.from('order_events').select('*').eq('order_id', orderId).order('id'));
  }
  async addOrderComment(orderId, text) {
    await this.q(this.sb.from('order_events').insert({ order_id: orderId, kind: 'comment', text: text.trim() }));
  }
  async orderIssued(orderId) {
    const ops = await this.q(this.sb.from('operations').select('type, cancelled_at, movements(item_id, qty)').eq('order_id', orderId));
    return issuedMap(ops);
  }

  // ---------- позиції ----------
  async items() {
    const rows = await this.all(() => this.sb.from('stock').select('*').order('name'));
    for (const r of rows) { r.qty = Number(r.qty); r.min_qty = Number(r.min_qty); r.reserved = Number(r.reserved) || 0; }
    return rows;
  }
  async saveItem(item) {
    const row = cleanItem(item);
    if (item.id) {
      await this.q(this.sb.from('items').update(row).eq('id', item.id));
      return item.id;
    }
    const data = await this.q(this.sb.from('items').insert(row).select('id').single());
    return data.id;
  }
  async trashItem(id) { await this.q(this.sb.rpc('trash_item', { p_id: id })); }
  async restoreItem(id) { await this.q(this.sb.rpc('restore_item', { p_id: id })); }
  async purgeItem(id) {
    const photo = await this.q(this.sb.rpc('purge_item', { p_id: id }));
    if (photo) await this.removePhoto(photo);
  }
  // прибрати з кошика все старше TRASH_DAYS (разом із фото видалених позицій)
  async purgeTrash() {
    const photos = await this.q(this.sb.rpc('purge_trash'));
    for (const ph of photos || []) await this.removePhoto(ph);
  }

  // ---------- фото ----------
  async uploadPhoto(blob) {
    const path = `${crypto.randomUUID()}.jpg`;
    await this.q(this.sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
    return path;
  }
  async removePhoto(path) {
    if (path) await this.sb.storage.from('photos').remove([path]).catch(() => {});
  }
  async photoUrls(paths) {
    const now = Date.now();
    const need = [...new Set(paths)].filter((p) => p && !(this.urlCache.get(p)?.exp > now));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const { data } = await this.sb.storage.from('photos').createSignedUrls(chunk, 6 * 3600);
      for (const r of data || []) if (r.signedUrl) this.urlCache.set(r.path, { url: r.signedUrl, exp: now + 5 * 3600e3 });
    }
    return Object.fromEntries(paths.filter((p) => this.urlCache.has(p)).map((p) => [p, this.urlCache.get(p).url]));
  }

  // ---------- комплекти ----------
  async kits() {
    const rows = await this.all(() => this.sb.from('kits').select('*, kit_components(item_id, qty)').order('name'));
    return rows.map((k) => ({ ...k, components: (k.kit_components || []).map((c) => ({ item_id: c.item_id, qty: Number(c.qty) })) }));
  }
  async saveKit(kit, components) {
    const row = { name: kit.name.trim(), note: (kit.note || '').trim(), photo_path: kit.photo_path || null, archived: !!kit.archived };
    let id = kit.id;
    if (id) await this.q(this.sb.from('kits').update(row).eq('id', id));
    else id = (await this.q(this.sb.from('kits').insert(row).select('id').single())).id;
    await this.q(this.sb.from('kit_components').delete().eq('kit_id', id));
    if (components.length) {
      await this.q(this.sb.from('kit_components').insert(components.map((c) => ({ kit_id: id, item_id: c.item_id, qty: c.qty }))));
    }
    return id;
  }
  async deleteKit(id) { await this.q(this.sb.from('kits').delete().eq('id', id)); }

  // ---------- операції ----------
  // op_id — id від клієнта (офлайн-черга): повтор тієї ж операції не створює дубля
  async postOperation({ type, lines = [], comment = '', counterparty = '', kit_id = null, kit_qty = null, order_id = null, op_id = null }) {
    return await this.q(this.sb.rpc('post_operation', {
      p_type: type, p_lines: lines, p_comment: comment, p_counterparty: counterparty,
      p_kit_id: kit_id, p_kit_qty: kit_qty, p_order_id: order_id, p_op_id: op_id,
    }));
  }
  // «видалити» операцію = покласти в кошик (cancelled_at): залишки рахуються без неї
  async cancelOperation(id) { await this.q(this.sb.rpc('cancel_operation', { p_id: id })); }
  async restoreOperation(id) { await this.q(this.sb.rpc('restore_operation', { p_id: id })); }
  async purgeOperation(id) { await this.q(this.sb.rpc('purge_operation', { p_id: id })); }
  async trashOperations() {
    return normOps(await this.all(() => this.sb.from('operations').select('*, movements(item_id, qty)')
      .not('cancelled_at', 'is', null).gte('cancelled_at', trashCutoff()).order('cancelled_at', { ascending: false })));
  }

  opQuery({ type, from, to } = {}) {
    let q = this.sb.from('operations').select('*, movements(item_id, qty)').is('cancelled_at', null)
      .order('created_at', { ascending: false });
    if (type) q = q.eq('type', type);
    if (from) q = q.gte('created_at', new Date(from + 'T00:00:00').toISOString());
    if (to) q = q.lt('created_at', new Date(new Date(to + 'T00:00:00').getTime() + 864e5).toISOString());
    return q;
  }
  async operations({ type, from, to, before, limit = 50 } = {}) {
    let q = this.opQuery({ type, from, to });
    if (before) q = q.lt('created_at', before);
    return normOps(await this.q(q.limit(limit)));
  }
  async allOperations(filter) { return normOps(await this.all(() => this.opQuery(filter))); }

  async itemHistory(itemId) {
    const rows = await this.q(this.sb.from('movements')
      .select('qty, operation:operations(*)').eq('item_id', itemId).order('id', { ascending: false }).limit(300));
    return rows.map((r) => ({ qty: Number(r.qty), op: r.operation }));
  }

  subscribe(cb) {
    // підписка покриває всі таблиці з публікації supabase_realtime (див. schema.sql)
    this.sb.channel('sklad-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => cb())
      .subscribe();
  }
}

function normOps(ops) {
  for (const o of ops) o.movements = (o.movements || []).map((m) => ({ item_id: m.item_id, qty: Number(m.qty) }));
  return ops;
}

// =====================================================================
//  Демо: localStorage, та сама логіка, що й у supabase/schema.sql
// =====================================================================
const KEY = 'sklad-demo-v1';
// ті самі стартові ролі, що й у supabase/schema.sql
const DEMO_ROLES = [
  ['Адміністратор', ['admin']],
  ['Комірник', ['stock.view', 'stock.edit', 'stock.delete', 'ops.view', 'ops.edit', 'ops.delete', 'kits.view', 'kits.edit', 'kits.delete', 'orders.view', 'orders.all']],
  ['Виробництво', ['stock.view', 'ops.view', 'ops.edit', 'kits.view', 'orders.view', 'orders.edit']],
  ['Лише перегляд', ['stock.view', 'ops.view', 'kits.view', 'orders.view', 'orders.all']],
];
const DEMO_USER = '00000000-0000-0000-0000-00000000demo';

class LocalApi {
  constructor() {
    this.listeners = [];
    window.addEventListener('storage', (e) => { if (e.key === KEY) this.listeners.forEach((f) => f()); });
  }
  load() {
    let d = null;
    try {
      d = JSON.parse(localStorage.getItem(KEY));
    } catch { /* порожньо */ }
    if (!d || !d.items) d = { items: [], kits: [], kit_components: [], operations: [], movements: [], profiles: { [DEMO_USER]: 'Демо' } };
    // демо-дані, збережені до появи замовлень, доповнюємо — і одразу зберігаємо,
    // інакше кожне читання давало б відділам нові id
    if (!d.roles) {
      d.roles = DEMO_ROLES.map(([name, perms]) => ({ id: crypto.randomUUID(), name, perms }));
      d.users = { [DEMO_USER]: { email: 'demo@example.com', role_id: d.roles[0].id, perms: null, active: true, created_at: new Date().toISOString() } };
      try { this.save(d); } catch { /* */ }
    }
    if (!d.departments) {
      d.departments = ['Прийом замовлень', 'Виробництво', 'Тестування']
        .map((name) => ({ id: crypto.randomUUID(), name, created_at: new Date().toISOString() }));
      for (const k of ['orders', 'order_tasks', 'order_parts', 'order_events']) d[k] = d[k] || [];
      d.profileDeps = d.profileDeps || {};
      try { this.save(d); } catch { /* переповнене сховище — побачимо при наступному записі */ }
    }
    if (!d.order_units) {
      d.order_units = [];
      d.settings = { org_name: '', app_url: '', tg_chat: '', tg_orders: true, tg_low: true, tg_overdue: true, backup_at: null };
      try { this.save(d); } catch { /* */ }
    }
    return d;
  }
  // резерв: деталі активних замовлень мінус уже видане під них
  reservedOf(d, itemId) {
    const live = new Set(d.operations.filter((o) => !o.cancelled_at && o.type === 'out' && o.order_id).map((o) => o.id));
    const opOrder = Object.fromEntries(d.operations.map((o) => [o.id, o.order_id]));
    let sum = 0;
    for (const o of d.orders) {
      if (o.deleted_at || !['new', 'in_work', 'testing', 'rework', 'done'].includes(o.status)) continue;
      const part = d.order_parts.find((p) => p.order_id === o.id && p.item_id === itemId);
      if (!part) continue;
      const issued = d.movements.filter((m) => m.item_id === itemId && live.has(m.operation_id) && opOrder[m.operation_id] === o.id)
        .reduce((s, m) => s - m.qty, 0);
      sum += Math.max(0, part.qty - issued);
    }
    return round(sum);
  }
  save(d) {
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
    } catch {
      throw new Error('Сховище браузера переповнене — видаліть кілька фото');
    }
  }
  qtyOf(d, itemId) {
    const live = new Set(d.operations.filter((o) => !o.cancelled_at).map((o) => o.id));
    return round(d.movements.filter((m) => m.item_id === itemId && live.has(m.operation_id)).reduce((s, m) => s + m.qty, 0));
  }

  async userId() { return DEMO_USER; }
  async email() { return 'demo'; }
  onAuth() {}
  async signIn() {}
  async signOut() {}
  async changePassword() { throw new Error('У демо-режимі паролів немає'); }
  async profiles() {
    const d = this.load();
    return Object.entries(d.profiles).map(([id, display_name]) => ({ id, display_name, department_id: d.profileDeps[id] || null }));
  }
  async setMyName(name) { const d = this.load(); d.profiles[DEMO_USER] = name; this.save(d); }
  async setMyDepartment(depId) {
    if (!(await this.myPerms()).some((x) => x === 'admin' || x === 'orders.all')) throw new Error('Відділ вам призначає адміністратор');
    const d = this.load(); d.profileDeps[DEMO_USER] = depId || null; this.save(d);
  }

  // ---------- права, ролі, «користувачі» (у демо — лише записи, без входу) ----------
  permsOf(d, id) {
    const u = d.users[id];
    if (!u || !u.active) return [];
    return u.perms || d.roles.find((r) => r.id === u.role_id)?.perms || [];
  }
  assertAdminLeft(d) {
    if (!Object.keys(d.users).some((id) => d.users[id].active && this.permsOf(d, id).includes('admin'))) {
      throw new Error('Має лишитися хоча б один активний адміністратор');
    }
  }
  async myPerms() { return this.permsOf(this.load(), DEMO_USER); }
  async roles() { return this.load().roles.slice().sort((a, b) => a.name.localeCompare(b.name, 'uk')); }
  async saveRole({ id, name, perms }) {
    const d = this.load();
    const n = String(name || '').trim();
    if (!n) throw new Error('Вкажіть назву ролі');
    if (d.roles.some((r) => r.id !== id && r.name.toLowerCase() === n.toLowerCase())) throw new Error('Така роль уже є');
    if (id) Object.assign(d.roles.find((r) => r.id === id), { name: n, perms });
    else { id = crypto.randomUUID(); d.roles.push({ id, name: n, perms }); }
    this.assertAdminLeft(d);
    this.save(d);
    return id;
  }
  async deleteRole(id) {
    const d = this.load();
    d.roles = d.roles.filter((r) => r.id !== id);
    for (const u of Object.values(d.users)) if (u.role_id === id) u.role_id = null;
    this.assertAdminLeft(d);
    this.save(d);
  }
  async users() {
    const d = this.load();
    return Object.entries(d.users).map(([id, u]) => ({
      id, email: u.email, display_name: d.profiles[id] || '', role_id: u.role_id, department_id: d.profileDeps[id] || null,
      perms: u.perms, active: u.active, last_sign_in_at: id === DEMO_USER ? new Date().toISOString() : null, created_at: u.created_at,
    })).sort((a, b) => a.display_name.localeCompare(b.display_name, 'uk'));
  }
  async createUser({ email, password, name, role_id, department_id }) {
    const d = this.load();
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Неправильний email');
    if (String(password || '').length < 6) throw new Error('Пароль — мінімум 6 символів');
    if (Object.values(d.users).some((u) => u.email === e)) throw new Error('Користувач з таким email уже є');
    const id = crypto.randomUUID();
    d.users[id] = { email: e, role_id: role_id || null, perms: null, active: true, created_at: new Date().toISOString() };
    d.profiles[id] = String(name || '').trim() || e.split('@')[0];
    d.profileDeps[id] = department_id || null;
    this.save(d);
    return id;
  }
  async updateUser({ id, name, role_id, department_id, perms, active }) {
    const d = this.load();
    const u = d.users[id];
    if (!u) throw new Error('Користувача не знайдено');
    if (id === DEMO_USER && !active) throw new Error('Не можна заблокувати самого себе');
    Object.assign(u, { role_id: role_id || null, perms, active });
    if (String(name || '').trim()) d.profiles[id] = name.trim();
    d.profileDeps[id] = department_id || null;
    if (id === DEMO_USER && !this.permsOf(d, id).includes('admin')) throw new Error('Не можна забрати права адміністратора в самого себе');
    this.assertAdminLeft(d);
    this.save(d);
  }
  async setUserPassword(id, password) {
    if (String(password || '').length < 6) throw new Error('Пароль — мінімум 6 символів');
  }
  async deleteUser(id) {
    const d = this.load();
    if (id === DEMO_USER) throw new Error('Не можна видалити самого себе');
    delete d.users[id];
    delete d.profiles[id];
    delete d.profileDeps[id];
    this.save(d);
  }

  // ---------- відділи ----------
  async departments() {
    return this.load().departments.map(({ id, name, tg_chat }) => ({ id, name, tg_chat: tg_chat || '' })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }
  async saveDepartment({ id, name, tg_chat }) {
    const d = this.load();
    const n = String(name || '').trim();
    if (!n) throw new Error('Вкажіть назву відділу');
    if (d.departments.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw new Error('Такий відділ уже є');
    if (id) {
      const dep = d.departments.find((x) => x.id === id);
      dep.name = n;
      if (tg_chat !== undefined) dep.tg_chat = String(tg_chat || '').trim();
    } else { id = crypto.randomUUID(); d.departments.push({ id, name: n, tg_chat: String(tg_chat || '').trim(), created_at: new Date().toISOString() }); }
    this.save(d);
    return id;
  }

  // ---------- налаштування (у демо сповіщення не надсилаються) ----------
  async settings() { const s = this.load().settings; return { org_name: s.org_name, app_url: s.app_url, backup_at: s.backup_at }; }
  async adminSettings() {
    const s = this.load().settings;
    return { ...s, tg_token_set: !!s.tg_token, tg_token_hint: s.tg_token ? '…' + s.tg_token.slice(-4) : '', pg_net: false, pg_cron: false, overdue_sent_on: null };
  }
  async saveSettings(patch) {
    const d = this.load();
    for (const k of ['org_name', 'app_url', 'tg_chat', 'tg_token']) if (k in patch) d.settings[k] = String(patch[k] ?? '').trim();
    for (const k of ['tg_orders', 'tg_low', 'tg_overdue']) if (k in patch) d.settings[k] = !!patch[k];
    if ('backup_at' in patch) d.settings.backup_at = patch.backup_at;
    this.save(d);
  }
  async tgTest() { throw new Error('У демо-режимі сповіщення не надсилаються — потрібна спільна база'); }
  async tgResult() { return ''; }
  async notifyOverdue() { return 0; }
  async deleteDepartment(id) {
    const d = this.load();
    if (d.orders.some((o) => o.department_id === id)) throw new Error('У відділі є замовлення — його можна лише перейменувати');
    d.departments = d.departments.filter((x) => x.id !== id);
    for (const k of Object.keys(d.profileDeps)) if (d.profileDeps[k] === id) d.profileDeps[k] = null;
    for (const e of d.order_events) {
      if (e.from_department === id) e.from_department = null;
      if (e.to_department === id) e.to_department = null;
    }
    this.save(d);
  }

  // ---------- замовлення ----------
  async orders() {
    const d = this.load();
    return d.orders.slice().sort((a, b) => b.number - a.number).map((o) => normOrder({
      ...o,
      tasks: d.order_tasks.filter((t) => t.order_id === o.id),
      parts: d.order_parts.filter((p) => p.order_id === o.id),
      units: d.order_units.filter((u) => u.order_id === o.id),
    }));
  }
  // вироби (серійні номери)
  checkSerial(d, serial, exceptId) {
    const s = String(serial || '').trim();
    if (!s) throw new Error('Серійний номер не може бути порожнім');
    if (d.order_units.some((u) => u.id !== exceptId && u.serial.toLowerCase() === s.toLowerCase())) throw new Error('Такий серійний номер уже є в іншому виробі');
    return s;
  }
  stampUnit(u, old = {}) {
    const now = new Date().toISOString();
    for (const k of ['assembled', 'tested']) {
      if (!u[k]) { u[`${k}_by`] = null; u[`${k}_at`] = null; }
      else if (!old[k]) { u[`${k}_by`] = DEMO_USER; u[`${k}_at`] = now; }
      else { u[`${k}_by`] = old[`${k}_by`]; u[`${k}_at`] = old[`${k}_at`]; }
    }
  }
  async addUnits(orderId, rows) {
    const d = this.load();
    if (!d.orders.some((o) => o.id === orderId && !o.deleted_at)) throw new Error('Замовлення не знайдено');
    for (const r of rows) {
      const u = { id: crypto.randomUUID(), order_id: orderId, position: r.position || 0, serial: this.checkSerial(d, r.serial),
        assembled: !!r.assembled, tested: !!r.tested, note: r.note || '', created_at: new Date().toISOString() };
      this.stampUnit(u);
      d.order_units.push(u);
    }
    this.save(d);
  }
  async updateUnit(id, patch) {
    const d = this.load();
    const u = d.order_units.find((x) => x.id === id);
    if (!u) throw new Error('Виріб не знайдено');
    const old = { ...u };
    if ('serial' in patch) u.serial = this.checkSerial(d, patch.serial, id);
    for (const k of ['position', 'note', 'assembled', 'tested']) if (k in patch) u[k] = patch[k];
    this.stampUnit(u, old);
    this.save(d);
  }
  async deleteUnit(id) {
    const d = this.load();
    d.order_units = d.order_units.filter((x) => x.id !== id);
    this.save(d);
  }
  async saveOrder(order, tasks, parts) {
    const d = this.load();
    const row = cleanOrder(order);
    if (!row.title) throw new Error('Вкажіть, що замовили');
    if (!(row.qty > 0)) throw new Error('Кількість має бути більше 0');
    const now = new Date().toISOString();
    let id = order.id;
    if (id) Object.assign(d.orders.find((o) => o.id === id), row, { updated_at: now });
    else {
      id = crypto.randomUUID();
      const o = { customer: '', qty: 1, due_date: null, description: '', ...row, id,
        number: d.orders.reduce((m, x) => Math.max(m, x.number), 0) + 1,
        status: 'new', department_id: order.department_id || null, created_at: now, created_by: DEMO_USER, updated_at: now };
      d.orders.push(o);
      d.order_events.push({ id: d.order_events.length + 1, order_id: id, kind: 'created', from_status: null, to_status: 'new',
        from_department: null, to_department: o.department_id, text: '', created_at: now, created_by: DEMO_USER });
    }
    const old = new Map(d.order_tasks.filter((t) => t.order_id === id).map((t) => [t.id, t]));
    d.order_tasks = d.order_tasks.filter((t) => t.order_id !== id).concat(tasks.map((t, n) => ({
      done: false, done_by: null, done_at: null, ...(old.get(t.id) || {}),
      id: t.id || crypto.randomUUID(), order_id: id, position: n, text: t.text.trim(),
    })));
    d.order_parts = d.order_parts.filter((p) => p.order_id !== id).concat(parts.map((p) => ({ order_id: id, item_id: p.item_id, qty: p.qty })));
    this.save(d);
    return id;
  }
  async moveOrder(id, status, departmentId, comment = '') {
    const d = this.load();
    const o = d.orders.find((x) => x.id === id && !x.deleted_at);
    if (!o) throw new Error('Замовлення не знайдено');
    const txt = String(comment || '').trim();
    const dep = departmentId || o.department_id;
    if (status === 'rework' && !txt) throw new Error('Напишіть у коментарі, що треба доопрацювати');
    if (status === 'cancelled' && !txt) throw new Error('Напишіть у коментарі причину скасування');
    if (status === o.status && dep === o.department_id) throw new Error('Нічого не змінилося');
    const now = new Date().toISOString();
    d.order_events.push({ id: d.order_events.length + 1, order_id: id, kind: 'move', from_status: o.status, to_status: status,
      from_department: o.department_id, to_department: dep, text: txt, created_at: now, created_by: DEMO_USER });
    Object.assign(o, { status, department_id: dep, updated_at: now });
    this.save(d);
  }
  async deleteOrder(id) {
    const d = this.load();
    const o = d.orders.find((x) => x.id === id && !x.deleted_at);
    if (!o) throw new Error('Замовлення не знайдено або воно вже в кошику');
    Object.assign(o, { deleted_at: new Date().toISOString(), deleted_by: DEMO_USER });
    this.save(d);
  }
  async restoreOrder(id) {
    const d = this.load();
    const o = d.orders.find((x) => x.id === id && x.deleted_at);
    if (!o) throw new Error('Замовлення не знайдено в кошику');
    Object.assign(o, { deleted_at: null, deleted_by: null });
    this.save(d);
  }
  async purgeOrder(id) {
    const d = this.load();
    if (!d.orders.some((x) => x.id === id && x.deleted_at)) throw new Error('Замовлення не знайдено в кошику');
    this.dropOrders(d, [id]);
    this.save(d);
  }
  dropOrders(d, ids) {
    const gone = new Set(ids);
    d.orders = d.orders.filter((x) => !gone.has(x.id));
    for (const k of ['order_tasks', 'order_parts', 'order_events', 'order_units']) d[k] = d[k].filter((x) => !gone.has(x.order_id));
    for (const op of d.operations) if (gone.has(op.order_id)) op.order_id = null;
  }
  async addTask(orderId, text, position) {
    const d = this.load();
    d.order_tasks.push({ id: crypto.randomUUID(), order_id: orderId, position, text: text.trim(), done: false, done_by: null, done_at: null });
    this.save(d);
  }
  async setTaskDone(taskId, done) {
    const d = this.load();
    const t = d.order_tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('Пункт не знайдено');
    if (done && !t.done) Object.assign(t, { done: true, done_by: DEMO_USER, done_at: new Date().toISOString() });
    if (!done) Object.assign(t, { done: false, done_by: null, done_at: null });
    this.save(d);
  }
  async orderEvents(orderId) { return this.load().order_events.filter((e) => e.order_id === orderId); }
  async addOrderComment(orderId, text) {
    const d = this.load();
    if (!String(text || '').trim()) throw new Error('Порожній коментар');
    d.order_events.push({ id: d.order_events.length + 1, order_id: orderId, kind: 'comment', from_status: null, to_status: null,
      from_department: null, to_department: null, text: text.trim(), created_at: new Date().toISOString(), created_by: DEMO_USER });
    this.save(d);
  }
  async orderIssued(orderId) {
    return issuedMap(this.filterOps(this.load()).filter((o) => o.order_id === orderId));
  }

  async items() {
    const d = this.load();
    return d.items.map((i) => ({ ...i, qty: this.qtyOf(d, i.id), reserved: this.reservedOf(d, i.id) })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }
  async saveItem(item) {
    const d = this.load();
    const row = cleanItem(item);
    if (row.code && d.items.some((i) => i.id !== item.id && !i.deleted_at && i.code && i.code.toLowerCase() === row.code.toLowerCase())) {
      throw new Error('Такий код уже є в іншої позиції');
    }
    let id = item.id;
    if (id) Object.assign(d.items.find((i) => i.id === id), row, { updated_at: new Date().toISOString() });
    else {
      id = crypto.randomUUID();
      d.items.push({ category: '', unit: 'шт', location: '', min_qty: 0, note: '', photo_path: null, archived: false,
        ...row, id, created_at: new Date().toISOString(), created_by: DEMO_USER });
    }
    this.save(d);
    return id;
  }
  async trashItem(id) {
    const d = this.load();
    const it = d.items.find((i) => i.id === id && !i.deleted_at);
    if (!it) throw new Error('Позицію не знайдено або вона вже в кошику');
    Object.assign(it, { deleted_at: new Date().toISOString(), deleted_by: DEMO_USER });
    this.save(d);
  }
  async restoreItem(id) {
    const d = this.load();
    const it = d.items.find((i) => i.id === id && i.deleted_at);
    if (!it) throw new Error('Позицію не знайдено в кошику');
    if (it.code && d.items.some((i) => i.id !== id && !i.deleted_at && i.code && i.code.toLowerCase() === it.code.toLowerCase())) {
      throw new Error('Такий код уже є в іншої позиції');
    }
    Object.assign(it, { deleted_at: null, deleted_by: null });
    this.save(d);
  }
  hasHistory(d, id) {
    return d.movements.some((m) => m.item_id === id) || d.kit_components.some((c) => c.item_id === id) || d.order_parts.some((p) => p.item_id === id);
  }
  async purgeItem(id) {
    const d = this.load();
    const it = d.items.find((i) => i.id === id && i.deleted_at);
    if (!it) throw new Error('Позицію не знайдено в кошику');
    if (this.hasHistory(d, id)) {
      throw new Error('Позиція має історію руху або є в комплекті чи замовленні — остаточно її видалити не можна. Через 30 днів вона сама зникне з кошика, а в журналі лишиться її назва');
    }
    d.items = d.items.filter((i) => i.id !== id);
    this.save(d);
    await this.removePhoto(it.photo_path);
  }
  async purgeTrash() {
    const d = this.load();
    const cut = trashCutoff();
    this.dropOrders(d, d.orders.filter((o) => o.deleted_at && o.deleted_at < cut).map((o) => o.id));
    const oldOps = new Set(d.operations.filter((o) => o.cancelled_at && o.cancelled_at < cut).map((o) => o.id));
    d.operations = d.operations.filter((o) => !oldOps.has(o.id));
    d.movements = d.movements.filter((m) => !oldOps.has(m.operation_id));
    const gone = d.items.filter((i) => i.deleted_at && i.deleted_at < cut && !this.hasHistory(d, i.id));
    d.items = d.items.filter((i) => !gone.includes(i));
    this.save(d);
    for (const i of gone) await this.removePhoto(i.photo_path);
  }

  async uploadPhoto(blob) {
    const path = `local:${crypto.randomUUID()}`;
    try {
      localStorage.setItem(`sklad-demo-photo-${path}`, await blobToDataUrl(blob));
    } catch {
      throw new Error('Сховище браузера переповнене — у демо-режимі фото обмежені');
    }
    return path;
  }
  async removePhoto(path) { if (path) localStorage.removeItem(`sklad-demo-photo-${path}`); }
  async photoUrls(paths) {
    return Object.fromEntries(paths.map((p) => [p, localStorage.getItem(`sklad-demo-photo-${p}`)]).filter(([, u]) => u));
  }

  async kits() {
    const d = this.load();
    return d.kits.map((k) => ({ ...k, components: d.kit_components.filter((c) => c.kit_id === k.id).map((c) => ({ item_id: c.item_id, qty: c.qty })) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }
  async saveKit(kit, components) {
    const d = this.load();
    const row = { name: kit.name.trim(), note: (kit.note || '').trim(), photo_path: kit.photo_path || null, archived: !!kit.archived };
    let id = kit.id;
    if (id) Object.assign(d.kits.find((k) => k.id === id), row);
    else { id = crypto.randomUUID(); d.kits.push({ ...row, id, created_at: new Date().toISOString(), created_by: DEMO_USER }); }
    d.kit_components = d.kit_components.filter((c) => c.kit_id !== id).concat(components.map((c) => ({ kit_id: id, item_id: c.item_id, qty: c.qty })));
    this.save(d);
    return id;
  }
  async deleteKit(id) {
    const d = this.load();
    d.kits = d.kits.filter((k) => k.id !== id);
    d.kit_components = d.kit_components.filter((c) => c.kit_id !== id);
    for (const o of d.operations) if (o.kit_id === id) o.kit_id = null;
    this.save(d);
  }

  async postOperation({ type, lines = [], comment = '', counterparty = '', kit_id = null, kit_qty = null, order_id = null, op_id = null }) {
    const d = this.load();
    if (!['in', 'out', 'adjust', 'kit_out'].includes(type)) throw new Error(`Невідомий тип операції: ${type}`);
    if (op_id && d.operations.some((o) => o.id === op_id)) return op_id;  // повтор з офлайн-черги
    if (order_id && !d.orders.some((o) => o.id === order_id && !o.deleted_at)) throw new Error('Замовлення не знайдено (можливо, воно в кошику)');
    if (type === 'kit_out') {
      if (!kit_id || !(kit_qty > 0)) throw new Error('Вкажіть комплект і кількість');
      lines = d.kit_components.filter((c) => c.kit_id === kit_id).map((c) => ({ item_id: c.item_id, qty: round(c.qty * kit_qty) }));
      if (!lines.length) throw new Error('Комплект порожній');
    }
    if (!lines.length) throw new Error('Додайте хоча б одну позицію');
    const merged = new Map();
    for (const l of lines) merged.set(l.item_id, round((merged.get(l.item_id) || 0) + Number(l.qty)));

    const opId = op_id || crypto.randomUUID();
    const now = new Date().toISOString();
    const moves = [];
    for (const [itemId, qty] of merged) {
      const item = d.items.find((i) => i.id === itemId);
      if (!item) throw new Error('Позицію не знайдено');
      if (item.deleted_at) throw new Error(`Позиція «${item.name}» у кошику — спершу відновіть її`);
      if (!Number.isFinite(qty) || (type !== 'adjust' && qty <= 0) || (type === 'adjust' && qty < 0)) {
        throw new Error(`Неправильна кількість для «${item.name}»`);
      }
      const have = this.qtyOf(d, itemId);
      const delta = type === 'in' ? qty : type === 'adjust' ? round(qty - have) : -qty;
      if (have + delta < 0) throw new Error(`Недостатньо «${item.name}»: є ${have}, потрібно ${qty}`);
      if (delta !== 0) moves.push({ id: d.movements.length + moves.length + 1, operation_id: opId, item_id: itemId, qty: delta, created_at: now });
    }
    if (!moves.length && type !== 'adjust') throw new Error('Немає що проводити');
    d.operations.push({ id: opId, type, comment, counterparty, kit_id: type === 'kit_out' ? kit_id : null,
      kit_qty: type === 'kit_out' ? kit_qty : null, order_id: order_id || null,
      created_at: now, created_by: DEMO_USER, cancelled_at: null, cancelled_by: null });
    d.movements.push(...moves);
    this.save(d);
    return opId;
  }
  async cancelOperation(id) {
    const d = this.load();
    const op = d.operations.find((o) => o.id === id && !o.cancelled_at);
    if (!op) throw new Error('Операцію не знайдено або її вже видалено');
    const sums = new Map();
    for (const m of d.movements.filter((x) => x.operation_id === id)) sums.set(m.item_id, (sums.get(m.item_id) || 0) + m.qty);
    for (const [itemId, qty] of sums) {
      const left = round(this.qtyOf(d, itemId) - qty);
      if (left < 0) throw new Error(`Не можна видалити: залишок «${d.items.find((i) => i.id === itemId)?.name}» стане ${left}`);
    }
    op.cancelled_at = new Date().toISOString();
    op.cancelled_by = DEMO_USER;
    this.save(d);
  }
  async restoreOperation(id) {
    const d = this.load();
    const op = d.operations.find((o) => o.id === id && o.cancelled_at);
    if (!op) throw new Error('Операцію не знайдено в кошику');
    const sums = new Map();
    for (const m of d.movements.filter((x) => x.operation_id === id)) sums.set(m.item_id, (sums.get(m.item_id) || 0) + m.qty);
    for (const [itemId, qty] of sums) {
      const left = round(this.qtyOf(d, itemId) + qty);
      if (left < 0) throw new Error(`Не можна відновити: залишок «${d.items.find((i) => i.id === itemId)?.name}» стане ${left}`);
    }
    Object.assign(op, { cancelled_at: null, cancelled_by: null });
    this.save(d);
  }
  async purgeOperation(id) {
    const d = this.load();
    if (!d.operations.some((o) => o.id === id && o.cancelled_at)) throw new Error('Операцію не знайдено в кошику');
    d.operations = d.operations.filter((o) => o.id !== id);
    d.movements = d.movements.filter((m) => m.operation_id !== id);
    this.save(d);
  }
  async trashOperations() {
    const cut = trashCutoff();
    return this.filterOps(this.load(), { trash: true })
      .filter((o) => o.cancelled_at >= cut)
      .sort((a, b) => b.cancelled_at.localeCompare(a.cancelled_at));
  }

  // без trash — лише живі операції (як у журналі); з trash — лише видалені
  filterOps(d, { type, from, to, trash = false } = {}) {
    const lo = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
    const hi = to ? new Date(to + 'T00:00:00').getTime() + 864e5 : Infinity;
    return d.operations
      .filter((o) => !!o.cancelled_at === trash)
      .filter((o) => (!type || o.type === type) && new Date(o.created_at).getTime() >= lo && new Date(o.created_at).getTime() < hi)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((o) => ({ ...o, movements: d.movements.filter((m) => m.operation_id === o.id).map((m) => ({ item_id: m.item_id, qty: m.qty })) }));
  }
  async operations({ before, limit = 50, ...f } = {}) {
    return this.filterOps(this.load(), f).filter((o) => !before || o.created_at < before).slice(0, limit);
  }
  async allOperations(f) { return this.filterOps(this.load(), f); }
  async itemHistory(itemId) {
    const d = this.load();
    return d.movements.filter((m) => m.item_id === itemId).reverse()
      .map((m) => ({ qty: m.qty, op: d.operations.find((o) => o.id === m.operation_id) }));
  }
  subscribe(cb) { this.listeners.push(cb); }

  resetDemo() {
    for (const k of Object.keys(localStorage)) if (k.startsWith('sklad-demo')) localStorage.removeItem(k);
  }
}

export const api = isDemo ? new LocalApi() : new SupaApi();
