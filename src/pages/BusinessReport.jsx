import React, { useState, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';
import {
  FileText, Download, Calendar, TrendingUp, Package,
  Users, Receipt, BarChart3, Building2
} from 'lucide-react';
import {
  formatCurrency, formatCurrencyPDF, getProjectGrandTotal, getEffectivePOCost, fmtDate, sumLogisticsRecord
} from '../utils/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const isExcluded = (status) => status === 'Rejected' || status === 'Disapproved';

const toDateEnd = (d) => { const e = new Date(d); e.setHours(23, 59, 59, 999); return e; };

const getDateRange = (preset, customStart, customEnd) => {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-indexed

  if (preset === 'custom') {
    if (!customStart || !customEnd) return { start: null, end: null };
    return { start: new Date(customStart), end: toDateEnd(customEnd) };
  }

  if (preset === 'this_month') return { start: new Date(y, m, 1), end: toDateEnd(new Date(y, m + 1, 0)) };
  if (preset === 'last_month') return { start: new Date(y, m - 1, 1), end: toDateEnd(new Date(y, m, 0)) };

  // Indian financial year starts April (month index 3)
  const fyStart = m >= 3 ? y : y - 1;

  if (preset === 'q1_fy') return { start: new Date(fyStart, 3, 1),     end: toDateEnd(new Date(fyStart, 5, 30)) };
  if (preset === 'q2_fy') return { start: new Date(fyStart, 6, 1),     end: toDateEnd(new Date(fyStart, 8, 30)) };
  if (preset === 'q3_fy') return { start: new Date(fyStart, 9, 1),     end: toDateEnd(new Date(fyStart, 11, 31)) };
  if (preset === 'q4_fy') return { start: new Date(fyStart + 1, 0, 1), end: toDateEnd(new Date(fyStart + 1, 2, 31)) };
  if (preset === 'h1_fy') return { start: new Date(fyStart, 3, 1),     end: toDateEnd(new Date(fyStart, 8, 30)) };
  if (preset === 'h2_fy') return { start: new Date(fyStart, 9, 1),     end: toDateEnd(new Date(fyStart + 1, 2, 31)) };
  if (preset === 'full_fy') return { start: new Date(fyStart, 3, 1),   end: toDateEnd(new Date(fyStart + 1, 2, 31)) };

  return { start: new Date(y, m, 1), end: toDateEnd(new Date(y, m + 1, 0)) };
};

const PRESET_BUTTONS = [
  { value: 'this_month', label: 'This Month',     group: 'Monthly' },
  { value: 'last_month', label: 'Last Month',     group: 'Monthly' },
  { value: 'q1_fy',      label: 'Q1 Apr–Jun',     group: 'Quarterly' },
  { value: 'q2_fy',      label: 'Q2 Jul–Sep',     group: 'Quarterly' },
  { value: 'q3_fy',      label: 'Q3 Oct–Dec',     group: 'Quarterly' },
  { value: 'q4_fy',      label: 'Q4 Jan–Mar',     group: 'Quarterly' },
  { value: 'h1_fy',      label: 'H1 Apr–Sep',     group: 'Bi-Annual' },
  { value: 'h2_fy',      label: 'H2 Oct–Mar',     group: 'Bi-Annual' },
  { value: 'full_fy',    label: 'Full FY',         group: 'Annual' },
  { value: 'custom',     label: 'Custom Range',    group: 'Custom' },
];

const STATUS_PILL = {
  Quoted:    'bg-orange-100 text-orange-700 border-orange-200',
  Confirmed: 'bg-green-100 text-green-700 border-green-200',
  Ongoing:   'bg-red-100 text-red-700 border-red-200',
  Completed: 'bg-blue-100 text-blue-700 border-blue-200',
  Closed:    'bg-gray-800 text-white border-gray-800',
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: section wrapper card
// ─────────────────────────────────────────────────────────────────────────────
const SectionCard = ({ icon: Icon, title, count, children }) => (
  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <div className="bg-slate-50 border-b px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2 font-semibold text-slate-700 text-sm">
        <div className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center">
          <Icon size={15} className="text-indigo-600" />
        </div>
        {title}
      </div>
      {count !== undefined && (
        <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full font-medium border border-indigo-100">
          {count}
        </span>
      )}
    </div>
    <div className="p-4">{children}</div>
  </div>
);

const EmptyState = ({ msg }) => (
  <div className="py-8 text-center text-slate-400 text-sm">{msg}</div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────
const BusinessReport = ({
  projects = [],
  clients = [],
  employees = [],
  expenses = [],
  inventory = [],
  payments = [],
  payouts = [],
  vendorPayments = [],
  role,
}) => {
  const [preset, setPreset]         = useState('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd]   = useState('');

  // ── Date range ────────────────────────────────────────────────────────────
  const { start: startDate, end: endDate } = useMemo(
    () => getDateRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  );

  const inRange = (dateStr) => {
    if (!startDate || !endDate || !dateStr) return false;
    const d = new Date(dateStr);
    return d >= startDate && d <= endDate;
  };

  const periodLabel = useMemo(() => {
    if (!startDate || !endDate) return '';
    const fmt = (d) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    return `${fmt(startDate)} – ${fmt(endDate)}`;
  }, [startDate, endDate]);

  // ── SECTION 1: Project Financial Summary ──────────────────────────────────
  const projectSummary = useMemo(() => {
    if (!startDate) return [];
    return projects
      .filter(p => p.status !== 'Cancelled')
      .filter(p => {
        // Include project if its event window overlaps the selected period
        const pStart = new Date(p.start_date);
        const pEnd   = new Date(p.end_date);
        return pEnd >= startDate && pStart <= endDate;
      })
      .map(p => {
        const revenue = getProjectGrandTotal(p);

        // Direct Costs = logistics charges (billed to client) + approved employee expenses
        let logisticsCosts = 0;
        if (p.logistics_costs) {
          Object.values(p.logistics_costs).forEach(c => {
            logisticsCosts += sumLogisticsRecord(c).total;
          });
        }
        const reimbursable   = (p.reimbursable_expenses || []).reduce((s, e) => s + (e.amount || 0), 0);
        const projectExpenses = expenses
          .filter(e => e.project_id === p.id && !isExcluded(e.status))
          .reduce((s, e) => s + parseFloat(e.amount || 0), 0);
        const directCosts = logisticsCosts + projectExpenses + reimbursable;

        // Outsourcing Costs = active Purchase Orders + unlinked vendor allocations
        const activePOs = (p.purchase_orders   || []).filter(po => po.status !== 'Cancelled');
        const outsourcingFromPOs    = activePOs.reduce((acc, po) => acc + getEffectivePOCost(po).total, 0);
        const unlinkedAllocs        = (p.vendor_allocations || []).filter(a => !a.po_id);
        const outsourcingFromAllocs = unlinkedAllocs.reduce((acc, v) => acc + (v.tax_amount || 0), 0);
        const outsourcingCosts      = outsourcingFromPOs + outsourcingFromAllocs;

        const netProfit = revenue - directCosts - outsourcingCosts;
        const client    = clients.find(c => c.id === p.client_id);

        return {
          id:               p.id,
          name:             p.project_name,
          client:           client?.name || '—',
          status:           p.status,
          startDate:        p.start_date,
          endDate:          p.end_date,
          venue:            p.venue || '—',
          revenue,
          directCosts,
          outsourcingCosts,
          netProfit,
          margin:           revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : '0.0',
        };
      })
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  }, [projects, clients, expenses, startDate, endDate]);

  // ── SECTION 2: Inventory & Equipment Utilization ─────────────────────────
  const inventoryUtilization = useMemo(() => {
    if (!startDate) return [];
    const itemMap = {};
    projectSummary.forEach(proj => {
      const full = projects.find(p => p.id === proj.id);
      if (!full) return;
      (full.items || []).forEach(item => {
        const key = item.item_id || item.item_name;
        if (!itemMap[key]) {
          itemMap[key] = {
            name:         item.item_name,
            category:     item.category,
            projects:     new Set(),
            totalDays:    0,
            totalRevenue: 0,
          };
        }
        itemMap[key].projects.add(proj.id);
        itemMap[key].totalDays    += (item.qty || 0) * (item.days || 0);
        itemMap[key].totalRevenue += (item.total || 0);
      });
    });
    return Object.values(itemMap)
      .map(v => ({ ...v, projectCount: v.projects.size }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  }, [projectSummary, projects, startDate]);

  // ── SECTION 3: Employee Project Allocation ────────────────────────────────
  const employeeAllocation = useMemo(() => {
    if (!startDate) return [];
    const empMap = {};
    projectSummary.forEach(proj => {
      const full = projects.find(p => p.id === proj.id);
      if (!full) return;
      (full.assigned_employees || []).forEach(empId => {
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        if (!empMap[empId]) empMap[empId] = { name: emp.name, role: emp.role, projects: [] };
        empMap[empId].projects.push({
          name:   proj.name,
          dates:  `${proj.startDate} → ${proj.endDate}`,
          venue:  proj.venue,
          status: proj.status,
        });
      });
    });
    return Object.values(empMap).sort((a, b) => a.name.localeCompare(b.name));
  }, [projectSummary, projects, employees, startDate]);

  // ── SECTION 4: Itemized Employee Expenses ────────────────────────────────
  const empExpenses = useMemo(() => {
    if (!startDate) return [];
    const filtered = expenses.filter(e => {
      if (isExcluded(e.status)) return false;
      return inRange(e.date || e.created_at);
    });
    const empMap = {};
    filtered.forEach(exp => {
      const emp     = employees.find(e => e.id === exp.employee_id);
      const empName = emp?.name || 'Unknown';
      if (!empMap[empName]) empMap[empName] = [];
      empMap[empName].push({
        date:     exp.date,
        category: exp.category,
        remarks:  exp.remarks || '—',
        project:  exp.is_general
          ? 'General Ops'
          : (projects.find(p => p.id === exp.project_id)?.project_name || '—'),
        amount: parseFloat(exp.amount || 0),
        status: exp.status,
      });
    });
    return Object.entries(empMap)
      .map(([name, entries]) => ({
        name,
        entries: entries.sort((a, b) => new Date(a.date) - new Date(b.date)),
        total:   entries.reduce((s, e) => s + e.amount, 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [expenses, employees, projects, startDate, endDate]);

  // ── SECTION 5: Consolidated Expense Report ────────────────────────────────
  const consolidatedExpenses = useMemo(() => {
    if (!startDate) return [];
    const catMap = {};

    // Employee expense claims
    expenses.forEach(exp => {
      if (isExcluded(exp.status)) return;
      if (!inRange(exp.date || exp.created_at)) return;
      const cat = exp.category || 'Misc';
      catMap[cat] = (catMap[cat] || 0) + parseFloat(exp.amount || 0);
    });

    // Logistics charges on projects in-period
    const logisticsLabels = {
      travel:        'Travel',
      accommodation: 'Accommodation',
      food:          'Food & Beverage',
      labour:        'Labour',
      transport:     'Transport',
    };
    projectSummary.forEach(proj => {
      const full = projects.find(p => p.id === proj.id);
      if (!full?.logistics_costs) return;
      Object.entries(full.logistics_costs).forEach(([type, c]) => {
        if (!c.amount) return;
        const cat   = logisticsLabels[type] || type;
        const total = sumLogisticsRecord(c).total;
        catMap[cat] = (catMap[cat] || 0) + total;
      });
    });

    // Outsourcing / sub-contractors
    const outsourcingTotal = projectSummary.reduce((s, p) => s + p.outsourcingCosts, 0);
    if (outsourcingTotal > 0) {
      const key = 'Outsourcing / Sub-contractors';
      catMap[key] = (catMap[key] || 0) + outsourcingTotal;
    }

    return Object.entries(catMap)
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
  }, [expenses, projectSummary, projects, startDate, endDate]);

  // ── Period totals ─────────────────────────────────────────────────────────
  const totals = useMemo(() => ({
    revenue:          projectSummary.reduce((s, p) => s + p.revenue, 0),
    directCosts:      projectSummary.reduce((s, p) => s + p.directCosts, 0),
    outsourcingCosts: projectSummary.reduce((s, p) => s + p.outsourcingCosts, 0),
    netProfit:        projectSummary.reduce((s, p) => s + p.netProfit, 0),
    totalExpenses:    consolidatedExpenses.reduce((s, c) => s + c.total, 0),
  }), [projectSummary, consolidatedExpenses]);

  // ── PDF Export ────────────────────────────────────────────────────────────
  const exportPDF = () => {
    if (!startDate) return;
    const doc   = new jsPDF({ orientation: 'landscape', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();

    const addHeader = () => {
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, pageW, 20, 'F');
      doc.setFontSize(13);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(255, 255, 255);
      doc.text('Business Performance Report', pageW / 2, 9, { align: 'center' });
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(`Period: ${periodLabel}`, pageW / 2, 15, { align: 'center' });
      doc.setTextColor(0, 0, 0);
    };

    const addSectionTitle = (title, y) => {
      doc.setFillColor(79, 70, 229);
      doc.rect(14, y, pageW - 28, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text(title, 17, y + 4.2);
      doc.setTextColor(0, 0, 0);
      return y + 8;
    };

    const tblOpts = {
      headStyles: { fillColor: [99, 102, 241], fontSize: 7, textColor: 255 },
      bodyStyles: { fontSize: 7 },
      styles:     { cellPadding: 1.5, lineColor: [226, 232, 240], lineWidth: 0.1 },
      margin:     { left: 14, right: 14 },
    };

    // ── Page 1 ──
    addHeader();
    let y = 26;

    // KPI boxes
    const kpis = [
      ['Total Revenue',  formatCurrencyPDF(totals.revenue)],
      ['Direct Costs',   formatCurrencyPDF(totals.directCosts)],
      ['Outsourcing',    formatCurrencyPDF(totals.outsourcingCosts)],
      ['Net Profit',     formatCurrencyPDF(totals.netProfit)],
    ];
    const boxW = (pageW - 28 - 9) / 4;
    kpis.forEach(([label, val], i) => {
      const bx = 14 + i * (boxW + 3);
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(226, 232, 240);
      doc.rect(bx, y, boxW, 12, 'FD');
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 116, 139);
      doc.text(label, bx + 3, y + 5);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text(val, bx + 3, y + 10);
    });
    doc.setTextColor(0, 0, 0);
    y += 16;

    // Section 1
    y = addSectionTitle('1. PROJECT FINANCIAL SUMMARY', y);
    autoTable(doc, {
      ...tblOpts,
      startY: y,
      head: [['Project / Event', 'Client', 'Status', 'Start', 'End', 'Venue', 'Revenue', 'Direct Costs', 'Outsourcing', 'Net Profit', 'Margin']],
      body: [
        ...projectSummary.map(p => [
          p.name, p.client, p.status, p.startDate, p.endDate, p.venue,
          formatCurrencyPDF(p.revenue), formatCurrencyPDF(p.directCosts),
          formatCurrencyPDF(p.outsourcingCosts), formatCurrencyPDF(p.netProfit), `${p.margin}%`,
        ]),
        [
          { content: 'TOTALS', colSpan: 6, styles: { fontStyle: 'bold', fillColor: [241, 245, 249] } },
          formatCurrencyPDF(totals.revenue), formatCurrencyPDF(totals.directCosts),
          formatCurrencyPDF(totals.outsourcingCosts), formatCurrencyPDF(totals.netProfit),
          totals.revenue > 0 ? `${((totals.netProfit / totals.revenue) * 100).toFixed(1)}%` : '—',
        ],
      ],
    });

    y = doc.lastAutoTable.finalY + 8;

    // Section 2
    if (y > pageH - 60) { doc.addPage(); addHeader(); y = 26; }
    y = addSectionTitle('2. INVENTORY & EQUIPMENT UTILIZATION', y);
    autoTable(doc, {
      ...tblOpts,
      startY: y,
      head: [['Equipment Name', 'Category', 'Projects', 'Unit-Days Deployed', 'Revenue Attributed']],
      body: inventoryUtilization.map(item => [
        item.name, item.category, item.projectCount, item.totalDays, formatCurrencyPDF(item.totalRevenue),
      ]),
    });

    y = doc.lastAutoTable.finalY + 8;

    // Section 3
    if (y > pageH - 60) { doc.addPage(); addHeader(); y = 26; }
    y = addSectionTitle('3. EMPLOYEE PROJECT ALLOCATION', y);
    const empAllocBody = [];
    employeeAllocation.forEach(emp => {
      if (!emp.projects.length) return;
      empAllocBody.push([{
        content:  `${emp.name}  (${emp.role})`,
        colSpan:  4,
        styles:   { fontStyle: 'bold', fillColor: [238, 242, 255] },
      }]);
      emp.projects.forEach(proj => empAllocBody.push(['', proj.name, proj.dates, proj.status]));
    });
    autoTable(doc, {
      ...tblOpts,
      startY: y,
      head: [['', 'Project / Event', 'Dates', 'Status']],
      body: empAllocBody,
      columnStyles: { 0: { cellWidth: 6 } },
    });

    // ── Page: Sections 4 & 5 ──
    doc.addPage(); addHeader(); y = 26;

    y = addSectionTitle('4. ITEMIZED EMPLOYEE EXPENSES', y);
    const expBody = [];
    empExpenses.forEach(emp => {
      expBody.push([{
        content: `${emp.name} — Total: ${formatCurrencyPDF(emp.total)}`,
        colSpan: 5,
        styles:  { fontStyle: 'bold', fillColor: [238, 242, 255] },
      }]);
      emp.entries.forEach(e =>
        expBody.push([e.date, e.category, e.project, e.remarks, formatCurrencyPDF(e.amount)])
      );
    });
    autoTable(doc, {
      ...tblOpts,
      startY: y,
      head: [['Date', 'Category', 'Project', 'Description / Remarks', 'Amount']],
      body: expBody,
    });

    y = doc.lastAutoTable.finalY + 8;

    if (y > pageH - 60) { doc.addPage(); addHeader(); y = 26; }
    y = addSectionTitle('5. CONSOLIDATED EXPENSE REPORT BY CATEGORY', y);
    autoTable(doc, {
      ...tblOpts,
      startY: y,
      head: [['Expense Category', 'Total Amount', '% of Total']],
      body: [
        ...consolidatedExpenses.map(c => [
          c.category, formatCurrencyPDF(c.total),
          totals.totalExpenses > 0 ? `${((c.total / totals.totalExpenses) * 100).toFixed(1)}%` : '—',
        ]),
        [
          { content: 'GRAND TOTAL', styles: { fontStyle: 'bold', fillColor: [241, 245, 249] } },
          { content: formatCurrencyPDF(totals.totalExpenses), styles: { fontStyle: 'bold' } },
          { content: '100%', styles: { fontStyle: 'bold' } },
        ],
      ],
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    });

    // Page numbers
    const total = doc.internal.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(148, 163, 184);
      doc.text(
        `Generated ${new Date().toLocaleDateString('en-IN')}  •  Page ${i} of ${total}`,
        pageW / 2, pageH - 5, { align: 'center' }
      );
    }

    const fileName = `Business_Report_${startDate.toISOString().slice(0, 10)}_to_${endDate.toISOString().slice(0, 10)}.pdf`;
    doc.save(fileName);
  };

  // ── Excel Export ──────────────────────────────────────────────────────────
  const exportExcel = () => {
    if (!startDate) return;
    const wb = XLSX.utils.book_new();

    // Sheet 1
    const s1 = [
      ['Business Performance Report'],
      [`Period: ${periodLabel}`],
      [],
      ['Project / Event', 'Client', 'Status', 'Start Date', 'End Date', 'Venue',
        'Revenue (₹)', 'Direct Costs (₹)', 'Outsourcing (₹)', 'Net Profit (₹)', 'Margin %'],
      ...projectSummary.map(p => [
        p.name, p.client, p.status, p.startDate, p.endDate, p.venue,
        p.revenue, p.directCosts, p.outsourcingCosts, p.netProfit, parseFloat(p.margin),
      ]),
      ['', '', '', '', '', 'TOTALS',
        totals.revenue, totals.directCosts, totals.outsourcingCosts, totals.netProfit,
        totals.revenue > 0 ? parseFloat(((totals.netProfit / totals.revenue) * 100).toFixed(1)) : 0],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), '1. Project Summary');

    // Sheet 2
    const s2 = [
      ['Equipment Name', 'Category', 'Projects Deployed', 'Unit-Days', 'Revenue Attributed (₹)'],
      ...inventoryUtilization.map(i => [i.name, i.category, i.projectCount, i.totalDays, i.totalRevenue]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), '2. Inventory Utilization');

    // Sheet 3
    const s3 = [['Employee', 'Role', 'Project / Event', 'Dates', 'Status']];
    employeeAllocation.forEach(emp =>
      emp.projects.forEach(proj =>
        s3.push([emp.name, emp.role, proj.name, proj.dates, proj.status])
      )
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s3), '3. Employee Allocation');

    // Sheet 4
    const s4 = [['Employee', 'Date', 'Category', 'Project', 'Description', 'Amount (₹)', 'Status']];
    empExpenses.forEach(emp =>
      emp.entries.forEach(e =>
        s4.push([emp.name, e.date, e.category, e.project, e.remarks, e.amount, e.status])
      )
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s4), '4. Employee Expenses');

    // Sheet 5
    const s5 = [
      ['Expense Category', 'Total Amount (₹)', '% of Total'],
      ...consolidatedExpenses.map(c => [
        c.category, c.total,
        totals.totalExpenses > 0 ? parseFloat(((c.total / totals.totalExpenses) * 100).toFixed(1)) : 0,
      ]),
      ['GRAND TOTAL', totals.totalExpenses, 100],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s5), '5. Consolidated Expenses');

    XLSX.writeFile(wb,
      `Business_Report_${startDate.toISOString().slice(0, 10)}_to_${endDate.toISOString().slice(0, 10)}.xlsx`
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const ready = !!(startDate && endDate);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-screen-xl mx-auto">

      {/* ── Page Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Building2 size={22} className="text-indigo-600" />
            Business Performance Report
          </h1>
          {ready && <p className="text-sm text-slate-500 mt-0.5">{periodLabel}</p>}
        </div>
        {ready && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={exportPDF}
              className="flex items-center gap-1.5 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
            >
              <FileText size={14} /> Export PDF
            </button>
            <button
              onClick={exportExcel}
              className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
            >
              <Download size={14} /> Export Excel
            </button>
          </div>
        )}
      </div>

      {/* ── Period Selector ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3 font-semibold text-slate-700 text-sm">
          <Calendar size={15} className="text-indigo-600" />
          Select Reporting Period
        </div>

        {/* Group labels */}
        {['Monthly', 'Quarterly', 'Bi-Annual', 'Annual', 'Custom'].map(group => {
          const btns = PRESET_BUTTONS.filter(b => b.group === group);
          return (
            <div key={group} className="flex flex-wrap items-center gap-2 mb-2 last:mb-0">
              <span className="text-xs text-slate-400 w-20 shrink-0">{group}</span>
              {btns.map(btn => (
                <button
                  key={btn.value}
                  onClick={() => setPreset(btn.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    preset === btn.value
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-700'
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          );
        })}

        {preset === 'custom' && (
          <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-slate-100">
            <div>
              <label className="block text-xs text-slate-500 mb-1">From</label>
              <input
                type="date"
                className="border border-slate-300 rounded-lg p-1.5 text-sm text-black"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">To</label>
              <input
                type="date"
                className="border border-slate-300 rounded-lg p-1.5 text-sm text-black"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
              />
            </div>
          </div>
        )}

        {ready && (
          <p className="mt-3 text-xs text-indigo-600 font-medium">
            Reporting window: {periodLabel}
          </p>
        )}
      </div>

      {/* ── Prompt if no range ── */}
      {!ready && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-8 text-center text-indigo-500 text-sm">
          Select a reporting period above to generate the report.
        </div>
      )}

      {ready && (
        <>
          {/* ── KPI Summary ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Total Revenue',  value: totals.revenue,          colorClass: 'border-emerald-100 text-emerald-700' },
              { label: 'Direct Costs',   value: totals.directCosts,       colorClass: 'border-orange-100 text-orange-700' },
              { label: 'Outsourcing',    value: totals.outsourcingCosts,  colorClass: 'border-red-100 text-red-700' },
              {
                label: 'Net Profit',
                value: totals.netProfit,
                colorClass: totals.netProfit >= 0 ? 'border-indigo-100 text-indigo-700' : 'border-red-200 text-red-700',
              },
            ].map(({ label, value, colorClass }) => (
              <div key={label} className={`bg-white rounded-xl border p-4 shadow-sm ${colorClass}`}>
                <div className="text-xs font-medium text-slate-500 mb-1">{label}</div>
                <div className={`text-lg font-bold ${colorClass.split(' ')[1]}`}>{formatCurrency(value)}</div>
                <div className="text-xs text-slate-400 mt-1">{projectSummary.length} project(s) in period</div>
              </div>
            ))}
          </div>

          {/* ─────────────────────────────────────────────────────────────────── */}
          {/* SECTION 1 – Project Financial Summary                              */}
          {/* ─────────────────────────────────────────────────────────────────── */}
          <SectionCard icon={TrendingUp} title="1. Project Financial Summary" count={`${projectSummary.length} projects`}>
            {projectSummary.length === 0 ? (
              <EmptyState msg="No projects overlap this period." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 text-slate-500 text-xs border-b border-slate-200">
                    <tr>
                      <th className="p-2.5 whitespace-nowrap">Project / Event</th>
                      <th className="p-2.5 whitespace-nowrap">Client</th>
                      <th className="p-2.5 whitespace-nowrap">Status</th>
                      <th className="p-2.5 whitespace-nowrap">Dates</th>
                      <th className="p-2.5 text-right whitespace-nowrap">Revenue</th>
                      <th className="p-2.5 text-right whitespace-nowrap">Direct Costs</th>
                      <th className="p-2.5 text-right whitespace-nowrap">Outsourcing</th>
                      <th className="p-2.5 text-right whitespace-nowrap">Net Profit</th>
                      <th className="p-2.5 text-right whitespace-nowrap">Margin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {projectSummary.map(p => (
                      <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-2.5 font-medium text-slate-800">{p.name}</td>
                        <td className="p-2.5 text-slate-600">{p.client}</td>
                        <td className="p-2.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_PILL[p.status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="p-2.5 text-slate-500 text-xs whitespace-nowrap">
                          {p.startDate} → {p.endDate}
                        </td>
                        <td className="p-2.5 text-right font-medium text-emerald-700">{formatCurrency(p.revenue)}</td>
                        <td className="p-2.5 text-right text-orange-600">{formatCurrency(p.directCosts)}</td>
                        <td className="p-2.5 text-right text-red-600">{formatCurrency(p.outsourcingCosts)}</td>
                        <td className={`p-2.5 text-right font-semibold ${p.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {formatCurrency(p.netProfit)}
                        </td>
                        <td className={`p-2.5 text-right text-xs font-semibold ${parseFloat(p.margin) >= 20 ? 'text-emerald-600' : parseFloat(p.margin) < 0 ? 'text-red-600' : 'text-amber-600'}`}>
                          {p.margin}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-100 border-t border-slate-300 font-bold text-sm">
                    <tr>
                      <td colSpan={4} className="p-2.5">
                        TOTALS &nbsp;
                        <span className="font-normal text-xs text-slate-500">({projectSummary.length} projects)</span>
                      </td>
                      <td className="p-2.5 text-right text-emerald-700">{formatCurrency(totals.revenue)}</td>
                      <td className="p-2.5 text-right text-orange-600">{formatCurrency(totals.directCosts)}</td>
                      <td className="p-2.5 text-right text-red-600">{formatCurrency(totals.outsourcingCosts)}</td>
                      <td className={`p-2.5 text-right ${totals.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {formatCurrency(totals.netProfit)}
                      </td>
                      <td className="p-2.5 text-right text-slate-700">
                        {totals.revenue > 0
                          ? `${((totals.netProfit / totals.revenue) * 100).toFixed(1)}%`
                          : '—'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </SectionCard>

          {/* ─────────────────────────────────────────────────────────────────── */}
          {/* SECTION 2 – Inventory & Equipment Utilization                      */}
          {/* ─────────────────────────────────────────────────────────────────── */}
          <SectionCard icon={Package} title="2. Inventory & Equipment Utilization" count={`${inventoryUtilization.length} items`}>
            {inventoryUtilization.length === 0 ? (
              <EmptyState msg="No equipment was allocated to projects in this period." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 text-slate-500 text-xs border-b border-slate-200">
                    <tr>
                      <th className="p-2.5 whitespace-nowrap">Equipment Name</th>
                      <th className="p-2.5 whitespace-nowrap">Category</th>
                      <th className="p-2.5 text-center whitespace-nowrap">Projects</th>
                      <th className="p-2.5 text-center whitespace-nowrap">Unit-Days Deployed</th>
                      <th className="p-2.5 text-right whitespace-nowrap">Revenue Attributed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {inventoryUtilization.map((item, i) => (
                      <tr key={i} className="hover:bg-slate-50 transition-colors">
                        <td className="p-2.5 font-medium text-slate-800">{item.name}</td>
                        <td className="p-2.5">
                          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                            {item.category}
                          </span>
                        </td>
                        <td className="p-2.5 text-center text-slate-600">{item.projectCount}</td>
                        <td className="p-2.5 text-center text-slate-600">{item.totalDays}</td>
                        <td className="p-2.5 text-right font-medium text-emerald-700">
                          {formatCurrency(item.totalRevenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-100 border-t border-slate-300 font-bold text-sm">
                    <tr>
                      <td colSpan={4} className="p-2.5">TOTAL REVENUE FROM EQUIPMENT</td>
                      <td className="p-2.5 text-right text-emerald-700">
                        {formatCurrency(inventoryUtilization.reduce((s, i) => s + i.totalRevenue, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </SectionCard>

          {/* ─────────────────────────────────────────────────────────────────── */}
          {/* SECTION 3 – Employee Project Allocation                            */}
          {/* ─────────────────────────────────────────────────────────────────── */}
          <SectionCard icon={Users} title="3. Employee Project Allocation" count={`${employeeAllocation.length} employees`}>
            {employeeAllocation.length === 0 ? (
              <EmptyState msg="No employees were assigned to projects in this period." />
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {employeeAllocation.map((emp, i) => (
                  <div key={i} className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="bg-indigo-50 px-3 py-2.5 flex items-center justify-between border-b border-indigo-100">
                      <span className="font-semibold text-indigo-800 text-sm">{emp.name}</span>
                      <span className="text-xs text-indigo-500 capitalize border border-indigo-200 rounded-full px-2 py-0.5 bg-white">
                        {emp.role}
                      </span>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {emp.projects.map((proj, j) => (
                        <li key={j} className="px-3 py-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium text-slate-700 text-sm leading-snug flex-1">{proj.name}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full border shrink-0 ${STATUS_PILL[proj.status] || 'bg-slate-100 text-slate-600'}`}>
                              {proj.status}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {proj.dates}{proj.venue && proj.venue !== '—' ? ` • ${proj.venue}` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* ─────────────────────────────────────────────────────────────────── */}
          {/* SECTION 4 – Itemized Employee Expenses                             */}
          {/* ─────────────────────────────────────────────────────────────────── */}
          <SectionCard icon={Receipt} title="4. Itemized Employee Expenses" count={`${empExpenses.length} employees`}>
            {empExpenses.length === 0 ? (
              <EmptyState msg="No approved employee expenses in this period." />
            ) : (
              <div className="space-y-4">
                {empExpenses.map((emp, i) => (
                  <div key={i} className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2.5 flex items-center justify-between border-b border-slate-200">
                      <span className="font-semibold text-slate-800 text-sm">{emp.name}</span>
                      <span className="text-sm font-bold text-orange-700">{formatCurrency(emp.total)}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-slate-400 bg-slate-50/60 border-b border-slate-100">
                          <tr>
                            <th className="p-2 text-left whitespace-nowrap">Date</th>
                            <th className="p-2 text-left whitespace-nowrap">Category</th>
                            <th className="p-2 text-left whitespace-nowrap">Project</th>
                            <th className="p-2 text-left">Description / Remarks</th>
                            <th className="p-2 text-right whitespace-nowrap">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {emp.entries.map((entry, j) => (
                            <tr key={j} className="hover:bg-slate-50 transition-colors">
                              <td className="p-2 text-slate-500 whitespace-nowrap">{fmtDate(entry.date)}</td>
                              <td className="p-2">
                                <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                                  {entry.category}
                                </span>
                              </td>
                              <td className="p-2 text-slate-600 text-xs max-w-[140px] truncate">{entry.project}</td>
                              <td className="p-2 text-slate-700">{entry.remarks}</td>
                              <td className="p-2 text-right font-medium text-orange-700">
                                {formatCurrency(entry.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {/* Grand total */}
                <div className="flex justify-end">
                  <div className="bg-orange-50 border border-orange-200 rounded-lg px-4 py-2 text-sm font-bold text-orange-800">
                    Total Employee Expenses: {formatCurrency(empExpenses.reduce((s, e) => s + e.total, 0))}
                  </div>
                </div>
              </div>
            )}
          </SectionCard>

          {/* ─────────────────────────────────────────────────────────────────── */}
          {/* SECTION 5 – Consolidated Expense Report                           */}
          {/* ─────────────────────────────────────────────────────────────────── */}
          <SectionCard icon={BarChart3} title="5. Consolidated Expense Report" count={`${consolidatedExpenses.length} categories`}>
            {consolidatedExpenses.length === 0 ? (
              <EmptyState msg="No expenses found for this period." />
            ) : (
              <div className="grid md:grid-cols-2 gap-6 items-start">
                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-xs border-b border-slate-200">
                      <tr>
                        <th className="p-2.5 text-left">Expense Category</th>
                        <th className="p-2.5 text-right">Total Amount</th>
                        <th className="p-2.5 text-right">% of Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {consolidatedExpenses.map((c, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className="p-2.5 font-medium text-slate-700">{c.category}</td>
                          <td className="p-2.5 text-right text-red-600 font-medium">{formatCurrency(c.total)}</td>
                          <td className="p-2.5 text-right text-slate-500 text-xs">
                            {totals.totalExpenses > 0
                              ? `${((c.total / totals.totalExpenses) * 100).toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="font-bold bg-slate-100 border-t border-slate-300 text-sm">
                      <tr>
                        <td className="p-2.5">GRAND TOTAL</td>
                        <td className="p-2.5 text-right text-red-700">{formatCurrency(totals.totalExpenses)}</td>
                        <td className="p-2.5 text-right">100%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Bar chart visualization */}
                <div className="space-y-2.5">
                  <div className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide">Spend Distribution</div>
                  {consolidatedExpenses.slice(0, 10).map((c, i) => {
                    const pct = totals.totalExpenses > 0 ? (c.total / totals.totalExpenses) * 100 : 0;
                    const colors = ['bg-indigo-500', 'bg-red-400', 'bg-orange-400', 'bg-amber-400',
                      'bg-emerald-400', 'bg-cyan-400', 'bg-purple-400', 'bg-pink-400',
                      'bg-sky-400', 'bg-lime-400'];
                    return (
                      <div key={i}>
                        <div className="flex justify-between text-xs text-slate-600 mb-1">
                          <span className="truncate max-w-[180px]">{c.category}</span>
                          <span className="font-medium ml-2 shrink-0">{formatCurrency(c.total)}</span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${colors[i % colors.length]}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
};

export default BusinessReport;
