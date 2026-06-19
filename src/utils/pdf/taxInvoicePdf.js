// Tax-invoice PDF generators — extracted from TaxInvoices.jsx to shrink the page.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";
import { formatCurrencyPDF, fmtDate, getFYFromDate, getProjectGSTBreakdown, getProjectGrandTotal, amountToWordsINR, round2 } from "../helpers";
import { GST_STATE_CODES } from "../constants";

  export const generateClassicInvoicePDF = async (invoice, ctx) => {
  const { clients, projects, getOrgSettings, logAction, addToast } = ctx;
    try {
      // H-12: prefer the org/bill-to snapshot captured at invoice issue time so
      // PDFs reflect the company/client identity AS OF the invoice date even
      // if those master records are later edited. Fall back to live data for
      // legacy invoices that were issued before snapshotting was added.
      const liveOrg = await getOrgSettings();
      const orgSnap = invoice.org_snapshot || null;
      const org = orgSnap ? {
        name: orgSnap.name,
        gstin: orgSnap.gstin,
        pan: orgSnap.pan,
        address: orgSnap.address,
        state: orgSnap.state,
        phone: orgSnap.phone,
        email: orgSnap.email,
        logo: orgSnap.logo_url,
        bank_name: orgSnap.bank_name,
        bank_account: orgSnap.bank_account,
        ifsc: orgSnap.ifsc,
      } : liveOrg;
      const client = clients.find(c => c.id === invoice.client_id);
      const billSnap = invoice.bill_to_snapshot || null;
      const billToName = billSnap?.name || invoice.sale_company_name || client?.name || '—';
      const billToAddress = billSnap?.address || invoice.sale_company_address || client?.address || '';
      const billToGstin = billSnap?.gstin || invoice.sale_company_gstin || client?.gstin || '';
      const linkedProjects = projects.filter(p => (invoice.project_ids || []).includes(p.id));
      const pdfDoc = new jsPDF();
      const pageWidth = pdfDoc.internal.pageSize.width;
      const pageH = pdfDoc.internal.pageSize.height;
      const margin = 14;
      const invDate = invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('en-IN') : '';
      const invNo = invoice.invoice_no || '—';
      const dueDate = invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : '';

      // GST direction based on first project
      const firstProject = linkedProjects[0];
      const gstBD0 = firstProject
        ? getProjectGSTBreakdown(firstProject, org?.gstin || '', billToGstin || '')
        : { supplyType: 'CGST_SGST', items: [], totals: { taxable: 0, cgstAmt: 0, sgstAmt: 0, igstAmt: 0, total: 0 }, placeOfSupply: '' };
      const isIGST = gstBD0.supplyType === 'IGST';

      const drawCompactHeader = () => {
        if (pdfDoc.internal.getCurrentPageInfo().pageNumber === 1) return;
        pdfDoc.setFillColor(30, 64, 175); pdfDoc.rect(margin, 5, pageWidth - margin * 2, 16, 'F');
        pdfDoc.setFontSize(10); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.text(org?.name || 'Company', margin + 3, 14);
        pdfDoc.text('TAX INVOICE', pageWidth / 2, 14, { align: 'center' });
        pdfDoc.text(`${invNo} | ${invDate}`, pageWidth - margin - 2, 14, { align: 'right' });
        pdfDoc.setTextColor(0, 0, 0);
      };
      const addNewPage = () => { pdfDoc.addPage(); drawCompactHeader(); return 32; };

      let y = 12;

      // Org header
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

      // Title banner
      y = Math.max(hY + 6, 44);
      pdfDoc.setFillColor(30, 64, 175); pdfDoc.rect(margin, y, pageWidth - margin * 2, 10, 'F');
      pdfDoc.setFontSize(13); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(255, 255, 255);
      pdfDoc.text('TAX INVOICE', pageWidth / 2, y + 7, { align: 'center' });
      pdfDoc.setTextColor(0, 0, 0); y += 14;

      // Invoice meta
      pdfDoc.setFontSize(9); pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('Invoice No: ', margin, y); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.text(invNo, margin + 22, y);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.text(`Date: ${invDate}`, pageWidth - margin, y, { align: 'right' });
      y += 5;
      if (dueDate) { pdfDoc.setFontSize(8); pdfDoc.setTextColor(180, 80, 0); pdfDoc.text(`Due: ${dueDate}`, margin, y); pdfDoc.setTextColor(0,0,0); }
      const fy = getFYFromDate(invoice.invoice_date);
      pdfDoc.setFontSize(8); pdfDoc.setTextColor(100,100,100); pdfDoc.text(`FY: ${fy}`, pageWidth - margin, y, { align: 'right' }); pdfDoc.setTextColor(0,0,0); y += 5;
      // Invoice type
      if (invoice.invoice_type && invoice.invoice_type !== 'Invoice') {
        pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(80,40,120);
        pdfDoc.text(`[${invoice.invoice_type}]`, margin, y); pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(0,0,0); y += 5;
      }

      // Bill To box
      const boxH = Math.max(36, 11 + linkedProjects.length * 5 + 8);
      pdfDoc.setDrawColor(200,200,220); pdfDoc.setLineWidth(0.3);
      pdfDoc.rect(margin, y, pageWidth - margin * 2, boxH, 'S');
      const midX = margin + (pageWidth - margin * 2) / 2;
      pdfDoc.line(midX, y, midX, y + boxH);

      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(80,80,80);
      pdfDoc.text('BILL TO', margin + 2, y + 5);
      pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(0,0,0); pdfDoc.setFontSize(9);
      pdfDoc.text(billToName, margin + 2, y + 11);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(60,60,60);
      const cAddr = pdfDoc.splitTextToSize(billToAddress || '', 85);
      pdfDoc.text(cAddr, margin + 2, y + 17);
      if (billToGstin) pdfDoc.text(`GSTIN: ${billToGstin}`, margin + 2, y + 17 + cAddr.length * 4);

      pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setFontSize(8); pdfDoc.setTextColor(80,80,80);
      pdfDoc.text('PROJECTS / SUPPLY', midX + 2, y + 5);
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(7.5); pdfDoc.setTextColor(60,60,60);
      linkedProjects.slice(0, 6).forEach((p, i) => {
        pdfDoc.text(`• ${p.project_name} (${fmtDate(p.start_date)}–${fmtDate(p.end_date)})`, midX + 2, y + 11 + i * 5);
      });
      if (linkedProjects.length > 6) pdfDoc.text(`  + ${linkedProjects.length - 6} more...`, midX + 2, y + 11 + 6 * 5);
      if (gstBD0.placeOfSupply) {
        pdfDoc.text(`Place of Supply: ${gstBD0.placeOfSupply} · ${isIGST ? 'IGST' : 'CGST+SGST'}`, midX + 2, y + boxH - 5);
      }
      pdfDoc.setTextColor(0,0,0); y += boxH + 4;

      // Aggregate items from all projects
      const allItems = [];
      linkedProjects.forEach(p => {
        const bd = getProjectGSTBreakdown(p, org?.gstin || '', client?.gstin || '');
        allItems.push(...bd.items);
      });

      const colHeaders = isIGST
        ? ['#','HSN','Description','Qty','Days','Rate','Taxable','IGST%','IGST Amt','Total']
        : ['#','HSN','Description','Qty','Days','Rate','Taxable','CGST%','CGST Amt','SGST%','SGST Amt','Total'];

      const tableRows = allItems.map((item, i) =>
        isIGST
          ? [i+1, item.hsn, item.description, item.qty||1, item.days||1, item.rate ? formatCurrencyPDF(item.rate) : '—', formatCurrencyPDF(item.taxable), `${item.igstRate}%`, formatCurrencyPDF(item.igstAmt), formatCurrencyPDF(item.total)]
          : [i+1, item.hsn, item.description, item.qty||1, item.days||1, item.rate ? formatCurrencyPDF(item.rate) : '—', formatCurrencyPDF(item.taxable), `${item.cgstRate}%`, formatCurrencyPDF(item.cgstAmt), `${item.sgstRate}%`, formatCurrencyPDF(item.sgstAmt), formatCurrencyPDF(item.total)]
      );

      const colStyles = isIGST
        ? { 0:{cellWidth:7}, 1:{cellWidth:14}, 3:{halign:'center'}, 4:{halign:'center'}, 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'center'}, 8:{halign:'right'}, 9:{halign:'right'} }
        : { 0:{cellWidth:6}, 1:{cellWidth:12}, 3:{halign:'center'}, 4:{halign:'center'}, 5:{halign:'right'}, 6:{halign:'right'}, 7:{halign:'center'}, 8:{halign:'right'}, 9:{halign:'center'}, 10:{halign:'right'}, 11:{halign:'right'} };

      autoTable(pdfDoc, {
        startY: y, head: [colHeaders], body: tableRows, theme: 'grid',
        headStyles: { fillColor: [30,64,175], fontSize: 7.5, textColor: [255,255,255] },
        styles: { fontSize: 7.5, cellPadding: 1.8 }, columnStyles: colStyles,
        didDrawPage: () => drawCompactHeader(),
      });
      y = pdfDoc.lastAutoTable.finalY + 4;

      // GST summary
      let totTaxable=0, totCgst=0, totSgst=0, totIgst=0, totTotal=0;
      allItems.forEach(item => { totTaxable+=item.taxable; totCgst+=item.cgstAmt||0; totSgst+=item.sgstAmt||0; totIgst+=item.igstAmt||0; totTotal+=item.total; });

      const summaryRows = [['Taxable Amount', formatCurrencyPDF(totTaxable)]];
      if (isIGST) { summaryRows.push(['IGST', formatCurrencyPDF(totIgst)]); }
      else { summaryRows.push(['CGST', formatCurrencyPDF(totCgst)]); summaryRows.push(['SGST', formatCurrencyPDF(totSgst)]); }

      const finalAmt = invoice.final_amount != null ? invoice.final_amount : totTotal;
      if (Math.abs(finalAmt - totTotal) > 0.01) {
        summaryRows.push(['Sub-Total (as calculated)', formatCurrencyPDF(totTotal)]);
        summaryRows.push(['Adjustment / Agreed Amount', formatCurrencyPDF(finalAmt - totTotal)]);
      }
      summaryRows.push(['GRAND TOTAL', formatCurrencyPDF(finalAmt)]);

      if (y + 40 > pageH - 20) { y = addNewPage(); }
      autoTable(pdfDoc, {
        startY: y, body: summaryRows, theme: 'plain', styles: { fontSize: 9, cellPadding: 2 },
        columnStyles: { 0:{halign:'right', fontStyle:'bold', cellWidth:130}, 1:{halign:'right'} },
        didParseCell: (data) => {
          if (data.row.index === summaryRows.length - 1) {
            data.cell.styles.fontStyle='bold'; data.cell.styles.fontSize=11.5; data.cell.styles.textColor=[30,64,175];
          }
        },
        didDrawPage: () => drawCompactHeader(),
      });
      y = pdfDoc.lastAutoTable.finalY + 6;

      // Bank details
      const banks = org?.bank_accounts || [];
      const defBank = banks.find(b => b.id === org?.default_bank_id) || banks[0];
      if (defBank) {
        if (y + 32 > pageH - 14) { y = addNewPage(); }
        pdfDoc.setFillColor(240,245,255); pdfDoc.setDrawColor(180,200,240); pdfDoc.setLineWidth(0.3);
        pdfDoc.rect(margin, y, pageWidth - margin * 2, 28, 'FD');
        pdfDoc.setFontSize(8.5); pdfDoc.setFont('helvetica','bold'); pdfDoc.setTextColor(30,64,175);
        pdfDoc.text('Bank Details (for NEFT/RTGS)', margin+3, y+6);
        pdfDoc.setFont('helvetica','normal'); pdfDoc.setTextColor(0,0,0); pdfDoc.setFontSize(8);
        pdfDoc.text(`Bank: ${defBank.bank_name||''}`, margin+3, y+12);
        pdfDoc.text(`A/c No: ${defBank.account_number||''}`, margin+3, y+17);
        pdfDoc.text(`IFSC: ${defBank.ifsc||''}`, margin+3, y+22);
        pdfDoc.text(`A/c Name: ${defBank.account_name||org?.name||''}`, pageWidth/2, y+12);
        pdfDoc.text(`Branch: ${defBank.branch||''}`, pageWidth/2, y+17);
        y += 32;
      }

      // Remarks
      if (invoice.remarks) {
        if (y + 16 > pageH - 10) { y = addNewPage(); }
        pdfDoc.setFillColor(255,249,230); pdfDoc.setDrawColor(220,180,60); pdfDoc.setLineWidth(0.3);
        const remLines = pdfDoc.splitTextToSize(invoice.remarks, pageWidth - margin*2 - 22);
        const remH = Math.max(14, 8 + remLines.length * 4);
        pdfDoc.rect(margin, y, pageWidth - margin*2, remH, 'FD');
        pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica','bold'); pdfDoc.setTextColor(120,80,0);
        pdfDoc.text('Remarks:', margin+2, y+5);
        pdfDoc.setFont('helvetica','normal'); pdfDoc.setTextColor(60,40,0);
        pdfDoc.text(remLines, margin+22, y+5);
        y += remH + 4;
      }

      // Terms
      if (y + 20 > pageH - 10) { y = addNewPage(); }
      pdfDoc.setFontSize(7.5); pdfDoc.setFont('helvetica','italic'); pdfDoc.setTextColor(120,120,120);
      pdfDoc.text('This is a computer-generated Tax Invoice and is valid without a signature.', margin, y);
      const invoiceTerms = org?.invoice_terms || org?.terms || '';
      if (invoiceTerms) {
        y += 5;
        pdfDoc.setFont('helvetica','bold'); pdfDoc.setFontSize(7.5); pdfDoc.setTextColor(80,80,80);
        pdfDoc.text('Terms & Conditions:', margin, y); y += 4;
        pdfDoc.setFont('helvetica','normal'); pdfDoc.setTextColor(100,100,100);
        pdfDoc.text(pdfDoc.splitTextToSize(invoiceTerms, pageWidth-margin*2), margin, y);
      }

      // GST e-invoice IRN + signed QR (when generated via GSP)
      if (invoice.irn) {
        try {
          pdfDoc.setFontSize(7); pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(80, 80, 80);
          pdfDoc.text(`IRN: ${invoice.irn}`, margin, pageH - 6);
          if (invoice.signed_qr) {
            const qrImg = await QRCode.toDataURL(String(invoice.signed_qr), { margin: 0, width: 160 });
            pdfDoc.addImage(qrImg, 'PNG', pageWidth - margin - 22, pageH - 30, 22, 22);
            pdfDoc.text('e-Invoice', pageWidth - margin - 11, pageH - 6, { align: 'center' });
          }
          pdfDoc.setTextColor(0, 0, 0);
        } catch (e) { /* QR optional */ }
      }

      const fileName = `TaxInvoice_${invNo.replace(/\//g,'-')}_${(client?.name||'').replace(/\s+/g,'_')}.pdf`;
      if (ctx.deliver) return { doc: pdfDoc, filename: fileName };
      pdfDoc.save(fileName);
      logAction('tax_invoices', 'print_pdf', invoice.id, {}, invoice.invoice_no);
      return { doc: pdfDoc, filename: fileName };
    } catch (err) {
      console.error('Tax Invoice PDF Error:', err);
      addToast('Failed to generate PDF', 'error');
    }
  };

  // ── Vyapar-style GST tax invoice (alternate template) ──────────────────────
  const stateLabel = (gstin) => {
    const code = String(gstin || '').slice(0, 2);
    return GST_STATE_CODES[code] ? `${code}-${GST_STATE_CODES[code]}` : '';
  };

  export const generateGSTFormatInvoicePDF = async (invoice, ctx) => {
  const { clients, projects, payments, taxInvoices, getOrgSettings, logAction, addToast } = ctx;
    try {
      const liveOrg = await getOrgSettings();
      const snap = invoice.org_snapshot || {};
      const org = {
        name: snap.name || liveOrg?.name || 'Company',
        address: snap.address || liveOrg?.address || '',
        gstin: snap.gstin || liveOrg?.gstin || '',
        phone: snap.phone || liveOrg?.phone || '',
        email: snap.email || liveOrg?.email || '',
        logo: snap.logo_url || liveOrg?.logo || '',
        msme_reg: liveOrg?.msme_reg || '',
        signature: liveOrg?.signature || '',
        invoice_terms: liveOrg?.invoice_terms || liveOrg?.terms || '',
        bank_accounts: liveOrg?.bank_accounts || [],
        default_bank_id: liveOrg?.default_bank_id || '',
      };

      const client = clients.find(c => c.id === invoice.client_id);
      const billSnap = invoice.bill_to_snapshot || null;
      const billToName = billSnap?.name || invoice.sale_company_name || client?.name || '—';
      const billToAddress = billSnap?.address || invoice.sale_company_address || client?.address || '';
      const billToGstin = billSnap?.gstin || invoice.sale_company_gstin || client?.gstin || '';
      const billToContact = client?.contact_number || client?.phone || client?.mobile || '';

      const linkedProjects = projects.filter(p => (invoice.project_ids || []).includes(p.id));
      const allItems = [];
      linkedProjects.forEach(p => { allItems.push(...getProjectGSTBreakdown(p, org.gstin || '', billToGstin || '').items); });

      const isIGST = (invoice.supply_type || '') === 'IGST';
      const finalAmt = invoice.final_amount != null ? parseFloat(invoice.final_amount) : (invoice.computed_total || 0);
      const subTotal = round2(allItems.reduce((s, it) => s + (it.total || 0), 0));
      const roundOff = round2(finalAmt - subTotal);

      // Running balance — consistent with the client ledger: the client's billed
      // position EXCLUDING this invoice = other active tax invoices + delivered
      // projects NOT yet covered by any tax invoice (so project-billed revenue is
      // counted, not just tax_invoices) − all payments received.
      const cid = invoice.client_id;
      const clientPays = (payments || []).filter(p => p.client_id === cid || p.party_id === cid);
      const totalPaid = clientPays.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      const activeClientInvoices = (taxInvoices || []).filter(i => i.client_id === cid && i.status !== 'Cancelled');
      const otherInvTotal = activeClientInvoices
        .filter(i => i.id !== invoice.id)
        .reduce((s, i) => s + parseFloat(i.final_amount ?? i.computed_total ?? 0), 0);
      const invoicedPids = new Set();
      activeClientInvoices.forEach(i => {
        (Array.isArray(i.project_ids) ? i.project_ids : (i.project_id ? [i.project_id] : [])).forEach(pid => pid && invoicedPids.add(pid));
      });
      const projBilled = (projects || [])
        .filter(p => p.client_id === cid && ['Completed', 'Closed'].includes(p.status) && !invoicedPids.has(p.id))
        .reduce((s, p) => s + getProjectGrandTotal(p), 0);
      const previousBalance = round2(otherInvTotal + projBilled - totalPaid);
      const received = round2(clientPays.filter(p => p.invoice_id === invoice.id).reduce((s, p) => s + parseFloat(p.amount || 0), 0));
      const balance = round2(finalAmt - received);
      const currentBalance = round2(previousBalance + balance);

      // UPI QR
      const banks = org.bank_accounts || [];
      const defBank = banks.find(b => b.id === org.default_bank_id) || banks[0] || null;
      let qrDataUrl = null;
      if (defBank?.upi_id) {
        try {
          const upiStr = `upi://pay?pa=${defBank.upi_id}&pn=${encodeURIComponent(defBank.account_name || org.name)}&am=${finalAmt.toFixed(2)}&cu=INR`;
          qrDataUrl = await QRCode.toDataURL(upiStr, { margin: 1, width: 140 });
        } catch (_) { qrDataUrl = null; }
      }

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.width;
      const pageH = doc.internal.pageSize.height;
      const margin = 12;
      const right = pageWidth - margin;
      const invDate = invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('en-IN') : '';
      const dueDate = invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('en-IN') : '';

      // ── 1. Header: seller left, logo right ──
      let y = 14;
      doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text(org.name, margin, y);
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 70, 70);
      let hy = y + 5;
      const addrLines = doc.splitTextToSize(org.address || '', 120);
      doc.text(addrLines, margin, hy); hy += addrLines.length * 3.6;
      if (org.phone) { doc.text(`Phone no.: ${org.phone}`, margin, hy); hy += 3.6; }
      if (org.email) { doc.text(`Email: ${org.email}`, margin, hy); hy += 3.6; }
      if (org.gstin) { doc.text(`GSTIN: ${org.gstin}`, margin, hy); hy += 3.6; }
      const orgState = stateLabel(org.gstin);
      if (orgState) { doc.text(`State: ${orgState}`, margin, hy); hy += 3.6; }
      if (org.msme_reg) { doc.text(`MSME REGD.: ${org.msme_reg}`, margin, hy); hy += 3.6; }
      if (org.logo) { try { doc.addImage(org.logo, 'PNG', right - 32, y - 2, 32, 18); } catch (_) {} }

      y = Math.max(hy + 2, 40);
      doc.setDrawColor(150); doc.setLineWidth(0.4); doc.line(margin, y, right, y); y += 5;
      doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text('Tax Invoice', pageWidth / 2, y, { align: 'center' }); y += 5;

      // ── 2. Three-column block: Bill To | Transportation | Invoice Details ──
      const colW = (right - margin) / 3;
      const boxTop = y;
      const hasTransport = invoice.transport_name || invoice.vehicle_number || invoice.delivery_date || invoice.delivery_location;
      const cx1 = margin + 2, cx2 = margin + colW + 2, cx3 = margin + colW * 2 + 2;
      let yL = boxTop + 4, yM = boxTop + 4, yR = boxTop + 4;
      doc.setFontSize(7); doc.setTextColor(90, 90, 90); doc.setFont('helvetica', 'bold');
      doc.text('Bill To', cx1, yL); doc.text('Transportation Details', cx2, yM); doc.text('Invoice Details', cx3, yR);
      yL += 4; yM += 4; yR += 4;
      // Bill To
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(20, 20, 20);
      doc.text(billToName, cx1, yL); yL += 4;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(60, 60, 60);
      const bAddr = doc.splitTextToSize(billToAddress || '', colW - 4); doc.text(bAddr, cx1, yL); yL += bAddr.length * 3.4;
      if (billToContact) { doc.text(`Contact No.: ${billToContact}`, cx1, yL); yL += 3.4; }
      if (billToGstin) { doc.text(`GSTIN: ${billToGstin}`, cx1, yL); yL += 3.4; }
      const bState = stateLabel(billToGstin); if (bState) { doc.text(`State: ${bState}`, cx1, yL); yL += 3.4; }
      // Transportation
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(60, 60, 60);
      [['Transport Name:', invoice.transport_name], ['Vehicle Number:', invoice.vehicle_number],
       ['Delivery Date:', invoice.delivery_date ? new Date(invoice.delivery_date).toLocaleDateString('en-IN') : ''],
       ['Delivery Location:', invoice.delivery_location]].forEach(([k, v]) => {
        doc.text(`${k} ${v || ''}`, cx2, yM); yM += 3.6;
      });
      // Invoice Details
      doc.setFontSize(7); doc.setTextColor(60, 60, 60);
      const invRow = (k, v, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(`${k} ${v || ''}`, cx3, yR); yR += 3.8; };
      invRow('Invoice No.:', invoice.invoice_no || '—');
      invRow('Date:', invDate);
      invRow('Place of Supply:', invoice.place_of_supply || bState || '');
      if (dueDate) invRow('Due Date:', dueDate, true);
      if (invoice.po_date) invRow('PO date:', new Date(invoice.po_date).toLocaleDateString('en-IN'));
      if (invoice.po_number) invRow('PO number:', invoice.po_number);

      const boxBottom = Math.max(yL, hasTransport ? yM : boxTop + 8, yR) + 2;
      doc.setDrawColor(180); doc.setLineWidth(0.3);
      doc.rect(margin, boxTop, right - margin, boxBottom - boxTop, 'S');
      doc.line(margin + colW, boxTop, margin + colW, boxBottom);
      doc.line(margin + colW * 2, boxTop, margin + colW * 2, boxBottom);
      y = boxBottom + 4;

      // ── 3. Items table ──
      const itemRows = allItems.map((it, i) => {
        const gstAmt = (it.cgstAmt || 0) + (it.sgstAmt || 0) + (it.igstAmt || 0);
        const rate = isIGST ? (it.igstRate || 0) : ((it.cgstRate || 0) + (it.sgstRate || 0));
        return [
          i + 1,
          it.description || '',
          it.hsn || '',
          it.days != null ? it.days : '-',
          it.qty != null ? it.qty : '-',
          '-',
          it.rate ? formatCurrencyPDF(it.rate) : '-',
          `${formatCurrencyPDF(gstAmt)}\n(${rate}%)`,
          formatCurrencyPDF(it.total),
        ];
      });
      const totalGst = round2(allItems.reduce((s, it) => s + (it.cgstAmt || 0) + (it.sgstAmt || 0) + (it.igstAmt || 0), 0));
      autoTable(doc, {
        startY: y,
        head: [['#', 'Item name', 'HSN/SAC', 'DAYS', 'Quantity', 'Unit', 'Price/Unit', 'GST', 'Amount']],
        body: itemRows,
        foot: [['', 'Total', '', '', '', '', '', formatCurrencyPDF(totalGst), formatCurrencyPDF(subTotal)]],
        theme: 'grid',
        headStyles: { fillColor: [70, 110, 200], textColor: [255, 255, 255], fontSize: 7, halign: 'center' },
        footStyles: { fillColor: [235, 240, 250], textColor: [20, 20, 20], fontStyle: 'bold', fontSize: 7.5 },
        styles: { fontSize: 7, cellPadding: 1.6, valign: 'middle' },
        columnStyles: {
          0: { cellWidth: 7, halign: 'center' }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 18, halign: 'center' },
          3: { cellWidth: 11, halign: 'center' }, 4: { cellWidth: 15, halign: 'center' }, 5: { cellWidth: 10, halign: 'center' },
          6: { cellWidth: 24, halign: 'right' }, 7: { cellWidth: 26, halign: 'right' }, 8: { cellWidth: 28, halign: 'right' },
        },
      });
      y = doc.lastAutoTable.finalY + 4;

      // ── 4 & 5. Tax-type table (left) + totals stack (right) ──
      // Built from the STORED, reconciled invoice fields (taxable + GST === final
      // amount) so the tax shown always matches the invoice value — even when the
      // user entered a tax-inclusive final amount that differs from the quote.
      const txTaxable = round2(invoice.taxable || 0);
      const txCgst = round2(invoice.cgst_amount || 0);
      const txSgst = round2(invoice.sgst_amount || 0);
      const txIgst = round2(invoice.igst_amount || 0);
      const blendedRate = txTaxable > 0 ? Math.round((round2(invoice.gst_amount || 0) / txTaxable) * 100) : 18;
      const taxRows = [];
      if (isIGST) {
        taxRows.push(['IGST', formatCurrencyPDF(txTaxable), `${blendedRate}%`, formatCurrencyPDF(txIgst)]);
      } else {
        taxRows.push(['CGST', formatCurrencyPDF(txTaxable), `${blendedRate / 2}%`, formatCurrencyPDF(txCgst)]);
        taxRows.push(['SGST', formatCurrencyPDF(txTaxable), `${blendedRate / 2}%`, formatCurrencyPDF(txSgst)]);
      }
      const taxTableTop = y;
      autoTable(doc, {
        startY: y,
        head: [['Tax type', 'Taxable amount', 'Rate', 'Tax amount']],
        body: taxRows.length ? taxRows : [['—', formatCurrencyPDF(invoice.taxable || 0), '', formatCurrencyPDF(invoice.gst_amount || 0)]],
        theme: 'grid', tableWidth: 95, margin: { left: margin },
        headStyles: { fillColor: [70, 110, 200], textColor: [255, 255, 255], fontSize: 6.5 },
        styles: { fontSize: 6.5, cellPadding: 1.3 },
      });
      const taxTableBottom = doc.lastAutoTable.finalY;

      // Totals stack on the right
      const tlx = pageWidth / 2 + 8;
      let ty = taxTableTop + 2;
      const totRow = (label, val, opts = {}) => {
        doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
        doc.setFontSize(opts.big ? 9 : 7.5);
        doc.setTextColor(opts.muted ? 120 : 30, opts.muted ? 120 : 30, opts.muted ? 120 : 30);
        doc.text(label, tlx, ty);
        doc.text(val, right, ty, { align: 'right' });
        ty += opts.big ? 6 : 4.6;
      };
      totRow('Sub Total', formatCurrencyPDF(subTotal));
      if (Math.abs(roundOff) > 0.001) totRow(Math.abs(roundOff) < 1 ? 'Round off' : 'Adjustment', formatCurrencyPDF(roundOff));
      doc.setDrawColor(200); doc.line(tlx, ty - 1.5, right, ty - 1.5);
      totRow('Total', formatCurrencyPDF(finalAmt), { bold: true, big: true });
      totRow('Received', formatCurrencyPDF(received));
      totRow('Balance', formatCurrencyPDF(balance), { bold: true });
      doc.setDrawColor(220); doc.line(tlx, ty - 1.5, right, ty - 1.5);
      totRow('Previous Balance', formatCurrencyPDF(previousBalance), { muted: true });
      totRow('Current Balance', formatCurrencyPDF(currentBalance), { bold: true });

      y = Math.max(taxTableBottom, ty) + 5;

      // ── 6. Amount in words, payment mode, terms, MSME ──
      if (y + 30 > pageH - 50) { doc.addPage(); y = 16; }
      doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
      doc.text('Invoice Amount In Words:', margin, y);
      doc.setFont('helvetica', 'normal');
      const wordsLines = doc.splitTextToSize(amountToWordsINR(finalAmt), right - margin - 42);
      doc.text(wordsLines, margin + 42, y); y += Math.max(4, wordsLines.length * 3.6) + 2;
      doc.setFont('helvetica', 'bold'); doc.text('Payment Mode:', margin, y);
      doc.setFont('helvetica', 'normal'); doc.text(invoice.sale_mode || 'Credit', margin + 26, y); y += 5;
      if (org.invoice_terms) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('Terms and conditions:', margin, y); y += 3.6;
        doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 90, 90);
        const tLines = doc.splitTextToSize(org.invoice_terms, right - margin * 2);
        doc.text(tLines, margin, y); y += tLines.length * 3.3 + 2;
      }
      if (org.msme_reg) { doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(30, 30, 30); doc.text(`MSME REG : ${org.msme_reg}`, margin, y); y += 4; }
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(110, 110, 110);
      doc.text('Thanks for doing business with us!', margin, y); y += 6;

      // ── 6b. Bank details + QR (left) | signature (right) ──
      const footTop = Math.max(y, pageH - 44);
      if (defBank) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(30, 30, 30);
        doc.text('Bank Details', margin + (qrDataUrl ? 26 : 0), footTop);
        if (qrDataUrl) { try { doc.addImage(qrDataUrl, 'PNG', margin, footTop + 2, 22, 22); } catch (_) {} }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(60, 60, 60);
        const bx = margin + (qrDataUrl ? 26 : 0);
        let by = footTop + 4;
        [`Name: ${defBank.bank_name || ''}`, `Account No.: ${defBank.account_no || ''}`, `IFSC code: ${defBank.ifsc || ''}`, `Account Holder's Name: ${defBank.account_name || org.name}`]
          .forEach(line => { doc.text(line, bx, by); by += 3.6; });
      }
      // Signature (right)
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40);
      doc.text(`For: ${org.name}`, right, footTop, { align: 'right' });
      if (org.signature) { try { doc.addImage(org.signature, 'PNG', right - 40, footTop + 3, 38, 16); } catch (_) {} }
      doc.setFont('helvetica', 'bold'); doc.text('Authorized Signatory', right, footTop + 24, { align: 'right' });

      // ── 7. Page 2: Acknowledgment slip ──
      doc.addPage();
      let ay = 16;
      doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text(org.name, margin, ay);
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 70, 70);
      const a2 = doc.splitTextToSize(org.address || '', 120); doc.text(a2, margin, ay + 5);
      let aHy = ay + 5 + a2.length * 3.6;
      if (org.gstin) { doc.text(`GSTIN: ${org.gstin}`, margin, aHy); aHy += 3.6; }
      if (orgState) { doc.text(`State: ${orgState}`, margin, aHy); aHy += 3.6; }
      if (org.logo) { try { doc.addImage(org.logo, 'PNG', right - 32, ay - 2, 32, 18); } catch (_) {} }
      ay = Math.max(aHy + 4, 42);
      doc.setDrawColor(150); doc.line(margin, ay, right, ay); ay += 6;
      doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.text('Tax Invoice', pageWidth / 2, ay, { align: 'center' }); ay += 8;
      doc.setDrawColor(200); doc.setLineDashPattern([1, 1], 0); doc.line(margin, ay, right, ay); doc.setLineDashPattern([], 0); ay += 6;
      doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(70, 110, 200);
      doc.text('Acknowledgment', pageWidth / 2, ay, { align: 'center' }); ay += 5;
      doc.setTextColor(70, 110, 200); doc.text(org.name, pageWidth / 2, ay, { align: 'center' }); ay += 10;
      doc.setTextColor(70, 110, 200); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
      doc.text('Invoice To:', margin, ay);
      doc.text('Invoice Details:', pageWidth / 2 + 6, ay); ay += 5;
      doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      doc.text(billToName, margin, ay);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60, 60, 60);
      const a3 = doc.splitTextToSize(billToAddress || '', 80); doc.text(a3, margin, ay + 4);
      // right details
      doc.setFontSize(8); doc.setTextColor(40, 40, 40);
      doc.text(`Invoice No. : ${invoice.invoice_no || '—'}`, pageWidth / 2 + 6, ay);
      doc.text(`Invoice Date : ${invDate}`, pageWidth / 2 + 6, ay + 5);
      doc.text(`Invoice Amount : ${formatCurrencyPDF(finalAmt)}`, pageWidth / 2 + 6, ay + 10);
      doc.setDrawColor(160); doc.setLineDashPattern([1, 1], 0); doc.line(right - 60, ay + 24, right, ay + 24); doc.setLineDashPattern([], 0);
      doc.setFontSize(7.5); doc.setTextColor(80, 80, 80); doc.text("Receiver's Seal & Sign", right - 30, ay + 28, { align: 'center' });

      const fileName = `TaxInvoice_GST_${(invoice.invoice_no || '').replace(/\//g, '-')}_${(billToName || '').replace(/\s+/g, '_')}.pdf`;
      if (ctx.deliver) return { doc, filename: fileName };
      doc.save(fileName);
      logAction('tax_invoices', 'print_pdf_gst', invoice.id, {}, invoice.invoice_no);
      return { doc, filename: fileName };
    } catch (err) {
      console.error('GST-format Invoice PDF Error:', err);
      addToast('Failed to generate GST-format PDF', 'error');
    }
  };

