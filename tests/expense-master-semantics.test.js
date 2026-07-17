import { describe, it, expect } from 'vitest';
import { buildExpenseMaster, isEmployeeAccountPayout } from '../src/utils/expenseMaster.js';
import { validateTransaction } from '../src/utils/aiAccountant/validator.js';

// B3 — "Payments" must mean the movements that settle expense claims (advances +
// reimbursement payouts, i.e. the Employee: ledger account), with salary shown
// separately — so the Expense Master balance ties to the books.
describe('buildExpenseMaster', () => {
  const employees = [{ id: 'e1', name: 'Rahul' }];
  const expenses = [
    { employee_id: 'e1', status: 'Approved', amount: 2000 },
    { employee_id: 'e1', status: 'Pending', amount: 700 },
    { employee_id: 'e1', status: 'Rejected', amount: 9999 }, // excluded
  ];
  const advances = [{ employee_id: 'e1', amount: 5000 }];
  const payouts = [
    { employee_id: 'e1', amount: 1500, payout_type: 'reimbursement' },
    { employee_id: 'e1', amount: 30000, payout_type: 'salary' },
    { employee_id: 'e1', amount: 4000 },                       // legacy untyped → salary bucket
  ];

  it('splits claim-settling payments from salary', () => {
    const [r] = buildExpenseMaster({ expenses, advances, payouts, employees });
    expect(r.payments).toBe(6500);          // 5000 advance + 1500 reimbursement
    expect(r.salaryPaid).toBe(34000);       // 30000 salary + 4000 untyped
    expect(r.approved).toBe(2000);
    expect(r.unapproved).toBe(700);
    expect(r.balance).toBe(4500);           // 6500 − 2000 — ties to the Employee: ledger
  });

  it('isEmployeeAccountPayout matches the ledger routing exactly', () => {
    expect(isEmployeeAccountPayout({ payout_type: 'reimbursement' })).toBe(true);
    expect(isEmployeeAccountPayout({ payout_type: 'advance' })).toBe(true);
    expect(isEmployeeAccountPayout({ payout_type: 'advance_settlement' })).toBe(true);
    expect(isEmployeeAccountPayout({ payout_type: 'salary' })).toBe(false);
    expect(isEmployeeAccountPayout({})).toBe(false);           // legacy untyped → Salary Expense
  });

  it('drops employees with zero activity and is robust to empty input', () => {
    expect(buildExpenseMaster({ employees })).toEqual([]);
    expect(buildExpenseMaster({})).toEqual([]);
  });
});

// B4 — deactivated accounts warn on posting.
describe('validator account_inactive warning', () => {
  it('warns when a leg touches a deactivated account', () => {
    const tx = validateTransaction(
      { intent: 'manual_journal', date: '2026-05-01', narration: 'x', entries: [{ debitAccount: 'Old Marketing', creditAccount: 'Cash', amount: 100 }] },
      { knownAccounts: ['Old Marketing', 'Cash'], inactiveAccounts: new Set(['Old Marketing']) }
    );
    expect((tx.issues || []).some((i) => i.code === 'account_inactive' && i.level === 'warning')).toBe(true);
  });
  it('stays silent without inactive accounts', () => {
    const tx = validateTransaction(
      { intent: 'manual_journal', date: '2026-05-01', narration: 'x', entries: [{ debitAccount: 'Rent Expense', creditAccount: 'Cash', amount: 100 }] },
      { knownAccounts: ['Rent Expense', 'Cash'], inactiveAccounts: new Set() }
    );
    expect((tx.issues || []).some((i) => i.code === 'account_inactive')).toBe(false);
  });
});
