# Security Implementation — Rental-Ops
**Version:** 3.9+  
**Date:** March 2, 2026  
**App:** `terms-a005e` (Firebase project)

---

## Table of Contents
1. [Overview](#1-overview)
2. [Role Definitions](#2-role-definitions)
3. [Permission Matrix (Default)](#3-permission-matrix-default)
4. [Core Files](#4-core-files)
5. [Route-Level Guards (ProtectedRoute)](#5-route-level-guards)
6. [Handler-Level Guards (per page)](#6-handler-level-guards)
7. [Dynamic RBAC Manager](#7-dynamic-rbac-manager)
8. [Firestore Offline Persistence](#8-firestore-offline-persistence)
9. [Employee Role Change Control](#9-employee-role-change-control)
10. [Audit Trail](#10-audit-trail)
11. [How to Add a New Permission](#11-how-to-add-a-new-permission)

---

## 1. Overview

Rental-Ops uses a **two-layer RBAC (Role-Based Access Control)** system:

| Layer | Where | What it does |
|---|---|---|
| **Route Guard** | `ProtectedRoute.jsx` | Blocks entire page if role cannot even view it |
| **Handler Guard** | Inside each page's action handlers | Prevents write/delete even if someone bypasses UI |

The single source of truth is `src/utils/permissions.js`.  
Permissions can also be **customised live** by the Owner through the Admin Tools → Roles & Permissions Matrix (stored in Firestore `settings/rbac`).

---

## 2. Role Definitions

| Role ID | Display Name | Colour Badge | Description |
|---|---|---|---|
| `admin` | Owner | Red | Full access to everything |
| `accountant` | Accountant | Emerald | All finance & reports; view-only on operations |
| `manager` | Project Manager | Blue | Projects, clients, inventory, outsourcing, challans |
| `tech` | Field Tech | Orange | Challans (create/edit), own expenses, view projects/inventory |
| `user` | General User | Slate | View-only on projects, clients, inventory |

> Custom roles can be added by the Owner via Admin Tools → Roles & Permissions.  
> Built-in roles (above) cannot be deleted.

---

## 3. Permission Matrix (Default)

✅ = Allowed &nbsp; — = Denied

### 3.1 Clients & Vendors
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create | ✅ | — | ✅ | — | — |
| Edit | ✅ | — | ✅ | — | — |
| Delete | ✅ | — | — | — | — |

### 3.2 Projects / Quotes
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | ✅ |
| View Rates/Amounts | ✅ | ✅ | ✅ | — | — |
| Create | ✅ | — | ✅ | — | — |
| Edit | ✅ | — | ✅ | — | — |
| Delete | ✅ | — | — | — | — |
| Close Project | ✅ | — | — | — | — |
| Mark Invoiced | ✅ | ✅ | ✅ | — | — |
| Manage Team | ✅ | — | ✅ | — | — |
| Allocate Items | ✅ | — | ✅ | — | — |

### 3.3 Inventory
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | ✅ |
| View Rates | ✅ | ✅ | ✅ | — | — |
| Create | ✅ | — | ✅ | — | — |
| Edit | ✅ | — | ✅ | — | — |
| Delete | ✅ | — | — | — | — |

### 3.4 Finance
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | — | — |
| Create / Add | ✅ | ✅ | — | — | — |
| Edit | ✅ | ✅ | — | — | — |
| Delete | ✅ | ✅ | — | — | — |

### 3.5 Reports
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | — | — |

### 3.6 Employees
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create | ✅ | — | ✅ | — | — |
| Edit | ✅ | — | ✅ | — | — |
| Delete | ✅ | — | — | — | — |
| Change User Role | ✅ | — | — | — | — |

### 3.7 Outsourcing / Purchase Orders
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | — |
| View Amounts | ✅ | ✅ | ✅ | — | — |
| Create | ✅ | — | ✅ | — | — |
| Edit | ✅ | — | ✅ | — | — |
| Delete | ✅ | — | — | — | — |

### 3.8 Challans
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create | ✅ | — | ✅ | ✅ | — |
| Edit | ✅ | — | ✅ | ✅ | — |
| Delete | ✅ | — | — | — | — |

### 3.9 Expenses
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View All (any user's) | ✅ | ✅ | ✅ | — | — |
| View Own | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit | ✅ | ✅ | ✅ | — | — |
| Delete | ✅ | ✅ | — | — | — |
| Approve | ✅ | ✅ | ✅ | — | — |

### 3.10 Purchase Invoices
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | — | — |
| Create | ✅ | ✅ | ✅ | — | — |
| Edit | ✅ | ✅ | ✅ | — | — |
| Delete | ✅ | ✅ | — | — | — |

### 3.11 Documents
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | ✅ | ✅ | — |
| Create | ✅ | — | ✅ | — | — |
| Edit | ✅ | — | ✅ | — | — |
| Delete | ✅ | — | — | — | — |

### 3.12 Admin Tools
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | — | — | — | — |
| Edit | ✅ | — | — | — | — |

### 3.13 Audit Logs
| Action | Owner | Accountant | Project Manager | Field Tech | General User |
|---|:---:|:---:|:---:|:---:|:---:|
| View | ✅ | ✅ | — | — | — |

---

## 4. Core Files

| File | Purpose |
|---|---|
| [src/utils/permissions.js](src/utils/permissions.js) | All role & permission definitions, `can()` helper, `setLiveConfig()`, `buildDefaultConfig()`, `getNavAccess()` |
| [src/components/ProtectedRoute.jsx](src/components/ProtectedRoute.jsx) | React route wrapper — redirects to `/dashboard` if access denied |
| [src/pages/RBACManager.jsx](src/pages/RBACManager.jsx) | Admin UI — live permission matrix editor (adds/removes permissions, creates custom roles) |

### `can(role, resource, action)` — Main Helper

```js
import { can } from './utils/permissions';

can('tech', 'finance', 'create')  // → false
can('admin', 'finance', 'delete') // → true
can('manager', 'projects', 'edit') // → true
```

**Priority:** Checks Firestore-loaded live config first → falls back to static compiled defaults.

---

## 5. Route-Level Guards

File: [src/components/ProtectedRoute.jsx](src/components/ProtectedRoute.jsx)

Wraps a `<Route>` element to block entire page if the user lacks the minimum view permission.

```jsx
<ProtectedRoute role={effectiveRole} resource="finance">
  <Finance ... />
</ProtectedRoute>
```

### Protected Routes (8 routes)

| Route | Resource checked | Redirects to |
|---|---|---|
| `/admin` | `admin_tools` | `/dashboard` |
| `/finance` | `finance` | `/dashboard` |
| `/reports` | `reports` | `/dashboard` |
| `/challans` | `challans` | `/dashboard` |
| `/documents` | `documents` | `/dashboard` |
| `/purchase-invoices` | `purchase_invoices` | `/dashboard` |
| `/audit` | `audit_logs` | `/dashboard` |
| `/employees` | `employees` | `/dashboard` |

---

## 6. Handler-Level Guards

Even if a user bypasses the UI, all write/delete operations check `can()` before touching Firestore.

### Finance.jsx
```js
handleDelete      → can(role, 'finance', 'delete')
handleClientPayment → can(role, 'finance', 'create')
handleEmpPayout     → can(role, 'finance', 'create')
handleVendorPayment → can(role, 'finance', 'create')
```

### Outsourcing.jsx
```js
handleSaveWizardAllocation → can(role, 'outsourcing', 'create')
handleRemove               → can(role, 'outsourcing', 'delete')
handleCreatePO             → can(role, 'outsourcing', 'create')
handleUpdatePO             → can(role, 'outsourcing', 'edit')
```

### AdminTools.jsx
```js
// Component-level guard — renders "Access Restricted" screen for non-admin
if (!can(role, 'admin_tools', 'view')) return <AccessRestrictedScreen />
```

### Employees.jsx — Role Change Guard (Two Layers)

**Layer 1 — UI:** Role dropdown is `disabled={role !== 'admin'}`.

**Layer 2 — Handler:**
```js
const resolvedRole = role === 'admin'
  ? formData.role
  : (editingId ? (employees.find(e => e.id === editingId)?.role || 'user') : 'user');
```
Non-admin saves always write back the employee's **existing role**, ignoring any `formData.role` value.

---

## 7. Dynamic RBAC Manager

**Location:** Admin Tools → **Roles & Permissions** tab  
**File:** [src/pages/RBACManager.jsx](src/pages/RBACManager.jsx)  
**Firestore path:** `artifacts/{appId}/public/data/settings/rbac`

### Features
- Full scrollable matrix: 13 resources × up to 14 actions × N roles
- Individual toggle per cell (green = allowed, grey = denied)
- **Click role column header** → toggle all permissions for that role at once
- **Click action row label** → toggle that action across all roles at once
- **Save & Apply** → writes to Firestore + calls `setLiveConfig()` → active immediately, no page reload
- **Reset Defaults** → reverts to static compiled defaults
- **Add Custom Role** → role ID + display name + badge colour (all permissions start denied)
- **Delete Custom Role** → hover role badge, click ×  (built-in roles protected)

### How Live Config Works

```
App starts
  └─ useEffect (role set after login)
      └─ getDoc('settings/rbac')
          └─ setLiveConfig(data)   ← updates module-level variable in permissions.js

can('tech', 'finance', 'view')
  └─ checks _liveConfig first
  └─ falls back to static PERMISSIONS if no Firestore doc exists
```

### Firestore Document Structure (`settings/rbac`)
```json
{
  "rolesMeta": {
    "admin":      { "label": "Owner",           "color": "bg-red-500",     "isBuiltIn": true },
    "accountant": { "label": "Accountant",       "color": "bg-emerald-600", "isBuiltIn": true },
    "manager":    { "label": "Project Manager",  "color": "bg-blue-500",    "isBuiltIn": true },
    "tech":       { "label": "Field Tech",       "color": "bg-orange-500",  "isBuiltIn": true },
    "user":       { "label": "General User",     "color": "bg-slate-400",   "isBuiltIn": true }
  },
  "permissions": {
    "admin": {
      "finance": { "view": true, "create": true, "edit": true, "delete": true },
      "projects": { "view": true, "create": true, ... }
    },
    "tech": {
      "finance": { "view": false, "create": false, "edit": false, "delete": false },
      ...
    }
  }
}
```

---

## 8. Firestore Offline Persistence

File: [src/firebase.js](src/firebase.js)

All Firestore data is cached to **IndexedDB** (browser's built-in database, ≥500 MB capacity).

```js
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
```

### Behaviour
| Scenario | Result |
|---|---|
| Online | Reads/writes go to Firebase; IndexedDB updated as mirror |
| Offline — read | Data served from IndexedDB cache (last synced state) |
| Offline — write | Write queued in IndexedDB |
| Back online | Queued writes auto-synced to Firebase |
| Multiple tabs | One tab acts as sync leader; others read from the same cache |

**DevTools inspection:** Application → IndexedDB → `firestore/[project-id]`

---

## 9. Employee Role Change Control

Only the **Owner (`admin`)** can change a user's role. Enforced at two independent levels:

| Level | Code location | How |
|---|---|---|
| UI | [Employees.jsx](src/pages/Employees.jsx) | `<select disabled={role !== 'admin'}>` + explanatory message |
| Handler | `handleSave()` in Employees.jsx | Non-admin writes are forced back to the employee's current DB role |

This means even if the disabled select is bypassed via browser dev tools, the saved value to Firestore is always the **original role** for non-admin users.

---

## 10. Audit Trail

Every significant action is logged via `logAction()` to Firestore collection `audit_logs`.

| Event | Logged on |
|---|---|
| Employee saved / created | `handleSave` in Employees.jsx |
| Finance record deleted | `handleDelete` in Finance.jsx |
| Payment / payout recorded | Finance handlers |
| Vendor payment | Finance handlers |
| RBAC matrix saved | RBACManager.jsx `handleSave` |
| Data backup / restore | AdminTools.jsx |
| Admin password changed | AdminTools.jsx |
| Challan created / printed | ChallanManager.jsx |
| Password changed | Employees.jsx `handlePasswordChange` |
| Account unlocked | Employees.jsx `handleUnlock` |

**Access:** Audit Logs page (`/audit`) — restricted to `admin` and `accountant` roles only.

---

## 11. How to Add a New Permission

### Option A — Dynamic (via Admin Tools UI)
1. Log in as Owner
2. Go to **Admin Tools → Roles & Permissions**
3. Toggle the desired cell in the matrix
4. Click **Save & Apply** — takes effect immediately

### Option B — Code (permanent default)

**Step 1:** Add the action to `PERMISSIONS` in [src/utils/permissions.js](src/utils/permissions.js):
```js
projects: {
  my_new_action: ['admin', 'manager'],  // ← add here
}
```

**Step 2:** Add it to `RESOURCE_DEFS` so it appears in the matrix UI:
```js
projects: {
  label: 'Projects / Quotes',
  actions: [..., 'my_new_action'],  // ← add here
}
```

**Step 3:** Add a display label in `ACTION_LABELS`:
```js
my_new_action: 'My New Action Label',
```

**Step 4:** Use `can()` in the relevant handler or component:
```js
if (!can(role, 'projects', 'my_new_action')) return alert('Access denied.');
```

---

## Summary of Security Layers

```
User logs in
  │
  ├─ Role loaded from Firestore employees collection
  │
  ├─ RBAC config loaded from Firestore settings/rbac
  │    └─ setLiveConfig() → all can() calls use Firestore-defined permissions
  │
  └─ Navigation
       ├─ Nav items hidden if !can(role, resource, 'view')
       │
       ├─ Route guard: ProtectedRoute → redirect to /dashboard if denied
       │
       └─ Page loaded
            ├─ UI elements hidden/disabled based on can()
            └─ Action handlers guard with can() before any Firestore write
                 └─ Role-change handler extra-locks resolved role for non-admin
```
