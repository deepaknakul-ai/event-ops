/**
 * scripts/seed-platform.cjs
 *
 * One-time bootstrap for the SaaS platform project. Writes the platform meta
 * flag and creates the first super_admin in platform_staff (plus its hashed
 * credentials), so the `platformLogin` callable can authenticate it.
 *
 * The password is hashed with the SAME pbkdf2 scheme as functions/index.js
 * (hashPasswordNode) — see PBKDF2_ITERS / hashPasswordNode below — so the
 * stored 'v3:...' string verifies cleanly server-side.
 *
 * Usage:
 *   node scripts/seed-platform.cjs \
 *     --project <saas-project-id> \
 *     --sa <path-to-service-account.json> \
 *     --super-admin-user  <username> \
 *     --super-admin-email <email> \
 *     --super-admin-pass  <password> \
 *     [--force]     overwrite an existing super_admin / staff doc
 *     [--dry-run]   print what would be written, write nothing
 *
 * Writes (top-level platform collections on the SaaS project):
 *   platform_meta/config                        { platform_enabled, seeded_at }
 *   platform_staff/{slug}                        { name, username, email, role, ... }
 *   platform_staff/{slug}/secret/credentials     { password:<v3 hash>, updated_at }
 *
 * Exit codes:  0 = seeded (or dry-run)   1 = bad args / guard tripped / error
 */

const fs = require('fs');
const path = require('path');
const { pbkdf2, randomBytes } = require('crypto');
const { promisify } = require('util');

// firebase-admin is installed under functions/ (matches sync-to-standby.cjs).
const FN_MODULES = path.join(__dirname, '..', 'functions', 'node_modules');
const admin = require(path.join(FN_MODULES, 'firebase-admin'));

const pbkdf2Async = promisify(pbkdf2);

// ─── pbkdf2 — EXACT replica of functions/index.js hashPasswordNode ────────────
// From functions/index.js:
//   const PBKDF2_ITERS = 100000;
//   async function hashPasswordNode(plaintext) {
//     const salt = randomBytes(16);
//     const derived = await pbkdf2Async(Buffer.from(plaintext,'utf8'), salt, PBKDF2_ITERS, 32, 'sha256');
//     return `v3:${PBKDF2_ITERS}:${salt.toString('hex')}:${derived.toString('hex')}`;
//   }
// Keep these three constants and the format string byte-for-byte identical so
// the platformLogin verifier (verifyPasswordNode, v3 branch) accepts the hash.
const PBKDF2_ITERS = 100000; // MUST match functions/index.js
const PBKDF2_KEYLEN = 32; //     MUST match (derived key length in bytes)
const PBKDF2_DIGEST = 'sha256'; // MUST match
const PBKDF2_SALT_BYTES = 16; //  MUST match

async function hashPasswordNode(plaintext) {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const derived = await pbkdf2Async(
    Buffer.from(plaintext, 'utf8'),
    salt,
    PBKDF2_ITERS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST
  );
  return `v3:${PBKDF2_ITERS}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

// ─── Arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true; // boolean flag (e.g. --dry-run, --force)
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function usage(msg) {
  if (msg) console.error(`\nError: ${msg}`);
  console.error(
    `
Usage:
  node scripts/seed-platform.cjs \\
    --project <saas-project-id> \\
    --sa <path-to-service-account.json> \\
    --super-admin-user  <username> \\
    --super-admin-email <email> \\
    --super-admin-pass  <password> \\
    [--force]    overwrite an existing super_admin
    [--dry-run]  print planned writes without writing

Example:
  node scripts/seed-platform.cjs --project acme-saas-prod \\
    --sa ./saas-service-account.json \\
    --super-admin-user root --super-admin-email ops@acme.io \\
    --super-admin-pass 'S0me-strong-pass' --dry-run
`
  );
  process.exit(1);
}

// Turn a username into a stable, readable doc id; fall back to a Firestore
// auto-id if it sanitizes to nothing.
function slugify(username) {
  const slug = String(username)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));

  const project = args.project;
  const saPath = args.sa;
  const username = args['super-admin-user'];
  const email = args['super-admin-email'];
  const password = args['super-admin-pass'];
  const DRY_RUN = args['dry-run'] === true;
  const FORCE = args.force === true;

  // Validate required flags.
  if (!project) usage('--project is required');
  if (!saPath) usage('--sa is required');
  if (!username) usage('--super-admin-user is required');
  if (!email) usage('--super-admin-email is required');
  if (!password) usage('--super-admin-pass is required');
  if (typeof project !== 'string' || project === 'REPLACE_WITH_SAAS_PROJECT_ID') {
    usage('--project is not set to a real SaaS project id');
  }
  if (typeof email !== 'string' || !email.includes('@')) {
    usage('--super-admin-email does not look like an email address');
  }
  if (typeof password !== 'string' || password.length < 8) {
    usage('--super-admin-pass must be at least 8 characters');
  }

  // Load the service account.
  const saAbs = path.resolve(saPath);
  if (!fs.existsSync(saAbs)) usage(`service account file not found: ${saAbs}`);
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(fs.readFileSync(saAbs, 'utf8'));
  } catch (e) {
    usage(`could not parse service account JSON: ${e.message}`);
  }
  if (serviceAccount.project_id && serviceAccount.project_id !== project) {
    console.warn(
      `WARN  service account project_id (${serviceAccount.project_id}) ` +
        `!= --project (${project}). Proceeding, but double-check this is intended.`
    );
  }

  const docId = slugify(username);

  console.log('');
  console.log(`Platform seed  —  project: ${project}${DRY_RUN ? '  (DRY RUN)' : ''}`);
  console.log(`  service account : ${saAbs}`);
  console.log(`  super_admin     : ${username} <${email}>`);
  console.log(`  staff doc id    : platform_staff/${docId || '(auto-id)'}`);
  console.log('');

  // Initialize Admin SDK against the SaaS project.
  const app = admin.initializeApp(
    {
      credential: admin.credential.cert(serviceAccount),
      projectId: project,
    },
    'seed-platform'
  );
  const db = app.firestore();

  // Resolve the final doc id / ref (auto-id if the slug is empty).
  const staffCol = db.collection('platform_staff');
  const staffRef = docId ? staffCol.doc(docId) : staffCol.doc();
  const finalId = staffRef.id;
  const credRef = staffRef.collection('secret').doc('credentials');
  const metaRef = db.doc('platform_meta/config');

  // ── Guard: don't clobber an existing super_admin (unless --force) ───────────
  const existingSuper = await staffCol
    .where('role', '==', 'super_admin')
    .limit(5)
    .get();
  if (!existingSuper.empty && !FORCE) {
    console.error('');
    console.error('REFUSING to seed — a super_admin already exists:');
    existingSuper.forEach((d) => {
      const v = d.data() || {};
      console.error(`  platform_staff/${d.id}  (${v.username || '?'} <${v.email || '?'}>)`);
    });
    console.error('');
    console.error('  Re-run with --force to overwrite / add another super_admin.');
    console.error('');
    await app.delete().catch(() => {});
    process.exit(1);
  }

  // Also warn if we're about to overwrite the specific target doc.
  const targetExisting = await staffRef.get();
  if (targetExisting.exists && !FORCE) {
    console.error('');
    console.error(`REFUSING to seed — platform_staff/${finalId} already exists.`);
    console.error('  Re-run with --force to overwrite it.');
    console.error('');
    await app.delete().catch(() => {});
    process.exit(1);
  }

  // ── Build the payloads ──────────────────────────────────────────────────────
  const now = admin.firestore.FieldValue.serverTimestamp();
  const passwordHash = await hashPasswordNode(password);

  const metaData = { platform_enabled: true, seeded_at: now };
  const staffData = {
    name: 'Super Admin',
    username,
    email,
    role: 'super_admin',
    regions: [],
    assigned_tenants: [],
    status: 'active',
    created_at: now,
  };
  const credData = { password: passwordHash, updated_at: now };

  // Show a redacted preview of the hash (it's one-way, but keep logs tidy).
  const hashPreview = `${passwordHash.slice(0, 24)}...(${passwordHash.length} chars)`;

  console.log('Planned writes:');
  console.log(`  platform_meta/config`);
  console.log(`      ${JSON.stringify({ ...metaData, seeded_at: '<serverTimestamp>' })}`);
  console.log(`  platform_staff/${finalId}`);
  console.log(`      ${JSON.stringify({ ...staffData, created_at: '<serverTimestamp>' })}`);
  console.log(`  platform_staff/${finalId}/secret/credentials`);
  console.log(`      { password: '${hashPreview}', updated_at: '<serverTimestamp>' }`);
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN — nothing written.');
    await app.delete().catch(() => {});
    process.exit(0);
  }

  // ── Write (meta + staff + credentials) ──────────────────────────────────────
  // meta uses merge so a re-seed doesn't wipe unrelated meta fields; staff and
  // credentials are set outright (guarded above / --force).
  await metaRef.set(metaData, { merge: true });
  await staffRef.set(staffData);
  await credRef.set(credData);

  console.log('Seeded successfully:');
  console.log(`  platform_meta/config            (platform_enabled: true)`);
  console.log(`  platform_staff/${finalId}         (super_admin: ${username})`);
  console.log(`  platform_staff/${finalId}/secret/credentials   (v3 pbkdf2 hash)`);
  console.log('');
  await app.delete().catch(() => {});
  process.exit(0);
})().catch((e) => {
  console.error('\nSEED ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
