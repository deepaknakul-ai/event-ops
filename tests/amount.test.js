import { describe, it, expect } from 'vitest';
import { extractAmount, detectPaymentMode } from '../src/utils/aiAccountant/amount.js';

describe('extractAmount', () => {
  it('parses plain integers', () => {
    expect(extractAmount('got 50000')).toBe(50000);
  });
  it('parses Indian comma notation', () => {
    expect(extractAmount('invoice 1,50,000')).toBe(150000);
  });
  it('parses decimals', () => {
    expect(extractAmount('paid 1,234.56')).toBe(1234.56);
  });
  it('parses k suffix', () => {
    expect(extractAmount('50k from Acme')).toBe(50000);
  });
  it('parses lakh variants', () => {
    expect(extractAmount('1.5 lakh from client')).toBe(150000);
    expect(extractAmount('2L via NEFT')).toBe(200000);
  });
  it('parses crore variants', () => {
    expect(extractAmount('received 1 crore')).toBe(10000000);
    expect(extractAmount('2cr deposit')).toBe(20000000);
  });
  it('strips currency words', () => {
    expect(extractAmount('Rs. 10,000 paid')).toBe(10000);
    expect(extractAmount('INR 25000')).toBe(25000);
  });
  it('returns 0 when no amount found', () => {
    expect(extractAmount('hello there')).toBe(0);
    expect(extractAmount('')).toBe(0);
  });
});

describe('detectPaymentMode', () => {
  it('detects bank mode from keywords', () => {
    expect(detectPaymentMode('paid 10k via NEFT')).toBe('Bank');
    expect(detectPaymentMode('UPI transfer 500')).toBe('Bank');
    expect(detectPaymentMode('cheque to Acme')).toBe('Bank');
  });
  it('detects cash mode explicitly', () => {
    expect(detectPaymentMode('cash payment 500')).toBe('Cash');
  });
  it('defaults to cash', () => {
    expect(detectPaymentMode('paid Acme 500')).toBe('Cash');
  });
});
