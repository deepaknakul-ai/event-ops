import { describe, it, expect } from 'vitest';
import {
  resolveAccount, resolveAccountCandidates, buildRunningLedger, partyBalanceAnswer, accountLedgerAnswer,
  outstandingAnswer, gstLiabilityAnswer, tdsLiabilityAnswer, buildBooksDigest,
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

describe('resolveAccountCandidates (A5 — deterministic, no over-matching)', () => {
  it('returns multiple candidates on ambiguity instead of guessing', () => {
    const l = [...ledger, { account: 'Party: Acme Industries', balance: 100, entries: [] }];
    const c = resolveAccountCandidates('acme', l);
    expect(c.length).toBe(2);
    expect(c).toContain('Party: Acme Corp');
    expect(c).toContain('Party: Acme Industries');
  });
  it('subjects shorter than 3 chars only match exactly', () => {
    expect(resolveAccountCandidates('za', ledger)).toEqual([]); // no fuzzy on 2 chars
    const withShort = [...ledger, { account: 'Party: ZA', balance: 1, entries: [] }];
    expect(resolveAccountCandidates('za', withShort)).toEqual(['Party: ZA']); // exact still fine
  });
  it('prefers the shortest name deterministically ("cash" → Cash over Cash In Hand)', () => {
    const l = [{ account: 'Cash In Hand', balance: 1, entries: [] }, { account: 'Cash', balance: 1, entries: [] }];
    expect(resolveAccount('cash', l)).toBe('Cash');
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
  it('keeps party AR/AP separate from employee balances (B11)', () => {
    const r = outstandingAnswer(ledger, 'both', fmt);
    expect(r.totalReceivable).toBe(5000);      // Acme (Party: only)
    expect(r.totalPayable).toBe(2000);         // Zenith only — staff NOT lumped in
    expect(r.employeePayable).toBe(1500);      // Rahul reported separately
    expect(r.message).toMatch(/owed to staff/i);
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

describe('buildBooksDigest (read-only LLM Q&A digest)', () => {
  const snapshot = {
    ledger,
    profitAndLoss: { revenue: 100000, netProfit: 20000 },
    balanceSheet: { assets: { total: 50000 }, liabilities: { gstPayable: 3000, total: 12000 } },
    trialBalance: { totalDebit: 60000, totalCredit: 60000, isBalanced: true, difference: 0 },
  };
  it('emits a compact digest with statements, balances, receivables/payables, GST/TDS', () => {
    const d = buildBooksDigest(snapshot, { fy: '2026-27', ageing: { receivableTotals: { total: 5000, '90_plus': 1000 }, payableTotals: { total: 3500, '90_plus': 0 } } });
    expect(d.fy).toBe('2026-27');
    expect(d.profit_and_loss.netProfit).toBe(20000);
    expect(d.trial_balance.isBalanced).toBe(true);
    expect(d.gst_payable).toBe(3000);
    expect(d.tds_payable).toBe(4000);
    expect(d.receivables.find((r) => r.name === 'Acme Corp').bal).toBe(5000);
    expect(d.payables.find((r) => r.name === 'Zenith').bal).toBe(2000);
    expect(d.aging.receivable_90plus).toBe(1000);
  });
  it('omits zero-balance accounts and is robust to empty input', () => {
    const d = buildBooksDigest({});
    expect(d.accounts).toEqual([]);
    expect(d.receivables).toEqual([]);
    expect(d.aging).toBe(null);
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
  it('classifies "audit my books" → audit', () => {
    expect(q('audit my books').meta.queryType).toBe('audit');
    expect(q('run a health check').meta.queryType).toBe('audit');
  });
  it('classifies close-readiness questions → close_readiness', () => {
    expect(q('am I ready to close the year').meta.queryType).toBe('close_readiness');
    expect(q('show close checklist').meta.queryType).toBe('close_readiness');
    expect(q('month end status').meta.queryType).toBe('close_readiness');
  });
  it('keeps existing statement queries intact', () => {
    expect(q('show me the balance sheet').meta.queryType).toBe('balance_sheet');
    expect(q('what is the trial balance').meta.queryType).toBe('trial_balance');
    expect(q('cash balance').meta.queryType).toBe('cash_balance');
  });
});
