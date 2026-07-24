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

function createPlatform({ admin, db, logger, HttpsError, verifyPasswordNode, hashPasswordNode, coaDefaults, listAppIds }) {
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

    const suspending = clean.status === 'suspended' && tenant.status !== 'suspended';

    clean.updated_at = nowISO();
    clean.updated_by = staff.id;
    await ref.update(clean);

    // Suspending kills every live session's rules access: the tenant's rules
    // resolve role via /users/{uid}, so wiping that collection locks everyone
    // out immediately (they re-materialize their mirror doc on next login once
    // reactivated).
    if (suspending) {
      await deleteCollectionDocs(`${dataPath(tenantId)}/users`);
    }

    const updated = { ...tenant, ...clean };
    await platformAudit({
      actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
      action: suspending ? 'tenant_suspend' : 'tenant_update', tenant_id: tenantId,
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
      if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Staff not found');

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
      const ref = db.doc(`platform_staff/${staffId}`);
      if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Staff not found');
      await ref.update({ status: 'disabled', updated_at: nowISO(), updated_by: staff.id });
      await platformAudit({
        actor_uid: staff.id, actor_name: staff.name, actor_role: staff.role,
        action: 'staff_disable', tenant_id: null, details: { staffId },
      });
      return { ok: true };
    }

    throw new HttpsError('invalid-argument', `Unknown op: ${op}`);
  }

  return {
    platformLogin,
    platformCreateTenant,
    platformListTenants,
    platformUpdateTenant,
    platformSupportAccess,
    platformResumeStaff,
    platformManageStaff,
  };
}

module.exports = { createPlatform, tenantInScope, TENANT_PATCH_KEYS, isValidTenantCode };
