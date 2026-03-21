# LED Wall System Setup & Usage Guide

## Overview

The rental-ops system now includes a comprehensive **LED Wall Management System** that supports modular LED tiles for building custom wall configurations. This guide explains how to set up and use the LED tile model feature.

---

## 1. Setting Up an LED Inventory Item

### Step 1: Create an Inventory Item with "LED" Category

1. Navigate to **Inventory** → Click **Add Inventory Item**
2. Fill in **General** tab:
   - **Item Name/Model**: e.g., `LED Wall P3.9`
   - **Brand**: e.g., `SolidRent Pro Series`
   - **Category**: Select **LED** (required)
   - **Sub-Category**: e.g., `LED Panel Tiles`
   - **Total Qty**: Total number of tiles you own (e.g., 200)
   - **Status**: Available

### Step 2: Enter Tile Model Specifications

3. Click **Tech Specs** tab
4. Look for the **LED Tile Model Specifications** section (appears only when category = "LED")
5. Fill in the following fields:

| Field | Example | Description |
|-------|---------|-------------|
| **Model Name** | P3.9-500x500 | Unique identifier/model number |
| **Pixel Pitch (mm)** | 3.9 | Distance between pixel centers |
| **Width (mm)** | 500 | Tile width in millimeters |
| **Height (mm)** | 500 | Tile height in millimeters |
| **Depth (mm)** | 60 | Tile depth in millimeters |
| **Weight per Tile (kg)** | 7.5 | Weight of a single tile (for rigging calcs) |
| **Max Power (W)** | 120 | Maximum power consumption per tile |
| **Avg Power (W)** | 60 | Average power consumption per tile |
| **Total Tiles Owned** | 200 | How many tiles you currently have |
| **Tiles per Flight Case** | 4 | How many tiles fit in one shipping case |

### Step 3: Optional Commercial & Logistics Info

6. In **Commercial** tab (if needed):
   - **Daily Rate**: Rental cost per day
   - **Purchase Cost**: What you paid for the tiles

7. In **Logistics** tab (if needed):
   - **Power (Watts)**: Total max power for reference
   - **Connector Type**: e.g., "Powercon, HDMI"
   - **IP Rating**: e.g., "IP54"

8. Click **Create Item**

---

## 2. Allocating an LED Wall to a Project

### Step 1: Create or Open a Project

1. Navigate to **Projects**
2. Create a new quote or open an existing project

### Step 2: Add the LED Item to the Project

1. Click **+ Add Item** in the "Allocated Equipment" section
2. **Select Item**: Choose your LED inventory item (e.g., `LED Wall P3.9`)
3. You'll see the allocation form shows:
   - Available Qty (total tiles you own)
   - Rate/Day
   - GST%

### Step 3: Specify the Wall Configuration

4. A new **LED Wall Configuration** section appears with:
   - **Tiles Wide** (no. of tiles): e.g., `8` (for an 8-tile wide display)
   - **Tiles High** (no. of tiles): e.g., `4` (for a 4-tile tall display)

5. As you enter the tiles wide and high, a **live preview** shows:
   - **Size**: Total dimensions in mm, meters, and feet
   - **Resolution**: Total pixel width × height
   - **Total Tiles**: 8 × 4 = 32 tiles
   - **Weight**: Total weight for rigging (e.g., 240 kg)
   - **Power**: Total max and average watts, plus amperage at 230V
   - **Flight Cases**: How many cases needed (e.g., 8 cases for 32 tiles with 4 tiles/case)

### Step 4: Set Rental Terms

6. Adjust **Qty** (pre-filled with total tiles needed), **Days**, **Rate/Day** if needed
7. Click **Add & Keep Open** to add the allocation

---

## 3. LED Details in Project Reports

### Project Details View

When you have LED allocations in a project, the project detail view shows a **LED Wall Details** box with:
- Wall configuration (e.g., `8 × 4 tiles`)
- Physical size (mm, m, ft)
- Resolution (pixels)
- Total tiles and weight
- Power consumption (max/avg) and amperage

### PDF Quotation Export

The **Quotation PDF** now includes an **LED Wall Details** section after the items table:
- Model name and tile configuration
- Physical dimensions and resolution
- Power requirements and flight cases

### Excel Quotation Export

The **Quotation Excel** file includes rows for:
- LED item details (qty, rate, amount)
- Size, Resolution, Power info per LED wall

---

## 4. Data Storage & Structure

LED tile model data is stored on each LED inventory item under the `tile_model` field:

```json
{
  "id": "inventory_id",
  "name": "LED Wall P3.9",
  "category": "LED",
  "tile_model": {
    "modelName": "P3.9-500x500",
    "pixelPitch": 3.9,
    "dimensions": {
      "width_mm": 500,
      "height_mm": 500,
      "depth_mm": 60
    },
    "power": {
      "maxPower": 120,
      "avgPower": 60
    },
    "weight": 7.5,
    "inventory": {
      "totalTiles": 200,
      "tilesPerCase": 4
    }
  }
}
```

When a project allocates an LED item, the allocation stores:

```json
{
  "item_name": "LED Wall P3.9",
  "qty": 32,
  "led": {
    "tilesWide": 8,
    "tilesHigh": 4,
    "specs": {
      "wallConfiguration": { "tilesWide": 8, "tilesHigh": 4 },
      "physicalDimensions": { "totalWidthMm": 4000, "totalHeightMm": 2000, "totalWeightKg": 240 },
      "resolution": { "totalPixelWidth": 1024, "totalPixelHeight": 512 },
      "power": { "maxPowerWatts": 3840, "avgPowerWatts": 1920, "maxAmpsAt230V": 16.7 }
    }
  }
}
```

---

## 5. Calculation Formulas

All LED calculations use the `calculateWallSpecs()` function from `src/utils/helpers.js`:

- **Tile Resolution**: Pixels = Dimension (mm) ÷ Pixel Pitch (mm)
- **Wall Size**: Total mm = Tile Dimension × Tile Count
- **Wall Weight**: Total kg = Tiles Count × Weight per Tile
- **Wall Power**: Total W = Tiles Count × Power per Tile
- **Wall Amps**: Total A = Total W ÷ Voltage (230V default)
- **Flight Cases**: Count = ⌈ Total Tiles ÷ Tiles per Case ⌉

---

## 6. Example: Creating a P3.9 1920×1080 LED Wall

### Setup Inventory Item:
- **Model Name**: P3.9-1920x1080
- **Pixel Pitch**: 3.9 mm
- **Tile Width**: 500 mm
- **Tile Height**: 500 mm
- **Tile Depth**: 60 mm
- **Tile Weight**: 7.5 kg
- **Max Power**: 120 W
- **Avg Power**: 60 W
- **Total Tiles Owned**: 200
- **Tiles per Case**: 4

### Allocate to Project:
- **Tiles Wide**: 8 (= 4000 mm / 500 mm = 4.0 m)
- **Tiles High**: 4 (= 2000 mm / 500 mm = 2.0 m)

### Calculated Result:
- **Wall Size**: 4.0 m × 2.0 m (13.1 ft × 6.6 ft)
- **Total Resolution**: 1024 × 512 pixels
- **Total Tiles**: 32 tiles
- **Total Weight**: 240 kg (for rigging)
- **Max Power**: 3,840 W (16.7 A @ 230V)
- **Avg Power**: 1,920 W (8.3 A @ 230V)
- **Flight Cases**: 8 cases (4 tiles per case)

---

## 7. Common Issues & Troubleshooting

| Issue | Solution |
|-------|----------|
| **LED section doesn't appear in Tech Specs** | Ensure category is set to "LED" (not "Lighting" or "Video") |
| **Can't allocate LED to project** | Check that the LED inventory item has `tile_model` data filled in |
| **Live preview shows "Missing tile details"** | Verify all tile_model fields are populated in inventory |
| **Flight case count seems wrong** | Check `tilesPerCase` value; calculation uses: ceil(totalTiles / tilesPerCase) |
| **Power consumption incorrect** | Verify `power.maxPower` and `power.avgPower` are set per tile, not total |

---

## 8. Tips & Best Practices

✅ **Do:**
- Create separate LED inventory items for each tile model/size
- Round flight case counts up (use ceiling division)
- Store power per tile, not total wall power
- Use millimeters for all dimension fields
- Test with small wall configs first (e.g., 2×2) before complex setups

❌ **Don't:**
- Mix different pixel pitches in one wall
- Store total power instead of per-tile power
- Use dimensions other than millimeters
- Delete tiles from cases mid-project (affects logistics count)

---

## 9. API Reference

### LEDTileModel Class

```javascript
import { LEDTileModel, calculateWallSpecs } from './utils/helpers';

// Create a tile model
const tile = new LEDTileModel({
  modelName: 'P3.9-500x500',
  dimensions: { width: 500, height: 500, depth: 60 },
  pixelPitch: 3.9,
  power: { maxPower: 120, avgPower: 60 },
  weight: 7.5,
  inventory: { totalTiles: 200, tilesPerCase: 4 }
});

// Get tile specs
const specs = tile.getSpecs();
// Returns: { modelName, dimensions, pixelPitch, power, weight, inventory, resolution }

// Calculate wall specs
const wallSpecs = calculateWallSpecs(tile, 8, 4, 230);
// Returns comprehensive wall breakdown (size, resolution, power, logistics)
```

---

## 10. Next Steps

- Add more LED inventory items for different models
- Create test projects with LED allocations
- Generate quotations to verify PDF/Excel exports
- Monitor project profit & loss including LED logistics

---

**Version**: 1.0  
**Last Updated**: February 3, 2026  
**Status**: Fully Integrated
