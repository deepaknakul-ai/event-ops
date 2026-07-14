# Changelog

The app version is stamped from `package.json` into the running site (footer +
`/version.json`) via `vite.config.js` → `src/version.js`. Bump with
`npm version minor|patch` (or the `release:*` scripts) and add an entry here.

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
