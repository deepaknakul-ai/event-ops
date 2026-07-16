import { describe, it, expect } from 'vitest';
import { runBooksAudit } from '../src/utils/aiAccountant/booksAudit.js';

const codes = (r) => r.findings.map((f) => f.code);
const cleanSnapshot = (over = {}) => ({
  trialBalance: { isBalanced: true, difference: 0, totalDebit: 10000, totalCredit: 10000 },
  ledger: [{ account: 'Cash In Hand', balance: 5000 }, { account: 'Sales Revenue', balance: -5000 }],
  balanceSheet: { liabilities: { gstPayable: 0 } },
  ...over,
});

describe('runBooksAudit', () => {
  it('clean books → no findings, grade A', () => {
    const r = runBooksAudit(cleanSnapshot(), { entries: [{ voucher_no: 'JV-1', narration: 'Sale', date: '2026-04-01' }] });
    expect(r.findings).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.summary.trialBalanced).toBe(true);
  });

  it('flags an out-of-balance trial balance as blocking (heavy penalty)', () => {
    const r = runBooksAudit(cleanSnapshot({ trialBalance: { isBalanced: false, difference: 250, totalDebit: 10250, totalCredit: 10000 } }));
    expect(codes(r)).toContain('trial_imbalance');
    expect(r.findings.find((f) => f.code === 'trial_imbalance').severity).toBe('blocking');
    expect(r.score).toBeLessThanOrEqual(60);
    expect(r.summary.trialBalanced).toBe(false);
  });

  it('flags Suspense balances and negative cash', () => {
    const r = runBooksAudit(cleanSnapshot({
      ledger: [{ account: 'Suspense', balance: 1200 }, { account: 'Bank', balance: -800 }],
    }));
    expect(codes(r)).toEqual(expect.arrayContaining(['suspense_balance', 'negative_cash']));
  });

  it('detects book-wide duplicate vouchers', () => {
    const leg = [{ debitAccount: 'Rent Expense', creditAccount: 'Bank', amount: 5000 }];
    const r = runBooksAudit(cleanSnapshot(), {
      entries: [
        { voucher_no: 'JV-1', date: '2026-04-01', narration: 'Rent', entries: leg },
        { voucher_no: 'JV-2', date: '2026-04-01', narration: 'Rent', entries: leg },
      ],
    });
    const dup = r.findings.find((f) => f.code === 'duplicate_voucher');
    expect(dup).toBeTruthy();
    expect(dup.refs).toEqual(['JV-1', 'JV-2']);
  });

  it('raises GST/TDS deposit advisories from outstanding balances', () => {
    const r = runBooksAudit(cleanSnapshot({
      balanceSheet: { liabilities: { gstPayable: 3000 } },
      ledger: [{ account: 'TDS Payable', balance: -4000 }],
    }));
    expect(codes(r)).toEqual(expect.arrayContaining(['gst_outstanding', 'tds_outstanding']));
  });

  it('flags stale 90+ receivables from the ageing analysis', () => {
    const r = runBooksAudit(cleanSnapshot(), {
      ageing: { receivable: [{ account: 'Party: Acme', name: 'Acme', '90_plus': 12000 }], payable: [] },
    });
    expect(codes(r)).toContain('stale_receivable');
  });

  it('flags missing narration, unreviewed AI entries, and unposted drafts', () => {
    const r = runBooksAudit(cleanSnapshot(), {
      entries: [
        { voucher_no: 'JV-1', date: '2026-04-01', narration: '' },                         // missing narration
        { voucher_no: 'JV-2', date: '2026-04-02', narration: 'ok', origin: 'ai_chat', ai_reviewed: false }, // unreviewed AI
      ],
      drafts: [{ id: 'd1' }, { id: 'd2' }],
    });
    expect(codes(r)).toEqual(expect.arrayContaining(['missing_narration', 'unreviewed_ai', 'unposted_drafts']));
  });

  it('flags entries dated in a closed financial year', () => {
    const r = runBooksAudit(cleanSnapshot(), {
      entries: [{ voucher_no: 'JV-1', date: '2024-06-01', fy: '2024-25', narration: 'x' }],
      closedFYs: ['2024-25'],
    });
    expect(codes(r)).toContain('closed_fy_entry');
  });

  it('is deterministic and robust to empty input', () => {
    const a = runBooksAudit({}, {});
    expect(a.findings).toEqual([]);
    expect(a.score).toBe(100);
    expect(runBooksAudit(cleanSnapshot(), {})).toEqual(runBooksAudit(cleanSnapshot(), {}));
  });
});
