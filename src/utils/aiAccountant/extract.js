// ─────────────────────────────────────────────────────────────────────────────
// Structured extractors used across Phase 3 intents.
//   - GST rate detection ("18%", "5% gst", "0 percent")
//   - Split-line parsing ("30k rent + 20k maintenance")
//   - Voucher number extraction ("JV-0042", "2026-27/0042", "voucher 42")
//   - Project tag extraction ("#P-123", "project ABC")
// Pure: no Firestore / DOM access.
// ─────────────────────────────────────────────────────────────────────────────

import { extractAmount } from './amount.js';
import { round2 } from './schema.js';

// ── GST rate ────────────────────────────────────────────────────────────────
export const GST_RATES = [0, 5, 12, 18, 28];

/**
 * Detect GST rate mentioned in text. Defaults to 18 when none found.
 * Returns 0 for explicit "nil / exempt / zero rated / no gst".
 * @param {string} text
 * @param {number} [fallback=18]
 * @returns {number}
 */
export function extractGSTRate(text, fallback = 18) {
  if (!text) return fallback;
  const lower = text.toLowerCase();
  if (/\b(nil\s*gst|exempt|zero\s*rated|zero-rated|no\s*gst|gst\s*free|without\s*gst)\b/.test(lower)) return 0;
  const m = lower.match(/\b(0|5|12|18|28)\s*(?:%|percent|pct)\s*(?:gst|tax)?\b/);
  if (m) return Number(m[1]);
  const m2 = lower.match(/\bgst\s*(?:@|at|of)?\s*(0|5|12|18|28)\s*(?:%|percent|pct)?\b/);
  if (m2) return Number(m2[1]);
  return fallback;
}

/**
 * Split a gross amount into taxable + tax components at the given rate.
 * Rate 0 → full amount is taxable, zero gst.
 * @param {number} gross
 * @param {number} ratePct
 * @returns {{ taxable: number, gst: number, rate: number }}
 */
export function splitGSTByRate(gross, ratePct) {
  const rate = Number(ratePct) || 0;
  if (rate <= 0) return { taxable: round2(gross), gst: 0, rate: 0 };
  const taxable = round2((gross * 100) / (100 + rate));
  const gst = round2(gross - taxable);
  return { taxable, gst, rate };
}

// ── Split-line expenses ─────────────────────────────────────────────────────
/**
 * Detect split-expense phrases like:
 *   "50k = 30k rent + 20k maintenance"
 *   "spent 5000 on travel and 2000 on food"
 * Returns an array of `{ amount, description }` items if >=2 parts found.
 * @param {string} text
 * @returns {Array<{amount:number, description:string}>}
 */
export function extractSplitLines(text) {
  if (!text) return [];
  const parts = [];
  // Tokenise around '+' / ',' / ' and '
  const segments = text.split(/\s*(?:\+|,|\band\b)\s*/i);
  if (segments.length < 2) return [];
  for (const seg of segments) {
    const amt = extractAmount(seg);
    if (amt <= 0) continue;
    // Strip the amount phrase to get the description
    const desc = seg
      .replace(/(\d[\d,]*(?:\.\d+)?\s*(?:lakh|lac|l|crore|cr|k)?)/i, '')
      .replace(/\b(rs\.?|rupees?|inr|amount|for|on|towards|paid|spent|of)\b/gi, '')
      .replace(/[=:\-–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (desc.length >= 2) parts.push({ amount: amt, description: desc });
  }
  return parts.length >= 2 ? parts : [];
}

// ── Voucher reference ───────────────────────────────────────────────────────
/**
 * Detect a voucher reference like:
 *   JV-0042, JV0042, voucher 2026-27/0042, JV# 42, #42
 * Returns the matched token (trimmed) or null.
 * @param {string} text
 */
export function extractVoucherNo(text) {
  if (!text) return null;
  // Primary: FY-style 2026-27/0042 or 2026-27-0042
  let m = text.match(/\b(\d{4}-\d{2}[/-]\d{1,6})\b/);
  if (m) return m[1].replace('-', '/').replace(/(\d{4})\/(\d{2})\/(\d+)/, '$1-$2/$3');
  // JV-0042 / JV0042 / jv 42
  m = text.match(/\bjv[\s#-]*(\d{1,6})\b/i);
  if (m) return `JV-${m[1].padStart(4, '0')}`;
  // Generic "voucher 42" — require at least one digit so words like
  // "voucher please" do NOT match.
  m = text.match(/\bvoucher\s*(?:no\.?|#)?\s*([A-Za-z0-9/-]*\d[A-Za-z0-9/-]*)\b/i);
  if (m) return m[1];
  return null;
}

// ── Project tag ─────────────────────────────────────────────────────────────
/**
 * Detect project tag.
 * Supports: "#P-123", "#123", "project-123", "project ABC Launch".
 * Returns a string (tag or project name) or null.
 * @param {string} text
 */
export function extractProjectTag(text) {
  if (!text) return null;
  let m = text.match(/#\s*(P-?\d+)\b/i);
  if (m) return m[1].toUpperCase();
  m = text.match(/#\s*(\d+)\b/);
  if (m) return `P-${m[1]}`;
  m = text.match(/\bproject[\s:-]+([A-Za-z0-9][\w .-]{1,40})/i);
  if (m) return m[1].trim().replace(/\s+$/g, '');
  return null;
}
