import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, where } from 'firebase/firestore';
import { Target, Plus, Phone, Mail, Calendar, TrendingUp, Edit, Trash2, ArrowRightCircle, AlertTriangle } from 'lucide-react';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import { notify } from '../utils/toast';
import { can } from '../utils/permissions';
import { formatCurrency, fmtDate } from '../utils/helpers';

const STATUSES = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];
const SOURCES = ['Referral', 'Website', 'Call', 'Walk-in', 'Repeat Client', 'Social', 'Other'];
const colHead = {
  New: 'bg-slate-100 text-slate-600', Contacted: 'bg-blue-100 text-blue-700', Quoted: 'bg-amber-100 text-amber-700',
  Won: 'bg-emerald-100 text-emerald-700', Lost: 'bg-red-100 text-red-600',
};

const blankLead = () => ({ name: '', contact_name: '', phone: '', email: '', source: 'Referral', status: 'New', est_value: '', event_date: '', venue: '', follow_up_date: '', notes: '' });

const Leads = ({ role = 'manager', db, appId, currentEmpId, logAction }) => {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankLead());
  const [del, setDel] = useState({ isOpen: false, lead: null });
  const canEdit = can(role, 'leads', 'create');

  useEffect(() => {
    if (!db) return undefined;
    // A manager sees ONLY their own leads (rule-enforced by created_by); admin +
    // accountant see all. The scoped query is required once the rule restricts reads.
    const col = collection(db, 'artifacts', appId, 'public', 'data', 'leads');
    const q = role === 'manager' ? query(col, where('created_by', '==', currentEmpId)) : col;
    const unsub = onSnapshot(q, (snap) => {
      setLeads(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, () => {});
    return unsub;
  }, [db, appId, role, currentEmpId]);

  const openAdd = () => { setEditingId(null); setForm(blankLead()); setIsOpen(true); };
  const openEdit = (l) => { setEditingId(l.id); setForm({ ...blankLead(), ...l }); setIsOpen(true); };

  const save = async () => {
    if (!form.name.trim()) return notify('Lead / company name is required.', 'error');
    const payload = { ...form, est_value: parseFloat(form.est_value) || 0, updated_at: new Date().toISOString() };
    try {
      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', editingId), payload);
        logAction?.('leads', 'update', editingId, {}, form.name);
      } else {
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'leads'), { ...payload, created_at: new Date().toISOString(), created_by: currentEmpId || '' });
        logAction?.('leads', 'create', ref.id, {}, form.name);
      }
      notify(editingId ? 'Lead updated.' : 'Lead added.', 'success');
      setIsOpen(false);
    } catch (e) { notify('Save failed: ' + (e?.message || 'error'), 'error'); }
  };

  const moveStatus = async (l, status) => {
    try { await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', l.id), { status, updated_at: new Date().toISOString() }); }
    catch (e) { notify('Update failed: ' + (e?.message || 'error'), 'error'); }
  };

  const remove = async () => {
    if (!del.lead) return;
    try { await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', del.lead.id)); logAction?.('leads', 'delete', del.lead.id, {}, del.lead.name); notify('Lead deleted.', 'success'); }
    catch (e) { notify('Delete failed: ' + (e?.message || 'error'), 'error'); }
    setDel({ isOpen: false, lead: null });
  };

  const convert = async (l) => {
    try {
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), {
        project_name: l.name, client_id: '', status: 'Quoted', invoice_status: 'Not Invoiced',
        start_date: l.event_date || '', end_date: l.event_date || '', setup_date: '', venue: l.venue || '',
        items: [], assigned_employees: [], logistics_costs: {}, package_cost: 0, package_cost_gst: 18,
        remarks: `Converted from lead. Contact: ${l.contact_name || ''} ${l.phone || ''}. Est. value: ${l.est_value || 0}.${l.notes ? ' ' + l.notes : ''}`,
        from_lead_id: l.id, created_at: new Date().toISOString(), created_by: currentEmpId || '',
      });
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', l.id), { status: 'Won', converted_project_id: ref.id, updated_at: new Date().toISOString() });
      logAction?.('leads', 'convert', l.id, { project_id: ref.id }, l.name);
      notify('Converted to a Quoted project — add client & items.', 'success');
      navigate(`/projects/${ref.id}`);
    } catch (e) { notify('Convert failed: ' + (e?.message || 'error'), 'error'); }
  };

  const todayIso = new Date().toISOString().slice(0, 10);
  const byStatus = useMemo(() => {
    const m = Object.fromEntries(STATUSES.map((s) => [s, []]));
    leads.forEach((l) => { (m[l.status] || m.New).push(l); });
    return m;
  }, [leads]);

  const stats = useMemo(() => {
    const open = leads.filter((l) => !['Won', 'Lost'].includes(l.status));
    const won = leads.filter((l) => l.status === 'Won').length;
    const lost = leads.filter((l) => l.status === 'Lost').length;
    const pipeline = open.reduce((s, l) => s + (parseFloat(l.est_value) || 0), 0);
    const overdue = open.filter((l) => l.follow_up_date && l.follow_up_date < todayIso).length;
    return { pipeline, winRate: (won + lost) ? Math.round((won / (won + lost)) * 100) : 0, open: open.length, won, overdue };
  }, [leads, todayIso]);

  if (!can(role, 'leads', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to the CRM.</div>;

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Target size={20} className="text-indigo-600" /> Leads / CRM</h2>
        {canEdit && <button onClick={openAdd} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Plus size={16} /> Add Lead</button>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Open Pipeline" value={formatCurrency(stats.pipeline)} icon={<TrendingUp size={16} className="text-indigo-500" />} />
        <Card label="Open Leads" value={stats.open} icon={<Target size={16} className="text-slate-500" />} />
        <Card label="Win Rate" value={`${stats.winRate}%`} icon={<TrendingUp size={16} className="text-emerald-500" />} />
        <Card label="Follow-ups Overdue" value={stats.overdue} icon={<AlertTriangle size={16} className="text-amber-500" />} amber={stats.overdue > 0} />
      </div>

      {/* Kanban */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {STATUSES.map((s) => (
          <div key={s} className="rounded-xl border border-slate-200 bg-slate-50/50">
            <div className={`flex items-center justify-between rounded-t-xl px-3 py-2 text-xs font-bold uppercase tracking-wide ${colHead[s]}`}>
              <span>{s}</span><span>{byStatus[s].length}</span>
            </div>
            <div className="space-y-2 p-2">
              {byStatus[s].length === 0 && <div className="px-2 py-4 text-center text-xs text-slate-300">—</div>}
              {byStatus[s].map((l) => {
                const overdue = l.follow_up_date && l.follow_up_date < todayIso && !['Won', 'Lost'].includes(l.status);
                return (
                  <div key={l.id} className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
                    <div className="flex items-start justify-between gap-1">
                      <div className="truncate text-sm font-semibold text-slate-800">{l.name}</div>
                      {l.est_value > 0 && <div className="shrink-0 text-xs font-medium text-emerald-600">{formatCurrency(l.est_value)}</div>}
                    </div>
                    {l.contact_name && <div className="mt-0.5 text-xs text-slate-500">{l.contact_name}</div>}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                      {l.phone && <span className="flex items-center gap-0.5"><Phone size={10} /> {l.phone}</span>}
                      {l.source && <span>{l.source}</span>}
                      {l.event_date && <span className="flex items-center gap-0.5"><Calendar size={10} /> {fmtDate(l.event_date)}</span>}
                    </div>
                    {l.follow_up_date && <div className={`mt-1 text-[11px] ${overdue ? 'font-semibold text-red-500' : 'text-slate-400'}`}>Follow-up: {fmtDate(l.follow_up_date)}{overdue ? ' (overdue)' : ''}</div>}
                    {canEdit && (
                      <div className="mt-2 flex items-center gap-1 border-t border-slate-100 pt-2">
                        <select value={l.status} onChange={(e) => moveStatus(l, e.target.value)} className="flex-1 rounded border border-slate-200 px-1 py-1 text-[11px] text-slate-600">
                          {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                        {!['Won', 'Lost'].includes(l.status) && <button onClick={() => convert(l)} title="Convert to Quote" className="rounded p-1 text-indigo-600 hover:bg-indigo-50"><ArrowRightCircle size={15} /></button>}
                        <button onClick={() => openEdit(l)} title="Edit" className="rounded p-1 text-slate-500 hover:bg-slate-100"><Edit size={14} /></button>
                        {can(role, 'leads', 'delete') && <button onClick={() => setDel({ isOpen: true, lead: l })} title="Delete" className="rounded p-1 text-red-500 hover:bg-red-50"><Trash2 size={14} /></button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title={editingId ? 'Edit Lead' : 'Add Lead'}>
        <div className="space-y-3">
          <Field label="Lead / Company Name *"><input className="inp" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Contact Person"><input className="inp" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></Field>
            <Field label="Phone"><input className="inp" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email"><input className="inp" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Source"><select className="inp" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Estimated Value (Rs.)"><input type="number" className="inp" value={form.est_value} onChange={(e) => setForm({ ...form, est_value: e.target.value })} /></Field>
            <Field label="Status"><select className="inp" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Event Date"><input type="date" className="inp" value={form.event_date} onChange={(e) => setForm({ ...form, event_date: e.target.value })} /></Field>
            <Field label="Follow-up Date"><input type="date" className="inp" value={form.follow_up_date} onChange={(e) => setForm({ ...form, follow_up_date: e.target.value })} /></Field>
            <Field label="Venue"><input className="inp" value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><textarea rows={3} className="inp" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <button onClick={save} className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">{editingId ? 'Update Lead' : 'Add Lead'}</button>
        </div>
      </Modal>

      <ConfirmDeleteModal isOpen={del.isOpen} onClose={() => setDel({ isOpen: false, lead: null })} onConfirm={remove} title="Delete Lead" message={`Delete lead "${del.lead?.name}"? This cannot be undone.`} />
      <style>{`.inp{width:100%;border:1px solid #cbd5e1;border-radius:0.5rem;padding:0.5rem;font-size:0.875rem;background:#fff;color:#000}`}</style>
    </div>
  );
};

const Card = ({ label, value, icon, amber }) => (
  <div className={`rounded-xl border p-4 ${amber ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">{icon} {label}</div>
    <div className="mt-1 text-lg font-bold text-slate-800">{value}</div>
  </div>
);
const Field = ({ label, children }) => (<div><label className="mb-1 block text-xs font-semibold text-slate-600">{label}</label>{children}</div>);

export default Leads;
