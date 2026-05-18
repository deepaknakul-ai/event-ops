import { describe, it, expect } from 'vitest';
import { parseDateRange } from '../src/utils/assistant/dates.js';

// Pin "today" so all assertions are deterministic.
// Wed 25 Apr 2026 — start of FY 2026-27.
const TODAY = new Date(2026, 3, 25);

const r = (s) => parseDateRange(s, TODAY);

describe('dates.parseDateRange', () => {
  it('today/yesterday/tomorrow', () => {
    expect(r('today')).toEqual({ start: '2026-04-25', end: '2026-04-25', label: 'today' });
    expect(r('yesterday')).toEqual({ start: '2026-04-24', end: '2026-04-24', label: 'yesterday' });
    expect(r('tomorrow')).toEqual({ start: '2026-04-26', end: '2026-04-26', label: 'tomorrow' });
  });

  it('this week / last week (Mon-Sun)', () => {
    // 25 Apr 2026 = Saturday → week Mon 20 → Sun 26
    expect(r('this week')).toMatchObject({ start: '2026-04-20', end: '2026-04-26' });
    expect(r('last week')).toMatchObject({ start: '2026-04-13', end: '2026-04-19' });
  });

  it('this month / last month / next month', () => {
    expect(r('this month')).toMatchObject({ start: '2026-04-01', end: '2026-04-30' });
    expect(r('last month')).toMatchObject({ start: '2026-03-01', end: '2026-03-31' });
    expect(r('next month')).toMatchObject({ start: '2026-05-01', end: '2026-05-31' });
  });

  it('this year / last year', () => {
    expect(r('this year')).toMatchObject({ start: '2026-01-01', end: '2026-12-31' });
    expect(r('last year')).toMatchObject({ start: '2025-01-01', end: '2025-12-31' });
  });

  it('this FY / last FY (Apr-Mar)', () => {
    expect(r('this FY')).toMatchObject({ start: '2026-04-01', end: '2027-03-31' });
    expect(r('last FY')).toMatchObject({ start: '2025-04-01', end: '2026-03-31' });
    expect(r('current financial year')).toMatchObject({ start: '2026-04-01', end: '2027-03-31' });
  });

  it('explicit FY notation', () => {
    expect(r('FY 2024-25')).toMatchObject({ start: '2024-04-01', end: '2025-03-31' });
    expect(r('FY24-25')).toMatchObject({ start: '2024-04-01', end: '2025-03-31' });
    expect(r('fy 2024')).toMatchObject({ start: '2024-04-01', end: '2025-03-31' });
  });

  it('quarters Q1-Q4 (fiscal)', () => {
    expect(r('Q1')).toMatchObject({ start: '2026-04-01', end: '2026-06-30' });
    expect(r('q2')).toMatchObject({ start: '2026-07-01', end: '2026-09-30' });
    expect(r('Q3')).toMatchObject({ start: '2026-10-01', end: '2026-12-31' });
    expect(r('Q4')).toMatchObject({ start: '2027-01-01', end: '2027-03-31' });
  });

  it('last N days/weeks/months', () => {
    expect(r('last 7 days')).toMatchObject({ start: '2026-04-19', end: '2026-04-25' });
    expect(r('past 30 days')).toMatchObject({ start: '2026-03-27', end: '2026-04-25' });
    expect(r('last 2 weeks')).toMatchObject({ start: '2026-04-12', end: '2026-04-25' });
    expect(r('last 3 months').end).toBe('2026-04-25');
  });

  it('month names with optional year', () => {
    expect(r('jan 2024')).toMatchObject({ start: '2024-01-01', end: '2024-01-31' });
    expect(r('march 2025')).toMatchObject({ start: '2025-03-01', end: '2025-03-31' });
  });

  it('between / from-to', () => {
    expect(r('between 2026-01-01 and 2026-01-31')).toMatchObject({ start: '2026-01-01', end: '2026-01-31' });
    expect(r('from 1 jan to 15 jan')).toMatchObject({ start: '2026-01-01', end: '2026-01-15' });
    // reversed → still normalised
    expect(r('between 15 jan and 1 jan')).toMatchObject({ start: '2026-01-01', end: '2026-01-15' });
  });

  it('since X', () => {
    expect(r('since 1 jan')).toMatchObject({ start: '2026-01-01', end: '2026-04-25' });
    expect(r('since 2025-12-15')).toMatchObject({ start: '2025-12-15', end: '2026-04-25' });
  });

  it('returns null for unrelated text', () => {
    expect(r('show pending expenses')).toBeNull();
    expect(r('')).toBeNull();
    expect(r(undefined)).toBeNull();
  });
});
