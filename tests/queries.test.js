import { describe, it, expect } from 'vitest';
import {
  resolveAccount, buildRunningLedger, partyBalanceAnswer, accountLedgerAnswer,
  outstandingAnswer, gstLiabilityAnswer, tdsLiabilityAnswer,
} from '../src/utils/aiAccountant/queries.js';
import { parseMessage } from '../src/utils/aiAccountant/nlu.js';

const fmt = (n) => String(n);
const ledger = [
  {
    account: 'Party: Acme Corp', balance: 5000, balanceType: 'Dr', debit: 8000, credit: 3000,
    entries: [
      { date: '2026-04-01', side: 'Dr', amount: 8000, debitAccount: 'Party: Acme Corp', creditAccount: 'Sales Revenue', source: 'sales_invoice', voucher_no: 'INV-1' },
      { date: '2026-04-10', side: 'Cr', amount: 3000, debitAccount: 'Bank', creditAccount: 'Party: Acme Corp', source: 'receipt', voucher_no: 'RC-1' },
    ],
  },
  { account: 'Party: Zenith', balance: -2000, balanceType: 'Cr', debit: 0, credit: 2000, entries: [] },
  { account: 'Employee: Rahul', balance: -1500, balanceType: 'Cr', debit: 0, credit: 1500, entries: [] },
  { account: 'TDS Payable', balance: -4000, balanceType: 'Cr', entries: [] },
  { account: 'TDS Receivable', balance: 1000, balanceType: 'Dr', entries: [] },
];
const balanceSheet = { assets: { inputGstCredit: 500 }, liabilities: { gstPayable: 3000 } };

describe('resolveAccount', () => {
  it('resolves exact, name-part, and contains matches; null when nothing fits', () => {
    expect(resolveAccount('Party: Acme Corp', ledger)).toBe('Party: Acme Corp');
    expect(resolveAccount('acme corp', ledger)).toBe('Party: Acme Corp');
    expect(resolveAccount('acme', ledger)).toBe('Party: Acme Corp');
    expect(resolveAccount('rahul', ledger)).toBe('Employee: Rahul');
    expect(resolveAccount('nobody', ledger)).toBe(null);
  });
});

describe('partyBalanceAnswer', () => {
  it('interprets a Dr balance as receivable', () => {
    const r = partyBalanceAnswer(ledger, 'Party: Acme Corp', fmt);
    expect(r.balance).toBe(5000);
    expect(r.message).toMatch(/owes you/i);
  });
  it('interprets a Cr balance as payable', () => {
    const r = partyBalanceAnswer(ledger, 'Party: Zenith', fmt);
    expect(r.balance).toBe(-2000);
    expect(r.message).toMatch(/you owe/i);
  });
  it('returns null for an unknown account', () => {
    expect(partyBalanceAnswer(ledger, 'Party: Ghost', fmt)).toBe(null);
  });
});

describe('buildRunningLedger + accountLedgerAnswer', () => {
  it('computes a running balance in date order', () => {
    const rows = buildRunningLedger(ledger[0]);
    expect(rows.map((r) => r.balance)).toEqual([8000, 5000]);
    expect(rows[0]).toMatchObject({ debit: 8000, credit: 0, contra: 'Sales Revenue' });
    expect(rows[1]).toMatchObject({ debit: 0, credit: 3000, contra: 'Bank' });
  });
  it('answers with rows, closing, and a download action', () => {
    const a = accountLedgerAnswer(ledger, 'Party: Acme Corp', fmt);
    expect(a.rows).toHaveLength(2);
    expect(a.closing).toBe(5000);
    expect(a.closingType).toBe('Dr');
    expect(a.action).toEqual({ type: 'download_ledger', account: 'Party: Acme Corp' });
  });
});

describe('outstanding / GST / TDS answers', () => {
  it('totals receivables and payables across party + employee sub-ledgers', () => {
    const r = outstandingAnswer(ledger, 'both', fmt);
    expect(r.totalReceivable).toBe(5000);      // Acme
    expect(r.totalPayable).toBe(3500);         // Zenith 2000 + Rahul 1500
  });
  it('gstLiabilityAnswer reports net GST payable', () => {
    expect(gstLiabilityAnswer(balanceSheet, fmt).gstPayable).toBe(3000);
  });
  it('tdsLiabilityAnswer reports payable and receivable', () => {
    const r = tdsLiabilityAnswer(ledger, fmt);
    expect(r.tdsPayable).toBe(4000);
    expect(r.tdsReceivable).toBe(1000);
  });
});

describe('detectQuery classification (via parseMessage)', () => {
  const q = (text, ctx = {}) => parseMessage(text, ctx);
  it('classifies "show me Acme Corp ledger" → account_ledger with subject', () => {
    const tx = q('show me Acme Corp ledger', { partyNames: ['Acme Corp'] });
    expect(tx.intent).toBe('query');
    expect(tx.meta.queryType).toBe('account_ledger');
    expect(tx.meta.subject.toLowerCase()).toContain('acme');
  });
  it('classifies "how much do we owe Zenith" → party_balance', () => {
    const tx = q('how much do we owe Zenith');
    expect(tx.meta.queryType).toBe('party_balance');
    expect(tx.meta.subject.toLowerCase()).toContain('zenith');
  });
  it('classifies "who owes us money" → outstanding (not party_balance)', () => {
    expect(q('who owes us money').meta.queryType).toBe('outstanding');
  });
  it('classifies GST/TDS liability questions', () => {
    expect(q('what is my gst liability this month').meta.queryType).toBe('gst_liability');
    expect(q('tds payable to deposit').meta.queryType).toBe('tds_liability');
  });
  it('keeps existing statement queries intact', () => {
    expect(q('show me the balance sheet').meta.queryType).toBe('balance_sheet');
    expect(q('what is the trial balance').meta.queryType).toBe('trial_balance');
    expect(q('cash balance').meta.queryType).toBe('cash_balance');
  });
});
