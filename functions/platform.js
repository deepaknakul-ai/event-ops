/**
 * Tenant-platform (SaaS control-plane) callables.
 *
 * The SAME functions bundle deploys to both the private single-tenant project
 * and the multi-tenant SaaS project. These handlers are DATA-GATED, never
 * build-gated: every one starts by checking for the top-level marker document
 * `platform_meta/config`. On the private project that doc does not exist, so
 * every handler throws `failed-precondition` and the module is inert. On the
 * SaaS project the doc exists and the control plane is live.
 *
 * Data model (TOP-LEVEL collections — deliberately NOT under artifacts/, so
 * tenant-scoped Firestore rules can never reach them):
 *   - platform_meta/config              — existence marks the SaaS deployment
 *   - platform_staff/{staffId}          — control-plane operators (super_admin /
 *       regional_admin / business_manager). Password pbkdf2 hash lives in the
 *       SUBDOC platform_staff/{staffId}/secret/credentials, never on the doc.
 *   - platform_tenants/{code}           — one per customer workspace (code ==
 *       the artifacts/{code} appId)
 *   - platform_audit_logs/{auto}        — control-plane audit trail
 *
 * Tenants are provisioned into the very same artifacts/{code}/public/data tree
 * the app already uses, and seeded so the owner can immediately sign in through
 * the existing verifyLogin admin branch (username "admin").
 *
 * Factory idiom mirrors functions/whatsapp.js createWhatsApp; the pbkdf2 login
 * recipe, rate-limit shape (5 attempts / 15 min) and custom-token minting mirror
 * functions/index.js verifyLogin.
 */
'use strict';

const PLATFORM_CONFIG_PATH = 'platform_meta/config';
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const SUPPORT_SESSION_MS = 4 * 60 * 60 * 1000;
const BATCH_LIMIT = 450; // < Firestore's 500-write cap, leaves headroom

const TENANT_STATUSES = ['active', 'suspended', 'churned'];
const TENANT_PLANS = ['trial', 'standard', 'premium'];
const STAFF_ROLES = ['super_admin', 'regional_admin', 'business_manager'];
const STAFF_STATUSES = ['active', 'disabled'];

// Minimum length for a platform-staff password chosen during first-login setup.
const PASSWORD_MIN_LEN = 10;
// Minimum length for a tenant employee's password (matches the tenant-owner
// password floor in platformCreateTenant / the app's own employee flows).
const TENANT_USER_PASSWORD_MIN_LEN = 8;

// Roles a tenant employee may hold (mirrors the app's employee roles). A
// cross-tenant user op may only ever set a role drawn from this list — this is
// what blocks escalating a user to an out-of-band role.
const TENANT_USER_ROLES = ['admin', 'accountant', 'manager', 'tech', 'user'];
// Employee status values a cross-tenant op may set. verifyLogin treats ONLY
// 'Disabled'/'Deactivated' as login-blocking, so those two are what the
// last-admin guard counts as inactive.
const TENANT_USER_STATUSES = ['Active', 'Disabled', 'Deactivated'];

// Small blocklist of obviously-weak passwords rejected regardless of length.
const TRIVIAL_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passwordpassword',
  '1234567890', '12345678', '123456789', '0123456789',
  'qwertyuiop', 'qwerty1234', 'abcdefghij',
  'letmein', 'welcome123', 'changeme', 'changeme123',
  'adminadmin', 'administrator',
]);

// Fields platformUpdateTenant is allowed to write. Deliberately EXCLUDES
// identity/provenance keys (code, created_at, created_by, updated_*) so a patch
// can never re-key a tenant or forge its audit provenance.
const TENANT_PATCH_KEYS = [
  'name', 'region', 'status', 'plan', 'trial_expires_on', 'assigned_managers',
  'contact_name', 'contact_email', 'contact_phone', 'notes',
];
// Of those, only a super_admin may change these two (they alter reach/scoping).
const TENANT_SUPER_ADMIN_ONLY_KEYS = ['region', 'assigned_managers'];

// Fields platformManageStaff('update') may write on the main staff doc.
const STAFF_UPDATE_KEYS = ['name', 'email', 'role', 'regions', 'assigned_tenants', 'status'];

// Tenant code == artifacts/{code} appId: a slug of 3–30 [a-z0-9-] chars.
function isValidTenantCode(code) {
  return typeof code === 'string' && /^[a-z0-9-]{3,30}$/.test(code);
}

// Pure scope predicate used by every scoped handler (list/update/support).
//   super_admin      → every tenant
//   regional_admin   → tenants whose region is in the staff member's regions
//   business_manager → tenants that name the staff member in assigned_managers
function tenantInScope(staff, tenant) {
  if (!staff || !tenant) return false;
  if (staff.role === 'super_admin') return true;
  if (staff.role === 'regional_admin') {
    return Array.isArray(staff.regions) && staff.regions.includes(tenant.region);
  }
  if (staff.role === 'business_manager') {
    return Array.isArray(tenant.assigned_managers) && tenant.assigned_managers.includes(staff.id);
  }
  return false;
}

// Validate a platform-staff password chosen at first-login setup. Pure so the UI
// can reuse it and it can be unit-tested. Returns null when acceptable, else a
// human-readable reason. Policy: >= PASSWORD_MIN_LEN characters, some character
// variety, and not an obviously trivial/common value.
function validateStaffPassword(pw) {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < PASSWORD_MIN_LEN) return `Password must be at least ${PASSWORD_MIN_LEN} characters`;
  if (pw.trim().length < PASSWORD_MIN_LEN) return `Password must be at least ${PASSWORD_MIN_LEN} non-space characters`;
  if (new Set(pw).size < 4) return 'Password is too simple — use a longer mix of characters';
  if (TRIVIAL_PASSWORDS.has(pw.toLowerCase())) return 'Password is too common — choose a less predictable one';
  return null;
}

// Employee statuses that BLOCK login (mirrors functions/index.js verifyLogin,
// which rejects only these two). Everything else — including a missing status —
// is treated as a live, login-capable account.
function isDisabledEmployeeStatus(status) {
  return status === 'Disabled' || status === 'Deactivated';
}

// Count the tenant's active admins AFTER a pending change to one employee, so a
// caller can refuse an op that would strip the tenant's last one and lock it
// out. Pure/testable.
//   employees : [{ id, role, status }, ...]  — the tenant's current employees
//   change    : { id, role?, status?, removed? } — the doc being mutated; omit
//               role/status to leave them, removed:true to drop the doc.
function countActiveAdminsAfter(employees, change) {
  if (!Array.isArray(employees)) return 0;
  let count = 0;
  for (const e of employees) {
    if (!e) continue;
    let role = e.role;
    let status = e.status;
    if (change && change.id != null && e.id === change.id) {
      if (change.removed) continue;
      if (change.role !== undefined) role = change.role;
      if (change.status !== undefined) status = change.status;
    }
    if (role === 'admin' && !isDisabledEmployeeStatus(status)) count += 1;
  }
  return count;
}

// Map a default-equipment-catalog entry to this app's inventory doc shape
// (src/pages/Inventory.jsx: name, category, sub_category, qty, unit, dimensions,
// weight, power, rate_per_day/week, purchase_cost, status). Seeded as priced-at-
// zero, zero-stock TEMPLATES (is_template) the tenant then stocks and prices.
function equipmentToInventory(item) {
  return {
    name: item.name,
    category: item.category || 'Uncategorised',
    sub_category: item.sub_category || '',
    unit: item.unit || 'piece',
    dimensions: item.dimensions || '',
    weight: item.weight != null ? item.weight : '',
    power: item.power_requirement === 'passive' || !item.power_watts ? '' : `${item.power_watts}W`,
    qty: 0,
    rate_per_day: 0,
    rate_per_week: 0,
    purchase_cost: 0,
    status: 'Active',
    material: item.material || '',
    classifier_tags: Array.isArray(item.classifier_tags) ? item.classifier_tags : [],
    equipment_group: item.group || '',
    is_template: true,
    indicative: !!item.indicative,
  };
}

function createPlatform({ admin, db, logger, HttpsError, verifyPasswordNode, hashPasswordNode, coaDefaults, equipmentDefaults, listAppIds }) {
  // listAppIds is accepted for parity with the createWhatsApp DI contract and
  // future cross-tenant sweeps; the current handlers list tenants straight from
  // the platform_tenants collection, so it is intentionally not yet consumed.
  void listAppIds;
  const nowISO = () => new Date().toISOString();
  const dataPath = (appId) => `artifacts/${appId}/public/data`;

  // ── Data gate ──────────────────────────────────────────────────────────────
  // Every handler's first act. Absent config doc → inert on this deployment.
  async function assertPlatformEnabled() {
    if (!(await db.doc(PLATFORM_CONFIG_PATH).get()).exists) {
      throw new HttpsError('failed-precondition', 'Platform features are not available on this deployment');
    }
  }

  // ── Control-plane audit trail (best-effort; never blocks the operation) ──────
  async function platformAudit({ actor_uid, actor_name, actor_role, action, tenant_id, details }) {
    try {
      await db.collection('platform_audit_logs').add({
        actor_uid: actor_uid || null,
        actor_name: actor_name || null,
        actor_role: actor_role || null,
        action,
        tenant_id: tenant_id || null,
        details: details || {},
        timestamp: nowISO(),
      });
    } catch (err) {
      logger.error(`platformAudit(${action}): ${err.message}`);
    }
  }

  // Resolve + authorize the calling staff member from the custom-token claims.
  // Requires the `staff` claim AND a live, active platform_staff doc.
  async function getStaff(auth) {
    if (!auth || !auth.token || auth.token.staff !== true || !auth.uid) {
      throw new HttpsError('permission-denied', 'Staff authentication required');
    }
    const snap = await db.doc(`platform_staff/${auth.uid}`).get();
    if (!snap.exists) throw new HttpsError('permission-denied', 'Staff account not found');
    const staff = { id: snap.id, ...snap.data() };
    if (staff.status !== 'active') throw new HttpsError('permission-denied', 'Staff account is disabled');
    return staff;
  }

  // Delete every doc in a collection in chunked batches (used to kill live
  // sessions' rules access when a tenant is suspended). Returns the count.
  async function deleteCollectionDocs(colPath) {
    const snap = await db.collection(colPath).get();
    if (snap.empty) return 0;
    let batch = db.batch();
    let pending = 0;
    let total = 0;
    for (const docSnap of snap.docs) {
      batch.delete(docSnap.ref);
      pending += 1;
      total += 1;
      if (pending >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) await batch.commit();
    return total;
  }

  // Revoke access for EVERY user of a tenant — used when a tenant is suspended,
  // churned, or its trial expires. Two-part revocation:
  //   1. revokeRefreshTokens(uid) — the standard Firebase logout: the user's next
  //      ID-token refresh (<=1h) fails, forcing re-auth, which verifyLogin then
  //      blocks (its suspended/churned status check). This is what actually ends
  //      the session; wiping the /users mirror alone does NOT, because
  //      firestore.rules userRole() falls back to /employees/{uid}.role.
  //   2. wipe the /users role mirror — removes support docs and forces every
  //      user to re-materialise their mirror on next (blocked) login.
  // uids are the tenant's employee doc ids (== the Firebase Auth uids minted by
  // verifyLogin). Best-effort per uid: many employees have never signed in and
  // have no Auth account, so revokeRefreshTokens throws — that's expected.
  // Residual window: an already-issued ID token stays valid until it expires
  // (<=1h); immediate cut-off would require a rules-level tenant-status gate.
  async function revokeTenantSessions(tenantId) {
    const empsSnap = await db.collection(`${dataPath(tenantId)}/employees`).get();
    let revoked = 0;
    for (const emp of empsSnap.docs) {
      try { await admin.auth().revokeRefreshTokens(emp.id); revoked += 1; }
      catch { /* no Firebase Auth account for this employee — nothing to revoke */ }
    }
    await deleteCollectionDocs(`${dataPath(tenantId)}/users`);
    return revoked;
  }

  // Revoke a staff member's access when they are disabled: kill their own
  // session AND any live support sessions they hold inside tenant workspaces.
  // platformManageStaff('disable') flips their status (callables re-check it on
  // every call), but without this a disabled staffer's browser keeps a valid
  // token — rules-level reads of the control plane + any standing support-admin
  // grant — until it expires (<=1h).
  async function revokeStaffSessions(staffId) {
    const supportUid = `support_${staffId}`;
    await admin.auth().revokeRefreshTokens(staffId).catch(() => {});
    await admin.auth().revokeRefreshTokens(supportUid).catch(() => {});
    const tenants = await db.collection('platform_tenants').get();
    let cleared = 0;
    for (const t of tenants.docs) {
      const ref = db.doc(`${dataPath(t.id)}/users/${supportUid}`);
      if ((await ref.get()).exists) { await ref.delete().catch(() => {}); cleared += 1; }
    }
    return cleared;
  }

  // tenant.assigned_managers is the ONLY source of truth for business_manager
  // scoping (enforced by tenantInScope + firestore.rules). staff.assigned_tenants
  // was previously written but read by nothing — assigning tenants from the staff
  // screen silently did nothing. This writes those edits THROUGH to each tenant's
  // assigned_managers so the staff-side assignment actually takes effect.
  async function syncManagerAssignments(staffId, prevTenants, nextTenants) {
    const prev = new Set(Array.isArray(prevTenants) ? prevTenants : []);
    const next = new Set(Array.isArray(nextTenants) ? nextTenants : []);
    for (const code of [...next].filter((c) => !prev.has(c))) {
      await db.doc(`platform_tenants/${code}`)
        .update({ assigned_managers: admin.firestore.FieldValue.arrayUnion(staffId) })
        .catch(() => { /* tenant may not exist — skip */ });
    }
    for (const code of [...prev].filter((c) => !next.has(c))) {
      await db.doc(`platform_tenants/${code}`)
        .update({ assigned_managers: admin.firestore.FieldValue.arrayRemove(staffId) })
        .catch(() => { /* tenant may not exist — skip */ });
    }
  }

  // Append an entry to a tenant's own audit_logs collection. Field names mirror
  // the client's logAction (src/App.jsx) EXACTLY so entries render in the
  // tenant's in-app audit view, plus a `support_session` marker.
  async function tenantAudit(appId, { action, details, staff }) {
    await db.collection(`${dataPath(appId)}/audit_logs`).add({
      collection: 'platform',
      action,
      doc_id: null,
      doc_name: '',
      details: details || {},
      performed_by: `platform:${staff.username || staff.email || staff.id}`,
      actor_emp_id: null,
      actor_name: staff.name || null,
      actor_role: `support:${staff.role}`,
      impersonated: false,
      support_session: true,
      timestamp: nowISO(),
    });
  }

  // ── 1. platformLogin ─────────────────────────────────────────────────────────
  async function platformLogin(req) {
    // Gated like EVERY other handler — the module must stay uniformly inert on a
    // non-platform deployment (the core data-gating requirement), not merely
    // fail closed after querying platform collections. (It would also fail
    // closed on its own, since a private project has no platform_staff docs, but
    // the explicit gate is what keeps it truly inert.)
    await assertPlatformEnabled();
    const { username, password } = req.data || {};
    if (!username || !password) throw new HttpsError('invalid-argument', 'Missing credentials');
    const usernameNorm = String(username).trim();

    // Lookup by username, then fall back to email. Both fields are unique.
    const [byUsername, byEmail] = await Promise.all([
      db.collection('platform_staff').where('username', '==', usernameNorm).limit(1).get(),
      db.collection('platform_staff').where('email', '==', usernameNorm).limit(1).get(),
    ]);
    const staffDoc = !byUsername.empty ? byUsername.docs[0]
      : !byEmail.empty ? byEmail.docs[0]
      : null;
    if (!staffDoc) throw new HttpsError('permission-denied', 'Invalid credentials');
    const staff = { id: staffDoc.id, ...staffDoc.data() };

    if (staff.status !== 'active') {
      throw new HttpsError('permission-denied', 'Account is disabled. Contact your administrator.');
    }

    // First-login setup: an account seeded without a password carries
    // needs_password_setup and has no secret/credentials.password — only a
    // one-time setup_key. Signal the UI (which keys off this EXACT code/message)
    // to switch to setup mode. Same information exposure as the disabled branch
    // above: only ever reached after a username/email match, so it leaks nothing
    // beyond the module's existing behaviour.
    if (staff.needs_password_setup === true) {
      throw new HttpsError('failed-precondition', 'PASSWORD_SETUP_REQUIRED');
    }

    // Rate limit — same shape as verifyLogin (5 failures → 15-min lock).
    const lockedUntil = staff.login_locked_until ? new Date(staff.login_locked_until) : null;
    if (lockedUntil && lockedUntil > new Date()) {
      throw new HttpsError('resource-exhausted', 'Too many failed attempts. Try again later.');
    }

    // Hash lives in the secret subdoc, never on the main doc.
    const credSnap = await db.doc(`platform_staff/${staff.id}/secret/credentials`).get();
    const storedHash = credSnap.exists ? credSnap.data().password : null;
    const valid = storedHash ? await verifyPasswordNode(password, storedHash) : false;

    if (!valid) {
      const attempts = (staff.failed_login_attempts || 0) + 1;
      const updates = { failed_login_attempts: attempts };
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        updates.login_locked_until = new Date(Date.now() + LOGIN_LOCK_MS).toISOString();
      }
      await staffDoc.ref.update(updates);
      throw new HttpsError('permission-denied', 'Invalid credentials');
    }

    // Success: clear the rate-limit counters.
    await staffDoc.ref.update({
      failed_login_attempts: 0,
      login_locked_until: null,
      last_login_at: nowISO(),
    });

    const token = await admin.auth().createCustomToken(staff.id, { staff: true, staff_role: staff.role });
    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action: 'staff_login', tenant_id: null, details: {},
    });
    return { token, staffId: staff.id, role: staff.role, name: staff.name || '' };
  }

  // ── 1b. platformSetupPassword ────────────────────────────────────────────────
  // First-login: exchange a one-time setup key (seeded as a pbkdf2 hash at
  // platform_staff/{id}/secret/credentials.setup_key) for a chosen password, then
  // log straight in. Mirrors platformLogin's rate-limit shape and mints the same
  // staff custom token.
  async function platformSetupPassword(req) {
    await assertPlatformEnabled();
    const { username, setupKey, newPassword } = req.data || {};
    if (!username || !setupKey || !newPassword) {
      throw new HttpsError('invalid-argument', 'username, setupKey and newPassword are required');
    }
    const usernameNorm = String(username).trim();

    // Lookup by username, then email (both unique) — same as platformLogin.
    const [byUsername, byEmail] = await Promise.all([
      db.collection('platform_staff').where('username', '==', usernameNorm).limit(1).get(),
      db.collection('platform_staff').where('email', '==', usernameNorm).limit(1).get(),
    ]);
    const staffDoc = !byUsername.empty ? byUsername.docs[0]
      : !byEmail.empty ? byEmail.docs[0]
      : null;

    // ONE generic error for "no such account / not awaiting setup / wrong key",
    // so this never reveals whether a username exists or its exact state.
    const GENERIC = 'Invalid setup key or the account is not awaiting setup';
    if (!staffDoc) throw new HttpsError('permission-denied', GENERIC);
    const staff = { id: staffDoc.id, ...staffDoc.data() };
    if (staff.status !== 'active' || staff.needs_password_setup !== true) {
      throw new HttpsError('permission-denied', GENERIC);
    }

    // Rate limit — reuse the login counters on the staff doc.
    const lockedUntil = staff.login_locked_until ? new Date(staff.login_locked_until) : null;
    if (lockedUntil && lockedUntil > new Date()) {
      throw new HttpsError('resource-exhausted', 'Too many failed attempts. Try again later.');
    }

    // Constant-time verify the setup key against its stored pbkdf2 hash. A wrong
    // key counts as a failed attempt (same lockout as login).
    const credSnap = await db.doc(`platform_staff/${staff.id}/secret/credentials`).get();
    const cred = credSnap.exists ? credSnap.data() : {};
    const storedKeyHash = cred.setup_key || null;
    const keyValid = storedKeyHash ? await verifyPasswordNode(String(setupKey), storedKeyHash) : false;
    if (!keyValid) {
      const attempts = (staff.failed_login_attempts || 0) + 1;
      const updates = { failed_login_attempts: attempts };
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        updates.login_locked_until = new Date(Date.now() + LOGIN_LOCK_MS).toISOString();
      }
      await staffDoc.ref.update(updates);
      throw new HttpsError('permission-denied', GENERIC);
    }

    // Key correct but expired → do NOT set a password. Distinct code so the UI
    // can prompt for a fresh key (the holder has already proven key knowledge, so
    // this leaks nothing new).
    const expISO = cred.setup_key_expires || null;
    if (expISO && new Date(expISO) < new Date()) {
      throw new HttpsError('failed-precondition', 'SETUP_KEY_EXPIRED');
    }

    // Validate the chosen password AFTER the key check (a valid key was spent to
    // reach here, but a weak password neither consumes an attempt nor burns the
    // key — the holder can simply retry with a stronger one).
    const pwErr = validateStaffPassword(newPassword);
    if (pwErr) throw new HttpsError('invalid-argument', pwErr);

    // Commit: set the password, delete the one-time key, leave setup mode, reset
    // the rate-limit counters.
    const ts = nowISO();
    await db.doc(`platform_staff/${staff.id}/secret/credentials`).set({
      password: await hashPasswordNode(String(newPassword)),
      setup_key: admin.firestore.FieldValue.delete(),
      setup_key_expires: admin.firestore.FieldValue.delete(),
      updated_at: ts,
    }, { merge: true });
    await staffDoc.ref.update({
      needs_password_setup: false,
      failed_login_attempts: 0,
      login_locked_until: null,
      password_set_at: ts,
      last_login_at: ts,
    });

    const token = await admin.auth().createCustomToken(staff.id, { staff: true, staff_role: staff.role });
    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action: 'staff_password_set', tenant_id: null, details: {},
    });
    return { token, staffId: staff.id, role: staff.role, name: staff.name || '' };
  }

  // ── 2. platformCreateTenant ──────────────────────────────────────────────────
  async function platformCreateTenant(req) {
    await assertPlatformEnabled();
    const staff = await getStaff(req.auth);
    const d = req.data || {};
    const {
      code, name, region, plan, trial_expires_on,
      contact_name, contact_email, contact_phone, ownerPassword,
    } = d;

    // Authz: super_admin (any region) or regional_admin (own region only).
    if (staff.role === 'business_manager') {
      throw new HttpsError('permission-denied', 'Business managers cannot create tenants');
    }
    if (staff.role === 'regional_admin' &&
        !(Array.isArray(staff.regions) && staff.regions.includes(region))) {
      throw new HttpsError('permission-denied', 'Region is outside your assigned regions');
    }

    // Validate inputs.
    if (!isValidTenantCode(code)) {
      throw new HttpsError('invalid-argument', 'Tenant code must be a slug of 3–30 characters (a–z, 0–9, hyphen)');
    }
    if (!name || !String(name).trim()) throw new HttpsError('invalid-argument', 'Tenant name is required');
    if (!ownerPassword || String(ownerPassword).length < 8) {
      throw new HttpsError('invalid-argument', 'Owner password must be at least 8 characters');
    }
    const planNorm = plan || 'trial';
    if (!TENANT_PLANS.includes(planNorm)) throw new HttpsError('invalid-argument', 'Invalid plan');

    // Must not collide with an existing tenant OR any existing tenant data
    // (belt-and-braces: never provision over a live workspace).
    if ((await db.doc(`platform_tenants/${code}`).get()).exists) {
      throw new HttpsError('already-exists', 'A tenant with this code already exists');
    }
    if ((await db.doc(`${dataPath(code)}`).listCollections()).length !== 0) {
      throw new HttpsError('already-exists', 'Workspace data already exists for this tenant code');
    }

    const ts = nowISO();
    const tenant = {
      name: String(name).trim(),
      code,
      region: region || null,
      status: 'active',
      plan: planNorm,
      trial_expires_on: trial_expires_on || null,
      assigned_managers: [],
      contact_name: contact_name || '',
      contact_email: contact_email || '',
      contact_phone: contact_phone || '',
      notes: '',
      created_at: ts,
      created_by: staff.id,
      updated_at: ts,
      updated_by: staff.id,
    };
    await db.doc(`platform_tenants/${code}`).set(tenant);

    // Seed settings/security EXACTLY as verifyLogin's admin branch requires: it
    // reads settings/security.admin_password (a v3 pbkdf2 hash), checks the
    // login_locked_until / failed_login_attempts counters, and — for username
    // "admin" (case-insensitive) — auto-creates the admin employee + /users
    // mirror on first login. So the owner can sign in immediately with
    // { username: 'admin', password: ownerPassword }.
    await db.doc(`${dataPath(code)}/settings/security`).set({
      admin_password: await hashPasswordNode(ownerPassword),
      password_hashed: true,
      failed_login_attempts: 0,
      login_locked_until: null,
    });

    await db.doc(`${dataPath(code)}/settings/organization`).set({
      name: tenant.name,
      created_at: ts,
    });

    // Seed chart_of_accounts identically to the client's seedDefaultCoa
    // (src/pages/Accounting.jsx): doc id == row.code, merge-write with
    // created_by / created_at stamped on.
    const defaults = coaDefaults.getDefaultChartOfAccounts();
    let batch = db.batch();
    let pending = 0;
    for (const row of defaults) {
      batch.set(
        db.doc(`${dataPath(code)}/chart_of_accounts/${row.code}`),
        { ...row, created_by: staff.id, created_at: ts },
        { merge: true },
      );
      if ((pending += 1) >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();

    // Seed a starter equipment catalog into inventory (default event/rental
    // equipment with sizes/power specs) so the tenant starts with a usable
    // catalog to stock and price. Templates: qty 0, rates 0. Best-effort per
    // item; the tenant can bulk-edit/delete afterwards.
    if (equipmentDefaults && typeof equipmentDefaults.getDefaultEquipmentCatalog === 'function') {
      const items = equipmentDefaults.getDefaultEquipmentCatalog();
      batch = db.batch();
      pending = 0;
      let seeded = 0;
      for (const item of items) {
        const ref = db.collection(`${dataPath(code)}/inventory`).doc();
        batch.set(ref, { ...equipmentToInventory(item), created_by: staff.id, created_at: ts });
        seeded += 1;
        if ((pending += 1) >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); pending = 0; }
      }
      if (pending > 0) await batch.commit();
      logger.info(`platformCreateTenant: seeded ${seeded} equipment templates for ${code}`);
    }

    // Register with the cron/discovery registry so scheduled posters see it.
    await db.doc('meta/active_apps').set({
      ids: admin.firestore.FieldValue.arrayUnion(code),
      last_seen: { [code]: ts },
    }, { merge: true });

    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action: 'tenant_create', tenant_id: code,
      details: { name: tenant.name, region: tenant.region, plan: planNorm },
    });

    return {
      ok: true,
      tenant,
      ownerLogin: {
        username: 'admin',
        note: 'Sign in with username "admin" and the owner password you supplied, then change it under Admin → Security.',
      },
    };
  }

  // ── 3. platformListTenants ───────────────────────────────────────────────────
  async function platformListTenants(req) {
    await assertPlatformEnabled();
    const staff = await getStaff(req.auth);
    // Tenant counts are small — fetch all and filter in memory via the shared
    // scope predicate (keeps one code path for every role).
    const snap = await db.collection('platform_tenants').get();
    const tenants = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((tenant) => tenantInScope(staff, tenant))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return { tenants };
  }

  // ── 4. platformUpdateTenant ──────────────────────────────────────────────────
  async function platformUpdateTenant(req) {
    await assertPlatformEnabled();
    const staff = await getStaff(req.auth);
    const { tenantId, patch } = req.data || {};
    if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId is required');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new HttpsError('invalid-argument', 'patch object is required');
    }

    const ref = db.doc(`platform_tenants/${tenantId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tenant not found');
    const tenant = { id: snap.id, ...snap.data() };
    if (!tenantInScope(staff, tenant)) throw new HttpsError('permission-denied', 'Tenant is outside your scope');

    // Whitelist — silently drop any key not in TENANT_PATCH_KEYS (this is what
    // blocks re-keying `code`, forging `created_by`, etc.).
    const clean = {};
    for (const key of TENANT_PATCH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
    if (staff.role !== 'super_admin') {
      for (const key of TENANT_SUPER_ADMIN_ONLY_KEYS) {
        if (key in clean) throw new HttpsError('permission-denied', `Only a super admin may change ${key}`);
      }
    }
    if ('status' in clean && !TENANT_STATUSES.includes(clean.status)) {
      throw new HttpsError('invalid-argument', 'Invalid status');
    }
    if ('plan' in clean && !TENANT_PLANS.includes(clean.plan)) {
      throw new HttpsError('invalid-argument', 'Invalid plan');
    }
    if ('assigned_managers' in clean && !Array.isArray(clean.assigned_managers)) {
      throw new HttpsError('invalid-argument', 'assigned_managers must be an array');
    }
    if (Object.keys(clean).length === 0) throw new HttpsError('invalid-argument', 'No updatable fields in patch');

    // Any transition INTO a non-active status (suspended or churned) must revoke
    // every live session — not merely block new logins. Previously only
    // 'suspended' wiped the /users mirror, and even that left live sessions with
    // access via the /employees role fallback; churn did neither.
    const deactivating = ('status' in clean)
      && ['suspended', 'churned'].includes(clean.status)
      && clean.status !== tenant.status;

    clean.updated_at = nowISO();
    clean.updated_by = staff.id;
    await ref.update(clean);

    if (deactivating) {
      const revoked = await revokeTenantSessions(tenantId);
      logger.info(`platformUpdateTenant: ${tenantId} -> ${clean.status}, revoked ${revoked} session(s)`);
    }

    const action = deactivating
      ? (clean.status === 'churned' ? 'tenant_churn' : 'tenant_suspend')
      : 'tenant_update';
    const updated = { ...tenant, ...clean };
    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action, tenant_id: tenantId,
      details: { fields: Object.keys(clean) },
    });
    return { ok: true, tenant: updated };
  }

  // ── 5. platformSupportAccess ─────────────────────────────────────────────────
  async function platformSupportAccess(req) {
    await assertPlatformEnabled();
    const staff = await getStaff(req.auth);
    const { tenantId } = req.data || {};
    if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId is required');

    const snap = await db.doc(`platform_tenants/${tenantId}`).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tenant not found');
    const tenant = { id: snap.id, ...snap.data() };
    // Scope is enforced; a suspended tenant is intentionally still reachable
    // for support (e.g. to investigate before churn).
    if (!tenantInScope(staff, tenant)) throw new HttpsError('permission-denied', 'Tenant is outside your scope');

    const uid = `support_${staff.id}`;
    const ts = nowISO();
    const expiresAt = new Date(Date.now() + SUPPORT_SESSION_MS).toISOString();

    // Time-boxed admin mirror doc → tenant rules grant this uid admin access.
    await db.doc(`${dataPath(tenantId)}/users/${uid}`).set({
      role: 'admin',
      name: `Support: ${staff.name || staff.username || staff.id}`,
      support: true,
      staff_uid: staff.id,
      support_expires_at: expiresAt,
      updated_at: ts,
    }, { merge: true });

    // Record on BOTH trails: the tenant's own audit_logs (visible in-app) and
    // the control-plane log.
    await tenantAudit(tenantId, {
      action: 'support_session_start',
      details: { staff_uid: staff.id, support_expires_at: expiresAt },
      staff,
    });
    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action: 'support_session_start', tenant_id: tenantId,
      details: { support_expires_at: expiresAt },
    });

    const token = await admin.auth().createCustomToken(uid, {
      role: 'admin', appId: tenantId, support: true, staff_uid: staff.id,
    });
    return { token, tenant: { id: tenant.id, name: tenant.name } };
  }

  // ── 6. platformResumeStaff ───────────────────────────────────────────────────
  // Called from inside a support session (support token) to end it and hop back
  // to a fresh staff token.
  async function platformResumeStaff(req) {
    await assertPlatformEnabled();
    const auth = req.auth;
    if (!auth || !auth.token || auth.token.support !== true || !auth.token.staff_uid) {
      throw new HttpsError('permission-denied', 'Not in a support session');
    }
    const staffUid = auth.token.staff_uid;
    const appId = auth.token.appId;
    if (!appId) throw new HttpsError('failed-precondition', 'Support session is missing its tenant');

    const staffSnap = await db.doc(`platform_staff/${staffUid}`).get();
    if (!staffSnap.exists) throw new HttpsError('permission-denied', 'Staff account not found');
    const staff = { id: staffSnap.id, ...staffSnap.data() };
    if (staff.status !== 'active') throw new HttpsError('permission-denied', 'Staff account is disabled');

    // Revoke the tenant-side admin mirror doc, ending rules access.
    await db.doc(`${dataPath(appId)}/users/support_${staffUid}`).delete().catch(() => {});

    await tenantAudit(appId, { action: 'support_session_end', details: {}, staff });
    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action: 'support_session_end', tenant_id: appId, details: {},
    });

    const token = await admin.auth().createCustomToken(staff.id, { staff: true, staff_role: staff.role });
    return { token, staffId: staff.id, role: staff.role, name: staff.name || '' };
  }

  // ── 7. platformManageStaff ───────────────────────────────────────────────────
  async function platformManageStaff(req) {
    await assertPlatformEnabled();
    const staff = await getStaff(req.auth);
    if (staff.role !== 'super_admin') throw new HttpsError('permission-denied', 'Only a super admin may manage staff');
    const { op, staffId, data } = req.data || {};

    if (op === 'list') {
      const snap = await db.collection('platform_staff').get();
      // Secrets live only in the /secret/credentials subdoc, which is never
      // read here — the main docs carry no password material.
      const list = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      return { staff: list };
    }

    if (op === 'create') {
      const dd = data || {};
      const { name, username, email, role, regions, assigned_tenants, password } = dd;
      if (!name || !username || !email || !role || !password) {
        throw new HttpsError('invalid-argument', 'name, username, email, role and password are required');
      }
      if (!STAFF_ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Invalid role');
      if (String(password).length < 8) throw new HttpsError('invalid-argument', 'Password must be at least 8 characters');

      const usernameNorm = String(username).trim();
      const emailNorm = String(email).trim();
      const [uSnap, eSnap] = await Promise.all([
        db.collection('platform_staff').where('username', '==', usernameNorm).limit(1).get(),
        db.collection('platform_staff').where('email', '==', emailNorm).limit(1).get(),
      ]);
      if (!uSnap.empty) throw new HttpsError('already-exists', 'Username already in use');
      if (!eSnap.empty) throw new HttpsError('already-exists', 'Email already in use');

      const ref = db.collection('platform_staff').doc();
      const ts = nowISO();
      const doc = {
        name: String(name).trim(),
        email: emailNorm,
        username: usernameNorm,
        role,
        regions: Array.isArray(regions) ? regions : [],
        assigned_tenants: Array.isArray(assigned_tenants) ? assigned_tenants : [],
        status: 'active',
        failed_login_attempts: 0,
        login_locked_until: null,
        created_at: ts,
        created_by: staff.id,
      };
      await ref.set(doc);
      await db.doc(`platform_staff/${ref.id}/secret/credentials`).set({
        password: await hashPasswordNode(password),
      });
      // Write the assignment through to the tenants' assigned_managers.
      await syncManagerAssignments(ref.id, [], doc.assigned_tenants);
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'staff_create', tenant_id: null, details: { staffId: ref.id, role },
      });
      return { ok: true, staff: { id: ref.id, ...doc } };
    }

    if (op === 'update') {
      if (!staffId) throw new HttpsError('invalid-argument', 'staffId is required');
      const dd = data || {};
      const ref = db.doc(`platform_staff/${staffId}`);
      const priorSnap = await ref.get();
      if (!priorSnap.exists) throw new HttpsError('not-found', 'Staff not found');
      const priorAssigned = priorSnap.data().assigned_tenants;

      const clean = {};
      for (const key of STAFF_UPDATE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(dd, key)) clean[key] = dd[key];
      }
      if ('role' in clean && !STAFF_ROLES.includes(clean.role)) throw new HttpsError('invalid-argument', 'Invalid role');
      if ('status' in clean && !STAFF_STATUSES.includes(clean.status)) throw new HttpsError('invalid-argument', 'Invalid status');
      if (dd.password !== undefined && String(dd.password).length < 8) {
        throw new HttpsError('invalid-argument', 'Password must be at least 8 characters');
      }

      clean.updated_at = nowISO();
      clean.updated_by = staff.id;
      await ref.update(clean);

      if ('assigned_tenants' in clean) {
        await syncManagerAssignments(staffId, priorAssigned, clean.assigned_tenants);
      }
      if (dd.password !== undefined) {
        await db.doc(`platform_staff/${staffId}/secret/credentials`).set(
          { password: await hashPasswordNode(dd.password) },
          { merge: true },
        );
      }
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'staff_update', tenant_id: null,
        details: { staffId, fields: Object.keys(clean), password_rotated: dd.password !== undefined },
      });
      return { ok: true };
    }

    if (op === 'disable') {
      if (!staffId) throw new HttpsError('invalid-argument', 'staffId is required');
      if (staffId === staff.id) throw new HttpsError('failed-precondition', 'You cannot disable your own account');
      const ref = db.doc(`platform_staff/${staffId}`);
      const targetSnap = await ref.get();
      if (!targetSnap.exists) throw new HttpsError('not-found', 'Staff not found');
      // Never disable the last active super_admin — that would lock everyone out
      // of staff management.
      if (targetSnap.data().role === 'super_admin') {
        const supers = await db.collection('platform_staff')
          .where('role', '==', 'super_admin').where('status', '==', 'active').get();
        if (supers.size <= 1) throw new HttpsError('failed-precondition', 'Cannot disable the last active super admin');
      }
      await ref.update({ status: 'disabled', updated_at: nowISO(), updated_by: staff.id });
      const clearedSupport = await revokeStaffSessions(staffId);
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'staff_disable', tenant_id: null, details: { staffId, cleared_support: clearedSupport },
      });
      return { ok: true };
    }

    throw new HttpsError('invalid-argument', `Unknown op: ${op}`);
  }

  // ── 8. platformManageTenantUsers ─────────────────────────────────────────────
  // Cross-tenant employee management: a scoped staff member operates directly on
  // a tenant's employees (artifacts/{tenantId}/public/data/employees) and their
  // /users mirror. Every mutation is double-logged — into the tenant's own
  // audit_logs (so it surfaces in-app, support_session style) AND the
  // control-plane platform_audit_logs.
  async function platformManageTenantUsers(req) {
    await assertPlatformEnabled();
    const staff = await getStaff(req.auth);
    const { tenantId, op, userId, data } = req.data || {};
    if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId is required');
    if (!op) throw new HttpsError('invalid-argument', 'op is required');

    const tSnap = await db.doc(`platform_tenants/${tenantId}`).get();
    if (!tSnap.exists) throw new HttpsError('not-found', 'Tenant not found');
    const tenant = { id: tSnap.id, ...tSnap.data() };
    if (!tenantInScope(staff, tenant)) {
      throw new HttpsError('permission-denied', 'Tenant is outside your scope');
    }

    const empCol = db.collection(`${dataPath(tenantId)}/employees`);
    const usersCol = db.collection(`${dataPath(tenantId)}/users`);
    const actor = `platform:${staff.email || staff.username || staff.id}`;

    // Shared: load all employees (tenants are small) for guard checks.
    const loadEmployees = async () =>
      (await empCol.get()).docs.map((d) => ({ id: d.id, ...d.data() }));

    if (op === 'list') {
      const snap = await empCol.get();
      const users = snap.docs
        .map((d) => {
          const e = d.data() || {};
          // Never surface password material or hashes.
          return {
            id: d.id,
            name: e.name || '',
            username: e.username || '',
            email: e.email || '',
            role: e.role || '',
            status: e.status || '',
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { users };
    }

    if (op === 'create') {
      const dd = data || {};
      const { name, username, email, role, password } = dd;
      if (!name || !username || !email || !role || !password) {
        throw new HttpsError('invalid-argument', 'name, username, email, role and password are required');
      }
      if (!TENANT_USER_ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Invalid role');
      if (String(password).length < TENANT_USER_PASSWORD_MIN_LEN) {
        throw new HttpsError('invalid-argument', `Password must be at least ${TENANT_USER_PASSWORD_MIN_LEN} characters`);
      }

      const usernameNorm = String(username).trim();
      const emailNorm = String(email).trim();
      const [uSnap, eSnap] = await Promise.all([
        empCol.where('username', '==', usernameNorm).limit(1).get(),
        empCol.where('email', '==', emailNorm).limit(1).get(),
      ]);
      if (!uSnap.empty) throw new HttpsError('already-exists', 'Username already in use');
      if (!eSnap.empty) throw new HttpsError('already-exists', 'Email already in use');

      const ref = empCol.doc();
      const ts = nowISO();
      const empDoc = {
        name: String(name).trim(),
        username: usernameNorm,
        email: emailNorm,
        role,
        status: 'Active',
        password: await hashPasswordNode(String(password)),
        password_hashed: true,
        failed_login_attempts: 0,
        created_at: ts,
        created_by: actor,
      };
      await ref.set(empDoc);
      // Mirror carries only what the tenant rules / UI need — no password.
      await usersCol.doc(ref.id).set({
        role,
        name: empDoc.name,
        email: emailNorm,
        employee_id: ref.id,
        updated_at: ts,
      }, { merge: true });

      await tenantAudit(tenantId, {
        action: 'tenant_user_create',
        details: { user_id: ref.id, username: usernameNorm, role },
        staff,
      });
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'tenant_user_create', tenant_id: tenantId,
        details: { user_id: ref.id, username: usernameNorm, role },
      });
      return { ok: true, userId: ref.id };
    }

    if (op === 'update') {
      if (!userId) throw new HttpsError('invalid-argument', 'userId is required');
      const dd = data || {};
      const ref = empCol.doc(userId);
      if (!(await ref.get()).exists) throw new HttpsError('not-found', 'User not found');

      // Whitelist the mutable fields — this is what blocks escalating via an
      // arbitrary extra field (e.g. is_locked, password) or an off-list role.
      const clean = {};
      if (dd.name !== undefined) clean.name = String(dd.name).trim();
      if (dd.email !== undefined) clean.email = String(dd.email).trim();
      if (dd.role !== undefined) {
        if (!TENANT_USER_ROLES.includes(dd.role)) throw new HttpsError('invalid-argument', 'Invalid role');
        clean.role = dd.role;
      }
      if (dd.status !== undefined) {
        if (!TENANT_USER_STATUSES.includes(dd.status)) throw new HttpsError('invalid-argument', 'Invalid status');
        clean.status = dd.status;
      }
      if (Object.keys(clean).length === 0) throw new HttpsError('invalid-argument', 'No updatable fields provided');

      // Last-admin guard: a role/status change must not remove the final admin.
      if (clean.role !== undefined || clean.status !== undefined) {
        const remaining = countActiveAdminsAfter(await loadEmployees(), {
          id: userId, role: clean.role, status: clean.status,
        });
        if (remaining < 1) {
          throw new HttpsError('failed-precondition', "This would remove the tenant's last active admin");
        }
      }

      clean.updated_at = nowISO();
      clean.updated_by = actor;
      await ref.update(clean);

      // Keep the mirror in sync for the fields it carries (role drives rules).
      const mirror = {};
      if (clean.role !== undefined) mirror.role = clean.role;
      if (clean.name !== undefined) mirror.name = clean.name;
      if (clean.email !== undefined) mirror.email = clean.email;
      if (Object.keys(mirror).length > 0) {
        mirror.updated_at = clean.updated_at;
        await usersCol.doc(userId).set(mirror, { merge: true });
      }

      const fields = Object.keys(clean).filter((k) => k !== 'updated_at' && k !== 'updated_by');
      await tenantAudit(tenantId, {
        action: 'tenant_user_update', details: { user_id: userId, fields }, staff,
      });
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'tenant_user_update', tenant_id: tenantId, details: { user_id: userId, fields },
      });
      return { ok: true };
    }

    if (op === 'disable') {
      if (!userId) throw new HttpsError('invalid-argument', 'userId is required');
      const ref = empCol.doc(userId);
      if (!(await ref.get()).exists) throw new HttpsError('not-found', 'User not found');

      // Last-admin guard: never disable the tenant's final active admin.
      const remaining = countActiveAdminsAfter(await loadEmployees(), { id: userId, status: 'Disabled' });
      if (remaining < 1) {
        throw new HttpsError('failed-precondition', "This would disable the tenant's last active admin");
      }

      await ref.update({ status: 'Disabled', updated_at: nowISO(), updated_by: actor });
      await tenantAudit(tenantId, { action: 'tenant_user_disable', details: { user_id: userId }, staff });
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'tenant_user_disable', tenant_id: tenantId, details: { user_id: userId },
      });
      return { ok: true };
    }

    if (op === 'resetPassword') {
      if (!userId) throw new HttpsError('invalid-argument', 'userId is required');
      const dd = data || {};
      if (!dd.password || String(dd.password).length < TENANT_USER_PASSWORD_MIN_LEN) {
        throw new HttpsError('invalid-argument', `Password must be at least ${TENANT_USER_PASSWORD_MIN_LEN} characters`);
      }
      const ref = empCol.doc(userId);
      if (!(await ref.get()).exists) throw new HttpsError('not-found', 'User not found');

      await ref.update({
        password: await hashPasswordNode(String(dd.password)),
        password_hashed: true,
        failed_login_attempts: 0,
        is_locked: false,
        updated_at: nowISO(),
        updated_by: actor,
      });
      await tenantAudit(tenantId, { action: 'tenant_user_reset_password', details: { user_id: userId }, staff });
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'tenant_user_reset_password', tenant_id: tenantId, details: { user_id: userId },
      });
      return { ok: true };
    }

    throw new HttpsError('invalid-argument', `Unknown op: ${op}`);
  }

  // ── Scheduled: enforce trial expiry ──────────────────────────────────────────
  // Active tenants on the 'trial' plan whose trial_expires_on has passed (beyond
  // an optional grace period from platform_meta/config.trial_grace_days, default
  // 0) are auto-suspended and their sessions revoked. verifyLogin already blocks
  // login to a suspended tenant. Inert off the SaaS project (empty query).
  async function enforceTrialExpiry() {
    const today = nowISO().slice(0, 10);
    let graceDays = 0;
    try {
      const cfg = await db.doc(PLATFORM_CONFIG_PATH).get();
      if (cfg.exists && Number.isFinite(cfg.data().trial_grace_days)) graceDays = cfg.data().trial_grace_days;
    } catch { /* default grace */ }
    const snap = await db.collection('platform_tenants')
      .where('plan', '==', 'trial').where('status', '==', 'active').get();
    let suspended = 0;
    for (const doc of snap.docs) {
      const t = doc.data();
      if (!t.trial_expires_on) continue;
      // Cutoff = expiry + grace, compared as YYYY-MM-DD strings (lexicographic).
      const cutoff = graceDays > 0
        ? new Date(new Date(`${t.trial_expires_on}T00:00:00Z`).getTime() + graceDays * 86400000).toISOString().slice(0, 10)
        : t.trial_expires_on;
      if (today <= cutoff) continue;
      await doc.ref.update({ status: 'suspended', suspended_reason: 'trial_expired', updated_at: nowISO(), updated_by: 'system:trial_expiry' });
      await revokeTenantSessions(doc.id);
      await platformAudit({
        actor_uid: 'system', actor_name: 'Trial Expiry', actor_role: 'system',
        action: 'tenant_suspend', tenant_id: doc.id, details: { reason: 'trial_expired', trial_expires_on: t.trial_expires_on },
      });
      suspended += 1;
    }
    if (suspended) logger.info(`enforceTrialExpiry: suspended ${suspended} expired trial tenant(s)`);
    return { suspended };
  }

  // ── Scheduled: sweep expired support sessions ────────────────────────────────
  // A support session mints a users/support_{staffId} admin mirror doc with a
  // support_expires_at (+4h). If staff never call platformResumeStaff, that
  // standing tenant-admin grant would persist forever. This deletes expired
  // support mirror docs and revokes the support uid's tokens. Iterates
  // platform_tenants (naturally scoped, no collectionGroup index needed); inert
  // off the SaaS project.
  async function sweepSupportSessions() {
    const now = Date.now();
    let swept = 0;
    const tenants = await db.collection('platform_tenants').get();
    for (const t of tenants.docs) {
      const supportDocs = await db.collection(`${dataPath(t.id)}/users`).where('support', '==', true).get();
      for (const d of supportDocs.docs) {
        const exp = d.data().support_expires_at;
        if (!exp || new Date(exp).getTime() >= now) continue;
        await d.ref.delete().catch(() => {});
        await admin.auth().revokeRefreshTokens(d.id).catch(() => {}); // d.id == support_{staffId}
        await platformAudit({
          actor_uid: 'system', actor_name: 'Support Sweep', actor_role: 'system',
          action: 'support_session_expired', tenant_id: t.id, details: { support_doc: d.id },
        });
        swept += 1;
      }
    }
    if (swept) logger.info(`sweepSupportSessions: revoked ${swept} expired support session(s)`);
    return { swept };
  }

  return {
    platformLogin,
    platformSetupPassword,
    platformCreateTenant,
    platformListTenants,
    platformUpdateTenant,
    platformSupportAccess,
    platformResumeStaff,
    platformManageStaff,
    platformManageTenantUsers,
    enforceTrialExpiry,
    sweepSupportSessions,
  };
}

module.exports = {
  createPlatform,
  tenantInScope,
  TENANT_PATCH_KEYS,
  isValidTenantCode,
  validateStaffPassword,
  countActiveAdminsAfter,
  TENANT_USER_ROLES,
  PASSWORD_MIN_LEN,
};
