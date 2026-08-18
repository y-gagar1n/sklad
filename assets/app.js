// app.js — интерфейс приложения: навигация, экраны, формы.
// Логика расчётов — в calc.js, данные — в store.js.
import * as store from "./store.js";
import * as sync from "./sync.js";
import { parseWorkbook } from "./xlsx-import.js";
import {
  itemSummary,
  addDays,
  sumConsumption,
  sumReceipts,
  todayISO,
  URGENCY,
} from "./calc.js";

// ── Утилиты ───────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Единицу «шт» (значение по умолчанию) в интерфейсе не показываем.
function un(unit) {
  return unit === "шт" ? "" : unit;
}

// Число → аккуратная строка (без хвостовых нулей, ру-разделители).
function fmt(n) {
  if (n === Infinity) return "∞";
  if (n == null || Number.isNaN(n)) return "0";
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString("ru-RU");
}

const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${d} ${MONTHS[m - 1]}, ${WD_SHORT[dt.getDay()]}`;
}

const URGENCY_LABEL = {
  [URGENCY.OK]: "В норме",
  [URGENCY.SOON]: "Скоро",
  [URGENCY.CRITICAL]: "Срочно",
};

function urgencyOrder(u) {
  return u === URGENCY.CRITICAL ? 0 : u === URGENCY.SOON ? 1 : 2;
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ── Нижний лист (формы) ───────────────────────────────────────────────────

function openSheet(html, { fixed = false } = {}) {
  const sheet = $("#sheet");
  sheet.style.transition = "";
  sheet.style.transform = "";
  // Фиксированная высота (для листов с растущим списком — поле ввода вверху не
  // скачет при появлении результатов, растёт скроллимая область, а не сам лист).
  sheet.classList.toggle("sheet-fixed", fixed);
  $("#sheet-content").innerHTML = html;
  $("#sheet-content").scrollTop = 0;
  $("#sheet-backdrop").classList.add("open");
  document.body.style.overflow = "hidden";
  return $("#sheet-content");
}
function closeSheet() {
  $("#sheet-backdrop").classList.remove("open");
  document.body.style.overflow = "";
  const sheet = $("#sheet");
  sheet.style.transform = "";
}
$("#sheet-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "sheet-backdrop") closeSheet();
});
$("#sheet-close").addEventListener("click", closeSheet);

// Свайп вниз по «ручке» листа — закрыть.
(function sheetSwipe() {
  const grabber = $("#sheet-grabber");
  const sheet = $("#sheet");
  let startY = 0;
  let dy = 0;
  let dragging = false;
  grabber.addEventListener(
    "touchstart",
    (e) => {
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = true;
      sheet.style.transition = "none";
    },
    { passive: true },
  );
  grabber.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    },
    { passive: false },
  );
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = "";
    if (dy > 90) closeSheet();
    sheet.style.transform = "";
  };
  grabber.addEventListener("touchend", end);
  grabber.addEventListener("touchcancel", end);
})();

// ── Навигация ──────────────────────────────────────────────────────────────

const RENDERERS = {
  overview: renderOverview,
  entry: renderEntry,
  items: renderItems,
  analytics: renderAnalytics,
  settings: renderSettings,
};
let currentTab = "overview";

function switchTab(tab) {
  currentTab = tab;
  $$(".tabbar button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab),
  );
  $$(".view").forEach((v) => v.classList.remove("active"));
  const view = $(`#view-${tab}`);
  view.classList.add("active");
  $("#header-title").textContent = view.dataset.title;
  $("#header-subtitle").textContent = view.dataset.subtitle;
  // Кнопка «+» в шапке — быстрое добавление категории на вкладке «Товары».
  $("#header-action").hidden = tab !== "items";
  render();
  window.scrollTo(0, 0);
}

$("#header-action").addEventListener("click", () => {
  if (currentTab === "items") sheetAddCategory();
});

$("#tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) switchTab(btn.dataset.tab);
});

// Перерисовать текущий экран (после любой правки данных).
function render() {
  RENDERERS[currentTab]();
}

// Панель этажей — быстрое переключение. Показываем на экранах, привязанных к
// этажу (Обзор, Ввод, Товары, Аналитика). Категории и товары общие, остаток свой.
function floorBar() {
  const fl = store.floors();
  const active = store.getActiveFloorId();
  return `<div class="floor-bar">
    ${fl
      .map(
        (f) =>
          `<button class="floor-chip ${f.id === active ? "on" : ""}" data-floor="${f.id}">${esc(f.name)}</button>`,
      )
      .join("")}
    <button class="floor-chip add" data-act="add-floor" title="Добавить этаж">＋</button>
  </div>`;
}

// ── Экран: Обзор ───────────────────────────────────────────────────────────

function renderOverview() {
  const view = $("#view-overview");
  const cats = store.categories();
  const items = store.allItems();

  if (items.length === 0) {
    view.innerHTML = emptyState(
      "📦",
      "Пока пусто",
      "Добавьте категории и товары, чтобы вести учёт остатков.",
      `<button class="btn block" data-act="go-items">Перейти к товарам</button>
       <div class="spacer"></div>
       <button class="btn secondary block" data-act="seed">Загрузить демо-данные</button>`,
    );
    return;
  }

  const opts = store.calcOpts();
  const rows = items.map((it) => {
    const s = itemSummary(store.movementsForItem(it.id), it, opts);
    return { it, s };
  });

  // Нужно заказать — сначала «срочно», затем «скоро».
  const toOrder = rows
    .filter((r) => r.s.urgency !== URGENCY.OK)
    .sort((a, b) => urgencyOrder(a.s.urgency) - urgencyOrder(b.s.urgency));

  const critCount = rows.filter((r) => r.s.urgency === URGENCY.CRITICAL).length;
  const soonCount = rows.filter((r) => r.s.urgency === URGENCY.SOON).length;

  let html =
    floorBar() +
    `
    <div class="metric-grid">
      <div class="metric">
        <div class="label">Позиций</div>
        <div class="value">${items.length}</div>
      </div>
      <div class="metric">
        <div class="label">Категорий</div>
        <div class="value">${cats.length}</div>
      </div>
      <div class="metric">
        <div class="label">Срочно</div>
        <div class="value" style="color:var(--crit)">${critCount}</div>
      </div>
      <div class="metric">
        <div class="label">Скоро</div>
        <div class="value" style="color:var(--soon)">${soonCount}</div>
      </div>
    </div>`;

  html += `<h2 class="section-title">Что заказать</h2>`;
  if (toOrder.length === 0) {
    html += `<div class="card card-pad" style="text-align:center">
      <div class="big-emoji" style="font-size:36px">✅</div>
      <div style="font-weight:700;margin-top:6px">Всё в достатке</div>
      <div class="muted" style="margin-top:4px">Ничего заказывать не нужно.</div>
    </div>`;
  } else {
    html += `<div class="card">`;
    html += toOrder
      .map((r) => orderRow(r.it, r.s))
      .join("");
    html += `</div>`;
  }

  // Остаток по категориям.
  html += `<h2 class="section-title">Остаток по категориям</h2><div class="card">`;
  html += cats
    .map((c) => {
      const its = store.itemsOf(c.id);
      const total = its.reduce((sum, it) => sum + store.stockForItem(it.id), 0);
      return `<div class="list-item" data-cat-jump="${c.id}">
        <div class="grow">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${its.length} поз.</div>
        </div>
        <div class="nowrap" style="font-weight:700">${fmt(total)}</div>
      </div>`;
    })
    .join("");
  html += `</div>`;

  view.innerHTML = html;
}

function orderRow(it, s) {
  const daysTxt = s.daysLeft === Infinity ? "нет расхода" : `хватит ~${fmt(s.daysLeft)} дн.`;
  return `<div class="list-item" data-item="${it.id}">
    <span class="dot ${s.urgency}"></span>
    <div class="grow">
      <div class="name">${esc(it.name)}</div>
      <div class="sub">Остаток ${fmt(s.stock)} ${esc(un(it.unit))} · ${daysTxt}</div>
    </div>
    <div style="text-align:right">
      <div style="font-weight:800">＋${fmt(s.order)}</div>
      <div class="badge ${s.urgency}" style="margin-top:2px">${URGENCY_LABEL[s.urgency]}</div>
    </div>
  </div>`;
}

// ── Экран: Товары ─────────────────────────────────────────────────────────

let itemSearch = "";

// Свёрнутые категории (id). Помним между сессиями в отдельном ключе.
const COLLAPSE_KEY = "sklad-collapsed";
let collapsedCats = new Set(loadCollapsed());
function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedCats]));
}

// Свёрнутость секций настроек (этажи/категории). По умолчанию свёрнуты;
// состояние держим только в памяти сессии (при перезагрузке снова свёрнуты).
const settingsCollapsed = { floors: true, cats: true };

// Кнопка «Свернуть все / Развернуть все» — вне поиска и если есть категории.
function collapseAllRow() {
  if (itemSearch.trim()) return "";
  const cats = store.categories();
  if (!cats.length) return "";
  const allCollapsed = cats.every((c) => collapsedCats.has(c.id));
  return `<div style="text-align:right;margin:-4px 0 10px">
    <button class="btn secondary small" data-act="toggle-all-cats">${allCollapsed ? "Развернуть все" : "Свернуть все"}</button>
  </div>`;
}

function renderItems() {
  const view = $("#view-items");

  view.innerHTML =
    floorBar() +
    `<div class="search-row">
      <span class="search-ic">🔍</span>
      <input id="item-search" type="search" inputmode="search" autocomplete="off"
        placeholder="Поиск товара или категории" value="${esc(itemSearch)}" />
      <button class="icon-btn search-clear" id="search-clear" ${itemSearch ? "" : "hidden"} title="Очистить">✕</button>
    </div>
    <button class="btn block" data-act="add-item-global">＋ Товар</button>
    ${collapseAllRow()}
    <div id="items-list"></div>`;

  renderItemsList();

  const inp = $("#item-search");
  inp.addEventListener("input", (e) => {
    itemSearch = e.target.value;
    $("#search-clear").hidden = !itemSearch;
    renderItemsList(); // обновляем только список — поле ввода и фокус сохраняются
  });
  $("#search-clear").addEventListener("click", () => {
    itemSearch = "";
    inp.value = "";
    $("#search-clear").hidden = true;
    renderItemsList();
    inp.focus();
  });
}

// Список категорий и товаров с учётом строки поиска. Перерисовывается отдельно
// от поля ввода, чтобы при наборе не терялся фокус.
function renderItemsList() {
  const list = $("#items-list");
  if (!list) return;
  const cats = store.categories();

  if (cats.length === 0) {
    list.innerHTML = emptyStateInline(
      "🗂️",
      "Нет категорий",
      "Категории создаются на экране «Ещё» → «Категории».",
    );
    return;
  }

  const q = itemSearch.trim().toLowerCase();
  const opts = store.calcOpts();
  let shown = 0;

  const html = cats
    .map((c) => {
      const catMatch = !q || c.name.toLowerCase().includes(q);
      let its;
      if (q) {
        // Поиск: показываем совпадения, включая товары с нулевым остатком
        // (чтобы к ним можно было добавить приход).
        its = store.itemsOf(c.id);
        if (!catMatch) {
          its = its.filter((it) => it.name.toLowerCase().includes(q));
          if (its.length === 0) return ""; // категория не подходит и товаров нет
        }
      } else {
        // Без поиска: прячем товары с нулевым остатком и пустые категории.
        its = store.itemsInStockOf(c.id);
        if (its.length === 0) return "";
      }
      shown++;
      const total = its.reduce((sum, it) => sum + store.stockForItem(it.id), 0);
      // Сворачивать можно только вне поиска (в поиске всегда показываем совпадения).
      const canCollapse = !q;
      const collapsed = canCollapse && collapsedCats.has(c.id);
      const caret = canCollapse
        ? `<span class="cat-caret">${collapsed ? "▸" : "▾"}</span>`
        : "";
      const rightTxt = collapsed
        ? `${fmt(total)} · ${its.length} поз.`
        : `${fmt(total)}${q ? "" : " всего"}`;
      let inner = `<div class="cat-head" ${canCollapse ? `data-cat-toggle="${c.id}"` : ""}>
        <span class="grow" style="display:flex;align-items:center;min-width:0">
          ${caret}<span class="truncate">${esc(c.name)}</span>
        </span>
        <span class="cat-stock nowrap">${rightTxt}</span>
        <button class="icon-btn cat-edit" data-add-item="${c.id}" title="Добавить товар">＋</button>
      </div>`;

      if (!collapsed) {
        if (its.length === 0) {
          inner += `<div class="list-item muted">Нет товаров</div>`;
        } else {
          inner += its
            .map((it) => {
              const s = itemSummary(store.movementsForItem(it.id), it, opts);
              return `<div class="list-item" data-item="${it.id}">
              <span class="dot ${s.urgency}"></span>
              <div class="grow">
                <div class="name">${esc(it.name)}</div>
                <div class="sub">мин. ${fmt(it.minStock)} ${esc(un(it.unit))}</div>
              </div>
              <div class="nowrap" style="text-align:right">
                <div style="font-weight:800">${fmt(s.stock)}</div>
                <div class="sub">${esc(un(it.unit))}</div>
              </div>
              <span class="chev">›</span>
            </div>`;
            })
            .join("");
        }
      }
      return `<div class="card">${inner}</div>`;
    })
    .join("");

  list.innerHTML =
    shown === 0
      ? q
        ? emptyStateInline("🔍", "Ничего не найдено", `По запросу «${esc(itemSearch.trim())}» ничего нет.`)
        : emptyStateInline(
            "📦",
            "Нет товаров в наличии",
            "Показаны только товары с остатком. Пустые ищите через поиск.",
          )
      : html;
}

// ── Экран: Быстрый ввод ───────────────────────────────────────────────────

let entryDate = todayISO();

function renderEntry() {
  const view = $("#view-entry");
  const cats = store.categories();
  const items = store.allItems();

  if (items.length === 0) {
    view.innerHTML = emptyState(
      "➕",
      "Нечего вводить",
      "Сначала добавьте товары на вкладке «Товары».",
      `<button class="btn block" data-act="go-items">Перейти к товарам</button>`,
    );
    return;
  }

  let html =
    floorBar() +
    `
    <label class="field">
      <span class="lbl">Дата</span>
      <input type="date" id="entry-date" value="${entryDate}" max="${todayISO()}" />
    </label>
    <p class="hint">Приход/расход записываются на выбранный этаж. Нажмите «Приход» или «Расход» у нужного товара.</p>`;

  html += cats
    .map((c) => {
      const its = store.itemsOf(c.id);
      if (its.length === 0) return "";
      let inner = `<div class="cat-head"><span>${esc(c.name)}</span></div>`;
      inner += its
        .map((it) => {
          const stock = store.stockForItem(it.id);
          return `<div class="card-pad" style="border-bottom:1px solid var(--border)">
            <div class="row between" style="margin-bottom:10px">
              <div class="grow truncate"><b>${esc(it.name)}</b></div>
              <div class="muted nowrap">${fmt(stock)} ${esc(un(it.unit))}</div>
            </div>
            <div class="stepper">
              <button class="step-btn out" data-mv="out" data-item="${it.id}">Расход<small>списать со склада</small></button>
              <button class="step-btn in" data-mv="in" data-item="${it.id}">Приход<small>добавить на склад</small></button>
            </div>
          </div>`;
        })
        .join("");
      return `<div class="card">${inner}</div>`;
    })
    .join("");

  view.innerHTML = html;

  $("#entry-date").addEventListener("change", (e) => {
    entryDate = e.target.value || todayISO();
  });
}

// ── Экран: Аналитика (Заказать / Отчёт за период) ─────────────────────────

let analyticsMode = "order"; // 'order' | 'report'
let reportFrom = addDays(todayISO(), -29);
let reportTo = todayISO();

function renderAnalytics() {
  const view = $("#view-analytics");
  const items = store.allItems();

  if (items.length === 0) {
    view.innerHTML = emptyState(
      "📊",
      "Нет данных",
      "Добавьте товары и внесите приход/расход — здесь появятся списки заказа и отчёты.",
      "",
    );
    return;
  }

  let html =
    floorBar() +
    `<div class="segmented">
      <button class="seg ${analyticsMode === "order" ? "on" : ""}" data-mode="order">Заказать</button>
      <button class="seg ${analyticsMode === "report" ? "on" : ""}" data-mode="report">Отчёт за период</button>
    </div>`;

  html += analyticsMode === "order" ? analyticsOrder() : analyticsReport();
  view.innerHTML = html;

  if (analyticsMode === "report") {
    $("#rep-from")?.addEventListener("change", (e) => {
      reportFrom = e.target.value || reportFrom;
      renderAnalytics();
    });
    $("#rep-to")?.addEventListener("change", (e) => {
      reportTo = e.target.value || reportTo;
      renderAnalytics();
    });
  }
}

// Список заказа: что и сколько заказать, по позициям (единицы разные — не суммируем).
function analyticsOrder() {
  const opts = store.calcOpts();
  const cats = store.categories();
  const st = store.getSettings();
  const modeTxt = st.workingDaysOnly ? "по рабочим дням" : "по всем дням";
  const rows = store
    .allItems()
    .map((it) => ({ it, s: itemSummary(store.movementsForItem(it.id), it, opts) }));

  const toOrder = rows
    .filter((r) => r.s.order > 0)
    .sort(
      (a, b) =>
        urgencyOrder(a.s.urgency) - urgencyOrder(b.s.urgency) || b.s.order - a.s.order,
    );

  let html = "";
  if (toOrder.length === 0) {
    html += `<div class="card card-pad" style="text-align:center">
      <div class="big-emoji" style="font-size:36px">✅</div>
      <div style="font-weight:700;margin-top:6px">Заказывать нечего</div>
      <div class="muted">Запасов достаточно.</div>
    </div>`;
  } else {
    html += `<div class="card card-pad row between">
      <div><div class="muted">Заказать на след. месяц</div>
      <div class="big-num" style="color:var(--accent);margin-top:2px">${toOrder.length} <span style="font-size:16px">поз.</span></div></div>
      <div style="font-size:40px">🧾</div>
    </div>`;
    html += `<div class="card">` + toOrder.map((r) => orderRow(r.it, r.s)).join("") + `</div>`;
    html += `<p class="hint">Сколько заказать = месячный расход + неснижаемый остаток − текущий остаток. Показываем списком по позициям, а не одной суммой — единицы у товаров разные.</p>`;
  }

  // Средние по категориям.
  html += `<h2 class="section-title">Средние по категориям</h2>`;
  html += `<p class="hint" style="margin-top:0">Считаются за последние ${st.windowDays} дн. (${modeTxt}), по текущему этажу.</p>`;
  html += cats
    .map((c) => {
      const its = store.itemsOf(c.id);
      if (its.length === 0) return "";
      const catRows = rows.filter((r) => r.it.categoryId === c.id);
      const catWeek = catRows.reduce((s, r) => s + r.s.weeklyAvg, 0);
      const catMonth = catRows.reduce((s, r) => s + r.s.monthlyAvg, 0);
      const catStock = catRows.reduce((s, r) => s + r.s.stock, 0);
      let inner = `<div class="cat-head">
        <span>${esc(c.name)}</span>
        <span class="cat-stock">ост. ${fmt(catStock)}</span>
      </div>
      <div class="card-pad">
        <div class="metric-grid">
          <div class="metric"><div class="label">Расход / неделя</div><div class="value">${fmt(catWeek)}</div></div>
          <div class="metric"><div class="label">Расход / месяц</div><div class="value">${fmt(catMonth)}</div></div>
        </div>
      </div>`;
      inner += catRows
        .map(({ it, s }) => {
          const daysTxt = s.daysLeft === Infinity ? "—" : `${fmt(s.daysLeft)} дн.`;
          return `<div class="card-pad" style="border-top:1px solid var(--border);cursor:pointer" data-item="${it.id}">
            <div class="row between">
              <div class="grow truncate"><b>${esc(it.name)}</b> <span class="badge ${s.urgency}">${URGENCY_LABEL[s.urgency]}</span></div>
              <span class="chev">›</span>
            </div>
            <div class="row" style="gap:16px;margin-top:8px;flex-wrap:wrap">
              <span class="muted">Остаток: <b style="color:var(--text)">${fmt(s.stock)} ${esc(un(it.unit))}</b></span>
              <span class="muted">В день: <b style="color:var(--text)">${fmt(s.dailyAvg)}</b></span>
              <span class="muted">Хватит: <b style="color:var(--text)">${daysTxt}</b></span>
            </div>
            <div class="row" style="gap:16px;margin-top:4px;flex-wrap:wrap">
              <span class="muted">Неделя: <b style="color:var(--text)">${fmt(s.weeklyAvg)}</b></span>
              <span class="muted">Месяц: <b style="color:var(--text)">${fmt(s.monthlyAvg)}</b></span>
              <span class="muted">Заказать: <b style="color:var(--accent)">＋${fmt(s.order)} ${esc(un(it.unit))}</b></span>
            </div>
          </div>`;
        })
        .join("");
      return `<div class="card">${inner}</div>`;
    })
    .join("");

  return html;
}

// Отчёт за период: приход и расход по каждому товару и категории за диапазон дат.
function analyticsReport() {
  const cats = store.categories();
  const from = reportFrom;
  const to = reportTo;
  const inStr = (n) => (n ? "＋" + fmt(n) : "0");
  const outStr = (n) => (n ? "−" + fmt(n) : "0");

  let html = `<div class="card card-pad">
    <div class="row" style="gap:12px">
      <label class="field grow" style="margin:0"><span class="lbl">С</span>
        <input type="date" id="rep-from" value="${from}" max="${todayISO()}" /></label>
      <label class="field grow" style="margin:0"><span class="lbl">По</span>
        <input type="date" id="rep-to" value="${to}" max="${todayISO()}" /></label>
    </div>
    <div class="row" style="gap:8px;margin-top:10px">
      ${[[7, "7 дней"], [30, "30 дней"], [90, "90 дней"]]
        .map(([n, l]) => `<button class="btn secondary small grow" data-range="${n}">${l}</button>`)
        .join("")}
    </div>
  </div>`;

  let gIn = 0;
  let gOut = 0;
  const blocks = cats
    .map((c) => {
      const its = store.itemsOf(c.id);
      let cin = 0;
      let cout = 0;
      const lines = [];
      for (const it of its) {
        const mv = store.movementsForItem(it.id);
        const inSum = sumReceipts(mv, from, to);
        const outSum = sumConsumption(mv, from, to);
        if (inSum === 0 && outSum === 0) continue;
        cin += inSum;
        cout += outSum;
        lines.push(`<div class="mv-line" data-item="${it.id}" style="cursor:pointer">
          <div class="grow truncate">${esc(it.name)} <span class="muted">${esc(un(it.unit))}</span></div>
          <span class="mv-qty in">${inStr(inSum)}</span>
          <span class="mv-qty out">${outStr(outSum)}</span>
          <span class="chev">›</span>
        </div>`);
      }
      if (!lines.length) return "";
      gIn += cin;
      gOut += cout;
      return `<div class="card">
        <div class="cat-head"><span>${esc(c.name)}</span>
          <span class="cat-stock"><span style="color:var(--in)">${inStr(cin)}</span> · <span style="color:var(--out)">${outStr(cout)}</span></span>
        </div>
        <div class="card-pad">${lines.join("")}</div>
      </div>`;
    })
    .join("");

  html += `<div class="card card-pad">
    <div class="row between">
      <div><div class="muted">Приход за период</div><div class="big-num" style="color:var(--in)">${inStr(gIn)}</div></div>
      <div style="text-align:right"><div class="muted">Расход за период</div><div class="big-num" style="color:var(--out)">${outStr(gOut)}</div></div>
    </div>
    <div class="hint">${fmtDate(from)} — ${fmtDate(to)} · этаж «${esc(store.getActiveFloor()?.name || "")}». Переносы между этажами не учитываются.</div>
  </div>`;
  html += blocks || `<div class="empty">За выбранный период движений нет.</div>`;
  return html;
}

// ── Экран: Настройки ──────────────────────────────────────────────────────

function renderSettings() {
  const view = $("#view-settings");
  const st = store.getSettings();
  const order = [1, 2, 3, 4, 5, 6, 0]; // Пн..Вс

  const fl = store.floors();
  const cats = store.categories();
  const secHead = (key, title, count) =>
    `<h2 class="section-title collapser" data-settings-toggle="${key}" style="cursor:pointer">
      <span class="cat-caret">${settingsCollapsed[key] ? "▸" : "▾"}</span>${title}
      <span class="muted" style="font-weight:400"> · ${count}</span>
    </h2>`;
  view.innerHTML = `
    ${secHead("floors", "Этажи", fl.length)}
    ${
      settingsCollapsed.floors
        ? ""
        : `<div class="card">
      ${fl
        .map(
          (f) => `<div class="list-item">
        <div class="grow"><div class="name">${esc(f.name)}</div></div>
        <button class="icon-btn" data-floor-edit="${f.id}" title="Переименовать" style="width:40px;height:40px;font-size:16px">✎</button>
        ${fl.length > 1 ? `<button class="icon-btn" data-floor-del="${f.id}" title="Удалить" style="width:40px;height:40px;font-size:16px">🗑️</button>` : ""}
      </div>`,
        )
        .join("")}
      <div class="card-pad"><button class="btn secondary small" data-act="add-floor">＋ Этаж</button></div>
    </div>
    <p class="hint">У каждого этажа свой остаток; категории и товары общие. Переключение — на экранах «Обзор», «Ввод», «Товары», «Аналитика».</p>`
    }

    ${secHead("cats", "Категории", cats.length)}
    ${
      settingsCollapsed.cats
        ? ""
        : `<div class="card">
      ${
        cats.length
          ? cats
              .map(
                (c) => `<div class="list-item">
        <div class="grow"><div class="name">${esc(c.name)}</div></div>
        <button class="icon-btn" data-edit-cat="${c.id}" title="Переименовать или удалить" style="width:40px;height:40px;font-size:16px">✎</button>
      </div>`,
              )
              .join("")
          : `<div class="list-item muted">Пока нет категорий</div>`
      }
      <div class="card-pad"><button class="btn secondary small" data-act="add-cat">＋ Категория</button></div>
    </div>
    <p class="hint">Категории общие для всех этажей. Товары добавляются на экране «Товары».</p>`
    }

    <h2 class="section-title">Рабочие дни</h2>`;
  view.innerHTML += `
    <div class="card card-pad">
      <p class="hint" style="margin-top:0">Средний расход можно считать только по рабочим дням.</p>
      <div class="weekday-row" id="weekday-row">
        ${order
          .map(
            (d) =>
              `<button class="wd ${st.workingDays.includes(d) ? "on" : ""}" data-wd="${d}">${WD_SHORT[d]}</button>`,
          )
          .join("")}
      </div>
      <div class="switch-row">
        <span>Считать только по рабочим дням</span>
        <input type="checkbox" id="wd-only" ${st.workingDaysOnly ? "checked" : ""} style="width:auto;min-height:auto" />
      </div>
      <label class="field" style="margin-bottom:0">
        <span class="lbl">Окно усреднения расхода</span>
        <select id="window-days">
          ${[7, 14, 30, 60, 90]
            .map(
              (n) =>
                `<option value="${n}" ${st.windowDays === n ? "selected" : ""}>${n} дней</option>`,
            )
            .join("")}
        </select>
      </label>
    </div>

    <h2 class="section-title">Синхронизация между устройствами</h2>
    <div class="card card-pad">
      <p class="hint" style="margin-top:0">Общие данные для телефона и ноутбука. Введите один и тот же адрес сервера и токен на всех устройствах.</p>
      <label class="field">
        <span class="lbl">Адрес сервера</span>
        <input id="sync-url" type="url" inputmode="url" autocomplete="off" placeholder="${DEFAULT_SYNC_URL}" value="${esc(sync.getConfig().url || "")}" />
      </label>
      <label class="field">
        <span class="lbl">Токен доступа</span>
        <input id="sync-token" type="password" autocomplete="off" placeholder="секретный токен" value="${esc(sync.getConfig().token || "")}" />
      </label>
      <button class="btn block" data-act="sync-save">Сохранить и проверить</button>
      <div class="spacer"></div>
      <button class="btn secondary block" data-act="sync-now">🔄 Синхронизировать сейчас</button>
      <div id="sync-status" style="margin-top:10px">${syncStatusHtml()}</div>
      <div class="divider"></div>
      <p class="hint" style="margin-top:0">Второе устройство (чтобы забрать данные с сервера, стерев локальные):</p>
      <button class="btn secondary block" data-act="sync-pull">⬇️ Заменить локальные данными с сервера</button>
    </div>

    <h2 class="section-title">Данные</h2>
    <div class="card card-pad">
      <p class="hint" style="margin-top:0">Данные хранятся в этом браузере на устройстве. Делайте резервную копию и переносите на другой телефон через файл.</p>
      <button class="btn block" data-act="export">⬇️ Сохранить копию (файл)</button>
      <div class="spacer"></div>
      <button class="btn secondary block" data-act="import">⬆️ Загрузить из файла</button>
      <div class="divider"></div>
      <button class="btn secondary block" data-act="import-xlsx">📊 Импорт из Excel (.xlsx)</button>
      <p class="hint" style="margin-bottom:0">Загрузите вашу Excel-таблицу — приложение само разберёт категории, товары, остатки и расход. Текущие данные будут заменены.</p>
      <div class="divider"></div>
      <button class="btn secondary block" data-act="seed">Загрузить демо-данные</button>
      <div class="spacer"></div>
      <button class="btn danger block" data-act="wipe">Удалить все данные</button>
    </div>

    <p class="hint" style="text-align:center;margin-top:20px">Склад · офлайн-приложение · v1</p>
  `;
}

// ── Формы (нижний лист) ────────────────────────────────────────────────────

function sheetAddCategory() {
  openSheet(`
    <h3>Новая категория</h3>
    <label class="field">
      <span class="lbl">Название</span>
      <input id="f-name" placeholder="Напр. Молочные продукты" autofocus />
    </label>
    <button class="btn block" data-save="cat">Добавить</button>
  `);
  focusFirst();
  $('[data-save="cat"]').addEventListener("click", () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Введите название");
    store.addCategory(name);
    closeSheet();
    render();
    toast("Категория добавлена");
  });
}

function sheetEditCategory(id) {
  const c = store.getCategory(id);
  if (!c) return;
  openSheet(`
    <h3>Категория</h3>
    <label class="field">
      <span class="lbl">Название</span>
      <input id="f-name" value="${esc(c.name)}" />
    </label>
    <button class="btn block" data-save="rename">Сохранить</button>
    <div class="spacer"></div>
    <button class="btn danger block" data-del="cat">Удалить категорию и её товары</button>
  `);
  focusFirst();
  $('[data-save="rename"]').addEventListener("click", () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Введите название");
    store.renameCategory(id, name);
    closeSheet();
    render();
  });
  $('[data-del="cat"]').addEventListener("click", () => {
    if (!confirm(`Удалить «${c.name}» со всеми товарами и историей?`)) return;
    store.deleteCategory(id);
    closeSheet();
    render();
    toast("Удалено");
  });
}

// Создание товара. categoryId задан — категория фиксирована (кнопка «+» у
// категории); иначе показываем выпадающий список категорий. Имя можно
// предзаполнить (из глобального пикера). После создания сразу открываем
// карточку — у нового товара остаток 0, и в списке он скрыт, а на карточке
// можно тут же внести приход.
function sheetCreateItem({ name = "", categoryId = null } = {}) {
  const cats = store.categories();
  if (cats.length === 0) {
    return toast("Сначала создайте категорию в «Ещё» → «Категории»");
  }
  const fixed = categoryId ? store.getCategory(categoryId) : null;
  openSheet(`
    <h3>Новый товар</h3>
    ${fixed ? `<div class="muted" style="margin-bottom:14px">в категории «${esc(fixed.name)}»</div>` : ""}
    <label class="field">
      <span class="lbl">Название</span>
      <input id="f-name" placeholder="Напр. Молоко" value="${esc(name)}" />
    </label>
    ${
      fixed
        ? ""
        : `<label class="field">
      <span class="lbl">Категория</span>
      <select id="f-cat">
        ${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
      </select>
    </label>`
    }
    <div class="row" style="gap:12px">
      <label class="field grow">
        <span class="lbl">Единица</span>
        <input id="f-unit" placeholder="шт / кг / л" value="шт" />
      </label>
      <label class="field grow">
        <span class="lbl">Мин. остаток</span>
        <input id="f-min" type="number" inputmode="decimal" placeholder="0" value="0" />
      </label>
    </div>
    <p class="hint">Мин. остаток — порог, ниже которого товар нужно заказывать.</p>
    <button class="btn block" data-save="item">Добавить</button>
  `);
  focusFirst();
  $('[data-save="item"]').addEventListener("click", () => {
    const nm = $("#f-name").value.trim();
    if (!nm) return toast("Введите название");
    const cid = fixed ? categoryId : $("#f-cat").value;
    const it = store.addItem(cid, {
      name: nm,
      unit: $("#f-unit").value.trim() || "шт",
      minStock: parseNum($("#f-min").value),
    });
    collapsedCats.delete(cid);
    saveCollapsed();
    closeSheet();
    render();
    sheetItemDetail(it.id); // сразу открываем карточку — внести приход
    toast("Товар добавлен — внесите приход");
  });
}

// Глобальное добавление товара: единый поиск — находит существующие товары
// (открыть карточку) или предлагает создать новый с введённым названием.
function sheetAddItemGlobal() {
  openSheet(
    `
    <h3>Добавить товар</h3>
    <label class="field">
      <span class="lbl">Название товара</span>
      <input id="f-pick" type="search" autocomplete="off" placeholder="Начните вводить название" />
    </label>
    <div id="pick-results"></div>
  `,
    { fixed: true },
  );
  focusFirst();
  const inp = $("#f-pick");
  const box = $("#pick-results");

  const renderResults = () => {
    const raw = inp.value.trim();
    const q = raw.toLowerCase();
    const matches = q
      ? store.allItems().filter((it) => it.name.toLowerCase().includes(q))
      : [];
    let html = "";
    if (matches.length) {
      html +=
        `<h2 class="section-title">Уже есть</h2><div class="card">` +
        matches
          .slice(0, 20)
          .map((it) => {
            const cat = store.getCategory(it.categoryId);
            return `<div class="list-item" data-open-item="${it.id}">
              <div class="grow">
                <div class="name">${esc(it.name)}</div>
                <div class="sub">${esc(cat?.name || "")} · остаток ${fmt(store.stockForItem(it.id))} ${esc(un(it.unit))}</div>
              </div>
              <span class="chev">›</span>
            </div>`;
          })
          .join("") +
        `</div>`;
    }
    if (raw) {
      html += `<button class="btn block" data-create-item style="margin-top:12px">＋ Создать «${esc(raw)}»</button>`;
    } else {
      html += `<p class="hint">Найдите существующий товар, чтобы открыть его, либо введите новое название для создания.</p>`;
    }
    box.innerHTML = html;
  };
  renderResults();
  inp.addEventListener("input", renderResults);
  box.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-item]");
    if (open) {
      closeSheet();
      sheetItemDetail(open.dataset.openItem);
      return;
    }
    if (e.target.closest("[data-create-item]")) {
      sheetCreateItem({ name: inp.value.trim() });
    }
  });
}

// Строка движения в карточке: дата + 2 колонки (приход | расход) + действия.
function mvRow2(m) {
  const note = m.transfer ? "перенос" : m.adjust ? "инвентаризация" : m.note ? esc(m.note) : "";
  return `<div class="mv-row2">
    <span class="mv-col-date">${fmtDate(m.date)}${note ? `<span class="muted"> · ${note}</span>` : ""}</span>
    <span class="mv-col-num mv-qty in">${m.type === "in" ? "＋" + fmt(m.qty) : ""}</span>
    <span class="mv-col-num mv-qty out">${m.type === "out" ? "−" + fmt(m.qty) : ""}</span>
    <span class="mv-col-act">
      ${m.transfer ? "" : `<button class="icon-btn" data-edit-mv="${m.id}" title="Изменить">✎</button>`}
      <button class="icon-btn" data-del-mv="${m.id}" title="Удалить">🗑️</button>
    </span>
  </div>`;
}

function sheetItemDetail(id) {
  const it = store.getItem(id);
  if (!it) return;
  const opts = store.calcOpts();
  const movements = store.movementsForItem(id);
  const s = itemSummary(movements, it, opts);
  const cat = store.getCategory(it.categoryId);
  const floor = store.getActiveFloor();

  const daysTxt = s.daysLeft === Infinity ? "нет расхода" : `${fmt(s.daysLeft)} дн.`;

  // История движений по этажам: 2 колонки (приход | расход) по датам, свежие
  // сверху. У каждого движения — правка/удаление (кроме переносов).
  const PER_FLOOR = 60;
  const floorsWithMv = store
    .floors()
    .map((f) => ({ f, mv: store.movementsForItem(id, f.id) }))
    .filter((x) => x.mv.length);
  const historyHtml = floorsWithMv.length
    ? floorsWithMv
        .map(({ f, mv }) => {
          const rows = [...mv]
            .reverse()
            .slice(0, PER_FLOOR)
            .map((m) => mvRow2(m))
            .join("");
          const more =
            mv.length > PER_FLOOR
              ? `<div class="card-pad muted">…и ещё ${mv.length - PER_FLOOR}</div>`
              : "";
          return `<div class="card">
            <div class="cat-head"><span>${esc(f.name)}</span><span class="cat-stock">ост. ${fmt(store.stockForItem(id, f.id))} ${esc(un(it.unit))}</span></div>
            <div class="mv-head">
              <span>Дата</span>
              <span class="mv-col-num" style="color:var(--in)">Приход</span>
              <span class="mv-col-num" style="color:var(--out)">Расход</span>
              <span class="mv-col-act"></span>
            </div>
            ${rows}${more}
          </div>`;
        })
        .join("")
    : `<div class="muted">Движений пока нет.</div>`;

  openSheet(`
    <h3>${esc(it.name)}</h3>
    <div class="row between" style="margin-bottom:14px">
      <span class="muted">${esc(cat?.name || "")} · ${esc(un(it.unit))}</span>
      <span class="badge ${s.urgency}">${URGENCY_LABEL[s.urgency]}</span>
    </div>

    <div class="card-pad" style="background:var(--surface-2);border-radius:var(--radius-sm);text-align:center;margin-bottom:14px">
      <div class="muted">Остаток · этаж «${esc(floor?.name || "")}»</div>
      <div class="big-num" style="margin-top:6px">${fmt(s.stock)} <span style="font-size:18px">${esc(un(it.unit))}</span></div>
    </div>

    <div class="metric-grid" style="margin-bottom:14px">
      <div class="metric"><div class="label">Расход / день</div><div class="value">${fmt(s.dailyAvg)}</div></div>
      <div class="metric"><div class="label">Хватит на</div><div class="value">${daysTxt}</div></div>
      <div class="metric"><div class="label">Расход / неделя</div><div class="value">${fmt(s.weeklyAvg)}</div></div>
      <div class="metric"><div class="label">Расход / месяц</div><div class="value">${fmt(s.monthlyAvg)}</div></div>
    </div>

    <div class="card-pad" style="background:var(--surface-2);border-radius:var(--radius-sm);margin-bottom:14px">
      <div class="row between" data-act="edit-min" data-item="${id}" style="cursor:pointer">
        <span>Мин. остаток ✎</span><b>${fmt(it.minStock)} ${esc(un(it.unit))}</b>
      </div>
      <div class="row between" style="margin-top:8px">
        <span>Заказать на месяц</span><b style="color:var(--accent)">＋${fmt(s.order)} ${esc(un(it.unit))}</b>
      </div>
    </div>

    <div class="stepper" style="margin-bottom:12px">
      <button class="step-btn out" data-mv="out" data-item="${id}">Расход</button>
      <button class="step-btn in" data-mv="in" data-item="${id}">Приход</button>
    </div>
    <button class="btn secondary block" data-act="inventory" data-item="${id}">📋 Инвентаризация (задать остаток)</button>
    <div class="spacer"></div>
    <button class="btn secondary block" data-act="transfer" data-item="${id}">🔀 Перенести на другой этаж</button>

    <h2 class="section-title">Движения по этажам</h2>
    ${historyHtml}

    <div class="divider"></div>
    <button class="btn secondary block" data-act="edit-item" data-item="${id}">Изменить товар</button>
    <div class="spacer"></div>
    <button class="btn danger block" data-del-item="${id}">Удалить товар</button>
  `);

  $('[data-del-item]')?.addEventListener("click", () => {
    if (!confirm(`Удалить «${it.name}» и всю его историю?`)) return;
    store.deleteItem(id);
    closeSheet();
    render();
    toast("Удалено");
  });
  $$('[data-del-mv]').forEach((b) =>
    b.addEventListener("click", () => {
      store.deleteMovement(b.dataset.delMv);
      sheetItemDetail(id); // перерисовать лист
      render();
    }),
  );
  $$('[data-edit-mv]').forEach((b) =>
    b.addEventListener("click", () => sheetEditMovement(b.dataset.editMv, id)),
  );
}

function sheetMovement(itemId, type) {
  const it = store.getItem(itemId);
  if (!it) return;
  const isIn = type === "in";
  const presets = [1, 5, 10, 50];
  openSheet(`
    <h3>${isIn ? "Приход" : "Расход"}: ${esc(it.name)}</h3>
    <div class="muted" style="margin-bottom:14px">Остаток сейчас: ${fmt(store.stockForItem(itemId))} ${esc(un(it.unit))}</div>
    <label class="field">
      <span class="lbl">Количество (${esc(un(it.unit))})</span>
      <input id="f-qty" type="number" inputmode="decimal" step="any" min="0" placeholder="0" />
    </label>
    <div class="row" style="gap:8px;margin-bottom:14px">
      ${presets.map((p) => `<button class="btn secondary small grow" data-preset="${p}">+${p}</button>`).join("")}
    </div>
    <label class="field">
      <span class="lbl">Дата</span>
      <input id="f-date" type="date" value="${entryDate}" max="${todayISO()}" />
    </label>
    <button class="btn block" data-save="mv" style="background:${isIn ? "var(--ok)" : "var(--crit)"}">
      ${isIn ? "＋ Добавить приход" : "− Списать расход"}
    </button>
  `);
  focusFirst();
  const qtyEl = $("#f-qty");
  $$('[data-preset]').forEach((b) =>
    b.addEventListener("click", () => {
      const cur = parseNum(qtyEl.value);
      qtyEl.value = String(cur + Number(b.dataset.preset));
    }),
  );
  $('[data-save="mv"]').addEventListener("click", () => {
    const qty = parseNum(qtyEl.value);
    if (qty <= 0) return toast("Введите количество");
    // Нельзя списать больше, чем есть — остаток не должен уходить в минус.
    if (!isIn) {
      const stock = store.stockForItem(itemId);
      if (qty > stock) {
        return toast(`Нельзя списать больше остатка: ${fmt(stock)} ${un(it.unit)}`);
      }
    }
    store.addMovement(itemId, {
      type,
      qty,
      date: $("#f-date").value || todayISO(),
    });
    closeSheet();
    render();
    toast(isIn ? "Приход записан" : "Расход записан");
  });
}

// Редактирование существующего прихода/расхода: количество и дата.
function sheetEditMovement(movementId, itemId) {
  const it = store.getItem(itemId);
  const m = store.movementsForItem(itemId).find((x) => x.id === movementId);
  if (!it || !m || m.transfer) return;
  const isIn = m.type === "in";
  const kind = m.adjust ? "инвентаризация" : isIn ? "приход" : "расход";
  openSheet(`
    <h3>Изменить движение: ${esc(it.name)}</h3>
    <div class="muted" style="margin-bottom:14px">Тип: ${kind}. Остаток сейчас: ${fmt(store.stockForItem(itemId, m.floorId))} ${esc(un(it.unit))}</div>
    <label class="field">
      <span class="lbl">Количество (${esc(un(it.unit))})</span>
      <input id="f-qty" type="number" inputmode="decimal" step="any" min="0" value="${m.qty}" />
    </label>
    <label class="field">
      <span class="lbl">Дата</span>
      <input id="f-date" type="date" value="${m.date}" max="${todayISO()}" />
    </label>
    <button class="btn block" data-save="edit-mv" style="background:${isIn ? "var(--ok)" : "var(--crit)"}">Сохранить</button>
  `);
  focusFirst();
  $('[data-save="edit-mv"]').addEventListener("click", () => {
    const qty = parseNum($("#f-qty").value);
    if (qty <= 0) return toast("Введите количество");
    // Для расхода/инвентаризации-в-минус: не дать остатку уйти в минус.
    // Остаток без текущего движения = текущий остаток минус его вклад.
    if (!isIn) {
      const stockWithout = store.stockForItem(itemId, m.floorId) + m.qty;
      if (qty > stockWithout) {
        return toast(`Нельзя списать больше остатка: ${fmt(stockWithout)} ${un(it.unit)}`);
      }
    }
    store.updateMovement(movementId, { qty, date: $("#f-date").value || m.date });
    sheetItemDetail(itemId);
    render();
    toast("Движение изменено");
  });
}

function sheetInventory(itemId) {
  const it = store.getItem(itemId);
  if (!it) return;
  const cur = store.stockForItem(itemId);
  openSheet(`
    <h3>Инвентаризация: ${esc(it.name)}</h3>
    <div class="muted" style="margin-bottom:14px">Расчётный остаток: ${fmt(cur)} ${esc(un(it.unit))}. Введите фактический — разница запишется в историю.</div>
    <label class="field">
      <span class="lbl">Фактический остаток (${esc(un(it.unit))})</span>
      <input id="f-qty" type="number" inputmode="decimal" step="any" value="${cur}" />
    </label>
    <label class="field">
      <span class="lbl">Дата</span>
      <input id="f-date" type="date" value="${todayISO()}" max="${todayISO()}" />
    </label>
    <button class="btn block" data-save="inv">Сохранить остаток</button>
  `);
  focusFirst();
  $('[data-save="inv"]').addEventListener("click", () => {
    const val = parseNum($("#f-qty").value);
    if (val < 0) return toast("Остаток не может быть отрицательным");
    store.setStock(itemId, val, $("#f-date").value || todayISO());
    closeSheet();
    render();
    toast("Остаток обновлён");
  });
}

function sheetTransfer(itemId) {
  const it = store.getItem(itemId);
  if (!it) return;
  const fromId = store.getActiveFloorId();
  const from = store.getFloor(fromId);
  const others = store.floors().filter((f) => f.id !== fromId);
  if (!others.length) {
    openSheet(`
      <h3>Перенести: ${esc(it.name)}</h3>
      <div class="empty" style="padding:16px 0">
        <div class="big-emoji">🏢</div>
        <div style="font-weight:700;color:var(--text)">Пока только один этаж</div>
        <div style="margin-top:6px">Чтобы переносить товары между этажами, сначала добавьте второй этаж.</div>
      </div>
      <button class="btn block" data-act="add-floor">＋ Добавить этаж</button>
    `);
    return;
  }
  const cur = store.stockForItem(itemId, fromId);
  openSheet(`
    <h3>Перенести: ${esc(it.name)}</h3>
    <div class="muted" style="margin-bottom:14px">С этажа «${esc(from?.name || "")}» · сейчас ${fmt(cur)} ${esc(un(it.unit))}</div>
    <label class="field">
      <span class="lbl">Куда</span>
      <select id="f-to">
        ${others.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}
      </select>
    </label>
    <label class="field">
      <span class="lbl">Сколько перенести (${esc(un(it.unit))})</span>
      <input id="f-qty" type="number" inputmode="decimal" step="any" min="0" placeholder="0" />
    </label>
    <div class="row" style="gap:8px;margin-bottom:14px">
      ${[1, 5, 10].map((p) => `<button class="btn secondary small grow" data-preset="${p}">+${p}</button>`).join("")}
      <button class="btn secondary small grow" data-preset-all>Все ${fmt(cur)}</button>
    </div>
    <button class="btn block" data-save="transfer">🔀 Перенести</button>
  `);
  focusFirst();
  const qtyEl = $("#f-qty");
  $$("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      qtyEl.value = String(parseNum(qtyEl.value) + Number(b.dataset.preset));
    }),
  );
  $("[data-preset-all]")?.addEventListener("click", () => {
    qtyEl.value = String(cur);
  });
  $('[data-save="transfer"]').addEventListener("click", () => {
    const qty = parseNum(qtyEl.value);
    if (qty <= 0) return toast("Введите количество");
    // Нельзя перенести больше, чем есть на исходном этаже.
    const avail = store.stockForItem(itemId, fromId);
    if (qty > avail) {
      return toast(`Нельзя перенести больше остатка: ${fmt(avail)} ${un(it.unit)}`);
    }
    const toId = $("#f-to").value;
    const toName = store.getFloor(toId)?.name || "";
    store.transferStock(itemId, fromId, toId, qty, todayISO());
    closeSheet();
    render();
    toast(`Перенесено на «${toName}»`);
  });
}

function sheetAddFloor() {
  openSheet(`
    <h3>Новый этаж</h3>
    <label class="field">
      <span class="lbl">Название</span>
      <input id="f-name" placeholder="Напр. Этаж 3" />
    </label>
    <button class="btn block" data-save="floor">Добавить</button>
  `);
  focusFirst();
  $('[data-save="floor"]').addEventListener("click", () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Введите название");
    store.addFloor(name); // активный этаж не меняем — переключиться можно чипом
    closeSheet();
    render();
    toast("Этаж добавлен");
  });
}

function sheetRenameFloor(id) {
  const f = store.getFloor(id);
  if (!f) return;
  openSheet(`
    <h3>Этаж</h3>
    <label class="field">
      <span class="lbl">Название</span>
      <input id="f-name" value="${esc(f.name)}" />
    </label>
    <button class="btn block" data-save="floor-rename">Сохранить</button>
  `);
  focusFirst();
  $('[data-save="floor-rename"]').addEventListener("click", () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Введите название");
    store.renameFloor(id, name);
    closeSheet();
    render();
  });
}

// Быстрое редактирование минимального остатка прямо из карточки товара.
function sheetEditMin(id) {
  const it = store.getItem(id);
  if (!it) return;
  openSheet(`
    <h3>Мин. остаток: ${esc(it.name)}</h3>
    <p class="hint" style="margin-top:0">Порог, ниже которого товар нужно заказывать. Влияет на метку срочности и рекомендацию заказа.</p>
    <label class="field">
      <span class="lbl">Минимальный остаток (${esc(un(it.unit))})</span>
      <input id="f-min" type="number" inputmode="decimal" step="any" min="0" value="${it.minStock}" />
    </label>
    <button class="btn block" data-save="min">Сохранить</button>
  `);
  focusFirst();
  $('[data-save="min"]').addEventListener("click", () => {
    const v = parseNum($("#f-min").value);
    if (v < 0) return toast("Не может быть отрицательным");
    store.updateItem(id, { minStock: v });
    closeSheet();
    sheetItemDetail(id);
    render();
    toast("Мин. остаток обновлён");
  });
}

function sheetEditItem(id) {
  const it = store.getItem(id);
  if (!it) return;
  const cats = store.categories();
  openSheet(`
    <h3>Изменить товар</h3>
    <label class="field">
      <span class="lbl">Название</span>
      <input id="f-name" value="${esc(it.name)}" />
    </label>
    <label class="field">
      <span class="lbl">Категория</span>
      <select id="f-cat">
        ${cats.map((c) => `<option value="${c.id}" ${c.id === it.categoryId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
    </label>
    <div class="row" style="gap:12px">
      <label class="field grow">
        <span class="lbl">Единица</span>
        <input id="f-unit" value="${esc(un(it.unit))}" />
      </label>
      <label class="field grow">
        <span class="lbl">Мин. остаток</span>
        <input id="f-min" type="number" inputmode="decimal" value="${it.minStock}" />
      </label>
    </div>
    <button class="btn block" data-save="edit">Сохранить</button>
  `);
  focusFirst();
  $('[data-save="edit"]').addEventListener("click", () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Введите название");
    store.updateItem(id, {
      name,
      categoryId: $("#f-cat").value,
      unit: $("#f-unit").value.trim() || "шт",
      minStock: parseNum($("#f-min").value),
    });
    closeSheet();
    render();
    toast("Сохранено");
  });
}

// ── Служебное ──────────────────────────────────────────────────────────────

function parseNum(v) {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function focusFirst() {
  setTimeout(() => {
    const el = $("#sheet-content input, #sheet-content select");
    if (el) el.focus();
  }, 60);
}

function emptyState(emoji, title, text, actions) {
  return `<div class="card card-pad">
    <div class="empty">
      <div class="big-emoji">${emoji}</div>
      <div style="font-weight:700;font-size:19px;color:var(--text)">${title}</div>
      <div style="margin-top:6px">${text}</div>
    </div>
    ${actions || ""}
  </div>`;
}
function emptyStateInline(emoji, title, text) {
  return `<div class="empty"><div class="big-emoji">${emoji}</div>
    <div style="font-weight:700;font-size:18px;color:var(--text)">${title}</div>
    <div style="margin-top:6px">${text}</div></div>`;
}

// ── Данные: экспорт / импорт ────────────────────────────────────────────────

function exportData() {
  const blob = new Blob([store.exportJSON()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sklad-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Копия сохранена");
}

async function saveSyncConfig() {
  const url = ($("#sync-url").value.trim() || DEFAULT_SYNC_URL);
  const token = $("#sync-token").value.trim();
  if (!token) return toast("Введите токен");
  sync.setConfig({ url, token });
  toast("Проверяю подключение…");
  const r = await sync.testConnection(url, token);
  updateSyncStatus();
  if (!r.ok) return alert("Не удалось подключиться: " + r.error);
  const res = await sync.syncNow();
  updateSyncStatus();
  if (res.changed) render();
  toast(res.ok ? "Подключено и синхронизировано" : "Ошибка синхронизации");
}

async function runSyncNow() {
  if (!sync.isConfigured()) return toast("Сначала задайте адрес и токен");
  toast("Синхронизирую…");
  const r = await sync.syncNow();
  updateSyncStatus();
  if (r.changed) render();
  toast(r.ok ? "Синхронизировано" : "Ошибка: " + (r.error || ""));
}

async function runPullReplace() {
  if (!sync.isConfigured()) return toast("Сначала задайте адрес и токен");
  if (
    !confirm(
      "Заменить все данные на этом устройстве данными с сервера? Локальные изменения на этом устройстве будут потеряны.",
    )
  )
    return;
  const r = await sync.pullReplace();
  updateSyncStatus();
  render();
  toast(r.ok ? "Данные загружены с сервера" : "Ошибка: " + (r.error || ""));
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      store.importJSON(reader.result);
      render();
      toast("Данные загружены");
    } catch (e) {
      alert("Не удалось прочитать файл: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ── Глобальные обработчики (делегирование) ─────────────────────────────────

document.addEventListener("click", (e) => {
  const t = e.target;

  // Открыть карточку товара.
  const itemRow = t.closest("[data-item]");
  const mvBtn = t.closest("[data-mv]");
  if (mvBtn) {
    sheetMovement(mvBtn.dataset.item, mvBtn.dataset.mv);
    return;
  }

  // Переключение этажа по чипу.
  const floorChip = t.closest("[data-floor]");
  if (floorChip) {
    store.setActiveFloor(floorChip.dataset.floor);
    render();
    return;
  }
  // Клик по строке товара (не по кнопке и не по действию) → детали.
  if (itemRow && !t.closest("button") && !t.closest("[data-act]") && itemRow.dataset.item) {
    sheetItemDetail(itemRow.dataset.item);
    return;
  }

  const act = t.closest("[data-act]")?.dataset.act;
  if (act === "add-cat") return sheetAddCategory();
  if (act === "add-item-global") return sheetAddItemGlobal();
  if (act === "seed") {
    if (store.allItems().length && !confirm("Заменить текущие данные демо-набором?")) return;
    store.seedDemo();
    render();
    toast("Демо-данные загружены");
    return;
  }
  if (act === "toggle-all-cats") {
    const cats = store.categories();
    if (cats.every((c) => collapsedCats.has(c.id))) collapsedCats.clear();
    else cats.forEach((c) => collapsedCats.add(c.id));
    saveCollapsed();
    render();
    return;
  }
  if (act === "go-items") return switchTab("items");
  if (act === "sync-save") return saveSyncConfig();
  if (act === "sync-now") return runSyncNow();
  if (act === "sync-pull") return runPullReplace();
  if (act === "export") return exportData();
  if (act === "import") return $("#import-file").click();
  if (act === "import-xlsx") return $("#xlsx-file").click();
  if (act === "wipe") {
    if (!confirm("Удалить все данные без возможности восстановления?")) return;
    store.replaceState({});
    render();
    toast("Данные удалены");
    return;
  }
  if (act === "inventory") return sheetInventory(t.closest("[data-item]").dataset.item);
  if (act === "edit-item") return sheetEditItem(t.closest("[data-item]").dataset.item);
  if (act === "edit-min") return sheetEditMin(t.closest("[data-item]").dataset.item);
  if (act === "transfer") return sheetTransfer(t.closest("[data-item]").dataset.item);
  if (act === "add-floor") return sheetAddFloor();

  const addItemCat = t.closest("[data-add-item]")?.dataset.addItem;
  if (addItemCat) return sheetCreateItem({ categoryId: addItemCat });

  const editCat = t.closest("[data-edit-cat]")?.dataset.editCat;
  if (editCat) return sheetEditCategory(editCat);

  // Свернуть/развернуть категорию (клик по её шапке, но не по кнопке ✎).
  const catToggle = t.closest("[data-cat-toggle]")?.dataset.catToggle;
  if (catToggle) {
    if (collapsedCats.has(catToggle)) collapsedCats.delete(catToggle);
    else collapsedCats.add(catToggle);
    saveCollapsed();
    render();
    return;
  }

  const catJump = t.closest("[data-cat-jump]");
  if (catJump) return switchTab("items");
});

$("#view-settings").addEventListener("change", (e) => {
  if (e.target.id === "wd-only") {
    store.updateSettings({ workingDaysOnly: e.target.checked });
    render();
  }
  if (e.target.id === "window-days") {
    store.updateSettings({ windowDays: Number(e.target.value) });
    render();
  }
});
$("#view-settings").addEventListener("click", (e) => {
  const stg = e.target.closest("[data-settings-toggle]");
  if (stg) {
    const k = stg.dataset.settingsToggle;
    settingsCollapsed[k] = !settingsCollapsed[k];
    render();
    return;
  }
  const fe = e.target.closest("[data-floor-edit]");
  if (fe) return sheetRenameFloor(fe.dataset.floorEdit);
  const fd = e.target.closest("[data-floor-del]");
  if (fd) {
    const f = store.getFloor(fd.dataset.floorDel);
    if (f && confirm(`Удалить этаж «${f.name}» со всеми его остатками и движениями?`)) {
      store.deleteFloor(fd.dataset.floorDel);
      render();
      toast("Этаж удалён");
    }
    return;
  }
  const wd = e.target.closest("[data-wd]");
  if (wd) {
    const st = store.getSettings();
    const d = Number(wd.dataset.wd);
    let days = st.workingDays.includes(d)
      ? st.workingDays.filter((x) => x !== d)
      : [...st.workingDays, d];
    if (days.length === 0) return toast("Оставьте хотя бы один день");
    store.updateSettings({ workingDays: days });
    render();
  }
});
// Аналитика: переключение режима и быстрые диапазоны отчёта.
$("#view-analytics").addEventListener("click", (e) => {
  const seg = e.target.closest("[data-mode]");
  if (seg) {
    analyticsMode = seg.dataset.mode;
    renderAnalytics();
    return;
  }
  const rng = e.target.closest("[data-range]");
  if (rng) {
    const n = Number(rng.dataset.range);
    reportTo = todayISO();
    reportFrom = addDays(todayISO(), -(n - 1));
    renderAnalytics();
  }
});

$("#import-file").addEventListener("change", (e) => {
  if (e.target.files[0]) importData(e.target.files[0]);
  e.target.value = "";
});
$("#xlsx-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  toast("Читаю файл…");
  try {
    const buf = await file.arrayBuffer();
    const st = store.getSettings();
    const parsed = await parseWorkbook(buf, {
      today: todayISO(),
      workingDays: st.workingDays,
    });
    const nCat = parsed.categories.length;
    const nItem = parsed.items.length;
    const nFloor = (parsed.floors || []).length;
    if (!nItem) {
      alert("В файле не найдено товаров. Проверьте, что это таблица учёта склада.");
      return;
    }
    const floorTxt = nFloor > 1 ? `, этажей: ${nFloor}` : "";
    if (
      !confirm(
        `Найдено категорий: ${nCat}, товаров: ${nItem}${floorTxt}.\n\nИмпортировать? Текущие данные в приложении будут заменены.`,
      )
    )
      return;
    store.importFromParsed(parsed, todayISO());
    switchTab("items");
    toast(`Импортировано: ${nItem} товаров`);
  } catch (err) {
    alert("Не удалось разобрать файл: " + err.message);
  }
});

// ── Синхронизация: автозапуск и обновление статуса ─────────────────────────

const DEFAULT_SYNC_URL = "https://213-165-212-180.sslip.io";
let autoSyncTimer = null;

// Дебаунс автосинка после локальных правок.
function scheduleAutoSync() {
  if (!sync.isConfigured()) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    sync.syncNow().then((r) => {
      if (r && r.changed) render();
    });
  }, 1500);
}
store.onChange(scheduleAutoSync);

// Обновляем строку статуса синка, если открыт экран настроек.
sync.onStatus(() => {
  if (currentTab === "settings") updateSyncStatus();
});

function updateSyncStatus() {
  const el = $("#sync-status");
  if (!el) return;
  el.innerHTML = syncStatusHtml();
}

function syncStatusHtml() {
  if (!sync.isConfigured()) {
    return `<span class="muted">Синк выключен — задайте адрес и токен.</span>`;
  }
  const s = sync.getStatus();
  const pending = sync.pendingCount();
  const when = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString("ru-RU") : "—";
  let line = s.syncing
    ? `<span class="muted">Синхронизирую…</span>`
    : `<span class="muted">Последний синк: ${when} · не отправлено: ${pending}</span>`;
  if (s.lastError) {
    line += `<div class="badge critical" style="margin-top:6px">Ошибка: ${esc(s.lastError)}</div>`;
  }
  return line;
}

// Синк при запуске, возврате в приложение и появлении сети.
function syncIfConfigured() {
  if (sync.isConfigured()) {
    sync.syncNow().then((r) => {
      if (r && r.changed) render();
    });
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncIfConfigured();
});
window.addEventListener("online", syncIfConfigured);

// ── Старт ────────────────────────────────────────────────────────────────

switchTab("overview");
syncIfConfigured();

// Регистрация service worker (офлайн-режим). Не критично, если не поддержан.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
