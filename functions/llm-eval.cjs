// ─────────────────────────────────────────────────────────────────────────────
// LLM Accounting Agent eval harness (Path B).
// Reproduces the EXACT aiExtractEntry server pipeline — same STATIC_SYSTEM_PROMPT,
// buildVolatileContext, LLM_TXN_SCHEMA, model params, and sanitizeLlmTransaction —
// but calls Anthropic directly so we can score free-form Hinglish/complex phrases
// offline. Does NOT touch Firestore, auth, rate limits, or usage counters.
//
//   ANTHROPIC_API_KEY=sk-ant-... node functions/llm-eval.cjs
//   ANTHROPIC_MODEL=claude-haiku-4-5 ANTHROPIC_API_KEY=... node functions/llm-eval.cjs
//
// Real billed calls (one per phrase). Prints each draft + a pass/fail scorecard.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const {
  LLM_TXN_SCHEMA, STATIC_SYSTEM_PROMPT, buildVolatileContext, capContext,
  sanitizeLlmTransaction, supportsAdaptiveThinking,
} = require('./ai-sanitize');

// Key from env var, else a gitignored local file `functions/.eval-key` (first line).
function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try {
    const fs = require('fs');
    const p = require('path').join(__dirname, '.eval-key');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').split('\n')[0].trim();
  } catch { /* fall through */ }
  return '';
}
const API_KEY = readKey();
const MODEL = (process.env.ANTHROPIC_MODEL || 'claude-opus-4-8').trim();
if (!API_KEY) { console.error('No key: set ANTHROPIC_API_KEY or put the key in functions/.eval-key (gitignored).'); process.exit(1); }

// Grounding context the client normally passes (mirrors buildAiContext caps).
const CTX = {
  todayISO: '2026-07-15',
  fy: '2026-27',
  orgGstin: '27ABCDE1234F1Z5', // Maharashtra org → intra-state = CGST+SGST
  partyNames: ['Acme Corp', 'Zenith Corp', 'Bright Media', 'SupplyCo'],
  partyGstins: { 'acme corp': '27AAACA1234A1Z0' },
  accountNames: [
    'Cash', 'Bank', 'Sales Revenue', 'Purchase Expense', 'Salary Expense',
    'Food Expense', 'Rent Expense', 'Electricity Expense', 'Site Power & Fuel',
    'Travelling & Conveyance', 'Commission Expense', 'Discount Allowed',
    'Employee Advances', 'Employee Payable', 'TDS Payable', 'Input GST Credit',
    'Output CGST', 'Output SGST', 'Input CGST', 'Input SGST', 'Miscellaneous Expense',
  ],
  projectNames: [],
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const total = (tx) => round2((tx.entries || []).reduce((s, e) => s + (Number(e.amount) || 0), 0));
const hasAcct = (tx, name) => (tx.entries || []).some((e) => e.debitAccount === name || e.creditAccount === name);
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;
const taxableLeg = (tx) => Math.max(0, ...(tx.entries || []).map((e) => Number(e.amount) || 0));

// 15 Hinglish / compound / GST-back-calc / arithmetic phrases + a primary check.
const CASES = [
  { t: 'Ramesh bhai ko 12,500 cash de diye site ke liye',
    check: (tx) => ({ ok: near(total(tx), 12500), why: `total=${total(tx)} (want 12500)` }) },
  { t: '36000 total incl 18% GST invoice to Acme Corp',
    check: (tx) => ({ ok: tx.intent === 'invoice' && near(taxableLeg(tx), 30508.47, 2), why: `intent=${tx.intent} taxable=${taxableLeg(tx)} (want invoice / 30508.47)` }) },
  { t: 'Acme Corp se 22k mila, 2k discount de ke settle kiya',
    check: (tx) => ({ ok: hasAcct(tx, 'Discount Allowed') && near(total(tx), 24000, 1), why: `discountLeg=${hasAcct(tx, 'Discount Allowed')} total=${total(tx)} (want Discount Allowed + 24000)` }) },
  { t: '8 log x 800 khana',
    check: (tx) => ({ ok: near(total(tx), 6400) && hasAcct(tx, 'Food Expense'), why: `total=${total(tx)} food=${hasAcct(tx, 'Food Expense')} (want 6400 Food)` }) },
  { t: 'bought printer 23600 incl 18% gst from SupplyCo',
    check: (tx) => ({ ok: tx.intent === 'purchase' && near(taxableLeg(tx), 20000, 2), why: `intent=${tx.intent} taxable=${taxableLeg(tx)} (want purchase / 20000)` }) },
  { t: 'Rahul ki salary 50000, 5000 TDS kaat ke 45000 diya bank se',
    check: (tx) => ({ ok: tx.intent === 'salary' && hasAcct(tx, 'TDS Payable'), why: `intent=${tx.intent} tds=${hasAcct(tx, 'TDS Payable')} (want salary + TDS Payable)` }) },
  { t: 'petrol bharwaya 2000 ka generator ke liye',
    check: (tx) => ({ ok: near(total(tx), 2000) && (hasAcct(tx, 'Site Power & Fuel') || hasAcct(tx, 'Travelling & Conveyance')), why: `total=${total(tx)} fuelAcct=${hasAcct(tx, 'Site Power & Fuel')} (want 2000 fuel)` }) },
  { t: 'rent 30000 aur electricity 5000 pay kiya',
    check: (tx) => ({ ok: near(total(tx), 35000) && (tx.entries || []).length >= 2, why: `total=${total(tx)} legs=${(tx.entries || []).length} (want 35000 / 2+ legs)` }) },
  { t: 'Raju ko 10000 advance diya',
    check: (tx) => ({ ok: hasAcct(tx, 'Employee Advances') && near(total(tx), 10000), why: `advAcct=${hasAcct(tx, 'Employee Advances')} total=${total(tx)} (want Employee Advances 10000)` }) },
  { t: '2.5 lakh ka invoice Zenith Corp ko sound system ka',
    check: (tx) => ({ ok: tx.intent === 'invoice' && near(taxableLeg(tx), 250000, 1) || near(total(tx), 250000, 1), why: `intent=${tx.intent} total=${total(tx)} (want invoice ~250000)` }) },
  { t: 'Acme Corp ko 118000 ka invoice incl 18% gst',
    check: (tx) => ({ ok: near(taxableLeg(tx), 100000, 2) && hasAcct(tx, 'Sales Revenue'), why: `taxable=${taxableLeg(tx)} sales=${hasAcct(tx, 'Sales Revenue')} (want 100000 taxable)` }) },
  { t: 'broker Sanjay ko 5000 commission diya',
    check: (tx) => ({ ok: near(total(tx), 5000) && hasAcct(tx, 'Commission Expense'), why: `total=${total(tx)} comm=${hasAcct(tx, 'Commission Expense')} (want Commission 5000)` }) },
  { t: 'bank se 20000 nikale',
    check: (tx) => ({ ok: near(total(tx), 20000) && hasAcct(tx, 'Cash') && hasAcct(tx, 'Bank'), why: `total=${total(tx)} cash=${hasAcct(tx, 'Cash')} bank=${hasAcct(tx, 'Bank')} (want Cash<-Bank 20000)` }) },
  { t: 'client ne 5000 wapas kiya galti se',
    check: (tx) => ({ ok: near(total(tx), 5000), why: `total=${total(tx)} intent=${tx.intent} (want some 5000 entry)` }) },
  { t: '36000 ka bill tha, usme se 6000 advance pehle diya tha, baaki 30000 pay kiya',
    check: (tx) => ({ ok: near(total(tx), 36000, 1) && (tx.entries || []).length >= 2, why: `total=${total(tx)} legs=${(tx.entries || []).length} (want full 36000 with advance leg + payment leg)` }) },
];

const client = new Anthropic({ apiKey: API_KEY, timeout: 60000, maxRetries: 1 });
const system = [
  { type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: buildVolatileContext(CTX) },
];

async function runOne(text) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    ...(supportsAdaptiveThinking(MODEL) ? { thinking: { type: 'adaptive' } } : {}),
    system,
    output_config: { format: { type: 'json_schema', schema: LLM_TXN_SCHEMA } },
    messages: [{ role: 'user', content: `<user_message>\n${text}\n</user_message>` }],
  });
  const u = resp.usage || {};
  const tokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
  if (resp.stop_reason === 'refusal') throw new Error('refusal');
  if (resp.stop_reason === 'max_tokens') throw new Error('max_tokens (response cut off)');
  const block = (resp.content || []).find((b) => b && b.type === 'text');
  const json = JSON.parse(block && block.text);
  const tx = sanitizeLlmTransaction(json, { text, todayISO: CTX.todayISO, modelId: MODEL });
  return { tx, tokens };
}

(async () => {
  console.log(`\nLLM Accounting Agent eval — model: ${MODEL}\n${'='.repeat(70)}`);
  let pass = 0, tokensTotal = 0;
  const fails = [];
  for (let i = 0; i < CASES.length; i++) {
    const { t, check } = CASES[i];
    try {
      const { tx, tokens } = await runOne(t);
      tokensTotal += tokens;
      const r = check(tx);
      if (r.ok) pass++; else fails.push({ i: i + 1, t, why: r.why });
      const legs = (tx.entries || []).map((e) => `${e.debitAccount} / ${e.creditAccount} ${e.amount}`).join('  |  ');
      console.log(`\n${r.ok ? '✅' : '❌'} #${i + 1} "${t}"`);
      console.log(`   intent=${tx.intent} conf=${tx.confidence} model=${tx.model}`);
      console.log(`   ${legs}`);
      if (!r.ok) console.log(`   ↳ ${r.why}`);
    } catch (err) {
      fails.push({ i: i + 1, t, why: `ERROR: ${err.message}` });
      console.log(`\n❌ #${i + 1} "${t}"\n   ERROR: ${err.message}`);
    }
  }
  console.log(`\n${'='.repeat(70)}`);
  console.log(`RESULT: ${pass}/${CASES.length} passed  ·  ~${tokensTotal.toLocaleString()} tokens  ·  bar = 12/15`);
  if (fails.length) { console.log('\nFailures to review:'); fails.forEach((f) => console.log(`  #${f.i} "${f.t}" — ${f.why}`)); }
  process.exit(pass >= 12 ? 0 : 2);
})();
