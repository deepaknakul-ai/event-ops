import { describe, it, expect } from 'vitest';
import { proposeDepreciation } from '../src/utils/aiAccountant/depreciation.js';

const row = (account, balance) => ({ account, balance });

describe('proposeDepreciation', () => {
  it('proposes WDV depreciation per fixed-asset class at the right rates', () => {
    const r = proposeDepreciation({
      ledger: [
        row('Computer Equipment', 100000),   // 40% → 40000
        row('AV Equipment', 200000),         // 15% → 30000
        row('Furniture & Fixtures', 50000),  // 10% → 5000
        row('Vehicles', 80000),              // 15% → 12000
      ],
      fy: '2026-27',
    });
    expect(r.proposals).toHaveLength(4);
    expect(r.proposals.find((p) => p.account === 'Computer Equipment')).toMatchObject({ rate: 40, amount: 40000 });
    expect(r.proposals.find((p) => p.account === 'AV Equipment')).toMatchObject({ rate: 15, amount: 30000 });
    expect(r.proposals.find((p) => p.account === 'Furniture & Fixtures')).toMatchObject({ rate: 10, amount: 5000 });
    expect(r.total).toBe(87000);
  });

  it('emits one consolidated Dr Depreciation Expense / Cr Accumulated Depreciation entry dated FY-end', () => {
    const r = proposeDepreciation({ ledger: [row('Computer Equipment', 100000)], fy: '2026-27' });
    expect(r.entries).toEqual([{ debitAccount: 'Depreciation Expense', creditAccount: 'Accumulated Depreciation', amount: 40000 }]);
    expect(r.date).toBe('2027-03-31');
    expect(r.parsed).toMatchObject({ intent: 'depreciation', date: '2027-03-31' });
    expect(r.parsed.meta.proposals).toHaveLength(1);
  });

  it('excludes non-fixed-asset accounts, Accumulated Depreciation, and zero balances', () => {
    const r = proposeDepreciation({
      ledger: [
        row('Equipment Hire', 50000),          // Expense — excluded despite "equipment"
        row('Accumulated Depreciation', -30000),
        row('AV Equipment', 0),                // nothing to depreciate
        row('Cash In Hand', 99999),
      ],
      fy: '2026-27',
    });
    expect(r.proposals).toHaveLength(0);
    expect(r.total).toBe(0);
    expect(r.parsed).toBe(null);
  });

  it('flags Land & Building with a split-out-land note', () => {
    const r = proposeDepreciation({ ledger: [row('Land & Building', 1000000)], fy: '2026-27' });
    expect(r.proposals[0]).toMatchObject({ rate: 10, amount: 100000 });
    expect(r.proposals[0].note).toMatch(/land/i);
  });
});
