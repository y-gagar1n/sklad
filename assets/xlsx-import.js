// xlsx-import.js — разбор Excel-файла учёта склада без сторонних библиотек.
//
// Читает .xlsx (это ZIP из XML), достаёт из каждого недельного/месячного листа
// надёжные колонки и превращает их в категории, товары и текущий остаток.
//
// Что берём (по заголовкам, не по буквам столбцов — раскладка на листах разная):
//   «Категория»            -> категория (у листов «Хоз-ка» её нет -> «Хозтовары»);
//   «наименование»         -> товар;
//   «ост итого» / «Остаток на конец мес-ца» -> текущий остаток;
//   «Итого расход за неделю» / «…за месяц»   -> расход за период (для среднего).
//
// Ежедневные «Приход/Расход» НЕ берём — в исходной таблице они заполнены
// непоследовательно (значения путаются между колонками). Поэтому по каждому
// товару берём остаток и расход из самого свежего листа, где они указаны.
// Это исключает двойной учёт при пересечении недельных и месячного листов.

// ── Распаковка ZIP (только нужные записи) ─────────────────────────────────

const U8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

// Возвращает Map(имя файла -> Uint8Array) для всех записей архива.
async function unzip(arrayBuffer) {
  const bytes = U8(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder("utf-8");

  // Ищем End Of Central Directory (сигнатура 0x06054b50) с конца.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Не похоже на .xlsx (нет ZIP-структуры)");

  const total = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // смещение центрального каталога
  const files = new Map();

  for (let n = 0; n < total; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Достаём и распаковываем содержимое по локальным заголовкам.
  const out = new Map();
  for (const [name, e] of files) {
    const lnameLen = view.getUint16(e.localOff + 26, true);
    const lextraLen = view.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + lnameLen + lextraLen;
    const raw = bytes.subarray(start, start + e.compSize);
    out.set(name, e.method === 0 ? raw : await inflateRaw(raw));
  }
  return out;
}

// ── Разбор XML (лёгкий, регулярками — namespace нам не важен) ──────────────

function xmlDecode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&");
}

function readSharedStrings(text) {
  if (!text) return [];
  const arr = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(text))) {
    const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t,
      s = "";
    while ((t = tre.exec(m[1]))) s += t[1];
    arr.push(xmlDecode(s));
  }
  return arr;
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Лист -> { rowNum: { colIndex: value(строка) } }
function parseSheet(text, shared) {
  const rows = {};
  const rre = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rre.exec(text))) {
    const rn = +r[1];
    const cells = {};
    const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cre.exec(r[2]))) {
      const attrs = c[1];
      const body = c[2] || "";
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let val = "";
      const vm = body.match(/<v>([\s\S]*?)<\/v>/);
      const im = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/);
      if (type === "s" && vm) val = shared[+vm[1]] ?? "";
      else if (type === "inlineStr" && im) val = xmlDecode(im[1]);
      else if (vm) val = vm[1];
      if (val !== "") cells[colToIndex(ref)] = val;
    }
    rows[rn] = cells;
  }
  return rows;
}

// ── Даты Excel ────────────────────────────────────────────────────────────

function serialToISO(serial) {
  const ms = Math.round((serial - 25569) * 86400000); // 25569 = 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayUTC(iso) {
  return new Date(iso + "T00:00:00Z").getUTCDay(); // 0=Вс … 6=Сб
}

// Последние N рабочих дней по дату asOf включительно (сегодня и назад).
function lastWorkingDays(asOfISO, count, workingDays) {
  const days = [];
  let cur = asOfISO;
  for (let i = 0; i < 400 && days.length < count; i++) {
    if (workingDays.includes(weekdayUTC(cur))) days.unshift(cur);
    cur = addDaysISO(cur, -1);
  }
  return days;
}

// ── Разбор книги целиком ──────────────────────────────────────────────────

const num = (v) => {
  if (v == null || v === "") return NaN;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const norm = (s) => String(s || "").trim().toLowerCase();

// Пропускаем служебные листы.
function isDataSheet(name) {
  const n = norm(name);
  return !(n.includes("заказать") || n.includes("инфо") || /^лист\s*\d+$/.test(n));
}

// Ищем строку заголовков (содержит «наименование») в первых 5 строках.
function findHeaderRow(rows) {
  for (let r = 1; r <= 5; r++) {
    const cells = rows[r];
    if (cells && Object.values(cells).some((v) => /наименован/i.test(v))) return r;
  }
  return null;
}

function mapColumns(headerCells) {
  let category = null,
    name = null,
    balance = null,
    consumption = null,
    consPeriod = "week";
  for (const [idxStr, raw] of Object.entries(headerCells)) {
    const idx = +idxStr;
    const h = norm(raw);
    if (!name && /наименован/.test(h)) name = idx;
    else if (!category && /категор/.test(h)) category = idx;
    // Текущий остаток: «ост итого» или «остаток на конец…». Берём самый правый.
    if (/ост/.test(h) && (/итого/.test(h) || /конец/.test(h))) {
      if (balance === null || idx > balance) balance = idx;
    }
    // Расход за период: «итого расход …». Берём самый правый (месяц > неделя).
    if (/итого/.test(h) && /расход/.test(h)) {
      if (consumption === null || idx > consumption) {
        consumption = idx;
        consPeriod = /месяц/.test(h) ? "month" : "week";
      }
    }
  }
  return { category, name, balance, consumption, consPeriod };
}

const SKIP_NAME = /^(итого|всего|категор|наименован)/i;

// arrayBuffer -> { categories:[имена], items:[{category,name,stock,outs:[{date,qty}]}] }
export async function parseWorkbook(arrayBuffer, opts = {}) {
  const workingDays = opts.workingDays || [1, 2, 3, 4, 5];
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "Браузер не поддерживает распаковку .xlsx. Обновите браузер (iOS 16.4+/свежий Chrome).",
    );
  }

  const files = await unzip(arrayBuffer);
  const shared = readSharedStrings(textOf(files, "xl/sharedStrings.xml"));

  // Имена листов и их пути.
  const wbText = textOf(files, "xl/workbook.xml");
  const relsText = textOf(files, "xl/_rels/workbook.xml.rels");
  const relMap = {};
  for (const m of relsText.matchAll(
    /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]*)"/g,
  )) {
    relMap[m[1]] = m[2];
  }
  const sheets = [];
  let autoIdx = 0;
  for (const m of wbText.matchAll(/<sheet[^>]*\/>/g)) {
    autoIdx++;
    const tag = m[0];
    const name = (tag.match(/name="([^"]*)"/) || [])[1] || "Лист" + autoIdx;
    const rid = (tag.match(/r:id="(rId\d+)"/) || [])[1];
    const target = (rid && relMap[rid]) || "worksheets/sheet" + autoIdx + ".xml";
    const path = "xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, "");
    sheets.push({ name, path });
  }

  // По каждому товару берём остаток и расход из самого свежего листа, где они
  // есть (свежесть = порядок листа в книге). Категории объединяем без учёта
  // регистра и пробелов («Соль» = «соль»).
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const perItem = new Map();
  const catDisplay = new Map(); // ключ(lower) -> отображаемое имя категории

  sheets.forEach((sheet, sheetIdx) => {
    if (!isDataSheet(sheet.name)) return;
    const bytes = files.get(sheet.path);
    if (!bytes) return;
    const rows = parseSheet(new TextDecoder("utf-8").decode(bytes), shared);
    const headerRow = findHeaderRow(rows);
    if (!headerRow) return;
    const cols = mapColumns(rows[headerRow]);
    if (!cols.name) return;

    const defaultCategory = /хоз/i.test(sheet.name) ? "Хозтовары" : "Без категории";
    let lastCategory = defaultCategory;
    const maxRow = Math.max(...Object.keys(rows).map(Number));

    for (let r = headerRow + 1; r <= maxRow; r++) {
      const row = rows[r];
      if (!row) continue;
      const name = String(row[cols.name] || "").trim();
      if (!name || SKIP_NAME.test(name)) continue;

      let category = lastCategory;
      if (cols.category) {
        const c = String(row[cols.category] || "").trim();
        if (c) {
          category = c;
          lastCategory = c;
        }
      }
      const catKey = category.toLowerCase();
      if (!catDisplay.has(catKey)) catDisplay.set(catKey, category);

      const stock = num(row[cols.balance]);
      const periodOut = num(row[cols.consumption]);
      const key = catKey + " " + name.toLowerCase();
      let rec = perItem.get(key);
      if (!rec) {
        rec = {
          category: catDisplay.get(catKey),
          name,
          stock: 0,
          stockIdx: -1,
          periodOut: 0,
          periodType: "week",
          consIdx: -1,
        };
        perItem.set(key, rec);
      }
      // Остаток — из самого свежего листа, где он указан.
      if (!Number.isNaN(stock) && sheetIdx >= rec.stockIdx) {
        rec.stock = stock;
        rec.stockIdx = sheetIdx;
      }
      // Расход за период — из самого свежего листа, где он указан.
      if (!Number.isNaN(periodOut) && sheetIdx >= rec.consIdx) {
        rec.periodOut = periodOut;
        rec.periodType = cols.consPeriod;
        rec.consIdx = sheetIdx;
      }
    }
  });

  // Строим категории (в порядке появления) и товары с движениями.
  const categories = [];
  const items = [];
  for (const rec of perItem.values()) {
    if (!categories.includes(rec.category)) categories.push(rec.category);

    let outs = [];
    if (rec.periodOut > 0) {
      // Недельный итог кладём на последние 5 рабочих дней, месячный — на ~22.
      const count = rec.periodType === "month" ? 22 : 5;
      const days = lastWorkingDays(today, count, workingDays);
      const per = round2(rec.periodOut / days.length);
      outs = days.map((d) => ({ date: d, qty: per }));
    }
    items.push({ category: rec.category, name: rec.name, stock: rec.stock, outs });
  }

  return { categories, items };
}

function textOf(files, name) {
  const b = files.get(name);
  return b ? new TextDecoder("utf-8").decode(b) : "";
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

export const _internals = {
  serialToISO,
  lastWorkingDays,
  mapColumns,
  parseSheet,
  readSharedStrings,
};
