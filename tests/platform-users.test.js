// Unit coverage for the PURE primitives behind the two new control-plane
// capabilities in functions/platform.js:
//   • validateStaffPassword   — the first-login password policy
//   • countActiveAdminsAfter  — the last-admin guard for cross-tenant user ops
//   • tenantInScope           — the SAME scope predicate platformManageTenantUsers
//                               authorizes with (super_admin / regional / manager)
// No Firestore/Admin SDK needed — these are the guards the handlers lean on,
// tested in isolation.
import { describe, expect, it } from 'vitest';
import {
  validateStaffPassword,
  countActiveAdminsAfter,
  tenantInScope,
  TENANT_USER_ROLES,
  PASSWORD_MIN_LEN,
} from '../functions/platform.js';

// ── validateStaffPassword ────────────────────────────────────────────────────
describe('validateStaffPassword', () => {
  it('accepts a reasonable password (returns null)', () => {
    expect(validateStaffPassword('Corr3ct-Horse!')).toBeNull();
    expect(validateStaffPassword('mY-str0ng-passphrase')).toBeNull();
  });

  it('exposes the min length as PASSWORD_MIN_LEN = 10', () => {
    expect(PASSWORD_MIN_LEN).toBe(10);
  });

  it('rejects non-strings', () => {
    for (const bad of [null, undefined, 12345, {}, []]) {
      expect(validateStaffPassword(bad)).toMatch(/required/i);
    }
  });

  it('rejects anything shorter than the minimum', () => {
    expect(validateStaffPassword('Ab1!')).toMatch(/at least 10/);
    expect(validateStaffPassword('nineChar1')).toMatch(/at least 10/); // 9 chars
  });

  it('rejects a value that is only long enough thanks to padding spaces', () => {
    // 10 raw chars but only 4 once trimmed → caught by the non-space check.
    expect(validateStaffPassword('   ab1!   ')).toMatch(/at least 10/);
  });

  it('rejects low-variety passwords (fewer than 4 distinct chars)', () => {
    expect(validateStaffPassword('aaaaaaaaaa')).toMatch(/too simple/i); // 1 distinct
    expect(validateStaffPassword('ababababab')).toMatch(/too simple/i); // 2 distinct
    expect(validateStaffPassword('abcabcabca')).toMatch(/too simple/i); // 3 distinct
  });

  it('rejects common/trivial passwords regardless of case', () => {
    expect(validateStaffPassword('password123')).toMatch(/too common/i);
    expect(validateStaffPassword('PassWord123')).toMatch(/too common/i);
    expect(validateStaffPassword('1234567890')).toMatch(/too common/i);
    expect(validateStaffPassword('qwertyuiop')).toMatch(/too common/i);
  });

  it('accepts a password exactly at the minimum length with enough variety', () => {
    const pw = 'ab3D-xy9Z'.padEnd(10, '!'); // 10 chars, many distinct
    expect(pw.length).toBe(10);
    expect(validateStaffPassword(pw)).toBeNull();
  });
});

// ── countActiveAdminsAfter (last-admin guard) ────────────────────────────────
describe('countActiveAdminsAfter', () => {
  const twoAdmins = [
    { id: 'a1', role: 'admin', status: 'Active' },
    { id: 'a2', role: 'admin', status: 'Active' },
    { id: 'u1', role: 'user', status: 'Active' },
  ];
  const oneAdmin = [
    { id: 'a1', role: 'admin', status: 'Active' },
    { id: 'u1', role: 'user', status: 'Active' },
  ];

  it('counts current active admins when no change is applied', () => {
    expect(countActiveAdminsAfter(twoAdmins, null)).toBe(2);
    expect(countActiveAdminsAfter(oneAdmin, null)).toBe(1);
  });

  it('disabling one of two admins still leaves one', () => {
    expect(countActiveAdminsAfter(twoAdmins, { id: 'a1', status: 'Disabled' })).toBe(1);
  });

  it('disabling the last admin leaves zero (guard should block)', () => {
    expect(countActiveAdminsAfter(oneAdmin, { id: 'a1', status: 'Disabled' })).toBe(0);
  });

  it('demoting the last admin (role change) leaves zero', () => {
    expect(countActiveAdminsAfter(oneAdmin, { id: 'a1', role: 'user' })).toBe(0);
  });

  it('removing the last admin leaves zero', () => {
    expect(countActiveAdminsAfter(oneAdmin, { id: 'a1', removed: true })).toBe(0);
  });

  it('treats Deactivated like Disabled, but an unknown/missing status as active', () => {
    const mixed = [
      { id: 'a1', role: 'admin', status: 'Deactivated' }, // inactive
      { id: 'a2', role: 'admin' }, // missing status → active (mirrors verifyLogin)
    ];
    expect(countActiveAdminsAfter(mixed, null)).toBe(1);
  });

  it('promoting a user to admin raises the count', () => {
    expect(countActiveAdminsAfter(oneAdmin, { id: 'u1', role: 'admin' })).toBe(2);
  });

  it('re-enabling a disabled admin raises the count', () => {
    const withDisabled = [
      { id: 'a1', role: 'admin', status: 'Disabled' },
      { id: 'a2', role: 'admin', status: 'Active' },
    ];
    expect(countActiveAdminsAfter(withDisabled, { id: 'a1', status: 'Active' })).toBe(2);
  });

  it('a change with role AND status both applied to the last admin', () => {
    // Same admin gets a new role and disabled at once → definitely zero.
    expect(countActiveAdminsAfter(oneAdmin, { id: 'a1', role: 'manager', status: 'Disabled' })).toBe(0);
  });

  it('is defensive about non-array / empty input', () => {
    expect(countActiveAdminsAfter(null, { id: 'x' })).toBe(0);
    expect(countActiveAdminsAfter(undefined, null)).toBe(0);
    expect(countActiveAdminsAfter([], null)).toBe(0);
    expect(countActiveAdminsAfter([null, undefined], null)).toBe(0);
  });

  it('ignores a change whose id matches nobody', () => {
    expect(countActiveAdminsAfter(twoAdmins, { id: 'ghost', status: 'Disabled' })).toBe(2);
  });
});

// ── TENANT_USER_ROLES — the allowed role set for cross-tenant user ops ────────
describe('TENANT_USER_ROLES', () => {
  it('is exactly the app employee roles', () => {
    expect([...TENANT_USER_ROLES].sort()).toEqual(
      ['accountant', 'admin', 'manager', 'tech', 'user'],
    );
  });
  it('excludes control-plane roles (a tenant user can never be platform staff)', () => {
    for (const r of ['super_admin', 'regional_admin', 'business_manager']) {
      expect(TENANT_USER_ROLES).not.toContain(r);
    }
  });
});

// ── Scope of platformManageTenantUsers (authorizes via tenantInScope) ────────
// The handler loads platform_tenants/{tenantId} and permits the op ONLY when
// tenantInScope(staff, tenant) — identical semantics to the read/update/support
// handlers. These cases assert that boundary per role.
describe('platformManageTenantUsers scope (via tenantInScope)', () => {
  const superAdmin = { id: 's_super', role: 'super_admin', regions: [] };
  const regionalNorth = { id: 's_reg', role: 'regional_admin', regions: ['north'] };
  const manager = { id: 's_mgr', role: 'business_manager' };

  const tNorth = { id: 'acme', region: 'north', assigned_managers: ['s_mgr'] };
  const tSouth = { id: 'beta', region: 'south', assigned_managers: [] };

  it('super_admin may manage users in any tenant', () => {
    expect(tenantInScope(superAdmin, tNorth)).toBe(true);
    expect(tenantInScope(superAdmin, tSouth)).toBe(true);
  });

  it('regional_admin may manage users only in an in-region tenant', () => {
    expect(tenantInScope(regionalNorth, tNorth)).toBe(true);
    expect(tenantInScope(regionalNorth, tSouth)).toBe(false);
  });

  it('business_manager may manage users only in an assigned tenant', () => {
    expect(tenantInScope(manager, tNorth)).toBe(true); // assigned
    expect(tenantInScope(manager, tSouth)).toBe(false); // not assigned
  });
});
