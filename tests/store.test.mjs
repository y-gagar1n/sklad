// Тесты хранилища: этажи, перенос, защита от отрицательного остатка.
// Подменяем localStorage in-memory, чтобы гонять модуль в node.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const store = await import("../assets/store.js");

function fresh() {
  store.replaceState({}); // сброс к нормализованному пустому (создаётся 1 этаж)
}

test("по умолчанию есть один этаж и активный этаж задан", () => {
  fresh();
  assert.equal(store.floors().length, 1);
  assert.ok(store.getActiveFloorId());
});

test("остаток считается по активному этажу", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  store.addMovement(it.id, { type: "in", qty: 20 });
  store.addMovement(it.id, { type: "out", qty: 5 });
  assert.equal(store.stockForItem(it.id), 15);
});

test("перенос уменьшает на исходном и увеличивает на целевом этаже", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  const f1 = store.getActiveFloorId();
  store.addMovement(it.id, { type: "in", qty: 20, floorId: f1 });
  const f2 = store.addFloor("Этаж 2");

  const ok = store.transferStock(it.id, f1, f2.id, 8);
  assert.equal(ok, true);
  assert.equal(store.stockForItem(it.id, f1), 12);
  assert.equal(store.stockForItem(it.id, f2.id), 8);
});

test("перенос больше остатка запрещён (возврат false, остаток не меняется)", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  const f1 = store.getActiveFloorId();
  store.addMovement(it.id, { type: "in", qty: 5, floorId: f1 });
  const f2 = store.addFloor("Этаж 2");

  const ok = store.transferStock(it.id, f1, f2.id, 10); // больше, чем 5
  assert.equal(ok, false);
  assert.equal(store.stockForItem(it.id, f1), 5); // не изменился
  assert.equal(store.stockForItem(it.id, f2.id), 0);
});

test("перенос на тот же этаж и нулевой объём отклоняются", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  const f1 = store.getActiveFloorId();
  store.addMovement(it.id, { type: "in", qty: 5 });
  assert.equal(store.transferStock(it.id, f1, f1, 2), false);
  assert.equal(store.transferStock(it.id, f1, f1, 0), false);
});

test("перенос не влияет на средний расход (transfer-движения исключены)", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  const f1 = store.getActiveFloorId();
  store.addMovement(it.id, { type: "in", qty: 20 });
  const f2 = store.addFloor("Этаж 2");
  store.transferStock(it.id, f1, f2.id, 8);
  // движения переноса помечены transfer:true
  const mv = store.movementsForItem(it.id, f1);
  const out = mv.find((m) => m.type === "out");
  assert.equal(out.transfer, true);
});

test("последний этаж удалить нельзя, а лишний — можно вместе с движениями", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  const f1 = store.getActiveFloorId();
  const f2 = store.addFloor("Этаж 2");
  store.addMovement(it.id, { type: "in", qty: 5, floorId: f2.id });

  assert.equal(store.deleteFloor(f2.id), true);
  assert.equal(store.floors().length, 1);
  assert.equal(store.stockForItem(it.id, f2.id), 0); // движения этажа удалены

  assert.equal(store.deleteFloor(f1), false); // последний не удаляется
  assert.equal(store.floors().length, 1);
});

test("миграция: данные без этажей получают этаж и floorId у движений", () => {
  // Старое состояние без floors/floorId.
  store.replaceState({
    categories: [{ id: "c1", name: "Молоко", order: 0 }],
    items: [{ id: "i1", categoryId: "c1", name: "Коровье", unit: "л", minStock: 0, order: 0 }],
    movements: [{ id: "m1", itemId: "i1", date: "2026-08-01", type: "in", qty: 7 }],
  });
  assert.equal(store.floors().length, 1);
  const fid = store.getActiveFloorId();
  assert.ok(fid);
  // движение без floorId должно резолвиться на активный этаж
  assert.equal(store.stockForItem("i1", fid), 7);
});
