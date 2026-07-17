// ─────────────────────────────────────────────────────────────────────────────
// Expense Master reducer (pure). Owner-approved semantics (grey-area B3):
// "Payments" against expense claims = advances + payouts typed
// reimbursement/advance — the SAME movements that hit the per-employee
// `Employee: <name>` ledger account. Salary (and legacy untyped payouts, which
// the ledger books to Salary Expense) is shown in its own column so nothing
// disappears from view, and Balance finally ties to the books.
// ─────────────────────────────────────────────────────────────────────────────

export const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

const EMPLOYEE_ACCOUNT_PAYOUT_TYPES = new Set(['reimbursement', 'advance', 'advance_settlement']);
export const isEmployeeAccountPayout = (p) => EMPLOYEE_ACCOUNT_PAYOUT_TYPES.has(String(p?.payout_type || '').toLowerCase());

/**
 * @param {{ expenses?:any[], advances?:any[], payouts?:any[], employees?:any[] }} args
 * @returns {Array<{id,name,status,approved,unapproved,payments,salaryPaid,balance}>}
 */
export function buildExpenseMaster({ expenses = [], advances = [], payouts = [], employees = [] } = {}) {
  const expByEmp = {};
  expenses.forEach((e) => {
    const k = String(e.employee_id);
    if (!expByEmp[k]) expByEmp[k] = { approved: 0, unapproved: 0 };
    const amt = parseFloat(e.amount || 0);
    if (e.status === 'Approved') expByEmp[k].approved += amt;
    else if (!isExpenseExcludedStatus(e.status)) expByEmp[k].unapproved += amt; // Pending + Clarification
  });
  const sumBy = (arr, filter = () => true) => arr.reduce((m, x) => {
    if (!filter(x)) return m;
    const k = String(x.employee_id);
    m[k] = (m[k] || 0) + parseFloat(x.amount || 0);
    return m;
  }, {});
  const advByEmp = sumBy(advances);
  const reimbPayByEmp = sumBy(payouts, isEmployeeAccountPayout);          // hits the Employee: account
  const salaryPayByEmp = sumBy(payouts, (p) => !isEmployeeAccountPayout(p)); // salary + legacy untyped

  return employees
    .map((emp) => {
      const k = String(emp.id);
      const approved = expByEmp[k]?.approved || 0;
      const unapproved = expByEmp[k]?.unapproved || 0;
      const payments = (advByEmp[k] || 0) + (reimbPayByEmp[k] || 0);
      const salaryPaid = salaryPayByEmp[k] || 0;
      return { id: emp.id, name: emp.name || '—', status: emp.status || '', approved, unapproved, payments, salaryPaid, balance: payments - approved };
    })
    .filter((r) => r.approved || r.unapproved || r.payments || r.salaryPaid)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
