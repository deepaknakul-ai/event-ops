import { describe, it, expect } from 'vitest';
import {
  getProjectReimbursableTotal, reimbursablesInvoicedFor, getProjectUnbilledReimbursable,
} from '../src/utils/helpers.js';

// Client reimbursables are money the client repays ON TOP of the project's billing
// value. They are either absorbed into an invoice (the "Include Client Reimbursable
// Expense For Selected Show" box) or carried separately on the client's ledger —
// NEVER both. The invoice stores the AMOUNT it absorbed, not a flag, so a
// reimbursable added AFTER the invoice stays outstanding instead of vanishing.

const project = {
  id: 'p1',
  reimbursable_expenses: [
    { id: 'r1', amount: 6400, description: 'Excess baggage', date: '2026-03-17' },
    { id: 'r2', amount: 1600, description: 'Local transport', date: '2026-03-18' },
  ],
};

describe('getProjectReimbursableTotal', () => {
  it('sums the expenses', () => {
    expect(getProjectReimbursableTotal(project)).toBe(8000);
  });
  it('is 0 for a project with none', () => {
    expect(getProjectReimbursableTotal({ id: 'x' })).toBe(0);
    expect(getProjectReimbursableTotal(null)).toBe(0);
  });
  it('tolerates string amounts', () => {
    expect(getProjectReimbursableTotal({ reimbursable_expenses: [{ amount: '1,500' }] })).toBe(1500);
  });
});

describe('reimbursablesInvoicedFor — the "never both" rule', () => {
  const invoiceWith = (extra) => ({
    invoice_no: 'INV-1', status: 'Active', project_ids: ['p1'],
    reimbursables_included: true, reimbursable_amount: 8000,
    reimbursable_by_project: { p1: 8000 }, ...extra,
  });

  it('counts what an invoice absorbed', () => {
    expect(reimbursablesInvoicedFor('p1', [invoiceWith()])).toBe(8000);
    expect(getProjectUnbilledReimbursable(project, [invoiceWith()])).toBe(0);
  });

  it('ignores an invoice where the box was NOT ticked', () => {
    const inv = invoiceWith({ reimbursables_included: false });
    expect(reimbursablesInvoicedFor('p1', [inv])).toBe(0);
    expect(getProjectUnbilledReimbursable(project, [inv])).toBe(8000); // still recoverable
  });

  it('ignores a CANCELLED invoice — the reimbursable becomes recoverable again', () => {
    const inv = invoiceWith({ status: 'Cancelled' });
    expect(reimbursablesInvoicedFor('p1', [inv])).toBe(0);
    expect(getProjectUnbilledReimbursable(project, [inv])).toBe(8000);
  });

  it('ignores an invoice that does not cover this project', () => {
    expect(reimbursablesInvoicedFor('p1', [invoiceWith({ project_ids: ['other'] })])).toBe(0);
  });

  it('leaves a reimbursable added AFTER the invoice outstanding', () => {
    // Invoice absorbed 8,000; a 2,500 expense was added later.
    const later = { ...project, reimbursable_expenses: [...project.reimbursable_expenses, { id: 'r3', amount: 2500 }] };
    expect(getProjectReimbursableTotal(later)).toBe(10500);
    expect(getProjectUnbilledReimbursable(later, [invoiceWith()])).toBe(2500);
  });

  it('handles a clubbed invoice absorbing several projects', () => {
    const inv = {
      invoice_no: 'INV-C', status: 'Active', project_ids: ['p1', 'p2'],
      reimbursables_included: true, reimbursable_amount: 12000,
      reimbursable_by_project: { p1: 8000, p2: 4000 },
    };
    expect(reimbursablesInvoicedFor('p1', [inv])).toBe(8000);
    expect(reimbursablesInvoicedFor('p2', [inv])).toBe(4000);
  });

  it('never goes negative if an invoice absorbed more than now exists', () => {
    const inv = { invoice_no: 'INV-1', status: 'Active', project_ids: ['p1'], reimbursables_included: true, reimbursable_by_project: { p1: 99999 } };
    expect(getProjectUnbilledReimbursable(project, [inv])).toBe(0);
  });

  it('is 0 when there are no invoices at all', () => {
    expect(reimbursablesInvoicedFor('p1', [])).toBe(0);
    expect(getProjectUnbilledReimbursable(project, [])).toBe(8000);
  });
});
