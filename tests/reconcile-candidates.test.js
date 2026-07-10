import { describe, it, expect } from 'vitest';
import { reconcile, makeBankMatcher, rowKey } from '../src/utils/aiAccountant/reconcile.js';

describe('makeBankMatcher', () => {
  it('matches a named bank account exactly (case-insensitive)', () => {
    const m = makeBankMatcher('HDFC Bank');
    expect(m('HDFC Bank')).toBe(true);
    expect(m('  hdfc bank  ')).toBe(true);
    expect(m('ICICI Bank')).toBe(false);
    expect(m('Bank')).toBe(false);
  });

  it('falls back to the legacy /^bank\\b/ heuristic when no account is given', () => {
    const legacy = makeBankMatcher();
    expect(legacy('Bank')).toBe(true);
    expect(legacy('Bank - Current')).toBe(true);
    expect(legacy('HDFC Bank')).toBe(false);
  });
});

describe('rowKey', () => {
  it('prefers the parser-assigned id, else the legacy composite key', () => {
    expect(rowKey({ id: '2026-04-10|debit|500|Cash#0' })).toBe('2026-04-10|debit|500|Cash#0');
    expect(rowKey({ date: '2026-04-10', amount: 500, description: 'Cash' })).toBe('2026-04-10-500-Cash');
  });
});

describe('reconcile — candidates grid', () => {
  const ROW = { id: 'r1', date: '2026-04-10', amount: 5000, direction: 'debit', description: 'pay' };
  const JES = [
    { id: 'j1', date: '2026-04-10', narration: 'exact day', entries: [{ debitAccount: 'X', creditAccount: 'Bank', amount: 5000 }] },
    { id: 'j2', date: '2026-04-11', narration: 'next day', entries: [{ debitAccount: 'Y', creditAccount: 'Bank', amount: 5000 }] },
    { id: 'j3', date: '2026-04-10', narration: 'cash not bank', entries: [{ debitAccount: 'Z', creditAccount: 'Cash', amount: 5000 }] },
  ];

  it('exposes top scored JVs per row keyed by rowKey, best first, excluding impossible pairs', () => {
    const r = reconcile([ROW], JES);
    expect(r.candidates.r1).toBeTruthy();
    expect(r.candidates.r1).toHaveLength(2); // j3 is not a bank line → excluded
    expect(r.candidates.r1[0].jeId).toBe('j1'); // same-day sorts ahead of next-day
    expect(r.candidates.r1.map((c) => c.jeId)).toContain('j2');
    expect(r.candidates.r1[0]).toHaveProperty('confidence');
    expect(r.candidates.r1[0]).toHaveProperty('reason');
  });

  it('caps candidates at 5 per row', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`, date: '2026-04-10', narration: `v${i}`,
      entries: [{ debitAccount: 'A', creditAccount: 'Bank', amount: 5000 }],
    }));
    const r = reconcile([ROW], many);
    expect(r.candidates.r1).toHaveLength(5);
  });

  it('still keeps a candidate whose JV was claimed by the greedy match on another row', () => {
    const rows = [
      { id: 'rA', date: '2026-04-10', amount: 5000, direction: 'debit', description: 'a' },
      { id: 'rB', date: '2026-04-10', amount: 5000, direction: 'debit', description: 'b' },
    ];
    const jes = [{ id: 'jOnly', date: '2026-04-10', narration: 'one', entries: [{ debitAccount: 'X', creditAccount: 'Bank', amount: 5000 }] }];
    const r = reconcile(rows, jes);
    // Only one greedy match is possible (single JV), but both rows list jOnly as a candidate.
    expect(r.matches).toHaveLength(1);
    expect(r.candidates.rA.map((c) => c.jeId)).toContain('jOnly');
    expect(r.candidates.rB.map((c) => c.jeId)).toContain('jOnly');
  });
});

describe('reconcile — bankAccountName scoping', () => {
  const ROW = { id: 'r1', date: '2026-04-10', amount: 5000, direction: 'debit', description: 'x' };
  const JE_HDFC = { id: 'jh', date: '2026-04-10', narration: 'h', entries: [{ debitAccount: 'X', creditAccount: 'HDFC Bank', amount: 5000 }] };
  const JE_ICICI = { id: 'ji', date: '2026-04-10', narration: 'i', entries: [{ debitAccount: 'Y', creditAccount: 'ICICI Bank', amount: 5000 }] };

  it('matches only the chosen bank account when bankAccountName is provided', () => {
    const r = reconcile([ROW], [JE_HDFC, JE_ICICI], { bankAccountName: 'HDFC Bank' });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].je.id).toBe('jh');
  });

  it('scopes to a different account on request', () => {
    const r = reconcile([ROW], [JE_HDFC, JE_ICICI], { bankAccountName: 'ICICI Bank' });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].je.id).toBe('ji');
  });

  it('legacy heuristic does not match accounts that merely end in "Bank"', () => {
    const r = reconcile([ROW], [JE_HDFC, JE_ICICI]);
    expect(r.matches).toHaveLength(0);
  });
});
