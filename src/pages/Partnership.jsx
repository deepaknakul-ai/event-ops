import React, { useMemo, useState } from 'react';
import { doc, setDoc, updateDoc, addDoc, collection } from 'firebase/firestore';
import {
  Users, ShieldCheck, Vote, PieChart, Plus, CheckCircle2, XCircle,
  PenLine, AlertTriangle, FileSignature, Wallet,
} from 'lucide-react';
import { Modal } from '../components/Shared';
import { formatCurrency, getFYFromDate, round2 } from '../utils/helpers';
import { can } from '../utils/permissions';
import { assertFYNotLocked } from '../utils/fyLock';
import {
  activePartners, partnershipActive, isNamedPartner, computeConsentOutcome,
  pendingActionId, isDualSigned,
} from '../utils/partnership';
import { MAX_INTEREST_RATE } from '../utils/partnershipAppropriation';

/**
 * PARTNERSHIP — the firm's governance home.
 *
 *  Overview    — partner share report: capital, drawings, appropriations (s.13(b))
 *  Approvals   — spend counter-approvals + two-partner sign-off requests
 *  Resolutions — consent register (s.12(c): ordinary = majority, fundamental = all)
 *  Partners    — the registry (admin manages; governance changes need dual-sign
 *                once the partnership is active — the Owner alone cannot rewrite it)
 *
 * Approval POWER comes from being a NAMED partner in settings/partnership — not
 * from the role. The `partner` ROLE is for principals whose only function is
 * partner: full books read, approval writes, no data entry.
 */
const Partnership = ({
  db, appId, role, currentEmpId, user, logAction, addToast,
  orgSettings, partnership, pendingActions = [], partnerConsents = [],
  employees = [], chartOfAccounts = [], journalEntries = [], openingBalances = [],
  fiscalYearClosings = [], vendorPayments = [], expenses = [], lockedFYs = [],
}) => {
  const [tab, setTab] = useState('overview');
  const [partnerModal, setPartnerModal] = useState(null); // {empId?} editing / {} new
  const [consentModal, setConsentModal] = useState(false);
  const [drawingModal, setDrawingModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const amPartner = isNamedPartner(partnership, currentEmpId);
  const active = partnershipActive(orgSettings, partnership);
  const partners = activePartners(partnership);
  const isManager = can(role, 'partnership', 'manage');
  const sPath = (...segs) => ['artifacts', appId, 'public', 'data', ...segs];

  // ── Governance write helper: settings/partnership is dual-sign-locked once
  //    the partnership is ACTIVE. Surface that instead of a raw error. ────────
  const governanceSigned = isDualSigned(pendingActions.find(a => a.id === 'partnership_settings'));
  const savePartnershipDoc = async (next, label) => {
    try {
      await setDoc(doc(db, ...sPath('settings', 'partnership')), next, { merge: true });
      logAction('admin', 'partnership_update', 'partnership', { label }, label);
      return true;
    } catch (e) {
      if (active && !governanceSigned) {
        addToast('Governance change blocked: once the partnership is active, changing the registry needs TWO partner signatures. Raise a "Governance change" sign-off request in Approvals first.', 'error');
      } else {
        addToast('Could not save: ' + e.message, 'error');
      }
      return false;
    }
  };

  // ── Partner registry save (admin) ─────────────────────────────────────────
  const blankPartner = { empId: '', profit_share: 50, interest_on_capital_rate: 12, is_working_partner: true, remuneration_annual: 0, active: true };
  const [pForm, setPForm] = useState(blankPartner);

  const nextCoaCode = (base) => {
    const used = new Set(chartOfAccounts.map(a => String(a.code || a.id)));
    for (let i = 1; i <= 20; i++) { const c = String(base + i); if (!used.has(c)) return c; }
    return String(base + Math.floor(Math.random() * 900) + 21);
  };

  const savePartner = async () => {
    if (!isManager) return;
    const emp = employees.find(e => e.id === pForm.empId);
    if (!emp) return addToast('Pick the employee who is this partner.', 'error');
    setSaving(true);
    try {
      const existing = partnership?.partners?.[pForm.empId] || {};
      let capId = existing.capital_account_id;
      let drwId = existing.drawings_account_id;
      // Per-partner equity accounts (s.13 capital + drawings), tagged with
      // partner_id so reports can group the ledger by partner.
      if (!capId) {
        capId = nextCoaCode(3100);
        await setDoc(doc(db, ...sPath('chart_of_accounts', capId)), {
          code: capId, name: `Capital — ${emp.name}`, type: 'Equity', normalSide: 'Cr',
          isSystem: false, isActive: true, partner_id: pForm.empId,
          created_by: user?.uid || '', created_at: new Date().toISOString(),
        }, { merge: true });
      }
      if (!drwId) {
        drwId = nextCoaCode(3110);
        await setDoc(doc(db, ...sPath('chart_of_accounts', drwId)), {
          code: drwId, name: `Drawings — ${emp.name}`, type: 'Equity', normalSide: 'Dr',
          isSystem: false, isActive: true, partner_id: pForm.empId,
          created_by: user?.uid || '', created_at: new Date().toISOString(),
        }, { merge: true });
      }
      const nextPartners = {
        ...(partnership?.partners || {}),
        [pForm.empId]: {
          name: emp.name,
          profit_share: Number(pForm.profit_share) || 0,
          interest_on_capital_rate: Math.min(Number(pForm.interest_on_capital_rate) || 0, MAX_INTEREST_RATE),
          is_working_partner: !!pForm.is_working_partner,
          remuneration_annual: Number(pForm.remuneration_annual) || 0,
          capital_account_id: capId, drawings_account_id: drwId,
          active: pForm.active !== false,
          joined_at: existing.joined_at || new Date().toISOString(),
        },
      };
      const activeCount = Object.values(nextPartners).filter(p => p.active !== false).length;
      const ok = await savePartnershipDoc(
        { partners: nextPartners, min_partners_met: activeCount >= 2 },
        `Partner saved: ${emp.name}`);
      if (ok) {
        addToast(`Partner ${emp.name} saved.${activeCount >= 2 ? '' : ' Add a second active partner to switch the controls on.'}`, 'success');
        setPartnerModal(null);
      }
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
    setSaving(false);
  };

  const shareTotal = partners.reduce((s, [, p]) => s + (Number(p.profit_share) || 0), 0);

  // ── Ledger math for the share report ──────────────────────────────────────
  // Capital/drawings movements live in: opening_balances (FY rollover / manual
  // opening) + journal_entries legs hitting the partner's named accounts
  // (appropriation vouchers, drawings, capital introduced by JV).
  const partnerLedger = useMemo(() => {
    const byPartner = {};
    const nameOf = {};
    chartOfAccounts.forEach(a => { if (a.partner_id) nameOf[a.name] = { pid: a.partner_id, side: a.normalSide }; });
    const ensure = (pid) => (byPartner[pid] = byPartner[pid] || { opening: 0, credits: 0, drawings: 0 });
    (openingBalances || []).forEach(ob => {
      const hit = nameOf[ob.account_name];
      if (!hit) return;
      const amt = Number(ob.amount) || 0;
      const signed = String(ob.side || 'Cr').toUpperCase() === 'CR' ? amt : -amt;
      ensure(hit.pid).opening = round2(ensure(hit.pid).opening + signed);
    });
    (journalEntries || []).forEach(j => {
      if (j.status === 'cancelled') return;
      (j.entries || []).forEach(leg => {
        const amt = Number(leg.amount) || 0;
        if (!(amt > 0)) return;
        const drHit = nameOf[leg.debitAccount];
        const crHit = nameOf[leg.creditAccount];
        if (crHit) {
          // credit to a Capital account grows it; credit to Drawings offsets
          if (crHit.side === 'Cr') ensure(crHit.pid).credits = round2(ensure(crHit.pid).credits + amt);
          else ensure(crHit.pid).drawings = round2(ensure(crHit.pid).drawings - amt);
        }
        if (drHit) {
          if (drHit.side === 'Dr') ensure(drHit.pid).drawings = round2(ensure(drHit.pid).drawings + amt);
          else ensure(drHit.pid).credits = round2(ensure(drHit.pid).credits - amt);
        }
      });
    });
    return byPartner;
  }, [chartOfAccounts, openingBalances, journalEntries]);

  // ── Spend approvals queue ─────────────────────────────────────────────────
  const pendingSpends = useMemo(() => ([
    ...vendorPayments.filter(v => v.partner_approval_status === 'pending')
      .map(v => ({ kind: 'vendor_payment', id: v.id, who: v.vendor_name, amount: v.amount, date: v.date, creator: v.created_by_emp, doc: v })),
    ...expenses.filter(x => x.partner_approval_status === 'pending')
      .map(x => ({ kind: 'expense', id: x.id, who: employees.find(e => e.id === x.employee_id)?.name || x.employee_id, amount: x.amount, date: x.date, creator: x.employee_id, doc: x })),
  ]), [vendorPayments, expenses, employees]);

  const decideSpend = async (item, decision) => {
    if (!amPartner) return addToast('Only a named partner can decide this.', 'error');
    if (item.creator === currentEmpId) return addToast('You cannot approve your own spend — another partner must.', 'error');
    const col = item.kind === 'vendor_payment' ? 'vendor_payments' : 'expenses';
    try {
      await updateDoc(doc(db, ...sPath(col, item.id)), {
        partner_approval_status: decision,
        partner_approved_by: currentEmpId,
        partner_approved_at: new Date().toISOString(),
        ...(decision === 'rejected' ? { partner_rejection_reason: 'Rejected by partner' } : {}),
      });
      logAction(col, `partner_${decision}`, item.id, { amount: item.amount }, `${decision} ${formatCurrency(item.amount)} (${item.who})`);
      addToast(`${decision === 'approved' ? 'Approved' : 'Rejected'}.`, 'success');
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };

  // ── Dual-sign requests ────────────────────────────────────────────────────
  const openSignRequests = pendingActions.filter(a => !a.consumed);
  const raiseAction = async (type, key, note) => {
    const id = pendingActionId(type, key);
    try {
      await setDoc(doc(db, ...sPath('pending_actions', id)), {
        type, key: String(key), note: note || '',
        initiated_by: currentEmpId,
        sig1: amPartner ? { emp: currentEmpId, at: new Date().toISOString() } : null,
        sig2: null,
        created_at: new Date().toISOString(),
      });
      logAction('admin', 'raise_dual_sign', id, { type }, `Sign-off requested: ${type} ${key}`);
      addToast('Sign-off request raised' + (amPartner ? ' (your signature recorded — one more partner must sign).' : '.'), 'success');
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };
  const signAction = async (a) => {
    if (!amPartner) return addToast('Only a named partner can sign.', 'error');
    const patch = !a.sig1?.emp
      ? { sig1: { emp: currentEmpId, at: new Date().toISOString() } }
      : (!a.sig2?.emp && a.sig1.emp !== currentEmpId
        ? { sig2: { emp: currentEmpId, at: new Date().toISOString() } }
        : null);
    if (!patch) return addToast(a.sig1?.emp === currentEmpId ? 'You already signed — a DIFFERENT partner must counter-sign.' : 'Already fully signed.', 'info');
    try {
      await updateDoc(doc(db, ...sPath('pending_actions', a.id)), patch);
      logAction('admin', 'sign_dual_sign', a.id, {}, `Signed: ${a.type}`);
      addToast('Signed.', 'success');
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };

  // ── Consent register ──────────────────────────────────────────────────────
  const [cForm, setCForm] = useState({ title: '', description: '', category: 'ordinary' });
  const proposeConsent = async () => {
    if (!amPartner) return addToast('Only a named partner can propose a resolution.', 'error');
    if (!cForm.title.trim()) return addToast('Give the resolution a title.', 'error');
    try {
      await addDoc(collection(db, ...sPath('partner_consents')), {
        title: cForm.title.trim(), description: cForm.description.trim(),
        category: cForm.category, proposed_by: currentEmpId,
        proposed_at: new Date().toISOString(), status: 'open',
      });
      logAction('admin', 'propose_consent', 'partner_consents', { title: cForm.title }, cForm.title);
      addToast('Resolution proposed — partners can now vote.', 'success');
      setConsentModal(false); setCForm({ title: '', description: '', category: 'ordinary' });
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };
  const castVote = async (c, vote) => {
    if (!amPartner) return addToast('Only a named partner votes.', 'error');
    try {
      await updateDoc(doc(db, ...sPath('partner_consents', c.id)), {
        [`vote_${currentEmpId}`]: { vote, at: new Date().toISOString() },
      });
      logAction('admin', 'consent_vote', c.id, { vote }, `${vote} on: ${c.title}`);
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };
  const closeConsent = async (c, status) => {
    try {
      await updateDoc(doc(db, ...sPath('partner_consents', c.id)), {
        status, closed_at: new Date().toISOString(), closed_by: currentEmpId,
      });
      logAction('admin', 'consent_close', c.id, { status }, `${status}: ${c.title}`);
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };

  // ── Drawings (admin/accountant post the voucher; partner is not data entry) ─
  const [dForm, setDForm] = useState({ partnerId: '', amount: '', mode: 'Bank', date: new Date().toISOString().split('T')[0], narration: '' });
  const recordDrawing = async () => {
    if (!can(role, 'finance', 'create')) return addToast('Only Admin/Accountant can post a drawing voucher.', 'error');
    const p = partnership?.partners?.[dForm.partnerId];
    if (!p) return addToast('Pick the partner.', 'error');
    const amt = parseFloat(dForm.amount);
    if (!(amt > 0)) return addToast('Enter the amount.', 'error');
    if (!assertFYNotLocked(dForm.date, lockedFYs)) return;
    const drawingsAcc = chartOfAccounts.find(a => String(a.code || a.id) === String(p.drawings_account_id));
    if (!drawingsAcc) return addToast('This partner has no Drawings account — re-save them in the registry first.', 'error');
    try {
      await addDoc(collection(db, ...sPath('journal_entries')), {
        voucher_no: `PD-${Date.now().toString().slice(-6)}`,
        fy: getFYFromDate(dForm.date), date: dForm.date,
        narration: dForm.narration || `Partner drawing — ${p.name}`,
        source: 'partner_drawing', partner_id: dForm.partnerId, status: 'posted',
        entries: [{ debitAccount: drawingsAcc.name, creditAccount: dForm.mode === 'Cash' ? 'Cash' : 'Bank', amount: round2(amt) }],
        created_by: user?.uid || '', created_at: new Date().toISOString(),
      });
      logAction('journal_entries', 'partner_drawing', dForm.partnerId, { amount: amt }, `Drawing ${formatCurrency(amt)} — ${p.name}`);
      addToast('Drawing recorded.', 'success');
      setDrawingModal(false); setDForm({ ...dForm, amount: '', narration: '' });
    } catch (e) { addToast('Error: ' + e.message, 'error'); }
  };

  if (orgSettings && orgSettings.firm_type !== 'partnership') {
    return (
      <div className="max-w-2xl mx-auto mt-10 rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <Users size={36} className="mx-auto text-slate-300 mb-3" />
        <h2 className="text-lg font-bold text-slate-800">This firm is a {orgSettings.firm_type || 'proprietorship'}</h2>
        <p className="mt-2 text-sm text-slate-500">Partnership features (partner registry, approvals, consent register, profit appropriation) activate when the firm is constituted as a partnership.</p>
        {isManager && (
          <button
            onClick={async () => {
              await setDoc(doc(db, ...sPath('settings', 'organization')), { firm_type: 'partnership' }, { merge: true });
              await setDoc(doc(db, ...sPath('settings', 'partnership')), { enabled: true, min_partners_met: false, approval_threshold: 50000, partners: {} }, { merge: true });
              logAction('admin', 'set_firm_type', 'organization', { firm_type: 'partnership' }, 'Converted to partnership');
              addToast('Converted to partnership — add your partners below.', 'success');
            }}
            className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
            Convert to Partnership
          </button>
        )}
      </div>
    );
  }

  const TABS = [
    { id: 'overview', label: 'Share Report', icon: PieChart },
    { id: 'approvals', label: 'Approvals', icon: ShieldCheck, badge: pendingSpends.length + openSignRequests.filter(a => !isDualSigned(a)).length },
    { id: 'resolutions', label: 'Resolutions', icon: Vote, badge: partnerConsents.filter(c => c.status === 'open').length },
    { id: 'partners', label: 'Partners', icon: Users },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-800">Partnership</h2>
        <div className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
          {active ? `Active — ${partners.length} partners · approvals ON` : 'Setup — controls activate at 2 active partners'}
        </div>
      </div>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit max-w-full overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition ${tab === t.id ? 'bg-white shadow-sm font-semibold text-indigo-700' : 'text-slate-600 hover:text-slate-800'}`}>
            <t.icon size={15} /> {t.label}
            {t.badge > 0 && <span className="ml-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5">{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* ═══ SHARE REPORT ═══ */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {partners.map(([pid, p]) => {
              const led = partnerLedger[pid] || { opening: 0, credits: 0, drawings: 0 };
              const closing = round2(led.opening + led.credits - led.drawings);
              return (
                <div key={pid} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold text-slate-800 truncate">{p.name}</div>
                    <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5 shrink-0">{p.profit_share}%</span>
                  </div>
                  <div className="mt-3 space-y-1 text-xs text-slate-600">
                    <div className="flex justify-between"><span>Opening capital</span><span className="font-mono">{formatCurrency(led.opening)}</span></div>
                    <div className="flex justify-between"><span>Credited (profit/interest/capital)</span><span className="font-mono text-emerald-700">{formatCurrency(led.credits)}</span></div>
                    <div className="flex justify-between"><span>Drawings</span><span className="font-mono text-red-600">−{formatCurrency(led.drawings)}</span></div>
                    <div className="flex justify-between border-t border-slate-100 pt-1 font-bold text-slate-800"><span>Closing capital</span><span className="font-mono">{formatCurrency(closing)}</span></div>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    {p.is_working_partner ? `Working partner · remuneration ${formatCurrency(p.remuneration_annual || 0)}/yr` : 'Non-working partner'} · interest {p.interest_on_capital_rate || 0}%
                  </div>
                </div>
              );
            })}
            {partners.length === 0 && (
              <div className="sm:col-span-2 lg:col-span-4 text-center py-8 rounded-xl border border-dashed border-slate-300 text-slate-400 text-sm">
                No partners yet — add them in the Partners tab.
              </div>
            )}
          </div>

          {/* Equity split bar */}
          {partners.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-bold text-slate-500 uppercase mb-2">Profit-sharing ratio {shareTotal !== 100 && <span className="text-amber-600 normal-case font-semibold">(sums to {shareTotal}% — shares are normalised)</span>}</div>
              <div className="flex h-6 w-full overflow-hidden rounded-lg border border-slate-200">
                {partners.map(([pid, p], i) => (
                  <div key={pid} title={`${p.name} ${p.profit_share}%`}
                    className={`h-full text-[10px] font-bold text-white flex items-center justify-center ${['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500', 'bg-rose-500'][i % 5]}`}
                    style={{ width: `${(Number(p.profit_share) || 0) / (shareTotal || 1) * 100}%` }}>
                    {p.name.split(' ')[0]}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Drawings action */}
          {can(role, 'finance', 'create') && partners.length > 0 && (
            <button onClick={() => setDrawingModal(true)} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Wallet size={15} /> Record Partner Drawing
            </button>
          )}

          {/* Past appropriations */}
          {fiscalYearClosings.filter(f => f.appropriation).length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 overflow-x-auto">
              <div className="text-xs font-bold text-slate-500 uppercase mb-2">Year-end appropriations (s.40(b))</div>
              <table className="w-full text-xs">
                <thead className="text-left text-slate-400 uppercase"><tr><th className="py-1 pr-3">FY</th><th className="py-1 pr-3">Partner</th><th className="py-1 pr-3 text-right">Interest</th><th className="py-1 pr-3 text-right">Remuneration</th><th className="py-1 pr-3 text-right">Profit share</th><th className="py-1 text-right">Total</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {fiscalYearClosings.filter(f => f.appropriation).flatMap(f =>
                    Object.entries(f.appropriation.perPartner || {}).map(([pid, row]) => (
                      <tr key={`${f.fy}_${pid}`}>
                        <td className="py-1.5 pr-3 font-mono">{f.fy}</td>
                        <td className="py-1.5 pr-3">{row.name}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{formatCurrency(row.interest)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{formatCurrency(row.remuneration)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{formatCurrency(row.share)}</td>
                        <td className="py-1.5 text-right font-mono font-bold">{formatCurrency(row.total)}</td>
                      </tr>
                    )))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══ APPROVALS ═══ */}
      {tab === 'approvals' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs font-bold text-slate-500 uppercase mb-3">Spend awaiting partner approval {partnership?.approval_threshold > 0 && <span className="normal-case font-normal">(above {formatCurrency(partnership.approval_threshold)})</span>}</div>
            {pendingSpends.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-4">Nothing waiting. Spends above the threshold appear here for a second partner&apos;s sign-off.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {pendingSpends.map(item => (
                  <div key={`${item.kind}_${item.id}`} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{formatCurrency(item.amount)} — {item.who}</div>
                      <div className="text-xs text-slate-400">{item.kind === 'vendor_payment' ? 'Vendor payment' : 'Expense'} · {item.date || '—'} · raised by {employees.find(e => e.id === item.creator)?.name || item.creator || '—'}</div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => decideSpend(item, 'approved')}
                        disabled={!amPartner || item.creator === currentEmpId}
                        title={item.creator === currentEmpId ? 'You raised this — another partner must approve' : ''}
                        className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40">
                        <CheckCircle2 size={13} /> Approve
                      </button>
                      <button onClick={() => decideSpend(item, 'rejected')}
                        disabled={!amPartner || item.creator === currentEmpId}
                        className="flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 disabled:opacity-40">
                        <XCircle size={13} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-xs font-bold text-slate-500 uppercase">Two-partner sign-off requests</div>
              {(amPartner || isManager) && (
                <button onClick={() => raiseAction('partnership_settings', 'current', 'Governance change (registry / threshold / firm type)')}
                  className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                  <FileSignature size={13} /> Raise governance sign-off
                </button>
              )}
            </div>
            {openSignRequests.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-4">No open requests. FY close, invoice cancellation and governance changes each need two partners&apos; signatures here first.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {openSignRequests.map(a => {
                  const done = isDualSigned(a);
                  return (
                    <div key={a.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                          {a.type === 'fy_close' ? `Close FY ${a.key}` : a.type === 'invoice_cancel' ? `Cancel invoice ${a.note || a.key}` : 'Governance change'}
                          {done && <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">FULLY SIGNED</span>}
                        </div>
                        <div className="text-xs text-slate-400">
                          Sig 1: {a.sig1?.emp ? (partnership?.partners?.[a.sig1.emp]?.name || a.sig1.emp) : '—'} · Sig 2: {a.sig2?.emp ? (partnership?.partners?.[a.sig2.emp]?.name || a.sig2.emp) : '—'}
                        </div>
                      </div>
                      {!done && (
                        <button onClick={() => signAction(a)} disabled={!amPartner || a.sig1?.emp === currentEmpId}
                          title={a.sig1?.emp === currentEmpId ? 'A DIFFERENT partner must counter-sign' : ''}
                          className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                          <PenLine size={13} /> Sign
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ RESOLUTIONS ═══ */}
      {tab === 'resolutions' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500 max-w-xl">Ordinary matters pass by <b>majority</b> of partners; fundamental changes (nature of the business, admitting a partner) need <b>every</b> partner&apos;s consent — s.12(c) &amp; s.31, Partnership Act 1932.</p>
            {amPartner && (
              <button onClick={() => setConsentModal(true)} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                <Plus size={15} /> Propose Resolution
              </button>
            )}
          </div>
          {partnerConsents.length === 0 ? (
            <div className="text-center py-10 rounded-xl border border-dashed border-slate-300 text-slate-400 text-sm">No resolutions recorded yet.</div>
          ) : (
            <div className="space-y-3">
              {[...partnerConsents].sort((a, b) => (b.proposed_at || '').localeCompare(a.proposed_at || '')).map(c => {
                const o = computeConsentOutcome(c, partnership);
                const myVote = c[`vote_${currentEmpId}`]?.vote;
                const isOpen = c.status === 'open';
                return (
                  <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-800 flex items-center gap-2">
                          {c.title}
                          <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 border ${c.category === 'fundamental' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{c.category}</span>
                          <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 border ${c.status === 'open' ? 'bg-amber-50 text-amber-700 border-amber-200' : c.status === 'passed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-600 border-red-200'}`}>{c.status}</span>
                        </div>
                        {c.description && <div className="mt-1 text-xs text-slate-500">{c.description}</div>}
                        <div className="mt-1 text-[11px] text-slate-400">
                          Proposed by {partnership?.partners?.[c.proposed_by]?.name || c.proposed_by} · {o.yes} yes / {o.no} no / {o.pending} pending · needs {o.needed} of {o.total}
                        </div>
                      </div>
                      {isOpen && (
                        <div className="flex flex-wrap gap-2">
                          {amPartner && (
                            <>
                              <button onClick={() => castVote(c, 'yes')} className={`rounded-lg px-3 py-1.5 text-xs font-bold border ${myVote === 'yes' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'}`}>Yes{myVote === 'yes' ? ' ✓' : ''}</button>
                              <button onClick={() => castVote(c, 'no')} className={`rounded-lg px-3 py-1.5 text-xs font-bold border ${myVote === 'no' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-600 border-red-300 hover:bg-red-50'}`}>No{myVote === 'no' ? ' ✓' : ''}</button>
                            </>
                          )}
                          {(o.outcome === 'passed' || o.outcome === 'rejected') && (amPartner || isManager) && (
                            <button onClick={() => closeConsent(c, o.outcome)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700">Record outcome: {o.outcome}</button>
                          )}
                          {c.proposed_by === currentEmpId && (
                            <button onClick={() => closeConsent(c, 'withdrawn')} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50">Withdraw</button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ PARTNERS (registry) ═══ */}
      {tab === 'partners' && (
        <div className="space-y-4">
          {active && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>The partnership is ACTIVE: registry changes (partners, shares, threshold) now need a dual-signed <b>governance sign-off</b> (Approvals tab) before saving — the Owner alone cannot rewrite the deed&apos;s terms. {governanceSigned && <b>A signed governance request is in place — changes will save.</b>}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-slate-500">Approval threshold: <b>{partnership?.approval_threshold > 0 ? formatCurrency(partnership.approval_threshold) : 'not set'}</b> — spends above it need a second partner.</div>
            {isManager && (
              <div className="flex gap-2">
                <button onClick={async () => {
                  const v = prompt('Partner-approval threshold (₹). Spends above this need a second partner. 0 disables.', String(partnership?.approval_threshold ?? 50000));
                  if (v == null) return;
                  const n = Math.max(0, parseFloat(v) || 0);
                  const ok = await savePartnershipDoc({ approval_threshold: n }, `Threshold → ${n}`);
                  if (ok) addToast('Threshold saved.', 'success');
                }} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">Set threshold</button>
                <button onClick={() => { setPForm(blankPartner); setPartnerModal({}); }} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Plus size={15} /> Add Partner</button>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr><th className="p-3">Partner</th><th className="p-3 text-right">Share %</th><th className="p-3 text-right">Interest %</th><th className="p-3">Working</th><th className="p-3 text-right">Remuneration/yr</th><th className="p-3">Status</th>{isManager && <th className="p-3"></th>}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.entries(partnership?.partners || {}).map(([pid, p]) => (
                  <tr key={pid} className={p.active === false ? 'opacity-50' : ''}>
                    <td className="p-3 font-semibold text-slate-800">{p.name}<div className="text-[10px] font-normal text-slate-400">Capital a/c {p.capital_account_id || '—'} · Drawings a/c {p.drawings_account_id || '—'}</div></td>
                    <td className="p-3 text-right font-mono">{p.profit_share}%</td>
                    <td className="p-3 text-right font-mono">{p.interest_on_capital_rate || 0}%</td>
                    <td className="p-3">{p.is_working_partner ? 'Yes' : 'No'}</td>
                    <td className="p-3 text-right font-mono">{formatCurrency(p.remuneration_annual || 0)}</td>
                    <td className="p-3">{p.active === false ? <span className="text-xs text-slate-400">Retired</span> : <span className="text-xs font-bold text-emerald-600">Active</span>}</td>
                    {isManager && (
                      <td className="p-3 text-right">
                        <button onClick={() => { setPForm({ empId: pid, ...p }); setPartnerModal({ empId: pid }); }} className="text-xs font-semibold text-indigo-600 hover:underline">Edit</button>
                      </td>
                    )}
                  </tr>
                ))}
                {Object.keys(partnership?.partners || {}).length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-slate-400 text-sm">No partners registered. Each partner must first exist as an employee (give principals the <b>Partner</b> role in Employees), then be added here with their profit share.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {shareTotal !== 100 && partners.length > 0 && (
            <div className="text-xs text-amber-600">Shares sum to {shareTotal}% — appropriation normalises them, but 100% is cleaner.</div>
          )}
        </div>
      )}

      {/* ── Partner modal ── */}
      <Modal isOpen={!!partnerModal} onClose={() => setPartnerModal(null)} title={partnerModal?.empId ? 'Edit Partner' : 'Add Partner'}>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-slate-700">Employee (identity of the partner)</label>
            <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={pForm.empId}
              disabled={!!partnerModal?.empId}
              onChange={e => setPForm(f => ({ ...f, empId: e.target.value }))}>
              <option value="">-- select --</option>
              {employees.filter(e => !e.is_locked).map(e => <option key={e.id} value={e.id}>{e.name} ({e.role})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="text-xs font-bold text-slate-700">Profit share %</label>
              <input type="number" min="0" max="100" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={pForm.profit_share} onChange={e => setPForm(f => ({ ...f, profit_share: e.target.value }))} /></div>
            <div><label className="text-xs font-bold text-slate-700">Interest on capital % (max 12 — s.40(b)(iv))</label>
              <input type="number" min="0" max="12" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={pForm.interest_on_capital_rate} onChange={e => setPForm(f => ({ ...f, interest_on_capital_rate: e.target.value }))} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-700 pt-5">
              <input type="checkbox" checked={!!pForm.is_working_partner} onChange={e => setPForm(f => ({ ...f, is_working_partner: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
              Working partner (eligible for remuneration)
            </label>
            <div><label className="text-xs font-bold text-slate-700">Remuneration ₹/year (40(b) limits apply at close)</label>
              <input type="number" min="0" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={pForm.remuneration_annual} onChange={e => setPForm(f => ({ ...f, remuneration_annual: e.target.value }))} disabled={!pForm.is_working_partner} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={pForm.active !== false} onChange={e => setPForm(f => ({ ...f, active: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
            Active partner (untick on retirement — history is kept)
          </label>
          <button onClick={savePartner} disabled={saving} className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Partner'}
          </button>
        </div>
      </Modal>

      {/* ── Consent modal ── */}
      <Modal isOpen={consentModal} onClose={() => setConsentModal(false)} title="Propose a Resolution">
        <div className="space-y-3">
          <div><label className="text-xs font-bold text-slate-700">Title</label>
            <input className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={cForm.title} onChange={e => setCForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Open a branch office in Mumbai" /></div>
          <div><label className="text-xs font-bold text-slate-700">Description</label>
            <textarea rows={3} className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={cForm.description} onChange={e => setCForm(f => ({ ...f, description: e.target.value }))} /></div>
          <div>
            <label className="text-xs font-bold text-slate-700">Category</label>
            <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={cForm.category} onChange={e => setCForm(f => ({ ...f, category: e.target.value }))}>
              <option value="ordinary">Ordinary — majority of partners decides (s.12(c))</option>
              <option value="fundamental">Fundamental — needs EVERY partner (nature of business, new partner — s.31)</option>
            </select>
          </div>
          <button onClick={proposeConsent} className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">Propose</button>
        </div>
      </Modal>

      {/* ── Drawing modal ── */}
      <Modal isOpen={drawingModal} onClose={() => setDrawingModal(false)} title="Record Partner Drawing">
        <div className="space-y-3">
          <p className="text-xs text-slate-500">Posts <b>Dr Drawings — Partner / Cr Bank(Cash)</b> to the books. Drawings reduce the partner&apos;s closing capital in the share report.</p>
          <div>
            <label className="text-xs font-bold text-slate-700">Partner</label>
            <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={dForm.partnerId} onChange={e => setDForm(f => ({ ...f, partnerId: e.target.value }))}>
              <option value="">-- select --</option>
              {partners.map(([pid, p]) => <option key={pid} value={pid}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div><label className="text-xs font-bold text-slate-700">Amount ₹</label>
              <input type="number" min="0" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={dForm.amount} onChange={e => setDForm(f => ({ ...f, amount: e.target.value }))} /></div>
            <div><label className="text-xs font-bold text-slate-700">Paid from</label>
              <select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={dForm.mode} onChange={e => setDForm(f => ({ ...f, mode: e.target.value }))}>
                <option>Bank</option><option>Cash</option>
              </select></div>
            <div><label className="text-xs font-bold text-slate-700">Date</label>
              <input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={dForm.date} onChange={e => setDForm(f => ({ ...f, date: e.target.value }))} /></div>
          </div>
          <div><label className="text-xs font-bold text-slate-700">Narration</label>
            <input className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={dForm.narration} onChange={e => setDForm(f => ({ ...f, narration: e.target.value }))} placeholder="optional" /></div>
          <button onClick={recordDrawing} className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">Post Drawing</button>
        </div>
      </Modal>
    </div>
  );
};

export default Partnership;
