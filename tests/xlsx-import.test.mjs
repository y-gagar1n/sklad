// Тесты чистых помощников разбора Excel (без реального файла — только логика).
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "../assets/xlsx-import.js";

const {
  serialToISO,
  mapColumns,
  dailyColumns,
  parseSheet,
  readSharedStrings,
  floorFromMarker,
  categoryKey,
  isDataSheet,
  FLOOR_MARKER,
} = _internals;

test("serialToISO: Excel-сериал → дата", () => {
  assert.equal(serialToISO(46223), "2026-07-20"); // из реального файла: «с 20.07»
  assert.equal(serialToISO(25569), "1970-01-01"); // эпоха
  assert.equal(serialToISO(46237), "2026-08-03"); // первый день августовской сводки
});

test("dailyColumns: пары приход/расход с датой из строки над шапкой", () => {
  // Строка дат (Excel-сериалы) и шапка «Приход»/«Расход» + месячные итоги.
  const dateCells = { 3: "46237", 4: "46237", 5: "46238", 6: "46238", 45: "46266" };
  const headerCells = {
    3: "Приход ",
    4: "Расход",
    5: "приход ",
    6: "расход",
    45: "Итого остаток", // итоговые колонки не считаем дневными
    46: "Итого расход за месяц",
  };
  const cols = dailyColumns(headerCells, dateCells);
  assert.deepEqual(cols, [
    { idx: 3, type: "in", date: "2026-08-03" },
    { idx: 4, type: "out", date: "2026-08-03" },
    { idx: 5, type: "in", date: "2026-08-04" },
    { idx: 6, type: "out", date: "2026-08-04" },
  ]);
});

test("dailyColumns: без строки дат — ничего не берём", () => {
  assert.deepEqual(dailyColumns({ 3: "Приход" }, null), []);
});

test("readSharedStrings: собирает строки, включая rich-text", () => {
  const xml =
    '<sst><si><t>Молоко</t></si><si><r><t>Кофе</t></r><r><t> 500</t></r></si></sst>';
  assert.deepEqual(readSharedStrings(xml), ["Молоко", "Кофе 500"]);
});

test("parseSheet: shared-строки, inline и числа по адресам", () => {
  const shared = ["Категория", "Молоко"];
  const xml =
    '<sheetData>' +
    '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Сыр</t></is></c><c r="C3"><v>12.5</v></c></row>' +
    "</sheetData>";
  const rows = parseSheet(xml, shared);
  assert.equal(rows[2][1], "Категория"); // A2
  assert.equal(rows[2][2], "Молоко"); // B2
  assert.equal(rows[3][1], "Сыр"); // A3 inline
  assert.equal(rows[3][3], "12.5"); // C3 число
});

test("mapColumns: распознаёт колонки по заголовкам (неделя)", () => {
  const header = {
    1: "Категория",
    2: "наименование",
    3: "Ост ",
    17: "ост итого",
    18: "Итого расход за неделю",
    19: "Запас рабочих дней",
  };
  const cols = mapColumns(header);
  assert.equal(cols.category, 1);
  assert.equal(cols.name, 2);
  assert.equal(cols.balance, 17); // самый правый «ост …итого»
  assert.equal(cols.consumption, 18);
  assert.equal(cols.consPeriod, "week");
});

test("floorFromMarker: определяет этаж по разным подписям", () => {
  assert.equal(floorFromMarker("ВТОРОЙ ЭТАЖ"), 2);
  assert.equal(floorFromMarker("на 2м этаже на складе"), 2);
  assert.equal(floorFromMarker("3 этаж"), 3);
  assert.equal(floorFromMarker("третий этаж"), 3);
  assert.equal(floorFromMarker("этаж"), 2); // по умолчанию второй
});

test("FLOOR_MARKER срабатывает на строках-разделителях этажа", () => {
  assert.ok(FLOOR_MARKER.test("ВТОРОЙ ЭТАЖ"));
  assert.ok(FLOOR_MARKER.test("на 2м этаже на складе"));
  assert.ok(!FLOOR_MARKER.test("Молоко")); // обычный товар — не разделитель
});

test("categoryKey: отбрасывает хвостовую единицу измерения", () => {
  assert.equal(categoryKey("Мед гр"), categoryKey("Мед"));
  assert.equal(categoryKey("Нутелла гр"), categoryKey("Нутелла"));
  assert.equal(categoryKey("Соль"), categoryKey("соль")); // регистр
  // не трогаем, если хвост — не единица
  assert.notEqual(categoryKey("Кофе 500 гр./уп"), categoryKey("Кофе"));
  assert.notEqual(categoryKey("Корица в пачке"), categoryKey("Корица"));
});

test("isDataSheet: берём только месячные листы, недельные и служебные — нет", () => {
  // Месячные сводные — берём.
  assert.ok(isDataSheet("Продукты Август"));
  assert.ok(isDataSheet("Хозка Август 26"));
  assert.ok(isDataSheet("Продукты Сентябрь")); // правило переживает смену месяца
  // Недельные с диапазонами дат — игнорируем.
  assert.ok(!isDataSheet("Продукты с 20.07 - 24.07"));
  assert.ok(!isDataSheet("Продукты 03.08-07.08"));
  assert.ok(!isDataSheet("Хоз-ка 03.08.-07.08."));
  // Служебные — игнорируем.
  assert.ok(!isDataSheet("Заказать - инфо"));
  assert.ok(!isDataSheet("Лист11"));
});

test("mapColumns: месячный лист и «остаток на конец мес-ца»", () => {
  const header = {
    1: "наименование",
    24: "ост итого",
    47: "Остаток на конец мес-ца",
    49: "Итого расход за месяц",
  };
  const cols = mapColumns(header);
  assert.equal(cols.name, 1);
  assert.equal(cols.category, null); // у хозтоваров нет колонки категории
  assert.equal(cols.balance, 47); // берём самый правый остаток-итог
  assert.equal(cols.consumption, 49);
  assert.equal(cols.consPeriod, "month");
});
