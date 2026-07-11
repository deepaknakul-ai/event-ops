import { describe, it, expect } from 'vitest';
import {
  partyLegNameSet,
  projectPartyJournalRows,
  projectOpeningBalance,
} from '../functions/ledger-project.js';

describe('partyLegNameSet', () => {
  it('builds a lower-cased "party: <name>" set from client + registry names', () => {
    const set = partyLegNameSet(
      { name: 'Chopra AV' },
      { current_name: 'Chopra AV', aliases: ['Chopra Audio Visuals'] },
    );
    expect(set.has('party: chopra av')).toBe(true);
    expect(set.has('party: chopra audio visuals')).toBe(true); // renamed alias
    expect(set.has('chopra av')).toBe(false); // must carry the "party: " prefix
  });

  it('tolerates missing party_account and non-string names', () => {
    const set = partyLegNameSet({ name: '  Acme  ', aliases: [null, 42, 'Old Acme'] }, null);
    expect(set.has('party: acme')).toBe(true);   // trimmed
    expect(set.has('party: old acme')).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe('projectPartyJournalRows', () => {
  const nameSet = partyLegNameSet({ name: 'Chopra AV' }, null);

  it('projects a manual JV that DEBITS the party as a debit', () => {
    const rows = projectPartyJournalRows(
      [{ id: 'j1', date: '2026-05-01', voucher_no: 'JV-1', narration: 'Interest charged',
         source: 'manual_journal', status: 'posted',
         entries: [{ debitAccount: 'Party: Chopra AV', creditAccount: 'Interest Income', amount: 500 }] }],
      nameSet,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'j1', debit: 500, credit: 0, voucher_no: 'JV-1' });
  });

  it('projects a manual JV that CREDITS the party as a credit', () => {
    const rows = projectPartyJournalRows(
      [{ id: 'j2', date: '2026-05-02', source: 'manual_journal',
         entries: [{ debitAccount: 'Discount Allowed', creditAccount: 'Party: Chopra AV', amount: 300 }] }],
      nameSet,
    );
    expect(rows[0]).toMatchObject({ debit: 0, credit: 300 });
  });

  it('nets a credit note whose taxable + GST legs BOTH credit the party', () => {
    const rows = projectPartyJournalRows(
      [{ id: 'cn1', date: '2026-05-03', source: 'credit_note', voucher_no: 'CN-1',
         entries: [
           { debitAccount: 'Sales Revenue', creditAccount: 'Party: Chopra AV', amount: 1000 },
           { debitAccount: 'Output GST Payable', creditAccount: 'Party: Chopra AV', amount: 180 },
         ] }],
      nameSet,
    );
    expect(rows[0]).toMatchObject({ source: 'credit_note', debit: 0, credit: 1180 });
  });

  it('NEVER leaks the contra account — only date/voucher/narration/debit/credit are emitted', () => {
    const rows = projectPartyJournalRows(
      [{ id: 'j3', date: '2026-05-04', source: 'manual_journal',
         entries: [{ debitAccount: 'Bad Debts Written Off', creditAccount: 'Party: Chopra AV', amount: 999 }] }],
      nameSet,
    );
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['credit', 'date', 'debit', 'id', 'narration', 'source', 'voucher_no'].sort(),
    );
    expect(JSON.stringify(rows[0])).not.toContain('Bad Debts');
  });

  it('drops cancelled docs and JVs that do not touch the party', () => {
    const rows = projectPartyJournalRows(
      [
        { id: 'c', status: 'cancelled', source: 'manual_journal',
          entries: [{ debitAccount: 'Party: Chopra AV', creditAccount: 'Cash', amount: 100 }] },
        { id: 'other', source: 'manual_journal',
          entries: [{ debitAccount: 'Rent', creditAccount: 'Cash', amount: 100 }] },
      ],
      nameSet,
    );
    expect(rows).toHaveLength(0);
  });

  it('matches a leg posted under a since-renamed alias', () => {
    const set = partyLegNameSet({ name: 'Chopra AV' }, { current_name: 'Chopra AV', aliases: ['Chopra Sound'] });
    const rows = projectPartyJournalRows(
      [{ id: 'j4', date: '2026-05-05', source: 'tds_entry',
         entries: [{ debitAccount: 'TDS Receivable', creditAccount: 'Party: Chopra Sound', amount: 250 }] }],
      set,
    );
    expect(rows[0]).toMatchObject({ credit: 250, source: 'tds_entry' });
  });

  it('ties out: sum(debit − credit) equals the party net movement across docs', () => {
    const rows = projectPartyJournalRows(
      [
        { id: 'a', source: 'manual_journal', entries: [{ debitAccount: 'Party: Chopra AV', creditAccount: 'X', amount: 1000 }] },
        { id: 'b', source: 'credit_note', entries: [{ debitAccount: 'X', creditAccount: 'Party: Chopra AV', amount: 400 }] },
      ],
      nameSet,
    );
    const net = rows.reduce((s, r) => s + r.debit - r.credit, 0);
    expect(net).toBe(600); // 1000 Dr − 400 Cr
  });

  it('returns nothing when the name set is empty (no party identity)', () => {
    expect(projectPartyJournalRows([{ id: 'x', entries: [{ debitAccount: 'Party: Chopra AV', creditAccount: 'Y', amount: 5 }] }], new Set())).toEqual([]);
  });
});

describe('projectOpeningBalance', () => {
  it('maps a Dr opening balance to a debit row', () => {
    expect(projectOpeningBalance({ amount: 5000, side: 'Dr', date: '2025-04-01', remarks: 'OB' }))
      .toEqual({ date: '2025-04-01', remarks: 'OB', debit: 5000, credit: 0 });
  });

  it('maps a Cr opening balance to a credit row', () => {
    expect(projectOpeningBalance({ amount: 5000, side: 'Cr', date: '2025-04-01' }))
      .toMatchObject({ debit: 0, credit: 5000 });
  });

  it('falls back to the FY-start date when no date is stored', () => {
    expect(projectOpeningBalance({ amount: 100, side: 'Dr', fy: '2025-26' }).date).toBe('2025-04-01');
  });

  it('returns null for missing / zero / negative balances', () => {
    expect(projectOpeningBalance(null)).toBeNull();
    expect(projectOpeningBalance({ amount: 0, side: 'Dr' })).toBeNull();
    expect(projectOpeningBalance({ amount: -10, side: 'Dr' })).toBeNull();
  });
});
