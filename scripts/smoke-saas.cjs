/**
 * Post-deploy SaaS smoke check — a blast-radius guard. Exercises the whole
 * tenant control-plane against a throwaway CANARY tenant and exits non-zero if
 * anything is broken, so a bad release is caught before real tenants hit it.
 *
 * Uses the service account to mint a super_admin staff token (no passwords), so
 * it runs unattended in CI / after deploy.
 *
 * Usage:
 *   node scripts/smoke-saas.cjs --project <id> --sa <sa.json> --api-key <web-api-key> [--keep]
 *
 * Checks: super_admin token works · create canary (trial) seeds COA + equipment
 * + entitlements · owner login · user-cap enforced · suspend revokes login ·
 * reactivate restores. Canary is deleted at the end (unless --keep).
 */
const admin = require(require('path').join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
const fs = require('fs');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const project = arg('project');
const saPath = arg('sa');
const apiKey = arg('api-key');
const keep = process.argv.includes('--keep');
if (!project || !saPath || !apiKey) {
  console.error('Usage: --project <id> --sa <sa.json> --api-key <web-api-key> [--keep]');
  process.exit(1);
}
const FN = `https://us-central1-${project}.cloudfunctions.net`;
const CODE = 'smoke-canary';
const OWNER_PW = 'CanaryOwner12345';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(saPath, 'utf8'))), projectId: project });
const db = admin.firestore();
let failures = 0;
const P = (m) => console.log('  PASS  ' + m);
const F = (m) => { console.log('  FAIL  ' + m); failures += 1; };
const emsg = (b) => (b && b.error ? b.error.message : JSON.stringify(b));

async function call(name, data, idToken) {
  const r = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function idTok(customToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  return (await r.json()).idToken;
}
async function cleanup() {
  await db.recursiveDelete(db.doc(`artifacts/${CODE}`)).catch(() => {});
  await db.doc(`platform_tenants/${CODE}`).delete().catch(() => {});
  await db.doc('meta/active_apps').set({ ids: admin.firestore.FieldValue.arrayRemove(CODE) }, { merge: true }).catch(() => {});
}

(async () => {
  console.log(`SaaS smoke check — ${project}${keep ? ' (--keep)' : ''}`);
  try {
    // 1. super_admin staff token via the SA (find an active super_admin doc)
    const supers = await db.collection('platform_staff').where('role', '==', 'super_admin').where('status', '==', 'active').limit(1).get();
    if (supers.empty) { F('no active super_admin in platform_staff'); throw new Error('no super_admin'); }
    const staffId = supers.docs[0].id;
    const staffTok = await idTok(await admin.auth().createCustomToken(staffId, { staff: true, staff_role: 'super_admin' }));
    if (!staffTok) { F('could not mint/exchange super_admin token (Auth enabled?)'); throw new Error('no token'); }
    P(`super_admin token established (${staffId})`);

    const list = await call('platformListTenants', {}, staffTok);
    list.status === 200 && Array.isArray(list.body.result?.tenants) ? P(`platformListTenants ok (${list.body.result.tenants.length} tenant(s))`) : F('platformListTenants: ' + emsg(list.body));

    // 2. create canary (trial) → seeds + entitlements
    await cleanup();
    const create = await call('platformCreateTenant', { code: CODE, name: 'Smoke Canary', region: 'north', plan: 'trial', trial_expires_on: '2099-12-31', contact: { name: 'x', email: 'x@x.co', phone: '0' }, ownerPassword: OWNER_PW }, staffTok);
    create.body.result?.ok ? P('canary created') : F('create canary: ' + emsg(create.body));
    const [coa, inv, ent] = await Promise.all([
      db.collection(`artifacts/${CODE}/public/data/chart_of_accounts`).count().get(),
      db.collection(`artifacts/${CODE}/public/data/inventory`).count().get(),
      db.doc(`artifacts/${CODE}/public/data/settings/entitlements`).get(),
    ]);
    coa.data().count >= 60 ? P(`COA seeded (${coa.data().count})`) : F(`COA seed low: ${coa.data().count}`);
    inv.data().count >= 130 ? P(`equipment seeded (${inv.data().count})`) : F(`equipment seed low: ${inv.data().count}`);
    ent.exists && ent.data().plan === 'trial' ? P('entitlements written (trial)') : F('entitlements doc missing/wrong');

    // 3. owner login
    const owner = await call('verifyLogin', { username: 'admin', password: OWNER_PW, appId: CODE }, null);
    owner.body.result?.token ? P('owner login ok') : F('owner login: ' + emsg(owner.body));

    // 4. user cap (trial = 3, incl. the auto-created owner admin): create users
    // until the cap blocks one — baseline-independent, so it doesn't matter how
    // many employees already exist.
    const mk = (n) => call('platformManageTenantUsers', { tenantId: CODE, op: 'create', data: { name: `U${n}`, username: `u${n}_${CODE}`, email: `u${n}_${CODE}@x.co`, role: 'user', password: 'UserPass12345' } }, staffTok);
    let created = 0; let capHit = null;
    for (let n = 1; n <= 6 && !capHit; n += 1) {
      const r = await mk(n);
      if (r.status === 200) created += 1; else capHit = r;
    }
    (created >= 1 && capHit && /plan allows/i.test(emsg(capHit.body))) ? P(`user cap enforced (created ${created}, next blocked)`) : F('cap not enforced: ' + (capHit ? emsg(capHit.body) : 'never blocked in 6 tries'));

    // 5. suspend revokes login; reactivate restores
    await call('platformUpdateTenant', { tenantId: CODE, patch: { status: 'suspended' } }, staffTok);
    const blocked = await call('verifyLogin', { username: 'admin', password: OWNER_PW, appId: CODE }, null);
    blocked.status !== 200 ? P('suspend blocks login') : F('suspend did not block login');
    await call('platformUpdateTenant', { tenantId: CODE, patch: { status: 'active' } }, staffTok);
    const react = await call('verifyLogin', { username: 'admin', password: OWNER_PW, appId: CODE }, null);
    react.status === 200 ? P('reactivate restores login') : F('reactivate failed: ' + emsg(react.body));
  } catch (e) {
    F('EXCEPTION: ' + e.message);
  } finally {
    if (!keep) { await cleanup(); console.log('  canary cleaned up.'); }
  }
  console.log(failures ? `\nSMOKE FAILED — ${failures} check(s) failed.` : '\nSMOKE PASSED — all checks green.');
  process.exit(failures ? 1 : 0);
})();
