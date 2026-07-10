// ─────────────────────────────────────────────────────────────────────────────
// Bank-row → journal draft builder (pure).
// Turns one reconciliation StatementRow into a canonical Transaction that the
// existing validate → human-confirm → postParsedEntry path can post. It builds
// the draft DIRECTLY (no free-text round-trip through parseMessage — bank
// narrations are noisy and misfire the intent classifier).
//
// Contra-account resolution order (best signal first):
//   1. suggestAccountForText  — the user's own learned narration→account map
//   2. single full-coverage party hit → "Party: X" (+ party ref + intent)
//   3. guessExpenseAccount    — keyword → expense account (money-out only)
//   4. "Suspense" + a warning — forces the human to pick before posting
//
// The Bank line always sits on the row's side:
//   direction 'credit' (money in)  → Bank debited, contra credited  → receipt
//   direction 'debit'  (money out) → Bank credited, contra debited  → payment
// ─────────────────────────────────────────────────────────────────────────────

import { round2, inferAccountMeta } from './schema.js';
import { guessExpenseAccount, findPartyCandidates } from './nlu.js';
import { suggestAccountForText } from './learning.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Derive the accountCreates list from the entry lines (mirrors nlu.js). */
function buildAccountCreates(entries) {
  const seen = new Set();
  const out = [];
  for (const line of entries) {
    for (const accName of [line.debitAccount, line.creditAccount]) {
      if (!accName || seen.has(accName)) continue;
      seen.add(accName);
      out.push(inferAccountMeta(accName));
    }
  }
  return out;
}

/**
 * @param {import('./reconcile.js').StatementRow} row
 * @param {{ bankAccountName?: string, partyNames?: string[], learned?: any }} [opts]
 * @returns {import('./schema.js').Transaction}
 */
export function buildRowBookingDraft(row, opts = {}) {
  const { bankAccountName, partyNames = [], learned = null } = opts;
  const bankAcc = (bankAccountName && bankAccountName.trim()) || 'Bank';
  const amount = round2(Math.abs(Number(row?.amount) || 0));
  const direction = row?.direction === 'credit' ? 'credit' : 'debit';
  const desc = String(row?.description || '').trim();
  const ref = String(row?.ref || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(row?.date || '') ? row.date : today();
  const intent = direction === 'credit' ? 'receipt' : 'payment';

  const issues = [];
  let contra = '';
  let party;
  let confidence = 0.4;

  // 1. Learned narration → account (the user's own history).
  const learnedHit = desc && learned ? suggestAccountForText(desc, learned) : null;
  // 2. Sole full-coverage party hit (a real name from the ledger, not noise).
  const cands = desc ? findPartyCandidates(desc, partyNames) : [];
  const soleParty = (cands.length === 1 && (cands[0].coverage ?? 1) >= 1) ? cands[0] : null;

  if (learnedHit && learnedHit.account) {
    contra = learnedHit.account;
    confidence = Math.max(confidence, Number(learnedHit.confidence) || 0.5);
  } else if (soleParty) {
    contra = `Party: ${soleParty.name}`;
    // Guess the party type from direction (money in ≈ client, out ≈ vendor);
    // the human confirms. Avoids the validator's "unknown party" warning for a
    // name we actually recognise.
    party = { type: direction === 'credit' ? 'client' : 'vendor', name: soleParty.name };
    confidence = 0.6;
  } else if (direction === 'debit') {
    contra = guessExpenseAccount(desc);
  } else {
    contra = 'Suspense';
  }

  if (!contra || contra === 'Suspense') {
    contra = 'Suspense';
    confidence = 0.3;
    issues.push({
      level: 'warning',
      code: 'contra_unresolved',
      message: 'Could not infer the other side of this entry — pick the correct account before posting.',
    });
  }

  const line = direction === 'credit'
    ? { debitAccount: bankAcc, creditAccount: contra, amount }
    : { debitAccount: contra, creditAccount: bankAcc, amount };
  const entries = [line];

  const narration = desc || `Bank ${direction === 'credit' ? 'receipt' : 'payment'}${ref ? ` (${ref})` : ''}`;

  return {
    intent,
    type: intent,
    date,
    narration,
    entries,
    party,
    mode: 'Bank',
    accountCreates: buildAccountCreates(entries),
    issues,
    confidence: round2(confidence),
    rawPrompt: desc,
    model: 'reco-v1',
    meta: {
      bankRow: { id: row?.id || null, date, amount, direction, ref, description: desc },
    },
  };
}
