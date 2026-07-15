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

// ── TDS compound breakdown ────────────────────────────────────────────────────
/**
 * Detect a net-of-TDS event in one sentence, e.g.
 *   "salary 50k, TDS 5k deducted, paid 45k bank"
 *   "paid vendor 1,00,000 less 2% TDS 2000"
 * Returns { gross, tds, net } or null. Section codes like 194C are ignored so
 * they are not mistaken for amounts.
 * @param {string} text
 * @returns {{gross:number, tds:number, net:number}|null}
 */
export function extractTDSBreakdown(text) {
  if (!text || !/\btds\b/i.test(text)) return null;
  // Strip section references (194C, 194, 192, 195, 206AA…) before scanning numbers.
  const clean = text.replace(/\b(?:u\/s\s*)?(?:section\s*)?19[0-9][a-z]{0,3}\b/gi, ' ');

  // Amount adjacent to the word "tds".
  let tds = 0;
  let m = clean.match(/tds[^0-9]{0,14}?(\d[\d.,]*\s*(?:lakh|lac|l|crore|cr|k)?)/i)
       || clean.match(/(\d[\d.,]*\s*(?:lakh|lac|l|crore|cr|k)?)\s*(?:as\s+)?tds/i);
  if (m) tds = extractAmount(m[1]);
  if (tds <= 0) return null;

  // All monetary amounts in the sentence.
  const nums = [];
  const re = /\d[\d.,]*\s*(?:lakh|lac|l|crore|cr|k)?/gi;
  let mm;
  while ((mm = re.exec(clean))) {
    const v = extractAmount(mm[0]);
    if (v > 0) nums.push(v);
  }
  if (nums.length < 2) return null;

  const gross = Math.max(...nums);
  if (gross <= tds) return null;
  return { gross: round2(gross), tds: round2(tds), net: round2(gross - tds) };
}

/**
 * Client-deducted TDS on OUR receipt: a client pays us NET of TDS. Unlike
 * extractTDSBreakdown (which assumes the largest number is gross), here the
 * received figure is the NET, so gross = net + tds. Requires an inflow cue so a
 * vendor outflow never routes here.
 * @param {string} text
 * @returns {{net:number, tds:number, gross:number}|null}
 */
export function extractClientTDSReceipt(text) {
  if (!text || !/\btds\b/i.test(text)) return null;
  if (!/\b(received|recd|got|credited|paid\s+(?:us|me|to\s+us|our)|net\s+of\s+tds|after\s+deduct)/i.test(text)) return null;
  const clean = text.replace(/\b(?:u\/s\s*)?(?:section\s*)?19[0-9][a-z]{0,3}\b/gi, ' ');

  let tds = 0;
  const m = clean.match(/tds[^0-9]{0,14}?(\d[\d.,]*\s*(?:lakh|lac|l|crore|cr|k)?)/i)
        || clean.match(/(\d[\d.,]*\s*(?:lakh|lac|l|crore|cr|k)?)\s*(?:as\s+)?tds/i);
  if (m) tds = round2(extractAmount(m[1]));
  if (tds <= 0) return null;

  const nums = [];
  const re = /\d[\d.,]*\s*(?:lakh|lac|l|crore|cr|k)?/gi;
  let mm;
  while ((mm = re.exec(clean))) {
    const v = extractAmount(mm[0]);
    if (v > 0) nums.push(round2(v));
  }
  // Drop one occurrence of the TDS figure; what's left is the net (and maybe a stated gross).
  const idx = nums.indexOf(tds);
  const rest = idx >= 0 ? nums.slice(0, idx).concat(nums.slice(idx + 1)) : nums.slice();
  if (!rest.length) return null;

  const maxRest = Math.max(...rest);
  const minRest = Math.min(...rest);
  let net, gross;
  if (rest.length >= 2 && Math.abs(maxRest - (minRest + tds)) <= 1) {
    net = minRest; gross = maxRest;          // both the net and a stated gross were given
  } else {
    net = maxRest; gross = round2(net + tds); // only the net was given
  }
  if (net <= 0 || gross <= tds) return null;
  return { net: round2(net), tds: round2(tds), gross: round2(gross) };
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
 * Supports: "#P-123", "#123", "project-123", "project ABC Launch", and — when a
 * `projectNames` list is supplied — a fuzzy reference to a real project name
 * anywhere in the text ("diesel for the Andheri job" → "Andheri Live").
 * Returns a string (tag or matched project name) or null.
 * @param {string} text
 * @param {string[]} [projectNames]  // live project names for fuzzy matching
 */
export function extractProjectTag(text, projectNames) {
  if (!text) return null;
  let m = text.match(/#\s*(P-?\d+)\b/i);
  if (m) return m[1].toUpperCase();
  m = text.match(/#\s*(\d+)\b/);
  if (m) return `P-${m[1]}`;
  m = text.match(/\bproject[\s:-]+([A-Za-z0-9][\w .-]{1,40})/i);
  if (m) return m[1].trim().replace(/\s+$/g, '');

  // Fuzzy: match a known project name (or a distinctive word from it) in the text.
  if (Array.isArray(projectNames) && projectNames.length) {
    const lower = text.toLowerCase();
    // Longest names first so "Andheri Live Show" beats "Andheri".
    const sorted = [...projectNames].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      const nl = name.toLowerCase();
      if (nl.length >= 3 && lower.includes(nl)) return name;
    }
    // Distinctive-word match: a project word (≥4 chars, not generic) present in text.
    const GENERIC = new Set(['project', 'event', 'show', 'live', 'job', 'work', 'the', 'and', 'for']);
    for (const name of sorted) {
      const words = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 4 && !GENERIC.has(w));
      if (words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower))) {
        return name;
      }
    }
  }
  return null;
}
