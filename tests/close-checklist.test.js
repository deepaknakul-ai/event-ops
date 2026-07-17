import { describe, it, expect } from 'vitest';
import { buildCloseChecklist, buildComplianceCalendar } from '../src/utils/aiAccountant/closeChecklist.js';

const cleanAudit = { findings: [], summary: { trialBalanced: true } };
const item = (r, id) => r.items.find((i) => i.id === id);

describe('buildCloseChecklist', () => {
  it('clean books → ready, everything ok except the manual bank check', () => {
    const r = buildCloseChecklist({ audit: cleanAudit, drafts: [], entries: [], today: '2026-07-17' });
    expect(r.ready).toBe(true);
    expect(item(r, 'trial_balanced').status).toBe('ok');
    expect(item(r, 'no_blocking').status).toBe('ok');
    expect(item(r, 'bank_reconciled').status).toBe('manual');
  });

  it('an unbalanced trial balance or blocking finding blocks the close', () => {
    const r1 = buildCloseChecklist({ audit: { findings: [], summary: { trialBalanced: false } }, today: '2026-07-17' });
    expect(r1.ready).toBe(false);
    expect(item(r1, 'trial_balanced').status).toBe('block');
    const r2 = buildCloseChecklist({ audit: { findings: [{ severity: 'blocking', code: 'trial_imbalance', message: 'x' }], summary: { trialBalanced: true } }, today: '2026-07-17' });
    expect(r2.ready).toBe(false);
    expect(item(r2, 'no_blocking').status).toBe('block');
  });

  it('drafts, unreviewed AI entries, GST/TDS outstanding surface as warnings (not blockers)', () => {
    const audit = { findings: [{ severity: 'advisory', code: 'gst_outstanding', message: 'g' }, { severity: 'advisory', code: 'tds_outstanding', message: 't' }], summary: { trialBalanced: true } };
    const r = buildCloseChecklist({
      audit,
      drafts: [{ id: 'd1' }],
      entries: [{ voucher_no: 'JV-1', origin: 'ai_chat', ai_reviewed: false, date: '2026-07-01' }],
      today: '2026-07-17',
    });
    expect(r.ready).toBe(true); // warnings don't block
    expect(item(r, 'drafts_clear').status).toBe('warn');
    expect(item(r, 'ai_reviewed').status).toBe('warn');
    expect(item(r, 'gst_settled').status).toBe('warn');
    expect(item(r, 'tds_deposited').status).toBe('warn');
  });
});

describe('buildComplianceCalendar', () => {
  it('creates a TDS deposit deadline (7th of next month) from TDS Payable legs', () => {
    const cal = buildComplianceCalendar({
      entries: [{ date: '2026-06-15', entries: [{ debitAccount: 'Salary Expense', creditAccount: 'TDS Payable', amount: 5000 }] }],
      today: '2026-07-03',
    });
    const tds = cal.find((c) => c.kind === 'tds');
    expect(tds).toMatchObject({ period: '2026-06', due: '2026-07-07', amount: 5000, overdue: false });
  });

  it('creates GSTR-1 (11th) and GSTR-3B (20th) deadlines for months with sales, flagging overdue', () => {
    const cal = buildComplianceCalendar({
      salesBook: [{ date: '2026-06-10', taxable: 100000 }],
      today: '2026-07-15',
    });
    expect(cal.find((c) => c.kind === 'gstr1')).toMatchObject({ due: '2026-07-11', overdue: true });
    expect(cal.find((c) => c.kind === 'gstr3b')).toMatchObject({ due: '2026-07-20', overdue: false });
  });

  it('salesMonths (unfiltered) preserves prev-month GSTR deadlines across an FY boundary (B9)', () => {
    // April 5, new-FY filter: an FY-scoped salesBook no longer contains March —
    // the explicit salesMonths set (from raw invoices) must keep the deadline.
    const cal = buildComplianceCalendar({
      salesBook: [],                                     // FY-filtered: March gone
      salesMonths: new Set(['2026-03']),                 // raw invoice months
      today: '2026-04-05',
    });
    expect(cal.find((c) => c.kind === 'gstr1')).toMatchObject({ period: '2026-03', due: '2026-04-11' });
    expect(cal.find((c) => c.kind === 'gstr3b')).toMatchObject({ period: '2026-03', due: '2026-04-20' });
  });

  it('handles the December → January rollover and empty input', () => {
    const cal = buildComplianceCalendar({
      entries: [{ date: '2026-12-20', entries: [{ debitAccount: 'X', creditAccount: 'TDS Payable', amount: 1000 }] }],
      today: '2027-01-02',
    });
    expect(cal.find((c) => c.kind === 'tds').due).toBe('2027-01-07');
    expect(buildComplianceCalendar({ today: '2026-07-17' })).toEqual([]);
  });
});
