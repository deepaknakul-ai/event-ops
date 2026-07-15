# Changelog

The app version is stamped from `package.json` into the running site (footer +
`/version.json`) via `vite.config.js` → `src/version.js`. Bump with
`npm version minor|patch` (or the `release:*` scripts) and add an entry here.

## 3.6.11 — Virtual Accountant: TDS depth (client-deducted flow + monthly deposit summary)

Deeper TDS handling in the AI Accountant chat + Accounts:

- **Client-deducted TDS (a client withholds tax on our receipt)** — new. *"received 90000
  from Acme, TDS 10000 deducted"* / *"Acme paid us 90000 after deducting 10000 TDS"* now books
  **Dr Bank 90,000 + Dr TDS Receivable 10,000 / Cr Acme 1,00,000** (the receivable you claim at
  ITR). Previously this produced a wrong single-leg entry or misfired as a vendor payment.
- **Vendor-deducted TDS** (we withhold paying a vendor) was already correct (Dr Party gross /
  Cr Bank net / Cr TDS Payable) — now the **section is tagged** (194C/194J/194I/194H/194A) and
  **salary TDS tags 192**. An explicitly stated section ("…TDS under 194J") is honoured.
- **Monthly TDS Payable deposit summary** — new read-only table in Accounts → TDS: what you
  withheld, grouped by month × section, with the **deposit-by date (7th of next month)**.
  Aggregates every TDS-Payable credit leg already posted (chat + manual entries).

Deterministic rules engine — no Anthropic key required. The section is persisted on the
journal entry (`tds_section`) so the summary ties out.

## 3.6.10 — Virtual Accountant: employee reimbursements + fuel "ask each time"

The AI Accountant chat now understands **employee out-of-pocket spends** and **ambiguous fuel**:

- **Employee reimbursement** — phrases like *"reimburse Rahul 2000 for site food"* or
  *"paid on behalf of Raj 1500 for printing"* now book **Dr &lt;Expense&gt; / Cr Employee Payable**
  (the company owes the employee), with the employee on the party leg — instead of wrongly
  treating the person as a vendor. A new **Employee Payable** account is seeded. When a known
  employee is merely mentioned (*"Rahul paid 2000 for taxi"*) the entry is left as a company
  expense but carries an **advisory** to confirm whether it's a reimbursement, an advance, or
  company-paid — never silently rerouted. Company advances (*"advance 5000 to Raj"*) are
  unchanged (Dr Employee Advances).
- **Fuel "ask each time"** — generic *"spent 5000 on fuel"* books to **Site Power & Fuel** but
  now carries an **advisory** to confirm Site Power & Fuel (generator/site) vs Travelling &
  Conveyance (vehicle) before posting. Clear context skips the prompt: *"diesel for generator"*
  → Site Power & Fuel; *"petrol for car" / "bike petrol"* → auto-reclassified to Travelling &
  Conveyance. These advisories surface in the v3.6.9 audit banner.

Deterministic rules engine — no Anthropic key required. Employee names are read from the HR
module and are never grounded as a client/vendor party.

## 3.6.9 — Virtual Accountant: Audit Agent verdict in the chat

The AI Accountant chat now runs its drafts past a deterministic **Audit Agent** before you
post. Each entry preview shows an **audit verdict banner** — *"Audit passed — ready to post"*
(green) or *"Audit flagged — review before posting"* (amber) with an **audit score /100** —
and every finding is now tagged by severity (**blocking / warning / advisory**) with a
plain-language **"→ how to fix"** hint. When an entry is posted, an **Agent Decision Trace**
(the audit findings, score, confidence and policy version) is saved alongside it for the audit
trail. No workflow change and no Anthropic key required — this runs on the existing rules
engine. Foundation for the multi-agent Virtual Accountant (Orchestrator + Accounting + Audit
+ Process-Analyst); the LLM Accounting Agent, employee-expense flow and TDS depth follow.

## 3.6.8 — Expense Master (per-employee summary)

New **Master** tab in the Expense Tracker (Owner / Accountant only): a per-employee table
showing **Unapproved**, **Approved**, **Total Payment** (advances + payouts) and **Balance**
(= payments received − approved expenses; positive = advance held by the employee, negative
= reimbursement payable). Includes an employee search, a totals row, and click-through to
each employee's dashboard. Aggregates the same figures the single-employee dashboard already
computes, in one pass.

## 3.6.7 — Ledger-link PO amount ties out with the books + employee-label fix

The client/vendor ledger link computed a vendor **PO's amount** with a hand-rolled calc
(`package_cost×(1+gst%)` or `po.amount`) that **ignored any embedded vendor invoice** and
**mis-derived package GST** — so the figure could differ from the in-app vendor balance. It
now reuses the same authoritative **`getOutsourcingCost`** the in-app derived ledger uses:
embedded vendor invoice → package cost (with the stored GST) → itemised. Linked purchase
invoices flagged `include_in_ledger` still supersede their PO row as before. Also fixed a
latent **object-sum bug** in the project-details PO totals (was summing objects → garbage),
and the Expenses → History **"by _employee_"** label now resolves the current user's own
project quick-expenses (which store the auth uid rather than an employee id).

## 3.6.6 — Migration tools relocated to Admin Tools

The one-time zero-trust field-split buttons (**Backfill money / Scrub base**) lived on the
everyday **Projects, Inventory, and Employees** pages — including a red *Scrub* button that
strips data from base docs, a mis-click risk in daily use. They're now consolidated into a
single **Data Migration** card in **Admin Tools → System Settings** (admin-only), alongside
Commission's *Recalculate cost totals*. The underlying Cloud Functions are unchanged — new
records sync automatically via triggers; these are only for re-running after a bulk import
of old data. Hosting-only.

## 3.6.5 — History project filter lists all projects (current FY by default)

The Expenses → History **Project** filter only listed expense-*eligible* projects
(Confirmed / Ongoing / Completed-within-15-days), so approvers couldn't filter to
older completed/closed projects to find expenses to share. Now, for approvers, it
lists **all** projects — scoped to the **current financial year** (Apr–Mar) by
default, or to the **date range** when one is set. (The Submit form's project picker
is unchanged — you still log new expenses only against active projects.)

## 3.6.4 — Approvers see all expenses in History (to share employee submissions)

The **Expenses → History** tab filtered to your **own** expenses (`employee_id === you`),
so admins/accountants/managers couldn't see — or **Share** — expenses that *other*
employees submitted; only their own (e.g. project quick-expenses) showed, which looked
like "only reimbursables can be shared." Now **approvers see all expenses in History**
(use the **Project** filter to focus one job), so they can find and Share any employee's
project expense with the client. Regular users still see only their own, and the personal
Ledger/balance is unchanged.

## 3.6.3 — Share any decided expense (not just approved)

3.6.1 only offered the **Share** toggle on *Approved* expenses, so Pending/Disapproved
ones showed no toggle — making it look like only reimbursables could be shared. Now:

- The **Share** toggle (Expenses → History) appears on any **decided** expense —
  **Approved or Disapproved** — for project-linked, admin/accountant/manager users.
  The **admin's share decision**, not approval status, controls what the client sees.
- Shared direct expenses show to the client **per project, with proof**, on their
  ledger link (the *Actual Expense Details* panel). They are **transparency-only** —
  the ledger **balance is unchanged** (client still owes *project cost + reimbursables*);
  a shared expense is never added to what's owed.
- The **internal approval status is no longer sent to the client** — they see only
  date / category / description / amount / proof.

## 3.6.2 — Version badge + logistics input fix

**Visible running-version badge.** The build version was only in `/version.json` and
a near-invisible sidebar line (`text-slate-300`, 10px). Now the **sidebar footer shows
a clear version badge** (`v<x.y.z> · <sha> · <date>`); clicking it opens `/version.json`
— the authoritative **live** deploy stamp, so you can confirm what's actually running
even if the browser cached an older bundle. The login screen already showed the version.

**Logistics cost inputs no longer "sticky."** The Travel / Accommodation / Transport /
Food & Beverage amount and description fields in a project's *Logistics & Services*
section wrote to Firestore on **every keystroke** — each character triggered a network
round-trip + snapshot re-render that reverted the field mid-type, so typing felt laggy
and the cursor jumped. They now use a **commit-on-blur** input (`CommitInput`): you type
freely into local state and it saves when you leave the field or press Enter. Also shows
an empty box instead of a stubborn `0`. GST dropdowns were unaffected (discrete changes).

## 3.6.1 — Expense sharing is now per-expense (approved only)

**Why.** 3.6.0 gated direct expenses at the *project* level and showed every
non-rejected expense — too blunt. Finance needs to choose *which* expenses a
client sees, and only after they're vetted.

**What changed.**
- **Per-expense opt-in.** In **Expenses → History**, each **Approved** expense now
  has a **"Share"** toggle (Admin/Accountant/Manager only). Only expenses you mark
  `shared_with_client` reach the client — and only while they stay Approved.
- **Ledger link.** `getLedgerData` now attaches a project's direct expenses from the
  set of `shared_with_client` + Approved expenses (one indexed read), scoped to the
  client's own projects. The project-level `share_expense_details` toggle now governs
  **reimbursable** proofs only.
- Same whitelist + leak-regression guarantees; new `groupClientSharedExpenses`
  helper + tests enforce "approved + shared + this-client-only, identity stripped."

## 3.6.0 — Client-visible actual expense details & proofs (opt-in per project)

**What changed.** A client viewing their shared **ledger link** can now dive into a
project's **actual expenses incurred** and **reimbursable expenses**, including the
**proof files (images / PDFs) submitted by employees** — but only for projects the
owner has explicitly opted in.

**How it works.**
- **Per-project opt-in.** On a project's *Client Reimbursable Expenses* panel there is
  a new **"Show on ledger link"** toggle (`share_expense_details`, off by default,
  editor-only). When on, that one project's actual expenses + reimbursables + proofs
  become visible to the client on the ledger link they already have.
- **On the ledger link.** An **"Actual Expense Details"** panel lists the shared
  projects; **"View Expenses & Proofs"** opens a breakdown of direct expenses
  (from the `expenses` collection, by `project_id`) and reimbursable expenses, each row
  linking to its proof. Proofs open in a new tab (tokenised Firebase Storage URLs, the
  same mechanism the public reimbursable page already uses — no Storage-rules change).

**Why it's safe.**
- The `getLedgerData` callable stays a strict whitelist. Expense/proof data is fetched
  and attached **only** for opted-in projects; non-flagged projects send nothing.
- Projections **never** expose the submitting employee, `project_id`, storage path, or
  internal ids/remarks — only date, category, description, amount, status, and the proof
  link. Rejected/disapproved expenses are dropped. Enforced by unit tests (incl.
  leak-regression assertions) in `tests/ledger-project.test.js`.

**Deliberate trade-off.** Showing actual expenses reveals real cost (and therefore
margin) to the client — which is exactly why it is a conscious, per-project opt-in,
intended for cost-plus / reimbursable-billing clients.

_Requires deploy of `functions:getLedgerData` + hosting._
