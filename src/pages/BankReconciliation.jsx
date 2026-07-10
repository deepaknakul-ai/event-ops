import React, { useMemo, useState, useEffect } from 'react';
import { addDoc, collection, doc, updateDoc, deleteDoc, onSnapshot, orderBy, query } from 'firebase/firestore';
import * as XLSX from '@e965/xlsx';
import { FileUp, ScanLine, Check, X as XIcon, AlertTriangle, Download, Save, FolderOpen, Trash2, Scale, BookOpen } from 'lucide-react';
import {
  parseStatementCSVDetailed, reconcile, rowKey, round2,
  buildRowBookingDraft, learnFromEntries, validateTransaction, canPost, inferAccountMeta,
} from '../utils/aiAccountant';
import { getLedgerBalance } from '../utils/accounting';
import { formatCurrency } from '../utils/helpers';
import { can } from '../utils/permissions';

// Derive the accountCreates list from entry lines (mirrors the NLU helper) so an
// edited contra account still auto-creates on post.
const buildCreates = (entries) => {
  const seen = new Set();
  const out = [];
  for (const l of entries) {
    for (const a of [l.debitAccount, l.creditAccount]) {
      if (!a || seen.has(a)) continue;
      seen.add(a);
      out.push(inferAccountMeta(a));
    }
  }
  return out;
};

// ── Book-this-row card ───────────────────────────────────────────────────────
// Builds a journal draft from one unmatched bank row, lets the human edit the
// narration + contra account, live-validates, and posts on explicit confirm.
// The Bank side is fixed to the row's direction; only the contra is editable.
function BookRowCard({ row, bankAccount, partyNames, allAccounts, learned, closedFYs, getFY, recentJournalEntries, onConfirm, onCancel, busy }) {
  const bankAcc = (bankAccount && bankAccount.trim()) || 'Bank';
  const isCredit = row.direction === 'credit';
  const amount = round2(Math.abs(Number(row.amount) || 0));
  const initial = useMemo(
    () => buildRowBookingDraft(row, { bankAccountName: bankAccount, partyNames, learned }),
    [row, bankAccount, partyNames, learned],
  );
  const [narration, setNarration] = useState(initial.narration);
  const [contra, setContra] = useState(isCredit ? initial.entries[0].creditAccount : initial.entries[0].debitAccount);

  const tx = useMemo(() => {
    const line = isCredit
      ? { debitAccount: bankAcc, creditAccount: contra, amount }
      : { debitAccount: contra, creditAccount: bankAcc, amount };
    const entries = [line];
    return {
      ...initial,
      narration,
      entries,
      accountCreates: buildCreates(entries),
      party: contra.startsWith('Party: ')
        ? { type: isCredit ? 'client' : 'vendor', name: contra.slice(7) }
        : undefined,
    };
  }, [initial, narration, contra, bankAcc, isCredit, amount]);

  const validated = useMemo(
    () => validateTransaction(tx, { knownAccounts: allAccounts, closedFYs, getFY, recentJournalEntries }),
    [tx, allAccounts, closedFYs, getFY, recentJournalEntries],
  );
  const postable = canPost(validated);
  const errors = (validated.issues || []).filter((i) => i.level === 'error');
  const warnings = (validated.issues || []).filter((i) => i.level === 'warning');

  // Account suggestions: existing COA + the builder's pick + known party names.
  const accountOptions = useMemo(() => {
    const set = new Set(allAccounts || []);
    set.add(contra);
    set.add('Suspense');
    (partyNames || []).forEach((n) => set.add(`Party: ${n}`));
    return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [allAccounts, partyNames, contra]);

  const bankLine = isCredit ? `${bankAcc} (Dr)` : `${bankAcc} (Cr)`;
  const contraSide = isCredit ? 'Cr' : 'Dr';

  return (
    <div className="rounded-lg border border-indigo-200 bg-white p-3 space-y-3">
      <div className="text-[11px] text-slate-500">
        Booking <strong>{formatCurrency(amount)}</strong> {isCredit ? 'received into' : 'paid from'} <strong>{bankAcc}</strong> · {row.date}{row.ref ? ` · ${row.ref}` : ''}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-slate-600">
          Narration
          <input
            type="text"
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          />
        </label>
        <label className="text-[11px] text-slate-600">
          Contra account ({contraSide})
          <input
            list="reco-book-accounts"
            value={contra}
            onChange={(e) => setContra(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
            placeholder="Type or pick an account"
          />
          <datalist id="reco-book-accounts">
            {accountOptions.map((n) => <option key={n} value={n} />)}
          </datalist>
        </label>
      </div>
      <div className="text-[11px] font-mono text-slate-600 bg-slate-50 rounded px-2 py-1.5">
        {bankLine} &nbsp;·&nbsp; {contra || '—'} ({contraSide}) &nbsp;·&nbsp; {formatCurrency(amount)}
      </div>
      {errors.length > 0 && (
        <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {errors.map((e, i) => <div key={i}>⚠ {e.message}</div>)}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
          {warnings.map((w, i) => <div key={i}>• {w.message}</div>)}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onConfirm(row, validated)}
          disabled={!postable || busy}
          className="rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
        >
          <BookOpen size={12} /> {busy ? 'Posting…' : 'Post entry'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const TABS = [
  { id: 'matches',   label: 'Matches' },
  { id: 'unmatched', label: 'Unmatched Bank Rows' },
  { id: 'orphans',   label: 'Unmatched JVs' },
];

// Legacy composite key used before rows carried a stable `id`. Kept so sessions
// saved under the old scheme still resolve their accepted/rejected maps.
const legacyKey = (row) => `${row?.date}-${row?.amount}-${row?.description}`;

const BankReconciliation = ({
  db,
  appId,
  role,
  user,
  manualJournalEntries = [],
  chartOfAccounts = [],
  ledger = [],
  partyNames = [],
  allAccounts = [],
  closedFYs = [],
  getFY,
  onBookRow,
  logAction,
  addToast,
}) => {
  const canEdit = can(role, 'finance', 'edit') || can(role, 'finance', 'create');
  const [csvText, setCsvText] = useState('');
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [parseError, setParseError] = useState('');
  const [minConf, setMinConf] = useState(60);
  const [tab, setTab] = useState('matches');
  const [accepted, setAccepted] = useState({});       // rowId → jeId
  const [acceptedMeta, setAcceptedMeta] = useState({}); // rowId → { confidence, reason }
  const [rejected, setRejected] = useState({});       // rowId → true
  const [saving, setSaving] = useState(false);
  const [bankAccount, setBankAccount] = useState(''); // '' = all bank accounts (legacy heuristic)
  const [excludeReconciled, setExcludeReconciled] = useState(true);
  const [manualClosing, setManualClosing] = useState('');
  const [bookingRowId, setBookingRowId] = useState(null); // unmatched row being booked
  const [bookedRows, setBookedRows] = useState({});        // rowId → voucher_no (this session)
  const [booking, setBooking] = useState(false);

  // Learned narration→account / party tables mined from history (feeds the
  // book-a-row contra suggestion).
  const learned = useMemo(() => learnFromEntries(manualJournalEntries), [manualJournalEntries]);

  // Accepted matches from prior sessions feed the learning-boost. Read-only for
  // all roles (admin sees creation in reconcile_matches via same listener).
  const [learnedMatches, setLearnedMatches] = useState([]);
  useEffect(() => {
    if (!db || !appId) return undefined;
    const unsub = onSnapshot(
      collection(db, 'artifacts', appId, 'public', 'data', 'reconcile_matches'),
      (snap) => setLearnedMatches(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setLearnedMatches([]),
    );
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, [db, appId]);

  // Bank-account choices: COA + ledger accounts whose name looks like a bank,
  // plus the generic 'Bank'. Choosing one scopes matching to that account; the
  // blank option keeps the legacy "any account starting Bank" behaviour.
  const bankAccountOptions = useMemo(() => {
    const set = new Set();
    (chartOfAccounts || []).forEach((a) => {
      const name = a?.name || '';
      const type = String(a?.type || a?.category || '').toLowerCase();
      if (/bank/i.test(name) && (!type || /asset/.test(type))) set.add(name);
    });
    (ledger || []).forEach((r) => { if (/bank/i.test(r.account || '')) set.add(r.account); });
    set.add('Bank');
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [chartOfAccounts, ledger]);

  // Saved sessions: persist upload + tolerance + accepted/rejected so the user
  // can resume a partially-reviewed statement later.
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [sessionName, setSessionName] = useState('');
  useEffect(() => {
    if (!db || !appId) return undefined;
    const col = collection(db, 'artifacts', appId, 'public', 'data', 'reconcile_sessions');
    let unsub;
    try {
      unsub = onSnapshot(query(col, orderBy('updated_at', 'desc')), (snap) => {
        setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }, () => setSessions([]));
    } catch {
      unsub = onSnapshot(col, (snap) => {
        setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }, () => setSessions([]));
    }
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, [db, appId]);

  const saveSession = async () => {
    if (!canEdit) return;
    if (!csvText.trim()) { addToast?.('Upload a CSV first', 'info'); return; }
    const name = (sessionName || '').trim() || `Session ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;
    const payload = {
      name,
      csv_text: csvText,
      min_conf: minConf,
      accepted,
      accepted_meta: acceptedMeta,
      rejected,
      bank_account: bankAccount,
      exclude_reconciled: excludeReconciled,
      manual_closing: manualClosing,
      schema_version: 2,
      row_count: rows.length,
      updated_at: new Date().toISOString(),
    };
    try {
      if (currentSessionId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'reconcile_sessions', currentSessionId), payload);
        logAction?.('reconcile_sessions', 'update', currentSessionId, payload, `Updated session "${name}"`);
        addToast?.(`Session "${name}" updated`, 'success');
      } else {
        const ref = await addDoc(
          collection(db, 'artifacts', appId, 'public', 'data', 'reconcile_sessions'),
          { ...payload, created_at: new Date().toISOString(), created_by: user?.uid || '' }
        );
        setCurrentSessionId(ref.id);
        logAction?.('reconcile_sessions', 'create', ref.id, payload, `Saved session "${name}"`);
        addToast?.(`Session "${name}" saved`, 'success');
      }
      setSessionName(name);
    } catch (err) {
      console.error(err);
      addToast?.('Failed to save session', 'error');
    }
  };

  const loadSession = (s) => {
    if (!s) return;
    setCsvText(s.csv_text || '');
    parseText(s.csv_text || '');
    setMinConf(Number(s.min_conf) || 60);
    setAccepted(s.accepted || {});
    setAcceptedMeta(s.accepted_meta || {});
    setRejected(s.rejected || {});
    setBankAccount(s.bank_account || '');
    setExcludeReconciled(s.exclude_reconciled !== false);
    setManualClosing(s.manual_closing || '');
    setSessionName(s.name || '');
    setCurrentSessionId(s.id);
    setTab('matches');
    addToast?.(`Loaded session "${s.name || s.id}"`, 'info');
  };

  const deleteSession = async (s) => {
    if (!canEdit || !s?.id) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'reconcile_sessions', s.id));
      logAction?.('reconcile_sessions', 'delete', s.id, {}, `Deleted session "${s.name || s.id}"`);
      if (currentSessionId === s.id) setCurrentSessionId(null);
      addToast?.('Session deleted', 'success');
    } catch (err) {
      console.error(err);
      addToast?.('Failed to delete session', 'error');
    }
  };

  const handleFile = (file) => {
    if (!file) return;
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — big enough for any real bank statement
    if (file.size > MAX_BYTES) {
      setParseError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is 10 MB — split into smaller chunks.`);
      setRows([]);
      return;
    }
    const name = (file.name || '').toLowerCase();
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm');
    const reader = new FileReader();
    reader.onerror = () => {
      setParseError('Failed to read file.');
      setRows([]);
    };
    reader.onload = (e) => {
      try {
        if (isXlsx) {
          const data = new Uint8Array(e.target?.result || new ArrayBuffer(0));
          const wb = XLSX.read(data, { type: 'array', cellDates: true });
          if (!wb || !wb.SheetNames || wb.SheetNames.length === 0) {
            setParseError('Workbook contains no sheets.');
            setRows([]);
            return;
          }
          const ws = wb.Sheets[wb.SheetNames[0]];
          const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
          setCsvText(csv);
          parseText(csv);
        } else {
          const text = String(e.target?.result || '');
          setCsvText(text);
          parseText(text);
        }
      } catch (err) {
        setParseError(err?.message || 'Failed to read file.');
        setRows([]);
      }
    };
    if (isXlsx) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  const parseText = (text) => {
    try {
      const d = parseStatementCSVDetailed(text);
      setRows(d.rows);
      setDetail(d);
      setParseError(d.rows.length === 0 ? (d.warnings[0] || 'No rows detected in CSV.') : '');
    } catch (err) {
      setParseError(err?.message || 'Failed to parse CSV.');
      setRows([]);
      setDetail(null);
    }
  };

  // Only reconcile against journal entries that are still open (default). A
  // re-uploaded statement therefore cannot re-claim JVs already reconciled.
  const jePool = useMemo(
    () => (excludeReconciled ? manualJournalEntries.filter((je) => !je.reconciled) : manualJournalEntries),
    [manualJournalEntries, excludeReconciled],
  );

  const result = useMemo(() => {
    if (rows.length === 0) return { matches: [], candidates: {}, unmatchedRows: [], unmatchedJVs: [], stats: { matched: 0, total: 0 } };
    return reconcile(rows, jePool, { minConfidence: minConf, learnedMatches, bankAccountName: bankAccount });
  }, [rows, jePool, minConf, learnedMatches, bankAccount]);

  // rowId → row, keyed by BOTH the stable id and the legacy composite so old
  // sessions' accepted maps still resolve to a row at persist time.
  const rowById = useMemo(() => {
    const m = {};
    for (const r of rows) { m[rowKey(r)] = r; m[legacyKey(r)] = r; }
    return m;
  }, [rows]);

  // Signatures of rows already written to reconcile_matches (matched OR booked)
  // — used to badge and block a second booking of the same bank row.
  const reconciledSignatures = useMemo(() => {
    const s = new Set();
    for (const m of learnedMatches) {
      if (m?.row) { s.add(m.row.id || legacyKey(m.row)); }
    }
    return s;
  }, [learnedMatches]);
  const isRowReconciled = (row) =>
    reconciledSignatures.has(rowKey(row)) || reconciledSignatures.has(legacyKey(row)) || !!bookedRows[rowKey(row)];

  const confidenceColor = (c) => c >= 90 ? 'bg-emerald-100 text-emerald-700' : c >= 75 ? 'bg-indigo-100 text-indigo-700' : c >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';

  const acceptedJeFor = (row) => accepted[rowKey(row)] ?? accepted[legacyKey(row)];

  const acceptMatch = (rowId, jeId, meta) => {
    if (!jeId) return;
    const clash = Object.entries(accepted).find(([rid, jid]) => jid === jeId && rid !== rowId);
    if (clash) { addToast?.('That voucher is already matched to another row', 'error'); return; }
    setAccepted((m) => ({ ...m, [rowId]: jeId }));
    setAcceptedMeta((m) => ({ ...m, [rowId]: meta || null }));
    setRejected((m) => { const n = { ...m }; delete n[rowId]; return n; });
  };

  const rejectMatch = (rowId) => {
    setRejected((m) => ({ ...m, [rowId]: true }));
    setAccepted((m) => { const n = { ...m }; delete n[rowId]; return n; });
    setAcceptedMeta((m) => { const n = { ...m }; delete n[rowId]; return n; });
  };

  // Write one reconcile_matches doc and best-effort flag the JV reconciled.
  // Shared by "accept match" (persistAccepted) and "book this row". The JV-stamp
  // failure is swallowed here; callers decide how to surface a partial write.
  const markReconciled = async (row, jeId, meta = {}) => {
    const payload = {
      row,
      journal_entry_id: jeId,
      confidence: meta.confidence ?? null,
      reason: meta.reason ?? '',
      bank_account: bankAccount || '',
      reconciled_at: new Date().toISOString(),
      reconciled_by: user?.uid || '',
    };
    const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'reconcile_matches'), payload);
    logAction?.('reconcile_matches', 'create', ref.id, payload, `Reconciled ${row.description || row.amount}`);
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', jeId), {
        reconciled: true,
        reconciled_at: new Date().toISOString(),
      });
    } catch { /* JE may be virtual/system-generated */ }
    return ref.id;
  };

  const persistAccepted = async () => {
    if (!canEdit) return;
    const entries = Object.entries(accepted);
    if (entries.length === 0) { addToast?.('No accepted matches to save', 'info'); return; }
    setSaving(true);
    let saved = 0;
    const usedJe = new Set(); // unique-jeId guard at persist time
    try {
      for (const [rowId, jeId] of entries) {
        if (!jeId || usedJe.has(jeId)) continue;
        const row = rowById[rowId];
        if (!row) continue;
        await markReconciled(row, jeId, acceptedMeta[rowId] || {});
        usedJe.add(jeId);
        saved++;
      }
      addToast?.(`Saved ${saved} match${saved === 1 ? '' : 'es'}`, 'success');
      setAccepted({});
      setAcceptedMeta({});
    } catch (err) {
      console.error(err);
      addToast?.('Failed to save some matches', 'error');
    }
    setSaving(false);
  };

  // Book an unmatched row as a new JV, then stamp the reconciliation. Ordered
  // post → stamp: if the stamp fails the JV still exists, so we warn and never
  // re-post. The row is badged booked either way.
  const handleBookConfirm = async (row, tx) => {
    if (!onBookRow || booking) return;
    if (isRowReconciled(row)) { addToast?.('This row is already reconciled', 'info'); return; }
    setBooking(true);
    let posted;
    try {
      posted = await onBookRow(tx);
    } catch (err) {
      console.error(err);
      addToast?.(err?.message || 'Failed to post entry', 'error');
      setBooking(false);
      return;
    }
    const voucher = posted?.voucher_no || posted?.id || '';
    try {
      await markReconciled(row, posted.id, { confidence: 100, reason: `Booked from bank row → ${voucher}` });
      addToast?.(`Booked ${voucher} from bank row`, 'success');
    } catch (err) {
      console.error(err);
      addToast?.(`Posted ${voucher}, but couldn't stamp reconciliation — match it manually.`, 'warning');
    }
    setBookedRows((m) => ({ ...m, [rowKey(row)]: voucher }));
    setBookingRowId(null);
    setBooking(false);
  };

  const downloadUnmatchedCSV = () => {
    const header = 'Date,Description,Reference,Amount,Direction\n';
    const body = result.unmatchedRows.map((r) => [r.date, JSON.stringify(r.description || ''), r.ref || '', r.amount, r.direction || ''].join(',')).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `unmatched-bank-rows-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadMatchesCSV = () => {
    const header = 'Bank Date,Description,Reference,Amount,Voucher,JV Date,Narration,Confidence,Reason\n';
    const body = result.matches.map((m) => [
      m.row.date,
      JSON.stringify(m.row.description || ''),
      m.row.ref || '',
      m.row.amount,
      m.journalEntry?.voucher_no || m.journalEntry?.id || '',
      m.journalEntry?.date || '',
      JSON.stringify(m.journalEntry?.narration || ''),
      m.confidence,
      JSON.stringify(m.reason || ''),
    ].join(',')).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reconciliation-matches-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const acceptedCount = Object.keys(accepted).length;

  // ── Closing-balance reconciliation ────────────────────────────────────────
  const statementClosing = manualClosing.trim() !== '' && isFinite(Number(manualClosing))
    ? round2(Number(manualClosing))
    : (detail?.closingBalance ?? null);
  const bookBankBalance = (() => {
    if (!ledger || ledger.length === 0) return null;
    if (bankAccount) return round2(getLedgerBalance(ledger, bankAccount));
    const banks = ledger.filter((r) => /^bank\b/i.test(r.account || ''));
    if (banks.length === 0) return null;
    return round2(banks.reduce((s, r) => s + (r.balance || 0), 0));
  })();
  const unmatchedNet = round2((result.unmatchedRows || []).reduce((s, r) => s + (r.direction === 'credit' ? r.amount : -r.amount), 0));
  const balanceDiff = (statementClosing != null && bookBankBalance != null) ? round2(statementClosing - bookBankBalance) : null;
  const showBalanceCard = rows.length > 0 && (statementClosing != null || bookBankBalance != null);

  const renderCandidateSelect = (row, currentJeId, placeholder) => {
    const cands = result.candidates?.[rowKey(row)] || [];
    if (cands.length === 0) return null;
    const value = acceptedJeFor(row) ?? currentJeId ?? '';
    return (
      <select
        value={value}
        disabled={!canEdit}
        onChange={(e) => {
          const jeId = e.target.value;
          if (!jeId) return;
          const c = cands.find((x) => x.jeId === jeId);
          acceptMatch(rowKey(row), jeId, c ? { confidence: c.confidence, reason: c.reason } : null);
        }}
        className="max-w-[190px] rounded-md border border-slate-300 px-1.5 py-1 text-[11px] text-slate-700"
        title="Pick a different voucher for this row"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {cands.map((c) => (
          <option key={c.jeId} value={c.jeId}>
            {(c.je.voucher_no || c.jeId)} · {c.je.date} · {c.confidence}%
          </option>
        ))}
      </select>
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <ScanLine size={20} className="text-indigo-600" /> Bank Reconciliation
        </h2>
        <p className="text-xs text-slate-500 mt-1">Upload a bank statement CSV and auto-match against posted journal entries. Review, accept or reject matches before saving.</p>
      </div>

      {/* Upload */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold cursor-pointer hover:bg-indigo-700">
            <FileUp size={14} /> Choose CSV / XLSX
            <input type="file" accept=".csv,text/csv,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
          </label>
          <div className="text-xs text-slate-500">or paste CSV below</div>
          <div className="flex-1" />
          <label className="text-xs text-slate-600 flex items-center gap-2">
            Min confidence
            <input type="range" min="50" max="95" step="5" value={minConf} onChange={(e) => setMinConf(parseInt(e.target.value, 10))} />
            <span className="font-mono font-semibold text-indigo-600 w-8 text-right">{minConf}</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-600 flex items-center gap-2">
            Bank account
            <select
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 min-w-[160px]"
              title="Scope matching to a specific bank ledger. 'All' uses any account named like a bank."
            >
              <option value="">All bank accounts</option>
              {bankAccountOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer" title="Ignore JVs already marked reconciled so a re-uploaded statement can't double-match them.">
            <input type="checkbox" checked={excludeReconciled} onChange={(e) => setExcludeReconciled(e.target.checked)} />
            Hide already-reconciled JVs
          </label>
        </div>
        <textarea
          value={csvText}
          onChange={(e) => { setCsvText(e.target.value); parseText(e.target.value); }}
          className="w-full min-h-[80px] rounded-md border border-slate-300 px-2 py-1.5 text-xs font-mono"
          placeholder="Date,Description,Reference,Debit,Credit&#10;25/04/2026,NEFT from Acme Corp,UTR123456,,50000.00"
        />
        {parseError && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={12} /> {parseError}
          </div>
        )}
        {rows.length > 0 && (
          <div className="text-xs text-slate-600">
            Parsed <strong>{rows.length}</strong> rows • Matched <strong>{result.matches.length}</strong> • Unmatched <strong>{result.unmatchedRows.length}</strong>
            {learnedMatches.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700" title={`${learnedMatches.length} previously-accepted matches boost confidence on similar rows`}>
                learning from {learnedMatches.length}
              </span>
            )}
          </div>
        )}
        {detail?.warnings?.length > 0 && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 space-y-0.5">
            {detail.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-2"><AlertTriangle size={11} /> {w}</div>
            ))}
          </div>
        )}
        {canEdit && rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="Session name (optional)"
              className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-2 py-1.5 text-xs"
            />
            <button
              onClick={saveSession}
              className="rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-semibold hover:bg-indigo-700 flex items-center gap-1"
            >
              <Save size={11} /> {currentSessionId ? 'Update session' : 'Save session'}
            </button>
            {currentSessionId && (
              <button
                onClick={() => { setCurrentSessionId(null); setSessionName(''); }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                title="Start a new session (next save will create a new record)"
              >
                New
              </button>
            )}
          </div>
        )}
      </div>

      {/* Closing-balance reconciliation */}
      {showBalanceCard && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Scale size={14} className="text-indigo-600" />
            <h3 className="text-sm font-semibold text-slate-700">Closing balance check</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-[10px] uppercase text-slate-400 font-semibold">Statement closing</div>
              <div className="mt-1 text-lg font-bold text-slate-800">{statementClosing != null ? formatCurrency(statementClosing) : '—'}</div>
              <input
                type="number"
                value={manualClosing}
                onChange={(e) => setManualClosing(e.target.value)}
                placeholder="Override / enter manually"
                className="mt-2 w-full rounded border border-slate-200 px-2 py-1 text-xs"
              />
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-[10px] uppercase text-slate-400 font-semibold">Book balance {bankAccount ? `· ${bankAccount}` : '· all bank a/cs'}</div>
              <div className="mt-1 text-lg font-bold text-slate-800">{bookBankBalance != null ? formatCurrency(bookBankBalance) : '—'}</div>
              <div className="mt-2 text-[10px] text-slate-400">From posted ledger (Dr positive).</div>
            </div>
            <div className={`rounded-lg p-3 ${balanceDiff != null && Math.abs(balanceDiff) < 1 ? 'bg-emerald-50' : 'bg-amber-50'}`}>
              <div className="text-[10px] uppercase text-slate-400 font-semibold">Difference</div>
              <div className={`mt-1 text-lg font-bold ${balanceDiff != null && Math.abs(balanceDiff) < 1 ? 'text-emerald-700' : 'text-amber-800'}`}>
                {balanceDiff != null ? formatCurrency(balanceDiff) : '—'}
              </div>
              <div className="mt-2 text-[10px] text-slate-500">
                {balanceDiff != null && Math.abs(balanceDiff) < 1
                  ? 'Statement and books agree.'
                  : 'Gap is expected while rows remain unbooked.'}
              </div>
            </div>
          </div>
          <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
            {result.unmatchedRows.length} bank row(s) still unmatched (net {formatCurrency(unmatchedNet)} to bank)
            {detail?.skippedRows ? ` · ${detail.skippedRows} row(s) skipped during import` : ''}.
            Reconcile or book these before the balances are expected to agree. This is an aid, not an audit — verify against your bank passbook.
          </div>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <FolderOpen size={14} className="text-indigo-600" />
            <h3 className="text-sm font-semibold text-slate-700">Saved sessions</h3>
            <span className="text-xs text-slate-400">({sessions.length})</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {sessions.map((s) => {
              const isActive = s.id === currentSessionId;
              const sessionAccepted = Object.keys(s.accepted || {}).length;
              return (
                <li key={s.id} className={`flex items-center gap-3 py-2 ${isActive ? 'bg-indigo-50/40 -mx-2 px-2 rounded' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-700 truncate">{s.name || s.id}</div>
                    <div className="text-[10px] text-slate-500">
                      {s.row_count || 0} rows · {sessionAccepted} accepted · {s.updated_at || s.created_at || ''}
                    </div>
                  </div>
                  <button
                    onClick={() => loadSession(s)}
                    className="rounded-md border border-indigo-200 text-indigo-700 px-2 py-1 text-[11px] font-semibold hover:bg-indigo-50"
                  >
                    {isActive ? 'Reload' : 'Load'}
                  </button>
                  {canEdit && (
                    <button
                      onClick={() => deleteSession(s)}
                      className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                      title="Delete session"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Tabs */}
          <div className="flex border-b border-slate-200">
            {TABS.map((t) => {
              const count = t.id === 'matches' ? result.matches.length : t.id === 'unmatched' ? result.unmatchedRows.length : result.unmatchedJVs.length;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                >
                  {t.label} <span className="text-xs text-slate-400 font-normal">({count})</span>
                </button>
              );
            })}
            <div className="flex-1" />
            {(tab === 'matches' || tab === 'unmatched') && acceptedCount > 0 && canEdit && (
              <button onClick={persistAccepted} disabled={saving} className="my-1 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50">
                Save {acceptedCount} accepted match{acceptedCount === 1 ? '' : 'es'}
              </button>
            )}
            {tab === 'matches' && result.matches.length > 0 && (
              <button onClick={downloadMatchesCSV} className="my-1 ml-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1">
                <Download size={11} /> Export CSV
              </button>
            )}
            {tab === 'unmatched' && result.unmatchedRows.length > 0 && (
              <button onClick={downloadUnmatchedCSV} className="my-1 ml-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1">
                <Download size={11} /> Export CSV
              </button>
            )}
          </div>

          {/* Tab contents */}
          {tab === 'matches' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Bank Row</th>
                      <th className="px-3 py-2 text-left">Matched JV</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-center">Confidence</th>
                      <th className="px-3 py-2 text-left">Reason</th>
                      <th className="px-3 py-2 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.matches.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-400">No matches above threshold. Try lowering confidence.</td></tr>
                    )}
                    {result.matches.map((m, idx) => {
                      const rowId = rowKey(m.row);
                      const acceptedJe = acceptedJeFor(m.row);
                      const isAccepted = acceptedJe != null;
                      const isRejected = !!(rejected[rowId] || rejected[legacyKey(m.row)]);
                      const rowCands = result.candidates?.[rowId] || [];
                      // Only show the picker when the current match is itself a
                      // listed candidate, so the controlled <select> value always
                      // maps to a rendered option.
                      const hasAlternates = rowCands.length > 1 && rowCands.some((c) => c.jeId === m.journalEntry?.id);
                      return (
                        <tr key={idx} className={`border-t border-slate-100 ${isAccepted ? 'bg-emerald-50/50' : isRejected ? 'bg-red-50/30 opacity-60' : 'hover:bg-slate-50'}`}>
                          <td className="px-3 py-2">
                            <div className="text-xs font-semibold text-slate-700">{m.row.date}</div>
                            <div className="text-xs text-slate-500 truncate max-w-[220px]" title={m.row.description}>{m.row.description || '—'}</div>
                            {m.row.ref && <div className="text-[10px] font-mono text-slate-400">{m.row.ref}</div>}
                          </td>
                          <td className="px-3 py-2">
                            <div className="text-xs font-semibold text-slate-700">{m.journalEntry?.voucher_no || m.journalEntry?.id}</div>
                            <div className="text-xs text-slate-500">{m.journalEntry?.date} — {m.journalEntry?.narration || '—'}</div>
                            {hasAlternates && !m.aggregated && (
                              <div className="mt-1">{renderCandidateSelect(m.row, m.journalEntry?.id)}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">{formatCurrency(m.row.amount)}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${confidenceColor(m.confidence)}`}>{m.confidence}%</span>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">{m.reason}</td>
                          <td className="px-3 py-2 text-center space-x-1 whitespace-nowrap">
                            <button
                              onClick={() => acceptMatch(rowId, m.journalEntry?.id, { confidence: m.confidence, reason: m.reason })}
                              disabled={!m.journalEntry?.id || isAccepted}
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold ${isAccepted ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                            >
                              <Check size={11} /> {isAccepted ? 'Accepted' : 'Accept'}
                            </button>
                            <button
                              onClick={() => rejectMatch(rowId)}
                              disabled={isRejected}
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold ${isRejected ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 hover:bg-red-100'}`}
                            >
                              <XIcon size={11} /> {isRejected ? 'Rejected' : 'Reject'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'unmatched' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-left">Ref</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-center">Direction</th>
                      <th className="px-3 py-2 text-left">Match to JV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.unmatchedRows.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-400">All rows matched.</td></tr>
                    )}
                    {result.unmatchedRows.map((r, idx) => {
                      const rid = rowKey(r);
                      const hasCands = (result.candidates?.[rid] || []).length > 0;
                      const isAccepted = acceptedJeFor(r) != null;
                      const reconciled = isRowReconciled(r);
                      const isBooking = bookingRowId === rid;
                      return (
                        <React.Fragment key={idx}>
                          <tr className={`border-t border-slate-100 ${isAccepted || reconciled ? 'bg-emerald-50/50' : 'hover:bg-slate-50'}`}>
                            <td className="px-3 py-2 text-xs">{r.date}</td>
                            <td className="px-3 py-2 text-xs text-slate-700 max-w-[260px] truncate" title={r.description}>{r.description || '—'}</td>
                            <td className="px-3 py-2 text-[11px] font-mono text-slate-500">{r.ref || '—'}</td>
                            <td className="px-3 py-2 text-right font-mono">{formatCurrency(r.amount)}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${r.direction === 'credit' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                                {r.direction === 'credit' ? 'Money In' : 'Money Out'}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {hasCands && renderCandidateSelect(r, null, 'Pick a voucher…')}
                                {isAccepted && <Check size={12} className="text-emerald-600" />}
                                {reconciled ? (
                                  <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                                    {bookedRows[rid] ? `Booked ${bookedRows[rid]}` : 'Reconciled'}
                                  </span>
                                ) : canEdit && onBookRow ? (
                                  <button
                                    onClick={() => setBookingRowId(isBooking ? null : rid)}
                                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold ${isBooking ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}
                                  >
                                    <BookOpen size={11} /> {isBooking ? 'Close' : 'Book entry'}
                                  </button>
                                ) : null}
                                {!hasCands && !reconciled && !(canEdit && onBookRow) && (
                                  <span className="text-[10px] text-slate-400">No candidate JV</span>
                                )}
                              </div>
                            </td>
                          </tr>
                          {isBooking && !reconciled && (
                            <tr className="bg-indigo-50/30">
                              <td colSpan={6} className="px-3 py-3">
                                <BookRowCard
                                  row={r}
                                  bankAccount={bankAccount}
                                  partyNames={partyNames}
                                  allAccounts={allAccounts}
                                  learned={learned}
                                  closedFYs={closedFYs}
                                  getFY={getFY}
                                  recentJournalEntries={manualJournalEntries}
                                  onConfirm={handleBookConfirm}
                                  onCancel={() => setBookingRowId(null)}
                                  busy={booking}
                                />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'orphans' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Voucher</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Narration</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.unmatchedJVs.length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-6 text-center text-xs text-slate-400">No unmatched bank-related JVs in the window.</td></tr>
                    )}
                    {result.unmatchedJVs.map((je) => {
                      const amt = (je.entries || []).reduce((s, e) => s + (e.amount || 0), 0);
                      return (
                        <tr key={je.id} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-3 py-2 text-xs font-semibold">{je.voucher_no || je.id}</td>
                          <td className="px-3 py-2 text-xs">{je.date}</td>
                          <td className="px-3 py-2 text-xs text-slate-600 max-w-[320px] truncate" title={je.narration}>{je.narration || '—'}</td>
                          <td className="px-3 py-2 text-right font-mono">{formatCurrency(amt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default BankReconciliation;
