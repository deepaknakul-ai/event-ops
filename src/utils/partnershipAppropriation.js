/**
 * PARTNERSHIP P&L APPROPRIATION — Income-tax s.40(b) waterfall.
 *
 * At FY close a partnership firm does not park profit in one Retained Earnings
 * lump: it appropriates. The statutory order (and the one a CA files with):
 *
 *   1. Interest on capital  — deductible u/s 40(b)(iv) up to 12% simple p.a.,
 *      allowed even in a loss year (only the RATE is capped, not the profit).
 *   2. Working-partner remuneration — deductible u/s 40(b)(v) only within the
 *      book-profit limit. Post-Finance-Act-2024 slabs (AY 2025-26 onward):
 *        on the first ₹6,00,000 of book profit (or in case of a LOSS):
 *            ₹3,00,000 or 90% of book profit, whichever is MORE
 *        on the balance: 60%
 *      "Book profit" here = net profit AFTER interest on capital but BEFORE
 *      any partner remuneration.
 *   3. Divisible profit (can be negative — a loss is shared too) split by the
 *      profit-sharing ratio (s.13(b) Partnership Act: equal unless agreed).
 *
 * Pure module — no Firebase, no UI — so the maths is unit-testable against
 * hand-computed examples. The FY-close flow turns the result into ONE balanced
 * appropriation voucher (Dr Retained Earnings / Cr Capital — Partner N).
 *
 * v1 scope notes (documented, deliberate):
 *  - Interest is computed on the OPENING capital balance only (no monthly
 *    product on mid-year contributions).
 *  - A loss year still computes the ₹3,00,000-capped remuneration — the 40(b)
 *    deduction exists; whether the deed pays it is the owner's call, and the
 *    close screen shows the full breakdown before anything posts.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Statutory caps (kept in one place; FA2024 figures). */
export const MAX_INTEREST_RATE = 12; // % p.a., s.40(b)(iv)
export const REMUNERATION_SLAB1_LIMIT = 600000; // first slab of book profit
export const REMUNERATION_SLAB1_FLOOR = 300000; // ₹3,00,000 floor
export const REMUNERATION_SLAB1_PCT = 0.9; // 90% of slab-1 book profit
export const REMUNERATION_SLAB2_PCT = 0.6; // 60% of the balance

/**
 * Maximum remuneration deductible u/s 40(b)(v) for a given book profit.
 * Loss (book profit <= 0) → the ₹3,00,000 floor.
 */
export const allowedRemuneration = (bookProfit) => {
  const bp = Number(bookProfit) || 0;
  if (bp <= 0) return REMUNERATION_SLAB1_FLOOR;
  const slab1 = Math.min(bp, REMUNERATION_SLAB1_LIMIT);
  const slab2 = Math.max(0, bp - REMUNERATION_SLAB1_LIMIT);
  return round2(Math.max(REMUNERATION_SLAB1_FLOOR, slab1 * REMUNERATION_SLAB1_PCT) + slab2 * REMUNERATION_SLAB2_PCT);
};

/**
 * Compute the full appropriation.
 *
 * @param {object} input
 * @param {number} input.netProfit       — the year's net profit from the books,
 *                                         BEFORE any partner interest/remuneration
 *                                         (the app never posts either mid-year)
 * @param {Object<string, object>} input.partners — settings/partnership.partners map
 *        (only entries with active !== false participate):
 *        { name, profit_share, interest_on_capital_rate, is_working_partner,
 *          remuneration_annual }
 * @param {Object<string, number>} [input.openingCapital] — empId → opening
 *        capital balance (Cr positive). Missing → 0 (no interest).
 * @returns {{
 *   interestRows: Array<{empId,name,rate,capital,amount}>,
 *   bookProfit: number,
 *   remunerationAllowed: number,
 *   remunerationRows: Array<{empId,name,configured,amount}>,
 *   remunerationTotal: number,
 *   divisible: number,
 *   shareRows: Array<{empId,name,sharePct,amount}>,
 *   perPartner: Object<string,{name,interest,remuneration,share,total}>,
 *   totalAppropriated: number,   // always === netProfit (voucher balances)
 * }}
 */
export const computeAppropriation = ({ netProfit = 0, partners = {}, openingCapital = {} } = {}) => {
  const active = Object.entries(partners || {})
    .filter(([, p]) => p && p.active !== false)
    .map(([empId, p]) => ({ empId, ...p }));

  const np = round2(netProfit);

  // ── 1. Interest on capital (rate hard-capped at 12%) ──────────────────────
  const interestRows = active.map((p) => {
    const rate = Math.min(Math.max(Number(p.interest_on_capital_rate) || 0, 0), MAX_INTEREST_RATE);
    const capital = Math.max(0, Number(openingCapital?.[p.empId]) || 0); // no interest on a debit (overdrawn) capital
    return { empId: p.empId, name: p.name || p.empId, rate, capital, amount: round2(capital * rate / 100) };
  });
  const interestTotal = round2(interestRows.reduce((s, r) => s + r.amount, 0));

  // ── 2. Remuneration within the 40(b) book-profit limit ────────────────────
  const bookProfit = round2(np - interestTotal);
  const remunerationAllowed = allowedRemuneration(bookProfit);
  const working = active.filter((p) => p.is_working_partner);
  const configuredTotal = round2(working.reduce((s, p) => s + (Number(p.remuneration_annual) || 0), 0));
  const remunerationTotal = round2(Math.min(configuredTotal, remunerationAllowed));
  // Pro-rata the allowed pool by each working partner's configured amount; the
  // last row absorbs the paise remainder so the voucher stays balanced.
  let allocated = 0;
  const remunerationRows = working.map((p, i) => {
    const configured = Number(p.remuneration_annual) || 0;
    let amount;
    if (i === working.length - 1) amount = round2(remunerationTotal - allocated);
    else {
      amount = configuredTotal > 0 ? round2(remunerationTotal * (configured / configuredTotal)) : 0;
      allocated = round2(allocated + amount);
    }
    return { empId: p.empId, name: p.name || p.empId, configured, amount };
  });

  // ── 3. Divisible profit (or loss) by the profit-sharing ratio ─────────────
  const divisible = round2(np - interestTotal - remunerationTotal);
  const totalShare = active.reduce((s, p) => s + (Number(p.profit_share) || 0), 0) || 1;
  let shareAllocated = 0;
  const shareRows = active.map((p, i) => {
    const sharePct = Number(p.profit_share) || 0;
    let amount;
    if (i === active.length - 1) amount = round2(divisible - shareAllocated); // remainder-absorbing
    else {
      amount = round2(divisible * (sharePct / totalShare));
      shareAllocated = round2(shareAllocated + amount);
    }
    return { empId: p.empId, name: p.name || p.empId, sharePct, amount };
  });

  // ── Per-partner rollup ────────────────────────────────────────────────────
  const perPartner = {};
  active.forEach((p) => {
    const interest = interestRows.find((r) => r.empId === p.empId)?.amount || 0;
    const remuneration = remunerationRows.find((r) => r.empId === p.empId)?.amount || 0;
    const share = shareRows.find((r) => r.empId === p.empId)?.amount || 0;
    perPartner[p.empId] = {
      name: p.name || p.empId,
      interest,
      remuneration,
      share,
      total: round2(interest + remuneration + share),
    };
  });
  const totalAppropriated = round2(Object.values(perPartner).reduce((s, r) => s + r.total, 0));

  return {
    interestRows, bookProfit, remunerationAllowed, remunerationRows, remunerationTotal,
    divisible, shareRows, perPartner, totalAppropriated,
  };
};
