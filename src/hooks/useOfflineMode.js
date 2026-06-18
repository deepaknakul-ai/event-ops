import { useState, useEffect, useCallback, useRef } from 'react';
import { collection, doc, getDoc, getDocs, enableNetwork, disableNetwork, waitForPendingWrites, onSnapshotsInSync } from 'firebase/firestore';

const COLLECTIONS = [
  'employees', 'projects', 'clients', 'inventory',
  'expenses', 'advances', 'payments', 'payouts', 'vendor_payments'
];

/**
 * Hook that manages offline mode for the app.
 *  - Tracks browser online/offline status
 *  - Pre-fetches all Firestore collections into the persistent local cache
 *  - Tracks pending (queued) write count
 *  - Optionally forces Firestore into offline mode (disableNetwork)
 */
export default function useOfflineMode(db, appId) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ done: 0, total: 0 });
  const [lastSyncTime, setLastSyncTime] = useState(() => {
    const stored = localStorage.getItem('rentalOps_lastOfflineSync');
    return stored ? new Date(stored) : null;
  });
  const [hasPendingWrites, setHasPendingWrites] = useState(false);
  const [forcedOffline, setForcedOffline] = useState(false);

  // Track online/offline events
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Monitor pending writes via onSnapshotsInSync
  useEffect(() => {
    if (!db) return;
    let pending = false;
    // onSnapshotsInSync fires when all listeners are in sync with server
    const unsub = onSnapshotsInSync(db, () => {
      if (pending) {
        setHasPendingWrites(false);
        pending = false;
      }
    });
    return unsub;
  }, [db]);

  // NOTE: Flight Mode (forcedOffline) is a *manual* choice and must persist
  // until the user taps "Exit Flight Mode". We deliberately do NOT auto-exit
  // it when the browser reports online — doing so would instantly undo the
  // toggle (you activate flight mode precisely while online), which made the
  // button appear broken. Browser-driven offline is tracked separately via
  // `isOnline` and reflected through `effectivelyOffline`.

  /**
   * Pre-fetch all collections so Firestore IndexedDB cache is warm.
   * After this, the app works fully offline.
   */
  const prepareForOffline = useCallback(async () => {
    if (!db || !appId) return { failed: [] };
    const total = COLLECTIONS.length + 1; // collections + settings step
    setIsSyncing(true);
    setSyncProgress({ done: 0, total });
    const failed = [];
    try {
      // Warm each collection. A single denied/failed read must not abort the
      // whole prep — record it and keep caching the rest.
      for (let i = 0; i < COLLECTIONS.length; i++) {
        const colName = COLLECTIONS[i];
        try {
          await getDocs(collection(db, 'artifacts', appId, 'public', 'data', colName));
        } catch (e) {
          console.warn('Offline cache skipped:', colName, e?.code || e?.message || e);
          failed.push(colName);
        }
        setSyncProgress({ done: i + 1, total });
      }

      // Warm only the specific settings docs the app reads. We deliberately
      // skip 'security' (admin-server-only — never cached on the client) and
      // never list the whole settings collection.
      const SETTINGS_DOCS = ['organization', 'hq', 'categories', 'rbac'];
      for (const id of SETTINGS_DOCS) {
        try {
          await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', id));
        } catch (e) {
          console.warn('Offline cache skipped: settings/' + id, e?.code || e?.message || e);
        }
      }
      setSyncProgress({ done: total, total });

      // Flush any queued writes (best-effort).
      try { await waitForPendingWrites(db); } catch { /* offline / no pending */ }

      const now = new Date();
      setLastSyncTime(now);
      localStorage.setItem('rentalOps_lastOfflineSync', now.toISOString());
      return { failed };
    } finally {
      setIsSyncing(false);
    }
  }, [db, appId]);

  /**
   * Force Firestore into offline mode (useful for testing or conserving battery on a flight).
   */
  const goOffline = useCallback(async () => {
    if (!db) return;
    await disableNetwork(db);
    setForcedOffline(true);
  }, [db]);

  /**
   * Re-enable Firestore network access.
   */
  const goOnline = useCallback(async () => {
    if (!db) return;
    await enableNetwork(db);
    setForcedOffline(false);
  }, [db]);

  /**
   * Mark that a local write happened (for pending indicator).
   */
  const markPendingWrite = useCallback(() => {
    setHasPendingWrites(true);
  }, []);

  const effectivelyOffline = !isOnline || forcedOffline;

  return {
    isOnline,
    effectivelyOffline,
    isSyncing,
    syncProgress,
    lastSyncTime,
    hasPendingWrites,
    forcedOffline,
    prepareForOffline,
    goOffline,
    goOnline,
    markPendingWrite,
  };
}
