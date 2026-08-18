// Тесты синхронизации: чистые функции store/sync + полный round-trip клиента
// против точной модели сервера (LWW + seq, как в backend/main.go).
import { test } from "node:test";
import assert from "node:assert/strict";

// In-memory localStorage до импорта модулей.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

// Модель сервера (зеркало backend/main.go).
function makeServer() {
  const names = ["categories", "items", "floors", "movements", "settings"];
  const coll = {};
  for (const n of names) coll[n] = {};
  let seq = 0;
  function apply(name, recs) {
    for (const rec of recs || []) {
      if (!rec || !rec.id) continue;
      const ex = coll[name][rec.id];
      if (ex && rec.updatedAt <= ex.updatedAt) continue;
      seq++;
      coll[name][rec.id] = {
        id: rec.id,
        updatedAt: rec.updatedAt,
        deleted: !!rec.deleted,
        data: rec.deleted ? undefined : rec.data,
        seq,
      };
    }
  }
  function changedSince(name, since) {
    return Object.values(coll[name])
      .filter((r) => r.seq > since)
      .sort((a, b) => a.seq - b.seq);
  }
  return { names, coll, get seq() { return seq; }, apply, changedSince };
}

let server = makeServer();

// fetch-шим поверх модели сервера.
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith("/health")) return { ok: true, status: 200 };
  if (url.endsWith("/sync")) {
    const body = JSON.parse(opts.body || "{}");
    let since = body.since || 0;
    if (since > server.seq) since = 0;
    for (const n of server.names) server.apply(n, body[n]);
    const out = { seq: server.seq };
    for (const n of server.names) out[n] = server.changedSince(n, since);
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const store = await import("../assets/store.js");
const sync = await import("../assets/sync.js");

function fresh() {
  mem.clear();
  server = makeServer();
  store.replaceState({});
  sync.resetSyncState();
  sync.setConfig({ url: "https://x.example", token: "t" });
}

// ── Чистые функции store ─────────────────────────────────────────────────

test("exportRecords: форма записей и singleton settings", () => {
  fresh();
  const c = store.addCategory("Молоко");
  const per = store.exportRecords();
  const rec = per.categories.find((r) => r.id === c.id);
  assert.equal(rec.deleted, false);
  assert.ok(rec.updatedAt > 1);
  assert.equal(rec.data.name, "Молоко");
  assert.equal(per.settings.length, 1);
  assert.equal(per.settings[0].id, "settings");
  assert.deepEqual(per.settings[0].data.workingDays, [1, 2, 3, 4, 5]);
});

test("applyServerRecords: LWW и тумбстоуны", () => {
  fresh();
  const c = store.addCategory("Молоко");
  // Более старая серверная запись — игнорируется.
  store.applyServerRecords({ categories: [{ id: c.id, updatedAt: 1, deleted: false, data: { name: "Старое" } }] });
  assert.equal(store.getCategory(c.id).name, "Молоко");
  // Более свежая — принимается.
  store.applyServerRecords({ categories: [{ id: c.id, updatedAt: Date.now() + 1000, deleted: false, data: { name: "Новое", order: 0 } }] });
  assert.equal(store.getCategory(c.id).name, "Новое");
  // Тумбстоун — категория исчезает из геттеров.
  store.applyServerRecords({ categories: [{ id: c.id, updatedAt: Date.now() + 2000, deleted: true, data: {} }] });
  assert.equal(store.getCategory(c.id), null);
});

test("replaceFromServerRecords: пересборка из серверных id", () => {
  fresh();
  store.replaceFromServerRecords({
    floors: [{ id: "F1", updatedAt: 10, deleted: false, data: { name: "Этаж 1", order: 0 } }],
    categories: [{ id: "C1", updatedAt: 10, deleted: false, data: { name: "Чай", order: 0 } }],
    items: [{ id: "I1", updatedAt: 10, deleted: false, data: { categoryId: "C1", name: "Черный", unit: "шт", minStock: 0, order: 0 } }],
    movements: [{ id: "M1", updatedAt: 10, deleted: false, data: { itemId: "I1", floorId: "F1", date: "2026-08-01", type: "in", qty: 5 } }],
    settings: [{ id: "settings", updatedAt: 10, deleted: false, data: { windowDays: 14, workingDaysOnly: false, workingDays: [1, 2, 3] } }],
  });
  assert.equal(store.floors()[0].id, "F1");
  assert.equal(store.getCategory("C1").name, "Чай");
  assert.equal(store.stockForItem("I1", "F1"), 5);
  assert.equal(store.getSettings().windowDays, 14);
});

// ── Чистые функции sync ──────────────────────────────────────────────────

test("computePush: изменённые + синтетические тумбстоуны", () => {
  const local = {
    categories: [{ id: "a", updatedAt: 100, deleted: false, data: {} }],
    items: [], floors: [], movements: [], settings: [],
  };
  // snapshot знает про a со старым updatedAt (изменилось) и про исчезнувший b.
  const snap = { categories: { a: 50, b: 70 }, items: {}, floors: {}, movements: {}, settings: {} };
  const push = sync.computePush(local, snap, 999);
  const ids = push.categories.map((r) => r.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
  const b = push.categories.find((r) => r.id === "b");
  assert.equal(b.deleted, true);
  assert.equal(b.updatedAt, 999);
  // Неизменённая запись не пушится.
  const push2 = sync.computePush(local, { categories: { a: 100 }, items: {}, floors: {}, movements: {}, settings: {} }, 999);
  assert.equal(push2.categories.length, 0);
});

// ── Round-trip против модели сервера ─────────────────────────────────────

test("syncNow: локальные данные уезжают на сервер", async () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  store.addMovement(it.id, { type: "in", qty: 10 });

  const r = await sync.syncNow();
  assert.equal(r.ok, true);
  assert.ok(server.coll.categories[c.id]);
  assert.ok(server.coll.items[it.id]);
  assert.equal(Object.keys(server.coll.movements).length, 1);
  // После синка нечего отправлять.
  assert.equal(sync.pendingCount(), 0);
});

test("syncNow: серверные изменения приезжают и сливаются", async () => {
  fresh();
  const c = store.addCategory("Молоко");
  await sync.syncNow();

  // Другое устройство добавило категорию прямо на сервере.
  server.apply("categories", [{ id: "remote1", updatedAt: Date.now() + 100, deleted: false, data: { name: "Чай", order: 5 } }]);

  await sync.syncNow();
  assert.ok(store.getCategory("remote1"));
  assert.equal(store.getCategory("remote1").name, "Чай");
  assert.ok(store.getCategory(c.id)); // своя не потерялась
});

test("удаление распространяется тумбстоуном", async () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье" });
  await sync.syncNow();

  store.deleteItem(it.id);
  await sync.syncNow();
  assert.equal(server.coll.items[it.id].deleted, true);
  assert.equal(store.getItem(it.id), null);
});

test("исчезновение записи (после импорта/сброса) тумбстоунится на сервере", async () => {
  fresh();
  const c = store.addCategory("Старое");
  await sync.syncNow();
  const oldId = c.id;

  // Полностью заменяем данные (как повторный импорт) — старый id исчезает.
  store.replaceState({});
  await sync.syncNow();
  assert.ok(server.coll.categories[oldId]);
  assert.equal(server.coll.categories[oldId].deleted, true);
});

test("pullReplace: второе устройство становится зеркалом сервера", async () => {
  fresh();
  // Наполняем сервер данными «первого устройства».
  const t = Date.now();
  server.apply("floors", [{ id: "F1", updatedAt: t, deleted: false, data: { name: "Этаж 1", order: 0 } }]);
  server.apply("categories", [{ id: "C1", updatedAt: t, deleted: false, data: { name: "Чай", order: 0 } }]);
  server.apply("items", [{ id: "I1", updatedAt: t, deleted: false, data: { categoryId: "C1", name: "Черный", unit: "шт", minStock: 0, order: 0 } }]);

  // На «втором устройстве» уже есть свой локальный мусор.
  store.addCategory("Локальный мусор");

  const r = await sync.pullReplace();
  assert.equal(r.ok, true);
  assert.equal(store.floors()[0].id, "F1");
  assert.equal(store.getCategory("C1").name, "Чай");
  // Локального мусора больше нет (заменили серверными).
  assert.equal(store.categories().length, 1);
});
