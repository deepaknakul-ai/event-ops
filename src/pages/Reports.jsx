import React, { useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area, ComposedChart
} from 'recharts';
import { FileText, Mail, MessageCircle, TrendingUp, AlertCircle } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { formatCurrency, getProjectGrandTotal, getProjectGST, getFinancialYear, getEffectivePOCost } from '../utils/helpers';
import { can } from '../utils/permissions';

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

const Reports = ({ projects, clients, employees, expenses, inventory, payments, payouts = [], advances = [], vendorPayments = [], role }) => {
  const [reportType, setReportType] = useState('ledger');
  const [filterId, setFilterId] = useState(''); // Client ID
  const [selectedProjId, setSelectedProjId] = useState(''); // Project ID
  const [isConsolidated, setIsConsolidated] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // --- Helper: Get Project Specific Data ---
  const selectedProject = projects.find(p => p.id === selectedProjId);

  // --- Data Preparation Logic ---
  const reportData = useMemo(() => {

    // --- 1. Client Ledger Report ---
    if (reportType === 'ledger') {
      if (!filterId) return [];

      const selectedClient = clients.find(c => c.id === filterId);
      const includeVendorLedger = selectedClient?.type === 'Both';

      const clientInvoices = projects
        .filter(p => p.client_id === filterId && ['Completed', 'Closed'].includes(p.status))
        .map(p => ({
          date: p.end_date,
          desc: `Invoice: ${p.project_name}`,
          debit: getProjectGrandTotal(p),
          credit: 0,
          type: 'invoice',
          invoice_status: p.invoice_status || 'Not Invoiced',
          invoice_no: p.invoice_no || '—',
          invoice_date: p.invoice_date || '—'
        }));

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
      if (includeVendorLedger) {
        projects.forEach(p => {
          if (p.purchase_orders) {
            p.purchase_orders.forEach(po => {
              if (po.vendor_id === filterId && po.status !== 'Cancelled') {
                const eff = getEffectivePOCost(po);
                const inv = po.vendor_invoice;
                vendorBills.push({
                  date: po.date,
                  desc: `Vendor Bill: ${po.po_no} (${p.project_name})${eff.source === 'invoice' ? ' [Invoice]' : ' [PO]'}`,
                  debit: 0,
                  credit: eff.total,
                  type: 'vendor_bill',
                  invoice_status: inv?.status || '',
                  invoice_no: inv?.invoice_no || '',
                  invoice_date: inv?.invoice_date || ''
                });
              }
            });
          }
        });
      }

      const vendorPaymentRows = includeVendorLedger
        ? vendorPayments.filter(p => p.vendor_id === filterId).map(p => ({
            date: p.date,
            desc: `Vendor Payment: ${p.mode} - ${p.reference}`,
            debit: parseFloat(p.amount || 0),
            credit: 0,
            type: 'vendor_payment',
            invoice_status: '', invoice_no: '', invoice_date: ''
          }))
        : [];

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

    // --- 8. Vendor Ledger Report (NEW) ---
    if (reportType === 'vendor_ledger') {
      if (!filterId) return [];

      // Get POs (Bills)
      const vendorBills = [];
      projects.forEach(p => {
          if(p.purchase_orders) {
              p.purchase_orders.forEach(po => {
                  if(po.vendor_id === filterId && po.status !== 'Cancelled') {
                      const eff = getEffectivePOCost(po);
                      vendorBills.push({
                          date: po.date,
                          desc: `${eff.source === 'invoice' ? 'Invoice' : 'PO'}: ${po.po_no} (${p.project_name})`,
                          credit: eff.total, // We owe this
                          debit: 0,
                          type: 'bill'
                      });
                  }
              });
          }
      });

      // Get Payments
      const vPayments = vendorPayments.filter(p => p.vendor_id === filterId).map(p => ({
          date: p.date, desc: `Payment: ${p.mode} - ${p.reference}`, credit: 0, debit: parseFloat(p.amount), type: 'payment'
      }));

      const combined = [...vendorBills, ...vPayments].sort((a,b) => new Date(a.date) - new Date(b.date));
      let balance = 0;
      return combined.map(row => { balance += (row.credit - row.debit); return { Date: row.date, Description: row.desc, 'Bill (Cr)': row.credit, 'Paid (Dr)': row.debit, Balance: balance }; });
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

      const payoutRows = empPayouts.map(p => ({
          date: p.date, desc: `Payout: ${p.mode} - ${p.reference || '-'}`, project: '-', debit: parseFloat(p.amount), credit: 0, type: 'payout'
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
          Description: row.desc,
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

    // --- 7. Client/Vendor Balance Report (UPDATED) ---
    if (reportType === 'client_balance') {
      return clients.map(c => {
          // Client Logic (Receivables)
          let clientInvoiced = 0;
          let clientReceived = 0;

          if (c.type === 'Client' || c.type === 'Both') {
             const clientProjects = projects.filter(p => p.client_id === c.id && ['Completed', 'Closed'].includes(p.status));
             clientInvoiced = clientProjects.reduce((sum, p) => sum + getProjectGrandTotal(p), 0);

             const clientPayments = payments.filter(p => p.client_id === c.id);
             clientReceived = clientPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
          }

          // Vendor Logic (Payables)
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

          const receivable = clientInvoiced - clientReceived;
          const payable = vendorBilled - vendorPaid;
          const netBalance = receivable - payable;

          return {
              Name: c.name,
              Type: c.type,
              'Client Inv': clientInvoiced,
              'Client Rec': clientReceived,
              'Vendor Bill': vendorBilled,
              'Vendor Paid': vendorPaid,
              'Net Balance': netBalance // Positive = We collect, Negative = We pay
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
            const gstRate = selectedProject.package_cost_gst || 18;
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
                   const base = c.amount || 0;
                   logisticsRevenue += base * (1 + (c.gst || 0)/100);
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

      // Output GST from completed/closed projects
      projects
        .filter(p => ['Completed', 'Closed'].includes(p.status))
        .forEach(p => {
          const date = new Date(p.end_date);
          if (s && date < s) return;
          if (e && date > e) return;
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          if (!monthlyData[key]) monthlyData[key] = { Month: key, 'Output GST': 0, 'Input GST (POs)': 0, 'Net GST Liability': 0, Projects: 0 };
          monthlyData[key]['Output GST'] += getProjectGST(p);
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
    if (reportType === 'aging_report') {
      const now = new Date();
      return clients
        .filter(c => c.type === 'Client' || c.type === 'Both')
        .map(c => {
          const clientProjects = projects.filter(p => p.client_id === c.id && ['Completed', 'Closed'].includes(p.status));
          const totalInvoiced = clientProjects.reduce((sum, p) => sum + getProjectGrandTotal(p), 0);
          const totalReceived = payments
            .filter(pay => pay.client_id === c.id)
            .reduce((sum, pay) => sum + parseFloat(pay.amount || 0), 0);
          const totalOutstanding = totalInvoiced - totalReceived;
          if (totalOutstanding <= 0.01) return null;

          let bucket30 = 0, bucket60 = 0, bucket90 = 0, bucket90plus = 0;
          let remaining = totalOutstanding;

          // Attribute outstanding to projects by date (oldest first gets the remainder)
          [...clientProjects]
            .sort((a, b) => new Date(a.end_date) - new Date(b.end_date))
            .forEach(p => {
              if (remaining <= 0) return;
              const daysOld = Math.floor((now - new Date(p.end_date)) / (1000 * 60 * 60 * 24));
              const pTotal = getProjectGrandTotal(p);
              const allocated = Math.min(pTotal, remaining);
              remaining -= allocated;
              if (daysOld <= 30) bucket30 += allocated;
              else if (daysOld <= 60) bucket60 += allocated;
              else if (daysOld <= 90) bucket90 += allocated;
              else bucket90plus += allocated;
            });

          return {
            Client: c.name,
            'Total Outstanding': totalOutstanding,
            '0-30 Days': bucket30,
            '31-60 Days': bucket60,
            '61-90 Days': bucket90,
            '90+ Days': bucket90plus,
            _phone: c.contacts?.[0]?.phone || '',
          };
        })
        .filter(Boolean)
        .sort((a, b) => b['Total Outstanding'] - a['Total Outstanding']);
    }

    return [];
  }, [reportType, filterId, selectedProjId, startDate, endDate, projects, clients, payments, expenses, employees]);

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
    } else if(reportType === 'employee_ledger') {
       const empName = employees.find(e => e.id === filterId)?.name;
       doc.text(`Employee: ${empName}`, 14, 34);
       if (isConsolidated) doc.text(`(Consolidated View)`, 14, 40);
    }

    if (reportData.length === 0) return alert("No data to export");

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
    if (reportData.length === 0) return alert("No data to export");
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
        alert("Report downloaded. Please attach the file to the email draft.");
    }, 500);
  };

  return (
    <div className="space-y-6 text-black">
      <h2 className="text-2xl font-bold text-slate-800">System Reports</h2>

      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="w-full md:w-auto">
            <label className="block text-sm font-medium text-slate-700 mb-1">Report Type</label>
            <select className="w-full rounded border p-2 min-w-[250px] text-black" value={reportType} onChange={(e) => { setReportType(e.target.value); setFilterId(''); setSelectedProjId(''); }}>
               <option value="ledger">Client Ledger (Statement)</option>
               <option value="client_balance">Client/Vendor Balance Summary</option>
               <option value="vendor_ledger">Vendor Ledger</option>
               <option value="employee_ledger">Employee Ledger</option>
               <option value="invoice_status">Invoiced / Non-Invoiced Projects</option>
               <option value="projects_summary">Revenue Summary (Date Range)</option>
               <option value="rejected_expenses">Rejected Expenses</option>
               <option value="clarification_expenses">Clarification Expenses</option>
               <option disabled>--- Project Specific ---</option>
               <option value="project_ops">Project Operations (Tech Sheet)</option>
               <option value="project_expenses">Project Expenses Detailed</option>
               <option value="project_pnl">Project Profit & Loss</option>
               <option disabled>--- Financial Analytics ---</option>
               <option value="gst_report">GST Report (Monthly Output vs Input)</option>
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

          {['projects_summary', 'employee_ledger', 'rejected_expenses', 'clarification_expenses', 'invoice_status', 'gst_report', 'pnl_timeline'].includes(reportType) && (
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
