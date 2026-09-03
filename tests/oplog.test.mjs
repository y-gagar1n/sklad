// Тесты локального журнала операций синка (assets/oplog.js): кольцевой буфер
// не должен расти неограниченно — это диагностика, а не рабочие данные, и не
// должен вытеснить sklad-state-v1/sklad-syncstate-v1 из localStorage.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const oplog = await import("../assets/oplog.js");

function fresh() {
  mem.clear();
}

test("log/getAll: базовая запись и чтение по порядку", () => {
  fresh();
  oplog.log("sync-push", { movements: { n: 34, del: 34 } });
  oplog.log("sync-error", { message: "таймаут" });
  const all = oplog.getAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].event, "sync-push");
  assert.equal(all[0].movements.del, 34);
  assert.equal(all[1].event, "sync-error");
  assert.ok(all[0].t > 0, "у записи должна быть метка времени");
});

test("clear: очищает журнал", () => {
  fresh();
  oplog.log("wipe", {});
  oplog.clear();
  assert.deepEqual(oplog.getAll(), []);
});

test("кольцевой буфер: количество записей ограничено (свежие важнее старых)", () => {
  fresh();
  for (let i = 0; i < 600; i++) oplog.log("sync-pull", { i });
  const all = oplog.getAll();
  assert.ok(all.length <= 500, `ждали не больше 500, получили ${all.length}`);
  // Последняя запись — самая свежая, не самая старая.
  assert.equal(all[all.length - 1].i, 599);
});

test("кольцевой буфер: суммарный размер в localStorage ограничен", () => {
  fresh();
  const chunk = "x".repeat(2000); // крупные записи, чтобы быстро упереться в лимит по байтам раньше лимита по count
  for (let i = 0; i < 300; i++) oplog.log("import-json", { note: chunk });
  const stored = localStorage.getItem("sklad-oplog-v1") || "";
  assert.ok(stored.length <= 200 * 1024, `журнал раздулся: ${stored.length} байт`);
  // Свежие записи не потерялись — последняя всё ещё на месте.
  const all = oplog.getAll();
  assert.equal(all[all.length - 1].note, chunk);
});

test("sizeBytes отражает реальный размер в localStorage", () => {
  fresh();
  assert.equal(oplog.sizeBytes(), 0);
  oplog.log("wipe", {});
  assert.ok(oplog.sizeBytes() > 0);
});

test("переполнение квоты: setItem бросает — лог не падает, режет буфер пополам", () => {
  fresh();
  for (let i = 0; i < 10; i++) oplog.log("sync-pull", { i });
  assert.equal(oplog.getAll().length, 10);

  // Один раз имитируем "квота превышена" — save() должен поймать, отрезать
  // половину и повторить запись, а не уронить вызывающий код.
  const realSetItem = localStorage.setItem;
  let calls = 0;
  localStorage.setItem = (k, v) => {
    calls++;
    if (calls === 1) throw new Error("QuotaExceededError");
    realSetItem(k, v);
  };
  assert.doesNotThrow(() => oplog.log("sync-error", { message: "квота" }));
  localStorage.setItem = realSetItem;

  const all = oplog.getAll();
  assert.ok(all.length < 11, "после переполнения буфер должен был подрезаться");
  assert.equal(all[all.length - 1].message, "квота", "последняя запись всё равно должна сохраниться");
});
