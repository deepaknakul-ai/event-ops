/**
 * Full-system backup/restore codec + validation.
 *
 * Firestore native types do not survive JSON.stringify: a Timestamp becomes a
 * plain {seconds,nanoseconds} map and silently changes type on restore (the
 * root defect of the legacy AdminTools/DataPortal exporters). The codec tags
 * them instead:
 *
 *   Timestamp  → { __t: 'ts',    s: <seconds>, n: <nanoseconds> }
 *   Bytes      → { __t: 'bytes', b64: <base64> }
 *   Reference  → { __t: 'ref',   p: <path> }        (defensive — no known usage)
 *
 * decode() reverses the tagging; untagged values (including legacy backup
 * files that predate the codec) pass through unchanged. GeoPoint is not
 * handled — the app has zero GeoPoint fields (locations are plain lat/lng
 * numbers).
 *
 * The Timestamp class is injected (createCodec) so this module stays loadable
 * by vitest from the root workspace without initializing firebase-admin.
 */

// Subcollections exported/restored per parent doc. Extend when a new
// subcollection is added to the schema — the exporter only descends where
// this map says to (a blanket listCollections() per doc would cost one RPC
// per document for nothing on the 45 flat collections).
const SUB_PARENTS = {
  chat_channels: ['messages'],
};

const TS_TAG = 'ts';
const BYTES_TAG = 'bytes';
const REF_TAG = 'ref';

function isTimestampLike(v, Timestamp) {
  if (Timestamp && v instanceof Timestamp) return true;
  // Duck-type fallback (client-SDK Timestamp or admin internals).
  return typeof v.toDate === 'function' &&
    (typeof v.seconds === 'number' || typeof v._seconds === 'number');
}

function createCodec({ Timestamp, refFromPath } = {}) {
  const encode = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object') return v;
    if (isTimestampLike(v, Timestamp)) {
      return {
        __t: TS_TAG,
        s: typeof v.seconds === 'number' ? v.seconds : v._seconds,
        n: typeof v.nanoseconds === 'number' ? v.nanoseconds : (v._nanoseconds || 0),
      };
    }
    if (v instanceof Date) {
      const ms = v.getTime();
      return { __t: TS_TAG, s: Math.floor(ms / 1000), n: (ms % 1000) * 1e6 };
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) {
      return { __t: BYTES_TAG, b64: v.toString('base64') };
    }
    if (v instanceof Uint8Array) {
      return { __t: BYTES_TAG, b64: Buffer.from(v).toString('base64') };
    }
    // DocumentReference duck-type: has a string .path and a .firestore handle.
    if (typeof v.path === 'string' && v.firestore) {
      return { __t: REF_TAG, p: v.path };
    }
    if (Array.isArray(v)) return v.map(encode);
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = encode(val);
    return out;
  };

  const decode = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (v.__t === TS_TAG && typeof v.s === 'number') {
      return Timestamp ? new Timestamp(v.s, v.n || 0) : v;
    }
    if (v.__t === BYTES_TAG && typeof v.b64 === 'string') {
      return Buffer.from(v.b64, 'base64');
    }
    if (v.__t === REF_TAG && typeof v.p === 'string') {
      return refFromPath ? refFromPath(v.p) : v.p;
    }
    if (Array.isArray(v)) return v.map(decode);
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = decode(val);
    return out;
  };

  return { encode, decode };
}

// Collection segment as used under artifacts/{appId}/public/data/ — the app's
// names are snake_case/camelCase identifiers; reject anything path-like.
function isValidCollectionName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name);
}

// Firestore doc id constraints (subset): non-empty, ≤1500 bytes, no '/',
// not '.'/'..', not reserved __*__ names.
function isValidDocId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (Buffer.byteLength(id, 'utf8') > 1500) return false;
  if (id.includes('/')) return false;
  if (id === '.' || id === '..') return false;
  if (/^__.*__$/.test(id)) return false;
  return true;
}

module.exports = { createCodec, isValidCollectionName, isValidDocId, SUB_PARENTS };
