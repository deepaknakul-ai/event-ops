import React, { useState, useMemo } from 'react';
import { BarChart3, Users, Clock, MapPin, AlertTriangle, CheckCircle, XCircle, TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { getLogHours, getFiscalYearStart, calculateCompliance } from '../utils/helpers';
import { LEAVE_ENTITLEMENTS } from '../utils/constants';

const PIE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

// eslint-disable-next-line no-unused-vars
const KPI = ({ icon: Icon, label, value, sub, color = 'text-indigo-600', bgColor = 'bg-indigo-50' }) => (
  <div className="rounded-xl border bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
      <div className={`rounded-lg p-2 ${bgColor}`}><Icon size={20} className={color} /></div>
    </div>
  </div>
);

const HRDashboard = ({ employees = [], timeLogs = [], hrLeaves = [], shiftRequests = [], penalties = [] }) => {
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const activeEmployees = useMemo(() => employees.filter(e => e.status !== 'Inactive'), [employees]);

  // Time logs for selected month
  const monthLogs = useMemo(() => {
    const [y, m] = selectedMonth.split('-').map(Number);
    return timeLogs.filter(l => {
      if (!l.checkIn) return false;
      const d = new Date(l.checkIn);
      return d.getFullYear() === y && d.getMonth() === m - 1;
    });
  }, [timeLogs, selectedMonth]);

  // Currently active shifts (checked in, no check out)
  const activeShifts = useMemo(() => timeLogs.filter(l => l.checkIn && !l.checkOut), [timeLogs]);

  // Monthly hours per employee
  const empMonthlyHours = useMemo(() => {
    const map = {};
    monthLogs.forEach(l => {
      const eid = l.employeeId;
      if (!map[eid]) map[eid] = 0;
      map[eid] += getLogHours(l);
    });
    return map;
  }, [monthLogs]);

  // FY hours
  const fyStart = useMemo(() => getFiscalYearStart(), []);
  const fyLogs = useMemo(() => timeLogs.filter(l => l.checkIn && new Date(l.checkIn) >= fyStart), [timeLogs, fyStart]);
  const totalFyHours = useMemo(() => fyLogs.reduce((s, l) => s + getLogHours(l), 0), [fyLogs]);
  const totalMonthlyHours = useMemo(() => monthLogs.reduce((s, l) => s + getLogHours(l), 0), [monthLogs]);

  // Geo exceptions this month
  const geoExceptions = useMemo(() => monthLogs.filter(l => l.geofenceVerified === false).length, [monthLogs]);

  // Missing checkouts this month
  const missingCheckouts = useMemo(() => monthLogs.filter(l => l.autoClosed).length, [monthLogs]);

  // Compliance
  const avgCompliance = useMemo(() => {
    const targets = activeEmployees.filter(e => e.monthlyTargetHours > 0);
    if (!targets.length) return 0;
    return Math.round(targets.reduce((s, e) => s + calculateCompliance(empMonthlyHours[e.id] || 0, e.monthlyTargetHours), 0) / targets.length);
  }, [activeEmployees, empMonthlyHours]);

  // Pending leaves & shifts
  const pendingLeaves = useMemo(() => hrLeaves.filter(l => l.status === 'Pending').length, [hrLeaves]);
  const pendingShifts = useMemo(() => shiftRequests.filter(s => s.status === 'Pending').length, [shiftRequests]);

  // Monthly penalties
  const monthPenalties = useMemo(() => {
    const [y, m] = selectedMonth.split('-').map(Number);
    return penalties.filter(p => {
      if (!p.appliedAt) return false;
      const d = new Date(p.appliedAt);
      return d.getFullYear() === y && d.getMonth() === m - 1;
    });
  }, [penalties, selectedMonth]);

  // Employee hours bar chart data
  const empChartData = useMemo(() => {
    return activeEmployees
      .map(e => ({ name: e.name?.split(' ')[0] || e.id?.slice(0, 6), hours: Math.round((empMonthlyHours[e.id] || 0) * 10) / 10, target: e.monthlyTargetHours || 0 }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 15);
  }, [activeEmployees, empMonthlyHours]);

  // Location distribution pie
  const locationPie = useMemo(() => {
    const map = {};
    monthLogs.forEach(l => { const loc = l.location || 'Unknown'; map[loc] = (map[loc] || 0) + 1; });
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [monthLogs]);

  // Leave balance summary
  const leaveStats = useMemo(() => {
    const fyLeaves = hrLeaves.filter(l => new Date(l.created_at || l.startDate) >= fyStart);
    const total = fyLeaves.length;
    const approved = fyLeaves.filter(l => l.status === 'Approved').length;
    const pending = fyLeaves.filter(l => l.status === 'Pending').length;
    const rejected = fyLeaves.filter(l => l.status === 'Rejected').length;
    return { total, approved, pending, rejected };
  }, [hrLeaves, fyStart]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><BarChart3 size={24} /> HR Dashboard</h2>
        <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} className="rounded border border-slate-300 p-2 text-sm text-black" />
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPI icon={Users} label="Total Personnel" value={activeEmployees.length} sub={`${employees.length} total incl. inactive`} />
        <KPI icon={Clock} label="Currently On Duty" value={activeShifts.length} sub="Active shifts now" color="text-green-600" bgColor="bg-green-50" />
        <KPI icon={TrendingUp} label="Monthly Hours" value={Math.round(totalMonthlyHours)} sub={`${monthLogs.length} check-ins`} color="text-blue-600" bgColor="bg-blue-50" />
        <KPI icon={TrendingUp} label="FY Hours" value={Math.round(totalFyHours)} sub={`Since ${fyStart.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`} color="text-purple-600" bgColor="bg-purple-50" />
        <KPI icon={CheckCircle} label="Avg Compliance" value={`${avgCompliance}%`} sub="Target adherence" color={avgCompliance >= 80 ? 'text-green-600' : 'text-amber-600'} bgColor={avgCompliance >= 80 ? 'bg-green-50' : 'bg-amber-50'} />
        <KPI icon={MapPin} label="Geo Exceptions" value={geoExceptions} sub="Outside fence check-ins" color="text-red-600" bgColor="bg-red-50" />
        <KPI icon={XCircle} label="Missing Check-outs" value={missingCheckouts} sub="Auto-closed shifts" color="text-amber-600" bgColor="bg-amber-50" />
        <KPI icon={AlertTriangle} label="Penalties" value={monthPenalties.length} sub={`${monthPenalties.reduce((s, p) => s + (p.minutes || 0), 0)} min total`} color="text-red-600" bgColor="bg-red-50" />
      </div>

      {/* Pending Actions */}
      {(pendingLeaves > 0 || pendingShifts > 0) && (
        <div className="flex gap-4 flex-wrap">
          {pendingLeaves > 0 && (
            <div className="rounded-lg border-l-4 border-amber-400 bg-amber-50 px-4 py-3">
              <span className="text-sm font-medium text-amber-800">{pendingLeaves} pending leave request{pendingLeaves > 1 ? 's' : ''}</span>
            </div>
          )}
          {pendingShifts > 0 && (
            <div className="rounded-lg border-l-4 border-purple-400 bg-purple-50 px-4 py-3">
              <span className="text-sm font-medium text-purple-800">{pendingShifts} pending shift request{pendingShifts > 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Employee Hours Bar Chart */}
        <div className="lg:col-span-2 rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Employee Hours — {new Date(selectedMonth + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h3>
          {empChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300} minWidth={0}>
              <BarChart data={empChartData} margin={{ left: 0, right: 10 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => `${v} hrs`} />
                <Bar dataKey="hours" fill="#6366f1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="target" fill="#e2e8f0" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="text-sm text-slate-400 text-center py-12">No attendance data for this month.</p>}
        </div>

        {/* Location Pie */}
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Check-in Locations</h3>
          {locationPie.length > 0 ? (
            <ResponsiveContainer width="100%" height={250} minWidth={0}>
              <PieChart>
                <Pie data={locationPie} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {locationPie.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="text-sm text-slate-400 text-center py-12">No data.</p>}
        </div>
      </div>

      {/* Leave Summary */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Leave Summary (FY)</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
          <div><p className="text-2xl font-bold text-slate-800">{leaveStats.total}</p><p className="text-xs text-slate-500">Total Applied</p></div>
          <div><p className="text-2xl font-bold text-green-600">{leaveStats.approved}</p><p className="text-xs text-slate-500">Approved</p></div>
          <div><p className="text-2xl font-bold text-amber-600">{leaveStats.pending}</p><p className="text-xs text-slate-500">Pending</p></div>
          <div><p className="text-2xl font-bold text-red-600">{leaveStats.rejected}</p><p className="text-xs text-slate-500">Rejected</p></div>
        </div>
      </div>

      {/* Employee Progress Table */}
      <div className="rounded-xl border bg-white p-5 shadow-sm overflow-x-auto">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Employee Attendance Summary</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-slate-500 uppercase">
              <th className="pb-2 pr-4">Employee</th>
              <th className="pb-2 pr-4">Role</th>
              <th className="pb-2 pr-4 text-right">Hours</th>
              <th className="pb-2 pr-4 text-right">Target</th>
              <th className="pb-2 pr-4 text-right">Compliance</th>
              <th className="pb-2 pr-4">Progress</th>
              <th className="pb-2 text-right">Penalties</th>
            </tr>
          </thead>
          <tbody>
            {activeEmployees.map(emp => {
              const hours = Math.round((empMonthlyHours[emp.id] || 0) * 10) / 10;
              const target = emp.monthlyTargetHours || 0;
              const comp = target > 0 ? Math.min(100, Math.round((hours / target) * 100)) : 0;
              const empPenalties = monthPenalties.filter(p => p.employeeId === emp.id);
              return (
                <tr key={emp.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-4 font-medium text-slate-800">{emp.name}</td>
                  <td className="py-2 pr-4 text-slate-500">{emp.role || '-'}</td>
                  <td className="py-2 pr-4 text-right font-mono">{hours}</td>
                  <td className="py-2 pr-4 text-right font-mono text-slate-400">{target || '-'}</td>
                  <td className="py-2 pr-4 text-right">
                    <span className={`font-bold ${comp >= 80 ? 'text-green-600' : comp >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{target ? `${comp}%` : '-'}</span>
                  </td>
                  <td className="py-2 pr-4 w-32">
                    {target > 0 && (
                      <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${comp >= 80 ? 'bg-green-500' : comp >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(comp, 100)}%` }} />
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right">{empPenalties.length > 0 ? <span className="text-red-600 font-medium">{empPenalties.length}</span> : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {activeEmployees.length === 0 && <p className="text-center text-sm text-slate-400 py-6">No active employees.</p>}
      </div>
    </div>
  );
};

export default HRDashboard;
