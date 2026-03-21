import React, { useState, useEffect, useMemo } from 'react';
import {
  Users, Plus, Search, Edit, Trash2, MapPin, Copy, Box,
  BarChart2, TrendingUp, TrendingDown, X, ArrowLeft, AlertTriangle,
  Calendar, FileText, CreditCard, Briefcase, CheckCircle, Clock
} from 'lucide-react';
import {
  doc, updateDoc, deleteDoc, addDoc, collection, serverTimestamp, getDoc
} from 'firebase/firestore';
import { Modal, ConfirmDeleteModal, GSTINField } from '../components/Shared';
import { formatCurrency, validateGSTIN, getProjectGrandTotal } from '../utils/helpers';
import { GST_STATE_CODES, CATEGORIES } from '../utils/constants';
import { can } from '../utils/permissions';

const Clients = ({ clients, inventory, projects = [], payments = [], vendorPayments = [], role, db, appId, logAction }) => {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({
    name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [],
    billing_terms: 'Net 15', custom_terms: '', remarks: ''
  });
  const [newContact, setNewContact] = useState({ name: '', role: '', phone: '', email: '' });
  const [selectedVendorForAssets, setSelectedVendorForAssets] = useState(null);
  const [vendorAssetForm, setVendorAssetForm] = useState({ name: '', category: 'Sound', qty: 1, price: 0 });
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [ledgerLinkModal, setLedgerLinkModal] = useState({ isOpen: false, client: null, link: '' });
  const [ledgerExpiryDays, setLedgerExpiryDays] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 12;
  const [activeTab, setActiveTab] = useState('list');
  const [dashboardClient, setDashboardClient] = useState(null);
  const [dashSearch, setDashSearch] = useState('');

  const dashData = useMemo(() => {
    if (!dashboardClient) return null;
    const cid = dashboardClient.id;
    const clientProjects = projects.filter(p => p.client_id === cid);
    const clientPayments = payments.filter(p => p.client_id === cid);

    // Revenue & billing
    const invoicedProjects = clientProjects.filter(p => p.invoice_status === 'Invoiced');
    const totalBilled = invoicedProjects.reduce((s, p) => s + getProjectGrandTotal(p), 0);
    const totalReceived = clientPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const outstanding = totalBilled - totalReceived;

    // Overdue: invoiced project whose invoice_date > credit term days ago and not fully paid
    const termDays = parseInt((dashboardClient.billing_terms || 'Net 15').replace('Net ', ''), 10) || 15;
    const now = new Date();
    const overdueProjects = invoicedProjects.filter(p => {
      if (!p.invoice_date) return false;
      const due = new Date(p.invoice_date);
      due.setDate(due.getDate() + termDays);
      return due < now;
    });
    const overdueAmt = overdueProjects.reduce((s, p) => s + getProjectGrandTotal(p), 0) - clientPayments.filter(p => overdueProjects.some(op => op.id === p.project_id)).reduce((s, p) => s + (p.amount || 0), 0);

    // Project pipeline
    const active = clientProjects.filter(p => ['Quoted', 'Confirmed', 'Ongoing'].includes(p.status));
    const completed = clientProjects.filter(p => ['Completed', 'Closed'].includes(p.status));
    const notInvoiced = completed.filter(p => p.invoice_status !== 'Invoiced');

    // GST
    const totalGST = invoicedProjects.reduce((s, p) => {
      const grand = getProjectGrandTotal(p);
      const net = grand / 1.18; // approx
      return s + (grand - net);
    }, 0);

    // Lifetime revenue
    const lifetimeRevenue = clientProjects.reduce((s, p) => s + getProjectGrandTotal(p), 0);
    const firstProject = clientProjects.sort((a, b) => new Date(a.start_date || a.created_at) - new Date(b.start_date || b.created_at))[0];
    const clientSince = firstProject ? (firstProject.start_date || firstProject.created_at) : null;

    // Top categories
    const catMap = {};
    clientProjects.forEach(p => (p.items || []).forEach(item => {
      const cat = item.category || 'Other';
      catMap[cat] = (catMap[cat] || 0) + (item.total || 0);
    }));
    const topCategories = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // Vendor data (if applicable)
    const isVendor = dashboardClient.type === 'Vendor' || dashboardClient.type === 'Both';

    // Jobs: all vendor_allocations across all projects for this vendor
    const vendorAllocations = isVendor ? projects.flatMap(p =>
      (p.vendor_allocations || []).filter(a => a.vendor_id === cid).map(a => ({
        ...a,
        project_id: p.id,
        project_name: p.project_name,
        project_status: p.status,
        project_start: p.start_date,
      }))
    ) : [];

    // POs: all vendor_pos across all projects for this vendor
    const vendorPOs = isVendor ? projects.flatMap(p =>
      (p.vendor_pos || []).filter(po => po.vendor_id === cid).map(po => ({
        ...po,
        project_id: p.id,
        project_name: p.project_name,
      }))
    ) : [];

    // Total job value (tax_amount = amount with GST)
    const totalJobValue = vendorAllocations.reduce((s, a) => s + (parseFloat(a.tax_amount || a.amount) || 0), 0);
    const totalJobBase  = vendorAllocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);

    // Payments made to this vendor
    const vendorPmts = isVendor ? vendorPayments.filter(vp => vp.vendor_id === cid) : [];
    const vendorPaid = vendorPmts.reduce((s, vp) => s + (parseFloat(vp.amount) || 0), 0);
    const vendorBalance = totalJobValue - vendorPaid;

    // Per-project breakdown
    const vendorProjectMap = {};
    vendorAllocations.forEach(a => {
      const key = a.project_id;
      if (!vendorProjectMap[key]) vendorProjectMap[key] = { project_name: a.project_name, project_status: a.project_status, project_start: a.project_start, jobValue: 0, items: [] };
      vendorProjectMap[key].jobValue += parseFloat(a.tax_amount || a.amount) || 0;
      vendorProjectMap[key].items.push(a);
    });
    const vendorByProject = Object.values(vendorProjectMap).sort((a, b) => new Date(b.project_start || 0) - new Date(a.project_start || 0));

    return {
      clientProjects, clientPayments, invoicedProjects,
      totalBilled, totalReceived, outstanding,
      overdueProjects, overdueAmt,
      active, completed, notInvoiced, totalGST,
      lifetimeRevenue, clientSince, topCategories,
      isVendor, vendorAllocations, vendorPOs, vendorPaid, vendorBalance,
      totalJobValue, totalJobBase, vendorPmts, vendorByProject,
    };
  }, [dashboardClient, projects, payments, vendorPayments]);


  const openAdd = () => {
    setEditingId(null);
    setFormData({ name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [], billing_terms: 'Net 15', custom_terms: '', remarks: '' });
    setIsAddOpen(true);
  };

  const openEdit = (client) => {
    setEditingId(client.id);
    setFormData({
      name: client.name, type: client.type, gstin: client.gstin || '', state: client.state || '',
      address: client.address || '', contacts: client.contacts || [],
      billing_terms: client.billing_terms || 'Net 15', custom_terms: client.custom_terms || '', remarks: client.remarks || ''
    });
    setIsAddOpen(true);
  };

  const handleDelete = async (id) => {
    if (!can(role, 'clients', 'delete')) return alert('Access denied: only Admin can delete clients.');
    const clientName = clients.find(c => c.id === id)?.name || 'this client';
    setConfirmModal({
      isOpen: true,
      requireTyped: true,
      title: 'Delete Client',
      message: `Permanently delete "${clientName}"? All associated data will be lost and this cannot be undone.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', id));
        logAction('clients', 'delete', id, { name: clientName }, clientName);
      }
    });
  };

  const handleAddContact = () => {
    if (!newContact.name || !newContact.phone) return alert("Name and Phone are required.");
    setFormData({ ...formData, contacts: [...formData.contacts, newContact] });
    setNewContact({ name: '', role: '', phone: '', email: '' });
  };

  const handleRemoveContact = (index) => {
    const updated = [...formData.contacts];
    updated.splice(index, 1);
    setFormData({ ...formData, contacts: updated });
  };

  const handleSave = async () => {
    if (editingId ? !can(role, 'clients', 'edit') : !can(role, 'clients', 'create')) return alert('Access denied: insufficient permissions.');
    if (formData.gstin) {
      const val = validateGSTIN(formData.gstin, formData.state);
      if (!val.valid) return alert(`GST Error: ${val.msg}`);
    }

    const doSave = async () => {
      const data = { ...formData, updated_at: serverTimestamp() };
      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', editingId), data);
        logAction('clients', 'update', editingId, data, formData.name);
      } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'clients'), { ...data, created_at: serverTimestamp() });
        logAction('clients', 'create', docRef.id, data, formData.name);
      }
      setIsAddOpen(false);
    };

    // Duplicate detection — check GSTIN and contact phone numbers
    const newGstin = formData.gstin?.trim().toUpperCase();
    const newPhones = (formData.contacts || []).map(c => c.phone?.trim()).filter(Boolean);

    const duplicates = clients.filter(c => {
      if (editingId && c.id === editingId) return false; // skip self when editing
      const gstinMatch = newGstin && c.gstin?.trim().toUpperCase() === newGstin;
      const existingPhones = (c.contacts || []).map(x => x.phone?.trim()).filter(Boolean);
      const phoneMatch = newPhones.some(p => existingPhones.includes(p));
      return gstinMatch || phoneMatch;
    });

    if (duplicates.length > 0) {
      const reasons = duplicates.map(d => {
        const parts = [];
        if (newGstin && d.gstin?.trim().toUpperCase() === newGstin) parts.push('same GSTIN');
        const existingPhones = (d.contacts || []).map(x => x.phone?.trim()).filter(Boolean);
        if (newPhones.some(p => existingPhones.includes(p))) parts.push('matching phone');
        return `"${d.name}" (${parts.join(' & ')})`;
      }).join('; ');
      setConfirmModal({
        isOpen: true,
        title: '⚠️ Possible Duplicate Client',
        message: `A similar client already exists: ${reasons}.\n\nAre you sure you want to save this as a separate entry?`,
        onConfirm: doSave,
      });
      return;
    }

    await doSave();
  };

  const handleSaveVendorAsset = async () => {
    if (!can(role, 'inventory', 'create')) return alert('Access denied: insufficient permissions.');
    if (!vendorAssetForm.name || !vendorAssetForm.qty) return alert("Name and Qty required");

    const newItem = {
      name: vendorAssetForm.name,
      category: vendorAssetForm.category || 'Accessories',
      total: parseInt(vendorAssetForm.qty),
      rate_per_day: parseFloat(vendorAssetForm.price) || 0,
      vendor_id: selectedVendorForAssets.id,
      is_external: true,
      status: 'Available',
      created_at: new Date().toISOString(),
      brand: '', sub_category: '', serial_number: '', location: 'Vendor Premise', gst_rate: 18
    };

    const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), newItem);
    logAction('inventory', 'create_vendor_asset', docRef.id, newItem, newItem.name);
    setVendorAssetForm({ name: '', category: 'Sound', qty: 1, price: 0 });
  };

  const handleDeleteAsset = async (assetId) => {
    if (!can(role, 'inventory', 'delete')) return alert('Access denied: only Admin can delete assets.');
    setConfirmModal({
      isOpen: true,
      requireTyped: false,
      title: 'Remove Vendor Asset',
      message: 'Remove this asset from the vendor list? This action cannot be undone.',
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', assetId));
        logAction('inventory', 'delete_vendor_asset', assetId, {}, 'Vendor Asset');
      }
    });
  };

  const generateLedgerToken = () => {
    if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  };

  const handleLedgerLink = async (client) => {
    if (!can(role, 'clients', 'edit')) return alert('Access denied: insufficient permissions.');
    let token = client.ledger_link_token;
    if (!token) {
      token = generateLedgerToken();
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', client.id), {
        ledger_link_token: token,
        ledger_link_enabled: true,
        ledger_link_created_at: new Date().toISOString()
      });
      logAction('clients', 'create_ledger_link', client.id, { token }, client.name);
    }

    const link = `${window.location.origin}/ledger/${token}`;
    setLedgerLinkModal({ isOpen: true, client, link });
    setLedgerExpiryDays('');
  };

  const handleRegenerateLedgerLink = async () => {
    if (!can(role, 'clients', 'edit')) return alert('Access denied: insufficient permissions.');
    if (!ledgerLinkModal.client) return;
    const token = generateLedgerToken();
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', ledgerLinkModal.client.id), {
      ledger_link_token: token,
      ledger_link_enabled: true,
      ledger_link_created_at: new Date().toISOString()
    });
    logAction('clients', 'regenerate_ledger_link', ledgerLinkModal.client.id, { token }, ledgerLinkModal.client.name);
    const link = `${window.location.origin}/ledger/${token}`;
    setLedgerLinkModal(prev => ({ ...prev, link }));
    setLedgerExpiryDays('');
  };

  const handleSetLedgerExpiry = async () => {
    if (!can(role, 'clients', 'edit')) return alert('Access denied: insufficient permissions.');
    if (!ledgerLinkModal.client) return;
    const days = parseInt(ledgerExpiryDays, 10);
    const payload = {
      ledger_link_expires_at: null
    };
    if (!Number.isNaN(days) && days > 0) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);
      payload.ledger_link_expires_at = expiresAt.toISOString();
    }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', ledgerLinkModal.client.id), payload);
    logAction('clients', 'update_ledger_link_expiry', ledgerLinkModal.client.id, payload, ledgerLinkModal.client.name);
    setLedgerLinkModal(prev => ({
      ...prev,
      client: { ...prev.client, ledger_link_expires_at: payload.ledger_link_expires_at }
    }));
    setLedgerExpiryDays('');
  };

  const handleCopyLedgerLink = async () => {
    if (!ledgerLinkModal.link) return;
    await navigator.clipboard.writeText(ledgerLinkModal.link);
    alert('Ledger link copied to clipboard.');
  };

  const handleCopyLedgerLinkValue = async (link) => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    alert('Ledger link copied to clipboard.');
  };

  const filteredClients = clients.filter(client =>
    client.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const paginatedClients = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredClients.slice(start, start + itemsPerPage);
  }, [filteredClients, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  return (
    <div className="space-y-4">
      {/* ── Page header with tabs ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Clients & Vendors</h2>
        <div className="flex gap-2 w-full md:w-auto">
          {activeTab === 'list' && (
            <div className="hidden md:flex items-center rounded border px-3 py-1 bg-white flex-1">
              <Search size={16} className="text-slate-400 mr-2" />
              <input placeholder="Search..." className="text-sm outline-none text-black" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
          )}
          {role !== 'tech' && role !== 'auditor' && activeTab === 'list' && (
            <button onClick={openAdd} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap flex-1 md:flex-none"><Plus size={18} /> Add Client/Vendor</button>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 border-b border-slate-200">
        <button onClick={() => setActiveTab('list')} className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px ${activeTab === 'list' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
          <span className="flex items-center gap-1.5"><Users size={14}/> Directory</span>
        </button>
        <button onClick={() => { setActiveTab('dashboard'); setDashboardClient(null); setDashSearch(''); }} className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px ${activeTab === 'dashboard' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
          <span className="flex items-center gap-1.5"><BarChart2 size={14}/> Client Dashboard</span>
        </button>
      </div>

      {activeTab === 'list' && <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {paginatedClients.map(client => {
          const ledgerLink = client.ledger_link_token
            ? `${window.location.origin}/ledger/${client.ledger_link_token}`
            : '';
          return (
          <div key={client.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col justify-between group relative">
            {(role === 'admin' || role === 'manager') && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-100">
                <button onClick={(e) => {e.stopPropagation(); handleLedgerLink(client)}} className="p-1 text-slate-600 hover:bg-slate-50 rounded" title="Ledger Link"><Copy size={14}/></button>
                <button onClick={(e) => {e.stopPropagation(); openEdit(client)}} className="p-1 text-blue-600 hover:bg-blue-50 rounded"><Edit size={14}/></button>
                <button onClick={(e) => {e.stopPropagation(); handleDelete(client.id)}} className="p-1 text-red-600 hover:bg-red-50 rounded"><Trash2 size={14}/></button>
              </div>
            )}
            <div>
              <div className="flex justify-between items-start">
                <h3 className="font-bold text-slate-800 text-lg">{client.name}</h3>
                <div className="flex flex-col items-end gap-1 mt-6">
                  <span className={`px-2 py-0.5 text-xs rounded ${client.type === 'Vendor' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{client.type}</span>
                  {client.billing_terms && <span className="px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-600 border border-slate-200">{client.billing_terms}</span>}
                </div>
              </div>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <div className="flex items-start gap-2">
                  <MapPin size={16} className="mt-0.5 text-slate-400 shrink-0" />
                  <div>
                    <div className="text-slate-600">{GST_STATE_CODES[client.gstin?.substring(0,2)] || 'Unknown State'}</div>
                    <div className="text-slate-500 text-xs mt-1">{client.address || 'No address provided'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 border-t pt-3 border-slate-100">
                <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">Primary Contact</div>
                {client.contacts?.[0] ? (
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">{client.contacts[0].name.charAt(0)}</div>
                    <div className="text-sm">
                      <div className="font-medium text-slate-800">{client.contacts[0].name}</div>
                      <div className="text-slate-500 text-xs">{client.contacts[0].phone}</div>
                    </div>
                  </div>
                ) : <div className="text-sm text-slate-400 italic">No contact persons added</div>}
            </div>
            {(role === 'admin' || role === 'manager') && (
              <div className="mt-3 border-t pt-3 border-slate-100">
                <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">Ledger Link</div>
                {ledgerLink ? (
                  <div className="flex items-center gap-2">
                    <input className="flex-1 rounded border p-2 text-xs text-black bg-white" value={ledgerLink} readOnly />
                    <button onClick={(e) => {e.stopPropagation(); handleCopyLedgerLinkValue(ledgerLink)}} className="rounded bg-indigo-600 text-white px-2 py-2 text-xs hover:bg-indigo-700">Copy</button>
                  </div>
                ) : (
                  <button onClick={(e) => {e.stopPropagation(); handleLedgerLink(client)}} className="w-full rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Generate Link</button>
                )}
              </div>
            )}
            {(client.type === 'Vendor' || client.type === 'Both') && (
                <button onClick={(e) => {e.stopPropagation(); setSelectedVendorForAssets(client)}} className="mt-3 w-full flex items-center justify-center gap-2 rounded border border-indigo-200 bg-indigo-50 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
                    <Box size={16} /> Manage Assets ({inventory ? inventory.filter(i => i.vendor_id === client.id).length : 0})
                </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); setDashboardClient(client); setActiveTab('dashboard'); }} className="mt-2 w-full flex items-center justify-center gap-2 rounded border border-slate-200 bg-slate-50 py-1.5 text-sm font-medium text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition">
              <BarChart2 size={15} /> View Dashboard
            </button>
          </div>
        );
        })}
      </div>}
      {activeTab === 'list' && filteredClients.length > itemsPerPage && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-slate-500">Showing {Math.min((currentPage - 1) * itemsPerPage + 1, filteredClients.length)} to {Math.min(currentPage * itemsPerPage, filteredClients.length)} of {filteredClients.length} entries</div>
          <div className="flex gap-2">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
              <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(filteredClients.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(filteredClients.length / itemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
          </div>
        </div>
      )}

      {/* ── Dashboard Tab ── */}
      {activeTab === 'dashboard' && !dashboardClient && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center gap-2 mb-4">
              <Search size={16} className="text-slate-400" />
              <input
                autoFocus
                placeholder="Search client or vendor name..."
                className="w-full text-sm outline-none text-black"
                value={dashSearch}
                onChange={e => setDashSearch(e.target.value)}
              />
            </div>
            <div className="divide-y divide-slate-100">
              {clients
                .filter(c => !dashSearch || c.name.toLowerCase().includes(dashSearch.toLowerCase()))
                .slice(0, 20)
                .map(c => {
                  const cp = projects.filter(p => p.client_id === c.id);
                  const totalRev = cp.reduce((s, p) => s + getProjectGrandTotal(p), 0);
                  const clientPay = payments.filter(p => p.client_id === c.id).reduce((s, p) => s + (p.amount || 0), 0);
                  const invoiced = cp.filter(p => p.invoice_status === 'Invoiced').reduce((s, p) => s + getProjectGrandTotal(p), 0);
                  const outstanding = invoiced - clientPay;
                  return (
                    <button key={c.id} onClick={() => setDashboardClient(c)}
                      className="w-full flex items-center justify-between px-3 py-3 hover:bg-indigo-50 transition rounded-lg text-left group">
                      <div className="flex items-center gap-3">
                        <div className={`h-9 w-9 rounded-full flex items-center justify-center font-bold text-white shrink-0 ${
                          c.type === 'Vendor' ? 'bg-purple-500' : c.type === 'Both' ? 'bg-teal-500' : 'bg-indigo-500'
                        }`}>{(c.name || '?')[0].toUpperCase()}</div>
                        <div>
                          <div className="font-semibold text-slate-800 group-hover:text-indigo-700">{c.name}</div>
                          <div className="text-xs text-slate-400">{c.type} · {GST_STATE_CODES[c.gstin?.substring(0,2)] || 'Unknown State'} · {cp.length} project{cp.length !== 1 ? 's' : ''}</div>
                        </div>
                      </div>
                      <div className="text-right shrink-0 hidden md:block">
                        <div className="text-sm font-bold text-slate-700">{formatCurrency(totalRev)}</div>
                        {outstanding > 0 && <div className="text-xs text-amber-600">{formatCurrency(outstanding)} due</div>}
                        {outstanding <= 0 && invoiced > 0 && <div className="text-xs text-green-600">Settled</div>}
                      </div>
                    </button>
                  );
                })}
              {clients.filter(c => !dashSearch || c.name.toLowerCase().includes(dashSearch.toLowerCase())).length === 0 && (
                <div className="py-8 text-center text-slate-400 text-sm">No clients match your search.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'dashboard' && dashboardClient && dashData && (
        <div className="space-y-4">
          {/* Back + client name */}
          <div className="flex items-center justify-between">
            <button onClick={() => setDashboardClient(null)} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-indigo-600 transition">
              <ArrowLeft size={16} /> All Clients
            </button>
            {(role === 'admin' || role === 'manager') && (
              <button onClick={() => openEdit(dashboardClient)} className="flex items-center gap-1.5 text-sm rounded border border-slate-200 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-600"><Edit size={14}/> Edit Client</button>
            )}
          </div>
        </div>
      )}
      <Modal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} title={editingId ? "Edit Client/Vendor" : "Add Client/Vendor"}>
        <div className="space-y-6">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-black border-b pb-1">Basic Details</h4>
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Basic Details</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
              <label htmlFor="client-type" className="block text-sm font-bold text-slate-800">Type</label>
              <select id="client-type" name="type" className="w-full rounded border p-2 bg-white text-black focus:ring-2 focus:ring-indigo-500" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
                <option value="Client">Client</option>
                <option value="Vendor">Vendor</option>
                <option value="Both">Both</option>
              </select>
            </div>
              <div>
              <label htmlFor="client-gstin" className="block text-sm font-bold text-slate-800">GSTIN</label>
              <GSTINField
                id="client-gstin"
                value={formData.gstin}
                onChange={v => setFormData({ ...formData, gstin: v })}
                onAutofill={({ name, address }) => setFormData(prev => ({
                  ...prev,
                  name: name || prev.name,
                  address: address || prev.address
                }))}
                db={db}
                appId={appId}
              />
            </div>
            </div>
            <div>
              <label htmlFor="client-name" className="block text-sm font-bold text-slate-800">Company Name</label>
              <input id="client-name" name="name" className="w-full rounded border p-2 bg-white text-black placeholder-slate-400 focus:ring-2 focus:ring-indigo-500" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
            </div>
            <div>
              <label htmlFor="client-address" className="block text-sm font-bold text-slate-800">Full Address</label>
              <textarea id="client-address" name="address" className="w-full rounded border p-2 text-sm bg-white text-black placeholder-slate-400 focus:ring-2 focus:ring-indigo-500" rows={2} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} />
            </div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Financial & Terms</h4>
            <div><label className="block text-sm font-bold text-slate-800">Credit Terms</label><select className="w-full rounded border p-2 bg-white text-slate-800" value={formData.billing_terms} onChange={e => setFormData({...formData, billing_terms: e.target.value})}><option value="Net 15">Net 15 Days</option><option value="Net 30">Net 30 Days</option><option value="Net 45">Net 45 Days</option><option value="Net 60">Net 60 Days</option><option value="Net 90">Net 90 Days</option></select></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Contact Persons</h4>
            {formData.contacts.length > 0 && (
              <div className="space-y-2 mb-3">{formData.contacts.map((c, idx) => (<div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border border-slate-200"><div><div className="text-sm font-medium text-slate-800">{c.name}</div><div className="text-xs text-slate-500">{c.phone}</div></div><button onClick={() => handleRemoveContact(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button></div>))}</div>
            )}
            <div className="bg-slate-50 p-3 rounded border border-dashed border-slate-300"><div className="grid grid-cols-2 gap-2 mb-2"><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Name *" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Role" value={newContact.role} onChange={e => setNewContact({...newContact, role: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Phone *" value={newContact.phone} onChange={e => setNewContact({...newContact, phone: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Email" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} /></div><button onClick={handleAddContact} className="w-full rounded border border-indigo-200 bg-white py-1 text-sm text-indigo-600 hover:bg-indigo-50">+ Add to List</button></div>
          </div>
          <button onClick={handleSave} className="w-full rounded bg-indigo-600 py-3 text-white font-medium hover:bg-indigo-700 shadow-sm mt-4">Save Client / Vendor</button>
        </div>
      </Modal>

      <Modal isOpen={ledgerLinkModal.isOpen} onClose={() => setLedgerLinkModal({ isOpen: false, client: null, link: '' })} title="Ledger Link">
        <div className="space-y-4">
          <div className="text-sm text-slate-600">
            Share this link with {ledgerLinkModal.client?.name || 'the party'} to view and download their ledger.
          </div>
          <div className="flex items-center gap-2">
            <input className="flex-1 rounded border p-2 text-sm text-black bg-white" value={ledgerLinkModal.link} readOnly />
            <button onClick={handleCopyLedgerLink} className="rounded bg-indigo-600 text-white px-3 py-2 text-sm hover:bg-indigo-700">Copy</button>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                className="w-28 rounded border p-2 text-sm text-black bg-white"
                placeholder="Days"
                value={ledgerExpiryDays}
                onChange={e => setLedgerExpiryDays(e.target.value)}
              />
              <button onClick={handleSetLedgerExpiry} className="rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Set Expiry</button>
              <button onClick={handleRegenerateLedgerLink} className="rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Regenerate Link</button>
            </div>
            <div className="text-xs text-slate-500">
              {ledgerLinkModal.client?.ledger_link_expires_at
                ? `Expires: ${new Date(ledgerLinkModal.client.ledger_link_expires_at).toLocaleDateString()}`
                : 'No expiry set.'}
            </div>
            {ledgerLinkModal.client?.ledger_link_created_at && (
              <div className="text-xs text-slate-500">
                Created: {new Date(ledgerLinkModal.client.ledger_link_created_at).toLocaleDateString()}
              </div>
            )}
          </div>
          <div className="text-xs text-slate-500">Each link is unique to the selected client/vendor.</div>
        </div>
      </Modal>

      {/* Vendor Assets Modal */}
      <Modal isOpen={!!selectedVendorForAssets} onClose={() => setSelectedVendorForAssets(null)} title={`Vendor Assets: ${selectedVendorForAssets?.name}`}>
        <div className="space-y-6">
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <h4 className="text-sm font-bold text-slate-700 mb-3 text-slate-800">Add New Asset</h4>
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                    <label htmlFor="vendor-asset-name" className="text-xs font-bold text-slate-700">Item Name</label>
                    <input id="vendor-asset-name" name="vendor_asset_name" className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500" value={vendorAssetForm.name} onChange={e => setVendorAssetForm({...vendorAssetForm, name: e.target.value})} placeholder="e.g. LED Wall Panel" />
                  </div>
                    <div><label className="text-xs font-bold text-slate-700">Category</label><select className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800" value={vendorAssetForm.category} onChange={e => setVendorAssetForm({...vendorAssetForm, category: e.target.value})}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                    <div>
                    <label htmlFor="vendor-asset-qty" className="text-xs font-bold text-slate-700">Quantity</label>
                    <input id="vendor-asset-qty" name="vendor_asset_qty" type="number" className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500" value={vendorAssetForm.qty} onChange={e => setVendorAssetForm({...vendorAssetForm, qty: e.target.value})} />
                  </div>
                    <div>
                    <label htmlFor="vendor-asset-price" className="text-xs font-bold text-slate-700">Offered Price (Rate)</label>
                    <input id="vendor-asset-price" name="vendor_asset_price" type="number" className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500" value={vendorAssetForm.price} onChange={e => setVendorAssetForm({...vendorAssetForm, price: e.target.value})} />
                  </div>
                </div>
                <button onClick={handleSaveVendorAsset} className="w-full rounded bg-indigo-600 py-2 text-white text-sm font-medium hover:bg-indigo-700">Add Asset</button>
            </div>

            <div>
                <h4 className="text-sm font-bold text-slate-800 mb-2">Current Assets</h4>
                <div className="max-h-60 overflow-y-auto border rounded-lg">
                    <table className="w-full text-sm text-left"><thead className="bg-slate-100 text-slate-800 font-bold sticky top-0"><tr><th className="p-2">Item</th><th className="p-2">Qty</th><th className="p-2">Price</th><th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">
                        {inventory.filter(i => i.vendor_id === selectedVendorForAssets?.id).map(item => (
                            <tr key={item.id}><td className="p-2 text-black">{item.name}<div className="text-xs text-slate-500">{item.category}</div></td><td className="p-2 text-black">{item.total}</td><td className="p-2 text-black">{formatCurrency(item.rate_per_day)}</td><td className="p-2 text-right"><button onClick={() => handleDeleteAsset(item.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14}/></button></td></tr>
                        ))}
                        {inventory.filter(i => i.vendor_id === selectedVendorForAssets?.id).length === 0 && <tr><td colSpan={4} className="p-4 text-center text-slate-400">No assets listed.</td></tr>}
                    </tbody></table>
                </div>
            </div>
        </div>
      </Modal>
      <ConfirmDeleteModal isOpen={confirmModal.isOpen} onClose={() => setConfirmModal({...confirmModal, isOpen: false})} onConfirm={confirmModal.onConfirm} title={confirmModal.title} message={confirmModal.message} requireTyped={confirmModal.requireTyped} />

      {activeTab === 'dashboard' && dashboardClient && dashData && (
        <div className="space-y-6">

            {/* Client info strip */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-wrap gap-6 text-sm">
              {dashboardClient.gstin && <div><div className="text-xs text-slate-400 font-semibold mb-0.5">GSTIN</div><div className="font-mono font-bold text-slate-700">{dashboardClient.gstin}</div></div>}
              <div><div className="text-xs text-slate-400 font-semibold mb-0.5">State</div><div className="text-slate-700">{GST_STATE_CODES[dashboardClient.gstin?.substring(0,2)] || dashboardClient.state || '—'}</div></div>
              <div><div className="text-xs text-slate-400 font-semibold mb-0.5">Credit Terms</div><div className="text-slate-700">{dashboardClient.billing_terms || 'Net 15'}</div></div>
              {dashData.clientSince && <div><div className="text-xs text-slate-400 font-semibold mb-0.5">Client Since</div><div className="text-slate-700">{new Date(dashData.clientSince).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div></div>}
              <div><div className="text-xs text-slate-400 font-semibold mb-0.5">Total Projects</div><div className="font-bold text-slate-800">{dashData.clientProjects.length}</div></div>
              {dashboardClient.contacts?.[0] && (
                <div><div className="text-xs text-slate-400 font-semibold mb-0.5">Primary Contact</div><div className="text-slate-700">{dashboardClient.contacts[0].name} · {dashboardClient.contacts[0].phone}</div></div>
              )}
            </div>

            {/* Accounts KPIs */}
            <div>
              <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wide mb-3">Accounts Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
                  <div className="text-xs text-slate-500 font-semibold mb-1">Lifetime Revenue</div>
                  <div className="text-2xl font-bold text-slate-800">{formatCurrency(dashData.lifetimeRevenue)}</div>
                  <div className="text-xs text-slate-400">{dashData.clientProjects.length} project{dashData.clientProjects.length !== 1 ? 's' : ''}</div>
                </div>
                <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 shadow-sm">
                  <div className="text-xs text-blue-700 font-semibold mb-1 flex items-center gap-1"><FileText size={11}/> Total Invoiced</div>
                  <div className="text-2xl font-bold text-blue-800">{formatCurrency(dashData.totalBilled)}</div>
                  <div className="text-xs text-slate-400">{dashData.invoicedProjects.length} invoice{dashData.invoicedProjects.length !== 1 ? 's' : ''}</div>
                </div>
                <div className="rounded-xl bg-green-50 border border-green-100 p-4 shadow-sm">
                  <div className="text-xs text-green-700 font-semibold mb-1 flex items-center gap-1"><CheckCircle size={11}/> Received</div>
                  <div className="text-2xl font-bold text-green-800">{formatCurrency(dashData.totalReceived)}</div>
                  <div className="text-xs text-slate-400">{dashData.clientPayments.length} payment{dashData.clientPayments.length !== 1 ? 's' : ''}</div>
                </div>
                <div className={`rounded-xl border p-4 shadow-sm ${dashData.outstanding > 0 ? 'bg-amber-50 border-amber-100' : 'bg-slate-50 border-slate-200'}`}>
                  <div className={`text-xs font-semibold mb-1 flex items-center gap-1 ${dashData.outstanding > 0 ? 'text-amber-700' : 'text-slate-500'}`}><CreditCard size={11}/> Outstanding</div>
                  <div className={`text-2xl font-bold ${dashData.outstanding > 0 ? 'text-amber-800' : 'text-slate-700'}`}>{formatCurrency(Math.max(0, dashData.outstanding))}</div>
                  {dashData.outstanding <= 0 && <div className="text-xs text-green-600">Fully settled</div>}
                </div>
              </div>
              {dashData.overdueProjects.length > 0 && (
                <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
                  <AlertTriangle size={16} className="text-red-500 mt-0.5 shrink-0" />
                  <div className="text-sm text-red-700">
                    <span className="font-bold">{dashData.overdueProjects.length} overdue invoice{dashData.overdueProjects.length !== 1 ? 's' : ''}</span> — approximately {formatCurrency(Math.max(0, dashData.overdueAmt))} past due based on {dashboardClient.billing_terms || 'Net 15'} terms.
                  </div>
                </div>
              )}
              {dashData.notInvoiced.length > 0 && (
                <div className="mt-2 flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-xl p-3">
                  <Clock size={16} className="text-orange-500 mt-0.5 shrink-0" />
                  <div className="text-sm text-orange-700">
                    <span className="font-bold">{dashData.notInvoiced.length} completed project{dashData.notInvoiced.length !== 1 ? 's' : ''}</span> not yet invoiced — {formatCurrency(dashData.notInvoiced.reduce((s, p) => s + getProjectGrandTotal(p), 0))} pending billing.
                  </div>
                </div>
              )}
            </div>

            {/* Management: Project Pipeline + Category breakdown side by side */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Project Pipeline */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center justify-between">
                  <span className="flex items-center gap-2"><Briefcase size={15} className="text-indigo-500"/> Project Pipeline</span>
                  <div className="flex gap-2 text-xs">
                    <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded">{dashData.active.length} active</span>
                    <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{dashData.completed.length} done</span>
                  </div>
                </div>
                {dashData.clientProjects.length === 0 ? (
                  <div className="p-6 text-center text-slate-400 text-sm">No projects yet.</div>
                ) : (
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-50">
                    {[...dashData.active, ...dashData.completed].slice(0, 15).map(p => {
                      const grand = getProjectGrandTotal(p);
                      const statusColor = { Quoted: 'bg-orange-100 text-orange-700', Confirmed: 'bg-green-100 text-green-700', Ongoing: 'bg-red-100 text-red-700', Completed: 'bg-blue-100 text-blue-700', Closed: 'bg-slate-200 text-slate-600' };
                      return (
                        <div key={p.id} className="px-4 py-3 hover:bg-slate-50">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-medium text-slate-800 text-sm truncate">{p.project_name}</div>
                              <div className="text-xs text-slate-400 mt-0.5">{p.start_date ? new Date(p.start_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}{p.end_date ? ` → ${new Date(p.end_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}` : ''}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-bold text-slate-700 text-sm">{formatCurrency(grand)}</div>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusColor[p.status] || 'bg-slate-100 text-slate-600'}`}>{p.status}</span>
                              {p.invoice_status === 'Invoiced' && <div className="text-xs text-green-600 mt-0.5">✓ Invoiced</div>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Top Categories + GST */}
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center gap-2"><TrendingUp size={15} className="text-purple-500"/> Top Equipment Categories</div>
                  {dashData.topCategories.length === 0 ? (
                    <div className="p-4 text-center text-slate-400 text-sm">No itemized data.</div>
                  ) : (
                    <div className="divide-y divide-slate-50">
                      {dashData.topCategories.map(([cat, amt]) => {
                        const pct = dashData.lifetimeRevenue > 0 ? Math.round((amt / dashData.lifetimeRevenue) * 100) : 0;
                        return (
                          <div key={cat} className="px-4 py-2.5 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-slate-700">{cat}</div>
                              <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-400 rounded-full" style={{ width: `${pct}%` }} /></div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-sm font-bold text-slate-800">{formatCurrency(amt)}</div>
                              <div className="text-xs text-slate-400">{pct}%</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                  <div className="text-xs text-slate-400 font-semibold mb-2">GST BILLED (APPROX)</div>
                  <div className="text-xl font-bold text-slate-800">{formatCurrency(dashData.totalGST)}</div>
                  <div className="text-xs text-slate-400 mt-1">On invoiced projects only</div>
                </div>
              </div>
            </div>

            {/* Invoice Register */}
            {dashData.invoicedProjects.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center gap-2"><FileText size={15} className="text-blue-500"/> Invoice Register</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-xs text-slate-500 font-semibold">
                      <tr><th className="p-3">Project</th><th className="p-3">Invoice No.</th><th className="p-3">Invoice Date</th><th className="p-3 text-right">Net Amount</th><th className="p-3 text-right">GST</th><th className="p-3 text-right">Total</th><th className="p-3 text-center">Status</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {dashData.invoicedProjects.map(p => {
                        const grand = getProjectGrandTotal(p);
                        const gst = grand - grand / 1.18;
                        const net = grand - gst;
                        return (
                          <tr key={p.id} className="hover:bg-slate-50">
                            <td className="p-3 font-medium text-slate-800 max-w-[180px] truncate">{p.project_name}</td>
                            <td className="p-3 font-mono text-slate-600">{p.invoice_no || '—'}</td>
                            <td className="p-3 text-slate-500">{p.invoice_date ? new Date(p.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                            <td className="p-3 text-right text-slate-700">{formatCurrency(net)}</td>
                            <td className="p-3 text-right text-slate-500">{formatCurrency(gst)}</td>
                            <td className="p-3 text-right font-bold text-slate-800">{formatCurrency(grand)}</td>
                            <td className="p-3 text-center"><span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">Invoiced</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Payment History */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center justify-between">
                <span className="flex items-center gap-2"><CreditCard size={15} className="text-green-500"/> Payment History</span>
                <span className="text-xs text-slate-400">{dashData.clientPayments.length} entries · {formatCurrency(dashData.totalReceived)} total</span>
              </div>
              {dashData.clientPayments.length === 0 ? (
                <div className="p-6 text-center text-slate-400 text-sm">No payments recorded.</div>
              ) : (
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-xs text-slate-500 font-semibold sticky top-0">
                      <tr><th className="p-3">Date</th><th className="p-3">Project</th><th className="p-3">Mode</th><th className="p-3">Reference</th><th className="p-3 text-right">Amount</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {[...dashData.clientPayments].sort((a,b) => new Date(b.date||b.created_at) - new Date(a.date||a.created_at)).map(pay => {
                        const proj = projects.find(p => p.id === pay.project_id);
                        return (
                          <tr key={pay.id} className="hover:bg-slate-50">
                            <td className="p-3 whitespace-nowrap text-slate-600">{pay.date ? new Date(pay.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                            <td className="p-3 text-slate-700 max-w-[160px] truncate">{proj?.project_name || (pay.project_id === 'general' ? 'General' : '—')}</td>
                            <td className="p-3 text-slate-600">{pay.mode || '—'}</td>
                            <td className="p-3 text-slate-400 text-xs font-mono">{pay.reference || '—'}</td>
                            <td className="p-3 text-right font-bold text-green-700">{formatCurrency(pay.amount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── VENDOR SECTION ── */}
            {dashData.isVendor && (
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wide">Vendor Account</h3>

                {/* KPI row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-xl bg-purple-50 border border-purple-100 p-4 shadow-sm">
                    <div className="text-xs text-purple-700 font-semibold mb-1">Total Jobs Value</div>
                    <div className="text-2xl font-bold text-purple-800">{formatCurrency(dashData.totalJobValue)}</div>
                    <div className="text-xs text-slate-400">{dashData.vendorAllocations.length} allocation{dashData.vendorAllocations.length !== 1 ? 's' : ''} across {dashData.vendorByProject.length} project{dashData.vendorByProject.length !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 shadow-sm">
                    <div className="text-xs text-slate-500 font-semibold mb-1">Base (ex-GST)</div>
                    <div className="text-2xl font-bold text-slate-700">{formatCurrency(dashData.totalJobBase)}</div>
                    <div className="text-xs text-slate-400">GST: {formatCurrency(dashData.totalJobValue - dashData.totalJobBase)}</div>
                  </div>
                  <div className="rounded-xl bg-green-50 border border-green-100 p-4 shadow-sm">
                    <div className="text-xs text-green-700 font-semibold mb-1 flex items-center gap-1"><CheckCircle size={11}/> Paid to Vendor</div>
                    <div className="text-2xl font-bold text-green-800">{formatCurrency(dashData.vendorPaid)}</div>
                    <div className="text-xs text-slate-400">{dashData.vendorPmts.length} payment{dashData.vendorPmts.length !== 1 ? 's' : ''}</div>
                  </div>
                  <div className={`rounded-xl border p-4 shadow-sm ${dashData.vendorBalance > 0 ? 'bg-amber-50 border-amber-100' : 'bg-slate-50 border-slate-200'}`}>
                    <div className={`text-xs font-semibold mb-1 ${dashData.vendorBalance > 0 ? 'text-amber-700' : 'text-slate-500'}`}>Balance Payable</div>
                    <div className={`text-2xl font-bold ${dashData.vendorBalance > 0 ? 'text-amber-800' : 'text-slate-600'}`}>{formatCurrency(Math.max(0, dashData.vendorBalance))}</div>
                    {dashData.vendorBalance <= 0 && <div className="text-xs text-green-600">Fully settled</div>}
                    {dashData.vendorBalance > 0 && <div className="text-xs text-amber-600">Pending payment</div>}
                  </div>
                </div>

                {/* Jobs by project */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center gap-2">
                    <Briefcase size={15} className="text-purple-500"/> Jobs by Project
                  </div>
                  {dashData.vendorByProject.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 text-sm">No outsourcing jobs recorded for this vendor.</div>
                  ) : (
                    <div className="divide-y divide-slate-50">
                      {dashData.vendorByProject.map((proj, pi) => {
                        const statusColor = { Quoted: 'bg-orange-100 text-orange-700', Confirmed: 'bg-green-100 text-green-700', Ongoing: 'bg-red-100 text-red-700', Completed: 'bg-blue-100 text-blue-700', Closed: 'bg-slate-200 text-slate-600' };
                        return (
                          <div key={pi} className="px-4 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <div>
                                <span className="font-semibold text-slate-800 text-sm">{proj.project_name}</span>
                                {proj.project_start && <span className="ml-2 text-xs text-slate-400">{new Date(proj.project_start).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusColor[proj.project_status] || 'bg-slate-100 text-slate-600'}`}>{proj.project_status}</span>
                                <span className="font-bold text-slate-700 text-sm">{formatCurrency(proj.jobValue)}</span>
                              </div>
                            </div>
                            <div className="space-y-1">
                              {proj.items.map((item, ii) => (
                                <div key={ii} className="flex items-center justify-between text-xs text-slate-500 pl-2 border-l-2 border-purple-100">
                                  <span>{item.description || item.item_name || 'Service'}
                                    {item.qty && item.rate ? <span className="text-slate-400 ml-1">({item.qty} × {formatCurrency(item.rate)}{item.days > 1 ? ` × ${item.days}d` : ''})</span> : ''}
                                  </span>
                                  <span className="font-medium text-slate-600">{formatCurrency(item.tax_amount || item.amount)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* PO Register */}
                {dashData.vendorPOs.length > 0 && (
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center gap-2">
                      <FileText size={15} className="text-blue-500"/> Purchase Orders
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-xs text-slate-500 font-semibold">
                          <tr><th className="p-3">PO No.</th><th className="p-3">Project</th><th className="p-3">Date</th><th className="p-3 text-right">Value</th><th className="p-3 text-center">Status</th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {dashData.vendorPOs.map((po, pi) => {
                            const poVal = po.is_package ? (po.package_cost || 0) * (1 + (po.package_cost_gst || 18)/100)
                              : ((po.equipment_cost||0)+(po.labour_cost||0)+(po.transport_cost||0)+(po.fnb_cost||0)+(po.travel_cost||0)+(po.accommodation_cost||0)+(po.misc_cost||0)) * (1 + (po.gst_rate||18)/100);
                            const stCol = { Draft: 'bg-slate-100 text-slate-600', Sent: 'bg-blue-100 text-blue-700', Approved: 'bg-green-100 text-green-700', Partial: 'bg-amber-100 text-amber-700', Paid: 'bg-green-100 text-green-800', Closed: 'bg-slate-200 text-slate-600', Cancelled: 'bg-red-100 text-red-600' };
                            return (
                              <tr key={pi} className="hover:bg-slate-50">
                                <td className="p-3 font-mono text-slate-700 font-medium">{po.po_no || '—'}</td>
                                <td className="p-3 text-slate-600 max-w-[160px] truncate">{po.project_name}</td>
                                <td className="p-3 text-slate-500">{po.date ? new Date(po.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                                <td className="p-3 text-right font-bold text-slate-800">{formatCurrency(poVal)}</td>
                                <td className="p-3 text-center"><span className={`text-xs px-2 py-0.5 rounded font-medium ${stCol[po.status] || 'bg-slate-100 text-slate-600'}`}>{po.status || 'Draft'}</span></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Payments made to vendor */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center justify-between">
                    <span className="flex items-center gap-2"><CreditCard size={15} className="text-green-500"/> Payments Made to Vendor</span>
                    <span className="text-xs text-slate-400">{dashData.vendorPmts.length} entries · {formatCurrency(dashData.vendorPaid)} total</span>
                  </div>
                  {dashData.vendorPmts.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 text-sm">No payments recorded.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-xs text-slate-500 font-semibold">
                          <tr><th className="p-3">Date</th><th className="p-3">Project</th><th className="p-3">Mode</th><th className="p-3">Reference / Notes</th><th className="p-3 text-right">Amount</th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {[...dashData.vendorPmts].sort((a,b) => new Date(b.date||b.created_at) - new Date(a.date||a.created_at)).map(pay => {
                            const proj = projects.find(p => p.id === pay.project_id);
                            return (
                              <tr key={pay.id} className="hover:bg-slate-50">
                                <td className="p-3 whitespace-nowrap text-slate-600">{pay.date ? new Date(pay.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                                <td className="p-3 text-slate-700 max-w-[150px] truncate">{proj?.project_name || (pay.project_id === 'general' ? 'General' : '—')}</td>
                                <td className="p-3 text-slate-600">{pay.mode || '—'}</td>
                                <td className="p-3 text-slate-400 text-xs max-w-[160px] truncate">{[pay.reference, pay.notes].filter(Boolean).join(' · ') || '—'}</td>
                                <td className="p-3 text-right font-bold text-green-700">{formatCurrency(pay.amount)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
};

export default Clients;
