import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/utils/aiAccountant/nlu.js';
import { fuelContext } from '../src/utils/aiAccountant/knowledge.js';
import { validateTransaction, canPost, auditFromIssues } from '../src/utils/aiAccountant/index.js';

// Rahul / Raj are EMPLOYEES here (never clients/vendors). Acme/SuppliCo are parties.
const CTX = { partyNames: ['Acme Corp', 'SuppliCo'], employeeNames: ['Rahul', 'Raj'], date: '2026-04-25' };
const hasIssue = (tx, code) => (tx.issues || []).some((i) => i.code === code);

describe('Employee reimbursement (explicit cue → Dr Expense / Cr Employee: <name>)', () => {
  it('"reimburse Rahul 2000 for site food" → reimbursement to Rahul, Food Expense', () => {
    const tx = parseMessage('reimburse Rahul 2000 for site food', CTX);
    expect(tx.intent).toBe('reimbursement');
    expect(tx.entries).toHaveLength(1);
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Food Expense', creditAccount: 'Employee: Rahul', amount: 2000 });
    expect(tx.party).toMatchObject({ type: 'employee', name: 'Rahul' });
    expect(hasIssue(tx, 'employee_expense_ambiguous')).toBe(false);
    expect(hasIssue(tx, 'fuel_account_ambiguous')).toBe(false);
  });

  it('"paid on behalf of Raj 1500 for printing" → reimbursement to Raj, Printing & Stationery', () => {
    const tx = parseMessage('paid on behalf of Raj 1500 for printing', CTX);
    expect(tx.intent).toBe('reimbursement');
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Printing & Stationery', creditAccount: 'Employee: Raj', amount: 1500 });
    expect(tx.party).toMatchObject({ type: 'employee', name: 'Raj' });
  });

  it('carries the per-employee account in accountCreates typed dual-use (Asset/Party)', () => {
    const tx = parseMessage('reimburse Rahul 2000 for taxi', CTX);
    const ep = (tx.accountCreates || []).find((a) => a.name === 'Employee: Rahul');
    expect(ep).toBeTruthy();
    expect(ep.type).toBe('Asset');       // dual-use like Party: — nets liability by sign in the ledger
    expect(ep.subType).toBe('Party');
    expect(ep.normalSide).toBe('Dr');
  });

  it('a reimbursement draft is postable with no expense-credited warning', () => {
    const tx = validateTransaction(parseMessage('reimburse Rahul 2000 for taxi', CTX), { knownAccounts: ['Food Expense', 'Travelling & Conveyance', 'Employee: Rahul'] });
    expect(canPost(tx)).toBe(true);
    expect(hasIssue(tx, 'expense_credited')).toBe(false);
    expect(hasIssue(tx, 'advance_as_expense')).toBe(false);
  });
});

describe('Advance (regression — Dr Employee: <name> / Cr cash|bank)', () => {
  it('"advance 5000 to Raj" → Employee: Raj / Cash, employee Raj', () => {
    const tx = parseMessage('advance 5000 to Raj', CTX);
    expect(tx.intent).toBe('advance');
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Employee: Raj', creditAccount: 'Cash', amount: 5000 });
    expect(tx.party).toMatchObject({ type: 'employee', name: 'Raj' });
  });

  it('"gave 5000 advance to Raj via bank" → credits Bank', () => {
    const tx = parseMessage('gave 5000 advance to Raj via bank', CTX);
    expect(tx.intent).toBe('advance');
    expect(tx.entries[0].creditAccount).toBe('Bank');
  });
});

describe('Company-paid expense (unchanged, no employee liability)', () => {
  it('"spent 5000 on taxi" → Travelling & Conveyance / Cash, no advisory', () => {
    const tx = parseMessage('spent 5000 on taxi', CTX);
    expect(tx.intent).toBe('expense');
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Travelling & Conveyance', creditAccount: 'Cash', amount: 5000 });
    expect(hasIssue(tx, 'employee_expense_ambiguous')).toBe(false);
  });

  it('"paid 20k to Acme Corp" (known vendor) → payment, no reimbursement/advisory', () => {
    const tx = parseMessage('paid 20k to Acme Corp', CTX);
    expect(tx.intent).toBe('payment');
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Party: Acme Corp', creditAccount: 'Cash' });
    expect(hasIssue(tx, 'employee_expense_ambiguous')).toBe(false);
  });
});

describe('Implicit employee spend → advisory only (never silently rerouted)', () => {
  it('"Rahul paid 2000 for taxi" (known employee) → advisory naming Rahul, not reimbursement', () => {
    const tx = parseMessage('Rahul paid 2000 for taxi', CTX);
    expect(tx.intent).not.toBe('reimbursement');
    expect(hasIssue(tx, 'employee_expense_ambiguous')).toBe(true);
    expect((tx.issues || []).find((i) => i.code === 'employee_expense_ambiguous').message).toMatch(/Rahul/);
  });

  it('"cash paid 2000 for taxi" (not an employee) → no advisory (avoids false positive)', () => {
    const tx = parseMessage('cash paid 2000 for taxi', CTX);
    expect(hasIssue(tx, 'employee_expense_ambiguous')).toBe(false);
  });
});

describe('Fuel "ask each time"', () => {
  it('fuelContext disambiguates generator / vehicle / ambiguous / none', () => {
    expect(fuelContext('diesel for generator')).toBe('generator');
    expect(fuelContext('petrol for bike')).toBe('vehicle');
    expect(fuelContext('fuel 5000')).toBe('ambiguous');
    expect(fuelContext('office rent')).toBe(null);
  });

  it('"spent 5000 on fuel" → Site Power & Fuel + advisory to confirm', () => {
    const tx = parseMessage('spent 5000 on fuel', CTX);
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Site Power & Fuel', creditAccount: 'Cash', amount: 5000 });
    expect(hasIssue(tx, 'fuel_account_ambiguous')).toBe(true);
    expect((tx.issues || []).find((i) => i.code === 'fuel_account_ambiguous').level).toBe('info');
  });

  it('"diesel 4000 for generator" → Site Power & Fuel, no advisory', () => {
    const tx = parseMessage('diesel 4000 for generator', CTX);
    expect(tx.entries[0].debitAccount).toBe('Site Power & Fuel');
    expect(hasIssue(tx, 'fuel_account_ambiguous')).toBe(false);
  });

  it('"petrol 1000 for car" → reclassified to Travelling & Conveyance, no advisory', () => {
    const tx = parseMessage('petrol 1000 for car', CTX);
    expect(tx.entries[0].debitAccount).toBe('Travelling & Conveyance');
    expect(hasIssue(tx, 'fuel_account_ambiguous')).toBe(false);
  });

  it('"bike petrol 500" → vehicle fuel → Travelling & Conveyance', () => {
    const tx = parseMessage('bike petrol 500', CTX);
    expect(tx.entries[0].debitAccount).toBe('Travelling & Conveyance');
  });

  it('the fuel advisory flows through validateTransaction → auditFromIssues as an advisory finding', () => {
    const tx = validateTransaction(parseMessage('spent 5000 on fuel', CTX), { knownAccounts: ['Site Power & Fuel', 'Cash'] });
    const audit = auditFromIssues(tx);
    expect(audit.blocking).toBe(false);
    expect(audit.findings.some((f) => f.code === 'fuel_account_ambiguous' && f.severity === 'advisory')).toBe(true);
  });
});

describe('Regression guards for existing intents', () => {
  it('"salary 30000 to Rahul" stays salary even with Rahul an employee', () => {
    const tx = parseMessage('salary 30000 to Rahul', CTX);
    expect(tx.intent).toBe('salary');
    expect(tx.entries[0].debitAccount).toBe('Salary Expense');
    expect(tx.party.type).toBe('employee');
  });

  it('"spent 5000 on travel" still maps to Travelling & Conveyance', () => {
    const tx = parseMessage('spent 5000 on travel', CTX);
    expect(tx.entries[0].debitAccount).toBe('Travelling & Conveyance');
    expect(hasIssue(tx, 'fuel_account_ambiguous')).toBe(false);
  });

  it('split expense "spent 5000 on travel and 2000 on food" still splits', () => {
    const tx = parseMessage('spent 5000 on travel and 2000 on food', CTX);
    expect(tx.meta.split).toBe(true);
    expect(tx.entries.map((e) => e.debitAccount)).toEqual(['Travelling & Conveyance', 'Food Expense']);
  });
});
