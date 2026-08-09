import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { confirmDialog, promptDialog } from '../utils/dialog';
import {
  addDoc,
  collection,
  doc,
  writeBatch,
  deleteDoc,
  getDocs,
  updateDoc,
  getDoc,
  onSnapshot,
  setDoc,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage, auth } from '../firebase';
import {
  BookOpen,
  FileSpreadsheet,
  Receipt,
  ReceiptText,
  Scale,
  Wallet,
  Landmark,
  PlusCircle,
  ClipboardCheck,
  CalendarSync,
  Trash2,
  Sparkles,
  Edit,
  Plus,
  Download,
  Clock,
  FileText,
  Search,
} from 'lucide-react';
import { formatCurrency, getFYFromDate, getProjectGSTBreakdown, isProjectInvoiced } from '../utils/helpers';
import { assertFYNotLocked } from '../utils/fyLock';
import { computeFyRolloverRows } from '../utils/fyRollover';
import * as XLSX from '@e965/xlsx';
import {
  buildAccountingSnapshot,
  generateBookInvoiceNumber,
  generateJournalVoucherNumber,
  getDefaultChartOfAccounts,
  getNextFinancialYear,
} from '../utils/accounting';
import { can } from '../utils/permissions';
import { ConfirmDeleteModal, Modal } from '../components/Shared';
import VirtualAccountant from '../components/VirtualAccountant';
import RecurringEntries from './RecurringEntries';
import BankReconciliation from './BankReconciliation';
import { extractVariables, applyVariables } from '../utils/aiAccountant/template-vars';
import { auditFromIssues, POLICY_VERSION, resolveAccountCandidates, pnlAnswer, partyBalanceAnswer, accountLedgerAnswer, outstandingAnswer, gstLiabilityAnswer, tdsLiabilityAnswer, runBooksAudit, runOrchestrator, buildBooksDigest, buildCloseChecklist, validateTransaction, canPost, proposeDepreciation, collectPriorDepreciation } from '../utils/aiAccountant';
import { generatePnlPdf, generateBalanceSheetPdf, generateTrialBalancePdf, generateLedgerPdf, generateAuditPdf } from '../utils/pdf/statementsPdf';
import { aiAvailable, aiAnswerQuery } from '../utils/aiParse';
import AiInsightsPanel from '../components/accounting/AiInsightsPanel';
import { enqueueDraft, flushQueue, queueSize } from '../utils/offlineDraftQueue';
import { exportReport as exportReportImpl, exportGstToExcel as exportGstToExcelImpl, exportGstrJson as exportGstrJsonImpl, exportAiEntries as exportAiEntriesImpl } from '../utils/accountingExports';

const TABS = [
  // ── Money Overview (layman-friendly first) ──
  { id: 'overview',             label: 'Overview',              icon: Wallet,          group: 'overview' },
  // ── Books & Records ──
  { id: 'sales',               label: 'Invoiced Sales',        icon: ReceiptText,     group: 'books',  hint: 'All billed work' },
  { id: 'non_invoiced_sales',  label: 'Unbilled Work',         icon: ReceiptText,     group: 'books',  hint: 'Completed but not yet billed' },
  { id: 'purchase',            label: 'Purchases & Outsourcing', icon: Receipt,       group: 'books',  hint: 'Bills from vendors' },
  { id: 'ledger',              label: 'Party Accounts',        icon: FileSpreadsheet, group: 'books',  hint: 'Who owes you / who you owe' },
  { id: 'cn_dn',               label: 'Credit/Debit Notes',    icon: FileText,        group: 'books',  hint: 'Issue CN/DN to adjust invoices' },
  // ── Reports ──
  { id: 'pl',                  label: 'Profit & Loss',         icon: Wallet,          group: 'reports' },
  { id: 'bs',                  label: 'Balance Sheet',         icon: Scale,           group: 'reports' },
  { id: 'trial',               label: 'Trial Balance',         icon: ClipboardCheck,  group: 'reports' },
  { id: 'audit',               label: 'Audit',                 icon: Scale,           group: 'reports', hint: 'Whole-book health check — findings, score & printable report' },
  { id: 'ageing',              label: 'Ageing Report',         icon: Clock,           group: 'reports', hint: '0-30-60-90 day outstanding' },
  { id: 'gst',                 label: 'GST Reports',           icon: Receipt,         group: 'reports', hint: 'GSTR-1, GSTR-2, HSN summary' },
  { id: 'tds',                 label: 'TDS Tracker',           icon: Receipt,         group: 'reports', hint: 'TDS deducted & deductible' },
  { id: 'ai_review',           label: 'AI Entries',            icon: Sparkles,        group: 'reports', hint: 'Entries created by the AI assistant — review with the original message (for CA/accountant)' },
  { id: 'ai_insights',         label: 'AI Insights',           icon: Sparkles,        group: 'reports', hint: 'Patterns the assistant is learning — audit health, weak spots, rule ideas (read-only)' },
  // ── Admin & Setup (accountant-level) ──
  { id: 'journal',             label: 'All Entries',           icon: BookOpen,        group: 'admin' },
  { id: 'approvals',           label: 'Approvals',             icon: ClipboardCheck,  group: 'admin', hint: 'Pending manager-created drafts' },
  { id: 'manual',              label: 'Manual Posting',        icon: PlusCircle,      group: 'admin' },
  { id: 'recurring',           label: 'Recurring Entries',     icon: CalendarSync,    group: 'admin', hint: 'Auto-post rent, salaries, EMIs' },
  { id: 'reconcile',           label: 'Bank Reconciliation',   icon: ClipboardCheck,  group: 'admin', hint: 'Match bank statement with journal entries' },
  { id: 'coa',                 label: 'Account Heads',         icon: Landmark,        group: 'admin' },
  { id: 'opening',             label: 'Opening Balances',      icon: CalendarSync,    group: 'admin' },
  { id: 'close',               label: 'Year Close',            icon: CalendarSync,    group: 'admin' },
];

const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];

const guessAccountType = (accountName, chartByName) => {
  if (chartByName[accountName]?.type) return chartByName[accountName].type;
  if (accountName.startsWith('Party:')) return 'Asset'; // Party accounts can be assets or liabilities
  if (accountName.startsWith('Accounts Receivable:')) return 'Asset';
  if (accountName.startsWith('Accounts Payable:')) return 'Liability';
  if (accountName.startsWith('Expense:')) return 'Expense';
  if (accountName.includes('Revenue')) return 'Income';
  if (accountName.includes('Expense') || accountName.includes('Purchase')) return 'Expense';
  if (accountName.includes('GST Payable')) return 'Liability';
  if (accountName.includes('GST Credit')) return 'Asset';
  if (accountName.includes('Cash') || accountName.includes('Bank')) return 'Asset';
  return 'Equity';
};

const Accounting = ({
  clients = [],
  projects = [],
  taxInvoices = [],
  purchaseInvoices = [],
  payments = [],
  vendorPayments = [],
  payouts = [],
  expenses = [],
  advances = [],
  employees = [],
  chartOfAccounts = [],
  manualJournalEntries = [],
  openingBalances = [],
  fiscalYearClosings = [],
  recurringRules = [],
  partyAccounts = [],   // M-5: stable party name registry
  db,
  appId,
  role,
  user,
  logAction,
  addToast,
  lockedFYs = [],
}) => {
  const [activeTab, setActiveTab] = useState('overview');
  const [aiReviewSearch, setAiReviewSearch] = useState('');
  const [aiReviewFilter, setAiReviewFilter] = useState('all'); // all | unreviewed | reviewed | flagged
  const [fyFilter, setFyFilter] = useState(() => getFYFromDate(new Date().toISOString().slice(0, 10)));
  const [selectedLedger, setSelectedLedger] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ isOpen: false, entry: null });
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);

  // Ctrl/Cmd+K → open the Virtual Accountant chat anywhere on the Accounting page.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setIsAssistantOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Parked (draft) journal entries from chat ───────────────────────────────
  const [journalDrafts, setJournalDrafts] = useState([]);
  const [editingDraft, setEditingDraft] = useState(null); // { id, date, narration, party_name, entries:[{debitAccount,creditAccount,amount}], schedule_post_on }
  const [selectedDraftIds, setSelectedDraftIds] = useState(new Set());
  const [bulkScheduleDate, setBulkScheduleDate] = useState('');
  const [journalTemplates, setJournalTemplates] = useState([]);
  const [templatePrompt, setTemplatePrompt] = useState(null); // { tpl, vars: [{name,type,default}], values: {name: ''} }
  const [editingTemplate, setEditingTemplate] = useState(null); // { id, name, narration, party_name, entries }
  const [templateCategoryFilter, setTemplateCategoryFilter] = useState('all');
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(new Set());
  const [bulkRecategorize, setBulkRecategorize] = useState('');
  const [recurringFromTpl, setRecurringFromTpl] = useState(null); // { tpl, frequency, interval, dayOfMonth, startDate, endDate, active }
  useEffect(() => {
    if (!db || !appId) return undefined;
    const unsub = onSnapshot(
      collection(db, 'artifacts', appId, 'public', 'data', 'journal_drafts'),
      (snap) => setJournalDrafts(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setJournalDrafts([]),
    );
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, [db, appId]);

  useEffect(() => {
    if (!db || !appId) return undefined;
    const unsub = onSnapshot(
      collection(db, 'artifacts', appId, 'public', 'data', 'journal_templates'),
      (snap) => setJournalTemplates(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setJournalTemplates([]),
    );
    return () => { try { unsub?.(); } catch { /* noop */ } };
  }, [db, appId]);

  const [coaForm, setCoaForm] = useState({
    code: '',
    name: '',
    type: 'Asset',
    subType: 'Current Asset',
    normalSide: 'Dr',
  });

  const [journalForm, setJournalForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    narration: '',
    debitAccount: '',
    creditAccount: '',
    amount: '',
    currency: 'INR',
    fx_rate_to_inr: 1,
  });

  const [openingForm, setOpeningForm] = useState({
    fy: '',
    date: new Date().toISOString().slice(0, 10),
    account_name: '',
    side: 'Dr',
    amount: '',
    remarks: '',
  });

  const piInitialForm = {
    invoice_date: new Date().toISOString().slice(0, 10),
    vendor_name: '',
    vendor_id: '',
    description: '',
    amount: '',
    gst_amount: '',
    purchase_mode: 'Credit',
    status: 'Pending',
    remarks: '',
  };
  const [piForm, setPiForm] = useState(piInitialForm);
  const [piEditingId, setPiEditingId] = useState(null);
  const [isPiModalOpen, setIsPiModalOpen] = useState(false);
  const [piDeleteModal, setPiDeleteModal] = useState({ isOpen: false, entry: null });

  const [cnDnEditingId, setCnDnEditingId] = useState(null);
  const [cnDnDeleteModal, setCnDnDeleteModal] = useState({ isOpen: false, entry: null });
  const [cnDnForm, setCnDnForm] = useState({
    type: 'credit_note',
    date: new Date().toISOString().slice(0, 10),
    party_name: '',
    original_invoice: '',
    taxable: '',
    gst: '',
    reason: '',
  });

  const [tdsForm, setTdsForm] = useState({
    type: 'tds_receivable',
    date: new Date().toISOString().slice(0, 10),
    party_name: '',
    section: '194J',
    rate: '10',
    base_amount: '',
    tds_amount: '',
    remarks: '',
  });

  const fyOptions = useMemo(() => {
    const set = new Set();
    taxInvoices.forEach((row) => row.invoice_date && set.add(getFYFromDate(row.invoice_date)));
    purchaseInvoices.forEach((row) => row.invoice_date && set.add(getFYFromDate(row.invoice_date)));
    payments.forEach((row) => row.date && set.add(getFYFromDate(row.date)));
    vendorPayments.forEach((row) => row.date && set.add(getFYFromDate(row.date)));
    payouts.forEach((row) => row.date && set.add(getFYFromDate(row.date)));
    expenses.forEach((row) => row.date && set.add(getFYFromDate(row.date)));
    advances.forEach((row) => row.date && set.add(getFYFromDate(row.date)));
    openingBalances.forEach((row) => row.fy && set.add(row.fy));
    manualJournalEntries.forEach((row) => row.fy && set.add(row.fy));
    fiscalYearClosings.forEach((row) => row.fy && set.add(row.fy));
    return ['all', ...Array.from(set).sort().reverse()];
  }, [taxInvoices, purchaseInvoices, payments, vendorPayments, payouts, expenses, advances, openingBalances, manualJournalEntries, fiscalYearClosings]);

  const snapshot = useMemo(
    () =>
      buildAccountingSnapshot({
        clients,
        projects,
        taxInvoices,
        purchaseInvoices,
        payments,
        vendorPayments,
        payouts,
        expenses,
        advances,
        employees,
        chartOfAccounts,
        openingBalances,
        manualJournalEntries,
        fiscalYearClosings,
        fyFilter,
        partyAccounts,  // M-5
      }),
    [
      clients,
      projects,
      taxInvoices,
      purchaseInvoices,
      payments,
      vendorPayments,
      payouts,
      expenses,
      advances,
      employees,
      chartOfAccounts,
      openingBalances,
      manualJournalEntries,
      fiscalYearClosings,
      fyFilter,
      partyAccounts,  // M-5
    ]
  );

  const chartByName = useMemo(
    () => chartOfAccounts.reduce((acc, item) => {
      acc[item.name] = item;
      return acc;
    }, {}),
    [chartOfAccounts]
  );

  const allAccounts = useMemo(() => {
    const set = new Set(chartOfAccounts.map((row) => row.name));
    snapshot.ledger.forEach((row) => set.add(row.account));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [chartOfAccounts, snapshot.ledger]);

  // Deactivated COA accounts (B4). Hidden from posting PICKERS when they carry
  // no balance; accounts with history stay listable (ledger views need them)
  // but the validator warns on new postings to them.
  const inactiveAccounts = useMemo(
    () => new Set(chartOfAccounts.filter((row) => row.isActive === false).map((row) => row.name)),
    [chartOfAccounts]
  );
  const pickerAccounts = useMemo(() => {
    if (!inactiveAccounts.size) return allAccounts;
    const balances = {};
    snapshot.ledger.forEach((row) => { balances[row.account] = row.balance || 0; });
    return allAccounts.filter((name) => !inactiveAccounts.has(name) || Math.abs(balances[name] || 0) > 0.005);
  }, [allAccounts, inactiveAccounts, snapshot.ledger]);

  // Attachments lookup keyed by voucher_no for quick per-row chip rendering.
  const attachmentsByVoucher = useMemo(() => {
    const m = {};
    (manualJournalEntries || []).forEach((e) => {
      if (Array.isArray(e.attachments) && e.attachments.length && e.voucher_no) {
        m[e.voucher_no] = e.attachments;
      }
    });
    return m;
  }, [manualJournalEntries]);
  const [attachmentsModal, setAttachmentsModal] = useState(null); // { voucher, attachments }

  const selectedLedgerRow = selectedLedger
    ? snapshot.ledger.find((row) => row.account === selectedLedger)
    : snapshot.ledger[0];

  const totals = {
    sales: snapshot.salesBook.reduce((sum, row) => sum + row.total, 0),
    nonInvoicedSales: (snapshot.nonInvoicedSalesBook || []).reduce((sum, row) => sum + row.total, 0),
    purchase: snapshot.purchaseBook.reduce((sum, row) => sum + row.total, 0),
    journal: snapshot.journal.reduce((sum, row) => sum + row.amount, 0),
  };

  const canEditFinance = can(role, 'finance', 'edit') || can(role, 'finance', 'create');

  // ── Ageing Analysis (FIFO-based) ──
  const ageingData = useMemo(() => {
    const today = new Date();
    // Age from the DUE date, not the posting date. Bucketing an invoice from the day
    // it was raised overstates overdue exposure for every party with credit terms
    // (a Net-45 invoice raised 40 days ago is not overdue at all). Resolution order:
    //   1. the invoice's own stored due_date (matched on refNo === invoice_no)
    //   2. posting date + the party's credit terms ("Net N" on the client)
    //   3. the posting date itself — i.e. exactly the previous behaviour
    // Bucket KEYS are unchanged (0_30/31_60/61_90/90_plus) so every downstream
    // consumer — the stacked bars, the Excel export, booksAudit — is untouched.
    const dueByRef = new Map();
    (taxInvoices || []).forEach((inv) => {
      if (inv && inv.invoice_no && inv.due_date && inv.status !== 'Cancelled') dueByRef.set(String(inv.invoice_no), inv.due_date);
    });
    const parseTermDays = (terms) => {
      const m = /(\d+)/.exec(String(terms || ''));
      const n = m ? parseInt(m[1], 10) : NaN;
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const termsByParty = new Map();
    (clients || []).forEach((c) => {
      if (!c || !c.name) return;
      const t = parseTermDays(c.billing_terms);
      if (t != null) termsByParty.set(`Party: ${c.name}`, t);
    });
    // Effective due date for one ledger entry. Falls back to the posting date, so an
    // entry we cannot resolve ages exactly as it does today (never later, so overdue
    // is never silently understated).
    const dueDateOf = (entry, partyAccount) => {
      const ref = entry.refNo != null ? String(entry.refNo) : '';
      const explicit = ref && dueByRef.get(ref);
      if (explicit) return explicit;
      const terms = termsByParty.get(partyAccount);
      if (entry.date && terms != null) {
        const d = new Date(entry.date);
        if (!isNaN(d.getTime())) { d.setDate(d.getDate() + terms); return d.toISOString().slice(0, 10); }
      }
      return entry.date;
    };

    const receivableRows = [];
    const payableRows = [];
    snapshot.ledger
      .filter(r => r.account.startsWith('Party:'))
      .forEach(ledgerRow => {
        const entries = [...(ledgerRow.entries || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const debits = entries.filter(e => e.side === 'Dr').map(e => ({ date: dueDateOf(e, ledgerRow.account), remaining: e.amount }));
        const credits = entries.filter(e => e.side === 'Cr').map(e => ({ date: dueDateOf(e, ledgerRow.account), remaining: e.amount }));
        credits.forEach(cr => {
          let toMatch = cr.remaining;
          for (const dr of debits) {
            if (toMatch <= 0.005) break;
            const m = Math.min(dr.remaining, toMatch);
            dr.remaining -= m;
            toMatch -= m;
          }
          cr.remaining = toMatch;
        });
        const bucket = (date) => {
          const days = Math.max(0, Math.floor((today - new Date(date)) / 86400000));
          if (days <= 30) return '0_30';
          if (days <= 60) return '31_60';
          if (days <= 90) return '61_90';
          return '90_plus';
        };
        const recB = { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0 };
        debits.filter(d => d.remaining > 0.01).forEach(d => { recB[bucket(d.date)] += d.remaining; recB.total += d.remaining; });
        if (recB.total > 0.01) receivableRows.push({ account: ledgerRow.account, name: ledgerRow.account.replace('Party: ', ''), ...recB });
        const payB = { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0 };
        credits.filter(c => c.remaining > 0.01).forEach(c => { payB[bucket(c.date)] += c.remaining; payB.total += c.remaining; });
        if (payB.total > 0.01) payableRows.push({ account: ledgerRow.account, name: ledgerRow.account.replace('Party: ', ''), ...payB });
      });
    const sumB = (rows) => rows.reduce((a, r) => ({ '0_30': a['0_30'] + r['0_30'], '31_60': a['31_60'] + r['31_60'], '61_90': a['61_90'] + r['61_90'], '90_plus': a['90_plus'] + r['90_plus'], total: a.total + r.total }), { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0 });
    return { receivable: receivableRows.sort((a, b) => b.total - a.total), payable: payableRows.sort((a, b) => b.total - a.total), receivableTotals: sumB(receivableRows), payableTotals: sumB(payableRows) };
  }, [snapshot.ledger, taxInvoices, clients]);

  // ── Export Reports to Excel / Tally ──
  const exportReport = (type) => exportReportImpl(type, { fyFilter, snapshot, ageingData, addToast });

  // Books-audit (Phase 2) — one shared computation for the chat command + Audit tab.
  const closedFYsList = useMemo(() => (fiscalYearClosings || []).filter((r) => r.status === 'closed').map((r) => r.fy), [fiscalYearClosings]);
  const booksAudit = useMemo(
    () => runBooksAudit(snapshot, { entries: manualJournalEntries, drafts: journalDrafts, ageing: ageingData, closedFYs: closedFYsList }),
    [snapshot, manualJournalEntries, journalDrafts, ageingData, closedFYsList]
  );

  // Close-readiness checklist + GST/TDS compliance calendar (Phase 4). Advisory
  // only — the terminal action remains the human-driven closeFinancialYear.
  const closeChecklist = useMemo(
    () => buildCloseChecklist({
      audit: booksAudit,
      drafts: journalDrafts,
      entries: manualJournalEntries,
      salesBook: snapshot.salesBook,
      // Sales months from the RAW (unfiltered) invoice list — an FY-scoped
      // salesBook would drop March's GSTR deadlines every April (B9).
      salesMonths: new Set((taxInvoices || []).map((r) => String(r.invoice_date || '').slice(0, 7)).filter(Boolean)),
      today: new Date().toISOString().slice(0, 10),
    }),
    [booksAudit, journalDrafts, manualJournalEntries, snapshot.salesBook, taxInvoices]
  );

  // Year-end depreciation proposal (Phase 5) — advisory; parked as a draft on
  // request. Prior posted/parked schedules feed the same-FY guard + WDV bases.
  const depreciationProposal = useMemo(
    () => (fyFilter !== 'all'
      ? proposeDepreciation({
          ledger: snapshot.ledger,
          fy: fyFilter,
          prior: collectPriorDepreciation({ entries: manualJournalEntries, drafts: journalDrafts }),
        })
      : null),
    [snapshot.ledger, fyFilter, manualJournalEntries, journalDrafts]
  );

  // Orchestrator verdict per parked draft (advisory chip — first live wiring of
  // the Phase-1 multi-agent orchestrator; nothing auto-posts).
  const draftAudits = useMemo(() => {
    if (!journalDrafts.length) return {};
    const octx = { knownAccounts: allAccounts, closedFYs: closedFYsList, getFY: getFYFromDate, recentJournalEntries: manualJournalEntries };
    const out = {};
    journalDrafts.forEach((d) => {
      const txn = {
        intent: d.intent || 'manual_journal',
        date: d.date,
        narration: d.narration || '',
        entries: d.entries || [],
        party: { type: d.party_type || 'unknown', name: d.party_name || '' },
        confidence: 1,
        issues: [],
      };
      try {
        const r = runOrchestrator({ text: d.raw_prompt || '', drafts: [txn], ctx: octx });
        const a = r.trace.audits[0];
        out[d.id] = {
          status: r.approved.length ? 'approved' : 'flagged',
          score: a?.auditScore ?? 0,
          top: ((a?.findings || []).find((f) => f.severity !== 'advisory') || (a?.findings || [])[0])?.message || '',
        };
      } catch { /* advisory only — never block the panel */ }
    });
    return out;
  }, [journalDrafts, allAccounts, closedFYsList, manualJournalEntries]);

  // ── Credit/Debit Note CRUD ──
  const cnDnInitialForm = { type: 'credit_note', date: new Date().toISOString().slice(0, 10), party_name: '', original_invoice: '', taxable: '', gst: '', reason: '' };

  const editCreditDebitNote = (row) => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    if (!assertFYNotLocked(row.date, lockedFYs)) return;
    // Reverse-engineer form fields from journal entries.
    const isCN = row.source === 'credit_note';
    const taxableLine = (row.entries || []).find((e) => isCN ? e.debitAccount === 'Sales Revenue' : e.creditAccount === 'Purchase Expense');
    const gstLine = (row.entries || []).find((e) => isCN ? e.debitAccount === 'Output GST Payable' : e.creditAccount === 'Input GST Credit');
    // Extract original_invoice + reason from narration: `Credit Note: <reason> | Ref: <inv> | Party: <name>`
    const narration = row.narration || '';
    const reasonMatch = narration.match(/^(?:Credit|Debit) Note:\s*([^|]*?)\s*\|/);
    const refMatch = narration.match(/Ref:\s*([^|]*?)\s*\|/);
    const partyMatch = narration.match(/Party:\s*(.*)$/);
    setCnDnEditingId(row.id);
    setCnDnForm({
      type: row.source,
      date: row.date || '',
      party_name: (partyMatch?.[1] || '').trim(),
      original_invoice: (refMatch?.[1] || '').trim() === 'N/A' ? '' : (refMatch?.[1] || '').trim(),
      taxable: taxableLine ? String(taxableLine.amount) : '',
      gst: gstLine ? String(gstLine.amount) : '',
      reason: (reasonMatch?.[1] || '').trim(),
    });
  };

  const cancelCreditDebitNoteEdit = () => {
    setCnDnEditingId(null);
    setCnDnForm(cnDnInitialForm);
  };

  const saveCreditDebitNote = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    const taxable = parseFloat(cnDnForm.taxable || 0);
    const gst = parseFloat(cnDnForm.gst || 0);
    const total = taxable + gst;
    if (!cnDnForm.date || !cnDnForm.party_name || total <= 0) return addToast('Date, party and amount are required.', 'error');
    if (!assertFYNotLocked(cnDnForm.date, lockedFYs)) return;
    try {
      setIsSaving(true);
      const partyAccount = `Party: ${cnDnForm.party_name}`;
      const isCN = cnDnForm.type === 'credit_note';
      const entries = [];
      if (isCN) {
        if (taxable > 0) entries.push({ debitAccount: 'Sales Revenue', creditAccount: partyAccount, amount: taxable });
        if (gst > 0) entries.push({ debitAccount: 'Output GST Payable', creditAccount: partyAccount, amount: gst });
      } else {
        if (taxable > 0) entries.push({ debitAccount: partyAccount, creditAccount: 'Purchase Expense', amount: taxable });
        if (gst > 0) entries.push({ debitAccount: partyAccount, creditAccount: 'Input GST Credit', amount: gst });
      }
      const narration = `${isCN ? 'Credit Note' : 'Debit Note'}: ${cnDnForm.reason || ''} | Ref: ${cnDnForm.original_invoice || 'N/A'} | Party: ${cnDnForm.party_name}`;

      // One validated path (edit skips the duplicate check — it would match itself).
      const check = validateManualEntry(isCN ? 'credit_note' : 'debit_note', cnDnForm.date, narration, entries, { partyName: cnDnForm.party_name, includeRecent: !cnDnEditingId });
      if (check.errors.length) { setIsSaving(false); return addToast(`Blocked: ${check.errors[0].message}`, 'error'); }
      if (check.warnings.length) addToast(check.warnings.map((w) => w.message).join(' · '), 'info');

      if (cnDnEditingId) {
        const existing = manualJournalEntries.find((r) => r.id === cnDnEditingId);
        // If the original posting date is in a now-locked FY, block.
        if (existing && !assertFYNotLocked(existing.date, lockedFYs)) { setIsSaving(false); return; }
        const updatePayload = {
          fy: getFYFromDate(cnDnForm.date),
          date: cnDnForm.date,
          narration,
          source: isCN ? 'credit_note' : 'debit_note',
          entries,
          updated_by: user?.uid || '',
          updated_at: new Date().toISOString(),
        };
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', cnDnEditingId), updatePayload);
        logAction('journal_entries', 'update', cnDnEditingId, updatePayload, `${isCN ? 'CN' : 'DN'} ${existing?.voucher_no || ''}`);
        addToast(`${isCN ? 'Credit Note' : 'Debit Note'} updated`, 'success');
      } else {
        const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr: cnDnForm.date });
        const payload = { voucher_no: voucherNo, fy: getFYFromDate(cnDnForm.date), date: cnDnForm.date, narration, source: isCN ? 'credit_note' : 'debit_note', status: 'posted', entries, created_by: user?.uid || '', created_at: new Date().toISOString() };
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
        logAction('journal_entries', 'create', ref.id, payload, `${isCN ? 'CN' : 'DN'} ${voucherNo}`);
        addToast(`${isCN ? 'Credit Note' : 'Debit Note'} posted`, 'success');
      }
      setCnDnEditingId(null);
      setCnDnForm(cnDnInitialForm);
    } catch (err) { console.error(err); addToast('Failed to save note: ' + err.message, 'error'); }
    setIsSaving(false);
  };

  const deleteCreditDebitNote = async (row) => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    if (!row?.id) return;
    if (!assertFYNotLocked(row.date, lockedFYs)) return;
    try {
      setIsSaving(true);
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', row.id));
      logAction('journal_entries', 'delete', row.id, null, `${row.source === 'credit_note' ? 'CN' : 'DN'} ${row.voucher_no || ''}`);
      addToast(`${row.source === 'credit_note' ? 'Credit Note' : 'Debit Note'} deleted`, 'success');
      setCnDnDeleteModal({ isOpen: false, entry: null });
      if (cnDnEditingId === row.id) {
        setCnDnEditingId(null);
        setCnDnForm(cnDnInitialForm);
      }
    } catch (err) { console.error(err); addToast('Delete failed: ' + err.message, 'error'); }
    setIsSaving(false);
  };

  // ── TDS Entry Save ──
  const saveTdsEntry = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    const tdsAmt = parseFloat(tdsForm.tds_amount || 0);
    if (!tdsForm.date || !tdsForm.party_name || tdsAmt <= 0) return addToast('Date, party and TDS amount are required.', 'error');
    if (!assertFYNotLocked(tdsForm.date, lockedFYs)) return;
    try {
      setIsSaving(true);
      const partyAccount = `Party: ${tdsForm.party_name}`;
      const isRec = tdsForm.type === 'tds_receivable';
      const entries = isRec
        ? [{ debitAccount: 'TDS Receivable', creditAccount: partyAccount, amount: tdsAmt }]
        : [{ debitAccount: partyAccount, creditAccount: 'TDS Payable', amount: tdsAmt }];
      // One validated path — checked BEFORE a voucher number is consumed.
      const check = validateManualEntry('tds', tdsForm.date, `TDS u/s ${tdsForm.section}`, entries, { partyName: tdsForm.party_name });
      if (check.errors.length) { setIsSaving(false); return addToast(`Blocked: ${check.errors[0].message}`, 'error'); }
      if (check.warnings.length) addToast(check.warnings.map((w) => w.message).join(' · '), 'info');
      const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr: tdsForm.date });
      const payload = { voucher_no: voucherNo, fy: getFYFromDate(tdsForm.date), date: tdsForm.date, narration: `TDS u/s ${tdsForm.section} @ ${tdsForm.rate}% | ${isRec ? 'Deducted by' : 'Deducted on'} ${tdsForm.party_name} | Base: ${formatCurrency(parseFloat(tdsForm.base_amount || 0))} | ${tdsForm.remarks || ''}`, source: 'tds_entry', status: 'posted', entries, created_by: user?.uid || '', created_at: new Date().toISOString() };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
      logAction('journal_entries', 'create', ref.id, payload, `TDS ${voucherNo}`);
      setTdsForm({ type: 'tds_receivable', date: new Date().toISOString().slice(0, 10), party_name: '', section: '194J', rate: '10', base_amount: '', tds_amount: '', remarks: '' });
      addToast('TDS entry posted', 'success');
    } catch (err) { console.error(err); addToast('Failed to post TDS entry', 'error'); }
    setIsSaving(false);
  };

  // ── Drill-down: click party name → open ledger ──
  const drillToLedger = (account) => { setSelectedLedger(account); setActiveTab('ledger'); };

  // ── One validated posting path (Phase 5) ──
  // Every manual form runs the SAME validator the AI chat and bank-reco use.
  // Errors block the post; warnings are surfaced but don't stop a deliberate
  // human action. `includeRecent:false` on edits (the entry would match itself
  // in the duplicate check).
  const validateManualEntry = (intent, date, narration, entries, { partyName = '', includeRecent = true } = {}) => {
    const validated = validateTransaction(
      { intent, date, narration, entries, party: { type: 'unknown', name: partyName } },
      {
        knownAccounts: allAccounts,
        inactiveAccounts,
        closedFYs: closedFYsList,
        getFY: getFYFromDate,
        recentJournalEntries: includeRecent ? manualJournalEntries : [],
      }
    );
    const errors = (validated.issues || []).filter((i) => i.level === 'error');
    const warnings = (validated.issues || []).filter((i) => i.level === 'warning');
    return { errors, warnings, postable: canPost(validated) };
  };

  // Real party balances for the "Money In / Out" overview cards.
  // Includes EVERY journal posting that hits a party account — invoiced sales,
  // non-invoiced sales accruals, purchase invoices, vendor allocations,
  // payments received/made, expenses, advances, manual journals, FY rollovers,
  // any other source. Single party account per stable entityId (M-5), so an
  // entity that is BOTH vendor and customer auto-nets: outsourcing payable
  // offsets work-done receivable. Final sign decides receivable vs payable.
  const realPartyBalances = useMemo(
    () => (snapshot.ledger || []).filter((r) => r.account.startsWith('Party:')),
    [snapshot.ledger]
  );

  const realReceivableTotal = useMemo(
    () => realPartyBalances.filter((r) => r.balance > 0.01).reduce((s, r) => s + r.balance, 0),
    [realPartyBalances]
  );
  const realPayableTotal = useMemo(
    () => realPartyBalances.filter((r) => r.balance < -0.01).reduce((s, r) => s + Math.abs(r.balance), 0),
    [realPartyBalances]
  );

  // ── GST Reports Data ──
  const [orgGstin, setOrgGstin] = useState('');
  const [orgName, setOrgName] = useState('');
  const [gstSubTab, setGstSubTab] = useState('gstr1');
  // AI escalation flag for the chat (non-secret mirror doc; the API key itself
  // lives in settings/ai which no client can read).
  const [aiEnabled, setAiEnabled] = useState(false);

  // Fetch org GSTIN + AI-assist flag once
  React.useEffect(() => {
    const fetchOrg = async () => {
      try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (snap.exists()) { setOrgGstin(snap.data().gstin || ''); setOrgName(snap.data().name || snap.data().org_name || ''); }
      } catch { /* ignore */ }
      try {
        const aiSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'ai_public'));
        if (aiSnap.exists()) setAiEnabled(aiSnap.data().enabled === true);
      } catch { /* ignore */ }
    };
    fetchOrg();
  }, [db, appId]);

  const gstData = useMemo(() => {
    const inFY = (dateStr) => {
      if (!dateStr) return false;
      if (fyFilter === 'all') return true;
      return getFYFromDate(dateStr) === fyFilter;
    };
    const clientById = {};
    clients.forEach((c) => { clientById[c.id] = c; });

    // ── GSTR-1: Outward supplies (sales) ──
    const gstr1 = [];
    // From tax invoices ONLY (authoritative). Cancelled excluded; supply-type + the
    // CGST/SGST/IGST split are read from the STORED invoice — we do NOT re-derive
    // place-of-supply from live GSTINs (that flipped a B2C CGST+SGST supply to IGST).
    // No project-derived rows: a tax invoice already covers its project(s), so
    // re-adding "Project Invoice" rows double-counted output tax (~2x).
    taxInvoices
      .filter((inv) => inv.status !== 'Cancelled' && inFY(inv.invoice_date))
      .forEach((inv) => {
        const client = clientById[inv.client_id];
        const isIGST = (inv.supply_type || '') === 'IGST';
        const taxable = parseFloat(inv.taxable || 0);
        const gstAmt = parseFloat(inv.gst_amount || 0);
        const cgst = isIGST ? 0 : (inv.cgst_amount != null ? parseFloat(inv.cgst_amount) : gstAmt / 2);
        const sgst = isIGST ? 0 : (inv.sgst_amount != null ? parseFloat(inv.sgst_amount) : gstAmt / 2);
        const igst = isIGST ? (inv.igst_amount != null ? parseFloat(inv.igst_amount) : gstAmt) : 0;
        const posCode = ((inv.place_of_supply || '').toString().substring(0, 2))
          || ((inv.bill_to_gstin_at_issue || inv.sale_company_gstin || client?.gstin || '').substring(0, 2))
          || (orgGstin || '').substring(0, 2);
        gstr1.push({
          date: inv.invoice_date,
          invoiceNo: inv.invoice_no,
          clientName: inv.sale_company_name || inv.client_name || client?.name || '',
          clientGstin: inv.bill_to_gstin_at_issue || inv.sale_company_gstin || client?.gstin || '',
          placeOfSupply: posCode,
          supplyType: isIGST ? 'Inter-State' : 'Intra-State',
          taxable,
          cgst, sgst, igst,
          total: parseFloat(inv.final_amount || inv.computed_total || (taxable + gstAmt)),
          gst_breakup: Array.isArray(inv.gst_breakup) && inv.gst_breakup.length ? inv.gst_breakup : null,
          source: 'Tax Invoice',
        });
      });
    gstr1.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // ── GSTR-2: Inward supplies (purchases) ──
    const gstr2 = purchaseInvoices
      .filter(pi => pi.status !== 'Rejected' && pi.status !== 'Cancelled' && inFY(pi.invoice_date))
      .map((pi) => {
        const vendor = clientById[pi.vendor_id];
        const vendorGstin = pi.vendor_company_gstin || vendor?.gstin || '';
        const taxable = parseFloat(pi.amount || 0);
        const gstAmt = parseFloat(pi.gst_amount || 0);
        // Prefer the STORED supply_type (as booked) over re-deriving from live state codes.
        const isIntra = pi.supply_type
          ? pi.supply_type !== 'IGST'
          : (() => { const os = (orgGstin || '').substring(0, 2); const vs = (vendorGstin || '').substring(0, 2); return !!(os && vs && os === vs); })();
        const cgst = isIntra ? (pi.cgst_amount != null ? parseFloat(pi.cgst_amount) : gstAmt / 2) : 0;
        const sgst = isIntra ? (pi.sgst_amount != null ? parseFloat(pi.sgst_amount) : gstAmt / 2) : 0;
        const igst = isIntra ? 0 : (pi.igst_amount != null ? parseFloat(pi.igst_amount) : gstAmt);
        return {
          date: pi.invoice_date,
          piNo: pi.pi_no,
          invoiceRef: pi.invoice_ref || '',
          vendorName: pi.vendor_name || vendor?.name || '',
          vendorGstin,
          type: pi.type || 'Service',
          placeOfSupply: (vendorGstin || '').substring(0, 2) || (orgGstin || '').substring(0, 2),
          supplyType: isIntra ? 'Intra-State' : 'Inter-State',
          taxable,
          cgst, sgst, igst,
          total: taxable + gstAmt,
        };
      })
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // ── GSTR-3B Summary ──
    const totalOutputCgst = gstr1.reduce((s, r) => s + r.cgst, 0);
    const totalOutputSgst = gstr1.reduce((s, r) => s + r.sgst, 0);
    const totalOutputIgst = gstr1.reduce((s, r) => s + r.igst, 0);
    const totalInputCgst = gstr2.reduce((s, r) => s + r.cgst, 0);
    const totalInputSgst = gstr2.reduce((s, r) => s + r.sgst, 0);
    const totalInputIgst = gstr2.reduce((s, r) => s + r.igst, 0);

    // Credit notes (to clients) reduce OUTPUT tax; debit notes (to vendors) reverse
    // ITC (reduce INPUT tax). Extract taxable + GST from the posted journal legs and
    // net them into GSTR-3B so net payable isn't overstated. Split is best-effort from
    // the party's GSTIN (notes carry no stored supply_type). A full per-note CDNR
    // table + portal-JSON section is a compliance-feature follow-up.
    const noteAdj = { outCgst: 0, outSgst: 0, outIgst: 0, outTaxable: 0, inCgst: 0, inSgst: 0, inIgst: 0, inTaxable: 0 };
    (manualJournalEntries || [])
      .filter((r) => (r.source === 'credit_note' || r.source === 'debit_note') && inFY(r.date))
      .forEach((r) => {
        const isCN = r.source === 'credit_note';
        const legs = Array.isArray(r.entries) ? r.entries : [];
        const gstAmt = legs.filter((e) => (isCN ? e.debitAccount === 'Output GST Payable' : e.creditAccount === 'Input GST Credit')).reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const taxable = legs.filter((e) => (isCN ? e.debitAccount === 'Sales Revenue' : e.creditAccount === 'Purchase Expense')).reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const partyAcc = legs.map((e) => e.debitAccount).concat(legs.map((e) => e.creditAccount)).find((a) => a && a.startsWith('Party: '));
        const party = clientById[Object.keys(clientById).find((id) => clientById[id]?.name === (partyAcc || '').replace('Party: ', ''))];
        const os = (orgGstin || '').substring(0, 2);
        const ps = (party?.gstin || '').substring(0, 2);
        const isIntra = !!(os && ps && os === ps);
        if (isCN) {
          noteAdj.outTaxable += taxable;
          if (isIntra) { noteAdj.outCgst += gstAmt / 2; noteAdj.outSgst += gstAmt / 2; } else { noteAdj.outIgst += gstAmt; }
        } else {
          noteAdj.inTaxable += taxable;
          if (isIntra) { noteAdj.inCgst += gstAmt / 2; noteAdj.inSgst += gstAmt / 2; } else { noteAdj.inIgst += gstAmt; }
        }
      });
    const netOutCgst = totalOutputCgst - noteAdj.outCgst;
    const netOutSgst = totalOutputSgst - noteAdj.outSgst;
    const netOutIgst = totalOutputIgst - noteAdj.outIgst;
    const netInCgst = totalInputCgst - noteAdj.inCgst;
    const netInSgst = totalInputSgst - noteAdj.inSgst;
    const netInIgst = totalInputIgst - noteAdj.inIgst;
    const gstr3b = {
      outputTaxable: gstr1.reduce((s, r) => s + r.taxable, 0) - noteAdj.outTaxable,
      outputCgst: netOutCgst,
      outputSgst: netOutSgst,
      outputIgst: netOutIgst,
      outputTotal: netOutCgst + netOutSgst + netOutIgst,
      inputTaxable: gstr2.reduce((s, r) => s + r.taxable, 0) - noteAdj.inTaxable,
      inputCgst: netInCgst,
      inputSgst: netInSgst,
      inputIgst: netInIgst,
      inputTotal: netInCgst + netInSgst + netInIgst,
      netCgst: netOutCgst - netInCgst,
      netSgst: netOutSgst - netInSgst,
      netIgst: netOutIgst - netInIgst,
      netPayable: (netOutCgst + netOutSgst + netOutIgst) - (netInCgst + netInSgst + netInIgst),
    };

    // ── HSN Summary ──
    const hsnMap = {};
    // Sales HSN — iterate the invoice's project_ids (array); the old code read the
    // singular inv.project_id, which modern invoices never set → the HSN sales table
    // was always blank. Cancelled excluded.
    taxInvoices.filter(inv => inv.status !== 'Cancelled' && inFY(inv.invoice_date)).forEach((inv) => {
      const ids = Array.isArray(inv.project_ids) ? inv.project_ids : (inv.project_id ? [inv.project_id] : []);
      ids.forEach((pid) => {
        const proj = projects.find(p => p.id === pid);
        if (!proj) return;
        const client = clientById[proj.client_id];
        const bd = getProjectGSTBreakdown(proj, orgGstin, client?.gstin || '');
        bd.items.forEach(item => {
          const rate = item.gstRate ?? 18;
          const key = `${item.hsn || '998599'}_${rate}`;
          if (!hsnMap[key]) hsnMap[key] = { hsn: item.hsn || '998599', gstRate: rate, salesTaxable: 0, salesGst: 0, purchaseTaxable: 0, purchaseGst: 0 };
          hsnMap[key].salesTaxable += item.taxable;
          hsnMap[key].salesGst += (item.cgstAmt + item.sgstAmt + item.igstAmt);
        });
      });
    });
    // Purchase HSN (default SAC 998599 for services, 998431 for assets); bucket by the
    // PI's ACTUAL rate rather than a hardcoded 18% so 0/5/12/28% purchases file correctly.
    gstr2.forEach(pi => {
      const hsn = pi.type === 'Asset' ? '998431' : '998599';
      const rate = pi.taxable > 0 ? Math.round(((pi.cgst + pi.sgst + pi.igst) / pi.taxable) * 100) : 0;
      const key = `${hsn}_${rate}`;
      if (!hsnMap[key]) hsnMap[key] = { hsn, gstRate: rate, salesTaxable: 0, salesGst: 0, purchaseTaxable: 0, purchaseGst: 0 };
      hsnMap[key].purchaseTaxable += pi.taxable;
      hsnMap[key].purchaseGst += (pi.cgst + pi.sgst + pi.igst);
    });
    const hsnSummary = Object.values(hsnMap).sort((a, b) => a.hsn.localeCompare(b.hsn));

    return { gstr1, gstr2, gstr3b, hsnSummary };
  }, [taxInvoices, purchaseInvoices, projects, clients, fyFilter, orgGstin, manualJournalEntries]);

  // ── Excel Export ──
  const exportGstToExcel = (reportType) => exportGstToExcelImpl(reportType, { fyFilter, gstData, addToast });

  // GSTR-1 / GSTR-3B JSON export — best-effort GSTN-spec JSON for portal upload.
  const exportGstrJson = (kind) => exportGstrJsonImpl(kind, { fyFilter, gstData, orgGstin, addToast });

  const addAccount = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    if (!coaForm.code || !coaForm.name) return addToast('Code and name are required.', 'error');

    try {
      setIsSaving(true);
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'chart_of_accounts'), {
        ...coaForm,
        isActive: true,
        isSystem: false,
        created_by: user?.uid || '',
        created_at: new Date().toISOString(),
      });
      logAction('chart_of_accounts', 'create', '', coaForm, `COA add ${coaForm.name}`);
      setCoaForm({ code: '', name: '', type: 'Asset', subType: 'Current Asset', normalSide: 'Dr' });
      addToast('Account added', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to add account', 'error');
    }
    setIsSaving(false);
  };

  // ── COA management (Phase 5): deactivate/reactivate + classification edit.
  // The NAME stays immutable — the derived ledger groups non-party accounts by
  // name, so renaming would orphan history.
  const [coaEditId, setCoaEditId] = useState(null);
  const [coaEditForm, setCoaEditForm] = useState({ type: 'Asset', subType: '', normalSide: 'Dr' });
  const toggleCoaActive = async (row) => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    if (!row.id && !row.code) return;
    const nowActive = row.isActive === false; // toggling
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'chart_of_accounts', row.id || row.code), {
        isActive: nowActive, updated_by: user?.uid || '', updated_at: new Date().toISOString(),
      });
      logAction('chart_of_accounts', 'update', row.id || row.code, { isActive: nowActive }, `${nowActive ? 'Reactivated' : 'Deactivated'} account ${row.name}`);
      addToast(`${row.name} ${nowActive ? 'reactivated' : 'deactivated'}`, 'success');
    } catch (err) { console.error(err); addToast('Failed to update account', 'error'); }
  };
  const saveCoaEdit = async (row) => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'chart_of_accounts', row.id || row.code), {
        type: coaEditForm.type, subType: coaEditForm.subType, normalSide: coaEditForm.normalSide,
        updated_by: user?.uid || '', updated_at: new Date().toISOString(),
      });
      logAction('chart_of_accounts', 'update', row.id || row.code, coaEditForm, `COA edit ${row.name}`);
      addToast(`${row.name} updated`, 'success');
      setCoaEditId(null);
    } catch (err) { console.error(err); addToast('Failed to update account', 'error'); }
  };

  const seedDefaultCoa = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    try {
      setIsSaving(true);
      const defaults = getDefaultChartOfAccounts();
      const batch = writeBatch(db);
      defaults.forEach((row) => {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'chart_of_accounts', row.code);
        batch.set(ref, {
          ...row,
          created_by: user?.uid || '',
          created_at: new Date().toISOString(),
        }, { merge: true });
      });
      await batch.commit();
      logAction('chart_of_accounts', 'seed', 'default', {}, 'Seeded default COA');
      addToast('Default COA seeded', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to seed default COA', 'error');
    }
    setIsSaving(false);
  };

  const postManualJournal = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    const amount = parseFloat(journalForm.amount || 0);
    if (!journalForm.date || !journalForm.debitAccount || !journalForm.creditAccount || amount <= 0) {
      return addToast('Date, debit, credit and valid amount are required.', 'error');
    }
    if (journalForm.debitAccount === journalForm.creditAccount) return addToast('Debit and credit account cannot be same.', 'error');
    if (!assertFYNotLocked(journalForm.date, lockedFYs)) return;

    // One validated path: same checks as the AI chat (closed FY, duplicates,
    // sign conventions, GST math…). Errors block; warnings inform.
    {
      const fxAmt = amount * (Number(journalForm.fx_rate_to_inr) || 1);
      const check = validateManualEntry('manual_journal', journalForm.date, journalForm.narration || '', [
        { debitAccount: journalForm.debitAccount, creditAccount: journalForm.creditAccount, amount: fxAmt },
      ]);
      if (check.errors.length) return addToast(`Blocked: ${check.errors[0].message}`, 'error');
      if (check.warnings.length) addToast(check.warnings.map((w) => w.message).join(' · '), 'info');
    }

    try {
      setIsSaving(true);
      const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr: journalForm.date });
      const fy = getFYFromDate(journalForm.date);
      const fxRate = Number(journalForm.fx_rate_to_inr) || 1;
      const currency = (journalForm.currency || 'INR').toUpperCase();
      const payload = {
        voucher_no: voucherNo,
        fy,
        date: journalForm.date,
        narration: journalForm.narration || '',
        source: 'manual_journal',
        status: 'posted',
        entries: [
          {
            debitAccount: journalForm.debitAccount,
            creditAccount: journalForm.creditAccount,
            amount: amount * fxRate, // store in INR for snapshot consistency
            original_amount: amount,
            currency,
          },
        ],
        currency,
        fx_rate_to_inr: fxRate,
        created_by: user?.uid || '',
        created_at: new Date().toISOString(),
      };

      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
      logAction('journal_entries', 'create', ref.id, payload, `Posted JV ${voucherNo}`);
      setJournalForm({
        date: new Date().toISOString().slice(0, 10),
        narration: '',
        debitAccount: '',
        creditAccount: '',
        amount: '',
        currency: 'INR',
        fx_rate_to_inr: 1,
      });
      addToast('Journal entry posted', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to post journal entry', 'error');
    }
    setIsSaving(false);
  };

  const addOpeningBalance = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    const amount = parseFloat(openingForm.amount || 0);
    if (!openingForm.fy || !openingForm.account_name || amount <= 0) {
      return addToast('FY, account and amount are required.', 'error');
    }

    try {
      setIsSaving(true);
      const payload = {
        ...openingForm,
        amount,
        created_by: user?.uid || '',
        created_at: new Date().toISOString(),
      };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'opening_balances'), payload);
      logAction('opening_balances', 'create', ref.id, payload, `Opening balance ${openingForm.account_name}`);
      setOpeningForm({
        fy: openingForm.fy,
        date: new Date().toISOString().slice(0, 10),
        account_name: '',
        side: 'Dr',
        amount: '',
        remarks: '',
      });
      addToast('Opening balance saved', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to save opening balance', 'error');
    }
    setIsSaving(false);
  };

  const handleDeleteJournalEntry = (entry) => {
    if (!canEditFinance) {
      addToast('Access denied. Only admin/manager can delete journal entries.', 'error');
      return;
    }
    // M-6 (widened): ANY posted voucher — manual, CN/DN, TDS, chat, reco — is
    // reversed, not deleted, to preserve the audit trail. Admin keeps a typed-
    // confirm hard delete for genuine mistakes (rules enforce admin-only anyway).
    if (entry?.status !== 'draft' && role !== 'admin') {
      addToast('Posted vouchers cannot be deleted. Use "Reverse" to issue a reversal voucher.', 'error');
      return;
    }
    setDeleteModal({ isOpen: true, entry });
  };

  const handleReverseJournalEntry = async (entry) => {
    if (!canEditFinance) {
      addToast('Access denied.', 'error');
      return;
    }
    if (!entry || !Array.isArray(entry.entries) || entry.entries.length === 0) {
      addToast('Nothing to reverse on this voucher.', 'error');
      return;
    }
    if (entry.reversed || entry.reversed_by) {
      addToast('This voucher has already been reversed.', 'info');
      return;
    }
    if (entry.source === 'fy_closing') {
      addToast('FY-closing vouchers cannot be reversed individually. Reopen the FY instead.', 'error');
      return;
    }
    const reversalDate = new Date().toISOString().slice(0, 10);
    const fy = getFYFromDate(reversalDate);
    if (!assertFYNotLocked(reversalDate, lockedFYs)) return;
    if (fiscalYearClosings.some((row) => row.fy === fy && row.status === 'closed')) {
      addToast(`Financial year ${fy} is closed.`, 'error');
      return;
    }

    try {
      setIsSaving(true);
      const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr: reversalDate });
      const reversedEntries = entry.entries.map((line) => ({
        debitAccount: line.creditAccount,
        creditAccount: line.debitAccount,
        amount: line.amount,
        original_amount: line.original_amount,
        currency: line.currency,
      }));
      const payload = {
        voucher_no: voucherNo,
        fy,
        date: reversalDate,
        narration: `Reversal of ${entry.voucher_no || entry.id}: ${entry.narration || ''}`.slice(0, 500),
        source: 'manual_journal_reversal',
        status: 'posted',
        entries: reversedEntries,
        currency: entry.currency || 'INR',
        fx_rate_to_inr: entry.fx_rate_to_inr || 1,
        is_reversal: true,
        reverses_voucher_id: entry.id,
        reverses_voucher_no: entry.voucher_no || '',
        created_by: user?.uid || '',
        created_at: new Date().toISOString(),
      };
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
      // Mark original as reversed so the UI hides the button + audit links the
      // pair. Writes BOTH flag families so the chat path sees it too (B6 fix).
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', entry.id), {
        reversed: true,
        reversed_by: voucherNo,
        reversed_by_voucher_id: ref.id,
        reversed_by_voucher_no: voucherNo,
        reversed_at: new Date().toISOString(),
      });
      logAction('journal_entries', 'reverse', ref.id, payload, `Reversed JV ${entry.voucher_no || entry.id} via ${voucherNo}`);
      addToast(`Reversal voucher ${voucherNo} posted`, 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to post reversal voucher', 'error');
    }
    setIsSaving(false);
  };

  const confirmDeleteJournalEntry = async () => {
    if (!deleteModal.entry) return;
    // C-2 / M-6 fix: prevent deletion of a JV in a locked FY — use reversal
    // voucher pattern instead.
    if (!assertFYNotLocked(deleteModal.entry?.date, lockedFYs)) return;

    try {
      setIsSaving(true);
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', deleteModal.entry.id));
      logAction(
        'journal_entries',
        'delete',
        deleteModal.entry.id,
        deleteModal.entry,
        `Deleted journal entry ${deleteModal.entry.voucher_no || deleteModal.entry.id}`
      );
      addToast('Journal entry deleted successfully', 'success');
      setDeleteModal({ isOpen: false, entry: null });
    } catch (err) {
      console.error(err);
      addToast('Failed to delete journal entry', 'error');
    }
    setIsSaving(false);
  };

  const handleApplyTemplate = (template) => {
    setJournalForm((prev) => ({
      ...prev,
      debitAccount: template.debitAccount || prev.debitAccount,
      creditAccount: template.creditAccount || prev.creditAccount,
      narration: template.narration || prev.narration,
    }));
    addToast('Template applied successfully', 'success');
  };

  const partyNames = useMemo(() => {
    const names = new Set();
    snapshot.ledger.filter(r => r.account.startsWith('Party: ')).forEach(r => names.add(r.account.replace('Party: ', '')));
    clients.forEach(c => c.name && names.add(c.name));
    return Array.from(names).sort();
  }, [snapshot.ledger, clients]);

  // Employee names for the assistant's reimbursement detection. Kept separate from
  // partyNames — an employee must never be grounded as a client/vendor party.
  const employeeNames = useMemo(
    () => Array.from(new Set((employees || []).map((e) => e && e.name).filter(Boolean))).sort(),
    [employees]
  );

  // Party-name → GSTIN map so the assistant can decide CGST/SGST vs IGST and
  // validate the counterparty's GSTIN (keyed by lowercased name).
  const partyGstins = useMemo(() => {
    const map = {};
    clients.forEach((c) => { if (c.name && c.gstin) map[c.name.toLowerCase()] = c.gstin; });
    return map;
  }, [clients]);

  // Live project names for fuzzy project resolution in the assistant.
  const projectNames = useMemo(
    () => projects.map((p) => p.project_name).filter(Boolean),
    [projects]
  );

  // ── AI Entries review ──────────────────────────────────────────────────────
  // Posted journal entries that were created by the AI assistant, surfaced with
  // the user's original message so an accountant/CA can review their impact.
  const isAiEntry = (e) => e?.origin === 'ai_chat' || e?.source === 'chat_entry' || e?.source === 'scheduled_post';

  const aiEntries = useMemo(() => {
    const q = aiReviewSearch.trim().toLowerCase();
    return (manualJournalEntries || [])
      .filter(isAiEntry)
      .filter((e) => fyFilter === 'all' || e.fy === fyFilter)
      .filter((e) => {
        if (aiReviewFilter === 'reviewed') return !!e.ai_reviewed;
        if (aiReviewFilter === 'unreviewed') return !e.ai_reviewed;
        if (aiReviewFilter === 'flagged') return (e.ai_issues || []).some((i) => i.level === 'warning' || i.level === 'error');
        return true;
      })
      .filter((e) => !q
        || (e.ai_prompt || '').toLowerCase().includes(q)
        || (e.narration || '').toLowerCase().includes(q)
        || (e.voucher_no || '').toLowerCase().includes(q)
        || (e.party_name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
  }, [manualJournalEntries, aiReviewSearch, aiReviewFilter, fyFilter]);

  const aiReviewedCount = useMemo(() => aiEntries.filter((e) => e.ai_reviewed).length, [aiEntries]);

  const toggleAiReviewed = async (entry) => {
    if (!canEditFinance) return addToast('Access denied: only finance roles can mark entries reviewed.', 'error');
    const now = new Date().toISOString();
    const next = !entry.ai_reviewed;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', entry.id), next
        ? { ai_reviewed: true, ai_reviewed_by: user?.uid || '', ai_reviewed_by_name: user?.email || user?.displayName || '', ai_reviewed_at: now }
        : { ai_reviewed: false, ai_reviewed_by: '', ai_reviewed_by_name: '', ai_reviewed_at: '' });
      logAction('journal_entries', next ? 'ai_review' : 'ai_unreview', entry.id, { voucher_no: entry.voucher_no }, entry.voucher_no);
      addToast(next ? `Marked ${entry.voucher_no} reviewed` : `Reopened ${entry.voucher_no}`, next ? 'success' : 'info');
    } catch (e) { console.error(e); addToast('Could not update review status', 'error'); }
  };

  const exportAiEntries = () => exportAiEntriesImpl({ aiEntries, addToast, fyFilter });

  // Shared posting path for AI-drafted entries: FY-lock guard, COA auto-create,
  // voucher numbering, party/project linkage, provenance. Used by the chat
  // (source 'chat_entry') and by bank reconciliation "book this row"
  // (source 'bank_reco'). Returns the new doc id + voucher number; the caller
  // owns the user-facing toast. This is the ONLY journal-write path for AI drafts.
  const postParsedEntry = async (parsed, { source = 'chat_entry', origin = 'ai_chat' } = {}) => {
    if (!canEditFinance) throw new Error('Access denied.');
    const dateStr = parsed?.date || new Date().toISOString().slice(0, 10);
    const fy = getFYFromDate(dateStr);

    // Respect FY lock even if the UI path missed it.
    const isClosed = fiscalYearClosings.some((row) => row.fy === fy && row.status === 'closed');
    if (isClosed) throw new Error(`Financial year ${fy} is closed.`);
    if (Array.isArray(lockedFYs) && lockedFYs.includes(fy)) throw new Error(`Financial year ${fy} is locked.`);

    // Auto-create any referenced accounts that don't exist yet in the COA.
    const existingNames = new Set(chartOfAccounts.map((a) => a.name));
    const toCreate = (parsed.accountCreates || []).filter((a) => a && a.name && !existingNames.has(a.name));
    if (toCreate.length) {
      await Promise.all(toCreate.map((a) =>
        addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'chart_of_accounts'), {
          code: '',
          name: a.name,
          type: a.type,
          subType: a.subType || '',
          normalSide: a.normalSide,
          auto_created: true,
          created_by_origin: origin,
          created_at: new Date().toISOString(),
        })
      ));
    }

    const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr });

    // Best-effort link to an existing client/vendor by name (metadata only; does
    // NOT write to payments/vendor_payments to avoid double-counting in ledger).
    let linkedPartyId = null;
    let linkedPartyType = null;
    const partyName = parsed?.party?.name || '';
    if (partyName) {
      const lc = partyName.toLowerCase();
      const hit = clients.find((c) => (c.name || '').toLowerCase() === lc)
        || clients.find((c) => (c.name || '').toLowerCase().startsWith(lc))
        || clients.find((c) => lc.startsWith((c.name || '').toLowerCase()) && (c.name || '').length > 2);
      if (hit) {
        linkedPartyId = hit.id;
        linkedPartyType = (hit.type || '').toLowerCase() === 'vendor' || hit.is_vendor ? 'vendor' : 'client';
      }
    }

    // Best-effort project linkage (tag like #P-123 or "project ABC").
    let linkedProjectId = null;
    let linkedProjectName = null;
    const projectTag = parsed?.meta?.projectTag;
    if (projectTag && Array.isArray(projects) && projects.length) {
      const tLower = projectTag.toLowerCase();
      const byCode = projects.find((p) => (p.code || p.project_code || '').toLowerCase() === tLower);
      const byName = !byCode && projects.find((p) => (p.name || '').toLowerCase() === tLower);
      const byPrefix = !byCode && !byName && projects.find((p) => (p.name || '').toLowerCase().startsWith(tLower.replace(/^p-/, '')));
      const hit = byCode || byName || byPrefix;
      if (hit) {
        linkedProjectId = hit.id;
        linkedProjectName = hit.name || null;
      }
    }

    const payload = {
      voucher_no: voucherNo,
      fy,
      date: dateStr,
      narration: parsed.narration || '',
      source,
      status: 'posted',
      entries: parsed.entries,
      // AI provenance / audit metadata
      origin,
      ai_intent: parsed.intent || parsed.type || null,
      ai_confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      ai_model: parsed.model || 'rule-v1',
      ai_prompt: parsed.rawPrompt || '',
      ai_issues: (parsed.issues || []).filter((i) => i.level !== 'error'),
      // Orchestrator/Audit-Agent decision trace (Phase 1). Persisted here on the
      // single AI write path so the Process-Analyst slice can later mine it.
      ai_decision_trace: {
        policy_version: POLICY_VERSION,
        audit: auditFromIssues(parsed),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        model_version: parsed.model || 'rule-v1',
        created_by_agent: 'orchestrator',
      },
      // Clarify correction ("typed name" → chosen party) — mined by
      // learnFromEntries so the same phrase resolves silently next time.
      ai_party_alias: parsed?.meta?.partyAlias || null,
      // Party linkage (for reconciliation views; NOT a side-effect write)
      party_name: partyName || null,
      party_type: parsed?.party?.type || null,
      linked_party_id: linkedPartyId,
      linked_party_type: linkedPartyType,
      // Project linkage
      project_tag: projectTag || null,
      linked_project_id: linkedProjectId,
      linked_project_name: linkedProjectName,
      // TDS section (192/194C/194J/194I/194H/194A…) for the monthly TDS summary
      tds_section: parsed?.meta?.tdsSection || null,
      // Full parsed meta (depreciation schedules, projections…) — consumed by
      // collectPriorDepreciation and future analysts. Additive, schemaless.
      ai_meta: parsed?.meta || null,
      attachments: parsed.attachments || [],
      created_by: user?.uid || '',
      created_at: new Date().toISOString(),
    };
    const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
    logAction('journal_entries', 'create', ref.id, payload, `${source === 'bank_reco' ? 'Bank reco' : 'Chat'} JV ${voucherNo}`);
    return { id: ref.id, voucher_no: voucherNo };
  };

  // Thin chat wrapper — preserves the exact prior behaviour (chat provenance +
  // "posted via chat" toast). The VirtualAccountant posts through this.
  const handleChatPostEntry = async (parsed) => {
    const { voucher_no } = await postParsedEntry(parsed, { source: 'chat_entry', origin: 'ai_chat' });
    addToast(`Entry ${voucher_no} posted via chat`, 'success');
  };

  // Book an unmatched bank statement row as a journal voucher (human-confirmed
  // in BankReconciliation). Returns { id, voucher_no } so the caller can stamp
  // the reconcile match. Distinct provenance from chat.
  const handleBookBankRow = async (parsed) => postParsedEntry(parsed, { source: 'bank_reco', origin: 'bank_reco' });

  // ── Parked (draft) entries ────────────────────────────────────────────────
  // Save a parsed chat entry to journal_drafts WITHOUT creating any COA
  // accounts or ledger postings. Posting happens later from the Drafts panel.
  const handleChatParkEntry = async (parsed) => {
    if (!canEditFinance) throw new Error('Access denied.');
    const dateStr = parsed?.date || new Date().toISOString().slice(0, 10);
    const requiresApproval = role === 'manager';
    const payload = {
      date: dateStr,
      narration: parsed.narration || '',
      entries: parsed.entries || [],
      party_name: parsed?.party?.name || null,
      party_type: parsed?.party?.type || null,
      intent: parsed.intent || parsed.type || null,
      account_creates: parsed.accountCreates || [],
      project_tag: parsed?.meta?.projectTag || null,
      raw_prompt: parsed.rawPrompt || '',
      ai_issues: parsed.issues || [],
      ai_party_alias: parsed?.meta?.partyAlias || null,
      ai_meta: parsed?.meta || null,
      source: 'chat_park',
      status: 'draft',
      requires_approval: requiresApproval,
      approval_status: requiresApproval ? 'pending' : 'approved',
      approved_by: null,
      approved_at: null,
      created_by: user?.uid || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const offline = typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
    try {
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_drafts'), payload);
      logAction('journal_drafts', 'create', ref.id, payload, `Parked draft: ${parsed.narration || parsed.intent || '—'}`);
      if (offline) {
        addToast('Offline — Firestore will sync when reconnected', 'info');
      } else {
        addToast(requiresApproval ? 'Entry parked — awaiting admin approval' : 'Entry parked as draft', 'success');
      }
    } catch (err) {
      // Firestore's offline queue usually absorbs failures. If addDoc
      // hard-rejects (quota, corrupt cache, rules while re-authenticating)
      // we fall back to our own IDB outbox and replay on reconnect.
      console.warn('[Accounting] addDoc failed, queuing to IDB outbox', err);
      await enqueueDraft(appId, 'journal_drafts', payload);
      await refreshQueueCount();
      addToast('Draft saved offline — will retry automatically', 'info');
    }
  };

  // Offline outbox state + flusher. Firestore already queues writes, but this
  // custom IDB outbox gives deterministic replay + a visible pending count
  // and catches hard-reject failures the SDK wouldn't retry.
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const refreshQueueCount = useCallback(async () => {
    try { setOfflineQueueCount(await queueSize(appId)); } catch { /* noop */ }
  }, [appId]);
  useEffect(() => { refreshQueueCount(); }, [refreshQueueCount]);
  useEffect(() => {
    if (!db || !appId) return undefined;
    const replay = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const result = await flushQueue(appId, async (collName, pl) => {
        await addDoc(collection(db, 'artifacts', appId, 'public', 'data', collName), pl);
      });
      if (result.flushed > 0) {
        addToast(`Synced ${result.flushed} queued draft${result.flushed === 1 ? '' : 's'}`, 'success');
      }
      await refreshQueueCount();
    };
    window.addEventListener('online', replay);
    replay();
    return () => window.removeEventListener('online', replay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, appId, refreshQueueCount]);

  // Reconstruct a "parsed" shape from a draft and hand it to the main post flow.
  const handlePostDraft = async (draft) => {
    if (!canEditFinance) return;
    if (draft.requires_approval && draft.approval_status !== 'approved' && role !== 'admin') {
      addToast('Draft is awaiting admin approval', 'error');
      return;
    }
    const parsed = {
      date: draft.date,
      narration: draft.narration,
      entries: draft.entries || [],
      party: { name: draft.party_name, type: draft.party_type },
      intent: draft.intent,
      accountCreates: draft.account_creates || [],
      meta: { ...(draft.ai_meta || {}), projectTag: draft.project_tag, partyAlias: draft.ai_party_alias || null },
      rawPrompt: draft.raw_prompt || '',
      issues: draft.ai_issues || [],
      attachments: draft.attachments || [],
    };
    try {
      await handleChatPostEntry(parsed);
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', draft.id));
      logAction('journal_drafts', 'delete', draft.id, {}, 'Draft posted');
    } catch (err) {
      console.error(err);
      addToast(`Failed to post draft: ${err.message}`, 'error');
    }
  };

  // Auto-post drafts whose schedule_post_on ≤ today. Fires on drafts list
  // change (incl. initial load). Sequential to avoid races.
  useEffect(() => {
    if (!canEditFinance || journalDrafts.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const due = journalDrafts.filter((d) => d.schedule_post_on && d.schedule_post_on <= today
      && !(d.requires_approval && d.approval_status !== 'approved'));
    if (due.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const d of due) {
        if (cancelled) return;
        try {
          await handlePostDraft(d);
          addToast(`Auto-posted scheduled draft: ${d.narration || d.party_name || '—'}`, 'success');
        } catch { /* already toasted */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalDrafts.length]);

  const handleDeleteDraft = async (draft) => {
    if (!canEditFinance) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', draft.id));
      logAction('journal_drafts', 'delete', draft.id, {}, `Discarded draft: ${draft.narration || '—'}`);
      addToast('Draft discarded', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to discard draft', 'error');
    }
  };

  // ── Approval workflow ─────────────────────────────────────────────────────
  const handleApproveDraft = async (draft) => {
    if (role !== 'admin') { addToast('Admin only', 'error'); return; }
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', draft.id), {
        approval_status: 'approved',
        approved_by: user?.uid || '',
        approved_at: new Date().toISOString(),
      });
      logAction('journal_drafts', 'approve', draft.id, {}, `Approved draft: ${draft.narration || '—'}`);
      addToast('Approved', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to approve: ' + err.message, 'error');
    }
  };
  const handleRejectDraft = async (draft) => {
    if (role !== 'admin') { addToast('Admin only', 'error'); return; }
    const reason = await promptDialog('Reason for rejection (optional)');
    if (reason === null) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', draft.id), {
        approval_status: 'rejected',
        approved_by: user?.uid || '',
        approved_at: new Date().toISOString(),
        rejection_reason: reason || '',
      });
      logAction('journal_drafts', 'reject', draft.id, { reason }, `Rejected draft: ${draft.narration || '—'}`);
      addToast('Rejected', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to reject: ' + err.message, 'error');
    }
  };
  const handleSaveDraftEdit = async () => {
    if (!canEditFinance || !editingDraft) return;
    const entries = (editingDraft.entries || []).map((e) => ({
      debitAccount: e.debitAccount || '',
      creditAccount: e.creditAccount || '',
      amount: Number(e.amount) || 0,
    }));
    // Basic validation: every line needs both accounts and a positive amount
    const bad = entries.findIndex((e) => !e.debitAccount || !e.creditAccount || e.amount <= 0);
    if (bad !== -1) { addToast(`Line ${bad + 1}: complete both accounts and a positive amount`, 'error'); return; }
    if (!editingDraft.date) { addToast('Date is required', 'error'); return; }

    const patch = {
      date: editingDraft.date,
      narration: editingDraft.narration || '',
      party_name: editingDraft.party_name || null,
      entries,
      schedule_post_on: editingDraft.schedule_post_on || null,
      attachments: editingDraft.attachments || [],
      updated_at: new Date().toISOString(),
    };
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', editingDraft.id), patch);
      logAction('journal_drafts', 'update', editingDraft.id, patch, `Edited draft: ${patch.narration || '—'}`);
      addToast('Draft updated', 'success');
      setEditingDraft(null);
    } catch (err) {
      console.error(err);
      addToast('Failed to update draft: ' + err.message, 'error');
    }
  };

  const addDraftLine = () => setEditingDraft((d) => d ? { ...d, entries: [...(d.entries || []), { debitAccount: '', creditAccount: '', amount: 0 }] } : d);
  const removeDraftLine = (idx) => setEditingDraft((d) => d ? { ...d, entries: d.entries.filter((_, i) => i !== idx) } : d);
  const updateDraftLine = (idx, field, value) => setEditingDraft((d) => d ? {
    ...d,
    entries: d.entries.map((e, i) => i === idx ? { ...e, [field]: value } : e),
  } : d);

  // ── Attachments (Firebase Storage) ────────────────────────────────────────
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const handleAttachFile = async (file) => {
    if (!file || !editingDraft || !canEditFinance) return;
    if (file.size > 10 * 1024 * 1024) { addToast('File exceeds 10 MB limit', 'error'); return; }
    setUploadingAttachment(true);
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `artifacts/${appId}/journal_drafts/${editingDraft.id}/${Date.now()}-${safe}`;
      const ref = storageRef(storage, path);
      await uploadBytes(ref, file, { contentType: file.type });
      const url = await getDownloadURL(ref);
      const meta = { name: file.name, path, url, size: file.size, type: file.type, uploadedAt: new Date().toISOString() };
      setEditingDraft((d) => d ? { ...d, attachments: [...(d.attachments || []), meta] } : d);
      addToast('File attached', 'success');
    } catch (err) {
      console.error(err);
      addToast('Upload failed: ' + err.message, 'error');
    } finally {
      setUploadingAttachment(false);
    }
  };
  const handleRemoveAttachment = async (att) => {
    if (!editingDraft) return;
    try {
      if (att.path) await deleteObject(storageRef(storage, att.path)).catch(() => {});
      setEditingDraft((d) => d ? { ...d, attachments: (d.attachments || []).filter((a) => a.path !== att.path) } : d);
    } catch (err) {
      console.error(err);
      addToast('Failed to remove attachment', 'error');
    }
  };

  // ── Bulk operations on drafts ─────────────────────────────────────────────
  const toggleDraftSelection = (id) => setSelectedDraftIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllDrafts = () => setSelectedDraftIds((prev) => (
    prev.size === journalDrafts.length ? new Set() : new Set(journalDrafts.map((d) => d.id))
  ));
  const handleBulkPostDrafts = async () => {
    if (!canEditFinance || selectedDraftIds.size === 0) return;
    if (!await confirmDialog(`Post ${selectedDraftIds.size} selected draft(s) to the ledger?`)) return;
    const selected = journalDrafts.filter((d) => selectedDraftIds.has(d.id));
    let ok = 0; let fail = 0;
    for (const d of selected) {
      try { await handlePostDraft(d); ok += 1; } catch { fail += 1; }
    }
    addToast(`Posted ${ok} draft(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    setSelectedDraftIds(new Set());
  };
  const handleBulkScheduleDrafts = async () => {
    if (!canEditFinance || selectedDraftIds.size === 0 || !bulkScheduleDate) return;
    let ok = 0; let fail = 0;
    for (const id of selectedDraftIds) {
      try {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', id), {
          schedule_post_on: bulkScheduleDate,
          updated_at: new Date().toISOString(),
        });
        ok += 1;
      } catch { fail += 1; }
    }
    logAction('journal_drafts', 'update', 'bulk', { ids: Array.from(selectedDraftIds), schedule_post_on: bulkScheduleDate }, `Bulk schedule ${ok}`);
    addToast(`Scheduled ${ok} draft(s) for ${bulkScheduleDate}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    setSelectedDraftIds(new Set());
    setBulkScheduleDate('');
  };
  const handleBulkDeleteDrafts = async () => {
    if (!canEditFinance || selectedDraftIds.size === 0) return;
    if (!await confirmDialog(`Discard ${selectedDraftIds.size} draft(s)? This cannot be undone.`)) return;
    let ok = 0; let fail = 0;
    for (const id of selectedDraftIds) {
      try {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_drafts', id));
        ok += 1;
      } catch { fail += 1; }
    }
    logAction('journal_drafts', 'delete', 'bulk', { ids: Array.from(selectedDraftIds) }, `Bulk discard ${ok}`);
    addToast(`Discarded ${ok} draft(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    setSelectedDraftIds(new Set());
  };

  // ── Templates ─────────────────────────────────────────────────────────────
  const handleSaveDraftAsTemplate = async (draft) => {
    if (!canEditFinance) return;
    const name = (await promptDialog('Template name?', draft.narration || draft.party_name || 'Template') || '').trim();
    if (!name) return;
    const varName = (await promptDialog(
      'Optional: variable name for the amount (leave blank to drop amounts).\n' +
      'Tip: also use {{var}} or {{var:default}} in narration / party.',
      'amount',
    ) || '').trim();
    const amountPlaceholder = varName ? `{{${varName}|amount}}` : 0;
    const payload = {
      name,
      narration: draft.narration || '',
      party_name: draft.party_name || null,
      // Capture structure (accounts) and either zeroed amounts or a {{var}} placeholder.
      entries: (draft.entries || []).map((e) => ({
        debitAccount: e.debitAccount || '',
        creditAccount: e.creditAccount || '',
        amount: amountPlaceholder,
      })),
      created_by: user?.uid || '',
      created_at: new Date().toISOString(),
      uses: 0,
    };
    try {
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_templates'), payload);
      logAction('journal_templates', 'create', ref.id, payload, `Template: ${name}`);
      addToast(`Saved template "${name}"`, 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to save template: ' + err.message, 'error');
    }
  };

  // Materialize a (possibly variable-bound) template into a new draft.
  const instantiateTemplate = async (tpl, values = {}) => {
    const today = new Date().toISOString().slice(0, 10);
    const expanded = applyVariables(
      {
        narration: tpl.narration || '',
        party_name: tpl.party_name || '',
        entries: (tpl.entries || []).map((e) => ({
          debitAccount: e.debitAccount || '',
          creditAccount: e.creditAccount || '',
          amount: e.amount,
        })),
      },
      values,
    );
    const payload = {
      date: today,
      narration: expanded.narration,
      entries: expanded.entries,
      party_name: expanded.party_name || null,
      party_type: null,
      intent: null,
      account_creates: [],
      project_tag: null,
      raw_prompt: '',
      ai_issues: [],
      source: 'template',
      template_id: tpl.id,
      template_name: tpl.name || '',
      template_values: values,
      status: 'draft',
      created_by: user?.uid || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_drafts'), payload);
    logAction('journal_drafts', 'create', ref.id, payload, `Draft from template: ${tpl.name}`);
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_templates', tpl.id), {
        uses: (tpl.uses || 0) + 1,
        last_used_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    addToast(`Created draft from "${tpl.name}"`, 'success');
    setEditingDraft({
      id: ref.id,
      date: today,
      narration: payload.narration,
      party_name: payload.party_name || '',
      entries: payload.entries,
      schedule_post_on: '',
    });
  };

  // Entry point: if template has user variables, prompt; else instantiate.
  const handleUseTemplate = async (tpl) => {
    if (!canEditFinance) return;
    const vars = extractVariables({
      narration: tpl.narration,
      party_name: tpl.party_name,
      entries: tpl.entries,
    });
    if (vars.length === 0) {
      try { await instantiateTemplate(tpl, {}); }
      catch (err) { console.error(err); addToast('Failed to apply template: ' + err.message, 'error'); }
      return;
    }
    const initial = {};
    vars.forEach((v) => { initial[v.name] = v.default || ''; });
    setTemplatePrompt({ tpl, vars, values: initial });
  };

  const handleConfirmTemplatePrompt = async () => {
    if (!templatePrompt) return;
    const { tpl, vars, values } = templatePrompt;
    // Coerce amount-typed fields to numbers; reject empties on required (no default).
    const clean = {};
    for (const v of vars) {
      const raw = values[v.name];
      if ((raw === '' || raw == null) && !v.default) {
        addToast(`Please provide a value for "${v.name}"`, 'error');
        return;
      }
      clean[v.name] = v.type === 'amount' ? Number(raw) || 0 : raw;
    }
    try {
      await instantiateTemplate(tpl, clean);
      setTemplatePrompt(null);
    } catch (err) {
      console.error(err);
      addToast('Failed to apply template: ' + err.message, 'error');
    }
  };

  const handleDeleteTemplate = async (tpl) => {
    if (!canEditFinance) return;
    if (!await confirmDialog(`Delete template "${tpl.name}"?`)) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_templates', tpl.id));
      logAction('journal_templates', 'delete', tpl.id, {}, `Deleted template: ${tpl.name}`);
      addToast('Template deleted', 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to delete template', 'error');
    }
  };

  // ── Import / Export templates ─────────────────────────────────────────────
  const handleExportTemplates = () => {
    const exportable = journalTemplates.map((t) => ({
      schema: 'rental-ops.journal_template/v1',
      name: t.name || '',
      category: t.category || null,
      narration: t.narration || '',
      party_name: t.party_name || null,
      entries: (t.entries || []).map((e) => ({
        debitAccount: e.debitAccount || '',
        creditAccount: e.creditAccount || '',
        amount: e.amount,
      })),
    }));
    const blob = new Blob([JSON.stringify({ schema: 'rental-ops.journal_templates/v1', exportedAt: new Date().toISOString(), templates: exportable }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `journal-templates-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    addToast(`Exported ${exportable.length} template(s)`, 'success');
  };

  const handleImportTemplates = async (e) => {
    if (!canEditFinance) return;
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-import of the same file
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (Array.isArray(data?.templates) ? data.templates : null);
      if (!list) { addToast('Invalid file: expected templates array', 'error'); return; }
      let ok = 0; let skipped = 0;
      for (const raw of list) {
        if (!raw || !raw.name || !Array.isArray(raw.entries)) { skipped += 1; continue; }
        const payload = {
          name: String(raw.name),
          category: raw.category || null,
          narration: raw.narration || '',
          party_name: raw.party_name || null,
          entries: raw.entries.map((it) => ({
            debitAccount: String(it.debitAccount || ''),
            creditAccount: String(it.creditAccount || ''),
            amount: typeof it.amount === 'string' ? it.amount : (Number(it.amount) || 0),
          })),
          uses: 0,
          created_by: user?.uid || '',
          created_at: new Date().toISOString(),
          imported: true,
        };
        try {
          await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_templates'), payload);
          ok += 1;
        } catch { skipped += 1; }
      }
      logAction('journal_templates', 'import', 'bulk', { ok, skipped }, `Imported ${ok} templates`);
      addToast(`Imported ${ok} template(s)${skipped ? `, ${skipped} skipped` : ''}`, skipped ? 'error' : 'success');
    } catch (err) {
      console.error(err);
      addToast('Failed to import: ' + err.message, 'error');
    }
  };

  // ── Template bulk operations ──────────────────────────────────────────────
  const toggleTemplateSelection = (id) => setSelectedTemplateIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearTemplateSelection = () => setSelectedTemplateIds(new Set());

  const handleBulkDeleteTemplates = async () => {
    if (!canEditFinance || selectedTemplateIds.size === 0) return;
    const n = selectedTemplateIds.size;
    // Destructive + irreversible — require explicit typed confirmation.
    const typed = await promptDialog(
      `You are about to DELETE ${n} template(s). This cannot be undone.\nType DELETE to confirm.`
    );
    if (typed !== 'DELETE') { addToast('Delete cancelled', 'info'); return; }
    // Capture names before deletion for the audit trail (post-hoc names
    // would be empty once docs are gone).
    const affected = journalTemplates
      .filter((t) => selectedTemplateIds.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, category: t.category || null }));
    let ok = 0; let fail = 0;
    for (const id of selectedTemplateIds) {
      try {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_templates', id));
        ok += 1;
      } catch { fail += 1; }
    }
    logAction(
      'journal_templates', 'bulk_delete', 'bulk',
      { ok, fail, affected },
      `Bulk deleted ${ok} template(s)`,
    );
    addToast(`Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    clearTemplateSelection();
  };

  const handleBulkRecategorize = async () => {
    if (!canEditFinance || selectedTemplateIds.size === 0) return;
    const cat = (bulkRecategorize || '').trim() || null;
    let ok = 0; let fail = 0;
    for (const id of selectedTemplateIds) {
      try {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_templates', id), {
          category: cat,
          updated_at: new Date().toISOString(),
        });
        ok += 1;
      } catch { fail += 1; }
    }
    logAction('journal_templates', 'bulk_recategorize', 'bulk', { ok, cat }, `Recategorized ${ok} → ${cat || '(uncategorized)'}`);
    addToast(`Updated ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    setBulkRecategorize('');
    clearTemplateSelection();
  };

  const handleBulkExportTemplates = () => {
    if (selectedTemplateIds.size === 0) return;
    const subset = journalTemplates.filter((t) => selectedTemplateIds.has(t.id));
    const exportable = subset.map((t) => ({
      schema: 'rental-ops.journal_template/v1',
      name: t.name || '',
      category: t.category || null,
      narration: t.narration || '',
      party_name: t.party_name || null,
      entries: (t.entries || []).map((e) => ({
        debitAccount: e.debitAccount || '',
        creditAccount: e.creditAccount || '',
        amount: e.amount,
      })),
    }));
    const blob = new Blob([JSON.stringify({ schema: 'rental-ops.journal_templates/v1', exportedAt: new Date().toISOString(), templates: exportable }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `journal-templates-selected-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    addToast(`Exported ${exportable.length} selected template(s)`, 'success');
  };

  // ── Recurring rule from template ──────────────────────────────────────────
  const handleSaveRecurringFromTemplate = async () => {
    if (!canEditFinance || !recurringFromTpl) return;
    const r = recurringFromTpl;
    if (!r.startDate) { addToast('Start date required', 'error'); return; }
    const payload = {
      name: r.tpl?.name ? `Recurring · ${r.tpl.name}` : 'Recurring template',
      active: r.active !== false,
      frequency: r.frequency || 'monthly',
      interval: Math.max(1, parseInt(r.interval || 1, 10)),
      dayOfMonth: r.dayOfMonth ? Math.max(1, Math.min(31, parseInt(r.dayOfMonth, 10))) : null,
      startDate: r.startDate,
      endDate: r.endDate || null,
      template_id: r.tpl?.id || null,
      created_by: user?.uid || '',
      created_at: new Date().toISOString(),
    };
    try {
      const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'recurring_rules'), payload);
      logAction('recurring_rules', 'create', ref.id, payload, `Recurring rule from template ${r.tpl?.name}`);
      addToast('Recurring schedule saved — drafts will auto-generate', 'success');
      setRecurringFromTpl(null);
    } catch (err) {
      console.error(err);
      addToast('Failed to save schedule: ' + err.message, 'error');
    }
  };
  const handleSaveTemplateEdit = async () => {
    if (!canEditFinance || !editingTemplate) return;
    const name = (editingTemplate.name || '').trim();
    if (!name) { addToast('Template name is required', 'error'); return; }
    const entries = (editingTemplate.entries || []).map((e) => ({
      debitAccount: (e.debitAccount || '').trim(),
      creditAccount: (e.creditAccount || '').trim(),
      // Preserve string placeholders verbatim; coerce numerics.
      amount: typeof e.amount === 'string' ? e.amount : (Number(e.amount) || 0),
    }));
    const bad = entries.findIndex((e) => !e.debitAccount || !e.creditAccount);
    if (bad !== -1) { addToast(`Line ${bad + 1}: complete both accounts`, 'error'); return; }
    const patch = {
      name,
      narration: editingTemplate.narration || '',
      party_name: editingTemplate.party_name || null,
      category: (editingTemplate.category || '').trim() || null,
      entries,
      updated_at: new Date().toISOString(),
    };
    try {
      if (editingTemplate.id) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'journal_templates', editingTemplate.id), patch);
        logAction('journal_templates', 'update', editingTemplate.id, patch, `Edited template: ${name}`);
        addToast('Template updated', 'success');
      } else {
        const newDoc = {
          ...patch,
          created_by: user?.uid || '',
          created_at: new Date().toISOString(),
          uses: 0,
        };
        const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_templates'), newDoc);
        logAction('journal_templates', 'create', ref.id, newDoc, `Template: ${name}`);
        addToast(`Created template "${name}"`, 'success');
      }
      setEditingTemplate(null);
    } catch (err) {
      console.error(err);
      addToast('Failed to save template: ' + err.message, 'error');
    }
  };

  const addTemplateLine = () => setEditingTemplate((t) => t ? { ...t, entries: [...(t.entries || []), { debitAccount: '', creditAccount: '', amount: 0 }] } : t);
  const removeTemplateLine = (idx) => setEditingTemplate((t) => t ? { ...t, entries: t.entries.filter((_, i) => i !== idx) } : t);
  const updateTemplateLine = (idx, field, value) => setEditingTemplate((t) => t ? {
    ...t,
    entries: t.entries.map((e, i) => i === idx ? { ...e, [field]: value } : e),
  } : t);

  // ── Chat helpers: compute named periods (pure date math). ──────────────────
  const computeChatPeriod = (period) => {
    const now = new Date();
    const toISO = (d) => d.toISOString().slice(0, 10);
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const mkFY = (y) => ({ from: `${y}-04-01`, to: `${y + 1}-03-31` });

    switch (period) {
      case 'today':      { const d = toISO(startOf(now)); return { from: d, to: d }; }
      case 'yesterday':  { const y = new Date(now); y.setDate(y.getDate() - 1); const d = toISO(startOf(y)); return { from: d, to: d }; }
      case 'this_week':  { const w = new Date(now); w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); return { from: toISO(startOf(w)), to: toISO(startOf(now)) }; }
      case 'last_week':  { const e = new Date(now); e.setDate(e.getDate() - ((e.getDay() + 6) % 7) - 1); const s = new Date(e); s.setDate(s.getDate() - 6); return { from: toISO(startOf(s)), to: toISO(startOf(e)) }; }
      case 'last_month': { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0); return { from: toISO(s), to: toISO(e) }; }
      case 'this_fy':    { const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; return mkFY(y); }
      case 'last_fy':    { const y = now.getMonth() >= 3 ? now.getFullYear() - 1 : now.getFullYear() - 2; return mkFY(y); }
      case 'this_month':
      default:           { const s = new Date(now.getFullYear(), now.getMonth(), 1); return { from: toISO(s), to: toISO(startOf(now)) }; }
    }
  };

  const prettyPeriod = (period, from, to) => {
    if (period === 'today' || period === 'yesterday') return `on ${from}`;
    if (period === 'this_month') return `this month`;
    if (period === 'last_month') return `last month`;
    if (period === 'this_fy' || period === 'last_fy') return `(${from} → ${to})`;
    return `${from} → ${to}`;
  };

  // Reversal handler: flip debit/credit of the original voucher and post a new JV.
  const handleChatReverse = async (parsed) => {
    if (!canEditFinance) throw new Error('Access denied.');
    const voucher = parsed?.meta?.reverseVoucher;
    if (!voucher) throw new Error('No voucher number specified.');
    const original = manualJournalEntries.find((e) =>
      e.voucher_no === voucher ||
      e.voucher_no === voucher.replace(/^JV-?/i, '') ||
      `JV-${(e.voucher_no || '').toString().padStart(4, '0')}` === voucher
    );
    if (!original) throw new Error(`Voucher ${voucher} not found.`);
    if (original.reversed || original.reversed_by || original.is_reversal) throw new Error(`Voucher ${voucher} is already reversed.`);

    const dateStr = parsed.date || new Date().toISOString().slice(0, 10);
    const fy = getFYFromDate(dateStr);
    if (fiscalYearClosings.some((row) => row.fy === fy && row.status === 'closed')) {
      throw new Error(`Financial year ${fy} is closed.`);
    }
    if (Array.isArray(lockedFYs) && lockedFYs.includes(fy)) throw new Error(`Financial year ${fy} is locked.`);
    // Also block if the original voucher's date falls in a locked FY.
    const originalFY = getFYFromDate(original?.date);
    if (originalFY && Array.isArray(lockedFYs) && lockedFYs.includes(originalFY)) {
      throw new Error(`Original voucher's FY ${originalFY} is locked. Unlock it before reversing.`);
    }

    const flipped = (original.entries || []).map((e) => ({
      debitAccount: e.creditAccount,
      creditAccount: e.debitAccount,
      amount: e.amount,
    }));
    const voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr });
    const payload = {
      voucher_no: voucherNo,
      fy,
      date: dateStr,
      narration: `Reversal of ${original.voucher_no || voucher} — ${original.narration || ''}`.trim(),
      source: 'chat_reversal',
      status: 'posted',
      entries: flipped,
      is_reversal: true,
      reverses_voucher_no: original.voucher_no || voucher,
      reverses_voucher_id: original.id,
      origin: 'ai_chat',
      ai_intent: 'reversal',
      ai_prompt: parsed.rawPrompt || '',
      created_by: user?.uid || '',
      created_at: new Date().toISOString(),
    };
    const ref = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'), payload);
    // Mark original as reversed (metadata only — does not delete it). Writes
    // BOTH flag families so the button path sees it too (B6 fix).
    if (original.id) {
      try {
        await updateDoc(
          doc(db, 'artifacts', appId, 'public', 'data', 'journal_entries', original.id),
          { reversed: true, reversed_by: voucherNo, reversed_by_voucher_id: ref.id, reversed_by_voucher_no: voucherNo, reversed_at: new Date().toISOString() },
        );
      } catch { /* best-effort */ }
    }
    logAction('journal_entries', 'create', ref.id, payload, `Reversal JV ${voucherNo} of ${original.voucher_no}`);
    addToast(`Reversed ${original.voucher_no} as ${voucherNo}`, 'success');
    return { message: `Posted ${voucherNo} — reversal of ${original.voucher_no}.` };
  };

  // Query handler: answer simple balance / P&L / expense-by-period questions.
  const handleChatQuery = async (parsed) => {
    const qt = parsed?.meta?.queryType;
    const period = parsed?.meta?.period || 'this_month';
    const { from, to } = computeChatPeriod(period);

    const inPeriod = (d) => (!from || d >= from) && (!to || d <= to);
    const periodLabel = prettyPeriod(period, from, to);

    if (qt === 'close_readiness') {
      const c = closeChecklist;
      const blockers = c.items.filter((i) => i.status === 'block');
      const warns = c.items.filter((i) => i.status === 'warn');
      const overdue = c.calendar.filter((x) => x.overdue);
      const nextDue = c.calendar.find((x) => !x.overdue);
      const lines = [
        c.ready
          ? `✓ You can close — no blockers${warns.length ? `, but ${warns.length} warning${warns.length === 1 ? '' : 's'} worth clearing first` : ''}.`
          : `✕ Not ready to close — ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}: ${blockers.map((b) => b.label).join('; ')}.`,
        ...warns.slice(0, 4).map((w) => `• ${w.label}: ${w.detail}`),
        overdue.length ? `⚠ Overdue: ${overdue.map((o) => o.label).join('; ')}.` : '',
        nextDue ? `Next deadline: ${nextDue.label} — due ${nextDue.due}.` : '',
        'Full checklist: Accounts → Year Close.',
      ].filter(Boolean);
      return { message: lines.join('\n') };
    }

    if (qt === 'audit') {
      const a = booksAudit;
      const top = a.findings.slice(0, 4).map((f) => `• ${f.message}`).join('\n');
      return {
        message: `Books audit: ${a.score}/100 (grade ${a.grade}). ${a.summary.headline}`
          + (top ? `\n\n${top}` : '')
          + `\n\nOpen Accounts → Audit for the full report and a printable PDF.`,
      };
    }

    // ── Show / ledger-on-demand / party balance / liabilities (read-only) ──
    if (qt === 'party_balance' || qt === 'account_ledger') {
      const subject = parsed?.meta?.subject || '';
      const candidates = resolveAccountCandidates(subject, snapshot.ledger);
      if (candidates.length === 0) {
        return { message: `I couldn't find an account or party matching "${subject || 'that'}". Try the exact name — e.g. "show Acme Corp ledger".` };
      }
      if (candidates.length > 1) {
        const opts = candidates.slice(0, 5).map((a) => a.replace(/^(Party:|Employee:)\s*/, '')).join(' · ');
        return { message: `"${subject}" matches more than one account — did you mean: ${opts}? Say e.g. "show ${candidates[0].replace(/^(Party:|Employee:)\s*/, '')} ledger".` };
      }
      const account = candidates[0];
      if (qt === 'account_ledger') {
        const ans = accountLedgerAnswer(snapshot.ledger, account, formatCurrency);
        const wantsPrint = /\b(print|download|pdf|export|save|email)\b/i.test(parsed?.rawPrompt || '');
        if (wantsPrint && ans.rows.length) {
          try {
            generateLedgerPdf(account, ans.rows, { orgName: orgName || 'Ledger', fyLabel: fyFilter, closing: ans.closing, closingType: ans.closingType });
            return { message: `${ans.message} PDF downloaded.` };
          } catch { return { message: `${ans.message} (couldn't generate the PDF — open Accounts → Ledger to print.)` }; }
        }
        return { message: `${ans.message} Say "print ${ans.name} ledger" to download it, or open Accounts → Ledger to view every entry.` };
      }
      return { message: partyBalanceAnswer(snapshot.ledger, account, formatCurrency).message };
    }
    if (qt === 'outstanding') {
      const raw = parsed?.rawPrompt || '';
      const kind = /\bpayables?\b|\bwe\s+owe\b|vendors?\b/i.test(raw) ? 'payable'
        : /\breceivables?\b|owes?\s+us\b|clients?\b|customers?\b/i.test(raw) ? 'receivable' : 'both';
      return { message: outstandingAnswer(snapshot.ledger, kind, formatCurrency).message };
    }
    if (qt === 'gst_liability') {
      return { message: gstLiabilityAnswer(snapshot.balanceSheet, formatCurrency).message };
    }
    if (qt === 'tds_liability') {
      return { message: tdsLiabilityAnswer(snapshot.ledger, formatCurrency).message };
    }

    // Statement answers read the fyFilter-scoped snapshot, NOT the chat period —
    // the scope suffix says so instead of echoing a period we didn't apply.
    const scopeLabel = fyFilter === 'all' ? 'all-periods figures' : `full FY ${fyFilter} figures`;
    if (qt === 'cash_balance' || qt === 'bank_balance') {
      const want = qt === 'cash_balance' ? /^Cash($|:)/i : /^Bank($|:)/i;
      const rows = (snapshot.ledger || []).filter((r) => want.test(r.account));
      const bal = rows.reduce((s, r) => s + (r.balance || 0), 0);
      return { message: `${qt === 'cash_balance' ? 'Cash' : 'Bank'} balance: ${formatCurrency(bal)} (as of today).` };
    }
    if (qt === 'pnl') {
      return { message: `${pnlAnswer(snapshot.profitAndLoss, formatCurrency).message} (${scopeLabel}).` };
    }
    if (qt === 'balance_sheet') {
      const bs = snapshot.balanceSheet || {};
      return { message: `Balance Sheet — Assets: ${formatCurrency(bs.assets?.total || 0)} · Liabilities: ${formatCurrency(bs.liabilities?.total || 0)} · Equity: ${formatCurrency(bs.equity?.total || 0)} (${scopeLabel}).` };
    }
    if (qt === 'trial_balance') {
      const dr = (snapshot.ledger || []).reduce((s, r) => s + Math.max(r.balance || 0, 0), 0);
      const cr = (snapshot.ledger || []).reduce((s, r) => s + Math.max(-(r.balance || 0), 0), 0);
      return { message: `Trial balance — Debits: ${formatCurrency(dr)} · Credits: ${formatCurrency(cr)} (${scopeLabel}).` };
    }
    if (qt === 'expenses') {
      const rows = (manualJournalEntries || []).filter((e) => inPeriod(e.date));
      const byMonth = new Map();
      const linesByMonth = new Map();
      let total = 0;
      rows.forEach((e) => {
        const monthKey = (e.date || '').slice(0, 7); // YYYY-MM
        (e.entries || []).forEach((line) => {
          const acc = chartOfAccounts.find((a) => a.name === line.debitAccount);
          if (acc?.type === 'Expense') {
            const amt = line.amount || 0;
            total += amt;
            byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + amt);
            const arr = linesByMonth.get(monthKey) || [];
            arr.push({ account: line.debitAccount, amount: amt, voucher_no: e.voucher_no || e.id, date: e.date, narration: e.narration || '' });
            linesByMonth.set(monthKey, arr);
          }
        });
      });
      const data = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([x, y]) => ({
        x, y,
        _breakdown: { expenses: linesByMonth.get(x) || [] },
      }));
      const useChart = data.length >= 2;
      return {
        message: `Expenses ${periodLabel}`,
        stat: formatCurrency(total),
        chart: useChart ? { kind: 'bar', data, xKey: 'x', yKey: 'y', drill: { seriesKey: 'expenses', label: 'Expenses' } } : null,
      };
    }
    if (qt === 'revenue') {
      const rows = (manualJournalEntries || []).filter((e) => inPeriod(e.date));
      const byMonth = new Map();
      const linesByMonth = new Map();
      let jvTotal = 0;
      rows.forEach((e) => {
        const monthKey = (e.date || '').slice(0, 7);
        (e.entries || []).forEach((line) => {
          const acc = chartOfAccounts.find((a) => a.name === line.creditAccount);
          if (acc?.type === 'Revenue' || acc?.type === 'Income') {
            const amt = line.amount || 0;
            jvTotal += amt;
            byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + amt);
            const arr = linesByMonth.get(monthKey) || [];
            arr.push({ account: line.creditAccount, amount: amt, voucher_no: e.voucher_no || e.id, date: e.date, narration: e.narration || '' });
            linesByMonth.set(monthKey, arr);
          }
        });
      });
      (snapshot.salesBook || []).filter((r) => inPeriod(r.date)).forEach((r) => {
        const monthKey = (r.date || '').slice(0, 7);
        byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + (r.total || 0));
        const arr = linesByMonth.get(monthKey) || [];
        arr.push({ account: 'Sales Book', amount: r.total || 0, voucher_no: r.invoice_no || r.id || '', date: r.date, narration: r.party_name || r.client_name || '' });
        linesByMonth.set(monthKey, arr);
      });
      const salesBookTotal = (snapshot.salesBook || []).filter((r) => inPeriod(r.date)).reduce((s, r) => s + r.total, 0);
      const total = jvTotal + salesBookTotal;
      const data = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([x, y]) => ({
        x, y,
        _breakdown: { revenue: linesByMonth.get(x) || [] },
      }));
      const useChart = data.length >= 2;
      return {
        message: `Revenue ${periodLabel}`,
        stat: formatCurrency(total),
        chart: useChart ? { kind: 'line', data, xKey: 'x', yKey: 'y', drill: { seriesKey: 'revenue', label: 'Revenue' } } : null,
      };
    }
    if (qt === 'compare') {
      // Build a shared month timeline across requested series (default: revenue vs expenses).
      const wanted = Array.isArray(parsed?.meta?.series) && parsed.meta.series.length > 0
        ? parsed.meta.series
        : ['revenue', 'expenses'];
      const rows = (manualJournalEntries || []).filter((e) => inPeriod(e.date));
      const months = new Set();
      const rev = new Map();
      const exp = new Map();
      const revLines = new Map();
      const expLines = new Map();
      rows.forEach((e) => {
        const monthKey = (e.date || '').slice(0, 7);
        if (!monthKey) return;
        (e.entries || []).forEach((line) => {
          const amt = line.amount || 0;
          const crAcc = chartOfAccounts.find((a) => a.name === line.creditAccount);
          const drAcc = chartOfAccounts.find((a) => a.name === line.debitAccount);
          if (crAcc?.type === 'Revenue' || crAcc?.type === 'Income') {
            rev.set(monthKey, (rev.get(monthKey) || 0) + amt); months.add(monthKey);
            const arr = revLines.get(monthKey) || [];
            arr.push({ account: line.creditAccount, amount: amt, voucher_no: e.voucher_no || e.id, date: e.date, narration: e.narration || '' });
            revLines.set(monthKey, arr);
          }
          if (drAcc?.type === 'Expense') {
            exp.set(monthKey, (exp.get(monthKey) || 0) + amt); months.add(monthKey);
            const arr = expLines.get(monthKey) || [];
            arr.push({ account: line.debitAccount, amount: amt, voucher_no: e.voucher_no || e.id, date: e.date, narration: e.narration || '' });
            expLines.set(monthKey, arr);
          }
        });
      });
      (snapshot.salesBook || []).filter((r) => inPeriod(r.date)).forEach((r) => {
        const monthKey = (r.date || '').slice(0, 7);
        if (!monthKey) return;
        rev.set(monthKey, (rev.get(monthKey) || 0) + (r.total || 0));
        months.add(monthKey);
        const arr = revLines.get(monthKey) || [];
        arr.push({ account: 'Sales Book', amount: r.total || 0, voucher_no: r.invoice_no || r.id || '', date: r.date, narration: r.party_name || r.client_name || '' });
        revLines.set(monthKey, arr);
      });
      const sorted = [...months].sort();
      const data = sorted.map((m) => ({
        x: m,
        revenue: rev.get(m) || 0,
        expenses: exp.get(m) || 0,
        _breakdown: { revenue: revLines.get(m) || [], expenses: expLines.get(m) || [] },
      }));
      const revTotal = [...rev.values()].reduce((a, b) => a + b, 0);
      const expTotal = [...exp.values()].reduce((a, b) => a + b, 0);
      const net = revTotal - expTotal;
      return {
        message: `${wanted.join(' vs ')} ${periodLabel}`,
        stat: `${formatCurrency(revTotal)} − ${formatCurrency(expTotal)} = ${formatCurrency(net)}`,
        chart: data.length >= 1 ? {
          kind: 'multi-bar',
          data,
          xKey: 'x',
          series: [
            { key: 'revenue',  color: '#10b981', label: 'Revenue' },
            { key: 'expenses', color: '#ef4444', label: 'Expenses' },
          ],
        } : null,
      };
    }

    // Long tail — a free-form question the deterministic menu didn't classify.
    // Escalate to the read-only LLM agent, grounded on a compact books digest.
    // Falls back to the plain summary when AI is off/offline or on any error.
    if (aiAvailable({ aiEnabled })) {
      try {
        const digest = buildBooksDigest(snapshot, { ageing: ageingData, fy: fyFilter, asOn: new Date().toISOString().slice(0, 10) });
        const answer = await aiAnswerQuery(parsed?.rawPrompt || '', digest);
        if (answer) return { message: answer, model: 'llm:qa' };
      } catch { /* fall through to the deterministic summary */ }
    }

    // Fallback summary
    return { message: `Sales: ${formatCurrency(totals.sales)} · Purchases: ${formatCurrency(totals.purchase)} · Cash/Bank: ${formatCurrency(snapshot.balanceSheet?.assets?.cashAndBank || 0)}.` };
  };

  const closeFinancialYear = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    if (fyFilter === 'all') return addToast('Select a specific FY first.', 'error');

    const alreadyClosed = fiscalYearClosings.some((row) => row.fy === fyFilter && row.status === 'closed');
    if (alreadyClosed) return addToast(`${fyFilter} is already closed.`, 'error');

    const nextFy = getNextFinancialYear(fyFilter);
    const closingDate = `${parseInt(fyFilter.slice(0, 4), 10) + 1}-03-31`;
    const netProfit = snapshot.profitAndLoss.netProfit;
    const transferAmount = Math.abs(netProfit);

    try {
      setIsSaving(true);
      const batch = writeBatch(db);

      let transferEntry = null;
      let voucherNo = '';

      if (transferAmount > 0.009) {
        voucherNo = await generateJournalVoucherNumber({ db, appId, dateStr: closingDate });
        transferEntry = netProfit >= 0
          ? { debitAccount: 'Profit And Loss Closing', creditAccount: 'Retained Earnings', amount: transferAmount }
          : { debitAccount: 'Retained Earnings', creditAccount: 'Profit And Loss Closing', amount: transferAmount };

        const journalRef = doc(collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries'));
        batch.set(journalRef, {
          voucher_no: voucherNo,
          fy: fyFilter,
          date: closingDate,
          narration: `Year closing transfer for ${fyFilter}`,
          source: 'fy_closing',
          status: 'posted',
          entries: [transferEntry],
          created_by: user?.uid || '',
          created_at: new Date().toISOString(),
        });
      }

      const closeRef = doc(db, 'artifacts', appId, 'public', 'data', 'fiscal_year_closings', fyFilter);
      batch.set(closeRef, {
        fy: fyFilter,
        next_fy: nextFy,
        date: closingDate,
        status: 'closed',
        voucher_no: voucherNo,
        transferEntry,
        net_profit: netProfit,
        closed_by: user?.uid || '',
        closed_at: new Date().toISOString(),
      });

      // Source rolloverRows from snapshot.ledger (NOT trialBalance.rows) so we
      // can capture the stable accountId for party rows. Without accountId,
      // next-FY opening balance for "Party: ABC" (keyed by name) won't merge
      // with current-year activity (keyed by party_${id}) → split ledger rows
      // that never net. This is the bug behind "completed projects not
      // included in final amount" — the rolled-forward party receivable from
      // unbilled projects sat in a separate ledger row from the new invoice
      // posted next year.
      // Pure + unit-tested (src/utils/fyRollover.js): carries A/L/E balances, drops
      // the 'Profit And Loss Closing' clearing account, and folds the closing
      // transfer into Retained Earnings — the transfer voucher is written in THIS
      // batch, so snapshot.ledger does not yet contain it and the year's profit
      // was previously never carried forward at all (it was silently absorbed by
      // the 'Opening Balance Equity' contra instead).
      const rolloverRows = computeFyRolloverRows({
        ledger: snapshot.ledger || [],
        typeOf: (account) => guessAccountType(account, chartByName),
        netProfit,
        hasTransfer: !!transferEntry,
      });

      rolloverRows.forEach((row) => {
        const side = row.balance >= 0 ? 'Dr' : 'Cr';
        const amount = Math.abs(row.balance);
        // Doc key prefers stable accountId so a party rename next year doesn't
        // create a duplicate opening-balance doc.
        const slug = row.accountId || row.account.replace(/[^a-zA-Z0-9]/g, '_');
        const key = `${nextFy}_${slug}`;
        const obRef = doc(db, 'artifacts', appId, 'public', 'data', 'opening_balances', key);
        batch.set(obRef, {
          fy: nextFy,
          date: `${parseInt(nextFy.slice(0, 4), 10)}-04-01`,
          account_name: row.account,
          account_id: row.accountId || null,  // stable identity for party rows
          side,
          amount,
          remarks: `FY rollover from ${fyFilter}`,
          source: 'fy_rollover',
          closed_from_fy: fyFilter,
          created_by: user?.uid || '',
          created_at: new Date().toISOString(),
        }, { merge: true });
      });

      await batch.commit();
      logAction('fiscal_year_closings', 'close', fyFilter, { fy: fyFilter, next_fy: nextFy }, `Closed FY ${fyFilter}`);
      addToast(`FY ${fyFilter} closed and rolled to ${nextFy}`, 'success');
    } catch (err) {
      console.error(err);
      addToast('FY close failed', 'error');
    }
    setIsSaving(false);
  };

  // ── Purchase Invoice CRUD ──
  const vendorOptions = useMemo(() =>
    clients
      .filter(c => c.type === 'Vendor' || c.type === 'Both' || c.type === 'Supplier')
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [clients]
  );

  const openPiAdd = () => {
    setPiEditingId(null);
    setPiForm(piInitialForm);
    setIsPiModalOpen(true);
  };

  const openPiEdit = (piRaw) => {
    setPiEditingId(piRaw.id);
    setPiForm({
      invoice_date: piRaw.invoice_date || '',
      vendor_name: piRaw.vendor_name || '',
      vendor_id: piRaw.vendor_id || '',
      description: piRaw.description || '',
      amount: piRaw.amount ?? '',
      gst_amount: piRaw.gst_amount ?? '',
      purchase_mode: piRaw.purchase_mode || 'Credit',
      status: piRaw.status || 'Pending',
      remarks: piRaw.remarks || '',
    });
    setIsPiModalOpen(true);
  };

  const handlePiSave = async () => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    if (!piForm.invoice_date) return addToast('Invoice date is required.', 'error');
    if (!piForm.vendor_name && !piForm.vendor_id) return addToast('Vendor name is required.', 'error');

    setIsSaving(true);
    try {
      const vendorClient = piForm.vendor_id ? clients.find(c => c.id === piForm.vendor_id) : null;
      const vendorName = vendorClient?.name || piForm.vendor_name;

      let piNo = null;
      if (piEditingId) {
        const existing = purchaseInvoices.find(r => r.id === piEditingId);
        piNo = existing?.pi_no;
      }
      if (!piNo) {
        const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        const orgSettings = orgSnap.exists() ? orgSnap.data() : {};
        piNo = await generateBookInvoiceNumber({ db, appId, dateStr: piForm.invoice_date, bookType: 'purchase', orgSettings });
      }

      const data = {
        pi_no: piNo,
        type: 'Service',
        invoice_date: piForm.invoice_date,
        invoice_ref: '',
        vendor_name: vendorName,
        vendor_id: piForm.vendor_id || '',
        description: piForm.description,
        amount: parseFloat(piForm.amount) || 0,
        gst_amount: parseFloat(piForm.gst_amount) || 0,
        purchase_mode: piForm.purchase_mode || 'Credit',
        status: piForm.status,
        remarks: piForm.remarks,
        fy: getFYFromDate(piForm.invoice_date),
        updated_at: new Date().toISOString(),
      };

      const colPath = collection(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices');
      if (piEditingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices', piEditingId), data);
        logAction('purchase_invoices', 'update', piEditingId, data, piNo);
      } else {
        data.created_at = new Date().toISOString();
        const ref = await addDoc(colPath, data);
        logAction('purchase_invoices', 'create', ref.id, data, piNo);
      }
      setIsPiModalOpen(false);
      addToast(piEditingId ? 'Purchase invoice updated' : 'Purchase invoice created', 'success');
    } catch (err) {
      console.error(err);
      addToast('Save failed: ' + err.message, 'error');
    }
    setIsSaving(false);
  };

  const handlePiDelete = async (piRaw) => {
    if (!canEditFinance) return addToast('Access denied.', 'error');
    try {
      setIsSaving(true);
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices', piRaw.id));
      logAction('purchase_invoices', 'delete', piRaw.id, null, piRaw.pi_no);
      addToast('Purchase invoice deleted', 'success');
      setPiDeleteModal({ isOpen: false, entry: null });
    } catch (err) {
      console.error(err);
      addToast('Delete failed: ' + err.message, 'error');
    }
    setIsSaving(false);
  };

  const undoFinancialYearClose = async (closingRow) => {
    if (role !== 'admin') {
      return addToast('Only an Admin can undo a financial year closing. Managers cannot reverse a closed FY because it deletes journal entries, rolled-over opening balances, and the closing record.', 'error');
    }
    if (!closingRow || closingRow.status !== 'closed') return;
    const confirmed = await confirmDialog(
      `Are you sure you want to UNDO the closing of FY ${closingRow.fy}?\n\n` +
      `This will:\n` +
      `• Delete the closing journal entry (${closingRow.voucher_no || 'N/A'})\n` +
      `• Remove rolled-over opening balances for ${closingRow.next_fy}\n` +
      `• Reopen FY ${closingRow.fy} for editing\n\n` +
      `This action cannot be undone automatically.`
    );
    if (!confirmed) return;

    try {
      setIsSaving(true);

      // Pre-flight: Firestore rules require the caller to be authenticated AND
      // have role='admin' on /users/{uid}. The synthetic 'admin' username
      // login writes that mirror fire-and-forget, so on a fresh session it
      // may not be present yet. Verify and self-heal before the destructive
      // batch, otherwise rules return "Missing or insufficient permissions".
      const authedUser = auth.currentUser;
      if (!authedUser) {
        addToast(
          'You are not signed in to Firebase Auth. Please log out and log back in (the admin login provisions Firebase Auth in the background — it may not have completed on this session). Then retry "Undo Close".',
          'error'
        );
        setIsSaving(false);
        return;
      }
      try {
        const mirrorRef = doc(db, 'artifacts', appId, 'public', 'data', 'users', authedUser.uid);
        const mirrorSnap = await getDoc(mirrorRef);
        const mirrorRole = mirrorSnap.exists() ? mirrorSnap.data().role : null;
        if (mirrorRole !== 'admin') {
          // Refresh / create the admin mirror so rules can authorise the batch.
          await setDoc(
            mirrorRef,
            {
              email: authedUser.email || 'admin@rentalops.com',
              role: 'admin',
              updated_at: new Date().toISOString(),
            },
            { merge: true }
          );
        }
      } catch (mirrorErr) {
        console.warn('Could not refresh /users/{uid} admin mirror before FY undo:', mirrorErr);
      }

      const batch = writeBatch(db);

      // 1. Delete the closing journal entry if it exists
      if (closingRow.voucher_no) {
        const jeSnap = await getDocs(
          collection(db, 'artifacts', appId, 'public', 'data', 'journal_entries')
        );
        jeSnap.docs.forEach((d) => {
          const data = d.data();
          if (data.source === 'fy_closing' && data.voucher_no === closingRow.voucher_no) {
            batch.delete(d.ref);
          }
        });
      }

      // 2. Delete rolled-over opening balances for the next FY
      if (closingRow.next_fy) {
        const obSnap = await getDocs(
          collection(db, 'artifacts', appId, 'public', 'data', 'opening_balances')
        );
        obSnap.docs.forEach((d) => {
          const data = d.data();
          if (data.source === 'fy_rollover' && data.closed_from_fy === closingRow.fy) {
            batch.delete(d.ref);
          }
        });
      }

      // 3. Delete the fiscal_year_closings record
      const closeRef = doc(db, 'artifacts', appId, 'public', 'data', 'fiscal_year_closings', closingRow.fy);
      batch.delete(closeRef);

      await batch.commit();
      logAction('fiscal_year_closings', 'undo', closingRow.fy, { fy: closingRow.fy }, `Undid FY ${closingRow.fy} close`);
      addToast(`FY ${closingRow.fy} reopened successfully`, 'success');
    } catch (err) {
      console.error(err);
      const code = err?.code || '';
      if (code === 'permission-denied' || /insufficient|permission/i.test(err?.message || '')) {
        addToast(
          'Undo FY close blocked by Firestore security rules. Cause: your Firebase Auth account is not recognised as admin on /users/{uid}. Fix: log out, log back in as admin, then retry. If this persists, an Admin must set role="admin" on artifacts/<appId>/public/data/users/<your-uid>.',
          'error'
        );
      } else {
        addToast('Undo FY close failed: ' + (err?.message || String(err)), 'error');
      }
    }
    setIsSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Accounts & Finance</h1>
          <p className="text-sm text-slate-500">Track your income, expenses, and who owes what — all in one place.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsAssistantOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-md hover:from-indigo-700 hover:to-indigo-800 transition"
            title="Ask Assistant (Ctrl+K)"
          >
            <Sparkles size={16} />
            Ask Assistant
            <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-white/30 bg-white/10 px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
          </button>
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-600">Year</label>
            <select
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
              value={fyFilter}
              onChange={(e) => {
                setFyFilter(e.target.value);
                setOpeningForm((f) => ({ ...f, fy: e.target.value === 'all' ? '' : e.target.value }));
              }}
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  {fy === 'all' ? 'All Years' : `FY ${fy}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Tab Navigation — grouped ── */}
      <div className="rounded-xl border border-slate-200 bg-white p-2 space-y-1">
        {['overview', 'books', 'reports', 'admin'].map((group) => {
          const groupTabs = TABS.filter((t) => t.group === group);
          if (groupTabs.length === 0) return null;
          const groupLabel = { overview: '', books: 'Books & Records', reports: 'Reports', admin: 'Setup & Admin' }[group];
          return (
            <div key={group} className="flex flex-wrap items-center gap-1">
              {groupLabel && <span className="mr-1 px-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{groupLabel}</span>}
              {groupTabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    title={tab.hint || tab.label}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                      activeTab === tab.id ? 'bg-indigo-100 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon size={13} />
                    {tab.label}
                  </button>
                );
              })}
              {group !== 'admin' && <div className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" />}
            </div>
          );
        })}
      </div>

      {/* ══════ OVERVIEW TAB — the layman dashboard ══════ */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Top-level numbers in plain English */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-green-200 bg-gradient-to-br from-green-50 to-white p-4">
              <p className="text-xs font-semibold uppercase text-green-600">Total Income</p>
              <p className="mt-1 text-2xl font-bold text-green-800">{formatCurrency(totals.sales + totals.nonInvoicedSales)}</p>
              <p className="mt-1 text-xs text-green-600">{formatCurrency(totals.sales)} billed + {formatCurrency(totals.nonInvoicedSales)} unbilled</p>
            </div>
            <div className="rounded-xl border border-orange-200 bg-gradient-to-br from-orange-50 to-white p-4">
              <p className="text-xs font-semibold uppercase text-orange-600">Total Spending</p>
              <p className="mt-1 text-2xl font-bold text-orange-800">{formatCurrency(totals.purchase)}</p>
              <p className="mt-1 text-xs text-orange-600">Purchases + Outsourcing</p>
            </div>
            <div className={`rounded-xl border p-4 ${snapshot.profitAndLoss.netProfit >= 0 ? 'border-blue-200 bg-gradient-to-br from-blue-50 to-white' : 'border-red-200 bg-gradient-to-br from-red-50 to-white'}`}>
              <p className={`text-xs font-semibold uppercase ${snapshot.profitAndLoss.netProfit >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                {snapshot.profitAndLoss.netProfit >= 0 ? 'Net Profit' : 'Net Loss'}
              </p>
              <p className={`mt-1 text-2xl font-bold ${snapshot.profitAndLoss.netProfit >= 0 ? 'text-blue-800' : 'text-red-800'}`}>
                {formatCurrency(Math.abs(snapshot.profitAndLoss.netProfit))}
              </p>
              <p className={`mt-1 text-xs ${snapshot.profitAndLoss.netProfit >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                Income minus all costs
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
              <p className="text-xs font-semibold uppercase text-slate-600">Cash & Bank</p>
              <p className="mt-1 text-2xl font-bold text-slate-800">{formatCurrency(snapshot.balanceSheet.assets.cashAndBank)}</p>
              <p className="mt-1 text-xs text-slate-500">Available balance</p>
            </div>
          </div>

          {/* Accounting analytics — drafts aging, top templates, AI vs manual */}
          {(() => {
            const todayMs = Date.now();
            const draftAge = (d) => {
              const t = d.created_at ? new Date(d.created_at).getTime() : todayMs;
              return Math.max(0, Math.round((todayMs - t) / (24 * 60 * 60 * 1000)));
            };
            const oldestDrafts = [...journalDrafts]
              .filter((d) => !d.requires_approval || d.approval_status === 'approved')
              .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
              .slice(0, 5);
            const overdueScheduled = journalDrafts.filter((d) => d.schedule_post_on && d.schedule_post_on < new Date().toISOString().slice(0, 10));
            const topTemplates = [...journalTemplates]
              .filter((t) => (t.uses || 0) > 0)
              .sort((a, b) => (b.uses || 0) - (a.uses || 0))
              .slice(0, 5);
            const sourceCounts = (manualJournalEntries || []).reduce((acc, e) => {
              const isAi = e.origin === 'ai_chat' || e.source === 'chat_entry' || e.source === 'scheduled_post';
              const key = isAi ? 'ai' : 'manual';
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, { ai: 0, manual: 0 });
            const totalEntries = sourceCounts.ai + sourceCounts.manual;
            const aiPct = totalEntries > 0 ? Math.round((sourceCounts.ai / totalEntries) * 100) : 0;
            return (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-xl border border-amber-200 bg-white p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-amber-700">⏱️ Drafts aging</p>
                    {overdueScheduled.length > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">{overdueScheduled.length} overdue</span>}
                  </div>
                  {oldestDrafts.length === 0 ? (
                    <p className="text-xs text-slate-400">No parked drafts.</p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {oldestDrafts.map((d) => (
                        <li key={d.id} className="flex justify-between gap-2">
                          <span className="truncate text-slate-600">{d.narration || d.party_name || '—'}</span>
                          <span className="text-amber-700 font-semibold whitespace-nowrap">{draftAge(d)}d</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-xl border border-purple-200 bg-white p-4">
                  <p className="text-sm font-semibold text-purple-700 mb-2">⭐ Top templates</p>
                  {topTemplates.length === 0 ? (
                    <p className="text-xs text-slate-400">No template usage yet.</p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {topTemplates.map((t) => (
                        <li key={t.id} className="flex justify-between gap-2">
                          <span className="truncate text-slate-600">{t.name}{t.category ? ` · ${t.category}` : ''}</span>
                          <span className="text-purple-700 font-semibold whitespace-nowrap">{t.uses}×</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-xl border border-indigo-200 bg-white p-4">
                  <p className="text-sm font-semibold text-indigo-700 mb-2">🤖 AI vs manual posting</p>
                  <div className="text-2xl font-bold text-indigo-800">{aiPct}%</div>
                  <p className="text-[11px] text-slate-500">{sourceCounts.ai} AI/auto · {sourceCounts.manual} manual</p>
                  <div className="mt-2 h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-indigo-500" style={{ width: `${aiPct}%` }} />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Who owes you / Who you owe — the #1 thing a layman needs */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-emerald-200 bg-white p-4">
              <p className="text-sm font-semibold text-emerald-700">💰 Money Coming In (Receivable)</p>
              <p className="text-xs text-slate-500 mb-3">Clients, employees & vendors who owe you money</p>
              <p className="text-2xl font-bold text-emerald-800 mb-3">{formatCurrency(realReceivableTotal)}</p>
              {realPartyBalances.filter(r => r.balance > 0.01).length > 0 ? (
                <div className="space-y-1 max-h-48 overflow-auto">
                  {realPartyBalances
                    .filter(r => r.balance > 0.01)
                    .sort((a, b) => b.balance - a.balance)
                    .map(r => (
                      <div key={r.account} onClick={() => drillToLedger(r.account)} className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm cursor-pointer hover:bg-emerald-100 transition">
                        <span className="text-slate-700">{r.account.replace('Party: ', '')}</span>
                        <span className="font-semibold text-emerald-800">{formatCurrency(r.balance)}</span>
                      </div>
                    ))
                  }
                </div>
              ) : (
                <p className="text-xs text-slate-400">No outstanding receivables</p>
              )}
            </div>
            <div className="rounded-xl border border-rose-200 bg-white p-4">
              <p className="text-sm font-semibold text-rose-700">📤 Money Going Out (Payable)</p>
              <p className="text-xs text-slate-500 mb-3">Clients, employees & vendors you owe money to</p>
              <p className="text-2xl font-bold text-rose-800 mb-3">{formatCurrency(realPayableTotal)}</p>
              {realPartyBalances.filter(r => r.balance < -0.01).length > 0 ? (
                <div className="space-y-1 max-h-48 overflow-auto">
                  {realPartyBalances
                    .filter(r => r.balance < -0.01)
                    .sort((a, b) => a.balance - b.balance)
                    .map(r => (
                      <div key={r.account} onClick={() => drillToLedger(r.account)} className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-sm cursor-pointer hover:bg-rose-100 transition">
                        <span className="text-slate-700">{r.account.replace('Party: ', '')}</span>
                        <span className="font-semibold text-rose-800">{formatCurrency(Math.abs(r.balance))}</span>
                      </div>
                    ))
                  }
                </div>
              ) : (
                <p className="text-xs text-slate-400">No outstanding payables</p>
              )}
            </div>
          </div>

          {/* Ageing Summary Bars */}
          {(ageingData.receivableTotals.total > 0.01 || ageingData.payableTotals.total > 0.01) && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">⏰ Ageing Summary</p>
                <button onClick={() => setActiveTab('ageing')} className="text-xs text-indigo-600 hover:underline">View Details →</button>
              </div>
              {ageingData.receivableTotals.total > 0.01 && (
                <div>
                  <p className="text-xs font-semibold text-emerald-700 mb-1">Receivable Ageing</p>
                  <div className="flex h-4 w-full overflow-hidden rounded-full bg-slate-100">
                    {['0_30', '31_60', '61_90', '90_plus'].map((key, i) => {
                      const pct = (ageingData.receivableTotals[key] / ageingData.receivableTotals.total) * 100;
                      const colors = ['bg-green-400', 'bg-yellow-400', 'bg-orange-400', 'bg-red-500'];
                      return pct > 0.5 ? <div key={key} style={{ width: `${pct}%` }} className={`${colors[i]}`} title={`${['0-30','31-60','61-90','90+'][i]} days: ${formatCurrency(ageingData.receivableTotals[key])}`} /> : null;
                    })}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-400" />0-30d: {formatCurrency(ageingData.receivableTotals['0_30'])}</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />31-60d: {formatCurrency(ageingData.receivableTotals['31_60'])}</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-orange-400" />61-90d: {formatCurrency(ageingData.receivableTotals['61_90'])}</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-red-500" />90+d: {formatCurrency(ageingData.receivableTotals['90_plus'])}</span>
                  </div>
                </div>
              )}
              {ageingData.payableTotals.total > 0.01 && (
                <div>
                  <p className="text-xs font-semibold text-rose-700 mb-1">Payable Ageing</p>
                  <div className="flex h-4 w-full overflow-hidden rounded-full bg-slate-100">
                    {['0_30', '31_60', '61_90', '90_plus'].map((key, i) => {
                      const pct = (ageingData.payableTotals[key] / ageingData.payableTotals.total) * 100;
                      const colors = ['bg-green-400', 'bg-yellow-400', 'bg-orange-400', 'bg-red-500'];
                      return pct > 0.5 ? <div key={key} style={{ width: `${pct}%` }} className={`${colors[i]}`} title={`${['0-30','31-60','61-90','90+'][i]} days: ${formatCurrency(ageingData.payableTotals[key])}`} /> : null;
                    })}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-green-400" />0-30d: {formatCurrency(ageingData.payableTotals['0_30'])}</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />31-60d: {formatCurrency(ageingData.payableTotals['31_60'])}</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-orange-400" />61-90d: {formatCurrency(ageingData.payableTotals['61_90'])}</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-red-500" />90+d: {formatCurrency(ageingData.payableTotals['90_plus'])}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* GST at a glance */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-xs font-semibold uppercase text-violet-600">GST Collected</p>
              <p className="mt-1 text-lg font-bold text-violet-800">{formatCurrency(Math.abs(Math.min(snapshot.ledger.find(r => r.account === 'Output GST Payable')?.balance || 0, 0)))}</p>
              <p className="text-xs text-violet-500">From your invoices</p>
            </div>
            <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4">
              <p className="text-xs font-semibold uppercase text-cyan-600">GST Paid</p>
              <p className="mt-1 text-lg font-bold text-cyan-800">{formatCurrency(Math.max(snapshot.ledger.find(r => r.account === 'Input GST Credit')?.balance || 0, 0))}</p>
              <p className="text-xs text-cyan-500">On your purchases</p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-xs font-semibold uppercase text-amber-600">GST to Pay Govt</p>
              <p className="mt-1 text-lg font-bold text-amber-800">{formatCurrency(snapshot.balanceSheet.liabilities.gstPayable)}</p>
              <p className="text-xs text-amber-500">Collected − Paid</p>
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setActiveTab('sales')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">View Billed Sales →</button>
            <button onClick={() => setActiveTab('non_invoiced_sales')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">View Unbilled Work →</button>
            <button onClick={() => setActiveTab('purchase')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">View Purchases →</button>
            <button onClick={() => setActiveTab('ledger')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">View Party Details →</button>
            <div className="w-px h-6 bg-slate-300 self-center" />
            <button onClick={() => exportReport('all')} className="inline-flex items-center gap-1 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-xs font-semibold text-green-700 hover:bg-green-100"><Download size={12} /> Export All (Excel)</button>
            <button onClick={() => exportReport('tally')} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-100"><Download size={12} /> Tally Export</button>
          </div>

          {/* Trial balance health check — simple green/red */}
          <div className={`rounded-xl border p-3 text-sm ${snapshot.trialBalance.isBalanced ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
            {snapshot.trialBalance.isBalanced
              ? '✅ Your books are balanced — everything adds up correctly.'
              : `⚠️ Your books have a difference of ${formatCurrency(Math.abs(snapshot.trialBalance.difference))}. Check Trial Balance tab for details.`
            }
          </div>

          {/* Integrity advisories. A balanced trial balance cannot detect these
              (the journal balances by construction), so they are checked
              independently. Shown ONLY when something actually needs a look —
              deliberately advisory, never a "do not file" alarm. */}
          {snapshot.integrity && !snapshot.integrity.ok && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">Your books balance, but {snapshot.integrity.checks.filter((c) => !c.ok).length} integrity check(s) need a look:</div>
              <ul className="mt-1 list-disc pl-5 space-y-0.5">
                {snapshot.integrity.checks.filter((c) => !c.ok).map((c) => (
                  <li key={c.id}>{c.label} — <span className="text-amber-700">{c.detail}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {activeTab === 'sales' && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Invoice No</th>
                  <th className="px-3 py-2 text-left">Client</th>
                  <th className="px-3 py-2 text-left">Mode</th>
                  <th className="px-3 py-2 text-right">Taxable</th>
                  <th className="px-3 py-2 text-right">GST</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {snapshot.salesBook.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2">{row.date || '-'}</td>
                    <td className="px-3 py-2 font-mono font-semibold text-slate-800">{row.invoiceNo || '-'}</td>
                    <td className="px-3 py-2">{row.clientName || '-'}</td>
                    <td className="px-3 py-2">{row.mode}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.taxable)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.gst)}</td>
                    <td className="px-3 py-2 text-right font-bold">{formatCurrency(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'non_invoiced_sales' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-teal-200 bg-teal-50 p-3">
            <p className="text-sm text-teal-800">
              <strong>Non-Invoiced Sales:</strong> Completed projects pending invoice. 
              Once invoice is raised, these entries automatically move to Invoiced Sales Book.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Project Name</th>
                    <th className="px-3 py-2 text-left">Client</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Taxable</th>
                    <th className="px-3 py-2 text-right">GST</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(snapshot.nonInvoicedSalesBook || []).map((row) => (
                    <tr key={row.id} className="bg-teal-50/30">
                      <td className="px-3 py-2">{row.date || '-'}</td>
                      <td className="px-3 py-2 font-semibold text-slate-800">{row.projectName || '-'}</td>
                      <td className="px-3 py-2">{row.clientName || '-'}</td>
                      <td className="px-3 py-2">
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          Pending Invoice
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.taxable)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.gst)}</td>
                      <td className="px-3 py-2 text-right font-bold">{formatCurrency(row.total)}</td>
                    </tr>
                  ))}
                  {(snapshot.nonInvoicedSalesBook || []).length === 0 && (
                    <tr>
                      <td colSpan="7" className="px-3 py-8 text-center text-slate-500">
                        No non-invoiced sales. All completed projects have been invoiced.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'purchase' && (
        <div className="space-y-3">
          {canEditFinance && (
            <div className="flex justify-end">
              <button onClick={openPiAdd} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                <Plus size={14} /> Add Purchase Invoice
              </button>
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">PI No</th>
                    <th className="px-3 py-2 text-left">Vendor</th>
                    <th className="px-3 py-2 text-left">Mode</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Taxable</th>
                    <th className="px-3 py-2 text-right">GST</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    {canEditFinance && <th className="px-3 py-2 text-center">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {purchaseInvoices
                    .filter((r) => r.status !== 'Rejected')
                    .filter((r) => fyFilter === 'all' || getFYFromDate(r.invoice_date) === fyFilter)
                    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''))
                    .map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2">{row.invoice_date || '-'}</td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-800">{row.pi_no || '-'}</td>
                        <td className="px-3 py-2">{row.vendor_name || '-'}</td>
                        <td className="px-3 py-2">{row.purchase_mode || 'Credit'}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${
                            row.status === 'Verified' ? 'bg-green-100 text-green-800' : row.status === 'Rejected' ? 'bg-red-100 text-red-800' : 'bg-orange-100 text-orange-800'
                          }`}>{row.status || 'Pending'}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.amount || 0)}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.gst_amount || 0)}</td>
                        <td className="px-3 py-2 text-right font-bold">{formatCurrency((row.amount || 0) + (row.gst_amount || 0))}</td>
                        {canEditFinance && (
                          <td className="px-3 py-2 text-center">
                            <div className="inline-flex gap-1">
                              <button onClick={() => openPiEdit(row)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-indigo-600"><Edit size={14} /></button>
                              <button onClick={() => setPiDeleteModal({ isOpen: true, entry: row })} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-600"><Trash2 size={14} /></button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'approvals' && (
        <div className="space-y-3">
          {(() => {
            const pending = journalDrafts.filter((d) => d.requires_approval && d.approval_status === 'pending');
            const recent = journalDrafts.filter((d) => d.requires_approval && d.approval_status !== 'pending').slice(0, 20);
            return (
              <>
                <div className="rounded-xl border-2 border-amber-200 bg-amber-50/40">
                  <div className="px-3 py-2 border-b border-amber-200 bg-amber-50 text-sm font-semibold text-amber-700 flex items-center justify-between">
                    <span>Pending approval ({pending.length})</span>
                    {role !== 'admin' && <span className="text-[11px] text-amber-600">View only — admin must approve</span>}
                  </div>
                  {pending.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-amber-700/70">No drafts awaiting approval.</div>
                  ) : (
                    <div className="divide-y divide-amber-100">
                      {pending.map((d) => {
                        const totalDebit = (d.entries || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
                        return (
                          <div key={d.id} className="px-3 py-2 grid grid-cols-12 gap-2 items-center">
                            <div className="col-span-2 text-xs text-slate-600">{d.date}</div>
                            <div className="col-span-4 text-sm">
                              <div className="font-medium text-slate-700 truncate">{d.narration || '—'}</div>
                              <div className="text-[11px] text-slate-500">{d.party_name || ''} · by {d.created_by?.slice(0, 8) || '—'}</div>
                            </div>
                            <div className="col-span-3 text-[11px] text-slate-600 truncate">
                              {(d.entries || []).slice(0, 2).map((e, i) => (
                                <div key={i}>{e.debitAccount || '—'} → {e.creditAccount || '—'}</div>
                              ))}
                              {(d.entries || []).length > 2 && <div className="text-slate-400">+{(d.entries || []).length - 2}</div>}
                            </div>
                            <div className="col-span-1 text-right font-mono text-xs">{formatCurrency(totalDebit)}</div>
                            <div className="col-span-2 flex justify-end gap-1">
                              {role === 'admin' ? (
                                <>
                                  <button onClick={() => handleApproveDraft(d)} className="rounded bg-green-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-700">Approve</button>
                                  <button onClick={() => handleRejectDraft(d)} className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700">Reject</button>
                                </>
                              ) : (
                                <span className="text-[11px] text-amber-700">Pending</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {recent.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-white">
                    <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700">Recently decided ({recent.length})</div>
                    <div className="divide-y divide-slate-100 text-xs">
                      {recent.map((d) => (
                        <div key={d.id} className="px-3 py-1.5 flex items-center justify-between">
                          <div className="truncate">
                            <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-semibold ${d.approval_status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{d.approval_status}</span>
                            {d.narration || '—'}
                          </div>
                          <div className="text-slate-400">{d.approved_at ? d.approved_at.slice(0, 10) : ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {activeTab === 'ai_insights' && (
        canEditFinance
          ? <AiInsightsPanel entries={manualJournalEntries} fyFilter={fyFilter} />
          : <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">AI Insights are available to finance/accountant roles.</div>
      )}

      {activeTab === 'ai_review' && (
        <div className="space-y-3">
          {/* Header + filters */}
          <div className="flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-indigo-700"><Sparkles size={16} /> AI-Created Entries</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Posted journal entries created via the Ask Assistant, shown with the original message so an accountant/CA can review their impact.
                {' '}<span className="font-semibold text-slate-700">{aiReviewedCount}/{aiEntries.length} reviewed</span>.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input className="w-48 rounded-lg border border-slate-300 pl-8 pr-2 py-1.5 text-xs text-slate-800" placeholder="Search message / voucher / party…" value={aiReviewSearch} onChange={(e) => setAiReviewSearch(e.target.value)} />
              </div>
              <select className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-700" value={aiReviewFilter} onChange={(e) => setAiReviewFilter(e.target.value)}>
                <option value="all">All</option>
                <option value="unreviewed">Unreviewed</option>
                <option value="reviewed">Reviewed</option>
                <option value="flagged">Flagged (has warnings)</option>
              </select>
              <button onClick={exportAiEntries} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">Export Excel</button>
            </div>
          </div>

          {aiEntries.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">No AI-created entries{aiReviewFilter !== 'all' ? ' for this filter' : ''}.</div>
          ) : (
            <div className="space-y-2">
              {aiEntries.map((e) => {
                const total = (e.entries || []).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
                const conf = typeof e.ai_confidence === 'number' ? Math.round(e.ai_confidence * 100) : null;
                const warnings = (e.ai_issues || []).filter((i) => i.level === 'warning' || i.level === 'error');
                const isLlm = (e.ai_model || '').startsWith('llm:');
                return (
                  <div key={e.id} className={`rounded-xl border bg-white p-3 shadow-sm ${e.ai_reviewed ? 'border-green-200' : warnings.length ? 'border-amber-200' : 'border-slate-200'}`}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-bold text-indigo-700">{e.voucher_no || '—'}</span>
                      <span className="text-slate-500">{e.date || '—'}</span>
                      <span className={`rounded-full border px-2 py-0.5 font-medium ${isLlm ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{isLlm ? 'AI (LLM)' : 'AI (rules)'}</span>
                      {conf != null && <span className={`rounded-full border px-2 py-0.5 font-medium ${conf >= 80 ? 'bg-green-50 text-green-700 border-green-200' : conf >= 50 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-red-50 text-red-700 border-red-200'}`}>conf {conf}%</span>}
                      {e.ai_intent && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{e.ai_intent}</span>}
                      <span className="ml-auto font-bold text-slate-800">{formatCurrency(total)}</span>
                      {e.ai_reviewed ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 font-semibold text-green-700">✓ Reviewed</span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">Pending review</span>
                      )}
                    </div>

                    {/* User's original message */}
                    {e.ai_prompt && (
                      <div className="mt-2 rounded-lg border-l-4 border-indigo-300 bg-indigo-50/50 px-3 py-1.5 text-sm text-slate-700 italic">“{e.ai_prompt}”</div>
                    )}

                    {/* Resulting double-entry */}
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs">
                        <tbody>
                          {(e.entries || []).map((l, i) => (
                            <tr key={i} className="border-b border-slate-50 last:border-0">
                              <td className="py-1 pr-2 text-slate-700">Dr <span className="font-medium">{l.debitAccount}</span></td>
                              <td className="py-1 pr-2 text-slate-700">Cr <span className="font-medium">{l.creditAccount}</span></td>
                              <td className="py-1 text-right font-mono text-slate-800">{formatCurrency(l.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {e.narration && <div className="mt-1 text-xs text-slate-500">{e.narration}</div>}

                    {/* Issues surfaced at posting time */}
                    {warnings.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {warnings.map((i, idx) => (
                          <span key={idx} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${i.level === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`} title={i.message}>{i.code || i.level}</span>
                        ))}
                      </div>
                    )}

                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                      <span>
                        {e.ai_reviewed
                          ? `Reviewed by ${e.ai_reviewed_by_name || e.ai_reviewed_by || '—'}${e.ai_reviewed_at ? ` on ${e.ai_reviewed_at.slice(0, 10)}` : ''}`
                          : `Created ${e.created_at ? e.created_at.slice(0, 10) : ''}`}
                      </span>
                      {canEditFinance && (
                        <button
                          onClick={() => toggleAiReviewed(e)}
                          className={`rounded-lg px-3 py-1 text-xs font-semibold ${e.ai_reviewed ? 'border border-slate-300 text-slate-600 hover:bg-slate-50' : 'bg-green-600 text-white hover:bg-green-700'}`}
                        >{e.ai_reviewed ? 'Reopen' : 'Mark reviewed'}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'journal' && (
        <div className="space-y-3">
          {offlineQueueCount > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center justify-between">
              <span>📥 {offlineQueueCount} draft{offlineQueueCount === 1 ? '' : 's'} queued offline — will sync when reconnected.</span>
              <button
                onClick={async () => {
                  const result = await flushQueue(appId, async (collName, pl) => {
                    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', collName), pl);
                  });
                  if (result.flushed > 0) addToast(`Synced ${result.flushed} queued draft(s)`, 'success');
                  if (result.failed > 0) addToast(`${result.failed} still pending`, 'error');
                  await refreshQueueCount();
                }}
                className="rounded bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-700"
              >Retry now</button>
            </div>
          )}
          {(journalTemplates.length > 0 || canEditFinance) && (
            <div className="overflow-hidden rounded-xl border-2 border-purple-200 bg-purple-50/30">
              <div className="flex items-center justify-between px-3 py-2 border-b border-purple-200 bg-purple-50">
                <div className="text-sm font-semibold text-purple-700">Journal Templates ({journalTemplates.length})</div>
                <div className="flex items-center gap-2">
                  {canEditFinance && selectedTemplateIds.size > 0 ? (
                    <>
                      <span className="text-[11px] font-semibold text-purple-700">{selectedTemplateIds.size} selected</span>
                      <button onClick={handleBulkExportTemplates} className="rounded border border-purple-300 bg-white px-2 py-1 text-[11px] font-semibold text-purple-700 hover:bg-purple-50" title="Download selected as JSON">Export selected</button>
                      <input
                        type="text"
                        list="template-category-options"
                        value={bulkRecategorize}
                        onChange={(e) => setBulkRecategorize(e.target.value)}
                        placeholder="New category…"
                        className="rounded border border-purple-300 px-2 py-1 text-[11px] w-32"
                      />
                      <button onClick={handleBulkRecategorize} className="rounded bg-purple-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-purple-700">Recategorize</button>
                      <button onClick={handleBulkDeleteTemplates} className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700">Delete</button>
                      <button onClick={clearTemplateSelection} className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">Clear</button>
                    </>
                  ) : (
                    <>
                      <span className="text-[11px] text-purple-600 hidden sm:inline">One-click drafts for recurring entries</span>
                      {canEditFinance && (
                        <>
                          <button
                            onClick={handleExportTemplates}
                            disabled={journalTemplates.length === 0}
                            className="rounded border border-purple-300 bg-white px-2 py-1 text-[11px] font-semibold text-purple-700 hover:bg-purple-50 disabled:opacity-40"
                            title="Download all templates as JSON"
                          >Export</button>
                          <label className="cursor-pointer rounded border border-purple-300 bg-white px-2 py-1 text-[11px] font-semibold text-purple-700 hover:bg-purple-50" title="Upload a JSON file to import templates">
                            Import
                            <input type="file" accept="application/json,.json" className="hidden" onChange={handleImportTemplates} />
                          </label>
                          <button
                            onClick={() => setEditingTemplate({
                              id: null,
                              name: '',
                              category: '',
                              narration: '',
                              party_name: '',
                              entries: [{ debitAccount: '', creditAccount: '', amount: '{{amount|amount}}' }],
                            })}
                            className="rounded bg-purple-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-purple-700"
                          >+ New Template</button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              {journalTemplates.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-purple-600/70">
                  No templates yet. Click <strong>+ New Template</strong> above, or save any parked draft as a template.
                </div>
              ) : (
                <>
                  {(() => {
                    const cats = Array.from(new Set(journalTemplates.map((t) => t.category).filter(Boolean))).sort();
                    if (cats.length === 0) return null;
                    return (
                      <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b border-purple-100 bg-white/60">
                        <span className="text-[10px] uppercase font-semibold text-purple-600 mr-1">Filter:</span>
                        <button
                          onClick={() => setTemplateCategoryFilter('all')}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${templateCategoryFilter === 'all' ? 'bg-purple-600 text-white' : 'bg-white border border-purple-200 text-purple-700 hover:bg-purple-50'}`}
                        >All</button>
                        {cats.map((c) => (
                          <button
                            key={c}
                            onClick={() => setTemplateCategoryFilter(c)}
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${templateCategoryFilter === c ? 'bg-purple-600 text-white' : 'bg-white border border-purple-200 text-purple-700 hover:bg-purple-50'}`}
                          >{c}</button>
                        ))}
                        <button
                          onClick={() => setTemplateCategoryFilter('__uncat__')}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${templateCategoryFilter === '__uncat__' ? 'bg-purple-600 text-white' : 'bg-white border border-purple-200 text-purple-700 hover:bg-purple-50'}`}
                        >Uncategorized</button>
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap gap-2 p-3">
                {journalTemplates
                  .filter((t) => templateCategoryFilter === 'all' ? true : templateCategoryFilter === '__uncat__' ? !t.category : t.category === templateCategoryFilter)
                  .slice()
                  .sort((a, b) => (b.uses || 0) - (a.uses || 0) || (a.name || '').localeCompare(b.name || ''))
                  .map((tpl) => {
                    const firstLine = (tpl.entries || [])[0] || {};
                    return (
                      <div key={tpl.id} className="group relative rounded-lg border border-purple-200 bg-white px-3 py-2 shadow-sm hover:border-purple-400 hover:shadow-md transition">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex items-start gap-2">
                            {canEditFinance && (
                              <input
                                type="checkbox"
                                checked={selectedTemplateIds.has(tpl.id)}
                                onChange={() => toggleTemplateSelection(tpl.id)}
                                className="mt-1 h-3.5 w-3.5 cursor-pointer rounded border-purple-300 text-purple-600"
                                title="Select for bulk action"
                              />
                            )}
                            <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <div className="text-sm font-semibold text-slate-800 truncate max-w-[180px]" title={tpl.name}>{tpl.name}</div>
                              {tpl.category && <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-semibold text-purple-700 uppercase">{tpl.category}</span>}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[200px]" title={`${firstLine.debitAccount || '—'} → ${firstLine.creditAccount || '—'}`}>
                              {firstLine.debitAccount || '—'} → {firstLine.creditAccount || '—'}
                              {(tpl.entries || []).length > 1 && <span className="ml-1 text-slate-400">+{(tpl.entries || []).length - 1}</span>}
                            </div>
                            {(tpl.uses || 0) > 0 && <div className="text-[10px] text-purple-600 font-semibold mt-0.5">Used {tpl.uses}×</div>}
                            {extractVariables(tpl).length > 0 && (
                              <div className="text-[10px] text-slate-500 mt-0.5" title="Will prompt for these on Use">
                                Vars: {extractVariables(tpl).map((v) => v.name).join(', ')}
                              </div>
                            )}
                            </div>
                          </div>
                          {canEditFinance && (
                            <div className="flex flex-col gap-1 shrink-0">
                              <button
                                onClick={() => handleUseTemplate(tpl)}
                                className="rounded bg-purple-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-purple-700"
                              >Use</button>
                              <button
                                onClick={() => setRecurringFromTpl({
                                  tpl,
                                  frequency: 'monthly',
                                  interval: 1,
                                  dayOfMonth: new Date().getDate(),
                                  startDate: new Date().toISOString().slice(0, 10),
                                  endDate: '',
                                  active: true,
                                })}
                                className="rounded border border-purple-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-purple-700 hover:bg-purple-50"
                                title="Schedule this template to auto-generate drafts"
                              >↻ Schedule</button>
                              <button
                                onClick={() => setEditingTemplate({
                                  id: tpl.id,
                                  name: tpl.name || '',
                                  category: tpl.category || '',
                                  narration: tpl.narration || '',
                                  party_name: tpl.party_name || '',
                                  entries: (tpl.entries || []).map((e) => ({
                                    debitAccount: e.debitAccount || '',
                                    creditAccount: e.creditAccount || '',
                                    amount: e.amount,
                                  })),
                                })}
                                className="rounded border border-purple-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-purple-700 hover:bg-purple-50"
                                title="Edit template"
                              >Edit</button>
                              <button
                                onClick={() => handleDeleteTemplate(tpl)}
                                className="rounded border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600"
                                title="Delete template"
                              >×</button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                </>
              )}
            </div>
          )}

          {journalDrafts.length > 0 && (
            <div className="overflow-hidden rounded-xl border-2 border-indigo-200 bg-indigo-50/30">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-indigo-200 bg-indigo-50">
                <div className="text-sm font-semibold text-indigo-700">Parked Drafts ({journalDrafts.length})</div>
                {canEditFinance && selectedDraftIds.size > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold text-indigo-700">{selectedDraftIds.size} selected</span>
                    <button onClick={handleBulkPostDrafts} className="rounded bg-green-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-700">Post selected</button>
                    <input
                      type="date"
                      value={bulkScheduleDate}
                      onChange={(e) => setBulkScheduleDate(e.target.value)}
                      className="rounded border border-indigo-300 px-2 py-1 text-[11px]"
                      title="Pick a date, then click Schedule"
                    />
                    <button
                      onClick={handleBulkScheduleDrafts}
                      disabled={!bulkScheduleDate}
                      className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                    >Schedule selected</button>
                    <button onClick={handleBulkDeleteDrafts} className="rounded border border-red-300 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50">Discard</button>
                    <button onClick={() => setSelectedDraftIds(new Set())} className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">Clear</button>
                  </div>
                ) : (
                  <div className="text-[11px] text-indigo-600">Not yet posted to the ledger</div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-indigo-50 text-xs uppercase text-indigo-600">
                    <tr>
                      {canEditFinance && (
                        <th className="px-3 py-2 text-center w-8">
                          <input
                            type="checkbox"
                            checked={selectedDraftIds.size === journalDrafts.length && journalDrafts.length > 0}
                            onChange={toggleAllDrafts}
                            title="Select all"
                          />
                        </th>
                      )}
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Party / Narration</th>
                      <th className="px-3 py-2 text-left">Dr → Cr</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      {canEditFinance && <th className="px-3 py-2 text-center">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-100">
                    {journalDrafts
                      .slice()
                      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
                      .map((d) => {
                        const line = (d.entries || [])[0] || {};
                        const amt = (d.entries || []).reduce((s, e) => s + (e.amount || 0), 0);
                        return (
                          <tr key={d.id} className="hover:bg-indigo-50/50">
                            {canEditFinance && (
                              <td className="px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={selectedDraftIds.has(d.id)}
                                  onChange={() => toggleDraftSelection(d.id)}
                                />
                              </td>
                            )}
                            <td className="px-3 py-2">{d.date}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium text-slate-700">{d.party_name || d.narration || '—'}</div>
                              {d.raw_prompt && <div className="text-[10px] text-slate-400 italic truncate max-w-[260px]" title={d.raw_prompt}>"{d.raw_prompt}"</div>}
                              {d.schedule_post_on && (
                                <div className={`text-[10px] font-semibold mt-0.5 ${d.schedule_post_on <= new Date().toISOString().slice(0,10) ? 'text-red-600' : 'text-indigo-600'}`}>
                                  ⏱ Auto-post on {d.schedule_post_on}
                                </div>
                              )}
                              {draftAudits[d.id] && (
                                <div
                                  className={`text-[10px] font-semibold mt-0.5 ${draftAudits[d.id].status === 'approved' ? 'text-green-600' : 'text-amber-600'}`}
                                  title={draftAudits[d.id].top || 'Orchestrator audit verdict'}
                                >
                                  {draftAudits[d.id].status === 'approved' ? '✓ audit ok' : `⚠ review (${draftAudits[d.id].score}/100)`}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs">
                              <span className="text-slate-600">{line.debitAccount || '—'}</span>
                              <span className="mx-1 text-slate-400">→</span>
                              <span className="text-slate-600">{line.creditAccount || '—'}</span>
                              {(d.entries || []).length > 1 && <span className="ml-1 text-[10px] text-slate-400">+{(d.entries || []).length - 1} more</span>}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold">{formatCurrency(amt)}</td>
                            {canEditFinance && (
                              <td className="px-3 py-2 text-center space-x-1">
                                <button
                                  onClick={() => handlePostDraft(d)}
                                  className="rounded bg-green-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-700"
                                >
                                  Post
                                </button>
                                <button
                                  onClick={() => setEditingDraft({
                                    id: d.id,
                                    date: d.date || new Date().toISOString().slice(0, 10),
                                    narration: d.narration || '',
                                    party_name: d.party_name || '',
                                    entries: (d.entries || []).map((e) => ({
                                      debitAccount: e.debitAccount || '',
                                      creditAccount: e.creditAccount || '',
                                      amount: e.amount || 0,
                                    })),
                                    schedule_post_on: d.schedule_post_on || '',
                                    attachments: d.attachments || [],
                                  })}
                                  className="rounded border border-indigo-300 bg-white px-2 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-50"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleSaveDraftAsTemplate(d)}
                                  className="rounded border border-purple-300 bg-white px-2 py-1 text-[11px] font-semibold text-purple-700 hover:bg-purple-50"
                                  title="Save the account structure as a reusable template"
                                >
                                  Save as Template
                                </button>
                                <button
                                  onClick={() => handleDeleteDraft(d)}
                                  className="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                                >
                                  Discard
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Ref</th>
                    <th className="px-3 py-2 text-left">Debit Account</th>
                    <th className="px-3 py-2 text-left">Credit Account</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-center w-16">Files</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snapshot.journal.map((row, idx) => {
                    const atts = attachmentsByVoucher[row.refNo] || [];
                    return (
                      <tr key={`${row.refNo}-${idx}`}>
                        <td className="px-3 py-2">{row.date || '-'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{row.refNo || row.source}</td>
                        <td className="px-3 py-2">{row.debitAccount}</td>
                        <td className="px-3 py-2">{row.creditAccount}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.amount)}</td>
                        <td className="px-3 py-2 text-center">
                          {atts.length > 0 ? (
                            <button
                              onClick={() => setAttachmentsModal({ voucher: row.refNo, attachments: atts })}
                              className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-200"
                              title={`${atts.length} file(s) attached`}
                            >📎 {atts.length}</button>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'ledger' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Select Account</label>
            <div className="flex items-center gap-2">
              <select
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                value={selectedLedgerRow?.account || ''}
                onChange={(e) => setSelectedLedger(e.target.value)}
              >
                {snapshot.ledger.length === 0 && <option value="">No accounts found</option>}
                {snapshot.ledger.map((row) => (
                  <option key={row.accountId || row.account} value={row.account}>
                    {row.account} ({row.balanceType} {formatCurrency(Math.abs(row.balance))})
                  </option>
                ))}
              </select>
              {selectedLedgerRow && (
                <button
                  onClick={() => {
                    const a = accountLedgerAnswer(snapshot.ledger, selectedLedgerRow.account, formatCurrency);
                    generateLedgerPdf(selectedLedgerRow.account, a.rows, { orgName, fyLabel: fyFilter, closing: a.closing, closingType: a.closingType });
                  }}
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Download size={13} /> Print PDF
                </button>
              )}
            </div>
          </div>
          {selectedLedgerRow && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-center">
                  <p className="text-xs font-semibold uppercase text-green-600">Total Debit</p>
                  <p className="mt-1 text-lg font-bold text-green-800">{formatCurrency(selectedLedgerRow.debit)}</p>
                </div>
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-center">
                  <p className="text-xs font-semibold uppercase text-red-600">Total Credit</p>
                  <p className="mt-1 text-lg font-bold text-red-800">{formatCurrency(selectedLedgerRow.credit)}</p>
                </div>
                <div className={`rounded-xl border p-3 text-center ${selectedLedgerRow.balance >= 0 ? 'border-blue-200 bg-blue-50' : 'border-amber-200 bg-amber-50'}`}>
                  <p className={`text-xs font-semibold uppercase ${selectedLedgerRow.balance >= 0 ? 'text-blue-600' : 'text-amber-600'}`}>Net Balance</p>
                  <p className={`mt-1 text-lg font-bold ${selectedLedgerRow.balance >= 0 ? 'text-blue-800' : 'text-amber-800'}`}>
                    {formatCurrency(Math.abs(selectedLedgerRow.balance))} {selectedLedgerRow.balanceType}
                  </p>
                </div>
              </div>
              {/* Entries table */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-left">Type</th>
                        <th className="px-3 py-2 text-left">Ref / Narration</th>
                        <th className="px-3 py-2 text-left">Contra Account</th>
                        <th className="px-3 py-2 text-right text-green-700">Debit (Dr)</th>
                        <th className="px-3 py-2 text-right text-red-700">Credit (Cr)</th>
                        <th className="px-3 py-2 text-right">Running Bal.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(() => {
                        let running = 0;
                        return selectedLedgerRow.entries.map((row, idx) => {
                          running += row.side === 'Dr' ? row.amount : -row.amount;
                          const sourceLabel = {
                            sales_invoice: 'Sale',
                            non_invoiced_sales: 'Sale (Pending Inv)',
                            purchase_invoice: 'Purchase',
                            receipt: 'Payment Recd',
                            vendor_payment: 'Payment Made',
                            expense: 'Expense',
                            employee_payout: 'Salary',
                            employee_reimbursement: 'Reimbursement',
                            employee_advance: 'Advance',
                            opening_balance: 'Opening Bal',
                            manual_journal: 'Journal Entry',
                            fy_closing: 'FY Closing',
                          }[row.source] || row.source;
                          const contra = row.side === 'Dr' ? row.creditAccount : row.debitAccount;
                          return (
                            <tr key={`${row.refNo}-${idx}`} className="hover:bg-slate-50">
                              <td className="px-3 py-2 whitespace-nowrap">{row.date || '-'}</td>
                              <td className="px-3 py-2">
                                <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${
                                  row.source === 'sales_invoice' || row.source === 'non_invoiced_sales'
                                    ? 'bg-green-100 text-green-800'
                                    : row.source === 'purchase_invoice'
                                    ? 'bg-orange-100 text-orange-800'
                                    : row.source === 'receipt'
                                    ? 'bg-blue-100 text-blue-800'
                                    : row.source === 'vendor_payment'
                                    ? 'bg-red-100 text-red-800'
                                    : 'bg-slate-100 text-slate-700'
                                }`}>
                                  {sourceLabel}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <span className="font-mono text-xs">{row.refNo || '-'}</span>
                                {row.remarks && <span className="ml-1 text-xs text-slate-400">— {row.remarks}</span>}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-600">{contra || '-'}</td>
                              <td className="px-3 py-2 text-right font-mono">
                                {row.side === 'Dr' ? <span className="text-green-700">{formatCurrency(row.amount)}</span> : ''}
                              </td>
                              <td className="px-3 py-2 text-right font-mono">
                                {row.side === 'Cr' ? <span className="text-red-700">{formatCurrency(row.amount)}</span> : ''}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-semibold">
                                <span className={running >= 0 ? 'text-green-700' : 'text-red-700'}>
                                  {formatCurrency(Math.abs(running))} {running >= 0 ? 'Dr' : 'Cr'}
                                </span>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          {!selectedLedgerRow && snapshot.ledger.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
              <p className="text-lg font-semibold">No Ledger Data</p>
              <p className="mt-1 text-sm">Create invoices, record payments, or add expenses to see ledger entries.</p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold ${booksAudit.score >= 90 ? 'bg-green-100 text-green-700' : booksAudit.score >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                {booksAudit.grade}
              </div>
              <div>
                <div className="text-sm font-bold text-slate-700">Books health — {booksAudit.score}/100</div>
                <div className="text-xs text-slate-500">{booksAudit.summary.headline} · {booksAudit.summary.postingsChecked} entries checked</div>
              </div>
            </div>
            <button onClick={() => generateAuditPdf(booksAudit, { orgName, fyLabel: fyFilter })} className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Download size={13} /> Download Report
            </button>
          </div>
          {booksAudit.findings.length === 0 ? (
            <div className="rounded-xl border border-green-200 bg-green-50 p-10 text-center text-sm font-semibold text-green-700">✓ Your books look clean — no issues found.</div>
          ) : (
            <div className="space-y-2">
              {booksAudit.findings.map((f, i) => (
                <div key={i} className={`rounded-xl border p-3 ${f.severity === 'blocking' ? 'border-red-200 bg-red-50' : f.severity === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-blue-200 bg-blue-50'}`}>
                  <div className="flex items-start gap-2">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${f.severity === 'blocking' ? 'bg-red-200 text-red-800' : f.severity === 'warning' ? 'bg-amber-200 text-amber-800' : 'bg-blue-200 text-blue-800'}`}>{f.severity}</span>
                    <div className="text-sm text-slate-700">
                      {f.message}
                      {f.fix && <div className="mt-0.5 text-xs text-slate-500">→ {f.fix}</div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-400">Read-only review of your posted books — nothing is changed. Fix each item from its respective tab.</p>
        </div>
      )}

      {activeTab === 'trial' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className={`flex-1 rounded-xl border p-3 text-sm font-semibold ${snapshot.trialBalance.isBalanced ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
              Total Dr: {formatCurrency(snapshot.trialBalance.totalDebit)} | Total Cr: {formatCurrency(snapshot.trialBalance.totalCredit)} | Difference: {formatCurrency(snapshot.trialBalance.difference)}
            </div>
            <button onClick={() => generateTrialBalancePdf(snapshot.trialBalance, { orgName, fyLabel: fyFilter })} className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Download size={13} /> Print PDF
            </button>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Account</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snapshot.trialBalance.rows.map((row) => (
                    <tr key={row.account}>
                      <td className="px-3 py-2">{row.account}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.debit)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.credit)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatCurrency(Math.abs(row.balance))} {row.balanceType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════ GST REPORTS TAB ══════ */}
      {activeTab === 'gst' && (
        <div className="space-y-4">
          {/* Sub-tab navigation */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1.5">
              {[
                { id: 'gstr1', label: 'GSTR-1 (Sales)' },
                { id: 'gstr2', label: 'GSTR-2 (Purchases)' },
                { id: 'gstr3b', label: 'GST Summary' },
                { id: 'hsn', label: 'HSN Summary' },
              ].map(t => (
                <button key={t.id} onClick={() => setGstSubTab(t.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${gstSubTab === t.id ? 'bg-indigo-100 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button onClick={() => exportGstToExcel(gstSubTab)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                <Download size={12} /> Export Current
              </button>
              <button onClick={() => exportGstToExcel('all')} className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700">
                <Download size={12} /> Export All GST
              </button>
              <button onClick={() => exportGstrJson('gstr1')} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700" title="GSTR-1 JSON for portal upload">
                <Download size={12} /> GSTR-1 JSON
              </button>
              <button onClick={() => exportGstrJson('gstr3b')} className="inline-flex items-center gap-1 rounded-lg bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800" title="GSTR-3B JSON for portal upload">
                <Download size={12} /> GSTR-3B JSON
              </button>
            </div>
          </div>

          {orgGstin && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Your GSTIN: <span className="font-mono font-semibold text-slate-800">{orgGstin}</span>
              <span className="ml-2 text-slate-400">|</span>
              <span className="ml-2">State: {orgGstin.substring(0, 2)}</span>
            </div>
          )}

          {/* ── GSTR-1: Outward Supplies ── */}
          {gstSubTab === 'gstr1' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                <strong>GSTR-1 — Outward Supplies (Sales)</strong>: All invoiced sales with client GSTIN and GST breakup. Use this data to file your GSTR-1 return.
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-left">Invoice No</th>
                        <th className="px-3 py-2 text-left">Client</th>
                        <th className="px-3 py-2 text-left">GSTIN</th>
                        <th className="px-3 py-2 text-left">Supply</th>
                        <th className="px-3 py-2 text-right">Taxable</th>
                        <th className="px-3 py-2 text-right">CGST</th>
                        <th className="px-3 py-2 text-right">SGST</th>
                        <th className="px-3 py-2 text-right">IGST</th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {gstData.gstr1.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-3 py-2">{r.date || '-'}</td>
                          <td className="px-3 py-2 font-mono text-xs font-semibold">{r.invoiceNo}</td>
                          <td className="px-3 py-2">{r.clientName}</td>
                          <td className="px-3 py-2 font-mono text-xs">{r.clientGstin || <span className="text-orange-500">Unregistered</span>}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${r.supplyType === 'Intra-State' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}`}>{r.supplyType}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{formatCurrency(r.taxable)}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{r.cgst ? formatCurrency(r.cgst) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{r.sgst ? formatCurrency(r.sgst) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-purple-700">{r.igst ? formatCurrency(r.igst) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(r.total)}</td>
                        </tr>
                      ))}
                      {gstData.gstr1.length === 0 && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">No sales invoices for the selected period</td></tr>}
                    </tbody>
                    {gstData.gstr1.length > 0 && (
                      <tfoot className="bg-slate-100 font-semibold text-sm">
                        <tr>
                          <td colSpan={5} className="px-3 py-2 text-right">Total ({gstData.gstr1.length} invoices)</td>
                          <td className="px-3 py-2 text-right font-mono">{formatCurrency(gstData.gstr1.reduce((s, r) => s + r.taxable, 0))}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{formatCurrency(gstData.gstr3b.outputCgst)}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{formatCurrency(gstData.gstr3b.outputSgst)}</td>
                          <td className="px-3 py-2 text-right font-mono text-purple-700">{formatCurrency(gstData.gstr3b.outputIgst)}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(gstData.gstr1.reduce((s, r) => s + r.total, 0))}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── GSTR-2: Inward Supplies ── */}
          {gstSubTab === 'gstr2' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
                <strong>GSTR-2 — Inward Supplies (Purchases)</strong>: All purchase invoices with vendor GSTIN, type (Asset/Service), and input tax credit. Use for GSTR-2 and ITC reconciliation.
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-left">PI No</th>
                        <th className="px-3 py-2 text-left">Vendor</th>
                        <th className="px-3 py-2 text-left">GSTIN</th>
                        <th className="px-3 py-2 text-left">Type</th>
                        <th className="px-3 py-2 text-left">Supply</th>
                        <th className="px-3 py-2 text-right">Taxable</th>
                        <th className="px-3 py-2 text-right">CGST</th>
                        <th className="px-3 py-2 text-right">SGST</th>
                        <th className="px-3 py-2 text-right">IGST</th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {gstData.gstr2.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-3 py-2">{r.date || '-'}</td>
                          <td className="px-3 py-2 font-mono text-xs font-semibold">{r.piNo}</td>
                          <td className="px-3 py-2">{r.vendorName}</td>
                          <td className="px-3 py-2 font-mono text-xs">{r.vendorGstin || <span className="text-orange-500">Unregistered</span>}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${r.type === 'Asset' ? 'bg-emerald-100 text-emerald-800' : 'bg-violet-100 text-violet-800'}`}>{r.type}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${r.supplyType === 'Intra-State' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}`}>{r.supplyType}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{formatCurrency(r.taxable)}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{r.cgst ? formatCurrency(r.cgst) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{r.sgst ? formatCurrency(r.sgst) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono text-purple-700">{r.igst ? formatCurrency(r.igst) : '-'}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(r.total)}</td>
                        </tr>
                      ))}
                      {gstData.gstr2.length === 0 && <tr><td colSpan={11} className="px-3 py-6 text-center text-slate-400">No purchase invoices for the selected period</td></tr>}
                    </tbody>
                    {gstData.gstr2.length > 0 && (
                      <tfoot className="bg-slate-100 font-semibold text-sm">
                        <tr>
                          <td colSpan={6} className="px-3 py-2 text-right">Total ({gstData.gstr2.length} invoices)</td>
                          <td className="px-3 py-2 text-right font-mono">{formatCurrency(gstData.gstr2.reduce((s, r) => s + r.taxable, 0))}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{formatCurrency(gstData.gstr3b.inputCgst)}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{formatCurrency(gstData.gstr3b.inputSgst)}</td>
                          <td className="px-3 py-2 text-right font-mono text-purple-700">{formatCurrency(gstData.gstr3b.inputIgst)}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(gstData.gstr2.reduce((s, r) => s + r.total, 0))}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── GSTR-3B Style Summary ── */}
          {gstSubTab === 'gstr3b' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">
                <strong>GST Summary (GSTR-3B Style)</strong>: Quick view of output tax vs input tax credit and net GST payable to the government.
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {/* Output Tax */}
                <div className="rounded-xl border-2 border-green-200 bg-white p-4">
                  <p className="text-sm font-bold text-green-700">Output Tax (Sales)</p>
                  <p className="text-xs text-green-600 mb-3">GST you collected from clients</p>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span>Taxable Value</span><span className="font-mono font-semibold">{formatCurrency(gstData.gstr3b.outputTaxable)}</span></div>
                    <div className="flex justify-between"><span>CGST</span><span className="font-mono font-semibold text-blue-700">{formatCurrency(gstData.gstr3b.outputCgst)}</span></div>
                    <div className="flex justify-between"><span>SGST</span><span className="font-mono font-semibold text-blue-700">{formatCurrency(gstData.gstr3b.outputSgst)}</span></div>
                    <div className="flex justify-between"><span>IGST</span><span className="font-mono font-semibold text-purple-700">{formatCurrency(gstData.gstr3b.outputIgst)}</span></div>
                    <div className="flex justify-between border-t pt-2 font-bold"><span>Total Output GST</span><span className="font-mono text-green-800">{formatCurrency(gstData.gstr3b.outputTotal)}</span></div>
                  </div>
                </div>
                {/* Input Tax Credit */}
                <div className="rounded-xl border-2 border-orange-200 bg-white p-4">
                  <p className="text-sm font-bold text-orange-700">Input Tax Credit (Purchases)</p>
                  <p className="text-xs text-orange-600 mb-3">GST you paid to vendors</p>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span>Taxable Value</span><span className="font-mono font-semibold">{formatCurrency(gstData.gstr3b.inputTaxable)}</span></div>
                    <div className="flex justify-between"><span>CGST</span><span className="font-mono font-semibold text-blue-700">{formatCurrency(gstData.gstr3b.inputCgst)}</span></div>
                    <div className="flex justify-between"><span>SGST</span><span className="font-mono font-semibold text-blue-700">{formatCurrency(gstData.gstr3b.inputSgst)}</span></div>
                    <div className="flex justify-between"><span>IGST</span><span className="font-mono font-semibold text-purple-700">{formatCurrency(gstData.gstr3b.inputIgst)}</span></div>
                    <div className="flex justify-between border-t pt-2 font-bold"><span>Total Input ITC</span><span className="font-mono text-orange-800">{formatCurrency(gstData.gstr3b.inputTotal)}</span></div>
                  </div>
                </div>
                {/* Net Payable */}
                <div className={`rounded-xl border-2 p-4 ${gstData.gstr3b.netPayable >= 0 ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'}`}>
                  <p className={`text-sm font-bold ${gstData.gstr3b.netPayable >= 0 ? 'text-red-700' : 'text-green-700'}`}>
                    {gstData.gstr3b.netPayable >= 0 ? '💸 Net GST Payable' : '💰 Net GST Refundable'}
                  </p>
                  <p className={`text-xs mb-3 ${gstData.gstr3b.netPayable >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {gstData.gstr3b.netPayable >= 0 ? 'Amount to pay the government' : 'ITC excess — carry forward or claim refund'}
                  </p>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span>CGST</span><span className={`font-mono font-semibold ${gstData.gstr3b.netCgst >= 0 ? 'text-red-700' : 'text-green-700'}`}>{formatCurrency(Math.abs(gstData.gstr3b.netCgst))}</span></div>
                    <div className="flex justify-between"><span>SGST</span><span className={`font-mono font-semibold ${gstData.gstr3b.netSgst >= 0 ? 'text-red-700' : 'text-green-700'}`}>{formatCurrency(Math.abs(gstData.gstr3b.netSgst))}</span></div>
                    <div className="flex justify-between"><span>IGST</span><span className={`font-mono font-semibold ${gstData.gstr3b.netIgst >= 0 ? 'text-red-700' : 'text-green-700'}`}>{formatCurrency(Math.abs(gstData.gstr3b.netIgst))}</span></div>
                    <div className="flex justify-between border-t pt-2 font-bold text-lg">
                      <span>Total</span>
                      <span className={`font-mono ${gstData.gstr3b.netPayable >= 0 ? 'text-red-800' : 'text-green-800'}`}>{formatCurrency(Math.abs(gstData.gstr3b.netPayable))}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── HSN Summary ── */}
          {gstSubTab === 'hsn' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <strong>HSN/SAC Summary</strong>: Taxable value and GST grouped by HSN/SAC code. Required for GSTR-1 Annexure and annual return.
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">HSN/SAC</th>
                        <th className="px-3 py-2 text-right">GST Rate</th>
                        <th className="px-3 py-2 text-right">Sales Taxable</th>
                        <th className="px-3 py-2 text-right">Sales GST</th>
                        <th className="px-3 py-2 text-right">Purchase Taxable</th>
                        <th className="px-3 py-2 text-right">Purchase GST</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {gstData.hsnSummary.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-3 py-2 font-mono font-semibold">{r.hsn}</td>
                          <td className="px-3 py-2 text-right">{r.gstRate}%</td>
                          <td className="px-3 py-2 text-right font-mono text-green-700">{formatCurrency(r.salesTaxable)}</td>
                          <td className="px-3 py-2 text-right font-mono text-green-700">{formatCurrency(r.salesGst)}</td>
                          <td className="px-3 py-2 text-right font-mono text-orange-700">{formatCurrency(r.purchaseTaxable)}</td>
                          <td className="px-3 py-2 text-right font-mono text-orange-700">{formatCurrency(r.purchaseGst)}</td>
                        </tr>
                      ))}
                      {gstData.hsnSummary.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No HSN data for the selected period</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'coa' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3 grid gap-2 sm:grid-cols-6">
            <input className="rounded border border-slate-300 px-2 py-2 text-sm text-black" placeholder="Code" value={coaForm.code} onChange={(e) => setCoaForm((f) => ({ ...f, code: e.target.value }))} />
            <input className="rounded border border-slate-300 px-2 py-2 text-sm text-black sm:col-span-2" placeholder="Account Name" value={coaForm.name} onChange={(e) => setCoaForm((f) => ({ ...f, name: e.target.value }))} />
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black" value={coaForm.type} onChange={(e) => setCoaForm((f) => ({ ...f, type: e.target.value }))}>
              {ACCOUNT_TYPES.map((row) => <option key={row} value={row}>{row}</option>)}
            </select>
            <input className="rounded border border-slate-300 px-2 py-2 text-sm text-black" placeholder="Sub Type" value={coaForm.subType} onChange={(e) => setCoaForm((f) => ({ ...f, subType: e.target.value }))} />
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black" value={coaForm.normalSide} onChange={(e) => setCoaForm((f) => ({ ...f, normalSide: e.target.value }))}>
              <option value="Dr">Dr</option>
              <option value="Cr">Cr</option>
            </select>
            <button disabled={isSaving} onClick={addAccount} className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">Add Account</button>
            <button disabled={isSaving} onClick={seedDefaultCoa} className="rounded border border-indigo-300 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">Seed Default COA</button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Code</th>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Sub Type</th>
                    <th className="px-3 py-2 text-left">Normal</th>
                    <th className="px-3 py-2 text-left">Source</th>
                    <th className="px-3 py-2 text-left">Active</th>
                    {canEditFinance && <th className="px-3 py-2 text-center">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {chartOfAccounts
                    .slice()
                    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')))
                    .map((row) => (
                      <tr key={row.id || row.code} className={row.isActive === false ? 'opacity-50' : ''}>
                        <td className="px-3 py-2 font-mono">{row.code}</td>
                        <td className="px-3 py-2">{row.name}</td>
                        {coaEditId === (row.id || row.code) ? (
                          <>
                            <td className="px-3 py-1">
                              <select className="rounded border border-indigo-300 px-1 py-1 text-xs text-black" value={coaEditForm.type} onChange={(e) => setCoaEditForm((f) => ({ ...f, type: e.target.value }))}>
                                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-1">
                              <input className="w-28 rounded border border-indigo-300 px-1 py-1 text-xs text-black" value={coaEditForm.subType} onChange={(e) => setCoaEditForm((f) => ({ ...f, subType: e.target.value }))} />
                            </td>
                            <td className="px-3 py-1">
                              <select className="rounded border border-indigo-300 px-1 py-1 text-xs text-black" value={coaEditForm.normalSide} onChange={(e) => setCoaEditForm((f) => ({ ...f, normalSide: e.target.value }))}>
                                <option value="Dr">Dr</option><option value="Cr">Cr</option>
                              </select>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-2">{row.type}</td>
                            <td className="px-3 py-2">{row.subType || '-'}</td>
                            <td className="px-3 py-2">{row.normalSide || '-'}</td>
                          </>
                        )}
                        <td className="px-3 py-2 text-xs">{row.isSystem ? 'System' : 'Manual'}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className={`rounded px-1.5 py-0.5 font-semibold ${row.isActive === false ? 'bg-slate-200 text-slate-500' : 'bg-green-100 text-green-700'}`}>{row.isActive === false ? 'Inactive' : 'Active'}</span>
                        </td>
                        {canEditFinance && (
                          <td className="px-3 py-2 text-center text-xs">
                            {coaEditId === (row.id || row.code) ? (
                              <>
                                <button onClick={() => saveCoaEdit(row)} className="mr-1 rounded bg-indigo-600 px-2 py-0.5 font-semibold text-white hover:bg-indigo-700">Save</button>
                                <button onClick={() => setCoaEditId(null)} className="rounded border border-slate-300 px-2 py-0.5 font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => { setCoaEditId(row.id || row.code); setCoaEditForm({ type: row.type || 'Asset', subType: row.subType || '', normalSide: row.normalSide || 'Dr' }); }} className="mr-1 rounded border border-slate-300 px-2 py-0.5 font-semibold text-slate-600 hover:bg-slate-50">Edit</button>
                                <button onClick={() => toggleCoaActive(row)} className={`rounded border px-2 py-0.5 font-semibold ${row.isActive === false ? 'border-green-300 text-green-700 hover:bg-green-50' : 'border-amber-300 text-amber-700 hover:bg-amber-50'}`}>
                                  {row.isActive === false ? 'Reactivate' : 'Deactivate'}
                                </button>
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'manual' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3 grid gap-2 sm:grid-cols-6">
            <input type="date" className="rounded border border-slate-300 px-2 py-2 text-sm text-black" value={journalForm.date} onChange={(e) => setJournalForm((f) => ({ ...f, date: e.target.value }))} />
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black sm:col-span-2" value={journalForm.debitAccount} onChange={(e) => setJournalForm((f) => ({ ...f, debitAccount: e.target.value }))}>
              <option value="">Debit Account</option>
              {pickerAccounts.map((row) => <option key={`dr-${row}`} value={row}>{row}</option>)}
            </select>
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black sm:col-span-2" value={journalForm.creditAccount} onChange={(e) => setJournalForm((f) => ({ ...f, creditAccount: e.target.value }))}>
              <option value="">Credit Account</option>
              {pickerAccounts.map((row) => <option key={`cr-${row}`} value={row}>{row}</option>)}
            </select>
            <input type="number" min="0" step="0.01" className="rounded border border-slate-300 px-2 py-2 text-sm text-black" placeholder="Amount" value={journalForm.amount} onChange={(e) => setJournalForm((f) => ({ ...f, amount: e.target.value }))} />
            <input className="rounded border border-slate-300 px-2 py-2 text-sm text-black sm:col-span-4" placeholder="Narration" value={journalForm.narration} onChange={(e) => setJournalForm((f) => ({ ...f, narration: e.target.value }))} />
            <select
              className="rounded border border-slate-300 px-2 py-2 text-sm text-black"
              value={journalForm.currency || 'INR'}
              onChange={(e) => setJournalForm((f) => ({ ...f, currency: e.target.value, fx_rate_to_inr: e.target.value === 'INR' ? 1 : f.fx_rate_to_inr }))}
              title="Currency"
            >
              <option value="INR">INR</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="AED">AED</option>
              <option value="SGD">SGD</option>
            </select>
            <input
              type="number" min="0" step="0.0001"
              className="rounded border border-slate-300 px-2 py-2 text-sm text-black"
              placeholder="FX → INR"
              value={journalForm.fx_rate_to_inr || 1}
              onChange={(e) => setJournalForm((f) => ({ ...f, fx_rate_to_inr: e.target.value }))}
              disabled={(journalForm.currency || 'INR') === 'INR'}
              title="FX rate snapshot at post time"
            />
            <button disabled={isSaving} onClick={postManualJournal} className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">Post Journal</button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Voucher</th>
                    <th className="px-3 py-2 text-left">Narration</th>
                    <th className="px-3 py-2 text-right">Entries</th>
                    <th className="px-3 py-2 text-right">Source</th>
                    {canEditFinance && <th className="px-3 py-2 text-center">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {manualJournalEntries
                    .filter((row) => (fyFilter === 'all' ? true : row.fy === fyFilter))
                    .slice()
                    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
                    .map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2">{row.date}</td>
                        <td className="px-3 py-2 font-mono text-xs">{row.voucher_no}</td>
                        <td className="px-3 py-2">{row.narration || '-'}</td>
                        <td className="px-3 py-2 text-right text-xs">{(row.entries || []).length}</td>
                        <td className="px-3 py-2 text-right text-xs">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            row.source === 'manual_journal' ? 'bg-indigo-100 text-indigo-700' :
                            row.source === 'fy_closing' ? 'bg-amber-100 text-amber-700' :
                            'bg-slate-100 text-slate-600'
                          }`}>
                            {row.source === 'manual_journal' ? 'Manual' : 
                             row.source === 'fy_closing' ? 'FY Close' : 
                             row.source || 'System'}
                          </span>
                        </td>
                        {canEditFinance && (
                          <td className="px-3 py-2 text-center">
                            <div className="inline-flex items-center gap-1">
                              {row.status !== 'draft' && !row.reversed && !row.reversed_by && !row.is_reversal
                                && row.source !== 'fy_closing' && !/reversal/i.test(row.source || '') && (
                                <button
                                  onClick={() => handleReverseJournalEntry(row)}
                                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 transition"
                                  title="Post a reversal voucher (M-6)"
                                  disabled={isSaving}
                                >
                                  Reverse
                                </button>
                              )}
                              {(row.reversed || row.reversed_by) && (
                                <span className="text-[10px] text-slate-500" title={`Reversed by ${row.reversed_by_voucher_no || row.reversed_by || ''}`}>Reversed</span>
                              )}
                              <button
                                onClick={() => handleDeleteJournalEntry(row)}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 transition disabled:opacity-40"
                                title={row.source === 'manual_journal' && row.status !== 'draft' ? 'Posted manual JVs cannot be deleted — use Reverse' : 'Delete entry'}
                                disabled={isSaving || (row.source === 'manual_journal' && row.status !== 'draft')}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'recurring' && (
        <RecurringEntries
          db={db}
          appId={appId}
          role={role}
          user={user}
          recurringRules={recurringRules}
          chartOfAccounts={chartOfAccounts}
          logAction={logAction}
          addToast={addToast}
          lockedFYs={lockedFYs}
        />
      )}

      {activeTab === 'reconcile' && (
        <BankReconciliation
          db={db}
          appId={appId}
          role={role}
          user={user}
          manualJournalEntries={manualJournalEntries}
          chartOfAccounts={chartOfAccounts}
          ledger={snapshot.ledger}
          partyNames={partyNames}
          allAccounts={allAccounts}
          closedFYs={fiscalYearClosings.filter((r) => r.status === 'closed').map((r) => r.fy)}
          getFY={getFYFromDate}
          onBookRow={handleBookBankRow}
          aiEnabled={aiEnabled}
          logAction={logAction}
          addToast={addToast}
        />
      )}

      {activeTab === 'opening' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3 grid gap-2 sm:grid-cols-6">
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black" value={openingForm.fy} onChange={(e) => setOpeningForm((f) => ({ ...f, fy: e.target.value }))}>
              <option value="">Select FY</option>
              {fyOptions.filter((row) => row !== 'all').map((row) => <option key={row} value={row}>{row}</option>)}
            </select>
            <input type="date" className="rounded border border-slate-300 px-2 py-2 text-sm text-black" value={openingForm.date} onChange={(e) => setOpeningForm((f) => ({ ...f, date: e.target.value }))} />
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black sm:col-span-2" value={openingForm.account_name} onChange={(e) => setOpeningForm((f) => ({ ...f, account_name: e.target.value }))}>
              <option value="">Account</option>
              {pickerAccounts.map((row) => <option key={`ob-${row}`} value={row}>{row}</option>)}
            </select>
            <select className="rounded border border-slate-300 px-2 py-2 text-sm text-black" value={openingForm.side} onChange={(e) => setOpeningForm((f) => ({ ...f, side: e.target.value }))}>
              <option value="Dr">Dr</option>
              <option value="Cr">Cr</option>
            </select>
            <input type="number" min="0" step="0.01" className="rounded border border-slate-300 px-2 py-2 text-sm text-black" placeholder="Amount" value={openingForm.amount} onChange={(e) => setOpeningForm((f) => ({ ...f, amount: e.target.value }))} />
            <input className="rounded border border-slate-300 px-2 py-2 text-sm text-black sm:col-span-5" placeholder="Remarks" value={openingForm.remarks} onChange={(e) => setOpeningForm((f) => ({ ...f, remarks: e.target.value }))} />
            <button disabled={isSaving} onClick={addOpeningBalance} className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">Save Opening Balance</button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">FY</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Account</th>
                    <th className="px-3 py-2 text-left">Side</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-left">Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {openingBalances
                    .filter((row) => (fyFilter === 'all' ? true : row.fy === fyFilter))
                    .slice()
                    .sort((a, b) => (b.fy || '').localeCompare(a.fy || '') || (b.date || '').localeCompare(a.date || ''))
                    .map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2">{row.fy}</td>
                        <td className="px-3 py-2">{row.date || '-'}</td>
                        <td className="px-3 py-2">{row.account_name}</td>
                        <td className="px-3 py-2">{row.side}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.amount)}</td>
                        <td className="px-3 py-2">{row.remarks || '-'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'close' && (
        <div className="space-y-3">
          {/* Close-readiness checklist (advisory — nothing is changed automatically) */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className={`mb-3 rounded-lg border px-3 py-2 text-sm font-semibold ${closeChecklist.ready ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {closeChecklist.ready ? '✓ Ready to close — no blockers (review warnings below).' : '✕ Not ready to close — fix the blockers first.'}
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {closeChecklist.items.map((i) => (
                <div key={i.id} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-1.5">
                  <span className={`mt-0.5 shrink-0 text-sm ${i.status === 'ok' ? 'text-green-600' : i.status === 'block' ? 'text-red-600' : i.status === 'warn' ? 'text-amber-600' : 'text-slate-400'}`}>
                    {i.status === 'ok' ? '✓' : i.status === 'block' ? '✕' : i.status === 'warn' ? '!' : '○'}
                  </span>
                  <div>
                    <div className="text-xs font-semibold text-slate-700">{i.label}</div>
                    <div className="text-[11px] text-slate-500">{i.detail}{i.status !== 'ok' && i.hint ? ` — ${i.hint}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>
            {closeChecklist.calendar.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-2">
                <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Compliance calendar</div>
                <div className="flex flex-wrap gap-2">
                  {closeChecklist.calendar.map((c, i) => (
                    <span key={i} className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${c.overdue ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                      {c.overdue ? '⚠ ' : ''}{c.label}{c.amount ? ` (${formatCurrency(c.amount)})` : ''} · due {c.due}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Depreciation — already provided for this FY (same-FY double-post guard) */}
          {depreciationProposal && depreciationProposal.alreadyProvided && (
            <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
              ✓ Depreciation for FY {fyFilter} already {depreciationProposal.alreadyProvided.status === 'draft' ? 'parked as a draft' : 'provided'} — {formatCurrency(depreciationProposal.alreadyProvided.total)}
              {depreciationProposal.alreadyProvided.date ? ` on ${depreciationProposal.alreadyProvided.date}` : ''}
              {depreciationProposal.alreadyProvided.status === 'draft' ? '. Post it from the Drafts panel.' : ` (${depreciationProposal.alreadyProvided.voucher_no}).`}
            </div>
          )}

          {/* Depreciation proposal (advisory — parks a draft, human posts) */}
          {depreciationProposal && depreciationProposal.total > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-bold text-slate-700">Depreciation for FY {fyFilter} — proposed {formatCurrency(depreciationProposal.total)}</div>
                  <div className="text-xs text-slate-500">WDV block rates on the written-down value of your fixed assets (cost − prior schedules). Review, then park as a draft — posting stays with you.</div>
                  {depreciationProposal.unapportionedNote && (
                    <div className="mt-1 text-[11px] text-amber-600">{depreciationProposal.unapportionedNote}</div>
                  )}
                </div>
                {canEditFinance && (
                  <button
                    onClick={() => handleChatParkEntry(depreciationProposal.parsed)}
                    className="shrink-0 rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                  >
                    Park as draft
                  </button>
                )}
              </div>
              <table className="mt-2 w-full text-xs">
                <thead className="text-left uppercase text-slate-400">
                  <tr><th className="py-1">Asset class</th><th className="py-1 text-right">Balance</th><th className="py-1 text-right">Rate</th><th className="py-1 text-right">Depreciation</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {depreciationProposal.proposals.map((p) => (
                    <tr key={p.account}>
                      <td className="py-1 text-slate-700">{p.account}{p.note && <span className="block text-[10px] text-amber-600">{p.note}</span>}</td>
                      <td className="py-1 text-right font-mono">{formatCurrency(p.base)}</td>
                      <td className="py-1 text-right">{p.rate}%</td>
                      <td className="py-1 text-right font-mono font-semibold">{formatCurrency(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-sm text-slate-600">Close selected FY and auto-roll opening balances to next FY.</div>
            <div className="mt-2 text-sm">Current FY: <span className="font-semibold">{fyFilter === 'all' ? 'Select FY' : fyFilter}</span></div>
            <div className="text-sm">Next FY: <span className="font-semibold">{fyFilter === 'all' ? '-' : getNextFinancialYear(fyFilter)}</span></div>
            <div className="text-sm">Net Profit/Loss to transfer: <span className="font-semibold">{formatCurrency(snapshot.profitAndLoss.netProfit)}</span></div>
            <button
              disabled={isSaving || fyFilter === 'all'}
              onClick={closeFinancialYear}
              className="mt-3 rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              Close FY And Rollover
            </button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">FY</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Voucher</th>
                    <th className="px-3 py-2 text-right">Net Profit</th>
                    <th className="px-3 py-2 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fiscalYearClosings
                    .slice()
                    .sort((a, b) => (b.fy || '').localeCompare(a.fy || ''))
                    .map((row) => (
                      <tr key={row.id || row.fy}>
                        <td className="px-3 py-2">{row.fy}</td>
                        <td className="px-3 py-2">{row.date || '-'}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${
                            row.status === 'closed' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700'
                          }`}>{row.status || '-'}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{row.voucher_no || '-'}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.net_profit || 0)}</td>
                        <td className="px-3 py-2 text-center">
                          {row.status === 'closed' && role === 'admin' && (
                            <button
                              disabled={isSaving}
                              onClick={() => undoFinancialYearClose(row)}
                              className="rounded border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                            >
                              Undo Close
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'pl' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <span className="text-sm text-slate-500">How much you earned, how much you spent, and what's left as profit.</span>
            <button onClick={() => generatePnlPdf(snapshot.profitAndLoss, { orgName, fyLabel: fyFilter })} className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Download size={13} /> Print PDF
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-green-200 bg-green-50/50 p-4">
              <div className="text-sm font-semibold text-green-700">💰 Total Earnings (Revenue)</div>
              <p className="text-xs text-green-600 mb-1">Money earned from all projects</p>
              <div className="text-2xl font-bold text-green-800">{formatCurrency(snapshot.profitAndLoss.revenue)}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
              <div className="text-sm font-semibold text-amber-700">📦 Direct Costs (COGS)</div>
              <p className="text-xs text-amber-600 mb-1">Vendor payments, outsourcing, equipment</p>
              <div className="text-2xl font-bold text-amber-800">{formatCurrency(snapshot.profitAndLoss.costOfGoodsSold)}</div>
            </div>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
              <div className="text-sm font-semibold text-indigo-700">📊 Gross Profit</div>
              <p className="text-xs text-indigo-600 mb-1">Earnings minus direct costs</p>
              <div className="text-2xl font-bold text-indigo-800">{formatCurrency(snapshot.profitAndLoss.grossProfit)}</div>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4">
              <div className="text-sm font-semibold text-rose-700">🏢 Running Costs (Expenses)</div>
              <p className="text-xs text-rose-600 mb-1">Salaries, office, travel, misc</p>
              <div className="text-2xl font-bold text-rose-800">{formatCurrency(snapshot.profitAndLoss.operatingExpenses)}</div>
            </div>
            <div className={`rounded-xl border-2 p-5 sm:col-span-2 ${snapshot.profitAndLoss.netProfit >= 0 ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}`}>
              <div className={`text-sm font-semibold ${snapshot.profitAndLoss.netProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                {snapshot.profitAndLoss.netProfit >= 0 ? '🎉 Net Profit' : '⚠️ Net Loss'}
              </div>
              <p className={`text-xs mb-1 ${snapshot.profitAndLoss.netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                What you actually keep after everything is paid
              </p>
              <div className={`text-3xl font-bold ${snapshot.profitAndLoss.netProfit >= 0 ? 'text-green-800' : 'text-red-800'}`}>
                {formatCurrency(Math.abs(snapshot.profitAndLoss.netProfit))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'bs' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <span className="text-sm text-slate-500">A snapshot of what your business owns, owes, and is worth right now.</span>
            <button onClick={() => generateBalanceSheetPdf(snapshot.balanceSheet, { orgName, fyLabel: fyFilter })} className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Download size={13} /> Print PDF
            </button>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {(() => {
              const bsA = snapshot.balanceSheet.assets;
              const bsL = snapshot.balanceSheet.liabilities;
              const bsE = snapshot.balanceSheet.equity;
              // [label, value, alwaysShow?] — optional lines hide when zero.
              const assetLines = [
                ['Cash & Bank Balance', bsA.cashAndBank, true],
                ['Money Owed by Clients', bsA.accountsReceivable, true],
                ['Advances to Staff', bsA.employeeAdvances, true],
                ['GST Refund Due', bsA.inputGstCredit, true],
                ['TDS Receivable', bsA.tdsReceivable],
                ['Prepaid Expenses', bsA.prepaid],
                ['Fixed Assets', bsA.fixedAssets],
                ['(Accumulated Depreciation)', bsA.accumulatedDepreciation],
                ['Suspense (Dr)', bsA.suspense],
                ['Other Assets', bsA.otherAssets],
              ];
              const liabilityLines = [
                ['Vendor Bills Pending', bsL.accountsPayable, true],
                ['Owed to Employees', bsL.employeePayable, true],
                ['GST Payable (gross)', bsL.gstPayableGross, true],
                ['TDS Payable', bsL.tdsPayable],
                ['Loans & Borrowings', bsL.loans],
                ['Outstanding Expenses', bsL.outstandingExpenses],
                ['Suspense (Cr)', bsL.suspense],
                ['Other Liabilities', bsL.otherLiabilities],
              ];
              const equityLines = [
                ['Capital Introduced', bsE.capital],
                ['(Drawings)', bsE.drawings],
                ['Opening Balance Equity', bsE.openingBalanceEquity],
                ['Previous Years\' Profits', bsE.retainedEarnings, true],
                ['(P&L Closing Transfer)', bsE.plClosing],
                ['This Year\'s Profit', bsE.currentYearProfit, true],
                ['Other / Unclassified', bsE.otherEquity],
              ];
              const renderLines = (lines, tone) => lines
                .filter(([, v, always]) => always || Math.abs(v || 0) > 0.005)
                .map(([label, v]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-slate-600">{label}</span>
                    <span className={`font-semibold ${tone}`}>{formatCurrency(v || 0)}</span>
                  </div>
                ));
              return (
                <>
                  <div className="rounded-xl border-2 border-green-200 bg-white p-4">
                    <div className="mb-3 text-sm font-bold text-green-700">🏦 What You Own (Assets)</div>
                    <div className="space-y-2 text-sm">{renderLines(assetLines, 'text-green-800')}</div>
                    <div className="mt-3 border-t border-green-200 pt-2 flex justify-between text-sm font-bold text-green-800">
                      <span>Total</span><span>{formatCurrency(snapshot.balanceSheet.assets.total)}</span>
                    </div>
                  </div>
                  <div className="rounded-xl border-2 border-rose-200 bg-white p-4">
                    <div className="mb-3 text-sm font-bold text-rose-700">📋 What You Owe (Liabilities)</div>
                    <div className="space-y-2 text-sm">{renderLines(liabilityLines, 'text-rose-800')}</div>
                    <div className="mt-3 border-t border-rose-200 pt-2 flex justify-between text-sm font-bold text-rose-800">
                      <span>Total</span><span>{formatCurrency(snapshot.balanceSheet.liabilities.total)}</span>
                    </div>
                  </div>
                  <div className="rounded-xl border-2 border-indigo-200 bg-white p-4">
                    <div className="mb-3 text-sm font-bold text-indigo-700">💎 Business Net Worth (Equity)</div>
                    <div className="space-y-2 text-sm">{renderLines(equityLines, 'text-indigo-800')}</div>
                    <div className="mt-3 border-t border-indigo-200 pt-2 flex justify-between text-sm font-bold text-indigo-800">
                      <span>Total</span><span>{formatCurrency(snapshot.balanceSheet.equity.total)}</span>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
          <div className={`rounded-xl border-2 p-4 text-center ${
            Math.abs(snapshot.balanceSheet.assets.total - snapshot.balanceSheet.totalLiabilitiesAndEquity) < 1
              ? 'border-green-200 bg-green-50'
              : 'border-red-200 bg-red-50'
          }`}>
            <p className="text-sm font-semibold text-slate-700">Assets = Liabilities + Equity</p>
            <p className="text-lg font-bold text-slate-800">{formatCurrency(snapshot.balanceSheet.assets.total)} = {formatCurrency(snapshot.balanceSheet.totalLiabilitiesAndEquity)}</p>
          </div>
        </div>
      )}

      {/* ══════ AGEING REPORT TAB ══════ */}
      {activeTab === 'ageing' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800 flex-1">
              <strong>Receivable & Payable Ageing</strong>: FIFO-based ageing of outstanding party balances by 0-30, 31-60, 61-90, and 90+ day buckets.
            </div>
            <button onClick={() => exportReport('ageing')} className="ml-3 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><Download size={12} /> Export</button>
          </div>
          <div>
            <h3 className="text-sm font-bold text-emerald-700 mb-2">💰 Receivable Ageing (Clients who owe you)</h3>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-emerald-50 text-xs uppercase text-emerald-700">
                    <tr>
                      <th className="px-3 py-2 text-left">Party</th>
                      <th className="px-3 py-2 text-right">0-30 Days</th>
                      <th className="px-3 py-2 text-right">31-60 Days</th>
                      <th className="px-3 py-2 text-right">61-90 Days</th>
                      <th className="px-3 py-2 text-right text-red-700">90+ Days</th>
                      <th className="px-3 py-2 text-right font-bold">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ageingData.receivable.map(r => (
                      <tr key={r.account} className="hover:bg-slate-50 cursor-pointer" onClick={() => drillToLedger(r.account)}>
                        <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                        <td className="px-3 py-2 text-right font-mono">{r['0_30'] > 0.01 ? formatCurrency(r['0_30']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono text-yellow-700">{r['31_60'] > 0.01 ? formatCurrency(r['31_60']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono text-orange-700">{r['61_90'] > 0.01 ? formatCurrency(r['61_90']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-red-700">{r['90_plus'] > 0.01 ? formatCurrency(r['90_plus']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(r.total)}</td>
                      </tr>
                    ))}
                    {ageingData.receivable.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No outstanding receivables</td></tr>}
                  </tbody>
                  {ageingData.receivable.length > 0 && (
                    <tfoot className="bg-emerald-50 font-semibold text-sm">
                      <tr>
                        <td className="px-3 py-2">Total</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(ageingData.receivableTotals['0_30'])}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(ageingData.receivableTotals['31_60'])}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(ageingData.receivableTotals['61_90'])}</td>
                        <td className="px-3 py-2 text-right font-mono text-red-700">{formatCurrency(ageingData.receivableTotals['90_plus'])}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(ageingData.receivableTotals.total)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-bold text-rose-700 mb-2">📤 Payable Ageing (What you owe vendors)</h3>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-rose-50 text-xs uppercase text-rose-700">
                    <tr>
                      <th className="px-3 py-2 text-left">Party</th>
                      <th className="px-3 py-2 text-right">0-30 Days</th>
                      <th className="px-3 py-2 text-right">31-60 Days</th>
                      <th className="px-3 py-2 text-right">61-90 Days</th>
                      <th className="px-3 py-2 text-right text-red-700">90+ Days</th>
                      <th className="px-3 py-2 text-right font-bold">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ageingData.payable.map(r => (
                      <tr key={r.account} className="hover:bg-slate-50 cursor-pointer" onClick={() => drillToLedger(r.account)}>
                        <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                        <td className="px-3 py-2 text-right font-mono">{r['0_30'] > 0.01 ? formatCurrency(r['0_30']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono text-yellow-700">{r['31_60'] > 0.01 ? formatCurrency(r['31_60']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono text-orange-700">{r['61_90'] > 0.01 ? formatCurrency(r['61_90']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-red-700">{r['90_plus'] > 0.01 ? formatCurrency(r['90_plus']) : '-'}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(r.total)}</td>
                      </tr>
                    ))}
                    {ageingData.payable.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No outstanding payables</td></tr>}
                  </tbody>
                  {ageingData.payable.length > 0 && (
                    <tfoot className="bg-rose-50 font-semibold text-sm">
                      <tr>
                        <td className="px-3 py-2">Total</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(ageingData.payableTotals['0_30'])}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(ageingData.payableTotals['31_60'])}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(ageingData.payableTotals['61_90'])}</td>
                        <td className="px-3 py-2 text-right font-mono text-red-700">{formatCurrency(ageingData.payableTotals['90_plus'])}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{formatCurrency(ageingData.payableTotals.total)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════ TDS TRACKER TAB ══════ */}
      {activeTab === 'tds' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">
            <strong>TDS Tracker</strong>: Record TDS deducted by clients on your income (receivable) or TDS you deduct on vendor payments (payable). Common sections: 194J (Professional 10%), 194C (Contractor 1%/2%), 194H (Commission 5%).
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-semibold text-green-700">TDS Receivable (Deducted by Clients)</p>
              <p className="mt-1 text-2xl font-bold text-green-800">{formatCurrency(Math.max(snapshot.ledger.find(r => r.account === 'TDS Receivable')?.balance || 0, 0))}</p>
              <p className="text-xs text-green-600">Claim as credit when filing ITR</p>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm font-semibold text-rose-700">TDS Payable (Deducted by You)</p>
              <p className="mt-1 text-2xl font-bold text-rose-800">{formatCurrency(Math.abs(Math.min(snapshot.ledger.find(r => r.account === 'TDS Payable')?.balance || 0, 0)))}</p>
              <p className="text-xs text-rose-600">Deposit to govt before due date</p>
            </div>
          </div>
          {(() => {
            // Monthly TDS Payable by section — aggregate every 'TDS Payable' credit
            // leg (chat compound entries + manual tds_entry docs) already in memory.
            const buckets = {};
            manualJournalEntries
              .filter(r => fyFilter === 'all' || r.fy === fyFilter)
              .forEach(r => {
                (r.entries || []).forEach(leg => {
                  if (leg.creditAccount !== 'TDS Payable') return;
                  const month = (r.date || '').slice(0, 7);
                  if (!month) return;
                  const secMatch = (r.narration || '').match(/u\/s\s*(19[0-9][a-z]?)/i);
                  const section = r.tds_section || (secMatch ? secMatch[1].toUpperCase() : 'Unclassified');
                  const key = `${month}::${section}`;
                  buckets[key] = (buckets[key] || 0) + (Number(leg.amount) || 0);
                });
              });
            const rows = Object.entries(buckets)
              .map(([k, amount]) => { const [month, section] = k.split('::'); return { month, section, amount }; })
              .sort((a, b) => b.month.localeCompare(a.month) || a.section.localeCompare(b.section));
            if (!rows.length) return null;
            const total = rows.reduce((s, r) => s + r.amount, 0);
            const depositBy = (month) => { const [y, m] = month.split('-').map(Number); const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, '0')}-07`; };
            return (
              <div className="overflow-hidden rounded-xl border border-rose-200 bg-white">
                <div className="border-b border-rose-100 bg-rose-50 px-4 py-2">
                  <p className="text-sm font-bold text-rose-800">TDS Payable — Monthly Deposit Summary</p>
                  <p className="text-xs text-rose-600">TDS you withheld and must deposit to the govt (due the 7th of the next month), grouped by section.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Month</th>
                        <th className="px-3 py-2 text-left">Section</th>
                        <th className="px-3 py-2 text-right">TDS Payable</th>
                        <th className="px-3 py-2 text-left">Deposit By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map(r => (
                        <tr key={`${r.month}-${r.section}`}>
                          <td className="px-3 py-2">{r.month}</td>
                          <td className="px-3 py-2"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700">{r.section}</span></td>
                          <td className="px-3 py-2 text-right font-mono font-semibold">{formatCurrency(r.amount)}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{depositBy(r.month)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                        <td className="px-3 py-2" colSpan={2}>Total</td>
                        <td className="px-3 py-2 text-right font-mono">{formatCurrency(total)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          })()}
          {canEditFinance && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-sm font-bold text-slate-700">Record TDS Entry</p>
              <div className="grid gap-2 sm:grid-cols-4">
                <select value={tdsForm.type} onChange={e => setTdsForm(f => ({ ...f, type: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="tds_receivable">TDS Deducted by Client</option>
                  <option value="tds_payable">TDS Deducted by You</option>
                </select>
                <input type="date" value={tdsForm.date} onChange={e => setTdsForm(f => ({ ...f, date: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <select value={tdsForm.party_name} onChange={e => setTdsForm(f => ({ ...f, party_name: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm sm:col-span-2">
                  <option value="">-- Select Party --</option>
                  {snapshot.ledger.filter(r => r.account.startsWith('Party:')).map(r => (
                    <option key={r.account} value={r.account.replace('Party: ', '')}>{r.account.replace('Party: ', '')}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2 sm:grid-cols-5">
                <select value={tdsForm.section} onChange={e => setTdsForm(f => ({ ...f, section: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="194J">194J - Professional (10%)</option>
                  <option value="194C">194C - Contractor (1%/2%)</option>
                  <option value="194H">194H - Commission (5%)</option>
                  <option value="194I">194I - Rent (10%)</option>
                  <option value="194A">194A - Interest (10%)</option>
                  <option value="other">Other</option>
                </select>
                <input type="number" step="0.01" placeholder="TDS Rate %" value={tdsForm.rate} onChange={e => setTdsForm(f => ({ ...f, rate: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input type="number" step="0.01" placeholder="Base Amount" value={tdsForm.base_amount} onChange={e => { const b = parseFloat(e.target.value || 0); setTdsForm(f => ({ ...f, base_amount: e.target.value, tds_amount: String(Math.round(b * parseFloat(f.rate || 0)) / 100) })); }} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input type="number" step="0.01" placeholder="TDS Amount" value={tdsForm.tds_amount} onChange={e => setTdsForm(f => ({ ...f, tds_amount: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <button disabled={isSaving} onClick={saveTdsEntry} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">Post TDS</button>
              </div>
              <input placeholder="Remarks (optional)" value={tdsForm.remarks} onChange={e => setTdsForm(f => ({ ...f, remarks: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Voucher</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Narration</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {manualJournalEntries.filter(r => r.source === 'tds_entry').filter(r => fyFilter === 'all' || r.fy === fyFilter).sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(r => (
                    <tr key={r.id}>
                      <td className="px-3 py-2">{r.date}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.voucher_no}</td>
                      <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${(r.entries || [])[0]?.debitAccount === 'TDS Receivable' ? 'bg-green-100 text-green-800' : 'bg-rose-100 text-rose-800'}`}>{(r.entries || [])[0]?.debitAccount === 'TDS Receivable' ? 'Receivable' : 'Payable'}</span></td>
                      <td className="px-3 py-2 text-xs">{r.narration}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">{formatCurrency((r.entries || [])[0]?.amount || 0)}</td>
                    </tr>
                  ))}
                  {manualJournalEntries.filter(r => r.source === 'tds_entry').length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No TDS entries recorded</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════ CREDIT/DEBIT NOTES TAB ══════ */}
      {activeTab === 'cn_dn' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">
            <strong>Credit & Debit Notes</strong>: Issue a <strong>Credit Note</strong> to reduce what a client owes (returns, discounts, corrections). Issue a <strong>Debit Note</strong> to reduce what you owe a vendor.
          </div>
          {canEditFinance && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <select value={cnDnForm.type} onChange={e => setCnDnForm(f => ({ ...f, type: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="credit_note">Credit Note (to Client)</option>
                  <option value="debit_note">Debit Note (to Vendor)</option>
                </select>
                <input type="date" value={cnDnForm.date} onChange={e => setCnDnForm(f => ({ ...f, date: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <select value={cnDnForm.party_name} onChange={e => setCnDnForm(f => ({ ...f, party_name: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="">-- Select Party --</option>
                  {snapshot.ledger.filter(r => r.account.startsWith('Party:')).map(r => (
                    <option key={r.account} value={r.account.replace('Party: ', '')}>{r.account.replace('Party: ', '')}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <input placeholder="Original Invoice Ref" value={cnDnForm.original_invoice} onChange={e => setCnDnForm(f => ({ ...f, original_invoice: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input type="number" step="0.01" placeholder="Taxable Amount" value={cnDnForm.taxable} onChange={e => setCnDnForm(f => ({ ...f, taxable: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input type="number" step="0.01" placeholder="GST Amount" value={cnDnForm.gst} onChange={e => setCnDnForm(f => ({ ...f, gst: e.target.value }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-right">Total: {formatCurrency((parseFloat(cnDnForm.taxable) || 0) + (parseFloat(cnDnForm.gst) || 0))}</div>
              </div>
              <div className="flex gap-2">
                <input placeholder="Reason (discount, return, correction, etc.)" value={cnDnForm.reason} onChange={e => setCnDnForm(f => ({ ...f, reason: e.target.value }))} className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                {cnDnEditingId && (
                  <button onClick={cancelCreditDebitNoteEdit} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
                )}
                <button disabled={isSaving} onClick={saveCreditDebitNote} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{isSaving ? 'Saving...' : cnDnEditingId ? `Update ${cnDnForm.type === 'credit_note' ? 'Credit Note' : 'Debit Note'}` : `Post ${cnDnForm.type === 'credit_note' ? 'Credit Note' : 'Debit Note'}`}</button>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <p className="font-semibold mb-1">Journal Entry Preview:</p>
                {cnDnForm.type === 'credit_note' ? (
                  <>
                    {parseFloat(cnDnForm.taxable || 0) > 0 && <p>Dr Sales Revenue — {formatCurrency(parseFloat(cnDnForm.taxable || 0))}</p>}
                    {parseFloat(cnDnForm.gst || 0) > 0 && <p>Dr Output GST Payable — {formatCurrency(parseFloat(cnDnForm.gst || 0))}</p>}
                    <p>Cr Party: {cnDnForm.party_name || '___'} — {formatCurrency((parseFloat(cnDnForm.taxable || 0)) + (parseFloat(cnDnForm.gst || 0)))}</p>
                  </>
                ) : (
                  <>
                    <p>Dr Party: {cnDnForm.party_name || '___'} — {formatCurrency((parseFloat(cnDnForm.taxable || 0)) + (parseFloat(cnDnForm.gst || 0)))}</p>
                    {parseFloat(cnDnForm.taxable || 0) > 0 && <p>Cr Purchase Expense — {formatCurrency(parseFloat(cnDnForm.taxable || 0))}</p>}
                    {parseFloat(cnDnForm.gst || 0) > 0 && <p>Cr Input GST Credit — {formatCurrency(parseFloat(cnDnForm.gst || 0))}</p>}
                  </>
                )}
              </div>
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Voucher</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Narration</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    {canEditFinance && <th className="px-3 py-2 text-center">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {manualJournalEntries.filter(r => r.source === 'credit_note' || r.source === 'debit_note').filter(r => fyFilter === 'all' || r.fy === fyFilter).sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(r => (
                    <tr key={r.id} className={cnDnEditingId === r.id ? 'bg-indigo-50' : ''}>
                      <td className="px-3 py-2">{r.date}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.voucher_no}</td>
                      <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${r.source === 'credit_note' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>{r.source === 'credit_note' ? 'Credit Note' : 'Debit Note'}</span></td>
                      <td className="px-3 py-2 text-xs">{r.narration}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">{formatCurrency((r.entries || []).reduce((s, e) => s + e.amount, 0))}</td>
                      {canEditFinance && (
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => editCreditDebitNote(r)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-indigo-600" title="Edit"><Edit size={14} /></button>
                            <button onClick={() => setCnDnDeleteModal({ isOpen: true, entry: r })} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-600" title="Delete"><Trash2 size={14} /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                  {manualJournalEntries.filter(r => r.source === 'credit_note' || r.source === 'debit_note').length === 0 && <tr><td colSpan={canEditFinance ? 6 : 5} className="px-3 py-6 text-center text-slate-400">No credit/debit notes issued yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <VirtualAccountant
        isOpen={isAssistantOpen}
        onClose={() => setIsAssistantOpen(false)}
        allAccounts={allAccounts}
        onApplyTemplate={handleApplyTemplate}
        currentEntry={journalForm}
        onPostEntry={handleChatPostEntry}
        onReverse={handleChatReverse}
        onQuery={handleChatQuery}
        onParkEntry={handleChatParkEntry}
        partyNames={partyNames}
        closedFYs={fiscalYearClosings.filter((r) => r.status === 'closed').map((r) => r.fy)}
        recentJournalEntries={manualJournalEntries}
        getFY={getFYFromDate}
        orgGstin={orgGstin}
        partyGstins={partyGstins}
        projectNames={projectNames}
        employeeNames={employeeNames}
        aiEnabled={aiEnabled}
      />

      <ConfirmDeleteModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, entry: null })}
        onConfirm={confirmDeleteJournalEntry}
        title="Delete Journal Entry"
        message={`Are you sure you want to delete journal entry "${deleteModal.entry?.voucher_no || 'this entry'}"? This action cannot be undone and will affect your accounting records. Please ensure this is a wrong entry that needs correction.`}
        requireTyped={true}
      />

      {/* Posted-JV attachments viewer */}
      <Modal isOpen={!!attachmentsModal} onClose={() => setAttachmentsModal(null)} title={`Attachments — ${attachmentsModal?.voucher || ''}`}>
        {attachmentsModal && (
          <ul className="space-y-2">
            {attachmentsModal.attachments.map((att) => (
              <li key={att.path || att.url} className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-white p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-700">{att.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {att.type || 'file'} · {Math.round((att.size || 0) / 1024)} KB
                    {att.uploadedAt ? ` · ${att.uploadedAt.slice(0, 10)}` : ''}
                  </div>
                </div>
                <a href={att.url} target="_blank" rel="noreferrer" className="shrink-0 rounded bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700">View</a>
              </li>
            ))}
          </ul>
        )}
      </Modal>      {/* Purchase Invoice Modal */}
      <Modal isOpen={!!recurringFromTpl} onClose={() => setRecurringFromTpl(null)} title={`Schedule recurring · ${recurringFromTpl?.tpl?.name || ''}`}>
        {recurringFromTpl && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-slate-500">Drafts will be auto-generated by the cloud scheduler on each run date and require manual posting (or approval).</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Frequency</label>
                <select
                  value={recurringFromTpl.frequency}
                  onChange={(e) => setRecurringFromTpl((r) => ({ ...r, frequency: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Every (interval)</label>
                <input type="number" min="1" max="12" value={recurringFromTpl.interval || 1}
                  onChange={(e) => setRecurringFromTpl((r) => ({ ...r, interval: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
            {['monthly', 'quarterly', 'yearly'].includes(recurringFromTpl.frequency) && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Day of month (1–31)</label>
                <input type="number" min="1" max="31" value={recurringFromTpl.dayOfMonth || ''}
                  onChange={(e) => setRecurringFromTpl((r) => ({ ...r, dayOfMonth: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Start date *</label>
                <input type="date" value={recurringFromTpl.startDate}
                  onChange={(e) => setRecurringFromTpl((r) => ({ ...r, startDate: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">End date <span className="text-slate-400">(optional)</span></label>
                <input type="date" value={recurringFromTpl.endDate || ''}
                  onChange={(e) => setRecurringFromTpl((r) => ({ ...r, endDate: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={recurringFromTpl.active !== false}
                onChange={(e) => setRecurringFromTpl((r) => ({ ...r, active: e.target.checked }))} />
              Active immediately
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setRecurringFromTpl(null)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSaveRecurringFromTemplate} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700">Save schedule</button>
            </div>
          </div>
        )}
      </Modal>
      {/* Purchase Invoice Modal */}
      <Modal isOpen={isPiModalOpen} onClose={() => setIsPiModalOpen(false)} title={piEditingId ? 'Edit Purchase Invoice' : 'New Purchase Invoice'}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Invoice Date *</label>
              <input type="date" value={piForm.invoice_date} onChange={e => setPiForm(f => ({ ...f, invoice_date: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Mode</label>
              <select value={piForm.purchase_mode} onChange={e => setPiForm(f => ({ ...f, purchase_mode: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                <option value="Credit">Credit</option>
                <option value="Cash">Cash</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Vendor *</label>
            <select
              value={piForm.vendor_id}
              onChange={e => {
                const v = vendorOptions.find(c => c.id === e.target.value);
                setPiForm(f => ({ ...f, vendor_id: e.target.value, vendor_name: v?.name || '' }));
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">-- Select Vendor --</option>
              {vendorOptions.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            {!piForm.vendor_id && (
              <input type="text" placeholder="Or type vendor name" value={piForm.vendor_name} onChange={e => setPiForm(f => ({ ...f, vendor_name: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Description</label>
            <input type="text" value={piForm.description} onChange={e => setPiForm(f => ({ ...f, description: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Equipment rental, services, etc." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Taxable Amount *</label>
              <input type="number" step="0.01" value={piForm.amount} onChange={e => setPiForm(f => ({ ...f, amount: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="0.00" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">GST Amount</label>
              <input type="number" step="0.01" value={piForm.gst_amount} onChange={e => setPiForm(f => ({ ...f, gst_amount: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="0.00" />
            </div>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-right text-sm font-semibold text-slate-700">
            Total: {formatCurrency((parseFloat(piForm.amount) || 0) + (parseFloat(piForm.gst_amount) || 0))}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Status</label>
            <select value={piForm.status} onChange={e => setPiForm(f => ({ ...f, status: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="Pending">Pending</option>
              <option value="Verified">Verified</option>
              <option value="Rejected">Rejected</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Remarks</label>
            <textarea value={piForm.remarks} onChange={e => setPiForm(f => ({ ...f, remarks: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" rows={2} placeholder="Optional notes" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setIsPiModalOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
            <button disabled={isSaving} onClick={handlePiSave} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{isSaving ? 'Saving...' : piEditingId ? 'Update' : 'Create'}</button>
          </div>
        </div>
      </Modal>

      <ConfirmDeleteModal
        isOpen={piDeleteModal.isOpen}
        onClose={() => setPiDeleteModal({ isOpen: false, entry: null })}
        onConfirm={() => piDeleteModal.entry && handlePiDelete(piDeleteModal.entry)}
        title="Delete Purchase Invoice"
        message={`Delete purchase invoice "${piDeleteModal.entry?.pi_no || ''}" from ${piDeleteModal.entry?.vendor_name || 'vendor'}? This will remove it from the purchase book and all accounting entries.`}
      />

      <ConfirmDeleteModal
        isOpen={cnDnDeleteModal.isOpen}
        onClose={() => setCnDnDeleteModal({ isOpen: false, entry: null })}
        onConfirm={() => cnDnDeleteModal.entry && deleteCreditDebitNote(cnDnDeleteModal.entry)}
        title={`Delete ${cnDnDeleteModal.entry?.source === 'credit_note' ? 'Credit Note' : 'Debit Note'}`}
        message={`Delete ${cnDnDeleteModal.entry?.source === 'credit_note' ? 'credit note' : 'debit note'} "${cnDnDeleteModal.entry?.voucher_no || ''}" dated ${cnDnDeleteModal.entry?.date || ''}? The journal entry will be removed and ledger balances will recompute.`}
      />

      <Modal isOpen={!!editingDraft} onClose={() => setEditingDraft(null)} title="Edit Parked Draft">
        {editingDraft && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Date *</label>
                <input
                  type="date"
                  value={editingDraft.date}
                  onChange={(e) => setEditingDraft((d) => ({ ...d, date: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600" title="Leave blank for manual post. Set to auto-post on this date.">
                  Auto-post on <span className="text-slate-400">(optional)</span>
                </label>
                <input
                  type="date"
                  value={editingDraft.schedule_post_on || ''}
                  onChange={(e) => setEditingDraft((d) => ({ ...d, schedule_post_on: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Party Name</label>
              <input
                type="text"
                value={editingDraft.party_name || ''}
                onChange={(e) => setEditingDraft((d) => ({ ...d, party_name: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                placeholder="Vendor / Customer / Employee"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Narration</label>
              <input
                type="text"
                value={editingDraft.narration}
                onChange={(e) => setEditingDraft((d) => ({ ...d, narration: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">
                  Attachments {(editingDraft.attachments || []).length > 0 && <span className="text-slate-400">({(editingDraft.attachments || []).length})</span>}
                </span>
                <label className={`cursor-pointer rounded px-2 py-1 text-[11px] font-semibold text-white ${uploadingAttachment ? 'bg-slate-400' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                  {uploadingAttachment ? 'Uploading…' : '+ Upload'}
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    disabled={uploadingAttachment}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleAttachFile(f); }}
                  />
                </label>
              </div>
              {(editingDraft.attachments || []).length === 0 ? (
                <div className="text-[11px] text-slate-400">Receipts / bills (10 MB max — image or PDF)</div>
              ) : (
                <ul className="space-y-1">
                  {(editingDraft.attachments || []).map((att) => (
                    <li key={att.path} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
                      <a href={att.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline truncate">
                        {att.name} <span className="text-slate-400">({Math.round((att.size || 0) / 1024)} KB)</span>
                      </a>
                      <button onClick={() => handleRemoveAttachment(att)} className="text-red-500 hover:text-red-700 px-1">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">Journal lines</span>
                <button type="button" onClick={addDraftLine} className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700">+ Add line</button>
              </div>
              {(editingDraft.entries || []).map((ent, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <select
                    className="col-span-4 rounded border border-slate-300 px-2 py-1.5 text-xs"
                    value={ent.debitAccount}
                    onChange={(e) => updateDraftLine(idx, 'debitAccount', e.target.value)}
                  >
                    <option value="">Debit Account</option>
                    {pickerAccounts.map((a) => <option key={`ded-${idx}-${a}`} value={a}>{a}</option>)}
                  </select>
                  <select
                    className="col-span-4 rounded border border-slate-300 px-2 py-1.5 text-xs"
                    value={ent.creditAccount}
                    onChange={(e) => updateDraftLine(idx, 'creditAccount', e.target.value)}
                  >
                    <option value="">Credit Account</option>
                    {pickerAccounts.map((a) => <option key={`dec-${idx}-${a}`} value={a}>{a}</option>)}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="col-span-3 rounded border border-slate-300 px-2 py-1.5 text-right font-mono text-xs"
                    value={ent.amount}
                    onChange={(e) => updateDraftLine(idx, 'amount', e.target.value)}
                    placeholder="0.00"
                  />
                  <button
                    type="button"
                    onClick={() => removeDraftLine(idx)}
                    disabled={(editingDraft.entries || []).length <= 1}
                    className="col-span-1 rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40"
                    title="Remove line"
                  >×</button>
                </div>
              ))}
              <div className="text-right text-xs font-semibold text-slate-700">
                Total: {formatCurrency((editingDraft.entries || []).reduce((s, e) => s + (Number(e.amount) || 0), 0))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditingDraft(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSaveDraftEdit} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">Save Draft</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!templatePrompt}
        onClose={() => setTemplatePrompt(null)}
        title={templatePrompt ? `Use template: ${templatePrompt.tpl.name || 'Template'}` : ''}
      >
        {templatePrompt && (
          <div className="space-y-3">
            <div className="text-xs text-slate-500">
              Fill in the variables below. Built-in placeholders like <code>{`{{month}}`}</code>, <code>{`{{today}}`}</code>, <code>{`{{fy}}`}</code> resolve automatically.
            </div>
            {templatePrompt.vars.map((v) => (
              <div key={v.name}>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  {v.name}
                  {v.type === 'amount' && <span className="ml-1 text-[10px] uppercase text-purple-600">amount</span>}
                  {v.default && <span className="ml-1 text-[10px] text-slate-400">default: {v.default}</span>}
                </label>
                <input
                  type={v.type === 'amount' ? 'number' : 'text'}
                  step={v.type === 'amount' ? '0.01' : undefined}
                  value={templatePrompt.values[v.name] ?? ''}
                  onChange={(e) => setTemplatePrompt((p) => p && ({
                    ...p,
                    values: { ...p.values, [v.name]: e.target.value },
                  }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder={v.default || `Enter ${v.name}`}
                  autoFocus={v === templatePrompt.vars[0]}
                />
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setTemplatePrompt(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={handleConfirmTemplatePrompt} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700">Create Draft</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!editingTemplate}
        onClose={() => setEditingTemplate(null)}
        title={editingTemplate?.id ? 'Edit Template' : 'New Template'}
      >
        {editingTemplate && (
          <div className="space-y-3">
            <div className="rounded bg-purple-50 border border-purple-200 px-3 py-2 text-[11px] text-purple-800">
              <strong>Variable syntax:</strong> <code>{`{{name}}`}</code> prompts the user, <code>{`{{name:default}}`}</code> falls back, <code>{`{{rent|amount}}`}</code> renders a numeric input. Built-ins: <code>{`{{today}} {{month}} {{year}} {{fy}}`}</code>.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Name *</label>
                <input
                  type="text"
                  value={editingTemplate.name}
                  onChange={(e) => setEditingTemplate((t) => ({ ...t, name: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="e.g. Monthly Office Rent"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Category <span className="text-slate-400">(optional)</span></label>
                <input
                  type="text"
                  list="template-category-options"
                  value={editingTemplate.category || ''}
                  onChange={(e) => setEditingTemplate((t) => ({ ...t, category: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Rent / Salary / Utilities"
                />
                <datalist id="template-category-options">
                  {Array.from(new Set(journalTemplates.map((t) => t.category).filter(Boolean))).sort().map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Narration</label>
              <input
                type="text"
                value={editingTemplate.narration || ''}
                onChange={(e) => setEditingTemplate((t) => ({ ...t, narration: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                placeholder="Office rent for {{month}} ({{property:Main}})"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Party Name</label>
              <input
                type="text"
                value={editingTemplate.party_name || ''}
                onChange={(e) => setEditingTemplate((t) => ({ ...t, party_name: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                placeholder="Optional — supports {{vars}}"
              />
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">Journal lines</span>
                <button type="button" onClick={addTemplateLine} className="rounded bg-purple-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-purple-700">+ Add line</button>
              </div>
              {(editingTemplate.entries || []).map((ent, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <select
                    className="col-span-4 rounded border border-slate-300 px-2 py-1.5 text-xs"
                    value={ent.debitAccount}
                    onChange={(e) => updateTemplateLine(idx, 'debitAccount', e.target.value)}
                  >
                    <option value="">Debit Account</option>
                    {pickerAccounts.map((a) => <option key={`ted-${idx}-${a}`} value={a}>{a}</option>)}
                  </select>
                  <select
                    className="col-span-4 rounded border border-slate-300 px-2 py-1.5 text-xs"
                    value={ent.creditAccount}
                    onChange={(e) => updateTemplateLine(idx, 'creditAccount', e.target.value)}
                  >
                    <option value="">Credit Account</option>
                    {pickerAccounts.map((a) => <option key={`tec-${idx}-${a}`} value={a}>{a}</option>)}
                  </select>
                  <input
                    type="text"
                    className="col-span-3 rounded border border-slate-300 px-2 py-1.5 text-right font-mono text-xs"
                    value={ent.amount === 0 ? '0' : String(ent.amount ?? '')}
                    onChange={(e) => updateTemplateLine(idx, 'amount', e.target.value)}
                    placeholder="{{amount}} or 0"
                    title="Number or {{var}} placeholder"
                  />
                  <button
                    type="button"
                    onClick={() => removeTemplateLine(idx)}
                    disabled={(editingTemplate.entries || []).length <= 1}
                    className="col-span-1 rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40"
                    title="Remove line"
                  >×</button>
                </div>
              ))}
              {(() => {
                const detected = extractVariables({
                  narration: editingTemplate.narration,
                  party_name: editingTemplate.party_name,
                  entries: editingTemplate.entries,
                });
                return detected.length > 0 ? (
                  <div className="text-[10px] text-purple-700 pt-1">
                    Will prompt for: <strong>{detected.map((v) => v.name).join(', ')}</strong>
                  </div>
                ) : null;
              })()}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditingTemplate(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={handleSaveTemplateEdit} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700">{editingTemplate.id ? 'Save Template' : 'Create Template'}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default Accounting;
