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

        # --- нова позиція: число в «Одиниці виміру» відхиляється; повторна назва додає кількість до наявної ---
        page.goto(url + "#/item-edit/new")
        f = page.locator("#f")
        expect(f.locator("label.field", has=page.locator("[name=init_qty]"))).to_contain_text("Кількість на складі зараз")
        expect(f.locator("label.field", has=page.locator("[name=unit]"))).to_contain_text("Одиниця виміру (без числа)")
        f.locator("[name=name]").fill("Дубль тест")
        f.locator("[name=unit]").fill("100 шт")
        f.locator("#save").click()
        expect(page.locator(".toast", has_text="В «Одиниця виміру» — лише")).to_be_visible()
        expect(page.locator("#f")).to_be_visible()  # лишились у формі, нічого не створено
        f.locator("[name=unit]").fill("шт")
        f.locator("[name=init_qty]").fill("100")
        f.locator("#save").click()
        expect(page.locator(".big-qty b")).to_have_text("100")
        dup_url = page.url

        # та сама відмова при редагуванні наявної
        page.goto(page.url.replace("#/item/", "#/item-edit/"))
        page.locator("#f [name=unit]").fill("5 шт")
        page.locator("#save").click()
        expect(page.locator(".toast", has_text="В «Одиниця виміру» — лише")).to_be_visible()
        expect(page.locator("#f")).to_be_visible()

        # та сама назва іншим регістром + кількість → питання → прихід на наявну, без другої позиції
        page.goto(url + "#/item-edit/new")
        f.locator("[name=name]").fill("дубль ТЕСТ")
        f.locator("[name=init_qty]").fill("10")
        f.locator("#save").click()
        expect(page.locator(".modal")).to_contain_text("Позиція «Дубль тест» вже є — на складі 100 шт. Додати 10 шт до неї?")
        page.screenshot(path=str(SHOTS / "27_duplicate.png"))
        page.locator(".modal [data-r='1']").click()
        expect(page.locator(".toast", has_text="Додано 10 шт — разом 110")).to_be_visible()
        expect(page.locator(".big-qty b")).to_have_text("110")
        assert page.url == dup_url, (page.url, dup_url)  # картка наявної позиції
        expect(page.locator("#top h1")).to_have_text("Дубль тест")

        # без кількості — лише «Відкрити», залишок не міняється
        page.goto(url + "#/item-edit/new")
        f.locator("[name=name]").fill("ДУБЛЬ ТЕСТ")
        f.locator("#save").click()
        expect(page.locator(".modal")).to_contain_text("Відкрити її?")
        expect(page.locator(".modal [data-r='1']")).to_have_text("Відкрити")
        page.locator(".modal [data-r='1']").click()
        expect(page.locator(".big-qty b")).to_have_text("110")
        assert page.url == dup_url, (page.url, dup_url)

        page.goto(url + "#/stock")
        expect(page.locator(".row-title", has_text=re.compile("дубль тест", re.I))).to_have_count(1)  # не задвоїлась
        assert stock_qty(page, "Дубль тест") == "110"
        page.goto(url + "#/journal")
        expect(page.locator(".op", has_text="Додано повторно")).to_have_count(1)

        # --- редагування наявної позиції: поле кількості показує залишок і править його інвентаризацією ---
        page.goto(dup_url.replace("#/item/", "#/item-edit/"))
        qty_in = page.locator("#f [name=init_qty]")
        expect(qty_in).to_have_value("110")
        expect(qty_in).to_be_enabled()
        qty_in.fill("-3")
        page.locator("#save").click()
        expect(page.locator(".toast", has_text="Кількість на складі — невідʼємне число")).to_be_visible()
        expect(page.locator("#f")).to_be_visible()
        qty_in.fill("95")
        page.locator("#save").click()
        expect(page.locator(".big-qty b")).to_have_text("95")
        assert page.url == dup_url, (page.url, dup_url)
        adj_rows = page.locator("#hist .hist-row", has_text="Інвентаризація")
        expect(adj_rows).to_have_count(1)
        expect(adj_rows).to_contain_text("Виправлено в картці позиції")
        expect(adj_rows.locator("b")).to_have_text("−15")
        expect(page.locator("#hist .hist-row")).to_have_count(3)
        page.screenshot(path=str(SHOTS / "28_item_qty_edit.png"), full_page=True)
        # збереження без змін (і з порожнім полем) — залишок той самий, нової операції немає
        for val in (None, ""):
            page.goto(dup_url.replace("#/item/", "#/item-edit/"))
            expect(page.locator("#f [name=init_qty]")).to_have_value("95")
            if val is not None:
                page.locator("#f [name=init_qty]").fill(val)
            page.locator("#save").click()
            expect(page.locator(".big-qty b")).to_have_text("95")
            expect(page.locator("#hist .hist-row")).to_have_count(3)
        page.goto(url + "#/journal")
        expect(page.locator(".op", has_text="Виправлено в картці позиції")).to_have_count(1)

        # --- випадний список у полях «Категорія / Місце / Одиниця» (замість datalist) ---
        page.goto(url + "#/item-edit/new")
        f = page.locator("#f")
        expect(f.locator("datalist")).to_have_count(0)
        cat = f.locator("[name=category]")
        cat_list = f.locator(".combo", has=page.locator("[name=category]")).locator(".combo-list")
        expect(cat_list).to_be_hidden()
        cat.click()
        expect(cat_list).to_be_visible()
        for c in ("Мотори", "Камери", "Кабелі", "Електроніка"):
            expect(cat_list.locator(".picker-opt", has_text=c)).to_have_count(1)
        # список лежить під полем, у межах екрана, і його не перекриває наступне поле
        ib, lb = cat.bounding_box(), cat_list.bounding_box()
        assert lb["y"] >= ib["y"] + ib["height"] and lb["x"] >= 0 and lb["x"] + lb["width"] <= 400, (ib, lb)
        ob = cat_list.locator(".picker-opt").first.bounding_box()
        assert ob["height"] >= 44, ob
        assert page.evaluate("""() => { const o = document.querySelector('.combo-list:not([hidden]) .picker-opt');
            const r = o.getBoundingClientRect();
            return o.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }""")
        expect(page.locator(".toast")).to_have_count(0, timeout=15000)  # старі сповіщення не мають закривати знімок
        page.screenshot(path=str(SHOTS / "29_category_dropdown.png"))
        cat.press_sequentially("кам")
        expect(cat_list.locator(".picker-opt")).to_have_count(1)
        expect(cat_list.locator(".picker-opt")).to_contain_text("Камери")
        cat_list.locator(".picker-opt").click()
        expect(cat).to_have_value("Камери")
        expect(cat_list).to_be_hidden()
        # нове значення, якого в списку немає, просто друкується; список без збігів не показується
        cat.fill("Пропелери")
        expect(cat).to_have_value("Пропелери")
        expect(cat_list).to_be_hidden()
        # клавіатура: стрілка + Enter вибирає і не відправляє форму; Escape ховає
        cat.fill("")
        expect(cat_list).to_be_visible()
        cat.press("ArrowDown")
        cat.press("Enter")
        expect(page.locator("#f")).to_be_visible()
        expect(cat_list).to_be_hidden()
        assert cat.input_value() != "", "Enter мав вибрати підсвічений варіант"
        cat.press("ArrowDown")
        expect(cat_list).to_be_visible()
        cat.press("Escape")
        expect(cat_list).to_be_hidden()
        # одиниця виміру: за замовчуванням «шт», дотик показує всі одиниці, а не лише «шт»
        unit = f.locator("[name=unit]")
        unit_list = f.locator(".combo", has=page.locator("[name=unit]")).locator(".combo-list")
        expect(unit).to_have_value("шт")
        unit.click()
        expect(cat_list).to_be_hidden()
        expect(unit_list.locator(".picker-opt", has_text="кг")).to_have_count(1)
        unit_list.locator(".picker-opt", has_text="кг").click()
        expect(unit).to_have_value("кг")
        # втрата фокусу ховає список
        f.locator("[name=location]").click()
        expect(f.locator(".combo", has=page.locator("[name=location]")).locator(".combo-list")).to_be_visible()
        f.locator("[name=name]").click()
        expect(f.locator(".combo-list:visible")).to_have_count(0)
        f.locator("a", has_text="Скасувати").click()  # нічого не зберігаємо
        expect(page.locator("#top h1")).to_have_text("Залишки")

        # --- порядок позицій і категорій: режим «Порядок», стрілки, перетягування, збереження ---
        add_item("Мотор 2306 2400KV", cat="Мотори")  # друга позиція в категорії — для порядку всередині неї
        page.goto(url + "#/stock")
        titles = lambda: page.locator("#list .row-title").all_inner_texts()
        cat_chips = lambda: page.eval_on_selector_all("#chips [data-cat]", "els => els.map((e) => e.dataset.cat).filter(Boolean)")
        e = titles()
        assert len(e) == 6 and e[-1] == "Мотор 2306 2400KV", e  # нова позиція — в кінці
        c = cat_chips()
        assert c == sorted(c) and len(c) == 4, c  # без збереженого порядку — за абеткою
        page.locator("[data-order]").click()
        expect(page.locator("#top h1")).to_have_text("Залишки — порядок")
        expect(page.locator("#q")).to_have_count(0)
        expect(page.locator(".sort-row")).to_have_count(6)
        assert titles() == e and cat_chips() == c
        # дотик до рядка в режимі картку не відкриває
        page.locator(".sort-row .row-title").first.click()
        page.locator(".sort-row .row-meta").nth(1).click()
        expect(page.locator("#top h1")).to_have_text("Залишки — порядок")
        assert page.url.endswith("#/stock"), page.url
        # ручка не дає сторінці прокручуватись під пальцем
        assert page.locator(".sort-row [data-grip]").first.evaluate("(g) => getComputedStyle(g).touchAction") == "none"
        assert page.locator(".sort-chip [data-grip]").first.evaluate("(g) => getComputedStyle(g).touchAction") == "none"

        # стрілка ▼ на першому рядку
        expect(page.locator(".sort-row").first.locator("[data-mv='-1']")).to_be_disabled()
        page.locator(".sort-row").first.locator("[data-mv='1']").click()
        e = [e[1], e[0]] + e[2:]
        assert titles() == e, titles()
        expect(page.locator(".sort-row").first.locator("[data-mv='-1']")).to_be_disabled()
        expect(page.locator(".sort-row").nth(1).locator("[data-mv='-1']")).to_be_enabled()

        # перетягування мишею: останній рядок — на самий верх
        def center(loc):
            b = loc.bounding_box()
            return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

        expect(page.locator(".toast")).to_have_count(0, timeout=15000)  # сповіщення не має закривати знімок
        gx, gy = center(page.locator(".sort-row").last.locator("[data-grip]"))
        top_row = page.locator(".sort-row").first.bounding_box()
        page.mouse.move(gx, gy)
        page.mouse.down()
        page.mouse.move(gx, top_row["y"] + 6, steps=15)
        expect(page.locator(".sort-row.dragging")).to_have_count(1)
        expect(page.locator(".sort-row.dragging .row-title")).to_have_text(e[-1])
        page.screenshot(path=str(SHOTS / "30_reorder.png"))
        page.mouse.up()
        expect(page.locator(".dragging")).to_have_count(0)
        e = [e[-1]] + e[:-1]
        assert titles() == e, titles()
        expect(page.locator("#top h1")).to_have_text("Залишки — порядок")

        # порядок усередині категорії: дотик до назви категорії фільтрує, сусідні категорії лишаються де були
        page.locator(".sort-chip[data-cat='Мотори'] [data-grip]").click()
        expect(page.locator(".sort-chip.on")).to_have_attribute("data-cat", "Мотори")
        motors = [t for t in e if t.startswith("Мотор")]
        assert titles() == motors and len(motors) == 2, titles()
        page.locator(".sort-row").last.locator("[data-mv='-1']").click()
        assert titles() == motors[::-1], titles()
        swap = dict(zip(motors, motors[::-1]))
        e = [swap.get(t, t) for t in e]
        page.locator("#chips .chip[data-cat='']").click()
        assert titles() == e, titles()

        # автопрокрутка: на низькому екрані перший рядок тягнемо до нижнього краю — сторінка їде сама
        page.set_viewport_size({"width": 400, "height": 420})
        page.evaluate("window.scrollTo(0, 0)")
        gx, gy = center(page.locator(".sort-row").first.locator("[data-grip]"))
        page.mouse.move(gx, gy)
        page.mouse.down()
        page.mouse.move(gx, 408, steps=10)
        page.wait_for_function("window.scrollY > 40")
        page.wait_for_function("window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2")
        last = page.locator(".sort-row").last.bounding_box()
        page.mouse.move(gx, last["y"] + last["height"] - 6, steps=5)
        page.mouse.up()
        e = e[1:] + [e[0]]
        assert titles() == e, titles()
        page.set_viewport_size({"width": 400, "height": 860})
        page.evaluate("window.scrollTo(0, 0)")

        # категорії: стрілка ▶ і перетягування останньої кнопки на перше місце
        expect(page.locator(".sort-chip").first.locator("[data-mv='-1']")).to_be_disabled()
        page.locator(".sort-chip").first.locator("[data-mv='1']").click()
        c = [c[1], c[0]] + c[2:]
        assert cat_chips() == c, cat_chips()
        gx, gy = center(page.locator(".sort-chip").last.locator("[data-grip]"))
        first_chip = page.locator(".sort-chip").first.bounding_box()
        tx, ty = first_chip["x"] + first_chip["width"] * 0.25, first_chip["y"] + first_chip["height"] / 2
        page.mouse.move(gx, gy)
        page.mouse.down()
        page.mouse.move(tx, ty, steps=15)
        page.mouse.move(tx + 1, ty)
        page.mouse.move(tx, ty)
        page.mouse.up()
        c = [c[-1]] + c[:-1]
        assert cat_chips() == c, cat_chips()
        expect(page.locator(".sort-chip.on")).to_have_count(0)  # відпускання після перетягування категорію не вибирає
        assert titles() == e, titles()
        expect(page.locator(".toast")).to_have_count(0)

        # «Готово»: звичайний список у новому порядку, дотик знову відкриває картку
        page.locator("[data-done]").click()
        expect(page.locator("#top h1")).to_have_text("Залишки")
        expect(page.locator("#list a.row")).to_have_count(6)
        assert titles() == e and cat_chips() == c, (titles(), cat_chips())
        page.locator("#list a.row").first.click()
        expect(page.locator("#top h1")).to_have_text(e[0])
        # порядок зберігся після перезавантаження; той самий — в інвентаризації й у списку категорій
        page.goto(url + "#/stock")
        page.reload()
        expect(page.locator("#list a.row")).to_have_count(6)
        assert titles() == e and cat_chips() == c, (titles(), cat_chips())
        page.goto(url + "#/inventory")
        assert page.locator(".inv-row .line-name b").all_inner_texts() == e
        assert page.locator("#cat option").all_inner_texts()[1:] == c
        # пішли з екрана в режимі «Порядок» — повернулись у звичайний список
        page.goto(url + "#/stock")
        page.locator("[data-order]").click()
        expect(page.locator(".sort-row")).to_have_count(6)
        page.goto(url + "#/journal")
        page.goto(url + "#/stock")
        expect(page.locator("#list a.row")).to_have_count(6)
        # без права «Зміна» кнопки «Порядок» немає — перевіряється нижче разом з іншими обмеженнями

        # демо-дані, збережені до появи порядку: позиції стають за назвою, як було досі
        page.evaluate("""() => {
            const d = JSON.parse(localStorage.getItem('sklad-demo-v1'));
            for (const i of d.items) delete i.sort_order;
            delete d.settings.category_order;
            localStorage.setItem('sklad-demo-v1', JSON.stringify(d));
        }""")
        page.reload()
        expect(page.locator("#list a.row")).to_have_count(6)
        assert titles() == sorted(e) and cat_chips() == sorted(c), (titles(), cat_chips())

        # --- користувачі та ролі (у демо — записи без входу) ---
        page.goto(url + "#/more")
        page.locator("a[href='#/users']").click()
        expect(page.locator(".user-row")).to_have_count(1)
        # демо-користувач — головний адміністратор: бейдж і керування
        expect(page.locator(".user-row .owner-tag")).to_have_text("Головний адміністратор")
        expect(page.locator("#ro-note")).to_have_count(0)
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
        # очима головного: бейдж лише біля нього, рядки — посилання на картки, є «+ Користувач»
        expect(page.locator(".user-row .owner-tag")).to_have_count(1)
        expect(page.locator(".user-row", has_text="ви").locator(".owner-tag")).to_have_count(1)
        expect(page.locator("a.user-row")).to_have_count(2)
        expect(page.locator("a[href='#/user/new']")).to_have_count(1)
        page.screenshot(path=str(SHOTS / "32_owner_users.png"))

        page.locator(".user-row", has_text="ви").click()
        expect(page.locator("[name=active]")).to_be_disabled()           # себе не заблокувати
        expect(page.locator("#del")).to_have_count(0)                     # і не видалити
        # головний не зніме із себе роль і права
        expect(page.locator("#owner-note")).to_contain_text("головний адміністратор")
        expect(page.locator("#f [name=role]")).to_be_disabled()
        expect(page.locator("#f [name=mode][value=own]")).to_be_disabled()
        expect(page.locator("[data-p='admin']")).to_be_disabled()
        page.locator("#f [name=name]").fill("Демо")
        page.locator("#save").click()                                     # імʼя зберігається, роль лишається
        assert "Збережено" in toast_text()
        expect(page.locator(".user-row", has_text="ви").locator(".row-meta")).to_contain_text("Адміністратор")
        owner_errs = page.evaluate("""async () => {
            const { api } = await import('./js/api.js');
            const me = '00000000-0000-0000-0000-00000000demo';
            const roles = await api.roles();
            const role = (n) => roles.find((r) => r.name === n).id;
            const out = [];
            for (const f of [
              () => api.updateUser({ id: me, name: 'Демо', role_id: role('Адміністратор'), department_id: null, perms: null, active: false }),
              () => api.updateUser({ id: me, name: 'Демо', role_id: role('Старший користувач'), department_id: null, perms: null, active: true }),
              () => api.deleteUser(me),
              () => api.deleteRole(role('Адміністратор')),
            ]) { try { await f(); out.push('ok'); } catch (e) { out.push(e.message); } }
            return out;
        }""")
        assert owner_errs[0] == "Не можна заблокувати самого себе", owner_errs
        assert owner_errs[1].startswith("Не можна забрати права адміністратора"), owner_errs
        assert owner_errs[2] == "Не можна видалити самого себе", owner_errs
        assert owner_errs[3].startswith(("Має лишитися", "Головного адміністратора не можна")), owner_errs

        page.goto(url + "#/roles")
        expect(page.locator(".list .row")).to_have_count(6)               # чотири стартові + дві нові
        expect(page.locator(".list .row", has_text="Звичайний користувач").locator(".row-meta")).to_have_text(
            "Склад: перегляд · Прихід / видаток: перегляд · Комплекти: перегляд · Замовлення: перегляд")
        expect(page.locator(".list .row", has_text="Старший користувач").locator(".row-meta")).to_have_text(
            "Склад: перегляд, зміна · Прихід / видаток: перегляд, зміна · Комплекти: перегляд, зміна · Замовлення: перегляд, зміна · усі відділи")
        new_roles = page.evaluate("""() => Object.fromEntries(JSON.parse(localStorage.getItem('sklad-demo-v1')).roles.map((r) => [r.name, r.perms]))""")
        assert new_roles["Звичайний користувач"] == ["stock.view", "ops.view", "kits.view", "orders.view"], new_roles
        assert new_roles["Старший користувач"] == ["stock.view", "stock.edit", "ops.view", "ops.edit", "kits.view", "kits.edit",
                                                    "orders.view", "orders.edit", "orders.all"], new_roles
        assert new_roles["Лише перегляд"] == ["stock.view", "ops.view", "kits.view", "orders.view", "orders.all"]  # старі не зачеплено
        page.locator("a[href='#/role/new']").click()
        page.locator("#f [name=name]").fill("Тестувальник")
        page.locator("[data-p='orders.edit']").check()
        page.locator("#save").click()
        assert "Роль збережено" in toast_text()
        expect(page.locator(".list .row")).to_have_count(7)
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
        expect(page.locator("[data-order]")).to_have_count(0)
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

        # --- роль «Адміністратор», але не головний: списки лише для читання ---
        petro = page.evaluate("""() => {
            const d = JSON.parse(localStorage.getItem('sklad-demo-v1'));
            const id = Object.keys(d.users).find((k) => d.users[k].email === 'petro@example.com');
            Object.assign(d.users[id], { role_id: d.roles.find((r) => r.name === 'Адміністратор').id, perms: null });
            d.owner = id;                       // головний — Петро, демо-користувач лишається адміністратором
            localStorage.setItem('sklad-demo-v1', JSON.stringify(d));
            return id;
        }""")
        page.reload()
        expect(page.locator("a[href='#/users']")).to_contain_text("лише перегляд")
        expect(page.locator("a[href='#/notifications']")).to_have_count(1)   # решта адмінського на місці
        expect(page.locator("a[href='#/backups']")).to_have_count(1)
        page.locator("a[href='#/users']").click()
        expect(page.locator(".user-row")).to_have_count(2)
        expect(page.locator("#ro-note")).to_contain_text("Права надає лише головний адміністратор")
        expect(page.locator("#ro-note")).to_contain_text("Петро")
        expect(page.locator("a.user-row")).to_have_count(0)                  # рядки — не посилання
        expect(page.locator("a[href='#/user/new']")).to_have_count(0)
        expect(page.locator(".user-row", has_text="Петро").locator(".owner-tag")).to_have_count(1)
        expect(page.locator(".user-row", has_text="ви").locator(".owner-tag")).to_have_count(0)
        page.screenshot(path=str(SHOTS / "33_admin_not_owner.png"))
        for h in ("#/user/new", f"#/user/{petro}", "#/user/00000000-0000-0000-0000-00000000demo"):
            page.goto(url + h)                                               # прямі адреси форм — той самий список
            expect(page.locator("#ro-note")).to_be_visible()
            expect(page.locator("#f")).to_have_count(0)
        page.goto(url + "#/roles")
        expect(page.locator(".list .row")).to_have_count(7)
        expect(page.locator("#ro-note")).to_be_visible()
        expect(page.locator("a.row")).to_have_count(0)
        expect(page.locator("a[href='#/role/new']")).to_have_count(0)
        page.goto(url + "#/role/new")
        expect(page.locator("#f")).to_have_count(0)
        expect(page.locator(".list .row")).to_have_count(7)
        # і в обхід кнопок — та сама відмова, що й на сервері
        denied = page.evaluate("""async (petro) => {
            const { api } = await import('./js/api.js');
            const roles = await api.roles();
            const me = '00000000-0000-0000-0000-00000000demo';
            const out = [];
            for (const f of [
              () => api.createUser({ email: 'x@example.com', password: 'secret1', name: 'X' }),
              () => api.updateUser({ id: petro, name: 'Петро', role_id: null, department_id: null, perms: null, active: false }),
              () => api.updateUser({ id: me, name: 'Демо', role_id: roles[0].id, department_id: null, perms: ['admin'], active: true }),
              () => api.setUserPassword(petro, 'secret12'),
              () => api.deleteUser(petro),
              () => api.saveRole({ name: 'Нова', perms: [] }),
              () => api.saveRole({ id: roles[0].id, name: roles[0].name, perms: ['admin'] }),
              () => api.deleteRole(roles[0].id),
            ]) { try { await f(); out.push('ok'); } catch (e) { out.push(e.message); } }
            const d = JSON.parse(localStorage.getItem('sklad-demo-v1'));
            return { out, users: Object.keys(d.users).length, roles: d.roles.length, owner: d.owner };
        }""", petro)
        assert denied["out"] == ["Права надає лише головний адміністратор"] * 8, denied
        assert denied["users"] == 2 and denied["roles"] == 7 and denied["owner"] == petro, denied

        # --- демо-дані, збережені до появи головного й нових ролей: з'являються самі, видалена роль не вертається ---
        page.evaluate("""() => {
            const d = JSON.parse(localStorage.getItem('sklad-demo-v1'));
            const petro = Object.keys(d.users).find((k) => d.users[k].email === 'petro@example.com');
            d.users[petro].role_id = d.roles.find((r) => r.name === 'Виробництво').id;
            delete d.owner;
            delete d.roles_seed;
            d.roles = d.roles.filter((r) => !['Звичайний користувач', 'Старший користувач'].includes(r.name));
            localStorage.setItem('sklad-demo-v1', JSON.stringify(d));
        }""")
        page.goto(url + "#/users")
        page.reload()
        expect(page.locator(".user-row", has_text="ви").locator(".owner-tag")).to_have_count(1)  # єдиний адміністратор — головний
        expect(page.locator(".user-row .owner-tag")).to_have_count(1)
        expect(page.locator("a[href='#/user/new']")).to_have_count(1)
        page.goto(url + "#/roles")
        expect(page.locator(".list .row")).to_have_count(7)
        page.locator(".list .row", has_text="Звичайний користувач").click()
        page.locator("#del").click()
        page.locator(".modal [data-r='1']").click()
        expect(page.locator(".list .row")).to_have_count(6)
        page.reload()
        expect(page.locator(".list .row")).to_have_count(6)                  # видалена не повернулась
        expect(page.locator(".list .row", has_text="Звичайний користувач")).to_have_count(0)
        expect(page.locator(".list .row", has_text="Старший користувач")).to_have_count(1)
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
