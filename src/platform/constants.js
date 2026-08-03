// Platform console — shared constants, option lists and tiny formatters.
// Kept dependency-free so the whole src/platform chunk stays self-contained.

// ── Tenant lifecycle status ──────────────────────────────────────────────────
export const TENANT_STATUS = {
  active:    { label: 'Active',    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  suspended: { label: 'Suspended', badge: 'bg-amber-50 text-amber-700 border-amber-200',       dot: 'bg-amber-500'   },
  churned:   { label: 'Churned',   badge: 'bg-rose-50 text-rose-700 border-rose-200',           dot: 'bg-rose-400'    },
};
export const STATUS_ORDER = ['active', 'suspended', 'churned'];

// ── Subscription plan ────────────────────────────────────────────────────────
export const TENANT_PLAN = {
  trial:    { label: 'Trial',    badge: 'bg-slate-100 text-slate-600 border-slate-200'   },
  standard: { label: 'Standard', badge: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  premium:  { label: 'Premium',  badge: 'bg-violet-50 text-violet-700 border-violet-200' },
};
export const PLAN_ORDER = ['trial', 'standard', 'premium'];

// Region is stored as a free string on the tenant; these are only autocomplete
// suggestions so any pre-existing value still round-trips through the form.
export const REGION_SUGGESTIONS = ['India', 'Middle East', 'Europe', 'North America', 'APAC', 'Africa', 'Other'];

// ── Plan entitlements: features + limits ─────────────────────────────────────
// Client-side mirror of the PLAN_DEFAULTS matrix in functions/platform.js. Each
// plan grants default boolean FEATURES and numeric LIMITS (null = unlimited). A
// tenant's feature_overrides / limit_overrides win PER KEY over these defaults;
// any key not present in the override map inherits the plan default. The backend
// stays the source of truth — this table only drives the editor + effective
// preview, so keep it in lock-step with functions/platform.js.
export const PLAN_DEFAULTS = {
  trial:    { features: { ai_accountant: false, whatsapp_copilot: false, hr_module: true }, limits: { max_users: 3 } },
  standard: { features: { ai_accountant: true,  whatsapp_copilot: false, hr_module: true }, limits: { max_users: 15 } },
  premium:  { features: { ai_accountant: true,  whatsapp_copilot: true,  hr_module: true }, limits: { max_users: null } },
};

// Feature catalogue — the boolean entitlement keys and how to label them. Order
// drives the rows in the entitlements editor. Keys match PLAN_DEFAULTS.features.
export const PLATFORM_FEATURES = [
  { key: 'ai_accountant',    label: 'AI Accountant',    desc: 'AI-assisted bookkeeping, categorisation and reconciliation.' },
  { key: 'whatsapp_copilot', label: 'WhatsApp Copilot', desc: 'WhatsApp assistant for capturing records on the go.' },
  { key: 'hr_module',        label: 'HR Module',        desc: 'Employees, attendance and payroll workspace.' },
];

// Limit catalogue — numeric caps. A null override means unlimited. Keys match
// PLAN_DEFAULTS.limits.
export const PLATFORM_LIMITS = [
  { key: 'max_users', label: 'Max users', desc: 'Maximum number of users the tenant may have.', unit: 'users' },
];

// Plan defaults for a given plan, falling back to trial for any unknown plan
// (mirrors the backend, which treats an absent/unknown plan as trial).
export const planDefaults = (plan) => PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.trial;

// Resolve the effective value of one entitlement = plan default overridden per
// key by the tenant's override map (present-in-map wins, absent inherits).
const has = (map, key) => !!map && Object.prototype.hasOwnProperty.call(map, key);
export const resolveFeature = (plan, key, featureOverrides) =>
  has(featureOverrides, key) ? !!featureOverrides[key] : !!planDefaults(plan).features[key];
export const resolveLimit = (plan, key, limitOverrides) => {
  if (has(limitOverrides, key)) return limitOverrides[key];
  const defs = planDefaults(plan).limits;
  return has(defs, key) ? defs[key] : null;
};

// Display helper for a numeric limit: null → "Unlimited".
export const fmtLimit = (v) => (v === null || v === undefined ? 'Unlimited' : String(v));

// ── Platform staff roles (from platformLogin → role) ─────────────────────────
// Values mirror functions/platform.js STAFF_ROLES exactly. UI-level gating only;
// the backend remains the source of truth.
//   super_admin      → every tenant; may manage staff + region/assigned_managers
//   regional_admin   → tenants in their assigned regions; may create in-region
//   business_manager → only tenants that name them in assigned_managers
export const PLATFORM_ROLE = {
  super_admin:      { label: 'Super Admin',      badge: 'bg-red-50 text-red-700 border-red-200'         },
  regional_admin:   { label: 'Regional Admin',   badge: 'bg-blue-50 text-blue-700 border-blue-200'      },
  business_manager: { label: 'Business Manager', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};
export const STAFF_ROLE_OPTIONS = ['super_admin', 'regional_admin', 'business_manager'];

// Staff account status (functions/platform.js STAFF_STATUSES).
export const STAFF_STATUS = {
  active:   { label: 'Active',   badge: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  disabled: { label: 'Disabled', badge: 'border-slate-200 bg-slate-100 text-slate-500',      dot: 'bg-slate-400'   },
};

export const roleLabel = (role) => PLATFORM_ROLE[role]?.label || role || '—';

// ── Tenant (company) user roles ──────────────────────────────────────────────
// These are roles a user holds INSIDE a tenant workspace (distinct from the
// PLATFORM_ROLE staff roles above). Used by the Tenant Users manager modal.
export const TENANT_USER_ROLE = {
  admin:      { label: 'Admin',      badge: 'bg-red-50 text-red-700 border-red-200',            desc: 'Full access to the tenant workspace.' },
  accountant: { label: 'Accountant', badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',   desc: 'Books, invoices and financial records.' },
  manager:    { label: 'Manager',    badge: 'bg-blue-50 text-blue-700 border-blue-200',          desc: 'Operations, projects and staff oversight.' },
  tech:       { label: 'Tech',       badge: 'bg-violet-50 text-violet-700 border-violet-200',    desc: 'Field / technical operations.' },
  user:       { label: 'User',       badge: 'bg-slate-100 text-slate-600 border-slate-200',      desc: 'Standard limited access.' },
};
export const TENANT_USER_ROLE_OPTIONS = ['admin', 'accountant', 'manager', 'tech', 'user'];

// Tenant user account status. Values match functions/platform.js
// TENANT_USER_STATUSES exactly (capitalised). 'disable' op → 'Disabled';
// update {status:'Active'} reactivates. Unknown values fall back in the badge.
export const TENANT_USER_STATUS = {
  Active:      { label: 'Active',      badge: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  Disabled:    { label: 'Disabled',    badge: 'border-slate-200 bg-slate-100 text-slate-500',      dot: 'bg-slate-400'   },
  Deactivated: { label: 'Deactivated', badge: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-400'    },
};
export const TENANT_USER_STATUS_OPTIONS = ['Active', 'Disabled', 'Deactivated'];
// Mirror of the backend isDisabledEmployeeStatus(): anything not explicitly
// Disabled/Deactivated (including a legacy empty value) counts as active.
export const isTenantUserActive = (status) => status !== 'Disabled' && status !== 'Deactivated';

// Client-side mirror of isValidTenantCode() — a slug of 3–30 [a-z0-9-].
export const TENANT_CODE_RE = /^[a-z0-9-]{3,30}$/;

// ── Tiny formatters ──────────────────────────────────────────────────────────
export const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

// Whole days from today until `v` (negative = already past). null when unparseable.
export const daysUntil = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t = new Date();
  const startOfToday = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((startOfTarget - startOfToday) / 86400000);
};

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
