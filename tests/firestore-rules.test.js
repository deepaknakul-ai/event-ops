// Firestore security-rules tests (run against the local emulator).
//
// These prove role isolation WITHOUT a live non-admin login. They only run under
// the emulator: `firebase emulators:exec --only firestore "npx vitest run
// tests/firestore-rules.test.js"` sets FIRESTORE_EMULATOR_HOST, which gates the
// whole suite via describe.skipIf so the normal `vitest run` stays green.
//
// Auth model: request.auth.uid === employee doc id; userRole() reads
// users/{uid} then falls back to employees/{uid}. We seed employees/{uid}.

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, test } from 'vitest';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const HAS_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;
const APP = 'TERMS 1.0.0';
const path = (...segs) => ['artifacts', APP, 'public', 'data', ...segs].join('/');

describe.skipIf(!HAS_EMULATOR)('firestore.rules — role isolation', () => {
  let testEnv;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'terms-rules-test',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: '127.0.0.1',
        port: 8987,
      },
    });
  });

  afterAll(async () => { if (testEnv) await testEnv.cleanup(); });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, path('employees', 'admin1')), { role: 'admin', name: 'Admin' });
      await setDoc(doc(db, path('employees', 'acct1')), { role: 'accountant', name: 'Acct' });
      await setDoc(doc(db, path('employees', 'mgrA')), { role: 'manager', name: 'Mgr A' });
      await setDoc(doc(db, path('employees', 'mgrB')), { role: 'manager', name: 'Mgr B' });
      await setDoc(doc(db, path('employees', 'tech1')), { role: 'tech', name: 'Tech' });
      await setDoc(doc(db, path('clients', 'cA')), { name: 'Client A', owner_id: 'mgrA' });
      await setDoc(doc(db, path('payments', 'pay1')), { amount: 1000, client_id: 'cA' });
      await setDoc(doc(db, path('projects', 'projA')), { project_name: 'Proj A', client_owner_id: 'mgrA' });
      await setDoc(doc(db, path('audit_logs', 'log1')), { action: 'test' });
    });
  });

  const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
  const asAnon = () => testEnv.unauthenticatedContext().firestore();

  describe('clients — manager owner-scoping (deployed)', () => {
    test('manager reads own client', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('clients', 'cA'))));
    });
    test("manager CANNOT read another manager's client", async () => {
      await assertFails(getDoc(doc(asUser('mgrB'), path('clients', 'cA'))));
    });
    test('admin reads any client', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('clients', 'cA'))));
    });
    test('accountant reads any client', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('clients', 'cA'))));
    });
    test('anonymous cannot read a client', async () => {
      await assertFails(getDoc(doc(asAnon(), path('clients', 'cA'))));
    });
  });

  describe('audit_logs (deployed rule: admin/accountant read only)', () => {
    test('admin reads audit_logs', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('audit_logs', 'log1'))));
    });
    test('tech CANNOT read audit_logs', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('audit_logs', 'log1'))));
    });
  });

  // Documents the CURRENT baseline gaps that Slice C will close. If these start
  // FAILING, it means the rules were tightened (update these to assertFails).
  describe('baseline gaps — still open at the rule layer (to close in Slice C)', () => {
    test('GAP: tech can still read any project', async () => {
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('projects', 'projA'))));
    });
    test('GAP: tech can still read finance collections (payments)', async () => {
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('payments', 'pay1'))));
    });
  });
});
