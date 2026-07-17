# TERMS AI Accountant — Feature Report & Command Guide

*As of v3.6.20 (July 2026). Everything below is live at https://terms-a005e.web.app.*

---

## 1. What the AI Accountant has become

Until v3.6.8 the assistant was an **entry-maker**: you typed a transaction, it drafted a journal
entry. Across v3.6.9 → v3.6.20 it became a **full accountant** with five capabilities layered on
top, then a hardening pass that closed 28 audited grey areas.

| Layer | What it does | Since |
|---|---|---|
| **Makes entries** | 27 rule intents (receipt, payment, invoice, salary, expense, advance, **reimbursement**, TDS both directions, GST splits…) + an LLM fallback for free-form Hinglish, inclusive-GST back-calculation, arithmetic and compound entries. Every draft is validated, audit-scored, and **you** post it. | core |
| **Shows & answers** | Ask about your books in plain language — balances, ledgers, aging, GST/TDS dues — answered instantly and free from the deterministic engine; anything unusual goes to a **read-only AI agent grounded on your actual figures** (it can never invent a number or post anything). | 3.6.15 / 3.6.17 |
| **Prints** | One-click PDF for P&L, Balance Sheet, Trial Balance, any account ledger, and the audit report. "print Acme's ledger" works from chat. | 3.6.15 |
| **Audits** | "audit my books" → whole-ledger health score (A–F) with findings and fixes: trial-balance integrity, Suspense balances, duplicates, negative cash, GST/TDS overdue, stale receivables, unreviewed AI entries. | 3.6.16 |
| **Owns the close** | Year Close shows a ready/not-ready checklist, a live **GST/TDS compliance calendar** (real due dates from your activity), and a **depreciation proposal** (true WDV, can't double-post). | 3.6.18/19 |
| **Guards the books** | One validator on *every* posting path (chat, bank-reco, manual forms). A balance sheet that **ties by construction**. FY locks enforced **server-side, binding even admin**. Posted vouchers reverse, not delete. One voucher series everywhere. | 3.6.20 |

### How the brain routes what you type
```
your message
 ├─ looks like a booking?  → rules engine → validated draft → YOU post/park
 │                            └─ rules can't shape it → LLM extractor → same validated path
 ├─ looks like a question? → deterministic answers (free, offline)
 │                            └─ off-menu question → read-only AI Q&A on your books digest
 └─ accountant command?    → audit / close-readiness / print actions
```
Hinglish works at every branch — including mid-sentence question words (*"acme ka balance kya hai"*).

---

## 2. Command reference

### A. Booking commands (make entries — always previewed, you press Post)
| Say (English or Hinglish) | Books |
|---|---|
| `got 50k from Acme` / `acme se 50000 aaye`* | Dr Cash·Bank / Cr Party: Acme |
| `paid 20000 to Sharma Traders via NEFT` | Dr Party / Cr Bank |
| `invoice 1,18,000 to Acme incl 18% GST` | taxable + CGST/SGST split back-calculated |
| `kiraya diya 25000` | Dr Rent Expense / Cr Cash |
| `diesel bharwaya 2000 generator ke liye` | Dr Site Power & Fuel (clear context = no question) |
| `spent 5000 on fuel` | Site Power & Fuel + an advisory to confirm vs vehicle fuel |
| `raju ko advance diya 3000` | **Dr Employee: Raju** / Cr Cash (per-employee account) |
| `reimburse Ramesh 2000 for site food` | Dr Food Expense / **Cr Employee: Ramesh** |
| `salary 50000 to Rahul, TDS 5000 kaat ke` | net + TDS Payable legs, section 192 tagged |
| `received 90000 from Acme, TDS 10000 deducted` | Dr Bank + Dr TDS Receivable / Cr Acme (client-deducted) |
| `8 log x 800 khana`* | Food Expense 6,400 (arithmetic via AI) |
| `36000 ka bill, 6000 advance pehle diya, baaki 30000 pay kiya`* | settlement with the advance leg |

*\* = handled by the AI fallback (needs AI enabled; ~1 paisa-scale token cost per message).*

Extras: **Park** any preview as a draft (drafts now carry an orchestrator audit chip); `reverse JV-0012-2026-27` posts a reversal voucher; low-confidence previews show an **Ask AI** chip.

### B. Question commands (read-only — nothing ever posts)
| Say | Answer |
|---|---|
| `what's Acme's balance?` / `acme ka balance kya hai` | receivable/payable with interpretation |
| `show me Rahul's ledger` → `print Rahul's ledger` | closing balance · downloads the PDF |
| `who owes us money?` / `kitna outstanding hai?` | AR/AP totals, staff shown separately |
| `GST liability this month` · `tds payable` | net figures from the books |
| `cash balance` · `kitna cash bacha hai` | as of today |
| `P&L` · `kitna profit hua is saal` | revenue / **real** expenses / net |
| `balance sheet` · `trial balance` | totals (full-FY figures, labelled) |
| `expenses this month` · `revenue vs expenses last fy` | monthly charts with drill-down |
| *anything else question-shaped* | AI answers **only from your books digest** |

### C. Accountant commands
| Say / click | Result |
|---|---|
| `audit my books` / `audit karo books ka` | score + top findings; full report in **Accounts → Audit** (printable) |
| `am I ready to close?` / `month end status` | blockers, warnings, overdue items, next statutory deadline |
| **Accounts → Year Close** | checklist + compliance calendar + depreciation proposal (Park as draft) |
| **Print PDF** buttons | on P&L, Balance Sheet, Trial Balance, Ledger, Audit tabs |
| **Accounts → AI Entries / AI Insights** | CA sign-off queue · what the assistant is learning |

### D. Guardrails you can rely on
- **Draft-only everywhere** — no AI path can post; a human always confirms.
- **One validator** — chat, bank-reco, manual JV/CN-DN/TDS all run the same checks (closed FY, duplicates, GST math, sign conventions, inactive accounts).
- **FY locks bind the server** — even admin cannot write into a locked year (unlock first in Admin Tools; that's audit-logged).
- **Everything is traced** — AI provenance, decision traces, review sign-off, activity log.

---

## 3. Known limitations (documented, by design)
- `"...ka bill settle kiya 36000"` parses as an **invoice** (the word "bill") — the preview shows the direction; phrase vendor payments as `"...ko 36000 diye"`. (Pinned in tests as a known read.)
- Chat statement answers are full-FY figures (labelled as such), not chat-period-scoped.
- The public employee link shows *Payments received (incl. salary)* with type badges; a full owed-vs-received ledger is a future opt-in.
- Party names extracted from pure-Hindi word order can look odd in the preview label — the entry itself is correct; edit before posting if needed.

## 4. How to test it — see `docs/AI_ACCOUNTANT_UAT.md`
A comprehensive live-environment plan: 6 personas (different English levels), 60+ scripted
utterances with expected results, plus the automated layers behind it (`tests/persona-hinglish.test.js`
free · `EVAL_PERSONAS=1 / EVAL_QA=1 node functions/llm-eval.cjs` billed).
