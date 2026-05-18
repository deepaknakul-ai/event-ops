import { describe, it, expect } from 'vitest';
import { parseMessage, classifyIntent, guessAssetAccount } from '../src/utils/aiAccountant/nlu.js';

const CTX = { partyNames: ['Acme Corp', 'HDFC Bank'] };

describe('new intents — classifier', () => {
  it('asset_purchase', () => {
    expect(classifyIntent('bought new laptop for 80000').intent).toBe('asset_purchase');
  });
  it('depreciation', () => {
    expect(classifyIntent('depreciation on equipment 10000').intent).toBe('depreciation');
  });
  it('loan_taken', () => {
    expect(classifyIntent('took a loan of 5 lakh from HDFC Bank').intent).toBe('loan_taken');
  });
  it('loan_repayment', () => {
    expect(classifyIntent('loan EMI 25000 paid').intent).toBe('loan_repayment');
  });
  it('interest_paid', () => {
    expect(classifyIntent('interest paid on loan 5000').intent).toBe('interest_paid');
  });
  it('interest_earned', () => {
    expect(classifyIntent('interest received from FD 2000').intent).toBe('interest_earned');
  });
  it('bad_debt', () => {
    expect(classifyIntent('wrote off 50000 as bad debt from Acme Corp').intent).toBe('bad_debt');
  });
});

describe('guessAssetAccount', () => {
  it('maps laptop to Computer Equipment', () => {
    expect(guessAssetAccount('new laptop')).toBe('Computer Equipment');
  });
  it('maps LED wall to AV Equipment', () => {
    expect(guessAssetAccount('bought led wall for stage')).toBe('AV Equipment');
  });
  it('maps vehicle', () => {
    expect(guessAssetAccount('bought a van')).toBe('Vehicles');
  });
  it('returns empty for unknown', () => {
    expect(guessAssetAccount('hello')).toBe('');
  });
});

describe('new intents — parseMessage entries', () => {
  it('asset_purchase debits asset account, credits cash/bank', () => {
    const tx = parseMessage('bought new laptop for 80000 cash', CTX);
    expect(tx.intent).toBe('asset_purchase');
    expect(tx.entries).toHaveLength(1);
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Computer Equipment', creditAccount: 'Cash', amount: 80000 });
  });

  it('depreciation debits Depreciation Expense', () => {
    const tx = parseMessage('depreciation on laptop 10000', CTX);
    expect(tx.entries[0].debitAccount).toBe('Depreciation Expense');
    expect(tx.entries[0].creditAccount).toMatch(/Accumulated Depreciation/);
  });

  it('loan_taken credits loan liability', () => {
    const tx = parseMessage('took a loan of 5 lakh from HDFC Bank via NEFT', CTX);
    expect(tx.entries[0].debitAccount).toBe('Bank');
    expect(tx.entries[0].creditAccount).toMatch(/^Loan from /);
    expect(tx.entries[0].amount).toBe(500000);
  });

  it('loan_repayment debits loan liability', () => {
    const tx = parseMessage('loan EMI 25000 paid to HDFC Bank from bank', CTX);
    expect(tx.entries[0].debitAccount).toMatch(/^Loan from /);
    expect(tx.entries[0].creditAccount).toBe('Bank');
  });

  it('interest_paid debits Interest Expense', () => {
    const tx = parseMessage('interest paid 5000', CTX);
    expect(tx.entries[0].debitAccount).toBe('Interest Expense');
  });

  it('interest_earned credits Interest Income', () => {
    const tx = parseMessage('interest received from FD 2000 in bank', CTX);
    expect(tx.entries[0].creditAccount).toBe('Interest Income');
    expect(tx.entries[0].debitAccount).toBe('Bank');
  });

  it('bad_debt writes off party balance', () => {
    const tx = parseMessage('wrote off 50000 as bad debt from Acme Corp', CTX);
    expect(tx.entries[0].debitAccount).toBe('Bad Debts Expense');
    expect(tx.entries[0].creditAccount).toBe('Party: Acme Corp');
  });
});

describe('parseMessage — date + arithmetic integration', () => {
  it('picks up natural date from text', () => {
    const now = new Date();
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    const pad = (n) => String(n).padStart(2, '0');
    const expected = `${yest.getFullYear()}-${pad(yest.getMonth() + 1)}-${pad(yest.getDate())}`;
    const tx = parseMessage('yesterday Acme Corp paid us 5000', CTX);
    expect(tx).toBeTruthy();
    expect(tx.date).toBe(expected);
  });

  it('ctx.date wins over natural date in text', () => {
    const tx = parseMessage('yesterday Acme paid us 5000', { ...CTX, date: '2024-12-31' });
    expect(tx.date).toBe('2024-12-31');
  });

  it('arithmetic amount sums correctly', () => {
    const tx = parseMessage('invoice 5000 + 900 for Acme Corp', CTX);
    expect(tx.intent).toBe('invoice');
    const total = tx.entries.reduce((s, e) => s + e.amount, 0);
    expect(total).toBeCloseTo(5900, 2);
  });
});
