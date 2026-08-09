/**
 * scripts/backup-firestore.cjs
 *
 * Dumps every collection under
 *   artifacts/TERMS 1.0.0/public/data/{collection}
 * to  ./firestore-backup-{date}/{collection}.json
 *
 * Usage:
 *   node scripts/backup-firestore.cjs
 *   node scripts/backup-firestore.cjs --dry-run   (list collections only)
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ID = 'terms-a005e';
const APP_ID     = 'TERMS 1.0.0';

// Collections to back up (must match Firestore structure)
const COLLECTIONS = [
  'clients',
  'inventory',
  'projects',
  'employees',
  'expenses',
  'payments',
  'payouts',
  'vendor_payments',
  'counters',
  'settings',
  'journal_entries',
  'opening_balances',
  // FY-close writes fiscal_year_closings + opening_balances + a closing voucher in
  // journal_entries. All three must be in the dump for a close to be reversible.
  'fiscal_year_closings',
  'configurations',
  'tax_invoices',
  'purchase_invoices',
  'audit_logs',
  'inventory_movements',
  'party_accounts',
  'users',
];

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Option A: set GOOGLE_APPLICATION_CREDENTIALS env variable to your service-account JSON path.
// Option B: set FIREBASE_SERVICE_ACCOUNT env variable to the JSON string.
// Option C: uses Application Default Credentials if you've run `gcloud auth application-default login`.
let app;
try {
  const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saEnv) {
    const sa = JSON.parse(saEnv);
    app = initializeApp({ credential: cert(sa), projectId: PROJECT_ID });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    app = initializeApp({ projectId: PROJECT_ID });
  } else {
    // Try Application Default Credentials
    app = initializeApp({ projectId: PROJECT_ID });
  }
} catch (err) {
  console.error('❌  Firebase init failed:', err.message);
  console.error('    Set GOOGLE_APPLICATION_CREDENTIALS to your service-account key JSON path.');
  process.exit(1);
}

const db = getFirestore(app);
const basePath = ['artifacts', APP_ID, 'public', 'data'];

// ─── Output dir ───────────────────────────────────────────────────────────────
const dateStr  = new Date().toISOString().slice(0, 10);
const outDir   = path.join(process.cwd(), `firestore-backup-${dateStr}`);
if (!DRY_RUN) fs.mkdirSync(outDir, { recursive: true });

// ─── Backup ───────────────────────────────────────────────────────────────────
async function backupCollection(name) {
  const colRef = db.collection(basePath.join('/') + '/' + name);
  const snap   = await colRef.get();
  if (snap.empty) {
    console.log(`  ⚪ ${name}: empty`);
    return 0;
  }
  const docs = {};
  snap.forEach(d => { docs[d.id] = d.data(); });
  if (!DRY_RUN) {
    fs.writeFileSync(
      path.join(outDir, `${name}.json`),
      JSON.stringify(docs, null, 2),
      'utf8'
    );
  }
  console.log(`  ✅ ${name}: ${snap.size} doc${snap.size === 1 ? '' : 's'}`);
  return snap.size;
}

(async () => {
  console.log(`\n🗄️  Firestore backup  —  project: ${PROJECT_ID}`);
  console.log(`    path  : artifacts/${APP_ID}/public/data/`);
  console.log(`    output: ${DRY_RUN ? '(dry-run, no files written)' : outDir}`);
  console.log('');

  // Discover collections LIVE rather than trusting the hardcoded list. A static
  // list silently drifts as the schema grows: a real dump taken from it was
  // missing 17 collections, including project_financials (every project's money,
  // moved there by the field-split scrub), chart_of_accounts, inventory_financials
  // and all of payroll — i.e. it could not have restored the books. COLLECTIONS is
  // kept only as a floor, so a collection that is momentarily empty still gets a file.
  let discovered = [];
  try {
    discovered = (await db.doc(basePath.join('/')).listCollections()).map((c) => c.id);
  } catch (err) {
    console.warn(`⚠️  Could not enumerate collections (${err.message}); falling back to the static list.`);
  }
  const targets = [...new Set([...COLLECTIONS, ...discovered])].sort();
  const extra = discovered.filter((c) => !COLLECTIONS.includes(c));
  if (extra.length) console.log(`    discovered ${extra.length} collection(s) beyond the static list: ${extra.join(', ')}\n`);

  let total = 0;
  for (const col of targets) {
    try {
      total += await backupCollection(col);
    } catch (err) {
      console.error(`  ❌ ${col}: ${err.message}`);
    }
  }

  console.log(`\n🏁  Done — ${total} total documents backed up.`);
  if (!DRY_RUN) console.log(`    Files written to: ${outDir}`);
  process.exit(0);
})();
