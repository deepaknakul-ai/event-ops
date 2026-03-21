# Rental-Ops: AI Agent Instructions

## Project Overview

**rental-ops** is a comprehensive **event equipment rental & logistics management system** built with **React 19 + Vite + Firebase**. The monolithic [App.jsx](src/App.jsx) (~7000 lines) manages clients, inventory, projects (quotes), finance, and operational workflows with role-based access (admin/manager/tech).

**Key Architectural Pattern:** Component-based UI sections (Clients, Projects, Finance, Inventory) implemented as sub-components within App.jsx, sharing centralized Firestore state via props and the `logAction()` audit trail.

---

## Core Architecture & Data Model

### Firestore Structure
```
artifacts/{appId}/public/data/
├── clients/        # Clients + Vendors (dual-type records)
├── inventory/      # Equipment (composite kits, vendor-supplied items)
├── projects/       # Quotes & Project Execution (with items, challans, logistics)
├── employees/      # Staff (with financial tracking)
├── expenses/       # Employee expense claims
├── payments/       # Client receivables
├── payouts/        # Employee salary/cash disbursements
├── vendor_payments/# Payments to vendor contractors
├── counters/       # FY-based challan numbering
└── settings/       # Organization details (name, GST, logo)
```

### Critical Data Flows

1. **Revenue Calculation (Projects):**
   - Equipment items: `qty × rate × days × (1 + GST%)`
   - Logistics costs: 5 pre-configured cost types (travel, accommodation, food, labour, transport)
   - Output GST = Sum of all item GST + logistics GST
   - **Key Helper:** [getProjectGrandTotal()](src/utils/helpers.js) – used extensively in reporting

2. **Inventory Management:**
   - **Composite Items (Kits):** When allocated to project, expanded to base components
   - **Vendor Items (`is_external`):** Linked to vendor client via `vendor_id`
   - **Quantity Tracking:** Projects check overlapping date ranges for available qty
   - **Serial Numbers:** Support multi-unit tracking (e.g., 5× projectors with unique serials)

3. **Project Lifecycle:** Quoted → Confirmed → Ongoing → Completed → Closed (invoiced)
   - **Challans:** Delivery & Return transport docs with item-level tracking
   - **Invoicing:** Only after "Completed" status; tracks invoice_no, invoice_date, invoice_status

4. **Financial Balances:**
   - **Employee:** Balance = (Advances + Payouts) - Expenses
   - **Vendor:** Balance = (Total POs) - (Payments Made)

---

## Developer Workflows

### Build & Run
```bash
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # Production build (dist/)
npm run preview    # Preview production build
npm run lint       # ESLint check
```

### Development Commands (Non-obvious)
- **Firebase Init:** Already configured in `firebase.js` (API key public, security rules control access)
- **Vite Config:** Minimal setup, React plugin with Fast Refresh enabled
- **Tailwind/PostCSS:** Configured for utility-first styling

### Common Debugging Patterns
- **Console Logs:** Check browser console for Firebase auth/Firestore errors
- **Network Tab:** Inspect Firestore requests & payloads
- **Redux DevTools:** Not used; state managed via React hooks + Firestore listeners (`onSnapshot`)
- **Audit Trail:** Check Firebase `logAction()` calls for action tracking

---

## Project-Specific Conventions

### Naming & Patterns
| Aspect | Convention | Example |
|--------|-----------|---------|
| **State Variables** | Descriptive, plural for arrays | `projects`, `filteredInventory` |
| **Handlers** | `handle{Action}` | `handleSaveAllocation()` |
| **Modals** | `is{Name}Open` state + `Modal` component | `isChallanModalOpen` |
| **Firestore Refs** | `doc(db, 'artifacts', appId, 'public', 'data', collection, id)` | Consistent path structure |
| **Timestamps** | ISO 8601 strings (`new Date().toISOString()`) | Firestore `serverTimestamp()` for server-side |
| **Currency Display** | [formatCurrency()](/src/utils/helpers.js) (Indian Rupees) | ₹12,345.67 |
| **Form Reset** | Conditional setState with `initialState` or object spread | `{ ...initialForm }` |

### Role-Based Access Control (RBAC)
```jsx
if (role !== 'admin') { /* block action */ }
if ((role === 'admin' || role === 'manager') && /* condition */) { /* show edit */ }
role === 'tech' ? /* limited view */ : /* full view */
```
Three roles: `admin` (full), `manager` (mostly), `tech` (view-only on finance/logistics).

### Color & Status Coding
- **Status Colors:** [STATUS_COLORS object](/src/utils/constants.js) – Quoted=orange, Confirmed=green, Ongoing=red, Completed=blue, Closed=black
- **Financial:** Green (income), Red (expense), Orange (vendor), Blue (projects)

---

## Cross-Component Integration Points

### 1. **Projects ↔ Inventory**
   - Allocation modal: Filter inventory by category, check available qty via overlapping date logic
   - **Key Check:** [isDateOverlap()](/src/utils/helpers.js) – prevents double-booking
   - **External Items:** Projects can reference vendor-supplied inventory items

### 2. **Projects ↔ Clients**
   - Client selector in project creation; one-way reference (project → client_id)
   - Vendor assets modal: Vendor clients can manage external inventory

### 3. **Projects ↔ Employees**
   - Team assignment with busy-status check (overlapping projects)
   - Employees see assigned projects in UI

### 4. **Projects ↔ Finance**
   - Payments/Payouts linked to project_id or 'general' account
   - Expense claims filtered by project
   - **Profit Calc:** Equipment + Logistics revenue vs. Outsourcing + Direct expenses

### 5. **Inventory ↔ Clients (Vendors)**
   - Vendor items stored with `vendor_id` pointing to client record
   - Supplier matrix: Inventory item can have multiple vendor quotes (brand, spec, rate)

---

## Key Implementation Details

### Challans (Transport Documents)
- **Two Types:** Delivery (items sent to project), Return (items back to warehouse)
- **Auto-Numbering:** Uses Firestore transaction with `counters/{FY}` doc
- **Format:** `{FY}/{number}` (e.g., `2024-25/0001`)
- **PDF Generation:** jsPDF + autoTable; includes transport details, GST, T&Cs
- **Validation:** Prevents return qty > delivered qty

### Invoice Management
- Constrained to "Completed" or "Closed" projects (enforced by role check)
- Tracks `invoice_no`, `invoice_date`, `invoice_status` ('Invoiced' / 'Not Invoiced')
- **Filtering:** Finance module supports invoice_status filter

### Challan Serials & E-Way Bills
- Serial numbers optional per item
- E-Way Bill JSON export for GST compliance
- Dry-run print before final save recommended

### Composite Kits
- Parent item with `is_composite: true` + `composition[]` array
- When allocated to project, automatically expanded to sub-items in pick lists
- Prevents circular references (cannot add item as own component)

---

## Common Errors & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| "Missing required fields" | Form validation | Check all inputs before `addDoc/updateDoc` |
| "Overbooking warning" | Qty exceeds available | Confirm quantity overlaps with other projects |
| "Only Admin can close projects" | Role check | Ensure admin login |
| Challan prints blank | jsPDF Y coordinate overflow | Verify page layout doesn't exceed max pages |
| Firestore read fails | No auth token | Re-login; check `auth.currentUser` |

---

## Testing & Quality Assurance

- **No automated tests** (E2E tests not in scope; manual QA workflow)
- **Lint:** ESLint configured; run before commits
- **Staging:** Use preview build to test production code locally
- **Firestore Rules:** Rules file not provided; assume public read/write for now

---

## Git & Version Control

Backup versions stored in [src/app backup/version/](/src/app%20backup/version/) (v1.0 → v3.7.2). **Do NOT edit backup files; they are for reference only.**

Current version: **~v3.9** (based on latest App.jsx comments).

---

## Extension Points for Agents

### High-Impact Improvements
1. **TypeScript Migration:** Convert `.jsx` to `.tsx` for type safety (start with `helpers.js` → `helpers.ts`)
2. **Component Extraction:** Break App.jsx into modular `/components` (Clients, Projects, Finance, Inventory)
3. **State Management:** Migrate to Zustand or Redux for cleaner global state
4. **Testing:** Add Vitest + React Testing Library for critical functions (allocation, challan generation)
5. **API Layer:** Introduce custom hooks (`useProjects()`, `useInventory()`) to abstract Firestore
6. **Audit UI:** Dashboard to visualize `logAction()` trails with filters

### Common Modification Patterns
- **Add Field to Form:** 1) Add to `initialForm` object, 2) Add input field in modal, 3) Persist in `handleSave()`
- **Add Filter:** 1) Add state variable, 2) Add input to filter bar, 3) Update filtering logic in `useMemo()`
- **Add Role Restriction:** Wrap UI in `role !== 'tech' && { ... }` or throw alert in handler

---

## References & Key Files

| File | Purpose |
|------|---------|
| [App.jsx](src/App.jsx) | Main app (7000+ lines; all major modules) |
| [firebase.js](src/firebase.js) | Firebase/Firestore initialization |
| [helpers.js](src/utils/helpers.js) | Currency, date, GST validation utilities |
| [constants.js](src/utils/constants.js) | Status colors, categories, logistics types |
| [Shared.jsx](src/components/Shared.jsx) | Modal, Toast, LoadingSpinner components |
| [Dashboard.jsx](src/pages/Dashboard.jsx) | KPI metrics & calendar visualization |
| [package.json](package.json) | Dependencies (React 19, Firebase 12.7, Recharts, jsPDF) |

---

## Quick Start for Agents

1. **Understand Data:** Read Firestore structure & [helpers.js](src/utils/helpers.js)
2. **Identify Module:** Locate the relevant sub-component in App.jsx (Projects, Inventory, Finance)
3. **Trace State:** Follow props from App → component → handlers
4. **Implement Change:** Edit handler logic or form definition, then `updateDoc()` Firestore
5. **Test:** Use browser console & check Firestore emulator or live DB
6. **Log Action:** Call `logAction()` before/after change for audit trail
