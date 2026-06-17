import React, { useState, useEffect, useRef } from 'react';
import { registerDialog } from '../utils/dialog';

// Single mounted host that renders in-app confirm/prompt modals on demand
// and resolves the awaiting promise when the user responds.
const DialogHost = () => {
  const [req, setReq] = useState(null);
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    registerDialog((r) => { setReq(r); setInput(r.defaultValue || ''); });
  }, []);

  useEffect(() => {
    if (req && req.kind === 'prompt' && inputRef.current) inputRef.current.focus();
  }, [req]);

  if (!req) return null;

  const isConfirm = req.kind === 'confirm';
  const close = (val) => { const r = req; setReq(null); r.resolve(val); };
  const onCancel = () => close(isConfirm ? false : null);
  const onAccept = () => close(isConfirm ? true : input);

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center px-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="px-5 py-4">
          {req.title && <div className="mb-1 text-base font-bold text-slate-800">{req.title}</div>}
          <div className="whitespace-pre-line text-sm text-slate-600">{req.message}</div>
          {!isConfirm && (
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onAccept(); if (e.key === 'Escape') onCancel(); }}
              className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
            />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t bg-slate-50 px-5 py-3">
          <button onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
            {req.cancelLabel || 'Cancel'}
          </button>
          <button
            onClick={onAccept}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${req.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
          >
            {req.confirmLabel || (isConfirm ? 'Confirm' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DialogHost;
