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

describe('getProjectGSTBreakdown — 0% lines must not be coerced to 18% (regression)', () => {
  // Reproduces the real quotation that mis-taxed a 0% Transportation line:
  // equipment + Travel @18%, Transportation @0%. The 0% line must add ZERO GST.
  it('does not tax a 0% logistics (Transportation) line', () => {
    const p = {
      items: [
        { item_name: 'WATCHOUT', amount: 24000, gst_rate: 18 },
        { item_name: 'LED 90', amount: 104400, gst_rate: 18 },
        { item_name: 'LED 42', amount: 48720, gst_rate: 18 },
      ],
      logistics_costs: {
        travel: { amount: 4000, gst: 18 },
        transport: { amount: 20000, gst: 0 }, // 0% — must stay 0%, not become 18%
      },
    };
    const bd = getProjectGSTBreakdown(p, ORG_DELHI, CLIENT_MH); // inter → IGST
    expect(round2(bd.totals.taxable)).toBe(201120);
    expect(round2(bd.totals.igstAmt)).toBe(32601.60);  // NOT 36201.60 (which taxed the 20000 @18%)
    expect(round2(bd.totals.total)).toBe(233721.60);   // subtotal + correct IGST reconciles
  });

  it('a 0% pure PACKAGE (no item mix) is not taxed at 18%', () => {
    const p = { package_cost: 100000, package_cost_gst: 0 }; // exempt lump-sum, no items to learn a rate from
    const bd = getProjectGSTBreakdown(p, ORG_DELHI, CLIENT_MH);
    expect(round2(bd.totals.taxable)).toBe(100000);
    expect(round2(bd.totals.igstAmt)).toBe(0);     // NOT 18000
    expect(round2(bd.totals.total)).toBe(100000);
  });

  it('does not tax a 0% equipment item, and honours an explicit stored gst_amount of 0', () => {
    const p = {
      items: [
        { item_name: 'Equipment', amount: 100000, gst_rate: 18 },
        { item_name: 'Exempt goods', amount: 20000, gst_rate: 0 },              // 0 || 18 trap
        { item_name: 'Zero-rated', amount: 30000, gst_rate: 0, gst_amount: 0 }, // stored 0 must be honoured
      ],
    };
    const bd = getProjectGSTBreakdown(p, ORG_DELHI, CLIENT_MH);
    expect(round2(bd.totals.taxable)).toBe(150000);
    expect(round2(bd.totals.igstAmt)).toBe(18000); // only the 100000 @18%
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
