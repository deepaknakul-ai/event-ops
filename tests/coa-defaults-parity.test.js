// Parity guard: functions/coa-defaults.cjs is a VERBATIM copy of the client's
// default Chart of Accounts. If this test fails, src/utils/accounting.js changed
// and the port must be updated to match (see the header of coa-defaults.cjs).
// This matters because platformCreateTenant seeds a new tenant's chart_of_accounts
// from the port, and it must be byte-identical to what the client's seedDefaultCoa
// would have written.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHART_OF_ACCOUNTS as origArr,
  getDefaultChartOfAccounts as origGet,
} from '../src/utils/accounting.js';
import ported from '../functions/coa-defaults.cjs';

const { DEFAULT_CHART_OF_ACCOUNTS: portArr, getDefaultChartOfAccounts: portGet } = ported;

describe('coa-defaults.cjs parity with client source', () => {
  it('DEFAULT_CHART_OF_ACCOUNTS deep-equals the client array', () => {
    expect(portArr).toEqual(origArr);
    // Guard against a trivially-empty port masking divergence.
    expect(portArr.length).toBe(origArr.length);
    expect(portArr.length).toBeGreaterThan(50);
  });

  it('getDefaultChartOfAccounts() deep-equals the client factory output', () => {
    expect(portGet()).toEqual(origGet());
  });

  it('getDefaultChartOfAccounts() returns fresh (unshared) row copies', () => {
    const a = portGet();
    const b = portGet();
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // new array each call
    expect(a[0]).not.toBe(portArr[0]); // rows are cloned, not the module constants
    a[0].name = 'MUTATED';
    expect(portArr[0].name).not.toBe('MUTATED'); // mutation cannot leak back
  });

  it('every row carries the id/shape fields platformCreateTenant seeds on', () => {
    // Doc id == row.code (mirrors seedDefaultCoa in src/pages/Accounting.jsx).
    const codes = portArr.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length); // codes are unique → no doc-id collisions
    for (const row of portArr) {
      expect(typeof row.code).toBe('string');
      expect(row.code.length).toBeGreaterThan(0);
      expect(typeof row.name).toBe('string');
      expect(['Asset', 'Liability', 'Equity', 'Income', 'Expense']).toContain(row.type);
      expect(['Dr', 'Cr']).toContain(row.normalSide);
    }
  });
});
