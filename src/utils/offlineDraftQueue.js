// Lightweight IndexedDB outbox for journal drafts created while offline or
// when a Firestore addDoc hard-rejects. Complements (does not replace)
// Firestore's built-in persistent write queue. We only enqueue when the SDK
// path fails; on reconnect we replay in insertion order.
//
// Safety limits:
//   - MAX_QUEUE:       hard cap on records (older dropped FIFO)
//   - MAX_ATTEMPTS:    per-record replay attempts before quarantine
//   - MAX_PAYLOAD_KB:  reject oversized payloads at enqueue time

const DB_NAME = 'rentalops_offline';
const DB_VERSION = 1;
const STORE = 'draft_outbox';
const MAX_QUEUE = 500;
const MAX_ATTEMPTS = 10;
const MAX_PAYLOAD_KB = 512;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueDraft(appId, collectionName, payload) {
  try {
    const size = JSON.stringify(payload || {}).length;
    if (size > MAX_PAYLOAD_KB * 1024) {
      console.error('[offlineDraftQueue] payload too large, refused', { size });
      return null;
    }
    const db = await openDb();
    // FIFO trim: if at capacity, delete oldest record first.
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result < MAX_QUEUE) { resolve(); return; }
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (e) => {
          const cur = e.target.result;
          if (cur) cur.delete();
          resolve();
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.add({
        appId,
        collection: collectionName,
        payload,
        created_at: new Date().toISOString(),
        attempts: 0,
        last_error: null,
        quarantined: false,
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('[offlineDraftQueue] enqueue failed', err);
    return null;
  }
}

export async function listQueued(appId) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(appId ? all.filter((r) => r.appId === appId) : all);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function removeQueued(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return false;
  }
}

async function updateQueued(id, patch) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) { resolve(false); return; }
        const putReq = store.put({ ...rec, ...patch });
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch {
    return false;
  }
}

export async function queueSize(appId) {
  const items = await listQueued(appId);
  return items.filter((i) => !i.quarantined).length;
}

/**
 * Drain the outbox. For each record, call `postFn(collection, payload)`.
 * On success, remove the record. On failure, increment attempts; records
 * that exceed MAX_ATTEMPTS are quarantined (kept for debugging, skipped by
 * future flushes and excluded from queueSize).
 * Returns { flushed, failed, quarantined }.
 */
export async function flushQueue(appId, postFn) {
  const items = (await listQueued(appId)).filter((i) => !i.quarantined);
  let flushed = 0;
  let failed = 0;
  let quarantined = 0;
  for (const item of items) {
    try {
      await postFn(item.collection, item.payload);
      await removeQueued(item.id);
      flushed += 1;
    } catch (err) {
      const attempts = (item.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await updateQueued(item.id, {
          attempts,
          quarantined: true,
          last_error: String(err && err.message || err).slice(0, 500),
        });
        quarantined += 1;
        console.error('[offlineDraftQueue] quarantined after max attempts', item.id, err);
      } else {
        await updateQueued(item.id, {
          attempts,
          last_error: String(err && err.message || err).slice(0, 500),
        });
        failed += 1;
      }
    }
  }
  return { flushed, failed, quarantined };
}
