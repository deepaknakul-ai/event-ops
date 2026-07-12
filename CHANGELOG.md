# Changelog

The app version is stamped from `package.json` into the running site (footer +
`/version.json`) via `vite.config.js` → `src/version.js`. Bump with
`npm version minor|patch` (or the `release:*` scripts) and add an entry here.

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
