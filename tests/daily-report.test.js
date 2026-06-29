import { describe, it, expect } from 'vitest';
import { isProjectActiveOnDate, projectDurationDays, getProjectOutsourcing } from '../src/utils/helpers.js';

describe('isProjectActiveOnDate', () => {
  const proj = { status: 'Confirmed', setup_date: '2026-06-10', start_date: '2026-06-10', end_date: '2026-06-12' };
  it('is active inside the window (inclusive boundaries)', () => {
    expect(isProjectActiveOnDate(proj, '2026-06-10')).toBe(true);
    expect(isProjectActiveOnDate(proj, '2026-06-11')).toBe(true);
    expect(isProjectActiveOnDate(proj, '2026-06-12')).toBe(true);
  });
  it('is inactive outside the window', () => {
    expect(isProjectActiveOnDate(proj, '2026-06-09')).toBe(false);
    expect(isProjectActiveOnDate(proj, '2026-06-13')).toBe(false);
  });
  it('spans the earliest setup/start to the latest end', () => {
    const p2 = { setup_date: '2026-06-08', start_date: '2026-06-10', end_date: '2026-06-12' };
    expect(isProjectActiveOnDate(p2, '2026-06-08')).toBe(true);
    expect(isProjectActiveOnDate(p2, '2026-06-07')).toBe(false);
  });
  it('returns false when the project has no dates', () => {
    expect(isProjectActiveOnDate({ status: 'Confirmed' }, '2026-06-11')).toBe(false);
  });
});

describe('projectDurationDays', () => {
  it('counts inclusive window days', () => {
    expect(projectDurationDays({ setup_date: '2026-06-10', end_date: '2026-06-12' })).toBe(3);
  });
  it('defaults to 1 when only a start date exists', () => {
    expect(projectDurationDays({ start_date: '2026-06-10' })).toBe(1);
  });
  it('defaults to 1 when dates are missing', () => {
    expect(projectDurationDays({})).toBe(1);
  });
});

describe('getProjectOutsourcing', () => {
  it('sums active PO effective cost + unlinked vendor allocations', () => {
    const p = {
      purchase_orders: [
        { id: 'po1', status: 'Sent', amount: 1180, gst_amount: 180, subtotal: 1000 },
        { id: 'po2', status: 'Cancelled', amount: 5000, gst_amount: 0, subtotal: 5000 },
      ],
      vendor_allocations: [
        { id: 'a1', tax_amount: 500 },              // unlinked → counted
        { id: 'a2', po_id: 'po1', tax_amount: 999 }, // linked to a PO → not double-counted
      ],
    };
    expect(getProjectOutsourcing(p)).toBe(1680); // 1180 (po1) + 500 (a1); po2 cancelled, a2 linked
  });
  it('is 0 with no outsourcing', () => {
    expect(getProjectOutsourcing({})).toBe(0);
  });
});
