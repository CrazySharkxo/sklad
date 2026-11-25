"""Наскрізний тест у демо-режимі (localStorage) через headless Edge.

    python tests/e2e_demo.py [папка_для_скріншотів]

Проходить робочий цикл: позиції → прихід → видаток (зокрема понад залишок) →
комплект → інвентаризація → журнал і скасування → дозамовлення → Excel експорт/імпорт.
"""
import functools
import http.server
import re
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "shots"


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a: None
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


# порожній конфіг = демо-режим, незалежно від того, що вписано в js/config.js
def DEMO_CONFIG(route):
    route.fulfill(content_type="text/javascript",
                  body="export const SUPABASE_URL = '';\nexport const SUPABASE_ANON_KEY = '';\n")


def stock_qty(page, name):
    row = page.locator(".row", has=page.locator(".row-title", has_text=name))
    return row.locator(".row-qty b").inner_text()


def main() -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    httpd, url = serve()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": 400, "height": 860}, locale="uk-UA", accept_downloads=True)
        ctx.route(re.compile(r".*/js/config\.js$"), DEMO_CONFIG)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        def toast_text():
            t = page.locator(".toast").last
            t.wait_for()
            return t.inner_text()

        page.goto(url)
        expect(page.locator(".empty-state")).to_contain_text("Склад порожній")
        page.screenshot(path=str(SHOTS / "01_empty.png"))

        # --- позиції ---
        def add_item(name, code="", cat="", unit="", loc="", min_qty="", init=""):
            page.goto(url + "#/item-edit/new")
            f = page.locator("#f")
            f.locator("[name=name]").fill(name)
            if code: f.locator("[name=code]").fill(code)
            if cat: f.locator("[name=category]").fill(cat)
            if unit: f.locator("[name=unit]").fill(unit)
            if loc: f.locator("[name=location]").fill(loc)
            if min_qty: f.locator("[name=min_qty]").fill(min_qty)
            if init: f.locator("[name=init_qty]").fill(init)
            f.locator("#save").click()
            expect(page.locator(".big-qty")).to_be_visible()

        add_item("Мотор 2207 1750KV", code="4820000000017", cat="Мотори", loc="Стелаж 1", min_qty="8", init="12")
        expect(page.locator(".big-qty b")).to_have_text("12")
        add_item("Польотник F722", cat="Електроніка", min_qty="2", init="3")
        add_item("Дріт силіконовий 14AWG", cat="Кабелі", unit="м", init="10,5")
        expect(page.locator(".big-qty")).to_contain_text("10,5")
        add_item("Камера Caddx Ratel", cat="Камери", min_qty="1")

        # дубль коду відхиляється
        page.goto(url + "#/item-edit/new")
        page.locator("[name=name]").fill("Дубль")
        page.locator("[name=code]").fill("4820000000017")
        page.locator("#save").click()
        assert "Такий код уже є" in toast_text()

        # --- прихід кількох позицій через пошук ---
        page.goto(url + "#/op/in")
        pick = page.locator("#picker input")
        pick.fill("камера")
        pick.press("Enter")
        page.locator(".line .qty").last.fill("4")
        pick.fill("4820000000017")  # точний код — як USB-сканер
        pick.press("Enter")
        page.locator(".line .qty").last.fill("2")
        page.locator("[name=counterparty]").fill("Магазин А")
        page.screenshot(path=str(SHOTS / "02_op_in.png"))
        page.locator("#post").click()
        assert "Прихід проведено" in toast_text()
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207") == "14", stock_qty(page, "Мотор 2207")
        assert stock_qty(page, "Камера") == "4"

        # --- видаток понад залишок відхиляється з назвою позиції ---
        page.goto(url + "#/op/out")
        pick = page.locator("#picker input")
        pick.fill("польотник")
        pick.press("Enter")
        page.locator(".line .qty").last.fill("5")
        expect(page.locator(".line.bad")).to_be_visible()
        page.locator("#post").click()
        assert "Недостатньо «Польотник F722»" in toast_text()
        page.locator(".line .qty").last.fill("1")
        page.locator("#post").click()
        assert "Видаток проведено" in toast_text()

        # --- комплект ---
        page.goto(url + "#/kit-edit/new")
        page.locator("[name=name]").fill('Дрон 7"')
        pick = page.locator("#picker input")
        for q, n in (("мотор", "4"), ("польотник", "1"), ("камера", "1"), ("дріт", "0,5")):
            pick.fill(q)
            pick.press("Enter")
            page.locator(".line .qty").last.fill(n)
        page.locator("#save").click()
        expect(page.locator(".kit-issue")).to_contain_text("можна видати: 2")  # FC: 2 шт
        page.locator(".issue-form [name=n]").fill("3")
        expect(page.locator(".tbl tr.bad")).to_have_count(1)
        page.screenshot(path=str(SHOTS / "03_kit.png"))
        page.locator(".issue-form [name=n]").fill("2")
        page.locator(".issue-form [name=counterparty]").fill("Екіпаж 3")
        page.locator(".issue-form button").click()
        page.locator(".modal [data-r='1']").click()
        assert "Комплекти видано" in toast_text()
        expect(page.locator(".kit-issue")).to_contain_text("можна видати: 0")
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207") == "6"
        assert stock_qty(page, "Дріт") == "9,5"

        # --- нижче мінімуму ---
        expect(page.locator(".chip.warn")).to_contain_text("Мало: 2")  # мотор 6<8, FC 0<2
        page.screenshot(path=str(SHOTS / "04_stock.png"), full_page=True)
        page.goto(url + "#/reorder")
        expect(page.locator(".row")).to_have_count(2)

        # --- інвентаризація ---
        page.goto(url + "#/inventory")
        row = page.locator(".inv-row", has_text="Мотор 2207")
        row.locator(".qty").fill("7")
        expect(row.locator(".inv-diff")).to_contain_text("+1")
        page.locator(".inv-row", has_text="Дріт").locator(".qty").fill("9,5")
        expect(page.locator("#stat")).to_have_text("Пораховано: 2, розбіжностей: 1")
        page.reload()  # чернетка переживає перезавантаження
        expect(page.locator("#stat")).to_have_text("Пораховано: 2, розбіжностей: 1")
        page.screenshot(path=str(SHOTS / "05_inventory.png"))
        page.locator("#post").click()
        page.locator(".modal [data-r='1']").click()
        assert "Інвентаризацію проведено" in toast_text()
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207") == "7"

        # --- журнал: видалення в кошик, відновлення, знову видалення ---
        page.goto(url + "#/journal")
        expect(page.locator(".op")).to_have_count(7)  # 3 поч. залишки + прихід + видаток + комплект + інвентаризація
        page.screenshot(path=str(SHOTS / "06_journal.png"), full_page=True)
        # накладна / акт друкуються в print-area
        page.locator(".op", has_text="Інвентаризація").locator("[data-print]").click()
        expect(page.locator("#print-area .doc")).to_contain_text("Акт інвентаризації")
        page.locator(".op", has_text="Прихід").first.locator("[data-print]").click()
        expect(page.locator("#print-area .doc")).to_contain_text("Прибуткова накладна")

        def delete_kit_op():
            page.locator(".op", has_text="Видача комплекту").locator("[data-cancel]").click()
            expect(page.locator(".modal")).to_contain_text("Журнал → Кошик")
            page.locator(".modal [data-r='1']").click()
            assert "Операцію перенесено в кошик" in toast_text()
            expect(page.locator(".op")).to_have_count(6)

        delete_kit_op()
        page.locator("#types [data-trash]").click()
        expect(page.locator(".op.in-trash")).to_have_count(1)
        expect(page.locator(".op.in-trash")).to_contain_text("зникне через 30 дн.")
        expect(page.locator("#dates")).to_be_hidden()
        page.screenshot(path=str(SHOTS / "06b_journal_trash.png"), full_page=True)
        page.locator(".op.in-trash [data-restore]").click()
        assert "Відновлено" in toast_text()
        expect(page.locator(".empty-state")).to_contain_text("Кошик порожній")
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207") == "7"  # видача знову діє
        page.goto(url + "#/journal")
        page.locator("#types [data-t='']").click()
        delete_kit_op()
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207") == "15"

        # --- Excel: експорт залишків і імпорт шаблону ---
        page.goto(url + "#/more")
        with page.expect_download() as dl:
            page.locator("[data-x=stock]").click()
        xl = SHOTS / "export.xlsx"
        dl.value.save_as(xl)
        assert xl.stat().st_size > 1000
        page.goto(url + "#/import")
        with page.expect_download() as dl:
            page.locator("#tpl").click()
        tpl = SHOTS / "template.xlsx"
        dl.value.save_as(tpl)
        page.locator("#file").set_input_files(str(tpl))
        expect(page.locator("#preview")).to_contain_text("нових позицій 0, вже існуючих 2")
        page.locator("#go").click()
        assert "Імпортовано" in toast_text()
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207 1750KV") == "39", stock_qty(page, "Мотор 2207 1750KV")  # 15 + 24 з шаблону
        expect(page.locator(".row", has_text="Дріт силіконовий 14AWG")).to_have_count(1)  # не задвоївся
        assert stock_qty(page, "Дріт силіконовий 14AWG") == "30,5"

        # --- замовлення: свій відділ → прийом → чекліст → видача деталей → тест → повернення ---
        page.goto(url + "#/orders")
        expect(page.locator(".empty-state")).to_contain_text("Замовлень ще немає")
        page.goto(url + "#/departments")
        page.locator(".dep-row", has_text="Прийом замовлень").locator("[data-mine]").click()
        assert "Ваш відділ: Прийом замовлень" in toast_text()

        page.goto(url + "#/order-edit/new")
        f = page.locator("#f")
        f.locator("[name=title]").fill('Дрон 7" нічний')
        f.locator("[name=customer]").fill("Екіпаж 5")
        f.locator("[name=qty]").fill("2")
        f.locator("[name=description]").fill("Нічна камера, антена 5.8 ГГц\nРама 7 дюймів")
        expect(f.locator("[name=dep] option:checked")).to_have_text("Прийом замовлень")
        for t in ("Зібрати раму", "Прошити польотник", "Облітати"):
            page.locator("#newtask").fill(t)
            page.locator("#newtask").press("Enter")
        expect(page.locator(".task-edit")).to_have_count(3)
        page.locator("#kit").select_option(label='Дрон 7"')
        expect(page.locator("#parts .line")).to_have_count(4)
        expect(page.locator("#parts .line", has_text="Мотор").locator(".qty")).to_have_value("8")  # 4 × 2 шт
        page.screenshot(path=str(SHOTS / "12_order_edit.png"), full_page=True)
        page.locator("#save").click()
        assert "Замовлення №1 прийнято" in toast_text()
        expect(page.locator(".order-head")).to_contain_text("Нове")
        expect(page.locator(".order-head")).to_contain_text("Прийом замовлень")
        expect(page.locator(".nav-badge")).to_have_text("1")

        page.locator(".task", has_text="Зібрати раму").locator("input").click()
        expect(page.locator("h3 .count").first).to_have_text("1 з 3")

        # --- резерв: деталі замовлення зарезервовано, у залишках видно «вільно» ---
        expect(page.locator("#parts")).to_contain_text("Усе потрібне є на складі")
        page.goto(url + "#/stock")
        expect(page.locator(".row", has_text="Мотор 2207").locator("em.res")).to_have_text("вільно 31")  # 39 − 8
        page.locator(".row", has_text="Мотор 2207").click()
        expect(page.locator(".badge.res")).to_contain_text("Зарезервовано під замовлення: 8")
        page.screenshot(path=str(SHOTS / "24_reserved.png"))
        page.locator(".badge.res a").click()

        # --- вироби: серійні номери, відмітки, етикетка, пошук за номером ---
        page.locator("#units [data-ugen]").click()
        assert "Створено номерів: 2" in toast_text()
        expect(page.locator(".unit")).to_have_count(2)
        expect(page.locator(".unit").first).to_contain_text("0001-01")
        expect(page.locator("#units [data-ugen]")).to_have_count(0)
        page.locator(".unit").first.locator("[data-k=assembled]").check()
        expect(page.locator(".unit").first.locator(".unit-chk").first).to_contain_text("Демо")
        page.locator("#units [data-ulabels]").click()
        expect(page.locator("#print-area .label")).to_have_count(2)
        page.locator("#oprint").click()
        expect(page.locator("#print-area .doc")).to_contain_text("Замовлення №1")
        page.screenshot(path=str(SHOTS / "25_units.png"), full_page=True)
        page.goto(url + "#/orders")
        page.locator("#q").fill("0001-02")
        expect(page.locator(".order-row")).to_have_count(1)
        page.locator("#q").fill("")
        page.locator(".order-row").first.click()

        page.locator("#parts a.btn.out").click()
        expect(page.locator(".line")).to_have_count(4)
        expect(page.locator("[name=counterparty]")).to_have_value('Замовлення №1 · Дрон 7" нічний')
        page.locator("#post").click()
        assert "Видаток проведено" in toast_text()
        expect(page.locator("#parts")).to_contain_text("Усі деталі видано")

        submit = page.locator(".move-dialog .modal-actions button:not([data-cancel])")
        page.locator("#acts [data-to=in_work]").click()
        submit.click()
        expect(page.locator(".order-head")).to_contain_text("В роботі")

        page.locator("#acts [data-to=testing]").first.click()
        expect(page.locator(".move-dialog .badge.warn")).to_contain_text("Виконано 1 з 3")
        expect(page.locator(".move-dialog select option:checked")).to_have_text("Тестування")
        page.locator(".move-dialog textarea").fill("Перевірити відео вночі")
        page.screenshot(path=str(SHOTS / "13_handoff.png"))
        submit.click()
        expect(page.locator(".order-head")).to_contain_text("На тестуванні")
        expect(page.locator(".order-head")).to_contain_text("Тестування")
        expect(page.locator(".nav-badge")).to_be_hidden()  # уже не на моєму відділі

        page.locator("#acts [data-to=rework]").click()
        expect(page.locator(".move-dialog select option:checked")).to_contain_text("Прийом замовлень")  # тому, хто передав
        submit.click()
        expect(page.locator(".move-dialog [data-err]")).to_contain_text("що треба доопрацювати")
        page.locator(".move-dialog textarea").fill("Немає відео з камери")
        submit.click()
        expect(page.locator(".order-head")).to_contain_text("На доопрацюванні")
        expect(page.locator(".order-head")).to_contain_text("чекає на ваш відділ")
        expect(page.locator("#events .ev")).to_have_count(4)  # прийом, у роботу, на тест, повернення
        expect(page.locator("#events .ev").first).to_contain_text("Немає відео з камери")
        page.screenshot(path=str(SHOTS / "14_order.png"), full_page=True)

        page.goto(url + "#/orders")
        page.locator(".chip[data-f=mine]").click()
        expect(page.locator(".order-row")).to_have_count(1)
        page.screenshot(path=str(SHOTS / "15_orders.png"))
        page.goto(url + "#/journal")
        expect(page.locator(".op", has_text="Замовлення №1")).to_have_count(1)
        page.goto(url + "#/more")
        with page.expect_download() as dl:
            page.locator("[data-x=orders]").click()
        assert dl.value.suggested_filename.startswith("замовлення_")
        page.goto(url + "#/stock")
        assert stock_qty(page, "Мотор 2207 1750KV") == "31", stock_qty(page, "Мотор 2207 1750KV")  # 39 − 8

        # --- замовлення: у кошик (з попередженням про видані деталі), назад, і назавжди ---
        page.goto(url + "#/orders")
        page.locator(".order-row").first.click()
        expect(page.locator("#parts")).to_contain_text("Усі деталі видано")
        page.locator("#acts [data-delete]").click()
        expect(page.locator(".modal")).to_contain_text("лишаться списаними")
        page.locator(".modal [data-r='1']").click()
        assert "Замовлення №1 перенесено в кошик" in toast_text()
        expect(page.locator(".order-row")).to_have_count(0)
        page.locator("#chips [data-f=trash]").click()
        expect(page.locator(".trash-row")).to_have_count(1)
        page.screenshot(path=str(SHOTS / "17_orders_trash.png"))
        page.locator(".trash-row [data-restore]").click()
        assert "Відновлено" in toast_text()
        page.locator("#chips [data-f=active]").click()
        expect(page.locator(".order-row")).to_have_count(1)

        page.goto(url + "#/order-edit/new")
        page.locator("#f [name=title]").fill("Помилкове замовлення")
        page.locator("#f [name=due_date]").fill("2020-01-01")
        page.locator("#save").click()
        assert "Замовлення №2 прийнято" in toast_text()
        # --- терміни: прострочене підсвічено й має свою вкладку ---
        expect(page.locator(".order-head .badge.danger")).to_contain_text("прострочено на")
        page.goto(url + "#/orders")
        expect(page.locator("#chips [data-f=overdue]")).to_contain_text("Прострочені · 1")
        page.locator("#chips [data-f=overdue]").click()
        expect(page.locator(".order-row.is-overdue")).to_have_count(1)
        page.screenshot(path=str(SHOTS / "26_overdue.png"))
        page.locator(".order-row").first.click()
        page.locator("#acts [data-delete]").click()
        page.locator(".modal [data-r='1']").click()
        assert "Замовлення №2 перенесено в кошик" in toast_text()
        page.locator("#chips [data-f=trash]").click()
        page.locator(".trash-row [data-purge]").click()
        page.locator(".modal [data-r='1']").click()
        assert "Видалено назавжди" in toast_text()
        expect(page.locator(".empty-state")).to_contain_text("Кошик порожній")
        page.locator("#chips [data-f=active]").click()
        expect(page.locator(".order-row")).to_have_count(1)

        # --- позиція: «Видалити» в картці → кошик → відновити → назавжди ---
        page.goto(url + "#/item-edit/new")
        page.locator("#f [name=name]").fill("Тимчасова деталь")
        page.locator("#f [name=code]").fill("TMP-1")
        page.locator("#save").click()
        expect(page.locator(".big-qty")).to_be_visible()
        page.locator("[data-del]").click()
        page.locator(".modal [data-r='1']").click()
        assert "Позицію перенесено в кошик" in toast_text()
        expect(page.locator(".row", has_text="Тимчасова деталь")).to_have_count(0)
        assert page.locator("#q").input_value() == ""
        page.locator("#q").fill("TMP-1")
        page.locator("#q").press("Enter")  # код у кошику не знаходиться
        expect(page.locator("#top h1")).to_have_text("Залишки")
        page.locator("#q").fill("")
        page.locator("#chips [data-trash]").click()
        expect(page.locator(".trash-row")).to_have_count(1)
        page.screenshot(path=str(SHOTS / "18_stock_trash.png"))
        page.locator(".trash-row [data-restore]").click()
        assert "Відновлено" in toast_text()
        expect(page.locator(".row", has_text="Тимчасова деталь")).to_have_count(1)
        page.locator(".row", has_text="Тимчасова деталь").click()
        page.locator("[data-del]").click()
        page.locator(".modal [data-r='1']").click()
        page.locator("#chips [data-trash]").click()
        page.locator(".trash-row [data-purge]").click()
        page.locator(".modal [data-r='1']").click()
        assert "Видалено назавжди" in toast_text()
        expect(page.locator("#chips [data-trash]")).to_have_count(0)
        page.goto(url + "#/stock")

        # --- користувачі та ролі (у демо — записи без входу) ---
        page.goto(url + "#/more")
        page.locator("a[href='#/users']").click()
        expect(page.locator(".user-row")).to_have_count(1)
        page.locator("a[href='#/user/new']").click()
        f = page.locator("#f")
        f.locator("[name=name]").fill("Петро")
        f.locator("[name=email]").fill("petro@example.com")
        assert len(f.locator("[name=password]").input_value()) == 10  # пароль згенеровано
        f.locator("[name=role]").select_option(label="Виробництво")
        f.locator("[name=dep]").select_option(label="Тестування")
        expect(page.locator("[data-p='ops.edit']")).to_be_checked()      # галочки ролі
        expect(page.locator("[data-p='ops.edit']")).to_be_disabled()     # «як у ролі» — не редагуються
        page.screenshot(path=str(SHOTS / "19_user_new.png"), full_page=True)
        page.locator("#save").click()
        assert "Користувача створено" in toast_text()
        expect(page.locator(".user-row")).to_have_count(2)
        expect(page.locator(".user-row", has_text="Петро")).to_contain_text("Виробництво · Тестування")

        page.locator(".user-row", has_text="Петро").click()
        page.locator("[name=mode][value=own]").check()
        page.locator("[data-p='stock.delete']").check()
        expect(page.locator("[data-p='stock.view']")).to_be_checked()    # видалення тягне перегляд
        page.locator("[data-p='orders.view']").uncheck()
        expect(page.locator("[data-p='orders.edit']")).not_to_be_checked()  # без перегляду — без зміни
        page.locator("#save").click()
        assert "Збережено" in toast_text()
        expect(page.locator(".user-row", has_text="Петро")).to_contain_text("свої права")
        page.screenshot(path=str(SHOTS / "20_users.png"))

        page.locator(".user-row", has_text="ви").click()
        expect(page.locator("[name=active]")).to_be_disabled()           # себе не заблокувати
        expect(page.locator("#del")).to_have_count(0)                     # і не видалити

        page.goto(url + "#/roles")
        expect(page.locator(".list .row")).to_have_count(4)
        page.locator("a[href='#/role/new']").click()
        page.locator("#f [name=name]").fill("Тестувальник")
        page.locator("[data-p='orders.edit']").check()
        page.locator("#save").click()
        assert "Роль збережено" in toast_text()
        expect(page.locator(".list .row")).to_have_count(5)
        expect(page.locator(".list .row", has_text="Тестувальник")).to_contain_text("Замовлення: перегляд, зміна")
        page.screenshot(path=str(SHOTS / "21_roles.png"))

        # --- обмежені права: робимо демо-користувача «Лише перегляд» ---
        set_role = """(name) => {
            const d = JSON.parse(localStorage.getItem('sklad-demo-v1'));
            d.users['00000000-0000-0000-0000-00000000demo'].role_id = d.roles.find((r) => r.name === name).id;
            localStorage.setItem('sklad-demo-v1', JSON.stringify(d));
        }"""
        page.evaluate(set_role, "Лише перегляд")
        page.goto(url + "#/stock")
        page.reload()
        expect(page.locator(".row").first).to_be_visible()
        expect(page.locator("#nav [data-tab=inventory]")).to_have_count(0)
        expect(page.locator("[data-new]")).to_have_count(0)
        expect(page.locator(".bottom-actions")).to_have_count(0)
        page.locator(".row").first.click()
        expect(page.locator("[data-del]")).to_have_count(0)
        expect(page.locator(".action-grid .btn.in")).to_have_count(0)
        page.goto(url + "#/journal")
        expect(page.locator(".op").first).to_be_visible()
        expect(page.locator("[data-cancel]")).to_have_count(0)
        expect(page.locator("#types [data-trash]")).to_have_count(0)
        page.goto(url + "#/orders")
        expect(page.locator(".top-actions a")).to_have_count(0)
        page.locator(".order-row").first.click()
        expect(page.locator("#acts [data-to]")).to_have_count(0)
        expect(page.locator("#cmt")).to_have_count(0)
        page.goto(url + "#/item-edit/new")
        expect(page.locator("#top h1")).to_have_text("Немає доступу")
        page.goto(url + "#/more")
        expect(page.locator("a[href='#/users']")).to_have_count(0)
        page.screenshot(path=str(SHOTS / "22_viewer.png"), full_page=True)
        page.evaluate(set_role, "Адміністратор")
        page.reload()
        expect(page.locator("a[href='#/users']")).to_have_count(1)
        page.goto(url + "#/stock")

        # --- скан-модалка відкривається і приймає ручний код (камери в headless нема) ---
        page.locator("#scan").click()
        page.locator(".scan-manual input").fill("4820000000017")
        page.locator(".scan-manual button").click()
        expect(page.locator("#top h1")).to_have_text("Мотор 2207 1750KV")
        page.screenshot(path=str(SHOTS / "07_item.png"), full_page=True)

        # --- десктоп ---
        page.set_viewport_size({"width": 1280, "height": 800})
        page.goto(url + "#/stock")
        page.screenshot(path=str(SHOTS / "08_desktop.png"))
        page.goto(url + "#/journal")
        page.screenshot(path=str(SHOTS / "09_desktop_journal.png"))
        page.goto(url + "#/orders")
        page.locator(".order-row").first.click()
        expect(page.locator("#events .ev")).to_have_count(4)
        page.screenshot(path=str(SHOTS / "16_desktop_order.png"), full_page=True)

        # --- темна тема ---
        dark = browser.new_context(viewport={"width": 400, "height": 860}, color_scheme="dark")
        dark.route(re.compile(r".*/js/config\.js$"), DEMO_CONFIG)
        dp = dark.new_page()
        dp.goto(url + "#/stock")
        dp.evaluate("(d) => localStorage.setItem('sklad-demo-v1', d)", page.evaluate("localStorage.getItem('sklad-demo-v1')"))
        dp.reload()
        dp.locator(".row").first.wait_for()
        dp.screenshot(path=str(SHOTS / "10_dark.png"))

        # --- смужка «Є оновлення»: без нової версії її нема, з новою — є, кнопка перезавантажує ---
        page.wait_for_timeout(3500)
        expect(page.locator("#upd")).to_be_hidden()
        up = browser.new_context(viewport={"width": 400, "height": 860})
        up.route(re.compile(r".*/js/config\.js$"), DEMO_CONFIG)
        up.route(re.compile(r".*/version\.js\?check=.*"),
                 lambda r: r.fulfill(content_type="text/javascript", body="self.APP_VERSION = '9999-01-01.1';"))
        upg = up.new_page()
        upg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        upg.goto(url + "#/more")
        expect(upg.locator("main")).to_contain_text("версія 2026-")
        expect(upg.locator("#upd")).to_be_visible(timeout=10000)
        upg.screenshot(path=str(SHOTS / "23_update.png"))
        with upg.expect_navigation():
            upg.locator("#upd-go").click()
        expect(upg.locator("#upd")).to_be_hidden()  # після перезавантаження — доки не перевірить знову
        browser.close()
    httpd.shutdown()

    real = [e for e in errors if "favicon" not in e]
    if real:
        print("ПОМИЛКИ В КОНСОЛІ:\n" + "\n".join(real))
        return 1
    print("E2E OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
