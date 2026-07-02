import React, { useState, useMemo } from 'react';
import { addDoc, collection } from 'firebase/firestore';
import { Percent, ChevronDown, ChevronRight, IndianRupee } from 'lucide-react';
import { can } from '../utils/permissions';
import { notify } from '../utils/toast';
import { promptDialog } from '../utils/dialog';
import { formatCurrency, getProjectCommission } from '../utils/helpers';

// Referral commission: an employee who brings a client earns rate% of the net
// profit of that client's projects, realized in proportion to the cash received.
const Commission = ({ clients = [], projects = [], expenses = [], payments = [], payouts = [], employees = [], role = 'user', currentEmpId, db, appId, logAction = () => {} }) => {
  const [expanded, setExpanded] = useState({});
  const seeAll = role === 'admin' || role === 'accountant';
  const canPay = can(role, 'commission', 'pay');
  const empName = (id) => employees.find((e) => e.id === id)?.name || id;

  const data = useMemo(() => {
    const ownedClients = clients.filter((c) => c.owner_id && (seeAll || c.owner_id === currentEmpId));
    const byEmp = {};
    ownedClients.forEach((c) => {
      const rate = c.referral_rate ?? 10;
      projects.filter((p) => p.client_id === c.id && p.status !== 'Cancelled').forEach((p) => {
        const r = getProjectCommission(p, expenses, payments, rate);
        if (r.grand <= 0 && r.commission === 0) return;
        const owner = c.owner_id;
        byEmp[owner] = byEmp[owner] || { emp_id: owner, name: empName(owner), accrued: 0, rows: [] };
        byEmp[owner].accrued += r.commission;
        byEmp[owner].rows.push({ client: c.name, project: p.project_name || '—', status: p.status, rate, ...r });
      });
    });
    Object.values(byEmp).forEach((e) => {
      e.paid = (payouts || []).filter((po) => po.employee_id === e.emp_id && po.commission).reduce((s, po) => s + (Number(po.amount) || 0), 0);
      e.balance = e.accrued - e.paid;
      e.rows.sort((a, b) => b.commission - a.commission);
    });
    return Object.values(byEmp).sort((a, b) => b.balance - a.balance);
  }, [clients, projects, expenses, payments, payouts, seeAll, currentEmpId, employees]); // eslint-disable-line react-hooks/exhaustive-deps

  const recordPayout = async (emp) => {
    if (!canPay) return notify('Only admin/accountant can record commission payouts.', 'error');
    const amtStr = await promptDialog(`Record commission payout to ${emp.name}.\nOutstanding balance: ${formatCurrency(emp.balance)}.\n\nAmount (₹):`, String(Math.max(0, Math.round(emp.balance))));
    if (amtStr === null) return;
    const amount = Number(amtStr);
    if (!amount || amount <= 0) return notify('Enter a valid amount', 'error');
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payouts'), {
        employee_id: emp.emp_id, employee_name: emp.name, amount, date: new Date().toISOString().slice(0, 10),
        mode: 'Bank Transfer', reference: '', remarks: 'Referral commission', commission: true,
        created_at: new Date().toISOString(), created_by: currentEmpId || '',
      });
      logAction('payouts', 'commission_payout', emp.emp_id, { amount }, emp.name);
      notify(`Commission payout of ${formatCurrency(amount)} recorded for ${emp.name}`, 'success');
    } catch (e) { notify(`Failed: ${e.message || e}`, 'error'); }
  };

  if (!can(role, 'commission', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to commissions.</div>;

  const totals = data.reduce((t, e) => ({ accrued: t.accrued + e.accrued, paid: t.paid + e.paid, balance: t.balance + e.balance }), { accrued: 0, paid: 0, balance: 0 });

  return (
    <div className="space-y-4 p-1">
      <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Percent size={20} className="text-indigo-600" /> Referral Commission</h2>
      <p className="text-xs text-slate-500">Earned as the client's projects are paid: <span className="font-medium">rate% × net profit (revenue − direct costs − outsourcing) × fraction paid</span>.</p>
      {!seeAll && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          These figures are <span className="font-semibold">indicative</span>. Some project costs are not visible to your role, so net profit here is an estimate — your final commission is confirmed and paid by Accounts.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[11px] font-semibold uppercase text-slate-400">Accrued</div><div className="mt-0.5 text-xl font-bold text-slate-700">{formatCurrency(totals.accrued)}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[11px] font-semibold uppercase text-slate-400">Paid out</div><div className="mt-0.5 text-xl font-bold text-emerald-700">{formatCurrency(totals.paid)}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[11px] font-semibold uppercase text-slate-400">Balance owed</div><div className={`mt-0.5 text-xl font-bold ${totals.balance > 0 ? 'text-amber-700' : 'text-slate-700'}`}>{formatCurrency(totals.balance)}</div></div>
      </div>

      {data.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">No commission yet. Assign an owner to a client (Clients → Edit → Owner) and record payments on their projects.</div>
      ) : data.map((e) => (
        <div key={e.emp_id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <button onClick={() => setExpanded((x) => ({ ...x, [e.emp_id]: !x[e.emp_id] }))} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-slate-50">
            <div className="flex items-center gap-2">
              {expanded[e.emp_id] ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
              <span className="font-semibold text-slate-800">{e.name}</span>
              <span className="text-xs text-slate-400">{e.rows.length} project(s)</span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-slate-500">accrued <span className="font-semibold text-slate-700">{formatCurrency(e.accrued)}</span></span>
              <span className="text-slate-500">paid <span className="font-semibold text-emerald-700">{formatCurrency(e.paid)}</span></span>
              <span className={`font-bold ${e.balance > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{formatCurrency(e.balance)} due</span>
              {canPay && e.balance > 0 && <span onClick={(ev) => { ev.stopPropagation(); recordPayout(e); }} className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700"><IndianRupee size={12} /> Pay</span>}
            </div>
          </button>
          {expanded[e.emp_id] && (
            <div className="overflow-x-auto border-t border-slate-100">
              <table className="w-full text-sm">
                <thead><tr className="bg-slate-50 text-left text-[11px] uppercase text-slate-400"><th className="p-2.5">Client</th><th className="p-2.5">Project</th><th className="p-2.5 text-right">Net profit</th><th className="p-2.5 text-right">Paid</th><th className="p-2.5 text-right">Rate</th><th className="p-2.5 text-right">Commission</th></tr></thead>
                <tbody>
                  {e.rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-2.5 text-slate-600">{r.client}</td>
                      <td className="p-2.5 text-slate-700">{r.project} <span className="text-[10px] text-slate-400">({r.status})</span></td>
                      <td className="p-2.5 text-right">{formatCurrency(r.netProfit)}</td>
                      <td className="p-2.5 text-right text-slate-500">{Math.round(r.paidFraction * 100)}%</td>
                      <td className="p-2.5 text-right text-slate-500">{r.rate}%</td>
                      <td className="p-2.5 text-right font-medium">{formatCurrency(r.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default Commission;
