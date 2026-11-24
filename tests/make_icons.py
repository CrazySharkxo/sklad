"""Генерує icons/icon-192.png і icon-512.png з SVG через headless Edge/Chromium.

    python tests/make_icons.py
"""
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
# коробка на синьому тлі; поля ~20% — щоб і «maskable»-обрізка Android не з'їла малюнок
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="{s}" height="{s}">
  <rect width="100" height="100" fill="#1d4ed8"/>
  <g fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    <path d="M50 24 L74 37 L74 63 L50 76 L26 63 L26 37 Z"/>
    <path d="M26 37 L50 50 L74 37 M50 50 L50 76"/>
    <path d="M38 30.5 L62 43.5" opacity=".75"/>
  </g>
</svg>"""


def main() -> None:
    (ROOT / "icons").mkdir(exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge")
        for s in (192, 512):
            pg = b.new_page(viewport={"width": s, "height": s})
            pg.set_content(f"<html><body style='margin:0'>{SVG.format(s=s)}</body></html>")
            pg.screenshot(path=str(ROOT / "icons" / f"icon-{s}.png"), clip={"x": 0, "y": 0, "width": s, "height": s})
        b.close()


if __name__ == "__main__":
    main()
