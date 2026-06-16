// Accounting report / GST / AI export builders — extracted from Accounting.jsx.
import * as XLSX from "@e965/xlsx";

export const exportReport = (type, ctx) => {
  const { fyFilter, snapshot, ageingData, addToast } = ctx;
    const wb = XLSX.utils.book_new();
    const fy = fyFilter === 'all' ? 'All' : fyFilter;
    if (type === 'sales' || type === 'all') {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshot.salesBook.map(r => ({ Date: r.date, 'Invoice No': r.invoiceNo, Client: r.clientName, Mode: r.mode, 'Taxable': r.taxable, 'GST': r.gst, 'Total': r.total }))), 'Sales Book');
    }
    if (type === 'non_invoiced' || type === 'all') {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((snapshot.nonInvoicedSalesBook || []).map(r => ({ Date: r.date, Project: r.projectName, Client: r.clientName, 'Taxable': r.taxable, 'GST': r.gst, 'Total': r.total }))), 'Unbilled Work');
    }
    if (type === 'purchase' || type === 'all') {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshot.purchaseBook.map(r => ({ Date: r.date, 'PI/PO No': r.invoiceNo, Vendor: r.vendorName, Mode: r.mode, 'Taxable': r.taxable, 'GST': r.gst, 'Total': r.total }))), 'Purchase Book');
    }
    if (type === 'trial' || type === 'all') {
      const rows = snapshot.trialBalance.rows.map(r => ({ Account: r.account, Debit: r.debit, Credit: r.credit, Balance: Math.abs(r.balance), Side: r.balanceType }));
      rows.push({ Account: 'TOTAL', Debit: snapshot.trialBalance.totalDebit, Credit: snapshot.trialBalance.totalCredit });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Trial Balance');
    }
    if (type === 'ledger' || type === 'all') {
      snapshot.ledger.forEach(l => {
        let running = 0;
        const rows = l.entries.map(e => { running += e.side === 'Dr' ? e.amount : -e.amount; return { Date: e.date, Type: e.source, Ref: e.refNo, Narration: e.remarks, Debit: e.side === 'Dr' ? e.amount : '', Credit: e.side === 'Cr' ? e.amount : '', Balance: Math.abs(running), Side: running >= 0 ? 'Dr' : 'Cr' }; });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), l.account.substring(0, 31).replace(/[*?:/\\[\]]/g, '_'));
      });
    }
    if (type === 'ageing' || type === 'all') {
      const rr = ageingData.receivable.map(r => ({ Party: r.name, '0-30 Days': r['0_30'], '31-60 Days': r['31_60'], '61-90 Days': r['61_90'], '90+ Days': r['90_plus'], Total: r.total }));
      rr.push({ Party: 'TOTAL', '0-30 Days': ageingData.receivableTotals['0_30'], '31-60 Days': ageingData.receivableTotals['31_60'], '61-90 Days': ageingData.receivableTotals['61_90'], '90+ Days': ageingData.receivableTotals['90_plus'], Total: ageingData.receivableTotals.total });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rr), 'Receivable Ageing');
      const pr = ageingData.payable.map(r => ({ Party: r.name, '0-30 Days': r['0_30'], '31-60 Days': r['31_60'], '61-90 Days': r['61_90'], '90+ Days': r['90_plus'], Total: r.total }));
      pr.push({ Party: 'TOTAL', '0-30 Days': ageingData.payableTotals['0_30'], '31-60 Days': ageingData.payableTotals['31_60'], '61-90 Days': ageingData.payableTotals['61_90'], '90+ Days': ageingData.payableTotals['90_plus'], Total: ageingData.payableTotals.total });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pr), 'Payable Ageing');
    }
    if (type === 'journal' || type === 'all') {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshot.journal.map(r => ({ Date: r.date, Source: r.source, Ref: r.refNo, 'Debit Account': r.debitAccount, 'Credit Account': r.creditAccount, Amount: r.amount, Narration: r.remarks }))), 'Journal');
    }
    if (type === 'tally' || type === 'all') {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshot.journal.map(r => ({ 'Voucher Date': r.date, 'Voucher Type': r.source === 'sales_invoice' ? 'Sales' : r.source === 'purchase_invoice' ? 'Purchase' : r.source === 'receipt' ? 'Receipt' : r.source === 'vendor_payment' ? 'Payment' : 'Journal', 'Voucher No': r.refNo, 'Ledger (Dr)': r.debitAccount, 'Ledger (Cr)': r.creditAccount, Amount: r.amount, Narration: r.remarks }))), 'Tally Import');
    }
    const label = type === 'all' ? 'Full_Export' : type === 'tally' ? 'Tally_Export' : type.charAt(0).toUpperCase() + type.slice(1);
    XLSX.writeFile(wb, `Accounting_${label}_${fy}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    addToast(`${label} exported to Excel`, 'success');
  };

export const exportGstToExcel = (reportType, ctx) => {
  const { fyFilter, gstData, addToast } = ctx;
    const wb = XLSX.utils.book_new();
    const fy = fyFilter === 'all' ? 'All' : fyFilter;

    if (reportType === 'gstr1' || reportType === 'all') {
      const rows = gstData.gstr1.map(r => ({
        'Date': r.date, 'Invoice No': r.invoiceNo, 'Client': r.clientName, 'Client GSTIN': r.clientGstin,
        'Place of Supply': r.placeOfSupply, 'Supply Type': r.supplyType, 'Taxable (₹)': r.taxable,
        'CGST (₹)': r.cgst, 'SGST (₹)': r.sgst, 'IGST (₹)': r.igst, 'Total (₹)': r.total, 'Source': r.source,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'GSTR-1 Sales');
    }
    if (reportType === 'gstr2' || reportType === 'all') {
      const rows = gstData.gstr2.map(r => ({
        'Date': r.date, 'PI No': r.piNo, 'Invoice Ref': r.invoiceRef, 'Vendor': r.vendorName, 'Vendor GSTIN': r.vendorGstin,
        'Type': r.type, 'Place of Supply': r.placeOfSupply, 'Supply Type': r.supplyType, 'Taxable (₹)': r.taxable,
        'CGST (₹)': r.cgst, 'SGST (₹)': r.sgst, 'IGST (₹)': r.igst, 'Total (₹)': r.total,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'GSTR-2 Purchases');
    }
    if (reportType === 'gstr3b' || reportType === 'all') {
      const s = gstData.gstr3b;
      const rows = [
        { 'Head': 'OUTPUT TAX (Sales)', 'Taxable': s.outputTaxable, 'CGST': s.outputCgst, 'SGST': s.outputSgst, 'IGST': s.outputIgst, 'Total GST': s.outputTotal },
        { 'Head': 'INPUT TAX CREDIT (Purchases)', 'Taxable': s.inputTaxable, 'CGST': s.inputCgst, 'SGST': s.inputSgst, 'IGST': s.inputIgst, 'Total GST': s.inputTotal },
        { 'Head': 'NET GST PAYABLE', 'Taxable': '', 'CGST': s.netCgst, 'SGST': s.netSgst, 'IGST': s.netIgst, 'Total GST': s.netPayable },
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'GSTR-3B Summary');
    }
    if (reportType === 'hsn' || reportType === 'all') {
      const rows = gstData.hsnSummary.map(r => ({
        'HSN/SAC': r.hsn, 'GST Rate (%)': r.gstRate,
        'Sales Taxable (₹)': r.salesTaxable, 'Sales GST (₹)': r.salesGst,
        'Purchase Taxable (₹)': r.purchaseTaxable, 'Purchase GST (₹)': r.purchaseGst,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'HSN Summary');
    }

    XLSX.writeFile(wb, `GST_Reports_${fy}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    addToast('GST report exported to Excel', 'success');
  };

export const exportGstrJson = (kind, ctx) => {
  const { fyFilter, gstData, orgGstin, addToast } = ctx;
    const fy = fyFilter === 'all' ? 'All' : fyFilter;
    const periodFromDate = (d) => {
      if (!d) return '';
      const dt = new Date(d);
      if (Number.isNaN(dt.getTime())) return '';
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      return `${mm}${dt.getFullYear()}`;
    };
    // Prefer the actual data date over "today" so exporting historical
    // months produces the correct `fp` / `ret_period`.
    const referenceDate = (() => {
      const sales = gstData.gstr1 || [];
      const purchases = gstData.gstr2 || [];
      const allDates = [...sales, ...purchases]
        .map((r) => r.date)
        .filter(Boolean)
        .sort();
      return allDates.length ? allDates[allDates.length - 1] : new Date().toISOString();
    })();
    const stateCode = (orgGstin || '').slice(0, 2) || '00';
    // GSTIN validator — 15 chars, 2-digit state, 10-char PAN, entity char,
    // 'Z' at position 14, alphanumeric check at 15. Returns a category.
    const classifyGstin = (gstin) => {
      const g = String(gstin || '').trim().toUpperCase();
      if (g.length !== 15) return 'UNREG';
      if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return 'UNREG';
      // UINs follow the same 15-char pattern but are identified in-app via
      // the explicit client_type field (maintained in /clients). Without
      // that context, treat every valid 15-char GSTIN as regular (B2B),
      // which means it's excluded from inter_sup entirely — the safer
      // classification (missing data vs. mis-classification).
      return 'REG';
    };
    let payload;
    let filename;

    if (kind === 'gstr1') {
      const rows = gstData.gstr1 || [];
      const fp = periodFromDate(referenceDate);
      // Group B2B by client GSTIN -> invoices array.
      const b2bMap = new Map();
      const b2cl = []; // inter-state to unregistered, invoice value > 2.5L
      const b2csMap = new Map(); // intra-state aggregated by rate
      const blendedRate = (r) => (Number(r.cgst || 0) + Number(r.sgst || 0) + Number(r.igst || 0)) > 0 && Number(r.taxable || 0) > 0
        ? +(((Number(r.cgst || 0) + Number(r.sgst || 0) + Number(r.igst || 0)) / Number(r.taxable)) * 100).toFixed(2)
        : 0;
      rows.forEach((r) => {
        const isInter = r.placeOfSupply && stateCode && r.placeOfSupply.slice(0, 2) !== stateCode;
        // Rate-wise slabs: one per GST rate when a breakup exists, else a single
        // blended slab — so a mixed-rate invoice files correctly under each rate.
        const slabs = (Array.isArray(r.gst_breakup) && r.gst_breakup.length)
          ? r.gst_breakup.map(b => ({ rt: Number(b.rate || 0), txval: Number(b.taxable || 0), iamt: Number(b.igst || 0), camt: Number(b.cgst || 0), samt: Number(b.sgst || 0) }))
          : [{ rt: blendedRate(r), txval: Number(r.taxable || 0), iamt: Number(r.igst || 0), camt: Number(r.cgst || 0), samt: Number(r.sgst || 0) }];
        const itms = slabs.map((s, i) => ({ num: i + 1, itm_det: { txval: s.txval, rt: s.rt, iamt: s.iamt, camt: s.camt, samt: s.samt, csamt: 0 } }));
        const inv = {
          inum: r.invoiceNo || '',
          idt: r.date ? new Date(r.date).toLocaleDateString('en-GB').replace(/\//g, '-') : '',
          val: Number(r.total || 0),
          pos: (r.placeOfSupply || '').slice(0, 2) || stateCode,
          rchrg: 'N',
          inv_typ: 'R',
          itms,
        };
        if (r.clientGstin && classifyGstin(r.clientGstin) === 'REG') {
          if (!b2bMap.has(r.clientGstin)) b2bMap.set(r.clientGstin, { ctin: r.clientGstin, inv: [] });
          b2bMap.get(r.clientGstin).inv.push(inv);
        } else if (isInter && Number(r.total || 0) > 250000) {
          b2cl.push({ pos: inv.pos, inv: [{ inum: inv.inum, idt: inv.idt, val: inv.val, itms }] });
        } else {
          // B2CS: aggregate each rate slab into its own bucket.
          slabs.forEach((s) => {
            const key = `${s.rt}|${inv.pos}|${isInter ? 'INTER' : 'INTRA'}`;
            if (!b2csMap.has(key)) {
              b2csMap.set(key, { sply_ty: isInter ? 'INTER' : 'INTRA', rt: s.rt, typ: 'OE', pos: inv.pos, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
            }
            const bucket = b2csMap.get(key);
            bucket.txval += s.txval;
            bucket.iamt += s.iamt;
            bucket.camt += s.camt;
            bucket.samt += s.samt;
          });
        }
      });
      const hsn = (gstData.hsnSummary || []).map((h, i) => ({
        num: i + 1,
        hsn_sc: h.hsn || '',
        uqc: 'NOS',
        qty: 0,
        txval: Number(h.salesTaxable || 0),
        iamt: 0, camt: 0, samt: 0, csamt: 0,
        rt: Number(h.gstRate || 0),
      }));
      payload = {
        gstin: orgGstin || '',
        fp,
        gt: 0,
        cur_gt: 0,
        b2b: Array.from(b2bMap.values()),
        b2cl,
        b2cs: Array.from(b2csMap.values()),
        hsn: { data: hsn },
      };
      filename = `GSTR1_${orgGstin || 'NA'}_${fp || fy}.json`;
    } else if (kind === 'gstr3b') {
      const s = gstData.gstr3b || {};
      const fp = periodFromDate(referenceDate);
      // Split outward supplies to unregistered / composition / UIN holders
      // by place-of-supply state for the inter_sup section. Without a
      // reliable composition/UIN flag in-app, we currently only split
      // unregistered (no GSTIN) — the common case. Registered B2B is
      // excluded from inter_sup per GSTN spec anyway.
      const unregMap = new Map(); // pos -> { pos, txval, iamt }
      (gstData.gstr1 || []).forEach((r) => {
        const pos = (r.placeOfSupply || '').slice(0, 2);
        if (!pos || pos === stateCode) return; // only inter-state goes here
        const cat = classifyGstin(r.clientGstin);
        if (cat !== 'UNREG') return;
        const txval = Number(r.taxable || 0);
        const iamt = Number(r.igst || 0);
        if (!unregMap.has(pos)) unregMap.set(pos, { pos, txval: 0, iamt: 0 });
        const b = unregMap.get(pos);
        b.txval += txval;
        b.iamt += iamt;
      });
      const toDetails = (m) => Array.from(m.values()).map((v) => ({
        pos: v.pos,
        txval: +v.txval.toFixed(2),
        iamt: +v.iamt.toFixed(2),
      }));
      // Inward supplies intra/inter split (GST-taxable purchases only).
      let inwardInter = 0;
      let inwardIntra = 0;
      (gstData.gstr2 || []).forEach((r) => {
        const total = Number(r.taxable || 0);
        if (Number(r.igst || 0) > 0) inwardInter += total;
        else inwardIntra += total;
      });
      payload = {
        gstin: orgGstin || '',
        ret_period: fp,
        sup_details: {
          osup_det: {
            txval: Number(s.outputTaxable || 0),
            iamt: Number(s.outputIgst || 0),
            camt: Number(s.outputCgst || 0),
            samt: Number(s.outputSgst || 0),
            csamt: 0,
          },
          osup_zero: { txval: 0, iamt: 0, csamt: 0 },
          osup_nil_exmp: { txval: 0 },
          isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
          osup_nongst: { txval: 0 },
        },
        inter_sup: {
          unreg_details: toDetails(unregMap),
          comp_details: [],
          uin_details: [],
        },
        itc_elg: {
          itc_avl: [
            { ty: 'IMPG', iamt: 0, camt: 0, samt: 0, csamt: 0 },
            { ty: 'IMPS', iamt: 0, camt: 0, samt: 0, csamt: 0 },
            { ty: 'ISRC', iamt: 0, camt: 0, samt: 0, csamt: 0 },
            { ty: 'ISD', iamt: 0, camt: 0, samt: 0, csamt: 0 },
            {
              ty: 'OTH',
              iamt: Number(s.inputIgst || 0),
              camt: Number(s.inputCgst || 0),
              samt: Number(s.inputSgst || 0),
              csamt: 0,
            },
          ],
          itc_rev: [],
          itc_net: {
            iamt: Number(s.inputIgst || 0),
            camt: Number(s.inputCgst || 0),
            samt: Number(s.inputSgst || 0),
            csamt: 0,
          },
          itc_inelg: [],
        },
        inward_sup: {
          isup_details: [
            { ty: 'GST', inter: +inwardInter.toFixed(2), intra: +inwardIntra.toFixed(2) },
            { ty: 'NONGST', inter: 0, intra: 0 },
          ],
        },
      };
      filename = `GSTR3B_${orgGstin || 'NA'}_${fp || fy}.json`;
    } else {
      return;
    }

    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      addToast(`${kind.toUpperCase()} JSON downloaded`, 'success');
    } catch (err) {
      console.error(err);
      addToast(`Failed to export ${kind.toUpperCase()} JSON`, 'error');
    }
  };

export const exportAiEntries = (ctx) => {
  const { aiEntries, addToast, fyFilter } = ctx;
    if (!aiEntries.length) return addToast('No AI entries to export', 'info');
    const rows = aiEntries.map((e) => ({
      Date: e.date || '',
      'Voucher No': e.voucher_no || '',
      'User Message': e.ai_prompt || '',
      Narration: e.narration || '',
      Intent: e.ai_intent || '',
      Confidence: typeof e.ai_confidence === 'number' ? `${Math.round(e.ai_confidence * 100)}%` : '',
      Model: e.ai_model || '',
      Entries: (e.entries || []).map((l) => `Dr ${l.debitAccount} / Cr ${l.creditAccount} = ${l.amount}`).join(' ; '),
      Amount: (e.entries || []).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0),
      Issues: (e.ai_issues || []).map((i) => `${i.level}: ${i.message}`).join(' | '),
      'Created By': e.created_by || '',
      Reviewed: e.ai_reviewed ? `Yes (${e.ai_reviewed_by_name || e.ai_reviewed_by || ''} ${e.ai_reviewed_at ? e.ai_reviewed_at.slice(0, 10) : ''})` : 'No',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'AI Entries');
    XLSX.writeFile(wb, `AI_Entries_${fyFilter === 'all' ? 'all' : fyFilter}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };
