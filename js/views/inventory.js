// Інвентаризація: вводимо фактичну кількість, програма проводить різницю
import { esc, fmtQty, fmtSigned, parseNum, round, toast, confirmDialog } from '../util.js';
import { state, reloadData, activeItems, categories, locations, searchItems, findByCode, ICON_SCAN } from '../core.js';
import { scanCode } from '../scanner.js';
import { postOrQueue } from '../outbox.js';

// чернетка підрахунку живе в браузері, щоб довгий перерахунок пережив перезавантаження
const DRAFT = 'sklad-inventory-draft';
const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT)) || {}; } catch { return {}; } };
const saveDraft = (d) => { try { localStorage.setItem(DRAFT, JSON.stringify(d)); } catch { /* */ } };
const f = { q: '', cat: '', loc: '', onlyCounted: false };

export function viewInventory(ctx) {
  ctx.header({ title: 'Інвентаризація' });
  const draft = loadDraft();
  ctx.main.innerHTML = `
    <div class="card hint">Порахуйте фактичну кількість і впишіть її. Незаповнені рядки не змінюються.
      Після «Провести» залишки стануть такими, як ви порахували, а різниця запишеться в журнал.</div>
    <div class="toolbar">
      <div class="search"><input type="search" id="q" placeholder="Пошук або код" value="${esc(f.q)}"></div>
      <button class="icon-btn big" id="scan" aria-label="Сканувати">${ICON_SCAN}</button>
    </div>
    <div class="toolbar">
      <select id="cat"><option value="">Усі категорії</option>${categories().map((c) => `<option ${f.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="loc"><option value="">Усі місця</option>${locations().map((c) => `<option ${f.loc === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="only" ${f.onlyCounted ? 'checked' : ''}> лише пораховані</label>
    </div>
    <div id="rows" class="inv"></div>
    <div class="bottom-actions inv-actions">
      <span id="stat" class="muted"></span><span class="grow"></span>
      <button class="btn ghost" id="clear">Очистити</button>
      <button class="btn primary" id="post">Провести</button>
    </div>`;
  const rowsEl = ctx.main.querySelector('#rows');

  const diffHtml = (it, v) => {
    const fact = parseNum(v);
    if (fact === null || Number.isNaN(fact)) return '';
    const d = round(fact - it.qty);
    return d === 0 ? '<span class="pos">✓</span>' : `<b class="${d > 0 ? 'pos' : 'neg'}">${fmtSigned(d)}</b>`;
  };
  const stat = () => {
    const ids = Object.keys(draft).filter((id) => state.byId.has(id) && parseNum(draft[id]) !== null);
    const diffs = ids.filter((id) => round(parseNum(draft[id]) - state.byId.get(id).qty) !== 0).length;
    ctx.main.querySelector('#stat').textContent = `Пораховано: ${ids.length}, розбіжностей: ${diffs}`;
  };
  const render = () => {
    let list = activeItems();
    if (f.cat) list = list.filter((i) => i.category === f.cat);
    if (f.loc) list = list.filter((i) => i.location === f.loc);
    if (f.onlyCounted) list = list.filter((i) => draft[i.id] !== undefined && draft[i.id] !== '');
    list = searchItems(f.q, list);
    rowsEl.innerHTML = list.length ? list.map((i) => `
      <div class="inv-row" data-id="${i.id}">
        <div class="line-name"><b>${esc(i.name)}</b><small class="muted">${[i.code, i.location].filter(Boolean).map(esc).join(' · ')}</small></div>
        <div class="inv-book"><small class="muted">облік</small>${fmtQty(i.qty)}</div>
        <input class="qty" inputmode="decimal" placeholder="факт" value="${esc(draft[i.id] ?? '')}" aria-label="Фактична кількість">
        <span class="unit">${esc(i.unit)}</span>
        <div class="inv-diff">${diffHtml(i, draft[i.id])}</div>
      </div>`).join('') : '<div class="empty-state"><p>Нічого не знайдено</p></div>';
    stat();
  };
  render();

  rowsEl.addEventListener('input', (e) => {
    if (!e.target.classList.contains('qty')) return;
    const row = e.target.closest('.inv-row');
    const id = row.dataset.id;
    if (e.target.value.trim() === '') delete draft[id]; else draft[id] = e.target.value;
    saveDraft(draft);
    row.querySelector('.inv-diff').innerHTML = diffHtml(state.byId.get(id), draft[id]);
    stat();
  });
  rowsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList.contains('qty')) return;
    e.preventDefault();
    const all = [...rowsEl.querySelectorAll('.qty')];
    all[all.indexOf(e.target) + 1]?.focus();
  });
  const focusItem = (item) => {
    f.q = ''; f.cat = ''; f.loc = ''; f.onlyCounted = false;
    ctx.main.querySelector('#q').value = '';
    ctx.main.querySelector('#cat').value = '';
    ctx.main.querySelector('#loc').value = '';
    ctx.main.querySelector('#only').checked = false;
    render();
    const inp = rowsEl.querySelector(`[data-id="${item.id}"] .qty`);
    inp?.scrollIntoView({ block: 'center' });
    inp?.focus();
  };
  const q = ctx.main.querySelector('#q');
  q.addEventListener('input', () => { f.q = q.value; render(); });
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const it = findByCode(q.value);
    if (it) focusItem(it);
  });
  ctx.main.querySelector('#scan').addEventListener('click', async () => {
    const code = await scanCode();
    if (!code) return;
    const it = findByCode(code);
    if (it) focusItem(it); else toast(`Код «${code}» не знайдено`, 'err');
  });
  ctx.main.querySelector('#cat').addEventListener('change', (e) => { f.cat = e.target.value; render(); });
  ctx.main.querySelector('#loc').addEventListener('change', (e) => { f.loc = e.target.value; render(); });
  ctx.main.querySelector('#only').addEventListener('change', (e) => { f.onlyCounted = e.target.checked; render(); });
  ctx.main.querySelector('#clear').addEventListener('click', async () => {
    if (!Object.keys(draft).length) return;
    if (!await confirmDialog('Стерти всі введені цифри підрахунку?', { ok: 'Стерти', danger: true })) return;
    for (const k of Object.keys(draft)) delete draft[k];
    saveDraft(draft);
    render();
  });
  ctx.main.querySelector('#post').addEventListener('click', async () => {
    const lines = [];
    for (const [id, v] of Object.entries(draft)) {
      if (!state.byId.has(id)) continue;
      const fact = parseNum(v);
      if (fact === null) continue;
      if (Number.isNaN(fact) || fact < 0) return toast(`Неправильне число для «${state.byId.get(id).name}»`, 'err');
      lines.push({ item_id: id, qty: fact });
    }
    if (!lines.length) return toast('Нічого не пораховано', 'err');
    const diffs = lines.filter((l) => round(l.qty - state.byId.get(l.item_id).qty) !== 0).length;
    if (!await confirmDialog(`Провести інвентаризацію: ${lines.length} позицій, розбіжностей ${diffs}?`, { ok: 'Провести' })) return;
    try {
      const r = await postOrQueue({ type: 'adjust', lines, comment: 'Інвентаризація' });
      localStorage.removeItem(DRAFT);
      for (const k of Object.keys(draft)) delete draft[k];
      if (r.queued) toast('Немає інтернету — збережено на пристрої, відправиться з появою мережі', 'ok', 6000);
      else { await reloadData(); toast('Інвентаризацію проведено'); }
      render();
    } catch (err) { toast(err.message, 'err', 6000); }
  });
}
