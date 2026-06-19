// Intent parser for the global app assistant (rental-ops).
//
// PURE function: takes a user message + a lightweight context (names only,
// no Firestore handles) and returns a canonical intent object. The executor
// layer consumes this to fetch data and render results.
//
// Output shape:
//   {
//     intent: 'projects.today' | 'client.ledger' | ... | 'unknown',
//     entities: { clientName?, employeeName?, status?, dateRange?, count?, category?, vendorName?, projectName? },
//     confidence: 0..1,
//     rawPrompt: string,
//     issues: [{ level: 'error'|'warn'|'info', message }]
//   }

import { parseDateRange } from './dates.js';

// Each intent declares many natural-language phrasings (synonyms, abbreviations,
// Hinglish/casual variants). Keep the canonical, most-specific phrases first —
// scoreIntent() rewards multi-word matches, so longer phrases naturally outrank
// shorter ones. Adding more synonyms here is the primary way to broaden NLU
// coverage without changing executor logic.
export const INTENTS = [
  // ── Projects ────────────────────────────────────────────────────────────
  { id: 'projects.today', keywords: [
    'today project', 'projects today', 'running today', 'executing today',
    'live today', 'ongoing today', 'todays project', "today's project",
    'project today', 'aaj ka project', 'aaj projects', 'whats running today',
    "what's running today", 'currently running', 'on floor today',
    'site today', 'live projects', 'running projects',
  ] },
  { id: 'projects.thisWeek', keywords: [
    'this week project', 'projects this week', 'projects upcoming',
    'upcoming project', 'next 7 day', 'next 7 days', 'week ke projects',
    'is hafte', 'this week', 'coming week',
  ] },
  { id: 'projects.upcoming', keywords: [
    'upcoming project', 'future project', 'next project', 'projects starting',
    'pipeline', 'pipeline projects', 'aane wale project',
    'forthcoming project', 'planned project',
  ] },
  { id: 'projects.overdue', keywords: [
    'overdue project', 'project overdue', 'delayed project', 'past due project',
    'late project', 'pending closure', 'should have ended', 'lapsed project',
  ] },
  { id: 'projects.byStatus', keywords: [
    'status', 'quoted', 'confirmed', 'ongoing', 'completed', 'closed',
    'cancelled', 'in status', 'with status',
  ], requires: 'status' },
  { id: 'projects.byClient', keywords: [
    'project of', 'projects of', 'project for', 'projects for', 'client project',
    "clients project", 'projects with', 'jobs for', 'gigs for', 'shows for',
    'event for', 'events for',
  ], requires: 'clientName' },
  { id: 'projects.unbilled', keywords: [
    'unbilled', 'not invoiced', 'pending invoice', 'ready to invoice',
    'yet to bill', 'bill pending', 'invoice pending project',
    'awaiting invoice', 'to be invoiced', 'billing pending',
  ] },
  { id: 'projects.lossMaking', keywords: [
    'loss making', 'loss-making', 'losing money', 'negative margin', 'at a loss',
    'unprofitable', 'lost money', 'loss projects', 'projects in loss',
  ] },
  { id: 'projects.topMargin', keywords: [
    'most profitable', 'top margin', 'best margin', 'highest margin',
    'best performing project', 'top projects by margin', 'profitable projects', 'most profit',
  ] },
  { id: 'projects.bottomMargin', keywords: [
    'least profitable', 'worst margin', 'lowest margin', 'worst performing project',
  ] },
  { id: 'clients.top', keywords: [
    'top client', 'top clients', 'best client', 'biggest client', 'top customer',
    'clients by revenue', 'highest revenue client', 'most valuable client', 'top accounts',
  ] },
  { id: 'projects.byDateRange', keywords: [
    'projects between', 'projects from', 'projects in', 'projects on',
    'projects during', 'shows between', 'events in', 'jobs in',
  ] },
  { id: 'projects.details', keywords: [
    'details of project', 'project details', 'open project', 'show project',
    'about project', 'open it', 'open that', 'show it',
    'show that', 'project info', 'view project', 'go to project',
    'tell me about', 'project ka detail',
  ], requires: 'projectName' },
  // ── Clients ─────────────────────────────────────────────────────────────
  { id: 'client.ledger', keywords: [
    'ledger of', 'ledger for', 'client ledger', 'account of', 'statement of',
    'account statement', 'transactions of', 'history of', 'khata of', 'khata',
    'ledger', 'soa', 'statement of account',
  ], requires: 'clientName' },
  { id: 'client.list', keywords: [
    'list client', 'all client', 'show client', 'clients list',
    'all customers', 'customer list', 'show customers', 'who are our clients',
  ] },
  { id: 'client.outstanding', keywords: [
    'who owe', 'who owes us', 'receivable', 'receivables', 'outstanding client',
    'money due', 'to receive', 'pending payment from', 'collect from',
    'collection pending', 'baki paisa', 'baaki', 'dues from clients',
    'unpaid clients', 'ar', 'accounts receivable',
  ] },
  // ── Employees ───────────────────────────────────────────────────────────
  { id: 'employee.balance', keywords: [
    'balance of', 'employee balance', 'dues of', 'payable to', 'how much owed to',
    'owe to employee', 'owe to staff', 'staff balance', 'kitna dena hai',
    'employee dues',
  ], requires: 'employeeName' },
  { id: 'employee.projects', keywords: [
    'project of employee', 'projects assigned', 'assigned project',
    'projects for employee', 'projects of staff', 'kis project mein',
    'where is', 'busy with', 'working on',
  ], requires: 'employeeName' },
  { id: 'employee.list', keywords: [
    'list employee', 'all employee', 'show employee', 'team list',
    'all staff', 'staff list', 'show team', 'who all work', 'roster',
  ] },
  // ── Expenses ────────────────────────────────────────────────────────────
  { id: 'expenses.pending', keywords: [
    'pending expense', 'expense pending', 'expense for approval',
    'expenses to approve', 'pending approval', 'expenses awaiting',
    'awaiting approval', 'unapproved expenses', 'reimbursement pending',
    'claims pending', 'expense queue',
  ] },
  { id: 'expenses.byEmployee', keywords: [
    'expense of', 'expenses of', 'expense for', 'expenses by',
    'expense claim of', 'reimbursement of', 'kharcha of',
  ], requires: 'employeeName' },
  { id: 'expenses.approve', keywords: [
    'approve', 'approve expense', 'approve expenses', 'approve all expense',
    'approve all', 'pass expense', 'sanction expense', 'ok expense',
    'green light expense', 'release expense',
  ], requires: 'employeeName', action: 'write' },
  { id: 'expenses.byCategory', keywords: [
    'expenses category', 'category expenses', 'travel expenses',
    'food expenses', 'fuel expenses', 'transport expenses',
    'accommodation expenses', 'lodging expenses', 'fooding expenses',
  ], requires: 'category' },
  { id: 'expenses.byStatus', keywords: [
    'rejected expense', 'approved expense', 'expense status',
    'declined expense', 'cleared expense',
  ] },
  { id: 'expenses.statistics', keywords: [
    'expense statistics', 'expense breakdown', 'expense summary by',
    'expenses by category', 'expense report', 'spending breakdown',
    'kharcha breakdown', 'where did money go',
  ] },
  // ── Payments ────────────────────────────────────────────────────────────
  { id: 'payments.pending', keywords: [
    'pending payment', 'pending invoice', 'money to receive',
    'outstanding receivable', 'unpaid invoice', 'overdue invoice',
    'aged receivables', 'baki invoices',
  ] },
  { id: 'payments.byDate', keywords: [
    'payments received', 'receipts', 'collections', 'money received',
    'money in', 'cash inflow', 'incoming payments', 'paisa aaya',
    'received money',
  ] },
  { id: 'vendor.payments', keywords: [
    'vendor due', 'vendor payment', 'payable to vendor', 'owe vendor',
    'vendor balance', 'supplier dues', 'kya dena hai vendor',
    'payable supplier',
  ] },
  { id: 'finance.payables', keywords: [
    'payables summary', 'payables', 'who do we owe', 'all vendors due',
    'ap', 'accounts payable', 'kisko paisa dena',
  ] },
  { id: 'finance.receivables', keywords: [
    'receivables summary', 'all receivables', 'total receivables',
    'how much to receive overall',
  ] },
  // ── Tax / Purchase invoices ────────────────────────────────────────────
  { id: 'taxInvoices.list', keywords: [
    'tax invoices', 'sales invoices', 'list invoices', 'all invoices',
    'gst invoices', 'invoices issued', 'sales bill list',
  ] },
  { id: 'taxInvoices.byClient', keywords: [
    'invoices of', 'invoices for', 'invoices to', 'bills issued to',
    'sales invoices of',
  ], requires: 'clientName' },
  { id: 'purchaseInvoices.list', keywords: [
    'purchase invoices', 'vendor bills', 'bills received', 'list purchase',
    'bills booked', 'gst purchases', 'vendor invoice list',
  ] },
  { id: 'purchaseInvoices.byVendor', keywords: [
    'bills of', 'bills from', 'purchase invoices of', 'vendor invoices of',
    'invoices received from',
  ], requires: 'vendorName' },
  // ── Inventory ───────────────────────────────────────────────────────────
  { id: 'inventory.low', keywords: [
    'low stock', 'out of stock', 'shortage inventory', 'stock kam',
    'reorder', 'below reorder', 'short of', 'running low',
  ] },
  { id: 'inventory.search', keywords: [
    'inventory of', 'stock of', 'how many', 'kitne hai', 'kitna stock',
    'available stock', 'qty of', 'quantity of',
  ], requires: 'itemName' },
  { id: 'inventory.byCategory', keywords: [
    'inventory category', 'items in category', 'inventory by category',
    'led inventory', 'audio inventory', 'video inventory',
    'lighting inventory', 'staging inventory',
  ], requires: 'category' },
  // ── Reports ─────────────────────────────────────────────────────────────
  { id: 'reports.pl', keywords: [
    'profit loss', 'p&l', 'profit and loss', 'pnl', 'profit report',
    'net profit', 'how much profit', 'profit kitna', 'p/l',
  ] },
  { id: 'reports.revenue', keywords: [
    'total revenue', 'total income', 'total sales', 'revenue this',
    'revenue fy', 'turnover', 'top line', 'sales total',
  ] },
  { id: 'reports.expenses', keywords: [
    'total expense', 'expense summary', 'total spending', 'how much spent',
    'kul kharcha', 'cost summary',
  ] },
  { id: 'reports.cashPosition', keywords: [
    'cash position', 'cash bank balance', 'bank balance', 'cash balance',
    'how much cash', 'liquidity', 'kitna paisa hai', 'tijori',
  ] },
  // ── Personal digest ─────────────────────────────────────────────────────
  { id: 'digest.myPending', keywords: [
    'my pending', 'my queue', 'my tasks', 'whats pending', "what's pending",
    'my dashboard', 'pending items', 'my todo', 'mere pending',
    'my work', 'inbox',
  ] },
  // ── Write intents ───────────────────────────────────────────────────────
  { id: 'project.confirm', keywords: [
    'confirm project', 'mark project confirmed', 'accept project',
    'confirm it', 'confirm that', 'confirm', 'lock project', 'won project',
    'project won', 'go ahead with project',
  ], requires: 'projectName', action: 'write' },
  { id: 'project.markOngoing', keywords: [
    'start project', 'mark project ongoing', 'project started', 'go live',
    'begin project', 'kick off project', 'kickoff', 'project kickoff',
    'project shuru', 'launch project',
  ], requires: 'projectName', action: 'write' },
  { id: 'project.markCompleted', keywords: [
    'complete project', 'mark project completed', 'finish project',
    'wrap project', 'mark complete', 'mark completed', 'complete it',
    'complete that', 'finish it', 'finish that', 'complete', 'finish',
    'project done', 'wrap up', 'wrap it', 'project khatam', 'project end',
  ], requires: 'projectName', action: 'write' },
  { id: 'project.markClosed', keywords: [
    'close project', 'mark project closed', 'close it', 'close that', 'close',
    'archive project', 'invoice closed', 'fully closed', 'lock project final',
  ], requires: 'projectName', action: 'write' },
  { id: 'expense.disapprove', keywords: [
    'reject expense of', 'reject expenses of', 'disapprove expense of',
    'disapprove expenses of', 'decline expense of', 'reject expense',
    'reject expenses', 'disapprove expense', 'disapprove expenses',
    'decline expense', 'deny expense', 'return expense', 'send back expense',
  ], requires: 'employeeName', action: 'write' },
  { id: 'payment.record', keywords: [
    'record payment', 'log payment', 'add payment', 'received from',
    'payment received from', 'got payment from', 'collected from',
    'paisa mila', 'amount received from', 'cleared invoice from',
    'mark paid', 'enter receipt', 'note receipt',
  ], requires: 'clientName', action: 'write' },
  { id: 'leave.approve', keywords: [
    'approve leave', 'sanction leave', 'pass leave', 'ok leave',
    'grant leave', 'allow leave', 'leave approve',
  ], requires: 'employeeName', action: 'write' },
  { id: 'leave.reject', keywords: [
    'reject leave', 'decline leave', 'deny leave', 'leave reject',
    'cancel leave request',
  ], requires: 'employeeName', action: 'write' },
  // ── Help ────────────────────────────────────────────────────────────────
  { id: 'help', keywords: [
    'help', 'what can you do', 'commands', 'how to', 'examples',
    'what can i ask', 'options', 'features', 'menu', '?', 'guide me',
  ] },
];

const STATUS_WORDS = ['quoted', 'confirmed', 'ongoing', 'completed', 'closed', 'cancelled'];
const CATEGORY_WORDS = ['travel', 'food', 'fuel', 'transport', 'accommodation', 'labour', 'lodging', 'misc', 'led', 'audio', 'video', 'lighting', 'staging'];

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findNameMatch(text, names) {
  // Return the longest name that appears in the normalised text (case-insensitive).
  const t = ` ${normalise(text)} `;
  let best = null;
  for (const name of names || []) {
    const n = normalise(name);
    if (!n || n.length < 2) continue;
    if (t.includes(` ${n} `) || t.includes(` ${n},`) || t.endsWith(` ${n}`) || t.startsWith(`${n} `)) {
      if (!best || n.length > best.length) best = name;
    } else if (t.includes(n)) {
      // Substring fallback (handles "SONY LIVE" when user typed "sony")
      if (!best || n.length > best.length) best = name;
    }
  }
  return best;
}

function detectStatus(text) {
  const t = normalise(text);
  for (const s of STATUS_WORDS) if (t.includes(s)) return s.charAt(0).toUpperCase() + s.slice(1);
  return null;
}

function detectCategory(text) {
  const t = normalise(text);
  for (const c of CATEGORY_WORDS) if (t.includes(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  return null;
}

function scoreIntent(text, intent) {
  const t = normalise(text);
  const padded = ` ${t} `;
  let score = 0;
  for (const kw of intent.keywords) {
    const k = normalise(kw);
    if (!k) continue;
    const tokens = k.split(' ').filter(Boolean);
    // For SHORT (≤4 char) single-token keywords (e.g. "ar", "cn", "show",
    // "open") require word-boundary matching so they don't false-positive
    // inside other words like "spectacular" → "ar".
    if (tokens.length === 1 && k.length <= 4) {
      if (padded.includes(` ${k} `)) score += 1;
      continue;
    }
    if (t.includes(k)) score += Math.max(1, tokens.length);
    else if (k.length >= 5 && tokensFuzzyMatch(t, k)) score += 1; // typo-tolerant
  }
  return score;
}

// ── Typo tolerance (Damerau-Levenshtein, capped at distance 1) ─────────────
function editDistance1(a, b) {
  // Return true iff strings differ by at most 1 char (insert / delete / sub /
  // adjacent transpose). Cheap for the short tokens we handle.
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Substitution
  if (la === lb) {
    let diffs = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffs++;
        // adjacent transpose check
        if (diffs === 1 && i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i]) return true;
        if (diffs > 1) return false;
      }
    }
    return diffs <= 1;
  }
  // Insertion / deletion
  const [s, l] = la < lb ? [a, b] : [b, a];
  for (let i = 0, j = 0, used = 0; i < s.length;) {
    if (s[i] === l[j]) { i++; j++; }
    else { if (++used > 1) return false; j++; }
  }
  return true;
}

/** True when every token of `phrase` is present (within edit-distance 1) in `text`. */
function tokensFuzzyMatch(text, phrase) {
  const tTok = text.split(' ').filter(Boolean);
  const pTok = phrase.split(' ').filter(Boolean);
  if (!pTok.length) return false;
  for (const p of pTok) {
    if (p.length < 4) {
      if (!tTok.includes(p)) return false; // too short for fuzzy → exact
    } else {
      const hit = tTok.some((t) => t === p || (Math.abs(t.length - p.length) <= 1 && editDistance1(t, p)));
      if (!hit) return false;
    }
  }
  return true;
}

// ── Anaphora ────────────────────────────────────────────────────────────────
const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/**
 * Resolve a row reference from memory (e.g. "#2", "the second one", "last").
 * Returns the matching row from memory.lastResultRows, or null.
 */
function resolveRowReference(rawText, memory) {
  if (!memory) return null;
  const rows = memory.lastResultRows || [];
  if (!rows.length) return null;
  const t = normalise(rawText);
  // "#3"
  const hash = String(rawText || '').match(/#\s*(\d+)/);
  if (hash) {
    const idx = parseInt(hash[1], 10) - 1;
    if (idx >= 0 && idx < rows.length) return rows[idx];
  }
  // "last", "latest", "previous", "most recent"
  if (/\b(last|latest|previous|most recent)\b/.test(t)) return rows[rows.length - 1];
  // "first one", "second project", "the third"
  const ord = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/);
  if (ord) {
    const n = ORDINAL_WORDS[ord[1]];
    if (n >= 1 && n <= rows.length) return rows[n - 1];
  }
  return null;
}

/** Detect bare pronouns referring to the previously discussed entity. */
function hasPronounReference(rawText) {
  const t = normalise(rawText);
  return /\b(it|that|this|same|the same|that one|this one)\b/.test(t);
}

/**
 * Apply a resolved row to entities, by row.type (project/client/employee/vendor).
 */
function applyRowToEntities(row, entities) {
  if (!row || !row.name || !row.type) return;
  const key = ({
    project: 'projectName',
    client: 'clientName',
    employee: 'employeeName',
    vendor: 'vendorName',
    item: 'itemName',
  })[row.type];
  if (key && !entities[key]) entities[key] = row.name;
}

/**
 * Apply memory.lastEntities to fill blanks (pronoun resolution).
 */
function applyLastEntities(memory, entities) {
  const le = (memory && memory.lastEntities) || {};
  for (const k of ['projectName', 'clientName', 'employeeName', 'vendorName', 'itemName']) {
    if (le[k] && !entities[k]) entities[k] = le[k];
  }
}

/**
 * Look up an intent from the learned phrase index. The index is built by the
 * learning module from the user's own past interactions. We try the exact
 * normalised prompt, then a "stripped" form (entity tokens removed), then a
 * Jaccard-style overlap on tokens.
 * @param {string} rawPrompt
 * @param {{ phraseIntent?: object } | null} learned
 */
function lookupLearnedIntent(rawPrompt, learned) {
  const idx = learned && learned.phraseIntent;
  if (!idx) return null;
  const norm = normalise(rawPrompt);
  if (idx[norm]) return idx[norm];
  // Token-overlap fallback: find the entry with highest Jaccard similarity ≥ 0.6.
  const tokens = new Set(norm.split(' ').filter((t) => t.length > 2));
  if (!tokens.size) return null;
  let best = null;
  let bestScore = 0;
  for (const [phrase, hit] of Object.entries(idx)) {
    const pTok = new Set(phrase.split(' ').filter((t) => t.length > 2));
    if (!pTok.size) continue;
    let inter = 0;
    for (const t of tokens) if (pTok.has(t)) inter++;
    const union = tokens.size + pTok.size - inter;
    const score = union ? inter / union : 0;
    if (score >= 0.6 && score > bestScore) { bestScore = score; best = hit; }
  }
  return best;
}

/**
 * Parse a user message into a structured intent.
 * @param {string} message
 * @param {{ clientNames?: string[], employeeNames?: string[], inventoryNames?: string[] }} ctx
 * @param {{ lastEntities?: object, lastResultRows?: Array<{id,name,type}>, lastIntent?: string } | null} memory
 * @param {{ phraseIntent?: object, intentFreq?: object } | null} learned
 * @returns {object}
 */
export function parseAssistantMessage(message, ctx = {}, memory = null, learned = null) {
  const rawPrompt = String(message || '').trim();
  const out = {
    intent: 'unknown',
    entities: {},
    confidence: 0,
    rawPrompt,
    issues: [],
  };
  if (!rawPrompt) {
    out.issues.push({ level: 'error', message: 'Empty message' });
    return out;
  }

  // Rank intents by keyword score.
  const ranked = INTENTS
    .map((it) => ({ intent: it, score: scoreIntent(rawPrompt, it) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // Extract entities regardless of chosen intent so downstream can disambiguate.
  const clientName = findNameMatch(rawPrompt, ctx.clientNames);
  const employeeName = findNameMatch(rawPrompt, ctx.employeeNames);
  const itemName = findNameMatch(rawPrompt, ctx.inventoryNames);
  const vendorName = findNameMatch(rawPrompt, ctx.vendorNames);
  const projectName = findNameMatch(rawPrompt, ctx.projectNames);
  const status = detectStatus(rawPrompt);
  const category = detectCategory(rawPrompt);
  const dateRange = parseDateRange(rawPrompt);
  if (clientName) out.entities.clientName = clientName;
  if (employeeName) out.entities.employeeName = employeeName;
  if (itemName) out.entities.itemName = itemName;
  if (vendorName) out.entities.vendorName = vendorName;
  if (projectName) out.entities.projectName = projectName;
  if (status) out.entities.status = status;
  if (category) out.entities.category = category;
  if (dateRange) out.entities.dateRange = dateRange;

  // ── Anaphora resolution ───────────────────────────────────────────────
  // Index/ordinal references (e.g. "#2", "the second one", "last") win over
  // pronouns. Both fall back to memory.lastEntities if neither yields a row.
  if (memory) {
    const row = resolveRowReference(rawPrompt, memory);
    if (row) {
      applyRowToEntities(row, out.entities);
      out.resolvedFromMemory = true;
    } else if (hasPronounReference(rawPrompt)) {
      applyLastEntities(memory, out.entities);
      out.resolvedFromMemory = true;
    }
  }

  if (ranked.length === 0) {
    // Learned-phrase fallback: if the user has said something similar before
    // and we recorded which intent they ran, reuse that mapping.
    const learnedHit = lookupLearnedIntent(rawPrompt, learned);
    if (learnedHit) {
      out.intent = learnedHit.intent;
      out.confidence = Math.min(0.7, 0.3 + 0.1 * learnedHit.count);
      out.fromLearned = true;
      return out;
    }

    // Date-range fallbacks: bare topic + a date phrase.
    if (dateRange) {
      const t = normalise(rawPrompt);
      if (/\bexpense/.test(t)) {
        out.intent = 'expenses.byDateRange'; out.confidence = 0.5; return out;
      }
      if (/\bproject/.test(t)) {
        out.intent = 'projects.byDateRange'; out.confidence = 0.5; return out;
      }
      if (/\bpayment|receipt|collection/.test(t)) {
        out.intent = 'payments.byDate'; out.confidence = 0.5; return out;
      }
      if (/\binvoice|sales/.test(t)) {
        out.intent = 'taxInvoices.list'; out.confidence = 0.5; return out;
      }
      if (/\bbill|purchase/.test(t)) {
        out.intent = 'purchaseInvoices.list'; out.confidence = 0.5; return out;
      }
    }
    // Entity-only hint: if the user typed just a client name, default to client ledger.
    if (out.entities.clientName) {
      out.intent = 'client.ledger';
      out.confidence = 0.4;
      out.issues.push({ level: 'info', message: 'Interpreted as client ledger.' });
      return out;
    }
    if (out.entities.employeeName) {
      out.intent = 'employee.balance';
      out.confidence = 0.4;
      out.issues.push({ level: 'info', message: 'Interpreted as employee balance.' });
      return out;
    }
    if (out.entities.projectName) {
      out.intent = 'projects.details';
      out.confidence = 0.4;
      out.issues.push({ level: 'info', message: 'Interpreted as project details.' });
      return out;
    }
    out.issues.push({ level: 'error', message: "Sorry, I didn't understand. Type 'help' for examples." });
    return out;
  }

  // Disambiguate projects.byStatus vs projects.today if both match: prefer higher score.
  // When the user has used a similar phrase before, give that intent a small bonus
  // so personal vocabulary wins over the global default ranking.
  const learnedHit = lookupLearnedIntent(rawPrompt, learned);
  if (learnedHit) {
    const idx = ranked.findIndex((r) => r.intent.id === learnedHit.intent);
    if (idx > 0) {
      ranked[idx].score += 1 + Math.min(3, learnedHit.count);
      ranked.sort((a, b) => b.score - a.score);
    }
  }
  const top = ranked[0];
  out.intent = top.intent.id;
  out.confidence = Math.min(1, top.score / 3);
  if (learnedHit && learnedHit.intent === out.intent) out.fromLearned = true;

  // Enforce required entities (read from out.entities so anaphora-filled
  // values count as resolved).
  const e = out.entities;
  if (top.intent.requires === 'clientName' && !e.clientName) {
    out.issues.push({ level: 'error', message: 'Please mention a client name.' });
    out.confidence *= 0.5;
  }
  if (top.intent.requires === 'employeeName' && !e.employeeName) {
    out.issues.push({ level: 'error', message: 'Please mention an employee name.' });
    out.confidence *= 0.5;
  }
  if (top.intent.requires === 'itemName' && !e.itemName) {
    out.issues.push({ level: 'error', message: 'Please mention an inventory item.' });
    out.confidence *= 0.5;
  }
  if (top.intent.requires === 'status' && !e.status) {
    out.issues.push({ level: 'error', message: 'Please mention a status (Quoted / Confirmed / Ongoing / Completed / Closed).' });
    out.confidence *= 0.5;
  }
  if (top.intent.requires === 'category' && !e.category) {
    out.issues.push({ level: 'error', message: 'Please mention a category (Travel / Food / Fuel / Transport / Accommodation / LED / Audio / Video).' });
    out.confidence *= 0.5;
  }
  if (top.intent.requires === 'vendorName' && !e.vendorName) {
    out.issues.push({ level: 'error', message: 'Please mention a vendor name.' });
    out.confidence *= 0.5;
  }
  if (top.intent.requires === 'projectName' && !e.projectName) {
    out.issues.push({ level: 'error', message: 'Please mention a project name.' });
    out.confidence *= 0.5;
  }

  // Flag write-actions for the executor.
  if (top.intent.action === 'write') out.isWriteAction = true;

  return out;
}

export default parseAssistantMessage;
