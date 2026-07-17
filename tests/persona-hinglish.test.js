import { describe, it, expect } from 'vitest';
import { parseMessage, looksLikeQuestion, buildQueryFallback } from '../src/utils/aiAccountant/nlu.js';

// ─────────────────────────────────────────────────────────────────────────────
// Six Indian-workplace personas, each with a different English↔Hindi mix, run
// against the DETERMINISTIC layer (parseMessage + question routing). For every
// utterance we pin either (a) the exact rules-engine booking/query, or (b) the
// correct ESCALATION ROUTE: question → read-only Q&A; booking dead-end → LLM
// entry extractor. The LLM-bound utterances themselves are evaluated live via
// EVAL_PERSONAS=1 node functions/llm-eval.cjs (billed).
// Companion docs: docs/AI_ACCOUNTANT_GUIDE.md + docs/AI_ACCOUNTANT_UAT.md.
// ─────────────────────────────────────────────────────────────────────────────
const CTX = { partyNames: ['Acme Corp', 'Sharma Traders', 'Zenith Events'], employeeNames: ['Ramesh', 'Raju', 'Priya'], projectNames: [] };
const parse = (t) => parseMessage(t, CTX);
// The dead-end triage the chat performs when parseMessage returns null.
const route = (t) => {
  const r = parse(t);
  if (r) return r.intent === 'query' ? `query:${r.meta?.queryType}` : `rules:${r.intent}`;
  return looksLikeQuestion(t) ? 'qa-agent' : 'llm-extractor';
};

describe('Persona 1 — Sharma ji (owner, 50s; Hindi-dominant, minimal English)', () => {
  it('"kiraya diya 25000" books rent from pure Hindi', () => {
    const r = parse('kiraya diya 25000');
    expect(r.intent).toBe('rent');
    expect(r.entries[0]).toMatchObject({ debitAccount: 'Rent Expense', creditAccount: 'Cash', amount: 25000 });
  });
  it('"petrol 2000 generator" books site fuel', () => {
    expect(parse('petrol 2000 generator').entries[0].debitAccount).toBe('Site Power & Fuel');
  });
  it('terse Hindi bookings the rules cannot shape go to the LLM extractor (never Q&A)', () => {
    expect(route('ramesh ko 5000 diya')).toBe('llm-extractor');
    expect(route('acme se 50000 aaye')).toBe('llm-extractor');
  });
  it('"kitna cash bacha hai" is recognised as a QUESTION (Q&A, not an entry)', () => {
    expect(route('kitna cash bacha hai')).toBe('qa-agent');
  });
});

describe('Persona 2 — Sunita (accountant; formal Indian-English)', () => {
  it('formal receipt with mode books to Bank', () => {
    const r = parse('Received Rs 50,000 from Acme Corp via NEFT');
    expect(r.intent).toBe('receipt');
    expect(r.entries[0]).toMatchObject({ debitAccount: 'Bank', creditAccount: 'Party: Acme Corp', amount: 50000 });
  });
  it('formal salary instruction books Salary Expense', () => {
    const r = parse('Record salary of 30000 paid to Ramesh');
    expect(r.intent).toBe('salary');
    expect(r.entries[0].debitAccount).toBe('Salary Expense');
  });
  it('statement requests classify as queries', () => {
    expect(route('show me the trial balance')).toBe('query:trial_balance');
    expect(route('am I ready to close the year')).toBe('query:close_readiness');
  });
});

describe('Persona 3 — Raju (site supervisor; true Hinglish)', () => {
  it('"diesel bharwaya 2000 ka generator ke liye" books site fuel silently (clear context)', () => {
    const r = parse('diesel bharwaya 2000 ka generator ke liye');
    expect(r.entries[0]).toMatchObject({ debitAccount: 'Site Power & Fuel', amount: 2000 });
    expect((r.issues || []).some((i) => i.code === 'fuel_account_ambiguous')).toBe(false);
  });
  it('"raju ko advance diya 3000" hits the PER-EMPLOYEE account', () => {
    const r = parse('raju ko advance diya 3000');
    expect(r.intent).toBe('advance');
    expect(r.entries[0]).toMatchObject({ debitAccount: 'Employee: Raju', creditAccount: 'Cash', amount: 3000 });
  });
  it('"labour ko 4000 cash diya" books Direct Labour', () => {
    expect(parse('labour ko 4000 cash diya').entries[0].debitAccount).toBe('Direct Labour');
  });
  it('arithmetic Hinglish ("khana khilaya 8 log 800 wala") escalates to the LLM extractor', () => {
    expect(route('khana khilaya 8 log 800 wala')).toBe('llm-extractor');
  });
});

describe('Persona 4 — Priya (coordinator; casual English + shorthand)', () => {
  it('"got 50k from acme" expands 50k and grounds the party', () => {
    const r = parse('got 50k from acme');
    expect(r.entries[0]).toMatchObject({ creditAccount: 'Party: Acme Corp', amount: 50000 });
  });
  it('"show me acme ledger" → ledger-on-demand with the right subject', () => {
    const r = parse('show me acme ledger');
    expect(r.meta.queryType).toBe('account_ledger');
    expect(r.meta.subject.toLowerCase()).toContain('acme');
  });
  it('"who owes us money?" → outstanding', () => {
    expect(route('who owes us money?')).toBe('query:outstanding');
  });
});

describe('Persona 5 — Anwar bhai (vendor ops; Hindi with English nouns)', () => {
  it('"sharma traders ko 20000 de diye neft se" escalates to the LLM extractor (not Q&A)', () => {
    expect(route('sharma traders ko 20000 de diye neft se')).toBe('llm-extractor');
  });
  it('"gst ka kitna banta hai" is a QUESTION → Q&A agent (mid-sentence kitna)', () => {
    expect(route('gst ka kitna banta hai')).toBe('qa-agent');
  });
  it('KNOWN LIMITATION (pinned): "bill settle kiya 36000" parses as an INVOICE, not a payment — the preview shows the direction and the human corrects. If this pin breaks, the engine changed.', () => {
    const r = parse('sharma traders ka bill settle kiya 36000');
    expect(r.intent).toBe('invoice'); // documented mis-read; caught at preview
  });
});

describe('Persona 6 — Deepak (tech-savvy owner; mixed commands + queries)', () => {
  it('Hinglish profit question routes to Q&A and classifies as pnl in the fallback', () => {
    expect(route('kitna profit hua is saal')).toBe('qa-agent');
    expect(buildQueryFallback('kitna profit hua is saal').meta.queryType).toBe('pnl');
  });
  it('"acme ka balance kya hai" is a QUESTION (mid-sentence kya — the fix under test)', () => {
    expect(route('acme ka balance kya hai')).toBe('qa-agent');
  });
  it('accountant commands work verbatim: audit + close readiness', () => {
    expect(route('audit karo books ka')).toBe('query:audit');
    expect(route('ready to close?')).toBe('query:close_readiness');
  });
  it('question words never hijack bookings (guard)', () => {
    expect(route('paid 5000 to ramesh')).toBe('rules:payment');
    expect(route('salary 30000 to Ramesh')).toBe('rules:salary');
  });
});
