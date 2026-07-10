// ─────────────────────────────────────────────────────────────────────────────
// Bank reconciliation matcher (pure).
// Given rows from a bank statement and the app's journal entries for the
// same period, produce:
//   - matches:       statement row ↔ journal entry (one-to-one)
//   - unmatchedRows: statement rows with no JV counterpart
//   - unmatchedJVs:  journal entries with no statement row
//   - suggestions:   best-candidate matches below the confidence cutoff
//   - candidates:    top-5 scored JVs PER ROW (keyed by row id), including rows
//                    that lost the greedy race — feeds the "Change match" picker
//
// Match rules (in order, highest confidence first):
//   1. Exact amount + same date + same sign (in/out)
//   2. Exact amount + date within ±3 days
//   3. Amount within 0.5% tolerance + date within ±3 days
//   4. Aggregated-amount match: one statement row ≈ sum of N JVs
//
// Also supports an RFC-4180 CSV parser (header-row aware, preamble-tolerant).
// ─────────────────────────────────────────────────────────────────────────────

import { round2, totalOf } from './schema.js';

/**
 * @typedef {Object} StatementRow
 * @property {string} date        // YYYY-MM-DD
 * @property {number} amount      // positive
 * @property {'debit'|'credit'} direction   // 'debit' = money out of our bank
 * @property {string} [description]
 * @property {string} [ref]       // UTR / cheque no
 * @property {number|null} [balance]  // running balance when the statement carries one
 * @property {string} [id]        // stable per-statement row id (see rowKey)
 */

/**
 * @typedef {Object} JEEntry
 * @property {string} id
 * @property {string} date
 * @property {string} [voucher_no]
 * @property {string} [narration]
 * @property {boolean} [reconciled]
 * @property {Array<{debitAccount:string, creditAccount:string, amount:number}>} entries
 */

const MS_PER_DAY = 86_400_000;
const parseISO = (s) => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};
const daysBetween = (a, b) => Math.round(Math.abs((parseISO(a) - parseISO(b)) / MS_PER_DAY));

/**
 * Stable identity for a statement row. Prefers the parser-assigned `id`
 * (date|direction|amount|desc40#occurrence — unique even for duplicate rows);
 * falls back to the legacy `date-amount-description` key so sessions saved
 * before stable ids still resolve their accepted/rejected maps.
 * @param {StatementRow} row
 */
export function rowKey(row) {
  if (row && row.id) return row.id;
  return `${row?.date}-${row?.amount}-${row?.description}`;
}

/**
 * Build a predicate that decides whether a JV account name is "the bank".
 * When a specific bank account is chosen we match it exactly (case-insensitive,
 * trimmed) so a multi-bank org reconciles one account at a time; when absent we
 * fall back to the legacy `/^bank\b/i` heuristic (any account starting "Bank").
 * @param {string} [bankAccountName]
 * @returns {(account: string) => boolean}
 */
export function makeBankMatcher(bankAccountName) {
  const target = (bankAccountName || '').trim().toLowerCase();
  if (!target) return (account) => /^bank\b/i.test(account || '');
  return (account) => (account || '').trim().toLowerCase() === target;
}

/**
 * Is this JV line involving the bank on the same `direction` as the statement?
 * direction='debit' (money out) ⇒ Bank is credited in the JV.
 * direction='credit' (money in) ⇒ Bank is debited in the JV.
 * @param {JEEntry} je
 * @param {'debit'|'credit'} direction
 * @param {(account: string) => boolean} isBank
 */
function jeMatchesDirection(je, direction, isBank) {
  const lines = je?.entries || [];
  return lines.some((l) => {
    const drIsBank = isBank(l.debitAccount || '');
    const crIsBank = isBank(l.creditAccount || '');
    if (direction === 'credit') return drIsBank; // money in
    if (direction === 'debit')  return crIsBank; // money out
    return drIsBank || crIsBank;
  });
}

function jeAmount(je) {
  return totalOf(je?.entries || []);
}

/**
 * Score a (row, je) pair. Higher is better; 0 = impossible.
 * @param {StatementRow} row
 * @param {JEEntry} je
 * @param {(account: string) => boolean} isBank
 */
function scorePair(row, je, isBank) {
  if (!jeMatchesDirection(je, row.direction, isBank)) return 0;
  const amtA = round2(row.amount);
  const amtB = round2(jeAmount(je));
  if (amtA <= 0 || amtB <= 0) return 0;
  const diff = Math.abs(amtA - amtB);
  const tolerance = Math.max(0.5, amtA * 0.005);
  if (diff > tolerance) return 0;
  const days = daysBetween(row.date, je.date);
  if (days > 7) return 0;

  let score = 100;
  score -= (diff / Math.max(amtA, 1)) * 400; // amount precision weight
  score -= days * 5;
  // Reward exact-same-date, exact-amount, UTR in narration
  if (days === 0) score += 10;
  if (diff < 0.01) score += 15;
  if (row.ref && (je.narration || '').toLowerCase().includes(row.ref.toLowerCase())) score += 20;
  return Math.max(0, round2(score));
}

/**
 * Main reconciliation entry point.
 * @param {StatementRow[]} rows
 * @param {JEEntry[]} journalEntries
 * @param {{minConfidence?: number, bankAccountName?: string, learnedMatches?: Array<{row:StatementRow, journal_entry_id?:string}>}} [opts]
 */
export function reconcile(rows, journalEntries, opts = {}) {
  const minConfidence = opts.minConfidence ?? 60;
  const isBank = makeBankMatcher(opts.bankAccountName);
  const learnedIndex = buildLearnedIndex(opts.learnedMatches);
  const usedJE = new Set();
  const usedRow = new Set();
  const matches = [];
  const suggestions = [];

  // Build score grid, keep only plausible candidates.
  const cands = [];
  rows.forEach((row, ri) => {
    journalEntries.forEach((je) => {
      const base = scorePair(row, je, isBank);
      if (base <= 0) return;
      const boost = learnedBoost(row, je, learnedIndex);
      const score = Math.min(100, round2(base + boost));
      cands.push({ ri, jeId: je.id, score, base, boost, row, je });
    });
  });
  cands.sort((a, b) => b.score - a.score);

  // Per-row candidate lists (top 5, already in desc-score order because `cands`
  // is globally sorted). Includes candidates whose JV is claimed by another row
  // so the UI can offer a "Change match" picker; the unique-jeId guard lives in
  // the UI/persist layer.
  /** @type {Record<string, Array<{jeId:string, score:number, confidence:number, reason:string, je:JEEntry, journalEntry:JEEntry}>>} */
  const candidates = {};
  for (const c of cands) {
    const key = rowKey(c.row);
    const list = candidates[key] || (candidates[key] = []);
    if (list.length < 5) {
      const reason = describeMatch(c.row, c.je, c.base, c.boost);
      list.push({ jeId: c.jeId, score: c.score, confidence: c.score, reason, je: c.je, journalEntry: c.je });
    }
  }

  for (const c of cands) {
    if (usedJE.has(c.jeId) || usedRow.has(c.ri)) continue;
    const reason = describeMatch(c.row, c.je, c.base, c.boost);
    const entry = { row: c.row, je: c.je, journalEntry: c.je, score: c.score, confidence: c.score, reason };
    if (c.score >= minConfidence) {
      matches.push(entry);
      usedJE.add(c.jeId);
      usedRow.add(c.ri);
    } else {
      // Note but don't claim
      suggestions.push(entry);
    }
  }

  const unmatchedRows = rows.filter((_, i) => !usedRow.has(i));
  const unmatchedJVs = journalEntries.filter((je) => !usedJE.has(je.id));

  // Aggregate-match fallback: try to match unmatched rows to sums of
  // unmatched JVs (same date, same direction, subset of up to 4 entries).
  for (const row of unmatchedRows.slice()) {
    const rowIdx = rows.indexOf(row);
    if (usedRow.has(rowIdx)) continue;
    const bucket = unmatchedJVs.filter((je) =>
      jeMatchesDirection(je, row.direction, isBank) &&
      daysBetween(row.date, je.date) <= 3 &&
      !usedJE.has(je.id),
    );
    const combo = findSubsetMatchingAmount(bucket, row.amount, 4);
    if (combo) {
      const agg = { aggregateOf: combo.map((je) => je.id), amount: row.amount, date: row.date };
      matches.push({
        row,
        je: agg,
        journalEntry: agg,
        score: 70,
        confidence: 70,
        reason: `Aggregate of ${combo.length} vouchers`,
        aggregated: true,
      });
      usedRow.add(rowIdx);
      combo.forEach((je) => usedJE.add(je.id));
    }
  }

  return {
    matches,
    candidates,
    unmatchedRows: rows.filter((_, i) => !usedRow.has(i)),
    unmatchedJVs: journalEntries.filter((je) => !usedJE.has(je.id)),
    suggestions: suggestions.filter((s) => !usedJE.has(s.je.id) && !usedRow.has(rows.indexOf(s.row))),
    stats: {
      rows: rows.length,
      journal: journalEntries.length,
      matched: matches.length,
      aggregated: matches.filter((m) => m.aggregated).length,
      learnedBoosted: matches.filter((m) => /learned/i.test(m.reason || '')).length,
    },
  };
}

/**
 * Build a term/ref lookup from previously-accepted matches.
 * @param {Array<{row?: StatementRow, journal_entry_id?: string}> | undefined} accepted
 */
function buildLearnedIndex(accepted) {
  const terms = new Map(); // token → count
  const refs = new Map();  // utr/cheque → count
  if (!Array.isArray(accepted)) return { terms, refs, size: 0 };
  for (const m of accepted) {
    const desc = (m?.row?.description || '').toLowerCase();
    for (const tok of tokenize(desc)) {
      terms.set(tok, (terms.get(tok) || 0) + 1);
    }
    const ref = (m?.row?.ref || '').toLowerCase().trim();
    if (ref && ref.length >= 4) refs.set(ref, (refs.get(ref) || 0) + 1);
  }
  return { terms, refs, size: accepted.length };
}

function tokenize(text) {
  if (!text) return [];
  return text.split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t));
}

/**
 * Additive confidence boost for rows that look like previously-approved matches.
 * Max +12 (≈ half a UTR match); keeps base scoring dominant.
 */
function learnedBoost(row, je, index) {
  if (!index || index.size === 0) return 0;
  let boost = 0;
  const ref = (row.ref || '').toLowerCase().trim();
  if (ref && index.refs.has(ref)) boost += 8;
  const desc = (row.description || '').toLowerCase();
  const narration = (je.narration || '').toLowerCase();
  let termHits = 0;
  for (const tok of tokenize(desc)) {
    if (index.terms.has(tok)) termHits += 1;
    if (narration.includes(tok)) termHits += 1;
  }
  if (termHits >= 1) boost += Math.min(4, termHits);
  return boost;
}

function describeMatch(row, je, base, boost) {
  const parts = [];
  const diff = Math.abs(round2(row.amount) - round2(jeAmount(je)));
  const days = daysBetween(row.date, je.date);
  if (diff < 0.01) parts.push('exact amount');
  else parts.push(`±₹${diff.toFixed(2)}`);
  if (days === 0) parts.push('same day');
  else parts.push(`${days}d apart`);
  if (row.ref && (je.narration || '').toLowerCase().includes(row.ref.toLowerCase())) {
    parts.push('UTR in narration');
  }
  if (boost > 0) parts.push(`learned +${boost}`);
  return `${parts.join(' · ')} (base ${base})`;
}

/**
 * Find a subset of items whose amounts sum to `target` (within 0.5).
 * Bounded to avoid exponential blow-up.
 * @template {{entries?: any[], amount?: number}} T
 * @param {T[]} items
 * @param {number} target
 * @param {number} maxSize
 * @returns {T[] | null}
 */
function findSubsetMatchingAmount(items, target, maxSize = 4) {
  const vals = items.map((it) => round2(totalOf(it.entries || []) || it.amount || 0));
  const n = items.length;
  if (n === 0 || n > 20) return null;
  let best = null;
  const choose = (start, picked, pickedSum) => {
    if (picked.length > maxSize || best) return;
    if (Math.abs(pickedSum - target) < 0.5 && picked.length >= 1) {
      best = picked.slice();
      return;
    }
    if (pickedSum > target + 0.5) return;
    for (let i = start; i < n; i += 1) {
      picked.push(items[i]);
      choose(i + 1, picked, pickedSum + vals[i]);
      picked.pop();
      if (best) return;
    }
  };
  choose(0, [], 0);
  return best;
}

// ── CSV parsing (RFC-4180, preamble-tolerant) ───────────────────────────────

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * RFC-4180 tokenizer over the WHOLE document: handles quoted fields, escaped
 * `""`, and newlines embedded inside quotes. Returns a matrix of string cells
 * with fully-blank rows dropped.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCSVMatrix(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = ''; i += 1; continue;
    }
    if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 1; continue;
    }
    field += ch; i += 1;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * Map a header row's cells to column roles. Roles are picked in a precedence
 * order and each column is claimed at most once, so "Dr/Cr" beats "Debit" and
 * "Debit"/"Credit" beat a bare "Amount".
 * @param {string[]} cells
 */
function mapColumns(cells) {
  const norm = cells.map((c) => String(c).toLowerCase().trim());
  const used = new Set();
  const pick = (patterns) => {
    for (const p of patterns) {
      for (let i = 0; i < norm.length; i += 1) {
        if (used.has(i) || !norm[i]) continue;
        if (p.test(norm[i])) { used.add(i); return i; }
      }
    }
    return -1;
  };
  const idxDate    = pick([/^(?:txn|transaction|value|posting|tran|book(?:ing)?)?\.?\s*date\b/, /date/]);
  const idxType    = pick([/^(?:dr\s*\/\s*cr|cr\s*\/\s*dr)$/, /\btype\b/, /\bindicator\b/]);
  const idxDebit   = pick([/withdraw/, /\bdebit\b/, /paid\s*out/, /^dr\.?$/]);
  const idxCredit  = pick([/deposit/, /\bcredit\b/, /paid\s*in/, /^cr\.?$/]);
  const idxBalance = pick([/balance/, /^bal\.?$/]);
  const idxAmount  = pick([/\bamount\b/, /\bamt\b/]);
  const idxRef     = pick([/\butr\b/, /cheque/, /chq/, /reference/, /\bref\b/, /instrument/, /tran(?:saction)?\s*id/]);
  const idxDesc    = pick([/description/, /narration/, /particular/, /details?/, /remark/]);
  return { idxDate, idxType, idxDebit, idxCredit, idxBalance, idxAmount, idxRef, idxDesc };
}

/**
 * Score how "header-like" a row is. Requires a date-ish column AND a money-ish
 * column (debit/credit or amount); penalises rows carrying actual data values.
 * @param {string[]} cells
 * @returns {number} higher = more header-like; -1 = not a header
 */
function scoreHeader(cells) {
  const map = mapColumns(cells);
  const hasDate = map.idxDate >= 0;
  const hasMoney = map.idxDebit >= 0 || map.idxCredit >= 0 || map.idxAmount >= 0;
  if (!hasDate || !hasMoney) return -1;
  let score = 0;
  for (const k of Object.keys(map)) if (map[k] >= 0) score += 1;
  for (const cell of cells) {
    if (looksLikeAmount(cell) || looksLikeDate(cell)) score -= 2;
  }
  return score;
}

function looksLikeAmount(cell) {
  const t = String(cell || '').trim();
  if (!t) return false;
  return /^[-+(]?\s*(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d+)?\s*\)?\s*(?:cr|dr)?\.?$/i.test(t);
}

function looksLikeDate(cell) {
  const t = String(cell || '').trim();
  if (!t) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(t)
    || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)
    || /^\d{1,2}[\s/-][a-z]{3,}[\s/-]\d{2,4}$/i.test(t);
}

/**
 * Parse a money cell: strips ₹/Rs/INR, commas, NBSP; honours parentheses and
 * trailing Cr/Dr as sign hints. Returns a signed number (magnitude is taken by
 * the caller); non-numeric → 0.
 * @param {string} raw
 */
function parseAmountCell(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) sign = -1;
  s = s.replace(/[()]/g, '');
  s = s.replace(/(?:₹|rs\.?|inr)/gi, '');
  s = s.replace(/\s*(cr|dr)\.?\s*$/i, '');              // trailing Cr/Dr (glued or spaced)
  s = s.replace(/[,\s]/g, '');                          // grouping separators
  if (s === '' || s === '.' || !/^[-+]?\d*(?:\.\d+)?$/.test(s)) return 0;
  const num = Number(s);
  return isFinite(num) ? sign * num : 0;
}

/**
 * Detect a trailing Cr/Dr marker on an amount cell (for single-amount-column
 * statements without a separate type column). Handles glued ("500Dr"),
 * spaced ("500 Cr") and parenthesised ("(Cr)") forms.
 * @param {string} cell
 * @returns {'cr'|'dr'|null}
 */
function detectDrCrMarker(cell) {
  const t = String(cell || '').trim().toLowerCase();
  if (/\d\s*cr\.?$/.test(t) || /\(cr\)$/.test(t) || /\bcr\b\.?$/.test(t)) return 'cr';
  if (/\d\s*dr\.?$/.test(t) || /\(dr\)$/.test(t) || /\bdr\b\.?$/.test(t)) return 'dr';
  return null;
}

/**
 * Normalise a date cell to YYYY-MM-DD. Handles ISO, DD/MM/YYYY, DD-MM-YY,
 * and DD-MMM-YY(YY) (month names), else falls back to Date parsing.
 * @param {string} s
 */
function normaliseDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // DD-MMM-YYYY / DD MMM YY / DD/MMM/YYYY
  let m = str.match(/^(\d{1,2})[\s/-]([a-z]{3,})[\s/-](\d{2,4})$/i);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) {
      let y = m[3];
      if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
      return `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }
  // DD/MM/YYYY or DD-MM-YYYY
  m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const asDate = new Date(str);
  if (!isNaN(asDate.getTime())) {
    const y = asDate.getFullYear();
    const mo = String(asDate.getMonth() + 1).padStart(2, '0');
    const d = String(asDate.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return '';
}

/**
 * Extract a StatementRow from a data row given the column map. Returns null
 * when the row has no usable date/amount (caller counts it as skipped).
 * @param {string[]} cols
 * @param {ReturnType<typeof mapColumns>} map
 */
function extractDataRow(cols, map) {
  const date = normaliseDate(cols[map.idxDate]);
  if (!date) return null;
  const desc = String(cols[map.idxDesc] || '').trim();
  const ref  = String(cols[map.idxRef] || '').trim();
  let amount = 0;
  let direction = null;

  if (map.idxDebit >= 0 || map.idxCredit >= 0) {
    const dr = Math.abs(parseAmountCell(cols[map.idxDebit]));
    const cr = Math.abs(parseAmountCell(cols[map.idxCredit]));
    if (dr > 0) { amount = dr; direction = 'debit'; }
    else if (cr > 0) { amount = cr; direction = 'credit'; }
  } else if (map.idxAmount >= 0) {
    const cell = cols[map.idxAmount] || '';
    const raw = parseAmountCell(cell);
    amount = Math.abs(raw);
    if (map.idxType >= 0) {
      const t = String(cols[map.idxType] || '').toLowerCase();
      if (/cr/.test(t)) direction = 'credit';
      else if (/dr|db|wd|with/.test(t)) direction = 'debit';
      else direction = raw < 0 ? 'debit' : 'credit';
    } else {
      const marker = detectDrCrMarker(cell);
      if (marker) direction = marker === 'cr' ? 'credit' : 'debit';
      else direction = raw < 0 ? 'debit' : 'credit';
    }
  }

  if (!(amount > 0) || !direction) return null;
  const balance = map.idxBalance >= 0 ? parseAmountCell(cols[map.idxBalance]) : null;
  return { date, amount: round2(amount), direction, description: desc, ref, balance };
}

const NON_TXN_RE = /opening balance|closing balance|balance b\/f|balance c\/f|brought forward|carried forward|^total|sub[\s-]?total|statement of|page \d/i;

/**
 * Parse a bank statement CSV with full diagnostics.
 * @param {string} csv
 * @returns {{rows: StatementRow[], headerRowIndex: number, skippedRows: number, openingBalance: number|null, closingBalance: number|null, warnings: string[]}}
 */
export function parseStatementCSVDetailed(csv) {
  const empty = { rows: [], headerRowIndex: -1, skippedRows: 0, openingBalance: null, closingBalance: null, warnings: [] };
  if (!csv || typeof csv !== 'string') return empty;
  const matrix = parseCSVMatrix(csv);
  if (matrix.length < 2) return empty;

  // Scored header detection over the first 30 rows (skips bank preambles).
  let headerRowIndex = -1;
  let bestScore = 0;
  const scanTo = Math.min(30, matrix.length);
  for (let i = 0; i < scanTo; i += 1) {
    const s = scoreHeader(matrix[i]);
    if (s > bestScore) { bestScore = s; headerRowIndex = i; }
  }
  if (headerRowIndex < 0) {
    return { ...empty, warnings: ['No recognizable header row found — expected Date plus Debit/Credit or Amount columns.'] };
  }

  const map = mapColumns(matrix[headerRowIndex]);
  const dataRegion = matrix.slice(headerRowIndex + 1);
  const rows = [];
  const seen = new Map();
  let skippedRows = 0;
  let explicitOpening = null;
  let explicitClosing = null;

  for (const cols of dataRegion) {
    const joined = cols.join(' ');
    // Capture explicit opening/closing balance summary lines.
    if (/opening balance/i.test(joined)) {
      const v = firstAmount(cols);
      if (v != null) explicitOpening = v;
    }
    if (/closing balance/i.test(joined)) {
      const v = firstAmount(cols);
      if (v != null) explicitClosing = v;
    }
    const row = extractDataRow(cols, map);
    if (!row) {
      if (!NON_TXN_RE.test(joined)) skippedRows += 1;
      continue;
    }
    // Stable id: distinct suffix per duplicate (date|dir|amount|desc40#occ).
    const base = `${row.date}|${row.direction}|${row.amount}|${(row.description || '').slice(0, 40)}`;
    const occ = seen.get(base) || 0;
    seen.set(base, occ + 1);
    row.id = `${base}#${occ}`;
    rows.push(row);
  }

  // Opening/closing balance: explicit labels win, else derive from the balance
  // column (last row = closing; first row ± its own amount = opening).
  let openingBalance = explicitOpening;
  let closingBalance = explicitClosing;
  if (map.idxBalance >= 0 && rows.length) {
    const last = rows[rows.length - 1];
    const first = rows[0];
    if (closingBalance == null && last.balance != null) closingBalance = round2(last.balance);
    if (openingBalance == null && first.balance != null) {
      const signed = first.direction === 'credit' ? first.amount : -first.amount;
      openingBalance = round2(first.balance - signed);
    }
  }

  const warnings = [];
  if (headerRowIndex > 0) warnings.push(`Ignored ${headerRowIndex} preamble line(s) before the header.`);
  if (skippedRows > 0) warnings.push(`Skipped ${skippedRows} row(s) with no valid date/amount.`);

  return { rows, headerRowIndex, skippedRows, openingBalance, closingBalance, warnings };
}

/** First parseable non-zero amount in a row (used for balance summary lines). */
function firstAmount(cols) {
  for (const c of cols) {
    if (looksLikeAmount(c)) {
      const v = parseAmountCell(c);
      if (v !== 0) return round2(v);
    }
  }
  return null;
}

/**
 * Parse a bank CSV where headers exist. Thin wrapper over the detailed parser
 * for callers that only need the rows.
 * @param {string} csv
 * @returns {StatementRow[]}
 */
export function parseStatementCSV(csv) {
  return parseStatementCSVDetailed(csv).rows;
}
