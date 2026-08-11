import React, { useState, useMemo, useCallback } from 'react';
import { confirmDialog, promptDialog } from '../utils/dialog';
import { Clock, Search, Filter, Users, MapPin, AlertTriangle, CheckCircle, XCircle, MessageSquare, Trash2, Plus, Edit2 } from 'lucide-react';
import { doc, addDoc, updateDoc, deleteDoc, collection } from 'firebase/firestore';
import { getLogHours } from '../utils/helpers';
import { SHIFT_REQUEST_STATUSES, HR_STATUS_COLORS } from '../utils/constants';
import { can } from '../utils/permissions';

const TABS = ['Attendance Log', 'Shift Requests', 'Penalties'];

const HRAttendance = ({ employees = [], timeLogs = [], shiftRequests = [], penalties = [], role, currentEmpId, db, appId, logAction, addToast, hqSettings = {} }) => {
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterLocation, setFilterLocation] = useState('');

  // Shift request modal
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [editShift, setEditShift] = useState(null);
  const [shiftForm, setShiftForm] = useState({ employeeId: '', startTime: '', endTime: '', location: 'HQ', reason: '' });

  // Penalty modal
  const [showPenaltyModal, setShowPenaltyModal] = useState(false);
  const [penaltyForm, setPenaltyForm] = useState({ employeeId: '', minutes: 0, reason: '' });

  // Close shift modal
  const [closeTarget, setCloseTarget] = useState(null);
  const [closeTime, setCloseTime] = useState('');

  // Adjust checkout modal (admin correction of suspicious late checkouts)
  const [adjustTarget, setAdjustTarget] = useState(null);
  const [adjustTime, setAdjustTime] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e])), [employees]);

  const getEmpName = useCallback((id) => empMap[id]?.name || id?.slice(0, 8), [empMap]);

  // ── Tab 0: Attendance Log ─────────────────────────────────────────────────
  const filteredLogs = useMemo(() => {
    let logs = [...timeLogs].sort((a, b) => new Date(b.checkIn || 0) - new Date(a.checkIn || 0));
    if (filterDate) logs = logs.filter(l => l.checkIn?.startsWith(filterDate));
    if (filterEmployee) logs = logs.filter(l => l.employeeId === filterEmployee);
    if (filterLocation) logs = logs.filter(l => l.location === filterLocation);
    if (search) {
      const s = search.toLowerCase();
      logs = logs.filter(l => getEmpName(l.employeeId).toLowerCase().includes(s) || l.location?.toLowerCase().includes(s) || l.project_name?.toLowerCase().includes(s));
    }
    return logs;
  }, [timeLogs, filterDate, filterEmployee, filterLocation, search, getEmpName]);

  // Force close open shift
  const handleCloseShift = async () => {
    if (!closeTarget || !closeTime) return;
    if (!can(role, 'hr_attendance', 'close_shift')) return addToast('Access denied.', 'error');
    try {
      const ref = doc(db, 'artifacts', appId, 'public', 'data', 'timeLogs', closeTarget.id);
      await updateDoc(ref, { checkOut: new Date(closeTime).toISOString(), autoClosed: true });
      logAction('timeLogs', 'force_close', closeTarget.id, { checkOut: closeTime }, 'Admin force-closed shift');
      addToast('Shift closed', 'success');
      setCloseTarget(null);
    } catch (e) { console.error(e); addToast('Error closing shift', 'error'); }
  };

  // Delete time log
  const handleDeleteLog = async (logId) => {
    if (!can(role, 'hr_attendance', 'delete')) return addToast('Access denied.', 'error');
    if (!await confirmDialog('Delete this attendance record?')) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'timeLogs', logId));
      logAction('timeLogs', 'delete', logId, null, 'Deleted attendance record');
      addToast('Record deleted', 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // Admin: correct checkout time for suspicious records
  const handleAdjustCheckout = async () => {
    if (!adjustTarget || !adjustTime || !adjustReason.trim()) return addToast('All fields required', 'error');
    if (!can(role, 'hr_attendance', 'close_shift')) return addToast('Access denied.', 'error');
    try {
      const ref = doc(db, 'artifacts', appId, 'public', 'data', 'timeLogs', adjustTarget.id);
      const correctedCheckOut = new Date(adjustTime).toISOString();
      await updateDoc(ref, {
        checkOut: correctedCheckOut,
        adminAdjusted: true,
        adminAdjustReason: adjustReason.trim(),
        adminAdjustedBy: currentEmpId,
        adminAdjustedAt: new Date().toISOString(),
        lateCheckout: false,
        suspiciousNightCheckout: false,
      });
      logAction('timeLogs', 'admin_adjust_checkout', adjustTarget.id, { correctedCheckOut, reason: adjustReason }, 'Admin corrected suspicious checkout time');
      addToast('Checkout time corrected', 'success');
      setAdjustTarget(null); setAdjustTime(''); setAdjustReason('');
    } catch (e) { console.error(e); addToast('Error adjusting checkout', 'error'); }
  };

  // ── Tab 1: Shift Requests ─────────────────────────────────────────────────
  const filteredShifts = useMemo(() => {
    let list = [...shiftRequests].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    if (!can(role, 'hr_shifts', 'view')) list = list.filter(s => s.employeeId === currentEmpId);
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(sr => getEmpName(sr.employeeId).toLowerCase().includes(s) || sr.reason?.toLowerCase().includes(s));
    }
    return list;
  }, [shiftRequests, search, role, currentEmpId, getEmpName]);

  const openNewShift = () => {
    setEditShift(null);
    setShiftForm({ employeeId: can(role, 'hr_shifts', 'view') ? '' : currentEmpId, startTime: '', endTime: '', location: 'HQ', reason: '' });
    setShowShiftModal(true);
  };

  const handleSaveShift = async () => {
    const { employeeId, startTime, endTime, reason } = shiftForm;
    if (!employeeId || !startTime || !endTime || !reason) return addToast('All fields required', 'error');
    try {
      const data = { ...shiftForm, status: 'Pending', created_at: new Date().toISOString() };
      if (editShift) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'shiftRequests', editShift.id), data);
        logAction('shiftRequests', 'update', editShift.id, data, 'Updated shift request');
      } else {
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'shiftRequests'), data);
        logAction('shiftRequests', 'create', ref.id, data, 'Created shift request');
      }
      addToast('Shift request saved', 'success');
      setShowShiftModal(false);
    } catch (e) { console.error(e); addToast('Error saving shift request', 'error'); }
  };

  const handleShiftAction = async (sr, action, clarification) => {
    if (!can(role, 'hr_shifts', 'approve')) return addToast('Access denied.', 'error');
    try {
      const update = { status: action, reviewedBy: currentEmpId, reviewedAt: new Date().toISOString() };
      if (action === 'Clarification' && clarification) update.adminClarification = clarification;
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'shiftRequests', sr.id), update);
      // On approval (from a not-yet-approved request), record the attendance as a
      // timeLog tagged source:'SR' so it's distinguishable in every attendance view.
      if (action === 'Approved' && sr.status !== 'Approved') {
        const now = new Date().toISOString();
        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'timeLogs'), {
          employeeId: sr.employeeId,
          checkIn: sr.startTime,
          checkOut: sr.endTime || null,
          location: sr.location || 'HQ',
          project_id: sr.project_id || null,
          project_name: sr.project_name || null,
          geofenceVerified: null,
          geoPenaltyMinutes: 0,
          autoClosed: false,
          lateMinutes: 0,
          gpsCheckIn: null,
          gpsCheckOut: null,
          source: 'SR',
          sourceShiftRequestId: sr.id,
          created_at: now,
          adminAdjustedBy: currentEmpId,
          adminAdjustedAt: now,
        });
      }
      logAction('shiftRequests', action.toLowerCase(), sr.id, update, `Shift request ${action}`);
      addToast(action === 'Approved' ? 'Approved — attendance recorded (SR)' : `Request ${action}`, 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // ── Tab 2: Penalties ──────────────────────────────────────────────────────
  const filteredPenalties = useMemo(() => {
    let list = [...penalties].sort((a, b) => new Date(b.appliedAt || 0) - new Date(a.appliedAt || 0));
    if (filterEmployee) list = list.filter(p => p.employeeId === filterEmployee);
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(p => getEmpName(p.employeeId).toLowerCase().includes(s) || p.reason?.toLowerCase().includes(s));
    }
    return list;
  }, [penalties, filterEmployee, search, getEmpName]);

  const handleAddPenalty = async () => {
    if (!can(role, 'hr_penalties', 'create')) return addToast('Access denied.', 'error');
    const { employeeId, minutes, reason } = penaltyForm;
    if (!employeeId || !minutes || !reason) return addToast('All fields required', 'error');
    try {
      const data = { employeeId, minutes: parseFloat(minutes), reason, appliedBy: currentEmpId, appliedAt: new Date().toISOString() };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'penalties'), data);
      logAction('penalties', 'create', ref.id, data, 'Applied penalty');
      addToast('Penalty applied', 'success');
      setShowPenaltyModal(false);
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  const handleDeletePenalty = async (pId) => {
    if (!can(role, 'hr_penalties', 'create')) return addToast('Access denied.', 'error');
    if (!await confirmDialog('Remove this penalty?')) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'penalties', pId));
      logAction('penalties', 'delete', pId, null, 'Removed penalty');
      addToast('Penalty removed', 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '-';
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-';
  const fmtDateTime = (iso) => iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '-';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Clock size={24} /> Attendance Management</h2>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === i ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{t}
            {i === 1 && shiftRequests.filter(s => s.status === 'Pending').length > 0 && <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs rounded-full bg-amber-100 text-amber-800">{shiftRequests.filter(s => s.status === 'Pending').length}</span>}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="w-full rounded border border-slate-300 pl-9 pr-3 py-2 text-sm text-black" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {tab === 0 && <input type="date" className="rounded border border-slate-300 p-2 text-sm text-black" value={filterDate} onChange={e => setFilterDate(e.target.value)} />}
        <select className="rounded border border-slate-300 p-2 text-sm text-black" value={filterEmployee} onChange={e => setFilterEmployee(e.target.value)}>
          <option value="">All Employees</option>
          {employees.filter(e => e.status !== 'Inactive').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        {tab === 0 && (
          <select className="rounded border border-slate-300 p-2 text-sm text-black" value={filterLocation} onChange={e => setFilterLocation(e.target.value)}>
            <option value="">All Locations</option>
            <option value="HQ">HQ</option>
            <option value="Site">Site</option>
            <option value="Remote">Remote</option>
          </select>
        )}
        {tab === 1 && can(role, 'hr_shifts', 'create') && (
          <button onClick={openNewShift} className="rounded bg-indigo-600 px-3 py-2 text-sm text-white font-medium hover:bg-indigo-700 flex items-center gap-1"><Plus size={14} /> New Request</button>
        )}
        {tab === 2 && can(role, 'hr_penalties', 'create') && (
          <button onClick={() => { setPenaltyForm({ employeeId: '', minutes: 0, reason: '' }); setShowPenaltyModal(true); }} className="rounded bg-red-600 px-3 py-2 text-sm text-white font-medium hover:bg-red-700 flex items-center gap-1"><AlertTriangle size={14} /> Add Penalty</button>
        )}
      </div>

      {/* ═══════ TAB 0: ATTENDANCE LOG ═══════ */}
      {tab === 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
                <th className="p-3">Employee</th>
                <th className="p-3">Date</th>
                <th className="p-3">Check In</th>
                <th className="p-3">Check Out</th>
                <th className="p-3 text-right">Hours</th>
                <th className="p-3">Location</th>
                <th className="p-3">Project</th>
                <th className="p-3 text-center">Geo</th>
                <th className="p-3">Flag</th>
                <th className="p-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.slice(0, 200).map(log => {
                const hours = getLogHours(log);
                const isOpen = log.checkIn && !log.checkOut;
                const isSuspicious = log.lateCheckout || log.suspiciousNightCheckout;
                const suspiciousHour = hqSettings.suspiciousCheckoutHour ?? 22;
                return (
                  <tr key={log.id} className={`border-b last:border-0 hover:bg-slate-50 ${isOpen ? 'bg-green-50' : isSuspicious ? 'bg-red-50' : ''}`}>
                    <td className="p-3 font-medium text-slate-800">{getEmpName(log.employeeId)}{log.source === 'SR' && <span title="Recorded from an approved shift request" className="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">SR</span>}</td>
                    <td className="p-3 text-slate-600">{fmtDate(log.checkIn)}</td>
                    <td className="p-3 font-mono text-slate-700">{fmtTime(log.checkIn)}</td>
                    <td className="p-3 font-mono text-slate-700">
                      {log.checkOut ? (
                        <span className="flex items-center gap-1">
                          {fmtTime(log.checkOut)}
                          {log.suspiciousNightCheckout && !log.adminAdjusted && (
                            <span title={`Night checkout after ${suspiciousHour}:00`} className="text-red-500 text-xs">🌙</span>
                          )}
                          {log.adminAdjusted && (
                            <span title={`Corrected by admin: ${log.adminAdjustReason}`} className="text-blue-500 text-xs">✏</span>
                          )}
                        </span>
                      ) : <span className="text-green-600 font-medium text-xs">● Active</span>}
                      {log.autoClosed && <span className="ml-1 text-xs text-amber-600">(auto)</span>}
                    </td>
                    <td className="p-3 text-right font-mono">{hours > 0 ? hours.toFixed(1) : '-'}</td>
                    <td className="p-3">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${log.location === 'HQ' ? 'bg-blue-100 text-blue-700' : log.location === 'Site' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                        <MapPin size={10} /> {log.location || '-'}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-slate-600">{log.project_name || '-'}</td>
                    <td className="p-3 text-center">
                      {log.geofenceVerified === true && <CheckCircle size={16} className="text-green-500 inline" />}
                      {log.geofenceVerified === false && <XCircle size={16} className="text-red-500 inline" />}
                      {log.geoPenaltyMinutes > 0 && <span className="text-xs text-red-500 ml-1">-{log.geoPenaltyMinutes}m</span>}
                    </td>
                    <td className="p-3">
                      {isSuspicious && !log.adminAdjusted && (
                        <div className="flex items-center gap-1">
                          <AlertTriangle size={13} className="text-red-500" />
                          <span className="text-xs text-red-600 font-medium">
                            {log.lateCheckout && log.suspiciousNightCheckout ? 'Late + Night' : log.lateCheckout ? `${log.lateCheckoutHours}h` : 'Night'}
                          </span>
                        </div>
                      )}
                      {log.lateCheckoutReason && (
                        <div className="text-xs text-slate-500 italic truncate max-w-[120px]" title={log.lateCheckoutReason}>"{log.lateCheckoutReason}"</div>
                      )}
                      {log.adminAdjusted && <span className="text-xs text-blue-600">Corrected</span>}
                    </td>
                    <td className="p-3 text-center flex gap-1 justify-center">
                      {isOpen && can(role, 'hr_attendance', 'close_shift') && (
                        <button onClick={() => { setCloseTarget(log); setCloseTime(new Date().toISOString().slice(0, 16)); }} className="text-amber-600 hover:text-amber-800" title="Force close"><XCircle size={16} /></button>
                      )}
                      {!isOpen && isSuspicious && !log.adminAdjusted && can(role, 'hr_attendance', 'close_shift') && (
                        <button onClick={() => { setAdjustTarget(log); setAdjustTime(log.checkOut?.slice(0, 16) || ''); setAdjustReason(''); }} className="text-blue-600 hover:text-blue-800" title="Correct checkout time"><Edit2 size={15} /></button>
                      )}
                      {can(role, 'hr_attendance', 'delete') && (
                        <button onClick={() => handleDeleteLog(log.id)} className="text-red-400 hover:text-red-600" title="Delete"><Trash2 size={14} /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredLogs.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No attendance records found.</p>}
          {filteredLogs.length > 200 && <p className="text-center text-xs text-slate-400 py-2">Showing first 200 of {filteredLogs.length} records.</p>}
        </div>
      )}

      {/* ═══════ TAB 1: SHIFT REQUESTS ═══════ */}
      {tab === 1 && (
        <div className="space-y-3">
          {filteredShifts.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No shift requests.</p>}
          {filteredShifts.map(sr => (
            <div key={sr.id} className={`rounded-xl border p-4 shadow-sm ${HR_STATUS_COLORS[sr.status] || 'bg-white'}`}>
              <div className="flex flex-col sm:flex-row justify-between gap-2">
                <div>
                  <div className="font-medium text-slate-800">{getEmpName(sr.employeeId)}</div>
                  <div className="text-xs text-slate-600 mt-1">
                    <span className="font-mono">{fmtDateTime(sr.startTime)}</span> → <span className="font-mono">{fmtDateTime(sr.endTime)}</span>
                    <span className="ml-2 text-slate-500">@ {sr.location}</span>
                  </div>
                  <div className="text-sm text-slate-700 mt-1">{sr.reason}</div>
                  {sr.adminClarification && <div className="text-xs text-purple-700 mt-1 italic">Admin: {sr.adminClarification}</div>}
                  {sr.clarificationResponse && <div className="text-xs text-indigo-700 mt-1 italic">Response: {sr.clarificationResponse}</div>}
                </div>
                <div className="flex items-start gap-2 shrink-0">
                  <span className={`text-xs font-semibold px-2 py-1 rounded ${sr.status === 'Approved' ? 'bg-green-200 text-green-800' : sr.status === 'Rejected' ? 'bg-red-200 text-red-800' : sr.status === 'Clarification' ? 'bg-purple-200 text-purple-800' : 'bg-amber-200 text-amber-800'}`}>{sr.status}</span>
                  {sr.status === 'Pending' && can(role, 'hr_shifts', 'approve') && (
                    <>
                      <button onClick={() => handleShiftAction(sr, 'Approved')} className="text-green-600 hover:text-green-800" title="Approve"><CheckCircle size={18} /></button>
                      <button onClick={() => handleShiftAction(sr, 'Rejected')} className="text-red-600 hover:text-red-800" title="Reject"><XCircle size={18} /></button>
                      <button onClick={async () => { const c = await promptDialog('Enter clarification message:'); if (c) handleShiftAction(sr, 'Clarification', c); }} className="text-purple-600 hover:text-purple-800" title="Ask Clarification"><MessageSquare size={18} /></button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══════ TAB 2: PENALTIES ═══════ */}
      {tab === 2 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
                <th className="p-3">Employee</th>
                <th className="p-3">Date</th>
                <th className="p-3 text-right">Minutes</th>
                <th className="p-3">Reason</th>
                <th className="p-3">Applied By</th>
                <th className="p-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPenalties.map(p => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium text-slate-800">{getEmpName(p.employeeId)}</td>
                  <td className="p-3 text-slate-600">{fmtDate(p.appliedAt)}</td>
                  <td className="p-3 text-right font-mono text-red-600 font-bold">{p.minutes}</td>
                  <td className="p-3 text-slate-700">{p.reason}</td>
                  <td className="p-3 text-slate-500 text-xs">{getEmpName(p.appliedBy)}</td>
                  <td className="p-3 text-center">
                    {can(role, 'hr_penalties', 'create') && (
                      <button onClick={() => handleDeletePenalty(p.id)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredPenalties.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No penalties recorded.</p>}
        </div>
      )}

      {/* ═══════ MODALS ═══════ */}

      {/* Force Close Shift Modal */}
      {closeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90dvh] overflow-y-auto">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Force Close Shift</h3>
            <p className="text-sm text-slate-600 mb-3">Employee: <strong>{getEmpName(closeTarget.employeeId)}</strong><br />Checked in: {fmtDateTime(closeTarget.checkIn)}</p>
            <label className="text-xs font-bold text-slate-700">Close Time</label>
            <input type="datetime-local" className="w-full rounded border border-slate-300 p-2 text-sm text-black mb-4" value={closeTime} onChange={e => setCloseTime(e.target.value)} />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setCloseTarget(null)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleCloseShift} className="rounded bg-amber-600 px-4 py-2 text-sm text-white font-medium hover:bg-amber-700">Close Shift</button>
            </div>
          </div>
        </div>
      )}

      {/* Shift Request Modal */}
      {showShiftModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90dvh] overflow-y-auto">
            <h3 className="text-lg font-bold text-slate-800 mb-4">{editShift ? 'Edit' : 'New'} Shift Request</h3>
            <div className="space-y-3">
              {can(role, 'hr_shifts', 'view') && (
                <div>
                  <label className="text-xs font-bold text-slate-700">Employee</label>
                  <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={shiftForm.employeeId} onChange={e => setShiftForm({ ...shiftForm, employeeId: e.target.value })}>
                    <option value="">Select Employee</option>
                    {employees.filter(e => e.status !== 'Inactive').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700">Start Time</label>
                  <input type="datetime-local" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={shiftForm.startTime} onChange={e => setShiftForm({ ...shiftForm, startTime: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700">End Time</label>
                  <input type="datetime-local" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={shiftForm.endTime} onChange={e => setShiftForm({ ...shiftForm, endTime: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Location</label>
                <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={shiftForm.location} onChange={e => setShiftForm({ ...shiftForm, location: e.target.value })}>
                  <option value="HQ">HQ</option>
                  <option value="Site">Site</option>
                  <option value="Remote">Remote</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Reason</label>
                <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={3} value={shiftForm.reason} onChange={e => setShiftForm({ ...shiftForm, reason: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowShiftModal(false)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSaveShift} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Penalty Modal */}
      {showPenaltyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90dvh] overflow-y-auto">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Add Penalty</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-700">Employee</label>
                <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={penaltyForm.employeeId} onChange={e => setPenaltyForm({ ...penaltyForm, employeeId: e.target.value })}>
                  <option value="">Select Employee</option>
                  {employees.filter(e => e.status !== 'Inactive').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Penalty Minutes</label>
                <input type="number" min="0" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={penaltyForm.minutes} onChange={e => setPenaltyForm({ ...penaltyForm, minutes: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Reason</label>
                <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={3} value={penaltyForm.reason} onChange={e => setPenaltyForm({ ...penaltyForm, reason: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowPenaltyModal(false)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleAddPenalty} className="rounded bg-red-600 px-4 py-2 text-sm text-white font-medium hover:bg-red-700">Apply Penalty</button>
            </div>
          </div>
        </div>
      )}
      {/* Adjust Checkout Modal — Admin correction of suspicious late checkouts */}
      {adjustTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl max-h-[90dvh] overflow-y-auto space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-red-100 shrink-0"><AlertTriangle size={20} className="text-red-600" /></div>
              <div>
                <h3 className="text-lg font-bold text-slate-800">Correct Checkout Time</h3>
                <p className="text-sm text-slate-600 mt-0.5">
                  Employee: <strong>{getEmpName(adjustTarget.employeeId)}</strong><br />
                  Original checkout: <strong>{fmtDateTime(adjustTarget.checkOut)}</strong> ({getLogHours(adjustTarget).toFixed(1)}h)<br />
                  {adjustTarget.lateCheckoutReason && <span className="italic text-slate-500">Staff reason: "{adjustTarget.lateCheckoutReason}"</span>}
                </p>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Corrected Checkout Time</label>
              <input type="datetime-local" className="w-full rounded border border-slate-300 p-2 text-sm text-black mt-1"
                value={adjustTime} onChange={e => setAdjustTime(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Admin Reason for Correction</label>
              <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black mt-1 resize-none" rows={3}
                placeholder="e.g. Show ended at 1 PM, employee checked out at 11 PM. Corrected to 2 PM."
                value={adjustReason} onChange={e => setAdjustReason(e.target.value)} />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setAdjustTarget(null)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleAdjustCheckout} className="rounded bg-blue-600 px-4 py-2 text-sm text-white font-medium hover:bg-blue-700">Save Correction</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HRAttendance;
