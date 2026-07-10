import { describe, it, expect } from 'vitest';
import { parseMessage, findPartyCandidates, NEW_PARTY_PREFIX } from '../src/utils/aiAccountant/nlu.js';
import { resolveParty, extractParty, nameSegments, segmentCoverage, pickPartyOption } from '../src/utils/aiAccountant/party.js';
import { learnFromEntries } from '../src/utils/aiAccountant/learning.js';

// Regression suite for the reported bug: typing "sanjeev chopra" was silently
// matched to the existing party "Chopra AV" (surname-only prefix hit).

describe('reported bug: "sanjeev chopra" vs existing "Chopra AV"', () => {
  it('clarifies instead of silently matching Chopra AV', () => {
    const tx = parseMessage('received 5000 from sanjeev chopra', { partyNames: ['Chopra AV'] });
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.clarifyKind).toBe('party');
    expect(tx.meta.options).toContain('Chopra AV');
    expect(tx.meta.options).toContain(`${NEW_PARTY_PREFIX}Sanjeev Chopra`);
    expect(tx.meta.typedParty).toBe('Sanjeev Chopra');
  });

  it('resolves silently when the exact party exists alongside the surname twin', () => {
    const tx = parseMessage('received 5000 from sanjeev chopra', {
      partyNames: ['Chopra AV', 'Sanjeev Chopra'],
    });
    expect(tx.intent).toBe('receipt');
    expect(tx.party.name).toBe('Sanjeev Chopra');
  });

  it('clarifies with both parties for a bare shared surname', () => {
    const tx = parseMessage('received 5000 from chopra', {
      partyNames: ['Chopra AV', 'Sanjeev Chopra'],
    });
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.options).toContain('Chopra AV');
    expect(tx.meta.options).toContain('Sanjeev Chopra');
  });

  it('forceParty (clarify answer / anaphora) bypasses the prompt', () => {
    const tx = parseMessage('received 5000 from sanjeev chopra', {
      partyNames: ['Chopra AV'],
      forceParty: 'Sanjeev Chopra',
    });
    expect(tx.intent).toBe('receipt');
    expect(tx.party.name).toBe('Sanjeev Chopra');
  });
});

describe('no-regression: strong partial references still resolve silently', () => {
  it('single unambiguous prefix resolves without a prompt', () => {
    const tx = parseMessage('paid acme 5000', { partyNames: ['Acme Corp', 'Beta Ltd'] });
    expect(tx.intent).toBe('payment');
    expect(tx.party.name).toBe('Acme Corp');
  });

  it('prefix followed by unrelated words resolves (segment isolation)', () => {
    const tx = parseMessage('received 5000 from acme for diwali event', {
      partyNames: ['Acme Corp'],
    });
    expect(tx.intent).toBe('receipt');
    expect(tx.party.name).toBe('Acme Corp');
  });

  // Adversarial-review regression pack: everyday phrasings that must NOT
  // trigger a clarify prompt (date words, txn nouns, tags, Hinglish, apps).
  const SILENT_CASES = [
    ['got 5000 from mehta today', ['Mehta Constructions'], 'Mehta Constructions'],
    ['received mehta payment of 5000', ['Mehta Constructions'], 'Mehta Constructions'],
    ['received 25000 from mehta #P-12', ['Mehta Constructions'], 'Mehta Constructions'],
    ['received 5000 upi from ramesh gpay', ['Ramesh Kumar'], 'Ramesh Kumar'],
    ['sharma ji ko 5000 transfer kiya', ['Sharma Traders'], 'Sharma Traders'],
  ];
  it.each(SILENT_CASES)('"%s" resolves silently', (text, partyNames, expected) => {
    const tx = parseMessage(text, { partyNames });
    expect(tx.intent).not.toBe('clarify');
    expect(tx.party.name).toBe(expected);
  });

  it('split expenses with a trailing site qualifier do not clarify', () => {
    const tx = parseMessage('spent 500 on tea and 300 on cab for mehta site', {
      partyNames: ['Mehta Constructions'],
    });
    expect(tx.intent).not.toBe('clarify');
  });
});

describe('noise words inside a NEW party name cannot hide it', () => {
  it('"kumar site services" clarifies against "Kumar Traders" instead of silently booking', () => {
    const tx = parseMessage('received 5000 from kumar site services', {
      partyNames: ['Kumar Traders'],
    });
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.options).toContain('Kumar Traders');
    expect(tx.meta.typedParty).toBe('Kumar Site Services');
  });

  it('trailing noise words still stay out of the name ("mehta payment")', () => {
    const segs = nameSegments('received mehta payment of 5000');
    expect(segs.map((s) => s.text)).toEqual(['mehta']);
  });

  it('interior noise words join the name phrase', () => {
    const segs = nameSegments('received 5000 from kumar site services');
    expect(segs.map((s) => s.text)).toEqual(['kumar site services']);
  });
});

describe('typedParty sanitization (junk new-party names)', () => {
  it('project tags and digits never reach the New-party option', () => {
    const tx = parseMessage('received 5000 from sanjeev chopra #P-12', {
      partyNames: ['Chopra AV'],
    });
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.typedParty).toBe('Sanjeev Chopra');
    expect(tx.meta.options).toContain(`${NEW_PARTY_PREFIX}Sanjeev Chopra`);
  });
});

describe('exact typed names always beat aliases', () => {
  const ALIAS = { 'sanjeev chopra': 'Chopra AV' };

  it('session alias must not hijack an exact full-name match', () => {
    const tx = parseMessage('received 5000 from sanjeev chopra', {
      partyNames: ['Chopra AV', 'Sanjeev Chopra'],
      sessionAliases: ALIAS,
    });
    expect(tx.intent).toBe('receipt');
    expect(tx.party.name).toBe('Sanjeev Chopra');
  });

  it('learned alias must not hijack an exact full-name match', () => {
    const learned = learnFromEntries([
      { date: '2026-05-01', ai_party_alias: { alias: 'sanjeev chopra', party: 'Chopra AV' }, entries: [] },
    ]);
    const tx = parseMessage('received 5000 from sanjeev chopra', {
      partyNames: ['Chopra AV', 'Sanjeev Chopra'],
      learned,
    });
    expect(tx.party.name).toBe('Sanjeev Chopra');
  });
});

describe('pickPartyOption (clarify answer matching)', () => {
  const OPTIONS = ['Chopra AV', `${NEW_PARTY_PREFIX}Sanjeev Chopra`];

  it('verbatim option click resolves', () => {
    expect(pickPartyOption('Chopra AV', OPTIONS, NEW_PARTY_PREFIX)).toBe('Chopra AV');
    expect(pickPartyOption(`${NEW_PARTY_PREFIX}Sanjeev Chopra`, OPTIONS, NEW_PARTY_PREFIX))
      .toBe(`${NEW_PARTY_PREFIX}Sanjeev Chopra`);
  });

  it('typing the bare new-party name resolves to the new-party option', () => {
    expect(pickPartyOption('sanjeev chopra', OPTIONS, NEW_PARTY_PREFIX))
      .toBe(`${NEW_PARTY_PREFIX}Sanjeev Chopra`);
  });

  it('a typo of the new name goes to the new party, not the existing one', () => {
    expect(pickPartyOption('sanjev chopra', OPTIONS, NEW_PARTY_PREFIX))
      .toBe(`${NEW_PARTY_PREFIX}Sanjeev Chopra`);
  });

  it('a genuinely ambiguous answer returns empty (re-ask) instead of guessing', () => {
    expect(pickPartyOption('chopra', ['Chopra AV', 'Chopra Decor'], NEW_PARTY_PREFIX)).toBe('');
  });
});

describe('alias mining determinism', () => {
  const OLD_ENTRY = { created_at: '2026-01-01T00:00:00Z', ai_party_alias: { alias: 'sc events', party: 'Old Party' }, entries: [] };
  const NEW_ENTRY = { created_at: '2026-06-01T00:00:00Z', ai_party_alias: { alias: 'sc events', party: 'New Party' }, entries: [] };

  it('conflicting corrections resolve to the most recent regardless of order', () => {
    expect(learnFromEntries([OLD_ENTRY, NEW_ENTRY]).partyAliases['sc events'].party).toBe('New Party');
    expect(learnFromEntries([NEW_ENTRY, OLD_ENTRY]).partyAliases['sc events'].party).toBe('New Party');
  });
});

describe('findPartyCandidates coverage metadata', () => {
  it('tags weak prefix hits with coverage < 1 and the typed phrase', () => {
    const hits = findPartyCandidates('received 5000 from sanjeev chopra', ['Chopra AV']);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: 'Chopra AV', source: 'prefix' });
    expect(hits[0].coverage).toBeLessThan(1);
    expect(hits[0].typedName.toLowerCase()).toBe('sanjeev chopra');
  });

  it('fully-explained prefix hits keep coverage 1', () => {
    const hits = findPartyCandidates('paid acme 1000', ['Acme Corp']);
    expect(hits).toHaveLength(1);
    expect(hits[0].coverage).toBe(1);
  });
});

describe('resolveParty coverage gate', () => {
  it('keeps the typed name when a surname-only match would otherwise win', () => {
    expect(resolveParty('sanjeev chopra', { partyNames: ['Chopra AV'] })).toBe('sanjeev chopra');
  });

  it('still resolves close typos', () => {
    expect(resolveParty('acmee corp', { partyNames: ['Acme Corp'] })).toBe('Acme Corp');
  });

  it('still resolves single-token references', () => {
    expect(resolveParty('rahul', { partyNames: ['Rahul Sharma'] })).toBe('Rahul Sharma');
  });
});

describe('short-token guards', () => {
  it('"AV" must not be extracted from "advance"', () => {
    const got = extractParty('paid 5000 advance to ramesh', { partyNames: ['AV Solutions'] });
    expect(got).not.toBe('AV Solutions');
  });

  it('short names still match as standalone words', () => {
    const hits = findPartyCandidates('paid chopra av 2000', ['Chopra AV']);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('exact');
  });
});

describe('name segmentation', () => {
  it('splits on amounts, action words, and fillers', () => {
    const segs = nameSegments('received 5000 from sanjeev chopra for diwali event');
    expect(segs.map((s) => s.text)).toEqual(['sanjeev chopra', 'diwali event']);
  });

  it('coverage is fractional for partially explained phrases', () => {
    expect(segmentCoverage(['sanjeev', 'chopra'], 'Chopra AV')).toBe(0.5);
    expect(segmentCoverage(['chopra'], 'Chopra AV')).toBe(1);
  });

  it('ignores honorifics in the typed phrase', () => {
    expect(segmentCoverage(['m/s', 'acme'], 'Acme Corp')).toBe(1);
  });
});

describe('party alias learning (clarify corrections)', () => {
  it('mines ai_party_alias from posted entries', () => {
    const learned = learnFromEntries([
      {
        date: '2026-05-01',
        ai_party_alias: { alias: 'sanjeev chopra', party: 'Chopra AV' },
        entries: [{ debitAccount: 'Bank', creditAccount: 'Party: Chopra AV', amount: 5000 }],
      },
    ]);
    expect(learned.partyAliases['sanjeev chopra']).toMatchObject({ party: 'Chopra AV' });
  });

  it('a learned alias resolves silently on the next parse', () => {
    const learned = learnFromEntries([
      { date: '2026-05-01', ai_party_alias: { alias: 'sanjeev chopra', party: 'Chopra AV' }, entries: [] },
    ]);
    const tx = parseMessage('received 9000 from sanjeev chopra', {
      partyNames: ['Chopra AV'],
      learned,
    });
    expect(tx.intent).toBe('receipt');
    expect(tx.party.name).toBe('Chopra AV');
  });

  it('session aliases from this chat resolve silently too', () => {
    const tx = parseMessage('received 9000 from sanjeev chopra', {
      partyNames: ['Chopra AV'],
      sessionAliases: { 'sanjeev chopra': 'Chopra AV' },
    });
    expect(tx.party.name).toBe('Chopra AV');
  });

  it('an alias pointing at a deleted party is ignored', () => {
    const tx = parseMessage('received 9000 from sanjeev chopra', {
      partyNames: ['Chopra AV'],
      sessionAliases: { 'sanjeev chopra': 'Old Deleted Party' },
    });
    expect(tx.intent).toBe('clarify');
  });
});
