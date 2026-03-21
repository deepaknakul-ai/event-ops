// c:\APP\temp\rental-ops\src\utils\helpers.js
import { GST_STATE_CODES } from './constants';

export const getProjectGrandTotal = (project) => {
  if (!project) return 0;
  
  // If package cost is specified, it supersedes all other costs
  if (project.package_cost && project.package_cost > 0) {
    const gstRate = project.package_cost_gst || 18;
    return project.package_cost * (1 + gstRate / 100);
  }
  
  // Otherwise, calculate from items and logistics
  const equipment = (project.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
  let logistics = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       const base = c.amount || 0;
       logistics += base * (1 + (c.gst || 0)/100);
    });
  }
  return equipment + logistics;
};

export const getProjectNetTotal = (project) => {
  if (!project) return 0;
  if (project.package_cost && project.package_cost > 0) {
    return project.package_cost;
  }
  const equipment = (project.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
  let logistics = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       logistics += c.amount || 0;
    });
  }
  return equipment + logistics;
};

export const getProjectGST = (project) => {
  if (!project) return 0;
  
  if (project.package_cost && project.package_cost > 0) {
    const gstRate = project.package_cost_gst || 18;
    return project.package_cost * (gstRate / 100);
  }
  
  let totalGST = 0;
  // Note: Equipment cost (from items) is assumed to be inclusive of GST by default in the old system.
  // This is a simplification. A more robust solution would be to have GST specified per item.
  // For now, we assume items contribute 0 to the separate GST calculation and are part of the net.
  
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       const base = c.amount || 0;
       totalGST += base * ((c.gst || 0)/100);
    });
  }
  return totalGST;
};

export const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount || 0);
};

export const formatCurrencyPDF = (amount) => {
  return "Rs. " + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
};

export const validateGSTIN = (gstin, stateCode) => {
  if (!gstin || gstin.length !== 15) return { valid: false, msg: 'Length must be 15' };
  const firstTwo = gstin.substring(0, 2);
  if (!GST_STATE_CODES[firstTwo]) return { valid: false, msg: 'Invalid State Code' };
  const regex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (!regex.test(gstin)) return { valid: false, msg: 'Invalid Format Pattern' };
  return { valid: true, msg: 'Valid' };
};

export const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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

// ── Password hashing (SHA-256 via Web Crypto API) ─────────────────────────────
export const hashPassword = async (plaintext) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};
