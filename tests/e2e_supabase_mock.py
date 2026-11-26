"""Перевірка Supabase-режиму без сервера: API Supabase підмінено в браузері.

Перевіряє: екран входу → вхід → завантаження (stock/kits/profiles) → створення позиції
з початковою кількістю → виклик rpc/post_operation з тими самими іменами параметрів,
що оголошені в supabase/schema.sql.

Порядок позицій і категорій: новий застосунок на базі зі СТАРОЮ схемою (без sort_order,
category_order і функцій порядку) працює як раніше, а спроба змінити порядок дає
зрозуміле повідомлення; на новій схемі порядок зберігається одним викликом rpc;
без мережі зміна не ставиться в чергу.
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
    db = {"new_schema": False, "category_order": []}

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
            rows = sorted(items, key=lambda r: r["name"])  # застосунок просить order=name
            if not db["new_schema"]:
                rows = [{k: v for k, v in r.items() if k != "sort_order"} for r in rows]
            return route.fulfill(json=rows)
        if path.startswith("/rest/v1/app_settings"):
            row = {"org_name": "ТОВ Мок", "app_url": "", "backup_at": None}
            if "category_order" in path:
                if not db["new_schema"]:
                    return route.fulfill(status=400, json={"code": "42703", "details": None, "hint": None,
                                                           "message": "column app_settings.category_order does not exist"})
                row["category_order"] = db["category_order"]
            return route.fulfill(json=[row])
        if path.startswith(("/rest/v1/rpc/set_item_order", "/rest/v1/rpc/set_category_order")):
            fn = path.split("/rpc/")[1].split("?")[0]
            arg = "p_ids" if fn == "set_item_order" else "p_names"
            if not db["new_schema"]:  # так PostgREST відповідає про функцію, якої немає в базі
                return route.fulfill(status=404, json={
                    "code": "PGRST202", "hint": None,
                    "details": f"Searched for the function public.{fn} with parameter {arg} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.",
                    "message": f"Could not find the function public.{fn}({arg}) in the schema cache"})
            body = json.loads(req.post_data)
            if fn == "set_item_order":
                for n, item_id in enumerate(body["p_ids"]):
                    next(r for r in items if r["id"] == item_id)["sort_order"] = n + 1
            else:
                db["category_order"] = body["p_names"]
            return route.fulfill(status=204, body="")
        if path.startswith(("/rest/v1/kits", "/rest/v1/operations", "/rest/v1/orders")):
            return route.fulfill(json=[])
        if path.startswith("/rest/v1/departments"):
            return route.fulfill(json=[{"id": "dddddddd-0000-0000-0000-000000000001", "name": "Тестування"}])
        if path.startswith("/rest/v1/rpc/my_perms"):
            return route.fulfill(json=["admin"])
        if path.startswith("/rest/v1/roles"):
            return route.fulfill(json=[{"id": "r1", "name": "Адміністратор", "perms": ["admin"]}])
        if path.startswith("/rest/v1/rpc/purge_trash"):
            return route.fulfill(json=[])
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
        ctx = browser.new_context(viewport={"width": 400, "height": 860}, service_workers="block")  # без SW: він обходить page.route
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

        # ---------- порядок: новий застосунок на базі зі старою схемою ----------
        titles = lambda: page.locator("#list .row-title").all_inner_texts()
        cat_chips = lambda: page.eval_on_selector_all("#chips [data-cat]", "els => els.map((e) => e.dataset.cat).filter(Boolean)")
        order_rpc = lambda fn: [json.loads(c[2]) for c in calls if f"/rpc/{fn}" in c[1]]
        items[0].update(category="Мотори", sort_order=1)
        items.append({"id": "aaaaaaaa-0000-0000-0000-000000000002", "name": "Антена", "code": None, "category": "Антени",
                      "unit": "шт", "location": "", "min_qty": 0, "note": "", "qty": 2, "archived": False,
                      "photo_path": None, "sort_order": 2})
        motor, antenna = items[0]["id"], items[1]["id"]

        def reload():  # сесію мок між завантаженнями не тримає — входимо знову
            page.reload()
            page.locator(".login, #list").first.wait_for()
            if page.locator(".login").count():
                page.fill("[name=email]", "ivan@example.com")
                page.fill("[name=password]", "secret1")
                page.click(".login button")

        page.goto(url + "#/stock")
        reload()
        expect(page.locator("#list a.row")).to_have_count(2)
        assert titles() == ["Антена", "Мотор"], titles()            # як раніше — за назвою
        assert cat_chips() == ["Антени", "Мотори"], cat_chips()     # і категорії за абеткою
        st = [c[1] for c in calls if c[1].startswith("/rest/v1/app_settings")][-2:]
        assert "category_order" in st[0] and "category_order" not in st[1], st  # без колонки — читаємо по-старому
        page.locator("[data-order]").click()
        page.locator(".sort-row").first.locator("[data-mv='1']").click()
        expect(page.locator(".toast.err")).to_contain_text("Оновіть базу (schema.sql)")
        expect(page.locator("#top h1")).to_have_text("Залишки — порядок")
        expect(page.locator(".sort-row .row-title").first).to_have_text("Антена")  # повернулось як було
        assert titles() == ["Антена", "Мотор"], titles()
        assert order_rpc("set_item_order") == [{"p_ids": [motor, antenna]}], order_rpc("set_item_order")
        page.locator(".sort-chip").first.locator("[data-mv='1']").click()
        expect(page.locator(".toast.err").last).to_contain_text("Оновіть базу (schema.sql)")
        expect(page.locator(".sort-chip").first).to_have_attribute("data-cat", "Антени")
        assert order_rpc("set_category_order") == [{"p_names": ["Мотори", "Антени"]}]
        page.screenshot(path=str(ROOT / "tests" / "shots" / "31_order_old_schema.png"))
        page.locator("[data-done]").click()
        page.locator("#list a.row").first.click()
        expect(page.locator("#top h1")).to_have_text("Антена")     # решта програми працює

        # ---------- та сама база після запуску нового schema.sql ----------
        db["new_schema"] = True
        db["category_order"] = ["Мотори", "Антени"]
        calls.clear()
        page.goto(url + "#/stock")
        reload()
        expect(page.locator("#list a.row")).to_have_count(2)
        assert titles() == ["Мотор", "Антена"], titles()            # збережений порядок, а не назва
        assert cat_chips() == ["Мотори", "Антени"], cat_chips()
        page.locator("[data-order]").click()
        page.locator(".sort-row").last.locator("[data-mv='-1']").click()
        expect(page.locator(".sort-row .row-title").first).to_have_text("Антена")
        page.locator(".sort-chip").last.locator("[data-mv='-1']").click()
        expect(page.locator(".sort-chip").first).to_have_attribute("data-cat", "Антени")
        for _ in range(50):  # збереження йдуть по черзі, вже після оновлення екрана
            if order_rpc("set_category_order"):
                break
            page.wait_for_timeout(100)
        assert order_rpc("set_item_order") == [{"p_ids": [antenna, motor]}], order_rpc("set_item_order")
        assert order_rpc("set_category_order") == [{"p_names": ["Антени", "Мотори"]}]
        assert page.locator(".toast.err").count() == 0 or "Оновіть" not in page.locator(".toast.err").last.inner_text()
        # імена параметрів у api.js збігаються з SQL
        for fn, arg in (("set_item_order", "p_ids"), ("set_category_order", "p_names")):
            sig3 = re.search(rf"function public\.{fn}\((.*?)\)\s+returns", sql, re.S).group(1)
            assert set(re.findall(r"\b(p_\w+)\s", sig3)) == {arg}, (fn, sig3)

        # без мережі зміна порядку не ставиться в чергу: повідомлення, порядок як був, запиту немає
        ctx.set_offline(True)
        page.locator(".sort-row").first.locator("[data-mv='1']").click()
        expect(page.locator(".toast.err").last).to_have_text("Немає мережі — порядок не збережено")
        expect(page.locator(".sort-row .row-title").first).to_have_text("Антена")
        assert len(order_rpc("set_item_order")) == 1
        ctx.set_offline(False)
        reload()
        expect(page.locator("#list a.row")).to_have_count(2)
        assert titles() == ["Антена", "Мотор"] and cat_chips() == ["Антени", "Мотори"], (titles(), cat_chips())  # збережене пережило перезавантаження
        assert len(order_rpc("set_item_order")) == 1
        browser.close()
    httpd.shutdown()
    if errors:
        print("\n".join(errors))
        return 1
    print("SUPABASE MOCK OK; rpc params:", sorted(params))
    return 0


if __name__ == "__main__":
    sys.exit(main())
