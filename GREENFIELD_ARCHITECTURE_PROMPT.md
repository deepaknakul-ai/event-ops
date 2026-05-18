# GREENFIELD ARCHITECTURE PROMPT
## Event Equipment Rental & Logistics Management System

> **Purpose:** Complete specification for building a production-grade equipment rental management platform from scratch. This document is the single source of truth for an AI coding agent or development team to architect, build, and ship the application.

---

## TABLE OF CONTENTS

1. [Product Vision & Scope](#1-product-vision--scope)
2. [Technology Stack](#2-technology-stack)
3. [Application Architecture](#3-application-architecture)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [Database Schema](#5-database-schema)
6. [Module Specifications](#6-module-specifications)
7. [Business Logic & Calculations](#7-business-logic--calculations)
8. [PDF Generation](#8-pdf-generation)
9. [Public Pages & External Access](#9-public-pages--external-access)
10. [HR & Workforce Module](#10-hr--workforce-module)
11. [Accounting Engine](#11-accounting-engine)
12. [UI/UX Requirements](#12-uiux-requirements)
13. [Data Validation & Constraints](#13-data-validation--constraints)
14. [Security Requirements](#14-security-requirements)
15. [Performance & Scalability](#15-performance--scalability)
16. [Testing Strategy](#16-testing-strategy)
17. [Build Order & Milestones](#17-build-order--milestones)
18. [Acceptance Criteria](#18-acceptance-criteria)

---

## 1. PRODUCT VISION & SCOPE

### 1.1 What This System Does

A **multi-tenant, role-based SaaS platform** for managing the entire lifecycle of event equipment rental operations:

- **Clients & Vendors:** Manage parties (clients, vendors, or dual-type) with multi-branch/company support, each branch having unique GSTIN and independent financial tracking
- **Inventory:** Track equipment assets with serial numbers, composite kits (auto-expandable), vendor-supplied items, availability checking across overlapping project dates, LED Wall specialized calculations
- **Projects:** Full lifecycle from Quoted → Confirmed → Ongoing → Completed → Closed, with equipment allocation, team assignment, vendor outsourcing, logistics costing, and package-cost vs itemized pricing modes
- **Finance:** Client payments (receivables), employee payouts, vendor payments, FY-grouped with locking
- **Tax Invoices:** GST-compliant sales invoices with multi-project bundling, auto-numbering, intra/inter-state tax logic, professional PDF generation
- **Purchase Orders:** Vendor PO creation with cost waterfall (invoice actuals → PO committed → allocation estimate)
- **Challans:** Delivery and return transport documents with auto-numbering, serial tracking, E-Way Bill export
- **Accounting:** Double-entry bookkeeping, chart of accounts, journal entries, trial balance, P&L, balance sheet
- **HR Module:** Attendance with GPS geofencing, leave management, shift tracking, payroll, penalty system
- **Reporting:** Business P&L, outsourcing analysis, project status, financial summaries
- **Audit Trail:** Immutable logging of all CRUD operations across all modules
- **Public Pages:** Token-based external access for client ledger, employee ledger, reimbursable expenses, quote approval

### 1.2 Users & Roles

| Role | Label | Access Level |
|------|-------|--------------|
| `admin` | Owner | Full CRUD on all resources, FY management, RBAC configuration, employee role assignment |
| `accountant` | Accountant | Finance, reports, tax/purchase invoices, accounting, audit logs. View-only on operations |
| `manager` | Project Manager | Projects, clients, inventory, outsourcing, challans, team assignment, expense approval |
| `tech` | Field Tech | Challans, own expenses, view projects/inventory (rates hidden), attendance check-in/out |
| `user` | General User | View-only on projects/clients/inventory, own leaves/shifts |

### 1.3 Indian Market Context

- All currency in **Indian Rupees (₹)** formatted with Indian number system (₹12,34,567.89)
- **GST compliance:** GSTIN validation (15-char format), HSN/SAC codes, CGST/SGST vs IGST auto-detection based on state match
- **Financial Year:** April–March (e.g., FY 2024-25)
- **36 GST state codes** mapped (01: Jammu & Kashmir through 38: Ladakh)

---

## 2. TECHNOLOGY STACK

### 2.1 Recommended Stack (Greenfield)

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Frontend** | React 19 + Vite | Fast HMR, modern React features |
| **Routing** | react-router-dom v7 | Nested routes, URL params, query params |
| **State Management** | Zustand | Lightweight global state, replaces prop drilling |
| **Styling** | Tailwind CSS 3.x | Utility-first, rapid UI development |
| **Icons** | lucide-react | Consistent icon set |
| **Backend/DB** | Firebase (Firestore + Auth + Storage) | Serverless, real-time listeners, offline support |
| **PDF Generation** | jsPDF + jspdf-autotable | Client-side invoice/challan/quotation PDFs |
| **Excel Export** | xlsx + exceljs | Spreadsheet exports for reports/payments |
| **Charts** | Recharts | Revenue charts, KPI visualizations |
| **Date Handling** | Native Date (ISO 8601 strings) | No external library, all dates stored as ISO strings |
| **Type Safety** | TypeScript (.tsx) | Type-safe from day one |
| **Testing** | Vitest + React Testing Library + Playwright | Unit + integration + E2E |

### 2.2 Project Structure

```
src/
├── main.tsx                          # Entry point
├── App.tsx                           # Router + layout + auth wrapper
├── firebase.ts                       # Firebase init + db/auth/storage exports
├── stores/                           # Zustand stores
│   ├── authStore.ts                  # Auth state + user role
│   ├── clientStore.ts                # Clients + vendors + branches
│   ├── projectStore.ts              # Projects lifecycle
│   ├── inventoryStore.ts            # Equipment + kits + availability
│   ├── financeStore.ts              # Payments + payouts + vendor payments
│   ├── employeeStore.ts            # Employee profiles
│   ├── expenseStore.ts             # Expense claims
│   ├── invoiceStore.ts             # Tax + purchase invoices
│   ├── challanStore.ts             # Challans
│   ├── settingsStore.ts            # Org settings + counters
│   └── hrStore.ts                   # Attendance + leaves + shifts
├── hooks/                            # Custom hooks
│   ├── useFirestoreCollection.ts     # Generic snapshot listener
│   ├── usePermission.ts             # can(role, resource, action)
│   ├── useFinancialYear.ts          # FY calculation + locking
│   └── useAvailability.ts           # Inventory availability checker
├── utils/
│   ├── helpers.ts                    # Currency, date, GST, calculation utilities
│   ├── constants.ts                  # Status colors, categories, types, state codes
│   ├── permissions.ts                # RBAC matrix + can() function
│   ├── accounting.ts                 # Journal entries, trial balance, P&L, balance sheet
│   ├── pdf/
│   │   ├── invoicePdf.ts            # Tax invoice PDF
│   │   ├── quotationPdf.ts          # Quotation PDF
│   │   ├── challanPdf.ts            # Challan PDF
│   │   ├── jobSheetPdf.ts           # Job sheet PDF
│   │   ├── pickListPdf.ts           # Pick list PDF
│   │   └── reportPdf.ts            # Business report PDF
│   └── validators.ts                # GSTIN, email, phone, form validators
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx               # Main navigation
│   │   ├── Header.tsx                # Top bar + search + notifications
│   │   └── ProtectedRoute.tsx        # Auth + role guard
│   ├── shared/
│   │   ├── Modal.tsx                 # Reusable modal
│   │   ├── Toast.tsx                 # Notification toasts
│   │   ├── LoadingSpinner.tsx        # Loading state
│   │   ├── ConfirmDialog.tsx         # Delete/action confirmation
│   │   ├── DataTable.tsx             # Sortable, filterable table
│   │   ├── SearchInput.tsx           # Debounced search
│   │   ├── StatusBadge.tsx           # Color-coded status pill
│   │   ├── CurrencyDisplay.tsx       # ₹ formatted amount
│   │   ├── DateRangePicker.tsx       # Date range selector
│   │   └── FileUpload.tsx            # Firebase Storage upload
│   ├── clients/
│   │   ├── ClientList.tsx            # Directory cards
│   │   ├── ClientForm.tsx            # Create/edit modal
│   │   ├── ClientDashboard.tsx       # Per-client dashboard
│   │   ├── BranchManager.tsx         # Company/branch CRUD
│   │   └── ContactManager.tsx        # Contact persons
│   ├── projects/
│   │   ├── ProjectList.tsx           # List + filters
│   │   ├── ProjectForm.tsx           # Create/edit modal
│   │   ├── ProjectDetail.tsx         # Detail panel
│   │   ├── AllocationModal.tsx       # Equipment allocation
│   │   ├── TeamAssignment.tsx        # Employee assignment
│   │   ├── OrderConfirmation.tsx     # Confirmation workflow modal
│   │   ├── InvoicingModal.tsx        # Bulk invoice application
│   │   ├── OutsourcingPanel.tsx      # Vendor allocations/POs
│   │   └── ReimbursableExpenses.tsx  # Client actuals billing
│   ├── inventory/
│   │   ├── InventoryList.tsx         # Master list + filters
│   │   ├── InventoryForm.tsx         # Create/edit modal
│   │   ├── SerialManager.tsx         # Serial number CRUD
│   │   ├── CompositeBuilder.tsx      # Kit composition editor
│   │   ├── SupplierMatrix.tsx        # Vendor rate comparison
│   │   ├── AvailabilityCalendar.tsx  # Visual availability
│   │   └── LEDWallCalculator.tsx     # LED tile spec calculator
│   ├── finance/
│   │   ├── PaymentList.tsx           # Receive payments
│   │   ├── PayoutList.tsx            # Employee payouts
│   │   ├── VendorPaymentList.tsx     # Vendor payments
│   │   └── PaymentForm.tsx           # Create/edit payment
│   ├── invoices/
│   │   ├── TaxInvoiceList.tsx        # Sales invoice list
│   │   ├── TaxInvoiceForm.tsx        # Create/edit invoicce
│   │   ├── PurchaseInvoiceList.tsx   # PO/vendor invoice list
│   │   └── PurchaseInvoiceForm.tsx   # Create/edit PO
│   ├── challans/
│   │   ├── ChallanList.tsx           # All challans
│   │   ├── ChallanForm.tsx           # Create delivery/return
│   │   └── EWayBillExport.tsx        # GST E-Way Bill
│   ├── accounting/
│   │   ├── ChartOfAccounts.tsx
│   │   ├── JournalEntries.tsx
│   │   ├── TrialBalance.tsx
│   │   ├── ProfitAndLoss.tsx
│   │   └── BalanceSheet.tsx
│   ├── hr/
│   │   ├── HRDashboard.tsx
│   │   ├── AttendancePanel.tsx
│   │   ├── LeaveManager.tsx
│   │   ├── PayrollEngine.tsx
│   │   └── HRSettings.tsx
│   └── reports/
│       ├── BusinessReport.tsx
│       └── OutsourcingReport.tsx
├── pages/                            # Route-level page components
│   ├── DashboardPage.tsx
│   ├── ProjectsPage.tsx
│   ├── ClientsPage.tsx
│   ├── InventoryPage.tsx
│   ├── FinancePage.tsx
│   ├── TaxInvoicesPage.tsx
│   ├── PurchaseInvoicesPage.tsx
│   ├── ChallansPage.tsx
│   ├── EmployeesPage.tsx
│   ├── ExpensesPage.tsx
│   ├── AccountingPage.tsx
│   ├── ReportsPage.tsx
│   ├── AuditLogsPage.tsx
│   ├── AdminToolsPage.tsx
│   ├── RBACManagerPage.tsx
│   ├── ProfileSettingsPage.tsx
│   ├── HRDashboardPage.tsx
│   ├── HRAttendancePage.tsx
│   ├── HRLeavesPage.tsx
│   ├── HRPayrollPage.tsx
│   ├── HRReportsPage.tsx
│   ├── HRSettingsPage.tsx
│   ├── HRPortalPage.tsx
│   ├── DocumentsHubPage.tsx
│   └── public/                       # No auth required
│       ├── PublicLedgerPage.tsx
│       ├── PublicEmployeeLedgerPage.tsx
│       ├── PublicReimbursablePage.tsx
│       └── QuoteApprovalPage.tsx
└── types/
    ├── client.ts                     # Client/Vendor/Branch types
    ├── project.ts                    # Project + items + logistics
    ├── inventory.ts                  # Equipment + serial + kit
    ├── employee.ts                   # Employee profile
    ├── expense.ts                    # Expense claim
    ├── payment.ts                    # Payment/payout/vendor payment
    ├── invoice.ts                    # Tax + purchase invoice
    ├── challan.ts                    # Challan + transport
    ├── accounting.ts                 # Journal + accounts
    ├── hr.ts                         # Attendance + leave + shift
    └── common.ts                     # Shared types (Timestamp, FY, etc.)
```

---

## 3. APPLICATION ARCHITECTURE

### 3.1 Data Flow Pattern

```
Firestore (Source of Truth)
    ↓ onSnapshot listeners
Zustand Stores (Reactive State)
    ↓ selectors
Page Components (Route-Level)
    ↓ props
Feature Components (UI Elements)
    ↓ handlers
Firestore Write (addDoc/updateDoc/deleteDoc + logAction)
```

### 3.2 Core Architectural Rules

1. **Every Firestore write MUST call `logAction()`** before or after the operation to maintain audit trail
2. **All financial documents store denormalized snapshots** (client name, GSTIN, address at time of creation) — never rely on live lookups for historical records
3. **Entity flattening pattern:** Branches appear as independent entities alongside their parent in all selector dropdowns, using composite keys (`clientId::companyId`)
4. **Branch isolation:** Each branch has its own financial position (outstanding, receivables, invoices) independent from its parent
5. **Parent aggregation:** Parent client dashboard aggregates all branch data with per-branch breakdown
6. **Offline-first:** Firestore persistence enabled; UI must handle optimistic updates gracefully

### 3.3 Global State Architecture (Zustand)

```typescript
// Example: clientStore.ts
interface ClientStore {
  clients: Client[];
  loading: boolean;
  subscribe: () => Unsubscribe;  // onSnapshot listener

  // Derived: clients + branches flattened
  getDisplayParties: () => DisplayParty[];

  // Derived: entity options for selectors (client + branches)
  getEntityOptions: () => EntityOption[];

  // CRUD
  addClient: (data: ClientInput) => Promise<void>;
  updateClient: (id: string, data: Partial<Client>) => Promise<void>;
  deleteClient: (id: string) => Promise<void>;

  // Branch operations
  addBranch: (clientId: string, branch: CompanyBranch) => Promise<void>;
  updateBranch: (clientId: string, branchId: string, data: Partial<CompanyBranch>) => Promise<void>;
  deleteBranch: (clientId: string, branchId: string) => Promise<void>;
}
```

### 3.4 Firestore Path Convention

All collections live under a single app namespace:

```
artifacts/{appId}/public/data/{collection}/{docId}
```

Where `appId` is a constant (e.g., `'TERMS 1.0.0'`).

### 3.5 Routing Architecture

```
/                           → Dashboard
/projects                   → Projects list + detail sidepanel
/clients                    → Clients & Vendors directory
/inventory                  → Equipment master list
/finance                    → Payments (3 tabs: Receive, Employee Payout, Vendor Payment)
/tax-invoices               → Sales invoices
/purchase-invoices          → POs & vendor invoices
/challans                   → Delivery & return challans
/employees                  → Employee management
/expenses                   → Expense claims
/outsourcing                → Vendor allocation overview
/accounting                 → Chart of accounts, journal, trial balance, P&L, balance sheet
/reports                    → Business reports
/business-report            → Detailed P&L report
/audit-logs                 → Action history
/admin-tools                → Settings, FY management
/rbac-manager               → Permission matrix editor
/profile                    → User profile
/documents                  → Document library
/hr/dashboard               → HR KPIs
/hr/attendance              → Attendance logs
/hr/leaves                  → Leave management
/hr/payroll                 → Payroll
/hr/reports                 → HR reports
/hr/settings                → HR config
/hr/portal                  → Employee self-service

# Public routes (no auth)
/ledger/:token              → Client public ledger (?company=branchId for branch scope)
/employee-ledger/:token     → Employee public ledger
/reimbursable/:token        → Reimbursable expenses view
/quote/:token               → Quote approval page
```

---

## 4. AUTHENTICATION & AUTHORIZATION

### 4.1 Authentication

- **Firebase Auth** with email/password sign-in
- Employee record in Firestore stores role and email
- On auth state change → lookup employee by email → set role in auth store
- Failed login tracking: increment `fail_count` on employee doc; lock at threshold (e.g., 5 attempts)
- Locked accounts show alert on Dashboard; admin can unlock

### 4.2 Authorization (RBAC)

#### Permission Matrix Structure

```typescript
type Role = 'admin' | 'accountant' | 'manager' | 'tech' | 'user';

type Resource =
  | 'clients' | 'projects' | 'inventory' | 'finance' | 'reports'
  | 'employees' | 'outsourcing' | 'challans' | 'expenses'
  | 'purchase_invoices' | 'tax_invoices' | 'documents' | 'admin_tools'
  | 'audit_logs'
  | 'hr_dashboard' | 'hr_attendance' | 'hr_leaves' | 'hr_shifts'
  | 'hr_penalties' | 'hr_payroll' | 'hr_reports' | 'hr_settings' | 'hr_portal';

type Action = 'view' | 'view_rates' | 'view_amounts' | 'view_all' | 'view_own'
  | 'create' | 'edit' | 'delete' | 'close' | 'invoice' | 'approve'
  | 'team_manage' | 'allocation' | 'manage_roles';
```

#### Default Permission Rules

| Resource | admin | accountant | manager | tech | user |
|----------|-------|-----------|---------|------|------|
| clients.view | ✅ | ✅ | ✅ | ✅ | ✅ |
| clients.create | ✅ | ❌ | ✅ | ❌ | ❌ |
| clients.edit | ✅ | ❌ | ✅ | ❌ | ❌ |
| clients.delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| projects.view | ✅ | ✅ | ✅ | ✅ | ✅ |
| projects.view_rates | ✅ | ✅ | ✅ | ❌ | ❌ |
| projects.create | ✅ | ❌ | ✅ | ❌ | ❌ |
| projects.edit | ✅ | ✅ | ✅ | ❌ | ❌ |
| projects.close | ✅ | ✅ | ✅ | ❌ | ❌ |
| projects.invoice | ✅ | ✅ | ✅ | ❌ | ❌ |
| projects.team_manage | ✅ | ❌ | ✅ | ❌ | ❌ |
| projects.allocation | ✅ | ❌ | ✅ | ❌ | ❌ |
| inventory.view | ✅ | ✅ | ✅ | ✅ | ✅ |
| inventory.view_rates | ✅ | ✅ | ✅ | ❌ | ❌ |
| inventory.create | ✅ | ❌ | ✅ | ❌ | ❌ |
| inventory.edit | ✅ | ❌ | ✅ | ❌ | ❌ |
| inventory.delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| finance.* | ✅ | ✅ | ❌ | ❌ | ❌ |
| reports.view | ✅ | ✅ | ✅ | ❌ | ❌ |
| employees.manage_roles | ✅ | ❌ | ❌ | ❌ | ❌ |
| challans.create | ✅ | ❌ | ✅ | ✅ | ❌ |
| expenses.view_all | ✅ | ✅ | ✅ | ❌ | ❌ |
| expenses.view_own | ✅ | ✅ | ✅ | ✅ | ✅ |
| expenses.approve | ✅ | ✅ | ✅ | ❌ | ❌ |
| audit_logs.view | ✅ | ✅ | ❌ | ❌ | ❌ |
| admin_tools.* | ✅ | ❌ | ❌ | ❌ | ❌ |

#### Live Configuration Override

- Admin can customize permission matrix via RBAC Manager UI
- Live config stored in Firestore (`settings/rbac_config`)
- `can(role, resource, action)` checks live config first, falls back to static defaults
- `getNavAccess(role)` returns which sidebar sections are visible

---

## 5. DATABASE SCHEMA

### 5.1 Collections

#### `clients`
```typescript
interface Client {
  id: string;                        // Firestore doc ID
  name: string;                      // Organization name
  type: 'Client' | 'Vendor' | 'Both';
  gstin: string;                     // 15-char GSTIN (unique across primary + branches)
  state: string;                     // State name
  address: string;                   // Primary address
  billing_terms: 'Net 15' | 'Net 30' | 'Net 45' | 'Net 60' | 'Net 90';
  contacts: Contact[];               // Multiple contact persons
  companies: CompanyBranch[];         // Additional branches/companies
  ledger_link_token?: string;         // Token for public ledger
  ledger_link_expiry?: string;        // ISO date
  reimbursable_token?: string;        // Token for reimbursable view
  reimbursable_token_expiry?: string;
  created_at: string;                // ISO timestamp
  updated_at: string;
}

interface Contact {
  name: string;
  role: string;
  phone: string;
  email: string;
}

interface CompanyBranch {
  id: string;                        // UUID or nanoid
  name: string;                      // Branch/company name
  gstin: string;                     // Unique GSTIN
  state: string;
  address: string;
}
```

#### `projects`
```typescript
interface Project {
  id: string;
  project_name: string;
  client_id: string;                 // FK → clients
  party_company_id: string;          // 'primary' or branch.id
  party_company_name: string;        // Snapshot at creation
  party_company_gstin: string;       // Snapshot
  party_company_address: string;     // Snapshot
  venue: string;
  status: 'Quoted' | 'Confirmed' | 'Ongoing' | 'Completed' | 'Closed';
  start_date: string;               // ISO date
  end_date: string;                  // ISO date
  setup_date?: string;              // Optional pre-setup date

  // Pricing mode
  is_package_cost: boolean;          // true = flat rate, false = itemized
  package_cost: number;              // Used when is_package_cost = true
  package_cost_gst: number;          // GST% for package cost

  // Itemized pricing
  items: ProjectItem[];
  logistics_costs: LogisticsCosts;

  // Team
  assigned_employees: string[];      // FK[] → employees

  // Vendor outsourcing
  vendor_allocations: VendorAllocation[];
  vendor_pos: string[];              // FK[] → purchase_invoices

  // Transport
  challans: string[];                // FK[] → challans

  // Invoicing
  invoice_no: string;
  invoice_date: string;
  invoice_status: 'Not Invoiced' | 'Invoiced';

  // Order confirmation
  confirmation_details?: ConfirmationDetails;

  // Reimbursable expenses
  reimbursable_expenses: ReimbursableExpense[];

  // Remarks timeline
  remarks: ProjectRemark[];

  created_at: string;
  updated_at: string;
}

interface ProjectItem {
  item_id: string;                   // FK → inventory
  item_name: string;                 // Snapshot
  qty: number;
  rate: number;                      // Per day
  days: number;
  total: number;                     // qty × rate × days
  gst_rate: number;                  // % (0, 5, 12, 18, 28)
  gst_amount: number;                // total × gst_rate/100
}

interface LogisticsCosts {
  travel: { amount: number; gst: number };       // gst is %
  accommodation: { amount: number; gst: number };
  food: { amount: number; gst: number };
  labour: { amount: number; gst: number };
  transport: { amount: number; gst: number };
}

interface ConfirmationDetails {
  confirmation_date: string;
  confirmation_mode: 'Email' | 'Phone' | 'In-person';
  confirmed_by_client: string;
  confirmed_by_internal: string;
  po_reference: string;
  advance_committed: number;
  follow_up_required: boolean;
  follow_up_date?: string;
  confirmation_notes: string;
}

interface VendorAllocation {
  vendor_id: string;                 // FK → clients (vendor type)
  vendor_name: string;               // Snapshot
  items: AllocatedVendorItem[];
  total_cost: number;
  gst_rate: number;
  gst_amount: number;
}

interface ReimbursableExpense {
  id: string;
  description: string;
  amount: number;
  date: string;
  category: string;
  proof_url?: string;
  created_at: string;
}

interface ProjectRemark {
  id: string;
  text: string;
  by: string;                       // Employee name
  at: string;                       // ISO timestamp
}
```

#### `inventory`
```typescript
interface InventoryItem {
  id: string;
  name: string;
  brand: string;
  category: EquipmentCategory;
  sub_category?: string;
  status: 'Available' | 'Rented' | 'InRepair' | 'Lost/Stolen' | 'Retired';
  total: number;                     // Total quantity owned

  // Pricing
  rate_per_day: number;
  rate_per_week?: number;
  purchase_cost?: number;
  replacement_value?: number;

  // GST
  hsn_code: string;
  gst_rate: number;                  // Default GST %

  // Serial numbers
  serial_numbers: string[];          // Simple list
  serial_details: SerialDetail[];    // Extended info per serial

  // Composite kit
  is_composite: boolean;
  composition: KitComponent[];       // Only if is_composite = true

  // Vendor supplied
  is_external: boolean;
  vendor_id?: string;                // FK → clients (vendor)

  // Supplier matrix
  suppliers: SupplierQuote[];

  // LED Wall specific
  tile_model?: LEDTileModel;

  // Technical specs
  attributes: Record<string, string>; // Flexible KV specs
  weight_kg?: number;
  dimensions?: string;
  power_watts?: number;
  current_amps?: number;
  connector_type?: string;
  ip_rating?: string;

  // Maintenance
  last_service_date?: string;
  next_test_due?: string;
  service_notes?: string;

  // Tracking
  location?: string;                 // Warehouse/site location
  asset_id?: string;                 // Barcode/asset tag

  // Archive
  is_archived: boolean;

  created_at: string;
  updated_at: string;
}

type EquipmentCategory =
  | 'Sound' | 'Lighting' | 'Video' | 'Camera'
  | 'Trussing' | 'Rigging' | 'Projectors' | 'LED'
  | 'LED Wall' | 'Power' | 'Cables' | 'Accessories';

interface SerialDetail {
  serial: string;
  purchase_date?: string;
  invoice_no?: string;
  warranty_start?: string;
  warranty_end?: string;
}

interface KitComponent {
  item_id: string;                   // FK → inventory (cannot be self)
  qty: number;
}

interface SupplierQuote {
  vendor_id: string;                 // FK → clients
  brand: string;
  spec: string;
  rate: number;
}

interface LEDTileModel {
  modelName: string;
  dimensions: { height_mm: number; width_mm: number; depth_mm: number };
  pixelPitch: number;                // mm
  resolution: { pixelWidth: number; pixelHeight: number };
  power: { maxPowerWatts: number; avgPowerWatts: number };
  weight: number;                    // kg
  inventory: { totalTiles: number; tilesPerCase: number };
}
```

#### `employees`
```typescript
interface Employee {
  id: string;
  name: string;
  email: string;                     // Unique, matches Firebase Auth
  phone: string;
  role: Role;
  is_locked: boolean;
  fail_count: number;
  location?: 'HQ' | 'Site' | 'Remote';
  created_at: string;
  updated_at: string;
}
```

#### `expenses`
```typescript
interface Expense {
  id: string;
  employee_id: string;               // FK → employees
  project_id: string;                // FK → projects (or 'general')
  category: ExpenseCategory;
  amount: number;
  date: string;
  description: string;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Disapproved';
  approved_by?: string;              // FK → employees
  proof_url?: string;                // Firebase Storage URL
  remarks?: string;
  created_at: string;
}

type ExpenseCategory =
  | 'Travel' | 'Food' | 'Lodging' | 'Fuel'
  | 'Local Transport' | 'Consumables' | 'Misc' | 'Labour';
```

#### `payments` (Client Receivables)
```typescript
interface Payment {
  id: string;
  client_id: string;                 // FK → clients
  party_company_id: string;          // 'primary' or branch.id
  party_company_name: string;        // Snapshot
  project_id: string;                // FK → projects (or 'general')
  amount: number;
  date: string;
  mode: 'Bank Transfer' | 'Cash' | 'Cheque' | 'UPI/Online';
  reference: string;                 // Transaction/cheque reference
  remarks?: string;
  created_at: string;
}
```

#### `payouts` (Employee Disbursements)
```typescript
interface Payout {
  id: string;
  employee_id: string;
  amount: number;
  date: string;
  mode: string;
  reference: string;
  project_id?: string;
  type: 'Salary' | 'Advance' | 'Reimbursement' | 'Bonus';
  remarks?: string;
  created_at: string;
}
```

#### `vendor_payments`
```typescript
interface VendorPayment {
  id: string;
  vendor_id: string;                 // FK → clients (vendor)
  party_company_id: string;          // Vendor branch
  party_company_name: string;
  amount: number;
  date: string;
  mode: string;
  reference: string;
  project_id?: string;
  remarks?: string;
  created_at: string;
}
```

#### `tax_invoices` (Sales)
```typescript
interface TaxInvoice {
  id: string;
  invoice_no: string;               // Auto-generated: {prefix}{FY}/{counter}
  invoice_date: string;
  due_date: string;                  // invoice_date + billing_terms days
  client_id: string;
  sale_company_id: string;           // 'primary' or branch.id
  sale_company_name: string;         // Snapshot
  sale_company_gstin: string;        // Snapshot
  sale_company_address: string;      // Snapshot
  project_ids: string[];             // Multi-project bundling
  invoice_type: 'Invoice' | 'Clubbed Invoice' | 'Clubbed & Settled Invoice' | 'Settled Invoice';

  // Aggregated line items (from all linked projects)
  items: InvoiceLineItem[];

  // Totals
  taxable_amount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total_gst: number;
  grand_total: number;
  final_amount: number;              // After adjustment (override)
  adjustment_remarks?: string;

  // Organization snapshot
  org_name: string;
  org_gstin: string;
  org_pan: string;
  org_address: string;
  org_bank_details: BankDetails;

  remarks?: string;
  terms_conditions?: string;
  created_at: string;
}

interface InvoiceLineItem {
  description: string;
  hsn_sac: string;
  qty: number;
  rate: number;
  days: number;
  taxable_value: number;
  gst_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
}
```

#### `purchase_invoices` (POs)
```typescript
interface PurchaseInvoice {
  id: string;
  po_no: string;                     // Auto-generated
  vendor_id: string;
  vendor_company_id: string;         // Vendor branch
  vendor_company_name: string;
  vendor_company_gstin: string;
  vendor_company_address: string;
  project_id: string;
  status: 'Draft' | 'Sent' | 'Approved' | 'Partial' | 'Paid' | 'Closed' | 'Cancelled';

  // Pricing mode
  is_package_cost: boolean;
  package_cost: number;
  package_cost_gst: number;

  // Itemized
  items: POLineItem[];
  labour_cost: number;
  transport_cost: number;
  fnb_cost: number;
  misc_cost: number;

  // GST
  gst_rate: number;
  base_amount: number;
  gst_amount: number;
  total_amount: number;

  // Vendor invoice (when vendor submits actual bill)
  vendor_invoice?: {
    invoice_no: string;
    invoice_date: string;
    status: 'Pending' | 'Accepted' | 'Verified';
    base_amount: number;
    gst_amount: number;
    total_amount: number;
  };

  remarks?: string;
  created_at: string;
}
```

#### `challans`
```typescript
interface Challan {
  id: string;
  challan_no: string;               // {FY}/{counter} e.g., 2024-25/0001
  type: 'Delivery' | 'Return';
  project_id: string;
  project_name: string;              // Snapshot
  client_id: string;
  client_name: string;               // Snapshot
  date: string;
  items: ChallanItem[];

  // Transport details
  transport: {
    mode: 'Road' | 'Rail' | 'Air' | 'Sea';
    vehicle_no: string;
    driver_name: string;
    driver_phone: string;
    eway_bill_no?: string;
  };

  // GST compliance
  place_of_supply: string;
  place_of_dispatch: string;

  created_at: string;
  created_by: string;
}

interface ChallanItem {
  item_id: string;
  item_name: string;
  qty: number;
  serial_numbers?: string[];         // Tracked serials
  hsn_code: string;
  rate: number;
  gst_rate: number;
}
```

#### `timeLogs` (Attendance)
```typescript
interface TimeLog {
  id: string;
  employeeId: string;
  checkIn: string;                   // ISO timestamp
  checkOut?: string;                 // ISO timestamp
  location: 'HQ' | 'Site' | 'Remote';
  project_id?: string;              // If on-site for project
  geofenceVerified: boolean;
  checkInCoords?: { lat: number; lng: number };
  checkOutCoords?: { lat: number; lng: number };
  penaltyMinutes?: number;
  lateCheckoutReason?: string;
  flagged: boolean;
  created_at: string;
}
```

#### `settings/organization`
```typescript
interface OrgSettings {
  name: string;
  logo_url: string;                  // Firebase Storage
  gstin: string;
  pan: string;
  phone: string;
  email: string;
  address: string;
  state: string;

  // Bank accounts
  bank_accounts: BankAccount[];
  default_bank_account: number;      // Index into bank_accounts

  // Numbering
  invoice_prefix: string;            // e.g., 'INV-{FY}/'
  po_prefix: string;                 // e.g., 'PO-{FY}/'
  challan_prefix?: string;

  // HR config
  hr_settings: {
    hq_lat: number;
    hq_lng: number;
    geofence_radius_meters: number;
    checkin_window_start: string;     // 'HH:MM'
    checkin_window_end: string;
    max_shift_hours: number;
    grace_minutes: number;
    geo_penalty_minutes: number;
    suspicious_checkout_hour: number;
    holiday_calendar: Holiday[];
    leave_entitlements: Record<string, number>;
  };

  // Expense config
  expense_proof_threshold: number;   // ₹ amount above which proof required
  max_upload_size_mb: number;

  // Calendar colors
  status_colors: Record<string, string>;
  invoice_text_colors: Record<string, string>;
}

interface BankAccount {
  bank_name: string;
  account_number: string;
  ifsc_code: string;
  branch: string;
  account_type: 'Current' | 'Savings';
}
```

#### `counters`
```typescript
// Document ID = FY string (e.g., '2024-25')
interface Counter {
  challan: number;        // Next challan number
  invoice: number;        // Next invoice number
  po: number;             // Next PO number
  jv: number;             // Next journal voucher number
}
```

#### `acLogs` (Audit Trail)
```typescript
interface AuditLog {
  id: string;
  timestamp: string;                 // ISO
  performed_by: string;              // Employee ID
  performed_by_name: string;         // Employee name snapshot
  action: 'create' | 'update' | 'delete' | 'status_change' | 'comment' | 'login' | 'logout';
  collection: string;                // Which Firestore collection
  doc_id: string;                    // Which document
  doc_name: string;                  // Human-readable name
  details: string;                   // Free-text description of change
}
```

#### `manual_journal_entries`
```typescript
interface ManualJournalEntry {
  id: string;
  voucher_no: string;               // JV-{0000}-{FY}
  date: string;
  description: string;
  entries: JournalLine[];
  created_at: string;
  created_by: string;
}

interface JournalLine {
  account_code: string;              // Chart of accounts code
  account_name: string;
  debit: number;
  credit: number;
  narration?: string;
}
```

#### `opening_balances`
```typescript
interface OpeningBalance {
  id: string;
  fy: string;                       // e.g., '2024-25'
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  created_at: string;
}
```

#### `fiscal_year_closings`
```typescript
interface FYClosing {
  id: string;
  fy: string;
  closed_at: string;
  closed_by: string;
  is_locked: boolean;
  transfer_entries: JournalLine[];   // Opening entries for next FY
}
```

---

## 6. MODULE SPECIFICATIONS

### 6.1 Dashboard

**Route:** `/`
**Access:** All roles (content varies by role)

**Features:**
- **KPI Cards:** Active events count, pending quotes, overdue returns, gross revenue (current FY)
- **Monthly Revenue Chart:** Last 6 months bar chart — Revenue, GST Collected, Expenses, Outsourcing
- **Project Calendar:** Horizontal timeline visualization with color-coded project bars (status-based colors)
- **Today's Operations Brief:**
  - Projects with setup today
  - Projects starting today
  - Projects ending today
  - Missing delivery challans (projects ongoing without challan)
- **Attendance Check-in/Check-out:** GPS-validated shift start/end widget
- **Employee Lock Alerts:** (admin/manager) Banner for locked accounts
- **Global Search Component:** Search across projects, clients, inventory by name/ID

### 6.2 Projects

**Route:** `/projects`
**Access:** All can view; create/edit restricted by role

**List View:**
- Filter by: status (multi-select), client, date range, invoice status, search text
- Quick filters: This week, next month, overdue (past end_date but not Completed/Closed)
- Sort by: date, name, client, status
- Pagination with configurable page size

**Detail Panel (Side/Inline):**
- All project fields displayed
- Inline date editing
- Status transition buttons (with role checks)
- Tabbed sections: Items, Logistics, Team, Outsourcing, Challans, Expenses, Remarks, Reimbursables

**Create/Edit Modal:**
- Client selector with branch search (displays parent + branches as flat list)
- A `party_company_*` snapshot is stored when client+branch selected
- Date pickers: start_date, end_date, setup_date (optional)
- Venue field
- **Pricing mode toggle:** Package Cost vs Itemized
  - Package Cost: single amount + GST% input
  - Itemized: allocate from inventory + logistics 5-line costs
- Save validates: client required, end ≥ start, at least one item or package cost > 0

**Equipment Allocation Modal:**
- Search inventory by name/category
- Show available qty (total - allocated in overlapping date projects)
- Enter qty, rate (override default), days, GST rate
- Composite kits auto-expand to components in pick list
- Overbooking warning (allow override with confirmation)

**Order Confirmation Modal:**
- Triggered on status change: Quoted → Confirmed
- Fields: confirmation_date, confirmation_mode, confirmed_by_client, confirmed_by_internal, po_reference, advance_committed, follow_up_required, follow_up_date, confirmation_notes

**Invoicing Modal:**
- Bulk apply invoice_no + invoice_date + invoice_status to selected projects
- Constrained to Completed/Closed projects only

**PDF Exports:**
1. **Quotation PDF:** Header (org logo, address), Bill To (client branch details), itemized table or package cost, terms & conditions, validity statement
2. **Quotation Excel:** Same data in spreadsheet format
3. **Job Sheet:** Internal doc with equipment list, vendor items, power/weight estimates, LED wall specs
4. **Pick List:** Warehouse prep list, composite kits expanded to components, grouped by category
5. **Final Report:** P&L summary — equipment revenue, logistics, outsourcing cost, direct expenses, profit margin

**Team Assignment:**
- Select employees from list
- Busy-status check: warn if employee assigned to overlapping project
- Remove assignment with confirmation

**Remarks Timeline:**
- Timestamped text notes per project
- Show author + datetime
- Add/delete remarks

### 6.3 Clients & Vendors

**Route:** `/clients`
**Access:** All can view; create/edit restricted

**Directory View:**
- Cards showing: name, type badge (Client/Vendor/Both), GSTIN, state, contact count
- Branch entries display as independent cards with "Branch of {parent}" badge
- Search across name, GSTIN, state
- Filter by type (Client/Vendor/Both)

**Create/Edit Modal:**
- Name, type (Client/Vendor/Both), GSTIN (validated), state (dropdown of 36 states), address
- Billing terms selector (Net 15/30/45/60/90)
- Contact manager: add/edit/remove contact persons (name, role, phone, email)

**Branch Manager:**
- Add/edit/remove companies/branches
- Each branch: name, GSTIN (unique validation including across all clients), state, address
- Branches appear as selectable entities across all modules

**Client Dashboard (on card click):**
- **Parent view (when parent card clicked):**
  - Lifetime revenue (sum of all project grand totals)
  - Pipeline revenue (Quoted + Confirmed projects)
  - Outstanding balance (sum of project totals for Invoiced projects - sum of payments)
  - Overdue invoices (past due per billing_terms)
  - **Branch-wise summary table:** Per-branch outstanding, non-invoiced projects, revenue, payments
  - Project pipeline by status
  - Category breakdown (top equipment categories rented)
  - Invoice register with GST details
  - Payment history
- **Branch view (when branch card clicked):**
  - Same metrics but filtered to only that branch's projects/payments/invoices

**Vendor Dashboard:**
  - Total jobs value, base amount, GST breakdown
  - Vendor payment summary
  - Per-project job details
  - PO register
  - Payment history

**Public Ledger Link:**
- Generate token-based URL for client to view their own ledger
- Optional expiry date
- Branch-scoped: append `?company=branchId` for branch-specific ledger

**Reimbursable Link:**
- Generate token for client to view reimbursable expenses per project

### 6.4 Inventory

**Route:** `/inventory`
**Access:** All can view; rates hidden from tech/user

**Master List:**
- Grid/list view toggle
- Search by: name, brand, asset ID, serial number
- Filter by: category (12 categories), status, vendor (external items), archived
- Sort by: name, category, qty, daily rate

**Create/Edit Modal:**
- Basic: name, brand, category, sub_category, total qty
- Pricing: rate_per_day, rate_per_week, purchase_cost, replacement_value
- GST: hsn_code, gst_rate dropdown
- Technical: weight, dimensions, power, current, connector, IP rating
- Attributes: flexible key-value pair editor
- Maintenance: last_service_date, next_test_due, service_notes
- Location & asset_id (barcode tag)

**Serial Number Manager:**
- CRUD per serial: serial string, purchase_date, invoice_no, warranty_start, warranty_end
- Auto-generate: prefix + counter + suffix format
- Barcode label printing: A4 landscape, 2 cols × 5 rows per page

**Composite Kit Builder:**
- Toggle is_composite → show composition editor
- Add component items (dropdown), qty per component
- Circular reference prevention (cannot add self or items that contain self)
- When kit allocated to project → expansion to base components in pick lists

**Supplier Matrix:**
- Multiple vendor quotes per item
- Fields: vendor (from vendor clients), brand, spec, rate
- Comparison view

**LED Wall Calculator:**
- Input: tile model (pixel pitch, dimensions, resolution, power, weight)
- Configure wall: tiles wide × tiles tall
- Auto-calculate:
  - Total resolution (pixels)
  - Physical dimensions (mm → m)
  - Total weight (kg)
  - Cases needed (tiles ÷ tiles_per_case)
  - Max/avg power consumption (watts → amps at 230V)
  - CAT6 signal ports (1 port per 650,000 pixels, with backup ×2)

**Availability Calendar:**
- Visual calendar showing which items are booked on which dates
- Color-coded by project
- Click-through to project detail

**Archive:**
- Soft-delete: mark is_archived = true
- Archived items hidden from allocation but history preserved
- Unarchive capability

### 6.5 Finance

**Route:** `/finance`
**Access:** admin, accountant only (full); tech/user hidden

**3-Tab Layout:**

**Tab 1: Receive Payment (Client → Company)**
- Entity selector: flat list of clients + branches (composite key)
- When branch selected → filter projects to that branch's projects only
- Date, amount, mode (Bank Transfer/Cash/Cheque/UPI), reference
- Link to project (or "General Account")
- FY-grouped display with collapse/expand
- **FY Locking:** Locked FYs disable add/edit/delete

**Tab 2: Employee Payout (Company → Employee)**
- Employee selector
- Type: Salary, Advance, Reimbursement, Bonus
- Balance display: current employee balance (advances + payouts - expenses)
- Date, amount, mode, reference

**Tab 3: Pay Vendor (Company → Vendor)**
- Vendor entity selector: flat list of vendors + branches
- When branch selected → filter projects to that branch's projects only
- Link to project or general
- Balance display: outstanding = Σ PO costs - Σ vendor payments

**Common Features:**
- Search by name/reference
- CSV export of filtered transactions
- Pagination (20/page)
- Edit/delete with role check + FY lock check

### 6.6 Tax Invoices (Sales)

**Route:** `/tax-invoices`
**Access:** admin, accountant, manager

**List View:**
- Columns: Invoice No, Date, Client, Company/Branch, Projects, Taxable, GST, Total, Status
- Filters: client search, FY filter, text search (invoice no, remarks)
- Sort by date, amount

**Create/Edit Modal:**
- Client entity selector (includes branches) with search filter
- Multi-project selector: link multiple projects to single invoice (filtered by selected client+branch)
- Invoice type: Invoice / Clubbed Invoice / Clubbed & Settled Invoice / Settled Invoice
- Auto-numbering: `{prefix}{FY}/{counter}` using Firestore counter transaction
- Invoice date (due_date auto-calculated from client billing_terms)
- Aggregated line items from all linked projects
- Final amount override field (for adjustments like discounts/penalties)
- Adjustment remarks
- Custom remarks field
- Terms & conditions (from org settings default)

**GST Logic:**
- Compare org GSTIN state code (first 2 chars) vs client GSTIN state code
- Same state → CGST (GST%/2) + SGST (GST%/2)
- Different state → IGST (full GST%)
- Each line item maintains its own GST rate

**PDF Generation:**
- Professional layout with org logo + letterhead
- Bill To: client branch name, GSTIN, address (from snapshot)
- Invoice number, date, due date
- Line items table: Description, HSN/SAC, Qty, Rate, Days, Taxable, CGST, SGST, IGST
- Subtotals: Taxable Amount, CGST Total, SGST Total, IGST Total, Grand Total
- Amount in words (Indian Rupee conversion)
- Bank details (from org settings)
- Remarks + Terms & Conditions
- "Computer Generated Invoice" footer
- Multi-page: compact header on subsequent pages

**Bulk Project Linking:**
- Select multiple projects → link to existing invoice
- Batched Firestore update on all linked projects

### 6.7 Purchase Invoices / POs

**Route:** `/purchase-invoices`
**Access:** admin, accountant, manager

**List View:**
- Columns: PO No, Date, Vendor, Company/Branch, Project, Base, GST, Total, Status
- Filters: vendor, project, status, FY
- Sort by date

**Create/Edit Modal:**
- Vendor entity selector (includes branches) with search
- Project selector (filtered by selected vendor+branch allocations)
- Status: Draft → Sent → Approved → Partial → Paid → Closed / Cancelled
- **Pricing mode:** Package cost OR itemized
  - Package cost: flat + GST%
  - Itemized: equipment items, labour, transport, F&B, misc costs
- GST rate + auto-calculate base, GST amount, total
- Vendor invoice capture: invoice_no, date, status (Pending/Accepted/Verified), actuals

**Cost Waterfall (for P&L):**
1. If vendor invoice with status Accepted/Verified → use invoice actuals
2. Else if PO committed cost → use PO amounts
3. Else → use allocation estimate from project

### 6.8 Challans

**Route:** `/challans`
**Access:** admin, manager, tech (create/edit); others view

**List View:**
- All challans across projects
- Filter by type (Delivery/Return), project, date range
- Search by challan number

**Create Modal:**
- Select project → auto-populate allocated items
- Type: Delivery or Return
- **Delivery:** Enter qty to send + serial numbers (if tracked)
- **Return:** Show delivered qty, enter return qty (≤ delivered - already returned)
- Transport details: mode, vehicle_no, driver_name, driver_phone
- E-Way Bill number (optional)
- Date picker

**Auto-Numbering:**
- Firestore transaction: read counter for current FY, increment, write back
- Format: `{FY}/{padded_counter}` (e.g., `2024-25/0001`)

**PDF Export:**
- Challan document with:
  - Organization header
  - Challan number + type + date
  - From/To addresses
  - Item table: Name, HSN, Qty, Serials, Rate, GST
  - Transport details
  - Place of supply / dispatch
  - Multi-page support

**E-Way Bill Export:**
- JSON format for GST portal compliance
- Contains supply type, document details, item details, transport details

### 6.9 Employees

**Route:** `/employees`
**Access:** admin (full CRUD + role management); others view

**Features:**
- Employee list with role badges
- Create/edit modal: name, email (unique), phone, role assignment
- Role change: admin-only action
- Lock/unlock: view failed login count, manual unlock
- Balance display: advances, payouts, expenses, current balance
- Assigned projects list

### 6.10 Expenses

**Route:** `/expenses`
**Access:** All can view own; admin/accountant/manager view all + approve

**Features:**
- **Quick Create:** employee (auto or select), project, category (8 types), amount, date, description
- **Proof Upload:** File upload to Firebase Storage (PDF/image)
  - Required if amount > org expense_proof_threshold
  - Max file size from org settings
- **Status Workflow:** Pending → Approved / Rejected / Disapproved
  - Manager/admin can bulk approve/reject
  - Rejection requires remarks
- **Filters:** By employee, project, category, status, date range
- **Aggregation:** Per-employee totals, per-project totals, per-category breakdown

### 6.11 Outsourcing

**Route:** `/outsourcing`
**Access:** admin, accountant, manager (amounts visible); tech view without amounts

**Features:**
- Overview of all vendor allocations across projects
- Group by vendor or by project
- Cost comparison: estimated vs PO committed vs invoice actual
- Margin analysis: revenue vs outsourcing cost per project
- Link to PO / vendor payment creation

### 6.12 Audit Logs

**Route:** `/audit-logs`
**Access:** admin, accountant only

**Features:**
- Chronological list of all `logAction()` entries
- Filters: category (Projects/Clients/Inventory/Finance/etc.), user, date range, action type
- Immutable records (no edit/delete)
- Each entry: timestamp, who, what action, which collection, document name, details

### 6.13 Admin Tools

**Route:** `/admin-tools`
**Access:** admin only

**Features:**
- **Organization Settings:**
  - Name, logo upload, GSTIN, PAN, phone, email, address, state
  - Bank accounts: add/edit/remove, set default for invoices
  - Invoice prefix (supports `{FY}` token), PO prefix, challan prefix
  - Expense proof threshold + max upload size
  - Calendar status colors (per status)
  - Invoice text colors
- **Financial Year Management:**
  - List all FYs with locked/unlocked status
  - Lock FY (prevents Finance CRUD for that FY)
  - Unlock FY (admin-only emergency action)
  - FY Closure: generate transfer entries for next FY opening balances
- **Data Export/Backup:** (optional) export all collections as JSON

### 6.14 RBAC Manager

**Route:** `/rbac-manager`
**Access:** admin only

**Features:**
- Visual grid: rows = resources (22 entries), columns = roles (5)
- Each cell: toggle actions (e.g., view ✅, create ❌, edit ✅)
- Save updates to Firestore (`settings/rbac_config`)
- Reset to defaults button
- Preview mode: "as this role, these sections are visible"

### 6.15 Profile Settings

**Route:** `/profile`
**Access:** All (own profile)

**Features:**
- View/edit: name, phone (email read-only)
- Password change via Firebase Auth
- View assigned projects
- View own attendance summary

### 6.16 Documents Hub

**Route:** `/documents`
**Access:** All can view; admin/manager can upload

**Features:**
- Document library for templates, policies, certificates
- Upload to Firebase Storage with metadata (title, category, uploaded_by)
- Filter by category
- Download link

### 6.17 Reports

**Route:** `/reports` + `/business-report`
**Access:** admin, accountant, manager

**Business Report:**
- P&L by project: revenue, outsourcing cost, expenses, profit, margin%
- Top clients by revenue
- Top equipment categories by rental frequency
- Monthly comparison (revenue + expenses trend)
- PDF + Excel export

**General Reports Dashboard:**
- Project status summary: count + total value per status
- Financial overview: receivables, payables, expenses
- Export capability

---

## 7. BUSINESS LOGIC & CALCULATIONS

### 7.1 Revenue Calculation

```typescript
function getProjectGrandTotal(project: Project): number {
  if (project.is_package_cost && project.package_cost > 0) {
    return project.package_cost * (1 + (project.package_cost_gst || 0) / 100);
  }

  // Equipment
  const equipmentBase = project.items.reduce((sum, item) =>
    sum + (item.qty * item.rate * item.days), 0);
  const equipmentGST = project.items.reduce((sum, item) =>
    sum + (item.qty * item.rate * item.days * (item.gst_rate || 0) / 100), 0);

  // Logistics
  const logisticsKeys = ['travel', 'accommodation', 'food', 'labour', 'transport'];
  const logisticsBase = logisticsKeys.reduce((sum, key) =>
    sum + (project.logistics_costs?.[key]?.amount || 0), 0);
  const logisticsGST = logisticsKeys.reduce((sum, key) => {
    const cost = project.logistics_costs?.[key];
    return sum + ((cost?.amount || 0) * (cost?.gst || 0) / 100);
  }, 0);

  return equipmentBase + equipmentGST + logisticsBase + logisticsGST;
}
```

### 7.2 Available Quantity

```typescript
function getAvailableQty(
  item: InventoryItem,
  startDate: string,
  endDate: string,
  excludeProjectId: string,
  projects: Project[]
): number {
  const overlapping = projects.filter(p =>
    p.id !== excludeProjectId &&
    ['Confirmed', 'Ongoing'].includes(p.status) &&
    isDateOverlap(p.start_date, p.end_date, startDate, endDate)
  );

  const allocated = overlapping.reduce((sum, p) => {
    const pItem = p.items.find(i => i.item_id === item.id);
    return sum + (pItem?.qty || 0);
  }, 0);

  return item.total - allocated;
}

function isDateOverlap(start1: string, end1: string, start2: string, end2: string): boolean {
  return new Date(start1) <= new Date(end2) && new Date(end1) >= new Date(start2);
}
```

### 7.3 GST State Logic

```typescript
function getGSTType(orgGstin: string, clientGstin: string): 'CGST_SGST' | 'IGST' {
  if (!orgGstin || !clientGstin) return 'IGST';
  return orgGstin.substring(0, 2) === clientGstin.substring(0, 2) ? 'CGST_SGST' : 'IGST';
}
```

### 7.4 Financial Year

```typescript
function getFY(dateStr: string): string {
  const d = new Date(dateStr);
  const month = d.getMonth(); // 0-indexed
  const year = d.getFullYear();

  if (month >= 3) { // Apr-Dec
    return `${year}-${(year + 1) % 100}`;
  } else { // Jan-Mar
    return `${year - 1}-${year % 100}`;
  }
}
```

### 7.5 Currency Formatting

```typescript
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}
// Output: ₹12,34,567.89
```

### 7.6 Employee Balance

```typescript
function getEmployeeBalance(
  employeeId: string,
  payouts: Payout[],
  expenses: Expense[]
): number {
  const totalPayouts = payouts
    .filter(p => p.employee_id === employeeId)
    .reduce((sum, p) => sum + p.amount, 0);

  const approvedExpenses = expenses
    .filter(e => e.employee_id === employeeId && e.status === 'Approved')
    .reduce((sum, e) => sum + e.amount, 0);

  return totalPayouts - approvedExpenses;
  // Positive = employee has advance (owes company)
  // Negative = company owes employee
}
```

### 7.7 Vendor Balance

```typescript
function getVendorBalance(
  vendorId: string,
  purchaseInvoices: PurchaseInvoice[],
  vendorPayments: VendorPayment[]
): number {
  const totalPOCost = purchaseInvoices
    .filter(pi => pi.vendor_id === vendorId && !['Cancelled', 'Draft'].includes(pi.status))
    .reduce((sum, pi) => sum + getEffectivePOCost(pi), 0);

  const totalPaid = vendorPayments
    .filter(vp => vp.vendor_id === vendorId)
    .reduce((sum, vp) => sum + vp.amount, 0);

  return totalPOCost - totalPaid;
  // Positive = we owe vendor
  // Negative = vendor credit
}

function getEffectivePOCost(po: PurchaseInvoice): number {
  // Priority: invoice actuals > PO committed > allocation estimate
  if (po.vendor_invoice &&
      ['Accepted', 'Verified'].includes(po.vendor_invoice.status)) {
    return po.vendor_invoice.total_amount;
  }
  return po.total_amount;
}
```

### 7.8 Days Calculation

```typescript
function getDaysDiff(startDate: string, endDate: string): number {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.ceil(ms / 86400000) + 1; // Inclusive counting
}
```

### 7.9 GSTIN Validation

```typescript
function isValidGSTIN(gstin: string): boolean {
  if (!gstin || gstin.length !== 15) return false;
  const pattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  return pattern.test(gstin);
}
```

### 7.10 LED Wall Calculations

```typescript
function calculateWallSpecs(
  model: LEDTileModel,
  tilesWide: number,
  tilesTall: number
) {
  const totalTiles = tilesWide * tilesTall;
  const totalPixelWidth = tilesWide * model.resolution.pixelWidth;
  const totalPixelHeight = tilesTall * model.resolution.pixelHeight;
  const totalPixels = totalPixelWidth * totalPixelHeight;
  const physicalWidth_mm = tilesWide * model.dimensions.width_mm;
  const physicalHeight_mm = tilesTall * model.dimensions.height_mm;
  const totalWeight_kg = totalTiles * model.weight;
  const casesNeeded = Math.ceil(totalTiles / model.inventory.tilesPerCase);
  const maxPower = totalTiles * model.power.maxPowerWatts;
  const avgPower = totalTiles * model.power.avgPowerWatts;

  // CAT6 signal ports: 1 port per 650,000 pixels
  const PIXELS_PER_PORT = 650000;
  const primaryPorts = Math.ceil(totalPixels / PIXELS_PER_PORT);
  const withBackup = primaryPorts * 2;

  return {
    totalTiles,
    resolution: `${totalPixelWidth} × ${totalPixelHeight}`,
    totalPixels,
    physicalSize: `${(physicalWidth_mm / 1000).toFixed(2)}m × ${(physicalHeight_mm / 1000).toFixed(2)}m`,
    weight: totalWeight_kg,
    cases: casesNeeded,
    power: { max: maxPower, avg: avgPower, ampsAt230V: Math.ceil(maxPower / 230) },
    signalPorts: { primary: primaryPorts, withBackup }
  };
}
```

### 7.10 Profit & Loss

```typescript
function calculateProjectPnL(
  project: Project,
  purchaseInvoices: PurchaseInvoice[],
  expenses: Expense[]
) {
  // Revenue (base, excluding GST for P&L)
  let revenue: number;
  if (project.is_package_cost) {
    revenue = project.package_cost;
  } else {
    const equipmentBase = project.items.reduce((s, i) => s + i.qty * i.rate * i.days, 0);
    const logisticsBase = ['travel', 'accommodation', 'food', 'labour', 'transport']
      .reduce((s, k) => s + (project.logistics_costs?.[k]?.amount || 0), 0);
    revenue = equipmentBase + logisticsBase;
  }

  // Outsourcing cost (base, excluding GST)
  const outsourcingCost = purchaseInvoices
    .filter(pi => pi.project_id === project.id && pi.status !== 'Cancelled')
    .reduce((s, pi) => {
      const effective = getEffectivePOCost(pi);
      // Extract base from total: base = total / (1 + gst_rate/100)
      return s + (effective / (1 + (pi.gst_rate || 0) / 100));
    }, 0);

  // Direct expenses
  const directExpenses = expenses
    .filter(e => e.project_id === project.id && e.status === 'Approved')
    .reduce((s, e) => s + e.amount, 0);

  const profit = revenue - outsourcingCost - directExpenses;
  const margin = revenue > 0 ? (profit / revenue * 100) : 0;

  return { revenue, outsourcingCost, directExpenses, profit, margin };
}
```

---

## 8. PDF GENERATION

### 8.1 Common Layout Elements

```
+----------------------------------------------------------+
| [ORG LOGO]  Organization Name                            |
|             Address Line 1, City, State - PIN            |
|             GSTIN: 27XXXXX1234X1ZX  |  PAN: XXXXX1234X  |
|             Phone: +91-XXXXXXXXXX                        |
+----------------------------------------------------------+
|                    DOCUMENT TITLE                         |
+----------------------------------------------------------+
| Document No: INV-2024-25/0042      Date: 15-Apr-2024    |
| Bill To:                           Ship To:              |
| Client Name (Branch)               Venue Address         |
| GSTIN: 36XXXXX5678Y2ZY                                  |
+----------------------------------------------------------+
| # | Description | HSN | Qty | Rate | Days | Taxable    |
|---|-------------|-----|-----|------|------|------------|
| 1 | LED Panel   | 9405| 20  | 500  | 3    | 30,000    |
|...|             |     |     |      |      |            |
+----------------------------------------------------------+
| Taxable Amount:                          ₹ 2,50,000     |
| CGST @ 9%:                              ₹   22,500     |
| SGST @ 9%:                              ₹   22,500     |
| Grand Total:                             ₹ 2,95,000     |
+----------------------------------------------------------+
| Amount in Words: Two Lakh Ninety Five Thousand Only      |
+----------------------------------------------------------+
| Bank Details:                                            |
| Bank: HDFC Bank | A/C: 50200XXXXX | IFSC: HDFC0001XXX  |
+----------------------------------------------------------+
| Remarks: Payment due within 30 days                      |
| Terms & Conditions:                                      |
| 1. Equipment to be returned in working condition         |
| 2. Damage charges apply at replacement value             |
+----------------------------------------------------------+
| This is a computer generated document                    |
+----------------------------------------------------------+
```

### 8.2 PDF Documents Required

| Document | Trigger | Key Content |
|----------|---------|-------------|
| **Tax Invoice** | Create from Tax Invoices module | Full GST-compliant invoice with line items from linked projects |
| **Quotation** | Export from project (Quoted status) | Itemized or package cost, optional LED wall specs |
| **Job Sheet** | Export from project (internal) | Equipment + vendor items, power/weight estimates |
| **Pick List** | Export from project (warehouse prep) | Items by category, kits expanded to components |
| **Delivery Challan** | Create from challan module | Transport doc: items, serials, vehicle details |
| **Return Challan** | Create from challan module | Return doc: items returned, qty validation |
| **Final Report** | Export from project (Completed+) | P&L: revenue, outsourcing, expenses, profit |
| **Business Report** | Export from reports module | Multi-project P&L summary |
| **Barcode Labels** | Generate from inventory | A4 landscape, 2 cols × 5 rows, serial + name + asset ID |

---

## 9. PUBLIC PAGES & EXTERNAL ACCESS

### 9.1 Public Ledger (`/ledger/:token`)

- **No authentication required**
- Token stored on client record (`ledger_link_token`)
- Displays: project list with grand totals, payments received, outstanding balance
- **Branch scoping:** If URL has `?company=branchId`, show only that branch's data
- Expiry: check `ledger_link_expiry`; show "Link expired" if past date
- Read-only; no write operations
- Responsive design (mobile-friendly)

### 9.2 Public Employee Ledger (`/employee-ledger/:token`)

- Token-based access for employees to view their own financial position
- Shows: payouts, approved expenses, advances, current balance
- Read-only

### 9.3 Public Reimbursable (`/reimbursable/:token`)

- Token-based access for clients to view reimbursable expenses
- Shows per-project breakdown of expenses marked as reimbursable
- Proof attachments viewable
- Read-only

### 9.4 Quote Approval (`/quote/:token`)

- Token-based access for client to review quotation
- Shows: project details, items/package cost, terms
- Actions: Approve / Request Revision
- 30-day expiry from generation date
- Approval status written back to project record

---

## 10. HR & WORKFORCE MODULE

### 10.1 Attendance System

**Check-in Flow:**
1. Employee clicks "Check In" on Dashboard
2. Browser requests GPS location (Geolocation API)
3. System validates:
   - Is current time within check-in window? (e.g., 08:00–11:00 for HQ)
   - Is location within geofence radius of HQ coordinates?
4. If out of geofence → apply penalty minutes (e.g., 40 min deducted)
5. If outside window → still allow but flag as late
6. Create `timeLog` record with check-in timestamp + coords

**Check-out Flow:**
1. Employee clicks "Check Out"
2. System checks:
   - Shift duration > max hours? → Flag as suspicious
   - Current time > suspicious hour (e.g., 22:00)? → Flag
   - If flagged → require reason text before allowing checkout
3. Record check-out timestamp + coords

**Auto-close:** After configurable hours, shifts auto-close with system flag

### 10.2 Leave Management

- **Leave Types:** Casual (12/yr), Sick (8/yr), Earned (15/yr)
- **Application:** Employee submits leave request with dates + type + reason
- **Approval:** Manager/admin approves or rejects
- **Balance Tracking:** Entitled days - used days = remaining
- **Calendar View:** Color-coded leave calendar

### 10.3 Payroll

- Salary structure per employee (not stored in current version — design as configuration)
- Monthly generation: base salary - deductions + reimbursements
- Integration with attendance (penalty calculation)
- Integration with expenses (approved reimbursements)
- Generate payslip PDF

### 10.4 HR Settings

- HQ coordinates (lat, lng) for geofencing
- Geofence radius (meters)
- Check-in window (start/end times)
- Max shift hours
- Grace minutes (for late arrival)
- Geo-penalty minutes
- Suspicious checkout hour
- Holiday calendar (dates + descriptions)
- Leave entitlement defaults per leave type

---

## 11. ACCOUNTING ENGINE

### 11.1 Chart of Accounts

| Code | Name | Type |
|------|------|------|
| 1000 | Cash In Hand | Asset |
| 1010 | Bank | Asset |
| 1100 | Accounts Receivable | Asset |
| 1200 | Employee Advances | Asset |
| 1300 | Input GST Credit | Asset |
| 2000 | Accounts Payable | Liability |
| 2100 | Output GST Payable | Liability |
| 3000 | Retained Earnings | Equity |
| 3010 | Opening Balance Equity | Equity |
| 4000 | Sales Revenue | Income |
| 5000 | Purchase Expense | Expense |
| 5100 | Salary Expense | Expense |
| 5200 | Expense: General | Expense |

Custom accounts can be added by admin.

### 11.2 Auto-Generated Journal Entries

| Trigger | Debit Account | Credit Account |
|---------|--------------|----------------|
| Tax Invoice (Credit) | 1100 Accounts Receivable | 4000 Sales Revenue + 2100 Output GST |
| Tax Invoice (Cash) | 1000 Cash / 1010 Bank | 4000 Sales Revenue + 2100 Output GST |
| Client Payment (Bank) | 1010 Bank | 1100 Accounts Receivable |
| Client Payment (Cash) | 1000 Cash | 1100 Accounts Receivable |
| Purchase Invoice (Credit) | 5000 Purchase + 1300 Input GST | 2000 Accounts Payable |
| Vendor Payment (Bank) | 2000 Accounts Payable | 1010 Bank |
| Expense (Approved) | 5200 Expense:General | 1010 Bank |
| Employee Payout (Bank) | 5100 Salary Expense | 1010 Bank |
| Employee Advance | 1200 Employee Advances | 1010 Bank |
| Opening Balance | Configured Account | 3010 Opening Balance Equity |
| FY Closing | Transfer entries | 3000 Retained Earnings |

### 11.3 Financial Reports

**Trial Balance:**
- All accounts with debit/credit totals
- Debit total must equal Credit total
- Difference flagged as error

**Profit & Loss:**
- Revenue: Sales (4000)
- COGS: Purchases (5000)
- Gross Profit = Revenue - COGS
- Operating Expenses: Salary (5100) + General (5200)
- Net Profit = Gross Profit - Operating Expenses

**Balance Sheet:**
- Assets: Cash (1000) + Bank (1010) + Receivables (1100) + Advances (1200) + Input GST (1300)
- Liabilities: Payables (2000) + Output GST (2100)
- Equity: Retained Earnings (3000) + Opening Balance Equity (3010) + Current Year Profit

### 11.4 Auto-Numbering

- **Invoice:** `{prefix}{FY}/{counter}` (e.g., `INV-2024-25/0042`)
- **PO:** `{prefix}{FY}/{counter}` (e.g., `PO-2024-25/0015`)
- **Challan:** `{FY}/{counter}` (e.g., `2024-25/0001`)
- **Journal Voucher:** `JV-{counter}-{FY}` (e.g., `JV-0003-2024-25`)

All use Firestore transactions to ensure atomic increment.

---

## 12. UI/UX REQUIREMENTS

### 12.1 Design System

- **Framework:** Tailwind CSS utility-first
- **Color Palette:**
  - Primary: Blue-600 (#2563EB)
  - Success/Income: Green-600
  - Danger/Expense: Red-600
  - Warning/Vendor: Orange-500
  - Info/Project: Blue-500
  - Status-specific colors defined in constants
- **Typography:** System font stack (Inter preferred)
- **Layout:** Fixed sidebar (collapsible) + scrollable main content area
- **Responsive:** Desktop-first, mobile-adaptive for public pages and employee portal
- **Dark Mode:** Support via Tailwind dark: variants

### 12.2 Interaction Patterns

- **Modal Dialogs:** For create/edit forms (overlay with backdrop dismiss)
- **Side Panels:** For detail views (slide-in from right)
- **Toast Notifications:** Success (green), Error (red), Warning (amber), Info (blue) — auto-dismiss after 4s
- **Confirmation Dialogs:** For delete actions and irreversible operations
- **Loading States:** Skeleton screens for initial load, spinner for actions
- **Empty States:** Helpful messages + CTA button when no data
- **Pagination:** Page-based (20 items default) with page size selector
- **Debounced Search:** 300ms debounce on search inputs
- **Inline Edit:** Double-click date fields in project detail for quick edit

### 12.3 Status Badge Colors (Tailwind)

```typescript
const STATUS_COLORS = {
  'Quoted':    { bg: 'bg-orange-100', text: 'text-orange-800' },
  'Confirmed': { bg: 'bg-green-100',  text: 'text-green-800' },
  'Cancelled': { bg: 'bg-gray-100',   text: 'text-gray-800' },
  'Ongoing':   { bg: 'bg-red-100',    text: 'text-red-800' },
  'Completed': { bg: 'bg-blue-100',   text: 'text-blue-800' },
  'Closed':    { bg: 'bg-[#003366]',  text: 'text-white' },
};
```

### 12.4 Navigation Structure

```
Sidebar:
├── Dashboard
├── Projects
├── Clients & Vendors
├── Inventory
├── Challans
├── Outsourcing
├── ── Finance ──
├── Payments
├── Tax Invoices
├── Purchase Invoices
├── Expenses
├── Accounting
├── ── Reports ──
├── Business Report
├── Reports
├── ── HR ──
├── HR Dashboard
├── Attendance
├── Leaves
├── Payroll
├── HR Reports
├── HR Portal
├── ── Admin ──
├── Employees
├── Audit Logs
├── Admin Tools
├── RBAC Manager
├── Documents
└── Profile
```

Each section visibility controlled by `getNavAccess(role)`.

---

## 13. DATA VALIDATION & CONSTRAINTS

### 13.1 Form-Level Validation

| Field | Rule | Error Message |
|-------|------|---------------|
| Client name | Required, min 2 chars | "Client name is required" |
| GSTIN | Optional; if provided, 15-char regex + unique across all clients & branches | "Invalid GSTIN format" / "GSTIN already exists" |
| Email | Valid format, unique per employee | "Invalid email" / "Email already registered" |
| Phone | Numeric, 10 digits | "Invalid phone number" |
| GST Rate | 0–100 | "GST rate must be between 0 and 100" |
| Project dates | end_date ≥ start_date | "End date cannot be before start date" |
| Allocation qty | ≤ available qty (warn, not block) | "Warning: Overbooking detected" |
| Return challan qty | ≤ delivered - already returned | "Return qty exceeds delivered" |
| Composite kit | Cannot reference self | "Circular reference not allowed" |
| Serial numbers | Unique within same item | "Duplicate serial number" |
| Expense proof | Required if amount > threshold | "Proof required for expenses above ₹{threshold}" |
| Invoice no | Required for invoicing | "Invoice number required" |

### 13.2 Business Rule Enforcement

| Rule | Enforcement Point |
|------|------------------|
| Status can only move forward (Quoted→Confirmed→Ongoing→Completed→Closed) | Status change handler |
| Only admin/accountant/manager can close projects | `can(role, 'projects', 'close')` |
| Only admin can delete clients | `can(role, 'clients', 'delete')` |
| FY-locked records cannot be edited/deleted | Finance CRUD handlers |
| Composite kit cannot contain itself | Kit composition editor |
| Employee cannot be assigned to overlapping projects (warning) | Team assignment handler |
| Invoice creation only for Completed/Closed projects | Invoice modal project selector |
| Rate fields hidden from tech/user roles | Conditional rendering |

---

## 14. SECURITY REQUIREMENTS

### 14.1 Authentication

- Firebase Auth email/password only (no social login)
- Session persistence: `browserLocalPersistence` for offline support
- Failed login tracking: increment counter on employee doc; lock at 5 failures
- Locked account: show alert on Dashboard; admin can unlock via Employees module

### 14.2 Authorization

- Every Firestore read/write protected by `can()` check in application layer
- Firestore Security Rules should mirror RBAC matrix (defense in depth)
- Public pages: read-only access via token validation, no write operations
- Token-based links: validate existence + expiry before showing data

### 14.3 Data Protection

- No sensitive data in client-side logs
- Proof uploads: validate file type (PDF/JPEG/PNG only) and size before upload
- GSTIN stored as-is (not PII per Indian law, but treat as business-sensitive)
- Password policy: minimum 8 chars (Firebase Auth default)

### 14.4 Audit Trail

- Every create/update/delete operation logged to `acLogs` collection
- Log entry includes: who, when, what action, which document, change description
- Logs are **immutable** — no edit/delete operations on acLogs
- Accessible only to admin + accountant roles

---

## 15. PERFORMANCE & SCALABILITY

### 15.1 Frontend

- **Code Splitting:** React.lazy + Suspense for all page-level routes
- **Memoization:** useMemo for expensive computations (entity flattening, filtering, aggregations)
- **Virtualization:** Use react-window for lists >100 items (inventory, audit logs)
- **Debounce:** 300ms on search inputs
- **Image Optimization:** Org logo compressed on upload; use webp where possible

### 15.2 Firestore

- **Composite Indexes:** Create for common queries:
  - `projects`: (client_id, status), (status, start_date), (invoice_status, client_id)
  - `payments`: (client_id, date), (party_company_id, date)
  - `expenses`: (employee_id, status), (project_id, status)
- **Listener Management:** Unsubscribe from snapshots on component unmount
- **Batch Writes:** Use batched writes for bulk operations (invoice linking, bulk approve)
- **Pagination:** Use `limit()` + `startAfter()` for cursor-based pagination
- **Offline Persistence:** Enable `enableIndexedDbPersistence()` for offline-first

### 15.3 Targets

- Initial page load: < 3s on 4G
- Route transition: < 500ms
- Search debounce: 300ms
- PDF generation: < 5s for complex invoices
- Firestore cold start: < 2s

---

## 16. TESTING STRATEGY

### 16.1 Unit Tests (Vitest)

**Priority functions to test:**
- `getProjectGrandTotal()` — all pricing modes, edge cases (0 items, 0 logistics)
- `getAvailableQty()` — overlapping, non-overlapping, excluded project
- `isDateOverlap()` — edge cases (same day, adjacent days, no overlap)
- `getGSTType()` — same state, different state, missing GSTIN
- `getFY()` — March (boundary), April (boundary), December
- `formatCurrency()` — large numbers, zero, negative
- `isValidGSTIN()` — valid format, invalid length, invalid pattern
- `calculateWallSpecs()` — known tile model with expected output
- `getEffectivePOCost()` — all 3 priority levels
- `getEmployeeBalance()` / `getVendorBalance()` — positive/negative/zero
- `buildAccountingSnapshot()` — complete journal + trial balance + P&L
- `can()` — all role×resource×action combinations

### 16.2 Integration Tests (React Testing Library)

- Project creation form → submit → verify Firestore write
- Equipment allocation → verify qty deducted
- Client creation with branch → verify flattening in selectors
- Invoice creation → verify linked projects updated
- Expense approval → verify employee balance updated
- Permission checks → verify UI elements hidden/shown per role

### 16.3 E2E Tests (Playwright)

- **Quote-to-Invoice workflow:** Create project → allocate items → confirm → generate challan → complete → create invoice
- **Vendor outsourcing:** Allocate vendor → create PO → capture invoice → pay vendor
- **Multi-branch:** Create client with branch → create project for branch → view branch dashboard → verify isolation
- **RBAC:** Login as each role → verify accessible/blocked routes
- **Public ledger:** Generate link → access without auth → verify data shown

---

## 17. BUILD ORDER & MILESTONES

### Phase 1: Foundation (Week 1-2)
- [ ] Project setup: Vite + React 19 + TypeScript + Tailwind
- [ ] Firebase configuration (Auth, Firestore, Storage)
- [ ] Type definitions (all interfaces in `/types/`)
- [ ] Utility functions (`helpers.ts`, `constants.ts`, `validators.ts`)
- [ ] Auth flow: login, role resolution, ProtectedRoute
- [ ] Layout: Sidebar + Header + main content area
- [ ] Shared components: Modal, Toast, LoadingSpinner, DataTable, SearchInput
- [ ] `useFirestoreCollection` hook (generic snapshot listener)
- [ ] `logAction()` utility

### Phase 2: Core Entities (Week 3-4)
- [ ] Clients & Vendors: CRUD + branch management + contacts
- [ ] Inventory: CRUD + serial numbers + composite kits + categories
- [ ] Employees: CRUD + role assignment + lock/unlock
- [ ] Basic navigation + RBAC (`can()` + `getNavAccess()`)

### Phase 3: Projects (Week 5-7)
- [ ] Project CRUD + status workflow
- [ ] Equipment allocation modal with availability check
- [ ] Logistics costs editor (5 types)
- [ ] Package cost mode toggle
- [ ] Team assignment with busy check
- [ ] Order confirmation modal
- [ ] Remarks timeline
- [ ] Quotation PDF + Excel export
- [ ] Job Sheet + Pick List PDF
- [ ] LED Wall calculator integration

### Phase 4: Finance & Invoicing (Week 8-10)
- [ ] Client payments (receive): CRUD with FY grouping + locking
- [ ] Employee payouts: CRUD with balance display
- [ ] Vendor payments: CRUD with outstanding calculation
- [ ] Tax Invoices: create with multi-project link, auto-numbering, GST logic, PDF generation
- [ ] Purchase Invoices / POs: CRUD with vendor invoice capture, cost waterfall
- [ ] Expenses: CRUD with proof upload, approval workflow

### Phase 5: Logistics (Week 11-12)
- [ ] Challan Manager: delivery + return challan creation
- [ ] Auto-numbering with Firestore transaction
- [ ] Serial number tracking in challans
- [ ] Challan PDF generation
- [ ] E-Way Bill JSON export
- [ ] Qty validation (return ≤ delivered)

### Phase 6: Accounting & Reports (Week 13-14)
- [ ] Chart of Accounts + custom accounts
- [ ] Auto-generated journal entries (from invoices, payments, expenses)
- [ ] Manual journal entries
- [ ] Trial Balance
- [ ] Profit & Loss statement
- [ ] Balance Sheet
- [ ] Opening balances + FY closure
- [ ] Business Report page
- [ ] Report PDF + Excel exports

### Phase 7: HR Module (Week 15-16)
- [ ] Attendance check-in/out with GPS + geofence
- [ ] Leave management: application + approval
- [ ] HR Dashboard with KPIs
- [ ] Shift tracking + penalties
- [ ] Payroll engine
- [ ] HR Settings (geofence, windows, holidays, entitlements)
- [ ] HR Reports

### Phase 8: Admin & Public Pages (Week 17-18)
- [ ] Admin Tools: org settings, bank accounts, numbering config
- [ ] RBAC Manager: visual permission grid
- [ ] Audit Logs: filterable history view
- [ ] Documents Hub
- [ ] Public Ledger (client + employee)
- [ ] Public Reimbursable
- [ ] Quote Approval page
- [ ] Profile Settings

### Phase 9: Polish & Testing (Week 19-20)
- [ ] Responsive design pass (all pages)
- [ ] Dark mode implementation
- [ ] Error boundary + offline indicator
- [ ] Performance optimization (code splitting, virtualization)
- [ ] Unit tests for all calculation functions
- [ ] Integration tests for critical workflows
- [ ] E2E test suite
- [ ] Security audit (Firestore rules, RBAC enforcement)
- [ ] Notification bell + global search
- [ ] Inventory availability calendar

---

## 18. ACCEPTANCE CRITERIA

### Functional

- [ ] All 5 roles can log in and see only their permitted sections
- [ ] Client CRUD with branches; branches appear as independent entities in all selectors
- [ ] Project lifecycle: Quoted → Confirmed → Ongoing → Completed → Closed
- [ ] Equipment allocation with real-time availability checking
- [ ] Composite kits expand to components in pick lists
- [ ] Package cost and itemized pricing modes produce correct totals
- [ ] Tax invoice with correct CGST/SGST vs IGST based on state match
- [ ] Challan auto-numbering across FYs with no gaps
- [ ] Return challan qty ≤ delivered qty
- [ ] Employee balance = payouts - approved expenses
- [ ] Vendor balance = PO cost (waterfall) - payments
- [ ] FY-locked records cannot be modified
- [ ] Trial balance: debits = credits
- [ ] PDF generation for all document types
- [ ] Public ledger accessible without auth via token
- [ ] Attendance geofence validation with penalty system
- [ ] All CRUD operations logged to audit trail

### Non-Functional

- [ ] Page load < 3s on 4G connection
- [ ] No security vulnerabilities (OWASP Top 10)
- [ ] Offline-capable (Firestore persistence)
- [ ] Mobile-responsive public pages
- [ ] All calculation functions have unit tests
- [ ] Critical workflows have E2E tests

---

## APPENDIX A: GST State Codes

```
01: Jammu and Kashmir    02: Himachal Pradesh    03: Punjab
04: Chandigarh           05: Uttarakhand         06: Haryana
07: Delhi                08: Rajasthan           09: Uttar Pradesh
10: Bihar                11: Sikkim              12: Arunachal Pradesh
13: Nagaland             14: Manipur             15: Mizoram
16: Tripura              17: Meghalaya           18: Assam
19: West Bengal           20: Jharkhand           21: Odisha
22: Chhattisgarh         23: Madhya Pradesh      24: Gujarat
25: Daman and Diu        26: Dadra and Nagar Haveli
27: Maharashtra          28: Andhra Pradesh (old) 29: Karnataka
30: Goa                  31: Lakshadweep         32: Kerala
33: Tamil Nadu           34: Puducherry          35: Andaman and Nicobar
36: Telangana            37: Andhra Pradesh (new) 38: Ladakh
```

## APPENDIX B: Logistics Cost Types

| Key | Display Name | Icon | Description |
|-----|-------------|------|-------------|
| `travel` | Travel Cost | Truck | Staff travel to/from venue |
| `accommodation` | Accommodation | Hotel | Staff lodging |
| `food` | Food & Beverage | Utensils | Catering for crew |
| `labour` | Labour Cost | Briefcase | On-site labor (non-employee) |
| `transport` | Transportation | Truck | Equipment transport (separate from travel) |

Each has: `amount` (₹ pre-tax) + `gst` (% rate).

## APPENDIX C: Equipment Categories

Sound, Lighting, Video, Camera, Trussing, Rigging, Projectors, LED, LED Wall, Power, Cables, Accessories

---

*End of Greenfield Architecture Prompt — Version 1.0*
*Generated from analysis of rental-ops v3.9 codebase*
