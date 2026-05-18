import { describe, it, expect } from 'vitest';
import {
  validateGSTIN,
  checkTDSApplicability,
  detectDuplicateVoucher,
  suggestRoundOff,
  checkCashCap,
  runComplianceChecks,
} from '../src/utils/aiAccountant/compliance.js';

describe('validateGSTIN', () => {
  // Compute a valid GSTIN dynamically so the test doesn't depend on a real
  // company's registration number.
  const validGstin = (() => {
    const base14 = '27AAPFU0939F1Z';
    const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const FACTOR = [1, 2];
    let sum = 0;
    for (let i = 0; i < 14; i += 1) {
      const prod = CHARS.indexOf(base14[i]) * FACTOR[i % 2];
      sum += Math.floor(prod / 36) + (prod % 36);
    }
    return base14 + CHARS[(36 - (sum % 36)) % 36];
  })();

  it('accepts a well-formed GSTIN', () => {
    const r = validateGSTIN(validGstin);
    expect(r.ok).toBe(true);
  });
  it('rejects wrong length', () => {
    expect(validateGSTIN('27AAPFU').ok).toBe(false);
  });
  it('rejects bad format', () => {
    expect(validateGSTIN('abcdefghijklmno').ok).toBe(false);
  });
  it('rejects bad checksum', () => {
    // Flip the check digit — will fail checksum but keep format valid.
    const bad = validGstin.slice(0, 14) + (validGstin[14] === 'A' ? 'B' : 'A');
    expect(validateGSTIN(bad).ok).toBe(false);
  });
});

describe('checkTDSApplicability', () => {
  it('applies when single-txn threshold crossed', () => {
    const r = checkTDSApplicability({ amount: 50000, section: '194C' });
    expect(r.applies).toBe(true);
    expect(r.rate).toBe(1);
  });
  it('does not apply under threshold', () => {
    const r = checkTDSApplicability({ amount: 1000, section: '194C' });
    expect(r.applies).toBe(false);
  });
  it('applies when annual aggregate crossed', () => {
    const r = checkTDSApplicability({ amount: 10000, section: '194C', ytdAmount: 95000 });
    expect(r.applies).toBe(true);
    expect(r.reason).toBe('annual_cap');
  });
  it('returns unknown_section for unrecognised code', () => {
    const r = checkTDSApplicability({ amount: 10000, section: '999Z' });
    expect(r.applies).toBe(false);
    expect(r.reason).toBe('unknown_section');
  });
});

describe('detectDuplicateVoucher', () => {
  const base = {
    date: '2026-04-10',
    entries: [{ debitAccount: 'Travel Expense', creditAccount: 'Cash', amount: 500 }],
  };
  it('flags identical entry on same date', () => {
    const history = [{ ...base, voucher_no: 'JV-0001' }];
    expect(detectDuplicateVoucher(base, history)).toEqual({ dup: true, voucher: 'JV-0001' });
  });
  it('does not flag different amount', () => {
    const other = { ...base, entries: [{ ...base.entries[0], amount: 501 }] };
    expect(detectDuplicateVoucher(base, [other]).dup).toBe(false);
  });
});

describe('suggestRoundOff', () => {
  it('suggests rounding for 1234.56', () => {
    const r = suggestRoundOff({ entries: [{ debitAccount: 'A', creditAccount: 'B', amount: 1234.56 }] });
    expect(r.suggest).toBe(true);
    expect(r.roundTo).toBe(1235);
  });
  it('does not suggest for whole amounts', () => {
    const r = suggestRoundOff({ entries: [{ debitAccount: 'A', creditAccount: 'B', amount: 1000 }] });
    expect(r.suggest).toBe(false);
  });
});

describe('checkCashCap', () => {
  it('flags when cash to same payee crosses 10k in a day', () => {
    const tx = {
      mode: 'Cash',
      date: '2026-04-10',
      party: { name: 'Acme Corp' },
      entries: [{ debitAccount: 'X', creditAccount: 'Cash', amount: 6000 }],
    };
    const history = [
      { mode: 'Cash', date: '2026-04-10', party_name: 'Acme Corp', entries: [{ debitAccount: 'X', creditAccount: 'Cash', amount: 5000 }] },
    ];
    const r = checkCashCap(tx, history);
    expect(r.over).toBe(true);
    expect(r.total).toBe(11000);
  });
  it('does not flag bank payments', () => {
    const tx = {
      mode: 'Bank',
      date: '2026-04-10',
      party: { name: 'Acme Corp' },
      entries: [{ debitAccount: 'X', creditAccount: 'Bank', amount: 50000 }],
    };
    expect(checkCashCap(tx, []).over).toBe(false);
  });
});

describe('runComplianceChecks', () => {
  it('emits round-off info for fractional totals', () => {
    const tx = { entries: [{ debitAccount: 'A', creditAccount: 'B', amount: 999.5 }] };
    const issues = runComplianceChecks(tx);
    expect(issues.some((i) => i.code === 'round_off_suggest')).toBe(true);
  });
  it('emits bad_gstin when context supplies an invalid GSTIN', () => {
    const tx = { entries: [] };
    const issues = runComplianceChecks(tx, { partyGstin: 'INVALID123' });
    expect(issues.some((i) => i.code === 'bad_gstin')).toBe(true);
  });
});
