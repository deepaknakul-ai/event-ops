import { describe, it, expect } from 'vitest';
import { extractAmountExpression, extractAmountSmart } from '../src/utils/aiAccountant/amount.js';

describe('extractAmountExpression', () => {
  it('adds two plain numbers', () => {
    expect(extractAmountExpression('5000 + 900')).toBe(5900);
  });
  it('adds amounts with descriptors between them', () => {
    expect(extractAmountExpression('5000 + 900 GST')).toBe(5900);
  });
  it('supports k and lakh shorthands', () => {
    expect(extractAmountExpression('10k + 2k')).toBe(12000);
    expect(extractAmountExpression('1L + 50k')).toBe(150000);
  });
  it('supports subtraction', () => {
    expect(extractAmountExpression('20000 - 500')).toBe(19500);
  });
  it('returns 0 when no operator present', () => {
    expect(extractAmountExpression('5000')).toBe(0);
  });
  it('returns 0 when result is non-positive', () => {
    expect(extractAmountExpression('500 - 5000')).toBe(0);
  });
});

describe('extractAmountSmart', () => {
  it('falls back to single number', () => {
    expect(extractAmountSmart('paid 5000')).toBe(5000);
  });
  it('prefers arithmetic when operators are present', () => {
    expect(extractAmountSmart('invoice 5000 + 900 GST')).toBe(5900);
  });
});
