/**
 * Cloud Functions for rental-ops.
 *
 * Scheduled poster — runs every day at 01:00 IST. App discovery uses an
 * explicit registry doc at `meta/active_apps` (preferred) and falls back to
 * a collectionGroup scan. Idempotent: skips drafts that already have a
 * matching `journal_entries` doc with `scheduled_from_draft == draftId`.
 *
 * Callables:
 *   - runScheduledDraftsNow(appIds?: string[]) → admin-only, manual trigger.
 *   - runRecurringTemplatesNow(appIds?: string[]) → admin-only, generates
 *     draft journal entries from `recurring_rules` with `template_id` set.
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

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
  // Preferred: explicit registry doc. Schema: { ids: ['app-a', 'app-b', ...] }
  try {
    const reg = await db.doc('meta/active_apps').get();
    if (reg.exists) {
      const ids = reg.data().ids;
      if (Array.isArray(ids) && ids.length) return ids.filter(Boolean);
    }
  } catch (err) {
    logger.warn('Failed to read meta/active_apps; falling back to scan', err);
  }
  // Fallback: collectionGroup scan over journal_drafts.
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
  // Drafts with non-empty schedule_post_on <= today AND not already on hold.
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
    // Approval gate: do not auto-post drafts that still need approval.
    if (draft.requires_approval && draft.approval_status !== 'approved') {
      skipped += 1;
      logger.info(`[${appId}] Draft ${docSnap.id} skipped — pending approval`);
      continue;
    }
    // Idempotency: if a journal_entries doc already references this draft, skip.
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

async function processRecurringTemplates(appId, today) {
  const rulesCol = db.collection(`artifacts/${appId}/public/data/recurring_rules`);
  const tplOnly = await rulesCol.where('template_id', '>', '').get();
  if (tplOnly.empty) return { drafted: 0 };
  let drafted = 0;
  for (const ruleSnap of tplOnly.docs) {
    const rule = { id: ruleSnap.id, ...ruleSnap.data() };
    if (rule.active === false) continue;
    const runs = rulesDueRuns(rule, today);
    if (!runs.length) continue;
    let tpl;
    try {
      const tplSnap = await db.doc(`artifacts/${appId}/public/data/journal_templates/${rule.template_id}`).get();
      if (!tplSnap.exists) continue;
      tpl = tplSnap.data();
    } catch { continue; }
    const succeededRuns = [];
    for (const runIso of runs) {
      // Idempotency: only one draft per (rule, runDate).
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
        // Do not advance lastRunDate past a failed run — it will be retried
        // on the next invocation so we never silently lose a scheduled draft.
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
async function assertAdmin(auth, appId) {
  if (!auth) throw new HttpsError('unauthenticated', 'Must be signed in');
  const claimRole = auth.token && auth.token.role;
  if (claimRole === 'admin') return;
  if (!appId) throw new HttpsError('invalid-argument', 'appId required');
  // Two possible role locations: custom collection userRoles/{uid} OR the
  // employees collection used by client-side rules.
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

// Return the subset of `appIds` where `auth` is an admin. Never throws for
// unauthorised apps — it simply drops them so a compromised admin in one
// tenant cannot reach data in another.
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
