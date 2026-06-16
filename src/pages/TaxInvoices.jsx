import React, { useState, useMemo } from 'react';
import {
  Plus, Search, Edit, Trash2, FileText, X, CheckCircle,
  AlertCircle, Download, Receipt, ChevronDown, Zap, XCircle, Eye
} from 'lucide-react';
import {
  collection, addDoc, updateDoc, doc, deleteDoc,
  getDoc, writeBatch
} from 'firebase/firestore';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import {
  formatCurrency, formatCurrencyPDF, fmtDate,
  getFYFromDate, getProjectGSTBreakdown, sumLogisticsRecord, getProjectGrandTotal, amountToWordsINR, round2
} from '../utils/helpers';
import { GST_STATE_CODES } from '../utils/constants';
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
    if (!can(role, 'tax_invoices', 'create')) return alert('Access denied.');
    if (!form.client_id) return alert('Select a client.');
    if (form.project_ids.length === 0) return alert('Select at least one project.');
    if (!form.invoice_no.trim()) return alert('Invoice number is required.');
    if (!form.invoice_date) return alert('Invoice date is required.');
    if (lastInvoiceDate && form.invoice_date < lastInvoiceDate)
      return alert(`Invoice date cannot be before last invoice date: ${fmtDate(lastInvoiceDate)}`);
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
    if (!cancelReason.trim()) return alert('Please enter a reason for cancellation.');
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
  const generatePDF = async (invoice) => {
    try {
      // H-12: prefer the org/bill-to snapshot captured at invoice issue time so
      // PDFs reflect the company/client identity AS OF the invoice date even
      // if those master records are later edited. Fall back to live data for
      // legacy invoices that were issued before snapshotting was added.
      const liveOrg = await getOrgSettings();
      const orgSnap = invoice.org_snapshot || null;
      const org = orgSnap ? {
        name: orgSnap.name,
        gstin: orgSnap.gstin,
        pan: orgSnap.pan,
        address: orgSnap.address,
        state: orgSnap.state,
        phone: orgSnap.phone,
        email: orgSnap.email,
        logo: orgSnap.logo_url,
        bank_name: orgSnap.bank_name,
        bank_account: orgSnap.bank_account,
        ifsc: orgSnap.ifsc,
      } : liveOrg;
      const client = clients.find(c => c.id === invoice.client_id);
      const billSnap = invoice.bill_to_snapshot || null;
      const billToName = billSnap?.name || invoice.sale_company_name || client?.name || '—';
      const billToAddress = billSnap?.address || invoice.sale_company_address || client?.address || '';
      const billToGstin = billSnap?.gstin || invoice.sale_company_gstin || client?.gstin || '';
      const linkedProjects = projects.filter(p => (invoice.project_ids || []).includes(p.id));
      const pdfDoc = new jsPDF();
      const pageWidth = pdfDoc.internal.pageSize.width;
      const pageH = pdfDoc.internal.pageSize.height;
      const margin = 14;
      const invDate = invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('en-IN') : '';
      const invNo = invoice.invoice_no || '—';
      const dueDate = invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : '';

      // GST direction based on first project
      const firstProject = linkedProjects[0];
      const gstBD0 = firstProject
        ? getProjectGSTBreakdown(firstProject, org?.gstin || '', billToGstin || '')
        : { supplyType: 'CGST_SGST', items: [], totals: { taxable: 0, cgstAmt: 0, sgstAmt: 0, igstAmt: 0, total: 0 }, placeOfSupply: '' };
      const isIGST = gstBD0.supplyType === 'IGST';

      const drawCompactHeader = () => {
        if (pdfDoc.internal.getCurrentPageInfo().pageNumber === 1) return;
        pdfDoc.setFillColor(30, 64, 175); pdfDoc.rect(margin, 5, pageWidth - margin * 2, 16, 'F');
        pdfDoc.setFontSize(10); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.text(org?.name || 'Company', margin + 3, 14);
        pdfDoc.text('TAX INVOICE', pageWidth / 2, 14, { align: 'center' });
        pdfDoc.text(`${invNo} | ${invDate}`, pageWidth - margin - 2, 14, { align: 'right' });
        pdfDoc.setTextColor(0, 0, 0);
      };
      const addNewPage = () => { pdfDoc.addPage(); drawCompactHeader(); return 32; };

      let y = 12;

      // Org header
      if (org?.logo) { try { pdfDoc.addImage(org.logo, 'JPEG', margin, y, 25, 25); } catch(e) {} }
      pdfDoc.setFontSize(15); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(30, 64, 175);
      pdfDoc.text(org?.name || 'Company', pageWidth - margin, y + 8, { align: 'right' });
      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(80, 80, 80);
      const orgAddrLines = pdfDoc.splitTextToSize(org?.address || '', 80);
      pdfDoc.text(orgAddrLines, pageWidth - margin, y + 14, { align: 'right' });
      let hY = y + 14 + orgAddrLines.length * 4;
      if (org?.gstin) { pdfDoc.text(`GSTIN: ${org.gstin}`, pageWidth - margin, hY, { align: 'right' }); hY += 4; }
      if (org?.phone) { pdfDoc.text(`Ph: ${org.phone}`, pageWidth - margin, hY, { align: 'right' }); }
      pdfDoc.setTextColor(0, 0, 0);

      // Title banner
      y = Math.max(hY + 6, 44);
      pdfDoc.setFillColor(30, 64, 175); pdfDoc.rect(margin, y, pageWidth - margin * 2, 10, 'F');
      pdfDoc.setFontSize(13); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(255, 255, 255);
      pdfDoc.text('TAX INVOICE', pageWidth / 2, y + 7, { align: 'center' });
      pdfDoc.setTextColor(0, 0, 0); y += 14;

      // Invoice meta
      pdfDoc.setFontSize(9); pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('Invoice No: ', margin, y); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.text(invNo, margin + 22, y);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.text(`Date: ${invDate}`, pageWidth - margin, y, { align: 'right' });
      y += 5;
      if (dueDate) { pdfDoc.setFontSize(8); pdfDoc.setTextColor(180, 80, 0); pdfDoc.text(`Due: ${dueDate}`, margin, y); pdfDoc.setTextColor(0,0,0); }
      const fy = getFYFromDate(invoice.invoice_date);
      pdfDoc.setFontSize(8); pdfDoc.setTextColor(100,100,100); pdfDoc.text(`FY: ${fy}`, pageWidth - margin, y, { align: 'right' }); pdfDoc.setTextColor(0,0,0); y += 5;
      // Invoice type
      if (invoice.invoice_type && invoice.invoice_type !== 'Invoice') {
        pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(80,40,120);
        pdfDoc.text(`[${invoice.invoice_type}]`, margin, y); pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(0,0,0); y += 5;
      }

      // Bill To box
      const boxH = Math.max(36, 11 + linkedProjects.length * 5 + 8);
      pdfDoc.setDrawColor(200,200,220); pdfDoc.setLineWidth(0.3);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, boxH, 'S');
      const midX = margin + (pageWidth - margin * 2) / 2;
      pdfDoc.line(midX, y, midX, y + boxH);

      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(80,80,80);
      pdfDoc.text('BILL TO', margin + 2, y + 5);
      pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(0,0,0); pdfDoc.setFontSize(9);
      pdfDoc.text(billToName, margin + 2, y + 11);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(60,60,60);
      const cAddr = pdfDoc.splitTextToSize(billToAddress || '', 85);
      pdfDoc.text(cAddr, margin + 2, y + 17);
      if (billToGstin) pdfDoc.text(`GSTIN: ${billToGstin}`, margin + 2, y + 17 + cAddr.length * 4);

      pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(80,80,80);
      pdfDoc.text('PROJECTS / SUPPLY', midX + 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(7.5); pdfDoc.setTextColor(60,60,60);
      linkedProjects.slice(0, 6).forEach((p, i) => {
        pdfDoc.text(`• ${p.project_name} (${fmtDate(p.start_date)}–${fmtDate(p.end_date)})`, midX + 2, y + 11 + i * 5);
      });
      if (linkedProjects.length > 6) pdfDoc.text(`  + ${linkedProjects.length - 6} more...`, midX + 2, y + 11 + 6 * 5);
      if (gstBD0.placeOfSupply) {
        pdfDoc.text(`Place of Supply: ${gstBD0.placeOfSupply} · ${isIGST ? 'IGST' : 'CGST+SGST'}`, midX + 2, y + boxH - 5);
      }
      pdfDoc.setTextColor(0,0,0); y += boxH + 4;

      // Aggregate items from all projects
      const allItems = [];
      linkedProjects.forEach(p => {
        const bd = getProjectGSTBreakdown(p, org?.gstin || '', client?.gstin || '');
        allItems.push(...bd.items);
      });

      const colHeaders = isIGST
        ? ['#','HSN','Description','Qty','Days','Rate','Taxable','IGST%','IGST Amt','Total']
        : ['#','HSN','Description','Qty','Days','Rate','Taxable','CGST%','CGST Amt','SGST%','SGST Amt','Total'];

      const tableRows = allItems.map((item, i) =>
        isIGST
          ? [i+1, item.hsn, item.description, item.qty||1, item.days||1, item.rate ? formatCurrencyPDF(item.rate) : '—', formatCurrencyPDF(item.taxable), `${item.igstRate}%`, formatCurrencyPDF(item.igstAmt), formatCurrencyPDF(item.total)]
          : [i+1, item.hsn, item.description, item.qty||1, item.days||1, item.rate ? formatCurrencyPDF(item.rate) : '—', formatCurrencyPDF(item.taxable), `${item.cgstRate}%`, formatCurrencyPDF(item.cgstAmt), `${item.sgstRate}%`, formatCurrencyPDF(item.sgstAmt), formatCurrencyPDF(item.total)]
      );

      const colStyles = isIGST
        ? { 0:{cellWidth:7}, 1:{cellWidth:14}, 3:{halign:'center'}, 4:{halign:'center'}, 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'center'}, 8:{halign:'right'}, 9:{halign:'right'} }
        : { 0:{cellWidth:6}, 1:{cellWidth:12}, 3:{halign:'center'}, 4:{halign:'center'}, 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'center'}, 8:{halign:'right'}, 9:{halign:'center'}, 10:{halign:'right'}, 11:{halign:'right'} };

      autoTable(pdfDoc, {
        startY: y, head: [colHeaders], body: tableRows, theme: 'grid',
        headStyles: { fillColor: [30,64,175], fontSize: 7.5, textColor: [255,255,255] },
        styles: { fontSize: 7.5, cellPadding: 1.8 }, columnStyles: colStyles,
        didDrawPage: () => drawCompactHeader(),
      });
      y = pdfDoc.lastAutoTable.finalY + 4;

      // GST summary
      let totTaxable=0, totCgst=0, totSgst=0, totIgst=0, totTotal=0;
      allItems.forEach(item => { totTaxable+=item.taxable; totCgst+=item.cgstAmt||0; totSgst+=item.sgstAmt||0; totIgst+=item.igstAmt||0; totTotal+=item.total; });

      const summaryRows = [['Taxable Amount', formatCurrencyPDF(totTaxable)]];
      if (isIGST) { summaryRows.push(['IGST', formatCurrencyPDF(totIgst)]); }
      else { summaryRows.push(['CGST', formatCurrencyPDF(totCgst)]); summaryRows.push(['SGST', formatCurrencyPDF(totSgst)]); }

      const finalAmt = invoice.final_amount != null ? invoice.final_amount : totTotal;
      if (Math.abs(finalAmt - totTotal) > 0.01) {
        summaryRows.push(['Sub-Total (as calculated)', formatCurrencyPDF(totTotal)]);
        summaryRows.push(['Adjustment / Agreed Amount', formatCurrencyPDF(finalAmt - totTotal)]);
      }
      summaryRows.push(['GRAND TOTAL', formatCurrencyPDF(finalAmt)]);

      if (y + 40 > pageH - 20) { y = addNewPage(); }
      autoTable(pdfDoc, {
        startY: y, body: summaryRows, theme: 'plain', styles: { fontSize: 9, cellPadding: 2 },
        columnStyles: { 0:{halign:'right', fontStyle:'bold', cellWidth:130}, 1:{halign:'right'} },
        didParseCell: (data) => {
          if (data.row.index === summaryRows.length - 1) {
            data.cell.styles.fontStyle='bold'; data.cell.styles.fontSize=11.5; data.cell.styles.textColor=[30,64,175];
          }
        },
        didDrawPage: () => drawCompactHeader(),
      });
      y = pdfDoc.lastAutoTable.finalY + 6;

      // Bank details
      const banks = org?.bank_accounts || [];
      const defBank = banks.find(b => b.id === org?.default_bank_id) || banks[0];
      if (defBank) {
        if (y + 32 > pageH - 14) { y = addNewPage(); }
        pdfDoc.setFillColor(240,245,255); pdfDoc.setDrawColor(180,200,240); pdfDoc.setLineWidth(0.3);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, 28, 'FD');
        pdfDoc.setFontSize(8.5); pdfDoc.setFont('helvetica','bold'); pdfDoc.setTextColor(30,64,175);
        pdfDoc.text('Bank Details (for NEFT/RTGS)', margin+3, y+6);
        pdfDoc.setFont('helvetica','normal'); pdfDoc.setTextColor(0,0,0); pdfDoc.setFontSize(8);
        pdfDoc.text(`Bank: ${defBank.bank_name||''}`, margin+3, y+12);
        pdfDoc.text(`A/c No: ${defBank.account_number||''}`, margin+3, y+17);
        pdfDoc.text(`IFSC: ${defBank.ifsc||''}`, margin+3, y+22);
        pdfDoc.text(`A/c Name: ${defBank.account_name||org?.name||''}`, pageWidth/2, y+12);
        pdfDoc.text(`Branch: ${defBank.branch||''}`, pageWidth/2, y+17);
        y += 32;
      }

      // Remarks
      if (invoice.remarks) {
        if (y + 16 > pageH - 10) { y = addNewPage(); }
        pdfDoc.setFillColor(255,249,230); pdfDoc.setDrawColor(220,180,60); pdfDoc.setLineWidth(0.3);
        const remLines = pdfDoc.splitTextToSize(invoice.remarks, pageWidth - margin*2 - 22);
        const remH = Math.max(14, 8 + remLines.length * 4);
        pdfDoc.rect(margin, y, pageWidth - margin*2, remH, 'FD');
        pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica','bold'); pdfDoc.setTextColor(120,80,0);
        pdfDoc.text('Remarks:', margin+2, y+5);
        pdfDoc.setFont('helvetica','normal'); pdfDoc.setTextColor(60,40,0);
        pdfDoc.text(remLines, margin+22, y+5);
        y += remH + 4;
      }

      // Terms
      if (y + 20 > pageH - 10) { y = addNewPage(); }
      pdfDoc.setFontSize(7.5); pdfDoc.setFont('helvetica','italic'); pdfDoc.setTextColor(120,120,120);
      pdfDoc.text('This is a computer-generated Tax Invoice and is valid without a signature.', margin, y);
      const invoiceTerms = org?.invoice_terms || org?.terms || '';
      if (invoiceTerms) {
        y += 5;
        pdfDoc.setFont('helvetica','bold'); pdfDoc.setFontSize(7.5); pdfDoc.setTextColor(80,80,80);
        pdfDoc.text('Terms & Conditions:', margin, y); y += 4;
        pdfDoc.setFont('helvetica','normal'); pdfDoc.setTextColor(100,100,100);
        pdfDoc.text(pdfDoc.splitTextToSize(invoiceTerms, pageWidth-margin*2), margin, y);
      }

      pdfDoc.save(`TaxInvoice_${invNo.replace(/\//g,'-')}_${(client?.name||'').replace(/\s+/g,'_')}.pdf`);
      logAction('tax_invoices', 'print_pdf', invoice.id, {}, invoice.invoice_no);
    } catch (err) {
      console.error('Tax Invoice PDF Error:', err);
      addToast('Failed to generate PDF', 'error');
    }
  };

  // ── Vyapar-style GST tax invoice (alternate template) ──────────────────────
  const stateLabel = (gstin) => {
    const code = String(gstin || '').slice(0, 2);
    return GST_STATE_CODES[code] ? `${code}-${GST_STATE_CODES[code]}` : '';
  };

  const generateGSTFormatPDF = async (invoice) => {
    try {
      const liveOrg = await getOrgSettings();
      const snap = invoice.org_snapshot || {};
      const org = {
        name: snap.name || liveOrg?.name || 'Company',
        address: snap.address || liveOrg?.address || '',
        gstin: snap.gstin || liveOrg?.gstin || '',
        phone: snap.phone || liveOrg?.phone || '',
        email: snap.email || liveOrg?.email || '',
        logo: snap.logo_url || liveOrg?.logo || '',
        msme_reg: liveOrg?.msme_reg || '',
        signature: liveOrg?.signature || '',
        invoice_terms: liveOrg?.invoice_terms || liveOrg?.terms || '',
        bank_accounts: liveOrg?.bank_accounts || [],
        default_bank_id: liveOrg?.default_bank_id || '',
      };

      const client = clients.find(c => c.id === invoice.client_id);
      const billSnap = invoice.bill_to_snapshot || null;
      const billToName = billSnap?.name || invoice.sale_company_name || client?.name || '—';
      const billToAddress = billSnap?.address || invoice.sale_company_address || client?.address || '';
      const billToGstin = billSnap?.gstin || invoice.sale_company_gstin || client?.gstin || '';
      const billToContact = client?.contact_number || client?.phone || client?.mobile || '';

      const linkedProjects = projects.filter(p => (invoice.project_ids || []).includes(p.id));
      const allItems = [];
      linkedProjects.forEach(p => { allItems.push(...getProjectGSTBreakdown(p, org.gstin || '', billToGstin || '').items); });

      const isIGST = (invoice.supply_type || '') === 'IGST';
      const finalAmt = invoice.final_amount != null ? parseFloat(invoice.final_amount) : (invoice.computed_total || 0);
      const subTotal = round2(allItems.reduce((s, it) => s + (it.total || 0), 0));
      const roundOff = round2(finalAmt - subTotal);

      // Running balance — consistent with the client ledger: the client's billed
      // position EXCLUDING this invoice = other active tax invoices + delivered
      // projects NOT yet covered by any tax invoice (so project-billed revenue is
      // counted, not just tax_invoices) − all payments received.
      const cid = invoice.client_id;
      const clientPays = (payments || []).filter(p => p.client_id === cid || p.party_id === cid);
      const totalPaid = clientPays.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      const activeClientInvoices = (taxInvoices || []).filter(i => i.client_id === cid && i.status !== 'Cancelled');
      const otherInvTotal = activeClientInvoices
        .filter(i => i.id !== invoice.id)
        .reduce((s, i) => s + parseFloat(i.final_amount ?? i.computed_total ?? 0), 0);
      const invoicedPids = new Set();
      activeClientInvoices.forEach(i => {
        (Array.isArray(i.project_ids) ? i.project_ids : (i.project_id ? [i.project_id] : [])).forEach(pid => pid && invoicedPids.add(pid));
      });
      const projBilled = (projects || [])
        .filter(p => p.client_id === cid && ['Completed', 'Closed'].includes(p.status) && !invoicedPids.has(p.id))
        .reduce((s, p) => s + getProjectGrandTotal(p), 0);
      const previousBalance = round2(otherInvTotal + projBilled - totalPaid);
      const received = round2(clientPays.filter(p => p.invoice_id === invoice.id).reduce((s, p) => s + parseFloat(p.amount || 0), 0));
      const balance = round2(finalAmt - received);
      const currentBalance = round2(previousBalance + balance);

      // UPI QR
      const banks = org.bank_accounts || [];
      const defBank = banks.find(b => b.id === org.default_bank_id) || banks[0] || null;
      let qrDataUrl = null;
      if (defBank?.upi_id) {
        try {
          const upiStr = `upi://pay?pa=${defBank.upi_id}&pn=${encodeURIComponent(defBank.account_name || org.name)}&am=${finalAmt.toFixed(2)}&cu=INR`;
          qrDataUrl = await QRCode.toDataURL(upiStr, { margin: 1, width: 140 });
        } catch (_) { qrDataUrl = null; }
      }

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.width;
      const pageH = doc.internal.pageSize.height;
      const margin = 12;
      const right = pageWidth - margin;
      const invDate = invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('en-IN') : '';
      const dueDate = invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : '';

      // ── 1. Header: seller left, logo right ──
      let y = 14;
      doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text(org.name, margin, y);
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 70, 70);
      let hy = y + 5;
      const addrLines = doc.splitTextToSize(org.address || '', 120);
      doc.text(addrLines, margin, hy); hy += addrLines.length * 3.6;
      if (org.phone) { doc.text(`Phone no.: ${org.phone}`, margin, hy); hy += 3.6; }
      if (org.email) { doc.text(`Email: ${org.email}`, margin, hy); hy += 3.6; }
      if (org.gstin) { doc.text(`GSTIN: ${org.gstin}`, margin, hy); hy += 3.6; }
      const orgState = stateLabel(org.gstin);
      if (orgState) { doc.text(`State: ${orgState}`, margin, hy); hy += 3.6; }
      if (org.msme_reg) { doc.text(`MSME REGD.: ${org.msme_reg}`, margin, hy); hy += 3.6; }
      if (org.logo) { try { doc.addImage(org.logo, 'PNG', right - 32, y - 2, 32, 18); } catch (_) {} }

      y = Math.max(hy + 2, 40);
      doc.setDrawColor(150); doc.setLineWidth(0.4); doc.line(margin, y, right, y); y += 5;
      doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text('Tax Invoice', pageWidth / 2, y, { align: 'center' }); y += 5;

      // ── 2. Three-column block: Bill To | Transportation | Invoice Details ──
      const colW = (right - margin) / 3;
      const boxTop = y;
      const hasTransport = invoice.transport_name || invoice.vehicle_number || invoice.delivery_date || invoice.delivery_location;
      const cx1 = margin + 2, cx2 = margin + colW + 2, cx3 = margin + colW * 2 + 2;
      let yL = boxTop + 4, yM = boxTop + 4, yR = boxTop + 4;
      doc.setFontSize(7); doc.setTextColor(90, 90, 90); doc.setFont('helvetica', 'bold');
      doc.text('Bill To', cx1, yL); doc.text('Transportation Details', cx2, yM); doc.text('Invoice Details', cx3, yR);
      yL += 4; yM += 4; yR += 4;
      // Bill To
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(20, 20, 20);
      doc.text(billToName, cx1, yL); yL += 4;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(60, 60, 60);
      const bAddr = doc.splitTextToSize(billToAddress || '', colW - 4); doc.text(bAddr, cx1, yL); yL += bAddr.length * 3.4;
      if (billToContact) { doc.text(`Contact No.: ${billToContact}`, cx1, yL); yL += 3.4; }
      if (billToGstin) { doc.text(`GSTIN: ${billToGstin}`, cx1, yL); yL += 3.4; }
      const bState = stateLabel(billToGstin); if (bState) { doc.text(`State: ${bState}`, cx1, yL); yL += 3.4; }
      // Transportation
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(60, 60, 60);
      [['Transport Name:', invoice.transport_name], ['Vehicle Number:', invoice.vehicle_number],
       ['Delivery Date:', invoice.delivery_date ? new Date(invoice.delivery_date).toLocaleDateString('en-IN') : ''],
       ['Delivery Location:', invoice.delivery_location]].forEach(([k, v]) => {
        doc.text(`${k} ${v || ''}`, cx2, yM); yM += 3.6;
      });
      // Invoice Details
      doc.setFontSize(7); doc.setTextColor(60, 60, 60);
      const invRow = (k, v, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(`${k} ${v || ''}`, cx3, yR); yR += 3.8; };
      invRow('Invoice No.:', invoice.invoice_no || '—');
      invRow('Date:', invDate);
      invRow('Place of Supply:', invoice.place_of_supply || bState || '');
      if (dueDate) invRow('Due Date:', dueDate, true);
      if (invoice.po_date) invRow('PO date:', new Date(invoice.po_date).toLocaleDateString('en-IN'));
      if (invoice.po_number) invRow('PO number:', invoice.po_number);

      const boxBottom = Math.max(yL, hasTransport ? yM : boxTop + 8, yR) + 2;
      doc.setDrawColor(180); doc.setLineWidth(0.3);
      doc.rect(margin, boxTop, right - margin, boxBottom - boxTop, 'S');
      doc.line(margin + colW, boxTop, margin + colW, boxBottom);
      doc.line(margin + colW * 2, boxTop, margin + colW * 2, boxBottom);
      y = boxBottom + 4;

      // ── 3. Items table ──
      const itemRows = allItems.map((it, i) => {
        const gstAmt = (it.cgstAmt || 0) + (it.sgstAmt || 0) + (it.igstAmt || 0);
        const rate = isIGST ? (it.igstRate || 0) : ((it.cgstRate || 0) + (it.sgstRate || 0));
        return [
          i + 1,
          it.description || '',
          it.hsn || '',
          it.days != null ? it.days : '-',
          it.qty != null ? it.qty : '-',
          '-',
          it.rate ? formatCurrencyPDF(it.rate) : '-',
          `${formatCurrencyPDF(gstAmt)}\n(${rate}%)`,
          formatCurrencyPDF(it.total),
        ];
      });
      const totalGst = round2(allItems.reduce((s, it) => s + (it.cgstAmt || 0) + (it.sgstAmt || 0) + (it.igstAmt || 0), 0));
      autoTable(doc, {
        startY: y,
        head: [['#', 'Item name', 'HSN/SAC', 'DAYS', 'Quantity', 'Unit', 'Price/Unit', 'GST', 'Amount']],
        body: itemRows,
        foot: [['', 'Total', '', '', '', '', '', formatCurrencyPDF(totalGst), formatCurrencyPDF(subTotal)]],
        theme: 'grid',
        headStyles: { fillColor: [70, 110, 200], textColor: [255, 255, 255], fontSize: 7, halign: 'center' },
        footStyles: { fillColor: [235, 240, 250], textColor: [20, 20, 20], fontStyle: 'bold', fontSize: 7.5 },
        styles: { fontSize: 7, cellPadding: 1.6, valign: 'middle' },
        columnStyles: {
          0: { cellWidth: 7, halign: 'center' }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 18, halign: 'center' },
          3: { cellWidth: 11, halign: 'center' }, 4: { cellWidth: 15, halign: 'center' }, 5: { cellWidth: 10, halign: 'center' },
          6: { cellWidth: 24, halign: 'right' }, 7: { cellWidth: 26, halign: 'right' }, 8: { cellWidth: 28, halign: 'right' },
        },
      });
      y = doc.lastAutoTable.finalY + 4;

      // ── 4 & 5. Tax-type table (left) + totals stack (right) ──
      // Built from the STORED, reconciled invoice fields (taxable + GST === final
      // amount) so the tax shown always matches the invoice value — even when the
      // user entered a tax-inclusive final amount that differs from the quote.
      const txTaxable = round2(invoice.taxable || 0);
      const txCgst = round2(invoice.cgst_amount || 0);
      const txSgst = round2(invoice.sgst_amount || 0);
      const txIgst = round2(invoice.igst_amount || 0);
      const blendedRate = txTaxable > 0 ? Math.round((round2(invoice.gst_amount || 0) / txTaxable) * 100) : 18;
      const taxRows = [];
      if (isIGST) {
        taxRows.push(['IGST', formatCurrencyPDF(txTaxable), `${blendedRate}%`, formatCurrencyPDF(txIgst)]);
      } else {
        taxRows.push(['CGST', formatCurrencyPDF(txTaxable), `${blendedRate / 2}%`, formatCurrencyPDF(txCgst)]);
        taxRows.push(['SGST', formatCurrencyPDF(txTaxable), `${blendedRate / 2}%`, formatCurrencyPDF(txSgst)]);
      }
      const taxTableTop = y;
      autoTable(doc, {
        startY: y,
        head: [['Tax type', 'Taxable amount', 'Rate', 'Tax amount']],
        body: taxRows.length ? taxRows : [['—', formatCurrencyPDF(invoice.taxable || 0), '', formatCurrencyPDF(invoice.gst_amount || 0)]],
        theme: 'grid', tableWidth: 95, margin: { left: margin },
        headStyles: { fillColor: [70, 110, 200], textColor: [255, 255, 255], fontSize: 6.5 },
        styles: { fontSize: 6.5, cellPadding: 1.3 },
      });
      const taxTableBottom = doc.lastAutoTable.finalY;

      // Totals stack on the right
      const tlx = pageWidth / 2 + 8;
      let ty = taxTableTop + 2;
      const totRow = (label, val, opts = {}) => {
        doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
        doc.setFontSize(opts.big ? 9 : 7.5);
        doc.setTextColor(opts.muted ? 120 : 30, opts.muted ? 120 : 30, opts.muted ? 120 : 30);
        doc.text(label, tlx, ty);
        doc.text(val, right, ty, { align: 'right' });
        ty += opts.big ? 6 : 4.6;
      };
      totRow('Sub Total', formatCurrencyPDF(subTotal));
      if (Math.abs(roundOff) > 0.001) totRow(Math.abs(roundOff) < 1 ? 'Round off' : 'Adjustment', formatCurrencyPDF(roundOff));
      doc.setDrawColor(200); doc.line(tlx, ty - 1.5, right, ty - 1.5);
      totRow('Total', formatCurrencyPDF(finalAmt), { bold: true, big: true });
      totRow('Received', formatCurrencyPDF(received));
      totRow('Balance', formatCurrencyPDF(balance), { bold: true });
      doc.setDrawColor(220); doc.line(tlx, ty - 1.5, right, ty - 1.5);
      totRow('Previous Balance', formatCurrencyPDF(previousBalance), { muted: true });
      totRow('Current Balance', formatCurrencyPDF(currentBalance), { bold: true });

      y = Math.max(taxTableBottom, ty) + 5;

      // ── 6. Amount in words, payment mode, terms, MSME ──
      if (y + 30 > pageH - 50) { doc.addPage(); y = 16; }
      doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
      doc.text('Invoice Amount In Words:', margin, y);
      doc.setFont('helvetica', 'normal');
      const wordsLines = doc.splitTextToSize(amountToWordsINR(finalAmt), right - margin - 42);
      doc.text(wordsLines, margin + 42, y); y += Math.max(4, wordsLines.length * 3.6) + 2;
      doc.setFont('helvetica', 'bold'); doc.text('Payment Mode:', margin, y);
      doc.setFont('helvetica', 'normal'); doc.text(invoice.sale_mode || 'Credit', margin + 26, y); y += 5;
      if (org.invoice_terms) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('Terms and conditions:', margin, y); y += 3.6;
        doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 90, 90);
        const tLines = doc.splitTextToSize(org.invoice_terms, right - margin * 2);
        doc.text(tLines, margin, y); y += tLines.length * 3.3 + 2;
      }
      if (org.msme_reg) { doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(30, 30, 30); doc.text(`MSME REG : ${org.msme_reg}`, margin, y); y += 4; }
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(110, 110, 110);
      doc.text('Thanks for doing business with us!', margin, y); y += 6;

      // ── 6b. Bank details + QR (left) | signature (right) ──
      const footTop = Math.max(y, pageH - 44);
      if (defBank) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(30, 30, 30);
        doc.text('Bank Details', margin + (qrDataUrl ? 26 : 0), footTop);
        if (qrDataUrl) { try { doc.addImage(qrDataUrl, 'PNG', margin, footTop + 2, 22, 22); } catch (_) {} }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(60, 60, 60);
        const bx = margin + (qrDataUrl ? 26 : 0);
        let by = footTop + 4;
        [`Name: ${defBank.bank_name || ''}`, `Account No.: ${defBank.account_no || ''}`, `IFSC code: ${defBank.ifsc || ''}`, `Account Holder's Name: ${defBank.account_name || org.name}`]
          .forEach(line => { doc.text(line, bx, by); by += 3.6; });
      }
      // Signature (right)
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
      doc.text(`For: ${org.name}`, right, footTop, { align: 'right' });
      if (org.signature) { try { doc.addImage(org.signature, 'PNG', right - 40, footTop + 3, 38, 16); } catch (_) {} }
      doc.setFont('helvetica', 'bold'); doc.text('Authorized Signatory', right, footTop + 24, { align: 'right' });

      // ── 7. Page 2: Acknowledgment slip ──
      doc.addPage();
      let ay = 16;
      doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text(org.name, margin, ay);
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 70, 70);
      const a2 = doc.splitTextToSize(org.address || '', 120); doc.text(a2, margin, ay + 5);
      let aHy = ay + 5 + a2.length * 3.6;
      if (org.gstin) { doc.text(`GSTIN: ${org.gstin}`, margin, aHy); aHy += 3.6; }
      if (orgState) { doc.text(`State: ${orgState}`, margin, aHy); aHy += 3.6; }
      if (org.logo) { try { doc.addImage(org.logo, 'PNG', right - 32, ay - 2, 32, 18); } catch (_) {} }
      ay = Math.max(aHy + 4, 42);
      doc.setDrawColor(150); doc.line(margin, ay, right, ay); ay += 6;
      doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.text('Tax Invoice', pageWidth / 2, ay, { align: 'center' }); ay += 8;
      doc.setDrawColor(200); doc.setLineDashPattern([1, 1], 0); doc.line(margin, ay, right, ay); doc.setLineDashPattern([], 0); ay += 6;
      doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(70, 110, 200);
      doc.text('Acknowledgment', pageWidth / 2, ay, { align: 'center' }); ay += 5;
      doc.setTextColor(70, 110, 200); doc.text(org.name, pageWidth / 2, ay, { align: 'center' }); ay += 10;
      doc.setTextColor(70, 110, 200); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
      doc.text('Invoice To:', margin, ay);
      doc.text('Invoice Details:', pageWidth / 2 + 6, ay); ay += 5;
      doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      doc.text(billToName, margin, ay);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60, 60, 60);
      const a3 = doc.splitTextToSize(billToAddress || '', 80); doc.text(a3, margin, ay + 4);
      // right details
      doc.setFontSize(8); doc.setTextColor(40, 40, 40);
      doc.text(`Invoice No. : ${invoice.invoice_no || '—'}`, pageWidth / 2 + 6, ay);
      doc.text(`Invoice Date : ${invDate}`, pageWidth / 2 + 6, ay + 5);
      doc.text(`Invoice Amount : ${formatCurrencyPDF(finalAmt)}`, pageWidth / 2 + 6, ay + 10);
      doc.setDrawColor(160); doc.setLineDashPattern([1, 1], 0); doc.line(right - 60, ay + 24, right, ay + 24); doc.setLineDashPattern([], 0);
      doc.setFontSize(7.5); doc.setTextColor(80, 80, 80); doc.text("Receiver's Seal & Sign", right - 30, ay + 28, { align: 'center' });

      doc.save(`TaxInvoice_GST_${(invoice.invoice_no || '').replace(/\//g, '-')}_${(billToName || '').replace(/\s+/g, '_')}.pdf`);
      logAction('tax_invoices', 'print_pdf_gst', invoice.id, {}, invoice.invoice_no);
    } catch (err) {
      console.error('GST-format Invoice PDF Error:', err);
      addToast('Failed to generate GST-format PDF', 'error');
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
