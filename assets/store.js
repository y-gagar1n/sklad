// store.js — данные склада и их хранение в браузере (localStorage).
// Рабочее хранилище — локальное; поверх работает фоновый синк (sync.js) с
// сервером. Для синка у каждой записи есть updatedAt(ms) и флаг deleted
// (тумбстоун вместо жёсткого удаления), конфликты решаются LWW по updatedAt.
import { stockOf, todayISO, addDays, round2 } from "./calc.js";

const KEY = "sklad-state-v1";
const VERSION = 2;
export const SETTINGS_ID = "settings";

// Базовая метка для мигрированных записей: заведомо «старая», чтобы любая
// реальная правка (updatedAt=now) на любом устройстве побеждала по LWW.
const BASELINE = 1;

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Монотонные метки: строго возрастают даже при нескольких правках в одну
// миллисекунду — иначе LWW не смог бы упорядочить их и последняя правка
// потерялась бы при синке.
let lastStamp = 0;
function now() {
  const t = Date.now();
  lastStamp = t > lastStamp ? t : lastStamp + 1;
  return lastStamp;
}

function defaultSettings() {
  return {
    // Рабочие дни недели: 0=Вс … 6=Сб. По умолчанию Пн–Пт.
    workingDays: [1, 2, 3, 4, 5],
    // Считать средние только по рабочим дням.
    workingDaysOnly: true,
    // Окно усреднения расхода, дней.
    windowDays: 30,
  };
}

function defaultState() {
  const floorId = uid();
  const t = now();
  return {
    version: VERSION,
    settings: defaultSettings(),
    settingsUpdatedAt: t,
    // Этажи: у каждого свой остаток; категории и товары общие для всех этажей.
    floors: [{ id: floorId, name: "Этаж 1", order: 0, updatedAt: t, deleted: false }],
    activeFloorId: floorId, // device-local, не синкается
    categories: [],
    items: [],
    movements: [],
  };
}

// Описание синкаемых коллекций: какие поля попадают в payload (data).
const COLLS = {
  categories: ["name", "order"],
  items: ["categoryId", "name", "unit", "minStock", "order"],
  floors: ["name", "order"],
  movements: ["itemId", "floorId", "date", "type", "qty", "adjust", "transfer", "note"],
};

// Живые (не удалённые) этажи.
function liveFloors(st) {
  return st.floors.filter((f) => !f.deleted);
}

// Гарантируем: хотя бы один живой этаж, корректный activeFloorId, floorId у
// движений (миграция старых данных без этажей).
function ensureFloors(st) {
  if (!Array.isArray(st.floors)) st.floors = [];
  if (liveFloors(st).length === 0) {
    st.floors.push({ id: uid(), name: "Этаж 1", order: 0, updatedAt: now(), deleted: false });
  }
  const liveIds = new Set(liveFloors(st).map((f) => f.id));
  if (!st.activeFloorId || !liveIds.has(st.activeFloorId)) {
    st.activeFloorId = liveFloors(st)[0].id;
  }
  const def = liveFloors(st)[0].id;
  for (const m of st.movements) if (!m.floorId) m.floorId = def;
  return st;
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return normalize(parsed);
  } catch (e) {
    console.warn("Не удалось прочитать данные, стартуем с чистого листа", e);
    return defaultState();
  }
}

// Мягкая миграция/защита от кривых данных + бэкфилл полей синка (updatedAt/deleted).
function normalize(s) {
  const base = defaultState();
  const out = {
    version: VERSION,
    settings: { ...base.settings, ...(s.settings || {}) },
    settingsUpdatedAt: s.settingsUpdatedAt || BASELINE,
    floors: Array.isArray(s.floors) ? s.floors : [],
    activeFloorId: s.activeFloorId || null,
    categories: Array.isArray(s.categories) ? s.categories : [],
    items: Array.isArray(s.items) ? s.items : [],
    movements: Array.isArray(s.movements) ? s.movements : [],
  };
  if (!Array.isArray(out.settings.workingDays) || !out.settings.workingDays.length) {
    out.settings.workingDays = base.settings.workingDays;
  }
  // Бэкфилл updatedAt/deleted для записей без полей синка.
  for (const name of Object.keys(COLLS)) {
    for (const rec of out[name]) {
      if (rec.updatedAt === undefined) rec.updatedAt = BASELINE;
      if (rec.deleted === undefined) rec.deleted = false;
    }
  }
  return ensureFloors(out);
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
  notifyChange();
}

// Подписка на изменения (для автосинка).
const changeListeners = new Set();
export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function notifyChange() {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch (e) {
      console.warn("change listener error", e);
    }
  }
}

// ── Чтение ────────────────────────────────────────────────────────────────

export function getState() {
  return state;
}

export function getSettings() {
  return state.settings;
}

export function calcOpts(asOf = todayISO()) {
  return {
    asOf,
    windowDays: state.settings.windowDays,
    workingDaysOnly: state.settings.workingDaysOnly,
    workingDays: state.settings.workingDays,
  };
}

export function categories() {
  return state.categories.filter((c) => !c.deleted).sort((a, b) => a.order - b.order);
}

export function itemsOf(categoryId) {
  return state.items
    .filter((i) => !i.deleted && i.categoryId === categoryId)
    .sort((a, b) => a.order - b.order);
}

export function allItems() {
  return state.items.filter((i) => !i.deleted).sort((a, b) => a.order - b.order);
}

export function getItem(id) {
  return state.items.find((i) => i.id === id && !i.deleted) || null;
}

export function getCategory(id) {
  return state.categories.find((c) => c.id === id && !c.deleted) || null;
}

export function movementsForItem(id, floorId = state.activeFloorId) {
  return state.movements
    .filter(
      (m) =>
        !m.deleted && m.itemId === id && (floorId == null || m.floorId === floorId),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function stockForItem(id, floorId = state.activeFloorId) {
  return stockOf(movementsForItem(id, floorId));
}

// Товары категории с положительным остатком на этаже. На экране «Товары»
// нулевые прячем (их всё ещё находит поиск — это делает View).
export function itemsInStockOf(categoryId, floorId = state.activeFloorId) {
  return itemsOf(categoryId).filter((it) => stockForItem(it.id, floorId) > 0);
}

// Есть ли в категории хоть один товар с остатком на этаже. Если нет —
// категория на экране «Товары» скрывается целиком.
export function categoryHasStock(categoryId, floorId = state.activeFloorId) {
  return itemsOf(categoryId).some((it) => stockForItem(it.id, floorId) > 0);
}

// ── Этажи ────────────────────────────────────────────────────────────────

export function floors() {
  // Сортировка по имени с учётом чисел: «Этаж 2» раньше «Этаж 10».
  return state.floors
    .filter((f) => !f.deleted)
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
}

export function getFloor(id) {
  return state.floors.find((f) => f.id === id && !f.deleted) || null;
}

export function getActiveFloorId() {
  return state.activeFloorId;
}

export function getActiveFloor() {
  return getFloor(state.activeFloorId);
}

export function setActiveFloor(id) {
  if (getFloor(id)) {
    state.activeFloorId = id; // device-local, не синкается — но persist для памяти
    persist();
  }
}

export function addFloor(name) {
  const floor = {
    id: uid(),
    name: String(name).trim() || "Этаж",
    order: state.floors.length,
    updatedAt: now(),
    deleted: false,
  };
  state.floors.push(floor);
  persist();
  return floor;
}

export function renameFloor(id, name) {
  const f = getFloor(id);
  if (f) {
    f.name = String(name).trim() || f.name;
    f.updatedAt = now();
    persist();
  }
}

// Удаление этажа = тумбстоун этажа и всех его движений. Последний живой этаж
// удалить нельзя.
export function deleteFloor(id) {
  if (liveFloors(state).length <= 1) return false;
  const f = state.floors.find((x) => x.id === id && !x.deleted);
  if (!f) return false;
  const t = now();
  f.deleted = true;
  f.updatedAt = t;
  for (const m of state.movements) {
    if (m.floorId === id && !m.deleted) {
      m.deleted = true;
      m.updatedAt = t;
    }
  }
  if (state.activeFloorId === id) state.activeFloorId = liveFloors(state)[0].id;
  persist();
  return true;
}

// Перенос количества товара с этажа на этаж. Помечены transfer:true — в средний
// расход не идут (это перемещение, не расход), но на остаток влияют.
export function transferStock(itemId, fromFloorId, toFloorId, qty, date = todayISO()) {
  const amount = Math.abs(Number(qty) || 0);
  if (amount <= 0 || fromFloorId === toFloorId) return false;
  const from = getFloor(fromFloorId);
  const to = getFloor(toFloorId);
  if (!from || !to) return false;
  if (amount > stockForItem(itemId, fromFloorId)) return false;
  const note = `Перенос: ${from.name} → ${to.name}`;
  addMovement(itemId, { date, type: "out", qty: amount, transfer: true, floorId: fromFloorId, note });
  addMovement(itemId, { date, type: "in", qty: amount, transfer: true, floorId: toFloorId, note });
  return true;
}

// ── Настройки ──────────────────────────────────────────────────────────────

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  state.settingsUpdatedAt = now();
  persist();
}

// ── Категории ────────────────────────────────────────────────────────────

export function addCategory(name) {
  const cat = {
    id: uid(),
    name: name.trim(),
    order: state.categories.length,
    updatedAt: now(),
    deleted: false,
  };
  state.categories.push(cat);
  persist();
  return cat;
}

export function renameCategory(id, name) {
  const c = getCategory(id);
  if (c) {
    c.name = name.trim();
    c.updatedAt = now();
    persist();
  }
}

// Удаление категории = тумбстоун категории, её товаров и их движений.
export function deleteCategory(id) {
  const t = now();
  const itemIds = new Set(
    state.items.filter((i) => i.categoryId === id && !i.deleted).map((i) => i.id),
  );
  for (const i of state.items) {
    if (i.categoryId === id && !i.deleted) {
      i.deleted = true;
      i.updatedAt = t;
    }
  }
  for (const m of state.movements) {
    if (itemIds.has(m.itemId) && !m.deleted) {
      m.deleted = true;
      m.updatedAt = t;
    }
  }
  const c = state.categories.find((x) => x.id === id);
  if (c) {
    c.deleted = true;
    c.updatedAt = t;
  }
  persist();
}

// ── Товары (подкатегории) ─────────────────────────────────────────────────

export function addItem(categoryId, { name, unit = "шт", minStock = 0 }) {
  const item = {
    id: uid(),
    categoryId,
    name: name.trim(),
    unit: unit.trim() || "шт",
    minStock: Number(minStock) || 0,
    order: itemsOf(categoryId).length,
    updatedAt: now(),
    deleted: false,
  };
  state.items.push(item);
  persist();
  return item;
}

export function updateItem(id, patch) {
  const it = getItem(id);
  if (!it) return;
  if (patch.name !== undefined) it.name = String(patch.name).trim();
  if (patch.unit !== undefined) it.unit = String(patch.unit).trim() || "шт";
  if (patch.minStock !== undefined) it.minStock = Number(patch.minStock) || 0;
  if (patch.categoryId !== undefined) it.categoryId = patch.categoryId;
  it.updatedAt = now();
  persist();
}

// Удаление товара = тумбстоун товара и его движений.
export function deleteItem(id) {
  const t = now();
  const it = state.items.find((x) => x.id === id);
  if (it) {
    it.deleted = true;
    it.updatedAt = t;
  }
  for (const m of state.movements) {
    if (m.itemId === id && !m.deleted) {
      m.deleted = true;
      m.updatedAt = t;
    }
  }
  persist();
}

// ── Движения (приход / расход / инвентаризация) ───────────────────────────

export function addMovement(
  itemId,
  { date, type, qty, note = "", adjust = false, transfer = false, floorId },
) {
  const m = {
    id: uid(),
    itemId,
    floorId: floorId || state.activeFloorId,
    date: date || todayISO(),
    type, // 'in' | 'out'
    qty: Math.abs(Number(qty) || 0),
    adjust: !!adjust,
    transfer: !!transfer,
    note: String(note || ""),
    updatedAt: now(),
    deleted: false,
  };
  state.movements.push(m);
  persist();
  return m;
}

// Инвентаризация: выставить фактический остаток на дату.
export function setStock(
  itemId,
  targetQty,
  date = todayISO(),
  note = "Инвентаризация",
  floorId = state.activeFloorId,
) {
  const current = stockForItem(itemId, floorId);
  const delta = Number(targetQty) - current;
  if (delta === 0) return null;
  return addMovement(itemId, {
    date,
    type: delta > 0 ? "in" : "out",
    qty: Math.abs(delta),
    adjust: true,
    floorId,
    note,
  });
}

// Удаление движения = тумбстоун.
export function deleteMovement(id) {
  const m = state.movements.find((x) => x.id === id);
  if (m && !m.deleted) {
    m.deleted = true;
    m.updatedAt = now();
    persist();
  }
}

// Редактирование движения: меняем дату/количество/заметку и бампаем updatedAt,
// поэтому правка нормально уезжает по синку (LWW-слияние по updatedAt, как у
// любой записи). Переносы (transfer) не трогаем — они парные, правка одной
// половины рассинхронила бы остатки этажей.
export function updateMovement(id, { date, qty, note } = {}) {
  const m = state.movements.find((x) => x.id === id && !x.deleted);
  if (!m || m.transfer) return null;
  if (date) m.date = date;
  if (qty !== undefined) m.qty = Math.abs(Number(qty) || 0);
  if (note !== undefined) m.note = String(note || "");
  m.updatedAt = now();
  persist();
  return m;
}

// ── Экспорт / импорт (резервная копия и перенос между устройствами) ────────

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  state = normalize(parsed);
  persist();
}

export function replaceState(newState) {
  state = normalize(newState);
  persist();
}

// ── Синхронизация: запись как {id, updatedAt, deleted, data} ───────────────

function toRecord(obj, fields) {
  const data = {};
  for (const f of fields) data[f] = obj[f];
  return { id: obj.id, updatedAt: obj.updatedAt ?? BASELINE, deleted: !!obj.deleted, data };
}

// Все локальные записи (включая тумбстоуны) по коллекциям — для отправки/диффа.
export function exportRecords() {
  const out = {};
  for (const [name, fields] of Object.entries(COLLS)) {
    out[name] = state[name].map((o) => toRecord(o, fields));
  }
  out.settings = [
    {
      id: SETTINGS_ID,
      updatedAt: state.settingsUpdatedAt ?? BASELINE,
      deleted: false,
      data: { ...state.settings },
    },
  ];
  return out;
}

function rebuildRecord(rec, fields) {
  const obj = { id: rec.id, updatedAt: rec.updatedAt, deleted: !!rec.deleted };
  const data = rec.data || {};
  for (const f of fields) obj[f] = data[f];
  return obj;
}

// LWW-слияние серверных записей в локальный стейт. Возвращает true, если что-то
// изменилось. Не трогает device-local поля (activeFloorId).
export function applyServerRecords(per) {
  let changed = false;
  for (const [name, fields] of Object.entries(COLLS)) {
    const arr = state[name];
    const idx = new Map(arr.map((o, i) => [o.id, i]));
    for (const rec of per[name] || []) {
      if (!rec || !rec.id) continue;
      const i = idx.get(rec.id);
      if (i === undefined) {
        arr.push(rebuildRecord(rec, fields));
        changed = true;
      } else if (rec.updatedAt > arr[i].updatedAt) {
        arr[i] = rebuildRecord(rec, fields);
        changed = true;
      }
    }
  }
  for (const rec of per.settings || []) {
    if (rec.id === SETTINGS_ID && rec.updatedAt > (state.settingsUpdatedAt ?? BASELINE)) {
      state.settings = { ...defaultSettings(), ...(rec.data || {}) };
      state.settingsUpdatedAt = rec.updatedAt;
      changed = true;
    }
  }
  if (changed) {
    ensureFloors(state);
    persist();
  }
  return changed;
}

// Полностью пересобрать стейт из серверных записей (для вторичного устройства:
// «заменить локальные данные серверными»). activeFloorId выставляем локально.
export function replaceFromServerRecords(per) {
  const fresh = {
    version: VERSION,
    settings: defaultSettings(),
    settingsUpdatedAt: BASELINE,
    floors: [],
    categories: [],
    items: [],
    movements: [],
    activeFloorId: null,
  };
  for (const [name, fields] of Object.entries(COLLS)) {
    for (const rec of per[name] || []) {
      if (rec && rec.id) fresh[name].push(rebuildRecord(rec, fields));
    }
  }
  for (const rec of per.settings || []) {
    if (rec.id === SETTINGS_ID) {
      fresh.settings = { ...defaultSettings(), ...(rec.data || {}) };
      fresh.settingsUpdatedAt = rec.updatedAt;
    }
  }
  state = ensureFloors(fresh);
  persist();
}

// ── Импорт разобранного Excel (заменяет все данные) ───────────────────────
export function importFromParsed(parsed, today = todayISO()) {
  state = defaultState();

  const def = state.floors[0];
  const floorId = new Map([[def.name, def.id]]);
  for (const fname of parsed.floors || []) {
    if (!floorId.has(fname)) floorId.set(fname, addFloor(fname).id);
  }

  const catId = new Map();
  for (const name of parsed.categories || []) {
    if (!catId.has(name)) catId.set(name, addCategory(name).id);
  }

  const itemId = new Map();
  for (const it of parsed.items || []) {
    let cid = catId.get(it.category);
    if (!cid) {
      cid = addCategory(it.category).id;
      catId.set(it.category, cid);
    }
    const ikey = it.category + " " + it.name;
    let iid = itemId.get(ikey);
    if (!iid) {
      iid = addItem(cid, { name: it.name, unit: "шт", minStock: 0 }).id;
      itemId.set(ikey, iid);
    }

    const fid = floorId.get(it.floor) || def.id;
    // Реальные движения из Excel — переносим как есть, с их датами.
    const moves = (it.moves || []).filter((m) => m.qty > 0);
    const sumIn = moves.reduce((s, m) => (m.type === "in" ? s + m.qty : s), 0);
    const sumOut = moves.reduce((s, m) => (m.type === "out" ? s + m.qty : s), 0);
    // Остаток на начало периода досчитываем так, чтобы после всех движений
    // текущий остаток совпал с «Итого остаток» из таблицы:
    //   начало = остаток − Σприход + Σрасход.
    const opening = round2((Number(it.stock) || 0) - sumIn + sumOut);

    let openDate = today;
    if (moves.length) {
      const earliest = moves.reduce((a, m) => (m.date < a ? m.date : a), moves[0].date);
      openDate = addDays(earliest, -1);
    }
    // Начальный остаток — одной инвентаризационной записью (в плюс или в минус).
    if (opening !== 0) {
      addMovement(iid, {
        date: openDate,
        type: opening > 0 ? "in" : "out",
        qty: Math.abs(opening),
        adjust: true,
        floorId: fid,
        note: "Импорт: остаток на начало",
      });
    }
    for (const m of moves) {
      addMovement(iid, {
        date: m.date,
        type: m.type,
        qty: m.qty,
        floorId: fid,
        note: "Импорт из Excel",
      });
    }
  }
  state.activeFloorId = def.id;
  persist();
}

// ── Демо-данные ────────────────────────────────────────────────────────────

export function seedDemo() {
  state = defaultState();

  const c1 = addCategory("Молочные продукты");
  const c2 = addCategory("Бакалея");
  const c3 = addCategory("Напитки");

  const milk = addItem(c1.id, { name: "Молоко", unit: "л", minStock: 20 });
  const cheese = addItem(c1.id, { name: "Сыр", unit: "кг", minStock: 5 });
  const flour = addItem(c2.id, { name: "Мука", unit: "кг", minStock: 30 });
  const sugar = addItem(c2.id, { name: "Сахар", unit: "кг", minStock: 25 });
  const water = addItem(c3.id, { name: "Вода 5 л", unit: "шт", minStock: 40 });

  const today = todayISO();
  const start = shift(today, -20);
  addMovement(milk.id, { date: start, type: "in", qty: 250 });
  addMovement(cheese.id, { date: start, type: "in", qty: 60 });
  addMovement(flour.id, { date: start, type: "in", qty: 250 });
  addMovement(sugar.id, { date: start, type: "in", qty: 200 });
  addMovement(water.id, { date: start, type: "in", qty: 250 });

  const plan = [
    [milk, 12],
    [cheese, 2.5],
    [flour, 8],
    [sugar, 6],
    [water, 9],
  ];
  for (let d = 19; d >= 1; d--) {
    const date = shift(today, -d);
    const dow = new Date(date).getDay();
    if (dow === 0 || dow === 6) continue;
    for (const [item, qty] of plan) {
      addMovement(item.id, { date, type: "out", qty });
    }
  }
  persist();
}

function shift(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
