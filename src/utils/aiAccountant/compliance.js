// ─────────────────────────────────────────────────────────────────────────────
// Compliance & sanity checks: pure Indian-accounting conventions that
// augment the validator with warnings/errors beyond double-entry balance.
//
// Covers:
//   - GSTIN format validation (15-char, check digit)
//   - TDS threshold warnings (section-wise, FY-window)
//   - Duplicate-voucher detection by signature
//   - Round-off suggestion for odd-amount single-line entries
//   - Cash-payment cap (Section 40A(3): ₹10,000/day to same payee)
// ─────────────────────────────────────────────────────────────────────────────

import { round2, totalOf } from './schema.js';

// ── GSTIN ───────────────────────────────────────────────────────────────────
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
/**
 * Validate an Indian GSTIN structure + checksum.
 * Returns { ok, reason? }.
 * @param {string} gstin
 */
export function validateGSTIN(gstin) {
  if (!gstin) return { ok: false, reason: 'empty' };
  const g = gstin.trim().toUpperCase();
  if (g.length !== 15) return { ok: false, reason: 'length' };
  if (!GSTIN_RE.test(g)) return { ok: false, reason: 'format' };
  // Checksum algorithm (GSTN official)
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const FACTOR = [1, 2];
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const digit = CHARS.indexOf(g[i]);
    if (digit < 0) return { ok: false, reason: 'char' };
    const prod = digit * FACTOR[i % 2];
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  if (CHARS[check] !== g[14]) return { ok: false, reason: 'checksum' };
  return { ok: true };
}

// ── TDS thresholds (FY 2024-25 India, representative; not exhaustive) ───────
// amount: annual aggregate threshold; singleTxn: per-transaction threshold
export const TDS_THRESHOLDS = {
  '194C':  { label: 'Contractor',      annual: 100000, singleTxn: 30000, rate: 1 },
  '194J':  { label: 'Professional',    annual: 30000,  singleTxn: 30000, rate: 10 },
  '194I':  { label: 'Rent',            annual: 240000, singleTxn: 240000, rate: 10 },
  '194H':  { label: 'Commission',      annual: 15000,  singleTxn: 15000, rate: 5 },
  '194A':  { label: 'Interest',        annual: 40000,  singleTxn: 40000, rate: 10 },
  '194Q':  { label: 'Goods Purchase',  annual: 5000000, singleTxn: 5000000, rate: 0.1 },
};

/**
 * Given a transaction + history of amounts already paid to the same party this
 * FY under the same section, decide whether TDS applies.
 * @param {{amount: number, section?: string, ytdAmount?: number}} args
 * @returns {{applies:boolean, section?:string, rate?:number, reason?:string}}
 */
export function checkTDSApplicability({ amount, section, ytdAmount = 0 }) {
  if (!section) return { applies: false };
  const cfg = TDS_THRESHOLDS[section];
  if (!cfg) return { applies: false, reason: 'unknown_section' };
  const crossesSingle = amount >= cfg.singleTxn;
  const crossesAnnual = (ytdAmount + amount) >= cfg.annual;
  if (crossesSingle || crossesAnnual) {
    return {
      applies: true,
      section,
      rate: cfg.rate,
      reason: crossesSingle ? 'single_txn' : 'annual_cap',
    };
  }
  return { applies: false, section, rate: cfg.rate, reason: 'below_threshold' };
}

// ── Duplicate voucher (different from validator's 60-sec window) ────────────
/**
 * A stricter duplicate check: same date + same entry signature = duplicate,
 * regardless of age. Used to warn before posting a vendor bill twice.
 * @param {{date:string, entries:Array}} tx
 * @param {Array<{date?:string, entries?:any[], voucher_no?:string}>} history
 * @returns {{dup: boolean, voucher?: string}}
 */
export function detectDuplicateVoucher(tx, history) {
  if (!tx || !Array.isArray(tx.entries) || tx.entries.length === 0) return { dup: false };
  const sig = signature(tx);
  const hit = (history || []).find((h) => signature(h) === sig);
  return hit ? { dup: true, voucher: hit.voucher_no } : { dup: false };
}

function signature({ entries = [], date = '' } = {}) {
  return `${date}#${[...entries]
    .map((e) => `${e.debitAccount}|${e.creditAccount}|${round2(e.amount)}`)
    .sort()
    .join('||')}`;
}

// ── Round-off suggestion ────────────────────────────────────────────────────
/**
 * If a transaction has an odd rupee total (e.g. 1234.56) with a single line,
 * suggest a round-off line so the receivable/payable is a clean number.
 * @param {{entries: Array}} tx
 * @param {{to?: number}} [opts] -- `to`: nearest unit to round to (default 1)
 * @returns {{suggest:boolean, roundTo?:number, roundOff?:number}}
 */
export function suggestRoundOff(tx, { to = 1 } = {}) {
  const lines = tx?.entries || [];
  if (!lines.length) return { suggest: false };
  const total = totalOf(lines);
  const rounded = Math.round(total / to) * to;
  const diff = round2(rounded - total);
  if (Math.abs(diff) > 0.001 && Math.abs(diff) < 1) {
    return { suggest: true, roundTo: rounded, roundOff: diff };
  }
  return { suggest: false };
}

// ── Cash-payment cap (Sec 40A(3)) ───────────────────────────────────────────
/**
 * Flag when a single cash payment crosses ₹10k to the same payee in one day.
 * @param {{amount:number, mode:string, party?:{name?:string}, date?:string}} tx
 * @param {Array<{date?:string, mode?:string, party_name?:string, entries?:any[]}>} history
 */
export function checkCashCap(tx, history) {
  if (!tx || tx.mode !== 'Cash') return { over: false };
  const amt = totalOf(tx.entries || []) || tx.amount || 0;
  if (amt <= 0) return { over: false };
  const today = tx.date;
  const payee = (tx.party?.name || '').toLowerCase();
  const sameDayToPayee = (history || []).reduce((sum, h) => {
    if (!h || h.mode !== 'Cash' || h.date !== today) return sum;
    if ((h.party_name || '').toLowerCase() !== payee) return sum;
    return sum + (totalOf(h.entries || []) || 0);
  }, 0);
  const total = sameDayToPayee + amt;
  if (total >= 10000) {
    return { over: true, total, limit: 10000 };
  }
  return { over: false };
}

// ── Aggregator: turn all checks into validator issues ───────────────────────
/**
 * Run all compliance checks and return an array of issue objects ready to be
 * merged into `tx.issues`. Each check is independent; unsupported checks are
 * skipped silently.
 * @param {import('./schema.js').Transaction} tx
 * @param {{history?: Array, partyGstin?: string, section?: string, ytdAmount?: number, roundOff?: boolean}} [ctx]
 */
export function runComplianceChecks(tx, ctx = {}) {
  const issues = [];
  if (!tx) return issues;

  if (ctx.partyGstin) {
    const r = validateGSTIN(ctx.partyGstin);
    if (!r.ok) {
      issues.push({
        level: 'warning',
        code: 'bad_gstin',
        message: `GSTIN format invalid (${r.reason}): ${ctx.partyGstin}`,
      });
    }
  }

  if (ctx.section) {
    const amt = totalOf(tx.entries || []) || 0;
    const tds = checkTDSApplicability({ amount: amt, section: ctx.section, ytdAmount: ctx.ytdAmount });
    if (tds.applies) {
      issues.push({
        level: 'warning',
        code: 'tds_applies',
        message: `TDS u/s ${tds.section} applies @ ${tds.rate}% (reason: ${tds.reason}).`,
      });
    }
  }

  if (Array.isArray(ctx.history) && ctx.history.length) {
    const d = detectDuplicateVoucher(tx, ctx.history);
    if (d.dup) {
      issues.push({
        level: 'warning',
        code: 'duplicate_voucher',
        message: `Duplicate of voucher ${d.voucher || '?'} — same date, same entries.`,
      });
    }
  }

  if (ctx.roundOff !== false) {
    const r = suggestRoundOff(tx);
    if (r.suggest) {
      issues.push({
        level: 'info',
        code: 'round_off_suggest',
        message: `Tip: round total to ${r.roundTo} (add round-off ${r.roundOff >= 0 ? '+' : ''}${r.roundOff}).`,
      });
    }
  }

  if (Array.isArray(ctx.history)) {
    const cap = checkCashCap(tx, ctx.history);
    if (cap.over) {
      issues.push({
        level: 'warning',
        code: 'cash_cap_breached',
        message: `Cash payments to this payee today total ${cap.total} — Sec 40A(3) caps at ₹${cap.limit}.`,
      });
    }
  }

  return issues;
}
