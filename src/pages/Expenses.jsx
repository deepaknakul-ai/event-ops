import React, { useState, useEffect, useMemo, useRef } from 'react';
import { confirmDialog, promptDialog } from '../utils/dialog';
import { notify } from '../utils/toast';
import { Link } from 'react-router-dom';
import {
  Utensils, Hotel, Hammer, Briefcase, AlertCircle, Wallet,
  CheckCircle, X, Edit, Trash2, Users, ArrowLeft, TrendingUp, TrendingDown, Filter, Upload, Eye, FileText, Image as ImageIcon, IndianRupee
} from 'lucide-react';
import { collection, addDoc, updateDoc, doc, query, where, getDocs, deleteDoc, getDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../firebase';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import { formatCurrency, generateSecureToken } from '../utils/helpers';
import { assertFYNotLocked } from '../utils/fyLock';
import { STATUS_COLORS, EXPENSE_CATS } from '../utils/constants';
import { can } from '../utils/permissions';

// Small reusable component to show proof badge/link
const ProofBadge = ({ proof_url }) => {
  if (!proof_url) return null;
  const isPdf = proof_url.toLowerCase().includes('.pdf');
  return (
    <a href={proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100" title="View proof">
      {isPdf ? <FileText size={11} /> : <ImageIcon size={11} />} Proof
    </a>
  );
};

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

const Expenses = ({ expenses, projects, user, role, db, appId, advances = [], payouts = [], currentEmpId, employees = [], logAction, expenseCats: expenseCatsProp, lockedFYs = [] }) => {
  const expenseCats = expenseCatsProp || EXPENSE_CATS;
  const [viewMode, setViewMode] = useState('submit');
  const [batchList, setBatchList] = useState([]);
  const [expenseForm, setExpenseForm] = useState({ date: new Date().toISOString().split('T')[0], category: 'Travel', amount: '', remarks: '', is_general: false, project_id: '' });

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
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState('');
  const [editForm, setEditForm] = useState({ date: '', category: 'Travel', amount: '', remarks: '', is_general: false, project_id: '' });
  const [historyFilter, setHistoryFilter] = useState({
    time: 'all',
    project: 'all',
    startDate: '',
    endDate: '',
    status: 'all'
  });
  const [projectSearch, setProjectSearch] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const historyItemsPerPage = 20;
  const [ledgerPage, setLedgerPage] = useState(1);
  const ledgerItemsPerPage = 20;
  const [approvalsPage, setApprovalsPage] = useState(1);
  const approvalsItemsPerPage = 20;
  const [approvalFilters, setApprovalFilters] = useState({ employee: '', project: '' });
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [selectedApprovalIds, setSelectedApprovalIds] = useState([]);
  const [approvalsStatusTab, setApprovalsStatusTab] = useState('Pending');

  // Proof upload state
  const proofInputRef = useRef(null);
  const editProofInputRef = useRef(null);
  const [proofUploading, setProofUploading] = useState(false);
  const [proofFile, setProofFile] = useState(null); // { url, name, path }
  const [editProofFile, setEditProofFile] = useState(null);

  const handleProofUpload = async (file, setter) => {
    if (!file) return;
    const maxBytes = (expenseProofSettings.maxSizeMb || 2) * 1024 * 1024;
    if (file.size > maxBytes) {
      return notify(`File too large. Maximum allowed size is ${expenseProofSettings.maxSizeMb} MB.`, 'info');
    }
    setProofUploading(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `expense-proofs/${appId}/${generateSecureToken(16)}.${ext}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      setter({ url, name: file.name, path });
    } catch (err) {
      notify('Upload failed: ' + err.message, 'error');
    }
    setProofUploading(false);
  };

  const handleRemoveProof = async (proofObj, setter) => {
    if (proofObj?.path) {
      try { await deleteObject(ref(storage, proofObj.path)); } catch (_) {}
    }
    setter(null);
  };

  // --- All Tracker state ---
  const [trackerFilters, setTrackerFilters] = useState({ employee: '', project: '', category: '', status: '', startDate: '', endDate: '' });
  const [trackerPage, setTrackerPage] = useState(1);
  const trackerItemsPerPage = 25;

  // --- Employee Dashboard state ---
  const [empDashId, setEmpDashId] = useState(null);
  const [empDashStatusFilter, setEmpDashStatusFilter] = useState('all');
  const [empDashPage, setEmpDashPage] = useState(1);
  const empDashItemsPerPage = 20;

  // Use currentEmpId if available (for mapped employees), otherwise fallback to user.uid
  const effectiveUserId = currentEmpId || user.uid;

  const isProjectEligibleForExpense = (p) => {
    const eligibleStatuses = ['Confirmed', 'Ongoing', 'Completed'];
    if (!eligibleStatuses.includes(p.status)) return false;
    if (p.status === 'Completed' && p.end_date) {
      const daysSinceEnd = (new Date() - new Date(p.end_date)) / (1000 * 60 * 60 * 24);
      if (daysSinceEnd > 15) return false;
    }
    return true;
  };

  const availableProjects = useMemo(() => role === 'tech'
    ? projects.filter(p => (p.assigned_employees || []).includes(effectiveUserId) || isProjectEligibleForExpense(p))
    : projects.filter(p => isProjectEligibleForExpense(p)), [role, projects, effectiveUserId]);

  const filteredProjects = useMemo(() => availableProjects.filter(p => p.project_name.toLowerCase().includes(projectSearch.toLowerCase())), [availableProjects, projectSearch]);

  const handleAddToBatch = () => {
    if (!expenseForm.amount || (!expenseForm.is_general && !expenseForm.project_id)) return notify("Fill required fields", 'error');
    const amt = parseFloat(expenseForm.amount);
    if (expenseProofSettings.threshold > 0 && amt > expenseProofSettings.threshold && !proofFile) {
      return notify(`Proof is required for expenses above ${formatCurrency(expenseProofSettings.threshold)}. Please attach an invoice/bill/receipt.`, 'error');
    }
    setBatchList([...batchList, { ...expenseForm, amount: amt, id: Date.now(), proof_url: proofFile?.url || '', proof_path: proofFile?.path || '', proof_name: proofFile?.name || '' }]);
    setExpenseForm({ ...expenseForm, amount: '', remarks: '' });
    setProofFile(null);
  };

  const removeBatchItem = (id) => setBatchList(batchList.filter(i => i.id !== id));

  const handleSubmitBatch = async () => {
    if (!can(role, 'expenses', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    if (batchList.length === 0) return;
    // C-2 fix: every batched item's date must be in an unlocked FY.
    for (const it of batchList) {
      if (!assertFYNotLocked(it.date, lockedFYs)) return;
    }

    const successfulSubmissions = [];
    const duplicateSubmissions = [];

    for (const batchItem of batchList) {
      const { id, ...rest } = batchItem;
      const { proof_url, proof_path, proof_name, ...restFields } = rest;
      const expenseData = {
        ...restFields,
        employee_id: effectiveUserId,
        status: 'Pending',
        created_at: new Date().toISOString(),
        proof_url: proof_url || '',
        proof_path: proof_path || '',
        proof_name: proof_name || ''
      };

      // Check for duplicates before submitting
      const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'expenses'),
        where("employee_id", "==", expenseData.employee_id),
        where("date", "==", expenseData.date),
        where("amount", "==", expenseData.amount),
        where("category", "==", expenseData.category),
        where("project_id", "==", expenseData.project_id || '')
      );

      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'expenses'), expenseData);
        logAction('expenses', 'create', docRef.id, expenseData, `${expenseData.category} - ${expenseData.amount}`);
        successfulSubmissions.push(expenseData);
      } else {
        duplicateSubmissions.push(expenseData);
      }
    }

    setBatchList([]);

    let alertMessage = '';
    if (successfulSubmissions.length > 0) {
      alertMessage += `${successfulSubmissions.length} expense(s) submitted successfully.\n\n`;
    }
    if (duplicateSubmissions.length > 0) {
      const duplicateDetails = duplicateSubmissions.map(d => `- ${d.date}: ${d.category} for ${formatCurrency(d.amount)}`).join('\n');
      alertMessage += `The following ${duplicateSubmissions.length} expense(s) were not submitted as they appear to be duplicates:\n${duplicateDetails}`;
    }

    if (alertMessage) {
      notify(alertMessage, 'info');
    }
  };

  const handleApprove = async (id) => {
    if (!can(role, 'expenses', 'approve')) return notify('Access denied: only Admin, Accountant, or Manager can approve expenses.', 'error');
    // C-2 / H-7 fix: Approval makes the expense post to P&L — block when its
    // FY is already locked.
    const exp = expenses.find(e => e.id === id);
    if (exp && !assertFYNotLocked(exp.date, lockedFYs)) return;
    if (!await confirmDialog("Approve this expense?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), { status: 'Approved' });
    logAction('expenses', 'approve', id, {}, 'Expense Approved');
  };

  const handleRequestClarification = async (id) => {
    if (!can(role, 'expenses', 'approve')) return notify('Access denied: insufficient permissions.', 'error');
    const note = await promptDialog('Request clarification (required):');
    if (!note) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), {
      status: 'Clarification',
      clarification_request: note,
      clarification_requested_at: new Date().toISOString()
    });
    logAction('expenses', 'clarify', id, { clarification_request: note }, 'Clarification Requested');
  };

  const handleDisapprove = async (id) => {
    if (!can(role, 'expenses', 'approve')) return notify('Access denied: insufficient permissions.', 'error');
    const note = await promptDialog('Disapprove reason (optional):');
    if (!await confirmDialog("Disapprove this expense?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), {
      status: 'Disapproved',
      disapproved_reason: note || '',
      disapproved_at: new Date().toISOString()
    });
    logAction('expenses', 'disapprove', id, { disapproved_reason: note || '' }, 'Expense Disapproved');
  };

  const handleBulkApprove = async () => {
    if (!can(role, 'expenses', 'approve')) return notify('Access denied: insufficient permissions.', 'error');
    if (selectedApprovalIds.length === 0) return notify('Select at least one expense.', 'error');
    if (!await confirmDialog(`Approve ${selectedApprovalIds.length} expense(s)?`)) return;
    await Promise.all(selectedApprovalIds.map(id => updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), { status: 'Approved' })));
    selectedApprovalIds.forEach(id => logAction('expenses', 'approve', id, {}, 'Expense Approved'));
    setSelectedApprovalIds([]);
  };

  const handleBulkClarify = async () => {
    if (!can(role, 'expenses', 'approve')) return notify('Access denied: insufficient permissions.', 'error');
    if (selectedApprovalIds.length === 0) return notify('Select at least one expense.', 'error');
    const note = await promptDialog('Request clarification (required):');
    if (!note) return;
    if (!await confirmDialog(`Request clarification for ${selectedApprovalIds.length} expense(s)?`)) return;
    await Promise.all(selectedApprovalIds.map(id => updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), {
      status: 'Clarification',
      clarification_request: note,
      clarification_requested_at: new Date().toISOString()
    })));
    selectedApprovalIds.forEach(id => logAction('expenses', 'clarify', id, { clarification_request: note }, 'Clarification Requested'));
    setSelectedApprovalIds([]);
  };

  const handleBulkDisapprove = async () => {
    if (!can(role, 'expenses', 'approve')) return notify('Access denied: insufficient permissions.', 'error');
    if (selectedApprovalIds.length === 0) return notify('Select at least one expense.', 'error');
    const note = await promptDialog('Disapprove reason (optional):');
    if (!await confirmDialog(`Disapprove ${selectedApprovalIds.length} expense(s)?`)) return;
    await Promise.all(selectedApprovalIds.map(id => updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), {
      status: 'Disapproved',
      disapproved_reason: note || '',
      disapproved_at: new Date().toISOString()
    })));
    selectedApprovalIds.forEach(id => logAction('expenses', 'disapprove', id, { disapproved_reason: note || '' }, 'Expense Disapproved'));
    setSelectedApprovalIds([]);
  };

  const handleSubmitClarification = async (exp) => {
    const response = await promptDialog('Add clarification (required):', exp.clarification_response || '');
    if (!response) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', exp.id), {
      status: 'Clarification',
      clarification_response: response,
      clarification_responded_at: new Date().toISOString()
    });
    logAction('expenses', 'clarification_response', exp.id, { clarification_response: response }, 'Clarification Submitted');
  };

  const isEditableExpense = (exp) => exp.status !== 'Approved' && !isExpenseExcludedStatus(exp.status);

  const handleOpenEdit = (exp) => {
    if (!isEditableExpense(exp)) return;
    setEditingExpenseId(exp.id);
    setEditForm({
      date: exp.date || new Date().toISOString().split('T')[0],
      category: exp.category || 'Travel',
      amount: exp.amount || '',
      remarks: exp.remarks || '',
      is_general: !!exp.is_general,
      project_id: exp.project_id || ''
    });
    setEditProofFile(exp.proof_url ? { url: exp.proof_url, path: exp.proof_path || '', name: exp.proof_name || 'Proof' } : null);
    setIsEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!can(role, 'expenses', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if (!editingExpenseId) return;
    if (!editForm.amount || (!editForm.is_general && !editForm.project_id)) {
      return notify('Fill required fields', 'error');
    }
    if (!assertFYNotLocked(editForm.date, lockedFYs)) return;
    const orig = expenses.find(e => e.id === editingExpenseId);
    if (orig?.date && orig.date !== editForm.date && !assertFYNotLocked(orig.date, lockedFYs)) return;
    const editAmt = parseFloat(editForm.amount);
    if (expenseProofSettings.threshold > 0 && editAmt > expenseProofSettings.threshold && !editProofFile) {
      return notify(`Proof is required for expenses above ${formatCurrency(expenseProofSettings.threshold)}. Please attach an invoice/bill/receipt.`, 'error');
    }
    const payload = {
      date: editForm.date,
      category: editForm.category,
      amount: parseFloat(editForm.amount),
      remarks: editForm.remarks || '',
      is_general: !!editForm.is_general,
      project_id: editForm.is_general ? '' : editForm.project_id,
      updated_at: new Date().toISOString(),
      proof_url: editProofFile?.url || '',
      proof_path: editProofFile?.path || '',
      proof_name: editProofFile?.name || ''
    };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', editingExpenseId), payload);
    logAction('expenses', 'update', editingExpenseId, payload, 'Expense Updated');
    setIsEditOpen(false);
    setEditingExpenseId('');
  };

  const handleDeleteExpense = async (exp) => {
    if (!can(role, 'expenses', 'delete')) return notify('Access denied: insufficient permissions.', 'error');
    if (!isEditableExpense(exp)) return;
    if (!assertFYNotLocked(exp?.date, lockedFYs)) return;
    setDeleteConfirm({
      isOpen: true,
      title: 'Delete Expense',
      message: `Delete this ${exp.category} expense of ₹${exp.amount}? This action cannot be undone.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', exp.id));
        logAction('expenses', 'delete', exp.id, {}, 'Expense Deleted');
      }
    });
  };

  // Filter History & Ledger based on the Effective ID (Employee Profile ID)
  // Ensure we compare strings to strings
  const myExpenses = useMemo(() => expenses.filter(e => String(e.employee_id) === String(effectiveUserId)), [expenses, effectiveUserId]);
  const myAdvances = useMemo(() => advances.filter(a => String(a.employee_id) === String(effectiveUserId)), [advances, effectiveUserId]);
  const myPayouts = useMemo(() => payouts.filter(p => String(p.employee_id) === String(effectiveUserId)), [payouts, effectiveUserId]);

  const filteredHistory = useMemo(() => myExpenses.filter(e => {
    const d = new Date(e.date);
    const now = new Date();
    const isWeek = (now - d) / (1000 * 3600 * 24) <= 7;
    const isMonth = (now - d) / (1000 * 3600 * 24) <= 30;
    const timeMatch = historyFilter.time === 'all' ? true : historyFilter.time === 'week' ? isWeek : isMonth;
    const projMatch = historyFilter.project === 'all' ? true : e.project_id === historyFilter.project;
    const startMatch = historyFilter.startDate
      ? d >= new Date(historyFilter.startDate)
      : true;
    const endMatch = historyFilter.endDate
      ? d <= new Date(`${historyFilter.endDate}T23:59:59`)
      : true;
    const statusMatch = historyFilter.status === 'all'
      ? true
      : historyFilter.status === 'approved'
        ? e.status === 'Approved'
        : historyFilter.status === 'disapproved'
          ? isExpenseExcludedStatus(e.status)
          : historyFilter.status === 'clarification'
            ? e.status === 'Clarification'
            : historyFilter.status === 'unapproved'
              ? e.status !== 'Approved' && !isExpenseExcludedStatus(e.status)
              : true;
    return timeMatch && projMatch && startMatch && endMatch && statusMatch;
  }), [myExpenses, historyFilter]);

  useEffect(() => {
    setHistoryPage(1);
  }, [historyFilter, viewMode, filteredHistory.length]);

  const paginatedHistory = useMemo(() => {
    const start = (historyPage - 1) * historyItemsPerPage;
    return filteredHistory.slice(start, start + historyItemsPerPage);
  }, [filteredHistory, historyPage]);

  const last30DaysExpenses = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return myExpenses
      .filter(e => new Date(e.date) >= cutoff)
      .sort((a, b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        const aProject = a.is_general ? 'General Ops' : (projects.find(p => p.id === a.project_id)?.project_name || '');
        const bProject = b.is_general ? 'General Ops' : (projects.find(p => p.id === b.project_id)?.project_name || '');
        return aProject.localeCompare(bProject);
      });
  }, [myExpenses, projects]);

  useEffect(() => {
    if (viewMode === 'ledger') {
      setLedgerPage(1);
    }
  }, [viewMode, last30DaysExpenses.length]);

  const paginatedLedger = useMemo(() => {
    const start = (ledgerPage - 1) * ledgerItemsPerPage;
    return last30DaysExpenses.slice(start, start + ledgerItemsPerPage);
  }, [last30DaysExpenses, ledgerPage]);

  const approvalsExpenses = useMemo(() => {
    return expenses.filter(e => {
      if (e.status !== approvalsStatusTab) return false;
      if (approvalFilters.employee && e.employee_id !== approvalFilters.employee) return false;
      if (approvalFilters.project && e.project_id !== approvalFilters.project) return false;
      return true;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [expenses, approvalFilters, approvalsStatusTab]);

  useEffect(() => {
    setSelectedApprovalIds([]);
  }, [approvalsPage, approvalFilters, approvalsExpenses.length, viewMode, approvalsStatusTab]);

  const paginatedApprovals = useMemo(() => {
    const start = (approvalsPage - 1) * approvalsItemsPerPage;
    return approvalsExpenses.slice(start, start + approvalsItemsPerPage);
  }, [approvalsExpenses, approvalsPage]);

  const approvalPageIds = useMemo(() => paginatedApprovals.map(exp => exp.id), [paginatedApprovals]);
  const allPageSelected = approvalPageIds.length > 0 && approvalPageIds.every(id => selectedApprovalIds.includes(id));

  const toggleSelectAllOnPage = () => {
    if (allPageSelected) {
      setSelectedApprovalIds(selectedApprovalIds.filter(id => !approvalPageIds.includes(id)));
      return;
    }
    const merged = new Set([...selectedApprovalIds, ...approvalPageIds]);
    setSelectedApprovalIds(Array.from(merged));
  };

  const toggleSelectOne = (id) => {
    if (selectedApprovalIds.includes(id)) {
      setSelectedApprovalIds(selectedApprovalIds.filter(itemId => itemId !== id));
      return;
    }
    setSelectedApprovalIds([...selectedApprovalIds, id]);
  };

  const totalAdvanced = useMemo(() => myAdvances.reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0), [myAdvances]);
  const totalPayouts = useMemo(() => myPayouts.reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0), [myPayouts]);
  const totalPaymentsReceived = totalAdvanced + totalPayouts;
  const totalApprovedExpenses = useMemo(() => myExpenses
    .filter(e => e.status === 'Approved')
    .reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0), [myExpenses]);
  const totalDisapprovedExpenses = useMemo(() => myExpenses
    .filter(e => isExpenseExcludedStatus(e.status))
    .reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0), [myExpenses]);
  const totalUnapprovedExpenses = useMemo(() => myExpenses
    .filter(e => e.status !== 'Approved' && !isExpenseExcludedStatus(e.status))
    .reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0), [myExpenses]);
  const balance = totalPaymentsReceived - totalApprovedExpenses;

  // ─── Payment Statement (FY-based) ───────────────────────────────────────────
  const [paymentFyFilter, setPaymentFyFilter] = useState('ALL');
  const [paymentPage, setPaymentPage] = useState(1);
  const paymentItemsPerPage = 20;

  const getEntryFY = (dateStr) => {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Unknown';
    const m = d.getMonth();
    const y = d.getFullYear();
    if (m < 3) return `${y - 1}-${String(y).slice(-2)}`;
    return `${y}-${String(y + 1).slice(-2)}`;
  };

  const { paymentRows, paymentFyList, paymentFySummaries } = useMemo(() => {
    const raw = [];
    myPayouts.forEach(p => raw.push({
      date: p.date, desc: `Payout: ${p.mode || 'Cash'}${p.reference ? ' - ' + p.reference : ''}`,
      type: 'payout', amount: parseFloat(p.amount || 0), remarks: p.remarks || ''
    }));
    myAdvances.forEach(a => raw.push({
      date: a.date, desc: `Advance${a.remarks ? ': ' + a.remarks : ''}`,
      type: 'advance', amount: parseFloat(a.amount || 0), remarks: a.remarks || ''
    }));
    raw.sort((a, b) => new Date(a.date) - new Date(b.date));

    const fyBuckets = {};
    raw.forEach(r => { const fy = getEntryFY(r.date); if (!fyBuckets[fy]) fyBuckets[fy] = []; fyBuckets[fy].push(r); });
    const sortedFYs = Object.keys(fyBuckets).sort((a, b) => parseInt(a) - parseInt(b));

    const result = [];
    let runningTotal = 0;
    const summaries = {};

    sortedFYs.forEach((fy, fyIdx) => {
      result.push({ _type: 'fy_header', fy });
      let fyPayout = 0, fyAdvance = 0;
      if (fyIdx > 0 && runningTotal !== 0) {
        result.push({ _type: 'bcf', fy, Date: fyBuckets[fy][0]?.date || '', Description: `Balance Carried Forward from FY ${sortedFYs[fyIdx - 1]}`, Amount: runningTotal, RunningTotal: runningTotal, type: 'bcf' });
      }
      fyBuckets[fy].forEach(row => {
        runningTotal += row.amount;
        if (row.type === 'payout') fyPayout += row.amount;
        if (row.type === 'advance') fyAdvance += row.amount;
        result.push({ _type: 'row', fy, Date: row.date, Description: row.desc, type: row.type, Amount: row.amount, RunningTotal: runningTotal, remarks: row.remarks });
      });
      summaries[fy] = { payouts: fyPayout, advances: fyAdvance, total: fyPayout + fyAdvance, closing: runningTotal };
    });
    summaries['ALL'] = {
      payouts: myPayouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0),
      advances: myAdvances.reduce((s, a) => s + parseFloat(a.amount || 0), 0),
      total: myPayouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0) + myAdvances.reduce((s, a) => s + parseFloat(a.amount || 0), 0),
      closing: runningTotal
    };
    return { paymentRows: result, paymentFyList: ['ALL', ...sortedFYs], paymentFySummaries: summaries };
  }, [myPayouts, myAdvances]);

  const visiblePaymentRows = useMemo(() => {
    if (paymentFyFilter === 'ALL') return paymentRows;
    return paymentRows.filter(r => r.fy === paymentFyFilter);
  }, [paymentRows, paymentFyFilter]);

  const currentPaymentSummary = paymentFySummaries[paymentFyFilter] || { payouts: 0, advances: 0, total: 0, closing: 0 };

  const dataPaymentRows = useMemo(() => visiblePaymentRows.filter(r => r._type === 'row' || r._type === 'bcf'), [visiblePaymentRows]);
  const paginatedPaymentRows = useMemo(() => {
    const start = (paymentPage - 1) * paymentItemsPerPage;
    return visiblePaymentRows.slice(start, start + paymentItemsPerPage);
  }, [visiblePaymentRows, paymentPage]);

  useEffect(() => { setPaymentPage(1); }, [paymentFyFilter]);

  // ─── All Tracker computations ───────────────────────────────────────────────
  const trackerExpenses = useMemo(() => {
    return expenses.filter(e => {
      if (trackerFilters.employee && e.employee_id !== trackerFilters.employee) return false;
      if (trackerFilters.project) {
        if (trackerFilters.project === '__general__') { if (!e.is_general) return false; }
        else { if (e.project_id !== trackerFilters.project || e.is_general) return false; }
      }
      if (trackerFilters.category && e.category !== trackerFilters.category) return false;
      if (trackerFilters.status && e.status !== trackerFilters.status) return false;
      if (trackerFilters.startDate && new Date(e.date) < new Date(trackerFilters.startDate)) return false;
      if (trackerFilters.endDate && new Date(e.date) > new Date(`${trackerFilters.endDate}T23:59:59`)) return false;
      return true;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [expenses, trackerFilters]);

  useEffect(() => { setTrackerPage(1); }, [trackerFilters]);

  const paginatedTracker = useMemo(() => {
    const s = (trackerPage - 1) * trackerItemsPerPage;
    return trackerExpenses.slice(s, s + trackerItemsPerPage);
  }, [trackerExpenses, trackerPage]);

  const trackerSummary = useMemo(() => ({
    total: trackerExpenses.length,
    totalAmt: trackerExpenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0),
    approved: trackerExpenses.filter(e => e.status === 'Approved').reduce((s, e) => s + parseFloat(e.amount || 0), 0),
    pending: trackerExpenses.filter(e => e.status === 'Pending').reduce((s, e) => s + parseFloat(e.amount || 0), 0),
    disapproved: trackerExpenses.filter(e => isExpenseExcludedStatus(e.status)).reduce((s, e) => s + parseFloat(e.amount || 0), 0),
  }), [trackerExpenses]);

  // ─── Employee Dashboard computations ────────────────────────────────────────
  const empDashEmployee = useMemo(() => employees.find(e => e.id === empDashId), [employees, empDashId]);
  const empDashExpenses = useMemo(() => expenses.filter(e => String(e.employee_id) === String(empDashId)), [expenses, empDashId]);
  const empDashAdvances = useMemo(() => advances.filter(a => String(a.employee_id) === String(empDashId)), [advances, empDashId]);
  const empDashPayouts = useMemo(() => payouts.filter(p => String(p.employee_id) === String(empDashId)), [payouts, empDashId]);

  const empDashKpis = useMemo(() => {
    const totalAdv = empDashAdvances.reduce((s, a) => s + parseFloat(a.amount || 0), 0);
    const totalPay = empDashPayouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const approved = empDashExpenses.filter(e => e.status === 'Approved').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const pending = empDashExpenses.filter(e => e.status === 'Pending').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const clarification = empDashExpenses.filter(e => e.status === 'Clarification').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const disapproved = empDashExpenses.filter(e => isExpenseExcludedStatus(e.status)).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const received = totalAdv + totalPay;
    const balance = received - approved;
    return { totalAdv, totalPay, received, approved, pending, clarification, disapproved, balance };
  }, [empDashExpenses, empDashAdvances, empDashPayouts]);

  const empDashCatBreakdown = useMemo(() => {
    const map = {};
    empDashExpenses.forEach(e => {
      if (!map[e.category]) map[e.category] = { cat: e.category, approved: 0, pending: 0, disapproved: 0 };
      const amt = parseFloat(e.amount || 0);
      if (e.status === 'Approved') map[e.category].approved += amt;
      else if (isExpenseExcludedStatus(e.status)) map[e.category].disapproved += amt;
      else map[e.category].pending += amt;
    });
    return Object.values(map).sort((a, b) => (b.approved + b.pending) - (a.approved + a.pending));
  }, [empDashExpenses]);

  const empDashProjBreakdown = useMemo(() => {
    const map = {};
    empDashExpenses.forEach(e => {
      const key = e.is_general ? '__general__' : (e.project_id || '__general__');
      if (!map[key]) map[key] = { key, name: e.is_general ? 'General Ops' : (projects.find(p => p.id === e.project_id)?.project_name || 'Unknown'), total: 0, approved: 0 };
      map[key].total += parseFloat(e.amount || 0);
      if (e.status === 'Approved') map[key].approved += parseFloat(e.amount || 0);
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [empDashExpenses, projects]);

  const empDashFiltered = useMemo(() => {
    if (empDashStatusFilter === 'all') return empDashExpenses;
    if (empDashStatusFilter === 'approved') return empDashExpenses.filter(e => e.status === 'Approved');
    if (empDashStatusFilter === 'pending') return empDashExpenses.filter(e => e.status === 'Pending');
    if (empDashStatusFilter === 'clarification') return empDashExpenses.filter(e => e.status === 'Clarification');
    if (empDashStatusFilter === 'disapproved') return empDashExpenses.filter(e => isExpenseExcludedStatus(e.status));
    return empDashExpenses;
  }, [empDashExpenses, empDashStatusFilter]);

  useEffect(() => { setEmpDashPage(1); }, [empDashStatusFilter, empDashId]);

  const paginatedEmpDash = useMemo(() => {
    const s = (empDashPage - 1) * empDashItemsPerPage;
    return [...empDashFiltered].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(s, s + empDashItemsPerPage);
  }, [empDashFiltered, empDashPage]);

  const openEmpDash = (empId) => {
    setEmpDashId(empId);
    setEmpDashStatusFilter('all');
    setViewMode('empDash');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h2 className="text-xl sm:text-2xl font-bold text-slate-800">Expense Tracker</h2>
        <div className="flex gap-1 sm:gap-2 bg-white rounded-lg border p-1 flex-wrap">
          <button onClick={() => setViewMode('submit')} className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded ${viewMode === 'submit' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Submit</button>
          <button onClick={() => setViewMode('history')} className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded ${viewMode === 'history' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>History</button>
          <button onClick={() => setViewMode('ledger')} className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded ${viewMode === 'ledger' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Ledger</button>
          <button onClick={() => setViewMode('payments')} className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded ${viewMode === 'payments' ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-slate-600'}`}>
            <span className="flex items-center gap-1"><IndianRupee size={13} /> Payments</span>
          </button>
          {can(role, 'expenses', 'approve') && (
            <button onClick={() => setViewMode('approvals')} className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded ${viewMode === 'approvals' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Approvals</button>
          )}
          {/* Tracker / Employee Dashboard exposes company-wide payouts/salary/advances/
              net balances — payroll data, so it is Owner + Accountant only. */}
          {can(role, 'expenses', 'view_payments') && (
            <button onClick={() => setViewMode('tracker')} className={`px-2 sm:px-3 py-1 text-xs sm:text-sm rounded ${viewMode === 'tracker' || viewMode === 'empDash' ? 'bg-purple-100 text-purple-700 font-medium' : 'text-slate-600'}`}>
              <span className="flex items-center gap-1"><Users size={13} /> Tracker</span>
            </button>
          )}
        </div>
      </div>

      {viewMode === 'submit' && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200 h-fit">
            <h3 className="mb-4 font-semibold text-slate-800">New Expense Entry</h3>
            <div className="space-y-4">
              <div className="flex gap-4 border-b pb-4">
                <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="exptype" checked={!expenseForm.is_general} onChange={() => setExpenseForm({...expenseForm, is_general: false})} /><span className="text-sm font-bold text-slate-800">Project Expense</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="exptype" checked={expenseForm.is_general} onChange={() => setExpenseForm({...expenseForm, is_general: true, project_id: ''})} /><span className="text-sm font-bold text-slate-800">General / Ops</span></label>
              </div>
              {!expenseForm.is_general && (
                <div>
                  <label className="text-xs font-bold text-slate-700">Select Project</label>
                  <input type="text" className="w-full rounded border border-slate-300 p-2 mb-1 text-xs text-black" placeholder="Search project..." value={projectSearch} onChange={e => setProjectSearch(e.target.value)} />
                  <select className="w-full rounded border border-slate-300 p-2 text-black" value={expenseForm.project_id} onChange={e => setExpenseForm({...expenseForm, project_id: e.target.value})}>
                    <option value="">-- Choose Project --</option>
                    {filteredProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-bold text-slate-700">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-black" value={expenseForm.date} onChange={e => setExpenseForm({...expenseForm, date: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Category</label><select className="w-full rounded border border-slate-300 p-2 text-black" value={expenseForm.category} onChange={e => setExpenseForm({...expenseForm, category: e.target.value})}>{expenseCats.map(c => <option key={c}>{c}</option>)}</select></div></div>
              <div><label className="text-xs font-bold text-slate-700">Amount</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-black" placeholder="0.00" value={expenseForm.amount} onChange={e => setExpenseForm({...expenseForm, amount: e.target.value})} /></div>
              <div><label className="text-xs font-bold text-slate-700">Remarks</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={expenseForm.remarks} onChange={e => setExpenseForm({...expenseForm, remarks: e.target.value})} placeholder="Description..." /></div>
              <div>
                <label className="text-xs font-bold text-slate-700">Proof (Invoice/Bill/Receipt){expenseProofSettings.threshold > 0 && parseFloat(expenseForm.amount) > expenseProofSettings.threshold && !proofFile ? <span className="text-red-500 ml-1">* Required above {formatCurrency(expenseProofSettings.threshold)}</span> : null}</label>
                <input ref={proofInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleProofUpload(f, setProofFile); e.target.value = ''; }} />
                {proofFile ? (
                  <div className="flex items-center gap-2 mt-1 p-2 bg-indigo-50 rounded border border-indigo-100">
                    <a href={proofFile.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-indigo-700 hover:underline truncate flex-1">
                      {proofFile.name?.toLowerCase().endsWith('.pdf') ? <FileText size={14} /> : <ImageIcon size={14} />} {proofFile.name}
                    </a>
                    <button type="button" onClick={() => handleRemoveProof(proofFile, setProofFile)} className="text-red-400 hover:text-red-600"><X size={14} /></button>
                  </div>
                ) : (
                  <button type="button" onClick={() => proofInputRef.current?.click()} disabled={proofUploading} className="w-full mt-1 flex items-center justify-center gap-2 rounded border border-dashed border-slate-300 p-2 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition">
                    <Upload size={14} /> {proofUploading ? 'Uploading...' : 'Attach proof (photo/PDF)'}
                  </button>
                )}
              </div>
              <button onClick={handleAddToBatch} className="w-full rounded bg-slate-100 text-slate-800 py-2 hover:bg-slate-200">+ Add to Batch</button>
            </div>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200 flex flex-col h-full">
            <h3 className="mb-4 font-semibold text-slate-800 flex justify-between items-center"><span>Ready to Submit</span><span className="text-xs bg-slate-100 px-2 py-1 rounded">{batchList.length} items</span></h3>
            <div className="flex-1 overflow-y-auto space-y-2 mb-4 pr-1">{batchList.length === 0 && <div className="text-center text-slate-400 italic mt-10">No items added yet.</div>}{batchList.map(item => (<div key={item.id} className="flex justify-between items-start p-3 bg-slate-50 rounded border border-slate-100"><div><div className="font-medium text-slate-800">{item.category} - {formatCurrency(item.amount)}</div><div className="text-xs text-slate-500">{item.is_general ? 'General Ops' : projects.find(p=>p.id===item.project_id)?.project_name || 'Unknown Project'}</div>{item.remarks && <div className="text-xs text-slate-400 mt-1">"{item.remarks}"</div>}{item.proof_url && <div className="mt-1"><ProofBadge proof_url={item.proof_url} /></div>}</div><button onClick={() => removeBatchItem(item.id)} className="text-red-400 hover:text-red-600"><X size={16} /></button></div>))}</div>
            <div className="border-t pt-4"><div className="flex justify-between mb-4 font-bold text-slate-800"><span>Total</span><span>{formatCurrency(batchList.reduce((s, i) => s + parseFloat(i.amount), 0))}</span></div><button onClick={handleSubmitBatch} disabled={batchList.length === 0} className={`w-full rounded py-3 font-medium text-white ${batchList.length > 0 ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-slate-300 cursor-not-allowed'}`}>Submit All Expenses</button></div>
          </div>
        </div>
      )}

      {viewMode === 'approvals' && (
        <div className="space-y-4">
            <h3 className="font-bold text-slate-700 text-lg">{approvalsStatusTab} Expenses</h3>
            <div className="flex flex-wrap gap-2">
              {['Pending', 'Clarification', 'Disapproved'].map(status => (
                <button
                  key={status}
                  onClick={() => { setApprovalsStatusTab(status); setApprovalsPage(1); }}
                  className={`px-3 py-1 text-sm rounded border ${approvalsStatusTab === status ? 'bg-indigo-100 text-indigo-700 border-indigo-200 font-medium' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                >
                  {status}
                </button>
              ))}
            </div>
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Filter by Employee</label>
                  <select className="w-full rounded border p-2 text-sm text-black" value={approvalFilters.employee} onChange={e => setApprovalFilters({...approvalFilters, employee: e.target.value})}>
                    <option value="">All Employees</option>
                    {[...new Map(expenses.filter(e => e.status === approvalsStatusTab).map(e => [e.employee_id, employees.find(emp => emp.id === e.employee_id)])).values()].filter(Boolean).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Filter by Project</label>
                  <select className="w-full rounded border p-2 text-sm text-black" value={approvalFilters.project} onChange={e => setApprovalFilters({...approvalFilters, project: e.target.value})}>
                    <option value="">All Projects</option>
                    {[...new Map(expenses.filter(e => e.status === approvalsStatusTab && !e.is_general).map(e => [e.project_id, projects.find(p => p.id === e.project_id)])).values()].filter(Boolean).map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                  </select>
                </div>
              </div>
            </div>
              {approvalsStatusTab === 'Pending' && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm text-slate-600">Selected: {selectedApprovalIds.length}</div>
                <button onClick={handleBulkApprove} className="rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700">Approve Selected</button>
                <button onClick={handleBulkClarify} className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700">Clarify Selected</button>
                <button onClick={handleBulkDisapprove} className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700">Disapprove Selected</button>
              </div>
              )}
            {/* Mobile card layout for approvals */}
            <div className="md:hidden space-y-3">
              {paginatedApprovals.map(exp => (
                <div key={exp.id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      {approvalsStatusTab === 'Pending' && (
                        <input type="checkbox" checked={selectedApprovalIds.includes(exp.id)} onChange={() => toggleSelectOne(exp.id)} className="mt-0.5" />
                      )}
                      <div>
                        <div className="font-semibold text-slate-800">{employees.find(e => e.id === exp.employee_id)?.name || 'Unknown'}</div>
                        <div className="text-xs text-slate-500">{new Date(exp.date).toLocaleDateString()}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-slate-900">{formatCurrency(exp.amount)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-medium">{exp.category}</span>
                    {exp.is_general
                      ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span>
                      : <span className="text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">{projects.find(p=>p.id===exp.project_id)?.project_name || 'Unknown'}</span>
                    }
                  </div>
                  {exp.remarks && <div className="text-xs text-slate-500 mb-2">{exp.remarks}</div>}
                  {exp.proof_url ? (
                    <a href={exp.proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 mb-2 px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition" title="View attached proof">
                      {exp.proof_url.toLowerCase().includes('.pdf') ? <FileText size={13} /> : <ImageIcon size={13} />} View Proof
                    </a>
                  ) : (
                    <div className="text-xs text-slate-300 mb-2">No proof attached</div>
                  )}
                  {exp.clarification_request && <div className="text-xs text-amber-700 mb-1">Clarification asked: {exp.clarification_request}</div>}
                  {exp.clarification_response && <div className="text-xs text-amber-700 mb-1">Clarification submitted: {exp.clarification_response}</div>}
                  {exp.disapproved_reason && <div className="text-xs text-red-600 mb-1">Disapproved: {exp.disapproved_reason}</div>}
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    {approvalsStatusTab === 'Pending' && (<>
                      <button onClick={() => handleApprove(exp.id)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-green-700 bg-green-50 hover:bg-green-100 rounded font-medium"><CheckCircle size={15}/> Approve</button>
                      <button onClick={() => handleRequestClarification(exp.id)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-amber-700 bg-amber-50 hover:bg-amber-100 rounded font-medium"><AlertCircle size={15}/> Clarify</button>
                      <button onClick={() => handleDisapprove(exp.id)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-red-700 bg-red-50 hover:bg-red-100 rounded font-medium"><X size={15}/> Reject</button>
                    </>)}
                    {approvalsStatusTab === 'Clarification' && (<>
                      <button onClick={() => handleApprove(exp.id)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-green-700 bg-green-50 hover:bg-green-100 rounded font-medium"><CheckCircle size={15}/> Approve</button>
                      <button onClick={() => handleDisapprove(exp.id)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-red-700 bg-red-50 hover:bg-red-100 rounded font-medium"><X size={15}/> Reject</button>
                    </>)}
                    {approvalsStatusTab === 'Disapproved' && (
                      <button onClick={() => handleApprove(exp.id)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-green-700 bg-green-50 hover:bg-green-100 rounded font-medium"><CheckCircle size={15}/> Approve</button>
                    )}
                  </div>
                </div>
              ))}
              {approvalsExpenses.length === 0 && <div className="p-8 text-center text-slate-400">No expenses found.</div>}
            </div>
            {/* Desktop table layout for approvals */}
            <div className="hidden md:block bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-700 font-semibold">
                        <tr>
                      <th className="p-4 w-10 text-center">
                        <input type="checkbox" checked={allPageSelected} onChange={toggleSelectAllOnPage} />
                      </th>
                            <th className="p-4">Date</th>
                            <th className="p-4">Employee</th>
                            <th className="p-4">Project / Type</th>
                            <th className="p-4">Category</th>
                            <th className="p-4 text-center">Proof</th>
                            <th className="p-4 text-right">Amount</th>
                            <th className="p-4 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {paginatedApprovals.map(exp => (
                            <tr key={exp.id} className="text-slate-800">
                        <td className="p-4 text-center">
                          {approvalsStatusTab === 'Pending' && (
                            <input type="checkbox" checked={selectedApprovalIds.includes(exp.id)} onChange={() => toggleSelectOne(exp.id)} />
                          )}
                        </td>
                                <td className="p-4 whitespace-nowrap">{new Date(exp.date).toLocaleDateString()}</td>
                                <td className="p-4 font-medium">{employees.find(e => e.id === exp.employee_id)?.name || 'Unknown'}</td>
                                <td className="p-4 text-black">{exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}</td>
                                <td className="p-4">
                                    <div>{exp.category}</div>
                                    <div className="text-xs text-slate-400">{exp.remarks}</div>
                          {exp.clarification_request && <div className="text-xs text-amber-700 mt-1">Clarification asked: {exp.clarification_request}</div>}
                          {exp.clarification_response && <div className="text-xs text-amber-700">Clarification submitted: {exp.clarification_response}</div>}
                          {exp.disapproved_reason && <div className="text-xs text-red-600 mt-1">Disapproved: {exp.disapproved_reason}</div>}
                                </td>
                                <td className="p-4 text-center">
                                  {exp.proof_url ? (
                                    <a href={exp.proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition" title="View attached proof">
                                      {exp.proof_url.toLowerCase().includes('.pdf') ? <FileText size={13} /> : <ImageIcon size={13} />} View
                                    </a>
                                  ) : (
                                    <span className="text-xs text-slate-300">—</span>
                                  )}
                                </td>
                                <td className="p-4 text-right font-bold whitespace-nowrap">{formatCurrency(exp.amount)}</td>
                                <td className="p-4 text-center">
                                    {approvalsStatusTab === 'Pending' && (
                                      <div className="flex items-center justify-center gap-2">
                                          <button onClick={() => handleApprove(exp.id)} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Approve"><CheckCircle size={18}/></button>
                                          <button onClick={() => handleRequestClarification(exp.id)} className="p-1 text-amber-600 hover:bg-amber-50 rounded" title="Request Clarification"><AlertCircle size={18}/></button>
                                          <button onClick={() => handleDisapprove(exp.id)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Disapprove"><X size={18}/></button>
                                      </div>
                                    )}
                                    {approvalsStatusTab === 'Clarification' && (
                                      <div className="flex items-center justify-center gap-2">
                                          <button onClick={() => handleApprove(exp.id)} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Approve"><CheckCircle size={18}/></button>
                                          <button onClick={() => handleDisapprove(exp.id)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Disapprove"><X size={18}/></button>
                                      </div>
                                    )}
                                    {approvalsStatusTab === 'Disapproved' && (
                                      <div className="flex items-center justify-center gap-2">
                                          <button onClick={() => handleApprove(exp.id)} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Approve"><CheckCircle size={18}/></button>
                                      </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {approvalsExpenses.length === 0 && <div className="p-8 text-center text-slate-400">No expenses found.</div>}
              </div>
            </div>
            {approvalsExpenses.length > approvalsItemsPerPage && (
              <div className="flex items-center justify-between p-4 border-t bg-white bg-slate-50 border-slate-200">
                  <div className="text-sm text-slate-500">
                      Showing {Math.min((approvalsPage - 1) * approvalsItemsPerPage + 1, approvalsExpenses.length)} to {Math.min(approvalsPage * approvalsItemsPerPage, approvalsExpenses.length)} of {approvalsExpenses.length} results
                  </div>
                  <div className="flex gap-2">
                      <button onClick={() => setApprovalsPage(p => Math.max(1, p - 1))} disabled={approvalsPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                      <button onClick={() => setApprovalsPage(p => Math.min(Math.ceil(approvalsExpenses.length / approvalsItemsPerPage), p + 1))} disabled={approvalsPage === Math.ceil(approvalsExpenses.length / approvalsItemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
                  </div>
              </div>
            )}
        </div>
      )}

      {viewMode === 'history' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 p-4 bg-white rounded-xl shadow-sm border border-slate-200">
             <select className="rounded border border-slate-300 p-1 text-sm text-black" value={historyFilter.time} onChange={e => setHistoryFilter({...historyFilter, time: e.target.value})}><option value="all">All Time</option><option value="week">This Week</option><option value="month">This Month</option></select>
             <select className="rounded border border-slate-300 p-1 text-sm text-black" value={historyFilter.project} onChange={e => setHistoryFilter({...historyFilter, project: e.target.value})}><option value="all">All Projects</option>{availableProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}</select>
             <input type="date" className="rounded border border-slate-300 p-1 text-sm text-black" value={historyFilter.startDate} onChange={e => setHistoryFilter({...historyFilter, startDate: e.target.value})} />
             <input type="date" className="rounded border border-slate-300 p-1 text-sm text-black" value={historyFilter.endDate} onChange={e => setHistoryFilter({...historyFilter, endDate: e.target.value})} />
             <select className="rounded border border-slate-300 p-1 text-sm text-black" value={historyFilter.status} onChange={e => setHistoryFilter({...historyFilter, status: e.target.value})}>
               <option value="all">All Status</option>
               <option value="approved">Approved Expenses</option>
               <option value="unapproved">Unapproved Expenses</option>
               <option value="disapproved">Rejected Expenses</option>
               <option value="clarification">Clarification Expenses</option>
             </select>
          </div>
            {/* Mobile card layout for history */}
            <div className="md:hidden space-y-3">
              {paginatedHistory.map(exp => (
                <div key={exp.id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="text-xs text-slate-500">{new Date(exp.date).toLocaleDateString()}</div>
                      <div className="font-medium text-slate-800 text-sm mt-0.5">{exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-base font-bold text-slate-900">{formatCurrency(exp.amount)}</div>
                      <span className="text-xs bg-slate-100 px-2 py-0.5 rounded">{exp.status}</span>
                    </div>
                  </div>
                  <div className="text-xs text-slate-600 mb-2">{exp.category}</div>
                  {exp.proof_url && <div className="mb-2"><ProofBadge proof_url={exp.proof_url} /></div>}
                  {exp.status === 'Clarification' && (
                    <div className="flex flex-col gap-1 mb-2">
                      <span className="text-xs text-amber-700">{exp.clarification_request || 'Clarification requested'}</span>
                      <button onClick={() => handleSubmitClarification(exp)} className="rounded bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-700 w-fit">Submit Clarification</button>
                    </div>
                  )}
                  {exp.status === 'Disapproved' && exp.disapproved_reason && (<div className="text-xs text-red-600 mb-2">{exp.disapproved_reason}</div>)}
                  {isEditableExpense(exp) && (
                    <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                      <button onClick={() => handleOpenEdit(exp)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-blue-700 bg-blue-50 hover:bg-blue-100 rounded font-medium"><Edit size={14}/> Edit</button>
                      <button onClick={() => handleDeleteExpense(exp)} className="flex-1 flex items-center justify-center gap-1 py-1.5 text-sm text-red-700 bg-red-50 hover:bg-red-100 rounded font-medium"><Trash2 size={14}/> Delete</button>
                    </div>
                  )}
                </div>
              ))}
              {filteredHistory.length === 0 && <div className="p-8 text-center text-slate-400">No records found.</div>}
            </div>
            {/* Desktop table layout for history */}
            <div className="hidden md:block rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-left text-sm text-black"><thead className="bg-slate-50 text-slate-700 font-semibold"><tr><th className="p-4">Date</th><th className="p-4">Project / Type</th><th className="p-4">Category</th><th className="p-4 text-right">Amount</th><th className="p-4 text-center">Status</th><th className="p-4 text-center">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{paginatedHistory.map(exp => (<tr key={exp.id}><td className="p-4 whitespace-nowrap">{new Date(exp.date).toLocaleDateString()}</td><td className="p-4 text-black">{exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}</td><td className="p-4">{exp.category}{exp.proof_url && <div className="mt-1"><ProofBadge proof_url={exp.proof_url} /></div>}</td><td className="p-4 text-right font-medium whitespace-nowrap">{formatCurrency(exp.amount)}</td><td className="p-4 text-center"><div className="flex flex-col items-center gap-2"><span className="text-xs bg-slate-100 px-2 py-1 rounded">{exp.status}</span>{exp.status === 'Clarification' && (<div className="flex flex-col items-center gap-2"><span className="text-xs text-amber-700">{exp.clarification_request || 'Clarification requested'}</span><button onClick={() => handleSubmitClarification(exp)} className="rounded bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-700">Submit Clarification</button></div>)}{exp.status === 'Disapproved' && exp.disapproved_reason && (<span className="text-xs text-red-600">{exp.disapproved_reason}</span>)}</div></td><td className="p-4 text-center">{isEditableExpense(exp) ? (<div className="flex items-center justify-center gap-2"><button onClick={() => handleOpenEdit(exp)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit"><Edit size={16} /></button><button onClick={() => handleDeleteExpense(exp)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 size={16} /></button></div>) : <span className="text-xs text-slate-400">-</span>}</td></tr>))}</tbody></table>{filteredHistory.length === 0 && <div className="p-8 text-center text-slate-400">No records found.</div>}</div></div>
            {filteredHistory.length > historyItemsPerPage && (
            <div className="flex items-center justify-between p-4 border-t bg-white bg-slate-50 border-slate-200">
              <div className="text-sm text-slate-500">
                Showing {Math.min((historyPage - 1) * historyItemsPerPage + 1, filteredHistory.length)} to {Math.min(historyPage * historyItemsPerPage, filteredHistory.length)} of {filteredHistory.length} results
              </div>
              <div className="flex gap-2">
                <button onClick={() => setHistoryPage(p => Math.max(1, p - 1))} disabled={historyPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                <button onClick={() => setHistoryPage(p => Math.min(Math.ceil(filteredHistory.length / historyItemsPerPage), p + 1))} disabled={historyPage === Math.ceil(filteredHistory.length / historyItemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
              </div>
            </div>
            )}
        </div>
      )}

      {viewMode === 'ledger' && (
        <div className="space-y-6">
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-xl bg-green-50 border border-green-100 p-4">
              <div className="text-green-600 text-sm font-medium flex items-center gap-2"><Wallet size={16} /> Total Payment Received</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(totalPaymentsReceived)}</div>
              <div className="text-xs text-slate-500 mt-1">Advances + Payouts</div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4">
              <div className="text-blue-600 text-sm font-medium flex items-center gap-2"><CheckCircle size={16} /> Approved Expenses</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(totalApprovedExpenses)}</div>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-4">
              <div className="text-amber-600 text-sm font-medium flex items-center gap-2"><AlertCircle size={16} /> Unapproved Expenses</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(totalUnapprovedExpenses)}</div>
            </div>
            <div className="rounded-xl bg-red-50 border border-red-100 p-4">
              <div className="text-red-600 text-sm font-medium flex items-center gap-2"><X size={16} /> Disapproved Expenses</div>
              <div className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(totalDisapprovedExpenses)}</div>
            </div>
            <div className={`rounded-xl border p-4 ${balance >= 0 ? 'bg-slate-50 border-slate-200' : 'bg-orange-50 border-orange-200'}`}>
              <div className="text-slate-600 text-sm font-medium">Balance Due</div>
              <div className={`text-2xl font-bold mt-1 ${balance < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                {balance < 0 ? `Due to You: ${formatCurrency(Math.abs(balance))}` : `Due to Company: ${formatCurrency(balance)}`}
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 font-semibold text-slate-700 flex items-center justify-between">
              <span>Expenses Submitted (Last 30 Days)</span>
              <span className="text-xs text-slate-500">{last30DaysExpenses.length} total</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-white text-slate-700 font-semibold border-b">
                  <tr>
                    <th className="p-4">Date</th>
                    <th className="p-4">Project / Type</th>
                    <th className="p-4">Category</th>
                    <th className="p-4">Details</th>
                    <th className="p-4 text-right">Amount</th>
                    <th className="p-4 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedLedger.map(exp => (
                    <tr key={exp.id} className="hover:bg-slate-50">
                      <td className="p-4 text-slate-700">{new Date(exp.date).toLocaleDateString()}</td>
                      <td className="p-4 text-black">
                        {exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}
                      </td>
                      <td className="p-4 font-medium text-slate-800">{exp.category}</td>
                      <td className="p-4 text-slate-500 text-xs">{exp.remarks || '-'}{exp.proof_url && <div className="mt-1"><ProofBadge proof_url={exp.proof_url} /></div>}</td>
                      <td className="p-4 text-right font-bold text-slate-800">{formatCurrency(exp.amount)}</td>
                      <td className="p-4 text-center">
                        <span className="text-xs bg-slate-100 px-2 py-1 rounded">{exp.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {last30DaysExpenses.length === 0 && (
                <div className="p-8 text-center text-slate-400">No expenses submitted in the last 30 days.</div>
              )}
            </div>
            {last30DaysExpenses.length > ledgerItemsPerPage && (
              <div className="flex items-center justify-between p-4 border-t bg-white bg-slate-50 border-slate-200">
                <div className="text-sm text-slate-500">
                  Showing {Math.min((ledgerPage - 1) * ledgerItemsPerPage + 1, last30DaysExpenses.length)} to {Math.min(ledgerPage * ledgerItemsPerPage, last30DaysExpenses.length)} of {last30DaysExpenses.length} results
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setLedgerPage(p => Math.max(1, p - 1))} disabled={ledgerPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                  <button onClick={() => setLedgerPage(p => Math.min(Math.ceil(last30DaysExpenses.length / ledgerItemsPerPage), p + 1))} disabled={ledgerPage === Math.ceil(last30DaysExpenses.length / ledgerItemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====== PAYMENTS RECEIVED VIEW ====== */}
      {viewMode === 'payments' && (
        <div className="space-y-4">
          {/* FY Filter */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-slate-800">Payments Received</h3>
            <select value={paymentFyFilter} onChange={e => setPaymentFyFilter(e.target.value)} className="border border-slate-200 rounded px-3 py-2 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-emerald-200 w-fit">
              {paymentFyList.map(fy => <option key={fy} value={fy}>{fy === 'ALL' ? 'All Years' : `FY ${fy}`}</option>)}
            </select>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-emerald-100 flex items-center justify-center"><Wallet size={20} className="text-emerald-600" /></div>
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wide">Payouts / Salary</div>
                  <div className="text-lg font-bold text-emerald-700">{formatCurrency(currentPaymentSummary.payouts)}</div>
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center"><TrendingUp size={20} className="text-blue-600" /></div>
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wide">Advances</div>
                  <div className="text-lg font-bold text-blue-700">{formatCurrency(currentPaymentSummary.advances)}</div>
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-indigo-100 flex items-center justify-center"><IndianRupee size={20} className="text-indigo-600" /></div>
                <div>
                  <div className="text-xs text-slate-400 uppercase tracking-wide">Total Received</div>
                  <div className="text-lg font-bold text-indigo-700">{formatCurrency(currentPaymentSummary.total)}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Statement Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between bg-slate-50">
              <span className="font-semibold text-slate-700">{paymentFyFilter === 'ALL' ? 'All Financial Years' : `FY ${paymentFyFilter}`}</span>
              <span className="text-xs text-slate-500">{dataPaymentRows.length} transactions</span>
            </div>
            <div className="overflow-x-auto max-h-[70vh]">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-100 text-slate-600 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="p-3 whitespace-nowrap">Date</th>
                    <th className="p-3">Description</th>
                    <th className="p-3 text-center">Type</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3 text-right">Running Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedPaymentRows.map((row, idx) => {
                    if (row._type === 'fy_header') {
                      return (
                        <tr key={`fyhdr-${idx}`}>
                          <td colSpan={5} className="px-4 py-2 bg-indigo-700 text-white font-bold text-xs uppercase tracking-widest">
                            &#9670;&nbsp; Financial Year {row.fy}
                          </td>
                        </tr>
                      );
                    }
                    if (row._type === 'bcf') {
                      return (
                        <tr key={`bcf-${idx}`} className="bg-amber-50 font-semibold border-y-2 border-amber-200">
                          <td className="p-3 whitespace-nowrap text-amber-800 text-xs">{row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}</td>
                          <td className="p-3 italic text-amber-800">{row.Description}</td>
                          <td className="p-3 text-center"><span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">B/F</span></td>
                          <td className="p-3 text-right text-slate-700">{formatCurrency(row.Amount)}</td>
                          <td className="p-3 text-right font-bold text-indigo-700">{formatCurrency(row.RunningTotal)}</td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={`pay-${idx}`} className="hover:bg-slate-50">
                        <td className="p-3 whitespace-nowrap text-slate-500">{row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}</td>
                        <td className="p-3 text-slate-700">{row.Description}</td>
                        <td className="p-3 text-center">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${row.type === 'payout' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                            {row.type === 'payout' ? 'Payout' : 'Advance'}
                          </span>
                        </td>
                        <td className="p-3 text-right font-medium text-emerald-700">{formatCurrency(row.Amount)}</td>
                        <td className="p-3 text-right font-semibold text-slate-800">{formatCurrency(row.RunningTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visiblePaymentRows.length === 0 && (
                <div className="p-8 text-center text-slate-400">No payment records found.</div>
              )}
            </div>
            {visiblePaymentRows.length > paymentItemsPerPage && (
              <div className="flex items-center justify-between p-3 border-t bg-slate-50">
                <div className="text-sm text-slate-500">Showing {Math.min((paymentPage - 1) * paymentItemsPerPage + 1, visiblePaymentRows.length)}–{Math.min(paymentPage * paymentItemsPerPage, visiblePaymentRows.length)} of {visiblePaymentRows.length}</div>
                <div className="flex gap-2">
                  <button onClick={() => setPaymentPage(p => Math.max(1, p - 1))} disabled={paymentPage === 1} className="px-3 py-1 rounded border text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50">Previous</button>
                  <button onClick={() => setPaymentPage(p => Math.min(Math.ceil(visiblePaymentRows.length / paymentItemsPerPage), p + 1))} disabled={paymentPage === Math.ceil(visiblePaymentRows.length / paymentItemsPerPage)} className="px-3 py-1 rounded border text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50">Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====== ALL TRACKER VIEW ====== */}
      {viewMode === 'tracker' && can(role, 'expenses', 'view_payments') && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
              <div className="text-xs text-slate-500 font-semibold mb-1">Total Records</div>
              <div className="text-2xl font-bold text-slate-800">{trackerSummary.total}</div>
              <div className="text-xs text-slate-400">{formatCurrency(trackerSummary.totalAmt)}</div>
            </div>
            <div className="rounded-xl bg-green-50 border border-green-100 p-4 shadow-sm">
              <div className="text-xs text-green-700 font-semibold mb-1 flex items-center gap-1"><CheckCircle size={12}/> Approved</div>
              <div className="text-2xl font-bold text-green-800">{formatCurrency(trackerSummary.approved)}</div>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 shadow-sm">
              <div className="text-xs text-amber-700 font-semibold mb-1 flex items-center gap-1"><AlertCircle size={12}/> Pending</div>
              <div className="text-2xl font-bold text-amber-800">{formatCurrency(trackerSummary.pending)}</div>
            </div>
            <div className="rounded-xl bg-red-50 border border-red-100 p-4 shadow-sm">
              <div className="text-xs text-red-700 font-semibold mb-1 flex items-center gap-1"><X size={12}/> Disapproved</div>
              <div className="text-2xl font-bold text-red-800">{formatCurrency(trackerSummary.disapproved)}</div>
            </div>
          </div>

          {/* Filters */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-slate-700"><Filter size={15}/> Filters</div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Employee</label>
                <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-black" value={trackerFilters.employee} onChange={e => setTrackerFilters(f => ({...f, employee: e.target.value}))}>
                  <option value="">All Employees</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Project</label>
                <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-black" value={trackerFilters.project} onChange={e => setTrackerFilters(f => ({...f, project: e.target.value}))}>
                  <option value="">All Projects</option>
                  <option value="__general__">General Ops</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
                <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-black" value={trackerFilters.category} onChange={e => setTrackerFilters(f => ({...f, category: e.target.value}))}>
                  <option value="">All Categories</option>
                  {expenseCats.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
                <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-black" value={trackerFilters.status} onChange={e => setTrackerFilters(f => ({...f, status: e.target.value}))}>
                  <option value="">All Statuses</option>
                  <option value="Approved">Approved</option>
                  <option value="Pending">Pending</option>
                  <option value="Clarification">Clarification</option>
                  <option value="Disapproved">Disapproved</option>
                  <option value="Rejected">Rejected</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">From Date</label>
                <input type="date" className="w-full rounded border border-slate-300 p-1.5 text-sm text-black" value={trackerFilters.startDate} onChange={e => setTrackerFilters(f => ({...f, startDate: e.target.value}))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">To Date</label>
                <input type="date" className="w-full rounded border border-slate-300 p-1.5 text-sm text-black" value={trackerFilters.endDate} onChange={e => setTrackerFilters(f => ({...f, endDate: e.target.value}))} />
              </div>
            </div>
            {(trackerFilters.employee || trackerFilters.project || trackerFilters.category || trackerFilters.status || trackerFilters.startDate || trackerFilters.endDate) && (
              <button onClick={() => setTrackerFilters({ employee: '', project: '', category: '', status: '', startDate: '', endDate: '' })} className="mt-3 text-xs text-indigo-600 hover:underline">Clear all filters</button>
            )}
          </div>

          {/* Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[700px]">
              <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
                <tr>
                  <th className="p-3">Date</th>
                  <th className="p-3">Employee</th>
                  <th className="p-3">Project / Type</th>
                  <th className="p-3">Category</th>
                  <th className="p-3 hidden lg:table-cell">Remarks</th>
                  <th className="p-3 text-right">Amount</th>
                  <th className="p-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedTracker.map(exp => {
                  const emp = employees.find(e => e.id === exp.employee_id);
                  const proj = exp.is_general ? null : projects.find(p => p.id === exp.project_id);
                  const statusColors = { Approved: 'bg-green-100 text-green-700', Pending: 'bg-amber-100 text-amber-700', Clarification: 'bg-orange-100 text-orange-700', Disapproved: 'bg-red-100 text-red-700', Rejected: 'bg-red-100 text-red-700' };
                  return (
                    <tr key={exp.id} className="hover:bg-slate-50 text-slate-800">
                      <td className="p-3 whitespace-nowrap">{new Date(exp.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                      <td className="p-3">
                        <button onClick={() => openEmpDash(exp.employee_id)} className="font-medium text-indigo-700 hover:underline text-left">{emp?.name || exp.employee_id}</button>
                        {emp?.designation && <div className="text-xs text-slate-400">{emp.designation}</div>}
                      </td>
                      <td className="p-3">{exp.is_general ? <span className="bg-orange-50 text-orange-700 px-2 py-0.5 rounded text-xs">General Ops</span> : <span className="text-slate-700">{proj?.project_name || 'Unknown'}</span>}</td>
                      <td className="p-3 font-medium">{exp.category}</td>
                      <td className="p-3 text-slate-500 text-xs max-w-[160px] truncate hidden lg:table-cell">{exp.remarks || '—'}{exp.proof_url && <div className="mt-1"><ProofBadge proof_url={exp.proof_url} /></div>}</td>
                      <td className="p-3 text-right font-bold whitespace-nowrap">{formatCurrency(exp.amount)}</td>
                      <td className="p-3 text-center"><span className={`text-xs px-2 py-0.5 rounded font-medium ${statusColors[exp.status] || 'bg-slate-100 text-slate-600'}`}>{exp.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {trackerExpenses.length === 0 && <div className="p-10 text-center text-slate-400">No expenses match the current filters.</div>}
          </div>

          {trackerExpenses.length > trackerItemsPerPage && (
            <div className="flex items-center justify-between p-3 border-t bg-slate-50 rounded-b-xl">
              <div className="text-sm text-slate-500">Showing {Math.min((trackerPage - 1) * trackerItemsPerPage + 1, trackerExpenses.length)}–{Math.min(trackerPage * trackerItemsPerPage, trackerExpenses.length)} of {trackerExpenses.length}</div>
              <div className="flex gap-2">
                <button onClick={() => setTrackerPage(p => Math.max(1, p - 1))} disabled={trackerPage === 1} className="px-3 py-1 rounded border text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50">Previous</button>
                <button onClick={() => setTrackerPage(p => Math.min(Math.ceil(trackerExpenses.length / trackerItemsPerPage), p + 1))} disabled={trackerPage === Math.ceil(trackerExpenses.length / trackerItemsPerPage)} className="px-3 py-1 rounded border text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ====== EMPLOYEE DASHBOARD VIEW ====== */}
      {viewMode === 'empDash' && empDashEmployee && can(role, 'expenses', 'view_payments') && (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <button onClick={() => setViewMode('tracker')} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-indigo-600 transition">
              <ArrowLeft size={16} /> Back to Tracker
            </button>
          </div>

          <div className="rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 p-5 text-white shadow-lg">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`h-12 w-12 rounded-full flex items-center justify-center text-white font-bold text-lg shrink-0 ${empDashEmployee.role === 'admin' ? 'bg-red-500' : empDashEmployee.role === 'manager' ? 'bg-blue-500' : 'bg-green-500'}`}>
                  {(empDashEmployee.name || '?')[0].toUpperCase()}
                </div>
                <div>
                  <h2 className="text-2xl font-bold">{empDashEmployee.name}</h2>
                  <div className="text-purple-100 text-sm capitalize">{empDashEmployee.designation || empDashEmployee.role || 'Employee'}</div>
                </div>
              </div>
              <div className="bg-white/20 backdrop-blur rounded-xl px-5 py-3 text-center">
                <div className="text-xs text-purple-100 uppercase font-semibold">Net Balance</div>
                <div className={`text-3xl font-bold ${empDashKpis.balance < 0 ? 'text-red-200' : 'text-white'}`}>{formatCurrency(Math.abs(empDashKpis.balance))}</div>
                <div className="text-xs text-purple-100">{empDashKpis.balance < 0 ? 'Company owes employee' : 'Employee owes company'}</div>
              </div>
            </div>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
              <div className="text-xs text-slate-500 font-semibold mb-1">Total Advances</div>
              <div className="text-xl font-bold text-slate-800">{formatCurrency(empDashKpis.totalAdv)}</div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
              <div className="text-xs text-slate-500 font-semibold mb-1">Payouts / Salary</div>
              <div className="text-xl font-bold text-slate-800">{formatCurrency(empDashKpis.totalPay)}</div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 shadow-sm">
              <div className="text-xs text-blue-700 font-semibold mb-1">Total Received</div>
              <div className="text-xl font-bold text-blue-800">{formatCurrency(empDashKpis.received)}</div>
              <div className="text-xs text-slate-400">Advances + Payouts</div>
            </div>
            <div className="rounded-xl bg-green-50 border border-green-100 p-4 shadow-sm">
              <div className="text-xs text-green-700 font-semibold mb-1 flex items-center gap-1"><CheckCircle size={11}/> Approved Expenses</div>
              <div className="text-xl font-bold text-green-800">{formatCurrency(empDashKpis.approved)}</div>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 shadow-sm">
              <div className="text-xs text-amber-700 font-semibold mb-1 flex items-center gap-1"><AlertCircle size={11}/> Pending</div>
              <div className="text-xl font-bold text-amber-800">{formatCurrency(empDashKpis.pending)}</div>
            </div>
            <div className="rounded-xl bg-orange-50 border border-orange-100 p-4 shadow-sm">
              <div className="text-xs text-orange-700 font-semibold mb-1">Clarification</div>
              <div className="text-xl font-bold text-orange-800">{formatCurrency(empDashKpis.clarification)}</div>
            </div>
            <div className="rounded-xl bg-red-50 border border-red-100 p-4 shadow-sm">
              <div className="text-xs text-red-700 font-semibold mb-1 flex items-center gap-1"><X size={11}/> Disapproved</div>
              <div className="text-xl font-bold text-red-800">{formatCurrency(empDashKpis.disapproved)}</div>
            </div>
            <div className={`rounded-xl border p-4 shadow-sm ${empDashKpis.balance < 0 ? 'bg-purple-50 border-purple-200' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-xs text-slate-600 font-semibold mb-1">Net Balance</div>
              <div className={`text-xl font-bold ${empDashKpis.balance < 0 ? 'text-purple-700' : 'text-slate-700'}`}>{formatCurrency(Math.abs(empDashKpis.balance))}</div>
              <div className="text-xs text-slate-400">{empDashKpis.balance < 0 ? 'To reimburse' : 'Employee owes'}</div>
            </div>
          </div>

          {/* Category + Project breakdowns */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center gap-2"><TrendingUp size={15} className="text-indigo-500" /> By Category</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 font-semibold">
                  <tr><th className="p-3 text-left">Category</th><th className="p-3 text-right text-green-700">Approved</th><th className="p-3 text-right text-amber-700">Pending</th><th className="p-3 text-right text-red-600">Rejected</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {empDashCatBreakdown.map(r => (
                    <tr key={r.cat} className="hover:bg-slate-50">
                      <td className="p-3 font-medium text-slate-800">{r.cat}</td>
                      <td className="p-3 text-right text-green-700">{r.approved > 0 ? formatCurrency(r.approved) : '—'}</td>
                      <td className="p-3 text-right text-amber-700">{r.pending > 0 ? formatCurrency(r.pending) : '—'}</td>
                      <td className="p-3 text-right text-red-600">{r.disapproved > 0 ? formatCurrency(r.disapproved) : '—'}</td>
                    </tr>
                  ))}
                  {empDashCatBreakdown.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-slate-400">No expenses</td></tr>}
                </tbody>
              </table>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-700 text-sm flex items-center gap-2"><Briefcase size={15} className="text-purple-500" /> By Project</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 font-semibold">
                  <tr><th className="p-3 text-left">Project</th><th className="p-3 text-right">Total</th><th className="p-3 text-right text-green-700">Approved</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {empDashProjBreakdown.map(r => (
                    <tr key={r.key} className="hover:bg-slate-50">
                      <td className="p-3 font-medium text-slate-800 max-w-[180px] truncate">{r.name}</td>
                      <td className="p-3 text-right font-bold text-slate-700">{formatCurrency(r.total)}</td>
                      <td className="p-3 text-right text-green-700">{formatCurrency(r.approved)}</td>
                    </tr>
                  ))}
                  {empDashProjBreakdown.length === 0 && <tr><td colSpan={3} className="p-4 text-center text-slate-400">No expenses</td></tr>}
                </tbody>
              </table>
              </div>
            </div>
          </div>

          {/* Full expense list */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
              <span className="font-semibold text-slate-700 text-sm">All Expenses ({empDashExpenses.length})</span>
              <div className="flex gap-1 flex-wrap">
                {[['all', 'All'], ['approved', 'Approved'], ['pending', 'Pending'], ['clarification', 'Clarification'], ['disapproved', 'Disapproved']].map(([val, label]) => (
                  <button key={val} onClick={() => setEmpDashStatusFilter(val)}
                    className={`px-3 py-1 text-xs rounded-full border font-medium transition ${empDashStatusFilter === val ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-100">
                  <tr><th className="p-3">Date</th><th className="p-3">Project / Type</th><th className="p-3">Category</th><th className="p-3">Remarks</th><th className="p-3 text-right">Amount</th><th className="p-3 text-center">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {paginatedEmpDash.map(exp => {
                    const proj = exp.is_general ? null : projects.find(p => p.id === exp.project_id);
                    const statusColors = { Approved: 'bg-green-100 text-green-700', Pending: 'bg-amber-100 text-amber-700', Clarification: 'bg-orange-100 text-orange-700', Disapproved: 'bg-red-100 text-red-700', Rejected: 'bg-red-100 text-red-700' };
                    return (
                      <tr key={exp.id} className="hover:bg-slate-50 text-slate-800">
                        <td className="p-3 whitespace-nowrap">{new Date(exp.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                        <td className="p-3">{exp.is_general ? <span className="bg-orange-50 text-orange-700 px-2 py-0.5 rounded text-xs">General Ops</span> : <span>{proj?.project_name || 'Unknown'}</span>}</td>
                        <td className="p-3 font-medium">{exp.category}</td>
                        <td className="p-3 text-slate-400 text-xs max-w-[160px] truncate">{exp.remarks || '—'}{exp.proof_url && <div className="mt-1"><ProofBadge proof_url={exp.proof_url} /></div>}</td>
                        <td className="p-3 text-right font-bold">{formatCurrency(exp.amount)}</td>
                        <td className="p-3 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${statusColors[exp.status] || 'bg-slate-100 text-slate-600'}`}>{exp.status}</span>
                          {exp.clarification_request && <div className="text-xs text-amber-600 mt-0.5 max-w-[140px] truncate" title={exp.clarification_request}>Q: {exp.clarification_request}</div>}
                          {exp.disapproved_reason && <div className="text-xs text-red-500 mt-0.5 max-w-[140px] truncate" title={exp.disapproved_reason}>{exp.disapproved_reason}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {empDashFiltered.length === 0 && <div className="p-8 text-center text-slate-400">No expenses in this category.</div>}
            </div>
            {empDashFiltered.length > empDashItemsPerPage && (
              <div className="flex items-center justify-between p-3 border-t bg-slate-50">
                <div className="text-sm text-slate-500">{Math.min((empDashPage - 1) * empDashItemsPerPage + 1, empDashFiltered.length)}–{Math.min(empDashPage * empDashItemsPerPage, empDashFiltered.length)} of {empDashFiltered.length}</div>
                <div className="flex gap-2">
                  <button onClick={() => setEmpDashPage(p => Math.max(1, p - 1))} disabled={empDashPage === 1} className="px-3 py-1 rounded border text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50">Previous</button>
                  <button onClick={() => setEmpDashPage(p => Math.min(Math.ceil(empDashFiltered.length / empDashItemsPerPage), p + 1))} disabled={empDashPage === Math.ceil(empDashFiltered.length / empDashItemsPerPage)} className="px-3 py-1 rounded border text-sm bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50">Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <Modal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} title="Edit Expense">
        <div className="space-y-4">
          <div className="flex gap-4 border-b pb-4">
            <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="edit-exptype" checked={!editForm.is_general} onChange={() => setEditForm({ ...editForm, is_general: false })} /><span className="text-sm font-bold text-slate-800">Project Expense</span></label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="edit-exptype" checked={editForm.is_general} onChange={() => setEditForm({ ...editForm, is_general: true, project_id: '' })} /><span className="text-sm font-bold text-slate-800">General / Ops</span></label>
          </div>
          {!editForm.is_general && (
            <div>
              <label className="text-xs font-bold text-slate-700">Select Project</label>
              <select className="w-full rounded border border-slate-300 p-2 text-black" value={editForm.project_id} onChange={e => setEditForm({ ...editForm, project_id: e.target.value })}>
                <option value="">-- Choose Project --</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-bold text-slate-700">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-black" value={editForm.date} onChange={e => setEditForm({ ...editForm, date: e.target.value })} /></div>
            <div><label className="text-xs font-bold text-slate-700">Category</label><select className="w-full rounded border border-slate-300 p-2 text-black" value={editForm.category} onChange={e => setEditForm({ ...editForm, category: e.target.value })}>{expenseCats.map(c => <option key={c}>{c}</option>)}</select></div>
          </div>
          <div><label className="text-xs font-bold text-slate-700">Amount</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-black" placeholder="0.00" value={editForm.amount} onChange={e => setEditForm({ ...editForm, amount: e.target.value })} /></div>
          <div><label className="text-xs font-bold text-slate-700">Remarks</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={editForm.remarks} onChange={e => setEditForm({ ...editForm, remarks: e.target.value })} placeholder="Description..." /></div>
          <div>
            <label className="text-xs font-bold text-slate-700">Proof (Invoice/Bill/Receipt){expenseProofSettings.threshold > 0 && parseFloat(editForm.amount) > expenseProofSettings.threshold && !editProofFile ? <span className="text-red-500 ml-1">* Required above {formatCurrency(expenseProofSettings.threshold)}</span> : null}</label>
            <input ref={editProofInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleProofUpload(f, setEditProofFile); e.target.value = ''; }} />
            {editProofFile ? (
              <div className="flex items-center gap-2 mt-1 p-2 bg-indigo-50 rounded border border-indigo-100">
                <a href={editProofFile.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-indigo-700 hover:underline truncate flex-1">
                  {editProofFile.name?.toLowerCase().endsWith('.pdf') ? <FileText size={14} /> : <ImageIcon size={14} />} {editProofFile.name}
                </a>
                <button type="button" onClick={() => handleRemoveProof(editProofFile, setEditProofFile)} className="text-red-400 hover:text-red-600"><X size={14} /></button>
              </div>
            ) : (
              <button type="button" onClick={() => editProofInputRef.current?.click()} disabled={proofUploading} className="w-full mt-1 flex items-center justify-center gap-2 rounded border border-dashed border-slate-300 p-2 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition">
                <Upload size={14} /> {proofUploading ? 'Uploading...' : 'Attach proof (photo/PDF)'}
              </button>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setIsEditOpen(false)} className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
            <button onClick={handleSaveEdit} className="rounded bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700">Save Changes</button>
          </div>
        </div>
      </Modal>
      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm(prev => ({ ...prev, isOpen: false }))}
        onConfirm={deleteConfirm.onConfirm}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        requireTyped={false}
      />
    </div>
  );
};

export default Expenses;
