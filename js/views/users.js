// Користувачі, ролі та права: керує лише головний адміністратор,
// інші адміністратори бачать списки без кнопок і форм
import { api, isDemo } from '../api.js';
import { esc, fmtDate, toast, confirmDialog, promptDialog } from '../util.js';
import {
  state, go, reloadData, depName, roleName, PERM_SECTIONS, PERM_ACTIONS, PERM_EXTRA, ICON_PLUS,
  isOwner, canManageUsers, userName,
} from '../core.js';

// ------------------------------------------------------------------
// Таблиця галочок: розділ × (перегляд, зміна, видалення) + окремі права
// ------------------------------------------------------------------
function permMatrix(container, initial, { disabled = false } = {}) {
  const has = new Set(initial || []);
  container.innerHTML = `
    <table class="tbl perm-tbl">
      <thead><tr><th>Розділ</th>${PERM_ACTIONS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${PERM_SECTIONS.map(([sec, label, hint]) => `<tr>
        <td><b>${label}</b>${hint ? `<small class="muted">${hint}</small>` : ''}</td>
        ${PERM_ACTIONS.map(([act, l]) => `<td><input type="checkbox" data-p="${sec}.${act}" aria-label="${label}: ${l}"></td>`).join('')}
      </tr>`).join('')}</tbody>
    </table>
    <div class="perm-extra">${PERM_EXTRA.map(([p, label, hint]) => `
      <label class="check"><input type="checkbox" data-p="${p}"><span><b>${label}</b><small class="muted">${hint}</small></span></label>`).join('')}
    </div>`;
  const boxes = [...container.querySelectorAll('[data-p]')];
  const box = (p) => boxes.find((b) => b.dataset.p === p);
  for (const b of boxes) b.checked = has.has(b.dataset.p);
  const sync = () => {
    const admin = box('admin').checked;
    for (const b of boxes) {
      if (b.dataset.p === 'admin') { b.disabled = disabled; continue; }
      b.disabled = disabled || admin;
      if (admin) b.checked = true;
    }
  };
  container.addEventListener('change', (e) => {
    const p = e.target.dataset.p;
    if (!p) return;
    const [sec, act] = p.split('.');
    // зміна чи видалення без перегляду не мають сенсу — і навпаки
    if (e.target.checked && (act === 'edit' || act === 'delete')) box(`${sec}.view`).checked = true;
    if (!e.target.checked && act === 'view') { box(`${sec}.edit`).checked = false; box(`${sec}.delete`).checked = false; }
    if (!e.target.checked && p === 'orders.view') box('orders.all').checked = false;
    if (e.target.checked && p === 'orders.all') box('orders.view').checked = true;
    if (p === 'admin' && !e.target.checked) for (const b of boxes) b.checked = false;
    sync();
  });
  sync();
  return {
    get: () => (box('admin').checked ? ['admin'] : boxes.filter((b) => b.checked).map((b) => b.dataset.p)),
    set: (perms) => { const s = new Set(perms || []); for (const b of boxes) b.checked = s.has(b.dataset.p); sync(); },
    disable: (v) => { disabled = v; sync(); },
  };
}

// коротко, що дає набір прав
export function permSummary(perms) {
  const s = new Set(perms || []);
  if (s.has('admin')) return 'усі права (адміністратор)';
  const parts = PERM_SECTIONS.map(([sec, label]) => {
    const acts = PERM_ACTIONS.filter(([a]) => s.has(`${sec}.${a}`)).map(([, l]) => l.toLowerCase());
    return acts.length ? `${label}: ${acts.join(', ')}` : '';
  }).filter(Boolean);
  if (s.has('orders.all')) parts.push('усі відділи');
  return parts.join(' · ') || 'без прав';
}

const demoNote = isDemo
  ? '<div class="card hint">Демо-режим: користувачі тут лише записи — увійти ними не можна. У спільній базі все працює по-справжньому.</div>' : '';

const OWNER_TAG = '<span class="tag st-new owner-tag">Головний адміністратор</span>';
// пояснення для адміністратора, який не головний: списки — лише для читання
const readOnlyNote = () => (canManageUsers() ? '' : `<div class="card hint" id="ro-note"><b>Права надає лише головний адміністратор</b>${
  state.owner ? ` — ${esc(userName(state.owner))}` : ''}. Ви бачите список людей і ролей, але додавати, змінювати чи блокувати може тільки він.</div>`);

// ------------------------------------------------------------------
export async function viewUsers(ctx) {
  const manage = canManageUsers();
  ctx.header({
    title: 'Користувачі', back: '#/more',
    actions: `<a class="btn ghost sm" href="#/roles">Ролі</a>${manage ? `<a class="btn primary sm" href="#/user/new">${ICON_PLUS}<span>Користувач</span></a>` : ''}`,
  });
  ctx.main.innerHTML = `${demoNote}${readOnlyNote()}<div id="list" class="list"><div class="muted pad">Завантаження…</div></div>`;
  let users;
  try { users = await api.users(); } catch (e) { toast(e.message, 'err'); return; }
  if (!ctx.alive()) return;
  // головному — рядки-посилання на картку; іншим адміністраторам — просто список
  const [open, close] = manage ? ['a', 'a'] : ['div', 'div'];
  ctx.main.querySelector('#list').innerHTML = users.map((u) => `
    <${open} class="row user-row${u.active ? '' : ' archived'}"${manage ? ` href="#/user/${u.id}"` : ''}>
      <div class="row-main">
        <div class="row-title">${esc(u.display_name || u.email)}${u.id === state.me ? ' <span class="tag st-done">ви</span>' : ''}${isOwner(u.id) ? ` ${OWNER_TAG}` : ''}${u.active ? '' : ' <span class="tag st-rework">заблоковано</span>'}</div>
        <div class="row-meta">${esc(u.email)} · ${u.perms ? 'свої права' : esc(roleName(u.role_id))}${u.department_id ? ` · ${esc(depName(u.department_id))}` : ''}</div>
      </div>
      <div class="row-qty"><small>${u.last_sign_in_at ? `входив ${fmtDate(u.last_sign_in_at)}` : 'ще не входив'}</small></div>
    </${close}>`).join('') || '<div class="empty-state"><p>Користувачів немає</p></div>';
}

// ------------------------------------------------------------------
const randomPassword = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const a = crypto.getRandomValues(new Uint32Array(10));
  return [...a].map((x) => abc[x % abc.length]).join('');
};

export async function viewUserEdit(ctx, id) {
  if (!canManageUsers()) { await viewUsers(ctx); return; }  // картки — лише головному
  const isNew = id === 'new';
  ctx.header({ title: isNew ? 'Новий користувач' : 'Користувач', back: '#/users' });
  let u = { display_name: '', email: '', role_id: null, department_id: null, perms: null, active: true };
  if (!isNew) {
    let users;
    try { users = await api.users(); } catch (e) { toast(e.message, 'err'); return; }
    u = users.find((x) => x.id === id);
    if (!ctx.alive()) return;
    if (!u) { ctx.notFound(); return; }
  }
  const self = u.id === state.me;
  // головний адміністратор не може зняти із себе роль чи права (сервер відмовить так само)
  const lock = !isNew && isOwner(u.id);
  const viewer = state.roles.find((r) => r.name === 'Лише перегляд');
  const roleId = isNew ? (viewer?.id || state.roles[0]?.id || '') : (u.role_id || '');

  ctx.main.innerHTML = `
    ${demoNote}
    ${lock ? `<div class="card hint" id="owner-note">${OWNER_TAG} Це головний адміністратор: лише він додає людей і надає права.
      Його роль, права й активність змінити не можна — щоб випадково не лишити склад без керування.</div>` : ''}
    <form class="form card" id="f" autocomplete="off">
      <div class="grid2">
        <label class="field"><span>Імʼя (так видно в журналі)</span><input name="name" value="${esc(u.display_name)}" placeholder="Напр. Петро Іваненко"></label>
        ${isNew
    ? `<label class="field"><span>Email (логін) *</span><input name="email" type="email" required autocomplete="off"></label>
           <label class="field"><span>Пароль для першого входу *</span>
             <div class="with-btn"><input name="password" required minlength="6" value="${randomPassword()}"><button type="button" class="btn ghost sm" id="gen">Інший</button></div>
             <small class="muted">Передайте його людині — змінити можна в «Ще → Змінити пароль».</small></label>`
    : `<div class="field"><span>Email (логін)</span><div class="static">${esc(u.email)}</div></div>`}
        <label class="field"><span>Роль</span><select name="role"${lock ? ' disabled' : ''}>
          <option value="">— без ролі —</option>
          ${state.roles.map((r) => `<option value="${r.id}"${r.id === roleId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select></label>
        <label class="field"><span>Відділ</span><select name="dep">
          <option value="">— без відділу —</option>
          ${state.departments.map((d) => `<option value="${d.id}"${d.id === u.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select></label>
      </div>
      <div class="field"><span>Права</span>
        <div class="seg">
          <label><input type="radio" name="mode" value="role"${u.perms ? '' : ' checked'}${lock ? ' disabled' : ''}> як у ролі</label>
          <label><input type="radio" name="mode" value="own"${u.perms ? ' checked' : ''}${lock ? ' disabled' : ''}> свої галочки</label>
        </div>
      </div>
      <div id="perms"></div>
      ${isNew ? '' : `<label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}${self ? ' disabled' : ''}>
        Активний — може входити й працювати${self ? ' <small class="muted">(себе заблокувати не можна)</small>' : ''}</label>`}
      <div class="form-actions">
        ${isNew || self ? '' : '<button type="button" class="btn ghost del-btn" id="del">Видалити користувача</button>'}
        ${isNew ? '' : '<button type="button" class="btn ghost" id="pw">Новий пароль</button>'}
        <span class="grow"></span>
        <a class="btn ghost" href="#/users">Скасувати</a>
        <button class="btn primary" id="save">${isNew ? 'Створити' : 'Зберегти'}</button>
      </div>
    </form>`;

  const f = ctx.main.querySelector('#f');
  const rolePerms = () => state.roles.find((r) => r.id === f.role.value)?.perms || [];
  const own = () => f.querySelector('[name=mode]:checked').value === 'own';
  const matrix = permMatrix(ctx.main.querySelector('#perms'), u.perms || rolePerms(), { disabled: lock || !u.perms });
  f.role.addEventListener('change', () => { if (!own()) matrix.set(rolePerms()); });
  f.querySelectorAll('[name=mode]').forEach((r) => r.addEventListener('change', () => {
    if (!own()) matrix.set(rolePerms());
    matrix.disable(!own());
  }));
  f.querySelector('#gen')?.addEventListener('click', () => { f.password.value = randomPassword(); });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('#save');
    btn.disabled = true;
    const data = {
      name: f.name.value.trim(), role_id: f.role.value || null, department_id: f.dep.value || null,
      perms: own() ? matrix.get() : null, active: isNew ? true : f.active.checked,
    };
    try {
      if (isNew) {
        const newId = await api.createUser({ email: f.email.value.trim(), password: f.password.value, ...data });
        if (data.perms) await api.updateUser({ id: newId, ...data });
        toast(`Користувача створено. Логін: ${f.email.value.trim()}`, 'ok', 6000);
      } else {
        await api.updateUser({ id, ...data });
        toast('Збережено');
      }
      await reloadData();
      go('#/users');
    } catch (err) {
      toast(err.message, 'err', 8000);
      btn.disabled = false;
    }
  });
  f.querySelector('#pw')?.addEventListener('click', async () => {
    const pw = await promptDialog(`Новий пароль для ${u.email} (мінімум 6 символів)`, randomPassword(), { ok: 'Змінити' });
    if (!pw) return;
    try {
      await api.setUserPassword(id, pw);
      toast(`Пароль змінено: ${pw}`, 'ok', 10000);
    } catch (err) { toast(err.message, 'err'); }
  });
  f.querySelector('#del')?.addEventListener('click', async () => {
    if (!await confirmDialog(`Видалити користувача ${u.email}? Увійти він більше не зможе. Його операції й замовлення лишаться в історії. Якщо людина може повернутися — краще просто заблокувати.`,
      { ok: 'Видалити', danger: true })) return;
    try {
      await api.deleteUser(id);
      await reloadData();
      toast('Користувача видалено');
      go('#/users');
    } catch (err) { toast(err.message, 'err', 8000); }
  });
}

// ------------------------------------------------------------------
export async function viewRoles(ctx) {
  const manage = canManageUsers();
  ctx.header({ title: 'Ролі', back: '#/users', actions: manage ? `<a class="btn primary sm" href="#/role/new">${ICON_PLUS}<span>Роль</span></a>` : '' });
  const users = await api.users().catch(() => []);
  if (!ctx.alive()) return;
  const tag = manage ? 'a' : 'div';
  ctx.main.innerHTML = `
    ${readOnlyNote()}
    <div class="card hint">Роль — готовий набір прав. ${manage ? 'Змініть роль — зміняться права всіх, у кого вона стоїть' : 'Зміна ролі змінює права всіх, у кого вона стоїть'}
      (крім людей зі «своїми галочками»).</div>
    <div class="list">${state.roles.map((r) => {
      const n = users.filter((u) => u.role_id === r.id && !u.perms).length;
      return `<${tag} class="row"${manage ? ` href="#/role/${r.id}"` : ''}><div class="row-main">
        <div class="row-title">${esc(r.name)}</div><div class="row-meta wrap">${esc(permSummary(r.perms))}</div></div>
        <div class="row-qty"><b>${n}</b><small>людей</small></div></${tag}>`;
    }).join('')}</div>`;
}

export async function viewRoleEdit(ctx, id) {
  if (!canManageUsers()) { await viewRoles(ctx); return; }  // ролі змінює лише головний
  const isNew = id === 'new';
  const role = isNew ? { name: '', perms: ['stock.view', 'ops.view', 'kits.view', 'orders.view'] } : state.roles.find((r) => r.id === id);
  if (!role) { ctx.notFound(); return; }
  ctx.header({ title: isNew ? 'Нова роль' : role.name, back: '#/roles' });
  ctx.main.innerHTML = `
    <form class="form card" id="f" autocomplete="off">
      <label class="field"><span>Назва ролі *</span><input name="name" required value="${esc(role.name)}" placeholder="Напр. Тестувальник"></label>
      <div id="perms"></div>
      <div class="form-actions">
        ${isNew ? '' : '<button type="button" class="btn ghost del-btn" id="del">Видалити роль</button>'}
        <span class="grow"></span>
        <a class="btn ghost" href="#/roles">Скасувати</a>
        <button class="btn primary" id="save">Зберегти</button>
      </div>
    </form>`;
  const f = ctx.main.querySelector('#f');
  const matrix = permMatrix(ctx.main.querySelector('#perms'), role.perms);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.saveRole({ id: isNew ? undefined : id, name: f.name.value, perms: matrix.get() });
      await reloadData();
      toast('Роль збережено');
      go('#/roles');
    } catch (err) { toast(err.message, 'err', 8000); }
  });
  f.querySelector('#del')?.addEventListener('click', async () => {
    const users = await api.users().catch(() => []);
    const n = users.filter((u) => u.role_id === id).length;
    if (!await confirmDialog(`Видалити роль «${role.name}»?${n ? ` У ${n} людей вона стоїть — вони залишаться без ролі й без прав, доки не призначите іншу.` : ''}`,
      { ok: 'Видалити', danger: true })) return;
    try {
      await api.deleteRole(id);
      await reloadData();
      toast('Роль видалено');
      go('#/roles');
    } catch (err) { toast(err.message, 'err', 8000); }
  });
}
