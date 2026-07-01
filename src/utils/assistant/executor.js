// Executor for the global app assistant.
//
// Takes a parsed intent + a read-only data context (arrays already loaded by
// the subscribed listeners in App.jsx) and returns a Result object the UI
// renders. No Firestore I/O lives here — write actions are returned as
// `pendingAction` descriptors the UI executes after user confirmation and
// RBAC checks.

import { getProjectGrandTotal, getEffectivePOCost } from '../helpers';

// Fallback to stored totals when items/logistics are not present in memory
// (e.g. legacy or import-sourced projects). getProjectGrandTotal does the
// full computation when items are there.
const projectTotal = (p) => {
  const computed = getProjectGrandTotal(p);
  if (computed > 0) return computed;
  return Number(p?.total || p?.grand_total || 0);
};
//
// Result shape:
//   {
//     type: 'list' | 'table' | 'metric' | 'text' | 'action' | 'error' | 'help',
//     title: string,
//     subtitle?: string,
//     rows?: Array<object>,           // list/table
//     columns?: Array<{key,label}>,   // table
//     value?: string | number,        // metric
//     hint?: string,
//     pendingAction?: {               // for write intents
//       kind: 'approve_expenses',
//       employeeId, items: [{id, amount, date, narration}]
//     }
//   }

const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return String(d); }
};
const fmtINR = (n) => {
  const v = Number(n) || 0;
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const isoToday = () => new Date().toISOString().slice(0, 10);
const dayKey = (d) => (d ? String(d).slice(0, 10) : '');

function inRange(today, start, end) {
  if (!start || !end) return false;
  return today >= start && today <= end;
}

// Generic helper: filter rows by a date field against a {start,end} range.
function applyDateFilter(rows, dateRange, dateField = 'date') {
  if (!dateRange || !dateRange.start) return rows || [];
  const { start, end } = dateRange;
  return (rows || []).filter((r) => {
    const v = dayKey(r && r[dateField]);
    if (!v) return false;
    return v >= start && v <= end;
  });
}

function findProjectByName(projects, name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return (projects || []).find((p) => String(p.project_name || '').toLowerCase() === n)
    || (projects || []).find((p) => String(p.project_name || '').toLowerCase().includes(n));
}

function findClient(clients, name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return (clients || []).find((c) => String(c.name || '').toLowerCase() === n)
    || (clients || []).find((c) => String(c.name || '').toLowerCase().includes(n));
}
function findEmployee(employees, name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return (employees || []).find((e) => String(e.name || '').toLowerCase() === n)
    || (employees || []).find((e) => String(e.name || '').toLowerCase().includes(n));
}

// ── Projects ───────────────────────────────────────────────────────────────
function projectsToday(ctx) {
  const today = isoToday();
  const rows = (ctx.projects || []).filter((p) => {
    if (!['Confirmed', 'Ongoing'].includes(p.status)) return false;
    const start = dayKey(p.setup_date || p.start_date);
    const end = dayKey(p.end_date || p.wrap_date);
    return inRange(today, start, end);
  });
  return {
    type: 'list',
    title: `Projects executing today (${rows.length})`,
    subtitle: rows.length === 0 ? 'No projects are running today.' : '',
    rows: rows.map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'} · ${p.status}`,
      line3: `${fmtDate(p.setup_date || p.start_date)} → ${fmtDate(p.end_date || p.wrap_date)}`,
    })),
  };
}
function projectsByStatus(ctx, status) {
  const rows = (ctx.projects || []).filter((p) => String(p.status || '').toLowerCase() === String(status || '').toLowerCase());
  return {
    type: 'list',
    title: `${status} projects (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'}`,
      line3: `${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}`,
    })),
  };
}
function projectsByClient(ctx, clientName) {
  const client = findClient(ctx.clients, clientName);
  if (!client) return { type: 'error', title: 'Client not found', subtitle: `No match for "${clientName}".` };
  const rows = (ctx.projects || []).filter((p) => p.client_id === client.id || p.client_name === client.name);
  return {
    type: 'list',
    title: `Projects of ${client.name} (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.status} · ${fmtINR(p.total || p.grand_total || 0)}`,
      line3: `${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}`,
    })),
  };
}
function projectsUpcoming(ctx) {
  const today = isoToday();
  const rows = (ctx.projects || [])
    .filter((p) => ['Quoted', 'Confirmed'].includes(p.status))
    .filter((p) => {
      const start = dayKey(p.setup_date || p.start_date);
      return start && start > today;
    })
    .sort((a, b) => dayKey(a.setup_date || a.start_date).localeCompare(dayKey(b.setup_date || b.start_date)));
  return {
    type: 'list',
    title: `Upcoming projects (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'} · ${p.status}`,
      line3: `Starts ${fmtDate(p.setup_date || p.start_date)}`,
    })),
  };
}
function projectsThisWeek(ctx) {
  const today = isoToday();
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const endIso = weekEnd.toISOString().slice(0, 10);
  const rows = (ctx.projects || []).filter((p) => {
    const start = dayKey(p.setup_date || p.start_date);
    const end = dayKey(p.end_date || p.wrap_date);
    return (start && start >= today && start <= endIso)
        || (start && end && start <= today && end >= today);
  });
  return {
    type: 'list',
    title: `Projects this week (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'} · ${p.status}`,
      line3: `${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}`,
    })),
  };
}
function projectsOverdue(ctx) {
  const today = isoToday();
  const rows = (ctx.projects || []).filter((p) => ['Confirmed', 'Ongoing'].includes(p.status) && dayKey(p.end_date) && dayKey(p.end_date) < today);
  return {
    type: 'list',
    title: `Overdue projects (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'} · ended ${fmtDate(p.end_date)}`,
      line3: `Status: ${p.status}`,
    })),
  };
}
function projectsUnbilled(ctx) {
  const rows = (ctx.projects || []).filter((p) => p.status === 'Completed' && p.invoice_status !== 'Invoiced');
  return {
    type: 'list',
    title: `Completed projects awaiting invoice (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'}`,
      line3: `Value: ${fmtINR(p.total || p.grand_total || 0)}`,
    })),
  };
}

// ── Profitability (BI) ──────────────────────────────────────────────────────
function projectMarginRows(ctx) {
  const exp = ctx.expenses || [];
  return (ctx.projects || [])
    .filter((p) => ['Completed', 'Closed'].includes(p.status))
    .map((p) => {
      const revenue = projectTotal(p);
      let cost = 0;
      if (p.logistics_costs) Object.values(p.logistics_costs).forEach((c) => { cost += (c.amount || 0) * (1 + (c.gst || 0) / 100); });
      cost += (p.reimbursable_expenses || []).reduce((s, e) => s + (e.amount || 0), 0);
      cost += exp.filter((e) => e.project_id === p.id && e.status !== 'Rejected' && e.status !== 'Disapproved').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      cost += (p.purchase_orders || []).filter((po) => po.status !== 'Cancelled').reduce((a, po) => a + getEffectivePOCost(po).total, 0);
      cost += (p.vendor_allocations || []).filter((a) => !a.po_id).reduce((a, v) => a + (parseFloat(v.tax_amount) || 0), 0);
      const margin = revenue - cost;
      return { p, revenue, cost, margin, pct: revenue > 0 ? (margin / revenue) * 100 : 0 };
    });
}

function projectsByMargin(ctx, dir) {
  let rows = projectMarginRows(ctx);
  if (dir === 'loss') rows = rows.filter((r) => r.margin < 0);
  rows.sort((a, b) => (dir === 'bottom' || dir === 'loss' ? a.margin - b.margin : b.margin - a.margin));
  rows = rows.slice(0, 15);
  if (!rows.length) return { type: 'text', title: dir === 'loss' ? 'No loss-making projects 🎉' : 'No delivered projects found', subtitle: 'Profitability uses Completed/Closed projects.' };
  return {
    type: 'table',
    title: dir === 'loss' ? `Loss-making projects (${rows.length})` : dir === 'bottom' ? 'Least profitable projects' : 'Most profitable projects',
    columns: [{ key: 'name', label: 'Project' }, { key: 'revenue', label: 'Revenue' }, { key: 'margin', label: 'Margin' }, { key: 'pct', label: 'Margin %' }],
    rows: rows.map((r) => ({ id: r.p.id, name: r.p.project_name || '—', revenue: fmtINR(r.revenue), margin: fmtINR(r.margin), pct: `${r.pct.toFixed(0)}%` })),
  };
}

function clientsTop(ctx) {
  const cm = {};
  (ctx.projects || []).filter((p) => ['Completed', 'Closed'].includes(p.status)).forEach((p) => {
    const cid = p.client_id || '?'; cm[cid] = (cm[cid] || 0) + projectTotal(p);
  });
  const rows = Object.entries(cm)
    .map(([cid, rev]) => ({ name: (ctx.clients || []).find((c) => c.id === cid)?.name || '—', rev }))
    .sort((a, b) => b.rev - a.rev).slice(0, 10);
  if (!rows.length) return { type: 'text', title: 'No client revenue yet', subtitle: 'Based on delivered projects.' };
  return {
    type: 'table',
    title: 'Top clients by revenue',
    columns: [{ key: 'name', label: 'Client' }, { key: 'rev', label: 'Revenue' }],
    rows: rows.map((r) => ({ name: r.name, rev: fmtINR(r.rev) })),
  };
}

// ── Clients ────────────────────────────────────────────────────────────────
function clientLedger(ctx, clientName) {
  const client = findClient(ctx.clients, clientName);
  if (!client) return { type: 'error', title: 'Client not found', subtitle: `No match for "${clientName}".` };

  // Tax invoices collection (formal invoice docs).
  const taxInvoices = (ctx.taxInvoices || []).filter((i) => i.client_id === client.id);
  const taxInvoiceProjectIds = new Set();
  taxInvoices.forEach((i) => (i.project_ids || []).forEach((pid) => taxInvoiceProjectIds.add(pid)));

  // Project-level invoiced rows (legacy / project-marked-as-invoiced) — only
  // include projects that aren't already represented by a tax_invoices row,
  // so we never double-count.
  const invoicedProjects = (ctx.projects || []).filter((p) => (
    p.client_id === client.id
    && ['Completed', 'Closed'].includes(p.status)
    && p.invoice_status === 'Invoiced'
    && !taxInvoiceProjectIds.has(p.id)
  ));

  // Unbilled = completed/closed but not invoiced anywhere.
  const unbilled = (ctx.projects || []).filter((p) => (
    p.client_id === client.id
    && ['Completed', 'Closed'].includes(p.status)
    && p.invoice_status !== 'Invoiced'
    && !taxInvoiceProjectIds.has(p.id)
  ));

  const taxInvoiceTotal = taxInvoices.reduce((s, i) => s + (Number(i.final_amount) || 0), 0);
  const projectInvoiceTotal = invoicedProjects.reduce((s, p) => s + projectTotal(p), 0);
  const invoicedTotal = taxInvoiceTotal + projectInvoiceTotal;
  const unbilledTotal = unbilled.reduce((s, p) => s + projectTotal(p), 0);

  const payments = (ctx.payments || []).filter((p) => p.client_id === client.id);
  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const rows = [
    ...taxInvoices.map((i) => ({
      date: i.invoice_date,
      ref: i.invoice_no || '—',
      type: `Invoice · ${i.invoice_no || ''}`.trim(),
      amount: +Number(i.final_amount || 0),
      balance: 0,
    })),
    ...invoicedProjects.map((p) => ({
      date: p.invoice_date || p.end_date,
      ref: p.invoice_no || '—',
      type: `Invoice ${p.invoice_no || ''} · ${p.project_name || '—'}`.trim(),
      amount: +projectTotal(p),
      balance: 0,
    })),
    ...unbilled.map((p) => ({
      date: p.end_date,
      ref: 'Unbilled',
      type: `Unbilled · ${p.project_name || '—'}`,
      amount: +projectTotal(p),
      balance: 0,
    })),
    ...payments.map((p) => ({
      date: p.date,
      ref: p.mode || 'Payment',
      type: 'Receipt',
      amount: -Number(p.amount || 0),
      balance: 0,
    })),
  ].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let bal = 0;
  rows.forEach((r) => { bal += r.amount; r.balance = bal; });
  const outstanding = invoicedTotal + unbilledTotal - paid;
  return {
    type: 'table',
    title: `Ledger — ${client.name}`,
    subtitle: `Invoiced ${fmtINR(invoicedTotal)} · Unbilled ${fmtINR(unbilledTotal)} · Received ${fmtINR(paid)} · Outstanding ${fmtINR(outstanding)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'ref', label: 'Ref' },
      { key: 'type', label: 'Type' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
      { key: 'balance', label: 'Balance', fmt: 'money' },
    ],
    rows: rows.map((r) => ({ ...r, date: fmtDate(r.date) })),
  };
}
function clientList(ctx) {
  const rows = (ctx.clients || []).filter((c) => String(c.type || 'Client').toLowerCase().includes('client'));
  return {
    type: 'list',
    title: `Clients (${rows.length})`,
    rows: rows.slice(0, 100).map((c) => ({
      id: c.id,
      line1: c.name || '—',
      line2: c.gstin || 'No GSTIN',
      line3: c.state || '',
    })),
  };
}
function clientOutstanding(ctx) {
  const agg = new Map();
  const taxInvoiceProjectIds = new Set();
  (ctx.taxInvoices || []).forEach((i) => {
    const key = i.client_id || i.client_name || 'unknown';
    const cur = agg.get(key) || { id: key, name: i.client_name || '—', invoiced: 0, unbilled: 0, received: 0 };
    cur.invoiced += Number(i.final_amount) || 0;
    agg.set(key, cur);
    (i.project_ids || []).forEach((pid) => taxInvoiceProjectIds.add(pid));
  });
  // Project-level invoiced (legacy) — only when not already in tax_invoices.
  (ctx.projects || []).forEach((p) => {
    if (!['Completed', 'Closed'].includes(p.status)) return;
    if (p.invoice_status !== 'Invoiced') return;
    if (taxInvoiceProjectIds.has(p.id)) return;
    const key = p.client_id || 'unknown';
    const cur = agg.get(key) || { id: key, name: p.client_name || '—', invoiced: 0, unbilled: 0, received: 0 };
    if (!cur.name || cur.name === '—') cur.name = p.client_name || cur.name;
    cur.invoiced += projectTotal(p);
    agg.set(key, cur);
  });
  // Rule: include unbilled (completed-not-invoiced) work so outstanding
  // receivables reflect what the client will owe once invoices are raised.
  (ctx.projects || []).forEach((p) => {
    if (!['Completed', 'Closed'].includes(p.status)) return;
    if (p.invoice_status === 'Invoiced') return;
    if (taxInvoiceProjectIds.has(p.id)) return;
    const key = p.client_id || 'unknown';
    const cur = agg.get(key) || { id: key, name: p.client_name || '—', invoiced: 0, unbilled: 0, received: 0 };
    if (!cur.name || cur.name === '—') cur.name = p.client_name || cur.name;
    cur.unbilled += projectTotal(p);
    agg.set(key, cur);
  });
  (ctx.payments || []).forEach((p) => {
    const key = p.client_id || 'unknown';
    const cur = agg.get(key);
    if (cur) cur.received += Number(p.amount) || 0;
  });
  const rows = Array.from(agg.values())
    .map((r) => ({ ...r, outstanding: r.invoiced + r.unbilled - r.received }))
    .filter((r) => r.outstanding > 0.01)
    .sort((a, b) => b.outstanding - a.outstanding);
  const total = rows.reduce((s, r) => s + r.outstanding, 0);
  return {
    type: 'table',
    title: `Outstanding receivables (${rows.length})`,
    subtitle: `Total due: ${fmtINR(total)} (incl. unbilled work)`,
    columns: [
      { key: 'name', label: 'Client' },
      { key: 'invoiced', label: 'Invoiced', fmt: 'money' },
      { key: 'unbilled', label: 'Unbilled', fmt: 'money' },
      { key: 'received', label: 'Received', fmt: 'money' },
      { key: 'outstanding', label: 'Outstanding', fmt: 'money' },
    ],
    rows,
  };
}

// ── Employees ──────────────────────────────────────────────────────────────
function employeeBalance(ctx, employeeName) {
  const emp = findEmployee(ctx.employees, employeeName);
  if (!emp) return { type: 'error', title: 'Employee not found', subtitle: `No match for "${employeeName}".` };
  const expenses = (ctx.expenses || []).filter((e) => e.employee_id === emp.id && e.status === 'Approved');
  const expenseTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const payouts = (ctx.payouts || []).filter((p) => p.employee_id === emp.id);
  const payoutTotal = payouts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const opening = Number(emp.opening_balance || 0);
  const balance = opening + expenseTotal - payoutTotal; // positive = company owes employee
  return {
    type: 'metric',
    title: `Balance — ${emp.name}`,
    value: fmtINR(balance),
    subtitle: `Approved expenses ${fmtINR(expenseTotal)} · Payouts ${fmtINR(payoutTotal)} · Opening ${fmtINR(opening)}`,
    hint: balance > 0 ? 'Company owes employee.' : balance < 0 ? 'Employee owes company.' : 'Settled.',
  };
}
function employeeProjects(ctx, employeeName) {
  const emp = findEmployee(ctx.employees, employeeName);
  if (!emp) return { type: 'error', title: 'Employee not found', subtitle: `No match for "${employeeName}".` };
  const rows = (ctx.projects || []).filter((p) => {
    const a = p.assigned_employees || [];
    return a.some((e) => (e && typeof e === 'object' ? e.id === emp.id : e === emp.id));
  });
  return {
    type: 'list',
    title: `Projects assigned to ${emp.name} (${rows.length})`,
    rows: rows.slice(0, 50).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'} · ${p.status}`,
      line3: `${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}`,
    })),
  };
}
function employeeList(ctx) {
  const rows = (ctx.employees || []).filter((e) => e.status !== 'Deactivated' && e.status !== 'Disabled');
  return {
    type: 'list',
    title: `Team (${rows.length})`,
    rows: rows.slice(0, 100).map((e) => ({
      id: e.id,
      line1: e.name || '—',
      line2: `${e.role || '—'}${e.email ? ' · ' + e.email : ''}`,
      line3: e.status || '',
    })),
  };
}

// ── Expenses ───────────────────────────────────────────────────────────────
function expensesPending(ctx) {
  const rows = (ctx.expenses || []).filter((e) => e.status === 'Pending');
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const byEmp = new Map();
  rows.forEach((e) => {
    const k = e.employee_id || '—';
    byEmp.set(k, (byEmp.get(k) || 0) + (Number(e.amount) || 0));
  });
  return {
    type: 'table',
    title: `Expenses pending approval (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'employee', label: 'Employee' },
      { key: 'category', label: 'Category' },
      { key: 'narration', label: 'Narration' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows.slice(0, 100).map((e) => {
      const emp = (ctx.employees || []).find((x) => x.id === e.employee_id);
      return {
        id: e.id,
        date: fmtDate(e.date),
        employee: emp ? emp.name : '—',
        category: e.category || '—',
        narration: e.narration || '',
        amount: Number(e.amount) || 0,
      };
    }),
  };
}
function expensesByEmployee(ctx, employeeName) {
  const emp = findEmployee(ctx.employees, employeeName);
  if (!emp) return { type: 'error', title: 'Employee not found', subtitle: `No match for "${employeeName}".` };
  const rows = (ctx.expenses || []).filter((e) => e.employee_id === emp.id);
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    type: 'table',
    title: `Expenses — ${emp.name} (${rows.length})`,
    subtitle: `Total claimed: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'category', label: 'Category' },
      { key: 'narration', label: 'Narration' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows.slice(0, 100).map((e) => ({
      id: e.id,
      date: fmtDate(e.date),
      category: e.category || '—',
      narration: e.narration || '',
      status: e.status || 'Pending',
      amount: Number(e.amount) || 0,
    })),
  };
}
function expensesApprove(ctx, employeeName) {
  const emp = findEmployee(ctx.employees, employeeName);
  if (!emp) return { type: 'error', title: 'Employee not found', subtitle: `No match for "${employeeName}".` };
  const pending = (ctx.expenses || []).filter((e) => e.employee_id === emp.id && e.status === 'Pending');
  if (pending.length === 0) {
    return { type: 'text', title: `No pending expenses for ${emp.name}` };
  }
  const total = pending.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    type: 'action',
    title: `Approve ${pending.length} expense(s) of ${emp.name}`,
    subtitle: `Total: ${fmtINR(total)}`,
    pendingAction: {
      kind: 'approve_expenses',
      employeeId: emp.id,
      employeeName: emp.name,
      items: pending.map((e) => ({ id: e.id, date: e.date, amount: Number(e.amount) || 0, narration: e.narration || '', category: e.category || '' })),
    },
  };
}

// ── Payments ───────────────────────────────────────────────────────────────
function paymentsPending(ctx) {
  return clientOutstanding(ctx); // same view
}
function vendorPayments(ctx) {
  const agg = new Map();
  (ctx.purchaseInvoices || []).forEach((i) => {
    if (i.include_in_ledger === false) return;
    const key = i.vendor_id || 'unknown';
    const cur = agg.get(key) || { id: key, name: '—', billed: 0, paid: 0 };
    const vendor = (ctx.clients || []).find((c) => c.id === i.vendor_id);
    if (vendor) cur.name = vendor.name;
    cur.billed += (Number(i.amount) || 0) + (Number(i.gst_amount) || 0);
    agg.set(key, cur);
  });
  (ctx.vendorPayments || []).forEach((p) => {
    const key = p.vendor_id || 'unknown';
    const cur = agg.get(key);
    if (cur) cur.paid += Number(p.amount) || 0;
  });
  const rows = Array.from(agg.values())
    .map((r) => ({ ...r, due: r.billed - r.paid }))
    .filter((r) => r.due > 0.01)
    .sort((a, b) => b.due - a.due);
  const total = rows.reduce((s, r) => s + r.due, 0);
  return {
    type: 'table',
    title: `Vendor dues (${rows.length})`,
    subtitle: `Total payable: ${fmtINR(total)}`,
    columns: [
      { key: 'name', label: 'Vendor' },
      { key: 'billed', label: 'Billed', fmt: 'money' },
      { key: 'paid', label: 'Paid', fmt: 'money' },
      { key: 'due', label: 'Due', fmt: 'money' },
    ],
    rows,
  };
}

// ── Inventory ──────────────────────────────────────────────────────────────
function inventoryLow(ctx) {
  const rows = (ctx.inventory || [])
    .filter((i) => Number(i.qty || 0) <= Number(i.reorder_level || 0))
    .sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0));
  return {
    type: 'list',
    title: `Low / out of stock (${rows.length})`,
    rows: rows.slice(0, 100).map((i) => ({
      id: i.id,
      line1: i.name || '—',
      line2: `Qty ${i.qty || 0} · reorder ≤ ${i.reorder_level || 0}`,
      line3: i.category || '',
    })),
  };
}
function inventorySearch(ctx, itemName) {
  const n = (itemName || '').toLowerCase();
  const rows = (ctx.inventory || []).filter((i) => String(i.name || '').toLowerCase().includes(n));
  return {
    type: 'list',
    title: `Inventory matching "${itemName}" (${rows.length})`,
    rows: rows.slice(0, 30).map((i) => ({
      id: i.id,
      line1: i.name || '—',
      line2: `Qty ${i.qty || 0}${ctx.canViewInventoryRates ? ` · ${fmtINR(i.rate_per_day || 0)}/day` : ''}`,
      line3: i.category || '',
    })),
  };
}

// ── Reports ────────────────────────────────────────────────────────────────
function reportRevenue(ctx) {
  const rev = (ctx.taxInvoices || []).reduce((s, i) => s + (Number(i.final_amount) || 0), 0);
  return {
    type: 'metric',
    title: 'Total invoiced revenue',
    value: fmtINR(rev),
    subtitle: `${(ctx.taxInvoices || []).length} invoices`,
  };
}
function reportExpenses(ctx) {
  const total = (ctx.expenses || []).filter((e) => e.status === 'Approved').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const vendor = (ctx.purchaseInvoices || []).reduce((s, i) => s + (Number(i.amount) || 0) + (Number(i.gst_amount) || 0), 0);
  return {
    type: 'metric',
    title: 'Total expenses',
    value: fmtINR(total + vendor),
    subtitle: `Employee claims ${fmtINR(total)} · Vendor bills ${fmtINR(vendor)}`,
  };
}
function reportPL(ctx) {
  const rev = (ctx.taxInvoices || []).reduce((s, i) => s + (Number(i.final_amount) || 0), 0);
  const empExp = (ctx.expenses || []).filter((e) => e.status === 'Approved').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const vendor = (ctx.purchaseInvoices || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const profit = rev - empExp - vendor;
  return {
    type: 'metric',
    title: profit >= 0 ? 'Net profit' : 'Net loss',
    value: fmtINR(Math.abs(profit)),
    subtitle: `Revenue ${fmtINR(rev)} − Expenses ${fmtINR(empExp + vendor)}`,
    hint: profit >= 0 ? 'In the black.' : 'Losses — review costs.',
  };
}
function reportCashPosition(ctx) {
  const inflow = (ctx.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const outflow = (ctx.payouts || []).reduce((s, p) => s + (Number(p.amount) || 0), 0)
                + (ctx.vendorPayments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return {
    type: 'metric',
    title: 'Cash position (net)',
    value: fmtINR(inflow - outflow),
    subtitle: `Inflow ${fmtINR(inflow)} · Outflow ${fmtINR(outflow)}`,
  };
}

// ── Date-range / drilldown extensions ─────────────────────────────────────
function projectsByDateRange(ctx, range) {
  if (!range) return { type: 'error', title: 'Specify a date range', subtitle: 'Try "projects between 1 jan and 31 jan" or "projects this month".' };
  const rows = (ctx.projects || []).filter((p) => {
    const start = dayKey(p.setup_date || p.start_date);
    const end = dayKey(p.end_date || p.wrap_date);
    if (!start) return false;
    // Overlap check between project window and requested range.
    const projEnd = end || start;
    return start <= range.end && projEnd >= range.start;
  });
  return {
    type: 'list',
    title: `Projects · ${range.label} (${rows.length})`,
    subtitle: `${range.start} → ${range.end}`,
    rows: rows.slice(0, 100).map((p) => ({
      id: p.id,
      line1: p.project_name || '—',
      line2: `${p.client_name || '—'} · ${p.status}`,
      line3: `${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}`,
    })),
  };
}

function projectsDetails(ctx, projectName) {
  const p = findProjectByName(ctx.projects, projectName);
  if (!p) return { type: 'error', title: 'Project not found', subtitle: `No match for "${projectName}".` };
  const total = projectTotal(p);
  const team = (p.assigned_employees || []).map((e) => {
    if (e && typeof e === 'object') return e.name || e.id;
    const emp = (ctx.employees || []).find((x) => x.id === e);
    return emp ? emp.name : e;
  });
  const expenses = (ctx.expenses || []).filter((x) => x.project_id === p.id);
  const expenseTotal = expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const lines = [
    { label: 'Client', value: p.client_name || '—' },
    { label: 'Status', value: p.status || '—' },
    { label: 'Window', value: `${fmtDate(p.setup_date || p.start_date)} → ${fmtDate(p.end_date || p.wrap_date)}` },
    { label: 'Value', value: fmtINR(total) },
    { label: 'Team', value: team.length ? team.join(', ') : '—' },
    { label: 'Items', value: String((p.items || []).length) },
    { label: 'Expenses booked', value: `${expenses.length} · ${fmtINR(expenseTotal)}` },
    { label: 'Invoice', value: p.invoice_status === 'Invoiced' ? `Invoiced ${p.invoice_no || ''} · ${fmtDate(p.invoice_date)}` : (p.status === 'Completed' ? 'Unbilled' : '—') },
  ];
  return {
    type: 'detail',
    title: p.project_name || 'Project',
    subtitle: `${p.client_name || '—'} · ${p.status || ''}`,
    rows: lines,
    id: p.id,
  };
}

// ── Expenses extensions ───────────────────────────────────────────────────
function expensesByDateRange(ctx, range) {
  if (!range) return { type: 'error', title: 'Specify a date range', subtitle: 'Try "expenses this month".' };
  const rows = applyDateFilter(ctx.expenses || [], range, 'date');
  const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return {
    type: 'table',
    title: `Expenses · ${range.label} (${rows.length})`,
    subtitle: `Total claimed: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'employee', label: 'Employee' },
      { key: 'category', label: 'Category' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows.slice(0, 200).map((e) => {
      const emp = (ctx.employees || []).find((x) => x.id === e.employee_id);
      return {
        id: e.id,
        date: fmtDate(e.date),
        employee: emp ? emp.name : '—',
        category: e.category || '—',
        status: e.status || 'Pending',
        amount: Number(e.amount) || 0,
      };
    }),
  };
}

function expensesByCategory(ctx, category, range) {
  if (!category) return { type: 'error', title: 'Specify a category' };
  const cat = String(category).toLowerCase();
  let rows = (ctx.expenses || []).filter((e) => String(e.category || '').toLowerCase() === cat);
  if (range) rows = applyDateFilter(rows, range, 'date');
  const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return {
    type: 'table',
    title: `${category} expenses${range ? ` · ${range.label}` : ''} (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'employee', label: 'Employee' },
      { key: 'narration', label: 'Narration' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows.slice(0, 200).map((e) => {
      const emp = (ctx.employees || []).find((x) => x.id === e.employee_id);
      return {
        id: e.id,
        date: fmtDate(e.date),
        employee: emp ? emp.name : '—',
        narration: e.narration || '',
        status: e.status || 'Pending',
        amount: Number(e.amount) || 0,
      };
    }),
  };
}

function expensesByStatus(ctx, status) {
  if (!status) return { type: 'error', title: 'Specify a status (Pending / Approved / Rejected)' };
  const rows = (ctx.expenses || []).filter((e) => String(e.status || '').toLowerCase() === String(status).toLowerCase());
  const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return {
    type: 'table',
    title: `${status} expenses (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'employee', label: 'Employee' },
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows.slice(0, 200).map((e) => {
      const emp = (ctx.employees || []).find((x) => x.id === e.employee_id);
      return {
        id: e.id,
        date: fmtDate(e.date),
        employee: emp ? emp.name : '—',
        category: e.category || '—',
        amount: Number(e.amount) || 0,
      };
    }),
  };
}

function expensesStatistics(ctx, range) {
  let rows = ctx.expenses || [];
  if (range) rows = applyDateFilter(rows, range, 'date');
  const byStatus = { Pending: 0, Approved: 0, Rejected: 0 };
  const byCategory = new Map();
  rows.forEach((e) => {
    const a = Number(e.amount) || 0;
    const st = e.status || 'Pending';
    byStatus[st] = (byStatus[st] || 0) + a;
    const c = e.category || 'Uncategorised';
    byCategory.set(c, (byCategory.get(c) || 0) + a);
  });
  const catRows = Array.from(byCategory.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  return {
    type: 'table',
    title: `Expense breakdown${range ? ` · ${range.label}` : ''}`,
    subtitle: `Pending ${fmtINR(byStatus.Pending || 0)} · Approved ${fmtINR(byStatus.Approved || 0)} · Rejected ${fmtINR(byStatus.Rejected || 0)}`,
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: catRows,
  };
}

// ── Finance / payments / invoices ─────────────────────────────────────────
function paymentsByDate(ctx, range) {
  if (!range) return { type: 'error', title: 'Specify a date range', subtitle: 'Try "payments received last week".' };
  const rows = applyDateFilter(ctx.payments || [], range, 'date');
  const total = rows.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return {
    type: 'table',
    title: `Payments received · ${range.label} (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'client', label: 'Client' },
      { key: 'mode', label: 'Mode' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows.slice(0, 200).map((p) => {
      const c = (ctx.clients || []).find((x) => x.id === p.client_id);
      return { id: p.id, date: fmtDate(p.date), client: c ? c.name : (p.client_name || '—'), mode: p.mode || '—', amount: Number(p.amount) || 0 };
    }),
  };
}

function taxInvoicesList(ctx, range) {
  let rows = ctx.taxInvoices || [];
  if (range) rows = applyDateFilter(rows, range, 'invoice_date');
  const total = rows.reduce((s, i) => s + (Number(i.final_amount) || 0), 0);
  return {
    type: 'table',
    title: `Tax invoices${range ? ` · ${range.label}` : ''} (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'invoice_no', label: 'Invoice #' },
      { key: 'client', label: 'Client' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows
      .slice()
      .sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')))
      .slice(0, 200)
      .map((i) => ({ id: i.id, date: fmtDate(i.invoice_date), invoice_no: i.invoice_no || '—', client: i.client_name || '—', amount: Number(i.final_amount) || 0 })),
  };
}

function taxInvoicesByClient(ctx, clientName, range) {
  const client = findClient(ctx.clients, clientName);
  if (!client) return { type: 'error', title: 'Client not found', subtitle: `No match for "${clientName}".` };
  let rows = (ctx.taxInvoices || []).filter((i) => i.client_id === client.id);
  if (range) rows = applyDateFilter(rows, range, 'invoice_date');
  const total = rows.reduce((s, i) => s + (Number(i.final_amount) || 0), 0);
  return {
    type: 'table',
    title: `Invoices · ${client.name}${range ? ` · ${range.label}` : ''} (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'invoice_no', label: 'Invoice #' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows
      .slice()
      .sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')))
      .slice(0, 200)
      .map((i) => ({ id: i.id, date: fmtDate(i.invoice_date), invoice_no: i.invoice_no || '—', amount: Number(i.final_amount) || 0 })),
  };
}

function purchaseInvoicesList(ctx, range) {
  let rows = ctx.purchaseInvoices || [];
  if (range) rows = applyDateFilter(rows, range, 'invoice_date');
  const total = rows.reduce((s, i) => s + (Number(i.amount) || 0) + (Number(i.gst_amount) || 0), 0);
  return {
    type: 'table',
    title: `Purchase invoices${range ? ` · ${range.label}` : ''} (${rows.length})`,
    subtitle: `Total billed: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'invoice_no', label: 'Bill #' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows
      .slice()
      .sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')))
      .slice(0, 200)
      .map((i) => {
        const v = (ctx.clients || []).find((x) => x.id === i.vendor_id);
        return {
          id: i.id,
          date: fmtDate(i.invoice_date),
          invoice_no: i.invoice_no || '—',
          vendor: v ? v.name : (i.vendor_name || '—'),
          amount: (Number(i.amount) || 0) + (Number(i.gst_amount) || 0),
        };
      }),
  };
}

function purchaseInvoicesByVendor(ctx, vendorName, range) {
  const vendor = findClient(ctx.clients, vendorName);
  if (!vendor) return { type: 'error', title: 'Vendor not found', subtitle: `No match for "${vendorName}".` };
  let rows = (ctx.purchaseInvoices || []).filter((i) => i.vendor_id === vendor.id);
  if (range) rows = applyDateFilter(rows, range, 'invoice_date');
  const total = rows.reduce((s, i) => s + (Number(i.amount) || 0) + (Number(i.gst_amount) || 0), 0);
  return {
    type: 'table',
    title: `Bills from ${vendor.name}${range ? ` · ${range.label}` : ''} (${rows.length})`,
    subtitle: `Total: ${fmtINR(total)}`,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'invoice_no', label: 'Bill #' },
      { key: 'amount', label: 'Amount', fmt: 'money' },
    ],
    rows: rows
      .slice()
      .sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')))
      .slice(0, 200)
      .map((i) => ({
        id: i.id,
        date: fmtDate(i.invoice_date),
        invoice_no: i.invoice_no || '—',
        amount: (Number(i.amount) || 0) + (Number(i.gst_amount) || 0),
      })),
  };
}

// ── Inventory extension ───────────────────────────────────────────────────
function inventoryByCategory(ctx, category) {
  const cat = String(category || '').toLowerCase();
  const rows = (ctx.inventory || []).filter((i) => String(i.category || '').toLowerCase().includes(cat));
  return {
    type: 'list',
    title: `${category} inventory (${rows.length})`,
    rows: rows.slice(0, 200).map((i) => ({
      id: i.id,
      line1: i.name || '—',
      line2: `Qty ${i.qty || 0}${ctx.canViewInventoryRates ? ` · ${fmtINR(i.rate_per_day || 0)}/day` : ''}`,
      line3: i.category || '',
    })),
  };
}

// ── Personal digest ───────────────────────────────────────────────────────
function digestMyPending(ctx) {
  const pendingExpenses = (ctx.expenses || []).filter((e) => e.status === 'Pending');
  const expenseTotal = pendingExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const unbilled = (ctx.projects || []).filter((p) => p.status === 'Completed' && p.invoice_status !== 'Invoiced');
  const unbilledTotal = unbilled.reduce((s, p) => s + projectTotal(p), 0);
  const overdue = (() => {
    const today = isoToday();
    return (ctx.projects || []).filter((p) => ['Confirmed', 'Ongoing'].includes(p.status) && dayKey(p.end_date) && dayKey(p.end_date) < today);
  })();
  const lowStock = (ctx.inventory || []).filter((i) => Number(i.qty || 0) <= Number(i.reorder_level || 0));
  return {
    type: 'list',
    title: 'Pending items',
    subtitle: `${pendingExpenses.length} expenses · ${unbilled.length} unbilled · ${overdue.length} overdue · ${lowStock.length} low stock`,
    rows: [
      { id: 'expenses', line1: `Expenses awaiting approval: ${pendingExpenses.length}`, line2: fmtINR(expenseTotal) },
      { id: 'unbilled', line1: `Completed projects to invoice: ${unbilled.length}`, line2: fmtINR(unbilledTotal) },
      { id: 'overdue', line1: `Overdue projects: ${overdue.length}`, line2: overdue.length ? overdue.slice(0, 3).map((p) => p.project_name).join(', ') : '—' },
      { id: 'low-stock', line1: `Low / out of stock: ${lowStock.length}`, line2: lowStock.length ? lowStock.slice(0, 3).map((i) => i.name).join(', ') : '—' },
    ],
  };
}

// ── Write actions (return pendingAction descriptors only) ─────────────────
const PROJECT_TRANSITIONS = {
  'project.confirm':       { from: ['Quoted'],                 to: 'Confirmed', verb: 'confirm', perm: ['projects', 'edit'] },
  'project.markOngoing':   { from: ['Confirmed'],              to: 'Ongoing',   verb: 'start',   perm: ['projects', 'edit'] },
  'project.markCompleted': { from: ['Ongoing', 'Confirmed'],   to: 'Completed', verb: 'complete', perm: ['projects', 'edit'] },
  'project.markClosed':    { from: ['Completed'],              to: 'Closed',    verb: 'close',   perm: ['projects', 'close'] },
};

function projectTransition(ctx, projectName, intent) {
  const t = PROJECT_TRANSITIONS[intent];
  if (!t) return { type: 'error', title: 'Unknown transition' };
  const p = findProjectByName(ctx.projects, projectName);
  if (!p) return { type: 'error', title: 'Project not found', subtitle: `No match for "${projectName}".` };
  if (p.status === t.to) return { type: 'text', title: `${p.project_name} is already ${t.to}.` };
  if (!t.from.includes(p.status)) {
    return {
      type: 'error',
      title: `Cannot ${t.verb} from ${p.status}`,
      subtitle: `Allowed only when status is ${t.from.join(' / ')}.`,
    };
  }
  return {
    type: 'action',
    title: `${t.verb.charAt(0).toUpperCase() + t.verb.slice(1)} project: ${p.project_name}`,
    subtitle: `${p.client_name || '—'} · ${p.status} → ${t.to}`,
    pendingAction: {
      kind: 'project.transition',
      projectId: p.id,
      projectName: p.project_name,
      fromStatus: p.status,
      toStatus: t.to,
      perm: t.perm,
      verb: t.verb,
    },
  };
}

function expenseDisapprove(ctx, employeeName) {
  const emp = findEmployee(ctx.employees, employeeName);
  if (!emp) return { type: 'error', title: 'Employee not found', subtitle: `No match for "${employeeName}".` };
  const pending = (ctx.expenses || []).filter((e) => e.employee_id === emp.id && e.status === 'Pending');
  if (pending.length === 0) return { type: 'text', title: `No pending expenses for ${emp.name}` };
  const total = pending.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    type: 'action',
    title: `Reject ${pending.length} expense(s) of ${emp.name}`,
    subtitle: `Total: ${fmtINR(total)} · A reason is required.`,
    pendingAction: {
      kind: 'expense.disapprove',
      employeeId: emp.id,
      employeeName: emp.name,
      perm: ['expenses', 'approve'],
      requires: ['reason'],
      items: pending.map((e) => ({ id: e.id, date: e.date, amount: Number(e.amount) || 0, narration: e.narration || '', category: e.category || '' })),
    },
  };
}

function paymentRecord(ctx, clientName, dateRange) {
  const client = findClient(ctx.clients, clientName);
  if (!client) return { type: 'error', title: 'Client not found', subtitle: `No match for "${clientName}".` };
  // Suggest matching unpaid invoice when amount entered later (by UI).
  const openInvoices = (ctx.taxInvoices || []).filter((i) => i.client_id === client.id);
  const totalInvoiced = openInvoices.reduce((s, i) => s + (Number(i.final_amount) || 0), 0);
  const totalPaid = (ctx.payments || []).filter((p) => p.client_id === client.id).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const outstanding = Math.max(0, totalInvoiced - totalPaid);
  return {
    type: 'action',
    title: `Record payment from ${client.name}`,
    subtitle: `Outstanding: ${fmtINR(outstanding)} · Provide amount, mode and date.`,
    pendingAction: {
      kind: 'payment.record',
      clientId: client.id,
      clientName: client.name,
      perm: ['finance', 'create'],
      requires: ['amount', 'mode', 'date'],
      defaults: {
        date: (dateRange && dateRange.start) || isoToday(),
        mode: 'Bank Transfer',
      },
      suggestion: outstanding > 0 ? `Outstanding ${fmtINR(outstanding)}` : null,
    },
  };
}

function leaveAction(ctx, employeeName, action) {
  const emp = findEmployee(ctx.employees, employeeName);
  if (!emp) return { type: 'error', title: 'Employee not found', subtitle: `No match for "${employeeName}".` };
  const pending = (ctx.hrLeaves || []).filter((l) => l.employeeId === emp.id && l.status === 'Pending');
  if (pending.length === 0) return { type: 'text', title: `No pending leave requests for ${emp.name}` };
  const verb = action === 'leave.approve' ? 'Approve' : 'Reject';
  return {
    type: 'action',
    title: `${verb} ${pending.length} leave request(s) for ${emp.name}`,
    subtitle: pending.slice(0, 3).map((l) => `${l.type} · ${l.startDate} → ${l.endDate}`).join(' · '),
    pendingAction: {
      kind: action === 'leave.approve' ? 'leave.approve' : 'leave.reject',
      employeeId: emp.id,
      employeeName: emp.name,
      perm: ['hr_leaves', 'approve'],
      items: pending.map((l) => ({ id: l.id, type: l.type, startDate: l.startDate, endDate: l.endDate, reason: l.reason })),
    },
  };
}

// ── Help ───────────────────────────────────────────────────────────────────
function help() {
  return {
    type: 'help',
    title: 'What can I do?',
    rows: [
      { line1: "Show today's projects", line2: 'Running between setup and end date.' },
      { line1: 'Show projects of ACME Pvt Ltd', line2: 'All projects for a client.' },
      { line1: 'Show ledger of ACME Pvt Ltd', line2: 'Invoices, payments and running balance.' },
      { line1: 'Projects this week / upcoming / overdue', line2: 'Calendar-based views.' },
      { line1: 'Unbilled projects', line2: 'Completed but not yet invoiced.' },
      { line1: "What is the balance of Ramesh?", line2: 'Employee net dues.' },
      { line1: 'Projects of Ramesh', line2: 'Assignments for an employee.' },
      { line1: 'Pending expense approvals', line2: 'Queue of pending claims.' },
      { line1: 'Expenses of Ramesh', line2: 'All claim history for one employee.' },
      { line1: 'Approve expenses of Ramesh', line2: 'Admin/manager: approve all pending.' },
      { line1: 'Outstanding receivables', line2: 'Clients who owe money.' },
      { line1: 'Vendor payments due', line2: 'Who we owe.' },
      { line1: 'Low stock', line2: 'Inventory at or below reorder level.' },
      { line1: 'Revenue / Expenses / Profit & loss / Cash position', line2: 'Snapshot reports.' },
      { line1: 'Projects this month / between 1 jan and 31 jan', line2: 'Date-range filters work everywhere.' },
      { line1: 'Tax invoices last week', line2: 'List sales invoices in any date range.' },
      { line1: 'Purchase invoices this FY / Bills from <vendor>', line2: 'Vendor bills.' },
      { line1: 'Travel expenses last month', line2: 'Filter by category and range.' },
      { line1: 'Expense breakdown this month', line2: 'Totals by status and category.' },
      { line1: 'Payments received last 7 days', line2: 'Receipts in a date range.' },
      { line1: 'My pending', line2: 'Personal queue of pending items.' },
      { line1: 'Details of project <name>', line2: 'Drill down into a single project.' },
    ],
  };
}

/**
 * Execute a parsed intent against the in-memory context.
 * @param {object} parsed  Output of parseAssistantMessage.
 * @param {object} ctx     { projects, clients, employees, expenses, payments, payouts, vendorPayments, taxInvoices, purchaseInvoices, inventory }
 * @returns {object} Result
 */
export function executeAssistantIntent(parsed, ctx = {}) {
  if (!parsed || parsed.intent === 'unknown') {
    return { type: 'error', title: 'Not understood', subtitle: (parsed && parsed.issues && parsed.issues[0] && parsed.issues[0].message) || 'Type "help" for examples.' };
  }
  const blockingIssue = (parsed.issues || []).find((i) => i.level === 'error');
  if (blockingIssue) {
    return { type: 'error', title: 'Missing info', subtitle: blockingIssue.message };
  }
  const e = parsed.entities || {};
  switch (parsed.intent) {
    case 'projects.today': return projectsToday(ctx);
    case 'projects.thisWeek': return projectsThisWeek(ctx);
    case 'projects.upcoming': return projectsUpcoming(ctx);
    case 'projects.overdue': return projectsOverdue(ctx);
    case 'projects.unbilled': return projectsUnbilled(ctx);
    case 'projects.byStatus': return projectsByStatus(ctx, e.status);
    case 'projects.byClient': return projectsByClient(ctx, e.clientName);
    case 'projects.byDateRange': return projectsByDateRange(ctx, e.dateRange);
    case 'projects.details': return projectsDetails(ctx, e.projectName);
    case 'client.ledger': return clientLedger(ctx, e.clientName);
    case 'client.list': return clientList(ctx);
    case 'client.outstanding': return clientOutstanding(ctx);
    case 'employee.balance': return employeeBalance(ctx, e.employeeName);
    case 'employee.projects': return employeeProjects(ctx, e.employeeName);
    case 'employee.list': return employeeList(ctx);
    case 'expenses.pending': return expensesPending(ctx);
    case 'expenses.byEmployee': return expensesByEmployee(ctx, e.employeeName);
    case 'expenses.approve': return expensesApprove(ctx, e.employeeName);
    case 'expenses.byDateRange': return expensesByDateRange(ctx, e.dateRange);
    case 'expenses.byCategory': return expensesByCategory(ctx, e.category, e.dateRange);
    case 'expenses.byStatus': return expensesByStatus(ctx, e.status);
    case 'expenses.statistics': return expensesStatistics(ctx, e.dateRange);
    case 'payments.pending': return paymentsPending(ctx);
    case 'payments.byDate': return paymentsByDate(ctx, e.dateRange);
    case 'vendor.payments': return vendorPayments(ctx);
    case 'finance.payables': return vendorPayments(ctx);
    case 'finance.receivables': return clientOutstanding(ctx);
    case 'taxInvoices.list': return taxInvoicesList(ctx, e.dateRange);
    case 'taxInvoices.byClient': return taxInvoicesByClient(ctx, e.clientName, e.dateRange);
    case 'purchaseInvoices.list': return purchaseInvoicesList(ctx, e.dateRange);
    case 'purchaseInvoices.byVendor': return purchaseInvoicesByVendor(ctx, e.vendorName, e.dateRange);
    case 'inventory.low': return inventoryLow(ctx);
    case 'inventory.search': return inventorySearch(ctx, e.itemName);
    case 'inventory.byCategory': return inventoryByCategory(ctx, e.category);
    case 'projects.topMargin': return projectsByMargin(ctx, 'top');
    case 'projects.lossMaking': return projectsByMargin(ctx, 'loss');
    case 'projects.bottomMargin': return projectsByMargin(ctx, 'bottom');
    case 'clients.top': return clientsTop(ctx);
    case 'reports.pl': return reportPL(ctx);
    case 'reports.revenue': return reportRevenue(ctx);
    case 'reports.expenses': return reportExpenses(ctx);
    case 'reports.cashPosition': return reportCashPosition(ctx);
    case 'digest.myPending': return digestMyPending(ctx);
    case 'project.confirm':
    case 'project.markOngoing':
    case 'project.markCompleted':
    case 'project.markClosed':
      return projectTransition(ctx, e.projectName, parsed.intent);
    case 'expense.disapprove': return expenseDisapprove(ctx, e.employeeName);
    case 'payment.record': return paymentRecord(ctx, e.clientName, e.dateRange);
    case 'leave.approve': return leaveAction(ctx, e.employeeName, 'leave.approve');
    case 'leave.reject': return leaveAction(ctx, e.employeeName, 'leave.reject');
    case 'help': return help();
    default: return { type: 'error', title: 'Unknown intent', subtitle: parsed.intent };
  }
}

export default executeAssistantIntent;
