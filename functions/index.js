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
const Anthropic = require('@anthropic-ai/sdk');
const { pbkdf2, timingSafeEqual, createHash, createHmac, randomBytes } = require('crypto');
const { promisify } = require('util');
const {
  LLM_TXN_SCHEMA,
  STATIC_SYSTEM_PROMPT,
  STATIC_QA_PROMPT,
  LLM_STMT_SCHEMA,
  STATIC_STMT_PROMPT,
  LLM_INVOICE_SCHEMA,
  STATIC_INVOICE_PROMPT,
  buildVolatileContext,
  capContext,
  sanitizeLlmTransaction,
  sanitizeLlmStatement,
  sanitizeLlmInvoice,
  supportsAdaptiveThinking,
} = require('./ai-sanitize');
const {
  partyLegNameSet,
  projectPartyJournalRows,
  projectOpeningBalance,
  selectVendorProjectPOs,
  projectSharedReimbursables,
  groupClientSharedExpenses,
} = require('./ledger-project');

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

// ── AI entry extraction (Virtual Accountant LLM escalation) ─────────────────
// The rule engine parses chat client-side first; this callable handles the
// messages rules can't (Hinglish, GST back-calculation, compound entries).
// The Anthropic API key lives in settings/ai — firestore.rules denies READ to
// every client role; only this function reads it via the Admin SDK. The output
// is a DRAFT in the canonical Transaction shape: the client re-validates it
// and a human confirms in the entry preview before anything is posted.
async function readAiConfig(appId) {
  const snap = await db.doc(`artifacts/${appId}/public/data/settings/ai`).get();
  const cfg = snap.exists ? (snap.data() || {}) : {};
  if (cfg.enabled !== true) throw new HttpsError('failed-precondition', 'AI assistant is not enabled. Turn it on in Admin Tools → AI Assistant.');
  if (!cfg.api_key) throw new HttpsError('failed-precondition', 'AI assistant has no API key. Add one in Admin Tools → AI Assistant.');
  return cfg;
}

exports.aiExtractEntry = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 },
  async (req) => {
    const { appId, text, context } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant']); // = canEditFinance; matches chat posting rights
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message) throw new HttpsError('invalid-argument', 'Message text required');
    if (message.length > 500) throw new HttpsError('invalid-argument', 'Message too long (max 500 characters)');

    const cfg = await readAiConfig(appId);
    const modelId = (typeof cfg.model === 'string' && cfg.model.trim()) || 'claude-opus-4-8';
    const monthlyBudget = Number(cfg.monthly_token_budget) > 0 ? Number(cfg.monthly_token_budget) : 2000000;
    const perUserRpm = Number(cfg.per_user_rpm) > 0 ? Number(cfg.per_user_rpm) : 6;

    // Per-user fixed-window rate limit (transactional; doc unreadable/unwritable
    // by clients — see the ai_usage rules stanza).
    const minute = new Date().toISOString().slice(0, 16);
    const rlRef = db.doc(`artifacts/${appId}/public/data/ai_usage/rl_${req.auth.uid}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef);
      const cur = snap.exists ? snap.data() : {};
      const count = cur.minute === minute ? Number(cur.count || 0) : 0;
      if (count >= perUserRpm) throw new HttpsError('resource-exhausted', 'Too many AI requests — wait a minute and try again.');
      tx.set(rlRef, { minute, count: count + 1, updated_at: new Date().toISOString() });
    });

    // Monthly token budget. Best-effort stop: the check is read-then-act, so
    // simultaneous requests near the cap can overshoot by a few calls' tokens
    // (bounded by per_user_rpm × concurrent users × ~10k) — accepted slack.
    const month = new Date().toISOString().slice(0, 7);
    const usageRef = db.doc(`artifacts/${appId}/public/data/ai_usage/usage_${month}`);
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? Number(usageSnap.data().tokens_total || 0) : 0;
    if (used >= monthlyBudget) throw new HttpsError('resource-exhausted', 'Monthly AI budget exhausted. Ask your admin to raise it in Admin Tools → AI Assistant.');

    // Timeout/retries must fit inside the callable's 60s deadline — the SDK
    // defaults (600s timeout, 2 retries) would blow it and surface an opaque
    // DEADLINE_EXCEEDED instead of the mapped errors below.
    const client = new Anthropic({ apiKey: cfg.api_key, timeout: 45000, maxRetries: 1 });
    let resp;
    try {
      resp = await client.messages.create({
        model: modelId,
        max_tokens: 8000, // adaptive thinking spends from this cap too — GST/compound entries need headroom
        // Haiku (and pre-4.6 models) reject adaptive thinking with a 400 — omit there.
        ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive' } } : {}),
        system: [
          // cache_control is inert while the static prompt is under the model's
          // minimum cacheable prefix (~4096 tokens on Opus 4.8) — harmless, and
          // engages automatically if the prompt grows.
          { type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildVolatileContext(context) },
        ],
        output_config: { format: { type: 'json_schema', schema: LLM_TXN_SCHEMA } },
        messages: [{ role: 'user', content: `<user_message>\n${message}\n</user_message>` }],
      });
    } catch (err) {
      // Typed SDK errors, most-specific first. Never log the key or context lists.
      if (err instanceof Anthropic.AuthenticationError) throw new HttpsError('failed-precondition', 'The configured AI API key is invalid. Update it in Admin Tools → AI Assistant.');
      if (err instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'The AI service is busy — try again in a moment.');
      if (err instanceof Anthropic.APIConnectionError) throw new HttpsError('unavailable', 'Could not reach the AI service. Try again.');
      if (err instanceof Anthropic.APIError) {
        logger.error('aiExtractEntry provider error', { appId, status: err.status });
        if (Number(err.status) === 529) throw new HttpsError('resource-exhausted', 'The AI service is overloaded — try again in a moment.');
        throw new HttpsError('internal', 'The AI service returned an error. Try again.');
      }
      throw err;
    }

    // Record spend before interpreting the result — the tokens are used either
    // way. Best-effort: a transient Firestore failure here must not fail the
    // user's successful extraction (and a retry would double-spend tokens).
    const u = resp.usage || {};
    const totalTokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
      + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
    try {
      await usageRef.set({
        tokens_in: admin.firestore.FieldValue.increment(Number(u.input_tokens || 0)),
        tokens_out: admin.firestore.FieldValue.increment(Number(u.output_tokens || 0)),
        tokens_total: admin.firestore.FieldValue.increment(totalTokens),
        calls: admin.firestore.FieldValue.increment(1),
        last_call_at: new Date().toISOString(),
        last_model: modelId,
      }, { merge: true });
    } catch (err) {
      logger.error('aiExtractEntry usage increment failed', { appId, reason: err.message });
    }

    if (resp.stop_reason === 'refusal') throw new HttpsError('failed-precondition', 'The AI declined to process this message. Rephrase and try again.');
    if (resp.stop_reason === 'max_tokens') throw new HttpsError('internal', 'The AI response was cut off — try a shorter message.');

    const textBlock = (resp.content || []).find((b) => b && b.type === 'text');
    let parsedJson = null;
    try { parsedJson = JSON.parse(textBlock && textBlock.text); } catch { /* handled below */ }
    if (!parsedJson) throw new HttpsError('internal', 'The AI could not produce a valid entry — try rephrasing.');

    let transaction;
    try {
      transaction = sanitizeLlmTransaction(parsedJson, { text: message, todayISO: capContext(context).todayISO, modelId });
    } catch (err) {
      logger.warn('aiExtractEntry sanitize failed', { appId, reason: err.message });
      throw new HttpsError('internal', 'The AI could not produce a valid entry — try rephrasing.');
    }

    return { ok: true, transaction, usage: { monthly_used: used + totalTokens, monthly_budget: monthlyBudget } };
  }
);

// ── AI ask-anything Q&A (read-only) ─────────────────────────────────────────
// Answers a free-form accounting question using ONLY a compact, read-only books
// digest the client computes from the in-memory snapshot. Never posts, never
// writes to the ledger. Reuses settings/ai + ai_usage + the same guards; a
// separate rate-limit doc (rl_qa_) throttles Q&A independently of entry drafts.
exports.aiAnswerQuery = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 },
  async (req) => {
    const { appId, question, digest } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant']);
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) throw new HttpsError('invalid-argument', 'Question text required');
    if (q.length > 500) throw new HttpsError('invalid-argument', 'Question too long (max 500 characters)');
    if (!digest || typeof digest !== 'object') throw new HttpsError('invalid-argument', 'Books digest required');

    const cfg = await readAiConfig(appId);
    const modelId = (typeof cfg.model === 'string' && cfg.model.trim()) || 'claude-opus-4-8';
    const monthlyBudget = Number(cfg.monthly_token_budget) > 0 ? Number(cfg.monthly_token_budget) : 2000000;
    const perUserRpm = Number(cfg.per_user_rpm) > 0 ? Number(cfg.per_user_rpm) : 6;

    // Per-user fixed-window rate limit — separate doc from entry extraction.
    const minute = new Date().toISOString().slice(0, 16);
    const rlRef = db.doc(`artifacts/${appId}/public/data/ai_usage/rl_qa_${req.auth.uid}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef);
      const cur = snap.exists ? snap.data() : {};
      const count = cur.minute === minute ? Number(cur.count || 0) : 0;
      if (count >= perUserRpm) throw new HttpsError('resource-exhausted', 'Too many AI questions — wait a minute and try again.');
      tx.set(rlRef, { minute, count: count + 1, updated_at: new Date().toISOString() });
    });

    const month = new Date().toISOString().slice(0, 7);
    const usageRef = db.doc(`artifacts/${appId}/public/data/ai_usage/usage_${month}`);
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? Number(usageSnap.data().tokens_total || 0) : 0;
    if (used >= monthlyBudget) throw new HttpsError('resource-exhausted', 'Monthly AI budget exhausted. Ask your admin to raise it in Admin Tools → AI Assistant.');

    // Cap the digest payload defensively (client already compacts it).
    const digestStr = JSON.stringify(digest).slice(0, 60000);

    const client = new Anthropic({ apiKey: cfg.api_key, timeout: 45000, maxRetries: 1 });
    let resp;
    try {
      resp = await client.messages.create({
        model: modelId,
        max_tokens: 1500,
        ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive' } } : {}),
        system: [{ type: 'text', text: STATIC_QA_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `<question>\n${q}\n</question>\n\n<books_digest>\n${digestStr}\n</books_digest>` }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new HttpsError('failed-precondition', 'The configured AI API key is invalid. Update it in Admin Tools → AI Assistant.');
      if (err instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'The AI service is busy — try again in a moment.');
      if (err instanceof Anthropic.APIConnectionError) throw new HttpsError('unavailable', 'Could not reach the AI service. Try again.');
      if (err instanceof Anthropic.APIError) {
        logger.error('aiAnswerQuery provider error', { appId, status: err.status });
        if (Number(err.status) === 529) throw new HttpsError('resource-exhausted', 'The AI service is overloaded — try again in a moment.');
        throw new HttpsError('internal', 'The AI service returned an error. Try again.');
      }
      throw err;
    }

    const u = resp.usage || {};
    const totalTokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
      + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
    try {
      await usageRef.set({
        tokens_in: admin.firestore.FieldValue.increment(Number(u.input_tokens || 0)),
        tokens_out: admin.firestore.FieldValue.increment(Number(u.output_tokens || 0)),
        tokens_total: admin.firestore.FieldValue.increment(totalTokens),
        calls: admin.firestore.FieldValue.increment(1),
        last_call_at: new Date().toISOString(),
        last_model: modelId,
      }, { merge: true });
    } catch (err) {
      logger.error('aiAnswerQuery usage increment failed', { appId, reason: err.message });
    }

    if (resp.stop_reason === 'refusal') throw new HttpsError('failed-precondition', 'The AI declined to answer that. Rephrase and try again.');
    const textBlock = (resp.content || []).find((b) => b && b.type === 'text');
    const answer = textBlock && typeof textBlock.text === 'string'
      ? textBlock.text.replace(new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]','g'), ' ').trim().slice(0, 4000)
      : '';
    if (!answer) throw new HttpsError('internal', 'The AI could not answer that — try rephrasing.');

    return { ok: true, answer, usage: { monthly_used: used + totalTokens, monthly_budget: monthlyBudget } };
  }
);

// ── AI bank-statement extraction (PDF → rows) ───────────────────────────────
// Reads an uploaded PDF bank statement and returns transaction rows the client
// serialises to canonical CSV and feeds the existing reconcile parse path.
// Longer deadline + bigger memory than aiExtractEntry (whole-document vision +
// up to 1000 rows). Reuses settings/ai + ai_usage; a separate rate-limit doc
// (rl_stmt_) throttles these heavier calls independently. Draft-only: every row
// is reviewed and each booking is human-confirmed before it posts.
exports.aiExtractStatement = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async (req) => {
    const { appId, pdfBase64, context } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant']);
    const b64 = typeof pdfBase64 === 'string' ? pdfBase64.trim() : '';
    if (!b64) throw new HttpsError('invalid-argument', 'PDF data required');
    if (!b64.startsWith('JVBERi')) throw new HttpsError('invalid-argument', 'That file is not a PDF. Upload a PDF bank statement, or a CSV/XLSX export.');
    if (b64.length > 7000000) throw new HttpsError('invalid-argument', 'PDF too large (max ~5MB). Split it into smaller date ranges, or upload a CSV/XLSX export.');

    const cfg = await readAiConfig(appId);
    const modelId = (typeof cfg.model === 'string' && cfg.model.trim()) || 'claude-opus-4-8';
    const monthlyBudget = Number(cfg.monthly_token_budget) > 0 ? Number(cfg.monthly_token_budget) : 2000000;
    const perUserRpm = Number(cfg.per_user_stmt_rpm) > 0 ? Number(cfg.per_user_stmt_rpm) : 2;

    // Independent rate-limit doc for statement extraction (heavier than chat).
    const minute = new Date().toISOString().slice(0, 16);
    const rlRef = db.doc(`artifacts/${appId}/public/data/ai_usage/rl_stmt_${req.auth.uid}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef);
      const cur = snap.exists ? snap.data() : {};
      const count = cur.minute === minute ? Number(cur.count || 0) : 0;
      if (count >= perUserRpm) throw new HttpsError('resource-exhausted', 'Too many statement imports — wait a minute and try again.');
      tx.set(rlRef, { minute, count: count + 1, updated_at: new Date().toISOString() });
    });

    const month = new Date().toISOString().slice(0, 7);
    const usageRef = db.doc(`artifacts/${appId}/public/data/ai_usage/usage_${month}`);
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? Number(usageSnap.data().tokens_total || 0) : 0;
    if (used >= monthlyBudget) throw new HttpsError('resource-exhausted', 'Monthly AI budget exhausted. Ask your admin to raise it in Admin Tools → AI Assistant.');

    // maxRetries:0 — a retry of a large vision call would double-spend tokens
    // and risk the 300s deadline; timeout sits just under it.
    const client = new Anthropic({ apiKey: cfg.api_key, timeout: 280000, maxRetries: 0 });
    let resp;
    try {
      resp = await client.messages.create({
        model: modelId,
        max_tokens: 32000, // up to 1000 rows of JSON needs a large output cap
        ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive' } } : {}),
        system: [
          { type: 'text', text: STATIC_STMT_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildVolatileContext(context) },
        ],
        output_config: { format: { type: 'json_schema', schema: LLM_STMT_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
            { type: 'text', text: '<statement>The attached PDF is a bank account statement. Extract every transaction row per the rules.</statement>' },
          ],
        }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new HttpsError('failed-precondition', 'The configured AI API key is invalid. Update it in Admin Tools → AI Assistant.');
      if (err instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'The AI service is busy — try again in a moment.');
      if (err instanceof Anthropic.APIConnectionError) throw new HttpsError('unavailable', 'Could not reach the AI service. Try again.');
      if (err instanceof Anthropic.APIError) {
        logger.error('aiExtractStatement provider error', { appId, status: err.status });
        if (Number(err.status) === 529) throw new HttpsError('resource-exhausted', 'The AI service is overloaded — try again in a moment.');
        throw new HttpsError('internal', 'The AI service returned an error. Try again.');
      }
      throw err;
    }

    const u = resp.usage || {};
    const totalTokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
      + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
    try {
      await usageRef.set({
        tokens_in: admin.firestore.FieldValue.increment(Number(u.input_tokens || 0)),
        tokens_out: admin.firestore.FieldValue.increment(Number(u.output_tokens || 0)),
        tokens_total: admin.firestore.FieldValue.increment(totalTokens),
        calls: admin.firestore.FieldValue.increment(1),
        last_call_at: new Date().toISOString(),
        last_model: modelId,
      }, { merge: true });
    } catch (err) {
      logger.error('aiExtractStatement usage increment failed', { appId, reason: err.message });
    }

    if (resp.stop_reason === 'refusal') throw new HttpsError('failed-precondition', 'The AI declined to process this document.');
    if (resp.stop_reason === 'max_tokens') throw new HttpsError('resource-exhausted', 'The statement is too large for one pass — split the PDF into smaller date ranges, or upload a CSV/XLSX export instead.');

    const textBlock = (resp.content || []).find((b) => b && b.type === 'text');
    let parsedJson = null;
    try { parsedJson = JSON.parse(textBlock && textBlock.text); } catch { /* handled below */ }
    if (!parsedJson) throw new HttpsError('internal', 'The AI could not read the statement — try a clearer PDF or a CSV export.');

    let statement;
    try {
      statement = sanitizeLlmStatement(parsedJson, { todayISO: capContext(context).todayISO });
    } catch (err) {
      logger.warn('aiExtractStatement sanitize failed', { appId, reason: err.message });
      throw new HttpsError('internal', err.message || 'The AI could not read the statement — try a clearer PDF or a CSV export.');
    }

    return { ok: true, statement, usage: { monthly_used: used + totalTokens, monthly_budget: monthlyBudget } };
  }
);

// ── AI purchase-invoice extraction (PDF/image → form prefill) ───────────────
// Reads ONE supplier invoice and returns header fields the PurchaseInvoices
// form prefills for human review. Never posts; the user confirms and saves.
// Reuses settings/ai + ai_usage; own rate-limit doc rl_inv_.
const INVOICE_MIME = {
  'application/pdf': 'JVBERi',
  'image/jpeg': '/9j/',
  'image/png': 'iVBORw',
  'image/webp': 'UklGR',
  'image/gif': 'R0lGOD',
};
exports.aiExtractInvoice = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120 },
  async (req) => {
    const { appId, fileBase64, mimeType, context } = req.data || {};
    await assertRole(req.auth, appId, ['admin', 'accountant']);
    const mt = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
    const b64 = typeof fileBase64 === 'string' ? fileBase64.trim() : '';
    if (!b64) throw new HttpsError('invalid-argument', 'Invoice file required');
    if (!INVOICE_MIME[mt]) throw new HttpsError('invalid-argument', 'Unsupported file type. Upload a PDF or an image (JPG/PNG/WebP).');
    if (!b64.startsWith(INVOICE_MIME[mt])) throw new HttpsError('invalid-argument', 'File content does not match its type. Re-upload the invoice.');
    if (b64.length > 7000000) throw new HttpsError('invalid-argument', 'File too large (max ~5MB). Upload a smaller scan or a single-page PDF.');

    const cfg = await readAiConfig(appId);
    const modelId = (typeof cfg.model === 'string' && cfg.model.trim()) || 'claude-opus-4-8';
    const monthlyBudget = Number(cfg.monthly_token_budget) > 0 ? Number(cfg.monthly_token_budget) : 2000000;
    const perUserRpm = Number(cfg.per_user_invoice_rpm) > 0 ? Number(cfg.per_user_invoice_rpm) : 4;

    const minute = new Date().toISOString().slice(0, 16);
    const rlRef = db.doc(`artifacts/${appId}/public/data/ai_usage/rl_inv_${req.auth.uid}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef);
      const cur = snap.exists ? snap.data() : {};
      const count = cur.minute === minute ? Number(cur.count || 0) : 0;
      if (count >= perUserRpm) throw new HttpsError('resource-exhausted', 'Too many invoice extractions — wait a minute and try again.');
      tx.set(rlRef, { minute, count: count + 1, updated_at: new Date().toISOString() });
    });

    const month = new Date().toISOString().slice(0, 7);
    const usageRef = db.doc(`artifacts/${appId}/public/data/ai_usage/usage_${month}`);
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? Number(usageSnap.data().tokens_total || 0) : 0;
    if (used >= monthlyBudget) throw new HttpsError('resource-exhausted', 'Monthly AI budget exhausted. Ask your admin to raise it in Admin Tools → AI Assistant.');

    const fileBlock = mt === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } };

    const client = new Anthropic({ apiKey: cfg.api_key, timeout: 110000, maxRetries: 0 });
    let resp;
    try {
      resp = await client.messages.create({
        model: modelId,
        max_tokens: 4000,
        ...(supportsAdaptiveThinking(modelId) ? { thinking: { type: 'adaptive' } } : {}),
        system: [
          { type: 'text', text: STATIC_INVOICE_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: buildVolatileContext(context) },
        ],
        output_config: { format: { type: 'json_schema', schema: LLM_INVOICE_SCHEMA } },
        messages: [{
          role: 'user',
          content: [fileBlock, { type: 'text', text: '<invoice>The attached file is a supplier invoice. Extract its fields per the rules.</invoice>' }],
        }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new HttpsError('failed-precondition', 'The configured AI API key is invalid. Update it in Admin Tools → AI Assistant.');
      if (err instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'The AI service is busy — try again in a moment.');
      if (err instanceof Anthropic.APIConnectionError) throw new HttpsError('unavailable', 'Could not reach the AI service. Try again.');
      if (err instanceof Anthropic.APIError) {
        logger.error('aiExtractInvoice provider error', { appId, status: err.status });
        if (Number(err.status) === 529) throw new HttpsError('resource-exhausted', 'The AI service is overloaded — try again in a moment.');
        throw new HttpsError('internal', 'The AI service returned an error. Try again.');
      }
      throw err;
    }

    const u = resp.usage || {};
    const totalTokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
      + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
    try {
      await usageRef.set({
        tokens_in: admin.firestore.FieldValue.increment(Number(u.input_tokens || 0)),
        tokens_out: admin.firestore.FieldValue.increment(Number(u.output_tokens || 0)),
        tokens_total: admin.firestore.FieldValue.increment(totalTokens),
        calls: admin.firestore.FieldValue.increment(1),
        last_call_at: new Date().toISOString(),
        last_model: modelId,
      }, { merge: true });
    } catch (err) {
      logger.error('aiExtractInvoice usage increment failed', { appId, reason: err.message });
    }

    if (resp.stop_reason === 'refusal') throw new HttpsError('failed-precondition', 'The AI declined to process this document.');
    if (resp.stop_reason === 'max_tokens') throw new HttpsError('internal', 'The AI response was cut off — try a clearer single-page invoice.');

    const textBlock = (resp.content || []).find((b) => b && b.type === 'text');
    let parsedJson = null;
    try { parsedJson = JSON.parse(textBlock && textBlock.text); } catch { /* handled below */ }
    if (!parsedJson) throw new HttpsError('internal', 'The AI could not read the invoice — try a clearer scan or enter it manually.');

    let invoice;
    try {
      invoice = sanitizeLlmInvoice(parsedJson, { todayISO: capContext(context).todayISO });
    } catch (err) {
      logger.warn('aiExtractInvoice sanitize failed', { appId, reason: err.message });
      throw new HttpsError('internal', 'The AI could not read the invoice — try a clearer scan or enter it manually.');
    }

    return { ok: true, invoice, usage: { monthly_used: used + totalTokens, monthly_budget: monthlyBudget } };
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
      for (const d of projSnap.docs) {
        const p = await mergeProjectFin(appId, d.id, d.data()); // vendor_allocations from sibling (base scrubbed)
        (p.vendor_allocations || []).filter((a) => a.vendor_id === cid).forEach((a) => {
          const amt = Number(a.tax_amount || a.amount || 0);
          jobs.push({ project: p.project_name || '', item: a.item_name || '', amount: amt });
          vBilled += amt;
        });
      }
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

// WHITELIST projection of a client for the EXTERNAL ledger-link holder (round-15:
// was a blacklist that would leak any newly-added internal client field). Returns
// only what PublicLedger renders; referral_rate / owner_id / owner_name / commission
// / remarks / tokens are excluded by construction. `id` is added by the caller.
function pickLedgerClient(c) {
  const d = c || {};
  return {
    name: d.name || '',
    type: d.type || 'Client',
    gstin: d.gstin || '',
    address: d.address || '',
    companies: d.companies || [],
  };
}

// WHITELIST projection of the org/settings doc for EXTERNAL token pages (round-15:
// the four public functions returned the RAW settings/organization doc, leaking
// gst_api_key (a live GST-API credential) + bank_accounts to logged-out link
// holders). Return only the display fields the public pages/PDFs render — mirrors
// getPortalData's curated org.
function pickOrgPublic(org) {
  const o = org || {};
  return {
    name: o.name || '',
    company_name: o.company_name || '',
    address: o.address || '',
    gstin: o.gstin || '',
    phone: o.phone || '',
    email: o.email || '',
    logo: o.logo || '',
  };
}

// WHITELIST projection of a money row (payment / vendor_payment / purchase_invoice /
// tax_invoice) for the EXTERNAL ledger (round-15: was a blacklist). Union of every
// field PublicLedger renders across the four row types; `id` set by the caller.
function pickLedgerRow(d) {
  const r = d.data();
  const keep = ['amount', 'client_id', 'computed_total', 'date', 'description',
    'final_amount', 'gst_amount', 'include_in_ledger', 'invoice_date', 'invoice_no',
    'invoice_ref', 'linked_po_id', 'linked_po_no', 'mode', 'party_company_id',
    'pi_no', 'project_id', 'project_ids', 'project_name', 'project_names',
    'reference', 'sale_company_id', 'status', 'vendor_id', 'vendor_name'];
  const out = { id: d.id };
  for (const k of keep) { if (r[k] !== undefined) out[k] = r[k]; }
  return out;
}

// WHITELIST projection of a project for the EXTERNAL client/vendor ledger.
// Round-14: replaces the previous blacklist strip, which leaked a newly-added
// internal field every iteration (owner UID → identity → remarks → direct_expense
// _total). Returns ONLY the fields PublicLedger + getProjectGrandTotal render, so
// no field ever added to a project doc can leak through a magic link. purchase_
// orders is filtered to the recipient's OWN POs (a vendor sees their payables; a
// client owns none). Client-facing revenue fields (items / logistics_costs /
// package_cost / reimbursable_expenses) ARE the client's payable and are retained.
// Field-split slice 3: project money now lives in the gated project_financials/{pid}
// sibling (base doc scrubbed). These server functions read projects via the Admin SDK,
// which bypasses rules, so merge the sibling's money back over the base doc before
// projecting for the external client/vendor. (Falls back to base if no sibling.)
async function mergeProjectFin(appId, id, data) {
  try {
    const finDoc = await db.doc(`artifacts/${appId}/public/data/project_financials/${id}`).get();
    if (!finDoc.exists) return data;
    const fin = finDoc.data();
    delete fin.client_owner_id; delete fin.created_by; delete fin.updated_at;
    return { ...data, ...fin };
  } catch (_) { return data; }
}

function pickLedgerProject(data, cid) {
  const d = data || {};
  // Per-project opt-in: only when the owner flags share_expense_details do proof
  // links ride along (reimbursables) and does getLedgerData attach direct_expenses.
  const shareExp = d.share_expense_details === true;
  return {
    client_id: d.client_id || '',
    project_name: d.project_name || '',
    status: d.status || '',
    party_company_id: d.party_company_id || '',
    start_date: d.start_date || '',
    end_date: d.end_date || '',
    setup_date: d.setup_date || '',
    venue: d.venue || '',
    invoice_no: d.invoice_no || '',
    invoice_date: d.invoice_date || '',
    invoice_status: d.invoice_status || '',
    package_cost: d.package_cost ?? 0,
    package_cost_gst: d.package_cost_gst ?? 0,
    items: d.items || [],
    logistics_costs: d.logistics_costs || {},
    reimbursable_expenses: projectSharedReimbursables(d.reimbursable_expenses, shareExp),
    share_expense_details: shareExp,
    purchase_orders: (d.purchase_orders || []).filter((po) => po && po.vendor_id === cid),
  };
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
    const [allProjSnap, paySnap, vpaySnap, orgSnap, piSnap, tiSnap, jeSnap, obSnap, paSnap, finSnap] = await Promise.all([
      // All projects: the client's OWN (client_id) are filtered below, and a
      // vendor's POs live embedded in OTHER parties' projects (see finSnap).
      col('projects').get(),
      col('payments').where('client_id', '==', cid).get(),
      col('vendor_payments').where('vendor_id', '==', cid).get(),
      db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null),
      col('purchase_invoices').where('vendor_id', '==', cid).get(),
      col('tax_invoices').where('client_id', '==', cid).get(),
      // No party field to query on — read all and filter by name leg-side below.
      col('journal_entries').get(),
      db.doc(`artifacts/${appId}/public/data/opening_balances/clientob_${cid}`).get().catch(() => null),
      db.doc(`artifacts/${appId}/public/data/party_accounts/${cid}`).get().catch(() => null),
      // A vendor's POs live embedded in OTHER parties' projects, inside the gated
      // project_financials sibling (base doc scrubbed, no queryable vendor index),
      // so the client_id query above can never reach them. Read the siblings and
      // project out ONLY this vendor's PO legs below.
      col('project_financials').get(),
    ]);
    // All external-facing objects use WHITELIST projections (round-15) — money rows,
    // the client doc, projects and org each return only the fields the public ledger
    // renders, so no internal field (owner UID, staff notes, credentials, cost basis)
    // can ever leak through a magic-link, now or after a future migration.
    const mapRows = (s) => s.docs.map(pickLedgerRow);
    // The party's OWN projects (they are the client) → full whitelist projection,
    // money merged from the gated sibling (base is scrubbed post-slice-3).
    const clientDocs = allProjSnap.docs.filter((d) => (d.data().client_id || '') === cid);
    const clientPids = new Set(clientDocs.map((d) => d.id));
    const clientProjectsOut = await Promise.all(clientDocs.map(async (d) =>
      ({ id: d.id, ...pickLedgerProject(await mergeProjectFin(appId, d.id, d.data()), cid) })));

    // Actual-expense transparency (PER-EXPENSE opt-in): finance marks an APPROVED
    // expense `shared_with_client` in the Expenses screen; only those reach the
    // client, grouped onto the client's OWN projects. One indexed read of the
    // (small) shared set, then whitelist + project-scope in groupClientSharedExpenses
    // — never leaks the employee, path, or another client's projects.
    const sharedExpSnap = await col('expenses').where('shared_with_client', '==', true).get().catch(() => null);
    if (sharedExpSnap && !sharedExpSnap.empty) {
      const sharedByPid = groupClientSharedExpenses(sharedExpSnap.docs.map((d) => d.data()), clientPids);
      clientProjectsOut.forEach((p) => { if (sharedByPid[p.id]) p.direct_expenses = sharedByPid[p.id]; });
    }

    // Vendor POs are embedded in OTHER parties' projects. Post field-split they sit
    // in the gated project_financials sibling, but a not-yet-scrubbed project may
    // still carry them on the base doc — so merge both (sibling wins, base fallback)
    // to be migration-proof. selectVendorProjectPOs returns ONLY this vendor's POs;
    // the owning client's package_cost / items / logistics / margin never come with.
    const finById = new Map(finSnap.docs.map((d) => [d.id, d.data()]));
    const vendorFinInput = allProjSnap.docs
      .filter((d) => !clientPids.has(d.id))
      .map((d) => {
        const base = d.data() || {};
        const sib = finById.get(d.id) || {};
        return {
          id: d.id,
          project_name: base.project_name || '',
          data: { purchase_orders: sib.purchase_orders || base.purchase_orders || [] },
        };
      });
    const nameByPid = new Map(vendorFinInput.map((v) => [v.id, v.project_name]));
    const vendorProjectsOut = selectVendorProjectPOs(vendorFinInput, cid, clientPids)
      .map((x) => ({
        id: x.pid,
        project_name: nameByPid.get(x.pid) || '',
        party_company_id: '', // the owning client's company id is meaningless here
        purchase_orders: x.purchase_orders,
      }));
    const projectsOut = [...clientProjectsOut, ...vendorProjectsOut];

    // Party-leg projections of journal_entries + the opening-balance mirror, so
    // the external ledger reflects manual JVs / CN / DN / TDS / opening balance
    // and ties out with the in-app derived ledger. Only the party's own leg is
    // exposed (see projectPartyJournalRows) — the contra account never leaves here.
    const nameSet = partyLegNameSet(client, (paSnap && paSnap.exists) ? paSnap.data() : null);
    const journalEntries = projectPartyJournalRows(
      jeSnap.docs.map((d) => ({ id: d.id, ...d.data() })), nameSet);
    const openingBalance = projectOpeningBalance((obSnap && obSnap.exists) ? obSnap.data() : null);
    return {
      client: { id: cid, ...pickLedgerClient(client) },
      projects: projectsOut,
      payments: mapRows(paySnap),
      vendorPayments: mapRows(vpaySnap),
      purchaseInvoices: mapRows(piSnap),
      taxInvoices: mapRows(tiSnap),
      journalEntries,
      openingBalance,
      org: (orgSnap && orgSnap.exists) ? pickOrgPublic(orgSnap.data()) : null,
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
    // Round-16: WHITELIST the payout/advance rows too (was a raw spread) — the
    // statement page renders only date/amount/mode/reference/remarks, so no future
    // internal field (approver note, batch id, cost breakdown) can leak through.
    const pickStatementRow = (d) => {
      const r = d.data();
      const out = { id: d.id };
      for (const k of ['amount', 'date', 'mode', 'reference', 'remarks']) {
        if (r[k] !== undefined) out[k] = r[k];
      }
      return out;
    };
    return {
      // Round-9 fix: return ONLY the display name (the statement page renders
      // `employee.name` and nothing else). The raw employee doc carries bank
      // details, PII and hourlyRateHistory / salary that a statement-link holder
      // must not receive — mirror getReimbursableData's curated projection.
      employee: { id: eid, name: emp.name || '' },
      payouts: payoutsSnap.docs.map(pickStatementRow),
      advances: advancesSnap.docs.map(pickStatementRow),
      org: (orgSnap && orgSnap.exists) ? pickOrgPublic(orgSnap.data()) : null,
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
    const pm = await mergeProjectFin(appId, pDoc.id, p); // money from sibling (base scrubbed)
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
        reimbursable_expenses: pm.reimbursable_expenses || [],
      },
      client,
      org: (orgSnap && orgSnap.exists) ? pickOrgPublic(orgSnap.data()) : null,
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
    // WHITELIST projection (round-14): the client approves the QUOTE (their price),
    // so return ONLY the fields QuoteApproval.jsx + getProjectGrandTotal render.
    // Everything else — internal costs/margin/vendor POs, reimbursable working notes,
    // identity metadata, remarks, direct_expense_total, tokens — is excluded by
    // construction, so no new project field can ever leak through this link.
    const pm = await mergeProjectFin(appId, pDoc.id, p); // money from sibling (base scrubbed)
    const quoteSafe = {
      quote_status: p.quote_status || '',
      project_name: p.project_name || '',
      venue: p.venue || '',
      start_date: p.start_date || '',
      end_date: p.end_date || '',
      client_id: p.client_id || '',
      package_cost: pm.package_cost ?? 0,
      package_cost_gst: pm.package_cost_gst ?? 0,
      items: pm.items || [],
      logistics_costs: pm.logistics_costs || {},
    };
    const orgSnap = await db.doc(`artifacts/${appId}/public/data/settings/organization`).get().catch(() => null);
    return {
      project: { id: pDoc.id, ...quoteSafe },
      org: (orgSnap && orgSnap.exists) ? pickOrgPublic(orgSnap.data()) : null,
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

// ── Keep the /users role mirror in sync with employees.role ─────────────────
// userRole() in firestore.rules reads the /users/{uid} mirror FIRST (it is written
// at login), then falls back to /employees/{uid}. A role change in Employees.jsx
// writes ONLY the employees doc, so without this trigger a demotion would not take
// effect server-side until the user voluntarily re-logs in — a demoted admin/manager
// would keep full elevated SDK access (finance/payroll/clients writes) indefinitely
// while their tab stays open (custom-token sessions auto-refresh). This trigger runs
// under the Admin SDK (bypasses rules) and rewrites the mirror's role the instant
// employees.role changes, giving demotion (and promotion) immediate server-side teeth.
exports.onEmployeeWritten = onDocumentWritten(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, document: 'artifacts/{appId}/public/data/employees/{eid}' },
  async (event) => {
    const { appId, eid } = event.params;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const mirrorRef = db.doc(`artifacts/${appId}/public/data/users/${eid}`);
    if (!after) {
      // Employee deleted — remove the mirror so a lingering session can't keep acting
      // as the old role (userRole() would otherwise still read the stale mirror).
      const snap = await mirrorRef.get().catch(() => null);
      if (snap && snap.exists) {
        await mirrorRef.delete().catch(() => {});
        logger.info(`onEmployeeWritten: employee ${eid} deleted — mirror removed`);
      }
      return;
    }
    const newRole = after.role || '';
    if (before && (before.role || '') === newRole) return; // role unchanged — nothing to sync
    // Only touch the mirror if it exists: a user who never logged in has none, and
    // userRole() correctly falls back to the (authoritative) employees doc for them.
    const snap = await mirrorRef.get().catch(() => null);
    if (snap && snap.exists) {
      if ((snap.data().role || '') === newRole) return; // already correct — idempotent
      await mirrorRef.set({ role: newRole, updated_at: new Date().toISOString() }, { merge: true });
      logger.info(`onEmployeeWritten: employee ${eid} role '${before ? before.role : 'none'}' -> '${newRole}' — mirror synced`);
    }
  },
);

// ── Denormalise each project's expenses-collection total ─────────────────────
// The referral-commission net-profit calc needs a project's direct costs, which
// include the separate expenses-collection rows. A Coordinator ('user') can only
// SDK-read their OWN expenses (self-scoped by rules), so their client-side
// commission estimate was STARVED of the project's real expenses (logged by
// managers/techs) and thus inflated. This trigger (Admin SDK) stamps
// direct_expense_total on the project so getProjectDirectCosts can fall back to it
// when the caller cannot see the rows. See-all roles keep using their live array.
exports.onExpenseWritten = onDocumentWritten(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, document: 'artifacts/{appId}/public/data/expenses/{expId}' },
  async (event) => {
    const { appId } = event.params;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    // Recompute the total for any project this expense touched (project_id can change).
    const pids = new Set();
    if (after && after.project_id) pids.add(after.project_id);
    if (before && before.project_id) pids.add(before.project_id);
    for (const pid of pids) {
      if (!pid) continue;
      const snap = await db.collection(`artifacts/${appId}/public/data/expenses`).where('project_id', '==', pid).get();
      let total = 0;
      for (const d of snap.docs) {
        const e = d.data();
        if (e.status === 'Rejected' || e.status === 'Disapproved') continue;
        total += parseFloat(e.amount) || 0;
      }
      total = Math.round(total * 100) / 100;
      const projRef = db.doc(`artifacts/${appId}/public/data/projects/${pid}`);
      const pSnap = await projRef.get().catch(() => null);
      if (pSnap && pSnap.exists) {
        if ((pSnap.data().direct_expense_total || 0) === total) continue; // idempotent — no self-loop
        await projRef.update({ direct_expense_total: total }).catch((err) => logger.warn(`onExpenseWritten: project ${pid} update failed: ${err.message}`));
        logger.info(`onExpenseWritten: project ${pid} direct_expense_total -> ${total}`);
      }
    }
  },
);

// Admin one-shot backfill: stamp direct_expense_total on EVERY project that already
// has booked expenses (the onExpenseWritten trigger only fires on future writes).
// Lets the Coordinator commission estimate become accurate for historical projects.
exports.backfillProjectExpenseTotals = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const expSnap = await db.collection(`artifacts/${appId}/public/data/expenses`).get();
    const totals = {};
    for (const d of expSnap.docs) {
      const e = d.data();
      if (!e.project_id || e.status === 'Rejected' || e.status === 'Disapproved') continue;
      totals[e.project_id] = (totals[e.project_id] || 0) + (parseFloat(e.amount) || 0);
    }
    const projSnap = await db.collection(`artifacts/${appId}/public/data/projects`).get();
    let batch = db.batch(); let pending = 0; let stamped = 0;
    for (const d of projSnap.docs) {
      const want = Math.round((totals[d.id] || 0) * 100) / 100;
      if ((d.data().direct_expense_total || 0) === want) continue;
      batch.update(d.ref, { direct_expense_total: want });
      pending += 1; stamped += 1;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`backfillProjectExpenseTotals: stamped ${stamped} project(s)`);
    return { stamped, projects: projSnap.size };
  },
);

// ── Financial-field-split slice 1: inventory rates/costs ─────────────────────
// Inventory money fields live embedded on the base inventory doc, which every
// role reads operationally (stock/scan), so they were SDK-readable though UI-hidden.
// These two admin callables migrate them into the gated inventory_financials sibling
// (rules: admin/accountant/manager read, admin/manager write). Owner runs BACKFILL
// (copy → sibling), verifies displays, then SCRUB (delete from base = leak closure).
const INV_MONEY_FIELDS = ['rate_per_day', 'rate_per_week', 'purchase_cost', 'replacement_value', 'suppliers'];

exports.backfillInventoryFinancials = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const invSnap = await db.collection(`artifacts/${appId}/public/data/inventory`).get();
    let batch = db.batch(); let pending = 0; let mirrored = 0;
    for (const d of invSnap.docs) {
      const src = d.data();
      const fin = {};
      for (const k of INV_MONEY_FIELDS) { if (src[k] !== undefined) fin[k] = src[k]; }
      if (Object.keys(fin).length === 0) continue;
      fin.updated_at = new Date().toISOString();
      batch.set(db.doc(`artifacts/${appId}/public/data/inventory_financials/${d.id}`), fin, { merge: true });
      pending += 1; mirrored += 1;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`backfillInventoryFinancials: mirrored ${mirrored} item(s)`);
    return { mirrored, items: invSnap.size };
  },
);

exports.scrubInventoryEmbeddedMoney = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const invSnap = await db.collection(`artifacts/${appId}/public/data/inventory`).get();
    const del = admin.firestore.FieldValue.delete();
    let batch = db.batch(); let pending = 0; let scrubbed = 0; let skipped = 0;
    for (const d of invSnap.docs) {
      const src = d.data();
      const present = INV_MONEY_FIELDS.filter((k) => src[k] !== undefined);
      if (present.length === 0) continue;
      // Safety: never scrub unless the sibling already holds this item's money —
      // guarantees the migration can't orphan/lose rates.
      const finDoc = await db.doc(`artifacts/${appId}/public/data/inventory_financials/${d.id}`).get().catch(() => null);
      if (!finDoc || !finDoc.exists) { skipped += 1; continue; }
      const upd = {};
      for (const k of present) upd[k] = del;
      batch.update(d.ref, upd);
      pending += 1; scrubbed += 1;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`scrubInventoryEmbeddedMoney: scrubbed ${scrubbed}, skipped ${skipped} (no sibling)`);
    return { scrubbed, skipped, items: invSnap.size };
  },
);

// ── Financial-field-split slice 2: employee pay ─────────────────────────────
// Pay fields were embedded on the base employee doc (which every role reads for
// name/role/assignment) and only UI-stripped by safeEmployees. Migrate them into
// the gated employee_pay sibling (rules: admin/accountant read+write, view_pay).
const EMP_PAY_FIELDS = ['hourlyRate', 'hourlyRateHistory', 'monthly_ctc', 'ctc', 'salary'];

exports.backfillEmployeePay = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const empSnap = await db.collection(`artifacts/${appId}/public/data/employees`).get();
    let batch = db.batch(); let pending = 0; let mirrored = 0;
    for (const d of empSnap.docs) {
      const src = d.data();
      const pay = {};
      for (const k of EMP_PAY_FIELDS) { if (src[k] !== undefined) pay[k] = src[k]; }
      if (Object.keys(pay).length === 0) continue;
      pay.updated_at = new Date().toISOString();
      batch.set(db.doc(`artifacts/${appId}/public/data/employee_pay/${d.id}`), pay, { merge: true });
      pending += 1; mirrored += 1;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`backfillEmployeePay: mirrored ${mirrored} employee(s)`);
    return { mirrored, employees: empSnap.size };
  },
);

exports.scrubEmployeeEmbeddedPay = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const empSnap = await db.collection(`artifacts/${appId}/public/data/employees`).get();
    const del = admin.firestore.FieldValue.delete();
    let batch = db.batch(); let pending = 0; let scrubbed = 0; let skipped = 0;
    for (const d of empSnap.docs) {
      const src = d.data();
      const present = EMP_PAY_FIELDS.filter((k) => src[k] !== undefined);
      if (present.length === 0) continue;
      const payDoc = await db.doc(`artifacts/${appId}/public/data/employee_pay/${d.id}`).get().catch(() => null);
      if (!payDoc || !payDoc.exists) { skipped += 1; continue; }
      const upd = {};
      for (const k of present) upd[k] = del;
      batch.update(d.ref, upd);
      pending += 1; scrubbed += 1;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`scrubEmployeeEmbeddedPay: scrubbed ${scrubbed}, skipped ${skipped} (no sibling)`);
    return { scrubbed, skipped, employees: empSnap.size };
  },
);

// ── Financial-field-split slice 3: project money ─────────────────────────────
// Projects carry money embedded (items[] rates/totals, package_cost, logistics,
// vendor_allocations, purchase_orders, reimbursable, margin, totals) but are read
// operationally by ALL roles, so the money is SDK-readable. There are ~18 project
// write sites, so instead of re-routing each we MIRROR the money into the gated
// project_financials sibling via a trigger (Admin SDK). Slice 3a (this): mirror only
// — base still carries money (no leak closed yet, zero app change). Slice 3b: scrub
// base + owner-scoped loader merge. The sibling carries client_owner_id/created_by so
// its rule can owner-scope managers to their own projects.
const PROJECT_FINANCIAL_FIELDS = ['package_cost', 'package_cost_gst', 'logistics_costs',
  'vendor_allocations', 'purchase_orders', 'reimbursable_expenses', 'proforma_invoices',
  'total_value', 'total', 'grand_total', 'margin', 'advance_committed', 'direct_expense_total'];
// Base-strip lists. direct_expense_total is intentionally NOT stripped: coordinators
// (who cannot read project_financials) need it on the base doc for their own referral-
// commission calc, and it is a single derived aggregate, not pricing.
const PROJECT_MONEY_SCALARS_STRIP = ['package_cost', 'package_cost_gst', 'logistics_costs',
  'vendor_allocations', 'purchase_orders', 'reimbursable_expenses', 'proforma_invoices',
  'total_value', 'total', 'grand_total', 'margin', 'advance_committed'];
const ITEM_MONEY_FIELDS = ['rate', 'amount', 'gst_rate', 'gst_amount', 'total'];

const itemsHaveMoney = (data) => Array.isArray(data.items)
  && data.items.some((it) => it && ITEM_MONEY_FIELDS.some((f) => it[f] !== undefined));

// Sibling projection. items[] are mirrored ONLY when they still carry money — on a
// PARTIAL money write (e.g. package_cost only) the base items may already be stripped,
// and mirroring them would overwrite the sibling's full items with a stripped copy.
// Scalars use merge-if-present, so already-stripped (undefined) scalars are left as-is.
function buildProjectFin(data) {
  const fin = { client_owner_id: data.client_owner_id || '', created_by: data.created_by || '' };
  for (const k of PROJECT_FINANCIAL_FIELDS) { if (data[k] !== undefined) fin[k] = data[k]; }
  if (itemsHaveMoney(data)) fin.items = data.items;
  return fin;
}

function stripItemMoney(it) {
  if (!it || typeof it !== 'object') return it;
  const clean = {};
  for (const k of Object.keys(it)) { if (!ITEM_MONEY_FIELDS.includes(k)) clean[k] = it[k]; }
  return clean;
}

// True if the BASE doc still carries embedded money (excludes direct_expense_total).
// The trigger's own strip write re-fires it; by then this is false → skip (no loop/wipe).
function projectHasEmbeddedMoney(data) {
  return PROJECT_MONEY_SCALARS_STRIP.some((k) => data[k] !== undefined) || itemsHaveMoney(data);
}

// Delete the base doc's money: scalar money fields + per-element items[] money (keeps
// item_id/name/qty/days). items only rewritten when they still carry money. null = noop.
function buildProjectStrip(data) {
  const strip = {};
  for (const k of PROJECT_MONEY_SCALARS_STRIP) { if (data[k] !== undefined) strip[k] = admin.firestore.FieldValue.delete(); }
  if (itemsHaveMoney(data)) strip.items = data.items.map(stripItemMoney);
  return Object.keys(strip).length ? strip : null;
}

exports.onProjectWritten = onDocumentWritten(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 120, document: 'artifacts/{appId}/public/data/projects/{pid}' },
  async (event) => {
    const { appId, pid } = event.params;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const finRef = db.doc(`artifacts/${appId}/public/data/project_financials/${pid}`);
    if (!after) {
      const snap = await finRef.get().catch(() => null);
      if (snap && snap.exists) { await finRef.delete().catch(() => {}); logger.info(`onProjectWritten: project ${pid} deleted — financials removed`); }
      return;
    }
    // Only act when the base doc actually carries money. The trigger's OWN strip write
    // re-fires this; by then money is gone (guard false) → skip. No loop, no sibling wipe.
    if (!projectHasEmbeddedMoney(after)) return;
    // 1) Mirror the FULL money (incl items with money) → gated sibling.
    const finAfter = buildProjectFin(after);
    finAfter.updated_at = new Date().toISOString();
    await finRef.set(finAfter, { merge: true });
    // 2) Strip the money from the base doc (the leak closure); new edits self-heal here.
    const strip = buildProjectStrip(after);
    if (strip) await event.data.after.ref.update(strip);
    logger.info(`onProjectWritten: project ${pid} mirrored + base stripped`);
  },
);

exports.backfillProjectFinancials = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const projSnap = await db.collection(`artifacts/${appId}/public/data/projects`).get();
    let batch = db.batch(); let pending = 0; let mirrored = 0;
    for (const d of projSnap.docs) {
      const fin = buildProjectFin(d.data());
      fin.updated_at = new Date().toISOString();
      batch.set(db.doc(`artifacts/${appId}/public/data/project_financials/${d.id}`), fin, { merge: true });
      pending += 1; mirrored += 1;
      if (pending >= 300) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`backfillProjectFinancials: mirrored ${mirrored} project(s)`);
    return { mirrored, projects: projSnap.size };
  },
);

exports.scrubProjectEmbeddedMoney = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 },
  async (req) => {
    const { appId } = req.data || {};
    await assertAdmin(req.auth, appId);
    const projSnap = await db.collection(`artifacts/${appId}/public/data/projects`).get();
    let batch = db.batch(); let pending = 0; let scrubbed = 0; let skipped = 0;
    for (const d of projSnap.docs) {
      const data = d.data();
      if (!projectHasEmbeddedMoney(data)) continue; // already clean
      // Safety: never scrub unless the sibling already holds this project's money.
      const finDoc = await db.doc(`artifacts/${appId}/public/data/project_financials/${d.id}`).get().catch(() => null);
      if (!finDoc || !finDoc.exists) { skipped += 1; continue; }
      const strip = buildProjectStrip(data);
      if (!strip) continue;
      batch.update(d.ref, strip);
      pending += 1; scrubbed += 1;
      if (pending >= 300) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    logger.info(`scrubProjectEmbeddedMoney: scrubbed ${scrubbed}, skipped ${skipped} (no sibling)`);
    return { scrubbed, skipped, projects: projSnap.size };
  },
);

