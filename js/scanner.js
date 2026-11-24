// Сканер штрих- і QR-кодів камерою.
// Android Chrome має вбудований BarcodeDetector; на Windows — ZXing.
// У тому ж вікні можна ввести код руками або USB-сканером (він «друкує» код + Enter).
import { esc } from './util.js';

const NATIVE_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'code_93', 'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix'];

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

export function scanCode({ title = 'Сканування коду' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap scan-wrap';
    wrap.innerHTML = `<div class="modal scan" role="dialog" aria-modal="true">
      <div class="modal-head"><b>${esc(title)}</b><button class="icon-btn" data-close aria-label="Закрити">✕</button></div>
      <div class="scan-view"><video playsinline muted></video><div class="scan-frame"></div>
        <div class="scan-status">Запуск камери…</div></div>
      <form class="scan-manual">
        <input name="code" placeholder="або введіть / відскануйте USB-сканером" autocomplete="off">
        <button class="btn primary">OK</button>
      </form></div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video');
    const status = wrap.querySelector('.scan-status');
    const input = wrap.querySelector('input');
    let stream = null, zx = null, stopped = false, timer = null;

    const finish = (code) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (zx) try { zx.reset(); } catch { /* */ }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (code && navigator.vibrate) navigator.vibrate(60);
      resolve(code ? String(code).trim() : null);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('[data-close]').onclick = () => finish(null);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
    wrap.querySelector('form').onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) finish(input.value); };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        status.textContent = 'Камера недоступна (потрібне https-зʼєднання). Введіть код вручну.';
        input.focus();
        return;
      }
      const det = await nativeDetector();
      try {
        if (det) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
          if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
          video.srcObject = stream;
          await video.play();
          status.textContent = 'Наведіть камеру на код';
          const loop = async () => {
            if (stopped) return;
            try {
              const codes = await det.detect(video);
              if (codes.length) return finish(codes[0].rawValue);
            } catch { /* кадр ще не готовий */ }
            timer = setTimeout(loop, 120);
          };
          loop();
        } else if (window.ZXing) {
          const hints = new Map();
          hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
          zx = new window.ZXing.BrowserMultiFormatReader(hints);
          await zx.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video, (res) => {
            if (res) finish(res.getText());
          });
          if (stopped) { try { zx.reset(); } catch { /* */ } return; }
          status.textContent = 'Наведіть камеру на код';
        } else {
          status.textContent = 'Сканер недоступний. Введіть код вручну.';
        }
      } catch (err) {
        status.textContent = err?.name === 'NotAllowedError'
          ? 'Доступ до камери заборонено. Дозвольте його в налаштуваннях браузера або введіть код вручну.'
          : err?.name === 'NotFoundError' ? 'Камеру не знайдено. Введіть код вручну.' : `Камера: ${err?.message || err}`;
        input.focus();
      }
    })();
  });
}
