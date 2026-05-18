import React, { useMemo, useState, useEffect } from 'react';
import { addDoc, collection, doc, updateDoc, deleteDoc, onSnapshot, orderBy, query } from 'firebase/firestore';
import * as XLSX from '@e965/xlsx';
import { FileUp, ScanLine, Check, X as XIcon, AlertTriangle, Download, Save, FolderOpen, Trash2 } from 'lucide-react';
import { parseStatementCSV, reconcile } from '../utils/aiAccountant';
import { formatCurrency } from '../utils/helpers';
import { can } from '../utils/permissions';

const TABS = [
  { id: 'matches',   label: 'Matches' },
  { id: 'unmatched', label: 'Unmatched Bank Rows' },
  { id: 'orphans',   label: 'Unmatched JVs' },
];

const BankReconciliation = ({
  db,
  appId,
  role,
  user,
  manualJournalEntries = [],
  logAction,
  addToast,
}) => {
  const canEdit = can(role, 'finance', 'edit') || can(role, 'finance', 'create');
  const [csvText, setCsvText] = useState('');
  const [rows, setRows] = useState([]);
  const [parseError, setParseError] = useState('');
  const [minConf, setMinConf] = useState(60);
  const [tab, setTab] = useState('matches');
  const [accepted, setAccepted] = useState({}); // rowId → jeId
  const [rejected, setRejected] = useState({}); // rowId → true
  const [saving, setSaving] = useState(false);

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
      rejected,
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
    setRejected(s.rejected || {});
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
      const parsed = parseStatementCSV(text);
      setRows(parsed);
      setParseError('');
      if (parsed.length === 0) setParseError('No rows detected in CSV.');
    } catch (err) {
      setParseError(err?.message || 'Failed to parse CSV.');
      setRows([]);
    }
  };

  const result = useMemo(() => {
    if (rows.length === 0) return { matches: [], unmatchedRows: [], unmatchedJVs: [], stats: { matched: 0, total: 0 } };
    return reconcile(rows, manualJournalEntries, { minConfidence: minConf, learnedMatches });
  }, [rows, manualJournalEntries, minConf, learnedMatches]);

  const confidenceColor = (c) => c >= 90 ? 'bg-emerald-100 text-emerald-700' : c >= 75 ? 'bg-indigo-100 text-indigo-700' : c >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';

  const acceptMatch = (rowId, jeId) => setAccepted((m) => ({ ...m, [rowId]: jeId }));
  const rejectMatch = (rowId) => { setRejected((m) => ({ ...m, [rowId]: true })); setAccepted((m) => { const n = { ...m }; delete n[rowId]; return n; }); };

  const persistAccepted = async () => {
    if (!canEdit) return;
    const entries = Object.entries(accepted);
    if (entries.length === 0) { addToast?.('No accepted matches to save', 'info'); return; }
    setSaving(true);
    let saved = 0;
    try {
      for (const [rowId, jeId] of entries) {
        const match = result.matches.find((m) => m.row.id === rowId || `${m.row.date}-${m.row.amount}-${m.row.description}` === rowId);
        if (!match) continue;
        const payload = {
          row: match.row,
          journal_entry_id: jeId,
          confidence: match.confidence,
          reason: match.reason,
          reconciled_at: new Date().toISOString(),
          reconciled_by: user?.uid || '',
        };
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'reconcile_matches'), payload);
        logAction?.('reconcile_matches', 'create', ref.id, payload, `Reconciled ${match.row.description || match.row.amount}`);
        // Also flag the JV as reconciled (best-effort).
        try {
          await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', jeId), {
            reconciled: true,
            reconciled_at: new Date().toISOString(),
          });
        } catch { /* JE may be virtual/system-generated */ }
        saved++;
      }
      addToast?.(`Saved ${saved} match${saved === 1 ? '' : 'es'}`, 'success');
      setAccepted({});
    } catch (err) {
      console.error(err);
      addToast?.('Failed to save some matches', 'error');
    }
    setSaving(false);
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
              const acceptedCount = Object.keys(s.accepted || {}).length;
              return (
                <li key={s.id} className={`flex items-center gap-3 py-2 ${isActive ? 'bg-indigo-50/40 -mx-2 px-2 rounded' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-700 truncate">{s.name || s.id}</div>
                    <div className="text-[10px] text-slate-500">
                      {s.row_count || 0} rows · {acceptedCount} accepted · {s.updated_at || s.created_at || ''}
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
            {tab === 'matches' && Object.keys(accepted).length > 0 && canEdit && (
              <button onClick={persistAccepted} disabled={saving} className="my-1 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50">
                Save {Object.keys(accepted).length} accepted match{Object.keys(accepted).length === 1 ? '' : 'es'}
              </button>
            )}
            {tab === 'matches' && result.matches.length > 0 && (
              <button onClick={downloadMatchesCSV} className="my-1 ml-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1">
                <Download size={11} /> Export CSV
              </button>
            )}
            {tab === 'unmatched' && result.unmatchedRows.length > 0 && (
              <button onClick={downloadUnmatchedCSV} className="my-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1">
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
                      const rowId = m.row.id || `${m.row.date}-${m.row.amount}-${m.row.description}`;
                      const isAccepted = accepted[rowId] != null;
                      const isRejected = !!rejected[rowId];
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
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">{formatCurrency(m.row.amount)}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${confidenceColor(m.confidence)}`}>{m.confidence}%</span>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">{m.reason}</td>
                          <td className="px-3 py-2 text-center space-x-1">
                            <button
                              onClick={() => acceptMatch(rowId, m.journalEntry?.id)}
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
                    </tr>
                  </thead>
                  <tbody>
                    {result.unmatchedRows.length === 0 && (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-slate-400">All rows matched.</td></tr>
                    )}
                    {result.unmatchedRows.map((r, idx) => (
                      <tr key={idx} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2 text-xs">{r.date}</td>
                        <td className="px-3 py-2 text-xs text-slate-700 max-w-[320px] truncate" title={r.description}>{r.description || '—'}</td>
                        <td className="px-3 py-2 text-[11px] font-mono text-slate-500">{r.ref || '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(r.amount)}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${r.direction === 'credit' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                            {r.direction === 'credit' ? 'Money In' : 'Money Out'}
                          </span>
                        </td>
                      </tr>
                    ))}
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
