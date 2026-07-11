# Rental-Ops Application Process and Usage Guide

## 1) Why this application matters

Rental-Ops is an operations and accounting control system for event equipment rental businesses. It connects sales, projects, inventory movement, staff deployment, vendor outsourcing, invoicing, collections, expenses, and accounting into one workflow.

The main value is operational and financial continuity:

- One confirmed project affects inventory availability, team schedules, challans, and revenue projections.
- One expense, payout, or vendor payment affects project margin and accounting books.
- One invoice or payment changes receivables, reports, and client balance view.

In short: this is not just a data-entry app. It is a dependency-driven business system.

## 2) Core business model in Rental-Ops

Typical event rental flow represented by the app:

1. Lead and client identified.
2. Quote/project created with dates, equipment, and logistics.
3. Inventory allocated (with date-overlap checks).
4. Team assigned.
5. Delivery and return challans generated.
6. Expenses, outsourcing, and purchase invoices captured.
7. Tax invoice issued.
8. Payment received and reconciled.
9. Project closed and reflected in accounting and reports.

## 3) Roles and access logic

The system is role-gated. Roles are configured centrally and checked per resource/action.

- Owner (admin): full control including admin tools and audit logs.
- Accountant: full finance/accounting/reporting with restricted admin actions.
- Project Manager: operational ownership of projects, clients, inventory, challans, outsourcing.
- Field Tech: execution-facing modules and own expenses.
- Coordinator (user): controlled view and basic operations.

Impact:

- The same page can render different controls based on role.
- Financial amounts and rates can be hidden while operational visibility remains.

## 4) Data model and module dependencies

Main collections are organized under artifacts/appId/public/data and consumed in live snapshots by the app shell.

High-impact entities and dependencies:

1. Clients and Vendors
- Used by projects, receivables, vendor payouts, outsourcing, purchase invoices.
- Changing a client name affects party-ledger readability and document outputs.

2. Inventory
- Used by project allocation, availability checks, warehouse scan, challans.
- Vendor-owned items support external sourcing and outsourcing decisions.

3. Projects
- Central object connecting clients, inventory, team, financial records, invoices, and reports.
- Status changes affect downstream actions like invoicing and completion tracking.

4. Expenses, Payments, Payouts, Vendor Payments
- Feed both operational dashboards and accounting snapshot generation.
- Influence project profitability and balance sheet movement.

5. Journal and Ledger artifacts
- Accounting views are derived from normalized journal events and balances.
- Reconciliation status marks journals and prevents repeat matching.

## 5) Page-by-page usage and background processing

This section explains each major page from user action to background effect.

### 5.1 Dashboard

User purpose:

- Fast business health view: project pipeline, activity, high-level metrics.

Background logic:

- Combines projects, expenses, payments, inventory, and accounting snapshot.
- Uses calculated totals, statuses, and date windows.

Cross-impact:

- Dashboard does not only display data. It surfaces where action is needed (pending collections, overloaded schedule, or margin stress).

### 5.2 Clients and Contacts

User purpose:

- Maintain client/vendor records and contacts.

Background logic:

- Client records are used as parties in operational and finance modules.
- Ledger links can be generated for external statement access.

Cross-impact:

- Wrong client typing (client vs vendor) cascades into wrong receivable/payable behavior.

### 5.3 Projects

User purpose:

- Create quote/project with dates, items, rates, and logistics components.

Background logic:

- Project grand total uses package-cost precedence when set; otherwise item plus logistics calculation.
- GST and net values are computed with structured helper logic.
- Date overlap logic is used during allocation to prevent overbooking.

Cross-impact:

- Changing project dates affects inventory availability, team assignment, and schedule views.
- Changing package cost overrides itemized financial view for top-line billing.
- Project status transitions affect invoicing and closure workflow.

### 5.4 Inventory and Warehouse Scan

User purpose:

- Maintain stock catalog and track movement.

Background logic:

- Inventory availability is constrained by overlapping active allocations.
- Warehouse scan supports operational movement confirmation.

Cross-impact:

- Incorrect inventory quantity or missing return update creates false shortage or false availability in future projects.

### 5.5 Schedule and Live Tracking

User purpose:

- Plan project timeline, teams, and field movement.

Background logic:

- Uses project and HR time/shift data.
- Role-based visibility protects sensitive monitoring data.

Cross-impact:

- Team assignment changes workload distribution and can alter project execution risk.

### 5.6 Challan Manager

User purpose:

- Generate delivery and return documents for equipment movement.

Background logic:

- Challan actions are tied to project and inventory context.
- Print/PDF outputs are generated with operational and tax-relevant details.

Cross-impact:

- Return challan mismatch creates inventory and reconciliation inconsistencies later.

### 5.7 Outsourcing and Purchase Invoices

User purpose:

- Manage third-party rentals, POs, and vendor invoice evidence.

Background logic:

- Cost precedence uses accepted invoice values before PO estimates.
- Purchase invoices support GST input tracking and accounting book alignment.

Cross-impact:

- Updating invoice acceptance changes project cost and gross margin.
- Missing purchase invoice causes under-reported cost and weak audit trail.

### 5.8 Finance

User purpose:

- Track receivables, disbursements, and financial operations.

Background logic:

- Writes transactional records that feed accounting and reporting aggregates.
- FY lock checks can prevent back-dated financial edits.

Cross-impact:

- A payment posted to wrong client distorts both client ledger and real cash-flow reporting.

### 5.9 Accounting and Virtual Accountant

User purpose:

- View journal, ledger, trial balance, P&L, balance sheet, and post controlled entries.

Background logic:

- Accounting snapshot is generated from source transactions plus manual journals and opening balances.
- Revenue and cost precedence logic avoids double counting.
- Ledger rows are built with stable account identity handling.

Cross-impact:

- Manual journal entries immediately influence trial balance and financial statements.
- Wrong account selection affects multiple reports, not just one transaction.

### 5.10 Bank Reconciliation

User purpose:

- Match bank statement rows against journal vouchers and resolve unmatched items.

Background logic:

- Parser supports robust CSV interpretation and skipped-row reporting.
- Matching uses amount/date/direction scoring with candidate suggestions.
- Optional bank account scoping narrows matching in multi-bank setups.
- Excluding already reconciled vouchers prevents duplicate claims on re-upload.
- Accepted matches persist both row-to-voucher mapping and reconciliation metadata.
- Closing-balance check compares statement close vs ledger bank balance and highlights residuals.

Cross-impact:

- Reconciliation marks journal entries as reconciled, changing future matching pool and finance confidence.
- Book-this-row creates a proper journal entry through shared posting logic, then marks the row reconciled.

### 5.11 Tax Invoices and Documents

User purpose:

- Generate and maintain formal billing documents.

Background logic:

- Supply-type and GST data affect output tax computation and reporting category mapping.

Cross-impact:

- Invoice edits affect receivable value, GST output liability, and report exports.

### 5.12 Reports, Analytics, Business Report, Daily Report

User purpose:

- Decision support: profitability, utilization, receivables, and trend analysis.

Background logic:

- Draws from normalized project, finance, and accounting datasets.
- Report numbers inherit all upstream data correctness.

Cross-impact:

- Reports are only as accurate as source process discipline (allocation, challans, invoices, reconciliation).

### 5.13 HR Module (Attendance, Leaves, Payroll, Reports)

User purpose:

- Workforce attendance, leave control, penalties, payroll calculations.

Background logic:

- Paid/unpaid leave and payroll logic use configured entitlements and attendance records.

Cross-impact:

- HR payroll actions feed expenses and financial reporting quality.

## 6) Critical system logic in background

### 6.1 Total and tax computation rules

1. Project totals
- If package cost exists, it supersedes itemized totals.
- Otherwise, totals are item totals plus logistics totals.

2. GST handling
- GST can be derived from explicit per-line amounts and fallback calculations.
- Output and input GST feed liability/asset positions in accounting.

3. Outsourcing and purchase cost precedence
- Accepted invoice actuals override PO estimate values.

### 6.2 Anti-error safeguards

1. Date overlap checks to reduce overbooking.
2. Reconciliation unique matching controls and reconciled-entry filters.
3. Role-based action restrictions.
4. Financial-year lock protections.

### 6.3 Audit and traceability

1. Major actions are logged via audit event calls.
2. Session persistence in reconciliation preserves review state.
3. Source/origin tagging in posting paths helps accountability.

## 7) How one option affects other modules

Key impact map for business users:

1. Editing project dates
- Affects inventory availability, team schedule, challans timeline, and potential revenue month.

2. Switching to package pricing
- Changes quoting and billed amount logic; can reduce item-level margin visibility.

3. Marking a project completed/closed
- Enables invoice and closure-related actions and changes dashboard pipeline counts.

4. Posting a payment
- Changes client outstanding, finance totals, and accounting cash/bank position.

5. Approving purchase invoice
- Increases recognized cost and GST input credit; affects project margin and accounting statements.

6. Reconciling a bank row
- Marks voucher reconciled, removes it from default future matching pool, and raises confidence in cash reporting.

7. HR leave/payroll updates
- Affect payroll expense and profitability analytics.

## 8) Recommended standard operating process (event rental)

Use this sequence to keep both operations and books accurate.

1. Sales and client onboarding
- Create or verify client record before quote.

2. Project creation and costing
- Build project with dates, item lines, logistics, and GST correctness.

3. Allocation and resource locking
- Allocate inventory and team only after date and quantity validation.

4. Delivery execution
- Generate delivery challan at dispatch and return challan at inward.

5. Cost capture
- Record direct expenses, outsourcing, and purchase invoices promptly.

6. Billing
- Generate tax invoice when project reaches completion conditions.

7. Collections and payout discipline
- Record receipts and payouts with correct party/account mapping.

8. Reconciliation and review
- Reconcile bank statement weekly (or daily for high volume).

9. Period close
- Validate trial balance, review P&L and balance sheet, then lock FY periods as needed.

## 9) Example business scenario (normal event rental lifecycle)

Company: Skyline Event Rentals
Event: Corporate launch, 3 days, Delhi NCR

### Step A: Inquiry to quote

1. Manager creates client GreenArc Pvt Ltd.
2. Manager creates project GreenArc Launch with dates and site details.
3. Adds sound, lighting, LED items and logistics components.

System effects:

- Project value appears in pipeline.
- Tentative inventory demand appears in planning context.

### Step B: Planning and execution prep

1. Inventory allocated after overlap checks.
2. Team assigned in schedule.
3. Delivery challan generated for dispatch list.

System effects:

- Same inventory units become constrained for overlapping project windows.
- Execution documentation is ready for logistics proof.

### Step C: During event

1. Fuel, local transport, and labor expenses are entered.
2. One urgent external truss item is outsourced to a vendor.

System effects:

- Project direct costs increase.
- Margin estimate drops in reports unless pricing is adjusted.

### Step D: Completion and billing

1. Return challan confirms inward quantity.
2. Project marked completed.
3. Tax invoice generated and shared.

System effects:

- Receivable opens against client.
- Revenue and GST output recognized per configured accounting logic.

### Step E: Payment and accounting control

1. Client pays 60 percent advance and remaining after 10 days.
2. Accountant records receipts.
3. Bank statement uploaded in reconciliation page.
4. Statement rows matched to vouchers, unmatched bank charge booked.

System effects:

- Client outstanding reduces to zero.
- Bank and ledger alignment improves.
- Reconciled vouchers are protected from duplicate matching next upload.

### Step F: Monthly review

1. Owner opens reports and accounting snapshot.
2. Checks project margin, receivables aging, GST view, and trial balance.

Business outcome:

- End-to-end traceability from quote to cash.
- Better control over margin leakages and cash certainty.

## 10) Operational best practices for users

1. Keep master data clean
- Standardize client and account naming to reduce reconciliation and posting errors.

2. Post source events early
- Delayed expense or vendor invoice posting creates false profitability.

3. Reconcile frequently
- Weekly reconciliation prevents month-end pileups and hidden bank mismatches.

4. Separate duties by role
- Let operations run projects and finance validate books.

5. Use controlled posting paths
- Prefer validated posting routes (chat, bank-booking, manual journal with checks) over ad-hoc edits.

## 11) Quick reference: what to fix when numbers do not match

1. Revenue mismatch
- Check project package-cost overrides and tax invoice final values.

2. Cost mismatch
- Check outsourcing invoice acceptance state and unposted purchase invoices.

3. Bank mismatch
- Check unreconciled bank rows, wrong bank account scope, and manual closing input.

4. Margin mismatch
- Check missing direct expenses, unlinked outsourcing, or late purchase invoice capture.

5. Statement mismatch by user role
- Verify whether the user has rights to view rates/amounts in that module.

---

This guide is intended as an operating handbook for business teams and implementation partners. It should be reviewed whenever new automation slices are released (AI extraction, reconciliation upgrades, invoice automation) because those features expand posting and validation pathways.