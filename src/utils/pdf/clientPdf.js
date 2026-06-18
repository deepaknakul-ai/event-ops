// Client-level exhaustive Management Report — aggregates every project for a
// client into one PDF: relationship KPIs, profitability, receivables aging,
// per-project breakdown, top equipment, and people deployed.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  formatCurrencyPDF, getProjectGrandTotal, getEffectivePOCost, fmtDate,
  getLogHours, getHourlyRateForDate,
} from "../helpers";

const isExcludedExpense = (s) => s === 'Rejected' || s === 'Disapproved';

export const generateClientManagementReportPDF = async (ctx) => {
  const { dashData, getOrgSettings, addToast, expenses = [], timeLogs = [], employees = [] } = ctx;
  if (!dashData) { if (addToast) addToast('Open a client to generate its report.', 'error'); return; }
  try {
    const doc = new jsPDF();
    const org = await getOrgSettings();
    const pageW = doc.internal.pageSize.width;
    const pageH = doc.internal.pageSize.height;
    const mX = 14;

    const {
      rootClient, isBranchView, clientProjects = [], clientPayments = [],
      totalBilled, totalReceived, outstanding, overdueAmt,
      lifetimeRevenue, pipelineRevenue, active = [], completed = [],
      clientSince, topCategories = [], isVendor, totalJobValue, vendorPaid, vendorBalance,
    } = dashData;

    const empName = (id) => (employees.find(e => e.id === id)?.name) || id || '—';
    const empObj = (id) => employees.find(e => e.id === id) || {};
    const projIds = new Set(clientProjects.map(p => p.id));

    const drawCompactHeader = () => {
      const pg = doc.internal.getCurrentPageInfo().pageNumber;
      if (pg === 1) return;
      doc.setFillColor(13, 148, 136);
      doc.rect(mX, 6, pageW - mX * 2, 12, 'F');
      doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
      doc.text('Client Management Report', mX + 3, 14);
      doc.text(rootClient?.name || '', pageW - mX - 3, 14, { align: 'right' });
      doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'normal');
    };
    const sectionTitle = (title, yy) => {
      if (yy + 16 > pageH - 14) { doc.addPage(); drawCompactHeader(); yy = 24; }
      doc.setFillColor(13, 148, 136);
      doc.rect(mX, yy, pageW - mX * 2, 7, 'F');
      doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
      doc.text(title, mX + 2, yy + 5);
      doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'normal');
      return yy + 11;
    };

    // ── Per-project cost (mirrors Business Report) ──
    const projectCost = (p) => {
      let logistics = 0;
      if (p.logistics_costs) Object.values(p.logistics_costs).forEach(c => { logistics += (c.amount || 0) * (1 + (c.gst || 0) / 100); });
      const reimb = (p.reimbursable_expenses || []).reduce((s, e) => s + (e.amount || 0), 0);
      const exp = expenses.filter(e => e.project_id === p.id && !isExcludedExpense(e.status)).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      const activePOs = (p.purchase_orders || []).filter(po => po.status !== 'Cancelled');
      const outPO = activePOs.reduce((a, po) => a + getEffectivePOCost(po).total, 0);
      const unlinked = (p.vendor_allocations || []).filter(a => !a.po_id);
      const outAlloc = unlinked.reduce((a, v) => a + (parseFloat(v.tax_amount) || 0), 0);
      return logistics + reimb + exp + outPO + outAlloc;
    };
    const receivedByProject = {};
    clientPayments.forEach(p => { receivedByProject[p.project_id] = (receivedByProject[p.project_id] || 0) + parseFloat(p.amount || 0); });

    // ── Title block ──
    let y = 16;
    if (org?.logo) { try { doc.addImage(org.logo, 'JPEG', mX, y - 4, 22, 22); } catch (e) { /* no logo */ } }
    doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.setTextColor(13, 148, 136);
    doc.text(org?.name || 'Company', pageW - mX, y + 3, { align: 'right' });
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(13); doc.setFont('helvetica', 'bold');
    doc.text('CLIENT MANAGEMENT REPORT', mX + (org?.logo ? 26 : 0), y + 4);
    y += 13;
    doc.setDrawColor(200); doc.line(mX, y, pageW - mX, y); y += 6;

    doc.setFontSize(9);
    const leftInfo = [
      ['Client', (rootClient?.name || '—') + (isBranchView ? ' (branch view)' : '')],
      ['GSTIN', rootClient?.gstin || '—'],
      ['Type', rootClient?.type || 'Client'],
    ];
    const rightInfo = [
      ['Client since', clientSince ? fmtDate(clientSince) : '—'],
      ['Total projects', String(clientProjects.length)],
      ['Generated', new Date().toLocaleDateString('en-IN')],
    ];
    leftInfo.forEach(([k, v], i) => {
      doc.setFont('helvetica', 'bold'); doc.text(`${k}:`, mX, y + i * 5);
      doc.setFont('helvetica', 'normal'); doc.text(String(v), mX + 22, y + i * 5);
    });
    rightInfo.forEach(([k, v], i) => {
      doc.setFont('helvetica', 'bold'); doc.text(`${k}:`, pageW / 2, y + i * 5);
      doc.setFont('helvetica', 'normal'); doc.text(String(v), pageW / 2 + 26, y + i * 5);
    });
    y += 3 * 5 + 5;

    // ── 1. Relationship Summary ──
    y = sectionTitle('1. Relationship Summary', y);
    autoTable(doc, {
      startY: y,
      head: [['Metric', 'Value']],
      body: [
        ['Lifetime Revenue (delivered)', formatCurrencyPDF(lifetimeRevenue)],
        ['Pipeline Revenue (active quotes/projects)', formatCurrencyPDF(pipelineRevenue)],
        ['Total Billed (invoiced)', formatCurrencyPDF(totalBilled)],
        ['Total Received', formatCurrencyPDF(totalReceived)],
        ['Outstanding', formatCurrencyPDF(outstanding)],
        ['Overdue', formatCurrencyPDF(overdueAmt)],
        ['Projects (active / completed / total)', `${active.length} / ${completed.length} / ${clientProjects.length}`],
      ],
      didParseCell: (d) => {
        if (d.section !== 'body') return;
        if (d.row.index === 4 && d.column.index === 1) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.textColor = outstanding > 0.5 ? [185, 28, 28] : [5, 150, 105]; }
        if (d.row.index === 5 && d.column.index === 1 && overdueAmt > 0.5) { d.cell.styles.textColor = [185, 28, 28]; }
      },
      theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8 }, headStyles: { fillColor: [13, 148, 136] },
      columnStyles: { 1: { halign: 'right' } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── 2. Profitability (delivered projects) ──
    y = sectionTitle('2. Profitability (delivered projects)', y);
    const delivered = clientProjects.filter(p => ['Completed', 'Closed'].includes(p.status));
    const totRev = delivered.reduce((s, p) => s + getProjectGrandTotal(p), 0);
    const totCost = delivered.reduce((s, p) => s + projectCost(p), 0);
    const grossMargin = totRev - totCost;
    const marginPct = totRev > 0 ? (grossMargin / totRev * 100).toFixed(1) : '0.0';
    autoTable(doc, {
      startY: y,
      head: [['Metric', 'Amount']],
      body: [
        ['Total Revenue (incl. GST)', formatCurrencyPDF(totRev)],
        ['Total Cost (outsourcing + expenses + logistics)', formatCurrencyPDF(totCost)],
        [`Gross Margin  (${marginPct}%)`, formatCurrencyPDF(grossMargin)],
      ],
      didParseCell: (d) => { if (d.section === 'body' && d.row.index === 2) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [240, 253, 250]; } },
      theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8 }, headStyles: { fillColor: [13, 148, 136] },
      columnStyles: { 1: { halign: 'right' } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── 3. Receivables Aging ──
    y = sectionTitle('3. Receivables Aging', y);
    const buckets = { b30: 0, b60: 0, b90: 0, b90p: 0 };
    const now = new Date();
    clientProjects.filter(p => p.invoice_status === 'Invoiced' || p.status === 'Closed').forEach(p => {
      const due = getProjectGrandTotal(p) - (receivedByProject[p.id] || 0);
      if (due <= 0.5) return;
      const base = p.invoice_date ? new Date(p.invoice_date) : new Date(p.end_date || p.start_date || now);
      const days = Math.floor((now - base) / 86400000);
      if (days <= 30) buckets.b30 += due; else if (days <= 60) buckets.b60 += due; else if (days <= 90) buckets.b90 += due; else buckets.b90p += due;
    });
    const agingTotal = buckets.b30 + buckets.b60 + buckets.b90 + buckets.b90p;
    autoTable(doc, {
      startY: y,
      head: [['0-30 days', '31-60 days', '61-90 days', '90+ days', 'Total Outstanding']],
      body: [[formatCurrencyPDF(buckets.b30), formatCurrencyPDF(buckets.b60), formatCurrencyPDF(buckets.b90), formatCurrencyPDF(buckets.b90p), formatCurrencyPDF(agingTotal)]],
      theme: 'grid', styles: { fontSize: 8.5, cellPadding: 2, halign: 'right' }, headStyles: { fillColor: [13, 148, 136], halign: 'right' },
      didParseCell: (d) => { if (d.section === 'body' && (d.column.index === 3 || d.column.index === 4)) { d.cell.styles.fontStyle = 'bold'; if (d.column.index === 3 && buckets.b90p > 0.5) d.cell.styles.textColor = [185, 28, 28]; } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── 4. Projects breakdown ──
    y = sectionTitle('4. Projects', y);
    const projRows = [...clientProjects]
      .filter(p => p.status !== 'Cancelled')
      .sort((a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0))
      .map(p => {
        const rev = getProjectGrandTotal(p);
        const cost = projectCost(p);
        const m = rev > 0 ? ((rev - cost) / rev * 100).toFixed(0) + '%' : '—';
        const billed = (p.invoice_status === 'Invoiced' || p.status === 'Closed') ? rev : 0;
        const recv = receivedByProject[p.id] || 0;
        const out = billed - recv;
        return [p.project_name || '—', p.status || '—', `${fmtDate(p.start_date)}`, formatCurrencyPDF(rev), m, formatCurrencyPDF(out > 0.5 ? out : 0)];
      });
    autoTable(doc, {
      startY: y,
      head: [['Project', 'Status', 'Start', 'Revenue', 'Margin', 'Outstanding']],
      body: projRows.length ? projRows : [['No projects', '', '', '', '', '']],
      theme: 'grid', styles: { fontSize: 7.5, cellPadding: 1.5 }, headStyles: { fillColor: [13, 148, 136] },
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'center' }, 5: { halign: 'right' } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── 5. Top equipment categories ──
    y = sectionTitle('5. Top Equipment Categories (by value)', y);
    const itemMap = {};
    clientProjects.forEach(p => (p.items || []).forEach(it => {
      const key = it.item_name || 'Item';
      if (!itemMap[key]) itemMap[key] = { qty: 0, value: 0 };
      itemMap[key].qty += parseInt(it.qty) || 0;
      itemMap[key].value += it.total || 0;
    }));
    const topItems = Object.entries(itemMap).sort((a, b) => b[1].value - a[1].value).slice(0, 10);
    autoTable(doc, {
      startY: y,
      head: [['Category', 'Value']],
      body: (topCategories.length ? topCategories : [['—', 0]]).map(([cat, val]) => [cat, formatCurrencyPDF(val)]),
      theme: 'grid', styles: { fontSize: 8, cellPadding: 1.6 }, headStyles: { fillColor: [13, 148, 136] },
      columnStyles: { 1: { halign: 'right' } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 4;
    autoTable(doc, {
      startY: y,
      head: [['Top Item', 'Total Qty', 'Value']],
      body: topItems.length ? topItems.map(([name, m]) => [name, m.qty, formatCurrencyPDF(m.value)]) : [['—', '', '']],
      theme: 'grid', styles: { fontSize: 8, cellPadding: 1.6 }, headStyles: { fillColor: [15, 118, 110] },
      columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right' } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── 6. People deployed across client's projects ──
    y = sectionTitle('6. People Deployed (across all projects)', y);
    const peopleMap = new Map();
    (timeLogs || []).filter(l => projIds.has(l.project_id)).forEach(l => {
      const id = l.employeeId || l.employee_id; if (!id) return;
      const worked = getLogHours(l);
      const rate = getHourlyRateForDate(empObj(id), l.checkIn || l.date || new Date());
      if (!peopleMap.has(id)) peopleMap.set(id, { projects: new Set(), shifts: 0, hours: 0, cost: 0 });
      const m = peopleMap.get(id);
      m.projects.add(l.project_id); m.shifts += 1; m.hours += worked; m.cost += worked * (rate || 0);
    });
    const peopleRows = Array.from(peopleMap.entries())
      .sort((a, b) => b[1].hours - a[1].hours)
      .map(([id, m]) => [empName(id), m.projects.size, m.shifts, m.hours.toFixed(1), formatCurrencyPDF(m.cost)]);
    autoTable(doc, {
      startY: y,
      head: [['Employee', 'Projects', 'Shifts', 'Hrs Worked', 'Labour Cost (indicative)']],
      body: peopleRows.length ? peopleRows : [['No attendance recorded', '', '', '', '']],
      theme: 'grid', styles: { fontSize: 8, cellPadding: 1.6 }, headStyles: { fillColor: [124, 58, 237] },
      columnStyles: { 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
      didDrawPage: drawCompactHeader,
    });
    y = doc.lastAutoTable.finalY + 6;

    // ── 7. Vendor engagement (only if this party is also a vendor) ──
    if (isVendor && (totalJobValue > 0 || vendorPaid > 0)) {
      y = sectionTitle('7. Vendor Engagement', y);
      autoTable(doc, {
        startY: y,
        head: [['Metric', 'Amount']],
        body: [
          ['Total Job Value (we owe / paid)', formatCurrencyPDF(totalJobValue)],
          ['Paid to Vendor', formatCurrencyPDF(vendorPaid)],
          ['Balance Payable', formatCurrencyPDF(vendorBalance)],
        ],
        didParseCell: (d) => { if (d.section === 'body' && d.row.index === 2) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.textColor = vendorBalance > 0.5 ? [185, 28, 28] : [5, 150, 105]; } },
        theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8 }, headStyles: { fillColor: [217, 119, 6] },
        columnStyles: { 1: { halign: 'right' } },
        didDrawPage: drawCompactHeader,
      });
    }

    // ── Page numbers ──
    const totalPages = doc.internal.getNumberOfPages();
    for (let pg = 1; pg <= totalPages; pg++) {
      doc.setPage(pg);
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(140, 140, 140);
      doc.text(`Page ${pg} of ${totalPages}`, pageW - mX, pageH - 5, { align: 'right' });
      doc.text(`${org?.name || ''} - Client Report`, mX, pageH - 5);
      doc.setTextColor(0, 0, 0);
    }

    const safe = (rootClient?.name || 'client').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    doc.save(`Client_Report_${safe}.pdf`);
  } catch (err) {
    console.error('Client Management Report PDF Error:', err);
    if (addToast) addToast('Failed to generate Client Management Report', 'error');
  }
};
