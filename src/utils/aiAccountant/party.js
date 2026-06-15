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

  // 3. Substring (either direction)
  const contains = ctx.partyNames.find(p =>
    norm(p).includes(lower) || lower.includes(norm(p))
  );
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
        if (nt === it) score += 3;
        else if (nt.startsWith(it) || it.startsWith(nt)) score += 2;
        else if (nt.includes(it) || it.includes(nt)) score += 1;
      }
    }
    // Fuzzy boost: a high bigram similarity adds up to +3 (handles typos).
    const dice = diceSimilarity(lower, nlower);
    if (dice >= 0.6) score += 3;
    else if (dice >= 0.45) score += 2;
    if (score > bestScore) { bestScore = score; bestMatch = name; }
  }
  return bestScore >= 2 ? bestMatch : cleaned;
}

/**
 * Extract a party name from free text.
 * @param {string} text
 * @param {{partyNames?: string[]}} [ctx]
 * @returns {string}
 */
export function extractParty(text, ctx) {
  if (!text) return '';

  // Fast path: direct substring match against known names (longest first).
  if (ctx?.partyNames?.length) {
    const lower = text.toLowerCase();
    const sorted = [...ctx.partyNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      if (lower.includes(name.toLowerCase())) return name;
    }
    // Token-overlap heuristic against known names
    const words = lower.split(/\s+/);
    for (const name of sorted) {
      const nameTokens = name.toLowerCase().split(/\s+/);
      const matchCount = nameTokens.filter(nt =>
        words.some(w => w === nt || (w.length >= 3 && (w.startsWith(nt) || nt.startsWith(w))))
      ).length;
      if (matchCount > 0 && matchCount >= nameTokens.length * 0.5) return name;
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
