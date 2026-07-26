'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
 * DEFAULT EQUIPMENT CATALOG — new-tenant inventory seed (SaaS).
 *
 * WHAT THIS IS
 * ------------
 * A representative, ready-to-edit catalog of professional event / rental /
 * staging equipment that a fresh tenant (event/rental company) is seeded with,
 * exactly analogous to how functions/coa-defaults.cjs seeds a default Chart of
 * Accounts. It gives a brand-new tenant a usable inventory skeleton on day one
 * instead of an empty grid; the admin then edits quantities, serials, rates and
 * brands to match what they actually own.
 *
 * FIELD NAMES MIRROR src/pages/Inventory.jsx (initialForm)
 * -------------------------------------------------------
 * Each row uses the SAME field names an inventory document uses, so seeded rows
 * load cleanly into the Inventory editor (General / Logistics tabs) and into the
 * ConfigurationBuilder power/weight analyser without any adapter:
 *
 *   item_type      'Equipment' | 'Service'      (all rows here are 'Equipment')
 *   name           item name / model            (Inventory: "Item Name / Model")
 *   category        one of the app CATEGORIES (src/utils/constants.js) OR a new
 *                   catalog category — the app's Category field is FREE-TEXT
 *                   (datalist-backed) and the tenant's inventory category list is
 *                   configurable (settings/categories.inventory_categories), so
 *                   new categories load and filter cleanly. See EQUIPMENT_GROUPS.
 *   sub_category   free-text sub-grouping        (Inventory field is sub_category,
 *                   NOT "subcategory")
 *   dimensions     free-text "L × W × H" string  (Inventory: "Dimensions (LxWxH)")
 *   power_watts    NUMBER, electrical draw in W  (Inventory: "Power (Watts)");
 *                   0 for passive / non-electrical items. ConfigurationBuilder
 *                   multiplies power_watts × qty to size DBs / generators, so
 *                   passive loudspeakers (amp-driven) and truss/stage/tent/drape
 *                   are 0 to avoid double-counting the amplifier draw.
 *   weight         NUMBER, kilograms             (Inventory: "Weight (kg)"; the
 *                   field is weight, NOT "weight_kg")
 *
 * CATALOG-ONLY METADATA (extra fields the app does not define — harmless: the
 * Inventory editor spreads {...initialForm, ...item} so unknown keys are simply
 * preserved on the doc, and Firestore is schemaless):
 *   group           EQUIPMENT_GROUPS id this row belongs to (structural | staging
 *                   | inside | outside)
 *   unit           unit of measure: 'piece' | 'set' | 'running-metre' | 'sqm'
 *   power_requirement  human phase/supply hint: 'passive' | 'none' | '1φ 230V' |
 *                   '3φ 415V' | 'amp-driven' …  (companion to numeric power_watts)
 *   material       primary material (aluminium / steel / HDPE / PVC / fabric …)
 *   classifier_tags  string[] of STRUCTURAL CLASSIFIERS used to spec/filter an
 *                   item: load rating, span, height, IP rating, phase, pixel
 *                   pitch, coverage, fire-rating, fold-flat, weatherproof, etc.
 *   indicative     true when the quoted size/weight/power is a representative
 *                   figure that varies widely by brand/model (plan around it,
 *                   verify against the actual asset); false when anchored to a
 *                   named reference product (see docs/EQUIPMENT_CATALOG.md).
 *
 * WIRING (for platformCreateTenant — see functions/platform.js CoA seeding):
 *   Collection path : artifacts/{appId}/public/data/inventory  (auto-id docs)
 *   Per row, stamp operational fields the seeder owns (NOT baked into the data,
 *   mirroring how coa rows omit created_by/created_at): e.g.
 *     { ...row, total: 0, status: 'Available', is_archived: false,
 *       created_at: ts, created_by: staff.id }
 *   Rates live in the sibling gated doc inventory_financials/{sameId}; this
 *   catalog carries NO pricing, so nothing needs writing there at seed time
 *   (rate_per_day/purchase_cost default to 0 when the sibling is absent).
 *   Optionally also seed settings/categories.inventory_categories with the union
 *   of EQUIPMENT_GROUPS[*].categories so the new categories appear in filters.
 *
 * CONSTRAINTS: NO imports — pure data + a getter — so this file is loadable by
 * both Cloud Functions (require) and vitest (import default). Keep it that way.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── Classification groups (the tenant taxonomy). Each group declares the set of
//    `category` values its items may use; the union is the catalog's category
//    vocabulary. Categories that also exist in the app's CATEGORIES constant are
//    marked "(app-native)"; the rest are new catalog categories.
const EQUIPMENT_GROUPS = [
  {
    id: 'structural',
    label: 'Structural / Building',
    description:
      'Load-bearing structure: truss, scaffolding/Layher, ground-support towers, ' +
      'goal posts, header bars, base plates, sleeve blocks, couplers, barricades.',
    // Trussing + Rigging are app-native; Scaffolding/Barricades/Ground Support are new.
    categories: ['Trussing', 'Rigging', 'Scaffolding', 'Barricades', 'Ground Support'],
  },
  {
    id: 'staging',
    label: 'Stage Building',
    description:
      'The performance platform itself: stage decks/risers, legs & sub-frames, ' +
      'ramps, stairs, railings, skirting.',
    categories: ['Staging'],
  },
  {
    id: 'inside',
    label: 'Inside Venue',
    description:
      'Everything dressed inside the covered/indoor space: lighting, PA/sound, ' +
      'video & LED walls, projection, drapery/backdrops, furniture, carpeting.',
    // Lighting/Sound/Video/LED Wall/Projectors/Camera are app-native; Drapery/Furniture/Carpeting are new.
    categories: ['Lighting', 'Sound', 'Video', 'LED Wall', 'Projectors', 'Camera', 'Drapery', 'Furniture', 'Carpeting'],
  },
  {
    id: 'outside',
    label: 'Outside Venue',
    description:
      'Site infrastructure and weather envelope: tents/marquees/pagodas, ' +
      'flooring/decking, generators & power distribution, cabling, climate control, sanitation.',
    // Power + Cables are app-native; Tentage/Flooring/Climate/Sanitation are new.
    categories: ['Tentage', 'Flooring', 'Power', 'Cables', 'Climate', 'Sanitation'],
  },
];

// ── The catalog. Flat array; one object per equipment type. Specs are metric
//    (Indian market: metres, kg, kVA). See header for the field contract and
//    docs/EQUIPMENT_CATALOG.md for spec sources.
const DEFAULT_EQUIPMENT_CATALOG = [
  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 1 — STRUCTURAL / BUILDING
  // ═══════════════════════════════════════════════════════════════════════

  // ── Trussing (box / triangular / ladder) ────────────────────────────────
  { item_type: 'Equipment', group: 'structural', name: 'F34 Box Truss — 1.0 m Straight (290 mm)', category: 'Trussing', sub_category: 'Box Truss', unit: 'piece', dimensions: '1000 × 290 × 290 mm', power_watts: 0, power_requirement: 'passive', weight: 9, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'span-1m', 'section-290mm', 'spigot-connect'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'F34 Box Truss — 2.0 m Straight (290 mm)', category: 'Trussing', sub_category: 'Box Truss', unit: 'piece', dimensions: '2000 × 290 × 290 mm', power_watts: 0, power_requirement: 'passive', weight: 17, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'span-2m', 'section-290mm', 'spigot-connect'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'F44 Box Truss — 2.0 m Straight (400 mm, heavy-duty)', category: 'Trussing', sub_category: 'Box Truss', unit: 'piece', dimensions: '2000 × 400 × 400 mm', power_watts: 0, power_requirement: 'passive', weight: 26, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'span-2m', 'section-400mm', 'high-load', 'spigot-connect'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'F34 Box Truss — 90° 2-Way Corner', category: 'Trussing', sub_category: 'Truss Corner', unit: 'piece', dimensions: '500 × 500 × 290 mm', power_watts: 0, power_requirement: 'passive', weight: 5.6, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'corner-2way', 'section-290mm'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'F34 Box Truss — 3-Way T Corner', category: 'Trussing', sub_category: 'Truss Corner', unit: 'piece', dimensions: '500 × 500 × 290 mm', power_watts: 0, power_requirement: 'passive', weight: 7, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'corner-3way', 'section-290mm'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'F34 Box Truss — 4-Way X Corner', category: 'Trussing', sub_category: 'Truss Corner', unit: 'piece', dimensions: '500 × 500 × 290 mm', power_watts: 0, power_requirement: 'passive', weight: 8.5, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'corner-4way', 'section-290mm'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'F33 Triangular Truss — 2.0 m (290 mm)', category: 'Trussing', sub_category: 'Triangular Truss', unit: 'piece', dimensions: '2000 × 290 × 290 mm', power_watts: 0, power_requirement: 'passive', weight: 11, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'span-2m', 'triangular', 'section-290mm'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Ladder Truss — 2.0 m (290 mm)', category: 'Trussing', sub_category: 'Ladder Truss', unit: 'piece', dimensions: '2000 × 290 × 50 mm', power_watts: 0, power_requirement: 'passive', weight: 7, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'span-2m', 'ladder', 'flat'], indicative: true },

  // ── Rigging (couplers, hoists, slings) ───────────────────────────────────
  { item_type: 'Equipment', group: 'structural', name: 'Conical Coupler Set (spigot + pins + clips)', category: 'Rigging', sub_category: 'Truss Connector', unit: 'set', dimensions: '150 × 60 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 1.2, material: 'Steel', classifier_tags: ['load-bearing', 'connector', 'truss-spigot'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Half Coupler — 48–51 mm', category: 'Rigging', sub_category: 'Coupler', unit: 'piece', dimensions: '120 × 60 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 0.7, material: 'Steel (drop-forged)', classifier_tags: ['wll-500kg', 'clamp', 'tube-48mm'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Bow Shackle — 3.25 t WLL', category: 'Rigging', sub_category: 'Rigging Hardware', unit: 'piece', dimensions: 'M20 / 3.25 t', power_watts: 0, power_requirement: 'passive', weight: 0.5, material: 'Steel (galvanised)', classifier_tags: ['wll-3.25t', 'shackle', 'lifting'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Round Sling / Lifting Strap — 2 t × 2 m', category: 'Rigging', sub_category: 'Rigging Hardware', unit: 'piece', dimensions: '2000 mm loop', power_watts: 0, power_requirement: 'passive', weight: 0.8, material: 'Polyester', classifier_tags: ['wll-2t', 'soft-sling', 'lifting'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Manual Chain Hoist / Chain Block — 1 t', category: 'Rigging', sub_category: 'Hoist', unit: 'piece', dimensions: '3 m lift', power_watts: 0, power_requirement: 'passive', weight: 11, material: 'Steel', classifier_tags: ['wll-1t', 'manual', 'lifting'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Electric Chain Hoist — 1 t (D8)', category: 'Rigging', sub_category: 'Hoist', unit: 'piece', dimensions: '18 m chain', power_watts: 1100, power_requirement: '3φ 415V', weight: 32, material: 'Steel', classifier_tags: ['wll-1t', 'motorised', 'lifting', '3-phase'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Safety Bond / Steel Wire Rope — 60 cm', category: 'Rigging', sub_category: 'Rigging Hardware', unit: 'piece', dimensions: '600 mm', power_watts: 0, power_requirement: 'passive', weight: 0.4, material: 'Steel wire rope', classifier_tags: ['wll-100kg', 'secondary-safety'], indicative: false },

  // ── Scaffolding / Layher ─────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'structural', name: 'Layher Allround Standard / Upright — 2.0 m', category: 'Scaffolding', sub_category: 'Layher Allround', unit: 'piece', dimensions: '2000 mm, Ø48.3', power_watts: 0, power_requirement: 'passive', weight: 6.9, material: 'Steel (galvanised)', classifier_tags: ['load-bearing', 'height-2m', 'rosette', 'modular'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Layher Allround O-Ledger — 2.07 m', category: 'Scaffolding', sub_category: 'Layher Allround', unit: 'piece', dimensions: '2070 mm', power_watts: 0, power_requirement: 'passive', weight: 5.0, material: 'Steel (galvanised)', classifier_tags: ['load-bearing', 'bay-2.07m', 'ledger', 'modular'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Layher Allround Diagonal Brace — 2.07 × 2.0 m', category: 'Scaffolding', sub_category: 'Layher Allround', unit: 'piece', dimensions: '2.07 × 2.0 m bay', power_watts: 0, power_requirement: 'passive', weight: 5.4, material: 'Steel (galvanised)', classifier_tags: ['bracing', 'bay-2.07m', 'modular'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Layher Steel Deck (O) — 2.07 m', category: 'Scaffolding', sub_category: 'Layher Allround', unit: 'piece', dimensions: '2070 × 320 mm', power_watts: 0, power_requirement: 'passive', weight: 19, material: 'Steel (galvanised)', classifier_tags: ['walk-deck', 'bay-2.07m', 'non-slip'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Adjustable Base Jack / Base Plate (scaffold)', category: 'Scaffolding', sub_category: 'Base', unit: 'piece', dimensions: '600 mm thread', power_watts: 0, power_requirement: 'passive', weight: 3.6, material: 'Steel', classifier_tags: ['levelling', 'base', 'height-adj'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Cuplock Vertical Standard — 2.0 m', category: 'Scaffolding', sub_category: 'Cuplock', unit: 'piece', dimensions: '2000 mm, Ø48.3', power_watts: 0, power_requirement: 'passive', weight: 6.5, material: 'Steel (galvanised)', classifier_tags: ['load-bearing', 'height-2m', 'cuplock', 'modular'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Scaffold Tube — 6.0 m (48.3 mm)', category: 'Scaffolding', sub_category: 'Tube & Fitting', unit: 'piece', dimensions: '6000 mm, Ø48.3 × 4 mm', power_watts: 0, power_requirement: 'passive', weight: 25, material: 'Steel', classifier_tags: ['load-bearing', 'tube-48mm', 'cut-to-fit'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Scaffold Double Coupler (right-angle)', category: 'Scaffolding', sub_category: 'Tube & Fitting', unit: 'piece', dimensions: '120 × 60 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 1.1, material: 'Steel (drop-forged)', classifier_tags: ['wll-630kg', 'clamp', 'right-angle'], indicative: false },

  // ── Ground support / towers / goal posts / base plates ───────────────────
  { item_type: 'Equipment', group: 'structural', name: 'Ground Support Tower / Lifting Tower — 6.5 m', category: 'Ground Support', sub_category: 'Lifting Tower', unit: 'piece', dimensions: '6500 mm max lift', power_watts: 0, power_requirement: 'passive', weight: 260, material: 'Aluminium / Steel', classifier_tags: ['load-bearing', 'height-6.5m', 'sleeve-lift', 'winch'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Sleeve Block (ground-support head)', category: 'Ground Support', sub_category: 'Sleeve Block', unit: 'piece', dimensions: '400 × 400 × 500 mm', power_watts: 0, power_requirement: 'passive', weight: 30, material: 'Aluminium / Steel', classifier_tags: ['load-bearing', 'sleeve', 'tower-head'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Header Bar / Goal-Post Beam — 8 m span', category: 'Ground Support', sub_category: 'Header Bar', unit: 'piece', dimensions: '8000 × 400 × 400 mm', power_watts: 0, power_requirement: 'passive', weight: 105, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'span-8m', 'header', 'goal-post'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Goal-Post Upright / Tower Leg — 5 m', category: 'Ground Support', sub_category: 'Tower Leg', unit: 'piece', dimensions: '5000 × 400 × 400 mm', power_watts: 0, power_requirement: 'passive', weight: 70, material: 'Aluminium 6082-T6', classifier_tags: ['load-bearing', 'height-5m', 'upright', 'goal-post'], indicative: true },
  { item_type: 'Equipment', group: 'structural', name: 'Truss Base Plate — 600 × 600 mm', category: 'Ground Support', sub_category: 'Base Plate', unit: 'piece', dimensions: '600 × 600 × 10 mm', power_watts: 0, power_requirement: 'passive', weight: 22, material: 'Steel', classifier_tags: ['base', 'load-spread', 'section-290/400'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Ballast Weight / Steel Kentledge — 25 kg', category: 'Ground Support', sub_category: 'Ballast', unit: 'piece', dimensions: '300 × 300 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 25, material: 'Steel / Cast iron', classifier_tags: ['ballast', 'counterweight', 'stackable'], indicative: false },

  // ── Barricades ───────────────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'structural', name: 'Stage Barrier — Straight Section (Mojo-style)', category: 'Barricades', sub_category: 'Stage Barrier', unit: 'piece', dimensions: '1000 × 1220 mm, 1200 mm deep foot', power_watts: 0, power_requirement: 'passive', weight: 29, material: 'Aluminium 6082-T6', classifier_tags: ['crowd-load', 'height-1.2m', 'fold-flat', 'stackable'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Stage Barrier — Corner Section', category: 'Barricades', sub_category: 'Stage Barrier', unit: 'piece', dimensions: '1000 × 1220 mm (90°)', power_watts: 0, power_requirement: 'passive', weight: 31, material: 'Aluminium 6082-T6', classifier_tags: ['crowd-load', 'height-1.2m', 'corner'], indicative: false },
  { item_type: 'Equipment', group: 'structural', name: 'Crowd Control Barrier (French / bike-rack) — 2.0 m', category: 'Barricades', sub_category: 'Pedestrian Barrier', unit: 'piece', dimensions: '2000 × 1100 mm', power_watts: 0, power_requirement: 'passive', weight: 14, material: 'Steel (galvanised)', classifier_tags: ['crowd-line', 'interlocking', 'height-1.1m'], indicative: false },

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 2 — STAGE BUILDING
  // ═══════════════════════════════════════════════════════════════════════
  { item_type: 'Equipment', group: 'staging', name: 'Stage Deck — 2 × 1 m (birch-ply / alu frame)', category: 'Staging', sub_category: 'Stage Deck', unit: 'piece', dimensions: '2000 × 1000 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 28, material: 'Aluminium frame + 12 mm birch ply', classifier_tags: ['udl-750kg/m2', 'modular', 'anti-slip', 'deck'], indicative: false },
  { item_type: 'Equipment', group: 'staging', name: 'Stage Deck — 1 × 1 m', category: 'Staging', sub_category: 'Stage Deck', unit: 'piece', dimensions: '1000 × 1000 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 16, material: 'Aluminium frame + 12 mm birch ply', classifier_tags: ['udl-750kg/m2', 'modular', 'deck'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Acrylic / Transparent Deck — 2 × 1 m', category: 'Staging', sub_category: 'Stage Deck', unit: 'piece', dimensions: '2000 × 1000 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 34, material: 'Aluminium frame + acrylic', classifier_tags: ['udl-500kg/m2', 'transparent', 'deck'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Adjustable Stage Leg — 40–60 cm', category: 'Staging', sub_category: 'Stage Leg', unit: 'piece', dimensions: '400–600 mm', power_watts: 0, power_requirement: 'passive', weight: 2.0, material: 'Aluminium', classifier_tags: ['height-adj', 'leg', 'levelling'], indicative: false },
  { item_type: 'Equipment', group: 'staging', name: 'Adjustable Stage Leg — 60–100 cm', category: 'Staging', sub_category: 'Stage Leg', unit: 'piece', dimensions: '600–1000 mm', power_watts: 0, power_requirement: 'passive', weight: 2.6, material: 'Aluminium', classifier_tags: ['height-adj', 'leg', 'levelling'], indicative: false },
  { item_type: 'Equipment', group: 'staging', name: 'Adjustable Stage Leg — 100–200 cm', category: 'Staging', sub_category: 'Stage Leg', unit: 'piece', dimensions: '1000–2000 mm', power_watts: 0, power_requirement: 'passive', weight: 3.5, material: 'Aluminium', classifier_tags: ['height-adj', 'leg', 'tall'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Fixed Riser Leg Set — 20 / 40 / 60 cm', category: 'Staging', sub_category: 'Riser', unit: 'set', dimensions: '200 / 400 / 600 mm', power_watts: 0, power_requirement: 'passive', weight: 8, material: 'Steel / Aluminium', classifier_tags: ['fixed-height', 'riser', 'leg-set'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Rolling Drum Riser — 2 × 2 m', category: 'Staging', sub_category: 'Riser', unit: 'piece', dimensions: '2000 × 2000 mm', power_watts: 0, power_requirement: 'passive', weight: 90, material: 'Steel frame + ply', classifier_tags: ['wheeled', 'riser', 'rollable'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Stage Stair — 3-Step (with handrail)', category: 'Staging', sub_category: 'Stairs', unit: 'piece', dimensions: '~600 mm rise', power_watts: 0, power_requirement: 'passive', weight: 25, material: 'Aluminium', classifier_tags: ['access', 'stairs', 'handrail'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Wheelchair Ramp — 2 m (1:12)', category: 'Staging', sub_category: 'Ramp', unit: 'piece', dimensions: '2000 × 1000 mm', power_watts: 0, power_requirement: 'passive', weight: 30, material: 'Aluminium', classifier_tags: ['access', 'ramp', 'ada-1:12'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Guard Rail / Hand Rail — 1.0 m', category: 'Staging', sub_category: 'Railing', unit: 'piece', dimensions: '1000 × 1100 mm', power_watts: 0, power_requirement: 'passive', weight: 6, material: 'Aluminium', classifier_tags: ['edge-protection', 'railing', 'height-1.1m'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Stage Skirting (velcro, IFR) — per running metre', category: 'Staging', sub_category: 'Skirting', unit: 'running-metre', dimensions: 'drop 200–1000 mm', power_watts: 0, power_requirement: 'passive', weight: 0.5, material: 'Fabric (IFR)', classifier_tags: ['skirt', 'velcro', 'fire-retardant', 'per-metre'], indicative: false },
  { item_type: 'Equipment', group: 'staging', name: 'Sub-Frame / Support Frame (deck understructure)', category: 'Staging', sub_category: 'Sub-Frame', unit: 'piece', dimensions: '2000 × 1000 mm', power_watts: 0, power_requirement: 'passive', weight: 20, material: 'Steel', classifier_tags: ['understructure', 'load-spread', 'sub-frame'], indicative: true },
  { item_type: 'Equipment', group: 'staging', name: 'Stage Deck Coupler / Connector Clamp', category: 'Staging', sub_category: 'Deck Hardware', unit: 'piece', dimensions: '120 × 60 mm', power_watts: 0, power_requirement: 'passive', weight: 0.6, material: 'Steel', classifier_tags: ['deck-connect', 'clamp'], indicative: false },

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 3 — INSIDE VENUE
  // ═══════════════════════════════════════════════════════════════════════

  // ── Lighting ─────────────────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'inside', name: 'LED PAR Can — RGBW 18 × 10 W', category: 'Lighting', sub_category: 'PAR', unit: 'piece', dimensions: '250 × 250 × 300 mm', power_watts: 200, power_requirement: '1φ 230V', weight: 3.5, material: 'Aluminium / ABS', classifier_tags: ['ip20', 'dmx', 'rgbw', 'wash'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'LED Wash / Fresnel — 200 W', category: 'Lighting', sub_category: 'Wash', unit: 'piece', dimensions: '300 × 300 × 350 mm', power_watts: 200, power_requirement: '1φ 230V', weight: 6, material: 'Aluminium', classifier_tags: ['ip20', 'dmx', 'zoom-wash'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Moving Head — Beam/Spot Hybrid (MegaPointe-class)', category: 'Lighting', sub_category: 'Moving Head', unit: 'piece', dimensions: '640 × 396 × 230 mm', power_watts: 620, power_requirement: '1φ 100–240V', weight: 22, material: 'Aluminium / composite', classifier_tags: ['ip20', 'dmx', 'beam-spot-wash', 'hybrid', 'lamp-470w'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Moving Head — Wash (LED, Spiider-class)', category: 'Lighting', sub_category: 'Moving Head', unit: 'piece', dimensions: '430 × 400 × 300 mm', power_watts: 600, power_requirement: '1φ 100–240V', weight: 14, material: 'Aluminium / composite', classifier_tags: ['ip20', 'dmx', 'wash', 'led'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Moving Head — Spot / Profile (700 W LED)', category: 'Lighting', sub_category: 'Moving Head', unit: 'piece', dimensions: '500 × 400 × 300 mm', power_watts: 800, power_requirement: '1φ 100–240V', weight: 27, material: 'Aluminium / composite', classifier_tags: ['ip20', 'dmx', 'spot', 'gobo', 'led'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'LED Blinder — 2-Lite (audience blinder)', category: 'Lighting', sub_category: 'Blinder', unit: 'piece', dimensions: '300 × 300 × 150 mm', power_watts: 260, power_requirement: '1φ 230V', weight: 5, material: 'Aluminium', classifier_tags: ['dmx', 'blinder', 'warm-white'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'LED Strobe (Atomic-class)', category: 'Lighting', sub_category: 'Strobe', unit: 'piece', dimensions: '480 × 300 × 170 mm', power_watts: 750, power_requirement: '1φ 230V', weight: 8, material: 'Aluminium', classifier_tags: ['dmx', 'strobe', 'high-output'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Follow Spot — 2500 W (HMI / LED)', category: 'Lighting', sub_category: 'Follow Spot', unit: 'piece', dimensions: '1200 × 400 × 400 mm', power_watts: 2500, power_requirement: '1φ 230V', weight: 35, material: 'Steel / Aluminium', classifier_tags: ['manual-operate', 'long-throw', 'follow-spot'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'ERS Profile / Ellipsoidal (Source Four-class) — 750 W', category: 'Lighting', sub_category: 'Profile', unit: 'piece', dimensions: '600 × 300 × 300 mm', power_watts: 750, power_requirement: '1φ 230V', weight: 7, material: 'Aluminium', classifier_tags: ['tungsten', 'gobo', 'shutter-cut', 'profile'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Fresnel — Tungsten 1 kW', category: 'Lighting', sub_category: 'Fresnel', unit: 'piece', dimensions: '350 × 300 × 350 mm', power_watts: 1000, power_requirement: '1φ 230V', weight: 6, material: 'Steel / Aluminium', classifier_tags: ['tungsten', 'barn-door', 'soft-wash'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'LED Pixel Bar / Batten — 1 m', category: 'Lighting', sub_category: 'Batten', unit: 'piece', dimensions: '1000 × 90 × 110 mm', power_watts: 150, power_requirement: '1φ 230V', weight: 4, material: 'Aluminium', classifier_tags: ['dmx', 'pixel', 'batten', 'rgbw'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Lighting Console (grandMA3 / Avolites-class)', category: 'Lighting', sub_category: 'Console', unit: 'piece', dimensions: '900 × 600 × 300 mm', power_watts: 200, power_requirement: '1φ 230V', weight: 20, material: 'Steel / Aluminium', classifier_tags: ['control', 'dmx-artnet-sacn', 'console'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'DMX Splitter / Node — 8-Way', category: 'Lighting', sub_category: 'DMX Distribution', unit: 'piece', dimensions: '19" 1U', power_watts: 20, power_requirement: '1φ 230V', weight: 2, material: 'Steel', classifier_tags: ['dmx', 'artnet', 'splitter', 'rack'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Hazer / Fazer (DMX)', category: 'Lighting', sub_category: 'Atmospherics', unit: 'piece', dimensions: '450 × 300 × 300 mm', power_watts: 500, power_requirement: '1φ 230V', weight: 8, material: 'Steel', classifier_tags: ['dmx', 'haze', 'atmospherics', 'water-based'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Fog / Smoke Machine — 1500 W', category: 'Lighting', sub_category: 'Atmospherics', unit: 'piece', dimensions: '400 × 250 × 250 mm', power_watts: 1500, power_requirement: '1φ 230V', weight: 5, material: 'Steel', classifier_tags: ['dmx', 'fog', 'atmospherics'], indicative: false },

  // ── Sound / PA ───────────────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'inside', name: 'Line-Array Element — 3-Way (K2-class)', category: 'Sound', sub_category: 'Line Array', unit: 'piece', dimensions: '1340 × 400 × 573 mm', power_watts: 0, power_requirement: 'amp-driven (passive)', weight: 56, material: 'Birch ply / steel grille', classifier_tags: ['passive', 'power-2000w-prog', 'spl-147db', 'flyable'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Line-Array Sub — Dual 18" (KS28-class)', category: 'Sound', sub_category: 'Line Array', unit: 'piece', dimensions: '1340 × 700 × 700 mm', power_watts: 0, power_requirement: 'amp-driven (passive)', weight: 79, material: 'Birch ply', classifier_tags: ['passive', 'sub', 'dual-18', 'flyable'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Point-Source Top — 15" 2-Way (passive)', category: 'Sound', sub_category: 'Speaker', unit: 'piece', dimensions: '700 × 450 × 400 mm', power_watts: 0, power_requirement: 'amp-driven (passive)', weight: 20, material: 'Birch ply / plywood', classifier_tags: ['passive', 'point-source', '2-way', 'pole-mount'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Powered PA Top — 15" Active (1000 W)', category: 'Sound', sub_category: 'Speaker', unit: 'piece', dimensions: '700 × 430 × 380 mm', power_watts: 1000, power_requirement: '1φ 230V', weight: 20, material: 'Polypropylene', classifier_tags: ['active', 'point-source', 'dsp', 'pole-mount'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Stage Monitor Wedge — 12"/15" (passive)', category: 'Sound', sub_category: 'Monitor', unit: 'piece', dimensions: '600 × 500 × 400 mm', power_watts: 0, power_requirement: 'amp-driven (passive)', weight: 18, material: 'Birch ply', classifier_tags: ['passive', 'wedge', 'floor-monitor'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Subwoofer — Dual 18" (passive)', category: 'Sound', sub_category: 'Subwoofer', unit: 'piece', dimensions: '650 × 1200 × 850 mm', power_watts: 0, power_requirement: 'amp-driven (passive)', weight: 45, material: 'Birch ply', classifier_tags: ['passive', 'sub', 'dual-18', 'ground-stack'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Touring Power Amplifier (LA12X-class, 4-ch)', category: 'Sound', sub_category: 'Amplifier', unit: 'piece', dimensions: '19" 2U', power_watts: 2600, power_requirement: '1φ/3φ 230/400V', weight: 12, material: 'Steel', classifier_tags: ['amplifier', 'dsp', 'rack', '4-channel'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Digital Mixing Console — 32-Fader', category: 'Sound', sub_category: 'Console', unit: 'piece', dimensions: '900 × 600 × 250 mm', power_watts: 250, power_requirement: '1φ 230V', weight: 25, material: 'Steel / Aluminium', classifier_tags: ['control', 'digital', 'console', 'foh-monitors'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Digital Stage Box / Snake — 32 × 16', category: 'Sound', sub_category: 'Stage Box', unit: 'piece', dimensions: '19" 6U', power_watts: 100, power_requirement: '1φ 230V', weight: 12, material: 'Steel', classifier_tags: ['stage-box', 'preamps', 'dante-madi', 'rack'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Active DI Box', category: 'Sound', sub_category: 'Accessory', unit: 'piece', dimensions: '120 × 90 × 50 mm', power_watts: 0, power_requirement: 'phantom / passive', weight: 0.6, material: 'Steel', classifier_tags: ['di', 'signal', 'phantom-power'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Wired Dynamic Microphone (SM58-class)', category: 'Sound', sub_category: 'Microphone', unit: 'piece', dimensions: '160 × 51 mm', power_watts: 0, power_requirement: 'passive', weight: 0.3, material: 'Steel / Zinc', classifier_tags: ['dynamic', 'cardioid', 'vocal', 'wired'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Wireless Mic System — UHF (handheld + lapel)', category: 'Sound', sub_category: 'Microphone', unit: 'set', dimensions: '19" 1U rx + tx', power_watts: 30, power_requirement: '1φ 230V', weight: 1.5, material: 'Steel / ABS', classifier_tags: ['wireless', 'uhf', 'diversity', 'handheld-lapel'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'In-Ear Monitor System (IEM)', category: 'Sound', sub_category: 'Monitoring', unit: 'set', dimensions: '19" 1U tx + bodypack', power_watts: 30, power_requirement: '1φ 230V', weight: 1.2, material: 'Steel / ABS', classifier_tags: ['wireless', 'iem', 'stereo', 'uhf'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Microphone Boom Stand', category: 'Sound', sub_category: 'Stand', unit: 'piece', dimensions: '900–1600 mm', power_watts: 0, power_requirement: 'passive', weight: 2.5, material: 'Steel', classifier_tags: ['stand', 'boom', 'height-adj'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Speaker Tripod / Sub Pole', category: 'Sound', sub_category: 'Stand', unit: 'piece', dimensions: '1100–2000 mm', power_watts: 0, power_requirement: 'passive', weight: 4, material: 'Steel / Aluminium', classifier_tags: ['stand', 'tripod', 'speaker-mount'], indicative: false },

  // ── Video / LED walls / projection / camera ──────────────────────────────
  { item_type: 'Equipment', group: 'inside', name: 'Indoor LED Tile — P2.6 500 × 500', category: 'LED Wall', sub_category: 'LED Tile', unit: 'piece', dimensions: '500 × 500 × 80 mm', power_watts: 200, power_requirement: '1φ 230V', weight: 7.5, material: 'Die-cast aluminium', classifier_tags: ['pixel-pitch-2.6', 'indoor', 'flyable', 'front-service'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Indoor LED Tile — P3.9 500 × 500', category: 'LED Wall', sub_category: 'LED Tile', unit: 'piece', dimensions: '500 × 500 × 80 mm', power_watts: 180, power_requirement: '1φ 230V', weight: 7.5, material: 'Die-cast aluminium', classifier_tags: ['pixel-pitch-3.9', 'indoor', 'flyable', 'front-service'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Outdoor LED Tile — P3.9 500 × 500 (IP65)', category: 'LED Wall', sub_category: 'LED Tile', unit: 'piece', dimensions: '500 × 500 × 85 mm', power_watts: 190, power_requirement: '1φ 230V', weight: 8.2, material: 'Die-cast aluminium', classifier_tags: ['pixel-pitch-3.9', 'outdoor', 'ip65', 'high-brightness'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'LED Processor / Sending Unit (Novastar-class)', category: 'Video', sub_category: 'LED Processor', unit: 'piece', dimensions: '19" 1U', power_watts: 30, power_requirement: '1φ 230V', weight: 3, material: 'Steel', classifier_tags: ['processor', 'scaler', 'sending-card', 'rack'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Seamless Video Switcher / Scaler', category: 'Video', sub_category: 'Switcher', unit: 'piece', dimensions: '19" 2U', power_watts: 60, power_requirement: '1φ 230V', weight: 5, material: 'Steel', classifier_tags: ['switcher', 'seamless', 'multi-layer', 'rack'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Media Server / Playback Machine', category: 'Video', sub_category: 'Media Server', unit: 'piece', dimensions: '19" 4U', power_watts: 500, power_requirement: '1φ 230V', weight: 15, material: 'Steel', classifier_tags: ['media-server', 'playback', 'mapping', 'rack'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Projector — 10,000 Lumen Laser', category: 'Projectors', sub_category: 'Projector', unit: 'piece', dimensions: '550 × 500 × 220 mm', power_watts: 900, power_requirement: '1φ 230V', weight: 25, material: 'Steel / Aluminium', classifier_tags: ['laser', '10k-lumen', 'wuxga', 'interchangeable-lens'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Projector — 20,000 Lumen Laser', category: 'Projectors', sub_category: 'Projector', unit: 'piece', dimensions: '650 × 600 × 300 mm', power_watts: 1500, power_requirement: '1φ 230V', weight: 45, material: 'Steel / Aluminium', classifier_tags: ['laser', '20k-lumen', 'wuxga', 'stacking'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Fast-Fold Projection Screen — 12 ft (3.6 m)', category: 'Projectors', sub_category: 'Screen', unit: 'piece', dimensions: '3660 × 2740 mm image', power_watts: 0, power_requirement: 'passive', weight: 40, material: 'Aluminium frame + fabric', classifier_tags: ['front-rear', 'fast-fold', 'dress-kit'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'LED Display / Screen — 55"', category: 'Video', sub_category: 'Display', unit: 'piece', dimensions: '1230 × 710 × 60 mm', power_watts: 150, power_requirement: '1φ 230V', weight: 18, material: 'Aluminium / glass', classifier_tags: ['display', '4k', 'floor-wall-mount'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'LED Display / Screen — 86"', category: 'Video', sub_category: 'Display', unit: 'piece', dimensions: '1930 × 1110 × 80 mm', power_watts: 350, power_requirement: '1φ 230V', weight: 45, material: 'Aluminium / glass', classifier_tags: ['display', '4k', 'large-format'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Video Switcher (ATEM-class)', category: 'Video', sub_category: 'Switcher', unit: 'piece', dimensions: '19" 1U', power_watts: 60, power_requirement: '1φ 230V', weight: 4, material: 'Steel', classifier_tags: ['switcher', 'multi-camera', 'streaming', 'rack'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'PTZ / Broadcast Camera + Tripod', category: 'Camera', sub_category: 'Camera', unit: 'set', dimensions: 'camera + tripod', power_watts: 30, power_requirement: '1φ 230V', weight: 8, material: 'Aluminium / composite', classifier_tags: ['camera', 'ptz', 'sdi-hdmi', 'tripod'], indicative: true },

  // ── Drapery / backdrops / pipe-and-drape ─────────────────────────────────
  { item_type: 'Equipment', group: 'inside', name: 'Blackout Drape / Wool Serge — per running metre (5 m drop)', category: 'Drapery', sub_category: 'Drape', unit: 'running-metre', dimensions: '5 m drop', power_watts: 0, power_requirement: 'passive', weight: 1.2, material: 'Wool serge / IFR fabric', classifier_tags: ['blackout', 'fire-retardant', 'per-metre', 'pleated'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Pipe & Drape Upright (telescopic 1.8–3.0 m)', category: 'Drapery', sub_category: 'Pipe & Drape', unit: 'piece', dimensions: '1800–3000 mm', power_watts: 0, power_requirement: 'passive', weight: 2, material: 'Aluminium', classifier_tags: ['height-adj', 'upright', 'telescopic'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Pipe & Drape Crossbar (adjustable 1.8–3.0 m)', category: 'Drapery', sub_category: 'Pipe & Drape', unit: 'piece', dimensions: '1800–3000 mm', power_watts: 0, power_requirement: 'passive', weight: 1.5, material: 'Aluminium', classifier_tags: ['width-adj', 'crossbar', 'telescopic'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Pipe & Drape Base Plate — 450 × 450 mm', category: 'Drapery', sub_category: 'Pipe & Drape', unit: 'piece', dimensions: '450 × 450 × 5 mm', power_watts: 0, power_requirement: 'passive', weight: 7.2, material: 'Steel', classifier_tags: ['base', 'weighted', 'stability'], indicative: false },
  { item_type: 'Equipment', group: 'inside', name: 'Star Cloth / LED Curtain — 3 × 2 m', category: 'Drapery', sub_category: 'Backdrop', unit: 'piece', dimensions: '3000 × 2000 mm', power_watts: 60, power_requirement: '1φ 230V', weight: 6, material: 'Fabric + LED', classifier_tags: ['starcloth', 'led', 'dmx', 'backdrop'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Backdrop / Cyclorama Cloth — per m²', category: 'Drapery', sub_category: 'Backdrop', unit: 'sqm', dimensions: 'per m²', power_watts: 0, power_requirement: 'passive', weight: 0.5, material: 'Cotton / IFR fabric', classifier_tags: ['cyc', 'seamless', 'fire-retardant', 'per-sqm'], indicative: true },

  // ── Furniture ────────────────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'inside', name: 'Cocktail / Highboy Table', category: 'Furniture', sub_category: 'Table', unit: 'piece', dimensions: 'Ø600 × 1100 mm', power_watts: 0, power_requirement: 'passive', weight: 12, material: 'Steel / MDF', classifier_tags: ['furniture', 'cocktail', 'standing'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Banquet Round Table — 5 ft', category: 'Furniture', sub_category: 'Table', unit: 'piece', dimensions: 'Ø1520 × 750 mm', power_watts: 0, power_requirement: 'passive', weight: 20, material: 'Steel / Plywood', classifier_tags: ['furniture', 'banquet', 'seats-10', 'folding'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Chiavari Chair', category: 'Furniture', sub_category: 'Chair', unit: 'piece', dimensions: '400 × 400 × 900 mm', power_watts: 0, power_requirement: 'passive', weight: 4, material: 'Resin / Aluminium', classifier_tags: ['furniture', 'chiavari', 'stackable', 'banquet'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Folding Chair', category: 'Furniture', sub_category: 'Chair', unit: 'piece', dimensions: '450 × 450 × 800 mm', power_watts: 0, power_requirement: 'passive', weight: 3, material: 'Steel / Plastic', classifier_tags: ['furniture', 'folding', 'stackable'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Lounge Sofa — 2-Seat', category: 'Furniture', sub_category: 'Lounge', unit: 'piece', dimensions: '1400 × 800 × 750 mm', power_watts: 0, power_requirement: 'passive', weight: 30, material: 'Wood / Foam / Leatherette', classifier_tags: ['furniture', 'lounge', 'soft-seating'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Lectern / Podium (acrylic)', category: 'Furniture', sub_category: 'Lectern', unit: 'piece', dimensions: '600 × 450 × 1150 mm', power_watts: 0, power_requirement: 'passive', weight: 15, material: 'Acrylic / Aluminium', classifier_tags: ['furniture', 'podium', 'presenter'], indicative: true },

  // ── Carpeting / floor covering ───────────────────────────────────────────
  { item_type: 'Equipment', group: 'inside', name: 'Event Carpet / Walkway — per m²', category: 'Carpeting', sub_category: 'Carpet', unit: 'sqm', dimensions: 'per m²', power_watts: 0, power_requirement: 'passive', weight: 0.4, material: 'Polypropylene', classifier_tags: ['carpet', 'per-sqm', 'consumable', 'fire-retardant'], indicative: true },
  { item_type: 'Equipment', group: 'inside', name: 'Vinyl Dance Floor (interlocking) — per m²', category: 'Carpeting', sub_category: 'Dance Floor', unit: 'sqm', dimensions: 'per m²', power_watts: 0, power_requirement: 'passive', weight: 5, material: 'PVC / vinyl', classifier_tags: ['dance-floor', 'interlocking', 'per-sqm'], indicative: true },

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 4 — OUTSIDE VENUE
  // ═══════════════════════════════════════════════════════════════════════

  // ── Tentage / marquees / canopies ────────────────────────────────────────
  { item_type: 'Equipment', group: 'outside', name: 'Pagoda Tent — 3 × 3 m', category: 'Tentage', sub_category: 'Pagoda', unit: 'set', dimensions: '3000 × 3000 mm, 65 × 65 mm frame', power_watts: 0, power_requirement: 'passive', weight: 60, material: 'Aluminium 6061-T6 + 850 g PVC', classifier_tags: ['wind-100kmh', 'high-peak', 'modular', 'weatherproof'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Pagoda Tent — 5 × 5 m', category: 'Tentage', sub_category: 'Pagoda', unit: 'set', dimensions: '5000 × 5000 mm, 65 × 65 mm frame', power_watts: 0, power_requirement: 'passive', weight: 160, material: 'Aluminium 6061-T6 + 850 g PVC', classifier_tags: ['wind-100kmh', 'high-peak', 'modular', 'weatherproof'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Clearspan Frame Marquee — 10 m span (per 5 m bay)', category: 'Tentage', sub_category: 'Clearspan', unit: 'set', dimensions: '10 000 mm span × 5 000 mm bay', power_watts: 0, power_requirement: 'passive', weight: 450, material: 'Aluminium 6061-T6 + 850 g PVC', classifier_tags: ['clearspan', 'span-10m', 'pillar-less', 'weatherproof'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Clearspan Frame Marquee — 15 m span (per 5 m bay)', category: 'Tentage', sub_category: 'Clearspan', unit: 'set', dimensions: '15 000 mm span × 5 000 mm bay', power_watts: 0, power_requirement: 'passive', weight: 700, material: 'Aluminium 6061-T6 + 850 g PVC', classifier_tags: ['clearspan', 'span-15m', 'pillar-less', 'weatherproof'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Pop-Up Canopy / Gazebo — 3 × 3 m', category: 'Tentage', sub_category: 'Canopy', unit: 'set', dimensions: '3000 × 3000 mm', power_watts: 0, power_requirement: 'passive', weight: 22, material: 'Aluminium / steel + polyester', classifier_tags: ['pop-up', 'quick-deploy', 'light-duty'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Arabian / Peg-and-Pole Tent (per module)', category: 'Tentage', sub_category: 'Peg & Pole', unit: 'set', dimensions: '6 × 6 m module', power_watts: 0, power_requirement: 'passive', weight: 120, material: 'PVC / cotton canvas + steel poles', classifier_tags: ['peg-pole', 'decor', 'traditional'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Tent Sidewall / Wall Panel (PVC) — per running metre', category: 'Tentage', sub_category: 'Sidewall', unit: 'running-metre', dimensions: 'drop 2–3 m', power_watts: 0, power_requirement: 'passive', weight: 1.5, material: 'PVC (650 g)', classifier_tags: ['sidewall', 'weatherproof', 'per-metre', 'window-option'], indicative: true },

  // ── Flooring / decking (outdoor) ─────────────────────────────────────────
  { item_type: 'Equipment', group: 'outside', name: 'Ground Protection / Turf Cover (Terraplas-class) — per m²', category: 'Flooring', sub_category: 'Ground Protection', unit: 'sqm', dimensions: 'per m²', power_watts: 0, power_requirement: 'passive', weight: 5, material: 'HDPE', classifier_tags: ['ground-protection', 'load-spread', 'per-sqm', 'interlocking'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Modular Raised Floor / Cassette Deck — per m²', category: 'Flooring', sub_category: 'Raised Floor', unit: 'sqm', dimensions: 'per m² (100–600 mm legs)', power_watts: 0, power_requirement: 'passive', weight: 18, material: 'Aluminium / plywood', classifier_tags: ['raised-floor', 'levelling', 'per-sqm'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Aluminium Trackway / Roadway Matting — per metre', category: 'Flooring', sub_category: 'Trackway', unit: 'running-metre', dimensions: '3000 × 750 mm panels', power_watts: 0, power_requirement: 'passive', weight: 20, material: 'Aluminium', classifier_tags: ['trackway', 'vehicle-load', 'per-metre'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Interlocking Plastic Floor Tile — per m²', category: 'Flooring', sub_category: 'Floor Tile', unit: 'sqm', dimensions: '500 × 500 mm tiles', power_watts: 0, power_requirement: 'passive', weight: 6, material: 'HDPE', classifier_tags: ['floor-tile', 'interlocking', 'per-sqm', 'drainage'], indicative: true },

  // ── Power: generators / distribution ─────────────────────────────────────
  { item_type: 'Equipment', group: 'outside', name: 'Diesel Generator (DG) — 62.5 kVA Silent', category: 'Power', sub_category: 'Generator', unit: 'piece', dimensions: '2600 × 1000 × 1500 mm', power_watts: 0, power_requirement: '3φ 415V output', weight: 1100, material: 'Steel (acoustic canopy)', classifier_tags: ['dg-set', 'output-62.5kva', '3-phase', 'silent', 'source'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Diesel Generator (DG) — 125 kVA Silent', category: 'Power', sub_category: 'Generator', unit: 'piece', dimensions: '3200 × 1100 × 1650 mm', power_watts: 0, power_requirement: '3φ 415V output', weight: 1700, material: 'Steel (acoustic canopy)', classifier_tags: ['dg-set', 'output-125kva', '3-phase', 'silent', 'source', 'fuel-27lph'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Diesel Generator (DG) — 250 kVA Silent', category: 'Power', sub_category: 'Generator', unit: 'piece', dimensions: '4000 × 1300 × 1900 mm', power_watts: 0, power_requirement: '3φ 415V output', weight: 2600, material: 'Steel (acoustic canopy)', classifier_tags: ['dg-set', 'output-250kva', '3-phase', 'silent', 'source'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Power Distribution Box (DB) — 63 A 3φ', category: 'Power', sub_category: 'Distribution', unit: 'piece', dimensions: '600 × 400 × 250 mm', power_watts: 0, power_requirement: '3φ 415V', weight: 25, material: 'Steel / ABS', classifier_tags: ['distro', 'in-63a', 'ip44', 'mcb-rcd', '3-phase'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Power Distribution Box (DB) — 125 A 3φ', category: 'Power', sub_category: 'Distribution', unit: 'piece', dimensions: '800 × 600 × 300 mm', power_watts: 0, power_requirement: '3φ 415V', weight: 40, material: 'Steel', classifier_tags: ['distro', 'in-125a', 'ip44', 'mcb-rcd', '3-phase'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Mains / Genset Change-Over Panel', category: 'Power', sub_category: 'Distribution', unit: 'piece', dimensions: '700 × 500 × 300 mm', power_watts: 0, power_requirement: '3φ 415V', weight: 35, material: 'Steel', classifier_tags: ['changeover', 'ats-manual', '3-phase'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Online UPS — 6 kVA', category: 'Power', sub_category: 'UPS', unit: 'piece', dimensions: '19" tower', power_watts: 0, power_requirement: '1φ/3φ', weight: 60, material: 'Steel', classifier_tags: ['ups', 'backup', 'online-double-conversion'], indicative: true },

  // ── Cables ───────────────────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'outside', name: '3-Phase Power Cable — 63 A / 5-Core (per metre)', category: 'Cables', sub_category: 'Power Cable', unit: 'running-metre', dimensions: '5 × 16 mm²', power_watts: 0, power_requirement: '3φ 415V', weight: 2.5, material: 'Copper / rubber', classifier_tags: ['power-cable', '63a', '3-phase', 'ceeform', 'per-metre'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Single-Phase Extension — 32 A (per metre)', category: 'Cables', sub_category: 'Power Cable', unit: 'running-metre', dimensions: '3 × 6 mm²', power_watts: 0, power_requirement: '1φ 230V', weight: 1, material: 'Copper / rubber', classifier_tags: ['power-cable', '32a', '1-phase', 'ceeform', 'per-metre'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Socapex / Multicore Lighting Cable (per metre)', category: 'Cables', sub_category: 'Multicore', unit: 'running-metre', dimensions: '6-way multicore', power_watts: 0, power_requirement: '1φ 230V', weight: 1.5, material: 'Copper / rubber', classifier_tags: ['socapex', 'lx-multicore', 'per-metre'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'DMX Control Cable — 5-Pin (per metre)', category: 'Cables', sub_category: 'Signal Cable', unit: 'running-metre', dimensions: '110 Ω, 5-pin XLR', power_watts: 0, power_requirement: 'passive', weight: 0.1, material: 'Copper / PVC', classifier_tags: ['dmx', 'signal', 'per-metre'], indicative: false },
  { item_type: 'Equipment', group: 'outside', name: 'Cable Ramp / Protector — 5-Channel (1 m)', category: 'Cables', sub_category: 'Cable Management', unit: 'piece', dimensions: '1000 × 500 × 75 mm', power_watts: 0, power_requirement: 'passive', weight: 12, material: 'Rubber / polyurethane', classifier_tags: ['cable-ramp', 'drive-over', '5-channel', 'trip-safe'], indicative: false },

  // ── Climate: cooling / heating ───────────────────────────────────────────
  { item_type: 'Equipment', group: 'outside', name: 'Industrial Cooling Fan — 30" Pedestal', category: 'Climate', sub_category: 'Fan', unit: 'piece', dimensions: '760 mm blade', power_watts: 350, power_requirement: '1φ 230V', weight: 15, material: 'Steel', classifier_tags: ['fan', 'air-movement', 'pedestal'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Outdoor Misting Fan', category: 'Climate', sub_category: 'Fan', unit: 'piece', dimensions: '650 mm blade + pump', power_watts: 400, power_requirement: '1φ 230V', weight: 25, material: 'Steel / plastic', classifier_tags: ['fan', 'misting', 'evaporative-cool', 'outdoor'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Portable AC / Packaged Unit — 3.5 ton', category: 'Climate', sub_category: 'Air Conditioning', unit: 'piece', dimensions: '1000 × 700 × 1800 mm', power_watts: 4500, power_requirement: '3φ 415V', weight: 120, material: 'Steel', classifier_tags: ['packaged-ac', '42000-btu', 'ducted', '3-phase'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Evaporative Cooler (industrial)', category: 'Climate', sub_category: 'Cooler', unit: 'piece', dimensions: '700 × 700 × 1300 mm', power_watts: 750, power_requirement: '1φ 230V', weight: 30, material: 'Plastic / steel', classifier_tags: ['evap-cooler', 'water-tank', 'air-movement'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Patio / Space Heater (electric)', category: 'Climate', sub_category: 'Heater', unit: 'piece', dimensions: '2200 mm mushroom', power_watts: 2000, power_requirement: '1φ 230V', weight: 15, material: 'Steel', classifier_tags: ['heater', 'radiant', 'patio'], indicative: true },

  // ── Sanitation ───────────────────────────────────────────────────────────
  { item_type: 'Equipment', group: 'outside', name: 'Portable Toilet — Single Unit (HDPE)', category: 'Sanitation', sub_category: 'Portable Toilet', unit: 'piece', dimensions: '1200 × 1200 × 2300 mm', power_watts: 0, power_requirement: 'passive', weight: 75, material: 'HDPE', classifier_tags: ['portable-toilet', 'chemical', 'single'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'VIP Toilet Trailer — 2/3-Bay', category: 'Sanitation', sub_category: 'Toilet Trailer', unit: 'piece', dimensions: '4000 × 2000 × 2600 mm', power_watts: 1000, power_requirement: '1φ 230V', weight: 900, material: 'Steel / FRP', classifier_tags: ['toilet-trailer', 'vip', 'plumbed', 'water-tank'], indicative: true },
  { item_type: 'Equipment', group: 'outside', name: 'Portable Hand-Wash Station', category: 'Sanitation', sub_category: 'Hand-Wash', unit: 'piece', dimensions: '600 × 600 × 1400 mm', power_watts: 0, power_requirement: 'passive', weight: 40, material: 'HDPE', classifier_tags: ['hand-wash', 'foot-pump', 'water-tank'], indicative: true },
];

// Return deep-cloned rows so callers can mutate freely without touching the
// module constants (mirrors coa-defaults.getDefaultChartOfAccounts). Nested
// arrays (classifier_tags) are copied too.
const getDefaultEquipmentCatalog = () =>
  DEFAULT_EQUIPMENT_CATALOG.map((row) => ({
    ...row,
    classifier_tags: Array.isArray(row.classifier_tags) ? row.classifier_tags.slice() : [],
  }));

module.exports = { EQUIPMENT_GROUPS, DEFAULT_EQUIPMENT_CATALOG, getDefaultEquipmentCatalog };
