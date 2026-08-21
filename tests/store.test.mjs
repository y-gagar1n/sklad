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

test("скрытие категории на этаже: прячет её, но движения и остаток сохраняются", () => {
  fresh();
  const c = store.addCategory("Напитки");
  const water = store.addItem(c.id, { name: "Вода", unit: "л" });
  const other = store.addCategory("Бакалея");
  const flour = store.addItem(other.id, { name: "Мука", unit: "кг" });
  const f1 = store.getActiveFloorId();
  const f2 = store.addFloor("Этаж 2");
  store.addMovement(water.id, { type: "in", qty: 10 }); // f1
  store.addMovement(water.id, { type: "in", qty: 7, floorId: f2.id });
  store.addMovement(flour.id, { type: "in", qty: 3 }); // f1

  assert.equal(store.hideCategoryOnFloor(c.id, f1), true);

  // На f1 категория скрыта из отображения, но остаток/движения НЕ тронуты.
  assert.ok(!store.categoriesForFloor(f1).some((x) => x.id === c.id));
  assert.equal(store.stockForItem(water.id, f1), 10);
  assert.equal(store.stockForItem(water.id, f2.id), 7);
  assert.ok(store.categoriesForFloor(f2.id).some((x) => x.id === c.id));
  assert.ok(store.getCategory(c.id)); // глобально категория существует
  assert.ok(store.getItem(water.id)); // товар существует

  // Соседняя категория на f1 не затронута.
  assert.ok(store.categoriesForFloor(f1).some((x) => x.id === other.id));
  assert.equal(store.stockForItem(flour.id, f1), 3);

  // hiddenCategoriesForFloor показывает её только на f1.
  assert.deepEqual(store.hiddenCategoriesForFloor(f1).map((x) => x.id), [c.id]);
  assert.equal(store.hiddenCategoriesForFloor(f2.id).length, 0);

  // Повторное скрытие — уже скрыта, ничего не меняем.
  assert.equal(store.hideCategoryOnFloor(c.id, f1), false);
});

test("возврат скрытой категории на этаж: снова видна, история и остаток на месте", () => {
  fresh();
  const c = store.addCategory("Напитки");
  const water = store.addItem(c.id, { name: "Вода", unit: "л" });
  const f1 = store.getActiveFloorId();
  store.addMovement(water.id, { type: "in", qty: 10 });

  store.hideCategoryOnFloor(c.id, f1);
  assert.equal(store.unhideCategoryOnFloor(c.id, f1), true);

  assert.ok(store.categoriesForFloor(f1).some((x) => x.id === c.id));
  assert.equal(store.stockForItem(water.id, f1), 10); // движения не трогались
  assert.equal(store.movementsForItem(water.id, f1).length, 1); // история цела
  assert.equal(store.unhideCategoryOnFloor(c.id, f1), false); // уже не скрыта
});

test("импорт из Excel: движения переносятся с датами, остаток сходится", () => {
  // Как у нутеллы в реальном файле: приход/расход по дням, «Итого остаток» = 6.
  store.importFromParsed(
    {
      categories: ["Нутелла"],
      floors: ["Этаж 1"],
      items: [
        {
          category: "Нутелла",
          name: "нутелла",
          floor: "Этаж 1",
          stock: 6,
          moves: [
            { date: "2026-08-03", type: "in", qty: 2 },
            { date: "2026-08-07", type: "out", qty: 1 },
            { date: "2026-08-18", type: "in", qty: 6 },
            { date: "2026-08-18", type: "out", qty: 1 },
          ],
        },
      ],
    },
    "2026-08-18",
  );
  const it = store.allItems().find((i) => i.name === "нутелла");
  assert.equal(store.stockForItem(it.id), 6); // совпадает с «Итого остаток»
  const mv = store.movementsForItem(it.id);
  // Начального остатка нет: 6 − 8 + 2 = 0 → только 4 реальные записи.
  assert.equal(mv.length, 4);
  assert.ok(mv.every((m) => m.note === "Импорт из Excel" && !m.adjust));
  const on18 = mv
    .filter((m) => m.date === "2026-08-18")
    .map((m) => `${m.type}:${m.qty}`)
    .sort();
  assert.deepEqual(on18, ["in:6", "out:1"]);
});

test("импорт из Excel: ненулевой остаток на начало заводится инвентаризацией", () => {
  store.importFromParsed(
    {
      categories: ["Соль"],
      floors: ["Этаж 1"],
      items: [
        {
          category: "Соль",
          name: "соль",
          floor: "Этаж 1",
          stock: 5,
          moves: [{ date: "2026-08-10", type: "out", qty: 2 }],
        },
      ],
    },
    "2026-08-18",
  );
  const it = store.allItems().find((i) => i.name === "соль");
  assert.equal(store.stockForItem(it.id), 5);
  const open = store.movementsForItem(it.id).find((m) => m.adjust);
  // начало = 5 − 0 + 2 = 7, датой за день до первого движения (10.08).
  assert.equal(open.type, "in");
  assert.equal(open.qty, 7);
  assert.equal(open.date, "2026-08-09");
});

test("updateMovement: правит количество/дату и меняет остаток", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  store.addMovement(it.id, { type: "in", qty: 20, date: "2026-08-01" });
  const out = store.addMovement(it.id, { type: "out", qty: 5, date: "2026-08-02" });
  const before = out.updatedAt;

  const res = store.updateMovement(out.id, { qty: 8, date: "2026-08-03" });
  assert.equal(res.qty, 8);
  assert.equal(res.date, "2026-08-03");
  assert.ok(res.updatedAt > before); // бампнули метку → уедет по синку
  assert.equal(store.stockForItem(it.id), 12); // 20 − 8
});

test("updateMovement: переносы не редактируются (возврат null)", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  const f1 = store.getActiveFloorId();
  store.addMovement(it.id, { type: "in", qty: 20, floorId: f1 });
  const f2 = store.addFloor("Этаж 2");
  store.transferStock(it.id, f1, f2.id, 8);
  const tr = store.movementsForItem(it.id, f1).find((m) => m.transfer);
  assert.equal(store.updateMovement(tr.id, { qty: 100 }), null);
  assert.equal(store.stockForItem(it.id, f1), 12); // остаток не тронут
});

test("этажи в списке сортируются по имени с учётом чисел", () => {
  fresh();
  store.renameFloor(store.getActiveFloorId(), "Этаж 2");
  store.addFloor("Этаж 10");
  store.addFloor("Этаж 1");
  store.addFloor("Подвал");
  assert.deepEqual(
    store.floors().map((f) => f.name),
    ["Подвал", "Этаж 1", "Этаж 2", "Этаж 10"],
  );
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
