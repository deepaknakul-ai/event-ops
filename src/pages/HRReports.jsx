import React, { useEffect, useState, useMemo } from 'react';
import { FileBarChart, Download, Printer, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { getLogHours, calculateCompliance, calculateLeaveBalance, getProjectGrandTotal, formatCurrency, getFYFromDate, getHourlyRateForDate } from '../utils/helpers';
import { LEAVE_ENTITLEMENTS, LEAVE_TYPES } from '../utils/constants';
import { can } from '../utils/permissions';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { notify } from '../utils/toast';

const REPORT_TYPES = [
  'Monthly Attendance',
  'Employee Hours Summary',
  'Leave Report',
  'Compliance Report',
  'Penalty Report',
  'Shift Request Report',
  'Project Work Attendance',
  'Payroll Summary',
  'Working Hours Audit',
  'Employee Financial Performance',
];

const PERFORMANCE_REPORT_INDEX = 9;

const PERFORMANCE_PERIOD_TYPES = [
  { value: 'custom', label: 'Custom Period' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'fy', label: 'Financial Year' },
];

const PERFORMANCE_QUARTERS = [
  { value: 'Q1', label: 'Q1 (Apr-Jun)' },
  { value: 'Q2', label: 'Q2 (Jul-Sep)' },
  { value: 'Q3', label: 'Q3 (Oct-Dec)' },
  { value: 'Q4', label: 'Q4 (Jan-Mar)' },
];

const WH_BANDS = [
  { key: 'under8',     label: '< 8 hrs',    color: 'bg-blue-100 text-blue-700',   row: 'bg-blue-50',   badge: 'bg-blue-100 text-blue-700' },
  { key: 'normal',     label: '8 – 12 hrs', color: 'bg-green-100 text-green-700', row: '',             badge: 'bg-green-100 text-green-700' },
  { key: 'extended',   label: '12 – 16 hrs',color: 'bg-amber-100 text-amber-700', row: 'bg-amber-50',  badge: 'bg-amber-100 text-amber-700' },
  { key: 'suspicious', label: '> 16 hrs',   color: 'bg-red-100 text-red-700',    row: 'bg-red-50',    badge: 'bg-red-100 text-red-700' },
];

const getBand = (hrs) => {
  if (hrs < 8)   return 'under8';
  if (hrs <= 12) return 'normal';
  if (hrs <= 16) return 'extended';
  return 'suspicious';
};

const isExpenseRejectedStatus = (status) => status === 'Rejected' || status === 'Disapproved';
const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const getCurrentFYStartYear = () => {
  const now = new Date();
  return now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
};
const formatFYLabel = (startYear) => `${startYear}-${String(startYear + 1).slice(-2)}`;
const toIsoDateInput = (dateObj) => {
  const d = new Date(dateObj);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};
const toDateSafe = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};
const toStartOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const toEndOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const isDateInRange = (date, start, end) => !!date && date >= start && date <= end;
const doDatesOverlap = (aStart, aEnd, bStart, bEnd) => !!aStart && !!aEnd && !!bStart && !!bEnd && aStart <= bEnd && aEnd >= bStart;
const getFinancialQuarterRange = (fyStartYear, quarter) => {
  const quarterMap = {
    Q1: { startMonth: 3, endMonth: 5, yearOffset: 0 },
    Q2: { startMonth: 6, endMonth: 8, yearOffset: 0 },
    Q3: { startMonth: 9, endMonth: 11, yearOffset: 0 },
    Q4: { startMonth: 0, endMonth: 2, yearOffset: 1 },
  };
  const cfg = quarterMap[quarter] || quarterMap.Q1;
  const startYear = fyStartYear + cfg.yearOffset;
  const start = new Date(startYear, cfg.startMonth, 1);
  const end = new Date(startYear, cfg.endMonth + 1, 0);
  return {
    valid: true,
    start: toStartOfDay(start),
    end: toEndOfDay(end),
    label: `${quarter} ${formatFYLabel(fyStartYear)}`,
  };
};
const getFinancialYearRange = (fyStartYear) => {
  const start = new Date(fyStartYear, 3, 1);
  const end = new Date(fyStartYear + 1, 2, 31);
  return {
    valid: true,
    start: toStartOfDay(start),
    end: toEndOfDay(end),
    label: `FY ${formatFYLabel(fyStartYear)}`,
  };
};

const HRReports = ({ employees = [], timeLogs = [], hrLeaves = [], shiftRequests = [], penalties = [], payroll = [], projects = [], expenses = [], payouts = [], advances = [], role, logAction, hqSettings = {} }) => {
  const currentFYStartYear = useMemo(() => getCurrentFYStartYear(), []);
  const [reportType, setReportType] = useState(0);
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [performanceRangeType, setPerformanceRangeType] = useState('quarter');
  const [performanceFYStartYear, setPerformanceFYStartYear] = useState(currentFYStartYear);
  const [performanceQuarter, setPerformanceQuarter] = useState('Q1');
  const [performanceCustomStart, setPerformanceCustomStart] = useState(() => {
    const now = new Date();
    return toIsoDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
  });
  const [performanceCustomEnd, setPerformanceCustomEnd] = useState(() => toIsoDateInput(new Date()));
  const [performanceSelectedEmployee, setPerformanceSelectedEmployee] = useState('');

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e])), [employees]);
  const getEmpName = (id) => empMap[id]?.name || id?.slice(0, 8);
  const activeEmployees = useMemo(() => employees.filter(e => e.status !== 'Inactive'), [employees]);
  const projMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects]);

  const [y, m] = selectedMonth.split('-').map(Number);

  const monthLogs = useMemo(() => timeLogs.filter(l => {
    if (!l.checkIn) return false;
    const d = new Date(l.checkIn);
    return d.getFullYear() === y && d.getMonth() === m - 1;
  }), [timeLogs, y, m]);

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '-';
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-';
  const monthLabel = new Date(y, m - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // ── Report Data ───────────────────────────────────────────────────────────
  // 0: Monthly Attendance
  const monthlyAttendanceData = useMemo(() => {
    let logs = monthLogs;
    if (filterEmployee) logs = logs.filter(l => l.employeeId === filterEmployee);
    return logs.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));
  }, [monthLogs, filterEmployee]);

  // 0b: Calendar view for a single selected employee (date-wise shows + hours)
  const employeeMonthCalendar = useMemo(() => {
    if (!filterEmployee) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const logs = monthLogs.filter(l => l.employeeId === filterEmployee && l.checkIn);
    const byDate = {};
    logs.forEach(l => {
      const d = new Date(l.checkIn);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (!byDate[key]) byDate[key] = { totalHours: 0, sessions: 0, hasOpen: false, shows: {} };
      const hrs = getLogHours(l);
      byDate[key].totalHours += hrs;
      byDate[key].sessions += 1;
      if (l.checkIn && !l.checkOut) byDate[key].hasOpen = true;
      const proj = l.project_id ? projMap[l.project_id] : null;
      const name = l.project_name || proj?.project_name || proj?.name
        || (l.location && l.location !== 'Site' ? l.location : 'General');
      const pid = l.project_id || `loc:${name}`;
      if (!byDate[key].shows[pid]) byDate[key].shows[pid] = { id: l.project_id || null, name, hours: 0, sessions: 0, status: proj?.status || '', location: l.location || '' };
      byDate[key].shows[pid].hours += hrs;
      byDate[key].shows[pid].sessions += 1;
    });
    const dates = Object.keys(byDate).sort();
    const detail = dates.map(key => ({
      date: key,
      totalHours: Math.round(byDate[key].totalHours * 100) / 100,
      sessions: byDate[key].sessions,
      hasOpen: byDate[key].hasOpen,
      shows: Object.values(byDate[key].shows)
        .map(s => ({ ...s, hours: Math.round(s.hours * 100) / 100, completed: ['Completed', 'Closed'].includes(s.status) }))
        .sort((a, b) => b.hours - a.hours),
    }));
    const distinctShows = new Set();
    detail.forEach(dd => dd.shows.forEach(s => { if (s.id) distinctShows.add(s.id); }));
    return {
      byDate,
      detail,
      daysInMonth: new Date(y, m, 0).getDate(),
      firstWeekday: new Date(y, m - 1, 1).getDay(),
      totalHours: Math.round(logs.reduce((s, l) => s + getLogHours(l), 0) * 100) / 100,
      daysPresent: dates.length,
      distinctShows: distinctShows.size,
      pad,
    };
  }, [filterEmployee, monthLogs, y, m, projMap]);

  // 1: Employee Hours Summary
  const hoursSummaryData = useMemo(() => {
    return activeEmployees.map(e => {
      const logs = monthLogs.filter(l => l.employeeId === e.id);
      const totalHours = logs.reduce((s, l) => s + getLogHours(l), 0);
      const penaltyMins = penalties.filter(p => p.employeeId === e.id && p.appliedAt && new Date(p.appliedAt).getFullYear() === y && new Date(p.appliedAt).getMonth() === m - 1).reduce((s, p) => s + (p.minutes || 0), 0);
      return { id: e.id, name: e.name, role: e.role, shifts: logs.length, totalHours: Math.round(totalHours * 100) / 100, target: e.monthlyTargetHours || 0, compliance: calculateCompliance(totalHours, e.monthlyTargetHours || 0), penaltyMins, geoExceptions: logs.filter(l => l.geofenceVerified === false).length };
    }).sort((a, b) => b.totalHours - a.totalHours);
  }, [activeEmployees, monthLogs, penalties, y, m]);

  // 2: Leave Report
  const leaveReportData = useMemo(() => {
    return activeEmployees.map(e => {
      const empLeaves = hrLeaves.filter(l => l.employeeId === e.id);
      const balance = calculateLeaveBalance(empLeaves, LEAVE_ENTITLEMENTS);
      const pending = empLeaves.filter(l => l.status === 'Pending').length;
      const approved = empLeaves.filter(l => l.status === 'Approved').length;
      return { id: e.id, name: e.name, ...balance, pending, approved, total: empLeaves.length };
    });
  }, [activeEmployees, hrLeaves]);

  // 3: Compliance Report
  const complianceData = useMemo(() => hoursSummaryData.filter(d => d.target > 0), [hoursSummaryData]);

  // 4: Penalty Report
  const penaltyData = useMemo(() => {
    let list = penalties.filter(p => p.appliedAt && new Date(p.appliedAt).getFullYear() === y && new Date(p.appliedAt).getMonth() === m - 1);
    if (filterEmployee) list = list.filter(p => p.employeeId === filterEmployee);
    return list.sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt));
  }, [penalties, y, m, filterEmployee]);

  // 5: Shift Request Report
  const shiftData = useMemo(() => {
    let list = shiftRequests.filter(s => s.created_at && new Date(s.created_at).getFullYear() === y && new Date(s.created_at).getMonth() === m - 1);
    if (filterEmployee) list = list.filter(s => s.employeeId === filterEmployee);
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [shiftRequests, y, m, filterEmployee]);

  // 6: Project Work Attendance
  const projectAttendanceData = useMemo(() => {
    let logs = timeLogs.filter(l => l.location === 'Site' && l.project_id);
    if (filterProject) logs = logs.filter(l => l.project_id === filterProject);
    if (filterEmployee) logs = logs.filter(l => l.employeeId === filterEmployee);
    return logs.sort((a, b) => new Date(b.checkIn || 0) - new Date(a.checkIn || 0));
  }, [timeLogs, filterProject, filterEmployee]);

  // 7: Payroll Summary
  const payrollData = useMemo(() => {
    let list = payroll.filter(p => p.month === m && p.year === y);
    if (filterEmployee) list = list.filter(p => p.employeeId === filterEmployee);
    return list;
  }, [payroll, y, m, filterEmployee]);

  // 8: Working Hours Audit
  const suspiciousHour = hqSettings.suspiciousCheckoutHour ?? 22;
  const workingHoursAuditData = useMemo(() => {
    let logs = monthLogs.filter(l => l.checkOut); // only completed shifts
    if (filterEmployee) logs = logs.filter(l => l.employeeId === filterEmployee);

    const getProjectNamesForLog = (log) => {
      const employeeId = String(log.employeeId || '');
      if (!employeeId) return [];

      const statusAllowed = new Set(['Confirmed', 'Ongoing', 'Completed', 'Closed']);
      const checkInDate = toDateSafe(log.checkIn);

      const allocatedProjectNames = projects
        .filter((p) => {
          if (!statusAllowed.has(String(p.status || '').trim())) return false;
          if (!(p.assigned_employees || []).map(String).includes(employeeId)) return false;
          if (!checkInDate) return true;

          const pStart = toDateSafe(p.setup_date || p.start_date);
          const pEnd = toDateSafe(p.end_date || p.start_date || p.setup_date);
          if (!pStart || !pEnd) return true;

          const start = toStartOfDay(pStart);
          start.setDate(start.getDate() - 1); // travel/setup grace
          const end = toEndOfDay(pEnd);
          end.setDate(end.getDate() + 1); // teardown grace
          return checkInDate >= start && checkInDate <= end;
        })
        .map((p) => p.project_name || p.name || (p.id ? `Project ${String(p.id).slice(0, 8)}` : ''))
        .filter(Boolean);

      const uniqueAllocated = Array.from(new Set(allocatedProjectNames));
      const isSite = String(log.location || '').toLowerCase() === 'site';
      const siteProjectName = log.project_name || projMap[log.project_id]?.project_name || projMap[log.project_id]?.name || '';

      if (isSite && siteProjectName) {
        return { names: [siteProjectName], source: 'Site Check-in' };
      }
      if (!isSite && uniqueAllocated.length > 0) {
        return { names: uniqueAllocated, source: 'Allocated Project(s)' };
      }
      if (isSite && uniqueAllocated.length > 0) {
        return { names: uniqueAllocated, source: 'Allocated (fallback)' };
      }
      return { names: [], source: '-' };
    };

    return logs
      .map(l => {
        const checkoutHour = new Date(l.checkOut).getHours();
        const projectInfo = getProjectNamesForLog(l);
        const projectDisplay = projectInfo.names.length === 0
          ? '-'
          : projectInfo.names.length === 1
            ? projectInfo.names[0]
            : `${projectInfo.names[0]} +${projectInfo.names.length - 1} more`;
        return {
          ...l,
          hrs: Math.round(getLogHours(l) * 100) / 100,
          band: getBand(getLogHours(l)),
          checkoutHour,
          isNightCheckout: checkoutHour >= suspiciousHour,
          projectNames: projectInfo.names,
          projectSource: projectInfo.source,
          projectDisplay,
          projectDisplayFull: projectInfo.names.join(', ') || '-',
        };
      })
      .sort((a, b) => b.hrs - a.hrs);
  }, [monthLogs, filterEmployee, suspiciousHour, projects, projMap]);

  const whAuditStats = useMemo(() => {
    const counts = { under8: 0, normal: 0, extended: 0, suspicious: 0, nightCheckout: 0, adminCorrected: 0 };
    workingHoursAuditData.forEach(r => {
      counts[r.band] = (counts[r.band] || 0) + 1;
      if (r.isNightCheckout) counts.nightCheckout++;
      if (r.adminAdjusted) counts.adminCorrected++;
    });
    return counts;
  }, [workingHoursAuditData]);

  // Per-employee suspicious summary for audit report
  const whEmpSummary = useMemo(() => {
    const map = {};
    workingHoursAuditData.forEach(r => {
      if (!map[r.employeeId]) map[r.employeeId] = { under8: 0, normal: 0, extended: 0, suspicious: 0, nightCheckout: 0, total: 0 };
      map[r.employeeId][r.band]++;
      map[r.employeeId].total++;
      if (r.isNightCheckout) map[r.employeeId].nightCheckout++;
    });
    return activeEmployees
      .filter(e => map[e.id])
      .map(e => ({ ...e, ...map[e.id] }))
      .sort((a, b) => b.suspicious - a.suspicious || b.nightCheckout - a.nightCheckout || b.extended - a.extended);
  }, [workingHoursAuditData, activeEmployees]);

  const performanceFYOptions = useMemo(() => {
    const years = new Set();
    const collect = (raw) => {
      const d = toDateSafe(raw);
      if (!d) return;
      const fy = getFYFromDate(d.toISOString());
      const startPart = Number(String(fy).split('-')[0]);
      if (!Number.isNaN(startPart)) years.add(startPart);
    };

    projects.forEach((p) => {
      collect(p.start_date || p.setup_date || p.created_at);
      collect(p.end_date || p.start_date || p.setup_date || p.updated_at);
    });
    expenses.forEach((e) => collect(e.date || e.created_at));
    timeLogs.forEach((l) => collect(l.checkIn || l.created_at));
    payouts.forEach((p) => collect(p.date || p.created_at));
    advances.forEach((a) => collect(a.date || a.created_at));
    payroll.forEach((p) => {
      const month = Number(p.month);
      const year = Number(p.year);
      if (month >= 1 && month <= 12 && year > 2000) collect(new Date(year, month - 1, 15));
    });

    years.add(currentFYStartYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [projects, expenses, timeLogs, payouts, advances, payroll, currentFYStartYear]);

  const performanceRange = useMemo(() => {
    if (performanceRangeType === 'custom') {
      const startRaw = toDateSafe(performanceCustomStart);
      const endRaw = toDateSafe(performanceCustomEnd);
      if (!startRaw || !endRaw || startRaw > endRaw) {
        return { valid: false, start: null, end: null, label: 'Invalid custom period' };
      }
      const start = toStartOfDay(startRaw);
      const end = toEndOfDay(endRaw);
      return {
        valid: true,
        start,
        end,
        label: `${start.toLocaleDateString('en-IN')} to ${end.toLocaleDateString('en-IN')}`,
      };
    }
    if (performanceRangeType === 'quarter') {
      return getFinancialQuarterRange(performanceFYStartYear, performanceQuarter);
    }
    return getFinancialYearRange(performanceFYStartYear);
  }, [performanceRangeType, performanceCustomStart, performanceCustomEnd, performanceFYStartYear, performanceQuarter]);

  const performanceRows = useMemo(() => {
    if (!performanceRange.valid) return [];

    const { start, end } = performanceRange;
    const rowsByEmployee = {};
    const completedStatuses = new Set(['Completed', 'Closed']);
    const activeStatuses = new Set(['Confirmed', 'Ongoing']);

    const ensureRow = (employeeId, fallbackName = 'Unknown') => {
      const id = String(employeeId || '');
      if (!id) return null;
      if (!rowsByEmployee[id]) {
        const emp = empMap[id] || activeEmployees.find((e) => String(e.id) === id);
        rowsByEmployee[id] = {
          id,
          name: emp?.name || fallbackName,
          role: emp?.role || '-',
          hourlyRate: Number(emp?.hourlyRate || 0),
          participatedProjects: 0,
          completedProjects: 0,
          soloCompletedProjects: 0,
          teamCompletedProjects: 0,
          activeProjects: 0,
          realizedRevenue: 0,
          pipelineRevenue: 0,
          expenseReportCount: 0,
          approvedExpenseCount: 0,
          approvedExpenses: 0,
          pendingExpenses: 0,
          disapprovedExpenses: 0,
          payrollCost: 0,
          estimatedLaborCost: 0,
          laborCost: 0,
          totalLoggedHours: 0,
          cashPayouts: 0,
          cashAdvances: 0,
          cashOutflow: 0,
          totalEmployeeCost: 0,
          netBenefit: 0,
          roiPct: null,
          benefitMarginPct: null,
          costSource: 'estimated',
          hasActivity: false,
          projectRows: [],
        };
      }
      return rowsByEmployee[id];
    };

    activeEmployees.forEach((e) => ensureRow(e.id, e.name));

    projects.forEach((project) => {
      const status = String(project.status || '').trim();
      if (status === 'Cancelled') return;

      const pStart = toDateSafe(project.start_date || project.setup_date || project.created_at);
      const pEnd = toDateSafe(project.end_date || project.start_date || project.setup_date || project.updated_at || project.created_at);
      const normalizedStart = pStart || pEnd;
      const normalizedEnd = pEnd || pStart;
      if (!normalizedStart || !normalizedEnd) return;
      if (!doDatesOverlap(normalizedStart, normalizedEnd, start, end)) return;

      const assigned = Array.from(new Set((project.assigned_employees || []).map((id) => String(id)).filter(Boolean)));
      if (assigned.length === 0) return;

      const teamSize = assigned.length;
      const total = Number(getProjectGrandTotal(project) || 0);
      const share = teamSize > 0 ? total / teamSize : 0;
      const isCompleted = completedStatuses.has(status);
      const isActive = activeStatuses.has(status);
      const projectName = project.project_name || project.name || `Project ${String(project.id || '').slice(0, 6)}`;

      assigned.forEach((empId) => {
        const row = ensureRow(empId, getEmpName(empId));
        if (!row) return;
        row.participatedProjects += 1;
        if (isCompleted) {
          row.completedProjects += 1;
          if (teamSize === 1) row.soloCompletedProjects += 1;
          else row.teamCompletedProjects += 1;
          row.realizedRevenue += share;
        }
        if (isActive) {
          row.activeProjects += 1;
          row.pipelineRevenue += share;
        }
        row.projectRows.push({
          id: project.id,
          name: projectName,
          status,
          teamSize,
          startDate: normalizedStart,
          endDate: normalizedEnd,
          revenueShare: roundMoney(share),
          isCompleted,
        });
      });
    });

    expenses.forEach((exp) => {
      const empId = String(exp.employee_id || exp.employeeId || '');
      if (!empId) return;
      const expenseDate = toDateSafe(exp.date || exp.created_at || exp.updated_at);
      if (!isDateInRange(expenseDate, start, end)) return;

      const row = ensureRow(empId, getEmpName(empId));
      if (!row) return;
      const amount = Number(exp.amount || 0);
      if (!Number.isFinite(amount)) return;
      row.expenseReportCount += 1;

      const status = String(exp.status || '').trim();
      if (status === 'Approved') {
        row.approvedExpenseCount += 1;
        row.approvedExpenses += amount;
      } else if (isExpenseRejectedStatus(status)) {
        row.disapprovedExpenses += amount;
      } else {
        row.pendingExpenses += amount;
      }
    });

    payroll.forEach((entry) => {
      const empId = String(entry.employeeId || entry.employee_id || '');
      if (!empId) return;

      const month = Number(entry.month);
      const year = Number(entry.year);
      if (!(month >= 1 && month <= 12 && year > 2000)) return;

      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = toEndOfDay(new Date(year, month, 0));
      if (!doDatesOverlap(monthStart, monthEnd, start, end)) return;

      const row = ensureRow(empId, getEmpName(empId));
      if (!row) return;
      const payValue = Number(entry.netPay ?? entry.grossPay ?? 0);
      if (Number.isFinite(payValue)) row.payrollCost += payValue;
    });

    timeLogs.forEach((log) => {
      const empId = String(log.employeeId || log.employee_id || '');
      if (!empId) return;
      const checkInDate = toDateSafe(log.checkIn);
      if (!isDateInRange(checkInDate, start, end)) return;

      const row = ensureRow(empId, getEmpName(empId));
      if (!row) return;
      const hours = getLogHours(log);
      row.totalLoggedHours += hours;
      if (hours > 0) {
        const emp = empMap[empId];
        const rateAtLogDate = Number(getHourlyRateForDate(emp, checkInDate || new Date()) || 0);
        row.estimatedLaborCost += hours * rateAtLogDate;
      }
    });

    payouts.forEach((item) => {
      const empId = String(item.employee_id || item.employeeId || '');
      if (!empId) return;
      const paidDate = toDateSafe(item.date || item.created_at);
      if (!isDateInRange(paidDate, start, end)) return;
      const row = ensureRow(empId, getEmpName(empId));
      if (!row) return;
      const amount = Number(item.amount || 0);
      if (Number.isFinite(amount)) row.cashPayouts += amount;
    });

    advances.forEach((item) => {
      const empId = String(item.employee_id || item.employeeId || '');
      if (!empId) return;
      const paidDate = toDateSafe(item.date || item.created_at);
      if (!isDateInRange(paidDate, start, end)) return;
      const row = ensureRow(empId, getEmpName(empId));
      if (!row) return;
      const amount = Number(item.amount || 0);
      if (Number.isFinite(amount)) row.cashAdvances += amount;
    });

    const finalRows = Object.values(rowsByEmployee).map((row) => {
      const estimatedLaborCost = roundMoney(row.estimatedLaborCost);
      const payrollCost = roundMoney(row.payrollCost);
      const laborCost = payrollCost > 0 ? payrollCost : estimatedLaborCost;
      const approvedExpenses = roundMoney(row.approvedExpenses);
      const totalEmployeeCost = roundMoney(laborCost + approvedExpenses);
      const realizedRevenue = roundMoney(row.realizedRevenue);
      const netBenefit = roundMoney(realizedRevenue - totalEmployeeCost);
      const cashPayouts = roundMoney(row.cashPayouts);
      const cashAdvances = roundMoney(row.cashAdvances);
      const cashOutflow = roundMoney(cashPayouts + cashAdvances);

      return {
        ...row,
        realizedRevenue,
        pipelineRevenue: roundMoney(row.pipelineRevenue),
        approvedExpenses,
        pendingExpenses: roundMoney(row.pendingExpenses),
        disapprovedExpenses: roundMoney(row.disapprovedExpenses),
        payrollCost,
        estimatedLaborCost,
        laborCost,
        totalLoggedHours: roundMoney(row.totalLoggedHours),
        cashPayouts,
        cashAdvances,
        cashOutflow,
        totalEmployeeCost,
        netBenefit,
        roiPct: laborCost > 0 ? roundMoney((netBenefit / laborCost) * 100) : null,
        benefitMarginPct: realizedRevenue > 0 ? roundMoney((netBenefit / realizedRevenue) * 100) : null,
        costSource: payrollCost > 0 ? 'payroll' : 'estimated',
        hasActivity: row.participatedProjects > 0 || row.expenseReportCount > 0 || totalEmployeeCost > 0 || cashOutflow > 0,
        projectRows: [...row.projectRows].sort((a, b) => (b.endDate?.getTime() || 0) - (a.endDate?.getTime() || 0)),
      };
    });

    finalRows.sort((a, b) => {
      if (b.netBenefit !== a.netBenefit) return b.netBenefit - a.netBenefit;
      if (b.realizedRevenue !== a.realizedRevenue) return b.realizedRevenue - a.realizedRevenue;
      if (b.completedProjects !== a.completedProjects) return b.completedProjects - a.completedProjects;
      return a.name.localeCompare(b.name);
    });

    return finalRows.map((row, index) => ({ ...row, placement: index + 1 }));
  }, [performanceRange, projects, expenses, payroll, timeLogs, payouts, advances, empMap, activeEmployees]);

  const performanceSummary = useMemo(() => {
    const base = performanceRows.filter((r) => r.hasActivity);
    const rows = base.length ? base : performanceRows;
    const totals = rows.reduce((acc, r) => {
      acc.realizedRevenue += r.realizedRevenue;
      acc.totalCost += r.totalEmployeeCost;
      acc.approvedExpenses += r.approvedExpenses;
      acc.laborCost += r.laborCost;
      acc.netBenefit += r.netBenefit;
      return acc;
    }, { realizedRevenue: 0, totalCost: 0, approvedExpenses: 0, laborCost: 0, netBenefit: 0 });

    const topPerformer = rows.length ? rows[0] : null;

    return {
      employeeCount: rows.length,
      totals: {
        realizedRevenue: roundMoney(totals.realizedRevenue),
        totalCost: roundMoney(totals.totalCost),
        approvedExpenses: roundMoney(totals.approvedExpenses),
        laborCost: roundMoney(totals.laborCost),
        netBenefit: roundMoney(totals.netBenefit),
      },
      topPerformer,
    };
  }, [performanceRows]);

  useEffect(() => {
    if (performanceRows.length === 0) {
      if (performanceSelectedEmployee) setPerformanceSelectedEmployee('');
      return;
    }
    const isValid = performanceRows.some((r) => r.id === performanceSelectedEmployee);
    if (!isValid) setPerformanceSelectedEmployee(performanceRows[0].id);
  }, [performanceRows, performanceSelectedEmployee]);

  const selectedPerformanceEmployeeData = useMemo(() => {
    if (performanceRows.length === 0) return null;
    return performanceRows.find((r) => r.id === performanceSelectedEmployee) || performanceRows[0];
  }, [performanceRows, performanceSelectedEmployee]);

  const selectedPerformanceProjects = useMemo(() => {
    if (!selectedPerformanceEmployeeData) return { completed: [], active: [] };
    return {
      completed: selectedPerformanceEmployeeData.projectRows.filter((p) => p.isCompleted),
      active: selectedPerformanceEmployeeData.projectRows.filter((p) => !p.isCompleted),
    };
  }, [selectedPerformanceEmployeeData]);

  // ── PDF Export ─────────────────────────────────────────────────────────────
  // Build { head, body } for the active report — shared by the PDF and CSV exporters.
  const buildReportTable = () => {
    const money = (value) => Number(value || 0).toFixed(2);
    switch (reportType) {
      case 0: // Monthly Attendance
        return {
          head: [['Employee', 'Date', 'Check In', 'Check Out', 'Hours', 'Location', 'Project', 'Geo', 'Source']],
          body: monthlyAttendanceData.map(l => [getEmpName(l.employeeId), fmtDate(l.checkIn), fmtTime(l.checkIn), l.checkOut ? fmtTime(l.checkOut) : 'Active', getLogHours(l).toFixed(1), l.location || '-', l.project_name || '-', l.geofenceVerified === false ? 'Outside' : l.geofenceVerified === true ? 'OK' : '-', l.source === 'SR' ? 'SR' : '-']),
        };
      case 1: // Hours Summary
        return {
          head: [['Employee', 'Role', 'Shifts', 'Total Hours', 'Target', 'Compliance', 'Penalties', 'Geo Exc.']],
          body: hoursSummaryData.map(d => [d.name, d.role || '-', d.shifts, d.totalHours, d.target || '-', d.target ? `${d.compliance}%` : '-', `${d.penaltyMins} min`, d.geoExceptions]),
        };
      case 2: // Leave Report
        return {
          head: [['Employee', ...LEAVE_TYPES.map(t => `${t} Bal`), 'Pending', 'Approved', 'Total']],
          body: leaveReportData.map(d => [d.name, ...LEAVE_TYPES.map(t => d[t] ?? '-'), d.pending, d.approved, d.total]),
        };
      case 3: // Compliance
        return {
          head: [['Employee', 'Hours', 'Target', 'Compliance %']],
          body: complianceData.map(d => [d.name, d.totalHours, d.target, `${d.compliance}%`]),
        };
      case 4: // Penalty
        return {
          head: [['Employee', 'Date', 'Minutes', 'Reason', 'Applied By']],
          body: penaltyData.map(p => [getEmpName(p.employeeId), fmtDate(p.appliedAt), p.minutes, p.reason, getEmpName(p.appliedBy)]),
        };
      case 5: // Shift Requests
        return {
          head: [['Employee', 'Start', 'End', 'Location', 'Status', 'Reason']],
          body: shiftData.map(s => [getEmpName(s.employeeId), fmtDate(s.startTime) + ' ' + fmtTime(s.startTime), fmtDate(s.endTime) + ' ' + fmtTime(s.endTime), s.location, s.status, s.reason?.slice(0, 50)]),
        };
      case 6: // Project Work Attendance
        return {
          head: [['Employee', 'Project', 'Check In', 'Check Out', 'Hours', 'GPS In', 'GPS Out']],
          body: projectAttendanceData.map(l => [getEmpName(l.employeeId), l.project_name || '-', fmtDate(l.checkIn) + ' ' + fmtTime(l.checkIn), l.checkOut ? fmtDate(l.checkOut) + ' ' + fmtTime(l.checkOut) : 'Active', getLogHours(l).toFixed(1), l.gpsCheckIn ? `${l.gpsCheckIn.lat?.toFixed(4)},${l.gpsCheckIn.lng?.toFixed(4)}` : '-', l.gpsCheckOut ? `${l.gpsCheckOut.lat?.toFixed(4)},${l.gpsCheckOut.lng?.toFixed(4)}` : '-']),
        };
      case 7: // Payroll
        return {
          head: [['Employee', 'Total Hrs', 'Penalty Hrs', 'Net Hrs', 'Rate/Hr', 'Gross', 'Deductions', 'Net Pay', 'Status']],
          body: payrollData.map(p => [getEmpName(p.employeeId), p.totalHours, p.penaltyHours, p.netHours, `₹${p.hourlyRate}`, `₹${p.grossPay}`, `₹${p.deductions || 0}`, `₹${p.netPay}`, p.status]),
        };
      case 8: // Working Hours Audit
        return {
          head: [['Employee', 'Check In (Date/Time)', 'Check Out (Date/Time)', 'Hours', 'Band', 'Location', 'Project(s)', 'Project Source', 'Flag']],
          body: workingHoursAuditData.map(r => [
            getEmpName(r.employeeId),
            `${fmtDate(r.checkIn)} ${fmtTime(r.checkIn)}`,
            `${fmtDate(r.checkOut)} ${fmtTime(r.checkOut)}`,
            r.hrs.toFixed(1),
            WH_BANDS.find(b => b.key === r.band)?.label || r.band,
            r.location || '-',
            r.projectDisplayFull || '-',
            r.projectSource || '-',
            r.band === 'suspicious' ? '⚠ HIGH RISK' : r.band === 'extended' ? 'Extended' : '',
          ]),
        };
      case PERFORMANCE_REPORT_INDEX: // Employee Financial Performance
        return {
          head: [['Rank', 'Employee', 'Role', 'Completed (Solo/Team)', 'Participated', 'Expense Reports', 'Realized Revenue', 'Employee Cost', 'Net Benefit', 'ROI %']],
          body: performanceRows.map((r) => [
            r.placement, r.name, r.role || '-',
            `${r.completedProjects} (${r.soloCompletedProjects}/${r.teamCompletedProjects})`,
            r.participatedProjects, r.expenseReportCount,
            money(r.realizedRevenue), money(r.totalEmployeeCost), money(r.netBenefit),
            r.roiPct == null ? '-' : `${r.roiPct}%`,
          ]),
        };
      default:
        return null;
    }
  };

  const exportPDF = () => {
    const table = buildReportTable();
    if (!table) return;
    if (!table.body.length) { notify('No data to export for this report / period.', 'info'); return; }
    const pdf = new jsPDF('l', 'mm', 'a4');
    const periodLabel = reportType === PERFORMANCE_REPORT_INDEX ? performanceRange.label : monthLabel;
    const exportSuffix = reportType === PERFORMANCE_REPORT_INDEX ? periodLabel : selectedMonth;
    const safeSuffix = String(exportSuffix || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
    pdf.setFontSize(14);
    pdf.text(`${REPORT_TYPES[reportType]} — ${periodLabel}`, 14, 15);
    pdf.setFontSize(8);
    pdf.text(`Generated: ${new Date().toLocaleString('en-IN')}`, 14, 21);
    autoTable(pdf, { head: table.head, body: table.body, startY: 25, styles: { fontSize: 7 }, headStyles: { fillColor: [99, 102, 241] } });
    pdf.save(`${REPORT_TYPES[reportType].replace(/\s/g, '_')}_${safeSuffix}.pdf`);
    const exportMeta = reportType === PERFORMANCE_REPORT_INDEX
      ? {
          range_type: performanceRangeType,
          range_label: performanceRange.label,
          start: performanceRange.start ? performanceRange.start.toISOString().slice(0, 10) : '',
          end: performanceRange.end ? performanceRange.end.toISOString().slice(0, 10) : '',
        }
      : { month: selectedMonth };
    logAction('hr_reports', 'export_pdf', reportType.toString(), exportMeta, `Exported ${REPORT_TYPES[reportType]} PDF`);
  };

  // CSV export
  const exportCSV = () => {
    let rows;
    switch (reportType) {
      case 1:
        rows = [['Employee', 'Role', 'Shifts', 'Total Hours', 'Target', 'Compliance', 'Penalties Min', 'Geo Exc.'], ...hoursSummaryData.map(d => [d.name, d.role, d.shifts, d.totalHours, d.target, d.compliance, d.penaltyMins, d.geoExceptions])];
        break;
      case 2:
        rows = [['Employee', ...LEAVE_TYPES, 'Pending', 'Approved', 'Total'], ...leaveReportData.map(d => [d.name, ...LEAVE_TYPES.map(t => d[t] ?? 0), d.pending, d.approved, d.total])];
        break;
      case 8:
        rows = [
          ['Employee', 'Check In Date/Time', 'Check Out Date/Time', 'Hours', 'Band', 'Location', 'Project(s)', 'Project Source'],
          ...workingHoursAuditData.map(r => [
            getEmpName(r.employeeId), `${fmtDate(r.checkIn)} ${fmtTime(r.checkIn)}`, `${fmtDate(r.checkOut)} ${fmtTime(r.checkOut)}`,
            r.hrs.toFixed(1), WH_BANDS.find(b => b.key === r.band)?.label || r.band, r.location || '-', r.projectDisplayFull || '-', r.projectSource || '-',
          ]),
        ];
        break;
      case PERFORMANCE_REPORT_INDEX:
        rows = [
          ['Rank', 'Employee', 'Role', 'Completed', 'Solo Completed', 'Team Completed', 'Participated', 'Expense Reports', 'Approved Expenses', 'Labor Cost', 'Total Cost', 'Realized Revenue', 'Net Benefit', 'ROI %', 'Cost Source'],
          ...performanceRows.map((r) => [
            r.placement,
            r.name,
            r.role || '-',
            r.completedProjects,
            r.soloCompletedProjects,
            r.teamCompletedProjects,
            r.participatedProjects,
            r.expenseReportCount,
            r.approvedExpenses,
            r.laborCost,
            r.totalEmployeeCost,
            r.realizedRevenue,
            r.netBenefit,
            r.roiPct == null ? '' : r.roiPct,
            r.costSource,
          ]),
        ];
        break;
      default: {
        const table = buildReportTable();
        rows = table && table.body.length ? [table.head[0], ...table.body] : [['No data for this report / period']];
        break;
      }
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const periodLabel = reportType === PERFORMANCE_REPORT_INDEX ? performanceRange.label : selectedMonth;
    const safeSuffix = String(periodLabel || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = `${REPORT_TYPES[reportType].replace(/\s/g, '_')}_${safeSuffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><FileBarChart size={24} /> HR Reports</h2>
        <div className="flex gap-2">
          {can(role, 'hr_reports', 'export') && (
            <>
              <button onClick={exportPDF} className="rounded bg-red-600 px-3 py-2 text-sm text-white font-medium hover:bg-red-700 flex items-center gap-1"><Printer size={14} /> PDF</button>
              <button onClick={exportCSV} className="rounded bg-green-600 px-3 py-2 text-sm text-white font-medium hover:bg-green-700 flex items-center gap-1"><Download size={14} /> CSV</button>
            </>
          )}
        </div>
      </div>

      {/* Report Type Selector + Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select className="rounded border border-slate-300 p-2 text-sm text-black font-medium" value={reportType} onChange={e => setReportType(Number(e.target.value))}>
          {REPORT_TYPES.map((t, i) => <option key={i} value={i}>{t}</option>)}
        </select>
        {reportType !== PERFORMANCE_REPORT_INDEX && (
          <>
            <input type="month" className="rounded border border-slate-300 p-2 text-sm text-black" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
            <select className="rounded border border-slate-300 p-2 text-sm text-black" value={filterEmployee} onChange={e => setFilterEmployee(e.target.value)}>
              <option value="">All Employees</option>
              {activeEmployees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </>
        )}
        {reportType === 6 && (
          <select className="rounded border border-slate-300 p-2 text-sm text-black" value={filterProject} onChange={e => setFilterProject(e.target.value)}>
            <option value="">All Projects</option>
            {projects.filter(p => ['Confirmed', 'Ongoing', 'Completed'].includes(p.status)).map(p => <option key={p.id} value={p.id}>{p.project_name || p.name}</option>)}
          </select>
        )}
        {reportType === PERFORMANCE_REPORT_INDEX && (
          <>
            <select
              className="rounded border border-slate-300 p-2 text-sm text-black"
              value={performanceRangeType}
              onChange={(e) => setPerformanceRangeType(e.target.value)}
            >
              {PERFORMANCE_PERIOD_TYPES.map((period) => (
                <option key={period.value} value={period.value}>{period.label}</option>
              ))}
            </select>

            {performanceRangeType === 'custom' && (
              <>
                <input
                  type="date"
                  className="rounded border border-slate-300 p-2 text-sm text-black"
                  value={performanceCustomStart}
                  onChange={(e) => setPerformanceCustomStart(e.target.value)}
                />
                <input
                  type="date"
                  className="rounded border border-slate-300 p-2 text-sm text-black"
                  value={performanceCustomEnd}
                  onChange={(e) => setPerformanceCustomEnd(e.target.value)}
                />
              </>
            )}

            {performanceRangeType === 'quarter' && (
              <>
                <select
                  className="rounded border border-slate-300 p-2 text-sm text-black"
                  value={performanceFYStartYear}
                  onChange={(e) => setPerformanceFYStartYear(Number(e.target.value))}
                >
                  {performanceFYOptions.map((fyStart) => (
                    <option key={fyStart} value={fyStart}>FY {formatFYLabel(fyStart)}</option>
                  ))}
                </select>
                <select
                  className="rounded border border-slate-300 p-2 text-sm text-black"
                  value={performanceQuarter}
                  onChange={(e) => setPerformanceQuarter(e.target.value)}
                >
                  {PERFORMANCE_QUARTERS.map((quarter) => (
                    <option key={quarter.value} value={quarter.value}>{quarter.label}</option>
                  ))}
                </select>
              </>
            )}

            {performanceRangeType === 'fy' && (
              <select
                className="rounded border border-slate-300 p-2 text-sm text-black"
                value={performanceFYStartYear}
                onChange={(e) => setPerformanceFYStartYear(Number(e.target.value))}
              >
                {performanceFYOptions.map((fyStart) => (
                  <option key={fyStart} value={fyStart}>FY {formatFYLabel(fyStart)}</option>
                ))}
              </select>
            )}

            <select
              className="rounded border border-slate-300 p-2 text-sm text-black"
              value={performanceSelectedEmployee}
              onChange={(e) => setPerformanceSelectedEmployee(e.target.value)}
            >
              <option value="">Top Performer</option>
              {performanceRows.map((row) => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* ═══════ REPORT 0: Monthly Attendance ═══════ */}
      {/* ═══════ REPORT 0 (employee selected): Calendar + date-wise shows ═══════ */}
      {reportType === 0 && filterEmployee && employeeMonthCalendar && (() => {
        const cal = employeeMonthCalendar;
        const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const cells = [];
        for (let i = 0; i < cal.firstWeekday; i++) cells.push(null);
        for (let d = 1; d <= cal.daysInMonth; d++) cells.push(d);
        const keyFor = (day) => `${y}-${cal.pad(m)}-${cal.pad(day)}`;
        const bandClass = (h) => h >= 8 ? 'bg-green-100 border-green-300 text-green-800'
          : h >= 4 ? 'bg-amber-100 border-amber-300 text-amber-800'
          : h > 0 ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-100 text-slate-300';
        const fmtKey = (key) => { const [yy, mm, dd] = key.split('-'); return new Date(Number(yy), Number(mm) - 1, Number(dd)).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }); };
        return (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Days Present', value: `${cal.daysPresent} / ${cal.daysInMonth}`, color: 'bg-indigo-50 border-indigo-200' },
                { label: 'Total Hours', value: cal.totalHours.toFixed(1), color: 'bg-green-50 border-green-200' },
                { label: 'Shows Worked', value: cal.distinctShows, color: 'bg-purple-50 border-purple-200' },
                { label: 'Avg Hrs / Present Day', value: cal.daysPresent ? (cal.totalHours / cal.daysPresent).toFixed(1) : '0', color: 'bg-amber-50 border-amber-200' },
              ].map(c => (
                <div key={c.label} className={`rounded-xl border p-3 ${c.color}`}>
                  <div className="text-[11px] font-medium text-slate-500">{c.label}</div>
                  <div className="text-lg font-bold text-slate-800 mt-0.5">{c.value}</div>
                </div>
              ))}
            </div>

            {/* Calendar grid */}
            <div className="rounded-xl border bg-white shadow-sm p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-slate-700">{getEmpName(filterEmployee)} — {monthLabel}</h3>
                <div className="flex items-center gap-3 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-green-100 border border-green-300" /> ≥8h</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-100 border border-amber-300" /> 4–8h</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-50 border border-blue-200" /> &lt;4h</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-blue-500" /> active</span>
                </div>
              </div>
              <div className="overflow-x-auto"><div className="grid grid-cols-7 gap-1 min-w-[560px]">
                {weekdays.map(w => <div key={w} className="text-center text-[10px] font-bold uppercase text-slate-400 py-1">{w}</div>)}
                {cells.map((day, i) => {
                  if (day === null) return <div key={`e${i}`} />;
                  const info = cal.byDate[keyFor(day)];
                  const h = info ? Math.round(info.totalHours * 10) / 10 : 0;
                  return (
                    <div key={day} className={`min-h-[58px] rounded-lg border p-1 text-right ${bandClass(h)}`} title={info ? `${h.toFixed(1)}h · ${Object.keys(info.shows).length} show(s)` : 'No attendance'}>
                      <div className="text-[11px] font-semibold leading-none flex items-center justify-end gap-1">
                        {info?.hasOpen && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />}
                        {day}
                      </div>
                      {info && (
                        <div className="mt-1 text-left">
                          <div className="text-[11px] font-bold">{h.toFixed(1)}h</div>
                          <div className="text-[9px] opacity-70 leading-tight truncate">{Object.keys(info.shows).length} show{Object.keys(info.shows).length > 1 ? 's' : ''}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div></div>
            </div>

            {/* Date-wise show & time detail */}
            <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
              <div className="px-3 py-2 border-b bg-slate-50 text-sm font-bold text-slate-700">Date-wise detail — shows attended & time per show</div>
              {cal.detail.length === 0 ? (
                <p className="text-center text-sm text-slate-400 py-8">No attendance for {monthLabel}.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {cal.detail.map(d => (
                    <div key={d.date} className="p-3">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="font-semibold text-slate-800 text-sm">{fmtKey(d.date)}{d.hasOpen && <span className="ml-2 text-[10px] font-semibold text-blue-600">● active shift</span>}</div>
                        <div className="text-sm font-bold text-indigo-700">{d.totalHours.toFixed(1)}h <span className="text-[11px] font-normal text-slate-400">· {d.sessions} session{d.sessions > 1 ? 's' : ''}</span></div>
                      </div>
                      <div className="space-y-1">
                        {d.shows.map((s, idx) => (
                          <div key={idx} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate text-slate-700">{s.name}</span>
                              {s.id && (
                                <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${s.completed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {s.completed ? 'Completed' : (s.status || 'Attended')}
                                </span>
                              )}
                            </div>
                            <span className="shrink-0 font-mono font-semibold text-slate-700">{s.hours.toFixed(1)}h</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ═══════ REPORT 0 (all employees): flat table ═══════ */}
      {reportType === 0 && !filterEmployee && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3">Date</th><th className="p-3">Check In</th><th className="p-3">Check Out</th><th className="p-3 text-right">Hours</th><th className="p-3">Location</th><th className="p-3">Project</th><th className="p-3">Geo</th>
            </tr></thead>
            <tbody>
              {monthlyAttendanceData.slice(0, 300).map(l => (
                <tr key={l.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{getEmpName(l.employeeId)}</td>
                  <td className="p-3">{fmtDate(l.checkIn)}</td>
                  <td className="p-3 font-mono">{fmtTime(l.checkIn)}</td>
                  <td className="p-3 font-mono">{l.checkOut ? fmtTime(l.checkOut) : <span className="text-green-600">Active</span>}</td>
                  <td className="p-3 text-right font-mono">{getLogHours(l).toFixed(1)}</td>
                  <td className="p-3">{l.location || '-'}</td>
                  <td className="p-3 text-xs">{l.project_name || '-'}</td>
                  <td className="p-3 text-xs">{l.geofenceVerified === false ? '❌' : l.geofenceVerified === true ? '✅' : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {monthlyAttendanceData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No records for this month.</p>}
        </div>
      )}

      {/* ═══════ REPORT 1: Employee Hours Summary ═══════ */}
      {reportType === 1 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3">Role</th><th className="p-3 text-right">Shifts</th><th className="p-3 text-right">Hours</th><th className="p-3 text-right">Target</th><th className="p-3 text-right">Compliance</th><th className="p-3 text-right">Penalties</th><th className="p-3 text-right">Geo Exc.</th>
            </tr></thead>
            <tbody>
              {hoursSummaryData.map(d => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{d.name}</td>
                  <td className="p-3 text-slate-500">{d.role || '-'}</td>
                  <td className="p-3 text-right">{d.shifts}</td>
                  <td className="p-3 text-right font-mono font-bold">{d.totalHours}</td>
                  <td className="p-3 text-right text-slate-400">{d.target || '-'}</td>
                  <td className="p-3 text-right"><span className={`font-bold ${d.compliance >= 80 ? 'text-green-600' : d.compliance >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{d.target ? `${d.compliance}%` : '-'}</span></td>
                  <td className="p-3 text-right text-red-600">{d.penaltyMins > 0 ? `${d.penaltyMins}m` : '-'}</td>
                  <td className="p-3 text-right">{d.geoExceptions > 0 ? <span className="text-red-600">{d.geoExceptions}</span> : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hoursSummaryData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No data.</p>}
        </div>
      )}

      {/* ═══════ REPORT 2: Leave Report ═══════ */}
      {reportType === 2 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th>
              {LEAVE_TYPES.map(t => <th key={t} className="p-3 text-center">{t}</th>)}
              <th className="p-3 text-center">Pending</th><th className="p-3 text-center">Approved</th><th className="p-3 text-center">Total</th>
            </tr></thead>
            <tbody>
              {leaveReportData.map(d => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{d.name}</td>
                  {LEAVE_TYPES.map(t => <td key={t} className="p-3 text-center"><span className={`font-bold ${(d[t] ?? 0) > 0 ? 'text-green-600' : 'text-red-600'}`}>{d[t] ?? 0}</span></td>)}
                  <td className="p-3 text-center text-amber-600">{d.pending}</td>
                  <td className="p-3 text-center text-green-600">{d.approved}</td>
                  <td className="p-3 text-center font-bold">{d.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════ REPORT 3: Compliance Report ═══════ */}
      {reportType === 3 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3 text-right">Hours</th><th className="p-3 text-right">Target</th><th className="p-3 text-right">Compliance</th><th className="p-3">Progress</th>
            </tr></thead>
            <tbody>
              {complianceData.map(d => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{d.name}</td>
                  <td className="p-3 text-right font-mono">{d.totalHours}</td>
                  <td className="p-3 text-right text-slate-400">{d.target}</td>
                  <td className="p-3 text-right"><span className={`font-bold ${d.compliance >= 80 ? 'text-green-600' : d.compliance >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{d.compliance}%</span></td>
                  <td className="p-3 w-40"><div className="h-2.5 rounded-full bg-slate-200 overflow-hidden"><div className={`h-full rounded-full ${d.compliance >= 80 ? 'bg-green-500' : d.compliance >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(d.compliance, 100)}%` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {complianceData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No employees with target hours set.</p>}
        </div>
      )}

      {/* ═══════ REPORT 4: Penalty Report ═══════ */}
      {reportType === 4 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3">Date</th><th className="p-3 text-right">Minutes</th><th className="p-3">Reason</th><th className="p-3">Applied By</th>
            </tr></thead>
            <tbody>
              {penaltyData.map(p => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{getEmpName(p.employeeId)}</td>
                  <td className="p-3">{fmtDate(p.appliedAt)}</td>
                  <td className="p-3 text-right font-mono text-red-600 font-bold">{p.minutes}</td>
                  <td className="p-3">{p.reason}</td>
                  <td className="p-3 text-xs text-slate-500">{getEmpName(p.appliedBy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {penaltyData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No penalties this month.</p>}
        </div>
      )}

      {/* ═══════ REPORT 5: Shift Request Report ═══════ */}
      {reportType === 5 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3">Start</th><th className="p-3">End</th><th className="p-3">Location</th><th className="p-3">Status</th><th className="p-3">Reason</th>
            </tr></thead>
            <tbody>
              {shiftData.map(s => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{getEmpName(s.employeeId)}</td>
                  <td className="p-3 font-mono text-xs">{fmtDate(s.startTime)} {fmtTime(s.startTime)}</td>
                  <td className="p-3 font-mono text-xs">{fmtDate(s.endTime)} {fmtTime(s.endTime)}</td>
                  <td className="p-3">{s.location}</td>
                  <td className="p-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded ${s.status === 'Approved' ? 'bg-green-100 text-green-700' : s.status === 'Rejected' ? 'bg-red-100 text-red-700' : s.status === 'Clarification' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>{s.status}</span></td>
                  <td className="p-3 text-xs max-w-[200px] truncate">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shiftData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No shift requests this month.</p>}
        </div>
      )}

      {/* ═══════ REPORT 6: Project Work Attendance ═══════ */}
      {reportType === 6 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3">Project</th><th className="p-3">Check In</th><th className="p-3">Check Out</th><th className="p-3 text-right">Hours</th><th className="p-3">GPS Check-In</th><th className="p-3">GPS Check-Out</th>
            </tr></thead>
            <tbody>
              {projectAttendanceData.slice(0, 300).map(l => (
                <tr key={l.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{getEmpName(l.employeeId)}</td>
                  <td className="p-3 text-indigo-700 font-medium">{l.project_name || projMap[l.project_id]?.name || l.project_id?.slice(0, 8)}</td>
                  <td className="p-3 font-mono text-xs">{fmtDate(l.checkIn)} {fmtTime(l.checkIn)}</td>
                  <td className="p-3 font-mono text-xs">{l.checkOut ? `${fmtDate(l.checkOut)} ${fmtTime(l.checkOut)}` : <span className="text-green-600">Active</span>}</td>
                  <td className="p-3 text-right font-mono">{getLogHours(l).toFixed(1)}</td>
                  <td className="p-3 text-xs font-mono text-slate-500">{l.gpsCheckIn ? `${l.gpsCheckIn.lat?.toFixed(4)}, ${l.gpsCheckIn.lng?.toFixed(4)}` : '-'}</td>
                  <td className="p-3 text-xs font-mono text-slate-500">{l.gpsCheckOut ? `${l.gpsCheckOut.lat?.toFixed(4)}, ${l.gpsCheckOut.lng?.toFixed(4)}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {projectAttendanceData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No site attendance records.</p>}
        </div>
      )}

      {/* ═══════ REPORT 7: Payroll Summary ═══════ */}
      {reportType === 7 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
              <th className="p-3">Employee</th><th className="p-3 text-right">Total Hrs</th><th className="p-3 text-right">Penalty Hrs</th><th className="p-3 text-right">Net Hrs</th><th className="p-3 text-right">Rate/Hr</th><th className="p-3 text-right">Gross</th><th className="p-3 text-right">Deductions</th><th className="p-3 text-right">Net Pay</th><th className="p-3">Status</th>
            </tr></thead>
            <tbody>
              {payrollData.map(p => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="p-3 font-medium">{getEmpName(p.employeeId)}</td>
                  <td className="p-3 text-right font-mono">{p.totalHours}</td>
                  <td className="p-3 text-right font-mono text-red-600">{p.penaltyHours}</td>
                  <td className="p-3 text-right font-mono font-bold">{p.netHours}</td>
                  <td className="p-3 text-right font-mono">{formatCurrency(p.hourlyRate)}</td>
                  <td className="p-3 text-right font-mono">{formatCurrency(p.grossPay)}</td>
                  <td className="p-3 text-right font-mono text-red-600">{formatCurrency(p.deductions || 0)}</td>
                  <td className="p-3 text-right font-mono font-bold text-green-600">{formatCurrency(p.netPay)}</td>
                  <td className="p-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded ${p.status === 'Finalized' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {payrollData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No payroll records for this month.</p>}
        </div>
      )}

      {/* ═══════ REPORT 8: Working Hours Audit ═══════ */}
      {reportType === 8 && (
        <div className="space-y-4">
          {/* Summary stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {WH_BANDS.map(b => (
              <div key={b.key} className={`rounded-xl border p-4 ${b.color} flex flex-col gap-1`}>
                <div className="text-xs font-semibold uppercase opacity-70">{b.label}</div>
                <div className="text-3xl font-bold">{whAuditStats[b.key] || 0}</div>
                <div className="text-xs opacity-60">shifts</div>
              </div>
            ))}
            <div className="rounded-xl border p-4 bg-purple-100 text-purple-700 flex flex-col gap-1">
              <div className="text-xs font-semibold uppercase opacity-70">🌙 Night Checkouts</div>
              <div className="text-3xl font-bold">{whAuditStats.nightCheckout || 0}</div>
              <div className="text-xs opacity-60">after {suspiciousHour}:00</div>
            </div>
            {whAuditStats.adminCorrected > 0 && (
              <div className="rounded-xl border p-4 bg-blue-100 text-blue-700 flex flex-col gap-1">
                <div className="text-xs font-semibold uppercase opacity-70">✏ Admin Corrected</div>
                <div className="text-3xl font-bold">{whAuditStats.adminCorrected}</div>
                <div className="text-xs opacity-60">records</div>
              </div>
            )}
          </div>

          {/* Risk notices */}
          {whAuditStats.suspicious > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4">
              <AlertTriangle className="text-red-500 mt-0.5 shrink-0" size={20} />
              <div>
                <div className="font-semibold text-red-700">⚠ Excessive Hours Detected</div>
                <div className="text-sm text-red-600 mt-0.5">
                  {whAuditStats.suspicious} shift{whAuditStats.suspicious > 1 ? 's' : ''} recorded more than 16 hours. May indicate employees kept session open to inflate hours. Review and correct in Attendance Log.
                </div>
              </div>
            </div>
          )}
          {whAuditStats.nightCheckout > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-purple-300 bg-purple-50 p-4">
              <AlertTriangle className="text-purple-500 mt-0.5 shrink-0" size={20} />
              <div>
                <div className="font-semibold text-purple-700">🌙 Night Checkouts Detected</div>
                <div className="text-sm text-purple-700 mt-0.5">
                  {whAuditStats.nightCheckout} checkout{whAuditStats.nightCheckout > 1 ? 's' : ''} recorded after {suspiciousHour}:00.
                  Example scenario: show ended at 1 PM, employee checked out at 11 PM. These are flagged for management review.
                  {whAuditStats.adminCorrected > 0 && ` (${whAuditStats.adminCorrected} already corrected by admin.)`}
                </div>
              </div>
            </div>
          )}

          {/* Per-employee summary table */}
          <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
            <div className="px-4 pt-4 pb-2 font-semibold text-slate-700 text-sm border-b">Employee-wise Breakdown</div>
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
                <th className="p-3">Employee</th>
                <th className="p-3 text-center">Total Shifts</th>
                <th className="p-3 text-center text-blue-700">&lt; 8 hrs</th>
                <th className="p-3 text-center text-green-700">8–12 hrs</th>
                <th className="p-3 text-center text-amber-700">12–16 hrs</th>
                <th className="p-3 text-center text-red-700">&gt; 16 hrs ⚠</th>
                <th className="p-3 text-center text-purple-700">🌙 Night</th>
              </tr></thead>
              <tbody>
                {whEmpSummary.map(e => (
                  <tr key={e.id} className={`border-b last:border-0 hover:bg-slate-50 ${e.suspicious > 0 || e.nightCheckout > 0 ? 'bg-red-50' : ''}`}>
                    <td className="p-3 font-medium">{e.name}</td>
                    <td className="p-3 text-center font-bold">{e.total}</td>
                    <td className="p-3 text-center text-blue-700">{e.under8 || '—'}</td>
                    <td className="p-3 text-center text-green-700">{e.normal || '—'}</td>
                    <td className="p-3 text-center text-amber-700">{e.extended || '—'}</td>
                    <td className="p-3 text-center">
                      {e.suspicious > 0
                        ? <span className="inline-flex items-center gap-1 font-bold text-red-600"><AlertTriangle size={13}/>{e.suspicious}</span>
                        : '—'}
                    </td>
                    <td className="p-3 text-center">
                      {e.nightCheckout > 0
                        ? <span className="font-bold text-purple-600">🌙 {e.nightCheckout}</span>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {whEmpSummary.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No completed shifts this month.</p>}
          </div>

          {/* Detailed records */}
          <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
            <div className="px-4 pt-4 pb-2 font-semibold text-slate-700 text-sm border-b">All Shift Records — Sorted by Hours (Descending)</div>
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
                <th className="p-3">Employee</th>
                <th className="p-3">Check In Date/Time</th>
                <th className="p-3">Check Out Date/Time</th>
                <th className="p-3 text-right">Hours</th>
                <th className="p-3">Hours Band</th>
                <th className="p-3">Project(s)</th>
                <th className="p-3">Checkout Flag</th>
                <th className="p-3">Location</th>
                <th className="p-3">Staff Reason</th>
              </tr></thead>
              <tbody>
                {workingHoursAuditData.map(r => {
                  const band = WH_BANDS.find(b => b.key === r.band);
                  const rowBg = r.isNightCheckout && !r.adminAdjusted ? 'bg-purple-50' : band?.row || '';
                  return (
                    <tr key={r.id} className={`border-b last:border-0 hover:brightness-95 ${rowBg}`}>
                      <td className="p-3 font-medium">{getEmpName(r.employeeId)}</td>
                      <td className="p-3 font-mono text-xs">{fmtDate(r.checkIn)} {fmtTime(r.checkIn)}</td>
                      <td className="p-3 font-mono text-xs">
                        <span className={r.isNightCheckout && !r.adminAdjusted ? 'text-purple-700 font-bold' : ''}>{fmtDate(r.checkOut)} {fmtTime(r.checkOut)}</span>
                        {r.adminAdjusted && <span className="ml-1 text-blue-500 text-xs" title={r.adminAdjustReason}>✏</span>}
                      </td>
                      <td className="p-3 text-right font-mono font-bold">{r.hrs.toFixed(1)}</td>
                      <td className="p-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${band?.badge || ''}`}>
                          {r.band === 'suspicious' && <span className="mr-1">⚠</span>}
                          {band?.label}
                        </span>
                      </td>
                      <td className="p-3 text-xs">
                        <div className="font-medium text-indigo-700 truncate max-w-[220px]" title={r.projectDisplayFull}>{r.projectDisplay}</div>
                        <div className="text-[11px] text-slate-500">{r.projectSource}</div>
                      </td>
                      <td className="p-3">
                        {r.adminAdjusted ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">✏ Corrected</span>
                        ) : r.isNightCheckout ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">🌙 Night ({r.checkoutHour}:00+)</span>
                        ) : r.lateCheckout ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">⚠ Late</span>
                        ) : (
                          <span className="text-xs text-slate-400">Normal</span>
                        )}
                      </td>
                      <td className="p-3 text-xs">{r.location || '—'}</td>
                      <td className="p-3 text-xs text-slate-500 max-w-[160px] truncate" title={r.lateCheckoutReason}>{r.lateCheckoutReason || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {workingHoursAuditData.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No completed shifts for this period.</p>}
          </div>
        </div>
      )}

      {/* ═══════ REPORT 9: Employee Financial Performance ═══════ */}
      {reportType === PERFORMANCE_REPORT_INDEX && (
        <div className="space-y-4">
          {!performanceRange.valid && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">
              Invalid custom period. Please select a valid start and end date.
            </div>
          )}

          {performanceRange.valid && (
            <>
              <div className="text-sm text-slate-500">Analyzing period: <span className="font-semibold text-slate-700">{performanceRange.label}</span></div>

              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="rounded-xl border bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Employees Ranked</div>
                  <div className="mt-1 text-2xl font-bold text-slate-800">{performanceSummary.employeeCount}</div>
                </div>
                <div className="rounded-xl border bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Realized Revenue</div>
                  <div className="mt-1 text-xl font-bold text-slate-800">{formatCurrency(performanceSummary.totals.realizedRevenue)}</div>
                </div>
                <div className="rounded-xl border bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Employee Cost</div>
                  <div className="mt-1 text-xl font-bold text-slate-800">{formatCurrency(performanceSummary.totals.totalCost)}</div>
                </div>
                <div className="rounded-xl border bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Net Benefit</div>
                  <div className={`mt-1 text-xl font-bold ${performanceSummary.totals.netBenefit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {formatCurrency(performanceSummary.totals.netBenefit)}
                  </div>
                </div>
                <div className="rounded-xl border bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Top Performer</div>
                  <div className="mt-1 text-sm font-semibold text-slate-800 truncate">{performanceSummary.topPerformer?.name || '-'}</div>
                  {performanceSummary.topPerformer && (
                    <div className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${performanceSummary.topPerformer.netBenefit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {performanceSummary.topPerformer.netBenefit >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {formatCurrency(performanceSummary.topPerformer.netBenefit)}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border bg-white shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-slate-500 uppercase bg-slate-50">
                      <th className="p-3">Rank</th>
                      <th className="p-3">Employee</th>
                      <th className="p-3 text-right">Completed</th>
                      <th className="p-3 text-right">Participated</th>
                      <th className="p-3 text-right">Expense Reports</th>
                      <th className="p-3 text-right">Realized Revenue</th>
                      <th className="p-3 text-right">Employee Cost</th>
                      <th className="p-3 text-right">Net Benefit</th>
                      <th className="p-3 text-right">ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performanceRows.map((row) => {
                      const selected = selectedPerformanceEmployeeData?.id === row.id;
                      return (
                        <tr
                          key={row.id}
                          onClick={() => setPerformanceSelectedEmployee(row.id)}
                          className={`border-b last:border-0 cursor-pointer hover:bg-slate-50 ${selected ? 'bg-indigo-50/70' : ''}`}
                        >
                          <td className="p-3 font-semibold">#{row.placement}</td>
                          <td className="p-3">
                            <div className="font-medium text-slate-800">{row.name}</div>
                            <div className="text-xs text-slate-500 capitalize">{row.role || '-'}</div>
                          </td>
                          <td className="p-3 text-right">
                            <div className="font-semibold text-slate-800">{row.completedProjects}</div>
                            <div className="text-xs text-slate-500">Solo {row.soloCompletedProjects} / Team {row.teamCompletedProjects}</div>
                          </td>
                          <td className="p-3 text-right font-medium">{row.participatedProjects}</td>
                          <td className="p-3 text-right font-medium">{row.expenseReportCount}</td>
                          <td className="p-3 text-right font-mono">{formatCurrency(row.realizedRevenue)}</td>
                          <td className="p-3 text-right font-mono">{formatCurrency(row.totalEmployeeCost)}</td>
                          <td className={`p-3 text-right font-mono font-semibold ${row.netBenefit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{formatCurrency(row.netBenefit)}</td>
                          <td className="p-3 text-right font-mono">{row.roiPct == null ? '-' : `${row.roiPct}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {performanceRows.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No employee performance data in this period.</p>}
              </div>

              {selectedPerformanceEmployeeData && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border bg-white shadow-sm p-4 space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-700">Project Contribution — {selectedPerformanceEmployeeData.name}</h3>
                      <p className="text-xs text-slate-500 mt-1">Revenue from each project is split equally among assigned team members.</p>
                    </div>

                    <div>
                      <div className="text-xs font-semibold uppercase text-slate-500 mb-2">Completed Projects</div>
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {selectedPerformanceProjects.completed.map((p) => (
                          <div key={`completed-${p.id}`} className="rounded border border-slate-200 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium text-slate-800 truncate">{p.name}</div>
                              <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">{p.status}</span>
                            </div>
                            <div className="mt-1 text-xs text-slate-500">Team Size: {p.teamSize} • Date: {p.endDate ? fmtDate(p.endDate.toISOString()) : '-'}</div>
                            <div className="mt-1 text-sm font-semibold text-slate-700">Share: {formatCurrency(p.revenueShare)}</div>
                          </div>
                        ))}
                        {selectedPerformanceProjects.completed.length === 0 && <div className="text-sm text-slate-400">No completed projects in this period.</div>}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-semibold uppercase text-slate-500 mb-2">Active / Participating Projects</div>
                      <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                        {selectedPerformanceProjects.active.map((p) => (
                          <div key={`active-${p.id}`} className="rounded border border-slate-200 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium text-slate-800 truncate">{p.name}</div>
                              <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">{p.status}</span>
                            </div>
                            <div className="mt-1 text-xs text-slate-500">Team Size: {p.teamSize} • Date: {p.startDate ? fmtDate(p.startDate.toISOString()) : '-'}</div>
                            <div className="mt-1 text-sm font-semibold text-slate-700">Pipeline Share: {formatCurrency(p.revenueShare)}</div>
                          </div>
                        ))}
                        {selectedPerformanceProjects.active.length === 0 && <div className="text-sm text-slate-400">No active project participation in this period.</div>}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border bg-white shadow-sm p-4 space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-700">Expense Reports and Financial Impact</h3>
                      <p className="text-xs text-slate-500 mt-1">Net benefit = Realized Revenue Share − (Labor Cost + Approved Expense Reports)</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div className="rounded border border-slate-200 p-3">
                        <div className="text-xs text-slate-500 uppercase">Expense Reports</div>
                        <div className="text-lg font-semibold text-slate-800">{selectedPerformanceEmployeeData.expenseReportCount}</div>
                        <div className="text-xs text-slate-500 mt-1">Approved {selectedPerformanceEmployeeData.approvedExpenseCount}</div>
                      </div>
                      <div className="rounded border border-slate-200 p-3">
                        <div className="text-xs text-slate-500 uppercase">Approved Expenses</div>
                        <div className="text-lg font-semibold text-slate-800">{formatCurrency(selectedPerformanceEmployeeData.approvedExpenses)}</div>
                        <div className="text-xs text-slate-500 mt-1">Pending {formatCurrency(selectedPerformanceEmployeeData.pendingExpenses)}</div>
                      </div>
                      <div className="rounded border border-slate-200 p-3">
                        <div className="text-xs text-slate-500 uppercase">Labor Cost</div>
                        <div className="text-lg font-semibold text-slate-800">{formatCurrency(selectedPerformanceEmployeeData.laborCost)}</div>
                        <div className="text-xs text-slate-500 mt-1 capitalize">Source: {selectedPerformanceEmployeeData.costSource}</div>
                      </div>
                      <div className="rounded border border-slate-200 p-3">
                        <div className="text-xs text-slate-500 uppercase">Cash Outflow</div>
                        <div className="text-lg font-semibold text-slate-800">{formatCurrency(selectedPerformanceEmployeeData.cashOutflow)}</div>
                        <div className="text-xs text-slate-500 mt-1">Payout {formatCurrency(selectedPerformanceEmployeeData.cashPayouts)} + Advance {formatCurrency(selectedPerformanceEmployeeData.cashAdvances)}</div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Realized Revenue Share</span>
                        <span className="font-semibold text-slate-800">{formatCurrency(selectedPerformanceEmployeeData.realizedRevenue)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-sm">
                        <span className="text-slate-500">Total Employee Cost</span>
                        <span className="font-semibold text-slate-800">{formatCurrency(selectedPerformanceEmployeeData.totalEmployeeCost)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-sm">
                        <span className="text-slate-500">Pipeline Revenue Share</span>
                        <span className="font-semibold text-slate-800">{formatCurrency(selectedPerformanceEmployeeData.pipelineRevenue)}</span>
                      </div>
                      <div className="mt-3 pt-3 border-t border-slate-200 flex items-center justify-between">
                        <span className="font-medium text-slate-700">Net Benefit</span>
                        <span className={`text-lg font-bold ${selectedPerformanceEmployeeData.netBenefit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {formatCurrency(selectedPerformanceEmployeeData.netBenefit)}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500 text-right">ROI: {selectedPerformanceEmployeeData.roiPct == null ? '-' : `${selectedPerformanceEmployeeData.roiPct}%`}</div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default HRReports;
