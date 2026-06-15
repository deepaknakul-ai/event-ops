// ─────────────────────────────────────────────────────────────────────────────
// Rule-based Natural Language Understanding for the AI Accountant.
// Pure: takes user text + context, returns a canonical Transaction.
// Phase 1 scope — preserves existing VirtualAccountant intents with better
// structure, confidence scores, and the new Transaction shape.
// ─────────────────────────────────────────────────────────────────────────────

import { extractAmountSmart, detectPaymentMode } from './amount.js';
import { extractParty, stripHonorifics, diceSimilarity } from './party.js';
import { parseDate } from './dates.js';
import { extractGSTRate, splitGSTByRate, extractSplitLines, extractVoucherNo, extractProjectTag, extractTDSBreakdown } from './extract.js';
import { inferAccountMeta, KNOWN_ACCOUNT_DEFAULTS, round2 } from './schema.js';
import { suggestAccountForText, suggestAccountForParty, suggestIntentFromPhrase } from './learning.js';
import { determineSupplyType, outputGSTLines, inputGSTLines, classifyExpenseAccount, tdsSectionForTransaction } from './knowledge.js';

// ── Intent keyword table ─────────────────────────────────────────────────────
// Each list intentionally contains many natural-language variants — formal,
// casual, abbreviated, and Hinglish — so the same business event can be
// expressed in many ways and still be classified correctly.
const INTENT_SIGNALS = {
  receipt: {
    keywords: [
      'received', 'receive', 'got', 'collected', 'collection', 'recd', 'rcvd',
      'incoming', 'came in', 'money came', 'payment from', 'amount from',
      'client paid', 'customer paid', 'they paid', 'paisa aaya', 'paise aaye',
      'mila', 'mil gaya', 'cleared dues', 'cleared invoice', 'settled invoice',
      'inflow', 'credited to our', 'in our account from', 'against invoice from',
    ],
    weight: 10,
  },
  payment: {
    keywords: [
      'paid', 'pay', 'sent', 'transferred', 'transfer', 'gave', 'given',
      'outgoing', 'payment to', 'amount to', 'settled', 'cleared',
      'remitted', 'released payment', 'made payment', 'sent money',
      'paisa diya', 'pay kar diya', 'pay kiya', 'paid off',
      'cleared bill', 'clearing', 'disbursed', 'paid out', 'outflow',
    ],
    weight: 10,
  },
  invoice: {
    keywords: [
      'invoice', 'invoiced', 'billed', 'bill', 'raised invoice', 'raise invoice',
      'billing', 'raise bill', 'tax invoice', 'gst invoice',
      'cut invoice', 'issued invoice', 'sales invoice', 'invoice raised',
      'bill banaya', 'invoice banaya', 'send invoice to', 'invoice issued',
    ],
    weight: 15,
  },
  salary: {
    keywords: [
      'salary', 'salaries', 'wages', 'wage', 'payroll', 'staff payment',
      'employee payment', 'stipend', 'tankha', 'tankhwah', 'salary di',
      'monthly salary', 'paid salary', 'salary paid', 'payroll run',
      'compensation paid',
    ],
    weight: 15,
  },
  expense: {
    keywords: [
      'expense', 'spent', 'spending', 'expensed', 'cost', 'charged',
      'office expense', 'misc expense', 'kharcha', 'kharcha hua', 'lagaya',
      'used for', 'paid for', 'reimburse', 'reimbursement', 'incurred',
      'out of pocket', 'petty cash', 'cash spent', 'spend on',
    ],
    weight: 12,
  },
  advance: {
    keywords: [
      'advance', 'adv', 'advance to', 'loan to employee', 'staff advance',
      'employee advance', 'imprest', 'imprest given', 'salary advance',
      'gave advance', 'advance diya',
    ],
    weight: 15,
  },
  purchase: {
    keywords: [
      'purchased', 'bought', 'purchase', 'buying', 'procurement', 'ordered',
      'vendor bill', 'supplier', 'kharida', 'liya from', 'po raised',
      'received goods', 'grn', 'inwarded', 'purchased from',
    ],
    weight: 12,
  },
  bank_deposit: {
    keywords: [
      'deposit', 'deposited', 'cash to bank', 'bank deposit', 'put in bank',
      'banked', 'cash deposit', 'cdm', 'cash deposit machine',
      'paid in cash to bank',
    ],
    weight: 15,
  },
  bank_withdrawal: {
    keywords: [
      'withdraw', 'withdrew', 'withdrawal', 'cash from bank',
      'bank withdrawal', 'atm', 'cash withdrawn',
      'took out cash', 'pulled cash',
    ],
    weight: 15,
  },
  tds: {
    keywords: [
      'tds', 'tax deducted', 'tax deduction', 'withholding tax',
      'tds deducted', 'tds receivable', 'tds kaata', 'tds katwaya',
      'short payment due to tds', 'tds 194',
    ],
    weight: 20,
  },
  credit_note: {
    keywords: [
      'credit note', 'credit memo', 'cn ', 'sales return', 'refund to client',
      'discount given', 'rate difference credit', 'goods returned by client',
    ],
    weight: 20,
  },
  debit_note: {
    keywords: [
      'debit note', 'debit memo', 'dn ', 'purchase return',
      'returned to vendor', 'rate difference debit', 'damaged goods returned',
    ],
    weight: 20,
  },
  rent: {
    keywords: [
      'rent', 'rental', 'lease payment', 'office rent', 'shop rent',
      'godown rent', 'warehouse rent', 'rent paid', 'kiraya', 'kiraya diya',
      'monthly rent',
    ],
    weight: 15,
  },
  asset_purchase: {
    keywords: [
      'bought asset', 'purchased asset', 'new laptop', 'new computer',
      'new machine', 'new equipment', 'new furniture', 'new vehicle',
      'capex', 'capital expenditure', 'fixed asset', 'capitalized',
      'purchased equipment', 'bought machinery',
    ],
    weight: 20,
  },
  depreciation: {
    keywords: [
      'depreciation', 'depreciate', 'wear and tear', 'amortisation',
      'amortization', 'book depreciation', 'monthly depreciation',
    ],
    weight: 25,
  },
  loan_taken: {
    keywords: [
      'loan taken', 'took a loan', 'borrowed', 'loan received', 'availed loan',
      'loan from bank', 'bank loan received', 'cc limit availed',
      'overdraft taken', 'loan disbursed to us',
    ],
    weight: 20,
  },
  loan_repayment: {
    keywords: [
      'loan emi', 'loan repayment', 'repaid loan', 'repay loan', 'emi paid',
      'principal repayment', 'loan installment', 'paid loan',
    ],
    weight: 20,
  },
  interest_paid: {
    keywords: [
      'interest paid', 'paid interest', 'interest on loan', 'interest expense',
      'finance charges', 'interest component',
    ],
    weight: 18,
  },
  interest_earned: {
    keywords: [
      'interest earned', 'interest received', 'interest income', 'fd interest',
      'bank interest', 'savings interest', 'interest credited',
    ],
    weight: 18,
  },
  bad_debt: {
    keywords: [
      'bad debt', 'write off', 'wrote off', 'write-off', 'uncollectible',
      'bad debts', 'irrecoverable', 'doodh ka jal gaya', 'lost money',
      'unrecoverable',
    ],
    weight: 22,
  },
  prepaid_expense: {
    keywords: [
      'prepaid', 'paid in advance for', 'advance rent', 'prepaid insurance',
      'prepaid expense', 'paid advance insurance', 'insurance for the year',
    ],
    weight: 22,
  },
  outstanding_expense: {
    keywords: [
      'outstanding', 'accrued', 'accrual', 'provision for', 'payable but not paid',
      'yet to pay', 'expense payable', 'unpaid expense', 'due but not paid', 'book the expense',
    ],
    weight: 22,
  },
  capital_introduced: {
    keywords: [
      'capital introduced', 'introduced capital', 'invested capital', 'capital invested',
      'owner invested', 'brought in capital', 'infused capital', 'capital infusion', 'proprietor introduced',
    ],
    weight: 24,
  },
  drawings: {
    keywords: [
      'drawings', 'drew for personal', 'withdrew for personal', 'personal use',
      'owner withdrew', 'proprietor withdrew', 'personal expense from business',
    ],
    weight: 24,
  },
  gst_payment: {
    keywords: [
      'gst payment', 'paid gst', 'gst paid', 'deposited gst', 'gst deposited',
      'gst challan', 'gst to government', 'gstr3b payment', 'paid gst to govt',
      'gst liability paid',
    ],
    weight: 24,
  },
  tds_payment: {
    keywords: [
      'tds payment', 'paid tds', 'deposited tds', 'tds deposited', 'tds challan',
      'tds to government', 'tds liability paid', 'paid tds to govt',
    ],
    weight: 24,
  },
};

// Max possible signal weight used to normalize confidence into [0..1].
const MAX_SIGNAL = 35;

/**
 * @param {string} text
 * @returns {{intent: string|null, score: number, bankSignal: boolean}}
 */
export function classifyIntent(text) {
  const lower = (text || '').toLowerCase();
  const scores = {};
  for (const [intent, config] of Object.entries(INTENT_SIGNALS)) {
    scores[intent] = 0;
    for (const kw of config.keywords) {
      if (lower.includes(kw)) {
        scores[intent] += config.weight;
        if (lower.indexOf(kw) < 20) scores[intent] += 5; // early-position bonus
        // Multi-word phrase bonus — rewards specific intents over generic ones.
        if (kw.includes(' ')) scores[intent] += 8;
      }
    }
  }

  const hasFrom = /\bfrom\b/i.test(text);
  const hasTo = /\bto\b/i.test(text);
  if (scores.receipt > 0 && scores.payment > 0) {
    if (hasFrom && !hasTo) scores.receipt += 5;
    if (hasTo && !hasFrom) scores.payment += 5;
  }
  // "X paid us / me / our company" → it's money COMING IN, regardless of 'paid'.
  if (/\bpaid\s+(us|me|our\s+(company|firm|account|business)|the\s+company)\b/i.test(text)) {
    scores.receipt = (scores.receipt || 0) + 20;
    scores.payment = Math.max(0, (scores.payment || 0) - 10);
  }
  // Negative-keyword guard: "rent received / rental income" is INCOME, not a
  // rent expense. Suppress the rent-expense intent and treat as a receipt.
  if (scores.rent > 0 && /\brent(al)?\s+(received|income|earned|collected)\b/i.test(text)) {
    scores.rent = 0;
    scores.receipt = (scores.receipt || 0) + 18;
  }
  if (scores.expense > 0 && scores.payment > 0 && hasTo) scores.payment += 3;

  // Net-of-TDS outflow: when a salary/payment verb co-occurs with "TDS", WE are
  // withholding tax on an outflow — keep salary/payment (the compound parser
  // adds the TDS leg). The bare `tds` intent stays for client-deducted receipts
  // (no salary/payment verb present).
  if (scores.tds > 0 && (scores.salary > 0 || scores.payment > 0)) {
    if (scores.salary >= scores.payment) scores.salary += 15;
    else scores.payment += 12;
    scores.tds = Math.max(0, scores.tds - 12);
  }

  const bankSignal = /\b(bank|neft|rtgs|upi|imps|online|net\s*banking|cheque|check)\b/i.test(text);

  let best = null;
  let bestScore = 0;
  for (const [intent, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; best = intent; }
  }
  return { intent: best, score: bestScore, bankSignal };
}

// ── Expense account inference ────────────────────────────────────────────────
const EXPENSE_KEYWORDS = [
  { re: /\b(rent|lease)\b/i,                                                             account: 'Rent Expense' },
  { re: /\b(travel|cab|fuel|petrol|diesel|uber|ola|flight|train|bus)\b/i,                 account: 'Travel Expense' },
  { re: /\b(food|meal|lunch|dinner|breakfast|tea|coffee|snack|catering)\b/i,             account: 'Food Expense' },
  { re: /\b(salary|wages|payroll)\b/i,                                                    account: 'Salary Expense' },
  { re: /\b(electric|utility|water|internet|wifi|broadband|phone|mobile|recharge)\b/i,    account: 'Utilities Expense' },
  { re: /\b(office|stationery|supplies|printer|paper|pen)\b/i,                           account: 'Office Supplies Expense' },
  { re: /\b(repair|maintenance|service|amc|fix)\b/i,                                     account: 'Repairs & Maintenance' },
  { re: /\b(insurance|premium)\b/i,                                                       account: 'Insurance Expense' },
  { re: /\b(legal|lawyer|advocate|court)\b/i,                                              account: 'Legal Expense' },
  { re: /\b(marketing|adverti|promo|campaign|ads)\b/i,                                    account: 'Marketing Expense' },
  { re: /\b(commission|brokerage)\b/i,                                                    account: 'Commission Expense' },
  { re: /\b(courier|shipping|freight|transport|logistics)\b/i,                            account: 'Freight & Logistics' },
];

/** @param {string} desc */
export function guessExpenseAccount(desc) {
  for (const { re, account } of EXPENSE_KEYWORDS) {
    if (re.test(desc)) return account;
  }
  return 'Expense:General';
}

// ── Asset account inference ─────────────────────────────────────────────────
const ASSET_KEYWORDS = [
  { re: /\b(laptop|computer|pc|desktop|server|printer|monitor|it\s*equipment|hardware)\b/i, account: 'Computer Equipment' },
  { re: /\b(camera|lens|lights?|speakers?|mixer|console|led\s*wall|projector|stage|truss|av\s*equipment)\b/i, account: 'AV Equipment' },
  { re: /\b(vehicle|car|truck|van|tempo|bike|scooter)\b/i, account: 'Vehicles' },
  { re: /\b(furniture|chair|desk|table|cabinet|sofa)\b/i, account: 'Furniture & Fixtures' },
  { re: /\b(building|land|property|office\s*space)\b/i, account: 'Land & Building' },
  { re: /\b(machine|machinery|tools?|generator|compressor)\b/i, account: 'Plant & Machinery' },
  { re: /\b(software|license|subscription\s*asset|saas\s*perpetual)\b/i, account: 'Software' },
];

/** @param {string} desc */
export function guessAssetAccount(desc) {
  for (const { re, account } of ASSET_KEYWORDS) {
    if (re.test(desc)) return account;
  }
  return '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);

function buildAccountCreates(entries) {
  const seen = new Set();
  const out = [];
  for (const line of entries) {
    for (const accName of [line.debitAccount, line.creditAccount]) {
      if (!accName || seen.has(accName)) continue;
      seen.add(accName);
      out.push(inferAccountMeta(accName));
    }
  }
  return out;
}

// ── Reversal / Query intent detectors ───────────────────────────────────────
const REVERSAL_KEYWORDS = ['reverse', 'reversal', 'cancel voucher', 'void voucher', 'undo jv', 'correct jv', 'correction of jv'];
const QUERY_KEYWORDS = [
  { re: /\b(show|list|how\s+much|what\s+(is|are|was)|total|balance|summary)\b/i, weight: 10 },
  { re: /\bhow\s+much\b/i, weight: 8 },
  { re: /\b(do\s+we\s+have|do\s+i\s+have|did\s+we|did\s+i)\b/i, weight: 8 },
  { re: /\b(expenses?|spending|spent)\b/i, weight: 8 },
  { re: /\b(sales|revenue|income|invoiced|receipts?|received)\b/i, weight: 8 },
  { re: /\b(profit|p\s*&\s*l|pnl|p\/l)\b/i, weight: 12 },
  { re: /\b(balance\s*sheet|bs)\b/i, weight: 12 },
  { re: /\b(cash|bank)\s+balance\b/i, weight: 15 },
  { re: /\b(trial\s*balance|tb)\b/i, weight: 15 },
];

/** @param {string} text */
function detectReversal(text) {
  const lower = text.toLowerCase();
  const hit = REVERSAL_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hit) return null;
  const voucher = extractVoucherNo(text);
  if (!voucher) return { ok: false, reason: 'no_voucher' };
  return { ok: true, voucher };
}

/** @param {string} text */
function detectQuery(text) {
  let score = 0;
  for (const { re, weight } of QUERY_KEYWORDS) {
    if (re.test(text)) score += weight;
  }
  // Boost when a concrete period is mentioned — short phrases like
  // "expenses this month" or "revenue vs expenses last fy" should qualify
  // even without an explicit verb like "show" or "how much".
  if (/\b(today|yesterday|this|last|previous|current|q[1-4])\s*(week|month|year|fy|quarter)?\b/i.test(text)
      || /\b(fy|quarter|q[1-4])\b/i.test(text)) {
    score += 8;
  }
  if (score < 15) return null;
  const lower = text.toLowerCase();
  // ── Compound / compare detection ───────────────────────────────────────
  // "revenue vs expenses", "revenue and expenses", "income vs spending"
  const mentionsRevenue = /\b(sales|revenue|income|invoiced)\b/.test(lower);
  const mentionsExpenses = /\b(expenses?|spending|spent)\b/.test(lower);
  const mentionsCompareWord = /\bvs\.?\b|\bversus\b|\band\b|\bcompared?\s+(to|with)\b/.test(lower);
  let queryType = 'summary';
  /** @type {string[] | undefined} */
  let series;
  if (mentionsRevenue && mentionsExpenses && mentionsCompareWord) {
    queryType = 'compare';
    series = ['revenue', 'expenses'];
  }
  else if (/\bcash\s+balance|how\s+much.*cash\b/.test(lower))      queryType = 'cash_balance';
  else if (/\bbank\s+balance|how\s+much.*bank\b/.test(lower))      queryType = 'bank_balance';
  else if (/\bprofit|p\s*&\s*l|pnl|p\/l/.test(lower))              queryType = 'pnl';
  else if (/\bbalance\s*sheet|bs\b/.test(lower))                   queryType = 'balance_sheet';
  else if (/\btrial\s*balance|tb\b/.test(lower))                   queryType = 'trial_balance';
  else if (mentionsExpenses)                                       queryType = 'expenses';
  else if (mentionsRevenue)                                        queryType = 'revenue';
  // Period detection
  let period = 'this_month';
  if (/\btoday\b/.test(lower))                              period = 'today';
  else if (/\byesterday\b/.test(lower))                     period = 'yesterday';
  else if (/\blast\s+month\b/.test(lower))                  period = 'last_month';
  else if (/\bthis\s+week\b/.test(lower))                   period = 'this_week';
  else if (/\blast\s+week\b/.test(lower))                   period = 'last_week';
  else if (/\b(this\s+year|current\s+fy|this\s+fy)\b/.test(lower))      period = 'this_fy';
  else if (/\b(last\s+year|previous\s+fy|last\s+fy)\b/.test(lower))     period = 'last_fy';
  else if (/\bq[1-4]\b/.test(lower)) {
    const q = lower.match(/\bq([1-4])\b/);
    period = `quarter_${q[1]}`;
  }
  return { queryType, period, score, series };
}

// ── Party candidate resolution (for clarify flow) ───────────────────────────
/**
 * Find every plausible party match in `ctx.partyNames` for the text.
 * Used to decide whether to ask a clarifying question.
 * @param {string} text
 * @param {string[]} [names]
 */
export function findPartyCandidates(text, names) {
  if (!text || !Array.isArray(names) || !names.length) return [];
  const lower = text.toLowerCase();
  const hits = [];

  const compact = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const compactText = compact(text);
  for (const n of names) {
    const ln = n.toLowerCase();
    if (ln.length < 2) continue;
    // Exact token
    if (new RegExp(`\\b${escapeRegex(ln)}\\b`).test(lower)) {
      hits.push({ name: n, weight: 10, source: 'exact' });
      continue;
    }
    // Exact-ish on compacted string (handles punctuation/noise differences)
    if (compactText && compactText.includes(compact(n))) {
      hits.push({ name: n, weight: 10, source: 'exact' });
      continue;
    }
    // Starts-with first-word of name
    const firstWord = ln.split(/\s+/)[0];
    if (firstWord.length >= 3 && new RegExp(`\\b${escapeRegex(firstWord)}\\b`).test(lower)) {
      hits.push({ name: n, weight: 5, source: 'prefix' });
      continue;
    }
    // Fuzzy: honorific-insensitive bigram similarity against each input word
    // ("sharma ji" ↔ "Sharma Traders"). Only a candidate, not an exact match.
    const strippedName = stripHonorifics(n).toLowerCase();
    const words = compactText.split(' ').filter((w) => w.length >= 3);
    const bestDice = words.reduce((mx, w) => Math.max(mx, diceSimilarity(w, strippedName)), 0);
    if (bestDice >= 0.55) hits.push({ name: n, weight: 4, source: 'fuzzy' });
  }
  // Deduplicate by name, keep highest weight
  const byName = {};
  for (const h of hits) {
    if (!byName[h.name] || byName[h.name].weight < h.weight) byName[h.name] = h;
  }

  const ranked = Object.values(byName).sort((a, b) => b.weight - a.weight);
  // If user has explicitly mentioned a full party name, keep only exact matches.
  // This prevents repeated clarify prompts when fuzzy matches are also present.
  const exact = ranked.filter((h) => h.source === 'exact');
  return exact.length > 0 ? exact : ranked;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Parse a free-text user message into a canonical Transaction.
 * @param {string} text
 * @param {{partyNames?: string[], date?: string}} [ctx]
 * @returns {import('./schema.js').Transaction | null}
 */
export function parseMessage(text, ctx = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length < 3) return null;

  // ── Control intents (no amount / entries required) ────────────────────────
  const rev = detectReversal(trimmed);
  if (rev) {
    return {
      intent: 'reversal',
      date: ctx.date || today(),
      narration: rev.ok ? `Reverse voucher ${rev.voucher}` : 'Reverse voucher',
      entries: [],
      party: { type: 'internal', name: '' },
      mode: 'Cash',
      accountCreates: [],
      issues: rev.ok ? [] : [{ level: 'error', code: 'reversal_no_voucher', message: 'Please include a voucher number to reverse (e.g. "reverse JV-0042").' }],
      confidence: rev.ok ? 0.9 : 0.5,
      rawPrompt: trimmed,
      model: 'rule-v1',
      meta: { reverseVoucher: rev.ok ? rev.voucher : null },
    };
  }
  const q = detectQuery(trimmed);
  if (q) {
    return {
      intent: 'query',
      date: ctx.date || today(),
      narration: `Query: ${q.queryType} (${q.period})`,
      entries: [],
      party: { type: 'internal', name: '' },
      mode: 'Cash',
      accountCreates: [],
      issues: [],
      confidence: Math.min(1, round2(q.score / 40)),
      rawPrompt: trimmed,
      model: 'rule-v1',
      meta: { queryType: q.queryType, period: q.period, series: q.series },
    };
  }

  const amount = extractAmountSmart(trimmed);

  // Pre-classify intent so we can give a clarifying response even without $.
  let { intent, score, bankSignal } = classifyIntent(trimmed);

  // Phrase-intent learning: when the rule-based classifier is unsure or wrong,
  // consult the user's own past entries. A confident match overrides; a soft
  // match merely boosts whatever the rule engine picked.
  if (ctx.learned) {
    const learnedIntent = suggestIntentFromPhrase(trimmed, ctx.learned);
    if (learnedIntent) {
      if (!intent || score < 10) {
        intent = learnedIntent.intent;
        score = Math.max(score, 12 + Math.min(8, learnedIntent.count));
      } else if (intent === learnedIntent.intent) {
        score += Math.min(6, learnedIntent.count);
      }
    }
  }

  // Fallback: an expense noun without an explicit spend verb ("diesel 4k for
  // site", "office electricity 3000"). If a specific expense account is
  // recognised, treat the message as an expense.
  if (!intent || score < 8) {
    const guess = classifyExpenseAccount(trimmed);
    if (guess.account && guess.account !== 'Miscellaneous Expense') {
      intent = 'expense';
      score = Math.max(score, 12);
    }
  }

  if (amount <= 0) {
    // No amount, but we detected a booking-style intent → ask for it.
    if (intent && score > 0) {
      return {
        intent: 'clarify',
        date: ctx.date || today(),
        narration: 'Clarification needed',
        entries: [],
        party: { type: 'internal', name: '' },
        mode: 'Cash',
        accountCreates: [],
        issues: [],
        confidence: 0.4,
        rawPrompt: trimmed,
        model: 'rule-v1',
        meta: {
          clarifyKind: 'amount',
          question: `How much is the ${intent}? (e.g. "50k", "1,25,000")`,
          proposedIntent: intent,
        },
      };
    }
    return null;
  }

  if (!intent || score <= 0) return null;

  // ── Clarify: ambiguous party ───────────────────────────────────────────────
  const forcedParty = String(ctx.forceParty || '').trim();
  const partyCandidates = forcedParty
    ? [{ name: forcedParty, weight: 99, source: 'forced' }]
    : findPartyCandidates(trimmed, ctx.partyNames);

  if (!forcedParty && partyCandidates.length > 1) {
    return {
      intent: 'clarify',
      date: ctx.date || (parseDate(trimmed) || {}).date || today(),
      narration: 'Clarification needed',
      entries: [],
      party: { type: 'unknown', name: '' },
      mode: detectPaymentMode(trimmed),
      accountCreates: [],
      issues: [],
      confidence: 0.5,
      rawPrompt: trimmed,
      model: 'rule-v1',
      meta: {
        clarifyKind: 'party',
        question: 'Which party did you mean?',
        options: partyCandidates.slice(0, 5).map((c) => c.name),
        proposedIntent: intent,
        amount,
      },
    };
  }

  const party = partyCandidates.length === 1 ? partyCandidates[0].name : extractParty(trimmed, ctx);
  const mode = detectPaymentMode(trimmed);
  const cashOrBank = bankSignal ? 'Bank' : mode;
  // Date resolution: explicit ctx.date > natural-language date in text > today.
  const found = parseDate(trimmed);
  const date = ctx.date || (found && found.date) || today();
  const dateMatched = found ? found.matched : null;
  const confidence = Math.min(1, round2(score / MAX_SIGNAL));
  const projectTag = extractProjectTag(trimmed, ctx.projectNames);

  /** @type {import('./schema.js').Transaction} */
  const base = {
    intent,
    date,
    narration: '',
    entries: [],
    party: party
      ? { type: /vendor|supplier|bought|purchase/i.test(trimmed) ? 'vendor' : 'client', name: party }
      : { type: 'unknown', name: '' },
    mode: cashOrBank,
    confidence,
    rawPrompt: trimmed,
    model: 'rule-v1',
    meta: { amount, dateMatched },
  };

  switch (intent) {
    case 'receipt': {
      const p = party || 'Unknown Client';
      base.entries = [{ debitAccount: cashOrBank, creditAccount: `Party: ${p}`, amount }];
      base.narration = `Payment received from ${p}${bankSignal ? ' (bank)' : ''}`;
      base.party = { type: 'client', name: p };
      break;
    }
    case 'payment': {
      const p = party || 'Unknown Vendor';
      const tdsB = extractTDSBreakdown(trimmed);
      if (tdsB) {
        // Vendor payment with TDS withheld: settle the payable, pay net, hold TDS.
        base.entries = [
          { debitAccount: `Party: ${p}`, creditAccount: cashOrBank, amount: tdsB.net },
          { debitAccount: `Party: ${p}`, creditAccount: 'TDS Payable', amount: tdsB.tds },
        ];
        base.narration = `Payment to ${p} (gross ${tdsB.gross}, TDS ${tdsB.tds})`;
        base.meta = { ...base.meta, compound: true, gross: tdsB.gross, tds: tdsB.tds, net: tdsB.net, amount: tdsB.gross };
      } else {
        base.entries = [{ debitAccount: `Party: ${p}`, creditAccount: cashOrBank, amount }];
        base.narration = `Payment made to ${p}${bankSignal ? ' (bank)' : ''}`;
      }
      base.party = { type: 'vendor', name: p };
      break;
    }
    case 'invoice': {
      const p = party || 'Unknown Client';
      const rate = extractGSTRate(trimmed);
      const { taxable, gst } = splitGSTByRate(amount, rate);
      const partyGstin = ctx.partyGstins?.[p.toLowerCase()] || '';
      const supplyType = determineSupplyType(ctx.orgGstin, partyGstin);
      const gstLines = outputGSTLines(gst, supplyType);
      base.entries = [
        { debitAccount: `Party: ${p}`, creditAccount: 'Sales Revenue', amount: taxable },
        ...gstLines.map((g) => ({ debitAccount: `Party: ${p}`, creditAccount: g.account, amount: g.amount })),
      ];
      const gstLabel = rate > 0
        ? `incl. ${rate}% GST (${supplyType === 'inter' ? 'IGST' : supplyType === 'intra' ? 'CGST+SGST' : 'GST'})`
        : 'exempt / no GST';
      base.narration = `Invoice raised to ${p} (${gstLabel})`;
      base.party = { type: 'client', name: p };
      base.meta = { ...base.meta, taxable, gst, gstRate: rate, supplyType };
      break;
    }
    case 'salary': {
      const name = party || 'Staff';
      const tdsB = extractTDSBreakdown(trimmed);
      if (tdsB) {
        // Gross salary split: net paid in cash/bank + TDS withheld (per-line balanced).
        base.entries = [
          { debitAccount: 'Salary Expense', creditAccount: cashOrBank, amount: tdsB.net },
          { debitAccount: 'Salary Expense', creditAccount: 'TDS Payable', amount: tdsB.tds },
        ];
        base.narration = `Salary to ${name} (gross ${tdsB.gross}, TDS ${tdsB.tds})`;
        base.meta = { ...base.meta, compound: true, gross: tdsB.gross, tds: tdsB.tds, net: tdsB.net, amount: tdsB.gross };
      } else {
        base.entries = [{ debitAccount: 'Salary Expense', creditAccount: cashOrBank, amount }];
        base.narration = `Salary paid to ${name}`;
      }
      base.party = { type: 'employee', name };
      break;
    }
    case 'expense': {
      // Split-line: "spent 5000 on travel and 2000 on food" -> 2 lines.
      // Accept when the parser found >=2 line-items. (We DO NOT clamp to the
      // smart-extracted amount, because that picks a single number — the user
      // typically wrote N sub-amounts whose sum is the true total.)
      const hasProject = !!projectTag;
      const split = extractSplitLines(trimmed);
      if (split.length >= 2) {
        base.entries = split.map((item) => ({
          debitAccount: classifyExpenseAccount(item.description, { hasProject }).account,
          creditAccount: cashOrBank,
          amount: item.amount,
        }));
        base.narration = `Expense (split): ${split.map((i) => i.description).join(' + ')}`;
        base.meta = { ...base.meta, split: true, lineCount: split.length };
      } else {
        const learnedAcct = suggestAccountForText(trimmed, ctx.learned);
        const classified = classifyExpenseAccount(trimmed, { hasProject });
        const account = (learnedAcct && learnedAcct.confidence >= 0.4 ? learnedAcct.account : null)
          || classified.account;
        base.entries = [{ debitAccount: account, creditAccount: cashOrBank, amount }];
        base.narration = `Expense: ${party || trimmed}`;
        base.meta = { ...base.meta, expenseGroup: classified.direct ? 'Direct' : 'Indirect' };
      }
      break;
    }
    case 'advance': {
      const name = party || 'Employee';
      base.entries = [{ debitAccount: 'Employee Advances', creditAccount: cashOrBank, amount }];
      base.narration = `Advance given to ${name}`;
      base.party = { type: 'employee', name };
      break;
    }
    case 'purchase': {
      const p = party || 'Unknown Vendor';
      const rate = extractGSTRate(trimmed);
      const { taxable, gst } = splitGSTByRate(amount, rate);
      const partyGstin = ctx.partyGstins?.[p.toLowerCase()] || '';
      const supplyType = determineSupplyType(ctx.orgGstin, partyGstin);
      const gstLines = inputGSTLines(gst, supplyType);
      base.entries = [
        { debitAccount: 'Purchase Expense', creditAccount: `Party: ${p}`, amount: taxable },
        ...gstLines.map((g) => ({ debitAccount: g.account, creditAccount: `Party: ${p}`, amount: g.amount })),
      ];
      const gstLabel = rate > 0
        ? `incl. ${rate}% GST (${supplyType === 'inter' ? 'IGST' : supplyType === 'intra' ? 'CGST+SGST' : 'GST'})`
        : 'no GST';
      base.narration = `Purchase from ${p} (${gstLabel})`;
      base.party = { type: 'vendor', name: p };
      base.meta = { ...base.meta, taxable, gst, gstRate: rate, supplyType };
      break;
    }
    case 'bank_deposit': {
      base.entries = [{ debitAccount: 'Bank', creditAccount: 'Cash', amount }];
      base.narration = 'Cash deposited to bank';
      break;
    }
    case 'bank_withdrawal': {
      base.entries = [{ debitAccount: 'Cash', creditAccount: 'Bank', amount }];
      base.narration = 'Cash withdrawn from bank';
      break;
    }
    case 'tds': {
      const p = party || 'Unknown Party';
      base.entries = [{ debitAccount: 'TDS Receivable', creditAccount: `Party: ${p}`, amount }];
      base.narration = `TDS deducted by ${p}`;
      base.party = { type: 'client', name: p };
      break;
    }
    case 'credit_note': {
      const p = party || 'Unknown Client';
      base.entries = [{ debitAccount: 'Sales Revenue', creditAccount: `Party: ${p}`, amount }];
      base.narration = `Credit Note issued to ${p}`;
      base.party = { type: 'client', name: p };
      break;
    }
    case 'debit_note': {
      const p = party || 'Unknown Vendor';
      base.entries = [{ debitAccount: `Party: ${p}`, creditAccount: 'Purchase Expense', amount }];
      base.narration = `Debit Note issued to ${p}`;
      base.party = { type: 'vendor', name: p };
      break;
    }
    case 'rent': {
      base.entries = [{ debitAccount: 'Rent Expense', creditAccount: cashOrBank, amount }];
      base.narration = `Rent payment${party ? ` to ${party}` : ''}`;
      break;
    }
    case 'asset_purchase': {
      // Only treat as vendor if the extracted party is actually in our party list.
      const isKnownParty = party && Array.isArray(ctx.partyNames) &&
        ctx.partyNames.some((n) => (n || '').toLowerCase() === party.toLowerCase());
      const p = isKnownParty ? party : '';
      const acc = guessAssetAccount(trimmed) || 'Fixed Assets';
      base.entries = [{ debitAccount: acc, creditAccount: p ? `Party: ${p}` : cashOrBank, amount }];
      base.narration = `Asset purchase: ${trimmed}`;
      if (p) base.party = { type: 'vendor', name: p };
      else base.party = { type: 'internal', name: '' };
      break;
    }
    case 'depreciation': {
      const acc = guessAssetAccount(trimmed) || 'Fixed Assets';
      base.entries = [{ debitAccount: 'Depreciation Expense', creditAccount: `Accumulated Depreciation - ${acc}`, amount }];
      base.narration = `Depreciation charged on ${acc}`;
      base.party = { type: 'internal', name: '' };
      break;
    }
    case 'loan_taken': {
      const p = party || 'Bank';
      base.entries = [{ debitAccount: cashOrBank, creditAccount: `Loan from ${p}`, amount }];
      base.narration = `Loan received from ${p}`;
      base.party = { type: 'lender', name: p };
      break;
    }
    case 'loan_repayment': {
      const p = party || 'Bank';
      base.entries = [{ debitAccount: `Loan from ${p}`, creditAccount: cashOrBank, amount }];
      base.narration = `Loan repayment to ${p}`;
      base.party = { type: 'lender', name: p };
      break;
    }
    case 'interest_paid': {
      const p = party || '';
      base.entries = [{ debitAccount: 'Interest Expense', creditAccount: cashOrBank, amount }];
      base.narration = `Interest paid${p ? ` to ${p}` : ''}`;
      if (p) base.party = { type: 'lender', name: p };
      break;
    }
    case 'interest_earned': {
      const p = party || '';
      base.entries = [{ debitAccount: cashOrBank, creditAccount: 'Interest Income', amount }];
      base.narration = `Interest earned${p ? ` from ${p}` : ''}`;
      if (p) base.party = { type: 'lender', name: p };
      break;
    }
    case 'bad_debt': {
      const p = party || 'Unknown Client';
      base.entries = [{ debitAccount: 'Bad Debts Expense', creditAccount: `Party: ${p}`, amount }];
      base.narration = `Bad debt written off — ${p}`;
      base.party = { type: 'client', name: p };
      break;
    }
    case 'gst_payment': {
      // Settling the net GST liability with the government.
      base.entries = [{ debitAccount: 'Output GST Payable', creditAccount: cashOrBank, amount }];
      base.narration = 'GST paid to government';
      base.party = { type: 'internal', name: '' };
      break;
    }
    case 'tds_payment': {
      // Depositing TDS deducted from vendors/employees with the government.
      base.entries = [{ debitAccount: 'TDS Payable', creditAccount: cashOrBank, amount }];
      base.narration = 'TDS deposited to government';
      base.party = { type: 'internal', name: '' };
      break;
    }
    case 'prepaid_expense': {
      // Expense paid in advance → recognised as an asset until it is consumed.
      base.entries = [{ debitAccount: 'Prepaid Expenses', creditAccount: cashOrBank, amount }];
      base.narration = `Prepaid expense${party ? ` — ${party}` : ''}`;
      base.party = { type: 'internal', name: '' };
      break;
    }
    case 'outstanding_expense': {
      // Expense incurred but not yet paid → accrue a liability (matching concept).
      const acct = classifyExpenseAccount(trimmed, { hasProject: !!projectTag }).account;
      base.entries = [{ debitAccount: acct, creditAccount: 'Outstanding Expenses', amount }];
      base.narration = `Provision / outstanding: ${acct}`;
      base.party = { type: 'internal', name: '' };
      break;
    }
    case 'capital_introduced': {
      base.entries = [{ debitAccount: cashOrBank, creditAccount: 'Capital', amount }];
      base.narration = 'Capital introduced by owner';
      base.party = { type: 'internal', name: '' };
      break;
    }
    case 'drawings': {
      base.entries = [{ debitAccount: 'Drawings', creditAccount: cashOrBank, amount }];
      base.narration = 'Drawings by owner (personal use)';
      base.party = { type: 'internal', name: '' };
      break;
    }
    default:
      return null;
  }

  base.accountCreates = buildAccountCreates(base.entries);
  if (projectTag) base.meta = { ...base.meta, projectTag };

  // Stamp the inferred TDS section so the validator's compliance layer can warn
  // when a deduction threshold is crossed (consumed via validatorCtx.tdsSection).
  const tdsSection = tdsSectionForTransaction(intent, trimmed);
  if (tdsSection) base.meta = { ...base.meta, tdsSection };

  // Learning: stamp a preferred-account hint for the party (consumer UI can
  // show "Usually posted to: X" next to the entry preview).
  if (ctx.learned && base.party?.name) {
    const hint = suggestAccountForParty(base.party.name, ctx.learned);
    if (hint && hint.confidence >= 0.4) {
      base.meta = { ...base.meta, learnedPartyAccount: hint.account, learnedConfidence: hint.confidence };
    }
  }

  return base;
}

export { KNOWN_ACCOUNT_DEFAULTS };
