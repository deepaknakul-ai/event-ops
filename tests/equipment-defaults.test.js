import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_GROUPS,
  DEFAULT_EQUIPMENT_CATALOG,
  getDefaultEquipmentCatalog,
} from '../functions/equipment-defaults.cjs';

// Guards the starter equipment catalog that platformCreateTenant seeds into a
// new tenant's inventory. Keep field names in sync with src/pages/Inventory.jsx
// (name, category, sub_category, unit) — the seeding maps to that doc shape.

describe('equipment defaults catalog', () => {
  it('exposes the catalog and a getter returning the same array', () => {
    expect(Array.isArray(DEFAULT_EQUIPMENT_CATALOG)).toBe(true);
    expect(DEFAULT_EQUIPMENT_CATALOG.length).toBeGreaterThan(60);
    expect(getDefaultEquipmentCatalog()).toEqual(DEFAULT_EQUIPMENT_CATALOG);
  });

  it('declares the four classification groups', () => {
    const groups = Array.isArray(EQUIPMENT_GROUPS)
      ? EQUIPMENT_GROUPS.map((g) => (typeof g === 'string' ? g : g.key || g.id || g.name))
      : Object.keys(EQUIPMENT_GROUPS);
    for (const want of ['structural', 'staging', 'inside', 'outside']) {
      expect(groups).toContain(want);
    }
  });

  it('every item has the required inventory-compatible fields', () => {
    for (const item of DEFAULT_EQUIPMENT_CATALOG) {
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(typeof item.category).toBe('string');
      expect(item.category.length).toBeGreaterThan(0);
      expect(typeof item.unit).toBe('string');
      expect(item.unit.length).toBeGreaterThan(0);
    }
  });

  it('every item belongs to a declared group', () => {
    const groups = Array.isArray(EQUIPMENT_GROUPS)
      ? EQUIPMENT_GROUPS.map((g) => (typeof g === 'string' ? g : g.key || g.id || g.name))
      : Object.keys(EQUIPMENT_GROUPS);
    for (const item of DEFAULT_EQUIPMENT_CATALOG) {
      expect(groups).toContain(item.group);
    }
  });

  it('has no duplicate item names', () => {
    const names = DEFAULT_EQUIPMENT_CATALOG.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('power fields are coherent (passive items draw no watts)', () => {
    for (const item of DEFAULT_EQUIPMENT_CATALOG) {
      if (item.power_requirement === 'passive') {
        expect(item.power_watts == null || item.power_watts === 0).toBe(true);
      }
      if (item.power_watts != null) {
        expect(typeof item.power_watts).toBe('number');
        expect(item.power_watts).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
