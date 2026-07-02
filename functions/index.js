/**
 * Cloud Functions for rental-ops.
 *
 * Scheduled poster — runs every day at 01:00 IST. App discovery uses an
 * explicit registry doc at `meta/active_apps` (preferred) and falls back to
 * a collectionGroup scan. Idempotent: skips drafts that already have a
 * matching `journal_entries` doc with `scheduled_from_draft == draftId`.
 *
 * Callables:
 *   - verifyLogin({ username, password, appId })
 *       → Verifies credentials server-side, returns a Firebase custom token.
 *         Removes the need for anonymous Firestore reads of employees/settings.
 *   - runScheduledDraftsNow(appIds?: string[]) → admin-only, manual trigger.
 *   - runRecurringTemplatesNow(appIds?: string[]) → admin-only, generates
 *     draft journal entries from `recurring_rules` with `template_id` set.
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { pbkdf2, timingSafeEqual, createHash, createHmac, randomBytes } = require('crypto');
const { promisify } = require('util');

admin.initializeApp();
const db = admin.firestore();
const pbkdf2Async = promisify(pbkdf2);

// ── Helpers ────────────────────────────────────────────────────────────────
function fyOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  const endYear = (startYear + 1).toString().slice(-2);
  return `${startYear}-${endYear}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function nextVoucherNo(appId, fy) {
  const counterRef = db.doc(`artifacts/${appId}/public/data/counters/vouchers_${fy}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists ? Number(snap.data().value || 0) : 0;
    const next = current + 1;
    tx.set(counterRef, { value: next, fy }, { merge: true });
    return `JV/${fy}/${String(next).padStart(4, '0')}`;
  });
}

async function listAppIds() {
  try {
    const reg = await db.doc('meta/active_apps').get();
    if (reg.exists) {
      const ids = reg.data().ids;
      if (Array.isArray(ids) && ids.length) return ids.filter(Boolean);
    }
  } catch (err) {
    logger.warn('Failed to read meta/active_apps; falling back to scan', err);
  }
  const cg = await db.collectionGroup('journal_drafts').limit(500).get();
  const ids = new Set();
  cg.forEach((d) => {
    const parts = d.ref.path.split('/');
    if (parts[0] === 'artifacts' && parts[1]) ids.add(parts[1]);
  });
  return [...ids];
}

async function isDraftAlreadyPosted(appId, draftId) {
  const q = await db
    .collection(`artifacts/${appId}/public/data/journal_entries`)
    .where('scheduled_from_draft', '==', draftId)
    .limit(1)
    .get();
  return !q.empty;
}

async function processAppDrafts(appId, today) {
  const draftsCol = db.collection(`artifacts/${appId}/public/data/journal_drafts`);
  const due = await draftsCol
    .where('schedule_post_on', '>', '')
    .where('schedule_post_on', '<=', today)
    .get();
  if (due.empty) return { posted: 0, failed: 0, skipped: 0 };
  let posted = 0;
  let failed = 0;
  let skipped = 0;
  for (const docSnap of due.docs) {
    const draft = docSnap.data() || {};
    if (draft.requires_approval && draft.approval_status !== 'approved') {
      skipped += 1;
      logger.info(`[${appId}] Draft ${docSnap.id} skipped — pending approval`);
      continue;
    }
    try {
      if (await isDraftAlreadyPosted(appId, docSnap.id)) {
        skipped += 1;
        await docSnap.ref.delete().catch(() => {});
        logger.info(`[${appId}] Draft ${docSnap.id} already posted → cleaned up`);
        continue;
      }
    } catch (err) {
      logger.warn(`[${appId}] Idempotency check failed for ${docSnap.id}`, err);
    }
    try {
      const dateStr = draft.date || today;
      const fy = fyOf(dateStr);
      const voucherNo = await nextVoucherNo(appId, fy);
      const payload = {
        voucher_no: voucherNo,
        fy,
        date: dateStr,
        narration: draft.narration || '',
        source: 'scheduled_post',
        status: 'posted',
        entries: draft.entries || [],
        origin: draft.origin || 'ai_chat',
        ai_intent: draft.ai_intent || draft.intent || null,
        ai_confidence: typeof draft.ai_confidence === 'number' ? draft.ai_confidence : null,
        ai_model: draft.ai_model || 'rule-v1',
        ai_prompt: draft.raw_prompt || draft.ai_prompt || '',
        ai_issues: (draft.ai_issues || []).filter((i) => i && i.level !== 'error'),
        party_name: draft.party_name || null,
        party_type: draft.party_type || null,
        linked_party_id: draft.linked_party_id || null,
        linked_party_type: draft.linked_party_type || null,
        project_tag: draft.project_tag || null,
        linked_project_id: draft.linked_project_id || null,
        linked_project_name: draft.linked_project_name || null,
        attachments: draft.attachments || [],
        currency: draft.currency || 'INR',
        fx_rate_to_inr: draft.fx_rate_to_inr || 1,
        created_by: draft.created_by || 'cloud_scheduler',
        created_at: new Date().toISOString(),
        scheduled_from_draft: docSnap.id,
      };
      await db.collection(`artifacts/${appId}/public/data/journal_entries`).add(payload);
      await docSnap.ref.delete();
      posted += 1;
      logger.info(`[${appId}] Posted draft ${docSnap.id} as ${voucherNo}`);
    } catch (err) {
      failed += 1;
      logger.error(`[${appId}] Failed to post draft ${docSnap.id}`, err);
    }
  }
  return { posted, failed, skipped };
}

// ── Recurring templates → drafts ───────────────────────────────────────────
function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dateToIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addPeriods(date, frequency, n) {
  const d = new Date(date);
  if (frequency === 'daily') d.setDate(d.getDate() + n);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7 * n);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + n);
  else if (frequency === 'quarterly') d.setMonth(d.getMonth() + 3 * n);
  else if (frequency === 'yearly') d.setFullYear(d.getFullYear() + n);
  return d;
}
function rulesDueRuns(rule, asOfIso) {
  if (!rule || rule.active === false) return [];
  const asOf = isoToDate(asOfIso);
  const interval = Math.max(1, Number(rule.interval) || 1);
  let cursor = rule.lastRunDate
    ? addPeriods(isoToDate(rule.lastRunDate), rule.frequency, interval)
    : isoToDate(rule.startDate);
  const end = rule.endDate ? isoToDate(rule.endDate) : null;
  const out = [];
  let safety = 0;
  while (cursor && cursor <= asOf) {
    if (end && cursor > end) break;
    out.push(dateToIso(cursor));
    cursor = addPeriods(cursor, rule.frequency, interval);
    if (++safety > 1000) break;
  }
  return out;
}

// PERF-01 fix: batch-fetch all needed templates in one Admin SDK getAll() call
// before iterating rules, eliminating the O(R) per-rule template reads.
async function processRecurringTemplates(appId, today) {
  const rulesCol = db.collection(`artifacts/${appId}/public/data/recurring_rules`);
  const tplOnly = await rulesCol.where('template_id', '>', '').get();
  if (tplOnly.empty) return { drafted: 0 };

  // Collect unique template IDs and batch-fetch them in a single RPC.
  const templateIds = [...new Set(
    tplOnly.docs.map(d => d.data().template_id).filter(Boolean)
  )];
  const templateRefs = templateIds.map(id =>
    db.doc(`artifacts/${appId}/public/data/journal_templates/${id}`)
  );
  const templateSnaps = await db.getAll(...templateRefs);
  const templateMap = Object.fromEntries(
    templateSnaps.filter(s => s.exists).map(s => [s.id, s.data()])
  );

  let drafted = 0;
  for (const ruleSnap of tplOnly.docs) {
    const rule = { id: ruleSnap.id, ...ruleSnap.data() };
    if (rule.active === false) continue;
    const tpl = templateMap[rule.template_id];
    if (!tpl) continue;

    const runs = rulesDueRuns(rule, today);
    if (!runs.length) continue;

    const succeededRuns = [];
    for (const runIso of runs) {
      try {
        const dup = await db
          .collection(`artifacts/${appId}/public/data/journal_drafts`)
          .where('recurring_rule_id', '==', rule.id)
          .where('recurring_run_date', '==', runIso)
          .limit(1)
          .get();
        if (!dup.empty) { succeededRuns.push(runIso); continue; }
        await db.collection(`artifacts/${appId}/public/data/journal_drafts`).add({
          date: runIso,
          narration: tpl.narration || tpl.name || 'Recurring entry',
          party_name: tpl.party_name || null,
          entries: tpl.entries || [],
          source: 'recurring_template',
          status: 'parked',
          origin: 'recurring',
          recurring_rule_id: rule.id,
          recurring_run_date: runIso,
          template_id: rule.template_id,
          category: tpl.category || null,
          currency: 'INR',
          fx_rate_to_inr: 1,
          created_by: 'cloud_scheduler',
          created_at: new Date().toISOString(),
        });
        drafted += 1;
        succeededRuns.push(runIso);
      } catch (err) {
        logger.error(`[${appId}] Failed recurring draft for rule ${rule.id} @ ${runIso}`, err);
        break;
      }
    }
    if (succeededRuns.length) {
      await ruleSnap.ref.update({
        lastRunDate: succeededRuns[succeededRuns.length - 1],
        updated_at: new Date().toISOString(),
      });
    }
  }
  return { drafted };
}

// ── Password verification (Node.js crypto — mirrors Web Crypto in helpers.js) ─
// Format: 'v2:saltHex:hashHex' (PBKDF2-SHA-256, 200 000 iterations)
//         64-hex chars → legacy SHA-256
//         anything else → very-old plaintext
// v3:iterations:saltHex:hashHex — iteration count is explicit so it can change safely.
// v2:saltHex:hashHex             — legacy 200 000 iterations (no count in format).
// 64-hex                         — legacy SHA-256 (very old).
// anything else                  — legacy plaintext.
const PBKDF2_ITERS = 100000; // 100k is NIST-acceptable and ~2× faster than 200k on CF

async function verifyPasswordNode(plaintext, storedHash) {
  if (!plaintext || !storedHash) return false;
  const plaintextBuf = Buffer.from(plaintext, 'utf8');

  if (storedHash.startsWith('v3:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 4) return false;
    const iters = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    const derived = await pbkdf2Async(plaintextBuf, salt, iters, 32, 'sha256');
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }

  if (storedHash.startsWith('v2:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const derived = await pbkdf2Async(plaintextBuf, salt, 200000, 32, 'sha256');
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }

  if (storedHash.length === 64 && /^[0-9a-f]+$/.test(storedHash)) {
    const hash = createHash('sha256').update(plaintextBuf).digest('hex');
    return hash === storedHash;
  }

  // Legacy plaintext — accepted but upgraded on next successful login
  return plaintext === storedHash;
}

async function hashPasswordNode(plaintext) {
  const salt = randomBytes(16);
  const derived = await pbkdf2Async(Buffer.from(plaintext, 'utf8'), salt, PBKDF2_ITERS, 32, 'sha256');
  return `v3:${PBKDF2_ITERS}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

// ── verifyLogin callable ────────────────────────────────────────────────────
// Replaces the client-side anonymous Firestore reads of employees/settings.
// On success returns a Firebase custom token the client signs in with.
exports.verifyLogin = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30, minInstances: 1, serviceAccount: 'firebase-adminsdk-fbsvc@terms-a005e.iam.gserviceaccount.com' },
  async (req) => {
    const { username, password, appId } = req.data || {};
    if (!username || !password || !appId) {
      throw new HttpsError('invalid-argument', 'Missing credentials');
    }

    const usernameNorm = String(username).trim();

    // ── Admin login ──────────────────────────────────────────────────────
    if (usernameNorm.toLowerCase() === 'admin') {
      const secRef = db.doc(`artifacts/${appId}/public/data/settings/security`);
      const secSnap = await secRef.get();

      if (!secSnap.exists || !secSnap.data().admin_password) {
        throw new HttpsError('permission-denied', 'Invalid credentials');
      }

      const secData = secSnap.data();

      // Rate-limit recovery attempts (admin login reuses the same counter)
      const lockedUntil = secData.login_locked_until ? new Date(secData.login_locked_until) : null;
      if (lockedUntil && lockedUntil > new Date()) {
        throw new HttpsError('resource-exhausted', 'Too many failed attempts. Try again later.');
      }

      // Run PBKDF2 and admin employee lookup in parallel to save one Firestore RTT.
      const [valid, empSnap] = await Promise.all([
        verifyPasswordNode(password, secData.admin_password),
        db.collection(`artifacts/${appId}/public/data/employees`)
          .where('role', '==', 'admin').limit(1).get(),
      ]);

      if (!valid) {
        const attempts = (secData.failed_login_attempts || 0) + 1;
        const updates = { failed_login_attempts: attempts };
        if (attempts >= 5) {
          updates.login_locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        }
        await secRef.update(updates);
        throw new HttpsError('permission-denied', 'Invalid credentials');
      }

      // Success: reset counters, upgrade legacy hash (v2 → v3 at lower iteration count)
      const resetUpdates = { failed_login_attempts: 0, login_locked_until: null };
      if (!secData.admin_password.startsWith('v3:')) {
        resetUpdates.admin_password = await hashPasswordNode(password);
        resetUpdates.password_hashed = true;
      }
      await secRef.update(resetUpdates);

      const adminEmp = empSnap.empty ? null : { id: empSnap.docs[0].id, ...empSnap.docs[0].data() };
      const uid = adminEmp?.id || `admin_${appId}`;

      const customToken = await admin.auth().createCustomToken(uid, { role: 'admin', appId });
      return {
        token: customToken,
        role: 'admin',
        empId: adminEmp?.id || null,
        name: adminEmp?.name || 'Administrator',
        email: adminEmp?.email || null,
      };
    }

    // ── Employee login ───────────────────────────────────────────────────
    // Search by email AND username field in parallel; prefer email match.
    const [byEmail, byUsername] = await Promise.all([
      db.collection(`artifacts/${appId}/public/data/employees`)
        .where('email', '==', usernameNorm)
        .limit(1)
        .get(),
      db.collection(`artifacts/${appId}/public/data/employees`)
        .where('username', '==', usernameNorm)
        .limit(1)
        .get(),
    ]);

    const empDoc = !byEmail.empty ? byEmail.docs[0]
      : !byUsername.empty ? byUsername.docs[0]
      : null;

    if (!empDoc) {
      throw new HttpsError('permission-denied', 'Invalid credentials');
    }

    const emp = { id: empDoc.id, ...empDoc.data() };

    if (emp.is_locked) {
      throw new HttpsError('permission-denied', 'Account is locked. Contact Admin.');
    }
    if (emp.status === 'Disabled' || emp.status === 'Deactivated') {
      throw new HttpsError('permission-denied', 'Account is disabled. Contact Admin.');
    }
    if (!emp.password) {
      throw new HttpsError('permission-denied', 'No password configured. Contact Admin.');
    }

    const valid = await verifyPasswordNode(password, emp.password);
    if (!valid) {
      const attempts = (emp.failed_login_attempts || 0) + 1;
      const updates = { failed_login_attempts: attempts };
      if (attempts >= 5) updates.is_locked = true;
      await empDoc.ref.update(updates);
      if (attempts >= 5) {
        throw new HttpsError('permission-denied', 'Account locked due to too many failed attempts. Contact Admin.');
      }
      throw new HttpsError('permission-denied', 'Invalid credentials');
    }

    // Success: reset counters, upgrade legacy hash (v2/plaintext → v3)
    const updates = {};
    if (emp.failed_login_attempts > 0) updates.failed_login_attempts = 0;
    if (!emp.password.startsWith('v3:')) {
      updates.password = await hashPasswordNode(password);
      updates.password_hashed = true;
    }
    if (Object.keys(updates).length > 0) await empDoc.ref.update(updates);

    const authEmail = emp.email || `${emp.id}@rental-ops.internal`;
    const customToken = await admin.auth().createCustomToken(emp.id, { role: emp.role, appId });

    return {
      token: customToken,
      role: emp.role,
      empId: emp.id,
      name: emp.name || '',
      email: authEmail,
    };
  }
);

// ── resetAdminPassword callable ────────────────────────────────────────────
// Verifies the recovery key server-side (constant-time, rate-limited) and
// resets the admin password.  Also handles first-time bootstrap setup.
exports.resetAdminPassword = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30, serviceAccount: 'firebase-adminsdk-fbsvc@terms-a005e.iam.gserviceaccount.com' },
  async (req) => {
    const { appId, recoveryKey, newPassword } = req.data || {};
    if (!appId || !recoveryKey || !newPassword) {
      throw new HttpsError('invalid-argument', 'appId, recoveryKey and newPassword are required');
    }
    if (newPassword.length < 8) {
      throw new HttpsError('invalid-argument', 'New password must be at least 8 characters');
    }

    const secRef = db.doc(`artifacts/${appId}/public/data/settings/security`);
    const secSnap = await secRef.get();

    // Bootstrap: no security doc exists yet — create it.
    if (!secSnap.exists) {
      const hashedPass = await hashPasswordNode(newPassword);
      const hashedKey = await hashPasswordNode(recoveryKey);
      await secRef.set({
        admin_password: hashedPass,
        password_hashed: true,
        recovery_key_hash: hashedKey,
        failed_login_attempts: 0,
      });
      return { ok: true, mode: 'bootstrap' };
    }

    const secData = secSnap.data();

    // Rate-limit recovery attempts.
    const lockedUntil = secData.recovery_locked_until ? new Date(secData.recovery_locked_until) : null;
    if (lockedUntil && lockedUntil > new Date()) {
      throw new HttpsError('resource-exhausted', 'Too many failed recovery attempts. Try again later.');
    }

    // Verify recovery key — support both hashed (new) and plaintext (legacy).
    let keyValid = false;
    if (secData.recovery_key_hash) {
      keyValid = await verifyPasswordNode(recoveryKey, secData.recovery_key_hash);
    } else if (secData.recovery_key) {
      // Legacy plaintext — constant-time compare via HMAC
      const hmacKey = randomBytes(32);
      const { createHmac } = require('crypto');
      const h1 = createHmac('sha256', hmacKey).update(recoveryKey).digest();
      const h2 = createHmac('sha256', hmacKey).update(secData.recovery_key).digest();
      keyValid = h1.length === h2.length && timingSafeEqual(h1, h2);
    }

    if (!keyValid) {
      const attempts = (secData.recovery_attempt_count || 0) + 1;
      const updates = { recovery_attempt_count: attempts };
      if (attempts >= 5) {
        updates.recovery_locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await secRef.update(updates);
      throw new HttpsError('permission-denied', 'Invalid recovery key');
    }

    // Key valid — reset password and upgrade legacy plaintext key to hash.
    const hashedPass = await hashPasswordNode(newPassword);
    const updates = {
      admin_password: hashedPass,
      password_hashed: true,
      recovery_attempt_count: 0,
      recovery_locked_until: null,
    };
    if (!secData.recovery_key_hash && secData.recovery_key) {
      updates.recovery_key_hash = await hashPasswordNode(secData.recovery_key);
      updates.recovery_key = admin.firestore.FieldValue.delete();
    }
    await secRef.update(updates);
    return { ok: true, mode: 'reset' };
  }
);

// ── Scheduled cron ─────────────────────────────────────────────────────────
exports.postScheduledDrafts = onSchedule(
  {
    schedule: 'every day 01:00',
    timeZone: 'Asia/Kolkata',
    memory: '256MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const today = todayISO();
    const appIds = await listAppIds();
    logger.info(`Scheduled poster scanning ${appIds.length} app(s) for date <= ${today}`);
    let totalPosted = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalDrafted = 0;
    for (const appId of appIds) {
      try {
        const r = await processAppDrafts(appId, today);
        totalPosted += r.posted;
        totalFailed += r.failed;
        totalSkipped += r.skipped;
        const r2 = await processRecurringTemplates(appId, today);
        totalDrafted += r2.drafted;
      } catch (err) {
        logger.error(`Failed processing app ${appId}`, err);
      }
    }
    logger.info(
      `Done. posted=${totalPosted} failed=${totalFailed} skipped=${totalSkipped} drafted=${totalDrafted}`
    );
  }
);

// ── Manual callables (admin-only) ──────────────────────────────────────────
// Reject if the caller's token was minted for a different workspace than the one
// being acted on (defense-in-depth against cross-tenant use of a role claim).
function assertAppMatch(auth, appId) {
  const tokenApp = auth && auth.token && auth.token.appId;
  if (tokenApp && appId && tokenApp !== appId) {
    throw new HttpsError('permission-denied', 'Token was issued for a different workspace.');
  }
}

async function assertAdmin(auth, appId) {
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in');
  assertAppMatch(auth, appId);
  const claimRole = auth.token && auth.token.role;
  if (claimRole === 'admin') return;
  if (!appId) throw new HttpsError('invalid-argument', 'appId required');
  const [rolesSnap, empSnap] = await Promise.all([
    db.doc(`artifacts/${appId}/public/data/userRoles/${auth.uid}`).get().catch(() => null),
    db.doc(`artifacts/${appId}/public/data/employees/${auth.uid}`).get().catch(() => null),
  ]);
  const fromRoles = rolesSnap && rolesSnap.exists && rolesSnap.data().role;
  const fromEmp = empSnap && empSnap.exists && empSnap.data().role;
  if (fromRoles !== 'admin' && fromEmp !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin only');
  }
}

async function filterAdminApps(auth, appIds) {
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in');
  const allowed = [];
  for (const id of appIds) {
    try { await assertAdmin(auth, id); allowed.push(id); } catch { /* skip */ }
  }
  return allowed;
}

exports.runScheduledDraftsNow = onCall(
  { memory: '256MiB', timeoutSeconds: 540 },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Must be signed in');
    const targetIds = Array.isArray(req.data && req.data.appIds) ? req.data.appIds.filter(Boolean) : null;
    const candidates = targetIds && targetIds.length ? targetIds : await listAppIds();
    const appIds = await filterAdminApps(req.auth, candidates);
    if (!appIds.length) throw new HttpsError('permission-denied', 'Not an admin in any requested app');
    const today = (req.data && req.data.date) || todayISO();
    const results = [];
    for (const appId of appIds) {
      try {
        const r = await processAppDrafts(appId, today);
        results.push({ appId, ...r });
      } catch (err) {
        results.push({ appId, error: err.message });
      }
    }
    return { ok: true, today, results };
  }
);

exports.runRecurringTemplatesNow = onCall(
  { memory: '256MiB', timeoutSeconds: 540 },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Must be signed in');
    const targetIds = Array.isArray(req.data && req.data.appIds) ? req.data.appIds.filter(Boolean) : null;
    const candidates = targetIds && targetIds.length ? targetIds : await listAppIds();
    const appIds = await filterAdminApps(req.auth, candidates);
    if (!appIds.length) throw new HttpsError('permission-denied', 'Not an admin in any requested app');
    const today = (req.data && req.data.date) || todayISO();
    const results = [];
    for (const appId of appIds) {
      try {
        const r = await processRecurringTemplates(appId, today);
        results.push({ appId, ...r });
      } catch (err) {
        results.push({ appId, error: err.message });
      }
    }
    return { ok: true, today, results };
  }
);

// ── Messaging: send a generated document (PDF) by email ─────────────────────
// Provider-agnostic — SMTP (nodemailer) or transactional API (SendGrid/Resend),
// chosen in settings/communication. Inert until the admin configures it.
async function assertAppUser(auth, appId) {
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in');
  assertAppMatch(auth, appId);
  const prov = auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider;
  if (prov === 'anonymous') throw new HttpsError('permission-denied', 'Anonymous sessions cannot send mail');
  if (auth.token && auth.token.role) return;
  if (!appId) throw new HttpsError('invalid-argument', 'appId required');
  const [rolesSnap, empSnap] = await Promise.all([
    db.doc(`artifacts/${appId}/public/data/userRoles/${auth.uid}`).get().catch(() => null),
    db.doc(`artifacts/${appId}/public/data/employees/${auth.uid}`).get().catch(() => null),
  ]);
  const ok = (rolesSnap && rolesSnap.exists && rolesSnap.data().role) || (empSnap && empSnap.exists && empSnap.data().role);
  if (!ok) throw new HttpsError('permission-denied', 'No role in this workspace');
}

// Resolve the caller's role (custom-token claim first, then Firestore) and throw
// unless it is in `allowed`. For action/mutation callables (payment links, IRN,
// outbound email) that must be limited to finance/management roles — never a
// Field Tech or Coordinator.
async function assertRole(auth, appId, allowed) {
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in');
  assertAppMatch(auth, appId);
  let role = auth.token && auth.token.role;
  if (!role) {
    if (!appId) throw new HttpsError('invalid-argument', 'appId required');
    const [rolesSnap, empSnap] = await Promise.all([
      db.doc(`artifacts/${appId}/public/data/userRoles/${auth.uid}`).get().catch(() => null),
      db.doc(`artifacts/${appId}/public/data/employees/${auth.uid}`).get().catch(() => null),
    ]);
    role = (rolesSnap && rolesSnap.exists && rolesSnap.data().role) || (empSnap && empSnap.exists && empSnap.data().role) || null;
  }
  if (!allowed.includes(role)) throw new HttpsError('permission-denied', 'You do not have permission for this action.');
  return role;
}

async function readCommunicationConfig(appId) {
  const snap = await db.doc(`artifacts/${appId}/public/data/settings/communication`).get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Email is not configured. Add it in Admin Tools → Communication.');
  return snap.data() || {};
}

async function deliverEmail(cfg, { to, cc, subject, html, text, attachment }) {
  const provider = (cfg.provider || 'smtp').toLowerCase();
  const fromEmail = cfg.from_email || cfg.smtp_user;
  if (!fromEmail) throw new HttpsError('failed-precondition', 'Sender email (from_email) not set.');
  const from = cfg.from_name ? `${cfg.from_name} <${fromEmail}>` : fromEmail;
  const att = attachment && attachment.contentBase64
    ? { filename: attachment.filename || 'document.pdf', b64: attachment.contentBase64, type: attachment.contentType || 'application/pdf' }
    : null;

  if (provider === 'smtp') {
    if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass) throw new HttpsError('failed-precondition', 'SMTP host/user/pass not set.');
    const transport = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: Number(cfg.smtp_port) || 587,
      secure: cfg.smtp_secure === true || Number(cfg.smtp_port) === 465,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    });
    await transport.sendMail({
      from, to, cc: cc || undefined, subject, html, text,
      attachments: att ? [{ filename: att.filename, content: Buffer.from(att.b64, 'base64'), contentType: att.type }] : [],
    });
    return;
  }
  if (provider === 'sendgrid') {
    if (!cfg.api_key) throw new HttpsError('failed-precondition', 'SendGrid API key not set.');
    const body = {
      personalizations: [{ to: [{ email: to }], ...(cc ? { cc: [{ email: cc }] } : {}) }],
      from: { email: fromEmail, name: cfg.from_name || undefined },
      subject,
      content: [{ type: 'text/html', value: html || text || '' }],
      ...(att ? { attachments: [{ content: att.b64, filename: att.filename, type: att.type, disposition: 'attachment' }] } : {}),
    };
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new HttpsError('internal', `SendGrid error ${r.status}: ${await r.text()}`);
    return;
  }
  if (provider === 'resend') {
    if (!cfg.api_key) throw new HttpsError('failed-precondition', 'Resend API key not set.');
    const body = { from, to, ...(cc ? { cc } : {}), subject, html: html || undefined, text: text || undefined, ...(att ? { attachments: [{ filename: att.filename, content: att.b64 }] } : {}) };
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new HttpsError('internal', `Resend error ${r.status}: ${await r.text()}`);
    return;
  }
  throw new HttpsError('failed-precondition', `Unknown email provider: ${provider}`);
}

exports.sendDocumentEmail = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 },
  async (req) => {
    const { appId, to, cc, subject, html, text, attachment } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant', 'manager']); // no tech/coordinator outbound mail
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) throw new HttpsError('invalid-argument', 'Valid recipient email required');
    if (!subject) throw new HttpsError('invalid-argument', 'Subject required');
    if (attachment && attachment.contentBase64 && attachment.contentBase64.length > 9000000) throw new HttpsError('invalid-argument', 'Attachment too large (max ~7MB)');
    const cfg = await readCommunicationConfig(appId);
    await deliverEmail(cfg, { to, cc, subject, html, text, attachment });
    return { ok: true };
  }
);

// ── Overdue-invoice payment reminders ───────────────────────────────────────
// Consolidated per-client reminder using persisted tax_invoice amounts and
// payments (billed − received). Deduped to at most once per client per 7 days.
async function processDueReminders(appId, today) {
  let cfg;
  try { cfg = await readCommunicationConfig(appId); } catch { return { skipped: 'no-config' }; }
  if (!cfg.reminders_enabled) return { skipped: 'disabled' };
  const overdueDays = Number(cfg.reminder_overdue_days) || 7;
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - overdueDays);

  const [invSnap, paySnap, cliSnap, orgSnap] = await Promise.all([
    db.collection(`artifacts/${appId}/public/data/tax_invoices`).get(),
    db.collection(`artifacts/${appId}/public/data/payments`).get(),
    db.collection(`artifacts/${appId}/public/data/clients`).get(),
    db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null),
  ]);
  const org = (orgSnap && orgSnap.exists) ? orgSnap.data() : {};
  const invoices = invSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => (i.status || 'active') !== 'cancelled');
  const clients = {}; cliSnap.forEach((d) => { clients[d.id] = d.data(); });

  const byClient = {};
  invoices.forEach((i) => {
    const cid = i.client_id; if (!cid) return;
    if (!byClient[cid]) byClient[cid] = { billed: 0, overdue: [] };
    byClient[cid].billed += Number(i.final_amount || 0);
    const idt = i.invoice_date ? new Date(i.invoice_date) : null;
    if (idt && idt < cutoff) byClient[cid].overdue.push(i);
  });
  const recv = {};
  paySnap.forEach((d) => { const p = d.data(); if (p.client_id) recv[p.client_id] = (recv[p.client_id] || 0) + Number(p.amount || 0); });

  const fmt = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let sent = 0, skipped = 0;
  for (const [cid, agg] of Object.entries(byClient)) {
    const outstanding = agg.billed - (recv[cid] || 0);
    if (outstanding <= 1 || agg.overdue.length === 0) { skipped += 1; continue; }
    const client = clients[cid] || {};
    const to = client.email || (client.contacts && client.contacts[0] && client.contacts[0].email);
    if (!to) { skipped += 1; continue; }
    const logRef = db.doc(`artifacts/${appId}/public/data/reminder_log/${cid}`);
    const logSnap = await logRef.get();
    if (logSnap.exists && logSnap.data().last_sent) {
      const last = new Date(logSnap.data().last_sent);
      if ((today - last) / 86400000 < 7) { skipped += 1; continue; }
    }
    const list = agg.overdue.map((i) => `<li>${i.invoice_no || ''} dated ${i.invoice_date || ''} — ${fmt(i.final_amount)}</li>`).join('');
    const html = `<p>Dear ${client.name || 'Customer'},</p><p>This is a gentle reminder that the following invoice(s) are overdue, with a total outstanding balance of <b>${fmt(outstanding)}</b>:</p><ul>${list}</ul><p>We would appreciate it if you could arrange payment at your earliest convenience.</p><p>Regards,<br>${org.name || ''}</p>`;
    try {
      await deliverEmail(cfg, { to, subject: `Payment reminder — ${fmt(outstanding)} outstanding`, html, text: `Dear ${client.name || 'Customer'}, your outstanding balance is ${fmt(outstanding)}. Please arrange payment.` });
      await logRef.set({ last_sent: today.toISOString(), outstanding, count: (logSnap.exists ? (logSnap.data().count || 0) : 0) + 1 }, { merge: true });
      sent += 1;
    } catch (e) { logger.warn(`[${appId}] reminder failed for ${cid}: ${e.message}`); skipped += 1; }
  }
  return { sent, skipped };
}

exports.sendDueReminders = onSchedule(
  { schedule: 'every day 09:30', timeZone: 'Asia/Kolkata', memory: '256MiB', timeoutSeconds: 540 },
  async () => {
    const today = new Date();
    const appIds = await listAppIds();
    for (const appId of appIds) {
      try { const r = await processDueReminders(appId, today); logger.info(`[${appId}] reminders`, r); }
      catch (e) { logger.error(`[${appId}] sendDueReminders error`, e); }
    }
    return null;
  }
);

exports.runDueRemindersNow = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 540 },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Must be signed in');
    const candidates = Array.isArray(req.data && req.data.appIds) && req.data.appIds.length ? req.data.appIds : await listAppIds();
    const appIds = await filterAdminApps(req.auth, candidates);
    if (!appIds.length) throw new HttpsError('permission-denied', 'Not an admin in any requested app');
    const today = new Date();
    const results = [];
    for (const appId of appIds) {
      try { results.push({ appId, ...(await processDueReminders(appId, today)) }); }
      catch (e) { results.push({ appId, error: e.message }); }
    }
    return { ok: true, results };
  }
);

// ── Self-service portal data (magic-link, no login) ─────────────────────────
// Validates a client/vendor portal_token server-side and returns ONLY that
// party's scoped data via the Admin SDK, so the public portal page needs no
// Firestore access or auth.
exports.getPortalData = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, token } = req.data || {};
    if (!appId || !token) throw new HttpsError('invalid-argument', 'appId and token required');
    const q = await db.collection(`artifacts/${appId}/public/data/clients`).where('portal_token', '==', token).limit(1).get();
    if (q.empty) throw new HttpsError('not-found', 'Invalid or expired link');
    const cDoc = q.docs[0];
    const client = cDoc.data();
    const cid = cDoc.id;
    if (client.portal_token_expiry && new Date(client.portal_token_expiry) < new Date()) {
      throw new HttpsError('permission-denied', 'This link has expired. Please request a new one.');
    }
    const [projSnap, invSnap, paySnap, orgSnap, vpaySnap] = await Promise.all([
      db.collection(`artifacts/${appId}/public/data/projects`).where('client_id', '==', cid).get(),
      db.collection(`artifacts/${appId}/public/data/tax_invoices`).where('client_id', '==', cid).get(),
      db.collection(`artifacts/${appId}/public/data/payments`).where('client_id', '==', cid).get(),
      db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null),
      db.collection(`artifacts/${appId}/public/data/vendor_payments`).where('vendor_id', '==', cid).get().catch(() => ({ docs: [] })),
    ]);
    const org = (orgSnap && orgSnap.exists) ? orgSnap.data() : {};
    const projects = projSnap.docs
      .map((d) => { const p = d.data(); return { id: d.id, name: p.project_name || '', status: p.status || '', start_date: p.start_date || '', end_date: p.end_date || '', venue: p.venue || '', invoice_status: p.invoice_status || '', quote_status: p.quote_status || '' }; })
      .sort((a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0));
    const invoices = invSnap.docs.map((d) => d.data()).filter((i) => (i.status || 'active') !== 'cancelled')
      .map((i) => ({ invoice_no: i.invoice_no || '', date: i.invoice_date || '', amount: Number(i.final_amount || 0) }))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const payments = paySnap.docs.map((d) => d.data())
      .map((p) => ({ date: p.date || p.payment_date || '', amount: Number(p.amount || 0), mode: p.mode || p.method || p.payment_mode || '', ref: p.reference || p.ref || '' }))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const billed = invoices.reduce((s, i) => s + i.amount, 0);
    const received = payments.reduce((s, p) => s + p.amount, 0);

    const isVendor = client.type === 'Vendor' || client.type === 'Both';
    let vendor = null;
    if (isVendor) {
      const jobs = []; let vBilled = 0;
      projSnap.docs.forEach((d) => {
        const p = d.data();
        (p.vendor_allocations || []).filter((a) => a.vendor_id === cid).forEach((a) => {
          const amt = Number(a.tax_amount || a.amount || 0);
          jobs.push({ project: p.project_name || '', item: a.item_name || '', amount: amt });
          vBilled += amt;
        });
      });
      const vPaid = (vpaySnap.docs || []).reduce((s, d) => s + Number(d.data().amount || 0), 0);
      vendor = { jobs, billed: vBilled, paid: vPaid, balance: vBilled - vPaid };
    }

    return {
      party: { name: client.name || '', gstin: client.gstin || '', type: client.type || 'Client', address: client.address || '' },
      org: { name: org.name || '', address: org.address || '', gstin: org.gstin || '', phone: org.phone || '', email: org.email || '', logo: org.logo || '' },
      isVendor,
      summary: { billed, received, outstanding: billed - received, projectCount: projects.length },
      projects, invoices, payments, vendor,
    };
  }
);

// ── Public token pages: server-side, token-validated data access ───────────
// These mirror getPortalData: the public pages (client ledger, employee
// statement, reimbursable list, quote approval) hold NO Firestore access. Each
// function validates a per-record token (+ enabled/expiry) via the Admin SDK and
// returns ONLY that record's scoped data, so a logged-in staff member can no
// longer abuse the browser SDK to read these collections, and logged-out clients
// can use the links. Token/secret fields are stripped from parent docs.
function stripSecrets(obj) {
  const {
    ledger_link_token, statement_link_token, reimbursable_token, quote_approval_token,
    portal_token, password, password_hash, passwordHash, pin, ...safe
  } = obj || {};
  return safe;
}

// Remove internal cost/margin fields from a project before returning it to an
// external party (client ledger). Keeps client-facing revenue fields —
// logistics_costs and reimbursable_expenses ARE billed to the client (they feed
// getProjectGrandTotal / client payable), so they are intentionally retained;
// only vendor/PO costs, margin and internal expenses are removed.
function stripProjectInternalCosts(p) {
  const {
    vendor_allocations, purchase_orders, vendor_pos, margin, expenses, ...safe
  } = p || {};
  return safe;
}

// Client / vendor ledger — keyed on ledger_link_token.
exports.getLedgerData = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, token } = req.data || {};
    if (!appId || !token) throw new HttpsError('invalid-argument', 'appId and token required');
    const q = await db.collection(`artifacts/${appId}/public/data/clients`).where('ledger_link_token', '==', token).limit(1).get();
    if (q.empty) throw new HttpsError('not-found', 'Invalid or expired ledger link.');
    const cDoc = q.docs[0]; const client = cDoc.data(); const cid = cDoc.id;
    if (client.ledger_link_enabled === false) throw new HttpsError('permission-denied', 'This ledger link has been disabled.');
    if (client.ledger_link_expires_at && new Date(client.ledger_link_expires_at) < new Date()) throw new HttpsError('permission-denied', 'This ledger link has expired.');
    const col = (name) => db.collection(`artifacts/${appId}/public/data/${name}`);
    const [projSnap, paySnap, vpaySnap, orgSnap, piSnap, tiSnap] = await Promise.all([
      col('projects').where('client_id', '==', cid).get(),
      col('payments').where('client_id', '==', cid).get(),
      col('vendor_payments').where('vendor_id', '==', cid).get(),
      db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null),
      col('purchase_invoices').where('vendor_id', '==', cid).get(),
      col('tax_invoices').where('client_id', '==', cid).get(),
    ]);
    const mapDocs = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
    return {
      client: { id: cid, ...stripSecrets(client) },
      // Projects: strip internal vendor/PO cost + margin (client sees only their
      // revenue-side figures — grand total, invoices, payments).
      projects: projSnap.docs.map((d) => ({ id: d.id, ...stripProjectInternalCosts(d.data()) })),
      payments: mapDocs(paySnap),
      vendorPayments: mapDocs(vpaySnap),
      purchaseInvoices: mapDocs(piSnap),
      taxInvoices: mapDocs(tiSnap),
      org: (orgSnap && orgSnap.exists) ? orgSnap.data() : null,
    };
  }
);

// Employee statement — keyed on statement_link_token.
exports.getEmployeeStatement = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, token } = req.data || {};
    if (!appId || !token) throw new HttpsError('invalid-argument', 'appId and token required');
    const q = await db.collection(`artifacts/${appId}/public/data/employees`).where('statement_link_token', '==', token).limit(1).get();
    if (q.empty) throw new HttpsError('not-found', 'Invalid or expired statement link.');
    const eDoc = q.docs[0]; const emp = eDoc.data(); const eid = eDoc.id;
    if (emp.statement_link_enabled === false) throw new HttpsError('permission-denied', 'This statement link has been disabled.');
    if (emp.statement_link_expires_at && new Date(emp.statement_link_expires_at) < new Date()) throw new HttpsError('permission-denied', 'This statement link has expired.');
    const col = (name) => db.collection(`artifacts/${appId}/public/data/${name}`);
    const [payoutsSnap, advancesSnap, orgSnap] = await Promise.all([
      col('payouts').where('employee_id', '==', eid).get(),
      col('advances').where('employee_id', '==', eid).get(),
      db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null),
    ]);
    const mapDocs = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
    return {
      employee: { id: eid, ...stripSecrets(emp) },
      payouts: mapDocs(payoutsSnap),
      advances: mapDocs(advancesSnap),
      org: (orgSnap && orgSnap.exists) ? orgSnap.data() : null,
    };
  }
);

// Client reimbursable-expense list — keyed on reimbursable_token. Returns a
// CURATED project (only the reimbursable list + display fields; internal
// costs/margins/vendor allocations are never sent).
exports.getReimbursableData = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, token } = req.data || {};
    if (!appId || !token) throw new HttpsError('invalid-argument', 'appId and token required');
    const q = await db.collection(`artifacts/${appId}/public/data/projects`).where('reimbursable_token', '==', token).limit(1).get();
    if (q.empty) throw new HttpsError('not-found', 'Invalid or expired link.');
    const pDoc = q.docs[0]; const p = pDoc.data();
    if (p.reimbursable_token_enabled === false) throw new HttpsError('permission-denied', 'This link has been disabled.');
    if (p.reimbursable_token_expires_at && new Date(p.reimbursable_token_expires_at) < new Date()) throw new HttpsError('permission-denied', 'This link has expired. Please request a new link.');
    let client = null;
    if (p.client_id) {
      const cSnap = await db.doc(`artifacts/${appId}/public/data/clients/${p.client_id}`).get().catch(() => null);
      if (cSnap && cSnap.exists) { const c = cSnap.data(); client = { id: cSnap.id, name: c.name || '', gstin: c.gstin || '', address: c.address || '' }; }
    }
    const orgSnap = await db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null);
    return {
      project: {
        id: pDoc.id,
        project_name: p.project_name || '',
        start_date: p.start_date || '',
        end_date: p.end_date || '',
        venue: p.venue || '',
        client_id: p.client_id || '',
        reimbursable_expenses: p.reimbursable_expenses || [],
      },
      client,
      org: (orgSnap && orgSnap.exists) ? orgSnap.data() : null,
    };
  }
);

// Quote approval — read (display the quotation) + write (approve/reject).
exports.getQuoteApprovalData = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, token } = req.data || {};
    if (!appId || !token) throw new HttpsError('invalid-argument', 'appId and token required');
    const q = await db.collection(`artifacts/${appId}/public/data/projects`).where('quote_approval_token', '==', token).limit(1).get();
    if (q.empty) throw new HttpsError('not-found', 'Invalid or expired quote approval link.');
    const pDoc = q.docs[0]; const p = pDoc.data();
    if (p.quote_approval_enabled === false) throw new HttpsError('permission-denied', 'This quote approval link has been disabled.');
    if (p.quote_approval_expires_at && new Date(p.quote_approval_expires_at) < new Date()) throw new HttpsError('permission-denied', 'This quote approval link has expired.');
    // Drop internal cost fields + reimbursable estimates — the client approves the
    // QUOTE (their price), not our costs or internal reimbursable working notes.
    const { vendor_allocations, purchase_orders, vendor_pos, margin, expenses, reimbursable_expenses, ...quoteSafe } = p;
    const orgSnap = await db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null);
    return {
      project: { id: pDoc.id, ...stripSecrets(quoteSafe) },
      org: (orgSnap && orgSnap.exists) ? orgSnap.data() : null,
    };
  }
);

exports.submitQuoteApproval = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, token, decision } = req.data || {};
    if (!appId || !token || !['approved', 'rejected'].includes(decision)) throw new HttpsError('invalid-argument', 'appId, token and a valid decision are required');
    const q = await db.collection(`artifacts/${appId}/public/data/projects`).where('quote_approval_token', '==', token).limit(1).get();
    if (q.empty) throw new HttpsError('not-found', 'Invalid or expired quote approval link.');
    const pDoc = q.docs[0]; const p = pDoc.data();
    if (p.quote_approval_enabled === false) throw new HttpsError('permission-denied', 'This quote approval link has been disabled.');
    if (p.quote_approval_expires_at && new Date(p.quote_approval_expires_at) < new Date()) throw new HttpsError('permission-denied', 'This quote approval link has expired.');
    // Finality: once the client has responded, the link cannot flip the decision
    // (no re-confirm after reject, and no repeated status churn).
    if (p.quote_status === 'approved' || p.quote_status === 'rejected') {
      throw new HttpsError('failed-precondition', `This quote was already ${p.quote_status}. Please contact us if you need to change your response.`);
    }
    const now = new Date().toISOString();
    const update = decision === 'approved'
      ? { status: 'Confirmed', quote_status: 'approved', quote_approved_at: now }
      : { quote_status: 'rejected', quote_rejected_at: now };
    await pDoc.ref.update(update);
    return { ok: true, decision };
  }
);

// Contact directory: returns clients stripped of ALL financial fields (no
// opening_balance / referral_rate / tokens) for any recognised, non-anonymous
// role. Used to populate the clients state for roles denied raw client reads
// (Coordinators, Field Techs) so name resolution + the Contacts page still work.
exports.getContacts = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId } = req.data || {};
    if (!appId) throw new HttpsError('invalid-argument', 'appId required');
    await assertAppUser(req.auth, appId);
    const snap = await db.collection(`artifacts/${appId}/public/data/clients`).get();
    const callerEmpId = (req.auth && req.auth.uid) || '';
    const contacts = snap.docs.map((d) => {
      const c = d.data();
      const owner = c.owner_id || '';
      return {
        id: d.id,
        name: c.name || '',
        type: c.type || 'Client',
        gstin: c.gstin || '',
        address: c.address || '',
        state: c.state || '',
        contacts: (c.contacts || []).map((p) => ({ name: p.name || '', phone: p.phone || '', email: p.email || '' })),
        // owner_id identifies the referrer (needed so a Coordinator's own-referral
        // commission page can match its clients). referral_rate (the %) is returned
        // ONLY for the caller's own clients — never another owner's.
        owner_id: owner,
        ...(owner && owner === callerEmpId ? { referral_rate: c.referral_rate } : {}),
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { contacts };
  },
);

// ── Payments: Razorpay payment links + webhook auto-reconcile ───────────────
async function readPaymentConfig(appId) {
  const snap = await db.doc(`artifacts/${appId}/public/data/settings/payments`).get();
  return snap.exists ? (snap.data() || {}) : null;
}

exports.createPaymentLink = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, amount, description, customer, reference, callbackUrl } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant', 'manager']); // payment links = finance/management only
    if (!(Number(amount) > 0)) throw new HttpsError('invalid-argument', 'A positive amount is required');
    const cfg = await readPaymentConfig(appId);
    if (!cfg || cfg.provider !== 'razorpay' || !cfg.key_id || !cfg.key_secret) {
      throw new HttpsError('failed-precondition', 'Razorpay is not configured. Add keys in Admin Tools → Payments.');
    }
    const auth = Buffer.from(`${cfg.key_id}:${cfg.key_secret}`).toString('base64');
    const body = {
      amount: Math.round(Number(amount) * 100),
      currency: 'INR',
      accept_partial: false,
      description: description || 'Payment',
      ...(reference ? { reference_id: reference } : {}),
      ...(customer ? { customer: { name: customer.name || undefined, email: customer.email || undefined, contact: customer.phone || undefined } } : {}),
      notify: { sms: !!(customer && customer.phone), email: !!(customer && customer.email) },
      reminder_enable: true,
      ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
    };
    const r = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpsError('internal', `Razorpay error: ${(data && data.error && data.error.description) || r.status}`);
    return { ok: true, url: data.short_url, id: data.id };
  }
);

// Razorpay webhook → verify signature, then post a payment (idempotent).
// Configure in Razorpay dashboard: https://<region>-<project>.cloudfunctions.net/razorpayWebhook?appId=<APPID>
exports.razorpayWebhook = onRequest(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req, res) => {
    try {
      const appId = req.query.appId || (req.body && req.body.appId);
      if (!appId) { res.status(400).send('appId required'); return; }
      const cfg = await readPaymentConfig(appId);
      if (!cfg || !cfg.webhook_secret) { res.status(400).send('not configured'); return; }
      const sig = req.headers['x-razorpay-signature'];
      const expected = createHmac('sha256', cfg.webhook_secret).update(req.rawBody).digest('hex');
      if (!sig || sig !== expected) { res.status(401).send('bad signature'); return; }

      const event = req.body.event;
      if (event === 'payment_link.paid' || event === 'payment.captured') {
        const pl = req.body.payload && req.body.payload.payment_link && req.body.payload.payment_link.entity;
        const pay = req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
        const reference = (pl && pl.reference_id) || (pay && pay.notes && pay.notes.reference) || '';
        const amount = ((pl && pl.amount) || (pay && pay.amount) || 0) / 100;
        const payId = (pay && pay.id) || (pl && pl.id) || '';
        if (payId) {
          const dup = await db.collection(`artifacts/${appId}/public/data/payments`).where('razorpay_id', '==', payId).limit(1).get();
          if (!dup.empty) { res.status(200).send('ok (dup)'); return; }
        }
        let project_id = null, client_id = null;
        if (reference.startsWith('proj:')) {
          project_id = reference.slice(5);
          const pdoc = await db.doc(`artifacts/${appId}/public/data/projects/${project_id}`).get();
          if (pdoc.exists) client_id = pdoc.data().client_id || null;
        } else if (reference.startsWith('client:')) {
          client_id = reference.slice(7);
        }
        await db.collection(`artifacts/${appId}/public/data/payments`).add({
          amount, client_id, project_id, mode: 'Razorpay', method: 'Razorpay',
          reference: payId, razorpay_id: payId, date: new Date().toISOString().slice(0, 10),
          source: 'razorpay_webhook', recorded_at: new Date().toISOString(),
        });
        logger.info(`[${appId}] razorpay payment posted: ${payId} ${amount}`);
      }
      res.status(200).send('ok');
    } catch (e) {
      logger.error('razorpayWebhook error', e);
      res.status(500).send('error');
    }
  }
);

// ── GST e-invoice (IRN) — scaffold; live GSP call when configured ───────────
exports.generateIRN = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const { appId, invoiceId } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant']); // GST e-invoicing = finance only
    if (!invoiceId) throw new HttpsError('invalid-argument', 'invoiceId required');
    const cfg = await db.doc(`artifacts/${appId}/public/data/settings/einvoice`).get().then((s) => (s.exists ? s.data() : null));
    if (!cfg || !cfg.enabled) throw new HttpsError('failed-precondition', 'E-invoicing is not enabled. Configure it in Admin Tools → GST E-Invoice.');
    const invRef = db.doc(`artifacts/${appId}/public/data/tax_invoices/${invoiceId}`);
    const invSnap = await invRef.get();
    if (!invSnap.exists) throw new HttpsError('not-found', 'Invoice not found');
    const inv = invSnap.data();
    if (inv.irn) return { ok: true, irn: inv.irn, message: 'IRN already generated.' };

    // Minimal NIC-schema payload built from the invoice (best-effort scaffold).
    const dt = inv.invoice_date ? new Date(inv.invoice_date) : new Date();
    const payload = {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
      DocDtls: { Typ: 'INV', No: inv.invoice_no || '', Dt: dt.toLocaleDateString('en-GB') },
      SellerDtls: { Gstin: cfg.gstin || inv.org_gstin_at_issue || '' },
      BuyerDtls: { Gstin: inv.client_gstin || 'URP', LglNm: inv.client_name || '' },
      ValDtls: { TotInvVal: Number(inv.final_amount || 0) },
    };
    await invRef.set({ einvoice_payload: payload, einvoice_status: 'prepared' }, { merge: true });

    if (!cfg.gsp_base_url || !cfg.client_id || !cfg.client_secret) {
      return { ok: true, pending: true, message: 'E-invoice payload prepared. Add full GSP credentials to obtain the live IRN.' };
    }
    try {
      const r = await fetch(`${cfg.gsp_base_url.replace(/\/$/, '')}/ei/api/invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', client_id: cfg.client_id, client_secret: cfg.client_secret, gstin: cfg.gstin || '', user_name: cfg.username || '' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      const irn = data.Irn || data.irn || (data.data && data.data.Irn);
      const qr = data.SignedQRCode || data.signedQRCode || (data.data && data.data.SignedQRCode);
      if (!r.ok || !irn) throw new Error((data && (data.message || data.error)) || `GSP error ${r.status}`);
      await invRef.set({ irn, signed_qr: qr || '', einvoice_status: 'generated', irn_at: new Date().toISOString() }, { merge: true });
      return { ok: true, irn };
    } catch (e) {
      return { ok: false, message: 'GSP call failed (payload saved): ' + (e.message || 'error') };
    }
  }
);

// ── Chat push: notify recipients when a new chat message is created ──────────
// Fires on chat_channels/{cid}/messages/{mid}. Resolves recipients (channel
// members − sender; team/announcement → all active employees), gathers their
// FCM device tokens from chat_push_tokens, sends a multicast, and prunes any
// tokens the FCM service reports as dead. Server send uses the function's
// service account — no VAPID/secret needed here (the public VAPID key is only
// used client-side to obtain a token).
exports.onChatMessageCreated = onDocumentCreated(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    document: 'artifacts/{appId}/public/data/chat_channels/{cid}/messages/{mid}',
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const msg = snap.data() || {};
    const { appId, cid } = event.params;
    const senderId = msg.sender_id || '';
    const ctype = msg.channel_type || '';

    // 1. Resolve recipient employee ids.
    let recipientIds = [];
    if (ctype === 'team' || ctype === 'announcement') {
      const emps = await db.collection(`artifacts/${appId}/public/data/employees`).get();
      recipientIds = emps.docs
        .filter((d) => (d.data().status || 'Active') === 'Active')
        .map((d) => d.id);
    } else {
      recipientIds = Array.isArray(msg.members) ? msg.members.slice() : [];
    }
    recipientIds = recipientIds.filter((id) => id && id !== senderId);
    if (recipientIds.length === 0) return;

    // 2. Collect device tokens for those recipients.
    const recipSet = new Set(recipientIds);
    const tokSnap = await db.collection(`artifacts/${appId}/public/data/chat_push_tokens`).get();
    const tokenDocs = tokSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => t.token && recipSet.has(t.emp_id));
    const tokens = Array.from(new Set(tokenDocs.map((t) => t.token)));
    if (tokens.length === 0) return;

    // 3. Build the notification (look up the channel name for context).
    const chanSnap = await db.doc(`artifacts/${appId}/public/data/chat_channels/${cid}`).get();
    const chanName = chanSnap.exists ? (chanSnap.data().name || '') : '';
    const sender = msg.sender_name || 'Someone';
    let title;
    if (ctype === 'dm') title = sender;
    else if (ctype === 'announcement') title = `📢 ${chanName || 'Announcement'}`;
    else title = chanName ? `${chanName} · ${sender}` : sender;
    let body = (msg.text || '').slice(0, 240);
    if (!body && Array.isArray(msg.attachments) && msg.attachments.length) {
      body = (msg.attachments[0].type || '').startsWith('image/') ? '📷 Photo' : `📎 ${msg.attachments[0].name || 'Attachment'}`;
    }

    // 4. Send + prune dead tokens.
    let resp;
    try {
      resp = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { channel_id: msg.channel_id || cid, channel_type: ctype },
        webpush: {
          notification: { icon: '/icons/icon-192.png' },
          fcmOptions: { link: '/chat' },
        },
      });
    } catch (e) {
      logger.warn('chat push send failed', e);
      return;
    }
    const dead = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          dead.push(tokens[i]);
        }
      }
    });
    await Promise.all(dead.map((tk) => db.doc(`artifacts/${appId}/public/data/chat_push_tokens/${tk}`).delete().catch(() => {})));
    logger.info(`chat push: ${resp.successCount}/${tokens.length} delivered for ${ctype} ${cid}`);
  },
);

// ── Location history cleanup — prune trail points past the retention window ──
// Daily; per app reads settings/tracking.history_retention_days (default 30) and
// deletes location_history docs older than the cutoff. `at` is an ISO string, so
// a single-field range query needs no composite index.
async function pruneAppLocationHistory(appId) {
  const cfg = await db.doc(`artifacts/${appId}/public/data/settings/tracking`).get()
    .then((s) => (s.exists ? s.data() : {})).catch(() => ({}));
  const days = Math.max(1, Number(cfg.history_retention_days) || 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const col = db.collection(`artifacts/${appId}/public/data/location_history`);
  let deleted = 0;
  // Delete in batches of 400 until nothing older remains.
  for (let i = 0; i < 50; i++) {
    const snap = await col.where('at', '<', cutoff).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 400) break;
  }
  return deleted;
}

exports.pruneLocationHistory = onSchedule(
  { schedule: 'every day 02:30', timeZone: 'Asia/Kolkata', memory: '256MiB', timeoutSeconds: 540 },
  async () => {
    const appIds = await listAppIds();
    let total = 0;
    for (const appId of appIds) {
      try { total += await pruneAppLocationHistory(appId); }
      catch (e) { logger.warn(`pruneLocationHistory failed for ${appId}`, e); }
    }
    logger.info(`pruneLocationHistory removed ${total} old point(s) across ${appIds.length} app(s)`);
  },
);

// ── Keep projects' denormalised client_owner_id in sync ─────────────────────
// When a client's owner_id changes (incl. an admin assigning an owner to a
// legacy client), stamp client_owner_id onto all of that client's projects so
// owner-scoped project reads work. Also backfills on first assignment.
exports.onClientWritten = onDocumentWritten(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 120, document: 'artifacts/{appId}/public/data/clients/{cid}' },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // client deleted — leave projects untouched
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const newOwner = after.owner_id || '';
    const oldOwner = before ? (before.owner_id || '') : ' none';
    if (newOwner === oldOwner) return; // owner unchanged
    const { appId, cid } = event.params;
    // Stamp client_owner_id onto the client's projects AND payments so owner-scoped
    // reads work (project financials + the coordinator commission view).
    const stampByClient = async (name) => {
      const snap = await db.collection(`artifacts/${appId}/public/data/${name}`).where('client_id', '==', cid).get();
      let batch = db.batch(); let pending = 0; let stamped = 0;
      for (const d of snap.docs) {
        if ((d.data().client_owner_id || '') === newOwner) continue;
        batch.update(d.ref, { client_owner_id: newOwner });
        pending += 1; stamped += 1;
        if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
      }
      if (pending > 0) await batch.commit();
      return stamped;
    };
    const stampedProjects = await stampByClient('projects');
    const stampedPayments = await stampByClient('payments');
    logger.info(`onClientWritten: client ${cid} owner '${oldOwner}'->'${newOwner}', stamped ${stampedProjects} project(s), ${stampedPayments} payment(s)`);
  },
);

// ── Keep payments' denormalised client_owner_id in sync ─────────────────────
// Stamp client_owner_id onto a payment from its client on every write, so the
// coordinator commission view (owner-scoped payment reads) works regardless of
// which surface created the payment (Finance page, assistant, Razorpay webhook).
// The guard makes this idempotent, so the self-triggered re-write stabilises.
exports.onPaymentWritten = onDocumentWritten(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, document: 'artifacts/{appId}/public/data/payments/{payId}' },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!after) return; // deleted
    const clientId = after.client_id || '';
    const { appId, payId } = event.params;
    let owner = '';
    if (clientId) {
      const cSnap = await db.doc(`artifacts/${appId}/public/data/clients/${clientId}`).get().catch(() => null);
      owner = (cSnap && cSnap.exists) ? (cSnap.data().owner_id || '') : '';
    }
    if ((after.client_owner_id || '') === owner) return; // already correct — stops the loop
    await event.data.after.ref.update({ client_owner_id: owner });
    logger.info(`onPaymentWritten: payment ${payId} client_owner_id -> '${owner}'`);
  },
);

