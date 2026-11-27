"""Перевірка Supabase-режиму без сервера: API Supabase підмінено в браузері.

Перевіряє: екран входу → вхід → завантаження (stock/kits/profiles) → створення позиції
з початковою кількістю → виклик rpc/post_operation з тими самими іменами параметрів,
що оголошені в supabase/schema.sql.

Порядок позицій і категорій: новий застосунок на базі зі СТАРОЮ схемою (без sort_order,
category_order і функцій порядку) працює як раніше, а спроба змінити порядок дає
зрозуміле повідомлення; на новій схемі порядок зберігається одним викликом rpc;
без мережі зміна не ставиться в чергу.

Головний адміністратор: на базі зі СТАРОЮ схемою (функції owner_id ще немає) адміністратор
керує людьми, як раніше; на новій — керування лише в головного, інший адміністратор бачить
список для читання.

Порядок меню: на базі без nav_order / set_nav_order меню стоїть у порядку за замовчуванням,
а спроба його змінити дає «Оновіть базу (schema.sql)»; на новій — зберігається одним викликом
rpc/set_nav_order з p_ids; без мережі в чергу не ставиться; кнопки порядку (меню і «Залишків»)
бачить лише головний адміністратор.

Видача замовнику й борги: на базі зі СТАРОЮ схемою (немає order_shipments / order_debts_left і
функцій ship_order …) замовлення відкриваються й передаються, як раніше, а спроба видати дає
«Оновіть базу (schema.sql)»; на новій — ship_order / close_order_debt / cancel_order_shipment
викликаються з тими параметрами, що оголошені в schema.sql; без мережі видача в чергу не ставиться.

«Мій відділ»: на базі зі СТАРОЮ схемою (у замовлень немає dept_path / origin_department_id) вкладка
працює, як раніше, — лише те, що зараз чекає на відділ; на новій — передане далі замовлення лишається
в списку з підписом, де воно зараз, а людина без orders.all бачить його картку лише для перегляду.
"""
import base64
import datetime
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
OTHER = "22222222-2222-2222-2222-222222222222"


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


class Server(socketserver.ThreadingTCPServer):
    # сторінка тягне два десятки модулів одразу: зі стандартною чергою (5) Windows подеколи
    # відмовляє в зʼєднанні (net::ERR_CONNECTION_REFUSED), і тест падає на рівному місці
    request_queue_size = 128
    daemon_threads = True


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = Server(("127.0.0.1", 0), handler)
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
    # owner: "absent" — у базі ще немає функції owner_id (стара схема); інакше — id головного
    # nav: чи є в базі app_settings.nav_order і set_nav_order (найновіша частина схеми)
    db = {"new_schema": False, "category_order": [], "owner": "absent", "nav": False, "nav_order": []}
    # ship: чи є в базі видачі замовнику й борги (order_shipments, order_debts_left, ship_order …)
    db.update(ship=False, orders=[], shipments=[], debts=[])
    # my_dep: відділ користувача в профілі; perms: що віддає my_perms; deps2: другий відділ у списку
    db.update(my_dep=None, perms=["admin"], deps2=False)

    def no_fn(route, fn, arg):  # так PostgREST відповідає про функцію, якої немає в базі
        return route.fulfill(status=404, json={
            "code": "PGRST202", "hint": None,
            "details": f"Searched for the function public.{fn} with parameter {arg} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.",
            "message": f"Could not find the function public.{fn}({arg}) in the schema cache"})

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
            if "nav_order" in path:
                if not db["nav"]:
                    return route.fulfill(status=400, json={"code": "42703", "details": None, "hint": None,
                                                           "message": "column app_settings.nav_order does not exist"})
                row["nav_order"] = db["nav_order"]
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
        if path.startswith("/rest/v1/rpc/set_nav_order"):
            if not db["nav"]:
                return route.fulfill(status=404, json={
                    "code": "PGRST202", "hint": None,
                    "details": "Searched for the function public.set_nav_order with parameter p_ids or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.",
                    "message": "Could not find the function public.set_nav_order(p_ids) in the schema cache"})
            db["nav_order"] = json.loads(req.post_data)["p_ids"]
            return route.fulfill(status=204, body="")
        if path.startswith(("/rest/v1/order_shipments", "/rest/v1/order_debts_left")):
            name = path.split("/rest/v1/")[1].split("?")[0]
            if not db["ship"]:  # так PostgREST відповідає про таблицю, якої немає в базі
                return route.fulfill(status=404, json={"code": "PGRST205", "details": None, "hint": None,
                                                       "message": f"Could not find the table 'public.{name}' in the schema cache"})
            return route.fulfill(json=[r for r in db["shipments"] if not r["cancelled_at"]] if name == "order_shipments" else db["debts"])
        if path.startswith("/rest/v1/rpc/ship_order"):
            if not db["ship"]:
                return no_fn(route, "ship_order", "p_comment, p_date, p_debts, p_id, p_qty, p_units")
            b = json.loads(req.post_data)
            sid = f"ffffffff-0000-0000-0000-{len(db['shipments']) + 1:012d}"
            db["shipments"].append({"id": sid, "order_id": b["p_id"], "qty": b["p_qty"], "shipped_at": b["p_date"], "comment": b["p_comment"],
                                    "auto": False, "closed_from": None, "created_at": "2026-11-27T10:00:00Z", "created_by": UID,
                                    "cancelled_at": None, "cancelled_by": None})
            for n, d in enumerate(b["p_debts"]):
                db["debts"].append({"id": f"dddddddd-1111-0000-0000-{len(db['debts']) + 1:012d}", "order_id": b["p_id"], "shipment_id": sid,
                                    "item_id": d["item_id"], "qty": d["qty"], "closed_qty": 0, "left_qty": d["qty"],
                                    "created_at": "2026-11-27T10:00:00Z", "created_by": UID})
            return route.fulfill(json=sid)
        if path.startswith("/rest/v1/rpc/close_order_debt"):
            if not db["ship"]:
                return no_fn(route, "close_order_debt", "p_comment, p_debt, p_qty")
            b = json.loads(req.post_data)
            d = next(r for r in db["debts"] if r["id"] == b["p_debt"])
            d.update(closed_qty=d["closed_qty"] + b["p_qty"], left_qty=d["left_qty"] - b["p_qty"])
            return route.fulfill(json="bbbbbbbb-0000-0000-0000-000000000009")
        if path.startswith("/rest/v1/rpc/cancel_order_shipment"):
            if not db["ship"]:
                return no_fn(route, "cancel_order_shipment", "p_id")
            sid = json.loads(req.post_data)["p_id"]
            next(r for r in db["shipments"] if r["id"] == sid)["cancelled_at"] = "2026-11-27T11:00:00Z"
            db["debts"][:] = [r for r in db["debts"] if r["shipment_id"] != sid]
            return route.fulfill(status=204, body="")
        if path.startswith("/rest/v1/rpc/move_order"):
            b = json.loads(req.post_data)
            next(o for o in db["orders"] if o["id"] == b["p_id"]).update(status=b["p_status"])
            return route.fulfill(status=204, body="")
        if path.startswith("/rest/v1/orders"):
            return route.fulfill(json=db["orders"])
        if path.startswith("/rest/v1/order_events"):
            return route.fulfill(json=[])
        if path.startswith(("/rest/v1/kits", "/rest/v1/operations")):
            return route.fulfill(json=[])
        if path.startswith("/rest/v1/departments"):
            return route.fulfill(json=[{"id": "dddddddd-0000-0000-0000-000000000001", "name": "Тестування"}]
                                 + ([{"id": "dddddddd-0000-0000-0000-000000000002", "name": "Виробництво"}] if db["deps2"] else []))
        if path.startswith("/rest/v1/rpc/my_perms"):
            return route.fulfill(json=db["perms"])
        if path.startswith("/rest/v1/rpc/owner_id"):
            if db["owner"] == "absent":
                return route.fulfill(status=404, json={
                    "code": "PGRST202", "hint": None,
                    "details": "Searched for the function public.owner_id without parameters or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.",
                    "message": "Could not find the function public.owner_id without parameters in the schema cache"})
            return route.fulfill(json=db["owner"])
        if path.startswith("/rest/v1/rpc/admin_users"):
            return route.fulfill(json=[
                {"id": UID, "email": "ivan@example.com", "display_name": "ivan", "role_id": "r1", "department_id": None,
                 "perms": None, "active": True, "last_sign_in_at": None, "created_at": "2026-01-01T00:00:00Z"},
                {"id": OTHER, "email": "olena@example.com", "display_name": "olena", "role_id": "r1", "department_id": None,
                 "perms": None, "active": True, "last_sign_in_at": None, "created_at": "2026-02-01T00:00:00Z"}])
        if path.startswith("/rest/v1/roles"):
            return route.fulfill(json=[{"id": "r1", "name": "Адміністратор", "perms": ["admin"]}])
        if path.startswith("/rest/v1/rpc/purge_trash"):
            return route.fulfill(json=[])
        if path.startswith("/rest/v1/profiles"):
            return route.fulfill(json=[{"id": UID, "display_name": "ivan", "department_id": db["my_dep"]},
                                       {"id": OTHER, "display_name": "olena", "department_id": None}])
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
        # стартова сторінка — перший розділ меню; база зі старою схемою (без nav_order) — порядок за замовчуванням
        expect(page.locator("#top h1")).to_have_text("Комплекти")
        tabs = lambda: page.eval_on_selector_all("#nav a[data-tab]", "els => els.map((e) => e.dataset.tab)")
        assert tabs() == ["kits", "stock", "orders", "journal", "more"], tabs()
        page.goto(url + "#/stock")
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

        # ---------- головний адміністратор ----------
        def users_page():
            calls.clear()
            page.goto(url + "#/users")
            reload()
            expect(page.locator(".user-row")).to_have_count(2)
            assert [c for c in calls if "/rpc/owner_id" in c[1]], "owner_id не запитано"

        # новий застосунок, база ще без головного (schema.sql не запускали): адміністратор керує, як раніше
        assert db["owner"] == "absent"
        users_page()
        expect(page.locator("a[href='#/user/new']")).to_have_count(1)
        expect(page.locator("a.user-row")).to_have_count(2)
        expect(page.locator(".owner-tag")).to_have_count(0)
        expect(page.locator("#ro-note")).to_have_count(0)
        page.locator(".user-row", has_text="olena").click()
        expect(page.locator("#f [name=role]")).to_be_enabled()            # форма робоча
        expect(page.locator("#save")).to_be_visible()
        page.goto(url + "#/roles")
        expect(page.locator("a[href='#/role/new']")).to_have_count(1)

        # після schema.sql: я — головний
        db["owner"] = UID
        users_page()
        expect(page.locator(".user-row", has_text="ivan").locator(".owner-tag")).to_have_text("Головний адміністратор")
        expect(page.locator(".owner-tag")).to_have_count(1)
        expect(page.locator("a[href='#/user/new']")).to_have_count(1)
        expect(page.locator("a.user-row")).to_have_count(2)
        page.locator(".user-row", has_text="ivan").click()
        expect(page.locator("#owner-note")).to_be_visible()
        expect(page.locator("#f [name=role]")).to_be_disabled()           # із себе роль не зняти

        # після schema.sql: головний — інша людина, я лише адміністратор
        db["owner"] = OTHER
        users_page()
        expect(page.locator("#ro-note")).to_contain_text("Права надає лише головний адміністратор")
        expect(page.locator("#ro-note")).to_contain_text("olena")
        expect(page.locator(".user-row", has_text="olena").locator(".owner-tag")).to_have_count(1)
        expect(page.locator("a[href='#/user/new']")).to_have_count(0)
        expect(page.locator("a.user-row")).to_have_count(0)
        page.goto(url + f"#/user/{OTHER}")
        expect(page.locator("#ro-note")).to_be_visible()
        expect(page.locator("#f")).to_have_count(0)
        page.goto(url + "#/roles")
        expect(page.locator("a[href='#/role/new']")).to_have_count(0)
        expect(page.locator("a.row")).to_have_count(0)
        page.goto(url + "#/more")
        expect(page.locator("a[href='#/notifications']")).to_have_count(1)  # решта адмінського лишилась
        assert not [c for c in calls if any(f"/rpc/admin_{x}" in c[1] for x in ("create_user", "update_user", "set_password", "delete_user"))]

        # ---------- порядок меню ----------
        ALL = ["kits", "stock", "orders", "journal", "inventory", "reorder", "departments", "labels", "import",
               "users", "notifications", "backups"]
        nav_rows = lambda: page.eval_on_selector_all("#navlist > [data-sort]", "els => els.map((e) => e.dataset.id)")

        def more_page():
            calls.clear()
            page.goto(url + "#/more")
            page.reload()
            page.locator(".login, main .menu").first.wait_for()
            if page.locator(".login").count():
                page.fill("[name=email]", "ivan@example.com")
                page.fill("[name=password]", "secret1")
                page.click(".login button")
            expect(page.locator("#top h1")).to_have_text("Ще")

        # не головний адміністратор (головна — olena): кнопок порядку немає ні в «Ще», ні в «Залишках»
        more_page()
        expect(page.locator("[data-x=navorder]")).to_have_count(0)
        page.goto(url + "#/stock")
        expect(page.locator("#list a.row")).to_have_count(2)
        expect(page.locator("[data-new]")).to_have_count(1)
        expect(page.locator("[data-order]")).to_have_count(0)

        # база, як вона є сьогодні: головний уже є, а nav_order / set_nav_order ще немає
        db["owner"] = UID
        more_page()
        st = [c[1] for c in calls if c[1].startswith("/rest/v1/app_settings")]
        assert "nav_order" in st[0] and "nav_order" not in st[1] and "category_order" in st[1], st  # без колонки — читаємо по-старому
        assert tabs() == ALL[:4] + ["more"], tabs()
        page.locator("[data-x=navorder]").click()
        expect(page.locator("#top h1")).to_have_text("Порядок меню")
        assert nav_rows() == ALL, nav_rows()
        page.locator("#navlist > [data-sort]").first.locator("[data-mv='1']").click()
        expect(page.locator(".toast.err").last).to_contain_text("Оновіть базу (schema.sql)")
        expect(page.locator("#navlist > [data-sort]").first).to_have_attribute("data-id", "kits")  # повернулось як було
        assert nav_rows() == ALL and tabs() == ALL[:4] + ["more"], (nav_rows(), tabs())
        assert order_rpc("set_nav_order") == [{"p_ids": ["stock", "kits"] + ALL[2:]}], order_rpc("set_nav_order")
        expect(page.locator("#top h1")).to_have_text("Порядок меню")                              # екран цілий
        page.locator("[data-done]").click()
        expect(page.locator("#top h1")).to_have_text("Ще")

        # зовсім стара база (ні головного, ні порядку): як і з людьми — будь-який адміністратор бачить кнопку, збереження просить оновити базу
        db.update(owner="absent", new_schema=False)
        more_page()
        st = [c[1] for c in calls if c[1].startswith("/rest/v1/app_settings")]
        assert len(st) >= 3 and "nav_order" in st[0] and "category_order" in st[1] and "category_order" not in st[2], st
        assert tabs() == ALL[:4] + ["more"], tabs()
        expect(page.locator("[data-x=navorder]")).to_have_count(1)
        page.locator("[data-x=navorder]").click()
        page.locator("#navlist > [data-sort]").last.locator("[data-mv='-1']").click()
        expect(page.locator(".toast.err").last).to_contain_text("Оновіть базу (schema.sql)")
        expect(page.locator("#navlist > [data-sort]").last).to_have_attribute("data-id", "backups")

        # після свіжого schema.sql: збережений порядок читається, головний міняє його одним викликом
        db.update(owner=UID, new_schema=True, nav=True, nav_order=["orders", "stock", "nema-takoho"])
        more_page()
        order = ["orders", "stock"] + [k for k in ALL if k not in ("orders", "stock")]
        assert tabs() == order[:4] + ["more"], tabs()
        page.locator("[data-x=navorder]").click()
        assert nav_rows() == order, nav_rows()
        page.locator("#navlist > [data-sort]").first.locator("[data-mv='1']").click()
        order[0], order[1] = order[1], order[0]
        expect(page.locator("#navlist > [data-sort]").first).to_have_attribute("data-id", "stock")
        for _ in range(50):
            if order_rpc("set_nav_order"):
                break
            page.wait_for_timeout(100)
        assert order_rpc("set_nav_order") == [{"p_ids": order}], order_rpc("set_nav_order")
        assert db["nav_order"] == order, db["nav_order"]
        assert tabs() == order[:4] + ["more"], tabs()
        assert page.locator(".toast.err").count() == 0
        sig4 = re.search(r"function public\.set_nav_order\((.*?)\)\s+returns", sql, re.S).group(1)
        assert set(re.findall(r"\b(p_\w+)\s", sig4)) == {"p_ids"}, sig4
        used = set(re.findall(r"\b(p_\w+):", re.search(r"rpc\('set_nav_order', \{(.*?)\}\)", js, re.S).group(1)))
        assert used == {"p_ids"}, used
        # без мережі порядок меню в чергу не ставиться
        ctx.set_offline(True)
        page.locator("#navlist > [data-sort]").first.locator("[data-mv='1']").click()
        expect(page.locator(".toast.err").last).to_have_text("Немає мережі — порядок не збережено")
        expect(page.locator("#navlist > [data-sort]").first).to_have_attribute("data-id", "stock")
        assert len(order_rpc("set_nav_order")) == 1 and tabs() == order[:4] + ["more"]
        ctx.set_offline(False)
        more_page()
        assert tabs() == order[:4] + ["more"], tabs()                # збережене пережило перезавантаження
        assert not order_rpc("set_nav_order")
        # головний на новій схемі бачить і «Порядок» у залишках
        page.goto(url + "#/stock")
        expect(page.locator("#list a.row")).to_have_count(2)
        expect(page.locator("[data-order]")).to_have_count(1)
        # функції, на які спирається клієнт, є в schema.sql
        assert re.search(r"function public\.owner_id\(\)\s+returns uuid", sql), "owner_id у schema.sql"

        # ---------- видача замовнику й борги ----------
        OID = "cccccccc-0000-0000-0000-000000000002"
        today = datetime.date.today().isoformat()
        db["orders"].append({
            "id": OID, "number": 2, "title": "МАД - аналог - фпв (CM4)", "customer": "Замовник", "qty": 55, "due_date": None,
            "description": "", "status": "in_work", "department_id": "dddddddd-0000-0000-0000-000000000001",
            "created_at": "2026-11-20T09:00:00Z", "created_by": UID, "updated_at": "2026-11-20T09:00:00Z",
            "deleted_at": None, "deleted_by": None, "order_tasks": [], "order_units": [],
            "order_parts": [{"item_id": motor, "qty": 55}]})
        rpc_calls = lambda fn: [json.loads(c[2]) for c in calls if f"/rpc/{fn}" in c[1]]

        def open_order():
            calls.clear()
            page.goto(url + "#/orders")
            reload()
            page.locator("#chips [data-f=active]").click()
            expect(page.locator("a.order-row")).to_have_count(1)
            page.locator("a.order-row").click()
            expect(page.locator("#top h1")).to_contain_text("МАД - аналог")
            expect(page.locator("#parts table")).to_be_visible()

        # новий застосунок, база ще без видач (schema.sql не запускали): замовлення працюють, як раніше
        assert not db["ship"]
        open_order()
        assert len([c for c in calls if c[1].startswith("/rest/v1/order_shipments")]) == 1, "таблицю видач питаємо один раз"
        ops = [c[1] for c in calls if c[1].startswith("/rest/v1/operations")]
        assert ops and not any("debt_id" in c for c in ops), ops   # колонки debt_id на старій схемі не просимо
        expect(page.locator("#ship-sum")).to_contain_text("Замовнику ще нічого не видано — лишилось 55")
        expect(page.locator("#ship-prop")).to_have_count(0)
        expect(page.locator("#debts")).to_have_count(0)
        page.locator("#ship [data-shipbtn]").click()
        dlg = page.locator(".ship-dialog")
        expect(dlg.locator("[name=qty]")).to_have_value("55")
        dlg.locator("[name=qty]").fill("20")
        dlg.locator("#ship-ok").click()
        expect(page.locator(".toast.err").last).to_contain_text("Оновіть базу (schema.sql)")
        assert rpc_calls("ship_order") == [{"p_id": OID, "p_qty": 20, "p_date": today, "p_comment": "", "p_debts": [], "p_units": None}], rpc_calls("ship_order")
        expect(page.locator("#top h1")).to_contain_text("МАД - аналог")          # картка ціла
        expect(page.locator("#ship-sum")).to_contain_text("лишилось 55")
        page.locator("#acts [data-to=testing]").click()                           # передача працює, як раніше
        page.locator(".move-dialog button.primary").click()
        expect(page.locator(".order-head")).to_contain_text("На тестуванні")
        assert rpc_calls("move_order")[0]["p_status"] == "testing"
        page.screenshot(path=str(ROOT / "tests" / "shots" / "47_ship_old_schema.png"))

        # та сама база після свіжого schema.sql
        db["ship"] = True
        open_order()
        ops = [c[1] for c in calls if c[1].startswith("/rest/v1/operations")]
        assert ops and all("debt_id" in c for c in ops), ops                      # довидачу боргу відрізняємо від видачі на збірку
        page.locator("#ship [data-shipbtn]").click()
        dlg = page.locator(".ship-dialog")
        dlg.locator("[name=qty]").fill("20")
        dlg.locator("[name=partial]").check()
        dlg.locator("[name=frompart]").select_option(label="Мотор")
        expect(dlg.locator("#slines .qty")).to_have_value("20")                    # 1 мотор на виріб × 20 виробів
        dlg.locator("#slines .qty").fill("10")
        dlg.locator("[name=c]").fill("перша партія")
        dlg.locator("#ship-ok").click()
        expect(page.locator("#ship-sum")).to_contain_text("Видано 20 з 55 · лишилось 35")
        assert rpc_calls("ship_order") == [{"p_id": OID, "p_qty": 20, "p_date": today, "p_comment": "перша партія",
                                            "p_debts": [{"item_id": motor, "qty": 10}], "p_units": None}], rpc_calls("ship_order")
        expect(page.locator("#debts .debt [data-c=left]")).to_have_text("10")
        expect(page.locator("#debt-badge")).to_be_visible()
        debt_id = db["debts"][0]["id"]
        page.locator("#debts [data-dclose]").click()
        dd = page.locator(".debt-dialog")
        dd.locator("[name=qty]").fill("4")
        dd.locator("#debt-ok").click()
        expect(page.locator("#debts .debt [data-c=left]")).to_have_text("6")
        assert rpc_calls("close_order_debt") == [{"p_debt": debt_id, "p_qty": 4, "p_comment": ""}], rpc_calls("close_order_debt")
        # список: «видано 20/55» і позначка боргу
        page.locator("#top a.back").click()
        expect(page.locator("a.order-row .ship-n")).to_have_text("видано 20/55")
        expect(page.locator("a.order-row .debt-tag")).to_have_text("борг")
        page.locator("a.order-row").click()
        # без мережі видача в чергу не ставиться
        n_ship = len(rpc_calls("ship_order"))
        ctx.set_offline(True)
        page.locator("#ship [data-shipbtn]").click()
        page.locator(".ship-dialog #ship-ok").click()
        expect(page.locator(".toast.err").last).to_contain_text("Немає мережі — видачу замовнику не записано")
        assert len(rpc_calls("ship_order")) == n_ship
        ctx.set_offline(False)
        # скасування помилкової видачі
        page.locator("#ship-list [data-scancel]").click()
        page.locator(".modal [data-r='1']").click()
        expect(page.locator("#ship-sum")).to_contain_text("Замовнику ще нічого не видано — лишилось 55")
        assert rpc_calls("cancel_order_shipment") == [{"p_id": db["shipments"][0]["id"]}], rpc_calls("cancel_order_shipment")
        expect(page.locator("#debts")).to_have_count(0)
        assert page.locator(".toast.err").count() == 0 or "Оновіть" not in page.locator(".toast.err").last.inner_text()
        # ---------- «Мій відділ» ----------
        TEST, PROD = "dddddddd-0000-0000-0000-000000000001", "dddddddd-0000-0000-0000-000000000002"
        order = db["orders"][0]
        db.update(deps2=True, my_dep=PROD)
        order.update(status="in_work", department_id=PROD)
        assert "dept_path" not in order and "origin_department_id" not in order   # стара схема: колонок немає

        def my_dep_tab():
            page.goto(url + "#/orders")
            reload()
            page.locator("#chips [data-f=mine]").click()

        # стара схема, замовлення чекає на мій відділ: воно в списку, число на фішці й на вкладці
        my_dep_tab()
        expect(page.locator("#list a.order-row.waits .wait-tag")).to_have_text("чекає на вас")
        expect(page.locator("#chips [data-f=mine]")).to_have_text("Мій відділ · 1")
        expect(page.locator(".nav-badge")).to_have_text("1")
        # стара схема, замовлення передали далі: як раніше — «нічого не чекає» (про шлях база ще не знає), нічого не падає
        order.update(status="testing", department_id=TEST)
        my_dep_tab()
        expect(page.locator("#list .empty-state")).to_have_text("На ваш відділ зараз нічого не чекає")
        expect(page.locator("#list a.order-row")).to_have_count(0)
        expect(page.locator("#chips [data-f=mine]")).to_have_text("Мій відділ")
        expect(page.locator(".nav-badge")).to_be_hidden()
        page.locator("#chips [data-f=active]").click()
        expect(page.locator("#list a.order-row")).to_have_count(1)
        assert not errors, errors
        # нова схема: база віддає причетні відділи — передане далі замовлення лишається в «Мій відділ»
        order.update(origin_department_id=PROD, dept_path=[PROD, TEST])
        my_dep_tab()
        expect(page.locator("#list .empty-state")).to_have_count(0)
        expect(page.locator("#mine-none")).to_have_text("На ваш відділ зараз нічого не чекає")
        expect(page.locator("#list a.order-row .now-at")).to_have_text("зараз: Тестування")
        expect(page.locator("#chips [data-f=mine]")).to_have_text("Мій відділ")     # число — лише те, що чекає
        expect(page.locator(".nav-badge")).to_be_hidden()
        # непричетний відділ (шлях без мого) — у «Мій відділ» його немає
        order.update(origin_department_id=TEST, dept_path=[TEST])
        my_dep_tab()
        expect(page.locator("#list a.order-row")).to_have_count(0)
        expect(page.locator("#list .empty-state")).to_have_text("Відкритих замовлень вашого відділу немає")
        # людина без orders.all: картка переданого далі замовлення — лише перегляд, запитів на зміну немає
        order.update(origin_department_id=PROD, dept_path=[PROD, TEST])
        db["perms"] = ["stock.view", "ops.view", "ops.edit", "orders.view", "orders.edit", "orders.delete"]
        my_dep_tab()
        n_calls = len(calls)
        page.locator("#list a.order-row").click()
        expect(page.locator("#view-only")).to_contain_text("зараз у відділі «Тестування»")
        expect(page.locator("#acts button")).to_have_count(0)
        expect(page.locator("#top a[href^='#/order-edit/']")).to_have_count(0)
        expect(page.locator("#addtask, #cmt, #ship [data-shipbtn], #parts a.btn.out")).to_have_count(0)
        expect(page.locator("#parts table")).to_be_visible()
        assert not [c for c in calls[n_calls:] if c[0] != "GET" and "/rpc/" not in c[1]], calls[n_calls:]   # нічого не пишемо
        # те саме замовлення повернули в мій відділ — дії на місці
        order.update(status="rework", department_id=PROD)
        my_dep_tab()
        expect(page.locator("#chips [data-f=mine]")).to_have_text("Мій відділ · 1")
        page.locator("#list a.order-row.waits").click()
        expect(page.locator("#view-only")).to_have_count(0)
        expect(page.locator("#acts [data-to=testing]")).to_have_count(1)
        db.update(perms=["admin"], my_dep=None)
        # колонки, на які спирається клієнт, є в schema.sql, і клієнт їх не пише
        assert re.search(r"add column dept_path uuid\[\]", sql) and "origin_department_id uuid references public.departments" in sql
        assert "function public.can_view_order_id(p_order uuid)" in sql
        assert "dept_path" not in re.search(r"grant insert \((.*?)\) on public\.orders", sql).group(1)
        assert "dept_path" not in re.search(r"grant update \((.*?)\) on public\.orders", sql).group(1)

        # імена параметрів у api.js збігаються з SQL
        for fn in ("ship_order", "cancel_order_shipment", "close_order_debt"):
            sig5 = re.search(rf"function public\.{fn}\((.*?)\)\s*returns", sql, re.S).group(1)
            declared5 = set(re.findall(r"\b(p_\w+)\s", sig5))
            used5 = set(re.findall(r"\b(p_\w+):", re.search(rf"rpc\('{fn}', \{{(.*?)\}}\)", js, re.S).group(1)))
            assert used5 == declared5 and used5 == set(rpc_calls(fn)[0].keys()), (fn, used5, declared5)
        browser.close()
    httpd.shutdown()
    if errors:
        print("\n".join(errors))
        return 1
    print("SUPABASE MOCK OK; rpc params:", sorted(params))
    return 0


if __name__ == "__main__":
    sys.exit(main())
