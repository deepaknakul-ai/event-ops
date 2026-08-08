import React, { useState, useMemo } from 'react';
import { notify } from '../utils/toast';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area, ComposedChart
} from 'recharts';
import { FileText, Mail, MessageCircle, TrendingUp, AlertCircle } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';
import { formatCurrency, getProjectGrandTotal, getProjectGST, getFinancialYear, getEffectivePOCost, getProjectGSTBreakdown, getGSTR1Category, fmtDate, round2, isProjectInvoiced, sumLogisticsRecord } from '../utils/helpers';
import { GST_STATE_CODES } from '../utils/constants';
import { buildAccountingSnapshot } from '../utils/accounting';
import { purchaseGstSplit } from '../utils/aiAccountant';
import { can } from '../utils/permissions';

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

// C-3: Build a multi-FY merged snapshot for Reports. We invoke
// buildAccountingSnapshot per FY in the date range and merge the journal +
// ledger so summary reports (ageing, balance summary, P&L totals) draw from
// the same double-entry source of truth as the Accounting module.
const buildMergedSnapshot = ({ fyList, ...inputs }) => {
  const fys = (fyList && fyList.length > 0) ? fyList : ['ALL'];
  const merged = { journal: [], partyMap: {}, profitAndLoss: { revenue: 0, costOfGoodsSold: 0, grossProfit: 0, operatingExpenses: 0, netProfit: 0 } };
  fys.forEach((fy) => {
    const snap = buildAccountingSnapshot({ ...inputs, fyFilter: fy === 'ALL' ? null : fy });
    merged.journal.push(...(snap.journal || []));
    (snap.ledger || []).forEach((row) => {
      if (!row.account.startsWith('Party:')) return;
      // M-5: group by stable accountId (immune to rename) when available.
      const key = row.accountId || row.account;
      const cur = merged.partyMap[key] || { account: row.account, accountId: row.accountId || null, debit: 0, credit: 0, entries: [] };
      cur.debit += row.debit;
      cur.credit += row.credit;
      cur.entries.push(...(row.entries || []));
      merged.partyMap[key] = cur;
    });
    if (snap.profitAndLoss) {
      merged.profitAndLoss.revenue += snap.profitAndLoss.revenue || 0;
      merged.profitAndLoss.costOfGoodsSold += snap.profitAndLoss.costOfGoodsSold || 0;
      merged.profitAndLoss.grossProfit += snap.profitAndLoss.grossProfit || 0;
      merged.profitAndLoss.operatingExpenses += snap.profitAndLoss.operatingExpenses || 0;
      merged.profitAndLoss.netProfit += snap.profitAndLoss.netProfit || 0;
    }
  });
  // Finalize party balances
  Object.values(merged.partyMap).forEach((p) => {
    p.balance = Math.round((p.debit - p.credit) * 100) / 100;
    p.balanceType = p.balance >= 0 ? 'Dr' : 'Cr';
  });
  return merged;
};

const fysInRange = (startDate, endDate) => {
  // Returns the list of FYs spanned by [startDate, endDate]. If either is
  // missing we return an empty array (caller treats as "all FYs").
  if (!startDate && !endDate) return [];
  const start = startDate ? new Date(startDate) : new Date('2000-04-01');
  const end = endDate ? new Date(endDate) : new Date();
  const result = [];
  const fyOf = (d) => {
    const m = d.getMonth();
    const y = d.getFullYear();
    return m < 3 ? `${y - 1}-${String(y).slice(-2)}` : `${y}-${String(y + 1).slice(-2)}`;
  };
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const fy = fyOf(cur);
    if (!result.includes(fy)) result.push(fy);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return result;
};

const Reports = ({
  projects,
  clients,
  employees,
  expenses,
  inventory,
  payments,
  payouts = [],
  advances = [],
  vendorPayments = [],
  purchaseInvoices = [],
  taxInvoices = [],
  chartOfAccounts = [],
  openingBalances = [],
  fiscalYearClosings = [],
  journalEntries = [],
  partyAccounts = [],   // M-5: stable party name registry
  role,
}) => {
  const [reportType, setReportType] = useState('ledger');
  const [filterId, setFilterId] = useState(''); // Client ID
  const [selectedProjId, setSelectedProjId] = useState(''); // Project ID
  const [partyInvoiceFilter, setPartyInvoiceFilter] = useState('');
  const [isConsolidated, setIsConsolidated] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // --- Helper: Get Project Specific Data ---
  const selectedProject = projects.find(p => p.id === selectedProjId);

  // C-3: Single source of truth for receivable/payable balances and P&L
  // totals — derived from the Accounting double-entry snapshot. We rebuild
  // when any contributing collection changes; the snapshot internally
  // honours the project→PO→PI→TI precedence rules.
  const accountingSnapshot = useMemo(() => {
    const fys = fysInRange(startDate, endDate);
    return buildMergedSnapshot({
      fyList: fys,
      clients,
      projects,
      taxInvoices,
      purchaseInvoices,
      payments,
      vendorPayments,
      payouts,
      expenses,
      advances,
      employees,
      chartOfAccounts,
      openingBalances,
      fiscalYearClosings,
      partyAccounts,  // M-5
      manualJournalEntries: journalEntries,
    });
  }, [startDate, endDate, clients, projects, taxInvoices, purchaseInvoices, payments, vendorPayments, payouts, expenses, advances, employees, chartOfAccounts, openingBalances, fiscalYearClosings, journalEntries, partyAccounts]);

  // M-5: lookup by stable accountId first; fall back to name-based key for legacy rows.
  const getPartyBalanceFromSnapshot = (entityName, entityId) => {
    if (entityId) {
      const idKey = `party_${entityId}`;
      const byId = accountingSnapshot.partyMap[idKey];
      if (byId) return byId.balance;
    }
    const key = `Party: ${entityName || 'Unknown Party'}`;
    const row = accountingSnapshot.partyMap[key];
    return row ? row.balance : 0;
  };

  // --- Data Preparation Logic ---
  const reportData = useMemo(() => {

    // --- 1. Client Ledger Report ---
    if (reportType === 'ledger') {
      if (!filterId) return [];

      const selectedClient = clients.find(c => c.id === filterId);
      const includeVendorLedger = selectedClient?.type === 'Both';

      const clientInvoices = projects
        .filter(p => p.client_id === filterId && ['Completed', 'Closed'].includes(p.status))
        .map(p => {
          const isInvoiced = isProjectInvoiced(p.invoice_status);
          // Rule: Completed-not-invoiced projects appear in the client ledger
          // as UNBILLED entries (giving the full picture of what the client
          // owes). Once invoiced, the entry flips to INVOICED with the
          // invoice number + date as the reference.
          const invoiceNo = p.invoice_no || '—';
          const desc = isInvoiced
            ? `Invoice ${invoiceNo}: ${p.project_name}`
            : `Unbilled: ${p.project_name} (completed — awaiting invoice)`;
          return {
            date: isInvoiced ? (p.invoice_date || p.end_date) : p.end_date,
            desc,
            debit: getProjectGrandTotal(p),
            credit: 0,
            type: isInvoiced ? 'invoice' : 'unbilled',
            invoice_status: isInvoiced ? 'Invoiced' : 'Unbilled',
            invoice_no: isInvoiced ? invoiceNo : '—',
            invoice_date: isInvoiced ? (p.invoice_date || '—') : '—'
          };
        });

      const clientPayments = payments
        .filter(p => p.client_id === filterId)
        .map(p => ({
          date: p.date,
          desc: `Payment: ${p.mode} - ${p.reference}`,
          debit: 0,
          credit: p.amount,
          type: 'payment',
          invoice_status: '', invoice_no: '', invoice_date: ''
        }));

      const vendorBills = [];
      const vendorPaymentRows = [];
      if (includeVendorLedger) {
        /*
         * PRECEDENCE: PI (include_in_ledger=true) > PO > Allocation
         * A PI with linked_po_id supersedes that PO entry in the ledger.
         */
        const vendorPIs = purchaseInvoices.filter(
          pi => pi.vendor_id === filterId && pi.include_in_ledger && pi.status !== 'Rejected'
        );
        const supersededPOKeys = new Set(
          vendorPIs.filter(pi => pi.linked_po_id).map(pi => pi.linked_po_id)
        );

        // POs — skip superseded ones
        projects.forEach(p => {
          if (p.purchase_orders) {
            p.purchase_orders.forEach(po => {
              if (po.vendor_id === filterId && po.status !== 'Cancelled') {
                // H-5: match supersession by stable po.id OR legacy composite key
                const poKey = `${p.id}::${po.po_no}`;
                if (supersededPOKeys.has(po.id || '') || supersededPOKeys.has(poKey)) return;
                const eff = getEffectivePOCost(po);
                vendorBills.push({
                  date: po.date,
                  desc: `PO: ${po.po_no} (${p.project_name})`,
                  debit: 0, credit: eff.total, type: 'vendor_bill',
                  invoice_status: '', invoice_no: '', invoice_date: ''
                });
              }
            });
          }
        });

        // Purchase Invoices (supersede linked PO or standalone)
        vendorPIs.forEach(pi => {
          const piTotal = (parseFloat(pi.amount) || 0) + (parseFloat(pi.gst_amount) || 0);
          const linkedLabel = pi.linked_po_no ? ` (replaces PO ${pi.linked_po_no})` : '';
          vendorBills.push({
            date: pi.invoice_date,
            desc: `PI: ${pi.pi_no}${linkedLabel} — ${pi.description || pi.vendor_name}`,
            debit: 0, credit: piTotal, type: 'purchase_invoice',
            invoice_status: pi.status || '',
            invoice_no: pi.invoice_ref || pi.pi_no,
            invoice_date: pi.invoice_date || ''
          });
        });

        vendorPayments.filter(p => p.vendor_id === filterId).forEach(p =>
          vendorPaymentRows.push({
            date: p.date,
            desc: `Vendor Payment: ${p.mode} - ${p.reference}`,
            debit: parseFloat(p.amount || 0), credit: 0, type: 'vendor_payment',
            invoice_status: '', invoice_no: '', invoice_date: ''
          })
        );
      }

      const combined = [...clientInvoices, ...clientPayments, ...vendorBills, ...vendorPaymentRows]
        .sort((a,b) => new Date(a.date) - new Date(b.date));

      let balance = 0;
      return combined.map(row => {
        balance += (row.debit - row.credit);
        return {
          Date: row.date,
          Description: row.desc,
          'Invoice Status': row.invoice_status,
          'Invoice No': row.invoice_no,
          'Invoice Date': row.invoice_date,
          'Debit (Inv)': row.debit,
          'Credit (Rec)': row.credit,
          Balance: balance
        };
      });
    }

    // --- 11. Invoiced / Non-Invoiced Projects Report ---
    if (reportType === 'invoice_status') {
      const filterVal = filterId; // '' = All, 'Invoiced', 'Not Invoiced'
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      return projects
        .filter(p => ['Completed', 'Closed'].includes(p.status))
        .filter(p => {
          if (!filterVal) return true;
          const status = p.invoice_status || 'Not Invoiced';
          return status === filterVal;
        })
        .filter(p => {
          if (!s && !e) return true;
          const d = new Date(p.end_date);
          if (s && d < s) return false;
          if (e && d > e) return false;
          return true;
        })
        .sort((a, b) => new Date(b.end_date) - new Date(a.end_date))
        .map(p => {
          const clientName = clients.find(c => c.id === p.client_id)?.name || '—';
          const total = getProjectGrandTotal(p);
          const received = payments
            .filter(pay => pay.client_id === p.client_id && pay.project_id === p.id)
            .reduce((s, pay) => s + parseFloat(pay.amount || 0), 0);
          return {
            Project: p.project_name,
            Client: clientName,
            'End Date': p.end_date || '—',
            'Project Status': p.status,
            'Invoice Status': p.invoice_status || 'Not Invoiced',
            'Invoice No': p.invoice_no || '—',
            'Invoice Date': p.invoice_date || '—',
            'Total Value': total,
            Received: received,
            Outstanding: total - received
          };
        });
    }

    // --- 11b. Client/Vendor Project Invoice Details ---
    if (reportType === 'party_project_invoice_details') {
      if (!filterId) return [];

      const selectedParty = clients.find(c => c.id === filterId);
      if (!selectedParty) return [];

      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      const includesClientProjects = selectedParty.type !== 'Vendor';
      const includesVendorProjects = selectedParty.type === 'Vendor' || selectedParty.type === 'Both';

      const matched = projects
        .filter((p) => {
          let match = false;
          if (includesClientProjects && p.client_id === filterId) match = true;

          if (!match && includesVendorProjects) {
            const hasPO = (p.purchase_orders || []).some(po => po.vendor_id === filterId && po.status !== 'Cancelled');
            const hasAlloc = (p.vendor_allocations || []).some(v => v.vendor_id === filterId);
            match = hasPO || hasAlloc;
          }

          if (!match) return false;
          if (!s && !e) return true;

          const pStart = new Date(p.start_date || p.setup_date || p.end_date);
          const pEnd = new Date(p.end_date || p.start_date || p.setup_date);
          if (s && pEnd < s) return false;
          if (e && pStart > e) return false;
          return true;
        })
        .map((p) => {
          const clientName = clients.find(c => c.id === p.client_id)?.name || '—';
          const asClient = p.client_id === filterId;
          const hasVendorPO = (p.purchase_orders || []).some(po => po.vendor_id === filterId && po.status !== 'Cancelled');
          const hasVendorAlloc = (p.vendor_allocations || []).some(v => v.vendor_id === filterId);

          let relation = 'Client';
          if (!asClient && (hasVendorPO || hasVendorAlloc)) relation = 'Vendor';
          if (asClient && (hasVendorPO || hasVendorAlloc)) relation = 'Client + Vendor';

          const invoiceStatus = p.invoice_status || 'Not Invoiced';
          const bucket = invoiceStatus === 'Invoiced' ? 'Invoiced' : 'Not Invoiced';

          return {
            Bucket: bucket,
            Project: p.project_name,
            Party: selectedParty.name,
            Relation: relation,
            Client: clientName,
            'Start Date': p.start_date || '—',
            'End Date': p.end_date || '—',
            'Project Status': p.status || '—',
            'Invoice Status': invoiceStatus,
            'Invoice No': p.invoice_no || '—',
            'Invoice Date': p.invoice_date || '—',
            'Project Value': getProjectGrandTotal(p),
            _bucketOrder: bucket === 'Invoiced' ? 0 : 1,
          };
        })
        .sort((a, b) => {
          if (a._bucketOrder !== b._bucketOrder) return a._bucketOrder - b._bucketOrder;
          return new Date(b['End Date']) - new Date(a['End Date']);
        });

      const visibleRows = !partyInvoiceFilter
        ? matched
        : matched.filter(r => r.Bucket === partyInvoiceFilter);

      const invoicedTotal = visibleRows
        .filter(r => r.Bucket === 'Invoiced')
        .reduce((sum, r) => sum + (Number(r['Project Value']) || 0), 0);
      const notInvoicedTotal = visibleRows
        .filter(r => r.Bucket === 'Not Invoiced')
        .reduce((sum, r) => sum + (Number(r['Project Value']) || 0), 0);

      return [
        ...visibleRows,
        {
          Bucket: 'TOTAL',
          Project: `${visibleRows.filter(r => r.Bucket === 'Invoiced').length} Invoiced Projects`,
          Party: selectedParty.name,
          Relation: '—',
          Client: '—',
          'Start Date': '—',
          'End Date': '—',
          'Project Status': '—',
          'Invoice Status': 'Invoiced',
          'Invoice No': '—',
          'Invoice Date': '—',
          'Project Value': invoicedTotal,
          _isTotal: true,
          _bucketOrder: 0,
        },
        {
          Bucket: 'TOTAL',
          Project: `${visibleRows.filter(r => r.Bucket === 'Not Invoiced').length} Not Invoiced Projects`,
          Party: selectedParty.name,
          Relation: '—',
          Client: '—',
          'Start Date': '—',
          'End Date': '—',
          'Project Status': '—',
          'Invoice Status': 'Not Invoiced',
          'Invoice No': '—',
          'Invoice Date': '—',
          'Project Value': notInvoicedTotal,
          _isTotal: true,
          _bucketOrder: 1,
        }
      ];
    }

    // --- 7b. Unbilled Shows + Reimbursables (by client) ---
    if (reportType === 'unbilled_shows') {
      const cid = filterId; // '' = all clients
      const unbilled = projects
        .filter(p => (!cid || p.client_id === cid)
          && ['Completed', 'Closed'].includes(p.status)
          && !isProjectInvoiced(p.invoice_status))
        .sort((a, b) => new Date(a.end_date || 0) - new Date(b.end_date || 0));

      const rows = [];
      let totShow = 0, totReimb = 0;
      unbilled.forEach(p => {
        const clientName = clients.find(c => c.id === p.client_id)?.name || '—';
        const grand = getProjectGrandTotal(p);
        const gst = getProjectGST(p);
        const taxable = Math.round((grand - gst) * 100) / 100;
        const reimbList = p.reimbursable_expenses || [];
        const reimbSum = reimbList.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
        totShow += grand; totReimb += reimbSum;
        rows.push({
          Type: 'Show',
          Client: clientName,
          'Show / Item': p.project_name || '—',
          Status: p.status,
          Start: fmtDate(p.start_date),
          End: fmtDate(p.end_date),
          Venue: p.venue || '—',
          Taxable: taxable,
          GST: gst,
          'Show Value': grand,
          Reimbursable: reimbSum,
          Total: Math.round((grand + reimbSum) * 100) / 100,
        });
        reimbList.forEach(r => {
          const amt = parseFloat(r.amount) || 0;
          rows.push({
            Type: '— Reimbursable',
            Client: clientName,
            'Show / Item': `${r.category ? r.category + ': ' : ''}${r.description || ''}`,
            Status: '',
            Start: r.date ? fmtDate(r.date) : '',
            End: '',
            Venue: '',
            Taxable: '',
            GST: '',
            'Show Value': '',
            Reimbursable: amt,
            Total: amt,
          });
        });
      });
      if (rows.length === 0) return [];
      rows.push({
        Type: 'TOTAL',
        Client: '',
        'Show / Item': `${unbilled.length} unbilled show(s)`,
        Status: '', Start: '', End: '', Venue: '',
        Taxable: '', GST: '',
        'Show Value': Math.round(totShow * 100) / 100,
        Reimbursable: Math.round(totReimb * 100) / 100,
        Total: Math.round((totShow + totReimb) * 100) / 100,
        _isTotal: true,
      });
      return rows;
    }

    // --- 8. Vendor Ledger Report ---
    if (reportType === 'vendor_ledger') {
      if (!filterId) return [];

      /*
       * PRECEDENCE: PI (include_in_ledger=true) > PO > Allocation
       */
      const vendorPIs = purchaseInvoices.filter(
        pi => pi.vendor_id === filterId && pi.include_in_ledger && pi.status !== 'Rejected'
      );
      const supersededPOKeys = new Set(
        vendorPIs.filter(pi => pi.linked_po_id).map(pi => pi.linked_po_id)
      );

      // POs — skip superseded
      const vendorBills = [];
      projects.forEach(p => {
        if (p.purchase_orders) {
          p.purchase_orders.forEach(po => {
            if (po.vendor_id === filterId && po.status !== 'Cancelled') {
              // H-5: match supersession by stable po.id OR legacy composite key
              const poKey = `${p.id}::${po.po_no}`;
              if (supersededPOKeys.has(po.id || '') || supersededPOKeys.has(poKey)) return;
              const eff = getEffectivePOCost(po);
              vendorBills.push({
                date: po.date,
                desc: `PO: ${po.po_no} (${p.project_name})`,
                credit: eff.total, debit: 0, type: 'bill'
              });
            }
          });
        }
      });

      // Purchase Invoices
      vendorPIs.forEach(pi => {
        const piTotal = (parseFloat(pi.amount) || 0) + (parseFloat(pi.gst_amount) || 0);
        const linkedLabel = pi.linked_po_no ? ` (replaces PO ${pi.linked_po_no})` : '';
        vendorBills.push({
          date: pi.invoice_date,
          desc: `PI: ${pi.pi_no}${linkedLabel} — ${pi.description || pi.vendor_name}`,
          credit: piTotal, debit: 0, type: 'purchase_invoice'
        });
      });

      // Payments
      const vPayments = vendorPayments.filter(p => p.vendor_id === filterId).map(p => ({
        date: p.date, desc: `Payment: ${p.mode} - ${p.reference}`,
        credit: 0, debit: parseFloat(p.amount || 0), type: 'payment'
      }));

      const combined = [...vendorBills, ...vPayments].sort((a, b) => new Date(a.date) - new Date(b.date));
      let balance = 0;
      return combined.map(row => {
        balance += (row.credit - row.debit);
        return {
          Date: row.date,
          Description: row.desc,
          'Bill (Cr)': row.credit,
          'Paid (Dr)': row.debit,
          Balance: balance
        };
      });
    }

    // --- 6. Employee Ledger (NEW) ---
    if (reportType === 'employee_ledger') {
      if (!filterId) return [];

      // Filter items
      let empAdvances = (advances || []).filter(a => String(a.employee_id) === String(filterId));
      let empPayouts = (payouts || []).filter(p => String(p.employee_id) === String(filterId));
      let empExpensesAll = (expenses || []).filter(e => String(e.employee_id) === String(filterId));

      // Date Filtering
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if(e) e.setHours(23,59,59,999);

      const filterDate = (item) => {
          const d = new Date(item.date || item.created_at);
          if (s && d < s) return false;
          if (e && d > e) return false;
          return true;
      };

      empAdvances = empAdvances.filter(filterDate);
      empPayouts = empPayouts.filter(filterDate);
      empExpensesAll = empExpensesAll.filter(filterDate);

        const advanceRows = empAdvances.map(a => ({
          date: a.date, desc: `Advance: ${a.remarks || '-'}`, project: '-', debit: parseFloat(a.amount), credit: 0, type: 'advance'
      }));

      // Payouts labelled by kind. Salary (and legacy untyped) payouts are shown
      // for completeness but do NOT settle expense claims — the books route them
      // to Salary Expense, not the employee's account (grey-area C2).
      const isClaimSettling = (p) => ['reimbursement', 'advance', 'advance_settlement'].includes(String(p.payout_type || '').toLowerCase());
      const payoutRows = empPayouts.map(p => ({
          date: p.date,
          desc: `Payout (${isClaimSettling(p) ? (String(p.payout_type).toLowerCase() === 'reimbursement' ? 'reimbursement' : 'advance') : (p.payout_type === 'salary' ? 'salary' : 'salary, assumed')}): ${p.mode} - ${p.reference || '-'}`,
          project: '-',
          debit: isClaimSettling(p) ? parseFloat(p.amount) : 0,
          credit: 0,
          salaryInfo: isClaimSettling(p) ? 0 : parseFloat(p.amount),
          type: 'payout'
      }));

      const approvedExpenses = empExpensesAll.filter(e => e.status === 'Approved');
      const unapprovedExpenses = empExpensesAll.filter(e => e.status !== 'Approved' && !isExpenseExcludedStatus(e.status));
      const rejectedExpenses = empExpensesAll.filter(e => isExpenseExcludedStatus(e.status));
      const clarificationExpenses = empExpensesAll.filter(e => e.status === 'Clarification');

      const sumAmounts = (list) => list.reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
      const approvedTotal = sumAmounts(approvedExpenses);
      const unapprovedTotal = sumAmounts(unapprovedExpenses);
      const rejectedTotal = sumAmounts(rejectedExpenses);
      const clarificationTotal = sumAmounts(clarificationExpenses);

      const buildExpenseRows = (list, labelPrefix) => {
        if (!isConsolidated) {
          return list.map(exp => ({
            date: exp.date,
            desc: `${labelPrefix}${exp.category}: ${exp.remarks || '-'}`,
            project: exp.is_general ? 'General Ops' : (projects.find(p=>p.id===exp.project_id)?.project_name || 'Unknown'),
            debit: 0,
            credit: parseFloat(exp.amount),
            type: 'expense'
          }));
        }

        const grouped = {};
        list.forEach(exp => {
          const pid = exp.project_id || 'general';
          if (!grouped[pid]) {
            grouped[pid] = { amount: 0, name: exp.is_general ? 'General Ops' : (projects.find(p=>p.id===pid)?.project_name || 'Unknown') };
          }
          grouped[pid].amount += parseFloat(exp.amount);
        });
        return Object.values(grouped).map(g => ({
          date: endDate || new Date().toISOString().split('T')[0],
          desc: `${labelPrefix}Consolidated Expenses`,
          project: g.name,
          debit: 0,
          credit: g.amount,
          type: 'expense'
        }));
      };

      const approvedExpenseRows = buildExpenseRows(approvedExpenses, 'Approved: ');
      const unapprovedExpenseRows = buildExpenseRows(unapprovedExpenses, 'Unapproved: ');

      const combined = [...advanceRows, ...payoutRows, ...approvedExpenseRows]
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const paymentsTotal = advanceRows.reduce((s, r) => s + r.debit, 0) + payoutRows.reduce((s, r) => s + r.debit, 0);

      let balance = 0;
      const combinedRows = combined.map(row => {
        balance += (row.credit - row.debit);
        return {
          Date: row.date,
          // Salary payouts show their amount in the description but do not move
          // the claim balance (they book to Salary Expense, not this account).
          Description: row.salaryInfo ? `${row.desc} — ${row.salaryInfo.toFixed(2)} (salary, not counted against claims)` : row.desc,
          Project: row.project,
          'Expense (Cr)': row.credit,
          'Payment (Dr)': row.debit,
          Balance: balance
        };
      });

      const summaryRows = [
        { Date: '-', Description: 'Approved Expenses Total', Project: '-', 'Expense (Cr)': approvedTotal, 'Payment (Dr)': 0, Balance: '', _isTotal: true },
        { Date: '-', Description: 'Unapproved Expenses Total', Project: '-', 'Expense (Cr)': unapprovedTotal, 'Payment (Dr)': 0, Balance: '', _isTotal: true },
        { Date: '-', Description: 'Rejected Expenses Total', Project: '-', 'Expense (Cr)': rejectedTotal, 'Payment (Dr)': 0, Balance: '', _isTotal: true },
        { Date: '-', Description: 'Clarification Expenses Total', Project: '-', 'Expense (Cr)': clarificationTotal, 'Payment (Dr)': 0, Balance: '', _isTotal: true }
      ];

      const totalRow = {
        Date: '-',
        Description: 'Total (Payments + Approved Expenses)',
        Project: '-',
        'Expense (Cr)': approvedTotal,
        'Payment (Dr)': paymentsTotal,
        Balance: balance,
        _isTotal: true
      };

      const unapprovedRows = unapprovedExpenseRows
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map(row => ({
          Date: row.date,
          Description: row.desc,
          Project: row.project,
          'Expense (Cr)': row.credit,
          'Payment (Dr)': row.debit,
          Balance: ''
        }));

      return [...summaryRows, ...combinedRows, totalRow, ...unapprovedRows];
    }

    // --- 7. Client/Vendor Balance Report ---
    // C-3: Net balance is now read directly from the snapshot's party
    // ledger so it reconciles with the Accounting → Ledger view. The
    // bill/invoice/paid totals are kept for context but the authoritative
    // 'Net Balance' column is the snapshot balance.
    if (reportType === 'client_balance') {
      return clients.map(c => {
          // Client Logic (Receivables) — used for context columns only
          let clientInvoiced = 0;
          let clientReceived = 0;

          if (c.type === 'Client' || c.type === 'Both') {
             const clientProjects = projects.filter(p => p.client_id === c.id && ['Completed', 'Closed'].includes(p.status));
             clientInvoiced = clientProjects.reduce((sum, p) => sum + getProjectGrandTotal(p), 0);

             const clientPayments = payments.filter(p => p.client_id === c.id);
             clientReceived = clientPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
          }

          // Vendor Logic (Payables) — used for context columns only
          let vendorBilled = 0;
          let vendorPaid = 0;

          if (c.type === 'Vendor' || c.type === 'Both') {
             projects.forEach(p => {
                 if(p.purchase_orders) {
                     p.purchase_orders.forEach(po => {
                         if(po.vendor_id === c.id && po.status !== 'Cancelled') {
                             vendorBilled += getEffectivePOCost(po).total;
                         }
                     });
                 }
             });
             vendorPaid = vendorPayments.filter(p => p.vendor_id === c.id).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
          }

          // Authoritative net balance from snapshot ledger.
          const snapshotBalance = getPartyBalanceFromSnapshot(c.name, c.id);  // M-5: id-first lookup

          return {
              Name: c.name,
              Type: c.type,
              'Client Inv': clientInvoiced,
              'Client Rec': clientReceived,
              'Vendor Bill': vendorBilled,
              'Vendor Paid': vendorPaid,
              'Net Balance': snapshotBalance, // From accounting snapshot
          };
      }).sort((a, b) => b['Net Balance'] - a['Net Balance']);
    }

    // --- 2. Project Revenue Summary (Existing) ---
    if (reportType === 'projects_summary') {
      return projects.filter(p => {
        const s = startDate ? new Date(startDate) : new Date('2000-01-01');
        const e = endDate ? new Date(endDate) : new Date('2099-12-31');
        const pStart = new Date(p.start_date);
        return pStart >= s && pStart <= e;
      }).map(p => ({
           Project: p.project_name,
           Client: clients.find(c => c.id === p.client_id)?.name || 'Unknown',
           Start: p.start_date,
           Status: p.status,
           Revenue: getProjectGrandTotal(p)
      }));
    }

    // --- 3. Project Operations / Tech Sheet (NEW) ---
    if (reportType === 'project_ops') {
        if (!selectedProject) return [];

        // Combine Internal Items and Outsourced Allocations for a full gear list
        const internalGear = (selectedProject.items || []).map(i => ({
            Category: i.category || 'Equipment',
            Item: i.item_name,
            Qty: i.qty,
            Source: i.is_external ? 'Cross-Hired' : 'In-House',
            Notes: '-'
        }));

        const outsourcedGear = (selectedProject.vendor_allocations || []).map(v => ({
            Category: 'Outsourced',
            Item: v.item_name,
            Qty: v.qty,
            Source: `Vendor: ${v.vendor_name}`,
            Notes: 'External Vendor'
        }));

        return [...internalGear, ...outsourcedGear];
    }

    // --- 4. Project Expenses Report (NEW) ---
    if (reportType === 'project_expenses') {
        if (!selectedProject) return [];

        const projExpenses = expenses.filter(e => e.project_id === selectedProject.id && !isExpenseExcludedStatus(e.status));
        return projExpenses.map(e => ({
            Date: e.date,
            Category: e.category,
            Amount: e.amount,
            'Logged By': employees.find(emp => emp.id === e.employee_id)?.name || 'Unknown',
            Remarks: e.remarks || '-'
        }));
    }

    // --- 9. Rejected Expenses Report ---
    if (reportType === 'rejected_expenses') {
      const rejected = expenses.filter(e => isExpenseExcludedStatus(e.status));
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);
      return rejected
        .filter(item => {
          const d = new Date(item.date || item.created_at);
          if (s && d < s) return false;
          if (e && d > e) return false;
          return true;
        })
        .map(item => ({
          Date: item.date,
          Employee: employees.find(emp => emp.id === item.employee_id)?.name || 'Unknown',
          Project: item.is_general ? 'General Ops' : (projects.find(p => p.id === item.project_id)?.project_name || 'Unknown'),
          Category: item.category,
          Amount: parseFloat(item.amount || 0),
          Remarks: item.remarks || '-',
          Status: item.status
        }));
    }

    // --- 10. Clarification Expenses Report ---
    if (reportType === 'clarification_expenses') {
      const clarification = expenses.filter(e => e.status === 'Clarification');
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);
      return clarification
        .filter(item => {
          const d = new Date(item.date || item.created_at);
          if (s && d < s) return false;
          if (e && d > e) return false;
          return true;
        })
        .map(item => ({
          Date: item.date,
          Employee: employees.find(emp => emp.id === item.employee_id)?.name || 'Unknown',
          Project: item.is_general ? 'General Ops' : (projects.find(p => p.id === item.project_id)?.project_name || 'Unknown'),
          Category: item.category,
          Amount: parseFloat(item.amount || 0),
          Remarks: item.remarks || '-',
          Status: item.status
        }));
    }

    // --- 5. Project Profit & Loss (NEW) ---
    if (reportType === 'project_pnl') {
        if (!selectedProject) return [];

        // Check if package cost is specified
        const hasPackageCost = selectedProject.package_cost && selectedProject.package_cost > 0;

        let totalRevenue = 0;
        let revenueItems = [];

        if (hasPackageCost) {
            // Use package cost as the sole revenue
            const gstRate = selectedProject.package_cost_gst ?? 18;
            const gstAmount = (selectedProject.package_cost * gstRate) / 100;
            totalRevenue = selectedProject.package_cost + gstAmount;
            revenueItems = [
                { Section: 'REVENUE', Item: 'Package Cost (Excl. GST)', Amount: selectedProject.package_cost },
                { Section: 'REVENUE', Item: `GST (${gstRate}%)`, Amount: gstAmount }
            ];
        } else {
            // Calculate from items and logistics
            const equipmentRevenue = (selectedProject.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
            let logisticsRevenue = 0;
            if (selectedProject.logistics_costs) {
                Object.values(selectedProject.logistics_costs).forEach(c => {
                   logisticsRevenue += sumLogisticsRecord(c).total; // split-line aware (amount + GST)
                });
            }
            totalRevenue = equipmentRevenue + logisticsRevenue;
            revenueItems = [
                { Section: 'REVENUE', Item: 'Equipment Rental', Amount: equipmentRevenue },
                { Section: 'REVENUE', Item: 'Logistics & Services', Amount: logisticsRevenue }
            ];
        }

        // Cost Calculations (same for both scenarios)
        // Cost waterfall: POs (invoice actuals if Accepted/Verified, else PO committed cost) + unlinked allocations
        const posForPnl = (selectedProject.purchase_orders || []).filter(po => po.status !== 'Cancelled');
        const outsourcingFromPOs = posForPnl.reduce((acc, po) => acc + getEffectivePOCost(po).total, 0);
        const unlinkedAllocsForPnl = (selectedProject.vendor_allocations || []).filter(a => !a.po_id);
        const outsourcingFromAllocs = unlinkedAllocsForPnl.reduce((acc, v) => acc + (v.tax_amount || 0), 0);
        const outsourcingCost = outsourcingFromPOs + outsourcingFromAllocs;
        // Label shows source of cost data for transparency
        const hasPOInvoice = posForPnl.some(po => po.vendor_invoice?.status === 'Accepted' || po.vendor_invoice?.status === 'Verified');
        const costLabel = hasPOInvoice ? 'Outsourcing — Invoice Actuals' : posForPnl.length > 0 ? 'Outsourcing — PO Committed' : 'Outsourcing — Allocation Estimate';

        const directExpenses = expenses
          .filter(e => e.project_id === selectedProject.id && !isExpenseExcludedStatus(e.status))
          .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);

        const totalCost = outsourcingCost + directExpenses;
        const netProfit = totalRevenue - totalCost;

        return [
            ...revenueItems,
            { Section: 'REVENUE', Item: 'Total Revenue', Amount: totalRevenue, _isTotal: true },
            { Section: 'COSTS', Item: costLabel, Amount: -outsourcingCost },
            { Section: 'COSTS', Item: 'Direct Expenses', Amount: -directExpenses },
            { Section: 'COSTS', Item: 'Total Costs', Amount: -totalCost, _isTotal: true },
            { Section: 'PROFIT', Item: 'Net Profit / Loss', Amount: netProfit, _isTotal: true }
        ];
    }

    // --- 12. GST Report — Monthly Output vs Input GST ---
    if (reportType === 'gst_report') {
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      const monthlyData = {};

      // Output GST from issued tax invoices (tax point = invoice_date, not project end_date).
      taxInvoices
        .filter(inv => inv.status !== 'Cancelled' && inv.invoice_date)
        .forEach(inv => {
          const date = new Date(inv.invoice_date);
          if (s && date < s) return;
          if (e && date > e) return;
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          if (!monthlyData[key]) monthlyData[key] = { Month: key, 'Output GST': 0, 'Input GST (POs)': 0, 'Net GST Liability': 0, Projects: 0 };
          monthlyData[key]['Output GST'] += parseFloat(inv.gst_amount || 0);
          monthlyData[key].Projects += 1;
        });

      // Input GST from Purchase Orders
      projects.forEach(p => {
        if (!p.purchase_orders) return;
        p.purchase_orders.forEach(po => {
          if (po.status === 'Cancelled') return;
          const date = new Date(po.date || p.start_date);
          if (s && date < s) return;
          if (e && date > e) return;
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          if (!monthlyData[key]) monthlyData[key] = { Month: key, 'Output GST': 0, 'Input GST (POs)': 0, 'Net GST Liability': 0, Projects: 0 };
          // Use cost waterfall: invoice GST if Accepted/Verified, else PO GST
          monthlyData[key]['Input GST (POs)'] += getEffectivePOCost(po).gst;
        });
      });

      return Object.keys(monthlyData)
        .sort()
        .map(key => {
          const row = monthlyData[key];
          const [y, m] = key.split('-');
          const label = new Date(+y, +m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
          return {
            Month: label,
            'Output GST': row['Output GST'],
            'Input GST (POs)': row['Input GST (POs)'],
            'Net GST Liability': row['Output GST'] - row['Input GST (POs)'],
            'Projects Count': row.Projects,
          };
        });
    }

    // --- 13. P&L Timeline — Profit per Project ---
    if (reportType === 'pnl_timeline') {
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      return projects
        .filter(p => ['Completed', 'Closed'].includes(p.status))
        .filter(p => {
          const date = new Date(p.end_date);
          if (s && date < s) return false;
          if (e && date > e) return false;
          return true;
        })
        .sort((a, b) => new Date(a.end_date) - new Date(b.end_date))
        .map(p => {
          const revenue = getProjectGrandTotal(p);
          // Cost waterfall: POs (invoice actuals if Accepted/Verified → PO amount) + unlinked allocations
          const posForTimeline = (p.purchase_orders || []).filter(po => po.status !== 'Cancelled');
          const outsourcingFromPOs = posForTimeline.reduce((acc, po) => acc + getEffectivePOCost(po).total, 0);
          const unlinkedForTimeline = (p.vendor_allocations || []).filter(a => !a.po_id);
          const outsourcingFromAllocs = unlinkedForTimeline.reduce((acc, v) => acc + parseFloat(v.tax_amount || 0), 0);
          const outsourcing = outsourcingFromPOs + outsourcingFromAllocs;
          const directExpenses = expenses
            .filter(ex => ex.project_id === p.id && !isExpenseExcludedStatus(ex.status))
            .reduce((acc, ex) => acc + parseFloat(ex.amount || 0), 0);
          const totalCosts = outsourcing + directExpenses;
          const profit = revenue - totalCosts;
          const margin = revenue > 0 ? parseFloat(((profit / revenue) * 100).toFixed(1)) : 0;
          const clientName = clients.find(c => c.id === p.client_id)?.name || '—';
          return {
            Project: p.project_name,
            Client: clientName,
            Date: p.end_date,
            Revenue: revenue,
            'Total Costs': totalCosts,
            'Net Profit': profit,
            'Margin %': margin,
          };
        });
    }

    // --- 14. Aging Report — Outstanding Receivables ---
    // C-3: Aging is now derived from the accounting snapshot's party ledger
    // (which respects PI→PO→Allocation precedence and excludes
    // cancelled/rejected docs). We bucket by the date of each unmatched
    // debit entry on the party account (FIFO match against credits).
    if (reportType === 'aging_report') {
      const now = new Date();
      const bucketize = (daysOld) => {
        if (daysOld <= 30) return '0-30';
        if (daysOld <= 60) return '31-60';
        if (daysOld <= 90) return '61-90';
        return '90+';
      };

      return clients
        .filter(c => c.type === 'Client' || c.type === 'Both')
        .map(c => {
          const partyKey = `Party: ${c.name}`;
          const partyRow = accountingSnapshot.partyMap[partyKey];
          if (!partyRow || partyRow.balance <= 0.01) return null;

          // FIFO match credits (payments) against debits (invoices/projects)
          const debits = (partyRow.entries || [])
            .filter(e => e.side === 'Dr')
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
          const credits = (partyRow.entries || [])
            .filter(e => e.side === 'Cr')
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

          // Note: party debits credit their account in our convention. Need
          // to inspect both directions: a Dr entry on the party means we
          // billed them; a Cr entry means they paid. Because the entries[]
          // array on the ledger row contains both sides regardless of which
          // side this row represents, we filter by direction.
          let creditPool = credits.reduce((s, e) => s + (e.amount || 0), 0);
          const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
          debits.forEach(d => {
            const amt = d.amount || 0;
            const consumed = Math.min(creditPool, amt);
            creditPool -= consumed;
            const remaining = amt - consumed;
            if (remaining <= 0) return;
            const daysOld = Math.floor((now - new Date(d.date)) / (1000 * 60 * 60 * 24));
            buckets[bucketize(daysOld)] += remaining;
          });

          return {
            Client: c.name,
            'Total Outstanding': partyRow.balance,
            '0-30 Days': buckets['0-30'],
            '31-60 Days': buckets['31-60'],
            '61-90 Days': buckets['61-90'],
            '90+ Days': buckets['90+'],
            _phone: c.contacts?.[0]?.phone || '',
          };
        })
        .filter(Boolean)
        .sort((a, b) => b['Total Outstanding'] - a['Total Outstanding']);
    }

    // --- 15. GSTR-1 Invoice Register ---
    // Data source: tax_invoices collection (authoritative issued invoices).
    // Separated into B2B / B2CL / B2CS per GSTN filing requirement.
    if (reportType === 'gstr1') {
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      const fyOf = (dateStr) => {
        const d = new Date(dateStr);
        const m = d.getMonth(); const yr = d.getFullYear();
        return m < 3 ? `${yr-1}-${String(yr).slice(-2)}` : `${yr}-${String(yr+1).slice(-2)}`;
      };

      return taxInvoices
        .filter(inv => {
          if (inv.status === 'Cancelled') return false;
          if (!inv.invoice_date) return false;
          const d = new Date(inv.invoice_date);
          if (s && d < s) return false;
          if (e && d > e) return false;
          return true;
        })
        .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date))
        .flatMap(inv => {
          const category = getGSTR1Category(inv);
          const isIGST = (inv.supply_type || '') === 'IGST';
          const posCode = (inv.place_of_supply || '').substring(0, 2);
          const posName = GST_STATE_CODES[posCode] || posCode || '—';
          const buyerGSTIN = inv.bill_to_gstin_at_issue || inv.sale_company_gstin || '';
          const invoiceValue = parseFloat(inv.final_amount || inv.computed_total || 0);
          const base = {
            'GSTR-1 Table': category,
            'FY': fyOf(inv.invoice_date),
            'Invoice No': inv.invoice_no || '—',
            'Invoice Date': inv.invoice_date || '—',
            'Invoice Type': inv.invoice_type || 'Regular',
            'Buyer Name': inv.sale_company_name || inv.client_name || '—',
            'Buyer GSTIN': buyerGSTIN || 'Unregistered',
            'Place of Supply': posName,
            'Reverse Charge': inv.reverse_charge ? 'Y' : 'N',
            'Supply Type': isIGST ? 'IGST' : 'CGST+SGST',
          };
          // Rate-wise: one row per GST slab when the invoice carries a breakup;
          // Invoice Value shown only on the first slab row to avoid double-counting.
          const breakup = Array.isArray(inv.gst_breakup) && inv.gst_breakup.length ? inv.gst_breakup : null;
          if (breakup) {
            return breakup.map((b, i) => ({
              ...base,
              'Rate %': b.rate,
              'Taxable Value': round2(b.taxable || 0),
              'IGST Amt': isIGST ? round2(b.igst || 0) : 0,
              'CGST Amt': !isIGST ? round2(b.cgst || 0) : 0,
              'SGST Amt': !isIGST ? round2(b.sgst || 0) : 0,
              'Total GST': round2((b.cgst || 0) + (b.sgst || 0) + (b.igst || 0)),
              'Invoice Value': i === 0 ? invoiceValue : '',
            }));
          }
          // Legacy invoices (no breakup): single blended row.
          const taxable = parseFloat(inv.taxable || 0);
          const blendedRate = taxable > 0 ? Math.round((parseFloat(inv.gst_amount || 0) / taxable) * 100) : '';
          return [{
            ...base,
            'Rate %': blendedRate,
            'Taxable Value': taxable,
            'IGST Amt': isIGST ? parseFloat(inv.igst_amount || 0) : 0,
            'CGST Amt': !isIGST ? parseFloat(inv.cgst_amount || 0) : 0,
            'SGST Amt': !isIGST ? parseFloat(inv.sgst_amount || 0) : 0,
            'Total GST': parseFloat(inv.gst_amount || 0),
            'Invoice Value': invoiceValue,
          }];
        });
    }

    // --- 16. ITC Register (Input Tax Credit from POs & Purchase Invoices) ---
    if (reportType === 'itc_register') {
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      const rows = [];

      // From Purchase Invoices (highest accuracy - actual tax invoices received)
      purchaseInvoices.forEach(pi => {
        if (pi.status === 'Rejected') return;
        const vendor = clients.find(c => c.id === pi.vendor_id);
        const d = new Date(pi.invoice_date || pi.created_at);
        if (s && d < s) return;
        if (e && d > e) return;
        const gstAmt = parseFloat(pi.gst_amount || 0);
        // Prefer the split stored on the PI (4a); derive from stored supply_type
        // otherwise; legacy PIs (no supply_type) show the lump only.
        const split = purchaseGstSplit(gstAmt, pi.supply_type || 'unknown');
        rows.push({
          Date: pi.invoice_date || '—',
          Source: 'Purchase Invoice',
          'Doc No': pi.pi_no || '—',
          'Vendor Inv Ref': pi.invoice_ref || '—',
          Vendor: vendor?.name || pi.vendor_name || '—',
          'Vendor GSTIN': vendor?.gstin || '—',
          Description: pi.description || pi.pi_no || '—',
          'Taxable Amount': parseFloat(pi.amount || 0),
          'GST (Input)': gstAmt,
          CGST: split.cgst,
          SGST: split.sgst,
          IGST: split.igst,
          'Total': parseFloat(pi.amount || 0) + gstAmt,
          Status: pi.status || 'Active',
          'Eligible ITC': pi.include_in_ledger ? 'Yes' : 'No',
        });
      });

      // From Project POs (where vendor invoice is Accepted/Verified — ITC eligible)
      projects.forEach(p => {
        (p.purchase_orders || []).forEach(po => {
          if (po.status === 'Cancelled') return;
          const inv = po.vendor_invoice;
          // Only include POs with accepted/verified vendor invoices (actual ITC)
          // or all POs if no PI already covers this (via linked_po_id check)
          const piCoversThisPO = purchaseInvoices.some(pi =>
            pi.status !== 'Rejected' && (
              (po.id && pi.linked_po_id === po.id) ||
              pi.linked_po_id === `${p.id}::${po.po_no}`
            )
          );
          if (piCoversThisPO) return; // Already counted via PI
          const vendor = clients.find(c => c.id === po.vendor_id);
          const d = new Date(po.date || p.start_date);
          if (s && d < s) return;
          if (e && d > e) return;
          const eff = getEffectivePOCost(po);
          const hasActualInvoice = inv && (inv.status === 'Accepted' || inv.status === 'Verified');
          rows.push({
            Date: po.date || p.start_date || '—',
            Source: hasActualInvoice ? 'PO (Invoice Verified)' : 'PO (Committed)',
            'Doc No': po.po_no || '—',
            'Vendor Inv Ref': inv?.invoice_ref || '—',
            Vendor: vendor?.name || po.vendor_name || '—',
            'Vendor GSTIN': vendor?.gstin || '—',
            Description: `PO for: ${p.project_name}`,
            'Taxable Amount': eff.base,
            'GST (Input)': eff.gst,
            CGST: 0, // PO GST has no stored place-of-supply — kept as lump input
            SGST: 0,
            IGST: 0,
            'Total': eff.total,
            Status: po.status || 'Draft',
            'Eligible ITC': hasActualInvoice ? 'Yes' : 'Pending',
          });
        });
      });

      rows.sort((a, b) => new Date(a.Date) - new Date(b.Date));

      if (rows.length === 0) return rows;

      const totalTaxable = rows.reduce((s, r) => s + r['Taxable Amount'], 0);
      const totalGST = rows.reduce((s, r) => s + r['GST (Input)'], 0);
      const totalCgst = rows.reduce((s, r) => s + (r.CGST || 0), 0);
      const totalSgst = rows.reduce((s, r) => s + (r.SGST || 0), 0);
      const totalIgst = rows.reduce((s, r) => s + (r.IGST || 0), 0);
      const eligibleITC = rows.filter(r => r['Eligible ITC'] === 'Yes').reduce((s, r) => s + r['GST (Input)'], 0);

      rows.push({
        Date: '—', Source: 'TOTAL', 'Doc No': '', 'Vendor Inv Ref': '', Vendor: '', 'Vendor GSTIN': '',
        Description: `${rows.length} entries`,
        'Taxable Amount': totalTaxable,
        'GST (Input)': totalGST,
        CGST: totalCgst,
        SGST: totalSgst,
        IGST: totalIgst,
        Total: totalTaxable + totalGST,
        Status: '',
        'Eligible ITC': `Confirmed: ₹${eligibleITC.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
        _isTotal: true,
      });

      return rows;
    }

    // --- 17. GST Rate-wise Breakup ---
    if (reportType === 'gst_ratewise') {
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if (e) e.setHours(23, 59, 59, 999);

      // Build rate buckets for output GST
      const outputBuckets = {}; // key = gstRate
      const inputBuckets = {};

      projects
        .filter(p => ['Completed', 'Closed'].includes(p.status))
        .forEach(p => {
          const d = new Date(p.invoice_date || p.end_date);
          if (s && d < s) return;
          if (e && d > e) return;
          const gstBD = getProjectGSTBreakdown(p, '', '');
          gstBD.items.forEach(item => {
            const rate = item.gstRate;
            if (!outputBuckets[rate]) outputBuckets[rate] = { taxable: 0, gst: 0, count: 0 };
            outputBuckets[rate].taxable += item.taxable;
            outputBuckets[rate].gst += (item.igstAmt || item.cgstAmt + item.sgstAmt);
            outputBuckets[rate].count += 1;
          });
        });

      // Input from POs + Purchase Invoices
      purchaseInvoices.filter(pi => pi.status !== 'Rejected').forEach(pi => {
        const d = new Date(pi.invoice_date || pi.created_at);
        if (s && d < s) return;
        if (e && d > e) return;
        const base = parseFloat(pi.amount || 0);
        const gst = parseFloat(pi.gst_amount || 0);
        const rate = base > 0 ? Math.round((gst / base) * 100) : 0;
        if (!inputBuckets[rate]) inputBuckets[rate] = { taxable: 0, gst: 0 };
        inputBuckets[rate].taxable += base;
        inputBuckets[rate].gst += gst;
      });
      projects.forEach(p => {
        (p.purchase_orders || []).forEach(po => {
          if (po.status === 'Cancelled') return;
          const piCovers = purchaseInvoices.some(pi =>
            pi.status !== 'Rejected' && (
              (po.id && pi.linked_po_id === po.id) ||
              pi.linked_po_id === `${p.id}::${po.po_no}`
            )
          );
          if (piCovers) return;
          const d = new Date(po.date || p.start_date);
          if (s && d < s) return;
          if (e && d > e) return;
          const eff = getEffectivePOCost(po);
          const rate = eff.base > 0 ? Math.round((eff.gst / eff.base) * 100) : 0;
          if (!inputBuckets[rate]) inputBuckets[rate] = { taxable: 0, gst: 0 };
          inputBuckets[rate].taxable += eff.base;
          inputBuckets[rate].gst += eff.gst;
        });
      });

      const allRates = [...new Set([...Object.keys(outputBuckets).map(Number), ...Object.keys(inputBuckets).map(Number)])].sort((a, b) => a - b);

      return allRates.map(rate => {
        const out = outputBuckets[rate] || { taxable: 0, gst: 0 };
        const inp = inputBuckets[rate] || { taxable: 0, gst: 0 };
        return {
          'GST Rate': `${rate}%`,
          'Output Taxable': out.taxable,
          'Output GST': out.gst,
          'Input Taxable': inp.taxable,
          'Input GST (ITC)': inp.gst,
          'Net GST Payable': out.gst - inp.gst,
        };
      });
    }

    return [];
  }, [reportType, filterId, selectedProjId, partyInvoiceFilter, startDate, endDate, projects, clients, payments, expenses, employees, vendorPayments, purchaseInvoices, accountingSnapshot]);

  // --- Export Functions ---
  const exportPDF = () => {
    const doc = new jsPDF();

    // Header Info
    doc.setFontSize(16);
    doc.text(`REPORT: ${reportType.toUpperCase().replace('_', ' ')}`, 14, 20);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 26);

    // Contextual Header Info (Venue, Dates)
    if (selectedProject && ['project_ops', 'project_expenses', 'project_pnl'].includes(reportType)) {
        doc.setFontSize(12);
        doc.text(`Project: ${selectedProject.project_name}`, 14, 34);
        doc.setFontSize(10);
        doc.text(`Venue: ${selectedProject.venue} | Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, 14, 40);

        if (reportType === 'project_ops' && selectedProject.setup_date) {
            doc.text(`Setup Date: ${selectedProject.setup_date}`, 14, 46);
        }
    } else if(reportType === 'vendor_ledger') {
       const vendorName = clients.find(c => c.id === filterId)?.name;
       doc.text(`Vendor: ${vendorName}`, 14, 34);
    } else if(reportType === 'ledger') {
       const clientName = clients.find(c => c.id === filterId)?.name;
       doc.text(`Client: ${clientName}`, 14, 34);
    } else if(reportType === 'invoice_status') {
       const label = filterId ? `Filter: ${filterId}` : 'All Projects (Completed/Closed)';
       doc.text(label, 14, 34);
     } else if (reportType === 'party_project_invoice_details') {
       const partyName = clients.find(c => c.id === filterId)?.name || '—';
       doc.text(`Party: ${partyName}`, 14, 34);
    } else if(reportType === 'employee_ledger') {
       const empName = employees.find(e => e.id === filterId)?.name;
       doc.text(`Employee: ${empName}`, 14, 34);
       if (isConsolidated) doc.text(`(Consolidated View)`, 14, 40);
    }

    if (reportData.length === 0) return notify("No data to export", 'info');

    // Filter out internal keys like _isTotal
    const headers = Object.keys(reportData[0]).filter(k => !k.startsWith('_'));
    const data = reportData.map(row => headers.map(h => {
        if(typeof row[h] === 'number') return row[h].toFixed(2);
        return row[h];
    }));

    autoTable(doc, {
        head: [headers],
        body: data,
        startY: 50,
        // Style specific rows (like totals in P&L)
        didParseCell: function (data) {
            if (reportType === 'project_pnl') {
                const rawRow = reportData[data.row.index];
                if (rawRow && rawRow._isTotal) {
                    data.cell.styles.fontStyle = 'bold';
                    data.cell.styles.fillColor = [240, 240, 240];
                }
            }
        }
    });
    doc.save(`report_${reportType}.pdf`);
  };

  const exportExcel = () => {
    if (reportData.length === 0) return notify("No data to export", 'info');
    // Clean data for excel (remove _isTotal)
    const cleanData = reportData.map(({ _isTotal, ...rest }) => rest);
    const ws = XLSX.utils.json_to_sheet(cleanData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, `report_${reportType}.xlsx`);
  };

  const handleEmail = () => {
    let recipientEmail = '';
    let subject = `Report: ${reportType.toUpperCase().replace('_', ' ')}`;
    let body = "Please find the attached report.";

    if (reportType === 'ledger') {
       const client = clients.find(c => c.id === filterId);
       if (client && client.contacts?.length > 0) {
           const contact = client.contacts.find(c => c.email);
           if (contact) recipientEmail = contact.email;
       }
    } else if (reportType === 'party_project_invoice_details') {
       const party = clients.find(c => c.id === filterId);
       if (party && party.contacts?.length > 0) {
         const contact = party.contacts.find(c => c.email);
         if (contact) recipientEmail = contact.email;
       }
    } else if (reportType === 'vendor_ledger') {
       const vendor = clients.find(c => c.id === filterId);
       if (vendor && vendor.contacts?.length > 0) {
           const contact = vendor.contacts.find(c => c.email);
           if (contact) recipientEmail = contact.email;
       }
    } else if (reportType === 'employee_ledger') {
       const emp = employees.find(e => e.id === filterId);
       if (emp) recipientEmail = emp.email;
    }

    exportPDF();
    setTimeout(() => {
        window.location.href = `mailto:${recipientEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        notify("Report downloaded. Please attach the file to the email draft.", 'error');
    }, 500);
  };

  return (
    <div className="space-y-6 text-black">
      <h2 className="text-2xl font-bold text-slate-800">System Reports</h2>

      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="w-full md:w-auto">
            <label className="block text-sm font-medium text-slate-700 mb-1">Report Type</label>
            <select className="w-full rounded border p-2 min-w-[250px] text-black" value={reportType} onChange={(e) => { setReportType(e.target.value); setFilterId(''); setSelectedProjId(''); setPartyInvoiceFilter(''); }}>
               <option value="ledger">Client Ledger (Statement)</option>
               <option value="client_balance">Client/Vendor Balance Summary</option>
               <option value="vendor_ledger">Vendor Ledger</option>
               <option value="employee_ledger">Employee Ledger</option>
               <option value="invoice_status">Invoiced / Non-Invoiced Projects</option>
               <option value="party_project_invoice_details">Client/Vendor Invoice Project Details</option>
               <option value="unbilled_shows">Unbilled Shows + Reimbursables (by Client)</option>
               <option value="projects_summary">Revenue Summary (Date Range)</option>
               <option value="rejected_expenses">Rejected Expenses</option>
               <option value="clarification_expenses">Clarification Expenses</option>
               <option disabled>--- Project Specific ---</option>
               <option value="project_ops">Project Operations (Tech Sheet)</option>
               <option value="project_expenses">Project Expenses Detailed</option>
               <option value="project_pnl">Project Profit & Loss</option>
               <option disabled>--- Financial Analytics ---</option>
               <option value="gst_report">GST Report (Monthly Output vs Input)</option>
               <option value="gstr1">GSTR-1 Invoice Register</option>
               <option value="gst_ratewise">GST Rate-wise Breakup</option>
               <option value="itc_register">ITC Register (Input Tax Credit)</option>
               <option value="pnl_timeline">P&amp;L Timeline (Profit per Project)</option>
               <option value="aging_report">Aging Report (Outstanding Receivables)</option>
            </select>
          </div>

          {/* Filters based on Type */}
          {reportType === 'ledger' && (
            <div className="w-full md:w-auto">
               <label className="block text-sm font-medium text-slate-700 mb-1">Select Client</label>
               <select className="w-full rounded border p-2 min-w-[200px] text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                  <option value="">-- Choose Client --</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
               </select>
            </div>
          )}

          {reportType === 'invoice_status' && (
            <div className="w-full md:w-auto">
              <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Filter</label>
              <select className="w-full rounded border p-2 min-w-[180px] text-black" value={filterId} onChange={e => setFilterId(e.target.value)}>
                <option value="">All (Invoiced + Non-Invoiced)</option>
                <option value="Invoiced">Invoiced Only</option>
                <option value="Not Invoiced">Not Invoiced Only</option>
              </select>
            </div>
          )}

          {reportType === 'party_project_invoice_details' && (
            <>
            <div className="w-full md:w-auto">
              <label className="block text-sm font-medium text-slate-700 mb-1">Select Client / Vendor</label>
              <select className="w-full rounded border p-2 min-w-[240px] text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                <option value="">-- Choose Client / Vendor --</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.type || 'Client'})</option>
                ))}
              </select>
            </div>
            <div className="w-full md:w-auto">
              <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Filter</label>
              <select className="w-full rounded border p-2 min-w-[200px] text-black" value={partyInvoiceFilter} onChange={(e) => setPartyInvoiceFilter(e.target.value)}>
                <option value="">All Projects</option>
                <option value="Invoiced">Invoiced Projects</option>
                <option value="Not Invoiced">Non Invoiced Projects</option>
              </select>
            </div>
            </>
          )}

          {reportType === 'unbilled_shows' && (
            <div className="w-full md:w-auto">
              <label className="block text-sm font-medium text-slate-700 mb-1">Select Client</label>
              <select className="w-full rounded border p-2 min-w-[200px] text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                <option value="">All Clients</option>
                {clients.filter(c => c.type !== 'Vendor').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {reportType === 'vendor_ledger' && (
            <div className="w-full md:w-auto">
               <label className="block text-sm font-medium text-slate-700 mb-1">Select Vendor</label>
               <select className="w-full rounded border p-2 min-w-[200px] text-black bg-slate-50 border-slate-200 text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                  <option value="">-- Choose Vendor --</option>
                  {clients.filter(c => c.type === 'Vendor' || c.type === 'Both').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
               </select>
            </div>
          )}

          {reportType === 'employee_ledger' && (
            <div className="w-full md:w-auto flex flex-col gap-2">
               <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Select Employee</label>
                  <select className="w-full rounded border p-2 min-w-[200px] text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                      <option value="">-- Choose Employee --</option>
                      {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
               </div>
               <div className="flex items-center gap-2"><input type="checkbox" id="consolidated" checked={isConsolidated} onChange={e => setIsConsolidated(e.target.checked)} className="w-4 h-4 cursor-pointer accent-indigo-600 accent-indigo-500" /><label htmlFor="consolidated" className="text-sm text-slate-700 text-slate-300 cursor-pointer">Consolidate by Project</label></div>
            </div>
          )}

          {['project_ops', 'project_expenses', 'project_pnl'].includes(reportType) && (
            <div className="w-full md:w-auto">
               <label className="block text-sm font-medium text-slate-700 mb-1">Select Project</label>
               <select className="w-full rounded border p-2 min-w-[250px] text-black" value={selectedProjId} onChange={(e) => setSelectedProjId(e.target.value)}>
                  <option value="">-- Choose Project --</option>
                  {projects.sort((a,b) => new Date(b.start_date) - new Date(a.start_date)).map(p => (
                      <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>
                  ))}
               </select>
            </div>
          )}

          {['projects_summary', 'employee_ledger', 'rejected_expenses', 'clarification_expenses', 'invoice_status', 'party_project_invoice_details', 'gst_report', 'gstr1', 'gst_ratewise', 'itc_register', 'pnl_timeline'].includes(reportType) && (
            <>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">From</label><input type="date" className="rounded border p-2 text-black" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">To</label><input type="date" className="rounded border p-2 text-black" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
            </>
          )}

          <div className="flex gap-2 ml-auto w-full md:w-auto">
             <button onClick={exportPDF} className="flex-1 md:flex-none justify-center bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex gap-2 items-center"><FileText size={16} /> PDF</button>
             <button onClick={exportExcel} className="flex-1 md:flex-none justify-center bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex gap-2 items-center"><FileText size={16} /> Excel</button>
             <button onClick={handleEmail} className="flex-1 md:flex-none justify-center bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 flex gap-2 items-center"><Mail size={16} /> Email</button>
          </div>
        </div>
      </div>

      {/* P&L Timeline Chart */}
      {reportType === 'pnl_timeline' && reportData.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div className="font-semibold text-slate-700 mb-4 flex items-center gap-2"><TrendingUp size={16} className="text-indigo-600" /> Revenue vs Profit per Project</div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={reportData} margin={{ top: 5, right: 20, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="Project" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
              <YAxis tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
              <RechartsTooltip formatter={(v, name) => [formatCurrency(v), name]} />
              <Legend />
              <Bar dataKey="Revenue" fill="#6366f1" radius={[3,3,0,0]} />
              <Bar dataKey="Total Costs" fill="#f87171" radius={[3,3,0,0]} />
              <Line type="monotone" dataKey="Net Profit" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* GST Bar Chart */}
      {reportType === 'gst_report' && reportData.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div className="font-semibold text-slate-700 mb-4">Monthly GST Overview</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={reportData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="Month" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
              <RechartsTooltip formatter={(v, name) => [formatCurrency(v), name]} />
              <Legend />
              <Bar dataKey="Output GST" fill="#6366f1" radius={[3,3,0,0]} />
              <Bar dataKey="Input GST (POs)" fill="#f59e0b" radius={[3,3,0,0]} />
              <Bar dataKey="Net GST Liability" fill="#ef4444" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Aging Summary Cards */}
      {reportType === 'aging_report' && reportData.length > 0 && (() => {
        const total = reportData.reduce((s, r) => s + r['Total Outstanding'], 0);
        const b30 = reportData.reduce((s, r) => s + r['0-30 Days'], 0);
        const b60 = reportData.reduce((s, r) => s + r['31-60 Days'], 0);
        const b90 = reportData.reduce((s, r) => s + r['61-90 Days'], 0);
        const b90p = reportData.reduce((s, r) => s + r['90+ Days'], 0);
        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[['0-30 Days', b30, 'green'], ['31-60 Days', b60, 'yellow'], ['61-90 Days', b90, 'orange'], ['90+ Days (Critical)', b90p, 'red']].map(([label, val, color]) => (
              <div key={label} className={`bg-white rounded-xl border p-3 border-${color}-200`}>
                <div className={`text-xs font-semibold text-${color}-600 mb-1`}>{label}</div>
                <div className={`text-lg font-bold text-${color}-700`}>{formatCurrency(val)}</div>
                <div className="text-xs text-slate-400">{total > 0 ? ((val/total)*100).toFixed(0) : 0}% of total</div>
              </div>
            ))}
          </div>
        );
      })()}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b font-semibold bg-slate-50 flex justify-between">
            <span>Preview</span>
            {selectedProject && ['project_ops', 'project_expenses', 'project_pnl'].includes(reportType) && (
                <span className="text-sm font-normal text-slate-500">
                    {selectedProject.venue} • {selectedProject.start_date}
                </span>
            )}
        </div>
        <div className="overflow-x-auto min-h-[480px] max-h-[75vh]">
            <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-500">
                   <tr>{reportData.length > 0 && Object.keys(reportData[0]).filter(k => !k.startsWith('_')).map(h => <th key={h} className="p-3 whitespace-nowrap">{h}</th>)}{reportType === 'aging_report' && reportData.some(r => r._phone) && <th className="p-3 whitespace-nowrap">Action</th>}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                   {reportData.map((row, idx) => (
                      <tr key={idx} className={`hover:bg-slate-50 ${row._isTotal ? 'bg-slate-100 font-bold' : ''}`}>
                          {Object.keys(row).filter(k => !k.startsWith('_')).map(key => (
                              <td key={key} className={`p-3 whitespace-nowrap ${typeof row[key] === 'number' ? 'text-right' : ''}`}>
                                 {typeof row[key] === 'number' ? formatCurrency(row[key]) : row[key]}
                              </td>
                          ))}
                          {reportType === 'aging_report' && row._phone && (
                            <td className="p-3 whitespace-nowrap">
                              {(() => {
                                const phone = row._phone.replace(/\D/g, '');
                                const waPhone = phone.startsWith('91') ? phone : `91${phone}`;
                                const msg = `Dear ${row.Client},\n\nThis is a gentle reminder that you have an outstanding balance of ${formatCurrency(row['Total Outstanding'])} with us.\n\nKindly arrange the payment at your earliest convenience.\n\nThank you,\nRentalOps Team`;
                                return (
                                  <a href={`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs font-medium text-green-600 border border-green-200 rounded px-2 py-1 hover:bg-green-50 transition whitespace-nowrap">
                                    <MessageCircle size={12} /> Remind
                                  </a>
                                );
                              })()}
                            </td>
                          )}
                      </tr>
                   ))}
                </tbody>
            </table>
            {reportData.length === 0 && <div className="p-8 text-center text-slate-400">Select filters to view data.</div>}
        </div>
      </div>
    </div>
  );
};

export default Reports;
