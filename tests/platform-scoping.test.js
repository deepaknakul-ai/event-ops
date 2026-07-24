// Unit coverage for the PURE authorization primitives exported by
// functions/platform.js — the scope predicate and validators that gate every
// control-plane callable. No Firestore/Admin SDK needed: these are the guards
// the handlers lean on, tested in isolation.
import { describe, expect, it } from 'vitest';
import { tenantInScope, TENANT_PATCH_KEYS, isValidTenantCode } from '../functions/platform.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const superAdmin = { id: 's_super', role: 'super_admin', regions: [] };
const regionalNorth = { id: 's_reg', role: 'regional_admin', regions: ['north', 'east'] };
const regionalNoRegions = { id: 's_reg2', role: 'regional_admin' }; // regions undefined
const manager = { id: 's_mgr', role: 'business_manager' };

const tNorth = { id: 'acme', region: 'north', assigned_managers: ['s_mgr'] };
const tSouth = { id: 'beta', region: 'south', assigned_managers: [] };
const tWest = { id: 'gamma', region: 'west', assigned_managers: ['someone_else'] };
const tNoManagers = { id: 'delta', region: 'north' }; // assigned_managers undefined

describe('tenantInScope — super_admin', () => {
  it.each([tNorth, tSouth, tWest, tNoManagers])('sees every tenant (%o)', (tenant) => {
    expect(tenantInScope(superAdmin, tenant)).toBe(true);
  });
});

describe('tenantInScope — regional_admin', () => {
  it('sees a tenant whose region is in its regions', () => {
    expect(tenantInScope(regionalNorth, tNorth)).toBe(true); // north ∈ [north, east]
  });
  it('cannot see a tenant in another region', () => {
    expect(tenantInScope(regionalNorth, tSouth)).toBe(false); // south ∉ [north, east]
    expect(tenantInScope(regionalNorth, tWest)).toBe(false);
  });
  it('with no regions array sees nothing', () => {
    expect(tenantInScope(regionalNoRegions, tNorth)).toBe(false);
  });
});

describe('tenantInScope — business_manager', () => {
  it('sees a tenant that names it in assigned_managers', () => {
    expect(tenantInScope(manager, tNorth)).toBe(true);
  });
  it('cannot see a tenant it is not assigned to', () => {
    expect(tenantInScope(manager, tSouth)).toBe(false); // empty assignment
    expect(tenantInScope(manager, tWest)).toBe(false); // assigned to someone else
  });
  it('cannot see a tenant with no assigned_managers field', () => {
    expect(tenantInScope(manager, tNoManagers)).toBe(false);
  });
  it('ignores region for managers (assignment is the only key)', () => {
    // Same region as the manager-linked tenant, but no assignment → still out.
    expect(tenantInScope(manager, { id: 'x', region: 'north', assigned_managers: [] })).toBe(false);
  });
});

describe('tenantInScope — defensive', () => {
  it('returns false for null/undefined staff or tenant', () => {
    expect(tenantInScope(null, tNorth)).toBe(false);
    expect(tenantInScope(superAdmin, null)).toBe(false);
    expect(tenantInScope(undefined, undefined)).toBe(false);
  });
  it('returns false for an unknown role', () => {
    expect(tenantInScope({ id: 'x', role: 'ghost', regions: ['north'] }, tNorth)).toBe(false);
    expect(tenantInScope({ id: 'x' }, tNorth)).toBe(false); // no role at all
  });
});

describe('isValidTenantCode', () => {
  it.each([
    'abc', 'a1b', 'my-tenant', 'acme-2026', 'a1b2c3', 'a'.repeat(3), 'a'.repeat(30),
  ])('accepts valid slug %j', (code) => {
    expect(isValidTenantCode(code)).toBe(true);
  });

  it.each([
    ['ab', 'too short (2 chars)'],
    ['a'.repeat(31), 'too long (31 chars)'],
    ['Acme', 'uppercase'],
    ['my_tenant', 'underscore'],
    ['my tenant', 'space'],
    ['tenant!', 'punctuation'],
    ['über', 'non-ascii'],
    ['', 'empty'],
  ])('rejects %j (%s)', (code) => {
    expect(isValidTenantCode(code)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidTenantCode(null)).toBe(false);
    expect(isValidTenantCode(undefined)).toBe(false);
    expect(isValidTenantCode(12345)).toBe(false);
    expect(isValidTenantCode({})).toBe(false);
  });
});

describe('TENANT_PATCH_KEYS whitelist', () => {
  // Mirror the exact filter platformUpdateTenant applies to an incoming patch.
  const pickWhitelisted = (patch) => {
    const clean = {};
    for (const key of TENANT_PATCH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
    return clean;
  };

  it('contains exactly the intended updatable keys', () => {
    expect([...TENANT_PATCH_KEYS].sort()).toEqual([
      'assigned_managers', 'contact_email', 'contact_name', 'contact_phone',
      'name', 'notes', 'plan', 'region', 'status', 'trial_expires_on',
    ]);
  });

  it('excludes identity/provenance keys (no re-keying or forging)', () => {
    for (const forbidden of ['code', 'id', 'created_by', 'created_at', 'updated_by', 'updated_at']) {
      expect(TENANT_PATCH_KEYS).not.toContain(forbidden);
    }
  });

  it('drops unknown/forged keys while keeping legitimate ones', () => {
    const malicious = {
      name: 'Renamed Co',
      status: 'suspended',
      code: 'evil-rekey', // attempt to re-point the tenant
      created_by: 'forged-actor', // attempt to forge provenance
      created_at: '1999-01-01T00:00:00.000Z',
      updated_by: 'forged',
      id: 'hijack',
      role: 'super_admin', // not a tenant field at all
      is_platform_owner: true, // arbitrary unknown key
    };
    const clean = pickWhitelisted(malicious);
    expect(clean).toEqual({ name: 'Renamed Co', status: 'suspended' });
    for (const forbidden of ['code', 'created_by', 'created_at', 'updated_by', 'id', 'role']) {
      expect(clean).not.toHaveProperty(forbidden);
    }
  });

  it('produces an empty object when a patch carries only non-whitelisted keys', () => {
    expect(pickWhitelisted({ code: 'x', created_by: 'y', foo: 1 })).toEqual({});
  });
});
