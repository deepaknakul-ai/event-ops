// c:\APP\temp\rental-ops\src\components\Shared.jsx
import React, { useEffect, useState, useRef } from 'react';
import { X, AlertTriangle, Search, Send, Mail, MessageCircle, Download, Loader } from 'lucide-react';
import { getDoc, doc } from 'firebase/firestore';
import { validateGSTIN } from '../utils/helpers';
import { GST_STATE_CODES } from '../utils/constants';
import { notify } from '../utils/toast';
import { promptDialog } from '../utils/dialog';
import { emailDocument, whatsappShare } from '../utils/messaging';

export const LoadingSpinner = () => (
  <div className="flex h-screen items-center justify-center bg-slate-50">
    <div className="flex flex-col items-center gap-3">
      <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-slate-200 border-t-indigo-600"></div>
      <span className="text-xs font-medium text-slate-400 tracking-wide">Loading…</span>
    </div>
  </div>
);

export const ConfirmationModal = ({ isOpen, onClose, onConfirm, title, message }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl animate-slide-up">
        <h3 className="text-base font-bold text-slate-900 mb-2">{title}</h3>
        <p className="text-sm text-slate-600 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition">Cancel</button>
          <button onClick={() => { onConfirm(); onClose(); }} className="px-4 py-2 rounded-lg bg-red-600 text-sm font-semibold text-white hover:bg-red-700 transition shadow-sm">Confirm</button>
        </div>
      </div>
    </div>
  );
};

/**
 * ConfirmDeleteModal — a safer delete confirmation dialog.
 * - requireTyped=false (default): shows a warning and a Confirm button
 * - requireTyped=true: user must type "DELETE" to enable the Confirm button
 */
export const ConfirmDeleteModal = ({ isOpen, onClose, onConfirm, title, message, requireTyped = false }) => {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!isOpen) setTyped(''); }, [isOpen]);
  if (!isOpen) return null;
  const canConfirm = !requireTyped || typed === 'DELETE';
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl border border-red-200">
        <div className="flex items-center gap-3 border-b border-red-100 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle size={18} className="text-red-600" />
          </div>
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="ml-auto rounded-full p-1 hover:bg-slate-100 text-slate-400"><X size={16} /></button>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-slate-600">{message}</p>
          {requireTyped && (
            <div className="mt-4">
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Type <span className="font-bold text-red-600 tracking-widest">DELETE</span> to confirm
              </label>
              <input
                type="text"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder="Type DELETE"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-300"
                autoFocus
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={() => { if (canConfirm) { onConfirm(); onClose(); } }}
            disabled={!canConfirm}
            className={`rounded px-4 py-2 text-sm font-semibold text-white transition ${canConfirm ? 'bg-red-600 hover:bg-red-700 cursor-pointer' : 'bg-red-300 cursor-not-allowed'}`}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

export const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);
  const styles = type === 'error'
    ? 'bg-red-600 text-white'
    : type === 'success'
    ? 'bg-emerald-600 text-white'
    : 'bg-white text-slate-800 border border-slate-200';
  return (
    <div className={`flex items-center gap-3 rounded-xl px-4 py-3 shadow-lg animate-slide-up ${styles}`}>
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onClose} className="opacity-70 hover:opacity-100 transition"><X size={15} /></button>
    </div>
  );
};

/**
 * GSTINField — smart GSTIN input with inline format validation and optional API lookup.
 * Props:
 *   value, onChange(gstin) — controlled input
 *   onAutofill({ name, address }) — called when API lookup succeeds
 *   db, appId — Firestore refs to fetch GST API key from org settings
 *   id — optional input id
 */
export const GSTINField = ({ value = '', onChange, onAutofill, db, appId, id = 'gstin-field' }) => {
  const [status, setStatus] = useState('idle'); // idle | loading | done | error | nokey
  const [msg, setMsg] = useState('');

  const gstin = value.toUpperCase();
  const isComplete = gstin.length === 15;
  const validation = isComplete ? validateGSTIN(gstin, null) : null;
  const stateCode = gstin.substring(0, 2);
  const stateName = GST_STATE_CODES[stateCode];

  useEffect(() => { setStatus('idle'); setMsg(''); }, [gstin]);

  const handleLookup = async () => {
    if (!validation?.valid || !db) return;
    setStatus('loading');
    try {
      const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
      const apiKey = orgSnap.exists() ? orgSnap.data().gst_api_key : null;
      if (!apiKey) {
        setStatus('nokey');
        setMsg('GST API key not configured. Set it in Admin Tools → Organisation Settings.');
        return;
      }
      const resp = await fetch(
        `https://api.gst.gov.in/apiportal/v1/search?gstin=${gstin}`,
        { headers: { 'auth-token': apiKey, 'Content-Type': 'application/json' } }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data?.status_cd === '1' && data?.data) {
        const name = data.data.lgnm || data.data.tradeName || '';
        const a = data.data.pradr?.addr || {};
        const address = [a.bno, a.bnm, a.flno, a.st, a.loc, a.dst, a.stcd, a.pncd]
          .filter(Boolean).join(', ');
        onAutofill?.({ name, address });
        setStatus('done');
        setMsg(name || 'Details fetched & filled');
      } else {
        throw new Error(data?.message || 'GSTIN not found on GST portal');
      }
    } catch (e) {
      const errMsg = String(e.message || 'Lookup failed');
      setStatus('error');
      setMsg(errMsg.includes('fetch') ? 'Network/CORS error. Try the GST Portal directly.' : errMsg);
    }
  };

  const inputBorder = !gstin
    ? 'border-slate-300'
    : isComplete && validation?.valid
    ? 'border-green-400 bg-green-50'
    : isComplete
    ? 'border-red-400 bg-red-50'
    : 'border-slate-300';

  return (
    <div>
      <div className="flex gap-2">
        <input
          id={id}
          name="gstin"
          type="text"
          maxLength={15}
          autoComplete="off"
          className={`flex-1 rounded border p-2 uppercase font-mono text-black placeholder-slate-400 focus:ring-2 focus:ring-indigo-500 transition-colors ${inputBorder}`}
          placeholder="15-char GSTIN (e.g. 27XXXXX0000X1ZX)"
          value={value}
          onChange={e => onChange(e.target.value.toUpperCase())}
        />
        {isComplete && validation?.valid && db && (
          <button
            type="button"
            onClick={handleLookup}
            disabled={status === 'loading'}
            className="flex items-center gap-1 rounded border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 whitespace-nowrap transition"
            title="Lookup firm name & address from GST Portal"
          >
            <Search size={13} />{status === 'loading' ? 'Looking up…' : 'Lookup'}
          </button>
        )}
      </div>
      {isComplete && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {validation?.valid
            ? <span className="text-green-700 font-medium">✓ Valid GSTIN — {stateName || stateCode}</span>
            : <span className="text-red-600">✗ {validation?.msg}</span>
          }
          {status === 'done' && (
            <span className="text-green-700 font-medium">• Autofilled: {msg}</span>
          )}
          {status === 'error' && (
            <span className="text-red-600">• {msg}{' '}
              <a href="https://services.gst.gov.in/services/searchtp" target="_blank" rel="noopener noreferrer" className="underline font-medium">Open GST Portal →</a>
            </span>
          )}
          {status === 'nokey' && (
            <span className="text-amber-700">• {msg}</span>
          )}
        </div>
      )}
    </div>
  );
};

export const Modal = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4 bg-black/40 backdrop-blur-sm">
      <div className="w-full sm:max-w-2xl h-[92dvh] sm:h-auto sm:max-h-[90vh] rounded-t-2xl sm:rounded-2xl bg-white shadow-xl flex flex-col animate-slide-up border border-slate-200/60">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 shrink-0">
          <h3 className="text-base font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-2 hover:bg-slate-100 text-slate-400 transition"><X size={20} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto text-slate-700 flex-1">{children}</div>
      </div>
    </div>
  );
};

/**
 * SendMenu — Download / Email / WhatsApp a generated document.
 *
 * Props:
 *   buildPdf:  async () => ({ doc, filename })  — returns a jsPDF doc WITHOUT saving
 *   email:     default recipient email (optional; prompted if missing)
 *   phone:     default WhatsApp number (optional)
 *   subject:   email subject
 *   message:   email/WhatsApp body text
 *   link:      optional link appended to the WhatsApp/email body (e.g. portal URL)
 *   label:     button label (default "Send")
 *   disabled:  disable the trigger
 */
export const SendMenu = ({ buildPdf, email = '', phone = '', subject = 'Document', message = '', link = '', label = 'Send', disabled = false, compact = false, className = '' }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleDownload = async () => {
    setOpen(false);
    try {
      const { doc: pdfDoc, filename } = await buildPdf();
      if (pdfDoc) pdfDoc.save(filename || 'document.pdf');
    } catch (e) { notify('Could not generate document: ' + (e?.message || 'error'), 'error'); }
  };

  const handleEmail = async () => {
    setOpen(false);
    const to = (email || '').trim() || (await promptDialog('Send to email address:', ''))?.trim();
    if (!to) return;
    setBusy(true);
    try {
      const { doc: pdfDoc, filename } = await buildPdf();
      await emailDocument({ pdfDoc, filename, to, subject, html: (message || subject).replace(/\n/g, '<br>') + (link ? `<br><br><a href="${link}">${link}</a>` : ''), text: message });
      notify('Email sent to ' + to, 'success');
    } catch (e) {
      const msg = e?.message || 'Failed to send';
      notify(/not configured|failed-precondition/i.test(msg) ? 'Email not set up yet — add SMTP/API in Admin Tools → Communication.' : 'Email failed: ' + msg, 'error');
    } finally { setBusy(false); }
  };

  const handleWhatsApp = () => {
    setOpen(false);
    whatsappShare({ phone, message: message || subject, link });
  };

  return (
    <div className={`relative inline-block ${className}`} ref={ref}>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => setOpen(o => !o)}
        title={compact ? 'Send (Email / WhatsApp / Download)' : undefined}
        className={compact
          ? 'p-1.5 rounded hover:bg-indigo-50 text-indigo-600 transition disabled:opacity-50'
          : 'flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition'}
      >
        {busy ? <Loader size={compact ? 14 : 15} className="animate-spin" /> : <Send size={compact ? 14 : 15} />}{compact ? '' : ` ${label}`}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <button type="button" onClick={handleDownload} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Download size={15} className="text-slate-500" /> Download</button>
          <button type="button" onClick={handleEmail} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Mail size={15} className="text-blue-500" /> Email</button>
          <button type="button" onClick={handleWhatsApp} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><MessageCircle size={15} className="text-green-500" /> WhatsApp</button>
        </div>
      )}
    </div>
  );
};
