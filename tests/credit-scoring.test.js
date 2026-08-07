import { describe, expect, it } from 'vitest';
import {
  panFromGstin, termDaysFromBillingTerms, ageBucket, interp, fifoMatch,
  computePartyObservation, aggregateObservations,
  scoreFactors, baseScore, compositeScore, bandForScore, deriveReasons, outlookFor,
  scoreParty, BANDS, DELAY_ANCHORS,
} from '../functions/credit-scoring.cjs';

const ASOF = '2026-06-01T00:00:00.000Z';
const OLD = '2022-01-01T00:00:00.000Z'; // >2y before ASOF → full tenure

// score/band helpers over a hand-built aggregate. maxDaysLate defaults to the
// weighted mean (worst-ever is never below the average) so synthetic aggregates
// stay physically possible for the new worstDelinquency factor.
const scoreOf = (agg) => compositeScore(scoreFactors(agg), agg, { asOf: ASOF });
const bandOf = (agg) => bandForScore(scoreOf(agg), agg, { asOf: ASOF });
const baseAgg = (o) => ({
  billed: 0, overdueAmt: 0, ninetyPlus: 0, weightedDaysLate: 0, reminderCount: 0,
  invoiceCount: 0, sample_size: 0, firstSeen: OLD,
  beyond45Amt: 0, timeBarredAmt: 0, recentDaysLate: null, priorDaysLate: null,
  maxDaysLate: o.maxDaysLate != null ? o.maxDaysLate : (o.weightedDaysLate || 0),
  ...o,
});

describe('panFromGstin', () => {
  it('extracts the 10-char PAN from a checksum-valid GSTIN', () => {
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
  });
  it('normalizes case and whitespace before extracting', () => {
    expect(panFromGstin('  27aapfu0939f1zv ')).toBe('AAPFU0939F');
  });
  it('rejects a wrong checksum digit (guards against merging typos)', () => {
    expect(panFromGstin('27AAPFU0939F1ZX')).toBeNull();
  });
  it('rejects malformed / short / non-string ids', () => {
    expect(panFromGstin('27AAPFU0939F1Z')).toBeNull(); // 14 chars
    expect(panFromGstin('NOTAGSTIN000000')).toBeNull();
    expect(panFromGstin('')).toBeNull();
    expect(panFromGstin(null)).toBeNull();
    expect(panFromGstin(42)).toBeNull();
  });
});

describe('termDaysFromBillingTerms', () => {
  it('parses "Net N"', () => {
    expect(termDaysFromBillingTerms('Net 15')).toBe(15);
    expect(termDaysFromBillingTerms('Net 30')).toBe(30);
    expect(termDaysFromBillingTerms('net45')).toBe(45);
  });
  it('falls back to 15 when absent/unparseable', () => {
    expect(termDaysFromBillingTerms('')).toBe(15);
    expect(termDaysFromBillingTerms(null)).toBe(15);
    expect(termDaysFromBillingTerms('on receipt')).toBe(15);
  });
});

describe('ageBucket', () => {
  it('buckets on 30/60/90 boundaries', () => {
    expect(ageBucket(0)).toBe('0_30');
    expect(ageBucket(30)).toBe('0_30');
    expect(ageBucket(31)).toBe('31_60');
    expect(ageBucket(60)).toBe('31_60');
    expect(ageBucket(61)).toBe('61_90');
    expect(ageBucket(90)).toBe('61_90');
    expect(ageBucket(91)).toBe('90_plus');
  });
});

describe('interp — PAYDEX/DBT delay curve', () => {
  it('returns the exact anchor values', () => {
    for (const [x, y] of DELAY_ANCHORS) expect(interp(x, DELAY_ANCHORS)).toBeCloseTo(y, 6);
  });
  it('interpolates linearly between anchors', () => {
    expect(interp(22.5, DELAY_ANCHORS)).toBeCloseTo(75, 6); // midpoint of [15→85, 30→65]
  });
  it('clamps flat beyond both ends', () => {
    expect(interp(-10, DELAY_ANCHORS)).toBe(100);
    expect(interp(500, DELAY_ANCHORS)).toBe(5);
  });
  it('is monotonically non-increasing (later = never safer)', () => {
    let prev = 101;
    for (let d = 0; d <= 200; d += 5) { const v = interp(d, DELAY_ANCHORS); expect(v).toBeLessThanOrEqual(prev); prev = v; }
  });
});

describe('fifoMatch', () => {
  it('clears the oldest invoice first and records the clearing date', () => {
    const inv = [{ amount: 1000, date: '2026-01-01' }, { amount: 1000, date: '2026-02-01' }];
    const m = fifoMatch(inv, [{ amount: 1000, date: '2026-02-15' }]);
    expect(m[0].outstanding).toBe(0);
    expect(m[0].clearedDate).toBe('2026-02-15');
    expect(m[1].outstanding).toBe(1000);
    expect(m[1].clearedDate).toBeNull();
  });
  it('leaves a partial invoice open', () => {
    const m = fifoMatch([{ amount: 1000, date: '2026-01-01' }], [{ amount: 400, date: '2026-01-10' }]);
    expect(m[0].paidAmount).toBe(400);
    expect(m[0].outstanding).toBe(600);
  });
});

describe('computePartyObservation', () => {
  it('measures days-late from due date to the clearing receipt + carries worst-ever', () => {
    const o = computePartyObservation({
      invoices: [{ amount: 1000, date: '2026-01-01', dueDate: '2026-01-31' }],
      payments: [{ amount: 1000, date: '2026-02-15' }],
      asOf: ASOF,
    });
    expect(o.avgDaysLate).toBe(15);
    expect(o.maxDaysLate).toBe(15);
    expect(o.outstanding).toBe(0);
    expect(o.invoiceCount).toBe(1);
  });
  it('an unpaid, long-overdue invoice ages into 90+ and stays outstanding', () => {
    const o = computePartyObservation({
      invoices: [{ amount: 1000, date: '2026-01-01', dueDate: '2026-01-31' }],
      payments: [], asOf: ASOF,
    });
    expect(o.outstanding).toBe(1000);
    expect(o.ninetyPlus).toBe(1000);
    expect(o.avgDaysLate).toBe(121);
  });

  it('MSME supplier: the 45-day statutory cap makes the same slow payment score worse', () => {
    const invoices = [{ amount: 100000, date: '2026-01-01', dueDate: '2026-03-01' }]; // Net-60 terms
    const payments = [{ amount: 100000, date: '2026-04-10' }];                        // paid ~day 99
    const nonMsme = computePartyObservation({ invoices, payments, supplierMsme: false, hasTerms: true, asOf: ASOF });
    const msme = computePartyObservation({ invoices, payments, supplierMsme: true, hasTerms: true, asOf: ASOF });
    expect(msme.avgDaysLate).toBeGreaterThan(nonMsme.avgDaysLate); // due capped at 45 → more days late
    expect(msme.beyond45Amt).toBe(100000);                          // breached the statutory limit
    expect(nonMsme.beyond45Amt).toBe(0);
  });

  it('time-barred (>3y) open debt leaves live exposure but stays a worst-ever black mark', () => {
    const o = computePartyObservation({
      invoices: [{ amount: 50000, date: '2022-01-01', dueDate: '2022-01-31' }], // due ~1582d before ASOF
      payments: [], asOf: ASOF,
    });
    expect(o.timeBarredAmt).toBe(50000);
    expect(o.outstanding).toBe(0);   // not collectible → excluded from live exposure
    expect(o.overdueAmt).toBe(0);
    expect(o.ninetyPlus).toBe(0);
    expect(o.avgDaysLate).toBe(0);   // excluded from the delay mean
    expect(o.maxDaysLate).toBeGreaterThan(1095); // but retained as historical delinquency
  });
});

describe('aggregateObservations', () => {
  it('billed-weights the delay across tenants and takes the MAX worst-ever', () => {
    const agg = aggregateObservations([
      { billed: 900000, avgDaysLate: 0, maxDaysLate: 10, invoiceCount: 9, lastActivity: '2026-05-01' },
      { billed: 100000, avgDaysLate: 100, maxDaysLate: 130, invoiceCount: 1, lastActivity: '2026-05-01' },
    ], { asOf: ASOF });
    expect(agg.weightedDaysLate).toBeCloseTo(10, 5);
    expect(agg.maxDaysLate).toBe(130); // worst-ever is a max, not an average
    expect(agg.billed).toBe(1000000);
  });
  it('combines recent/prior trend windows billed-weighted', () => {
    const agg = aggregateObservations([
      { billed: 100000, recentDaysLate: 5, recentBilled: 100000, priorDaysLate: 60, priorBilled: 100000, invoiceCount: 4, lastActivity: '2026-05-01' },
    ], { asOf: ASOF });
    expect(agg.recentDaysLate).toBeCloseTo(5, 5);
    expect(agg.priorDaysLate).toBeCloseTo(60, 5);
  });
});

describe('worstDelinquency & trend/outlook factors', () => {
  it('a party once very late scores below one that was only ever mildly late (same current mean)', () => {
    const reformed = baseAgg({ billed: 300000, weightedDaysLate: 5, maxDaysLate: 120, invoiceCount: 15, sample_size: 15 });
    const steady = baseAgg({ billed: 300000, weightedDaysLate: 5, maxDaysLate: 8, invoiceCount: 15, sample_size: 15 });
    expect(scoreOf(reformed)).toBeLessThan(scoreOf(steady));
  });
  it('improving vs worsening parties with equal means diverge on trend + outlook', () => {
    const improving = baseAgg({ billed: 300000, weightedDaysLate: 30, recentDaysLate: 5, priorDaysLate: 60, invoiceCount: 15, sample_size: 15 });
    const worsening = baseAgg({ billed: 300000, weightedDaysLate: 30, recentDaysLate: 60, priorDaysLate: 5, invoiceCount: 15, sample_size: 15 });
    expect(scoreFactors(improving).trend).toBeGreaterThan(scoreFactors(worsening).trend);
    expect(outlookFor(improving)).toBe('improving');
    expect(outlookFor(worsening)).toBe('worsening');
    expect(outlookFor(baseAgg({ recentDaysLate: null, priorDaysLate: null }))).toBe('stable');
  });
});

describe('scoring bands', () => {
  it('Green — reliable, prompt, high-volume payer', () => {
    const agg = baseAgg({ billed: 500000, weightedDaysLate: 2, invoiceCount: 20, sample_size: 20 });
    expect(scoreOf(agg)).toBeGreaterThanOrEqual(70);
    expect(bandOf(agg)).toBe(BANDS.GREEN);
  });
  it('Amber — mildly slow with some overdue', () => {
    const agg = baseAgg({ billed: 200000, overdueAmt: 60000, weightedDaysLate: 40, reminderCount: 2, invoiceCount: 10, sample_size: 10 });
    expect(bandOf(agg)).toBe(BANDS.AMBER);
  });
  it('Red — material persistent 90+ default forces Red regardless of composite', () => {
    const agg = baseAgg({ billed: 500000, overdueAmt: 300000, ninetyPlus: 300000, weightedDaysLate: 120, reminderCount: 5, invoiceCount: 20, sample_size: 20 });
    expect(bandOf(agg)).toBe(BANDS.RED);
  });
  it('Gray — too few invoices / trivial billing / brand-new relationship', () => {
    expect(bandOf(baseAgg({ billed: 200000, invoiceCount: 1, sample_size: 1 }))).toBe(BANDS.GRAY);
    expect(bandOf(baseAgg({ billed: 5000, invoiceCount: 10, sample_size: 10 }))).toBe(BANDS.GRAY);
    expect(bandOf(baseAgg({ billed: 200000, invoiceCount: 10, sample_size: 10, firstSeen: '2026-05-02T00:00:00.000Z' }))).toBe(BANDS.GRAY);
  });
  it('is monotonic — a later payer never scores higher than a prompt one', () => {
    const good = baseAgg({ billed: 300000, weightedDaysLate: 5, invoiceCount: 15, sample_size: 15 });
    const bad = baseAgg({ billed: 300000, weightedDaysLate: 45, invoiceCount: 15, sample_size: 15 });
    expect(scoreOf(bad)).toBeLessThan(scoreOf(good));
  });
  it('thin samples shrink toward neutral — a shaky record is not instant Red on 3 invoices', () => {
    const thin = baseAgg({ billed: 30000, weightedDaysLate: 120, maxDaysLate: 120, overdueAmt: 18000, reminderCount: 5, invoiceCount: 3, sample_size: 3 });
    const thick = baseAgg({ billed: 500000, weightedDaysLate: 120, maxDaysLate: 120, overdueAmt: 300000, reminderCount: 5, invoiceCount: 40, sample_size: 40 });
    expect(scoreOf(thin)).toBeGreaterThan(scoreOf(thick));
    expect(bandOf(thin)).toBe(BANDS.AMBER);
    expect(bandOf(thick)).toBe(BANDS.RED);
  });
});

describe('two-pass shrinkage prior', () => {
  it('baseScore is the unshrunk 0..100 raw', () => {
    const agg = baseAgg({ billed: 300000, weightedDaysLate: 5, invoiceCount: 20, sample_size: 20 });
    const b = baseScore(scoreFactors(agg), agg, { asOf: ASOF });
    expect(b).toBeGreaterThan(0); expect(b).toBeLessThanOrEqual(100);
  });
  it('a thin file shrinks toward the supplied portfolio prior, not always 50', () => {
    const agg = baseAgg({ billed: 30000, weightedDaysLate: 3, invoiceCount: 3, sample_size: 3 });
    const f = scoreFactors(agg);
    const lowPrior = compositeScore(f, agg, { asOf: ASOF, prior: 20 });
    const highPrior = compositeScore(f, agg, { asOf: ASOF, prior: 80 });
    expect(highPrior).toBeGreaterThan(lowPrior); // same party, harsher/kinder book pulls the thin score
  });
});

describe('deriveReasons', () => {
  it('lists hard-override reasons first, then the worst factor shortfalls', () => {
    const agg = baseAgg({
      billed: 500000, overdueAmt: 300000, ninetyPlus: 300000, weightedDaysLate: 120, maxDaysLate: 200,
      reminderCount: 4, timeBarredAmt: 20000, beyond45Amt: 200000, invoiceCount: 20, sample_size: 20,
    });
    const reasons = deriveReasons(scoreFactors(agg), agg);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.length).toBeLessThanOrEqual(4);
    expect(reasons[0]).toMatch(/material default/i);
    expect(reasons.join(' | ')).toMatch(/time-barred/i);
    expect(reasons.join(' | ')).toMatch(/MSME/i);
  });
  it('a clean party has few or no reasons', () => {
    const agg = baseAgg({ billed: 500000, weightedDaysLate: 1, invoiceCount: 20, sample_size: 20 });
    expect(deriveReasons(scoreFactors(agg), agg).length).toBeLessThanOrEqual(1);
  });
});

describe('scoreParty (end-to-end shape)', () => {
  it('returns aggregate, factors, score, band, reasons, outlook', () => {
    const obs = computePartyObservation({
      invoices: [
        { amount: 200000, date: '2025-01-01', dueDate: '2025-01-31' },
        { amount: 200000, date: '2026-04-01', dueDate: '2026-04-30' },
      ],
      payments: [{ amount: 200000, date: '2025-06-01' }, { amount: 200000, date: '2026-05-05' }],
      reminderCount: 1, asOf: ASOF,
    });
    const sp = scoreParty([obs], { asOf: ASOF });
    expect(sp).toHaveProperty('score');
    expect(sp).toHaveProperty('band');
    expect(Array.isArray(sp.reasons)).toBe(true);
    expect(['improving', 'stable', 'worsening']).toContain(sp.outlook);
    expect(sp.aggregate.maxDaysLate).toBeGreaterThan(100);
  });
});
