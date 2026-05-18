/**
 * M-5 Phase 3: party_accounts/{entityId} maintenance.
 *
 * Provides stable identity keys for parties (clients, vendors, employees)
 * so that journal ledger entries survive name changes without splitting
 * the ledger balance across two accounts.
 *
 * Schema for each doc in artifacts/{appId}/public/data/party_accounts/{entityId}:
 *   entity_id    : string  — Firestore doc id of the client/vendor/employee
 *   entity_type  : string  — 'client' | 'vendor' | 'employee'
 *   current_name : string  — latest name (updated on rename)
 *   aliases      : string[] — previous names (appended on rename, never removed)
 *   created_at   : Timestamp
 *   updated_at   : Timestamp
 */
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, arrayUnion } from 'firebase/firestore';

/**
 * Create or update a party_accounts doc for the given entity.
 *   - Creates on first call.
 *   - On rename: pushes old name to aliases, updates current_name.
 *   - On same name: no-op (skips write to avoid noise).
 * Non-fatal: failures are logged but not rethrown.
 */
export const upsertPartyAccount = async (db, appId, entityId, entityType, currentName) => {
  if (!entityId || !currentName) return;
  try {
    const ref = doc(db, 'artifacts', appId, 'public', 'data', 'party_accounts', entityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        entity_id: entityId,
        entity_type: entityType,   // 'client' | 'vendor' | 'employee'
        current_name: currentName,
        aliases: [],
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });
    } else {
      const existing = snap.data();
      if (existing.current_name === currentName) return; // no-op
      await updateDoc(ref, {
        current_name: currentName,
        aliases: arrayUnion(existing.current_name), // push old name
        updated_at: serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn('[M-5] upsertPartyAccount failed for', entityId, ':', err.message);
  }
};
