import { describe, it, expect } from 'vitest';
import { parseAssistantMessage } from '../src/utils/assistant/nlu.js';
import { executeAssistantIntent } from '../src/utils/assistant/executor.js';

const ctx = {
  clientNames: ['ACME Pvt Ltd', 'Sony Live', 'Tata Events'],
  employeeNames: ['Ramesh Kumar', 'Priya Shah'],
  inventoryNames: ['LED Panel P3.9', 'Line Array'],
};

const data = {
  projects: [
    { id: 'p1', project_name: 'Wedding', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Ongoing', setup_date: iso(-1), start_date: iso(0), end_date: iso(1) },
    { id: 'p2', project_name: 'Concert', client_id: 'c2', client_name: 'Sony Live', status: 'Confirmed', start_date: iso(5), end_date: iso(6) },
    { id: 'p3', project_name: 'Launch', client_id: 'c1', client_name: 'ACME Pvt Ltd', status: 'Completed', start_date: iso(-10), end_date: iso(-5), invoice_status: 'Not Invoiced', total: 50000 },
    { id: 'p4', project_name: 'Old Ongoing', client_id: 'c3', client_name: 'Tata Events', status: 'Ongoing', start_date: iso(-20), end_date: iso(-10) },
    // Project-level invoiced (legacy: no tax_invoices row, just marked on project).
    { id: 'p5', project_name: 'Showcase', client_id: 'c2', client_name: 'Sony Live', status: 'Completed', start_date: iso(-30), end_date: iso(-25), invoice_status: 'Invoiced', invoice_no: 'INV/LEGACY/01', invoice_date: iso(-24), total: 12000 },
  ],
  clients: [
    { id: 'c1', name: 'ACME Pvt Ltd', type: 'Client' },
    { id: 'c2', name: 'Sony Live', type: 'Client' },
    { id: 'c3', name: 'Tata Events', type: 'Client' },
  ],
  employees: [
    { id: 'e1', name: 'Ramesh Kumar', role: 'tech', status: 'Active' },
    { id: 'e2', name: 'Priya Shah', role: 'manager', status: 'Active' },
  ],
  expenses: [
    { id: 'x1', employee_id: 'e1', amount: 500, status: 'Pending', date: iso(-1), narration: 'Taxi', category: 'Travel' },
    { id: 'x2', employee_id: 'e1', amount: 1200, status: 'Pending', date: iso(-2), narration: 'Lunch', category: 'Food' },
    { id: 'x3', employee_id: 'e1', amount: 800, status: 'Approved', date: iso(-5), narration: 'Stay', category: 'Travel' },
    { id: 'x4', employee_id: 'e2', amount: 2000, status: 'Approved', date: iso(-3), narration: 'Cab', category: 'Travel' },
  ],
  payments: [
    { id: 'pay1', client_id: 'c1', amount: 10000, date: iso(-1), mode: 'Bank' },
  ],
  payouts: [
    { id: 'po1', employee_id: 'e1', amount: 500, date: iso(-1) },
  ],
  vendorPayments: [],
  taxInvoices: [
    { id: 'inv1', client_id: 'c1', client_name: 'ACME Pvt Ltd', invoice_no: 'INV/1', invoice_date: iso(-2), final_amount: 25000 },
  ],
  purchaseInvoices: [],
  inventory: [
    { id: 'i1', name: 'LED Panel P3.9', qty: 2, reorder_level: 10, category: 'LED', rate_per_day: 1000 },
    { id: 'i2', name: 'Line Array', qty: 50, reorder_level: 5, category: 'Audio', rate_per_day: 500 },
  ],
};

function iso(deltaDays) {
  const d = new Date();
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

describe('assistant NLU', () => {
  it('recognises today projects', () => {
    const r = parseAssistantMessage("show today's projects", ctx);
    expect(r.intent).toBe('projects.today');
    expect(r.confidence).toBeGreaterThan(0);
  });
  it('extracts client name for ledger', () => {
    const r = parseAssistantMessage('show ledger of ACME Pvt Ltd', ctx);
    expect(r.intent).toBe('client.ledger');
    expect(r.entities.clientName).toBe('ACME Pvt Ltd');
  });
  it('extracts employee name for balance', () => {
    const r = parseAssistantMessage('what is the balance of Ramesh Kumar?', ctx);
    expect(r.intent).toBe('employee.balance');
    expect(r.entities.employeeName).toBe('Ramesh Kumar');
  });
  it('flags write action for approve expenses', () => {
    const r = parseAssistantMessage('approve expenses of Ramesh Kumar', ctx);
    expect(r.intent).toBe('expenses.approve');
    expect(r.isWriteAction).toBe(true);
  });
  it('defaults to client.ledger when only client name is typed', () => {
    const r = parseAssistantMessage('ACME Pvt Ltd', ctx);
    expect(r.intent).toBe('client.ledger');
  });
  it('emits error for missing required entity', () => {
    const r = parseAssistantMessage('show ledger of', ctx);
    expect(r.intent).toBe('client.ledger');
    expect(r.issues.some((i) => i.level === 'error')).toBe(true);
  });
  it('recognises help', () => {
    expect(parseAssistantMessage('help', ctx).intent).toBe('help');
    expect(parseAssistantMessage('what can you do', ctx).intent).toBe('help');
  });
  it('recognises pending expenses', () => {
    expect(parseAssistantMessage('pending expense approvals', ctx).intent).toBe('expenses.pending');
  });
  it('recognises status filter', () => {
    const r = parseAssistantMessage('show ongoing projects', ctx);
    expect(['projects.byStatus']).toContain(r.intent);
    expect(r.entities.status).toBe('Ongoing');
  });
  it('recognises inventory low', () => {
    expect(parseAssistantMessage('low stock', ctx).intent).toBe('inventory.low');
  });
  it('recognises profit loss', () => {
    expect(parseAssistantMessage('show profit and loss', ctx).intent).toBe('reports.pl');
  });
  it('returns unknown for gibberish', () => {
    expect(parseAssistantMessage('zzxkj qwerty', ctx).intent).toBe('unknown');
  });
});

describe('assistant executor', () => {
  it('returns today projects filtering ongoing in range', () => {
    const parsed = parseAssistantMessage("today's projects", ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('list');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe('p1');
  });
  it('builds client ledger with correct outstanding', () => {
    const parsed = parseAssistantMessage('ledger of ACME Pvt Ltd', ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('table');
    // Invoiced 25000 + Unbilled 50000 − Received 10000 = 65000 outstanding.
    expect(r.subtitle).toMatch(/Outstanding.*65,000/);
  });
  it('computes employee balance = approved expenses − payouts', () => {
    const parsed = parseAssistantMessage('balance of Ramesh Kumar', ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('metric');
    // 800 approved − 500 payout = 300 owed to employee.
    expect(r.value).toMatch(/300/);
  });
  it('lists pending expenses with total', () => {
    const parsed = parseAssistantMessage('pending expenses', ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('table');
    expect(r.rows.length).toBe(2);
    expect(r.subtitle).toMatch(/1,700/);
  });
  it('returns pendingAction for approve expenses', () => {
    const parsed = parseAssistantMessage('approve expenses of Ramesh Kumar', ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('action');
    expect(r.pendingAction.kind).toBe('approve_expenses');
    expect(r.pendingAction.items.length).toBe(2);
  });
  it('flags unbilled completed projects', () => {
    const parsed = parseAssistantMessage('unbilled projects', ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('list');
    expect(r.rows.find((x) => x.id === 'p3')).toBeTruthy();
  });
  it('includes unbilled work in client ledger (rule: full picture)', () => {
    // p3 is Completed for ACME but Not Invoiced → must appear in the ledger
    // as an Unbilled line.
    const parsed = parseAssistantMessage('ledger of ACME Pvt Ltd', ctx);
    const r = executeAssistantIntent(parsed, data);
    const unbilledRow = r.rows.find((row) => String(row.type).startsWith('Unbilled'));
    expect(unbilledRow).toBeTruthy();
    expect(r.subtitle).toMatch(/Unbilled/);
  });
  it('includes project-level invoiced rows in client ledger (legacy)', () => {
    // Sony Live has p5 marked Invoiced on the project itself with no
    // tax_invoices row — must still appear in the ledger.
    const parsed = parseAssistantMessage('ledger of Sony Live', ctx);
    const r = executeAssistantIntent(parsed, data);
    const invoiceRow = r.rows.find((row) => String(row.ref).includes('INV/LEGACY/01'));
    expect(invoiceRow).toBeTruthy();
    expect(invoiceRow.amount).toBe(12000);
    expect(r.subtitle).toMatch(/Invoiced.*12,000/);
  });
  it('includes unbilled totals in outstanding receivables', () => {
    const r = executeAssistantIntent(parseAssistantMessage('outstanding receivables', ctx), data);
    expect(r.type).toBe('table');
    expect(r.columns.some((c) => c.key === 'unbilled')).toBe(true);
    // ACME row: invoiced 25000 + unbilled 50000 − received 10000 = 65000
    const acme = r.rows.find((x) => x.name === 'ACME Pvt Ltd');
    expect(acme).toBeTruthy();
    expect(acme.unbilled).toBe(50000);
  });
  it('handles client-not-found cleanly', () => {
    const parsed = parseAssistantMessage('ledger of Nonexistent Corp', ctx);
    const r = executeAssistantIntent(parsed, data);
    expect(r.type).toBe('error');
  });
  it('returns help structure', () => {
    const r = executeAssistantIntent(parseAssistantMessage('help', ctx), data);
    expect(r.type).toBe('help');
    expect(r.rows.length).toBeGreaterThan(5);
  });
  it('computes P&L', () => {
    const r = executeAssistantIntent(parseAssistantMessage('profit and loss', ctx), data);
    expect(r.type).toBe('metric');
    // Revenue 25000 − approved expenses 2800 = 22200
    expect(r.value).toMatch(/22,200/);
  });
  it('flags low inventory', () => {
    const r = executeAssistantIntent(parseAssistantMessage('low stock', ctx), data);
    expect(r.type).toBe('list');
    expect(r.rows.find((x) => x.id === 'i1')).toBeTruthy();
    expect(r.rows.find((x) => x.id === 'i2')).toBeFalsy();
  });
});
