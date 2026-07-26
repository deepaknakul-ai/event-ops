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
