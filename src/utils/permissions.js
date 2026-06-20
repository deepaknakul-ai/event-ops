/**
 * permissions.js — Central Role-Based Access Control
 *
 * Roles:
 *   admin       → Owner           (full access to everything)
 *   accountant  → Accountant      (all finance, reports, view-only on operations)
 *   manager     → Project Manager (projects, clients, inventory, outsourcing, challans)
 *   tech        → Field Tech      (challans, own expenses, view projects/inventory)
 *   user        → General User    (view-only on projects, clients, inventory)
 */

// ── Role labels shown in UI ───────────────────────────────────────────────────
export const ROLE_LABELS = {
  admin:      'Owner',
  accountant: 'Accountant',
  manager:    'Project Manager',
  tech:       'Field Tech',
  user:       'Coordinator',
};

// ── All selectable roles (for employee form dropdown) ─────────────────────────
export const ROLE_OPTIONS = [
  { value: 'admin',      label: 'Owner' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'manager',    label: 'Project Manager' },
  { value: 'tech',       label: 'Field Tech' },
  { value: 'user',       label: 'Coordinator' },
];

// ── Role avatar color ─────────────────────────────────────────────────────────
export const ROLE_COLOR = {
  admin:      'bg-red-500',
  accountant: 'bg-emerald-600',
  manager:    'bg-blue-500',
  tech:       'bg-orange-500',
  user:       'bg-slate-400',
};

// ── Central permission definitions ───────────────────────────────────────────
//
//  Structure: PERMISSIONS[resource][action] = [roles...]
//
//  Resources: clients, projects, inventory, finance, reports,
//             employees, outsourcing, challans, expenses,
//             purchase_invoices, documents, admin_tools, audit_logs
//
//  Actions:   view, create, edit, delete, close (projects), approve (expenses),
//             view_rates, view_amounts, manage_roles

export const PERMISSIONS = {
  clients: {
    view:   ['admin', 'accountant', 'manager', 'user'],
    create: ['admin', 'manager'],
    edit:   ['admin', 'manager'],
    delete: ['admin'],
  },
  leads: {
    view:   ['admin', 'manager', 'accountant'],
    create: ['admin', 'manager'],
    edit:   ['admin', 'manager'],
    delete: ['admin'],
  },
  chat: {
    view:     ['admin', 'accountant', 'manager', 'tech', 'user'],
    create:   ['admin', 'accountant', 'manager', 'tech', 'user'],  // post messages
    announce: ['admin', 'manager'],                                // post to Announcements
    moderate: ['admin', 'manager'],                                // delete others' messages
  },
  projects: {
    view:         ['admin', 'accountant', 'manager', 'tech', 'user'],
    view_rates:   ['admin', 'accountant', 'manager'],          // hides rate/amount cols from tech/user
    create:       ['admin', 'manager'],
    create_draft: ['admin', 'manager', 'user'],
    edit:         ['admin', 'manager'],
    delete:       ['admin'],
    close:        ['admin'],
    invoice:      ['admin', 'accountant', 'manager'],
    team_manage:  ['admin', 'manager'],
    allocation:   ['admin', 'manager'],
  },
  inventory: {
    view:        ['admin', 'accountant', 'manager', 'tech', 'user'],
    view_rates:  ['admin', 'accountant', 'manager'],
    create:      ['admin', 'manager'],
    edit:        ['admin', 'manager'],
    delete:      ['admin'],
  },
  finance: {
    view:   ['admin', 'accountant', 'manager'],
    create: ['admin', 'accountant', 'manager'],
    edit:   ['admin', 'accountant'],
    delete: ['admin', 'accountant'],
  },
  reports: {
    view: ['admin', 'accountant', 'manager'],
  },
  employees: {
    view:         ['admin', 'accountant', 'manager', 'tech', 'user'],
    create:       ['admin', 'manager'],
    edit:         ['admin', 'manager'],
    delete:       ['admin'],
    manage_roles: ['admin'],              // only admin can change a user's role
  },
  outsourcing: {
    view:        ['admin', 'accountant', 'manager'],
    view_amounts:['admin', 'accountant', 'manager'],
    create:      ['admin', 'manager'],
    edit:         ['admin', 'manager'],
    delete:      ['admin'],
  },
  challans: {
    view:   ['admin', 'accountant', 'manager', 'tech', 'user'],
    create: ['admin', 'manager', 'tech'],
    edit:   ['admin', 'manager', 'tech'],
    delete: ['admin'],
  },
  expenses: {
    view_all: ['admin', 'accountant', 'manager'],   // see everyone's expenses
    view_own: ['admin', 'accountant', 'manager', 'tech', 'user'],
    create:   ['admin', 'accountant', 'manager', 'tech', 'user'],
    edit:     ['admin', 'accountant', 'manager'],
    delete:   ['admin', 'accountant'],
    approve:  ['admin', 'accountant', 'manager'],
  },
  purchase_invoices: {
    view:   ['admin', 'accountant', 'manager'],
    create: ['admin', 'accountant', 'manager'],
    edit:   ['admin', 'accountant', 'manager'],
    delete: ['admin', 'accountant'],
  },
  tax_invoices: {
    view:   ['admin', 'accountant', 'manager'],
    create: ['admin', 'accountant', 'manager'],
    edit:   ['admin', 'accountant', 'manager'],
    delete: ['admin', 'accountant'],
  },
  documents: {
    view:   ['admin', 'accountant', 'manager', 'tech'],
    create: ['admin', 'manager'],
    edit:   ['admin', 'manager'],
    delete: ['admin'],
  },
  admin_tools: {
    view:   ['admin'],
    edit:   ['admin'],
  },
  audit_logs: {
    view: ['admin', 'accountant'],
  },
  // ── HR Module Resources ──────────────────────────────────────────────────────
  hr_dashboard: {
    view: ['admin', 'accountant', 'manager'],
  },
  hr_attendance: {
    view:        ['admin', 'accountant', 'manager'],
    create:      ['admin', 'manager'],
    edit:        ['admin', 'manager'],
    delete:      ['admin'],
    close_shift: ['admin', 'manager'],
  },
  hr_leaves: {
    view:     ['admin', 'accountant', 'manager'],
    view_own: ['admin', 'accountant', 'manager', 'tech', 'user'],
    create:   ['admin', 'accountant', 'manager', 'tech', 'user'],
    approve:  ['admin', 'manager'],
    cancel:   ['admin', 'manager', 'accountant'],
  },
  hr_shifts: {
    view:     ['admin', 'accountant', 'manager'],
    view_own: ['admin', 'accountant', 'manager', 'tech', 'user'],
    create:   ['admin', 'accountant', 'manager', 'tech', 'user'],
    approve:  ['admin', 'manager'],
    clarify:  ['admin', 'manager'],
  },
  hr_penalties: {
    view:       ['admin', 'accountant', 'manager'],
    create:     ['admin', 'manager'],
    bulk_apply: ['admin'],
  },
  hr_payroll: {
    view:     ['admin', 'accountant'],
    generate: ['admin', 'accountant'],
  },
  hr_reports: {
    view:   ['admin', 'accountant', 'manager'],
    export: ['admin', 'accountant', 'manager'],
  },
  hr_settings: {
    view: ['admin'],
    edit: ['admin'],
  },
  hr_portal: {
    view: ['admin', 'accountant', 'manager', 'tech', 'user'],
  },
  configurations: {
    view:   ['admin', 'accountant', 'manager', 'tech', 'user'],
    create: ['admin', 'manager'],
    edit:   ['admin', 'manager'],
    delete: ['admin'],
  },
};

// ── Human-readable resource definitions (used by RBACManager matrix) ─────────
export const RESOURCE_DEFS = {
  clients:           { label: 'Clients & Vendors',   actions: ['view', 'create', 'edit', 'delete'] },
  leads:             { label: 'Leads / CRM',         actions: ['view', 'create', 'edit', 'delete'] },
  chat:              { label: 'Team Chat',           actions: ['view', 'create', 'announce', 'moderate'] },
  projects:          { label: 'Projects / Quotes',   actions: ['view', 'view_rates', 'create', 'create_draft', 'edit', 'delete', 'close', 'invoice', 'team_manage', 'allocation'] },
  inventory:         { label: 'Inventory',           actions: ['view', 'view_rates', 'create', 'edit', 'delete'] },
  finance:           { label: 'Finance',             actions: ['view', 'create', 'edit', 'delete'] },
  reports:           { label: 'Reports',             actions: ['view'] },
  employees:         { label: 'Employees',           actions: ['view', 'create', 'edit', 'delete', 'manage_roles'] },
  outsourcing:       { label: 'Outsourcing / POs',   actions: ['view', 'view_amounts', 'create', 'edit', 'delete'] },
  challans:          { label: 'Challans',            actions: ['view', 'create', 'edit', 'delete'] },
  expenses:          { label: 'Expenses',            actions: ['view_all', 'view_own', 'create', 'edit', 'delete', 'approve'] },
  purchase_invoices: { label: 'Purchase Invoices',   actions: ['view', 'create', 'edit', 'delete'] },
  tax_invoices:      { label: 'Tax Invoices',        actions: ['view', 'create', 'edit', 'delete'] },
  documents:         { label: 'Documents',           actions: ['view', 'create', 'edit', 'delete'] },
  admin_tools:       { label: 'Admin Tools',         actions: ['view', 'edit'] },
  audit_logs:        { label: 'Audit Logs',          actions: ['view'] },
  // HR Module
  hr_dashboard:      { label: 'HR Dashboard',        actions: ['view'] },
  hr_attendance:     { label: 'HR Attendance',       actions: ['view', 'create', 'edit', 'delete', 'close_shift'] },
  hr_leaves:         { label: 'HR Leaves',           actions: ['view', 'view_own', 'create', 'approve', 'cancel'] },
  hr_shifts:         { label: 'HR Shift Requests',   actions: ['view', 'view_own', 'create', 'approve', 'clarify'] },
  hr_penalties:      { label: 'HR Penalties',        actions: ['view', 'create', 'bulk_apply'] },
  hr_payroll:        { label: 'HR Payroll',          actions: ['view', 'generate'] },
  hr_reports:        { label: 'HR Reports',          actions: ['view', 'export'] },
  hr_settings:       { label: 'HR Settings',         actions: ['view', 'edit'] },
  hr_portal:         { label: 'HR Portal',           actions: ['view'] },
  configurations:    { label: 'Configurations',       actions: ['view', 'create', 'edit', 'delete'] },
};

// ── Human-readable action labels ──────────────────────────────────────────────
export const ACTION_LABELS = {
  view:         'View',
  view_rates:   'View Rates/Amounts',
  view_amounts: 'View Amounts',
  view_all:     'View All (any user)',
  view_own:     'View Own',
  create:       'Create / Add',
  edit:         'Edit / Update',
  delete:       'Delete',
  close:        'Close Project',
  invoice:      'Mark Invoiced',
  team_manage:  'Manage Team',
  allocation:   'Allocate Items',
  approve:      'Approve',
  manage_roles: 'Change User Roles',
  announce:     'Post Announcements',
  moderate:     'Moderate / Delete',
  // HR actions
  close_shift: 'Close Open Shift',
  bulk_apply:  'Bulk Apply',
  generate:    'Generate',
  clarify:     'Request Clarification',
  export:      'Export',
};

// ── Build full boolean config from static PERMISSIONS (used as default) ───────
export const buildDefaultConfig = () => {
  const roles = Object.keys(ROLE_LABELS);
  const config = { permissions: {}, rolesMeta: {} };
  const colorMap = {
    admin: 'bg-red-500', accountant: 'bg-emerald-600',
    manager: 'bg-blue-500', tech: 'bg-orange-500', user: 'bg-slate-400',
  };
  roles.forEach(role => {
    config.rolesMeta[role] = {
      label: ROLE_LABELS[role],
      color: colorMap[role] || 'bg-slate-400',
      isBuiltIn: true,
    };
    config.permissions[role] = {};
    Object.entries(RESOURCE_DEFS).forEach(([resource, def]) => {
      config.permissions[role][resource] = {};
      def.actions.forEach(action => {
        config.permissions[role][resource][action] =
          PERMISSIONS[resource]?.[action]?.includes(role) ?? false;
      });
    });
  });
  return config;
};

// ── Live config (set by App.jsx when Firestore rbac doc is loaded) ────────────
let _liveConfig = null;
export const setLiveConfig = (config) => { _liveConfig = config; };
export const getLiveConfig = () => _liveConfig;

// ── Main helper: can(role, resource, action) ─────────────────────────────────
/**
 * Returns true if `role` is allowed to perform `action` on `resource`.
 * Checks Firestore-stored live config first; falls back to static PERMISSIONS.
 * @param {string} role - The user's role
 * @param {string} resource - The resource (e.g. 'finance', 'projects')
 * @param {string} action - The action (e.g. 'create', 'delete', 'view_rates')
 * @returns {boolean}
 */
export const can = (role, resource, action) => {
  if (!role || !resource || !action) return false;
  // Use Firestore-loaded live config if available, but fall back to static for missing resources
  if (_liveConfig) {
    const liveResult = _liveConfig.permissions?.[role]?.[resource]?.[action];
    if (liveResult !== undefined) return liveResult;
    // Resource not in live config — fall through to static defaults
  }
  // Fallback: static compile-time permissions
  const resource_perms = PERMISSIONS[resource];
  if (!resource_perms) return false;
  const allowed = resource_perms[action];
  if (!allowed) return false;
  return allowed.includes(role);
};

// ── Nav visibility helper ─────────────────────────────────────────────────────
/**
 * Returns an object describing which nav sections are visible for the role.
 */
export const getNavAccess = (role) => ({
  dashboard:         true,
  projects:          can(role, 'projects', 'view'),
  outsourcing:       can(role, 'outsourcing', 'view'),
  clients:           can(role, 'clients', 'view'),
  leads:             can(role, 'leads', 'view'),
  chat:              can(role, 'chat', 'view'),
  inventory:         can(role, 'inventory', 'view'),
  expenses:          can(role, 'expenses', 'view_own'),
  finance:           can(role, 'finance', 'view'),
  challans:          can(role, 'challans', 'view'),
  reports:           can(role, 'reports', 'view'),
  purchase_invoices: can(role, 'purchase_invoices', 'view'),
  documents:         can(role, 'documents', 'view'),
  employees:         can(role, 'employees', 'view'),
  admin_tools:       can(role, 'admin_tools', 'view'),
  audit_logs:        can(role, 'audit_logs', 'view'),
  // HR Module
  hr_dashboard:      can(role, 'hr_dashboard', 'view'),
  hr_attendance:     can(role, 'hr_attendance', 'view'),
  hr_leaves:         can(role, 'hr_leaves', 'view') || can(role, 'hr_leaves', 'view_own'),
  hr_shifts:         can(role, 'hr_shifts', 'view') || can(role, 'hr_shifts', 'view_own'),
  hr_penalties:      can(role, 'hr_penalties', 'view'),
  hr_payroll:        can(role, 'hr_payroll', 'view'),
  hr_reports:        can(role, 'hr_reports', 'view'),
  hr_settings:       can(role, 'hr_settings', 'view'),
  hr_portal:         can(role, 'hr_portal', 'view'),
});
