import React, { useState } from 'react';
import { Wifi, WifiOff, Plane, Download, Loader, Check, X, CloudOff } from 'lucide-react';

/**
 * Offline mode indicator + "Prepare for Offline" panel.
 * Renders as a small icon button (like NotificationBell) that opens a dropdown.
 */
export default function OfflineIndicator({ offlineState, role }) {
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState('');
  const {
    isOnline, effectivelyOffline, isSyncing, syncProgress,
    lastSyncTime, hasPendingWrites, forcedOffline,
    prepareForOffline, goOffline, goOnline
  } = offlineState;

  const handleSync = async () => {
    setError('');
    try {
      await prepareForOffline();
    } catch (e) {
      setError('Sync failed. Check your connection and try again.');
    }
  };

  const statusColor = effectivelyOffline
    ? 'text-amber-500'
    : hasPendingWrites
      ? 'text-blue-500'
      : 'text-green-500';

  const StatusIcon = effectivelyOffline ? WifiOff : Wifi;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`p-2 rounded-full hover:bg-slate-100 transition-colors relative ${statusColor}`}
        title={effectivelyOffline ? 'Offline' : 'Online'}
      >
        <StatusIcon size={20} />
        {effectivelyOffline && (
          <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 border-2 border-white" />
        )}
        {hasPendingWrites && !effectivelyOffline && (
          <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-blue-500 border-2 border-white animate-pulse" />
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40 flex items-center justify-center" onClick={() => setIsOpen(false)}>
            <div className="absolute inset-0 bg-black/20" />
            <div className="relative w-72 rounded-xl bg-white shadow-xl border border-slate-200 z-50 overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className={`px-4 py-3 flex items-center gap-2 ${effectivelyOffline ? 'bg-amber-50 border-b border-amber-100' : 'bg-green-50 border-b border-green-100'}`}>
              <StatusIcon size={16} className={effectivelyOffline ? 'text-amber-600' : 'text-green-600'} />
              <span className={`text-sm font-semibold ${effectivelyOffline ? 'text-amber-800' : 'text-green-800'}`}>
                {forcedOffline ? 'Flight Mode Active' : effectivelyOffline ? 'No Internet' : 'Connected'}
              </span>
              <button onClick={() => setIsOpen(false)} className="ml-auto p-1 text-slate-400 hover:text-slate-600"><X size={14} /></button>
            </div>

            <div className="p-4 space-y-3">
              {/* Offline banner when disconnected */}
              {effectivelyOffline && (
                <div className="flex items-start gap-2 p-2 bg-amber-50 rounded-lg border border-amber-100">
                  <CloudOff size={14} className="text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-xs text-amber-700">
                    Working offline. Changes are saved locally and will sync automatically when you reconnect.
                    {hasPendingWrites && <span className="font-semibold block mt-1">Pending changes queued.</span>}
                  </div>
                </div>
              )}

              {/* Last sync time */}
              {lastSyncTime && (
                <div className="text-xs text-slate-500">
                  Last synced: {lastSyncTime.toLocaleString()}
                </div>
              )}

              {/* Sync progress */}
              {isSyncing && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-indigo-700">
                    <Loader size={14} className="animate-spin" />
                    Syncing data… {syncProgress.done}/{syncProgress.total}
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-1.5">
                    <div
                      className="bg-indigo-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${syncProgress.total ? (syncProgress.done / syncProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}

              {error && (
                <div className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-100">{error}</div>
              )}

              {/* Prepare for Offline button */}
              {role === 'admin' && isOnline && !forcedOffline && (
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50 transition"
                >
                  {isSyncing ? (
                    <><Loader size={14} className="animate-spin" /> Syncing…</>
                  ) : (
                    <><Download size={14} /> Prepare for Offline</>
                  )}
                </button>
              )}

              {/* Toggle Flight Mode */}
              {role === 'admin' && (
                <>
                  {!forcedOffline && isOnline && (
                    <button
                      onClick={async () => { await goOffline(); }}
                      disabled={isSyncing}
                      className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 font-medium hover:bg-amber-100 disabled:opacity-50 transition"
                    >
                      <Plane size={14} /> Activate Flight Mode
                    </button>
                  )}
                  {forcedOffline && (
                    <button
                      onClick={async () => { await goOnline(); }}
                      className="w-full flex items-center justify-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 font-medium hover:bg-green-100 transition"
                    >
                      <Wifi size={14} /> Exit Flight Mode
                    </button>
                  )}
                </>
              )}

              {/* Info text */}
              <div className="text-[11px] text-slate-400 leading-relaxed">
                {role === 'admin'
                  ? 'Tap "Prepare for Offline" before boarding to cache all data. Flight Mode forces offline—changes queue locally and sync on reconnect.'
                  : effectivelyOffline
                    ? 'Your changes are saved locally and will sync when you reconnect.'
                    : 'All data is connected and in sync.'
                }
              </div>
            </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
