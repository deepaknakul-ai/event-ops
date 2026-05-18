// ─────────────────────────────────────────────────────────────────────────────
// Chat-assistant learning module.
//
// Records successful (and corrected) prompt → intent mappings so the NLU can
// learn from each user's personal phrasing. Pure, framework-agnostic:
//   • `recordUsage()` mutates an in-memory model and returns the new state.
//   • `loadModel()` / `saveModel()` persist to localStorage (browser) when
//     available, with a graceful no-op on the server.
//   • `topUsedPrompts()` powers the dynamic Quick-Actions strip.
//   • `summary()` is handy for the (future) "what have I taught you?" panel.
//
// The stored shape is:
// {
//   version: 1,
//   updatedAt: <iso>,
//   phraseIntent: {
//     "<normalised phrase>": { intent, count, lastUsed, originalSamples: [...] }
//   },
//   intentFreq:  { "<intent>": count },
//   prompts:     [ { text, intent, ts } ]   // bounded ring-buffer
// }
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'rentalOps.assistant.learning.v1';
const MAX_PROMPTS = 200;
const MAX_SAMPLES_PER_PHRASE = 5;

/** Lower-case + strip punctuation + collapse whitespace. */
function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove tokens that match any known entity name so the phrase reflects shape, not data. */
function stripEntities(phrase, ctx = {}) {
  let out = ` ${phrase} `;
  const allNames = []
    .concat(ctx.clientNames || [])
    .concat(ctx.employeeNames || [])
    .concat(ctx.vendorNames || [])
    .concat(ctx.projectNames || [])
    .concat(ctx.inventoryNames || [])
    .map(normalise)
    .filter((n) => n && n.length > 2)
    .sort((a, b) => b.length - a.length); // longest first
  for (const n of allNames) {
    out = out.replace(new RegExp(` ${escapeRegex(n)} `, 'g'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function emptyModel() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    phraseIntent: {},
    intentFreq: {},
    prompts: [],
  };
}

/**
 * Record one successful interaction. Returns the updated model (immutable
 * style — caller should pass the result back to the React state setter).
 *
 * @param {object} model         Current learning model (use emptyModel() if null).
 * @param {object} input
 * @param {string} input.text    Raw user prompt.
 * @param {string} input.intent  Resolved intent id.
 * @param {object} [input.ctx]   NLU ctx for entity stripping.
 * @param {boolean} [input.corrected]  True when this is a user correction
 *                                     (we weight corrections higher).
 */
export function recordUsage(model, { text, intent, ctx, corrected = false }) {
  if (!intent || intent === 'unknown' || intent === 'help') return model || emptyModel();
  const m = model && typeof model === 'object' ? { ...model } : emptyModel();
  m.phraseIntent = { ...(m.phraseIntent || {}) };
  m.intentFreq = { ...(m.intentFreq || {}) };
  m.prompts = Array.isArray(m.prompts) ? m.prompts.slice() : [];

  const norm = normalise(text);
  const stripped = stripEntities(norm, ctx || {});
  const key = stripped || norm;
  if (!key) return m;

  const cur = m.phraseIntent[key] || { intent, count: 0, lastUsed: null, originalSamples: [] };
  // If a different intent is recorded, the user effectively corrected us:
  // overwrite when the new signal is a correction or has accumulated weight.
  if (cur.intent !== intent) {
    if (corrected) {
      cur.intent = intent;
      cur.count = 1;
    } else {
      cur.count -= 1;
      if (cur.count <= 0) { cur.intent = intent; cur.count = 1; }
    }
  } else {
    cur.count += corrected ? 2 : 1;
  }
  cur.lastUsed = new Date().toISOString();
  if (!cur.originalSamples.includes(text)) {
    cur.originalSamples = [text, ...cur.originalSamples].slice(0, MAX_SAMPLES_PER_PHRASE);
  }
  m.phraseIntent[key] = cur;

  m.intentFreq[intent] = (m.intentFreq[intent] || 0) + 1;
  m.prompts = [{ text, intent, ts: Date.now() }, ...m.prompts].slice(0, MAX_PROMPTS);
  m.updatedAt = new Date().toISOString();
  return m;
}

/**
 * Return the user's most-used original prompts (de-duplicated). Useful as
 * dynamic quick-action chips. Filters out one-off phrasings.
 */
export function topUsedPrompts(model, { limit = 6, minCount = 2 } = {}) {
  if (!model || !model.phraseIntent) return [];
  const rows = Object.values(model.phraseIntent)
    .filter((r) => r.count >= minCount && Array.isArray(r.originalSamples) && r.originalSamples.length)
    .sort((a, b) => (b.count - a.count) || (Date.parse(b.lastUsed || 0) - Date.parse(a.lastUsed || 0)))
    .slice(0, limit * 2);
  // Pick the most-recent original sample for display.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const sample = r.originalSamples[0];
    if (!sample || seen.has(sample.toLowerCase())) continue;
    seen.add(sample.toLowerCase());
    out.push({ text: sample, intent: r.intent, count: r.count });
    if (out.length >= limit) break;
  }
  return out;
}

/** Lightweight self-report for debugging / a future "memory" panel. */
export function summary(model) {
  const m = model || emptyModel();
  return {
    phrases: Object.keys(m.phraseIntent || {}).length,
    interactions: (m.prompts || []).length,
    topIntents: Object.entries(m.intentFreq || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count })),
    updatedAt: m.updatedAt,
  };
}

/** Forget a single phrase (e.g. "stop suggesting this"). */
export function forgetPhrase(model, normalisedKey) {
  if (!model || !model.phraseIntent || !model.phraseIntent[normalisedKey]) return model;
  const m = { ...model, phraseIntent: { ...model.phraseIntent } };
  delete m.phraseIntent[normalisedKey];
  m.updatedAt = new Date().toISOString();
  return m;
}

/** Reset everything for a user. */
export function resetModel() { return emptyModel(); }

// ── Persistence helpers ─────────────────────────────────────────────────────
function storageKey(userId) {
  return `${STORAGE_PREFIX}.${userId || 'anonymous'}`;
}

export function loadModel(userId) {
  try {
    if (typeof localStorage === 'undefined') return emptyModel();
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return emptyModel();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return emptyModel();
    return parsed;
  } catch {
    return emptyModel();
  }
}

export function saveModel(userId, model) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(storageKey(userId), JSON.stringify(model));
  } catch {
    // quota exceeded etc. — silent best-effort
  }
}
