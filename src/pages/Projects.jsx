import React, { useEffect, useMemo, useRef, useState, memo } from 'react';
import { confirmDialog } from '../utils/dialog';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowDownRight, ArrowLeft, ArrowUpRight, Calculator, CheckCircle, ChevronDown, ChevronUp,
  ClipboardList, Clock, Copy, Download, Edit, FileCheck, FileText, History, ListChecks,
  MessageCircle, Monitor, Package, Percent, Plus, Printer, Receipt, RotateCcw,
  Search, Share2, Trash2, Truck, TrendingUp, Users, X, Zap, Upload, Image as ImageIcon, MapPin, Eye
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';
import { collection, addDoc, updateDoc, doc, deleteDoc, serverTimestamp, getDoc, arrayUnion, arrayRemove, runTransaction } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../firebase';

import { CATEGORIES, EXPENSE_CATS, LOGISTICS_TYPES, STATUS_COLORS, GST_STATE_CODES } from '../utils/constants';
import { generateQuotationPDF as generateQuotationPDFImpl, generateQuotationExcel as generateQuotationExcelImpl, generateFinalReportPDF as generateFinalReportPDFImpl, generateTaxInvoicePDF as generateTaxInvoicePDFImpl, generateProformaInvoicePDF as generateProformaInvoicePDFImpl, printChallanPDF as printChallanPDFImpl, downloadEWayBillJSON as downloadEWayBillJSONImpl, generateManagementReportPDF as generateManagementReportPDFImpl } from '../utils/pdf/projectPdf';
import {
  calculateLEDSignalPorts, calculateWallSpecs, formatCurrency, formatCurrencyPDF,
  getDaysDifference, getFinancialYear, getFYFromDate, getProjectGrandTotal, isDateOverlap, LEDTileModel, getEffectivePOCost, fmtDate, getProjectGSTBreakdown, round2,
  getLogisticsLines, sumLogisticsRecord, getDistance, generateSecureToken, isProjectInvoiced, publicLink
} from '../utils/helpers';
import { Modal, ConfirmDeleteModal, SendMenu } from '../components/Shared';
import ProjectRemarks from '../components/ProjectRemarks';
import LocationPicker from '../components/LocationPicker';
import { can } from '../utils/permissions';
import { useEmployeeLocations, isLocationLive } from '../utils/useEmployeeLocations';

// Commit-on-blur input. Types into LOCAL state (instant — no lag) and only calls
// onCommit on blur / Enter, so a field wired to a Firestore write PER KEYSTROKE
// (logistics costs) stops feeling "sticky": previously each character triggered a
// network updateDoc → snapshot → re-render that reverted the input mid-type. Adopts
// external value changes at render time (React's recommended prop→state sync) without
// clobbering in-progress typing, since the parent value only changes after commit.
const CommitInput = memo(function CommitInput({ value, onCommit, className = '', type = 'text', placeholder, disabled, min }) {
  const norm = (v) => (v === null || v === undefined ? '' : String(v));
  const [local, setLocal] = useState(() => norm(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) { setPrev(value); setLocal(norm(value)); }
  const commit = () => { if (norm(value) !== local) onCommit(local); };
  return (
    <input
      type={type}
      min={min}
      placeholder={placeholder}
      className={className}
      value={local}
      disabled={disabled}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
    />
  );
});

// M-1 fix: explicit state machine. Free transitions previously allowed
// Closed → Quoted, leaving stale invoice fields. Map below blocks invalid moves
// and signals which transitions need invoice cleanup.
const PROJECT_STATE_TRANSITIONS = {
  Draft: ['Quoted', 'Cancelled'],
  Quoted: ['Confirmed', 'Cancelled'],
  Confirmed: ['Ongoing', 'Quoted', 'Cancelled'],
  Ongoing: ['Completed', 'Confirmed', 'Cancelled'],
  Completed: ['Closed', 'Ongoing'],
  Closed: ['Completed'],
  Cancelled: ['Quoted'],
};
const isValidProjectTransition = (from, to) => {
  if (!from) return true; // brand new project
  if (from === to) return true;
  return (PROJECT_STATE_TRANSITIONS[from] || []).includes(to);
};
// When demoting away from invoiced/closed, clear invoice fields so GSTR-1
// and Accounting don't keep counting a project that's no longer billable.
const INVOICE_FIELD_RESET = {
  invoice_status: 'Not Invoiced',
  invoice_no: '',
  invoice_date: '',
  invoice_due_date: '',
  invoice_label: '',
  invoice_remarks: '',
  tax_invoice_id: '',
};

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';
const fmtSiteDistance = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

const Projects = ({ projects, clients, inventory, expenses, employees, role, user, currentEmpId = null, db, appId, selectedProjectId, setSelectedProjectId, logAction, addToast, timeLogs = [], taxInvoices = [], payments = [] }) => {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const liveLocations = useEmployeeLocations(db, appId, can(role, 'tracking', 'view'));
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // Inline date editing on detail panel
  const [editingDateField, setEditingDateField] = useState(null); // 'setup_date' | 'start_date' | 'end_date'
  const [editingDateValue, setEditingDateValue] = useState('');

  const handleInlineDateSave = async () => {
    if (!editingDateField || !selectedProject) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
        [editingDateField]: editingDateValue,
      });
      logAction?.('projects', 'update_date', selectedProject.id, { field: editingDateField, value: editingDateValue }, selectedProject.project_name);
      addToast?.('Date updated', 'success');
    } catch (e) {
      addToast?.('Failed to update date', 'error');
    }
    setEditingDateField(null);
    setEditingDateValue('');
  };
  const [isEditItemModalOpen, setIsEditItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  
  // Challan State
  const [isChallanModalOpen, setIsChallanModalOpen] = useState(false);
  const [challanType, setChallanType] = useState('delivery'); // 'delivery' or 'return'
  const [challanForm, setChallanForm] = useState({ mode: 'Road', vehicle_no: '', driver_name: '', driver_mobile: '', eway_bill: '', dispatch_address: '', date: '' });
  const [challanSelection, setChallanSelection] = useState({});
  const [challanSerials, setChallanSerials] = useState({});
  const [isChallanHistoryOpen, setIsChallanHistoryOpen] = useState(false);
  const [editingChallan, setEditingChallan] = useState(null);

  // Proforma Invoice State
  const [isProformaModalOpen, setIsProformaModalOpen] = useState(false);
  const [isProformaHistoryOpen, setIsProformaHistoryOpen] = useState(false);
  const [proformaForm, setProformaForm] = useState({ date: '', notes: '', payment_terms: '' });
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {}, requireTyped: false });
  const [isQuoteShareOpen, setIsQuoteShareOpen] = useState(false);
  const [quoteShareUrl, setQuoteShareUrl] = useState('');
  const [isQuickExpenseOpen, setIsQuickExpenseOpen] = useState(false);
  const [quickExpenseForm, setQuickExpenseForm] = useState({ category: 'Travel', amount: '', notes: '', date: '' });
  const [notesOpen, setNotesOpen] = useState(false);

  // Reimbursable expenses state
  const [isReimbursableOpen, setIsReimbursableOpen] = useState(false);
  const [reimbursableForm, setReimbursableForm] = useState({ description: '', category: 'Travel', amount: '', date: '', remarks: '' });
  const reimbursableProofRef = useRef(null);
  const [reimbursableProofFile, setReimbursableProofFile] = useState(null);
  const [reimbursableProofUploading, setReimbursableProofUploading] = useState(false);
  const [isReimbursableShareOpen, setIsReimbursableShareOpen] = useState(false);
  const [reimbursableShareUrl, setReimbursableShareUrl] = useState('');
  const [editingReimbursableIdx, setEditingReimbursableIdx] = useState(null);

  // Quick expense proof upload
  const qeProofInputRef = useRef(null);
  const [qeProofFile, setQeProofFile] = useState(null);
  const [qeProofUploading, setQeProofUploading] = useState(false);

  // Expense proof policy settings
  const [expenseProofSettings, setExpenseProofSettings] = useState({ threshold: 0, maxSizeMb: 2 });
  const [orgGstin, setOrgGstin] = useState('');
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (snap.exists()) {
          const d = snap.data();
          setExpenseProofSettings({ threshold: d.expense_proof_threshold || 0, maxSizeMb: d.expense_proof_max_size_mb || 2 });
          setOrgGstin(d.gstin || '');
        }
      } catch (_) {}
    };
    fetchSettings();
  }, [db, appId]);

  // Per-project GST split (sales side) decided from client GSTIN vs org state.
  const gstSplitLabel = (supplyType) => supplyType === 'IGST' ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)';
  const stateName = (code) => {
    const c = String(code || '').slice(0, 2);
    return GST_STATE_CODES[c] ? `${c}-${GST_STATE_CODES[c]}` : (c || '—');
  };
  const getProjectSalesGST = (project) => {
    if (!project) return null;
    const clientGstin = project.party_company_gstin || clients.find(c => c.id === project.client_id)?.gstin || '';
    const bd = getProjectGSTBreakdown(project, orgGstin, clientGstin);
    return { ...bd, clientGstin };
  };

  // Project lifecycle: Quoted → Confirmed → Delivered → Invoiced → Paid.
  const getProjectLifecycle = (p) => {
    if (!p) return null;
    const stages = ['Quoted', 'Confirmed', 'Delivered', 'Invoiced', 'Paid'];
    if (p.status === 'Cancelled') return { stages, current: -1, cancelled: true };
    let current = 0;
    if (['Confirmed', 'Ongoing', 'Completed', 'Closed'].includes(p.status)) current = 1;
    if (['Completed', 'Closed'].includes(p.status)) current = 2;
    if (isProjectInvoiced(p.invoice_status)) current = 3;
    const grand = getProjectGrandTotal(p);
    const paid = (payments || []).filter(pay => pay.project_id === p.id).reduce((s, pay) => s + parseFloat(pay.amount || 0), 0);
    if (isProjectInvoiced(p.invoice_status) && grand > 0 && paid >= grand - 1) current = 4;
    return { stages, current, paid, grand };
  };

  // Input-GST (cost side): split outsourcing GST per vendor, decided from each
  // vendor's GSTIN state vs the org state.
  const getProjectInputGST = (project) => {
    if (!project) return null;
    const orgState = (orgGstin || '').slice(0, 2);
    const byVendor = {};
    const add = (vendorId, base, gst) => {
      const vendor = clients.find(c => c.id === vendorId);
      const vg = vendor?.gstin || '';
      const intra = orgState ? (vg.slice(0, 2) ? orgState === vg.slice(0, 2) : true) : false;
      const key = vendorId || 'unknown';
      if (!byVendor[key]) byVendor[key] = { name: vendor?.name || 'Unregistered / unknown vendor', gstin: vg, supplyType: intra ? 'CGST_SGST' : 'IGST', base: 0, gst: 0, cgst: 0, sgst: 0, igst: 0 };
      const v = byVendor[key];
      v.base += base; v.gst += gst;
      if (intra) { v.cgst += gst / 2; v.sgst += gst / 2; } else { v.igst += gst; }
    };
    (project.purchase_orders || []).filter(po => po.status !== 'Cancelled').forEach(po => {
      const eff = getEffectivePOCost(po); add(po.vendor_id, eff.base, eff.gst);
    });
    (project.vendor_allocations || []).filter(a => !a.po_id).forEach(a => {
      const usePkg = a.package_cost && a.package_cost > 0;
      const base = usePkg ? a.package_cost : (a.amount || 0);
      const rate = usePkg ? (a.package_cost_gst || 0) : (a.gst || 0);
      add(a.vendor_id, base, base * (rate / 100) || 0);
    });
    const vendors = Object.values(byVendor).filter(v => v.gst > 0 || v.base > 0);
    if (!vendors.length) return null;
    const totals = vendors.reduce((acc, v) => {
      acc.base += v.base; acc.gst += v.gst; acc.cgst += v.cgst; acc.sgst += v.sgst; acc.igst += v.igst; return acc;
    }, { base: 0, gst: 0, cgst: 0, sgst: 0, igst: 0 });
    return { vendors, totals };
  };

  // --- Order Confirmation State ---
  const [isConfirmOrderOpen, setIsConfirmOrderOpen] = useState(false);
  const [pendingConfirmPid, setPendingConfirmPid] = useState(null);
  const [confirmOrderForm, setConfirmOrderForm] = useState({
    confirmation_date: '',
    confirmation_mode: 'Email',
    confirmed_by_client: '',
    confirmed_by_internal: '',
    po_reference: '',
    advance_committed: '',
    follow_up_required: false,
    follow_up_date: '',
    confirmation_notes: '',
  });

  // --- Filter State ---
  const [filters, setFilters] = useState({
    startDate: '', endDate: '', clientId: '', status: '', setupDate: '', invoiceStatus: ''
  });
  const [isDefaultFilter, setIsDefaultFilter] = useState(true);
  const [myProjectsOnly, setMyProjectsOnly] = useState(role === 'tech');
  const [quickFilter, setQuickFilter] = useState('');

  // Bulk / Group Invoice state
  const [bulkInvoiceOpen, setBulkInvoiceOpen] = useState(false);
  const [bulkInvoiceSelected, setBulkInvoiceSelected] = useState(new Set());
  const [bulkInvoiceForm, setBulkInvoiceForm] = useState({ invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], invoice_status: 'Invoiced' });
  const [bulkFilter, setBulkFilter] = useState({ clientId: '', status: '', dateFrom: '', dateTo: '' });

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;
  const [sortConfig, setSortConfig] = useState({ key: 'start_date', direction: 'desc' });

  // Financial visibility is per-project for managers: admin/accountant see all
  // money; a manager sees rates/margins ONLY on projects they own (their client)
  // or created; tech/user never see project money. Enforces the spec's
  // "assigned-but-not-owner manager → operational access only" (Rule 3).
  const seesAllProjectFinance = role === 'admin' || role === 'accountant';
  const canViewRatesRole = can(role, 'projects', 'view_rates'); // admin/accountant/manager (role capability)
  const projectFinanceVisible = (proj) => seesAllProjectFinance
    || (canViewRatesRole && !!currentEmpId
        && (((proj?.client_owner_id || '') === currentEmpId)
            || ((proj?.created_by || '') === currentEmpId)));
  const canManageProjectInvoices = can(role, 'projects', 'invoice');
  const canEditProjects = can(role, 'projects', 'edit');

  useEffect(() => {
    if (!canViewRatesRole && sortConfig.key === 'total_value') {
      setSortConfig(prev => ({ ...prev, key: 'start_date' }));
    }
  }, [canViewRatesRole, sortConfig.key]);

  const [isAllocationModalOpen, setIsAllocationModalOpen] = useState(false);
  const [allocationForm, setAllocationForm] = useState({ item_id: '', qty: 1, rate: 0, days: 1, gst_rate: 18, available_qty: 0, description: '', is_led: false, tilesWide: 0, tilesHigh: 0, tileModelData: null });
  // Searchable item combobox state
  const [itemSearchQuery, setItemSearchQuery] = useState('');
  const [itemCategoryFilter, setItemCategoryFilter] = useState('');
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const itemComboRef = useRef(null);
  // Close combobox dropdown on outside click
  useEffect(() => {
    if (!showItemDropdown) return;
    const handler = (e) => {
      if (itemComboRef.current && !itemComboRef.current.contains(e.target)) setShowItemDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showItemDropdown]);
  const [isEmpModalOpen, setIsEmpModalOpen] = useState(false);

  // Client search combobox state
  const [clientSearchQuery, setClientSearchQuery] = useState('');
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const clientComboRef = useRef(null);
  useEffect(() => {
    if (!showClientDropdown) return;
    const handler = (e) => {
      if (clientComboRef.current && !clientComboRef.current.contains(e.target)) setShowClientDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showClientDropdown]);

  // Initialize State (Added invoice fields and package cost)
  const [newProj, setNewProj] = useState({
    project_name: '', client_id: '', start_date: '', end_date: '', setup_date: '',
    venue: '', site_lat: null, site_lng: null, status: 'Quoted', invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '',
    items: [], assigned_employees: [], logistics_costs: {}, package_cost: 0, package_cost_gst: 18,
    party_company_id: '', party_company_name: '', party_company_gstin: '', party_company_address: ''
  });

  const getPartyCompanies = (client) => {
    if (!client) return [];
    const primary = {
      id: 'primary',
      name: client.name || 'Primary Company',
      gstin: client.gstin || '',
      address: client.address || '',
    };
    const extras = (client.companies || []).map(c => ({
      id: c.id,
      name: c.name || 'Branch',
      gstin: c.gstin || '',
      address: c.address || '',
    }));
    return [primary, ...extras];
  };

  const projectClientEntityOptions = useMemo(() => {
    const rows = [];
    clients.forEach(c => {
      const companies = getPartyCompanies(c);
      companies.forEach(co => {
        rows.push({
          value: co.id === 'primary' ? c.id : `${c.id}::${co.id}`,
          client_id: c.id,
          company_id: co.id,
          company_name: co.name,
          company_gstin: co.gstin,
          company_address: co.address,
          label: co.id === 'primary' ? c.name : `${c.name} — ${co.name}`,
        });
      });
    });
    return rows;
  }, [clients]);

  useEffect(() => {
    if (projectId) setSelectedProjectId(projectId);
  }, [projectId, setSelectedProjectId]);

  const selectedProject = useMemo(() => {
    if (selectedProjectId == null) return null;
    const targetId = String(selectedProjectId);
    return projects.find(p => String(p.id) === targetId) || null;
  }, [projects, selectedProjectId]);

  // Detail-view financial visibility for the currently open project (owner-aware).
  const canViewProjectFinancials = projectFinanceVisible(selectedProject);

  // Derived values for project notes
  const currentUserObj = useMemo(() => {
    if (currentEmpId) {
      const emp = employees.find(e => e.id === currentEmpId);
      if (emp) return { uid: emp.id, displayName: emp.name, email: emp.email || '', employee_id: emp.id };
    }
    return { uid: role || 'unknown', displayName: role || 'User', email: '', employee_id: null };
  }, [currentEmpId, employees, role]);

  const latestRemark = useMemo(() => {
    if (!selectedProject?.remarks?.length) return null;
    return [...selectedProject.remarks].sort(
      (a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date)
    )[0];
  }, [selectedProject?.remarks]);

  const handleBulkInvoiceApply = async () => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied: insufficient permissions.', 'error');
    if (bulkInvoiceSelected.size === 0) return addToast('Select at least one project.', 'error');
    if (!bulkInvoiceForm.invoice_no.trim()) return addToast('Enter an Invoice Number.', 'error');
    if (!bulkInvoiceForm.invoice_date) return addToast('Enter an Invoice Date.', 'error');
    const confirmed = await confirmDialog(`Apply invoice #${bulkInvoiceForm.invoice_no} to ${bulkInvoiceSelected.size} project(s)?`);
    if (!confirmed) return;
    const updates = [...bulkInvoiceSelected].map(id =>
      updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id), {
        invoice_status: bulkInvoiceForm.invoice_status,
        invoice_no: bulkInvoiceForm.invoice_no.trim(),
        invoice_date: bulkInvoiceForm.invoice_date,
      })
    );
    await Promise.all(updates);
    logAction('projects', 'bulk_invoice', 'multiple', bulkInvoiceForm, `${bulkInvoiceSelected.size} projects`);
    setBulkInvoiceOpen(false);
    setBulkInvoiceSelected(new Set());
    setBulkInvoiceForm({ invoice_no: '', invoice_date: new Date().toISOString().split('T')[0], invoice_status: 'Invoiced' });
    setBulkFilter({ clientId: '', status: '', dateFrom: '', dateTo: '' });
    addToast(`Invoice applied to ${updates.length} project(s).`, 'info');
  };

  const handleSaveRemark = async (projectId, newRemark) => {
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', projectId), {
      remarks: arrayUnion(newRemark)
    });
    logAction('projects', 'add_remark', projectId, newRemark, selectedProject?.project_name);
  };

  // Only admin/manager may delete a remark (enforced here and in ProjectRemarks UI).
  const handleDeleteRemark = async (projectId, remarkId) => {
    if (!(role === 'admin' || role === 'manager')) { addToast('Only admin or manager can delete remarks.', 'error'); return; }
    const proj = projects.find(p => p.id === projectId) || selectedProject;
    const updated = (proj?.remarks || []).filter(r => String(r.id) !== String(remarkId));
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', projectId), { remarks: updated });
    logAction('projects', 'delete_remark', projectId, { remarkId }, proj?.project_name);
  };

  const projectExpenses = useMemo(() => {
    if (!selectedProjectId) return [];
    return expenses.filter(e => e.project_id === selectedProjectId && !isExpenseExcludedStatus(e.status));
  }, [expenses, selectedProjectId]);

  const expenseDateRows = useMemo(() => {
    const employeeMap = new Map(employees.map(e => [e.id, e.name]));
    return [...projectExpenses]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(e => ({
        date: e.date,
        employee: employeeMap.get(e.employee_id) || 'Unknown',
        category: e.category || 'Uncategorized',
        amount: parseFloat(e.amount || 0),
        remarks: e.remarks || '',
        proof_url: e.proof_url || ''
      }));
  }, [projectExpenses, employees]);

  const expenseByEmployeeCategory = useMemo(() => {
    const employeeMap = new Map(employees.map(e => [e.id, e.name]));
    const rollup = new Map();

    projectExpenses.forEach(exp => {
      const employee = employeeMap.get(exp.employee_id) || 'Unknown';
      const category = exp.category || 'Uncategorized';
      const key = `${employee}||${category}`;
      const current = rollup.get(key) || { employee, category, total: 0 };
      current.total += parseFloat(exp.amount || 0);
      rollup.set(key, current);
    });

    return Array.from(rollup.values()).sort((a, b) =>
      a.employee.localeCompare(b.employee) || a.category.localeCompare(b.category)
    );
  }, [projectExpenses, employees]);

  const outsourcingRows = useMemo(() => {
    if (!selectedProject?.vendor_allocations) return [];
    return selectedProject.vendor_allocations.map(v => {
      const base = v.package_cost && v.package_cost > 0 ? v.package_cost : (v.amount || 0);
      const gstRate = v.package_cost && v.package_cost > 0 ? (v.package_cost_gst || 0) : (v.gst || 0);
      return {
        vendor: v.vendor_name || 'Vendor',
        item: v.item_name || '-',
        qty: parseFloat(v.qty || 0),
        days: parseFloat(v.days || 0),
        base,
        gstRate,
        total: base * (1 + (gstRate / 100))
      };
    });
  }, [selectedProject]);

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setIsDefaultFilter(false);
    setCurrentPage(1);
  };

  const resetFilters = () => {
    setFilters({ startDate: '', endDate: '', clientId: '', status: '', setupDate: '', invoiceStatus: '' });
    setQuickFilter('');
    setIsDefaultFilter(true);
    setCurrentPage(1);
  };

  const handleQuickFilterChange = (val) => {
    setQuickFilter(val);
    setIsDefaultFilter(false);
    setCurrentPage(1);
  };

  const exportFilteredProjects = () => {
    // Gate on the role capability (not the selectedProject-dependent detail flag, which
    // is unreliable in the list context). tech/user are blocked entirely.
    if (!canViewRatesRole) return addToast('Access denied: financial export is restricted.', 'error');
    if (sortedProjects.length === 0) return addToast("No projects to export", 'info');
    const data = sortedProjects.map(p => ({
        "Project Name": p.project_name,
        "Client": clients.find(c => c.id === p.client_id)?.name || '',
        "Venue": p.venue,
        "Start Date": p.start_date, "End Date": p.end_date, "Setup Date": p.setup_date || '-',
        "Status": p.status, "Invoice Status": p.invoice_status || 'Not Invoiced', "Invoice No": p.invoice_no || '-',
        // Owner-scoped per row: a manager exports Total Value ONLY for projects they own;
        // other managers' project values are redacted (admin/accountant see all).
        "Total Value": projectFinanceVisible(p) ? getProjectGrandTotal(p) : 'Restricted'
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Projects");
    XLSX.writeFile(wb, `Projects_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // --- Filtering Logic (Updated with Invoice Status) ---
  const filteredProjects = useMemo(() => {
    if (isDefaultFilter) {
        const today = new Date();
        today.setHours(0,0,0,0);
        const last21 = new Date(today); last21.setDate(today.getDate() - 21);
        const next21 = new Date(today); next21.setDate(today.getDate() + 21);

        return projects.filter(p => {
            const pSetup = p.setup_date ? new Date(p.setup_date) : null;
            const pStart = new Date(p.start_date);
            const setupCondition = pSetup && pSetup >= last21 && pSetup <= today;
            const startCondition = pStart >= today && pStart <= next21;
            const inTeam = !myProjectsOnly || (p.assigned_employees || []).includes(currentEmpId);
            return (setupCondition || startCondition) && inTeam;
        });
    }
    return projects.filter(p => {
      const pStart = new Date(p.start_date);
      const pEnd = new Date(p.end_date);
      const pSetup = p.setup_date ? new Date(p.setup_date) : null;
      
      const fStart = filters.startDate ? new Date(filters.startDate) : null;
      const fEnd = filters.endDate ? new Date(filters.endDate) : null;
      const fSetup = filters.setupDate ? new Date(filters.setupDate) : null;

      const matchesStart = fStart ? pStart >= fStart : true;
      const matchesEnd = fEnd ? pEnd <= fEnd : true;
      const matchesSetup = fSetup && pSetup ? pSetup >= fSetup : true;
      const matchesClient = filters.clientId ? p.client_id === filters.clientId : true;
      const matchesStatus = filters.status ? p.status === filters.status : true;
      // Invoice Filter
      const matchesInvoice = filters.invoiceStatus ? (p.invoice_status || 'Not Invoiced') === filters.invoiceStatus : true;

      // Quick Filter Logic
      let matchesQuick = true;
      if (quickFilter) {
          const today = new Date(); today.setHours(0,0,0,0);
          if (quickFilter === 'this_week') {
             const curr = new Date(); 
             const first = curr.getDate() - curr.getDay(); 
             const firstday = new Date(curr.setDate(first)); firstday.setHours(0,0,0,0);
             const lastday = new Date(curr.setDate(firstday.getDate() + 6)); lastday.setHours(23,59,59,999);
             matchesQuick = pStart <= lastday && pEnd >= firstday;
          } else if (quickFilter === 'next_month') {
             const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
             const nextMonthEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0); nextMonthEnd.setHours(23,59,59,999);
             matchesQuick = pStart >= nextMonth && pStart <= nextMonthEnd;
          } else if (quickFilter === 'overdue') {
             matchesQuick = p.status === 'Ongoing' && pEnd < today;
          }
      }

      const matchesTeam = !myProjectsOnly || (p.assigned_employees || []).includes(currentEmpId);

      return matchesStart && matchesEnd && matchesSetup && matchesClient && matchesStatus && matchesInvoice && matchesQuick && matchesTeam;
    });
  }, [projects, filters, isDefaultFilter, quickFilter, myProjectsOnly, currentEmpId]);

  // --- Sorting Logic ---
  const sortedProjects = useMemo(() => {
    let sortableProjects = [...filteredProjects];
    if (sortConfig.key) {
      sortableProjects.sort((a, b) => {
        let aValue, bValue;

        if (sortConfig.key === 'client') {
            aValue = (clients.find(c => c.id === a.client_id)?.name || '').toLowerCase();
            bValue = (clients.find(c => c.id === b.client_id)?.name || '').toLowerCase();
        } else if (sortConfig.key === 'total_value') {
            aValue = getProjectGrandTotal(a);
            bValue = getProjectGrandTotal(b);
        } else {
            aValue = a[sortConfig.key];
            bValue = b[sortConfig.key];
        }

        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableProjects;
  }, [filteredProjects, sortConfig, clients]);

  const paginatedProjects = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedProjects.slice(start, start + itemsPerPage);
  }, [sortedProjects, currentPage]);

  const clientMap = useMemo(() => {
    const map = new Map();
    clients.forEach(c => map.set(String(c.id), c));
    return map;
  }, [clients]);

  const projectCards = useMemo(() => {
    return paginatedProjects.map(project => {
      const start = new Date(project.start_date);
      const end = new Date(project.end_date);
      const now = new Date();

      let progress = 0;
      if (now > end) progress = 100;
      else if (now > start) progress = Math.round(((now - start) / (end - start)) * 100);

      const clientName = clientMap.get(String(project.client_id))?.name || 'Unknown Client';
      const daysDiff = getDaysDifference(project.start_date, project.end_date);
      const setupToStart = project.setup_date && project.start_date
        ? getDaysDifference(project.setup_date, project.start_date)
        : 0;

      return { project, progress, clientName, daysDiff, setupToStart };
    });
  }, [paginatedProjects, clientMap]);

  // ... (Keep existing helpers: getAvailableQty, isEmployeeBusy) ...
  // H-4 fix: composite kit availability now expands sub-components recursively
  // with a cycle guard. Returns a Map of leafItemId → qtyNeeded for given top-level qty.
  const expandComposite = (itemId, qty, visited = new Set()) => {
    const result = new Map();
    if (visited.has(itemId)) return result; // cycle guard (e.g., A→B→A)
    const it = inventory.find(i => i.id === itemId);
    if (!it) return result;
    if (!it.is_composite || !Array.isArray(it.composition) || it.composition.length === 0) {
      result.set(itemId, (result.get(itemId) || 0) + (parseInt(qty) || 0));
      return result;
    }
    visited.add(itemId);
    it.composition.forEach(c => {
      const subQty = (parseInt(c.qty) || 0) * (parseInt(qty) || 0);
      if (subQty <= 0) return;
      const subMap = expandComposite(c.item_id, subQty, new Set(visited));
      subMap.forEach((q, id) => result.set(id, (result.get(id) || 0) + q));
    });
    return result;
  };

  const getAvailableQty = (itemId) => {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return 0;
    // External / vendor-supplied items: treated as virtually unlimited (G-16);
    // physical stock lives at the vendor.
    if (item.is_external) return Number.MAX_SAFE_INTEGER;
    if (!selectedProject?.start_date || !selectedProject?.end_date) return item.total;
    const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
    // For composite kits we need to check leaf-component conflicts, not the kit id.
    const usedQty = overlappingProjs.reduce((acc, p) => {
      let consumed = 0;
      (p.items || []).forEach(alloc => {
        const aq = parseInt(alloc.qty) || 0;
        if (aq <= 0) return;
        // expand each allocated kit to its leaves and count contribution to this itemId
        const leaves = expandComposite(alloc.item_id, aq);
        consumed += leaves.get(itemId) || 0;
      });
      return acc + consumed;
    }, 0);
    return Math.max(0, item.total - usedQty);
  };

  const isEmployeeBusy = (empId) => {
    if (!selectedProject?.start_date || !selectedProject?.end_date) return false;
    const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
    return overlappingProjs.some(p => (p.assigned_employees || []).includes(empId));
  };

  // --- CRUD Handlers ---

  const openCreate = () => {
    setEditingId(null);
    setNewProj({
      project_name: '', client_id: '', start_date: '', end_date: '', setup_date: '',
      venue: '', site_lat: null, site_lng: null, status: role === 'user' ? 'Draft' : 'Quoted', invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '',
      items: [], assigned_employees: [], logistics_costs: {}, package_cost: 0, package_cost_gst: 18,
      party_company_id: '', party_company_name: '', party_company_gstin: '', party_company_address: ''
    });
    setClientSearchQuery('');
    setIsCreateOpen(true);
  };

  const openEdit = (proj) => {
    setEditingId(proj.id);
    setNewProj({ 
      project_name: proj.project_name, client_id: proj.client_id, 
      start_date: proj.start_date, end_date: proj.end_date, setup_date: proj.setup_date || '',
      venue: proj.venue, site_lat: proj.site_lat ?? null, site_lng: proj.site_lng ?? null, status: proj.status,
      invoice_status: proj.invoice_status || 'Not Invoiced', // Load existing
      invoice_no: proj.invoice_no || '', 
      invoice_date: proj.invoice_date || '',
      items: proj.items || [], assigned_employees: proj.assigned_employees || [], logistics_costs: proj.logistics_costs || {},
      package_cost: proj.package_cost || 0, package_cost_gst: proj.package_cost_gst || 18,
      party_company_id: proj.party_company_id || 'primary',
      party_company_name: proj.party_company_name || (clients.find(c => c.id === proj.client_id)?.name || ''),
      party_company_gstin: proj.party_company_gstin || (clients.find(c => c.id === proj.client_id)?.gstin || ''),
      party_company_address: proj.party_company_address || (clients.find(c => c.id === proj.client_id)?.address || '')
    });
    setClientSearchQuery(clients.find(c => c.id === proj.client_id)?.name || '');
    setIsCreateOpen(true);
  };

  const handleDelete = async (id) => {
    const projName = projects.find(p => p.id === id)?.project_name || 'this project';
    setDeleteConfirm({
      isOpen: true,
      requireTyped: true,
      title: 'Delete Project',
      message: `Permanently delete "${projName}" and all its associated data (items, challans, invoices)? This cannot be undone.`,
      onConfirm: async () => {
        if (!can(role, 'projects', 'delete')) return addToast('Access denied: only Admin can delete projects.', 'error');
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
        logAction('projects', 'delete', id, {}, projName);
      }
    });
  };

  const handleSaveProject = async () => {
    const isDraftCreate = !editingId && role === 'user' && can(role, 'projects', 'create_draft');
    if (editingId ? !can(role, 'projects', 'edit') : (!can(role, 'projects', 'create') && !isDraftCreate)) return addToast('Access denied: insufficient permissions.', 'error');
    if (isDraftCreate && newProj.status !== 'Draft') return addToast('Coordinators can only create Draft enquiries.', 'error');
    if(!newProj.client_id || !newProj.project_name) return addToast("Missing Client or Project Name", 'error');
    
    const selectedClient = clients.find(c => c.id === newProj.client_id);
    const clientCompanies = getPartyCompanies(selectedClient);
    const selectedCompany = clientCompanies.find(c => c.id === newProj.party_company_id) || clientCompanies[0] || null;

    // Ensure default invoice status
    const data = {
        ...newProj,
        invoice_status: newProj.invoice_status || 'Not Invoiced',
      party_company_id: selectedCompany?.id || '',
      party_company_name: selectedCompany?.name || '',
      party_company_gstin: selectedCompany?.gstin || '',
      party_company_address: selectedCompany?.address || '',
      // Denormalised owner of the project's client — drives owner-scoped reads.
      client_owner_id: selectedClient?.owner_id || '',
        updated_at: serverTimestamp()
    };

    // Persist the GST supply type (decided from client GSTIN vs org state) so the
    // invoice, reports and clubbing checks stay consistent with the project.
    try {
      const bd = getProjectGSTBreakdown(data, orgGstin, selectedCompany?.gstin || '');
      data.supply_type = bd.supplyType;          // 'CGST_SGST' | 'IGST'
      data.place_of_supply = bd.placeOfSupply;   // 2-digit state code
    } catch (_) { /* non-fatal */ }

    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
      logAction('projects', 'update', editingId, data, newProj.project_name);
      addToast("Project updated successfully", 'success');
    } else {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
      logAction('projects', 'create', docRef.id, data, newProj.project_name);
      addToast("Quote created successfully", 'success');
      setSelectedProjectId(docRef.id);
    }
    setIsCreateOpen(false); 
  };

  const updateStatus = async (pid, newStatus) => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied: insufficient permissions.', 'error');
    if (newStatus === 'Closed' && !can(role, 'projects', 'close')) return addToast("Only Admin can close projects.", 'info');
    const proj = projects.find(p => p.id === pid);
    const fromStatus = proj?.status || 'Quoted';
    // M-1 fix: enforce state machine. Block illegal transitions like Closed → Quoted.
    if (!isValidProjectTransition(fromStatus, newStatus)) {
      return addToast(`Invalid transition: ${fromStatus} → ${newStatus}. Allowed next states: ${(PROJECT_STATE_TRANSITIONS[fromStatus] || []).join(', ') || 'none'}.`, 'error');
    }
    if (newStatus === 'Confirmed') {
      const today = new Date().toISOString().split('T')[0];
      setConfirmOrderForm({
        confirmation_date: today,
        confirmation_mode: 'Email',
        confirmed_by_client: '',
        confirmed_by_internal: '',
        po_reference: '',
        advance_committed: '',
        follow_up_required: false,
        follow_up_date: '',
        confirmation_notes: '',
      });
      setPendingConfirmPid(pid);
      setIsConfirmOrderOpen(true);
      return;
    }
    // M-1 fix: when demoting from Closed/Completed back to an earlier state,
    // clear invoice fields so a previously-invoiced project doesn't keep
    // appearing in GSTR-1 / Accounting sales book.
    const demotionFromInvoiced =
      (fromStatus === 'Closed' || fromStatus === 'Completed') &&
      newStatus !== 'Closed' && newStatus !== 'Completed' &&
      isProjectInvoiced(proj?.invoice_status);
    const payload = { status: newStatus };
    if (demotionFromInvoiced) {
      Object.assign(payload, INVOICE_FIELD_RESET);
      // Tell the user we're un-invoicing
      if (!await confirmDialog(`Demoting an Invoiced project to ${newStatus} will clear its invoice number, date and tax-invoice link. Continue?`)) return;
    }
    // Cancellation: also clear invoice fields and release allocations are not auto-released
    // (data integrity left to user) but mark a cancellation timestamp.
    if (newStatus === 'Cancelled') {
      Object.assign(payload, INVOICE_FIELD_RESET);
      payload.cancelled_at = new Date().toISOString();
      payload.cancelled_by = user?.uid || '';
    }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), payload);
    logAction('projects', 'status_change', pid, payload, proj?.project_name);
  };

  const handleSaveConfirmation = async (skip = false) => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied: insufficient permissions.', 'error');
    if (!pendingConfirmPid) return;
    const payload = { status: 'Confirmed', updated_at: serverTimestamp() };
    if (!skip) {
      payload.confirmation_details = {
        ...confirmOrderForm,
        advance_committed: confirmOrderForm.advance_committed ? parseFloat(confirmOrderForm.advance_committed) : 0,
        saved_at: new Date().toISOString(),
        saved_by_uid: user.uid,
      };
    }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pendingConfirmPid), payload);
    logAction('projects', 'status_change', pendingConfirmPid, { status: 'Confirmed', confirmation_details: payload.confirmation_details }, selectedProject?.project_name);
    setIsConfirmOrderOpen(false);
    setPendingConfirmPid(null);
    addToast('Project confirmed!', 'success');
  };

  const handleShareQuoteForApproval = async () => {
    // Owner-scoped: only the owning manager (or admin/accountant) may mint a public
    // quote-approval link — a non-owner manager must not expose another's quote amounts.
    if (!can(role, 'projects', 'edit') || !canViewProjectFinancials) return addToast('Access denied: insufficient permissions.', 'error');
    if (!selectedProject) return;
    const token = selectedProject.quote_approval_token || generateSecureToken();
    // Token expires in 30 days
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
        quote_approval_token: token,
        quote_approval_expires_at: expiresAt,
        quote_status: selectedProject.quote_status || 'pending',
      });
      const url = publicLink(`/quote-approval/${token}`);
      setQuoteShareUrl(url);
      setIsQuoteShareOpen(true);
      logAction('quote_share', `Shared quote approval link for ${selectedProject.project_name}`);
    } catch (e) {
      addToast('Failed to generate approval link. Please try again.', 'error');
    }
  };

  const handleSaveQuickExpense = async () => {
    if (!can(role, 'expenses', 'create')) return addToast('Access denied: insufficient permissions.', 'error');
    if (!quickExpenseForm.amount || !quickExpenseForm.category || !quickExpenseForm.date) {
      addToast('Please fill in all required fields.', 'error');
      return;
    }
    const qeAmt = parseFloat(quickExpenseForm.amount) || 0;
    if (expenseProofSettings.threshold > 0 && qeAmt > expenseProofSettings.threshold && !qeProofFile) {
      return addToast(`Proof is required for expenses above ${formatCurrency(expenseProofSettings.threshold)}. Please attach an invoice/bill/receipt.`, 'error');
    }
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'expenses'), {
        employee_id: user.uid,
        project_id: selectedProject.id,
        category: quickExpenseForm.category,
        amount: parseFloat(quickExpenseForm.amount) || 0,
        notes: quickExpenseForm.notes || `Quick expense for ${selectedProject.project_name}`,
        date: quickExpenseForm.date,
        status: 'Pending',
        created_at: new Date().toISOString(),
        proof_url: qeProofFile?.url || '',
        proof_path: qeProofFile?.path || '',
        proof_name: qeProofFile?.name || ''
      });
      logAction('expense_add', `Quick expense ₹${quickExpenseForm.amount} (${quickExpenseForm.category}) for ${selectedProject.project_name}`);
      addToast('Expense logged successfully!', 'success');
      setIsQuickExpenseOpen(false);
      setQuickExpenseForm({ category: 'Travel', amount: '', notes: '', date: '' });
      setQeProofFile(null);
    } catch (e) {
      addToast('Failed to save expense. Please try again.', 'error');
    }
  };

  // --- Reimbursable (Client Actuals) Handlers ---
  const handleReimbursableProofUpload = async (file) => {
    if (!file) return;
    const maxBytes = (expenseProofSettings.maxSizeMb || 5) * 1024 * 1024;
    if (file.size > maxBytes) return addToast(`File too large. Max ${expenseProofSettings.maxSizeMb || 5} MB.`, 'error');
    setReimbursableProofUploading(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `reimbursable-proofs/${appId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      setReimbursableProofFile({ url, name: file.name, path });
    } catch (err) { addToast('Upload failed: ' + err.message, 'error'); }
    setReimbursableProofUploading(false);
  };

  const handleSaveReimbursable = async () => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied.', 'error');
    if (!reimbursableForm.description || !reimbursableForm.amount || !reimbursableForm.date) return addToast('Fill description, amount and date.', 'error');
    const entry = {
      id: editingReimbursableIdx !== null ? (selectedProject.reimbursable_expenses || [])[editingReimbursableIdx]?.id : Date.now().toString(36) + Math.random().toString(36).slice(2),
      description: reimbursableForm.description,
      category: reimbursableForm.category,
      amount: parseFloat(reimbursableForm.amount) || 0,
      date: reimbursableForm.date,
      remarks: reimbursableForm.remarks || '',
      proof_url: reimbursableProofFile?.url || '',
      proof_path: reimbursableProofFile?.path || '',
      proof_name: reimbursableProofFile?.name || '',
      created_at: editingReimbursableIdx !== null ? (selectedProject.reimbursable_expenses || [])[editingReimbursableIdx]?.created_at : new Date().toISOString()
    };
    const existing = [...(selectedProject.reimbursable_expenses || [])];
    if (editingReimbursableIdx !== null) {
      existing[editingReimbursableIdx] = entry;
    } else {
      existing.push(entry);
    }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { reimbursable_expenses: existing });
    logAction('projects', editingReimbursableIdx !== null ? 'edit_reimbursable' : 'add_reimbursable', selectedProject.id, entry, selectedProject.project_name);
    addToast(editingReimbursableIdx !== null ? 'Reimbursable expense updated.' : 'Reimbursable expense added.', 'success');
    setIsReimbursableOpen(false);
    setReimbursableForm({ description: '', category: 'Travel', amount: '', date: '', remarks: '' });
    setReimbursableProofFile(null);
    setEditingReimbursableIdx(null);
  };

  const handleDeleteReimbursable = async (idx) => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied.', 'error');
    if (!await confirmDialog('Delete this reimbursable expense?')) return;
    const existing = [...(selectedProject.reimbursable_expenses || [])];
    const removed = existing.splice(idx, 1)[0];
    if (removed?.proof_path) { try { await deleteObject(ref(storage, removed.proof_path)); } catch (_) {} }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { reimbursable_expenses: existing });
    logAction('projects', 'delete_reimbursable', selectedProject.id, removed, selectedProject.project_name);
    addToast('Reimbursable expense deleted.', 'success');
  };

  const handleShareReimbursable = async () => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied.', 'error');
    if (!selectedProject) return;
    const token = selectedProject.reimbursable_token || generateSecureToken();
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
      reimbursable_token: token, reimbursable_token_expires_at: expiresAt
    });
    const url = publicLink(`/reimbursable/${token}`);
    setReimbursableShareUrl(url);
    setIsReimbursableShareOpen(true);
    logAction('projects', 'share_reimbursable', selectedProject.id, {}, selectedProject.project_name);
  };

  // Per-project opt-in: when ON, this project's ACTUAL expenses + reimbursables
  // (with employee-submitted proof images/PDFs) become visible to the client on
  // their existing ledger link. Off by default; reveals real cost/margin, so it
  // is a deliberate per-project choice. Enforced server-side in getLedgerData.
  const toggleShareExpenseDetails = async () => {
    if (!can(role, 'projects', 'edit')) return addToast('Access denied.', 'error');
    if (!selectedProject) return;
    const next = !selectedProject.share_expense_details;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
        share_expense_details: next, updated_at: serverTimestamp(),
      });
      logAction('projects', next ? 'share_expenses_on' : 'share_expenses_off', selectedProject.id, {}, selectedProject.project_name);
      addToast(next
        ? 'Actual expense details + proofs will now show on the client ledger link.'
        : 'Expense sharing turned off for this project.', 'success');
    } catch (e) {
      addToast('Failed to update sharing: ' + e.message, 'error');
    }
  };

  const reimbursableTotal = useMemo(() => {
    if (!selectedProject?.reimbursable_expenses) return 0;
    return selectedProject.reimbursable_expenses.reduce((acc, e) => acc + (parseFloat(e.amount) || 0), 0);
  }, [selectedProject?.reimbursable_expenses]);

  const handleDuplicate = async (project) => {
    if(!await confirmDialog(`Duplicate "${project.project_name}" to create a new quote?`)) return;
    
    // Deep copy items to ensure new IDs
    const itemsCopy = (project.items || []).map(item => ({...item, id: Date.now() + Math.random().toString()}));
    
    setNewProj({ 
      project_name: `Copy of ${project.project_name}`, 
      client_id: project.client_id, 
      start_date: '', end_date: '', setup_date: '', 
      venue: project.venue, status: 'Quoted', 
      invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '',
      items: itemsCopy, assigned_employees: [], logistics_costs: project.logistics_costs || {},
      package_cost: project.package_cost || 0, package_cost_gst: project.package_cost_gst || 18
    });
    setEditingId(null);
    setIsCreateOpen(true);
  };

  // --- Helper to fetch Org Settings ---
  const getOrgSettings = async () => {
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (docSnap.exists()) return docSnap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const getChallanedQty = (allocationId, type, excludeChallanId = null) => {
    return (selectedProject.challans || [])
        .filter(c => c.type === type && c.id !== excludeChallanId)
        .reduce((acc, c) => {
            const item = c.items.find(i => i.id === allocationId);
            return acc + (item ? (parseInt(item.qty) || 0) : 0);
        }, 0);
  };

  // M-4: collect serials referenced on prior challans of a given type. Used to
  // validate that a return challan only ships serials that were actually
  // delivered and not already returned.
  const getChallanedSerials = (allocationId, type, excludeChallanId = null) => {
    const set = new Set();
    (selectedProject.challans || [])
      .filter(c => c.type === type && c.id !== excludeChallanId)
      .forEach(c => {
        const item = c.items.find(i => i.id === allocationId);
        if (item && Array.isArray(item.serial_numbers)) {
          item.serial_numbers.forEach(s => { if (s) set.add(String(s)); });
        }
      });
    return set;
  };

  const openChallanModal = (type, challanToEdit = null) => {
    setChallanType(type);
    setEditingChallan(challanToEdit);
    
    const initialSelection = {};
    const initialSerials = {};
    if (challanToEdit) {
        setChallanForm({
            ...(challanToEdit.transport || {}),
            date: challanToEdit.date ? new Date(challanToEdit.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
        });
        (selectedProject.items || []).forEach(item => {
            const existing = challanToEdit.items.find(i => i.id === item.id);
            initialSelection[item.id] = existing ? existing.qty : 0;
            initialSerials[item.id] = existing ? (existing.serial_numbers || []) : [];
        });
    } else {
        setChallanForm({ 
            mode: 'Road', vehicle_no: '', driver_name: '', driver_mobile: '', eway_bill: '', dispatch_address: '',
            date: new Date().toISOString().split('T')[0]
        });
        (selectedProject.items || []).forEach(item => {
            initialSelection[item.id] = 0;
            initialSerials[item.id] = [];
        });
    }
    
    setChallanSelection(initialSelection);
    setChallanSerials(initialSerials);
    setIsChallanModalOpen(true);
    setIsChallanHistoryOpen(false);
  };

  const quotationCtx = () => ({ selectedProject, calculateProjectTotals, canViewProjectFinancials, clients, getOrgSettings, getProjectSalesGST, stateName, addToast });
  const generateQuotationPDF = () => generateQuotationPDFImpl(quotationCtx());
  const generateQuotationExcel = () => generateQuotationExcelImpl(quotationCtx());

  const generateFinalReportPDF = () => generateFinalReportPDFImpl({ selectedProject, canViewProjectFinancials, addToast, getOrgSettings, clients, calculateProjectTotals, outsourcingRows, expenseDateRows, expenseByEmployeeCategory });
  const mgmtReportCtx = () => ({ selectedProject, canViewProjectFinancials, addToast, getOrgSettings, clients, calculateProjectTotals, outsourcingRows, expenseByEmployeeCategory, payments, timeLogs, employees, lifecycle: getProjectLifecycle(selectedProject) });
  const generateManagementReportPDF = () => generateManagementReportPDFImpl(mgmtReportCtx());
  const buildQuotationPdf = () => generateQuotationPDFImpl({ ...quotationCtx(), deliver: true });
  const projectClientObj = () => clients.find(c => c.id === selectedProject?.client_id) || {};
  const projectClientEmail = () => { const c = projectClientObj(); return c.email || (c.contacts && c.contacts[0] && c.contacts[0].email) || ''; };
  const projectClientPhone = () => { const c = projectClientObj(); return c.phone || c.contact_phone || (c.contacts && c.contacts[0] && c.contacts[0].phone) || ''; };

  // --- Print Handler ---
  const printProjectDocument = async (type) => {
    if (!selectedProject) return;

    if (!canViewProjectFinancials && (type === 'quotation_pdf' || type === 'quotation_excel')) {
      addToast('Access denied: quotation amounts are restricted.', 'error');
      return;
    }

    if (type === 'quotation_pdf') {
      generateQuotationPDF();
      return;
    }

    if (type === 'quotation_excel') {
      generateQuotationExcel();
      return;
    }

    if (type === 'challan') {
        setIsChallanModalOpen(true);
        return;
    }

    const pdfDoc = new jsPDF();
    const pageWidth = pdfDoc.internal.pageSize.width;
    
    // Job Sheet Header
    const addHeader = (title) => {
        pdfDoc.setFontSize(18);
        pdfDoc.text(title, 14, 20);
        pdfDoc.setFontSize(10);
        pdfDoc.text(`Project: ${selectedProject.project_name}`, 14, 30);
        pdfDoc.text(`Client: ${clients.find(c=>c.id===selectedProject.client_id)?.name || '-'}`, 14, 35);
        pdfDoc.text(`Venue: ${selectedProject.venue}`, 14, 40);
        pdfDoc.text(`Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, 14, 45);
        if (selectedProject.setup_date) pdfDoc.text(`Setup: ${selectedProject.setup_date}`, 14, 50);
        return 60;
    };

    if (type === 'pick_list') {
        let y = addHeader("WAREHOUSE PICK LIST");
        
        const pickMap = new Map();

        const processItem = (itemId, qty) => {
            const item = inventory.find(i => i.id === itemId);
            if (!item) return;

            if (item.is_composite && item.composition?.length > 0) {
                item.composition.forEach(comp => {
                    processItem(comp.item_id, qty * (parseInt(comp.qty) || 1));
                });
            } else {
                const existing = pickMap.get(item.id) || {
                    name: item.name,
                    location: item.location || '-',
                    weight: parseFloat(item.weight || 0),
                    qty: 0
                };
                existing.qty += qty;
                pickMap.set(item.id, existing);
            }
        };

        (selectedProject.items || []).forEach(pItem => {
            processItem(pItem.item_id, parseInt(pItem.qty) || 0);
        });

        const pickRows = Array.from(pickMap.values()).map(item => [
            item.name,
            item.qty,
            item.location,
            item.weight > 0 ? `${(item.weight * item.qty).toFixed(2)} kg` : '-'
        ]);

        // Sort by Location then Name
        pickRows.sort((a, b) => (a[2] || '').localeCompare(b[2] || '') || a[0].localeCompare(b[0]));

        pdfDoc.setFontSize(11);
        pdfDoc.text("Consolidated Component List (Kits Broken Down)", 14, y);
        y += 6;

        autoTable(pdfDoc, {
            startY: y,
            head: [['Item Name', 'Total Qty', 'Location', 'Total Weight']],
            body: pickRows,
            theme: 'grid',
            headStyles: { fillColor: [234, 88, 12], textColor: 255 }, // Orange
            styles: { fontSize: 10, cellPadding: 3 },
            columnStyles: {
                0: { cellWidth: 'auto' },
                1: { cellWidth: 25, halign: 'center' },
                2: { cellWidth: 40 },
                3: { cellWidth: 30, halign: 'right' }
            }
        });
        
        pdfDoc.save(`PickList_${selectedProject.project_name}.pdf`);
        return;
    }

    if (type === 'job_sheet') {
        let y = addHeader("PROJECT JOB SHEET");
        
        let totalWatts = 0;
        let totalWeight = 0;
        const equipmentRows = (selectedProject.items || []).map(i => {
            const inv = inventory.find(x => x.id === i.item_id);
            const w = (inv?.weight || 0) * i.qty;
            const p = (inv?.power_watts || 0) * i.qty;
            totalWeight += w;
            totalWatts += p;
            return [i.item_name, i.qty, inv?.location || '-', `${inv?.weight || 0} kg`, `${inv?.power_watts || 0} W`];
        });

        pdfDoc.setFillColor(245, 247, 250);
        pdfDoc.rect(14, y, pageWidth - 28, 22, 'F');
        pdfDoc.setFontSize(11);
        pdfDoc.setTextColor(60);
        pdfDoc.text(`Est. Total Weight: ${totalWeight.toFixed(2)} kg`, 20, y + 14);
        pdfDoc.text(`Est. Total Power: ${(totalWatts/1000).toFixed(2)} kW (${(totalWatts/230).toFixed(1)}A @ 230V)`, 100, y + 14);
        pdfDoc.setTextColor(0);
        y += 30;

        pdfDoc.setFontSize(12);
        pdfDoc.text("Internal Equipment List", 14, y);
        y += 4;
        autoTable(pdfDoc, {
            startY: y,
            head: [['Item', 'Qty', 'Location', 'Unit Wt', 'Unit Pwr']],
            body: equipmentRows,
            theme: 'grid',
            headStyles: { fillColor: [79, 70, 229] },
            styles: { fontSize: 9 }
        });
        y = pdfDoc.lastAutoTable.finalY + 15;

        if ((selectedProject.vendor_allocations || []).length > 0) {
            pdfDoc.text("Outsourced / Vendor Equipment", 14, y);
            y += 4;
            const vendorRows = selectedProject.vendor_allocations.map(v => [
                v.vendor_name, v.item_name, v.qty, `${v.days} days`
            ]);
            autoTable(pdfDoc, {
                startY: y,
                head: [['Vendor', 'Item', 'Qty', 'Duration']],
                body: vendorRows,
                theme: 'grid',
                headStyles: { fillColor: [220, 38, 38] },
                styles: { fontSize: 9 }
            });
        }
        pdfDoc.save(`JobSheet_${selectedProject.project_name}.pdf`);
    }
  };

  const printChallanPDF = (challanData) => printChallanPDFImpl(challanData, { getOrgSettings, clients, selectedProject, challanForm, inventory });
  const handleSaveChallan = async () => {
    const itemsToShip = [];
    
    // Validate and build items list
    for (const item of (selectedProject.items || [])) {
        const qty = parseInt(challanSelection[item.id] || 0);
        if (qty > 0) {
            const excludeId = editingChallan ? editingChallan.id : null;
            const alreadyChallaned = getChallanedQty(item.id, challanType, excludeId);
            
            let maxQty = 0;
            if (challanType === 'delivery') {
                maxQty = item.qty - alreadyChallaned;
            } else {
                // Return: Max is what was delivered - what was already returned
                const delivered = getChallanedQty(item.id, 'delivery');
                const returned = getChallanedQty(item.id, 'return', excludeId);
                maxQty = delivered - returned;
            }

            if (qty > maxQty) {
                addToast(`Error: Item "${item.item_name}" exceeds available quantity. Max: ${maxQty}, Requested: ${qty}`, 'error');
                return;
            }

            // M-4: when serial numbers are picked for this line, validate them
            // against prior challans before persisting.
            const pickedSerials = Array.isArray(challanSerials[item.id])
              ? challanSerials[item.id].map(s => String(s).trim()).filter(Boolean)
              : [];
            if (pickedSerials.length) {
                const dupes = pickedSerials.filter((s, i) => pickedSerials.indexOf(s) !== i);
                if (dupes.length) {
                    addToast(`Error: duplicate serial(s) on "${item.item_name}": ${[...new Set(dupes)].join(', ')}`, 'error');
                    return;
                }
                if (pickedSerials.length > qty) {
                    addToast(`Error: ${pickedSerials.length} serials selected for "${item.item_name}" but qty is ${qty}.`, 'error');
                    return;
                }
                if (challanType === 'return') {
                    const excludeId = editingChallan ? editingChallan.id : null;
                    const deliveredSerials = getChallanedSerials(item.id, 'delivery');
                    const returnedSerials = getChallanedSerials(item.id, 'return', excludeId);
                    const invalid = pickedSerials.filter(s => !deliveredSerials.has(s));
                    if (invalid.length) {
                        addToast(`Error: serial(s) on "${item.item_name}" were never delivered: ${invalid.join(', ')}`, 'error');
                        return;
                    }
                    const reReturned = pickedSerials.filter(s => returnedSerials.has(s));
                    if (reReturned.length) {
                        addToast(`Error: serial(s) on "${item.item_name}" already returned on a prior challan: ${reReturned.join(', ')}`, 'error');
                        return;
                    }
                }
            }

            itemsToShip.push({ ...item, qty, serial_numbers: pickedSerials });
        }
    }

    if (itemsToShip.length === 0) return addToast("Please select at least one item.", 'error');
    if (!can(role, 'challans', 'create')) return addToast('Access denied: insufficient permissions.', 'error');

    try {
        // H-13: counter key derived from the challan's document date,
        // not today's FY, so backdating doesn't corrupt the FY counter.
        const fy = getFYFromDate(challanForm.date) || getFinancialYear();
        const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id);
        const counterRef = doc(db, 'artifacts', appId, 'public', 'data', 'counters', 'challan');

        // H-14: All counter increment + challan array mutation happens in a
        // single runTransaction so partial failures cannot leave the project
        // doc in an inconsistent state (challan removed but not re-added).
        const challanData = await runTransaction(db, async (transaction) => {
            const projectDoc = await transaction.get(projectRef);
            if (!projectDoc.exists()) throw new Error('Project not found');
            const projectData = projectDoc.data();
            const existingChallans = Array.isArray(projectData.challans) ? projectData.challans : [];

            // Build the challan record (reserve a new number if creating)
            let record;
            if (editingChallan) {
                const original = existingChallans.find(c => c.id === editingChallan.id);
                if (!original) throw new Error('Challan no longer exists. Reload and try again.');
                record = {
                    ...original,
                    items: itemsToShip,
                    transport: challanForm,
                    date: new Date(challanForm.date).toISOString(),
                    updated_at: new Date().toISOString(),
                };
            } else {
                const counterDoc = await transaction.get(counterRef);
                const currentCount = (counterDoc.exists() && typeof counterDoc.data()?.[fy] === 'number')
                    ? counterDoc.data()[fy] : 0;
                const nextCount = currentCount + 1;
                transaction.set(counterRef, { [fy]: nextCount }, { merge: true });
                record = {
                    id: Date.now().toString(),
                    challan_no: `${fy}/${String(nextCount).padStart(4, '0')}`,
                    type: challanType,
                    created_by: user.uid,
                    date: new Date(challanForm.date).toISOString(),
                    updated_at: new Date().toISOString(),
                    items: itemsToShip,
                    transport: challanForm,
                };
            }

            // Replace existing challan in-place; otherwise append.
            const nextChallans = editingChallan
                ? existingChallans.map(c => c.id === editingChallan.id ? record : c)
                : [...existingChallans, record];

            const updates = { challans: nextChallans };
            if (!projectData.challan_no && challanType === 'delivery') {
                updates.challan_no = record.challan_no;
                updates.challan_date = record.date;
            }
            transaction.update(projectRef, updates);
            return record;
        });

        logAction('projects', editingChallan ? 'update_challan' : 'create_challan', selectedProject.id, { challan_no: challanData.challan_no }, selectedProject.project_name);

        // H-3: Mirror the movement to /inventory_movements/ for fast inventory
        // history queries. Best-effort writes performed AFTER the transaction
        // commits — failures here are logged but don't block the save.
        try {
            const direction = challanType === 'delivery' ? 'out' : 'in';
            const ts = new Date().toISOString();
            await Promise.all(
                itemsToShip
                    .filter(i => i.item_id) // skip ad-hoc lines without inventory link
                    .map(i => addDoc(
                        collection(db, 'artifacts', appId, 'public', 'data', 'inventory_movements'),
                        {
                            item_id: i.item_id,
                            item_name: i.item_name || '',
                            qty: parseInt(i.qty) || 0,
                            direction,
                            challan_id: challanData.id,
                            challan_no: challanData.challan_no,
                            challan_type: challanType,
                            project_id: selectedProject.id,
                            project_name: selectedProject.project_name,
                            client_id: selectedProject.client_id || null,
                            date: challanData.date,
                            edit: !!editingChallan,
                            recorded_at: ts,
                        }
                    ))
            );
        } catch (mvErr) {
            console.warn('inventory_movements mirror write failed (non-fatal):', mvErr.message);
        }

        if (await confirmDialog("Challan Saved. Print now?")) {
            printChallanPDF(challanData);
        }
        setIsChallanModalOpen(false);
    } catch (e) {
        console.error(e);
        addToast(`Error saving challan: ${e.message}`, 'error');
    }
  };

  const handleDeleteChallan = async (challan) => {
    if (!can(role, 'challans', 'delete')) return addToast('Access denied: only Admin can delete challans.', 'error');
    setDeleteConfirm({
      isOpen: true,
      requireTyped: false,
      title: `Delete Challan ${challan.challan_no}`,
      message: `Are you sure you want to delete Challan ${challan.challan_no}? This action cannot be undone.`,
      onConfirm: async () => {
        try {
            // H-14: read-modify-write under a transaction so concurrent
            // edits cannot resurrect the deleted challan.
            const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id);
            await runTransaction(db, async (transaction) => {
                const projectDoc = await transaction.get(projectRef);
                if (!projectDoc.exists()) throw new Error('Project not found');
                const existing = Array.isArray(projectDoc.data().challans) ? projectDoc.data().challans : [];
                const next = existing.filter(c => c.id !== challan.id);
                transaction.update(projectRef, { challans: next });
            });
            logAction('projects', 'delete_challan', selectedProject.id, { challan_no: challan.challan_no }, selectedProject.project_name);

            // H-3: reversal mirror in inventory_movements (delivery delete = items
            // never went out; return delete = items never came back).
            try {
                const reverseDir = challan.type === 'delivery' ? 'in' : 'out';
                const ts = new Date().toISOString();
                await Promise.all(
                    (challan.items || [])
                        .filter(i => i.item_id)
                        .map(i => addDoc(
                            collection(db, 'artifacts', appId, 'public', 'data', 'inventory_movements'),
                            {
                                item_id: i.item_id,
                                item_name: i.item_name || '',
                                qty: parseInt(i.qty) || 0,
                                direction: reverseDir,
                                challan_id: challan.id,
                                challan_no: challan.challan_no,
                                challan_type: challan.type,
                                project_id: selectedProject.id,
                                project_name: selectedProject.project_name,
                                client_id: selectedProject.client_id || null,
                                date: challan.date,
                                reversal: true,
                                recorded_at: ts,
                            }
                        ))
                );
            } catch (mvErr) {
                console.warn('inventory_movements reversal write failed (non-fatal):', mvErr.message);
            }
        } catch(e) {
            console.error(e);
            addToast("Failed to delete challan", 'error');
        }
      }
    });
  };

  // ==========================================
  // PROFORMA INVOICE HANDLERS
  // ==========================================

  const handleSaveProformaInvoice = async () => {
    if (!can(role, 'projects', 'invoice') || !canViewProjectFinancials) return addToast('Access denied: insufficient permissions.', 'error');
    if (!selectedProject) return;
    try {
      const fy = getFinancialYear();
      const newPiNo = await runTransaction(db, async (transaction) => {
        const counterRef = doc(db, 'artifacts', appId, 'public', 'data', 'counters', 'proforma_invoice');
        const counterDoc = await transaction.get(counterRef);
        let currentCount = 0;
        if (counterDoc.exists()) {
          const cData = counterDoc.data();
          currentCount = (cData && typeof cData[fy] === 'number') ? cData[fy] : 0;
        }
        const nextCount = currentCount + 1;
        transaction.set(counterRef, { [fy]: nextCount }, { merge: true });
        return `PI/${fy}/${String(nextCount).padStart(4, '0')}`;
      });

      const piData = {
        id: Date.now().toString(),
        pi_no: newPiNo,
        date: proformaForm.date || new Date().toISOString().split('T')[0],
        notes: proformaForm.notes || '',
        payment_terms: proformaForm.payment_terms || '',
        created_by: user.uid,
        created_at: new Date().toISOString(),
        items_snapshot: selectedProject.items || [],
        logistics_snapshot: selectedProject.logistics_costs || {},
        package_cost: selectedProject.package_cost || 0,
        package_cost_gst: selectedProject.package_cost_gst || 18,
      };

      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
        proforma_invoices: arrayUnion(piData)
      });
      logAction('projects', 'create_proforma_invoice', selectedProject.id, { pi_no: newPiNo }, selectedProject.project_name);

      if (await confirmDialog(`Proforma Invoice ${newPiNo} saved. Print now?`)) {
        generateProformaInvoicePDF(piData);
      }
      setIsProformaModalOpen(false);
      setProformaForm({ date: '', notes: '', payment_terms: '' });
      addToast(`Proforma Invoice ${newPiNo} created successfully`, 'success');
    } catch (e) {
      console.error(e);
      addToast(`Error creating Proforma Invoice: ${e.message}`, 'error');
    }
  };

  const handleDeleteProformaInvoice = async (piRecord) => {
    if (!can(role, 'projects', 'delete') || !canViewProjectFinancials) return addToast('Access denied: insufficient permissions.', 'error');
    setDeleteConfirm({
      isOpen: true,
      requireTyped: false,
      title: `Delete Proforma Invoice ${piRecord.pi_no}`,
      message: `Are you sure you want to delete Proforma Invoice ${piRecord.pi_no}? This action cannot be undone.`,
      onConfirm: async () => {
        try {
          await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
            proforma_invoices: arrayRemove(piRecord)
          });
          logAction('projects', 'delete_proforma_invoice', selectedProject.id, { pi_no: piRecord.pi_no }, selectedProject.project_name);
          addToast(`Proforma Invoice ${piRecord.pi_no} deleted`, 'success');
        } catch (e) {
          console.error(e);
          addToast('Failed to delete Proforma Invoice', 'error');
        }
      }
    });
  };

  // Ownership-aware: the impl's internal `if (!canManageProjectInvoices)` guard now
  // also fails for a non-owner manager, so no PDF path leaks another manager's rates.
  const generateTaxInvoicePDF = () => generateTaxInvoicePDFImpl({ canManageProjectInvoices: canViewProjectFinancials && canManageProjectInvoices, addToast, getOrgSettings, clients, selectedProject, logAction });
  const generateProformaInvoicePDF = (piData) => generateProformaInvoicePDFImpl(piData, { canManageProjectInvoices: canViewProjectFinancials && canManageProjectInvoices, addToast, getOrgSettings, clients, selectedProject });

  const downloadEWayBillJSON = () => downloadEWayBillJSONImpl({ getOrgSettings, clients, selectedProject, challanSelection, inventory, challanForm });

  // --- NEW INVOICE HANDLER ---
  const updateInvoiceDetails = async (field, value) => {
    if (!can(role, 'projects', 'invoice')) return addToast('Access denied: insufficient permissions.', 'error');
    // Constraint: Can only update if Completed or Closed
    const isCompleted = selectedProject.status === 'Completed' || selectedProject.status === 'Closed';
    
    // Allow Admin to force edit even if not completed, otherwise block
    if (!isCompleted && role !== 'admin') {
        return addToast("Project must be 'Completed' before invoicing.", 'error');
    }

    const updates = { [field]: value };
    
    // Logic: If setting status to 'Not Invoiced', clear details
    if (field === 'invoice_status' && value === 'Not Invoiced') {
        updates.invoice_no = '';
        updates.invoice_date = '';
    }

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), updates);
    logAction('projects', 'invoice_update', selectedProject.id, updates, selectedProject.project_name);
  };

  // ... (Keep existing toggleEmployee, updateLogisticsCost, Modal handlers) ...
  const toggleEmployee = async (empId) => {
    if (!can(role, 'projects', 'team_manage')) return addToast('Access denied: insufficient permissions.', 'error');
    const currentAssigned = selectedProject.assigned_employees || [];
    const newAssigned = currentAssigned.includes(empId) ? currentAssigned.filter(id => id !== empId) : [...currentAssigned, empId];
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { assigned_employees: newAssigned });
    logAction('projects', 'assign_employee', selectedProject.id, { empId, action: currentAssigned.includes(empId) ? 'remove' : 'add' }, selectedProject.project_name);
  };

  const updateLogisticsCost = async (type, field, value) => {
    if (!can(role, 'projects', 'edit')) return;
    const currentCosts = selectedProject.logistics_costs || {};
    const newCosts = { ...currentCosts, [type]: { ...(currentCosts[type] || { amount: 0, gst: 0 }), [field]: parseFloat(value) || 0 } };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { logistics_costs: newCosts });
    logAction('projects', 'update_logistics', selectedProject.id, { type, field, value }, selectedProject.project_name);
  };

  // H-10: persist split-line edits onto logistics_costs[type].lines[]
  const persistLogisticsLines = async (type, lines) => {
    const currentCosts = selectedProject.logistics_costs || {};
    const existing = currentCosts[type] || {};
    const newCosts = { ...currentCosts, [type]: { ...existing, lines } };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { logistics_costs: newCosts });
    logAction('projects', 'update_logistics_lines', selectedProject.id, { type, count: lines.length }, selectedProject.project_name);
  };

  const addLogisticsLine = async (type) => {
    if (!can(role, 'projects', 'edit')) return;
    const labelBase = (LOGISTICS_TYPES.find(lt => lt.id === type)?.label) || type;
    const existing = (selectedProject.logistics_costs || {})[type];
    const lines = Array.isArray(existing?.lines) ? [...existing.lines] : [];
    // If migrating from legacy single-bucket, seed with that value as line 1.
    if (lines.length === 0 && existing && (existing.amount > 0 || existing.gst > 0)) {
      lines.push({ id: `${type}_legacy`, description: labelBase, amount: parseFloat(existing.amount || 0), gst: parseFloat(existing.gst || 0) });
    }
    lines.push({ id: `${type}_${Date.now()}`, description: '', amount: 0, gst: lines[0]?.gst ?? 18 });
    await persistLogisticsLines(type, lines);
  };

  const removeLogisticsLine = async (type, lineId) => {
    if (!can(role, 'projects', 'edit')) return;
    const existing = (selectedProject.logistics_costs || {})[type];
    const lines = (Array.isArray(existing?.lines) ? existing.lines : []).filter(l => l.id !== lineId);
    await persistLogisticsLines(type, lines);
  };

  const updateLogisticsLine = async (type, lineId, field, value) => {
    if (!can(role, 'projects', 'edit')) return;
    const existing = (selectedProject.logistics_costs || {})[type];
    const lines = (Array.isArray(existing?.lines) ? existing.lines : []).map(l => {
      if (l.id !== lineId) return l;
      if (field === 'description') return { ...l, description: value };
      return { ...l, [field]: parseFloat(value) || 0 };
    });
    await persistLogisticsLines(type, lines);
  };

  const openAllocationModal = () => {
    const days = selectedProject?.start_date && selectedProject?.end_date ? getDaysDifference(selectedProject.start_date, selectedProject.end_date) : 1;
    setAllocationForm({ item_id: '', qty: 1, rate: 0, days: days, gst_rate: 18, available_qty: 0, description: '', is_led: false, tilesWide: 0, tilesHigh: 0, tileModelData: null });
    setItemSearchQuery('');
    setItemCategoryFilter('');
    setShowItemDropdown(false);
    setIsAllocationModalOpen(true);
  };

  const handleItemSelect = (e) => {
    const itemId = e.target.value;
    if (!itemId) return setAllocationForm(p => ({...p, item_id: '', available_qty: 0}));
    const item = inventory.find(i => i.id === itemId);
    if (item) {
      // Detect LED Wall category (supports both 'LED Wall' and 'LED')
      const isLed = ['LED Wall', 'LED'].includes(item.category);
      const tileModelData = item.tile_model || item.led_spec || item.tileSpec || null;
      setAllocationForm(p => ({ ...p, item_id: itemId, rate: item.rate_per_day || 0, gst_rate: item.gst_rate || 18, available_qty: getAvailableQty(itemId), is_led: !!isLed, tilesWide: 0, tilesHigh: 0, tileModelData }));
    }
  };

  const handleSaveAllocation = async () => {
    if (!can(role, 'projects', 'allocation')) return addToast('Access denied: insufficient permissions.', 'error');
    if(!allocationForm.item_id) return addToast("Select an item", 'error');
    const item = inventory.find(i => i.id === allocationForm.item_id);
    // If LED allocation, compute tile-based quantities from tilesWide/tilesHigh
    let finalQty = parseInt(allocationForm.qty);
    let ledSpecs = null;
    if (allocationForm.is_led) {
      // Ensure tile model data exists
      if (!allocationForm.tileModelData) return addToast('Selected LED item is missing technical tile details. Please add tile specs to inventory.', 'error');
      // Build a LEDTileModel instance from inventory tileModelData
      const tileModel = new LEDTileModel({
        modelName: allocationForm.tileModelData.modelName || allocationForm.tileModelData.name || item.name,
        dimensions: allocationForm.tileModelData.dimensions || allocationForm.tileModelData.dim || { width: allocationForm.tileModelData.width_mm || 0, height: allocationForm.tileModelData.height_mm || 0, depth: allocationForm.tileModelData.depth_mm || 0 },
        pixelPitch: allocationForm.tileModelData.pixelPitch || allocationForm.tileModelData.pixel_pitch || allocationForm.tileModelData.pitch || 0,
        resolution: allocationForm.tileModelData.resolution || { pixelWidth: allocationForm.tileModelData.pixelWidth || 0, pixelHeight: allocationForm.tileModelData.pixelHeight || 0 },
        power: allocationForm.tileModelData.power || allocationForm.tileModelData.powerSpecs || { maxPower: allocationForm.tileModelData.maxPower || 0, avgPower: allocationForm.tileModelData.avgPower || 0 },
        weight: allocationForm.tileModelData.weight || allocationForm.tileModelData.weightKg || item.weight || 0,
        inventory: allocationForm.tileModelData.inventory || { totalTiles: item.total || 0, tilesPerCase: allocationForm.tileModelData.tilesPerCase || item.tilesPer_case || 1 }
      });

      const w = parseInt(allocationForm.tilesWide) || 0;
      const h = parseInt(allocationForm.tilesHigh) || 0;
      if (w <= 0 || h <= 0) return addToast('Enter valid Tile Width (tiles) and Tile Height (tiles) for LED wall.', 'error');

      ledSpecs = calculateWallSpecs(tileModel, w, h, 230);
      finalQty = ledSpecs?.logistics?.totalTilesNeeded || (w * h);
      // Use availability check against total tiles owned
      if (finalQty > (allocationForm.tileModelData?.inventory?.totalTiles || item.total || 0)) {
        if (!await confirmDialog(`Warning: You are allocating ${finalQty} tiles but only ${allocationForm.tileModelData?.inventory?.totalTiles || item.total || 0} are available. Proceed?`)) return;
      }
    } else {
      if (allocationForm.qty > allocationForm.available_qty) {
        if(!await confirmDialog(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
      }
    }

    // H-11 fix: server-side qty validation; UI "min=0" is bypassable.
    if (!Number.isFinite(finalQty) || finalQty <= 0) return addToast('Quantity must be greater than zero.', 'error');
    const rate = parseFloat(allocationForm.rate) || 0;
    const days = parseInt(allocationForm.days) || 0;
    const gst_rate = parseFloat(allocationForm.gst_rate) || 0;
    if (rate < 0 || days <= 0 || gst_rate < 0) return addToast('Invalid rate, days or GST rate.', 'error');

    // M-8 fix: round all currency math to paise so total = amount + gst_amount.
    const amount = round2(finalQty * rate * days);
    const gst_amount = round2(amount * (gst_rate / 100));
    const total = round2(amount + gst_amount);
    const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: finalQty, rate, days, gst_rate, amount, gst_amount, total, description: allocationForm.description || '' };
    if (allocationForm.is_led) {
      newItem.led = {
        tilesWide: parseInt(allocationForm.tilesWide),
        tilesHigh: parseInt(allocationForm.tilesHigh),
        specs: ledSpecs
      };
    }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
    logAction('projects', 'allocate_item', selectedProject.id, newItem, selectedProject.project_name);
    setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0, description: '', is_led: false, tilesWide: 0, tilesHigh: 0, tileModelData: null })); 
  };

  const handleUpdateItemAllocation = async (updatedItem) => {
    if (!can(role, 'projects', 'allocation')) return addToast('Access denied: insufficient permissions.', 'error');
    const qty = parseInt(updatedItem.qty) || 0;
    const rate = parseFloat(updatedItem.rate) || 0;
    const days = parseInt(updatedItem.days) || 0;
    const gst_rate = parseFloat(updatedItem.gst_rate) || 0;
    if (qty <= 0) return addToast('Quantity must be greater than zero.', 'error');
    if (rate < 0 || days <= 0 || gst_rate < 0) return addToast('Invalid rate, days or GST rate.', 'error');

    // M-8 fix: round each leg, derive total from amount+gst_amount (consistent with PDF).
    const amount = round2(qty * rate * days);
    const gst_amount = round2(amount * (gst_rate / 100));
    const total = round2(amount + gst_amount);

    const finalItem = { ...updatedItem, qty, rate, days, gst_rate, amount, gst_amount, total };

    const newItems = selectedProject.items.map(item => {
      if (item.id === finalItem.id) {
        return finalItem;
      }
      return item;
    });
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: newItems });
    logAction('projects', 'update_item_allocation', selectedProject.id, { item: finalItem }, selectedProject.project_name);
    setIsEditItemModalOpen(false);
  };

  const handleRemoveAllocation = async (item) => {
    if (!can(role, 'projects', 'allocation')) return addToast('Access denied: insufficient permissions.', 'error');
    if(await confirmDialog("Remove this item?")) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
        logAction('projects', 'remove_item', selectedProject.id, item, selectedProject.project_name);
    }
  };

  const calculateProjectTotals = () => {
    if (!selectedProject) return { equipment: 0, logistics: 0, total: 0, gst_output: 0, gst_input: 0, outsourcing: 0, direct_expense: 0, package_cost: 0, use_package_cost: false };
    
    // Check if package cost is specified
    const hasPackageCost = selectedProject.package_cost && selectedProject.package_cost > 0;
    
    let equipmentBase = 0, equipmentGST = 0, logisticsBase = 0, logisticsGST = 0;
    let totalRevenueBase = 0, gstOutput = 0;
    
    if (hasPackageCost) {
      // Package cost — GST split RATE-WISE from the item/logistics rate mix
      // (mirrors getProjectGSTBreakdown), not a single blended rate.
      const bd = getProjectGSTBreakdown(selectedProject, '', '');
      equipmentBase = bd.totals.taxable;
      equipmentGST = bd.totals.cgstAmt + bd.totals.sgstAmt + bd.totals.igstAmt;
      gstOutput = equipmentGST;
      totalRevenueBase = equipmentBase;
    } else {
      // Use items and logistics
      equipmentBase = (selectedProject.items || []).reduce((acc, i) => acc + (i.amount || 0), 0);
      equipmentGST = (selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0);
      if (selectedProject.logistics_costs) {
        Object.values(selectedProject.logistics_costs).forEach(c => {
           // H-10: respect split lines if present.
           const s = sumLogisticsRecord(c);
           logisticsBase += s.amount;
           logisticsGST += s.gstAmount;
        });
      }
      gstOutput = equipmentGST + logisticsGST;
      totalRevenueBase = equipmentBase + logisticsBase;
    }
    
    // Cost waterfall: POs (invoice actuals if Accepted/Verified, else PO amount) + unlinked allocations
    const posForProject = (selectedProject.purchase_orders || []).filter(po => po.status !== 'Cancelled');
    let poOutsourcingBase = 0, poOutsourcingGST = 0;
    posForProject.forEach(po => {
      const eff = getEffectivePOCost(po);
      poOutsourcingBase += eff.base;
      poOutsourcingGST  += eff.gst;
    });
    // Allocations NOT yet linked to any PO (estimates only)
    const unlinkedAllocs = (selectedProject.vendor_allocations || []).filter(a => !a.po_id);
    const unlinkedBase = unlinkedAllocs.reduce((acc, v) => {
      const costBase = (v.package_cost && v.package_cost > 0) ? v.package_cost : (v.amount || 0);
      return acc + costBase;
    }, 0);
    const unlinkedGST = unlinkedAllocs.reduce((acc, v) => {
      const gstRate = (v.package_cost && v.package_cost > 0) ? (v.package_cost_gst || 0) : (v.gst || 0);
      const costBase = (v.package_cost && v.package_cost > 0) ? v.package_cost : (v.amount || 0);
      return acc + (costBase * (gstRate / 100) || 0);
    }, 0);
    const outsourcingBase = poOutsourcingBase + unlinkedBase;
    const outsourcingGST  = poOutsourcingGST  + unlinkedGST;
    const directExpenses = expenses
      .filter(e => e.project_id === selectedProject.id && !isExpenseExcludedStatus(e.status))
      .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);
    const gstInput = outsourcingGST;
    
    const reimbursable = (selectedProject.reimbursable_expenses || []).reduce((acc, e) => acc + (parseFloat(e.amount) || 0), 0);
    
    return { 
      equipment: equipmentBase, logistics: logisticsBase, outsourcing: outsourcingBase,
      direct_expense: directExpenses, reimbursable, gst_output: gstOutput, gst_input: gstInput,
      gst_payable: gstOutput - gstInput,
      total_revenue: totalRevenueBase + gstOutput,
      total_cost: outsourcingBase + directExpenses + gstInput,
      total_client_payable: totalRevenueBase + gstOutput + reimbursable,
      package_cost: selectedProject.package_cost || 0,
      use_package_cost: hasPackageCost
    };
  };

  if (selectedProject) {
    const totals = calculateProjectTotals();
    const totalRevenue = totals.equipment + totals.logistics + totals.gst_output;
    const totalCost = totals.outsourcing + totals.direct_expense + totals.gst_input;
    // Operating profit = base revenue - base cost (GST is neutral for registered business; shown separately)
    const margin = (totals.equipment + totals.logistics) - (totals.outsourcing + totals.direct_expense);
    const isInvoicingEnabled = selectedProject.status === 'Completed' || selectedProject.status === 'Closed' || role === 'admin';
    const clientInfo = clients.find(c => c.id === selectedProject.client_id);
    const allProjectExpenses = expenses.filter(e => e.project_id === selectedProject.id && !isExpenseExcludedStatus(e.status));
    const ownExpenseIds = new Set([currentEmpId, user?.uid].filter(Boolean).map(String));
    const ownProjectExpenses = allProjectExpenses.filter(e => ownExpenseIds.has(String(e.employee_id)));
    const visibleProjectExpenses = canViewProjectFinancials ? allProjectExpenses : ownProjectExpenses;
    const visibleProjectExpenseTotal = visibleProjectExpenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const operatingRevenue = totals.equipment + totals.logistics;
    const operatingCost = totals.outsourcing + totals.direct_expense;
    const pnlPieData = [
      { name: 'Revenue', value: Math.max(0, operatingRevenue) },
      { name: 'Costs', value: Math.max(0, operatingCost) },
      { name: margin >= 0 ? 'Profit' : 'Loss', value: Math.abs(margin) }
    ];
    const pnlPieColors = ['#2563eb', '#dc2626', margin >= 0 ? '#16a34a' : '#f97316'];

    return (
      <div className="space-y-6">
        {/* ===== SECTION 1: HEADER & NAVIGATION ===== */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <button onClick={() => { setSelectedProjectId(null); navigate('/projects'); }} className="flex items-center text-slate-500 hover:text-indigo-600 transition-colors">
            <ArrowLeft size={18} className="mr-2" /> Back to Projects
          </button>
          <div className="flex items-center flex-wrap gap-2">
            <span className={`px-4 py-1.5 rounded-full text-sm font-bold border ${STATUS_COLORS[selectedProject.status]}`}>{selectedProject.status}</span>
            {selectedProject.quote_status === 'approved' && (
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-green-100 text-green-700 border border-green-200 flex items-center gap-1"><CheckCircle size={12}/> Client Approved</span>
            )}
            {selectedProject.quote_status === 'rejected' && (
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-200">Client Declined</span>
            )}
            {selectedProject.quote_status === 'pending' && (
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700 border border-amber-200">Awaiting Approval</span>
            )}
            {(role === 'admin' || role === 'manager') && (
              <select className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm bg-white hover:border-indigo-300 focus:ring-2 focus:ring-indigo-200 transition-all" value={selectedProject.status} onChange={(e) => updateStatus(selectedProject.id, e.target.value)}>
                <option value="Quoted">Quoted</option>
                <option value="Confirmed">Confirmed</option>
                <option value="Ongoing">Ongoing</option>
                <option value="Completed">Completed</option>
                <option value="Closed">Closed</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            )}
          </div>
        </div>

        {/* ===== SECTION 2: PROJECT IDENTITY CARD ===== */}
        <div className="rounded-2xl bg-gradient-to-r from-indigo-600 to-blue-600 p-6 text-white shadow-lg">
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold">{selectedProject.project_name}</h1>
              <div className="flex items-center gap-3 text-indigo-100">
                <span className="flex items-center gap-1"><Users size={14} /> {clientInfo?.name || 'No Client'}</span>
                {clientInfo?.phone && <span className="text-indigo-200">• {clientInfo.phone}</span>}
              </div>
              {selectedProject.venue && (
                <div className="text-indigo-100 text-sm">📍 {selectedProject.venue}</div>
              )}
            </div>
            {canViewProjectFinancials && (
              <div className="bg-white/20 backdrop-blur rounded-xl p-4 text-center min-w-[160px]">
                <div className="text-xs text-indigo-100 uppercase font-semibold">Grand Total</div>
                <div className="text-3xl font-bold">{formatCurrency(totals.total_revenue)}</div>
                {totals.reimbursable > 0 && (
                  <div className="mt-1 border-t border-white/20 pt-1">
                    <div className="text-[10px] text-indigo-200 uppercase">+ Reimbursable</div>
                    <div className="text-sm font-semibold text-teal-200">{formatCurrency(totals.reimbursable)}</div>
                    <div className="text-[10px] text-indigo-200 uppercase mt-0.5">Client Payable</div>
                    <div className="text-lg font-bold">{formatCurrency(totals.total_client_payable)}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ===== Lifecycle strip ===== */}
        {(() => {
          const lc = getProjectLifecycle(selectedProject);
          if (!lc) return null;
          if (lc.cancelled) {
            return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700">Project Cancelled</div>;
          }
          return (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between">
                {lc.stages.map((stage, i) => {
                  const done = i < lc.current;
                  const active = i === lc.current;
                  return (
                    <React.Fragment key={stage}>
                      <div className="flex flex-col items-center gap-1 min-w-0">
                        <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-green-500 text-white' : active ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : 'bg-slate-100 text-slate-400'}`}>
                          {done ? '✓' : i + 1}
                        </div>
                        <span className={`text-[11px] font-medium ${active ? 'text-indigo-700' : done ? 'text-green-700' : 'text-slate-400'}`}>{stage}</span>
                      </div>
                      {i < lc.stages.length - 1 && (
                        <div className={`h-0.5 flex-1 mx-1 ${i < lc.current ? 'bg-green-400' : 'bg-slate-200'}`} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ===== SECTION 3: KEY INFO CARDS ===== */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Start Date */}
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100 group">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1 flex items-center justify-between">
              Start Date
              {can(role, 'projects', 'edit') && editingDateField !== 'start_date' && (
                <button onClick={() => { setEditingDateField('start_date'); setEditingDateValue(selectedProject.start_date || ''); }}
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-indigo-500 hover:text-indigo-700 transition-opacity">
                  <Edit size={12} />
                </button>
              )}
            </div>
            {editingDateField === 'start_date' ? (
              <div className="flex items-center gap-1 mt-1">
                <input type="date" autoFocus value={editingDateValue} onChange={e => setEditingDateValue(e.target.value)}
                  className="flex-1 rounded border border-indigo-300 px-2 py-1 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                <button onClick={handleInlineDateSave} className="text-green-600 hover:text-green-800 font-bold text-xs px-1">✓</button>
                <button onClick={() => setEditingDateField(null)} className="text-slate-400 hover:text-slate-600 text-xs px-1">✕</button>
              </div>
            ) : (
              <div className="text-lg font-bold text-slate-800 cursor-pointer" onClick={() => { if (can(role, 'projects', 'edit')) { setEditingDateField('start_date'); setEditingDateValue(selectedProject.start_date || ''); } }}>
                {fmtDate(selectedProject.start_date)}
              </div>
            )}
          </div>
          {/* End Date */}
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100 group">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1 flex items-center justify-between">
              End Date
              {can(role, 'projects', 'edit') && editingDateField !== 'end_date' && (
                <button onClick={() => { setEditingDateField('end_date'); setEditingDateValue(selectedProject.end_date || ''); }}
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-indigo-500 hover:text-indigo-700 transition-opacity">
                  <Edit size={12} />
                </button>
              )}
            </div>
            {editingDateField === 'end_date' ? (
              <div className="flex items-center gap-1 mt-1">
                <input type="date" autoFocus value={editingDateValue} onChange={e => setEditingDateValue(e.target.value)}
                  className="flex-1 rounded border border-indigo-300 px-2 py-1 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                <button onClick={handleInlineDateSave} className="text-green-600 hover:text-green-800 font-bold text-xs px-1">✓</button>
                <button onClick={() => setEditingDateField(null)} className="text-slate-400 hover:text-slate-600 text-xs px-1">✕</button>
              </div>
            ) : (
              <div className="text-lg font-bold text-slate-800 cursor-pointer" onClick={() => { if (can(role, 'projects', 'edit')) { setEditingDateField('end_date'); setEditingDateValue(selectedProject.end_date || ''); } }}>
                {fmtDate(selectedProject.end_date)}
              </div>
            )}
          </div>
          {/* Setup Date */}
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100 group">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1 flex items-center justify-between">
              Setup Date
              {can(role, 'projects', 'edit') && editingDateField !== 'setup_date' && (
                <button onClick={() => { setEditingDateField('setup_date'); setEditingDateValue(selectedProject.setup_date || ''); }}
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-indigo-500 hover:text-indigo-700 transition-opacity">
                  <Edit size={12} />
                </button>
              )}
            </div>
            {editingDateField === 'setup_date' ? (
              <div className="flex items-center gap-1 mt-1">
                <input type="date" autoFocus value={editingDateValue} onChange={e => setEditingDateValue(e.target.value)}
                  className="flex-1 rounded border border-indigo-300 px-2 py-1 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                <button onClick={handleInlineDateSave} className="text-green-600 hover:text-green-800 font-bold text-xs px-1">✓</button>
                <button onClick={() => setEditingDateField(null)} className="text-slate-400 hover:text-slate-600 text-xs px-1">✕</button>
              </div>
            ) : (
              <div className="text-lg font-bold text-indigo-600 cursor-pointer" onClick={() => { if (can(role, 'projects', 'edit')) { setEditingDateField('setup_date'); setEditingDateValue(selectedProject.setup_date || ''); } }}>
                {fmtDate(selectedProject.setup_date)}
              </div>
            )}
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1">Duration</div>
            <div className="text-lg font-bold text-slate-800">
              {selectedProject.start_date && selectedProject.end_date 
                ? `${getDaysDifference(selectedProject.start_date, selectedProject.end_date)} days` 
                : '—'}
            </div>
          </div>
        </div>

        {/* ===== SECTION 3.2: CONFIRMATION DETAILS ===== */}
        {selectedProject.status === 'Confirmed' || selectedProject.confirmation_details ? (
          <div className={`rounded-xl p-4 shadow-sm border ${selectedProject.confirmation_details ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CheckCircle size={17} className={selectedProject.confirmation_details ? 'text-green-600' : 'text-amber-500'} />
                <span className="font-semibold text-sm text-slate-700">Order Confirmation</span>
              </div>
              {(role === 'admin' || role === 'manager') && (
                <button
                  onClick={() => {
                    const cd = selectedProject.confirmation_details || {};
                    const today = new Date().toISOString().split('T')[0];
                    setConfirmOrderForm({
                      confirmation_date: cd.confirmation_date || today,
                      confirmation_mode: cd.confirmation_mode || 'Email',
                      confirmed_by_client: cd.confirmed_by_client || '',
                      confirmed_by_internal: cd.confirmed_by_internal || '',
                      po_reference: cd.po_reference || '',
                      advance_committed: cd.advance_committed || '',
                      follow_up_required: cd.follow_up_required || false,
                      follow_up_date: cd.follow_up_date || '',
                      confirmation_notes: cd.confirmation_notes || '',
                    });
                    setPendingConfirmPid(selectedProject.id);
                    setIsConfirmOrderOpen(true);
                  }}
                  className="text-xs px-2 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-600 flex items-center gap-1"
                ><Edit size={12} /> Edit
                </button>
              )}
            </div>
            {selectedProject.confirmation_details ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                <div><span className="text-xs text-slate-500 block">Date</span><span className="font-semibold text-slate-800">{selectedProject.confirmation_details.confirmation_date || '—'}</span></div>
                <div><span className="text-xs text-slate-500 block">Mode</span><span className="font-semibold text-slate-800">{selectedProject.confirmation_details.confirmation_mode || '—'}</span></div>
                {selectedProject.confirmation_details.po_reference && (
                  <div><span className="text-xs text-slate-500 block">Reference / PO No.</span><span className="font-semibold text-slate-800">{selectedProject.confirmation_details.po_reference}</span></div>
                )}
                {selectedProject.confirmation_details.confirmed_by_client && (
                  <div><span className="text-xs text-slate-500 block">Client Contact</span><span className="font-semibold text-slate-800">{selectedProject.confirmation_details.confirmed_by_client}</span></div>
                )}
                {selectedProject.confirmation_details.confirmed_by_internal && (
                  <div><span className="text-xs text-slate-500 block">Received By</span><span className="font-semibold text-slate-800">{selectedProject.confirmation_details.confirmed_by_internal}</span></div>
                )}
                {canViewProjectFinancials && selectedProject.confirmation_details.advance_committed > 0 && (
                  <div><span className="text-xs text-slate-500 block">Advance Committed</span><span className="font-semibold text-green-700">{formatCurrency(selectedProject.confirmation_details.advance_committed)}</span></div>
                )}
                {selectedProject.confirmation_details.follow_up_required && (
                  <div className="col-span-2 md:col-span-3">
                    <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">
                      ⚠ Written confirmation pending{selectedProject.confirmation_details.follow_up_date ? ` by ${selectedProject.confirmation_details.follow_up_date}` : ''}
                    </span>
                  </div>
                )}
                {selectedProject.confirmation_details.confirmation_notes && (
                  <div className="col-span-2 md:col-span-3"><span className="text-xs text-slate-500 block">Notes</span><span className="text-slate-700">{selectedProject.confirmation_details.confirmation_notes}</span></div>
                )}
              </div>
            ) : (
              <p className="text-xs text-amber-700">Project marked Confirmed but no confirmation details recorded. <button onClick={() => { setPendingConfirmPid(selectedProject.id); const today = new Date().toISOString().split('T')[0]; setConfirmOrderForm({ confirmation_date: today, confirmation_mode: 'Email', confirmed_by_client: '', confirmed_by_internal: '', po_reference: '', advance_committed: '', follow_up_required: false, follow_up_date: '', confirmation_notes: '' }); setIsConfirmOrderOpen(true); }} className="underline text-amber-800 font-semibold">Add now →</button></p>
            )}
          </div>
        ) : null}

        {/* ===== SECTION 3.5: PINNED PROJECT NOTES ===== */}
        <div className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
          <button
            className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
            onClick={() => setNotesOpen(o => !o)}
          >
            <div className="flex items-center gap-3 min-w-0">
              <MessageCircle size={17} className="text-indigo-500 shrink-0" />
              <span className="font-semibold text-slate-700 text-sm shrink-0">Project Notes</span>
              {(selectedProject.remarks?.length || 0) > 0 && (
                <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-bold shrink-0">
                  {selectedProject.remarks.length}
                </span>
              )}
              {!notesOpen && latestRemark && (
                <span className="text-xs text-slate-400 truncate hidden sm:block">
                  — {latestRemark.remark?.substring(0, 70)}{(latestRemark.remark?.length || 0) > 70 ? '\u2026' : ''}
                </span>
              )}
              {!notesOpen && !latestRemark && (
                <span className="text-xs text-slate-400">No notes yet</span>
              )}
            </div>
            {notesOpen
              ? <ChevronUp size={16} className="text-slate-400 shrink-0" />
              : <ChevronDown size={16} className="text-slate-400 shrink-0" />}
          </button>
          {notesOpen && (
            <div className="border-t border-slate-100 p-4">
              <ProjectRemarks
                project={selectedProject}
                currentUser={currentUserObj}
                role={role}
                employees={employees}
                clients={clients}
                onSaveRemark={handleSaveRemark}
                onDeleteRemark={handleDeleteRemark}
                onClose={() => setNotesOpen(false)}
              />
            </div>
          )}
        </div>

        {/* ===== SECTION 4: QUICK ACTIONS BAR ===== */}
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 uppercase mr-2">Documents:</span>
            {canViewProjectFinancials && (
              <button onClick={() => printProjectDocument('quotation_pdf')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-indigo-50 hover:border-indigo-200 text-slate-700 transition-all">
                <FileText size={16} className="text-indigo-500" /> Quote PDF
              </button>
            )}
            {canViewProjectFinancials && (
              <button onClick={() => printProjectDocument('quotation_excel')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-green-50 hover:border-green-200 text-slate-700 transition-all">
                <FileText size={16} className="text-green-500" /> Quote Excel
              </button>
            )}
            <button onClick={() => printProjectDocument('job_sheet')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-amber-50 hover:border-amber-200 text-slate-700 transition-all">
              <Printer size={16} className="text-amber-500" /> Job Sheet
            </button>
            <button onClick={() => printProjectDocument('pick_list')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-purple-50 hover:border-purple-200 text-slate-700 transition-all">
              <ListChecks size={16} className="text-purple-500" /> Pick List
            </button>
            {canViewProjectFinancials && (
              <button onClick={generateFinalReportPDF} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50 hover:border-slate-300 text-slate-700 transition-all">
                <FileText size={16} className="text-slate-600" /> Final Report
              </button>
            )}
            {canViewProjectFinancials && (
              <button onClick={generateManagementReportPDF} className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm hover:bg-indigo-100 text-indigo-700 font-medium transition-all">
                <ClipboardList size={16} className="text-indigo-600" /> Management Report
              </button>
            )}
            {canViewProjectFinancials && selectedProject && (
              <SendMenu
                label="Send Quote"
                buildPdf={buildQuotationPdf}
                email={projectClientEmail()}
                phone={projectClientPhone()}
                subject={`Quotation — ${selectedProject.project_name}`}
                message={`Dear ${projectClientObj().name || 'Customer'}, please find our quotation for ${selectedProject.project_name} attached.`}
              />
            )}
            {canViewProjectFinancials && canManageProjectInvoices && (
              <button onClick={() => { setProformaForm({ date: new Date().toISOString().split('T')[0], notes: '', payment_terms: '' }); setIsProformaModalOpen(true); }} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-teal-50 hover:border-teal-200 text-slate-700 transition-all">
                <Receipt size={16} className="text-teal-600" /> Proforma Invoice
              </button>
            )}
            {canViewProjectFinancials && canManageProjectInvoices && (selectedProject.proforma_invoices || []).length > 0 && (
              <button onClick={() => setIsProformaHistoryOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-100 text-slate-700 transition-all" title="Proforma Invoice History">
                <History size={16} className="text-teal-500" />
                <span className="font-mono text-xs bg-teal-100 text-teal-700 px-1.5 rounded">{(selectedProject.proforma_invoices || []).length}</span>
              </button>
            )}
            
            <div className="h-6 w-px bg-slate-200 mx-2 hidden sm:block"></div>
            <span className="text-xs font-semibold text-slate-500 uppercase mr-2">Challans:</span>
            
            <button onClick={() => openChallanModal('delivery', null)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-blue-50 hover:border-blue-200 text-slate-700 transition-all">
              <FileCheck size={16} className="text-blue-500" /> Delivery
            </button>
            <button onClick={() => openChallanModal('return', null)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-orange-50 hover:border-orange-200 text-slate-700 transition-all">
              <RotateCcw size={16} className="text-orange-500" /> Return
            </button>
            <button onClick={() => setIsChallanHistoryOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-100 text-slate-700 transition-all" title="Challan History">
              <History size={16} className="text-slate-500" /> History
            </button>

            <div className="h-6 w-px bg-slate-200 mx-2 hidden sm:block"></div>
            <span className="text-xs font-semibold text-slate-500 uppercase mr-2">Actions:</span>

            {selectedProject.status === 'Quoted' && canViewProjectFinancials && (role === 'admin' || role === 'manager') && (
              <button onClick={handleShareQuoteForApproval} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-indigo-50 hover:border-indigo-200 text-slate-700 transition-all">
                <Share2 size={16} className="text-indigo-500" /> Share for Approval
              </button>
            )}

            <button onClick={() => { setQuickExpenseForm({ category: 'Travel', amount: '', notes: '', date: new Date().toISOString().split('T')[0] }); setIsQuickExpenseOpen(true); }} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-amber-50 hover:border-amber-200 text-slate-700 transition-all">
              <Zap size={16} className="text-amber-500" /> Log Expense
            </button>
            
            {selectedProject.challan_no && (
              <div className="ml-auto text-xs font-mono text-slate-500 bg-slate-100 px-3 py-1.5 rounded-lg">
                Last Challan: {selectedProject.challan_no}
              </div>
            )}
          </div>
        </div>

        {/* ===== SECTION 5: MAIN CONTENT GRID ===== */}
        <div className="grid gap-6 lg:grid-cols-4">
          
          {/* LEFT COLUMN: Equipment & Logistics */}
          <div className="lg:col-span-3 space-y-6">
            
            {/* Equipment Table */}
            <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                  <Package size={20} className="text-indigo-500" /> Allocated Equipment
                </h3>
                {(role === 'manager' || role === 'admin') && selectedProject.status !== 'Closed' && (
                  <button onClick={openAllocationModal} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors">
                    + Add Item
                  </button>
                )}
              </div>
              
              {(selectedProject.items || []).length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="p-3 rounded-l-lg">Item</th>
                        <th className="p-3 text-center">Qty</th>
                        <th className="p-3 text-center hidden sm:table-cell">Days</th>
                        {canViewProjectFinancials && <th className="p-3 text-right hidden sm:table-cell">Rate</th>}
                        {canViewProjectFinancials && <th className="p-3 text-right hidden sm:table-cell">Amount</th>}
                        {canViewProjectFinancials && <th className="p-3 text-right hidden sm:table-cell">GST Amt</th>}
                        {canViewProjectFinancials && <th className="p-3 text-right">Total</th>}
                        <th className="p-3 rounded-r-lg"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-800">
                      {(selectedProject.items || []).map((item, idx) => (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3">
                            <div className="font-medium text-slate-800">{item.item_name}</div>
                            {item.description && <div className="text-xs text-slate-500 italic mt-0.5">{item.description}</div>}
                            {item.is_external && <span className="text-xs text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded mt-1 inline-block">External</span>}
                          </td>
                          <td className="p-3 text-center font-medium">{item.qty}</td>
                          <td className="p-3 text-center hidden sm:table-cell">{item.days}</td>
                          {canViewProjectFinancials && <td className="p-3 text-right text-slate-600 hidden sm:table-cell">{formatCurrency(item.rate)}</td>}
                          {canViewProjectFinancials && <td className="p-3 text-right text-slate-700 hidden sm:table-cell">{formatCurrency(item.amount || (item.qty * item.rate * item.days))}</td>}
                          {canViewProjectFinancials && <td className="p-3 text-right text-amber-700 hidden sm:table-cell">{formatCurrency(item.gst_amount || ((item.amount || item.qty * item.rate * item.days) * item.gst_rate / 100))}</td>}
                          {canViewProjectFinancials && <td className="p-3 text-right font-semibold text-indigo-700">{formatCurrency(item.total)}</td>}
                          <td className="p-3 text-right">
                            {(role === 'manager' || role === 'admin') && (
                              <div className="flex justify-end gap-1">
                                <button onClick={() => { setEditingItem(item); setIsEditItemModalOpen(true); }} className="p-1.5 rounded hover:bg-blue-50 text-blue-500 hover:text-blue-700 transition-colors">
                                  <Edit size={14} />
                                </button>
                                <button onClick={() => handleRemoveAllocation(item)} className="p-1.5 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {canViewProjectFinancials && (
                      <tfoot className="bg-indigo-50 font-bold text-indigo-700 text-sm">
                        <tr>
                          <td colSpan={2} className="p-3 text-right rounded-l-lg">Equipment Total:</td>
                          <td className="p-3 text-right text-slate-700 hidden sm:table-cell">{formatCurrency(totals.equipment)}</td>
                          <td className="p-3 text-right text-amber-700 hidden sm:table-cell">{formatCurrency((selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0))}</td>
                          <td className="p-3 text-right text-indigo-700 hidden sm:table-cell"></td>
                          <td className="p-3 text-right text-indigo-700">{formatCurrency((selectedProject.items || []).reduce((acc, i) => acc + (i.total || 0), 0))}</td>
                          <td className="rounded-r-lg"></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-slate-400">
                  <Package size={40} className="mx-auto mb-2 opacity-50" />
                  <p>No equipment allocated yet.</p>
                </div>
              )}
            </div>

            {/* Logistics Table */}
            {canViewProjectFinancials && (
              <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
                <h3 className="font-bold text-slate-800 text-lg mb-4 flex items-center gap-2">
                  <Truck size={20} className="text-amber-500" /> Logistics & Services
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="p-3 rounded-l-lg">Cost Type</th>
                        <th className="p-3 w-32">Amount</th>
                        <th className="p-3 w-24">GST %</th>
                        <th className="p-3 text-right rounded-r-lg">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-800">
                      {LOGISTICS_TYPES.map(type => {
                        const record = (selectedProject.logistics_costs || {})[type.id];
                        const split = Array.isArray(record?.lines) ? record.lines : [];
                        const hasSplit = split.length > 0;
                        const summary = sumLogisticsRecord(record || {});
                        const legacy = record || { amount: 0, gst: 18 };
                        return (
                          <React.Fragment key={type.id}>
                            <tr className="hover:bg-slate-50">
                              <td className="p-3 flex items-center gap-2">
                                <span className="text-slate-400">{type.icon}</span>
                                <span className="text-slate-700 font-medium">{type.label}</span>
                                {canEditProjects && (
                                  <button
                                    type="button"
                                    onClick={() => addLogisticsLine(type.id)}
                                    title="Add a split line item"
                                    className="ml-2 text-xs px-2 py-0.5 rounded-full border border-amber-300 text-amber-700 hover:bg-amber-50"
                                  >+ Split</button>
                                )}
                                {hasSplit && (
                                  <span className="ml-2 text-[11px] text-slate-500">{split.length} line{split.length === 1 ? '' : 's'}</span>
                                )}
                              </td>
                              <td className="p-3">
                                {hasSplit ? (
                                  <span className="text-slate-500 italic text-xs">From split lines</span>
                                ) : (
                                  <CommitInput type="number" min="0" className="w-full rounded-lg border border-slate-200 p-2 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400" value={legacy.amount || ''} onCommit={(v) => updateLogisticsCost(type.id, 'amount', v)} disabled={!canEditProjects} />
                                )}
                              </td>
                              <td className="p-3">
                                {hasSplit ? (
                                  <span className="text-slate-400 text-xs">—</span>
                                ) : (
                                  <select className="w-full rounded-lg border border-slate-200 p-2 focus:ring-2 focus:ring-indigo-200" value={legacy.gst} onChange={(e) => updateLogisticsCost(type.id, 'gst', e.target.value)} disabled={!canEditProjects}>
                                    <option value="0">0%</option>
                                    <option value="5">5%</option>
                                    <option value="12">12%</option>
                                    <option value="18">18%</option>
                                    <option value="28">28%</option>
                                  </select>
                                )}
                              </td>
                              <td className="p-3 text-right font-medium text-slate-800">{formatCurrency(hasSplit ? summary.total : (legacy.amount || 0) * (1 + (legacy.gst || 0) / 100))}</td>
                            </tr>
                            {hasSplit && split.map((line) => (
                              <tr key={line.id} className="bg-amber-50/40">
                                <td className="p-2 pl-10">
                                  <CommitInput
                                    type="text"
                                    placeholder="Description"
                                    className="w-full rounded-lg border border-slate-200 p-1.5 text-xs"
                                    value={line.description || ''}
                                    onCommit={(v) => updateLogisticsLine(type.id, line.id, 'description', v)}
                                    disabled={!canEditProjects}
                                  />
                                </td>
                                <td className="p-2">
                                  <CommitInput
                                    type="number"
                                    min="0"
                                    className="w-full rounded-lg border border-slate-200 p-1.5 text-xs"
                                    value={line.amount || ''}
                                    onCommit={(v) => updateLogisticsLine(type.id, line.id, 'amount', v)}
                                    disabled={!canEditProjects}
                                  />
                                </td>
                                <td className="p-2">
                                  <select
                                    className="w-full rounded-lg border border-slate-200 p-1.5 text-xs"
                                    value={line.gst || 0}
                                    onChange={(e) => updateLogisticsLine(type.id, line.id, 'gst', e.target.value)}
                                    disabled={!canEditProjects}
                                  >
                                    <option value="0">0%</option>
                                    <option value="5">5%</option>
                                    <option value="12">12%</option>
                                    <option value="18">18%</option>
                                    <option value="28">28%</option>
                                  </select>
                                </td>
                                <td className="p-2 text-right text-xs">
                                  <span className="font-medium text-slate-700 mr-2">
                                    {formatCurrency((parseFloat(line.amount || 0)) * (1 + (parseFloat(line.gst || 0)) / 100))}
                                  </span>
                                  {canEditProjects && (
                                    <button
                                      type="button"
                                      onClick={() => removeLogisticsLine(type.id, line.id)}
                                      title="Remove line"
                                      className="text-red-500 hover:text-red-700 px-1"
                                    >×</button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-amber-50 font-bold text-amber-700 border-t">
                      <tr>
                        <td colSpan={3} className="p-3 text-right rounded-l-lg">Logistics Total:</td>
                        <td className="p-3 text-right rounded-r-lg">{formatCurrency(totals.logistics)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* LED Walls Summary (if any) */}
            {((selectedProject.items || []).filter(i => i.led)).length > 0 && (
              <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
                <h3 className="font-bold text-slate-800 text-lg mb-4 flex items-center gap-2">
                  <Monitor size={20} className="text-purple-500" /> LED Wall Specifications
                </h3>
                <div className="grid gap-4 md:grid-cols-2">
                  {(selectedProject.items || []).filter(i => i.led).map((li, idx) => {
                    const s = li.led?.specs;
                    if (!s) return null;
                    const ftFactor = 3.28084;
                    return (
                      <div key={idx} className="p-4 border border-purple-100 rounded-xl bg-purple-50/50">
                        <div className="font-bold text-slate-800 mb-2">{li.item_name}</div>
                        <div className="text-sm text-purple-700 font-medium mb-2">{li.led.tilesWide} × {li.led.tilesHigh} tiles</div>
                        <div className="space-y-1 text-xs text-slate-600">
                          <div className="flex justify-between"><span>Size:</span><span>{s.physicalDimensions.totalWidthM}m × {s.physicalDimensions.totalHeightM}m ({(s.physicalDimensions.totalWidthM * ftFactor).toFixed(1)}ft × {(s.physicalDimensions.totalHeightM * ftFactor).toFixed(1)}ft)</span></div>
                          <div className="flex justify-between"><span>Resolution:</span><span>{s.resolution.totalPixelWidth} × {s.resolution.totalPixelHeight} px</span></div>
                          <div className="flex justify-between"><span>Total Tiles:</span><span>{s.logistics.totalTilesNeeded}</span></div>
                          <div className="flex justify-between"><span>Weight:</span><span>{s.physicalDimensions.totalWeightKg} kg</span></div>
                          <div className="flex justify-between"><span>Power:</span><span>{s.power.maxPowerWatts}W max / {s.power.avgPowerWatts}W avg</span></div>
                        </div>
                        {(() => {
                          const portCalc = calculateLEDSignalPorts(s.resolution.totalPixelWidth, s.resolution.totalPixelHeight);
                          if (!portCalc) return null;
                          return (
                            <div className="border-t border-purple-200 mt-3 pt-2">
                              <div className="text-xs font-semibold text-purple-700 mb-1">Signal Ports</div>
                              <div className="text-xs text-slate-600">Primary: {portCalc.primaryPorts} | Backup: {portCalc.backupPorts} | Total: {portCalc.totalPortsWithBackup}</div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT COLUMN: Team, Expenses, Invoice, Summary */}
          <div className="space-y-6">
            
            {/* Team Card */}
            <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  <Users size={18} className="text-blue-500" /> Assigned Team
                </h3>
                {(role === 'admin' || role === 'manager') && (
                  <button
                    onClick={() => setIsEmpModalOpen(true)}
                    className="inline-flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
                  >
                    Manage Team
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {(selectedProject.assigned_employees || []).length > 0 ? (
                  (selectedProject.assigned_employees || []).map(empId => {
                    const emp = employees.find(e => e.id === empId);
                    return (
                      <div key={empId} className="flex items-center gap-2 rounded-full bg-blue-50 border border-blue-100 px-3 py-1.5 text-sm">
                        <div className="relative h-6 w-6 rounded-full bg-blue-200 flex items-center justify-center text-xs font-bold text-blue-700">
                          {emp?.name?.charAt(0) || '?'}
                          {liveLocations[empId] && <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-blue-50 ${isLocationLive(liveLocations[empId]) ? 'bg-emerald-500' : 'bg-slate-300'}`} />}
                        </div>
                        <span className="text-slate-700 font-medium">{emp?.name || 'Unknown'}</span>
                        {can(role, 'tracking', 'view') && typeof selectedProject.site_lat === 'number' && typeof liveLocations[empId]?.lat === 'number' && (() => {
                          const d = getDistance(selectedProject.site_lat, selectedProject.site_lng, liveLocations[empId].lat, liveLocations[empId].lng);
                          const onSite = d <= 200;
                          return <span className={`text-[11px] font-semibold ${onSite ? 'text-emerald-600' : 'text-amber-600'}`}>{onSite ? 'On site' : `${fmtSiteDistance(d)} away`}</span>;
                        })()}
                        {can(role, 'tracking', 'view') && liveLocations[empId] && (
                          <button onClick={() => navigate(`/tracking?emp=${empId}`)} title="Locate on map" className="text-indigo-500 hover:text-indigo-700"><MapPin size={14} /></button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-sm text-slate-400 italic py-2">No team members assigned.</div>
                )}
              </div>
            </div>

            {/* Work Attending Report Card */}
            {(() => {
              const projLogs = timeLogs.filter(l => l.project_id === selectedProject.id);
              if (projLogs.length === 0) return null;
              return (
                <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
                  <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                    <Clock size={18} className="text-indigo-500" /> Work Attending Report
                  </h3>
                  <div className="text-xs text-slate-500 mb-3">{projLogs.length} site visit(s) recorded</div>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {projLogs.sort((a, b) => new Date(b.checkIn || 0) - new Date(a.checkIn || 0)).map(log => {
                      const emp = employees.find(e => e.id === log.employeeId);
                      const hrs = log.checkIn && log.checkOut ? ((new Date(log.checkOut) - new Date(log.checkIn)) / 3600000).toFixed(1) : null;
                      return (
                        <div key={log.id} className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 text-sm">
                          <div className="flex justify-between items-start">
                            <span className="font-medium text-slate-800">{emp?.name || 'Unknown'}</span>
                            <span className="text-xs text-slate-500">{log.checkIn ? new Date(log.checkIn).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-'}</span>
                          </div>
                          <div className="text-xs text-slate-600 mt-1">
                            In: {log.checkIn ? new Date(log.checkIn).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}
                            {log.checkOut ? ` — Out: ${new Date(log.checkOut).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ' (Active)'}
                            {hrs && <span className="ml-2 font-medium text-indigo-700">({hrs}h)</span>}
                          </div>
                          {log.gpsCheckIn && <div className="text-xs text-slate-400 mt-0.5">📍 {log.gpsCheckIn.lat?.toFixed(4)}, {log.gpsCheckIn.lng?.toFixed(4)}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Expenses Card */}
            <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                <Receipt size={18} className="text-red-500" /> {canViewProjectFinancials ? 'Project Expenses' : 'My Expenses'}
              </h3>
              <div className="text-3xl font-bold text-red-600">
                {formatCurrency(visibleProjectExpenseTotal)}
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {visibleProjectExpenses.length} expense(s) recorded
              </div>
            </div>

            {/* Invoice Card — owner-scoped: a non-owner manager must not see another
                manager's client invoice no./amounts or print their Tax Invoice PDF. */}
            {canViewProjectFinancials && canManageProjectInvoices && (
              <div className={`rounded-xl p-6 shadow-sm border transition-colors ${isProjectInvoiced(selectedProject.invoice_status) ? 'bg-green-50 border-green-200' : 'bg-white border-slate-100'}`}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <FileText size={18} className="text-green-600" /> Invoice
                  </h3>
                  <div className={`text-xs px-2 py-1 rounded-full font-medium ${isProjectInvoiced(selectedProject.invoice_status) ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
                    {selectedProject.invoice_status || 'Not Invoiced'}
                  </div>
                </div>

                {isProjectInvoiced(selectedProject.invoice_status) ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 text-xs uppercase font-semibold">Invoice No.</span>
                      <span className="font-bold text-slate-800 font-mono">{selectedProject.invoice_no}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 text-xs uppercase font-semibold">Date</span>
                      <span className="font-medium text-slate-700">{fmtDate(selectedProject.invoice_date)}</span>
                    </div>
                    {selectedProject.invoice_due_date && (
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 text-xs uppercase font-semibold">Due Date</span>
                        <span className={`font-medium ${new Date(selectedProject.invoice_due_date) < new Date() ? 'text-red-600' : 'text-orange-600'}`}>
                          {fmtDate(selectedProject.invoice_due_date)}
                        </span>
                      </div>
                    )}
                    {selectedProject.invoice_label && selectedProject.invoice_label !== 'Invoice' && (
                      <div className="bg-purple-50 border border-purple-200 rounded px-2 py-1 text-xs font-semibold text-purple-700">
                        {selectedProject.invoice_label}
                      </div>
                    )}
                    {selectedProject.invoice_remarks && (
                      <div className="bg-slate-50 border border-slate-200 rounded p-2 text-xs text-slate-600 italic">
                        &ldquo;{selectedProject.invoice_remarks}&rdquo;
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => navigate('/tax-invoices')} className="flex-1 flex items-center justify-center gap-1 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 py-2 text-xs font-semibold transition">
                        <Edit size={13} /> Manage in Tax Invoices
                      </button>
                      <button onClick={generateTaxInvoicePDF} className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-blue-700 hover:bg-blue-800 text-white py-2 text-xs font-semibold transition">
                        <FileText size={13} /> Tax Invoice PDF
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {!isInvoicingEnabled && (
                      <div className="text-xs text-orange-600 flex items-center gap-1 font-medium bg-orange-50 px-3 py-2 rounded-lg">
                        <AlertCircle size={12} /> Complete project to invoice
                      </div>
                    )}
                    {isInvoicingEnabled && (
                      <button onClick={() => navigate('/tax-invoices')} className="w-full flex items-center justify-center gap-2 rounded-lg bg-green-600 hover:bg-green-700 text-white py-2.5 text-sm font-semibold transition">
                        <FileText size={15} /> Create Tax Invoice
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Financial Summary Card */}
            {canViewProjectFinancials && (
              <div className="rounded-xl bg-gradient-to-br from-indigo-50 to-blue-50 p-6 shadow-sm border border-indigo-100">
                <h3 className="font-bold text-slate-800 text-lg mb-4 flex items-center gap-2">
                  <Calculator size={18} className="text-indigo-600" /> Summary
                </h3>
                <div className="space-y-3 text-sm">
                  {totals.use_package_cost ? (
                    <>
                      <div className="flex justify-between"><span className="text-slate-600">Package Cost</span><span className="font-medium text-slate-600">{formatCurrency(totals.equipment)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-600">GST <span className="text-[10px] text-slate-400">(rate-wise)</span></span><span className="font-medium text-green-600">+{formatCurrency(totals.gst_output)}</span></div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between"><span className="text-slate-600">Equipment</span><span className="font-semibold text-slate-900">{formatCurrency(totals.equipment)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-600">Logistics</span><span className="font-semibold text-slate-900">{formatCurrency(totals.logistics)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-600">GST Output</span><span className="font-medium text-green-600">+{formatCurrency(totals.gst_output)}</span></div>
                    </>
                  )}
                  <div className="border-t border-indigo-200 pt-3 flex justify-between text-lg font-bold text-indigo-700">
                    <span>Grand Total</span>
                    <span>{formatCurrency(totals.total_revenue)}</span>
                  </div>
                  {(() => {
                    const g = getProjectSalesGST(selectedProject);
                    if (!g) return null;
                    const t = g.totals;
                    return (
                      <div className="border-t border-indigo-200 pt-3 mt-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">GST Split (Sales)</span>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${g.supplyType === 'IGST' ? 'bg-orange-100 text-orange-700' : 'bg-emerald-100 text-emerald-700'}`}>{gstSplitLabel(g.supplyType)}</span>
                        </div>
                        <div className="flex justify-between text-xs text-slate-600"><span>Place of Supply</span><span className="font-medium">{stateName(g.placeOfSupply)}</span></div>
                        <div className="flex justify-between text-xs text-slate-600"><span>Taxable</span><span className="font-medium">{formatCurrency(t.taxable)}</span></div>
                        {g.supplyType === 'IGST' ? (
                          <div className="flex justify-between text-xs text-slate-600"><span>IGST</span><span className="font-medium">{formatCurrency(t.igstAmt)}</span></div>
                        ) : (
                          <>
                            <div className="flex justify-between text-xs text-slate-600"><span>CGST</span><span className="font-medium">{formatCurrency(t.cgstAmt)}</span></div>
                            <div className="flex justify-between text-xs text-slate-600"><span>SGST</span><span className="font-medium">{formatCurrency(t.sgstAmt)}</span></div>
                          </>
                        )}
                        {!g.clientGstin && <div className="text-[10px] text-amber-600 mt-1">Client GSTIN missing — defaulted to intra-state. Add the client's GSTIN for an accurate split.</div>}
                      </div>
                    );
                  })()}
                  {(() => {
                    const inp = getProjectInputGST(selectedProject);
                    if (!inp) return null;
                    const t = inp.totals;
                    return (
                      <div className="border-t border-indigo-200 pt-3 mt-1">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Input GST (Outsourcing)</span>
                        <div className="mt-1 space-y-0.5">
                          {inp.vendors.map((v, i) => (
                            <div key={i} className="flex justify-between text-xs text-slate-600">
                              <span className="truncate max-w-[60%]">{v.name} <span className={`text-[9px] font-semibold ${v.supplyType === 'IGST' ? 'text-orange-600' : 'text-emerald-600'}`}>{v.supplyType === 'IGST' ? 'IGST' : 'C+S'}</span></span>
                              <span className="font-medium">{formatCurrency(v.gst)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex justify-between text-xs text-slate-700 mt-1 pt-1 border-t border-indigo-100">
                          <span className="font-semibold">Total Input GST</span>
                          <span className="font-semibold">{formatCurrency(t.gst)}{t.igst > 0 && (t.cgst > 0 || t.sgst > 0) ? '' : ''}</span>
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400">
                          <span>CGST {formatCurrency(t.cgst)} · SGST {formatCurrency(t.sgst)} · IGST {formatCurrency(t.igst)}</span>
                        </div>
                      </div>
                    );
                  })()}
                  {totals.reimbursable > 0 && (
                    <>
                      <div className="flex justify-between pt-1">
                        <span className="text-slate-600 text-xs">+ Client Reimbursable (As Actual)</span>
                        <span className="font-semibold text-teal-700">{formatCurrency(totals.reimbursable)}</span>
                      </div>
                      <div className="border-t border-teal-200 pt-2 mt-2 flex justify-between text-base font-bold text-teal-800">
                        <span>Total Client Payable</span>
                        <span>{formatCurrency(totals.total_client_payable)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== SECTION 6: PROFIT & LOSS BREAKDOWN (Full Width) ===== */}
        {canViewProjectFinancials && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
            <h3 className="mb-6 font-bold text-slate-800 text-lg flex items-center gap-2">
              <TrendingUp size={20} className="text-green-600" /> Profit & Loss Analysis
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 text-sm">
              {/* Revenue Column */}
              <div className="space-y-3 p-4 rounded-xl bg-green-50 border border-green-100">
                <div className="font-bold text-green-700 border-b border-green-200 pb-2 flex items-center gap-2">
                  <ArrowUpRight size={16} /> REVENUE
                </div>
                {totals.use_package_cost ? (
                  <>
                    <div className="flex justify-between text-xs text-slate-600"><span>Package Cost</span><span className="font-medium text-slate-600">{formatCurrency(totals.equipment)}</span></div>
                    <div className="flex justify-between text-xs text-slate-600"><span>Output GST</span><span className="font-medium text-slate-600">+{formatCurrency(totals.gst_output)}</span></div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between text-xs text-slate-600"><span>Equipment</span><span className="font-semibold text-slate-900">{formatCurrency(totals.equipment)}</span></div>
                    <div className="flex justify-between text-xs text-slate-600"><span>Logistics</span><span className="font-semibold text-slate-900">{formatCurrency(totals.logistics)}</span></div>
                    <div className="flex justify-between text-xs text-slate-600"><span>Output GST</span><span className="font-medium text-slate-600">+{formatCurrency(totals.gst_output)}</span></div>
                  </>
                )}
                {totals.reimbursable > 0 && (
                  <div className="flex justify-between text-xs text-slate-600"><span>Client Reimbursable</span><span className="font-medium text-teal-600">+{formatCurrency(totals.reimbursable)}</span></div>
                )}
                <div className="flex justify-between font-bold text-green-700 border-t border-green-200 pt-2">
                  <span>Total</span>
                  <span>{formatCurrency(totalRevenue + totals.reimbursable)}</span>
                </div>
              </div>

              {/* Costs Column */}
              <div className="space-y-3 p-4 rounded-xl bg-red-50 border border-red-100">
                <div className="font-bold text-red-700 border-b border-red-200 pb-2 flex items-center gap-2">
                  <ArrowDownRight size={16} /> COSTS
                </div>
                <div className="flex justify-between text-xs text-slate-600"><span>Outsourcing</span><span className="font-medium text-slate-600">-{formatCurrency(totals.outsourcing)}</span></div>
                <div className="flex justify-between text-xs text-slate-600"><span>Direct Expenses</span><span className="font-medium text-slate-600">-{formatCurrency(totals.direct_expense)}</span></div>
                <div className="flex justify-between text-xs text-slate-600"><span>Input GST</span><span className="font-medium text-slate-600">-{formatCurrency(totals.gst_input)}</span></div>
                {totals.reimbursable > 0 && (
                  <div className="flex justify-between text-xs text-slate-600"><span>Reimbursable (Pass-through)</span><span className="font-medium text-teal-600">-{formatCurrency(totals.reimbursable)}</span></div>
                )}
                <div className="flex justify-between font-bold text-red-700 border-t border-red-200 pt-2">
                  <span>Total</span>
                  <span>-{formatCurrency(totalCost + totals.reimbursable)}</span>
                </div>
              </div>

              {/* GST Column */}
              <div className="space-y-3 p-4 rounded-xl bg-amber-50 border border-amber-100">
                <div className="font-bold text-amber-700 border-b border-amber-200 pb-2 flex items-center gap-2">
                  <Percent size={16} /> GST PAYABLE
                </div>
                <div className="flex justify-between text-xs text-slate-600"><span>Output GST</span><span className="font-medium text-green-600">+{formatCurrency(totals.gst_output)}</span></div>
                <div className="flex justify-between text-xs text-slate-600"><span>Input GST</span><span className="font-medium text-red-600">-{formatCurrency(totals.gst_input)}</span></div>
                <div className="flex justify-between text-slate-600 font-bold border-t border-amber-200 pt-2">
                  <span>Net Payable</span>
                  <span className={totals.gst_payable >= 0 ? 'text-red-600' : 'text-green-600'}>{formatCurrency(totals.gst_payable)}</span>
                </div>
              </div>

              {/* Margin Column */}
              <div className={`p-4 rounded-xl flex flex-col justify-center text-center border-2 ${margin >= 0 ? 'bg-gradient-to-br from-green-50 to-emerald-50 border-green-200' : 'bg-gradient-to-br from-red-50 to-rose-50 border-red-200'}`}>
                <div className="text-xs font-bold text-slate-600 uppercase mb-2">Gross Margin</div>
                <div className={`text-2xl font-bold ${margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(margin)}
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  {totalRevenue > 0 ? `${((margin / totalRevenue) * 100).toFixed(1)}% margin` : '—'}
                </div>
              </div>
            </div>
          </div>
        )}
        {canViewProjectFinancials && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                <ClipboardList size={20} className="text-indigo-600" /> Final Project Report
              </h3>
              <div className="flex items-center gap-2">
                <button onClick={generateFinalReportPDF} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                  Export PDF
                </button>
                <button onClick={generateManagementReportPDF} className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 font-medium hover:bg-indigo-100">
                  Management Report
                </button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-700 mb-3">Cost Centers</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-slate-500">Equipment</span><span className="font-medium text-slate-800">{formatCurrency(totals.equipment)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Logistics</span><span className="font-medium text-slate-800">{formatCurrency(totals.logistics)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Outsourcing</span><span className="font-medium text-slate-800">{formatCurrency(totals.outsourcing)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Direct Expenses</span><span className="font-medium text-slate-800">{formatCurrency(totals.direct_expense)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">GST Output</span><span className="font-medium text-green-600">+{formatCurrency(totals.gst_output)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">GST Input</span><span className="font-medium text-red-600">-{formatCurrency(totals.gst_input)}</span></div>
                  {totals.reimbursable > 0 && (
                    <div className="flex justify-between"><span className="text-slate-500">Client Reimbursable</span><span className="font-medium text-teal-600">{formatCurrency(totals.reimbursable)}</span></div>
                  )}
                  <div className="border-t pt-2 flex justify-between font-semibold text-slate-800">
                    <span>Profit / Loss</span>
                    <span className={margin >= 0 ? 'text-green-600' : 'text-red-600'}>{formatCurrency(margin)}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-700 mb-3">P&L Pie Chart</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height={192} minWidth={0}>
                    <PieChart>
                      <Pie data={pnlPieData} dataKey="value" nameKey="name" innerRadius={40} outerRadius={70} paddingAngle={2}>
                        {pnlPieData.map((entry, index) => (
                          <Cell key={`${entry.name}-${index}`} fill={pnlPieColors[index % pnlPieColors.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(val) => formatCurrency(val)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-xs text-slate-500 mt-2">Profit/Loss uses absolute value for charting.</div>
              </div>
            </div>

            <div className="mt-6 space-y-6">
              <div>
                <div className="text-sm font-semibold text-slate-700 mb-2">Outsourcing Details</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="p-2">Vendor</th>
                        <th className="p-2">Item</th>
                        <th className="p-2 text-center">Qty</th>
                        <th className="p-2 text-center">Days</th>
                        <th className="p-2 text-right">Base</th>
                        <th className="p-2 text-right">GST %</th>
                        <th className="p-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-800">
                      {outsourcingRows.length === 0 ? (
                        <tr><td colSpan={7} className="p-3 text-center text-slate-400">No outsourcing records.</td></tr>
                      ) : outsourcingRows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="p-2 text-slate-700">{row.vendor}</td>
                          <td className="p-2 text-slate-700">{row.item}</td>
                          <td className="p-2 text-center">{row.qty}</td>
                          <td className="p-2 text-center">{row.days}</td>
                          <td className="p-2 text-right">{formatCurrency(row.base)}</td>
                          <td className="p-2 text-right">{row.gstRate}%</td>
                          <td className="p-2 text-right font-medium">{formatCurrency(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold text-slate-700 mb-2">Expenses by Date</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="p-2">Date</th>
                        <th className="p-2">Employee</th>
                        <th className="p-2">Category</th>
                        <th className="p-2 text-right">Amount</th>
                        <th className="p-2">Remarks</th>
                        <th className="p-2 text-center">Proof</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-800">
                      {expenseDateRows.length === 0 ? (
                        <tr><td colSpan={6} className="p-3 text-center text-slate-400">No expenses submitted.</td></tr>
                      ) : expenseDateRows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="p-2">{row.date ? new Date(row.date).toLocaleDateString('en-IN') : '-'}</td>
                          <td className="p-2">{row.employee}</td>
                          <td className="p-2">{row.category}</td>
                          <td className="p-2 text-right">{formatCurrency(row.amount)}</td>
                          <td className="p-2 text-slate-500">{row.remarks || '-'}</td>
                          <td className="p-2 text-center">{row.proof_url ? <a href={row.proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">{row.proof_url.toLowerCase().includes('.pdf') ? <FileText size={11} /> : <ImageIcon size={11} />} View</a> : <span className="text-xs text-slate-300">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold text-slate-700 mb-2">Expense Totals by Employee and Category</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="p-2">Employee</th>
                        <th className="p-2">Category</th>
                        <th className="p-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-800">
                      {expenseByEmployeeCategory.length === 0 ? (
                        <tr><td colSpan={3} className="p-3 text-center text-slate-400">No expense totals.</td></tr>
                      ) : expenseByEmployeeCategory.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="p-2">{row.employee}</td>
                          <td className="p-2">{row.category}</td>
                          <td className="p-2 text-right font-medium">{formatCurrency(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ===== REIMBURSABLE EXPENSES (Client Actuals) ===== */}
        {canViewProjectFinancials && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-teal-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                <Receipt size={20} className="text-teal-600" /> Client Reimbursable Expenses
                <span className="text-xs font-normal text-slate-400 ml-1">(As Actual)</span>
              </h3>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {can(role, 'projects', 'edit') && (
                  <button
                    onClick={toggleShareExpenseDetails}
                    title="When ON, this project's actual expenses + reimbursables (with proofs) show on the client's ledger link"
                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition ${selectedProject.share_expense_details ? 'border-teal-600 bg-teal-600 text-white hover:bg-teal-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                  >
                    <Eye size={14} /> {selectedProject.share_expense_details ? 'Visible on ledger link' : 'Show on ledger link'}
                  </button>
                )}
                {(selectedProject.reimbursable_expenses || []).length > 0 && (
                  <button onClick={handleShareReimbursable} className="flex items-center gap-1.5 rounded-lg border border-teal-200 px-3 py-1.5 text-sm text-teal-700 hover:bg-teal-50 transition">
                    <Share2 size={14} /> Share with Client
                  </button>
                )}
                {can(role, 'projects', 'edit') && (
                  <button onClick={() => { setReimbursableForm({ description: '', category: 'Travel', amount: '', date: new Date().toISOString().split('T')[0], remarks: '' }); setReimbursableProofFile(null); setEditingReimbursableIdx(null); setIsReimbursableOpen(true); }} className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm text-white hover:bg-teal-700 transition">
                    <Plus size={14} /> Add Expense
                  </button>
                )}
              </div>
            </div>
            {(selectedProject.reimbursable_expenses || []).length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">No reimbursable expenses recorded. These are expenses the client has agreed to pay at actuals.</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-teal-50 text-teal-700 text-xs uppercase">
                      <tr>
                        <th className="p-2">Date</th>
                        <th className="p-2">Description</th>
                        <th className="p-2">Category</th>
                        <th className="p-2 text-right">Amount</th>
                        <th className="p-2 text-center">Proof</th>
                        <th className="p-2">Remarks</th>
                        {can(role, 'projects', 'edit') && <th className="p-2 text-center">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-800">
                      {(selectedProject.reimbursable_expenses || []).map((exp, idx) => (
                        <tr key={exp.id || idx} className="hover:bg-slate-50">
                          <td className="p-2 whitespace-nowrap">{exp.date ? new Date(exp.date).toLocaleDateString('en-IN') : '-'}</td>
                          <td className="p-2 font-medium">{exp.description}</td>
                          <td className="p-2"><span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{exp.category}</span></td>
                          <td className="p-2 text-right font-semibold">{formatCurrency(exp.amount)}</td>
                          <td className="p-2 text-center">{exp.proof_url ? <a href={exp.proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-teal-700 bg-teal-50 px-2 py-0.5 rounded border border-teal-100 hover:bg-teal-100">{exp.proof_url.toLowerCase().includes('.pdf') ? <FileText size={11} /> : <ImageIcon size={11} />} View</a> : <span className="text-xs text-slate-300">—</span>}</td>
                          <td className="p-2 text-slate-500 text-xs">{exp.remarks || '-'}</td>
                          {can(role, 'projects', 'edit') && (
                            <td className="p-2 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={() => { setReimbursableForm({ description: exp.description, category: exp.category, amount: exp.amount, date: exp.date, remarks: exp.remarks || '' }); setReimbursableProofFile(exp.proof_url ? { url: exp.proof_url, name: exp.proof_name || 'proof', path: exp.proof_path || '' } : null); setEditingReimbursableIdx(idx); setIsReimbursableOpen(true); }} className="p-1 text-slate-400 hover:text-indigo-600"><Edit size={14} /></button>
                                <button onClick={() => handleDeleteReimbursable(idx)} className="p-1 text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-teal-50 font-semibold">
                      <tr>
                        <td colSpan={3} className="p-2 text-right text-teal-800">Total Reimbursable</td>
                        <td className="p-2 text-right text-teal-800 text-lg">{formatCurrency(reimbursableTotal)}</td>
                        <td colSpan={can(role, 'projects', 'edit') ? 3 : 2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        <EditItemAllocationModal
          isOpen={isEditItemModalOpen}
          onClose={() => setIsEditItemModalOpen(false)}
          item={editingItem}
          onSave={handleUpdateItemAllocation}
        />
        <Modal isOpen={isChallanModalOpen} onClose={() => setIsChallanModalOpen(false)} title={`${editingChallan ? 'Edit' : 'Generate'} ${challanType === 'return' ? 'Return' : 'Delivery'} Challan`}>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
              <div className="bg-blue-50 p-3 rounded text-xs text-blue-700">Enter transport details to be printed on the official {challanType} challan.</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className="text-xs font-bold text-slate-500">Transport Mode</label><select className="w-full rounded border p-2 text-slate-800" value={challanForm.mode} onChange={e => setChallanForm({ ...challanForm, mode: e.target.value })}><option>Road</option><option>Air</option><option>Train</option><option>Hand Carry</option></select></div>
                <div><label className="text-xs font-bold text-slate-500">Vehicle No</label><input className="w-full rounded border p-2 text-slate-800" value={challanForm.vehicle_no} onChange={e => setChallanForm({ ...challanForm, vehicle_no: e.target.value })} placeholder="MH-01-AB-1234" /></div>
                <div><label className="text-xs font-bold text-slate-500">Driver Name</label><input className="w-full rounded border p-2 text-slate-800" value={challanForm.driver_name} onChange={e => setChallanForm({ ...challanForm, driver_name: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-500">Driver Mobile</label><input className="w-full rounded border p-2 text-slate-800" value={challanForm.driver_mobile} onChange={e => setChallanForm({ ...challanForm, driver_mobile: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-500">E-Way Bill No</label><input className="w-full rounded border p-2 text-slate-800" value={challanForm.eway_bill} onChange={e => setChallanForm({ ...challanForm, eway_bill: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-500">Dispatch Address</label><input className="w-full rounded border p-2 text-slate-800" value={challanForm.dispatch_address} onChange={e => setChallanForm({ ...challanForm, dispatch_address: e.target.value })} placeholder="Leave empty for Venue" /></div>
                <div><label className="text-xs font-bold text-slate-500">Challan Date</label><input type="date" className="w-full rounded border p-2" value={challanForm.date} onChange={e => setChallanForm({ ...challanForm, date: e.target.value })} /></div>
              </div>
              
              <div className="border-t pt-4">
                <h4 className="text-sm font-bold text-slate-700 mb-2">Select Items to Include</h4>
                <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs text-left text-slate-600">
                        <thead className="bg-slate-50 text-slate-500"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Total</th><th className="p-2 text-center">{challanType === 'delivery' ? 'Sent' : 'Returned'}</th><th className="p-2 text-center">Avail</th><th className="p-2 w-20">Current</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                            {(selectedProject.items || []).map(item => {
                                const excludeId = editingChallan ? editingChallan.id : null;
                                const alreadyChallaned = getChallanedQty(item.id, challanType, excludeId);
                                let maxQty = 0;
                                if (challanType === 'delivery') maxQty = item.qty - alreadyChallaned;
                                else {
                                    const delivered = getChallanedQty(item.id, 'delivery');
                                    const returned = getChallanedQty(item.id, 'return', excludeId);
                                    maxQty = delivered - returned;
                                }
                                return (
                                    <tr key={item.id} className={challanSelection[item.id] > 0 ? 'bg-indigo-50' : ''}>
                                        <td className="p-2"><input type="checkbox" checked={challanSelection[item.id] > 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: e.target.checked ? maxQty : 0})} disabled={maxQty <= 0 && !challanSelection[item.id]} /></td>
                                        <td className="p-2">{item.item_name}</td>
                                        <td className="p-2 text-center">{item.qty}</td>
                                        <td className="p-2 text-center">{alreadyChallaned}</td>
                                        <td className="p-2 text-center font-bold">{maxQty}</td>
                                        <td className="p-2"><input type="number" min="0" max={maxQty} className="w-full border rounded p-1" value={challanSelection[item.id] || 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: parseInt(e.target.value) || 0})} /></td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={downloadEWayBillJSON} className="flex-1 rounded border border-indigo-600 text-indigo-600 py-2 font-bold hover:bg-indigo-50">Export E-Way JSON</button>
                <button onClick={() => {
                    const tempChallan = {
                        ...editingChallan,
                        challan_no: editingChallan ? editingChallan.challan_no : 'DRAFT',
                        type: challanType,
                        date: challanForm.date,
                        transport: challanForm,
                        items: (selectedProject.items || []).filter(item => (challanSelection[item.id] || 0) > 0).map(item => ({...item, qty: parseInt(challanSelection[item.id])}))
                    };
                    printChallanPDF(tempChallan);
                }} className="flex-1 rounded border border-slate-200 text-slate-700 py-2 font-bold hover:bg-slate-50">Preview / Print</button>
                <button onClick={handleSaveChallan} className="flex-1 rounded bg-indigo-600 py-2 text-white font-bold hover:bg-indigo-700">{editingChallan ? 'Update Challan' : 'Generate Challan'}</button>
              </div>
            </div>
        </Modal>
        <Modal isOpen={isChallanHistoryOpen} onClose={() => setIsChallanHistoryOpen(false)} title="Challan History">
            <div className="space-y-2">
                {(selectedProject.challans || []).length === 0 ? <div className="text-center text-slate-400 p-4">No challans generated yet.</div> : 
                (selectedProject.challans || []).sort((a,b) => new Date(b.date) - new Date(a.date)).map((c, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 border rounded hover:bg-slate-50">
                        <div>
                            <div className="font-bold text-slate-800">{c.type === 'return' ? 'Return' : 'Delivery'} Challan #{c.challan_no}</div>
                            <div className="text-xs text-slate-500">{new Date(c.date).toLocaleString()} | {c.items?.length || 0} items</div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            <button onClick={() => printChallanPDF(c)} className="text-indigo-600 hover:underline text-xs font-medium border border-indigo-200 px-2 py-1 rounded">Reprint</button>
                            <button onClick={() => openChallanModal(c.type, c)} className="text-blue-600 hover:underline text-xs font-medium border border-blue-200 px-2 py-1 rounded">Edit</button>
                            <button onClick={() => handleDeleteChallan(c)} className="text-red-600 hover:underline text-xs font-medium border border-red-200 px-2 py-1 rounded">Delete</button>
                            {(() => {
                              const clientPhone = clients.find(cl => cl.id === selectedProject.client_id)?.contacts?.[0]?.phone;
                              if (!clientPhone) return null;
                              const phone = clientPhone.replace(/\D/g, '');
                              const waPhone = phone.startsWith('91') ? phone : `91${phone}`;
                              const msg = `Dear Team,\n\n${c.type === 'return' ? 'Return' : 'Delivery'} Challan #${c.challan_no} for project "${selectedProject.project_name}" has been generated on ${new Date(c.date).toLocaleDateString('en-IN')}.\n\nItems: ${c.items?.length || 0} unit(s) dispatched.\n\nPlease acknowledge receipt.\n\n- RentalOps`;
                              return (
                                <a href={`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:underline text-xs font-medium border border-green-200 px-2 py-1 rounded flex items-center gap-1">
                                  <MessageCircle size={11} /> WhatsApp
                                </a>
                              );
                            })()}
                        </div>
                    </div>
                ))}
            </div>
        </Modal>

        {canViewProjectFinancials && canManageProjectInvoices && (
          <>
            {/* ===== PROFORMA INVOICE MODALS ===== */}
            {/* Create Proforma Invoice */}
            <Modal isOpen={isProformaModalOpen} onClose={() => setIsProformaModalOpen(false)} title="Create Proforma Invoice">
          <div className="space-y-4">
            <div className="bg-teal-50 border border-teal-200 rounded p-3 text-xs text-teal-800">
              A new Proforma Invoice will be auto-numbered (<span className="font-mono font-semibold">PI/FY/XXXX</span>) and a snapshot of current items will be saved.
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-bold text-slate-700">Issue Date</label>
                <input type="date" className="w-full rounded border p-2 text-slate-800" value={proformaForm.date} onChange={e => setProformaForm({...proformaForm, date: e.target.value})} />
              </div>
              <div className="flex items-end">
                <div className="bg-slate-50 rounded p-2 text-sm w-full">
                  <div className="text-xs text-slate-500">Grand Total</div>
                  <div className="font-bold text-indigo-700 text-lg">{formatCurrency(totals?.total_revenue || 0)}</div>
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-bold text-slate-700">Payment Terms <span className="text-slate-400 font-normal text-xs">(overrides admin default)</span></label>
              <textarea className="w-full rounded border p-2 text-slate-800 text-sm" rows={3} value={proformaForm.payment_terms} onChange={e => setProformaForm({...proformaForm, payment_terms: e.target.value})} placeholder="Leave blank to use default payment terms from Admin settings..." />
            </div>

            <div>
              <label className="text-sm font-bold text-slate-700">Notes / Special Instructions</label>
              <textarea className="w-full rounded border p-2 text-slate-800 text-sm" rows={2} value={proformaForm.notes} onChange={e => setProformaForm({...proformaForm, notes: e.target.value})} placeholder="Any special notes to appear on the Proforma Invoice..." />
            </div>

            {/* Preview of items */}
            <div className="border rounded overflow-hidden">
              <div className="bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 uppercase">Equipment Snapshot Preview</div>
              <div className="max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500"><tr><th className="p-2 text-left">Item</th><th className="p-2 text-center">Qty</th><th className="p-2 text-center">Days</th><th className="p-2 text-right">Total</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {(selectedProject?.items || []).map((item, idx) => (
                      <tr key={idx} className="text-slate-700"><td className="p-2">{item.item_name}</td><td className="p-2 text-center">{item.qty}</td><td className="p-2 text-center">{item.days}</td><td className="p-2 text-right">{formatCurrency(item.total)}</td></tr>
                    ))}
                    {(selectedProject?.items || []).length === 0 && (
                      <tr><td colSpan={4} className="p-3 text-center text-slate-400 italic">No items allocated yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={() => setIsProformaModalOpen(false)} className="flex-1 rounded border border-slate-300 py-2 text-slate-600 hover:bg-slate-50 font-medium">Cancel</button>
              <button onClick={handleSaveProformaInvoice} className="flex-1 rounded bg-teal-600 py-2 text-white font-bold hover:bg-teal-700">Save & Generate PI</button>
            </div>
          </div>
          </Modal>

          {/* Proforma Invoice History */}
          <Modal isOpen={isProformaHistoryOpen} onClose={() => setIsProformaHistoryOpen(false)} title="Proforma Invoice History">
          <div className="space-y-2">
            {(selectedProject?.proforma_invoices || []).length === 0 ? (
              <div className="text-center text-slate-400 p-6">No Proforma Invoices generated yet.</div>
            ) : (
              [...(selectedProject?.proforma_invoices || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((pi, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
                  <div>
                    <div className="font-bold text-slate-800 font-mono text-sm">{pi.pi_no}</div>
                    <div className="text-xs text-slate-500">
                      Issued: {pi.date ? new Date(pi.date).toLocaleDateString('en-IN') : '—'} &nbsp;|&nbsp;
                      {pi.items_snapshot?.length || 0} items &nbsp;|&nbsp;
                      Created: {new Date(pi.created_at).toLocaleDateString('en-IN')}
                    </div>
                    {pi.notes && <div className="text-xs text-slate-400 italic mt-0.5">{pi.notes.substring(0, 60)}{pi.notes.length > 60 ? '...' : ''}</div>}
                  </div>
                  <div className="flex gap-2 ml-2 shrink-0">
                    <button onClick={() => generateProformaInvoicePDF(pi)} className="text-teal-600 hover:underline text-xs font-medium border border-teal-200 px-2.5 py-1.5 rounded hover:bg-teal-50">Print PDF</button>
                    <button onClick={() => handleDeleteProformaInvoice(pi)} className="text-red-500 hover:underline text-xs font-medium border border-red-200 px-2.5 py-1.5 rounded hover:bg-red-50">Delete</button>
                  </div>
                </div>
              ))
            )}
          </div>
            </Modal>
          </>
        )}

        {/* ... (Keep existing Modals: Allocation, Employee) ... */}
        <Modal isOpen={isAllocationModalOpen} onClose={() => { setIsAllocationModalOpen(false); setShowItemDropdown(false); }} title="Allocate Equipment">
          <div className="space-y-4">
            {/* ===== SEARCHABLE ITEM COMBOBOX ===== */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Select Item</label>
              <div ref={itemComboRef} className="relative">
                {/* Row: category filter + search input */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    className="rounded border border-slate-300 px-2 py-2 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-indigo-500 w-full sm:w-auto sm:shrink-0 sm:max-w-[140px]"
                    value={itemCategoryFilter}
                    onChange={e => { setItemCategoryFilter(e.target.value); setShowItemDropdown(true); }}
                  >
                    <option value="">All Categories</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <div className="relative flex-1">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search by name or category..."
                      className="w-full pl-8 pr-7 py-2 rounded border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 text-slate-800"
                      value={itemSearchQuery}
                      onChange={e => { setItemSearchQuery(e.target.value); setShowItemDropdown(true); }}
                      onFocus={() => setShowItemDropdown(true)}
                    />
                    {(itemSearchQuery || allocationForm.item_id) && (
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        onMouseDown={e => { e.preventDefault(); setItemSearchQuery(''); setItemCategoryFilter(''); setAllocationForm(p => ({ ...p, item_id: '', available_qty: 0, rate: 0, gst_rate: 18, is_led: false, tilesWide: 0, tilesHigh: 0, tileModelData: null })); setShowItemDropdown(true); }}
                        title="Clear selection"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Selected item info bar */}
                {allocationForm.item_id && (() => {
                  const selItem = inventory.find(i => i.id === allocationForm.item_id);
                  return selItem ? (
                    <div className="mt-1.5 flex items-center gap-2 rounded bg-indigo-50 border border-indigo-200 px-3 py-1.5">
                      <Package size={12} className="text-indigo-500 shrink-0" />
                      <span className="text-xs font-semibold text-indigo-700 truncate">{selItem.name}</span>
                      <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{selItem.category}</span>
                      {selItem.is_external && <span className="text-[10px] text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded shrink-0">Vendor</span>}
                      <span id="alloc-availability-inventory" role="status" aria-live="polite" className={`ml-auto text-xs font-bold shrink-0 ${allocationForm.available_qty > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {allocationForm.available_qty} avail.
                      </span>
                    </div>
                  ) : null;
                })()}

                {/* Dropdown list */}
                {showItemDropdown && (() => {
                  const q = itemSearchQuery.toLowerCase().trim();
                  const filtered = inventory.filter(item => {
                    const matchCat = !itemCategoryFilter || item.category === itemCategoryFilter;
                    const matchQ = !q || item.name.toLowerCase().includes(q) || (item.category || '').toLowerCase().includes(q) || (item.description || '').toLowerCase().includes(q);
                    return matchCat && matchQ && !item.is_archived;
                  });
                  return (
                    <div className="absolute z-[999] left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl max-h-60 overflow-y-auto">
                      {filtered.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-slate-500 text-center">No items found</div>
                      ) : (
                        filtered.map(item => {
                          const avail = getAvailableQty(item.id);
                          const isSelected = allocationForm.item_id === item.id;
                          return (
                            <div
                              key={item.id}
                              className={`flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-indigo-50 border-b border-slate-100 last:border-b-0 ${isSelected ? 'bg-indigo-50' : ''}`}
                              onMouseDown={e => {
                                e.preventDefault();
                                const isLed = ['LED Wall', 'LED'].includes(item.category);
                                const tileModelData = item.tile_model || item.led_spec || item.tileSpec || null;
                                setAllocationForm(p => ({ ...p, item_id: item.id, rate: item.rate_per_day || 0, gst_rate: item.gst_rate || 18, available_qty: avail, is_led: !!isLed, tilesWide: 0, tilesHigh: 0, tileModelData }));
                                setItemSearchQuery('');
                                setShowItemDropdown(false);
                              }}
                            >
                              <div className="flex-1 min-w-0">
                                <span className={`text-sm font-medium ${isSelected ? 'text-indigo-700' : 'text-slate-800'}`}>{item.name}</span>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{item.category || '—'}</span>
                                  {item.is_external && <span className="text-[10px] text-orange-500 bg-orange-50 px-1.5 py-0.5 rounded">Vendor</span>}
                                  {item.is_composite && <span className="text-[10px] text-purple-500 bg-purple-50 px-1.5 py-0.5 rounded">Kit</span>}
                                </div>
                              </div>
                              <div className="ml-3 text-right shrink-0">
                                <div className={`text-xs font-bold ${avail > 0 ? 'text-green-600' : 'text-red-500'}`}>{avail} free</div>
                                {item.rate_per_day > 0 && <div className="text-[10px] text-slate-400">₹{item.rate_per_day}/day</div>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="alloc-qty-inventory" className="block text-sm font-medium text-slate-700">Quantity</label>
                <input id="alloc-qty-inventory" name="qty" type="number" min="1" className={`w-full rounded border p-2 focus:ring-2 focus:ring-indigo-500 text-slate-800 ${allocationForm.qty > allocationForm.available_qty ? 'border-red-500 bg-red-50' : ''}`} value={allocationForm.qty} onChange={e => setAllocationForm({...allocationForm, qty: e.target.value})} aria-invalid={allocationForm.qty > allocationForm.available_qty ? 'true' : 'false'} />
                {allocationForm.qty > allocationForm.available_qty && (
                  <div className="text-xs text-red-600 mt-1 flex items-center gap-1" role="alert" aria-live="assertive"><AlertCircle size={10} /> Overbooking warning</div>
                )}
              </div>
              <div>
                <label htmlFor="alloc-days-inventory" className="block text-sm font-medium text-slate-700">Days</label>
                <input id="alloc-days-inventory" name="days" type="number" min="1" className="w-full rounded border p-2 focus:ring-2 focus:ring-indigo-500 text-slate-800" value={allocationForm.days} onChange={e => setAllocationForm({...allocationForm, days: e.target.value})} />
              </div>
              <div>
                <label htmlFor="alloc-rate-inventory" className="block text-sm font-medium text-slate-700">Rate / Day</label>
                <input id="alloc-rate-inventory" name="rate" type="number" className="w-full rounded border p-2 focus:ring-2 focus:ring-indigo-500 text-slate-800" value={allocationForm.rate} onChange={e => setAllocationForm({...allocationForm, rate: e.target.value})} />
              </div>
              <div>
                <label htmlFor="alloc-gst-inventory" className="block text-sm font-medium text-slate-700">GST %</label>
                <input id="alloc-gst-inventory" name="gst_rate" type="number" disabled className="w-full rounded border p-2 bg-slate-50 text-slate-800" value={allocationForm.gst_rate} />
              </div>
            </div>
            {allocationForm.is_led && (
              <div className="rounded border border-indigo-100 bg-indigo-50 p-3 mt-3">
                <div className="text-sm font-semibold text-indigo-700 mb-2">LED Wall Configuration</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-slate-700">Tiles Wide (no. of tiles)</label>
                    <input type="number" min={1} className="w-full rounded border p-2" value={allocationForm.tilesWide} onChange={e => setAllocationForm({...allocationForm, tilesWide: e.target.value})} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-700">Tiles High (no. of tiles)</label>
                    <input type="number" min={1} className="w-full rounded border p-2" value={allocationForm.tilesHigh} onChange={e => setAllocationForm({...allocationForm, tilesHigh: e.target.value})} />
                  </div>
                </div>
                <div className="mt-3 text-sm text-slate-700">
                  {/* Compute and display LED specs if tile model data available */}
                  {(() => {
                    const selItem = inventory.find(i => i.id === allocationForm.item_id) || {};
                    const tileData = allocationForm.tileModelData || selItem.tile_model || selItem.led_spec || selItem.tileSpec;
                    const w = parseInt(allocationForm.tilesWide) || 0;
                    const h = parseInt(allocationForm.tilesHigh) || 0;
                    if (!tileData) return (<div className="text-xs text-red-600 mt-2">Missing tile technical details on this inventory item.</div>);
                    if (w <= 0 || h <= 0) return (<div className="text-xs text-slate-500 mt-2">Enter tiles wide and high to preview specs.</div>);
                    const tileModel = new LEDTileModel({
                      modelName: tileData.modelName || tileData.name || selItem.name,
                      dimensions: tileData.dimensions || tileData.dim || { width: tileData.width_mm || tileData.width || 0, height: tileData.height_mm || tileData.height || 0, depth: tileData.depth_mm || tileData.depth || 0 },
                      pixelPitch: tileData.pixelPitch || tileData.pixel_pitch || tileData.pitch || 0,
                      resolution: tileData.resolution || { pixelWidth: tileData.pixelWidth || 0, pixelHeight: tileData.pixelHeight || 0 },
                      power: tileData.power || tileData.powerSpecs || { maxPower: tileData.maxPower || 0, avgPower: tileData.avgPower || 0 },
                      weight: tileData.weight || tileData.weightKg || selItem.weight || 0,
                      inventory: tileData.inventory || { totalTiles: selItem.total || 0, tilesPerCase: tileData.tilesPerCase || selItem.tilesPer_case || 1 }
                    });
                    const specs = calculateWallSpecs(tileModel, w, h, 230);
                    const ftFactor = 3.28084;
                    const portCalc = calculateLEDSignalPorts(specs.resolution.totalPixelWidth, specs.resolution.totalPixelHeight);
                    return (
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs"><span>Total Width:</span><span>{specs.physicalDimensions.totalWidthMm} mm ({specs.physicalDimensions.totalWidthM} m | {(specs.physicalDimensions.totalWidthM * ftFactor).toFixed(2)} ft)</span></div>
                        <div className="flex justify-between text-xs"><span>Total Height:</span><span>{specs.physicalDimensions.totalHeightMm} mm ({specs.physicalDimensions.totalHeightM} m | {(specs.physicalDimensions.totalHeightM * ftFactor).toFixed(2)} ft)</span></div>
                        <div className="flex justify-between text-xs"><span>Resolution:</span><span>{specs.resolution.totalPixelWidth} × {specs.resolution.totalPixelHeight} px</span></div>
                        <div className="flex justify-between text-xs"><span>Total Tiles:</span><span>{specs.logistics.totalTilesNeeded}</span></div>
                        <div className="flex justify-between text-xs"><span>Total Weight:</span><span>{specs.physicalDimensions.totalWeightKg} kg</span></div>
                        <div className="flex justify-between text-xs"><span>Power (Max / Avg):</span><span>{specs.power.maxPowerWatts} W / {specs.power.avgPowerWatts} W</span></div>
                        <div className="flex justify-between text-xs"><span>Estimated Amps (@{specs.power.operatingVoltage}V):</span><span>{specs.power.maxAmpsAt230V} A (max) | {specs.power.avgAmpsAt230V} A (avg)</span></div>
                        <div className="flex justify-between text-xs"><span>Flight Cases Needed:</span><span>{specs.logistics.totalFlightCasesNeeded} cases ({specs.logistics.tilesPerFlightCase} tiles/case)</span></div>
                        {portCalc && (
                          <>
                            <div className="border-t pt-2 text-xs font-semibold text-indigo-700">CAT 6 Signal Ports (Technical)</div>
                            <div className="flex justify-between text-xs"><span>Primary Ports:</span><span>{portCalc.primaryPorts} (650K px/port)</span></div>
                            <div className="flex justify-between text-xs"><span>Backup Ports:</span><span>{portCalc.backupPorts}</span></div>
                            <div className="flex justify-between text-xs font-semibold text-indigo-600"><span>Total with Backup:</span><span>{portCalc.totalPortsWithBackup}</span></div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
            <div>
              <label htmlFor="alloc-desc-inventory" className="block text-sm font-medium text-slate-700">Description / Remarks</label>
              <input id="alloc-desc-inventory" name="description" type="text" className="w-full rounded border p-2 focus:ring-2 focus:ring-indigo-500 text-slate-800" placeholder="Optional notes..." value={allocationForm.description} onChange={e => setAllocationForm({...allocationForm, description: e.target.value})} />
            </div>
            <div className="rounded bg-slate-50 p-3 text-right space-y-1 text-sm text-slate-700" aria-live="polite">
              <div className="flex justify-between"><span>Subtotal:</span><span>{formatCurrency((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0))}</span></div>
              <div className="flex justify-between font-bold text-lg text-slate-800 border-t pt-1 mt-1"><span>Total:</span><span>{formatCurrency(((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0)) * (1 + allocationForm.gst_rate/100))}</span></div>
            </div>
            <div className="flex justify-end pt-2"><button onClick={handleSaveAllocation} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">Add & Keep Open</button></div>
          </div>
        </Modal>
        <Modal isOpen={isEmpModalOpen} onClose={() => setIsEmpModalOpen(false)} title="Assign Team to Project">
          <div className="space-y-4">
            <div className="text-xs text-slate-500">Tap an employee to assign or remove from this project.</div>
            <div className="space-y-2 max-h-[60dvh] overflow-y-auto pr-1">
              {employees.map(emp => {
                const isAssigned = (selectedProject.assigned_employees || []).includes(emp.id);
                const isBusy = !isAssigned && isEmployeeBusy(emp.id);
                return (
                  <div
                    key={emp.id}
                    className={`flex items-center justify-between gap-2 p-3 rounded border cursor-pointer ${isAssigned ? 'bg-indigo-50 border-indigo-200' : isBusy ? 'bg-orange-50 border-orange-200' : 'bg-white hover:bg-slate-50'}`}
                    onClick={() => toggleEmployee(emp.id)}
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold ${isBusy ? 'bg-orange-200 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>
                        {emp.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-slate-800 flex items-center gap-2">
                          <span className="truncate">{emp.name}</span>
                          {isBusy && <span className="text-[10px] bg-orange-100 text-orange-700 px-1 rounded border border-orange-200 shrink-0">Busy</span>}
                        </div>
                        <div className="text-xs text-slate-500 capitalize">{emp.role}</div>
                      </div>
                    </div>
                    <div className={`h-5 w-5 shrink-0 rounded border flex items-center justify-center ${isAssigned ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300'}`}>
                      {isAssigned && <CheckCircle size={14} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end pt-2">
              <button onClick={() => setIsEmpModalOpen(false)} className="rounded bg-slate-50 px-6 py-2 text-black hover:bg-slate-100">Done</button>
            </div>
          </div>
        </Modal>

        {/* ===== QUICK EXPENSE MODAL ===== */}
        <Modal isOpen={isQuickExpenseOpen} onClose={() => setIsQuickExpenseOpen(false)} title="Log Quick Expense">
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
              Logging expense for: <span className="font-bold">{selectedProject?.project_name}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-700">Category <span className="text-red-500">*</span></label>
                <select className="w-full rounded border p-2 text-slate-800 bg-white" value={quickExpenseForm.category} onChange={e => setQuickExpenseForm({...quickExpenseForm, category: e.target.value})}>
                  {EXPENSE_CATS.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Date <span className="text-red-500">*</span></label>
                <input type="date" className="w-full rounded border p-2 text-slate-800" value={quickExpenseForm.date} onChange={e => setQuickExpenseForm({...quickExpenseForm, date: e.target.value})} />
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Amount (₹) <span className="text-red-500">*</span></label>
              <input type="number" placeholder="Enter amount" className="w-full rounded border p-2 text-slate-800" value={quickExpenseForm.amount} onChange={e => setQuickExpenseForm({...quickExpenseForm, amount: e.target.value})} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Notes</label>
              <input type="text" placeholder="Brief description (optional)" className="w-full rounded border p-2 text-slate-800" value={quickExpenseForm.notes} onChange={e => setQuickExpenseForm({...quickExpenseForm, notes: e.target.value})} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Proof (Invoice/Bill/Receipt){expenseProofSettings.threshold > 0 && parseFloat(quickExpenseForm.amount) > expenseProofSettings.threshold && !qeProofFile ? <span className="text-red-500 ml-1">* Required above {formatCurrency(expenseProofSettings.threshold)}</span> : null}</label>
              <input ref={qeProofInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={async e => {
                const f = e.target.files?.[0]; if (!f) return;
                const maxBytes = (expenseProofSettings.maxSizeMb || 2) * 1024 * 1024;
                if (f.size > maxBytes) { addToast(`File too large. Maximum allowed size is ${expenseProofSettings.maxSizeMb} MB.`, 'error'); e.target.value = ''; return; }
                setQeProofUploading(true);
                try { const ext = f.name.split('.').pop(); const path = `expense-proofs/${appId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
                  const storageRef = ref(storage, path); await uploadBytes(storageRef, f); const url = await getDownloadURL(storageRef);
                  setQeProofFile({ url, name: f.name, path }); } catch (err) { addToast('Upload failed: ' + err.message, 'error'); }
                setQeProofUploading(false); e.target.value = '';
              }} />
              {qeProofFile ? (
                <div className="flex items-center gap-2 mt-1 p-2 bg-indigo-50 rounded border border-indigo-100">
                  <a href={qeProofFile.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-indigo-700 hover:underline truncate flex-1">
                    {qeProofFile.name?.toLowerCase().endsWith('.pdf') ? <FileText size={14} /> : <ImageIcon size={14} />} {qeProofFile.name}
                  </a>
                  <button type="button" onClick={async () => { if (qeProofFile.path) { try { await deleteObject(ref(storage, qeProofFile.path)); } catch (_) {} } setQeProofFile(null); }} className="text-red-400 hover:text-red-600"><X size={14} /></button>
                </div>
              ) : (
                <button type="button" onClick={() => qeProofInputRef.current?.click()} disabled={qeProofUploading} className="w-full mt-1 flex items-center justify-center gap-2 rounded border border-dashed border-slate-300 p-2 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition">
                  <Upload size={14} /> {qeProofUploading ? 'Uploading...' : 'Attach proof (photo/PDF)'}
                </button>
              )}
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setIsQuickExpenseOpen(false)} className="flex-1 rounded border border-slate-300 py-2 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSaveQuickExpense} className="flex-1 rounded bg-amber-500 py-2 text-white font-bold hover:bg-amber-600">Submit Expense</button>
            </div>
          </div>
        </Modal>

        {/* ===== QUOTE SHARE MODAL ===== */}
        <Modal isOpen={isQuoteShareOpen} onClose={() => setIsQuoteShareOpen(false)} title="Share Quote for Client Approval">
          <div className="space-y-4">
            <div className="bg-indigo-50 border border-indigo-200 rounded p-3 text-sm text-indigo-800">
              Share this link with your client. They can review the quote and approve or decline directly — no login required.
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700 mb-1 block">Approval Link</label>
              <div className="flex gap-2">
                <input readOnly value={quoteShareUrl} className="flex-1 rounded border border-slate-300 p-2 text-sm text-slate-700 bg-slate-50 font-mono" />
                <button onClick={() => { navigator.clipboard.writeText(quoteShareUrl); addToast('Link copied!', 'success'); }} className="rounded bg-indigo-600 px-4 py-2 text-white text-sm font-medium hover:bg-indigo-700">Copy</button>
              </div>
            </div>
            {(() => {
              const clientPhone = clients.find(c => c.id === selectedProject?.client_id)?.contacts?.[0]?.phone;
              if (!clientPhone) return <div className="text-xs text-slate-400 italic">No client phone on record — copy the link to share manually.</div>;
              const phone = clientPhone.replace(/\D/g, '');
              const waPhone = phone.startsWith('91') ? phone : `91${phone}`;
              const msg = `Dear ${clients.find(c => c.id === selectedProject?.client_id)?.name || "Sir/Ma'am"},\n\nPlease review and approve the quotation for "${selectedProject?.project_name}".\n\n👉 ${quoteShareUrl}\n\nKindly click the link to approve or decline. Thank you!\n\n— RentalOps Team`;
              return (
                <a href={`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full rounded-lg bg-green-500 py-2.5 text-white font-bold hover:bg-green-600 transition">
                  <MessageCircle size={18} /> Send via WhatsApp to {clientPhone}
                </a>
              );
            })()}
            <button onClick={() => setIsQuoteShareOpen(false)} className="w-full rounded border border-slate-300 py-2 text-slate-600 hover:bg-slate-50 text-sm">Close</button>
          </div>
        </Modal>

        {/* ===== REIMBURSABLE EXPENSE MODAL ===== */}
        <Modal isOpen={isReimbursableOpen} onClose={() => { setIsReimbursableOpen(false); setEditingReimbursableIdx(null); }} title={editingReimbursableIdx !== null ? 'Edit Reimbursable Expense' : 'Add Reimbursable Expense'}>
          <div className="space-y-4">
            <div className="bg-teal-50 border border-teal-200 rounded p-3 text-xs text-teal-800">
              Client-reimbursable expense for: <span className="font-bold">{selectedProject?.project_name}</span>
              <div className="mt-1 text-teal-600">These are expenses the client has agreed to pay at actuals — they will appear in the project total under a separate heading and can be shared with the client.</div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Description <span className="text-red-500">*</span></label>
              <input type="text" className="w-full rounded border p-2 text-slate-800" placeholder="e.g. Local transport, Fuel charges, Parking" value={reimbursableForm.description} onChange={e => setReimbursableForm({...reimbursableForm, description: e.target.value})} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-700">Category</label>
                <select className="w-full rounded border p-2 text-slate-800 bg-white" value={reimbursableForm.category} onChange={e => setReimbursableForm({...reimbursableForm, category: e.target.value})}>
                  {EXPENSE_CATS.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Date <span className="text-red-500">*</span></label>
                <input type="date" className="w-full rounded border p-2 text-slate-800" value={reimbursableForm.date} onChange={e => setReimbursableForm({...reimbursableForm, date: e.target.value})} />
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Amount (₹) <span className="text-red-500">*</span></label>
              <input type="number" className="w-full rounded border p-2 text-slate-800" placeholder="Enter amount" value={reimbursableForm.amount} onChange={e => setReimbursableForm({...reimbursableForm, amount: e.target.value})} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Remarks</label>
              <input type="text" className="w-full rounded border p-2 text-slate-800" placeholder="Optional notes" value={reimbursableForm.remarks} onChange={e => setReimbursableForm({...reimbursableForm, remarks: e.target.value})} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Proof (Invoice/Receipt)</label>
              <input ref={reimbursableProofRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleReimbursableProofUpload(f); e.target.value = ''; }} />
              {reimbursableProofFile ? (
                <div className="flex items-center gap-2 mt-1 p-2 bg-teal-50 rounded border border-teal-100">
                  <a href={reimbursableProofFile.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-teal-700 hover:underline truncate flex-1">
                    {reimbursableProofFile.name?.toLowerCase().endsWith('.pdf') ? <FileText size={14} /> : <ImageIcon size={14} />} {reimbursableProofFile.name}
                  </a>
                  <button type="button" onClick={async () => { if (reimbursableProofFile.path && editingReimbursableIdx === null) { try { await deleteObject(ref(storage, reimbursableProofFile.path)); } catch (_) {} } setReimbursableProofFile(null); }} className="text-red-400 hover:text-red-600"><X size={14} /></button>
                </div>
              ) : (
                <button type="button" onClick={() => reimbursableProofRef.current?.click()} disabled={reimbursableProofUploading} className="w-full mt-1 flex items-center justify-center gap-2 rounded border border-dashed border-slate-300 p-2 text-xs text-slate-500 hover:border-teal-400 hover:text-teal-600 transition">
                  <Upload size={14} /> {reimbursableProofUploading ? 'Uploading...' : 'Attach proof (photo/PDF)'}
                </button>
              )}
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => { setIsReimbursableOpen(false); setEditingReimbursableIdx(null); }} className="flex-1 rounded border border-slate-300 py-2 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSaveReimbursable} className="flex-1 rounded bg-teal-600 py-2 text-white font-bold hover:bg-teal-700">{editingReimbursableIdx !== null ? 'Update' : 'Save'}</button>
            </div>
          </div>
        </Modal>

        {/* ===== REIMBURSABLE SHARE MODAL ===== */}
        <Modal isOpen={isReimbursableShareOpen} onClose={() => setIsReimbursableShareOpen(false)} title="Share Reimbursable Expenses with Client">
          <div className="space-y-4">
            <div className="bg-teal-50 border border-teal-200 rounded p-3 text-sm text-teal-800">
              Share this link with your client. They can view all reimbursable expenses with proofs and download them as PDF or Excel — no login required.
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700 mb-1 block">Reimbursable Expenses Link</label>
              <div className="flex gap-2">
                <input readOnly value={reimbursableShareUrl} className="flex-1 rounded border border-slate-300 p-2 text-sm text-slate-700 bg-slate-50 font-mono" />
                <button onClick={() => { navigator.clipboard.writeText(reimbursableShareUrl); addToast('Link copied!', 'success'); }} className="rounded bg-teal-600 px-4 py-2 text-white text-sm font-medium hover:bg-teal-700">Copy</button>
              </div>
            </div>
            {(() => {
              const clientPhone = clients.find(c => c.id === selectedProject?.client_id)?.contacts?.[0]?.phone;
              if (!clientPhone) return <div className="text-xs text-slate-400 italic">No client phone on record — copy the link to share manually.</div>;
              const phone = clientPhone.replace(/\D/g, '');
              const waPhone = phone.startsWith('91') ? phone : `91${phone}`;
              const msg = `Dear ${clients.find(c => c.id === selectedProject?.client_id)?.name || "Sir/Ma'am"},\n\nPlease find the reimbursable expenses for project "${selectedProject?.project_name}".\n\n👉 ${reimbursableShareUrl}\n\nYou can view details, download proofs, and export as PDF or Excel.\n\nThank you!\n— RentalOps Team`;
              return (
                <a href={`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full rounded-lg bg-green-500 py-2.5 text-white font-bold hover:bg-green-600 transition">
                  <MessageCircle size={18} /> Send via WhatsApp to {clientPhone}
                </a>
              );
            })()}
            <button onClick={() => setIsReimbursableShareOpen(false)} className="w-full rounded border border-slate-300 py-2 text-slate-600 hover:bg-slate-50 text-sm">Close</button>
          </div>
        </Modal>

        <ConfirmDeleteModal
          isOpen={deleteConfirm.isOpen}
          onClose={() => setDeleteConfirm(prev => ({ ...prev, isOpen: false }))}
          onConfirm={deleteConfirm.onConfirm}
          title={deleteConfirm.title}
          message={deleteConfirm.message}
          requireTyped={deleteConfirm.requireTyped}
        />

        {/* ===== ORDER CONFIRMATION MODAL ===== */}
        <Modal isOpen={isConfirmOrderOpen} onClose={() => setIsConfirmOrderOpen(false)} title="Order Confirmation Details">
          <div className="space-y-4">
            <p className="text-sm text-slate-500">Record how and when this order was confirmed. This creates an audit trail for disputes and finance follow-ups.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Confirmation Date <span className="text-red-500">*</span></label>
                <input type="date" value={confirmOrderForm.confirmation_date} onChange={e => setConfirmOrderForm(f => ({ ...f, confirmation_date: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Confirmation Mode <span className="text-red-500">*</span></label>
                <select value={confirmOrderForm.confirmation_mode} onChange={e => setConfirmOrderForm(f => ({ ...f, confirmation_mode: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200">
                  <option>Email</option>
                  <option>Purchase Order (PO)</option>
                  <option>WhatsApp</option>
                  <option>Verbal – Phone Call</option>
                  <option>Verbal – In Person</option>
                  <option>Signed Quote</option>
                  <option>Client Portal</option>
                  <option>Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Reference / PO Number</label>
                <input type="text" placeholder="PO-1234 / Email subject / Message ID" value={confirmOrderForm.po_reference} onChange={e => setConfirmOrderForm(f => ({ ...f, po_reference: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Advance Committed (₹)</label>
                <input type="number" placeholder="0" value={confirmOrderForm.advance_committed} onChange={e => setConfirmOrderForm(f => ({ ...f, advance_committed: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Client Contact (who confirmed)</label>
                <input type="text" placeholder="Name & designation" value={confirmOrderForm.confirmed_by_client} onChange={e => setConfirmOrderForm(f => ({ ...f, confirmed_by_client: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Received By (internal)</label>
                <input type="text" placeholder="Team member who received confirmation" value={confirmOrderForm.confirmed_by_internal} onChange={e => setConfirmOrderForm(f => ({ ...f, confirmed_by_internal: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200" />
              </div>
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={confirmOrderForm.follow_up_required} onChange={e => setConfirmOrderForm(f => ({ ...f, follow_up_required: e.target.checked }))} className="accent-amber-500 w-4 h-4" />
                <span className="text-sm font-semibold text-amber-800">Written confirmation still pending (verbal only for now)</span>
              </label>
              {confirmOrderForm.follow_up_required && (
                <div>
                  <label className="block text-xs font-semibold text-amber-700 mb-1">Expected by date</label>
                  <input type="date" value={confirmOrderForm.follow_up_date} onChange={e => setConfirmOrderForm(f => ({ ...f, follow_up_date: e.target.value }))} className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-amber-200" />
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Additional Notes</label>
              <textarea rows={2} placeholder="Any special terms agreed, conditions, remarks…" value={confirmOrderForm.confirmation_notes} onChange={e => setConfirmOrderForm(f => ({ ...f, confirmation_notes: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200 resize-none" />
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => handleSaveConfirmation(true)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm">Skip & Confirm</button>
              <button onClick={() => handleSaveConfirmation(false)} disabled={!confirmOrderForm.confirmation_date || !confirmOrderForm.confirmation_mode} className="px-5 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-semibold disabled:opacity-50">Save & Confirm</button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h2 className="text-2xl font-bold text-slate-800">Projects</h2>
          <div className="flex gap-2 w-full md:w-auto">
              {(role === 'manager' || role === 'admin') && (
                <>
                  <button onClick={exportFilteredProjects} className="flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-50 whitespace-nowrap w-full md:w-auto"><Download size={18} /> Export</button>
                  <button onClick={() => { setBulkInvoiceOpen(true); setBulkInvoiceSelected(new Set()); }} className="flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-emerald-700 hover:bg-emerald-100 whitespace-nowrap w-full md:w-auto">
                      <Receipt size={18} /> Group Invoice
                  </button>
                </>
              )}
              {can(role, 'projects', 'create') && (
                <button onClick={openCreate} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap w-full md:w-auto">
                    <Plus size={18} /> Create New Quote
                </button>
              )}
              {!can(role, 'projects', 'create') && can(role, 'projects', 'create_draft') && (
                <button onClick={openCreate} className="flex items-center justify-center gap-2 rounded-lg border border-slate-400 bg-slate-100 px-4 py-2 text-slate-700 hover:bg-slate-200 whitespace-nowrap w-full md:w-auto">
                    <Plus size={18} /> New Enquiry (Draft)
                </button>
              )}
          </div>
      </div>

      {/* --- Filter Bar with Invoice Status --- */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
         <div><label className="text-[10px] font-bold text-slate-700 uppercase">From Date</label><input type="date" className="w-full text-xs rounded border p-1 bg-white text-black" value={filters.startDate} onChange={e => handleFilterChange('startDate', e.target.value)} /></div>
         <div><label className="text-[10px] font-bold text-slate-700 uppercase">To Date</label><input type="date" className="w-full text-xs rounded border p-1 bg-white text-black" value={filters.endDate} onChange={e => handleFilterChange('endDate', e.target.value)} /></div>
         <div><label className="text-[10px] font-bold text-slate-700 uppercase">Setup Date {'>='}</label><input type="date" className="w-full text-xs rounded border p-1 bg-white text-black" value={filters.setupDate} onChange={e => handleFilterChange('setupDate', e.target.value)} /></div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Client</label>
            <select className="w-full text-xs rounded border p-1 bg-slate-50 text-black" value={filters.clientId} onChange={e => handleFilterChange('clientId', e.target.value)}>
                <option value="">All Clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Status</label>
            <select className="w-full text-xs rounded border p-1 bg-slate-50 text-black" value={filters.status} onChange={e => handleFilterChange('status', e.target.value)}>
                <option value="">All Status</option>
                <option value="Draft">Draft</option>
                <option value="Quoted">Quoted</option>
                <option value="Confirmed">Confirmed</option>
                <option value="Ongoing">Ongoing</option>
                <option value="Completed">Completed</option>
                <option value="Closed">Closed</option>
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Invoice</label>
            <select className="w-full text-xs rounded border p-1 bg-slate-50 text-black" value={filters.invoiceStatus} onChange={e => handleFilterChange('invoiceStatus', e.target.value)}>
                <option value="">All</option>
                <option value="Not Invoiced">Not Invoiced</option>
                <option value="Invoiced">Invoiced</option>
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Quick Filter</label>
            <select className="w-full text-xs rounded border p-1 bg-slate-50 text-black" value={quickFilter} onChange={e => handleQuickFilterChange(e.target.value)}>
                <option value="">None</option>
                <option value="this_week">This Week</option>
                <option value="next_month">Next Month</option>
                <option value="overdue">Overdue</option>
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Sort By</label>
            <div className="flex gap-1">
                <select className="w-full text-xs rounded border p-1 bg-slate-50 text-black" value={sortConfig.key} onChange={e => setSortConfig({...sortConfig, key: e.target.value})}>
                    <option value="start_date">Start Date</option>
                    <option value="client">Client</option>
                  {canViewRatesRole && <option value="total_value">Total Value</option>}
                </select>
                <button onClick={() => setSortConfig(prev => ({ ...prev, direction: prev.direction === 'asc' ? 'desc' : 'asc' }))} className="px-2 rounded border bg-slate-50 hover:bg-slate-100 text-slate-800" title="Toggle Direction">
                    {sortConfig.direction === 'asc' ? '↑' : '↓'}
                </button>
            </div>
         </div>
         <div className="flex items-end gap-1">
            {role === 'tech' && (
              <button
                onClick={() => setMyProjectsOnly(v => !v)}
                className={`w-full text-xs rounded border p-1.5 font-bold ${
                  myProjectsOnly ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
                title={myProjectsOnly ? 'Showing your assigned projects. Click to show all.' : 'Showing all projects. Click to show only yours.'}
              >
                {myProjectsOnly ? 'My Projects' : 'All Projects'}
              </button>
            )}
            <button onClick={resetFilters} className={`w-full text-xs rounded border p-1.5 font-bold ${isDefaultFilter ? 'bg-indigo-100 text-indigo-700 border-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {isDefaultFilter ? 'Default View' : 'Reset Filters'}
            </button>
         </div>
      </div>

      <div className="space-y-3">
        {paginatedProjects.length === 0 ? <div className="text-center text-slate-400 py-10">No projects match your filters.</div> : 
        projectCards.map(({ project, progress, clientName, daysDiff, setupToStart }) => (
          <div key={project.id} onClick={() => { setSelectedProjectId(String(project.id)); navigate(`/projects/${project.id}`); }} className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md hover:border-indigo-300 group relative">
            {/* Top Row: Project Name & Status */}
            <div className="flex items-start justify-between mb-3 gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                    <div className="font-bold text-lg text-slate-800">{project.project_name}</div>
                    {isProjectInvoiced(project.invoice_status) && <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded border border-green-200" title={`Inv#: ${project.invoice_no}`}>INVOICED</span>}
                </div>
                <div className="text-sm font-semibold text-indigo-600">{clientName}</div>
              </div>
              <span className={`px-3 py-1 text-xs font-semibold rounded border whitespace-nowrap ${STATUS_COLORS[project.status]}`}>{project.status}</span>
            </div>

            {/* Main Info Grid: 2x3 Layout */}
            <div className="grid grid-cols-3 gap-3 mb-3 text-sm">
              {/* Column 1: Dates */}
              <div className="space-y-2">
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Setup Date</div>
                  <div className="font-semibold text-slate-800">{fmtDate(project.setup_date)}</div>
                  {setupToStart > 0 && <div className="text-xs text-slate-600">({setupToStart} days before)</div>}
                </div>
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Start Date</div>
                  <div className="font-semibold text-slate-800">{fmtDate(project.start_date)}</div>
                </div>
              </div>

              {/* Column 2: Duration & Venue */}
              <div className="space-y-2">
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Duration</div>
                  <div className="font-semibold text-slate-800">{daysDiff} days</div>
                  <div className="text-xs text-slate-600">End: {fmtDate(project.end_date)}</div>
                </div>
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Venue</div>
                  <div className="font-semibold text-slate-800 truncate" title={project.venue}>{project.venue || '—'}</div>
                </div>
              </div>

              {/* Column 3: Project Value & Items */}
              <div className="space-y-2">
                {projectFinanceVisible(project) ? (
                  <div className="bg-indigo-50 rounded p-2 border border-indigo-100">
                    <div className="text-xs text-indigo-600 font-semibold uppercase">Project Value</div>
                    <div className="font-bold text-indigo-700">{formatCurrency(getProjectGrandTotal(project))}</div>
                    <div className="text-xs text-indigo-600">{(project.items || []).length} items</div>
                  </div>
                ) : (
                  <div className="bg-indigo-50 rounded p-2 border border-indigo-100">
                    <div className="text-xs text-indigo-600 font-semibold uppercase">Allocated Items</div>
                    <div className="font-bold text-indigo-700">{(project.items || []).length}</div>
                    <div className="text-xs text-indigo-600">Financial value hidden</div>
                  </div>
                )}
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Progress</div>
                  <div className="text-sm font-semibold text-slate-800">{progress}%</div>
                  {['Confirmed', 'Ongoing'].includes(project.status) && (
                    <div className="w-full bg-slate-200 rounded-full h-1 mt-1 overflow-hidden">
                      <div className={`h-1 rounded-full ${progress >= 100 ? 'bg-green-500' : 'bg-indigo-500'}`} style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}></div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Action Buttons - Visible on Hover */}
            {(role==='admin'||role==='manager') && (
              <div className="absolute bottom-4 right-4 flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                <button onClick={(e)=>{e.stopPropagation();openEdit(project)}} className="p-2 text-blue-600 bg-blue-50 rounded hover:bg-blue-100 transition" title="Edit Project"><Edit size={16}/></button>
                <button onClick={(e)=>{e.stopPropagation();handleDuplicate(project)}} className="p-2 text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100 transition" title="Duplicate Project"><Copy size={16}/></button>
                <button onClick={(e)=>{e.stopPropagation();handleDelete(project.id)}} className="p-2 text-red-600 bg-red-50 rounded hover:bg-red-100 transition" title="Delete Project"><Trash2 size={16}/></button>
              </div>
            )}
          </div>
        ))}
        {sortedProjects.length > itemsPerPage && (
          <div className="flex items-center justify-between pt-4">
            <div className="text-sm text-slate-500">Showing {Math.min((currentPage - 1) * itemsPerPage + 1, sortedProjects.length)} to {Math.min(currentPage * itemsPerPage, sortedProjects.length)} of {sortedProjects.length} projects</div>
            <div className="flex gap-2">
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(sortedProjects.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(sortedProjects.length / itemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title={editingId ? "Edit Project" : "Create New Quote"}>
        <div className="space-y-3">
          <div><label className="text-sm font-bold text-slate-800">Project Name</label><input className="w-full rounded border p-2 text-slate-800" value={newProj.project_name} onChange={e => setNewProj({...newProj, project_name: e.target.value})} /></div>
          <div ref={clientComboRef}>
            <label className="text-sm font-bold text-slate-800">Client</label>
            <div className="relative">
              <input
                className="w-full rounded border p-2 text-slate-800"
                placeholder="Search client by name..."
                value={showClientDropdown ? clientSearchQuery : (clients.find(c => c.id === newProj.client_id)?.name || clientSearchQuery)}
                onChange={e => { setClientSearchQuery(e.target.value); setShowClientDropdown(true); if (!e.target.value) setNewProj({...newProj, client_id: '', party_company_id: '', party_company_name: '', party_company_gstin: '', party_company_address: ''}); }}
                onFocus={() => setShowClientDropdown(true)}
              />
              {newProj.client_id && !showClientDropdown && (
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => { setNewProj({...newProj, client_id: '', party_company_id: '', party_company_name: '', party_company_gstin: '', party_company_address: ''}); setClientSearchQuery(''); setShowClientDropdown(true); }}><X size={16} /></button>
              )}
              {showClientDropdown && (
                <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded border bg-white shadow-lg">
                  {projectClientEntityOptions.filter(c => c.label?.toLowerCase().includes(clientSearchQuery.toLowerCase())).length === 0 ? (
                    <li className="px-3 py-2 text-sm text-slate-400">No clients found</li>
                  ) : (
                    projectClientEntityOptions.filter(c => c.label?.toLowerCase().includes(clientSearchQuery.toLowerCase())).map(c => (
                      <li key={c.value} className={`cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50 ${newProj.client_id === c.client_id && (newProj.party_company_id || 'primary') === c.company_id ? 'bg-indigo-100 font-semibold' : ''}`}
                        onClick={() => {
                          setNewProj({
                            ...newProj,
                            client_id: c.client_id,
                            party_company_id: c.company_id || 'primary',
                            party_company_name: c.company_name || '',
                            party_company_gstin: c.company_gstin || '',
                            party_company_address: c.company_address || '',
                          });
                          setClientSearchQuery(c.label);
                          setShowClientDropdown(false);
                        }}>
                        {c.label}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          </div>
          {newProj.client_id && (() => {
            const selectedClient = clients.find(c => c.id === newProj.client_id);
            const companies = getPartyCompanies(selectedClient);
            return (
              <div>
                <label className="text-sm font-bold text-slate-800">Billing Company / Branch</label>
                <select
                  className="w-full rounded border p-2 text-slate-800"
                  value={newProj.party_company_id || 'primary'}
                  onChange={e => {
                    const selected = companies.find(x => x.id === e.target.value);
                    setNewProj({
                      ...newProj,
                      party_company_id: selected?.id || '',
                      party_company_name: selected?.name || '',
                      party_company_gstin: selected?.gstin || '',
                      party_company_address: selected?.address || '',
                    });
                  }}
                >
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.gstin ? ` (${c.gstin})` : ''}</option>
                  ))}
                </select>
                {newProj.party_company_address && (
                  <div className="mt-1 text-xs text-slate-500">Address: {newProj.party_company_address}</div>
                )}
              </div>
            );
          })()}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div><label className="text-sm font-bold text-slate-800">Setup Date</label><input type="date" className="w-full rounded border p-2 text-slate-800" value={newProj.setup_date} onChange={e => { const v = e.target.value; setNewProj(prev => ({ ...prev, setup_date: v, start_date: v, end_date: v })); }} /></div>
              <div><label className="text-sm font-bold text-slate-800">Start Date</label><input type="date" className="w-full rounded border p-2 text-slate-800" value={newProj.start_date} onChange={e => setNewProj({...newProj, start_date: e.target.value})} /></div>
              <div><label className="text-sm font-bold text-slate-800">End Date</label><input type="date" className="w-full rounded border p-2 text-slate-800" value={newProj.end_date} onChange={e => setNewProj({...newProj, end_date: e.target.value})} /></div>
          </div>
          <div><label className="text-sm font-bold text-slate-800">Venue</label><input className="w-full rounded border p-2 text-slate-800" value={newProj.venue} onChange={e => setNewProj({...newProj, venue: e.target.value})} /></div>

          <div>
            <label className="text-sm font-bold text-slate-800">Site GPS location <span className="font-normal text-slate-400">(optional — enables crew distance-from-site)</span></label>
            <LocationPicker lat={newProj.site_lat} lng={newProj.site_lng} onChange={({ lat, lng }) => setNewProj(prev => ({ ...prev, site_lat: lat, site_lng: lng }))} />
          </div>

          {/* Package Cost Section */}
          <div className="border-t pt-3 mt-3">
            <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-3">
              <p className="text-xs text-blue-700"><strong>Package Cost:</strong> If specified, this will be the final revenue for P&L and client invoicing, superseding item allocations and logistics costs.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-sm font-bold text-slate-800">Package Cost (Excl. GST)</label>
                <input type="number" min="0" step="0.01" className="w-full rounded border p-2 text-slate-800" value={newProj.package_cost || 0} onChange={e => setNewProj({...newProj, package_cost: parseFloat(e.target.value) || 0})} placeholder="0.00" />
              </div>
              <div>
                <label className="text-sm font-bold text-slate-800">GST %</label>
                <input type="number" min="0" max="100" step="0.01" className="w-full rounded border p-2 text-slate-800" value={newProj.package_cost_gst || 18} onChange={e => setNewProj({...newProj, package_cost_gst: parseFloat(e.target.value) || 18})} placeholder="18" />
              </div>
            </div>
            {newProj.package_cost > 0 && (
              <div className="mt-2 p-2 bg-white rounded border border-blue-100 text-sm">
                <div className="flex justify-between"><span className="text-slate-600">Subtotal:</span><span className="font-medium">{formatCurrency(newProj.package_cost)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">GST ({newProj.package_cost_gst}%):</span><span className="font-medium">{formatCurrency((newProj.package_cost * newProj.package_cost_gst) / 100)}</span></div>
                <div className="flex justify-between text-base font-bold text-blue-700 border-t mt-1 pt-1"><span>Total Revenue:</span><span>{formatCurrency(newProj.package_cost * (1 + newProj.package_cost_gst / 100))}</span></div>
              </div>
            )}
          </div>
          
          <div className="flex gap-2 mt-4">
            <button onClick={() => setIsCreateOpen(false)} className="flex-1 rounded border border-slate-300 py-2 text-slate-600 hover:bg-slate-50 font-medium">Cancel</button>
            <button onClick={handleSaveProject} className="flex-1 rounded bg-indigo-600 py-2 text-white font-medium hover:bg-indigo-700">{editingId ? 'Update Project' : 'Create Quote'}</button>
          </div>
        </div>
    </Modal>

      {/* ===== GROUP / BULK INVOICE MODAL ===== */}
      <Modal isOpen={bulkInvoiceOpen} onClose={() => { setBulkInvoiceOpen(false); setBulkFilter({ clientId: '', status: '', dateFrom: '', dateTo: '' }); }} title="Group Invoice — Update Multiple Projects">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Assign a single invoice number and date to multiple projects at once. Useful when several events are billed under one consolidated invoice.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-bold text-slate-700">Invoice Number <span className="text-red-500">*</span></label>
              <input type="text" placeholder="e.g. INV-2024-001" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={bulkInvoiceForm.invoice_no} onChange={e => setBulkInvoiceForm(f => ({ ...f, invoice_no: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Invoice Date <span className="text-red-500">*</span></label>
              <input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={bulkInvoiceForm.invoice_date} onChange={e => setBulkInvoiceForm(f => ({ ...f, invoice_date: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Status</label>
              <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={bulkInvoiceForm.invoice_status} onChange={e => setBulkInvoiceForm(f => ({ ...f, invoice_status: e.target.value }))}>
                <option value="Invoiced">Invoiced</option>
                <option value="Not Invoiced">Not Invoiced</option>
              </select>
            </div>
          </div>
          <div className="border-t pt-3">
            {/* Filters */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase">Client</label>
                <select className="w-full rounded border border-slate-300 p-1.5 text-xs text-black bg-white" value={bulkFilter.clientId} onChange={e => setBulkFilter(f => ({ ...f, clientId: e.target.value }))}>
                  <option value="">All Clients</option>
                  {clients.filter(c => c.type !== 'Vendor').sort((a,b) => (a.name||'').localeCompare(b.name||'')).map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase">Status</label>
                <select className="w-full rounded border border-slate-300 p-1.5 text-xs text-black bg-white" value={bulkFilter.status} onChange={e => setBulkFilter(f => ({ ...f, status: e.target.value }))}>
                  <option value="">All Eligible</option>
                  <option value="Confirmed">Confirmed</option>
                  <option value="Ongoing">Ongoing</option>
                  <option value="Completed">Completed</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase">Start From</label>
                <input type="date" className="w-full rounded border border-slate-300 p-1.5 text-xs text-black bg-white" value={bulkFilter.dateFrom} onChange={e => setBulkFilter(f => ({ ...f, dateFrom: e.target.value }))} />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase">Start To</label>
                <input type="date" className="w-full rounded border border-slate-300 p-1.5 text-xs text-black bg-white" value={bulkFilter.dateTo} onChange={e => setBulkFilter(f => ({ ...f, dateTo: e.target.value }))} />
              </div>
            </div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-700 uppercase">Select Projects</span>
              <div className="flex gap-2">
                <button onClick={() => {
                  const eligible = projects.filter(p => {
                    if (!projectFinanceVisible(p)) return false; // owner-scope: no cross-manager grand totals
                    if (!['Confirmed','Ongoing','Completed'].includes(p.status)) return false;
                    if (bulkFilter.status && p.status !== bulkFilter.status) return false;
                    if (bulkFilter.clientId && p.client_id !== bulkFilter.clientId) return false;
                    if (bulkFilter.dateFrom && (p.start_date || '') < bulkFilter.dateFrom) return false;
                    if (bulkFilter.dateTo && (p.start_date || '') > bulkFilter.dateTo) return false;
                    return true;
                  });
                  setBulkInvoiceSelected(new Set(eligible.map(p => p.id)));
                }} className="text-xs text-indigo-600 hover:underline">Select All Visible</button>
                <span className="text-slate-300">|</span>
                <button onClick={() => setBulkInvoiceSelected(new Set())} className="text-xs text-slate-500 hover:underline">Clear</button>
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1 border rounded p-2 bg-slate-50">
              {projects.filter(p => {
                  if (!projectFinanceVisible(p)) return false; // owner-scope: no cross-manager grand totals
                  if (!['Confirmed','Ongoing','Completed'].includes(p.status)) return false;
                  if (bulkFilter.status && p.status !== bulkFilter.status) return false;
                  if (bulkFilter.clientId && p.client_id !== bulkFilter.clientId) return false;
                  if (bulkFilter.dateFrom && (p.start_date || '') < bulkFilter.dateFrom) return false;
                  if (bulkFilter.dateTo && (p.start_date || '') > bulkFilter.dateTo) return false;
                  return true;
              }).length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No projects match the current filters.</p>
              )}
              {projects
                .filter(p => {
                  if (!projectFinanceVisible(p)) return false; // owner-scope: no cross-manager grand totals
                  if (!['Confirmed','Ongoing','Completed'].includes(p.status)) return false;
                  if (bulkFilter.status && p.status !== bulkFilter.status) return false;
                  if (bulkFilter.clientId && p.client_id !== bulkFilter.clientId) return false;
                  if (bulkFilter.dateFrom && (p.start_date || '') < bulkFilter.dateFrom) return false;
                  if (bulkFilter.dateTo && (p.start_date || '') > bulkFilter.dateTo) return false;
                  return true;
                })
                .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''))
                .map(p => {
                  const client = clients.find(c => c.id === p.client_id);
                  const checked = bulkInvoiceSelected.has(p.id);
                  return (
                    <label key={p.id} className={`flex items-center gap-3 p-2 rounded cursor-pointer hover:bg-white transition ${checked ? 'bg-emerald-50 border border-emerald-200' : 'border border-transparent'}`}>
                      <input type="checkbox" className="accent-emerald-600 w-4 h-4" checked={checked} onChange={e => {
                        const next = new Set(bulkInvoiceSelected);
                        e.target.checked ? next.add(p.id) : next.delete(p.id);
                        setBulkInvoiceSelected(next);
                      }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate">{p.project_name}</div>
                        <div className="text-xs text-slate-500">{client?.name || '—'} · {fmtDate(p.start_date)} → {fmtDate(p.end_date)}</div>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-0.5">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[p.status]}`}>{p.status}</span>
                        {isProjectInvoiced(p.invoice_status) && <span className="text-[9px] text-green-600 font-medium">#{p.invoice_no}</span>}
                        <span className="text-[10px] font-semibold text-slate-700">{formatCurrency(getProjectGrandTotal(p))}</span>
                      </div>
                    </label>
                  );
                })}
            </div>
          </div>
          {bulkInvoiceSelected.size > 0 && (() => {
            let taxable = 0, gstAmt = 0, grandTotal = 0;
            for (const id of bulkInvoiceSelected) {
              const p = projects.find(x => x.id === id);
              if (!p) continue;
              if (p.package_cost && p.package_cost > 0) {
                const gstRate = p.package_cost_gst || 18;
                const base = p.package_cost;
                taxable += base;
                gstAmt += base * gstRate / 100;
                grandTotal += base * (1 + gstRate / 100);
              } else {
                (p.items || []).forEach(i => {
                  taxable += i.amount || 0;
                  gstAmt += i.gst_amount || 0;
                  grandTotal += i.total || 0;
                });
                Object.values(p.logistics_costs || {}).forEach(c => {
                  const base = c.amount || 0;
                  const g = base * ((c.gst || 0) / 100);
                  taxable += base;
                  gstAmt += g;
                  grandTotal += base + g;
                });
              }
            }
            return (
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3">
                <div className="text-xs font-bold text-indigo-700 uppercase mb-2">Invoice Summary — {bulkInvoiceSelected.size} Project{bulkInvoiceSelected.size !== 1 ? 's' : ''} Selected</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="bg-white rounded p-2 text-center border border-indigo-100">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold mb-0.5">Amount (excl. GST)</div>
                    <div className="text-sm font-bold text-slate-800">{formatCurrency(taxable)}</div>
                  </div>
                  <div className="bg-white rounded p-2 text-center border border-orange-100">
                    <div className="text-[10px] text-orange-600 uppercase font-semibold mb-0.5">GST Amount</div>
                    <div className="text-sm font-bold text-orange-700">{formatCurrency(gstAmt)}</div>
                  </div>
                  <div className="bg-indigo-600 rounded p-2 text-center">
                    <div className="text-[10px] text-indigo-200 uppercase font-semibold mb-0.5">Total Amount</div>
                    <div className="text-sm font-bold text-white">{formatCurrency(grandTotal)}</div>
                  </div>
                </div>
              </div>
            );
          })()}
          <div className="flex items-center justify-between border-t pt-3">
            <span className="text-sm text-slate-500">{bulkInvoiceSelected.size} project(s) selected</span>
            <div className="flex gap-2">
              <button onClick={() => setBulkInvoiceOpen(false)} className="px-4 py-2 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm">Cancel</button>
              <button onClick={handleBulkInvoiceApply} disabled={bulkInvoiceSelected.size === 0 || !bulkInvoiceForm.invoice_no.trim()} className="px-5 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 text-sm font-semibold disabled:opacity-50">Apply to Selected</button>
            </div>
          </div>
        </div>
      </Modal>
  </div>
  );
};

const EditItemAllocationModal = ({ isOpen, onClose, item, onSave }) => {
  const [formData, setFormData] = useState(item || {});

  useEffect(() => {
    setFormData(item || {});
  }, [item]);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Allocated Item">
      <div className="space-y-4">
        <div>
          <label className="text-xs font-bold text-slate-700">Quantity</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-white"
            value={formData?.qty || ''}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Rate</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200"
            value={formData?.rate || ''}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Days</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200"
            value={formData?.days || ''}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Description</label>
          <input
            type="text"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200"
            value={formData?.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
        </div>
        <div className="flex justify-end pt-2">
          <button
            onClick={() => onSave(formData)}
            className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default memo(Projects);
