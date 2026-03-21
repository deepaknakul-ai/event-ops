import { useState, useEffect, useCallback, useRef } from 'react';
import { collection, getDocs, enableNetwork, disableNetwork, waitForPendingWrites, onSnapshotsInSync } from 'firebase/firestore';

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

  // When coming back online and previously forced offline, re-enable network
  useEffect(() => {
    if (isOnline && forcedOffline && db) {
      enableNetwork(db).then(() => setForcedOffline(false)).catch(() => {});
    }
  }, [isOnline, forcedOffline, db]);

  /**
   * Pre-fetch all collections so Firestore IndexedDB cache is warm.
   * After this, the app works fully offline.
   */
  const prepareForOffline = useCallback(async () => {
    if (!db || !appId) return;
    setIsSyncing(true);
    setSyncProgress({ done: 0, total: COLLECTIONS.length });
    try {
      for (let i = 0; i < COLLECTIONS.length; i++) {
        const colName = COLLECTIONS[i];
        await getDocs(collection(db, 'artifacts', appId, 'public', 'data', colName));
        setSyncProgress({ done: i + 1, total: COLLECTIONS.length });
      }

      // Also warm the settings document
      await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'settings'));

      // Wait for any pending writes to flush
      await waitForPendingWrites(db);

      const now = new Date();
      setLastSyncTime(now);
      localStorage.setItem('rentalOps_lastOfflineSync', now.toISOString());
    } catch (err) {
      console.error('Offline sync failed:', err);
      throw err;
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
