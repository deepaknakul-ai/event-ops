import { describe, it, expect } from 'vitest';
import { resolvePurchaseGst, resolvePurchaseSupplyType, resolveSalesGst, stateCodeOf } from '../src/utils/gstSupply.js';

const ORG_DELHI = '07AAACO0000A1Z5';   // state 07
const VENDOR_DELHI = '07AABCA1234A1Z0'; // state 07 → intra
const VENDOR_MH = '27AAGFE3742B1ZT';    // state 27 → inter

describe('stateCodeOf', () => {
  it('takes the first two characters, tolerating blanks', () => {
    expect(stateCodeOf(ORG_DELHI)).toBe('07');
    expect(stateCodeOf('')).toBe('');
    expect(stateCodeOf(null)).toBe('');
  });
});

describe('resolvePurchaseSupplyType', () => {
  it('trusts a stored intra/inter', () => {
    expect(resolvePurchaseSupplyType('inter', ORG_DELHI, VENDOR_DELHI)).toBe('inter');
    expect(resolvePurchaseSupplyType('intra', ORG_DELHI, VENDOR_MH)).toBe('intra');
  });
  it('derives from state codes when stored is unknown/missing', () => {
    expect(resolvePurchaseSupplyType('unknown', ORG_DELHI, VENDOR_MH)).toBe('inter');
    expect(resolvePurchaseSupplyType(undefined, ORG_DELHI, VENDOR_DELHI)).toBe('intra');
  });
  it('treats an unregistered vendor as intra (the app B2C convention)', () => {
    expect(resolvePurchaseSupplyType('unknown', ORG_DELHI, '')).toBe('intra');
  });
  it('never returns unknown — GST must still be split even with no org GSTIN', () => {
    expect(resolvePurchaseSupplyType('unknown', '', '')).toBe('intra');
  });
});

describe('resolvePurchaseGst — THE REGRESSION: inter-state ITC filed under the wrong heads', () => {
  // Reproduces the live defect. purchase_invoices store supply_type 'inter';
  // the report compared it against the SALES value 'IGST' — 'inter' !== 'IGST'
  // is true, so it classified the purchase as INTRA and split the ITC into
  // CGST+SGST with IGST zero.
  const interPi = {
    amount: 100000, gst_amount: 18000,
    supply_type: 'inter', gst_cgst: 0, gst_sgst: 0, gst_igst: 18000,
  };

  it('an inter-state purchase claims IGST, never CGST/SGST', () => {
    const r = resolvePurchaseGst(interPi, ORG_DELHI, VENDOR_MH);
    expect(r.supplyType).toBe('inter');
    expect(r.isIntra).toBe(false);
    expect(r.igst).toBe(18000);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
  });

  it('proves the old comparison was inverted', () => {
    // The exact expression that shipped: `pi.supply_type !== 'IGST'` → isIntra
    expect(interPi.supply_type !== 'IGST').toBe(true);     // ...said "intra"
    expect(resolvePurchaseGst(interPi, ORG_DELHI, VENDOR_MH).isIntra).toBe(false); // ...truth
  });

  it('an intra-state purchase splits CGST+SGST exactly, never IGST', () => {
    const r = resolvePurchaseGst(
      { amount: 100000, gst_amount: 18000, supply_type: 'intra', gst_cgst: 9000, gst_sgst: 9000, gst_igst: 0 },
      ORG_DELHI, VENDOR_DELHI,
    );
    expect(r.cgst + r.sgst).toBe(18000);
    expect(r.igst).toBe(0);
  });
});

describe('resolvePurchaseGst — stored split is trusted only when it reconciles', () => {
  it('derives when the stored split is all zeros (an "unknown" PI)', () => {
    const r = resolvePurchaseGst(
      { amount: 50000, gst_amount: 9000, supply_type: 'unknown', gst_cgst: 0, gst_sgst: 0, gst_igst: 0 },
      ORG_DELHI, VENDOR_MH,
    );
    expect(r.splitSource).toBe('derived');
    expect(r.supplyType).toBe('inter'); // recovered from the state codes
    expect(r.igst).toBe(9000);          // ITC is NOT dropped
  });

  it('derives when the stored split sits on the wrong heads for the supply type', () => {
    const r = resolvePurchaseGst(
      { amount: 50000, gst_amount: 9000, supply_type: 'inter', gst_cgst: 4500, gst_sgst: 4500, gst_igst: 0 },
      ORG_DELHI, VENDOR_MH,
    );
    expect(r.splitSource).toBe('derived');
    expect(r.igst).toBe(9000);
    expect(r.cgst).toBe(0);
  });

  it('derives when the stored split does not sum to the GST', () => {
    const r = resolvePurchaseGst(
      { amount: 50000, gst_amount: 9000, supply_type: 'intra', gst_cgst: 1000, gst_sgst: 1000, gst_igst: 0 },
      ORG_DELHI, VENDOR_DELHI,
    );
    expect(r.splitSource).toBe('derived');
    expect(r.cgst + r.sgst).toBe(9000);
  });

  it('splits an odd GST amount so the halves still sum exactly', () => {
    const r = resolvePurchaseGst({ amount: 100, gst_amount: 2.05, supply_type: 'intra' }, ORG_DELHI, VENDOR_DELHI);
    expect(r.cgst + r.sgst).toBeCloseTo(2.05, 2);
  });

  it('a 0% purchase claims nothing at all', () => {
    const r = resolvePurchaseGst({ amount: 20000, gst_amount: 0, supply_type: 'intra' }, ORG_DELHI, VENDOR_DELHI);
    expect(r.gst).toBe(0);
    expect(r.cgst + r.sgst + r.igst).toBe(0);
  });

  it('an unregistered vendor still gets its GST reported (owner rule)', () => {
    const r = resolvePurchaseGst({ amount: 10000, gst_amount: 1800, supply_type: 'unknown' }, ORG_DELHI, '');
    expect(r.cgst + r.sgst + r.igst).toBe(1800);
  });
});

describe('resolveSalesGst — the SALES vocabulary is separate and unaffected', () => {
  it('IGST invoice reports IGST only', () => {
    const r = resolveSalesGst({ taxable: 100000, gst_amount: 18000, supply_type: 'IGST', igst_amount: 18000 });
    expect(r.isIGST).toBe(true);
    expect(r.igst).toBe(18000);
    expect(r.cgst).toBe(0);
  });
  it('CGST_SGST invoice reports both halves', () => {
    const r = resolveSalesGst({ taxable: 100000, gst_amount: 18000, supply_type: 'CGST_SGST', cgst_amount: 9000, sgst_amount: 9000 });
    expect(r.isIGST).toBe(false);
    expect(r.cgst + r.sgst).toBe(18000);
    expect(r.igst).toBe(0);
  });
  it('falls back to an exact halving when the split was never stored', () => {
    const r = resolveSalesGst({ taxable: 100, gst_amount: 2.05, supply_type: 'CGST_SGST' });
    expect(r.cgst + r.sgst).toBeCloseTo(2.05, 2);
  });
});
