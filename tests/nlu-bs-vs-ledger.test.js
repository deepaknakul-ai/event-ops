import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/utils/aiAccountant/nlu.js';

// A4 — a bare "bs" token must not hijack ledger/statement requests
// (previously "show BS Traders ledger" answered with the balance sheet).
describe('detectQuery: balance_sheet vs account_ledger precedence', () => {
  const q = (text) => parseMessage(text, { partyNames: ['BS Traders'] });

  it('"show BS Traders ledger" → account_ledger with the right subject', () => {
    const tx = q('show BS Traders ledger');
    expect(tx.intent).toBe('query');
    expect(tx.meta.queryType).toBe('account_ledger');
    expect(tx.meta.subject.toLowerCase()).toContain('bs traders');
  });

  it('"show me the balance sheet" and bare "show bs" still → balance_sheet', () => {
    expect(q('show me the balance sheet').meta.queryType).toBe('balance_sheet');
    expect(q('show bs').meta.queryType).toBe('balance_sheet');
  });

  it('"BS Traders statement" → account_ledger', () => {
    expect(q('BS Traders statement').meta.queryType).toBe('account_ledger');
  });
});
