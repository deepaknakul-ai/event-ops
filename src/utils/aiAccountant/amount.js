// ─────────────────────────────────────────────────────────────────────────────
// Amount extraction for natural-language money expressions.
// Understands Indian number system (1,50,000), shorthand (50k / 1.5L / 2cr),
// and decimals. Returns 0 when nothing parseable is found.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {number}
 */
export function extractAmount(text) {
  if (!text) return 0;
  const cleaned = text
    .replace(/\b(rs\.?|rupees?|inr|amount)\b/gi, '')
    .replace(/[₹$]/g, '');

  // Order matters: suffixes (lakh/crore/k) first, then decimals, then plain.
  const patterns = [
    /(\d[\d,]*(?:\.\d+)?)\s*(?:lakh|lac|l)\b/i,   // 1.5 lakh, 2L
    /(\d[\d,]*(?:\.\d+)?)\s*(?:crore|cr)\b/i,     // 1 crore, 2cr
    /(\d[\d,]*(?:\.\d+)?)\s*k\b/i,                // 50k
    /(\d[\d,]*\.\d+)/,                             // 1,50,000.50
    /(\d[\d,]+)/,                                   // 150000 / 1,50,000
    /(\d+)/,                                        // bare integer
  ];

  for (const pat of patterns) {
    const m = cleaned.match(pat);
    if (!m) continue;
    let num = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(num)) continue;
    const suffix = m[0].toLowerCase();
    if (/\b(lakh|lac|l)\b/i.test(suffix) || /\dl\b/i.test(suffix)) num *= 100000;
    else if (/\b(crore|cr)\b/i.test(suffix) || /\dcr\b/i.test(suffix)) num *= 10000000;
    else if (/\dk\b/i.test(suffix)) num *= 1000;
    if (num > 0) return Math.round(num * 100) / 100;
  }
  return 0;
}

/**
 * Detect payment mode (cash vs bank) from context words.
 * @param {string} text
 * @returns {'Cash'|'Bank'}
 */
export function detectPaymentMode(text) {
  const lower = (text || '').toLowerCase();
  if (/\b(bank|neft|rtgs|imps|online|net\s*banking|upi|gpay|phonepe|paytm|cheque|check|chq)\b/.test(lower)) return 'Bank';
  if (/\b(cash|by\s*hand|hand\s*cash)\b/.test(lower)) return 'Cash';
  return 'Cash';
}

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetic expressions: "10k + 2k", "5000 + 900 GST", "20000 - 500 discount".
// Returns the summed value, ignoring trailing descriptors.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse amount expressions with + / - operators.
 * Returns 0 if no operators found or inputs unparseable.
 * @param {string} text
 * @returns {number}
 */
export function extractAmountExpression(text) {
  if (!text) return 0;
  // Find a contiguous arithmetic run: number [+/- number]+
  const exprRe = /(\d[\d,]*(?:\.\d+)?\s*(?:lakh|lac|l|crore|cr|k)?)\s*([+-])\s*(\d[\d,]*(?:\.\d+)?\s*(?:lakh|lac|l|crore|cr|k)?)(?:\s*([+-])\s*(\d[\d,]*(?:\.\d+)?\s*(?:lakh|lac|l|crore|cr|k)?))*/i;
  const m = text.match(exprRe);
  if (!m) return 0;
  const full = m[0];
  // Tokenise into [num, op, num, op, num...]
  const parts = full.split(/\s*([+-])\s*/).filter(Boolean);
  if (parts.length < 3) return 0;
  let total = extractAmount(parts[0]);
  if (total === 0) return 0;
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i];
    const n = extractAmount(parts[i + 1] || '0');
    if (op === '+') total += n;
    else if (op === '-') total -= n;
  }
  return total > 0 ? Math.round(total * 100) / 100 : 0;
}

/**
 * Smart total: prefer arithmetic sum if operators are present; else extractAmount.
 * @param {string} text
 * @returns {number}
 */
export function extractAmountSmart(text) {
  const expr = extractAmountExpression(text);
  if (expr > 0) return expr;
  return extractAmount(text);
}
