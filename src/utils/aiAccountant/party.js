// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy party resolution: match free-text party references in user messages
// to the known list of clients/vendors/employees.
// Pure functions — no React / Firestore / I/O.
// ─────────────────────────────────────────────────────────────────────────────

const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'from', 'with', 'by', 'on', 'in', 'into',
  'towards', 'against', 'is', 'was', 'has', 'have', 'been', 'and', 'or',
]);

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
  const cleaned = raw.trim().replace(/[.!?,;:]+$/, '');
  if (!ctx?.partyNames?.length) return cleaned;

  const lower = cleaned.toLowerCase();

  // 1. Exact match
  const exact = ctx.partyNames.find(p => p.toLowerCase() === lower);
  if (exact) return exact;

  // 2. Starts-with
  const startsWith = ctx.partyNames.find(p => p.toLowerCase().startsWith(lower));
  if (startsWith) return startsWith;

  // 3. Substring (either direction)
  const contains = ctx.partyNames.find(p =>
    p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase())
  );
  if (contains) return contains;

  // 4. Token overlap score
  const inputTokens = lower.split(/\s+/).filter(Boolean);
  let bestMatch = null;
  let bestScore = 0;
  for (const name of ctx.partyNames) {
    const nameTokens = name.toLowerCase().split(/\s+/);
    let score = 0;
    for (const it of inputTokens) {
      if (it.length < 2) continue;
      for (const nt of nameTokens) {
        if (nt === it) score += 3;
        else if (nt.startsWith(it) || it.startsWith(nt)) score += 2;
        else if (nt.includes(it) || it.includes(nt)) score += 1;
      }
    }
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
