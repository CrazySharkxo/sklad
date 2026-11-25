// Налаштування (лише адміністратор): назва організації для документів,
// сповіщення в Telegram — токен бота, чати, що саме надсилати.
import { api, isDemo } from '../api.js';
import { esc, fmtDate, toast } from '../util.js';
import { state, reloadData } from '../core.js';

export async function viewNotifications(ctx) {
  ctx.header({ title: 'Сповіщення Telegram', back: '#/more' });
  ctx.main.innerHTML = '<div class="muted pad">Завантаження…</div>';
  let s;
  try { s = await api.adminSettings(); } catch (e) { toast(e.message, 'err'); return; }
  if (!ctx.alive()) return;

  ctx.main.innerHTML = `
    ${isDemo ? '<div class="card hint">Демо-режим: налаштування збережуться лише в цьому браузері, повідомлення не надсилаються.</div>' : ''}
    ${!isDemo && !s.pg_net ? `<div class="card hint warn-card">У базі не ввімкнено розширення <b>pg_net</b> — повідомлення не підуть.
      Виконайте ще раз <code>supabase/schema.sql</code> у SQL Editor (він вмикає pg_net сам) або ввімкніть його в Supabase → Database → Extensions.</div>` : ''}
    <div class="card hint">
      <b>Як підключити за 3 хвилини.</b><br>
      1. У Telegram відкрийте <b>@BotFather</b> → <code>/newbot</code> → отримаєте токен виду <code>123456:ABC-DEF…</code>.<br>
      2. Створіть групу (або візьміть наявну), додайте в неї бота.<br>
      3. Дізнайтеся id групи: додайте в групу <b>@getidsbot</b> (або @userinfobot) — він напише id, зазвичай відʼємний, напр. <code>-1001234567890</code>.<br>
      4. Впишіть токен і id нижче, збережіть і натисніть «Надіслати тестове».
    </div>
    <form class="form card" id="f" autocomplete="off">
      <div class="grid2">
        <label class="field"><span>Токен бота${s.tg_token_set ? ` <small class="pos">· збережено ${esc(s.tg_token_hint)}</small>` : ''}</span>
          <input name="tg_token" placeholder="${s.tg_token_set ? 'лишіть порожнім, щоб не міняти' : '123456789:AAH…'}" autocomplete="off"></label>
        <label class="field"><span>Головний чат (id групи)</span><input name="tg_chat" value="${esc(s.tg_chat)}" placeholder="-1001234567890"></label>
        <label class="field"><span>Адреса програми <small class="muted">— для посилань у повідомленнях</small></span>
          <input name="app_url" value="${esc(s.app_url)}" placeholder="${esc(location.origin + location.pathname)}"></label>
        <label class="field"><span>Назва організації <small class="muted">— шапка накладних</small></span>
          <input name="org_name" value="${esc(s.org_name)}" placeholder="Склад"></label>
      </div>
      <div class="field"><span>Що надсилати</span>
        <label class="check"><input type="checkbox" name="tg_orders" ${s.tg_orders ? 'checked' : ''}> Замовлення: прийняте, передане в інший відділ, повернуте на доопрацювання, готове</label>
        <label class="check"><input type="checkbox" name="tg_low" ${s.tg_low ? 'checked' : ''}> Склад: позиція впала нижче мінімального залишку</label>
        <label class="check"><input type="checkbox" name="tg_overdue" ${s.tg_overdue ? 'checked' : ''}> Щодня зранку: список прострочених замовлень${s.overdue_sent_on ? ` <small class="muted">(останній — ${esc(s.overdue_sent_on)})</small>` : ''}</label>
      </div>
      <div class="form-actions">
        ${s.tg_token_set ? '<button type="button" class="btn ghost del-btn" id="clear">Прибрати токен</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn ghost" id="test" ${s.tg_token_set && s.tg_chat ? '' : 'disabled'}>Надіслати тестове</button>
        <button class="btn primary">Зберегти</button>
      </div>
      <p class="muted small" id="test-res"></p>
    </form>

    <h3>Чати відділів <small class="muted">— необовʼязково</small></h3>
    <div class="card">
      <p class="muted small">Якщо у відділу своя група — замовлення, що приходять у цей відділ, підуть і туди. Порожньо = лише головний чат.</p>
      <div class="lines" id="deps">${state.departments.map((d) => `
        <div class="line dep-chat" data-id="${d.id}"><div class="line-name"><b>${esc(d.name)}</b></div>
          <input class="chat" value="${esc(d.tg_chat || '')}" placeholder="id групи" aria-label="Чат відділу ${esc(d.name)}">
          <button type="button" class="btn ghost sm" data-save>Зберегти</button></div>`).join('') || '<div class="muted pad">Відділів немає</div>'}</div>
    </div>`;

  const f = ctx.main.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {
      tg_chat: f.tg_chat.value, app_url: f.app_url.value, org_name: f.org_name.value,
      tg_orders: f.tg_orders.checked, tg_low: f.tg_low.checked, tg_overdue: f.tg_overdue.checked,
    };
    if (f.tg_token.value.trim()) patch.tg_token = f.tg_token.value.trim();
    try {
      await api.saveSettings(patch);
      await reloadData();
      toast('Збережено');
      viewNotifications(ctx);
    } catch (err) { toast(err.message, 'err', 6000); }
  });
  f.querySelector('#clear')?.addEventListener('click', async () => {
    try { await api.saveSettings({ tg_token: '' }); toast('Токен прибрано'); viewNotifications(ctx); } catch (err) { toast(err.message, 'err'); }
  });
  f.querySelector('#test').addEventListener('click', async (e) => {
    const res = ctx.main.querySelector('#test-res');
    e.target.disabled = true;
    res.textContent = 'Надсилаю…';
    try {
      const reqId = await api.tgTest();
      if (!reqId) { res.textContent = 'Не надіслано: немає токена, чату або pg_net.'; return; }
      // pg_net відповідає асинхронно — зачекаємо й спитаємо результат
      let r = '';
      for (let i = 0; i < 6 && !r; i++) {
        await new Promise((ok) => setTimeout(ok, 1500));
        r = await api.tgResult(reqId).catch(() => '');
      }
      if (!r) res.textContent = 'Запит відправлено, відповідь Telegram ще не прийшла — перевірте чат.';
      else if (/"ok":true/.test(r)) { res.textContent = 'Telegram відповів OK — перевірте чат.'; toast('Тестове повідомлення надіслано'); }
      else res.textContent = `Telegram відповів: ${r.slice(0, 300)} — перевірте токен і id чату (бот має бути учасником групи).`;
    } catch (err) { res.textContent = err.message; } finally { e.target.disabled = false; }
  });
  ctx.main.querySelector('#deps').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const row = b.closest('.dep-chat');
    const dep = state.departments.find((d) => d.id === row.dataset.id);
    b.disabled = true;
    try {
      await api.saveDepartment({ id: dep.id, name: dep.name, tg_chat: row.querySelector('.chat').value });
      await reloadData();
      toast(`Чат відділу «${dep.name}» збережено`);
    } catch (err) { toast(err.message, 'err'); } finally { b.disabled = false; }
  });
}

export const lastBackupText = (at) => (at ? `остання копія ${fmtDate(at)}` : 'копій ще не було');
