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

/**
 * Select a vendor's purchase orders out of the project_financials siblings. A
 * vendor's POs are embedded in OTHER parties' projects, so the ledger endpoint
 * can only reach them by scanning siblings. This returns ONLY {pid, purchase_orders}
 * carrying just the POs where this party is the vendor — nothing else from the
 * sibling (the owning client's package_cost / items / logistics / margin) is ever
 * carried through, so it cannot leak to the vendor's magic-link. Projects the
 * party already owns as a client are excluded (their POs come via the client path).
 * @param {Array<{id:string, data:{purchase_orders?:Array<{vendor_id?:string}>}}>} finDocs
 * @param {string} cid  this party's id
 * @param {Set<string>|string[]} clientPids  project ids the party owns as client
 * @returns {Array<{pid:string, purchase_orders:Array<object>}>}
 */
function selectVendorProjectPOs(finDocs, cid, clientPids) {
  const out = [];
  const owned = clientPids instanceof Set ? clientPids : new Set(clientPids || []);
  (Array.isArray(finDocs) ? finDocs : []).forEach((d) => {
    if (!d || !d.id || owned.has(d.id)) return;
    const data = d.data || {};
    const pos = (Array.isArray(data.purchase_orders) ? data.purchase_orders : [])
      .filter((po) => po && po.vendor_id === cid);
    if (pos.length) out.push({ pid: d.id, purchase_orders: pos });
  });
  return out;
}

/**
 * EXTERNAL whitelist projection of `expenses`-collection rows an admin has marked
 * `shared_with_client`. The admin's share decision — not approval status — gates
 * visibility (an approved OR disapproved expense can be shared). NEVER emits the
 * submitting employee, project_id, storage path, internal ids, or the internal
 * approval status — only date/category/description/amount + the proof link the
 * client opens. These are transparency-only; they do NOT enter the ledger balance.
 * @param {Array<object>} rows  raw expense docs (already filtered to shared)
 * @returns {Array<{date,category,description,amount,proof_url,proof_name}>}
 */
function projectSharedExpenses(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((e) => e)
    .map((e) => ({
      date: e.date || '',
      category: e.category || '',
      description: e.remarks || '',
      amount: round2(e.amount),
      proof_url: typeof e.proof_url === 'string' ? e.proof_url : '',
      proof_name: typeof e.proof_name === 'string' ? e.proof_name : '',
    }));
}

/**
 * Whitelist projection of a project's embedded reimbursable_expenses[] for the
 * client ledger. Amounts always show (existing behaviour); proof links ride along
 * ONLY when the project is flagged for expense sharing. Never emits the storage
 * path, internal id, created_at, or free-text remarks.
 * @param {Array<object>} rows
 * @param {boolean} includeProofs  true only when share_expense_details is on
 */
function projectSharedReimbursables(rows, includeProofs) {
  return (Array.isArray(rows) ? rows : []).map((e) => ({
    date: e.date || '',
    description: e.description || '',
    category: e.category || '',
    amount: round2(e.amount),
    ...(includeProofs
      ? {
        proof_url: typeof e.proof_url === 'string' ? e.proof_url : '',
        proof_name: typeof e.proof_name === 'string' ? e.proof_name : '',
      }
      : {}),
  }));
}

/**
 * Group admin-shared expenses onto the client's OWN projects. An expense reaches
 * the client ledger only when an admin marked it `shared_with_client` AND its
 * `project_id` is one of the client's projects — approval status does NOT gate it
 * (the Expenses UI only offers the toggle on decided expenses, but the server just
 * honors the flag). Each project's rows are whitelisted via projectSharedExpenses
 * (identity / path / status / internal fields stripped). Returns { [project_id]: rows }.
 * @param {Array<object>} expenseDocs  raw expense docs
 * @param {Set<string>|string[]} clientPids  the client's own project ids
 * @returns {Object<string, Array>}
 */
function groupClientSharedExpenses(expenseDocs, clientPids) {
  const owned = clientPids instanceof Set ? clientPids : new Set(clientPids || []);
  const byPid = {};
  (Array.isArray(expenseDocs) ? expenseDocs : []).forEach((e) => {
    if (!e || e.shared_with_client !== true) return;
    const pid = e.project_id;
    if (!pid || !owned.has(pid)) return;
    (byPid[pid] = byPid[pid] || []).push(e);
  });
  Object.keys(byPid).forEach((pid) => { byPid[pid] = projectSharedExpenses(byPid[pid]); });
  return byPid;
}

/**
 * Fold the party's journal legs + opening balance into a billed/received summary,
 * so a caller's `outstanding` equals the ledger's closing balance.
 *
 * The public ledger folds these in; getPortalData did not, which left the portal
 * disagreeing with the ledger for the same client on the same day — a ₹2,00,000
 * receipt booked as a journal voucher instead of a payment kept the portal 2 lakh
 * too high, and a credit opening balance did the same.
 *
 * Credits (JV credits, a Cr opening balance) reduce what is owed, so they are
 * returned as `creditRows` for the money-in list — otherwise `received` would not
 * tie to the rows shown beneath it. Debits are additional charges and get no list
 * of their own (a debit note is not an invoice), so they ride in `billed` and are
 * itemised under `adjustments`.
 *
 * @param {{billed?:number, received?:number, journalRows?:Array, openingBalance?:object|null}} input
 */
function foldPartyLedgerAdjustments({ billed = 0, received = 0, journalRows = [], openingBalance = null } = {}) {
  const jvLabel = (src) => (src === 'credit_note' ? 'Credit Note'
    : src === 'debit_note' ? 'Debit Note'
      : src === 'tds_entry' ? 'TDS' : 'Journal Voucher');

  const rows = Array.isArray(journalRows) ? journalRows : [];
  const creditRows = [];
  if (openingBalance && Number(openingBalance.credit) > 0) {
    creditRows.push({
      date: openingBalance.date || '',
      amount: round2(openingBalance.credit),
      mode: 'Opening Balance',
      ref: openingBalance.remarks || '',
    });
  }
  rows.filter((j) => j && Number(j.credit) > 0).forEach((j) => {
    creditRows.push({
      date: j.date || '',
      amount: round2(j.credit),
      mode: jvLabel(j.source),
      ref: j.voucher_no || '',
    });
  });

  const adjDebit = round2((openingBalance ? Number(openingBalance.debit) || 0 : 0)
    + rows.reduce((s, j) => s + (Number(j && j.debit) || 0), 0));
  const adjCredit = round2(creditRows.reduce((s, r) => s + r.amount, 0));
  const outBilled = round2(Number(billed) + adjDebit);
  const outReceived = round2(Number(received) + adjCredit);

  return {
    billed: outBilled,
    received: outReceived,
    outstanding: round2(outBilled - outReceived),
    adjustments: {
      debit: adjDebit,
      credit: adjCredit,
      entries: rows.length,
      opening_balance: !!openingBalance,
    },
    creditRows,
  };
}

module.exports = {
  partyLegNameSet,
  projectPartyJournalRows,
  projectOpeningBalance,
  foldPartyLedgerAdjustments,
  selectVendorProjectPOs,
  projectSharedExpenses,
  projectSharedReimbursables,
  groupClientSharedExpenses,
};
