import { doc, runTransaction } from 'firebase/firestore';
import { getFYFromDate, sumLogisticsRecord } from './helpers';
import { inputGSTLines } from './aiAccountant/knowledge.js';

const round2 = (value) => Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Revenue Precedence for a project (highest available value wins):
 *   Level 3 (highest): Tax Invoice value for the project
 *   Level 2:           Package cost on the project
 *   Level 1 (lowest):  Itemised cost (items + logistics)
 * Returns { taxable, gst, total, source }
 */
const getProjectRevenue = (project, taxInvoiceForProject) => {
  // Level 3: Tax Invoice value — most authoritative
  if (taxInvoiceForProject) {
    const taxable = round2(taxInvoiceForProject.taxable || 0);
    const gst = round2(taxInvoiceForProject.gst_amount || 0);
    const total = round2(taxInvoiceForProject.final_amount != null
      ? taxInvoiceForProject.final_amount
      : (taxInvoiceForProject.computed_total || taxable + gst));
    return { taxable, gst, total, source: 'tax_invoice' };
  }

  // Level 2: Package cost on the project
  if (project.package_cost && parseFloat(project.package_cost) > 0) {
    const base = round2(parseFloat(project.package_cost));
    const gstRate = parseFloat(project.package_cost_gst || 18);
    const gst = round2(base * (gstRate / 100));
    return { taxable: base, gst, total: round2(base + gst), source: 'package_cost' };
  }

  // Level 1: Itemised cost (items + logistics)
  const equipment = (project.items || []).reduce((sum, i) => sum + (i.total || 0), 0);
  let logisticsBase = 0;
  let logisticsGst = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach((c) => {
      // H-10: respect split lines if present.
      const s = sumLogisticsRecord(c);
      logisticsBase += s.amount;
      logisticsGst += s.gstAmount;
    });
  }
  // Equipment items already include GST in their total — reverse-calc taxable at 18%
  const equipTaxable = round2(equipment / 1.18);
  const equipGst = round2(equipment - equipTaxable);
  const taxable = round2(equipTaxable + logisticsBase);
  const gst = round2(equipGst + logisticsGst);
  return { taxable, gst, total: round2(taxable + gst), source: 'itemised' };
};

/**
 * Cost Precedence for an outsourcing entry (highest available value wins):
 *   Level 3 (highest): Vendor Invoice (po.vendor_invoice or standalone purchase invoice)
 *   Level 2:           PO cost (package_cost or itemised PO cost)
 *   Level 1 (lowest):  Vendor allocation itemised cost
 * Returns { taxable, gst, total, source }
 */
export const getOutsourcingCost = (po, linkedPurchaseInvoice) => {
  // Level 3a: Standalone Purchase Invoice (from purchaseInvoices collection)
  if (linkedPurchaseInvoice) {
    const taxable = round2(linkedPurchaseInvoice.amount || 0);
    const gst = round2(linkedPurchaseInvoice.gst_amount || 0);
    return { taxable, gst, total: round2(taxable + gst), source: 'purchase_invoice' };
  }

  // Level 3b: Vendor Invoice embedded in PO (po.vendor_invoice)
  if (po?.vendor_invoice && po.vendor_invoice.invoice_no) {
    const taxable = round2(po.vendor_invoice.base_amount || 0);
    const gst = round2(po.vendor_invoice.gst_amount || 0);
    const total = round2(po.vendor_invoice.total_amount || (taxable + gst));
    if (total > 0) return { taxable, gst, total, source: 'vendor_invoice' };
  }

  if (!po) return { taxable: 0, gst: 0, total: 0, source: 'none' };

  // Level 2: PO package cost
  if (po.package_cost && parseFloat(po.package_cost) > 0) {
    const base = round2(parseFloat(po.package_cost));
    const gstRate = parseFloat(po.package_cost_gst || 0);
    const gst = round2(parseFloat(po.gst_amount) || (base * (gstRate / 100)));
    return { taxable: base, gst, total: round2(base + gst), source: 'po_package' };
  }

  // Level 1: PO itemised cost
  const total = round2(parseFloat(po.amount || 0));
  const gst = round2(parseFloat(po.gst_amount || 0));
  const taxable = round2(parseFloat(po.subtotal) || (total - gst));
  return { taxable, gst, total, source: 'po_itemised' };
};


// Helper to create unified client/vendor account name (display label).
// Still returns a plain string for backward compat with all callers.
const getPartyAccount = (entityName, entityId) => {
  const name = entityName || entityId || 'Unknown Party';
  return `Party: ${name}`;
};

// M-5: Stable identity key for a party (immune to name changes).
// Stored as debitAccountId / creditAccountId on journal rows so toLedger can
// group by ID even when the display name changes later.
const getPartyAccountId = (entityId) => (entityId ? `party_${entityId}` : null);

const normalizeMode = (mode) => {
  const raw = String(mode || '').trim().toLowerCase();
  if (raw === 'cash') return 'Cash';
  if (raw === 'credit') return 'Credit';
  return 'Credit';
};

const pickAccountByMode = (mode, cashAccount, creditAccount) => {
  return normalizeMode(mode) === 'Cash' ? cashAccount : creditAccount;
};

const applyFYToken = (value, fy) => String(value || '').replace(/\{FY\}/g, fy);

const defaultConfig = {
  sales: {
    prefix: 'SI-',
    suffix: '-{FY}',
    padLength: 4,
  },
  purchase: {
    prefix: 'PI-',
    suffix: '-{FY}',
    padLength: 4,
  },
};

export const DEFAULT_CHART_OF_ACCOUNTS = [
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

export const getDefaultChartOfAccounts = () => DEFAULT_CHART_OF_ACCOUNTS.map((row) => ({ ...row }));

const guessAccountType = (accountName, coaByName) => {
  const direct = coaByName[accountName];
  if (direct?.type) return direct.type;

  if (accountName.startsWith('Party:')) {
    // Party accounts are assets if Dr balance, liabilities if Cr balance
    // For type guessing, classify as Asset (will show correct based on balance)
    return 'Asset';
  }
  if (accountName.startsWith('Accounts Receivable:')) return 'Asset';
  if (accountName.startsWith('Accounts Payable:')) return 'Liability';
  if (accountName.startsWith('Expense:')) return 'Expense';

  if (accountName.includes('Revenue')) return 'Income';
  if (accountName.includes('Expense') || accountName.includes('Purchase')) return 'Expense';
  if (accountName.includes('GST Payable')) return 'Liability';
  if (accountName.includes('GST Credit')) return 'Asset';
  if (accountName.includes('Advance')) return 'Asset';
  if (accountName.includes('Cash') || accountName.includes('Bank')) return 'Asset';

  return 'Equity';
};

const fiscalYearStartDate = (fy) => {
  const startYear = parseInt(String(fy).slice(0, 4), 10);
  return `${startYear}-04-01`;
};

export const getNextFinancialYear = (fy) => {
  const startYear = parseInt(String(fy).slice(0, 4), 10);
  const nextStart = startYear + 1;
  const nextEnd = String(nextStart + 1).slice(-2);
  return `${nextStart}-${nextEnd}`;
};

const resolveBookConfig = (orgSettings = {}, bookType = 'sales', fy) => {
  const base = defaultConfig[bookType] || defaultConfig.sales;

  if (bookType === 'sales') {
    return {
      prefix: applyFYToken(orgSettings.sales_invoice_prefix || orgSettings.sales_prefix || base.prefix, fy),
      suffix: applyFYToken(orgSettings.sales_invoice_suffix || orgSettings.sales_suffix || base.suffix, fy),
      padLength: parseInt(orgSettings.sales_invoice_pad || orgSettings.sales_pad || base.padLength, 10) || 4,
    };
  }

  return {
    prefix: applyFYToken(orgSettings.purchase_invoice_prefix || orgSettings.purchase_prefix || base.prefix, fy),
    suffix: applyFYToken(orgSettings.purchase_invoice_suffix || orgSettings.purchase_suffix || base.suffix, fy),
    padLength: parseInt(orgSettings.purchase_invoice_pad || orgSettings.purchase_pad || base.padLength, 10) || 4,
  };
};

export const generateBookInvoiceNumber = async ({
  db,
  appId,
  dateStr,
  bookType = 'sales',
  orgSettings = {},
}) => {
  const fy = getFYFromDate(dateStr);
  const config = resolveBookConfig(orgSettings, bookType, fy);
  const counterKey = `${bookType}_${fy.replace('-', '_')}`;
  const counterRef = doc(db, 'artifacts', appId, 'public', 'data', 'counters', 'accounting_books');

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? parseInt(snap.data()[counterKey] || 0, 10) : 0;
    const next = current + 1;

    tx.set(counterRef, { [counterKey]: next }, { merge: true });

    const serial = String(next).padStart(config.padLength, '0');
    return `${config.prefix}${serial}${config.suffix}`;
  });
};

export const generateJournalVoucherNumber = async ({ db, appId, dateStr }) => {
  const fy = getFYFromDate(dateStr);
  const counterKey = `je_${fy.replace('-', '_')}`;
  const counterRef = doc(db, 'artifacts', appId, 'public', 'data', 'counters', 'accounting_vouchers');

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? parseInt(snap.data()[counterKey] || 0, 10) : 0;
    const next = current + 1;
    tx.set(counterRef, { [counterKey]: next }, { merge: true });
    return `JV-${String(next).padStart(4, '0')}-${fy}`;
  });
};

const pushDoubleEntry = (rows, common, lines) => {
  lines.forEach((line) => {
    rows.push({
      date: common.date,
      fy: common.fy,
      source: common.source,
      refNo: common.refNo,
      remarks: common.remarks || '',
      debitAccount: line.debitAccount,
      creditAccount: line.creditAccount,
      // M-5: stable party identity keys — immune to name changes.
      // null for system accounts (Cash, Bank, GST, etc.).
      debitAccountId: line.debitAccountId || null,
      creditAccountId: line.creditAccountId || null,
      amount: round2(line.amount),
      entityId: common.entityId || '',
      entityName: common.entityName || '',
      // C-3: project linkage so Reports project-P&L can filter journal lines.
      projectId: common.projectId || '',
      projectIds: Array.isArray(common.projectIds) ? common.projectIds : (common.projectId ? [common.projectId] : []),
      projectName: common.projectName || '',
    });
  });
};

// M-5: toLedger now accepts partyAccountsById for stable display-name resolution.
// Groups by accountId (stable) when set, else falls back to accountName string.
const toLedger = (journalRows, partyAccountsById = {}) => {
  const map = {};

  // Build a reverse index: 'Party: <current_name>' → accountId. Also include
  // historical names/aliases if present on the party doc (e.g. previous_names,
  // aliases). Used to backfill accountId on legacy journal rows that were
  // posted before M-5 (or by integrations that only set the name).
  const nameToId = {};
  Object.entries(partyAccountsById || {}).forEach(([id, pa]) => {
    if (!pa) return;
    const candidates = [pa.current_name, ...(Array.isArray(pa.previous_names) ? pa.previous_names : []), ...(Array.isArray(pa.aliases) ? pa.aliases : [])];
    candidates.filter(Boolean).forEach((nm) => {
      nameToId[`Party: ${nm}`] = id;
    });
  });

  // Resolve a leg's stable key. If the journal row has no accountId but the
  // account name matches a known party, look up its id so the row merges with
  // the id-keyed entries instead of producing a duplicate ledger row.
  const getKey = (accountName, accountId) => {
    if (accountId) return accountId;
    if (accountName && nameToId[accountName]) return nameToId[accountName];
    return accountName;
  };
  // If a party_accounts doc exists for this id, show its current name.
  const getDisplay = (accountName, accountId) => {
    const id = accountId || (accountName && nameToId[accountName]);
    if (id && partyAccountsById[id]) {
      return `Party: ${partyAccountsById[id].current_name}`;
    }
    return accountName;
  };

  journalRows.forEach((row) => {
    const drKey = getKey(row.debitAccount, row.debitAccountId);
    const crKey = getKey(row.creditAccount, row.creditAccountId);
    const drId = row.debitAccountId || (row.debitAccount && nameToId[row.debitAccount]) || null;
    const crId = row.creditAccountId || (row.creditAccount && nameToId[row.creditAccount]) || null;

    if (!map[drKey]) {
      map[drKey] = { account: getDisplay(row.debitAccount, row.debitAccountId), accountId: drId, debit: 0, credit: 0, entries: [] };
    }
    if (!map[crKey]) {
      map[crKey] = { account: getDisplay(row.creditAccount, row.creditAccountId), accountId: crId, debit: 0, credit: 0, entries: [] };
    }

    map[drKey].debit += row.amount;
    map[drKey].entries.push({ ...row, side: 'Dr' });

    map[crKey].credit += row.amount;
    map[crKey].entries.push({ ...row, side: 'Cr' });
  });

  return Object.values(map)
    .map((row) => {
      const debit = round2(row.debit);
      const credit = round2(row.credit);
      const balance = round2(debit - credit);
      return {
        ...row,
        debit,
        credit,
        balance,
        balanceType: balance >= 0 ? 'Dr' : 'Cr',
      };
    })
    .sort((a, b) => a.account.localeCompare(b.account));
};

export const getLedgerBalance = (ledgerRows, accountName) => {
  const row = (ledgerRows || []).find((item) => item.account === accountName);
  return row ? row.balance : 0;
};

// Sum the balances of every ledger account whose name matches a pattern.
// Used so the GST summary rolls up both the legacy single control accounts
// ("Output GST Payable" / "Input GST Credit") AND the split CGST/SGST/IGST
// sub-accounts the AI Accountant may post to.
const sumLedgerBalanceByPattern = (ledgerRows, re) =>
  ledgerRows.reduce((sum, item) => (re.test(item.account) ? sum + (item.balance || 0) : sum), 0);

export const buildAccountingSnapshot = ({
  clients = [],
  projects = [],
  taxInvoices = [],
  purchaseInvoices = [],
  payments = [],
  vendorPayments = [],
  payouts = [],
  expenses = [],
  advances = [],
  chartOfAccounts = [],
  openingBalances = [],
  manualJournalEntries = [],
  fiscalYearClosings = [],
  fyFilter = 'all',
  partyAccounts = [],   // M-5: stable name/alias lookup for party ledger rows
}) => {
  const inFY = (dateStr) => (fyFilter === 'all' ? true : getFYFromDate(dateStr) === fyFilter);

  // M-5: map from 'party_{entityId}' → party_accounts doc for display name resolution.
  const partyAccountsById = (partyAccounts || []).reduce((acc, pa) => {
    if (pa.entity_id) acc[`party_${pa.entity_id}`] = pa;
    return acc;
  }, {});

  const coaByName = (chartOfAccounts || []).reduce((acc, item) => {
    acc[item.name] = item;
    return acc;
  }, {});

  // C-5 fix: exclude Cancelled / Voided tax invoices from sales book
  const ACTIVE_TAX_INVOICE_STATUSES = (s) => {
    const v = String(s || '').toLowerCase();
    return v !== 'cancelled' && v !== 'voided' && v !== 'void' && v !== 'rejected';
  };

  const salesBookFromTaxInvoices = taxInvoices
    .filter((row) => ACTIVE_TAX_INVOICE_STATUSES(row.status))
    .filter((row) => inFY(row.invoice_date))
    .map((row) => {
      const taxable = round2(row.taxable || 0);
      const gst = round2(row.gst_amount || 0);
      const total = round2(row.final_amount != null ? row.final_amount : row.computed_total || taxable + gst);
      // C-3: capture project linkage for project-level P&L drilldown.
      const projectIds = Array.isArray(row.project_ids) && row.project_ids.length
        ? row.project_ids.filter(Boolean)
        : (row.project_id ? [row.project_id] : []);
      return {
        id: row.id,
        date: row.invoice_date,
        fy: getFYFromDate(row.invoice_date),
        invoiceNo: row.invoice_no,
        clientId: row.client_id,
        clientName: row.client_name,
        taxable,
        gst,
        total,
        mode: normalizeMode(row.sale_mode),
        remarks: row.remarks || '',
        source: 'tax_invoice', // Mark source
        projectIds,
        projectId: projectIds[0] || '',
      };
    });

  // M-14 fix: exclude Cancelled / Voided / Draft purchase invoices
  // (already excluded: Rejected). Pending/Approved/Paid/Posted are accepted.
  const ACTIVE_PURCHASE_INVOICE_STATUSES = (s) => {
    const v = String(s || '').toLowerCase();
    return v !== 'rejected' && v !== 'cancelled' && v !== 'voided' && v !== 'void' && v !== 'draft';
  };

  // Build index of purchase invoices by linked PO id for cost precedence lookup
  const piByLinkedPO = {};
  purchaseInvoices.forEach((pi) => {
    if (pi.linked_po_id && ACTIVE_PURCHASE_INVOICE_STATUSES(pi.status)) piByLinkedPO[pi.linked_po_id] = pi;
  });

  // PURCHASE BOOK: Purchase Invoices are Level 3 (highest priority for outsourcing)
  // Only include standalone purchase invoices that are NOT linked to any PO.
  // Linked ones will be handled via the PO-based outsourcing logic below.
  const purchaseBookFromPI = purchaseInvoices
    .filter((row) => ACTIVE_PURCHASE_INVOICE_STATUSES(row.status))
    .filter((row) => !row.linked_po_id)  // Exclude linked ones — handled in outsourcing
    .filter((row) => inFY(row.invoice_date))
    .map((row) => {
      const taxable = round2(row.amount || 0);
      const gst = round2(row.gst_amount || 0);
      const total = round2(taxable + gst);
      return {
        id: row.id,
        date: row.invoice_date,
        fy: getFYFromDate(row.invoice_date),
        invoiceNo: row.pi_no,
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        type: row.type || 'Service',
        taxable,
        gst,
        total,
        // Place-of-supply for the input-GST split (stored on the PI since 4a).
        // Absent/unknown → the single Input GST Credit control account (legacy).
        supplyType: String(row.supply_type || 'unknown'),
        status: row.status || 'Pending',
        mode: normalizeMode(row.purchase_mode),
        remarks: row.remarks || '',
        costSource: 'purchase_invoice',
        // C-3: standalone PIs may carry an explicit project link.
        projectId: row.project_id || '',
      };
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // ═══════════════════════════════════════════════════════════════════
  // OUTSOURCING COST: 3-Tier Precedence per vendor per project
  //   Tier 3 (highest): Vendor Invoice (po.vendor_invoice or standalone PI linked to PO)
  //   Tier 2: PO cost (package_cost > itemised PO cost)
  //   Tier 1 (lowest): Allocation cost (from vendor_allocations)
  //
  // For each vendor×project combination, only ONE tier's cost is used:
  //   - If vendor invoice exists → use invoice cost ONLY
  //   - Else if PO exists → use PO cost ONLY
  //   - Else if allocation exists → use allocation cost ONLY
  // ═══════════════════════════════════════════════════════════════════

  // Index: standalone purchase invoices linked to POs
  // (used inside the PO loop via piByLinkedPO lookup)

  const outsourcingFromProjects = [];

  projects
    .filter((p) => p.status === 'Completed' || p.status === 'Closed' || p.status === 'Ongoing')
    .forEach((project) => {
      // Track which vendors already have PO-level entries (to avoid allocation duplicacy)
      const vendorsCoveredByPO = new Set();

      // ── PASS 1: Process Purchase Orders (Tier 2/3) ──
      (project.purchase_orders || []).forEach((po) => {
        if (!po || po.status === 'Cancelled') return;

        // H-5: match a linked PI by stable po.id first, then fall back to the
        // legacy `${projectId}::${po_no}` composite key for older data.
        const stableKey = po.id || '';
        const compositeKey = `${project.id}::${po.po_no}`;
        const linkedPI = (stableKey && piByLinkedPO[stableKey])
          || piByLinkedPO[compositeKey]
          || null;

        // Determine cost using 3-tier precedence:
        //   getOutsourcingCost checks: linkedPI → po.vendor_invoice → po.package_cost → po.itemised
        const cost = getOutsourcingCost(po, linkedPI);
        if (cost.total <= 0) return;

        // Pick the best date: invoice date > PO date > project end date
        let entryDate;
        if (cost.source === 'purchase_invoice' && linkedPI) {
          entryDate = linkedPI.invoice_date;
        } else if (cost.source === 'vendor_invoice' && po.vendor_invoice) {
          entryDate = po.vendor_invoice.invoice_date || po.vendor_invoice.received_date;
        } else {
          entryDate = po.date;
        }
        entryDate = entryDate || project.end_date || project.completion_date;
        if (!inFY(entryDate)) return;

        // Build the reference number based on which tier won
        let refNo = po.po_no || `PO-${po.id}`;
        if (cost.source === 'vendor_invoice' && po.vendor_invoice?.invoice_no) {
          refNo = `VI-${po.vendor_invoice.invoice_no} (${po.po_no})`;
        } else if (cost.source === 'purchase_invoice' && linkedPI) {
          refNo = linkedPI.pi_no || `PI-${linkedPI.id}`;
        }

        outsourcingFromProjects.push({
          id: `po_${project.id}_${po.id}`,
          date: entryDate,
          fy: getFYFromDate(entryDate),
          invoiceNo: refNo,
          vendorId: po.vendor_id,
          vendorName: po.vendor_name,
          type: 'Service',
          taxable: cost.taxable,
          gst: cost.gst,
          total: cost.total,
          status: po.status || 'Draft',
          mode: 'Credit',
          remarks: `${cost.source === 'vendor_invoice' ? 'Vendor Invoice' : cost.source === 'purchase_invoice' ? 'Purchase Invoice' : 'PO'} for ${project.project_name || project.id}`,
          costSource: cost.source,
          projectId: project.id,
          projectName: project.project_name || '',
        });

        // Mark this vendor as covered by PO (so allocation doesn't double-count)
        if (po.vendor_id) vendorsCoveredByPO.add(po.vendor_id);
      });

      // ── PASS 2: Vendor Allocations WITHOUT POs ──
      // INTENTIONALLY DISABLED: allocation is planning, not execution. Until a
      // Purchase Order is raised (or a vendor / purchase invoice exists), the
      // allocation must NOT post to the ledger or appear in the purchase book —
      // it would create phantom payables to vendors and inflate P&L cost.
      // Only PO / Vendor Invoice / standalone PI tiers (PASS 1) post to journal.
      // (Project P&L reports may still surface allocation as a forecast/estimate
      //  separately, but that is computed outside this accounting snapshot.)
    });

  const purchaseBook = [...purchaseBookFromPI, ...outsourcingFromProjects]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // NON-INVOICED SALES BOOK: Completed projects without invoices
  // C-1 fix: tax_invoices stores `project_ids` (array), legacy docs may have singular `project_id`.
  // Skip cancelled invoices for dedup so the project goes back to non-invoiced bucket.
  const invoicedProjectIds = new Set(
    taxInvoices
      .filter((inv) => ACTIVE_TAX_INVOICE_STATUSES(inv.status))
      .flatMap((inv) => {
        const ids = Array.isArray(inv.project_ids) ? inv.project_ids : [];
        if (ids.length) return ids.filter(Boolean);
        return inv.project_id ? [inv.project_id] : [];
      })
  );

  // PROJECTS WITH INVOICE STATUS = 'Invoiced': These should go to Invoiced Sales
  const projectsMarkedAsInvoiced = projects
    .filter((p) => p.status === 'Completed' || p.status === 'Closed')
    .filter((p) => p.invoice_status === 'Invoiced')
    .filter((p) => !invoicedProjectIds.has(p.id)) // Not already in tax_invoices
    .filter((p) => inFY(p.end_date || p.completion_date || p.invoice_date))
    .map((project) => {
      // Revenue Precedence: package_cost > itemised (no tax invoice for these)
      const rev = getProjectRevenue(project, null);
      const clientName = clients.find(c => c.id === project.client_id)?.name || 'Unknown Client';

      return {
        id: project.id,
        date: project.invoice_date || project.end_date || project.completion_date || new Date().toISOString().slice(0, 10),
        fy: getFYFromDate(project.invoice_date || project.end_date || project.completion_date || new Date().toISOString().slice(0, 10)),
        invoiceNo: project.invoice_no || `PROJECT-${project.project_name || project.id}`,
        clientId: project.client_id,
        clientName: clientName,
        taxable: rev.taxable,
        gst: rev.gst,
        total: rev.total,
        mode: 'Credit',
        remarks: `Project Invoice: ${project.project_name}`,
        source: 'project_invoice',
        revenueSource: rev.source,
        projectId: project.id,
        projectIds: [project.id],
        projectName: project.project_name || '',
      };
    });

  // COMBINE SALES BOOK: Tax invoices + Project-based invoices
  const salesBook = [...salesBookFromTaxInvoices, ...projectsMarkedAsInvoiced]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const nonInvoicedSalesBook = projects
    .filter((p) => p.status === 'Completed' || p.status === 'Closed')
    .filter((p) => !invoicedProjectIds.has(p.id)) // Not in tax_invoices
    .filter((p) => p.invoice_status !== 'Invoiced') // NOT marked as invoiced (catches all non-invoiced states)
    .filter((p) => inFY(p.end_date || p.completion_date))
    .map((project) => {
      // Revenue Precedence: package_cost > itemised (no tax invoice for these)
      const rev = getProjectRevenue(project, null);
      const clientName = clients.find(c => c.id === project.client_id)?.name || 'Unknown Client';

      return {
        id: project.id,
        date: project.end_date || project.completion_date || new Date().toISOString().slice(0, 10),
        fy: getFYFromDate(project.end_date || project.completion_date || new Date().toISOString().slice(0, 10)),
        projectName: project.project_name,
        clientId: project.client_id,
        clientName: clientName,
        taxable: rev.taxable,
        gst: rev.gst,
        total: rev.total,
        mode: 'Credit',
        remarks: `Pending Invoice - Project: ${project.project_name}`,
        status: 'Non-Invoiced',
        revenueSource: rev.source,
        projectId: project.id,
      };
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const journal = [];

  // INVOICED SALES: From Tax Invoices
  salesBook.forEach((row) => {
    const partyAccount = getPartyAccount(row.clientName, row.clientId);
    const partyAccountId = getPartyAccountId(row.clientId);  // M-5
    const collectionAccount = pickAccountByMode(row.mode, 'Cash In Hand', partyAccount);
    // M-5: accountId only applies when the leg IS the party (Credit mode).
    const collectionAccountId = normalizeMode(row.mode) === 'Credit' ? partyAccountId : null;

    pushDoubleEntry(
      journal,
      {
        date: row.date,
        fy: row.fy,
        source: row.source === 'project_invoice' ? 'project_invoice' : 'sales_invoice',
        refNo: row.invoiceNo,
        remarks: row.remarks,
        entityId: row.clientId,
        entityName: row.clientName,
        projectId: row.projectId || '',
        projectIds: row.projectIds || [],
        projectName: row.projectName || '',
      },
      [
        {
          debitAccount: collectionAccount,
          debitAccountId: collectionAccountId,
          creditAccount: 'Sales Revenue',
          amount: row.taxable,
        },
        {
          debitAccount: collectionAccount,
          debitAccountId: collectionAccountId,
          creditAccount: 'Output GST Payable',
          amount: row.gst,
        },
      ]
    );
  });

  // NON-INVOICED SALES: From Completed Projects
  nonInvoicedSalesBook.forEach((row) => {
    const partyAccount = getPartyAccount(row.clientName, row.clientId);
    const partyAccountId = getPartyAccountId(row.clientId);  // M-5

    pushDoubleEntry(
      journal,
      {
        date: row.date,
        fy: row.fy,
        source: 'non_invoiced_sales',
        refNo: `Project-${row.projectName || row.id}`,
        remarks: row.remarks,
        entityId: row.clientId,
        entityName: row.clientName,
        projectId: row.projectId || row.id || '',
        projectName: row.projectName || '',
      },
      [
        {
          debitAccount: partyAccount,
          debitAccountId: partyAccountId,
          creditAccount: 'Non-Invoiced Sales Revenue',
          amount: row.taxable,
        },
        {
          debitAccount: partyAccount,
          debitAccountId: partyAccountId,
          creditAccount: 'Output GST Payable',
          amount: row.gst,
        },
      ]
    );
  });

  purchaseBook.forEach((row) => {
    const partyAccount = getPartyAccount(row.vendorName, row.vendorId);
    const partyAccountId = getPartyAccountId(row.vendorId);  // M-5
    const settlementAccount = pickAccountByMode(row.mode, 'Cash In Hand', partyAccount);
    // M-5: accountId only applies when the leg IS the party (Credit mode).
    const settlementAccountId = normalizeMode(row.mode) === 'Credit' ? partyAccountId : null;

    pushDoubleEntry(
      journal,
      {
        date: row.date,
        fy: row.fy,
        source: row.costSource || 'purchase_invoice',
        refNo: row.invoiceNo,
        remarks: row.remarks,
        entityId: row.vendorId,
        entityName: row.vendorName,
        projectId: row.projectId || '',
        projectName: row.projectName || '',
      },
      [
        {
          debitAccount: 'Purchase Expense',
          creditAccount: settlementAccount,
          creditAccountId: settlementAccountId,
          amount: row.taxable,
        },
        // Input GST: split into Input CGST/SGST/IGST when the PI carries an
        // intra/inter supply type (4a); otherwise the single Input GST Credit
        // control account, byte-identical to the legacy posting.
        ...((row.gst > 0 && (row.supplyType === 'intra' || row.supplyType === 'inter'))
          ? inputGSTLines(row.gst, row.supplyType).map((g) => ({
              debitAccount: g.account,
              creditAccount: settlementAccount,
              creditAccountId: settlementAccountId,
              amount: g.amount,
            }))
          : [{
              debitAccount: 'Input GST Credit',
              creditAccount: settlementAccount,
              creditAccountId: settlementAccountId,
              amount: row.gst,
            }]),
      ]
    );
  });

  // H-8 fix: Honor payment mode (Cash vs Bank) instead of always crediting Bank.
  payments
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      const collectionAccount = pickAccountByMode(row.mode, 'Cash In Hand', 'Bank');
      pushDoubleEntry(
        journal,
        {
          date: row.date,
          fy: getFYFromDate(row.date),
          source: 'receipt',
          refNo: row.reference || row.id,
          remarks: row.remarks,
          entityId: row.client_id,
          entityName: row.client_name,
        },
        [
          {
            debitAccount: collectionAccount,
            creditAccount: getPartyAccount(row.client_name, row.client_id),
            creditAccountId: getPartyAccountId(row.client_id),  // M-5
            amount: round2(row.amount),
          },
        ]
      );
    });

  // H-8 fix: Vendor payments honor mode.
  vendorPayments
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      const settlementAccount = pickAccountByMode(row.mode, 'Cash In Hand', 'Bank');
      pushDoubleEntry(
        journal,
        {
          date: row.date,
          fy: getFYFromDate(row.date),
          source: 'vendor_payment',
          refNo: row.reference || row.id,
          remarks: row.remarks,
          entityId: row.vendor_id,
          entityName: row.vendor_name,
        },
        [
          {
            debitAccount: getPartyAccount(row.vendor_name, row.vendor_id),
            debitAccountId: getPartyAccountId(row.vendor_id),  // M-5
            creditAccount: settlementAccount,
            amount: round2(row.amount),
          },
        ]
      );
    });

  // H-7 fix: Only Approved expense claims hit the books.
  // Pending / Clarification / Rejected / Disapproved are excluded so P&L
  // does not include un-approved claims.
  // H-6 fix: An expense claim creates a payable to the employee, not a Bank
  // outflow. Bank only moves when the reimbursement payout is actually paid.
  // The corresponding payout (with payout_type='reimbursement') will debit
  // Reimbursement Payable to clear it.
  expenses
    .filter((row) => row.status === 'Approved')
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      pushDoubleEntry(
        journal,
        {
          date: row.date,
          fy: getFYFromDate(row.date),
          source: 'expense',
          refNo: row.id,
          remarks: row.remarks,
          entityId: row.employee_id,
          entityName: row.employee_name,
          projectId: row.project_id || '',
        },
        [
          {
            debitAccount: `Expense:${row.category || 'General'}`,
            creditAccount: 'Reimbursement Payable',
            amount: round2(row.amount),
          },
        ]
      );
    });

  // H-6 / H-8 fix: Payouts route by payout_type so reimbursements clear the
  // Reimbursement Payable created by the expense, advance settlements clear
  // Employee Advances, and salary still hits Salary Expense.
  // Mode (Cash/Bank) is honored on the credit leg.
  payouts
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      const settlementAccount = pickAccountByMode(row.mode, 'Cash In Hand', 'Bank');
      let debitAccount = 'Salary Expense';
      const t = String(row.payout_type || '').toLowerCase();
      if (t === 'reimbursement') debitAccount = 'Reimbursement Payable';
      else if (t === 'advance_settlement' || t === 'advance') debitAccount = 'Employee Advances';
      pushDoubleEntry(
        journal,
        {
          date: row.date,
          fy: getFYFromDate(row.date),
          source: 'employee_payout',
          refNo: row.reference || row.id,
          remarks: row.remarks,
          entityId: row.employee_id,
          entityName: row.employee_name,
        },
        [
          {
            debitAccount,
            creditAccount: settlementAccount,
            amount: round2(row.amount),
          },
        ]
      );
    });

  // H-8 fix: Advances honor mode.
  advances
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      const settlementAccount = pickAccountByMode(row.mode, 'Cash In Hand', 'Bank');
      pushDoubleEntry(
        journal,
        {
          date: row.date,
          fy: getFYFromDate(row.date),
          source: 'employee_advance',
          refNo: row.id,
          remarks: row.remarks,
          entityId: row.employee_id,
          entityName: row.employee_name,
        },
        [
          {
            debitAccount: 'Employee Advances',
            creditAccount: settlementAccount,
            amount: round2(row.amount),
          },
        ]
      );
    });

  openingBalances
    .filter((row) => {
      // CRITICAL FIX: Filter by FY, not by date (prevents double counting after rollover)
      if (fyFilter === 'all') {
        // When viewing all FYs, EXCLUDE rollover opening balances because the
        // underlying transactions from prior FYs are already included in the journal.
        // Only keep manually-entered / initial-setup opening balances.
        return row.source !== 'fy_rollover';
      }
      // When viewing specific FY, ONLY include opening balances FOR THAT FY
      return row.fy === fyFilter;
    })
    .forEach((row) => {
      const amount = round2(row.amount);
      if (amount <= 0) return;
      const side = String(row.side || 'Dr').toUpperCase();
      const date = row.date || fiscalYearStartDate(row.fy || getFYFromDate(new Date().toISOString().slice(0, 10)));
      const accountName = row.account_name || row.account || 'Opening Balance Account';
      // M-5 carry-forward: stable accountId for party rows so the opening
      // balance row groups with the same entity's current-FY activity in toLedger.
      // Without this, prior-year carry-forward sits in its own ledger row and
      // doesn't net against new payments/invoices → comprehensive picture broken.
      const accountId = row.account_id || row.accountId || null;

      if (side === 'CR') {
        pushDoubleEntry(
          journal,
          {
            date,
            fy: getFYFromDate(date),
            source: 'opening_balance',
            refNo: row.ref_no || row.id || 'OB',
            remarks: row.remarks || 'Opening balance',
          },
          [{
            debitAccount: 'Opening Balance Equity',
            creditAccount: accountName,
            creditAccountId: accountId,
            amount,
          }]
        );
      } else {
        pushDoubleEntry(
          journal,
          {
            date,
            fy: getFYFromDate(date),
            source: 'opening_balance',
            refNo: row.ref_no || row.id || 'OB',
            remarks: row.remarks || 'Opening balance',
          },
          [{
            debitAccount: accountName,
            debitAccountId: accountId,
            creditAccount: 'Opening Balance Equity',
            amount,
          }]
        );
      }
    });

  manualJournalEntries
    .filter((row) => row.status !== 'cancelled')
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      (row.entries || []).forEach((entry) => {
        const amount = round2(entry.amount);
        if (amount <= 0 || !entry.debitAccount || !entry.creditAccount) return;
        pushDoubleEntry(
          journal,
          {
            date: row.date,
            fy: getFYFromDate(row.date),
            source: row.source || 'manual_journal',
            refNo: row.voucher_no || row.id,
            remarks: row.narration || row.remarks || '',
          },
          [{ debitAccount: entry.debitAccount, creditAccount: entry.creditAccount, amount }]
        );
      });
    });

  fiscalYearClosings
    .filter((row) => row.status === 'closed')
    .filter((row) => inFY(row.date || fiscalYearStartDate(row.fy)))
    .forEach((row) => {
      const entry = row.transferEntry;
      if (!entry || !entry.debitAccount || !entry.creditAccount || !entry.amount) return;
      pushDoubleEntry(
        journal,
        {
          date: row.date || fiscalYearStartDate(row.fy),
          fy: row.fy || getFYFromDate(row.date),
          source: 'fy_closing',
          refNo: row.voucher_no || `CLOSE-${row.fy}`,
          remarks: row.remarks || `Year closing transfer for ${row.fy}`,
        },
        [{ debitAccount: entry.debitAccount, creditAccount: entry.creditAccount, amount: entry.amount }]
      );
    });

  journal.sort((a, b) => {
    if ((a.date || '') === (b.date || '')) return String(a.refNo || '').localeCompare(String(b.refNo || ''));
    return (a.date || '').localeCompare(b.date || '');
  });

  const ledger = toLedger(journal, partyAccountsById);  // M-5: pass id map for stable grouping

  const trialRows = ledger.map((row) => ({
    account: row.account,
    debit: row.debit,
    credit: row.credit,
    balance: row.balance,
    balanceType: row.balanceType,
  }));
  const trialDebitTotal = round2(trialRows.reduce((sum, row) => sum + row.debit, 0));
  const trialCreditTotal = round2(trialRows.reduce((sum, row) => sum + row.credit, 0));
  const trialDifference = round2(trialDebitTotal - trialCreditTotal);
  const isTrialBalanced = Math.abs(trialDifference) < 0.01;

  const incomeByLedger = round2(
    ledger
      .filter((row) => guessAccountType(row.account, coaByName) === 'Income')
      .reduce((sum, row) => sum + Math.max(-row.balance, 0), 0)
  );
  const expenseRows = ledger.filter((row) => guessAccountType(row.account, coaByName) === 'Expense');
  const cogsRows = expenseRows.filter((row) => /purchase|cogs|cost of goods/i.test(row.account));
  const opexRows = expenseRows.filter((row) => !/purchase|cogs|cost of goods/i.test(row.account));

  const totalPurchaseTaxable = round2(cogsRows.reduce((sum, row) => sum + Math.max(row.balance, 0), 0));
  const totalOperatingExpenses = round2(opexRows.reduce((sum, row) => sum + Math.max(row.balance, 0), 0));
  const totalSalesTaxable = incomeByLedger;

  const grossProfit = round2(totalSalesTaxable - totalPurchaseTaxable);
  const netProfit = round2(grossProfit - totalOperatingExpenses);

  const cashBalance = round2(getLedgerBalance(ledger, 'Cash In Hand') + getLedgerBalance(ledger, 'Bank'));

  // Party accounts can be assets (Dr balance) or liabilities (Cr balance)
  const partyLedgerRows = ledger.filter((row) => row.account.startsWith('Party:'));
  const receivableTotal = round2(
    partyLedgerRows.reduce((sum, row) => sum + (row.balance > 0 ? row.balance : 0), 0)
  );
  const advanceAsset = round2(Math.max(getLedgerBalance(ledger, 'Employee Advances'), 0));

  const payableTotal = round2(
    partyLedgerRows.reduce((sum, row) => sum + (row.balance < 0 ? Math.abs(row.balance) : 0), 0)
  );

  // Roll up the whole output/input GST family (legacy single control accounts
  // + any Output/Input CGST/SGST/IGST split accounts) so chat-posted split
  // entries are not under-counted in the balance sheet.
  const outputGst = round2(Math.abs(Math.min(sumLedgerBalanceByPattern(ledger, /output\s+(c|s|i)?gst|gst\s+payable/i), 0)));
  const inputGst = round2(Math.max(sumLedgerBalanceByPattern(ledger, /input\s+(c|s|i)?gst|gst\s+credit/i), 0));
  const gstPayable = round2(Math.max(outputGst - inputGst, 0));

  const assetsTotal = round2(cashBalance + receivableTotal + advanceAsset + inputGst);
  const liabilitiesTotal = round2(payableTotal + gstPayable);
  const retainedEarningsLedger = round2(Math.abs(Math.min(getLedgerBalance(ledger, 'Retained Earnings'), 0)));
  const equityTotal = round2(retainedEarningsLedger + netProfit);

  return {
    clients,
    fyFilter,
    salesBook,  // INVOICED SALES (from tax_invoices)
    nonInvoicedSalesBook,  // NON-INVOICED SALES (from completed projects)
    purchaseBook,
    journal,
    ledger,
    profitAndLoss: {
      revenue: totalSalesTaxable,
      costOfGoodsSold: totalPurchaseTaxable,
      grossProfit,
      operatingExpenses: totalOperatingExpenses,
      netProfit,
    },
    trialBalance: {
      rows: trialRows,
      totalDebit: trialDebitTotal,
      totalCredit: trialCreditTotal,
      difference: trialDifference,
      isBalanced: isTrialBalanced,
    },
    balanceSheet: {
      assets: {
        cashAndBank: cashBalance,
        accountsReceivable: receivableTotal,
        employeeAdvances: advanceAsset,
        inputGstCredit: inputGst,
        total: assetsTotal,
      },
      liabilities: {
        accountsPayable: payableTotal,
        gstPayable,
        total: liabilitiesTotal,
      },
      equity: {
        retainedEarnings: retainedEarningsLedger,
        currentYearProfit: netProfit,
        total: equityTotal,
      },
      totalLiabilitiesAndEquity: round2(liabilitiesTotal + equityTotal),
    },
  };
};
