import { describe, it, expect } from 'vitest';
import { getProjectGSTBreakdown, amountToWordsINR, round2 } from '../src/utils/helpers.js';

const ORG_DELHI = '07AAACO0000A1Z5';      // state 07
const CLIENT_DELHI = '07AABCA1234A1Z0';   // state 07 → intra
const CLIENT_MH = '27AAGFE3742B1ZT';      // state 27 → inter

describe('getProjectGSTBreakdown — place of supply', () => {
  const itemized = { items: [{ item_name: 'Sound', amount: 100000, gst_rate: 18, days: 1, qty: 1 }] };

  it('intra-state → CGST + SGST (half each), no IGST', () => {
    const bd = getProjectGSTBreakdown(itemized, ORG_DELHI, CLIENT_DELHI);
    expect(bd.supplyType).toBe('CGST_SGST');
    expect(round2(bd.totals.cgstAmt)).toBe(9000);
    expect(round2(bd.totals.sgstAmt)).toBe(9000);
    expect(round2(bd.totals.igstAmt)).toBe(0);
    expect(round2(bd.totals.cgstAmt + bd.totals.sgstAmt)).toBe(18000);
  });

  it('inter-state → IGST only', () => {
    const bd = getProjectGSTBreakdown(itemized, ORG_DELHI, CLIENT_MH);
    expect(bd.supplyType).toBe('IGST');
    expect(round2(bd.totals.igstAmt)).toBe(18000);
    expect(bd.totals.cgstAmt).toBe(0);
    expect(bd.totals.sgstAmt).toBe(0);
  });

  it('no client GSTIN → defaults to intra-state when org state known', () => {
    const bd = getProjectGSTBreakdown(itemized, ORG_DELHI, '');
    expect(bd.supplyType).toBe('CGST_SGST');
  });
});

describe('getProjectGSTBreakdown — rate-wise package cost', () => {
  it('splits a package across item GST slabs (package = items sum)', () => {
    const p = {
      package_cost: 120000,
      items: [
        { item_name: 'Equipment', amount: 100000, gst_rate: 18 },
        { item_name: 'Catering', amount: 20000, gst_rate: 5 },
      ],
    };
    const bd = getProjectGSTBreakdown(p, ORG_DELHI, CLIENT_MH); // inter → IGST
    expect(round2(bd.totals.taxable)).toBe(120000);
    expect(round2(bd.totals.igstAmt)).toBe(19000); // 18000 + 1000
    expect(round2(bd.totals.total)).toBe(139000);
    // two slabs emitted
    expect(bd.items.length).toBe(2);
  });

  it('apportions a higher agreed package proportionally, taxable sums to package', () => {
    const p = {
      package_cost: 130000,
      items: [
        { item_name: 'Equipment', amount: 100000, gst_rate: 18 },
        { item_name: 'Catering', amount: 20000, gst_rate: 5 },
      ],
    };
    const bd = getProjectGSTBreakdown(p, ORG_DELHI, CLIENT_DELHI); // intra
    expect(round2(bd.totals.taxable)).toBe(130000);
    // GST between the two single-rate extremes (5%..18% of 130000)
    const gst = bd.totals.cgstAmt + bd.totals.sgstAmt;
    expect(gst).toBeGreaterThan(6500);
    expect(gst).toBeLessThan(23400);
    expect(round2(bd.totals.cgstAmt)).toBe(round2(bd.totals.sgstAmt));
  });

  it('falls back to single package_cost_gst when there are no items', () => {
    const p = { package_cost: 50000, package_cost_gst: 18, items: [] };
    const bd = getProjectGSTBreakdown(p, ORG_DELHI, CLIENT_MH);
    expect(bd.items.length).toBe(1);
    expect(round2(bd.totals.igstAmt)).toBe(9000);
    expect(round2(bd.totals.total)).toBe(59000);
  });
});

describe('amountToWordsINR', () => {
  it('matches the Indian-system wording', () => {
    expect(amountToWordsINR(169431)).toBe('One Lakh Sixty Nine Thousand Four Hundred Thirty One Rupees only');
    expect(amountToWordsINR(10000000)).toBe('One Crore Rupees only');
    expect(amountToWordsINR(100.5)).toBe('One Hundred Rupees and Fifty Paise only');
    expect(amountToWordsINR(0)).toBe('Zero Rupees only');
  });
});
