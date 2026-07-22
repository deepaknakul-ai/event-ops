// Parity guard: functions/books-digest.cjs is a VERBATIM port of the client
// snapshot/digest builders. If this test fails, the client source changed and
// the port must be updated to match (see the header of functions/books-digest.cjs).
import { describe, expect, it } from 'vitest';
import { buildAccountingSnapshot as origSnap } from '../src/utils/accounting.js';
import { buildBooksDigest as origDigest } from '../src/utils/aiAccountant/queries.js';
import ported from '../functions/books-digest.cjs';

const { buildAccountingSnapshot: portSnap, buildBooksDigest: portDigest } = ported;

// ── Synthetic fixture — non-trivial, exercises every posting branch ──────────
const makeFixture = () => ({
  clients: [
    { id: 'c1', name: 'Acme Corp' },
    { id: 'c2', name: 'Beta Events Ltd' },
    { id: 'c3', name: 'Gamma Traders' },
  ],
  projects: [
    {
      // Invoiced via tax invoice inv-1; carries a PO with an embedded vendor invoice
      id: 'p1',
      project_name: 'Acme AV Setup',
      client_id: 'c1',
      status: 'Completed',
      end_date: '2025-06-20',
      invoice_status: 'Invoiced',
      purchase_orders: [
        {
          id: 'po1',
          po_no: 'PO-001',
          vendor_id: 'v1',
          vendor_name: 'SoundWorks',
          status: 'Approved',
          date: '2025-06-01',
          vendor_invoice: { invoice_no: 'VI-77', base_amount: 10000, gst_amount: 1800, total_amount: 11800, invoice_date: '2025-06-05' },
        },
        {
          id: 'po2',
          po_no: 'PO-002',
          vendor_id: 'v2',
          vendor_name: 'LightCo',
          status: 'Approved',
          date: '2025-06-10',
          package_cost: 5000,
          package_cost_gst: 18,
        },
      ],
    },
    {
      // Marked Invoiced on the project itself (no tax invoice) — package cost revenue
      id: 'p2',
      project_name: 'Beta Conference',
      client_id: 'c2',
      status: 'Closed',
      end_date: '2025-09-15',
      invoice_date: '2025-09-20',
      invoice_no: 'GST-25-26/042',
      invoice_status: 'Clubbed Invoice',
      package_cost: 40000,
      package_cost_gst: 18,
      purchase_orders: [],
    },
    {
      // Non-invoiced completed project — itemised revenue (items + split logistics)
      id: 'p3',
      project_name: 'Gamma Expo',
      client_id: 'c3',
      status: 'Completed',
      end_date: '2024-11-10', // prior FY 2024-25 → exercises FY filtering
      invoice_status: 'Not Invoiced',
      items: [{ total: 11800 }, { total: 5900 }],
      logistics_costs: {
        transport: { lines: [{ amount: 1000, gst: 18 }, { amount: 500, gst: 5 }] },
        crane: { amount: 2000, gst: 18 },
      },
    },
  ],
  taxInvoices: [
    {
      id: 'inv1',
      invoice_no: 'SI-0001-2025-26',
      invoice_date: '2025-06-25',
      client_id: 'c1',
      client_name: 'Acme Corp',
      taxable: 50000,
      gst_amount: 9000,
      final_amount: 59000,
      status: 'Approved',
      sale_mode: 'Credit',
      project_ids: ['p1'],
    },
    {
      // Cancelled — must be excluded from sales book AND from invoiced-project dedup
      id: 'inv2',
      invoice_no: 'SI-0002-2025-26',
      invoice_date: '2025-07-01',
      client_id: 'c3',
      client_name: 'Gamma Traders',
      taxable: 9999,
      gst_amount: 1799.82,
      status: 'Cancelled',
      project_ids: ['p3'],
    },
  ],
  purchaseInvoices: [
    {
      // Standalone PI, intra supply → Input CGST/SGST split
      id: 'pi1',
      pi_no: 'PI-0001',
      invoice_date: '2025-08-05',
      vendor_id: 'v3',
      vendor_name: 'Stage Rentals',
      amount: 12000,
      gst_amount: 2160,
      supply_type: 'intra',
      status: 'Approved',
      purchase_mode: 'Credit',
    },
    {
      // Linked to PO-002 via legacy composite key → overrides PO package cost (Tier 3)
      id: 'pi2',
      pi_no: 'PI-0002',
      invoice_date: '2025-06-18',
      vendor_id: 'v2',
      vendor_name: 'LightCo',
      amount: 5200,
      gst_amount: 936,
      linked_po_id: 'po2',
      status: 'Paid',
    },
    {
      // Draft — excluded everywhere
      id: 'pi3',
      pi_no: 'PI-0003',
      invoice_date: '2025-08-06',
      vendor_id: 'v3',
      vendor_name: 'Stage Rentals',
      amount: 700,
      gst_amount: 126,
      status: 'Draft',
    },
  ],
  payments: [
    { id: 'pay1', date: '2025-07-10', client_id: 'c1', client_name: 'Acme Corp', amount: 30000, mode: 'Bank', reference: 'NEFT-123' },
    { id: 'pay2', date: '2024-12-01', client_id: 'c3', client_name: 'Gamma Traders', amount: 5000, mode: 'Cash' }, // prior FY
  ],
  vendorPayments: [
    { id: 'vp1', date: '2025-08-20', vendor_id: 'v3', vendor_name: 'Stage Rentals', amount: 8000, mode: 'Bank', reference: 'UTR-9' },
  ],
  payouts: [
    { id: 'po_sal1', date: '2025-07-31', employee_id: 'e1', employee_name: 'Ravi Kumar', amount: 25000, mode: 'Bank' }, // legacy salary
    { id: 'po_re1', date: '2025-08-02', employee_id: 'e2', employee_name: 'Priya Singh', amount: 1200, mode: 'Cash', payout_type: 'reimbursement' },
  ],
  expenses: [
    { id: 'ex1', date: '2025-08-01', employee_id: 'e2', employee_name: 'Priya Singh', amount: 1200, category: 'Travel', status: 'Approved' },
    { id: 'ex2', date: '2025-08-03', employee_id: 'e1', employee_name: 'Ravi Kumar', amount: 999, category: 'Food', status: 'Pending' }, // excluded
  ],
  advances: [
    { id: 'adv1', date: '2025-05-05', employee_id: 'e1', employee_name: 'Ravi Kumar', amount: 4000, mode: 'Cash' },
  ],
  employees: [
    { id: 'e1', name: 'Ravi Kumar' },
    { id: 'e2', name: 'Priya Singh', previous_names: ['Priya S'] },
  ],
  chartOfAccounts: [
    { code: '1000', name: 'Cash In Hand', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr' },
    { code: '1010', name: 'Bank', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr' },
    { code: '2100', name: 'Output GST Payable', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr' },
    { code: '4000', name: 'Sales Revenue', type: 'Income', subType: 'Operating Income', normalSide: 'Cr' },
    { code: '5000', name: 'Purchase Expense', type: 'Expense', subType: 'Cost Of Goods Sold', normalSide: 'Dr' },
    { code: '5340', name: 'Bank Charges', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr' },
    { code: '1560', name: 'Software', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr' },
  ],
  openingBalances: [
    { id: 'ob1', fy: '2025-26', date: '2025-04-01', account_name: 'Bank', side: 'Dr', amount: 100000, source: 'initial_setup' },
    { id: 'ob2', fy: '2025-26', date: '2025-04-01', account_name: 'Party: Acme Corp', account_id: 'party_c1', side: 'Dr', amount: 7500, source: 'fy_rollover' }, // excluded when fyFilter='all'
    { id: 'ob3', fy: '2024-25', date: '2024-04-01', account_name: 'Capital', side: 'Cr', amount: 50000, source: 'initial_setup' },
  ],
  manualJournalEntries: [
    {
      id: 'mj1',
      voucher_no: 'JV-0001-2025-26',
      date: '2025-09-30',
      narration: 'Bank charges and TDS deduction',
      entries: [
        { debitAccount: 'Bank Charges', creditAccount: 'Bank', amount: 350 },
        { debitAccount: 'Party: Acme Corp', creditAccount: 'TDS Payable', amount: 500 },
      ],
    },
    {
      id: 'mj2',
      voucher_no: 'JV-0002-2025-26',
      date: '2025-10-05',
      remarks: 'Software purchase',
      entries: [
        { debitAccount: 'Software', creditAccount: 'Bank', amount: 15000 },
        { debitAccount: 'Software', creditAccount: 'Bank', amount: 0 }, // zero leg → skipped
      ],
    },
    {
      id: 'mj3',
      voucher_no: 'JV-0003-2025-26',
      date: '2025-10-06',
      status: 'cancelled', // excluded
      entries: [{ debitAccount: 'Bank', creditAccount: 'Capital', amount: 77777 }],
    },
  ],
  fiscalYearClosings: [],
  partyAccounts: [
    { entity_id: 'c1', current_name: 'Acme Corp', aliases: ['Acme'] },
    { entity_id: 'v3', current_name: 'Stage Rentals', previous_names: ['Stage Rentals & Co'] },
  ],
});

const snapshotFor = (fyFilter) => {
  const orig = origSnap({ ...makeFixture(), fyFilter });
  const port = portSnap({ ...makeFixture(), fyFilter });
  return { orig, port };
};

describe('books-digest.cjs parity with client source', () => {
  it('buildAccountingSnapshot matches the original (fyFilter = "all")', () => {
    const { orig, port } = snapshotFor('all');
    expect(port).toEqual(orig);
    // Guard against a trivially-empty fixture masking divergence:
    expect(orig.journal.length).toBeGreaterThan(10);
    expect(orig.ledger.length).toBeGreaterThan(8);
    expect(orig.salesBook.length).toBe(2); // inv1 + project-marked p2 (inv2 cancelled)
    expect(orig.nonInvoicedSalesBook.length).toBe(1); // p3
    expect(orig.purchaseBook.length).toBe(3); // pi1 standalone + po1 vendor-invoice + pi2-linked po2
    expect(orig.trialBalance.isBalanced).toBe(true);
  });

  it('buildAccountingSnapshot matches the original (fyFilter = "2025-26")', () => {
    const { orig, port } = snapshotFor('2025-26');
    expect(port).toEqual(orig);
    // FY filter is live: prior-FY project p3 and payment pay2 drop out,
    // and the fy_rollover opening balance ob2 comes IN for the specific FY.
    expect(orig.nonInvoicedSalesBook.length).toBe(0);
    expect(orig.journal.some((r) => r.refNo === 'NEFT-123')).toBe(true);
    expect(orig.journal.some((r) => r.refNo === 'pay2')).toBe(false);
    expect(orig.journal.some((r) => r.source === 'opening_balance' && r.refNo === 'ob2')).toBe(true);
  });

  it('buildAccountingSnapshot matches the original (fyFilter = "2024-25")', () => {
    const { orig, port } = snapshotFor('2024-25');
    expect(port).toEqual(orig);
    expect(orig.nonInvoicedSalesBook.length).toBe(1); // p3 lives here
  });

  it('buildBooksDigest matches the original over both snapshots', () => {
    const extras = {
      asOn: '2026-07-22',
      fy: 'all',
      ageing: {
        receivableTotals: { total: 12345.67, '90_plus': 111.11 },
        payableTotals: { total: 9876.54, '90_plus': 222.22 },
      },
    };
    for (const fy of ['all', '2025-26']) {
      const { orig, port } = snapshotFor(fy);
      const dOrig = origDigest(orig, { ...extras, fy });
      const dPort = portDigest(port, { ...extras, fy });
      expect(dPort).toEqual(dOrig);
      // Digest is meaningfully populated:
      expect(dOrig.accounts.length).toBeGreaterThan(5);
      expect(dOrig.receivables.length).toBeGreaterThan(0);
      expect(dOrig.payables.length).toBeGreaterThan(0);
    }
  });

  it('buildBooksDigest parity without ageing extras (aging: null branch)', () => {
    const { orig, port } = snapshotFor('all');
    const dOrig = origDigest(orig, { asOn: '2026-07-22' });
    const dPort = portDigest(port, { asOn: '2026-07-22' });
    expect(dPort).toEqual(dOrig);
    expect(dOrig.aging).toBeNull();
  });
});
