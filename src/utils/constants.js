// c:\APP\temp\rental-ops\src\utils\constants.js
import React from 'react';
import { Truck, Hotel, Utensils, Briefcase } from 'lucide-react';
import { IS_SAAS } from './edition';

// Tenant id. PRIVATE: a fixed compile-time constant — `IS_SAAS` folds to false
// so this whole block reduces to `let appId = 'TERMS 1.0.0'` and setAppId is a
// no-op (byte-stable private behavior). SAAS: resolved per tenant from the
// company code entered at login, persisted in localStorage across reloads.
//
// Exported as `let` so it is an ESM LIVE BINDING — every importer sees the
// current value with no code changes at the import site. IMPORTANT: consumers
// must read `appId` at CALL TIME (inside functions/effects), never capture it
// at module-eval time. All current importers already do; keep it that way.
const PRIVATE_APP_ID = 'TERMS 1.0.0';
const SAAS_TENANT_KEY = 'saasTenantId';

export let appId = IS_SAAS
  ? (() => { try { return localStorage.getItem(SAAS_TENANT_KEY) || ''; } catch { return ''; } })()
  : PRIVATE_APP_ID;

// Set the active tenant (SaaS only). No-op in private builds so it can be
// called unconditionally from shared login code. Call BEFORE the auth state
// change that triggers data subscriptions so effects re-run with the new value.
export function setAppId(next) {
  if (!IS_SAAS) return;
  appId = String(next || '').trim();
  try {
    if (appId) localStorage.setItem(SAAS_TENANT_KEY, appId);
    else localStorage.removeItem(SAAS_TENANT_KEY);
  } catch { /* storage unavailable — in-memory value still updates */ }
}

export const GST_STATE_CODES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "25": "Dadra & Nagar Haveli and Daman & Diu", "26": "Dadra & Nagar Haveli", "27": "Maharashtra",
  "28": "Andhra Pradesh (New)", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala",
  "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh (Old)", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction"
};

// Valid GST rate slabs (%) as notified by GST Council.
export const VALID_GST_RATES = [0, 0.1, 0.25, 1, 1.5, 2.5, 3, 5, 6, 7.5, 9, 12, 14, 18, 28];

// Common SAC codes for AV/events rental business.
export const COMMON_SAC_CODES = {
  '997212': 'Rental of other machinery and equipment (18%)',
  '997313': 'Sound and lighting equipment rental (18%)',
  '998596': 'Event management and related services (18%)',
  '996812': 'Road transport services (18%)',
  '996311': 'Hotel/accommodation services (12%)',
  '996331': 'Catering/food services (5%)',
  '998399': 'Other professional and technical services (18%)',
};

// Character set used in GSTIN checksum computation (GSTN spec).
export const GSTIN_CHECKSUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const STATUS_COLORS = {
  'Draft': 'bg-slate-100 text-slate-600 border-slate-300',
  'Quoted': 'bg-orange-100 text-orange-800 border-orange-200',
  'Confirmed': 'bg-green-100 text-green-800 border-green-200',
  'Cancelled': 'bg-gray-100 text-gray-800 border-gray-200',
  'Ongoing': 'bg-red-100 text-red-800 border-red-200',
  'Completed': 'bg-blue-100 text-blue-800 border-blue-200',
  'Closed': 'bg-[#003366] text-white border-[#003366]',
};

export const LOGISTICS_TYPES = [
  { id: 'travel', label: 'Travel Cost', icon: React.createElement(Truck, { size: 14 }) },
  { id: 'accommodation', label: 'Accommodation', icon: React.createElement(Hotel, { size: 14 }) },
  { id: 'food', label: 'Food & Beverage', icon: React.createElement(Utensils, { size: 14 }) },
  { id: 'labour', label: 'Labour Cost', icon: React.createElement(Briefcase, { size: 14 }) },
  { id: 'transport', label: 'Transportation', icon: React.createElement(Truck, { size: 14 }) },
];

export const CATEGORIES = ['Sound', 'Lighting', 'Video', 'Camera', 'Trussing', 'Rigging', 'Projectors', 'LED', 'LED Wall', 'Power', 'Cables', 'Accessories'];
export const EXPENSE_CATS = ['Travel', 'Food', 'Lodging', 'Fuel', 'Local Transport', 'Consumables', 'Misc', 'Labour'];

// LED Wall Module - Tile Model Registry
export const LED_WALL_TILE_MODELS = {
  // This registry stores predefined LED tile models for quick access
  // Developers can populate this with standard tile specifications used in projects
  // Example structure for reference (populate as needed):
  /*
  'P2.6_500x500': {
    modelName: 'P2.6 500x500',
    dimensions: { height: 500, width: 500, depth: 100 },
    pixelPitch: 2.6,
    power: { maxPower: 120, avgPower: 80 },
    weight: 8.5,
    inventory: { totalTiles: 150, tilesPerCase: 6 }
  }
  */
};

// ── HR Module Constants ───────────────────────────────────────────────────────
export const LEAVE_ENTITLEMENTS = { Casual: 12, Sick: 8, Earned: 15 };
export const LOCATION_TYPES = ['HQ', 'Site', 'Remote'];
export const SHIFT_REQUEST_STATUSES = ['Pending', 'Approved', 'Rejected', 'Clarification'];
export const LEAVE_TYPES = ['Casual', 'Sick', 'Earned'];
// Leave types that are PAID up to the employee's remaining annual entitlement.
// Days taken beyond the remaining balance fall through to Loss of Pay (unpaid).
export const LEAVE_PAID_TYPES = ['Casual', 'Sick', 'Earned'];
// Standard paid hours in one leave day (used to value a leave day from hourly rate).
export const LEAVE_DAY_HOURS = 8;
export const HR_STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800 border-amber-200',
  Approved: 'bg-green-100 text-green-800 border-green-200',
  Rejected: 'bg-red-100 text-red-800 border-red-200',
  Clarification: 'bg-purple-100 text-purple-800 border-purple-200',
  Cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
};
export const DEFAULT_HQ_SETTINGS = {
  lat: 28.6139, lng: 77.2090, strictMode: false, geoRadiusMeters: 400,
  windowStart: '08:00', windowEnd: '11:00', enforceTime: false,
  maxShiftHours: 12, autoCloseHours: 18, graceMinutes: 10, geoPenaltyMinutes: 40,
};
