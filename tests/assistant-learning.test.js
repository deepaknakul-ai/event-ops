// Tests for the chat-assistant learning module + NLU integration.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  emptyModel, recordUsage, topUsedPrompts, summary, forgetPhrase,
} from '../src/utils/assistant/learning.js';
import { parseAssistantMessage } from '../src/utils/assistant/nlu.js';

const ctx = {
  clientNames: ['ACME Pvt Ltd'],
  employeeNames: ['Ramesh Kumar'],
  vendorNames: [],
  projectNames: ['Wedding Spectacular'],
  inventoryNames: [],
};

describe('learning model — basics', () => {
  it('emptyModel has the expected shape', () => {
    const m = emptyModel();
    expect(m.version).toBe(1);
    expect(m.phraseIntent).toEqual({});
    expect(m.intentFreq).toEqual({});
    expect(m.prompts).toEqual([]);
  });

  it('recordUsage adds a phrase and tracks frequency', () => {
    let m = emptyModel();
    m = recordUsage(m, { text: 'whats running today', intent: 'projects.today', ctx });
    m = recordUsage(m, { text: 'whats running today', intent: 'projects.today', ctx });
    expect(m.intentFreq['projects.today']).toBe(2);
    const keys = Object.keys(m.phraseIntent);
    expect(keys.length).toBe(1);
    expect(m.phraseIntent[keys[0]].count).toBe(2);
  });

  it('strips entity names so phrases generalise', () => {
    let m = emptyModel();
    m = recordUsage(m, { text: 'ledger of ACME Pvt Ltd', intent: 'client.ledger', ctx });
    const keys = Object.keys(m.phraseIntent);
    // "acme pvt ltd" should be removed, leaving "ledger of"
    expect(keys[0]).not.toMatch(/acme/);
    expect(keys[0]).toMatch(/ledger/);
  });

  it('skips unknown / help intents', () => {
    let m = recordUsage(emptyModel(), { text: 'help', intent: 'help', ctx });
    m = recordUsage(m, { text: 'gibberish', intent: 'unknown', ctx });
    expect(Object.keys(m.phraseIntent).length).toBe(0);
  });

  it('correction overrides previous mapping with corrected:true', () => {
    let m = emptyModel();
    m = recordUsage(m, { text: 'show foo', intent: 'projects.today', ctx });
    m = recordUsage(m, { text: 'show foo', intent: 'help', ctx, corrected: true });
    // help is filtered → original mapping retained, no new entry overwritten
    const v = Object.values(m.phraseIntent)[0];
    expect(v.intent).toBe('projects.today');

    // Now correct to a real intent
    m = recordUsage(m, { text: 'show foo', intent: 'client.ledger', ctx, corrected: true });
    expect(Object.values(m.phraseIntent)[0].intent).toBe('client.ledger');
  });

  it('forgetPhrase removes the entry', () => {
    let m = recordUsage(emptyModel(), { text: 'paisa aaya', intent: 'payments.byDate', ctx });
    const key = Object.keys(m.phraseIntent)[0];
    m = forgetPhrase(m, key);
    expect(m.phraseIntent[key]).toBeUndefined();
  });

  it('topUsedPrompts returns most-used prompts only', () => {
    let m = emptyModel();
    for (let i = 0; i < 3; i++) m = recordUsage(m, { text: 'pending claims', intent: 'expenses.pending', ctx });
    m = recordUsage(m, { text: 'one off thing', intent: 'reports.pl', ctx });
    const top = topUsedPrompts(m, { limit: 5, minCount: 2 });
    expect(top).toHaveLength(1);
    expect(top[0].text).toBe('pending claims');
  });

  it('summary reports counts', () => {
    let m = emptyModel();
    m = recordUsage(m, { text: 'a b c', intent: 'projects.today', ctx });
    m = recordUsage(m, { text: 'd e f', intent: 'reports.pl', ctx });
    const s = summary(m);
    expect(s.phrases).toBe(2);
    expect(s.interactions).toBe(2);
    expect(s.topIntents.length).toBeGreaterThan(0);
  });
});

describe('NLU + learning integration', () => {
  it('recovers an unknown phrase via the learned phraseIntent index', () => {
    let m = emptyModel();
    // Teach the assistant: "kya situation hai" → projects.today
    m = recordUsage(m, { text: 'kya situation hai', intent: 'projects.today', ctx });
    m = recordUsage(m, { text: 'kya situation hai', intent: 'projects.today', ctx });
    const r = parseAssistantMessage('kya situation hai', ctx, null, m);
    expect(r.intent).toBe('projects.today');
    expect(r.fromLearned).toBe(true);
  });

  it('Jaccard fallback recovers similar phrasing', () => {
    let m = emptyModel();
    m = recordUsage(m, { text: 'whats the running today situation', intent: 'projects.today', ctx });
    m = recordUsage(m, { text: 'whats the running today situation', intent: 'projects.today', ctx });
    const r = parseAssistantMessage('running today situation whats', ctx, null, m);
    expect(r.intent).toBe('projects.today');
  });

  it('learned hint boosts an existing keyword match (does not override)', () => {
    // Both "ledger" and entity match → keyword path wins anyway.
    let m = emptyModel();
    m = recordUsage(m, { text: 'show ledger of ACME Pvt Ltd', intent: 'client.ledger', ctx });
    const r = parseAssistantMessage('show ledger of ACME Pvt Ltd', ctx, null, m);
    expect(r.intent).toBe('client.ledger');
    expect(r.entities.clientName).toBe('ACME Pvt Ltd');
  });
});

describe('NLU — synonyms / Hinglish coverage', () => {
  it('recognises Hindi phrasing for cash position', () => {
    expect(parseAssistantMessage('kitna paisa hai', ctx).intent).toBe('reports.cashPosition');
  });
  it('recognises "khata" for ledger', () => {
    const r = parseAssistantMessage('khata of ACME Pvt Ltd', ctx);
    expect(r.intent).toBe('client.ledger');
    expect(r.entities.clientName).toBe('ACME Pvt Ltd');
  });
  it('recognises "kickoff" for ongoing', () => {
    const r = parseAssistantMessage('kickoff Wedding Spectacular', ctx);
    expect(r.intent).toBe('project.markOngoing');
  });
  it('recognises "wrap up" for completed', () => {
    const r = parseAssistantMessage('wrap it', ctx, { lastEntities: { projectName: 'Wedding Spectacular' } });
    expect(r.intent).toBe('project.markCompleted');
  });
  it('recognises "accounts receivable" for outstanding clients', () => {
    expect(parseAssistantMessage('show accounts receivable', ctx).intent).toBe('client.outstanding');
  });
  it('typo tolerance: "ledgr" still maps to ledger', () => {
    const r = parseAssistantMessage('ledgr ACME Pvt Ltd', ctx);
    expect(r.intent).toBe('client.ledger');
  });
});
