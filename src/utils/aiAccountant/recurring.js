// ─────────────────────────────────────────────────────────────────────────────
// Recurring entries: pure schedule engine. Given a rule + "as of date",
// compute the next run, list due runs, and project future runs for a window.
//
// Rule shape:
//   {
//     frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly',
//     interval: 1,                      // every N periods (default 1)
//     dayOfMonth: 1..31,                 // for monthly/quarterly/yearly
//     dayOfWeek: 0..6,                   // for weekly (0=Sun)
//     startDate: 'YYYY-MM-DD',
//     endDate?:  'YYYY-MM-DD',
//     lastRunDate?: 'YYYY-MM-DD',
//     active?: boolean,                  // default true
//   }
//
// No Firestore I/O. Consumers persist rules separately and call these helpers.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {'daily'|'weekly'|'monthly'|'quarterly'|'yearly'} Frequency
 * @typedef {Object} RecurringRule
 * @property {Frequency} frequency
 * @property {number} [interval]
 * @property {number} [dayOfMonth]
 * @property {number} [dayOfWeek]
 * @property {string}  startDate
 * @property {string}  [endDate]
 * @property {string}  [lastRunDate]
 * @property {boolean} [active]
 * @property {string}  [id]
 * @property {string}  [name]
 */

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => {
  const [y, m, d] = (s || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
};

/**
 * Add N periods of the given frequency to a Date, preserving dayOfMonth when
 * possible (clamps 31→28/30 for short months).
 * @param {Date} date
 * @param {Frequency} frequency
 * @param {number} n
 * @returns {Date}
 */
function addPeriods(date, frequency, n = 1) {
  const d = new Date(date);
  switch (frequency) {
    case 'daily':
      d.setDate(d.getDate() + n);
      return d;
    case 'weekly':
      d.setDate(d.getDate() + 7 * n);
      return d;
    case 'monthly': {
      const target = d.getMonth() + n;
      const year = d.getFullYear() + Math.floor(target / 12);
      const month = ((target % 12) + 12) % 12;
      // Clamp day
      const day = Math.min(d.getDate(), daysInMonth(year, month));
      return new Date(year, month, day);
    }
    case 'quarterly':
      return addPeriods(d, 'monthly', 3 * n);
    case 'yearly': {
      const year = d.getFullYear() + n;
      const day = Math.min(d.getDate(), daysInMonth(year, d.getMonth()));
      return new Date(year, d.getMonth(), day);
    }
    default:
      return d;
  }
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Compute the next run date AFTER `fromDate` (exclusive) per the rule.
 * Returns null if the rule is inactive or past endDate.
 * @param {RecurringRule} rule
 * @param {string} fromISO  "YYYY-MM-DD"
 * @returns {string|null}
 */
export function computeNextRun(rule, fromISO) {
  if (!rule || rule.active === false) return null;
  const start = parseISO(rule.startDate);
  if (!start) return null;
  const from = parseISO(fromISO) || new Date();
  const end = rule.endDate ? parseISO(rule.endDate) : null;
  const interval = Math.max(1, Number(rule.interval) || 1);

  // Start from max(startDate, lastRunDate). Advance by period until > from.
  const lastRun = rule.lastRunDate ? parseISO(rule.lastRunDate) : null;
  let cursor = lastRun && lastRun > start ? new Date(lastRun) : new Date(start);

  // If we've never run, the first run is the start date itself (provided it's > from).
  // So only advance when cursor <= from.
  let safety = 0;
  while (cursor <= from) {
    cursor = addPeriods(cursor, rule.frequency, interval);
    safety += 1;
    if (safety > 5000) return null;
  }
  if (end && cursor > end) return null;
  return toISO(cursor);
}

/**
 * List all runs due on-or-before `asOfISO` that haven't been executed yet.
 * @param {RecurringRule} rule
 * @param {string} asOfISO
 * @returns {string[]}
 */
export function dueRuns(rule, asOfISO) {
  if (!rule || rule.active === false) return [];
  const asOf = parseISO(asOfISO);
  if (!asOf) return [];
  const out = [];
  let cursor = rule.lastRunDate
    ? addPeriods(parseISO(rule.lastRunDate), rule.frequency, Math.max(1, Number(rule.interval) || 1))
    : parseISO(rule.startDate);
  const end = rule.endDate ? parseISO(rule.endDate) : null;
  let safety = 0;
  while (cursor && cursor <= asOf) {
    if (end && cursor > end) break;
    out.push(toISO(cursor));
    cursor = addPeriods(cursor, rule.frequency, Math.max(1, Number(rule.interval) || 1));
    safety += 1;
    if (safety > 1000) break;
  }
  return out;
}

/**
 * Project future runs for a window; useful for calendar preview.
 * @param {RecurringRule} rule
 * @param {string} fromISO
 * @param {string} toISODate
 */
export function projectRuns(rule, fromISO, toISODate) {
  if (!rule || rule.active === false) return [];
  const from = parseISO(fromISO);
  const to = parseISO(toISODate);
  if (!from || !to || from > to) return [];
  const end = rule.endDate ? parseISO(rule.endDate) : null;
  const out = [];
  // Start at the earliest possible run >= fromISO
  let cursor = rule.lastRunDate
    ? addPeriods(parseISO(rule.lastRunDate), rule.frequency, Math.max(1, Number(rule.interval) || 1))
    : parseISO(rule.startDate);
  let safety = 0;
  while (cursor && cursor < from) {
    cursor = addPeriods(cursor, rule.frequency, Math.max(1, Number(rule.interval) || 1));
    safety += 1;
    if (safety > 5000) return out;
  }
  safety = 0;
  while (cursor && cursor <= to) {
    if (end && cursor > end) break;
    out.push(toISO(cursor));
    cursor = addPeriods(cursor, rule.frequency, Math.max(1, Number(rule.interval) || 1));
    safety += 1;
    if (safety > 5000) break;
  }
  return out;
}

/**
 * Partition a list of rules into "due today or earlier" vs "upcoming" buckets.
 * @param {RecurringRule[]} rules
 * @param {string} asOfISO
 */
export function partitionRules(rules, asOfISO) {
  const due = [];
  const upcoming = [];
  for (const rule of rules || []) {
    const runs = dueRuns(rule, asOfISO);
    if (runs.length) due.push({ rule, runs });
    const nxt = computeNextRun(rule, asOfISO);
    if (nxt) upcoming.push({ rule, next: nxt });
  }
  return { due, upcoming };
}

/**
 * Minimal natural-language rule parser so the chat can accept:
 *   "pay rent 50000 every 1st of month"
 *   "charge AMC 25000 every 3 months on 10th"
 *   "salary 100000 monthly"
 * Returns null if no recurring phrase detected.
 * @param {string} text
 * @param {string} fromISO
 * @returns {Partial<RecurringRule> | null}
 */
export function parseRecurringPhrase(text, fromISO) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (!/\b(every|recurring|each|monthly|weekly|yearly|quarterly|daily)\b/.test(lower)) return null;

  let frequency = null;
  let interval = 1;
  let dayOfMonth = null;
  let dayOfWeek = null;

  if (/\bdaily\b|every\s+day\b/.test(lower)) frequency = 'daily';
  else if (/\bweekly\b|every\s+week\b/.test(lower)) frequency = 'weekly';
  else if (/\bquarterly\b|every\s+quarter\b/.test(lower)) frequency = 'quarterly';
  else if (/\byearly\b|annually\b|every\s+year\b/.test(lower)) frequency = 'yearly';
  else if (/\bmonthly\b|every\s+month\b|of\s+month\b|of\s+the\s+month\b/.test(lower)) frequency = 'monthly';

  const everyN = lower.match(/every\s+(\d+)\s+(day|week|month|quarter|year)s?/);
  if (everyN) {
    interval = Number(everyN[1]) || 1;
    if (!frequency) {
      frequency = everyN[2] === 'day' ? 'daily' :
                  everyN[2] === 'week' ? 'weekly' :
                  everyN[2] === 'quarter' ? 'quarterly' :
                  everyN[2] === 'year' ? 'yearly' : 'monthly';
    }
  }

  // Day-of-month like "1st", "15th", "on the 10th"
  const dom = lower.match(/\b(?:on\s+(?:the\s+)?)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dom && (frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly')) {
    const n = Number(dom[1]);
    if (n >= 1 && n <= 31) dayOfMonth = n;
  }

  // Day-of-week
  const dowNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dowMatch = dowNames.find((w) => new RegExp(`\\b${w}s?\\b`).test(lower));
  if (dowMatch && frequency === 'weekly') dayOfWeek = dowNames.indexOf(dowMatch);

  if (!frequency) return null;

  let startDate = fromISO || toISO(new Date());
  if (dayOfMonth && (frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly')) {
    const f = parseISO(startDate);
    if (f) {
      // Anchor start to specified day; if already past, push to next period.
      const candidate = new Date(f.getFullYear(), f.getMonth(), Math.min(dayOfMonth, daysInMonth(f.getFullYear(), f.getMonth())));
      if (candidate < f) {
        startDate = toISO(addPeriods(candidate, frequency, 1));
      } else {
        startDate = toISO(candidate);
      }
    }
  }

  return {
    frequency,
    interval,
    dayOfMonth: dayOfMonth ?? undefined,
    dayOfWeek: dayOfWeek ?? undefined,
    startDate,
    active: true,
  };
}
