import React, { useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import * as XLSX from '@e965/xlsx';
import { CalendarSync, Play, Edit, Trash2, Plus, AlertTriangle, CheckCircle, Download } from 'lucide-react';
import {
  computeNextRun,
  dueRuns,
  partitionRules,
  parseRecurringPhrase,
} from '../utils/aiAccountant';
import { generateJournalVoucherNumber } from '../utils/accounting';
import { formatCurrency, getFYFromDate } from '../utils/helpers';
import { isFYLocked } from '../utils/fyLock';
import { can } from '../utils/permissions';
import { ConfirmDeleteModal } from '../components/Shared';

const FREQUENCIES = [
  { value: 'daily',     label: 'Daily' },
  { value: 'weekly',    label: 'Weekly' },
  { value: 'monthly',   label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly',    label: 'Yearly' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const emptyForm = () => ({
  name: '',
  active: true,
  frequency: 'monthly',
  interval: 1,
  dayOfMonth: 1,
  dayOfWeek: 1,
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  narration: '',
  debitAccount: '',
  creditAccount: '',
  amount: '',
});

const ruleFromForm = (form) => {
  const clean = {
    name: (form.name || '').trim(),
    active: !!form.active,
    frequency: form.frequency,
    interval: Math.max(1, parseInt(form.interval || 1, 10)),
    startDate: form.startDate,
    endDate: form.endDate || null,
    template: {
      narration: form.narration || form.name,
      debitAccount: form.debitAccount,
      creditAccount: form.creditAccount,
      amount: parseFloat(form.amount || 0),
    },
  };
  if (form.frequency === 'weekly') {
    clean.dayOfWeek = Math.max(0, Math.min(6, parseInt(form.dayOfWeek || 0, 10)));
  }
  if (['monthly', 'quarterly', 'yearly'].includes(form.frequency)) {
    clean.dayOfMonth = Math.max(1, Math.min(31, parseInt(form.dayOfMonth || 1, 10)));
  }
  return clean;
};

const RecurringEntries = ({
  db,
  appId,
  role,
  user,
  recurringRules = [],
  chartOfAccounts = [],
  logAction,
  addToast,
  lockedFYs = [],
}) => {
  const canEdit = can(role, 'finance', 'edit') || can(role, 'finance', 'create');
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null);
  const [posting, setPosting] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ isOpen: false, rule: null });
  const [phrase, setPhrase] = useState('');

  const today = new Date().toISOString().slice(0, 10);
  const partition = useMemo(() => partitionRules(recurringRules, today), [recurringRules, today]);
  const accountOptions = useMemo(
    () => (chartOfAccounts || []).map((a) => a.name).filter(Boolean).sort(),
    [chartOfAccounts]
  );

  const applyPhrase = () => {
    const hint = parseRecurringPhrase(phrase, today);
    if (!hint) { addToast?.('Could not parse recurrence phrase.', 'warn'); return; }
    setForm((f) => ({ ...f, frequency: hint.frequency, interval: hint.interval || 1, dayOfMonth: hint.dayOfMonth || f.dayOfMonth, startDate: hint.startDate || f.startDate }));
  };

  const resetForm = () => { setForm(emptyForm()); setEditingId(null); };

  const startEdit = (rule) => {
    setEditingId(rule.id);
    setForm({
      name: rule.name || '',
      active: rule.active !== false,
      frequency: rule.frequency || 'monthly',
      interval: rule.interval || 1,
      dayOfMonth: rule.dayOfMonth || 1,
      dayOfWeek: rule.dayOfWeek ?? 1,
      startDate: rule.startDate || today,
      endDate: rule.endDate || '',
      narration: rule.template?.narration || '',
      debitAccount: rule.template?.debitAccount || '',
      creditAccount: rule.template?.creditAccount || '',
      amount: rule.template?.amount || '',
    });
  };

  const handleSave = async () => {
    if (!canEdit) return;
    if (!form.name.trim()) return addToast?.('Name is required', 'warn');
    if (!form.debitAccount || !form.creditAccount) return addToast?.('Debit and Credit accounts are required', 'warn');
    if (form.debitAccount === form.creditAccount) return addToast?.('Debit and Credit must differ', 'warn');
    const amt = parseFloat(form.amount || 0);
    if (!(amt > 0)) return addToast?.('Amount must be > 0', 'warn');

    const clean = ruleFromForm(form);
    const nextRun = computeNextRun({ ...clean, lastRunDate: null }, today);

    try {
      if (editingId) {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'recurring_rules', editingId);
        await updateDoc(ref, { ...clean, nextRun, updated_at: new Date().toISOString() });
        logAction?.('recurring_rules', 'update', editingId, clean, `Updated rule ${clean.name}`);
        addToast?.('Rule updated', 'success');
      } else {
        const payload = { ...clean, nextRun, lastRunDate: null, created_by: user?.uid || '', created_at: new Date().toISOString() };
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'recurring_rules'), payload);
        logAction?.('recurring_rules', 'create', ref.id, payload, `Created rule ${clean.name}`);
        addToast?.('Rule saved', 'success');
      }
      resetForm();
    } catch (err) {
      console.error(err);
      addToast?.('Failed to save rule', 'error');
    }
  };

  const toggleActive = async (rule) => {
    if (!canEdit) return;
    const ref = doc(db, 'artifacts', appId, 'public', 'data', 'recurring_rules', rule.id);
    try {
      await updateDoc(ref, { active: !rule.active, updated_at: new Date().toISOString() });
      logAction?.('recurring_rules', 'update', rule.id, { active: !rule.active }, `${rule.active ? 'Paused' : 'Resumed'} ${rule.name}`);
    } catch (err) { console.error(err); addToast?.('Failed to toggle', 'error'); }
  };

  const confirmDelete = async () => {
    const rule = deleteModal.rule;
    if (!rule) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'recurring_rules', rule.id));
      logAction?.('recurring_rules', 'delete', rule.id, {}, `Deleted ${rule.name}`);
      addToast?.('Rule deleted', 'success');
    } catch (err) { console.error(err); addToast?.('Failed to delete', 'error'); }
    setDeleteModal({ isOpen: false, rule: null });
  };

  const postRule = async (rule) => {
    if (!canEdit) return;
    const due = dueRuns(rule, today);
    if (due.length === 0) { addToast?.('No runs due', 'info'); return; }
    setPosting(true);
    let posted = 0;
    let skippedLocked = 0;
    try {
      for (const runDate of due) {
        if (isFYLocked(runDate, lockedFYs)) { skippedLocked++; continue; }
        const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr: runDate });
        const amount = Number(rule.template?.amount || 0);
        if (!(amount > 0)) continue;
        const payload = {
          voucher_no: voucherNo,
          fy: getFYFromDate(runDate),
          date: runDate,
          narration: rule.template?.narration || rule.name,
          source: 'recurring_rule',
          status: 'posted',
          entries: [{
            debitAccount: rule.template.debitAccount,
            creditAccount: rule.template.creditAccount,
            amount,
          }],
          recurring_rule_id: rule.id,
          created_by: user?.uid || '',
          created_at: new Date().toISOString(),
        };
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
        logAction?.('journal_entries', 'create', ref.id, payload, `Recurring JV ${voucherNo} (${rule.name})`);
        posted++;
      }
      const lastRunDate = due[due.length - 1];
      const updated = { ...rule, lastRunDate };
      const nextRun = computeNextRun(updated, lastRunDate);
      await updateDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'recurring_rules', rule.id),
        { lastRunDate, nextRun, updated_at: new Date().toISOString() }
      );
      if (skippedLocked > 0) {
        addToast?.(`Posted ${posted}; skipped ${skippedLocked} run${skippedLocked === 1 ? '' : 's'} in locked FY`, 'warn');
      } else {
        addToast?.(`Posted ${posted} run${posted === 1 ? '' : 's'} for "${rule.name}"`, 'success');
      }
    } catch (err) {
      console.error(err);
      addToast?.('Failed to post some runs', 'error');
    }
    setPosting(false);
  };

  const postAllDue = async () => {
    for (const rule of partition.due) {
      await postRule(rule);
    }
  };

  const exportXLSX = () => {
    const rows = (recurringRules || []).map((r) => ({
      Name: r.name || '',
      Active: r.active === false ? 'No' : 'Yes',
      Frequency: r.frequency || '',
      Interval: r.interval || 1,
      'Day of Month': r.dayOfMonth || '',
      'Day of Week': r.dayOfWeek != null ? WEEKDAYS[r.dayOfWeek] : '',
      'Start Date': r.startDate || '',
      'End Date': r.endDate || '',
      'Next Run': r.nextRun || '',
      'Last Run': r.lastRunDate || '',
      Narration: r.template?.narration || '',
      'Debit Account': r.template?.debitAccount || '',
      'Credit Account': r.template?.creditAccount || '',
      Amount: r.template?.amount || 0,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Recurring Rules');
    XLSX.writeFile(wb, `recurring-rules-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const describeSchedule = (rule) => {
    const every = rule.interval > 1 ? `every ${rule.interval} ` : 'every ';
    switch (rule.frequency) {
      case 'daily':     return `${every}${rule.interval > 1 ? 'days' : 'day'}`;
      case 'weekly':    return `${every}${rule.interval > 1 ? 'weeks' : 'week'} on ${WEEKDAYS[rule.dayOfWeek ?? 1]}`;
      case 'monthly':   return `${every}${rule.interval > 1 ? 'months' : 'month'} on day ${rule.dayOfMonth || 1}`;
      case 'quarterly': return `${every}${rule.interval > 1 ? 'quarters' : 'quarter'} on day ${rule.dayOfMonth || 1}`;
      case 'yearly':    return `${every}${rule.interval > 1 ? 'years' : 'year'} on day ${rule.dayOfMonth || 1}`;
      default:          return rule.frequency;
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <CalendarSync size={20} className="text-indigo-600" /> Recurring Entries
          </h2>
          <p className="text-xs text-slate-500 mt-1">Automate repetitive journal entries like rent, salaries, or EMIs. Post all due runs in one click.</p>
        </div>
        {partition.due.length > 0 && canEdit && (
          <button
            onClick={postAllDue}
            disabled={posting}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            <Play size={14} /> Post all {partition.due.length} due
          </button>
        )}
        {recurringRules.length > 0 && (
          <button
            onClick={exportXLSX}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            <Download size={14} /> Export XLSX
          </button>
        )}
      </div>

      {/* Form */}
      {canEdit && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-slate-700">{editingId ? 'Edit Rule' : 'New Recurring Rule'}</h3>
            {editingId && <button onClick={resetForm} className="text-xs text-slate-500 hover:underline">Cancel edit</button>}
          </div>

          <div className="mb-3 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 p-2 flex items-center gap-2">
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder='Describe it: "every month on 1st", "every 3 months", "weekly on monday"'
              className="flex-1 rounded-md border border-indigo-200 bg-white px-2 py-1 text-xs"
            />
            <button onClick={applyPhrase} className="rounded-md bg-indigo-600 text-white px-3 py-1 text-xs font-semibold hover:bg-indigo-700">Apply</button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Name</label>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="e.g. Office Rent" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Frequency</label>
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Every N periods</label>
              <input type="number" min="1" value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </div>
            {['monthly', 'quarterly', 'yearly'].includes(form.frequency) && (
              <div>
                <label className="text-[11px] font-semibold text-slate-500 uppercase">Day of Month</label>
                <input type="number" min="1" max="31" value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              </div>
            )}
            {form.frequency === 'weekly' && (
              <div>
                <label className="text-[11px] font-semibold text-slate-500 uppercase">Day of Week</label>
                <select value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                  {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Start Date</label>
              <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">End Date <span className="text-slate-400 font-normal">(optional)</span></label>
              <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Narration</label>
              <input type="text" value={form.narration} onChange={(e) => setForm({ ...form, narration: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="e.g. Office rent - monthly" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Debit Account</label>
              <input list="ru-dr-accounts" value={form.debitAccount} onChange={(e) => setForm({ ...form, debitAccount: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="e.g. Expense:Rent" />
              <datalist id="ru-dr-accounts">{accountOptions.map((a) => <option key={`dr-${a}`} value={a} />)}</datalist>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Credit Account</label>
              <input list="ru-cr-accounts" value={form.creditAccount} onChange={(e) => setForm({ ...form, creditAccount: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="e.g. Cash" />
              <datalist id="ru-cr-accounts">{accountOptions.map((a) => <option key={`cr-${a}`} value={a} />)}</datalist>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase">Amount</label>
              <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
            </label>
            <div className="flex-1" />
            <button onClick={handleSave} className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold hover:bg-indigo-700">
              <Plus size={14} className="inline mr-1" /> {editingId ? 'Update' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Due runs */}
      <RuleSection
        title="Due Now"
        icon={<AlertTriangle size={16} className="text-amber-600" />}
        emptyText="Nothing due. You're all caught up."
        rules={partition.due}
        today={today}
        canEdit={canEdit}
        onPost={postRule}
        onEdit={startEdit}
        onToggle={toggleActive}
        onDelete={(rule) => setDeleteModal({ isOpen: true, rule })}
        describe={describeSchedule}
        posting={posting}
        highlight="amber"
      />

      {/* Upcoming */}
      <RuleSection
        title="Upcoming"
        icon={<CheckCircle size={16} className="text-emerald-600" />}
        emptyText="No upcoming rules."
        rules={partition.upcoming}
        today={today}
        canEdit={canEdit}
        onPost={postRule}
        onEdit={startEdit}
        onToggle={toggleActive}
        onDelete={(rule) => setDeleteModal({ isOpen: true, rule })}
        describe={describeSchedule}
        posting={posting}
        highlight="emerald"
      />

      <ConfirmDeleteModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, rule: null })}
        onConfirm={confirmDelete}
        itemName={deleteModal.rule?.name || 'this rule'}
      />
    </div>
  );
};

const RuleSection = ({ title, icon, emptyText, rules, canEdit, onPost, onEdit, onToggle, onDelete, describe, posting, highlight }) => {
  const headerColor = highlight === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200';
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className={`px-4 py-2 border-b ${headerColor} flex items-center gap-2`}>
        {icon}
        <h3 className="text-sm font-bold text-slate-700">{title} <span className="text-slate-400 font-normal">({rules.length})</span></h3>
      </div>
      {rules.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-slate-400">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Schedule</th>
                <th className="px-3 py-2 text-left">Next Run</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Entries</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-800">{rule.name}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{describe(rule)}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{rule.nextRun || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">{formatCurrency(rule.template?.amount || 0)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    <div>Dr: {rule.template?.debitAccount || '—'}</div>
                    <div>Cr: {rule.template?.creditAccount || '—'}</div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${rule.active === false ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>
                      {rule.active === false ? 'Paused' : 'Active'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right space-x-1">
                    {highlight === 'amber' && canEdit && (
                      <button onClick={() => onPost(rule)} disabled={posting} title="Post due runs" className="inline-flex items-center gap-1 rounded-md bg-indigo-600 text-white px-2 py-1 text-[11px] font-semibold hover:bg-indigo-700 disabled:opacity-50">
                        <Play size={11} /> Post
                      </button>
                    )}
                    {canEdit && (
                      <>
                        <button onClick={() => onToggle(rule)} title={rule.active === false ? 'Resume' : 'Pause'} className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100">
                          {rule.active === false ? 'Resume' : 'Pause'}
                        </button>
                        <button onClick={() => onEdit(rule)} title="Edit" className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100">
                          <Edit size={11} />
                        </button>
                        <button onClick={() => onDelete(rule)} title="Delete" className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">
                          <Trash2 size={11} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default RecurringEntries;
