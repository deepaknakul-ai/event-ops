import { describe, it, expect } from 'vitest';
import {
  partyLegNameSet,
  projectPartyJournalRows,
  projectOpeningBalance,
  foldPartyLedgerAdjustments,
  selectVendorProjectPOs,
  projectSharedExpenses,
  projectSharedReimbursables,
  groupClientSharedExpenses,
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

describe('selectVendorProjectPOs', () => {
  // A vendor's POs live inside OTHER clients' project_financials siblings.
  const VID = 'vendor-9';
  const finDocs = [
    { id: 'projA', data: { // another client's project — vendor-9 has a PO here
      package_cost: 500000, items: [{ rate: 1000 }], logistics_costs: { truck: 2000 }, margin: 99999,
      purchase_orders: [
        { id: 'po1', po_no: 'PO-1', vendor_id: 'vendor-9', package_cost: 10000 },
        { id: 'po2', po_no: 'PO-2', vendor_id: 'vendor-7', package_cost: 8000 },
      ] } },
    { id: 'projB', data: { purchase_orders: [{ id: 'po3', vendor_id: 'vendor-7', package_cost: 3000 }] } },
    { id: 'projOwn', data: { purchase_orders: [{ id: 'po4', vendor_id: 'vendor-9', package_cost: 4000 }] } },
  ];

  it('returns only the projects+POs where this party is the vendor', () => {
    const res = selectVendorProjectPOs(finDocs, VID, new Set());
    expect(res.map((r) => r.pid)).toEqual(['projA', 'projOwn']);
    expect(res[0].purchase_orders.map((p) => p.id)).toEqual(['po1']); // po2 (other vendor) dropped
  });

  it('excludes projects the party already owns as a client (no double-count)', () => {
    const res = selectVendorProjectPOs(finDocs, VID, new Set(['projOwn']));
    expect(res.map((r) => r.pid)).toEqual(['projA']);
  });

  it('NEVER leaks the owning client financials — only {pid, purchase_orders} come out', () => {
    const res = selectVendorProjectPOs(finDocs, VID, new Set());
    expect(Object.keys(res[0]).sort()).toEqual(['pid', 'purchase_orders']);
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('500000'); // package_cost
    expect(blob).not.toContain('99999');  // margin
    expect(blob).not.toContain('logistics');
  });

  it('accepts a plain array of client pids and tolerates empty / missing input', () => {
    expect(selectVendorProjectPOs(finDocs, VID, ['projA', 'projOwn']).map((r) => r.pid)).toEqual([]);
    expect(selectVendorProjectPOs([], VID, new Set())).toEqual([]);
    expect(selectVendorProjectPOs(null, VID, null)).toEqual([]);
  });
});

describe('projectSharedExpenses', () => {
  const raw = [
    { date: '2026-05-01', category: 'Travel', remarks: 'Cab to venue', amount: 1200, status: 'Approved',
      proof_url: 'https://fb/o/x?token=1', proof_name: 'cab.jpg',
      employee_id: 'emp-7', project_id: 'projA', proof_path: 'expense-proofs/app/x.jpg', is_general: false },
    { date: '2026-05-02', category: 'Food', remarks: 'Crew lunch', amount: 800, status: 'Pending', proof_url: '', proof_name: '' },
    { date: '2026-05-03', category: 'Misc', remarks: 'bogus', amount: 500, status: 'Rejected' },
    { date: '2026-05-04', category: 'Misc', remarks: 'nope', amount: 400, status: 'Disapproved' },
  ];

  it('keeps ALL shared rows regardless of status and maps remarks→description', () => {
    const out = projectSharedExpenses(raw);
    expect(out).toHaveLength(4); // approved, pending, rejected, disapproved all kept — admin decides
    expect(out[0]).toMatchObject({ date: '2026-05-01', category: 'Travel', description: 'Cab to venue', amount: 1200, proof_name: 'cab.jpg' });
    expect(out[3]).toMatchObject({ category: 'Misc', description: 'nope', amount: 400 });
  });

  it('NEVER leaks employee, project_id, storage path, or internal approval status', () => {
    const out = projectSharedExpenses(raw);
    expect(Object.keys(out[0]).sort()).toEqual(
      ['amount', 'category', 'date', 'description', 'proof_name', 'proof_url'].sort());
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('emp-7');
    expect(blob).not.toContain('projA');
    expect(blob).not.toContain('expense-proofs');
    expect(blob).not.toContain('Disapproved'); // internal status never surfaces
  });

  it('tolerates empty / non-array input', () => {
    expect(projectSharedExpenses([])).toEqual([]);
    expect(projectSharedExpenses(null)).toEqual([]);
  });
});

describe('projectSharedReimbursables', () => {
  const raw = [{ id: 'r1', date: '2026-05-01', description: 'Flowers', category: 'Decor', amount: 2500,
    remarks: 'internal note', proof_url: 'https://fb/o/y?token=2', proof_name: 'bill.pdf', proof_path: 'reimbursable-proofs/app/y.pdf', created_at: 'x' }];

  it('always emits amount, only emits proofs when the project is flagged', () => {
    const off = projectSharedReimbursables(raw, false);
    expect(off[0]).toEqual({ date: '2026-05-01', description: 'Flowers', category: 'Decor', amount: 2500 });
    expect(off[0].proof_url).toBeUndefined();
    const on = projectSharedReimbursables(raw, true);
    expect(on[0]).toMatchObject({ amount: 2500, proof_url: 'https://fb/o/y?token=2', proof_name: 'bill.pdf' });
  });

  it('never leaks remarks / internal id / storage path even when flagged', () => {
    const blob = JSON.stringify(projectSharedReimbursables(raw, true));
    expect(blob).not.toContain('internal note');
    expect(blob).not.toContain('reimbursable-proofs');
    expect(blob).not.toContain('r1');
  });

  it('tolerates empty / non-array input', () => {
    expect(projectSharedReimbursables(null, true)).toEqual([]);
  });
});

describe('groupClientSharedExpenses', () => {
  const CLIENT_PIDS = new Set(['pA', 'pB']);
  const docs = [
    { project_id: 'pA', status: 'Approved', shared_with_client: true, date: '2026-05-01', category: 'Travel', remarks: 'Cab', amount: 500, proof_url: 'u1', proof_name: 'c.jpg', employee_id: 'emp-1' },
    { project_id: 'pA', status: 'Approved', shared_with_client: false, category: 'Food', amount: 300 }, // not shared
    { project_id: 'pB', status: 'Pending', shared_with_client: true, category: 'Misc', amount: 200 },   // not approved
    { project_id: 'pB', status: 'Approved', shared_with_client: true, date: '2026-05-02', category: 'Stay', remarks: 'Hotel', amount: 4000, proof_url: 'u2', proof_name: 'h.pdf' },
    { project_id: 'pZ', status: 'Approved', shared_with_client: true, category: 'X', amount: 999 },      // another client's project
  ];

  it('keeps shared + client-owned expenses regardless of status, grouped by project', () => {
    const g = groupClientSharedExpenses(docs, CLIENT_PIDS);
    expect(Object.keys(g).sort()).toEqual(['pA', 'pB']);
    expect(g.pA).toHaveLength(1); // the non-shared pA row is excluded
    expect(g.pA[0]).toMatchObject({ category: 'Travel', description: 'Cab', amount: 500 });
    expect(g.pB).toHaveLength(2); // Pending + Approved, both shared → both shown (admin decides)
    expect(g.pB.map((r) => r.amount).sort((a, b) => a - b)).toEqual([200, 4000]);
  });

  it('drops another client\'s project even if shared', () => {
    const g = groupClientSharedExpenses(docs, CLIENT_PIDS);
    expect(g.pZ).toBeUndefined();
  });

  it('whitelists rows — employee id and status never survive grouping', () => {
    const g = groupClientSharedExpenses(docs, CLIENT_PIDS);
    expect(JSON.stringify(g)).not.toContain('emp-1');
    expect(Object.keys(g.pA[0]).sort()).toEqual(
      ['amount', 'category', 'date', 'description', 'proof_name', 'proof_url'].sort());
  });

  it('accepts a plain array of pids and tolerates empty input', () => {
    expect(groupClientSharedExpenses(docs, ['pA'])).toHaveProperty('pA');
    expect(groupClientSharedExpenses([], CLIENT_PIDS)).toEqual({});
    expect(groupClientSharedExpenses(null, null)).toEqual({});
  });
});

// The client PORTAL previously summed only invoices and the `payments` collection,
// while the client LEDGER also folds in party-leg journal vouchers and the opening
// balance. Same client, same day, two different balances: a ₹2,00,000 receipt
// booked as a JV instead of a payment left the portal 2 lakh too high, and a Cr
// opening balance did the same. foldPartyLedgerAdjustments is what closes that.
describe('foldPartyLedgerAdjustments', () => {
  const jvCredit = { id: 'j1', date: '2026-06-12', voucher_no: 'JV-0010-2026-27', narration: 'Payment received', source: 'chat_entry', debit: 0, credit: 200000 };

  it('is a no-op when the party has no journal legs and no opening balance', () => {
    const r = foldPartyLedgerAdjustments({ billed: 7050426.25, received: 3930000 });
    expect(r).toMatchObject({ billed: 7050426.25, received: 3930000, outstanding: 3120426.25 });
    expect(r.creditRows).toEqual([]);
    expect(r.adjustments).toMatchObject({ debit: 0, credit: 0, entries: 0, opening_balance: false });
  });

  it('folds a JV receipt into received — the real SANJEEV CHOPRA case', () => {
    const r = foldPartyLedgerAdjustments({ billed: 7050426.25, received: 3930000, journalRows: [jvCredit] });
    expect(r.received).toBe(4130000);
    expect(r.outstanding).toBe(2920426.25); // was 31,20,426.25 before the fold
    expect(r.billed).toBe(7050426.25);      // billed is untouched by a credit
  });

  it('lists the credit so `received` ties to the rows shown beneath it', () => {
    const r = foldPartyLedgerAdjustments({ billed: 100000, received: 0, journalRows: [jvCredit] });
    expect(r.creditRows).toEqual([
      { date: '2026-06-12', amount: 200000, mode: 'Journal Voucher', ref: 'JV-0010-2026-27' },
    ]);
    expect(r.creditRows.reduce((s, x) => s + x.amount, 0)).toBe(r.adjustments.credit);
  });

  it('labels each voucher type the way the ledger page does', () => {
    const rows = [
      { id: 'a', date: '2026-01-01', voucher_no: 'CN-1', source: 'credit_note', debit: 0, credit: 100 },
      { id: 'b', date: '2026-01-02', voucher_no: 'TD-1', source: 'tds_entry', debit: 0, credit: 200 },
      { id: 'c', date: '2026-01-03', voucher_no: 'JV-1', source: 'manual_journal', debit: 0, credit: 300 },
    ];
    expect(foldPartyLedgerAdjustments({ journalRows: rows }).creditRows.map((r) => r.mode))
      .toEqual(['Credit Note', 'TDS', 'Journal Voucher']);
  });

  it('a debit note increases billed and is NOT listed as a payment', () => {
    const dn = { id: 'd', date: '2026-05-01', voucher_no: 'DN-1', source: 'debit_note', debit: 15000, credit: 0 };
    const r = foldPartyLedgerAdjustments({ billed: 100000, received: 0, journalRows: [dn] });
    expect(r.billed).toBe(115000);
    expect(r.outstanding).toBe(115000);
    expect(r.creditRows).toEqual([]); // a debit note is not money in
    expect(r.adjustments.debit).toBe(15000);
  });

  it('nets a voucher that both debits and credits the same party', () => {
    const both = { id: 'e', date: '2026-05-01', voucher_no: 'JV-9', source: 'manual_journal', debit: 55000, credit: 55000 };
    const r = foldPartyLedgerAdjustments({ billed: 100000, received: 0, journalRows: [both] });
    expect(r.outstanding).toBe(100000); // nets out, as the production 55,000 pairs do
  });

  it('applies a Cr opening balance — the real NEERAJ KALKAJI case', () => {
    const ob = projectOpeningBalance({ amount: 36000, side: 'Cr', date: '2026-04-01', remarks: 'Opening balance for NEERAJ KALKAJI' });
    const r = foldPartyLedgerAdjustments({ billed: 11800, received: 0, openingBalance: ob });
    expect(r.outstanding).toBe(-24200); // a genuine credit balance, not an error
    expect(r.creditRows[0]).toMatchObject({ mode: 'Opening Balance', amount: 36000 });
    expect(r.adjustments.opening_balance).toBe(true);
  });

  it('applies a Dr opening balance to billed', () => {
    const ob = projectOpeningBalance({ amount: 50000, side: 'Dr', date: '2026-04-01' });
    const r = foldPartyLedgerAdjustments({ billed: 10000, received: 0, openingBalance: ob });
    expect(r.billed).toBe(60000);
    expect(r.creditRows).toEqual([]);
  });

  it('combines an opening balance with several vouchers, ordered OB first', () => {
    const ob = projectOpeningBalance({ amount: 5000, side: 'Cr', date: '2026-04-01' });
    const r = foldPartyLedgerAdjustments({
      billed: 100000, received: 20000, openingBalance: ob,
      journalRows: [jvCredit, { id: 'x', date: '2026-07-01', voucher_no: 'DN-2', source: 'debit_note', debit: 1000, credit: 0 }],
    });
    expect(r.billed).toBe(101000);
    expect(r.received).toBe(225000);
    expect(r.outstanding).toBe(-124000);
    expect(r.creditRows.map((x) => x.mode)).toEqual(['Opening Balance', 'Journal Voucher']);
    expect(r.adjustments).toMatchObject({ debit: 1000, credit: 205000, entries: 2, opening_balance: true });
  });

  it('survives junk input without throwing', () => {
    expect(foldPartyLedgerAdjustments()).toMatchObject({ billed: 0, received: 0, outstanding: 0 });
    expect(foldPartyLedgerAdjustments({ journalRows: null, openingBalance: null }).outstanding).toBe(0);
    expect(foldPartyLedgerAdjustments({ billed: 100, journalRows: [null, undefined] }).outstanding).toBe(100);
  });

  it('rounds to paise rather than drifting', () => {
    const r = foldPartyLedgerAdjustments({
      billed: 0.1, received: 0, journalRows: [{ id: 'r', date: '', source: 'x', debit: 0.2, credit: 0 }],
    });
    expect(r.billed).toBe(0.3);
  });
});
