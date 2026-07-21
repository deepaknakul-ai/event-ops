/**
 * One-way sync of all tenant data from the primary project (terms-a005e) to
 * the standby project (eventops-68df9): every Firestore collection under
 * artifacts/{APP_ID}/public/data (incl. chat message subcollections), the
 * meta/active_apps registry, and all Storage files under the app prefixes.
 *
 * Run:  node scripts/sync-to-standby.cjs [--dry-run]
 *
 * Auth: reads ./service-account.json (primary, read side) and the firebase
 * CLI's stored user credential (standby, write side — the logged-in account
 * must own the standby project). No JSON intermediate: Firestore-to-Firestore
 * copy preserves Timestamps and other native types exactly.
 *
 * Existing standby docs at the same IDs are overwritten (set, no merge).
 * Docs that exist ONLY on the standby are left alone — run a wipe first via
 * the standby's Admin > Restore (Exact mode) if a clean mirror is required.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const FN_MODULES = path.join(__dirname, '..', 'functions', 'node_modules');
const admin = require(path.join(FN_MODULES, 'firebase-admin'));

const APP_ID = 'TERMS 1.0.0';
const SRC_PROJECT = 'terms-a005e';
const DST_PROJECT = 'eventops-68df9';
const SRC_BUCKET = 'terms-a005e.firebasestorage.app';
const DST_BUCKET = 'eventops-68df9.firebasestorage.app';
const DATA_PATH = `artifacts/${APP_ID}/public/data`;
// Subcollections to descend into, keyed by parent collection (mirror of
// SUB_PARENTS in functions/backup.js).
const SUB_PARENTS = { chat_channels: ['messages'] };
const STORAGE_PREFIXES = [
  `artifacts/${APP_ID}/`,
  `expense-proofs/${APP_ID}/`,
  `purchase-invoices/${APP_ID}/`,
  `reimbursable-proofs/${APP_ID}/`,
];
// firebase-tools' public OAuth client (embedded in the CLI itself).
const CLI_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const DRY = process.argv.includes('--dry-run');

// The admin Firestore client only accepts cert or Application Default
// Credentials — a raw refreshToken credential is rejected. So the CLI user
// token is written as an ADC-format authorized_user file and exposed via
// GOOGLE_APPLICATION_CREDENTIALS (deleted on exit).
function writeAdcFromCli() {
  const cfg = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const rt = store.tokens && store.tokens.refresh_token;
  if (!rt) throw new Error('No firebase CLI login found — run `firebase login` first.');
  const adcPath = path.join(os.tmpdir(), `standby-sync-adc-${process.pid}.json`);
  fs.writeFileSync(adcPath, JSON.stringify({
    type: 'authorized_user',
    client_id: CLI_CLIENT_ID,
    client_secret: CLI_CLIENT_SECRET,
    refresh_token: rt,
    quota_project_id: DST_PROJECT,
  }));
  return adcPath;
}

const ADC_PATH = writeAdcFromCli();
process.env.GOOGLE_APPLICATION_CREDENTIALS = ADC_PATH;
process.on('exit', () => { try { fs.unlinkSync(ADC_PATH); } catch { /* already gone */ } });

(async () => {
  const src = admin.initializeApp({
    credential: admin.credential.cert(require(path.join(__dirname, '..', 'service-account.json'))),
    projectId: SRC_PROJECT,
    storageBucket: SRC_BUCKET,
  }, 'src');
  const dst = admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: DST_PROJECT,
    storageBucket: DST_BUCKET,
  }, 'dst');
  const sdb = src.firestore();
  const ddb = dst.firestore();

  console.log(`Sync ${SRC_PROJECT} -> ${DST_PROJECT}${DRY ? ' (DRY RUN)' : ''}\n`);

  // ── Firestore ─────────────────────────────────────────────────────────────
  const cols = await sdb.doc(DATA_PATH).listCollections();
  let grandDocs = 0;
  for (const col of cols) {
    let copied = 0, subCopied = 0, cursor = null;
    for (;;) {
      let q = col.orderBy(admin.firestore.FieldPath.documentId()).limit(300);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      let batch = ddb.batch(); let pending = 0;
      const flush = async () => { if (pending) { if (!DRY) await batch.commit(); batch = ddb.batch(); pending = 0; } };
      for (const d of snap.docs) {
        batch.set(ddb.doc(`${DATA_PATH}/${col.id}/${d.id}`), d.data());
        pending += 1; copied += 1;
        if (pending >= 400) await flush();
        for (const subName of SUB_PARENTS[col.id] || []) {
          const subSnap = await d.ref.collection(subName).get();
          for (const sd of subSnap.docs) {
            batch.set(ddb.doc(`${DATA_PATH}/${col.id}/${d.id}/${subName}/${sd.id}`), sd.data());
            pending += 1; subCopied += 1;
            if (pending >= 400) await flush();
          }
        }
      }
      await flush();
      cursor = snap.docs[snap.docs.length - 1].id;
      if (snap.size < 300) break;
    }
    grandDocs += copied + subCopied;
    console.log(`  ${col.id}: ${copied} docs${subCopied ? ` + ${subCopied} subdocs` : ''}`);
  }
  if (!DRY) await ddb.doc('meta/active_apps').set(
    { ids: admin.firestore.FieldValue.arrayUnion(APP_ID) }, { merge: true });
  console.log(`Firestore total: ${grandDocs} docs. meta/active_apps registered.\n`);

  // ── Storage ───────────────────────────────────────────────────────────────
  // The user credential has access to BOTH buckets, so GCS server-side copy
  // (rewrite) moves bytes without downloading them to this machine.
  const { Storage } = require(path.join(FN_MODULES, '@google-cloud', 'storage'));
  const gcs = new Storage({ keyFilename: ADC_PATH, projectId: DST_PROJECT });
  const srcBucket = gcs.bucket(SRC_BUCKET);
  const dstBucket = gcs.bucket(DST_BUCKET);
  let filesCopied = 0, bytes = 0; const fileFails = [];
  for (const prefix of STORAGE_PREFIXES) {
    const [files] = await srcBucket.getFiles({ prefix });
    for (const f of files) {
      try {
        if (!DRY) await f.copy(dstBucket.file(f.name));
        filesCopied += 1; bytes += Number(f.metadata.size || 0);
      } catch (e) { fileFails.push(`${f.name}: ${e.message}`); }
    }
    console.log(`  storage ${prefix}: done (${files.length} files)`);
  }
  console.log(`Storage total: ${filesCopied} files, ${(bytes / 1048576).toFixed(1)} MB${fileFails.length ? `, FAILED: ${fileFails.length}` : ''}`);
  fileFails.slice(0, 10).forEach((m) => console.log('   FAIL', m));

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log('\nVerification (doc counts on standby):');
  let mismatches = 0;
  for (const col of cols) {
    const [a, b] = await Promise.all([
      sdb.collection(`${DATA_PATH}/${col.id}`).count().get(),
      ddb.collection(`${DATA_PATH}/${col.id}`).count().get(),
    ]);
    const sa = a.data().count, sb = b.data().count;
    if (sb < sa) { mismatches += 1; console.log(`  MISMATCH ${col.id}: src=${sa} dst=${sb}`); }
  }
  console.log(mismatches ? `${mismatches} collection(s) mismatched` : '  all collections: standby >= primary. OK');
  process.exit(mismatches ? 1 : 0);
})().catch((e) => { console.error('SYNC ERROR:', e.message); process.exit(1); });
