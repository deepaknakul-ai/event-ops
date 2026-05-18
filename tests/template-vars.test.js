import { describe, it, expect } from 'vitest';
import {
  extractVariables,
  applyVariables,
  builtinValues,
  hasUnresolvedVariables,
} from '../src/utils/aiAccountant/template-vars.js';

describe('template-vars', () => {
  it('extracts user variables, ignores built-ins', () => {
    const tpl = {
      narration: 'Office rent for {{month}} — {{property:Main}}',
      entries: [{ debitAccount: 'Rent', creditAccount: 'Bank', amount: '{{rent|amount}}' }],
    };
    const vars = extractVariables(tpl);
    const names = vars.map((v) => v.name).sort();
    expect(names).toEqual(['property', 'rent']);
    const rent = vars.find((v) => v.name === 'rent');
    expect(rent.type).toBe('amount');
    const prop = vars.find((v) => v.name === 'property');
    expect(prop.default).toBe('Main');
  });

  it('substitutes user vars + built-ins in narration and amount', () => {
    const tpl = {
      narration: 'Rent for {{month}} — {{property}}',
      party_name: 'Landlord {{property}}',
      entries: [{ debitAccount: 'Rent', creditAccount: 'Bank', amount: '{{rent}}' }],
    };
    const out = applyVariables(tpl, { rent: 25000, property: 'Mumbai' }, new Date('2026-04-15'));
    expect(out.narration).toMatch(/^Rent for April 2026 — Mumbai$/);
    expect(out.party_name).toBe('Landlord Mumbai');
    expect(out.entries[0].amount).toBe(25000);
    expect(typeof out.entries[0].amount).toBe('number');
  });

  it('uses default when value missing', () => {
    const tpl = { narration: 'Hello {{name:Friend}}', entries: [] };
    expect(applyVariables(tpl, {}).narration).toBe('Hello Friend');
    expect(applyVariables(tpl, { name: 'Alice' }).narration).toBe('Hello Alice');
  });

  it('builtinValues returns today/month/year/fy', () => {
    const v = builtinValues(new Date('2026-04-15'));
    expect(v.today).toBe('2026-04-15');
    expect(v.year).toBe('2026');
    expect(v.fy).toBe('2026-27');
    expect(v.month).toMatch(/April/);
  });

  it('fy spans April–March correctly', () => {
    expect(builtinValues(new Date('2026-03-31')).fy).toBe('2025-26');
    expect(builtinValues(new Date('2026-04-01')).fy).toBe('2026-27');
    expect(builtinValues(new Date('2026-12-31')).fy).toBe('2026-27');
  });

  it('hasUnresolvedVariables flags missing values', () => {
    const tpl = { narration: 'Hi {{name}}', entries: [] };
    expect(hasUnresolvedVariables(tpl)).toBe(true);
    expect(hasUnresolvedVariables(applyVariables(tpl, { name: 'X' }))).toBe(false);
  });

  it('non-string amount stays numeric', () => {
    const tpl = { narration: '', entries: [{ debitAccount: 'A', creditAccount: 'B', amount: 500 }] };
    const out = applyVariables(tpl, {});
    expect(out.entries[0].amount).toBe(500);
  });
});
