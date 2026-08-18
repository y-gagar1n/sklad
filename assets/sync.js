// sync.js — фоновая синхронизация с сервером (pull → merge → push).
//
// Модель простая, потому что у каждой записи есть updatedAt (штампуется при
// каждой правке в store.js): конфликты решаются whole-record LWW по updatedAt,
// одинаково для всех коллекций. Движения иммутабельны, поэтому их слияние —
// это union по id (+ тумбстоуны). Отдельного 3-way merge не нужно.
//
// Что храним локально (device-local, НЕ синкается):
//   sklad-sync-config    { url, token }
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
  const cfg = { url: normUrl(url), token: (token || "").trim() };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
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
  if (!resp.ok) throw new Error("Сервер вернул " + resp.status);
  return resp.json();
}

// ── Статус (для UI) ─────────────────────────────────────────────────────────

let status = {
  syncing: false,
  lastSyncAt: 0,
  lastError: "",
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

      const body = { since: ss.lastSeq };
      for (const name of COLLECTIONS) body[name] = push[name];

      const resp = await postSync(cfg, body);

      // Вливаем серверную дельту (LWW) — включая наши же эхо-записи.
      const per = {};
      for (const name of COLLECTIONS) per[name] = resp[name] || [];
      store.applyServerRecords(per);

      // Новый снимок = текущие локальные записи (после слияния мы = сервер).
      saveSyncState({
        lastSeq: resp.seq || 0,
        snapshot: snapshotFromRecords(store.exportRecords()),
      });

      setStatus({ syncing: false, lastSyncAt: Date.now(), lastError: "" });
      return { ok: true, seq: resp.seq, pushed: hasAny(push) };
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

// Проверка связи/токена: дёргаем /health и один пустой /sync.
export async function testConnection(url, token) {
  const cfg = { url: normUrl(url), token: (token || "").trim() };
  if (!cfg.url || !cfg.token) return { ok: false, error: "Заполните адрес и токен" };
  try {
    const h = await fetch(cfg.url + "/health");
    if (!h.ok) return { ok: false, error: "Сервер недоступен (/health " + h.status + ")" };
    await postSync(cfg, { since: 0 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
