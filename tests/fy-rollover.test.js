import { describe, it, expect } from 'vitest';
import {
  computeFyRolloverRows, rolloverImbalance,
  PL_CLOSING_ACCOUNT, RETAINED_EARNINGS_ACCOUNT,
} from '../src/utils/fyRollover.js';

// Ledger convention: balance = debit − credit (equity sits on the credit side, so
// its balance is negative). Every opening balance is posted against the
// 'Opening Balance Equity' contra, so ANY net imbalance in the rollover set is
// silently absorbed there — which is exactly how the year's profit went missing.

const TYPES = {
  Bank: 'Asset',
  'Input GST Credit': 'Asset',
  'Output GST Payable': 'Liability',
  'Party: ACME': 'Asset',
  'Retained Earnings': 'Equity',
  [PL_CLOSING_ACCOUNT]: 'Equity',
  'Sales Revenue': 'Income',
  'Purchase Expense': 'Expense',
};
const typeOf = (a) => TYPES[a] || 'Asset';

describe('computeFyRolloverRows', () => {
  it('carries assets and liabilities, and never carries nominal accounts', () => {
    const rows = computeFyRolloverRows({
      ledger: [
        { account: 'Bank', balance: 100000 },
        { account: 'Output GST Payable', balance: -25000 },
        { account: 'Sales Revenue', balance: -400000 },   // nominal — resets
        { account: 'Purchase Expense', balance: 150000 }, // nominal — resets
      ],
      typeOf, netProfit: 0, hasTransfer: false,
    });
    expect(rows.map((r) => r.account).sort()).toEqual(['Bank', 'Output GST Payable']);
  });

  it('drops the Profit And Loss Closing clearing account', () => {
    const rows = computeFyRolloverRows({
      ledger: [
        { account: 'Bank', balance: 100000 },
        { account: PL_CLOSING_ACCOUNT, balance: 250000 },
      ],
      typeOf, netProfit: 0, hasTransfer: false,
    });
    expect(rows.find((r) => r.account === PL_CLOSING_ACCOUNT)).toBeUndefined();
  });

  it('credits the year profit to Retained Earnings (balance goes MORE negative)', () => {
    const rows = computeFyRolloverRows({
      ledger: [{ account: 'Bank', balance: 100000 }],
      typeOf, netProfit: 100000, hasTransfer: true,
    });
    const re = rows.find((r) => r.account === RETAINED_EARNINGS_ACCOUNT);
    expect(re).toBeTruthy();
    expect(re.balance).toBe(-100000); // Cr 100000
  });

  it('accumulates onto an existing Retained Earnings balance', () => {
    const rows = computeFyRolloverRows({
      ledger: [
        { account: 'Bank', balance: 300000 },
        { account: RETAINED_EARNINGS_ACCOUNT, balance: -200000 }, // Cr 200000 b/f
      ],
      typeOf, netProfit: 100000, hasTransfer: true,
    });
    expect(rows.find((r) => r.account === RETAINED_EARNINGS_ACCOUNT).balance).toBe(-300000);
  });

  it('debits Retained Earnings for a LOSS year', () => {
    const rows = computeFyRolloverRows({
      ledger: [{ account: 'Bank', balance: 50000 }],
      typeOf, netProfit: -40000, hasTransfer: true,
    });
    expect(rows.find((r) => r.account === RETAINED_EARNINGS_ACCOUNT).balance).toBe(40000); // Dr
  });

  it('a loss that exactly cancels brought-forward profit leaves no RE row', () => {
    const rows = computeFyRolloverRows({
      ledger: [
        { account: 'Bank', balance: 10000 },
        { account: RETAINED_EARNINGS_ACCOUNT, balance: -50000 },
      ],
      typeOf, netProfit: -50000, hasTransfer: true,
    });
    expect(rows.find((r) => r.account === RETAINED_EARNINGS_ACCOUNT)).toBeUndefined();
  });

  it('makes a self-contained year roll forward perfectly balanced', () => {
    // Bank 100000 Dr funded entirely by the year's profit → after the transfer the
    // rollover nets to zero, so Opening Balance Equity absorbs NOTHING.
    const rows = computeFyRolloverRows({
      ledger: [
        { account: 'Bank', balance: 100000 },
        { account: 'Sales Revenue', balance: -100000 },
      ],
      typeOf, netProfit: 100000, hasTransfer: true,
    });
    expect(rolloverImbalance(rows)).toBe(0);
  });
});

describe('regression against the real production close (terms-a005e, FY 2025-26)', () => {
  // Taken from the live backup: 25 rolled rows summing to Dr 8,227,405.01 /
  // Cr 2,692,212.65, with net profit 5,092,926.60 and NO equity row carried.
  const REAL_NET_IMBALANCE = 5535192.36;
  const REAL_NET_PROFIT = 5092926.6;
  const ledger = [
    { account: 'Bank', balance: REAL_NET_IMBALANCE }, // stands in for the 25 A/L rows
    { account: 'Sales Revenue', balance: -REAL_NET_PROFIT },
  ];

  it('OLD behaviour: the profit was never carried, so equity absorbed all of it', () => {
    const rows = computeFyRolloverRows({ ledger, typeOf, netProfit: REAL_NET_PROFIT, hasTransfer: false });
    expect(rows.find((r) => r.account === RETAINED_EARNINGS_ACCOUNT)).toBeUndefined();
    expect(rolloverImbalance(rows)).toBeCloseTo(REAL_NET_IMBALANCE, 2);
  });

  it('NEW behaviour: the profit lands in Retained Earnings and the plug shrinks by exactly that much', () => {
    const rows = computeFyRolloverRows({ ledger, typeOf, netProfit: REAL_NET_PROFIT, hasTransfer: true });
    const re = rows.find((r) => r.account === RETAINED_EARNINGS_ACCOUNT);
    expect(re.balance).toBeCloseTo(-REAL_NET_PROFIT, 2); // Cr 5,092,926.60
    // Residual 442,265.76 is genuine pre-existing opening equity — not invented here.
    expect(rolloverImbalance(rows)).toBeCloseTo(REAL_NET_IMBALANCE - REAL_NET_PROFIT, 2);
  });
});
