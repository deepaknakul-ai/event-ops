// ─────────────────────────────────────────────────────────────────────────────
// Client bridge to the aiExtractEntry Cloud Function (Virtual Accountant LLM
// escalation). The rule engine parses chat first; these helpers are used only
// when rules dead-end. Mirrors the messaging.js callable-wrapper pattern.
//
// hydrateLlmTransaction / buildAiContext / aiAvailable are pure — unit-tested
// without any network.
// ─────────────────────────────────────────────────────────────────────────────
import { getFunctions, httpsCallable } from 'firebase/functions';
import { appId } from './constants';
import { inferAccountMeta } from './aiAccountant/schema.js';
import { findPartyCandidates } from './aiAccountant/nlu.js';
import { normalizeAliasKey } from './aiAccountant/party.js';

/** Is the AI path usable right now? Rules remain the offline fallback. */
export const aiAvailable = ({ aiEnabled } = {}) =>
  !!aiEnabled && !(typeof navigator !== 'undefined' && navigator && navigator.onLine === false);

/** Whitelisted, capped context sent to the server (which re-caps regardless). */
export const buildAiContext = (ctx = {}) => {
  const cap = (arr, n) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, n) : []);
  const todayISO = new Date().toISOString().slice(0, 10);
  let fy = '';
  try { fy = typeof ctx.getFY === 'function' ? String(ctx.getFY(todayISO) || '') : ''; } catch { fy = ''; }
  return {
    partyNames: cap(ctx.partyNames, 300),
    partyGstins: ctx.partyGstins && typeof ctx.partyGstins === 'object' ? ctx.partyGstins : {},
    accountNames: cap(ctx.allAccounts, 200),
    projectNames: cap(ctx.projectNames, 100),
    orgGstin: typeof ctx.orgGstin === 'string' ? ctx.orgGstin : '',
    todayISO,
    fy,
  };
};

/**
 * Ground the server-sanitized LLM Transaction in local state (trust-but-verify):
 * - Party: exact name match → canonical casing; session alias → snap; single
 *   fully-covering candidate → snap with an info issue. Otherwise the LLM's
 *   name is kept — the validator's unknown-party warning + the entry preview
 *   are the clarification surface (the LLM path never emits `clarify`).
 * - Accounts: case/whitespace variants snap to the COA; unknown accounts get
 *   accountCreates via the SAME inferAccountMeta the rule engine uses.
 * Pure function.
 */
export const hydrateLlmTransaction = (txn, ctx = {}) => {
  const out = {
    ...txn,
    party: { ...(txn.party || { type: 'unknown', name: '' }) },
    entries: Array.isArray(txn.entries) ? txn.entries.map((l) => ({ ...l })) : [],
    issues: Array.isArray(txn.issues) ? [...txn.issues] : [],
    meta: { ...(txn.meta || {}) },
  };
  const partyNames = Array.isArray(ctx.partyNames) ? ctx.partyNames : [];
  const allAccounts = Array.isArray(ctx.allAccounts) ? ctx.allAccounts : [];

  // ── Party grounding ─────────────────────────────────────────────────────
  // ctx.partyNames holds CLIENTS/VENDORS only — an employee party (salary,
  // advance) must never be grounded against it, or "Rahul" gets rewritten to
  // the client "Rahul Traders" on a salary voucher.
  const name = out.party.name || '';
  if (name && out.party.type !== 'employee') {
    const exact = partyNames.find((p) => String(p).toLowerCase() === name.toLowerCase());
    let target = exact || '';
    let snapped = false;
    if (!target) {
      const aliasHit = ctx.sessionAliases ? ctx.sessionAliases[normalizeAliasKey(name)] : '';
      if (aliasHit && partyNames.includes(aliasHit)) {
        target = aliasHit;
        snapped = true;
      } else {
        const candidates = findPartyCandidates(name, partyNames);
        const only = candidates.length === 1 ? candidates[0] : null;
        if (only && (only.source === 'exact' || (only.coverage ?? 0) >= 1)) {
          target = only.name;
          snapped = true;
        }
      }
    }
    if (target && target !== name) {
      if (snapped) {
        out.issues.push({ level: 'info', code: 'llm_party_snapped', message: `Interpreted "${name}" as existing party "${target}".` });
      }
      // Party ledger accounts in the entry lines must follow the rename — in
      // BOTH branches (a case-variant "Party: acme corp" would otherwise
      // auto-create a second COA account and split the party ledger).
      const oldAcc = `party: ${name.toLowerCase()}`;
      out.entries = out.entries.map((l) => ({
        ...l,
        debitAccount: String(l.debitAccount || '').toLowerCase() === oldAcc ? `Party: ${target}` : l.debitAccount,
        creditAccount: String(l.creditAccount || '').toLowerCase() === oldAcc ? `Party: ${target}` : l.creditAccount,
      }));
      out.party.name = target;
    }
  }

  // ── Account grounding ───────────────────────────────────────────────────
  const canon = new Map(allAccounts.map((a) => [String(a).trim().toLowerCase(), String(a)]));
  const fix = (n) => {
    const trimmed = String(n || '').trim();
    return canon.get(trimmed.toLowerCase()) || trimmed;
  };
  out.entries = out.entries.map((l) => ({ ...l, debitAccount: fix(l.debitAccount), creditAccount: fix(l.creditAccount) }));

  const seen = new Set();
  const accountCreates = [];
  for (const l of out.entries) {
    for (const acc of [l.debitAccount, l.creditAccount]) {
      const key = String(acc).toLowerCase();
      if (acc && !canon.has(key) && !seen.has(key)) {
        seen.add(key);
        accountCreates.push(inferAccountMeta(acc));
      }
    }
  }
  out.accountCreates = accountCreates;
  return out;
};

/** Call the Cloud Function and hydrate the result. Throws HttpsError-shaped
 *  errors (err.message is user-friendly — surfaced directly in chat). */
export const aiExtractEntry = async (text, ctx = {}) => {
  const fn = httpsCallable(getFunctions(), 'aiExtractEntry');
  const res = await fn({ appId, text, context: buildAiContext(ctx) });
  const txn = res && res.data && res.data.transaction;
  if (!txn) throw new Error('The AI returned no result. Try rephrasing.');
  return hydrateLlmTransaction(txn, ctx);
};
