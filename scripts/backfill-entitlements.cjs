/**
 * One-time backfill: write settings/entitlements for tenants that predate the
 * entitlements feature. New tenants get it at creation and on every plan/override
 * change; this catches the ones created before. Idempotent — safe to re-run.
 *
 * Usage: node scripts/backfill-entitlements.cjs --project <id> --sa <sa.json> [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
const { resolveEntitlements } = require(path.join(__dirname, '..', 'functions', 'platform.js'));

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const project = arg('project');
const saPath = arg('sa');
const dry = process.argv.includes('--dry-run');
if (!project || !saPath) { console.error('Usage: --project <id> --sa <sa.json> [--dry-run]'); process.exit(1); }

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(saPath, 'utf8'))), projectId: project });
  const db = admin.firestore();
  const snap = await db.collection('platform_tenants').get();
  console.log(`${snap.size} tenant(s)${dry ? ' (DRY RUN)' : ''}`);
  for (const doc of snap.docs) {
    const ent = resolveEntitlements({ id: doc.id, ...doc.data() });
    console.log(`  ${doc.id}: plan=${ent.plan} whatsapp=${ent.features.whatsapp_copilot} ai=${ent.features.ai_accountant} max_users=${ent.limits.max_users}`);
    if (!dry) {
      await db.doc(`artifacts/${doc.id}/public/data/settings/entitlements`).set({ ...ent, updated_at: new Date().toISOString() });
    }
  }
  console.log(dry ? 'DRY RUN — nothing written.' : 'Backfill complete.');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
