import { describe, it, expect } from 'vitest';
import {
  computeNextRun,
  dueRuns,
  projectRuns,
  partitionRules,
  parseRecurringPhrase,
} from '../src/utils/aiAccountant/recurring.js';

describe('computeNextRun', () => {
  it('returns next monthly run', () => {
    const rule = { frequency: 'monthly', interval: 1, startDate: '2026-04-01', active: true };
    expect(computeNextRun(rule, '2026-04-15')).toBe('2026-05-01');
  });
  it('returns startDate when strictly after from', () => {
    const rule = { frequency: 'monthly', startDate: '2026-06-01', active: true };
    expect(computeNextRun(rule, '2026-04-15')).toBe('2026-06-01');
  });
  it('returns null when inactive', () => {
    expect(computeNextRun({ frequency: 'monthly', startDate: '2026-04-01', active: false }, '2026-04-15')).toBeNull();
  });
  it('returns null after endDate', () => {
    const rule = { frequency: 'monthly', startDate: '2026-04-01', endDate: '2026-04-30', active: true };
    expect(computeNextRun(rule, '2026-05-01')).toBeNull();
  });
  it('clamps day-of-month for short months', () => {
    const rule = { frequency: 'monthly', startDate: '2026-01-31', active: true };
    expect(computeNextRun(rule, '2026-01-31')).toBe('2026-02-28');
  });
});

describe('dueRuns', () => {
  it('lists every past run not yet executed', () => {
    const rule = { frequency: 'monthly', startDate: '2026-01-01', active: true };
    const runs = dueRuns(rule, '2026-04-15');
    expect(runs).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  });
  it('respects lastRunDate', () => {
    const rule = { frequency: 'monthly', startDate: '2026-01-01', lastRunDate: '2026-03-01', active: true };
    const runs = dueRuns(rule, '2026-05-15');
    expect(runs).toEqual(['2026-04-01', '2026-05-01']);
  });
});

describe('projectRuns', () => {
  it('projects monthly runs in window', () => {
    const rule = { frequency: 'monthly', startDate: '2026-04-01', active: true };
    const out = projectRuns(rule, '2026-04-01', '2026-07-01');
    expect(out).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
  });
  it('quarterly frequency', () => {
    const rule = { frequency: 'quarterly', startDate: '2026-04-01', active: true };
    const out = projectRuns(rule, '2026-04-01', '2027-04-01');
    expect(out).toEqual(['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01', '2027-04-01']);
  });
});

describe('partitionRules', () => {
  it('separates due vs upcoming', () => {
    const rules = [
      { id: 'r1', frequency: 'monthly', startDate: '2026-01-01', active: true },
      { id: 'r2', frequency: 'monthly', startDate: '2026-07-01', active: true },
    ];
    const { due, upcoming } = partitionRules(rules, '2026-04-15');
    expect(due).toHaveLength(1);
    expect(upcoming).toHaveLength(2);
  });
});

describe('parseRecurringPhrase', () => {
  it('parses "every month on the 1st"', () => {
    const r = parseRecurringPhrase('pay rent every month on the 1st', '2026-04-15');
    expect(r).toBeTruthy();
    expect(r.frequency).toBe('monthly');
    expect(r.dayOfMonth).toBe(1);
  });
  it('parses "every 3 months"', () => {
    const r = parseRecurringPhrase('AMC every 3 months', '2026-04-15');
    expect(r).toBeTruthy();
    expect(r.frequency).toBe('monthly');
    expect(r.interval).toBe(3);
  });
  it('parses "monthly"', () => {
    const r = parseRecurringPhrase('salary 100000 monthly', '2026-04-15');
    expect(r).toBeTruthy();
    expect(r.frequency).toBe('monthly');
  });
  it('returns null when not recurring', () => {
    expect(parseRecurringPhrase('pay rent 50000', '2026-04-15')).toBeNull();
  });
});
