import React, { useState, useMemo } from 'react';
import {
  Plus, Search, Edit, Trash2, FileText, X, CheckCircle,
  AlertCircle, Download, Receipt, ChevronDown, Zap, XCircle, Eye, CreditCard, FileCheck
} from 'lucide-react';
import {
  collection, addDoc, updateDoc, doc, deleteDoc,
  getDoc, writeBatch
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';
import { Modal, ConfirmDeleteModal, SendMenu } from '../components/Shared';
import {
  formatCurrency, formatCurrencyPDF, fmtDate,
  getFYFromDate, getProjectGSTBreakdown, sumLogisticsRecord, getProjectGrandTotal, amountToWordsINR, round2
} from '../utils/helpers';
import { GST_STATE_CODES } from '../utils/constants';
import { generateClassicInvoicePDF, generateGSTFormatInvoicePDF } from '../utils/pdf/taxInvoicePdf';
import { generateBookInvoiceNumber } from '../utils/accounting';
import { assertFYNotLocked } from '../utils/fyLock';
import { can } from '../utils/permissions';

// ─── local helpers ────────────────────────────────────────────────────────────
const getInvoiceType = (selectedPids, projects) => {
  const selected = projects.filter(p => selectedPids.includes(p.id));
  if (selected.length === 0) return 'Invoice';
  const hasSettled = selected.some(p => p.status === 'Settled');
  if (selected.length === 1 && !hasSettled) return 'Invoice';
  if (selected.length === 1 && hasSettled) return 'Settled Invoice';
  if (selected.length > 1 && hasSettled) return 'Clubbed & Settled Invoice';
  return 'Clubbed Invoice';
};

const computeProjectsTotals = (selectedPids, projects) => {
  let taxable = 0, gstAmt = 0, total = 0;
  for (const id of selectedPids) {
    const p = projects.find(x => x.id === id);
    if (!p) continue;
    if (p.package_cost && p.package_cost > 0) {
      // Rate-wise package split (mirrors getProjectGSTBreakdown). GSTIN args are
      // irrelevant here — we only need the taxable/GST totals, not the Dr/Cr split.
      const bd = getProjectGSTBreakdown(p, '', '');
      taxable += bd.totals.taxable;
      gstAmt += (bd.totals.cgstAmt + bd.totals.sgstAmt + bd.totals.igstAmt);
      total += bd.totals.total;
    } else {
      (p.items || []).forEach(i => { taxable += i.amount || 0; gstAmt += i.gst_amount || 0; total += i.total || 0; });
      Object.values(p.logistics_costs || {}).forEach(c => {
        // H-10: split line items aware
        const s = sumLogisticsRecord(c);
        taxable += s.amount; gstAmt += s.gstAmount; total += s.total;
      });
    }
  }
  return { taxable, gstAmt, total };
};

const parseCreditDays = (billing_terms) => {
  if (!billing_terms) return 45;
  const m = String(billing_terms).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 45;
};

const TYPE_BADGE = {
  'Invoice':                    'bg-blue-100 text-blue-700 border-blue-200',
  'Clubbed Invoice':            'bg-purple-100 text-purple-700 border-purple-200',
  'Clubbed & Settled Invoice':  'bg-orange-100 text-orange-700 border-orange-200',
  'Settled Invoice':            'bg-teal-100 text-teal-700 border-teal-200',
};

const STATUS_COLORS = {
  Quoted: 'bg-orange-100 text-orange-700', Confirmed: 'bg-green-100 text-green-700',
  Ongoing: 'bg-red-100 text-red-700', Completed: 'bg-blue-100 text-blue-700',
  Closed: 'bg-slate-800 text-white', Settled: 'bg-teal-100 text-teal-700',
  Cancelled: 'bg-gray-100 text-gray-500',
};

// ─── component ────────────────────────────────────────────────────────────────
const TaxInvoices = ({
  db, appId, role, user, logAction, addToast,
  taxInvoices = [], projects = [], clients = [], payments = [], lockedFYs = []
}) => {
  const [search, setSearch]             = useState('');
  const [filterClient, setFilterClient] = useState('');
  const [filterFY, setFilterFY]         = useState('All');
  const [activeTab, setActiveTab]       = useState('invoices');
  const [modalOpen, setModalOpen]       = useState(false);
  const [editingId, setEditingId]       = useState(null);
  const [saving, setSaving]             = useState(false);
  const [invGenLoading, setInvGenLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, invoice: null });
  const [cancelConfirm, setCancelConfirm] = useState({ isOpen: false, invoice: null });
  const [cancelReason, setCancelReason]   = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');

  const initialForm = {
    client_id: '', project_ids: [], invoice_no: '',
    invoice_date: new Date().toISOString().split('T')[0],
    due_date: '', remarks: '', final_amount: '', sale_mode: 'Credit',
    sale_company_id: 'primary', sale_company_name: '', sale_company_gstin: '', sale_company_address: '',
    // Optional Transportation / PO details (GST-format invoice; render only when filled)
    po_number: '', po_date: '', transport_name: '', vehicle_number: '', delivery_date: '', delivery_location: '',
  };
  const [form, setForm] = useState(initialForm);

  const getPartyCompanies = (party) => {
    if (!party) return [];
    const primary = {
      id: 'primary',
      name: party.name || 'Primary Company',
      gstin: party.gstin || '',
      address: party.address || '',
    };
    const extras = (party.companies || []).map(c => ({
      id: c.id,
      name: c.name || 'Branch',
      gstin: c.gstin || '',
      address: c.address || '',
    }));
    return [primary, ...extras];
  };

  const makeClientEntityValue = (clientId, companyId = 'primary') => (
    companyId && companyId !== 'primary' ? `${clientId}::${companyId}` : clientId
  );

  const clientEntityOptions = useMemo(() => {
    const options = [];
    clients
      .filter(c => c.type !== 'Vendor')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .forEach(c => {
        const companies = getPartyCompanies(c);
        companies.forEach(co => {
          options.push({
            value: makeClientEntityValue(c.id, co.id),
            client_id: c.id,
            company_id: co.id,
            company_name: co.name,
            company_gstin: co.gstin,
            company_address: co.address,
            label: co.id === 'primary' ? c.name : `${c.name} — ${co.name}`,
          });
        });
      });
    return options;
  }, [clients]);

  // ── derived state ──────────────────────────────────────────────────────────
  const clientProjects = useMemo(() => {
    if (!form.client_id) return [];
    const selectedSet = new Set(form.project_ids || []);
    return projects
      .filter(p => p.client_id === form.client_id)
      .filter(p => {
        // Show only Completed + not invoiced projects for new selection,
        // but keep selected projects visible during edit.
        if (selectedSet.has(p.id)) return true;
        const isCompleted = p.status === 'Completed';
        const notInvoiced = p.invoice_status !== 'Invoiced' && !p.tax_invoice_id;
        return isCompleted && notInvoiced;
      })
      .filter(p => !projectSearch || p.project_name?.toLowerCase().includes(projectSearch.toLowerCase()))
      .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
  }, [form.client_id, form.project_ids, projects, projectSearch]);

  const computedTotals = useMemo(
    () => computeProjectsTotals(form.project_ids, projects),
    [form.project_ids, projects]
  );

  const invoiceType = useMemo(
    () => getInvoiceType(form.project_ids, projects),
    [form.project_ids, projects]
  );

  // Clubbing guard: warn when the selected projects mix intra-state (CGST+SGST)
  // and inter-state (IGST) supply — they cannot share one GST invoice cleanly.
  const mixedSupply = useMemo(() => {
    const types = new Set(
      (form.project_ids || [])
        .map(pid => projects.find(p => p.id === pid)?.supply_type)
        .filter(Boolean)
    );
    return types.size > 1;
  }, [form.project_ids, projects]);

  const lastInvoiceDate = useMemo(() =>
    taxInvoices
      .filter(i => editingId ? i.id !== editingId : true)
      .reduce((max, i) => (i.invoice_date > max ? i.invoice_date : max), ''),
    [taxInvoices, editingId]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return taxInvoices
      .filter(inv => {
        if (!showCancelled && inv.status === 'Cancelled') return false;
        if (search && !`${inv.invoice_no} ${inv.client_name} ${inv.remarks || ''}`.toLowerCase().includes(q)) return false;
        if (filterClient && inv.client_id !== filterClient) return false;
        if (filterFY !== 'All' && getFYFromDate(inv.invoice_date) !== filterFY) return false;
        return true;
      })
      .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  }, [taxInvoices, search, filterClient, filterFY, showCancelled]);

  const fyOptions = useMemo(() => {
    const fys = new Set(taxInvoices.map(i => getFYFromDate(i.invoice_date)));
    return ['All', ...Array.from(fys).sort().reverse()];
  }, [taxInvoices]);

  const totalAmount = filtered.reduce((s, i) => s + (i.final_amount || 0), 0);

  // ── Unbilled Projects ──────────────────────────────────────────────────────
  const unbilledProjects = useMemo(() => {
    return projects
      .filter(p => (p.status === 'Completed' || p.status === 'Closed') &&
                   p.invoice_status !== 'Invoiced' &&
                   !p.tax_invoice_id)
      .sort((a, b) => (a.end_date || '').localeCompare(b.end_date || ''));
  }, [projects]);

  const openCreateForProject = (project) => {
    setEditingId(null);
    setProjectSearch('');
    setClientSearch('');
    setForm({ ...initialForm, client_id: project.client_id, project_ids: [project.id] });
    setModalOpen(true);
  };

  // ── helpers ────────────────────────────────────────────────────────────────
  const getOrgSettings = async () => {
    try {
      const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
      if (snap.exists()) return snap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const generateInvoiceNo = async (dateStr) => {
    const orgSettings = (await getOrgSettings()) || {};
    return generateBookInvoiceNumber({
      db,
      appId,
      dateStr,
      bookType: 'sales',
      orgSettings,
    });
  };

  const computeDueDate = (invoiceDateStr, clientId) => {
    if (!invoiceDateStr) return '';
    const c = clients.find(x => x.id === clientId);
    const days = parseCreditDays(c?.billing_terms);
    const d = new Date(invoiceDateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  // ── modal actions ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setEditingId(null);
    setProjectSearch('');
    setClientSearch('');
    setForm(initialForm);
    setModalOpen(true);
  };

  const openEdit = (inv) => {
    setEditingId(inv.id);
    setProjectSearch('');
    setClientSearch('');
    setForm({
      client_id: inv.client_id || '',
      project_ids: inv.project_ids || [],
      invoice_no: inv.invoice_no || '',
      invoice_date: inv.invoice_date || new Date().toISOString().split('T')[0],
      due_date: inv.due_date || '',
      remarks: inv.remarks || '',
      final_amount: inv.final_amount != null ? String(inv.final_amount) : '',
      sale_mode: inv.sale_mode || 'Credit',
      sale_company_id: inv.sale_company_id || 'primary',
      sale_company_name: inv.sale_company_name || '',
      sale_company_gstin: inv.sale_company_gstin || '',
      sale_company_address: inv.sale_company_address || '',
      po_number: inv.po_number || '', po_date: inv.po_date || '',
      transport_name: inv.transport_name || '', vehicle_number: inv.vehicle_number || '',
      delivery_date: inv.delivery_date || '', delivery_location: inv.delivery_location || '',
    });
    setModalOpen(true);
  };

  const filteredClientEntityOptions = useMemo(() => {
    const q = (clientSearch || '').trim().toLowerCase();
    if (!q) return clientEntityOptions;
    return clientEntityOptions.filter(o =>
      (o.label || '').toLowerCase().includes(q) ||
      (o.company_gstin || '').toLowerCase().includes(q)
    );
  }, [clientEntityOptions, clientSearch]);

  const toggleProject = (pid) => {
    setForm(f => {
      const next = f.project_ids.includes(pid)
        ? f.project_ids.filter(x => x !== pid)
        : [...f.project_ids, pid];
      return { ...f, project_ids: next };
    });
  };

  // ── save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!can(role, 'tax_invoices', 'create')) return addToast('Access denied.', 'error');
    if (!form.client_id) return addToast('Select a client.', 'error');
    if (form.project_ids.length === 0) return addToast('Select at least one project.', 'error');
    if (!form.invoice_no.trim()) return addToast('Invoice number is required.', 'error');
    if (!form.invoice_date) return addToast('Invoice date is required.', 'error');
    if (lastInvoiceDate && form.invoice_date < lastInvoiceDate)
      return addToast(`Invoice date cannot be before last invoice date: ${fmtDate(lastInvoiceDate)}`, 'error');
    // C-2 fix: enforce FY lock here too — was previously only in Finance.jsx.
    if (!assertFYNotLocked(form.invoice_date, lockedFYs)) return;
    // H-2 fix: prevent silent edit of an issued invoice in a locked FY by also
    // checking the original invoice_date when editing.
    if (editingId) {
      const prev = taxInvoices.find(i => i.id === editingId);
      if (prev?.invoice_date && !assertFYNotLocked(prev.invoice_date, lockedFYs)) return;
    }

    setSaving(true);
    try {
      const client = clients.find(c => c.id === form.client_id);
      const companies = getPartyCompanies(client);
      const selectedCompany = companies.find(c => c.id === (form.sale_company_id || 'primary')) || companies[0] || null;
      const totals = computedTotals;
      const finalAmt = form.final_amount !== '' ? parseFloat(form.final_amount) : totals.total;
      const type = invoiceType;

      const linked = projects.filter(p => form.project_ids.includes(p.id));
      const projectNames = linked.map(p => p.project_name || '').filter(Boolean);

      // H-12 fix: Snapshot organisation master onto the invoice at issue time so
      // re-prints don't rewrite history when org name/GSTIN/address changes later.
      let orgSnapshot = null;
      try {
        const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (orgSnap.exists()) {
          const o = orgSnap.data() || {};
          orgSnapshot = {
            name: o.name || '',
            gstin: o.gstin || '',
            pan: o.pan || '',
            address: o.address || '',
            state: o.state || '',
            phone: o.phone || '',
            email: o.email || '',
            logo_url: o.logo_url || '',
            bank_name: o.bank_name || '',
            bank_account: o.bank_account || '',
            ifsc: o.ifsc || '',
            snapshot_at: new Date().toISOString(),
          };
        }
      } catch (_) { /* non-fatal */ }

      // H-12 / Master-data G-4: Snapshot the bill-to client master at issue.
      const billToSnapshot = {
        name: selectedCompany?.name || client?.name || '',
        gstin: selectedCompany?.gstin || client?.gstin || '',
        address: selectedCompany?.address || client?.address || '',
        state: client?.state || '',
        snapshot_at: new Date().toISOString(),
      };

      // M-7: persist CGST/SGST/IGST split at issue. Aggregates the per-project
      // breakdown using the captured org/bill-to GSTINs (not the live values),
      // so reprints + GSTR exports stay consistent with what the customer
      // originally received.
      const orgGstinForSplit = orgSnapshot?.gstin || '';
      const billGstinForSplit = billToSnapshot.gstin || '';
      let cgstAmt = 0, sgstAmt = 0, igstAmt = 0;
      let supplyType = 'CGST_SGST';
      let placeOfSupply = '';
      const rateBuckets = {}; // gstRate -> { taxable, cgst, sgst, igst } — for rate-wise GSTR-1
      try {
        for (const pid of form.project_ids) {
          const p = projects.find(x => x.id === pid);
          if (!p) continue;
          const bd = getProjectGSTBreakdown(p, orgGstinForSplit, billGstinForSplit);
          cgstAmt += bd.totals.cgstAmt || 0;
          sgstAmt += bd.totals.sgstAmt || 0;
          igstAmt += bd.totals.igstAmt || 0;
          supplyType = bd.supplyType;
          placeOfSupply = bd.placeOfSupply || placeOfSupply;
          (bd.items || []).forEach((it) => {
            const r = Number(it.gstRate || 0);
            if (!rateBuckets[r]) rateBuckets[r] = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
            rateBuckets[r].taxable += it.taxable || 0;
            rateBuckets[r].cgst += it.cgstAmt || 0;
            rateBuckets[r].sgst += it.sgstAmt || 0;
            rateBuckets[r].igst += it.igstAmt || 0;
          });
        }
      } catch (_) { /* breakdown helper failure is non-fatal */ }
      // ── Reconcile the tax breakdown to the FINAL (gross, tax-inclusive) amount ──
      // The user enters `final_amount` as the agreed amount INCLUDING GST. Scale
      // the computed taxable/GST/CGST/SGST/IGST so that taxable + GST === final
      // amount exactly. When no override is given, finalAmt === computed total
      // and scale === 1 (no change). This keeps the invoice value, the GST split,
      // the PDF, the books and GSTR all internally consistent.
      const computedTotal = totals.total;
      const scale = computedTotal > 0 ? finalAmt / computedTotal : 1;
      const taxableFinal = computedTotal > 0 ? round2(totals.taxable * scale) : round2(finalAmt);
      const gstFinal = round2(finalAmt - taxableFinal);
      let cgstFinal = 0, sgstFinal = 0, igstFinal = 0;
      if (supplyType === 'IGST') {
        igstFinal = gstFinal;
      } else {
        cgstFinal = round2(gstFinal / 2);
        sgstFinal = round2(gstFinal - cgstFinal);
      }
      // Rate-wise breakup (scaled to the reconciled totals) for rate-wise GSTR-1.
      const gstBreakup = Object.entries(rateBuckets)
        .map(([rate, b]) => ({
          rate: Number(rate),
          taxable: round2((b.taxable || 0) * scale),
          cgst: round2((b.cgst || 0) * scale),
          sgst: round2((b.sgst || 0) * scale),
          igst: round2((b.igst || 0) * scale),
        }))
        .filter(b => b.taxable > 0 || b.cgst > 0 || b.sgst > 0 || b.igst > 0)
        .sort((a, b) => b.rate - a.rate);
      const gstSplit = {
        supply_type: supplyType,
        cgst_amount: cgstFinal,
        sgst_amount: sgstFinal,
        igst_amount: igstFinal,
        place_of_supply: placeOfSupply,
        org_gstin: orgGstinForSplit,
        bill_to_gstin: billGstinForSplit,
        gst_breakup: gstBreakup,
      };

      const invoiceData = {
        client_id: form.client_id,
        client_name: client?.name || '',
        sale_company_id: selectedCompany?.id || 'primary',
        sale_company_name: selectedCompany?.name || client?.name || '',
        sale_company_gstin: selectedCompany?.gstin || client?.gstin || '',
        sale_company_address: selectedCompany?.address || client?.address || '',
        project_ids: form.project_ids,
        project_names: projectNames,
        invoice_no: form.invoice_no.trim(),
        invoice_date: form.invoice_date,
        due_date: form.due_date,
        taxable: taxableFinal,
        gst_amount: gstFinal,
        // M-7: CGST/SGST/IGST split (reflects org vs bill-to state at issue),
        // reconciled to the gross final amount so taxable + GST === final_amount.
        supply_type: gstSplit.supply_type,
        cgst_amount: gstSplit.cgst_amount,
        sgst_amount: gstSplit.sgst_amount,
        igst_amount: gstSplit.igst_amount,
        gst_breakup: gstSplit.gst_breakup,
        place_of_supply: gstSplit.place_of_supply,
        org_gstin_at_issue: gstSplit.org_gstin,
        bill_to_gstin_at_issue: gstSplit.bill_to_gstin,
        computed_total: totals.total,
        final_amount: finalAmt,
        sale_mode: form.sale_mode || 'Credit',
        remarks: form.remarks,
        // Optional Transportation / PO details (GST-format invoice)
        po_number: form.po_number || '', po_date: form.po_date || '',
        transport_name: form.transport_name || '', vehicle_number: form.vehicle_number || '',
        delivery_date: form.delivery_date || '', delivery_location: form.delivery_location || '',
        invoice_type: type,
        // C-5 fix: explicit lifecycle status; existing rows treated as 'Active'
        // by accounting filter when missing.
        status: form.status || 'Active',
        // H-12 snapshots
        org_snapshot: orgSnapshot,
        bill_to_snapshot: billToSnapshot,
        updated_at: new Date().toISOString(),
      };

      let invoiceId;
      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tax_invoices', editingId), invoiceData);
        invoiceId = editingId;
        logAction('tax_invoices', 'update', editingId, invoiceData, `Updated ${form.invoice_no}`);
      } else {
        invoiceData.created_at = new Date().toISOString();
        invoiceData.created_by = user?.uid || '';
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tax_invoices'), invoiceData);
        invoiceId = ref.id;
        logAction('tax_invoices', 'create', invoiceId, invoiceData, `Created ${form.invoice_no}`);
      }

      const batch = writeBatch(db);
      for (const pid of form.project_ids) {
        batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), {
          tax_invoice_id: invoiceId,
          invoice_status: 'Invoiced',
          invoice_no: form.invoice_no.trim(),
          invoice_date: form.invoice_date,
          invoice_due_date: form.due_date,
          invoice_label: type,
          invoice_remarks: form.remarks,
        });
      }
      // If editing: clear projects that were removed from this invoice
      if (editingId) {
        const prev = taxInvoices.find(i => i.id === editingId);
        for (const pid of (prev?.project_ids || []).filter(id => !form.project_ids.includes(id))) {
          batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), {
            tax_invoice_id: '', invoice_status: 'Not Invoiced',
            invoice_no: '', invoice_date: '', invoice_due_date: '', invoice_label: '', invoice_remarks: '',
          });
        }
      }
      await batch.commit();
      setModalOpen(false);
      addToast('Tax invoice saved successfully', 'success');
    } catch (err) {
      console.error(err);
      addToast('Error saving tax invoice', 'error');
    }
    setSaving(false);
  };

  // ── delete ────────────────────────────────────────────────────────────────
  const handleDelete = async (invoice) => {
    // C-2 fix: don't allow deletion of an invoice posted in a locked FY — use
    // a credit-note (Cancellation) workflow for closed periods.
    if (!assertFYNotLocked(invoice?.invoice_date, lockedFYs)) return;
    try {
      const batch = writeBatch(db);
      for (const pid of (invoice.project_ids || [])) {
        batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), {
          tax_invoice_id: '', invoice_status: 'Not Invoiced',
          invoice_no: '', invoice_date: '', invoice_due_date: '', invoice_label: '', invoice_remarks: '',
        });
      }
      batch.delete(doc(db, 'artifacts', appId, 'public', 'data', 'tax_invoices', invoice.id));
      await batch.commit();
      logAction('tax_invoices', 'delete', invoice.id, {}, invoice.invoice_no);
      setDeleteConfirm({ isOpen: false, invoice: null });
      addToast('Invoice deleted', 'info');
    } catch (err) {
      console.error(err);
      addToast('Error deleting invoice', 'error');
    }
  };

  // ── cancel & reissue ─────────────────────────────────────────────────────
  // Soft-cancels the invoice (preserves audit trail), releases linked projects
  // so they can be re-invoiced with a corrected invoice.
  const handleCancel = async () => {
    const invoice = cancelConfirm.invoice;
    if (!invoice) return;
    if (!cancelReason.trim()) return addToast('Please enter a reason for cancellation.', 'error');
    try {
      const batch = writeBatch(db);
      // Mark invoice cancelled — immutable fields (invoice_no, GST amounts) stay intact for audit.
      batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'tax_invoices', invoice.id), {
        status: 'Cancelled',
        cancel_reason: cancelReason.trim(),
        cancelled_by: user?.uid || '',
        cancelled_at: new Date().toISOString(),
      });
      // Release linked projects back to "Completed, not invoiced".
      for (const pid of (invoice.project_ids || [])) {
        batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), {
          tax_invoice_id: '',
          invoice_status: 'Not Invoiced',
          invoice_no: '',
          invoice_date: '',
          invoice_due_date: '',
          invoice_label: '',
          invoice_remarks: '',
        });
      }
      await batch.commit();
      logAction('tax_invoices', 'cancel', invoice.id, { cancel_reason: cancelReason.trim() }, invoice.invoice_no);
      setCancelConfirm({ isOpen: false, invoice: null });
      setCancelReason('');
      addToast(`Invoice ${invoice.invoice_no} cancelled — projects released for re-invoicing`, 'info');
    } catch (err) {
      console.error(err);
      addToast('Error cancelling invoice', 'error');
    }
  };

  // ── PDF generation ────────────────────────────────────────────────────────
  const pdfCtx = () => ({ clients, projects, payments, taxInvoices, getOrgSettings, logAction, addToast });
  const generatePDF = (invoice) => generateClassicInvoicePDF(invoice, pdfCtx());
  const generateGSTFormatPDF = (invoice) => generateGSTFormatInvoicePDF(invoice, pdfCtx());
  // Deliver-mode build (returns { doc, filename } without auto-saving) for SendMenu.
  const buildInvoicePdf = (invoice) => generateClassicInvoicePDF(invoice, { ...pdfCtx(), deliver: true });
  const invoiceParty = (invoice) => clients.find(c => c.id === invoice.client_id) || {};
  const partyEmail = (c) => c.email || (c.contacts && c.contacts[0] && c.contacts[0].email) || '';
  const partyPhone = (c) => c.phone || c.contact_phone || (c.contacts && c.contacts[0] && c.contacts[0].phone) || '';

  // ── Payment link (Razorpay) + e-invoice (IRN) ──
  const handlePaymentLink = async (inv) => {
    const cl = invoiceParty(inv);
    try {
      addToast('Generating payment link…', 'info');
      const fn = httpsCallable(getFunctions(), 'createPaymentLink');
      const res = await fn({ appId, amount: inv.final_amount, description: `Invoice ${inv.invoice_no}`, reference: `proj:${inv.project_id}`, customer: { name: cl.name, email: partyEmail(cl), phone: partyPhone(cl) } });
      const url = res.data?.url;
      if (!url) throw new Error('No link returned');
      try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
      addToast('Payment link copied: ' + url, 'success');
      logAction('tax_invoices', 'payment_link', inv.id, { url }, inv.invoice_no);
    } catch (e) {
      const msg = e?.message || 'error';
      addToast(/not configured|failed-precondition/i.test(msg) ? 'Razorpay not set up — add keys in Admin Tools → Payments.' : 'Payment link failed: ' + msg, 'error');
    }
  };

  const handleGenerateIRN = async (inv) => {
    try {
      addToast('Requesting IRN…', 'info');
      const fn = httpsCallable(getFunctions(), 'generateIRN');
      const res = await fn({ appId, invoiceId: inv.id });
      if (res.data?.irn) addToast('IRN generated: ' + res.data.irn, 'success');
      else addToast(res.data?.message || 'E-invoice payload prepared.', 'info');
    } catch (e) {
      const msg = e?.message || 'error';
      addToast(/not configured|not enabled|failed-precondition/i.test(msg) ? 'E-invoicing not enabled — configure it in Admin Tools → GST E-Invoice.' : 'IRN failed: ' + msg, 'error');
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  const clientOptions = clients.filter(c => c.type !== 'Vendor').sort((a,b) => (a.name||'').localeCompare(b.name||''));

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Receipt size={22} className="text-indigo-600" /> Tax Invoices (Sales)
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage all tax invoices raised to clients</p>
        </div>
        {can(role, 'tax_invoices', 'create') && (
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-semibold shadow transition">
            <Plus size={16} /> Create Tax Invoice
          </button>
        )}
      </div>

      {activeTab === 'unbilled' ? (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          {unbilledProjects.length === 0 ? (
            <div className="text-center text-slate-400 py-12">
              <CheckCircle size={36} className="mx-auto mb-2 text-green-400" />
              <p className="font-semibold">All completed projects have been invoiced.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase">
                  <th className="px-4 py-3 text-left">Project</th>
                  <th className="px-4 py-3 text-left">Client</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">End Date</th>
                  <th className="px-4 py-3 text-left">Overdue By</th>
                  <th className="px-4 py-3 text-right">Value</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {unbilledProjects.map(p => {
                  const client = clients.find(c => c.id === p.client_id);
                  const daysSince = p.end_date ? Math.floor((Date.now() - new Date(p.end_date)) / 86400000) : null;
                  return (
                    <tr key={p.id} className="hover:bg-amber-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-slate-800">{p.project_name || p.name || p.id}</td>
                      <td className="px-4 py-3 text-slate-600">{client?.name || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          STATUS_COLORS[p.status] || 'bg-slate-100 text-slate-600'
                        }`}>{p.status}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{p.end_date ? fmtDate(p.end_date) : '—'}</td>
                      <td className="px-4 py-3">
                        {daysSince !== null && (
                          <span className={`text-xs font-bold ${
                            daysSince > 30 ? 'text-red-600' : daysSince > 14 ? 'text-amber-600' : 'text-slate-500'
                          }`}>
                            {daysSince} day{daysSince !== 1 ? 's' : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-800">
                        {formatCurrency(getProjectGrandTotal(p))}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openCreateForProject(p)}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition ml-auto"
                        >
                          <Plus size={12} /> Create Invoice
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <>
      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('invoices')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 transition ${
            activeTab === 'invoices' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Issued Invoices
        </button>
        {can(role, 'tax_invoices', 'create') && (
          <button
            onClick={() => setActiveTab('unbilled')}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition flex items-center gap-2 ${
              activeTab === 'unbilled' ? 'border-amber-500 text-amber-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            Pending Invoices
            {unbilledProjects.length > 0 && (
              <span className="bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">{unbilledProjects.length}</span>
            )}
          </button>
        )}
      </div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" placeholder="Search invoice no, client, remarks..."
            className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-200 text-sm text-black bg-white"
            value={search} onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-black bg-white" value={filterClient} onChange={e => setFilterClient(e.target.value)}>
          <option value="">All Clients</option>
          {clientOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-black bg-white" value={filterFY} onChange={e => setFilterFY(e.target.value)}>
          {fyOptions.map(fy => <option key={fy} value={fy}>{fy === 'All' ? 'All FY' : fy}</option>)}
        </select>
        <button
          onClick={() => setShowCancelled(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition ${showCancelled ? 'bg-red-50 border-red-200 text-red-700 font-medium' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
        >
          <Eye size={13} /> {showCancelled ? 'Hide Cancelled' : 'Show Cancelled'}
        </button>
      </div>

      {/* Summary chips */}
      <div className="flex gap-3 flex-wrap">
        <div className="bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 text-sm">
          <span className="text-slate-500">Showing</span> <span className="font-bold text-indigo-700">{filtered.length}</span> invoice{filtered.length !== 1 ? 's' : ''}
        </div>
        <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2 text-sm">
          <span className="text-slate-500">Total:</span> <span className="font-bold text-green-700">{formatCurrency(totalAmount)}</span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase">
                <th className="px-4 py-3 text-left">Invoice No.</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Due Date</th>
                <th className="px-4 py-3 text-left">Client</th>
                <th className="px-4 py-3 text-left">Company / Branch</th>
                <th className="px-4 py-3 text-left">Projects</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Mode</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="text-center py-12 text-slate-400 text-sm">No tax invoices found. Create your first invoice.</td></tr>
              )}
              {filtered.map(inv => {
                const isOverdue = inv.due_date && inv.due_date < new Date().toISOString().split('T')[0] && inv.invoice_status !== 'Paid';
                return (
                  <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 font-mono font-bold text-slate-800">
                      {inv.invoice_no}
                      {inv.status === 'Cancelled' && (
                        <span className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-600 border border-red-200 uppercase tracking-wide">Cancelled</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{fmtDate(inv.invoice_date)}</td>
                    <td className={`px-4 py-3 font-medium ${isOverdue ? 'text-red-600' : 'text-slate-600'}`}>
                      {fmtDate(inv.due_date) || '—'}
                      {isOverdue && <span className="ml-1 text-[10px] bg-red-100 text-red-600 rounded px-1">Overdue</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-700 font-medium">{inv.client_name}</td>
                    <td className="px-4 py-3 text-slate-600 text-xs">{inv.sale_company_name || inv.client_name || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="text-slate-700">{inv.project_ids?.length || 0} project{inv.project_ids?.length !== 1 ? 's' : ''}</div>
                      {inv.project_names?.length > 0 && (
                        <div className="text-[10px] text-slate-400 truncate max-w-36">{inv.project_names.slice(0,2).join(', ')}{inv.project_names.length > 2 ? ' + more' : ''}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${TYPE_BADGE[inv.invoice_type] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {inv.invoice_type || 'Invoice'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${(inv.sale_mode || 'Credit') === 'Cash' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-orange-100 text-orange-700 border-orange-200'}`}>
                        {inv.sale_mode || 'Credit'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-800">{formatCurrency(inv.final_amount)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => generatePDF(inv)} title="Download PDF" className="p-1.5 rounded hover:bg-blue-50 text-blue-600 transition"><Download size={14} /></button>
                        <button onClick={() => generateGSTFormatPDF(inv)} title="Download GST format (Vyapar-style)" className="p-1.5 rounded hover:bg-green-50 text-green-600 transition"><Receipt size={14} /></button>
                        <SendMenu
                          compact
                          buildPdf={() => buildInvoicePdf(inv)}
                          email={partyEmail(invoiceParty(inv))}
                          phone={partyPhone(invoiceParty(inv))}
                          subject={`Tax Invoice ${inv.invoice_no}`}
                          message={`Dear ${invoiceParty(inv).name || 'Customer'}, please find your Tax Invoice ${inv.invoice_no} attached.`}
                        />
                        <button onClick={() => handlePaymentLink(inv)} title="Generate Razorpay payment link" className="p-1.5 rounded hover:bg-emerald-50 text-emerald-600 transition"><CreditCard size={14} /></button>
                        {can(role, 'tax_invoices', 'edit') && (
                          <button onClick={() => handleGenerateIRN(inv)} title="Generate e-invoice IRN" className="p-1.5 rounded hover:bg-purple-50 text-purple-600 transition"><FileCheck size={14} /></button>
                        )}
                        {can(role, 'tax_invoices', 'edit') && (
                          <button onClick={() => openEdit(inv)} title="Edit" className="p-1.5 rounded hover:bg-indigo-50 text-indigo-600 transition"><Edit size={14} /></button>
                        )}
                        {can(role, 'tax_invoices', 'delete') && (
                          <button onClick={() => setDeleteConfirm({ isOpen: true, invoice: inv })} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500 transition"><Trash2 size={14} /></button>
                        )}
                        {role === 'admin' && inv.status !== 'Cancelled' && (
                          <button onClick={() => { setCancelConfirm({ isOpen: true, invoice: inv }); setCancelReason(''); }} title="Cancel Invoice" className="p-1.5 rounded hover:bg-orange-50 text-orange-500 transition"><XCircle size={14} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? `Edit Invoice — ${form.invoice_no}` : 'Create Tax Invoice'}
      >
        <div className="space-y-4">
          {/* Step 1: Client */}
          <div>
            <label className="text-xs font-bold text-slate-700 block mb-1">Client <span className="text-red-500">*</span></label>
            {!editingId && (
              <div className="relative mb-2">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Filter client/branch by name or GSTIN..."
                  className="w-full pl-6 pr-2 py-1.5 rounded border border-slate-200 text-xs text-black bg-white"
                  value={clientSearch}
                  onChange={e => setClientSearch(e.target.value)}
                />
              </div>
            )}
            <select
              className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black bg-white"
              value={makeClientEntityValue(form.client_id, form.sale_company_id || 'primary')}
              onChange={e => {
                const selected = clientEntityOptions.find(o => o.value === e.target.value);
                if (!selected) {
                  setForm(f => ({ ...f, client_id: '', project_ids: [], sale_company_id: 'primary', sale_company_name: '', sale_company_gstin: '', sale_company_address: '' }));
                  return;
                }
                setForm(f => ({
                  ...f,
                  client_id: selected.client_id,
                  project_ids: [],
                  sale_company_id: selected.company_id,
                  sale_company_name: selected.company_name,
                  sale_company_gstin: selected.company_gstin,
                  sale_company_address: selected.company_address,
                }));
              }}
              disabled={!!editingId}
            >
              <option value="">— Select Client —</option>
              {filteredClientEntityOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {!editingId && clientSearch && filteredClientEntityOptions.length === 0 && (
              <p className="text-[10px] text-slate-400 mt-1">No matching client/branch found.</p>
            )}
          </div>

          {form.client_id && (
            <div className="text-xs text-slate-500 -mt-2">
              Billing To: <span className="font-semibold text-slate-700">{form.sale_company_name || clients.find(c => c.id === form.client_id)?.name || '—'}</span>
              {form.sale_company_gstin ? <span className="ml-2 font-mono">{form.sale_company_gstin}</span> : null}
            </div>
          )}

          {/* Step 2: Project selector */}
          {form.client_id && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-slate-700">
                  Select Projects <span className="text-red-500">*</span>
                  <span className="text-slate-400 font-normal ml-1">({form.project_ids.length} selected)</span>
                </label>
                <div className="flex gap-2">
                  <button onClick={() => setForm(f => ({ ...f, project_ids: clientProjects.map(p => p.id) }))} className="text-xs text-indigo-600 hover:underline">All</button>
                  <span className="text-slate-300">|</span>
                  <button onClick={() => setForm(f => ({ ...f, project_ids: [] }))} className="text-xs text-slate-500 hover:underline">Clear</button>
                </div>
              </div>
              <div className="relative mb-1">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text" placeholder="Filter projects..."
                  className="w-full pl-6 pr-2 py-1.5 rounded border border-slate-200 text-xs text-black bg-white"
                  value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
                />
              </div>
              <div className="max-h-48 overflow-y-auto border rounded-lg bg-slate-50 divide-y divide-slate-100">
                {clientProjects.length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-4">No eligible projects for this client.</p>
                )}
                {clientProjects.map(p => {
                  const checked = form.project_ids.includes(p.id);
                  const pTotal = computeProjectsTotals([p.id], projects).total;
                  const alreadyLinked = p.tax_invoice_id && p.tax_invoice_id !== editingId;
                  return (
                    <label key={p.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white transition ${checked ? 'bg-emerald-50' : ''} ${alreadyLinked ? 'opacity-60' : ''}`}>
                      <input type="checkbox" className="accent-emerald-600 w-4 h-4 shrink-0" checked={checked} onChange={() => toggleProject(p.id)} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate">{p.project_name}</div>
                        <div className="text-[10px] text-slate-500">{fmtDate(p.start_date)} → {fmtDate(p.end_date)}</div>
                        {alreadyLinked && <div className="text-[10px] text-orange-500">⚠ Linked to {p.invoice_no}</div>}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[p.status] || 'bg-slate-100 text-slate-600'}`}>{p.status}</div>
                        <div className="text-xs font-bold text-slate-700 mt-0.5">{formatCurrency(pTotal)}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Mixed supply-type (intra vs inter) clubbing warning */}
          {mixedSupply && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>These projects mix <strong>intra-state (CGST+SGST)</strong> and <strong>inter-state (IGST)</strong> supply. A single GST invoice must use one supply type — raise separate invoices per supply type, or verify the client GSTIN on each project.</span>
            </div>
          )}

          {/* Invoice summary panel */}
          {form.project_ids.length > 0 && (
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-indigo-700 uppercase">Invoice Summary</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${TYPE_BADGE[invoiceType] || 'bg-blue-100 text-blue-700 border-blue-200'}`}>{invoiceType}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-white rounded p-2 text-center border border-indigo-100">
                  <div className="text-[10px] text-slate-500 uppercase font-semibold mb-0.5">Taxable</div>
                  <div className="text-sm font-bold text-slate-800">{formatCurrency(computedTotals.taxable)}</div>
                </div>
                <div className="bg-white rounded p-2 text-center border border-orange-100">
                  <div className="text-[10px] text-orange-600 uppercase font-semibold mb-0.5">GST</div>
                  <div className="text-sm font-bold text-orange-700">{formatCurrency(computedTotals.gstAmt)}</div>
                </div>
                <div className="bg-indigo-600 rounded p-2 text-center">
                  <div className="text-[10px] text-indigo-200 uppercase font-semibold mb-0.5">Computed Total</div>
                  <div className="text-sm font-bold text-white">{formatCurrency(computedTotals.total)}</div>
                </div>
              </div>
            </div>
          )}

          {/* Invoice fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Invoice Number */}
            <div className="sm:col-span-2">
              <label className="text-xs font-bold text-slate-700 block mb-1">Invoice Number <span className="text-red-500">*</span></label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 rounded-lg border border-slate-300 p-2 text-sm text-black font-mono"
                  placeholder="e.g. 0001/25-26"
                  value={form.invoice_no}
                  onChange={e => setForm(f => ({ ...f, invoice_no: e.target.value }))}
                />
                <button
                  disabled={invGenLoading}
                  onClick={async () => {
                    try {
                      setInvGenLoading(true);
                      const no = await generateInvoiceNo(form.invoice_date);
                      setForm(f => ({ ...f, invoice_no: no }));
                    } catch { addToast('Failed to generate number', 'error'); }
                    finally { setInvGenLoading(false); }
                  }}
                  className="px-3 py-2 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 disabled:opacity-50 flex items-center gap-1 whitespace-nowrap"
                >
                  <Zap size={12} /> {invGenLoading ? '...' : 'Auto'}
                </button>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5">Sales sequence is independent per financial year. Prefix/suffix can be controlled from organization settings.</p>
            </div>

            {/* Invoice Date */}
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Invoice Date <span className="text-red-500">*</span></label>
              <input
                type="date"
                min={lastInvoiceDate || undefined}
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black"
                value={form.invoice_date}
                onChange={e => {
                  const d = e.target.value;
                  setForm(f => ({ ...f, invoice_date: d, due_date: computeDueDate(d, f.client_id) }));
                }}
              />
              {lastInvoiceDate && (
                <p className="text-[10px] text-orange-500 mt-0.5">⚠ Min: {fmtDate(lastInvoiceDate)} (last invoice date)</p>
              )}
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Sale Mode</label>
              <select
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black"
                value={form.sale_mode || 'Credit'}
                onChange={e => setForm(f => ({ ...f, sale_mode: e.target.value }))}
              >
                <option value="Credit">Credit</option>
                <option value="Cash">Cash</option>
              </select>
            </div>

            {/* Due Date */}
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Due Date
                <span className="text-slate-400 font-normal ml-1">
                  ({clients.find(c => c.id === form.client_id)?.billing_terms || 'Net 45 — default'})
                </span>
              </label>
              <input
                type="date"
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black"
                value={form.due_date}
                onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
              />
            </div>

            {/* Final Amount Override */}
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Final Invoice Amount
                <span className="text-slate-400 font-normal ml-1">(leave blank to use computed)</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black"
                placeholder={computedTotals.total ? String(Math.round(computedTotals.total * 100) / 100) : '0.00'}
                value={form.final_amount}
                onChange={e => setForm(f => ({ ...f, final_amount: e.target.value }))}
              />
              <p className="text-[10px] text-slate-400 mt-0.5">Override only if agreed amount differs from calculated total</p>
            </div>

            {/* Remarks */}
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Remarks <span className="text-slate-400 font-normal">(printed on invoice)</span>
              </label>
              <textarea
                rows={2}
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black resize-none"
                placeholder="e.g. Against annual corporate event services..."
                value={form.remarks}
                onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))}
              />
            </div>

            {/* Transportation & PO (optional — GST-format invoice) */}
            <details className="rounded-lg border border-slate-200 bg-slate-50/60">
              <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-slate-600 select-none">Transportation &amp; PO details <span className="font-normal text-slate-400">(optional — shown on GST-format invoice)</span></summary>
              <div className="grid grid-cols-2 gap-3 p-3 pt-1">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">PO Number</label>
                  <input className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black" value={form.po_number} onChange={e => setForm(f => ({ ...f, po_number: e.target.value }))} placeholder="e.g. ASHUTOSH VERBAL" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">PO Date</label>
                  <input type="date" className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black" value={form.po_date} onChange={e => setForm(f => ({ ...f, po_date: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Transport Name</label>
                  <input className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black" value={form.transport_name} onChange={e => setForm(f => ({ ...f, transport_name: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Vehicle Number</label>
                  <input className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black" value={form.vehicle_number} onChange={e => setForm(f => ({ ...f, vehicle_number: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Delivery Date</label>
                  <input type="date" className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black" value={form.delivery_date} onChange={e => setForm(f => ({ ...f, delivery_date: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Delivery Location</label>
                  <input className="w-full rounded-lg border border-slate-300 p-2 text-sm text-black" value={form.delivery_location} onChange={e => setForm(f => ({ ...f, delivery_location: e.target.value }))} />
                </div>
              </div>
            </details>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t pt-3">
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || form.project_ids.length === 0 || !form.invoice_no.trim()}
              className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editingId ? 'Update Invoice' : 'Create Invoice'}
            </button>
          </div>
        </div>
      </Modal>

      </>
      )}

      {/* Delete confirm — outside tab conditional so it works from either tab */}
      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        title="Delete Tax Invoice"
        message={`Delete invoice ${deleteConfirm.invoice?.invoice_no}? This will also unlink ${deleteConfirm.invoice?.project_ids?.length || 0} project(s). This cannot be undone.`}
        onConfirm={() => handleDelete(deleteConfirm.invoice)}
        onCancel={() => setDeleteConfirm({ isOpen: false, invoice: null })}
      />

      {/* Cancel Invoice modal */}
      {cancelConfirm.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="flex items-center gap-3 p-5 border-b border-slate-100">
              <XCircle className="text-orange-500" size={20} />
              <h2 className="font-semibold text-slate-800">Cancel Invoice</h2>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-sm text-slate-600">
                Cancel <span className="font-mono font-bold">{cancelConfirm.invoice?.invoice_no}</span>?
                The invoice will be marked Cancelled and linked projects released for re-invoicing.
                This preserves the audit trail as required by Section 34 CGST Act.
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Reason for cancellation <span className="text-red-500">*</span></label>
                <textarea
                  rows={3}
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  placeholder="e.g. Wrong GSTIN, amount correction, duplicate invoice…"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-slate-100">
              <button onClick={() => setCancelConfirm({ isOpen: false, invoice: null })} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 transition">Keep Invoice</button>
              <button onClick={handleCancel} disabled={!cancelReason.trim()} className="px-4 py-2 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition">Cancel Invoice</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaxInvoices;
