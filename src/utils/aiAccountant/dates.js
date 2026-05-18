// ─────────────────────────────────────────────────────────────────────────────
// Natural-date parser for AI Accountant.
// Understands: explicit ISO / DMY / MDY; relative phrases (today, yesterday,
// tomorrow, day before yesterday, "N days/weeks/months ago", "last Friday",
// "this Monday", "next week"); month-day forms ("5 Jan", "Jan 5", "on 5th").
// All outputs are `YYYY-MM-DD`. Pure: takes an optional `now` for testability.
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clone = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const c = clone(d); c.setDate(c.getDate() + n); return c; };

/**
 * Try to parse any date reference found in free-form text.
 * Returns `{ date: 'YYYY-MM-DD', matched: '<phrase>' }` or `null` if none found.
 *
 * @param {string} text
 * @param {Date} [now] — reference "today" (default: new Date())
 * @returns {{ date: string, matched: string } | null}
 */
export function parseDate(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;
  const today = clone(now);

  // 1. ISO 8601 — YYYY-MM-DD
  let m = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isValid(d, +m[1], +m[2], +m[3])) return { date: toISO(d), matched: m[0] };
  }

  // 2. DD/MM/YYYY or DD-MM-YYYY (Indian convention, preferred over MDY here)
  m = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/);
  if (m) {
    let [, dd, mm, yy] = m;
    let year = +yy;
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const d = new Date(year, +mm - 1, +dd);
    if (isValid(d, year, +mm, +dd)) return { date: toISO(d), matched: m[0] };
  }

  // 3. "5 Jan 2026" / "5th Jan" / "Jan 5" / "January 5, 2026"
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:\s+(\d{2,4}))?\b/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const day = +m[1];
    const mon = MONTHS[m[2].toLowerCase()];
    let year = m[3] ? +m[3] : today.getFullYear();
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const d = new Date(year, mon, day);
    if (isValid(d, year, mon + 1, day)) return { date: toISO(d), matched: m[0] };
  }
  m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{2,4}))?\b/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const mon = MONTHS[m[1].toLowerCase()];
    const day = +m[2];
    let year = m[3] ? +m[3] : today.getFullYear();
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const d = new Date(year, mon, day);
    if (isValid(d, year, mon + 1, day)) return { date: toISO(d), matched: m[0] };
  }

  // 4. Relative shortcuts
  const lower = text.toLowerCase();
  if (/\bday\s+before\s+yesterday\b/.test(lower)) return { date: toISO(addDays(today, -2)), matched: 'day before yesterday' };
  if (/\byesterday\b/.test(lower))                 return { date: toISO(addDays(today, -1)), matched: 'yesterday' };
  if (/\btoday\b/.test(lower))                     return { date: toISO(today),              matched: 'today' };
  if (/\btomorrow\b/.test(lower))                  return { date: toISO(addDays(today, 1)),  matched: 'tomorrow' };

  // 5. "N days/weeks/months ago" / "in N days"
  m = lower.match(/\b(\d+)\s+(day|days|week|weeks|month|months)\s+ago\b/);
  if (m) {
    const n = +m[1];
    const unit = m[2];
    if (unit.startsWith('day'))   return { date: toISO(addDays(today, -n)), matched: m[0] };
    if (unit.startsWith('week'))  return { date: toISO(addDays(today, -n * 7)), matched: m[0] };
    if (unit.startsWith('month')) {
      const d = clone(today); d.setMonth(d.getMonth() - n);
      return { date: toISO(d), matched: m[0] };
    }
  }
  m = lower.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
  if (m) {
    const n = +m[1];
    return { date: toISO(addDays(today, m[2].startsWith('week') ? n * 7 : n)), matched: m[0] };
  }

  // 6. "last <weekday>" / "this <weekday>" / "next <weekday>"
  m = lower.match(/\b(last|this|next)\s+([a-z]+)\b/);
  if (m && WEEKDAYS[m[2]] !== undefined) {
    const target = WEEKDAYS[m[2]];
    const cur = today.getDay();
    let delta;
    if (m[1] === 'last') {
      delta = -(((cur - target) + 7) % 7 || 7);
    } else if (m[1] === 'next') {
      delta = ((target - cur) + 7) % 7 || 7;
    } else {
      // "this <weekday>": nearest one in the current week, forward if future else same day or backward
      delta = ((target - cur) + 7) % 7;
      if (delta === 0) delta = 0;
    }
    return { date: toISO(addDays(today, delta)), matched: m[0] };
  }

  // 7. "on 5th" / "on the 15th" → current month
  m = lower.match(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const day = +m[1];
    if (day >= 1 && day <= 31) {
      const d = new Date(today.getFullYear(), today.getMonth(), day);
      return { date: toISO(d), matched: m[0] };
    }
  }

  return null;
}

function isValid(d, y, m, day) {
  return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day;
}

/** Remove any recognised date phrase from the text (useful to clean narration). */
export function stripDate(text, now = new Date()) {
  const found = parseDate(text, now);
  if (!found) return text;
  return text.replace(found.matched, ' ').replace(/\s+/g, ' ').trim();
}
