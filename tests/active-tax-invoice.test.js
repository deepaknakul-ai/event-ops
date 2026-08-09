import { describe, it, expect } from 'vitest';
import { isActiveTaxInvoice } from '../src/utils/helpers.js';

// There were eight divergent "is this invoice live?" checks. Two (both server-side)
// were broken: `(status || 'active') !== 'cancelled'` never matched the 'Cancelled'
// that TaxInvoices.jsx actually writes, so a cancelled invoice kept appearing in the
// client portal AND kept generating payment reminders. The client-side ones compared
// `!== 'Cancelled'` exactly — case-sensitive and blind to voided/void/rejected.

describe('isActiveTaxInvoice', () => {
  it('excludes the exact status the app writes on cancel', () => {
    // TaxInvoices.jsx:582 writes status: 'Cancelled'
    expect(isActiveTaxInvoice('Cancelled')).toBe(false);
  });

  it('pins the old server bug: a raw !== comparison let it through', () => {
    const cancelled = 'Cancelled';
    expect((cancelled || 'active') !== 'cancelled').toBe(true); // the OLD check said "live"
    expect(isActiveTaxInvoice(cancelled)).toBe(false);          // the truth
  });

  it('is case-insensitive in both directions', () => {
    for (const v of ['cancelled', 'CANCELLED', 'CaNcElLeD']) {
      expect(isActiveTaxInvoice(v)).toBe(false);
    }
  });

  it('also excludes voided / void / rejected (the client checks missed these)', () => {
    for (const v of ['voided', 'Voided', 'void', 'Void', 'rejected', 'Rejected']) {
      expect(isActiveTaxInvoice(v)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(isActiveTaxInvoice('  Cancelled  ')).toBe(false);
  });

  it('treats a live invoice as live', () => {
    for (const v of ['Active', 'active', 'Issued', 'Paid', 'posted']) {
      expect(isActiveTaxInvoice(v)).toBe(true);
    }
  });

  it('treats an ABSENT status as live (legacy invoices predate the field)', () => {
    expect(isActiveTaxInvoice(undefined)).toBe(true);
    expect(isActiveTaxInvoice(null)).toBe(true);
    expect(isActiveTaxInvoice('')).toBe(true);
  });

  it('matches the real production status values (4 Active + 1 absent = all live)', () => {
    expect(['Active', 'Active', 'Active', 'Active', undefined].every(isActiveTaxInvoice)).toBe(true);
  });
});
