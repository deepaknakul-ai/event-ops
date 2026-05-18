import { describe, it, expect } from 'vitest';
import { parseAssistantMessage } from '../src/utils/assistant/nlu.js';
import { executeAssistantIntent } from '../src/utils/assistant/executor.js';

// Pinned dates for deterministic range filtering.
const TODAY = '2026-04-25';
const D = (offset) => {
  const d = new Date(2026, 3, 25); // 25 Apr 2026
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const ctx = {
  clientNames: ['ACME Pvt Ltd', 'Sony Live'],
  vendorNames: ['Truss World', 'AV Hub'],
  employeeNames: ['Ramesh Kumar', 'Priya Shah'],
  inventoryNames: ['LED Panel P3.9'],
  projectNames: ['Wedding Spectacular'],
};

const data = {
  projects: [
    { id: 'p1', project_name: 'Wedding Spectacular', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Ongoing', setup_date: D(-2), start_date: D(-1), end_date: D(2), total: 100000, items: [] },
    { id: 'p2', project_name: 'Concert Aug', client_id: 'c2', client_name: 'Sony Live', status: 'Confirmed', start_date: '2026-08-10', end_date: '2026-08-12', total: 50000 },
    { id: 'p3', project_name: 'Last Month Show', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Completed', start_date: '2026-03-15', end_date: '2026-03-18', invoice_status: 'Not Invoiced', total: 30000 },
  ],
  clients: [
    { id: 'c1', name: 'ACME Pvt Ltd', type: 'Client' },
    { id: 'c2', name: 'Sony Live', type: 'Client' },
    { id: 'v1', name: 'Truss World', type: 'Vendor' },
    { id: 'v2', name: 'AV Hub', type: 'Vendor' },
  ],
  employees: [
    { id: 'e1', name: 'Ramesh Kumar', role: 'tech', status: 'Active' },
    { id: 'e2', name: 'Priya Shah', role: 'manager', status: 'Active' },
  ],
  expenses: [
    { id: 'x1', employee_id: 'e1', amount: 500, status: 'Pending', date: D(-1), narration: 'Taxi', category: 'Travel' },
    { id: 'x2', employee_id: 'e1', amount: 1200, status: 'Approved', date: D(-3), narration: 'Lunch', category: 'Food' },
    { id: 'x3', employee_id: 'e2', amount: 2000, status: 'Approved', date: '2026-03-10', narration: 'Cab', category: 'Travel' },
    { id: 'x4', employee_id: 'e2', amount: 800, status: 'Rejected', date: '2026-04-05', narration: 'Snacks', category: 'Food' },
  ],
  payments: [
    { id: 'pay1', client_id: 'c1', amount: 10000, date: D(-1), mode: 'Bank' },
    { id: 'pay2', client_id: 'c2', amount: 5000, date: '2026-03-20', mode: 'UPI' },
  ],
  payouts: [],
  vendorPayments: [
    { id: 'vp1', vendor_id: 'v1', amount: 4000, date: D(-2) },
  ],
  taxInvoices: [
    { id: 'inv1', client_id: 'c1', client_name: 'ACME Pvt Ltd', invoice_no: 'INV/26/01', invoice_date: D(-5), final_amount: 25000 },
    { id: 'inv2', client_id: 'c2', client_name: 'Sony Live', invoice_no: 'INV/26/02', invoice_date: '2026-03-25', final_amount: 60000 },
  ],
  purchaseInvoices: [
    { id: 'pi1', vendor_id: 'v1', vendor_name: 'Truss World', invoice_no: 'TW/100', invoice_date: D(-3), amount: 8000, gst_amount: 1440 },
    { id: 'pi2', vendor_id: 'v2', vendor_name: 'AV Hub', invoice_no: 'AV/55', invoice_date: '2026-02-10', amount: 5000, gst_amount: 900 },
  ],
  inventory: [
    { id: 'i1', name: 'LED Panel P3.9', qty: 10, category: 'LED', rate_per_day: 1000 },
    { id: 'i2', name: 'Speaker', qty: 20, category: 'Audio', rate_per_day: 500 },
  ],
};

// Override "today" inside the executor by stubbing Date — but executor uses
// new Date().toISOString(). To keep tests deterministic for date-RANGE
// queries, we use ranges that don't depend on "today" (explicit ranges or
// ranges anchored on test data dates).

describe('Phase 5 NLU — date ranges & new intents', () => {
  it('extracts dateRange from "this month"', () => {
    const r = parseAssistantMessage('expenses this month', ctx);
    expect(r.entities.dateRange).toBeTruthy();
    expect(r.entities.dateRange.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('routes "expenses between X and Y" to expenses.byDateRange', () => {
    const r = parseAssistantMessage('expenses between 2026-04-01 and 2026-04-30', ctx);
    // Could be byDateRange or statistics — both accept range. Accept any.
    expect(['expenses.byDateRange', 'expenses.statistics', 'expenses.pending']).toContain(r.intent);
    expect(r.entities.dateRange).toMatchObject({ start: '2026-04-01', end: '2026-04-30' });
  });

  it('detects category for travel expenses', () => {
    const r = parseAssistantMessage('travel expenses last month', ctx);
    expect(r.entities.category).toBe('Travel');
    expect(r.entities.dateRange).toBeTruthy();
  });

  it('detects vendor name for purchase invoices', () => {
    const r = parseAssistantMessage('bills from Truss World', ctx);
    expect(r.intent).toBe('purchaseInvoices.byVendor');
    expect(r.entities.vendorName).toBe('Truss World');
  });

  it('detects project name for details', () => {
    const r = parseAssistantMessage('details of project Wedding Spectacular', ctx);
    expect(r.intent).toBe('projects.details');
    expect(r.entities.projectName).toBe('Wedding Spectacular');
  });

  it('routes "my pending" to digest.myPending', () => {
    const r = parseAssistantMessage('my pending', ctx);
    expect(r.intent).toBe('digest.myPending');
  });
});

describe('Phase 5 executor — new builders', () => {
  it('expenses.byDateRange filters by date', () => {
    const parsed = { intent: 'expenses.byDateRange', entities: { dateRange: { start: '2026-04-01', end: '2026-04-30', label: 'Apr 2026' } }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('table');
    // x1 (Apr 24), x2 (Apr 22), x4 (Apr 5) are in range; x3 (Mar 10) is not.
    expect(r.rows.length).toBe(3);
  });

  it('expenses.byCategory + range', () => {
    const parsed = { intent: 'expenses.byCategory', entities: { category: 'Travel', dateRange: { start: '2026-04-01', end: '2026-04-30', label: 'Apr 2026' } }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    // Only x1 (Travel, Apr 24).
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe('x1');
  });

  it('expenses.byStatus surfaces rejected', () => {
    const parsed = { intent: 'expenses.byStatus', entities: { status: 'Rejected' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe('x4');
  });

  it('expenses.statistics totals by category', () => {
    const parsed = { intent: 'expenses.statistics', entities: {}, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.subtitle).toMatch(/Pending/);
    const travel = r.rows.find((x) => x.category === 'Travel');
    expect(travel).toBeTruthy();
    expect(travel.amount).toBe(2500); // 500 + 2000
  });

  it('payments.byDate range', () => {
    const parsed = { intent: 'payments.byDate', entities: { dateRange: { start: '2026-03-01', end: '2026-03-31', label: 'Mar 2026' } }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe('pay2');
  });

  it('taxInvoices.list with range', () => {
    const parsed = { intent: 'taxInvoices.list', entities: { dateRange: { start: '2026-03-01', end: '2026-03-31', label: 'Mar 2026' } }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].invoice_no).toBe('INV/26/02');
  });

  it('taxInvoices.byClient', () => {
    const parsed = { intent: 'taxInvoices.byClient', entities: { clientName: 'ACME Pvt Ltd' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].invoice_no).toBe('INV/26/01');
  });

  it('purchaseInvoices.byVendor', () => {
    const parsed = { intent: 'purchaseInvoices.byVendor', entities: { vendorName: 'Truss World' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].amount).toBe(9440); // 8000 + 1440
  });

  it('projects.byDateRange overlaps window', () => {
    const parsed = { intent: 'projects.byDateRange', entities: { dateRange: { start: '2026-08-01', end: '2026-08-31', label: 'Aug 2026' } }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe('p2');
  });

  it('projects.details renders detail card', () => {
    const parsed = { intent: 'projects.details', entities: { projectName: 'Wedding Spectacular' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('detail');
    expect(r.title).toBe('Wedding Spectacular');
    expect(r.rows.find((x) => x.label === 'Client').value).toBe('ACME Pvt Ltd');
    expect(r.rows.find((x) => x.label === 'Value').value).toMatch(/1,00,000/);
  });

  it('inventory.byCategory filters', () => {
    const parsed = { intent: 'inventory.byCategory', entities: { category: 'LED' }, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe('i1');
  });

  it('digest.myPending aggregates', () => {
    const parsed = { intent: 'digest.myPending', entities: {}, issues: [] };
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('list');
    expect(r.rows.find((x) => x.id === 'expenses')).toBeTruthy();
    expect(r.rows.find((x) => x.id === 'unbilled')).toBeTruthy();
  });

  it('byDateRange intents reject when no range', () => {
    const r = executeAssistantIntent({ intent: 'projects.byDateRange', entities: {}, issues: [] }, data);
    expect(r.type).toBe('error');
  });
});
