# CAT 6 Signal Ports - Quick Reference

## Formula
```
Primary Ports = Floor(Total Pixels ÷ 650,000)
Backup Ports = Primary Ports × 2
Total with Backup = Primary + Backup
```

## Where It's Displayed

✅ **Project Details** → LED Wall Details box (right sidebar)
✅ **Allocation Modal** → Live preview while configuring tiles
✅ **PDF Export** → Technical reference line per LED item
✅ **Excel Export** → Technical row showing port counts

## Examples

### 4×3 Wall (P3.9) = 512×384px
- **Total Pixels:** 196,608
- **Primary Ports:** 1
- **Backup Ports:** 2
- **Total:** 3

### 10×8 Wall (P2.6) = 1,280×1,024px
- **Total Pixels:** 1,310,720
- **Primary Ports:** 2
- **Backup Ports:** 4
- **Total:** 6

### 16×12 Wall (P1.5) = 3,072×2,304px
- **Total Pixels:** 7,077,888
- **Primary Ports:** 10
- **Backup Ports:** 20
- **Total:** 30

## Key Points

- **650,000 pixels** per CAT 6 cable capacity
- **Floor division** used (round down to nearest integer)
- **Backup is 2x** primary for system redundancy
- Minimum **1 primary port** even for small displays
- Zero resolution → No port calculation (skipped)

## Code Location

- **Function:** `src/utils/helpers.js` line ~339
- **Import:** `src/App.jsx` line ~27
- **Project View:** `src/App.jsx` line ~2375
- **Allocation Modal:** `src/App.jsx` line ~2565
- **PDF Export:** `src/App.jsx` line ~1385
- **Excel Export:** `src/App.jsx` line ~1517

## What Each Port Type Does

**Primary Ports:**
- Carry main video/data signal from controller to wall
- User-entered number based on pixel count
- Each supports exactly 650K pixels

**Backup Ports:**
- Provide failover if primary fails
- Keep system running during maintenance
- Standard: 2× primary (double redundancy)
- Critical for live events

---

**Status:** Implemented ✅ | Build: Success ✅ | Tests: Passed ✅
