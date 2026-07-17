import { describe, it, expect } from 'vitest';
import { computeTdsYtdForParty, checkTDSApplicability } from '../src/utils/aiAccountant/compliance.js';

// A7 — the chat previously pinned tdsYtdAmount to 0, so the section-wise ANNUAL
// aggregate (e.g. 194C ₹1,00,000 of payments) could never fire.
const je = (fy, party, amount) => ({ fy, party_name: party, entries: [{ debitAccount: 'X', creditAccount: 'Y', amount }] });

describe('computeTdsYtdForParty', () => {
  const entries = [
    je('2026-27', 'Sharma Traders', 40000),
    je('2026-27', 'Sharma Traders', 35000),
    je('2026-27', 'sharma traders', 5000),   // case-insensitive match
    je('2025-26', 'Sharma Traders', 90000),  // other FY — excluded
    je('2026-27', 'Acme Corp', 50000),       // other party — excluded
    { fy: '2026-27', entries: [{ amount: 10000 }] }, // no party_name — excluded
  ];

  it('sums this-FY payments to the party only (case-insensitive)', () => {
    expect(computeTdsYtdForParty(entries, 'Sharma Traders', '2026-27')).toBe(80000);
  });
  it('returns 0 without a party or FY, and on empty input', () => {
    expect(computeTdsYtdForParty(entries, '', '2026-27')).toBe(0);
    expect(computeTdsYtdForParty(entries, 'Sharma Traders', '')).toBe(0);
    expect(computeTdsYtdForParty([], 'Sharma Traders', '2026-27')).toBe(0);
  });
  it('feeds the 194C annual aggregate: sub-threshold payment crosses on YTD', () => {
    // 80k YTD + 25k new = 105k >= 1L annual cap even though 25k < 30k single-txn.
    const ytd = computeTdsYtdForParty(entries, 'Sharma Traders', '2026-27');
    const r = checkTDSApplicability({ amount: 25000, section: '194C', ytdAmount: ytd });
    expect(r.applies).toBe(true);
    expect(r.reason).toBe('annual_cap');
  });
});
