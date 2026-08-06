import { describe, expect, it } from 'vitest';
import { normalizeRegion, REGIONS } from '../functions/platform.js';

describe('normalizeRegion', () => {
  it('accepts canonical regions unchanged', () => {
    for (const r of REGIONS) expect(normalizeRegion(r)).toBe(r);
  });

  it('normalizes case and surrounding whitespace to canonical', () => {
    expect(normalizeRegion('india')).toBe('India');
    expect(normalizeRegion('  INDIA  ')).toBe('India');
    expect(normalizeRegion('north america')).toBe('North America');
    expect(normalizeRegion('apac')).toBe('APAC');
  });

  it('rejects unknown regions and non-strings', () => {
    expect(normalizeRegion('Antarctica')).toBeNull();
    expect(normalizeRegion('')).toBeNull();
    expect(normalizeRegion(null)).toBeNull();
    expect(normalizeRegion(42)).toBeNull();
    expect(normalizeRegion('indi')).toBeNull(); // no fuzzy/partial matching
  });

  it('is idempotent (normalize∘normalize == normalize)', () => {
    for (const r of ['india', 'EUROPE', ' africa ']) {
      const once = normalizeRegion(r);
      expect(normalizeRegion(once)).toBe(once);
    }
  });
});
