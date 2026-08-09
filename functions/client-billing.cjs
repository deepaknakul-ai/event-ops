/**
 * PORT of src/utils/clientBilling.js (+ the src/utils/helpers.js functions it needs
 * that the server did not already have). CommonJS so Cloud Functions can require it.
 *
 * WHY A PORT: getPortalData and processDueReminders are pure backend — they cannot
 * import the ESM client module, yet they must answer "what has this client been
 * billed?" exactly as the public ledger does. Reading `tax_invoices` alone (what
 * they did before) misses every invoice raised through the project bulk/group flow,
 * which is stamped on the project as invoice_no with NO invoice document behind it.
 *
 * KEEP IN SYNC with src/utils/clientBilling.js and src/utils/helpers.js.
 * tests/client-billing-parity.test.js diffs the two implementations on a shared
 * fixture and fails if they drift — same guard books-digest.cjs uses.
 */
const { isProjectInvoiced, sumLogisticsRecord, round2 } = require('./books-digest.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/helpers.js
// ─────────────────────────────────────────────────────────────────────────────

const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v == null ? '' : v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const getProjectInvoiceReference = (project) => {
  const invoiceNo = String((project && project.invoice_no) || '').trim();
  if (!isProjectInvoiced(project && project.invoice_status) || !invoiceNo) return null;
  return { invoiceNo, invoiceDate: (project && project.invoice_date) || '' };
};

const isActiveTaxInvoice = (status) => {
  const v = String(status || '').trim().toLowerCase();
  return v !== 'cancelled' && v !== 'voided' && v !== 'void' && v !== 'rejected';
};

const getProjectReimbursableTotal = (project) =>
  round2(((project && project.reimbursable_expenses) || []).reduce((s, e) => s + toNum(e && e.amount), 0));

const reimbursablesInvoicedFor = (projectId, taxInvoices = []) =>
  round2((taxInvoices || []).reduce((sum, inv) => {
    if (!inv || !inv.reimbursables_included || !isActiveTaxInvoice(inv.status)) return sum;
    const ids = Array.isArray(inv.project_ids) ? inv.project_ids : (inv.project_id ? [inv.project_id] : []);
    if (!ids.includes(projectId)) return sum;
    const per = inv.reimbursable_by_project && inv.reimbursable_by_project[projectId];
    return sum + toNum(per != null ? per : 0);
  }, 0));

const getLogisticsLines = (typeId, typeLabel, record) => {
  if (!record) return [];
  const split = Array.isArray(record.lines) ? record.lines.filter(Boolean) : [];
  if (split.length > 0) {
    return split.map((l, i) => ({
      id: l.id || `${typeId}_${i}`,
      description: l.description || typeLabel,
      amount: parseFloat(l.amount || 0),
      gst: parseFloat(l.gst || 0),
    }));
  }
  const amount = parseFloat(record.amount || 0);
  if (amount <= 0 && record.amount === undefined) return [];
  return [{
    id: `${typeId}_legacy`,
    description: typeLabel,
    amount,
    gst: parseFloat(record.gst || 0),
  }];
};

const getProjectGSTBreakdown = (project, orgGSTIN, clientGSTIN) => {
  const orgState = (orgGSTIN || '').substring(0, 2);
  const clientState = (clientGSTIN || '').substring(0, 2);
  const isIntraState = orgState
    ? (clientState ? orgState === clientState : true)
    : false;
  const supplyType = isIntraState ? 'CGST_SGST' : 'IGST';

  const items = [];

  if (project.package_cost && project.package_cost > 0) {
    const pkg = parseFloat(project.package_cost);
    // A single agreed package price is split RATE-WISE using the GST-rate mix of
    // the underlying items + logistics, so mixed-rate packages produce a correct
    // per-slab GST (not one blended rate). Falls back to the single package GST
    // rate when there is no rate mix to learn from (pure lump sum, no items).
    const buckets = {};
    let mixBase = 0;
    (project.items || []).forEach((it) => {
      const b = parseFloat(it.amount || 0);
      if (b > 0) { const r = parseFloat(it.gst_rate != null ? it.gst_rate : 18); buckets[r] = (buckets[r] || 0) + b; mixBase += b; }
    });
    if (project.logistics_costs) {
      Object.entries(project.logistics_costs).forEach(([key, cost]) => {
        if (!cost) return;
        const labelBase = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
        getLogisticsLines(key, labelBase, cost).forEach((line) => {
          const b = parseFloat(line.amount || 0);
          if (b > 0) { const r = parseFloat(line.gst != null ? line.gst : 18); buckets[r] = (buckets[r] || 0) + b; mixBase += b; }
        });
      });
    }
    const rateEntries = mixBase > 0
      ? Object.entries(buckets).map(([r, b]) => ({ rate: parseFloat(r), base: b })).sort((a, b) => b.rate - a.rate)
      : [{ rate: parseFloat(project.package_cost_gst != null ? project.package_cost_gst : 18), base: pkg }];
    const totalBase = rateEntries.reduce((s, e) => s + e.base, 0) || 1;
    const multiRate = rateEntries.length > 1;
    let allocated = 0;
    rateEntries.forEach((e, idx) => {
      // Last slab absorbs the rounding remainder so the slabs sum exactly to the package.
      const taxable = idx === rateEntries.length - 1 ? round2(pkg - allocated) : round2(pkg * (e.base / totalBase));
      allocated = round2(allocated + taxable);
      const gstRate = e.rate;
      const gstAmt = taxable * (gstRate / 100);
      items.push({
        description: multiRate ? `Package Cost @ ${gstRate}%` : 'Package Cost',
        hsn: project.hsn_code || '998599',
        taxable,
        gstRate,
        cgstRate: isIntraState ? gstRate / 2 : 0,
        sgstRate: isIntraState ? gstRate / 2 : 0,
        igstRate: isIntraState ? 0 : gstRate,
        cgstAmt: isIntraState ? gstAmt / 2 : 0,
        sgstAmt: isIntraState ? gstAmt / 2 : 0,
        igstAmt: isIntraState ? 0 : gstAmt,
        total: taxable + gstAmt,
      });
    });
  } else {
    (project.items || []).forEach((item) => {
      // Guard with != null: a legitimate 0% rate must NOT be coerced to 18%.
      const gstRate = parseFloat(item.gst_rate != null ? item.gst_rate : 18);
      const taxable = parseFloat(item.amount || 0);
      const gstAmt = item.gst_amount != null ? parseFloat(item.gst_amount) : taxable * (gstRate / 100);
      items.push({
        description: item.item_name,
        hsn: item.hsn_code || '998599',
        qty: item.qty,
        rate: item.rate,
        days: item.days,
        taxable,
        gstRate,
        cgstRate: isIntraState ? gstRate / 2 : 0,
        sgstRate: isIntraState ? gstRate / 2 : 0,
        igstRate: isIntraState ? 0 : gstRate,
        cgstAmt: isIntraState ? gstAmt / 2 : 0,
        sgstAmt: isIntraState ? gstAmt / 2 : 0,
        igstAmt: isIntraState ? 0 : gstAmt,
        total: taxable + gstAmt,
      });
    });
    if (project.logistics_costs) {
      Object.entries(project.logistics_costs).forEach(([key, cost]) => {
        if (!cost) return;
        const labelBase = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
        const lines = getLogisticsLines(key, labelBase, cost);
        lines.forEach((line) => {
          if (!line.amount && !line.gst) return;
          // 0% logistics (e.g. Transportation) must stay 0% — never `|| 18`.
          const gstRate = parseFloat(line.gst != null ? line.gst : 18);
          const taxable = parseFloat(line.amount || 0);
          const gstAmt = taxable * (gstRate / 100);
          items.push({
            description: line.description !== labelBase ? `${labelBase} — ${line.description}` : labelBase,
            hsn: '996812',
            taxable,
            gstRate,
            cgstRate: isIntraState ? gstRate / 2 : 0,
            sgstRate: isIntraState ? gstRate / 2 : 0,
            igstRate: isIntraState ? 0 : gstRate,
            cgstAmt: isIntraState ? gstAmt / 2 : 0,
            sgstAmt: isIntraState ? gstAmt / 2 : 0,
            igstAmt: isIntraState ? 0 : gstAmt,
            total: taxable + gstAmt,
          });
        });
      });
    }
  }

  const totals = items.reduce((acc, item) => {
    acc.taxable += item.taxable;
    acc.cgstAmt += item.cgstAmt;
    acc.sgstAmt += item.sgstAmt;
    acc.igstAmt += item.igstAmt;
    acc.total += item.total;
    return acc;
  }, { taxable: 0, cgstAmt: 0, sgstAmt: 0, igstAmt: 0, total: 0 });

  return { supplyType, items, totals, placeOfSupply: clientState || orgState };
};

const getProjectGrandTotal = (project) => {
  if (!project) return 0;
  // Package cost supersedes all other costs. Rate-wise so a mixed-rate package
  // matches the issued invoice; a pure lump sum falls back to package_cost_gst.
  if (project.package_cost && project.package_cost > 0) {
    return round2(getProjectGSTBreakdown(project, '', '').totals.total);
  }
  const equipment = (project.items || []).reduce((acc, i) => acc + toNum(i.total), 0);
  let logistics = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach((c) => {
      logistics += sumLogisticsRecord(c).total;
    });
  }
  return round2(equipment + logistics);
};

// ─────────────────────────────────────────────────────────────────────────────
// PORTED from src/utils/clientBilling.js — see that file for the full rationale.
// ─────────────────────────────────────────────────────────────────────────────

const BILLING_KIND = {
  INVOICE: 'invoice',
  PROJECT_INVOICE: 'project_invoice',
  UNBILLED: 'unbilled',
  REIMBURSABLE: 'reimbursable',
};

const DELIVERED_STATUSES = ['Completed', 'Closed'];

const buildClientBillingRows = ({ clientId, projects = [], taxInvoices = [] } = {}) => {
  const rows = [];

  const activeClientInvoices = (taxInvoices || []).filter((inv) =>
    inv && isActiveTaxInvoice(inv.status) && (!clientId || !inv.client_id || inv.client_id === clientId));

  const invoicedPids = new Set();
  activeClientInvoices.forEach((inv) => {
    const pids = Array.isArray(inv.project_ids) ? inv.project_ids : (inv.project_id ? [inv.project_id] : []);
    pids.forEach((pid) => pid && invoicedPids.add(pid));
  });

  const mine = (projects || []).filter((p) => p && p.client_id === clientId);

  mine
    .filter((p) => DELIVERED_STATUSES.includes(p.status) && !invoicedPids.has(p.id))
    .forEach((p) => {
      const invoiceRef = getProjectInvoiceReference(p);
      rows.push({
        kind: invoiceRef ? BILLING_KIND.PROJECT_INVOICE : BILLING_KIND.UNBILLED,
        date: invoiceRef ? (invoiceRef.invoiceDate || p.end_date) : p.end_date,
        desc: invoiceRef
          ? `Invoice ${invoiceRef.invoiceNo}: ${p.project_name}`
          : `Unbilled: ${p.project_name} (completed — awaiting invoice)`,
        amount: getProjectGrandTotal(p),
        invoice_status: invoiceRef ? 'Invoiced' : 'Unbilled',
        invoice_no: (invoiceRef && invoiceRef.invoiceNo) || '—',
        invoice_date: (invoiceRef && invoiceRef.invoiceDate) || '—',
        project_id: p.id,
        project_name: p.project_name || '',
        company_source_id: p.party_company_id,
      });
    });

  mine
    .filter((p) => (p.reimbursable_expenses || []).length > 0)
    .forEach((p) => {
      const invoiced = reimbursablesInvoicedFor(p.id, activeClientInvoices);
      if (invoiced > 0 && invoiced >= getProjectReimbursableTotal(p) - 0.005) return;
      let absorbed = invoiced;
      (p.reimbursable_expenses || []).forEach((e, i) => {
        const amt = parseFloat((e && e.amount) || 0);
        if (!(amt > 0)) return;
        const net = Math.max(0, amt - Math.min(absorbed, amt));
        absorbed = Math.max(0, absorbed - amt);
        if (net <= 0.005) return;
        rows.push({
          kind: BILLING_KIND.REIMBURSABLE,
          date: e.date || p.end_date,
          desc: `Reimbursable: ${e.description || e.category || 'Expense'} (${p.project_name})`,
          amount: net,
          invoice_status: 'Reimbursable',
          invoice_no: '—',
          invoice_date: '—',
          project_id: p.id,
          project_name: p.project_name || '',
          reimbursable_id: e.id || `${p.id}_${i}`,
          proof_url: e.proof_url || '',
          proof_name: e.proof_name || '',
          company_source_id: p.party_company_id,
        });
      });
    });

  activeClientInvoices.forEach((inv) => {
    const projNames = (Array.isArray(inv.project_names) && inv.project_names.length)
      ? inv.project_names.join(', ')
      : (inv.project_name || '');
    rows.push({
      kind: BILLING_KIND.INVOICE,
      date: inv.invoice_date,
      desc: `Invoice ${inv.invoice_no || '—'}${projNames ? `: ${projNames}` : ''}`,
      amount: parseFloat(inv.final_amount != null ? inv.final_amount : (inv.computed_total || 0)),
      invoice_status: 'Invoiced',
      invoice_no: inv.invoice_no || '—',
      invoice_date: inv.invoice_date || '—',
      company_source_id: inv.sale_company_id,
    });
  });

  return rows;
};

const summariseClientBilling = (rows = [], payments = []) => {
  let invoiced = 0; let unbilled = 0; let reimbursable = 0;
  (rows || []).forEach((r) => {
    if (!r) return;
    if (r.kind === BILLING_KIND.INVOICE || r.kind === BILLING_KIND.PROJECT_INVOICE) invoiced += toNum(r.amount);
    else if (r.kind === BILLING_KIND.UNBILLED) unbilled += toNum(r.amount);
    else if (r.kind === BILLING_KIND.REIMBURSABLE) reimbursable += toNum(r.amount);
  });
  const billed = round2(invoiced + unbilled + reimbursable);
  const received = round2((payments || []).reduce((s, p) => s + toNum(p && p.amount), 0));
  return {
    invoiced: round2(invoiced),
    unbilled: round2(unbilled),
    reimbursable: round2(reimbursable),
    billed,
    received,
    outstanding: round2(billed - received),
  };
};

const buildClientInvoiceList = (rows = []) => {
  const out = [];
  const stamped = new Map();
  (rows || []).forEach((r) => {
    if (!r) return;
    if (r.kind === BILLING_KIND.INVOICE) {
      out.push({
        invoice_no: r.invoice_no,
        date: r.invoice_date && r.invoice_date !== '—' ? r.invoice_date : (r.date || ''),
        amount: round2(toNum(r.amount)),
        projects: 1,
        source: 'document',
      });
      return;
    }
    if (r.kind !== BILLING_KIND.PROJECT_INVOICE) return;
    const key = r.invoice_no;
    if (!stamped.has(key)) {
      const entry = { invoice_no: key, date: r.date || '', amount: 0, projects: 0, source: 'stamp' };
      stamped.set(key, entry);
      out.push(entry);
    }
    const entry = stamped.get(key);
    entry.amount = round2(entry.amount + toNum(r.amount));
    entry.projects += 1;
    if (r.date && (!entry.date || r.date < entry.date)) entry.date = r.date;
  });
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
};

module.exports = {
  BILLING_KIND,
  buildClientBillingRows,
  summariseClientBilling,
  buildClientInvoiceList,
  // Ported helpers exported for tests / reuse:
  toNum,
  isActiveTaxInvoice,
  getProjectInvoiceReference,
  getProjectReimbursableTotal,
  reimbursablesInvoicedFor,
  getLogisticsLines,
  getProjectGSTBreakdown,
  getProjectGrandTotal,
};
