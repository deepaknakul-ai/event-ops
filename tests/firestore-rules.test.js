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
import { doc, getDoc, setDoc, deleteDoc, getDocs, query, where, collection } from 'firebase/firestore';

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
      // pay1: client cA is owned by mgrA. pay_u: a client referred by Coordinator u1.
      await setDoc(doc(db, path('payments', 'pay1')), { amount: 1000, client_id: 'cA', client_owner_id: 'mgrA' });
      await setDoc(doc(db, path('payments', 'pay_u')), { amount: 250, client_id: 'cU', client_owner_id: 'u1' });
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
      await setDoc(doc(db, path('payroll', 'pr1')), { employee_id: 'tech1', grossPay: 50000, netPay: 45000, deductions: 5000 });
      await setDoc(doc(db, path('inventory', 'inv1')), { name: 'LED Panel', rate_per_day: 500, purchase_cost: 40000 });
      await setDoc(doc(db, path('expenses', 'exp_tech')), { employee_id: 'tech1', amount: 500, status: 'Approved' });
      await setDoc(doc(db, path('expenses', 'exp_mgr')), { employee_id: 'mgrA', amount: 800, status: 'Approved' });
      await setDoc(doc(db, path('expenses', 'exp_tech_pend')), { employee_id: 'tech1', amount: 300, status: 'Pending' });
      await setDoc(doc(db, path('penalties', 'pen1')), { employee_id: 'tech1', minutes: 30, reason: 'late' });
      await setDoc(doc(db, path('reminder_log', 'rl_cA')), { outstanding: 5000, count: 2, last_sent: '2026-07-01' });
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
    test('tech CANNOT read a client (opening_balance leak closed)', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('clients', 'cA'))));
    });
    test('coordinator CANNOT read a client they do not own', async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('clients', 'cA'))));
    });
    test('tech CANNOT list clients', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('clients'))));
    });
  });

  describe('audit_logs (deployed rule: admin/accountant read only)', () => {
    test('admin reads audit_logs', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('audit_logs', 'log1'))));
    });
    test('tech CANNOT read audit_logs', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('audit_logs', 'log1'))));
    });
    test('accountant CANNOT read audit_logs (Owner-only now)', async () => {
      await assertFails(getDoc(doc(asUser('acct1'), path('audit_logs', 'log1'))));
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

  describe('payments — owner-scoped for Coordinator, all for finance/manager (Slice C-5)', () => {
    test('admin reads any payment', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('payments', 'pay1'))));
    });
    test('manager reads any payment', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('payments', 'pay1'))));
    });
    test('coordinator reads a payment of a client THEY referred', async () => {
      await assertSucceeds(getDoc(doc(asUser('u1'), path('payments', 'pay_u'))));
    });
    test('coordinator CANNOT read a payment of a client they did NOT refer', async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('payments', 'pay1'))));
    });
    test('tech CANNOT read any payment', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('payments', 'pay_u'))));
    });
    test('coordinator CAN list own-referred payments (scoped query the loader runs)', async () => {
      await assertSucceeds(getDocs(query(collection(asUser('u1'), path('payments')), where('client_owner_id', '==', 'u1'))));
    });
    test('coordinator CANNOT list all payments (global denied)', async () => {
      await assertFails(getDocs(collection(asUser('u1'), path('payments'))));
    });
  });

  describe('payroll — Owner/Accountant only (verification fix)', () => {
    test('accountant reads payroll', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('payroll', 'pr1'))));
    });
    test('manager CANNOT read payroll', async () => {
      await assertFails(getDoc(doc(asUser('mgrA'), path('payroll', 'pr1'))));
    });
    test('tech CANNOT read payroll (own or otherwise)', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('payroll', 'pr1'))));
    });
    test('tech CANNOT list payroll', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('payroll'))));
    });
    test('accountant CAN write payroll', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('payroll', 'pr_new')), { employee_id: 'tech1', grossPay: 10000 }));
    });
    test('tech CANNOT write/forge payroll', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('payroll', 'pr_forge')), { employee_id: 'tech1', grossPay: 999999 }));
    });
    test('manager CANNOT write payroll', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('payroll', 'pr_mgr')), { employee_id: 'tech1', grossPay: 1 }));
    });
  });

  describe('manager cannot write accounting ledgers (round-5 escalation fix)', () => {
    test('manager CANNOT create a journal_entry', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('journal_entries', 'je_m')), { debit_amount: 100, credit_amount: 100 }));
    });
    test('manager CANNOT overwrite chart_of_accounts', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('chart_of_accounts', 'coa1')), { name: 'Hacked' }));
    });
    test('manager CANNOT write opening_balances', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('opening_balances', 'ob_m')), { debit_amount: 5 }));
    });
    test('admin CAN create a journal_entry', async () => {
      await assertSucceeds(setDoc(doc(asUser('admin1'), path('journal_entries', 'je_a')), { debit_amount: 100, credit_amount: 100 }));
    });
    test('accountant CAN create a journal_entry', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('journal_entries', 'je_ac')), { debit_amount: 50, credit_amount: 50 }));
    });
    test('manager CAN still record a payment (receipt path preserved)', async () => {
      // The manager receipt flow always stamps 'Pending Review' (Clients.jsx/Finance.jsx).
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('payments', 'pay_recpt')), { client_id: 'cA', amount: 100, date: '2026-07-02', mode: 'Cash', status: 'Pending Review' }));
    });
  });

  describe('advances writes — admin/accountant only (round-6 fix)', () => {
    test('accountant CAN create an advance', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('advances', 'adv_new')), { employee_id: 'tech1', amount: 1000 }));
    });
    test('tech CANNOT create/forge an advance', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('advances', 'adv_forge')), { employee_id: 'tech1', amount: 999999 }));
    });
    test('manager CANNOT create an advance', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('advances', 'adv_m')), { employee_id: 'tech1', amount: 1 }));
    });
  });

  describe('party_accounts writes — admin/accountant only (round-7 fix)', () => {
    test('accountant CAN write party_accounts', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('party_accounts', 'pa_a')), { current_name: 'ACME' }));
    });
    // Manager READ of party_accounts is denied and upsertPartyAccount getDocs first,
    // so managers never wrote it in practice; the rule now matches (tamper hole closed).
    test('manager CANNOT write party_accounts', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('party_accounts', 'pa_m')), { current_name: 'ACME' }));
    });
    test('tech CANNOT write party_accounts', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('party_accounts', 'pa_t')), { current_name: 'X' }));
    });
  });

  describe('finance-doc DELETE — admin/accountant only, manager walled off (round-7 fix)', () => {
    // A manager must not be able to DELETE finance docs it can neither read nor create.
    test('manager CANNOT delete payroll', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('payroll', 'pr1'))));
    });
    test('manager CANNOT delete a payout', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('payouts', 'po_u1'))));
    });
    test('manager CANNOT delete an advance', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('advances', 'adv_u1'))));
    });
    test('manager CANNOT delete party_accounts', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('party_accounts', 'pa_seed'))));
    });
    test('manager CANNOT delete a purchase_invoice', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('purchase_invoices', 'pi1'))));
    });
    test('tech CANNOT delete a payout', async () => {
      await assertFails(deleteDoc(doc(asUser('tech1'), path('payouts', 'po_u1'))));
    });
    test('accountant CAN delete a payout', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('acct1'), path('payouts', 'po_mgrA'))));
    });
    test('accountant CAN delete payroll', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('acct1'), path('payroll', 'pr1'))));
    });
  });

  describe('reminder_log — admin/accountant only (round-9 fix)', () => {
    // Per-client outstanding receivable, written server-side; no client stake for
    // manager/tech/user, so it must not expose the debtor ledger.
    test('accountant CAN read reminder_log', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('reminder_log', 'rl_cA'))));
    });
    test('manager CANNOT read reminder_log', async () => {
      await assertFails(getDoc(doc(asUser('mgrA'), path('reminder_log', 'rl_cA'))));
    });
    test('tech CANNOT read reminder_log', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('reminder_log', 'rl_cA'))));
    });
    test('tech CANNOT list reminder_log (enumerate debtors)', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('reminder_log'))));
    });
    test('tech CANNOT forge/overwrite reminder_log', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('reminder_log', 'rl_forge')), { outstanding: 0 }));
    });
  });

  describe('leads writes — admin/accountant any, manager own-only (round-9 fix)', () => {
    test('tech CANNOT create a lead (cannot even read leads)', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('leads', 'ld_tech')), { name: 'X', created_by: 'tech1', est_value: 1 }));
    });
    test('manager CAN create a lead stamped with own created_by', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('leads', 'ld_new')), { name: 'New', created_by: 'mgrA', est_value: 1000 }));
    });
    test('manager CANNOT create a lead stamped with another manager', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('leads', 'ld_forge')), { name: 'F', created_by: 'mgrB', est_value: 1 }));
    });
    test('Manager B CANNOT update Manager A\'s lead', async () => {
      await assertFails(setDoc(doc(asUser('mgrB'), path('leads', 'ld_mgrA')), { name: 'Lead A', created_by: 'mgrA', est_value: 999999 }));
    });
    test('manager CAN update own lead', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('leads', 'ld_mgrA')), { name: 'Lead A', created_by: 'mgrA', est_value: 123 }));
    });
    test('accountant CAN update any lead', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('leads', 'ld_mgrB')), { name: 'Lead B', created_by: 'mgrB', est_value: 5 }));
    });
    test('Manager B CANNOT delete Manager A\'s lead', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrB'), path('leads', 'ld_mgrA'))));
    });
    test('manager CAN delete own lead', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('mgrA'), path('leads', 'ld_mgrA'))));
    });
    test('tech CANNOT delete a lead', async () => {
      await assertFails(deleteDoc(doc(asUser('tech1'), path('leads', 'ld_mgrA'))));
    });
  });

  describe('penalties — Owner/Accountant/Manager only (verification fix)', () => {
    test('manager reads penalties', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('penalties', 'pen1'))));
    });
    test('tech CANNOT read penalties', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('penalties', 'pen1'))));
    });
  });

  describe('isFinanceWriter now includes accountant (regression fix)', () => {
    test('accountant CAN create a payment', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('payments', 'newpay_acct')), { client_id: 'cA', amount: 100, date: '2026-07-02', mode: 'UPI' }));
    });
    test('tech CANNOT create a payment', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('payments', 'newpay_tech')), { client_id: 'cA', amount: 100 }));
    });
  });

  describe('payments segregation of duties — manager create-only, no self-approve (round-13 fix)', () => {
    test('manager CAN create a receipt in Pending Review', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('payments', 'pay_mgr_new')), { client_id: 'cA', amount: 500, status: 'Pending Review' }));
    });
    test('manager CANNOT create a payment already Approved (self-approval)', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('payments', 'pay_mgr_appr')), { client_id: 'cA', amount: 500, status: 'Approved' }));
    });
    test('manager CANNOT create with forged approver stamps', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('payments', 'pay_mgr_stamp')), { client_id: 'cA', amount: 500, status: 'Pending Review', approved_by: 'mgrA' }));
    });
    test('manager CANNOT update an existing payment (approve/tamper)', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('payments', 'pay1')), { client_id: 'cA', amount: 99999, status: 'Approved' }));
    });
    test('accountant CAN create an Approved payment', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('payments', 'pay_acct_ok')), { client_id: 'cA', amount: 100, status: 'Approved' }));
    });
    test('accountant CAN update a payment to Approved', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('payments', 'pay1')), { client_id: 'cA', amount: 1000, status: 'Approved', approved_by: 'acct1' }));
    });
  });

  describe('expenses — self-scoped for tech/user (round-3 fix)', () => {
    test('tech reads OWN expense', async () => {
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('expenses', 'exp_tech'))));
    });
    test('tech CANNOT read another employee expense', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('expenses', 'exp_mgr'))));
    });
    test('manager reads any expense', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('expenses', 'exp_mgr'))));
    });
    test('tech CAN list own expenses (scoped query)', async () => {
      await assertSucceeds(getDocs(query(collection(asUser('tech1'), path('expenses')), where('employee_id', '==', 'tech1'))));
    });
    test('tech CANNOT list ALL expenses (global denied)', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('expenses'))));
    });
  });

  describe('expenses writes/delete — dedicated block authoritative (round-10 fix)', () => {
    // Previously the generic wildcard (isRoleUser create/update, isFinanceWriter
    // delete) OR-overrode the dedicated own-Pending block. Now expenses is in both
    // write/delete false-lists, so ONLY the dedicated block grants.
    test('tech CANNOT tamper another employee\'s expense', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('expenses', 'exp_mgr')), { employee_id: 'mgrA', amount: 99999, status: 'Approved' }));
    });
    test('tech CANNOT edit own APPROVED expense (not Pending)', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('expenses', 'exp_tech')), { employee_id: 'tech1', amount: 99999, status: 'Approved' }));
    });
    test('tech CAN edit own PENDING expense (keeps it Pending)', async () => {
      await assertSucceeds(setDoc(doc(asUser('tech1'), path('expenses', 'exp_tech_pend')), { employee_id: 'tech1', amount: 350, status: 'Pending' }));
    });
    test('tech CANNOT self-approve own Pending expense', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('expenses', 'exp_tech_pend')), { employee_id: 'tech1', amount: 350, status: 'Approved' }));
    });
    test('tech CANNOT reassign own Pending expense to another employee', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('expenses', 'exp_tech_pend')), { employee_id: 'mgrA', amount: 350, status: 'Pending' }));
    });
    test('manager CAN update any expense (approver)', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('expenses', 'exp_tech_pend')), { employee_id: 'tech1', amount: 300, status: 'Approved' }));
    });
    test('manager CANNOT delete an expense (delete = admin/accountant)', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('expenses', 'exp_tech'))));
    });
    test('tech CANNOT delete own expense', async () => {
      await assertFails(deleteDoc(doc(asUser('tech1'), path('expenses', 'exp_tech'))));
    });
    test('accountant CAN delete an expense', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('acct1'), path('expenses', 'exp_tech'))));
    });
  });

  describe('penalties writes — admin/manager only (round-3 fix)', () => {
    test('manager CAN create a penalty', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('penalties', 'pen_m')), { employee_id: 'tech1', minutes: 15 }));
    });
    test('tech CANNOT create a penalty', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('penalties', 'pen_t')), { employee_id: 'tech1', minutes: 0 }));
    });
  });

  describe('inventory + penalties DELETE mirror create (admin/manager only, round-14 fix)', () => {
    // Delete must match the create gate (admin/manager) — accountant is view-only.
    test('accountant CANNOT delete a penalty (view-only)', async () => {
      await assertFails(deleteDoc(doc(asUser('acct1'), path('penalties', 'pen1'))));
    });
    test('accountant CANNOT delete an inventory item (view-only)', async () => {
      await assertFails(deleteDoc(doc(asUser('acct1'), path('inventory', 'inv1'))));
    });
    test('manager CAN delete a penalty', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('mgrA'), path('penalties', 'pen1'))));
    });
    test('manager CAN delete an inventory item', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('mgrA'), path('inventory', 'inv1'))));
    });
    test('tech CANNOT delete a penalty', async () => {
      await assertFails(deleteDoc(doc(asUser('tech1'), path('penalties', 'pen1'))));
    });
  });

  describe('users/{uid} mirror — no privilege escalation (verification fix)', () => {
    test('tech CANNOT self-create mirror as admin via a forged employee_id', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('users', 'tech1')), { role: 'admin', employee_id: 'admin1' }));
    });
    test('tech CAN create own mirror with the role matching its OWN employee doc', async () => {
      await assertSucceeds(setDoc(doc(asUser('tech1'), path('users', 'tech1')), { role: 'tech' }));
    });
    test('tech CANNOT write a mirror at another uid', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('users', 'admin1')), { role: 'tech' }));
    });
  });

  describe('inventory writes — admin/manager only (verification fix)', () => {
    test('admin CAN create inventory', async () => {
      await assertSucceeds(setDoc(doc(asUser('admin1'), path('inventory', 'inv_a')), { name: 'LED', rate_per_day: 500 }));
    });
    test('manager CAN create inventory', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('inventory', 'inv_m')), { name: 'Truss', rate_per_day: 200 }));
    });
    test('tech CANNOT create/edit inventory (rate/cost tamper)', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('inventory', 'inv_t')), { name: 'X', rate_per_day: 999 }));
    });
    test('coordinator CANNOT create inventory', async () => {
      await assertFails(setDoc(doc(asUser('u1'), path('inventory', 'inv_u')), { name: 'Y', rate_per_day: 1 }));
    });
  });

  // Documents the CURRENT accepted carve-out (by decision/risk). If one starts
  // FAILING, the rule was tightened (flip it to assertFails).
  describe('accepted carve-out — operational reads with money hidden in the UI', () => {
    test('tech CAN read a project operationally (dispatch/challan flows; money UI-hidden)', async () => {
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('projects', 'projA'))));
    });
    test('tech CAN read inventory operationally (rate/cost embedded; hidden in UI; field-split is the future fix)', async () => {
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('inventory', 'inv1'))));
    });
  });
});
