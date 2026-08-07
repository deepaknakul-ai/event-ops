/**
 * Cross-tenant credit-worthiness scoring — PURE, no firebase.
 *
 * Safe to require under vitest (mirrors the pure exports of platform.js). The
 * nightly platform.computeCreditScores() job reads each tenant's books and feeds
 * the raw docs through these functions; nothing here touches Firestore, the
 * clock (asOf is always injected), or the network — so every function is
 * deterministic and table-testable.
 *
 * Model in one line: a party is scored **as a payer** (receivables). We derive a
 * per-(tenant,party) observation from that tenant's sales invoices + receipts,
 * aggregate all observations for the same legal entity across tenants (matched by
 * PAN), turn the aggregate into six 0..100 sub-scores, and collapse those to a
 * single 0..100 composite and a colour band. Only the band is ever shown to a
 * tenant; the number stays in the control plane.
 *
 * Higher sub-score / composite == SAFER (100 = pays on time, nothing overdue).
 */
'use strict';

// Match window / thresholds. Tunable; kept here so tests pin them explicitly.
const DAY_MS = 86400000;
const OVERDUE_CAP_RATIO = 0.5;    // overdue/billed at/above which `overdueRatio` bottoms out
const DELINQ_CAP_RATIO = 0.25;    // 90+/billed at/above which `delinquency` bottoms out
const REMINDER_STEP = 15;         // points lost per dunning reminder sent
const DEFAULT_TERM_DAYS = 15;     // fallback net term when neither due_date nor billing_terms exist (matches Clients.jsx)

// `delay` sub-score curve — avg days-late → 0..100, anchored to the D&B PAYDEX
// Days-Beyond-Terms shape (convex, still discriminates past 60 days) instead of
// a straight line that flattens everything ≥60d to 0. Green≈within terms,
// Amber≈≤~1 month late, Red≈chronic. Interpolated by interp(); floors at 5.
const DELAY_ANCHORS = [[0, 100], [15, 85], [30, 65], [45, 50], [60, 40], [90, 20], [120, 5]];

// `worstDelinquency` — the single worst days-late ever seen (peak bucket is more
// predictive than the mean). Bottoms out at 90 days.
const WORST_CAP_DAYS = 90;

// `trend` / Outlook — compare amount-weighted days-late in the recent window vs
// before it. Positive delta (recent < prior) = improving.
const TREND_WINDOW_DAYS = 180;    // "recent" = cleared/aged within this of asOf
const TREND_K = 1.5;              // trend sub-score points per day of improvement
const TREND_FLAT = 7;             // |delta| ≤ this → Outlook 'stable'

// India statutory reality.
const MSME_CAP_DAYS = 45;         // MSMED Act §15 hard cap to pay a micro/small supplier
const MSME_CAP_NO_TERMS_DAYS = 15;// §15 cap when there is no written agreement
const BEYOND_LIMIT_DAYS = 45;     // invoices paid/held past this breach the MSME limit (§43B(h))
const TIME_BARRED_DAYS = 1095;    // Limitation Act 1963 — >3y past due is unenforceable

// "Enough to judge" floors — below these a party is Gray (unrated), not Red.
const MIN_INVOICES = 3;
const MIN_BILLED = 10000;         // ₹10k of billing before a score is meaningful
const MIN_TENURE_DAYS = 60;       // relationship younger than this stays unrated

// Materiality for the hard-Red default override: a persistent 90+ balance that
// is both large in absolute terms AND a big slice of billing.
const DEFAULT_FLOOR = 50000;      // ₹50k
const DEFAULT_RATIO = 0.25;

// Composite weights (sum = 1). tenure is a small bonus, not a core weight, so
// "old relationship" alone can never buy a good score. v2 spreads the three
// open-balance factors (overdue/delinquency/defaultRisk) apart and adds two
// orthogonal signals — worst-ever peak and payment trend.
const WEIGHTS = {
  delay: 0.30, overdueRatio: 0.18, delinquency: 0.14,
  worstDelinquency: 0.10, trend: 0.10, chronic: 0.08, defaultRisk: 0.10,
};
const TENURE_BONUS_MAX = 5;

// Bayesian shrinkage toward a prior when the sample is thin, so a single late
// invoice can't floor a party (or a single prompt one crown it). The nightly job
// overrides the prior with the observed portfolio mean; 50 (neutral) is the
// standalone default.
const SHRINK_PRIOR = 50;
const SHRINK_WEIGHT = 4;

const BANDS = { GREEN: 'green', AMBER: 'amber', RED: 'red', GRAY: 'gray' };
const GREEN_MIN = 70;
const AMBER_MIN = 40;

const GSTIN_CHECKSUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => (Number.isFinite(v) ? v : 0);
const earlierIso = (a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b);

// Piecewise-linear interpolation over sorted [x, y] anchor points. Clamps flat
// beyond both ends. Used for the PAYDEX-style delay curve.
function interp(x, points) {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
  }
  return last[1];
}

// Human ₹ formatting for reason codes (Indian grouping).
const inr = (v) => '₹' + Math.round(num(v)).toLocaleString('en-IN');

// Whole days from `fromISO` to `toISO` (negative if from is later). Bad dates → 0.
function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO).getTime();
  const b = new Date(toISO).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / DAY_MS);
}

function addDays(iso, days) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  return new Date(t + days * DAY_MS).toISOString();
}

// The one identity key of the bureau. A GSTIN embeds the entity's 10-char PAN at
// positions 2..11; PAN is stable across a business's multiple state GSTINs, so it
// unifies a multi-state entity that a raw GSTIN would fragment. Returns the PAN,
// or null when the GSTIN is malformed / checksum-invalid (so a typo'd id can
// never merge two different parties). Mirrors validateGSTIN in src/utils/helpers.js.
function panFromGstin(gstin) {
  if (!gstin) return null;
  const norm = String(gstin).trim().toUpperCase().replace(/\s+/g, '');
  if (norm.length !== 15 || !GSTIN_RE.test(norm)) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHECKSUM_CHARS.indexOf(norm[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  const expected = GSTIN_CHECKSUM_CHARS[(36 - (sum % 36)) % 36];
  if (norm[14] !== expected) return null;
  return norm.substring(2, 12);
}

// Net term days from a billing_terms string ("Net 15" → 15). Falls back to
// DEFAULT_TERM_DAYS. Mirrors the parse in src/pages/Clients.jsx:83.
function termDaysFromBillingTerms(billingTerms) {
  const m = /(\d+)/.exec(String(billingTerms || ''));
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TERM_DAYS;
}

// Ageing bucket for a number of days outstanding (identical boundaries to the
// app's FIFO ageing in src/pages/Accounting.jsx).
function ageBucket(days) {
  if (days <= 30) return '0_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

// FIFO-match receipts against invoices by date (oldest invoice paid first) — the
// only way this data model can attribute a payment to an invoice (there is no
// invoice_id link on payments). Returns each invoice enriched with how much was
// paid, the date it was fully cleared (null if still open), and what remains.
// Overpayment / advances beyond the invoice set are ignored for ageing.
function fifoMatch(invoices, payments) {
  const inv = (invoices || [])
    .map((i) => ({ amount: num(i.amount), date: i.date, due: i.due, remaining: num(i.amount), paid: 0, clearedDate: null }))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const pays = (payments || [])
    .map((p) => ({ amount: num(p.amount), date: p.date }))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  for (const p of pays) {
    let amt = p.amount;
    for (const i of inv) {
      if (amt <= 0.005) break;
      if (i.remaining <= 0.005) continue;
      const m = Math.min(i.remaining, amt);
      i.remaining -= m;
      i.paid += m;
      amt -= m;
      if (i.remaining <= 0.005) i.clearedDate = p.date; // the receipt that cleared it
    }
  }
  return inv.map((i) => ({
    amount: i.amount,
    date: i.date,
    due: i.due,
    paidAmount: i.paid,
    outstanding: Math.max(0, i.remaining),
    clearedDate: i.clearedDate,
  }));
}

// Derive ONE tenant's experience with ONE party into a raw observation. Inputs:
//   invoices : [{ amount, date(=invoice_date), dueDate? }] — Active client-role sales invoices
//   payments : [{ amount, date }]                          — receipts from this party
//   reminderCount : cumulative dunning reminders (reminder_log.count)
//   termDays : net term for due-date fallback when an invoice has no dueDate
//   supplierMsme : is the REPORTING TENANT (the supplier) a micro/small MSME? If
//                  so, the statutory due date is capped at 45 days (15 with no
//                  written terms) — MSMED §15 / IT §43B(h) — so a buyer who pays
//                  MSME suppliers late is correctly scored worse.
//   hasTerms : does the party carry written billing terms? (drives the 45 vs 15 cap)
//   asOf     : ISO run date (all "days late/overdue" measured against this)
function computePartyObservation({ invoices = [], payments = [], reminderCount = 0, termDays = DEFAULT_TERM_DAYS, supplierMsme = false, hasTerms = true, asOf }) {
  const withDue = invoices.map((i) => {
    let due = i.dueDate || addDays(i.date, termDays);
    if (supplierMsme && i.date) due = earlierIso(due, addDays(i.date, hasTerms ? MSME_CAP_DAYS : MSME_CAP_NO_TERMS_DAYS));
    return { amount: num(i.amount), date: i.date, due };
  });
  const matched = fifoMatch(withDue, payments);

  let billed = 0;
  let outstanding = 0;
  let overdueAmt = 0;
  let ninetyPlus = 0;
  let weightSum = 0;   // Σ amount (excl. time-barred)
  let lateSum = 0;     // Σ amount * daysLate (excl. time-barred)
  let maxDaysLate = 0; // worst-ever, INCLUDING time-barred (historical black mark)
  let beyond45Amt = 0; // Σ amount breaching the MSME 45-day limit
  let timeBarredAmt = 0; // open balance now legally unenforceable (>3y)
  let recentW = 0; let recentLate = 0; // trend windows (amount-weighted)
  let priorW = 0; let priorLate = 0;
  let firstSeen = null;
  let lastActivity = null;

  const touch = (d) => {
    if (!d) return;
    if (!firstSeen || d < firstSeen) firstSeen = d;
    if (!lastActivity || d > lastActivity) lastActivity = d;
  };

  for (const inv of matched) {
    billed += inv.amount;
    touch(inv.date);
    touch(inv.clearedDate);
    const open = inv.outstanding > 0.005;
    // Days late: for a cleared invoice, how long past due it was paid; for an
    // open invoice, how long past due it has been sitting as of asOf.
    const refDate = open ? asOf : inv.clearedDate;
    const daysLate = Math.max(0, daysBetween(inv.due, refDate));
    if (daysLate > maxDaysLate) maxDaysLate = daysLate;               // worst-ever (incl. time-barred)
    if (supplierMsme && daysLate > BEYOND_LIMIT_DAYS) beyond45Amt += inv.amount;

    const overdueDays = open ? daysBetween(inv.due, asOf) : 0;
    if (open && overdueDays > TIME_BARRED_DAYS) {
      // Time-barred: not collectible exposure and excluded from the delay mean so
      // one ancient invoice can't dominate — but it stays in maxDaysLate above.
      timeBarredAmt += inv.outstanding;
      continue;
    }

    weightSum += inv.amount;
    lateSum += inv.amount * daysLate;
    // Trend window: bucket by how recent the reference date is.
    const recent = refDate ? daysBetween(refDate, asOf) <= TREND_WINDOW_DAYS : false;
    if (recent) { recentW += inv.amount; recentLate += inv.amount * daysLate; }
    else { priorW += inv.amount; priorLate += inv.amount * daysLate; }

    if (open) {
      outstanding += inv.outstanding;
      if (overdueDays > 0) overdueAmt += inv.outstanding;
      if (overdueDays > 90) ninetyPlus += inv.outstanding;
    }
  }
  for (const p of payments) touch(p.date);

  const received = payments.reduce((s, p) => s + num(p.amount), 0);
  return {
    billed,
    received,
    outstanding,
    overdueAmt,
    ninetyPlus,
    avgDaysLate: weightSum > 0 ? lateSum / weightSum : 0,
    maxDaysLate,
    recentDaysLate: recentW > 0 ? recentLate / recentW : null,
    priorDaysLate: priorW > 0 ? priorLate / priorW : null,
    recentBilled: recentW,
    priorBilled: priorW,
    beyond45Amt,
    timeBarredAmt,
    invoiceCount: matched.length,
    reminderCount: num(reminderCount),
    firstSeen,
    lastActivity,
  };
}

// Combine every tenant's observation for the same PAN into one aggregate. Volume
// (billed) weights the delay average so a ₹10L exposure outweighs a ₹10k one;
// activity older than 12 months is down-weighted (recency decay) so ancient
// behaviour doesn't dominate a party who has since reformed (or slipped).
function aggregateObservations(observations, { asOf } = {}) {
  const obs = (observations || []).filter(Boolean);
  const agg = {
    billed: 0, received: 0, outstanding: 0, overdueAmt: 0, ninetyPlus: 0,
    reminderCount: 0, invoiceCount: 0, firstSeen: null, lastActivity: null,
    weightedDaysLate: 0, maxDaysLate: 0, beyond45Amt: 0, timeBarredAmt: 0,
    recentDaysLate: null, priorDaysLate: null,
  };
  let wLate = 0;   // Σ (billed * decay)
  let wLateSum = 0; // Σ (avgDaysLate * billed * decay)
  let rW = 0; let rSum = 0; // recent trend window (billed-weighted across tenants)
  let pW = 0; let pSum = 0; // prior trend window
  for (const o of obs) {
    agg.billed += num(o.billed);
    agg.received += num(o.received);
    agg.outstanding += num(o.outstanding);
    agg.overdueAmt += num(o.overdueAmt);
    agg.ninetyPlus += num(o.ninetyPlus);
    agg.reminderCount += num(o.reminderCount);
    agg.invoiceCount += num(o.invoiceCount);
    agg.beyond45Amt += num(o.beyond45Amt);
    agg.timeBarredAmt += num(o.timeBarredAmt);
    if (num(o.maxDaysLate) > agg.maxDaysLate) agg.maxDaysLate = num(o.maxDaysLate);
    if (o.firstSeen && (!agg.firstSeen || o.firstSeen < agg.firstSeen)) agg.firstSeen = o.firstSeen;
    if (o.lastActivity && (!agg.lastActivity || o.lastActivity > agg.lastActivity)) agg.lastActivity = o.lastActivity;

    const recent = asOf && o.lastActivity ? daysBetween(o.lastActivity, asOf) <= 365 : true;
    const decay = recent ? 1 : 0.5;
    const w = num(o.billed) * decay;
    wLate += w;
    wLateSum += num(o.avgDaysLate) * w;

    if (o.recentDaysLate != null) { rW += num(o.recentBilled); rSum += num(o.recentDaysLate) * num(o.recentBilled); }
    if (o.priorDaysLate != null) { pW += num(o.priorBilled); pSum += num(o.priorDaysLate) * num(o.priorBilled); }
  }
  agg.weightedDaysLate = wLate > 0 ? wLateSum / wLate : 0;
  agg.recentDaysLate = rW > 0 ? rSum / rW : null;
  agg.priorDaysLate = pW > 0 ? pSum / pW : null;
  agg.sample_size = agg.invoiceCount;
  agg.confidence = (agg.invoiceCount >= 6 && agg.billed >= MIN_BILLED) ? 'high' : 'low';
  return agg;
}

// Seven explainable 0..100 sub-scores from an aggregate (100 = safest on that axis).
function scoreFactors(agg) {
  const a = agg || {};
  const billed = num(a.billed);
  const overdueRatio = billed > 0 ? num(a.overdueAmt) / billed : 0;
  const delinqRatio = billed > 0 ? num(a.ninetyPlus) / billed : 0;
  const beyond45Ratio = billed > 0 ? num(a.beyond45Amt) / billed : 0;
  const material = num(a.ninetyPlus) >= DEFAULT_FLOOR && delinqRatio > 0.1;

  const delay = clamp(interp(num(a.weightedDaysLate), DELAY_ANCHORS), 0, 100);
  const overdue = clamp(100 - (overdueRatio / OVERDUE_CAP_RATIO) * 100, 0, 100);
  const delinquency = clamp(100 - (delinqRatio / DELINQ_CAP_RATIO) * 100, 0, 100);
  const worstDelinquency = clamp(100 - (num(a.maxDaysLate) / WORST_CAP_DAYS) * 100, 0, 100);
  const chronic = clamp(100 - num(a.reminderCount) * REMINDER_STEP, 0, 100);
  // Trend: recent vs prior amount-weighted days-late. Neutral when a window is
  // empty (a party with only-recent or only-old history has no measurable trend).
  let trend = 50;
  if (a.recentDaysLate != null && a.priorDaysLate != null) {
    trend = clamp(50 + TREND_K * (num(a.priorDaysLate) - num(a.recentDaysLate)), 0, 100);
  }
  // defaultRisk bites once a 90+ balance is material; the MSME 45-day breach ratio
  // nudges it down further (a buyer stiffing statutory MSME dues is riskier).
  let defaultRisk = material ? clamp(100 - (delinqRatio / OVERDUE_CAP_RATIO) * 100, 0, 100) : 100;
  defaultRisk = clamp(defaultRisk - beyond45Ratio * 20, 0, 100);
  const tenure = 100; // tenure enters via the bonus in baseScore, not as a weighted factor

  return { delay, overdueRatio: overdue, delinquency, worstDelinquency, trend, chronic, defaultRisk, tenure };
}

// The unshrunk 0..100 base: weighted sub-scores + the tenure bonus. The nightly
// job means these across the portfolio to set the shrinkage prior (two-pass).
function baseScore(factors, agg, { asOf } = {}) {
  const f = factors || {};
  let base = 0;
  for (const k of Object.keys(WEIGHTS)) base += num(f[k]) * WEIGHTS[k];
  const tenureDays = asOf && agg && agg.firstSeen ? Math.max(0, daysBetween(agg.firstSeen, asOf)) : 0;
  const tenureBonus = (clamp((tenureDays / 730) * 100, 0, 100) / 100) * TENURE_BONUS_MAX;
  return clamp(base + tenureBonus, 0, 100);
}

// Collapse to a single 0..100, applying thin-sample shrinkage toward `prior`
// (the portfolio mean when the job supplies it; neutral 50 otherwise).
function compositeScore(factors, agg, { asOf, prior = SHRINK_PRIOR } = {}) {
  const raw = baseScore(factors, agg, { asOf });
  const n = agg ? num(agg.sample_size || agg.invoiceCount) : 0;
  const shrunk = (raw * n + prior * SHRINK_WEIGHT) / (n + SHRINK_WEIGHT);
  return clamp(Math.round(shrunk), 0, 100);
}

// Outlook from the trend windows: improving / stable / worsening.
function outlookFor(agg) {
  const a = agg || {};
  if (a.recentDaysLate == null || a.priorDaysLate == null) return 'stable';
  const delta = num(a.priorDaysLate) - num(a.recentDaysLate);
  return delta > TREND_FLAT ? 'improving' : delta < -TREND_FLAT ? 'worsening' : 'stable';
}

// Top ≤4 human-readable "why this band" reasons (staff-only). Hard-override
// reasons (material default, time-barred, MSME breach) come first; then the
// factors whose weighted shortfall from 100 is largest.
function deriveReasons(factors, agg) {
  const a = agg || {};
  const f = factors || {};
  const billed = num(a.billed);
  const delinqRatio = billed > 0 ? num(a.ninetyPlus) / billed : 0;
  const out = [];
  if (num(a.ninetyPlus) >= DEFAULT_FLOOR && delinqRatio > DEFAULT_RATIO) out.push(`${inr(a.ninetyPlus)} in 90+ arrears (material default)`);
  if (num(a.timeBarredAmt) > 0) out.push(`${inr(a.timeBarredAmt)} in debt now time-barred (>3y)`);
  if (num(a.beyond45Amt) > 0 && billed > 0 && a.beyond45Amt / billed > 0.25) out.push('pays MSME dues beyond the 45-day statutory limit');

  const label = {
    delay: `pays ~${Math.round(num(a.weightedDaysLate))} days beyond due`,
    overdueRatio: `${Math.round((num(a.overdueAmt) / Math.max(1, billed)) * 100)}% of billings overdue`,
    delinquency: `${inr(a.ninetyPlus)} in 90+ arrears`,
    worstDelinquency: `was once ${Math.round(num(a.maxDaysLate))} days late`,
    trend: 'payment behaviour worsening',
    chronic: `${Math.round(num(a.reminderCount))} dunning reminder(s) issued`,
    defaultRisk: 'elevated default risk',
  };
  const ranked = Object.keys(WEIGHTS)
    .map((k) => ({ k, shortfall: WEIGHTS[k] * (100 - num(f[k])) }))
    .sort((x, y) => y.shortfall - x.shortfall);
  for (const { k, shortfall } of ranked) {
    if (out.length >= 4) break;
    if (shortfall < 3) continue;                       // ignore trivial shortfalls
    if (k === 'trend' && num(f.trend) >= 50) continue; // only cite trend when actually worsening
    const t = label[k];
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 4);
}

// Final band. Gray wins for insufficient evidence (too few invoices, trivial
// billing, brand-new relationship). A material persistent default forces Red
// regardless of the composite. Otherwise thresholds on the composite.
function bandForScore(score, agg, { asOf } = {}) {
  const a = agg || {};
  const tenureDays = asOf && a.firstSeen ? daysBetween(a.firstSeen, asOf) : Infinity;
  if (num(a.invoiceCount) < MIN_INVOICES || num(a.billed) < MIN_BILLED || tenureDays < MIN_TENURE_DAYS) {
    return BANDS.GRAY;
  }
  const delinqRatio = num(a.billed) > 0 ? num(a.ninetyPlus) / num(a.billed) : 0;
  if (num(a.ninetyPlus) >= DEFAULT_FLOOR && delinqRatio > DEFAULT_RATIO) return BANDS.RED;
  if (score >= GREEN_MIN) return BANDS.GREEN;
  if (score >= AMBER_MIN) return BANDS.AMBER;
  return BANDS.RED;
}

// Convenience: aggregate → factors → composite → band → reasons/outlook in one
// call. `prior` shrinks thin files toward the portfolio mean (job) or 50 (default).
function scoreParty(observations, { asOf, prior = SHRINK_PRIOR } = {}) {
  const aggregate = aggregateObservations(observations, { asOf });
  const factors = scoreFactors(aggregate);
  const score = compositeScore(factors, aggregate, { asOf, prior });
  const band = bandForScore(score, aggregate, { asOf });
  const reasons = deriveReasons(factors, aggregate);
  const outlook = outlookFor(aggregate);
  return { aggregate, factors, score, band, reasons, outlook };
}

module.exports = {
  panFromGstin,
  termDaysFromBillingTerms,
  ageBucket,
  interp,
  fifoMatch,
  computePartyObservation,
  aggregateObservations,
  scoreFactors,
  baseScore,
  compositeScore,
  bandForScore,
  deriveReasons,
  outlookFor,
  scoreParty,
  daysBetween,
  BANDS,
  // thresholds exported for tests / the console legend
  GREEN_MIN, AMBER_MIN, MIN_INVOICES, MIN_BILLED, MIN_TENURE_DAYS,
  DEFAULT_FLOOR, DEFAULT_RATIO, WEIGHTS, DELAY_ANCHORS,
};
