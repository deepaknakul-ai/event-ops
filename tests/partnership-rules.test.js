// Partnership rules tests (run against the local emulator, like
// firestore-rules.test.js). Reproduces the live setup: firm_type=partnership,
// two active partners (P1 = also the admin's counter-party, P2), admin who IS
// a named partner, plus a pure partner-role login. Verifies every surface the
// /partnership page touches, to catch permission-denied regressions like the
// one reported on partner-add.

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, test } from 'vitest';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection } from 'firebase/firestore';

const HAS_EMULATOR = !!(globalThis.process?.env?.FIRESTORE_EMULATOR_HOST);
const APP = 'TERMS 1.0.0';
const path = (...segs) => ['artifacts', APP, 'public', 'data', ...segs].join('/');

describe.skipIf(!HAS_EMULATOR)('firestore.rules — partnership module', () => {
  let env;
  const asUser = (uid) => env.authenticatedContext(uid, { appId: APP }).firestore();

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'partnership-rules-test',
      firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8987 },
    });
  });
  afterAll(async () => { if (env) await env.cleanup(); });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // roles
      await setDoc(doc(db, path('employees', 'adminP')), { role: 'admin', name: 'Owner Partner' });
      await setDoc(doc(db, path('users', 'adminP')), { role: 'admin' });
      await setDoc(doc(db, path('employees', 'p2')), { role: 'partner', name: 'Partner Two' });
      await setDoc(doc(db, path('users', 'p2')), { role: 'partner' });
      await setDoc(doc(db, path('employees', 'acc1')), { role: 'accountant', name: 'Bean Counter' });
      await setDoc(doc(db, path('users', 'acc1')), { role: 'accountant' });
      await setDoc(doc(db, path('employees', 'mgr1')), { role: 'manager', name: 'Mgr' });
      await setDoc(doc(db, path('users', 'mgr1')), { role: 'manager' });
      // firm constitution: ACTIVE partnership, admin is a named partner
      await setDoc(doc(db, path('settings', 'organization')), { name: 'Firm', firm_type: 'partnership' });
      await setDoc(doc(db, path('settings', 'partnership')), {
        enabled: true, min_partners_met: true, approval_threshold: 50000,
        partners: {
          adminP: { name: 'Owner Partner', profit_share: 60, active: true },
          p2: { name: 'Partner Two', profit_share: 40, active: true },
        },
      });
      // sample books docs for listener coverage
      await setDoc(doc(db, path('pending_actions', 'seeded')), { type: 'fy_close', key: '2025-26', initiated_by: 'adminP', sig1: null, sig2: null });
      await setDoc(doc(db, path('partner_consents', 'c1')), { title: 'T', category: 'ordinary', status: 'open', proposed_by: 'p2' });
      await setDoc(doc(db, path('clients', 'cl1')), { name: 'Acme', owner_id: 'mgr1', opening_balance: 5 });
      await setDoc(doc(db, path('project_financials', 'pj1')), { client_owner_id: 'mgr1', package_cost: 100 });
      await setDoc(doc(db, path('payments', 'pay1')), { amount: 100, client_id: 'cl1', recorded_by: 'acc1', status: 'Approved' });
      await setDoc(doc(db, path('employee_pay', 'e1')), { hourlyRate: 100 });
      await setDoc(doc(db, path('journal_entries', 'j1')), { fy: '2026-27', entries: [] });
      await setDoc(doc(db, path('vendor_payments', 'vpBig')), { amount: 90000, vendor_id: 'v1', created_by_emp: 'adminP', partner_approval_status: 'pending', partner_approved_by: null, partner_approved_at: null });
    });
  });

  // ── every listener the partner-role session opens ─────────────────────────
  test('partner-role: books listeners all readable (s.12(d))', async () => {
    const db = asUser('p2');
    await assertSucceeds(getDocs(collection(db, path('pending_actions'))));
    await assertSucceeds(getDocs(collection(db, path('partner_consents'))));
    await assertSucceeds(getDocs(collection(db, path('payments'))));
    await assertSucceeds(getDocs(collection(db, path('employee_pay'))));
    await assertSucceeds(getDocs(collection(db, path('journal_entries'))));
    await assertSucceeds(getDocs(collection(db, path('vendor_payments'))));
    await assertSucceeds(getDocs(collection(db, path('clients'))));            // full client book
    await assertSucceeds(getDocs(collection(db, path('project_financials')))); // project money
  });

  test('admin + accountant: governance listeners readable; manager denied consents', async () => {
    await assertSucceeds(getDocs(collection(asUser('adminP'), path('pending_actions'))));
    await assertSucceeds(getDocs(collection(asUser('adminP'), path('partner_consents'))));
    await assertSucceeds(getDocs(collection(asUser('acc1'), path('partner_consents'))));
    await assertFails(getDocs(collection(asUser('mgr1'), path('partner_consents'))));
  });

  // ── the auto-raise flow (stageGovernance) exactly as the page writes it ───
  test('admin(named partner): stage → counter-sign → apply → consume', async () => {
    const admin = asUser('adminP');
    const ref = doc(admin, path('pending_actions', 'partnership_settings'));
    // stage (create with own sig1 — admin is a named partner)
    await assertSucceeds(setDoc(ref, {
      type: 'partnership_settings', key: 'current', note: 'Add/update partner: Three',
      staged: { next: { partners: { p3: { name: 'Three', profit_share: 10, active: true } }, min_partners_met: true } },
      initiated_by: 'adminP', sig1: { emp: 'adminP', at: 'now' }, sig2: null, created_at: 'now',
    }));
    // registry write still blocked (only one signature)
    await assertFails(setDoc(doc(admin, path('settings', 'partnership')), { approval_threshold: 1 }, { merge: true }));
    // p2 cannot fill sig2 with someone else's id, can with their own
    const p2 = asUser('p2');
    await assertFails(updateDoc(doc(p2, path('pending_actions', 'partnership_settings')), { sig2: { emp: 'adminP', at: 'now' } }));
    await assertSucceeds(updateDoc(doc(p2, path('pending_actions', 'partnership_settings')), { sig2: { emp: 'p2', at: 'now' } }));
    // dual-signed → admin applies the staged merge, then consumes the request
    await assertSucceeds(setDoc(doc(admin, path('settings', 'partnership')),
      { partners: { p3: { name: 'Three', profit_share: 10, active: true } } }, { merge: true }));
    await assertSucceeds(deleteDoc(doc(admin, path('pending_actions', 'partnership_settings'))));
    // …and the next governance write is blocked again
    await assertFails(setDoc(doc(admin, path('settings', 'partnership')), { approval_threshold: 2 }, { merge: true }));
  });

  test('self-countersign denied: the SAME partner cannot fill both slots', async () => {
    const admin = asUser('adminP');
    await assertSucceeds(setDoc(doc(admin, path('pending_actions', 'partnership_settings')), {
      type: 'partnership_settings', key: 'current', note: 'x', staged: { next: {} },
      initiated_by: 'adminP', sig1: { emp: 'adminP', at: 'now' }, sig2: null,
    }));
    await assertFails(updateDoc(doc(admin, path('pending_actions', 'partnership_settings')), { sig2: { emp: 'adminP', at: 'now' } }));
  });

  test('manager can neither create nor sign a pending action', async () => {
    const mgr = asUser('mgr1');
    await assertFails(setDoc(doc(mgr, path('pending_actions', 'mgr_try')), { type: 'x', initiated_by: 'mgr1', sig1: null, sig2: null }));
    await assertFails(updateDoc(doc(mgr, path('pending_actions', 'seeded')), { sig1: { emp: 'mgr1', at: 'now' } }));
  });

  // ── per-partner CoA + registry save path used by savePartner ──────────────
  test('admin: creates per-partner capital/drawings CoA accounts', async () => {
    const admin = asUser('adminP');
    await assertSucceeds(setDoc(doc(admin, path('chart_of_accounts', '3101')), {
      code: '3101', name: 'Capital — Three', type: 'Equity', normalSide: 'Cr', isSystem: false, partner_id: 'p3',
    }, { merge: true }));
  });

  // ── spend threshold: vendor payment above ₹50,000 ─────────────────────────
  test('above-threshold vendor payment must be born pending; partner (not creator) decides', async () => {
    const acc = asUser('acc1');
    // born Approved-less: missing pending status → denied
    await assertFails(setDoc(doc(acc, path('vendor_payments', 'vpNew')), { amount: 60000, vendor_id: 'v1', created_by_emp: 'acc1' }));
    await assertSucceeds(setDoc(doc(acc, path('vendor_payments', 'vpNew')), {
      amount: 60000, vendor_id: 'v1', created_by_emp: 'acc1',
      partner_approval_status: 'pending', partner_approved_by: null, partner_approved_at: null,
    }));
    // creator (adminP) of vpBig cannot approve their own spend
    await assertFails(updateDoc(doc(asUser('adminP'), path('vendor_payments', 'vpBig')), {
      partner_approval_status: 'approved', partner_approved_by: 'adminP', partner_approved_at: 'now',
    }));
    // the OTHER partner can
    await assertSucceeds(updateDoc(doc(asUser('p2'), path('vendor_payments', 'vpBig')), {
      partner_approval_status: 'approved', partner_approved_by: 'p2', partner_approved_at: 'now',
    }));
    // below-threshold stays frictionless
    await assertSucceeds(setDoc(doc(acc, path('vendor_payments', 'vpSmall')), { amount: 100, vendor_id: 'v1' }));
  });

  // ── consent register ──────────────────────────────────────────────────────
  test('votes: each partner writes ONLY their own slot; closed docs freeze', async () => {
    const p2 = asUser('p2');
    await assertSucceeds(updateDoc(doc(p2, path('partner_consents', 'c1')), { vote_p2: { vote: 'yes', at: 'now' } }));
    await assertFails(updateDoc(doc(p2, path('partner_consents', 'c1')), { vote_adminP: { vote: 'yes', at: 'now' } }));
    await assertSucceeds(updateDoc(doc(asUser('adminP'), path('partner_consents', 'c1')), { status: 'passed', closed_at: 'now', closed_by: 'adminP' }));
    await assertFails(updateDoc(doc(p2, path('partner_consents', 'c1')), { vote_p2: { vote: 'no', at: 'later' } }));
    await assertFails(deleteDoc(doc(asUser('adminP'), path('partner_consents', 'c1'))));
  });

  // ── proprietorship stays untouched ────────────────────────────────────────
  test('proprietorship: admin edits settings/partnership freely (setup path)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path('settings', 'organization')), { firm_type: 'proprietorship' });
    });
    await assertSucceeds(setDoc(doc(asUser('adminP'), path('settings', 'partnership')), { enabled: true, partners: {} }, { merge: true }));
  });
});
