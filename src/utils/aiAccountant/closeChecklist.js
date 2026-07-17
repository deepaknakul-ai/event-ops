// ─────────────────────────────────────────────────────────────────────────────
// Proactive close checklist + compliance calendar (Phase 4 of "Full Accountant").
// PURE and read-only: given the books-audit result + drafts + posted entries +
// the sales book, computes (a) a month/year-end close-readiness checklist and
// (b) upcoming GST/TDS statutory deadlines. Advisory only — the terminal action
// remains the existing human-driven closeFinancialYear.
// ─────────────────────────────────────────────────────────────────────────────
import { round2 } from './schema.js';

const isAiEntry = (e) => e?.origin === 'ai_chat' || e?.source === 'chat_entry' || e?.source === 'scheduled_post';
const monthOf = (iso) => String(iso || '').slice(0, 7);
const prevMonth = (m) => {
  const [y, mm] = String(m).split('-').map(Number);
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
};
// Statutory due date = <day> of the month AFTER the period (timezone-safe string math).
const dueDate = (period, day) => {
  const [y, mm] = String(period).split('-').map(Number);
  const ny = mm === 12 ? y + 1 : y;
  const nm = mm === 12 ? 1 : mm + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** Upcoming GST/TDS deadlines for the current + previous period, from real activity. */
export function buildComplianceCalendar({ entries = [], salesBook = [], today } = {}) {
  const t = today || new Date().toISOString().slice(0, 10);
  const months = [prevMonth(monthOf(t)), monthOf(t)];

  const tdsByMonth = {};
  entries.forEach((e) => (e.entries || []).forEach((l) => {
    if (l.creditAccount !== 'TDS Payable') return;
    const m = monthOf(e.date);
    if (m) tdsByMonth[m] = (tdsByMonth[m] || 0) + (Number(l.amount) || 0);
  }));
  const salesMonths = new Set(salesBook.map((r) => monthOf(r.date)).filter(Boolean));

  const cal = [];
  months.forEach((m) => {
    if ((tdsByMonth[m] || 0) > 0.5) {
      cal.push({ kind: 'tds', period: m, due: dueDate(m, 7), label: `Deposit TDS for ${m}`, amount: round2(tdsByMonth[m]) });
    }
    if (salesMonths.has(m)) {
      cal.push({ kind: 'gstr1', period: m, due: dueDate(m, 11), label: `File GSTR-1 for ${m}` });
      cal.push({ kind: 'gstr3b', period: m, due: dueDate(m, 20), label: `File GSTR-3B + pay GST for ${m}` });
    }
  });
  cal.forEach((c) => { c.overdue = c.due < t; });
  return cal.sort((a, b) => a.due.localeCompare(b.due));
}

/**
 * Close-readiness checklist. `audit` = runBooksAudit output (already computed).
 * @returns {{ ready:boolean, items:Array<{id,label,status:'ok'|'warn'|'block'|'manual',detail,hint?}>, calendar:Array }}
 */
export function buildCloseChecklist({ audit, drafts = [], entries = [], salesBook = [], today } = {}) {
  const findings = (audit && audit.findings) || [];
  const byCode = (code) => findings.filter((f) => f.code === code);
  const blocking = findings.filter((f) => f.severity === 'blocking');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const unreviewedAi = entries.filter((e) => isAiEntry(e) && !e.ai_reviewed).length;

  const items = [
    {
      id: 'trial_balanced',
      label: 'Trial balance is balanced',
      status: audit && audit.summary && audit.summary.trialBalanced === false ? 'block' : 'ok',
      detail: audit?.summary?.trialBalanced === false ? 'Debits ≠ credits — the books cannot be closed.' : 'Debits equal credits.',
      hint: 'Accounts → Audit shows the imbalance.',
    },
    {
      id: 'no_blocking',
      label: 'No blocking audit findings',
      status: blocking.length ? 'block' : 'ok',
      detail: blocking.length ? `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} open.` : 'Audit shows nothing blocking.',
      hint: 'Fix them from Accounts → Audit before closing.',
    },
    {
      id: 'audit_warnings',
      label: 'Audit warnings resolved',
      status: warnings.length ? 'warn' : 'ok',
      detail: warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'} open (Suspense, duplicates, stale AR/AP…).` : 'No open warnings.',
      hint: 'Recommended before close; not strictly blocking.',
    },
    {
      id: 'drafts_clear',
      label: 'All drafts posted or discarded',
      status: drafts.length ? 'warn' : 'ok',
      detail: drafts.length ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'} pending.` : 'Draft queue is empty.',
      hint: 'Accounts → Approvals / All Entries.',
    },
    {
      id: 'ai_reviewed',
      label: 'AI entries reviewed',
      status: unreviewedAi ? 'warn' : 'ok',
      detail: unreviewedAi ? `${unreviewedAi} AI entr${unreviewedAi === 1 ? 'y' : 'ies'} unreviewed.` : 'All AI entries signed off.',
      hint: 'Accounts → AI Entries.',
    },
    {
      id: 'gst_settled',
      label: 'GST filed & paid',
      status: byCode('gst_outstanding').length ? 'warn' : 'ok',
      detail: byCode('gst_outstanding').length ? 'GST payable is outstanding.' : 'No net GST payable.',
      hint: 'GSTR-3B by the 20th of next month.',
    },
    {
      id: 'tds_deposited',
      label: 'TDS deposited',
      status: byCode('tds_outstanding').length ? 'warn' : 'ok',
      detail: byCode('tds_outstanding').length ? 'Deducted TDS not yet deposited.' : 'No TDS pending deposit.',
      hint: 'Deposit by the 7th of next month.',
    },
    {
      id: 'bank_reconciled',
      label: 'Bank statement reconciled',
      status: 'manual',
      detail: 'Verify the latest statement is matched and the closing balance ties.',
      hint: 'Accounts → Bank Reconciliation.',
    },
  ];

  const ready = !items.some((i) => i.status === 'block');
  const calendar = buildComplianceCalendar({ entries, salesBook, today });
  return { ready, items, calendar };
}
