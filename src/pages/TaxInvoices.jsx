import React, { useState, useMemo } from 'react';
import {
  Plus, Search, Edit, Trash2, FileText, X, CheckCircle,
  AlertCircle, Download, Receipt, ChevronDown, Zap
} from 'lucide-react';
import {
  collection, addDoc, updateDoc, doc, deleteDoc,
  getDoc, writeBatch
} from 'firebase/firestore';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import {
  formatCurrency, formatCurrencyPDF, fmtDate,
  getFYFromDate, getProjectGSTBreakdown, sumLogisticsRecord, getProjectGrandTotal
} from '../utils/helpers';
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
      const rate = p.package_cost_gst || 18;
      taxable += p.package_cost;
      gstAmt += p.package_cost * rate / 100;
      total += p.package_cost * (1 + rate / 100);
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
  taxInvoices = [], projects = [], clients = [], lockedFYs = []
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
  const [projectSearch, setProjectSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');

  const initialForm = {
    client_id: '', project_ids: [], invoice_no: '',
    invoice_date: new Date().toISOString().split('T')[0],
    due_date: '', remarks: '', final_amount: '', sale_mode: 'Credit',
    sale_company_id: 'primary', sale_company_name: '', sale_company_gstin: '', sale_company_address: '',
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
        if (search && !`${inv.invoice_no} ${inv.client_name} ${inv.remarks || ''}`.toLowerCase().includes(q)) return false;
        if (filterClient && inv.client_id !== filterClient) return false;
        if (filterFY !== 'All' && getFYFromDate(inv.invoice_date) !== filterFY) return false;
        return true;
      })
      .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  }, [taxInvoices, search, filterClient, filterFY]);

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
        }
      } catch (_) { /* breakdown helper failure is non-fatal */ }
      const gstSplit = {
        supply_type: supplyType,
        cgst_amount: Math.round(cgstAmt * 100) / 100,
        sgst_amount: Math.round(sgstAmt * 100) / 100,
        igst_amount: Math.round(igstAmt * 100) / 100,
        place_of_supply: placeOfSupply,
        org_gstin: orgGstinForSplit,
        bill_to_gstin: billGstinForSplit,
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
        taxable: totals.taxable,
        gst_amount: totals.gstAmt,
        // M-7: CGST/SGST/IGST split (reflects org vs bill-to state at issue).
        supply_type: gstSplit.supply_type,
        cgst_amount: gstSplit.cgst_amount,
        sgst_amount: gstSplit.sgst_amount,
        igst_amount: gstSplit.igst_amount,
        place_of_supply: gstSplit.place_of_supply,
        org_gstin_at_issue: gstSplit.org_gstin,
        bill_to_gstin_at_issue: gstSplit.bill_to_gstin,
        computed_total: totals.total,
        final_amount: finalAmt,
        sale_mode: form.sale_mode || 'Credit',
        remarks: form.remarks,
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
                    <td className="px-4 py-3 font-mono font-bold text-slate-800">{inv.invoice_no}</td>
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
                        {can(role, 'tax_invoices', 'edit') && (
                          <button onClick={() => openEdit(inv)} title="Edit" className="p-1.5 rounded hover:bg-indigo-50 text-indigo-600 transition"><Edit size={14} /></button>
                        )}
                        {can(role, 'tax_invoices', 'delete') && (
                          <button onClick={() => setDeleteConfirm({ isOpen: true, invoice: inv })} title="Delete" className="p-1.5 rounded hover:bg-red-50 text-red-500 transition"><Trash2 size={14} /></button>
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

      </> /* end invoices tab */
      )} /* end activeTab ternary */

      {/* Delete confirm — outside tab conditional so it works from either tab */}
      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        title="Delete Tax Invoice"
        message={`Delete invoice ${deleteConfirm.invoice?.invoice_no}? This will also unlink ${deleteConfirm.invoice?.project_ids?.length || 0} project(s). This cannot be undone.`}
        onConfirm={() => handleDelete(deleteConfirm.invoice)}
        onCancel={() => setDeleteConfirm({ isOpen: false, invoice: null })}
      />
    </div>
  );
};

export default TaxInvoices;
