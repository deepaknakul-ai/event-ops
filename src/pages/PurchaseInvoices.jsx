import React, { useState, useEffect, useMemo, useRef } from 'react';
import { notify } from '../utils/toast';
import {
  Plus, Search, Edit, Trash2, Upload, Eye, X, FileText,
  CheckCircle, Clock, XCircle, Download, Filter, ChevronDown,
  Image as ImageIcon, ZoomIn, Package, Wrench
} from 'lucide-react';
import {
  collection, addDoc, updateDoc, doc, deleteDoc,
  getDoc, getDocs
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../firebase';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import { formatCurrency, getFinancialYear } from '../utils/helpers';
import { assertFYNotLocked } from '../utils/fyLock';
import { generateBookInvoiceNumber } from '../utils/accounting';
import { can } from '../utils/permissions';

// ─── helpers ────────────────────────────────────────────────────────────────

const getFYFromDate = (dateStr) => {
  if (!dateStr) return getFinancialYear();
  const d = new Date(dateStr);
  const m = d.getMonth(); // 0-indexed
  const y = d.getFullYear();
  if (m < 3) return `${y - 1}-${String(y).slice(-2)}`;
  return `${y}-${String(y + 1).slice(-2)}`;
};

const STATUS_STYLES = {
  Pending:  { bg: 'bg-orange-100 text-orange-700 border-orange-200',  icon: Clock },
  Verified: { bg: 'bg-green-100  text-green-700  border-green-200',   icon: CheckCircle },
  Rejected: { bg: 'bg-red-100    text-red-700    border-red-200',     icon: XCircle },
};

const TYPE_STYLES = {
  Asset:   { bg: 'bg-blue-100   text-blue-700   border-blue-200',   icon: Package },
  Service: { bg: 'bg-purple-100 text-purple-700 border-purple-200', icon: Wrench },
};

// ─── component ──────────────────────────────────────────────────────────────

const PurchaseInvoices = ({ db, appId, logAction, inventory = [], clients = [], projects = [], role, purchaseInvoicesExternal, setPurchaseInvoicesExternal, lockedFYs = [] }) => {
  const [records, setRecords]           = useState([]);
  const [loading, setLoading]           = useState(false);
  const [isModalOpen, setIsModalOpen]   = useState(false);
  const [editingId, setEditingId]       = useState(null);
  const [searchTerm, setSearchTerm]     = useState('');
  const [filterType, setFilterType]     = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');
  const [filterFY, setFilterFY]         = useState('All');
  const [currentPage, setCurrentPage]   = useState(1);
  const [lightbox, setLightbox]         = useState(null); // { url, name }
  const [uploadingIdx, setUploadingIdx] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const fileInputRef = useRef(null);
  const itemsPerPage = 20;

  const initialForm = {
    type: 'Asset',
    invoice_date: new Date().toISOString().split('T')[0],
    invoice_ref: '',
    vendor_name: '',
    vendor_id: '',
    vendor_company_id: 'primary',
    vendor_company_name: '',
    vendor_company_gstin: '',
    vendor_company_address: '',
    description: '',
    amount: '',
    gst_amount: '',
    linked_inventory_id: '',
    linked_po_id: '',    // PO id (format: projectId::po_no) that this PI supersedes
    linked_po_no: '',    // human-readable PO number
    include_in_ledger: false, // show in vendor public ledger
    purchase_mode: 'Credit',
    status: 'Pending',
    images: [],   // [{ url, name, path, uploaded_at }]
    remarks: '',
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

  const makeVendorEntityValue = (vendorId, companyId = 'primary') => (
    companyId && companyId !== 'primary' ? `${vendorId}::${companyId}` : vendorId
  );

  const vendorEntityOptions = useMemo(() => {
    const options = [];
    clients
      .filter(c => c.type === 'Vendor' || c.type === 'Both' || c.type === 'Supplier')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .forEach(v => {
        const companies = getPartyCompanies(v);
        companies.forEach(co => {
          options.push({
            value: makeVendorEntityValue(v.id, co.id),
            vendor_id: v.id,
            company_id: co.id,
            company_name: co.name,
            company_gstin: co.gstin,
            company_address: co.address,
            label: co.id === 'primary' ? v.name : `${v.name} — ${co.name}`,
          });
        });
      });
    return options;
  }, [clients]);

  // ── Firestore listener: load purchase_invoices ──
  useEffect(() => {
    if (!db || !appId) return;
    const loadData = async () => {
      setLoading(true);
      try {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices'));
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        data.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        setRecords(data);
        setPurchaseInvoicesExternal?.(data);
      } catch (e) { console.error(e); }
      setLoading(false);
    };
    loadData();
  }, [db, appId]);

  // ── Auto-number generation ──
  const generatePINumber = async (dateStr) => {
    const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
    const orgSettings = orgSnap.exists() ? orgSnap.data() : {};
    return generateBookInvoiceNumber({
      db,
      appId,
      dateStr,
      bookType: 'purchase',
      orgSettings,
    });
  };

  // ── Image upload ──
  const handleImageUpload = async (files, piNo) => {
    const uploaded = [];
    for (let i = 0; i < files.length; i++) {
      setUploadingIdx(i);
      const file = files[i];
      const ext = file.name.split('.').pop();
      const path = `purchase-invoices/${appId}/${piNo}/${Date.now()}_${i}.${ext}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      uploaded.push({ url, name: file.name, path, uploaded_at: new Date().toISOString() });
    }
    setUploadingIdx(null);
    return uploaded;
  };

  // ── Open add / edit ──
  const openAdd = () => {
    setEditingId(null);
    setForm(initialForm);
    setIsModalOpen(true);
  };

  const openEdit = (rec) => {
    setEditingId(rec.id);
    setForm({
      type: rec.type || 'Asset',
      invoice_date: rec.invoice_date || '',
      invoice_ref: rec.invoice_ref || '',
      vendor_name: rec.vendor_name || '',
      vendor_id: rec.vendor_id || '',
      vendor_company_id: rec.vendor_company_id || 'primary',
      vendor_company_name: rec.vendor_company_name || '',
      vendor_company_gstin: rec.vendor_company_gstin || '',
      vendor_company_address: rec.vendor_company_address || '',
      description: rec.description || '',
      amount: rec.amount || '',
      gst_amount: rec.gst_amount || '',
      linked_inventory_id: rec.linked_inventory_id || '',
      linked_po_id: rec.linked_po_id || '',
      linked_po_no: rec.linked_po_no || '',
      include_in_ledger: rec.include_in_ledger || false,
      purchase_mode: rec.purchase_mode || 'Credit',
      status: rec.status || 'Pending',
      images: rec.images || [],
      remarks: rec.remarks || '',
    });
    setIsModalOpen(true);
  };

  // ── Save ──
  const handleSave = async () => {
    if (editingId ? !can(role, 'purchase_invoices', 'edit') : !can(role, 'purchase_invoices', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    if (!form.invoice_date) return notify('Invoice date is required.', 'error');
    if (!form.vendor_name && !form.vendor_id) return notify('Vendor / Supplier name is required.', 'error');
    // C-2 fix: enforce FY lock on PI save (was Finance.jsx-only).
    if (!assertFYNotLocked(form.invoice_date, lockedFYs)) return;
    if (editingId) {
      const prev = records.find(r => r.id === editingId);
      if (prev?.invoice_date && !assertFYNotLocked(prev.invoice_date, lockedFYs)) return;
    }

    setLoading(true);
    try {
      let piNo = editingId ? records.find(r => r.id === editingId)?.pi_no : null;
      if (!piNo) piNo = await generatePINumber(form.invoice_date);

      const selectedVendor = clients.find(c => c.id === form.vendor_id);
      const companies = getPartyCompanies(selectedVendor);
      const selectedCompany = companies.find(c => c.id === (form.vendor_company_id || 'primary')) || companies[0] || null;

      const data = {
        pi_no: piNo,
        type: form.type,
        invoice_date: form.invoice_date,
        invoice_ref: form.invoice_ref,
        vendor_name: form.vendor_id
          ? (clients.find(c => c.id === form.vendor_id)?.name || form.vendor_name)
          : form.vendor_name,
        vendor_id: form.vendor_id || '',
        vendor_company_id: selectedCompany?.id || 'primary',
        vendor_company_name: selectedCompany?.name || (selectedVendor?.name || ''),
        vendor_company_gstin: selectedCompany?.gstin || (selectedVendor?.gstin || ''),
        vendor_company_address: selectedCompany?.address || (selectedVendor?.address || ''),
        description: form.description,
        amount: parseFloat(form.amount) || 0,
        gst_amount: parseFloat(form.gst_amount) || 0,
        linked_inventory_id: form.linked_inventory_id || '',
        linked_po_id: form.linked_po_id || '',
        linked_po_no: form.linked_po_no || '',
        include_in_ledger: form.include_in_ledger || false,
        purchase_mode: form.purchase_mode || 'Credit',
        status: form.status,
        images: form.images || [],
        remarks: form.remarks,
        fy: getFYFromDate(form.invoice_date),
        updated_at: new Date().toISOString(),
      };

      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices', editingId), data);
        setRecords(prev => {
          const next = prev.map(r => r.id === editingId ? { ...r, ...data } : r);
          setPurchaseInvoicesExternal?.(next);
          return next;
        });
        logAction('purchase_invoices', 'update', editingId, data, piNo);
      } else {
        data.created_at = new Date().toISOString();
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices'), data);
        setRecords(prev => {
          const next = [{ id: docRef.id, ...data }, ...prev];
          setPurchaseInvoicesExternal?.(next);
          return next;
        });
        logAction('purchase_invoices', 'create', docRef.id, data, piNo);
      }
      setIsModalOpen(false);
    } catch (e) {
      console.error(e);
      notify('Save failed: ' + e.message, 'error');
    }
    setLoading(false);
  };

  // ── Delete ──
  const handleDelete = (rec) => {
    if (!can(role, 'purchase_invoices', 'delete')) return notify('Access denied: insufficient permissions.', 'error');
    if (!assertFYNotLocked(rec?.invoice_date, lockedFYs)) return;
    setDeleteConfirm({
      isOpen: true,
      title: `Delete ${rec.pi_no}`,
      message: `Permanently delete purchase invoice ${rec.pi_no}? Images will also be removed.`,
      onConfirm: async () => {
        try {
          // Delete images from Storage
          for (const img of rec.images || []) {
            if (img.path) {
              try { await deleteObject(ref(storage, img.path)); } catch (_) {}
            }
          }
          await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices', rec.id));
          setRecords(prev => {
            const next = prev.filter(r => r.id !== rec.id);
            setPurchaseInvoicesExternal?.(next);
            return next;
          });
          logAction('purchase_invoices', 'delete', rec.id, {}, rec.pi_no);
        } catch (e) { notify('Delete failed: ' + e.message, 'error'); }
      }
    });
  };

  // ── Remove single image ──
  const removeImage = async (idx) => {
    const img = form.images[idx];
    if (img.path) {
      try { await deleteObject(ref(storage, img.path)); } catch (_) {}
    }
    setForm(f => ({ ...f, images: f.images.filter((_, i) => i !== idx) }));
  };

  // ── File picker handler ──
  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const piNo = editingId ? records.find(r => r.id === editingId)?.pi_no : `TEMP-${Date.now()}`;
    try {
      const uploaded = await handleImageUpload(files, piNo);
      setForm(f => ({ ...f, images: [...(f.images || []), ...uploaded] }));
    } catch (err) {
      notify('Upload failed: ' + err.message, 'error');
    }
    e.target.value = '';
  };

  // ── All FYs for filter ──
  const allFYs = useMemo(() => [...new Set(records.map(r => r.fy).filter(Boolean))].sort().reverse(), [records]);

  // ── Filtered records ──
  const filtered = useMemo(() => records.filter(r => {
    const q = searchTerm.toLowerCase();
    const matchSearch = !q ||
      (r.pi_no || '').toLowerCase().includes(q) ||
      (r.vendor_name || '').toLowerCase().includes(q) ||
      (r.invoice_ref || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q);
    const matchType   = filterType   === 'All' || r.type   === filterType;
    const matchStatus = filterStatus === 'All' || r.status === filterStatus;
    const matchFY     = filterFY     === 'All' || r.fy     === filterFY;
    return matchSearch && matchType && matchStatus && matchFY;
  }), [records, searchTerm, filterType, filterStatus, filterFY]);

  const paginated = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filtered.slice(start, start + itemsPerPage);
  }, [filtered, currentPage]);

  useEffect(() => setCurrentPage(1), [searchTerm, filterType, filterStatus, filterFY]);

  // ── Totals ──
  const totals = useMemo(() => ({
    amount: filtered.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
    gst:    filtered.reduce((s, r) => s + (parseFloat(r.gst_amount) || 0), 0),
    count:  filtered.length,
    asset:  filtered.filter(r => r.type === 'Asset').length,
    service:filtered.filter(r => r.type === 'Service').length,
  }), [filtered]);

  // ────────────────────────────────────────────────────────── render ──

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Purchase Invoices</h2>
          <p className="text-sm text-slate-500 mt-0.5">Track asset &amp; service purchases with images and warranty records</p>
        </div>
        {(role === 'admin' || role === 'manager') && (
          <button onClick={openAdd} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white text-sm hover:bg-indigo-700 shrink-0 font-medium shadow-sm">
            <Plus size={16} /> New Purchase Invoice
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Records', value: totals.count, sub: `${totals.asset} Asset · ${totals.service} Service`, color: 'bg-slate-50 border-slate-200' },
          { label: 'Total Amount', value: formatCurrency(totals.amount), sub: 'excl. GST', color: 'bg-blue-50 border-blue-200' },
          { label: 'Total GST', value: formatCurrency(totals.gst), sub: 'input tax credit', color: 'bg-purple-50 border-purple-200' },
          { label: 'Grand Total', value: formatCurrency(totals.amount + totals.gst), sub: 'incl. GST', color: 'bg-indigo-50 border-indigo-200' },
        ].map(c => (
          <div key={c.label} className={`rounded-xl border p-3 ${c.color}`}>
            <div className="text-xs text-slate-500 font-medium">{c.label}</div>
            <div className="text-lg font-bold text-slate-800 mt-0.5">{c.value}</div>
            <div className="text-[10px] text-slate-400">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 gap-2 flex-1 min-w-48">
          <Search size={14} className="text-slate-400 shrink-0" />
          <input
            className="text-sm outline-none text-slate-800 bg-transparent w-full"
            placeholder="Search PI no., vendor, description…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        {[
          { label: 'Type', value: filterType, set: setFilterType, options: ['All', 'Asset', 'Service'] },
          { label: 'Status', value: filterStatus, set: setFilterStatus, options: ['All', 'Pending', 'Verified', 'Rejected'] },
          { label: 'FY', value: filterFY, set: setFilterFY, options: ['All', ...allFYs] },
        ].map(f => (
          <select key={f.label} value={f.value} onChange={e => f.set(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none">
            {f.options.map(o => <option key={o} value={o}>{f.label === 'FY' ? (o === 'All' ? 'All FY' : `FY ${o}`) : o}</option>)}
          </select>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-slate-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <FileText size={32} className="mx-auto mb-2 opacity-30" />
            No purchase invoices found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-3 font-medium text-slate-500">PI No.</th>
                  <th className="p-3 font-medium text-slate-500">Type</th>
                  <th className="p-3 font-medium text-slate-500">Date</th>
                  <th className="p-3 font-medium text-slate-500">Vendor</th>
                  <th className="p-3 font-medium text-slate-500">Company</th>
                  <th className="p-3 font-medium text-slate-500 hidden md:table-cell">Inv. Ref</th>
                  <th className="p-3 font-medium text-slate-500 text-center">Mode</th>
                  <th className="p-3 font-medium text-slate-500 text-right">Amount</th>
                  <th className="p-3 font-medium text-slate-500 text-right hidden md:table-cell">GST</th>
                  <th className="p-3 font-medium text-slate-500 text-center">Status</th>
                  <th className="p-3 font-medium text-slate-500 text-center hidden md:table-cell">Images</th>
                  {(role === 'admin' || role === 'manager') && <th className="p-3 font-medium text-slate-500 text-center">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginated.map(rec => {
                  const tStyle = TYPE_STYLES[rec.type] || TYPE_STYLES.Asset;
                  const sStyle = STATUS_STYLES[rec.status] || STATUS_STYLES.Pending;
                  const SIcon = sStyle.icon;
                  return (
                    <tr key={rec.id} className="hover:bg-slate-50 group">
                      <td className="p-3">
                        <span className="font-mono text-sm font-bold text-indigo-700">{rec.pi_no}</span>
                        {rec.linked_inventory_id && (
                          <div className="text-[10px] text-slate-400 truncate max-w-[100px]">
                            {inventory.find(i => i.id === rec.linked_inventory_id)?.name || ''}
                          </div>
                        )}
                        {rec.linked_po_no && (
                          <div className="text-[10px] text-purple-500 truncate max-w-[100px]">PO: {rec.linked_po_no}</div>
                        )}
                        {rec.include_in_ledger && (
                          <div className="text-[10px] text-green-600 font-semibold">📒 In Ledger</div>
                        )}
                      </td>
                      <td className="p-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${tStyle.bg}`}>
                          <tStyle.icon size={10} /> {rec.type}
                        </span>
                      </td>
                      <td className="p-3 text-slate-600 text-xs whitespace-nowrap">{rec.invoice_date}</td>
                      <td className="p-3 text-slate-700 font-medium text-xs">
                        <div className="truncate max-w-[140px]">{rec.vendor_name || '—'}</div>
                      </td>
                      <td className="p-3 text-slate-500 text-xs">
                        <div className="truncate max-w-[140px]">{rec.vendor_company_name || rec.vendor_name || '—'}</div>
                      </td>
                      <td className="p-3 text-slate-500 text-xs hidden md:table-cell">{rec.invoice_ref || '—'}</td>
                      <td className="p-3 text-center">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${(rec.purchase_mode || 'Credit') === 'Cash' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-orange-100 text-orange-700 border-orange-200'}`}>
                          {rec.purchase_mode || 'Credit'}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono text-slate-800 text-sm">{formatCurrency(rec.amount || 0)}</td>
                      <td className="p-3 text-right font-mono text-slate-500 text-xs hidden md:table-cell">{formatCurrency(rec.gst_amount || 0)}</td>
                      <td className="p-3 text-center">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${sStyle.bg}`}>
                          <SIcon size={10} /> {rec.status}
                        </span>
                      </td>
                      <td className="p-3 text-center hidden md:table-cell">
                        {(rec.images || []).length > 0 ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => setLightbox({ images: rec.images, idx: 0 })}
                              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-0.5 rounded-full"
                            >
                              <ImageIcon size={11} /> {rec.images.length}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                      {(role === 'admin' || role === 'manager') && (
                        <td className="p-3 text-center">
                          <div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => openEdit(rec)} className="rounded p-1 text-blue-600 hover:bg-blue-50"><Edit size={15} /></button>
                            <button onClick={() => handleDelete(rec)} className="rounded p-1 text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > itemsPerPage && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">
            {Math.min((currentPage - 1) * itemsPerPage + 1, filtered.length)}–{Math.min(currentPage * itemsPerPage, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
              className="px-3 py-1.5 rounded-lg border bg-indigo-600 text-white text-sm disabled:opacity-40">Previous</button>
            <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(filtered.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(filtered.length / itemsPerPage)}
              className="px-3 py-1.5 rounded-lg border bg-indigo-600 text-white text-sm disabled:opacity-40">Next</button>
          </div>
        </div>
      )}

      {/* ═══════════ ADD/EDIT MODAL ═══════════ */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? `Edit ${records.find(r => r.id === editingId)?.pi_no || 'Invoice'}` : 'New Purchase Invoice'}>
        <div className="space-y-4">

          {/* Type selector */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Purchase Type <span className="text-red-500">*</span></label>
            <div className="flex gap-3">
              {['Asset', 'Service'].map(t => (
                <label key={t} className={`flex-1 flex items-center gap-2 border rounded-lg p-3 cursor-pointer transition-colors ${form.type === t ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <input type="radio" name="pi_type" value={t} checked={form.type === t} onChange={() => setForm(f => ({ ...f, type: t }))} className="accent-indigo-600" />
                  <div>
                    <div className="text-sm font-bold text-slate-800">{t === 'Asset' ? '🏷 Asset' : '🔧 Service'}</div>
                    <div className="text-[10px] text-slate-500">{t === 'Asset' ? 'Equipment, tools, hardware' : 'Labour, maintenance, repair'}</div>
                  </div>
                  <span className={`ml-auto text-xs font-mono font-bold px-2 py-0.5 rounded ${t === 'Asset' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                    PI-0001-{getFYFromDate(form.invoice_date)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Row: date + invoice ref */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Invoice Date <span className="text-red-500">*</span></label>
              <input type="date" className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                value={form.invoice_date} onChange={e => setForm(f => ({ ...f, invoice_date: e.target.value }))} />
              <div className="text-[10px] text-slate-400 mt-0.5">FY: {getFYFromDate(form.invoice_date)}</div>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Vendor Invoice Ref.</label>
              <input type="text" className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                placeholder="e.g. INV/2025/001"
                value={form.invoice_ref} onChange={e => setForm(f => ({ ...f, invoice_ref: e.target.value }))} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Purchase Mode</label>
            <select
              className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
              value={form.purchase_mode || 'Credit'}
              onChange={e => setForm(f => ({ ...f, purchase_mode: e.target.value }))}
            >
              <option value="Credit">Credit</option>
              <option value="Cash">Cash</option>
            </select>
            <div className="text-[10px] text-slate-400 mt-0.5">Purchase book can be tracked separately as cash or credit.</div>
          </div>

          {/* Vendor */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Vendor / Supplier <span className="text-red-500">*</span></label>
            <div className="flex gap-2">
              <select
                className="w-48 rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                value={makeVendorEntityValue(form.vendor_id, form.vendor_company_id || 'primary')}
                onChange={e => {
                  const selected = vendorEntityOptions.find(v => v.value === e.target.value);
                  if (!selected) {
                    setForm(f => ({ ...f, vendor_id: '', vendor_name: '', vendor_company_id: 'primary', vendor_company_name: '', vendor_company_gstin: '', vendor_company_address: '', linked_po_id: '', linked_po_no: '' }));
                    return;
                  }
                  setForm(f => ({
                    ...f,
                    vendor_id: selected.vendor_id,
                    vendor_name: '',
                    vendor_company_id: selected.company_id,
                    vendor_company_name: selected.company_name,
                    vendor_company_gstin: selected.company_gstin,
                    vendor_company_address: selected.company_address,
                    linked_po_id: '',
                    linked_po_no: '',
                  }));
                }}
              >
                <option value="">— Type manually —</option>
                {vendorEntityOptions.map(v => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
              {!form.vendor_id && (
                <input type="text" className="flex-1 rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                  placeholder="Vendor / supplier name"
                  value={form.vendor_name} onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value }))} />
              )}
              {form.vendor_id && (
                <div className="flex-1 rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-sm text-indigo-700 font-medium truncate">
                  {clients.find(c => c.id === form.vendor_id)?.name}{form.vendor_company_name ? ` — ${form.vendor_company_name}` : ''}
                  <button className="ml-2 text-xs text-slate-400 hover:text-red-500" onClick={() => setForm(f => ({ ...f, vendor_id: '', vendor_company_id: 'primary', vendor_company_name: '', vendor_company_gstin: '', vendor_company_address: '', linked_po_id: '', linked_po_no: '' }))}>✕</button>
                </div>
              )}
            </div>
          </div>

          {/* Link to Purchase Order (Service type + vendor selected) */}
          {form.type === 'Service' && form.vendor_id && (() => {
            const vendorPOs = [];
            projects.forEach(proj => {
              (proj.purchase_orders || []).forEach(po => {
                if (po.vendor_id === form.vendor_id && po.status !== 'Cancelled') {
                  // H-5: prefer the stable po.id over the brittle composite key.
                  // Fall back to composite for older POs that lack `id`.
                  const stableKey = po.id || `${proj.id}::${po.po_no}`;
                  vendorPOs.push({ key: stableKey, po_no: po.po_no, project_name: proj.project_name, date: po.date });
                }
              });
            });
            if (vendorPOs.length === 0) return null;
            return (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Link to Purchase Order <span className="text-slate-400">(optional — supersedes PO in ledger)</span></label>
                <select
                  className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                  value={form.linked_po_id}
                  onChange={e => {
                    const sel = vendorPOs.find(p => p.key === e.target.value);
                    setForm(f => ({ ...f, linked_po_id: e.target.value, linked_po_no: sel ? sel.po_no : '' }));
                  }}
                >
                  <option value="">— No PO linked (standalone entry) —</option>
                  {vendorPOs.map(p => (
                    <option key={p.key} value={p.key}>{p.po_no} · {p.project_name}{p.date ? ` (${p.date})` : ''}</option>
                  ))}
                </select>
                {form.linked_po_id && (
                  <p className="text-[10px] text-indigo-600 mt-1">This PI will replace the linked PO in the vendor ledger when "Take in Ledger" is on.</p>
                )}
              </div>
            );
          })()}

          {/* Take in Ledger toggle */}
          {form.vendor_id && (
            <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors select-none"
              style={{ background: form.include_in_ledger ? '#eef2ff' : '', borderColor: form.include_in_ledger ? '#6366f1' : '#e2e8f0' }}>
              <input type="checkbox" className="accent-indigo-600 w-4 h-4"
                checked={form.include_in_ledger}
                onChange={e => setForm(f => ({ ...f, include_in_ledger: e.target.checked }))} />
              <div>
                <div className="text-sm font-bold text-slate-800">Take in Ledger</div>
                <div className="text-[10px] text-slate-500">Include this purchase invoice in the vendor's public ledger balance. {form.linked_po_id ? 'Will replace the linked PO entry.' : 'Will appear as a standalone payable.'}</div>
              </div>
            </label>
          )}

          {/* Description */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Description</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800" rows={2}
              placeholder="What was purchased…"
              value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>

          {/* Amount row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Amount (excl. GST)</label>
              <input type="number" min="0" className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                placeholder="0.00"
                value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">GST Amount</label>
              <input type="number" min="0" className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                placeholder="0.00"
                value={form.gst_amount} onChange={e => setForm(f => ({ ...f, gst_amount: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Grand Total</label>
              <div className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700 font-bold">
                {formatCurrency((parseFloat(form.amount) || 0) + (parseFloat(form.gst_amount) || 0))}
              </div>
            </div>
          </div>

          {/* Link inventory (Asset only) */}
          {form.type === 'Asset' && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Link to Inventory Item <span className="text-slate-400">(optional)</span></label>
              <select className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
                value={form.linked_inventory_id} onChange={e => setForm(f => ({ ...f, linked_inventory_id: e.target.value }))}>
                <option value="">— Not linked —</option>
                {inventory.map(i => <option key={i.id} value={i.id}>{i.name} {i.brand ? `(${i.brand})` : ''}</option>)}
              </select>
            </div>
          )}

          {/* Status */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Status</label>
            <div className="flex gap-2">
              {['Pending', 'Verified', 'Rejected'].map(s => {
                const st = STATUS_STYLES[s];
                return (
                  <label key={s} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border cursor-pointer text-sm font-medium transition-colors ${form.status === s ? `${st.bg} border-current` : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                    <input type="radio" name="pi_status" value={s} checked={form.status === s} onChange={() => setForm(f => ({ ...f, status: s }))} className="sr-only" />
                    <st.icon size={13} /> {s}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Remarks */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Remarks / Notes</label>
            <input type="text" className="w-full rounded-lg border border-slate-300 p-2 text-sm bg-white text-slate-800"
              placeholder="Additional notes…"
              value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
          </div>

          {/* Image Upload */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-700">Invoice Images</label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingIdx !== null}
                className="flex items-center gap-1 text-xs bg-indigo-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                <Upload size={12} /> {uploadingIdx !== null ? `Uploading ${uploadingIdx + 1}…` : 'Upload Images'}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={handleFileChange} />
            </div>

            {(form.images || []).length > 0 ? (
              <div className="grid grid-cols-3 gap-2 max-h-40 overflow-y-auto">
                {form.images.map((img, idx) => (
                  <div key={idx} className="relative group rounded-lg overflow-hidden border border-slate-200 bg-slate-50 aspect-square flex items-center justify-center">
                    {img.name?.toLowerCase().endsWith('.pdf') ? (
                      <div className="flex flex-col items-center gap-1 p-2 text-center">
                        <FileText size={24} className="text-red-500" />
                        <span className="text-[10px] text-slate-500 truncate w-full text-center">{img.name}</span>
                      </div>
                    ) : (
                      <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                    )}
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                      <button onClick={() => setLightbox({ images: form.images, idx })} className="p-1 rounded bg-white/90 text-slate-800 hover:bg-white">
                        <ZoomIn size={13} />
                      </button>
                      <button onClick={() => removeImage(idx)} className="p-1 rounded bg-white/90 text-red-600 hover:bg-white">
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={20} className="mx-auto text-slate-300 mb-1" />
                <p className="text-xs text-slate-400">Click to upload invoice images or PDFs</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">
              {loading ? 'Saving…' : editingId ? 'Update Invoice' : 'Create Invoice'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ═══════════ LIGHTBOX ═══════════ */}
      {lightbox && (
        <div className="fixed inset-0 z-[300] bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <div className="relative max-w-4xl w-full max-h-full" onClick={e => e.stopPropagation()}>
            <button onClick={() => setLightbox(null)} className="absolute -top-10 right-0 text-white hover:text-slate-300 p-2">
              <X size={24} />
            </button>
            {lightbox.images[lightbox.idx]?.name?.toLowerCase().endsWith('.pdf') ? (
              <div className="bg-white rounded-xl p-8 text-center">
                <FileText size={48} className="mx-auto text-red-500 mb-3" />
                <p className="text-slate-700 font-medium">{lightbox.images[lightbox.idx].name}</p>
                <a href={lightbox.images[lightbox.idx].url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">
                  <Download size={14} /> Open PDF
                </a>
              </div>
            ) : (
              <img src={lightbox.images[lightbox.idx]?.url} alt="" className="max-h-[80vh] w-full object-contain rounded-xl" />
            )}
            {lightbox.images.length > 1 && (
              <div className="flex items-center justify-center gap-4 mt-4">
                <button
                  disabled={lightbox.idx === 0}
                  onClick={() => setLightbox(l => ({ ...l, idx: l.idx - 1 }))}
                  className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 disabled:opacity-30 text-sm"
                >← Prev</button>
                <span className="text-white text-sm">{lightbox.idx + 1} / {lightbox.images.length}</span>
                <button
                  disabled={lightbox.idx === lightbox.images.length - 1}
                  onClick={() => setLightbox(l => ({ ...l, idx: l.idx + 1 }))}
                  className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 disabled:opacity-30 text-sm"
                >Next →</button>
              </div>
            )}
            {/* Thumbnail strip */}
            {lightbox.images.length > 1 && (
              <div className="flex gap-2 mt-3 justify-center overflow-x-auto">
                {lightbox.images.map((img, i) => (
                  <button key={i} onClick={() => setLightbox(l => ({ ...l, idx: i }))}
                    className={`w-12 h-12 rounded border-2 overflow-hidden shrink-0 ${i === lightbox.idx ? 'border-indigo-500' : 'border-white/30'}`}>
                    {img.name?.toLowerCase().endsWith('.pdf')
                      ? <div className="w-full h-full bg-red-100 flex items-center justify-center"><FileText size={16} className="text-red-500" /></div>
                      : <img src={img.url} alt="" className="w-full h-full object-cover" />
                    }
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm(p => ({ ...p, isOpen: false }))}
        onConfirm={deleteConfirm.onConfirm}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        requireTyped={false}
      />
    </div>
  );
};

export default PurchaseInvoices;
