# Default Equipment Catalog

A starter catalog of event / rental / staging equipment (134 items) that
`platformCreateTenant` seeds into a new SaaS tenant's inventory, so a company
starts with a usable, classified equipment list to stock and price. Source:
`functions/equipment-defaults.cjs` (pure CJS data, guarded by
`tests/equipment-defaults.test.js`).

## How it's used

On tenant creation, each catalog item is mapped to the app's inventory doc
shape (`src/pages/Inventory.jsx`: `name, category, sub_category, unit,
dimensions, weight, power, qty, rate_per_day, rate_per_week, purchase_cost,
status`) via `equipmentToInventory()` in `functions/platform.js`, written to
`artifacts/{tenant}/public/data/inventory`. Items seed as **templates**:
`qty: 0`, all rates/cost `0`, `status: 'Active'`, `is_template: true`. The
tenant then sets stock quantities and pricing. Catalog-only fields (`material`,
`classifier_tags`, `equipment_group`, `indicative`) ride along as metadata.

## Classification groups

The catalog is organised into four groups matching the venue/build taxonomy:

| Group | Items | Categories |
|---|---|---|
| **structural** (building/support) | 32 | Trussing, Rigging, Scaffolding, Ground Support, Barricades |
| **staging** (stage building) | 14 | Staging (decks, risers, ramps, stairs, rails, skirting) |
| **inside** (inside the venue) | 57 | Lighting, Sound, LED Wall, Video, Projectors, Camera, Drapery, Furniture, Carpeting |
| **outside** (outside the venue) | 31 | Tentage, Flooring, Power, Cables, Climate, Sanitation |

## Item fields

Each catalog entry carries: `name`, `group`, `category`, `sub_category`,
`unit` (piece/set/sqft/running-foot…), `dimensions` (with units),
`power_watts` (number) + `power_requirement` (`passive`/rated), `weight` (kg),
`material`, and `classifier_tags` (structural classifiers such as load rating,
span, section size, phase, IP rating). Items whose specs vary widely are marked
`indicative: true`.

## Maintaining it

- It's pure data with no imports — loadable by both Cloud Functions and vitest.
- Add/adjust items in `functions/equipment-defaults.cjs`; the test enforces
  required fields, group membership, unique names, and coherent power specs.
- If `src/pages/Inventory.jsx` changes its item field names, update
  `equipmentToInventory()` in `functions/platform.js` to match.
