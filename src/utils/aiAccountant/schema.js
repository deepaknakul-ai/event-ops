// ─────────────────────────────────────────────────────────────────────────────
// Canonical Transaction schema for the AI Accountant pipeline.
// All NLU parsers output an object shaped like this, and all downstream
// stages (validator, executor, UI) consume this shape and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'Dr'|'Cr'} Side
 *
 * @typedef {Object} JournalLine
 * @property {string} debitAccount
 * @property {string} creditAccount
 * @property {number} amount  // positive, already rounded
 *
 * @typedef {Object} PartyRef
 * @property {'client'|'vendor'|'employee'|'unknown'} type
 * @property {string} name                   // resolved canonical name
 * @property {string} [id]                   // Firestore id if resolved
 *
 * @typedef {Object} AccountCreateRequest
 * @property {string} name
 * @property {'Asset'|'Liability'|'Equity'|'Income'|'Expense'} type
 * @property {string} [subType]
 * @property {Side} normalSide
 *
 * @typedef {'info'|'warning'|'error'} IssueLevel
 *
 * @typedef {Object} Issue
 * @property {IssueLevel} level
 * @property {string} code
 * @property {string} message
 *
 * @typedef {Object} Transaction
 * @property {string} intent                 // receipt | payment | invoice | …
 * @property {string} date                   // ISO YYYY-MM-DD
 * @property {string} narration
 * @property {JournalLine[]} entries         // must balance
 * @property {PartyRef} [party]
 * @property {'Cash'|'Bank'|null} [mode]
 * @property {AccountCreateRequest[]} [accountCreates]  // accounts to auto-create
 * @property {Issue[]} [issues]              // validator output
 * @property {number} [confidence]           // 0..1
 * @property {string} [rawPrompt]            // what the user typed
 * @property {string} [model]                // 'rule-v1' | 'llm:xxx'
 * @property {Object} [meta]                 // free-form
 */

export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];

// Accounts that the rule engine may reference; each has a canonical type +
// normal side so the executor can auto-create the COA row if missing.
// Keep this list short — it's only the ones the NLU layer emits by default.
// Project-specific chart entries still override via `chartByName` lookup.
export const KNOWN_ACCOUNT_DEFAULTS = {
  // Assets
  'Cash':                        { type: 'Asset',     subType: 'Current Asset',      normalSide: 'Dr' },
  'Bank':                        { type: 'Asset',     subType: 'Current Asset',      normalSide: 'Dr' },
  'Accounts Receivable':         { type: 'Asset',     subType: 'Current Asset',      normalSide: 'Dr' },
  'Input GST Credit':            { type: 'Asset',     subType: 'Current Asset',      normalSide: 'Dr' },
  'TDS Receivable':              { type: 'Asset',     subType: 'Current Asset',      normalSide: 'Dr' },
  'Employee Advances':           { type: 'Asset',     subType: 'Current Asset',      normalSide: 'Dr' },
  // Liabilities
  'Accounts Payable':            { type: 'Liability', subType: 'Current Liability',  normalSide: 'Cr' },
  'Output GST Payable':          { type: 'Liability', subType: 'Current Liability',  normalSide: 'Cr' },
  'TDS Payable':                 { type: 'Liability', subType: 'Current Liability',  normalSide: 'Cr' },
  // Income
  'Sales Revenue':               { type: 'Income',    subType: 'Operating Income',   normalSide: 'Cr' },
  // Expenses
  'Purchase Expense':            { type: 'Expense',   subType: 'Direct Expense',     normalSide: 'Dr' },
  'Salary Expense':              { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Rent Expense':                { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Travel Expense':              { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Food Expense':                { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Utilities Expense':           { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Office Supplies Expense':     { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Repairs & Maintenance':       { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Insurance Expense':           { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Legal Expense':               { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Marketing Expense':           { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Commission Expense':          { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Freight & Logistics':         { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
  'Expense:General':             { type: 'Expense',   subType: 'Indirect Expense',   normalSide: 'Dr' },
};

/**
 * Infer the canonical type/side for an account name that is not in the
 * chart of accounts yet. Used when auto-creating.
 * @param {string} name
 * @returns {AccountCreateRequest}
 */
export function inferAccountMeta(name) {
  if (KNOWN_ACCOUNT_DEFAULTS[name]) {
    return { name, ...KNOWN_ACCOUNT_DEFAULTS[name] };
  }
  if (name.startsWith('Party: ')) {
    // Party accounts are dual-use (receivable or payable); treat as Asset by
    // default — the ledger engine handles negative balances as Cr-side
    // liabilities at report time.
    return { name, type: 'Asset', subType: 'Party', normalSide: 'Dr' };
  }
  if (name.startsWith('Employee: ')) {
    return { name, type: 'Asset', subType: 'Party', normalSide: 'Dr' };
  }
  if (name.startsWith('Expense:') || /expense$/i.test(name) || /cost$/i.test(name)) {
    return { name, type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr' };
  }
  if (/revenue|income|sales/i.test(name)) {
    return { name, type: 'Income', subType: 'Operating Income', normalSide: 'Cr' };
  }
  if (/gst payable|payable|accrued/i.test(name)) {
    return { name, type: 'Liability', subType: 'Current Liability', normalSide: 'Cr' };
  }
  if (/gst credit|receivable|cash|bank/i.test(name)) {
    return { name, type: 'Asset', subType: 'Current Asset', normalSide: 'Dr' };
  }
  // Conservative fallback: Equity/Suspense keeps trial balance intact.
  return { name, type: 'Equity', subType: 'Suspense', normalSide: 'Cr' };
}

/**
 * Round to 2 decimals.
 * @param {number} n
 */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Sum entry amounts (guaranteed positive per schema).
 * @param {JournalLine[]} entries
 */
export const totalOf = (entries = []) => round2(entries.reduce((s, e) => s + (Number(e.amount) || 0), 0));
