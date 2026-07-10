// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy party resolution: match free-text party references in user messages
// to the known list of clients/vendors/employees.
// Pure functions — no React / Firestore / I/O.
// ─────────────────────────────────────────────────────────────────────────────

const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'from', 'with', 'by', 'on', 'in', 'into',
  'towards', 'against', 'is', 'was', 'has', 'have', 'been', 'and', 'or',
]);

// Honorifics / business prefixes & suffixes to strip before matching, so
// "Mr. Sharma", "M/s Acme", "Sharma ji", "Acme Pvt Ltd" all match cleanly.
const HONORIFIC_PREFIX_RE = /^(?:m\/s\.?|messrs\.?|mr\.?|mrs\.?|ms\.?|miss|shri|smt\.?|sri|dr\.?|prof\.?|sh\.?)\s+/i;
const HONORIFIC_SUFFIX_RE = /\s+(?:ji|sahab|saab|sir|madam|garu)\b/i;
const COMPANY_SUFFIX_RE = /\b(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|co\.?|corp\.?|corporation|company|enterprises?|industries|traders?|associates?|&\s*co\.?)\b/gi;

/** Remove honorifics, salutations and common company suffixes. */
export function stripHonorifics(name) {
  let s = String(name || '').trim();
  s = s.replace(HONORIFIC_PREFIX_RE, '');
  s = s.replace(HONORIFIC_SUFFIX_RE, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Dice coefficient on character bigrams → 0..1 similarity. */
export function diceSimilarity(a, b) {
  const x = String(a || '').toLowerCase().replace(/\s+/g, '');
  const y = String(b || '').toLowerCase().replace(/\s+/g, '');
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = (str) => {
    const m = new Map();
    for (let i = 0; i < str.length - 1; i += 1) {
      const bg = str.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const [bg, cx] of bx) {
    const cy = by.get(bg) || 0;
    inter += Math.min(cx, cy);
  }
  return (2 * inter) / ((x.length - 1) + (y.length - 1));
}

const ACTION_WORDS = [
  'received', 'receive', 'got', 'collected', 'recd', 'paid', 'pay', 'sent',
  'gave', 'transferred', 'transfer', 'invoice', 'invoiced', 'billed', 'bill',
  'salary', 'wages', 'expense', 'spent', 'advance', 'purchased', 'bought',
  'deposit', 'deposited', 'withdraw', 'withdrew', 'tds', 'rent',
  'cn', 'dn', 'credit\\s*note', 'debit\\s*note',
  'rs\\.?', 'rupees?', 'inr', 'amount', 'via', 'bank', 'neft', 'rtgs',
  'upi', 'imps', 'cash', 'cheque', 'check', 'online',
];

const ACTION_RE = new RegExp(`\\b(${ACTION_WORDS.join('|')})\\b`, 'gi');
const NUMERIC_RE = /\b\d[\d,]*(?:\.\d+)?[kKlLcC]?\b/g;
const PUNCT_RE = /[.!?,;:()[\]{}]+/g;

// Per-token (anchored, no /g state) variants for segmentation.
const NOISE_TOKEN_RE = new RegExp(`^(?:${ACTION_WORDS.join('|')})$`, 'i');
const NUMERIC_TOKEN_RE = /^[₹$]?\d[\d,]*(?:\.\d+)?[kKlLcC]?$/;

// Words that commonly sit right next to a party name in bookkeeping chat but
// are never part of the name itself ("got 5000 from mehta today", "received
// mehta payment", "sharma ji ko 5000 bheja"). Used ONLY for segmentation —
// they end a name phrase instead of polluting it.
const SEGMENT_NOISE_WORDS = new Set([
  // date / time
  'today', 'tomorrow', 'yesterday', 'tonight', 'morning', 'afternoon', 'evening', 'night',
  'week', 'month', 'year', 'day', 'date', 'dated', 'last', 'next', 'this', 'ago',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // transaction nouns
  'payment', 'payments', 'part', 'partial', 'full', 'final', 'remaining', 'balance',
  'due', 'pending', 'outstanding', 'settlement', 'installment', 'instalment', 'emi',
  // Hinglish particles / verbs
  'ko', 'ka', 'ki', 'ke', 'se', 'ne', 'ho', 'hai', 'hain', 'tha', 'thi',
  'kiya', 'diya', 'liya', 'bheja', 'bhejo', 'mila', 'gaya', 'karo', 'kar',
  'rupaye', 'rupay', 'paise',
  // UPI / payment apps
  'gpay', 'phonepe', 'paytm', 'googlepay', 'bhim',
  // place-ish qualifiers
  'site', 'office', 'work', 'job', 'shop', 'godown', 'warehouse',
]);

/** Canonical key for alias lookups: lowercase, alphanumeric words only. */
export function normalizeAliasKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split free text into contiguous runs of "name-ish" tokens — everything that
 * is not an amount, action word, or filler. "received 5000 from sanjeev chopra
 * for diwali event" → [{text:'sanjeev chopra',…}, {text:'diwali event',…}].
 * The run containing a party match is the name phrase the user actually typed,
 * which lets callers check whether that phrase is FULLY explained by the party.
 * @param {string} text
 * @returns {{text: string, tokens: string[]}[]}
 */
export function nameSegments(text) {
  const rawTokens = String(text || '')
    .replace(PUNCT_RE, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const segments = [];
  let current = [];
  let pendingSoft = [];
  const flush = () => {
    if (current.length) {
      segments.push({ text: current.join(' '), tokens: current.map((t) => t.toLowerCase()) });
    }
    current = [];
    pendingSoft = [];
  };
  for (const tok of rawTokens) {
    const low = tok.toLowerCase();
    // Hard separators can never be part of a name.
    const isHard = NUMERIC_TOKEN_RE.test(tok)
      || NOISE_TOKEN_RE.test(tok)
      || FILLER_WORDS.has(low)
      || tok.startsWith('#')          // project tags (#P-12)
      || /\d/.test(tok);              // anything with digits is not a name token
    if (isHard) { flush(); continue; }
    // Soft noise ("payment", "today", "site") usually trails a name — but it
    // may also sit INSIDE one ("Kumar Site Services"). Keep it pending: it
    // joins the segment only when another name token follows, so it can never
    // hide the rest of a typed name, yet trailing noise stays out.
    if (SEGMENT_NOISE_WORDS.has(low)) {
      if (current.length) pendingSoft.push(tok);
      continue;
    }
    if (pendingSoft.length) { current.push(...pendingSoft); pendingSoft = []; }
    current.push(tok);
  }
  flush();
  return segments;
}

/**
 * Does any token of the party name explain this input token?
 * Short tokens (< 3 chars, e.g. "AV") must match exactly so they can't
 * piggyback on unrelated words ("av" ↔ "advance").
 */
function tokenExplained(inputTok, nameTokens) {
  const it = String(inputTok || '').toLowerCase();
  if (!it) return true;
  for (const nt of nameTokens) {
    if (nt === it) return true;
    const minLen = Math.min(nt.length, it.length);
    if (minLen >= 3 && (nt.startsWith(it) || it.startsWith(nt))) return true;
    if (minLen >= 4 && diceSimilarity(it, nt) >= 0.7) return true;
  }
  return false;
}

/**
 * Fraction (0..1) of a typed name phrase explained by `partyName`.
 * "sanjeev chopra" vs "Chopra AV" → 0.5 (sanjeev unexplained) — a weak match
 * that should trigger clarification instead of a silent resolve.
 * @param {string[]} segmentTokens
 * @param {string} partyName
 */
export function segmentCoverage(segmentTokens, partyName) {
  const joined = (segmentTokens || []).join(' ');
  // Only purely-alphabetic tokens count against coverage — tags, numbers,
  // symbol-bearing fragments, and generic noise words ("site", "payment")
  // are never evidence of a different party name.
  const toks = stripHonorifics(joined).toLowerCase().split(/\s+/)
    .filter((t) => t && t.length >= 2 && /^[a-z]+$/.test(t) && !SEGMENT_NOISE_WORDS.has(t));
  if (!toks.length) return 1;
  const nameTokens = stripHonorifics(partyName).toLowerCase().split(/\s+/).filter(Boolean);
  if (!nameTokens.length) return 1;
  const explained = toks.filter((t) => tokenExplained(t, nameTokens)).length;
  return explained / toks.length;
}

/**
 * @param {string} raw
 * @param {{partyNames?: string[]}} [ctx]
 * @returns {string}
 */
export function resolveParty(raw, ctx) {
  if (!raw) return '';
  const cleaned = stripHonorifics(raw.trim().replace(/[.!?,;:]+$/, ''));
  if (!ctx?.partyNames?.length) return cleaned;

  const lower = cleaned.toLowerCase();
  const norm = (s) => stripHonorifics(s).toLowerCase();

  // 1. Exact match (honorific-insensitive)
  const exact = ctx.partyNames.find(p => norm(p) === lower);
  if (exact) return exact;

  // 2. Starts-with
  const startsWith = ctx.partyNames.find(p => norm(p).startsWith(lower) && lower.length >= 3);
  if (startsWith) return startsWith;

  // 3. Substring (either direction). Require 3+ chars on the contained side so
  //    tiny fragments ("av") can't latch onto longer names and vice versa.
  const contains = lower.length >= 3 && ctx.partyNames.find(p => {
    const np = norm(p);
    return (np.length >= 3) && (np.includes(lower) || lower.includes(np));
  });
  if (contains) return contains;

  // 4. Token overlap + bigram (Dice) similarity. Combine both so short
  //    references ("acme") and noisy ones ("acmee corp") still resolve.
  const inputTokens = lower.split(/\s+/).filter(Boolean);
  let bestMatch = null;
  let bestScore = 0;
  for (const name of ctx.partyNames) {
    const nlower = norm(name);
    const nameTokens = nlower.split(/\s+/);
    let score = 0;
    for (const it of inputTokens) {
      if (it.length < 2) continue;
      for (const nt of nameTokens) {
        const minLen = Math.min(nt.length, it.length);
        if (nt === it) score += 3;
        else if (minLen >= 3 && (nt.startsWith(it) || it.startsWith(nt))) score += 2;
        else if (minLen >= 3 && (nt.includes(it) || it.includes(nt))) score += 1;
      }
    }
    // Fuzzy boost: a high bigram similarity adds up to +3 (handles typos).
    const dice = diceSimilarity(lower, nlower);
    if (dice >= 0.6) score += 3;
    else if (dice >= 0.45) score += 2;
    if (score > bestScore) { bestScore = score; bestMatch = name; }
  }
  if (bestScore >= 2 && bestMatch) {
    // Coverage gate: only resolve when the party explains EVERYTHING the user
    // typed (or the whole string is a near-identical typo). A surname-only hit
    // ("sanjeev chopra" → "Chopra AV") must fall through and keep the typed
    // name so callers can treat it as a potential new party.
    const nameTokens = norm(bestMatch).split(/\s+/).filter(Boolean);
    const covered = inputTokens
      .filter((t) => t.length >= 2 && !FILLER_WORDS.has(t))
      .every((t) => tokenExplained(t, nameTokens));
    if (covered || diceSimilarity(lower, norm(bestMatch)) >= 0.7) return bestMatch;
  }
  return cleaned;
}

/**
 * Extract a party name from free text.
 * @param {string} text
 * @param {{partyNames?: string[]}} [ctx]
 * @returns {string}
 */
export function extractParty(text, ctx) {
  if (!text) return '';

  // Fast path: direct match against known names (longest first). Word-boundary
  // aware so "Ram" can't match inside "programme" or "AV" inside "advance".
  if (ctx?.partyNames?.length) {
    const lower = text.toLowerCase();
    const sorted = [...ctx.partyNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(lower)) return name;
    }
    // Token-overlap heuristic against known names. A partial hit only resolves
    // when the name phrase the user typed is FULLY explained by the party —
    // otherwise "sanjeev chopra" would silently become "Chopra AV".
    const words = lower.split(/\s+/);
    const segments = nameSegments(text);
    for (const name of sorted) {
      const nameTokens = name.toLowerCase().split(/\s+/);
      const matchCount = nameTokens.filter(nt =>
        words.some(w => w === nt || (w.length >= 3 && nt.length >= 3 && (w.startsWith(nt) || nt.startsWith(w))))
      ).length;
      if (matchCount > 0 && matchCount >= nameTokens.length * 0.5) {
        const matchedSegments = segments.filter((s) =>
          s.tokens.some((t) => tokenExplained(t, nameTokens))
        );
        const fullyCovered = matchedSegments.some((s) => segmentCoverage(s.tokens, name) >= 1);
        if (!matchedSegments.length || fullyCovered) return name;
      }
    }
  }

  // Directional preposition extraction.
  const dirMatch = text.match(/(?:from|to|for|by|of|with|client|vendor|party|company)\s+(.+)/i);
  if (dirMatch) {
    const candidate = stripNoise(dirMatch[1]);
    if (candidate.length >= 2) return resolveParty(candidate, ctx);
  }

  // Fallback: strip everything noisy and return the residue.
  const stripped = stripNoise(text);
  if (stripped.length >= 2) return resolveParty(stripped, ctx);

  return '';
}

/**
 * Match a user's clarify answer against the offered options. Options may
 * include a "New party: X" entry — comparison uses the bare name. Returns the
 * ORIGINAL option string, or '' when the answer is ambiguous (near-tie) so the
 * caller re-asks instead of guessing: a guessed party silently books money to
 * the wrong ledger and can poison alias learning.
 * @param {string} answer
 * @param {string[]} options
 * @param {string} [newPartyPrefix]
 */
export function pickPartyOption(answer, options = [], newPartyPrefix = 'New party: ') {
  if (!answer || !Array.isArray(options) || !options.length) return '';
  const ansNorm = normalizeAliasKey(answer);
  if (!ansNorm) return '';

  const comparable = options.map((opt) => {
    const s = String(opt);
    const name = s.startsWith(newPartyPrefix) ? s.slice(newPartyPrefix.length) : s;
    return { opt: s, norm: normalizeAliasKey(name), optNorm: normalizeAliasKey(s) };
  });

  // 1. Exact — against the option verbatim (button click) or its bare name.
  const exact = comparable.find((c) => c.norm === ansNorm || c.optNorm === ansNorm);
  if (exact) return exact.opt;

  // 2. Unique containment (3+ chars either direction).
  const contains = comparable.filter((c) =>
    ansNorm.length >= 3 && c.norm.length >= 3
    && (c.norm.includes(ansNorm) || ansNorm.includes(c.norm)));
  if (contains.length === 1) return contains[0].opt;

  // 3. Scored: token overlap + bigram similarity; demand a clear winner.
  const ansTokens = ansNorm.split(' ').filter(Boolean);
  let best = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const c of comparable) {
    const optTokens = c.norm.split(' ').filter(Boolean);
    let score = 0;
    for (const t of ansTokens) {
      if (optTokens.includes(t)) score += 2;
    }
    score += diceSimilarity(ansNorm, c.norm) * 4;
    if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = c; }
    else if (score > runnerUp) runnerUp = score;
  }
  if (!best || bestScore < 1 || bestScore - runnerUp < 1) return '';
  return best.opt;
}

/** Remove numbers, action words, punctuation, fillers. */
function stripNoise(text) {
  return text
    .replace(ACTION_RE, '')
    .replace(NUMERIC_RE, '')
    .replace(PUNCT_RE, '')
    .split(/\s+/)
    .filter(w => w && !FILLER_WORDS.has(w.toLowerCase()))
    .join(' ')
    .trim();
}
