import React, { useEffect, useState } from 'react';
import { Download, X, Share } from 'lucide-react';

// Lightweight "Install app" banner. Captures the browser's beforeinstallprompt
// event (Android Chrome / desktop) and offers a one-tap install. On iOS Safari
// (no beforeinstallprompt) it shows the manual Add-to-Home-Screen hint. Hidden
// entirely once installed/standalone or after the user dismisses it.
const DISMISS_KEY = 'pwaInstallDismissed';

const isStandalone = () =>
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  (typeof navigator !== 'undefined' && navigator.standalone === true);

const isIos = () =>
  typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

const readDismissed = () => {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
};

const InstallPrompt = () => {
  const [deferred, setDeferred] = useState(null);
  // iOS never fires beforeinstallprompt — surface the manual hint up-front
  // (lazy initialisers avoid setting state inside the effect).
  const [iosHint] = useState(() => isIos() && !isStandalone() && !readDismissed());
  const [visible, setVisible] = useState(() => iosHint);

  useEffect(() => {
    if (isStandalone() || readDismissed()) return undefined;
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferred(e);
      setVisible(true);
    };
    const onInstalled = () => { setVisible(false); setDeferred(null); };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    setVisible(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* user dismissed */ }
    setDeferred(null);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[200] flex justify-center px-3 pb-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-indigo-200 bg-white p-3 shadow-xl">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <Download size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800">Install TERMS</div>
          {iosHint ? (
            <div className="text-[11px] text-slate-500">Tap <Share size={11} className="inline -mt-0.5" /> Share → <span className="font-medium">Add to Home Screen</span>.</div>
          ) : (
            <div className="text-[11px] text-slate-500">Add it to your home screen for a full-screen app with notifications.</div>
          )}
        </div>
        {!iosHint && (
          <button onClick={install} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700">
            Install
          </button>
        )}
        <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default InstallPrompt;
