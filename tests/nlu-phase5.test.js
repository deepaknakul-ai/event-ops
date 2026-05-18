import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/utils/aiAccountant';

const CTX = { partyNames: [], allAccounts: [] };

describe('compound query parsing', () => {
  it('detects "revenue vs expenses" as compare', () => {
    const tx = parseMessage('show revenue vs expenses this fy', CTX);
    expect(tx).toBeTruthy();
    expect(tx.intent).toBe('query');
    expect(tx.meta.queryType).toBe('compare');
    expect(tx.meta.series).toEqual(['revenue', 'expenses']);
    expect(tx.meta.period).toBe('this_fy');
  });

  it('detects "income versus spending" as compare', () => {
    const tx = parseMessage('income versus spending last fy', CTX);
    expect(tx).toBeTruthy();
    expect(tx.meta.queryType).toBe('compare');
    expect(tx.meta.period).toBe('last_fy');
  });

  it('detects "sales and expenses this month"', () => {
    const tx = parseMessage('show sales and expenses this month', CTX);
    expect(tx).toBeTruthy();
    expect(tx.meta.queryType).toBe('compare');
    expect(tx.meta.series).toEqual(['revenue', 'expenses']);
  });

  it('falls back to single series when only one is mentioned', () => {
    const tx = parseMessage('show revenue this fy', CTX);
    expect(tx).toBeTruthy();
    expect(tx.meta.queryType).toBe('revenue');
    expect(tx.meta.series).toBeUndefined();
  });

  it('does not confuse expense-only query with compare', () => {
    const tx = parseMessage('expenses this month', CTX);
    expect(tx).toBeTruthy();
    expect(tx.meta.queryType).toBe('expenses');
  });
});
