You are a senior full-stack engineer and accounting systems architect working on the Rental-Ops codebase (React + Firebase + Firestore). Implement a production-grade multi-agent Virtual Accountant that can understand natural language accounting messages, generate compliant journal entries, run continuous audit checks, and orchestrate all accounting workflows end-to-end.

Objective
Build an Accounting Orchestrator with three specialist subagents:
1) Accounting Agent: Understands user text, classifies accounting intent, proposes and posts journal entries.
2) Audit Agent: Validates entries, checks compliance and controls, and flags risks/anomalies.
3) Accounting Process Analyst Agent: Understands how Accounting Agent and Audit Agent are working, compares their outputs, learns from audit findings, and recommends rule/model improvements.

The Main Orchestrator Agent must consult all three agents and produce final decisions with confidence scores, explainability, and fallback human review.

Business Context and Critical Gaps to Solve
1) Current text parsing misses realistic accounting narration patterns, especially mixed/batched expenses in one sentence.
2) Real-world examples to support immediately:
   - "5000 rupees spent on fuel"
   - "600 paid to employee for expense"
   - "employees submit their expense"
   - "7000 paid for booking flight ticket"
   - "outstation cab"
   - "600 paid for food"
3) TDS is critical:
   - Clients often deduct TDS before paying us.
   - TDS handling should be optional/configurable per transaction, but supported deeply.
4) The assistant must understand accounting concepts:
   - Direct income, indirect income, operating revenue, non-operating income
   - Direct expense, indirect expense, COGS, overheads
   - Depreciation
   - Fixed assets vs current assets (working assets)
   - Sundry debtors and sundry creditors
   - Profit and Loss and Balance Sheet impact
5) Bank statement ingestion is required:
   - Parse PDF and Excel bank statements
   - Reconcile against ledger and suggest adjustment entries
6) Voice is not implemented now. Keep architecture voice-ready but implement text-first.

Implementation Scope
A) Multi-Agent Architecture
Implement an in-app multi-agent runtime with strict contracts:
- Main Orchestrator Agent
  - Receives user message or imported statement rows.
  - Calls Accounting Agent first for draft entries.
  - Calls Audit Agent on each draft entry and aggregate batch.
  - Calls Process Analyst Agent to compare Accounting vs Audit outputs and detect recurring weaknesses.
  - Returns final response:
    - approved entries
    - flagged entries requiring clarification
    - risk score
    - concise explanation and next action
- Accounting Agent
  - Performs NLP/NLU intent classification and entity extraction.
  - Supports single-line and multi-line or comma-separated compound messages.
  - Produces:
    - transaction type
    - debit account(s), credit account(s)
    - amount split lines
    - party mapping
    - GST and TDS suggestions
    - confidence
- Audit Agent
  - Verifies double-entry, account type consistency, GST/TDS logic, FY lock rules, duplicate risk, unusual entries, missing narration, and policy rules.
  - Produces severity-tagged findings:
    - blocking error
    - warning
    - advisory
- Process Analyst Agent
  - Observes disagreements between Accounting and Audit agents.
  - Detects patterns (for example, repeated fuel misclassification or missing employee payable leg).
  - Updates rule weights and suggestion tables via a controlled learning pipeline.
  - Generates weekly "agent quality" metrics.

B) Data and Ledger Model Enhancements
Implement or extend storage models for:
- ParsedMessage
- ProposedJournalBatch
- AuditFinding
- TDSConfiguration
- StatementImportSession
- ReconciliationMatch
- AgentDecisionTrace

Required fields include:
- source_text
- normalized_text
- extracted_entities
- entry_lines
- confidence
- audit_score
- requires_human_review
- policy_version
- model_version
- created_by_agent

C) Natural Language Accounting Intelligence
Support robust parsing for:
- Amount formats: 5000, 5,000, 5k, 1.5 lakh, 2 cr, INR 5000
- Mixed text: English + Hinglish
- Multiple events in one message
  - Example: "5000 fuel, 7000 flight, 600 food paid by cash"
- Expense context disambiguation:
  - Direct project cost vs indirect overhead
  - Employee-paid then reimbursement vs direct company payment
- Party resolution:
  - client, vendor, employee aliases
- Payment mode detection:
  - cash, bank, UPI, card, transfer
- Date extraction:
  - today, yesterday, last Friday, explicit date strings

D) Accounting Logic Rules to Implement
1) Employee Expense Workflow
- If employee submits expense not yet reimbursed:
  - Dr relevant Expense account
  - Cr Employee Payable (or Employee Clearing)
- If reimbursed immediately:
  - Dr relevant Expense account
  - Cr Cash/Bank
- If employee received advance earlier and now submits bills:
  - Dr Expense
  - Cr Employee Advance
  - settle balance with payable/receivable if needed

2) Expense Category Mapping
Implement high-confidence mapping:
- fuel, petrol, diesel -> Travel or Site Power and Fuel (direct if project-tagged)
- flight, train, hotel, outstation cab -> Travel and Conveyance (or direct project travel)
- food, meals, catering -> Food Expense (or direct project food if project-tagged)
- vendor services -> Subcontractor or Outsourcing

3) TDS Rules
- Client deducts TDS from our receivable (receipt short by TDS):
  - Dr Bank (net received)
  - Dr TDS Receivable
  - Cr Accounts Receivable (gross settlement)
- We deduct TDS while paying vendor/professional:
  - Dr Expense or Payable
  - Cr Bank (net paid)
  - Cr TDS Payable (deducted amount)
- TDS must support:
  - section tagging (for example 194C, 194J, etc.)
  - rate and amount basis
  - optional per transaction toggle
  - monthly payable summary and deposit reminders

4) Revenue and Income Classification
- Distinguish operating revenue, other income, interest income, discounts.
- Ensure P and L grouping is correct.

5) Asset and Depreciation Logic
- Detect fixed asset purchase from text.
- Route to fixed asset account, not expense account, when thresholds and keywords indicate capitalization.
- Generate periodic depreciation suggestions or auto-entry if enabled.

6) Debtors and Creditors
- Improve sundry debtors and creditors handling with party-ledger identity stability.
- Preserve opening balance and FY carry-forward correctness.

E) Bank Statement Import and Reconciliation
Implement:
- PDF parser pipeline (table extraction + fallback OCR)
- Excel and CSV parser
- Standard normalized row shape:
  - txn_date, value_date, narration, debit, credit, balance, reference
- Auto-match engine:
  - exact amount/date
  - fuzzy narration similarity
  - party alias match
- Output:
  - matched items
  - unmatched credits and debits
  - suggested journal entries
  - bank charges, interest, reversals, UTR pending mapping

F) User Experience
1) Chat-first Accounting Panel
- User can paste one or many lines.
- Show parsed transaction cards and confidence.
- One-click actions:
  - approve all safe entries
  - review flagged
  - ask follow-up clarification

2) Audit Panel
- Severity-based findings
- Explain in plain accounting language
- Show "why" and "how to fix"

3) Orchestrator Decision Panel
- Shows outputs from all three subagents
- Shows final decision and confidence
- Shows when human approval is mandatory

4) Learning and Feedback Loop
- If user corrects account mapping, store correction and improve future predictions.
- Keep audit-safe controlled learning with approval threshold.

G) Security, Controls, and Governance
- Respect existing role permissions and FY lock.
- Maintain complete audit trail for all auto-generated entries.
- No destructive overwrite of posted vouchers.
- Reversal-first approach for corrections.
- Every agent action must be traceable in logs.

H) Implementation Plan (Do Not Skip)
Phase 1: Foundation
- Define agent interfaces and decision pipeline.
- Introduce data contracts and telemetry.
- Build parser improvements for the listed expense examples.

Phase 2: Accounting + TDS Core
- Implement employee expense flows and TDS logic.
- Add direct/indirect classification with project-awareness.
- Expand account mapping and confidence scoring.

Phase 3: Audit and Reconciliation
- Implement Audit Agent rule engine.
- Add bank statement import and reconciliation suggestions.

Phase 4: Process Analyst and Optimization
- Implement disagreement analyzer and quality metrics.
- Add rule-learning feedback pipeline with safeguards.

Phase 5: QA and Hardening
- Unit tests and integration tests.
- Regression tests for existing accounting flows.
- Performance checks on large statement imports.

I) Mandatory Test Cases
Create automated tests for at least these cases:
1) "5000 rupees spent on fuel"
Expected: expense recognized and posted with correct account class.
2) "600 paid to employee for expense"
Expected: distinguish reimbursement vs advance using context and ask clarification if ambiguous.
3) "employees submit their expense"
Expected: create payable-style entry when reimbursement pending.
4) "7000 paid for booking flight ticket"
Expected: travel category and correct payment leg.
5) "600 paid for food"
Expected: food expense category and correct payment leg.
6) Client TDS deduction
Expected: net bank + TDS receivable + AR settlement.
7) Vendor payment with TDS deduction
Expected: bank net + TDS payable.
8) Compound message with 3 expenses in one text
Expected: split into 3 entry proposals.
9) Bank statement import sample
Expected: matched and unmatched items with journal suggestions.
10) FY lock and RBAC
Expected: blocked posting when disallowed.

J) Acceptance Criteria
The feature is complete only if all are true:
1) Multi-agent orchestration is implemented and visible in UI traces.
2) Example transactions listed above parse correctly with confidence and proper accounting entries.
3) TDS workflows for both client-deducted and vendor-deducted scenarios are implemented.
4) Direct versus indirect classification works with project context.
5) Bank statement PDF and Excel ingestion works with reconciliation outputs.
6) Audit Agent blocks invalid postings and explains reasons.
7) Process Analyst Agent reports recurring weaknesses and proposes improvements.
8) Tests pass and no regression in existing accounting and reporting logic.

K) Deliverables
Provide these outputs in your final implementation report:
1) Architecture summary with agent contracts.
2) File-by-file change list.
3) Migration notes if schema changed.
4) Test report with pass/fail details.
5) Known limitations and next roadmap.

Execution Guidance
- Reuse existing accounting and parser infrastructure where possible.
- Do not duplicate modules unnecessarily.
- Keep backward compatibility for existing posted data.
- Prioritize accounting correctness over aggressive automation.
- If confidence is low or ambiguity is high, ask one concise clarification instead of guessing.

Now implement the full feature set above end-to-end in this repository.