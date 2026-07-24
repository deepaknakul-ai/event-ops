import { afterEach, describe, expect, it, vi } from 'vitest';

// Edition + tenant-id resolution. These modules read import.meta.env at import
// time, so each case stubs the env then dynamically imports a fresh copy.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('edition resolution', () => {
  it('defaults to private when VITE_EDITION is unset', async () => {
    vi.stubEnv('VITE_EDITION', '');
    const ed = await import('../src/utils/edition.js?private');
    expect(ed.EDITION).toBe('private');
    expect(ed.IS_SAAS).toBe(false);
    expect(ed.IS_PRIVATE).toBe(true);
  });

  it('is saas only for the exact "saas" value', async () => {
    vi.stubEnv('VITE_EDITION', 'saas');
    const ed = await import('../src/utils/edition.js?saas');
    expect(ed.EDITION).toBe('saas');
    expect(ed.IS_SAAS).toBe(true);
    expect(ed.IS_PRIVATE).toBe(false);
  });

  it('treats any other value as private', async () => {
    vi.stubEnv('VITE_EDITION', 'SAAS');
    const ed = await import('../src/utils/edition.js?weird');
    expect(ed.IS_SAAS).toBe(false);
  });
});

describe('constants appId (private)', () => {
  it('is the fixed constant and setAppId is a no-op', async () => {
    vi.stubEnv('VITE_EDITION', '');
    const c = await import('../src/utils/constants.js?private');
    expect(c.appId).toBe('TERMS 1.0.0');
    c.setAppId('acme');
    // Live binding must remain the private constant — setAppId is inert.
    const again = await import('../src/utils/constants.js?private');
    expect(again.appId).toBe('TERMS 1.0.0');
  });
});

describe('constants appId (saas)', () => {
  it('setAppId updates the live binding and persists', async () => {
    vi.stubEnv('VITE_EDITION', 'saas');
    const store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    });
    const c = await import('../src/utils/constants.js?saas');
    // Empty before any tenant is chosen.
    expect(c.appId).toBe('');
    c.setAppId('acme-events');
    expect(c.appId).toBe('acme-events');
    expect(store.saasTenantId).toBe('acme-events');
    vi.unstubAllGlobals();
  });
});
