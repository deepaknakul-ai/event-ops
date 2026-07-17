import { describe, it, expect } from 'vitest';
import { pnlAnswer } from '../src/utils/aiAccountant/queries.js';

describe('pnlAnswer (A1 — the chat P&L must not report Expenses: 0)', () => {
  it('sums COGS + operating expenses (the snapshot has no `expenses` key)', () => {
    const r = pnlAnswer({ revenue: 100000, costOfGoodsSold: 30000, grossProfit: 70000, operatingExpenses: 25000, netProfit: 45000 }, String);
    expect(r.expenses).toBe(55000);
    expect(r.revenue).toBe(100000);
    expect(r.netProfit).toBe(45000);
    expect(r.message).toContain('55000');
    expect(r.message).not.toMatch(/Expenses: 0\b/);
  });

  it('is zero-safe on an empty snapshot', () => {
    const r = pnlAnswer({}, String);
    expect(r).toMatchObject({ revenue: 0, expenses: 0, netProfit: 0 });
  });
});
