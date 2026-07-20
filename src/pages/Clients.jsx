import React, { useState, useEffect, useMemo } from 'react';
import { notify } from '../utils/toast';
import { confirmDialog } from '../utils/dialog';
import {
  Users, Plus, Search, Edit, Trash2, MapPin, Copy, Box,
  BarChart2, TrendingUp, TrendingDown, X, ArrowLeft, AlertTriangle,
  Calendar, FileText, CreditCard, Briefcase, CheckCircle, Clock, Link2
} from 'lucide-react';
import {
  doc, updateDoc, deleteDoc, addDoc, collection, serverTimestamp, getDoc, setDoc
} from 'firebase/firestore';
import { Modal, ConfirmDeleteModal, GSTINField } from '../components/Shared';
import { formatCurrency, validateGSTIN, getProjectGrandTotal, getFYFromDate, generateSecureToken, isProjectInvoiced } from '../utils/helpers';
import { GST_STATE_CODES, CATEGORIES } from '../utils/constants';
import { can } from '../utils/permissions';
import { upsertPartyAccount } from '../utils/partyAccounts';
import { generateClientManagementReportPDF } from '../utils/pdf/clientPdf';

const Clients = ({ clients, inventory, projects = [], payments = [], vendorPayments = [], expenses = [], timeLogs = [], employees = [], role, currentEmpId, db, appId, logAction }) => {
  const canSeeAllClients = role !== 'manager'; // only managers are owner-scoped
  const empNameById = (id) => employees.find((e) => e.id === id)?.name || '';
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({
    name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [],
    billing_terms: 'Net 15', custom_terms: '', remarks: '', companies: [],
    owner_id: '', referral_rate: 10
  });
  const [newCompany, setNewCompany] = useState({ name: '', gstin: '', state: '', address: '' });
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
    const rootClient = dashboardClient.rootClient || dashboardClient;
    const cid = rootClient.id;
    const branchId = dashboardClient.isBranch ? dashboardClient.branch_id : null;
    const isBranchView = !!branchId;

    const getProjectCompanyId = (p) => p.party_company_id || 'primary';
    const getPaymentCompanyId = (pay) => {
      if (pay.party_company_id) return pay.party_company_id;
      const linkedProject = projects.find(pr => pr.id === pay.project_id);
      return linkedProject?.party_company_id || 'primary';
    };

    const matchesBranchProject = (p) => !isBranchView || getProjectCompanyId(p) === branchId;
    const matchesBranchPayment = (pay) => !isBranchView || getPaymentCompanyId(pay) === branchId;

    const companyOptions = [
      { id: 'primary', name: rootClient.name || 'Primary Company', gstin: rootClient.gstin || '' },
      ...((rootClient.companies || []).map(c => ({ id: c.id, name: c.name || 'Branch', gstin: c.gstin || '' }))),
    ];
    // Deduplicate by id in case of Firestore listener edge cases
    const seen = new Set();
    const clientProjects = projects.filter(p => {
      if (p.client_id !== cid) return false;
      if (!matchesBranchProject(p)) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    const clientPayments = payments.filter(p => p.client_id === cid && matchesBranchPayment(p));

    // Revenue & billing
    // "Closed" status means project is fully done/invoiced per lifecycle (Closed = invoiced)
    const invoicedProjects = clientProjects.filter(p => isProjectInvoiced(p.invoice_status) || p.status === 'Closed');
    const totalBilled = invoicedProjects.reduce((s, p) => s + getProjectGrandTotal(p), 0);
    const totalReceived = clientPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const outstanding = totalBilled - totalReceived;

    // Overdue: invoiced project whose invoice_date > credit term days ago and not fully paid
    const termDays = parseInt((rootClient.billing_terms || 'Net 15').replace('Net ', ''), 10) || 15;
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
    // "Not invoiced" = Completed status (not yet Closed) and not explicitly marked Invoiced
    const notInvoiced = completed.filter(p => p.status !== 'Closed' && !isProjectInvoiced(p.invoice_status));

    // GST
    const totalGST = invoicedProjects.reduce((s, p) => {
      const grand = getProjectGrandTotal(p);
      const net = grand / 1.18; // approx
      return s + (grand - net);
    }, 0);

    // Lifetime revenue: only delivered (Completed + Closed) to avoid inflating with quotes
    const deliveredProjects = clientProjects.filter(p => ['Completed', 'Closed'].includes(p.status));
    const lifetimeRevenue = deliveredProjects.reduce((s, p) => s + getProjectGrandTotal(p), 0);
    const pipelineRevenue = active.reduce((s, p) => s + getProjectGrandTotal(p), 0);
    // Sort a copy to avoid mutating the filtered array
    const firstProject = [...clientProjects].sort((a, b) => new Date(a.start_date || a.created_at) - new Date(b.start_date || b.created_at))[0];
    const clientSince = firstProject ? (firstProject.start_date || firstProject.created_at) : null;

    // Top categories
    const catMap = {};
    clientProjects.forEach(p => (p.items || []).forEach(item => {
      const cat = item.category || 'Other';
      catMap[cat] = (catMap[cat] || 0) + (item.total || 0);
    }));
    const topCategories = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // Vendor data (if applicable)
    const isVendor = rootClient.type === 'Vendor' || rootClient.type === 'Both';

    // Jobs: all vendor_allocations across all projects for this vendor
    const vendorAllocations = isVendor ? projects.flatMap(p =>
      (p.vendor_allocations || []).filter(a => a.vendor_id === cid && (!isBranchView || (a.party_company_id || p.party_company_id || 'primary') === branchId)).map(a => ({
        ...a,
        project_id: p.id,
        project_name: p.project_name,
        project_status: p.status,
        project_start: p.start_date,
      }))
    ) : [];

    // POs: all vendor_pos across all projects for this vendor
    const vendorPOs = isVendor ? projects.flatMap(p =>
      (p.vendor_pos || []).filter(po => po.vendor_id === cid && (!isBranchView || (po.party_company_id || p.party_company_id || 'primary') === branchId)).map(po => ({
        ...po,
        project_id: p.id,
        project_name: p.project_name,
      }))
    ) : [];

    // Total job value (tax_amount = amount with GST)
    const totalJobValue = vendorAllocations.reduce((s, a) => s + (parseFloat(a.tax_amount || a.amount) || 0), 0);
    const totalJobBase  = vendorAllocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);

    // Payments made to this vendor
    const vendorPmts = isVendor ? vendorPayments.filter(vp => vp.vendor_id === cid && (!isBranchView || ((vp.party_company_id || projects.find(pr => pr.id === vp.project_id)?.party_company_id || 'primary') === branchId))) : [];
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

    const branchSummaries = companyOptions.map(company => {
      const branchProjects = projects.filter(p => p.client_id === cid && getProjectCompanyId(p) === company.id);
      const branchPayments = payments.filter(p => p.client_id === cid && getPaymentCompanyId(p) === company.id);
      const branchInvoiced = branchProjects.filter(p => isProjectInvoiced(p.invoice_status) || p.status === 'Closed');
      const branchBilled = branchInvoiced.reduce((s, p) => s + getProjectGrandTotal(p), 0);
      const branchReceived = branchPayments.reduce((s, p) => s + (p.amount || 0), 0);
      const branchCompletedNotInvoiced = branchProjects.filter(p => ['Completed'].includes(p.status) && !isProjectInvoiced(p.invoice_status));
      return {
        ...company,
        projects: branchProjects.length,
        billed: branchBilled,
        received: branchReceived,
        outstanding: branchBilled - branchReceived,
        notInvoicedCount: branchCompletedNotInvoiced.length,
        notInvoicedAmount: branchCompletedNotInvoiced.reduce((s, p) => s + getProjectGrandTotal(p), 0),
      };
    }).filter(b => b.projects > 0 || b.billed > 0 || b.received > 0 || b.notInvoicedCount > 0);

    return {
      rootClient,
      isBranchView,
      selectedBranchId: branchId,
      clientProjects, clientPayments, invoicedProjects,
      totalBilled, totalReceived, outstanding,
      overdueProjects, overdueAmt,
      active, completed, notInvoiced, totalGST,
      lifetimeRevenue, pipelineRevenue, deliveredProjects, clientSince, topCategories,
      isVendor, vendorAllocations, vendorPOs, vendorPaid, vendorBalance,
      totalJobValue, totalJobBase, vendorPmts, vendorByProject,
      branchSummaries,
    };
  }, [dashboardClient, projects, payments, vendorPayments]);

  // Org settings fetch (for report header), mirrors Projects/Final Report.
  const getOrgSettings = async () => {
    try {
      const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
      if (snap.exists()) return snap.data();
    } catch (e) { console.error(e); }
    return null;
  };
  const handleClientReport = () => generateClientManagementReportPDF({
    dashData, getOrgSettings, addToast: notify, expenses, timeLogs, employees,
  });

  const todayFyStart = (() => {
    const d = new Date();
    const startYear = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
    return `${startYear}-04-01`;
  })();

  const blankOpening = { amount: '', side: 'Dr', date: todayFyStart, remarks: '' };

  // One-time migration: assign every un-owned (legacy) client/vendor to the admin
  // running this. Their projects get tagged by the onClientWritten function.
  const unownedClients = clients.filter((c) => !c.owner_id);
  const handleClaimUnowned = async () => {
    if (role !== 'admin') return notify('Admin only.', 'error');
    if (!currentEmpId) return notify('Your admin account has no employee id to own clients.', 'error');
    if (unownedClients.length === 0) return notify('No un-owned clients to assign.', 'info');
    const ok = await confirmDialog(`Assign ${unownedClients.length} un-owned client(s)/vendor(s) to you (admin)?\n\nTheir projects are tagged automatically. You can reassign any to a manager later.`, { title: 'Claim un-owned clients', confirmLabel: 'Assign to me' });
    if (!ok) return;
    const ownerName = empNameById(currentEmpId) || 'Administrator';
    let done = 0;
    for (const c of unownedClients) {
      try { await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', c.id), { owner_id: currentEmpId, owner_name: ownerName }); done += 1; } catch { /* skip */ }
    }
    logAction('clients', 'backfill_owner', 'bulk', { count: done, owner: currentEmpId }, 'Assigned legacy clients to admin');
    notify(`${done} client(s)/vendor(s) now owned by you.`, 'success');
  };

  // Scoped receipt form: a manager can record a payment from their OWN clients
  // (they only see their own here) without the full Finance page. Managers' entries
  // are flagged 'Pending Review' for Owner/Accountant. client_owner_id is stamped
  // server-side by onPaymentWritten; we also set it locally for immediacy.
  // Managers only: they have create_own_receipt but not full finance.create
  // (Owner/Accountant use the Finance page). Managers are finance-writers at the
  // rule level, so the payment write succeeds.
  const canRecordReceipt = can(role, 'finance', 'create_own_receipt') && !can(role, 'finance', 'create');
  const blankReceipt = () => ({ client_id: '', project_id: 'general', amount: '', date: new Date().toISOString().slice(0, 10), mode: 'UPI', reference: '', remarks: '' });
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [savingReceipt, setSavingReceipt] = useState(false);
  const [receiptForm, setReceiptForm] = useState(blankReceipt());
  const receiptClientProjects = useMemo(
    () => (projects || []).filter((p) => p.client_id === receiptForm.client_id),
    [projects, receiptForm.client_id],
  );
  const saveReceipt = async () => {
    if (!canRecordReceipt) return notify('You are not permitted to record receipts.', 'error');
    const cl = clients.find((c) => c.id === receiptForm.client_id);
    if (!cl) return notify('Select a client.', 'error');
    const amt = parseFloat(receiptForm.amount);
    if (!(amt > 0)) return notify('Enter a valid amount.', 'error');
    setSavingReceipt(true);
    try {
      const data = {
        client_id: cl.id,
        client_name: cl.name,
        project_id: receiptForm.project_id || 'general',
        client_owner_id: cl.owner_id || currentEmpId || '',
        amount: amt,
        date: receiptForm.date,
        mode: receiptForm.mode,
        reference: receiptForm.reference,
        remarks: receiptForm.remarks,
        status: role === 'manager' ? 'Pending Review' : 'Approved',
        recorded_by_role: role,
        created_at: new Date().toISOString(),
        created_by: currentEmpId || '',
        updated_at: new Date().toISOString(),
      };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payments'), data);
      logAction('payments', 'receive_payment', ref.id, data, `Receipt from ${cl.name}`);
      notify(role === 'manager' ? 'Receipt recorded — pending Owner/Accountant review.' : 'Payment recorded.', 'success');
      setReceiptOpen(false);
      setReceiptForm(blankReceipt());
    } catch (e) {
      notify(`Could not record receipt: ${e?.message || 'error'}`, 'error');
    }
    setSavingReceipt(false);
  };

  const openAdd = () => {
    setEditingId(null);
    setFormData({ name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [], billing_terms: 'Net 15', custom_terms: '', remarks: '', companies: [], owner_id: currentEmpId || '', referral_rate: 10, opening_balance: { ...blankOpening } });
    setNewCompany({ name: '', gstin: '', state: '', address: '' });
    setIsAddOpen(true);
  };

  const openEdit = (client) => {
    setEditingId(client.id);
    const ob = client.opening_balance && typeof client.opening_balance === 'object' ? client.opening_balance : null;
    setFormData({
      name: client.name, type: client.type, gstin: client.gstin || '', state: client.state || '',
      address: client.address || '', contacts: client.contacts || [],
      billing_terms: client.billing_terms || 'Net 15', custom_terms: client.custom_terms || '', remarks: client.remarks || '',
      companies: client.companies || [],
      owner_id: client.owner_id || '', referral_rate: client.referral_rate ?? 10,
      opening_balance: ob
        ? { amount: ob.amount != null ? String(ob.amount) : '', side: ob.side || 'Dr', date: ob.date || todayFyStart, remarks: ob.remarks || '' }
        : { ...blankOpening },
    });
    setNewCompany({ name: '', gstin: '', state: '', address: '' });
    setIsAddOpen(true);
  };

  const generateCompanyId = () => `co_${generateSecureToken(8)}`;

  const handleAddCompany = () => {
    const name = (newCompany.name || '').trim();
    const gstin = (newCompany.gstin || '').trim().toUpperCase();
    const address = (newCompany.address || '').trim();
    if (!name || !gstin || !address) return notify('Company/Branch Name, GSTIN and Address are required.', 'error');

    const dupInForm = (formData.companies || []).some(c => (c.gstin || '').trim().toUpperCase() === gstin);
    if (dupInForm || (formData.gstin || '').trim().toUpperCase() === gstin) {
      return notify('This GSTIN is already added in this client record.', 'error');
    }

    setFormData(prev => ({
      ...prev,
      companies: [
        ...(prev.companies || []),
        {
          id: generateCompanyId(),
          name,
          gstin,
          state: newCompany.state || '',
          address,
        },
      ],
    }));
    setNewCompany({ name: '', gstin: '', state: '', address: '' });
  };

  const handleRemoveCompany = (companyId) => {
    setFormData(prev => ({
      ...prev,
      companies: (prev.companies || []).filter(c => c.id !== companyId),
    }));
  };

  const handleDelete = async (id) => {
    if (!can(role, 'clients', 'delete')) return notify('Access denied: only Admin can delete clients.', 'error');
    const clientName = clients.find(c => c.id === id)?.name || 'this client';
    setConfirmModal({
      isOpen: true,
      requireTyped: true,
      title: 'Delete Client',
      message: `Permanently delete "${clientName}"? All associated data will be lost and this cannot be undone.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', id));
        // Cleanup mirror docs so the ledger doesn't keep an orphaned
        // "Party: <name>" row after the source client is gone.
        try {
          const obRef = doc(db, 'artifacts', appId, 'public', 'data', 'opening_balances', `clientob_${id}`);
          const obSnap = await getDoc(obRef);
          if (obSnap.exists()) {
            await deleteDoc(obRef);
            logAction('opening_balances', 'delete', `clientob_${id}`, null, `OB removed (client ${clientName} deleted)`);
          }
        } catch (e) { console.warn('Opening balance cleanup failed:', e?.message); }
        try {
          const paRef = doc(db, 'artifacts', appId, 'public', 'data', 'party_accounts', id);
          const paSnap = await getDoc(paRef);
          if (paSnap.exists()) await deleteDoc(paRef);
        } catch (e) { console.warn('Party account cleanup failed:', e?.message); }
        logAction('clients', 'delete', id, { name: clientName }, clientName);
      }
    });
  };

  const handleAddContact = () => {
    if (!newContact.name || !newContact.phone) return notify("Name and Phone are required.", 'error');
    setFormData({ ...formData, contacts: [...formData.contacts, newContact] });
    setNewContact({ name: '', role: '', phone: '', email: '' });
  };

  const handleRemoveContact = (index) => {
    const updated = [...formData.contacts];
    updated.splice(index, 1);
    setFormData({ ...formData, contacts: updated });
  };

  const handleSave = async () => {
    if (editingId ? !can(role, 'clients', 'edit') : !can(role, 'clients', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    const normalizedPrimaryGST = (formData.gstin || '').trim().toUpperCase();
    if (normalizedPrimaryGST) {
      const val = validateGSTIN(normalizedPrimaryGST, formData.state);
      if (!val.valid) return notify(`GST Error: ${val.msg}`, 'error');
    }

    const normalizedCompanies = (formData.companies || []).map(c => ({
      id: c.id || generateCompanyId(),
      name: (c.name || '').trim(),
      gstin: (c.gstin || '').trim().toUpperCase(),
      state: c.state || '',
      address: (c.address || '').trim(),
    })).filter(c => c.name && c.gstin && c.address);

    for (const company of normalizedCompanies) {
      const val = validateGSTIN(company.gstin, company.state);
      if (!val.valid) return notify(`GST Error in company/branch "${company.name}": ${val.msg}`, 'error');
    }

    const ownGstSet = new Set();
    if (normalizedPrimaryGST) ownGstSet.add(normalizedPrimaryGST);
    for (const company of normalizedCompanies) {
      if (ownGstSet.has(company.gstin)) {
        return notify(`Duplicate GSTIN inside this client: ${company.gstin}`, 'error');
      }
      ownGstSet.add(company.gstin);
    }

    const doSave = async () => {
      const obAmount = parseFloat(formData.opening_balance?.amount || 0) || 0;
      const obSide = (formData.opening_balance?.side || 'Dr').toUpperCase() === 'CR' ? 'Cr' : 'Dr';
      const obDate = formData.opening_balance?.date || todayFyStart;
      const obRemarks = (formData.opening_balance?.remarks || '').trim();
      const opening_balance = obAmount > 0
        ? { amount: obAmount, side: obSide, date: obDate, fy: getFYFromDate(obDate), remarks: obRemarks }
        : null;

      // Owner (= referral employee, earns the commission). Managers always own
      // their own creation; admin may assign/reassign via the dropdown.
      const ownerId = (role === 'admin'
        ? (formData.owner_id || currentEmpId)
        : (editingId ? (formData.owner_id || currentEmpId) : currentEmpId)) || currentEmpId || '';
      const data = {
        ...formData,
        gstin: normalizedPrimaryGST,
        companies: normalizedCompanies,
        owner_id: ownerId,
        owner_name: empNameById(ownerId) || formData.owner_name || '',
        referral_rate: Number(formData.referral_rate) || 10,
        opening_balance,
        updated_at: serverTimestamp()
      };
      let clientId;
      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', editingId), data);
        logAction('clients', 'update', editingId, data, formData.name);
        clientId = editingId;
      } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'clients'), { ...data, created_at: serverTimestamp() });
        logAction('clients', 'create', docRef.id, data, formData.name);
        clientId = docRef.id;
      }

      // M-5: ensure party_accounts/{clientId} exists so the ledger resolves
      // this party's display name (and links opening-balance via accountId).
      // 'Both' (client + vendor) is normalised to 'client' for the registry —
      // toLedger only cares about the stable id; the dual nature is encoded
      // by the journal rows that reference it.
      const entityType = formData.type === 'Vendor' ? 'vendor' : 'client';
      try {
        await upsertPartyAccount(db, appId, clientId, entityType, formData.name);
        // Also keep entity_type fresh in case the user toggled Client⇄Vendor.
        const paRef = doc(db, 'artifacts', appId, 'public', 'data', 'party_accounts', clientId);
        const paSnap = await getDoc(paRef);
        if (paSnap.exists() && paSnap.data().entity_type !== entityType) {
          await updateDoc(paRef, { entity_type: entityType, updated_at: serverTimestamp() });
        }
      } catch { /* non-fatal */ }

      // Mirror opening balance into opening_balances collection so the accounting
      // snapshot picks it up. Stable doc id: clientob_{clientId}. Opening balances are
      // an accounting-ledger concern gated to admin/accountant in firestore.rules, so
      // a manager saving THEIR OWN client must (a) never reach this write, and (b)
      // never have the save flow broken by a rule-denied write. Guard by role AND wrap
      // non-fatally (the OB input is hidden for non-finance roles below).
      const canWriteOB = role === 'admin' || role === 'accountant';
      if (canWriteOB) {
        const obRef = doc(db, 'artifacts', appId, 'public', 'data', 'opening_balances', `clientob_${clientId}`);
        try {
          if (opening_balance) {
            await setDoc(obRef, {
              fy: opening_balance.fy,
              date: opening_balance.date,
              account_name: `Party: ${formData.name}`,
              account_id: `party_${clientId}`,
              side: opening_balance.side,
              amount: opening_balance.amount,
              remarks: opening_balance.remarks || `Opening balance for ${formData.name}`,
              source: 'client_initial',
              entity_id: clientId,
              updated_at: serverTimestamp(),
            }, { merge: true });
            logAction('opening_balances', editingId ? 'update' : 'create', `clientob_${clientId}`, opening_balance, `OB ${formData.name}`);
          } else {
            // No opening balance — remove any prior mirror doc.
            const prior = await getDoc(obRef);
            if (prior.exists()) {
              await deleteDoc(obRef);
              logAction('opening_balances', 'delete', `clientob_${clientId}`, null, `OB removed for ${formData.name}`);
            }
          }
        } catch (e) { console.warn('Opening-balance mirror failed (non-fatal):', e?.message); }
      }

      setIsAddOpen(false);
    };

    // Duplicate detection — check GSTIN globally (client + branch GSTINs) and contact phones
    const newGstin = normalizedPrimaryGST;
    const newPhones = (formData.contacts || []).map(c => c.phone?.trim()).filter(Boolean);
    const newAllGstins = new Set([newGstin, ...normalizedCompanies.map(c => c.gstin)].filter(Boolean));

    const gstCollisions = clients.filter(c => {
      if (editingId && c.id === editingId) return false; // skip self when editing
      const existingGstins = new Set([
        (c.gstin || '').trim().toUpperCase(),
        ...((c.companies || []).map(x => (x.gstin || '').trim().toUpperCase()))
      ].filter(Boolean));
      const gstinMatch = Array.from(newAllGstins).some(g => existingGstins.has(g));
      return gstinMatch;
    });

    if (gstCollisions.length > 0) {
      const reasons = gstCollisions.map(d => {
        const parts = [];
        const existingGstins = new Set([
          (d.gstin || '').trim().toUpperCase(),
          ...((d.companies || []).map(x => (x.gstin || '').trim().toUpperCase()))
        ].filter(Boolean));
        const collidingGst = Array.from(newAllGstins).filter(g => existingGstins.has(g));
        if (collidingGst.length > 0) parts.push(`same GSTIN: ${collidingGst.join(', ')}`);
        return `"${d.name}" (${parts.join(' & ')})`;
      }).join('; ');
      return notify(`GSTIN must be unique across all clients and branches. Conflicts found: ${reasons}`, 'error');
    }

    const phoneDuplicates = clients.filter(c => {
      if (editingId && c.id === editingId) return false;
      const existingPhones = (c.contacts || []).map(x => x.phone?.trim()).filter(Boolean);
      return newPhones.some(p => existingPhones.includes(p));
    });

    if (phoneDuplicates.length > 0) {
      const reasons = phoneDuplicates.map(d => {
        const existingPhones = (d.contacts || []).map(x => x.phone?.trim()).filter(Boolean);
        const commonPhones = newPhones.filter(p => existingPhones.includes(p));
        return `"${d.name}" (matching phone: ${commonPhones.join(', ')})`;
      }).join('; ');
      setConfirmModal({
        isOpen: true,
        title: '⚠️ Possible Duplicate Client',
        message: `A similar client already exists: ${reasons}.\n\nDo you still want to save this as a separate entry?`,
        onConfirm: doSave,
      });
      return;
    }

    await doSave();
  };

  const handleSaveVendorAsset = async () => {
    if (!can(role, 'inventory', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    if (!vendorAssetForm.name || !vendorAssetForm.qty) return notify("Name and Qty required", 'error');

    const newItem = {
      name: vendorAssetForm.name,
      category: vendorAssetForm.category || 'Accessories',
      total: parseInt(vendorAssetForm.qty),
      vendor_id: selectedVendorForAssets.id,
      is_external: true,
      status: 'Available',
      created_at: new Date().toISOString(),
      brand: '', sub_category: '', serial_number: '', location: 'Vendor Premise', gst_rate: 18
    };

    try {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), newItem);
      // Field-split slice 1: rate_per_day → gated inventory_financials sibling, not base.
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory_financials', docRef.id), { rate_per_day: parseFloat(vendorAssetForm.price) || 0, updated_at: new Date().toISOString() }, { merge: true });
      logAction('inventory', 'create_vendor_asset', docRef.id, newItem, newItem.name);
      setVendorAssetForm({ name: '', category: 'Sound', qty: 1, price: 0 });
    } catch (e) {
      notify(`Failed to add vendor asset: ${e.message || e}`, 'error');
    }
  };

  const handleDeleteAsset = async (assetId) => {
    if (!can(role, 'inventory', 'delete')) return notify('Access denied: only Admin can delete assets.', 'error');
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

  const generateLedgerToken = () => generateSecureToken(16);

  const handleLedgerLink = async (client) => {
    if (!can(role, 'clients', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
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

  const handlePortalLink = async (client) => {
    if (!can(role, 'clients', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if (!client) return;
    let token = client.portal_token;
    if (!token) {
      token = generateSecureToken(20);
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', client.id), {
        portal_token: token,
        portal_token_created_at: new Date().toISOString(),
      });
      logAction('clients', 'create_portal_link', client.id, { token }, client.name);
    }
    const link = `${window.location.origin}/portal/${token}`;
    try { await navigator.clipboard.writeText(link); notify('Portal link copied to clipboard.', 'success'); }
    catch { notify('Portal link: ' + link, 'info'); }
  };

  const handleRevokePortalLink = async (client) => {
    if (!can(role, 'clients', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if (!client) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', client.id), { portal_token: '' });
    logAction('clients', 'revoke_portal_link', client.id, {}, client.name);
    notify('Portal link revoked.', 'success');
  };

  const handleRegenerateLedgerLink = async () => {
    if (!can(role, 'clients', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
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
    if (!can(role, 'clients', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
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
    notify('Ledger link copied to clipboard.', 'success');
  };

  const handleCopyLedgerLinkValue = async (link) => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    notify('Ledger link copied to clipboard.', 'success');
  };

  const handleOpenLedgerPage = async (client) => {
    const baseClient = client.rootClient || client;
    let token = baseClient.ledger_link_token;

    // Reuse existing token when available.
    if (!token) {
      if (!can(role, 'clients', 'edit')) {
        notify('Ledger link is not generated yet. Please ask admin/manager to generate it first.', 'error');
        return;
      }
      token = generateLedgerToken();
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', baseClient.id), {
        ledger_link_token: token,
        ledger_link_enabled: true,
        ledger_link_created_at: new Date().toISOString()
      });
      logAction('clients', 'create_ledger_link', baseClient.id, { token }, baseClient.name);
    }

    const companyQuery = client.isBranch && client.branch_id ? `?company=${encodeURIComponent(client.branch_id)}` : '';
    window.open(`${window.location.origin}/ledger/${token}${companyQuery}`, '_blank', 'noopener,noreferrer');
  };

  const generateReimbursableToken = () => generateSecureToken(16);

  const handleOpenReimbursablePage = async (client) => {
    // Public reimbursable view is project-token based.
    const clientProjects = projects
      .filter(p => p.client_id === client.id)
      .filter(p => (p.reimbursable_expenses || []).length > 0)
      .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));

    if (clientProjects.length === 0) {
      notify('No reimbursable entries found for this client.', 'error');
      return;
    }

    const project = clientProjects[0];
    let token = project.reimbursable_token;

    if (!token) {
      if (!can(role, 'projects', 'edit')) {
        notify('Reimbursable link is not generated yet. Please ask admin/manager to generate it first.', 'error');
        return;
      }
      token = generateReimbursableToken();
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', project.id), {
        reimbursable_token: token,
        reimbursable_token_enabled: true,
        reimbursable_token_created_at: new Date().toISOString()
      });
      logAction('projects', 'create_reimbursable_link', project.id, { token }, project.project_name || project.id);
    }

    window.open(`${window.location.origin}/reimbursable/${token}`, '_blank', 'noopener,noreferrer');
  };

  const displayParties = useMemo(() => {
    const rows = [];
    clients.forEach(client => {
      rows.push({
        ...client,
        entity_key: client.id,
        isBranch: false,
        rootClient: client,
        display_name: client.name,
      });
      (client.companies || []).forEach(company => {
        rows.push({
          ...client,
          id: `${client.id}::${company.id}`,
          entity_key: `${client.id}::${company.id}`,
          isBranch: true,
          branch_id: company.id,
          branch_name: company.name,
          name: company.name || client.name,
          gstin: company.gstin || client.gstin,
          address: company.address || client.address,
          rootClient: client,
          display_name: `${client.name} — ${company.name || 'Branch'}`,
        });
      });
    });
    return rows;
  }, [clients]);

  const filteredClients = displayParties.filter(client => {
    // Owner scoping (UI): non admin/accountant see only clients/vendors they own.
    if (!canSeeAllClients && (client.owner_id || client.rootClient?.owner_id) !== currentEmpId) return false;
    const q = searchTerm.toLowerCase();
    return (
      (client.display_name || '').toLowerCase().includes(q) ||
      (client.gstin || '').toLowerCase().includes(q)
    );
  });

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
          {role === 'admin' && activeTab === 'list' && unownedClients.length > 0 && (
            <button onClick={handleClaimUnowned} title="Assign all legacy (un-owned) clients/vendors to admin" className="flex items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-700 hover:bg-amber-100 whitespace-nowrap text-sm font-medium"><Plus size={16} /> Claim {unownedClients.length} un-owned</button>
          )}
          {canRecordReceipt && activeTab === 'list' && (
            <button onClick={() => { setReceiptForm(blankReceipt()); setReceiptOpen(true); }} title="Record a payment received from your client" className="flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-700 hover:bg-emerald-100 whitespace-nowrap text-sm font-medium"><CreditCard size={16} /> Record Receipt</button>
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
          const baseClient = client.rootClient || client;
          const ledgerLink = baseClient.ledger_link_token
            ? `${window.location.origin}/ledger/${baseClient.ledger_link_token}`
            : '';
          return (
          <div key={client.entity_key || client.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col justify-between group relative">
            {(role === 'admin' || role === 'manager') && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-100">
                <button onClick={(e) => {e.stopPropagation(); handleLedgerLink(baseClient)}} className="p-1 text-slate-600 hover:bg-slate-50 rounded" title="Ledger Link"><Copy size={14}/></button>
                <button onClick={(e) => {e.stopPropagation(); openEdit(baseClient)}} className="p-1 text-blue-600 hover:bg-blue-50 rounded"><Edit size={14}/></button>
                <button onClick={(e) => {e.stopPropagation(); handleDelete(baseClient.id)}} className="p-1 text-red-600 hover:bg-red-50 rounded"><Trash2 size={14}/></button>
              </div>
            )}
            <div>
              <div className="flex justify-between items-start">
                <h3 className="font-bold text-slate-800 text-lg">{client.display_name || client.name}</h3>
                <div className="flex flex-col items-end gap-1 mt-6">
                  <span className={`px-2 py-0.5 text-xs rounded ${client.type === 'Vendor' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{client.type}</span>
                  {client.isBranch && <span className="px-2 py-0.5 text-xs rounded bg-cyan-100 text-cyan-700">Branch</span>}
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
                  <button onClick={(e) => {e.stopPropagation(); handleLedgerLink(baseClient)}} className="w-full rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Generate Link</button>
                )}
              </div>
            )}
            {(client.type === 'Vendor' || client.type === 'Both') && (
                <button onClick={(e) => {e.stopPropagation(); setSelectedVendorForAssets(baseClient)}} className="mt-3 w-full flex items-center justify-center gap-2 rounded border border-indigo-200 bg-indigo-50 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
                    <Box size={16} /> Manage Assets ({inventory ? inventory.filter(i => i.vendor_id === baseClient.id).length : 0})
                </button>
            )}
            <button
              onClick={async (e) => { e.stopPropagation(); await handleOpenLedgerPage(baseClient); }}
              className="mt-2 w-full flex items-center justify-center gap-2 rounded border border-emerald-200 bg-emerald-50 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 transition"
            >
              <FileText size={15} /> View Ledger
            </button>
            <button
              onClick={async (e) => { e.stopPropagation(); await handleOpenReimbursablePage(baseClient); }}
              className="mt-2 w-full flex items-center justify-center gap-2 rounded border border-cyan-200 bg-cyan-50 py-1.5 text-sm font-medium text-cyan-700 hover:bg-cyan-100 transition"
            >
              <FileText size={15} /> Reimbursable Ledger
            </button>
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
              {displayParties
                .filter(c => !dashSearch || (c.display_name || c.name || '').toLowerCase().includes(dashSearch.toLowerCase()))
                .slice(0, 20)
                .map(c => {
                  const rootClientId = c.rootClient?.id || c.id;
                  const branchId = c.isBranch ? c.branch_id : null;
                  const cp = projects.filter(p => p.client_id === rootClientId && (!branchId || ((p.party_company_id || 'primary') === branchId)));
                  const totalRev = cp.reduce((s, p) => s + getProjectGrandTotal(p), 0);
                  const clientPay = payments
                    .filter(p => p.client_id === rootClientId)
                    .filter(p => {
                      if (!branchId) return true;
                      const linkedProject = projects.find(pr => pr.id === p.project_id);
                      return (p.party_company_id || linkedProject?.party_company_id || 'primary') === branchId;
                    })
                    .reduce((s, p) => s + (p.amount || 0), 0);
                  const invoiced = cp.filter(p => isProjectInvoiced(p.invoice_status)).reduce((s, p) => s + getProjectGrandTotal(p), 0);
                  const outstanding = invoiced - clientPay;
                  return (
                    <button key={c.entity_key || c.id} onClick={() => setDashboardClient(c)}
                      className="w-full flex items-center justify-between px-3 py-3 hover:bg-indigo-50 transition rounded-lg text-left group">
                      <div className="flex items-center gap-3">
                        <div className={`h-9 w-9 rounded-full flex items-center justify-center font-bold text-white shrink-0 ${
                          c.type === 'Vendor' ? 'bg-purple-500' : c.type === 'Both' ? 'bg-teal-500' : 'bg-indigo-500'
                        }`}>{(c.display_name || c.name || '?')[0].toUpperCase()}</div>
                        <div>
                          <div className="font-semibold text-slate-800 group-hover:text-indigo-700">{c.display_name || c.name}{c.isBranch ? ' (Branch)' : ''}</div>
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
              {displayParties.filter(c => !dashSearch || (c.display_name || c.name || '').toLowerCase().includes(dashSearch.toLowerCase())).length === 0 && (
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
            <div className="flex items-center gap-3">
              <button onClick={() => setDashboardClient(null)} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-indigo-600 transition">
                <ArrowLeft size={16} /> All Clients
              </button>
              {(() => { const rc = dashboardClient.rootClient || dashboardClient; return rc.owner_id ? (
                <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700">Brought by <span className="font-semibold">{rc.owner_name || empNameById(rc.owner_id) || '—'}</span></span>
              ) : null; })()}
            </div>
            <div className="flex items-center gap-2">
              {can(role, 'finance', 'view') && (
                <button onClick={handleClientReport} className="flex items-center gap-1.5 text-sm rounded border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-indigo-700 font-medium hover:bg-indigo-100"><FileText size={14}/> Management Report</button>
              )}
              {can(role, 'clients', 'edit') && (
                <button onClick={() => handlePortalLink(dashboardClient.rootClient || dashboardClient)} title="Copy a secure self-service portal link for this party" className="flex items-center gap-1.5 text-sm rounded border border-teal-200 bg-teal-50 px-3 py-1.5 text-teal-700 font-medium hover:bg-teal-100"><Link2 size={14}/> Portal Link</button>
              )}
              {can(role, 'clients', 'edit') && (dashboardClient.rootClient || dashboardClient).portal_token && (
                <button onClick={() => handleRevokePortalLink(dashboardClient.rootClient || dashboardClient)} title="Disable the portal link" className="flex items-center gap-1.5 text-sm rounded border border-slate-200 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-500"><X size={14}/> Revoke</button>
              )}
              {(role === 'admin' || role === 'manager') && (
                <button onClick={() => openEdit(dashboardClient.rootClient || dashboardClient)} className="flex items-center gap-1.5 text-sm rounded border border-slate-200 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-600"><Edit size={14}/> Edit Client</button>
              )}
            </div>
          </div>
        </div>
      )}
      <Modal isOpen={receiptOpen} onClose={() => setReceiptOpen(false)} title="Record Receipt">
        <div className="space-y-3">
          <p className="text-xs text-slate-500">Record a payment received from one of your clients.{role === 'manager' ? ' It will be flagged for Owner/Accountant review.' : ''}</p>
          <div>
            <label className="text-sm font-bold text-slate-700">Client</label>
            <select className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={receiptForm.client_id} onChange={(e) => setReceiptForm({ ...receiptForm, client_id: e.target.value, project_id: 'general' })}>
              <option value="">— Select your client —</option>
              {[...clients].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {receiptForm.client_id && (
            <div>
              <label className="text-sm font-bold text-slate-700">Against Project (optional)</label>
              <select className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={receiptForm.project_id} onChange={(e) => setReceiptForm({ ...receiptForm, project_id: e.target.value })}>
                <option value="general">General / On account</option>
                {receiptClientProjects.map((p) => <option key={p.id} value={p.id}>{p.project_name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-bold text-slate-700">Amount (₹)</label>
              <input type="number" min="0" step="0.01" className="w-full rounded border border-slate-300 p-2 text-black" value={receiptForm.amount} onChange={(e) => setReceiptForm({ ...receiptForm, amount: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-bold text-slate-700">Date</label>
              <input type="date" className="w-full rounded border border-slate-300 p-2 text-black" value={receiptForm.date} onChange={(e) => setReceiptForm({ ...receiptForm, date: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-bold text-slate-700">Mode</label>
              <select className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={receiptForm.mode} onChange={(e) => setReceiptForm({ ...receiptForm, mode: e.target.value })}>
                <option>UPI</option><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>Card</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-bold text-slate-700">Reference</label>
              <input className="w-full rounded border border-slate-300 p-2 text-black" placeholder="UTR / cheque no." value={receiptForm.reference} onChange={(e) => setReceiptForm({ ...receiptForm, reference: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="text-sm font-bold text-slate-700">Remarks</label>
            <input className="w-full rounded border border-slate-300 p-2 text-black" value={receiptForm.remarks} onChange={(e) => setReceiptForm({ ...receiptForm, remarks: e.target.value })} />
          </div>
          <button onClick={saveReceipt} disabled={savingReceipt} className="w-full rounded bg-emerald-600 text-white py-2 hover:bg-emerald-700 disabled:opacity-50">{savingReceipt ? 'Recording…' : 'Record Receipt'}</button>
        </div>
      </Modal>
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
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-bold text-slate-800">Owner / Brought by <span className="text-xs font-normal text-slate-500">(earns referral)</span></label>
                {role === 'admin' ? (
                  <select className="w-full rounded border p-2 bg-white text-slate-800" value={formData.owner_id || ''} onChange={e => setFormData({ ...formData, owner_id: e.target.value })}>
                    <option value="">— select employee —</option>
                    {employees.filter(emp => (emp.status || 'Active') === 'Active').map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                  </select>
                ) : (
                  <div className="w-full rounded border p-2 bg-slate-50 text-sm text-slate-600">{empNameById(formData.owner_id || currentEmpId) || 'You'}</div>
                )}
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-800">Referral rate %</label>
                <input type="number" min="0" max="100" step="0.5" className="w-full rounded border p-2 text-sm bg-white text-black disabled:bg-slate-50" value={formData.referral_rate ?? 10} disabled={role !== 'admin'} onChange={e => setFormData({ ...formData, referral_rate: e.target.value })} />
              </div>
            </div>
            {/* Opening Balance posts an accounting-ledger row (opening_balances),
                gated to admin/accountant in firestore.rules. Hide it from other roles
                so a manager never enters a value that would be silently dropped. */}
            {(role === 'admin' || role === 'accountant') && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-bold text-slate-800">Opening Balance <span className="text-xs font-normal text-slate-500">(for existing party with prior balance)</span></label>
                {(parseFloat(formData.opening_balance?.amount || 0) > 0) && (
                  <button type="button" onClick={() => setFormData({ ...formData, opening_balance: { ...blankOpening } })} className="text-xs text-rose-600 hover:underline">Clear</button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    className="w-full rounded border p-2 text-sm bg-white text-black"
                    value={formData.opening_balance?.amount ?? ''}
                    onChange={e => setFormData({ ...formData, opening_balance: { ...(formData.opening_balance || blankOpening), amount: e.target.value } })}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">Type</label>
                  <select
                    className="w-full rounded border p-2 text-sm bg-white text-slate-800"
                    value={formData.opening_balance?.side || 'Dr'}
                    onChange={e => setFormData({ ...formData, opening_balance: { ...(formData.opening_balance || blankOpening), side: e.target.value } })}
                  >
                    <option value="Dr">Receivable (they owe us)</option>
                    <option value="Cr">Payable (we owe them)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">As of</label>
                  <input
                    type="date"
                    className="w-full rounded border p-2 text-sm bg-white text-black"
                    value={formData.opening_balance?.date || todayFyStart}
                    onChange={e => setFormData({ ...formData, opening_balance: { ...(formData.opening_balance || blankOpening), date: e.target.value } })}
                  />
                </div>
              </div>
              <input
                type="text"
                placeholder="Remarks (optional, e.g. 'Migrated from Tally on 01-Apr-2025')"
                className="w-full rounded border p-2 text-sm bg-white text-black"
                value={formData.opening_balance?.remarks || ''}
                onChange={e => setFormData({ ...formData, opening_balance: { ...(formData.opening_balance || blankOpening), remarks: e.target.value } })}
              />
              <p className="text-[11px] text-slate-500">Posts to <span className="font-mono">Party: {formData.name || '<name>'}</span> as of the chosen date and reflects in the ledger immediately.</p>
            </div>
            )}
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Contact Persons</h4>
            {formData.contacts.length > 0 && (
              <div className="space-y-2 mb-3">{formData.contacts.map((c, idx) => (<div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border border-slate-200"><div><div className="text-sm font-medium text-slate-800">{c.name}</div><div className="text-xs text-slate-500">{c.phone}</div></div><button onClick={() => handleRemoveContact(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button></div>))}</div>
            )}
            <div className="bg-slate-50 p-3 rounded border border-dashed border-slate-300"><div className="grid grid-cols-2 gap-2 mb-2"><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Name *" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Role" value={newContact.role} onChange={e => setNewContact({...newContact, role: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Phone *" value={newContact.phone} onChange={e => setNewContact({...newContact, phone: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Email" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} /></div><button onClick={handleAddContact} className="w-full rounded border border-indigo-200 bg-white py-1 text-sm text-indigo-600 hover:bg-indigo-50">+ Add to List</button></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Additional Companies / Branches (Unique GSTIN)</h4>
            {(formData.companies || []).length > 0 && (
              <div className="space-y-2">
                {(formData.companies || []).map((c) => (
                  <div key={c.id} className="flex items-start justify-between gap-2 rounded border border-slate-200 bg-slate-50 p-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{c.name}</div>
                      <div className="text-xs font-mono text-slate-600">{c.gstin}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{c.address}</div>
                    </div>
                    <button onClick={() => handleRemoveCompany(c.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3">
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Company / Branch Name *" value={newCompany.name} onChange={e => setNewCompany({ ...newCompany, name: e.target.value })} />
                <input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="GSTIN *" value={newCompany.gstin} onChange={e => setNewCompany({ ...newCompany, gstin: e.target.value.toUpperCase() })} />
                <input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400 col-span-2" placeholder="Address *" value={newCompany.address} onChange={e => setNewCompany({ ...newCompany, address: e.target.value })} />
              </div>
              <button onClick={handleAddCompany} className="w-full rounded border border-indigo-200 bg-white py-1 text-sm text-indigo-600 hover:bg-indigo-50">+ Add Company / Branch</button>
            </div>
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
              {dashData.isBranchView && (
                <div><div className="text-xs text-slate-400 font-semibold mb-0.5">View Scope</div><div className="text-cyan-700 font-semibold">Branch-only dashboard</div></div>
              )}
              {dashboardClient.gstin && <div><div className="text-xs text-slate-400 font-semibold mb-0.5">GSTIN</div><div className="font-mono font-bold text-slate-700">{dashboardClient.gstin}</div></div>}
              <div><div className="text-xs text-slate-400 font-semibold mb-0.5">State</div><div className="text-slate-700">{GST_STATE_CODES[dashboardClient.gstin?.substring(0,2)] || dashboardClient.state || '—'}</div></div>
              <div><div className="text-xs text-slate-400 font-semibold mb-0.5">Credit Terms</div><div className="text-slate-700">{dashboardClient.billing_terms || 'Net 15'}</div></div>
              {dashData.clientSince && <div><div className="text-xs text-slate-400 font-semibold mb-0.5">Client Since</div><div className="text-slate-700">{new Date(dashData.clientSince).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div></div>}
              <div>
                <div className="text-xs text-slate-400 font-semibold mb-0.5">Total Projects</div>
                <div className="font-bold text-slate-800">{dashData.clientProjects.length}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {dashData.active.length > 0 && <span className="text-green-600">{dashData.active.length} active</span>}
                  {dashData.active.length > 0 && dashData.completed.length > 0 && ' · '}
                  {dashData.completed.length > 0 && <span>{dashData.completed.length} done</span>}
                </div>
                {dashData.active.length > 0 && (
                  <div className="text-xs text-slate-400 mt-0.5">
                    {['Quoted','Confirmed','Ongoing'].map(st => {
                      const cnt = dashData.active.filter(p => p.status === st).length;
                      return cnt > 0 ? <span key={st} className="mr-1">{cnt} {st}</span> : null;
                    })}
                  </div>
                )}
              </div>
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
                  <div className="text-xs text-slate-400">{dashData.deliveredProjects.length} delivered project{dashData.deliveredProjects.length !== 1 ? 's' : ''}</div>
                  {dashData.pipelineRevenue > 0 && (
                    <div className="text-xs text-indigo-500 mt-0.5">+ {formatCurrency(dashData.pipelineRevenue)} in pipeline ({dashData.active.length} active)</div>
                  )}
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

              {!dashData.isBranchView && dashData.branchSummaries && dashData.branchSummaries.length > 1 && (
                <div className="mt-3 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm">Company / Branch-wise Summary</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-xs text-slate-500 font-semibold">
                        <tr>
                          <th className="p-3">Company / Branch</th>
                          <th className="p-3">GSTIN</th>
                          <th className="p-3 text-center">Projects</th>
                          <th className="p-3 text-right">Billed</th>
                          <th className="p-3 text-right">Received</th>
                          <th className="p-3 text-right">Outstanding</th>
                          <th className="p-3 text-right">Non-Invoiced</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {dashData.branchSummaries.map(b => (
                          <tr key={b.id} className="hover:bg-slate-50">
                            <td className="p-3 font-medium text-slate-800">{b.name}{b.id === 'primary' ? ' (Primary)' : ''}</td>
                            <td className="p-3 text-xs font-mono text-slate-500">{b.gstin || '—'}</td>
                            <td className="p-3 text-center text-slate-600">{b.projects}</td>
                            <td className="p-3 text-right text-slate-700">{formatCurrency(b.billed)}</td>
                            <td className="p-3 text-right text-green-700">{formatCurrency(b.received)}</td>
                            <td className="p-3 text-right font-semibold">
                              <span className={b.outstanding > 0 ? 'text-amber-700' : 'text-slate-600'}>{formatCurrency(Math.max(0, b.outstanding))}</span>
                            </td>
                            <td className="p-3 text-right">
                              <span className={b.notInvoicedCount > 0 ? 'text-orange-700 font-semibold' : 'text-slate-500'}>
                                {b.notInvoicedCount > 0 ? `${b.notInvoicedCount} (${formatCurrency(b.notInvoicedAmount)})` : '0'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                              {(isProjectInvoiced(p.invoice_status) || p.status === 'Closed') && <div className="text-xs text-green-600 mt-0.5">✓ Invoiced</div>}
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

            {/* All Projects Details */}
            {dashData.clientProjects.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center justify-between">
                  <span className="flex items-center gap-2"><Briefcase size={15} className="text-indigo-500"/> Projects Detail</span>
                  <span className="text-xs text-slate-400">{dashData.clientProjects.length} total &middot; {dashData.active.length} active &middot; {dashData.completed.length} completed</span>
                </div>

                {/* Active Projects */}
                {dashData.active.length > 0 && (
                  <div>
                    <div className="px-4 py-2 bg-green-50 border-b border-slate-100 text-xs font-bold text-green-700 uppercase tracking-wide">Active Projects ({dashData.active.length})</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-xs text-slate-500 font-semibold border-b border-slate-100">
                          <tr>
                            <th className="p-3">Project / Venue</th>
                            <th className="p-3">Dates</th>
                            <th className="p-3 text-center">Status</th>
                            <th className="p-3 text-center">Items</th>
                            <th className="p-3 text-right">Total</th>
                            <th className="p-3 text-right">Received</th>
                            <th className="p-3 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {dashData.active.map(p => {
                            const grand = getProjectGrandTotal(p);
                            const projPaid = dashData.clientPayments.filter(py => py.project_id === p.id).reduce((s, py) => s + (py.amount || 0), 0);
                            const projBalance = grand - projPaid;
                            const statusColor = { Quoted: 'bg-orange-100 text-orange-700', Confirmed: 'bg-green-100 text-green-700', Ongoing: 'bg-red-100 text-red-700', Completed: 'bg-blue-100 text-blue-700', Closed: 'bg-slate-200 text-slate-600' };
                            const itemCount = (p.items || []).length;
                            const venue = p.venue || p.location || '';
                            return (
                              <tr key={p.id} className="hover:bg-slate-50">
                                <td className="p-3">
                                  <div className="font-medium text-slate-800">{p.project_name}</div>
                                  {venue && <div className="text-xs text-slate-400 mt-0.5">{venue}</div>}
                                </td>
                                <td className="p-3 text-xs text-slate-500 whitespace-nowrap">
                                  {p.start_date ? new Date(p.start_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                                  {p.end_date && p.end_date !== p.start_date && <><br/>{new Date(p.end_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</>}
                                </td>
                                <td className="p-3 text-center">
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusColor[p.status] || 'bg-slate-100 text-slate-600'}`}>{p.status}</span>
                                </td>
                                <td className="p-3 text-center text-slate-600 text-xs">{itemCount > 0 ? itemCount : '—'}</td>
                                <td className="p-3 text-right font-bold text-slate-800">{formatCurrency(grand)}</td>
                                <td className="p-3 text-right text-green-700">{projPaid > 0 ? formatCurrency(projPaid) : <span className="text-slate-400">—</span>}</td>
                                <td className="p-3 text-right">
                                  {projBalance > 0 ? <span className="font-semibold text-amber-700">{formatCurrency(projBalance)}</span> : <span className="text-green-600 text-xs font-medium">Settled</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Completed Projects */}
                {dashData.completed.length > 0 && (
                  <div className={dashData.active.length > 0 ? 'border-t border-slate-200' : ''}>
                    <div className="px-4 py-2 bg-blue-50 border-b border-slate-100 text-xs font-bold text-blue-700 uppercase tracking-wide">Completed Projects ({dashData.completed.length})</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-xs text-slate-500 font-semibold border-b border-slate-100">
                          <tr>
                            <th className="p-3">Project / Venue</th>
                            <th className="p-3">Dates</th>
                            <th className="p-3 text-center">Status</th>
                            <th className="p-3 text-center">Invoice</th>
                            <th className="p-3 text-right">Total</th>
                            <th className="p-3 text-right">Received</th>
                            <th className="p-3 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {dashData.completed.map(p => {
                            const grand = getProjectGrandTotal(p);
                            const projPaid = dashData.clientPayments.filter(py => py.project_id === p.id).reduce((s, py) => s + (py.amount || 0), 0);
                            const projBalance = grand - projPaid;
                            const statusColor = { Quoted: 'bg-orange-100 text-orange-700', Confirmed: 'bg-green-100 text-green-700', Ongoing: 'bg-red-100 text-red-700', Completed: 'bg-blue-100 text-blue-700', Closed: 'bg-slate-200 text-slate-600' };
                            const venue = p.venue || p.location || '';
                            const itemCount = (p.items || []).length;
                            return (
                              <tr key={p.id} className="hover:bg-slate-50">
                                <td className="p-3">
                                  <div className="font-medium text-slate-800">{p.project_name}</div>
                                  {venue && <div className="text-xs text-slate-400 mt-0.5">{venue}</div>}
                                  {itemCount > 0 && <div className="text-xs text-slate-400">{itemCount} item{itemCount !== 1 ? 's' : ''}</div>}
                                </td>
                                <td className="p-3 text-xs text-slate-500 whitespace-nowrap">
                                  {p.start_date ? new Date(p.start_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                                  {p.end_date && p.end_date !== p.start_date && <><br/>{new Date(p.end_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</>}
                                </td>
                                <td className="p-3 text-center">
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusColor[p.status] || 'bg-slate-100 text-slate-600'}`}>{p.status}</span>
                                </td>
                                <td className="p-3 text-center">
                                  {(isProjectInvoiced(p.invoice_status) || p.status === 'Closed') ? (
                                    <div>
                                      <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-green-100 text-green-700">{p.status === 'Closed' && !isProjectInvoiced(p.invoice_status) ? 'Closed' : 'Invoiced'}</span>
                                      {p.invoice_no && <div className="text-xs font-mono text-slate-500 mt-0.5">{p.invoice_no}</div>}
                                    </div>
                                  ) : (
                                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-orange-100 text-orange-700">Pending</span>
                                  )}
                                </td>
                                <td className="p-3 text-right font-bold text-slate-800">{formatCurrency(grand)}</td>
                                <td className="p-3 text-right text-green-700">{projPaid > 0 ? formatCurrency(projPaid) : <span className="text-slate-400">—</span>}</td>
                                <td className="p-3 text-right">
                                  {projBalance > 0 ? <span className="font-semibold text-amber-700">{formatCurrency(projBalance)}</span> : <span className="text-green-600 text-xs font-medium">Settled</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

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
