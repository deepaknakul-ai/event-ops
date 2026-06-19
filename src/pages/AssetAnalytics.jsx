import React, { useState, useMemo } from 'react';
import * as XLSX from '@e965/xlsx';
import { Boxes, TrendingUp, Percent, AlertTriangle, Download, ArrowUpDown } from 'lucide-react';
import { formatCurrency } from '../utils/helpers';
import { can } from '../utils/permissions';
import { notify } from '../utils/toast';

// Per-asset ROI & utilisation. Revenue = Σ line totals across projects in the
// period; utilisation = unit-days booked ÷ (units × period days); ROI =
// revenue ÷ purchase cost. Idle = no bookings in the period.
const AssetAnalytics = ({ inventory = [], projects = [], role = 'manager' }) => {
  const today = new Date();
  const yearAgo = new Date(today); yearAgo.setFullYear(today.getFullYear() - 1);
  const [from, setFrom] = useState(yearAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [sortKey, setSortKey] = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');

  const periodDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);

  const rows = useMemo(() => {
    const inRange = (d) => d && d >= from && d <= to;
    const periodProjects = projects.filter((p) => p.status !== 'Cancelled' && inRange(p.start_date));
    const agg = {};
    periodProjects.forEach((p) => (p.items || []).forEach((it) => {
      const id = it.item_id; if (!id) return;
      if (!agg[id]) agg[id] = { revenue: 0, unitDays: 0, projects: new Set() };
      agg[id].revenue += it.total || 0;
      agg[id].unitDays += (parseInt(it.qty) || 0) * (parseInt(it.days) || 0);
      agg[id].projects.add(p.id);
    }));
    return inventory
      .filter((i) => !i.is_composite && !i.is_external)
      .map((i) => {
        const a = agg[i.id] || { revenue: 0, unitDays: 0, projects: new Set() };
        const units = parseInt(i.total) || 0;
        const cost = parseFloat(i.purchase_cost) || 0;
        const capacity = units * periodDays;
        return {
          id: i.id, name: i.name, category: i.category || '—', units, cost,
          revenue: a.revenue, unitDays: a.unitDays, rentals: a.projects.size,
          utilization: capacity > 0 ? (a.unitDays / capacity) * 100 : 0,
          roi: cost > 0 ? a.revenue / cost : null,
          idle: a.revenue <= 0,
        };
      });
  }, [inventory, projects, from, to, periodDays]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }, [rows, sortKey, sortDir]);

  const totals = useMemo(() => {
    const assetValue = rows.reduce((s, r) => s + r.cost, 0);
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const idle = rows.filter((r) => r.idle && r.cost > 0);
    const idleValue = idle.reduce((s, r) => s + r.cost, 0);
    const avgUtil = rows.length ? rows.reduce((s, r) => s + r.utilization, 0) / rows.length : 0;
    return { assetValue, revenue, roi: assetValue > 0 ? revenue / assetValue : 0, idleCount: idle.length, idleValue, avgUtil };
  }, [rows]);

  const setSort = (k) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc'); } };

  const exportExcel = () => {
    const data = sorted.map((r) => ({
      Asset: r.name, Category: r.category, Units: r.units,
      'Purchase Cost': r.cost, 'Rentals': r.rentals, 'Unit-Days Booked': r.unitDays,
      'Utilization %': +r.utilization.toFixed(1), Revenue: r.revenue, 'ROI x': r.roi != null ? +r.roi.toFixed(2) : '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Asset Analytics');
    XLSX.writeFile(wb, `Asset_Analytics_${from}_to_${to}.xlsx`);
    notify('Exported to Excel', 'success');
  };

  if (!can(role, 'reports', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to asset analytics.</div>;

  const Th = ({ k, children, right }) => (
    <th onClick={() => setSort(k)} className={`cursor-pointer select-none px-3 py-2 font-semibold ${right ? 'text-right' : 'text-left'} hover:text-indigo-600`}>
      <span className="inline-flex items-center gap-1">{children}{sortKey === k && <ArrowUpDown size={11} />}</span>
    </th>
  );

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Boxes size={20} className="text-indigo-600" /> Asset Analytics</h2>
        <div className="flex items-center gap-2 text-sm">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" />
          <span className="text-slate-400">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" />
          <button onClick={exportExcel} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-slate-600 hover:bg-slate-50"><Download size={15} /> Excel</button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Asset Value" value={formatCurrency(totals.assetValue)} icon={<Boxes size={16} className="text-slate-500" />} />
        <Card label="Rental Revenue (period)" value={formatCurrency(totals.revenue)} icon={<TrendingUp size={16} className="text-emerald-500" />} />
        <Card label="Blended ROI" value={`${totals.roi.toFixed(2)}×`} icon={<Percent size={16} className="text-indigo-500" />} />
        <Card label="Idle Assets" value={`${totals.idleCount} · ${formatCurrency(totals.idleValue)}`} icon={<AlertTriangle size={16} className="text-amber-500" />} amber={totals.idleCount > 0} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <Th k="name">Asset</Th>
              <Th k="category">Category</Th>
              <Th k="units" right>Units</Th>
              <Th k="cost" right>Purchase Cost</Th>
              <Th k="rentals" right>Rentals</Th>
              <Th k="utilization" right>Utilization</Th>
              <Th k="revenue" right>Revenue</Th>
              <Th k="roi" right>ROI</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No assets.</td></tr>
            ) : sorted.map((r) => (
              <tr key={r.id} className={`border-t border-slate-50 ${r.idle && r.cost > 0 ? 'bg-amber-50/40' : ''}`}>
                <td className="px-3 py-2 font-medium text-slate-700">{r.name}</td>
                <td className="px-3 py-2 text-slate-500">{r.category}</td>
                <td className="px-3 py-2 text-right text-slate-600">{r.units}</td>
                <td className="px-3 py-2 text-right text-slate-600">{r.cost ? formatCurrency(r.cost) : '—'}</td>
                <td className="px-3 py-2 text-right text-slate-600">{r.rentals}</td>
                <td className="px-3 py-2 text-right">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${r.utilization >= 50 ? 'bg-emerald-100 text-emerald-700' : r.utilization > 0 ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-700'}`}>{r.utilization.toFixed(0)}%</span>
                </td>
                <td className="px-3 py-2 text-right font-semibold text-slate-800">{formatCurrency(r.revenue)}</td>
                <td className="px-3 py-2 text-right">{r.roi != null ? <span className={r.roi >= 1 ? 'font-semibold text-emerald-600' : 'text-slate-500'}>{r.roi.toFixed(2)}×</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-1 text-[11px] text-slate-400">Utilization = unit-days booked ÷ (units × {periodDays} days in period). ROI = rental revenue in period ÷ purchase cost. Composite & external items excluded.</p>
    </div>
  );
};

const Card = ({ label, value, icon, amber }) => (
  <div className={`rounded-xl border p-4 ${amber ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">{icon} {label}</div>
    <div className="mt-1 text-lg font-bold text-slate-800">{value}</div>
  </div>
);

export default AssetAnalytics;
