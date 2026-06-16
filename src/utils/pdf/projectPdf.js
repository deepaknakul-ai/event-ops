// Project quotation PDF/Excel generators — extracted from Projects.jsx.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "@e965/xlsx";
import { formatCurrencyPDF, getLogisticsLines, calculateLEDSignalPorts, getProjectGSTBreakdown } from "../helpers";
import { LOGISTICS_TYPES } from "../constants";

export const generateQuotationPDF = async (ctx) => {
  const { selectedProject, calculateProjectTotals, canViewProjectFinancials, clients, getOrgSettings, getProjectSalesGST, stateName, addToast } = ctx;
    if (!canViewProjectFinancials) {
      addToast('Access denied: quotation amounts are restricted.', 'error');
      return;
    }
    const doc = new jsPDF();
    const org = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    const pageWidth = doc.internal.pageSize.width;
    const margin = 14;
    let y = 20;

    // Header
    if (org?.logo) {
        try { doc.addImage(org.logo, 'JPEG', margin, 15, 25, 25); } catch (e) { console.warn("Logo add failed", e); }
    }
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text(org?.name || "Quotation", pageWidth - margin, 25, { align: 'right' });
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const orgAddr = doc.splitTextToSize(org?.address || "", 80);
    doc.text(orgAddr, pageWidth - margin, 32, { align: 'right' });
    y = 50;

    // Client & Project Details
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Quote To:", margin, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(client?.name || '', margin, y);
    y += 5;
    const clientAddr = doc.splitTextToSize(client?.address || "", 80);
    doc.text(clientAddr, margin, y);
    y += clientAddr.length * 5 + 2;
    if (client?.gstin) doc.text(`GSTIN: ${client.gstin}`, margin, y);

    doc.text(`Quote #: ${selectedProject.id.slice(-6)}`, pageWidth - margin, y - 15, { align: 'right' });
    doc.text(`Date: ${new Date().toLocaleDateString()}`, pageWidth - margin, y - 10, { align: 'right' });
    
    y += 10;

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text(`Subject: Quotation for ${selectedProject.project_name}`, margin, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.text(`Venue: ${selectedProject.venue}`, margin, y);
    y += 5;
    doc.text(`Event Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, margin, y);
    y += 10;

    const totals = calculateProjectTotals();

    // Table
    let head = [['#', 'Item Description', 'Qty', 'Days', 'Rate', 'GST', 'Amount']];
    let body = [];
    let grandTotal = 0;

    if (totals.use_package_cost) {
        (selectedProject.items || []).forEach((item, idx) => {
            body.push([
                idx + 1,
                item.item_name + (item.description ? `\n(${item.description})` : ''),
                item.qty,
                item.days,
                '-',
                '-',
                'Included'
            ]);
        });
        grandTotal = totals.total_revenue;
    } else {
        (selectedProject.items || []).forEach((item, idx) => {
            body.push([
                idx + 1,
                item.item_name + (item.description ? `\n(${item.description})` : ''),
                item.qty,
                item.days,
                formatCurrencyPDF(item.rate),
                `${item.gst_rate}%`,
                formatCurrencyPDF(item.total)
            ]);
        });
        (LOGISTICS_TYPES).forEach(lt => {
            const cost = selectedProject.logistics_costs?.[lt.id];
            if (!cost) return;
            // H-10: emit one PDF row per split line (or single legacy bucket).
            getLogisticsLines(lt.id, lt.label, cost).forEach(line => {
                if (!(line.amount > 0)) return;
                const total = line.amount * (1 + (line.gst || 0) / 100);
                const desc = line.description && line.description !== lt.label
                    ? `${lt.label} — ${line.description}`
                    : lt.label;
                body.push([
                    body.length + 1,
                    desc,
                    1,
                    1,
                    formatCurrencyPDF(line.amount),
                    `${line.gst || 0}%`,
                    formatCurrencyPDF(total)
                ]);
            });
        });
        grandTotal = totals.total_revenue;
    }

    autoTable(doc, {
        startY: y,
        head: head,
        body: body,
        theme: 'grid',
        headStyles: { fillColor: [41, 51, 61] },
        styles: { fontSize: 8, cellPadding: 2 },
        columnStyles: {
            0: { cellWidth: 8 },
            1: { cellWidth: 'auto' },
            2: { halign: 'center' },
            3: { halign: 'center' },
            4: { halign: 'right' },
            5: { halign: 'center' },
            6: { halign: 'right' }
        }
    });

    y = doc.lastAutoTable.finalY;

    // Insert LED Wall details (if any allocations have LED metadata)
    const ledItems = (selectedProject.items || []).filter(it => it.led);
    if (ledItems.length > 0) {
      y += 6;
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text("LED Wall Details:", margin, y);
      y += 6;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      ledItems.forEach(li => {
        const s = li.led.specs;
        if (!s) return;
        const portCalc = calculateLEDSignalPorts(s.resolution.totalPixelWidth, s.resolution.totalPixelHeight);
        const line = `${li.item_name} — ${li.led.tilesWide}×${li.led.tilesHigh} tiles | Size: ${s.physicalDimensions.totalWidthM}m × ${s.physicalDimensions.totalHeightM}m | Res: ${s.resolution.totalPixelWidth}×${s.resolution.totalPixelHeight} px | Power: ${s.power.maxPowerWatts}W / ${s.power.avgPowerWatts}W`;
        const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2);
        doc.text(wrapped, margin, y);
        y += wrapped.length * 5 + 2;
        if (portCalc) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(8);
          const portLine = `Technical: CAT 6 Ports - Primary: ${portCalc.primaryPorts} | Backup: ${portCalc.backupPorts} | Total: ${portCalc.totalPortsWithBackup}`;
          doc.text(portLine, margin + 5, y);
          y += 5;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
        }
        if (y > doc.internal.pageSize.height - 40) { doc.addPage(); y = 20; }
      });
    }

    // Totals Table — GST split by place of supply (client GSTIN vs org state)
    const salesGst = getProjectSalesGST(selectedProject);
    const gstRows = salesGst
      ? (salesGst.supplyType === 'IGST'
          ? [['IGST', formatCurrencyPDF(salesGst.totals.igstAmt)]]
          : [['CGST', formatCurrencyPDF(salesGst.totals.cgstAmt)], ['SGST', formatCurrencyPDF(salesGst.totals.sgstAmt)]])
      : [['Total GST', formatCurrencyPDF(totals.gst_output)]];
    let summaryBody;
    if (totals.use_package_cost) {
        summaryBody = [
            ['Package Cost (excl. GST)', formatCurrencyPDF(totals.package_cost)],
            ...gstRows,
            ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
    } else {
        const subtotal = totals.equipment + totals.logistics;
        summaryBody = [
            ['Subtotal', formatCurrencyPDF(subtotal)],
            ...gstRows,
            ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
    }
    if (salesGst) {
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 90, 90);
      doc.text(`Place of Supply: ${stateName(salesGst.placeOfSupply)} · ${salesGst.supplyType === 'IGST' ? 'Inter-state (IGST)' : 'Intra-state (CGST+SGST)'}`, margin, y + 8);
      doc.setTextColor(0, 0, 0);
    }

    autoTable(doc, {
        startY: y + 5,
        body: summaryBody,
        theme: 'plain',
        tableWidth: 90,
        margin: { left: pageWidth - margin - 90 },
        styles: { fontSize: 9, cellPadding: 1.5 },
        columnStyles: {
            0: { halign: 'right', cellWidth: 50, fontStyle: 'bold' },
            1: { halign: 'right' }
        },
        didDrawCell: (data) => {
            if (data.row.index === data.table.body.length - 1) { // Grand Total row
                data.cell.styles.fontStyle = 'bold';
                data.cell.styles.fontSize = 10;
                doc.setLineWidth(0.2);
                doc.line(data.cell.x, data.cell.y, data.cell.x + data.cell.width, data.cell.y);
            }
        }
    });

    y = doc.lastAutoTable.finalY + 10;

    // Terms
    if (org?.po_terms) {
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        doc.text("Terms & Conditions:", margin, y);
        y += 5;
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        const terms = doc.splitTextToSize(org.po_terms, pageWidth - (margin * 2));
        doc.text(terms, margin, y);
        y += (terms.length * 4) + 10;
    }

    // Signature
    doc.text("For " + (org?.name || "Your Company"), pageWidth - margin, y, { align: 'right' });
    y += 20;
    doc.text("Authorized Signatory", pageWidth - margin, y, { align: 'right' });

    doc.save(`Quotation_${selectedProject.project_name.replace(/\s/g, '_')}.pdf`);
  };

  export const generateQuotationExcel = (ctx) => {
  const { selectedProject, calculateProjectTotals, canViewProjectFinancials, clients, getOrgSettings, getProjectSalesGST, stateName, addToast } = ctx;
    if (!canViewProjectFinancials) {
      addToast('Access denied: quotation amounts are restricted.', 'error');
      return;
    }
    const totals = calculateProjectTotals();
    let data = [];

    if (totals.use_package_cost) {
        (selectedProject.items || []).forEach((item, idx) => {
            data.push({
                '#': idx + 1,
                'Item Description': item.item_name + (item.description ? ` (${item.description})` : ''),
                'Qty': item.qty,
                'Days': item.days,
                'Rate': 'Included',
                'GST %': '-',
                'Amount': 'Included'
            });
        });
        data.push({}); // Spacer
        data.push({ 'Item Description': 'Package Cost (excl. GST)', 'Amount': totals.package_cost });
        data.push({
            'Item Description': `GST (${selectedProject.package_cost_gst || 18}%)`, 'Amount': totals.total_revenue - totals.package_cost
        });
    } else {
        (selectedProject.items || []).forEach((item, idx) => {
            data.push({
                '#': idx + 1,
                'Item Description': item.item_name + (item.description ? ` (${item.description})` : ''),
                'Qty': item.qty,
                'Days': item.days,
                'Rate': item.rate,
                'GST %': item.gst_rate,
                'Amount': item.total
            });
        });
        (LOGISTICS_TYPES).forEach(lt => {
            const cost = selectedProject.logistics_costs?.[lt.id];
            if (!cost) return;
            // H-10: emit one Excel row per split line.
            getLogisticsLines(lt.id, lt.label, cost).forEach(line => {
                if (!(line.amount > 0)) return;
                const total = line.amount * (1 + (line.gst || 0) / 100);
                const desc = line.description && line.description !== lt.label
                    ? `${lt.label} — ${line.description}`
                    : lt.label;
                data.push({
                    '#': data.length + 1,
                    'Item Description': desc,
                    'Qty': 1,
                    'Days': 1,
                    'Rate': line.amount,
                    'GST %': line.gst || 0,
                    'Amount': total
                });
            });
        });
    }

    // Add LED details for Excel export
    const ledItemsForExcel = (selectedProject.items || []).filter(i => i.led);
    if (ledItemsForExcel.length > 0) {
      data.push({});
      data.push({ 'Item Description': 'LED Wall Details' });
      ledItemsForExcel.forEach(li => {
        const s = li.led?.specs || {};
        const portCalc = calculateLEDSignalPorts(s.resolution?.totalPixelWidth || 0, s.resolution?.totalPixelHeight || 0);
        data.push({ 'Item Description': `${li.item_name} — ${li.led.tilesWide}x${li.led.tilesHigh} tiles`, 'Qty': li.qty, 'Days': li.days, 'Rate': li.rate, 'GST %': li.gst_rate, 'Amount': li.total });
        data.push({ 'Item Description': `Size: ${s.physicalDimensions?.totalWidthM || ''}m x ${s.physicalDimensions?.totalHeightM || ''}m`, 'Amount': '' });
        data.push({ 'Item Description': `Resolution: ${s.resolution?.totalPixelWidth || ''} x ${s.resolution?.totalPixelHeight || ''} px`, 'Amount': '' });
        data.push({ 'Item Description': `Power (Max/Avg): ${s.power?.maxPowerWatts || ''} W / ${s.power?.avgPowerWatts || ''} W`, 'Amount': '' });
        if (portCalc) {
          data.push({ 'Item Description': `Technical - CAT 6 Ports (Primary: ${portCalc.primaryPorts} | Backup: ${portCalc.backupPorts} | Total: ${portCalc.totalPortsWithBackup})`, 'Amount': '' });
        }
        data.push({});
      });
    }

    data.push({}); // Spacer
    data.push({
        'Item Description': 'Grand Total',
        'Amount': totals.total_revenue
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Quotation");
    XLSX.writeFile(wb, `Quotation_${selectedProject.project_name.replace(/\s/g, '_')}.xlsx`);
  };

  export const generateFinalReportPDF = async (ctx) => {
  const { selectedProject, canViewProjectFinancials, addToast, getOrgSettings, clients, calculateProjectTotals, outsourcingRows, expenseDateRows, expenseByEmployeeCategory } = ctx;
    if (!selectedProject) return;
    if (!canViewProjectFinancials) {
      addToast('Access denied: financial report is restricted.', 'error');
      return;
    }

    const doc = new jsPDF();
    const org = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    const totals = calculateProjectTotals();
    const totalRevenue = totals.equipment + totals.logistics + totals.gst_output;
    const totalCost = totals.outsourcing + totals.direct_expense + totals.gst_input;
    // Operating profit uses BASE amounts only — GST collected & paid cancel out for registered business
    const margin = (totals.equipment + totals.logistics) - (totals.outsourcing + totals.direct_expense);

    const pageWidth = doc.internal.pageSize.width;
    const marginX = 14;
    let y = 18;

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(org?.name || 'Final Project Report', marginX, y);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${selectedProject.project_name}`, marginX, y + 7);
    doc.text(`Client: ${client?.name || '-'}`, marginX, y + 12);
    doc.text(`Dates: ${selectedProject.start_date || '-'} to ${selectedProject.end_date || '-'}`, marginX, y + 17);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, pageWidth - marginX, y + 7, { align: 'right' });
    y += 24;

    autoTable(doc, {
      startY: y,
      head: [['Cost Center', 'Amount']],
      body: [
        ['Equipment Revenue (Base)', formatCurrencyPDF(totals.equipment)],
        ['Logistics Revenue (Base)', formatCurrencyPDF(totals.logistics)],
        ['Total Revenue (Base, Excl. GST)', formatCurrencyPDF(totals.equipment + totals.logistics)],
        ['Outsourcing Cost (Base)', formatCurrencyPDF(totals.outsourcing)],
        ['Direct Expenses', formatCurrencyPDF(totals.direct_expense)],
        ['Total Cost (Base)', formatCurrencyPDF(totals.outsourcing + totals.direct_expense)],
        ['Operating Profit / Loss', formatCurrencyPDF(margin)],
        ['— GST Output (Collected)', formatCurrencyPDF(totals.gst_output)],
        ['— GST Input / ITC (Paid)', formatCurrencyPDF(totals.gst_input)],
        ['— Net GST Payable to Govt', formatCurrencyPDF(totals.gst_payable)],
        ...(totals.reimbursable > 0 ? [
          ['Client Reimbursable (As Actual)', formatCurrencyPDF(totals.reimbursable)],
          ['Total Client Payable', formatCurrencyPDF(totals.total_client_payable)],
        ] : []),
      ],
      didParseCell: (data) => {
        if (data.section === 'body') {
          // Bold the profit row (index 6)
          if (data.row.index === 6) data.cell.styles.fontStyle = 'bold';
          // Bold the total client payable row (last row when reimbursable exists)
          if (totals.reimbursable > 0 && data.row.index === data.table.body.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = [240, 253, 250];
          }
        }
      },
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] }
    });

    y = doc.lastAutoTable.finalY + 8;

    autoTable(doc, {
      startY: y,
      head: [['Vendor', 'Item', 'Qty', 'Days', 'Base', 'GST %', 'Total']],
      body: outsourcingRows.length > 0
        ? outsourcingRows.map(r => [
            r.vendor,
            r.item,
            r.qty,
            r.days,
            formatCurrencyPDF(r.base),
            `${r.gstRate}%`,
            formatCurrencyPDF(r.total)
          ])
        : [['-', '-', '-', '-', '-', '-', '-']],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [220, 38, 38] }
    });

    y = doc.lastAutoTable.finalY + 8;

    autoTable(doc, {
      startY: y,
      head: [['Date', 'Employee', 'Category', 'Amount', 'Remarks']],
      body: expenseDateRows.length > 0
        ? expenseDateRows.map(r => [
            r.date ? new Date(r.date).toLocaleDateString('en-IN') : '-',
            r.employee,
            r.category,
            formatCurrencyPDF(r.amount),
            r.remarks || '-'
          ])
        : [['-', '-', '-', '-', '-']],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 116, 144] }
    });

    y = doc.lastAutoTable.finalY + 8;

    autoTable(doc, {
      startY: y,
      head: [['Employee', 'Category', 'Total']],
      body: expenseByEmployeeCategory.length > 0
        ? expenseByEmployeeCategory.map(r => [r.employee, r.category, formatCurrencyPDF(r.total)])
        : [['-', '-', '-']],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [16, 185, 129] }
    });

    doc.save(`Final_Report_${selectedProject.project_name.replace(/\s/g, '_')}.pdf`);
  };

  export const generateTaxInvoicePDF = async (ctx) => {
  const { canManageProjectInvoices, addToast, getOrgSettings, clients, selectedProject, logAction } = ctx;
    if (!canManageProjectInvoices) {
      addToast('Access denied: invoice documents are restricted.', 'error');
      return;
    }
    try {
      const pdfDoc = new jsPDF();
      const org = await getOrgSettings();
      const client = clients.find(c => c.id === selectedProject.client_id);
      const pageWidth = pdfDoc.internal.pageSize.width;
      const pageH = pdfDoc.internal.pageSize.height;
      const margin = 14;
      const invDate = selectedProject.invoice_date
        ? new Date(selectedProject.invoice_date).toLocaleDateString('en-IN')
        : new Date().toLocaleDateString('en-IN');
      const invNo = selectedProject.invoice_no || '—';

      // GST breakdown
      const gstBD = getProjectGSTBreakdown(selectedProject, org?.gstin || '', client?.gstin || '');
      const isIGST = gstBD.supplyType === 'IGST';

      // --- draw compact header on pages 2+ ---
      const drawCompactHeader = () => {
        const pg = pdfDoc.internal.getCurrentPageInfo().pageNumber;
        if (pg === 1) return;
        pdfDoc.setFillColor(30, 64, 175);
        pdfDoc.rect(margin, 5, pageWidth - margin * 2, 16, 'F');
        pdfDoc.setFontSize(10); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.text(org?.name || 'Company', margin + 3, 14);
        pdfDoc.text('TAX INVOICE', pageWidth / 2, 14, { align: 'center' });
        pdfDoc.text(`${invNo}  |  ${invDate}`, pageWidth - margin - 2, 14, { align: 'right' });
        pdfDoc.setTextColor(0, 0, 0);
      };
      const addNewPage = () => { pdfDoc.addPage(); drawCompactHeader(); return 32; };

      let y = 12;

      // --- PAGE 1 HEADER ---
      if (org?.logo) { try { pdfDoc.addImage(org.logo, 'JPEG', margin, y, 25, 25); } catch(e) {} }
      pdfDoc.setFontSize(15); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(30, 64, 175);
      pdfDoc.text(org?.name || 'Company', pageWidth - margin, y + 8, { align: 'right' });
      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(80, 80, 80);
      const orgAddrLines = pdfDoc.splitTextToSize(org?.address || '', 80);
      pdfDoc.text(orgAddrLines, pageWidth - margin, y + 14, { align: 'right' });
      let hY = y + 14 + orgAddrLines.length * 4;
      if (org?.gstin) { pdfDoc.text(`GSTIN: ${org.gstin}`, pageWidth - margin, hY, { align: 'right' }); hY += 4; }
      if (org?.phone) { pdfDoc.text(`Ph: ${org.phone}`, pageWidth - margin, hY, { align: 'right' }); }
      pdfDoc.setTextColor(0, 0, 0);

      // Title Banner
      y = Math.max(hY + 6, 44);
      pdfDoc.setFillColor(30, 64, 175);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, 10, 'F');
      pdfDoc.setFontSize(13); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(255, 255, 255);
      pdfDoc.text('TAX INVOICE', pageWidth / 2, y + 7, { align: 'center' });
      pdfDoc.setTextColor(0, 0, 0);
      y += 14;

      // Invoice meta row
      pdfDoc.setFontSize(9); pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('Invoice No: ', margin, y); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.text(invNo, margin + 22, y);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.text(`Date: ${invDate}`, pageWidth - margin, y, { align: 'right' });
      y += 5;
      // Due date & FY
      const invDueDate = selectedProject.invoice_due_date
        ? new Date(selectedProject.invoice_due_date).toLocaleDateString('en-IN') : '';
      if (invDueDate) { pdfDoc.setFontSize(8); pdfDoc.setTextColor(180, 80, 0); pdfDoc.text(`Due: ${invDueDate}`, margin, y); pdfDoc.setTextColor(0,0,0); }
      const fy = selectedProject.invoice_date
        ? (() => { const d = new Date(selectedProject.invoice_date); const m = d.getMonth(); const yr = d.getFullYear(); return m < 3 ? `${yr-1}-${String(yr).slice(-2)}` : `${yr}-${String(yr+1).slice(-2)}`; })()
        : '';
      if (fy) { pdfDoc.setFontSize(8); pdfDoc.setTextColor(100, 100, 100); pdfDoc.text(`Financial Year: ${fy}`, pageWidth - margin, y, { align: 'right' }); pdfDoc.setTextColor(0,0,0); }
      y += 4;

      // Bill To / Supply Info Box
      pdfDoc.setDrawColor(200, 200, 220); pdfDoc.setLineWidth(0.3);
      const boxH = 34;
      pdfDoc.rect(margin, y, pageWidth - margin * 2, boxH, 'S');
      // Split box vertically at center
      const midX = margin + (pageWidth - margin * 2) / 2;
      pdfDoc.setDrawColor(200, 200, 220); pdfDoc.line(midX, y, midX, y + boxH);

      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(80, 80, 80);
      pdfDoc.text('BILL TO', margin + 2, y + 5);
      pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(0, 0, 0); pdfDoc.setFontSize(9);
      pdfDoc.text(client?.name || '—', margin + 2, y + 11);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(60, 60, 60);
      const cAddr = pdfDoc.splitTextToSize(client?.address || '', 85);
      pdfDoc.text(cAddr, margin + 2, y + 17);
      if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, margin + 2, y + 17 + cAddr.length * 4);

      pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(80, 80, 80);
      pdfDoc.text('SUPPLY DETAILS', midX + 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(60, 60, 60);
      pdfDoc.text(`Project: ${selectedProject.project_name}`, midX + 2, y + 11);
      pdfDoc.text(`Venue: ${selectedProject.venue || '—'}`, midX + 2, y + 16);
      pdfDoc.text(`Period: ${selectedProject.start_date || '—'} to ${selectedProject.end_date || '—'}`, midX + 2, y + 21);
      pdfDoc.text(`Place of Supply: ${gstBD.placeOfSupply || '—'} · ${isIGST ? 'IGST (Inter-State)' : 'CGST+SGST (Intra-State)'}`, midX + 2, y + 27);
      pdfDoc.setTextColor(0, 0, 0);
      y += boxH + 4;

      // --- ITEM TABLE ---
      const colHeaders = isIGST
        ? ['#', 'HSN', 'Description', 'Qty', 'Days', 'Rate', 'Taxable', 'IGST %', 'IGST Amt', 'Total']
        : ['#', 'HSN', 'Description', 'Qty', 'Days', 'Rate', 'Taxable', 'CGST %', 'CGST Amt', 'SGST %', 'SGST Amt', 'Total'];

      const tableRows = gstBD.items.map((item, i) => {
        const base = isIGST
          ? [i + 1, item.hsn, item.description, item.qty || 1, item.days || 1,
              item.rate ? formatCurrencyPDF(item.rate) : '—',
              formatCurrencyPDF(item.taxable),
              `${item.igstRate}%`, formatCurrencyPDF(item.igstAmt),
              formatCurrencyPDF(item.total)]
          : [i + 1, item.hsn, item.description, item.qty || 1, item.days || 1,
              item.rate ? formatCurrencyPDF(item.rate) : '—',
              formatCurrencyPDF(item.taxable),
              `${item.cgstRate}%`, formatCurrencyPDF(item.cgstAmt),
              `${item.sgstRate}%`, formatCurrencyPDF(item.sgstAmt),
              formatCurrencyPDF(item.total)];
        return base;
      });

      const colStyles = isIGST
        ? { 0: { cellWidth: 7 }, 1: { cellWidth: 16 }, 3: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'center' }, 8: { halign: 'right' }, 9: { halign: 'right' } }
        : { 0: { cellWidth: 6 }, 1: { cellWidth: 14 }, 3: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'center' }, 8: { halign: 'right' }, 9: { halign: 'center' }, 10: { halign: 'right' }, 11: { halign: 'right' } };

      autoTable(pdfDoc, {
        startY: y,
        head: [colHeaders],
        body: tableRows,
        theme: 'grid',
        headStyles: { fillColor: [30, 64, 175], fontSize: 7.5, textColor: [255, 255, 255] },
        styles: { fontSize: 7.5, cellPadding: 1.8 },
        columnStyles: colStyles,
        didDrawPage: () => { drawCompactHeader(); }
      });
      y = pdfDoc.lastAutoTable.finalY + 4;

      // --- GST SUMMARY TABLE ---
      const summaryRows = [];
      if (isIGST) {
        summaryRows.push(['Taxable Amount', formatCurrencyPDF(gstBD.totals.taxable)]);
        summaryRows.push([`IGST`, formatCurrencyPDF(gstBD.totals.igstAmt)]);
      } else {
        summaryRows.push(['Taxable Amount', formatCurrencyPDF(gstBD.totals.taxable)]);
        summaryRows.push([`CGST`, formatCurrencyPDF(gstBD.totals.cgstAmt)]);
        summaryRows.push([`SGST`, formatCurrencyPDF(gstBD.totals.sgstAmt)]);
      }
      summaryRows.push(['GRAND TOTAL', formatCurrencyPDF(gstBD.totals.total)]);

      if (y + 40 > pageH - 20) { y = addNewPage(); }
      autoTable(pdfDoc, {
        startY: y,
        body: summaryRows,
        theme: 'plain',
        styles: { fontSize: 9, cellPadding: 2 },
        columnStyles: { 0: { halign: 'right', fontStyle: 'bold', cellWidth: 130 }, 1: { halign: 'right' } },
        didParseCell: (data) => {
          if (data.row.index === summaryRows.length - 1) {
            data.cell.styles.fontStyle = 'bold'; data.cell.styles.fontSize = 11.5;
            data.cell.styles.textColor = [30, 64, 175];
          }
        },
        didDrawPage: () => { drawCompactHeader(); }
      });
      y = pdfDoc.lastAutoTable.finalY + 6;

      // --- BANK DETAILS ---
      const banks = org?.bank_accounts || [];
      const defBank = banks.find(b => b.id === org?.default_bank_id) || banks[0];
      if (defBank) {
        if (y + 32 > pageH - 14) { y = addNewPage(); }
        pdfDoc.setFillColor(240, 245, 255); pdfDoc.setDrawColor(180, 200, 240); pdfDoc.setLineWidth(0.3);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, 28, 'FD');
        pdfDoc.setFontSize(8.5); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(30, 64, 175);
        pdfDoc.text('Bank Details (for NEFT/RTGS)', margin + 3, y + 6);
        pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(0, 0, 0); pdfDoc.setFontSize(8);
        pdfDoc.text(`Bank: ${defBank.bank_name || ''}`, margin + 3, y + 12);
        pdfDoc.text(`A/c No: ${defBank.account_number || ''}`, margin + 3, y + 17);
        pdfDoc.text(`IFSC: ${defBank.ifsc || ''}`, margin + 3, y + 22);
        pdfDoc.text(`A/c Name: ${defBank.account_name || org?.name || ''}`, pageWidth / 2, y + 12);
        pdfDoc.text(`Branch: ${defBank.branch || ''}`, pageWidth / 2, y + 17);
        y += 32;
      }

      // --- REMARKS ---
      const invRemarks = selectedProject.invoice_remarks || '';
      if (invRemarks) {
        if (y + 16 > pageH - 10) { y = addNewPage(); }
        pdfDoc.setFillColor(255, 249, 230); pdfDoc.setDrawColor(220, 180, 60); pdfDoc.setLineWidth(0.3);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, 14, 'FD');
        pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(120, 80, 0);
        pdfDoc.text('Remarks:', margin + 2, y + 5);
        pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(60, 40, 0);
        const remarkLines = pdfDoc.splitTextToSize(invRemarks, pageWidth - margin * 2 - 20);
        pdfDoc.text(remarkLines, margin + 22, y + 5);
        y += 14 + (remarkLines.length - 1) * 4;
      }

      // --- TERMS ---
      if (y + 20 > pageH - 10) { y = addNewPage(); }
      pdfDoc.setFontSize(7.5); pdfDoc.setFont('helvetica', 'italic'); pdfDoc.setTextColor(120, 120, 120);
      pdfDoc.text('This is a computer-generated Tax Invoice and is valid without a signature.', margin, y);
      const invoiceTerms = org?.invoice_terms || org?.terms || '';
      if (invoiceTerms) {
        y += 5;
        pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setFontSize(7.5); pdfDoc.setTextColor(80, 80, 80);
        pdfDoc.text('Terms & Conditions:', margin, y);
        y += 4;
        pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(100, 100, 100);
        const termLines = pdfDoc.splitTextToSize(invoiceTerms, pageWidth - margin * 2);
        pdfDoc.text(termLines, margin, y);
      }

      const safeName = (selectedProject.project_name || 'project').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      pdfDoc.save(`TaxInvoice_${invNo.replace(/\//g, '-')}_${safeName}.pdf`);
      logAction('projects', 'generate_tax_invoice_pdf', selectedProject.id, { invoice_no: invNo }, selectedProject.project_name);
    } catch (err) {
      console.error('Tax Invoice PDF Error:', err);
      addToast('Failed to generate Tax Invoice PDF', 'error');
    }
  };


  export const generateProformaInvoicePDF = async (piData, ctx) => {
  const { canManageProjectInvoices, addToast, getOrgSettings, clients, selectedProject } = ctx;
    if (!canManageProjectInvoices) {
      addToast('Access denied: proforma documents are restricted.', 'error');
      return;
    }
    try {
      const pdfDoc = new jsPDF();
      const org = await getOrgSettings();
      const client = clients.find(c => c.id === selectedProject.client_id);
      const pageWidth = pdfDoc.internal.pageSize.width;
      const pageH = pdfDoc.internal.pageSize.height;
      const margin = 14;
      const COMPACT_HEADER_H = 28; // height occupied by compact header on pages 2+
      const piDate = piData.date ? new Date(piData.date).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN');
      let y = 15;

      // ── Compact header drawn on every page except page 1 ──────────────────
      const drawCompactHeader = () => {
        const currentPage = pdfDoc.internal.getCurrentPageInfo().pageNumber;
        if (currentPage === 1) return;
        pdfDoc.setFillColor(41, 51, 61);
        pdfDoc.rect(margin, 5, pageWidth - margin * 2, 16, 'F');
        pdfDoc.setFontSize(10);
        pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.text(org?.name || 'Company', margin + 3, 14);
        pdfDoc.text('PROFORMA INVOICE', pageWidth / 2, 14, { align: 'center' });
        pdfDoc.text(`${piData.pi_no}  |  ${piDate}`, pageWidth - margin - 2, 14, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.text(selectedProject.project_name, pageWidth / 2, 20, { align: 'center' });
        pdfDoc.setTextColor(0, 0, 0);
      };

      // Helper: add page + compact header, returns starting y for content
      const addNewPage = () => {
        pdfDoc.addPage();
        drawCompactHeader();
        return COMPACT_HEADER_H + 2;
      };

      // ── PAGE 1 FULL HEADER ─────────────────────────────────────────────────
      if (org?.logo) {
        try { pdfDoc.addImage(org.logo, 'JPEG', margin, 10, 25, 25); } catch(e) { console.warn('Logo failed', e); }
      }
      pdfDoc.setFontSize(14);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text(org?.name || 'Company', pageWidth - margin, 18, { align: 'right' });
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'normal');
      const orgAddr = pdfDoc.splitTextToSize(org?.address || '', 80);
      pdfDoc.text(orgAddr, pageWidth - margin, 24, { align: 'right' });
      let orgInfoY = 24 + orgAddr.length * 4;
      if (org?.gstin) { pdfDoc.text(`GSTIN: ${org.gstin}`, pageWidth - margin, orgInfoY, { align: 'right' }); orgInfoY += 4; }
      if (org?.phone) { pdfDoc.text(`Ph: ${org.phone}`, pageWidth - margin, orgInfoY, { align: 'right' }); }

      // Title banner
      y = Math.max(orgInfoY + 6, 46);
      pdfDoc.setFillColor(41, 51, 61);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, 10, 'F');
      pdfDoc.setFontSize(13);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.setTextColor(255, 255, 255);
      pdfDoc.text('PROFORMA INVOICE', pageWidth / 2, y + 7, { align: 'center' });
      pdfDoc.setTextColor(0, 0, 0);
      y += 14;

      // PI number / date row
      pdfDoc.setFontSize(9);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('PI No: ', margin, y);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text(piData.pi_no, margin + 12, y);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text(`Date: ${piDate}`, pageWidth - margin, y, { align: 'right' });
      y += 6;

      // Client & Project Info box
      pdfDoc.setDrawColor(200, 200, 200);
      pdfDoc.setLineWidth(0.3);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, 28, 'S');
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('Bill To:', margin + 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text(client?.name || '—', margin + 2, y + 10);
      const cAddr = pdfDoc.splitTextToSize(client?.address || '', 85);
      pdfDoc.text(cAddr, margin + 2, y + 15);
      if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, margin + 2, y + 15 + cAddr.length * 4);
      pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('Project:', pageWidth / 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal');
      const projNameWrapped = pdfDoc.splitTextToSize(selectedProject.project_name, 80);
      pdfDoc.text(projNameWrapped, pageWidth / 2, y + 10);
      pdfDoc.text(`Venue: ${selectedProject.venue || '—'}`, pageWidth / 2, y + 18);
      pdfDoc.text(`Event: ${selectedProject.start_date || ''} to ${selectedProject.end_date || ''}`, pageWidth / 2, y + 23);
      y += 32;

      // ── ITEMS TABLE ───────────────────────────────────────────────────────
      const snapshotItems = piData.items_snapshot || [];
      const snapshotLogistics = piData.logistics_snapshot || {};
      const usePkgCost = piData.package_cost && piData.package_cost > 0;
      let tableBody = [];
      let grandTotal = 0;

      if (usePkgCost) {
        snapshotItems.forEach((item, idx) => {
          tableBody.push([idx + 1, item.item_name + (item.description ? `\n(${item.description})` : ''), item.qty, item.days, '—', '—', 'Included']);
        });
        const pkgGst = (piData.package_cost * (piData.package_cost_gst || 18)) / 100;
        grandTotal = piData.package_cost + pkgGst;
      } else {
        snapshotItems.forEach((item, idx) => {
          tableBody.push([idx + 1, item.item_name + (item.description ? `\n(${item.description})` : ''), item.qty, item.days, formatCurrencyPDF(item.rate), `${item.gst_rate}%`, formatCurrencyPDF(item.total)]);
          grandTotal += item.total || 0;
        });
        LOGISTICS_TYPES.forEach(lt => {
          const cost = snapshotLogistics[lt.id];
          if (cost && cost.amount > 0) {
            const ltTotal = cost.amount * (1 + (cost.gst || 0) / 100);
            tableBody.push([tableBody.length + 1, lt.label, 1, 1, formatCurrencyPDF(cost.amount), `${cost.gst || 0}%`, formatCurrencyPDF(ltTotal)]);
            grandTotal += ltTotal;
          }
        });
      }

      autoTable(pdfDoc, {
        startY: y,
        head: [['#', 'Description', 'Qty', 'Days', 'Rate', 'GST %', 'Amount']],
        body: tableBody,
        theme: 'grid',
        headStyles: { fillColor: [41, 51, 61], fontSize: 8 },
        styles: { fontSize: 8, cellPadding: 2 },
        columnStyles: { 0: { cellWidth: 8 }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'right' }, 5: { halign: 'center' }, 6: { halign: 'right' } },
        didDrawPage: () => { drawCompactHeader(); }
      });
      y = pdfDoc.lastAutoTable.finalY + 4;

      // Totals summary
      let summaryBody;
      if (usePkgCost) {
        const pkgGst = (piData.package_cost * (piData.package_cost_gst || 18)) / 100;
        summaryBody = [
          ['Package Cost (excl. GST)', formatCurrencyPDF(piData.package_cost)],
          [`GST (${piData.package_cost_gst || 18}%)`, formatCurrencyPDF(pkgGst)],
          ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
      } else {
        const subtotal = snapshotItems.reduce((a, i) => a + (i.amount || 0), 0) + LOGISTICS_TYPES.reduce((a, lt) => { const c = snapshotLogistics[lt.id]; return a + (c?.amount || 0); }, 0);
        const totalGst = grandTotal - subtotal;
        summaryBody = [
          ['Subtotal (excl. GST)', formatCurrencyPDF(subtotal)],
          ['Total GST', formatCurrencyPDF(totalGst)],
          ['Grand Total', formatCurrencyPDF(grandTotal)]
        ];
      }

      autoTable(pdfDoc, {
        startY: y,
        body: summaryBody,
        theme: 'plain',
        styles: { fontSize: 9, cellPadding: 2 },
        columnStyles: { 0: { halign: 'right', fontStyle: 'bold', cellWidth: 120 }, 1: { halign: 'right', fontStyle: 'normal' } },
        didParseCell: (data) => {
          if (data.row.index === summaryBody.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fontSize = 11;
            data.cell.styles.textColor = [79, 70, 229];
          }
        },
        didDrawPage: () => { drawCompactHeader(); }
      });
      y = pdfDoc.lastAutoTable.finalY + 8;

      // ── BANK DETAILS ──────────────────────────────────────────────────────
      if (y + 90 > pageH - 12) { y = addNewPage(); }
      const banks = org?.bank_accounts || [];
      const defBank = banks.find(b => b.id === org?.default_bank_id) || banks[0];
      if (defBank) {
        pdfDoc.setFillColor(240, 245, 255);
        pdfDoc.setDrawColor(180, 200, 240);
        pdfDoc.setLineWidth(0.3);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, 30, 'FD');
        pdfDoc.setFontSize(9);
        pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setTextColor(30, 60, 120);
        pdfDoc.text('Payment Bank Details:', margin + 3, y + 6);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.setTextColor(0, 0, 0);
        pdfDoc.setFontSize(8);
        const colW = (pageWidth - margin * 2) / 2 - 4;
        pdfDoc.text(`Bank: ${defBank.bank_name}`, margin + 3, y + 12);
        pdfDoc.text(`A/C Name: ${defBank.account_name}`, margin + 3, y + 17);
        pdfDoc.text(`A/C No: ${defBank.account_no}`, margin + 3, y + 22);
        pdfDoc.text(`IFSC: ${defBank.ifsc}${defBank.branch ? `  |  Branch: ${defBank.branch}` : ''}`, margin + colW + 6, y + 12);
        if (defBank.upi_id) pdfDoc.text(`UPI: ${defBank.upi_id}`, margin + colW + 6, y + 17);
        y += 34;
      }

      // Notes
      if (piData.notes) {
        if (y + 12 > pageH - 12) { y = addNewPage(); }
        pdfDoc.setFontSize(8);
        pdfDoc.setFont('helvetica', 'italic');
        pdfDoc.setTextColor(100, 100, 100);
        const noteLines = pdfDoc.splitTextToSize(`Notes: ${piData.notes}`, pageWidth - margin * 2);
        pdfDoc.text(noteLines, margin, y);
        pdfDoc.setTextColor(0, 0, 0);
        y += noteLines.length * 4 + 4;
      }

      // Disclaimer
      if (y + 8 > pageH - 12) { y = addNewPage(); }
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'italic');
      pdfDoc.setTextColor(150, 150, 150);
      pdfDoc.text('* This is a Proforma Invoice only and is NOT a Tax Invoice. Actual invoice will be raised after project completion.', margin, y);
      pdfDoc.setTextColor(0, 0, 0);
      y += 8;

      // Reference to T&C
      if (y + 50 > pageH - 12) { y = addNewPage(); }
      pdfDoc.setFontSize(8);
      pdfDoc.setFont('helvetica', 'italic');
      pdfDoc.setTextColor(80, 80, 80);
      pdfDoc.text('* Please read the Payment Terms and Conditions below before signing.', margin, y);
      pdfDoc.setTextColor(0, 0, 0);
      y += 6;

      // ── SIGNATURES ────────────────────────────────────────────────────────
      pdfDoc.setLineWidth(0.5);
      pdfDoc.setDrawColor(0, 0, 0);
      pdfDoc.line(margin, y + 15, margin + 60, y + 15);
      pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.setFontSize(8);
      pdfDoc.text('Authorized Signatory', margin, y + 20);
      pdfDoc.text(`For ${org?.name || 'Company'}`, margin, y + 25);
      pdfDoc.line(pageWidth - margin - 60, y + 15, pageWidth - margin, y + 15);
      pdfDoc.text("Client's Signature & Acceptance", pageWidth - margin - 60, y + 20);
      y += 32;

      // ── PAYMENT TERMS & CONDITIONS BOX ───────────────────────────────────
      const terms = piData.payment_terms || org?.payment_terms || '';
      if (terms) {
        if (y + 20 > pageH - 12) { y = addNewPage(); }
        const termLines = pdfDoc.splitTextToSize(terms, pageWidth - margin * 2 - 8);
        const boxH = termLines.length * 4.5 + 14;
        pdfDoc.setFillColor(255, 251, 235);
        pdfDoc.setDrawColor(210, 180, 80);
        pdfDoc.setLineWidth(0.4);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, boxH, 'FD');
        pdfDoc.setFontSize(8.5);
        pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setTextColor(120, 80, 0);
        pdfDoc.text('PAYMENT TERMS AND CONDITIONS', margin + 3, y + 7);
        pdfDoc.setLineWidth(0.2);
        pdfDoc.line(margin + 3, y + 9, margin + (pageWidth - margin * 2) - 3, y + 9);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.setFontSize(8);
        pdfDoc.setTextColor(60, 40, 0);
        pdfDoc.text(termLines, margin + 4, y + 13);
        pdfDoc.setTextColor(0, 0, 0);
        pdfDoc.setDrawColor(0, 0, 0);
      }

      // ── PAGE NUMBERS (post-process all pages) ────────────────────────────
      const totalPages = pdfDoc.internal.getNumberOfPages();
      for (let pg = 1; pg <= totalPages; pg++) {
        pdfDoc.setPage(pg);
        pdfDoc.setFontSize(7.5);
        pdfDoc.setFont('helvetica', 'normal');
        pdfDoc.setTextColor(140, 140, 140);
        pdfDoc.text(
          `Page ${pg} of ${totalPages}`,
          pageWidth - margin,
          pageH - 4,
          { align: 'right' }
        );
        pdfDoc.text(
          `${piData.pi_no}  |  ${selectedProject.project_name}`,
          margin,
          pageH - 4
        );
        pdfDoc.setTextColor(0, 0, 0);
      }

      pdfDoc.save(`ProformaInvoice_${piData.pi_no.replace(/\//g, '-')}_${selectedProject.project_name.replace(/\s/g, '_')}.pdf`);
    } catch (err) {
      console.error('Proforma Invoice PDF Error:', err);
      addToast('Failed to generate Proforma Invoice PDF', 'error');
    }
  };

  export const printChallanPDF = async (challanData, ctx) => {
  const { getOrgSettings, clients, selectedProject, challanForm, inventory } = ctx;
    try {
        const pdfDoc = new jsPDF();
        const pageWidth = pdfDoc.internal.pageSize.width;
        const orgSettings = await getOrgSettings();
        const isReturn = challanData.type === 'return';
        const displayChallanNo = isReturn ? `RET/${challanData.challan_no}` : challanData.challan_no;
        const todayStr = new Date(challanData.date).toLocaleDateString('en-IN');

        // --- Header Section (Org Details) ---
        let y = 15;
        if (orgSettings?.logo) {
            try {
                pdfDoc.addImage(orgSettings.logo, 'JPEG', 14, 10, 25, 25);
            } catch (e) { console.warn("Logo add failed", e); }
        }
        
        pdfDoc.setFontSize(16);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(orgSettings?.name || "RENTAL OPS", 45, 18);
        
        pdfDoc.setFontSize(9);
        pdfDoc.setFont("helvetica", "normal");
        const addrLines = pdfDoc.splitTextToSize(orgSettings?.address || "", 100);
        pdfDoc.text(addrLines, 45, 24);
        
        let headerY = 24 + (addrLines.length * 4);
        if (orgSettings?.gstin) pdfDoc.text(`GSTIN: ${orgSettings.gstin}`, 45, headerY);
        if (orgSettings?.pan) pdfDoc.text(`PAN: ${orgSettings.pan}`, 100, headerY);
        
        // Ensure we start below the header
        y = Math.max(y + 25, headerY + 10);

        // Title
        pdfDoc.setFontSize(14);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "RETURN CHALLAN" : "DELIVERY CHALLAN", pageWidth - 14, 20, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(isReturn ? "(Material Returning from Project)" : "(Authority to carry inventory for Project Execution)", pageWidth - 14, 25, { align: 'right' });

        pdfDoc.setFontSize(10);
        pdfDoc.text(`Challan No: ${displayChallanNo}`, pageWidth - 14, 32, { align: 'right' });
        pdfDoc.text(`Date: ${todayStr}`, pageWidth - 14, 37, { align: 'right' });

        pdfDoc.setLineWidth(0.5); pdfDoc.line(14, y, pageWidth - 14, y);
        y += 5;

        // --- Consignee & Transport Details ---
        const client = clients.find(c=>c.id===selectedProject.client_id);
        
        // Left: Consignee
        pdfDoc.setFontSize(10);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "Received From (Client):" : "Consignee (Client):", 14, y);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(client?.name || '-', 14, y + 5);
        const clientAddr = pdfDoc.splitTextToSize(client?.address || "Address not available", 80);
        pdfDoc.text(clientAddr, 14, y + 10);
        if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, 14, y + 10 + (clientAddr.length * 4) + 2);

        // Right: Transport & Project
        pdfDoc.text(`Project: ${selectedProject.project_name}`, 110, y);
        pdfDoc.text(`Venue: ${selectedProject.venue}`, 110, y + 5);
        pdfDoc.text(isReturn ? `Return To: ${orgSettings?.address ? 'Warehouse / Office' : 'Warehouse'}` : `Dispatch To: ${challanForm.dispatch_address || selectedProject.venue}`, 110, y + 10);
        
        // Calculate Y based on address height to avoid overlap
        y = Math.max(y + 25, y + 10 + (clientAddr.length * 4) + 10);

        const transport = challanData.transport || {};
        pdfDoc.rect(14, y, pageWidth - 28, 18);
        pdfDoc.setFontSize(9);
        pdfDoc.text(`Transport Mode: ${transport.mode || '-'}`, 16, y + 6);
        pdfDoc.text(`Vehicle No: ${transport.vehicle_no || '-'}`, 80, y + 6);
        pdfDoc.text(`E-Way Bill: ${transport.eway_bill || '-'}`, 150, y + 6);
        pdfDoc.text(`Driver: ${transport.driver_name || '-'} (${transport.driver_mobile || '-'})`, 16, y + 12);

        // --- Inventory Table ---
        y += 25;
        const items = (challanData.items || []).map((i, idx) => {
            const invItem = inventory.find(inv => inv.id === i.item_id);
            return [
                idx + 1, 
                `${i.item_name}\nSN: ${invItem?.serial_number || '-'}`, 
                invItem?.hsn_code || '-',
                i.qty, 
                `${i.days} Days`,
                formatCurrencyPDF(i.rate),
                formatCurrencyPDF(i.total)
            ];
        });

        autoTable(pdfDoc, { 
            startY: y, 
            head: [['#', 'Description of Goods', 'HSN/SAC', 'Qty', 'Duration', 'Rate', 'Amount']], 
            body: items, 
            theme: 'grid',
            margin: { left: 14, right: 14 },
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' }, 
            headStyles: { fillColor: [50, 50, 50], textColor: 255 },
            columnStyles: { 
                0: { cellWidth: 8 }, 
                1: { cellWidth: 58 }, 
                2: { cellWidth: 14 },
                3: { cellWidth: 10, halign: 'center' },
                4: { cellWidth: 14, halign: 'center' },
                5: { cellWidth: 18, halign: 'right' },
                6: { cellWidth: 54, halign: 'right', cellPadding: { top: 2, bottom: 2, left: 2, right: 10 } }
            }
        });
        
        let finalY = ((pdfDoc.lastAutoTable && pdfDoc.lastAutoTable.finalY) || y + 50) + 10;

        if (orgSettings?.challan_terms) {
            pdfDoc.setFontSize(9);
            pdfDoc.setFont("helvetica", "bold");
            pdfDoc.text("Terms & Conditions:", 14, finalY);
            pdfDoc.setFont("helvetica", "normal");
            pdfDoc.setFontSize(8);
            const terms = pdfDoc.splitTextToSize(orgSettings.challan_terms, pageWidth - 28);
            pdfDoc.text(terms, 14, finalY + 5);
            finalY += 10 + (terms.length * 3.5);
        }
        
        // --- Footer / Declarations ---
        pdfDoc.setFontSize(8);
        pdfDoc.text("Declaration:", 14, finalY);
        pdfDoc.text(isReturn ? "1. Material returning from project site to warehouse." : "1. The goods are being transported for project execution purpose only and not for sale.", 14, finalY + 5);
        pdfDoc.text(isReturn ? "2. Not for sale." : "2. The goods will be returned to the consignor after completion of the project.", 14, finalY + 9);
        
        pdfDoc.setLineWidth(0.5); 
        pdfDoc.line(14, finalY + 25, 80, finalY + 25); 
        pdfDoc.text("Authorized Signatory", 14, finalY + 30); 
        pdfDoc.text(`For ${orgSettings?.name || 'Company'}`, 14, finalY + 34);

        pdfDoc.line(pageWidth - 90, finalY + 25, pageWidth - 14, finalY + 25); 
        pdfDoc.text(isReturn ? "Sender's Signature (Client)" : "Receiver's Signature & Stamp", pageWidth - 90, finalY + 30);
        
        pdfDoc.save(`${isReturn ? 'Return' : 'Delivery'}_Challan_${displayChallanNo.replace('/','-')}.pdf`);
    } catch (error) {
        console.error("Challan PDF Error:", error);
        alert("Failed to generate Challan PDF. See console for details.");
    }
  };


  export const downloadEWayBillJSON = async (ctx) => {
  const { getOrgSettings, clients, selectedProject, challanSelection, inventory, challanForm } = ctx;
    const orgSettings = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    
    if (!orgSettings || !client) return alert("Organization or Client details missing.");

    const itemsToShip = (selectedProject.items || []).filter(item => (challanSelection[item.id] || 0) > 0).map(item => ({
        ...item,
        qty: parseInt(challanSelection[item.id])
    }));

    if (itemsToShip.length === 0) return alert("Select items first.");

    const ewayData = {
        "supplyType": "O",
        "subSupplyType": "8", // Exhibition or Fairs
        "docType": "CHL",
        "docNo": "DRAFT",
        "docDate": new Date().toLocaleDateString('en-IN'),
        "fromGstin": orgSettings.gstin || "URP",
        "fromTrdName": orgSettings.name || "",
        "fromAddr1": orgSettings.address || "",
        "fromPlace": "", 
        "fromPincode": 100000, // Placeholder
        "toGstin": client.gstin || "URP",
        "toTrdName": client.name || "",
        "toAddr1": client.address || "",
        "toPlace": "",
        "toPincode": 100000, // Placeholder
        "itemList": itemsToShip.map(item => ({
            "productName": item.item_name,
            "hsnCode": parseInt(inventory.find(i=>i.id===item.item_id)?.hsn_code || 0),
            "quantity": parseInt(item.qty),
            "qtyUnit": "NOS",
            "taxableAmount": parseFloat(item.amount),
            "sgstRate": 0, "cgstRate": 0, "igstRate": 0 // Rates to be filled by user in portal if needed
        })),
        "transMode": challanForm.mode === 'Road' ? 1 : challanForm.mode === 'Rail' ? 2 : challanForm.mode === 'Air' ? 3 : 4,
        "transDistance": 0,
        "transporterName": "",
        "transDocNo": challanForm.eway_bill || "",
        "transDocDate": new Date().toLocaleDateString('en-IN'),
        "vehicleNo": challanForm.vehicle_no || ""
    };

    const blob = new Blob([JSON.stringify(ewayData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EWayBill_${selectedProject.challan_no || 'Draft'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

