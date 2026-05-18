// Pure natural-language date-range parser for the assistant.
//
// parseDateRange(text, today?) → { start, end, label } | null
//   start, end are YYYY-MM-DD strings (inclusive), today defaults to "today".
//   FY = Apr 1 → Mar 31 (Indian financial year).
//
// Supported phrases (case-insensitive):
//   today, yesterday, tomorrow
//   this week, last week, next week
//   this month, last month, next month
//   this year, last year
//   this fy, last fy, current fy, fy 2024-25, FY24-25, FY 2024
//   q1 / q2 / q3 / q4   (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar)
//   january, february …  (single-month range — current year if not stated)
//   jan 2024, march 2025
//   last 7 days, last 30 days, last N weeks/months
//   past N days
//   since 1 jan, since jan, since 2024-01-01
//   between 1 jan and 15 jan, from A to B
//
// Returns null when no recognisable date phrase is present.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function fyBounds(fyStartYear) {
  // FY 2024-25 → Apr 1 2024 – Mar 31 2025
  return {
    start: iso(new Date(fyStartYear, 3, 1)),
    end: iso(new Date(fyStartYear + 1, 2, 31)),
  };
}

function currentFYStartYear(today) {
  // If month >= April (3) we are in FY starting this calendar year.
  return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}

function monthRange(year, month0) {
  const start = new Date(year, month0, 1);
  const end = new Date(year, month0 + 1, 0); // last day of month
  return { start: iso(start), end: iso(end) };
}

function quarterRange(today, q) {
  // Indian fiscal quarters: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
  const fyStart = currentFYStartYear(today);
  const startMonth = 3 + (q - 1) * 3; // 3,6,9,12
  if (startMonth < 12) {
    return monthRangeMulti(fyStart, startMonth, 3);
  }
  // Q4 wraps into next calendar year (Jan-Mar of fyStart+1).
  return monthRangeMulti(fyStart + 1, 0, 3);
}

function monthRangeMulti(year, startMonth0, count) {
  const start = new Date(year, startMonth0, 1);
  const end = new Date(year, startMonth0 + count, 0);
  return { start: iso(start), end: iso(end) };
}

function tryISO(s) {
  // YYYY-MM-DD or YYYY/MM/DD
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return null;
  return iso(dt);
}

function tryDayMonth(text, year) {
  // "1 jan", "15 march 2025", "jan 1", "march 15 2025"
  const m1 = /(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/i.exec(text);
  if (m1) {
    const day = Number(m1[1]);
    const mo = MONTHS[m1[2].toLowerCase()];
    if (mo == null) return null;
    const yr = m1[3] ? Number(m1[3]) : year;
    return iso(new Date(yr, mo, day));
  }
  const m2 = /([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec(text);
  if (m2) {
    const mo = MONTHS[m2[1].toLowerCase()];
    if (mo == null) return null;
    const day = Number(m2[2]);
    const yr = m2[3] ? Number(m2[3]) : year;
    return iso(new Date(yr, mo, day));
  }
  return null;
}

function tryMonthYear(text, defaultYear) {
  // "march 2025", "jan", "feb 2024"
  const m = /^([a-z]+)(?:\s+(\d{4}))?$/i.exec(text.trim());
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (mo == null) return null;
  const yr = m[2] ? Number(m[2]) : defaultYear;
  return monthRange(yr, mo);
}

/**
 * @param {string} text
 * @param {Date|string} [todayInput]
 * @returns {{start: string, end: string, label: string} | null}
 */
export function parseDateRange(text, todayInput) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const today = startOfDay(todayInput ? new Date(todayInput) : new Date());

  // Single-day shortcuts.
  if (/\btoday\b/.test(t)) {
    const v = iso(today); return { start: v, end: v, label: 'today' };
  }
  if (/\byesterday\b/.test(t)) {
    const v = iso(addDays(today, -1)); return { start: v, end: v, label: 'yesterday' };
  }
  if (/\btomorrow\b/.test(t)) {
    const v = iso(addDays(today, 1)); return { start: v, end: v, label: 'tomorrow' };
  }

  // "last N days/weeks/months"
  const lastN = /\b(?:last|past)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/.exec(t);
  if (lastN) {
    const n = Number(lastN[1]);
    const unit = lastN[2];
    let start;
    if (unit.startsWith('day')) start = addDays(today, -(n - 1));
    else if (unit.startsWith('week')) start = addDays(today, -(7 * n - 1));
    else { start = new Date(today); start.setMonth(start.getMonth() - n); start = addDays(start, 1); }
    return { start: iso(start), end: iso(today), label: `last ${n} ${unit}` };
  }

  // Week.
  if (/\bthis week\b/.test(t)) {
    const dow = today.getDay() || 7; // 1..7 (Mon..Sun)
    const start = addDays(today, -(dow - 1));
    const end = addDays(start, 6);
    return { start: iso(start), end: iso(end), label: 'this week' };
  }
  if (/\blast week\b/.test(t)) {
    const dow = today.getDay() || 7;
    const thisStart = addDays(today, -(dow - 1));
    const start = addDays(thisStart, -7);
    const end = addDays(thisStart, -1);
    return { start: iso(start), end: iso(end), label: 'last week' };
  }
  if (/\bnext week\b/.test(t)) {
    const dow = today.getDay() || 7;
    const start = addDays(today, -(dow - 1) + 7);
    const end = addDays(start, 6);
    return { start: iso(start), end: iso(end), label: 'next week' };
  }

  // Month.
  if (/\bthis month\b/.test(t)) {
    return { ...monthRange(today.getFullYear(), today.getMonth()), label: 'this month' };
  }
  if (/\blast month\b/.test(t)) {
    const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return { ...monthRange(d.getFullYear(), d.getMonth()), label: 'last month' };
  }
  if (/\bnext month\b/.test(t)) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return { ...monthRange(d.getFullYear(), d.getMonth()), label: 'next month' };
  }

  // Year (calendar).
  if (/\bthis year\b/.test(t)) {
    return { start: iso(new Date(today.getFullYear(), 0, 1)), end: iso(new Date(today.getFullYear(), 11, 31)), label: 'this year' };
  }
  if (/\blast year\b/.test(t)) {
    const y = today.getFullYear() - 1;
    return { start: iso(new Date(y, 0, 1)), end: iso(new Date(y, 11, 31)), label: 'last year' };
  }

  // Financial year — keywords + explicit "FY 2024-25" or "FY 2024".
  const fyExplicit = /\bfy\s*(\d{2,4})(?:\s*[-–/]\s*(\d{2,4}))?\b/.exec(t);
  if (fyExplicit) {
    let y1 = Number(fyExplicit[1]);
    if (y1 < 100) y1 += 2000;
    return { ...fyBounds(y1), label: `FY ${y1}-${String((y1 + 1) % 100).padStart(2, '0')}` };
  }
  if (/\b(this|current)\s+fy\b/.test(t) || /\b(this|current)\s+financial\s+year\b/.test(t)) {
    const y = currentFYStartYear(today);
    return { ...fyBounds(y), label: `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}` };
  }
  if (/\blast fy\b/.test(t) || /\bprevious fy\b/.test(t) || /\blast financial year\b/.test(t)) {
    const y = currentFYStartYear(today) - 1;
    return { ...fyBounds(y), label: `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}` };
  }

  // Quarters.
  const qm = /\bq([1-4])\b/.exec(t);
  if (qm) {
    const q = Number(qm[1]);
    return { ...quarterRange(today, q), label: `Q${q}` };
  }

  // "between A and B" / "from A to B"
  const between = /\b(?:between|from)\s+(.+?)\s+(?:and|to)\s+(.+)$/.exec(t);
  if (between) {
    const a = tryISO(between[1]) || tryDayMonth(between[1], today.getFullYear());
    const b = tryISO(between[2]) || tryDayMonth(between[2], today.getFullYear());
    if (a && b) {
      const [start, end] = a <= b ? [a, b] : [b, a];
      return { start, end, label: `${start} → ${end}` };
    }
  }

  // "since X"
  const since = /\bsince\s+(.+)$/.exec(t);
  if (since) {
    const v = tryISO(since[1]) || tryDayMonth(since[1], today.getFullYear()) || (() => {
      const r = tryMonthYear(since[1], today.getFullYear());
      return r ? r.start : null;
    })();
    if (v) return { start: v, end: iso(today), label: `since ${since[1].trim()}` };
  }

  // Bare "<month>" or "<month> <year>".
  const monthOnly = tryMonthYear(t, today.getFullYear());
  if (monthOnly) return { ...monthOnly, label: t };

  // ISO date alone.
  const isoMatch = tryISO(t);
  if (isoMatch) return { start: isoMatch, end: isoMatch, label: isoMatch };

  return null;
}

export default parseDateRange;
