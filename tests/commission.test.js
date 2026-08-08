import { describe, it, expect } from 'vitest';
import {
  getProjectDirectCosts, getProjectNetProfit, getProjectPaidToDate, getProjectCommission,
} from '../src/utils/helpers.js';

// getProjectDirectCosts (default, GST-INCLUSIVE) = 18800 (11800 logistics + 2000
// reimbursable + 5000 approved expense; 999 rejected excluded).
// Commission net profit is GST-EXCLUSIVE (GST is not profit): revenue-ex 100000 −
// direct-ex 17000 (10000 logistics base + 2000 + 5000) − outsourcing-ex 10000 (PO
// subtotal) = 73000. (Was 87400 when GST-inclusive; the 14400 delta = output GST
// 18000 − input GST 3600 is government money, not margin.)
const project = {
  id: 'p1',
  package_cost: 100000, package_cost_gst: 18,
  logistics_costs: { road: { amount: 10000, gst: 18 } },
  reimbursable_expenses: [{ amount: 2000 }],
  purchase_orders: [{ id: 'po1', status: 'Sent', amount: 11800, gst_amount: 1800, subtotal: 10000 }],
  vendor_allocations: [],
};
const expenses = [
  { project_id: 'p1', amount: 5000, status: 'Approved' },
  { project_id: 'p1', amount: 999, status: 'Rejected' },   // excluded
  { project_id: 'other', amount: 7777, status: 'Approved' }, // different project
];

describe('getProjectDirectCosts', () => {
  it('sums logistics(incl GST) + reimbursable + dated project expenses, excluding rejected', () => {
    expect(getProjectDirectCosts(project, expenses)).toBe(18800);
  });
});

describe('getProjectNetProfit', () => {
  it('is GST-exclusive revenue − direct − outsourcing (no manpower, no net GST)', () => {
    expect(getProjectNetProfit(project, expenses)).toBe(73000);
  });
  it('is 0 for a null project', () => {
    expect(getProjectNetProfit(null, expenses)).toBe(0);
  });
});

describe('getProjectPaidToDate', () => {
  it('sums payments for the project only', () => {
    const payments = [{ project_id: 'p1', amount: 30000 }, { project_id: 'p1', amount: 29000 }, { project_id: 'x', amount: 999 }];
    expect(getProjectPaidToDate('p1', payments)).toBe(59000);
  });
});

describe('getProjectCommission', () => {
  it('accrues rate% × net profit × fraction paid (half paid)', () => {
    const r = getProjectCommission(project, expenses, [{ project_id: 'p1', amount: 59000 }], 10);
    expect(r.netProfit).toBe(73000);
    expect(r.paidFraction).toBe(0.5);
    expect(r.commission).toBe(3650); // 73000 * 10% * 0.5
  });
  it('reaches full commission when fully paid', () => {
    const r = getProjectCommission(project, expenses, [{ project_id: 'p1', amount: 118000 }], 10);
    expect(r.paidFraction).toBe(1);
    expect(r.commission).toBe(7300); // 73000 * 10%
  });
  it('caps the paid fraction at 1 on overpayment', () => {
    const r = getProjectCommission(project, expenses, [{ project_id: 'p1', amount: 200000 }], 10);
    expect(r.paidFraction).toBe(1);
    expect(r.commission).toBe(7300);
  });
  it('is 0 when nothing is paid', () => {
    const r = getProjectCommission(project, expenses, [], 10);
    expect(r.commission).toBe(0);
  });
});
