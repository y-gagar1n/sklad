// sync.js — фоновая синхронизация с сервером (pull → merge → push).
//
// Модель простая, потому что у каждой записи есть updatedAt (штампуется при
// каждой правке в store.js): конфликты решаются whole-record LWW по updatedAt,
// одинаково для всех коллекций. Движения иммутабельны, поэтому их слияние —
// это union по id (+ тумбстоуны). Отдельного 3-way merge не нужно.
//
// Что храним локально (device-local, НЕ синкается):
//   sklad-sync-config    { url, token, readOnly, forceReadOnly } — readOnly
//                        приходит от сервера в ответе /sync (поле readOnly),
//                        кэшируется тут, чтобы UI знал режим сразу при загрузке,
//                        не дожидаясь сети. forceReadOnly — локальный тумблер
//                        (Настройки → Синхронизация): пользователь с обычным
//                        (read-write) токеном может включить его сам, чтобы
//                        проверить интерфейс как read-only-пользователь, только
//                        на этом устройстве. У настоящего read-only токена
//                        серверный readOnly и так true — тумблер там decorative
//                        (см. isServerReadOnly в app.js).
//   sklad-syncstate-v1   { lastSeq, snapshot: { coll: { id: updatedAt } } }
import * as store from "./store.js";

const CONFIG_KEY = "sklad-sync-config";
const STATE_KEY = "sklad-syncstate-v1";
const COLLECTIONS = ["categories", "items", "floors", "movements", "settings"];

// ── Конфиг (адрес сервера + токен) ─────────────────────────────────────────

export function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

export function setConfig({ url, token }) {
  // readOnly (серверный флаг) сбрасываем — токен сменился, режим неизвестен до
  // следующего /sync. forceReadOnly — настройка устройства, а не токена,
  // переносим её как есть.
  const forceReadOnly = !!getConfig().forceReadOnly;
  const cfg = { url: normUrl(url), token: (token || "").trim(), readOnly: false, forceReadOnly };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  setStatus({ readOnly: false });
  return cfg;
}

export function isConfigured() {
  const c = getConfig();
  return !!(c.url && c.token);
}

function normUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// ── Локальное состояние синка ──────────────────────────────────────────────

function loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    return { lastSeq: s.lastSeq || 0, snapshot: s.snapshot || {} };
  } catch {
    return { lastSeq: 0, snapshot: {} };
  }
}

function saveSyncState(s) {
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
}

export function resetSyncState() {
  localStorage.removeItem(STATE_KEY);
}

// ── Чистые функции (тестируются без сети) ──────────────────────────────────

// Снимок {coll: {id: updatedAt}} из набора записей exportRecords().
export function snapshotFromRecords(per) {
  const snap = {};
  for (const name of COLLECTIONS) {
    snap[name] = {};
    for (const rec of per[name] || []) snap[name][rec.id] = rec.updatedAt;
  }
  return snap;
}

// Снимок для случая, когда мы приняли pull, но НЕ пушили (пустой запрос — как
// testConnection, или read-only токен в syncNow): помечаем «уже на сервере»
// только те id, что реально пришли с сервера, остальной снимок не трогаем.
// Так локальные неотправленные правки остаются «неотправленными», а не
// объявляются синхронизированными без реального push'а (см. computePush).
function mergeSnapshot(prevSnapshot, per) {
  const snap = {};
  for (const name of COLLECTIONS) {
    snap[name] = { ...(prevSnapshot[name] || {}) };
    for (const rec of per[name] || []) snap[name][rec.id] = rec.updatedAt;
  }
  return snap;
}

// Что нужно отправить: локальные записи, изменившиеся с прошлого снимка, плюс
// синтетические тумбстоуны для записей, которые были в снимке, но исчезли из
// локальных (например, после «Удалить всё» или повторного импорта).
export function computePush(local, snapshot, nowMs) {
  const push = {};
  for (const name of COLLECTIONS) {
    const out = [];
    const localById = new Map();
    for (const rec of local[name] || []) {
      localById.set(rec.id, rec);
      const seen = snapshot[name]?.[rec.id];
      if (seen === undefined || seen !== rec.updatedAt) out.push(rec);
    }
    for (const id of Object.keys(snapshot[name] || {})) {
      if (!localById.has(id)) {
        // Тумбстоун должен строго побеждать последнюю известную метку (иначе
        // при совпадении миллисекунды LWW оставит запись живой).
        const seen = snapshot[name][id] || 0;
        out.push({ id, updatedAt: Math.max(nowMs, seen + 1), deleted: true, data: {} });
      }
    }
    push[name] = out;
  }
  return push;
}

function hasAny(push) {
  return COLLECTIONS.some((n) => (push[n] || []).length > 0);
}

// ── Сеть ───────────────────────────────────────────────────────────────────

async function postSync(cfg, body) {
  const resp = await fetch(cfg.url + "/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.token,
    },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) throw new Error("Неверный токен доступа");
  if (resp.status === 403) {
    // 403 на /sync в этом протоколе означает ровно одно: токен read-only и в
    // запросе была непустая коллекция (см. backend/main.go). Запоминаем сразу,
    // не дожидаясь следующего чистого pull.
    rememberReadOnly(true);
    const text = await resp.text().catch(() => "");
    throw new Error(text || "Доступ только для чтения");
  }
  if (!resp.ok) throw new Error("Сервер вернул " + resp.status);
  return resp.json();
}

// ── Статус (для UI) ─────────────────────────────────────────────────────────

let status = {
  syncing: false,
  lastSyncAt: 0,
  lastError: "",
  // Восстанавливаем из последнего известного значения (пережившего перезагрузку),
  // чтобы UI не мигал «можно редактировать» до первого сетевого ответа.
  readOnly: !!getConfig().readOnly,
  forceReadOnly: !!getConfig().forceReadOnly,
};
const statusListeners = new Set();
export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of statusListeners) {
    try {
      fn(status);
    } catch {}
  }
}
export function getStatus() {
  return status;
}
// Эффективный read-only: либо так решил сервер (токен и правда read-only),
// либо пользователь сам включил локальную проверку (forceReadOnly). Именно эту
// функцию использует app.js, чтобы решить, блокировать ли контролы.
export function isReadOnly() {
  return !!(status.readOnly || status.forceReadOnly);
}
// Read-only ли сам токен на сервере (а не локальная проверка) — по этому флагу
// app.js решает, показывать ли тумблер forceReadOnly интерактивным: у токена,
// который и так read-only, включать/выключать локальную проверку бессмысленно.
export function isServerReadOnly() {
  return !!status.readOnly;
}
export function isForcedReadOnly() {
  return !!status.forceReadOnly;
}

// Запоминаем read-only режим текущего токена — в статусе (для немедленного UI)
// и в конфиге (переживает перезагрузку страницы, до следующего /sync).
function rememberReadOnly(flag) {
  flag = !!flag;
  setStatus({ readOnly: flag });
  const cfg = getConfig();
  if (cfg.url && cfg.readOnly !== flag) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...cfg, readOnly: flag }));
  }
}

// Локальный тумблер «проверить как read-only» (Настройки → Синхронизация).
// Доступен только пользователю с обычным (read-write) токеном — переключает
// поведение интерфейса только на этом устройстве, сервера не касается.
export function setForceReadOnly(flag) {
  flag = !!flag;
  setStatus({ forceReadOnly: flag });
  const cfg = getConfig();
  if (cfg.url && cfg.forceReadOnly !== flag) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...cfg, forceReadOnly: flag }));
  }
}

// Число несинхронизованных изменений (для показа в UI).
export function pendingCount() {
  if (!isConfigured()) return 0;
  const push = computePush(store.exportRecords(), loadSyncState().snapshot, Date.now());
  return COLLECTIONS.reduce((n, name) => n + (push[name] || []).length, 0);
}

// ── Основной синк: push изменения + pull дельту, слить по LWW ──────────────

let inFlight = null;

export async function syncNow() {
  if (!isConfigured()) return { ok: false, reason: "not-configured" };
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const cfg = getConfig();
    setStatus({ syncing: true, lastError: "" });
    try {
      const ss = loadSyncState();
      const local = store.exportRecords();
      const push = computePush(local, ss.snapshot, Date.now());

      // Пропускаем push, если сервер уже сказал, что токен read-only (иначе он
      // отклонит непустой push 403-м на весь запрос — и мы потеряем pull-часть
      // вместе с ним), либо пользователь сам включил локальную проверку
      // forceReadOnly (Настройки → Синхронизация) — тогда пропускаем без
      // обращения к серверу вообще, чисто по своему выбору.
      const skipPush = cfg.readOnly || cfg.forceReadOnly;
      const body = { since: ss.lastSeq };
      if (!skipPush) {
        for (const name of COLLECTIONS) body[name] = push[name];
      }

      const resp = await postSync(cfg, body);
      rememberReadOnly(resp.readOnly);

      // Вливаем серверную дельту (LWW) — включая наши же эхо-записи.
      const per = {};
      for (const name of COLLECTIONS) per[name] = resp[name] || [];
      store.applyServerRecords(per);

      // Снимок: если реально пушили — текущие локальные записи (после слияния
      // мы = сервер). Если push пропустили — только то, что правда пришло с
      // сервера; локальные неотправленные правки остаются «в очереди», их
      // pendingCount() продолжит показывать как неотправленные.
      saveSyncState({
        lastSeq: resp.seq || 0,
        snapshot: skipPush
          ? mergeSnapshot(ss.snapshot, per)
          : snapshotFromRecords(store.exportRecords()),
      });

      setStatus({ syncing: false, lastSyncAt: Date.now(), lastError: "" });
      return { ok: true, seq: resp.seq, pushed: !skipPush && hasAny(push) };
    } catch (e) {
      setStatus({ syncing: false, lastError: e.message || String(e) });
      return { ok: false, reason: "error", error: e.message || String(e) };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Полностью заменить локальные данные серверными (для второго устройства).
export async function pullReplace() {
  if (!isConfigured()) return { ok: false, reason: "not-configured" };
  const cfg = getConfig();
  setStatus({ syncing: true, lastError: "" });
  try {
    const resp = await postSync(cfg, { since: 0 });
    rememberReadOnly(resp.readOnly);
    const per = {};
    for (const name of COLLECTIONS) per[name] = resp[name] || [];
    store.replaceFromServerRecords(per);
    saveSyncState({
      lastSeq: resp.seq || 0,
      snapshot: snapshotFromRecords(store.exportRecords()),
    });
    setStatus({ syncing: false, lastSyncAt: Date.now(), lastError: "" });
    return { ok: true, seq: resp.seq };
  } catch (e) {
    setStatus({ syncing: false, lastError: e.message || String(e) });
    return { ok: false, reason: "error", error: e.message || String(e) };
  }
}

// Проверка связи/токена: дёргаем /health и один пустой /sync (без push, только
// since:0). Сервер всё равно отдаёт полную дельту в ответе — сразу сливаем её
// в локальное хранилище: так самый первый контакт с сервером (в частности для
// read-only токена, чей обычный syncNow может 403-ться на локальных дефолтах
// этого устройства и потерять pull вместе с push) сразу подтягивает реальные
// данные склада, а не оставляет устройство пустым до случайного успешного синка.
export async function testConnection(url, token) {
  const cfg = { url: normUrl(url), token: (token || "").trim() };
  if (!cfg.url || !cfg.token) return { ok: false, error: "Заполните адрес и токен" };
  try {
    const h = await fetch(cfg.url + "/health");
    if (!h.ok) return { ok: false, error: "Сервер недоступен (/health " + h.status + ")" };
    const resp = await postSync(cfg, { since: 0 });
    rememberReadOnly(resp.readOnly);
    const per = {};
    for (const name of COLLECTIONS) per[name] = resp[name] || [];
    store.applyServerRecords(per);
    saveSyncState({
      lastSeq: resp.seq || 0,
      snapshot: mergeSnapshot(loadSyncState().snapshot, per),
    });
    return { ok: true, readOnly: !!resp.readOnly };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
