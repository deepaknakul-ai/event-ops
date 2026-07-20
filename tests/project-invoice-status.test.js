import { describe, expect, it } from 'vitest';
import { getProjectInvoiceReference, isProjectInvoiced } from '../src/utils/helpers';

describe('isProjectInvoiced', () => {
  it.each([
    'Invoiced',
    'Clubbed Invoice',
    'Clubbed Invoiced',
    ' clubbed   invoice ',
  ])('recognizes %j as invoiced', (status) => {
    expect(isProjectInvoiced(status)).toBe(true);
  });

  it.each(['Not Invoiced', '', null, undefined, 'Cancelled'])('does not treat %j as invoiced', (status) => {
    expect(isProjectInvoiced(status)).toBe(false);
  });
});

describe('getProjectInvoiceReference', () => {
  it('uses project-level invoice metadata when no tax-invoice linkage exists', () => {
    expect(getProjectInvoiceReference({
      invoice_status: 'Clubbed Invoice',
      invoice_no: ' GST 26-27/008 ',
      invoice_date: '2026-07-17',
      tax_invoice_id: '',
    })).toEqual({ invoiceNo: 'GST 26-27/008', invoiceDate: '2026-07-17' });
  });

  it('does not turn an unbilled project into an invoice row from a stale number', () => {
    expect(getProjectInvoiceReference({
      invoice_status: 'Not Invoiced',
      invoice_no: 'OLD-001',
      invoice_date: '2026-01-01',
    })).toBeNull();
  });
});