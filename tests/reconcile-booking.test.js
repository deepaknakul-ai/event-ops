import { describe, it, expect } from 'vitest';
import { buildRowBookingDraft } from '../src/utils/aiAccountant/bookRow.js';
import { learnFromEntries } from '../src/utils/aiAccountant/learning.js';
import { validateTransaction, canPost } from '../src/utils/aiAccountant/validator.js';

const ctx = { knownAccounts: [], closedFYs: [], getFY: () => '2026-27' };

describe('buildRowBookingDraft — direction → sides', () => {
  it('books money-out with the Bank credited and an expense debited (payment)', () => {
    const row = { id: 'r1', date: '2026-04-10', amount: 1500, direction: 'debit', description: 'Rent paid for office', ref: '' };
    const tx = buildRowBookingDraft(row, { bankAccountName: 'Bank' });
    expect(tx.entries).toHaveLength(1);
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Rent Expense', creditAccount: 'Bank', amount: 1500 });
    expect(tx.intent).toBe('payment');
    expect(tx.model).toBe('reco-v1');
    expect(canPost(validateTransaction(tx, ctx))).toBe(true);
  });

  it('books money-in from a recognised party with the Bank debited (receipt)', () => {
    const row = { id: 'r2', date: '2026-04-12', amount: 50000, direction: 'credit', description: 'NEFT from Acme Corp', ref: 'UTR9' };
    const tx = buildRowBookingDraft(row, { bankAccountName: 'Bank', partyNames: ['Acme Corp'] });
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Bank', creditAccount: 'Party: Acme Corp', amount: 50000 });
    expect(tx.party).toEqual({ type: 'client', name: 'Acme Corp' });
    expect(tx.intent).toBe('receipt');
    expect(canPost(validateTransaction(tx, ctx))).toBe(true);
  });

  it('threads a custom bank account name into the entry', () => {
    const row = { id: 'r3', date: '2026-04-10', amount: 2000, direction: 'debit', description: 'random unclassified', ref: '' };
    const tx = buildRowBookingDraft(row, { bankAccountName: 'HDFC Bank' });
    expect(tx.entries[0].creditAccount).toBe('HDFC Bank');
  });
});

describe('buildRowBookingDraft — contra resolution', () => {
  it('falls back to a keyword-guessed expense account for money-out', () => {
    const row = { id: 'r4', date: '2026-04-10', amount: 800, direction: 'debit', description: 'Diesel for site generator', ref: '' };
    const tx = buildRowBookingDraft(row, {});
    expect(tx.entries[0].debitAccount).toBe('Travel Expense');
  });

  it('uses the generic expense account when no keyword matches', () => {
    const row = { id: 'r5', date: '2026-04-10', amount: 800, direction: 'debit', description: 'zzz unknown outflow', ref: '' };
    const tx = buildRowBookingDraft(row, {});
    expect(tx.entries[0].debitAccount).toBe('Expense:General');
  });

  it('prefers a learned narration→account mapping over keyword guessing', () => {
    const learned = learnFromEntries([
      { narration: 'Swiggy lunch order', entries: [{ debitAccount: 'Food Expense', creditAccount: 'Cash', amount: 300 }] },
      { narration: 'Swiggy dinner order', entries: [{ debitAccount: 'Food Expense', creditAccount: 'Cash', amount: 400 }] },
    ]);
    const row = { id: 'r6', date: '2026-04-10', amount: 500, direction: 'debit', description: 'Swiggy order', ref: '' };
    const tx = buildRowBookingDraft(row, { learned });
    expect(tx.entries[0].debitAccount).toBe('Food Expense');
  });

  it('routes an unclassifiable money-in row to Suspense with a warning', () => {
    const row = { id: 'r7', date: '2026-04-10', amount: 9999, direction: 'credit', description: 'Unknown wire', ref: '' };
    const tx = buildRowBookingDraft(row, { partyNames: [] });
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Bank', creditAccount: 'Suspense' });
    expect(tx.issues.some((i) => i.code === 'contra_unresolved')).toBe(true);
  });
});

describe('buildRowBookingDraft — output shape', () => {
  it('derives accountCreates for both legs and stamps bankRow meta', () => {
    const row = { id: 'r8', date: '2026-04-10', amount: 1234.5, direction: 'debit', description: 'zzz unknown outflow', ref: 'CHQ1' };
    const tx = buildRowBookingDraft(row, { bankAccountName: 'Bank' });
    const names = tx.accountCreates.map((a) => a.name).sort();
    expect(names).toEqual(['Bank', 'Expense:General']);
    expect(tx.meta.bankRow).toMatchObject({ id: 'r8', direction: 'debit', amount: 1234.5, ref: 'CHQ1' });
  });

  it('takes the absolute rounded amount and passes the date through', () => {
    const row = { id: 'r9', date: '2026-04-10', amount: -777.125, direction: 'credit', description: 'NEFT from Acme Corp', ref: '' };
    const tx = buildRowBookingDraft(row, { partyNames: ['Acme Corp'] });
    expect(tx.entries[0].amount).toBe(777.13);
    expect(tx.date).toBe('2026-04-10');
  });
});
