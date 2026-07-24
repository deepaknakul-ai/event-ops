'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
 * PORTED VERBATIM — DO NOT "IMPROVE".
 *
 * Server-side (Cloud Functions) copy of the client's default Chart of Accounts.
 * DEFAULT_CHART_OF_ACCOUNTS below is copied row-for-row (modulo ESM→CJS syntax)
 * from:
 *
 *   - src/utils/accounting.js → DEFAULT_CHART_OF_ACCOUNTS, getDefaultChartOfAccounts
 *
 * platformCreateTenant (functions/platform.js) seeds a new tenant's
 * chart_of_accounts from getDefaultChartOfAccounts() using each row's `code`
 * as the document id — identical to the client's seedDefaultCoa
 * (src/pages/Accounting.jsx).
 *
 * ANY change to the client source MUST be mirrored here. The parity test
 * tests/coa-defaults-parity.test.js guards this: it deep-equals this copy
 * against the client export and fails if they diverge.
 *
 * NO firebase imports — everything here is plain data.
 * ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Cash In Hand', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '1010', name: 'Bank', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '1100', name: 'Accounts Receivable', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '1200', name: 'Employee Advances', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '1300', name: 'Input GST Credit', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '2000', name: 'Accounts Payable', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '2100', name: 'Output GST Payable', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '3000', name: 'Retained Earnings', type: 'Equity', subType: 'Equity', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '3010', name: 'Opening Balance Equity', type: 'Equity', subType: 'Equity', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '4000', name: 'Sales Revenue', type: 'Income', subType: 'Operating Income', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '4010', name: 'Non-Invoiced Sales Revenue', type: 'Income', subType: 'Operating Income', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '5000', name: 'Purchase Expense', type: 'Expense', subType: 'Cost Of Goods Sold', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '5100', name: 'Salary Expense', type: 'Expense', subType: 'Operating Expense', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '5200', name: 'Expense:General', type: 'Expense', subType: 'Operating Expense', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '1400', name: 'TDS Receivable', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: true, isActive: true },
  { code: '2200', name: 'TDS Payable', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '2210', name: 'Employee Payable', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: true, isActive: true },
  { code: '3020', name: 'Profit And Loss Closing', type: 'Equity', subType: 'Equity', normalSide: 'Dr', isSystem: true, isActive: true },

  // ── Extended professional CoA (editable; seeded for the AI Accountant) ──────
  // Assets — fixed asset blocks + prepaid
  { code: '1500', name: 'Computer Equipment', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1510', name: 'AV Equipment', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1520', name: 'Plant & Machinery', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1530', name: 'Furniture & Fixtures', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1540', name: 'Vehicles', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1550', name: 'Land & Building', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1560', name: 'Software', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1600', name: 'Accumulated Depreciation', type: 'Asset', subType: 'Fixed Asset', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '1700', name: 'Prepaid Expenses', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1310', name: 'Input CGST', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1320', name: 'Input SGST', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '1330', name: 'Input IGST', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr', isSystem: false, isActive: true },

  // Liabilities — GST split + accruals + loans + capital/drawings
  { code: '2110', name: 'Output CGST', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '2120', name: 'Output SGST', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '2130', name: 'Output IGST', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '2300', name: 'Outstanding Expenses', type: 'Liability', subType: 'Current Liability', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '2400', name: 'Loans', type: 'Liability', subType: 'Loan', normalSide: 'Cr', isSystem: false, isActive: true },

  // Equity
  { code: '3100', name: 'Capital', type: 'Equity', subType: 'Equity', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '3110', name: 'Drawings', type: 'Equity', subType: 'Equity', normalSide: 'Dr', isSystem: false, isActive: true },

  // Income — other than operating sales
  { code: '4100', name: 'Interest Income', type: 'Income', subType: 'Other Income', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '4110', name: 'Discount Received', type: 'Income', subType: 'Other Income', normalSide: 'Cr', isSystem: false, isActive: true },
  { code: '4120', name: 'Round Off', type: 'Income', subType: 'Other Income', normalSide: 'Cr', isSystem: false, isActive: true },

  // Direct expenses (Cost of Goods Sold / Direct)
  { code: '5010', name: 'Subcontractor / Outsourcing', type: 'Expense', subType: 'Direct Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5020', name: 'Direct Labour', type: 'Expense', subType: 'Direct Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5030', name: 'Equipment Hire', type: 'Expense', subType: 'Direct Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5040', name: 'Freight Inward', type: 'Expense', subType: 'Direct Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5050', name: 'Site Power & Fuel', type: 'Expense', subType: 'Direct Expense', normalSide: 'Dr', isSystem: false, isActive: true },

  // Indirect expenses (Operating / Overheads)
  { code: '5300', name: 'Rent Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5310', name: 'Electricity Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5320', name: 'Telephone & Internet', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5330', name: 'Printing & Stationery', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5340', name: 'Bank Charges', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5350', name: 'Professional & Legal Fees', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5360', name: 'Travelling & Conveyance', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5370', name: 'Repairs & Maintenance', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5380', name: 'Insurance Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5390', name: 'Marketing Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5400', name: 'Commission Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5410', name: 'Food Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5420', name: 'Office Supplies Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5430', name: 'Freight & Logistics', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5440', name: 'Miscellaneous Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5500', name: 'Depreciation Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5510', name: 'Interest Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5520', name: 'Discount Allowed', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
  { code: '5530', name: 'Bad Debts Expense', type: 'Expense', subType: 'Indirect Expense', normalSide: 'Dr', isSystem: false, isActive: true },
];

const getDefaultChartOfAccounts = () => DEFAULT_CHART_OF_ACCOUNTS.map((row) => ({ ...row }));

module.exports = { DEFAULT_CHART_OF_ACCOUNTS, getDefaultChartOfAccounts };
