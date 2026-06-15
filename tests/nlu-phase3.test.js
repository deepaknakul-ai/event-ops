import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/utils/aiAccountant/nlu.js';
import { validateTransaction, canPost, canDispatch } from '../src/utils/aiAccountant/validator.js';

const CTX = { partyNames: ['Acme Corp'] };

describe('reversal intent', () => {
  it('detects and attaches voucher number', () => {
    const tx = parseMessage('reverse JV-0042 posted yesterday', CTX);
    expect(tx.intent).toBe('reversal');
    expect(tx.meta.reverseVoucher).toBe('JV-0042');
    expect(canDispatch(validateTransaction(tx, {}))).toBe(true);
    expect(canPost(tx)).toBe(false);
  });

  it('flags missing voucher number', () => {
    const tx = parseMessage('reverse the voucher please', CTX);
    expect(tx.intent).toBe('reversal');
    expect(tx.issues.some((i) => i.code === 'reversal_no_voucher')).toBe(true);
    expect(canDispatch(validateTransaction(tx, {}))).toBe(false);
  });
});

describe('query intent', () => {
  it('detects cash balance question', () => {
    const tx = parseMessage('how much cash do we have', CTX);
    expect(tx.intent).toBe('query');
    expect(tx.meta.queryType).toBe('cash_balance');
  });

  it('detects expenses this month', () => {
    const tx = parseMessage('show me expenses this month', CTX);
    expect(tx.intent).toBe('query');
    expect(tx.meta.queryType).toBe('expenses');
    expect(tx.meta.period).toBe('this_month');
  });

  it('detects P&L', () => {
    const tx = parseMessage('show profit and loss', CTX);
    expect(tx.intent).toBe('query');
    expect(tx.meta.queryType).toBe('pnl');
  });

  it('canDispatch true for query', () => {
    const tx = parseMessage('what is the bank balance', CTX);
    expect(canDispatch(validateTransaction(tx, {}))).toBe(true);
  });
});

describe('GST rate variants in invoice', () => {
  it('applies 18% by default', () => {
    const tx = parseMessage('invoice 11800 to Acme Corp', CTX);
    expect(tx.meta.gstRate).toBe(18);
    expect(tx.entries).toHaveLength(2);
    const total = tx.entries.reduce((s, e) => s + e.amount, 0);
    expect(total).toBeCloseTo(11800, 2);
  });

  it('applies 5% when stated', () => {
    const tx = parseMessage('invoice 10500 to Acme Corp with 5% GST', CTX);
    expect(tx.meta.gstRate).toBe(5);
    expect(tx.entries[0].amount).toBe(10000);
    expect(tx.entries[1].amount).toBe(500);
  });

  it('applies 0% for nil GST (single line)', () => {
    const tx = parseMessage('invoice 5000 to Acme Corp nil GST', CTX);
    expect(tx.meta.gstRate).toBe(0);
    expect(tx.entries).toHaveLength(1);
    expect(tx.entries[0].creditAccount).toBe('Sales Revenue');
  });

  it('applies 28% to purchase', () => {
    const tx = parseMessage('purchased from Acme Corp 12800 with 28% gst', CTX);
    expect(tx.intent).toBe('purchase');
    expect(tx.meta.gstRate).toBe(28);
    expect(tx.entries).toHaveLength(2);
  });
});

describe('split-line expense', () => {
  it('splits "5000 on travel and 2000 on food"', () => {
    const tx = parseMessage('spent 5000 on travel and 2000 on food', CTX);
    expect(tx.intent).toBe('expense');
    expect(tx.entries).toHaveLength(2);
    const accounts = tx.entries.map((e) => e.debitAccount).sort();
    expect(accounts).toContain('Travelling & Conveyance');
    expect(accounts).toContain('Food Expense');
    expect(tx.meta.split).toBe(true);
  });
});

describe('project tag integration', () => {
  it('stamps projectTag in meta', () => {
    const tx = parseMessage('spent 5000 on travel #P-123', CTX);
    expect(tx.meta.projectTag).toBe('P-123');
  });
});
