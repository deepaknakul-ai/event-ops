import { describe, it, expect } from 'vitest';
import { analyzePostedEntries, primaryAccount, isFlagged } from '../src/utils/aiAccountant/analyst.js';

// Synthetic posted journal entry carrying the ai_* fields postParsedEntry writes.
const mkEntry = (over = {}) => ({
  ai_intent: 'expense',
  ai_confidence: 0.9,
  ai_model: 'rule-v1',
  ai_prompt: 'spent on stuff',
  party_name: null,
  entries: [{ debitAccount: 'Miscellaneous Expense', creditAccount: 'Cash', amount: 100 }],
  ai_decision_trace: { policy_version: 'audit-v1', audit: { findings: [], auditScore: 100, blocking: false }, confidence: 0.9 },
  ...over,
});
const withFindings = (findings, score, over = {}) =>
  mkEntry({ ai_decision_trace: { audit: { findings, auditScore: score, blocking: false } }, ...over });
const advisory = (code, account) => withFindings(
  [{ severity: 'advisory', code, message: code, fix: 'do X' }], 90,
  { entries: [{ debitAccount: account, creditAccount: 'Cash', amount: 100 }], ai_prompt: `${code} entry` });

describe('analyzePostedEntries — robustness', () => {
  it('handles empty / garbage input without throwing', () => {
    for (const bad of [null, undefined, [], [null, undefined]]) {
      const r = analyzePostedEntries(bad);
      expect(r.sampleSize).toBe(0);
      expect(r.health.avgAuditScore).toBe(null);
      expect(r.topFindingCodes).toEqual([]);
      expect(r.suggestions).toEqual([]);
    }
  });

  it('is deterministic (deep-equal across two calls)', () => {
    const es = [advisory('fuel_account_ambiguous', 'Travelling & Conveyance'), mkEntry()];
    expect(analyzePostedEntries(es)).toEqual(analyzePostedEntries(es));
  });
});

describe('health counts', () => {
  it('counts warnings / advisories / clean', () => {
    const es = [
      mkEntry(), mkEntry(), mkEntry(), // 3 clean
      withFindings([{ severity: 'warning', code: 'unknown_party', message: 'x' }], 88),
      withFindings([{ severity: 'warning', code: 'possible_duplicate', message: 'y' }], 88),
    ];
    const r = analyzePostedEntries(es);
    expect(r.health.total).toBe(5);
    expect(r.health.clean).toBe(3);
    expect(r.health.withWarnings).toBe(2);
  });

  it('averages audit score only over scored entries', () => {
    const es = [withFindings([], 100), withFindings([], 88), withFindings([], 76)];
    expect(analyzePostedEntries(es).health.avgAuditScore).toBe(88);
  });

  it('counts below-confidence-bar excluding null confidences', () => {
    const es = [mkEntry({ ai_confidence: 0.9 }), mkEntry({ ai_confidence: 0.4 }), mkEntry({ ai_confidence: 0.5 }), mkEntry({ ai_confidence: null })];
    const r = analyzePostedEntries(es);
    expect(r.health.belowConfidenceBar).toBe(2);
    expect(r.health.belowConfidencePct).toBe(round(100 * 2 / 3));
  });
});

describe('topFindingCodes ranking', () => {
  it('ranks by count desc and carries severity + fix', () => {
    const es = [
      ...Array.from({ length: 4 }, () => advisory('fuel_account_ambiguous', 'Site Power & Fuel')),
      ...Array.from({ length: 2 }, () => withFindings([{ severity: 'warning', code: 'possible_duplicate', message: 'd' }], 88)),
    ];
    const r = analyzePostedEntries(es);
    expect(r.topFindingCodes[0]).toMatchObject({ code: 'fuel_account_ambiguous', count: 4, severity: 'advisory' });
    expect(r.topFindingCodes[0].fix).toBeTruthy();
    expect(r.topFindingCodes[1]).toMatchObject({ code: 'possible_duplicate', count: 2 });
  });
});

describe('rule suggestions', () => {
  it('surfaces a suggestion when a code recurs to a dominant account', () => {
    const es = [
      ...Array.from({ length: 5 }, () => advisory('fuel_account_ambiguous', 'Travelling & Conveyance')),
      advisory('fuel_account_ambiguous', 'Site Power & Fuel'),
    ];
    const r = analyzePostedEntries(es);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ code: 'fuel_account_ambiguous', account: 'Travelling & Conveyance', hits: 5, total: 6 });
    expect(r.suggestions[0].message).toMatch(/5\/6/);
  });

  it('suppresses below minRecurrence', () => {
    const es = [advisory('fuel_account_ambiguous', 'Travelling & Conveyance'), advisory('fuel_account_ambiguous', 'Travelling & Conveyance')];
    expect(analyzePostedEntries(es).suggestions).toEqual([]);
  });

  it('suppresses when no account dominates (ratio < 0.6)', () => {
    const es = [
      advisory('employee_expense_ambiguous', 'A'), advisory('employee_expense_ambiguous', 'A'),
      advisory('employee_expense_ambiguous', 'B'), advisory('employee_expense_ambiguous', 'B'),
    ];
    expect(analyzePostedEntries(es).suggestions).toEqual([]);
  });
});

describe('hotspots', () => {
  it('ranks flagged parties, ignoring under-sampled groups', () => {
    const es = [
      ...Array.from({ length: 3 }, () => withFindings([{ severity: 'warning', code: 'unknown_party', message: 'x' }], 88, { party_name: 'Acme' })),
      mkEntry({ party_name: 'Acme' }),   // Acme: 3 flagged / 4 total
      mkEntry({ party_name: 'Beta' }), mkEntry({ party_name: 'Beta' }), // Beta: 0/2
    ];
    const r = analyzePostedEntries(es);
    expect(r.hotspots.byParty[0]).toMatchObject({ key: 'Acme', flagged: 3, total: 4 });
    expect(r.hotspots.byParty[0].ratio).toBe(0.75);
  });

  it('tokenizes prompts, dropping numbers and short tokens', () => {
    const es = Array.from({ length: 3 }, () => withFindings([{ severity: 'warning', code: 'fuel_account_ambiguous', message: 'f' }], 88, { ai_prompt: 'fuel 5000 for site' }));
    const tokens = analyzePostedEntries(es).hotspots.byPromptToken.map((t) => t.key);
    expect(tokens).toContain('fuel');
    expect(tokens).toContain('site');
    expect(tokens).not.toContain('5000'); // pure numbers dropped
    expect(tokens).not.toContain('5'); // short tokens dropped
  });
});

describe('alias trends', () => {
  it('ranks repeated typed→party corrections', () => {
    const es = [
      ...Array.from({ length: 3 }, () => mkEntry({ ai_party_alias: { alias: 'sanjeev chopra', party: 'Chopra AV' } })),
      mkEntry({ ai_party_alias: { alias: 'raj kumar', party: 'Raj Traders' } }),
    ];
    const r = analyzePostedEntries(es);
    expect(r.aliasTrends[0]).toMatchObject({ typed: 'sanjeev chopra', party: 'Chopra AV', count: 3 });
  });
});

describe('fallback + filtering', () => {
  it('derives findings from ai_issues when no decision trace, and counts untraced', () => {
    const e = { ai_intent: 'payment', ai_confidence: 0.8, ai_prompt: 'paid x', entries: [{ debitAccount: 'Party: X', creditAccount: 'Cash', amount: 50 }], ai_issues: [{ level: 'warning', code: 'unknown_party', message: 'z' }] };
    const r = analyzePostedEntries([e]);
    expect(r.untraced).toBe(1);
    expect(r.health.withWarnings).toBe(1);
    expect(r.topFindingCodes[0].code).toBe('unknown_party');
  });

  it('excludes fy_closing rows from every count', () => {
    const es = [mkEntry(), { source: 'fy_closing', entries: [] }];
    expect(analyzePostedEntries(es).sampleSize).toBe(1);
  });
});

// local rounding mirror for the pct assertion
function round(n) { return Math.round(n * 100) / 100; }
