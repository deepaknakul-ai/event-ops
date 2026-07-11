// ─────────────────────────────────────────────────────────────────────────────
// Party-ledger projection helpers for the EXTERNAL client/vendor ledger link
// (getLedgerData). Pure CJS, no firebase-admin import, so the Dr/Cr netting and
// name-matching can be unit-tested in isolation (mirrors ai-sanitize.js).
//
// Why this exists: manual journal vouchers, credit/debit notes and TDS entries
// post their party leg as the free string "Party: <name>" with NO account id
// (see src/pages/Accounting.jsx), and journal_entries carries no queryable party
// field. So the ledger endpoint reads the collection and attributes rows here by
// matching a leg's debit/credit account name against the party's name variants.
//
// SECURITY: only the party's OWN leg is ever emitted (date, narration, voucher,
// netted Dr/Cr) — never the contra account, which may name an internal account
// ("Bad Debts Written Off") or another party. The projections below are the sole
// path from journal_entries → the magic-link page.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Build the set of ledger-account names that denote THIS party, lower-cased and
 * prefixed to match a journal leg's debit/credit account verbatim ("party: x").
 * Names come from the party_accounts registry (current name + renamed aliases)
 * and the client doc, so a leg posted under a since-renamed name still matches.
 * @param {{name?:string, aliases?:string[], previous_names?:string[]}|null} client
 * @param {{current_name?:string, aliases?:string[], previous_names?:string[]}|null} partyAccount
 * @returns {Set<string>}
 */
function partyLegNameSet(client, partyAccount) {
  const names = [];
  const add = (n) => { if (n && typeof n === 'string') names.push(n); };
  add(client && client.name);
  (Array.isArray(client && client.aliases) ? client.aliases : []).forEach(add);
  (Array.isArray(client && client.previous_names) ? client.previous_names : []).forEach(add);
  if (partyAccount) {
    add(partyAccount.current_name);
    (Array.isArray(partyAccount.aliases) ? partyAccount.aliases : []).forEach(add);
    (Array.isArray(partyAccount.previous_names) ? partyAccount.previous_names : []).forEach(add);
  }
  return new Set(names.map((n) => `party: ${String(n).trim().toLowerCase()}`));
}

/**
 * Project party-affecting journal_entries into external ledger rows. Each doc
 * contributes ONE row carrying only the party's own leg, netted across the doc's
 * legs (a credit note has two legs — taxable + GST — both crediting the party).
 * Cancelled docs are dropped to match buildAccountingSnapshot, so the link's
 * closing balance equals the in-app derived Party balance.
 * @param {Array<{id:string, status?:string, date?:string, voucher_no?:string, narration?:string, source?:string, entries?:Array<{debitAccount?:string, creditAccount?:string, amount?:number}>}>} docs
 * @param {Set<string>} nameSet  from partyLegNameSet
 * @returns {Array<{id:string, date:string, voucher_no:string, narration:string, source:string, debit:number, credit:number}>}
 */
function projectPartyJournalRows(docs, nameSet) {
  const out = [];
  if (!nameSet || nameSet.size === 0) return out;
  (Array.isArray(docs) ? docs : []).forEach((d) => {
    if (!d || d.status === 'cancelled') return;
    let debit = 0;
    let credit = 0;
    (Array.isArray(d.entries) ? d.entries : []).forEach((leg) => {
      const amt = Number(leg && leg.amount) || 0;
      if (amt <= 0) return;
      const dr = String((leg && leg.debitAccount) || '').trim().toLowerCase();
      const cr = String((leg && leg.creditAccount) || '').trim().toLowerCase();
      if (nameSet.has(dr)) debit += amt;
      if (nameSet.has(cr)) credit += amt;
    });
    if (debit === 0 && credit === 0) return; // this JV doesn't touch the party
    out.push({
      id: d.id,
      date: d.date || '',
      voucher_no: d.voucher_no || '',
      narration: typeof d.narration === 'string' ? d.narration.slice(0, 200) : '',
      source: d.source || 'manual_journal',
      debit: round2(debit),
      credit: round2(credit),
    });
  });
  return out;
}

/**
 * Project the party's opening-balance mirror doc (opening_balances/clientob_<id>)
 * into a single ledger row. side Dr → debit, Cr → credit (matches the derived
 * ledger fold). Returns null when there is no positive opening balance.
 * @param {{amount?:number, side?:string, date?:string, fy?:string, remarks?:string}|null} ob
 * @returns {{date:string, remarks:string, debit:number, credit:number}|null}
 */
function projectOpeningBalance(ob) {
  if (!ob) return null;
  const amt = Number(ob.amount) || 0;
  if (amt <= 0) return null;
  const side = String(ob.side || 'Dr').toUpperCase();
  return {
    date: ob.date || (ob.fy ? `${String(ob.fy).slice(0, 4)}-04-01` : ''),
    remarks: typeof ob.remarks === 'string' ? ob.remarks.slice(0, 200) : '',
    debit: side === 'CR' ? 0 : round2(amt),
    credit: side === 'CR' ? round2(amt) : 0,
  };
}

module.exports = { partyLegNameSet, projectPartyJournalRows, projectOpeningBalance };
