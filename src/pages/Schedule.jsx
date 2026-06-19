import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, AlertTriangle, Users, Package, Calendar } from 'lucide-react';
import { isDateOverlap } from '../utils/helpers';
import { can } from '../utils/permissions';

// Read-only resource / dispatch board: a month timeline of projects with their
// crew + key equipment, plus conflict detection (double-booked staff and
// over-allocated equipment across overlapping projects).
const Schedule = ({ projects = [], inventory = [], employees = [], role = 'manager' }) => {
  const navigate = useNavigate();
  const [monthOffset, setMonthOffset] = useState(0);

  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + monthOffset);
  const year = base.getFullYear(), month = base.getMonth();
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const monthLabel = base.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const todayIso = new Date().toISOString().slice(0, 10);

  const empName = (id) => employees.find((e) => e.id === id)?.name || id;
  const itemName = (id) => inventory.find((i) => i.id === id)?.name || id;

  const active = useMemo(() => projects.filter((p) => p.status !== 'Cancelled' && p.start_date && p.end_date), [projects]);

  const rangeStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const rangeEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const monthProjects = useMemo(
    () => active.filter((p) => isDateOverlap(p.start_date, p.end_date, rangeStart, rangeEnd)).sort((a, b) => new Date(a.start_date) - new Date(b.start_date)),
    [active, rangeStart, rangeEnd],
  );

  const conflicts = useMemo(() => {
    const out = [];
    // crew double-booking
    const empMap = {};
    active.forEach((p) => (p.assigned_employees || []).forEach((eid) => { (empMap[eid] = empMap[eid] || []).push(p); }));
    Object.entries(empMap).forEach(([eid, ps]) => {
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        if (isDateOverlap(ps[i].start_date, ps[i].end_date, ps[j].start_date, ps[j].end_date)) {
          out.push({ type: 'crew', label: `${empName(eid)} double-booked`, detail: `${ps[i].project_name} ↔ ${ps[j].project_name}`, ids: [ps[i].id, ps[j].id] });
        }
      }
    });
    // equipment over-allocation (pairwise)
    const itemMap = {};
    active.forEach((p) => {
      const agg = {};
      (p.items || []).forEach((it) => { if (it.item_id) agg[it.item_id] = (agg[it.item_id] || 0) + (parseInt(it.qty) || 0); });
      Object.entries(agg).forEach(([iid, qty]) => { (itemMap[iid] = itemMap[iid] || []).push({ p, qty }); });
    });
    Object.entries(itemMap).forEach(([iid, arr]) => {
      const inv = inventory.find((i) => i.id === iid);
      const total = inv?.total || 0;
      if (arr.length < 2 || !total || inv?.is_external) return;
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        if (isDateOverlap(arr[i].p.start_date, arr[i].p.end_date, arr[j].p.start_date, arr[j].p.end_date) && (arr[i].qty + arr[j].qty) > total) {
          out.push({ type: 'equipment', label: `${itemName(iid)} over-booked (${arr[i].qty + arr[j].qty}/${total})`, detail: `${arr[i].p.project_name} ↔ ${arr[j].p.project_name}`, ids: [arr[i].p.id, arr[j].p.id] });
        }
      }
    });
    const seen = new Set();
    return out.filter((c) => { const k = c.type + c.label + c.detail; if (seen.has(k)) return false; seen.add(k); return true; });
  }, [active, inventory, employees]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflictIds = useMemo(() => new Set(conflicts.flatMap((c) => c.ids)), [conflicts]);

  const barStyle = (p) => {
    const s = new Date(Math.max(new Date(p.start_date).getTime(), monthStart.getTime()));
    const e = new Date(Math.min(new Date(p.end_date).getTime(), monthEnd.getTime()));
    const startDay = Math.max(0, s.getDate() - 1);
    const endDay = e.getDate();
    return { left: `${(startDay / daysInMonth) * 100}%`, width: `${Math.max(3, ((endDay - startDay) / daysInMonth) * 100)}%` };
  };
  const statusBar = (s) => ({ Quoted: 'bg-slate-400', Confirmed: 'bg-blue-500', Ongoing: 'bg-amber-500', Completed: 'bg-emerald-500', Closed: 'bg-emerald-600' }[s] || 'bg-slate-400');

  if (!can(role, 'projects', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to the schedule.</div>;

  // light day gridlines (weeks)
  const weekTicks = []; for (let d = 1; d <= daysInMonth; d += 7) weekTicks.push(d);

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Calendar size={20} className="text-indigo-600" /> Resource Schedule</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonthOffset((m) => m - 1)} className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"><ChevronLeft size={16} /></button>
          <span className="min-w-[130px] text-center text-sm font-semibold text-slate-700">{monthLabel}</span>
          <button onClick={() => setMonthOffset((m) => m + 1)} className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"><ChevronRight size={16} /></button>
          {monthOffset !== 0 && <button onClick={() => setMonthOffset(0)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50">Today</button>}
        </div>
      </div>

      {/* Conflicts */}
      <div className={`rounded-xl border p-4 ${conflicts.length ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <div className="flex items-center gap-2 text-sm font-bold">
          <AlertTriangle size={16} className={conflicts.length ? 'text-red-600' : 'text-emerald-600'} />
          {conflicts.length ? `${conflicts.length} scheduling conflict(s)` : 'No scheduling conflicts'}
        </div>
        {conflicts.length > 0 && (
          <div className="mt-2 space-y-1">
            {conflicts.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-red-800">
                {c.type === 'crew' ? <Users size={12} /> : <Package size={12} />}
                <span className="font-semibold">{c.label}</span>
                <span className="text-red-600">— {c.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex border-b border-slate-100 bg-slate-50 text-[11px] text-slate-400">
          <div className="w-48 shrink-0 px-3 py-2 font-semibold uppercase tracking-wide">Project</div>
          <div className="relative flex-1">
            {weekTicks.map((d) => <span key={d} className="absolute top-0 py-2" style={{ left: `${((d - 1) / daysInMonth) * 100}%` }}>{d}</span>)}
          </div>
        </div>
        {monthProjects.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">No projects scheduled in {monthLabel}.</div>
        ) : monthProjects.map((p) => {
          const crew = (p.assigned_employees || []).length;
          const kit = (p.items || []).length;
          const flagged = conflictIds.has(p.id);
          return (
            <button key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="flex w-full items-stretch border-b border-slate-50 text-left hover:bg-slate-50">
              <div className="w-48 shrink-0 px-3 py-2.5">
                <div className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-700">{flagged && <AlertTriangle size={12} className="shrink-0 text-red-500" />}{p.project_name}</div>
                <div className="mt-0.5 flex items-center gap-3 text-[11px] text-slate-400"><span className="flex items-center gap-0.5"><Users size={10} /> {crew}</span><span className="flex items-center gap-0.5"><Package size={10} /> {kit}</span></div>
              </div>
              <div className="relative my-2 flex-1">
                {/* today marker */}
                {todayIso >= rangeStart && todayIso <= rangeEnd && (
                  <span className="absolute top-0 bottom-0 w-px bg-indigo-300" style={{ left: `${((new Date(todayIso).getDate() - 1) / daysInMonth) * 100}%` }} />
                )}
                <div className={`absolute top-1 h-5 rounded ${statusBar(p.status)} ${flagged ? 'ring-2 ring-red-400' : ''}`} style={barStyle(p)} title={`${p.start_date} → ${p.end_date} (${p.status})`} />
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 px-1 text-[11px] text-slate-500">
        {['Quoted', 'Confirmed', 'Ongoing', 'Completed'].map((s) => <span key={s} className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded ${statusBar(s)}`} /> {s}</span>)}
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-white ring-2 ring-red-400" /> Conflict</span>
      </div>
    </div>
  );
};

export default Schedule;
