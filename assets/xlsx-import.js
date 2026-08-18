// xlsx-import.js — разбор Excel-файла учёта склада без сторонних библиотек.
//
// Читает .xlsx (это ZIP из XML), достаёт из месячных сводных листов категории,
// товары, текущий остаток и реальные дневные движения (приход/расход с датами).
//
// Что берём (по заголовкам, не по буквам столбцов — раскладка на листах разная):
//   «Категория»     -> категория (у листов «Хоз-ка» её нет -> «Хозтовары»);
//   «наименование»  -> товар;
//   «Итого остаток» -> текущий остаток (из него выводим остаток на начало месяца);
//   дневные пары «Приход»/«Расход» -> движения; дата дня — Excel-сериал в строке
//   над шапкой, та же колонка.
//
// Берём данные только с месячных сводных листов (в названии есть месяц, напр.
// «Продукты Август», «Хозка Август 26»); недельные листы с диапазонами дат
// («Продукты 03.08-07.08») игнорируем — их итоги ненадёжны и расходятся между
// собой. Движения переносим как есть, с их датами; недостающий остаток на начало
// месяца досчитывает store.importFromParsed по формуле «остаток − Σприход + Σрасход».

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

// ── Разбор книги целиком ──────────────────────────────────────────────────

const num = (v) => {
  if (v == null || v === "") return NaN;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};
const norm = (s) => String(s || "").trim().toLowerCase();

// Берём только месячные сводные листы — те, где в названии есть месяц
// («Продукты Август», «Хозка Август 26»). Недельные листы с диапазонами дат,
// служебные («Заказать - инфо») и «Лист11» отсекаются автоматически — месяца в
// названии нет.
const MONTH_IN_NAME =
  /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i;
function isDataSheet(name) {
  return MONTH_IN_NAME.test(name);
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

// Дневные колонки движений: пары «Приход»/«Расход» по дням месяца. Дата дня
// лежит в строке над шапкой (dateCells), в той же колонке — Excel-сериал.
// «Итого приход/расход/остаток» — это месячные итоги, их сюда не берём.
const DAY_IN = /^приход/;
const DAY_OUT = /^расход/;
function dailyColumns(headerCells, dateCells) {
  const cols = [];
  if (!dateCells) return cols;
  for (const [idxStr, raw] of Object.entries(headerCells)) {
    const h = norm(raw);
    if (h.includes("итого")) continue;
    let type = null;
    if (DAY_IN.test(h)) type = "in";
    else if (DAY_OUT.test(h)) type = "out";
    if (!type) continue;
    const idx = +idxStr;
    const serial = num(dateCells[idx]);
    if (Number.isNaN(serial)) continue;
    cols.push({ idx, type, date: serialToISO(serial) });
  }
  return cols;
}

const SKIP_NAME = /^(итого|всего|категор|наименован)/i;

// Единицы измерения, которые в конце названия категории отбрасываем при
// группировке: «Мед гр» = «Мед», «Нутелла гр» = «Нутелла».
const UNIT_TOKENS = new Set(["гр", "г", "кг", "мл", "л", "шт"]);
function categoryKey(name) {
  const parts = String(name).trim().toLowerCase().split(/\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1].replace(/[.,]/g, "");
    if (UNIT_TOKENS.has(last)) parts.pop();
  }
  return parts.join(" ");
}

// Строка-разделитель этажа внутри листа: «ВТОРОЙ ЭТАЖ», «на 2м этаже на складе».
// Всё ниже такой строки (до конца листа) относится к указанному этажу.
const FLOOR_MARKER = /этаж/i;
const ORDINALS = { перв: 1, втор: 2, трет: 3, четв: 4, пят: 5, шест: 6 };
function floorFromMarker(text) {
  const t = String(text).toLowerCase();
  const digit = t.match(/(\d+)/);
  if (digit) return Math.max(1, parseInt(digit[1], 10));
  for (const [stem, n] of Object.entries(ORDINALS)) if (t.includes(stem)) return n;
  return 2; // «второй этаж» по умолчанию
}

// arrayBuffer -> { categories, floors, items:[{category,name,floor,stock,
//   moves:[{date,type:'in'|'out',qty}]}] }
export async function parseWorkbook(arrayBuffer, opts = {}) {
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

  // По каждому товару берём остаток и дневные движения из самого свежего
  // месячного листа, где он есть (свежесть = порядок листа в книге). Продукты и
  // хозтовары лежат на разных месячных листах и не пересекаются, так что слияние
  // тривиально. Категории объединяем без учёта регистра и пробелов («Соль» = «соль»).
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
    // Дневные колонки приход/расход и их даты (строка над шапкой).
    const daily = dailyColumns(rows[headerRow], rows[headerRow - 1]);

    const defaultCategory = /хоз/i.test(sheet.name) ? "Хозтовары" : "Без категории";
    let lastCategory = defaultCategory;
    let currentFloor = 1; // на каждом листе счёт этажей начинается с дефолтного
    const maxRow = Math.max(...Object.keys(rows).map(Number));

    for (let r = headerRow + 1; r <= maxRow; r++) {
      const row = rows[r];
      if (!row) continue;
      const name = String(row[cols.name] || "").trim();
      if (!name) continue;
      // Строка-разделитель этажа: переключаем этаж и не считаем её товаром.
      if (FLOOR_MARKER.test(name)) {
        currentFloor = floorFromMarker(name);
        continue;
      }
      if (SKIP_NAME.test(name)) continue;

      let category = lastCategory;
      if (cols.category) {
        const c = String(row[cols.category] || "").trim();
        if (c) {
          category = c;
          lastCategory = c;
        }
      }
      const catKey = categoryKey(category);
      const disp = category.trim();
      const prevDisp = catDisplay.get(catKey);
      // Имя категории — самое короткое из встреченных вариантов («Мед», не «Мед гр»).
      if (!prevDisp || disp.length < prevDisp.length) catDisplay.set(catKey, disp);

      const stock = num(row[cols.balance]);
      // Реальные дневные движения этой строки: непустые ячейки приход/расход.
      const moves = [];
      for (const d of daily) {
        const q = num(row[d.idx]);
        if (!Number.isNaN(q) && q > 0) moves.push({ date: d.date, type: d.type, qty: q });
      }

      const key = catKey + " " + name.toLowerCase();
      let rec = perItem.get(key);
      if (!rec) {
        rec = {
          catKey,
          name,
          stock: 0,
          stockIdx: -1,
          moves: [],
          movesIdx: -1,
          floorNum: 1,
          floorIdx: -1,
        };
        perItem.set(key, rec);
      }
      // Этаж товара — по самому свежему листу, где он встретился (последнее место).
      if (sheetIdx >= rec.floorIdx) {
        rec.floorIdx = sheetIdx;
        rec.floorNum = currentFloor;
      }
      // Остаток — из самого свежего листа, где он указан.
      if (!Number.isNaN(stock) && sheetIdx >= rec.stockIdx) {
        rec.stock = stock;
        rec.stockIdx = sheetIdx;
      }
      // Движения — из самого свежего листа, где встретился товар.
      if (sheetIdx >= rec.movesIdx) {
        rec.moves = moves;
        rec.movesIdx = sheetIdx;
      }
    }
  });

  // Строим категории, список этажей и товары с движениями.
  const categories = [];
  const floorNums = new Set([1]); // дефолтный этаж есть всегда
  const items = [];
  for (const rec of perItem.values()) {
    const category = catDisplay.get(rec.catKey);
    if (!categories.includes(category)) categories.push(category);
    floorNums.add(rec.floorNum);

    // Записи по возрастанию даты — для наглядного порядка в карточке товара.
    const moves = rec.moves
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    items.push({
      category,
      name: rec.name,
      floor: "Этаж " + rec.floorNum,
      stock: rec.stock,
      moves,
    });
  }
  const floors = [...floorNums].sort((a, b) => a - b).map((n) => "Этаж " + n);

  return { categories, floors, items };
}

function textOf(files, name) {
  const b = files.get(name);
  return b ? new TextDecoder("utf-8").decode(b) : "";
}

export const _internals = {
  serialToISO,
  mapColumns,
  dailyColumns,
  parseSheet,
  readSharedStrings,
  floorFromMarker,
  categoryKey,
  isDataSheet,
  FLOOR_MARKER,
};
