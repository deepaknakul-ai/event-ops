// ─────────────────────────────────────────────────────────────────────────────
// Multi-agent Virtual Accountant — Main Orchestrator + Audit Agent (Phase 1).
//
// The "Accounting Agent" already exists: the rules engine (parseMessage) and the
// LLM escalation (aiExtractEntry) both emit canonical `Transaction` drafts. This
// module adds the two missing agents as PURE, deterministic functions so the whole
// pipeline is unit-testable and needs no Anthropic key to verify:
//
//   • Audit Agent  (runAuditAgent)  — wraps the existing `validateTransaction`
//     (which already returns severity-tagged issues) and maps them to the spec's
//     blocking / warning / advisory taxonomy, adds a couple of audit-only checks,
//     and scores each draft.
//   • Orchestrator (runOrchestrator) — consults the Accounting Agent's drafts, runs
//     the Audit Agent per draft, computes an overall risk score, and returns a final
//     decision (approve / flag / human-review) plus a persistable AgentDecisionTrace.
//
// The Process-Analyst Agent's learning/metrics live in a later slice; here the
// Orchestrator only EMITS the trace (`created_by_agent`, per-draft audit records)
// that the Analyst will later mine. Traces persist via the existing single AI
// write path (postParsedEntry) as an `ai_decision_trace` field.
// ─────────────────────────────────────────────────────────────────────────────
import { validateTransaction, canPost } from './validator.js';

export const POLICY_VERSION = 'audit-v1';

/**
 * @typedef {{ severity:'blocking'|'warning'|'advisory', code:string, message:string, fix?:string }} AuditFinding
 * @typedef {{ findings:AuditFinding[], auditScore:number, blocking:boolean, postable:boolean }} AuditResult
 */

// validateTransaction's issue.level → the spec's severity taxonomy.
const SEVERITY_BY_LEVEL = { error: 'blocking', warning: 'warning', info: 'advisory' };

// Plain-language "how to fix" hints, keyed by the validator/compliance issue codes.
const FIX_HINTS = {
  no_tx: 'The message did not resolve to a transaction — rephrase it.',
  no_entries: 'Add at least one debit/credit line.',
  bad_date: 'Use a valid date (YYYY-MM-DD).',
  missing_dr: 'Set a debit account.',
  missing_cr: 'Set a credit account.',
  same_account: 'Debit and credit accounts must differ.',
  bad_amount: 'Amount must be a positive number.',
  zero_total: 'The entry total must be greater than zero.',
  fy_locked: 'This financial year is closed — post in an open FY or reopen it.',
  unknown_party: 'Pick or confirm the party (client / vendor / employee).',
  placeholder_party: 'Replace the placeholder party name with a real one.',
  possible_duplicate: 'A similar entry exists recently — confirm this is not a duplicate.',
  gst_math_mismatch: 'GST amount does not match taxable × rate.',
  income_debited: 'Income is normally credited — check the entry direction.',
  expense_credited: 'Expense is normally debited — check the entry direction.',
  advance_as_expense: 'This looks like an advance, not an expense.',
  maybe_capital: 'Large asset-like spend — consider capitalising instead of expensing.',
  bad_gstin: 'The GSTIN looks invalid.',
  tds_applies: 'TDS may apply — consider deducting under the flagged section.',
  cash_cap_breached: 'Cash payment exceeds the ₹10,000/day limit (Sec 40A(3)).',
  contra_unresolved: 'The contra account is unresolved (Suspense) — set the correct account.',
  missing_narration: 'Add a short narration for the audit trail.',
};

const SEVERITY_PENALTY = { blocking: 40, warning: 12, advisory: 3 };

/**
 * Audit Agent — deterministic. Runs the existing validator, maps its issues to
 * findings, adds audit-only advisories, and scores the draft (100 − penalties).
 * @param {object} txn  a canonical Transaction draft
 * @param {object} ctx  ValidatorContext { knownAccounts, closedFYs, getFY, recentJournalEntries, partyGstin, tdsSection, ... }
 * @returns {AuditResult}
 */
/**
 * Build findings + score from a Transaction that ALREADY carries validator issues
 * (i.e. was validated at parse time). Lets the chat UI + the persist path render
 * the Audit Agent's output without re-running validateTransaction.
 * @param {object} txn  a validated Transaction (has `issues`)
 * @returns {{ findings:AuditFinding[], auditScore:number, blocking:boolean }}
 */
export function auditFromIssues(txn) {
  const issues = Array.isArray(txn?.issues) ? txn.issues : [];
  const findings = issues.map((iss) => ({
    severity: SEVERITY_BY_LEVEL[iss.level] || 'advisory',
    code: iss.code,
    message: iss.message,
    ...(FIX_HINTS[iss.code] ? { fix: FIX_HINTS[iss.code] } : {}),
  }));
  // Audit-only advisory not covered by the validator: missing narration.
  if (!String(txn?.narration || '').trim()) {
    findings.push({ severity: 'advisory', code: 'missing_narration', message: 'No narration provided.', fix: FIX_HINTS.missing_narration });
  }
  const auditScore = Math.max(0, 100 - findings.reduce((s, f) => s + (SEVERITY_PENALTY[f.severity] || 0), 0));
  const blocking = findings.some((f) => f.severity === 'blocking');
  return { findings, auditScore, blocking };
}

/**
 * Audit Agent — deterministic. Validates then scores. `postable` uses the same
 * canPost gate the UI uses (entries present, no error-level issue, non-control intent).
 * @returns {AuditResult}
 */
export function runAuditAgent(txn, ctx = {}) {
  const validated = validateTransaction(txn, ctx);
  return { ...auditFromIssues(validated), postable: canPost(validated) };
}

/** Concise human-facing summary of the batch decision. */
function buildExplanation(results) {
  if (!results.length) return 'No entries were proposed.';
  const approved = results.filter((r) => r.status === 'approved').length;
  const flagged = results.length - approved;
  const codes = [...new Set(results.flatMap((r) => r.findings.filter((f) => f.severity !== 'advisory').map((f) => f.code)))];
  const parts = [`${results.length} draft${results.length === 1 ? '' : 's'}: ${approved} ready, ${flagged} need${flagged === 1 ? 's' : ''} review`];
  if (codes.length) parts.push(`flags: ${codes.join(', ')}`);
  return parts.join(' — ');
}

/**
 * Main Orchestrator. Given the Accounting Agent's draft(s), audits each, scores
 * overall risk, and returns the final decision + a persistable AgentDecisionTrace.
 * A draft is auto-"approved" (safe for one-click posting) only when it is postable,
 * carries no blocking finding, clears the audit-score bar, and meets min confidence;
 * otherwise it is "flagged" for human review/clarification.
 *
 * @param {{ text?:string, drafts?:object[], ctx?:object, modelVersion?:string, reviewThreshold?:number, minConfidence?:number }} args
 * @returns {{ approved:object[], flagged:object[], risk_score:number, requires_human_review:boolean, decision:'approved'|'partial'|'review', explanation:string, trace:object }}
 */
export function runOrchestrator({ text = '', drafts = [], ctx = {}, modelVersion = 'rule-v1', reviewThreshold = 70, minConfidence = 0.55 } = {}) {
  const list = Array.isArray(drafts) ? drafts.filter(Boolean) : [];
  const results = list.map((txn, i) => {
    const audit = runAuditAgent(txn, ctx);
    const confidence = typeof txn?.confidence === 'number' ? txn.confidence : 1;
    const safe = audit.postable && !audit.blocking && audit.auditScore >= reviewThreshold && confidence >= minConfidence;
    return { draftIndex: i, txn, ...audit, confidence, status: safe ? 'approved' : 'flagged' };
  });

  const approved = results.filter((r) => r.status === 'approved');
  const flagged = results.filter((r) => r.status === 'flagged');
  const risk_score = results.length
    ? Math.round(results.reduce((s, r) => s + (100 - r.auditScore), 0) / results.length)
    : 0;
  const requires_human_review = flagged.length > 0;
  const decision = !requires_human_review ? 'approved' : (approved.length ? 'partial' : 'review');
  const explanation = buildExplanation(results);

  const trace = {
    source_text: text,
    normalized_text: String(text || '').trim().replace(/\s+/g, ' ').toLowerCase(),
    draft_count: list.length,
    audits: results.map((r) => ({
      draftIndex: r.draftIndex,
      intent: r.txn?.intent || r.txn?.type || null,
      confidence: r.confidence,
      findings: r.findings,
      auditScore: r.auditScore,
      blocking: r.blocking,
      status: r.status,
    })),
    risk_score,
    requires_human_review,
    decision,
    explanation,
    policy_version: POLICY_VERSION,
    model_version: modelVersion,
    created_by_agent: 'orchestrator',
  };

  return { approved, flagged, risk_score, requires_human_review, decision, explanation, trace };
}
