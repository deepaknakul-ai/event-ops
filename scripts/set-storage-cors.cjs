/**
 * Set the CORS policy on the primary and standby Storage buckets.
 *
 * Run:  node scripts/set-storage-cors.cjs
 *
 * Why: Admin Tools' storage backup downloads every attachment in the browser
 * via getBlob() — a direct XHR to firebasestorage.googleapis.com. Without a
 * bucket CORS policy the browser blocks the response ("No
 * 'Access-Control-Allow-Origin' header"), so the backup zip comes out empty.
 * Restore uploads (uploadBytes) ride the same policy. Idempotent — safe to
 * re-run; edit ORIGINS when a custom domain is added.
 *
 * Auth: same split as sync-to-standby.cjs — ./service-account.json for the
 * primary bucket, the firebase CLI's stored user credential (ADC-format temp
 * file) for the standby.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const FN_MODULES = path.join(__dirname, '..', 'functions', 'node_modules');
const admin = require(path.join(FN_MODULES, 'firebase-admin'));

const PRIMARY_PROJECT = 'terms-a005e';
const STANDBY_PROJECT = 'eventops-68df9';
const PRIMARY_BUCKET = 'terms-a005e.firebasestorage.app';
const STANDBY_BUCKET = 'eventops-68df9.firebasestorage.app';

// firebase-tools' public OAuth client (embedded in the CLI itself).
const CLI_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const ORIGINS = [
  'https://terms-a005e.web.app',
  'https://terms-a005e.firebaseapp.com',
  'https://eventops-68df9.web.app',
  'https://eventops-68df9.firebaseapp.com',
  'http://localhost:5173', // vite dev
  'http://localhost:4173', // vite preview
  'capacitor://localhost', // mobile shell (iOS)
  'http://localhost',      // mobile shell (Android)
  'https://localhost',
];
const CORS = [{
  origin: ORIGINS,
  method: ['GET', 'HEAD', 'PUT', 'POST'],
  responseHeader: ['*'],
  maxAgeSeconds: 3600,
}];

function writeAdcFromCli(quotaProject) {
  const cfg = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const rt = store.tokens && store.tokens.refresh_token;
  if (!rt) throw new Error('No firebase CLI login found — run `firebase login` first.');
  const adcPath = path.join(os.tmpdir(), `set-cors-adc-${process.pid}.json`);
  fs.writeFileSync(adcPath, JSON.stringify({
    type: 'authorized_user',
    client_id: CLI_CLIENT_ID,
    client_secret: CLI_CLIENT_SECRET,
    refresh_token: rt,
    quota_project_id: quotaProject,
  }));
  return adcPath;
}

(async () => {
  const primary = admin.initializeApp({
    credential: admin.credential.cert(require(path.join(__dirname, '..', 'service-account.json'))),
    projectId: PRIMARY_PROJECT,
  }, 'primary');
  await primary.storage().bucket(PRIMARY_BUCKET).setCorsConfiguration(CORS);
  console.log(`${PRIMARY_BUCKET}: CORS set (${ORIGINS.length} origins)`);

  const adcPath = writeAdcFromCli(STANDBY_PROJECT);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  try {
    const standby = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: STANDBY_PROJECT,
    }, 'standby');
    await standby.storage().bucket(STANDBY_BUCKET).setCorsConfiguration(CORS);
    console.log(`${STANDBY_BUCKET}: CORS set (${ORIGINS.length} origins)`);
  } finally {
    try { fs.unlinkSync(adcPath); } catch { /* already gone */ }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
