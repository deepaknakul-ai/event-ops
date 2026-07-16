// version 1.3.0 finance implementation

import React, { useState, useEffect, useMemo } from 'react';
import { notify } from '../utils/toast';
import { TrendingUp, TrendingDown, Edit, Trash2, Download, Lock, Filter } from 'lucide-react';
import { addDoc, updateDoc, deleteDoc, doc, collection } from 'firebase/firestore';
import * as XLSX from '@e965/xlsx';
import { ConfirmDeleteModal } from '../components/Shared';
import { formatCurrency, getEffectivePOCost, getFYFromDate, fmtDate } from '../utils/helpers';
import { can } from '../utils/permissions';

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

const Finance = ({ clients, employees, projects, payments, payouts, vendorPayments = [], expenses, advances, role, db, appId, user, logAction, lockedFYs = [] }) => {
  const [activeTab, setActiveTab] = useState('client_in'); // 'client_in' or 'emp_out'
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    entity_id: '', amount: '', date: new Date().toISOString().split('T')[0],
    mode: 'Bank Transfer', reference: '', remarks: '', project_id: '', party_company_id: '',
    payout_type: 'salary'  // employee payout kind: salary | reimbursement | advance_settlement
  });
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [fyFilter, setFyFilter] = useState('all');

  const getEntityCompanies = (entity) => {
    if (!entity) return [];
    const primary = {
      id: 'primary',
      name: entity.name || 'Primary Company',
      gstin: entity.gstin || '',
      address: entity.address || '',
    };
    const extras = (entity.companies || []).map(c => ({
      id: c.id,
      name: c.name || 'Branch',
      gstin: c.gstin || '',
      address: c.address || '',
    }));
    return [primary, ...extras];
  };

  const financeEntityOptions = useMemo(() => {
    const rows = [];
    clients.forEach(c => {
      const companies = getEntityCompanies(c);
      companies.forEach(co => {
        rows.push({
          value: co.id === 'primary' ? c.id : `${c.id}::${co.id}`,
          entity_id: c.id,
          company_id: co.id,
          label: co.id === 'primary' ? c.name : `${c.name} — ${co.name}`,
          type: c.type,
        });
      });
    });
    return rows;
  }, [clients]);

  const isFYLocked = (dateStr) => lockedFYs.includes(getFYFromDate(dateStr));

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setCurrentPage(1);
    cancelEdit();
  };

  const handleEdit = (item) => {
    if (isFYLocked(item.date)) return notify(`FY ${getFYFromDate(item.date)} is locked. Cannot edit transactions in a locked financial year.`, 'error');
    setEditingId(item.id);
    setForm({
        entity_id: item.client_id || item.employee_id || item.vendor_id,
        amount: item.amount,
        date: item.date,
        mode: item.mode,
        reference: item.reference,
        remarks: item.remarks,
      project_id: item.project_id || '',
      party_company_id: item.party_company_id || 'primary',
      payout_type: item.payout_type || 'salary'  // legacy payouts default to salary
    });
  };

  const handleDelete = async (item) => {
    if (!can(role, 'finance', 'delete')) return notify('Access denied: only Admin and Accountant can delete financial records.', 'error');
    if (isFYLocked(item.date)) return notify(`FY ${getFYFromDate(item.date)} is locked. Cannot delete transactions in a locked financial year.`, 'error');
    let col = '';
    if (activeTab === 'client_in') col = 'payments';
    else if (activeTab === 'emp_out') col = 'payouts';
    else if (activeTab === 'vendor_out') col = 'vendor_payments';
    const tabLabel = activeTab === 'client_in' ? 'Payment' : activeTab === 'emp_out' ? 'Payout' : 'Vendor Payment';
    setDeleteConfirm({
      isOpen: true,
      title: `Delete ${tabLabel} Record`,
      message: `Are you sure you want to delete this ${tabLabel.toLowerCase()} of ${formatCurrency(item.amount)}? This action cannot be undone.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', col, item.id));
        logAction(col, 'delete', item.id, item, 'Deleted Payment record');
      }
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm({
        entity_id: '', amount: '', date: new Date().toISOString().split('T')[0],
      mode: 'Bank Transfer', reference: '', remarks: '', project_id: '', party_company_id: '', payout_type: 'salary'
    });
  };

  // --- Client Payment Logic ---
  const handleApprovePayment = async (item) => {
    if (!can(role, 'finance', 'edit')) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payments', item.id), { status: 'Approved', approved_by: user.uid, approved_at: new Date().toISOString() });
    logAction('payments', 'approve', item.id, item, `Approved on-site receipt from ${item.client_name}`);
  };

  const handleClientPayment = async () => {
    if (!can(role, 'finance', 'create')) return notify('Access denied: only Admin, Accountant and Manager can record payments.', 'error');
    if (!form.entity_id || !form.amount) return notify("Select Client and Amount", 'error');
    if (role === 'manager' && !['Cash', 'UPI / Online'].includes(form.mode))
      return notify('Managers can only record Cash or UPI / Online payments on-site.', 'info');
    if (isFYLocked(form.date)) return notify(`FY ${getFYFromDate(form.date)} is locked. You cannot add or edit transactions in a locked financial year.`, 'error');
    const client = clients.find(c => c.id === form.entity_id);
    const companies = getEntityCompanies(client);
    const selectedCompany = companies.find(c => c.id === (form.party_company_id || 'primary')) || companies[0] || null;

    const data = {
      client_id: client.id,
      client_name: client.name,
      project_id: form.project_id || 'general',
      party_company_id: selectedCompany?.id || '',
      party_company_name: selectedCompany?.name || '',
      party_company_gstin: selectedCompany?.gstin || '',
      party_company_address: selectedCompany?.address || '',
      amount: parseFloat(form.amount),
      date: form.date,
      mode: form.mode,
      reference: form.reference,
      remarks: form.remarks,
      status: role === 'manager' ? 'Pending Review' : 'Approved',
      recorded_by_role: role,
      updated_at: new Date().toISOString()
    };

    if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payments', editingId), data);
        logAction('payments', 'update', editingId, data, `Updated Payment from ${client.name}`);
        notify("Payment Updated", 'success');
        cancelEdit();
    } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payments'), {
            ...data,
            created_at: new Date().toISOString(),
            created_by: user.uid
        });
        logAction('payments', 'receive_payment', docRef.id, data, `Payment from ${client.name}`);
        notify("Payment Received Recorded", 'success');
        setForm({ ...form, amount: '', reference: '', remarks: '' });
    }
  };

  // --- Employee Payout Logic ---
  const handleEmpPayout = async () => {
    if (!can(role, 'finance', 'create')) return notify('Access denied: only Admin and Accountant can record payouts.', 'error');
    if (!form.entity_id || !form.amount) return notify("Select Employee and Amount", 'error');
    if (isFYLocked(form.date)) return notify(`FY ${getFYFromDate(form.date)} is locked. You cannot add or edit transactions in a locked financial year.`, 'error');
    const emp = employees.find(e => e.id === form.entity_id);

    const data = {
      employee_id: emp.id,
      employee_name: emp.name,
      amount: parseFloat(form.amount),
      date: form.date,
      mode: form.mode,
      // Payout kind drives the ledger: reimbursement / advance_settlement debit
      // the employee's per-employee account; salary debits Salary Expense.
      payout_type: form.payout_type || 'salary',
      reference: form.reference,
      remarks: form.remarks,
      updated_at: new Date().toISOString()
    };

    if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payouts', editingId), data);
        logAction('payouts', 'update', editingId, data, `Updated Payout to ${emp.name}`);
        notify("Payout Updated", 'success');
        cancelEdit();
    } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payouts'), {
            ...data,
            created_at: new Date().toISOString(),
            created_by: user.uid
        });
        logAction('payouts', 'make_payout', docRef.id, data, `Payout to ${emp.name}`);
        notify("Employee Payout Recorded", 'success');
        setForm({ ...form, amount: '', reference: '', remarks: '' });
    }
  };

  // --- Vendor Payment Logic ---
  const handleVendorPayment = async () => {
    if (!can(role, 'finance', 'create')) return notify('Access denied: only Admin and Accountant can record vendor payments.', 'error');
    if (!form.entity_id || !form.amount) return notify("Select Vendor and Amount", 'error');
    if (isFYLocked(form.date)) return notify(`FY ${getFYFromDate(form.date)} is locked. You cannot add or edit transactions in a locked financial year.`, 'error');
    const vendor = clients.find(c => c.id === form.entity_id);
    const companies = getEntityCompanies(vendor);
    const selectedCompany = companies.find(c => c.id === (form.party_company_id || 'primary')) || companies[0] || null;

    const data = {
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      project_id: form.project_id || 'general',
      party_company_id: selectedCompany?.id || '',
      party_company_name: selectedCompany?.name || '',
      party_company_gstin: selectedCompany?.gstin || '',
      party_company_address: selectedCompany?.address || '',
      amount: parseFloat(form.amount),
      date: form.date,
      mode: form.mode,
      reference: form.reference,
      remarks: form.remarks,
      updated_at: new Date().toISOString()
    };

    if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'vendor_payments', editingId), data);
        logAction('vendor_payments', 'update', editingId, data, `Updated Payment to ${vendor.name}`);
        notify("Vendor Payment Updated", 'success');
        cancelEdit();
    } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'vendor_payments'), {
            ...data,
            created_at: new Date().toISOString(),
            created_by: user.uid
        });
        logAction('vendor_payments', 'pay_vendor', docRef.id, data, `Payment to ${vendor.name}`);
        notify("Vendor Payment Recorded", 'success');
        setForm({ ...form, amount: '', reference: '', remarks: '' });
    }
  };

  // --- Calc Emp Balance ---
  const getEmpBalance = (empId) => {
    const myExpenses = expenses
      .filter(e => e.employee_id === empId && !isExpenseExcludedStatus(e.status))
      .reduce((s, e) => s + parseFloat(e.amount), 0);
    const myAdvances = advances.filter(a => a.employee_id === empId).reduce((s, a) => s + parseFloat(a.amount), 0);
    const myPayouts = payouts.filter(p => p.employee_id === empId).reduce((s, p) => s + parseFloat(p.amount), 0);
    return myAdvances + myPayouts - myExpenses; // Positive = Employee owes company (Advance), Negative = Company owes Employee
  };

  // --- Calc Vendor Balance ---
  const getVendorBalance = (vendorId) => {
    let totalPOs = 0;
    projects.forEach(p => {
        if(p.purchase_orders) {
            p.purchase_orders.forEach(po => {
                if(po.vendor_id === vendorId && po.status !== 'Cancelled') {
                    // Cost waterfall: invoice (Accepted/Verified) → PO cost → allocation estimate
                    totalPOs += getEffectivePOCost(po).total;
                }
            });
        }
    });
    const totalPaid = vendorPayments.filter(p => p.vendor_id === vendorId).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    return totalPOs - totalPaid; // Positive = We owe Vendor
  };

  const currentList = useMemo(() => {
    let list;
    if (activeTab === 'client_in') list = [...payments];
    else if (activeTab === 'vendor_out') list = [...vendorPayments];
    else if (activeTab === 'emp_out') list = [...payouts];
    else list = [];
    list.sort((a, b) => new Date(b.date) - new Date(a.date));
    return list;
  }, [activeTab, payments, vendorPayments, payouts]);

  // Derive FY list for filter dropdown
  const fyList = useMemo(() => {
    const fys = new Set(currentList.map(item => getFYFromDate(item.date)));
    return Array.from(fys).sort().reverse();
  }, [currentList]);

  // Filtered + grouped list
  const filteredList = useMemo(() => {
    if (fyFilter === 'all') return currentList;
    return currentList.filter(item => getFYFromDate(item.date) === fyFilter);
  }, [currentList, fyFilter]);

  // Build FY-grouped rows for display
  const groupedRows = useMemo(() => {
    if (filteredList.length === 0) return [];
    const groups = {};
    filteredList.forEach(item => {
      const fy = getFYFromDate(item.date);
      if (!groups[fy]) groups[fy] = [];
      groups[fy].push(item);
    });
    const rows = [];
    const sortedFYs = Object.keys(groups).sort().reverse();
    sortedFYs.forEach(fy => {
      const fyTotal = groups[fy].reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
      const isLocked = lockedFYs.includes(fy);
      rows.push({ _type: 'fy_header', fy, count: groups[fy].length, total: fyTotal, isLocked });
      groups[fy].forEach(item => rows.push({ ...item, _type: 'row' }));
    });
    return rows;
  }, [filteredList, lockedFYs]);

  const paginatedList = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return groupedRows.slice(start, start + itemsPerPage);
  }, [groupedRows, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, fyFilter]);

  const exportCSV = () => {
    if (filteredList.length === 0) return notify('No records to export', 'error');
    const label = activeTab === 'client_in' ? 'Client_Payments' : activeTab === 'vendor_out' ? 'Vendor_Payments' : 'Employee_Payouts';
    const rows = filteredList.map(item => ({
      Date: item.date,
      Name: item.client_name || item.vendor_name || item.employee_name || '',
      Company: item.party_company_name || '',
      Project: item.project_id === 'general' || !item.project_id
        ? 'General Account'
        : projects.find(p => p.id === item.project_id)?.project_name || item.project_id,
      Mode: item.mode || '',
      Reference: item.reference || '',
      Amount: item.amount,
      Remarks: item.remarks || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, label);
    XLSX.writeFile(wb, `${label}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Finance & Payments</h2>
        <div className="flex bg-white rounded-lg border p-1">
          <button onClick={() => handleTabChange('client_in')} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors flex-1 ${activeTab === 'client_in' ? 'bg-green-100 text-green-700' : 'text-slate-600 hover:bg-slate-50'}`}>Receive Payment (In)</button>
          {role !== 'manager' && <button onClick={() => handleTabChange('emp_out')} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors flex-1 ${activeTab === 'emp_out' ? 'bg-red-100 text-red-700' : 'text-slate-600 hover:bg-slate-50'}`}>Employee Payout</button>}
          {role !== 'manager' && <button onClick={() => handleTabChange('vendor_out')} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors flex-1 ${activeTab === 'vendor_out' ? 'bg-orange-100 text-orange-700' : 'text-slate-600 hover:bg-slate-50'}`}>Pay Vendor (Out)</button>}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-12">
        {/* --- FORM SECTION --- */}
        <div className="md:col-span-4 space-y-4 ">
          {!can(role, 'finance', 'create') ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex flex-col items-center text-center gap-2">
              <Lock size={22} className="text-amber-500" />
              <p className="text-sm font-bold text-amber-700">View Only</p>
              <p className="text-xs text-amber-600">Your role ({role}) can view financial records but cannot add or edit transactions. Contact the Owner or Accountant.</p>
            </div>
          ) : (
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className={`font-bold text-lg mb-4 flex items-center gap-2 ${activeTab === 'client_in' ? 'text-green-700' : activeTab === 'vendor_out' ? 'text-orange-700' : 'text-red-700'}`}>
              {activeTab === 'client_in' ? <TrendingUp /> : <TrendingDown />}
              {editingId ? 'Edit Payment Record' : (activeTab === 'client_in' ? 'Record Incoming Payment' : activeTab === 'vendor_out' ? 'Record Vendor Payment' : 'Record Employee Payout')}
            </h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">{activeTab === 'client_in' ? 'Received From Client' : activeTab === 'vendor_out' ? 'Pay To Vendor' : 'Pay To Employee'}</label>
                <select className="w-full rounded border p-2 bg-slate-50 text-black" value={form.entity_id ? (form.party_company_id && form.party_company_id !== 'primary' ? `${form.entity_id}::${form.party_company_id}` : form.entity_id) : ''} onChange={e => {
                  if (activeTab === 'emp_out') {
                    setForm({...form, entity_id: e.target.value, party_company_id: 'primary'});
                    return;
                  }
                  const selected = financeEntityOptions.find(x => x.value === e.target.value);
                  setForm({
                    ...form,
                    entity_id: selected?.entity_id || '',
                    party_company_id: selected?.company_id || 'primary'
                  });
                }}>
                  <option value="">-- Select --</option>
                  {activeTab === 'client_in'
                    ? financeEntityOptions.filter(c => c.type !== 'Vendor').map(c => <option key={c.value} value={c.value}>{c.label}</option>)
                    : activeTab === 'vendor_out'
                      ? financeEntityOptions.filter(c => c.type === 'Vendor' || c.type === 'Both').map(v => <option key={v.value} value={v.value}>{v.label}</option>)
                      : employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)
                  }
                </select>
              </div>

              {/* Show Balance Context */}
              {form.entity_id && activeTab === 'emp_out' && (
                <div className={`p-2 rounded text-xs font-bold border ${getEmpBalance(form.entity_id) < 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                  Current Balance: {formatCurrency(Math.abs(getEmpBalance(form.entity_id)))}
                  {getEmpBalance(form.entity_id) < 0 ? ' (Company owes Employee)' : ' (Employee has Advance)'}
                </div>
              )}

              {form.entity_id && activeTab === 'vendor_out' && (
                <div className={`p-2 rounded text-xs font-bold border ${getVendorBalance(form.entity_id) > 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                  Outstanding Balance: {formatCurrency(getVendorBalance(form.entity_id))}
                  {getVendorBalance(form.entity_id) > 0 ? ' (We Owe)' : ' (Paid/Advance)'}
                </div>
              )}

              {(activeTab === 'client_in' || activeTab === 'vendor_out') && (
                <div>
                   <label className="text-xs font-bold text-slate-700 uppercase">Against Project (Optional)</label>
                   <select className="w-full rounded border p-2 bg-slate-50 text-black" value={form.project_id} onChange={e => {
                     const selectedProjectId = e.target.value;
                     const selectedProject = projects.find(p => p.id === selectedProjectId);
                     setForm({
                       ...form,
                       project_id: selectedProjectId,
                       party_company_id: selectedProject?.party_company_id || form.party_company_id,
                     });
                   }}>
                      <option value="">General / On Account</option>
                      {projects.filter(p => p.client_id === form.entity_id).map(p => (
                        <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>
                      ))}
                   </select>
                </div>
              )}

              {(activeTab === 'client_in' || activeTab === 'vendor_out') && form.entity_id && (() => {
                const selectedEntity = clients.find(c => c.id === form.entity_id);
                const companies = getEntityCompanies(selectedEntity);
                return (
                  <div>
                    <label className="text-xs font-bold text-slate-700 uppercase">Company / Branch</label>
                    <select
                      className="w-full rounded border p-2 bg-slate-50 text-black"
                      value={form.party_company_id || 'primary'}
                      onChange={e => setForm({ ...form, party_company_id: e.target.value })}
                    >
                      {companies.map(c => (
                        <option key={c.id} value={c.id}>{c.name}{c.gstin ? ` (${c.gstin})` : ''}</option>
                      ))}
                    </select>
                  </div>
                );
              })()}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700 uppercase">Amount</label>
                  <input type="number" className="w-full rounded border p-2 text-black" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 uppercase">Date</label>
                  <input type="date" className="w-full rounded border p-2 text-black" value={form.date} onChange={e => setForm({...form, date: e.target.value})} />
                </div>
              </div>
              {form.date && isFYLocked(form.date) && (
                <div className="p-2 rounded text-xs font-bold border bg-red-50 border-red-200 text-red-700 flex items-center gap-2">
                  <Lock size={13} /> FY {getFYFromDate(form.date)} is locked — this transaction will be blocked.
                </div>
              )}

              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">Payment Mode</label>
                <select className="w-full rounded border p-2 text-black" value={form.mode} onChange={e => setForm({...form, mode: e.target.value})}>
                  {role === 'manager' ? (
                    <><option>Cash</option><option>UPI / Online</option></>
                  ) : (
                    <><option>Bank Transfer</option><option>Cash</option><option>Cheque</option><option>UPI / Online</option></>
                  )}
                </select>
                {role === 'manager' && <p className="text-[10px] text-amber-600 mt-1">On-site receipts limited to Cash / UPI. Bank Transfer & Cheque must be recorded by Accountant.</p>}
              </div>

              {activeTab === 'emp_out' && (
                <div>
                  <label className="text-xs font-bold text-slate-700 uppercase">Payment For</label>
                  <select className="w-full rounded border p-2 text-black" value={form.payout_type} onChange={e => setForm({...form, payout_type: e.target.value})}>
                    <option value="salary">Salary / Wages</option>
                    <option value="reimbursement">Reimbursement (clear expense claim)</option>
                    <option value="advance">Advance (paid to employee)</option>
                  </select>
                  <p className="text-[10px] text-slate-500 mt-1">
                    {form.payout_type === 'salary'
                      ? 'Books to Salary Expense.'
                      : form.payout_type === 'reimbursement'
                        ? 'Clears what this employee is owed (their expense-claim balance).'
                        : 'Recorded against this employee’s account — they now owe it back.'}
                  </p>
                </div>
              )}

              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">Reference / Trx ID</label>
                <input type="text" className="w-full rounded border p-2 text-black" value={form.reference} onChange={e => setForm({...form, reference: e.target.value})} />
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">Remarks</label>
                <textarea className="w-full rounded border p-2 text-sm text-black" rows={2} value={form.remarks} onChange={e => setForm({...form, remarks: e.target.value})} />
              </div>

              {editingId && (
                  <button onClick={cancelEdit} className="w-full py-2 rounded text-slate-600 font-bold border border-slate-300 hover:bg-slate-50 mb-2">Cancel Edit</button>
              )}
              <button
                onClick={activeTab === 'client_in' ? handleClientPayment : activeTab === 'vendor_out' ? handleVendorPayment : handleEmpPayout}
                className={`w-full py-3 rounded text-white font-bold shadow-sm ${activeTab === 'client_in' ? 'bg-green-600 hover:bg-green-700' : activeTab === 'vendor_out' ? 'bg-orange-600 hover:bg-orange-700' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {editingId ? 'Update Record' : (activeTab === 'client_in' ? 'Receive Payment' : activeTab === 'vendor_out' ? 'Record Vendor Payment' : 'Process Payout')}
              </button>
            </div>
          </div>
          )}
        </div>

        {/* --- LIST SECTION --- */}
        <div className="md:col-span-8">
           <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
             <div className="p-4 border-b bg-slate-50 font-bold text-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
               <span>Recent {activeTab === 'client_in' ? 'Client Payments' : activeTab === 'vendor_out' ? 'Vendor Payments' : 'Employee Payouts'}</span>
               <div className="flex items-center gap-2">
                 <div className="flex items-center gap-1.5">
                   <Filter size={13} className="text-slate-400" />
                   <select
                     value={fyFilter}
                     onChange={e => setFyFilter(e.target.value)}
                     className="text-xs border border-slate-300 rounded px-2 py-1.5 bg-white text-slate-700 font-medium"
                   >
                     <option value="all">All FYs</option>
                     {fyList.map(fy => (
                       <option key={fy} value={fy}>FY {fy}{lockedFYs.includes(fy) ? ' 🔒' : ''}</option>
                     ))}
                   </select>
                 </div>
                 <button
                   onClick={exportCSV}
                   className="flex items-center gap-1.5 text-xs bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 font-medium"
                 >
                   <Download size={13} /> Export Excel
                 </button>
               </div>
             </div>
             {/* FY Lock banner */}
             {fyFilter !== 'all' && lockedFYs.includes(fyFilter) && (
               <div className="px-4 py-2 bg-red-50 border-b border-red-200 flex items-center gap-2 text-xs font-semibold text-red-700">
                 <Lock size={13} /> FY {fyFilter} is locked — transactions cannot be added, edited, or deleted.
               </div>
             )}
             {/* Mobile card view */}
             <div className="block md:hidden divide-y divide-slate-100">
               {paginatedList.map((item) => {
                 if (item._type === 'fy_header') return (
                   <div key={`fh-${item.fy}`} className={`p-3 font-bold text-sm flex items-center justify-between ${item.isLocked ? 'bg-red-50 text-red-800' : 'bg-indigo-50 text-indigo-800'}`}>
                     <span className="flex items-center gap-2">{item.isLocked && <Lock size={13} />}FY {item.fy} ({item.count} records)</span>
                     <span>{formatCurrency(item.total)}</span>
                   </div>
                 );
                 return (
                 <div key={item.id} className="p-4 hover:bg-slate-50">
                   <div className="flex items-start justify-between gap-2">
                     <div className="flex-1 min-w-0">
                       <div className="font-semibold text-sm text-slate-800 truncate">{item.client_name || item.vendor_name || item.employee_name}</div>
                       {(item.party_company_name && (activeTab === 'client_in' || activeTab === 'vendor_out')) && (
                         <div className="text-[11px] text-indigo-600 mt-0.5">{item.party_company_name}</div>
                       )}
                       <div className="text-xs text-slate-500 mt-0.5">
                         {activeTab === 'client_in' || activeTab === 'vendor_out'
                           ? (item.project_id === 'general' || !item.project_id ? 'General Account' : projects.find(p => p.id === item.project_id)?.project_name)
                           : item.mode}
                       </div>
                       <div className="flex gap-3 mt-1 text-xs text-slate-400">
                         <span>{fmtDate(item.date)}</span>
                         {item.reference && <span className="truncate max-w-[120px]">Ref: {item.reference}</span>}
                       </div>
                     </div>
                     <div className="flex flex-col items-end gap-1">
                       <span className={`font-bold text-sm ${activeTab === 'client_in' ? 'text-green-600' : activeTab === 'vendor_out' ? 'text-orange-600' : 'text-red-600'}`}>
                         {formatCurrency(item.amount)}
                       </span>
                       {can(role,'finance','edit') && !isFYLocked(item.date) && (
                       <div className="flex gap-1">
                         <button onClick={() => handleEdit(item)} className="text-blue-600 hover:bg-blue-50 p-1 rounded"><Edit size={13}/></button>
                         <button onClick={() => handleDelete(item)} className="text-red-600 hover:bg-red-50 p-1 rounded"><Trash2 size={13}/></button>
                       </div>
                       )}
                       {isFYLocked(item.date) && <Lock size={12} className="text-red-400" />}
                     </div>
                   </div>
                 </div>
               );})}
               {paginatedList.length === 0 && <div className="p-8 text-center text-slate-400 text-sm">No records found.</div>}
             </div>

             {/* Desktop table view */}
             <div className="hidden md:block overflow-x-auto">
               <table className="w-full text-left text-sm">
                <thead className="bg-white text-slate-700 font-semibold border-b">
                   <tr>
                     <th className="p-3">Date</th>
                     <th className="p-3">Name</th>
                     <th className="p-3">Company</th>
                     <th className="p-3">{activeTab === 'client_in' ? 'Project' : 'Mode'}</th>
                     <th className="p-3">Reference</th>
                     <th className="p-3 text-right">Amount</th>
                     <th className="p-3 text-center">Actions</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-slate-50">
                   {paginatedList.map((item) => {
                    if (item._type === 'fy_header') return (
                      <tr key={`fh-${item.fy}`} className={item.isLocked ? 'bg-red-50' : 'bg-indigo-50'}>
                        <td colSpan={6} className={`p-3 font-bold text-sm ${item.isLocked ? 'text-red-800' : 'text-indigo-800'}`}>
                          <span className="flex items-center gap-2">{item.isLocked && <Lock size={13} />}FY {item.fy} — {item.count} records — Total: {formatCurrency(item.total)}</span>
                        </td>
                        <td className="p-3 text-center">
                          {item.isLocked && <span className="text-xs text-red-600 font-semibold">Locked</span>}
                        </td>
                      </tr>
                    );
                    const rowLocked = isFYLocked(item.date);
                    return (
                    <tr key={item.id} className={`hover:bg-slate-50 ${rowLocked ? 'opacity-75' : ''}`}>
                       <td className="p-3 text-slate-700">{fmtDate(item.date)}</td>
                       <td className="p-3 font-medium text-slate-800">{item.client_name || item.vendor_name || item.employee_name}</td>
                       <td className="p-3 text-slate-500 text-xs">{(activeTab === 'client_in' || activeTab === 'vendor_out') ? (item.party_company_name || '-') : '-'}</td>
                       <td className="p-3 text-slate-500">
                         {activeTab === 'client_in' || activeTab === 'vendor_out'
                           ? (item.project_id === 'general' || !item.project_id ? 'General Account' : projects.find(p=>p.id===item.project_id)?.project_name)
                           : item.mode
                         }
                       </td>
                       <td className="p-3 text-slate-500 text-xs">{item.reference || '-'}</td>
                       <td className={`p-3 text-right font-bold ${activeTab === 'client_in' ? 'text-green-600' : activeTab === 'vendor_out' ? 'text-orange-600' : 'text-red-600'}`}>
                         {formatCurrency(item.amount)}
                         {item.status === 'Pending Review' && (
                           <span className="ml-2 text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">Pending Review</span>
                         )}
                       </td>
                       <td className="p-3 text-center flex justify-center gap-2">
                           {rowLocked ? (
                             <Lock size={14} className="text-red-400" title="FY Locked" />
                           ) : (
                             <>
                               {item.status === 'Pending Review' && can(role,'finance','edit') && (
                                 <button onClick={() => handleApprovePayment(item)} className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 font-semibold">Approve</button>
                               )}
                               {can(role,'finance','edit') && item.status !== 'Pending Review' && <button onClick={() => handleEdit(item)} className="text-blue-600 hover:bg-blue-50 p-1 rounded"><Edit size={14}/></button>}
                               {can(role,'finance','delete') && <button onClick={() => handleDelete(item)} className="text-red-600 hover:bg-red-50 p-1 rounded"><Trash2 size={14}/></button>}
                             </>
                           )}
                       </td>
                     </tr>
                   );})}
                 </tbody>
               </table>
               {groupedRows.length === 0 && (
                 <div className="p-8 text-center text-slate-400">No records found.</div>
               )}
             </div>{/* end desktop table overflow-x-auto */}
             <div className="flex items-center justify-between p-4 border-t bg-white">
                <div className="text-sm text-slate-500">
                    Showing {Math.min((currentPage - 1) * itemsPerPage + 1, groupedRows.length)} to {Math.min(currentPage * itemsPerPage, groupedRows.length)} of {groupedRows.length} rows ({filteredList.length} records)
                </div>
                <div className="flex gap-2">
                    <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                    <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(groupedRows.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(groupedRows.length / itemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
                </div>
             </div>
           </div>
        </div>
      </div>
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

export default Finance;
