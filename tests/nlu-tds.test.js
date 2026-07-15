import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/utils/aiAccountant/nlu.js';
import { extractClientTDSReceipt } from '../src/utils/aiAccountant/extract.js';
import { validateTransaction, canPost } from '../src/utils/aiAccountant/index.js';

const CTX = { partyNames: ['Zenith Corp', 'Acme Consulting', 'Bright Media', 'Sharma Traders'], employeeNames: ['Rahul'], date: '2026-05-10' };
const legBy = (tx, cr) => (tx.entries || []).find((e) => e.creditAccount === cr);

describe('Vendor-deducted TDS (we withhold, outflow) — compound + section', () => {
  it('"paid Acme Consulting 50000, TDS 5000 deducted for professional fees" → net + TDS Payable, 194J', () => {
    const tx = parseMessage('paid Acme Consulting 50000, TDS 5000 deducted for professional fees', CTX);
    expect(tx.intent).toBe('payment');
    expect(legBy(tx, 'Cash') || legBy(tx, 'Bank')).toMatchObject({ debitAccount: 'Party: Acme Consulting', amount: 45000 });
    expect(legBy(tx, 'TDS Payable')).toMatchObject({ debitAccount: 'Party: Acme Consulting', amount: 5000 });
    expect(tx.party.type).toBe('vendor');
    expect(tx.meta.tdsSection).toBe('194J');
    expect(tx.meta.gross).toBe(50000);
  });
});

describe('Salary TDS → section 192', () => {
  it('"salary 50000 to Rahul, TDS 5000 deducted, paid 45000 by bank" → 192 + net/TDS legs', () => {
    const tx = parseMessage('salary 50000 to Rahul, TDS 5000 deducted, paid 45000 by bank', CTX);
    expect(tx.intent).toBe('salary');
    expect(legBy(tx, 'Bank')).toMatchObject({ debitAccount: 'Salary Expense', amount: 45000 });
    expect(legBy(tx, 'TDS Payable')).toMatchObject({ debitAccount: 'Salary Expense', amount: 5000 });
    expect(tx.meta.tdsSection).toBe('192');
  });

  it('plain "salary 30000 to Rahul" (no TDS) stays unstamped', () => {
    const tx = parseMessage('salary 30000 to Rahul', CTX);
    expect(tx.intent).toBe('salary');
    expect(tx.meta.tdsSection).toBeUndefined();
  });
});

describe('Client-deducted TDS (client withholds on our receipt) — new 3-leg draft', () => {
  it('"received 90000 from Zenith Corp, TDS 10000 deducted" → Dr Cash net + Dr TDS Receivable', () => {
    const tx = parseMessage('received 90000 from Zenith Corp, TDS 10000 deducted', CTX);
    expect(tx.intent).toBe('tds');
    // Cr Party gross split across two balanced pairs.
    const cashLeg = tx.entries.find((e) => e.debitAccount === 'Cash');
    const tdsLeg = tx.entries.find((e) => e.debitAccount === 'TDS Receivable');
    expect(cashLeg).toMatchObject({ creditAccount: 'Party: Zenith Corp', amount: 90000 });
    expect(tdsLeg).toMatchObject({ creditAccount: 'Party: Zenith Corp', amount: 10000 });
    expect(tx.party).toMatchObject({ type: 'client', name: 'Zenith Corp' });
    expect(tx.meta).toMatchObject({ gross: 100000, net: 90000, tds: 10000 });
  });

  it('"Zenith Corp paid us 90000 after deducting 10000 TDS" → tds intent (override beats payment tie-break)', () => {
    const tx = parseMessage('Zenith Corp paid us 90000 after deducting 10000 TDS', CTX);
    expect(tx.intent).toBe('tds');
    expect(tx.entries.find((e) => e.debitAccount === 'TDS Receivable')).toMatchObject({ amount: 10000 });
    expect(tx.entries.find((e) => e.debitAccount === 'Cash')).toMatchObject({ amount: 90000 });
  });

  it('"got 45000 from Bright Media, 5000 TDS under 194J" → net 45000, gross 50000, section 194J', () => {
    const tx = parseMessage('got 45000 from Bright Media, 5000 TDS under 194J', CTX);
    expect(tx.intent).toBe('tds');
    expect(tx.meta).toMatchObject({ net: 45000, gross: 50000, tds: 5000 });
    expect(tx.meta.tdsSection).toBe('194J');
  });

  it('a client-deducted draft is balanced and postable', () => {
    const tx = validateTransaction(parseMessage('received 90000 from Zenith Corp, TDS 10000 deducted', CTX), { knownAccounts: ['Cash', 'TDS Receivable'] });
    expect(canPost(tx)).toBe(true);
  });
});

describe('extractClientTDSReceipt (net + tds → gross)', () => {
  it('computes gross = net + tds from a net receipt', () => {
    expect(extractClientTDSReceipt('received 90000, TDS 10000 deducted')).toEqual({ net: 90000, tds: 10000, gross: 100000 });
  });
  it('returns null without an inflow cue (a vendor outflow must not route here)', () => {
    expect(extractClientTDSReceipt('paid 90000 to vendor, TDS 10000')).toBe(null);
  });
  it('returns null when no TDS figure is present', () => {
    expect(extractClientTDSReceipt('received 90000 from client')).toBe(null);
  });
});

describe('Regression guards', () => {
  it('a plain vendor payment with no TDS stays a simple payment', () => {
    const tx = parseMessage('paid 20000 to Sharma Traders for cab', CTX);
    expect(tx.intent).toBe('payment');
    expect(tx.entries).toHaveLength(1);
    expect(legBy(tx, 'Cash')).toMatchObject({ debitAccount: 'Party: Sharma Traders', amount: 20000 });
  });
});
