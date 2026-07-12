import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { appId } from '../utils/constants';
import { formatCurrency, getProjectGrandTotal, getEffectivePOCost } from '../utils/helpers';
import { LoadingSpinner } from '../components/Shared';
import { FileText, X, ChevronDown, ChevronUp, Receipt, ChevronRight, Image as ImageIcon, Eye } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';

const PublicLedger = () => {
  const { token } = useParams();
  const location = useLocation();
  const [client, setClient] = useState(null);
  const [orgSettings, setOrgSettings] = useState(null);
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [vendorPayments, setVendorPayments] = useState([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState([]);
  const [taxInvoices, setTaxInvoices] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]); // party-leg JVs/CN/DN/TDS
  const [openingBalance, setOpeningBalance] = useState(null); // party opening-balance mirror
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fyFilter, setFyFilter] = useState('ALL');
  const [detailProject, setDetailProject] = useState(null); // project shown in detail modal
  const [expenseProject, setExpenseProject] = useState(null); // project whose actual-expense + proof drill-in is open
  const [invoiceViewOpen, setInvoiceViewOpen] = useState(false);
  const [selectedInvoiceNo, setSelectedInvoiceNo] = useState(''); // invoice number filter in invoice view
  const companyFilterId = useMemo(() => new URLSearchParams(location.search).get('company') || '', [location.search]);

  useEffect(() => {
    let isMounted = true;
    const fetchLedgerData = async () => {
      setLoading(true);
      setError('');
      try {
        // Token validation + scoped data all happen server-side (Admin SDK).
        const fn = httpsCallable(getFunctions(), 'getLedgerData');
        const res = await fn({ appId, token });
        const data = res.data || {};
        if (!isMounted) return;
        setClient(data.client || null);
        setProjects(data.projects || []);
        setPayments(data.payments || []);
        setVendorPayments(data.vendorPayments || []);
        setOrgSettings(data.org || null);
        setPurchaseInvoices(data.purchaseInvoices || []);
        setTaxInvoices(data.taxInvoices || []);
        setJournalEntries(data.journalEntries || []);
        setOpeningBalance(data.openingBalance || null);
      } catch (err) {
        console.error('Public ledger load failed:', err);
        if (isMounted) { setClient(null); setError(err?.message || 'Failed to load ledger. Please try again later.'); }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    if (token) fetchLedgerData();
    return () => { isMounted = false; };
  }, [token]);

  // Returns the Indian FY label (e.g. "2024-25") for any date string
  const getEntryFY = (dateStr) => {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Unknown';
    const m = d.getMonth(); // 0 = Jan
    const y = d.getFullYear();
    if (m < 3) return `${y - 1}-${String(y).slice(-2)}`; // Jan–Mar → prev FY
    return `${y}-${String(y + 1).slice(-2)}`; // Apr–Dec → current FY
  };

  const getPartyCompanies = (party) => {
    if (!party) return [];
    const primary = {
      id: 'primary',
      name: party.name || 'Primary Company',
      gstin: party.gstin || '',
      address: party.address || '',
    };
    const extras = (party.companies || []).map(c => ({
      id: c.id,
      name: c.name || 'Branch',
      gstin: c.gstin || '',
      address: c.address || '',
    }));
    return [primary, ...extras];
  };

  const { allRows, fyList } = useMemo(() => {
    if (!client) return { allRows: [], fyList: ['ALL'] };

    const includeClientLedger = client.type === 'Client' || client.type === 'Both';
    const includeVendorLedger = client.type === 'Vendor' || client.type === 'Both';
    const partyCompanies = getPartyCompanies(client);
    const defaultCompany = partyCompanies[0] || { id: 'primary', name: client.name || 'Primary Company', gstin: client.gstin || '', address: client.address || '' };
    const resolveCompany = (companyId) => partyCompanies.find(c => c.id === companyId) || defaultCompany;
    const raw = [];

    if (includeClientLedger) {
      // PRECEDENCE: a raised tax invoice is the source of truth for the amount
      // due. An invoice debits the client at its FINAL (agreed, tax-inclusive)
      // amount and SUPERSEDES the per-project quote(s) it covers — so a clubbed
      // invoice shows as ONE line, not N quote lines. Only completed/closed
      // projects NOT yet covered by any invoice show as an "unbilled" quote.
      const activeClientInvoices = (taxInvoices || []).filter(inv => inv.status !== 'Cancelled');
      const invoicedPids = new Set();
      activeClientInvoices.forEach(inv => {
        const pids = Array.isArray(inv.project_ids) ? inv.project_ids : (inv.project_id ? [inv.project_id] : []);
        pids.forEach(pid => pid && invoicedPids.add(pid));
      });

      // Unbilled completed/closed projects → quoted cost
      projects
        .filter(p => p.client_id === client.id && ['Completed', 'Closed'].includes(p.status) && !invoicedPids.has(p.id))
        .forEach(p => {
          const company = resolveCompany(p.party_company_id);
          raw.push({
            date: p.end_date,
            desc: `Unbilled: ${p.project_name} (completed — awaiting invoice)`,
            debit: getProjectGrandTotal(p),
            credit: 0,
            invoice_status: 'Unbilled',
            invoice_no: '—',
            invoice_date: '—',
            project_id: p.id,
            company_key: company.id,
            company_name: company.name,
            company_gstin: company.gstin,
          });
        });

      // Raised tax invoices → one debit line each at the billed (final) amount
      activeClientInvoices.forEach(inv => {
        const company = resolveCompany(inv.sale_company_id);
        const amount = parseFloat(inv.final_amount != null ? inv.final_amount : (inv.computed_total || 0));
        const projNames = (Array.isArray(inv.project_names) && inv.project_names.length)
          ? inv.project_names.join(', ')
          : (inv.project_name || '');
        raw.push({
          date: inv.invoice_date,
          desc: `Invoice ${inv.invoice_no || '—'}${projNames ? `: ${projNames}` : ''}`,
          debit: amount,
          credit: 0,
          invoice_status: 'Invoiced',
          invoice_no: inv.invoice_no || '—',
          invoice_date: inv.invoice_date || '—',
          company_key: company.id,
          company_name: company.name,
          company_gstin: company.gstin,
        });
      });
      payments
        .filter(p => p.client_id === client.id)
        .forEach(p => {
          const linkedProject = projects.find(pr => pr.id === p.project_id);
          const company = resolveCompany(p.party_company_id || linkedProject?.party_company_id);
          raw.push({
            date: p.date,
            desc: `Payment: ${p.mode} - ${p.reference}`,
            debit: 0,
            credit: parseFloat(p.amount || 0),
            invoice_status: null, invoice_no: null, invoice_date: null,
            company_key: company.id,
            company_name: company.name,
            company_gstin: company.gstin,
          });
        });
    }

    if (includeVendorLedger) {
      /*
       * PRECEDENCE ORDER (highest wins, lower is skipped if higher exists):
       *  3. Purchase Invoice (include_in_ledger=true) — exact PI amount, most authoritative
       *  2. Purchase Order   — commitment amount, shown only if no PI supersedes it
       *  1. Inventory Allocation — not yet surfaced separately (covered by PO)
       *
       * A PI with linked_po_id supersedes that specific PO entry.
       * A PI without linked_po_id appears as a standalone payable row.
       */

      // Collect vendor PIs flagged for ledger inclusion
      const vendorPIs = purchaseInvoices.filter(
        pi => pi.vendor_id === client.id && pi.include_in_ledger && pi.status !== 'Rejected'
      );

      // Build Set of PO keys (projectId::po_no) superseded by a PI
      const supersededPOKeys = new Set(
        vendorPIs.filter(pi => pi.linked_po_id).map(pi => pi.linked_po_id)
      );

      // 2. POs — show only if not superseded
      projects.forEach(p => {
        if (p.purchase_orders) {
          p.purchase_orders.forEach(po => {
            if (po.vendor_id === client.id && po.status !== 'Cancelled') {
              // H-5: match supersession by either stable id or legacy composite key.
              const stableKey = po.id || '';
              const poKey = `${p.id}::${po.po_no}`;
              if (supersededPOKeys.has(stableKey) || supersededPOKeys.has(poKey)) return; // PI supersedes this PO
              const poAmount = (po.package_cost && po.package_cost > 0)
                ? po.package_cost * (1 + (po.package_cost_gst || 0) / 100)
                : parseFloat(po.amount || 0);
              raw.push({
                date: po.date,
                desc: `PO: ${po.po_no} — ${p.project_name}`,
                entry_tag: 'PO',
                debit: 0, credit: poAmount,
                invoice_status: null, invoice_no: null, invoice_date: null,
                company_key: resolveCompany(po.party_company_id || p.party_company_id).id,
                company_name: resolveCompany(po.party_company_id || p.party_company_id).name,
                company_gstin: resolveCompany(po.party_company_id || p.party_company_id).gstin,
              });
            }
          });
        }
      });

      // 3. Purchase Invoices (supersede linked PO or standalone)
      vendorPIs.forEach(pi => {
        const piTotal = (parseFloat(pi.amount) || 0) + (parseFloat(pi.gst_amount) || 0);
        const linkedLabel = pi.linked_po_no ? ` (replaces PO ${pi.linked_po_no})` : '';
        raw.push({
          date: pi.invoice_date,
          desc: `PI: ${pi.pi_no}${linkedLabel} — ${pi.description || pi.vendor_name}`,
          entry_tag: 'PI',
          debit: 0, credit: piTotal,
          invoice_status: pi.status || null,
          invoice_no: pi.invoice_ref || pi.pi_no,
          invoice_date: pi.invoice_date || null,
          company_key: resolveCompany(pi.party_company_id).id,
          company_name: resolveCompany(pi.party_company_id).name,
          company_gstin: resolveCompany(pi.party_company_id).gstin,
        });
      });

      vendorPayments
        .filter(p => p.vendor_id === client.id)
        .forEach(p => {
          const linkedProject = projects.find(pr => pr.id === p.project_id);
          const company = resolveCompany(p.party_company_id || linkedProject?.party_company_id);
          raw.push({
            date: p.date,
            desc: `Payment: ${p.mode} - ${p.reference}`,
            debit: parseFloat(p.amount || 0), credit: 0,
            invoice_status: null, invoice_no: null, invoice_date: null,
            company_key: company.id,
            company_name: company.name,
            company_gstin: company.gstin,
          });
        });
    }

    // ── Journal-voucher & opening-balance rows (server-scoped to this party) ──
    // These come pre-netted to the party's own leg, so they fold in exactly like
    // an invoice or payment and make the running balance tie out with the in-app
    // derived ledger. Not company-split → attach to the primary company.
    if (openingBalance && (openingBalance.debit || openingBalance.credit)) {
      raw.push({
        date: openingBalance.date,
        desc: openingBalance.remarks || 'Opening Balance',
        debit: parseFloat(openingBalance.debit || 0),
        credit: parseFloat(openingBalance.credit || 0),
        entry_tag: 'OB',
        invoice_status: null, invoice_no: null, invoice_date: null,
        company_key: defaultCompany.id, company_name: defaultCompany.name, company_gstin: defaultCompany.gstin,
      });
    }
    const jvLabel = (src) => src === 'credit_note' ? 'Credit Note'
      : src === 'debit_note' ? 'Debit Note'
      : src === 'tds_entry' ? 'TDS'
      : 'Journal Voucher';
    (journalEntries || []).forEach(j => {
      raw.push({
        date: j.date,
        desc: `${jvLabel(j.source)}${j.voucher_no ? ` ${j.voucher_no}` : ''}${j.narration ? `: ${j.narration}` : ''}`,
        debit: parseFloat(j.debit || 0),
        credit: parseFloat(j.credit || 0),
        entry_tag: 'JV',
        invoice_status: null, invoice_no: null, invoice_date: null,
        company_key: defaultCompany.id, company_name: defaultCompany.name, company_gstin: defaultCompany.gstin,
      });
    });

    const scopedRaw = companyFilterId
      ? raw.filter(r => (r.company_key || 'primary') === companyFilterId)
      : raw;

    scopedRaw.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Group by FY
    const fyBuckets = {};
    scopedRaw.forEach(r => {
      const fy = getEntryFY(r.date);
      if (!fyBuckets[fy]) fyBuckets[fy] = [];
      fyBuckets[fy].push(r);
    });

    const sortedFYs = Object.keys(fyBuckets).sort((a, b) => parseInt(a) - parseInt(b));

    const result = [];
    let runningBalance = 0;

    sortedFYs.forEach((fy, fyIdx) => {
      // Section header row
      result.push({ _type: 'fy_header', fy });

      // Balance Carried Forward (only after the first FY and only if non-zero)
      if (fyIdx > 0 && runningBalance !== 0) {
        result.push({
          _type: 'bcf',
          fy,
          Date: fyBuckets[fy][0]?.date || '',
          Description: `Balance Carried Forward from FY ${sortedFYs[fyIdx - 1]}`,
          Debit: runningBalance > 0 ? runningBalance : 0,
          Credit: runningBalance < 0 ? Math.abs(runningBalance) : 0,
          Balance: runningBalance
        });
      }

      fyBuckets[fy].forEach(row => {
        runningBalance += (row.debit - row.credit);
        result.push({
          _type: 'row',
          fy,
          Date: row.date,
          Description: row.desc,
          company_key: row.company_key || defaultCompany.id,
          company_name: row.company_name || defaultCompany.name,
          company_gstin: row.company_gstin || defaultCompany.gstin,
          invoice_status: row.invoice_status,
          invoice_no: row.invoice_no,
          invoice_date: row.invoice_date,
          entry_tag: row.entry_tag || null,
          project_id: row.project_id || null,
          Debit: row.debit,
          Credit: row.credit,
          Balance: runningBalance
        });
      });
    });

    return { allRows: result, fyList: ['ALL', ...sortedFYs] };
  }, [client, projects, payments, vendorPayments, purchaseInvoices, taxInvoices, journalEntries, openingBalance, companyFilterId]);

  // Group client's invoiced projects by invoice_no for the Invoice View panel
  const invoiceGroups = useMemo(() => {
    if (!client) return [];
    const invoiced = projects.filter(
      p => p.client_id === client.id && p.invoice_no && p.invoice_no.trim()
    );
    const map = {};
    invoiced.forEach(p => {
      const key = p.invoice_no.trim();
      if (!map[key]) {
        map[key] = {
          invoice_no: key,
          invoice_date: p.invoice_date || '',
          invoice_status: p.invoice_status || 'Not Invoiced',
          projects: [],
          total: 0
        };
      }
      map[key].projects.push(p);
      map[key].total += getProjectGrandTotal(p);
    });
    return Object.values(map).sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
  }, [client, projects]);

  // Rows visible in the table (filtered by selected FY)
  const visibleRows = useMemo(() => {
    if (fyFilter === 'ALL') return allRows;
    return allRows.filter(r => r.fy === fyFilter);
  }, [allRows, fyFilter]);

  const companyBalances = useMemo(() => {
    const map = new Map();
    visibleRows
      .filter(r => r._type === 'row')
      .forEach(r => {
        const key = r.company_key || 'primary';
        const curr = map.get(key) || {
          key,
          name: r.company_name || client?.name || 'Primary Company',
          gstin: r.company_gstin || '',
          debit: 0,
          credit: 0,
        };
        curr.debit += parseFloat(r.Debit || 0);
        curr.credit += parseFloat(r.Credit || 0);
        map.set(key, curr);
      });
    return Array.from(map.values())
      .map(x => ({ ...x, balance: x.debit - x.credit }))
      .sort((a, b) => (b.debit + b.credit) - (a.debit + a.credit));
  }, [visibleRows, client]);

  // Flat rows for PDF / Excel export (no fy_header separators)
  const exportRows = useMemo(() => {
    const source = fyFilter === 'ALL' ? allRows : allRows.filter(r => r.fy === fyFilter);
    return source
      .filter(r => r._type !== 'fy_header')
      .map(r => ({
        Date: r.Date,
        Description: r.Description,
        'Invoice Status': r.invoice_status || '',
        'Invoice No': r.invoice_no || '',
        'Invoice Date': r.invoice_date || '',
        Debit: r.Debit,
        Credit: r.Credit,
        Balance: r.Balance
      }));
  }, [allRows, fyFilter]);

  // Projects the owner has opted into sharing actual expense details for (with proofs).
  // Direct expenses are shared PER-EXPENSE (attached server-side only when marked),
  // reimbursables PER-PROJECT (share_expense_details). A project surfaces if either
  // shared set is non-empty.
  const sharedExpenseProjects = useMemo(
    () => (projects || []).filter(p => ((p.direct_expenses || []).length)
      || (p.share_expense_details && (p.reimbursable_expenses || []).length)),
    [projects]
  );

  // ── Detail breakdown helpers ────────────────────────────────────────────
  const fmtAmt = (v) => formatCurrency(parseFloat(v) || 0);
  const fmtD = (ds) => ds ? new Date(ds).toLocaleDateString('en-IN') : '—';
  // Proof link — mirrors PublicReimbursable: the tokenised Storage URL opens in a
  // new tab; icon picks PDF vs image from the filename/URL.
  const renderProof = (url, name) => {
    if (!url) return <span className="text-xs text-slate-300">—</span>;
    const isPdf = String(name || url).toLowerCase().includes('.pdf');
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-teal-700 bg-teal-50 px-2 py-0.5 rounded border border-teal-100 hover:bg-teal-100">
        {isPdf ? <FileText size={11} /> : <ImageIcon size={11} />} View
      </a>
    );
  };

  const getDetailSections = (p) => {
    if (!p) return {};
    // Equipment
    const items = (p.items || []).map(i => ({
      name: i.name || i.item_name || '—',
      category: i.category || '—',
      qty: i.qty || 1,
      rate: parseFloat(i.rate || 0),
      days: parseFloat(i.days || 1),
      gst: parseFloat(i.gst || 0),
      total: parseFloat(i.total || 0)
    }));
    const equipTotal = items.reduce((s, i) => s + i.total, 0);

    // Logistics
    const logistics = Object.entries(p.logistics_costs || {}).map(([key, v]) => ({
      type: key.charAt(0).toUpperCase() + key.slice(1),
      description: v.description || '—',
      amount: parseFloat(v.amount || 0),
      gst: parseFloat(v.gst || 0),
      total: parseFloat(v.amount || 0) * (1 + parseFloat(v.gst || 0) / 100)
    })).filter(l => l.amount > 0);
    const logTotal = logistics.reduce((s, l) => s + l.total, 0);

    // Outsourcing / Services (Purchase Orders)
    const pos = (p.purchase_orders || []).filter(po => po.status !== 'Cancelled').map(po => ({
      po_no: po.po_no || '—',
      description: po.description || po.service_type || '—',
      date: po.date || '',
      amount: getEffectivePOCost(po),
      status: po.status || '—'
    }));
    const poTotal = pos.reduce((s, po) => s + po.amount, 0);

    // Client Reimbursable Expenses
    const reimbursable = (p.reimbursable_expenses || []).map(e => ({
      date: e.date || '',
      description: e.description || e.category || '—',
      amount: parseFloat(e.amount || 0)
    })).filter(e => e.amount > 0);
    const reimbTotal = reimbursable.reduce((s, e) => s + e.amount, 0);

    return { items, equipTotal, logistics, logTotal, pos, poTotal, reimbursable, reimbTotal };
  };

  const exportDetailPDF = (p) => {
    if (!p) return;
    const d = new jsPDF();
    const { items, equipTotal, logistics, logTotal, pos, poTotal, reimbursable, reimbTotal } = getDetailSections(p);
    const grandTotal = equipTotal + logTotal + poTotal + reimbTotal;
    let y = 14;
    const org = orgSettings?.name || 'RentalOps';

    if (orgSettings?.logo) {
      try { d.addImage(orgSettings.logo, orgSettings.logo.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG', 160, y - 4, 30, 20); } catch {}
    }
    d.setFontSize(14); d.setFont(undefined, 'bold');
    d.text(org, 14, y); y += 7;
    d.setFontSize(11); d.setFont(undefined, 'normal');
    d.text('Project Cost Breakdown', 14, y); y += 6;
    d.setFontSize(9);
    d.text(`Project: ${p.project_name}`, 14, y); y += 5;
    d.text(`Client: ${client?.name || ''}  |  Period: ${fmtD(p.start_date)} – ${fmtD(p.end_date)}`, 14, y); y += 5;
    d.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, 14, y); y += 5;

    if (items.length > 0) {
      d.setFontSize(10); d.setFont(undefined, 'bold'); d.text('Equipment / Services', 14, y + 4); y += 2;
      autoTable(d, {
        head: [['Item', 'Category', 'Qty', 'Rate', 'Days', 'GST%', 'Total']],
        body: items.map(i => [i.name, i.category, i.qty, fmtAmt(i.rate), i.days, `${i.gst}%`, fmtAmt(i.total)]),
        foot: [['', '', '', '', '', 'Subtotal', fmtAmt(equipTotal)]],
        startY: y + 4, theme: 'striped', styles: { fontSize: 8 }, footStyles: { fontStyle: 'bold' }
      });
      y = d.lastAutoTable.finalY + 6;
    }

    if (logistics.length > 0) {
      d.setFontSize(10); d.setFont(undefined, 'bold'); d.text('Logistics Costs', 14, y + 4); y += 2;
      autoTable(d, {
        head: [['Type', 'Description', 'Amount', 'GST%', 'Total']],
        body: logistics.map(l => [l.type, l.description, fmtAmt(l.amount), `${l.gst}%`, fmtAmt(l.total)]),
        foot: [['', '', '', 'Subtotal', fmtAmt(logTotal)]],
        startY: y + 4, theme: 'striped', styles: { fontSize: 8 }, footStyles: { fontStyle: 'bold' }
      });
      y = d.lastAutoTable.finalY + 6;
    }

    if (pos.length > 0) {
      d.setFontSize(10); d.setFont(undefined, 'bold'); d.text('Outsourcing / Services', 14, y + 4); y += 2;
      autoTable(d, {
        head: [['PO #', 'Description', 'Date', 'Status', 'Amount']],
        body: pos.map(po => [po.po_no, po.description, fmtD(po.date), po.status, fmtAmt(po.amount)]),
        foot: [['', '', '', 'Subtotal', fmtAmt(poTotal)]],
        startY: y + 4, theme: 'striped', styles: { fontSize: 8 }, footStyles: { fontStyle: 'bold' }
      });
      y = d.lastAutoTable.finalY + 6;
    }

    if (reimbursable.length > 0) {
      d.setFontSize(10); d.setFont(undefined, 'bold'); d.text('Client Reimbursable Expenses', 14, y + 4); y += 2;
      autoTable(d, {
        head: [['Date', 'Description', 'Amount']],
        body: reimbursable.map(e => [fmtD(e.date), e.description, fmtAmt(e.amount)]),
        foot: [['', 'Subtotal', fmtAmt(reimbTotal)]],
        startY: y + 4, theme: 'striped', styles: { fontSize: 8 }, footStyles: { fontStyle: 'bold' }
      });
      y = d.lastAutoTable.finalY + 6;
    }

    // Grand total box
    d.setFillColor(79, 70, 229); d.rect(14, y, 182, 10, 'F');
    d.setFontSize(10); d.setFont(undefined, 'bold'); d.setTextColor(255, 255, 255);
    d.text('Grand Total', 16, y + 7);
    d.text(fmtAmt(grandTotal), 194, y + 7, { align: 'right' });
    d.setTextColor(0, 0, 0);

    const footerY = d.internal.pageSize.getHeight() - 10;
    d.setFontSize(8); d.setFont(undefined, 'normal');
    d.text(`Generated by ${org}`, 14, footerY);
    d.save(`breakdown_${p.project_name?.replace(/\s+/g, '_') || 'project'}.pdf`);
  };

  const exportPDF = () => {
    if (exportRows.length === 0) return alert('No data to export');
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(orgSettings?.name || 'Ledger Statement', 14, 18);
    if (orgSettings?.logo) {
      try {
        const logoType = orgSettings.logo.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG';
        doc.addImage(orgSettings.logo, logoType, 160, 10, 30, 20);
      } catch (e) { console.warn('Logo render failed', e); }
    }
    doc.setFontSize(12);
    doc.text('Ledger Statement', 14, 26);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 32);
    if (client) doc.text(`Party: ${client.name} (${client.type})`, 14, 38);
    if (fyFilter !== 'ALL') doc.text(`Financial Year: FY ${fyFilter}`, 14, 44);

    const headers = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
    const data = exportRows.map(row => headers.map(h =>
      typeof row[h] === 'number' ? row[h].toFixed(2) : (row[h] || '')
    ));

    autoTable(doc, {
      head: [headers],
      body: data,
      startY: fyFilter !== 'ALL' ? 50 : 44,
      didParseCell: ({ row: r, cell }) => {
        if (r.raw?.[1]?.toString()?.startsWith('Balance Carried Forward')) {
          cell.styles.fillColor = [255, 251, 235];
          cell.styles.fontStyle = 'bold';
        }
      }
    });
    const footerY = doc.internal.pageSize.getHeight() - 12;
    doc.setFontSize(9);
    doc.text(orgSettings?.name ? `Generated by ${orgSettings.name}` : 'Generated by RentalOps', 14, footerY);
    doc.save(`ledger_${client?.name || 'party'}${fyFilter !== 'ALL' ? `_FY${fyFilter}` : ''}.pdf`);
  };

  const exportExcel = () => {
    if (exportRows.length === 0) return alert('No data to export');
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, fyFilter === 'ALL' ? 'Ledger' : `FY ${fyFilter}`);
    XLSX.writeFile(wb, `ledger_${client?.name || 'party'}${fyFilter !== 'ALL' ? `_FY${fyFilter}` : ''}.xlsx`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-700">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-700 p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center">
          <div className="text-lg font-semibold text-slate-800">Ledger Unavailable</div>
          <div className="text-sm text-slate-500 mt-2">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-black">
      <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">{orgSettings?.name || 'RentalOps'}</div>
              <h1 className="text-2xl font-bold text-slate-800">Ledger Statement</h1>
              <div className="text-sm text-slate-500 mt-1">
                {client?.name} • {client?.type}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* FY Filter */}
              <select
                value={fyFilter}
                onChange={e => setFyFilter(e.target.value)}
                className="border border-slate-200 rounded px-3 py-2 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-indigo-200"
              >
                {fyList.map(fy => (
                  <option key={fy} value={fy}>{fy === 'ALL' ? 'All Years' : `FY ${fy}`}</option>
                ))}
              </select>
              <button onClick={exportPDF} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex items-center gap-2">
                <FileText size={16} /> PDF
              </button>
              <button onClick={exportExcel} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex items-center gap-2">
                <FileText size={16} /> Excel
              </button>
              {invoiceGroups.length > 0 && (
                <button
                  onClick={() => setInvoiceViewOpen(v => !v)}
                  className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold border transition-colors ${
                    invoiceViewOpen
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-indigo-700 border-indigo-300 hover:bg-indigo-50'
                  }`}
                >
                  <Receipt size={16} /> Invoices ({invoiceGroups.length})
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Invoice Summary Panel ──────────────────────────────────────── */}
        {invoiceViewOpen && invoiceGroups.length > 0 && (
          <div className="bg-white rounded-xl border border-indigo-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-indigo-600 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Receipt size={16} className="text-white" />
                <span className="text-white font-bold text-sm uppercase tracking-wide">Invoice Summary</span>
                <span className="text-indigo-200 text-xs ml-1">— select an invoice to see its projects</span>
              </div>
              <button onClick={() => { setInvoiceViewOpen(false); setSelectedInvoiceNo(''); }} className="text-white/70 hover:text-white">
                <X size={18} />
              </button>
            </div>
            {/* Invoice selector */}
            <div className="p-4 border-b bg-indigo-50 flex flex-wrap gap-2">
              {invoiceGroups.map(grp => (
                <button
                  key={grp.invoice_no}
                  onClick={() => setSelectedInvoiceNo(prev => prev === grp.invoice_no ? '' : grp.invoice_no)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-semibold transition-colors ${
                    selectedInvoiceNo === grp.invoice_no
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'bg-white border-indigo-200 text-indigo-700 hover:bg-indigo-100'
                  }`}
                >
                  <Receipt size={13} />
                  {grp.invoice_no}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-normal ${
                    selectedInvoiceNo === grp.invoice_no ? 'bg-indigo-500 text-white' : 'bg-indigo-50 text-indigo-600'
                  }`}>{grp.projects.length} project{grp.projects.length !== 1 ? 's' : ''}</span>
                </button>
              ))}
            </div>
            {/* Projects under selected invoice */}
            {selectedInvoiceNo && (() => {
              const grp = invoiceGroups.find(g => g.invoice_no === selectedInvoiceNo);
              if (!grp) return null;
              return (
                <div className="p-4 space-y-3">
                  <div className="flex flex-wrap gap-4 text-sm text-slate-600 pb-2 border-b border-slate-100">
                    <span><span className="font-semibold text-slate-700">Invoice #:</span> {grp.invoice_no}</span>
                    {grp.invoice_date && <span><span className="font-semibold text-slate-700">Date:</span> {new Date(grp.invoice_date).toLocaleDateString('en-IN')}</span>}
                    <span><span className="font-semibold text-slate-700">Projects:</span> {grp.projects.length}</span>
                    <span><span className="font-semibold text-slate-700">Total:</span> <span className="text-indigo-700 font-bold">{formatCurrency(grp.total)}</span></span>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                      grp.invoice_status === 'Invoiced' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                    }`}>{grp.invoice_status}</span>
                  </div>
                  <div className="space-y-2">
                    {grp.projects.sort((a, b) => (a.start_date || '').localeCompare(b.start_date || '')).map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white transition-colors">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 truncate">{p.project_name}</div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {fmtD(p.start_date)}{p.end_date && p.end_date !== p.start_date ? ` – ${fmtD(p.end_date)}` : ''}
                            {p.venue ? ` · ${p.venue}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-sm font-bold text-indigo-700">{formatCurrency(getProjectGrandTotal(p))}</span>
                          <button
                            onClick={() => setDetailProject(p)}
                            className="flex items-center gap-1 text-xs bg-indigo-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-indigo-700 transition-colors font-semibold"
                          >
                            <ChevronRight size={13} /> Details
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {!selectedInvoiceNo && (
              <div className="p-6 text-center text-slate-400 text-sm">Select an invoice above to view its projects.</div>
            )}
          </div>
        )}

        {/* Actual expense transparency — only projects the owner opted into sharing */}
        {sharedExpenseProjects.length > 0 && (
          <div className="bg-white rounded-xl border border-teal-200 shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-teal-50 flex items-center gap-2">
              <Receipt size={18} className="text-teal-600" />
              <span className="font-semibold text-slate-800">Actual Expense Details</span>
              <span className="text-xs text-slate-500 hidden sm:inline">— shared at actuals, with proofs</span>
            </div>
            <div className="divide-y divide-slate-100">
              {sharedExpenseProjects.map(p => {
                const de = p.direct_expenses || [];
                const re = p.share_expense_details ? (p.reimbursable_expenses || []) : [];
                const total = de.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
                  + re.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
                return (
                  <div key={p.id} className="p-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-slate-800">{p.project_name || 'Project'}</div>
                      <div className="text-xs text-slate-500">
                        {de.length} expense{de.length === 1 ? '' : 's'} · {re.length} reimbursable{re.length === 1 ? '' : 's'} · {fmtAmt(total)}
                      </div>
                    </div>
                    <button onClick={() => setExpenseProject(p)} className="shrink-0 inline-flex items-center gap-1.5 text-sm bg-teal-600 text-white px-3 py-1.5 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap">
                      <Eye size={14} /> View Expenses &amp; Proofs
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between bg-slate-50">
              <span className="font-semibold">
                {fyFilter === 'ALL' ? 'All Financial Years' : `FY ${fyFilter}`}
              </span>
              {fyFilter !== 'ALL' && (() => {
                const fyRows = visibleRows.filter(r => r._type === 'row' || r._type === 'bcf');
                const closing = fyRows.length > 0 ? fyRows[fyRows.length - 1].Balance : null;
                return closing !== null ? (
                  <span className={`text-sm font-bold px-3 py-1 rounded-full ${closing >= 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    Closing Balance: {formatCurrency(Math.abs(closing))} {closing >= 0 ? 'Dr' : 'Cr'}
                  </span>
                ) : null;
              })()}
            </div>
          {companyBalances.length > 1 && (
            <div className="grid gap-2 p-3 border-b bg-indigo-50/40 md:grid-cols-2">
              {companyBalances.map(c => (
                <div key={c.key} className="rounded-lg border border-indigo-100 bg-white p-2">
                  <div className="text-xs font-semibold text-slate-700">{c.name}</div>
                  {c.gstin && <div className="text-[11px] font-mono text-slate-500 mt-0.5">{c.gstin}</div>}
                  <div className={`mt-1 text-sm font-bold ${c.balance >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {formatCurrency(Math.abs(c.balance))} {c.balance >= 0 ? 'Dr' : 'Cr'}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-100 text-slate-600 text-xs uppercase">
                <tr>
                  <th className="p-3 whitespace-nowrap">Date</th>
                  <th className="p-3">Description</th>
                  <th className="p-3 text-right">Debit</th>
                  <th className="p-3 text-right">Credit</th>
                  <th className="p-3 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((row, idx) => {
                  if (row._type === 'fy_header') {
                    return (
                      <tr key={`fyhdr-${idx}`}>
                        <td colSpan={5} className="px-4 py-2 bg-indigo-700 text-white font-bold text-xs uppercase tracking-widest">
                          ◆&nbsp; Financial Year {row.fy}
                        </td>
                      </tr>
                    );
                  }
                  if (row._type === 'bcf') {
                    return (
                      <tr key={`bcf-${idx}`} className="bg-amber-50 font-semibold border-y-2 border-amber-200">
                        <td className="p-3 whitespace-nowrap text-amber-800 text-xs">
                          {row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}
                        </td>
                        <td className="p-3 italic text-amber-800">{row.Description}</td>
                        <td className="p-3 text-right text-slate-700">{row.Debit > 0 ? formatCurrency(row.Debit) : '—'}</td>
                        <td className="p-3 text-right text-slate-700">{row.Credit > 0 ? formatCurrency(row.Credit) : '—'}</td>
                        <td className="p-3 text-right font-bold text-indigo-700">{formatCurrency(row.Balance)}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={idx} className="hover:bg-slate-50">
                      <td className="p-3 whitespace-nowrap text-slate-500">
                        {row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}
                      </td>
                      <td className="p-3 text-slate-700">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span>{row.Description}</span>
                            {row.company_name && (
                              <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                                {row.company_name}
                              </span>
                            )}
                            {row.entry_tag && (
                              <span className={`ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                                row.entry_tag === 'PI'
                                  ? 'bg-purple-100 text-purple-700'
                                  : row.entry_tag === 'PO'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-slate-100 text-slate-500'
                              }`}>{row.entry_tag}</span>
                            )}
                          </div>
                          {row.project_id && (() => {
                            const proj = projects.find(p => p.id === row.project_id);
                            return proj ? (
                              <button
                                onClick={() => setDetailProject(proj)}
                                className="shrink-0 text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 font-semibold px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                              >
                                View Details
                              </button>
                            ) : null;
                          })()}
                        </div>
                        {row.invoice_status && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${row.invoice_status === 'Invoiced' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                              {row.invoice_status}
                            </span>
                            {row.invoice_no && row.invoice_no !== '—' && (
                              <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"> Inv# {row.invoice_no}</span>
                            )}
                            {row.invoice_date && row.invoice_date !== '—' && (
                              <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded"> {new Date(row.invoice_date).toLocaleDateString('en-IN')}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right text-slate-600">{row.Debit > 0 ? formatCurrency(row.Debit) : '—'}</td>
                      <td className="p-3 text-right text-slate-600">{row.Credit > 0 ? formatCurrency(row.Credit) : '—'}</td>
                      <td className={`p-3 text-right font-semibold ${row.Balance >= 0 ? 'text-slate-800' : 'text-red-600'}`}>
                        {formatCurrency(Math.abs(row.Balance))} {row.Balance >= 0 ? 'Dr' : 'Cr'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleRows.length === 0 && (
              <div className="p-8 text-center text-slate-400">No ledger entries found.</div>
            )}
          </div>
        </div>
        <div className="text-xs text-slate-400 text-center">Generated by {orgSettings?.name || 'RentalOps'}</div>
      </div>

      {/* ── Project Detail Modal ──────────────────────────────────────────── */}
      {detailProject && (() => {
        const p = detailProject;
        const { items, equipTotal, logistics, logTotal, pos, poTotal, reimbursable, reimbTotal } = getDetailSections(p);
        const grandTotal = equipTotal + logTotal + poTotal + reimbTotal;
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-6 overflow-hidden">
              {/* Header */}
              <div className="bg-indigo-700 px-6 py-4 flex items-center justify-between">
                <div>
                  <div className="text-white/70 text-xs uppercase tracking-widest">Project Cost Breakdown</div>
                  <div className="text-white text-xl font-bold mt-0.5">{p.project_name}</div>
                  <div className="text-indigo-200 text-sm mt-0.5">
                    {fmtD(p.start_date)} – {fmtD(p.end_date)}
                    {p.setup_date ? ` · Setup: ${fmtD(p.setup_date)}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => exportDetailPDF(p)}
                    className="flex items-center gap-1.5 bg-white text-indigo-700 font-bold text-sm px-4 py-2 rounded-lg hover:bg-indigo-50 transition-colors"
                  >
                    <FileText size={15} /> Export PDF
                  </button>
                  <button onClick={() => setDetailProject(null)} className="text-white/70 hover:text-white transition-colors ml-2">
                    <X size={22} />
                  </button>
                </div>
              </div>

              <div className="p-6 space-y-6 overflow-y-auto max-h-[80vh]">

                {/* Equipment */}
                {items.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Equipment / Services</span>
                      <span className="ml-auto text-sm font-bold text-indigo-700">{fmtAmt(equipTotal)}</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                          <tr>
                            <th className="p-2 text-left">Item</th>
                            <th className="p-2 text-center">Qty</th>
                            <th className="p-2 text-right">Rate</th>
                            <th className="p-2 text-center">Days</th>
                            <th className="p-2 text-center">GST%</th>
                            <th className="p-2 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {items.map((i, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="p-2 font-medium text-slate-800">{i.name}<span className="text-xs text-slate-400 ml-1">({i.category})</span></td>
                              <td className="p-2 text-center text-slate-600">{i.qty}</td>
                              <td className="p-2 text-right text-slate-600">{fmtAmt(i.rate)}</td>
                              <td className="p-2 text-center text-slate-600">{i.days}</td>
                              <td className="p-2 text-center text-slate-600">{i.gst}%</td>
                              <td className="p-2 text-right font-semibold text-slate-800">{fmtAmt(i.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-indigo-50">
                          <tr><td colSpan={5} className="p-2 text-right text-xs font-bold text-indigo-700 uppercase">Equipment Subtotal</td><td className="p-2 text-right font-bold text-indigo-700">{fmtAmt(equipTotal)}</td></tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}

                {/* Logistics */}
                {logistics.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Logistics Costs</span>
                      <span className="ml-auto text-sm font-bold text-indigo-700">{fmtAmt(logTotal)}</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                          <tr>
                            <th className="p-2 text-left">Type</th>
                            <th className="p-2 text-left">Description</th>
                            <th className="p-2 text-right">Amount</th>
                            <th className="p-2 text-center">GST%</th>
                            <th className="p-2 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {logistics.map((l, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="p-2 font-medium text-slate-800">{l.type}</td>
                              <td className="p-2 text-slate-600">{l.description}</td>
                              <td className="p-2 text-right text-slate-600">{fmtAmt(l.amount)}</td>
                              <td className="p-2 text-center text-slate-600">{l.gst}%</td>
                              <td className="p-2 text-right font-semibold text-slate-800">{fmtAmt(l.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-indigo-50">
                          <tr><td colSpan={4} className="p-2 text-right text-xs font-bold text-indigo-700 uppercase">Logistics Subtotal</td><td className="p-2 text-right font-bold text-indigo-700">{fmtAmt(logTotal)}</td></tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}

                {/* Outsourcing / Services */}
                {pos.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Outsourcing / Services</span>
                      <span className="ml-auto text-sm font-bold text-indigo-700">{fmtAmt(poTotal)}</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                          <tr>
                            <th className="p-2 text-left">PO #</th>
                            <th className="p-2 text-left">Description</th>
                            <th className="p-2 text-left">Date</th>
                            <th className="p-2 text-center">Status</th>
                            <th className="p-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {pos.map((po, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="p-2 font-medium text-slate-800">{po.po_no}</td>
                              <td className="p-2 text-slate-600">{po.description}</td>
                              <td className="p-2 text-slate-500">{fmtD(po.date)}</td>
                              <td className="p-2 text-center"><span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">{po.status}</span></td>
                              <td className="p-2 text-right font-semibold text-slate-800">{fmtAmt(po.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-indigo-50">
                          <tr><td colSpan={4} className="p-2 text-right text-xs font-bold text-indigo-700 uppercase">Services Subtotal</td><td className="p-2 text-right font-bold text-indigo-700">{fmtAmt(poTotal)}</td></tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}

                {/* Client Reimbursable Expenses */}
                {reimbursable.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Client Reimbursable Expenses</span>
                      <span className="ml-auto text-sm font-bold text-indigo-700">{fmtAmt(reimbTotal)}</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                          <tr>
                            <th className="p-2 text-left">Date</th>
                            <th className="p-2 text-left">Description</th>
                            <th className="p-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {reimbursable.map((e, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="p-2 text-slate-500">{fmtD(e.date)}</td>
                              <td className="p-2 text-slate-700">{e.description}</td>
                              <td className="p-2 text-right font-semibold text-slate-800">{fmtAmt(e.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-indigo-50">
                          <tr><td colSpan={2} className="p-2 text-right text-xs font-bold text-indigo-700 uppercase">Reimbursable Subtotal</td><td className="p-2 text-right font-bold text-indigo-700">{fmtAmt(reimbTotal)}</td></tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}

                {items.length === 0 && logistics.length === 0 && pos.length === 0 && reimbursable.length === 0 && (
                  <div className="text-center text-slate-400 py-8">No cost breakdown available for this project.</div>
                )}

                {/* Grand Total */}
                <div className="rounded-xl bg-indigo-700 text-white px-6 py-4 flex items-center justify-between">
                  <span className="text-sm font-bold uppercase tracking-wide">Total Project Value</span>
                  <span className="text-2xl font-extrabold">{fmtAmt(grandTotal)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Actual Expense & Proof Detail Modal ───────────────────────────── */}
      {expenseProject && (() => {
        const p = expenseProject;
        const de = p.direct_expenses || [];
        const re = p.share_expense_details ? (p.reimbursable_expenses || []) : [];
        const deTotal = de.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
        const reTotal = re.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-6 overflow-hidden">
              <div className="bg-teal-700 px-6 py-4 flex items-center justify-between">
                <div>
                  <div className="text-white/70 text-xs uppercase tracking-widest">Actual Expenses &amp; Proofs</div>
                  <div className="text-white text-xl font-bold mt-0.5">{p.project_name}</div>
                </div>
                <button onClick={() => setExpenseProject(null)} className="text-white/70 hover:text-white transition-colors"><X size={22} /></button>
              </div>

              <div className="p-6 space-y-6 overflow-y-auto max-h-[80vh]">
                {/* Direct / actual expenses */}
                {de.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Expenses Incurred</span>
                      <span className="ml-auto text-sm font-bold text-teal-700">{fmtAmt(deTotal)}</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                          <tr>
                            <th className="p-2 text-left">Date</th>
                            <th className="p-2 text-left">Category</th>
                            <th className="p-2 text-left">Description</th>
                            <th className="p-2 text-right">Amount</th>
                            <th className="p-2 text-center">Proof</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {de.map((e, i) => (
                            <tr key={i} className="hover:bg-slate-50">
                              <td className="p-2 text-slate-500 whitespace-nowrap">{fmtD(e.date)}</td>
                              <td className="p-2">
                                <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{e.category || '—'}</span>
                              </td>
                              <td className="p-2 text-slate-700">{e.description || '—'}</td>
                              <td className="p-2 text-right font-semibold text-slate-800">{fmtAmt(e.amount)}</td>
                              <td className="p-2 text-center">{renderProof(e.proof_url, e.proof_name)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-teal-50">
                          <tr><td colSpan={3} className="p-2 text-right text-xs font-bold text-teal-700 uppercase">Subtotal</td><td className="p-2 text-right font-bold text-teal-700">{fmtAmt(deTotal)}</td><td /></tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}

                {/* Reimbursable expenses (with proofs) */}
                {re.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-bold text-slate-700 uppercase tracking-wide">Reimbursable Expenses</span>
                      <span className="ml-auto text-sm font-bold text-teal-700">{fmtAmt(reTotal)}</span>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                          <tr>
                            <th className="p-2 text-left">Date</th>
                            <th className="p-2 text-left">Description</th>
                            <th className="p-2 text-right">Amount</th>
                            <th className="p-2 text-center">Proof</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {re.map((e, i) => (
                            <tr key={i} className="hover:bg-slate-50">
                              <td className="p-2 text-slate-500 whitespace-nowrap">{fmtD(e.date)}</td>
                              <td className="p-2 text-slate-700">{e.description || e.category || '—'}</td>
                              <td className="p-2 text-right font-semibold text-slate-800">{fmtAmt(e.amount)}</td>
                              <td className="p-2 text-center">{renderProof(e.proof_url, e.proof_name)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-teal-50">
                          <tr><td colSpan={2} className="p-2 text-right text-xs font-bold text-teal-700 uppercase">Subtotal</td><td className="p-2 text-right font-bold text-teal-700">{fmtAmt(reTotal)}</td><td /></tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}

                {de.length === 0 && re.length === 0 && (
                  <div className="text-center text-slate-400 py-8">No expense details shared for this project.</div>
                )}

                <div className="rounded-xl bg-teal-700 text-white px-6 py-4 flex items-center justify-between">
                  <span className="text-sm font-bold uppercase tracking-wide">Total Actual Expenses</span>
                  <span className="text-2xl font-extrabold">{fmtAmt(deTotal + reTotal)}</span>
                </div>
                <p className="text-[11px] text-slate-400">Proofs open in a new tab. Figures are actuals recorded by {orgSettings?.name || 'us'} for this project.</p>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default PublicLedger;
