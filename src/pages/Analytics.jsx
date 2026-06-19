import React, { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  PieChart, Pie, Cell, BarChart,
} from 'recharts';
import { LineChart as LineIcon, TrendingUp, Percent, IndianRupee } from 'lucide-react';
import { formatCurrency, getProjectGrandTotal, getEffectivePOCost } from '../utils/helpers';
import { can } from '../utils/permissions';

const isExcluded = (s) => s === 'Rejected' || s === 'Disapproved';
const PIE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16', '#64748b'];
const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
};

const Analytics = ({ projects = [], clients = [], expenses = [], payments = [], role = 'manager' }) => {
  const projectCost = (p) => {
    let logistics = 0;
    if (p.logistics_costs) Object.values(p.logistics_costs).forEach((c) => { logistics += (c.amount || 0) * (1 + (c.gst || 0) / 100); });
    const reimb = (p.reimbursable_expenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const exp = expenses.filter((e) => e.project_id === p.id && !isExcluded(e.status)).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const outPO = (p.purchase_orders || []).filter((po) => po.status !== 'Cancelled').reduce((a, po) => a + getEffectivePOCost(po).total, 0);
    const outAlloc = (p.vendor_allocations || []).filter((a) => !a.po_id).reduce((a, v) => a + (parseFloat(v.tax_amount) || 0), 0);
    return logistics + reimb + exp + outPO + outAlloc;
  };

  const { months, totals, forecast, topClients, categoryMix } = useMemo(() => {
    const now = new Date();
    const buckets = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-IN', { month: 'short' }), year: d.getFullYear(), revenue: 0, cost: 0, collected: 0 });
    }
    const idx = Object.fromEntries(buckets.map((b, i) => [b.key, i]));
    const delivered = projects.filter((p) => ['Completed', 'Closed'].includes(p.status));
    delivered.forEach((p) => {
      const dt = p.invoice_date || p.end_date || p.start_date;
      if (!dt) return;
      const key = dt.slice(0, 7);
      if (key in idx) { buckets[idx[key]].revenue += getProjectGrandTotal(p); buckets[idx[key]].cost += projectCost(p); }
    });
    payments.forEach((pay) => { const key = (pay.date || pay.payment_date || '').slice(0, 7); if (key in idx) buckets[idx[key]].collected += parseFloat(pay.amount || 0); });
    buckets.forEach((b) => { b.margin = b.revenue - b.cost; b.marginPct = b.revenue > 0 ? +((b.margin / b.revenue) * 100).toFixed(1) : 0; });

    // linear-regression forecast on revenue → next 3 months
    const ys = buckets.map((b) => b.revenue);
    const n = ys.length; const xm = (n - 1) / 2; const ym = ys.reduce((a, c) => a + c, 0) / n;
    let num = 0, den = 0; ys.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
    const slope = den ? num / den : 0; const intercept = ym - slope * xm;
    const fc = [];
    for (let k = 0; k < 3; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() + 1 + k, 1);
      fc.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-IN', { month: 'short' }), forecast: Math.max(0, Math.round(intercept + slope * (n + k))) });
    }

    const totalRev = buckets.reduce((s, b) => s + b.revenue, 0);
    const totalCost = buckets.reduce((s, b) => s + b.cost, 0);
    const totalsObj = { revenue: totalRev, cost: totalCost, margin: totalRev - totalCost, marginPct: totalRev > 0 ? (totalRev - totalCost) / totalRev * 100 : 0, avg: totalRev / 12 };

    // top clients (12-mo delivered)
    const cm = {};
    delivered.forEach((p) => {
      const dt = (p.invoice_date || p.end_date || p.start_date || '').slice(0, 7);
      if (!(dt in idx)) return;
      const cid = p.client_id || 'unknown';
      if (!cm[cid]) cm[cid] = { revenue: 0, margin: 0 };
      cm[cid].revenue += getProjectGrandTotal(p); cm[cid].margin += getProjectGrandTotal(p) - projectCost(p);
    });
    const top = Object.entries(cm).map(([cid, v]) => ({ name: clients.find((c) => c.id === cid)?.name || '—', ...v })).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    // category mix
    const cat = {};
    delivered.forEach((p) => {
      const dt = (p.invoice_date || p.end_date || p.start_date || '').slice(0, 7);
      if (!(dt in idx)) return;
      (p.items || []).forEach((it) => { const k = it.category || 'Other'; cat[k] = (cat[k] || 0) + (it.total || 0); });
    });
    const mix = Object.entries(cat).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 9);

    // chart series: historical revenue + forecast (connect at last point)
    const series = buckets.map((b, i) => ({ label: b.label, revenue: b.revenue, cost: b.cost, marginPct: b.marginPct, forecast: i === buckets.length - 1 ? b.revenue : null }));
    fc.forEach((f) => series.push({ label: f.label, revenue: null, cost: null, marginPct: null, forecast: f.forecast }));

    return { months: series, totals: totalsObj, forecast: fc, topClients: top, categoryMix: mix };
  }, [projects, clients, expenses, payments]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can(role, 'reports', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to analytics.</div>;

  return (
    <div className="space-y-4 p-1">
      <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><LineIcon size={20} className="text-indigo-600" /> Business Analytics <span className="text-xs font-normal text-slate-400">· last 12 months</span></h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Revenue (12 mo)" value={formatCurrency(totals.revenue)} icon={<IndianRupee size={16} className="text-emerald-500" />} />
        <Card label="Gross Margin" value={`${formatCurrency(totals.margin)} · ${totals.marginPct.toFixed(0)}%`} icon={<Percent size={16} className="text-indigo-500" />} />
        <Card label="Avg / month" value={formatCurrency(totals.avg)} icon={<TrendingUp size={16} className="text-slate-500" />} />
        <Card label="Next month (forecast)" value={formatCurrency(forecast[0]?.forecast || 0)} icon={<TrendingUp size={16} className="text-amber-500" />} amber />
      </div>

      <ChartCard title="Revenue & Margin (monthly)">
        <ResponsiveContainer width="100%" height={300} minWidth={0}>
          <ComposedChart data={months.slice(0, 12)} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" fontSize={11} /><YAxis tickFormatter={compact} fontSize={11} /><YAxis yAxisId="r" orientation="right" tickFormatter={(v) => `${v}%`} fontSize={11} />
            <Tooltip formatter={(v, n) => (n === 'Margin %' ? `${v}%` : formatCurrency(v))} />
            <Legend />
            <Bar dataKey="revenue" name="Revenue" fill="#6366f1" radius={[3, 3, 0, 0]} />
            <Bar dataKey="cost" name="Cost" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" dataKey="marginPct" name="Margin %" stroke="#10b981" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Revenue trend + 3-month forecast">
        <ResponsiveContainer width="100%" height={260} minWidth={0}>
          <ComposedChart data={months} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" fontSize={11} /><YAxis tickFormatter={compact} fontSize={11} />
            <Tooltip formatter={(v) => formatCurrency(v)} />
            <Line dataKey="revenue" name="Revenue" stroke="#6366f1" strokeWidth={2} dot={false} connectNulls />
            <Line dataKey="forecast" name="Forecast" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Top clients by revenue">
          <ResponsiveContainer width="100%" height={280} minWidth={0}>
            <BarChart data={topClients} layout="vertical" margin={{ left: 10, right: 20 }}>
              <XAxis type="number" tickFormatter={compact} fontSize={11} />
              <YAxis type="category" dataKey="name" width={110} fontSize={10} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Bar dataKey="revenue" name="Revenue" fill="#6366f1" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Revenue by category">
          <ResponsiveContainer width="100%" height={280} minWidth={0}>
            <PieChart>
              <Pie data={categoryMix} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                {categoryMix.map((e, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      <p className="px-1 text-[11px] text-slate-400">Revenue = grand total of delivered (Completed/Closed) projects by invoice/end month. Forecast = linear trend of the last 12 months. Cost = outsourcing + expenses + logistics.</p>
    </div>
  );
};

const Card = ({ label, value, icon, amber }) => (
  <div className={`rounded-xl border p-4 ${amber ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">{icon} {label}</div>
    <div className="mt-1 text-base font-bold text-slate-800">{value}</div>
  </div>
);
const ChartCard = ({ title, children }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4">
    <h3 className="mb-3 text-sm font-bold text-slate-800">{title}</h3>
    {children}
  </div>
);

export default Analytics;
