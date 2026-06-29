import { describe, it, expect } from 'vitest';
import {
  leaveDaysInRange, splitLeavePaidUnpaid, dailyLeaveRate, paidLeaveDaysInMonth,
} from '../src/utils/helpers.js';

const ENT = { Casual: 12, Sick: 8, Earned: 15 };
const PAID = ['Casual', 'Sick', 'Earned'];
const jun1 = new Date(2026, 5, 1);
const junEnd = new Date(2026, 6, 0, 23, 59, 59);

describe('leaveDaysInRange', () => {
  it('counts inclusive days within range', () => {
    expect(leaveDaysInRange('2026-06-10', '2026-06-12', new Date(2026, 5, 1), new Date(2026, 6, 0))).toBe(3);
  });
  it('returns 0 when fully outside the range', () => {
    expect(leaveDaysInRange('2026-07-01', '2026-07-03', new Date(2026, 5, 1), new Date(2026, 6, 0))).toBe(0);
  });
  it('clips a leave overlapping the range start', () => {
    expect(leaveDaysInRange('2026-05-28', '2026-06-02', new Date(2026, 5, 1), new Date(2026, 6, 0))).toBe(2);
  });
});

describe('splitLeavePaidUnpaid', () => {
  it('fully paid when within balance', () => {
    expect(splitLeavePaidUnpaid(2, 5, true)).toEqual({ paid: 2, lwp: 0 });
  });
  it('splits paid vs loss-of-pay beyond balance', () => {
    expect(splitLeavePaidUnpaid(5, 3, true)).toEqual({ paid: 3, lwp: 2 });
  });
  it('all loss-of-pay when no balance', () => {
    expect(splitLeavePaidUnpaid(3, 0, true)).toEqual({ paid: 0, lwp: 3 });
  });
  it('all loss-of-pay for an unpaid type', () => {
    expect(splitLeavePaidUnpaid(3, 5, false)).toEqual({ paid: 0, lwp: 3 });
  });
});

describe('dailyLeaveRate', () => {
  it('values a day at hourly rate × 8 by default', () => { expect(dailyLeaveRate(100)).toBe(800); });
  it('honours a custom day length', () => { expect(dailyLeaveRate(100, 6)).toBe(600); });
  it('is 0 for missing/zero rate', () => { expect(dailyLeaveRate(0)).toBe(0); expect(dailyLeaveRate(undefined)).toBe(0); });
});

describe('paidLeaveDaysInMonth', () => {
  it('credits approved entitled leave inside the month', () => {
    const leaves = [{ employeeId: 'e1', type: 'Casual', status: 'Approved', startDate: '2026-06-10', endDate: '2026-06-12' }];
    expect(paidLeaveDaysInMonth(leaves, 'e1', jun1, junEnd, PAID, ENT)).toBe(3);
  });
  it('ignores pending (unapproved) leave', () => {
    const leaves = [{ employeeId: 'e1', type: 'Casual', status: 'Pending', startDate: '2026-06-10', endDate: '2026-06-12' }];
    expect(paidLeaveDaysInMonth(leaves, 'e1', jun1, junEnd, PAID, ENT)).toBe(0);
  });
  it('caps at remaining annual quota — excess is loss of pay', () => {
    const leaves = [
      { employeeId: 'e1', type: 'Casual', status: 'Approved', startDate: '2026-01-05', endDate: '2026-01-15' }, // 11 days earlier
      { employeeId: 'e1', type: 'Casual', status: 'Approved', startDate: '2026-06-10', endDate: '2026-06-12' }, // 3 days in June
    ];
    expect(paidLeaveDaysInMonth(leaves, 'e1', jun1, junEnd, PAID, ENT)).toBe(1); // only 1 left in the 12-day quota
  });
  it('pays nothing when the quota was already exhausted before the month', () => {
    const leaves = [
      { employeeId: 'e1', type: 'Earned', status: 'Approved', startDate: '2026-02-01', endDate: '2026-02-15' }, // 15 = full quota
      { employeeId: 'e1', type: 'Earned', status: 'Approved', startDate: '2026-06-05', endDate: '2026-06-06' }, // 2 in June → LWP
    ];
    expect(paidLeaveDaysInMonth(leaves, 'e1', jun1, junEnd, PAID, ENT)).toBe(0);
  });
  it('only counts the queried employee', () => {
    const leaves = [{ employeeId: 'other', type: 'Casual', status: 'Approved', startDate: '2026-06-10', endDate: '2026-06-12' }];
    expect(paidLeaveDaysInMonth(leaves, 'e1', jun1, junEnd, PAID, ENT)).toBe(0);
  });
});
