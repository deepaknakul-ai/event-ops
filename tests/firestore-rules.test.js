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
import { doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, query, where, collection } from 'firebase/firestore';

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
      await setDoc(doc(db, path('project_financials', 'projA')), { client_owner_id: 'mgrA', created_by: 'mgrA', package_cost: 5000 });
      await setDoc(doc(db, path('project_financials', 'pf_created')), { client_owner_id: '', created_by: 'mgrB', package_cost: 1000 });
      await setDoc(doc(db, path('project_financials', 'pf_coord')), { client_owner_id: 'u1', created_by: 'mgrA', package_cost: 800 });
      await setDoc(doc(db, path('audit_logs', 'log1')), { action: 'test' });
      await setDoc(doc(db, path('journal_entries', 'je1')), { debit_amount: 100 });
      await setDoc(doc(db, path('chart_of_accounts', 'coa1')), { name: 'Cash' });
      await setDoc(doc(db, path('payouts', 'po_u1')), { employee_id: 'u1', amount: 500 });
      await setDoc(doc(db, path('payouts', 'po_mgrA')), { employee_id: 'mgrA', amount: 700 });
      await setDoc(doc(db, path('advances', 'adv_u1')), { employee_id: 'u1', amount: 200 });
      await setDoc(doc(db, path('tax_invoices', 'ti1')), { client_id: 'cA', final_amount: 5000, invoice_no: 'TI-1' });
      await setDoc(doc(db, path('vendor_payments', 'vp1')), { vendor_id: 'vX', amount: 300 });
      await setDoc(doc(db, path('purchase_invoices', 'pi1')), { vendor_id: 'vX', amount: 400 });
      await setDoc(doc(db, path('leads', 'ld_mgrA')), { name: 'Lead A', created_by: 'mgrA', est_value: 90000 });
      await setDoc(doc(db, path('leads', 'ld_mgrB')), { name: 'Lead B', created_by: 'mgrB', est_value: 50000 });
      await setDoc(doc(db, path('payroll', 'pr1')), { employee_id: 'tech1', grossPay: 50000, netPay: 45000, deductions: 5000 });
      await setDoc(doc(db, path('inventory', 'inv1')), { name: 'LED Panel', rate_per_day: 500, purchase_cost: 40000 });
      await setDoc(doc(db, path('inventory_financials', 'inv1')), { rate_per_day: 500, purchase_cost: 40000 });
      await setDoc(doc(db, path('employee_pay', 'tech1')), { hourlyRate: 200, hourlyRateHistory: [] });
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
    test('manager CANNOT read a purchase invoice (round-17: admin/accountant-only)', async () => {
      await assertFails(getDoc(doc(asUser('mgrA'), path('purchase_invoices', 'pi1'))));
    });
    test('manager CANNOT list purchase_invoices (round-17)', async () => {
      await assertFails(getDocs(collection(asUser('mgrA'), path('purchase_invoices'))));
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
      // The manager receipt flow always stamps 'Pending Review' + own client_owner_id.
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('payments', 'pay_recpt')), { client_id: 'cA', amount: 100, date: '2026-07-02', mode: 'Cash', status: 'Pending Review', client_owner_id: 'mgrA' }));
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
    test('manager CAN create a receipt in Pending Review for OWN client', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('payments', 'pay_mgr_new')), { client_id: 'cA', amount: 500, status: 'Pending Review', client_owner_id: 'mgrA' }));
    });
    test('manager CANNOT create a receipt for another manager\'s client (round-16 own-scope)', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('payments', 'pay_mgr_other')), { client_id: 'cB', amount: 500, status: 'Pending Review', client_owner_id: 'mgrB' }));
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

  describe('project_financials sibling — field-split slice 3 (money owner-scoped)', () => {
    // Read: admin/accountant all; manager ONLY own (client_owner_id/created_by == uid);
    // tech/user never. Client writes denied (Admin SDK trigger maintains it).
    test('accountant CAN read any project_financials', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('project_financials', 'projA'))));
    });
    test('owning manager CAN read own project_financials (client_owner_id)', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('project_financials', 'projA'))));
    });
    test('manager CAN read own project_financials via created_by', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrB'), path('project_financials', 'pf_created'))));
    });
    test('non-owning manager CANNOT read another manager\'s project_financials', async () => {
      await assertFails(getDoc(doc(asUser('mgrB'), path('project_financials', 'projA'))));
    });
    test('tech CANNOT read project_financials', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('project_financials', 'projA'))));
    });
    test('coordinator CANNOT read a project_financials they do NOT own', async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('project_financials', 'projA'))));
    });
    test('coordinator CAN read a project_financials for a client THEY referred (commission)', async () => {
      await assertSucceeds(getDoc(doc(asUser('u1'), path('project_financials', 'pf_coord'))));
    });
    test('coordinator CAN list OWN project_financials (scoped query)', async () => {
      await assertSucceeds(getDocs(query(collection(asUser('u1'), path('project_financials')), where('client_owner_id', '==', 'u1'))));
    });
    test('tech CANNOT read even an owner-scoped project_financials (owns none)', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('project_financials', 'pf_coord'))));
    });
    test('tech CANNOT list project_financials', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('project_financials'))));
    });
    test('manager CANNOT list ALL project_financials (unscoped)', async () => {
      await assertFails(getDocs(collection(asUser('mgrA'), path('project_financials'))));
    });
    test('manager CAN list OWN project_financials (scoped query)', async () => {
      await assertSucceeds(getDocs(query(collection(asUser('mgrA'), path('project_financials')), where('client_owner_id', '==', 'mgrA'))));
    });
    // Client writes denied — only the onProjectWritten trigger (Admin SDK) writes it.
    test('manager CANNOT client-write project_financials', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('project_financials', 'projA')), { package_cost: 1 }));
    });
    test('accountant CANNOT client-write project_financials', async () => {
      await assertFails(setDoc(doc(asUser('acct1'), path('project_financials', 'pf_x')), { package_cost: 1 }));
    });
  });

  describe('employee_pay sibling — field-split slice 2 (pay gated, view_pay only)', () => {
    // Read/write: admin/accountant (view_pay) only. manager/tech/user denied — pay
    // must never enter a non-finance role's client state via the SDK.
    test('accountant CAN read employee_pay', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('employee_pay', 'tech1'))));
    });
    test('manager CANNOT read employee_pay', async () => {
      await assertFails(getDoc(doc(asUser('mgrA'), path('employee_pay', 'tech1'))));
    });
    test('tech CANNOT read own employee_pay', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('employee_pay', 'tech1'))));
    });
    test('tech CANNOT list employee_pay', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('employee_pay'))));
    });
    test('accountant CAN write employee_pay', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('employee_pay', 'ep_new')), { hourlyRate: 300 }));
    });
    test('manager CANNOT write employee_pay', async () => {
      await assertFails(setDoc(doc(asUser('mgrA'), path('employee_pay', 'ep_m')), { hourlyRate: 1 }));
    });
    test('tech CANNOT write employee_pay', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('employee_pay', 'ep_t')), { hourlyRate: 1 }));
    });
    test('accountant CAN delete employee_pay', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('acct1'), path('employee_pay', 'tech1'))));
    });
    test('manager CANNOT delete employee_pay', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('employee_pay', 'tech1'))));
    });
  });

  describe('inventory_financials sibling — field-split slice 1 (rates/costs gated)', () => {
    // Read: admin/accountant/manager (managers seed allocations from rates). tech/user denied.
    test('accountant CAN read inventory_financials', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('inventory_financials', 'inv1'))));
    });
    test('manager CAN read inventory_financials', async () => {
      await assertSucceeds(getDoc(doc(asUser('mgrA'), path('inventory_financials', 'inv1'))));
    });
    test('tech CANNOT read inventory_financials (no rate leak)', async () => {
      await assertFails(getDoc(doc(asUser('tech1'), path('inventory_financials', 'inv1'))));
    });
    test('coordinator CANNOT read inventory_financials', async () => {
      await assertFails(getDoc(doc(asUser('u1'), path('inventory_financials', 'inv1'))));
    });
    test('tech CANNOT list inventory_financials', async () => {
      await assertFails(getDocs(collection(asUser('tech1'), path('inventory_financials'))));
    });
    // Write/delete: admin/manager (mirror inventory create/edit); accountant view-only.
    test('manager CAN write inventory_financials', async () => {
      await assertSucceeds(setDoc(doc(asUser('mgrA'), path('inventory_financials', 'invf_new')), { rate_per_day: 100 }));
    });
    test('accountant CANNOT write inventory_financials (view-only)', async () => {
      await assertFails(setDoc(doc(asUser('acct1'), path('inventory_financials', 'invf_a')), { rate_per_day: 1 }));
    });
    test('tech CANNOT write inventory_financials', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('inventory_financials', 'invf_t')), { rate_per_day: 1 }));
    });
    test('manager CAN delete inventory_financials', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('mgrA'), path('inventory_financials', 'inv1'))));
    });
    test('tech CANNOT delete inventory_financials', async () => {
      await assertFails(deleteDoc(doc(asUser('tech1'), path('inventory_financials', 'inv1'))));
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

  describe('tax_invoices DELETE — admin/accountant only (round-15 fix)', () => {
    // A manager may CREATE invoices but must NOT delete them (GSTR-1 continuity);
    // permissions.js locks tax_invoices.delete to admin/accountant.
    test('manager CANNOT delete a tax invoice', async () => {
      await assertFails(deleteDoc(doc(asUser('mgrA'), path('tax_invoices', 'ti1'))));
    });
    test('tech CANNOT delete a tax invoice', async () => {
      await assertFails(deleteDoc(doc(asUser('tech1'), path('tax_invoices', 'ti1'))));
    });
    test('accountant CAN delete a tax invoice', async () => {
      await assertSucceeds(deleteDoc(doc(asUser('acct1'), path('tax_invoices', 'ti1'))));
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

  // ── Phase-2 AI assistant: key secrecy + budget-counter integrity ───────────
  describe('AI settings & usage metering', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, path('settings', 'ai')), { enabled: true, api_key: 'sk-ant-secret', model: 'claude-opus-4-8' });
        await setDoc(doc(db, path('settings', 'ai_public')), { enabled: true, model: 'claude-opus-4-8', api_key_set: true });
        await setDoc(doc(db, path('ai_usage', 'usage_2026-07')), { tokens_total: 1234, calls: 5 });
        await setDoc(doc(db, path('ai_usage', 'rl_admin1')), { minute: '2026-07-10T09:41', count: 2 });
      });
    });

    test('NOBODY can read settings/ai — not even admin (the API key doc)', async () => {
      await assertFails(getDoc(doc(asUser('admin1'), path('settings', 'ai'))));
      await assertFails(getDoc(doc(asUser('acct1'), path('settings', 'ai'))));
      await assertFails(getDoc(doc(asUser('tech1'), path('settings', 'ai'))));
      await assertFails(getDoc(doc(asAnon(), path('settings', 'ai'))));
    });
    test('admin CAN write settings/ai (blind write) — others cannot', async () => {
      await assertSucceeds(setDoc(doc(asUser('admin1'), path('settings', 'ai')), { enabled: true, api_key: 'sk-ant-new' }, { merge: true }));
      await assertFails(setDoc(doc(asUser('acct1'), path('settings', 'ai')), { api_key: 'stolen' }, { merge: true }));
      await assertFails(setDoc(doc(asUser('mgrA'), path('settings', 'ai')), { api_key: 'stolen' }, { merge: true }));
    });
    test('settings/ai_public readable by real sessions (non-secret mirror)', async () => {
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('settings', 'ai_public'))));
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('settings', 'ai_public'))));
    });
    test('ai_usage readable by admin/accountant, NOT by manager/tech', async () => {
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('ai_usage', 'usage_2026-07'))));
      await assertSucceeds(getDoc(doc(asUser('acct1'), path('ai_usage', 'usage_2026-07'))));
      await assertFails(getDoc(doc(asUser('mgrA'), path('ai_usage', 'usage_2026-07'))));
      await assertFails(getDoc(doc(asUser('tech1'), path('ai_usage', 'usage_2026-07'))));
    });
    test('ai_usage is client-unwritable for EVERY role (budget forgery closed)', async () => {
      await assertFails(setDoc(doc(asUser('admin1'), path('ai_usage', 'usage_2026-07')), { tokens_total: 0 }, { merge: true }));
      await assertFails(setDoc(doc(asUser('acct1'), path('ai_usage', 'usage_2026-07')), { tokens_total: 0 }, { merge: true }));
      await assertFails(setDoc(doc(asUser('tech1'), path('ai_usage', 'rl_tech1')), { minute: 'x', count: 0 }));
      await assertFails(deleteDoc(doc(asUser('admin1'), path('ai_usage', 'usage_2026-07'))));
    });

    // Pre-existing wildcard hole closed in this round: settings was excluded
    // from the wildcard READ but not WRITE/DELETE, letting any role overwrite
    // settings/security (admin password), settings/rbac, settings/ai, etc.
    test('non-admin roles CANNOT write ANY settings doc (wildcard bypass closed)', async () => {
      await assertFails(setDoc(doc(asUser('tech1'), path('settings', 'security')), { admin_password: 'pwned' }, { merge: true }));
      await assertFails(setDoc(doc(asUser('u1'), path('settings', 'ai')), { api_key: 'attacker-key', enabled: true }, { merge: true }));
      await assertFails(setDoc(doc(asUser('mgrA'), path('settings', 'ai_public')), { enabled: false }, { merge: true }));
      await assertFails(setDoc(doc(asUser('acct1'), path('settings', 'chat')), { presence_enabled: false }, { merge: true }));
      await assertFails(deleteDoc(doc(asUser('tech1'), path('settings', 'ai'))));
    });
    test('admin CAN still write settings docs (stanza remains authoritative)', async () => {
      await assertSucceeds(setDoc(doc(asUser('admin1'), path('settings', 'chat')), { presence_enabled: false }, { merge: true }));
      await assertSucceeds(setDoc(doc(asUser('admin1'), path('settings', 'organization')), { name: 'TERMS' }, { merge: true }));
    });
  });

  describe('journal_entries FY lock — server-enforced, binds admin (grey-area B7)', () => {
    const seedLock = () => testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, path('settings', 'organization')), { name: 'TERMS', locked_fys: ['2024-25'] });
      await setDoc(doc(db, path('journal_entries', 'je_locked')), { fy: '2024-25', date: '2024-06-01', narration: 'old', entries: [] });
      await setDoc(doc(db, path('journal_entries', 'je_open')), { fy: '2026-27', date: '2026-06-01', narration: 'new', entries: [], origin: 'ai_chat' });
    });

    test('admin CANNOT create a journal entry dated in a locked FY', async () => {
      await seedLock();
      await assertFails(setDoc(doc(asUser('admin1'), path('journal_entries', 'je_bad')), { fy: '2024-25', date: '2024-06-15', entries: [] }));
    });
    test('admin CAN create in an open FY (lock does not over-block)', async () => {
      await seedLock();
      await assertSucceeds(setDoc(doc(asUser('admin1'), path('journal_entries', 'je_ok')), { fy: '2026-27', date: '2026-06-15', entries: [] }));
    });
    test('accountant CANNOT update a locked-FY entry, nor move an entry INTO a locked FY', async () => {
      await seedLock();
      await assertFails(setDoc(doc(asUser('acct1'), path('journal_entries', 'je_locked')), { fy: '2024-25', narration: 'tampered' }, { merge: true }));
      await assertFails(setDoc(doc(asUser('acct1'), path('journal_entries', 'je_open')), { fy: '2024-25' }, { merge: true }));
    });
    test('ai_reviewed-only diff stays allowed EVEN on a locked-FY entry (metadata exemption)', async () => {
      await seedLock();
      await assertSucceeds(updateDoc(doc(asUser('acct1'), path('journal_entries', 'je_locked')), {
        ai_reviewed: true, ai_reviewed_by: 'acct1', ai_reviewed_by_name: 'Acct', ai_reviewed_at: '2026-07-17T00:00:00Z',
      }));
    });
    test('admin CANNOT hard-delete a locked-FY entry; open-FY delete still works', async () => {
      await seedLock();
      await assertFails(deleteDoc(doc(asUser('admin1'), path('journal_entries', 'je_locked'))));
      await assertSucceeds(deleteDoc(doc(asUser('admin1'), path('journal_entries', 'je_open'))));
    });
    test('no lock configured → journal writes unaffected (legacy safety)', async () => {
      await assertSucceeds(setDoc(doc(asUser('acct1'), path('journal_entries', 'je_nolock')), { fy: '2026-27', date: '2026-06-15', entries: [] }));
    });
  });

  describe('chart_of_accounts isSystem guard (grey-area C4)', () => {
    const seedCoa = () => testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, path('chart_of_accounts', 'sys1')), { code: '1000', name: 'Cash In Hand', type: 'Asset', normalSide: 'Dr', isSystem: true, isActive: true });
      await setDoc(doc(db, path('chart_of_accounts', 'man1')), { code: '9001', name: 'Custom Head', type: 'Expense', normalSide: 'Dr', isSystem: false, isActive: true });
    });

    test('accountant CANNOT retype/rename/de-flag a SYSTEM account', async () => {
      await seedCoa();
      await assertFails(updateDoc(doc(asUser('acct1'), path('chart_of_accounts', 'sys1')), { type: 'Equity' }));
      await assertFails(updateDoc(doc(asUser('acct1'), path('chart_of_accounts', 'sys1')), { name: 'Slush Fund' }));
      await assertFails(updateDoc(doc(asUser('acct1'), path('chart_of_accounts', 'sys1')), { isSystem: false }));
    });
    test('accountant CAN toggle isActive / edit subType on a SYSTEM account (deactivation feature)', async () => {
      await seedCoa();
      await assertSucceeds(updateDoc(doc(asUser('acct1'), path('chart_of_accounts', 'sys1')), { isActive: false, updated_by: 'acct1' }));
      await assertSucceeds(updateDoc(doc(asUser('acct1'), path('chart_of_accounts', 'sys1')), { subType: 'Petty Cash' }));
    });
    test('manual accounts stay fully editable; system heads cannot be deleted even by admin', async () => {
      await seedCoa();
      await assertSucceeds(updateDoc(doc(asUser('acct1'), path('chart_of_accounts', 'man1')), { type: 'Asset', name: 'Renamed Head' }));
      await assertFails(deleteDoc(doc(asUser('admin1'), path('chart_of_accounts', 'sys1'))));
      await assertSucceeds(deleteDoc(doc(asUser('admin1'), path('chart_of_accounts', 'man1'))));
    });
  });

  // ── Cross-tenant credit intelligence ────────────────────────────────────────
  // The NUMERIC score (platform_credit_scores) is control-plane, staff-only; the
  // COLOUR projection (settings/credit_labels) is tenant-readable but server-write.
  describe('credit intelligence — score is staff-only, labels are read-only for tenants', () => {
    // A platform-staff session: staff:true + staff_role claim (mirrors the token
    // verifyLogin/platformLogin mint). staffData() reads platform_staff/{uid}.
    const asStaff = (uid, role) => testEnv.authenticatedContext(uid, { staff: true, staff_role: role }).firestore();

    const seedCredit = () => testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'platform_credit_scores/PAN1'), { pan: 'PAN1', band: 'red', score: 18, computed_by: 'system:credit' });
      await setDoc(doc(db, 'platform_staff/super1'), { role: 'super_admin', status: 'active' });
      await setDoc(doc(db, 'platform_staff/trusted1'), { role: 'business_manager', status: 'active', can_view_credit: true });
      await setDoc(doc(db, 'platform_staff/plain1'), { role: 'business_manager', status: 'active', can_view_credit: false });
      await setDoc(doc(db, path('settings', 'credit_labels')), { labels: { cA: { band: 'red' } }, updated_at: 'x' });
    });

    test('super_admin and trusted (can_view_credit) staff CAN read a score', async () => {
      await seedCredit();
      await assertSucceeds(getDoc(doc(asStaff('super1', 'super_admin'), 'platform_credit_scores/PAN1')));
      await assertSucceeds(getDoc(doc(asStaff('trusted1', 'business_manager'), 'platform_credit_scores/PAN1')));
    });

    test('untrusted staff and tenant users and anon CANNOT read a score', async () => {
      await seedCredit();
      await assertFails(getDoc(doc(asStaff('plain1', 'business_manager'), 'platform_credit_scores/PAN1')));
      await assertFails(getDoc(doc(asUser('admin1'), 'platform_credit_scores/PAN1'))); // tenant admin — no staff claim
      await assertFails(getDoc(doc(asUser('u1'), 'platform_credit_scores/PAN1')));
      await assertFails(getDoc(doc(asAnon(), 'platform_credit_scores/PAN1')));
    });

    test('NOBODY can write a score — not even a super_admin (Admin SDK only)', async () => {
      await seedCredit();
      await assertFails(setDoc(doc(asStaff('super1', 'super_admin'), 'platform_credit_scores/PAN1'), { band: 'green' }, { merge: true }));
      await assertFails(setDoc(doc(asStaff('trusted1', 'business_manager'), 'platform_credit_scores/PAN9'), { band: 'green' }));
      await assertFails(deleteDoc(doc(asStaff('super1', 'super_admin'), 'platform_credit_scores/PAN1')));
    });

    test('settings/credit_labels is readable by any real tenant session, NOT anon', async () => {
      await seedCredit();
      await assertSucceeds(getDoc(doc(asUser('admin1'), path('settings', 'credit_labels'))));
      await assertSucceeds(getDoc(doc(asUser('u1'), path('settings', 'credit_labels'))));
      await assertSucceeds(getDoc(doc(asUser('tech1'), path('settings', 'credit_labels'))));
      await assertFails(getDoc(doc(asAnon(), path('settings', 'credit_labels'))));
    });

    test('settings/credit_labels is client-UNwritable for every tenant role (server-only)', async () => {
      await seedCredit();
      await assertFails(setDoc(doc(asUser('admin1'), path('settings', 'credit_labels')), { labels: { cA: { band: 'green' } } }, { merge: true }));
      await assertFails(setDoc(doc(asUser('acct1'), path('settings', 'credit_labels')), { labels: {} }, { merge: true }));
      await assertFails(deleteDoc(doc(asUser('admin1'), path('settings', 'credit_labels'))));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PARTNERSHIP MODULE — partner role visibility, spend threshold, no-self-
  // approval, dual sign-off, consent register, governance lock.
  // Gating: settings/organization.firm_type == 'partnership' AND
  // settings/partnership {enabled, min_partners_met}. Every control below must
  // be INERT for a proprietorship (verified at the end).
  // ═══════════════════════════════════════════════════════════════════════════
  describe('partnership module', () => {
    const seedPartnership = async (overrides = {}) => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, path('employees', 'partner1')), { role: 'partner', name: 'Partner One' });
        await setDoc(doc(db, path('employees', 'partner2')), { role: 'partner', name: 'Partner Two' });
        await setDoc(doc(db, path('settings', 'organization')), { name: 'Firm', firm_type: 'partnership' });
        await setDoc(doc(db, path('settings', 'partnership')), {
          enabled: true, min_partners_met: true, approval_threshold: 50000,
          partners: {
            admin1:   { name: 'Admin',       active: true },
            partner1: { name: 'Partner One', active: true },
            partner2: { name: 'Partner Two', active: true },
          },
          ...overrides,
        });
      });
    };

    describe('partner role — books read (s.12(d)), no writes', () => {
      test('partner reads journal entries, chart, payroll, purchase invoices', async () => {
        await seedPartnership();
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('journal_entries', 'je1'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('chart_of_accounts', 'coa1'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('payroll', 'pr1'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('purchase_invoices', 'pi1'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('payouts', 'po_mgrA'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('tax_invoices', 'ti1'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('payments', 'pay1'))));
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('expenses', 'exp_tech'))));
      });
      test('partner reads the audit trail', async () => {
        await seedPartnership();
        await assertSucceeds(getDoc(doc(asUser('partner1'), path('audit_logs', 'log1'))));
      });
      test('partner CANNOT write the ledger or delete an invoice', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('partner1'), path('journal_entries', 'je_new')), { debit_amount: 1 }));
        await assertFails(deleteDoc(doc(asUser('partner1'), path('tax_invoices', 'ti1'))));
        await assertFails(setDoc(doc(asUser('partner1'), path('payments', 'p_new')), { amount: 1 }));
      });
    });

    describe('vendor payments — spend threshold + no self-approval', () => {
      test('above-threshold payment must be born pending', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('admin1'), path('vendor_payments', 'vp_big')),
          { vendor_id: 'vX', amount: 60000, created_by_emp: 'admin1' }));
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('vendor_payments', 'vp_big')),
          { vendor_id: 'vX', amount: 60000, created_by_emp: 'admin1',
            partner_approval_status: 'pending', partner_approved_by: null, partner_approved_at: null }));
      });
      test('below-threshold payment needs nothing extra', async () => {
        await seedPartnership();
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('vendor_payments', 'vp_small')),
          { vendor_id: 'vX', amount: 40000, created_by_emp: 'admin1' }));
      });
      test('a DIFFERENT named partner approves; the creator cannot', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('vendor_payments', 'vp_p')),
            { vendor_id: 'vX', amount: 60000, created_by_emp: 'admin1',
              partner_approval_status: 'pending', partner_approved_by: null, partner_approved_at: null });
        });
        await assertFails(updateDoc(doc(asUser('admin1'), path('vendor_payments', 'vp_p')),
          { partner_approval_status: 'approved', partner_approved_by: 'admin1', partner_approved_at: 'now' }));
        await assertFails(updateDoc(doc(asUser('mgrA'), path('vendor_payments', 'vp_p')),
          { partner_approval_status: 'approved', partner_approved_by: 'mgrA', partner_approved_at: 'now' }));
        await assertFails(updateDoc(doc(asUser('partner1'), path('vendor_payments', 'vp_p')),
          { partner_approval_status: 'approved', partner_approved_by: 'partner2', partner_approved_at: 'now' }));
        await assertSucceeds(updateDoc(doc(asUser('partner1'), path('vendor_payments', 'vp_p')),
          { partner_approval_status: 'approved', partner_approved_by: 'partner1', partner_approved_at: 'now' }));
      });
      test('pure-partner role may ONLY touch the approval fields', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('vendor_payments', 'vp_q')),
            { vendor_id: 'vX', amount: 60000, created_by_emp: 'admin1',
              partner_approval_status: 'pending', partner_approved_by: null, partner_approved_at: null });
        });
        await assertFails(updateDoc(doc(asUser('partner1'), path('vendor_payments', 'vp_q')),
          { partner_approval_status: 'approved', partner_approved_by: 'partner1', partner_approved_at: 'now', amount: 99999 }));
      });
      test('raising the amount past the threshold sends it back to pending', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('vendor_payments', 'vp_r')),
            { vendor_id: 'vX', amount: 40000, created_by_emp: 'acct1' });
        });
        await assertFails(updateDoc(doc(asUser('acct1'), path('vendor_payments', 'vp_r')), { amount: 90000 }));
        await assertSucceeds(updateDoc(doc(asUser('acct1'), path('vendor_payments', 'vp_r')),
          { amount: 90000, partner_approval_status: 'pending' }));
      });
    });

    describe('journal drafts — no self-approval binds even the Owner', () => {
      const seedDraft = async (createdBy) => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('journal_drafts', 'jd1')),
            { narration: 'test', created_by: createdBy, requires_approval: true,
              approval_status: 'pending', approved_by: null, approved_at: null });
        });
      };
      test('creator-admin CANNOT approve their own draft', async () => {
        await seedPartnership(); await seedDraft('admin1');
        await assertFails(updateDoc(doc(asUser('admin1'), path('journal_drafts', 'jd1')),
          { approval_status: 'approved', approved_by: 'admin1', approved_at: 'now' }));
      });
      test('a named partner approves it with their own stamp', async () => {
        await seedPartnership(); await seedDraft('admin1');
        await assertFails(updateDoc(doc(asUser('partner1'), path('journal_drafts', 'jd1')),
          { approval_status: 'approved', approved_by: 'admin1', approved_at: 'now' }));
        await assertSucceeds(updateDoc(doc(asUser('partner1'), path('journal_drafts', 'jd1')),
          { approval_status: 'approved', approved_by: 'partner1', approved_at: 'now' }));
      });
      test('pure-partner role cannot edit draft CONTENT', async () => {
        await seedPartnership(); await seedDraft('admin1');
        await assertFails(updateDoc(doc(asUser('partner1'), path('journal_drafts', 'jd1')), { narration: 'tampered' }));
      });
    });

    describe('expenses — threshold + no self-approval', () => {
      test('above-threshold expense must carry pending partner fields at create', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('tech1'), path('expenses', 'exp_big')),
          { employee_id: 'tech1', amount: 70000, status: 'Pending' }));
        await assertSucceeds(setDoc(doc(asUser('tech1'), path('expenses', 'exp_big')),
          { employee_id: 'tech1', amount: 70000, status: 'Pending',
            partner_approval_status: 'pending', partner_approved_by: null }));
      });
      test('cannot flip to Approved before the partner counter-approval', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('expenses', 'exp_gate')),
            { employee_id: 'tech1', amount: 70000, status: 'Pending',
              partner_approval_status: 'pending', partner_approved_by: null });
        });
        await assertFails(updateDoc(doc(asUser('admin1'), path('expenses', 'exp_gate')),
          { status: 'Approved', approved_by: 'admin1' }));
        await assertSucceeds(updateDoc(doc(asUser('partner1'), path('expenses', 'exp_gate')),
          { partner_approval_status: 'approved', partner_approved_by: 'partner1', partner_approved_at: 'now' }));
        await assertSucceeds(updateDoc(doc(asUser('admin1'), path('expenses', 'exp_gate')),
          { status: 'Approved', approved_by: 'admin1' }));
      });
      test('a partner cannot countersign their OWN expense', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('expenses', 'exp_own')),
            { employee_id: 'partner1', amount: 70000, status: 'Pending',
              partner_approval_status: 'pending', partner_approved_by: null });
        });
        await assertFails(updateDoc(doc(asUser('partner1'), path('expenses', 'exp_own')),
          { partner_approval_status: 'approved', partner_approved_by: 'partner1', partner_approved_at: 'now' }));
      });
      test('approver cannot approve their own spend (below threshold too)', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('expenses', 'exp_self')),
            { employee_id: 'admin1', amount: 900, status: 'Pending' });
        });
        await assertFails(updateDoc(doc(asUser('admin1'), path('expenses', 'exp_self')),
          { status: 'Approved', approved_by: 'admin1' }));
        await assertSucceeds(updateDoc(doc(asUser('acct1'), path('expenses', 'exp_self')),
          { status: 'Approved', approved_by: 'acct1' }));
      });
    });

    describe('pending_actions — two different named partners', () => {
      test('create: initiator may pre-sign slot 1 with OWN id only', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('partner1'), path('pending_actions', 'fy_close_2025-26')),
          { type: 'fy_close', initiated_by: 'partner1', sig1: { emp: 'partner2', at: 'now' }, sig2: null }));
        await assertSucceeds(setDoc(doc(asUser('partner1'), path('pending_actions', 'fy_close_2025-26')),
          { type: 'fy_close', initiated_by: 'partner1', sig1: { emp: 'partner1', at: 'now' }, sig2: null }));
      });
      test('slot 2: different partner only; duplicates and outsiders denied', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('pending_actions', 'act1')),
            { type: 'fy_close', initiated_by: 'partner1', sig1: { emp: 'partner1', at: 'now' }, sig2: null });
        });
        await assertFails(updateDoc(doc(asUser('partner1'), path('pending_actions', 'act1')),
          { sig2: { emp: 'partner1', at: 'now' } }));
        await assertFails(updateDoc(doc(asUser('mgrA'), path('pending_actions', 'act1')),
          { sig2: { emp: 'mgrA', at: 'now' } }));
        await assertFails(updateDoc(doc(asUser('partner2'), path('pending_actions', 'act1')),
          { sig2: { emp: 'partner2', at: 'now' }, type: 'tampered' }));
        await assertSucceeds(updateDoc(doc(asUser('partner2'), path('pending_actions', 'act1')),
          { sig2: { emp: 'partner2', at: 'now' } }));
      });
    });

    describe('dual-signed events', () => {
      const seedSigned = async (id) => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('pending_actions', id)),
            { type: 't', initiated_by: 'partner1',
              sig1: { emp: 'partner1', at: 'now' }, sig2: { emp: 'partner2', at: 'now' } });
        });
      };
      test('FY close blocked until fy_close_{fy} is dual-signed', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('admin1'), path('fiscal_year_closings', '2025-26')),
          { fy: '2025-26', status: 'closed', closed_by: 'admin1' }));
        await seedSigned('fy_close_2025-26');
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('fiscal_year_closings', '2025-26')),
          { fy: '2025-26', status: 'closed', closed_by: 'admin1' }));
      });
      test('invoice cancellation blocked until invoice_cancel_{id} is dual-signed', async () => {
        await seedPartnership();
        await assertFails(updateDoc(doc(asUser('admin1'), path('tax_invoices', 'ti1')), { status: 'Cancelled' }));
        await seedSigned('invoice_cancel_ti1');
        await assertSucceeds(updateDoc(doc(asUser('admin1'), path('tax_invoices', 'ti1')), { status: 'Cancelled' }));
      });
      test('governance: settings/partnership locked behind partnership_settings sign-off', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('admin1'), path('settings', 'partnership')),
          { enabled: false }, { merge: true }));
        await seedSigned('partnership_settings');
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('settings', 'partnership')),
          { approval_threshold: 100000 }, { merge: true }));
      });
    });

    describe('partner_consents — s.12(c) vote isolation', () => {
      test('only a named partner proposes; proposer stamp enforced', async () => {
        await seedPartnership();
        await assertFails(setDoc(doc(asUser('mgrA'), path('partner_consents', 'c1')),
          { title: 'x', proposed_by: 'mgrA', status: 'open', category: 'ordinary' }));
        await assertFails(setDoc(doc(asUser('partner1'), path('partner_consents', 'c1')),
          { title: 'x', proposed_by: 'partner2', status: 'open', category: 'ordinary' }));
        await assertSucceeds(setDoc(doc(asUser('partner1'), path('partner_consents', 'c1')),
          { title: 'x', proposed_by: 'partner1', status: 'open', category: 'ordinary' }));
      });
      test('each partner writes ONLY their own vote field', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('partner_consents', 'c2')),
            { title: 'x', proposed_by: 'partner1', status: 'open', category: 'ordinary' });
        });
        await assertFails(updateDoc(doc(asUser('partner2'), path('partner_consents', 'c2')),
          { vote_partner1: { vote: 'yes', at: 'now' } }));
        await assertFails(updateDoc(doc(asUser('mgrA'), path('partner_consents', 'c2')),
          { vote_mgrA: { vote: 'yes', at: 'now' } }));
        await assertSucceeds(updateDoc(doc(asUser('partner2'), path('partner_consents', 'c2')),
          { vote_partner2: { vote: 'yes', at: 'now' } }));
      });
      test('withdraw is proposer-only; a closed resolution is immutable', async () => {
        await seedPartnership();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('partner_consents', 'c3')),
            { title: 'x', proposed_by: 'partner1', status: 'open', category: 'fundamental' });
        });
        await assertFails(updateDoc(doc(asUser('partner2'), path('partner_consents', 'c3')),
          { status: 'withdrawn', closed_at: 'now', closed_by: 'partner2' }));
        await assertSucceeds(updateDoc(doc(asUser('partner2'), path('partner_consents', 'c3')),
          { status: 'rejected', closed_at: 'now', closed_by: 'partner2' }));
        await assertFails(updateDoc(doc(asUser('partner1'), path('partner_consents', 'c3')),
          { vote_partner1: { vote: 'yes', at: 'now' } }));
        await assertFails(deleteDoc(doc(asUser('admin1'), path('partner_consents', 'c3'))));
      });
    });

    describe('proprietorship stays EXACTLY as before (controls inert)', () => {
      test('no firm_type: big vendor payment, self-approval, FY close all work as today', async () => {
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('vendor_payments', 'vp_plain')),
          { vendor_id: 'vX', amount: 500000 }));
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('journal_drafts', 'jd_p')),
            { narration: 'x', created_by: 'admin1', approval_status: 'pending', approved_by: null });
        });
        await assertSucceeds(updateDoc(doc(asUser('admin1'), path('journal_drafts', 'jd_p')),
          { approval_status: 'approved', approved_by: 'admin1', approved_at: 'now' }));
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('fiscal_year_closings', '2025-26')),
          { fy: '2025-26', status: 'closed', closed_by: 'admin1' }));
        await assertSucceeds(updateDoc(doc(asUser('admin1'), path('tax_invoices', 'ti1')), { status: 'Cancelled' }));
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('settings', 'partnership')),
          { enabled: true, partners: {} }));
      });
      test('declared proprietorship: same freedom', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), path('settings', 'organization')), { name: 'Solo', firm_type: 'proprietorship' });
        });
        await assertSucceeds(setDoc(doc(asUser('admin1'), path('vendor_payments', 'vp_solo')),
          { vendor_id: 'vX', amount: 500000 }));
      });
    });
  });
});
