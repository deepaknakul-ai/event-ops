import React, { useState, useMemo, useCallback } from 'react';
import { CalendarDays, Plus, Search, CheckCircle, XCircle, Eye, Ban } from 'lucide-react';
import { addDoc, updateDoc, doc, collection } from 'firebase/firestore';
import { calculateLeaveBalance } from '../utils/helpers';
import { LEAVE_TYPES, LEAVE_ENTITLEMENTS, HR_STATUS_COLORS } from '../utils/constants';
import { can } from '../utils/permissions';

const HRLeaves = ({ employees = [], hrLeaves = [], role, currentEmpId, db, appId, logAction, addToast }) => {
  const [tab, setTab] = useState(0); // 0=Requests, 1=Balances
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [form, setForm] = useState({ employeeId: '', type: 'Casual', startDate: '', endDate: '', reason: '', adminRemarks: '' });

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e])), [employees]);
  const getEmpName = useCallback((id) => empMap[id]?.name || id?.slice(0, 8), [empMap]);
  const canViewAll = can(role, 'hr_leaves', 'view');

  // Filtered leaves
  const filtered = useMemo(() => {
    let list = [...hrLeaves].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    if (!canViewAll) list = list.filter(l => l.employeeId === currentEmpId);
    if (filterStatus) list = list.filter(l => l.status === filterStatus);
    if (filterType) list = list.filter(l => l.type === filterType);
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(l => getEmpName(l.employeeId).toLowerCase().includes(s) || l.reason?.toLowerCase().includes(s));
    }
    return list;
  }, [hrLeaves, search, filterStatus, filterType, canViewAll, currentEmpId, getEmpName]);

  // Leave balances per employee (FY scope)
  const balances = useMemo(() => {
    const activeEmps = employees.filter(e => e.status !== 'Inactive');
    return activeEmps.map(e => {
      const empLeaves = hrLeaves.filter(l => l.employeeId === e.id);
      const bal = calculateLeaveBalance(empLeaves, LEAVE_ENTITLEMENTS);
      return { ...e, balance: bal };
    });
  }, [employees, hrLeaves]);

  const filteredBalances = useMemo(() => {
    if (!search) return balances;
    const s = search.toLowerCase();
    return balances.filter(b => b.name?.toLowerCase().includes(s));
  }, [balances, search]);

  const getDays = (start, end) => {
    if (!start || !end) return 0;
    return Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 86400000) + 1);
  };

  // Admin marking leave for someone = auto-approved; employee applying = Pending.
  const isAdminMarking = role === 'admin' && !!form.employeeId && form.employeeId !== currentEmpId;

  const openNew = () => {
    setForm({ employeeId: canViewAll ? '' : currentEmpId, type: 'Casual', startDate: '', endDate: '', reason: '', adminRemarks: '' });
    setShowModal(true);
  };

  const handleSave = async () => {
    const { employeeId, type, startDate, endDate, reason, adminRemarks } = form;
    if (!employeeId || !type || !startDate || !endDate || !reason) return addToast('All fields required', 'error');
    if (new Date(endDate) < new Date(startDate)) return addToast('End date must be after start date', 'error');
    try {
      const adminApproving = role === 'admin';
      const now = new Date().toISOString();
      const data = {
        employeeId, type, startDate, endDate, reason,
        status: adminApproving ? 'Approved' : 'Pending',
        created_at: now,
        ...(adminApproving ? {
          approvedBy: currentEmpId,
          approvedAt: now,
          markedByAdmin: true,
          ...(adminRemarks.trim() ? { adminRemarks: adminRemarks.trim() } : {}),
        } : {}),
      };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'leaves'), data);
      logAction('leaves', 'create', ref.id, data, adminApproving ? 'Leave marked by admin' : 'Leave application submitted');
      addToast(adminApproving ? `Leave marked as Approved for ${getEmpName(employeeId)}` : 'Leave request submitted', 'success');
      setShowModal(false);
    } catch (e) { console.error(e); addToast('Error submitting leave', 'error'); }
  };

  const handleAction = async (leave, action) => {
    if (!can(role, 'hr_leaves', 'approve')) return alert('Access denied.');
    try {
      const update = { status: action, approvedBy: currentEmpId, approvedAt: new Date().toISOString() };
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leaves', leave.id), update);
      logAction('leaves', action.toLowerCase(), leave.id, update, `Leave ${action}`);
      addToast(`Leave ${action}`, 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // Cancel an already-approved leave (admin/manager/HR). Restores the day(s) to
  // the employee's balance automatically, since balances count only 'Approved'.
  const handleCancelApproved = async (leave) => {
    if (!can(role, 'hr_leaves', 'cancel')) return alert('Access denied.');
    const reason = window.prompt(`Cancel approved ${leave.type} leave for ${getEmpName(leave.employeeId)} (${fmtDate(leave.startDate)} — ${fmtDate(leave.endDate)})?\n\nReason (required):`, '');
    if (reason === null) return;           // user dismissed
    if (!reason.trim()) return addToast('A reason is required to cancel a leave', 'error');
    try {
      const update = {
        status: 'Cancelled',
        cancelledBy: currentEmpId,
        cancelledAt: new Date().toISOString(),
        cancelReason: reason.trim(),
      };
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leaves', leave.id), update);
      logAction('leaves', 'cancel', leave.id, update, `Leave cancelled — ${getEmpName(leave.employeeId)}`);
      addToast('Approved leave cancelled — balance restored', 'info');
    } catch (e) { console.error(e); addToast('Error cancelling leave', 'error'); }
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '-';

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><CalendarDays size={24} /> Leave Management</h2>
        {can(role, 'hr_leaves', 'create') && (
          <button onClick={openNew} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 flex items-center gap-1">
            <Plus size={14} /> {role === 'admin' ? 'Mark Leave' : 'Apply Leave'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {['Leave Requests', 'Leave Balances'].map((t, i) => (
          <button key={t} onClick={() => setTab(i)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === i ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t}
            {i === 0 && hrLeaves.filter(l => l.status === 'Pending').length > 0 && <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs rounded-full bg-amber-100 text-amber-800">{hrLeaves.filter(l => l.status === 'Pending').length}</span>}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="w-full rounded border border-slate-300 pl-9 pr-3 py-2 text-sm text-black" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {tab === 0 && (
          <>
            <select className="rounded border border-slate-300 p-2 text-sm text-black" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">All Statuses</option>
              <option value="Pending">Pending</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
              <option value="Cancelled">Cancelled</option>
            </select>
            <select className="rounded border border-slate-300 p-2 text-sm text-black" value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="">All Types</option>
              {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </>
        )}
      </div>

      {/* ═══════ TAB 0: LEAVE REQUESTS ═══════ */}
      {tab === 0 && (
        <div className="space-y-3">
          {filtered.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No leave requests found.</p>}
          {filtered.map(leave => (
            <div key={leave.id} className={`rounded-xl border p-4 shadow-sm ${HR_STATUS_COLORS[leave.status] || 'bg-white'}`}>
              <div className="flex flex-col sm:flex-row justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-800">{getEmpName(leave.employeeId)}</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${leave.type === 'Casual' ? 'bg-blue-100 text-blue-700' : leave.type === 'Sick' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{leave.type}</span>
                  </div>
                  <div className="text-xs text-slate-600 mt-1">
                    {fmtDate(leave.startDate)} — {fmtDate(leave.endDate)}
                    <span className="ml-2 font-medium">({getDays(leave.startDate, leave.endDate)} day{getDays(leave.startDate, leave.endDate) > 1 ? 's' : ''})</span>
                  </div>
                  <div className="text-sm text-slate-700 mt-1">{leave.reason}</div>
                  {leave.approvedBy && <div className="text-xs text-slate-500 mt-1">Reviewed by {getEmpName(leave.approvedBy)} on {fmtDate(leave.approvedAt)}</div>}
                </div>
                <div className="flex items-start gap-2 shrink-0">
                  <span className={`text-xs font-semibold px-2 py-1 rounded ${leave.status === 'Approved' ? 'bg-green-200 text-green-800' : leave.status === 'Rejected' ? 'bg-red-200 text-red-800' : leave.status === 'Cancelled' ? 'bg-slate-200 text-slate-600' : 'bg-amber-200 text-amber-800'}`}>{leave.status}</span>
                  {leave.status === 'Pending' && can(role, 'hr_leaves', 'approve') && (
                    <>
                      <button onClick={() => handleAction(leave, 'Approved')} className="text-green-600 hover:text-green-800" title="Approve"><CheckCircle size={18} /></button>
                      <button onClick={() => handleAction(leave, 'Rejected')} className="text-red-600 hover:text-red-800" title="Reject"><XCircle size={18} /></button>
                    </>
                  )}
                  {leave.status === 'Approved' && can(role, 'hr_leaves', 'cancel') && (
                    <button onClick={() => handleCancelApproved(leave)} className="text-orange-600 hover:text-orange-800" title="Cancel approved leave"><Ban size={18} /></button>
                  )}
                  <button onClick={() => setShowDetail(leave)} className="text-slate-400 hover:text-slate-600" title="View"><Eye size={18} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══════ TAB 1: LEAVE BALANCES ═══════ */}
      {tab === 1 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
                <th className="p-3">Employee</th>
                {LEAVE_TYPES.map(t => (
                  <th key={t} className="p-3 text-center">{t}<br /><span className="text-slate-400 font-normal">({LEAVE_ENTITLEMENTS[t]})</span></th>
                ))}
                <th className="p-3 text-center">Total Available</th>
              </tr>
            </thead>
            <tbody>
              {filteredBalances.map(emp => {
                const total = LEAVE_TYPES.reduce((s, t) => s + (emp.balance[t] || 0), 0);
                return (
                  <tr key={emp.id} className="border-b last:border-0 hover:bg-slate-50">
                    <td className="p-3 font-medium text-slate-800">{emp.name}</td>
                    {LEAVE_TYPES.map(t => (
                      <td key={t} className="p-3 text-center">
                        <span className={`font-bold ${emp.balance[t] > 0 ? 'text-green-600' : 'text-red-600'}`}>{emp.balance[t]}</span>
                      </td>
                    ))}
                    <td className="p-3 text-center font-bold text-indigo-600">{total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredBalances.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No employees.</p>}
        </div>
      )}

      {/* ═══════ APPLY LEAVE MODAL ═══════ */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-bold text-slate-800 mb-1">
              {isAdminMarking ? 'Mark Leave for Employee' : 'Apply for Leave'}
            </h3>
            {isAdminMarking && (
              <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-1.5 mb-3">
                Leave will be created as <strong>Approved</strong> immediately — no separate approval needed.
              </p>
            )}
            <div className="space-y-3">
              {canViewAll && (
                <div>
                  <label className="text-xs font-bold text-slate-700">Employee</label>
                  <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}>
                    <option value="">Select Employee</option>
                    {employees.filter(e => e.status !== 'Inactive').map(e => <option key={e.id} value={e.id}>{e.name}{e.id === currentEmpId ? ' (You)' : ''}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-slate-700">Leave Type</label>
                <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700">Start Date</label>
                  <input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700">End Date</label>
                  <input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} />
                </div>
              </div>
              {form.startDate && form.endDate && (
                <p className="text-xs text-indigo-600 font-medium">{getDays(form.startDate, form.endDate)} day(s)</p>
              )}
              <div>
                <label className="text-xs font-bold text-slate-700">{isAdminMarking ? 'Reason (on behalf of employee)' : 'Reason'}</label>
                <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
              </div>
              {isAdminMarking && (
                <div>
                  <label className="text-xs font-bold text-slate-700">Admin Remarks <span className="font-normal text-slate-400">(optional)</span></label>
                  <input type="text" className="w-full rounded border border-slate-300 p-2 text-sm text-black" placeholder="e.g. Pre-approved, medical emergency…" value={form.adminRemarks} onChange={e => setForm({ ...form, adminRemarks: e.target.value })} />
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowModal(false)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSave} className={`rounded px-4 py-2 text-sm text-white font-medium ${isAdminMarking ? 'bg-green-600 hover:bg-green-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                {isAdminMarking ? 'Mark as Approved' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {showDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowDetail(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-800 mb-4">Leave Details</h3>
            <div className="space-y-2 text-sm">
              <div><span className="text-slate-500">Employee:</span> <span className="font-medium">{getEmpName(showDetail.employeeId)}</span></div>
              <div><span className="text-slate-500">Type:</span> <span className="font-medium">{showDetail.type}</span></div>
              <div><span className="text-slate-500">Period:</span> {fmtDate(showDetail.startDate)} — {fmtDate(showDetail.endDate)} ({getDays(showDetail.startDate, showDetail.endDate)} day{getDays(showDetail.startDate, showDetail.endDate) > 1 ? 's' : ''})</div>
              <div><span className="text-slate-500">Reason:</span> {showDetail.reason}</div>
              <div><span className="text-slate-500">Status:</span> <span className={`font-bold ${showDetail.status === 'Approved' ? 'text-green-600' : showDetail.status === 'Rejected' ? 'text-red-600' : showDetail.status === 'Cancelled' ? 'text-slate-500' : 'text-amber-600'}`}>{showDetail.status}</span></div>
              {showDetail.approvedBy && <div><span className="text-slate-500">Reviewed by:</span> {getEmpName(showDetail.approvedBy)} on {fmtDate(showDetail.approvedAt)}{showDetail.markedByAdmin ? ' (marked by admin)' : ''}</div>}
              {showDetail.adminRemarks && <div><span className="text-slate-500">Admin Remarks:</span> {showDetail.adminRemarks}</div>}
              {showDetail.status === 'Cancelled' && showDetail.cancelledBy && <div><span className="text-slate-500">Cancelled by:</span> {getEmpName(showDetail.cancelledBy)} on {fmtDate(showDetail.cancelledAt)}</div>}
              {showDetail.cancelReason && <div><span className="text-slate-500">Cancel reason:</span> {showDetail.cancelReason}</div>}
              <div><span className="text-slate-500">Applied:</span> {fmtDate(showDetail.created_at)}</div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              {showDetail.status === 'Pending' && can(role, 'hr_leaves', 'approve') && (
                <>
                  <button onClick={() => { handleAction(showDetail, 'Approved'); setShowDetail(null); }} className="rounded bg-green-600 px-4 py-2 text-sm text-white font-medium hover:bg-green-700">Approve</button>
                  <button onClick={() => { handleAction(showDetail, 'Rejected'); setShowDetail(null); }} className="rounded bg-red-600 px-4 py-2 text-sm text-white font-medium hover:bg-red-700">Reject</button>
                </>
              )}
              {showDetail.status === 'Approved' && can(role, 'hr_leaves', 'cancel') && (
                <button onClick={() => { handleCancelApproved(showDetail); setShowDetail(null); }} className="rounded bg-orange-600 px-4 py-2 text-sm text-white font-medium hover:bg-orange-700">Cancel Leave</button>
              )}
              <button onClick={() => setShowDetail(null)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HRLeaves;
