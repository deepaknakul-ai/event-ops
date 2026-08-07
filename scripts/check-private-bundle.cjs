/**
 * scripts/check-private-bundle.cjs
 *
 * Guardrail: proves the PRIVATE build never ships SaaS / platform code.
 *
 * Run this immediately AFTER a private build (`npm run build` or
 * `npm run build:backup`), while dist/ still holds the private output:
 *
 *   npm run build && node scripts/check-private-bundle.cjs
 *   (or via the package script:  npm run verify:private-bundle)
 *
 * It scans every JavaScript chunk under dist/assets and FAILS (exit 1) if any
 * platform-only marker leaked into the bundle. Platform code lives in
 * src/platform/* and is guarded by `IS_SAAS` (src/utils/edition.js); in a
 * private build `IS_SAAS` folds to a literal `false`, so Vite should
 * dead-code-eliminate every platform branch and lazy chunk. If a marker shows
 * up here, a guard was missed and private would ship tenant-platform code.
 *
 * Why string literals: Firestore collection names ('platform_staff',
 * 'platform_tenants'), callable names ('platformLogin', 'platformSupportAccess')
 * and UI text ('Company code') survive minification because they are string
 * constants. Identifiers such as `PlatformApp` CAN be renamed by the minifier,
 * so its absence is not proof of anything — but its presence as a raw string is
 * still a red flag, so we check for it too. The reliable signal is the set of
 * string literals above.
 *
 * Exit codes:  0 = clean (PASS)   1 = leak found, or dist/ missing (FAIL)
 */

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(DIST, 'assets');

// Markers that must NEVER appear in a private bundle.
const FORBIDDEN_MARKERS = [
  'platform_staff',           // platform staff collection (survives minification)
  'platform_tenants',         // tenant registry collection (survives minification)
  'platform_credit_scores',   // cross-tenant credit bureau collection (platform-only)
  'platformLogin',            // platform login callable id (string literal — reliable)
  'platformSupportAccess',    // support-impersonation callable id (string literal)
  'platformListCreditScores', // credit-score callable id (lives only in the platform chunk)
  'Company Code',             // SaaS login form label (JSX text — survives)
];
// NOTE: 'credit_labels' is deliberately NOT forbidden — it is a tenant settings
// doc the SHARED app (src/App.jsx / Clients.jsx) reads in both editions, gated by
// IS_SAAS at runtime. Its presence in the private bundle is expected and benign,
// exactly like settings/entitlements.

// The private appId string. Its presence proves the app-id constant folded in
// correctly. Absent => warn only (a future minifier could, in theory, mangle
// it — but it is a plain string constant today, so absence is suspicious).
const REQUIRED_APP_ID = 'TERMS 1.0.0';

// ─── Helpers ────────────────────────────────────────────────────────────────
function failHard(lines) {
  console.error('');
  (Array.isArray(lines) ? lines : [lines]).forEach((l) => console.error(l));
  console.error('');
  process.exit(1);
}

// Collect every *.js file under a directory (recursive, defensive against
// nested chunk folders even though Vite normally emits a flat assets/).
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// ─── Pre-flight: dist must exist ──────────────────────────────────────────────
if (!fs.existsSync(DIST) || !fs.statSync(DIST).isDirectory()) {
  failHard([
    'FAIL  dist/ not found — nothing to check.',
    `      Looked in: ${DIST}`,
    '      Run a private build first, e.g.:  npm run build',
  ]);
}
if (!fs.existsSync(ASSETS) || !fs.statSync(ASSETS).isDirectory()) {
  failHard([
    'FAIL  dist/assets/ not found — the build looks incomplete.',
    `      Looked in: ${ASSETS}`,
    '      Run a private build first, e.g.:  npm run build',
  ]);
}

const jsFiles = collectJsFiles(ASSETS);
if (jsFiles.length === 0) {
  failHard([
    'FAIL  No .js files under dist/assets/ — the build looks incomplete.',
    '      Run a private build first, e.g.:  npm run build',
  ]);
}

// ─── Scan ───────────────────────────────────────────────────────────────────
console.log('Private bundle guardrail — scanning dist/assets for platform code');
console.log(`  assets dir : ${ASSETS}`);
console.log(`  js chunks  : ${jsFiles.length}`);
console.log('');

let totalBytes = 0;
let appIdFound = false;
const offenders = []; // { file, markers: [...] }

for (const file of jsFiles) {
  const buf = fs.readFileSync(file);
  totalBytes += buf.length;
  const text = buf.toString('utf8');

  const hits = FORBIDDEN_MARKERS.filter((m) => text.includes(m));
  if (hits.length > 0) {
    offenders.push({ file: path.relative(ROOT, file), markers: hits });
  }
  if (!appIdFound && text.includes(REQUIRED_APP_ID)) {
    appIdFound = true;
  }
}

const mb = (totalBytes / 1048576).toFixed(2);

// ─── Verdict ──────────────────────────────────────────────────────────────────
if (offenders.length > 0) {
  const lines = [
    'FAIL  Private bundle contains platform / SaaS markers.',
    '      Private MUST NOT ship platform code. A guard was likely missed —',
    '      ensure the leaking code is behind `IS_SAAS` (src/utils/edition.js)',
    '      or in a lazy chunk gated by `import.meta.env.VITE_EDITION === "saas"`.',
    '',
    '      Offending chunk(s):',
  ];
  for (const o of offenders) {
    lines.push(`        ${o.file}`);
    lines.push(`            markers: ${o.markers.join(', ')}`);
  }
  lines.push('');
  lines.push(`      Scanned ${jsFiles.length} file(s), ${mb} MB before failing.`);
  failHard(lines);
}

// No forbidden markers. The appId check is advisory (warn, never fail).
if (!appIdFound) {
  console.warn(
    `WARN  Expected appId string "${REQUIRED_APP_ID}" not found in any chunk.`
  );
  console.warn(
    '      Constants may not have folded as expected (or a minifier mangled it).'
  );
  console.warn('      Not failing on this — but worth a look.');
  console.warn('');
}

console.log('PASS  No platform / SaaS markers found in the private bundle.');
console.log(`      files scanned : ${jsFiles.length}`);
console.log(`      total size    : ${totalBytes} bytes (${mb} MB)`);
console.log(
  `      appId marker  : ${appIdFound ? `present ("${REQUIRED_APP_ID}")` : 'ABSENT (warned above)'}`
);
console.log(
  `      forbidden     : none of [${FORBIDDEN_MARKERS.join(', ')}]`
);
process.exit(0);
