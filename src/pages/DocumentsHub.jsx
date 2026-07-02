import React, { useState, useMemo } from 'react';
import { notify } from '../utils/toast';
import {
  Search, FileText, Truck, RotateCcw, ShoppingBag, Receipt,
  Filter, X, ChevronDown, ChevronUp, Eye, Printer,
  Calendar, Building2, Hash, Tag, Download, ExternalLink
} from 'lucide-react';
import { formatCurrency } from '../utils/helpers';
import { can } from '../utils/permissions';
import { Modal } from '../components/Shared';
import { useNavigate } from 'react-router-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { doc, getDoc, updateDoc, arrayRemove, arrayUnion } from 'firebase/firestore';

// ─── Constants ─────────────────────────────────────────────────────────────────
const DOC_TYPES = [
  { key: 'all',       label: 'All Documents',      icon: FileText,   color: 'slate' },
  { key: 'delivery',  label: 'Delivery Challans',  icon: Truck,      color: 'blue' },
  { key: 'return',    label: 'Return Challans',     icon: RotateCcw,  color: 'orange' },
  { key: 'po',        label: 'Purchase Orders',     icon: ShoppingBag,color: 'purple' },
  { key: 'proforma',  label: 'Proforma Invoices',   icon: Receipt,    color: 'teal' },
];

const PO_STATUSES   = ['Draft', 'Sent', 'Approved', 'Partial', 'Paid', 'Closed', 'Cancelled'];
const CHALLAN_TYPES = ['delivery', 'return'];

const TYPE_BADGE = {
  delivery: 'bg-blue-100 text-blue-700 border-blue-200',
  return:   'bg-orange-100 text-orange-700 border-orange-200',
  po:       'bg-purple-100 text-purple-700 border-purple-200',
  proforma: 'bg-teal-100 text-teal-700 border-teal-200',
};
const TYPE_LABEL = {
  delivery: 'Delivery Challan',
  return:   'Return Challan',
  po:       'Purchase Order',
  proforma: 'Proforma Invoice',
};

const STATUS_BADGE = {
  Draft:     'bg-slate-100 text-slate-600',
  Sent:      'bg-blue-100 text-blue-700',
  Approved:  'bg-green-100 text-green-700',
  Partial:   'bg-yellow-100 text-yellow-700',
  Paid:      'bg-emerald-100 text-emerald-700',
  Closed:    'bg-gray-100 text-gray-600',
  Cancelled: 'bg-red-100 text-red-600',
};

// ─── Helper ─────────────────────────────────────────────────────────────────────
const fmt = (dateStr) => {
  if (!dateStr) return '—';
  try { return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return dateStr; }
};

// ─── Main Component ─────────────────────────────────────────────────────────────
const DocumentsHub = ({ projects = [], clients = [], role, currentEmpId = null, db, appId, logAction }) => {
  // A manager sees documents (PO amounts, cost breakdowns, proforma totals) only
  // for their OWN projects — never another manager's clients'.
  const scopedProjects = useMemo(
    () => (role === 'manager'
      ? projects.filter(p => p.client_owner_id === currentEmpId || p.created_by === currentEmpId)
      : projects),
    [projects, role, currentEmpId],
  );
  const navigate = useNavigate();

  // ── Filters ──────────────────────────────────────────────────────────────────
  const [docType,    setDocType]    = useState('all');
  const [search,     setSearch]     = useState('');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sortField,  setSortField]  = useState('date');
  const [sortDir,    setSortDir]    = useState('desc');
  const [page,       setPage]       = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const PER_PAGE = 25;

  // ── Detail modal ──────────────────────────────────────────────────────────────
  const [detailDoc, setDetailDoc] = useState(null);

  // ─── Build flat document list ─────────────────────────────────────────────────
  const allDocs = useMemo(() => {
    const list = [];

    scopedProjects.forEach(p => {
      const client = clients.find(c => c.id === p.client_id);
      const clientName = client?.name || p.client_name || '—';

      // Delivery + Return Challans
      (p.challans || []).forEach(c => {
        list.push({
          _type:       c.type === 'return' ? 'return' : 'delivery',
          id:          c.id,
          ref:         c.type === 'return' ? `RET/${c.challan_no}` : (c.challan_no || '—'),
          date:        c.date,
          projectId:   p.id,
          projectName: p.project_name,
          clientId:    p.client_id,
          clientName,
          vendorName:  '—',
          status:      c.type === 'return' ? 'Returned' : 'Delivered',
          amount:      null,
          items:       c.items || [],
          transport:   c.transport || {},
          _raw:        c,
          _project:    p,
        });
      });

      // Purchase Orders
      (p.purchase_orders || []).forEach(po => {
        const vendor = clients.find(c => c.id === po.vendor_id);
        list.push({
          _type:       'po',
          id:          po.id,
          ref:         po.po_no || '—',
          date:        po.date,
          projectId:   p.id,
          projectName: p.project_name,
          clientId:    p.client_id,
          clientName,
          vendorId:    po.vendor_id,
          vendorName:  vendor?.name || po.vendor_name || '—',
          status:      po.status || 'Draft',
          amount:      po.amount,
          items:       po.items || [],
          subject:     po.subject,
          terms:       po.terms,
          notes:       po.notes,
          costs:       po.costs,
          _raw:        po,
          _project:    p,
        });
      });

      // Proforma Invoices
      (p.proforma_invoices || []).forEach(pi => {
        list.push({
          _type:       'proforma',
          id:          pi.id || pi.pi_no,
          ref:         pi.pi_no || '—',
          date:        pi.date || pi.created_at,
          projectId:   p.id,
          projectName: p.project_name,
          clientId:    p.client_id,
          clientName,
          vendorName:  '—',
          status:      pi.status || 'Issued',
          amount:      pi.grand_total || pi.total || null,
          items:       pi.items || [],
          notes:       pi.notes,
          payment_terms: pi.payment_terms,
          _raw:        pi,
          _project:    p,
        });
      });
    });

    return list;
  }, [scopedProjects, clients]);

  // ─── Filtered + sorted list ───────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = allDocs;

    if (docType !== 'all') list = list.filter(d => d._type === docType);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(d =>
        (d.ref || '').toLowerCase().includes(q) ||
        (d.clientName || '').toLowerCase().includes(q) ||
        (d.vendorName || '').toLowerCase().includes(q) ||
        (d.projectName || '').toLowerCase().includes(q) ||
        (d.subject || '').toLowerCase().includes(q)
      );
    }

    if (dateFrom) list = list.filter(d => d.date && d.date >= dateFrom);
    if (dateTo)   list = list.filter(d => d.date && d.date.substring(0, 10) <= dateTo);

    if (statusFilter) list = list.filter(d => d.status === statusFilter);
    if (projectFilter) list = list.filter(d => d.projectId === projectFilter);

    list = [...list].sort((a, b) => {
      let va = a[sortField] ?? '';
      let vb = b[sortField] ?? '';
      if (sortField === 'amount') { va = va || 0; vb = vb || 0; }
      const cmp = typeof va === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [allDocs, docType, search, dateFrom, dateTo, statusFilter, projectFilter, sortField, sortDir]);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paginated  = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
    setPage(1);
  };
  const resetFilters = () => {
    setSearch(''); setDateFrom(''); setDateTo('');
    setStatusFilter(''); setProjectFilter(''); setDocType('all'); setPage(1);
  };
  const activeFiltersCount = [search, dateFrom, dateTo, statusFilter, projectFilter]
    .filter(Boolean).length + (docType !== 'all' ? 1 : 0);

  // ─── Summary counts ───────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = { delivery: 0, return: 0, po: 0, proforma: 0 };
    allDocs.forEach(d => c[d._type]++);
    return c;
  }, [allDocs]);

  // ─── PDF print (simple summary) ───────────────────────────────────────────────
  const handlePrintList = () => {
    const pdfDoc = new jsPDF({ orientation: 'landscape' });
    pdfDoc.setFontSize(14);
    pdfDoc.setFont('helvetica', 'bold');
    pdfDoc.text('Documents Hub — Summary', 14, 16);
    pdfDoc.setFontSize(8);
    pdfDoc.setFont('helvetica', 'normal');
    pdfDoc.text(`Generated: ${new Date().toLocaleString('en-IN')}  |  Total: ${filtered.length} documents`, 14, 22);

    autoTable(pdfDoc, {
      startY: 28,
      head: [['Type', 'Reference', 'Date', 'Project', 'Client / Vendor', 'Status', 'Amount']],
      body: filtered.slice(0, 500).map(d => [
        TYPE_LABEL[d._type],
        d.ref,
        fmt(d.date),
        d.projectName,
        d._type === 'po' ? d.vendorName : d.clientName,
        d.status,
        d.amount != null ? formatCurrency(d.amount) : '—',
      ]),
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [79, 70, 229], fontSize: 8 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });

    pdfDoc.save(`Documents_Hub_${new Date().toISOString().split('T')[0]}.pdf`);
  };

  // ─── PO Status update ─────────────────────────────────────────────────────────
  const handleUpdatePOStatus = async (docEntry, newStatus) => {
    if (!can(role, 'documents', 'edit')) return notify('Permission denied.', 'error');
    try {
      const projRef   = doc(db, 'artifacts', appId, 'public', 'data', 'projects', docEntry.projectId);
      const projSnap  = await getDoc(projRef);
      if (!projSnap.exists()) return;
      const pData     = projSnap.data();
      const oldPO     = (pData.purchase_orders || []).find(p => p.id === docEntry.id);
      if (!oldPO) return;
      const updatedPO = { ...oldPO, status: newStatus };
      await updateDoc(projRef, { purchase_orders: arrayRemove(oldPO) });
      await updateDoc(projRef, { purchase_orders: arrayUnion(updatedPO) });
      logAction('projects', 'update_po_status', docEntry.projectId, { po_no: docEntry.ref, status: newStatus }, docEntry.projectName);
      // reflect in detailDoc
      if (detailDoc?.id === docEntry.id) setDetailDoc(d => ({ ...d, status: newStatus }));
    } catch (e) {
      console.error(e);
      notify('Error updating PO status.', 'error');
    }
  };

  // ─── Sort icon ────────────────────────────────────────────────────────────────
  const SortIcon = ({ field }) => sortField === field
    ? (sortDir === 'asc' ? <ChevronUp size={12} className="ml-1 inline" /> : <ChevronDown size={12} className="ml-1 inline" />)
    : <ChevronDown size={12} className="ml-1 inline opacity-30" />;

  // ─── RENDER ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Documents Hub</h2>
          <p className="text-sm text-slate-500 mt-0.5">Challans · Purchase Orders · Proforma Invoices — all in one place</p>
        </div>
        <button
          onClick={handlePrintList}
          className="flex items-center gap-2 rounded border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 text-slate-600"
        >
          <Download size={14} /> Export PDF
        </button>
      </div>

      {/* Type selector cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {DOC_TYPES.map(t => {
          const Icon  = t.icon;
          const count = t.key === 'all' ? allDocs.length : counts[t.key];
          const active = docType === t.key;
          return (
            <button
              key={t.key}
              onClick={() => { setDocType(t.key); setPage(1); }}
              className={`rounded-xl border p-3 text-left transition-all ${
                active
                  ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <Icon size={18} className={active ? 'text-indigo-600' : 'text-slate-400'} />
              <div className={`mt-1 text-lg font-bold ${active ? 'text-indigo-700' : 'text-slate-800'}`}>{count}</div>
              <div className="text-xs text-slate-500 leading-tight">{t.label}</div>
            </button>
          );
        })}
      </div>

      {/* Search + Filter bar */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full rounded border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400"
              placeholder="Search by reference, client, vendor, project…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
            {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={14} /></button>}
          </div>
          <button
            onClick={() => setShowFilters(v => !v)}
            className={`flex items-center gap-1 rounded border px-3 py-2 text-sm ${showFilters || activeFiltersCount > 0 ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
          >
            <Filter size={14} />
            Filters{activeFiltersCount > 0 && <span className="ml-1 rounded-full bg-indigo-600 text-white text-[10px] px-1.5">{activeFiltersCount}</span>}
          </button>
          {activeFiltersCount > 0 && (
            <button onClick={resetFilters} className="flex items-center gap-1 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 hover:bg-red-100">
              <X size={14} /> Clear
            </button>
          )}
        </div>

        {showFilters && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div>
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Date From</label>
              <input type="date" className="mt-1 w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800"
                value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Date To</label>
              <input type="date" className="mt-1 w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800"
                value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Status</label>
              <select className="mt-1 w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800"
                value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
                <option value="">All Statuses</option>
                {['Draft','Sent','Approved','Partial','Paid','Closed','Cancelled',
                  'Delivered','Returned','Issued'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Project</label>
              <select className="mt-1 w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800"
                value={projectFilter} onChange={e => { setProjectFilter(e.target.value); setPage(1); }}>
                <option value="">All Projects</option>
                {[...new Map(scopedProjects.map(p => [p.id, p])).values()].map(p => (
                  <option key={p.id} value={p.id}>{p.project_name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Results info */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span><span className="font-bold text-slate-700">{filtered.length}</span> document{filtered.length !== 1 ? 's' : ''} found</span>
        {totalPages > 1 && (
          <span>Page {page} of {totalPages}</span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-slate-50 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('ref')}>
                Reference <SortIcon field="ref" />
              </th>
              <th className="px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('date')}>
                Date <SortIcon field="date" />
              </th>
              <th className="px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('projectName')}>
                Project <SortIcon field="projectName" />
              </th>
              <th className="px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('clientName')}>
                Client / Vendor <SortIcon field="clientName" />
              </th>
              <th className="px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('status')}>
                Status <SortIcon field="status" />
              </th>
              <th className="px-4 py-3 cursor-pointer select-none text-right" onClick={() => handleSort('amount')}>
                Amount <SortIcon field="amount" />
              </th>
              <th className="px-4 py-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                  No documents match your filters.
                </td>
              </tr>
            ) : paginated.map((d, i) => (
              <tr key={`${d._type}-${d.id}-${i}`}
                className="border-b last:border-0 hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-bold ${TYPE_BADGE[d._type]}`}>
                    {TYPE_LABEL[d._type]}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs font-bold text-slate-800">{d.ref}</td>
                <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{fmt(d.date)}</td>
                <td className="px-4 py-3 max-w-[180px] truncate text-slate-700" title={d.projectName}>{d.projectName}</td>
                <td className="px-4 py-3 text-slate-600">
                  {d._type === 'po' ? (
                    <span className="flex items-center gap-1">
                      <Building2 size={12} className="text-purple-400" />
                      {d.vendorName}
                    </span>
                  ) : d.clientName}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[d.status] || 'bg-slate-100 text-slate-600'}`}>
                    {d.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-medium text-slate-700">
                  {d.amount != null ? formatCurrency(d.amount) : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => setDetailDoc(d)}
                      title="View Details"
                      className="rounded border border-slate-200 p-1.5 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200"
                    >
                      <Eye size={13} />
                    </button>
                    <button
                      onClick={() => navigate(`/projects/${d.projectId}`)}
                      title="Open Project"
                      className="rounded border border-slate-200 p-1.5 text-slate-500 hover:bg-teal-50 hover:text-teal-600 hover:border-teal-200"
                    >
                      <ExternalLink size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="rounded border px-3 py-1.5 text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-40"
          >← Prev</button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const pg = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page + i - 3;
            if (pg < 1 || pg > totalPages) return null;
            return (
              <button key={pg}
                onClick={() => setPage(pg)}
                className={`rounded border px-3 py-1.5 text-sm ${pg === page ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-200 hover:bg-slate-50'}`}
              >{pg}</button>
            );
          })}
          <button
            disabled={page === totalPages}
            onClick={() => setPage(p => p + 1)}
            className="rounded border px-3 py-1.5 text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-40"
          >Next →</button>
        </div>
      )}

      {/* ── Detail Modal ────────────────────────────────────────────────────────── */}
      <Modal
        isOpen={!!detailDoc}
        onClose={() => setDetailDoc(null)}
        title={`${TYPE_LABEL[detailDoc?._type] || 'Document'} — ${detailDoc?.ref}`}
      >
        {detailDoc && (
          <div className="space-y-4 text-sm">

            {/* Meta row */}
            <div className="grid grid-cols-2 gap-3">
              <InfoRow icon={Hash}       label="Reference"  value={detailDoc.ref} />
              <InfoRow icon={Calendar}   label="Date"       value={fmt(detailDoc.date)} />
              <InfoRow icon={FileText}   label="Project"    value={detailDoc.projectName} />
              <InfoRow icon={Building2}  label={detailDoc._type === 'po' ? 'Vendor' : 'Client'}
                value={detailDoc._type === 'po' ? detailDoc.vendorName : detailDoc.clientName} />
              {detailDoc.subject && <InfoRow icon={Tag} label="Subject" value={detailDoc.subject} className="col-span-2" />}
              {detailDoc.payment_terms && <InfoRow icon={Tag} label="Payment Terms" value={detailDoc.payment_terms} />}
            </div>

            {/* Status + change (PO only) */}
            <div className="flex items-center gap-3 rounded-lg bg-slate-50 border p-3">
              <span className="text-slate-500 font-medium">Status:</span>
              <span className={`rounded px-2.5 py-1 text-xs font-bold ${STATUS_BADGE[detailDoc.status] || 'bg-slate-100'}`}>
                {detailDoc.status}
              </span>
              {detailDoc._type === 'po' && can(role, 'documents', 'edit') && (
                <div className="ml-auto flex items-center gap-1">
                  <span className="text-xs text-slate-400">Change:</span>
                  <select
                    className="rounded border border-slate-200 text-xs p-1 text-slate-700"
                    value={detailDoc.status}
                    onChange={e => handleUpdatePOStatus(detailDoc, e.target.value)}
                  >
                    {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* Items table */}
            {detailDoc.items && detailDoc.items.length > 0 && (
              <div>
                <h4 className="font-bold text-slate-700 mb-2">Items ({detailDoc.items.length})</h4>
                <div className="max-h-60 overflow-y-auto rounded border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-100 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-bold text-slate-600">Item</th>
                        <th className="px-3 py-2 text-center font-bold text-slate-600">Qty</th>
                        {detailDoc._type === 'po' && (
                          <th className="px-3 py-2 text-right font-bold text-slate-600">Amount</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {detailDoc.items.map((item, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-3 py-2 text-slate-700">{item.item_name || item.name || `Item ${idx + 1}`}</td>
                          <td className="px-3 py-2 text-center text-slate-600">{item.qty ?? '—'}</td>
                          {detailDoc._type === 'po' && (
                            <td className="px-3 py-2 text-right text-slate-700">
                              {item.amount != null ? formatCurrency(item.amount) : '—'}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Transport info for challans */}
            {(detailDoc._type === 'delivery' || detailDoc._type === 'return') && detailDoc.transport &&
              Object.keys(detailDoc.transport).length > 0 && (
              <div>
                <h4 className="font-bold text-slate-700 mb-2">Transport Details</h4>
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 border p-3 text-xs text-slate-600">
                  {Object.entries(detailDoc.transport)
                    .filter(([k, v]) => v && k !== 'date')
                    .map(([k, v]) => (
                    <div key={k}>
                      <span className="font-medium capitalize text-slate-500">{k.replace(/_/g, ' ')}: </span>
                      {String(v)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* PO costs breakdown */}
            {detailDoc._type === 'po' && detailDoc.costs && (
              <div>
                <h4 className="font-bold text-slate-700 mb-2">Cost Breakdown</h4>
                <div className="rounded-lg border bg-slate-50 p-3 space-y-1.5">
                  {Object.entries(detailDoc.costs)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                    <div key={k} className="flex justify-between text-xs">
                      <span className="capitalize text-slate-500">{k}</span>
                      <span className="font-medium text-slate-700">{formatCurrency(v)}</span>
                    </div>
                  ))}
                  <div className="border-t pt-1.5 flex justify-between text-sm font-bold">
                    <span className="text-slate-700">Total</span>
                    <span className="text-indigo-700">{formatCurrency(detailDoc.amount)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Amount summary for PI */}
            {detailDoc._type === 'proforma' && detailDoc.amount != null && (
              <div className="rounded-lg bg-teal-50 border border-teal-200 p-3 flex justify-between items-center">
                <span className="font-bold text-teal-700">Grand Total</span>
                <span className="text-lg font-bold text-teal-800">{formatCurrency(detailDoc.amount)}</span>
              </div>
            )}

            {/* Notes / Terms */}
            {(detailDoc.notes || detailDoc.terms) && (
              <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-xs text-amber-800">
                {detailDoc.notes && <div><span className="font-bold">Notes: </span>{detailDoc.notes}</div>}
                {detailDoc.terms && <div className="mt-1"><span className="font-bold">Terms: </span>{detailDoc.terms}</div>}
              </div>
            )}

            {/* Go to project button */}
            <div className="pt-2 flex justify-end">
              <button
                onClick={() => { setDetailDoc(null); navigate(`/projects/${detailDoc.projectId}`); }}
                className="flex items-center gap-2 rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
              >
                <ExternalLink size={14} /> Open in Projects
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

// ── Small helper component ─────────────────────────────────────────────────────
const InfoRow = ({ icon: Icon, label, value, className = '' }) => (
  <div className={`flex items-start gap-2 ${className}`}>
    <Icon size={13} className="mt-0.5 text-slate-400 shrink-0" />
    <div>
      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="text-slate-800 font-medium">{value || '—'}</div>
    </div>
  </div>
);

export default DocumentsHub;
