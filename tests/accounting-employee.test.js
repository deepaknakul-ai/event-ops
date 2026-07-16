import { describe, it, expect } from 'vitest';
import { buildAccountingSnapshot } from '../src/utils/accounting.js';

// First coverage of the employee expense → per-employee payable → payout derivation.
const bal = (ledger, name) => {
  const r = ledger.find((x) => x.account === name);
  return r ? r.balance : 0;
};
const empRows = (ledger) => ledger.filter((r) => r.account.startsWith('Employee:'));

const EMP = [{ id: 'e1', name: 'Rahul' }];
const approvedExpense = (over = {}) => ({
  id: 'x1', status: 'Approved', date: '2026-05-01', employee_id: 'e1', employee_name: 'Rahul', category: 'Travel', amount: 2000, ...over,
});

describe('buildAccountingSnapshot — per-employee reimbursement account', () => {
  it('an approved expense credits the employee account and surfaces as a liability', () => {
    const snap = buildAccountingSnapshot({ employees: EMP, expenses: [approvedExpense()], fyFilter: 'all' });
    expect(bal(snap.ledger, 'Employee: Rahul')).toBe(-2000); // Cr = we owe the employee
    expect(bal(snap.ledger, 'Expense:Travel')).toBe(2000);
    expect(snap.balanceSheet.liabilities.employeePayable).toBe(2000);
    expect(snap.balanceSheet.assets.employeeAdvances).toBe(0);
    // Reimbursement Payable / Employee Payable are retired — never posted to now.
    expect(snap.ledger.find((r) => r.account === 'Reimbursement Payable')).toBeFalsy();
  });

  it('a reimbursement payout clears the employee account to zero', () => {
    const snap = buildAccountingSnapshot({
      employees: EMP,
      expenses: [approvedExpense()],
      payouts: [{ id: 'p1', date: '2026-05-05', employee_id: 'e1', employee_name: 'Rahul', amount: 2000, mode: 'Cash', payout_type: 'reimbursement' }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Employee: Rahul')).toBe(0);
    expect(snap.balanceSheet.liabilities.employeePayable).toBe(0);
    expect(bal(snap.ledger, 'Salary Expense')).toBe(0); // NOT salary — this is a reimbursement
  });

  it('an advance debits the employee account (they owe us) → an asset', () => {
    const snap = buildAccountingSnapshot({
      employees: EMP,
      advances: [{ id: 'a1', date: '2026-05-01', employee_id: 'e1', employee_name: 'Rahul', amount: 5000 }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Employee: Rahul')).toBe(5000);
    expect(snap.balanceSheet.assets.employeeAdvances).toBe(5000);
    expect(snap.balanceSheet.liabilities.employeePayable).toBe(0);
  });

  it('advance + reimbursement net into a single running balance per employee', () => {
    const snap = buildAccountingSnapshot({
      employees: EMP,
      advances: [{ id: 'a1', date: '2026-05-01', employee_id: 'e1', employee_name: 'Rahul', amount: 5000 }],
      expenses: [approvedExpense({ amount: 2000 })],
      fyFilter: 'all',
    });
    // 5000 advance (Dr) − 2000 reimbursement owed (Cr) = 3000 net receivable
    expect(bal(snap.ledger, 'Employee: Rahul')).toBe(3000);
    expect(empRows(snap.ledger)).toHaveLength(1); // ONE account per employee
    expect(snap.balanceSheet.assets.employeeAdvances).toBe(3000);
  });

  it('a chat manual entry crediting "Employee: <name>" (name only) merges into the id-keyed row', () => {
    const snap = buildAccountingSnapshot({
      employees: EMP,
      expenses: [approvedExpense({ amount: 2000 })], // Cr Employee: Rahul with emp_e1
      manualJournalEntries: [{ id: 'j1', date: '2026-05-02', entries: [{ debitAccount: 'Food Expense', creditAccount: 'Employee: Rahul', amount: 500 }] }],
      fyFilter: 'all',
    });
    expect(empRows(snap.ledger)).toHaveLength(1); // merged, not duplicated
    expect(bal(snap.ledger, 'Employee: Rahul')).toBe(-2500); // 2000 + 500 owed
  });

  it('a legacy payout with no payout_type still books to Salary Expense (history unchanged)', () => {
    const snap = buildAccountingSnapshot({
      employees: EMP,
      payouts: [{ id: 'p2', date: '2026-05-05', employee_id: 'e1', employee_name: 'Rahul', amount: 3000, mode: 'Bank' }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Salary Expense')).toBe(3000);
    expect(empRows(snap.ledger)).toHaveLength(0); // no per-employee account touched
  });

  it('an advance paid via Finance debits the employee account, not Salary Expense', () => {
    const snap = buildAccountingSnapshot({
      employees: EMP,
      payouts: [{ id: 'p3', date: '2026-05-10', employee_id: 'e1', employee_name: 'Rahul', amount: 5000, mode: 'Cash', payout_type: 'advance' }],
      fyFilter: 'all',
    });
    expect(bal(snap.ledger, 'Employee: Rahul')).toBe(5000); // Dr — employee owes us
    expect(bal(snap.ledger, 'Salary Expense')).toBe(0);
    expect(snap.balanceSheet.assets.employeeAdvances).toBe(5000);
  });
});
