import { describe, it, expect } from 'vitest';
import { computeAppropriation, allowedRemuneration } from '../src/utils/partnershipAppropriation.js';

// s.40(b) waterfall, hand-computed. Interest on capital (≤12%, allowed even in
// loss) → working-partner remuneration within the book-profit limit (FA2024
// slabs) → divisible profit/loss by ratio. The voucher must always balance:
// Σ per-partner totals === net profit, to the paise.

const partners = {
  A: { name: 'Partner A', profit_share: 60, interest_on_capital_rate: 12, is_working_partner: true, remuneration_annual: 300000, active: true },
  B: { name: 'Partner B', profit_share: 40, interest_on_capital_rate: 12, is_working_partner: true, remuneration_annual: 300000, active: true },
};
const openingCapital = { A: 600000, B: 400000 };

describe('allowedRemuneration — the 40(b)(v) limit', () => {
  it('loss year → the ₹3,00,000 floor', () => {
    expect(allowedRemuneration(-500000)).toBe(300000);
    expect(allowedRemuneration(0)).toBe(300000);
  });
  it('small profit → floor beats 90%', () => {
    // 90% of 2,00,000 = 1,80,000 < 3,00,000 floor
    expect(allowedRemuneration(200000)).toBe(300000);
  });
  it('slab 1 fully used → 90%', () => {
    expect(allowedRemuneration(600000)).toBe(540000); // 90% of 6L
  });
  it('both slabs: 90% of first 6L + 60% of balance', () => {
    // book profit 10,80,000 → 5,40,000 + 60%×4,80,000 = 8,28,000
    expect(allowedRemuneration(1080000)).toBe(828000);
  });
});

describe('computeAppropriation — profit year (₹12,00,000, 60/40)', () => {
  const r = computeAppropriation({ netProfit: 1200000, partners, openingCapital });

  it('interest on capital @12% on opening balances', () => {
    expect(r.interestRows.find(x => x.empId === 'A').amount).toBe(72000);
    expect(r.interestRows.find(x => x.empId === 'B').amount).toBe(48000);
  });
  it('book profit = profit − interest', () => {
    expect(r.bookProfit).toBe(1080000);
    expect(r.remunerationAllowed).toBe(828000);
  });
  it('configured remuneration under the limit → paid in full', () => {
    expect(r.remunerationTotal).toBe(600000);
    expect(r.perPartner.A.remuneration).toBe(300000);
    expect(r.perPartner.B.remuneration).toBe(300000);
  });
  it('divisible split 60/40', () => {
    expect(r.divisible).toBe(480000);
    expect(r.perPartner.A.share).toBe(288000);
    expect(r.perPartner.B.share).toBe(192000);
  });
  it('per-partner totals and the balancing invariant', () => {
    expect(r.perPartner.A.total).toBe(660000);
    expect(r.perPartner.B.total).toBe(540000);
    expect(r.totalAppropriated).toBe(1200000); // === netProfit
  });
});

describe('computeAppropriation — remuneration capped by 40(b)', () => {
  it('configured above the allowed limit is scaled to the limit, pro-rata', () => {
    const rich = {
      A: { ...partners.A, remuneration_annual: 900000 },
      B: { ...partners.B, remuneration_annual: 300000 },
    };
    // netProfit 6,00,000 → interest 1,20,000 → book profit 4,80,000
    // allowed = max(3L, 90%×4.8L=4.32L) = 4,32,000; configured 12,00,000 → capped
    const r = computeAppropriation({ netProfit: 600000, partners: rich, openingCapital });
    expect(r.remunerationAllowed).toBe(432000);
    expect(r.remunerationTotal).toBe(432000);
    expect(r.perPartner.A.remuneration).toBe(324000); // 432000 × 9/12
    expect(r.perPartner.B.remuneration).toBe(108000); // remainder row
    expect(r.totalAppropriated).toBe(600000);
  });
});

describe('computeAppropriation — loss year (−₹2,00,000)', () => {
  const r = computeAppropriation({ netProfit: -200000, partners, openingCapital });

  it('interest still allowed (40(b)(iv) caps the rate, not the profit)', () => {
    expect(r.interestRows.find(x => x.empId === 'A').amount).toBe(72000);
  });
  it('remuneration capped at the ₹3,00,000 loss-year floor, pro-rata', () => {
    expect(r.bookProfit).toBe(-320000);
    expect(r.remunerationAllowed).toBe(300000);
    expect(r.remunerationTotal).toBe(300000);
    expect(r.perPartner.A.remuneration).toBe(150000);
    expect(r.perPartner.B.remuneration).toBe(150000);
  });
  it('the loss (grown by interest+remuneration) is shared by ratio', () => {
    expect(r.divisible).toBe(-620000);
    expect(r.perPartner.A.share).toBe(-372000);
    expect(r.perPartner.B.share).toBe(-248000);
  });
  it('still balances to the net loss', () => {
    expect(r.perPartner.A.total).toBe(-150000);
    expect(r.perPartner.B.total).toBe(-50000);
    expect(r.totalAppropriated).toBe(-200000);
  });
});

describe('edge behaviour', () => {
  it('interest rate is hard-capped at 12% even if configured higher', () => {
    const greedy = { A: { ...partners.A, interest_on_capital_rate: 24 }, B: partners.B };
    const r = computeAppropriation({ netProfit: 1000000, partners: greedy, openingCapital });
    expect(r.interestRows.find(x => x.empId === 'A').rate).toBe(12);
    expect(r.interestRows.find(x => x.empId === 'A').amount).toBe(72000);
  });
  it('no interest on an overdrawn (negative) capital balance', () => {
    const r = computeAppropriation({ netProfit: 100000, partners, openingCapital: { A: -50000, B: 400000 } });
    expect(r.interestRows.find(x => x.empId === 'A').amount).toBe(0);
  });
  it('inactive partners are excluded entirely', () => {
    const three = { ...partners, C: { name: 'Left', profit_share: 50, active: false } };
    const r = computeAppropriation({ netProfit: 1000000, partners: three, openingCapital });
    expect(r.perPartner.C).toBeUndefined();
    expect(r.totalAppropriated).toBe(1000000);
  });
  it('non-working partner gets no remuneration but full interest + share', () => {
    const mixed = {
      A: { ...partners.A },
      B: { ...partners.B, is_working_partner: false },
    };
    const r = computeAppropriation({ netProfit: 1200000, partners: mixed, openingCapital });
    expect(r.perPartner.B.remuneration).toBe(0);
    expect(r.perPartner.B.interest).toBe(48000);
    expect(r.totalAppropriated).toBe(1200000);
  });
  it('awkward ratios still balance to the paise (remainder-absorbing last row)', () => {
    const thirds = {
      A: { name: 'A', profit_share: 33.33, active: true },
      B: { name: 'B', profit_share: 33.33, active: true },
      C: { name: 'C', profit_share: 33.34, active: true },
    };
    const r = computeAppropriation({ netProfit: 100000.01, partners: thirds, openingCapital: {} });
    expect(r.totalAppropriated).toBe(100000.01);
  });
  it('empty registry → zero everything, no crash', () => {
    const r = computeAppropriation({ netProfit: 500000, partners: {}, openingCapital: {} });
    expect(r.totalAppropriated).toBe(0);
    expect(r.interestRows).toHaveLength(0);
  });
});
