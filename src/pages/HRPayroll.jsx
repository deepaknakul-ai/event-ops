import React, { useState, useMemo, useCallback } from 'react';
import { DollarSign, Search, Download, FileText, CheckCircle, Clock, AlertTriangle, Users, Filter } from 'lucide-react';
import { addDoc, updateDoc, doc, collection, deleteDoc } from 'firebase/firestore';
import { getLogHours, getHourlyRateForDate } from '../utils/helpers';
import { can } from '../utils/permissions';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const HRPayroll = ({ employees = [], timeLogs = [], penalties = [], payroll = [], role, db, appId, logAction, addToast }) => {
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const activeEmployees = useMemo(() => employees.filter(e => e.status !== 'Inactive'), [employees]);

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e])), [employees]);
  const getEmpName = useCallback((id) => empMap[id]?.name || id?.slice(0, 8), [empMap]);

  // Existing payroll records for selected month
  const monthPayroll = useMemo(() =>
    payroll.filter(p => p.month === selectedMonth && p.year === selectedYear),
    [payroll, selectedMonth, selectedYear]
  );
  const payrollMap = useMemo(() => Object.fromEntries(monthPayroll.map(p => [p.employeeId, p])), [monthPayroll]);

  // Calculate hours and pay for each active employee
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const payrollData = useMemo(() => {
    const monthStart = new Date(selectedYear, selectedMonth - 1, 1);
    const monthEnd = new Date(selectedYear, selectedMonth, 0, 23, 59, 59);
    const round2 = (value) => Number(Number(value || 0).toFixed(2));

    return activeEmployees.map(emp => {
      const existing = payrollMap[emp.id];

      // Calculate from timeLogs
      const empLogs = timeLogs.filter(l => {
        const d = new Date(l.checkIn);
        return l.employeeId === emp.id && d >= monthStart && d <= monthEnd;
      });
      const totalHours = round2(empLogs.reduce((s, l) => s + getLogHours(l), 0));

      const empPenalties = penalties.filter(p => {
        const d = new Date(p.appliedAt || p.createdAt || Date.now());
        return p.employeeId === emp.id && d >= monthStart && d <= monthEnd;
      });
      const penaltyMinutes = empPenalties.reduce((s, p) => s + Number(p.minutes || 0), 0);
      const penaltyHours = round2(penaltyMinutes / 60);
      const netHours = Math.max(0, round2(totalHours - penaltyHours));

      const rateBucketsMap = {};
      const grossFromLogs = round2(empLogs.reduce((sum, log) => {
        const hours = getLogHours(log);
        if (hours <= 0) return sum;
        const hourlyRate = Number(getHourlyRateForDate(emp, log.checkIn || monthStart) || 0);
        const bucketKey = hourlyRate.toFixed(2);
        rateBucketsMap[bucketKey] = (rateBucketsMap[bucketKey] || 0) + hours;
        return sum + (hours * hourlyRate);
      }, 0));

      const fallbackRate = Number(getHourlyRateForDate(emp, monthStart) || 0);
      const hourlyRate = totalHours > 0 ? round2(grossFromLogs / totalHours) : round2(fallbackRate);
      const penaltyValue = round2(penaltyHours * hourlyRate);
      const grossPayComputed = Math.max(0, round2(grossFromLogs - penaltyValue));

      const rateBreakdown = Object.entries(rateBucketsMap)
        .map(([rate, hours]) => {
          const parsedRate = Number(rate);
          const roundedHours = round2(hours);
          return {
            hourlyRate: parsedRate,
            hours: roundedHours,
            pay: round2(parsedRate * roundedHours),
          };
        })
        .sort((a, b) => a.hourlyRate - b.hourlyRate);

      const targetHours = Number(emp.monthlyTargetHours || 160);
      const standardHours = Math.min(netHours, targetHours);
      const overtimeHours = Math.max(0, netHours - targetHours);
      const deductions = Number(existing?.deductions || 0);
      const netPayComputed = round2(grossPayComputed - deductions);
      const shifts = empLogs.length;
      const daysWorked = new Set(empLogs.map(l => new Date(l.checkIn).toDateString())).size;
      const calculated = {
        totalHours,
        penaltyMinutes,
        penaltyHours,
        netHours,
        hourlyRate,
        targetHours,
        standardHours,
        overtimeHours,
        grossPay: grossPayComputed,
        deductions,
        netPay: netPayComputed,
        shifts,
        daysWorked,
        compliance: targetHours > 0 ? Math.round((netHours / targetHours) * 100) : 0,
        rateMode: 'history-aware',
        rateBreakdown,
      };

      if (existing) {
        const storedTargetHours = Number(existing.targetHours ?? targetHours);
        const storedNetHours = Number(existing.netHours ?? netHours);
        const storedGrossPay = round2(existing.grossPay ?? grossPayComputed);
        const storedDeductions = round2(existing.deductions ?? deductions);
        const storedNetPay = round2(existing.netPay ?? (storedGrossPay - storedDeductions));
        const storedHourlyRate = round2(existing.hourlyRate ?? hourlyRate);

        return {
          employeeId: emp.id,
          name: emp.name,
          totalHours: round2(existing.totalHours ?? totalHours),
          penaltyMinutes: Number(existing.penaltyMinutes ?? penaltyMinutes),
          penaltyHours: round2(existing.penaltyHours ?? penaltyHours),
          netHours: storedNetHours,
          hourlyRate: storedHourlyRate,
          targetHours: storedTargetHours,
          standardHours: round2(existing.standardHours ?? Math.min(storedNetHours, storedTargetHours)),
          overtimeHours: round2(existing.overtimeHours ?? Math.max(0, storedNetHours - storedTargetHours)),
          grossPay: storedGrossPay,
          deductions: storedDeductions,
          netPay: storedNetPay,
          shifts: Number(existing.shifts ?? shifts),
          daysWorked: Number(existing.daysWorked ?? daysWorked),
          status: existing.status || 'Draft',
          payrollId: existing.id || null,
          compliance: storedTargetHours > 0 ? Math.round((storedNetHours / storedTargetHours) * 100) : 0,
          rateMode: existing.rateMode || 'flat',
          rateBreakdown: Array.isArray(existing.rateBreakdown) && existing.rateBreakdown.length > 0 ? existing.rateBreakdown : rateBreakdown,
          isHistoricalRateApplied: (existing.rateMode || 'flat') === 'history-aware',
          calculated,
        };
      }

      return {
        employeeId: emp.id,
        name: emp.name,
        totalHours,
        penaltyMinutes,
        penaltyHours,
        netHours,
        hourlyRate,
        targetHours,
        standardHours,
        overtimeHours,
        grossPay: grossPayComputed,
        deductions,
        netPay: netPayComputed,
        shifts,
        daysWorked,
        status: existing?.status || 'Not Generated',
        payrollId: existing?.id || null,
        compliance: targetHours > 0 ? Math.round((netHours / targetHours) * 100) : 0,
        rateMode: 'history-aware',
        rateBreakdown,
        isHistoricalRateApplied: rateBreakdown.length > 1,
        calculated,
      };
    });
  }, [activeEmployees, timeLogs, penalties, payrollMap, selectedYear, selectedMonth]);

  // Filtered list
  const filtered = useMemo(() => {
    let list = [...payrollData];
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(p => getEmpName(p.employeeId).toLowerCase().includes(s));
    }
    if (filterStatus) list = list.filter(p => p.status === filterStatus);
    return list.sort((a, b) => b.netHours - a.netHours);
  }, [payrollData, search, filterStatus, getEmpName]);

  // Summary stats
  const stats = useMemo(() => ({
    totalGross: filtered.reduce((s, p) => s + p.grossPay, 0),
    totalNet: filtered.reduce((s, p) => s + p.netPay, 0),
    totalHours: filtered.reduce((s, p) => s + p.netHours, 0),
    generated: filtered.filter(p => p.status !== 'Not Generated').length,
    finalized: filtered.filter(p => p.status === 'Finalized').length,
  }), [filtered]);

  // ── Generate payroll for one employee ──
  const handleGenerate = async (row) => {
    if (!can(role, 'hr_payroll', 'generate')) return addToast('Access denied', 'error');
    try {
      const source = row.calculated || row;
      const data = {
        employeeId: row.employeeId,
        month: selectedMonth,
        year: selectedYear,
        totalHours: source.totalHours,
        penaltyMinutes: source.penaltyMinutes,
        penaltyHours: source.penaltyHours,
        netHours: source.netHours,
        hourlyRate: source.hourlyRate,
        targetHours: source.targetHours,
        standardHours: source.standardHours,
        overtimeHours: source.overtimeHours,
        grossPay: source.grossPay,
        deductions: source.deductions,
        netPay: source.netPay,
        shifts: source.shifts,
        daysWorked: source.daysWorked,
        compliance: source.compliance,
        rateMode: source.rateMode || 'history-aware',
        rateBreakdown: source.rateBreakdown || [],
        status: 'Draft',
        generatedBy: role,
        generatedAt: new Date().toISOString(),
      };
      if (row.payrollId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payroll', row.payrollId), data);
        logAction('payroll', 'update', row.payrollId, data, `Re-generated payroll for ${row.name}`);
      } else {
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payroll'), data);
        logAction('payroll', 'create', ref.id, data, `Generated payroll for ${row.name}`);
      }
      addToast(`Payroll generated for ${row.name}`, 'success');
    } catch (e) { console.error(e); addToast('Error generating payroll', 'error'); }
  };

  // ── Generate All ──
  const handleGenerateAll = async () => {
    if (!can(role, 'hr_payroll', 'generate')) return addToast('Access denied', 'error');
    if (!confirm(`Generate payroll for all ${activeEmployees.length} employees for ${MONTHS[selectedMonth - 1]} ${selectedYear}?`)) return;
    let count = 0;
    for (const row of payrollData) {
      try {
        const source = row.calculated || row;
        const data = {
          employeeId: row.employeeId,
          month: selectedMonth,
          year: selectedYear,
          totalHours: source.totalHours,
          penaltyMinutes: source.penaltyMinutes,
          penaltyHours: source.penaltyHours,
          netHours: source.netHours,
          hourlyRate: source.hourlyRate,
          targetHours: source.targetHours,
          standardHours: source.standardHours,
          overtimeHours: source.overtimeHours,
          grossPay: source.grossPay,
          deductions: source.deductions,
          netPay: source.netPay,
          shifts: source.shifts,
          daysWorked: source.daysWorked,
          compliance: source.compliance,
          rateMode: source.rateMode || 'history-aware',
          rateBreakdown: source.rateBreakdown || [],
          status: 'Draft',
          generatedBy: role,
          generatedAt: new Date().toISOString(),
        };
        if (row.payrollId) {
          await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payroll', row.payrollId), data);
        } else {
          await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payroll'), data);
        }
        count++;
      } catch (e) { console.error(e); }
    }
    logAction('payroll', 'bulk_generate', null, { month: selectedMonth, year: selectedYear, count }, `Bulk generated payroll for ${count} employees`);
    addToast(`Payroll generated for ${count} employees`, 'success');
  };

  // ── Finalize ──
  const handleFinalize = async (row) => {
    if (!can(role, 'hr_payroll', 'generate')) return addToast('Access denied', 'error');
    if (!row.payrollId) return addToast('Generate payroll first', 'error');
    if (!confirm(`Finalize payroll for ${row.name}? This marks it as approved.`)) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payroll', row.payrollId), {
        status: 'Finalized',
        finalizedBy: role,
        finalizedAt: new Date().toISOString(),
      });
      logAction('payroll', 'finalize', row.payrollId, null, `Finalized payroll for ${row.name}`);
      addToast(`Payroll finalized for ${row.name}`, 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // ── Delete ──
  const handleDelete = async (row) => {
    if (!can(role, 'hr_payroll', 'generate')) return addToast('Access denied', 'error');
    if (!row.payrollId) return;
    if (row.status === 'Finalized') return addToast('Cannot delete finalized payroll', 'error');
    if (!confirm(`Delete payroll record for ${row.name}?`)) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'payroll', row.payrollId));
      logAction('payroll', 'delete', row.payrollId, null, `Deleted payroll for ${row.name}`);
      addToast('Deleted', 'success');
    } catch (e) { console.error(e); addToast('Error', 'error'); }
  };

  // ── Payslip PDF ──
  const generatePayslip = (row) => {
    const emp = empMap[row.employeeId];
    const pdf = new jsPDF();
    const monthLabel = `${MONTHS[selectedMonth - 1]} ${selectedYear}`;
    const rateModeLabel = row.isHistoricalRateApplied ? 'History-based blended' : 'Flat rate';
    const rateBreakdownText = Array.isArray(row.rateBreakdown)
      ? row.rateBreakdown
          .map((b) => `Rs ${Number(b.hourlyRate || 0).toFixed(2)} x ${Number(b.hours || 0).toFixed(2)}h`)
          .join(' | ')
      : '';

    // Header
    pdf.setFontSize(18);
    pdf.setFont('helvetica', 'bold');
    pdf.text('PAYSLIP', 14, 22);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100);
    pdf.text(monthLabel, 14, 30);
    pdf.setTextColor(0);

    // Employee info
    pdf.setFontSize(11);
    pdf.text(`Employee: ${emp?.name || row.employeeId}`, 14, 44);
    pdf.text(`Designation: ${emp?.designation || '-'}`, 14, 52);
    pdf.text(`Hourly Rate: ₹${row.hourlyRate}`, 120, 44);
    pdf.text(`Target Hours: ${row.targetHours}h`, 120, 52);
    pdf.text(`Rate Mode: ${rateModeLabel}`, 120, 60);

    // Main table
    autoTable(pdf, {
      startY: 68,
      head: [['Description', 'Value']],
      body: [
        ['Total Hours Worked', `${row.totalHours}h`],
        ['Penalty Deduction', `−${row.penaltyHours}h (${row.penaltyMinutes} min)`],
        ['Net Hours', `${row.netHours}h`],
        ['Standard Hours', `${row.standardHours}h`],
        ['Overtime Hours', `${row.overtimeHours}h`],
        ['', ''],
        ['Gross Pay', `₹${row.grossPay.toFixed(2)}`],
        ['Deductions', `₹${row.deductions.toFixed(2)}`],
        ['Net Pay', `₹${row.netPay.toFixed(2)}`],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 23, 42] },
      styles: { fontSize: 10 },
    });

    // Attendance summary
    const finalY = pdf.lastAutoTable.finalY + 12;
    pdf.setFontSize(9);
    pdf.setTextColor(100);
    pdf.text(`Shifts: ${row.shifts} | Days Worked: ${row.daysWorked} | Compliance: ${row.compliance}%`, 14, finalY);
    pdf.text(`Status: ${row.status}`, 14, finalY + 8);
    pdf.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, 14, finalY + 16);
    if (rateBreakdownText) {
      const breakdownLines = pdf.splitTextToSize(`Rate Breakdown: ${rateBreakdownText}`, 180);
      pdf.text(breakdownLines, 14, finalY + 24);
    }

    pdf.save(`Payslip_${(emp?.name || 'emp').replace(/\s+/g, '_')}_${selectedYear}_${String(selectedMonth).padStart(2, '0')}.pdf`);
    addToast('Payslip downloaded', 'success');
  };

  // ── Excel Export ──
  const exportExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TERMS HR Module';
    workbook.created = new Date();

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 25 },
      { header: 'Value', key: 'value', width: 20 },
    ];
    summarySheet.addRows([
      { metric: 'Month', value: `${MONTHS[selectedMonth - 1]} ${selectedYear}` },
      { metric: 'Total Employees', value: filtered.length },
      { metric: 'Total Gross Pay', value: `₹${stats.totalGross.toFixed(2)}` },
      { metric: 'Total Net Pay', value: `₹${stats.totalNet.toFixed(2)}` },
      { metric: 'Total Hours', value: stats.totalHours.toFixed(2) },
      { metric: 'Generated', value: stats.generated },
      { metric: 'Finalized', value: stats.finalized },
    ]);
    summarySheet.getRow(1).font = { bold: true };

    // Payroll Detail sheet
    const detailSheet = workbook.addWorksheet('Payroll Detail');
    detailSheet.columns = [
      { header: 'Employee', key: 'name', width: 22 },
      { header: 'Total Hours', key: 'totalHours', width: 14 },
      { header: 'Penalty (min)', key: 'penaltyMinutes', width: 14 },
      { header: 'Net Hours', key: 'netHours', width: 12 },
      { header: 'Std Hours', key: 'standardHours', width: 12 },
      { header: 'OT Hours', key: 'overtimeHours', width: 12 },
      { header: 'Rate/Hr', key: 'hourlyRate', width: 10 },
      { header: 'Rate Mode', key: 'rateMode', width: 14 },
      { header: 'Gross Pay', key: 'grossPay', width: 14 },
      { header: 'Deductions', key: 'deductions', width: 14 },
      { header: 'Net Pay', key: 'netPay', width: 14 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Compliance %', key: 'compliance', width: 14 },
      { header: 'Days Worked', key: 'daysWorked', width: 12 },
      { header: 'Shifts', key: 'shifts', width: 10 },
    ];
    filtered.forEach(row => {
      detailSheet.addRow({
        name: getEmpName(row.employeeId),
        totalHours: row.totalHours,
        penaltyMinutes: row.penaltyMinutes,
        netHours: row.netHours,
        standardHours: row.standardHours,
        overtimeHours: row.overtimeHours,
        hourlyRate: row.hourlyRate,
        rateMode: row.isHistoricalRateApplied ? 'History-aware' : 'Flat',
        grossPay: row.grossPay,
        deductions: row.deductions,
        netPay: row.netPay,
        status: row.status,
        compliance: row.compliance,
        daysWorked: row.daysWorked,
        shifts: row.shifts,
      });
    });
    detailSheet.getRow(1).font = { bold: true };
    detailSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Payroll_${MONTHS[selectedMonth - 1]}_${selectedYear}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('Excel exported', 'success');
  };

  // ── PDF Export ──
  const exportPDF = () => {
    const pdf = new jsPDF({ orientation: 'landscape' });
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`Payroll Report — ${MONTHS[selectedMonth - 1]} ${selectedYear}`, 14, 18);
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Generated: ${new Date().toLocaleString('en-IN')} | Employees: ${filtered.length} | Total Net: ₹${stats.totalNet.toFixed(2)}`, 14, 26);

    autoTable(pdf, {
      startY: 32,
      head: [['Employee', 'Total Hrs', 'Penalty', 'Net Hrs', 'Rate/Hr', 'Gross', 'Deductions', 'Net Pay', 'Status', 'Compliance']],
      body: filtered.map(r => [
        getEmpName(r.employeeId),
        r.totalHours, `${r.penaltyHours}h`, r.netHours,
        `₹${r.hourlyRate}`, `₹${r.grossPay.toFixed(2)}`, `₹${r.deductions.toFixed(2)}`, `₹${r.netPay.toFixed(2)}`,
        r.status, `${r.compliance}%`,
      ]),
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], fontSize: 8 },
      styles: { fontSize: 7 },
      foot: [['TOTAL', stats.totalHours.toFixed(2), '', '', '', `₹${stats.totalGross.toFixed(2)}`, '', `₹${stats.totalNet.toFixed(2)}`, '', '']],
      footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' },
    });

    pdf.save(`Payroll_Report_${MONTHS[selectedMonth - 1]}_${selectedYear}.pdf`);
    addToast('PDF exported', 'success');
  };

  const statusBadge = (status) => {
    const colors = {
      'Finalized': 'bg-green-100 text-green-700',
      'Draft': 'bg-amber-100 text-amber-700',
      'Not Generated': 'bg-slate-100 text-slate-500',
    };
    return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${colors[status] || colors['Not Generated']}`}>{status}</span>;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-slate-800">Payroll Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">{MONTHS[selectedMonth - 1]} {selectedYear} — {activeEmployees.length} employees</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can(role, 'hr_payroll', 'generate') && (
            <button onClick={handleGenerateAll} className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors">
              <Users size={14} /> Generate All
            </button>
          )}
          <button onClick={exportPDF} className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors">
            <FileText size={14} /> PDF
          </button>
          <button onClick={exportExcel} className="flex items-center gap-1.5 px-3 py-2 bg-green-50 text-green-700 rounded-lg text-xs font-bold hover:bg-green-100 transition-colors">
            <Download size={14} /> Excel
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-[10px] font-medium text-slate-500 uppercase">Total Gross</p>
          <p className="text-xl font-bold text-indigo-600 mt-1">₹{stats.totalGross.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-[10px] font-medium text-slate-500 uppercase">Total Net Pay</p>
          <p className="text-xl font-bold text-green-600 mt-1">₹{stats.totalNet.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-[10px] font-medium text-slate-500 uppercase">Total Hours</p>
          <p className="text-xl font-bold text-blue-600 mt-1">{stats.totalHours.toFixed(1)}h</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-[10px] font-medium text-slate-500 uppercase">Generated</p>
          <p className="text-xl font-bold text-amber-600 mt-1">{stats.generated}/{filtered.length}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-[10px] font-medium text-slate-500 uppercase">Finalized</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">{stats.finalized}/{filtered.length}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 p-3 bg-white border rounded-xl shadow-sm">
        <select value={selectedMonth} onChange={e => setSelectedMonth(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-xs font-bold bg-white">
          {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-xs font-bold bg-white">
          {[selectedYear - 1, selectedYear, selectedYear + 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="flex items-center gap-1.5 border rounded-lg px-2 py-1.5 flex-1 min-w-[160px]">
          <Search size={14} className="text-slate-400" />
          <input type="text" placeholder="Search employee..." value={search} onChange={e => setSearch(e.target.value)} className="bg-transparent outline-none text-xs w-full" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border rounded-lg px-3 py-2 text-xs font-bold bg-white">
          <option value="">All Status</option>
          <option value="Not Generated">Not Generated</option>
          <option value="Draft">Draft</option>
          <option value="Finalized">Finalized</option>
        </select>
      </div>

      {/* Payroll Table */}
      <div className="bg-white border rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-slate-50 text-slate-500 text-[10px] font-semibold uppercase">
              <th className="p-3 text-left">Employee</th>
              <th className="p-3 text-right">Total Hrs</th>
              <th className="p-3 text-right">Penalty</th>
              <th className="p-3 text-right">Net Hrs</th>
              <th className="p-3 text-right">Rate/Hr</th>
              <th className="p-3 text-right">Gross</th>
              <th className="p-3 text-right">Deductions</th>
              <th className="p-3 text-right">Net Pay</th>
              <th className="p-3 text-center">Compliance</th>
              <th className="p-3 text-center">Status</th>
              <th className="p-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(row => (
              <tr key={row.employeeId} className="border-b hover:bg-slate-50/50 transition-colors">
                <td className="p-3 font-bold text-slate-800">{getEmpName(row.employeeId)}</td>
                <td className="p-3 text-right text-slate-600">{row.totalHours}</td>
                <td className="p-3 text-right text-red-500">{row.penaltyHours > 0 ? `−${row.penaltyHours}h` : '—'}</td>
                <td className="p-3 text-right font-semibold text-slate-700">{row.netHours}</td>
                <td className="p-3 text-right text-slate-500">
                  <div>₹{Number(row.hourlyRate || 0).toFixed(2)}</div>
                  {row.isHistoricalRateApplied && <div className="text-[10px] text-indigo-600">Blended</div>}
                </td>
                <td className="p-3 text-right text-slate-600">₹{row.grossPay.toFixed(2)}</td>
                <td className="p-3 text-right text-red-500">{row.deductions > 0 ? `₹${row.deductions.toFixed(2)}` : '—'}</td>
                <td className="p-3 text-right font-bold text-green-700">₹{row.netPay.toFixed(2)}</td>
                <td className="p-3 text-center">
                  <span className={`text-[10px] font-bold ${row.compliance >= 100 ? 'text-green-600' : row.compliance >= 80 ? 'text-amber-600' : 'text-red-600'}`}>
                    {row.compliance}%
                  </span>
                </td>
                <td className="p-3 text-center">{statusBadge(row.status)}</td>
                <td className="p-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {can(role, 'hr_payroll', 'generate') && (
                      <button onClick={() => handleGenerate(row)} title="Generate / Recalculate" className="p-1.5 rounded-lg hover:bg-indigo-50 text-indigo-600 transition-colors">
                        <Clock size={14} />
                      </button>
                    )}
                    {row.payrollId && row.status === 'Draft' && can(role, 'hr_payroll', 'generate') && (
                      <button onClick={() => handleFinalize(row)} title="Finalize" className="p-1.5 rounded-lg hover:bg-green-50 text-green-600 transition-colors">
                        <CheckCircle size={14} />
                      </button>
                    )}
                    <button onClick={() => generatePayslip(row)} title="Download Payslip" className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors">
                      <FileText size={14} />
                    </button>
                    {row.payrollId && row.status !== 'Finalized' && can(role, 'hr_payroll', 'generate') && (
                      <button onClick={() => handleDelete(row)} title="Delete" className="p-1.5 rounded-lg hover:bg-red-50 text-red-600 transition-colors">
                        <AlertTriangle size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-bold text-slate-800 border-t-2">
              <td className="p-3">TOTAL ({filtered.length})</td>
              <td className="p-3 text-right">{stats.totalHours.toFixed(2)}</td>
              <td className="p-3"></td>
              <td className="p-3"></td>
              <td className="p-3"></td>
              <td className="p-3 text-right">₹{stats.totalGross.toFixed(2)}</td>
              <td className="p-3"></td>
              <td className="p-3 text-right text-green-700">₹{stats.totalNet.toFixed(2)}</td>
              <td className="p-3"></td>
              <td className="p-3"></td>
              <td className="p-3"></td>
            </tr>
          </tfoot>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm">No payroll data for the selected period</div>
        )}
      </div>
    </div>
  );
};

export default HRPayroll;
