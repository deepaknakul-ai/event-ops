import { describe, it, expect } from 'vitest';
import { parseMessage, classifyIntent } from '../src/utils/aiAccountant/nlu.js';

const CTX = { partyNames: ['Acme Corp', 'Rahul', 'SuppliCo'], date: '2026-04-25' };

describe('classifyIntent', () => {
  it('classifies receipt', () => {
    expect(classifyIntent('Acme paid us 50000').intent).toBe('receipt');
  });
  it('classifies payment', () => {
    expect(classifyIntent('paid 20k to Acme').intent).toBe('payment');
  });
  it('classifies salary above payment', () => {
    expect(classifyIntent('salary 30000 to Rahul').intent).toBe('salary');
  });
  it('classifies bank deposit', () => {
    expect(classifyIntent('deposited 1 lakh in bank').intent).toBe('bank_deposit');
  });
});

describe('parseMessage', () => {
  it('returns null for short text', () => {
    expect(parseMessage('hi', CTX)).toBeNull();
  });

  it('returns clarify intent for amount-less booking text', () => {
    const tx = parseMessage('paid vendor', CTX);
    expect(tx).toBeTruthy();
    expect(tx.intent).toBe('clarify');
    expect(tx.meta.clarifyKind).toBe('amount');
  });

  it('builds a balanced receipt transaction', () => {
    const tx = parseMessage('Acme Corp paid us 50000 via NEFT', CTX);
    expect(tx).toBeTruthy();
    expect(tx.intent).toBe('receipt');
    expect(tx.mode).toBe('Bank');
    expect(tx.entries).toHaveLength(1);
    expect(tx.entries[0]).toMatchObject({ debitAccount: 'Bank', creditAccount: 'Party: Acme Corp', amount: 50000 });
    expect(tx.confidence).toBeGreaterThan(0);
    expect(tx.rawPrompt).toContain('Acme');
    expect(tx.model).toBe('rule-v1');
  });

  it('builds a 2-line invoice with 18% GST split', () => {
    const tx = parseMessage('invoice 1,18,000 for Acme Corp', CTX);
    expect(tx.intent).toBe('invoice');
    expect(tx.entries).toHaveLength(2);
    const total = tx.entries.reduce((s, e) => s + e.amount, 0);
    expect(total).toBeCloseTo(118000, 2);
    expect(tx.entries[0].creditAccount).toBe('Sales Revenue');
    expect(tx.entries[1].creditAccount).toBe('Output GST Payable');
  });

  it('builds a salary entry', () => {
    const tx = parseMessage('salary 30000 to Rahul', CTX);
    expect(tx.intent).toBe('salary');
    expect(tx.entries[0].debitAccount).toBe('Salary Expense');
    expect(tx.party).toMatchObject({ type: 'employee', name: 'Rahul' });
  });

  it('builds an expense with inferred account', () => {
    const tx = parseMessage('spent 5000 on travel', CTX);
    expect(tx.intent).toBe('expense');
    // Knowledge-base taxonomy: travel maps to the standard "Travelling & Conveyance" ledger.
    expect(tx.entries[0].debitAccount).toBe('Travelling & Conveyance');
  });

  it('emits accountCreates for referenced accounts', () => {
    const tx = parseMessage('spent 5000 on office stationery', CTX);
    const names = tx.accountCreates.map(a => a.name);
    // Stationery maps to the standard "Printing & Stationery" ledger.
    expect(names).toContain('Printing & Stationery');
    expect(names).toContain('Cash');
  });

  it('uses context date', () => {
    const tx = parseMessage('Acme paid us 5000', { ...CTX, date: '2025-01-15' });
    expect(tx.date).toBe('2025-01-15');
  });
});
