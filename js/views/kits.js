// Комплекти (специфікації): «1 виріб = N компонентів», видача списує все разом
import { api } from '../api.js';
import { esc, fmtQty, parseNum, round, toast, confirmDialog, compressImage } from '../util.js';
import { state, go, reloadData, itemPicker, kitCapacity, hydratePhotos, thumb, ICON_PLUS, can } from '../core.js';
import { postOrQueue } from '../outbox.js';

export function viewKits(ctx) {
  ctx.header({ title: 'Комплекти', actions: can('kits.edit') ? `<a class="btn primary sm" href="#/kit-edit/new">${ICON_PLUS}<span>Комплект</span></a>` : '' });
  const kits = state.kits.filter((k) => !k.archived);
  ctx.main.innerHTML = kits.length ? `<div class="list">${kits.map((k) => {
    const cap = kitCapacity(k);
    return `<a class="row" href="#/kit/${k.id}">
      ${thumb(k.photo_path)}
      <div class="row-main"><div class="row-title">${esc(k.name)}</div>
        <div class="row-meta">${k.components.length} компонент(ів)${k.note ? ' · ' + esc(k.note) : ''}</div></div>
      <div class="row-qty${cap === 0 ? ' low' : ''}"><b>${cap}</b><small>можна видати</small></div>
    </a>`;
  }).join('')}</div>` : `<div class="empty-state">
      <p>Комплект — це виріб зі складових, напр. «Дрон 7"» = 4 мотори + 1 польотник + 1 камера…</p>
      <p>Видача комплекту одним рухом списує всі компоненти, а тут видно, скільки виробів можна зібрати із залишків.</p>
      ${can('kits.edit') ? '<p><a class="btn primary" href="#/kit-edit/new">Створити комплект</a></p>' : ''}</div>`;
  hydratePhotos(ctx.main);
}

export function viewKit(ctx, id) {
  const kit = state.kits.find((k) => k.id === id);
  if (!kit) { ctx.notFound(); return; }
  ctx.header({ title: kit.name, back: '#/kits', actions: can('kits.edit') ? `<a class="btn ghost sm" href="#/kit-edit/${id}">Редагувати</a>` : '' });
  const cap = kitCapacity(kit);

  ctx.main.innerHTML = `
    ${kit.photo_path || kit.note ? `<div class="card item-card">${kit.photo_path ? `<div class="item-photo">${thumb(kit.photo_path, 'photo')}</div>` : ''}
      ${kit.note ? `<p class="note">${esc(kit.note)}</p>` : ''}</div>` : ''}
    <div class="card">
      <div class="kit-issue">
        <div>Із залишків можна видати: <b class="${cap ? 'pos' : 'neg'}">${cap}</b></div>
        <form id="issue" class="issue-form" autocomplete="off">
          <input name="n" inputmode="numeric" value="1" aria-label="Скільки комплектів">
          ${can('ops.edit') ? `<input name="counterparty" placeholder="Кому / для чого">
          <button class="btn out">Видати комплекти</button>` : ''}
        </form>
      </div>
      <table class="tbl" id="tbl"></table>
    </div>`;
  hydratePhotos(ctx.main);
  const tbl = ctx.main.querySelector('#tbl');
  const form = ctx.main.querySelector('#issue');

  const renderTable = () => {
    const n = Math.max(0, parseNum(form.n.value) || 0);
    tbl.innerHTML = `<thead><tr><th>Компонент</th><th>на 1</th><th>потрібно</th><th>на складі</th></tr></thead><tbody>
      ${kit.components.map((c) => {
        const it = state.byId.get(c.item_id);
        const need = round(c.qty * n);
        const ok = it && it.qty >= need;
        return `<tr class="${ok ? '' : 'bad'}"><td><a href="#/item/${c.item_id}">${esc(it?.name || '?')}</a></td>
          <td>${fmtQty(c.qty)} ${esc(it?.unit || '')}</td><td>${fmtQty(need)}</td>
          <td>${fmtQty(it?.qty || 0)}${ok ? '' : ` <small class="err-text">бракує ${fmtQty(need - (it?.qty || 0))}</small>`}</td></tr>`;
      }).join('')}</tbody>`;
  };
  renderTable();
  form.n.addEventListener('input', renderTable);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!can('ops.edit')) return;
    const n = parseNum(form.n.value);
    if (!(n > 0)) return toast('Вкажіть кількість комплектів', 'err');
    if (!await confirmDialog(`Видати ${fmtQty(n)} × «${kit.name}»? Буде списано всі компоненти.`, { ok: 'Видати' })) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const r = await postOrQueue({ type: 'kit_out', kit_id: id, kit_qty: n, counterparty: form.counterparty.value.trim() });
      if (r.queued) toast('Немає інтернету — збережено на пристрої, відправиться з появою мережі', 'ok', 6000);
      else { await reloadData(); toast('Комплекти видано'); }
      viewKit(ctx, id);
    } catch (err) {
      toast(err.message, 'err', 6000);
      btn.disabled = false;
    }
  });
}

export function viewKitEdit(ctx, id) {
  const isNew = id === 'new';
  const kit = isNew ? { name: '', note: '', photo_path: null, components: [] } : state.kits.find((k) => k.id === id);
  if (!kit) { ctx.notFound(); return; }
  ctx.header({ title: isNew ? 'Новий комплект' : 'Редагування комплекту', back: isNew ? '#/kits' : `#/kit/${id}` });
  const comps = kit.components.map((c) => ({ item_id: c.item_id, qty: fmtQty(c.qty) }));
  let newPhoto = null;
  let photoPath = kit.photo_path;

  ctx.main.innerHTML = `
    <form class="form card" id="f" autocomplete="off">
      <label class="field"><span>Назва комплекту *</span><input name="name" required value="${esc(kit.name)}" placeholder='Напр. Дрон 7" у зборі'></label>
      <label class="field"><span>Примітка</span><input name="note" value="${esc(kit.note)}"></label>
      <div class="photo-edit">
        <div class="photo-box" id="pbox">${thumb(photoPath, 'photo')}</div>
        <div class="photo-btns"><label class="btn ghost sm">Фото<input type="file" accept="image/*" hidden id="pin"></label></div>
      </div>
      <h3>Склад (на 1 комплект)</h3>
      <div id="picker"></div>
      <div id="lines" class="lines"></div>
      ${!isNew ? `<label class="check"><input type="checkbox" name="archived" ${kit.archived ? 'checked' : ''}> В архіві</label>` : ''}
      <div class="form-actions">
        ${!isNew && can('kits.delete') ? '<button type="button" class="btn danger ghost" id="del">Видалити</button>' : ''}
        <span class="grow"></span>
        <a class="btn ghost" href="${isNew ? '#/kits' : `#/kit/${id}`}">Скасувати</a>
        <button class="btn primary" id="save">Зберегти</button>
      </div>
    </form>`;
  hydratePhotos(ctx.main);
  const f = ctx.main.querySelector('#f');
  const linesEl = ctx.main.querySelector('#lines');
  const render = (focus = -1) => {
    linesEl.innerHTML = comps.length ? comps.map((c, n) => {
      const it = state.byId.get(c.item_id);
      return `<div class="line" data-n="${n}"><div class="line-name"><b>${esc(it?.name || '?')}</b></div>
        <input class="qty" inputmode="decimal" value="${esc(c.qty)}" placeholder="к-сть"><span class="unit">${esc(it?.unit || '')}</span>
        <button type="button" class="icon-btn" data-rm aria-label="Прибрати">✕</button></div>`;
    }).join('') : '<div class="muted pad center">Додайте компоненти</div>';
    if (focus >= 0) linesEl.querySelectorAll('.qty')[focus]?.focus();
  };
  render();
  itemPicker(ctx.main.querySelector('#picker'), (item) => {
    const i = comps.findIndex((c) => c.item_id === item.id);
    if (i >= 0) return render(i);
    comps.push({ item_id: item.id, qty: '1' });
    render(comps.length - 1);
  }, { placeholder: 'Додати компонент…', showQty: false });
  linesEl.addEventListener('input', (e) => { if (e.target.classList.contains('qty')) comps[+e.target.closest('.line').dataset.n].qty = e.target.value; });
  linesEl.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { comps.splice(+e.target.closest('.line').dataset.n, 1); render(); } });
  ctx.main.querySelector('#pin').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    newPhoto = await compressImage(file);
    ctx.main.querySelector('#pbox').innerHTML = `<img class="photo" src="${URL.createObjectURL(newPhoto)}" alt="">`;
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = [];
    for (const c of comps) {
      const q = parseNum(c.qty);
      if (!(q > 0)) return toast(`Кількість для «${state.byId.get(c.item_id)?.name}» має бути більше 0`, 'err');
      out.push({ item_id: c.item_id, qty: q });
    }
    if (!out.length) return toast('Додайте хоча б один компонент', 'err');
    const btn = f.querySelector('#save');
    btn.disabled = true;
    try {
      if (newPhoto) photoPath = await api.uploadPhoto(newPhoto);
      const saved = await api.saveKit({ id: isNew ? undefined : id, name: f.name.value, note: f.note.value, photo_path: photoPath, archived: !isNew && f.archived.checked }, out);
      if (kit.photo_path && kit.photo_path !== photoPath) api.removePhoto(kit.photo_path);
      await reloadData();
      toast('Комплект збережено');
      go(`#/kit/${saved}`);
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });
  ctx.main.querySelector('#del')?.addEventListener('click', async () => {
    if (!await confirmDialog(`Видалити комплект «${kit.name}»? Компоненти на складі не зміняться.`, { ok: 'Видалити', danger: true })) return;
    try {
      await api.deleteKit(id);
      await reloadData();
      go('#/kits');
    } catch (err) { toast(err.message, 'err'); }
  });
}
