import { describe, it, expect } from 'vitest';
import { parseDate, stripDate } from '../src/utils/aiAccountant/dates.js';

// Fixed reference date so tests stay deterministic: Saturday 25 Apr 2026.
const NOW = new Date(2026, 3, 25);

describe('parseDate — explicit formats', () => {
  it('parses ISO', () => {
    expect(parseDate('paid on 2026-04-20', NOW)).toEqual({ date: '2026-04-20', matched: '2026-04-20' });
  });
  it('parses DD/MM/YYYY (Indian)', () => {
    expect(parseDate('on 05/01/2026', NOW).date).toBe('2026-01-05');
  });
  it('parses DD-MM-YY', () => {
    expect(parseDate('on 05-01-26', NOW).date).toBe('2026-01-05');
  });
  it('parses "5 Jan 2026"', () => {
    expect(parseDate('5 Jan 2026', NOW).date).toBe('2026-01-05');
  });
  it('parses "5th January"', () => {
    expect(parseDate('5th January', NOW).date).toBe('2026-01-05');
  });
  it('parses "Jan 5"', () => {
    expect(parseDate('Jan 5', NOW).date).toBe('2026-01-05');
  });
});

describe('parseDate — relative', () => {
  it('today', () => {
    expect(parseDate('paid today', NOW).date).toBe('2026-04-25');
  });
  it('yesterday', () => {
    expect(parseDate('yesterday got 5000', NOW).date).toBe('2026-04-24');
  });
  it('day before yesterday', () => {
    expect(parseDate('day before yesterday', NOW).date).toBe('2026-04-23');
  });
  it('tomorrow', () => {
    expect(parseDate('tomorrow', NOW).date).toBe('2026-04-26');
  });
  it('3 days ago', () => {
    expect(parseDate('3 days ago', NOW).date).toBe('2026-04-22');
  });
  it('2 weeks ago', () => {
    expect(parseDate('paid 2 weeks ago', NOW).date).toBe('2026-04-11');
  });
  it('1 month ago', () => {
    expect(parseDate('1 month ago', NOW).date).toBe('2026-03-25');
  });
  it('in 5 days', () => {
    expect(parseDate('in 5 days', NOW).date).toBe('2026-04-30');
  });
});

describe('parseDate — weekdays', () => {
  // 25 Apr 2026 is a Saturday (day=6).
  it('last Friday', () => {
    expect(parseDate('last Friday', NOW).date).toBe('2026-04-24');
  });
  it('next Monday', () => {
    expect(parseDate('next Monday', NOW).date).toBe('2026-04-27');
  });
});

describe('parseDate — "on <nth>"', () => {
  it('on the 5th', () => {
    expect(parseDate('paid on the 5th', NOW).date).toBe('2026-04-05');
  });
});

describe('parseDate — fallbacks', () => {
  it('returns null when no date found', () => {
    expect(parseDate('paid 5000 to Acme', NOW)).toBeNull();
  });
});

describe('stripDate', () => {
  it('removes matched phrase', () => {
    expect(stripDate('yesterday paid 5000 to Acme', NOW)).toBe('paid 5000 to Acme');
  });
  it('leaves text unchanged when no date', () => {
    expect(stripDate('paid 5000', NOW)).toBe('paid 5000');
  });
});
