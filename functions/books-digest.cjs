'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
 * PORTED VERBATIM — DO NOT "IMPROVE".
 *
 * Server-side (Cloud Functions) port of the PURE client accounting-books
 * digest pipeline. Every function body below is copied byte-for-byte (modulo
 * ESM→CJS syntax) from these source files:
 *
 *   - src/utils/helpers.js                → isProjectInvoiced, getFinancialYear,
 *                                           getFYFromDate, sumLogisticsRecord
 *   - src/utils/aiAccountant/schema.js    → round2 (schema variant)
 *   - src/utils/aiAccountant/knowledge.js → halve, inputGSTLines
 *   - src/utils/accounting.js             → round2 (accounting variant),
 *                                           getProjectRevenue, getOutsourcingCost,
 *                                           getPartyAccount, getPartyAccountId,
 *                                           getEmployeeAccount, getEmployeeAccountId,
 *                                           normalizeMode, pickAccountByMode,
 *                                           guessAccountType, fiscalYearStartDate,
 *                                           pushDoubleEntry, toLedger,
 *                                           buildAccountingSnapshot
 *   - src/utils/aiAccountant/queries.js   → stripPrefix, buildBooksDigest
 *
 * ANY change to the originals MUST be mirrored here. The parity test
 * tests/books-digest-parity.test.js guards this: it runs both implementations
 * over the same synthetic fixture and asserts deep equality.
 *
 * NOTE on the two round2 variants: accounting.js defines its own local
 * round2 (parseFloat + Number.EPSILON), while knowledge.js / queries.js import
 * round2 from schema.js (Number, no EPSILON). Both are preserved exactly —
 * the schema variant is scoped inside closures so each ported body sees the
 * same `round2` it saw in its source module.
 *
 * NO firebase imports — everything here is pure JS over plain data.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/helpers.js
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_INVOICED_STATUSES = new Set([
  'invoiced',
  'clubbed invoice',
  'clubbed invoiced',
]);

const isProjectInvoiced = (status) =>
  PROJECT_INVOICED_STATUSES.has(String(status || '').trim().toLowerCase().replace(/\s+/g, ' '));

const getFinancialYear = () => {
  const now = new Date();
  const m = now.getMonth(); // 0 = Jan
  const y = now.getFullYear();
  if (m < 3) return `${y-1}-${String(y).slice(-2)}`;
  return `${y}-${String(y+1).slice(-2)}`;
};

const getFYFromDate = (dateStr) => {
  if (!dateStr) return getFinancialYear();
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return getFinancialYear();
  const m = d.getMonth();
  const y = d.getFullYear();
  if (m < 3) return `${y-1}-${String(y).slice(-2)}`;
  return `${y}-${String(y+1).slice(-2)}`;
};

/**
 * H-10: aggregated taxable + GST for a single logistics type record.
 * Uses split lines when present, else legacy single-bucket.
 */
const sumLogisticsRecord = (record) => {
  if (!record) return { amount: 0, gstAmount: 0, total: 0 };
  const split = Array.isArray(record.lines) ? record.lines.filter(Boolean) : [];
  if (split.length > 0) {
    let amount = 0, gstAmount = 0;
    split.forEach((l) => {
      const a = parseFloat(l.amount || 0);
      const g = parseFloat(l.gst || 0);
      amount += a;
      gstAmount += a * g / 100;
    });
    return { amount, gstAmount, total: amount + gstAmount };
  }
  const amount = parseFloat(record.amount || 0);
  const gst = parseFloat(record.gst || 0);
  const gstAmount = amount * gst / 100;
  return { amount, gstAmount, total: amount + gstAmount };
};

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/aiAccountant/schema.js
// ─────────────────────────────────────────────────────────────────────────────

const schemaRound2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/aiAccountant/knowledge.js
// (knowledge.js imports round2 from schema.js — the closure preserves that.)
// ─────────────────────────────────────────────────────────────────────────────

const { inputGSTLines } = (() => {
  const round2 = schemaRound2;

  /** Split a GST amount into two halves that still sum exactly to the original. */
  function halve(gst) {
    const half = round2(gst / 2);
    return [half, round2(gst - half)]; // [cgst, sgst]
  }

  /**
   * GST debit lines for a PURCHASE (input) — claimable input tax credit.
   * @returns {Array<{account:string, amount:number}>}
   */
  function inputGSTLines(gst, supplyType) {
    if (gst <= 0) return [];
    if (supplyType === 'inter') return [{ account: 'Input IGST', amount: round2(gst) }];
    if (supplyType === 'intra') {
      const [cgst, sgst] = halve(gst);
      return [{ account: 'Input CGST', amount: cgst }, { account: 'Input SGST', amount: sgst }];
    }
    return [{ account: 'Input GST Credit', amount: round2(gst) }];
  }

  return { inputGSTLines };
})();

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/accounting.js
// ─────────────────────────────────────────────────────────────────────────────

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
    const gstRate = parseFloat(project.package_cost_gst != null ? project.package_cost_gst : 18);
    const gst = round2(base * (gstRate / 100));
    return { taxable: base, gst, total: round2(base + gst), source: 'package_cost' };
  }

  // Level 1: Itemised cost (items + logistics) — GST summed PER LINE (respects 0%
  // and mixed rates); never a flat 18% reverse-calc, which mis-stated any 0%/non-18%
  // item. GST is still computed and carried even when a party has no GSTIN.
  let equipTaxable = 0;
  let equipGst = 0;
  (project.items || []).forEach((i) => {
    const taxable = parseFloat(i.amount || 0);
    const gstRate = parseFloat(i.gst_rate != null ? i.gst_rate : 18);
    const gst = i.gst_amount != null ? parseFloat(i.gst_amount) : taxable * (gstRate / 100);
    equipTaxable += taxable;
    equipGst += gst;
  });
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
const getOutsourcingCost = (po, linkedPurchaseInvoice) => {
  // Level 3a: Standalone Purchase Invoice (from purchaseInvoices collection)
  if (linkedPurchaseInvoice) {
    const taxable = round2(linkedPurchaseInvoice.amount || 0);
    const gst = round2(linkedPurchaseInvoice.gst_amount || 0);
    return { taxable, gst, total: round2(taxable + gst), source: 'purchase_invoice' };
  }

  // Level 3b: Vendor Invoice embedded in PO (po.vendor_invoice)
  if (po?.vendor_invoice && po.vendor_invoice.invoice_no && (po.vendor_invoice.status === 'Accepted' || po.vendor_invoice.status === 'Verified')) {
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
    const gst = round2(po.gst_amount != null ? parseFloat(po.gst_amount) : base * (gstRate / 100));
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

// Per-employee sub-ledger — one net running balance per employee that holds BOTH
// advances (Dr, they owe us) and reimbursements (Cr, we owe them). Mirrors the
// Party: convention (dual-use, netted by sign) but under a distinct prefix so
// employees never leak into client/vendor AR/AP aging or party pickers.
const getEmployeeAccount = (entityName, entityId) => {
  const name = entityName || entityId || 'Unknown Employee';
  return `Employee: ${name}`;
};
const getEmployeeAccountId = (entityId) => (entityId ? `emp_${entityId}` : null);

const normalizeMode = (mode) => {
  const raw = String(mode || '').trim().toLowerCase();
  if (raw === 'cash') return 'Cash';
  if (raw === 'credit') return 'Credit';
  return 'Credit';
};

const pickAccountByMode = (mode, cashAccount, creditAccount) => {
  return normalizeMode(mode) === 'Cash' ? cashAccount : creditAccount;
};

const guessAccountType = (accountName, coaByName) => {
  const direct = coaByName[accountName];
  if (direct?.type) return direct.type;

  if (accountName.startsWith('Party:')) {
    // Party accounts are assets if Dr balance, liabilities if Cr balance
    // For type guessing, classify as Asset (will show correct based on balance)
    return 'Asset';
  }
  // Per-employee accounts are dual-use like Party: (net asset or liability by sign).
  if (accountName.startsWith('Employee:')) return 'Asset';
  if (accountName.startsWith('Accounts Receivable:')) return 'Asset';
  if (accountName.startsWith('Accounts Payable:')) return 'Liability';
  if (accountName.startsWith('Expense:')) return 'Expense';

  if (accountName.includes('Revenue')) return 'Income';
  if (accountName.includes('Expense') || accountName.includes('Purchase')) return 'Expense';
  if (accountName.includes('GST Payable')) return 'Liability';
  if (accountName.includes('GST Credit')) return 'Asset';
  if (accountName.includes('Advance')) return 'Asset';
  // "Bank Charges" / fee accounts are expenses — check BEFORE the cash/bank rule.
  if (/charge/i.test(accountName)) return 'Expense';
  if (accountName.includes('Cash') || accountName.includes('Bank')) return 'Asset';

  return 'Equity';
};

const fiscalYearStartDate = (fy) => {
  const startYear = parseInt(String(fy).slice(0, 4), 10);
  return `${startYear}-04-01`;
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
const toLedger = (journalRows, partyAccountsById = {}, employeeAccountsById = {}) => {
  const map = {};

  // Build a reverse index: 'Party: <current_name>' → accountId. Also include
  // historical names/aliases if present on the party doc (e.g. previous_names,
  // aliases). Used to backfill accountId on legacy journal rows that were
  // posted before M-5 (or by integrations that only set the name).
  // The same index also maps 'Employee: <name>' → 'emp_<id>' so a chat leg that
  // only carries the employee NAME merges into the id-keyed derived employee row.
  const nameToId = {};
  Object.entries(partyAccountsById || {}).forEach(([id, pa]) => {
    if (!pa) return;
    const candidates = [pa.current_name, ...(Array.isArray(pa.previous_names) ? pa.previous_names : []), ...(Array.isArray(pa.aliases) ? pa.aliases : [])];
    candidates.filter(Boolean).forEach((nm) => {
      nameToId[`Party: ${nm}`] = id;
    });
  });
  Object.entries(employeeAccountsById || {}).forEach(([id, ea]) => {
    if (!ea) return;
    const candidates = [ea.current_name, ...(Array.isArray(ea.previous_names) ? ea.previous_names : []), ...(Array.isArray(ea.aliases) ? ea.aliases : [])];
    candidates.filter(Boolean).forEach((nm) => {
      nameToId[`Employee: ${nm}`] = id;
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
  // If a party_accounts / employee doc exists for this id, show its current name.
  const getDisplay = (accountName, accountId) => {
    const id = accountId || (accountName && nameToId[accountName]);
    if (id && partyAccountsById[id]) {
      return `Party: ${partyAccountsById[id].current_name}`;
    }
    if (id && employeeAccountsById[id]) {
      return `Employee: ${employeeAccountsById[id].current_name}`;
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

const buildAccountingSnapshot = ({
  clients = [],
  projects = [],
  taxInvoices = [],
  purchaseInvoices = [],
  payments = [],
  vendorPayments = [],
  payouts = [],
  expenses = [],
  advances = [],
  employees = [],
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

  // Per-employee ledger identity: 'emp_{id}' → { current_name } so the derived
  // employee legs (which carry the id) and chat legs (name only) merge into one
  // running balance per employee.
  const employeeAccountsById = (employees || []).reduce((acc, e) => {
    if (e && e.id) acc[`emp_${e.id}`] = { current_name: e.name, previous_names: e.previous_names, aliases: e.aliases };
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
    .filter((p) => isProjectInvoiced(p.invoice_status))
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
    .filter((p) => !isProjectInvoiced(p.invoice_status)) // NOT marked as invoiced (catches all non-invoiced states)
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

    const salesLines = [
      { debitAccount: collectionAccount, debitAccountId: collectionAccountId, creditAccount: 'Sales Revenue', amount: row.taxable },
      { debitAccount: collectionAccount, debitAccountId: collectionAccountId, creditAccount: 'Output GST Payable', amount: row.gst },
    ];
    // Round-off / discount: when the invoice's final_amount differs from taxable+gst,
    // post the residual to Round Off so the party sub-ledger equals the document total.
    const salesRoundOff = round2((row.total != null ? row.total : (row.taxable + row.gst)) - row.taxable - row.gst);
    if (Math.abs(salesRoundOff) > 0.005) {
      salesLines.push(salesRoundOff > 0
        ? { debitAccount: collectionAccount, debitAccountId: collectionAccountId, creditAccount: 'Round Off', amount: salesRoundOff }
        : { debitAccount: 'Round Off', creditAccount: collectionAccount, creditAccountId: collectionAccountId, amount: -salesRoundOff });
    }
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
      salesLines
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
        // Unbilled accrual: NO Output GST leg — the GST liability arises only when the
        // tax invoice is raised (time of supply). Accruing it here overstated the
        // balance-sheet Output GST Payable. Receivable = taxable (ex-GST) until invoiced.
        {
          debitAccount: partyAccount,
          debitAccountId: partyAccountId,
          creditAccount: 'Non-Invoiced Sales Revenue',
          amount: row.taxable,
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
            // We now OWE the employee: credit their per-employee running account.
            creditAccount: getEmployeeAccount(row.employee_name, row.employee_id),
            creditAccountId: getEmployeeAccountId(row.employee_id),
            amount: round2(row.amount),
          },
        ]
      );
    });

  // Payouts route by payout_type: a reimbursement or advance-settlement debits
  // the employee's per-employee account (clearing what we owe / recovering an
  // advance); salary — and every legacy payout with no payout_type — still hits
  // Salary Expense. Mode (Cash/Bank) is honored on the credit leg.
  payouts
    .filter((row) => inFY(row.date))
    .forEach((row) => {
      const settlementAccount = pickAccountByMode(row.mode, 'Cash In Hand', 'Bank');
      const t = String(row.payout_type || '').toLowerCase();
      let debitAccount = 'Salary Expense';
      let debitAccountId = null;
      let source = 'employee_payout';
      if (t === 'reimbursement') {
        debitAccount = getEmployeeAccount(row.employee_name, row.employee_id);
        debitAccountId = getEmployeeAccountId(row.employee_id);
        source = 'employee_reimbursement';
      } else if (t === 'advance_settlement' || t === 'advance') {
        // Money out to the employee as an advance → they now owe us (Dr), same
        // account/direction as an advance from the advances collection.
        debitAccount = getEmployeeAccount(row.employee_name, row.employee_id);
        debitAccountId = getEmployeeAccountId(row.employee_id);
        source = 'employee_advance';
      }
      pushDoubleEntry(
        journal,
        {
          date: row.date,
          fy: getFYFromDate(row.date),
          source,
          refNo: row.reference || row.id,
          remarks: row.remarks,
          entityId: row.employee_id,
          entityName: row.employee_name,
        },
        [
          {
            debitAccount,
            debitAccountId,
            creditAccount: settlementAccount,
            amount: round2(row.amount),
          },
        ]
      );
    });

  // H-8 fix: Advances honor mode. Net model — the advance debits the employee's
  // per-employee account (they now owe us), same account reimbursements credit.
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
            debitAccount: getEmployeeAccount(row.employee_name, row.employee_id),
            debitAccountId: getEmployeeAccountId(row.employee_id),
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

  const ledger = toLedger(journal, partyAccountsById, employeeAccountsById);  // M-5: pass id maps for stable grouping

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

  const incomeRows = ledger.filter((row) => guessAccountType(row.account, coaByName) === 'Income');
  const incomeByLedger = round2(
    incomeRows.reduce((sum, row) => sum + Math.max(-row.balance, 0), 0)
  );
  const expenseRows = ledger.filter((row) => guessAccountType(row.account, coaByName) === 'Expense');
  const cogsRows = expenseRows.filter((row) => /purchase|cogs|cost of goods/i.test(row.account));
  const opexRows = expenseRows.filter((row) => !/purchase|cogs|cost of goods/i.test(row.account));

  const totalPurchaseTaxable = round2(cogsRows.reduce((sum, row) => sum + Math.max(row.balance, 0), 0));
  const totalOperatingExpenses = round2(opexRows.reduce((sum, row) => sum + Math.max(row.balance, 0), 0));
  const totalSalesTaxable = incomeByLedger;

  const grossProfit = round2(totalSalesTaxable - totalPurchaseTaxable);
  const netProfit = round2(grossProfit - totalOperatingExpenses);

  // ── Abnormal-sign P&L accounts (diagnostic only) ────────────────────────────
  // The Math.max clamps above DROP any P&L account sitting on the wrong side
  // (an Income head with a Dr balance, an Expense head with a Cr balance) from the
  // presented P&L; the residue is absorbed into balanceSheet.equity.otherEquity
  // below, so the sheet still balances and the anomaly is invisible. Surface them
  // instead of hiding them. Presentation is unchanged — this only reports.
  const plExceptions = [
    ...incomeRows.filter((row) => row.balance > 0.005).map((row) => ({
      account: row.account, type: 'Income', balance: round2(row.balance),
      side: 'Dr', excluded: round2(row.balance),
    })),
    ...expenseRows.filter((row) => row.balance < -0.005).map((row) => ({
      account: row.account, type: 'Expense', balance: round2(row.balance),
      side: 'Cr', excluded: round2(-row.balance),
    })),
  ];
  const plExceptionsTotal = round2(plExceptions.reduce((s, r) => s + r.excluded, 0));

  // ── Balance sheet BY CONSTRUCTION (grey-area B2) ────────────────────────────
  // Every non-P&L ledger row is classified into exactly one named line; totals
  // are sums of those lines, so for a balanced trial balance A = L + E is an
  // algebraic identity. Lines can be negative (contra accounts, Dr liabilities).
  // Nothing is dropped: unmatched rows land in visible "other*" lines.
  const A = (line, value) => ({ bucket: 'assets', line, value });
  const L = (line, value) => ({ bucket: 'liabilities', line, value });
  const E = (line, value) => ({ bucket: 'equity', line, value });
  const classifyBsRow = (row) => {
    const name = row.account || '';
    const bal = row.balance || 0; // Dr positive
    // Dual-use sub-ledgers split by sign (a Cr party = payable, Dr = receivable).
    if (name.startsWith('Party:')) return bal >= 0 ? A('accountsReceivable', bal) : L('accountsPayable', -bal);
    if (name.startsWith('Employee:') || name === 'Employee Advances' || name === 'Employee Payable') {
      return bal >= 0 ? A('employeeAdvances', bal) : L('employeePayable', -bal);
    }
    if (/suspense|unresolved/i.test(name)) return bal >= 0 ? A('suspense', bal) : L('suspense', -bal);
    // Tax families before generic typing.
    if (/input\s+(c|s|i)?gst|gst\s+credit/i.test(name)) return A('inputGstCredit', bal);
    if (/output\s+(c|s|i)?gst|gst\s+payable/i.test(name)) return L('gstPayableGross', -bal);
    if (/^tds\s+receivable$/i.test(name)) return A('tdsReceivable', bal);
    if (/^tds\s+payable$/i.test(name)) return L('tdsPayable', -bal);
    if (/accumulated\s+depreciation/i.test(name)) return A('accumulatedDepreciation', bal); // contra → negative
    if (/loan|borrow|overdraft/i.test(name)) return L('loans', -bal);
    const type = guessAccountType(name, coaByName);
    if (type === 'Income' || type === 'Expense') return { bucket: 'pl', line: 'pl', value: bal };
    // Fixed assets / prepaid rescue — these names guess-fall to Equity when no
    // COA doc exists, so classify them by name BEFORE the bucket-by-type step.
    if (/prepaid/i.test(name)) return A('prepaid', bal);
    if (coaByName[name]?.subType === 'Fixed Asset'
      || /computer|av\s+equipment|plant|machiner|furniture|fixture|vehicle|land|building|^software$|fixed\s+asset/i.test(name)) return A('fixedAssets', bal);
    if (type === 'Asset') {
      if (/cash|bank/i.test(name) && !/charge|fee/i.test(name)) return A('cashAndBank', bal);
      return A('otherAssets', bal);
    }
    if (type === 'Liability') {
      if (/outstanding/i.test(name)) return L('outstandingExpenses', -bal);
      return L('otherLiabilities', -bal);
    }
    // Equity (incl. the guessAccountType fallback — visible, never dropped).
    if (/drawing/i.test(name)) return E('drawings', -bal);
    if (/\bcapital\b/i.test(name)) return E('capital', -bal);
    if (/opening\s+balance\s+equity/i.test(name)) return E('openingBalanceEquity', -bal);
    // P&L Closing carries a Dr balance after year-close — a NEGATIVE equity line
    // that offsets the transferred retained earnings (kills the closed-FY
    // profit double-count).
    if (/profit\s+and\s+loss\s+closing/i.test(name)) return E('plClosing', -bal);
    if (/retained\s+earnings/i.test(name)) return E('retainedEarnings', -bal);
    return E('otherEquity', -bal);
  };

  const bs = {
    assets: { cashAndBank: 0, accountsReceivable: 0, employeeAdvances: 0, inputGstCredit: 0, tdsReceivable: 0, prepaid: 0, fixedAssets: 0, accumulatedDepreciation: 0, suspense: 0, otherAssets: 0 },
    liabilities: { accountsPayable: 0, employeePayable: 0, gstPayableGross: 0, tdsPayable: 0, loans: 0, outstandingExpenses: 0, suspense: 0, otherLiabilities: 0 },
    equity: { capital: 0, drawings: 0, openingBalanceEquity: 0, plClosing: 0, retainedEarnings: 0, otherEquity: 0 },
  };
  let plRowsNet = 0; // income − expenses from the ACTUAL signed P&L balances
  ledger.forEach((row) => {
    const c = classifyBsRow(row);
    if (c.bucket === 'pl') plRowsNet += -c.value;
    else bs[c.bucket][c.line] += c.value;
  });
  Object.keys(bs).forEach((b) => Object.keys(bs[b]).forEach((k) => { bs[b][k] = round2(bs[b][k]); }));
  // The presented P&L clamps abnormal-sign rows; park the residue in otherEquity
  // so the identity survives (currentYearProfit + residue = actual P&L net).
  bs.equity.otherEquity = round2(bs.equity.otherEquity + (round2(plRowsNet) - netProfit));

  const cashBalance = bs.assets.cashAndBank;
  const receivableTotal = bs.assets.accountsReceivable;
  const advanceAsset = bs.assets.employeeAdvances;
  const inputGst = bs.assets.inputGstCredit;
  const payableTotal = bs.liabilities.accountsPayable;
  const employeePayable = bs.liabilities.employeePayable;
  // Legacy net-GST figure kept for the chat answer / digest compat.
  const gstPayable = round2(Math.max(bs.liabilities.gstPayableGross - inputGst, 0));
  const retainedEarningsLedger = bs.equity.retainedEarnings;

  const assetsTotal = round2(Object.values(bs.assets).reduce((s, v) => s + v, 0));
  const liabilitiesTotal = round2(Object.values(bs.liabilities).reduce((s, v) => s + v, 0));
  const equityTotal = round2(Object.values(bs.equity).reduce((s, v) => s + v, 0) + netProfit);

  return {
    clients,
    fyFilter,
    salesBook,  // INVOICED SALES (from tax_invoices)
    nonInvoicedSalesBook,  // NON-INVOICED SALES (from completed projects)
    purchaseBook,
    journal,
    ledger,
    // Diagnostic only: P&L rows clamped OUT of profitAndLoss by their abnormal sign.
    // `total` is the amount thereby absorbed into balanceSheet.equity.otherEquity.
    // Top-level (not nested in profitAndLoss) so existing consumers are untouched.
    plExceptions: { rows: plExceptions, total: plExceptionsTotal },
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
        ...bs.assets,
        cashAndBank: cashBalance,
        accountsReceivable: receivableTotal,
        employeeAdvances: advanceAsset,
        inputGstCredit: inputGst,
        total: assetsTotal,
      },
      liabilities: {
        ...bs.liabilities,
        accountsPayable: payableTotal,
        employeePayable,
        gstPayable, // legacy NET figure (output − input, floored) for answers/digest
        total: liabilitiesTotal,
      },
      equity: {
        ...bs.equity,
        retainedEarnings: retainedEarningsLedger,
        currentYearProfit: netProfit,
        total: equityTotal,
      },
      totalLiabilitiesAndEquity: round2(liabilitiesTotal + equityTotal),
      // Tripwire: ≈0 whenever the trial balance is balanced (A = L + E identity).
      unclassifiedDifference: round2(assetsTotal - liabilitiesTotal - equityTotal),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/aiAccountant/queries.js
// (queries.js imports round2 from schema.js — the closure preserves that.)
// ─────────────────────────────────────────────────────────────────────────────

const { buildBooksDigest, stripPrefix } = (() => {
  const round2 = schemaRound2;

  const SUBLEDGER_RE = /^(Party:|Employee:)\s*/;
  const stripPrefix = (account) => String(account || '').replace(SUBLEDGER_RE, '');

  /**
   * Compact, READ-ONLY digest of the books for the LLM ask-anything agent — "all
   * the read tools pre-executed": statements + capped account/party balances +
   * aging + GST/TDS. Pure; nothing here can post or write.
   * @param {object} snapshot buildAccountingSnapshot output
   * @param {{ asOn?:string, fy?:string, ageing?:object }} [extras]
   */
  function buildBooksDigest(snapshot = {}, extras = {}) {
    const ledger = Array.isArray(snapshot.ledger) ? snapshot.ledger : [];
    // Cash/bank sums exclude expense accounts that merely CONTAIN the word
    // ("Bank Charges" must not pollute the bank figure).
    const bal = (re) => ledger.filter((r) => re.test(r.account) && !/charge|fee|loan/i.test(r.account)).reduce((s, r) => s + (r.balance || 0), 0);
    const nonZero = ledger.filter((r) => Math.abs(r.balance || 0) > 0.5);
    const parties = nonZero.filter((r) => /^Party:/.test(r.account));
    const empRows = nonZero.filter((r) => /^Employee:/.test(r.account));
    const tb = snapshot.trialBalance || {};
    const tdsRow = ledger.find((r) => r.account === 'TDS Payable');
    return {
      as_on: extras.asOn || new Date().toISOString().slice(0, 10),
      fy: extras.fy || 'all',
      profit_and_loss: snapshot.profitAndLoss || {},
      balance_sheet: snapshot.balanceSheet || {},
      trial_balance: { totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, isBalanced: tb.isBalanced, difference: tb.difference },
      cash: round2(bal(/^cash/i)),
      bank: round2(bal(/^bank/i)),
      accounts: nonZero.slice(0, 250).map((r) => ({ a: r.account, bal: round2(r.balance) })),
      receivables: parties.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 40).map((r) => ({ name: stripPrefix(r.account), bal: round2(r.balance) })),
      payables: parties.filter((r) => r.balance < 0).sort((a, b) => a.balance - b.balance).slice(0, 40).map((r) => ({ name: stripPrefix(r.account), bal: round2(Math.abs(r.balance)) })),
      employee_receivables: empRows.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 20).map((r) => ({ name: stripPrefix(r.account), bal: round2(r.balance) })),
      employee_payables: empRows.filter((r) => r.balance < 0).sort((a, b) => a.balance - b.balance).slice(0, 20).map((r) => ({ name: stripPrefix(r.account), bal: round2(Math.abs(r.balance)) })),
      gst_payable: round2(snapshot.balanceSheet?.liabilities?.gstPayable || 0),
      tds_payable: tdsRow ? round2(Math.abs(Math.min(tdsRow.balance || 0, 0))) : 0,
      aging: extras.ageing ? {
        receivable_total: round2(extras.ageing.receivableTotals?.total || 0),
        receivable_90plus: round2(extras.ageing.receivableTotals?.['90_plus'] || 0),
        payable_total: round2(extras.ageing.payableTotals?.total || 0),
        payable_90plus: round2(extras.ageing.payableTotals?.['90_plus'] || 0),
      } : null,
    };
  }

  return { buildBooksDigest, stripPrefix };
})();

module.exports = {
  buildAccountingSnapshot,
  buildBooksDigest,
  // Ported helpers exported for tests / reuse:
  getFYFromDate,
  getFinancialYear,
  isProjectInvoiced,
  sumLogisticsRecord,
  inputGSTLines,
  round2,
  schemaRound2,
  getProjectRevenue,
  getOutsourcingCost,
  stripPrefix,
};
