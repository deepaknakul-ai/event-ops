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

const DEP_NARRATION_RE = /^Depreciation for FY (\S+) \(WDV\)/;

/**
 * Collect depreciation ALREADY posted (journal entries) or parked (drafts) so a
 * new proposal can (a) refuse to double-provide for the same FY and (b) compute a
 * true WDV base = cost − prior depreciation per asset class. Per-account amounts
 * come from the persisted ai_meta.proposals; legacy entries without meta still
 * count toward same-FY detection via the narration stamp.
 * @param {{ entries?:object[], drafts?:object[] }} args
 * @returns {Array<{fy:string, date:string, voucher_no:string, status:'posted'|'draft', proposals:Array|null, total:number}>}
 */
export function collectPriorDepreciation({ entries = [], drafts = [] } = {}) {
  const out = [];
  const fyOf = (rec) => rec?.ai_meta?.fy
    || (String(rec?.narration || '').match(DEP_NARRATION_RE) || [])[1]
    || rec?.fy || '';
  const isDep = (rec, intentKey) => rec
    && ((rec[intentKey] === 'depreciation') || DEP_NARRATION_RE.test(String(rec.narration || '')) || rec?.ai_meta?.depreciation === true);
  (entries || []).forEach((e) => {
    if (!isDep(e, 'ai_intent')) return;
    out.push({
      fy: fyOf(e), date: e.date || '', voucher_no: e.voucher_no || e.id || '', status: 'posted',
      proposals: Array.isArray(e?.ai_meta?.proposals) ? e.ai_meta.proposals : null,
      total: round2((e.entries || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)),
    });
  });
  (drafts || []).forEach((d) => {
    if (!isDep(d, 'intent')) return;
    out.push({
      fy: fyOf(d), date: d.date || '', voucher_no: d.id || '', status: 'draft',
      proposals: Array.isArray(d?.ai_meta?.proposals) ? d.ai_meta.proposals : null,
      total: round2((d.entries || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)),
    });
  });
  return out;
}

/**
 * @param {{ ledger?:object[], fy?:string, prior?:Array }} args
 * @returns {{ proposals:Array<{account,base,rate,amount,note?}>, total:number, date:string, narration:string, entries:Array, parsed:object|null, alreadyProvided:object|null, unapportionedNote:string|null }}
 */
export function proposeDepreciation({ ledger = [], fy = '', prior = [] } = {}) {
  // Same-FY guard: depreciation already posted or parked for this FY → no new
  // proposal (double-provision was possible before this check existed).
  const existing = (prior || []).find((p) => p.fy === fy);
  if (existing) {
    return {
      proposals: [], total: 0, date: fyEndDate(fy), narration: '', entries: [], parsed: null,
      alreadyProvided: { total: existing.total, date: existing.date, voucher_no: existing.voucher_no, status: existing.status },
      unapportionedNote: null,
    };
  }

  // True WDV base = ledger cost − Σ prior per-account amounts (earlier FYs).
  const priorByAccount = {};
  let knownPriorTotal = 0;
  (prior || []).forEach((p) => (p.proposals || []).forEach((x) => {
    priorByAccount[x.account] = round2((priorByAccount[x.account] || 0) + (Number(x.amount) || 0));
    knownPriorTotal += Number(x.amount) || 0;
  }));
  const accDep = Math.abs(round2(
    (ledger || []).filter((r) => /accumulated\s*depreciation/i.test(r.account || '')).reduce((s, r) => s + (r.balance || 0), 0)
  ));
  const unapportioned = round2(accDep - knownPriorTotal);
  const unapportionedNote = unapportioned > 1
    ? `₹${unapportioned} of accumulated depreciation could not be apportioned per asset (posted before schedules were tracked) — bases may be overstated; review and edit before posting.`
    : null;

  const proposals = [];
  (ledger || []).forEach((row) => {
    const name = row.account || '';
    if (/accumulated\s*depreciation/i.test(name)) return;
    const meta = inferAccountMeta(name);
    if (meta.subType !== 'Fixed Asset') return;         // only true fixed-asset accounts
    const cost = round2(row.balance || 0);
    const base = round2(cost - (priorByAccount[name] || 0)); // WDV, not cost
    if (base <= 0.5) return;                            // nothing left to depreciate
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

  return { proposals, total, date, narration, entries, parsed, alreadyProvided: null, unapportionedNote };
}
