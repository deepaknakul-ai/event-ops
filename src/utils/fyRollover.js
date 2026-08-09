/**
 * FY-close rollover — pure, testable.
 *
 * When a financial year is closed we carry the CLOSING balances forward as next
 * year's opening balances. Two rules that were previously missing and silently
 * lost the year's profit:
 *
 *  1. The closing voucher (Dr 'Profit And Loss Closing' / Cr 'Retained Earnings')
 *     is written in the SAME batch as the rollover, so the ledger snapshot the
 *     rollover is built from does NOT yet contain it. Nothing re-applied it, so
 *     Retained Earnings rolled forward at its PRE-transfer value (usually 0) and
 *     the profit was never carried at all. Because every opening balance is posted
 *     against the 'Opening Balance Equity' contra, the missing amount was silently
 *     absorbed there — leaving Retained Earnings at ~0 year after year while
 *     Opening Balance Equity ballooned. The accounting equation still balanced,
 *     so nothing ever flagged it.
 *
 *  2. 'Profit And Loss Closing' is a WITHIN-YEAR clearing account. Carrying its
 *     post-transfer debit forward would exactly cancel the Retained Earnings
 *     credit and strand the profit again, so it is never rolled.
 *
 * Nominal (Income/Expense) accounts are correctly not carried — they reset each
 * year, and their net result is precisely what lands in Retained Earnings.
 *
 * Ledger convention: balance = debit − credit. Equity sits on the credit side, so
 * a credit to Retained Earnings makes its balance MORE NEGATIVE.
 */

export const PL_CLOSING_ACCOUNT = 'Profit And Loss Closing';
export const RETAINED_EARNINGS_ACCOUNT = 'Retained Earnings';

const norm = (s) => String(s || '').trim().toLowerCase();
const ROLLED_TYPES = new Set(['Asset', 'Liability', 'Equity']);

/**
 * @param {object[]} ledger        snapshot.ledger (rows: { account, accountId?, balance })
 * @param {(account:string)=>string} typeOf  resolves an account name to its CoA type
 * @param {number} netProfit       the closing year's net profit (negative = loss)
 * @param {boolean} hasTransfer    whether a closing transfer voucher is being posted
 * @returns {object[]} rows to write as next-FY opening balances
 */
export const computeFyRolloverRows = ({ ledger = [], typeOf, netProfit = 0, hasTransfer = true }) => {
  const rows = (ledger || [])
    .filter((row) => row && Math.abs(Number(row.balance) || 0) > 0.009)
    .filter((row) => ROLLED_TYPES.has(typeOf(row.account)))
    .filter((row) => norm(row.account) !== norm(PL_CLOSING_ACCOUNT));

  if (!hasTransfer) return rows;

  const existing = (ledger || []).find((r) => r && norm(r.account) === norm(RETAINED_EARNINGS_ACCOUNT));
  const closedReBalance = (Number(existing?.balance) || 0) - (Number(netProfit) || 0);
  const idx = rows.findIndex((r) => norm(r.account) === norm(RETAINED_EARNINGS_ACCOUNT));

  if (Math.abs(closedReBalance) <= 0.009) {
    if (idx >= 0) rows.splice(idx, 1);
    return rows;
  }
  const reRow = { account: RETAINED_EARNINGS_ACCOUNT, accountId: null, balance: closedReBalance };
  if (idx >= 0) rows[idx] = { ...rows[idx], ...reRow };
  else rows.push(reRow);
  return rows;
};

/** Net Dr−Cr of a rollover set. Whatever is left over is what the
 *  'Opening Balance Equity' contra will absorb in the next year. */
export const rolloverImbalance = (rows = []) =>
  Math.round(rows.reduce((s, r) => s + (Number(r.balance) || 0), 0) * 100) / 100;
