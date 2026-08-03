import { describe, expect, it } from 'vitest';
import { resolveEntitlements, PLAN_ENTITLEMENTS, FEATURE_KEYS, LIMIT_KEYS } from '../functions/platform.js';

describe('resolveEntitlements', () => {
  it('returns the plan defaults with no overrides', () => {
    const e = resolveEntitlements({ plan: 'standard' });
    expect(e.plan).toBe('standard');
    expect(e.features).toEqual(PLAN_ENTITLEMENTS.standard.features);
    expect(e.limits).toEqual(PLAN_ENTITLEMENTS.standard.limits);
  });

  it('premium is unlimited users', () => {
    expect(resolveEntitlements({ plan: 'premium' }).limits.max_users).toBeNull();
  });

  it('falls back to trial for an unknown/missing plan', () => {
    expect(resolveEntitlements({}).plan).toBe('trial');
    expect(resolveEntitlements({ plan: 'enterprise' }).features).toEqual(PLAN_ENTITLEMENTS.trial.features);
  });

  it('feature_overrides win over plan defaults (booleans only)', () => {
    const e = resolveEntitlements({ plan: 'trial', feature_overrides: { whatsapp_copilot: true, bogus: true } });
    expect(e.features.whatsapp_copilot).toBe(true); // overridden
    expect(e.features.ai_accountant).toBe(false); // untouched
    expect('bogus' in e.features).toBe(false); // unknown keys ignored
  });

  it('ignores non-boolean feature overrides', () => {
    const e = resolveEntitlements({ plan: 'premium', feature_overrides: { whatsapp_copilot: 'yes' } });
    expect(e.features.whatsapp_copilot).toBe(true); // plan default kept, string ignored
  });

  it('limit_overrides accept numbers and explicit null (unlimited)', () => {
    expect(resolveEntitlements({ plan: 'trial', limit_overrides: { max_users: 50 } }).limits.max_users).toBe(50);
    expect(resolveEntitlements({ plan: 'trial', limit_overrides: { max_users: null } }).limits.max_users).toBeNull();
  });

  it('ignores non-numeric limit overrides', () => {
    const e = resolveEntitlements({ plan: 'trial', limit_overrides: { max_users: 'lots' } });
    expect(e.limits.max_users).toBe(3); // plan default kept
  });

  it('exposes stable key vocabularies', () => {
    expect(FEATURE_KEYS).toContain('whatsapp_copilot');
    expect(LIMIT_KEYS).toContain('max_users');
    // Every plan defines every feature key.
    for (const plan of Object.values(PLAN_ENTITLEMENTS)) {
      for (const k of FEATURE_KEYS) expect(typeof plan.features[k]).toBe('boolean');
    }
  });
});
