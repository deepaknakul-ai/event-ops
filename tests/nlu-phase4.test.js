import { describe, it, expect } from 'vitest';
import { parseMessage, findPartyCandidates } from '../src/utils/aiAccountant/nlu.js';
import { canPost, canDispatch } from '../src/utils/aiAccountant/validator.js';
import { learnFromEntries } from '../src/utils/aiAccountant/learning.js';

describe('clarify intent — missing amount', () => {
  it('asks for amount when intent is clear but amount missing', () => {
    const tx = parseMessage('paid Acme Corp for services', { partyNames: ['Acme Corp'] });
    expect(tx).toBeTruthy();
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.clarifyKind).toBe('amount');
    expect(tx.meta.proposedIntent).toBe('payment');
    expect(canPost(tx)).toBe(false);
    expect(canDispatch(tx)).toBe(false);
  });

  it('returns null for pure gibberish', () => {
    expect(parseMessage('???')).toBeNull();
  });
});

describe('clarify intent — ambiguous party', () => {
  it('asks which Acme when multiple matches', () => {
    const tx = parseMessage('paid acme 5000', { partyNames: ['Acme Corp', 'Acme Logistics', 'Beta Ltd'] });
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.clarifyKind).toBe('party');
    expect(tx.meta.options).toContain('Acme Corp');
    expect(tx.meta.options).toContain('Acme Logistics');
    expect(tx.meta.amount).toBe(5000);
  });

  it('does NOT clarify when only one candidate', () => {
    const tx = parseMessage('paid acme 5000', { partyNames: ['Acme Corp', 'Beta Ltd'] });
    expect(tx.intent).toBe('payment');
    expect(tx.party.name).toBe('Acme Corp');
  });

  it('resolves when one full name is explicitly provided among similar parties', () => {
    const tx = parseMessage('paid to sanjeev chopra 3000 sanjeev chopra lights', {
      partyNames: ['Sanjeev Chopra Lights', 'Sanjeev Chopra Decor'],
    });
    expect(tx.intent).toBe('payment');
    expect(tx.party.name).toBe('Sanjeev Chopra Lights');
  });
});

describe('learning integration in NLU', () => {
  const HISTORY = [
    { date: '2026-04-01', party_name: 'Acme Corp', ai_intent: 'payment',
      entries: [{ debitAccount: 'Party: Acme Corp', creditAccount: 'Bank', amount: 50000 }] },
    { date: '2026-04-05', party_name: 'Acme Corp', ai_intent: 'payment',
      entries: [{ debitAccount: 'Party: Acme Corp', creditAccount: 'Bank', amount: 50000 }] },
    { date: '2026-04-05', narration: 'travel fare',
      entries: [{ debitAccount: 'Travel Expense', creditAccount: 'Cash', amount: 2000 }] },
  ];

  it('stamps learnedPartyAccount on payments', () => {
    const learned = learnFromEntries(HISTORY);
    const tx = parseMessage('paid Acme Corp 50000', { partyNames: ['Acme Corp'], learned });
    expect(tx.intent).toBe('payment');
    expect(tx.meta.learnedPartyAccount).toBe('Party: Acme Corp');
  });

  it('uses learned account for expenses when confidence is high', () => {
    const learned = learnFromEntries([...HISTORY, ...HISTORY]); // boost count
    const tx = parseMessage('spent 500 on cab fare', { learned });
    expect(tx.intent).toBe('expense');
    // Either learned or guessed — both should land on Travel Expense
    expect(tx.entries[0].debitAccount).toBe('Travel Expense');
  });
});

describe('findPartyCandidates', () => {
  it('matches exact token', () => {
    const hits = findPartyCandidates('paid acme corp 1000', ['Acme Corp', 'Beta']);
    expect(hits.map((h) => h.name)).toContain('Acme Corp');
  });
  it('matches first word', () => {
    const hits = findPartyCandidates('paid acme 1000', ['Acme Corp', 'Acme Logistics']);
    expect(hits).toHaveLength(2);
  });
  it('empty when no match', () => {
    expect(findPartyCandidates('paid xyz', ['Acme Corp'])).toEqual([]);
  });

  it('prioritizes exact match over first-word fuzzy matches', () => {
    const hits = findPartyCandidates('paid sanjeev chopra lights 1000', ['Sanjeev Chopra Lights', 'Sanjeev Chopra Decor']);
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Sanjeev Chopra Lights');
  });
});
