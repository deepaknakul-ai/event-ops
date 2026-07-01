// Global app assistant (chat UI) — speaks plain English, understands the
// whole rental-ops data model via src/utils/assistant/{nlu,executor}.js.
//
// Mounted from the Dashboard as a floating button + slide-in panel. Writes
// (e.g. expense approvals) are RBAC-checked client-side and executed via
// Firestore updateDoc with an audit log entry.

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { MessageSquare, X, Send, Sparkles, CheckCircle, AlertTriangle } from 'lucide-react';
import { parseAssistantMessage } from '../utils/assistant/nlu';
import { executeAssistantIntent } from '../utils/assistant/executor';
import { applyPendingAction } from '../utils/assistant/writeOps';
import { loadModel, saveModel, recordUsage, topUsedPrompts } from '../utils/assistant/learning';
import { can } from '../utils/permissions';

// Operational quick actions — safe for every role (no money surfaced).
const QUICK_ACTIONS_OPS = [
  "Today's projects",
  'Low stock',
  'Help',
];
// Financial quick actions — only shown to roles that can view reports
// (admin/accountant/manager). Tapping one as tech/user would be blocked anyway.
const QUICK_ACTIONS_FIN = [
  'My pending',
  'Pending expenses',
  'Outstanding receivables',
  'Most profitable projects',
  'Loss-making projects',
  'Top clients by revenue',
  'Tax invoices this month',
  'Expense breakdown this month',
  'P&L',
];

// Intents that surface money, margins, or financial ledgers. These are gated on
// can(role,'reports','view') at execution time so Field Techs / Coordinators
// (tech/user) get an access-restricted card instead of company financials.
const FINANCIAL_INTENTS = new Set([
  'projects.topMargin', 'projects.lossMaking', 'projects.bottomMargin',
  'clients.top', 'client.ledger', 'client.outstanding',
  'finance.receivables', 'finance.payables',
  'vendor.payments', 'payments.pending', 'payments.byDate',
  'taxInvoices.list', 'taxInvoices.byClient',
  'purchaseInvoices.list', 'purchaseInvoices.byVendor',
  'reports.pl', 'reports.revenue', 'reports.expenses', 'reports.cashPosition',
  'employee.balance',
  'expenses.pending', 'expenses.approve', 'expense.disapprove',
  'expenses.byEmployee', 'expenses.byDateRange', 'expenses.byCategory',
  'expenses.byStatus', 'expenses.statistics',
  'digest.myPending', 'payment.record',
]);

// Map intent → row entity type for conversational memory ("#2", "first one").
const INTENT_TO_ROW_TYPE = {
  'projects.today': 'project',
  'projects.thisWeek': 'project',
  'projects.upcoming': 'project',
  'projects.overdue': 'project',
  'projects.byStatus': 'project',
  'projects.byClient': 'project',
  'projects.unbilled': 'project',
  'projects.byDateRange': 'project',
  'projects.details': 'project',
  'employee.projects': 'project',
  'client.list': 'client',
  'client.outstanding': 'client',
  'finance.receivables': 'client',
  'employee.list': 'employee',
  'inventory.low': 'item',
  'inventory.search': 'item',
  'inventory.byCategory': 'item',
  'vendor.payments': 'vendor',
  'finance.payables': 'vendor',
  'purchaseInvoices.byVendor': 'vendor',
};

const fmtINR = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function ResultCard({ result, onApplyAction, applying, role, slots, onSlotChange }) {
  if (!result) return null;
  switch (result.type) {
    case 'error':
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-4 h-4" />{result.title}</div>
          {result.subtitle && <div className="mt-1 text-red-700">{result.subtitle}</div>}
        </div>
      );
    case 'metric':
      return (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{result.title}</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{result.value}</div>
          {result.subtitle && <div className="mt-1 text-xs text-slate-600">{result.subtitle}</div>}
          {result.hint && <div className="mt-2 text-xs italic text-slate-500">{result.hint}</div>}
        </div>
      );
    case 'list':
    case 'help':
      return (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 text-sm font-semibold text-slate-800">{result.title}</div>
          {result.subtitle && <div className="mb-2 text-xs text-slate-600">{result.subtitle}</div>}
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {(result.rows || []).map((r, i) => (
              <div key={r.id || i} className="rounded border border-slate-100 px-2 py-1.5 text-xs hover:bg-slate-50">
                <div className="font-medium text-slate-900">{r.line1}</div>
                {r.line2 && <div className="text-slate-600">{r.line2}</div>}
                {r.line3 && <div className="text-slate-500">{r.line3}</div>}
              </div>
            ))}
            {(result.rows || []).length === 0 && <div className="text-xs italic text-slate-500">No results.</div>}
          </div>
        </div>
      );
    case 'table':
      return (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 text-sm font-semibold text-slate-800">{result.title}</div>
          {result.subtitle && <div className="mb-2 text-xs text-slate-600">{result.subtitle}</div>}
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-500">
                <tr>{(result.columns || []).map((c) => <th key={c.key} className="px-2 py-1 font-medium">{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {(result.rows || []).map((r, i) => (
                  <tr key={r.id || i} className="border-t border-slate-100">
                    {(result.columns || []).map((c) => (
                      <td key={c.key} className="px-2 py-1 text-slate-700">
                        {c.fmt === 'money' ? fmtINR(r[c.key]) : (r[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
                {(result.rows || []).length === 0 && (
                  <tr><td colSpan={(result.columns || []).length} className="px-2 py-3 text-center italic text-slate-500">No results.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'action': {
      const action = result.pendingAction || {};
      const perm = action.perm || ['expenses', 'approve'];
      const canDo = can(role, perm[0], perm[1]);
      const requires = action.requires || [];
      const items = action.items || [];
      const showItems = items.length > 0;
      // Are all required slots filled?
      const missingSlots = requires.filter((s) => {
        const v = slots && slots[s];
        return v == null || String(v).trim() === '';
      });
      const ready = canDo && missingSlots.length === 0;
      return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="text-sm font-semibold text-amber-900">{result.title}</div>
          {result.subtitle && <div className="mt-1 text-xs text-amber-800">{result.subtitle}</div>}
          {action.suggestion && <div className="mt-1 text-xs italic text-amber-700">{action.suggestion}</div>}
          {showItems && (
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
              {items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-2 rounded bg-white/60 px-2 py-1">
                  <span className="truncate">
                    {it.category ? `${it.category} — ` : ''}
                    {it.narration || it.type || it.startDate || '—'}
                  </span>
                  {it.amount != null && <span className="font-mono">{fmtINR(it.amount)}</span>}
                </li>
              ))}
            </ul>
          )}
          {requires.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2">
              {requires.includes('amount') && (
                <input
                  type="number" min="0" step="0.01"
                  placeholder="Amount (₹)"
                  value={(slots && slots.amount) || ''}
                  onChange={(e) => onSlotChange('amount', e.target.value)}
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-xs"
                />
              )}
              {requires.includes('mode') && (
                <select
                  value={(slots && slots.mode) || (action.defaults && action.defaults.mode) || 'Bank Transfer'}
                  onChange={(e) => onSlotChange('mode', e.target.value)}
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-xs"
                >
                  <option>Bank Transfer</option>
                  <option>UPI</option>
                  <option>Cash</option>
                  <option>Cheque</option>
                  <option>Card</option>
                </select>
              )}
              {requires.includes('date') && (
                <input
                  type="date"
                  value={(slots && slots.date) || (action.defaults && action.defaults.date) || ''}
                  onChange={(e) => onSlotChange('date', e.target.value)}
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-xs"
                />
              )}
              {requires.includes('reason') && (
                <textarea
                  rows={2}
                  placeholder="Reason (required)"
                  value={(slots && slots.reason) || ''}
                  onChange={(e) => onSlotChange('reason', e.target.value)}
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-xs"
                />
              )}
            </div>
          )}
          {!canDo ? (
            <div className="mt-2 text-xs text-red-700">You don&apos;t have permission to perform this action.</div>
          ) : (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={!ready || applying}
                onClick={onApplyAction}
                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <CheckCircle className="w-3.5 h-3.5" />{applying ? 'Applying…' : 'Confirm & apply'}
              </button>
              {missingSlots.length > 0 && (
                <span className="self-center text-[11px] italic text-amber-700">Fill: {missingSlots.join(', ')}</span>
              )}
            </div>
          )}
        </div>
      );
    }
    case 'text':
      return <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{result.title}</div>;
    case 'detail':
      return (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-sm font-semibold text-slate-900">{result.title}</div>
          {result.subtitle && <div className="mt-0.5 text-xs text-slate-600">{result.subtitle}</div>}
          <dl className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {(result.rows || []).map((r, i) => (
              <div key={i} className="flex flex-col rounded border border-slate-100 px-2 py-1">
                <dt className="text-[10px] uppercase tracking-wide text-slate-500">{r.label}</dt>
                <dd className="text-slate-800">{r.value || '—'}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    default:
      return null;
  }
}

export default function AppAssistant({
  isOpen, onClose,
  projects = [], clients = [], employees = [], expenses = [],
  payments = [], payouts = [], vendorPayments = [],
  taxInvoices = [], purchaseInvoices = [],
  inventory = [], journalEntries = [], hrLeaves = [],
  role, db, appId, logAction, addToast, currentUserId,
}) {
  const [messages, setMessages] = useState(() => ([
    { id: 'welcome', role: 'assistant', type: 'help', content: null, ts: Date.now() },
  ]));
  const [input, setInput] = useState('');
  const [applyingId, setApplyingId] = useState(null);
  const [slotsByMsg, setSlotsByMsg] = useState({}); // { [msgId]: { amount, mode, date, reason, ... } }
  // Conversational memory (Phase 3): track last entities + last result rows so
  // anaphora ("it", "that", "#2", "first one") can be resolved by the NLU.
  // Reset whenever the panel closes.
  const [memory, setMemory] = useState({ lastEntities: {}, lastResultRows: [], lastIntent: null });
  // Long-term learning: per-user phrase → intent map, persisted to localStorage.
  // The NLU consults this to recover known phrasings; we add to it on every
  // successful (non-error) interaction and on user corrections.
  const [learning, setLearning] = useState(() => loadModel(currentUserId));
  useEffect(() => { setLearning(loadModel(currentUserId)); }, [currentUserId]);
  const scrollerRef = useRef(null);

  const nluCtx = useMemo(() => {
    const isVendor = (c) => String(c.type || '').toLowerCase().includes('vendor');
    return {
      clientNames: (clients || []).filter((c) => !isVendor(c)).map((c) => c.name).filter(Boolean),
      vendorNames: (clients || []).filter((c) => isVendor(c)).map((c) => c.name).filter(Boolean),
      employeeNames: (employees || []).map((e) => e.name).filter(Boolean),
      inventoryNames: (inventory || []).map((i) => i.name).filter(Boolean),
      projectNames: (projects || []).map((p) => p.project_name).filter(Boolean),
    };
  }, [clients, employees, inventory, projects]);

  const execCtx = useMemo(() => ({
    projects, clients, employees, expenses,
    payments, payouts, vendorPayments,
    taxInvoices, purchaseInvoices,
    inventory, journalEntries, hrLeaves,
  }), [projects, clients, employees, expenses, payments, payouts, vendorPayments, taxInvoices, purchaseInvoices, inventory, journalEntries, hrLeaves]);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages, isOpen]);

  // Reset memory when the panel closes so a new conversation starts clean.
  useEffect(() => {
    if (!isOpen) setMemory({ lastEntities: {}, lastResultRows: [], lastIntent: null });
  }, [isOpen]);

  const runPrompt = useCallback((text) => {
    const prompt = String(text || '').trim();
    if (!prompt) return;
    const parsed = parseAssistantMessage(prompt, nluCtx, memory, learning);
    // Zero-Trust gate: financial intents are limited to report-viewing roles
    // (admin/accountant/manager). tech/user never see company money via the
    // assistant, regardless of how the question is phrased.
    let result;
    if (FINANCIAL_INTENTS.has(parsed.intent) && !can(role, 'reports', 'view')) {
      result = {
        type: 'error',
        title: 'Access restricted',
        subtitle: 'Financial details are limited to management. You can ask about projects, schedules, inventory, or your own tasks.',
      };
    } else {
      result = executeAssistantIntent(parsed, execCtx);
    }
    // Help message uses structured help card.
    if (parsed.intent === 'help' && result.type === 'help') {
      // ok
    }
    // For welcome placeholder rendering.
    if (result.type === 'help' && !result.rows) result = executeAssistantIntent({ intent: 'help', entities: {}, issues: [] }, execCtx);
    const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setMessages((prev) => [
      ...prev,
      { id: `u_${id}`, role: 'user', content: prompt, ts: Date.now() },
      { id, role: 'assistant', result, parsed, ts: Date.now() },
    ]);
    // Update conversational memory: merge new entities; capture rows of list/detail
    // results so follow-up prompts like "open #2" or "confirm it" work.
    setMemory((prev) => {
      const nextEntities = { ...(prev.lastEntities || {}), ...(parsed.entities || {}) };
      // Strip transient slots that should not persist (dates, status, category).
      delete nextEntities.dateRange;
      delete nextEntities.status;
      delete nextEntities.category;
      const rowType = INTENT_TO_ROW_TYPE[parsed.intent] || null;
      const rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      const lastResultRows = rowType
        ? rows.slice(0, 20).map((r) => ({ id: r.id, name: r.line1 || r.name || '', type: rowType }))
        : prev.lastResultRows;
      return { lastEntities: nextEntities, lastResultRows, lastIntent: parsed.intent };
    });
    // Long-term learning: record the prompt → intent mapping when we got a
    // useful, non-error answer. Errors and 'unknown' are intentionally skipped
    // so we don't reinforce bad parses.
    if (parsed.intent && parsed.intent !== 'unknown' && result && result.type !== 'error') {
      setLearning((prev) => {
        const next = recordUsage(prev, { text: prompt, intent: parsed.intent, ctx: nluCtx });
        saveModel(currentUserId, next);
        return next;
      });
    }
  }, [nluCtx, execCtx, memory, learning, currentUserId, role]);

  // Report-viewing roles (admin/accountant/manager) get the financial quick
  // actions; tech/user get operational ones only.
  const quickActions = useMemo(
    () => (can(role, 'reports', 'view') ? [...QUICK_ACTIONS_OPS, ...QUICK_ACTIONS_FIN] : QUICK_ACTIONS_OPS),
    [role],
  );

  const handleSubmit = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    runPrompt(input);
    setInput('');
  };

  const applyAction = useCallback(async (msg) => {
    const action = msg?.result?.pendingAction;
    if (!action) return;
    setApplyingId(msg.id);
    try {
      const res = await applyPendingAction(
        { db, appId },
        action,
        { logAction, role, currentUserId, slots: slotsByMsg[msg.id] || {} },
      );
      addToast && addToast(res.summary || 'Done.', 'success');
      setMessages((prev) => prev.map((m) => m.id === msg.id
        ? { ...m, result: { type: 'text', title: res.summary || 'Done.' } }
        : m));
      // Clean up any slot state for this message.
      setSlotsByMsg((prev) => { const n = { ...prev }; delete n[msg.id]; return n; });
    } catch (err) {
      const code = err && err.code;
      const msgText = code === 'permission-denied'
        ? 'Access denied for this action.'
        : code === 'missing-slot'
          ? err.message
          : `Failed: ${err.message}`;
      addToast && addToast(msgText, 'error');
    } finally {
      setApplyingId(null);
    }
  }, [db, appId, logAction, role, currentUserId, addToast, slotsByMsg]);

  const setSlot = useCallback((msgId, key, value) => {
    setSlotsByMsg((prev) => ({ ...prev, [msgId]: { ...(prev[msgId] || {}), [key]: value } }));
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-end bg-black/30 sm:items-center sm:justify-end sm:p-4" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:h-[90vh] sm:max-h-[720px] sm:w-[440px] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">App Assistant</div>
              <div className="text-[11px] text-slate-500">Ask anything in plain English</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3">
          {messages.map((m) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white shadow-sm">
                    {m.content}
                  </div>
                </div>
              );
            }
            const res = m.result || executeAssistantIntent({ intent: 'help', entities: {}, issues: [] }, execCtx);
            return (
              <div key={m.id} className="flex">
                <div className="w-full max-w-full">
                  <ResultCard
                    result={res}
                    applying={applyingId === m.id}
                    role={role}
                    slots={slotsByMsg[m.id] || {}}
                    onSlotChange={(k, v) => setSlot(m.id, k, v)}
                    onApplyAction={() => applyAction(m)}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-slate-200 bg-white p-2">
          <div className="mb-2 flex flex-wrap gap-1">
            {quickActions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => runPrompt(q)}
                className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
              >
                {q}
              </button>
            ))}
            {topUsedPrompts(learning, { limit: 4, minCount: 2 }).map((q) => (
              <button
                key={`learned-${q.text}`}
                type="button"
                onClick={() => runPrompt(q.text)}
                title={`You've used this ${q.count} times`}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] text-indigo-700 hover:bg-indigo-100"
              >
                {q.text.length > 32 ? q.text.slice(0, 30) + '…' : q.text}
              </button>
            ))}
          </div>
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. Show ledger of ACME"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Floating trigger button — mount separately so Dashboard controls placement. */
export function AppAssistantLauncher({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Ask the assistant"
      aria-label="Open assistant"
      className="fixed bottom-20 right-4 sm:bottom-5 sm:right-5 z-[110] flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg transition hover:scale-105 hover:shadow-xl"
    >
      <MessageSquare className="w-6 h-6" />
    </button>
  );
}
