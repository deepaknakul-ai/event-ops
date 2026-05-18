// ─────────────────────────────────────────────────────────────────────────────
// Bank reconciliation matcher (pure).
// Given rows from a bank statement and the app's journal entries for the
// same period, produce:
//   - matches:       statement row ↔ journal entry (one-to-one)
//   - unmatchedRows: statement rows with no JV counterpart
//   - unmatchedJVs:  journal entries with no statement row
//   - suggestions:   best-candidate matches below the confidence cutoff
//
// Match rules (in order, highest confidence first):
//   1. Exact amount + same date + same sign (in/out)
//   2. Exact amount + date within ±3 days
//   3. Amount within 0.5% tolerance + date within ±3 days
//   4. Aggregated-amount match: one statement row ≈ sum of N JVs
//
// Also supports a lightweight CSV parser (header-row aware).
// ─────────────────────────────────────────────────────────────────────────────

import { round2, totalOf } from './schema.js';

/**
 * @typedef {Object} StatementRow
 * @property {string} date        // YYYY-MM-DD
 * @property {number} amount      // positive
 * @property {'debit'|'credit'} direction   // 'debit' = money out of our bank
 * @property {string} [description]
 * @property {string} [ref]       // UTR / cheque no
 */

/**
 * @typedef {Object} JEEntry
 * @property {string} id
 * @property {string} date
 * @property {string} [voucher_no]
 * @property {string} [narration]
 * @property {Array<{debitAccount:string, creditAccount:string, amount:number}>} entries
 */

const MS_PER_DAY = 86_400_000;
const parseISO = (s) => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};
const daysBetween = (a, b) => Math.round(Math.abs((parseISO(a) - parseISO(b)) / MS_PER_DAY));

/**
 * Is this JV line involving the bank on the same `direction` as the statement?
 * direction='debit' (money out) ⇒ Bank is credited in the JV.
 * direction='credit' (money in) ⇒ Bank is debited in the JV.
 */
function jeMatchesDirection(je, direction) {
  const lines = je?.entries || [];
  return lines.some((l) => {
    const drIsBank = /^bank\b/i.test(l.debitAccount || '');
    const crIsBank = /^bank\b/i.test(l.creditAccount || '');
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
 */
function scorePair(row, je) {
  if (!jeMatchesDirection(je, row.direction)) return 0;
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
 * @param {{minConfidence?: number, learnedMatches?: Array<{row:StatementRow, journal_entry_id?:string}>}} [opts]
 */
export function reconcile(rows, journalEntries, opts = {}) {
  const minConfidence = opts.minConfidence ?? 60;
  const learnedIndex = buildLearnedIndex(opts.learnedMatches);
  const usedJE = new Set();
  const usedRow = new Set();
  const matches = [];
  const suggestions = [];

  // Build score grid, keep only plausible candidates.
  const cands = [];
  rows.forEach((row, ri) => {
    journalEntries.forEach((je) => {
      const base = scorePair(row, je);
      if (base <= 0) return;
      const boost = learnedBoost(row, je, learnedIndex);
      const score = Math.min(100, round2(base + boost));
      cands.push({ ri, jeId: je.id, score, base, boost, row, je });
    });
  });
  cands.sort((a, b) => b.score - a.score);

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
      jeMatchesDirection(je, row.direction) &&
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

// ── CSV parsing (minimal; no quoted-embedded-newline support) ───────────────
/**
 * Parse a bank CSV where headers exist. Auto-detects common column names for
 * date / credit / debit / amount / description / reference.
 * @param {string} csv
 * @returns {StatementRow[]}
 */
export function parseStatementCSV(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCSV(lines[0]).map((h) => h.toLowerCase().trim());
  const idxDate  = findCol(header, ['date', 'txn date', 'transaction date', 'value date']);
  const idxDesc  = findCol(header, ['description', 'narration', 'particulars', 'details']);
  const idxRef   = findCol(header, ['ref', 'reference', 'utr', 'cheque', 'chq no', 'chq. no']);
  const idxDebit = findCol(header, ['debit', 'withdrawal', 'withdrawal amt', 'dr']);
  const idxCred  = findCol(header, ['credit', 'deposit', 'deposit amt', 'cr']);
  const idxAmt   = findCol(header, ['amount', 'amt', 'transaction amount']);
  const idxType  = findCol(header, ['type', 'dr/cr', 'cr/dr']);

  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCSV(lines[i]);
    const date = normaliseDate(cols[idxDate]);
    if (!date) continue;
    const desc = cols[idxDesc] || '';
    const ref  = cols[idxRef] || '';
    let amount = 0;
    let direction = null;
    if (idxDebit >= 0 && idxCred >= 0) {
      const dr = Number((cols[idxDebit] || '0').replace(/[,\s]/g, '')) || 0;
      const cr = Number((cols[idxCred] || '0').replace(/[,\s]/g, '')) || 0;
      if (dr > 0) { amount = dr; direction = 'debit'; }
      else if (cr > 0) { amount = cr; direction = 'credit'; }
    } else if (idxAmt >= 0) {
      amount = Number((cols[idxAmt] || '0').replace(/[,\s]/g, '')) || 0;
      if (idxType >= 0) {
        const t = (cols[idxType] || '').toLowerCase();
        direction = /cr/.test(t) ? 'credit' : 'debit';
      } else {
        direction = amount < 0 ? 'debit' : 'credit';
        amount = Math.abs(amount);
      }
    }
    if (amount <= 0 || !direction) continue;
    out.push({ date, amount: round2(amount), direction, description: desc, ref });
  }
  return out;
}

function splitCSV(line) {
  // Handles simple quoted fields
  const out = [];
  let buf = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function findCol(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function normaliseDate(s) {
  if (!s) return '';
  const str = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // DD/MM/YYYY or DD-MM-YYYY
  const m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
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
