import { describe, it, expect } from 'vitest';
import { runAuditAgent, runOrchestrator, auditFromIssues, POLICY_VERSION } from '../src/utils/aiAccountant/orchestrator.js';
import { parseMessage } from '../src/utils/aiAccountant/index.js';

// A structurally-clean expense draft (the Accounting Agent's canonical Transaction).
const cleanExpense = (over = {}) => ({
  intent: 'expense', date: '2026-05-01', narration: 'Site fuel',
  entries: [{ debitAccount: 'Site Power & Fuel', creditAccount: 'Cash', amount: 5000 }],
  party: { type: 'internal', name: '' }, mode: 'Cash', confidence: 0.85,
  accountCreates: [], issues: [], ...over,
});

describe('runAuditAgent (deterministic Audit Agent)', () => {
  it('passes a clean expense — no blocking finding, high score, postable', () => {
    const r = runAuditAgent(cleanExpense());
    expect(r.blocking).toBe(false);
    expect(r.postable).toBe(true);
    expect(r.auditScore).toBeGreaterThanOrEqual(90);
  });

  it('maps a zero/invalid amount to a BLOCKING finding (not postable)', () => {
    const r = runAuditAgent(cleanExpense({ entries: [{ debitAccount: 'Fuel', creditAccount: 'Cash', amount: 0 }] }));
    expect(r.blocking).toBe(true);
    expect(r.postable).toBe(false);
    expect(r.findings.some((f) => f.severity === 'blocking')).toBe(true);
  });

  it('flags a closed financial year as blocking (fy_locked)', () => {
    const r = runAuditAgent(cleanExpense(), { getFY: () => '2025-26', closedFYs: ['2025-26'] });
    expect(r.findings.some((f) => f.code === 'fy_locked' && f.severity === 'blocking')).toBe(true);
    expect(r.blocking).toBe(true);
  });

  it('adds a missing-narration advisory (non-blocking)', () => {
    const r = runAuditAgent(cleanExpense({ narration: '' }));
    expect(r.findings.some((f) => f.code === 'missing_narration' && f.severity === 'advisory')).toBe(true);
    expect(r.blocking).toBe(false);
  });

  it('maps validator issues to the blocking/warning/advisory taxonomy with fix hints', () => {
    const r = runAuditAgent(cleanExpense({ entries: [{ debitAccount: 'A', creditAccount: 'A', amount: 100 }] }));
    const same = r.findings.find((f) => f.code === 'same_account');
    expect(same).toBeTruthy();
    expect(same.severity).toBe('blocking'); // validator level 'error' → blocking
    expect(same.fix).toBeTruthy();
  });
});

describe('auditFromIssues (UI/persist path — no re-validation)', () => {
  it('scores a clean draft from its issues without a validator ctx', () => {
    const r = auditFromIssues(cleanExpense());
    expect(r.blocking).toBe(false);
    expect(r.auditScore).toBeGreaterThanOrEqual(90);
    expect(Array.isArray(r.findings)).toBe(true);
  });

  it('maps an already-attached error issue to a blocking finding with a fix hint', () => {
    const r = auditFromIssues(cleanExpense({ issues: [{ level: 'error', code: 'same_account', message: 'Dr = Cr' }] }));
    const f = r.findings.find((x) => x.code === 'same_account');
    expect(f.severity).toBe('blocking');
    expect(f.fix).toBeTruthy();
    expect(r.blocking).toBe(true);
  });

  it('adds the missing-narration advisory when narration is blank', () => {
    const r = auditFromIssues(cleanExpense({ narration: '', issues: [] }));
    expect(r.findings.some((f) => f.code === 'missing_narration' && f.severity === 'advisory')).toBe(true);
    expect(r.blocking).toBe(false);
  });

  it('matches runAuditAgent output for an already-validated draft (same findings/score)', () => {
    const txn = cleanExpense();
    const viaAgent = runAuditAgent(txn); // validates (no issues added) then scores
    const viaIssues = auditFromIssues(txn);
    expect(viaIssues.auditScore).toBe(viaAgent.auditScore);
    expect(viaIssues.findings).toEqual(viaAgent.findings);
  });
});

describe('runOrchestrator (Main Orchestrator)', () => {
  it('approves a single safe draft with no human review and low risk', () => {
    const out = runOrchestrator({ text: 'site fuel 5000', drafts: [cleanExpense()] });
    expect(out.approved).toHaveLength(1);
    expect(out.flagged).toHaveLength(0);
    expect(out.requires_human_review).toBe(false);
    expect(out.decision).toBe('approved');
    expect(out.risk_score).toBeLessThan(30);
  });

  it('flags a draft with a blocking finding for human review', () => {
    const out = runOrchestrator({ text: 'bad', drafts: [cleanExpense({ entries: [{ debitAccount: 'X', creditAccount: 'Y', amount: 0 }] })] });
    expect(out.flagged).toHaveLength(1);
    expect(out.requires_human_review).toBe(true);
    expect(out.decision).toBe('review');
  });

  it('flags a low-confidence draft even when audit-clean', () => {
    const out = runOrchestrator({ text: 'x', drafts: [cleanExpense({ confidence: 0.3 })] });
    expect(out.flagged).toHaveLength(1);
    expect(out.requires_human_review).toBe(true);
  });

  it('returns "partial" when some drafts are safe and some are not', () => {
    const out = runOrchestrator({ text: 'batch', drafts: [cleanExpense(), cleanExpense({ entries: [{ debitAccount: 'X', creditAccount: 'Y', amount: 0 }] })] });
    expect(out.approved).toHaveLength(1);
    expect(out.flagged).toHaveLength(1);
    expect(out.decision).toBe('partial');
  });

  it('emits a persistable AgentDecisionTrace', () => {
    const out = runOrchestrator({ text: 'Site Fuel 5000', drafts: [cleanExpense()], modelVersion: 'rule-v1' });
    expect(out.trace).toMatchObject({
      source_text: 'Site Fuel 5000',
      normalized_text: 'site fuel 5000',
      draft_count: 1,
      policy_version: POLICY_VERSION,
      model_version: 'rule-v1',
      created_by_agent: 'orchestrator',
    });
    expect(out.trace.audits[0]).toHaveProperty('auditScore');
    expect(out.trace.audits[0]).toHaveProperty('findings');
  });

  it('handles an empty batch safely', () => {
    const out = runOrchestrator({ text: '', drafts: [] });
    expect(out.approved).toHaveLength(0);
    expect(out.flagged).toHaveLength(0);
    expect(out.requires_human_review).toBe(false);
    expect(out.risk_score).toBe(0);
  });
});

describe('Accounting Agent → Orchestrator pipeline (real parseMessage output)', () => {
  it('parses "600 paid for food" to a Food Expense and audits it with no blocking finding', () => {
    const draft = parseMessage('600 paid for food');
    expect(draft).toBeTruthy();
    expect(draft.entries[0]).toMatchObject({ debitAccount: 'Food Expense', creditAccount: 'Cash', amount: 600 });
    const out = runOrchestrator({ text: '600 paid for food', drafts: [draft], modelVersion: draft.model });
    expect(out.approved.length + out.flagged.length).toBe(1);
    expect(out.trace.audits[0].findings.every((f) => f.severity !== 'blocking')).toBe(true);
  });

  it('parses "7000 paid for booking flight ticket" to Travelling & Conveyance', () => {
    const draft = parseMessage('7000 paid for booking flight ticket');
    expect(draft.entries[0]).toMatchObject({ debitAccount: 'Travelling & Conveyance', creditAccount: 'Cash', amount: 7000 });
  });
});
