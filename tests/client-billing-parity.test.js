// Parity guard: functions/client-billing.cjs is a VERBATIM port of
// src/utils/clientBilling.js (plus the src/utils/helpers.js functions the server
// lacked). The server CANNOT import the ESM module, yet getPortalData and
// processDueReminders must answer "what has this client been billed?" exactly as
// the public ledger does — the whole point of the change. If this test fails, the
// client source moved and the port must be updated to match.
import { describe, expect, it } from 'vitest';
import {
  buildClientBillingRows as origRows,
  buildClientInvoiceList as origList,
  summariseClientBilling as origSummary,
} from '../src/utils/clientBilling.js';
import {
  getProjectGrandTotal as origGrandTotal,
  getProjectGSTBreakdown as origBreakdown,
  getLogisticsLines as origLogisticsLines,
  reimbursablesInvoicedFor as origReimbInvoiced,
  isActiveTaxInvoice as origActive,
  getProjectInvoiceReference as origInvoiceRef,
  toNum as origToNum,
} from '../src/utils/helpers.js';
import ported from '../functions/client-billing.cjs';

const {
  buildClientBillingRows: portRows,
  buildClientInvoiceList: portList,
  summariseClientBilling: portSummary,
  getProjectGrandTotal: portGrandTotal,
  getProjectGSTBreakdown: portBreakdown,
  getLogisticsLines: portLogisticsLines,
  reimbursablesInvoicedFor: portReimbInvoiced,
  isActiveTaxInvoice: portActive,
  getProjectInvoiceReference: portInvoiceRef,
  toNum: portToNum,
} = ported;

// ── Fixture — shaped after real production data, exercising every branch ──────
const makeFixture = () => ({
  clientId: 'c1',
  projects: [
    // Covered by a tax-invoice DOCUMENT → superseded, must not appear on its own
    { id: 'p1', client_id: 'c1', project_name: 'Chennai Show LED', status: 'Completed', end_date: '2026-05-02',
      invoice_status: 'Invoiced', invoice_no: 'gst 26-27/009', invoice_date: '2026-07-17',
      items: [{ item_name: 'LED', amount: 120000, total: 141600, gst_rate: 18 }],
      logistics_costs: { transport: { amount: 15000, gst: 0 }, accommodation: { amount: 6000, gst: 0 } } },
    // STAMP only — no document anywhere (the case the portal could not see)
    { id: 'p2', client_id: 'c1', project_name: 'IEW 2026', status: 'Completed', end_date: '2026-01-25',
      invoice_status: 'Invoiced', invoice_no: 'GST25-26/41', invoice_date: '2026-02-09',
      package_cost: 2050000, package_cost_gst: 18 },
    // Same stamp as p2 → must group with it
    { id: 'p3', client_id: 'c1', project_name: 'Plast India', status: 'Closed', end_date: '2026-02-03',
      invoice_status: 'Clubbed Invoice', invoice_no: 'GST25-26/41', invoice_date: '2026-02-09',
      items: [{ item_name: 'Screens', amount: 100000, total: 118000, gst_rate: 18 }],
      logistics_costs: { transport: { lines: [{ amount: 6000, gst: 0 }, { amount: 4000, gst: 5 }] } } },
    // Delivered, never invoiced
    { id: 'p4', client_id: 'c1', project_name: 'Philips Awarss', status: 'Completed', end_date: '2026-07-20',
      items: [{ item_name: 'Audio', amount: 41559.32, total: 49040, gst_rate: 18 }],
      reimbursable_expenses: [
        { id: 'r1', amount: 6400, description: 'Excess baggage', date: '2026-07-21', proof_url: 'p://1' },
        { id: 'r2', amount: '1,600', description: 'Local transport', date: '2026-07-22' },
      ] },
    // Mixed-rate package — exercises the rate-wise split
    { id: 'p5', client_id: 'c1', project_name: 'Mixed Package', status: 'Completed', end_date: '2026-06-01',
      package_cost: 90000, package_cost_gst: 18,
      items: [{ item_name: 'A', amount: 50000, gst_rate: 18 }, { item_name: 'B', amount: 25000, gst_rate: 5 }],
      logistics_costs: { travel: { amount: 5000, gst: 0 } } },
    // Zero-rated package, no item mix → must stay 0%, never `|| 18`
    { id: 'p6', client_id: 'c1', project_name: 'Exempt Job', status: 'Completed', end_date: '2026-06-10',
      package_cost: 40000, package_cost_gst: 0 },
    // Not delivered / cancelled / another client — none may appear
    { id: 'p7', client_id: 'c1', project_name: 'In Flight', status: 'Confirmed', end_date: '2026-09-01',
      items: [{ item_name: 'X', amount: 1000, total: 1180, gst_rate: 18 }] },
    { id: 'p8', client_id: 'c1', project_name: 'Yashobhumi', status: 'Cancelled', end_date: '2026-04-01',
      items: [{ item_name: 'Y', amount: 1000000, total: 1180000, gst_rate: 18 }] },
    { id: 'p9', client_id: 'c2', project_name: 'Someone Else', status: 'Completed', end_date: '2026-04-01',
      items: [{ item_name: 'Z', amount: 9999, total: 11798.82, gst_rate: 18 }] },
    // Reimbursables partly absorbed by an invoice → remainder must survive
    { id: 'p10', client_id: 'c1', project_name: 'Mumbai', status: 'Completed', end_date: '2026-05-20',
      invoice_status: 'Invoiced', invoice_no: 'gst 26-27/009', invoice_date: '2026-07-17',
      items: [{ item_name: 'Kit', amount: 190000, total: 224200, gst_rate: 18 }],
      reimbursable_expenses: [
        { id: 'r3', amount: 4000, description: 'hotel extra hours', date: '2026-05-21' },
        { id: 'r4', amount: 2500, description: 'late checkout', date: '2026-05-22' },
      ] },
  ],
  taxInvoices: [
    { invoice_no: 'gst 26-27/009', client_id: 'c1', status: 'Active', invoice_date: '2026-07-17',
      project_ids: ['p1', 'p10'], project_names: ['Chennai Show LED', 'Mumbai'],
      final_amount: 1044300, computed_total: 1039440, sale_company_id: 'co1',
      reimbursables_included: true, reimbursable_by_project: { p10: 4000 } },
    { invoice_no: 'GST26-27/077', client_id: 'c1', status: 'Cancelled', invoice_date: '2026-06-01',
      project_ids: ['p4'], final_amount: 99999 },
    { invoice_no: 'OTHER/1', client_id: 'cX', status: 'Active', invoice_date: '2026-06-02', final_amount: 12345 },
  ],
  payments: [{ amount: 3930000 }, { amount: '2,00,000' }],
});

describe('client-billing.cjs ↔ clientBilling.js parity', () => {
  const fx = makeFixture();
  const args = { clientId: fx.clientId, projects: fx.projects, taxInvoices: fx.taxInvoices };

  it('buildClientBillingRows returns deep-equal rows', () => {
    const a = origRows(args);
    const b = portRows(args);
    expect(a.length).toBeGreaterThan(3); // fixture must actually exercise the thing
    expect(b).toEqual(a);
  });

  it('summariseClientBilling returns deep-equal totals', () => {
    expect(portSummary(portRows(args), fx.payments)).toEqual(origSummary(origRows(args), fx.payments));
  });

  it('buildClientInvoiceList returns deep-equal invoices', () => {
    const a = origList(origRows(args));
    expect(a.length).toBeGreaterThan(1);
    expect(portList(portRows(args))).toEqual(a);
  });

  it('the ported helpers agree project-by-project', () => {
    fx.projects.forEach((p) => {
      expect(portGrandTotal(p)).toBe(origGrandTotal(p));
      expect(portBreakdown(p, '', '')).toEqual(origBreakdown(p, '', ''));
      expect(portBreakdown(p, '07ABCDE1234F1Z5', '07ZYXWV9876G1A2')).toEqual(origBreakdown(p, '07ABCDE1234F1Z5', '07ZYXWV9876G1A2'));
      expect(portInvoiceRef(p)).toEqual(origInvoiceRef(p));
      expect(portReimbInvoiced(p.id, fx.taxInvoices)).toBe(origReimbInvoiced(p.id, fx.taxInvoices));
      Object.entries(p.logistics_costs || {}).forEach(([k, rec]) => {
        expect(portLogisticsLines(k, k, rec)).toEqual(origLogisticsLines(k, k, rec));
      });
    });
  });

  it('the ported scalars agree on the awkward inputs', () => {
    for (const v of [0, 18, null, undefined, '', '1,500', '₹ 2,400', 'abc', NaN, Infinity, -12.5, '  7 ']) {
      expect(portToNum(v)).toBe(origToNum(v));
    }
    for (const s of ['Cancelled', 'cancelled', '  Voided ', 'void', 'Rejected', 'Active', '', null, undefined]) {
      expect(portActive(s)).toBe(origActive(s));
    }
  });

  it('agrees on an empty client (no projects, no invoices)', () => {
    const empty = { clientId: 'zzz', projects: [], taxInvoices: [] };
    expect(portRows(empty)).toEqual(origRows(empty));
    expect(portSummary([], [])).toEqual(origSummary([], []));
  });

  it('agrees when called with no arguments at all', () => {
    expect(portRows()).toEqual(origRows());
    expect(portList()).toEqual(origList());
  });
});
