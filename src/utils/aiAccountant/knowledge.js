// ─────────────────────────────────────────────────────────────────────────────
// Accounting knowledge base for the AI Accountant (rules-only).
// Centralises the professional-accountant judgment that used to be scattered in
// nlu.js: GST intra/inter-state routing, direct-vs-indirect expense classification,
// and TDS-section inference. Pure functions — no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { round2 } from './schema.js';

// ── GST supply-type routing ──────────────────────────────────────────────────
/** First two digits of a GSTIN are the state code. */
export function stateCodeFromGSTIN(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  return /^[0-9]{2}/.test(g) ? g.slice(0, 2) : '';
}

/**
 * Decide the place-of-supply nature of a transaction.
 *   - 'intra'   → CGST + SGST   (org state === party state)
 *   - 'inter'   → IGST          (org state !== party state)
 *   - 'unknown' → single control account (insufficient info)
 * When the party is unregistered (no GSTIN) but the org state is known, GST is
 * still charged; default to intra-state (CGST+SGST), matching the project-level
 * B2C convention used in helpers.getProjectGSTBreakdown.
 * @param {string} orgGstin
 * @param {string} partyGstin
 */
export function determineSupplyType(orgGstin, partyGstin) {
  const org = stateCodeFromGSTIN(orgGstin);
  const party = stateCodeFromGSTIN(partyGstin);
  if (!org) return 'unknown';
  if (!party) return 'intra';            // org known, party unregistered → intra B2C
  return org === party ? 'intra' : 'inter';
}

/** Split a GST amount into two halves that still sum exactly to the original. */
function halve(gst) {
  const half = round2(gst / 2);
  return [half, round2(gst - half)]; // [cgst, sgst]
}

/**
 * GST credit lines for a SALE (output) — the party is debited for the gross,
 * so these are the GST credit legs.
 * @returns {Array<{account:string, amount:number}>}
 */
export function outputGSTLines(gst, supplyType) {
  if (gst <= 0) return [];
  if (supplyType === 'inter') return [{ account: 'Output IGST', amount: round2(gst) }];
  if (supplyType === 'intra') {
    const [cgst, sgst] = halve(gst);
    return [{ account: 'Output CGST', amount: cgst }, { account: 'Output SGST', amount: sgst }];
  }
  return [{ account: 'Output GST Payable', amount: round2(gst) }];
}

/**
 * GST debit lines for a PURCHASE (input) — claimable input tax credit.
 * @returns {Array<{account:string, amount:number}>}
 */
export function inputGSTLines(gst, supplyType) {
  if (gst <= 0) return [];
  if (supplyType === 'inter') return [{ account: 'Input IGST', amount: round2(gst) }];
  if (supplyType === 'intra') {
    const [cgst, sgst] = halve(gst);
    return [{ account: 'Input CGST', amount: cgst }, { account: 'Input SGST', amount: sgst }];
  }
  return [{ account: 'Input GST Credit', amount: round2(gst) }];
}

// ── Expense classification (Direct vs Indirect) ──────────────────────────────
// Each rule maps a keyword pattern to a real CoA account. `direct: true` marks
// costs that are part of delivering a job/site (Cost of Goods Sold side).
const EXPENSE_RULES = [
  { re: /\b(subcontract|sub-contract|outsourc|vendor\s+work)\b/i, account: 'Subcontractor / Outsourcing', direct: true },
  { re: /\b(labour|labor|manpower|crew|helper|loading|unloading)\b/i, account: 'Direct Labour', direct: true },
  { re: /\b(equipment\s*hire|machinery\s*hire|hire\s*of|rented\s*equipment|gear\s*hire)\b/i, account: 'Equipment Hire', direct: true },
  { re: /\b(freight\s*inward|inward\s*freight|cartage\s*inward)\b/i, account: 'Freight Inward', direct: true },
  { re: /\b(diesel|petrol|fuel|generator\s*fuel|dg\s*fuel)\b/i, account: 'Site Power & Fuel', direct: true, siteOnly: true },
  { re: /\b(rent|lease|kiraya)\b/i, account: 'Rent Expense' },
  { re: /\b(electric|electricity|power\s*bill|eb\s*bill)\b/i, account: 'Electricity Expense' },
  { re: /\b(internet|wifi|broadband|phone|mobile|telephone|recharge|sim)\b/i, account: 'Telephone & Internet' },
  { re: /\b(stationery|printing|print|paper|toner|cartridge|pen)\b/i, account: 'Printing & Stationery' },
  { re: /\b(bank\s*charge|bank\s*fee|neft\s*charge|processing\s*fee|cheque\s*bounce)\b/i, account: 'Bank Charges' },
  { re: /\b(legal|lawyer|advocate|consultant|consulting|professional\s*fee|audit\s*fee|ca\s*fee|retainer)\b/i, account: 'Professional & Legal Fees' },
  { re: /\b(travel|cab|taxi|uber|ola|flight|train|bus|conveyance|toll|parking)\b/i, account: 'Travelling & Conveyance' },
  { re: /\b(repair|maintenance|service|amc|fix|servicing)\b/i, account: 'Repairs & Maintenance' },
  { re: /\b(insurance|premium|policy)\b/i, account: 'Insurance Expense' },
  { re: /\b(marketing|advertis|promo|campaign|ads|branding|hoarding)\b/i, account: 'Marketing Expense' },
  { re: /\b(commission|brokerage)\b/i, account: 'Commission Expense' },
  { re: /\b(food|meal|lunch|dinner|breakfast|tea|coffee|snack|catering|refreshment)\b/i, account: 'Food Expense' },
  { re: /\b(office\s*supplies|supplies|housekeeping|pantry)\b/i, account: 'Office Supplies Expense' },
  { re: /\b(courier|shipping|freight|transport|logistics|delivery)\b/i, account: 'Freight & Logistics' },
];

/**
 * Pick the best expense account for a description.
 * @param {string} desc
 * @param {{ hasProject?: boolean }} [opts]  // a job/site reference biases site-fuel to Direct
 * @returns {{ account: string, direct: boolean }}
 */
export function classifyExpenseAccount(desc, opts = {}) {
  const text = String(desc || '');
  for (const rule of EXPENSE_RULES) {
    if (rule.re.test(text)) {
      // Site-only direct accounts stay direct only when a job/site is referenced.
      const direct = rule.siteOnly ? !!(opts.hasProject && rule.direct) : !!rule.direct;
      return { account: rule.account, direct };
    }
  }
  return { account: 'Miscellaneous Expense', direct: false };
}

// ── TDS section inference ─────────────────────────────────────────────────────
// Maps the nature of a payment to the most likely TDS section so the dormant
// compliance.checkTDSApplicability() can warn the user.
const TDS_RULES = [
  { re: /\b(rent|lease|kiraya)\b/i, section: '194I' },
  { re: /\b(professional|legal|consultant|consulting|technical|audit|retainer|ca\s*fee|lawyer|advocate)\b/i, section: '194J' },
  { re: /\b(contract|subcontract|sub-contract|labour|labor|manpower|works\s*contract|job\s*work)\b/i, section: '194C' },
  { re: /\b(commission|brokerage)\b/i, section: '194H' },
  { re: /\b(interest)\b/i, section: '194A' },
];

/**
 * Infer the TDS section for a transaction (or null).
 * @param {string} intent
 * @param {string} text
 * @returns {string|null}
 */
export function tdsSectionForTransaction(intent, text) {
  const t = String(text || '');
  if (intent === 'rent') return '194I';
  if (intent === 'interest_paid') return '194A';
  if (intent === 'salary' || intent === 'advance') return null; // salary TDS is 192, handled separately
  for (const rule of TDS_RULES) {
    if (rule.re.test(t)) return rule.section;
  }
  // Only suggest a section for outflow-style intents.
  if (['payment', 'purchase', 'expense'].includes(intent)) {
    for (const rule of TDS_RULES) {
      if (rule.re.test(t)) return rule.section;
    }
  }
  return null;
}
