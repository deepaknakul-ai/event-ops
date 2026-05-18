import { describe, it, expect } from 'vitest';
import { reconcile, parseStatementCSV } from '../src/utils/aiAccountant/reconcile.js';

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
