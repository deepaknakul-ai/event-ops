import React, { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowDownRight, ArrowLeft, ArrowUpRight, Calculator, CheckCircle, ChevronDown, ChevronUp,
  ClipboardList, Copy, Download, Edit, FileCheck, FileText, History, ListChecks,
  MessageCircle, Monitor, Package, Percent, Plus, Printer, Receipt, RotateCcw,
  Search, Share2, Trash2, Truck, TrendingUp, Users, X, Zap, Upload, Image as ImageIcon
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { collection, addDoc, updateDoc, doc, deleteDoc, serverTimestamp, getDoc, arrayUnion, arrayRemove, runTransaction } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../firebase';

import { CATEGORIES, EXPENSE_CATS, LOGISTICS_TYPES, STATUS_COLORS } from '../utils/constants';
import {
  calculateLEDSignalPorts, calculateWallSpecs, formatCurrency, formatCurrencyPDF,
  getDaysDifference, getFinancialYear, getProjectGrandTotal, isDateOverlap, LEDTileModel, getEffectivePOCost
} from '../utils/helpers';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import ProjectRemarks from '../components/ProjectRemarks';
import { can } from '../utils/permissions';

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

const Projects = ({ projects, clients, inventory, expenses, employees, role, user, currentEmpId = null, db, appId, selectedProjectId, setSelectedProjectId, logAction, addToast }) => {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
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
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (snap.exists()) {
          const d = snap.data();
          setExpenseProofSettings({ threshold: d.expense_proof_threshold || 0, maxSizeMb: d.expense_proof_max_size_mb || 2 });
        }
      } catch (_) {}
    };
    fetchSettings();
  }, [db, appId]);

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
  const [quickFilter, setQuickFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;
  const [sortConfig, setSortConfig] = useState({ key: 'start_date', direction: 'desc' });

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
    venue: '', status: 'Quoted', invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '',
    items: [], assigned_employees: [], logistics_costs: {}, package_cost: 0, package_cost_gst: 18
  });

  useEffect(() => {
    if (projectId) setSelectedProjectId(projectId);
  }, [projectId, setSelectedProjectId]);

  const selectedProject = useMemo(() => {
    if (selectedProjectId == null) return null;
    const targetId = String(selectedProjectId);
    return projects.find(p => String(p.id) === targetId) || null;
  }, [projects, selectedProjectId]);

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

  const handleSaveRemark = async (projectId, newRemark) => {
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', projectId), {
      remarks: arrayUnion(newRemark)
    });
    logAction('projects', 'add_remark', projectId, newRemark, selectedProject?.project_name);
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
    if (sortedProjects.length === 0) return alert("No projects to export");
    const data = sortedProjects.map(p => ({
        "Project Name": p.project_name,
        "Client": clients.find(c => c.id === p.client_id)?.name || '',
        "Venue": p.venue,
        "Start Date": p.start_date, "End Date": p.end_date, "Setup Date": p.setup_date || '-',
        "Status": p.status, "Invoice Status": p.invoice_status || 'Not Invoiced', "Invoice No": p.invoice_no || '-',
        "Total Value": getProjectGrandTotal(p)
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
            return setupCondition || startCondition;
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

      return matchesStart && matchesEnd && matchesSetup && matchesClient && matchesStatus && matchesInvoice && matchesQuick;
    });
  }, [projects, filters, isDefaultFilter, quickFilter]);

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
  const getAvailableQty = (itemId) => {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return 0;
    if (!selectedProject?.start_date || !selectedProject?.end_date) return item.total;
    const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
    const usedQty = overlappingProjs.reduce((acc, p) => {
      const alloc = (p.items || []).find(i => i.item_id === itemId);
      return acc + (alloc ? (parseInt(alloc.qty) || 0) : 0);
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
      venue: '', status: 'Quoted', invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '', 
      items: [], assigned_employees: [], logistics_costs: {}, package_cost: 0, package_cost_gst: 18
    });
    setClientSearchQuery('');
    setIsCreateOpen(true);
  };

  const openEdit = (proj) => {
    setEditingId(proj.id);
    setNewProj({ 
      project_name: proj.project_name, client_id: proj.client_id, 
      start_date: proj.start_date, end_date: proj.end_date, setup_date: proj.setup_date || '',
      venue: proj.venue, status: proj.status, 
      invoice_status: proj.invoice_status || 'Not Invoiced', // Load existing
      invoice_no: proj.invoice_no || '', 
      invoice_date: proj.invoice_date || '',
      items: proj.items || [], assigned_employees: proj.assigned_employees || [], logistics_costs: proj.logistics_costs || {},
      package_cost: proj.package_cost || 0, package_cost_gst: proj.package_cost_gst || 18
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
        if (!can(role, 'projects', 'delete')) return alert('Access denied: only Admin can delete projects.');
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
        logAction('projects', 'delete', id, {}, projName);
      }
    });
  };

  const handleSaveProject = async () => {
    if (editingId ? !can(role, 'projects', 'edit') : !can(role, 'projects', 'create')) return addToast('Access denied: insufficient permissions.', 'error');
    if(!newProj.client_id || !newProj.project_name) return addToast("Missing Client or Project Name", 'error');
    
    // Ensure default invoice status
    const data = { 
        ...newProj, 
        invoice_status: newProj.invoice_status || 'Not Invoiced',
        updated_at: serverTimestamp() 
    };

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
    if (!can(role, 'projects', 'edit')) return alert('Access denied: insufficient permissions.');
    if (newStatus === 'Closed' && !can(role, 'projects', 'close')) return alert("Only Admin can close projects.");
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
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), { status: newStatus });
    logAction('projects', 'status_change', pid, { status: newStatus }, selectedProject?.project_name);
  };

  const handleSaveConfirmation = async (skip = false) => {
    if (!can(role, 'projects', 'edit')) return alert('Access denied: insufficient permissions.');
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
    if (!can(role, 'projects', 'edit')) return addToast('Access denied: insufficient permissions.', 'error');
    if (!selectedProject) return;
    const token = selectedProject.quote_approval_token || Date.now().toString(36) + Math.random().toString(36).slice(2);
    // Token expires in 30 days
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
        quote_approval_token: token,
        quote_approval_expires_at: expiresAt,
        quote_status: selectedProject.quote_status || 'pending',
      });
      const url = `${window.location.origin}/quote-approval/${token}`;
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
    if (!confirm('Delete this reimbursable expense?')) return;
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
    const token = selectedProject.reimbursable_token || Date.now().toString(36) + Math.random().toString(36).slice(2);
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
      reimbursable_token: token, reimbursable_token_expires_at: expiresAt
    });
    const url = `${window.location.origin}/reimbursable/${token}`;
    setReimbursableShareUrl(url);
    setIsReimbursableShareOpen(true);
    logAction('projects', 'share_reimbursable', selectedProject.id, {}, selectedProject.project_name);
  };

  const reimbursableTotal = useMemo(() => {
    if (!selectedProject?.reimbursable_expenses) return 0;
    return selectedProject.reimbursable_expenses.reduce((acc, e) => acc + (parseFloat(e.amount) || 0), 0);
  }, [selectedProject?.reimbursable_expenses]);

  const handleDuplicate = (project) => {
    if(!confirm(`Duplicate "${project.project_name}" to create a new quote?`)) return;
    
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

const generateQuotationPDF = async () => {
    const doc = new jsPDF();
    const org = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    const pageWidth = doc.internal.pageSize.width;
    const margin = 14;
    let y = 20;

    // Header
    if (org?.logo) {
        try { doc.addImage(org.logo, 'JPEG', margin, 15, 25, 25); } catch (e) { console.warn("Logo add failed", e); }
    }
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text(org?.name || "Quotation", pageWidth - margin, 25, { align: 'right' });
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const orgAddr = doc.splitTextToSize(org?.address || "", 80);
    doc.text(orgAddr, pageWidth - margin, 32, { align: 'right' });
    y = 50;

    // Client & Project Details
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Quote To:", margin, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(client?.name || '', margin, y);
    y += 5;
    const clientAddr = doc.splitTextToSize(client?.address || "", 80);
    doc.text(clientAddr, margin, y);
    y += clientAddr.length * 5 + 2;
    if (client?.gstin) doc.text(`GSTIN: ${client.gstin}`, margin, y);

    doc.text(`Quote #: ${selectedProject.id.slice(-6)}`, pageWidth - margin, y - 15, { align: 'right' });
    doc.text(`Date: ${new Date().toLocaleDateString()}`, pageWidth - margin, y - 10, { align: 'right' });
    
    y += 10;

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text(`Subject: Quotation for ${selectedProject.project_name}`, margin, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.text(`Venue: ${selectedProject.venue}`, margin, y);
    y += 5;
    doc.text(`Event Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, margin, y);
    y += 10;

    const totals = calculateProjectTotals();

    // Table
    let head = [['#', 'Item Description', 'Qty', 'Days', 'Rate', 'GST', 'Amount']];
    let body = [];
    let grandTotal = 0;

    if (totals.use_package_cost) {
        (selectedProject.items || []).forEach((item, idx) => {
            body.push([
                idx + 1,
                item.item_name + (item.description ? `\n(${item.description})` : ''),
                item.qty,
                item.days,
                '-',
                '-',
                'Included'
            ]);
        });
        grandTotal = totals.total_revenue;
    } else {
        (selectedProject.items || []).forEach((item, idx) => {
            body.push([
                idx + 1,
                item.item_name + (item.description ? `\n(${item.description})` : ''),
                item.qty,
                item.days,
                formatCurrencyPDF(item.rate),
                `${item.gst_rate}%`,
                formatCurrencyPDF(item.total)
            ]);
        });
        (LOGISTICS_TYPES).forEach(lt => {
            const cost = selectedProject.logistics_costs?.[lt.id];
            if (cost && cost.amount > 0) {
                const total = cost.amount * (1 + (cost.gst || 0) / 100);
                body.push([
                    body.length + 1,
                    lt.label,
                    1,
                    1,
                    formatCurrencyPDF(cost.amount),
                    `${cost.gst || 0}%`,
                    formatCurrencyPDF(total)
                ]);
            }
        });
        grandTotal = totals.total_revenue;
    }

    autoTable(doc, {
        startY: y,
        head: head,
        body: body,
        theme: 'grid',
        headStyles: { fillColor: [41, 51, 61] },
        styles: { fontSize: 8, cellPadding: 2 },
        columnStyles: {
            0: { cellWidth: 8 },
            1: { cellWidth: 'auto' },
            2: { halign: 'center' },
            3: { halign: 'center' },
            4: { halign: 'right' },
            5: { halign: 'center' },
            6: { halign: 'right' }
        }
    });

    y = doc.lastAutoTable.finalY;

    // Insert LED Wall details (if any allocations have LED metadata)
    const ledItems = (selectedProject.items || []).filter(it => it.led);
    if (ledItems.length > 0) {
      y += 6;
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text("LED Wall Details:", margin, y);
      y += 6;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      ledItems.forEach(li => {
        const s = li.led.specs;
        if (!s) return;
        const portCalc = calculateLEDSignalPorts(s.resolution.totalPixelWidth, s.resolution.totalPixelHeight);
        const line = `${li.item_name} — ${li.led.tilesWide}×${li.led.tilesHigh} tiles | Size: ${s.physicalDimensions.totalWidthM}m × ${s.physicalDimensions.totalHeightM}m | Res: ${s.resolution.totalPixelWidth}×${s.resolution.totalPixelHeight} px | Power: ${s.power.maxPowerWatts}W / ${s.power.avgPowerWatts}W`;
        const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2);
        doc.text(wrapped, margin, y);
        y += wrapped.length * 5 + 2;
        if (portCalc) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(8);
          const portLine = `Technical: CAT 6 Ports - Primary: ${portCalc.primaryPorts} | Backup: ${portCalc.backupPorts} | Total: ${portCalc.totalPortsWithBackup}`;
          doc.text(portLine, margin + 5, y);
          y += 5;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
        }
        if (y > doc.internal.pageSize.height - 40) { doc.addPage(); y = 20; }
      });
    }

    // Totals Table
    let summaryBody;
    if (totals.use_package_cost) {
        summaryBody = [
            ['Package Cost (excl. GST)', formatCurrencyPDF(totals.package_cost)],
            [`GST (${selectedProject.package_cost_gst || 18}%)`, formatCurrencyPDF(totals.total_revenue - totals.package_cost)],
            ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
    } else {
        const subtotal = totals.equipment + totals.logistics;
        summaryBody = [
            ['Subtotal', formatCurrencyPDF(subtotal)],
            ['Total GST', formatCurrencyPDF(totals.gst_output)],
            ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
    }

    autoTable(doc, {
        startY: y + 5,
        body: summaryBody,
        theme: 'plain',
        tableWidth: 90,
        margin: { left: pageWidth - margin - 90 },
        styles: { fontSize: 9, cellPadding: 1.5 },
        columnStyles: {
            0: { halign: 'right', cellWidth: 50, fontStyle: 'bold' },
            1: { halign: 'right' }
        },
        didDrawCell: (data) => {
            if (data.row.index === data.table.body.length - 1) { // Grand Total row
                data.cell.styles.fontStyle = 'bold';
                data.cell.styles.fontSize = 10;
                doc.setLineWidth(0.2);
                doc.line(data.cell.x, data.cell.y, data.cell.x + data.cell.width, data.cell.y);
            }
        }
    });

    y = doc.lastAutoTable.finalY + 10;

    // Terms
    if (org?.po_terms) {
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        doc.text("Terms & Conditions:", margin, y);
        y += 5;
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        const terms = doc.splitTextToSize(org.po_terms, pageWidth - (margin * 2));
        doc.text(terms, margin, y);
        y += (terms.length * 4) + 10;
    }

    // Signature
    doc.text("For " + (org?.name || "Your Company"), pageWidth - margin, y, { align: 'right' });
    y += 20;
    doc.text("Authorized Signatory", pageWidth - margin, y, { align: 'right' });

    doc.save(`Quotation_${selectedProject.project_name.replace(/\s/g, '_')}.pdf`);
  };

  const generateQuotationExcel = () => {
    const totals = calculateProjectTotals();
    let data = [];

    if (totals.use_package_cost) {
        (selectedProject.items || []).forEach((item, idx) => {
            data.push({
                '#': idx + 1,
                'Item Description': item.item_name + (item.description ? ` (${item.description})` : ''),
                'Qty': item.qty,
                'Days': item.days,
                'Rate': 'Included',
                'GST %': '-',
                'Amount': 'Included'
            });
        });
        data.push({}); // Spacer
        data.push({ 'Item Description': 'Package Cost (excl. GST)', 'Amount': totals.package_cost });
        data.push({
            'Item Description': `GST (${selectedProject.package_cost_gst || 18}%)`, 'Amount': totals.total_revenue - totals.package_cost
        });
    } else {
        (selectedProject.items || []).forEach((item, idx) => {
            data.push({
                '#': idx + 1,
                'Item Description': item.item_name + (item.description ? ` (${item.description})` : ''),
                'Qty': item.qty,
                'Days': item.days,
                'Rate': item.rate,
                'GST %': item.gst_rate,
                'Amount': item.total
            });
        });
        (LOGISTICS_TYPES).forEach(lt => {
            const cost = selectedProject.logistics_costs?.[lt.id];
            if (cost && cost.amount > 0) {
                const total = cost.amount * (1 + (cost.gst || 0) / 100);
                data.push({
                    '#': data.length + 1,
                    'Item Description': lt.label,
                    'Qty': 1,
                    'Days': 1,
                    'Rate': cost.amount,
                    'GST %': cost.gst || 0,
                    'Amount': total
                });
            }
        });
    }

    // Add LED details for Excel export
    const ledItemsForExcel = (selectedProject.items || []).filter(i => i.led);
    if (ledItemsForExcel.length > 0) {
      data.push({});
      data.push({ 'Item Description': 'LED Wall Details' });
      ledItemsForExcel.forEach(li => {
        const s = li.led?.specs || {};
        const portCalc = calculateLEDSignalPorts(s.resolution?.totalPixelWidth || 0, s.resolution?.totalPixelHeight || 0);
        data.push({ 'Item Description': `${li.item_name} — ${li.led.tilesWide}x${li.led.tilesHigh} tiles`, 'Qty': li.qty, 'Days': li.days, 'Rate': li.rate, 'GST %': li.gst_rate, 'Amount': li.total });
        data.push({ 'Item Description': `Size: ${s.physicalDimensions?.totalWidthM || ''}m x ${s.physicalDimensions?.totalHeightM || ''}m`, 'Amount': '' });
        data.push({ 'Item Description': `Resolution: ${s.resolution?.totalPixelWidth || ''} x ${s.resolution?.totalPixelHeight || ''} px`, 'Amount': '' });
        data.push({ 'Item Description': `Power (Max/Avg): ${s.power?.maxPowerWatts || ''} W / ${s.power?.avgPowerWatts || ''} W`, 'Amount': '' });
        if (portCalc) {
          data.push({ 'Item Description': `Technical - CAT 6 Ports (Primary: ${portCalc.primaryPorts} | Backup: ${portCalc.backupPorts} | Total: ${portCalc.totalPortsWithBackup})`, 'Amount': '' });
        }
        data.push({});
      });
    }

    data.push({}); // Spacer
    data.push({
        'Item Description': 'Grand Total',
        'Amount': totals.total_revenue
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Quotation");
    XLSX.writeFile(wb, `Quotation_${selectedProject.project_name.replace(/\s/g, '_')}.xlsx`);
  };

  const generateFinalReportPDF = async () => {
    if (!selectedProject) return;

    const doc = new jsPDF();
    const org = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    const totals = calculateProjectTotals();
    const totalRevenue = totals.equipment + totals.logistics + totals.gst_output;
    const totalCost = totals.outsourcing + totals.direct_expense + totals.gst_input;
    // Operating profit uses BASE amounts only — GST collected & paid cancel out for registered business
    const margin = (totals.equipment + totals.logistics) - (totals.outsourcing + totals.direct_expense);

    const pageWidth = doc.internal.pageSize.width;
    const marginX = 14;
    let y = 18;

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(org?.name || 'Final Project Report', marginX, y);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${selectedProject.project_name}`, marginX, y + 7);
    doc.text(`Client: ${client?.name || '-'}`, marginX, y + 12);
    doc.text(`Dates: ${selectedProject.start_date || '-'} to ${selectedProject.end_date || '-'}`, marginX, y + 17);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, pageWidth - marginX, y + 7, { align: 'right' });
    y += 24;

    autoTable(doc, {
      startY: y,
      head: [['Cost Center', 'Amount']],
      body: [
        ['Equipment Revenue (Base)', formatCurrencyPDF(totals.equipment)],
        ['Logistics Revenue (Base)', formatCurrencyPDF(totals.logistics)],
        ['Total Revenue (Base, Excl. GST)', formatCurrencyPDF(totals.equipment + totals.logistics)],
        ['Outsourcing Cost (Base)', formatCurrencyPDF(totals.outsourcing)],
        ['Direct Expenses', formatCurrencyPDF(totals.direct_expense)],
        ['Total Cost (Base)', formatCurrencyPDF(totals.outsourcing + totals.direct_expense)],
        ['Operating Profit / Loss', formatCurrencyPDF(margin)],
        ['— GST Output (Collected)', formatCurrencyPDF(totals.gst_output)],
        ['— GST Input / ITC (Paid)', formatCurrencyPDF(totals.gst_input)],
        ['— Net GST Payable to Govt', formatCurrencyPDF(totals.gst_payable)],
        ...(totals.reimbursable > 0 ? [
          ['Client Reimbursable (As Actual)', formatCurrencyPDF(totals.reimbursable)],
          ['Total Client Payable', formatCurrencyPDF(totals.total_client_payable)],
        ] : []),
      ],
      didParseCell: (data) => {
        if (data.section === 'body') {
          // Bold the profit row (index 6)
          if (data.row.index === 6) data.cell.styles.fontStyle = 'bold';
          // Bold the total client payable row (last row when reimbursable exists)
          if (totals.reimbursable > 0 && data.row.index === data.table.body.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = [240, 253, 250];
          }
        }
      },
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] }
    });

    y = doc.lastAutoTable.finalY + 8;

    autoTable(doc, {
      startY: y,
      head: [['Vendor', 'Item', 'Qty', 'Days', 'Base', 'GST %', 'Total']],
      body: outsourcingRows.length > 0
        ? outsourcingRows.map(r => [
            r.vendor,
            r.item,
            r.qty,
            r.days,
            formatCurrencyPDF(r.base),
            `${r.gstRate}%`,
            formatCurrencyPDF(r.total)
          ])
        : [['-', '-', '-', '-', '-', '-', '-']],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [220, 38, 38] }
    });

    y = doc.lastAutoTable.finalY + 8;

    autoTable(doc, {
      startY: y,
      head: [['Date', 'Employee', 'Category', 'Amount', 'Remarks']],
      body: expenseDateRows.length > 0
        ? expenseDateRows.map(r => [
            r.date ? new Date(r.date).toLocaleDateString('en-IN') : '-',
            r.employee,
            r.category,
            formatCurrencyPDF(r.amount),
            r.remarks || '-'
          ])
        : [['-', '-', '-', '-', '-']],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 116, 144] }
    });

    y = doc.lastAutoTable.finalY + 8;

    autoTable(doc, {
      startY: y,
      head: [['Employee', 'Category', 'Total']],
      body: expenseByEmployeeCategory.length > 0
        ? expenseByEmployeeCategory.map(r => [r.employee, r.category, formatCurrencyPDF(r.total)])
        : [['-', '-', '-']],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [16, 185, 129] }
    });

    doc.save(`Final_Report_${selectedProject.project_name.replace(/\s/g, '_')}.pdf`);
  };


  // --- Print Handler ---
  const printProjectDocument = async (type) => {
    if (!selectedProject) return;

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

  const printChallanPDF = async (challanData) => {
    try {
        const pdfDoc = new jsPDF();
        const pageWidth = pdfDoc.internal.pageSize.width;
        const orgSettings = await getOrgSettings();
        const isReturn = challanData.type === 'return';
        const displayChallanNo = isReturn ? `RET/${challanData.challan_no}` : challanData.challan_no;
        const todayStr = new Date(challanData.date).toLocaleDateString('en-IN');

        // --- Header Section (Org Details) ---
        let y = 15;
        if (orgSettings?.logo) {
            try {
                pdfDoc.addImage(orgSettings.logo, 'JPEG', 14, 10, 25, 25);
            } catch (e) { console.warn("Logo add failed", e); }
        }
        
        pdfDoc.setFontSize(16);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(orgSettings?.name || "RENTAL OPS", 45, 18);
        
        pdfDoc.setFontSize(9);
        pdfDoc.setFont("helvetica", "normal");
        const addrLines = pdfDoc.splitTextToSize(orgSettings?.address || "", 100);
        pdfDoc.text(addrLines, 45, 24);
        
        let headerY = 24 + (addrLines.length * 4);
        if (orgSettings?.gstin) pdfDoc.text(`GSTIN: ${orgSettings.gstin}`, 45, headerY);
        if (orgSettings?.pan) pdfDoc.text(`PAN: ${orgSettings.pan}`, 100, headerY);
        
        // Ensure we start below the header
        y = Math.max(y + 25, headerY + 10);

        // Title
        pdfDoc.setFontSize(14);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "RETURN CHALLAN" : "DELIVERY CHALLAN", pageWidth - 14, 20, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(isReturn ? "(Material Returning from Project)" : "(Authority to carry inventory for Project Execution)", pageWidth - 14, 25, { align: 'right' });

        pdfDoc.setFontSize(10);
        pdfDoc.text(`Challan No: ${displayChallanNo}`, pageWidth - 14, 32, { align: 'right' });
        pdfDoc.text(`Date: ${todayStr}`, pageWidth - 14, 37, { align: 'right' });

        pdfDoc.setLineWidth(0.5); pdfDoc.line(14, y, pageWidth - 14, y);
        y += 5;

        // --- Consignee & Transport Details ---
        const client = clients.find(c=>c.id===selectedProject.client_id);
        
        // Left: Consignee
        pdfDoc.setFontSize(10);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "Received From (Client):" : "Consignee (Client):", 14, y);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(client?.name || '-', 14, y + 5);
        const clientAddr = pdfDoc.splitTextToSize(client?.address || "Address not available", 80);
        pdfDoc.text(clientAddr, 14, y + 10);
        if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, 14, y + 10 + (clientAddr.length * 4) + 2);

        // Right: Transport & Project
        pdfDoc.text(`Project: ${selectedProject.project_name}`, 110, y);
        pdfDoc.text(`Venue: ${selectedProject.venue}`, 110, y + 5);
        pdfDoc.text(isReturn ? `Return To: ${orgSettings?.address ? 'Warehouse / Office' : 'Warehouse'}` : `Dispatch To: ${challanForm.dispatch_address || selectedProject.venue}`, 110, y + 10);
        
        // Calculate Y based on address height to avoid overlap
        y = Math.max(y + 25, y + 10 + (clientAddr.length * 4) + 10);

        const transport = challanData.transport || {};
        pdfDoc.rect(14, y, pageWidth - 28, 18);
        pdfDoc.setFontSize(9);
        pdfDoc.text(`Transport Mode: ${transport.mode || '-'}`, 16, y + 6);
        pdfDoc.text(`Vehicle No: ${transport.vehicle_no || '-'}`, 80, y + 6);
        pdfDoc.text(`E-Way Bill: ${transport.eway_bill || '-'}`, 150, y + 6);
        pdfDoc.text(`Driver: ${transport.driver_name || '-'} (${transport.driver_mobile || '-'})`, 16, y + 12);

        // --- Inventory Table ---
        y += 25;
        const items = (challanData.items || []).map((i, idx) => {
            const invItem = inventory.find(inv => inv.id === i.item_id);
            return [
                idx + 1, 
                `${i.item_name}\nSN: ${invItem?.serial_number || '-'}`, 
                invItem?.hsn_code || '-',
                i.qty, 
                `${i.days} Days`,
                formatCurrencyPDF(i.rate),
                formatCurrencyPDF(i.total)
            ];
        });

        autoTable(pdfDoc, { 
            startY: y, 
            head: [['#', 'Description of Goods', 'HSN/SAC', 'Qty', 'Duration', 'Rate', 'Amount']], 
            body: items, 
            theme: 'grid',
            margin: { left: 14, right: 14 },
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' }, 
            headStyles: { fillColor: [50, 50, 50], textColor: 255 },
            columnStyles: { 
                0: { cellWidth: 8 }, 
                1: { cellWidth: 58 }, 
                2: { cellWidth: 14 },
                3: { cellWidth: 10, halign: 'center' },
                4: { cellWidth: 14, halign: 'center' },
                5: { cellWidth: 18, halign: 'right' },
                6: { cellWidth: 54, halign: 'right', cellPadding: { top: 2, bottom: 2, left: 2, right: 10 } }
            }
        });
        
        let finalY = ((pdfDoc.lastAutoTable && pdfDoc.lastAutoTable.finalY) || y + 50) + 10;

        if (orgSettings?.challan_terms) {
            pdfDoc.setFontSize(9);
            pdfDoc.setFont("helvetica", "bold");
            pdfDoc.text("Terms & Conditions:", 14, finalY);
            pdfDoc.setFont("helvetica", "normal");
            pdfDoc.setFontSize(8);
            const terms = pdfDoc.splitTextToSize(orgSettings.challan_terms, pageWidth - 28);
            pdfDoc.text(terms, 14, finalY + 5);
            finalY += 10 + (terms.length * 3.5);
        }
        
        // --- Footer / Declarations ---
        pdfDoc.setFontSize(8);
        pdfDoc.text("Declaration:", 14, finalY);
        pdfDoc.text(isReturn ? "1. Material returning from project site to warehouse." : "1. The goods are being transported for project execution purpose only and not for sale.", 14, finalY + 5);
        pdfDoc.text(isReturn ? "2. Not for sale." : "2. The goods will be returned to the consignor after completion of the project.", 14, finalY + 9);
        
        pdfDoc.setLineWidth(0.5); 
        pdfDoc.line(14, finalY + 25, 80, finalY + 25); 
        pdfDoc.text("Authorized Signatory", 14, finalY + 30); 
        pdfDoc.text(`For ${orgSettings?.name || 'Company'}`, 14, finalY + 34);

        pdfDoc.line(pageWidth - 90, finalY + 25, pageWidth - 14, finalY + 25); 
        pdfDoc.text(isReturn ? "Sender's Signature (Client)" : "Receiver's Signature & Stamp", pageWidth - 90, finalY + 30);
        
        pdfDoc.save(`${isReturn ? 'Return' : 'Delivery'}_Challan_${displayChallanNo.replace('/','-')}.pdf`);
    } catch (error) {
        console.error("Challan PDF Error:", error);
        alert("Failed to generate Challan PDF. See console for details.");
    }
  };

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
                alert(`Error: Item "${item.item_name}" exceeds available quantity. Max: ${maxQty}, Requested: ${qty}`);
                return;
            }
            itemsToShip.push({ ...item, qty });
        }
    }

    if (itemsToShip.length === 0) return alert("Please select at least one item.");
    if (!can(role, 'challans', 'create')) return alert('Access denied: insufficient permissions.');

    try {
        let challanData = { ...editingChallan };
        
        if (!editingChallan) {
            const fy = getFinancialYear();
            const newChallanNo = await runTransaction(db, async (transaction) => {
                const counterRef = doc(db, 'artifacts', appId, 'public', 'data', 'counters', 'challan');
                const counterDoc = await transaction.get(counterRef);
                let currentCount = 0;
                if (counterDoc.exists()) {
                    const data = counterDoc.data();
                    currentCount = (data && typeof data[fy] === 'number') ? data[fy] : 0;
                }
                const nextCount = currentCount + 1;
                transaction.set(counterRef, { [fy]: nextCount }, { merge: true });
                return `${fy}/${String(nextCount).padStart(4, '0')}`;
            });
            
            challanData = {
                id: Date.now().toString(),
                challan_no: newChallanNo,
                type: challanType,
                created_by: user.uid,
                date: new Date().toISOString()
            };
        }

        challanData.items = itemsToShip;
        challanData.transport = challanForm;
        challanData.date = new Date(challanForm.date).toISOString();
        challanData.updated_at = new Date().toISOString();

        const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id);
        
        if (editingChallan) {
            await updateDoc(projectRef, { challans: arrayRemove(editingChallan) });
        }
        
        await updateDoc(projectRef, { 
            challans: arrayUnion(challanData),
            ...(!selectedProject.challan_no && challanType === 'delivery' ? { challan_no: challanData.challan_no, challan_date: challanData.date } : {})
        });
        
        logAction('projects', editingChallan ? 'update_challan' : 'create_challan', selectedProject.id, { challan_no: challanData.challan_no }, selectedProject.project_name);
        
        if (confirm("Challan Saved. Print now?")) {
            printChallanPDF(challanData);
        }
        setIsChallanModalOpen(false);
    } catch (e) {
        console.error(e);
        alert(`Error saving challan: ${e.message}`);
    }
  };

  const handleDeleteChallan = async (challan) => {
    if (!can(role, 'challans', 'delete')) return alert('Access denied: only Admin can delete challans.');
    setDeleteConfirm({
      isOpen: true,
      requireTyped: false,
      title: `Delete Challan ${challan.challan_no}`,
      message: `Are you sure you want to delete Challan ${challan.challan_no}? This action cannot be undone.`,
      onConfirm: async () => {
        try {
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
                challans: arrayRemove(challan)
            });
            logAction('projects', 'delete_challan', selectedProject.id, { challan_no: challan.challan_no }, selectedProject.project_name);
        } catch(e) {
            console.error(e);
            alert("Failed to delete challan");
        }
      }
    });
  };

  // ==========================================
  // PROFORMA INVOICE HANDLERS
  // ==========================================

  const handleSaveProformaInvoice = async () => {
    if (!can(role, 'projects', 'invoice')) return alert('Access denied: insufficient permissions.');
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

      if (confirm(`Proforma Invoice ${newPiNo} saved. Print now?`)) {
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
    if (!can(role, 'projects', 'delete')) return alert('Access denied: insufficient permissions.');
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

  const generateProformaInvoicePDF = async (piData) => {
    try {
      const pdfDoc = new jsPDF();
      const org = await getOrgSettings();
      const client = clients.find(c => c.id === selectedProject.client_id);
      const pageWidth = pdfDoc.internal.pageSize.width;
      const pageH = pdfDoc.internal.pageSize.height;
      const margin = 14;
      const COMPACT_HEADER_H = 28; // height occupied by compact header on pages 2+
      const piDate = piData.date ? new Date(piData.date).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN');
      let y = 15;

      // ── Compact header drawn on every page except page 1 ──────────────────
      const drawCompactHeader = () => {
        const currentPage = pdfDoc.internal.getCurrentPageInfo().pageNumber;
        if (currentPage === 1) return;
        pdfDoc.setFillColor(41, 51, 61);
        pdfDoc.rect(margin, 5, pageWidth - margin * 2, 16, 'F');
        pdfDoc.setFontSize(10);
        pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.text(org?.name || 'Company', margin + 3, 14);
        pdfDoc.text('PROFORMA INVOICE', pageWidth / 2, 14, { align: 'center' });
        pdfDoc.text(`${piData.pi_no}  |  ${piDate}`, pageWidth - margin - 2, 14, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.text(selectedProject.project_name, pageWidth / 2, 20, { align: 'center' });
        pdfDoc.setTextColor(0, 0, 0);
      };

      // Helper: add page + compact header, returns starting y for content
      const addNewPage = () => {
        pdfDoc.addPage();
        drawCompactHeader();
        return COMPACT_HEADER_H + 2;
      };

      // ── PAGE 1 FULL HEADER ─────────────────────────────────────────────────
      if (org?.logo) {
        try { pdfDoc.addImage(org.logo, 'JPEG', margin, 10, 25, 25); } catch(e) { console.warn('Logo failed', e); }
      }
      pdfDoc.setFontSize(14);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text(org?.name || 'Company', pageWidth - margin, 18, { align: 'right' });
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'normal');
      const orgAddr = pdfDoc.splitTextToSize(org?.address || '', 80);
      pdfDoc.text(orgAddr, pageWidth - margin, 24, { align: 'right' });
      let orgInfoY = 24 + orgAddr.length * 4;
      if (org?.gstin) { pdfDoc.text(`GSTIN: ${org.gstin}`, pageWidth - margin, orgInfoY, { align: 'right' }); orgInfoY += 4; }
      if (org?.phone) { pdfDoc.text(`Ph: ${org.phone}`, pageWidth - margin, orgInfoY, { align: 'right' }); }

      // Title banner
      y = Math.max(orgInfoY + 6, 46);
      pdfDoc.setFillColor(41, 51, 61);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, 10, 'F');
      pdfDoc.setFontSize(13);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.setTextColor(255, 255, 255);
      pdfDoc.text('PROFORMA INVOICE', pageWidth / 2, y + 7, { align: 'center' });
      pdfDoc.setTextColor(0, 0, 0);
      y += 14;

      // PI number / date row
      pdfDoc.setFontSize(9);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('PI No: ', margin, y);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text(piData.pi_no, margin + 12, y);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text(`Date: ${piDate}`, pageWidth - margin, y, { align: 'right' });
      y += 6;

      // Client & Project Info box
      pdfDoc.setDrawColor(200, 200, 200);
      pdfDoc.setLineWidth(0.3);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, 28, 'S');
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('Bill To:', margin + 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text(client?.name || '—', margin + 2, y + 10);
      const cAddr = pdfDoc.splitTextToSize(client?.address || '', 85);
      pdfDoc.text(cAddr, margin + 2, y + 15);
      if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, margin + 2, y + 15 + cAddr.length * 4);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('Project:', pageWidth / 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal');
      const projNameWrapped = pdfDoc.splitTextToSize(selectedProject.project_name, 80);
      pdfDoc.text(projNameWrapped, pageWidth / 2, y + 10);
      pdfDoc.text(`Venue: ${selectedProject.venue || '—'}`, pageWidth / 2, y + 18);
      pdfDoc.text(`Event: ${selectedProject.start_date || ''} to ${selectedProject.end_date || ''}`, pageWidth / 2, y + 23);
      y += 32;

      // ── ITEMS TABLE ───────────────────────────────────────────────────────
      const snapshotItems = piData.items_snapshot || [];
      const snapshotLogistics = piData.logistics_snapshot || {};
      const usePkgCost = piData.package_cost && piData.package_cost > 0;
      let tableBody = [];
      let grandTotal = 0;

      if (usePkgCost) {
        snapshotItems.forEach((item, idx) => {
          tableBody.push([idx + 1, item.item_name + (item.description ? `\n(${item.description})` : ''), item.qty, item.days, '—', '—', 'Included']);
        });
        const pkgGst = (piData.package_cost * (piData.package_cost_gst || 18)) / 100;
        grandTotal = piData.package_cost + pkgGst;
      } else {
        snapshotItems.forEach((item, idx) => {
          tableBody.push([idx + 1, item.item_name + (item.description ? `\n(${item.description})` : ''), item.qty, item.days, formatCurrencyPDF(item.rate), `${item.gst_rate}%`, formatCurrencyPDF(item.total)]);
          grandTotal += item.total || 0;
        });
        LOGISTICS_TYPES.forEach(lt => {
          const cost = snapshotLogistics[lt.id];
          if (cost && cost.amount > 0) {
            const ltTotal = cost.amount * (1 + (cost.gst || 0) / 100);
            tableBody.push([tableBody.length + 1, lt.label, 1, 1, formatCurrencyPDF(cost.amount), `${cost.gst || 0}%`, formatCurrencyPDF(ltTotal)]);
            grandTotal += ltTotal;
          }
        });
      }

      autoTable(pdfDoc, {
        startY: y,
        head: [['#', 'Description', 'Qty', 'Days', 'Rate', 'GST %', 'Amount']],
        body: tableBody,
        theme: 'grid',
        headStyles: { fillColor: [41, 51, 61], fontSize: 8 },
        styles: { fontSize: 8, cellPadding: 2 },
        columnStyles: { 0: { cellWidth: 8 }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'right' }, 5: { halign: 'center' }, 6: { halign: 'right' } },
        didDrawPage: () => { drawCompactHeader(); }
      });
      y = pdfDoc.lastAutoTable.finalY + 4;

      // Totals summary
      let summaryBody;
      if (usePkgCost) {
        const pkgGst = (piData.package_cost * (piData.package_cost_gst || 18)) / 100;
        summaryBody = [
          ['Package Cost (excl. GST)', formatCurrencyPDF(piData.package_cost)],
          [`GST (${piData.package_cost_gst || 18}%)`, formatCurrencyPDF(pkgGst)],
          ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
      } else {
        const subtotal = snapshotItems.reduce((a, i) => a + (i.amount || 0), 0) + LOGISTICS_TYPES.reduce((a, lt) => { const c = snapshotLogistics[lt.id]; return a + (c?.amount || 0); }, 0);
        const totalGst = grandTotal - subtotal;
        summaryBody = [
          ['Subtotal (excl. GST)', formatCurrencyPDF(subtotal)],
          ['Total GST', formatCurrencyPDF(totalGst)],
          ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
      }

      autoTable(pdfDoc, {
        startY: y,
        body: summaryBody,
        theme: 'plain',
        styles: { fontSize: 9, cellPadding: 2 },
        columnStyles: { 0: { halign: 'right', fontStyle: 'bold', cellWidth: 120 }, 1: { halign: 'right', fontStyle: 'normal' } },
        didParseCell: (data) => {
          if (data.row.index === summaryBody.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fontSize = 11;
            data.cell.styles.textColor = [79, 70, 229];
          }
        },
        didDrawPage: () => { drawCompactHeader(); }
      });
      y = pdfDoc.lastAutoTable.finalY + 8;

      // ── BANK DETAILS ──────────────────────────────────────────────────────
      if (y + 90 > pageH - 12) { y = addNewPage(); }
      const banks = org?.bank_accounts || [];
      const defBank = banks.find(b => b.id === org?.default_bank_id) || banks[0];
      if (defBank) {
        pdfDoc.setFillColor(240, 245, 255);
        pdfDoc.setDrawColor(180, 200, 240);
        pdfDoc.setLineWidth(0.3);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, 30, 'FD');
        pdfDoc.setFontSize(9);
        pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setTextColor(30, 60, 120);
        pdfDoc.text('Payment Bank Details:', margin + 3, y + 6);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.setTextColor(0, 0, 0);
        pdfDoc.setFontSize(8);
        const colW = (pageWidth - margin * 2) / 2 - 4;
        pdfDoc.text(`Bank: ${defBank.bank_name}`, margin + 3, y + 12);
        pdfDoc.text(`A/C Name: ${defBank.account_name}`, margin + 3, y + 17);
        pdfDoc.text(`A/C No: ${defBank.account_no}`, margin + 3, y + 22);
        pdfDoc.text(`IFSC: ${defBank.ifsc}${defBank.branch ? `  |  Branch: ${defBank.branch}` : ''}`, margin + colW + 6, y + 12);
        if (defBank.upi_id) pdfDoc.text(`UPI: ${defBank.upi_id}`, margin + colW + 6, y + 17);
        y += 34;
      }

      // Notes
      if (piData.notes) {
        if (y + 12 > pageH - 12) { y = addNewPage(); }
        pdfDoc.setFontSize(8);
        pdfDoc.setFont('helvetica', 'italic');
        pdfDoc.setTextColor(100, 100, 100);
        const noteLines = pdfDoc.splitTextToSize(`Notes: ${piData.notes}`, pageWidth - margin * 2);
        pdfDoc.text(noteLines, margin, y);
        pdfDoc.setTextColor(0, 0, 0);
        y += noteLines.length * 4 + 4;
      }

      // Disclaimer
      if (y + 8 > pageH - 12) { y = addNewPage(); }
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'italic');
      pdfDoc.setTextColor(150, 150, 150);
      pdfDoc.text('* This is a Proforma Invoice only and is NOT a Tax Invoice. Actual invoice will be raised after project completion.', margin, y);
      pdfDoc.setTextColor(0, 0, 0);
      y += 8;

      // Reference to T&C
      if (y + 50 > pageH - 12) { y = addNewPage(); }
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'italic');
      pdfDoc.setTextColor(80, 80, 80);
      pdfDoc.text('* Please read the Payment Terms and Conditions below before signing.', margin, y);
      pdfDoc.setTextColor(0, 0, 0);
      y += 6;

      // ── SIGNATURES ────────────────────────────────────────────────────────
      pdfDoc.setLineWidth(0.5);
      pdfDoc.setDrawColor(0, 0, 0);
      pdfDoc.line(margin, y + 15, margin + 60, y + 15);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.setFontSize(8);
      pdfDoc.text('Authorized Signatory', margin, y + 20);
      pdfDoc.text(`For ${org?.name || 'Company'}`, margin, y + 25);
      pdfDoc.line(pageWidth - margin - 60, y + 15, pageWidth - margin, y + 15);
      pdfDoc.text("Client's Signature & Acceptance", pageWidth - margin - 60, y + 20);
      y += 32;

      // ── PAYMENT TERMS & CONDITIONS BOX ───────────────────────────────────
      const terms = piData.payment_terms || org?.payment_terms || '';
      if (terms) {
        if (y + 20 > pageH - 12) { y = addNewPage(); }
        const termLines = pdfDoc.splitTextToSize(terms, pageWidth - margin * 2 - 8);
        const boxH = termLines.length * 4.5 + 14;
        pdfDoc.setFillColor(255, 251, 235);
        pdfDoc.setDrawColor(210, 180, 80);
        pdfDoc.setLineWidth(0.4);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, boxH, 'FD');
        pdfDoc.setFontSize(8.5);
        pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setTextColor(120, 80, 0);
        pdfDoc.text('PAYMENT TERMS AND CONDITIONS', margin + 3, y + 7);
        pdfDoc.setLineWidth(0.2);
        pdfDoc.line(margin + 3, y + 9, margin + (pageWidth - margin * 2) - 3, y + 9);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.setFontSize(8);
        pdfDoc.setTextColor(60, 40, 0);
        pdfDoc.text(termLines, margin + 4, y + 13);
        pdfDoc.setTextColor(0, 0, 0);
        pdfDoc.setDrawColor(0, 0, 0);
      }

      // ── PAGE NUMBERS (post-process all pages) ────────────────────────────
      const totalPages = pdfDoc.internal.getNumberOfPages();
      for (let pg = 1; pg <= totalPages; pg++) {
        pdfDoc.setPage(pg);
        pdfDoc.setFontSize(7.5);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.setTextColor(140, 140, 140);
        pdfDoc.text(
          `Page ${pg} of ${totalPages}`,
          pageWidth - margin,
          pageH - 4,
          { align: 'right' }
        );
        pdfDoc.text(
          `${piData.pi_no}  |  ${selectedProject.project_name}`,
          margin,
          pageH - 4
        );
        pdfDoc.setTextColor(0, 0, 0);
      }

      pdfDoc.save(`ProformaInvoice_${piData.pi_no.replace(/\//g, '-')}_${selectedProject.project_name.replace(/\s/g, '_')}.pdf`);
    } catch (err) {
      console.error('Proforma Invoice PDF Error:', err);
      addToast('Failed to generate Proforma Invoice PDF', 'error');
    }
  };

  const downloadEWayBillJSON = async () => {
    const orgSettings = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    
    if (!orgSettings || !client) return alert("Organization or Client details missing.");

    const itemsToShip = (selectedProject.items || []).filter(item => (challanSelection[item.id] || 0) > 0).map(item => ({
        ...item,
        qty: parseInt(challanSelection[item.id])
    }));

    if (itemsToShip.length === 0) return alert("Select items first.");

    const ewayData = {
        "supplyType": "O",
        "subSupplyType": "8", // Exhibition or Fairs
        "docType": "CHL",
        "docNo": "DRAFT",
        "docDate": new Date().toLocaleDateString('en-IN'),
        "fromGstin": orgSettings.gstin || "URP",
        "fromTrdName": orgSettings.name || "",
        "fromAddr1": orgSettings.address || "",
        "fromPlace": "", 
        "fromPincode": 100000, // Placeholder
        "toGstin": client.gstin || "URP",
        "toTrdName": client.name || "",
        "toAddr1": client.address || "",
        "toPlace": "",
        "toPincode": 100000, // Placeholder
        "itemList": itemsToShip.map(item => ({
            "productName": item.item_name,
            "hsnCode": parseInt(inventory.find(i=>i.id===item.item_id)?.hsn_code || 0),
            "quantity": parseInt(item.qty),
            "qtyUnit": "NOS",
            "taxableAmount": parseFloat(item.amount),
            "sgstRate": 0, "cgstRate": 0, "igstRate": 0 // Rates to be filled by user in portal if needed
        })),
        "transMode": challanForm.mode === 'Road' ? 1 : challanForm.mode === 'Rail' ? 2 : challanForm.mode === 'Air' ? 3 : 4,
        "transDistance": 0,
        "transporterName": "",
        "transDocNo": challanForm.eway_bill || "",
        "transDocDate": new Date().toLocaleDateString('en-IN'),
        "vehicleNo": challanForm.vehicle_no || ""
    };

    const blob = new Blob([JSON.stringify(ewayData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EWayBill_${selectedProject.challan_no || 'Draft'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // --- NEW INVOICE HANDLER ---
  const updateInvoiceDetails = async (field, value) => {
    if (!can(role, 'projects', 'invoice')) return alert('Access denied: insufficient permissions.');
    // Constraint: Can only update if Completed or Closed
    const isCompleted = selectedProject.status === 'Completed' || selectedProject.status === 'Closed';
    
    // Allow Admin to force edit even if not completed, otherwise block
    if (!isCompleted && role !== 'admin') {
        return alert("Project must be 'Completed' before invoicing.");
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
    if (!can(role, 'projects', 'team_manage')) return alert('Access denied: insufficient permissions.');
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
    if (!can(role, 'projects', 'allocation')) return alert('Access denied: insufficient permissions.');
    if(!allocationForm.item_id) return alert("Select an item");
    const item = inventory.find(i => i.id === allocationForm.item_id);
    // If LED allocation, compute tile-based quantities from tilesWide/tilesHigh
    let finalQty = parseInt(allocationForm.qty);
    let ledSpecs = null;
    if (allocationForm.is_led) {
      // Ensure tile model data exists
      if (!allocationForm.tileModelData) return alert('Selected LED item is missing technical tile details. Please add tile specs to inventory.');
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
      if (w <= 0 || h <= 0) return alert('Enter valid Tile Width (tiles) and Tile Height (tiles) for LED wall.');

      ledSpecs = calculateWallSpecs(tileModel, w, h, 230);
      finalQty = ledSpecs?.logistics?.totalTilesNeeded || (w * h);
      // Use availability check against total tiles owned
      if (finalQty > (allocationForm.tileModelData?.inventory?.totalTiles || item.total || 0)) {
        if (!confirm(`Warning: You are allocating ${finalQty} tiles but only ${allocationForm.tileModelData?.inventory?.totalTiles || item.total || 0} are available. Proceed?`)) return;
      }
    } else {
      if (allocationForm.qty > allocationForm.available_qty) {
        if(!confirm(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
      }
    }

    const amount = finalQty * allocationForm.rate * allocationForm.days;
    const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(finalQty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100), description: allocationForm.description || '' };
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
    if (!can(role, 'projects', 'allocation')) return alert('Access denied: insufficient permissions.');
    const qty = parseInt(updatedItem.qty) || 0;
    const rate = parseFloat(updatedItem.rate) || 0;
    const days = parseInt(updatedItem.days) || 0;
    const gst_rate = parseFloat(updatedItem.gst_rate) || 0;
    
    const amount = qty * rate * days;
    const gst_amount = amount * (gst_rate / 100);
    const total = amount + gst_amount;

    const finalItem = { ...updatedItem, qty, rate, days, amount, gst_amount, total };

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
    if (!can(role, 'projects', 'allocation')) return alert('Access denied: insufficient permissions.');
    if(confirm("Remove this item?")) {
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
      // Use package cost
      const gstRate = selectedProject.package_cost_gst || 18;
      equipmentBase = selectedProject.package_cost;
      equipmentGST = (selectedProject.package_cost * gstRate) / 100;
      gstOutput = equipmentGST;
      totalRevenueBase = equipmentBase;
    } else {
      // Use items and logistics
      equipmentBase = (selectedProject.items || []).reduce((acc, i) => acc + (i.amount || 0), 0);
      equipmentGST = (selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0);
      if (selectedProject.logistics_costs) {
        Object.values(selectedProject.logistics_costs).forEach(c => {
           const base = c.amount || 0; logisticsBase += base; logisticsGST += base * ((c.gst || 0)/100);
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
        <div className="flex items-center justify-between">
          <button onClick={() => { setSelectedProjectId(null); navigate('/projects'); }} className="flex items-center text-slate-500 hover:text-indigo-600 transition-colors">
            <ArrowLeft size={18} className="mr-2" /> Back to Projects
          </button>
          <div className="flex items-center gap-2">
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
            {role !== 'tech' && (
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

        {/* ===== SECTION 3: KEY INFO CARDS ===== */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1">Start Date</div>
            <div className="text-lg font-bold text-slate-800">{selectedProject.start_date || '—'}</div>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1">End Date</div>
            <div className="text-lg font-bold text-slate-800">{selectedProject.end_date || '—'}</div>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
            <div className="text-xs text-slate-500 uppercase font-semibold mb-1">Setup Date</div>
            <div className="text-lg font-bold text-indigo-600">{selectedProject.setup_date || '—'}</div>
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
                {selectedProject.confirmation_details.advance_committed > 0 && (
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
                onClose={() => setNotesOpen(false)}
              />
            </div>
          )}
        </div>

        {/* ===== SECTION 4: QUICK ACTIONS BAR ===== */}
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 uppercase mr-2">Documents:</span>
            <button onClick={() => printProjectDocument('quotation_pdf')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-indigo-50 hover:border-indigo-200 text-slate-700 transition-all">
              <FileText size={16} className="text-indigo-500" /> Quote PDF
            </button>
            <button onClick={() => printProjectDocument('quotation_excel')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-green-50 hover:border-green-200 text-slate-700 transition-all">
              <FileText size={16} className="text-green-500" /> Quote Excel
            </button>
            <button onClick={() => printProjectDocument('job_sheet')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-amber-50 hover:border-amber-200 text-slate-700 transition-all">
              <Printer size={16} className="text-amber-500" /> Job Sheet
            </button>
            <button onClick={() => printProjectDocument('pick_list')} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-purple-50 hover:border-purple-200 text-slate-700 transition-all">
              <ListChecks size={16} className="text-purple-500" /> Pick List
            </button>
            <button onClick={generateFinalReportPDF} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50 hover:border-slate-300 text-slate-700 transition-all">
              <FileText size={16} className="text-slate-600" /> Final Report
            </button>
            <button onClick={() => { setProformaForm({ date: new Date().toISOString().split('T')[0], notes: '', payment_terms: '' }); setIsProformaModalOpen(true); }} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-teal-50 hover:border-teal-200 text-slate-700 transition-all">
              <Receipt size={16} className="text-teal-600" /> Proforma Invoice
            </button>
            {(selectedProject.proforma_invoices || []).length > 0 && (
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

            {selectedProject.status === 'Quoted' && (role === 'admin' || role === 'manager') && (
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
                        <th className="p-3 text-center">Days</th>
                        {role !== 'tech' && <th className="p-3 text-right">Rate</th>}
                        {role !== 'tech' && <th className="p-3 text-right">Amount</th>}
                        {role !== 'tech' && <th className="p-3 text-right">GST Amt</th>}
                        {role !== 'tech' && <th className="p-3 text-right">Total Amt</th>}
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
                          <td className="p-3 text-center">{item.days}</td>
                          {role !== 'tech' && <td className="p-3 text-right text-slate-600">{formatCurrency(item.rate)}</td>}
                          {role !== 'tech' && <td className="p-3 text-right text-slate-700">{formatCurrency(item.amount || (item.qty * item.rate * item.days))}</td>}
                          {role !== 'tech' && <td className="p-3 text-right text-amber-700">{formatCurrency(item.gst_amount || ((item.amount || item.qty * item.rate * item.days) * item.gst_rate / 100))}</td>}
                          {role !== 'tech' && <td className="p-3 text-right font-semibold text-indigo-700">{formatCurrency(item.total)}</td>}
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
                    {role !== 'tech' && (
                      <tfoot className="bg-indigo-50 font-bold text-indigo-700 text-sm">
                        <tr>
                          <td colSpan={4} className="p-3 text-right rounded-l-lg">Equipment Total:</td>
                          <td className="p-3 text-right text-slate-700">{formatCurrency(totals.equipment)}</td>
                          <td className="p-3 text-right text-amber-700">{formatCurrency((selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0))}</td>
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
            {role !== 'tech' && (
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
                        const saved = (selectedProject.logistics_costs || {})[type.id] || { amount: 0, gst: 18 };
                        const total = (saved.amount || 0) * (1 + (saved.gst || 0) / 100);
                        return (
                          <tr key={type.id} className="hover:bg-slate-50">
                            <td className="p-3 flex items-center gap-2">
                              <span className="text-slate-400">{type.icon}</span>
                              <span className="text-slate-700 font-medium">{type.label}</span>
                            </td>
                            <td className="p-3">
                              <input type="number" min="0" className="w-full rounded-lg border border-slate-200 p-2 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400" value={saved.amount} onChange={(e) => updateLogisticsCost(type.id, 'amount', e.target.value)} disabled={role === 'tech'} />
                            </td>
                            <td className="p-3">
                              <select className="w-full rounded-lg border border-slate-200 p-2 focus:ring-2 focus:ring-indigo-200" value={saved.gst} onChange={(e) => updateLogisticsCost(type.id, 'gst', e.target.value)} disabled={role === 'tech'}>
                                <option value="0">0%</option>
                                <option value="5">5%</option>
                                <option value="12">12%</option>
                                <option value="18">18%</option>
                                <option value="28">28%</option>
                              </select>
                            </td>
                            <td className="p-3 text-right font-medium text-slate-800">{formatCurrency(total)}</td>
                          </tr>
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
                  <button onClick={() => setIsEmpModalOpen(true)} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
                    Manage
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {(selectedProject.assigned_employees || []).length > 0 ? (
                  (selectedProject.assigned_employees || []).map(empId => {
                    const emp = employees.find(e => e.id === empId);
                    return (
                      <div key={empId} className="flex items-center gap-2 rounded-full bg-blue-50 border border-blue-100 px-3 py-1.5 text-sm">
                        <div className="h-6 w-6 rounded-full bg-blue-200 flex items-center justify-center text-xs font-bold text-blue-700">
                          {emp?.name?.charAt(0) || '?'}
                        </div>
                        <span className="text-slate-700 font-medium">{emp?.name || 'Unknown'}</span>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-sm text-slate-400 italic py-2">No team members assigned.</div>
                )}
              </div>
            </div>

            {/* Expenses Card */}
            <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                <Receipt size={18} className="text-red-500" /> Project Expenses
              </h3>
              <div className="text-3xl font-bold text-red-600">
                {formatCurrency(expenses.filter(e => e.project_id === selectedProject.id && !isExpenseExcludedStatus(e.status)).reduce((s, e) => s + parseFloat(e.amount), 0))}
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {expenses.filter(e => e.project_id === selectedProject.id && !isExpenseExcludedStatus(e.status)).length} expense(s) recorded
              </div>
            </div>

            {/* Invoice Card */}
            {role !== 'tech' && (
              <div className={`rounded-xl p-6 shadow-sm border transition-colors ${selectedProject.invoice_status === 'Invoiced' ? 'bg-green-50 border-green-200' : 'bg-white border-slate-100'}`}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <FileText size={18} className="text-green-600" /> Invoice Status
                  </h3>
                  <div className={`text-xs px-2 py-1 rounded-full font-medium ${selectedProject.invoice_status === 'Invoiced' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
                    {selectedProject.invoice_status || 'Not Invoiced'}
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Status</label>
                    <select
                      disabled={!isInvoicingEnabled}
                      className={`w-full rounded-lg border p-2 text-sm ${!isInvoicingEnabled ? 'bg-slate-100 cursor-not-allowed' : 'bg-white border-slate-200 focus:ring-2 focus:ring-green-200'}`}
                      value={selectedProject.invoice_status || 'Not Invoiced'}
                      onChange={(e) => updateInvoiceDetails('invoice_status', e.target.value)}
                    >
                      <option value="Not Invoiced">Not Invoiced</option>
                      <option value="Invoiced">Invoiced</option>
                    </select>
                  </div>

                  {selectedProject.invoice_status === 'Invoiced' && (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Invoice No.</label>
                        <input
                          type="text"
                          className="w-full rounded-lg border border-slate-200 p-2 text-sm focus:ring-2 focus:ring-green-200"
                          placeholder="INV-2024-001"
                          value={selectedProject.invoice_no || ''}
                          onChange={(e) => updateInvoiceDetails('invoice_no', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Invoice Date</label>
                        <input
                          type="date"
                          className="w-full rounded-lg border border-slate-200 p-2 text-sm focus:ring-2 focus:ring-green-200"
                          value={selectedProject.invoice_date || ''}
                          onChange={(e) => updateInvoiceDetails('invoice_date', e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {!isInvoicingEnabled && (
                    <div className="text-xs text-orange-600 flex items-center gap-1 font-medium bg-orange-50 px-3 py-2 rounded-lg">
                      <AlertCircle size={12} /> Complete project to invoice
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Financial Summary Card */}
            {role !== 'tech' && (
              <div className="rounded-xl bg-gradient-to-br from-indigo-50 to-blue-50 p-6 shadow-sm border border-indigo-100">
                <h3 className="font-bold text-slate-800 text-lg mb-4 flex items-center gap-2">
                  <Calculator size={18} className="text-indigo-600" /> Summary
                </h3>
                <div className="space-y-3 text-sm">
                  {totals.use_package_cost ? (
                    <>
                      <div className="flex justify-between"><span className="text-slate-600">Package Cost</span><span className="font-medium text-slate-600">{formatCurrency(totals.equipment)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-600">GST ({selectedProject.package_cost_gst || 18}%)</span><span className="font-medium text-green-600">+{formatCurrency(totals.gst_output)}</span></div>
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
        {role !== 'tech' && (
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
        {role !== 'tech' && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                <ClipboardList size={20} className="text-indigo-600" /> Final Project Report
              </h3>
              <button onClick={generateFinalReportPDF} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                Export PDF
              </button>
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
                  <ResponsiveContainer width="100%" height="100%">
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
        {role !== 'tech' && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-teal-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                <Receipt size={20} className="text-teal-600" /> Client Reimbursable Expenses
                <span className="text-xs font-normal text-slate-400 ml-1">(As Actual)</span>
              </h3>
              <div className="flex items-center gap-2">
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
              <div className="grid grid-cols-2 gap-4">
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

        {/* ===== PROFORMA INVOICE MODALS ===== */}
        {/* Create Proforma Invoice */}
        <Modal isOpen={isProformaModalOpen} onClose={() => setIsProformaModalOpen(false)} title="Create Proforma Invoice">
          <div className="space-y-4">
            <div className="bg-teal-50 border border-teal-200 rounded p-3 text-xs text-teal-800">
              A new Proforma Invoice will be auto-numbered (<span className="font-mono font-semibold">PI/FY/XXXX</span>) and a snapshot of current items will be saved.
            </div>

            <div className="grid grid-cols-2 gap-4">
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

        {/* ... (Keep existing Modals: Allocation, Employee) ... */}
        <Modal isOpen={isAllocationModalOpen} onClose={() => { setIsAllocationModalOpen(false); setShowItemDropdown(false); }} title="Allocate Equipment">
          <div className="space-y-4">
            {/* ===== SEARCHABLE ITEM COMBOBOX ===== */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Select Item</label>
              <div ref={itemComboRef} className="relative">
                {/* Row: category filter + search input */}
                <div className="flex gap-2">
                  <select
                    className="rounded border border-slate-300 px-2 py-2 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-indigo-500 shrink-0 max-w-[140px]"
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
                    return matchCat && matchQ;
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
            <div className="grid grid-cols-2 gap-4">
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
                <div className="grid grid-cols-2 gap-3">
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
            <div className="space-y-4"><div className="space-y-2 max-h-96 overflow-y-auto">{employees.map(emp => { const isAssigned = (selectedProject.assigned_employees || []).includes(emp.id); const isBusy = !isAssigned && isEmployeeBusy(emp.id); return (<div key={emp.id} className={`flex items-center justify-between p-3 rounded border cursor-pointer ${isAssigned ? 'bg-indigo-50 border-indigo-200' : isBusy ? 'bg-orange-50 border-orange-200' : 'bg-white hover:bg-slate-50'}`} onClick={() => toggleEmployee(emp.id)}><div className="flex items-center gap-3"><div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold ${isBusy ? 'bg-orange-200 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{emp.name.charAt(0)}</div><div><div className="font-medium text-slate-800 flex items-center gap-2">{emp.name}{isBusy && <span className="text-[10px] bg-orange-100 text-orange-700 px-1 rounded border border-orange-200">Busy</span>}</div><div className="text-xs text-slate-500 capitalize">{emp.role}</div></div></div><div className={`h-5 w-5 rounded border flex items-center justify-center ${isAssigned ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300'}`}>{isAssigned && <CheckCircle size={14} />}</div></div>); })}</div><div className="flex justify-end pt-2"><button onClick={() => setIsEmpModalOpen(false)} className="rounded bg-slate-50 px-6 py-2 text-black hover:bg-slate-50">Done</button></div></div>
        </Modal>

        {/* ===== QUICK EXPENSE MODAL ===== */}
        <Modal isOpen={isQuickExpenseOpen} onClose={() => setIsQuickExpenseOpen(false)} title="Log Quick Expense">
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
              Logging expense for: <span className="font-bold">{selectedProject?.project_name}</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
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
            <div className="grid grid-cols-2 gap-4">
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
          {(role === 'manager' || role === 'admin') && (
            <div className="flex gap-2 w-full md:w-auto">
                <button onClick={exportFilteredProjects} className="flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-50 whitespace-nowrap w-full md:w-auto"><Download size={18} /> Export</button>
                <button onClick={openCreate} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap w-full md:w-auto">
                    <Plus size={18} /> Create New Quote
                </button>
            </div>
          )}
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
                    <option value="total_value">Total Value</option>
                </select>
                <button onClick={() => setSortConfig(prev => ({ ...prev, direction: prev.direction === 'asc' ? 'desc' : 'asc' }))} className="px-2 rounded border bg-slate-50 hover:bg-slate-100 text-slate-800" title="Toggle Direction">
                    {sortConfig.direction === 'asc' ? '↑' : '↓'}
                </button>
            </div>
         </div>
         <div className="flex items-end">
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
                    {project.invoice_status === 'Invoiced' && <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded border border-green-200" title={`Inv#: ${project.invoice_no}`}>INVOICED</span>}
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
                  <div className="font-semibold text-slate-800">{project.setup_date || '—'}</div>
                  {setupToStart > 0 && <div className="text-xs text-slate-600">({setupToStart} days before)</div>}
                </div>
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Start Date</div>
                  <div className="font-semibold text-slate-800">{project.start_date}</div>
                </div>
              </div>

              {/* Column 2: Duration & Venue */}
              <div className="space-y-2">
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Duration</div>
                  <div className="font-semibold text-slate-800">{daysDiff} days</div>
                  <div className="text-xs text-slate-600">End: {project.end_date}</div>
                </div>
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-xs text-slate-500 font-semibold uppercase">Venue</div>
                  <div className="font-semibold text-slate-800 truncate" title={project.venue}>{project.venue || '—'}</div>
                </div>
              </div>

              {/* Column 3: Project Value & Items */}
              <div className="space-y-2">
                <div className="bg-indigo-50 rounded p-2 border border-indigo-100">
                  <div className="text-xs text-indigo-600 font-semibold uppercase">Project Value</div>
                  <div className="font-bold text-indigo-700">{formatCurrency(getProjectGrandTotal(project))}</div>
                  <div className="text-xs text-indigo-600">{(project.items || []).length} items</div>
                </div>
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
              <div className="absolute bottom-4 right-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                onChange={e => { setClientSearchQuery(e.target.value); setShowClientDropdown(true); if (!e.target.value) setNewProj({...newProj, client_id: ''}); }}
                onFocus={() => setShowClientDropdown(true)}
              />
              {newProj.client_id && !showClientDropdown && (
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => { setNewProj({...newProj, client_id: ''}); setClientSearchQuery(''); setShowClientDropdown(true); }}><X size={16} /></button>
              )}
              {showClientDropdown && (
                <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded border bg-white shadow-lg">
                  {clients.filter(c => c.name?.toLowerCase().includes(clientSearchQuery.toLowerCase())).length === 0 ? (
                    <li className="px-3 py-2 text-sm text-slate-400">No clients found</li>
                  ) : (
                    clients.filter(c => c.name?.toLowerCase().includes(clientSearchQuery.toLowerCase())).map(c => (
                      <li key={c.id} className={`cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50 ${newProj.client_id === c.id ? 'bg-indigo-100 font-semibold' : ''}`}
                        onClick={() => { setNewProj({...newProj, client_id: c.id}); setClientSearchQuery(c.name); setShowClientDropdown(false); }}>
                        {c.name}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
              <div><label className="text-sm font-bold text-slate-800">Setup Date</label><input type="date" className="w-full rounded border p-2 text-slate-800" value={newProj.setup_date} onChange={e => { const v = e.target.value; setNewProj(prev => ({ ...prev, setup_date: v, start_date: v, end_date: v })); }} /></div>
              <div><label className="text-sm font-bold text-slate-800">Start Date</label><input type="date" className="w-full rounded border p-2 text-slate-800" value={newProj.start_date} onChange={e => setNewProj({...newProj, start_date: e.target.value})} /></div>
              <div><label className="text-sm font-bold text-slate-800">End Date</label><input type="date" className="w-full rounded border p-2 text-slate-800" value={newProj.end_date} onChange={e => setNewProj({...newProj, end_date: e.target.value})} /></div>
          </div>
          <div><label className="text-sm font-bold text-slate-800">Venue</label><input className="w-full rounded border p-2 text-slate-800" value={newProj.venue} onChange={e => setNewProj({...newProj, venue: e.target.value})} /></div>
          
          {/* Package Cost Section */}
          <div className="border-t pt-3 mt-3">
            <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-3">
              <p className="text-xs text-blue-700"><strong>Package Cost:</strong> If specified, this will be the final revenue for P&L and client invoicing, superseding item allocations and logistics costs.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
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
