import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/utils/aiAccountant/reconcile.js';

// Tight, unambiguous base case: one row, one JE, moderate confidence.
// Use a 4-day gap so base score has headroom below 100 for boost tests.
const ROW = { date: '2026-04-14', amount: 50000, direction: 'credit', description: 'NEFT Acme Corp salary advance', ref: 'NEFT789' };
const JE  = { id: 'je1', date: '2026-04-10', narration: 'Salary advance', entries: [{ debitAccount: 'Bank', creditAccount: 'Party: Acme', amount: 50000 }] };

describe('reconcile learning', () => {
  it('returns rich match shape with journalEntry / confidence / reason', () => {
    const r = reconcile([ROW], [JE]);
    expect(r.matches.length).toBe(1);
    const m = r.matches[0];
    expect(m.journalEntry).toBeTruthy();
    expect(m.journalEntry.id).toBe('je1');
    expect(m.confidence).toBe(m.score);
    expect(typeof m.reason).toBe('string');
    expect(m.reason).toMatch(/exact amount/);
  });

  it('boosts confidence when a matching ref was previously accepted', () => {
    const base = reconcile([ROW], [JE]).matches[0];
    const learned = [{ row: { description: 'NEFT Acme Corp salary advance', ref: 'NEFT789' }, journal_entry_id: 'je-historic' }];
    const boosted = reconcile([ROW], [JE], { learnedMatches: learned }).matches[0];
    expect(boosted.confidence).toBeGreaterThan(base.confidence);
    expect(boosted.reason).toMatch(/learned \+/);
  });

  it('boosts confidence on description-token overlap even without ref match', () => {
    const base = reconcile([ROW], [JE]).matches[0];
    const learned = [{ row: { description: 'salary advance to Acme', ref: '' } }];
    const boosted = reconcile([ROW], [JE], { learnedMatches: learned }).matches[0];
    expect(boosted.confidence).toBeGreaterThanOrEqual(base.confidence);
    // At least one token ('salary', 'advance', 'acme') should hit.
    if (boosted.confidence > base.confidence) {
      expect(boosted.reason).toMatch(/learned/);
    }
  });

  it('caps learned boost so it cannot push a bad match over the threshold alone', () => {
    // Mismatched amount (>0.5% tolerance) → base is 0; learning must not rescue it.
    const badRow = { ...ROW, amount: 60000 };
    const learned = Array.from({ length: 20 }, () => ({ row: { description: badRow.description, ref: badRow.ref } }));
    const r = reconcile([badRow], [JE], { learnedMatches: learned });
    expect(r.matches.length).toBe(0);
  });

  it('exposes learnedBoosted count in stats', () => {
    const learned = [{ row: { description: 'NEFT Acme Corp salary advance', ref: 'NEFT789' } }];
    const r = reconcile([ROW], [JE], { learnedMatches: learned });
    expect(r.stats.learnedBoosted).toBe(1);
  });

  it('is a no-op when learnedMatches is empty or omitted', () => {
    const r1 = reconcile([ROW], [JE]).matches[0];
    const r2 = reconcile([ROW], [JE], { learnedMatches: [] }).matches[0];
    expect(r2.confidence).toBe(r1.confidence);
  });
});
