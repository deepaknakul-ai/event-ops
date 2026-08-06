/**
 * Migrate a PRIVATE-edition customer INTO the SaaS platform as a tenant.
 *
 * Copies a source project's single-company dataset
 * (artifacts/{sourceAppId}/public/data/**) into the SaaS project under a new
 * tenant code (artifacts/{code}/public/data/**), provisions the platform_tenants
 * record + entitlements, and registers the tenant for cron. Non-destructive to
 * the source — a botched run is rolled back by simply not cutting over (the
 * customer keeps using their private project untouched).
 *
 * AUTH IDENTITY NOTE: verifyLogin mints custom tokens with uid == the EMPLOYEE
 * DOC ID (not a Firebase Auth uid). So copying employees/{id} + users/{id} +
 * settings/security (with their password hashes) and preserving doc ids fully
 * preserves every login on the SaaS side — no Firebase Auth user migration is
 * needed.
 *
 * Usage:
 *   node scripts/migrate-to-saas.cjs \
 *     --source-project <id> --source-sa <sa.json> --source-app-id "TERMS 1.0.0" \
 *     --saas-project <id>   --saas-sa <sa.json> \
 *     --code <tenant-code>  --name "Company Name" --region India --plan standard \
 *     [--include-storage] [--dry-run]
 *
 * Storage copy routes bytes through this machine (download src -> upload dst),
 * since the two projects are owned separately; off by default.
 */
const path = require('path');
const fs = require('fs');
const FN = path.join(__dirname, '..', 'functions', 'node_modules');
const admin = require(path.join(FN, 'firebase-admin'));
const { normalizeRegion, resolveEntitlements } = require(path.join(__dirname, '..', 'functions', 'platform.js'));

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const WITH_STORAGE = process.argv.includes('--include-storage');

const srcProject = arg('source-project');
const srcSaPath = arg('source-sa');
const srcAppId = arg('source-app-id', 'TERMS 1.0.0');
const dstProject = arg('saas-project');
const dstSaPath = arg('saas-sa');
const code = arg('code');
const name = arg('name');
const region = arg('region');
const plan = arg('plan', 'standard');

function fail(m) { console.error('ERROR: ' + m); process.exit(1); }
if (!srcProject || !srcSaPath || !dstProject || !dstSaPath || !code || !name || !region) {
  fail('Required: --source-project --source-sa --saas-project --saas-sa --code --name --region');
}
if (!/^[a-z0-9-]{3,30}$/.test(code)) fail('--code must be a slug of 3–30 chars (a–z, 0–9, hyphen)');
const regionNorm = normalizeRegion(region);
if (!regionNorm) fail(`--region invalid; must normalize to a canonical region (got '${region}')`);
if (!['trial', 'standard', 'premium'].includes(plan)) fail('--plan must be trial|standard|premium');

const SUB_PARENTS = { chat_channels: ['messages'] };
const STORAGE_PREFIXES = ['artifacts', 'expense-proofs', 'purchase-invoices', 'reimbursable-proofs'];

(async () => {
  const src = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(srcSaPath, 'utf8'))), projectId: srcProject }, 'src');
  const dst = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(dstSaPath, 'utf8'))), projectId: dstProject }, 'dst');
  const sdb = src.firestore();
  const ddb = dst.firestore();
  const SRC = `artifacts/${srcAppId}/public/data`;
  const DST = `artifacts/${code}/public/data`;

  console.log(`Migrate  ${srcProject}[${srcAppId}]  ->  ${dstProject}[${code}]${DRY ? '  (DRY RUN)' : ''}\n`);

  // ── Collision guard ─────────────────────────────────────────────────────────
  if ((await ddb.doc(`platform_tenants/${code}`).get()).exists) fail(`platform_tenants/${code} already exists on ${dstProject}`);
  if ((await ddb.doc(`artifacts/${code}`).listCollections()).length !== 0) fail(`artifacts/${code} already has data on ${dstProject}`);
  if (!(await sdb.doc('platform_meta/config').get().then(() => true).catch(() => true))) { /* noop */ }

  // ── Firestore copy (re-prefixed, native types preserved) ────────────────────
  const cols = await sdb.doc(SRC).listCollections();
  if (cols.length === 0) fail(`no data found at ${SRC} on the source project — check --source-app-id`);
  let grand = 0;
  const counts = {};
  for (const col of cols) {
    let copied = 0; let sub = 0; let cursor = null;
    for (;;) {
      let q = col.orderBy(admin.firestore.FieldPath.documentId()).limit(300);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      let batch = ddb.batch(); let pending = 0;
      const flush = async () => { if (pending) { if (!DRY) await batch.commit(); batch = ddb.batch(); pending = 0; } };
      for (const d of snap.docs) {
        batch.set(ddb.doc(`${DST}/${col.id}/${d.id}`), d.data());
        pending += 1; copied += 1;
        if (pending >= 400) await flush();
        for (const subName of SUB_PARENTS[col.id] || []) {
          const subSnap = await d.ref.collection(subName).get();
          for (const sd of subSnap.docs) {
            batch.set(ddb.doc(`${DST}/${col.id}/${d.id}/${subName}/${sd.id}`), sd.data());
            pending += 1; sub += 1;
            if (pending >= 400) await flush();
          }
        }
      }
      await flush();
      cursor = snap.docs[snap.docs.length - 1].id;
      if (snap.size < 300) break;
    }
    counts[col.id] = copied;
    grand += copied + sub;
    console.log(`  ${col.id}: ${copied}${sub ? ` (+${sub} subdocs)` : ''}`);
  }
  console.log(`Firestore: ${grand} docs across ${cols.length} collections.\n`);

  // ── Provision the tenant on the platform ────────────────────────────────────
  const nowISO = new Date().toISOString();
  const tenant = {
    name: String(name).trim(), code, region: regionNorm, status: 'active', plan,
    trial_expires_on: null, assigned_managers: [],
    migrated_from: { project: srcProject, app_id: srcAppId, at: nowISO },
    created_at: nowISO, created_by: 'migration',
  };
  if (!DRY) {
    await ddb.doc(`platform_tenants/${code}`).set(tenant);
    await ddb.doc(`${DST}/settings/entitlements`).set({ ...resolveEntitlements(tenant), updated_at: nowISO });
    await ddb.doc('meta/active_apps').set({ ids: admin.firestore.FieldValue.arrayUnion(code), last_seen: { [code]: nowISO } }, { merge: true });
  }
  console.log(`Provisioned platform_tenants/${code} (plan=${plan}, region=${regionNorm}) + entitlements + cron registration.\n`);

  // ── Storage (optional; download src -> upload dst, re-prefixed) ──────────────
  if (WITH_STORAGE) {
    const { Storage } = require(path.join(FN, '@google-cloud', 'storage'));
    const srcGcs = new Storage({ keyFilename: srcSaPath, projectId: srcProject });
    const dstGcs = new Storage({ keyFilename: dstSaPath, projectId: dstProject });
    const srcBucket = srcGcs.bucket(`${srcProject}.firebasestorage.app`);
    const dstBucket = dstGcs.bucket(`${dstProject}.firebasestorage.app`);
    let files = 0; let bytes = 0; const fails = [];
    for (const p of STORAGE_PREFIXES) {
      const [list] = await srcBucket.getFiles({ prefix: `${p}/${srcAppId}/` });
      for (const f of list) {
        const destName = f.name.replace(`${p}/${srcAppId}/`, `${p}/${code}/`);
        try {
          if (!DRY) {
            const [buf] = await f.download();
            await dstBucket.file(destName).save(buf, { contentType: f.metadata.contentType });
          }
          files += 1; bytes += Number(f.metadata.size || 0);
        } catch (e) { fails.push(`${f.name}: ${e.message}`); }
      }
      console.log(`  storage ${p}/: ${list.length} file(s)`);
    }
    console.log(`Storage: ${files} files, ${(bytes / 1048576).toFixed(1)} MB${fails.length ? `, FAILED ${fails.length}` : ''}`);
    fails.slice(0, 10).forEach((m) => console.log('   FAIL', m));
  } else {
    console.log('Storage: SKIPPED (pass --include-storage to copy attachments).\n');
  }

  // ── Verify Firestore counts ─────────────────────────────────────────────────
  console.log('Verification (source vs SaaS doc counts):');
  let mism = 0;
  for (const col of cols) {
    const [a, b] = await Promise.all([
      sdb.collection(`${SRC}/${col.id}`).count().get(),
      ddb.collection(`${DST}/${col.id}`).count().get(),
    ]);
    const sa = a.data().count; const sb = DRY ? sa : b.data().count;
    if (sb < sa) { mism += 1; console.log(`  MISMATCH ${col.id}: src=${sa} saas=${sb}`); }
  }
  console.log(mism ? `  ${mism} collection(s) short — investigate.` : '  all collections: SaaS >= source. OK');

  console.log('\n──────────────────────────────────────────────');
  console.log(DRY ? 'DRY RUN — nothing was written.' : `Migration complete. Tenant '${code}' is live on ${dstProject}.`);
  console.log('CUTOVER: the customer signs in at the SaaS URL with company code');
  console.log(`  "${code}" and their EXISTING username + password (admin owner works too).`);
  console.log('  The source private project is untouched — revert by simply not switching.');
  console.log('  If migrating attachments, re-run with --include-storage (or copy via gsutil).');
  console.log('──────────────────────────────────────────────');
  process.exit(mism ? 1 : 0);
})().catch((e) => { console.error('MIGRATION ERROR:', e.message); process.exit(1); });
