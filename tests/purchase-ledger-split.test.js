import { describe, it, expect } from 'vitest';
import { buildAccountingSnapshot } from '../src/utils/accounting.js';

const bal = (ledger, name) => {
  const r = ledger.find((x) => x.account === name);
  return r ? r.balance : 0;
};
const inputGstFamily = (ledger) =>
  ledger.filter((r) => /input\s+(c|s|i)?gst|gst\s+credit/i.test(r.account)).reduce((s, r) => s + r.balance, 0);

const basePi = {
  id: 'pi1', pi_no: 'PI-1', invoice_date: '2026-05-10',
  vendor_id: 'v1', vendor_name: 'Acme Supplies',
  amount: 10000, gst_amount: 1800, purchase_mode: 'Credit', status: 'Verified',
};

describe('buildAccountingSnapshot — purchase input-GST split (Slice 4b)', () => {
  it('splits an intra-state PI into Input CGST + Input SGST', () => {
    const snap = buildAccountingSnapshot({
      purchaseInvoices: [{ ...basePi, supply_type: 'intra', gst_cgst: 900, gst_sgst: 900, gst_igst: 0 }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Input CGST')).toBe(900);
    expect(bal(snap.ledger, 'Input SGST')).toBe(900);
    expect(snap.ledger.find((r) => r.account === 'Input GST Credit')).toBeFalsy();
    expect(bal(snap.ledger, 'Purchase Expense')).toBe(10000);
    expect(inputGstFamily(snap.ledger)).toBeCloseTo(1800, 2);
  });

  it('books an inter-state PI entirely to Input IGST', () => {
    const snap = buildAccountingSnapshot({
      purchaseInvoices: [{ ...basePi, supply_type: 'inter', gst_igst: 1800 }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Input IGST')).toBe(1800);
    expect(snap.ledger.find((r) => r.account === 'Input CGST')).toBeFalsy();
    expect(inputGstFamily(snap.ledger)).toBeCloseTo(1800, 2);
  });

  it('keeps a legacy PI (no supply_type) on the single Input GST Credit control account', () => {
    const snap = buildAccountingSnapshot({
      purchaseInvoices: [{ ...basePi }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Input GST Credit')).toBe(1800);
    expect(snap.ledger.find((r) => r.account === 'Input CGST')).toBeFalsy();
    expect(inputGstFamily(snap.ledger)).toBeCloseTo(1800, 2);
  });

  it('preserves the total input-GST (no double-count) whichever way it splits', () => {
    const intra = buildAccountingSnapshot({ purchaseInvoices: [{ ...basePi, supply_type: 'intra' }], fyFilter: 'all' });
    const legacy = buildAccountingSnapshot({ purchaseInvoices: [{ ...basePi }], fyFilter: 'all' });
    expect(inputGstFamily(intra.ledger)).toBeCloseTo(inputGstFamily(legacy.ledger), 2);
  });
});
