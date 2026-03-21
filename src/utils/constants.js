// c:\APP\temp\rental-ops\src\utils\constants.js
import React from 'react';
import { Truck, Hotel, Utensils, Briefcase } from 'lucide-react';

export const appId = 'TERMS 1.0.0';

export const GST_STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "19": "West Bengal", "27": "Maharashtra",
  "29": "Karnataka", "33": "Tamil Nadu", "36": "Telangana"
};

export const STATUS_COLORS = {
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
