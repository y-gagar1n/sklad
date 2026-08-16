// Тесты чистой логики склада. Запуск: node --test tests/  или ./test.sh
// Без зависимостей — только встроенный node:test + node:assert.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseISO,
  toISO,
  addDays,
  diffDays,
  weekday,
  isWorkingDay,
  countWorkingDays,
  stockOf,
  stockAsOf,
  sumConsumption,
  averageDailyConsumption,
  weeklyAverage,
  monthlyAverage,
  daysOfStock,
  recommendedOrder,
  urgency,
  itemSummary,
  URGENCY,
} from "../assets/calc.js";

const WD = [1, 2, 3, 4, 5]; // Пн–Пт

// ── Даты ─────────────────────────────────────────────────────────────────────

test("toISO/parseISO — roundtrip", () => {
  assert.equal(toISO(parseISO("2026-08-16")), "2026-08-16");
});

test("addDays через границу месяца", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("diffDays", () => {
  assert.equal(diffDays("2026-08-01", "2026-08-16"), 15);
  assert.equal(diffDays("2026-08-16", "2026-08-01"), -15);
  assert.equal(diffDays("2026-08-16", "2026-08-16"), 0);
});

test("weekday и isWorkingDay", () => {
  // 2026-08-16 — воскресенье.
  assert.equal(weekday("2026-08-16"), 0);
  assert.equal(isWorkingDay("2026-08-16", WD), false);
  assert.equal(isWorkingDay("2026-08-17", WD), true); // понедельник
});

test("countWorkingDays за полную неделю = 5", () => {
  // Пн 2026-08-17 … Вс 2026-08-23.
  assert.equal(countWorkingDays("2026-08-17", "2026-08-23", WD), 5);
});

test("countWorkingDays при from>to = 0", () => {
  assert.equal(countWorkingDays("2026-08-23", "2026-08-17", WD), 0);
});

// ── Остатки ──────────────────────────────────────────────────────────────────

const mv = (date, type, qty, adjust = false) => ({ date, type, qty, adjust });

test("stockOf = приход - расход", () => {
  const m = [
    mv("2026-08-01", "in", 100),
    mv("2026-08-02", "out", 30),
    mv("2026-08-03", "out", 20),
  ];
  assert.equal(stockOf(m), 50);
});

test("stockOf учитывает инвентаризацию (adjust)", () => {
  const m = [
    mv("2026-08-01", "in", 100),
    mv("2026-08-02", "out", 30),
    mv("2026-08-03", "out", 10, true), // инвентаризация: списали недостачу
  ];
  assert.equal(stockOf(m), 60);
});

test("stockAsOf игнорирует будущие движения", () => {
  const m = [
    mv("2026-08-01", "in", 100),
    mv("2026-08-05", "out", 40),
    mv("2026-08-10", "out", 10),
  ];
  assert.equal(stockAsOf(m, "2026-08-05"), 60);
  assert.equal(stockAsOf(m, "2026-08-10"), 50);
  assert.equal(stockAsOf(m, "2026-07-31"), 0);
});

// ── Расход и средние ─────────────────────────────────────────────────────────

test("sumConsumption считает только 'out' без adjust, в окне", () => {
  const m = [
    mv("2026-08-01", "in", 100),
    mv("2026-08-02", "out", 30),
    mv("2026-08-05", "out", 20),
    mv("2026-08-06", "out", 5, true), // корректировка — не расход
    mv("2026-08-20", "out", 99), // вне окна
  ];
  assert.equal(sumConsumption(m, "2026-08-01", "2026-08-10"), 50);
});

test("averageDailyConsumption — рабочие дни", () => {
  // Приход + 5 дней расхода по 10 (Пн–Пт 17–21 авг), всего 50.
  const m = [
    mv("2026-08-17", "in", 100),
    mv("2026-08-17", "out", 10),
    mv("2026-08-18", "out", 10),
    mv("2026-08-19", "out", 10),
    mv("2026-08-20", "out", 10),
    mv("2026-08-21", "out", 10),
  ];
  // asOf = пятница, окно 30 дней, но первое движение 17-го → делим на 5 раб. дней.
  const avg = averageDailyConsumption(m, {
    asOf: "2026-08-21",
    windowDays: 30,
    workingDaysOnly: true,
    workingDays: WD,
  });
  assert.equal(avg, 10);
});

test("averageDailyConsumption — календарные дни", () => {
  const m = [
    mv("2026-08-17", "out", 10),
    mv("2026-08-18", "out", 10),
    mv("2026-08-19", "out", 10),
  ];
  // 30 за период с 17 по 19 = 3 календарных дня → 10/день.
  const avg = averageDailyConsumption(m, {
    asOf: "2026-08-19",
    windowDays: 30,
    workingDaysOnly: false,
    workingDays: WD,
  });
  assert.equal(avg, 10);
});

test("averageDailyConsumption без движений = 0", () => {
  const avg = averageDailyConsumption([], {
    asOf: "2026-08-21",
    workingDays: WD,
  });
  assert.equal(avg, 0);
});

test("weeklyAverage и monthlyAverage", () => {
  assert.equal(weeklyAverage(10, true, WD), 50); // 5 раб. дней
  assert.equal(weeklyAverage(10, false, WD), 70); // 7 дней
  assert.equal(monthlyAverage(10, true, WD), round2(10 * 5 * 4.345));
  assert.equal(monthlyAverage(10, false, WD), round2(10 * 30.437));
});

function round2(x) {
  return Math.round(x * 100) / 100;
}

// ── Заказ и срочность ─────────────────────────────────────────────────────────

test("daysOfStock", () => {
  assert.equal(daysOfStock(50, 10), 5);
  assert.equal(daysOfStock(50, 0), Infinity);
});

test("recommendedOrder покрывает месяц + минимум минус остаток", () => {
  // Месячный расход 200, минимум 50, на складе 60 → нужно 200+50-60=190.
  assert.equal(recommendedOrder(60, 200, 50), 190);
  // Всего в достатке → 0.
  assert.equal(recommendedOrder(300, 200, 50), 0);
  // Округление вверх.
  assert.equal(recommendedOrder(0, 10.2, 0), 11);
});

test("urgency: critical при остатке ниже минимума", () => {
  assert.equal(urgency(5, 10, 1), URGENCY.CRITICAL);
});

test("urgency: critical если хватит меньше недели", () => {
  // остаток 6, расход 1/день → 6 дней < 7.
  assert.equal(urgency(6, 0, 1), URGENCY.CRITICAL);
});

test("urgency: soon при 21 > дней >= 7", () => {
  // остаток 100, расход 10/день → 10 дней.
  assert.equal(urgency(100, 0, 10), URGENCY.SOON);
});

test("urgency: ok при большом запасе", () => {
  // остаток 300, расход 10/день → 30 дней.
  assert.equal(urgency(300, 0, 10), URGENCY.OK);
});

test("urgency: ok если расход нулевой и остаток выше минимума", () => {
  assert.equal(urgency(100, 10, 0), URGENCY.OK);
});

test("urgency: ok при нулевом остатке без минимума и без расхода", () => {
  // Импортированная позиция без расхода и без заданного минимума — не «срочно».
  assert.equal(urgency(0, 0, 0), URGENCY.OK);
});

test("urgency: critical при пустом остатке и наличии расхода", () => {
  assert.equal(urgency(0, 0, 5), URGENCY.CRITICAL);
});

// ── Сводка ───────────────────────────────────────────────────────────────────

test("itemSummary собирает всё вместе", () => {
  const m = [
    mv("2026-08-17", "in", 100),
    mv("2026-08-18", "out", 10),
    mv("2026-08-19", "out", 10),
    mv("2026-08-20", "out", 10),
    mv("2026-08-21", "out", 10),
  ];
  const s = itemSummary(
    m,
    { minStock: 20 },
    {
      asOf: "2026-08-21",
      windowDays: 30,
      workingDaysOnly: true,
      workingDays: WD,
    },
  );
  assert.equal(s.stock, 60); // 100 - 40
  assert.ok(s.dailyAvg > 0);
  assert.ok(s.monthlyAvg > s.weeklyAvg);
  assert.ok(s.order >= 0);
  assert.ok([URGENCY.OK, URGENCY.SOON, URGENCY.CRITICAL].includes(s.urgency));
});
