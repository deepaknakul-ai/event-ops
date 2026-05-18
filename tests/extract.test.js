import { describe, it, expect } from 'vitest';
import {
  extractGSTRate,
  splitGSTByRate,
  extractSplitLines,
  extractVoucherNo,
  extractProjectTag,
  GST_RATES,
} from '../src/utils/aiAccountant/extract.js';

describe('extractGSTRate', () => {
  it('defaults to 18 when not mentioned', () => {
    expect(extractGSTRate('invoice 5000 to Acme')).toBe(18);
  });
  it('picks explicit 5% / 12% / 28%', () => {
    expect(extractGSTRate('invoice with 5% GST')).toBe(5);
    expect(extractGSTRate('12% gst for food')).toBe(12);
    expect(extractGSTRate('28 percent tax')).toBe(28);
  });
  it('detects GST@18', () => {
    expect(extractGSTRate('gst @ 18')).toBe(18);
  });
  it('handles "nil gst" / "exempt" / "no GST"', () => {
    expect(extractGSTRate('nil gst invoice')).toBe(0);
    expect(extractGSTRate('exempt supply')).toBe(0);
    expect(extractGSTRate('invoice without gst')).toBe(0);
  });
  it('exposes GST_RATES table', () => {
    expect(GST_RATES).toEqual([0, 5, 12, 18, 28]);
  });
});

describe('splitGSTByRate', () => {
  it('splits 118 at 18% into 100 + 18', () => {
    expect(splitGSTByRate(118, 18)).toEqual({ taxable: 100, gst: 18, rate: 18 });
  });
  it('splits 10500 at 5%', () => {
    expect(splitGSTByRate(10500, 5)).toEqual({ taxable: 10000, gst: 500, rate: 5 });
  });
  it('splits 11200 at 12%', () => {
    expect(splitGSTByRate(11200, 12)).toEqual({ taxable: 10000, gst: 1200, rate: 12 });
  });
  it('splits 12800 at 28%', () => {
    expect(splitGSTByRate(12800, 28)).toEqual({ taxable: 10000, gst: 2800, rate: 28 });
  });
  it('rate 0 returns full amount taxable with no GST', () => {
    expect(splitGSTByRate(5000, 0)).toEqual({ taxable: 5000, gst: 0, rate: 0 });
  });
});

describe('extractSplitLines', () => {
  it('splits "5000 travel + 2000 food"', () => {
    const lines = extractSplitLines('spent 5000 on travel + 2000 on food');
    expect(lines).toHaveLength(2);
    expect(lines[0].amount).toBe(5000);
    expect(lines[0].description.toLowerCase()).toContain('travel');
    expect(lines[1].amount).toBe(2000);
    expect(lines[1].description.toLowerCase()).toContain('food');
  });

  it('splits "5000 travel and 2000 food"', () => {
    const lines = extractSplitLines('5000 travel and 2000 food');
    expect(lines).toHaveLength(2);
  });

  it('splits on commas', () => {
    const lines = extractSplitLines('3k internet, 2k phone, 1k stationery');
    expect(lines).toHaveLength(3);
    expect(lines[0].amount).toBe(3000);
    expect(lines[2].amount).toBe(1000);
  });

  it('returns [] for single item', () => {
    expect(extractSplitLines('paid 5000 for travel')).toEqual([]);
  });
});

describe('extractVoucherNo', () => {
  it('parses JV-0042', () => {
    expect(extractVoucherNo('reverse JV-0042 please')).toBe('JV-0042');
  });
  it('parses JV42 (pads to 4)', () => {
    expect(extractVoucherNo('reverse JV42')).toBe('JV-0042');
  });
  it('parses FY-style voucher', () => {
    expect(extractVoucherNo('cancel voucher 2026-27/0042')).toMatch(/2026-27.0042/);
  });
  it('returns null when absent', () => {
    expect(extractVoucherNo('reverse something')).toBeNull();
  });
});

describe('extractProjectTag', () => {
  it('parses #P-123', () => {
    expect(extractProjectTag('spent 5000 #P-123')).toBe('P-123');
  });
  it('parses #123', () => {
    expect(extractProjectTag('spent 5000 #123 on travel')).toBe('P-123');
  });
  it('parses "project ABC Launch"', () => {
    expect(extractProjectTag('spent 5000 on project ABC Launch travel')).toMatch(/^ABC/i);
  });
  it('returns null when no project mentioned', () => {
    expect(extractProjectTag('spent 5000 on travel')).toBeNull();
  });
});
