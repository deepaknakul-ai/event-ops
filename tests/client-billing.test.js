import { describe, it, expect } from 'vitest';
import {
  BILLING_KIND,
  buildClientBillingRows,
  buildClientInvoiceList,
  summariseClientBilling,
} from '../src/utils/clientBilling.js';

// An invoice reaches a project by TWO routes: a tax_invoices DOCUMENT (project_ids
// point back at it) or a STAMP on the project (invoice_no + invoice_status, no
// document). getPortalData and processDueReminders honoured only the first, so six
// real clients saw a NEGATIVE outstanding — their payments counted, their invoices
// did not — or a silent zero while lakhs were due. These pin both routes.

const proj = (over = {}) => ({
  id: 'p1', client_id: 'c1', project_name: 'Show One', status: 'Completed',
  end_date: '2026-03-31', items: [{ item_name: 'LED', amount: 10000, total: 11800, gst_rate: 18 }],
  ...over,
});

describe('route 1 — tax_invoices document', () => {
  const invoice = {
    invoice_no: 'INV-1', invoice_date: '2026-04-10', client_id: 'c1', status: 'Active',
    project_ids: ['p1', 'p2'], project_names: ['Show One', 'Show Two'], final_amount: 25000,
  };

  it('is ONE row for a clubbed invoice, at final_amount — not N project rows', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [proj(), proj({ id: 'p2', project_name: 'Show Two' })],
      taxInvoices: [invoice],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(BILLING_KIND.INVOICE);
    expect(rows[0].amount).toBe(25000);
    expect(rows[0].desc).toBe('Invoice INV-1: Show One, Show Two');
  });

  it('prefers final_amount over computed_total (the agreed price wins)', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1', projects: [],
      taxInvoices: [{ ...invoice, computed_total: 20000 }],
    });
    expect(rows[0].amount).toBe(25000);
  });

  it('falls back to computed_total when no final amount was entered', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1', projects: [],
      taxInvoices: [{ ...invoice, final_amount: null, computed_total: 20000 }],
    });
    expect(rows[0].amount).toBe(20000);
  });

  it('a CANCELLED invoice drops out and re-exposes the projects it covered', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1', projects: [proj()],
      taxInvoices: [{ ...invoice, status: 'Cancelled' }],
    });
    expect(rows.some((r) => r.kind === BILLING_KIND.INVOICE)).toBe(false);
    expect(rows[0].kind).toBe(BILLING_KIND.UNBILLED);
    expect(rows[0].amount).toBe(11800);
  });
});

describe('route 2 — the project-side invoice stamp (no document)', () => {
  // This is the case that was invisible. GST25-26/44 covers 33 real projects and
  // has no tax_invoices document at all.
  const stamped = (id, name, total) => proj({
    id, project_name: name, invoice_status: 'Invoiced',
    invoice_no: 'GST25-26/44', invoice_date: '2026-03-31',
    items: [{ item_name: 'Kit', amount: total / 1.18, total, gst_rate: 18 }],
  });

  it('counts a stamped project as INVOICED, not unbilled', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1', projects: [stamped('p1', 'A', 11800)], taxInvoices: [],
    });
    expect(rows[0].kind).toBe(BILLING_KIND.PROJECT_INVOICE);
    expect(rows[0].invoice_no).toBe('GST25-26/44');
    expect(rows[0].invoice_status).toBe('Invoiced');
    expect(rows[0].desc).toBe('Invoice GST25-26/44: A');
  });

  it('groups every project sharing one stamp into a single invoice line', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [stamped('p1', 'A', 11800), stamped('p2', 'B', 23600), stamped('p3', 'C', 5900)],
      taxInvoices: [],
    });
    expect(rows).toHaveLength(3); // three ledger rows…
    const list = buildClientInvoiceList(rows);
    expect(list).toHaveLength(1); // …but ONE invoice
    expect(list[0]).toMatchObject({ invoice_no: 'GST25-26/44', amount: 41300, projects: 3, source: 'stamp' });
  });

  it('recognises the clubbed-invoice status variants the app writes', () => {
    for (const st of ['Invoiced', 'invoiced', 'Clubbed Invoice', 'clubbed invoiced']) {
      const rows = buildClientBillingRows({
        clientId: 'c1', projects: [stamped('p1', 'A', 11800)].map((p) => ({ ...p, invoice_status: st })), taxInvoices: [],
      });
      expect(rows[0].kind).toBe(BILLING_KIND.PROJECT_INVOICE);
    }
  });

  it('a stamp with no invoice number is NOT invoiced', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1', projects: [{ ...stamped('p1', 'A', 11800), invoice_no: '   ' }], taxInvoices: [],
    });
    expect(rows[0].kind).toBe(BILLING_KIND.UNBILLED);
  });

  it('a document WINS over the stamp — never counted twice', () => {
    // Real shape: gst 26-27/009 both exists as a document AND is stamped on its
    // 16 projects. Counting both would double the client's balance.
    const p = stamped('p1', 'A', 11800);
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [p],
      taxInvoices: [{ invoice_no: 'X', client_id: 'c1', status: 'Active', project_ids: ['p1'], final_amount: 12000 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(BILLING_KIND.INVOICE);
    expect(rows[0].amount).toBe(12000);
  });
});

describe('what never reaches the ledger', () => {
  it('a project belonging to another client', () => {
    expect(buildClientBillingRows({ clientId: 'c1', projects: [proj({ client_id: 'c2' })] })).toHaveLength(0);
  });

  it('a Cancelled or still-running project', () => {
    for (const status of ['Cancelled', 'Confirmed', 'Quoted', 'Ongoing']) {
      expect(buildClientBillingRows({ clientId: 'c1', projects: [proj({ status })] })).toHaveLength(0);
    }
  });

  it('an invoice carrying a DIFFERENT client_id (defensive — callers pre-scope)', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1', projects: [],
      taxInvoices: [{ invoice_no: 'INV-9', client_id: 'cX', status: 'Active', final_amount: 5000 }],
    });
    expect(rows).toHaveLength(0);
  });
});

describe('delivered but not invoiced', () => {
  it('shows as Unbilled at the project value', () => {
    const rows = buildClientBillingRows({ clientId: 'c1', projects: [proj()], taxInvoices: [] });
    expect(rows[0].kind).toBe(BILLING_KIND.UNBILLED);
    expect(rows[0].amount).toBe(11800);
    expect(rows[0].desc).toBe('Unbilled: Show One (completed — awaiting invoice)');
    expect(rows[0].invoice_no).toBe('—');
  });

  it('is kept OUT of the invoice list — there is no invoice to chase', () => {
    const rows = buildClientBillingRows({ clientId: 'c1', projects: [proj()], taxInvoices: [] });
    expect(buildClientInvoiceList(rows)).toHaveLength(0);
  });

  it('uses the package cost when one is set (package supersedes items)', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [proj({ package_cost: 50000, package_cost_gst: 18, items: [] })],
      taxInvoices: [],
    });
    expect(rows[0].amount).toBe(59000);
  });

  it('respects a 0% package rate instead of defaulting to 18%', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [proj({ package_cost: 50000, package_cost_gst: 0, items: [] })],
      taxInvoices: [],
    });
    expect(rows[0].amount).toBe(50000);
  });
});

describe('reimbursables — on the invoice OR the ledger, never both', () => {
  const withReimb = proj({
    reimbursable_expenses: [
      { id: 'r1', amount: 6400, description: 'Excess baggage', date: '2026-03-17', proof_url: 'u1' },
      { id: 'r2', amount: 1600, description: 'Local transport', date: '2026-03-18' },
    ],
  });

  it('carries them as their own rows, dated by the expense, with proof', () => {
    const rows = buildClientBillingRows({ clientId: 'c1', projects: [withReimb], taxInvoices: [] });
    const r = rows.filter((x) => x.kind === BILLING_KIND.REIMBURSABLE);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ amount: 6400, date: '2026-03-17', proof_url: 'u1' });
    expect(r[0].desc).toBe('Reimbursable: Excess baggage (Show One)');
  });

  it('drops them entirely once an invoice absorbed the lot', () => {
    const inv = {
      invoice_no: 'INV-1', client_id: 'c1', status: 'Active', project_ids: ['p1'], final_amount: 20000,
      reimbursables_included: true, reimbursable_by_project: { p1: 8000 },
    };
    const rows = buildClientBillingRows({ clientId: 'c1', projects: [withReimb], taxInvoices: [inv] });
    expect(rows.filter((x) => x.kind === BILLING_KIND.REIMBURSABLE)).toHaveLength(0);
  });

  it('leaves the remainder outstanding when the invoice absorbed only part', () => {
    const inv = {
      invoice_no: 'INV-1', client_id: 'c1', status: 'Active', project_ids: ['p1'], final_amount: 20000,
      reimbursables_included: true, reimbursable_by_project: { p1: 6400 },
    };
    const rows = buildClientBillingRows({ clientId: 'c1', projects: [withReimb], taxInvoices: [inv] });
    const r = rows.filter((x) => x.kind === BILLING_KIND.REIMBURSABLE);
    expect(r).toHaveLength(1); // the 6,400 was consumed oldest-first
    expect(r[0].amount).toBe(1600);
  });

  it('a cancelled invoice makes them recoverable again', () => {
    const inv = {
      invoice_no: 'INV-1', client_id: 'c1', status: 'Cancelled', project_ids: ['p1'],
      reimbursables_included: true, reimbursable_by_project: { p1: 8000 },
    };
    const rows = buildClientBillingRows({ clientId: 'c1', projects: [withReimb], taxInvoices: [inv] });
    expect(rows.filter((x) => x.kind === BILLING_KIND.REIMBURSABLE)).toHaveLength(2);
  });
});

describe('summariseClientBilling', () => {
  const rows = buildClientBillingRows({
    clientId: 'c1',
    projects: [
      proj({ id: 'p1', invoice_status: 'Invoiced', invoice_no: 'GST/44', invoice_date: '2026-03-31' }),
      proj({ id: 'p2', project_name: 'Show Two' }), // delivered, not invoiced
      proj({ id: 'p3', project_name: 'Show Three', items: [], reimbursable_expenses: [{ id: 'r', amount: 500 }] }),
    ],
    taxInvoices: [{ invoice_no: 'INV-1', client_id: 'c1', status: 'Active', project_ids: ['pX'], final_amount: 100000 }],
  });

  it('splits the total three ways and nets off payments', () => {
    const s = summariseClientBilling(rows, [{ amount: 50000 }, { amount: '1,000' }]);
    expect(s.invoiced).toBe(111800);      // 100,000 invoice + 11,800 stamped
    expect(s.unbilled).toBe(11800);
    expect(s.reimbursable).toBe(500);
    expect(s.billed).toBe(124100);
    expect(s.received).toBe(51000);       // tolerates the string "1,000"
    expect(s.outstanding).toBe(73100);
  });

  it('is all zeroes for a client with nothing', () => {
    expect(summariseClientBilling([], [])).toMatchObject({ billed: 0, received: 0, outstanding: 0 });
  });

  it('goes NEGATIVE only when the client has genuinely overpaid', () => {
    // The old portal produced −28.8 lakh for a client who owed 30 lakh, because it
    // counted payments against invoices it could not see. A real credit balance is
    // the only thing that should ever show negative.
    const s = summariseClientBilling(rows, [{ amount: 200000 }]);
    expect(s.outstanding).toBeLessThan(0);
  });
});

describe('buildClientInvoiceList', () => {
  it('lists documents and stamped groups together, newest first', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [
        proj({ id: 'p1', invoice_status: 'Invoiced', invoice_no: 'GST/41', invoice_date: '2026-02-09' }),
        proj({ id: 'p2', invoice_status: 'Invoiced', invoice_no: 'GST/44', invoice_date: '2026-03-31' }),
      ],
      taxInvoices: [{ invoice_no: 'GST/009', client_id: 'c1', status: 'Active', invoice_date: '2026-07-17', project_ids: ['pX'], final_amount: 1044300 }],
    });
    expect(buildClientInvoiceList(rows).map((i) => i.invoice_no)).toEqual(['GST/009', 'GST/44', 'GST/41']);
  });

  it('dates a stamped group by its earliest project stamp', () => {
    const rows = buildClientBillingRows({
      clientId: 'c1',
      projects: [
        proj({ id: 'p1', invoice_status: 'Invoiced', invoice_no: 'G/1', invoice_date: '2026-03-31' }),
        proj({ id: 'p2', invoice_status: 'Invoiced', invoice_no: 'G/1', invoice_date: '2026-01-05' }),
      ],
      taxInvoices: [],
    });
    expect(buildClientInvoiceList(rows)[0].date).toBe('2026-01-05');
  });
});
