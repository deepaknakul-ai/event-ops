import { describe, it, expect } from 'vitest';
import {
  learnFromEntries,
  suggestAccountForParty,
  suggestAccountForText,
  topAccounts,
} from '../src/utils/aiAccountant/learning.js';

const HISTORY = [
  {
    date: '2026-04-01',
    narration: 'Payment to Acme Corp for rent',
    party_name: 'Acme Corp',
    ai_intent: 'payment',
    entries: [
      { debitAccount: 'Party: Acme Corp', creditAccount: 'Bank', amount: 50000 },
    ],
  },
  {
    date: '2026-04-05',
    narration: 'Travel expenses cab fuel',
    ai_intent: 'expense',
    entries: [
      { debitAccount: 'Travel Expense', creditAccount: 'Cash', amount: 2000 },
    ],
  },
  {
    date: '2026-04-08',
    narration: 'Travel expenses again',
    ai_intent: 'expense',
    entries: [
      { debitAccount: 'Travel Expense', creditAccount: 'Cash', amount: 1500 },
    ],
  },
  {
    date: '2026-04-10',
    narration: 'Payment to Acme Corp rent again',
    party_name: 'Acme Corp',
    ai_intent: 'payment',
    entries: [
      { debitAccount: 'Party: Acme Corp', creditAccount: 'Bank', amount: 50000 },
    ],
  },
];

describe('learnFromEntries', () => {
  it('builds frequency tables', () => {
    const l = learnFromEntries(HISTORY);
    expect(l.sampleSize).toBe(4);
    expect(l.accountFrequency['Travel Expense']).toBe(2);
    expect(l.accountFrequency['Party: Acme Corp']).toBe(2);
    expect(l.pairFrequency['Party: Acme Corp|Bank']).toBe(2);
  });

  it('maps party → account', () => {
    const l = learnFromEntries(HISTORY);
    expect(l.partyAccount['Acme Corp']).toBeTruthy();
    expect(l.partyAccount['Acme Corp'].account).toBe('Party: Acme Corp');
    expect(l.partyAccount['Acme Corp'].count).toBe(2);
  });

  it('skips fy_closing entries', () => {
    const l = learnFromEntries([...HISTORY, { source: 'fy_closing', entries: [{ debitAccount: 'Retained Earnings', creditAccount: 'P&L', amount: 999 }] }]);
    expect(l.accountFrequency['Retained Earnings']).toBeUndefined();
  });
});

describe('suggestAccountForParty', () => {
  it('returns most-used account with confidence', () => {
    const l = learnFromEntries(HISTORY);
    const s = suggestAccountForParty('Acme Corp', l);
    expect(s.account).toBe('Party: Acme Corp');
    expect(s.type).toBe('vendor');
    expect(s.confidence).toBeGreaterThan(0);
  });

  it('returns null for unknown party', () => {
    const l = learnFromEntries(HISTORY);
    expect(suggestAccountForParty('Nobody Inc', l)).toBeNull();
  });
});

describe('suggestAccountForText', () => {
  it('picks Travel Expense from "cab fare"', () => {
    const l = learnFromEntries(HISTORY);
    const s = suggestAccountForText('paid cab fare for travel', l);
    expect(s).toBeTruthy();
    expect(s.account).toBe('Travel Expense');
  });
});

describe('topAccounts', () => {
  it('returns sorted by frequency', () => {
    const l = learnFromEntries(HISTORY);
    const top = topAccounts(l, 3);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0].count).toBeGreaterThanOrEqual(top[top.length - 1].count);
  });
});
