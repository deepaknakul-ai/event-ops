/**
 * Control-plane backup — exports the top-level platform_* tree that the normal
 * per-tenant backup (adminExportData, artifacts/{code}/...) does NOT cover:
 *   platform_meta, platform_staff (+ each staff's secret/credentials subdoc),
 *   platform_tenants, platform_audit_logs.
 *
 * These are small but load-bearing: lose platform_staff and no one can sign into
 * the console; lose platform_tenants and every tenant's plan/status/scope is gone.
 *
 * Usage:
 *   node scripts/backup-platform.cjs --project <id> --sa <service-account.json> [--out <dir>]
 *
 * WARNING: the output contains platform_staff/<id>/secret/credentials password
 * hashes. Store the file as securely as a service-account key.
 *
 * Types survive via the shared codec (functions/backup.js) — Timestamps etc. are
 * tagged, so a restore round-trips exactly.
 */
const fs = require('fs');
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
const { createCodec } = require(path.join(__dirname, '..', 'functions', 'backup.js'));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const project = arg('project');
const saPath = arg('sa');
const outDir = arg('out', path.join(process.cwd(), `platform-backup-${new Date().toISOString().slice(0, 10)}`));

if (!project || !saPath) {
  console.error('Usage: node scripts/backup-platform.cjs --project <id> --sa <service-account.json> [--out <dir>]');
  process.exit(1);
}

const COLLECTIONS = ['platform_meta', 'platform_staff', 'platform_tenants', 'platform_audit_logs'];
// Subcollections to descend into, keyed by parent collection.
const SUBCOLLECTIONS = { platform_staff: ['secret'] };

(async () => {
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  if (sa.project_id !== project) {
    console.warn(`WARNING: service account project_id (${sa.project_id}) != --project (${project})`);
  }
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: project });
  const db = admin.firestore();
  const codec = createCodec({ Timestamp: admin.firestore.Timestamp });

  const out = { _meta: { format: 'platform-backup', version: 1, project, exported_at: new Date().toISOString() }, data: {} };
  let grand = 0;

  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).get();
    const docs = [];
    for (const d of snap.docs) {
      const entry = { id: d.id, d: codec.encode(d.data()) };
      for (const sub of SUBCOLLECTIONS[col] || []) {
        const subSnap = await d.ref.collection(sub).get();
        if (!subSnap.empty) {
          entry.s = entry.s || {};
          entry.s[sub] = subSnap.docs.map((sd) => ({ id: sd.id, d: codec.encode(sd.data()) }));
        }
      }
      docs.push(entry);
    }
    out.data[col] = docs;
    grand += docs.length;
    console.log(`  ${col}: ${docs.length} doc(s)`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'platform.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nControl-plane backup written: ${file}`);
  console.log(`  ${grand} docs across ${COLLECTIONS.length} collections.`);
  console.log('  NOTE: contains staff password hashes — store securely.');
  process.exit(0);
})().catch((e) => { console.error('BACKUP ERROR:', e.message); process.exit(1); });
