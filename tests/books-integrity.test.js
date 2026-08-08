import { describe, it, expect } from 'vitest';
import { buildAccountingSnapshot } from '../src/utils/accounting.js';

// The historic "your books are balanced" indicator could never go red: the journal
// is balanced BY CONSTRUCTION (each pushDoubleEntry line carries one amount to a Dr
// and a Cr account) and the balance sheet balances BY IDENTITY. These integrity
// checks are deliberately INDEPENDENT of those identities, so they CAN fail — this
// suite proves it, which is the whole point of the feature.

const jv = (id, date, entries) => ({ id, date, voucher_no: id, narration: id, entries });

const snap = (manualJournalEntries) => buildAccountingSnapshot({
  manualJournalEntries,
  fyFilter: 'all',
});

const checkOf = (s, id) => s.integrity.checks.find((c) => c.id === id);

describe('books integrity — clean set', () => {
  const s = snap([
    jv('JV-1', '2025-06-01', [{ debitAccount: 'Bank', creditAccount: 'Sales Revenue', amount: 100000 }]),
    jv('JV-2', '2025-06-02', [{ debitAccount: 'Purchase Expense', creditAccount: 'Bank', amount: 40000 }]),
  ]);

  it('reports every check and passes overall', () => {
    expect(s.integrity.checks.length).toBeGreaterThanOrEqual(6);
    expect(s.integrity.ok).toBe(true);
    expect(s.integrity.checks.every((c) => c.ok)).toBe(true);
  });

  it('still ties the trial balance', () => {
    expect(s.trialBalance.isBalanced).toBe(true);
  });

  it('ledger totals reconcile to the raw journal', () => {
    expect(checkOf(s, 'ledger_reconciles_to_journal').ok).toBe(true);
  });

  it('reports no abnormal-sign P&L accounts', () => {
    expect(s.plExceptions.rows).toEqual([]);
    expect(s.plExceptions.total).toBe(0);
    expect(checkOf(s, 'pl_residue_explained').ok).toBe(true);
  });
});

describe('books integrity — the checks CAN fail', () => {
  // A self-posting (same account on both sides) nets to a zero balance but inflates
  // BOTH trial-balance totals equally — so the trial balance still "ties" and the
  // balance sheet still balances. Only an independent check can surface it.
  const s = snap([
    jv('JV-1', '2025-06-01', [{ debitAccount: 'Bank', creditAccount: 'Sales Revenue', amount: 100000 }]),
    jv('JV-BAD', '2025-06-03', [{ debitAccount: 'Bank', creditAccount: 'Bank', amount: 25000 }]),
  ]);

  it('flags the self-posting and turns integrity.ok false', () => {
    expect(checkOf(s, 'no_self_postings').ok).toBe(false);
    expect(checkOf(s, 'no_self_postings').detail).toContain('1');
    expect(s.integrity.ok).toBe(false);
  });

  it('proves the OLD indicator would have stayed green on the same data', () => {
    // This is why the check was needed: the legacy signal is blind to it.
    expect(s.trialBalance.isBalanced).toBe(true);
    expect(s.trialBalance.difference).toBe(0);
  });

  it('does not raise unrelated checks', () => {
    expect(checkOf(s, 'all_legs_named').ok).toBe(true);
    expect(checkOf(s, 'no_negative_amounts').ok).toBe(true);
    expect(checkOf(s, 'ledger_rows_match_entries').ok).toBe(true);
  });
});

describe('books integrity — abnormal-sign P&L account is surfaced, not hidden', () => {
  // Credit an EXPENSE head so it carries an abnormal (Cr) balance. The presented P&L
  // clamps it out and the residue is absorbed into equity.otherEquity — historically
  // invisible. plExceptions now reports it and the residue check still reconciles.
  const s = snap([
    jv('JV-1', '2025-06-01', [{ debitAccount: 'Bank', creditAccount: 'Sales Revenue', amount: 100000 }]),
    jv('JV-2', '2025-06-02', [{ debitAccount: 'Bank', creditAccount: 'Purchase Expense', amount: 7000 }]),
  ]);

  it('lists the abnormal-sign expense head', () => {
    const row = s.plExceptions.rows.find((r) => r.account === 'Purchase Expense');
    expect(row).toBeTruthy();
    expect(row.type).toBe('Expense');
    expect(row.side).toBe('Cr');
    expect(row.excluded).toBe(7000);
    expect(s.plExceptions.total).toBe(7000);
  });

  it('reconciles that residue against equity (check passes, nothing unexplained)', () => {
    expect(checkOf(s, 'pl_residue_explained').ok).toBe(true);
  });
});
