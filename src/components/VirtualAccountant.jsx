import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { X, Sparkles, Send, Check, Edit3, RotateCcw, AlertTriangle, Info, Mic, MicOff, HelpCircle, BookmarkPlus } from 'lucide-react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '../utils/helpers';
import { parseMessage, validateTransaction, canPost, canDispatch, issueSummary, auditFromIssues, computeTdsYtdForParty, learnFromEntries, NEW_PARTY_PREFIX, normalizeAliasKey, pickPartyOption } from '../utils/aiAccountant';
import { aiAvailable, aiExtractEntry } from '../utils/aiParse';

// Web Speech API (prefix-agnostic). Returns null when unsupported.
const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

// NLP, amount/party extraction, intent classification, and message parsing
// live in `src/utils/aiAccountant/`. This component is a thin UI shell.
const QUICK_ACTIONS = [
  { label: 'Received payment', text: 'received from ' },
  { label: 'Paid vendor', text: 'paid to ' },
  { label: 'Raised invoice', text: 'invoice ' },
  { label: 'Made purchase', text: 'bought from ' },
  { label: 'Paid salary', text: 'salary ' },
  { label: 'Bank deposit', text: 'deposit to bank ' },
  { label: 'Expense', text: 'spent on ' },
];

const HELP_EXAMPLES = [
  'Acme Corp paid us 50000',
  'got 1.5 lakh from client ABC',
  'transferred 20k to Vendor XYZ via NEFT',
  'invoice 1,50,000 for Client ABC',
  'salary 30000 to Rahul',
  'spent 5000 on office supplies',
  'bought equipment for 80000 from SuppliCo',
  'deposited 1 lakh in bank',
  'withdrew 50k from bank',
  'tds 10000 deducted by Acme',
  'rent 25000',
  'credit note 5000 for Client ABC',
  'advance 15000 to Raj',
];

// Short-scale tick for Y axis (1.2L / 75k / 900) and full-currency tooltip.
const shortTick = (v) => {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
};
const tooltipFormatter = (value, name) => [formatCurrency(Number(value) || 0), name];

const TYPE_LABELS = {
  receipt: 'Payment Receipt',
  payment: 'Payment Made',
  invoice: 'Sales Invoice',
  purchase: 'Purchase',
  salary: 'Salary',
  expense: 'Expense',
  bank_deposit: 'Bank Deposit',
  bank_withdrawal: 'Bank Withdrawal',
  tds: 'TDS Entry',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  advance: 'Advance',
  reimbursement: 'Employee Reimbursement',
};

// Entry Preview Card
const EntryPreview = ({ msg, onPost, onPark, onCancel, onEdit, onAskAi, editingEntry, setEditingEntry, allAccounts }) => {
  const { parsed, status } = msg;
  const totalAmount = parsed.entries.reduce((s, e) => s + e.amount, 0);
  const { errors, warnings, infos } = issueSummary(parsed);
  const hasErrors = errors > 0;

  // Audit Agent — the draft was already validated at parse time, so score it from
  // its issues (no re-validation). Severity + fix-hints + an audit score come back;
  // the Orchestrator's per-draft "safe" gate decides the ready/needs-review banner.
  const audit = auditFromIssues(parsed);
  const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 1;
  const auditReady = canPost(parsed) && !audit.blocking && audit.auditScore >= 70 && conf >= 0.55;

  const badgeFor = (sev) => ({
    blocking: 'bg-red-50 border-red-200 text-red-700',
    warning:  'bg-amber-50 border-amber-200 text-amber-700',
    advisory: 'bg-blue-50 border-blue-200 text-blue-700',
  }[sev] || 'bg-slate-50 border-slate-200 text-slate-700');
  const iconFor = (sev) => sev === 'advisory'
    ? <Info size={12} className="shrink-0" />
    : <AlertTriangle size={12} className="shrink-0" />;

  const statusColor = {
    pending: hasErrors ? 'border-red-200 bg-red-50/40' : 'border-indigo-200 bg-white',
    posting: 'border-amber-200 bg-amber-50',
    posted: 'border-green-200 bg-green-50',
    parked: 'border-indigo-300 bg-indigo-50',
    cancelled: 'border-slate-200 bg-slate-50 opacity-60',
    error: 'border-red-200 bg-red-50',
  }[status] || 'border-slate-200 bg-white';

  const typeKey = parsed.type || parsed.intent;

  return (
    <div className={`max-w-[95%] rounded-2xl rounded-bl-md border-2 ${statusColor} px-4 py-3 shadow-sm space-y-2`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-indigo-600">
          {TYPE_LABELS[typeKey] || 'Journal Entry'}
          {String(parsed.model || '').startsWith('llm:') && (
            <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold text-violet-700 normal-case tracking-normal">
              <Sparkles size={9} /> AI
            </span>
          )}
          {typeof parsed.confidence === 'number' && (
            <span className="ml-2 text-[9px] font-semibold text-slate-400">
              conf {Math.round(parsed.confidence * 100)}%
            </span>
          )}
        </p>
        {status === 'posted' && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">POSTED</span>}
        {status === 'cancelled' && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-500">CANCELLED</span>}
        {status === 'posting' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 animate-pulse">POSTING...</span>}
        {status === 'pending' && (errors + warnings + infos > 0) && (
          <span className="text-[10px] font-semibold text-slate-500">
            {errors > 0 && <span className="text-red-600">{errors} err</span>}
            {errors > 0 && (warnings + infos > 0) && ' · '}
            {warnings > 0 && <span className="text-amber-600">{warnings} warn</span>}
            {warnings > 0 && infos > 0 && ' · '}
            {infos > 0 && <span className="text-blue-600">{infos} info</span>}
          </span>
        )}
      </div>

      <p className="text-sm text-slate-700">{parsed.narration}</p>

      <div className="rounded-lg bg-slate-50 border border-slate-200 divide-y divide-slate-200 text-xs">
        <div className="grid grid-cols-12 gap-1 px-3 py-1.5 font-bold uppercase text-[10px] text-slate-400">
          <div className="col-span-5">Account</div>
          <div className="col-span-3 text-right text-green-600">Debit</div>
          <div className="col-span-3 text-right text-red-600">Credit</div>
          <div className="col-span-1"></div>
        </div>
        {parsed.entries.map((entry, i) => (
          <React.Fragment key={i}>
            <div className="grid grid-cols-12 gap-1 px-3 py-1.5 items-center">
              <div className="col-span-5">
                {editingEntry?.messageId === msg.id && editingEntry?.entryIndex === i && editingEntry?.field === 'debitAccount' ? (
                  <select autoFocus value={entry.debitAccount} onChange={e => onEdit(i, 'debitAccount', e.target.value)} onBlur={() => setEditingEntry(null)} className="w-full rounded border border-indigo-300 bg-white px-1 py-0.5 text-xs">
                    {allAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                    {!allAccounts.includes(entry.debitAccount) && <option value={entry.debitAccount}>{entry.debitAccount}</option>}
                  </select>
                ) : (
                  <span className={`font-semibold text-slate-800 ${status === 'pending' ? 'cursor-pointer hover:text-indigo-600' : ''}`} onClick={() => status === 'pending' && setEditingEntry({ messageId: msg.id, entryIndex: i, field: 'debitAccount' })}>
                    {entry.debitAccount}
                  </span>
                )}
              </div>
              <div className="col-span-3 text-right">
                {editingEntry?.messageId === msg.id && editingEntry?.entryIndex === i && editingEntry?.field === 'amount' ? (
                  <input autoFocus type="number" value={entry.amount} onChange={e => onEdit(i, 'amount', e.target.value)} onBlur={() => setEditingEntry(null)} onKeyDown={e => e.key === 'Enter' && setEditingEntry(null)} className="w-full rounded border border-indigo-300 bg-white px-1 py-0.5 text-xs text-right" />
                ) : (
                  <span className={`font-mono font-semibold text-green-700 ${status === 'pending' ? 'cursor-pointer hover:text-green-900' : ''}`} onClick={() => status === 'pending' && setEditingEntry({ messageId: msg.id, entryIndex: i, field: 'amount' })}>
                    {formatCurrency(entry.amount)}
                  </span>
                )}
              </div>
              <div className="col-span-3 text-right text-slate-300">-</div>
              <div className="col-span-1"></div>
            </div>
            <div className="grid grid-cols-12 gap-1 px-3 py-1.5 items-center bg-white/50">
              <div className="col-span-5 pl-4">
                {editingEntry?.messageId === msg.id && editingEntry?.entryIndex === i && editingEntry?.field === 'creditAccount' ? (
                  <select autoFocus value={entry.creditAccount} onChange={e => onEdit(i, 'creditAccount', e.target.value)} onBlur={() => setEditingEntry(null)} className="w-full rounded border border-indigo-300 bg-white px-1 py-0.5 text-xs">
                    {allAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                    {!allAccounts.includes(entry.creditAccount) && <option value={entry.creditAccount}>{entry.creditAccount}</option>}
                  </select>
                ) : (
                  <span className={`text-slate-600 ${status === 'pending' ? 'cursor-pointer hover:text-indigo-600' : ''}`} onClick={() => status === 'pending' && setEditingEntry({ messageId: msg.id, entryIndex: i, field: 'creditAccount' })}>
                    To: {entry.creditAccount}
                  </span>
                )}
              </div>
              <div className="col-span-3 text-right text-slate-300">-</div>
              <div className="col-span-3 text-right font-mono font-semibold text-red-600">{formatCurrency(entry.amount)}</div>
              <div className="col-span-1 text-center">
                {status === 'pending' && <button onClick={() => setEditingEntry({ messageId: msg.id, entryIndex: i, field: 'debitAccount' })} className="text-slate-300 hover:text-indigo-500"><Edit3 size={10} /></button>}
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>

      <div className="flex justify-between items-center text-xs">
        <span className="text-slate-400">Click any account or amount to edit</span>
        <span className="font-bold text-slate-600">Total: {formatCurrency(totalAmount)}</span>
      </div>

      {status === 'pending' && (
        <div
          className={`flex items-center justify-between rounded-md border px-2 py-1 text-[11px] ${auditReady ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}
          title="Audit Agent verdict — deterministic check before you post"
        >
          <span className="inline-flex items-center gap-1 font-semibold">
            {auditReady ? <Check size={12} className="shrink-0" /> : <AlertTriangle size={12} className="shrink-0" />}
            {auditReady ? 'Audit passed — ready to post' : 'Audit flagged — review before posting'}
          </span>
          <span className="font-mono text-[10px] opacity-80">audit {audit.auditScore}/100</span>
        </div>
      )}

      {status === 'pending' && audit.findings.length > 0 && (
        <div className="space-y-1 pt-1">
          {audit.findings.map((f, i) => (
            <div key={i} className={`flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] ${badgeFor(f.severity)}`}>
              {iconFor(f.severity)}
              <span>
                {f.message}
                {f.fix && <span className="block text-[10px] opacity-80 mt-0.5">→ {f.fix}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {status === 'pending' && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onPost}
            disabled={hasErrors}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-white transition shadow-sm ${hasErrors ? 'bg-slate-300 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'}`}
          >
            <Check size={14} /> {hasErrors ? 'Fix errors to post' : 'Post Entry'}
          </button>
          {onPark && (
            <button
              onClick={onPark}
              title="Save as draft — does not hit the ledger"
              className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 transition"
            >
              <BookmarkPlus size={12} /> Park
            </button>
          )}
          {onAskAi && (
            <button
              onClick={onAskAi}
              title="Not what you meant? Let the AI accountant interpret this message instead"
              className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-white px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-50 transition"
            >
              <Sparkles size={12} /> Ask AI
            </button>
          )}
          <button onClick={onCancel} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition">
            <X size={12} /> Cancel
          </button>
        </div>
      )}
      {status === 'parked' && (
        <div className="flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700">
          <BookmarkPlus size={12} /> Parked as draft — review and post from Accounts → All Entries tab.
        </div>
      )}
      {status === 'error' && (
        <button onClick={onPost} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700 transition">
          <RotateCcw size={12} /> Retry
        </button>
      )}
    </div>
  );
};

// Main Chat Component
const VirtualAccountant = ({
  isOpen,
  onClose,
  allAccounts = [],
  onPostEntry,
  onReverse,
  onQuery,
  onParkEntry,
  partyNames = [],
  // Phase-1 validator context (all optional for backwards-compat):
  closedFYs = [],
  recentJournalEntries = [],
  getFY,
  // Phase-2/3 grounding (all optional for backwards-compat):
  orgGstin = '',
  partyGstins = {},      // { 'party name (lower)': 'GSTIN' }
  projectNames = [],
  employeeNames = [],    // for employee-reimbursement detection (never grounded as a vendor/client)
  // LLM escalation (settings/ai_public.enabled — the key itself never reaches the client):
  aiEnabled = false,
}) => {
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      type: 'text',
      content: 'Hey! I am your accounting assistant. Tell me what happened in any way you like and I will create the journal entry.\n\nExamples:\n- "Acme Corp paid us 50000"\n- "transferred 20k to vendor XYZ via NEFT"\n- "spent 5000 on office supplies"\n- "got 1.5 lakh from client"\n\nI understand flexible phrasing, amounts like 50k/1.5L, and bank/UPI/cash modes!',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [editingEntry, setEditingEntry] = useState(null);
  const [drillTarget, setDrillTarget] = useState(null); // { title, rows: [{account, amount, voucher_no, date, narration}] }
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const openDrill = useCallback((pointData, seriesKey, seriesLabel) => {
    if (!pointData || !pointData._breakdown) return;
    const rows = pointData._breakdown[seriesKey] || [];
    if (rows.length === 0) return;
    const label = seriesLabel || seriesKey || 'Breakdown';
    setDrillTarget({ title: `${label} — ${pointData[ 'x'] || pointData.x || ''}`, rows });
  }, []);

  const learned = useMemo(() => learnFromEntries(recentJournalEntries || []), [recentJournalEntries]);
  const ctx = useMemo(
    () => ({ partyNames, allAccounts, learned, orgGstin, partyGstins, projectNames, employeeNames }),
    [partyNames, allAccounts, learned, orgGstin, partyGstins, projectNames, employeeNames]
  );
  const validatorCtx = useMemo(() => ({
    knownAccounts: allAccounts,
    closedFYs,
    recentJournalEntries,
    getFY,
  }), [allAccounts, closedFYs, recentJournalEntries, getFY]);

  // Per-transaction compliance context — feeds the (previously dormant)
  // GSTIN / TDS / cash-cap checks in compliance.js. partyGstin is resolved from
  // the parsed party; tdsSection comes from the rulebook stamp on meta.
  const buildValidatorCtx = useCallback((raw) => {
    const partyName = String(raw?.party?.name || '').toLowerCase();
    const partyGstin = partyName ? (partyGstins[partyName] || '') : '';
    // Real YTD payments to this party this FY (basis for the section-wise annual
    // TDS threshold, e.g. 194C's ₹1L aggregate). Best-effort from posted entries.
    const fy = typeof getFY === 'function' ? getFY(raw?.date || new Date().toISOString().slice(0, 10)) : '';
    return {
      ...validatorCtx,
      partyGstin,
      tdsSection: raw?.meta?.tdsSection || undefined,
      tdsYtdAmount: computeTdsYtdForParty(recentJournalEntries, raw?.party?.name || '', fy),
    };
  }, [validatorCtx, partyGstins, recentJournalEntries, getFY]);

  // Multi-turn session memory: remember the last party / mode / project so
  // follow-ups like "…and 5k cab for the same job" or "paid them 10k more" inherit context.
  const sessionRef = useRef({ party: '', partyType: '', mode: null, project: '' });
  // Clarify corrections this session: normalized typed phrase → chosen party.
  // Consulted by parseMessage so the same phrase doesn't re-ask.
  const aliasRef = useRef({});
  // LLM escalation state: transient typing-style indicator while the Cloud
  // Function runs, plus a session cache so a "not configured" answer doesn't
  // trigger a failed round-trip on every message.
  const [isThinking, setIsThinking] = useState(false);
  const aiNotConfiguredRef = useRef(false);
  const aiUsable = () => aiAvailable({ aiEnabled }) && !aiNotConfiguredRef.current;

  // Escalate a message the rule engine couldn't parse to the aiExtractEntry
  // Cloud Function. The result is a DRAFT: it goes through the exact same
  // validateTransaction → EntryPreview → human-confirm path as rule output.
  const escalateToAi = async (text) => {
    setIsThinking(true);
    try {
      // ctx (parse memo) lacks getFY — it's a separate prop; the AI context
      // uses it to tell the model the current financial year.
      const hydrated = await aiExtractEntry(text, { ...ctx, getFY, sessionAliases: aliasRef.current });
      const parsed = validateTransaction({ ...hydrated, type: hydrated.intent }, buildValidatorCtx(hydrated));
      updateSession(parsed);
      addMessage({ role: 'assistant', type: 'entry_preview', content: parsed.narration, parsed, status: 'pending' });
    } catch (err) {
      const msg = err?.message || 'AI assist failed.';
      // Session-disable on anything an admin must fix in settings (disabled,
      // missing key, invalid key) — retrying per message would only burn a
      // failed provider round-trip each time.
      if (/not enabled|no API key|not configured|API key is invalid/i.test(msg)) aiNotConfiguredRef.current = true;
      addMessage({ role: 'assistant', type: 'text', content: `AI assist: ${msg}\n\nYou can still type structured entries like "got 50000 from Acme" or "paid 20k to vendor XYZ".` });
    } finally {
      setIsThinking(false);
    }
  };

  // "Ask AI" chip on a low-confidence rule preview: cancel the rule draft and
  // re-run the same prompt through the LLM.
  const handleAskAi = async (messageId) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.status !== 'pending' || isThinking) return;
    const prompt = msg.parsed?.rawPrompt || '';
    if (!prompt) return;
    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, status: 'cancelled' } : m));
    await escalateToAi(prompt);
  };
  const ANAPHORA_PARTY_RE = /\b(same|them|they|him|her|it|that\s+(party|client|vendor|guy|firm|company))\b/i;
  const ANAPHORA_PROJECT_RE = /\b(same\s+(job|project|site|event)|for\s+the\s+same)\b/i;

  // Voice input state
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  useEffect(() => {
    if (!SpeechRecognitionImpl) return;
    const rec = new SpeechRecognitionImpl();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-IN';
    rec.onresult = (evt) => {
      const transcript = Array.from(evt.results).map((r) => r[0].transcript).join(' ').trim();
      if (transcript) setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    rec.onend = () => setIsListening(false);
    rec.onerror = () => setIsListening(false);
    recognitionRef.current = rec;
    return () => { try { rec.abort(); } catch { /* noop */ } };
  }, []);
  const toggleVoice = () => {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (isListening) { try { rec.stop(); } catch { /* noop */ } setIsListening(false); return; }
    try { rec.start(); setIsListening(true); } catch { setIsListening(false); }
  };

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);
  useEffect(() => { if (isOpen) setTimeout(() => inputRef.current?.focus(), 200); }, [isOpen]);

  const addMessage = (msg) => {
    setMessages(prev => [...prev, { ...msg, id: `msg-${Date.now()}-${Math.random()}`, timestamp: new Date() }]);
  };

  // Non-committal answers to a party clarify — re-ask instead of merging them
  // into the message text (which would corrupt the proposed new-party name).
  const NONCOMMITTAL_RE = /^(yes|yeah|yep|ya|y|haan|han|ji|no|nope|nah|na|nahi|n|ok|okay|hmm+|sure|correct|right)$/i;

  // Remember the resolved party / mode / project from a parsed transaction so
  // subsequent anaphoric messages ("the same job", "pay them more") can inherit.
  const updateSession = (parsed) => {
    if (!parsed) return;
    const name = parsed.party?.name;
    if (name && parsed.party?.type !== 'internal' && parsed.party?.type !== 'unknown') {
      sessionRef.current.party = name;
      sessionRef.current.partyType = parsed.party.type;
    }
    if (parsed.mode) sessionRef.current.mode = parsed.mode;
    if (parsed.meta?.projectTag) sessionRef.current.project = parsed.meta.projectTag;
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isThinking) return;

    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last?.type === 'clarify') {
      addMessage({ role: 'user', type: 'text', content: text });
      setInput('');
      await handleClarifyAnswer(last.baseText || '', text, last.parsed?.meta || null, { appendUserEcho: false });
      return;
    }

    addMessage({ role: 'user', type: 'text', content: text });
    setInput('');

    if (/^(help|what can you do|commands|how|examples?)\b/i.test(text)) {
      addMessage({ role: 'assistant', type: 'help', content: 'Here are things you can say:' });
      return;
    }

    // Session memory: inherit the last party when the user uses an anaphor.
    const sess = sessionRef.current;
    const baseCtx = { ...ctx, sessionAliases: aliasRef.current };
    const augCtx = (sess.party && ANAPHORA_PARTY_RE.test(text))
      ? { ...baseCtx, forceParty: sess.party }
      : baseCtx;

    const raw = parseMessage(text, augCtx);
    if (!raw) {
      // Rule engine dead-end → LLM escalation (when enabled + online).
      if (aiUsable()) {
        await escalateToAi(text);
        return;
      }
      const offlineNote = aiEnabled && !aiAvailable({ aiEnabled }) ? '\n\n(AI assist is offline right now.)' : '';
      addMessage({ role: 'assistant', type: 'text', content: `Hmm, I need at least an amount and a transaction type to create an entry. Try something like:\n- "got 50000 from Acme"\n- "paid 20k to vendor XYZ"\n- "spent 5000 on travel"\n- "salary 30000 Rahul"\n\nI understand amounts like 50k, 1.5 lakh, 2 crore. Type help for more.${offlineNote}` });
      return;
    }

    // Inherit the last project when the user references "the same job/site".
    if (sess.project && !raw.meta?.projectTag && ANAPHORA_PROJECT_RE.test(text)) {
      raw.meta = { ...(raw.meta || {}), projectTag: sess.project };
    }

    const parsed = validateTransaction({ ...raw, type: raw.intent }, buildValidatorCtx(raw));
    updateSession(parsed);

    // Multi-turn clarify: NLU asks for missing amount / ambiguous party
    if (parsed.intent === 'clarify') {
      addMessage({
        role: 'assistant',
        type: 'clarify',
        content: parsed.meta?.question || 'Could you clarify?',
        parsed,
        baseText: text,
      });
      return;
    }

    // Control intents (reversal / query) are dispatched, not posted.
    if (parsed.intent === 'reversal') {
      void handleControl('reversal', parsed);
      return;
    }
    if (parsed.intent === 'query') {
      void handleControl('query', parsed);
      return;
    }

    addMessage({ role: 'assistant', type: 'entry_preview', content: parsed.narration, parsed, status: 'pending' });
  };

  // Resume after user answered a clarify prompt. Combines original text with the
  // supplied answer and re-runs parseMessage → validateTransaction.
  const handleClarifyAnswer = async (baseText, answer, clarifyMeta = null, options = {}) => {
    // Clarify option buttons call this directly (not via handleSend), so they
    // need their own in-flight guard — a click while the AI is thinking would
    // run a concurrent parse/AI call and can produce duplicate previews.
    if (isThinking) return;
    if (options.appendUserEcho !== false) {
      addMessage({ role: 'user', type: 'text', content: answer });
    }

    // Party clarifies can offer a "New party: X" option (unknown name typed).
    // Picking it forces the typed name through as-is instead of an existing party.
    let resolvedParty = '';
    let isNewParty = false;
    let pickedExactly = false;
    if (clarifyMeta?.clarifyKind === 'party') {
      // "yes"/"no"/"ok" don't identify an option — re-ask, and crucially do
      // NOT merge the word into the message text (it would corrupt the
      // proposed new-party name into e.g. "Sanjeev Chopra Yes"). An answer
      // that exactly names an option is never intercepted (party called "Ok").
      const ansIsOption = (clarifyMeta.options || []).some(
        (o) => normalizeAliasKey(o) === normalizeAliasKey(answer)
      );
      if (!ansIsOption && NONCOMMITTAL_RE.test(String(answer).trim())) {
        addMessage({
          role: 'assistant',
          type: 'clarify',
          content: 'Please pick one of the options below (or type the party name).',
          parsed: { intent: 'clarify', meta: clarifyMeta },
          baseText,
        });
        return;
      }
      const typedParty = clarifyMeta.typedParty || '';
      if (typedParty && /^new(\s+party)?$/i.test(String(answer).trim())) {
        resolvedParty = typedParty;
        isNewParty = true;
        pickedExactly = true;
      } else {
        const picked = pickPartyOption(answer, clarifyMeta.options || [], NEW_PARTY_PREFIX);
        if (picked.startsWith(NEW_PARTY_PREFIX)) {
          resolvedParty = picked.slice(NEW_PARTY_PREFIX.length).trim();
          isNewParty = true;
        } else {
          resolvedParty = picked;
        }
        // Verbatim selection (button click, or typing the option/name exactly)
        // — the only case trustworthy enough to LEARN from.
        const ansKey = normalizeAliasKey(answer);
        pickedExactly = !!picked && (
          ansKey === normalizeAliasKey(picked) || ansKey === normalizeAliasKey(resolvedParty)
        );
      }
    }

    const merged = resolvedParty && baseText.toLowerCase().includes(resolvedParty.toLowerCase())
      ? baseText
      : `${baseText} ${resolvedParty || answer}`.trim();
    const parseCtx = resolvedParty
      ? { ...ctx, sessionAliases: aliasRef.current, forceParty: resolvedParty }
      : { ...ctx, sessionAliases: aliasRef.current };
    const raw = parseMessage(merged, parseCtx);
    if (!raw) {
      // The user already answered one clarify and the merged text STILL doesn't
      // parse — this is the strongest escalation signal we have.
      if (aiUsable()) {
        await escalateToAi(merged);
        return;
      }
      addMessage({ role: 'assistant', type: 'text', content: 'Still not clear — please rephrase the whole sentence.' });
      return;
    }

    // Remember the correction: typed phrase → deliberately chosen existing
    // party. Guarded hard, because a wrong alias silently rewrites this phrase
    // forever: only from the two-option (single existing candidate) prompt,
    // and only when the user selected the option exactly — never from fuzzy
    // interpretations of a typed answer. Stamped on meta here; recorded into
    // the session map (and persisted via ai_party_alias) only when the entry
    // is actually posted or parked.
    const typedPhrase = clarifyMeta?.typedParty || '';
    const existingOptions = (clarifyMeta?.options || []).filter((o) => !String(o).startsWith(NEW_PARTY_PREFIX));
    if (resolvedParty && !isNewParty && pickedExactly && typedPhrase && existingOptions.length === 1) {
      const key = normalizeAliasKey(typedPhrase);
      if (key && normalizeAliasKey(resolvedParty) !== key) {
        raw.meta = { ...(raw.meta || {}), partyAlias: { alias: typedPhrase, party: resolvedParty } };
      }
    }
    const parsed = validateTransaction({ ...raw, type: raw.intent }, buildValidatorCtx(raw));
    updateSession(parsed);
    if (parsed.intent === 'clarify') {
      addMessage({ role: 'assistant', type: 'clarify', content: parsed.meta?.question || 'One more thing…', parsed, baseText: merged });
      return;
    }
    if (parsed.intent === 'reversal') { void handleControl('reversal', parsed); return; }
    if (parsed.intent === 'query')    { void handleControl('query',    parsed); return; }
    addMessage({ role: 'assistant', type: 'entry_preview', content: parsed.narration, parsed, status: 'pending' });
  };

  const handleControl = async (kind, parsed) => {
    if (!canDispatch(parsed)) {
      const msg = (parsed.issues || []).find((i) => i.level === 'error')?.message
        || 'I could not understand that request. Please include more detail.';
      addMessage({ role: 'assistant', type: 'text', content: msg });
      return;
    }
    const handler = kind === 'reversal' ? onReverse : onQuery;
    if (!handler) {
      addMessage({ role: 'assistant', type: 'text', content: `${kind === 'reversal' ? 'Reversal' : 'Query'} is not available in this context.` });
      return;
    }
    addMessage({ role: 'assistant', type: 'text', content: kind === 'reversal' ? 'Reversing voucher…' : 'Looking that up…' });
    try {
      const result = await handler(parsed);
      if (kind === 'query' && result && typeof result === 'object' && result.chart) {
        addMessage({
          role: 'assistant',
          type: 'query_result',
          content: result.message || 'Here are the numbers.',
          chart: result.chart,
          stat: result.stat || null,
        });
        return;
      }
      const text = typeof result === 'string' ? result : (result?.message || 'Done.');
      addMessage({ role: 'assistant', type: 'text', content: text });
    } catch (err) {
      addMessage({ role: 'assistant', type: 'text', content: `Failed: ${err?.message || String(err)}` });
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // A clarify correction becomes a session alias only once the user commits
  // the entry (post/park) — a cancelled preview must not rewrite the phrase
  // for the rest of the session.
  const recordSessionAlias = (parsed) => {
    const pa = parsed?.meta?.partyAlias;
    if (pa?.alias && pa?.party) {
      const key = normalizeAliasKey(pa.alias);
      if (key) aliasRef.current[key] = pa.party;
    }
  };

  const handlePostEntry = async (messageId) => {
    if (!onPostEntry) return;
    const msg = messages.find(m => m.id === messageId);
    if (!msg || msg.status !== 'pending') return;
    // Re-run validator on the (possibly user-edited) entry before posting —
    // with the FULL compliance ctx (GSTIN/TDS), same as the preview (A8 fix).
    const rechecked = validateTransaction({ ...msg.parsed, type: msg.parsed.intent || msg.parsed.type }, buildValidatorCtx(msg.parsed));
    if (!canPost(rechecked)) {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, parsed: rechecked } : m));
      addMessage({ role: 'assistant', type: 'text', content: 'Cannot post yet — please fix the errors highlighted on the entry.' });
      return;
    }

    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'posting', parsed: rechecked } : m));
    try {
      await onPostEntry(rechecked);
      recordSessionAlias(rechecked);
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'posted' } : m));
      addMessage({ role: 'assistant', type: 'text', content: 'Done! Entry posted successfully. What is next?' });
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'error' } : m));
      addMessage({ role: 'assistant', type: 'text', content: `Failed: ${err.message}. Try again or edit the entry.` });
    }
  };

  const handleCancelEntry = (messageId) => {
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status: 'cancelled' } : m));
    addMessage({ role: 'assistant', type: 'text', content: 'Cancelled. What else?' });
  };

  const handleParkEntry = async (messageId) => {
    if (!onParkEntry) return;
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.status !== 'pending') return;
    const rechecked = validateTransaction({ ...msg.parsed, type: msg.parsed.intent || msg.parsed.type }, buildValidatorCtx(msg.parsed));
    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, status: 'posting', parsed: rechecked } : m));
    try {
      await onParkEntry(rechecked);
      recordSessionAlias(rechecked);
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, status: 'parked' } : m));
      addMessage({ role: 'assistant', type: 'text', content: 'Parked as draft. Open Accounts → All Entries (Drafts) when you are ready to post.' });
    } catch (err) {
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, status: 'pending' } : m));
      addMessage({ role: 'assistant', type: 'text', content: `Failed to park: ${err.message}.` });
    }
  };

  const handleEditEntry = (messageId, entryIndex, field, value) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId || m.type !== 'entry_preview') return m;
      const newParsed = { ...m.parsed, entries: [...m.parsed.entries] };
      newParsed.entries[entryIndex] = { ...newParsed.entries[entryIndex], [field]: field === 'amount' ? parseFloat(value) || 0 : value };
      return { ...m, parsed: newParsed };
    }));
    setEditingEntry(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl sm:rounded-2xl rounded-t-2xl bg-white shadow-2xl flex flex-col" style={{ maxHeight: '85vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-3 sm:rounded-t-2xl rounded-t-2xl shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
              <Sparkles className="text-white" size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Accounting Chat</h2>
              <p className="text-[11px] text-indigo-200">Type in plain English, I will make the entry</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-white/70 hover:bg-white/20 transition">
            <X size={18} />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50" style={{ minHeight: '280px' }}>
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'user' ? (
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-sm text-white shadow-sm">
                  {msg.content}
                </div>
              ) : msg.type === 'entry_preview' ? (
                <EntryPreview
                  msg={msg}
                  onPost={() => handlePostEntry(msg.id)}
                  onPark={onParkEntry ? () => handleParkEntry(msg.id) : undefined}
                  onCancel={() => handleCancelEntry(msg.id)}
                  onAskAi={
                    aiUsable()
                    && String(msg.parsed?.model || '').startsWith('rule')
                    && (msg.parsed?.confidence ?? 1) < 0.55
                      ? () => handleAskAi(msg.id)
                      : undefined
                  }
                  onEdit={(ei, field, val) => handleEditEntry(msg.id, ei, field, val)}
                  editingEntry={editingEntry}
                  setEditingEntry={setEditingEntry}
                  allAccounts={allAccounts}
                />
              ) : msg.type === 'help' ? (
                <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-white border border-slate-200 px-4 py-3 shadow-sm">
                  <p className="text-sm text-slate-700 font-semibold mb-2">{msg.content}</p>
                  <div className="space-y-1">
                    {HELP_EXAMPLES.map((ex, i) => (
                      <button key={i} onClick={() => { setInput(ex); inputRef.current?.focus(); }} className="block w-full text-left rounded-lg bg-slate-50 hover:bg-indigo-50 px-3 py-1.5 text-xs text-slate-600 hover:text-indigo-700 transition font-mono">
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              ) : msg.type === 'clarify' ? (
                <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-amber-50 border-2 border-amber-200 px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <HelpCircle size={14} className="text-amber-700" />
                    <p className="text-xs font-bold uppercase tracking-wide text-amber-700">Clarify</p>
                  </div>
                  <p className="text-sm text-slate-800 mb-2">{msg.content}</p>
                  {msg.parsed?.meta?.clarifyKind === 'party' && Array.isArray(msg.parsed.meta?.options) && (
                    <div className="flex flex-wrap gap-1.5">
                      {msg.parsed.meta.options.map((opt) => (
                        <button
                          key={opt}
                          disabled={isThinking}
                          onClick={() => handleClarifyAnswer(msg.baseText, opt, msg.parsed?.meta)}
                          className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  {msg.parsed?.meta?.clarifyKind === 'amount' && (
                    <p className="text-[11px] text-amber-800">Type the amount (e.g. <em>5000</em>, <em>50k</em>, <em>1.5 lakh</em>) and press Send.</p>
                  )}
                </div>
              ) : msg.type === 'query_result' ? (
                <div className="max-w-[95%] rounded-2xl rounded-bl-md bg-white border border-slate-200 px-4 py-3 shadow-sm space-y-2">
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{msg.content}</p>
                  {msg.stat && (
                    <p className="text-lg font-bold text-indigo-700">{msg.stat}</p>
                  )}
                  {msg.chart && Array.isArray(msg.chart.data) && msg.chart.data.length > 0 && (
                    <div className="h-48 w-full">
                      <ResponsiveContainer width="100%" height={192} minWidth={0}>
                        {msg.chart.kind === 'multi-bar' ? (
                          <BarChart data={msg.chart.data}>
                            <XAxis dataKey={msg.chart.xKey || 'x'} tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={shortTick} />
                            <Tooltip formatter={tooltipFormatter} />
                            <Legend wrapperStyle={{ fontSize: 10 }} />
                            {(msg.chart.series || []).map((s) => (
                              <Bar
                                key={s.key}
                                dataKey={s.key}
                                name={s.label || s.key}
                                fill={s.color || '#6366f1'}
                                cursor="pointer"
                                onClick={(pt) => openDrill(pt?.payload || pt, s.key, s.label || s.key)}
                              />
                            ))}
                          </BarChart>
                        ) : msg.chart.kind === 'bar' ? (
                          <BarChart data={msg.chart.data}>
                            <XAxis dataKey={msg.chart.xKey || 'x'} tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={shortTick} />
                            <Tooltip formatter={tooltipFormatter} />
                            <Bar
                              dataKey={msg.chart.yKey || 'y'}
                              fill="#6366f1"
                              cursor="pointer"
                              onClick={(pt) => openDrill(pt?.payload || pt, msg.chart.drill?.seriesKey || 'expenses', msg.chart.drill?.label || 'Breakdown')}
                            />
                          </BarChart>
                        ) : (
                          <LineChart
                            data={msg.chart.data}
                            onClick={(e) => {
                              const pt = e?.activePayload?.[0]?.payload;
                              if (pt) openDrill(pt, msg.chart.drill?.seriesKey || 'revenue', msg.chart.drill?.label || 'Breakdown');
                            }}
                          >
                            <XAxis dataKey={msg.chart.xKey || 'x'} tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={shortTick} />
                            <Tooltip formatter={tooltipFormatter} />
                            <Line type="monotone" dataKey={msg.chart.yKey || 'y'} stroke="#6366f1" strokeWidth={2} dot={{ r: 3, cursor: 'pointer' }} activeDot={{ r: 5 }} />
                          </LineChart>
                        )}
                      </ResponsiveContainer>
                    </div>
                  )}
                  {msg.chart && msg.chart.data?.some((d) => d._breakdown) && (
                    <p className="text-[10px] text-slate-400">Tip: click a bar or point to see the underlying entries.</p>
                  )}
                </div>
              ) : (
                <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-white border border-slate-200 px-4 py-2.5 text-sm text-slate-700 shadow-sm whitespace-pre-wrap">
                  {msg.content}
                </div>
              )}
            </div>
          ))}
          {isThinking && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-indigo-50 border border-indigo-200 px-4 py-2.5 text-sm text-indigo-700 shadow-sm animate-pulse flex items-center gap-2">
                <Sparkles size={14} className="shrink-0" /> Thinking… asking the AI accountant
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick action chips */}
        <div className="border-t border-slate-100 bg-white px-4 pt-2 pb-1 shrink-0">
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {QUICK_ACTIONS.map((qa) => (
              <button key={qa.label} onClick={() => { setInput(qa.text); inputRef.current?.focus(); }} className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200 transition">
                {qa.label}
              </button>
            ))}
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-slate-200 bg-white px-4 py-3 sm:rounded-b-2xl shrink-0" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isThinking ? 'Thinking…' : isListening ? 'Listening…' : 'e.g. "Acme paid us 50000" or "spent 5k on travel"'}
              className="flex-1 rounded-xl border border-slate-300 bg-slate-50 px-4 py-2.5 text-base sm:text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            {SpeechRecognitionImpl && (
              <button
                onClick={toggleVoice}
                title={isListening ? 'Stop listening' : 'Speak instead of typing'}
                className={`flex h-11 w-11 sm:h-10 sm:w-10 items-center justify-center rounded-xl shadow-sm transition ${isListening ? 'bg-red-600 text-white animate-pulse' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
            <button onClick={handleSend} disabled={!input.trim() || isThinking} className="flex h-11 w-11 sm:h-10 sm:w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition">
              <Send size={16} />
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400 text-center">Understands flexible phrasing, amounts like 50k/1.5L, and UPI/NEFT/cash modes. Type <strong>help</strong> for examples.</p>
        </div>
      </div>

      {/* Drill-through slide-over */}
      {drillTarget && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/40" onClick={() => setDrillTarget(null)} />
          <aside className="fixed right-0 top-0 z-[61] h-full w-full max-w-md bg-white shadow-2xl flex flex-col">
            <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-800">{drillTarget.title}</h3>
                <p className="text-[11px] text-slate-500">{drillTarget.rows.length} entries · {formatCurrency(drillTarget.rows.reduce((s, r) => s + (r.amount || 0), 0))}</p>
              </div>
              <button onClick={() => setDrillTarget(null)} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100">
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
                  <tr>
                    <th className="text-left py-1.5 pr-2">Date</th>
                    <th className="text-left py-1.5 pr-2">Account</th>
                    <th className="text-left py-1.5 pr-2">Voucher</th>
                    <th className="text-right py-1.5">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {drillTarget.rows.map((r, i) => (
                    <tr key={i} className="border-b border-slate-50 align-top">
                      <td className="py-1.5 pr-2 font-mono text-slate-500">{r.date || '—'}</td>
                      <td className="py-1.5 pr-2">
                        <div className="font-medium text-slate-700">{r.account || '—'}</div>
                        {r.narration && <div className="text-[10px] text-slate-400 truncate max-w-[180px]" title={r.narration}>{r.narration}</div>}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-indigo-600">{r.voucher_no || '—'}</td>
                      <td className="py-1.5 text-right font-mono text-slate-700">{formatCurrency(r.amount || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </aside>
        </>
      )}
    </div>
  );
};

export default VirtualAccountant;
