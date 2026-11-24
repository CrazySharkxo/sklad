// Дрібні допоміжні функції без стану

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 });
export const fmtQty = (n) => nf.format(Number(n) || 0);
export const fmtSigned = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + nf.format(Math.abs(n));

export function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

export const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// приймає і кому, і крапку; '' → null
export function parseNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().replace(/\s/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

// округлення до 6 знаків, щоб 0.1+0.2 не давало хвостів
export const round = (n) => Math.round(n * 1e6) / 1e6;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').trim();

export const OP_TYPES = {
  in: { label: 'Прихід', cls: 'in' },
  out: { label: 'Видаток', cls: 'out' },
  adjust: { label: 'Інвентаризація', cls: 'adj' },
  kit_out: { label: 'Видача комплекту', cls: 'kit' },
};

export const ORDER_STATUS = {
  new: { label: 'Нове', cls: 'st-new' },
  in_work: { label: 'В роботі', cls: 'st-work' },
  testing: { label: 'На тестуванні', cls: 'st-test' },
  rework: { label: 'На доопрацюванні', cls: 'st-rework' },
  done: { label: 'Готово', cls: 'st-done' },
  shipped: { label: 'Відвантажено', cls: 'st-closed' },
  cancelled: { label: 'Скасовано', cls: 'st-closed' },
};
export const statusTag = (s) => {
  const m = ORDER_STATUS[s] || { label: s, cls: '' };
  return `<span class="tag ${m.cls}">${m.label}</span>`;
};

// ------------------------------------------------------------------
// Фото: стискаємо на пристрої, щоб не гнати мегабайти мобільним інтернетом
// ------------------------------------------------------------------
export async function compressImage(file, maxSide = 1280, quality = 0.82) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не вдалося прочитати зображення'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width, h = bmp.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

// ------------------------------------------------------------------
// Повідомлення і діалоги
// ------------------------------------------------------------------
export function toast(text, kind = 'ok', ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  // не більше двох одночасно — швидка робота не повинна засипати екран
  while (box.children.length >= 2) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add('hide'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

export function confirmDialog(text, { ok = 'Так', cancel = 'Скасувати', danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal small" role="dialog" aria-modal="true">
      <p class="confirm-text"></p>
      <div class="modal-actions">
        <button class="btn ghost" data-r="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button>
      </div></div>`;
    wrap.querySelector('.confirm-text').textContent = text;
    const done = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-r="1"]').focus();
  });
}

export function promptDialog(title, value = '', { ok = 'Зберегти', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal small" role="dialog" aria-modal="true">
      <label class="field"><span></span><input name="v" autocomplete="off"></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-cancel>Скасувати</button>
        <button class="btn primary">${esc(ok)}</button>
      </div></form>`;
    const form = wrap.querySelector('form');
    form.querySelector('span').textContent = title;
    const inp = form.querySelector('input');
    inp.value = value;
    inp.placeholder = placeholder;
    const done = (v) => { wrap.remove(); resolve(v); };
    form.addEventListener('submit', (e) => { e.preventDefault(); done(inp.value.trim()); });
    form.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    document.body.appendChild(wrap);
    inp.focus();
    inp.select();
  });
}

// ------------------------------------------------------------------
// Excel
// ------------------------------------------------------------------
export function downloadXlsx(filename, sheets) {
  const wb = window.XLSX.utils.book_new();
  for (const { name, rows, widths } of sheets) {
    const ws = window.XLSX.utils.aoa_to_sheet(rows);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    window.XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  window.XLSX.writeFile(wb, filename);
}

export async function readSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
}

// ------------------------------------------------------------------
// QR-код як SVG (для етикеток)
// ------------------------------------------------------------------
export function qrSvg(text, cell = 4) {
  const qr = window.qrcode(0, 'M');
  qr.addData(unescape(encodeURIComponent(text)));
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 0, scalable: true });
}

// що зашито в етикетку: код позиції, а якщо його нема — внутрішній id
export const labelPayload = (item) => (item.code ? item.code : `SKL:${item.id}`);
