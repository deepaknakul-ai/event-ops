/**
 * scripts/deploy-everywhere.cjs
 *
 * "One update -> all editions." Builds and deploys the app to each Firebase
 * project (private, backup/standby, saas), gating every step on the previous
 * one succeeding. Any non-zero exit aborts the whole run — we never deploy on
 * top of a failed build or a red test suite.
 *
 * Pipeline (in order):
 *   1. npm test                                            (unless --skip-tests)
 *   2. npm run build            -> node scripts/check-private-bundle.cjs
 *      -> firebase deploy --project default --only hosting,functions,firestore:rules
 *   3. npm run build:backup
 *      -> firebase deploy --project backup  --only hosting,functions,firestore:rules
 *   4. npm run build:saas
 *      -> firebase deploy --project saas    --only hosting,functions,firestore:rules
 *
 * The private build is verified by check-private-bundle.cjs BEFORE the backup
 * build overwrites dist/, so the guardrail always inspects private output.
 *
 * Flags:
 *   --skip-tests            skip step 1 (npm test)
 *   --only <editions>       deploy a subset; comma-separated subset of
 *                           private,backup,saas  (e.g. --only private,saas)
 *   --dry-run               print the exact command plan; execute nothing
 *
 * Guard: if the 'saas' alias in .firebaserc is still the placeholder
 * 'REPLACE_WITH_SAAS_PROJECT_ID', the saas edition is SKIPPED with a warning
 * (not an error) — you can roll out private + backup before SaaS exists.
 *
 * Exit codes:  0 = all selected editions deployed (or dry-run)   non-zero = a
 * step failed (propagates the failing command's exit code).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SAAS_PLACEHOLDER = 'REPLACE_WITH_SAAS_PROJECT_ID';
const DEPLOY_TARGETS = 'hosting,functions,firestore:rules';

// Ordered edition definitions. `check` runs only for private (its bundle is the
// one that must stay free of platform code).
const EDITIONS = [
  {
    key: 'private',
    label: 'PRIVATE (project alias: default)',
    build: 'npm run build',
    check: 'node scripts/check-private-bundle.cjs',
    alias: 'default',
  },
  {
    key: 'backup',
    label: 'BACKUP / STANDBY (project alias: backup)',
    build: 'npm run build:backup',
    check: null,
    alias: 'backup',
  },
  {
    key: 'saas',
    label: 'SAAS (project alias: saas)',
    build: 'npm run build:saas',
    check: null,
    alias: 'saas',
  },
];

// ─── Arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const SKIP_TESTS = args['skip-tests'] === true;
const DRY_RUN = args['dry-run'] === true;

// Resolve which editions to run (default: all, in declared order).
let selectedKeys = EDITIONS.map((e) => e.key);
if (typeof args.only === 'string') {
  const requested = args.only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = new Set(EDITIONS.map((e) => e.key));
  const bad = requested.filter((r) => !valid.has(r));
  if (bad.length > 0) {
    console.error(
      `\nError: --only got unknown edition(s): ${bad.join(', ')}` +
        `\n       Valid values: ${[...valid].join(', ')}\n`
    );
    process.exit(1);
  }
  // Preserve declared order regardless of the order given on the CLI.
  selectedKeys = EDITIONS.map((e) => e.key).filter((k) => requested.includes(k));
} else if (args.only === true) {
  console.error('\nError: --only requires a value, e.g. --only private,saas\n');
  process.exit(1);
}
const selected = EDITIONS.filter((e) => selectedKeys.includes(e.key));

// ─── Read the saas alias so we can guard the SaaS deploy ──────────────────────
function readSaasAlias() {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
    return (rc.projects && rc.projects.saas) || null;
  } catch (e) {
    console.warn(`WARN  could not read .firebaserc: ${e.message}`);
    return null;
  }
}
const saasAlias = readSaasAlias();
const saasReady = saasAlias && saasAlias !== SAAS_PLACEHOLDER;

// ─── Command runner ───────────────────────────────────────────────────────────
// Prints the command (so --dry-run yields a full, copy-pasteable plan), then
// runs it with inherited stdio. A non-zero exit aborts the entire script.
function run(cmd) {
  console.log(`\n$ ${cmd}`);
  if (DRY_RUN) return;
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
  } catch (e) {
    const code = typeof e.status === 'number' ? e.status : 1;
    console.error(`\nCommand failed (exit ${code}): ${cmd}`);
    console.error('Aborting deploy-everywhere — no further steps will run.');
    process.exit(code);
  }
}

// ─── Plan banner ──────────────────────────────────────────────────────────────
console.log('');
console.log('deploy-everywhere — one update, all editions');
console.log(`  mode      : ${DRY_RUN ? 'DRY RUN (no commands executed)' : 'LIVE'}`);
console.log(`  tests     : ${SKIP_TESTS ? 'skipped (--skip-tests)' : 'npm test'}`);
console.log(`  editions  : ${selected.map((e) => e.key).join(', ') || '(none)'}`);
console.log(`  targets   : ${DEPLOY_TARGETS}`);
console.log(`  saas alias: ${saasAlias || '(unset)'}${saasReady ? '' : '  -> SaaS will be SKIPPED'}`);
console.log('');

if (selected.length === 0) {
  console.log('Nothing selected to deploy. Done.');
  process.exit(0);
}

const deployed = [];
const skipped = [];

// ─── Step 1: tests (once, up front) ───────────────────────────────────────────
if (SKIP_TESTS) {
  console.log('Step 1/…  tests SKIPPED (--skip-tests)');
} else {
  console.log('Step 1  Running test suite (gates everything below)…');
  run('npm test');
}

// ─── Steps 2..N: per-edition build + verify + deploy ──────────────────────────
let stepNo = 2;
for (const ed of selected) {
  console.log(`\nStep ${stepNo}  ${ed.label}`);
  stepNo++;

  // SaaS guard: skip cleanly if the alias is still the placeholder.
  if (ed.key === 'saas' && !saasReady) {
    console.warn(
      `  SKIPPING SaaS — .firebaserc 'saas' alias is ${saasAlias ? `'${saasAlias}'` : 'unset'}.`
    );
    console.warn(
      `  Set a real project id (replace '${SAAS_PLACEHOLDER}') in .firebaserc to enable it.`
    );
    skipped.push(`${ed.key} (saas alias not configured)`);
    continue;
  }

  // Build this edition into dist/.
  run(ed.build);

  // Private-only: prove the freshly built dist/ carries no platform code
  // BEFORE any later build overwrites it.
  if (ed.check) run(ed.check);

  // Deploy the freshly built dist/ + functions + rules to this project.
  run(`firebase deploy --project ${ed.alias} --only ${DEPLOY_TARGETS}`);

  deployed.push(`${ed.key} (--project ${ed.alias})`);
}

// ─── Final summary ────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────');
console.log(DRY_RUN ? 'DRY RUN complete — the plan above was NOT executed.' : 'deploy-everywhere complete.');
console.log(`  deployed: ${deployed.length ? deployed.join(', ') : '(none)'}`);
if (skipped.length) console.log(`  skipped : ${skipped.join(', ')}`);
console.log('──────────────────────────────────────────────\n');
process.exit(0);
