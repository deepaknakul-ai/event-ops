// c:\APP\temp\rental-ops\src\utils\helpers.js
import { GST_STATE_CODES } from './constants';

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

export const formatCurrencyPDF = (amount) => {
  return "Rs. " + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
};

export const normalizeGSTIN = (gstin) => {
  if (!gstin) return '';
  return String(gstin).trim().toUpperCase().replace(/\s+/g, '');
};

export const validateGSTIN = (gstin, stateCode) => {
  void stateCode;
  const norm = normalizeGSTIN(gstin);
  if (!norm || norm.length !== 15) return { valid: false, msg: 'Length must be 15' };
  const firstTwo = norm.substring(0, 2);
  if (!GST_STATE_CODES[firstTwo]) return { valid: false, msg: 'Invalid State Code' };
  const regex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (!regex.test(norm)) return { valid: false, msg: 'Invalid Format Pattern' };
  return { valid: true, msg: 'Valid', value: norm };
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
  const isIntraState = orgState && clientState && orgState === clientState;
  const supplyType = isIntraState ? 'CGST_SGST' : 'IGST';

  const items = [];

  if (project.package_cost && project.package_cost > 0) {
    const gstRate = parseFloat(project.package_cost_gst || 18);
    const taxable = parseFloat(project.package_cost);
    const gstAmt = taxable * (gstRate / 100);
    items.push({
      description: 'Package Cost',
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
  } else {
    // Equipment items
    (project.items || []).forEach(item => {
      const gstRate = parseFloat(item.gst_rate || 18);
      const taxable = parseFloat(item.amount || 0); // amount = qty × rate × days (pre-GST)
      const gstAmt = parseFloat(item.gst_amount || taxable * (gstRate / 100));
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
          const gstRate = parseFloat(line.gst || 18);
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
