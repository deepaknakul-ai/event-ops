// c:\APP\temp\rental-ops\src\utils\helpers.js
import { GST_STATE_CODES, VALID_GST_RATES, GSTIN_CHECKSUM_CHARS, appId } from './constants';
import { IS_SAAS } from './edition';

// Build a public share link. PRIVATE: returns origin + path unchanged (share
// links are byte-identical to before). SAAS: appends the tenant id as `?w=` (or
// `&w=` when the path already has a query) so the logged-out public page knows
// which tenant to read — the routes are shared across all tenants. `appId` is
// read at call time (live binding); on private this whole tail folds away.
export function publicLink(pathWithToken) {
  const p = pathWithToken.startsWith('/') ? pathWithToken : `/${pathWithToken}`;
  const base = `${window.location.origin}${p}`;
  if (!IS_SAAS || !appId) return base;
  return `${base}${base.includes('?') ? '&' : '?'}w=${encodeURIComponent(appId)}`;
}

// Tenant id for a PUBLIC (logged-out) page. SAAS visitors have no session, so
// the tenant travels in the share link's `?w=`; falls back to `appId` (the
// fixed constant on private, where `w` is never present). Read at call time.
export function publicAppId() {
  try {
    const w = new URLSearchParams(window.location.search).get('w');
    if (IS_SAAS && w) return w;
  } catch { /* no window/search */ }
  return appId;
}

const PROJECT_INVOICED_STATUSES = new Set([
  'invoiced',
  'clubbed invoice',
  'clubbed invoiced',
]);

export const isProjectInvoiced = (status) =>
  PROJECT_INVOICED_STATUSES.has(String(status || '').trim().toLowerCase().replace(/\s+/g, ' '));

export const getProjectInvoiceReference = (project) => {
  const invoiceNo = String(project?.invoice_no || '').trim();
  if (!isProjectInvoiced(project?.invoice_status) || !invoiceNo) return null;
  return { invoiceNo, invoiceDate: project?.invoice_date || '' };
};

// M-8 fix: round to paise to prevent float drift between line totals and grand total.
export const round2 = (value) => Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;

export const getProjectGrandTotal = (project) => {
  if (!project) return 0;

  // If package cost is specified, it supersedes all other costs
  if (project.package_cost && project.package_cost > 0) {
    const gstRate = project.package_cost_gst || 18;
    return round2(project.package_cost * (1 + gstRate / 100));
  }

  // Otherwise, calculate from items and logistics
  const equipment = (project.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
  let logistics = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       // H-10: respect split lines if present, fallback to legacy single-bucket.
       logistics += sumLogisticsRecord(c).total;
    });
  }
  return round2(equipment + logistics);
};

export const getProjectNetTotal = (project) => {
  if (!project) return 0;
  if (project.package_cost && project.package_cost > 0) {
    return round2(project.package_cost);
  }
  const equipment = (project.items || []).reduce((acc, i) => acc + (i.amount || 0), 0);
  let logistics = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       logistics += sumLogisticsRecord(c).amount;
    });
  }
  return round2(equipment + logistics);
};

// H-15 fix: Sum stored item.gst_amount instead of returning 0 for equipment.
// Equipment items are stored with explicit gst_rate + gst_amount per item.
export const getProjectGST = (project) => {
  if (!project) return 0;

  if (project.package_cost && project.package_cost > 0) {
    const gstRate = project.package_cost_gst || 18;
    return round2(project.package_cost * (gstRate / 100));
  }

  let totalGST = 0;
  (project.items || []).forEach(i => {
    const stored = parseFloat(i.gst_amount);
    if (!isNaN(stored)) {
      totalGST += stored;
    } else {
      // Fallback: derive from amount + gst_rate when gst_amount missing
      const base = parseFloat(i.amount || 0);
      const rate = parseFloat(i.gst_rate || 0);
      totalGST += base * (rate / 100);
    }
  });

  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       totalGST += sumLogisticsRecord(c).gstAmount;
    });
  }
  return round2(totalGST);
};

export const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount || 0);
};

// Convert a number to Indian-system words for invoices, e.g.
//   169431 → "One Lakh Sixty Nine Thousand Four Hundred Thirty One Rupees only"
//   100.50 → "One Hundred Rupees and Fifty Paise only"
export const amountToWordsINR = (amount) => {
  const num = Math.abs(round2(amount));
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);

  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const twoDigits = (n) => n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const threeDigits = (n) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return `${h ? ones[h] + ' Hundred' + (r ? ' ' : '') : ''}${r ? twoDigits(r) : ''}`;
  };

  const inWords = (n) => {
    if (n === 0) return 'Zero';
    let words = '';
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    const hundred = n;
    if (crore) words += `${inWords(crore)} Crore `;
    if (lakh) words += `${twoDigits(lakh)} Lakh `;
    if (thousand) words += `${twoDigits(thousand)} Thousand `;
    if (hundred) words += threeDigits(hundred);
    return words.trim();
  };

  let result = `${inWords(rupees)} Rupees`;
  if (paise > 0) result += ` and ${twoDigits(paise)} Paise`;
  return `${result} only`;
};

export const formatCurrencyPDF = (amount) => {
  return "Rs. " + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
};

export const normalizeGSTIN = (gstin) => {
  if (!gstin) return '';
  return String(gstin).trim().toUpperCase().replace(/\s+/g, '');
};

export const validateGSTIN = (gstin) => {
  const norm = normalizeGSTIN(gstin);
  if (!norm || norm.length !== 15) return { valid: false, msg: 'GSTIN must be exactly 15 characters' };
  const stateCode = norm.substring(0, 2);
  if (!GST_STATE_CODES[stateCode]) return { valid: false, msg: `Invalid state code: ${stateCode}` };
  const regex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (!regex.test(norm)) return { valid: false, msg: 'Invalid GSTIN format (expected: 22AAAAA0000A1Z5)' };
  // Verify checksum digit (position 15) using GSTN spec algorithm.
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHECKSUM_CHARS.indexOf(norm[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  const expected = GSTIN_CHECKSUM_CHARS[(36 - (sum % 36)) % 36];
  if (norm[14] !== expected) return { valid: false, msg: 'Invalid GSTIN — checksum digit mismatch' };
  return { valid: true, msg: 'Valid', value: norm, stateName: GST_STATE_CODES[stateCode] };
};

// Returns true if rate is a notified GST slab.
export const validateGSTRate = (rate) => VALID_GST_RATES.includes(parseFloat(rate));

// Validates HSN/SAC code — 4, 6, or 8 digits for goods; 6 digits (SAC) for services.
export const validateHSNCode = (code) => {
  const s = String(code || '').trim();
  return /^[0-9]{4}$/.test(s) || /^[0-9]{6}$/.test(s) || /^[0-9]{8}$/.test(s);
};

// Classifies a tax invoice into GSTR-1 table category.
// B2B  — buyer has valid GSTIN (registered person)
// B2CL — unregistered buyer, inter-state supply, invoice value ≥ ₹2.5 lakh
// B2CS — unregistered buyer, intra-state OR inter-state < ₹2.5 lakh
export const getGSTR1Category = (invoice) => {
  const buyerGSTIN = (invoice.bill_to_gstin_at_issue || invoice.sale_company_gstin || '').trim();
  const isRegistered = buyerGSTIN.length === 15;
  if (isRegistered) return 'B2B';
  const isInterState = (invoice.supply_type || '') === 'IGST';
  const value = parseFloat(invoice.final_amount || invoice.computed_total || 0);
  if (isInterState && value >= 250000) return 'B2CL';
  return 'B2CS';
};

export const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
};

export const fmtDate = (dateStr) => {
  if (!dateStr) return '—';
  try {
    const d = String(dateStr).substring(0, 10);
    const [y, m, day] = d.split('-');
    if (!y || !m || !day) return dateStr;
    return `${day}-${m}-${y}`;
  } catch { return dateStr; }
};

export const getDaysDifference = (start, end) => {
  if (!start || !end) return 1;
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; 
  return diffDays > 0 ? diffDays : 1;
};

export const isDateOverlap = (start1, end1, start2, end2) => {
  if (!start1 || !end1 || !start2 || !end2) return false;
  const s1 = new Date(start1); const e1 = new Date(end1);
  const s2 = new Date(start2); const e2 = new Date(end2);
  return s1 <= e2 && s2 <= e1;
};

/**
 * Cost Waterfall for a single PO:
 *  1. If vendor invoice is Accepted or Verified → use invoice actuals (most accurate for P&L)
 *  2. Else → use PO committed cost (package or itemized)
 * Returns { base, gst, total, source }
 */
export const getEffectivePOCost = (po) => {
  if (!po) return { base: 0, gst: 0, total: 0, source: 'none' };

  const inv = po.vendor_invoice;

  // Level 1: Invoice accepted/verified — use actuals for accounting & ITC
  if (inv && (inv.status === 'Accepted' || inv.status === 'Verified') && parseFloat(inv.total_amount || 0) > 0) {
    const base  = parseFloat(inv.base_amount  || 0);
    const gst   = parseFloat(inv.gst_amount   || 0);
    const total = parseFloat(inv.total_amount || 0);
    return { base, gst, total, source: 'invoice' };
  }

  // Level 2: PO committed cost — use stored values directly to avoid rounding drift
  let base = 0, gst = 0, total = 0;
  if (po.package_cost && parseFloat(po.package_cost) > 0) {
    base  = parseFloat(po.package_cost);
    const pkgGstRate = parseFloat(po.package_cost_gst || 0);
    gst   = parseFloat(po.gst_amount)  || base * (pkgGstRate / 100);
    total = base + gst;
  } else {
    // po.amount is grand total (base + gst); po.subtotal is base; po.gst_amount is gst portion
    total = parseFloat(po.amount || 0);
    gst   = parseFloat(po.gst_amount || 0);
    base  = parseFloat(po.subtotal)    || (total - gst);
  }
  return { base, gst, total, source: 'po' };
};

export const getFinancialYear = () => {
  const now = new Date();
  const m = now.getMonth(); // 0 = Jan
  const y = now.getFullYear();
  if (m < 3) return `${y-1}-${String(y).slice(-2)}`;
  return `${y}-${String(y+1).slice(-2)}`;
};

export const getFYFromDate = (dateStr) => {
  if (!dateStr) return getFinancialYear();
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return getFinancialYear();
  const m = d.getMonth();
  const y = d.getFullYear();
  if (m < 3) return `${y-1}-${String(y).slice(-2)}`;
  return `${y}-${String(y+1).slice(-2)}`;
};

const toValidDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

const startOfDay = (dateValue) => {
  const d = new Date(dateValue);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (dateValue) => {
  const d = new Date(dateValue);
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Normalize employee hourly rate history into a sorted, predictable structure.
 * Supports legacy keys (`rate`, `from`, `to`) and current keys (`hourlyRate`, `effectiveFrom`, `effectiveTo`).
 */
export const normalizeHourlyRateHistory = (employee = {}) => {
  const raw = Array.isArray(employee?.hourlyRateHistory) ? employee.hourlyRateHistory : [];
  return raw
    .map((entry, index) => {
      const hourlyRate = Number(entry?.hourlyRate ?? entry?.rate ?? 0);
      const effectiveFrom = entry?.effectiveFrom || entry?.from || '';
      const effectiveTo = entry?.effectiveTo || entry?.to || null;
      return {
        id: entry?.id || `${effectiveFrom}_${index}`,
        hourlyRate,
        effectiveFrom,
        effectiveTo,
        changeType: entry?.changeType || 'Revision',
        notes: entry?.notes || '',
        createdAt: entry?.createdAt || entry?.created_at || null,
      };
    })
    .filter((entry) => {
      if (!Number.isFinite(entry.hourlyRate)) return false;
      return !!toValidDate(entry.effectiveFrom);
    })
    .sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));
};

/**
 * Resolve employee hourly rate for a specific date using history first, then fallback to current `employee.hourlyRate`.
 */
export const getHourlyRateForDate = (employee = {}, dateInput = new Date()) => {
  const targetRaw = toValidDate(dateInput);
  const target = targetRaw ? startOfDay(targetRaw) : startOfDay(new Date());

  const history = normalizeHourlyRateHistory(employee);
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const from = startOfDay(entry.effectiveFrom);
    const to = entry.effectiveTo ? endOfDay(entry.effectiveTo) : null;
    if (target >= from && (!to || target <= to)) {
      return Number(entry.hourlyRate || 0);
    }
  }

  return Number(employee?.hourlyRate || 0);
};

/**
 * H-10: Expand a logistics_costs entry into one or more line items.
 * Backward-compatible: legacy { amount, gst } maps to a single synthetic line;
 * new { lines: [{ id, description, amount, gst }] } returns those lines.
 */
export const getLogisticsLines = (typeId, typeLabel, record) => {
  if (!record) return [];
  const split = Array.isArray(record.lines) ? record.lines.filter(Boolean) : [];
  if (split.length > 0) {
    return split.map((l, i) => ({
      id: l.id || `${typeId}_${i}`,
      description: l.description || typeLabel,
      amount: parseFloat(l.amount || 0),
      gst: parseFloat(l.gst || 0),
    }));
  }
  const amount = parseFloat(record.amount || 0);
  if (amount <= 0 && record.amount === undefined) return [];
  return [{
    id: `${typeId}_legacy`,
    description: typeLabel,
    amount,
    gst: parseFloat(record.gst || 0),
  }];
};

/**
 * H-10: aggregated taxable + GST for a single logistics type record.
 * Uses split lines when present, else legacy single-bucket.
 */
export const sumLogisticsRecord = (record) => {
  if (!record) return { amount: 0, gstAmount: 0, total: 0 };
  const split = Array.isArray(record.lines) ? record.lines.filter(Boolean) : [];
  if (split.length > 0) {
    let amount = 0, gstAmount = 0;
    split.forEach((l) => {
      const a = parseFloat(l.amount || 0);
      const g = parseFloat(l.gst || 0);
      amount += a;
      gstAmount += a * g / 100;
    });
    return { amount, gstAmount, total: amount + gstAmount };
  }
  const amount = parseFloat(record.amount || 0);
  const gst = parseFloat(record.gst || 0);
  const gstAmount = amount * gst / 100;
  return { amount, gstAmount, total: amount + gstAmount };
};

/**
 * GST Breakdown for a project.
 *
 * Supply type rules:
 *  - If orgGSTIN state code == clientGSTIN state code → Intra-state → CGST + SGST (each half of total GST)
 *  - Otherwise → Inter-state → IGST (full total GST)
 *  - If either GSTIN is missing → default to IGST
 *
 * Returns per-item breakdowns and totals.
 * @param {object} project
 * @param {string} orgGSTIN   - Seller GSTIN (first 2 digits = state code)
 * @param {string} clientGSTIN - Buyer GSTIN (first 2 digits = state code)
 * @returns {{ supplyType: 'IGST'|'CGST_SGST', items: Array, totals: object, placeOfSupply: string }}
 */
export const getProjectGSTBreakdown = (project, orgGSTIN, clientGSTIN) => {
  const orgState = (orgGSTIN || '').substring(0, 2);
  const clientState = (clientGSTIN || '').substring(0, 2);
  // B2B: both GSTINs present — compare state codes.
  // B2C (no client GSTIN): treat as intra-state (CGST+SGST) when org state is known,
  // because the safest default for a B2C local supply is intra-state, not IGST.
  // The finance team must manually confirm for cross-state B2C supplies.
  const isIntraState = orgState
    ? (clientState ? orgState === clientState : true)
    : false;
  const supplyType = isIntraState ? 'CGST_SGST' : 'IGST';

  const items = [];

  if (project.package_cost && project.package_cost > 0) {
    const pkg = parseFloat(project.package_cost);
    // A single agreed package price is split RATE-WISE using the GST-rate mix of
    // the underlying items + logistics, so mixed-rate packages produce a correct
    // per-slab GST (not one blended rate). Falls back to the single package GST
    // rate when there is no rate mix to learn from (pure lump sum, no items).
    const buckets = {};
    let mixBase = 0;
    (project.items || []).forEach((it) => {
      const b = parseFloat(it.amount || 0);
      if (b > 0) { const r = parseFloat(it.gst_rate != null ? it.gst_rate : 18); buckets[r] = (buckets[r] || 0) + b; mixBase += b; }
    });
    if (project.logistics_costs) {
      Object.entries(project.logistics_costs).forEach(([key, cost]) => {
        if (!cost) return;
        const labelBase = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
        getLogisticsLines(key, labelBase, cost).forEach((line) => {
          const b = parseFloat(line.amount || 0);
          if (b > 0) { const r = parseFloat(line.gst != null ? line.gst : 18); buckets[r] = (buckets[r] || 0) + b; mixBase += b; }
        });
      });
    }
    const rateEntries = mixBase > 0
      ? Object.entries(buckets).map(([r, b]) => ({ rate: parseFloat(r), base: b })).sort((a, b) => b.rate - a.rate)
      : [{ rate: parseFloat(project.package_cost_gst || 18), base: pkg }];
    const totalBase = rateEntries.reduce((s, e) => s + e.base, 0) || 1;
    const multiRate = rateEntries.length > 1;
    let allocated = 0;
    rateEntries.forEach((e, idx) => {
      // Last slab absorbs the rounding remainder so the slabs sum exactly to the package.
      const taxable = idx === rateEntries.length - 1 ? round2(pkg - allocated) : round2(pkg * (e.base / totalBase));
      allocated = round2(allocated + taxable);
      const gstRate = e.rate;
      const gstAmt = taxable * (gstRate / 100);
      items.push({
        description: multiRate ? `Package Cost @ ${gstRate}%` : 'Package Cost',
        hsn: project.hsn_code || '998599',
        taxable,
        gstRate,
        cgstRate: isIntraState ? gstRate / 2 : 0,
        sgstRate: isIntraState ? gstRate / 2 : 0,
        igstRate: isIntraState ? 0 : gstRate,
        cgstAmt: isIntraState ? gstAmt / 2 : 0,
        sgstAmt: isIntraState ? gstAmt / 2 : 0,
        igstAmt: isIntraState ? 0 : gstAmt,
        total: taxable + gstAmt,
      });
    });
  } else {
    // Equipment items
    (project.items || []).forEach(item => {
      // Guard with != null (like the package branch above): a legitimate 0% rate
      // must NOT be coerced to 18% by a falsy `|| 18` (0 || 18 === 18).
      const gstRate = parseFloat(item.gst_rate != null ? item.gst_rate : 18);
      const taxable = parseFloat(item.amount || 0); // amount = qty × rate × days (pre-GST)
      const gstAmt = item.gst_amount != null ? parseFloat(item.gst_amount) : taxable * (gstRate / 100);
      items.push({
        description: item.item_name,
        hsn: item.hsn_code || '998599',
        qty: item.qty,
        rate: item.rate,
        days: item.days,
        taxable,
        gstRate,
        cgstRate: isIntraState ? gstRate / 2 : 0,
        sgstRate: isIntraState ? gstRate / 2 : 0,
        igstRate: isIntraState ? 0 : gstRate,
        cgstAmt: isIntraState ? gstAmt / 2 : 0,
        sgstAmt: isIntraState ? gstAmt / 2 : 0,
        igstAmt: isIntraState ? 0 : gstAmt,
        total: taxable + gstAmt,
      });
    });
    // Logistics costs
    if (project.logistics_costs) {
      Object.entries(project.logistics_costs).forEach(([key, cost]) => {
        if (!cost) return;
        const labelBase = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
        // H-10: expand split lines into individual invoice rows.
        const lines = getLogisticsLines(key, labelBase, cost);
        lines.forEach((line) => {
          if (!line.amount && !line.gst) return;
          // 0% logistics (e.g. Transportation) must stay 0% — never `|| 18`.
          const gstRate = parseFloat(line.gst != null ? line.gst : 18);
          const taxable = parseFloat(line.amount || 0);
          const gstAmt = taxable * (gstRate / 100);
          items.push({
            description: line.description !== labelBase ? `${labelBase} — ${line.description}` : labelBase,
            hsn: '996812',
            taxable,
            gstRate,
            cgstRate: isIntraState ? gstRate / 2 : 0,
            sgstRate: isIntraState ? gstRate / 2 : 0,
            igstRate: isIntraState ? 0 : gstRate,
            cgstAmt: isIntraState ? gstAmt / 2 : 0,
            sgstAmt: isIntraState ? gstAmt / 2 : 0,
            igstAmt: isIntraState ? 0 : gstAmt,
            total: taxable + gstAmt,
          });
        });
      });
    }
  }

  const totals = items.reduce((acc, item) => {
    acc.taxable += item.taxable;
    acc.cgstAmt += item.cgstAmt;
    acc.sgstAmt += item.sgstAmt;
    acc.igstAmt += item.igstAmt;
    acc.total += item.total;
    return acc;
  }, { taxable: 0, cgstAmt: 0, sgstAmt: 0, igstAmt: 0, total: 0 });

  return { supplyType, items, totals, placeOfSupply: clientState || orgState };
};

// ============================================================================
// LED WALL SYSTEM - Data Model & Calculation Logic
// ============================================================================

/**
 * LED Tile Model - Data schema for individual LED tiles
 * 
 * Properties:
 * - modelName: Unique identifier/name of the tile model
 * - dimensions: Object containing height, width, depth in millimeters
 * - pixelPitch: Distance between pixel centers in millimeters (e.g., 2.6, 3.9)
 * - resolution: Optional pre-calculated resolution {pixelWidth, pixelHeight} in pixels
 * - power: Object with maxPower and avgPower consumption in watts
 * - weight: Weight per tile in kilograms (for rigging calculations)
 * - inventory: Object containing totalTiles and tilesPerCase
 * 
 * Note: Resolution can be pre-calculated or derived from: Dimension / Pixel Pitch
 */
export class LEDTileModel {
  constructor({
    modelName,
    dimensions = {},
    pixelPitch,
    resolution = {},
    power = {},
    weight,
    inventory = {}
  }) {
    this.modelName = modelName;
    this.dimensions = {
      height: dimensions.height || dimensions.height_mm || 0,  // mm
      width: dimensions.width || dimensions.width_mm || 0,    // mm
      depth: dimensions.depth || dimensions.depth_mm || 0     // mm
    };
    this.pixelPitch = pixelPitch;      // mm
    this.resolution = {
      pixelWidth: resolution.pixelWidth || 0,    // pre-calculated pixel width
      pixelHeight: resolution.pixelHeight || 0   // pre-calculated pixel height
    };
    this.power = {
      maxPower: power.maxPower || 0,   // Watts
      avgPower: power.avgPower || 0    // Watts
    };
    this.weight = weight;              // kg
    this.inventory = {
      totalTiles: inventory.totalTiles || 0,
      tilesPerCase: inventory.tilesPerCase || 0
    };
  }

  /**
   * Calculate or retrieve resolution of a single tile
   * If pre-calculated resolution is available, use it. Otherwise calculate from dimensions/pitch.
   * Formula: Resolution = Dimension / Pixel Pitch (if not pre-calculated)
   * 
   * @returns {Object} { pixelWidth, pixelHeight }
   */
  getResolution() {
    // Use pre-calculated resolution if available
    if (this.resolution.pixelWidth > 0 && this.resolution.pixelHeight > 0) {
      return {
        pixelWidth: this.resolution.pixelWidth,
        pixelHeight: this.resolution.pixelHeight
      };
    }
    // Fallback: calculate from dimensions and pixel pitch
    if (this.pixelPitch > 0 && this.dimensions.width > 0 && this.dimensions.height > 0) {
      return {
        pixelWidth: Math.round(this.dimensions.width / this.pixelPitch),
        pixelHeight: Math.round(this.dimensions.height / this.pixelPitch)
      };
    }
    return { pixelWidth: 0, pixelHeight: 0 };
  }

  /**
   * Get all tile specifications as a readable object
   * @returns {Object} Complete tile specifications
   */
  getSpecs() {
    return {
      modelName: this.modelName,
      dimensions: this.dimensions,
      pixelPitch: this.pixelPitch,
      power: this.power,
      weight: this.weight,
      inventory: this.inventory,
      resolution: this.getResolution()
    };
  }
}

/**
 * Calculate comprehensive LED wall specifications
 * 
 * This function takes a tile model and desired wall dimensions (in tiles)
 * and returns a complete breakdown of physical, electrical, and logistics specifications.
 * 
 * @param {LEDTileModel} selectedTileModel - The LED tile model to use
 * @param {Number} targetWidth - Number of tiles horizontally
 * @param {Number} targetHeight - Number of tiles vertically
 * @param {Number} voltage - Operating voltage in volts (default: 230V)
 * 
 * @returns {Object} Wall specifications including dimensions, resolution, power, and logistics
 */
export const calculateWallSpecs = (
  selectedTileModel,
  targetWidth,
  targetHeight,
  voltage = 230
) => {
  // Input validation
  if (!selectedTileModel || targetWidth <= 0 || targetHeight <= 0) {
    return null;
  }

  const tiles = selectedTileModel.getResolution();
  
  // ========== PHYSICAL DIMENSIONS ==========
  // Total width and height in millimeters, then convert to meters
  const totalWidthMm = selectedTileModel.dimensions.width * targetWidth;
  const totalHeightMm = selectedTileModel.dimensions.height * targetHeight;
  const totalDepthMm = selectedTileModel.dimensions.depth;
  
  const totalWidthM = totalWidthMm / 1000;
  const totalHeightM = totalHeightMm / 1000;
  
  // Total weight: number of tiles × weight per tile
  const totalTilesNeeded = targetWidth * targetHeight;
  const totalWeight = totalTilesNeeded * selectedTileModel.weight;

  // ========== RESOLUTION CALCULATION ==========
  // Total resolution = (Tiles × Resolution per Tile)
  const totalPixelWidth = tiles.pixelWidth * targetWidth;
  const totalPixelHeight = tiles.pixelHeight * targetHeight;

  // ========== POWER REQUIREMENTS ==========
  // Total max power: number of tiles × max power per tile
  const totalMaxWatts = selectedTileModel.power.maxPower * totalTilesNeeded;
  const totalAvgWatts = selectedTileModel.power.avgPower * totalTilesNeeded;
  
  // Calculate amps using Ohm's law: Amps = Watts / Voltage
  const totalMaxAmps = totalMaxWatts / voltage;
  const totalAvgAmps = totalAvgWatts / voltage;

  // ========== LOGISTICS ==========
  // Flight cases needed: ceiling division (round up to nearest full case)
  const tilesPerCase = selectedTileModel.inventory.tilesPerCase;
  const totalFlightCases = Math.ceil(totalTilesNeeded / tilesPerCase);

  return {
    wallConfiguration: {
      tilesWide: targetWidth,
      tilesHigh: targetHeight,
      tileModelName: selectedTileModel.modelName
    },
    physicalDimensions: {
      totalWidthMm,
      totalHeightMm,
      totalDepthMm,
      totalWidthM: parseFloat(totalWidthM.toFixed(2)),
      totalHeightM: parseFloat(totalHeightM.toFixed(2)),
      totalWeightKg: parseFloat(totalWeight.toFixed(2))
    },
    resolution: {
      totalPixelWidth,
      totalPixelHeight,
      pixelDensity: `${selectedTileModel.pixelPitch}mm`
    },
    power: {
      maxPowerWatts: totalMaxWatts,
      avgPowerWatts: totalAvgWatts,
      maxAmpsAt230V: parseFloat(totalMaxAmps.toFixed(2)),
      avgAmpsAt230V: parseFloat(totalAvgAmps.toFixed(2)),
      operatingVoltage: voltage
    },
    logistics: {
      totalTilesNeeded,
      tilesPerFlightCase: tilesPerCase,
      totalFlightCasesNeeded: totalFlightCases
    }
  };
};

/**
 * Calculate individual tile cost breakdown for a LED wall project
 * Useful for pricing quotations
 * 
 * @param {LEDTileModel} selectedTileModel - The LED tile model
 * @param {Number} targetWidth - Number of tiles horizontally
 * @param {Number} targetHeight - Number of tiles vertically
 * @param {Number} costPerTile - Cost per tile in rupees
 * @param {Number} gstPercentage - GST rate (default: 18%)
 * 
 * @returns {Object} Cost breakdown for the wall
 */
export const calculateLEDWallCost = (
  selectedTileModel,
  targetWidth,
  targetHeight,
  costPerTile,
  gstPercentage = 18
) => {
  if (!selectedTileModel || targetWidth <= 0 || targetHeight <= 0) {
    return null;
  }

  const totalTiles = targetWidth * targetHeight;
  const netCost = totalTiles * costPerTile;
  const gstAmount = netCost * (gstPercentage / 100);
  const grandTotal = netCost + gstAmount;

  return {
    totalTiles,
    costPerTile,
    netCost: parseFloat(netCost.toFixed(2)),
    gstPercentage,
    gstAmount: parseFloat(gstAmount.toFixed(2)),
    grandTotal: parseFloat(grandTotal.toFixed(2))
  };
};

/**
 * Calculate CAT 6 Signal Cable Ports Required for LED Wall
 * 
 * Each CAT 6 signal cable can support 650,000 pixels
 * Calculation: Ports = Floor(Total Pixels / 650000)
 * With backup signal: Total Ports = Primary Ports × 2
 * 
 * @param {Number} totalPixelWidth - Total wall width in pixels
 * @param {Number} totalPixelHeight - Total wall height in pixels
 * @returns {Object} Port requirements (primary, backup, total)
 */
export const calculateLEDSignalPorts = (totalPixelWidth, totalPixelHeight) => {
  const PIXELS_PER_CAT6_PORT = 650000;
  
  if (!totalPixelWidth || !totalPixelHeight || totalPixelWidth <= 0 || totalPixelHeight <= 0) {
    return null;
  }

  const totalPixels = totalPixelWidth * totalPixelHeight;
  
  // Floor division: round down to lower integer
  const primaryPorts = Math.floor(totalPixels / PIXELS_PER_CAT6_PORT);
  
  // Handle edge case: if result is 0 but pixels > 0, we still need 1 port
  const actualPrimaryPorts = primaryPorts === 0 && totalPixels > 0 ? 1 : primaryPorts;
  
  // Backup ports: double the primary ports for redundancy
  const backupPorts = actualPrimaryPorts * 2;
  
  // Total ports with backup
  const totalPorts = actualPrimaryPorts + backupPorts;

  return {
    totalPixels,
    pixelsPerPort: PIXELS_PER_CAT6_PORT,
    primaryPorts: actualPrimaryPorts,
    backupPorts,
    totalPortsWithBackup: totalPorts,
    // Additional info for technical reference
    technicalReference: {
      description: 'CAT 6 Signal Cable Port Requirements',
      formulaPrimary: `Floor(${totalPixels} / 650000) = ${actualPrimaryPorts}`,
      formulaBackup: `${actualPrimaryPorts} × 2 = ${backupPorts}`,
      note: 'Primary ports handle signal distribution; backup ports provide redundancy for system reliability'
    }
  };
};

// ── Cryptographic token generation ───────────────────────────────────────────
// Single source of truth for all security-sensitive random tokens.
// Never falls back to Math.random — throws instead so callers fail loudly.
export const generateSecureToken = (byteLength = 16) => {
  if (!window.crypto?.getRandomValues) {
    throw new Error('Web Crypto API unavailable — cannot generate secure token');
  }
  const bytes = new Uint8Array(byteLength);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

// ── Password hashing (PBKDF2-SHA-256 via Web Crypto API) ─────────────────────
// Output format: 'v2:{16-byte saltHex}:{32-byte hashHex}'
// Legacy SHA-256 hashes (64 hex chars, no prefix) are verified by
// verifyPassword() and upgraded to PBKDF2 transparently on next login.
export const hashPassword = async (plaintext) => {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(plaintext), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200000 },
    keyMaterial, 256
  );
  const toHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `v2:${toHex(salt.buffer)}:${toHex(bits)}`;
};

// Verify a plaintext password against any stored hash format:
//   'v2:saltHex:hashHex'  → PBKDF2 (current)
//   64 hex chars          → legacy SHA-256
//   anything else         → plaintext (very old installs)
export const verifyPassword = async (plaintext, storedHash) => {
  if (!plaintext || !storedHash) return false;
  const encoder = new TextEncoder();
  if (storedHash.startsWith('v2:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const salt = new Uint8Array(parts[1].match(/.{2}/g).map(b => parseInt(b, 16)));
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(plaintext), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200000 },
      keyMaterial, 256
    );
    const actual = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return actual === parts[2];
  }
  if (storedHash.length === 64 && /^[0-9a-f]+$/.test(storedHash)) {
    const buf = await crypto.subtle.digest('SHA-256', encoder.encode(plaintext));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hex === storedHash;
  }
  return plaintext === storedHash;
};

// ── HR Module Helpers ─────────────────────────────────────────────────────────

/** Haversine distance between two GPS coordinates in meters */
export const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Adjusted hours from a timeLog entry (subtracts geo penalty) */
export const getLogHours = (log) => {
  if (!log?.checkIn || !log?.checkOut) return 0;
  const diff = (new Date(log.checkOut) - new Date(log.checkIn)) / 3600000;
  const penalty = (log.geoPenaltyMinutes || 0) / 60;
  return Math.max(0, diff - penalty);
};

/** Returns the start of the Indian fiscal year (April 1) for a given date */
export const getFiscalYearStart = (date = new Date()) => {
  const d = new Date(date);
  const y = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
  return new Date(y, 3, 1);
};

/** Returns {start, end} of the fiscal quarter for a given date */
export const getFiscalQuarterRange = (date = new Date()) => {
  const d = new Date(date);
  const m = d.getMonth();
  const y = d.getFullYear();
  // Fiscal quarters: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar
  const quarters = [[3, 4, 5], [6, 7, 8], [9, 10, 11], [0, 1, 2]];
  for (const q of quarters) {
    if (q.includes(m)) {
      const startYear = q[0] >= 3 ? y : (m < 3 ? y : y + 1);
      return {
        start: new Date(startYear, q[0], 1),
        end: new Date(startYear + (q[2] < 3 ? 1 : 0), q[2] + 1, 0)
      };
    }
  }
  return { start: new Date(y, 3, 1), end: new Date(y, 5, 30) };
};

/** Compliance percentage: (actual hours / target) × 100 */
export const calculateCompliance = (monthlyHours, target) => {
  if (!target || target <= 0) return 0;
  return Math.round((monthlyHours / target) * 100);
};

/** Remaining leave balance per type after deducting approved leaves */
export const calculateLeaveBalance = (leaves, entitlements) => {
  const balance = { ...entitlements };
  (leaves || []).filter(l => l.status === 'Approved').forEach(l => {
    const days = getDaysDifference(l.startDate, l.endDate);
    if (balance[l.type] !== undefined) balance[l.type] = Math.max(0, balance[l.type] - days);
  });
  return balance;
};

// ── Leave pay (entitled = paid, excess = Loss of Pay) ───────────────────────
/** Calendar days (inclusive) of [startDate,endDate] that fall within [rangeStart,rangeEnd]. */
export const leaveDaysInRange = (startDate, endDate, rangeStart, rangeEnd) => {
  if (!startDate || !endDate) return 0;
  const day = 86400000;
  const s = new Date(startDate); s.setHours(0, 0, 0, 0);
  const e = new Date(endDate); e.setHours(0, 0, 0, 0);
  const rs = new Date(rangeStart); rs.setHours(0, 0, 0, 0);
  const re = new Date(rangeEnd); re.setHours(0, 0, 0, 0);
  const lo = s > rs ? s : rs;
  const hi = e < re ? e : re;
  if (hi < lo) return 0;
  return Math.floor((hi - lo) / day) + 1;
};

/** Split `days` of a leave into paid (within remaining balance) vs Loss-of-Pay. */
export const splitLeavePaidUnpaid = (days, balanceForType, isPaidType) => {
  const d = Math.max(0, Number(days) || 0);
  if (!isPaidType) return { paid: 0, lwp: d };
  const bal = Math.max(0, Number(balanceForType) || 0);
  const paid = Math.min(d, bal);
  return { paid, lwp: d - paid };
};

/** One leave day's pay = hourly rate × a standard work day (default 8h). */
export const dailyLeaveRate = (hourlyRate, dayHours = 8) =>
  Math.max(0, Number(hourlyRate) || 0) * (Number(dayHours) || 8);

/**
 * Approved paid-leave days for an employee inside [monthStart,monthEnd] that
 * still fall within the type's annual entitlement (entitlement year = calendar
 * year of monthStart). Days beyond the quota are Loss of Pay and excluded.
 * Used by payroll to credit paid leave.
 */
export const paidLeaveDaysInMonth = (leaves, empId, monthStart, monthEnd, paidTypes, entitlements) => {
  const yearStart = new Date(monthStart.getFullYear(), 0, 1);
  const prevDayEnd = new Date(monthStart.getTime() - 86400000);
  let total = 0;
  (paidTypes || []).forEach((type) => {
    const quota = Number(entitlements?.[type] || 0);
    if (quota <= 0) return;
    const approved = (leaves || []).filter(l => l.employeeId === empId && l.status === 'Approved' && l.type === type);
    let before = 0, inMonth = 0;
    approved.forEach((l) => {
      before += leaveDaysInRange(l.startDate, l.endDate, yearStart, prevDayEnd);
      inMonth += leaveDaysInRange(l.startDate, l.endDate, monthStart, monthEnd);
    });
    total += Math.min(inMonth, Math.max(0, quota - before));
  });
  return total;
};

// ── Daily report helpers ────────────────────────────────────────────────────
const _ymd = (d) => (d ? String(d).slice(0, 10) : '');
const _shiftYmd = (key, n) => { const d = new Date(key); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/** True if a project's setup/start/end window covers dateKey (YYYY-MM-DD). */
export const isProjectActiveOnDate = (project, dateKey) => {
  if (!project || !dateKey) return false;

  const projectDates = [_ymd(project.setup_date), _ymd(project.start_date), _ymd(project.end_date)].filter(Boolean);
  if (projectDates.length === 0) return false;

  const startKey = projectDates.reduce((earliest, current) => (!earliest || current < earliest ? current : earliest), '');
  const endKey = projectDates.reduce((latest, current) => (!latest || current > latest ? current : latest), '');

  return startKey <= dateKey && dateKey <= endKey;
};

/** Inclusive number of days in a project's window (min 1) — used to prorate per-day figures. */
export const projectDurationDays = (project) => {
  const startKey = _ymd(project?.setup_date || project?.start_date);
  const endKey = _ymd(project?.end_date || project?.start_date);
  if (!startKey || !endKey) return 1;
  return Math.max(1, Math.floor((new Date(endKey) - new Date(startKey)) / 86400000) + 1);
};

/** Total outsourcing cost for a project (active POs by effective cost + unlinked vendor allocations). */
export const getProjectOutsourcing = (project) => {
  const activePOs = (project?.purchase_orders || []).filter((po) => po && po.status !== 'Cancelled');
  const fromPOs = activePOs.reduce((acc, po) => acc + (getEffectivePOCost(po).total || 0), 0);
  const unlinked = (project?.vendor_allocations || []).filter((a) => a && !a.po_id);
  const fromAllocs = unlinked.reduce((acc, v) => acc + (Number(v.tax_amount) || 0), 0);
  return round2(fromPOs + fromAllocs);
};

// ── Project net profit (for referral commission) ────────────────────────────
// Direct costs = logistics (incl GST) + reimbursable expenses + dated project
// expenses (excluding rejected/disapproved). Mirrors BusinessReport.jsx exactly.
export const getProjectDirectCosts = (project, expenses = []) => {
  let logistics = 0;
  if (project?.logistics_costs) {
    Object.values(project.logistics_costs).forEach((c) => {
      logistics += (Number(c?.amount) || 0) * (1 + (Number(c?.gst) || 0) / 100);
    });
  }
  const reimbursable = (project?.reimbursable_expenses || []).reduce((s, e) => s + (Number(e?.amount) || 0), 0);
  const arraySum = (expenses || [])
    .filter((e) => e.project_id === project?.id && e.status !== 'Rejected' && e.status !== 'Disapproved')
    .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  // When the caller cannot see the project's expense rows (a Coordinator's expenses
  // are self-scoped by security rules), the live array sums to ~0 and would inflate
  // net profit / commission. Fall back to direct_expense_total, denormalised on the
  // project by the onExpenseWritten Cloud Function. See-all roles pass the full
  // array, so arraySum > 0 wins and stays live-accurate.
  const projectExpenses = (arraySum === 0 && typeof project?.direct_expense_total === 'number')
    ? project.direct_expense_total
    : arraySum;
  return round2(logistics + reimbursable + projectExpenses);
};

/** Net profit = revenue − direct costs − outsourcing (excludes manpower) — the
 *  basis for the referral commission. */
export const getProjectNetProfit = (project, expenses = []) => {
  if (!project) return 0;
  return round2(getProjectGrandTotal(project) - getProjectDirectCosts(project, expenses) - getProjectOutsourcing(project));
};

/** Sum of recorded payments for a project (cash received to date). */
export const getProjectPaidToDate = (projectId, payments = []) =>
  round2((payments || []).filter((p) => p.project_id === projectId).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0));

/** Realized referral commission for a project: rate% × net profit × fraction paid. */
export const getProjectCommission = (project, expenses = [], payments = [], ratePct = 10) => {
  if (!project) return { netProfit: 0, paid: 0, grand: 0, paidFraction: 0, commission: 0 };
  const netProfit = getProjectNetProfit(project, expenses);
  const grand = getProjectGrandTotal(project);
  const paid = getProjectPaidToDate(project.id, payments);
  const paidFraction = grand > 0 ? Math.min(1, paid / grand) : 0;
  const commission = round2(netProfit * (Number(ratePct) || 0) / 100 * paidFraction);
  return { netProfit, paid, grand, paidFraction, commission };
};

// Service/maintenance due status for an inventory item. Uses an explicit
// next_test_due if set, else last_service_date + service_interval_days.
// Returns { status: 'overdue'|'due_soon'|'ok'|'none', dueDate, days }.
export const getServiceStatus = (item, asOf = new Date()) => {
  if (!item) return { status: 'none' };
  let due = item.next_test_due || null;
  if (!due && item.last_service_date && Number(item.service_interval_days) > 0) {
    const d = new Date(item.last_service_date);
    d.setDate(d.getDate() + Number(item.service_interval_days));
    due = d.toISOString().slice(0, 10);
  }
  if (!due) return { status: 'none' };
  const today = new Date(asOf); today.setHours(0, 0, 0, 0);
  const dueDate = new Date(due); dueDate.setHours(0, 0, 0, 0);
  const days = Math.round((dueDate - today) / 86400000);
  if (days < 0) return { status: 'overdue', dueDate: due, days };
  if (days <= 14) return { status: 'due_soon', dueDate: due, days };
  return { status: 'ok', dueDate: due, days };
};
