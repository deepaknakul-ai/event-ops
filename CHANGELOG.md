# Changelog

The app version is stamped from `package.json` into the running site (footer +
`/version.json`) via `vite.config.js` → `src/version.js`. Bump with
`npm version minor|patch` (or the `release:*` scripts) and add an entry here.

## 3.6.22 — Client ledger link: invoice → projects details

On the shared client ledger, every **Inv# chip is now a link** — clicking it opens the
Invoice Summary with that invoice selected, showing exactly **which projects the invoice
covers** (with per-project details and the invoice amount vs projects total). The Invoice
Summary now includes invoices raised through the invoice module (previously it only knew
projects stamped with an invoice number), so every invoice on the statement is explorable.

## 3.6.21 — Hinglish questions + AI Accountant guide

Mid-sentence Hinglish question words ("acme ka balance kya hai", "gst ka kitna banta
hai") are now recognised as questions and answered from your books instead of being
treated as entries. New docs: AI_ACCOUNTANT_GUIDE (features + commands) and
AI_ACCOUNTANT_UAT (six-persona live test plan).

## 3.6.20 — Grey-area hardening: 28 audit findings fixed across 7 waves

A full adversarial audit of the AI accounting system, then fixes for everything found:

- **Right answers**: the chat P&L no longer reports "Expenses: ₹0"; "show BS Traders
  ledger" no longer returns the balance sheet; ambiguous names ask "did you mean…";
  statement answers say exactly which period they cover.
- **Questions reach the right brain**: "are we profitable?" and other free-form questions
  now go to the read-only Q&A (deterministic or AI) — never to the entry extractor. Parked
  drafts get an orchestrator audit chip.
- **A balance sheet that ties**: every account (fixed assets, accumulated depreciation,
  loans, capital, drawings, TDS both sides, Suspense, second cash/bank accounts, opening
  equity, P&L closing) now classifies into a visible line — A = L + E holds by construction,
  and closed years no longer double-count profit.
- **Depreciation can't double-post**: same-FY proposals are blocked once posted or parked;
  multi-year bases are true WDV (cost − prior schedules); unexplained history is flagged
  honestly.
- **One meaning of "employee payments"**: Expense Master, Reports and the payout list all
  now separate claim-settling payments (advances + reimbursements) from salary — matching
  the ledger. Editing an untyped payout forces an explicit type. Deactivated account heads
  disappear from posting pickers and warn if used.
- **LLM parity**: the AI extractor learns the per-employee accounts (reimbursement intent,
  employee roster in context, flat-account rewrite) so both paths book identically; the
  ask-anything agent gains an eval (incl. injection resistance). *(functions deploy)*
- **Server-side controls**: locked financial years are now enforced in Firestore rules —
  binding admin too — and by the nightly scheduler; system account heads can't be renamed,
  retyped or deleted; cron and UI vouchers share one numbering series. *(rules + functions
  deploys)*

Double-reversal is no longer possible; posted vouchers can't be hard-deleted by non-admins.
658 app tests + 179 emulator rules tests pass.

## 3.6.19 — Full Accountant, Phase 5: Integrity gap-fillers

The final phase of the Full Accountant roadmap — closing the paths the audit engine couldn't vouch for:

- **One validated posting path** — the Manual Posting, Credit/Debit Note, and TDS Entry forms
  now run the **same validator the AI chat uses** before posting: closed-FY, duplicate,
  sign-convention, GST-math and account checks. Errors block the post; warnings are surfaced
  as a note but don't stop a deliberate action. (TDS validates *before* consuming a voucher number.)
- **Depreciation proposer** — Year Close now shows a **proposed depreciation schedule** (WDV
  block rates on your fixed-asset balances: computers/software 40%, plant/AV 15%, furniture 10%,
  vehicles 15%, building 10%) with a one-click **Park as draft** — you review and post; nothing
  is booked automatically.
- **Account Heads management** — each account can now be **deactivated/reactivated** and its
  Type / Sub-type / Normal side edited inline. Names stay immutable (the ledger groups by name).

Deferred by design: vendor-payment (AP) due-date reminders — payables visibility already exists
via Ageing, the Audit tab and the close checklist; a true due-date model is a future slice.

## 3.6.18 — Full Accountant, Phase 4: Proactive close + compliance calendar

The accountant now **owns the close**. Accounts → Year Close gains:

- **Close-readiness checklist** — a ready/not-ready verdict with itemised checks: trial balance
  balanced, no blocking audit findings, warnings resolved, drafts cleared, AI entries reviewed,
  GST filed & paid, TDS deposited, bank reconciled. Blockers stop a close; warnings advise.
- **Compliance calendar** — live GST/TDS statutory deadlines computed from your actual activity:
  TDS deposit (7th), GSTR-1 (11th), GSTR-3B (20th) for the current and previous period, with
  amounts and **overdue** flags.
- **Ask in chat** — *"am I ready to close the year?"*, *"month end status"*, *"close checklist"*
  → the verdict, open warnings, overdue items, and the next deadline.

Advisory only — closing remains the existing human-driven action; nothing changes automatically.

## 3.6.17 — Full Accountant, Phase 3: Ask-anything (AI Q&A over your books)

The assistant can now answer **free-form questions** about your books, not just the fixed menu.
When a question isn't one of the built-in answers, it escalates to a **read-only AI agent** that
answers strictly from a compact digest of your actual figures — *"why is my cash lower than last
month?"*, *"which client is my biggest exposure?"*, *"is my GST under control?"*

- **Grounded & read-only:** the AI only sees a digest of your books (statements, account and
  party balances, aging, GST/TDS) and is instructed to use **only those figures — never invent
  numbers**. It cannot post or change anything.
- **Hybrid, cost-aware:** the deterministic answers (v3.6.15) still handle the common questions
  instantly and offline for free; the AI is used only for the long tail, and reuses the same
  monthly budget + rate limits as the rest of the assistant.

Requires the AI assistant to be enabled (Admin Tools → AI Assistant). Falls back to a plain
summary when AI is off or offline.

## 3.6.16 — Full Accountant, Phase 2: Audit engine

The AI Accountant can now **audit the whole book** and take responsibility for its health —
not just score one entry at a time.

- **New Audit tab** (Accounts → Audit): a health **score /100 + grade** with a categorised
  findings list — trial-balance integrity, Suspense/unresolved balances, negative cash/bank,
  book-wide duplicate vouchers, outstanding GST/TDS to deposit, stale 90+ day receivables/
  payables, missing narrations, unreviewed AI entries, unposted drafts, and postings in a
  closed FY. Each finding carries a plain-language fix. **Download Report** prints a PDF.
- **"Audit my books" in chat** — ask the assistant and get the score, headline, and top findings
  instantly, with a pointer to the full report.

Read-only and deterministic — it reviews your posted books and reports; it never changes
anything (fix each item from its own tab). Foundation for the proactive month/year-end close.

## 3.6.15 — Full Accountant, Phase 1: Show & Print

The AI Accountant now **answers on demand** and **prints statements** — the first step from
entry-maker toward a full accountant.

- **Ask about your books** in the assistant chat: *"what's Acme's balance?"*, *"show me Rahul's
  ledger"*, *"who owes us money?"*, *"GST liability this month"*, *"TDS payable"* — answered
  instantly from your books (read-only, deterministic, works offline). Party and employee
  balances are interpreted as receivable/payable; *"print Acme's ledger"* downloads a PDF.
- **Print any statement** — new **Print PDF** buttons on the P&L, Balance Sheet, Trial Balance,
  and Ledger tabs (these had no export before). A single account's ledger prints with a running
  balance and closing figure.
- **Balance Sheet fix** — the liabilities panel now shows **Owed to Employees** (employee
  payable), which the data model carried but the screen omitted.

Deterministic, read-only, nothing is posted. Foundation for the audit engine and the LLM
"ask-anything" agent (later phases).

## 3.6.14 — Per-employee reimbursement accounts (consolidated) + Finance payout kinds

Money owed to an employee now lives in **one account per employee** and clears when you pay them.

- **Per-employee ledger account** — an approved expense claim now credits **`Employee: <name>`**
  (a single net running balance per employee) instead of a lumped `Reimbursement Payable`.
  Advances debit the same account, so each employee shows one balance: a **liability** when you
  owe them (net Cr) or an **asset** when they hold an advance (net Dr). It appears on the Balance
  Sheet and is selectable in the ledger drilldown — but stays out of client/vendor AR/AP.
- **Consolidation** — the AI Accountant chat reimbursement/advance now target the **same**
  `Employee: <name>` account (previously a separate `Employee Payable`), and a chat entry by name
  merges into the derived per-employee balance.
- **Finance payout kinds** — the employee-payout form gains a **Payment For** selector
  (Salary / Reimbursement / Advance). A **Reimbursement** payment now `Dr Employee: <name> / Cr
  Cash·Bank` — clearing what you owe — instead of silently hitting Salary Expense. **Fixes a
  latent bug** where every employee payout mis-posted to Salary Expense (the routing was never
  activated). Salary payments — and all historical payouts — are unchanged.

Deterministic; no data migration (the ledger is derived). Past payouts stay as recorded; tag a
specific old payout as "Reimbursement" via the Finance edit form if you want it to clear.

## 3.6.13 — Bank reconciliation: smart suggestions for common unmatched rows

When you book an unmatched bank-statement row, the assistant now **auto-suggests the right
account** for the everyday patterns:

- **Bank charges / fees** (SMS charge, AMB, NEFT/IMPS charge, service charge…) → **Bank Charges**
- **Interest** → **Interest Income** (credited) / **Interest Expense** (debited)
- **Cash deposit / withdrawal** → booked against **Cash**
- **Reversals / refunds** → routed to Suspense with a clear "confirm which entry it reverses"
  note, never a wrong guess

Each suggested entry shows the reason and now runs the **Audit Agent verdict** (green/amber
banner + score + fix hints) — the same check the chat uses — before you post. A recognised
party name or your own learned mapping still wins over these patterns, and everything still
posts through the one validated → human-confirm → post path. Deterministic; no Anthropic key.

## 3.6.12 — Virtual Accountant: Process-Analyst insights (Accounts → AI Insights)

A new read-only **AI Insights** tab in Accounts (finance/accountant only) mines the decision
traces now saved on AI-posted entries (v3.6.9) to show what the assistant is learning:

- **Audit health** — entries analysed, average audit score, % posted below the confidence bar,
  count posted with warnings/advisories.
- **Most common audit findings** — ranked finding codes (fuel-ambiguous, possible-duplicate,
  unknown-party…) with severity + fix hint.
- **Rule ideas** — when a finding recurs to the same account ("you booked entries flagged X to
  Travelling & Conveyance 6/7 times — add a rule?"). Advisory only; nothing changes automatically.
- **Weak spots** — parties, accounts, and prompt words that most often produce flagged drafts.
- **Party-name corrections** — which typed names keep getting remapped.

Pure/deterministic, driven entirely by journal entries already in memory — no new database
reads, no writes, no Anthropic key. Honest by design: it reports observed outcomes (the final
posted account), not the AI's pre-edit draft, which isn't stored.

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
