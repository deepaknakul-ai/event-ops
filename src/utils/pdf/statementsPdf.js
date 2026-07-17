// ─────────────────────────────────────────────────────────────────────────────
// On-demand PDF export for the core financial statements + a single-account
// ledger. Mirrors the jsPDF + autoTable pattern used in Reports.jsx. Amounts use
// plain Indian-grouped numbers (no ₹ glyph — jsPDF's core font can't render it).
// ─────────────────────────────────────────────────────────────────────────────
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const num = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-IN');

// Shared header: org name + statement title + generated date + FY/period.
function header(doc, title, meta = {}) {
  doc.setFontSize(14);
  doc.text(String(meta.orgName || 'Financial Statement'), 14, 18);
  doc.setFontSize(12);
  doc.text(title, 14, 26);
  doc.setFontSize(9);
  const scope = meta.fyLabel && meta.fyLabel !== 'all' ? `FY ${meta.fyLabel}` : 'All periods';
  doc.text(`${scope}  ·  Generated ${today()}`, 14, 32);
  return 40;
}

function twoColTable(doc, startY, rows) {
  autoTable(doc, {
    body: rows,
    startY,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 1.5 },
    columnStyles: { 0: { cellWidth: 130 }, 1: { halign: 'right' } },
    didParseCell: (d) => {
      const raw = rows[d.row.index];
      if (raw && raw._bold) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [240, 240, 240]; }
    },
  });
}

/** Profit & Loss. `pnl` = snapshot.profitAndLoss. */
export function generatePnlPdf(pnl = {}, meta = {}) {
  const doc = new jsPDF();
  const y = header(doc, 'Profit & Loss', meta);
  twoColTable(doc, y, [
    ['Revenue', num(pnl.revenue)],
    ['Cost of Goods Sold', num(pnl.costOfGoodsSold)],
    Object.assign(['Gross Profit', num(pnl.grossProfit)], { _bold: true }),
    ['Operating Expenses', num(pnl.operatingExpenses)],
    Object.assign(['Net Profit', num(pnl.netProfit)], { _bold: true }),
  ]);
  doc.save(`PnL_${meta.fyLabel || 'all'}.pdf`);
}

/** Balance Sheet. `bs` = snapshot.balanceSheet (classification-driven lines). */
export function generateBalanceSheetPdf(bs = {}, meta = {}) {
  const a = bs.assets || {}; const l = bs.liabilities || {}; const e = bs.equity || {};
  const doc = new jsPDF();
  const y = header(doc, 'Balance Sheet', meta);
  const opt = (label, v) => (Math.abs(v || 0) > 0.005 ? [[label, num(v)]] : []);
  const rows = [
    Object.assign(['ASSETS', ''], { _bold: true }),
    ['Cash & Bank', num(a.cashAndBank)],
    ['Accounts Receivable', num(a.accountsReceivable)],
    ['Employee Advances', num(a.employeeAdvances)],
    ['Input GST Credit', num(a.inputGstCredit)],
    ...opt('TDS Receivable', a.tdsReceivable),
    ...opt('Prepaid Expenses', a.prepaid),
    ...opt('Fixed Assets', a.fixedAssets),
    ...opt('(Accumulated Depreciation)', a.accumulatedDepreciation),
    ...opt('Suspense (Dr)', a.suspense),
    ...opt('Other Assets', a.otherAssets),
    Object.assign(['Total Assets', num(a.total)], { _bold: true }),
    ['', ''],
    Object.assign(['LIABILITIES', ''], { _bold: true }),
    ['Accounts Payable', num(l.accountsPayable)],
    ['Employee Payable', num(l.employeePayable)],
    ['GST Payable (gross)', num(l.gstPayableGross)],
    ...opt('TDS Payable', l.tdsPayable),
    ...opt('Loans & Borrowings', l.loans),
    ...opt('Outstanding Expenses', l.outstandingExpenses),
    ...opt('Suspense (Cr)', l.suspense),
    ...opt('Other Liabilities', l.otherLiabilities),
    Object.assign(['Total Liabilities', num(l.total)], { _bold: true }),
    ['', ''],
    Object.assign(['EQUITY', ''], { _bold: true }),
    ...opt('Capital Introduced', e.capital),
    ...opt('(Drawings)', e.drawings),
    ...opt('Opening Balance Equity', e.openingBalanceEquity),
    ['Retained Earnings', num(e.retainedEarnings)],
    ...opt('(P&L Closing Transfer)', e.plClosing),
    ['Current Year Profit', num(e.currentYearProfit)],
    ...opt('Other / Unclassified', e.otherEquity),
    Object.assign(['Total Equity', num(e.total)], { _bold: true }),
    ['', ''],
    Object.assign(['Liabilities + Equity', num(bs.totalLiabilitiesAndEquity)], { _bold: true }),
  ];
  twoColTable(doc, y, rows);
  doc.save(`BalanceSheet_${meta.fyLabel || 'all'}.pdf`);
}

/** Trial Balance. `tb` = snapshot.trialBalance. */
export function generateTrialBalancePdf(tb = {}, meta = {}) {
  const doc = new jsPDF();
  const y = header(doc, 'Trial Balance', meta);
  const body = (tb.rows || []).map((r) => [r.account, r.debit ? num(r.debit) : '', r.credit ? num(r.credit) : '']);
  autoTable(doc, {
    head: [['Account', 'Debit', 'Credit']],
    body,
    startY: y,
    styles: { fontSize: 9, cellPadding: 1.2 },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    foot: [[
      { content: `Totals — ${tb.isBalanced ? 'Balanced' : 'NOT balanced'}`, styles: { fontStyle: 'bold' } },
      { content: num(tb.totalDebit), styles: { halign: 'right', fontStyle: 'bold' } },
      { content: num(tb.totalCredit), styles: { halign: 'right', fontStyle: 'bold' } },
    ]],
  });
  doc.save(`TrialBalance_${meta.fyLabel || 'all'}.pdf`);
}

/** Books audit report. `audit` = runBooksAudit output. */
export function generateAuditPdf(audit = {}, meta = {}) {
  const doc = new jsPDF();
  const y = header(doc, 'Books Audit Report', meta);
  doc.setFontSize(11);
  doc.text(`Health score: ${audit.score}/100  (Grade ${audit.grade})`, 14, y);
  doc.setFontSize(9);
  doc.text(audit.summary?.headline || '', 14, y + 6);
  const body = (audit.findings || []).map((f) => [
    (f.severity || '').toUpperCase(),
    f.message + (f.fix ? `\nFix: ${f.fix}` : ''),
  ]);
  autoTable(doc, {
    head: [['Severity', 'Finding']],
    body: body.length ? body : [['—', 'No issues found — books look clean.']],
    startY: y + 12,
    styles: { fontSize: 9, cellPadding: 2, valign: 'top' },
    columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 155 } },
    didParseCell: (d) => {
      if (d.section !== 'body' || d.column.index !== 0) return;
      const sev = (audit.findings[d.row.index] || {}).severity;
      if (sev === 'blocking') { d.cell.styles.textColor = [180, 30, 30]; d.cell.styles.fontStyle = 'bold'; }
      else if (sev === 'warning') { d.cell.styles.textColor = [180, 120, 20]; }
      else { d.cell.styles.textColor = [40, 90, 160]; }
    },
  });
  doc.save(`BooksAudit_${meta.fyLabel || 'all'}.pdf`);
}

/** Single-account ledger. `rows` = buildRunningLedger output. */
export function generateLedgerPdf(account, rows = [], meta = {}) {
  const doc = new jsPDF();
  const name = String(account || '').replace(/^(Party:|Employee:)\s*/, '');
  const y = header(doc, `Ledger — ${name}`, meta);
  const body = rows.map((r) => [
    r.date || '',
    r.voucher_no || '',
    r.contra || '',
    r.debit ? num(r.debit) : '',
    r.credit ? num(r.credit) : '',
    `${num(Math.abs(r.balance))} ${r.balance >= 0 ? 'Dr' : 'Cr'}`,
  ]);
  autoTable(doc, {
    head: [['Date', 'Voucher', 'Particulars', 'Debit', 'Credit', 'Balance']],
    body,
    startY: y,
    styles: { fontSize: 8, cellPadding: 1 },
    columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    foot: meta.closing != null ? [[
      { content: 'Closing Balance', colSpan: 5, styles: { fontStyle: 'bold' } },
      { content: `${num(Math.abs(meta.closing))} ${meta.closingType || (meta.closing >= 0 ? 'Dr' : 'Cr')}`, styles: { halign: 'right', fontStyle: 'bold' } },
    ]] : undefined,
  });
  doc.save(`Ledger_${name.replace(/\s+/g, '_')}.pdf`);
}
