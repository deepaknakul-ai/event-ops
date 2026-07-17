import { describe, it, expect } from 'vitest';
import { buildAccountingSnapshot } from '../src/utils/accounting.js';

// B2 — the balance sheet must tie (A = L + E) BY CONSTRUCTION for balanced books,
// with every account classified into a visible line (nothing silently dropped).
const je = (lines) => ({ date: '2026-05-10', status: 'posted', entries: lines });
const snapOf = (entries) => buildAccountingSnapshot({ manualJournalEntries: entries, fyFilter: 'all' });

describe('classification-driven balance sheet', () => {
  const entries = [
    je([{ debitAccount: 'Bank', creditAccount: 'Capital', amount: 500000 }]),                       // capital intro
    je([{ debitAccount: 'Bank', creditAccount: 'Loan from HDFC Bank', amount: 200000 }]),           // loan
    je([
      { debitAccount: 'Party: Acme Corp', creditAccount: 'Sales Revenue', amount: 100000 },          // sale
      { debitAccount: 'Party: Acme Corp', creditAccount: 'Output GST Payable', amount: 18000 },
    ]),
    je([{ debitAccount: 'Computer Equipment', creditAccount: 'Bank', amount: 80000 }]),             // fixed asset
    je([{ debitAccount: 'Depreciation Expense', creditAccount: 'Accumulated Depreciation', amount: 32000 }]),
    je([{ debitAccount: 'Drawings', creditAccount: 'Bank', amount: 20000 }]),
    je([{ debitAccount: 'TDS Receivable', creditAccount: 'Party: Acme Corp', amount: 5000 }]),      // client deducted
    je([{ debitAccount: 'Salary Expense', creditAccount: 'TDS Payable', amount: 10000 }]),          // we deducted
    je([{ debitAccount: 'Petty Cash', creditAccount: 'Bank', amount: 5000 }]),                      // second cash acct
    je([{ debitAccount: 'Bank Charges', creditAccount: 'Bank', amount: 500 }]),                     // expense w/ "Bank"
    je([{ debitAccount: 'Some Alien Account', creditAccount: 'Bank', amount: 700 }]),               // unclassifiable
  ];

  it('A = L + E exactly, with unclassifiedDifference ≈ 0', () => {
    const bs = snapOf(entries).balanceSheet;
    expect(Math.abs(bs.assets.total - bs.totalLiabilitiesAndEquity)).toBeLessThan(0.01);
    expect(Math.abs(bs.unclassifiedDifference)).toBeLessThan(0.01);
  });

  it('classifies every account family into its named line', () => {
    const bs = snapOf(entries).balanceSheet;
    expect(bs.assets.fixedAssets).toBe(80000);
    expect(bs.assets.accumulatedDepreciation).toBe(-32000);       // contra, visible
    expect(bs.assets.tdsReceivable).toBe(5000);
    expect(bs.liabilities.tdsPayable).toBe(10000);
    expect(bs.liabilities.loans).toBe(200000);
    expect(bs.liabilities.gstPayableGross).toBe(18000);
    expect(bs.equity.capital).toBe(500000);
    expect(bs.equity.drawings).toBe(-20000);
  });

  it('Petty Cash counts as cash; Bank Charges does NOT (expense, and hits opex)', () => {
    const snap = snapOf(entries);
    // Bank flows: +500000 +200000 −80000 −20000 −5000 −500 −700 = 593800; + Petty Cash 5000
    expect(snap.balanceSheet.assets.cashAndBank).toBe(598800);
    expect(snap.profitAndLoss.operatingExpenses).toBeGreaterThanOrEqual(500); // charges in P&L
  });

  it('an unclassifiable account lands VISIBLY in an other* line (never dropped)', () => {
    const bs = snapOf(entries).balanceSheet;
    // 'Some Alien Account' guess-falls to Equity → otherEquity (Dr 700 → −700).
    expect(bs.equity.otherEquity).toBeLessThanOrEqual(-700 + 0.01);
  });

  it('closed-FY view: the P&L Closing transfer no longer double-counts profit', () => {
    const closed = [
      ...entries,
      je([{ debitAccount: 'Profit And Loss Closing', creditAccount: 'Retained Earnings', amount: 45000 }]),
    ];
    const bs = snapOf(closed).balanceSheet;
    expect(bs.equity.retainedEarnings).toBe(45000);
    expect(bs.equity.plClosing).toBe(-45000);                     // offsets the transfer
    expect(Math.abs(bs.assets.total - bs.totalLiabilitiesAndEquity)).toBeLessThan(0.01);
  });

  it('legacy Employee Advances with a CREDIT balance now surfaces as employeePayable', () => {
    const bs = snapOf([
      je([{ debitAccount: 'Cash In Hand', creditAccount: 'Employee Advances', amount: 3000 }]),
    ]).balanceSheet;
    expect(bs.liabilities.employeePayable).toBe(3000);            // was floored to 0 before
    expect(bs.assets.employeeAdvances).toBe(0);
    expect(Math.abs(bs.unclassifiedDifference)).toBeLessThan(0.01);
  });
});
