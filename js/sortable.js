// Перестановка перетягуванням і стрілками — спільна для «Залишків» і порядку меню
import { isDemo } from './api.js';
import { toast } from './util.js';
import { state, reloadData } from './core.js';

export const ICON_GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg>';

let drag = null;                  // триває перетягування: { after } — що зробити після відпускання
let saving = Promise.resolve();   // збереження йдуть по черзі
let failures = 0;                 // після невдачі вже поставлені в чергу збереження не відправляються

// Зміни від інших не перемальовують екран під пальцем — лише після відпускання.
// true — перетягування триває, fn викличеться після нього (останній fn з тим самим key).
export function afterDrag(key, fn) {
  if (!drag) return false;
  drag.after.set(key, fn);
  return true;
}

// Новий порядок уже на екрані; apply оновлює стан і повертає «як було», send зберігає в базі,
// redraw перемальовує екран зі стану. Без мережі порядок у чергу не ставиться.
export function commitOrder(apply, send, redraw) {
  if (!isDemo && (!navigator.onLine || state.offline)) {
    toast('Немає мережі — порядок не збережено', 'err', 5000);
    redraw();
    return;
  }
  const undo = apply();
  const mine = failures;
  saving = saving.then(() => (mine === failures ? send() : null)).catch((err) => {
    failures += 1;
    undo();
    toast(err.message, 'err', 8000);
    redraw();
    // кілька перестановок поспіль могли розійтися з базою — звіряємось
    reloadData().then(redraw, () => {});
  });
}

// Перестановка дітей box, позначених [data-sort]: перетягуванням за [data-grip]
// (Pointer Events — миша, палець, стилус) і кнопками [data-mv="-1|1"].
// Елемент, який тягнуть, у DOM не рухається (інакше браузер відпустив би вказівник) —
// місцями міняються сусіди. drop() — порядок змінився; cancel() — жест перервано.
// autoScroll — біля краю екрана сторінка прокручується сама (для списку на всю сторінку).
export function sortable(box, { horizontal = false, autoScroll = !horizontal, drop, cancel }) {
  const items = () => [...box.querySelectorAll(':scope > [data-sort]')];
  const ends = () => {
    const els = items();
    els.forEach((el, n) => {
      const [up, down] = el.querySelectorAll('[data-mv]');
      up.disabled = n === 0;
      down.disabled = n === els.length - 1;
    });
  };
  // el стає по той бік від t; усі, хто між ними, зсуваються на одне місце
  const moveTo = (el, t) => {
    if (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) {
      for (let n = el.nextElementSibling; n; n = el.nextElementSibling) { box.insertBefore(n, el); if (n === t) break; }
    } else {
      for (let n = el.previousElementSibling; n; n = el.previousElementSibling) { box.insertBefore(n, el.nextSibling); if (n === t) break; }
    }
  };
  ends();

  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mv]');
    const el = b?.closest('[data-sort]');
    if (!el || el.parentNode !== box) return;
    const els = items();
    const t = els[els.indexOf(el) + Number(b.dataset.mv)];
    if (!t) return;
    moveTo(el, t);
    ends();
    (b.disabled ? el.querySelector('[data-mv]:not(:disabled)') : b)?.focus();
    drop();
  });

  box.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    const el = grip?.closest('[data-sort]');
    if (!el || el.parentNode !== box || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const before = items();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let x = x0;
    let y = y0;
    let active = false;
    let raf = 0;
    const hit = () => {
      const r0 = box.getBoundingClientRect();
      // у списку важить лише висота: палець може зʼїхати з ручки вбік
      const t = document.elementFromPoint(horizontal ? x : r0.left + r0.width / 2, y)?.closest('[data-sort]');
      if (!t || t === el || t.parentNode !== box) return;
      const r = t.getBoundingClientRect();
      const d = el.getBoundingClientRect();
      const after = !!(el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      // сусід поступається місцем, коли вказівник перейшов його середину — інакше елементи різного розміру смикались би
      if (!horizontal && (after ? y < r.top + r.height / 2 : y > r.top + r.height / 2)) return;
      const sameLine = r.top < d.bottom && r.bottom > d.top;
      if (horizontal && sameLine && (after ? x < r.left + r.width / 2 : x > r.left + r.width / 2)) return;
      moveTo(el, t);
      ends();
    };
    // біля верхнього й нижнього краю екрана сторінка сама прокручується
    const scroll = () => {
      const zone = 110;
      const bottom = window.innerHeight - zone;
      const dy = y < zone ? -Math.min(18, (zone - y) / 5) : y > bottom ? Math.min(18, (y - bottom) / 5) : 0;
      if (active && dy) { window.scrollBy(0, dy); hit(); }
      raf = requestAnimationFrame(scroll);
    };
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
      if (!active) {
        if (Math.hypot(x - x0, y - y0) < 5) return;
        active = true;
        el.classList.add('dragging');
        if (autoScroll) raf = requestAnimationFrame(scroll);
      }
      ev.preventDefault();
      hit();
    };
    const finish = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      cancelAnimationFrame(raf);
      el.classList.remove('dragging');
      const { after } = drag;
      drag = null;
      if (active) {
        // після перетягування браузер ще надішле click — він не має вибрати категорію
        const eat = (c) => { c.stopPropagation(); c.preventDefault(); };
        box.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => box.removeEventListener('click', eat, { capture: true }), 80);
      }
      const changed = items().some((n, k) => n !== before[k]);
      if (ev.type === 'pointercancel') cancel();
      else if (changed) drop();
      for (const fn of after.values()) fn();
    };
    drag = { after: new Map() };
    try { grip.setPointerCapture(e.pointerId); } catch { /* вказівник уже відпущено */ }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    if (e.pointerType === 'mouse') e.preventDefault(); // без виділення тексту під час перетягування
  });
}
