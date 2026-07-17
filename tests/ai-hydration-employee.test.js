import { describe, it, expect } from 'vitest';
import { hydrateLlmTransaction, buildAiContext } from '../src/utils/aiParse.js';
import { capContext, buildVolatileContext, sanitizeLlmTransaction } from '../functions/ai-sanitize.js';

// A3 — the LLM path must land employee money in the SAME per-employee accounts
// as the rules engine (previously: flat 'Employee Advances', no reimbursement
// intent, no employee roster in the context).
const CTX = { partyNames: ['Rahul Traders', 'Acme Corp'], allAccounts: ['Cash', 'Bank', 'Employee: Rahul'], employeeNames: ['Rahul', 'Raju'] };

describe('hydrateLlmTransaction — employee grounding', () => {
  it('rewrites a flat Employee Advances leg to the per-employee account', () => {
    const out = hydrateLlmTransaction({
      intent: 'advance', date: '2026-07-01', narration: 'advance to raju',
      party: { type: 'employee', name: 'raju' },
      entries: [{ debitAccount: 'Employee Advances', creditAccount: 'Cash', amount: 10000 }],
    }, CTX);
    expect(out.entries[0].debitAccount).toBe('Employee: Raju');
    expect(out.party.name).toBe('Raju'); // canonical casing
  });

  it('snaps a case-variant "Employee: rahul" leg to canonical casing', () => {
    const out = hydrateLlmTransaction({
      intent: 'reimbursement', date: '2026-07-01', narration: 'reimburse',
      party: { type: 'employee', name: 'rahul' },
      entries: [{ debitAccount: 'Food Expense', creditAccount: 'Employee: rahul', amount: 500 }],
    }, CTX);
    expect(out.entries[0].creditAccount).toBe('Employee: Rahul');
  });

  it('NEVER grounds an employee against the client list (Rahul ≠ Rahul Traders)', () => {
    const out = hydrateLlmTransaction({
      intent: 'salary', date: '2026-07-01', narration: 'salary',
      party: { type: 'employee', name: 'Rahul' },
      entries: [{ debitAccount: 'Salary Expense', creditAccount: 'Bank', amount: 30000 }],
    }, CTX);
    expect(out.party.name).toBe('Rahul');
    expect(out.entries[0].creditAccount).toBe('Bank');
  });

  it('vendor/client parties are untouched by the employee block', () => {
    const out = hydrateLlmTransaction({
      intent: 'payment', date: '2026-07-01', narration: 'paid acme',
      party: { type: 'vendor', name: 'Acme Corp' },
      entries: [{ debitAccount: 'Party: Acme Corp', creditAccount: 'Bank', amount: 5000 }],
    }, CTX);
    expect(out.entries[0].debitAccount).toBe('Party: Acme Corp');
  });
});

describe('server context + sanitizer accept the employee additions', () => {
  it('capContext caps and passes employeeNames; volatile block lists them', () => {
    const c = capContext({ employeeNames: ['Rahul', 'Raju'], partyNames: [], accountNames: [], projectNames: [] });
    expect(c.employeeNames).toEqual(['Rahul', 'Raju']);
    expect(buildVolatileContext({ employeeNames: ['Rahul'] })).toMatch(/Known employees.*Rahul/);
  });
  it('sanitizeLlmTransaction accepts the new reimbursement intent', () => {
    const tx = sanitizeLlmTransaction({
      intent: 'reimbursement', date: '2026-07-01', narration: 'reimburse Rahul',
      party: { type: 'employee', name: 'Rahul' }, mode: 'Bank', confidence: 0.8,
      entries: [{ debitAccount: 'Employee: Rahul', creditAccount: 'Bank', amount: 3000 }],
    }, { text: 'reimburse rahul 3000', todayISO: '2026-07-17', modelId: 'claude-opus-4-8' });
    expect(tx.intent).toBe('reimbursement');
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Employee: Rahul', amount: 3000 });
  });
  it('buildAiContext forwards employeeNames (capped)', () => {
    const c = buildAiContext({ employeeNames: ['Rahul'], partyNames: [], allAccounts: [], projectNames: [] });
    expect(c.employeeNames).toEqual(['Rahul']);
  });
});
