import { describe, it, expect } from 'vitest';
import { validateTransaction, canPost, issueSummary } from '../src/utils/aiAccountant/validator.js';

const base = (overrides = {}) => ({
  intent: 'receipt',
  date: '2026-04-25',
  narration: 'test',
  entries: [{ debitAccount: 'Bank', creditAccount: 'Party: Acme', amount: 5000 }],
  party: { type: 'client', name: 'Acme' },
  mode: 'Bank',
  accountCreates: [],
  issues: [],
  confidence: 0.9,
  rawPrompt: 'acme paid 5000',
  model: 'rule-v1',
  ...overrides,
});

describe('validateTransaction', () => {
  it('clean transaction posts', () => {
    const tx = validateTransaction(base(), {});
    expect(canPost(tx)).toBe(true);
    expect(issueSummary(tx).errors).toBe(0);
  });

  it('flags same account on both sides', () => {
    const tx = validateTransaction(base({ entries: [{ debitAccount: 'Bank', creditAccount: 'Bank', amount: 100 }] }), {});
    expect(canPost(tx)).toBe(false);
    expect(tx.issues.some(i => /same account/i.test(i.message))).toBe(true);
  });

  it('flags negative / zero amount', () => {
    const tx = validateTransaction(base({ entries: [{ debitAccount: 'Bank', creditAccount: 'Party: Acme', amount: 0 }] }), {});
    expect(canPost(tx)).toBe(false);
  });

  it('flags missing Dr or Cr', () => {
    const tx = validateTransaction(base({ entries: [{ debitAccount: '', creditAccount: 'Party: Acme', amount: 100 }] }), {});
    expect(canPost(tx)).toBe(false);
  });

  it('blocks posting in closed FY', () => {
    const ctx = {
      closedFYs: ['2025-26'],
      getFY: (d) => (d >= '2025-04-01' && d <= '2026-03-31' ? '2025-26' : '2026-27'),
    };
    const tx = validateTransaction(base({ date: '2025-06-01' }), ctx);
    expect(canPost(tx)).toBe(false);
    expect(tx.issues.some(i => /closed/i.test(i.message))).toBe(true);
  });

  it('detects duplicates within window', () => {
    const now = Date.now();
    const ctx = {
      recentJournalEntries: [{
        date: '2026-04-25',
        entries: [{ debitAccount: 'Bank', creditAccount: 'Party: Acme', amount: 5000 }],
        created_at: new Date(now - 1000).toISOString(),
      }],
      duplicateWindowMs: 60000,
    };
    const tx = validateTransaction(base(), ctx);
    expect(tx.issues.some(i => i.code === 'possible_duplicate')).toBe(true);
  });

  it('warns on unresolved party', () => {
    const tx = validateTransaction(base({ party: { type: 'unknown', name: '' } }), {});
    expect(tx.issues.some(i => i.level === 'warning' && i.code === 'unknown_party')).toBe(true);
  });

  it('warns on placeholder party name', () => {
    const tx = validateTransaction(base({ party: { type: 'client', name: 'Unknown Client' } }), {});
    expect(tx.issues.some(i => i.code === 'placeholder_party')).toBe(true);
  });
});
