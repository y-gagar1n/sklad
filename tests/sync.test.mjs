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

// Многотенантность: свой server-model на токен (как <data-dir>/<tenant>.json на
// бэке). Токен берём из заголовка Authorization; отсутствие токена → 401. Ленивое
// создание тенанта — токен и есть ключ изоляции.
const tenants = new Map();
function serverFor(token) {
  if (!tenants.has(token)) tenants.set(token, makeServer());
  return tenants.get(token);
}

// Токены, помеченные read-only (зеркалит "tenantId: token ro" в tokens-файле
// бэкенда): pull работает, push — 403, как в backend/main.go.
const roTokens = new Set();

// server — модель тенанта токена "t" (его ставит fresh()); на неё смотрят тесты.
let server = serverFor("t");

function bearer(opts) {
  const h = opts.headers || {};
  const raw = typeof h.get === "function"
    ? h.get("Authorization") || ""
    : h.Authorization || h.authorization || "";
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}

// Батчи, присланные на /client-logs — по токену, для проверки sendLogs().
const clientLogs = new Map();

// fetch-шим поверх моделей тенантов.
globalThis.fetch = async (url, opts = {}) => {
  if (url.endsWith("/health")) return { ok: true, status: 200 };
  if (url.endsWith("/client-logs")) {
    const token = bearer(opts);
    if (!token) return { ok: false, status: 401, json: async () => ({}) };
    const body = JSON.parse(opts.body || "{}");
    if (!Array.isArray(body.entries) || !body.entries.length) {
      return { ok: false, status: 400, json: async () => ({}) };
    }
    if (!clientLogs.has(token)) clientLogs.set(token, []);
    clientLogs.get(token).push(...body.entries);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (url.endsWith("/sync") || url.endsWith("/wipe")) {
    const token = bearer(opts);
    if (!token) return { ok: false, status: 401, json: async () => ({}) };
    const isRO = roTokens.has(token);
    const body = JSON.parse(opts.body || "{}");
    const hasIncoming = Object.keys(body).some(
      (k) => k !== "since" && Array.isArray(body[k]) && body[k].length,
    );
    if (isRO && (url.endsWith("/wipe") || hasIncoming)) {
      return {
        ok: false,
        status: 403,
        text: async () => "read-only токен: запись запрещена",
        json: async () => ({}),
      };
    }
    const srv = serverFor(token);
    let since = body.since || 0;
    if (since > srv.seq) since = 0;
    for (const n of srv.names) srv.apply(n, body[n]);
    const out = { seq: srv.seq, readOnly: isRO };
    for (const n of srv.names) out[n] = srv.changedSince(n, since);
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const store = await import("../assets/store.js");
const sync = await import("../assets/sync.js");
const oplog = await import("../assets/oplog.js");

function fresh() {
  mem.clear();
  tenants.clear();
  roTokens.clear();
  clientLogs.clear();
  server = serverFor("t"); // тенант токена "t" — с ним работает клиент по умолчанию
  store.replaceState({});
  sync.resetSyncState();
  oplog.clear();
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

test("hiddenCats этажа синкается: поле в payload и мёржится по LWW", () => {
  fresh();
  const c = store.addCategory("Напитки");
  const f1 = store.getActiveFloorId();
  store.hideCategoryOnFloor(c.id, f1);

  // Поле уходит в payload записи этажа.
  const per = store.exportRecords();
  const frec = per.floors.find((r) => r.id === f1);
  assert.deepEqual(frec.data.hiddenCats, [c.id]);

  // Более свежая серверная запись без hiddenCats — категория снова видна (LWW).
  store.applyServerRecords({
    floors: [{ id: f1, updatedAt: Date.now() + 5000, deleted: false, data: { name: "Этаж 1", order: 0 } }],
  });
  assert.ok(store.categoriesForFloor(f1).some((x) => x.id === c.id));

  // Ещё более свежая серверная запись со скрытием — категория снова скрыта.
  store.applyServerRecords({
    floors: [{ id: f1, updatedAt: Date.now() + 9000, deleted: false, data: { name: "Этаж 1", order: 0, hiddenCats: [c.id] } }],
  });
  assert.ok(!store.categoriesForFloor(f1).some((x) => x.id === c.id));
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

// ── Read-only токены ───────────────────────────────────────────────────────

// testConnection шлёт {since:0} без коллекций — чистый pull, без push. Это путь
// реального UI (saveSyncConfig зовёт testConnection сразу после setConfig), так
// read-only узнаётся ДО того, как syncNow попробует запушить дефолтные локальные
// записи (этаж/настройки, которые есть у любого свежего устройства) и получит 403.
test("read-only токен: testConnection узнаёт readOnly чистым pull'ом, без 403", async () => {
  fresh();
  roTokens.add("ro-t");
  sync.setConfig({ url: "https://x.example", token: "ro-t" });
  assert.equal(sync.isReadOnly(), false); // до первого сетевого ответа — режим ещё не известен

  const r = await sync.testConnection("https://x.example", "ro-t");
  assert.equal(r.ok, true);
  assert.equal(r.readOnly, true);
  assert.equal(sync.isReadOnly(), true);
  // Закэшировано в конфиге — переживает перезагрузку страницы.
  assert.equal(JSON.parse(localStorage.getItem("sklad-sync-config")).readOnly, true);
});

test("read-only токен: известный readOnly — syncNow не пушит, правка остаётся в очереди", async () => {
  fresh();
  roTokens.add("ro-t2");
  sync.setConfig({ url: "https://x.example", token: "ro-t2" });
  await sync.testConnection("https://x.example", "ro-t2");
  assert.equal(sync.isReadOnly(), true);

  store.addCategory("Тайком добавлено");
  assert.ok(sync.pendingCount() > 0);

  // syncNow больше не пытается пушить, раз readOnly уже известен (иначе сервер
  // 403-т ВЕСЬ запрос и мы бы теряли pull-часть вместе с push) — чистый pull
  // проходит успешно, а неотправленная правка остаётся «в очереди», а не
  // тихо помечается синхронизированной.
  const r = await sync.syncNow();
  assert.equal(r.ok, true);
  assert.equal(r.pushed, false);
  assert.ok(sync.pendingCount() > 0);
});

test("read-only токен: 403 на неожиданном push (readOnly ещё не был известен) не топит pull навсегда", async () => {
  fresh();
  roTokens.add("ro-t4");
  sync.setConfig({ url: "https://x.example", token: "ro-t4" });
  // Сервер уже что-то знает про этот тенант (другое устройство запушило).
  server = serverFor("ro-t4");
  server.apply("categories", [{ id: "srv1", updatedAt: 1, deleted: false, data: { name: "С сервера", order: 0 } }]);

  // Без предварительного testConnection syncNow ещё не знает readOnly и пушит
  // локальные дефолты — сервер 403-т весь запрос, pull теряется вместе с push.
  const r1 = await sync.syncNow();
  assert.equal(r1.ok, false);
  assert.equal(sync.isReadOnly(), true); // хотя бы режим узнали из самого 403

  // Но следующий syncNow уже знает readOnly, push не шлёт — и данные с сервера доезжают.
  const r2 = await sync.syncNow();
  assert.equal(r2.ok, true);
  assert.ok(store.getCategory("srv1"));
});

test("смена токена сбрасывает закэшированный readOnly до следующего /sync", async () => {
  fresh();
  roTokens.add("ro-t3");
  sync.setConfig({ url: "https://x.example", token: "ro-t3" });
  await sync.syncNow();
  assert.equal(sync.isReadOnly(), true);

  sync.setConfig({ url: "https://x.example", token: "t" }); // обычный read-write токен
  assert.equal(sync.isReadOnly(), false);
});

// ── Локальный тумблер forceReadOnly ─────────────────────────────────────────

test("forceReadOnly: включает isReadOnly() у обычного токена, не мешает pull, блокирует push", async () => {
  fresh(); // токен "t" — обычный read-write
  assert.equal(sync.isReadOnly(), false);
  assert.equal(sync.isServerReadOnly(), false);

  sync.setForceReadOnly(true);
  assert.equal(sync.isReadOnly(), true);
  assert.equal(sync.isServerReadOnly(), false); // источник — локальный тумблер, не токен
  assert.equal(sync.isForcedReadOnly(), true);

  // Другое устройство добавило категорию на сервере — pull всё равно проходит.
  server.apply("categories", [{ id: "remote1", updatedAt: Date.now(), deleted: false, data: { name: "Чай", order: 0 } }]);
  const r1 = await sync.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(r1.pushed, false);
  assert.ok(store.getCategory("remote1"));

  // Локальная правка не пушится и остаётся в очереди — как у настоящего read-only.
  store.addCategory("Локально при проверке");
  assert.ok(sync.pendingCount() > 0);
  const r2 = await sync.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.pushed, false);
  assert.ok(sync.pendingCount() > 0);

  sync.setForceReadOnly(false);
  assert.equal(sync.isReadOnly(), false);
});

test("forceReadOnly переживает смену токена (это настройка устройства, а не токена)", async () => {
  fresh();
  sync.setForceReadOnly(true);
  sync.setConfig({ url: "https://x.example", token: "t" });
  assert.equal(sync.isForcedReadOnly(), true);
  assert.equal(sync.isReadOnly(), true);
});

test("сервер изолирует данные по токену; без токена — 401", async () => {
  fresh();
  const url = "https://x.example/sync";
  const hdr = (tok) => ({ "Content-Type": "application/json", Authorization: "Bearer " + tok });

  // Тенант A пушит товар.
  const rA = await fetch(url, {
    method: "POST",
    headers: hdr("ta"),
    body: JSON.stringify({ since: 0, items: [{ id: "x", updatedAt: 100, deleted: false, data: { n: 1 } }] }),
  });
  const outA = await rA.json();
  assert.equal(outA.items.length, 1);

  // Тенант B с нуля видит пусто и seq=0 — данные изолированы.
  const rB = await fetch(url, { method: "POST", headers: hdr("tb"), body: JSON.stringify({ since: 0 }) });
  const outB = await rB.json();
  assert.equal(outB.items.length, 0);
  assert.equal(outB.seq, 0);

  // Тенант A по-прежнему видит свой товар.
  const rA2 = await fetch(url, { method: "POST", headers: hdr("ta"), body: JSON.stringify({ since: 0 }) });
  const outA2 = await rA2.json();
  assert.equal(outA2.items.length, 1);

  // Без Authorization — 401.
  const rNo = await fetch(url, { method: "POST", headers: {}, body: "{}" });
  assert.equal(rNo.status, 401);
});

// ── oplog: локальный журнал операций синка ─────────────────────────────────

test("syncNow пишет в oplog состав push (включая долю тумбстоунов)", async () => {
  fresh();
  const c = store.addCategory("Молоко");
  const it = store.addItem(c.id, { name: "Коровье", unit: "л" });
  store.addMovement(it.id, { type: "in", qty: 10 });
  await sync.syncNow();

  const events = oplog.getAll().map((e) => e.event);
  assert.ok(events.includes("sync-push"), `ждали sync-push среди ${events}`);
  const push = oplog.getAll().find((e) => e.event === "sync-push");
  assert.equal(push.movements.n, 1);
  assert.ok(!push.movements.del, "обычное создание — не тумбстоун");
});

test("computePush-тумбстоун виден в oplog как del — ровно то, что искали при разборе инцидента", async () => {
  fresh();
  const it = store.addItem(store.addCategory("Кофе").id, { name: "Синяя упаковка", unit: "шт" });
  const m = store.addMovement(it.id, { type: "in", qty: 5 });
  await sync.syncNow(); // движение уехало на сервер, снимок его знает

  // Имитируем «откат к старому бэкапу»: движение пропало из локальных данных,
  // но снимок синка всё ещё помнит его id (см. computePush).
  store.replaceState({
    categories: store.exportRecords().categories.map((r) => ({ id: r.id, ...r.data, updatedAt: r.updatedAt, deleted: r.deleted })),
  });
  oplog.clear(); // сам replaceState тоже пишет в oplog — не мешаем следующей проверке
  await sync.syncNow();

  const push = oplog.getAll().find((e) => e.event === "sync-push");
  assert.ok(push, "ждали sync-push после отката");
  assert.equal(push.movements.del, 1, "пропавшее движение должно уйти тумбстоуном — и это видно в oplog");
});

test("pullReplace пишет в oplog сводку того, что пришло с сервера", async () => {
  fresh();
  server.apply("items", [{ id: "x", updatedAt: 100, deleted: false, data: { name: "Чай" } }]);
  await sync.pullReplace();
  const pull = oplog.getAll().find((e) => e.event === "pull-replace");
  assert.ok(pull, "ждали pull-replace в oplog");
  assert.equal(pull.items.n, 1);
});

test("sendLogs: пустой журнал — не шлём запрос, честно говорим 'empty'", async () => {
  fresh();
  const r = await sync.sendLogs();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty");
});

test("sendLogs: непустой журнал уезжает на /client-logs тем же токеном", async () => {
  fresh();
  oplog.log("sync-error", { message: "таймаут" });
  oplog.log("wipe", { before: { movements: 5 } });

  const r = await sync.sendLogs();
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(clientLogs.get("t").length, 2);
  assert.equal(clientLogs.get("t")[0].event, "sync-error");
});
