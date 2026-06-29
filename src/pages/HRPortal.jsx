import React, { useState, useMemo, useCallback } from 'react';
import { promptDialog } from '../utils/dialog';
import { UserCheck, Clock, MapPin, CalendarDays, FileText, AlertTriangle, CheckCircle } from 'lucide-react';
import { addDoc, updateDoc, doc, collection } from 'firebase/firestore';
import { getLogHours, getDistance, calculateLeaveBalance, getHourlyRateForDate, splitLeavePaidUnpaid, dailyLeaveRate, formatCurrency } from '../utils/helpers';
import { LEAVE_TYPES, LEAVE_ENTITLEMENTS, LEAVE_PAID_TYPES, LEAVE_DAY_HOURS, LOCATION_TYPES } from '../utils/constants';

const HRPortal = ({ employees = [], timeLogs = [], hrLeaves = [], shiftRequests = [], penalties = [], hqSettings = {}, projects = [], role = '', currentEmpId, db, appId, logAction, addToast }) => {
  const [tab, setTab] = useState(0);
  const [checkInLocation, setCheckInLocation] = useState('HQ');
  const [checkInProject, setCheckInProject] = useState('');
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState('');

  // Leave form
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveForm, setLeaveForm] = useState({ type: 'Casual', startDate: '', endDate: '', reason: '' });

  // Shift request form
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [shiftForm, setShiftForm] = useState({ startTime: '', endTime: '', location: 'HQ', reason: '' });

  const currentEmp = useMemo(() => employees.find(e => e.id === currentEmpId), [employees, currentEmpId]);
  const activeProjects = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = (d) => (d ? String(d).slice(0, 10) : '');
    const addDays = (k, n) => {
      const d = new Date(k); d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    };
    return projects.filter(p => {
      if (!['Confirmed', 'Ongoing'].includes(p.status)) return false;
      // Coordinators (user role) can select any active project for site check-in
      if (role !== 'user' && !(p.assigned_employees || []).includes(currentEmpId)) return false;
      // Window spans from setup_date (if any) or start_date through end_date,
      // with a 1-day grace on either side for travel/teardown days.
      const startKey = dayKey(p.setup_date || p.start_date);
      const endKey = dayKey(p.end_date || p.start_date);
      if (!startKey || !endKey) return true;
      return addDays(startKey, -1) <= today && today <= addDays(endKey, 1);
    });
  }, [projects, currentEmpId, role]);

  // My time logs
  const myLogs = useMemo(() => timeLogs.filter(l => l.employeeId === currentEmpId).sort((a, b) => new Date(b.checkIn || 0) - new Date(a.checkIn || 0)), [timeLogs, currentEmpId]);
  const activeShift = useMemo(() => myLogs.find(l => l.checkIn && !l.checkOut), [myLogs]);

  // My leaves
  const myLeaves = useMemo(() => hrLeaves.filter(l => l.employeeId === currentEmpId).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)), [hrLeaves, currentEmpId]);
  const leaveBalance = useMemo(() => calculateLeaveBalance(myLeaves, LEAVE_ENTITLEMENTS), [myLeaves]);

  // My shift requests
  const myShifts = useMemo(() => shiftRequests.filter(s => s.employeeId === currentEmpId).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)), [shiftRequests, currentEmpId]);

  // My penalties
  const myPenalties = useMemo(() => penalties.filter(p => p.employeeId === currentEmpId).sort((a, b) => new Date(b.appliedAt || 0) - new Date(a.appliedAt || 0)), [penalties, currentEmpId]);

  // Month stats
  const monthStats = useMemo(() => {
    const now = new Date();
    const monthLogs = myLogs.filter(l => {
      const d = new Date(l.checkIn);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    const totalHours = monthLogs.reduce((s, l) => s + getLogHours(l), 0);
    return { shifts: monthLogs.length, hours: Math.round(totalHours * 10) / 10 };
  }, [myLogs]);

  const getGPS = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  // ── CHECK IN ──────────────────────────────────────────────────────────────
  const handleCheckIn = useCallback(async () => {
    if (activeShift) return addToast('You already have an active shift. Check out first.', 'error');
    if (checkInLocation === 'Site' && !checkInProject) return addToast('Please select a project for site attendance.', 'error');

    setGpsLoading(true);
    setGpsError('');
    try {
      let gps = null;
      try { gps = await getGPS(); } catch (gpsErr) {
        addToast('GPS unavailable — check-in recorded without location.', 'warning');
      }
      const now = new Date().toISOString();

      let geofenceVerified = gps !== null;
      let geoPenaltyMinutes = 0;

      // HQ geofence check
      if (gps && checkInLocation === 'HQ' && hqSettings.lat && hqSettings.lng) {
        const dist = getDistance(gps.lat, gps.lng, hqSettings.lat, hqSettings.lng);
        if (dist > (hqSettings.geoRadiusMeters || 400)) {
          if (hqSettings.strictMode) {
            setGpsLoading(false);
            return addToast(`You are ${Math.round(dist)}m from HQ. Check-in blocked (strict mode).`, 'error');
          }
          geofenceVerified = false;
          geoPenaltyMinutes = hqSettings.geoPenaltyMinutes || 0;
        }
      }

      // Time window check
      if (hqSettings.enforceTime && checkInLocation === 'HQ') {
        const hm = now.slice(11, 16);
        const grace = hqSettings.graceMinutes || 0;
        const winStart = hqSettings.windowStart || '08:00';
        const winEnd = hqSettings.windowEnd || '11:00';
        // Simple HH:MM comparison; grace applied to start
        const adjustedStart = subtractMinutes(winStart, grace);
        if (hm < adjustedStart || hm > winEnd) {
          addToast(`Check-in outside time window (${winStart}–${winEnd}). Proceeding with penalty.`, 'warning');
          geoPenaltyMinutes += hqSettings.geoPenaltyMinutes || 0;
        }
      }

      const selectedProj = checkInProject ? activeProjects.find(p => p.id === checkInProject) : null;

      const logData = {
        employeeId: currentEmpId,
        checkIn: now,
        checkOut: null,
        location: checkInLocation,
        project_id: checkInLocation === 'Site' ? checkInProject : null,
        project_name: checkInLocation === 'Site' ? (selectedProj?.project_name || '') : null,
        geofenceVerified,
        geoPenaltyMinutes,
        autoClosed: false,
        autoCloseAcknowledged: false,
        lateMinutes: 0,
        gpsCheckIn: gps,
        gpsCheckOut: null,
        created_at: now,
      };

      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'timeLogs'), logData);
      logAction('timeLogs', 'check_in', ref.id, logData, `Checked in at ${checkInLocation}`);
      addToast(`Checked in at ${checkInLocation}${selectedProj ? ` — ${selectedProj.project_name}` : ''}`, 'success');
    } catch (e) {
      console.error(e);
      setGpsError(e.message || 'GPS error');
      addToast('Failed to get GPS location. Please enable location access.', 'error');
    }
    setGpsLoading(false);
  }, [activeShift, checkInLocation, checkInProject, hqSettings, currentEmpId, activeProjects, db, appId, logAction, addToast]);

  // ── CHECK OUT ─────────────────────────────────────────────────────────────
  const handleCheckOut = useCallback(async () => {
    if (!activeShift) return addToast('No active shift to close.', 'error');
    setGpsLoading(true);
    setGpsError('');
    try {
      let gps = null;
      try { gps = await getGPS(); } catch (gpsErr) {
        addToast('GPS unavailable — check-out recorded without location.', 'warning');
      }
      const now = new Date().toISOString();
      const ref = doc(db, 'artifacts', appId, 'public', 'data', 'timeLogs', activeShift.id);
      await updateDoc(ref, { checkOut: now, gpsCheckOut: gps });
      logAction('timeLogs', 'check_out', activeShift.id, { checkOut: now, gpsCheckOut: gps }, 'Checked out');
      addToast('Checked out successfully', 'success');
    } catch (e) {
      console.error(e);
      setGpsError(e.message || 'GPS error');
      addToast('Failed to get GPS location.', 'error');
    }
    setGpsLoading(false);
  }, [activeShift, db, appId, logAction, addToast]);

  // ── LEAVE APPLICATION ─────────────────────────────────────────────────────
  const handleLeaveSubmit = async () => {
    const { type, startDate, endDate, reason } = leaveForm;
    if (!type || !startDate || !endDate || !reason) return addToast('All fields required', 'error');
    if (new Date(endDate) < new Date(startDate)) return addToast('End date must be after start date', 'error');
    try {
      const data = { employeeId: currentEmpId, type, startDate, endDate, reason, status: 'Pending', created_at: new Date().toISOString() };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'leaves'), data);
      logAction('leaves', 'create', ref.id, data, 'Leave applied from portal');
      addToast('Leave request submitted', 'success');
      setShowLeaveModal(false);
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // ── SHIFT REQUEST ─────────────────────────────────────────────────────────
  const handleShiftSubmit = async () => {
    const { startTime, endTime, location, reason } = shiftForm;
    if (!startTime || !endTime || !reason) return addToast('All fields required', 'error');
    try {
      const data = { employeeId: currentEmpId, startTime, endTime, location, reason, status: 'Pending', created_at: new Date().toISOString() };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'shiftRequests'), data);
      logAction('shiftRequests', 'create', ref.id, data, 'Shift request from portal');
      addToast('Shift request submitted', 'success');
      setShowShiftModal(false);
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // ── CLARIFICATION RESPONSE ────────────────────────────────────────────────
  const handleClarificationResponse = async (sr) => {
    const response = await promptDialog('Enter your clarification response:');
    if (!response) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'shiftRequests', sr.id), { clarificationResponse: response, status: 'Pending' });
      logAction('shiftRequests', 'clarification_response', sr.id, { clarificationResponse: response }, 'Responded to clarification');
      addToast('Response submitted', 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '-';
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-';
  const getDays = (s, e) => !s || !e ? 0 : Math.max(1, Math.ceil((new Date(e) - new Date(s)) / 86400000) + 1);

  // Live financial impact of the leave currently being filled in.
  const leaveImpact = (() => {
    const { type, startDate, endDate } = leaveForm;
    if (!startDate || !endDate) return null;
    const days = getDays(startDate, endDate);
    if (!days) return null;
    const isPaid = LEAVE_PAID_TYPES.includes(type);
    const bal = Number(leaveBalance[type] || 0);
    const { paid, lwp } = splitLeavePaidUnpaid(days, bal, isPaid);
    const rate = Number(getHourlyRateForDate(currentEmp, startDate) || currentEmp?.hourlyRate || 0);
    const perDay = dailyLeaveRate(rate, LEAVE_DAY_HOURS);
    return { days, isPaid, bal, paid, lwp, perDay, loss: Math.round(lwp * perDay), rate };
  })();

  const TABS = ['My Attendance', 'My Leaves', 'My Shift Requests', 'My Penalties'];

  return (
    <div className="space-y-4">
      {/* ═══════ ALWAYS VISIBLE: CHECK IN / OUT ═══════ */}
      <div className="max-w-lg mx-auto space-y-4">
        {/* Active shift banner */}
        {activeShift ? (
          <div className="rounded-xl border-2 border-green-400 bg-green-50 p-5 text-center">
            <div className="flex items-center justify-center gap-2 text-green-700 font-bold text-lg">
              <Clock size={20} className="animate-pulse" /> Active Shift
            </div>
            <p className="text-sm text-green-600 mt-1">
              Since {fmtTime(activeShift.checkIn)} @ {activeShift.location}
              {activeShift.project_name && <span className="font-medium"> — {activeShift.project_name}</span>}
            </p>
            <p className="text-xs text-slate-500 mt-1">{fmtDate(activeShift.checkIn)}</p>
            <button
              onClick={handleCheckOut}
              disabled={gpsLoading}
              className="mt-4 rounded-xl bg-red-600 px-8 py-3 text-white text-lg font-bold hover:bg-red-700 disabled:opacity-50 shadow-lg"
            >
              {gpsLoading ? 'Getting GPS...' : '🔴 CHECK OUT'}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-slate-800 text-center">Check In</h3>

            {/* Location selector */}
            <div>
              <label className="text-xs font-bold text-slate-700 mb-1 block">Location</label>
              <div className="grid grid-cols-3 gap-2">
                {LOCATION_TYPES.map(loc => (
                  <button
                    key={loc}
                    onClick={() => { setCheckInLocation(loc); if (loc !== 'Site') setCheckInProject(''); }}
                    className={`rounded-lg p-3 text-center border-2 transition-all ${checkInLocation === loc ? 'border-indigo-600 bg-indigo-50 text-indigo-700 font-bold' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                  >
                    <MapPin size={20} className="mx-auto mb-1" />
                    <span className="text-sm">{loc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Project selector (Site only) */}
            {checkInLocation === 'Site' && (
              <div>
                <label className="text-xs font-bold text-slate-700 mb-1 block">Select Project *</label>
                <select
                  className="w-full rounded border border-slate-300 p-2.5 text-sm text-black"
                  value={checkInProject}
                  onChange={e => setCheckInProject(e.target.value)}
                >
                  <option value="">— Choose Project —</option>
                  {activeProjects.map(p => (
                    <option key={p.id} value={p.id}>{p.project_name}{p.client_name ? ` (${p.client_name})` : ''}</option>
                  ))}
                </select>
                {activeProjects.length === 0 && <p className="text-xs text-amber-600 mt-1">No projects assigned to you for today.</p>}
              </div>
            )}

            <button
              onClick={handleCheckIn}
              disabled={gpsLoading}
              className="w-full rounded-xl bg-green-600 px-8 py-3 text-white text-lg font-bold hover:bg-green-700 disabled:opacity-50 shadow-lg"
            >
              {gpsLoading ? 'Getting GPS...' : '🟢 CHECK IN'}
            </button>

            {gpsError && <p className="text-xs text-red-600 text-center">{gpsError}</p>}
            <p className="text-xs text-slate-400 text-center">GPS coordinates will be recorded automatically.</p>
          </div>
        )}
      </div>

      {/* Header + Stats */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><UserCheck size={24} /> My HR Portal</h2>
          {currentEmp && <p className="text-sm text-slate-500 mt-0.5">Welcome, {currentEmp.name}</p>}
        </div>
        <div className="flex gap-3 text-center">
          <div className="rounded-lg bg-indigo-50 px-4 py-2">
            <p className="text-xl font-bold text-indigo-600">{monthStats.shifts}</p>
            <p className="text-xs text-slate-500">Shifts (Month)</p>
          </div>
          <div className="rounded-lg bg-blue-50 px-4 py-2">
            <p className="text-xl font-bold text-blue-600">{monthStats.hours}</p>
            <p className="text-xs text-slate-500">Hours (Month)</p>
          </div>
        </div>
      </div>

      {/* Tabs (no Check In/Out tab — it's always above) */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} className={`px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === i ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{t}</button>
        ))}
      </div>

      {/* ═══════ TAB 0: MY ATTENDANCE ═══════ */}
      {tab === 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Date</th><th className="p-3">Check In</th><th className="p-3">Check Out</th><th className="p-3 text-right">Hours</th><th className="p-3">Location</th><th className="p-3">Project</th><th className="p-3 text-center">Geo</th>
            </tr></thead>
            <tbody>
              {myLogs.slice(0, 100).map(l => (
                <tr key={l.id} className={`border-b last:border-0 hover:bg-slate-50 ${!l.checkOut ? 'bg-green-50' : ''}`}>
                  <td className="p-3">{fmtDate(l.checkIn)}</td>
                  <td className="p-3 font-mono">{fmtTime(l.checkIn)}</td>
                  <td className="p-3 font-mono">{l.checkOut ? fmtTime(l.checkOut) : <span className="text-green-600 font-medium">Active</span>}{l.autoClosed && <span className="text-xs text-amber-600 ml-1">(auto)</span>}</td>
                  <td className="p-3 text-right font-mono">{getLogHours(l) > 0 ? getLogHours(l).toFixed(1) : '-'}</td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${l.location === 'HQ' ? 'bg-blue-100 text-blue-700' : l.location === 'Site' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{l.location}</span>
                  </td>
                  <td className="p-3 text-xs">{l.project_name || '-'}</td>
                  <td className="p-3 text-center">
                    {l.geofenceVerified === true && <CheckCircle size={14} className="text-green-500 inline" />}
                    {l.geofenceVerified === false && <span className="text-red-500 text-xs">Outside{l.geoPenaltyMinutes > 0 ? ` -${l.geoPenaltyMinutes}m` : ''}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {myLogs.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No attendance records yet.</p>}
        </div>
      )}

      {/* ═══════ TAB 1: MY LEAVES ═══════ */}
      {tab === 1 && (
        <div className="space-y-4">
          {/* Balance cards */}
          <div className="grid grid-cols-3 gap-3">
            {LEAVE_TYPES.map(t => (
              <div key={t} className="rounded-xl border bg-white p-4 text-center shadow-sm">
                <p className="text-xs text-slate-500 uppercase">{t}</p>
                <p className={`text-2xl font-bold ${leaveBalance[t] > 0 ? 'text-green-600' : 'text-red-600'}`}>{leaveBalance[t]}</p>
                <p className="text-xs text-slate-400">of {LEAVE_ENTITLEMENTS[t]}</p>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <button onClick={() => { setLeaveForm({ type: 'Casual', startDate: '', endDate: '', reason: '' }); setShowLeaveModal(true); }} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700">Apply Leave</button>
          </div>

          {/* Leave history */}
          <div className="space-y-2">
            {myLeaves.length === 0 && <p className="text-center text-sm text-slate-400 py-6">No leave records.</p>}
            {myLeaves.map(l => (
              <div key={l.id} className={`rounded-lg border p-3 ${l.status === 'Approved' ? 'bg-green-50 border-green-200' : l.status === 'Rejected' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded mr-2 ${l.type === 'Casual' ? 'bg-blue-100 text-blue-700' : l.type === 'Sick' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{l.type}</span>
                    <span className="text-sm text-slate-700">{fmtDate(l.startDate)} — {fmtDate(l.endDate)} ({getDays(l.startDate, l.endDate)}d)</span>
                  </div>
                  <span className={`text-xs font-bold ${l.status === 'Approved' ? 'text-green-700' : l.status === 'Rejected' ? 'text-red-700' : 'text-amber-700'}`}>{l.status}</span>
                </div>
                <p className="text-xs text-slate-600 mt-1">{l.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══════ TAB 2: MY SHIFT REQUESTS ═══════ */}
      {tab === 2 && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => { setShiftForm({ startTime: '', endTime: '', location: 'HQ', reason: '' }); setShowShiftModal(true); }} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700">New Shift Request</button>
          </div>
          {myShifts.length === 0 && <p className="text-center text-sm text-slate-400 py-6">No shift requests.</p>}
          {myShifts.map(sr => (
            <div key={sr.id} className={`rounded-lg border p-3 ${sr.status === 'Approved' ? 'bg-green-50 border-green-200' : sr.status === 'Rejected' ? 'bg-red-50 border-red-200' : sr.status === 'Clarification' ? 'bg-purple-50 border-purple-200' : 'bg-amber-50 border-amber-200'}`}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-sm text-slate-700">
                    <span className="font-mono">{fmtDate(sr.startTime)} {fmtTime(sr.startTime)}</span> → <span className="font-mono">{fmtDate(sr.endTime)} {fmtTime(sr.endTime)}</span>
                    <span className="ml-2 text-slate-500">@ {sr.location}</span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">{sr.reason}</p>
                  {sr.adminClarification && (
                    <div className="mt-2 p-2 rounded bg-purple-100 border border-purple-200">
                      <p className="text-xs text-purple-700 font-medium">Admin asks: {sr.adminClarification}</p>
                      {sr.clarificationResponse ? (
                        <p className="text-xs text-indigo-700 mt-1">Your response: {sr.clarificationResponse}</p>
                      ) : (
                        <button onClick={() => handleClarificationResponse(sr)} className="mt-1 text-xs text-purple-600 underline hover:text-purple-800">Respond</button>
                      )}
                    </div>
                  )}
                </div>
                <span className={`text-xs font-bold shrink-0 ${sr.status === 'Approved' ? 'text-green-700' : sr.status === 'Rejected' ? 'text-red-700' : sr.status === 'Clarification' ? 'text-purple-700' : 'text-amber-700'}`}>{sr.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══════ TAB 3: MY PENALTIES ═══════ */}
      {tab === 3 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Date</th><th className="p-3 text-right">Minutes</th><th className="p-3">Reason</th>
            </tr></thead>
            <tbody>
              {myPenalties.map(p => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3">{fmtDate(p.appliedAt)}</td>
                  <td className="p-3 text-right font-mono text-red-600 font-bold">{p.minutes}</td>
                  <td className="p-3 text-slate-700">{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {myPenalties.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No penalties. 🎉</p>}
          {myPenalties.length > 0 && (
            <div className="p-3 border-t bg-slate-50 text-right">
              <span className="text-sm text-slate-600">Total: </span>
              <span className="font-bold text-red-600">{myPenalties.reduce((s, p) => s + (p.minutes || 0), 0)} minutes</span>
            </div>
          )}
        </div>
      )}

      {/* ═══════ MODALS ═══════ */}

      {/* Leave Modal */}
      {showLeaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Apply for Leave</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-700">Leave Type</label>
                <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={leaveForm.type} onChange={e => setLeaveForm({ ...leaveForm, type: e.target.value })}>
                  {LEAVE_TYPES.map(t => <option key={t} value={t}>{t} (Balance: {leaveBalance[t]})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700">Start Date</label>
                  <input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={leaveForm.startDate} onChange={e => setLeaveForm({ ...leaveForm, startDate: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700">End Date</label>
                  <input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={leaveForm.endDate} onChange={e => setLeaveForm({ ...leaveForm, endDate: e.target.value })} />
                </div>
              </div>
              {leaveImpact && (
                <div className={`rounded-lg border p-3 text-xs ${leaveImpact.lwp > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                  <div className="mb-1 flex items-center gap-1.5 font-bold text-slate-700">
                    {leaveImpact.lwp > 0 ? <AlertTriangle size={13} className="text-amber-600" /> : <CheckCircle size={13} className="text-emerald-600" />}
                    Financial impact
                  </div>
                  <div className="space-y-0.5 text-slate-600">
                    <div>{leaveImpact.days} day(s) of {leaveForm.type} leave</div>
                    {leaveImpact.isPaid && <div>Paid from balance: <span className="font-semibold">{leaveImpact.paid}</span> day(s) — {leaveImpact.bal} left in your {leaveForm.type} quota</div>}
                    {leaveImpact.lwp > 0 && <div className="text-amber-700">Beyond balance → Loss of Pay: <span className="font-semibold">{leaveImpact.lwp}</span> day(s){leaveImpact.perDay > 0 ? <> × {formatCurrency(leaveImpact.perDay)}/day</> : null}</div>}
                    <div className="pt-1 font-bold">
                      {leaveImpact.lwp > 0
                        ? (leaveImpact.perDay > 0
                            ? <span className="text-amber-700">≈ {formatCurrency(leaveImpact.loss)} less in your pay</span>
                            : <span className="text-amber-700">{leaveImpact.lwp} unpaid day(s) — set your hourly rate to see the amount</span>)
                        : <span className="text-emerald-700">No salary impact — fully covered by your paid balance ✓</span>}
                    </div>
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-slate-700">Reason</label>
                <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={3} value={leaveForm.reason} onChange={e => setLeaveForm({ ...leaveForm, reason: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowLeaveModal(false)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleLeaveSubmit} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700">Submit</button>
            </div>
          </div>
        </div>
      )}

      {/* Shift Request Modal */}
      {showShiftModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-bold text-slate-800 mb-4">New Shift Request</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
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
                  {LOCATION_TYPES.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-700">Reason</label>
                <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={3} value={shiftForm.reason} onChange={e => setShiftForm({ ...shiftForm, reason: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowShiftModal(false)} className="rounded border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleShiftSubmit} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700">Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Helper: subtract minutes from HH:MM string
function subtractMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m - mins;
  const nh = Math.floor(Math.max(0, total) / 60);
  const nm = Math.max(0, total) % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

export default HRPortal;
