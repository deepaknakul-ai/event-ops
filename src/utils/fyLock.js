// c:\APP\temp\rental-ops\src\utils\fyLock.js
// C-2 fix: Centralized FY-lock enforcement so every write path validates,
// not just Finance.jsx. Wire into TaxInvoices, Expenses, PurchaseInvoices,
// Accounting JV post, RecurringEntries, Projects vendor invoices, and
// Projects reimbursable expenses.
//
// Shape of lockedFYs: array of FY strings like '2024-25' (matches getFYFromDate format).

import { getFYFromDate } from './helpers';
import { notify } from './toast';

/**
 * Returns true when the given date falls inside a locked FY.
 */
export const isFYLocked = (dateStr, lockedFYs = []) => {
  if (!dateStr || !Array.isArray(lockedFYs) || lockedFYs.length === 0) return false;
  const fy = getFYFromDate(dateStr);
  return lockedFYs.includes(fy);
};

/**
 * Throws (or returns false + alerts) when the date is in a locked FY.
 * Use as: `if (!assertFYNotLocked(date, lockedFYs)) return;`
 */
export const assertFYNotLocked = (dateStr, lockedFYs = [], opts = {}) => {
  const { alertFn = (msg) => { if (typeof alert === 'function') notify(msg, 'info'); } } = opts;
  if (!isFYLocked(dateStr, lockedFYs)) return true;
  const fy = getFYFromDate(dateStr);
  alertFn(`Cannot save: financial year ${fy} is locked. Unlock it from Admin → FY Locking before posting backdated entries.`);
  return false;
};
