// ─────────────────────────────────────────────────────────────────────────────
// Learning from history: mine recent journal entries to build "smart default"
// suggestions so the NLU can auto-fill accounts & party types it has seen
// before. Pure — no Firestore I/O.
//
// Typical inputs are the `manualJournalEntries` array already cached by the
// Accounting page. We return compact lookup tables the NLU can consult.
// ─────────────────────────────────────────────────────────────────────────────

import { round2 } from './schema.js';
import { normalizeAliasKey } from './party.js';

/**
 * @typedef {Object} JournalLine
 * @property {string} debitAccount
 * @property {string} creditAccount
 * @property {number} amount
 */
/**
 * @typedef {Object} JournalEntry
 * @property {string} [date]
 * @property {string} [narration]
 * @property {JournalLine[]} [entries]
 * @property {string} [party_name]
 * @property {string} [party_type]
 * @property {string} [source]
 * @property {string} [ai_intent]
 */

/**
 * Derive usage frequency tables from a list of journal entries.
 * Returns four maps:
 *   - partyAccount:   "Acme Corp" → { account: "Party: Acme Corp", count, type }
 *   - narrationAccount: keyword token → { account, count }
 *   - accountFrequency: "Travel Expense" → count  (global, for tie-breaks)
 *   - pairFrequency:   "Travel Expense|Cash" → count  (dr|cr combo)
 * @param {JournalEntry[]} entries
 * @returns {{
 *   partyAccount:       Record<string, { account: string, count: number, type: string }>,
 *   narrationAccount:   Record<string, { account: string, count: number }>,
 *   accountFrequency:   Record<string, number>,
 *   pairFrequency:      Record<string, number>,
 *   sampleSize:         number,
 * }}
 */
export function learnFromEntries(entries) {
  /** @type {Record<string, { account: string, count: number, type: string }>} */
  const partyAccount = {};
  /** @type {Record<string, { account: string, count: number }>} */
  const narrationAccount = {};
  /** @type {Record<string, number>} */
  const accountFrequency = {};
  /** @type {Record<string, number>} */
  const pairFrequency = {};
  /** @type {Record<string, { intent: string, count: number }>} */
  const phraseIntent = {};
  /** @type {Record<string, number>} */
  const intentFreq = {};
  /** @type {Record<string, { party: string, count: number }>} */
  const partyAliases = {};
  /** @type {Record<string, Record<string, { count: number, lastAt: string }>>} */
  const aliasVotes = {};

  const safe = Array.isArray(entries) ? entries : [];
  for (const je of safe) {
    if (!je || je.source === 'fy_closing') continue;
    const lines = Array.isArray(je.entries) ? je.entries : [];

    // Party-alias learning: a clarify correction ("sanjeev chopra" resolved to
    // "Chopra AV") is stamped on the posted entry as ai_party_alias. Votes are
    // collected per target and reduced after the loop so conflicting
    // corrections resolve deterministically (most votes, then most recent) —
    // not by Firestore document iteration order.
    const alias = je.ai_party_alias;
    if (alias?.alias && alias?.party) {
      const key = normalizeAliasKey(alias.alias);
      if (key) {
        const at = String(je.created_at || je.date || '');
        const votes = aliasVotes[key] || (aliasVotes[key] = {});
        const v = votes[alias.party] || (votes[alias.party] = { count: 0, lastAt: '' });
        v.count += 1;
        if (at > v.lastAt) v.lastAt = at;
      }
    }

    // Phrase → intent learning (uses raw user prompt + the AI-resolved intent
    // we stored on the journal entry). This lets the NLU recover personal
    // phrasings the user has used successfully before. The prompt may be
    // stored under different keys depending on when it was saved.
    const rawPrompt = je.rawPrompt || je.ai_prompt || je.raw_prompt || '';
    if (je.ai_intent && rawPrompt) {
      const key = String(rawPrompt)
        .toLowerCase()
        .replace(/\d+(?:[.,]\d+)*/g, ' ')          // strip numbers (amounts)
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (key && key.length >= 3) {
        const cur = phraseIntent[key];
        if (cur && cur.intent === je.ai_intent) cur.count += 1;
        else if (cur) cur.count = Math.max(1, cur.count - 1);
        else phraseIntent[key] = { intent: je.ai_intent, count: 1 };
      }
      intentFreq[je.ai_intent] = (intentFreq[je.ai_intent] || 0) + 1;
    }

    // Tokens from narration (lowercase, >=3 chars) for keyword→account
    const narrTokens = (je.narration || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3);

    for (const line of lines) {
      const dr = line.debitAccount;
      const cr = line.creditAccount;
      if (dr) accountFrequency[dr] = (accountFrequency[dr] || 0) + 1;
      if (cr) accountFrequency[cr] = (accountFrequency[cr] || 0) + 1;
      if (dr && cr) {
        const key = `${dr}|${cr}`;
        pairFrequency[key] = (pairFrequency[key] || 0) + 1;
      }

      // Narration-keyword learning: bias the "expense-side" account (debit for
      // expense intent, credit for revenue intent). We keep it symmetric by
      // recording BOTH sides against each token; callers pick the side.
      for (const tok of narrTokens) {
        if (dr && !/^cash|^bank|^party:/i.test(dr)) {
          bumpKW(narrationAccount, tok, dr);
        }
        if (cr && !/^cash|^bank|^party:/i.test(cr)) {
          bumpKW(narrationAccount, tok, cr);
        }
      }
    }

    // Party→account linkage: prefer explicit party_name. Fall back to
    // scanning credit/debit for "Party: X" style accounts.
    const pName = (je.party_name || '').trim();
    const pType = (je.party_type || '').trim() || inferPartyTypeFromIntent(je.ai_intent);
    if (pName) {
      const partyAcct = lines
        .flatMap((l) => [l.debitAccount, l.creditAccount])
        .find((a) => typeof a === 'string' && a.toLowerCase() === `party: ${pName.toLowerCase()}`);
      if (partyAcct) bumpParty(partyAccount, pName, partyAcct, pType);
    } else {
      for (const line of lines) {
        for (const acc of [line.debitAccount, line.creditAccount]) {
          if (typeof acc === 'string' && /^party:\s*/i.test(acc)) {
            const name = acc.replace(/^party:\s*/i, '').trim();
            if (name) bumpParty(partyAccount, name, acc, '');
          }
        }
      }
    }
  }

  // Reduce alias votes: most votes wins; ties broken by recency.
  for (const [key, votes] of Object.entries(aliasVotes)) {
    const ranked = Object.entries(votes).sort((a, b) =>
      (b[1].count - a[1].count)
      || (b[1].lastAt > a[1].lastAt ? 1 : b[1].lastAt < a[1].lastAt ? -1 : 0)
    );
    const [party, v] = ranked[0];
    partyAliases[key] = { party, count: v.count };
  }

  return {
    partyAccount,
    narrationAccount,
    accountFrequency,
    pairFrequency,
    phraseIntent,
    intentFreq,
    partyAliases,
    sampleSize: safe.length,
  };
}

function bumpKW(map, token, account) {
  const cur = map[token];
  if (!cur) {
    map[token] = { account, count: 1 };
    return;
  }
  if (cur.account === account) cur.count += 1;
  else if (cur.count === 1) {
    // Switch only if the new account is more specific/longer — keeps first win
    // for most cases, but lets genuine winners take over.
    map[token] = { account, count: 1 };
  }
}

function bumpParty(map, name, account, type) {
  const cur = map[name];
  if (!cur) {
    map[name] = { account, count: 1, type: type || '' };
    return;
  }
  cur.count += 1;
  if (!cur.type && type) cur.type = type;
}

function inferPartyTypeFromIntent(intent) {
  switch ((intent || '').toLowerCase()) {
    case 'receipt':
    case 'invoice':
    case 'credit_note':
      return 'client';
    case 'payment':
    case 'purchase':
    case 'debit_note':
      return 'vendor';
    case 'salary':
    case 'advance':
      return 'employee';
    default:
      return '';
  }
}

/**
 * Given a party name and the learned table, return the most-used account plus
 * a normalised confidence in [0, 1].
 * @param {string} name
 * @param {ReturnType<typeof learnFromEntries>} learned
 */
export function suggestAccountForParty(name, learned) {
  if (!name || !learned?.partyAccount) return null;
  const hit = learned.partyAccount[name]
    || Object.values(learned.partyAccount).find((r) => r.account.toLowerCase() === `party: ${name.toLowerCase()}`);
  if (!hit) return null;
  return {
    account: hit.account,
    type: hit.type || '',
    count: hit.count,
    confidence: round2(Math.min(1, hit.count / 5)),
  };
}

/**
 * Given a narration/free-text and the learned table, pick the account that
 * matches the most keywords.
 * @param {string} text
 * @param {ReturnType<typeof learnFromEntries>} learned
 */
export function suggestAccountForText(text, learned) {
  if (!text || !learned?.narrationAccount) return null;
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  /** @type {Record<string, number>} */
  const scores = {};
  for (const tok of tokens) {
    const row = learned.narrationAccount[tok];
    if (row) scores[row.account] = (scores[row.account] || 0) + row.count;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [account, score] = ranked[0];
  return { account, score, confidence: round2(Math.min(1, score / 5)) };
}

/**
 * Given a free-text prompt, find a previously-learned intent for a similar
 * phrasing. Used by the NLU to break ties or recover unknowns.
 * @param {string} text
 * @param {ReturnType<typeof learnFromEntries>} learned
 */
export function suggestIntentFromPhrase(text, learned) {
  if (!text || !learned?.phraseIntent) return null;
  const key = String(text)
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)*/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key) return null;
  // Exact match wins.
  if (learned.phraseIntent[key]) {
    const hit = learned.phraseIntent[key];
    return { intent: hit.intent, count: hit.count, confidence: round2(Math.min(1, hit.count / 5)) };
  }
  // Token-overlap (Jaccard ≥ 0.6) fallback.
  const toks = new Set(key.split(' ').filter((t) => t.length >= 3));
  if (!toks.size) return null;
  let best = null, bestScore = 0;
  for (const [phrase, hit] of Object.entries(learned.phraseIntent)) {
    const pTok = new Set(phrase.split(' ').filter((t) => t.length >= 3));
    if (!pTok.size) continue;
    let inter = 0;
    for (const t of toks) if (pTok.has(t)) inter++;
    const union = toks.size + pTok.size - inter;
    const score = union ? inter / union : 0;
    if (score >= 0.6 && score > bestScore) { bestScore = score; best = hit; }
  }
  if (!best) return null;
  return { intent: best.intent, count: best.count, confidence: round2(Math.min(1, (best.count / 5) * bestScore)) };
}

/**
 * List the top N most-used accounts. Useful for UI hints.
 * @param {ReturnType<typeof learnFromEntries>} learned
 * @param {number} [n=5]
 */
export function topAccounts(learned, n = 5) {
  if (!learned?.accountFrequency) return [];
  return Object.entries(learned.accountFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([account, count]) => ({ account, count }));
}
