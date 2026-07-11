import { describe, it, expect } from 'vitest';
import { sanitizeLlmInvoice } from '../functions/ai-sanitize.js';

const TODAY = { todayISO: '2026-07-11' };

describe('sanitizeLlmInvoice', () => {
  it('normalises a clean intra-state invoice', () => {
    const r = sanitizeLlmInvoice({
      vendor_name: 'Acme Supplies Pvt Ltd', vendor_gstin: '27ABCDE1234F1Z5',
      invoice_no: 'INV-42', invoice_date: '2026-05-10',
      taxable_amount: 10000, gst_rate: 18, cgst_amount: 900, sgst_amount: 900, igst_amount: null,
      gst_amount: 1800, total_amount: 11800, description: 'LED panels',
    }, TODAY);
    expect(r).toMatchObject({
      vendor_name: 'Acme Supplies Pvt Ltd', vendor_gstin: '27ABCDE1234F1Z5',
      invoice_no: 'INV-42', invoice_date: '2026-05-10',
      taxable: 10000, gst_amount: 1800, cgst: 900, sgst: 900, igst: 0,
      supply_type: 'intra', gst_rate: 18, total: 11800,
    });
    expect(r.warnings).toHaveLength(0);
  });

  it('infers inter-state from IGST', () => {
    const r = sanitizeLlmInvoice({ vendor_name: 'X', invoice_no: '1', invoice_date: '2026-05-10', taxable_amount: 1000, igst_amount: 180, gst_amount: 180 }, TODAY);
    expect(r.supply_type).toBe('inter');
    expect(r.igst).toBe(180);
  });

  it('drops a malformed GSTIN with a warning', () => {
    const r = sanitizeLlmInvoice({ vendor_name: 'X', vendor_gstin: 'NOTAGSTIN', invoice_no: '1', invoice_date: '2026-05-10', taxable_amount: 1000, gst_amount: 0 }, TODAY);
    expect(r.vendor_gstin).toBe('');
    expect(r.warnings.some((w) => /GSTIN/.test(w))).toBe(true);
  });

  it('blanks an out-of-range invoice date with a warning', () => {
    const r = sanitizeLlmInvoice({ vendor_name: 'X', invoice_no: '1', invoice_date: '1990-01-01', taxable_amount: 1000, gst_amount: 0 }, TODAY);
    expect(r.invoice_date).toBe('');
    expect(r.warnings.some((w) => /date/i.test(w))).toBe(true);
  });

  it('reconciles a GST total that disagrees with the CGST+SGST+IGST split', () => {
    const r = sanitizeLlmInvoice({ vendor_name: 'X', invoice_no: '1', invoice_date: '2026-05-10', taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90, gst_amount: 5 }, TODAY);
    expect(r.gst_amount).toBe(180); // split sum wins
    expect(r.supply_type).toBe('intra');
    expect(r.warnings.some((w) => /did not match/.test(w))).toBe(true);
  });

  it('nulls a non-standard gst_rate and warns on an empty supplier name', () => {
    const r = sanitizeLlmInvoice({ vendor_name: '', invoice_no: '1', invoice_date: '2026-05-10', taxable_amount: 1000, gst_rate: 17, gst_amount: 170 }, TODAY);
    expect(r.gst_rate).toBeNull();
    expect(r.warnings.some((w) => /supplier name/i.test(w))).toBe(true);
  });

  it('throws only on a non-object result', () => {
    expect(() => sanitizeLlmInvoice(null)).toThrow();
    expect(() => sanitizeLlmInvoice('nope')).toThrow();
    expect(() => sanitizeLlmInvoice([])).toThrow();
  });
});
