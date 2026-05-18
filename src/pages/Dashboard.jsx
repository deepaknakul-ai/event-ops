// c:\APP\temp\rental-ops\src\pages\Dashboard.jsx
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend
} from 'recharts';
import { AlertTriangle, AlertCircle, Briefcase, ChevronRight, Truck, CalendarDays, TrendingUp, Clock, FileText, DollarSign, MapPin, Shield } from 'lucide-react';
import { doc, getDoc, addDoc, updateDoc, collection } from 'firebase/firestore';
import { STATUS_COLORS, LOCATION_TYPES } from '../utils/constants';
import { formatCurrency, getProjectGrandTotal, getProjectNetTotal, getProjectGST, getLogHours, getDistance, fmtDate, getFinancialYear, getFYFromDate } from '../utils/helpers';
import { can } from '../utils/permissions';

const DEFAULT_STATUS_BG = {
  Quoted: '#ffedd5',
  Confirmed: '#dcfce7',
  Cancelled: '#f3f4f6',
  Ongoing: '#fee2e2',
  Completed: '#dbeafe',
  Closed: '#003366'
};

const DEFAULT_INVOICE_TEXT = {
  Invoiced: '',
  'Not Invoiced': ''
};

const Dashboard = ({ projects, expenses, role, clients, onProjectClick, employees = [], payments = [], db, appId, timeLogs = [], hqSettings = {}, currentEmpId, logAction, addToast, payouts = [], vendorPayments = [], taxInvoices = [], purchaseInvoices = [], inventory = [], journalEntries = [], hrLeaves = [], currentUserId }) => {
  const navigate = useNavigate();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [checkInLocation, setCheckInLocation] = useState('HQ');
  const [checkInProject, setCheckInProject] = useState('');
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [lateCheckoutModal, setLateCheckoutModal] = useState(false);
  const [lateCheckoutReason, setLateCheckoutReason] = useState('');
  const [pendingCheckoutPayload, setPendingCheckoutPayload] = useState(null);
  const [calendarColors, setCalendarColors] = useState({
    statusColors: { ...DEFAULT_STATUS_BG },
    invoiceTextColors: { ...DEFAULT_INVOICE_TEXT }
  });
  const [selectedFY, setSelectedFY] = useState(getFinancialYear());

  // Build list of available FYs from all completed/closed projects
  const availableFYs = useMemo(() => {
    const fySet = new Set();
    fySet.add(getFinancialYear());
    projects.forEach(p => {
      if (['Completed', 'Closed'].includes(p.status) && p.end_date) {
        fySet.add(getFYFromDate(p.end_date));
      }
    });
    return [...fySet].sort().reverse();
  }, [projects]);

  const activeProjects = projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).length;
  const pendingQuotes = projects.filter(p => p.status === 'Quoted').length;
  const revenue = projects.filter(p => (p.status === 'Completed' || p.status === 'Closed') && getFYFromDate(p.end_date) === selectedFY).reduce((sum, p) => sum + getProjectGrandTotal(p), 0);
  
  const overdueProjects = projects.filter(p => {
    const end = new Date(p.end_date); end.setHours(23,59,59);
    return p.status === 'Ongoing' && end < new Date();
  }).length;

  const lockedEmployees = employees.filter(e => e.is_locked);

  // ── Attendance check-in/out state ─────────────────────────────────────────
  const myLogs = useMemo(() => currentEmpId ? timeLogs.filter(l => l.employeeId === currentEmpId).sort((a, b) => new Date(b.checkIn || 0) - new Date(a.checkIn || 0)) : [], [timeLogs, currentEmpId]);
  const activeShift = useMemo(() => myLogs.find(l => l.checkIn && !l.checkOut), [myLogs]);
  const myActiveProjects = useMemo(() => {
    if (!currentEmpId) return [];
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = (d) => (d ? String(d).slice(0, 10) : '');
    return projects.filter(p => {
      if (!['Confirmed', 'Ongoing'].includes(p.status)) return false;
      // Coordinators (user role) can check in at any active project site
      if (role !== 'user' && !(p.assigned_employees || []).includes(currentEmpId)) return false;
      // Window spans from setup_date (if any) or start_date through end_date.
      // Allow a 1-day grace on either side so staff can check in on travel/teardown days.
      const startKey = dayKey(p.setup_date || p.start_date);
      const endKey = dayKey(p.end_date || p.start_date);
      if (!startKey || !endKey) return true; // undated project — don't exclude
      const addDays = (k, n) => {
        const d = new Date(k); d.setDate(d.getDate() + n);
        return d.toISOString().slice(0, 10);
      };
      return addDays(startKey, -1) <= today && today <= addDays(endKey, 1);
    });
  }, [projects, currentEmpId, role]);

  const getGPS = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  const subtractMinutes = (timeStr, mins) => {
    const [h, m] = timeStr.split(':').map(Number);
    const total = h * 60 + m - mins;
    const nh = Math.floor(((total % 1440) + 1440) % 1440 / 60);
    const nm = ((total % 1440) + 1440) % 1440 % 60;
    return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
  };

  const handleDashCheckIn = useCallback(async () => {
    if (!currentEmpId) return addToast?.('No employee linked to your account', 'error');
    if (activeShift) return addToast?.('You already have an active shift. Check out first.', 'error');
    if (checkInLocation === 'Site' && !checkInProject) return addToast?.('Please select a project for site attendance.', 'error');
    setGpsLoading(true); setGpsError('');
    try {
      let gps = null;
      try { gps = await getGPS(); } catch (gpsErr) {
        addToast?.('GPS unavailable — check-in recorded without location.', 'warning');
      }
      const now = new Date().toISOString();
      let geofenceVerified = gps !== null, geoPenaltyMinutes = 0;
      if (gps && checkInLocation === 'HQ' && hqSettings.lat && hqSettings.lng) {
        const dist = getDistance(gps.lat, gps.lng, hqSettings.lat, hqSettings.lng);
        if (dist > (hqSettings.geoRadiusMeters || 400)) {
          if (hqSettings.strictMode) { setGpsLoading(false); return addToast?.(`You are ${Math.round(dist)}m from HQ. Check-in blocked.`, 'error'); }
          geofenceVerified = false; geoPenaltyMinutes = hqSettings.geoPenaltyMinutes || 0;
        }
      }
      if (hqSettings.enforceTime && checkInLocation === 'HQ') {
        const hm = now.slice(11, 16);
        const winStart = hqSettings.windowStart || '08:00', winEnd = hqSettings.windowEnd || '11:00';
        const adjustedStart = subtractMinutes(winStart, hqSettings.graceMinutes || 0);
        if (hm < adjustedStart || hm > winEnd) { setGpsLoading(false); return addToast?.(`Check-in allowed only between ${winStart} and ${winEnd}.`, 'error'); }
      }
      const selectedProj = checkInProject ? myActiveProjects.find(p => p.id === checkInProject) : null;
      const logData = {
        employeeId: currentEmpId, checkIn: now, checkOut: null, location: checkInLocation,
        project_id: checkInLocation === 'Site' ? checkInProject : null,
        project_name: checkInLocation === 'Site' ? (selectedProj?.project_name || '') : null,
        geofenceVerified, geoPenaltyMinutes, autoClosed: false,
        lateMinutes: 0, gpsCheckIn: gps, gpsCheckOut: null, created_at: now,
      };
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'timeLogs'), logData);
      logAction?.('timeLogs', 'check_in', null, logData, `Dashboard check-in at ${checkInLocation}`);
      addToast?.(`Checked in at ${checkInLocation}${selectedProj ? ` — ${selectedProj.project_name}` : ''}`, 'success');
      setCheckInProject(''); setCheckInLocation('HQ');
    } catch (e) { console.error(e); setGpsError(e.message || 'GPS error'); addToast?.('Check-in failed', 'error'); }
    finally { setGpsLoading(false); }
  }, [currentEmpId, activeShift, checkInLocation, checkInProject, hqSettings, myActiveProjects, db, appId, logAction, addToast]);

  const handleDashCheckOut = useCallback(async () => {
    if (!activeShift) return;
    setGpsLoading(true); setGpsError('');
    try {
      let gps = null;
      try { gps = await getGPS(); } catch (gpsErr) {
        addToast?.('GPS unavailable — check-out recorded without location.', 'warning');
      }
      const now = new Date().toISOString();
      const hrs = getLogHours({ ...activeShift, checkOut: now });
      const maxHrs = hqSettings.maxShiftHours || 0;
      const suspiciousHour = hqSettings.suspiciousCheckoutHour ?? 22;
      const checkoutHour = new Date(now).getHours();
      const isOverMax = maxHrs > 0 && hrs > maxHrs;
      const isNightCheckout = checkoutHour >= suspiciousHour;

      // Hard block: admin must force-close instead
      if (isOverMax && hqSettings.enforceMaxShift) {
        setGpsLoading(false);
        return addToast?.(`Checkout blocked — shift exceeds ${maxHrs}h limit. Contact your administrator to close this shift.`, 'error');
      }

      const flags = {
        lateCheckout: isOverMax,
        lateCheckoutHours: isOverMax ? Math.round(hrs * 10) / 10 : null,
        suspiciousNightCheckout: isNightCheckout,
        checkoutHour,
      };

      // Soft block: require reason
      if ((isOverMax && hqSettings.requireLateReason) || isNightCheckout) {
        setGpsLoading(false);
        setPendingCheckoutPayload({ now, gps, flags, hrs });
        setLateCheckoutReason('');
        setLateCheckoutModal(true);
        return;
      }

      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'timeLogs', activeShift.id), { checkOut: now, gpsCheckOut: gps, ...flags });
      logAction?.('timeLogs', 'check_out', activeShift.id, { checkOut: now, ...flags }, `Dashboard check-out (${hrs.toFixed(1)}h)`);
      addToast?.(`Checked out — ${hrs.toFixed(1)} hours`, 'success');
    } catch (e) { console.error(e); setGpsError(e.message || 'GPS error'); addToast?.('Check-out failed', 'error'); }
    finally { setGpsLoading(false); }
  }, [activeShift, db, appId, logAction, addToast, hqSettings]);

  const handleConfirmLateCheckout = useCallback(async () => {
    if (!pendingCheckoutPayload || !lateCheckoutReason.trim()) return;
    setGpsLoading(true);
    try {
      const { now, gps, flags, hrs } = pendingCheckoutPayload;
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'timeLogs', activeShift.id), {
        checkOut: now, gpsCheckOut: gps, ...flags,
        lateCheckoutReason: lateCheckoutReason.trim(),
      });
      logAction?.('timeLogs', 'check_out', activeShift.id, { checkOut: now, ...flags, lateCheckoutReason: lateCheckoutReason.trim() }, `Late checkout with reason (${hrs.toFixed(1)}h)`);
      addToast?.(`Checked out — ${hrs.toFixed(1)} hours (flagged for review)`, 'warning');
      setLateCheckoutModal(false); setPendingCheckoutPayload(null); setLateCheckoutReason('');
    } catch (e) { console.error(e); addToast?.('Check-out failed', 'error'); }
    finally { setGpsLoading(false); }
  }, [pendingCheckoutPayload, lateCheckoutReason, activeShift, db, appId, logAction, addToast]);

  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-';
  // ── End attendance ────────────────────────────────────────────────────────

  useEffect(() => {
    const loadCalendarColors = async () => {
      if (!db || !appId) return;
      try {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization');
        const snap = await getDoc(docRef);
        if (!snap.exists()) return;
        const stored = snap.data()?.calendar_color_settings || {};
        setCalendarColors({
          statusColors: { ...DEFAULT_STATUS_BG, ...(stored.statusColors || {}) },
          invoiceTextColors: { ...DEFAULT_INVOICE_TEXT, ...(stored.invoiceTextColors || {}) }
        });
      } catch (error) {
        console.error('Failed to load calendar colors', error);
      }
    };
    loadCalendarColors();
  }, [db, appId]);

  const getStatusBgColor = (status) => calendarColors.statusColors?.[status] || DEFAULT_STATUS_BG[status];

  const getInvoiceTextColor = (project) => {
    if (project.status !== 'Closed') return null;
    const key = project.invoice_status || '';
    const value = calendarColors.invoiceTextColors?.[key] || '';
    return value && value.trim() ? value.trim() : null;
  };

  // Revenue Data (Monthwise)
  const revenueData = useMemo(() => {
    // Build last 6 months keys (including current month)
    const now = new Date();
    const monthKeys = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // Initialize all 6 months with zeros
    const data = {};
    monthKeys.forEach(key => {
      data[key] = { totalRevenue: 0, netRevenue: 0, gst: 0, expenses: 0, outsourcing: 0 };
    });

    // Aggregate revenue & outsourcing from Completed/Closed projects
    projects.forEach(p => {
      if (['Completed', 'Closed'].includes(p.status)) {
         const d = new Date(p.end_date);
         if (!isNaN(d)) {
             const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
             if (data[key]) {
               data[key].totalRevenue += getProjectGrandTotal(p);
               data[key].netRevenue += getProjectNetTotal(p);
               data[key].gst += getProjectGST(p);
               // Outsourcing: vendor_allocations total (tax-inclusive)
               (p.vendor_allocations || []).forEach(v => {
                 data[key].outsourcing += parseFloat(v.tax_amount || v.amount || 0);
               });
             }
         }
      }
    });

    // Aggregate approved expenses by month
    (expenses || []).forEach(exp => {
      if (exp.status === 'Approved' && exp.date) {
        const d = new Date(exp.date);
        if (!isNaN(d)) {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (data[key]) {
            data[key].expenses += parseFloat(exp.amount) || 0;
          }
        }
      }
    });

    return monthKeys.map(key => {
       const [y, m] = key.split('-');
       const monthName = new Date(y, m - 1).toLocaleString('default', { month: 'short' });
       return { 
         name: `${monthName} ${y.slice(2)}`,
         'Revenue': Math.round(data[key].netRevenue),
         'GST': Math.round(data[key].gst),
         'Expenses': Math.round(data[key].expenses),
         'Outsourcing': Math.round(data[key].outsourcing)
       };
    });
  }, [projects, expenses]);

  // Calendar Logic
  const weeks = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    
    for(let i=0; i<firstDay.getDay(); i++) days.push(null);
    for(let i=1; i<=lastDay.getDate(); i++) days.push(new Date(year, month, i));
    
    const weeksArray = [];
    for (let i = 0; i < days.length; i += 7) {
        weeksArray.push(days.slice(i, i + 7));
    }
    return weeksArray;
  }, [currentMonth]);

  const getWeekRange = (week) => {
    const firstValidIndex = week.findIndex(d => d !== null);
    if (firstValidIndex === -1) return null;
    const firstValidDate = week[firstValidIndex];
    const startOfWeek = new Date(firstValidDate);
    startOfWeek.setDate(firstValidDate.getDate() - firstValidIndex);
    startOfWeek.setHours(0,0,0,0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23,59,59,999);
    
    return { start: startOfWeek, end: endOfWeek };
  };

  const getProjectBars = (week) => {
    const range = getWeekRange(week);
    if (!range) return { bars: [], totalRows: 0 };
    
    const weekProjects = projects.filter(p => {
        const pStart = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
        const pEnd = new Date(p.end_date);
        pStart.setHours(0,0,0,0); pEnd.setHours(23,59,59,999);
        return pStart <= range.end && pEnd >= range.start;
    });

    weekProjects.sort((a, b) => {
        const startA = a.setup_date ? new Date(a.setup_date) : new Date(a.start_date);
        const startB = b.setup_date ? new Date(b.setup_date) : new Date(b.start_date);
        if (startA - startB !== 0) return startA - startB;
        return (new Date(b.end_date) - startB) - (new Date(a.end_date) - startA);
    });

    const rows = [];
    const bars = weekProjects.map(p => {
        const pStart = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
        const pEnd = new Date(p.end_date);
        pStart.setHours(0,0,0,0); pEnd.setHours(23,59,59,999);

        const start = pStart < range.start ? range.start : pStart;
        const end = pEnd > range.end ? range.end : pEnd;

        const diffStart = Math.floor((start - range.start) / (1000 * 60 * 60 * 24));
        const diffDuration = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
        
        const startCol = Math.max(0, Math.min(6, diffStart));
        const span = Math.max(1, Math.min(7 - startCol, diffDuration));

        let rowIndex = 0;
        while (true) {
            if (!rows[rowIndex]) rows[rowIndex] = Array(7).fill(false);
            let collision = false;
            for (let i = startCol; i < startCol + span; i++) {
                if (rows[rowIndex][i]) { collision = true; break; }
            }
            if (!collision) {
                for (let i = startCol; i < startCol + span; i++) rows[rowIndex][i] = true;
                break;
            }
            rowIndex++;
        }
        return { project: p, startCol, span, rowIndex };
    });
    return { bars, totalRows: rows.length };
  };

  const changeMonth = (offset) => {
    const newDate = new Date(currentMonth);
    newDate.setMonth(newDate.getMonth() + offset);
    setCurrentMonth(newDate);
  };

  // Recent/Upcoming List (Setup Date +/- 7 days)
  const recentProjects = useMemo(() => {
      const today = new Date();
      today.setHours(0,0,0,0);
      const minDate = new Date(today); minDate.setDate(today.getDate() - 7);
      const maxDate = new Date(today); maxDate.setDate(today.getDate() + 7);
      
      return projects.filter(p => {
          const d = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
          d.setHours(0,0,0,0);
          return d >= minDate && d <= maxDate;
      }).sort((a,b) => new Date(a.start_date) - new Date(b.start_date));
  }, [projects]);

  const todaysBrief = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    return {
      setupToday: projects.filter(p => p.setup_date === todayStr && !['Cancelled', 'Closed'].includes(p.status)),
      startingToday: projects.filter(p => p.start_date === todayStr && !['Cancelled', 'Closed'].includes(p.status)),
      endingToday: projects.filter(p => p.end_date === todayStr && p.status === 'Ongoing'),
      ongoingNoChallan: projects.filter(p => p.status === 'Ongoing' && !(p.challans || []).some(c => c.type === 'delivery')),
    };
  }, [projects]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-800">Dashboard</h2>
        <span className="text-xs text-slate-400">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
      
      {can(role, 'employees', 'edit') && lockedEmployees.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 animate-pulse">
           <div className="flex items-center gap-3 text-red-800">
              <div className="bg-red-100 p-2 rounded-full"><AlertTriangle className="text-red-600" size={24} /></div>
              <div>
                 <div className="font-bold text-lg">Security Alert</div>
                 <div className="text-sm">{lockedEmployees.length} account(s) are currently locked due to failed login attempts.</div>
              </div>
           </div>
           <button onClick={() => navigate('/employees')} className="whitespace-nowrap bg-red-600 text-white px-4 py-2 rounded shadow-sm text-sm font-medium hover:bg-red-700">Review Accounts</button>
        </div>
      )}

      {/* ── Quick Attendance Check-in / Check-out ─────────────────────────── */}
      {currentEmpId && (
        <div className={`rounded-2xl shadow-lg border-2 overflow-hidden ${activeShift ? 'border-green-400 bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50' : 'border-indigo-300 bg-gradient-to-br from-indigo-50 via-blue-50 to-slate-50'}`}>
          {/* Header Banner */}
          <div className={`px-6 py-3 flex items-center justify-between ${activeShift ? 'bg-green-600' : 'bg-indigo-600'}`}>
            <div className="flex items-center gap-2">
              <Clock size={18} className={`text-white ${activeShift ? 'animate-pulse' : ''}`} />
              <span className="text-white text-sm font-bold uppercase tracking-widest">Attendance</span>
            </div>
            <span className="text-white/80 text-xs font-medium">{new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>

          <div className="p-6">
            {activeShift ? (
              <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                {/* Status */}
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center shadow-md">
                      <Clock size={32} className="text-green-600 animate-pulse" />
                    </div>
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white animate-pulse" />
                  </div>
                  <div>
                    <p className="text-xl font-extrabold text-green-700">Shift Active</p>
                    <p className="text-base font-semibold text-slate-700 mt-0.5">{activeShift.location}{activeShift.project_name ? ` — ${activeShift.project_name}` : ''}</p>
                    <p className="text-sm text-slate-500 mt-0.5">Checked in at <span className="font-bold text-slate-700">{fmtTime(activeShift.checkIn)}</span></p>
                  </div>
                </div>
                {/* Checkout button */}
                <button
                  onClick={handleDashCheckOut}
                  disabled={gpsLoading}
                  className="w-full md:w-auto rounded-2xl bg-red-600 hover:bg-red-700 active:scale-95 disabled:opacity-50 transition-all shadow-lg shadow-red-200 px-10 py-5 flex flex-col items-center gap-1"
                >
                  <span className="text-4xl leading-none">🔴</span>
                  <span className="text-white text-lg font-extrabold mt-1">{gpsLoading ? 'Getting GPS…' : 'Check Out'}</span>
                  <span className="text-red-200 text-xs">Tap to end your shift</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                {/* Location picker */}
                <div className="flex-1 space-y-3 w-full">
                  <div>
                    <p className="text-base font-bold text-slate-700 mb-1">📍 Select Location</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {LOCATION_TYPES.map(loc => (
                        <button key={loc} onClick={() => { setCheckInLocation(loc); if (loc !== 'Site') setCheckInProject(''); }}
                          className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-all ${checkInLocation === loc ? 'border-indigo-600 bg-indigo-600 text-white shadow-md shadow-indigo-200' : 'border-slate-200 bg-white text-slate-500 hover:border-indigo-300'}`}>
                          {loc}
                        </button>
                      ))}
                    </div>
                  </div>
                  {checkInLocation === 'Site' && (
                    <div>
                      <p className="text-sm font-bold text-slate-700 mb-1">🏗 Select Project</p>
                      <select value={checkInProject} onChange={e => setCheckInProject(e.target.value)}
                        className="border-2 border-indigo-200 rounded-xl px-3 py-2 text-sm font-semibold bg-white w-full max-w-xs focus:outline-none focus:border-indigo-500">
                        <option value="">— Select a project —</option>
                        {myActiveProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                {/* Check-in button */}
                <button
                  onClick={handleDashCheckIn}
                  disabled={gpsLoading}
                  className="w-full md:w-auto rounded-2xl bg-green-600 hover:bg-green-700 active:scale-95 disabled:opacity-50 transition-all shadow-lg shadow-green-200 px-10 py-5 flex flex-col items-center gap-1"
                >
                  <span className="text-4xl leading-none">🟢</span>
                  <span className="text-white text-lg font-extrabold mt-1">{gpsLoading ? 'Getting GPS…' : 'Check In'}</span>
                  <span className="text-green-200 text-xs">Mark your attendance</span>
                </button>
              </div>
            )}
            {gpsError && <p className="text-sm text-red-600 font-semibold mt-3 text-center bg-red-50 rounded-xl py-2">{gpsError}</p>}
          </div>
        </div>
      )}

      {/* Late / Night Checkout Reason Modal */}
      {lateCheckoutModal && pendingCheckoutPayload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-red-100 shrink-0"><Shield size={22} className="text-red-600" /></div>
              <div>
                <h3 className="text-lg font-bold text-slate-800">Late Checkout Detected</h3>
                <p className="text-sm text-slate-600 mt-1">
                  {pendingCheckoutPayload.flags.suspiciousNightCheckout && (
                    <span className="block text-red-600 font-medium">⚠ You are checking out after {hqSettings.suspiciousCheckoutHour ?? 22}:00 — this will be flagged for management review.</span>
                  )}
                  {pendingCheckoutPayload.flags.lateCheckout && (
                    <span className="block text-amber-700 font-medium mt-1">Shift duration: <strong>{pendingCheckoutPayload.hrs.toFixed(1)} hours</strong> (exceeds {hqSettings.maxShiftHours}h limit).</span>
                  )}
                  <span className="block mt-2 text-slate-600">Please provide a reason to proceed.</span>
                </p>
              </div>
            </div>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-800 resize-none focus:ring-2 focus:ring-red-400 focus:outline-none"
              rows={3}
              placeholder="Reason for late checkout (e.g. post-event cleanup, equipment packing, transport delay...)"
              value={lateCheckoutReason}
              onChange={e => setLateCheckoutReason(e.target.value)}
            />
            <div className="flex gap-3 justify-end">
              <button onClick={() => { setLateCheckoutModal(false); setPendingCheckoutPayload(null); }} className="rounded-lg border px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleConfirmLateCheckout} disabled={!lateCheckoutReason.trim() || gpsLoading} className="rounded-lg bg-red-600 px-5 py-2 text-sm text-white font-bold hover:bg-red-700 disabled:opacity-50">
                {gpsLoading ? 'Saving...' : 'Submit & Check Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
          <div className="p-2 rounded-lg bg-blue-50 text-blue-600"><CalendarDays size={18} /></div>
          <div>
            <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Active Events</div>
            <div className="mt-0.5 text-2xl font-bold text-slate-800">{activeProjects}</div>
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
          <div className="p-2 rounded-lg bg-amber-50 text-amber-600"><Clock size={18} /></div>
          <div>
            <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Pending Quotes</div>
            <div className="mt-0.5 text-2xl font-bold text-slate-800">{pendingQuotes}</div>
          </div>
        </div>
        {overdueProjects > 0 && (
          <div className="rounded-xl bg-red-50 p-4 shadow-sm border border-red-100 animate-pulse flex items-start gap-3">
            <div className="p-2 rounded-lg bg-red-100 text-red-600"><AlertCircle size={18} /></div>
            <div>
              <div className="text-xs text-red-600 font-semibold uppercase tracking-wide">Overdue Returns</div>
              <div className="mt-0.5 text-2xl font-bold text-red-700">{overdueProjects}</div>
            </div>
          </div>
        )}
        {can(role, 'expenses', 'approve') && (
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-rose-50 text-rose-600"><FileText size={18} /></div>
            <div>
              <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Pending Expenses</div>
              <div className="mt-0.5 text-2xl font-bold text-slate-800">
                {expenses.filter(e => e.status === 'Pending').length}
              </div>
            </div>
          </div>
        )}
        {can(role, 'finance', 'view') && (
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600"><TrendingUp size={18} /></div>
            <div>
              <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide flex items-center gap-2">
                Gross Revenue
                <select
                  value={selectedFY}
                  onChange={e => setSelectedFY(e.target.value)}
                  className="text-xs font-semibold bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 text-emerald-700 cursor-pointer"
                >
                  {availableFYs.map(fy => <option key={fy} value={fy}>FY {fy}</option>)}
                </select>
              </div>
              <div className="mt-0.5 text-xl font-bold text-slate-800">{formatCurrency(revenue)}</div>
            </div>
          </div>
        )}
      </div>

      {/* ===== MY WORK — visible to tech role only ===== */}
      {role === 'tech' && (
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide flex items-center gap-2">
            <Briefcase size={15} className="text-indigo-500" /> My Assignments
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* My Active Projects */}
            <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 bg-indigo-50 border-b flex items-center gap-2">
                <CalendarDays size={15} className="text-indigo-600" />
                <span className="font-bold text-indigo-800 text-sm">Active Assignments ({myActiveProjects.length})</span>
              </div>
              {myActiveProjects.length === 0 ? (
                <div className="p-6 text-center text-slate-400 text-sm">No active projects assigned to you.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {myActiveProjects.map(p => (
                    <li key={p.id} className="px-4 py-3 hover:bg-slate-50 cursor-pointer" onClick={() => onProjectClick && onProjectClick(p.id)}>
                      <div className="font-semibold text-sm text-slate-800">{p.project_name}</div>
                      <div className="flex flex-wrap gap-x-3 mt-0.5 text-xs text-slate-500">
                        {p.venue && <span><MapPin size={10} className="inline mr-0.5" />{p.venue}</span>}
                        <span>{fmtDate(p.start_date)} → {fmtDate(p.end_date)}</span>
                        <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-semibold ${STATUS_COLORS[p.status] || 'bg-slate-100 text-slate-700'}`}>{p.status}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* My Pending Expenses */}
            <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 bg-rose-50 border-b flex items-center gap-2">
                <FileText size={15} className="text-rose-600" />
                <span className="font-bold text-rose-800 text-sm">My Expense Claims</span>
              </div>
              {(() => {
                const myExpenses = expenses.filter(e => e.employee_id === currentEmpId).slice(0, 5);
                if (myExpenses.length === 0) return <div className="p-6 text-center text-slate-400 text-sm">No expense claims found.</div>;
                return (
                  <ul className="divide-y divide-slate-100">
                    {myExpenses.map(e => (
                      <li key={e.id} className="px-4 py-3 flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-slate-800">{e.category || e.description || 'Expense'}</div>
                          <div className="text-xs text-slate-400">{fmtDate(e.date)}{e.project_id && e.project_id !== 'general' ? ` · ${projects.find(p => p.id === e.project_id)?.project_name || ''}` : ''}</div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className="font-bold text-sm text-slate-800">{formatCurrency(e.amount)}</span>
                          <span className={`text-[10px] font-semibold rounded px-1.5 py-0 border ${e.status === 'Approved' ? 'bg-green-100 text-green-700 border-green-200' : e.status === 'Rejected' || e.status === 'Disapproved' ? 'bg-red-100 text-red-700 border-red-200' : 'bg-amber-100 text-amber-700 border-amber-200'}`}>{e.status || 'Pending'}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {can(role, 'finance', 'view') && (
        <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200">
          <h3 className="mb-4 text-sm font-bold text-slate-800 uppercase tracking-wide">Revenue & Expenses — Last 6 Months</h3>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueData} margin={{ top: 10, right: 20, left: 20, bottom: 5 }} barSize={20} barGap={2} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis
                  width={80}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => {
                    if (value >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
                    if (value >= 1000) return `₹${(value / 1000).toFixed(0)}K`;
                    return `₹${value}`;
                  }}
                />
                <RechartsTooltip formatter={(value) => formatCurrency(value)} />
                <Legend />
                <Bar dataKey="Revenue" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                <Bar dataKey="GST" fill="#818cf8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Outsourcing" fill="#f97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}


      {/* ===== TODAY'S OPERATIONS ===== */}
      {can(role, 'projects', 'edit') && (
        Object.values(todaysBrief).some(arr => arr.length > 0) ? (
        <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden">
          <div className="border-b px-5 py-3 bg-indigo-50 flex items-center gap-2">
            <Truck size={16} className="text-indigo-500" />
            <h3 className="font-bold text-indigo-800">Today's Operations — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</h3>
          </div>
          <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-100">
            {todaysBrief.setupToday.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-amber-600 uppercase mb-2">🔧 Setup Today ({todaysBrief.setupToday.length})</div>
                {todaysBrief.setupToday.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    {p.venue && <span className="text-slate-400 text-xs ml-1">@ {p.venue}</span>}
                  </div>
                ))}
              </div>
            )}
            {todaysBrief.startingToday.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-green-600 uppercase mb-2">▶ Starting Today ({todaysBrief.startingToday.length})</div>
                {todaysBrief.startingToday.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    {p.venue && <span className="text-slate-400 text-xs ml-1">@ {p.venue}</span>}
                  </div>
                ))}
              </div>
            )}
            {todaysBrief.endingToday.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-blue-600 uppercase mb-2">⏹ Wrapping Up Today ({todaysBrief.endingToday.length})</div>
                {todaysBrief.endingToday.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    {p.venue && <span className="text-slate-400 text-xs ml-1">@ {p.venue}</span>}
                  </div>
                ))}
              </div>
            )}
            {todaysBrief.ongoingNoChallan.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-red-600 uppercase mb-2">⚠ Ongoing — No Delivery Challan ({todaysBrief.ongoingNoChallan.length})</div>
                {todaysBrief.ongoingNoChallan.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    <span className="text-slate-400 text-xs ml-1">({fmtDate(p.start_date)} → {fmtDate(p.end_date)})</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        ) : null
      )}

      {/* Calendar */}
      <div className="rounded-xl bg-white shadow-sm border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Project Calendar</h3>
              <div className="flex items-center gap-2">
                  <button
                    onClick={() => changeMonth(-1)}
                    className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    aria-label="Previous month"
                  >
                    <ChevronRight className="rotate-180" size={16} /> Prev
                  </button>
                  <span className="min-w-[160px] text-center font-bold text-slate-800">
                    {currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
                  </span>
                  <button
                    onClick={() => changeMonth(1)}
                    className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    aria-label="Next month"
                  >
                    Next <ChevronRight size={16} />
                  </button>
              </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                      <div key={d} className="p-2 text-center text-xs font-bold text-slate-600 uppercase">{d}</div>
                  ))}
              </div>
              {weeks.map((week, wIdx) => {
                  const { bars, totalRows } = getProjectBars(week);
                  const minHeight = Math.max(100, (totalRows * 24) + 40);
                  return (
                      <div key={wIdx} className="grid grid-cols-7 border-b border-slate-100 relative" style={{ minHeight: `${minHeight}px` }}>
                          {week.map((date, dIdx) => (
                              <div key={dIdx} className={`border-r border-slate-100 p-1 ${!date ? 'bg-slate-50' : ''}`}>
                                  {date && (
                                      <div className={`text-xs font-medium mb-1 ${date.toDateString() === new Date().toDateString() ? 'bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center' : 'text-slate-400'}`}>
                                          {date.getDate()}
                                      </div>
                                  )}
                              </div>
                          ))}
                          <div className="absolute inset-0 top-8 flex flex-col pointer-events-none z-10">
                              {bars.map((bar, idx) => (
                                  (() => {
                                  const statusBg = getStatusBgColor(bar.project.status);
                                  const invoiceColor = getInvoiceTextColor(bar.project);
                                  const barStyle = { backgroundColor: statusBg, borderColor: statusBg };
                                  if (invoiceColor) barStyle.color = invoiceColor;
                                  return (
                                  <div 
                                      key={idx} 
                                      onClick={() => {
                                        if (onProjectClick) onProjectClick(bar.project.id);
                                        navigate(`/projects/${bar.project.id}`);
                                      }}
                                      className={`absolute h-5 rounded text-[10px] px-1 truncate cursor-pointer pointer-events-auto shadow-sm border ${STATUS_COLORS[bar.project.status]} hover:opacity-90`}
                                      style={{
                                          left: `${bar.startCol * 14.28}%`,
                                          width: `${bar.span * 14.28}%`,
                                          top: `${bar.rowIndex * 22}px`,
                                      margin: '0 2px',
                                      ...barStyle
                                      }}
                                      title={`${bar.project.project_name} (${bar.project.status})`}
                                  >
                                      <span className="font-bold mr-1">{clients.find(c=>c.id===bar.project.client_id)?.name}</span>
                                      {bar.project.project_name}
                                  </div>
                                  );
                                  })()
                              ))}
                          </div>
                      </div>
                  );
              })}
          </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm border border-slate-200">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Recent & Upcoming — Setup ±7 Days</h3>
        </div>
        <div className="divide-y divide-slate-100">
          {recentProjects.map(project => (
            <div key={project.id} className="flex items-center justify-between p-4 hover:bg-slate-50">
              <div>
                <div className="font-bold text-slate-800">{project.project_name}</div>
                <div className="text-sm text-slate-500">
                    <span className="font-medium text-indigo-600">{clients.find(c=>c.id===project.client_id)?.name}</span> • {project.venue}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                    Start: {fmtDate(project.start_date)} {project.setup_date && `| Setup: ${fmtDate(project.setup_date)}`}
                </div>
              </div>
              <span className={`rounded-full px-2 py-1 text-xs font-medium border ${STATUS_COLORS[project.status]}`}>
                {project.status}
              </span>
            </div>
          ))}
          {recentProjects.length === 0 && <div className="p-4 text-center text-slate-400">No projects in range.</div>}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
