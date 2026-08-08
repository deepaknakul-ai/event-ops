import { describe, it, expect } from 'vitest';
import { projectOccupancyWindow, isDateOverlap, projectDurationDays } from '../src/utils/helpers.js';

// Equipment (and crew) are committed from the moment the kit leaves the warehouse
// for SETUP — not from the event start date. Availability checks that used
// start_date alone allowed gear in transit/setup to be double-allocated, while
// projectDurationDays already prorated from setup_date. These now agree.

describe('projectOccupancyWindow', () => {
  it('starts at setup_date when setup precedes the event', () => {
    expect(projectOccupancyWindow({ setup_date: '2026-05-01', start_date: '2026-05-03', end_date: '2026-05-05' }))
      .toEqual({ start: '2026-05-01', end: '2026-05-05' });
  });

  it('falls back to start_date when there is no setup_date', () => {
    expect(projectOccupancyWindow({ start_date: '2026-05-03', end_date: '2026-05-05' }))
      .toEqual({ start: '2026-05-03', end: '2026-05-05' });
  });

  it('uses the EARLIER of setup/start (a setup logged after start does not shorten it)', () => {
    expect(projectOccupancyWindow({ setup_date: '2026-05-04', start_date: '2026-05-03', end_date: '2026-05-05' }))
      .toEqual({ start: '2026-05-03', end: '2026-05-05' });
  });

  it('treats a single-day project (no end_date) as one day', () => {
    expect(projectOccupancyWindow({ start_date: '2026-05-03' }))
      .toEqual({ start: '2026-05-03', end: '2026-05-03' });
  });

  it('returns null when there are no usable dates', () => {
    expect(projectOccupancyWindow({})).toBeNull();
    expect(projectOccupancyWindow(null)).toBeNull();
    expect(projectOccupancyWindow({ end_date: '2026-05-05' })).toBeNull();
  });

  it('never returns an inverted window', () => {
    const w = projectOccupancyWindow({ start_date: '2026-05-10', end_date: '2026-05-01' });
    expect(w.end >= w.start).toBe(true);
  });

  it('agrees with projectDurationDays, which already prorates from setup', () => {
    const p = { setup_date: '2026-05-01', start_date: '2026-05-03', end_date: '2026-05-05' };
    const w = projectOccupancyWindow(p);
    const days = Math.floor((new Date(w.end) - new Date(w.start)) / 86400000) + 1;
    expect(days).toBe(projectDurationDays(p)); // 5 days, not 3
  });
});

describe('setup-window overlap detection (the double-booking case)', () => {
  // Project B's setup begins while project A is still running. Comparing only
  // start/end dates says "no conflict" and the same kit gets allocated twice.
  const running = { start_date: '2026-05-01', end_date: '2026-05-04' };
  const setupOverlaps = { setup_date: '2026-05-03', start_date: '2026-05-06', end_date: '2026-05-08' };

  it('the OLD start-date-only comparison missed the conflict', () => {
    expect(isDateOverlap(running.start_date, running.end_date, setupOverlaps.start_date, setupOverlaps.end_date))
      .toBe(false);
  });

  it('the occupancy window catches it', () => {
    const a = projectOccupancyWindow(running);
    const b = projectOccupancyWindow(setupOverlaps);
    expect(isDateOverlap(a.start, a.end, b.start, b.end)).toBe(true);
  });

  it('still reports no conflict for genuinely separate projects', () => {
    const later = projectOccupancyWindow({ setup_date: '2026-05-06', start_date: '2026-05-07', end_date: '2026-05-09' });
    const a = projectOccupancyWindow(running);
    expect(isDateOverlap(a.start, a.end, later.start, later.end)).toBe(false);
  });
});
