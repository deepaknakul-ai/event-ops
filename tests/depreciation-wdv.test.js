import { describe, it, expect } from 'vitest';
import { proposeDepreciation, collectPriorDepreciation } from '../src/utils/aiAccountant/depreciation.js';

// B1 — depreciation must not double-provide for the same FY, and multi-year
// bases must be WDV (cost − prior schedules), not full cost every year.
const row = (account, balance) => ({ account, balance });

describe('collectPriorDepreciation', () => {
  it('collects posted schedules via ai_intent/ai_meta and legacy narration stamps', () => {
    const prior = collectPriorDepreciation({
      entries: [
        { ai_intent: 'depreciation', date: '2026-03-31', voucher_no: 'JV-0009-2025-26', ai_meta: { depreciation: true, fy: '2025-26', proposals: [{ account: 'Computer Equipment', amount: 40000 }] }, entries: [{ amount: 40000 }] },
        { narration: 'Depreciation for FY 2024-25 (WDV): Computer Equipment @40% = 30000', date: '2025-03-31', voucher_no: 'JV-0004-2024-25', entries: [{ amount: 30000 }] }, // legacy, no meta
        { narration: 'Rent paid', entries: [{ amount: 5000 }] },
      ],
      drafts: [{ intent: 'depreciation', date: '2027-03-31', id: 'd1', ai_meta: { fy: '2026-27', proposals: [] }, entries: [{ amount: 12000 }] }],
    });
    expect(prior).toHaveLength(3);
    expect(prior.find((p) => p.fy === '2025-26')).toMatchObject({ status: 'posted', total: 40000 });
    expect(prior.find((p) => p.fy === '2024-25')).toMatchObject({ status: 'posted', total: 30000, proposals: null });
    expect(prior.find((p) => p.fy === '2026-27')).toMatchObject({ status: 'draft', total: 12000 });
  });
});

describe('proposeDepreciation with prior history', () => {
  const ledger = [row('Computer Equipment', 100000), row('Accumulated Depreciation', -40000)];
  const postedPrior = [{ fy: '2025-26', date: '2026-03-31', voucher_no: 'JV-9', status: 'posted', total: 40000, proposals: [{ account: 'Computer Equipment', amount: 40000 }] }];

  it('same-FY prior (posted) → alreadyProvided, no proposal, no parseable draft', () => {
    const r = proposeDepreciation({ ledger, fy: '2025-26', prior: postedPrior });
    expect(r.proposals).toHaveLength(0);
    expect(r.parsed).toBe(null);
    expect(r.alreadyProvided).toMatchObject({ total: 40000, status: 'posted', voucher_no: 'JV-9' });
  });

  it('same-FY prior parked as a DRAFT also blocks a second proposal', () => {
    const r = proposeDepreciation({ ledger, fy: '2026-27', prior: [{ fy: '2026-27', date: '2027-03-31', voucher_no: 'd1', status: 'draft', total: 24000, proposals: [] }] });
    expect(r.parsed).toBe(null);
    expect(r.alreadyProvided.status).toBe('draft');
  });

  it('next-FY base is WDV: cost 100000 − prior 40000 → 60000 @40% = 24000 (not 40000 again)', () => {
    const r = proposeDepreciation({ ledger, fy: '2026-27', prior: postedPrior });
    expect(r.proposals[0]).toMatchObject({ account: 'Computer Equipment', base: 60000, amount: 24000 });
    expect(r.unapportionedNote).toBe(null); // 40000 acc-dep fully explained by schedules
  });

  it('legacy unexplained accumulated depreciation raises the honest note', () => {
    const r = proposeDepreciation({ ledger: [row('Computer Equipment', 100000), row('Accumulated Depreciation', -25000)], fy: '2026-27', prior: [] });
    expect(r.unapportionedNote).toMatch(/25000/);
    expect(r.proposals[0].base).toBe(100000); // no per-account history to subtract — flagged, not guessed
  });

  it('no prior at all behaves like v1 (back-compat)', () => {
    const r = proposeDepreciation({ ledger: [row('Computer Equipment', 100000)], fy: '2026-27' });
    expect(r.proposals[0]).toMatchObject({ base: 100000, amount: 40000 });
    expect(r.alreadyProvided).toBe(null);
  });
});
