import React, { useState, useMemo } from 'react';
import { Calendar, Users, Package, Briefcase, Printer, ChevronLeft, ChevronRight, MapPin } from 'lucide-react';
import { can } from '../utils/permissions';
import {
  formatCurrency, getProjectGrandTotal, getProjectNetTotal, getProjectOutsourcing,
  isProjectActiveOnDate, projectDurationDays, getLogHours, getHourlyRateForDate,
} from '../utils/helpers';

const isExcludedExpense = (s) => s === 'Rejected' || s === 'Disapproved';
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');
const ymd = (d) => (d ? String(d).slice(0, 10) : '');
const shiftDate = (key, n) => { const d = new Date(key); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const TONE = { slate: 'text-slate-700', indigo: 'text-indigo-700', blue: 'text-blue-700', emerald: 'text-emerald-700', red: 'text-red-600' };
const Card = ({ label, value, sub, tone = 'slate' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`mt-0.5 text-xl font-bold ${TONE[tone] || TONE.slate}`}>{value}</div>
    {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
  </div>
);

const DailyReport = ({ projects = [], clients = [], employees = [], expenses = [], timeLogs = [], role = 'user' }) => {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const empById = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);
  const clientById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c])), [clients]);

  const data = useMemo(() => {
    const D = date;
    const dayLogs = timeLogs.filter((l) => l.checkIn && ymd(l.checkIn) === D);

    const shows = projects.filter((p) => isProjectActiveOnDate(p, D)).map((p) => {
      const dur = projectDurationDays(p);
      const setupDay = ymd(p.setup_date);
      const startDay = ymd(p.start_date);
      const endDay = ymd(p.end_date);
      const dateTags = [];
      if (setupDay === D) dateTags.push({ label: 'Setup', className: 'bg-amber-50 text-amber-700' });
      if (startDay === D) dateTags.push({ label: 'Start', className: 'bg-indigo-50 text-indigo-700' });
      if (endDay === D) dateTags.push({ label: 'End', className: 'bg-emerald-50 text-emerald-700' });
      if (dateTags.length === 0) dateTags.push({ label: 'Within project window', className: 'bg-slate-100 text-slate-600' });

      const onDuty = dayLogs.filter((l) => l.project_id === p.id).map((l) => ({
        name: empById[l.employeeId]?.name || l.employeeId, inTime: l.checkIn, outTime: l.checkOut, hours: getLogHours(l),
      }));
      return {
        p, dur,
        client: clientById[p.client_id]?.name || '',
        dateTags,
        revGrandDay: getProjectGrandTotal(p) / dur,
        revNetDay: getProjectNetTotal(p) / dur,
        outsourcingDay: getProjectOutsourcing(p) / dur,
        assigned: (p.assigned_employees || []).map((id) => empById[id]?.name || id),
        onDuty,
        equipment: (p.items || []).map((it) => ({ name: it.item_name || it.name || it.item_id, qty: it.qty })),
      };
    });

    const crew = dayLogs.map((l) => {
      const emp = empById[l.employeeId] || {};
      const hours = getLogHours(l);
      const rate = Number(getHourlyRateForDate(emp, l.checkIn) || 0);
      return { id: l.id, name: emp.name || l.employeeId, project_name: l.project_name || (l.location || ''), inTime: l.checkIn, outTime: l.checkOut, hours, rate, cost: hours * rate, source: l.source };
    }).sort((a, b) => new Date(a.inTime) - new Date(b.inTime));
    const manpower = crew.reduce((s, c) => s + c.cost, 0);

    const isDirect = (e) => e.project_id && !e.is_general;
    const dayExpenses = expenses.filter((e) => e.date === D && !isExcludedExpense(e.status))
      .map((e) => ({ ...e, _name: empById[e.employee_id]?.name || empById[e.employeeId]?.name || '', _project: (projects.find((p) => p.id === e.project_id)?.project_name) || '' }));
    const directExp = dayExpenses.reduce((s, e) => s + (isDirect(e) ? (Number(e.amount) || 0) : 0), 0);
    const generalExp = dayExpenses.reduce((s, e) => s + (isDirect(e) ? 0 : (Number(e.amount) || 0)), 0);

    const movements = [];
    projects.forEach((p) => (p.challans || []).forEach((ch) => {
      if (ymd(ch.date) === D) (ch.items || []).forEach((it) => movements.push({ project: p.project_name, type: ch.type, challan_no: ch.challan_no, item: it.item_name, qty: it.qty }));
    }));

    const revenue = shows.reduce((s, x) => s + x.revGrandDay, 0);
    const outsourcing = shows.reduce((s, x) => s + x.outsourcingDay, 0);
    const margin = revenue - (manpower + directExp + generalExp + outsourcing);

    return { shows, crew, manpower, dayExpenses, directExp, generalExp, movements, revenue, outsourcing, margin };
  }, [date, projects, timeLogs, expenses, empById, clientById]);

  if (!can(role, 'daily_reports', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to daily reports.</div>;

  const niceDate = new Date(date).toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const PL = [
    { k: 'Revenue (prorated, incl GST)', v: data.revenue, kind: 'in' },
    { k: 'Manpower cost', v: -data.manpower, kind: 'out' },
    { k: 'Direct project expenses', v: -data.directExp, kind: 'out' },
    { k: 'General / overhead expenses', v: -data.generalExp, kind: 'out' },
    { k: 'Outsourcing (prorated)', v: -data.outsourcing, kind: 'out' },
  ];

  return (
    <div className="space-y-4 p-1">
      {/* Header + date */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Calendar size={20} className="text-indigo-600" /> Daily Report</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setDate((d) => shiftDate(d, -1))} className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"><ChevronLeft size={16} /></button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-black" />
          <button onClick={() => setDate((d) => shiftDate(d, 1))} className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"><ChevronRight size={16} /></button>
          <button onClick={() => setDate(new Date().toISOString().slice(0, 10))} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50">Today</button>
          <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"><Printer size={14} /> Print</button>
        </div>
      </div>
      <div className="text-sm font-semibold text-slate-600">{niceDate}</div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card label="Shows running" value={data.shows.length} tone="indigo" />
        <Card label="Crew on duty" value={data.crew.length} sub={`${data.crew.reduce((s, c) => s + c.hours, 0).toFixed(1)} hrs`} tone="blue" />
        <Card label="Day revenue" value={formatCurrency(data.revenue)} sub="prorated" tone="emerald" />
        <Card label="Indicative margin" value={formatCurrency(data.margin)} tone={data.margin >= 0 ? 'emerald' : 'red'} />
      </div>

      {/* Shows running */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700"><Briefcase size={15} className="mr-1.5 inline text-indigo-600" /> Shows running ({data.shows.length})</div>
        {data.shows.length === 0 ? <div className="px-4 py-6 text-center text-xs text-slate-400">No shows running on this date.</div> : (
          <div className="divide-y divide-slate-100">
            {data.shows.map((s) => (
              <div key={s.p.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800">{s.p.project_name}</div>
                    <div className="text-xs text-slate-500">{s.client}{s.p.venue ? <> · <MapPin size={11} className="inline" /> {s.p.venue}</> : null} · {s.p.status}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.dateTags.map((tag) => (
                        <span key={tag.label} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tag.className}`}>{tag.label}</span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-emerald-700">{formatCurrency(s.revGrandDay)}/day</div>
                    <div className="text-[11px] text-slate-400">of {formatCurrency(getProjectGrandTotal(s.p))} over {s.dur}d</div>
                  </div>
                </div>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <div className="mb-1 font-semibold text-slate-500">Crew handling</div>
                    {s.onDuty.length === 0 && s.assigned.length === 0 ? <span className="text-slate-400">—</span> : (
                      <div className="flex flex-wrap gap-1">
                        {s.onDuty.map((c, i) => <span key={`o${i}`} className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">{c.name} {hhmm(c.inTime)}–{c.outTime ? hhmm(c.outTime) : 'open'}</span>)}
                        {s.assigned.filter((n) => !s.onDuty.some((o) => o.name === n)).map((n, i) => <span key={`a${i}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{n}</span>)}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-slate-500">Key equipment</div>
                    {s.equipment.length === 0 ? <span className="text-slate-400">—</span> : (
                      <div className="flex flex-wrap gap-1">{s.equipment.slice(0, 14).map((it, i) => <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{it.name} ×{it.qty}</span>)}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Crew on duty */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700"><Users size={15} className="mr-1.5 inline text-indigo-600" /> Crew on duty — in/out &amp; manpower cost</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-slate-50 text-left text-[11px] uppercase text-slate-400"><th className="p-2.5">Employee</th><th className="p-2.5">Project / Loc</th><th className="p-2.5">In</th><th className="p-2.5">Out</th><th className="p-2.5 text-right">Hours</th><th className="p-2.5 text-right">Rate</th><th className="p-2.5 text-right">Cost</th></tr></thead>
            <tbody>
              {data.crew.length === 0 ? <tr><td colSpan={7} className="p-6 text-center text-xs text-slate-400">Nobody checked in on this date.</td></tr> : data.crew.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="p-2.5 font-medium text-slate-700">{c.name}{c.source === 'SR' && <span title="Recorded from an approved shift request" className="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">SR</span>}</td>
                  <td className="p-2.5 text-slate-500">{c.project_name || '—'}</td>
                  <td className="p-2.5">{hhmm(c.inTime)}</td>
                  <td className="p-2.5">{c.outTime ? hhmm(c.outTime) : <span className="text-amber-600">open</span>}</td>
                  <td className="p-2.5 text-right">{c.hours.toFixed(2)}</td>
                  <td className="p-2.5 text-right text-slate-500">{c.rate ? formatCurrency(c.rate) : '—'}</td>
                  <td className="p-2.5 text-right font-medium">{formatCurrency(c.cost)}</td>
                </tr>
              ))}
            </tbody>
            {data.crew.length > 0 && <tfoot><tr className="border-t bg-slate-50 font-bold"><td className="p-2.5" colSpan={6}>Total manpower cost</td><td className="p-2.5 text-right">{formatCurrency(data.manpower)}</td></tr></tfoot>}
          </table>
        </div>
      </section>

      {/* Expenses */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700">Expenses submitted for the day</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-slate-50 text-left text-[11px] uppercase text-slate-400"><th className="p-2.5">Category</th><th className="p-2.5">By</th><th className="p-2.5">For</th><th className="p-2.5">Status</th><th className="p-2.5 text-right">Amount</th></tr></thead>
            <tbody>
              {data.dayExpenses.length === 0 ? <tr><td colSpan={5} className="p-6 text-center text-xs text-slate-400">No expenses for this date.</td></tr> : data.dayExpenses.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="p-2.5 text-slate-700">{e.category}</td>
                  <td className="p-2.5 text-slate-500">{e._name || '—'}</td>
                  <td className="p-2.5">{e.project_id && !e.is_general ? <span className="text-indigo-600">{e._project || 'Project'}</span> : <span className="text-slate-400">General</span>}</td>
                  <td className="p-2.5 text-xs text-slate-500">{e.status}</td>
                  <td className="p-2.5 text-right font-medium">{formatCurrency(e.amount)}</td>
                </tr>
              ))}
            </tbody>
            {data.dayExpenses.length > 0 && <tfoot><tr className="border-t bg-slate-50 text-xs font-bold"><td className="p-2.5" colSpan={4}>Direct {formatCurrency(data.directExp)} · General {formatCurrency(data.generalExp)}</td><td className="p-2.5 text-right">{formatCurrency(data.directExp + data.generalExp)}</td></tr></tfoot>}
          </table>
        </div>
      </section>

      {/* Equipment movements */}
      {data.movements.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700"><Package size={15} className="mr-1.5 inline text-indigo-600" /> Equipment dispatched / returned today</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-slate-50 text-left text-[11px] uppercase text-slate-400"><th className="p-2.5">Item</th><th className="p-2.5 text-right">Qty</th><th className="p-2.5">Direction</th><th className="p-2.5">Project</th><th className="p-2.5">Challan</th></tr></thead>
              <tbody>
                {data.movements.map((m, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="p-2.5 text-slate-700">{m.item}</td>
                    <td className="p-2.5 text-right">{m.qty}</td>
                    <td className="p-2.5"><span className={`rounded px-1.5 py-0.5 text-xs ${m.type === 'delivery' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{m.type === 'delivery' ? 'Out' : 'In'}</span></td>
                    <td className="p-2.5 text-slate-500">{m.project}</td>
                    <td className="p-2.5 text-xs text-slate-400">{m.challan_no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Daily P&L */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-bold text-slate-700">Daily financial summary</div>
        <div className="space-y-1.5 text-sm">
          {PL.map((r) => (
            <div key={r.k} className="flex items-center justify-between border-b border-slate-50 pb-1.5">
              <span className="text-slate-600">{r.k}</span>
              <span className={`font-medium ${r.kind === 'out' ? 'text-red-600' : 'text-emerald-700'}`}>{r.kind === 'out' ? `(${formatCurrency(Math.abs(r.v))})` : formatCurrency(r.v)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1 text-base font-bold">
            <span className="text-slate-800">Indicative day margin</span>
            <span className={data.margin >= 0 ? 'text-emerald-700' : 'text-red-600'}>{formatCurrency(data.margin)}</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Manpower &amp; dated expenses are actuals for the day. Revenue &amp; outsourcing are each project's total spread evenly across its run-days (a daily run-rate), so single-day figures are indicative, not invoiced amounts.</p>
      </section>
    </div>
  );
};

export default DailyReport;
