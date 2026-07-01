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
import { doc, getDoc, setDoc, getDocs, query, where, collection } from 'firebase/firestore';

const HAS_EMULATOR = !!(globalThis.process?.env?.FIRESTORE_EMULATOR_HOST);
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
      await setDoc(doc(db, path('employees', 'u1')), { role: 'user', name: 'Coordinator' });
      await setDoc(doc(db, path('clients', 'cA')), { name: 'Client A', owner_id: 'mgrA' });
      await setDoc(doc(db, path('payments', 'pay1')), { amount: 1000, client_id: 'cA' });
      await setDoc(doc(db, path('projects', 'projA')), { project_name: 'Proj A', client_owner_id: 'mgrA' });
      await setDoc(doc(db, path('audit_logs', 'log1')), { action: 'test' });
      await setDoc(doc(db, path('journal_entries', 'je1')), { debit_amount: 100 });
      await setDoc(doc(db, path('chart_of_accounts', 'coa1')), { name: 'Cash' });
      await setDoc(doc(db, path('payouts', 'po_u1')), { employee_id: 'u1', amount: 500 });
      await setDoc(doc(db, path('payouts', 'po_mgrA')), { employee_id: 'mgrA', amount: 700 });
      await setDoc(doc(db, path('advances', 'adv_u1')), { employee_id: 'u1', amount: 200 });
      await setDoc(doc(db, path('tax_invoices', 'ti1')), { client_id: 'cA', final_amount: 5000 });
      await setDoc(doc(db, path('vendor_payments', 'vp1')), { vendor_id: 'vX', amount: 300 });
      await setDoc(doc(db, path('purchase_invoices', 'pi1')), { vendor_id: 'vX', amount: 400 });
      await setDoc(doc(db, path('leads', 'ld_mgrA')), { name: 'Lead A', created_by: 'mgrA', est_value: 90000 });
      await setDoc(doc(db, path('leads', 'ld_mgrB')), { name: 'Lead B', created_by: 'mgrB', est_value: 50000 });
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

  describe('company ledgers — Owner + Accountant only (Slice C-1)', () => {
    test('admin reads journal_entries', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('journal_entries', 'je1'))));
    });
    test('accountant reads journal_entries', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('journal_entries', 'je1'))));
    });
    test('accountant reads chart_of_accounts', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('chart_of_accounts', 'coa1'))));
    });
    test('manager CANNOT read journal_entries', async () => {
      await assertFails(getDoc(doc(asUser('mgrA'), path('journal_entries', 'je1'))));
    });
    test('tech CANNOT read journal_entries', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('journal_entries', 'je1'))));
    });
    test('user CANNOT read chart_of_accounts', async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('chart_of_accounts', 'coa1'))));
    });
  });

  describe('payouts + advances — self-scoped (Slice C-2)', () => {
    test('user reads OWN payout', async () => {
      await assertSucceeds(getDoc(doc(asUser('u1'), path('payouts', 'po_u1'))));
    });
    test("user CANNOT read another employee's payout", async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('payouts', 'po_mgrA'))));
    });
    test('user reads OWN advance', async () => {
      await assertSucceeds(getDoc(doc(asUser('u1'), path('advances', 'adv_u1'))));
    });
    test('accountant reads any payout', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('payouts', 'po_mgrA'))));
    });
    test('tech CANNOT read another employee payout', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('payouts', 'po_u1'))));
    });
    test('user CAN list own payouts (scoped query the loader runs)', async () => {
      const db = asUser('u1');
      await assertSucceeds(getDocs(query(collection(db, path('payouts')), where('employee_id', '==', 'u1'))));
    });
    test('user CANNOT list ALL payouts (global query denied)', async () => {
      await assertFails(getDocs(collection(asUser('u1'), path('payouts'))));
    });
    test('accountant CAN list all payouts (global query)', async () => {
      await assertSucceeds(getDocs(collection(asUser('acct1'), path('payouts'))));
    });
  });

  describe('invoices + vendor payments — Owner/Accountant/Manager only (Slice C-3)', () => {
    test('manager reads a tax invoice', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('tax_invoices', 'ti1'))));
    });
    test('accountant reads a purchase invoice', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('purchase_invoices', 'pi1'))));
    });
    test('tech CANNOT read a tax invoice', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('tax_invoices', 'ti1'))));
    });
    test('user CANNOT read a vendor payment', async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('vendor_payments', 'vp1'))));
    });
    test('user CANNOT list tax_invoices', async () => {
      await assertFails(getDocs(collection(asUser('u1'), path('tax_invoices'))));
    });
  });

  describe('leads — Owner/Accountant all, Manager own only (Slice C-4)', () => {
    test('admin reads any lead', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('leads', 'ld_mgrB'))));
    });
    test('manager reads OWN lead', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('leads', 'ld_mgrA'))));
    });
    test("manager CANNOT read another manager's lead", async () => {
      await assertFails(getDoc(doc(asUser('mgrA'), path('leads', 'ld_mgrB'))));
    });
    test('tech CANNOT read leads', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('leads', 'ld_mgrA'))));
    });
    test('manager CAN list own leads (scoped query)', async () => {
      await assertSucceeds(getDocs(query(collection(asUser('mgrA'), path('leads')), where('created_by', '==', 'mgrA'))));
    });
    test('manager CANNOT list all leads (global denied)', async () => {
      await assertFails(getDocs(collection(asUser('mgrA'), path('leads'))));
    });
  });

  // Documents the CURRENT baseline gaps that later Slice-C steps will close.
  // If one starts FAILING, the rule was tightened (flip it to assertFails).
  describe('baseline gaps — still open at the rule layer (later Slice-C steps)', () => {
    test('GAP: tech can still read any project', async () => {
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('projects', 'projA'))));
    });
    test('GAP: payments still global (user commission reads it — needs owner denorm)', async () => {
      await assertSucceeds(getDoc(doc(asUser('u1'), path('payments', 'pay1'))));
    });
  });
});
