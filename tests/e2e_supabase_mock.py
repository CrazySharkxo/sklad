"""Перевірка Supabase-режиму без сервера: API Supabase підмінено в браузері.

Перевіряє: екран входу → вхід → завантаження (stock/kits/profiles) → створення позиції
з початковою кількістю → виклик rpc/post_operation з тими самими іменами параметрів,
що оголошені в supabase/schema.sql.
"""
import base64
import functools
import http.server
import json
import pathlib
import re
import socketserver
import sys
import threading
import time

from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAKE = "https://fake-project.supabase.co"
UID = "11111111-1111-1111-1111-111111111111"


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


def main() -> int:
    httpd, url = serve()
    exp = int(time.time()) + 3600
    jwt = f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64({'sub': UID, 'exp': exp, 'role': 'authenticated', 'email': 'ivan@example.com'})}.sig"
    session = {"access_token": jwt, "token_type": "bearer", "expires_in": 3600, "expires_at": exp, "refresh_token": "r",
               "user": {"id": UID, "aud": "authenticated", "role": "authenticated", "email": "ivan@example.com",
                        "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}}
    calls = []
    items = []

    def handle(route):
        req = route.request
        path = req.url[len(FAKE):]
        calls.append((req.method, path, req.post_data))
        if path.startswith("/auth/v1/token"):
            body = json.loads(req.post_data or "{}")
            if body.get("password") != "secret1":
                return route.fulfill(status=400, json={"error": "invalid_grant", "error_description": "Invalid login credentials", "msg": "Invalid login credentials"})
            return route.fulfill(json=session)
        if path.startswith("/rest/v1/stock"):
            return route.fulfill(json=items)
        if path.startswith(("/rest/v1/kits", "/rest/v1/operations", "/rest/v1/orders")):
            return route.fulfill(json=[])
        if path.startswith("/rest/v1/departments"):
            return route.fulfill(json=[{"id": "dddddddd-0000-0000-0000-000000000001", "name": "Тестування"}])
        if path.startswith("/rest/v1/profiles"):
            return route.fulfill(json=[{"id": UID, "display_name": "ivan", "department_id": None}])
        if path.startswith("/rest/v1/items") and req.method == "POST":
            row = json.loads(req.post_data)
            row = row[0] if isinstance(row, list) else row
            new = {"id": "aaaaaaaa-0000-0000-0000-000000000001", **row, "qty": 0, "archived": False, "photo_path": None}
            items.append(new)
            return route.fulfill(json={"id": new["id"]}, headers={"content-type": "application/vnd.pgrst.object+json"})
        if path.startswith("/rest/v1/rpc/post_operation"):
            items[0]["qty"] = json.loads(req.post_data)["p_lines"][0]["qty"]
            return route.fulfill(json="bbbbbbbb-0000-0000-0000-000000000001")
        if path.startswith("/rest/v1/movements"):
            return route.fulfill(json=[])
        return route.fulfill(status=404, json={"message": f"unmocked {path}"})

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": 400, "height": 860})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.route(re.compile(r".*/js/config\.js$"), lambda r: r.fulfill(
            content_type="text/javascript",
            body=f"export const SUPABASE_URL = '{FAKE}';\nexport const SUPABASE_ANON_KEY = 'anon-test-key';\n"))
        page.route(f"{FAKE}/**", handle)
        page.route(re.compile(r"^wss?://fake-project.*"), lambda r: r.abort())

        page.goto(url)
        expect(page.locator(".login")).to_be_visible()
        page.screenshot(path=str(ROOT / "tests" / "shots" / "11_login.png"))
        page.fill("[name=email]", "ivan@example.com")
        page.fill("[name=password]", "wrong")
        page.click(".login button")
        expect(page.locator(".toast.err")).to_have_text("Невірний email або пароль")
        page.fill("[name=password]", "secret1")
        page.click(".login button")
        expect(page.locator(".empty-state")).to_contain_text("Склад порожній")
        assert page.locator(".banner.demo").count() == 0

        page.goto(url + "#/item-edit/new")
        page.fill("[name=name]", "Мотор")
        page.fill("[name=init_qty]", "5")
        page.click("#save")
        expect(page.locator(".big-qty b")).to_have_text("5")

        rpc = [c for c in calls if "/rpc/post_operation" in c[1]]
        assert rpc, "post_operation не викликано"
        params = set(json.loads(rpc[0][2]).keys())
        sql = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
        sig = re.search(r"function public\.post_operation\((.*?)\) returns", sql, re.S).group(1)
        declared = set(re.findall(r"\b(p_\w+)\s", sig))
        assert params == declared, f"параметри rpc {params} != SQL {declared}"
        # move_order: імена параметрів у api.js збігаються з SQL
        js = (ROOT / "js" / "api.js").read_text(encoding="utf-8")
        used = set(re.findall(r"\b(p_\w+):", re.search(r"rpc\('move_order', \{(.*?)\}\)", js, re.S).group(1)))
        sig2 = re.search(r"function public\.move_order\((.*?)\) returns", sql, re.S).group(1)
        assert used == set(re.findall(r"\b(p_\w+)\s", sig2)), f"move_order {used}"
        hdr = [c for c in calls if c[1].startswith("/rest/v1/items")][0]
        assert json.loads(hdr[2]).get("name") == "Мотор"
        browser.close()
    httpd.shutdown()
    if errors:
        print("\n".join(errors))
        return 1
    print("SUPABASE MOCK OK; rpc params:", sorted(params))
    return 0


if __name__ == "__main__":
    sys.exit(main())
