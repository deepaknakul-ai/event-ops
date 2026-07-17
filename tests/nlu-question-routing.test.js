import { describe, it, expect } from 'vitest';
import { looksLikeQuestion, buildQueryFallback, parseMessage } from '../src/utils/aiAccountant/nlu.js';

// A2 — a QUESTION the booking parser can't handle must route to the read-only
// query path, never the LLM ENTRY extractor.
describe('looksLikeQuestion', () => {
  it('accepts interrogatives (English + Hinglish) and trailing ?', () => {
    for (const t of [
      'are we profitable?', "what's my cash", 'how healthy are the books',
      'kitna cash bacha hai', 'kya hum profit me hain', 'expenses?', 'is the gst paid',
    ]) expect(looksLikeQuestion(t), t).toBe(true);
  });
  it('rejects booking statements', () => {
    for (const t of [
      'paid 5000 to ramesh', 'salary 30000 rahul', 'got 50k from acme',
      'spent 2000 on fuel', 'reimburse Raj 800 for taxi',
    ]) expect(looksLikeQuestion(t), t).toBe(false);
  });
});

describe('buildQueryFallback (no score gate)', () => {
  it('produces a canonical query Transaction with a classified type', () => {
    const q = buildQueryFallback("what's my cash");
    expect(q.intent).toBe('query');
    expect(q.meta.queryType).toBe('cash_balance');
    expect(q.entries).toEqual([]);
    expect(q.confidence).toBeLessThan(0.55); // fallback route is marked low-confidence
  });
  it('defaults to summary for the long tail (the ask-anything hook)', () => {
    expect(buildQueryFallback('are we profitable?').meta.queryType).toBe('pnl');
    expect(buildQueryFallback('how are things going overall?').meta.queryType).toBe('summary');
  });
  it('classifies deterministically without the LLM for known shapes', () => {
    expect(buildQueryFallback('expenses?').meta.queryType).toBe('expenses');
    expect(buildQueryFallback('kitna outstanding hai?').meta.queryType).toBe('outstanding');
  });
});

describe('regression: booking phrases still parse as bookings', () => {
  it('"paid 5000 to ramesh" stays a payment (never a query)', () => {
    const tx = parseMessage('paid 5000 to ramesh', {});
    expect(tx.intent).toBe('payment');
  });
  it('existing gated queries still classify through detectQuery', () => {
    expect(parseMessage('show me the balance sheet', {}).meta.queryType).toBe('balance_sheet');
    expect(parseMessage('how much do we owe Zenith', {}).meta.queryType).toBe('party_balance');
  });
});
