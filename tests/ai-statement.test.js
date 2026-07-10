import { describe, it, expect } from 'vitest';
import { sanitizeLlmStatement } from '../functions/ai-sanitize.js';
import { statementRowsToCsv } from '../src/utils/aiParse.js';
import { parseStatementCSV } from '../src/utils/aiAccountant/reconcile.js';

const TODAY = { todayISO: '2026-07-11' };

describe('sanitizeLlmStatement — shape', () => {
  it('normalises valid rows and surfaces opening/closing balances', () => {
    const raw = {
      opening_balance: 100000,
      closing_balance: 75000,
      rows: [
        { date: '2026-04-05', description: 'NEFT ACME', ref: 'UTR1', amount: 50000, direction: 'debit', balance: 50000 },
        { date: '2026-04-10', description: 'IMPS Salary', ref: null, amount: 25000, direction: 'credit', balance: 75000 },
      ],
    };
    const r = sanitizeLlmStatement(raw, TODAY);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ date: '2026-04-05', amount: 50000, direction: 'debit', description: 'NEFT ACME', ref: 'UTR1', balance: 50000 });
    expect(r.rows[1].ref).toBe(''); // null ref → empty string
    expect(r.dropped).toBe(0);
    expect(r.warnings).toHaveLength(0);
    expect(r.openingBalance).toBe(100000);
    expect(r.closingBalance).toBe(75000);
  });

  it('takes the absolute rounded amount', () => {
    const r = sanitizeLlmStatement({ rows: [{ date: '2026-04-05', amount: -777.125, direction: 'credit', description: 'x' }] }, TODAY);
    expect(r.rows[0].amount).toBe(777.13);
  });
});

describe('sanitizeLlmStatement — drop-and-count', () => {
  it('drops bad rows individually and counts them without failing the whole import', () => {
    const raw = {
      rows: [
        { date: '2026-04-05', description: 'ok', amount: 100, direction: 'debit' },
        { date: 'not-a-date', description: 'bad date', amount: 100, direction: 'debit' },
        { date: '2026-04-06', description: 'bad dir', amount: 100, direction: 'sideways' },
        { date: '2026-04-07', description: 'zero amt', amount: 0, direction: 'credit' },
        { date: '1990-01-01', description: 'too old', amount: 100, direction: 'debit' },
        null,
      ],
    };
    const r = sanitizeLlmStatement(raw, TODAY);
    expect(r.rows).toHaveLength(1);
    expect(r.dropped).toBe(5);
    expect(r.warnings.some((w) => /Dropped 5/.test(w))).toBe(true);
  });
});

describe('sanitizeLlmStatement — hard limits', () => {
  it('throws on a non-object, no rows, or all-bad rows', () => {
    expect(() => sanitizeLlmStatement(null)).toThrow();
    expect(() => sanitizeLlmStatement({ rows: [] })).toThrow(/no transaction rows/);
    expect(() => sanitizeLlmStatement({ rows: 'nope' })).toThrow(/no transaction rows/);
    expect(() => sanitizeLlmStatement({ rows: [{ date: 'bad', amount: 1, direction: 'debit' }] }, TODAY)).toThrow(/no usable/);
  });

  it('throws when the row count is absurd (>1000)', () => {
    const rows = Array.from({ length: 1001 }, () => ({ date: '2026-04-05', amount: 1, direction: 'debit', description: 'x' }));
    expect(() => sanitizeLlmStatement({ rows }, TODAY)).toThrow(/max 1000/);
  });
});

describe('sanitizeLlmStatement — balance-tie hallucination check', () => {
  it('warns when closing does not tie to opening + net movement', () => {
    const raw = {
      opening_balance: 100000,
      closing_balance: 999999, // should be 50000 (100000 - 50000)
      rows: [{ date: '2026-04-05', amount: 50000, direction: 'debit', description: 'x' }],
    };
    const r = sanitizeLlmStatement(raw, TODAY);
    expect(r.warnings.some((w) => /tie to opening/i.test(w))).toBe(true);
  });

  it('stays quiet when the balances tie out', () => {
    const raw = {
      opening_balance: 100000,
      closing_balance: 150000,
      rows: [{ date: '2026-04-05', amount: 50000, direction: 'credit', description: 'x' }],
    };
    const r = sanitizeLlmStatement(raw, TODAY);
    expect(r.warnings).toHaveLength(0);
  });
});

describe('statementRowsToCsv → parseStatementCSV round-trip', () => {
  it('round-trips rows through canonical CSV (incl. commas/quotes in narration)', () => {
    const rows = [
      { date: '2026-04-05', description: 'NEFT, ACME "Corp"', ref: 'UTR1', amount: 50000, direction: 'debit', balance: 50000 },
      { date: '2026-04-10', description: 'IMPS Salary', ref: '', amount: 25000, direction: 'credit' },
    ];
    const csv = statementRowsToCsv(rows);
    const parsed = parseStatementCSV(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ date: '2026-04-05', amount: 50000, direction: 'debit', description: 'NEFT, ACME "Corp"', ref: 'UTR1' });
    expect(parsed[1]).toMatchObject({ date: '2026-04-10', amount: 25000, direction: 'credit' });
  });
});
