# Editions: Private vs SaaS

One codebase, two build flavors. This is the **contract** every contributor
follows: what is shared, what is exclusive to one edition, and the rule for
where a change lands.

## The golden rule

> **Every change — bug fix, refactor, data-flow/logic change, or feature
> add/replace/remove — lands in BOTH editions by default, because both build
> from the same source.** A change is edition-specific ONLY when it touches
> code that is already edition-gated (behind `IS_SAAS` / `import.meta.env`,
> under `src/platform/`, or in a platform Cloud Function), or when the task
> explicitly says "SaaS only" / "private only".

Practically: you edit shared code once; `npm run build` (private) and
`npm run build:saas` (SaaS) both pick it up. You only write in two places when
a feature is genuinely edition-exclusive.

- **Private MUST NEVER ship SaaS code.** The platform console, staff roles,
  tenant management, and company-code login are dead-code-eliminated from the
  private bundle via `IS_SAAS` ([src/utils/edition.js](../src/utils/edition.js)).
  `npm run verify:private-bundle` enforces this on every private build.
- **Shared backend is identical everywhere.** `functions/` and
  `firestore.rules` deploy byte-for-byte to all three Firebase projects
  (`terms-a005e` private, `eventops-68df9` standby, `<saas>` SaaS). Platform
  functions self-disable where `platform_meta/config` is absent; the
  suspension check self-disables where `platform_tenants/{appId}` is absent.

## Edition mechanism

| | Private (default) | Private standby | SaaS |
|---|---|---|---|
| Build | `npm run build` | `npm run build:backup` | `npm run build:saas` |
| Vite mode | (none) | `backup` | `saas` |
| `VITE_EDITION` | unset → `private` | unset → `private` | `saas` |
| Firebase project | terms-a005e | eventops-68df9 | `<saas project>` |
| Firebase config source | hardcoded default | `.env.backup.local` | `.env.saas.local` |
| appId | fixed `TERMS 1.0.0` | fixed `TERMS 1.0.0` | dynamic (tenant code) |

## Feature matrix

### Shared — in BOTH editions (the whole product)

Every business feature is shared. Edit once, ships to both.

| Area | Feature |
|---|---|
| Operations | Projects, Clients/Vendors, Inventory, Employees, Schedule, Outsourcing, Challans, Warehouse QR scan |
| Accounting | Journal entries, Chart of Accounts, Tax invoices, Purchase invoices, Opening balances, FY closing, Party accounts |
| Money | Expenses, Client/Vendor payments, Payouts, Advances, Commission, Bank reconciliation, Recurring entries |
| HR | Attendance, Leaves, Payroll, Penalties, HR Portal, HR Settings |
| Reporting | Reports, Business reports, Asset analytics, GST (GSTR-1/2/3B/HSN) exports, Tally export |
| Comms/AI | Chat, Live map / GPS tracking, Documents hub, AI Accountant, **WhatsApp Copilot** |
| Platform ops | **Backup & Restore** (Firestore + Storage), Data Portal, RBAC Manager, Audit Logs, Admin Tools |
| Public links | Client ledger, Employee ledger, Reimbursable, Quote approval, Customer portal |
| Tenant roles | admin (Owner), accountant, manager, tech, user |

### Private-only

None. Private is the shared product with the SaaS layer compiled out. There is
no feature that exists in private but not SaaS.

### SaaS-only (never in private)

| Feature | Where |
|---|---|
| Platform console (tenant list, detail, wizard) | `src/platform/*` (lazy, DCE'd from private) |
| Platform staff roles: **super_admin, regional_admin, business_manager** | `functions/platform.js`, platform rules |
| Staff-driven tenant onboarding (create + seed COA + owner) | `platformCreateTenant` |
| Tenant plan / status / trial-expiry tracking (no payment gateway) | `platform_tenants` + console |
| Tenant **suspension blocks login** | `verifyLogin` suspension check (inert on private) |
| Audited **support access** into a tenant workspace | `platformSupportAccess` + banner + audit stamp |
| Company-code field at login | login form, `IS_SAAS` gated |
| Dynamic tenant appId | `setAppId` in [constants.js](../src/utils/constants.js) (no-op in private) |
| Platform audit logs | `platform_audit_logs` |

### Shared code, edition-different behavior

Same source, small `IS_SAAS`/inert branches — NOT a fork.

| Concern | Private | SaaS |
|---|---|---|
| Login inputs | username + password | + company code |
| Share links | `/route/{token}` | `/route/{token}?w={appId}` |
| `verifyLogin` | no tenant doc → no suspension check | checks `platform_tenants/{code}.status` |
| `meta/active_apps` registration | server-side on login (1 tenant) | server-side on login + at provision |
| firestore.rules | `tokenApp()` binding always passes; platform stanzas inert | binding enforced; platform stanzas active |

## Day-to-day workflow

- **Branches:** SaaS work lives on `feature/saas-platform`. Shared fixes made
  on the mainline must be merged into the SaaS branch (and vice-versa) so both
  stay in lockstep — they are the same code.
- **A shared bug fix** → edit shared file once → `npm test` →
  `npm run deploy:everywhere` (builds + deploys all three projects; runs the
  private-bundle check first).
- **A SaaS-only change** → guard with `IS_SAAS` or put under `src/platform/` /
  `functions/platform.js` → verify the private bundle is unaffected
  (`npm run verify:private-bundle`).
- **Never** hand-copy a shared change into a second place; if you find yourself
  doing that, the code isn't actually shared — reshape it so it is.
