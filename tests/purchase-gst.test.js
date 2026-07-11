import { describe, it, expect } from 'vitest';
import { purchaseGstSplit, determineSupplyType, stateCodeFromGSTIN } from '../src/utils/aiAccountant/knowledge.js';

describe('purchaseGstSplit', () => {
  it('splits an intra-state GST total into equal CGST + SGST that sum exactly', () => {
    expect(purchaseGstSplit(1800, 'intra')).toEqual({ cgst: 900, sgst: 900, igst: 0 });
  });

  it('puts an inter-state GST total entirely into IGST', () => {
    expect(purchaseGstSplit(1800, 'inter')).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
  });

  it('leaves an unknown-supply GST unsplit (kept in the lump control account)', () => {
    expect(purchaseGstSplit(1800, 'unknown')).toEqual({ cgst: 0, sgst: 0, igst: 0 });
  });

  it('keeps odd amounts balanced (halves still sum to the total)', () => {
    const s = purchaseGstSplit(999.99, 'intra');
    expect(s.cgst + s.sgst).toBe(999.99);
    expect(s.igst).toBe(0);
  });

  it('returns zeros for non-positive or non-numeric GST', () => {
    expect(purchaseGstSplit(0, 'intra')).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    expect(purchaseGstSplit(-50, 'inter')).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    expect(purchaseGstSplit('abc', 'intra')).toEqual({ cgst: 0, sgst: 0, igst: 0 });
  });
});

describe('determineSupplyType (place of supply)', () => {
  it('is intra when org and vendor share a state code', () => {
    expect(determineSupplyType('27ABCDE1234F1Z5', '27PQRSX6789K1Z2')).toBe('intra');
  });

  it('is inter when the state codes differ', () => {
    expect(determineSupplyType('27ABCDE1234F1Z5', '29PQRSX6789K1Z2')).toBe('inter');
  });

  it('is unknown when the org GSTIN is missing', () => {
    expect(determineSupplyType('', '29PQRSX6789K1Z2')).toBe('unknown');
  });

  it('defaults to intra (B2C) when the org is known but the vendor is unregistered', () => {
    expect(determineSupplyType('27ABCDE1234F1Z5', '')).toBe('intra');
  });

  it('reads the first two digits as the state code', () => {
    expect(stateCodeFromGSTIN('07AABCU9603R1ZM')).toBe('07');
    expect(stateCodeFromGSTIN('bad')).toBe('');
  });
});
