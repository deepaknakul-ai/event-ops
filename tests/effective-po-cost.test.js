import { describe, it, expect } from 'vitest';
import { getEffectivePOCost } from '../src/utils/helpers.js';

// The cost waterfall for a PO: verified invoice actuals supersede the committed
// PO price. The NEW invoice flow (Outsourcing "Create Invoice (PI)") strips the
// legacy embedded vendor_invoice off the PO and stores a purchase_invoices doc +
// a slim summary stamped on the PO. Before this fix getEffectivePOCost knew only
// the embedded flow, so a verified ₹2,00,000 invoice against a ₹3,00,000 PO
// never superseded it — project P&L, vendor payable, referral commission and the
// vendor portal all kept the committed PO figure.

const basePO = {
  id: 'po1', po_no: 'PO/2026/001', vendor_id: 'v1', status: 'Sent',
  amount: 354000, subtotal: 300000, gst_amount: 54000,
};

describe('level 2 — PO committed cost (unchanged behaviour)', () => {
  it('itemised PO', () => {
    expect(getEffectivePOCost(basePO)).toEqual({ base: 300000, gst: 54000, total: 354000, source: 'po' });
  });

  it('package PO honours a stored 0 GST (0% stays 0%)', () => {
    const po = { id: 'p', package_cost: 50000, package_cost_gst: 0, gst_amount: 0 };
    expect(getEffectivePOCost(po)).toEqual({ base: 50000, gst: 0, total: 50000, source: 'po' });
  });

  it('null PO', () => {
    expect(getEffectivePOCost(null).source).toBe('none');
  });
});

describe('level 1b — legacy embedded vendor_invoice (unchanged behaviour)', () => {
  it('Accepted/Verified embedded invoice supersedes the PO', () => {
    for (const status of ['Accepted', 'Verified']) {
      const po = { ...basePO, vendor_invoice: { status, base_amount: 180000, gst_amount: 32400, total_amount: 212400 } };
      expect(getEffectivePOCost(po)).toEqual({ base: 180000, gst: 32400, total: 212400, source: 'invoice' });
    }
  });

  it('a Disputed/Received embedded invoice does NOT', () => {
    for (const status of ['Disputed', 'Received', 'Rejected']) {
      const po = { ...basePO, vendor_invoice: { status, base_amount: 1, gst_amount: 0, total_amount: 1 } };
      expect(getEffectivePOCost(po).source).toBe('po');
    }
  });
});

describe('level 1a — linked standalone Purchase Invoice (the fix)', () => {
  const verifiedPI = { id: 'pi9', linked_po_id: 'po1', status: 'Verified', amount: 170000, gst_amount: 30600 };

  it('a Verified PI resolved from the collection supersedes the PO', () => {
    const eff = getEffectivePOCost({ ...basePO, purchase_invoice_id: 'pi9' }, [verifiedPI]);
    expect(eff).toEqual({ base: 170000, gst: 30600, total: 200600, source: 'invoice' });
  });

  it('resolves by the PI\'s linked_po_id even when the PO carries no pointer (Purchases-page linking)', () => {
    const eff = getEffectivePOCost(basePO, [verifiedPI]);
    expect(eff.source).toBe('invoice');
    expect(eff.total).toBe(200600);
  });

  it('a Pending PI does NOT supersede — the committed PO price stands', () => {
    const eff = getEffectivePOCost({ ...basePO, purchase_invoice_id: 'pi9' }, [{ ...verifiedPI, status: 'Pending' }]);
    expect(eff).toMatchObject({ total: 354000, source: 'po' });
  });

  it('a Rejected PI does NOT supersede', () => {
    expect(getEffectivePOCost(basePO, [{ ...verifiedPI, status: 'Rejected' }]).source).toBe('po');
  });

  it('falls back to the stamped summary when the caller has no collection', () => {
    const po = {
      ...basePO,
      purchase_invoice_id: 'pi9',
      purchase_invoice_summary: { invoice_ref: 'VND/77', total: 200600, amount: 170000, gst_amount: 30600, status: 'Verified' },
    };
    expect(getEffectivePOCost(po)).toEqual({ base: 170000, gst: 30600, total: 200600, source: 'invoice' });
  });

  it('a Pending stamped summary does NOT supersede', () => {
    const po = {
      ...basePO,
      purchase_invoice_id: 'pi9',
      purchase_invoice_summary: { total: 200600, amount: 170000, gst_amount: 30600, status: 'Pending' },
    };
    expect(getEffectivePOCost(po).source).toBe('po');
  });

  it('derives the split from a legacy {total,status}-only summary', () => {
    const po = {
      ...basePO,
      purchase_invoice_id: 'pi9',
      purchase_invoice_summary: { total: 200600, status: 'Verified' },
    };
    const eff = getEffectivePOCost(po);
    expect(eff.total).toBe(200600);
    expect(eff.base + eff.gst).toBeCloseTo(200600, 2);
    expect(eff.source).toBe('invoice');
  });

  it('the LIVE doc beats a stale stamped summary — including by saying no', () => {
    // Summary still says Verified, but the PI has since been moved to Rejected.
    const po = {
      ...basePO,
      purchase_invoice_id: 'pi9',
      purchase_invoice_summary: { total: 999999, amount: 999999, gst_amount: 0, status: 'Verified' },
    };
    const eff = getEffectivePOCost(po, [{ ...verifiedPI, status: 'Rejected' }]);
    expect(eff).toMatchObject({ total: 354000, source: 'po' }); // NOT 999999
  });

  it('accepts an already-resolved PI object as the second argument', () => {
    expect(getEffectivePOCost(basePO, verifiedPI).total).toBe(200600);
  });

  it('a dangling pointer (PI deleted, stamp cleared) degrades to the PO price', () => {
    expect(getEffectivePOCost({ ...basePO, purchase_invoice_id: 'gone' }, []).source).toBe('po');
  });

  it('a 0% PI keeps GST at 0', () => {
    const eff = getEffectivePOCost(basePO, [{ ...verifiedPI, amount: 50000, gst_amount: 0 }]);
    expect(eff).toEqual({ base: 50000, gst: 0, total: 50000, source: 'invoice' });
  });
});
