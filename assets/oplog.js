// oplog.js — компактный локальный журнал операций синка (для расследования
// случаев вроде «движения пропали после синка»: см. историю тумбстоунов от
// случайного импорта старого бэкапа). Пишет НЕ содержимое записей (только
// счётчики/факты) — этого достаточно, чтобы понять, что произошло, но
// достаточно компактно, чтобы не спорить за место в localStorage с рабочими
// данными (`sklad-state-v1`) и снимком синка (`sklad-syncstate-v1`).
//
// Кольцевой буфер: старые записи выталкиваются, как только упираемся в лимит
// по байтам или по количеству — см. MAX_BYTES.

const KEY = "sklad-oplog-v1";
// localStorage per-origin квота у браузеров обычно 5–10 МБ (мобильный Safari —
// у нижней границы), и делят её с sklad-state-v1/sklad-syncstate-v1, которые
// на активном складе уже могут быть от единиц до пары десятков МБ. Лог —
// диагностика, а не рабочие данные, поэтому ему нарочно выделена скромная,
// фиксированная доля.
const MAX_BYTES = 200 * 1024; // 200 КБ
const MAX_ENTRIES = 500;

function load() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Обрезает с начала (старые записи) под оба лимита. Возвращает то, что реально
// сохранилось (для тестов и на случай переполнения квоты).
function save(arr) {
  while (arr.length > MAX_ENTRIES) arr.shift();
  let json = JSON.stringify(arr);
  while (json.length > MAX_BYTES && arr.length > 1) {
    arr.shift();
    json = JSON.stringify(arr);
  }
  try {
    localStorage.setItem(KEY, json);
  } catch {
    // Квота переполнена чем-то другим (напр. другой origin-ключ распух) —
    // режем пополам и пробуем ещё раз; если и это не влезло, тихо сдаёмся —
    // лог не критичен для работы приложения.
    if (arr.length > 1) {
      arr.splice(0, Math.ceil(arr.length / 2));
      try {
        localStorage.setItem(KEY, JSON.stringify(arr));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  return arr;
}

// Записать событие. data — плоский объект с короткими полями (счётчики, id,
// короткие строки) — НЕ класть сюда целые записи/массивы записей.
export function log(event, data = {}) {
  const arr = load();
  arr.push({ t: Date.now(), event, ...data });
  return save(arr);
}

export function getAll() {
  return load();
}

export function clear() {
  localStorage.removeItem(KEY);
}

// Текущий размер лога в байтах (для UI — показать, сколько накопилось).
export function sizeBytes() {
  return (localStorage.getItem(KEY) || "").length;
}
