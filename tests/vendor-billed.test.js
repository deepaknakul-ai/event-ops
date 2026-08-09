import { describe, it, expect } from 'vitest';
import { getVendorBilled, getProjectOutsourcing } from '../src/utils/helpers.js';

const V = 'v1';

// The vendor dashboard and client portal used to sum raw vendor_allocations only,
// while the project P&L and the books used PO-first precedence. Three concrete
// disagreements followed; each is pinned below.

describe('getVendorBilled — one canonical basis', () => {
  it('counts a PO even when the vendor has no allocation (was: showed ZERO owing)', () => {
    const projects = [{
      id: 'p1', purchase_orders: [{ id: 'po1', vendor_id: V, status: 'Sent', amount: 11800, gst_amount: 1800, subtotal: 10000 }],
      vendor_allocations: [],
    }];
    expect(getVendorBilled(projects, V)).toEqual({ total: 11800, base: 10000 });
  });

  it('does NOT double-count an allocation that was converted into a PO', () => {
    const projects = [{
      id: 'p1',
      purchase_orders: [{ id: 'po1', vendor_id: V, status: 'Sent', amount: 11800, gst_amount: 1800, subtotal: 10000 }],
      vendor_allocations: [{ vendor_id: V, po_id: 'po1', amount: 9000, tax_amount: 10620 }],
    }];
    // The stale allocation price (10,620) must not appear — the PO supersedes it.
    expect(getVendorBilled(projects, V).total).toBe(11800);
  });

  it('still counts an allocation that has NOT been converted', () => {
    const projects = [{
      id: 'p1', purchase_orders: [],
      vendor_allocations: [{ vendor_id: V, amount: 9000, tax_amount: 10620 }],
    }];
    expect(getVendorBilled(projects, V)).toEqual({ total: 10620, base: 9000 });
  });

  it('ignores cancelled POs and other vendors', () => {
    const projects = [{
      id: 'p1',
      purchase_orders: [
        { id: 'po1', vendor_id: V, status: 'Cancelled', amount: 50000, gst_amount: 0, subtotal: 50000 },
        { id: 'po2', vendor_id: 'other', status: 'Sent', amount: 70000, gst_amount: 0, subtotal: 70000 },
      ],
      vendor_allocations: [{ vendor_id: 'other', amount: 5000, tax_amount: 5900 }],
    }];
    expect(getVendorBilled(projects, V)).toEqual({ total: 0, base: 0 });
  });

  it('prefers an ACCEPTED vendor invoice over the committed PO price', () => {
    const projects = [{
      id: 'p1',
      purchase_orders: [{
        id: 'po1', vendor_id: V, status: 'Sent', amount: 11800, gst_amount: 1800, subtotal: 10000,
        vendor_invoice: { invoice_no: 'VI-1', status: 'Accepted', base_amount: 12000, gst_amount: 2160, total_amount: 14160 },
      }],
      vendor_allocations: [],
    }];
    expect(getVendorBilled(projects, V).total).toBe(14160);
  });

  it('ignores a PENDING vendor invoice and keeps the committed PO price', () => {
    const projects = [{
      id: 'p1',
      purchase_orders: [{
        id: 'po1', vendor_id: V, status: 'Sent', amount: 11800, gst_amount: 1800, subtotal: 10000,
        vendor_invoice: { invoice_no: 'VI-1', status: 'Pending', base_amount: 99999, gst_amount: 0, total_amount: 99999 },
      }],
      vendor_allocations: [],
    }];
    expect(getVendorBilled(projects, V).total).toBe(11800);
  });

  it('honours a stored 0% GST on a package PO (no re-derivation at the package rate)', () => {
    const projects = [{
      id: 'p1',
      purchase_orders: [{ id: 'po1', vendor_id: V, status: 'Sent', package_cost: 5000, package_cost_gst: 18, gst_amount: 0 }],
      vendor_allocations: [],
    }];
    // gst_amount is explicitly 0 → total is the base, NOT 5000 * 1.18
    expect(getVendorBilled(projects, V)).toEqual({ total: 5000, base: 5000 });
  });

  it('supports an optional branch filter', () => {
    const projects = [{
      id: 'p1', party_company_id: 'primary',
      purchase_orders: [
        { id: 'po1', vendor_id: V, status: 'Sent', party_company_id: 'br1', amount: 1000, gst_amount: 0, subtotal: 1000 },
        { id: 'po2', vendor_id: V, status: 'Sent', party_company_id: 'br2', amount: 2000, gst_amount: 0, subtotal: 2000 },
      ],
      vendor_allocations: [],
    }];
    const onlyBr1 = (row, p) => (row.party_company_id || p.party_company_id || 'primary') === 'br1';
    expect(getVendorBilled(projects, V, onlyBr1).total).toBe(1000);
  });

  it('agrees with getProjectOutsourcing when the project has a single vendor', () => {
    const project = {
      id: 'p1',
      purchase_orders: [{ id: 'po1', vendor_id: V, status: 'Sent', amount: 11800, gst_amount: 1800, subtotal: 10000 }],
      vendor_allocations: [{ vendor_id: V, amount: 3000, tax_amount: 3540 }], // unlinked
    };
    expect(getVendorBilled([project], V).total).toBe(getProjectOutsourcing(project));
  });
});
