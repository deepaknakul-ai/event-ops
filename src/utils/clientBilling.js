/**
 * CLIENT BILLING — the single definition of "what has this client been billed?"
 *
 * These rules were previously inlined in PublicLedger.jsx and NOWHERE else, so the
 * public ledger was right while every other surface invented its own answer. The
 * worst offender was getPortalData, which counted only `tax_invoices` documents.
 *
 * That matters because an invoice reaches a project by TWO different routes:
 *
 *   1. a `tax_invoices` DOCUMENT              — project_ids[] point back at it
 *   2. a STAMP on the project itself          — invoice_no / invoice_date /
 *                                               invoice_status, with no document
 *
 * Route 2 is how the bulk/group invoice flow works, and it is not a rare legacy
 * case: at the time of writing 9 invoices worth ~84 lakh exist ONLY as a stamp,
 * against just 5 real invoice documents. Reading `tax_invoices` alone showed six
 * clients either a NEGATIVE outstanding (their payments counted, their invoices
 * did not) or a silent zero while lakhs were due.
 *
 * PRECEDENCE, unchanged from the ledger:
 *   - A tax invoice is the source of truth for the amount due. It debits the
 *     client at its FINAL (agreed, tax-inclusive) amount and SUPERSEDES the
 *     per-project quotes it covers — a clubbed invoice is ONE row, not N.
 *   - A project covered by no invoice document falls back to its own stamp, and
 *     failing that shows as "Unbilled".
 *   - Reimbursables are money the client repays ON TOP of the project value, so
 *     they are never folded into it, and never appear both here and on an invoice.
 *
 * Mirrored VERBATIM by functions/client-billing.cjs for the server (portal +
 * reminders), guarded by tests/client-billing-parity.test.js. Change both.
 */
import {
  getProjectGrandTotal,
  getProjectInvoiceReference,
  getProjectReimbursableTotal,
  isActiveTaxInvoice,
  reimbursablesInvoicedFor,
  round2,
  toNum,
} from './helpers';

/** Row kinds. INVOICE and PROJECT_INVOICE are both "invoiced"; they differ only in provenance. */
export const BILLING_KIND = {
  INVOICE: 'invoice', // backed by a tax_invoices document
  PROJECT_INVOICE: 'project_invoice', // invoice_no stamped on the project, no document
  UNBILLED: 'unbilled', // delivered, awaiting invoice
  REIMBURSABLE: 'reimbursable', // client-repayable expense not absorbed by an invoice
};

/** A project only reaches the client's ledger once it has actually been delivered. */
const DELIVERED_STATUSES = ['Completed', 'Closed'];

/**
 * Every debit row for one client, in the ledger's own push order (projects,
 * then reimbursables, then invoices). Callers sort by date themselves.
 *
 * `taxInvoices` is expected to be pre-scoped to the client (both getLedgerData and
 * getPortalData query `where('client_id','==',cid)`); any invoice that does carry a
 * mismatched client_id is dropped defensively, so an unscoped caller is still safe.
 */
export const buildClientBillingRows = ({ clientId, projects = [], taxInvoices = [] } = {}) => {
  const rows = [];

  const activeClientInvoices = (taxInvoices || []).filter((inv) =>
    inv && isActiveTaxInvoice(inv.status) && (!clientId || !inv.client_id || inv.client_id === clientId));

  // Projects reached by an invoice DOCUMENT — their quotes are superseded by it.
  const invoicedPids = new Set();
  activeClientInvoices.forEach((inv) => {
    const pids = Array.isArray(inv.project_ids) ? inv.project_ids : (inv.project_id ? [inv.project_id] : []);
    pids.forEach((pid) => pid && invoicedPids.add(pid));
  });

  const mine = (projects || []).filter((p) => p && p.client_id === clientId);

  // 1. Delivered projects NOT covered by an invoice document. A project-side stamp
  //    still counts as invoiced — that is the bulk/group invoice flow — so it shows
  //    its invoice number rather than being misreported as unbilled.
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
        invoice_no: invoiceRef?.invoiceNo || '—',
        invoice_date: invoiceRef?.invoiceDate || '—',
        project_id: p.id,
        project_name: p.project_name || '',
        company_source_id: p.party_company_id,
      });
    });

  // 2. Reimbursables the client repays on top, dated by when the expense was
  //    incurred. Whatever an invoice already absorbed is consumed oldest-first, so a
  //    reimbursable appears on the invoice OR here — never both — and one added
  //    AFTER the invoice correctly stays outstanding.
  mine
    .filter((p) => (p.reimbursable_expenses || []).length > 0)
    .forEach((p) => {
      const invoiced = reimbursablesInvoicedFor(p.id, activeClientInvoices);
      if (invoiced > 0 && invoiced >= getProjectReimbursableTotal(p) - 0.005) return; // fully billed on an invoice
      let absorbed = invoiced;
      (p.reimbursable_expenses || []).forEach((e, i) => {
        const amt = parseFloat(e?.amount || 0);
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

  // 3. Raised tax invoices — one row each at the billed (final) amount.
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

/**
 * Totals for the summary tiles. `billed` deliberately includes delivered-but-
 * un-invoiced work and outstanding reimbursables, because that is what the ledger
 * carries as a debit — the split is returned alongside so a caller can show it.
 */
export const summariseClientBilling = (rows = [], payments = []) => {
  let invoiced = 0; let unbilled = 0; let reimbursable = 0;
  (rows || []).forEach((r) => {
    if (!r) return;
    if (r.kind === BILLING_KIND.INVOICE || r.kind === BILLING_KIND.PROJECT_INVOICE) invoiced += toNum(r.amount);
    else if (r.kind === BILLING_KIND.UNBILLED) unbilled += toNum(r.amount);
    else if (r.kind === BILLING_KIND.REIMBURSABLE) reimbursable += toNum(r.amount);
  });
  const billed = round2(invoiced + unbilled + reimbursable);
  const received = round2((payments || []).reduce((s, p) => s + toNum(p?.amount), 0));
  return {
    invoiced: round2(invoiced),
    unbilled: round2(unbilled),
    reimbursable: round2(reimbursable),
    billed,
    received,
    outstanding: round2(billed - received),
  };
};

/**
 * The client-facing invoice list. Invoice documents pass through one-for-one;
 * stamped projects are GROUPED under their shared invoice number so a 33-project
 * bulk invoice reads as a single line, matching how a real invoice would.
 */
export const buildClientInvoiceList = (rows = []) => {
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
    // Earliest stamped date wins, so the group carries the date the invoice was raised.
    if (r.date && (!entry.date || r.date < entry.date)) entry.date = r.date;
  });
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
};
