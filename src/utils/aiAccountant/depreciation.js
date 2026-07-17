// ─────────────────────────────────────────────────────────────────────────────
// Depreciation proposer (Phase 5 of "Full Accountant"). PURE and advisory-only:
// computes a year-end depreciation schedule over the FIXED-ASSET ledger balances
// (WDV block rates, Income-tax style) and returns a ready-to-park journal
// proposal — Dr Depreciation Expense / Cr Accumulated Depreciation. The human
// reviews and posts (park-as-draft); nothing is posted automatically.
//
// Honest v1 limitation: accumulated depreciation lives in ONE contra account,
// so the base here is each asset account's ledger balance (cost), not a true
// per-class WDV. The schedule is a PROPOSAL to review/edit, not gospel.
// ─────────────────────────────────────────────────────────────────────────────
import { round2, inferAccountMeta } from './schema.js';

// WDV block rates by asset-class name. Order matters (first match wins).
export const DEP_RULES = [
  { re: /computer|software/i, rate: 40 },
  { re: /furniture|fixture/i, rate: 10 },
  { re: /vehicle/i, rate: 15 },
  { re: /land\s*&\s*building/i, rate: 10, note: 'Rate applied to the whole balance — split out land (not depreciable) if it is included.' },
  { re: /\bland\b/i, rate: 0 },
  { re: /av\s*equipment|plant|machinery|equipment|fixed\s*asset/i, rate: 15 },
];

const fyEndDate = (fy) => {
  // '2026-27' → '2027-03-31'
  const start = parseInt(String(fy).slice(0, 4), 10);
  return Number.isFinite(start) ? `${start + 1}-03-31` : '';
};

/**
 * @param {{ ledger?:object[], fy?:string }} args
 * @returns {{ proposals:Array<{account,base,rate,amount,note?}>, total:number, date:string, narration:string, entries:Array, parsed:object|null }}
 */
export function proposeDepreciation({ ledger = [], fy = '' } = {}) {
  const proposals = [];
  (ledger || []).forEach((row) => {
    const name = row.account || '';
    if (/accumulated\s*depreciation/i.test(name)) return;
    const meta = inferAccountMeta(name);
    if (meta.subType !== 'Fixed Asset') return;         // only true fixed-asset accounts
    const base = round2(row.balance || 0);
    if (base <= 0.5) return;                            // nothing to depreciate
    const rule = DEP_RULES.find((r) => r.re.test(name));
    if (!rule || rule.rate <= 0) return;                // land etc. excluded
    const amount = round2((base * rule.rate) / 100);
    if (amount <= 0.5) return;
    proposals.push({ account: name, base, rate: rule.rate, amount, ...(rule.note ? { note: rule.note } : {}) });
  });

  const total = round2(proposals.reduce((s, p) => s + p.amount, 0));
  const date = fyEndDate(fy);
  const schedule = proposals.map((p) => `${p.account} @${p.rate}% = ${p.amount}`).join('; ');
  const narration = `Depreciation for FY ${fy} (WDV): ${schedule}`;
  const entries = total > 0
    ? [{ debitAccount: 'Depreciation Expense', creditAccount: 'Accumulated Depreciation', amount: total }]
    : [];

  // A canonical Transaction the existing park-as-draft path accepts verbatim.
  const parsed = total > 0 ? {
    intent: 'depreciation',
    date,
    narration,
    entries,
    party: { type: 'internal', name: '' },
    mode: 'Cash',
    confidence: 0.9,
    rawPrompt: `Depreciation proposal FY ${fy}`,
    model: 'rule-v1',
    issues: [],
    accountCreates: [],
    meta: { depreciation: true, fy, proposals },
  } : null;

  return { proposals, total, date, narration, entries, parsed };
}
