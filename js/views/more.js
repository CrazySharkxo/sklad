// Дозамовити, етикетки, імпорт/експорт Excel, профіль
import { api, isDemo } from '../api.js';
import { esc, fmtQty, parseNum, norm, toast, confirmDialog, promptDialog, downloadXlsx, readSheet, todayIso } from '../util.js';
import { state, go, reloadData, activeItems, isLow, searchItems, hydratePhotos, thumb, myDepartment, depName, can } from '../core.js';
import { printLabels } from './stock.js';
import { exportJournal } from './ops.js';
import { exportOrders } from './orders.js';
import { pending, outboxBannerText } from '../outbox.js';
import { lastBackupText } from './settings.js';

export function viewMore(ctx) {
  ctx.header({ title: 'Ще' });
  const me = state.profiles[state.me] || '';
  const low = activeItems().filter(isLow).length;
  const dep = myDepartment();
  const queued = pending().length;
  ctx.main.innerHTML = `
    ${state.perms.size ? '' : `<div class="card hint">Вам ще не надали прав. Зверніться до адміністратора складу —
      він відкриє потрібні розділи в «Ще → Користувачі».</div>`}
    <div class="menu">
      ${queued ? `<a href="#/outbox" class="menu-item outbox-item"><b>Черга відправки</b><span class="muted">${esc(outboxBannerText())}</span></a>` : ''}
      ${can('admin') ? `<a href="#/users" class="menu-item"><b>Користувачі та ролі</b><span class="muted">додати людей, права доступу, блокування</span></a>
      <a href="#/notifications" class="menu-item"><b>Сповіщення Telegram</b><span class="muted">нові замовлення, передачі, мало на складі, прострочені</span></a>
      <a href="#/backups" class="menu-item"><b>Резервні копії</b><span class="muted">${isDemo ? 'завантажити копію даних' : esc(lastBackupText(state.settings?.backup_at))}</span></a>` : ''}
      <a href="#/departments" class="menu-item"><b>Відділи</b><span class="muted">${dep ? `мій відділ: ${esc(depName(dep))}` : 'свій відділ ще не вибрано'}</span></a>
      ${can('stock.view') ? '' : '<!--'}<a href="#/reorder" class="menu-item"><b>Дозамовити</b><span class="muted">${low ? `${low} позицій нижче мінімуму` : 'усе в нормі'}</span></a>
${can('stock.view') ? '' : '-->'}
      ${can('ops.edit') ? '<a href="#/inventory" class="menu-item only-wide"><b>Інвентаризація</b><span class="muted">перерахунок фактичної кількості</span></a>' : ''}
      ${can('stock.view') ? '<a href="#/labels" class="menu-item"><b>Етикетки з QR-кодом</b><span class="muted">друк наліпок для полиць і коробок</span></a>' : ''}
      ${can('stock.edit') ? '<a href="#/import" class="menu-item"><b>Імпорт з Excel</b><span class="muted">завантажити список позицій і залишків</span></a>' : ''}
      ${can('stock.view') ? '<button class="menu-item" data-x="stock"><b>Залишки в Excel</b><span class="muted">поточний стан складу</span></button>' : ''}
      ${can('ops.view') ? '<button class="menu-item" data-x="journal"><b>Журнал в Excel</b><span class="muted">усі операції (з фільтром журналу)</span></button>' : ''}
      ${can('orders.view') ? '<button class="menu-item" data-x="orders"><b>Замовлення в Excel</b><span class="muted">усі замовлення зі статусами</span></button>' : ''}
      <button class="menu-item" data-x="name"><b>Моє імʼя</b><span class="muted">${esc(me || 'не вказано')} — так вас видно в журналі</span></button>
      ${isDemo ? `<button class="menu-item" data-x="reset"><b>Очистити демо-дані</b><span class="muted">стерти все, що введено в цьому браузері</span></button>`
        : `<button class="menu-item" data-x="pw"><b>Змінити пароль</b><span class="muted"></span></button>
           <button class="menu-item" data-x="out"><b>Вийти</b><span class="muted" id="em"></span></button>`}
    </div>
    <p class="muted center small">Склад · версія ${esc(window.APP_VERSION || '?')} · ${isDemo ? 'демо-режим (дані лише в цьому браузері)' : 'спільна база'}</p>`;
  if (!isDemo) api.email().then((e) => { const el = ctx.main.querySelector('#em'); if (el) el.textContent = e; });

  ctx.main.querySelector('.menu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    const x = b.dataset.x;
    if (x === 'stock') exportStock();
    if (x === 'journal') exportJournal();
    if (x === 'orders') exportOrders();
    if (x === 'name') {
      const name = await promptDialog('Ваше імʼя для журналу', me);
      if (name) { await api.setMyName(name).catch((er) => toast(er.message, 'err')); await reloadData(); viewMore(ctx); }
    }
    if (x === 'pw') {
      const pw = await promptDialog('Новий пароль (мінімум 6 символів)', '', { ok: 'Змінити' });
      if (pw) {
        if (pw.length < 6) return toast('Пароль закороткий', 'err');
        try { await api.changePassword(pw); toast('Пароль змінено'); } catch (er) { toast(er.message, 'err'); }
      }
    }
    if (x === 'out') { await api.signOut(); location.hash = ''; location.reload(); }
    if (x === 'reset' && await confirmDialog('Стерти всі демо-дані в цьому браузері?', { ok: 'Стерти', danger: true })) {
      api.resetDemo();
      location.hash = '';
      location.reload();
    }
  });
}

export function exportStock() {
  const rows = [['Назва', 'Код', 'Категорія', 'Місце', 'Одиниця', 'Залишок', 'Резерв', 'Мінімум', 'Дозамовити', 'Примітка']];
  for (const i of activeItems()) {
    rows.push([i.name, i.code || '', i.category, i.location, i.unit, i.qty, i.reserved || '', i.min_qty || '', isLow(i) ? i.min_qty - i.qty : '', i.note]);
  }
  downloadXlsx(`залишки_${todayIso()}.xlsx`, [{ name: 'Залишки', rows, widths: [36, 16, 16, 16, 8, 10, 8, 9, 11, 30] }]);
}

// ------------------------------------------------------------------
export function viewReorder(ctx) {
  ctx.header({ title: 'Дозамовити', back: '#/more', actions: '<button class="btn ghost sm" data-xls>Excel</button>' });
  const list = activeItems().filter(isLow).sort((a, b) => (a.qty / a.min_qty) - (b.qty / b.min_qty));
  ctx.main.innerHTML = list.length ? `<div class="list">${list.map((i) => `
    <a class="row" href="#/item/${i.id}">${thumb(i.photo_path)}
      <div class="row-main"><div class="row-title">${esc(i.name)}</div>
        <div class="row-meta">є ${fmtQty(i.qty)} з мін. ${fmtQty(i.min_qty)} ${esc(i.unit)}${i.category ? ' · ' + esc(i.category) : ''}</div></div>
      <div class="row-qty low"><b>${fmtQty(i.min_qty - i.qty)}</b><small>${esc(i.unit)} бракує</small></div>
    </a>`).join('')}</div>`
    : '<div class="empty-state"><p>Усі позиції вище мінімального залишку.</p><p class="muted">Мінімум задається в картці позиції → Редагувати.</p></div>';
  hydratePhotos(ctx.main);
  ctx.headerEl.querySelector('[data-xls]').addEventListener('click', () => {
    const rows = [['Назва', 'Код', 'Категорія', 'Одиниця', 'Залишок', 'Мінімум', 'Бракує'],
      ...list.map((i) => [i.name, i.code || '', i.category, i.unit, i.qty, i.min_qty, i.min_qty - i.qty])];
    downloadXlsx(`дозамовити_${todayIso()}.xlsx`, [{ name: 'Дозамовити', rows, widths: [36, 16, 16, 8, 10, 9, 9] }]);
  });
}

// ------------------------------------------------------------------
export function viewLabels(ctx) {
  ctx.header({ title: 'Етикетки', back: '#/more' });
  const sel = new Set();
  ctx.main.innerHTML = `
    <div class="card hint">Позначте позиції та натисніть «Друк». На етикетці — QR-код, назва й код.
      Скануйте її в програмі, щоб одразу відкрити позицію. Позиція без власного коду отримує внутрішній.</div>
    <div class="toolbar"><div class="search"><input type="search" id="q" placeholder="Пошук"></div>
      <button class="btn ghost sm" id="all">Позначити всі знайдені</button></div>
    <div id="rows" class="list"></div>
    <div class="bottom-actions"><span class="muted" id="cnt"></span><span class="grow"></span><button class="btn primary" id="print">Друк</button></div>`;
  const rows = ctx.main.querySelector('#rows');
  let shown = [];
  const render = () => {
    shown = searchItems(ctx.main.querySelector('#q').value);
    rows.innerHTML = shown.map((i) => `<label class="row check-row"><input type="checkbox" data-id="${i.id}" ${sel.has(i.id) ? 'checked' : ''}>
      <div class="row-main"><div class="row-title">${esc(i.name)}</div><div class="row-meta">${esc(i.code || 'без коду')}</div></div></label>`).join('');
    ctx.main.querySelector('#cnt').textContent = `Вибрано: ${sel.size}`;
  };
  render();
  ctx.main.querySelector('#q').addEventListener('input', render);
  rows.addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (e.target.checked) sel.add(id); else sel.delete(id);
    ctx.main.querySelector('#cnt').textContent = `Вибрано: ${sel.size}`;
  });
  ctx.main.querySelector('#all').addEventListener('click', () => { shown.forEach((i) => sel.add(i.id)); render(); });
  ctx.main.querySelector('#print').addEventListener('click', () => {
    if (!sel.size) return toast('Нічого не вибрано', 'err');
    printLabels(state.items.filter((i) => sel.has(i.id)));
  });
}

// ------------------------------------------------------------------
// Імпорт з Excel: шапка таблиці розпізнається за назвами стовпців
// ------------------------------------------------------------------
const COLS = {
  name: ['назва', 'найменування', 'name', 'товар', 'позиція'],
  code: ['код', 'штрихкод', 'артикул', 'code', 'sku', 'barcode'],
  category: ['категорія', 'група', 'category'],
  unit: ['одиниця', 'од.', 'од', 'одиниця виміру', 'unit'],
  location: ['місце', 'місце зберігання', 'комірка', 'location'],
  min_qty: ['мінімум', 'мін', 'мін.', 'мінімальний залишок', 'min'],
  qty: ['кількість', 'залишок', 'к-сть', 'qty', 'quantity'],
  note: ['примітка', 'коментар', 'note'],
};

const matchExisting = (r) => (r.code && state.items.find((i) => i.code && i.code.toLowerCase() === r.code.toLowerCase()))
  || state.items.find((i) => norm(i.name) === norm(r.name)) || null;

export function viewImport(ctx) {
  ctx.header({ title: 'Імпорт з Excel', back: '#/more' });
  ctx.main.innerHTML = `
    <div class="card hint">
      Перший рядок таблиці — назви стовпців: <b>Назва</b> (обовʼязково), Код, Категорія, Одиниця, Місце, Мінімум, <b>Кількість</b>, Примітка.
      Позиція, яку вже є (той самий код або точно та сама назва), не дублюється: оновляться заповнені поля, а кількість піде <b>приходом</b>.
      <div class="pad"><button class="btn ghost sm" id="tpl">Завантажити шаблон</button></div>
    </div>
    <div class="card"><label class="btn primary">Вибрати файл .xlsx / .csv<input type="file" id="file" accept=".xlsx,.xls,.csv,.ods" hidden></label></div>
    <div id="preview"></div>`;
  ctx.main.querySelector('#tpl').addEventListener('click', () => downloadXlsx('шаблон_складу.xlsx', [{
    name: 'Позиції',
    rows: [['Назва', 'Код', 'Категорія', 'Одиниця', 'Місце', 'Мінімум', 'Кількість', 'Примітка'],
      ['Мотор 2207 1750KV', '', 'Мотори', 'шт', 'Стелаж 1', 8, 24, ''],
      ['Дріт силіконовий 14AWG', '', 'Кабелі', 'м', 'Коробка 3', 5, 20, 'червоний']],
    widths: [30, 16, 14, 9, 14, 9, 10, 20],
  }]));

  ctx.main.querySelector('#file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let table;
    try { table = await readSheet(file); } catch (err) { return toast(`Не вдалося прочитати файл: ${err.message}`, 'err'); }
    const head = (table[0] || []).map((h) => norm(h));
    const idx = {};
    for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex((h) => names.includes(h));
    if (idx.name < 0) return toast('Не знайдено стовпця «Назва» в першому рядку', 'err', 6000);

    const rows = [];
    const errors = [];
    table.slice(1).forEach((r, n) => {
      const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
      const name = get('name');
      if (!name) return;
      const qty = idx.qty >= 0 ? parseNum(get('qty')) : null;
      const min = idx.min_qty >= 0 ? parseNum(get('min_qty')) : null;
      if (Number.isNaN(qty) || qty < 0 || Number.isNaN(min) || min < 0) { errors.push(`рядок ${n + 2}: «${name}» — неправильне число`); return; }
      const r2 = { name, code: get('code'), category: get('category'), unit: get('unit'), location: get('location'), min_qty: min, qty, note: get('note') };
      r2.existing = matchExisting(r2);
      rows.push(r2);
    });
    const nNew = rows.filter((r) => !r.existing).length;
    const pv = ctx.main.querySelector('#preview');
    pv.innerHTML = `<div class="card">
      <p>Рядків: <b>${rows.length}</b> — нових позицій <b>${nNew}</b>, вже існуючих <b>${rows.length - nNew}</b>,
         з кількістю <b>${rows.filter((r) => r.qty > 0).length}</b>.</p>
      ${errors.length ? `<div class="err-text">${errors.slice(0, 10).map(esc).join('<br>')}${errors.length > 10 ? '<br>…' : ''}</div>` : ''}
      <table class="tbl"><thead><tr><th></th><th>Назва</th><th>Код</th><th>Категорія</th><th>К-сть</th></tr></thead><tbody>
      ${rows.slice(0, 30).map((r) => `<tr><td>${r.existing ? '<small class="muted">є</small>' : '<small class="pos">нова</small>'}</td>
        <td>${esc(r.name)}</td><td>${esc(r.code)}</td><td>${esc(r.category)}</td><td>${r.qty ?? ''} ${esc(r.unit)}</td></tr>`).join('')}
      </tbody></table>${rows.length > 30 ? `<p class="muted">…і ще ${rows.length - 30}</p>` : ''}
      <div class="form-actions"><span class="grow"></span><button class="btn primary" id="go" ${rows.length ? '' : 'disabled'}>Імпортувати</button></div></div>`;

    pv.querySelector('#go').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = 'Імпорт…';
      const lines = [];
      try {
        for (const r of rows) {
          let id;
          // заново, бо після невдалої спроби частина позицій уже створена
          r.existing = matchExisting(r);
          if (r.existing) {
            id = r.existing.id;
            const patch = { id, name: r.existing.name };
            for (const k of ['code', 'category', 'unit', 'location', 'note']) if (r[k]) patch[k] = r[k];
            if (r.min_qty !== null) patch.min_qty = r.min_qty;
            await api.saveItem(patch);
          } else {
            id = await api.saveItem({ name: r.name, code: r.code, category: r.category, unit: r.unit || 'шт', location: r.location, min_qty: r.min_qty || 0, note: r.note });
            // щоб повтор тієї ж назви нижче у файлі не створив дубль
            state.items.push({ id, name: r.name, code: r.code || null });
          }
          if (r.qty > 0) lines.push({ item_id: id, qty: r.qty });
        }
        if (lines.length) await api.postOperation({ type: 'in', lines, comment: `Імпорт з Excel: ${file.name}` });
        await reloadData();
        toast(`Імпортовано: ${rows.length} позицій`);
        go('#/stock');
      } catch (err) {
        toast(`Помилка імпорту: ${err.message}`, 'err', 8000);
        await reloadData().catch(() => {});
        ev.target.disabled = false;
        ev.target.textContent = 'Імпортувати ще раз';
      }
    });
  });
}
