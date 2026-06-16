// Project quotation PDF/Excel generators — extracted from Projects.jsx.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "@e965/xlsx";
import { formatCurrencyPDF, getLogisticsLines, calculateLEDSignalPorts } from "../helpers";

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

