// ─────────────────────────────────────────────────────────────────────────────
// Read-only answer builders for the AI Accountant "show / ledger on demand" layer.
// PURE functions over the accounting snapshot (buildAccountingSnapshot output) — no
// Firestore, no posting. They power conversational answers (party balance, ledger
// on demand, outstanding, GST/TDS liability) and are reusable as LLM tools later.
// Every builder takes an optional `fmt` currency formatter (defaults to String) so
// it stays testable without the app's formatCurrency.
// ─────────────────────────────────────────────────────────────────────────────
import { round2 } from './schema.js';

const SUBLEDGER_RE = /^(Party:|Employee:)\s*/;
const stripPrefix = (account) => String(account || '').replace(SUBLEDGER_RE, '');
const isSubledger = (account) => /^(Party:|Employee:)/.test(String(account || ''));

/**
 * Resolve a free-text subject to ledger account CANDIDATES, deterministically:
 * exact account → exact name-part → (len>=3 only) startsWith → includes, with
 * sub-ledgers (Party:/Employee:) preferred, then shortest name, then locale order.
 * Subjects shorter than 3 chars only match exactly (stops "bs"/"sa" grabbing a
 * random party). Callers treat 1 candidate as a hit, >1 as "did you mean…".
 */
export function resolveAccountCandidates(subject, ledger) {
  const s = String(subject || '').trim().toLowerCase();
  if (!s) return [];
  const accounts = (ledger || []).map((r) => r.account).filter(Boolean);
  const byExact = accounts.filter((a) => a.toLowerCase() === s);
  if (byExact.length) return byExact;
  const byName = accounts.filter((a) => stripPrefix(a).toLowerCase() === s);
  if (byName.length) return byName;
  if (s.length < 3) return [];
  const rank = (a) => {
    const name = stripPrefix(a).toLowerCase();
    if (name.startsWith(s)) return 0;
    if (name.includes(s)) return 1;
    if (a.toLowerCase().includes(s)) return 2;
    return 9;
  };
  return accounts
    .filter((a) => rank(a) < 9)
    .sort((a, b) =>
      rank(a) - rank(b)
      || (isSubledger(b) ? 1 : 0) - (isSubledger(a) ? 1 : 0)
      || a.length - b.length
      || a.localeCompare(b));
}

/**
 * Back-compat single-account resolver: the best candidate (or null). Ambiguity
 * handling belongs to callers via resolveAccountCandidates.
 */
export function resolveAccount(subject, ledger) {
  const c = resolveAccountCandidates(subject, ledger);
  return c.length ? c[0] : null;
}

/** P&L chat answer. `pnl` = snapshot.profitAndLoss (which has NO `expenses` key —
 *  total expenses = COGS + operating expenses). */
export function pnlAnswer(pnl = {}, fmt = String) {
  const revenue = round2(pnl.revenue || 0);
  const expenses = round2((pnl.costOfGoodsSold || 0) + (pnl.operatingExpenses || 0));
  const netProfit = round2(pnl.netProfit || 0);
  return {
    revenue,
    expenses,
    netProfit,
    message: `P&L — Revenue: ${fmt(revenue)} · Expenses: ${fmt(expenses)} · Net: ${fmt(netProfit)}`,
  };
}

/** A single account's entries with a running balance (sorted by date). */
export function buildRunningLedger(row) {
  const entries = [...((row && row.entries) || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let running = 0;
  return entries.map((e) => {
    const dr = e.side === 'Dr' ? (e.amount || 0) : 0;
    const cr = e.side === 'Cr' ? (e.amount || 0) : 0;
    running = round2(running + dr - cr);
    return {
      date: e.date,
      source: e.source,
      voucher_no: e.voucher_no || e.refNo || '',
      contra: e.side === 'Dr' ? e.creditAccount : e.debitAccount,
      debit: dr,
      credit: cr,
      balance: running,
      narration: e.remarks || '',
    };
  });
}

/** "How much do we owe Acme / does Acme owe us / Acme balance". */
export function partyBalanceAnswer(ledger, account, fmt = String) {
  const row = (ledger || []).find((r) => r.account === account);
  if (!row) return null;
  const bal = round2(row.balance || 0);
  const name = stripPrefix(account);
  const sub = isSubledger(account);
  let message;
  if (bal > 0) message = sub ? `${name} owes you ${fmt(bal)} (receivable).` : `${account}: ${fmt(bal)} Dr.`;
  else if (bal < 0) message = sub ? `You owe ${name} ${fmt(Math.abs(bal))} (payable).` : `${account}: ${fmt(Math.abs(bal))} Cr.`;
  else message = `${name} is fully settled — nil balance.`;
  return { account, name, balance: bal, balanceType: bal >= 0 ? 'Dr' : 'Cr', message };
}

/** "Show me / open / print the <X> ledger" — running-balance rows + a download action. */
export function accountLedgerAnswer(ledger, account, fmt = String) {
  const row = (ledger || []).find((r) => r.account === account);
  if (!row) return null;
  const rows = buildRunningLedger(row);
  const closing = round2(row.balance || 0);
  const name = stripPrefix(account);
  const side = closing >= 0 ? 'Dr' : 'Cr';
  return {
    account,
    name,
    rows,
    closing,
    closingType: side,
    message: rows.length
      ? `${name} ledger — ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}, closing balance ${fmt(Math.abs(closing))} ${side}.`
      : `${name} has no posted entries yet.`,
    action: { type: 'download_ledger', account },
  };
}

/** Top outstanding receivables / payables. Client/vendor (Party:) AR/AP stays
 *  separate from employee balances — employees are reported as their own line
 *  (mirrors the balance sheet, which never lumps staff into AR/AP). */
export function outstandingAnswer(ledger, kind, fmt = String, topN = 8) {
  const rows = (ledger || []).filter((r) => /^Party:/.test(r.account) && Math.abs(r.balance || 0) > 0.5);
  const empRows = (ledger || []).filter((r) => /^Employee:/.test(r.account) && Math.abs(r.balance || 0) > 0.5);
  const receivables = rows.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance);
  const payables = rows.filter((r) => r.balance < 0).sort((a, b) => a.balance - b.balance);
  const totalRecv = round2(receivables.reduce((s, r) => s + r.balance, 0));
  const totalPay = round2(payables.reduce((s, r) => s + Math.abs(r.balance), 0));
  const empAdvances = round2(empRows.reduce((s, r) => s + Math.max(r.balance, 0), 0));
  const empOwed = round2(empRows.reduce((s, r) => s + Math.max(-r.balance, 0), 0));
  const empNote = (empAdvances > 0.5 || empOwed > 0.5)
    ? ` Employees: advances recoverable ${fmt(empAdvances)} · owed to staff ${fmt(empOwed)}.`
    : '';
  const list = (arr, fn) => arr.slice(0, topN).map((r) => `${stripPrefix(r.account)}: ${fmt(fn(r.balance))}`).join(' · ');
  let message;
  if (kind === 'payable') {
    message = (payables.length ? `You owe ${fmt(totalPay)} across ${payables.length} parties. Top: ${list(payables, Math.abs)}.` : 'You have no outstanding payables.') + empNote;
  } else if (kind === 'receivable') {
    message = (receivables.length ? `${fmt(totalRecv)} is receivable across ${receivables.length} parties. Top: ${list(receivables, (x) => x)}.` : 'Nothing is currently receivable.') + empNote;
  } else {
    message = `Receivable ${fmt(totalRecv)} · Payable ${fmt(totalPay)}. Net ${fmt(round2(totalRecv - totalPay))}.${empNote}`;
  }
  return { totalReceivable: totalRecv, totalPayable: totalPay, receivables, payables, employeeAdvances: empAdvances, employeePayable: empOwed, message };
}

/** GST payable this period (output − input credit) from the balance sheet rollup. */
export function gstLiabilityAnswer(balanceSheet, fmt = String) {
  const liab = (balanceSheet && balanceSheet.liabilities) || {};
  const asset = (balanceSheet && balanceSheet.assets) || {};
  const payable = round2(liab.gstPayable || 0);
  const credit = round2(asset.inputGstCredit || 0);
  return {
    gstPayable: payable,
    inputCredit: credit,
    message: payable > 0
      ? `GST payable: ${fmt(payable)} (output GST net of ${fmt(credit)} input credit).`
      : `No net GST payable — input credit (${fmt(credit)}) covers output GST.`,
  };
}

/**
 * Compact, READ-ONLY digest of the books for the LLM ask-anything agent — "all
 * the read tools pre-executed": statements + capped account/party balances +
 * aging + GST/TDS. Pure; nothing here can post or write.
 * @param {object} snapshot buildAccountingSnapshot output
 * @param {{ asOn?:string, fy?:string, ageing?:object }} [extras]
 */
export function buildBooksDigest(snapshot = {}, extras = {}) {
  const ledger = Array.isArray(snapshot.ledger) ? snapshot.ledger : [];
  // Cash/bank sums exclude expense accounts that merely CONTAIN the word
  // ("Bank Charges" must not pollute the bank figure).
  const bal = (re) => ledger.filter((r) => re.test(r.account) && !/charge|fee|loan/i.test(r.account)).reduce((s, r) => s + (r.balance || 0), 0);
  const nonZero = ledger.filter((r) => Math.abs(r.balance || 0) > 0.5);
  const parties = nonZero.filter((r) => /^Party:/.test(r.account));
  const empRows = nonZero.filter((r) => /^Employee:/.test(r.account));
  const tb = snapshot.trialBalance || {};
  const tdsRow = ledger.find((r) => r.account === 'TDS Payable');
  return {
    as_on: extras.asOn || new Date().toISOString().slice(0, 10),
    fy: extras.fy || 'all',
    profit_and_loss: snapshot.profitAndLoss || {},
    balance_sheet: snapshot.balanceSheet || {},
    trial_balance: { totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, isBalanced: tb.isBalanced, difference: tb.difference },
    cash: round2(bal(/^cash/i)),
    bank: round2(bal(/^bank/i)),
    accounts: nonZero.slice(0, 250).map((r) => ({ a: r.account, bal: round2(r.balance) })),
    receivables: parties.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 40).map((r) => ({ name: stripPrefix(r.account), bal: round2(r.balance) })),
    payables: parties.filter((r) => r.balance < 0).sort((a, b) => a.balance - b.balance).slice(0, 40).map((r) => ({ name: stripPrefix(r.account), bal: round2(Math.abs(r.balance)) })),
    employee_receivables: empRows.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 20).map((r) => ({ name: stripPrefix(r.account), bal: round2(r.balance) })),
    employee_payables: empRows.filter((r) => r.balance < 0).sort((a, b) => a.balance - b.balance).slice(0, 20).map((r) => ({ name: stripPrefix(r.account), bal: round2(Math.abs(r.balance)) })),
    gst_payable: round2(snapshot.balanceSheet?.liabilities?.gstPayable || 0),
    tds_payable: tdsRow ? round2(Math.abs(Math.min(tdsRow.balance || 0, 0))) : 0,
    aging: extras.ageing ? {
      receivable_total: round2(extras.ageing.receivableTotals?.total || 0),
      receivable_90plus: round2(extras.ageing.receivableTotals?.['90_plus'] || 0),
      payable_total: round2(extras.ageing.payableTotals?.total || 0),
      payable_90plus: round2(extras.ageing.payableTotals?.['90_plus'] || 0),
    } : null,
  };
}

/** TDS payable (deducted, yet to deposit) from the TDS Payable ledger balance. */
export function tdsLiabilityAnswer(ledger, fmt = String) {
  const row = (ledger || []).find((r) => r.account === 'TDS Payable');
  const payable = row ? round2(Math.abs(Math.min(row.balance || 0, 0))) : 0;
  const receivable = (() => {
    const r = (ledger || []).find((x) => x.account === 'TDS Receivable');
    return r ? round2(Math.max(r.balance || 0, 0)) : 0;
  })();
  return {
    tdsPayable: payable,
    tdsReceivable: receivable,
    message: `TDS payable (to deposit): ${fmt(payable)}. TDS receivable (claim at ITR): ${fmt(receivable)}.`,
  };
}
