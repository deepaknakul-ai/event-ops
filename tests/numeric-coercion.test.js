import { describe, it, expect } from 'vitest';
import {
  toNum, getProjectGrandTotal, getProjectNetTotal, getProjectCommission,
} from '../src/utils/helpers.js';

// Legacy / imported Firestore docs can carry money as a STRING. Before these
// guards, `acc + '11800'` string-concatenated and silently corrupted every
// downstream figure (grand total → margin → referral commission → client PDFs).

describe('toNum', () => {
  it('passes finite numbers through', () => {
    expect(toNum(1500)).toBe(1500);
    expect(toNum(0)).toBe(0);
    expect(toNum(-42.5)).toBe(-42.5);
  });
  it('parses plain numeric strings', () => {
    expect(toNum('11800')).toBe(11800);
    expect(toNum('0')).toBe(0);
  });
  it('tolerates thousands separators / currency symbols / spaces', () => {
    // parseFloat('1,500') === 1 and Number('1,500') === NaN — both wrong.
    expect(toNum('1,500')).toBe(1500);
    expect(toNum('₹1,23,456.78')).toBeCloseTo(123456.78, 2);
    expect(toNum(' 250 ')).toBe(250);
  });
  it('maps nullish / junk / non-finite to 0', () => {
    expect(toNum(undefined)).toBe(0);
    expect(toNum(null)).toBe(0);
    expect(toNum('')).toBe(0);
    expect(toNum('abc')).toBe(0);
    expect(toNum(NaN)).toBe(0);
    expect(toNum(Infinity)).toBe(0);
  });
});

describe('project totals survive string-typed money', () => {
  it('getProjectGrandTotal sums a string item total numerically', () => {
    // pre-fix: '11800' concatenated → 118001180
    expect(getProjectGrandTotal({
      items: [{ total: '11800' }],
      logistics_costs: { transport: { amount: 1000, gst: 18 } },
    })).toBe(12980);
    // numeric control — must agree exactly
    expect(getProjectGrandTotal({
      items: [{ total: 11800 }],
      logistics_costs: { transport: { amount: 1000, gst: 18 } },
    })).toBe(12980);
  });

  it('recovers a comma-formatted legacy total (today it silently read as 1)', () => {
    expect(getProjectGrandTotal({ items: [{ total: '1,500' }] })).toBe(1500);
  });

  it('getProjectNetTotal sums a string item amount numerically', () => {
    expect(getProjectNetTotal({ items: [{ amount: '10000' }, { amount: 5000 }] })).toBe(15000);
  });
});

describe('referral commission survives string-typed money', () => {
  // Mixed shape is the realistic legacy case: `total` and `amount` are written by
  // different code paths, so one can be a string while the other is a number.
  // Pre-fix this UNDER-paid the referrer 10x (grand inflated → paidFraction 0.1).
  it('pays the correct commission when item.total is a string', () => {
    expect(getProjectCommission(
      { id: 'p1', items: [{ total: '118000', amount: 100000, gst_rate: 18, gst_amount: 18000 }] },
      [],
      [{ project_id: 'p1', amount: 118000 }],
      10,
    )).toEqual({
      netProfit: 100000, paid: 118000, grand: 118000, paidFraction: 1, commission: 10000,
    });
  });

  it('is stable when every money field is a string', () => {
    expect(getProjectCommission(
      { id: 'p1', items: [{ total: '118000', amount: '100000', gst_rate: 18, gst_amount: '18000' }] },
      [],
      [{ project_id: 'p1', amount: 118000 }],
      10,
    )).toEqual({
      netProfit: 100000, paid: 118000, grand: 118000, paidFraction: 1, commission: 10000,
    });
  });
});
