import { describe, it, expect } from 'vitest';
import { classifyBankNarration } from '../src/utils/aiAccountant/knowledge.js';
import { buildRowBookingDraft } from '../src/utils/aiAccountant/bookRow.js';
import { validateTransaction, canPost } from '../src/utils/aiAccountant/validator.js';

const ctx = { knownAccounts: [], closedFYs: [], getFY: () => '2026-27' };
const row = (over) => ({ id: 'x', date: '2026-04-10', ref: '', ...over });

describe('classifyBankNarration', () => {
  it('bank charges (debit) → Bank Charges', () => {
    expect(classifyBankNarration('AMB CHARGES APR', 'debit')).toMatchObject({ account: 'Bank Charges' });
    expect(classifyBankNarration('SMS CHG 17.70', 'debit')).toMatchObject({ account: 'Bank Charges' });
    expect(classifyBankNarration('NEFT CHG', 'debit')).toMatchObject({ account: 'Bank Charges' });
  });
  it('interest credited → Interest Income; debited → Interest Expense', () => {
    expect(classifyBankNarration('SB INT CREDIT', 'credit')).toMatchObject({ account: 'Interest Income' });
    expect(classifyBankNarration('OD INTEREST', 'debit')).toMatchObject({ account: 'Interest Expense' });
  });
  it('cash deposit/withdrawal → Cash (both directions)', () => {
    expect(classifyBankNarration('CASH DEPOSIT', 'credit')).toMatchObject({ account: 'Cash' });
    expect(classifyBankNarration('ATM WDL', 'debit')).toMatchObject({ account: 'Cash' });
  });
  it('reversal/refund → Suspense with review flag', () => {
    expect(classifyBankNarration('IMPS REVERSAL', 'credit')).toMatchObject({ account: 'Suspense', review: true });
    expect(classifyBankNarration('NEFT RETURN failed', 'credit')).toMatchObject({ review: true });
  });
  it('returns null for ordinary expense / party narrations (no hijack)', () => {
    expect(classifyBankNarration('Rent paid for office', 'debit')).toBe(null);
    expect(classifyBankNarration('Diesel for site generator', 'debit')).toBe(null);
    expect(classifyBankNarration('NEFT from Acme Corp', 'credit')).toBe(null);
    expect(classifyBankNarration('Legal fees paid', 'debit')).toBe(null); // "fees" alone is not a bank charge
  });
});

describe('buildRowBookingDraft — bank-pattern suggestions', () => {
  it('books a bank charge: Dr Bank Charges / Cr Bank + suggestion meta', () => {
    const tx = buildRowBookingDraft(row({ amount: 17.7, direction: 'debit', description: 'SMS CHG APR' }), { bankAccountName: 'Bank' });
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Bank Charges', creditAccount: 'Bank' });
    expect(tx.meta.suggestion).toMatchObject({ account: 'Bank Charges' });
    expect(tx.confidence).toBeGreaterThanOrEqual(0.8);
    expect(canPost(validateTransaction(tx, ctx))).toBe(true);
  });

  it('books interest earned: Dr Bank / Cr Interest Income (a money-in row rules cannot party-match)', () => {
    const tx = buildRowBookingDraft(row({ amount: 1234, direction: 'credit', description: 'SB INTEREST CREDIT' }), { bankAccountName: 'Bank' });
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Bank', creditAccount: 'Interest Income' });
    expect(canPost(validateTransaction(tx, ctx))).toBe(true);
  });

  it('books a cash deposit against Cash', () => {
    const tx = buildRowBookingDraft(row({ amount: 20000, direction: 'credit', description: 'CASH DEPOSIT' }), { bankAccountName: 'Bank' });
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Bank', creditAccount: 'Cash' });
  });

  it('books a cash withdrawal: Dr Cash / Cr Bank', () => {
    const tx = buildRowBookingDraft(row({ amount: 5000, direction: 'debit', description: 'ATM WDL' }), { bankAccountName: 'Bank' });
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Cash', creditAccount: 'Bank' });
  });

  it('routes a reversal to Suspense with a reversal_review warning (not a generic guess)', () => {
    const tx = buildRowBookingDraft(row({ amount: 5000, direction: 'debit', description: 'IMPS REVERSAL' }), {});
    expect(tx.entries[0].debitAccount).toBe('Suspense');
    expect(tx.issues.some((i) => i.code === 'reversal_review')).toBe(true);
    expect(tx.meta.suggestion).toBeUndefined();
  });
});

describe('buildRowBookingDraft — regression (bank patterns never override party/keyword)', () => {
  it('a recognised party still wins over any bank pattern', () => {
    const tx = buildRowBookingDraft(row({ amount: 50000, direction: 'credit', description: 'NEFT INT FROM Acme Corp' }), { partyNames: ['Acme Corp'] });
    expect(tx.entries[0].creditAccount).toBe('Party: Acme Corp');
  });
  it('a plain money-out keyword still routes via guessExpenseAccount', () => {
    const tx = buildRowBookingDraft(row({ amount: 1500, direction: 'debit', description: 'Rent paid for office' }), {});
    expect(tx.entries[0].debitAccount).toBe('Rent Expense');
  });
  it('an unclassifiable money-in row still lands on Suspense + contra_unresolved', () => {
    const tx = buildRowBookingDraft(row({ amount: 9999, direction: 'credit', description: 'Unknown wire' }), {});
    expect(tx.entries[0].creditAccount).toBe('Suspense');
    expect(tx.issues.some((i) => i.code === 'contra_unresolved')).toBe(true);
  });
});
