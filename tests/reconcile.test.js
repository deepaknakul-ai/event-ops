import { describe, it, expect } from 'vitest';
import { reconcile, parseStatementCSV, parseStatementCSVDetailed } from '../src/utils/aiAccountant/reconcile.js';

const JES = [
  {
    id: 'je1',
    date: '2026-04-10',
    voucher_no: 'JV-0001',
    narration: 'Payment to Acme via NEFT UTR123',
    entries: [
      { debitAccount: 'Party: Acme Corp', creditAccount: 'Bank', amount: 50000 },
    ],
  },
  {
    id: 'je2',
    date: '2026-04-12',
    voucher_no: 'JV-0002',
    narration: 'Receipt from client ClientX',
    entries: [
      { debitAccount: 'Bank', creditAccount: 'Party: ClientX', amount: 25000 },
    ],
  },
  {
    id: 'je3',
    date: '2026-04-14',
    voucher_no: 'JV-0003',
    narration: 'Travel expense',
    entries: [
      { debitAccount: 'Travel Expense', creditAccount: 'Cash', amount: 500 },
    ],
  },
];

const ROWS = [
  { date: '2026-04-10', amount: 50000, direction: 'debit',  description: 'NEFT UTR123 Acme', ref: 'UTR123' },
  { date: '2026-04-12', amount: 25000, direction: 'credit', description: 'Client X receipt' },
  { date: '2026-04-20', amount: 9999,  direction: 'debit',  description: 'Unknown wire' },
];

describe('reconcile', () => {
  it('matches statement rows to journal entries with high confidence', () => {
    const r = reconcile(ROWS, JES);
    expect(r.matches.length).toBe(2);
    const matchedIds = r.matches.map((m) => m.je.id).sort();
    expect(matchedIds).toEqual(['je1', 'je2']);
    expect(r.unmatchedRows.length).toBe(1);
    expect(r.unmatchedJVs.map((j) => j.id)).toContain('je3');
  });

  it('boosts score when UTR appears in narration', () => {
    const r = reconcile([ROWS[0]], [JES[0]]);
    expect(r.matches[0].score).toBeGreaterThan(80);
  });

  it('does not match when direction is wrong', () => {
    const wrongRow = [{ ...ROWS[0], direction: 'credit' }];
    const r = reconcile(wrongRow, [JES[0]]);
    expect(r.matches.length).toBe(0);
  });

  it('aggregate-matches split payments', () => {
    const aggRows = [{ date: '2026-04-10', amount: 3000, direction: 'debit', description: 'sum' }];
    const splitJes = [
      { id: 'a1', date: '2026-04-10', entries: [{ debitAccount: 'X', creditAccount: 'Bank', amount: 1000 }] },
      { id: 'a2', date: '2026-04-10', entries: [{ debitAccount: 'Y', creditAccount: 'Bank', amount: 2000 }] },
    ];
    const r = reconcile(aggRows, splitJes);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].aggregated).toBe(true);
    expect(r.matches[0].je.aggregateOf.sort()).toEqual(['a1', 'a2']);
  });
});

describe('parseStatementCSV', () => {
  it('parses HDFC-style CSV with debit/credit columns', () => {
    const csv = [
      'Date,Narration,Debit,Credit,Reference',
      '10/04/2026,Payment Acme,50000,,UTR123',
      '12/04/2026,Receipt ClientX,,25000,',
    ].join('\n');
    const rows = parseStatementCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe('2026-04-10');
    expect(rows[0].amount).toBe(50000);
    expect(rows[0].direction).toBe('debit');
    expect(rows[1].direction).toBe('credit');
  });

  it('parses amount + type column', () => {
    const csv = [
      'Date,Description,Amount,Type',
      '2026-04-10,Cash withdraw,1000,DR',
      '2026-04-11,Interest credit,500,CR',
    ].join('\n');
    const rows = parseStatementCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].direction).toBe('debit');
    expect(rows[1].direction).toBe('credit');
  });

  it('returns empty array for invalid input', () => {
    expect(parseStatementCSV('')).toEqual([]);
    expect(parseStatementCSV('onlyheader')).toEqual([]);
  });
});

describe('parseStatementCSVDetailed — real-world bank exports', () => {
  it('skips a multi-line bank preamble, reads a balance column, and derives opening/closing', () => {
    const csv = [
      'HDFC BANK LTD',
      'Statement of account for 50100XXXX',
      'Account Branch : KORAMANGALA',
      '',
      'Date,Narration,Chq/Ref No,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '01/04/2026,OPENING BALANCE,,,,100000.00',
      '05/04/2026,NEFT ACME CORP,UTR12345,50000.00,,50000.00',
      '10/04/2026,IMPS SALARY,,,25000.00,75000.00',
    ].join('\n');
    const d = parseStatementCSVDetailed(csv);
    expect(d.headerRowIndex).toBe(3);
    expect(d.rows).toHaveLength(2);
    expect(d.rows[0]).toMatchObject({ date: '2026-04-05', amount: 50000, direction: 'debit', ref: 'UTR12345' });
    expect(d.rows[1]).toMatchObject({ date: '2026-04-10', amount: 25000, direction: 'credit' });
    expect(d.openingBalance).toBe(100000);
    expect(d.closingBalance).toBe(75000);
    expect(d.skippedRows).toBe(0);
    expect(d.warnings.some((w) => /preamble/.test(w))).toBe(true);
    expect(d.rows[0].id).toMatch(/^2026-04-05\|debit\|50000\|/);
  });

  it('handles RFC-4180 quoted fields with embedded commas and newlines', () => {
    const csv = 'Date,Description,Amount,Type\n"2026-04-10","ACME, INC\nInvoice 5",1000,DR\n2026-04-11,Interest,500,CR';
    const rows = parseStatementCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toContain('ACME, INC');
    expect(rows[0].description).toContain('\n');
    expect(rows[0].direction).toBe('debit');
    expect(rows[1].direction).toBe('credit');
  });

  it('parses dd-MMM-yy dates, ₹/comma amounts, and trailing Cr/Dr markers', () => {
    const csv = [
      'Txn Date,Particulars,Amount',
      '05-Apr-2026,UPI to Kirana,"₹1,250.00 Dr"',
      '06-Apr-26,Refund,"₹2,00,000.00 Cr"',
    ].join('\n');
    const rows = parseStatementCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2026-04-05', amount: 1250, direction: 'debit' });
    expect(rows[1]).toMatchObject({ date: '2026-04-06', amount: 200000, direction: 'credit' });
  });

  it('treats parenthesised amounts as money-out in a single amount column', () => {
    const csv = ['Date,Details,Amount', '2026-04-10,ATM withdrawal,(1500.00)', '2026-04-11,Salary,45000.00'].join('\n');
    const rows = parseStatementCSV(csv);
    expect(rows[0]).toMatchObject({ direction: 'debit', amount: 1500 });
    expect(rows[1]).toMatchObject({ direction: 'credit', amount: 45000 });
  });

  it('gives duplicate rows distinct stable ids', () => {
    const csv = ['Date,Description,Debit,Credit', '2026-04-10,Cash,500,', '2026-04-10,Cash,500,'].join('\n');
    const rows = parseStatementCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(rows[0].id).toMatch(/#0$/);
    expect(rows[1].id).toMatch(/#1$/);
  });

  it('counts genuinely-unparseable rows as skipped but ignores summary lines', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '2026-04-10,Valid,500,',
      'Total,,500,700',
      'random note,,,',
      '2026-04-12,Another,,700',
    ].join('\n');
    const d = parseStatementCSVDetailed(csv);
    expect(d.rows).toHaveLength(2);
    expect(d.skippedRows).toBe(1);
    expect(d.warnings.some((w) => /Skipped 1 row/.test(w))).toBe(true);
  });
});
