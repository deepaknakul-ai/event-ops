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
  user:       'General User',
};

// ── All selectable roles (for employee form dropdown) ─────────────────────────
export const ROLE_OPTIONS = [
  { value: 'admin',      label: 'Owner' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'manager',    label: 'Project Manager' },
  { value: 'tech',       label: 'Field Tech' },
  { value: 'user',       label: 'General User' },
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
    view:   ['admin', 'accountant', 'manager', 'tech', 'user'],
    create: ['admin', 'manager'],
    edit:   ['admin', 'manager'],
    delete: ['admin'],
  },
  projects: {
    view:         ['admin', 'accountant', 'manager', 'tech', 'user'],
    view_rates:   ['admin', 'accountant', 'manager'],          // hides rate/amount cols from tech/user
    create:       ['admin', 'manager'],
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
    create: ['admin', 'accountant'],
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
    view:        ['admin', 'accountant', 'manager', 'tech'],
    view_amounts:['admin', 'accountant', 'manager'],
    create:      ['admin', 'manager'],
    edit:        ['admin', 'manager'],
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
};

// ── Human-readable resource definitions (used by RBACManager matrix) ─────────
export const RESOURCE_DEFS = {
  clients:           { label: 'Clients & Vendors',   actions: ['view', 'create', 'edit', 'delete'] },
  projects:          { label: 'Projects / Quotes',   actions: ['view', 'view_rates', 'create', 'edit', 'delete', 'close', 'invoice', 'team_manage', 'allocation'] },
  inventory:         { label: 'Inventory',           actions: ['view', 'view_rates', 'create', 'edit', 'delete'] },
  finance:           { label: 'Finance',             actions: ['view', 'create', 'edit', 'delete'] },
  reports:           { label: 'Reports',             actions: ['view'] },
  employees:         { label: 'Employees',           actions: ['view', 'create', 'edit', 'delete', 'manage_roles'] },
  outsourcing:       { label: 'Outsourcing / POs',   actions: ['view', 'view_amounts', 'create', 'edit', 'delete'] },
  challans:          { label: 'Challans',            actions: ['view', 'create', 'edit', 'delete'] },
  expenses:          { label: 'Expenses',            actions: ['view_all', 'view_own', 'create', 'edit', 'delete', 'approve'] },
  purchase_invoices: { label: 'Purchase Invoices',   actions: ['view', 'create', 'edit', 'delete'] },
  documents:         { label: 'Documents',           actions: ['view', 'create', 'edit', 'delete'] },
  admin_tools:       { label: 'Admin Tools',         actions: ['view', 'edit'] },
  audit_logs:        { label: 'Audit Logs',          actions: ['view'] },
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
  // Use Firestore-loaded live config if available
  if (_liveConfig) {
    return _liveConfig.permissions?.[role]?.[resource]?.[action] ?? false;
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
});
