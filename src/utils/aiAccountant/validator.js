// ─────────────────────────────────────────────────────────────────────────────
// Validator: runs a parsed Transaction through safety checks before it can
// be posted. Returns an enriched Transaction with an `issues` array.
// Pure: no Firestore I/O. Needs caller-supplied context (existing COA,
// recent journal entries for duplicate detection, FY lock list).
// ─────────────────────────────────────────────────────────────────────────────

import { round2, totalOf, inferAccountMeta } from './schema.js';
import { runComplianceChecks } from './compliance.js';

// Account-name patterns that look like a capitalisable fixed asset — used for the
// capital-vs-revenue hint when a large "purchase" is booked straight to expense.
const CAPITAL_ASSET_RE = /\b(laptop|computer|server|printer|camera|lens|projector|led\s*wall|console|mixer|vehicle|car|truck|machine|machinery|generator|furniture|equipment|building|land)\b/i;

/**
 * @typedef {Object} ValidatorContext
 * @property {string[]}  [knownAccounts]       // names present in current COA
 * @property {string[]}  [closedFYs]           // FY labels like '2024-25'
 * @property {Array<{date?:string, voucher_no?:string, entries?:any[], rawPrompt?:string, source?:string, narration?:string}>} [recentJournalEntries]
 * @property {(dateStr: string) => string} [getFY]   // maps YYYY-MM-DD → FY label
 * @property {number}    [duplicateWindowMs]   // default 60000
 */

/**
 * @param {import('./schema.js').Transaction} tx
 * @param {ValidatorContext} [ctx]
 * @returns {import('./schema.js').Transaction}
 */
export function validateTransaction(tx, ctx = {}) {
  const issues = [...(tx.issues || [])];

  // ── 1. Structural sanity ───────────────────────────────────────────────────
  if (!tx || typeof tx !== 'object') {
    return { ...(tx || {}), issues: [{ level: 'error', code: 'no_tx', message: 'No transaction to validate' }] };
  }

  // Control intents (reversal, query) skip most bookkeeping checks — they are
  // dispatched to special handlers rather than posted as a journal voucher.
  const controlIntents = new Set(['reversal', 'query', 'clarify']);
  if (controlIntents.has(tx.intent || tx.type)) {
    return { ...tx, issues };
  }

  if (!tx.date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) {
    issues.push({ level: 'error', code: 'bad_date', message: 'Missing or invalid date (expected YYYY-MM-DD)' });
  }
  if (!Array.isArray(tx.entries) || tx.entries.length === 0) {
    issues.push({ level: 'error', code: 'no_entries', message: 'Transaction has no journal lines' });
  }

  // ── 2. Per-line checks ─────────────────────────────────────────────────────
  (tx.entries || []).forEach((line, i) => {
    if (!line.debitAccount) issues.push({ level: 'error', code: 'missing_dr', message: `Line ${i + 1}: debit account missing` });
    if (!line.creditAccount) issues.push({ level: 'error', code: 'missing_cr', message: `Line ${i + 1}: credit account missing` });
    if (line.debitAccount && line.creditAccount && line.debitAccount === line.creditAccount) {
      issues.push({ level: 'error', code: 'same_account', message: `Line ${i + 1}: debit and credit are the same account` });
    }
    const amt = Number(line.amount);
    if (!isFinite(amt) || amt <= 0) {
      issues.push({ level: 'error', code: 'bad_amount', message: `Line ${i + 1}: amount must be a positive number` });
    }
  });

  // ── 3. Double-entry balance check ─────────────────────────────────────────
  // Each line is itself balanced by schema (dr & cr of same amount), but we
  // still guard against rounding drift if a caller edits values.
  const total = totalOf(tx.entries || []);
  if (total <= 0 && (tx.entries || []).length > 0) {
    issues.push({ level: 'error', code: 'zero_total', message: 'Transaction total is zero' });
  }

  // ── 4. FY lock ─────────────────────────────────────────────────────────────
  if (tx.date && ctx.getFY && Array.isArray(ctx.closedFYs)) {
    const fy = ctx.getFY(tx.date);
    if (fy && ctx.closedFYs.includes(fy)) {
      issues.push({ level: 'error', code: 'fy_locked', message: `Financial year ${fy} is closed. Cannot post to a locked FY.` });
    }
  }

  // ── 5. Unknown accounts → warning (the executor will auto-create) ─────────
  if (Array.isArray(ctx.knownAccounts)) {
    const known = new Set(ctx.knownAccounts);
    const toCreate = (tx.accountCreates || []).filter(a => !known.has(a.name));
    toCreate.forEach(a => {
      issues.push({
        level: 'info',
        code: 'account_will_be_created',
        message: `Will create new account: "${a.name}" (${a.type}, normal ${a.normalSide})`,
      });
    });
  }

  // ── 6. Unresolved party → warning ─────────────────────────────────────────
  if (tx.party && tx.party.type === 'unknown') {
    issues.push({ level: 'warning', code: 'unknown_party', message: 'Party is not linked to any client/vendor/employee record.' });
  }
  if (tx.party && /unknown\s+(client|vendor|party)/i.test(tx.party.name || '')) {
    issues.push({ level: 'warning', code: 'placeholder_party', message: 'Party name looks like a placeholder — specify a real name before posting.' });
  }

  // ── 7. Duplicate detection ─────────────────────────────────────────────────
  const windowMs = ctx.duplicateWindowMs ?? 60_000;
  if (Array.isArray(ctx.recentJournalEntries) && ctx.recentJournalEntries.length && tx.entries?.length) {
    const txTotal = totalOf(tx.entries);
    const txSig = signature(tx);
    const now = Date.now();
    const dup = ctx.recentJournalEntries.find((r) => {
      if (!r || r.source === 'fy_closing') return false;
      const rTotal = Array.isArray(r.entries) ? totalOf(r.entries) : 0;
      if (Math.abs(rTotal - txTotal) > 0.5) return false;
      const rSig = signature({ entries: r.entries, date: r.date });
      if (rSig !== txSig) return false;
      // Only flag if also recent (within window)
      const ts = Date.parse(r.created_at || r.date || '') || 0;
      return ts && now - ts < windowMs;
    });
    if (dup) {
      issues.push({
        level: 'warning',
        code: 'possible_duplicate',
        message: `Similar entry posted ${Math.round((now - (Date.parse(dup.created_at || dup.date || '') || now)) / 1000)}s ago (voucher ${dup.voucher_no || '?'}).`,
      });
    }
  }

  // ── 7b. Accounting-standards guardrails ───────────────────────────────────
  const intent = tx.intent || tx.type;

  // GST math: the tax must match the taxable × rate (within a small tolerance).
  const meta = tx.meta || {};
  if (meta.gstRate > 0 && meta.taxable > 0 && typeof meta.gst === 'number') {
    const expected = round2((meta.taxable * meta.gstRate) / 100);
    const tol = Math.max(1, round2(meta.taxable * 0.005));
    if (Math.abs(expected - meta.gst) > tol) {
      issues.push({
        level: 'warning',
        code: 'gst_math_mismatch',
        message: `GST ${meta.gst} doesn't match ${meta.gstRate}% of ${meta.taxable} (expected ≈ ${expected}).`,
      });
    }
  }

  // Sign conventions: an Income account is normally credited and an Expense
  // account normally debited. Flag the reverse unless it's a return/reversal.
  const incomeDebitOk = new Set(['credit_note', 'reversal']);
  const expenseCreditOk = new Set(['debit_note', 'reversal']);
  (tx.entries || []).forEach((line, i) => {
    if (!line.debitAccount || !line.creditAccount) return;
    const drType = inferAccountMeta(line.debitAccount).type;
    const crType = inferAccountMeta(line.creditAccount).type;
    if (drType === 'Income' && !incomeDebitOk.has(intent)) {
      issues.push({ level: 'warning', code: 'income_debited', message: `Line ${i + 1}: an Income account ("${line.debitAccount}") is being debited — unusual outside a sales return/credit note.` });
    }
    if (crType === 'Expense' && !expenseCreditOk.has(intent)) {
      issues.push({ level: 'warning', code: 'expense_credited', message: `Line ${i + 1}: an Expense account ("${line.creditAccount}") is being credited — unusual outside a purchase return/debit note.` });
    }
  });

  // Advance must be an asset, not an expense.
  if (intent === 'advance') {
    const badLine = (tx.entries || []).find((l) => /expense/i.test(l.debitAccount || ''));
    if (badLine) {
      issues.push({ level: 'warning', code: 'advance_as_expense', message: 'An employee advance is an asset (Employee Advances), not an expense — review the debit account.' });
    }
  }

  // Capital-vs-revenue: a large purchase/expense that names a fixed asset should
  // likely be capitalised rather than expensed.
  if ((intent === 'purchase' || intent === 'expense') && CAPITAL_ASSET_RE.test(tx.rawPrompt || '')) {
    const total = totalOf(tx.entries || []);
    const toExpense = (tx.entries || []).some((l) => inferAccountMeta(l.debitAccount || '').type === 'Expense');
    if (total >= 50000 && toExpense) {
      issues.push({ level: 'info', code: 'maybe_capital', message: 'This looks like a fixed asset (₹' + total + '). Consider capitalising it instead of expensing.' });
    }
  }

  // ── 8. Compliance checks (GSTIN, TDS, round-off, cash cap, duplicates) ─────
  // All of these are opt-in via ctx keys; runComplianceChecks no-ops gracefully
  // when the relevant ctx field is missing.
  let complianceIssues = runComplianceChecks(tx, {
    history: ctx.recentJournalEntries,
    partyGstin: ctx.partyGstin,
    section: ctx.tdsSection,
    ytdAmount: ctx.tdsYtdAmount,
    roundOff: ctx.skipRoundOff ? false : true,
  });
  // The Sec 40A(3) cash cap applies only to cash payments to a payee — drop it
  // for inflows and tax-deposits to avoid false positives on receipts etc.
  const CASH_CAP_INTENTS = new Set(['payment', 'expense', 'purchase', 'rent', 'salary', 'advance']);
  if (!CASH_CAP_INTENTS.has(intent)) {
    complianceIssues = complianceIssues.filter((i) => i.code !== 'cash_cap_breached');
  }
  issues.push(...complianceIssues);

  return { ...tx, issues };
}

/** Compact signature used for duplicate detection. */
function signature({ entries = [], date = '' } = {}) {
  const sorted = entries
    .map(e => `${e.debitAccount}|${e.creditAccount}|${round2(e.amount)}`)
    .sort()
    .join('||');
  return `${date}#${sorted}`;
}

/**
 * Convenience: true only if there are zero error-level issues.
 * @param {import('./schema.js').Transaction} tx
 */
export function canPost(tx) {
  const intent = tx?.intent || tx?.type;
  if (intent === 'reversal' || intent === 'query' || intent === 'clarify') return false;
  return Array.isArray(tx?.entries) && tx.entries.length > 0 &&
    !(tx.issues || []).some(i => i.level === 'error');
}

/**
 * True when a control intent (reversal / query) is ready to be dispatched.
 * @param {import('./schema.js').Transaction} tx
 */
export function canDispatch(tx) {
  if (!tx) return false;
  const intent = tx.intent || tx.type;
  if (intent !== 'reversal' && intent !== 'query') return false;
  return !(tx.issues || []).some(i => i.level === 'error');
}

/**
 * @param {import('./schema.js').Transaction} tx
 * @returns {{errors:number, warnings:number, infos:number}}
 */
export function issueSummary(tx) {
  const list = tx?.issues || [];
  return {
    errors:   list.filter(i => i.level === 'error').length,
    warnings: list.filter(i => i.level === 'warning').length,
    infos:    list.filter(i => i.level === 'info').length,
  };
}
