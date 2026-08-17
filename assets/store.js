// store.js — данные склада и их хранение в браузере (localStorage).
// Всё локально на устройстве; резервная копия — экспорт/импорт JSON.
import { stockOf, todayISO, addDays } from "./calc.js";

const KEY = "sklad-state-v1";
const VERSION = 1;

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function defaultState() {
  const floorId = uid();
  return {
    version: VERSION,
    settings: {
      // Рабочие дни недели: 0=Вс … 6=Сб. По умолчанию Пн–Пт.
      workingDays: [1, 2, 3, 4, 5],
      // Считать средние только по рабочим дням.
      workingDaysOnly: true,
      // Окно усреднения расхода, дней.
      windowDays: 30,
    },
    // Этажи: у каждого свой остаток; категории и товары общие для всех этажей.
    floors: [{ id: floorId, name: "Этаж 1", order: 0 }],
    activeFloorId: floorId,
    categories: [],
    items: [],
    movements: [],
  };
}

// Гарантируем наличие хотя бы одного этажа, корректный активный этаж и
// проставленный floorId у всех движений (миграция старых данных без этажей).
function ensureFloors(st) {
  if (!Array.isArray(st.floors)) st.floors = [];
  if (st.floors.length === 0) {
    st.floors.push({ id: uid(), name: "Этаж 1", order: 0 });
  }
  const ids = new Set(st.floors.map((f) => f.id));
  if (!st.activeFloorId || !ids.has(st.activeFloorId)) {
    st.activeFloorId = st.floors[0].id;
  }
  const def = st.floors[0].id;
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

// Мягкая миграция/защита от кривых данных.
function normalize(s) {
  const base = defaultState();
  const out = {
    version: VERSION,
    settings: { ...base.settings, ...(s.settings || {}) },
    floors: Array.isArray(s.floors) ? s.floors : [],
    activeFloorId: s.activeFloorId || null,
    categories: Array.isArray(s.categories) ? s.categories : [],
    items: Array.isArray(s.items) ? s.items : [],
    movements: Array.isArray(s.movements) ? s.movements : [],
  };
  if (!Array.isArray(out.settings.workingDays) || !out.settings.workingDays.length) {
    out.settings.workingDays = base.settings.workingDays;
  }
  return ensureFloors(out);
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
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
  return [...state.categories].sort((a, b) => a.order - b.order);
}

export function itemsOf(categoryId) {
  return state.items
    .filter((i) => i.categoryId === categoryId)
    .sort((a, b) => a.order - b.order);
}

export function allItems() {
  return [...state.items].sort((a, b) => a.order - b.order);
}

export function getItem(id) {
  return state.items.find((i) => i.id === id) || null;
}

export function getCategory(id) {
  return state.categories.find((c) => c.id === id) || null;
}

export function movementsForItem(id, floorId = state.activeFloorId) {
  return state.movements
    .filter((m) => m.itemId === id && (floorId == null || m.floorId === floorId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function stockForItem(id, floorId = state.activeFloorId) {
  return stockOf(movementsForItem(id, floorId));
}

// ── Этажи ────────────────────────────────────────────────────────────────

export function floors() {
  return [...state.floors].sort((a, b) => a.order - b.order);
}

export function getFloor(id) {
  return state.floors.find((f) => f.id === id) || null;
}

export function getActiveFloorId() {
  return state.activeFloorId;
}

export function getActiveFloor() {
  return getFloor(state.activeFloorId);
}

export function setActiveFloor(id) {
  if (getFloor(id)) {
    state.activeFloorId = id;
    persist();
  }
}

export function addFloor(name) {
  const floor = { id: uid(), name: String(name).trim() || "Этаж", order: state.floors.length };
  state.floors.push(floor);
  persist();
  return floor;
}

export function renameFloor(id, name) {
  const f = getFloor(id);
  if (f) {
    f.name = String(name).trim() || f.name;
    persist();
  }
}

// Удаление этажа вместе с его движениями. Последний этаж удалить нельзя.
export function deleteFloor(id) {
  if (state.floors.length <= 1) return false;
  state.floors = state.floors.filter((f) => f.id !== id);
  state.movements = state.movements.filter((m) => m.floorId !== id);
  if (state.activeFloorId === id) state.activeFloorId = state.floors[0].id;
  persist();
  return true;
}

// Перенос количества товара с этажа на этаж. Расход/приход-переносы помечены
// transfer:true и не учитываются в среднем расходе (это перемещение, не расход).
export function transferStock(itemId, fromFloorId, toFloorId, qty, date = todayISO()) {
  const amount = Math.abs(Number(qty) || 0);
  if (amount <= 0 || fromFloorId === toFloorId) return false;
  const from = getFloor(fromFloorId);
  const to = getFloor(toFloorId);
  if (!from || !to) return false;
  // Нельзя перенести больше, чем есть на исходном этаже.
  if (amount > stockForItem(itemId, fromFloorId)) return false;
  const note = `Перенос: ${from.name} → ${to.name}`;
  addMovement(itemId, { date, type: "out", qty: amount, transfer: true, floorId: fromFloorId, note });
  addMovement(itemId, { date, type: "in", qty: amount, transfer: true, floorId: toFloorId, note });
  return true;
}

// ── Настройки ──────────────────────────────────────────────────────────────

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
}

// ── Категории ────────────────────────────────────────────────────────────

export function addCategory(name) {
  const cat = {
    id: uid(),
    name: name.trim(),
    order: state.categories.length,
  };
  state.categories.push(cat);
  persist();
  return cat;
}

export function renameCategory(id, name) {
  const c = getCategory(id);
  if (c) {
    c.name = name.trim();
    persist();
  }
}

export function deleteCategory(id) {
  const itemIds = new Set(
    state.items.filter((i) => i.categoryId === id).map((i) => i.id),
  );
  state.items = state.items.filter((i) => i.categoryId !== id);
  state.movements = state.movements.filter((m) => !itemIds.has(m.itemId));
  state.categories = state.categories.filter((c) => c.id !== id);
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
  persist();
}

export function deleteItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  state.movements = state.movements.filter((m) => m.itemId !== id);
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
  };
  state.movements.push(m);
  persist();
  return m;
}

// Инвентаризация: выставить фактический остаток на дату.
// Разницу с текущим складываем как корректировочное движение (adjust:true),
// поэтому остаток всегда пересчитывается из истории.
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

export function deleteMovement(id) {
  state.movements = state.movements.filter((m) => m.id !== id);
  persist();
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

// ── Импорт разобранного Excel (заменяет все данные) ───────────────────────
// parsed: { categories:[имена], floors:[имена], items:[{category,name,floor,stock,outs}] }
// Остаток восстанавливаем как приход = остаток + суммарный расход, датированный
// до первого расхода: stock = Σприход − Σрасход даёт ровно текущий остаток,
// а движения расхода наполняют средние. Товар с указанным этажом кладём на
// соответствующий этаж (по умолчанию — «Этаж 1»).
export function importFromParsed(parsed, today = todayISO()) {
  state = defaultState();

  // Этажи: дефолтный «Этаж 1» уже есть, остальные добавляем из файла.
  const def = state.floors[0];
  const floorId = new Map([[def.name, def.id]]);
  for (const fname of parsed.floors || []) {
    if (!floorId.has(fname)) floorId.set(fname, addFloor(fname).id);
  }

  const catId = new Map();
  for (const name of parsed.categories || []) {
    if (!catId.has(name)) catId.set(name, addCategory(name).id);
  }

  const itemId = new Map(); // ключ «категория\0товар» -> id (один товар на все этажи)
  for (const it of parsed.items || []) {
    let cid = catId.get(it.category);
    if (!cid) {
      cid = addCategory(it.category).id;
      catId.set(it.category, cid);
    }
    const ikey = it.category + " " + it.name;
    let iid = itemId.get(ikey);
    if (!iid) {
      iid = addItem(cid, { name: it.name, unit: "шт", minStock: 0 }).id;
      itemId.set(ikey, iid);
    }

    const fid = floorId.get(it.floor) || def.id;
    const outs = (it.outs || []).filter((o) => o.qty > 0);
    const totalOut = outs.reduce((s, o) => s + o.qty, 0);
    const openStock = (Number(it.stock) || 0) + totalOut;

    let openDate = today;
    if (outs.length) {
      const earliest = outs.reduce((a, o) => (o.date < a ? o.date : a), outs[0].date);
      openDate = addDays(earliest, -1);
    }
    if (openStock > 0) {
      addMovement(iid, {
        date: openDate,
        type: "in",
        qty: openStock,
        adjust: true,
        floorId: fid,
        note: "Импорт из Excel",
      });
    }
    for (const o of outs) {
      addMovement(iid, {
        date: o.date,
        type: "out",
        qty: o.qty,
        floorId: fid,
        note: "Импорт из Excel",
      });
    }
  }
  state.activeFloorId = def.id; // после импорта активен дефолтный этаж
  persist();
}

// ── Демо-данные (по кнопке в настройках) ──────────────────────────────────

export function seedDemo() {
  const s = defaultState();
  state = s;

  const c1 = addCategory("Молочные продукты");
  const c2 = addCategory("Бакалея");
  const c3 = addCategory("Напитки");

  const milk = addItem(c1.id, { name: "Молоко", unit: "л", minStock: 20 });
  const cheese = addItem(c1.id, { name: "Сыр", unit: "кг", minStock: 5 });
  const flour = addItem(c2.id, { name: "Мука", unit: "кг", minStock: 30 });
  const sugar = addItem(c2.id, { name: "Сахар", unit: "кг", minStock: 25 });
  const water = addItem(c3.id, { name: "Вода 5 л", unit: "шт", minStock: 40 });

  // Стартовые приходы 20 дней назад и ежедневный расход по рабочим дням.
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
    if (dow === 0 || dow === 6) continue; // выходные пропускаем
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
