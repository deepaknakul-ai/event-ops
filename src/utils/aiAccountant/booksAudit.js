// ─────────────────────────────────────────────────────────────────────────────
// Books Audit engine (Phase 2 of "Full Accountant"). PURE, deterministic — reviews
// the WHOLE posted ledger (not one draft) and returns categorized findings + a
// health score + a printable summary. Read-only: it never posts or mutates.
//
// runBooksAudit(snapshot, ctx) → { score, grade, findings[], summary }
//   snapshot = buildAccountingSnapshot output (trialBalance, ledger, balanceSheet…)
//   ctx      = { entries=[], drafts=[], ageing=null, closedFYs=[], asOn }
//
// Finding shape mirrors the orchestrator taxonomy so the UI reuses the same
// severity rendering: { severity:'blocking'|'warning'|'advisory', code, message, fix?, refs? }.
// ─────────────────────────────────────────────────────────────────────────────
import { round2 } from './schema.js';
import { analyzePostedEntries } from './analyst.js';

const SEVERITY_PENALTY = { blocking: 40, warning: 12, advisory: 3 };
const isAiEntry = (e) => e?.origin === 'ai_chat' || e?.source === 'chat_entry' || e?.source === 'scheduled_post';
const finding = (severity, code, message, extra = {}) => ({ severity, code, message, ...extra });

// A stable signature for book-wide duplicate detection.
function entrySignature(e) {
  const legs = (e.entries || [])
    .map((l) => `${l.debitAccount}>${l.creditAccount}=${round2(l.amount)}`)
    .sort()
    .join('|');
  return `${(e.date || '').slice(0, 10)}#${legs}`;
}

/**
 * @param {object} snapshot buildAccountingSnapshot output
 * @param {{ entries?:object[], drafts?:object[], ageing?:object, closedFYs?:string[], asOn?:string, staleDays?:number }} [ctx]
 */
export function runBooksAudit(snapshot = {}, ctx = {}) {
  const ledger = Array.isArray(snapshot.ledger) ? snapshot.ledger : [];
  const tb = snapshot.trialBalance || {};
  const bs = snapshot.balanceSheet || {};
  const entries = Array.isArray(ctx.entries) ? ctx.entries : [];
  const drafts = Array.isArray(ctx.drafts) ? ctx.drafts : [];
  const ageing = ctx.ageing || null;
  const closedFYs = new Set(Array.isArray(ctx.closedFYs) ? ctx.closedFYs : []);
  const findings = [];

  // 1. Trial balance must balance (double-entry integrity). Blocking.
  if (tb.isBalanced === false || Math.abs(tb.difference || 0) > 0.5) {
    findings.push(finding('blocking', 'trial_imbalance',
      `Trial balance is out by ${round2(Math.abs(tb.difference || 0))} (Dr ${round2(tb.totalDebit || 0)} vs Cr ${round2(tb.totalCredit || 0)}).`,
      { fix: 'Find the one-sided or mis-posted entry — the books cannot be trusted until this is zero.' }));
  }

  // 2. Suspense / unresolved accounts carrying a balance. Warning.
  ledger.filter((r) => /suspense|unresolved/i.test(r.account) && Math.abs(r.balance || 0) > 0.5)
    .forEach((r) => findings.push(finding('warning', 'suspense_balance',
      `${r.account} holds ${round2(Math.abs(r.balance))} — reclassify it to the correct account.`,
      { fix: 'Open the ledger and move each Suspense entry to its real account.', refs: [r.account] })));

  // 3. Negative cash / bank (a Cr balance on cash is impossible). Warning.
  ledger.filter((r) => /^(cash|bank)\b/i.test(r.account) && (r.balance || 0) < -0.5)
    .forEach((r) => findings.push(finding('warning', 'negative_cash',
      `${r.account} shows a negative (Cr) balance of ${round2(Math.abs(r.balance))} — cash/bank can't go below zero.`,
      { fix: 'A payment was likely booked before its receipt, or an account is mis-mapped.', refs: [r.account] })));

  // 4. Book-wide exact duplicate vouchers (same date + same legs + same amount). Warning.
  const bySig = new Map();
  entries.forEach((e) => {
    const sig = entrySignature(e);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(e.voucher_no || e.id);
  });
  [...bySig.values()].filter((g) => g.length > 1).forEach((g) => findings.push(finding('warning', 'duplicate_voucher',
    `${g.length} identical entries posted (same date, accounts and amount): ${g.slice(0, 4).join(', ')}${g.length > 4 ? '…' : ''}.`,
    { fix: 'Confirm this is not a double entry; reverse the extra voucher if it is.', refs: g })));

  // 5. GST payable outstanding — file/deposit reminder. Advisory.
  const gstPayable = round2(bs.liabilities?.gstPayable || 0);
  if (gstPayable > 1) {
    findings.push(finding('advisory', 'gst_outstanding',
      `GST payable of ${gstPayable} is outstanding — confirm the return is filed and the tax deposited.`,
      { fix: 'File GSTR-3B and deposit by the 20th of next month.' }));
  }

  // 6. TDS payable outstanding — deposit reminder. Advisory.
  const tdsRow = ledger.find((r) => r.account === 'TDS Payable');
  const tdsPayable = tdsRow ? round2(Math.abs(Math.min(tdsRow.balance || 0, 0))) : 0;
  if (tdsPayable > 1) {
    findings.push(finding('advisory', 'tds_outstanding',
      `TDS of ${tdsPayable} has been deducted but not yet deposited.`,
      { fix: 'Deposit TDS by the 7th of next month to avoid interest.' }));
  }

  // 7 & 8. Stale receivables / payables (90+ days) from the ageing analysis.
  if (ageing) {
    (ageing.receivable || []).filter((r) => (r['90_plus'] || 0) > 1).forEach((r) => findings.push(finding('warning', 'stale_receivable',
      `${r.name} owes ${round2(r['90_plus'])} overdue 90+ days — follow up or provide for it.`, { refs: [r.account] })));
    (ageing.payable || []).filter((r) => (r['90_plus'] || 0) > 1).forEach((r) => findings.push(finding('advisory', 'stale_payable',
      `${round2(r['90_plus'])} owed to ${r.name} is 90+ days old — clear it or reconcile.`, { refs: [r.account] })));
  }

  // 9. Posted entries with no narration (audit-trail hygiene). Advisory (once, with count).
  const noNarr = entries.filter((e) => !String(e.narration || '').trim());
  if (noNarr.length) {
    findings.push(finding('advisory', 'missing_narration',
      `${noNarr.length} posted entr${noNarr.length === 1 ? 'y has' : 'ies have'} no narration.`,
      { fix: 'Add a short narration to each for a clean audit trail.', refs: noNarr.slice(0, 6).map((e) => e.voucher_no || e.id) }));
  }

  // 10. AI-created entries not yet reviewed/signed-off. Advisory.
  const unreviewedAi = entries.filter((e) => isAiEntry(e) && !e.ai_reviewed);
  if (unreviewedAi.length) {
    findings.push(finding('advisory', 'unreviewed_ai',
      `${unreviewedAi.length} AI-created entr${unreviewedAi.length === 1 ? 'y is' : 'ies are'} unreviewed.`,
      { fix: 'Review them in Accounts → AI Entries and mark reviewed.' }));
  }

  // 11. Unposted drafts sitting in the queue. Advisory.
  if (drafts.length) {
    findings.push(finding('advisory', 'unposted_drafts',
      `${drafts.length} draft${drafts.length === 1 ? '' : 's'} not yet posted.`,
      { fix: 'Post or discard them so the books are complete.' }));
  }

  // 12. Entries dated inside a closed financial year. Warning.
  const inClosed = entries.filter((e) => {
    const fy = e.fy || null;
    return fy && closedFYs.has(fy);
  });
  if (inClosed.length) {
    findings.push(finding('warning', 'closed_fy_entry',
      `${inClosed.length} entr${inClosed.length === 1 ? 'y is' : 'ies are'} dated in a closed financial year.`,
      { fix: 'A closed FY should not receive new postings — review and reverse if needed.', refs: inClosed.slice(0, 6).map((e) => e.voucher_no || e.id) }));
  }

  // ── Score & grade ──
  const rawPenalty = findings.reduce((s, f) => s + (SEVERITY_PENALTY[f.severity] || 0), 0);
  const score = Math.max(0, Math.min(100, 100 - rawPenalty));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  const bySeverity = { blocking: 0, warning: 0, advisory: 0 };
  findings.forEach((f) => { bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1; });

  // Fold the Process-Analyst health stats into the summary (read-only).
  const health = entries.length ? analyzePostedEntries(entries.filter(isAiEntry)).health : null;

  const summary = {
    total: findings.length,
    bySeverity,
    postingsChecked: entries.length,
    trialBalanced: tb.isBalanced !== false && Math.abs(tb.difference || 0) <= 0.5,
    health,
    headline: findings.length === 0
      ? 'Books look clean — no issues found.'
      : `${bySeverity.blocking} blocking · ${bySeverity.warning} warning · ${bySeverity.advisory} advisory.`,
  };

  return { score, grade, findings, summary };
}
