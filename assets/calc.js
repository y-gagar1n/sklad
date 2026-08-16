// calc.js — вся «математика» склада в одном месте.
// Чистые функции без побочных эффектов: их же гоняют тесты в tests/calc.test.mjs.
// Идея: пользователь не пишет формулы вручную — вся логика средних, остатков,
// заказов и срочности живёт здесь и покрыта тестами.

// ── Работа с датами (строки 'YYYY-MM-DD', локальная полночь) ───────────────────

export function parseISO(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayISO(now = new Date()) {
  return toISO(now);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// Полных дней между двумя датами (b - a). Отрицательно, если b раньше a.
export function diffDays(aISO, bISO) {
  const a = parseISO(aISO);
  const b = parseISO(bISO);
  return Math.round((b - a) / 86400000);
}

// getDay(): 0=Вс, 1=Пн … 6=Сб.
export function weekday(iso) {
  return parseISO(iso).getDay();
}

export function isWorkingDay(iso, workingDays) {
  return workingDays.includes(weekday(iso));
}

// Сколько рабочих дней в отрезке [fromISO, toISO] включительно.
export function countWorkingDays(fromISO, toISO, workingDays) {
  const total = diffDays(fromISO, toISO);
  if (total < 0) return 0;
  let count = 0;
  for (let i = 0; i <= total; i++) {
    if (isWorkingDay(addDays(fromISO, i), workingDays)) count++;
  }
  return count;
}

// ── Остатки ────────────────────────────────────────────────────────────────

// Остаток товара = сумма приходов минус сумма расходов по всем движениям.
// Инвентаризация тоже хранится как движение (adjust:true), поэтому остаток
// всегда пересчитывается из истории и не «уплывает».
export function stockOf(movements) {
  let stock = 0;
  for (const m of movements) {
    if (m.type === "in") stock += m.qty;
    else if (m.type === "out") stock -= m.qty;
  }
  return round2(stock);
}

// Остаток на конец указанной даты (включительно) — для истории/графика.
export function stockAsOf(movements, asOfISO) {
  let stock = 0;
  for (const m of movements) {
    if (diffDays(m.date, asOfISO) < 0) continue; // движение позже asOf — пропускаем
    if (m.type === "in") stock += m.qty;
    else if (m.type === "out") stock -= m.qty;
  }
  return round2(stock);
}

// ── Расход и средние ─────────────────────────────────────────────────────────

// Только реальный расход (type==='out', не корректировки инвентаризации).
export function realConsumption(movements) {
  return movements.filter((m) => m.type === "out" && !m.adjust);
}

// Суммарный расход в окне [fromISO, toISO] включительно.
export function sumConsumption(movements, fromISO, toISO) {
  let sum = 0;
  for (const m of realConsumption(movements)) {
    if (diffDays(fromISO, m.date) < 0) continue; // раньше окна
    if (diffDays(m.date, toISO) < 0) continue; // позже окна
    sum += m.qty;
  }
  return round2(sum);
}

// Дата самого раннего движения (для честного делителя, пока данных мало).
export function firstMovementDate(movements) {
  let first = null;
  for (const m of movements) {
    if (first === null || diffDays(m.date, first) > 0) first = m.date;
  }
  return first;
}

// Средний расход в день.
// Окно: [asOf - windowDays + 1 … asOf], но не раньше первого движения —
// иначе в первые дни среднее занижается делением на пустые дни.
// workingDaysOnly — делим на число рабочих дней в окне, иначе на календарные.
export function averageDailyConsumption(movements, opts) {
  const {
    asOf,
    windowDays = 30,
    workingDaysOnly = true,
    workingDays = [1, 2, 3, 4, 5],
  } = opts;

  const first = firstMovementDate(movements);
  if (!first) return 0;

  const windowStart = addDays(asOf, -(windowDays - 1));
  // Не уходим левее первого движения.
  const effectiveStart =
    diffDays(first, windowStart) > 0 ? windowStart : first;

  const total = sumConsumption(movements, effectiveStart, asOf);
  if (total === 0) return 0;

  let divisor;
  if (workingDaysOnly) {
    divisor = countWorkingDays(effectiveStart, asOf, workingDays);
  } else {
    divisor = diffDays(effectiveStart, asOf) + 1;
  }
  if (divisor <= 0) return 0;
  return round2(total / divisor);
}

export function workingDaysPerWeek(workingDays) {
  return workingDays.length || 7;
}

// Средний расход за неделю.
export function weeklyAverage(dailyAvg, workingDaysOnly, workingDays) {
  const perWeek = workingDaysOnly ? workingDaysPerWeek(workingDays) : 7;
  return round2(dailyAvg * perWeek);
}

// Средний расход за месяц. 4.345 недели в среднем месяце.
export function monthlyAverage(dailyAvg, workingDaysOnly, workingDays) {
  const daysPerMonth = workingDaysOnly
    ? workingDaysPerWeek(workingDays) * 4.345
    : 30.437;
  return round2(dailyAvg * daysPerMonth);
}

// ── Заказ и срочность ────────────────────────────────────────────────────────

// На сколько дней хватит текущего остатка при текущем среднем расходе.
export function daysOfStock(currentStock, dailyAvg) {
  if (dailyAvg <= 0) return Infinity;
  return round1(currentStock / dailyAvg);
}

// Сколько заказать на следующий месяц.
// Цель — покрыть месячный расход и держать неснижаемый остаток (minStock),
// за вычетом того, что уже есть на складе. Округляем вверх.
export function recommendedOrder(currentStock, monthlyAvg, minStock = 0) {
  const target = monthlyAvg + (minStock || 0);
  const need = target - currentStock;
  return need > 0 ? Math.ceil(need) : 0;
}

// Насколько срочно заказывать.
//   'critical' — срочно: остаток не выше минимального или хватит < 7 дней;
//   'soon'     — скоро: хватит < 21 дня либо близко к минимуму;
//   'ok'       — запаса достаточно.
export const URGENCY = { CRITICAL: "critical", SOON: "soon", OK: "ok" };

export function urgency(currentStock, minStock, dailyAvg) {
  const days = daysOfStock(currentStock, dailyAvg);
  const min = minStock || 0;
  if (currentStock <= min || days < 7) return URGENCY.CRITICAL;
  if (days < 21 || currentStock <= min * 1.5) return URGENCY.SOON;
  return URGENCY.OK;
}

// Полная сводка по товару — то, что показывает карточка/аналитика.
export function itemSummary(movements, item, opts) {
  const dailyAvg = averageDailyConsumption(movements, opts);
  const stock = stockOf(movements);
  const monthly = monthlyAverage(
    dailyAvg,
    opts.workingDaysOnly,
    opts.workingDays,
  );
  const weekly = weeklyAverage(
    dailyAvg,
    opts.workingDaysOnly,
    opts.workingDays,
  );
  const minStock = item.minStock || 0;
  return {
    stock,
    dailyAvg,
    weeklyAvg: weekly,
    monthlyAvg: monthly,
    daysLeft: daysOfStock(stock, dailyAvg),
    order: recommendedOrder(stock, monthly, minStock),
    urgency: urgency(stock, minStock, dailyAvg),
  };
}

// ── Округление ────────────────────────────────────────────────────────────────

export function round1(x) {
  return Math.round(x * 10) / 10;
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}
