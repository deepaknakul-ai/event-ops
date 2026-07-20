# Rental-Ops Demo Presenter Script

## Purpose

This script is designed for live demonstration of Rental-Ops with a realistic event-rental business scenario.

It includes:

- A 60-minute executive demo script
- A 90-minute operations and finance deep-dive script
- Click-by-click actions
- Exact presenter lines
- What each action does in the background
- How each action affects other modules
- Recovery lines if something fails during live demo

Use this as a spoken runbook, not as a technical spec.

---

## Demo Scenario Used In Both Formats

Company: Skyline Event Rentals

Client: Zenith Pharma Pvt Ltd

Project: Zenith Annual Meet 2026

Duration: 3 event days + 1 setup day + 1 teardown day

Business complexity injected in scenario:

1. Package pricing with add-on items
2. One outsourced item from vendor
3. Direct expenses during execution
4. Client payment in two installments
5. One unmatched bank row booked during reconciliation

---

## Presenter Setup (Do Before Audience Joins)

1. Open app and login as Admin in browser tab 1.
2. Keep second tab ready for quick role switch (Manager/Accountant).
3. Ensure these records exist:
- 8 clients
- 5 employees
- 30 inventory items
- 2 prior projects
- 1 vendor
- 1 sample bank CSV
4. Keep a fallback statement file ready.
5. Keep one short note visible with target outcomes:
- Prevent overbooking
- Track true margin
- Close books with reconciliation

---

## 60-Minute Executive Demo Script

## Goal

Prove business control, financial visibility, and auditability in one story.

## Time Plan

1. 0-5 min: Positioning and role-based control
2. 5-18 min: Client to project quote flow
3. 18-28 min: Inventory allocation and challan flow
4. 28-38 min: Cost capture and invoicing
5. 38-50 min: Collections and reconciliation
6. 50-57 min: Accounting and reports
7. 57-60 min: Summary and sign-off questions

## Stage 1 (0-5 min) - Access and control

Click path:

1. Open Dashboard.
2. Open role-protected module (Finance/Accounting).
3. Switch to Manager role and re-open same area.

Presenter line:

"We run one platform for all teams, but with strict role controls. Operations can move fast without unrestricted financial posting."

Background process:

- Permission checks gate actions by resource and action.

Cross-impact to call out:

- Wrong role cannot accidentally alter books.

## Stage 2 (5-18 min) - Client and project creation

Click path:

1. Go to Clients.
2. Create or open Zenith Pharma client.
3. Go to Projects.
4. Create project Zenith Annual Meet 2026.
5. Add event dates.
6. Add items and logistics.
7. Toggle package-cost mode and set package value.

Presenter line:

"This is where sales intent becomes operational and financial truth."

Background process:

- Project total follows package-cost precedence if set.
- GST and totals are computed from configured logic.

Cross-impact to call out:

- Changing package cost changes billing basis and margin lens in reports.

## Stage 3 (18-28 min) - Allocation and challans

Click path:

1. In project, allocate inventory items.
2. Try a conflicting date allocation to show warning/protection.
3. Open Schedule and show assigned team impact.
4. Open Challans.
5. Generate delivery challan.

Presenter line:

"This is where overbooking risk is controlled before it becomes a field failure."

Background process:

- Date-overlap checks and availability constraints.
- Delivery record links movement to project context.

Cross-impact to call out:

- One date change can affect inventory availability and manpower planning.

## Stage 4 (28-38 min) - Costs and invoice

Click path:

1. Open Expenses and enter fuel/labor records.
2. Open Outsourcing and add vendor-linked outsourced item.
3. Open Purchase Invoices and attach/record invoice.
4. Return to project and mark completed.
5. Open Tax Invoices and generate invoice.

Presenter line:

"If costs are not captured here, profit is fake. This flow closes that gap."

Background process:

- Cost precedence uses actual invoice values where available.
- Invoice state moves receivable logic forward.

Cross-impact to call out:

- Late purchase invoice posting inflates margin until corrected.

## Stage 5 (38-50 min) - Receipts and reconciliation

Click path:

1. Open Finance and post first payment installment.
2. Post second payment installment.
3. Open Bank Reconciliation.
4. Upload statement CSV.
5. Show auto-matches and confidence.
6. Change one candidate match manually.
7. Book one unmatched row.
8. Persist accepted matches.
9. Show closing balance card.

Presenter line:

"This is where cash reality is validated against book reality."

Background process:

- Row parsing, score-based matching, unique-voucher safeguards.
- Reconciled flags reduce re-match risk on future uploads.

Cross-impact to call out:

- Reconciliation changes future matching pool and confidence in cash reporting.

## Stage 6 (50-57 min) - Accounting truth and owner view

Click path:

1. Open Accounting.
2. Show ledger and trial balance.
3. Show P and L and balance sheet.
4. Open Reports/Business Report.
5. Open Audit Logs for one action trace.

Presenter line:

"From one project journey, we now have complete audit-ready financial traceability."

Background process:

- Snapshot builds from posted entries and normalized account mapping.

Cross-impact to call out:

- Every operational action can be traced to financial impact.

## Stage 7 (57-60 min) - Executive close

Ask stakeholders:

1. Can this reduce project leakage and billing delays?
2. Can this improve cash confidence at month close?
3. Can this replace current fragmented tools without control loss?

---

## 90-Minute Deep-Dive Demo Script

## Goal

Demonstrate practical daily usage by operations and finance teams in one connected run.

## Time Plan

1. 0-10 min: Architecture, roles, and navigation
2. 10-30 min: Sales to project to allocation
3. 30-45 min: Execution controls (challans, warehouse, team)
4. 45-60 min: Costing and vendor cycle
5. 60-75 min: Billing, receipts, and accounting posting impact
6. 75-86 min: Bank reconciliation deep flow including unmatched booking
7. 86-90 min: Reports, audit, Q and A

## Deep-Dive Stage Details

## Stage A (0-10 min) - Navigation and governance

Click path:

1. Dashboard overview.
2. Show modules list quickly.
3. Show protected route behavior by role.

Presenter line:

"Our design principle is simple: operational speed plus financial control."

Focus callouts:

1. Role-action gating
2. Financial visibility separation
3. Audit-readiness

## Stage B (10-30 min) - Project lifecycle setup

Click path:

1. Clients: create/check client and contact points.
2. Projects: create project and set dates.
3. Add inventory lines with quantities/rates.
4. Add logistics costs.
5. Set package-cost override and explain when to use it.
6. Assign team.

Presenter line:

"At this stage, every operational decision creates a measurable financial footprint."

Background and impact callouts:

1. Date overlap logic protects inventory planning.
2. Package-cost override changes top-line computation behavior.
3. Team assignment links HR workload and execution readiness.

## Stage C (30-45 min) - Execution controls

Click path:

1. Challan Manager: delivery challan creation.
2. Warehouse Scan: show movement confirmation process.
3. Return challan simulation.
4. Schedule view confirmation.

Presenter line:

"Execution records are not paperwork here; they are data controls that prevent downstream confusion."

Impact callouts:

1. Dispatch/return quality affects inventory truth.
2. Inventory truth affects future project commitments.

## Stage D (45-60 min) - Cost and vendor cycle

Click path:

1. Outsourcing: add vendor-supplied requirement.
2. Purchase Invoices: record vendor invoice details.
3. Expenses: add event direct expenses.
4. Re-open project summary and show margin movement.

Presenter line:

"This is where we prevent hidden cost leakage and delayed profitability surprises."

Impact callouts:

1. Invoice acceptance influences recognized cost.
2. Missing direct expense entries create false profit.

## Stage E (60-75 min) - Billing to books

Click path:

1. Tax Invoices: create invoice for completed project.
2. Finance: record receipt split into two payments.
3. Accounting: show effect in ledger and receivable movement.

Presenter line:

"Billing and receipt posting are connected, so owner visibility updates in real time."

Impact callouts:

1. Invoice affects receivable and tax output visibility.
2. Payments affect cash/bank and outstanding balance.

## Stage F (75-86 min) - Reconciliation deep flow

Click path:

1. Bank Reconciliation: upload statement.
2. Show parser outcome and skipped row visibility.
3. Show top candidates on matched and unmatched lines.
4. Use alternate picker to change a match.
5. Use Book this row on one unmatched item.
6. Persist accepted.
7. Show closing balance comparison and residual.

Presenter line:

"This closes the loop between operations, accounting, and real bank movement."

Impact callouts:

1. Reconciled entries are protected from duplicate matching.
2. Unmatched booking still uses validated posting workflow.
3. Closing balance card exposes residual risk clearly.

## Stage G (86-90 min) - Reporting and trust close

Click path:

1. Reports: project profitability snapshot.
2. Accounting: trial balance balanced check.
3. Audit Logs: show who performed key actions.

Presenter line:

"We can now answer: what happened, why it happened, and who did it."

---

## Mandatory Demo Sentences (Use Exactly)

Use these lines to keep the narrative business-focused.

1. "This action is operational on screen, but financial in effect."
2. "The system is preventing a future error, not just showing a warning."
3. "We are not just posting entries, we are preserving audit trail and control."
4. "This module result is consumed by at least two downstream modules."
5. "If this step is skipped in real life, reporting quality drops immediately."

---

## Live Failure Recovery Script

If anything breaks, say this and continue:

1. "The control behavior is still demonstrated; I will continue using preloaded data for timeline continuity."
2. "I am switching to a prepared record so we can focus on the business logic impact."
3. "This does not change process validity, only this live input step."

Fallback sequence:

1. Skip file upload step and open pre-saved reconciliation session.
2. Skip creation step and open existing demo project.
3. Continue to accounting and reports to preserve end-to-end story.

---

## Demo Completion Checklist

Confirm all were shown before ending:

1. Role-based access difference
2. Project creation and costing logic
3. Inventory/date conflict protection
4. Challan lifecycle
5. Expense plus outsourcing plus purchase invoice flow
6. Invoice plus payment flow
7. Bank reconciliation including unmatched row booking
8. Accounting statements and audit trace

If all 8 are shown, the demo is complete.
