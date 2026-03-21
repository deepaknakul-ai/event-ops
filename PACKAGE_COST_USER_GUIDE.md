# Package Cost Feature - User Guide

## For Project Managers/Admins

### Creating a Project with Package Cost

1. **Click "Create New Quote"** button in Projects section
2. **Fill in basic details:**
   - Project Name
   - Client
   - Setup Date, Start Date, End Date
   - Venue

3. **NEW: Add Package Cost (Optional)**
   - Scroll down to "Package Cost" section
   - Enter **Package Cost (Excl. GST)** - e.g., 100000
   - Adjust **GST %** if needed (default: 18%)
   - Real-time preview shows:
     - Subtotal (your cost)
     - GST amount
     - **Total Revenue** (bold - what client will be invoiced)

4. **Item Allocation (Still Works!)**
   - You can still allocate items to the project
   - When package cost is set, these allocations are for operational tracking only
   - Revenue used for invoicing/P&L will be the package cost

5. **Save Project**

### Example Scenario

**Project: Annual Conference Setup**
- Equipment allocation: 50 projectors, 100 speakers, staging = ₹250,000 calculated
- Logistics: Travel + accommodation = ₹50,000 calculated
- **But**: Package negotiated with client = ₹280,000 (excl. GST)

**With Package Cost Feature:**
- Set: Package Cost = ₹280,000, GST = 18%
- Total Revenue = ₹280,000 × 1.18 = **₹330,400**
- This amount appears in:
  - Client invoice
  - P&L report
  - Client ledger
- Equipment/logistics tracking remains for operational use

---

## Reports & Analytics

### Client Ledger Report
**Shows:** Package cost amount as invoice debit

### Project P&L Report
**With Package Cost:**
```
REVENUE
├─ Package Cost (Excl. GST)     ₹280,000
├─ GST (18%)                    ₹50,400
└─ Total Revenue               ₹330,400

COSTS
├─ Outsourcing (Vendors)        -₹80,000
├─ Direct Expenses              -₹20,000
└─ Total Costs                  -₹100,000

PROFIT
└─ Net Profit / Loss           ₹230,400
```

**Without Package Cost:**
```
REVENUE
├─ Equipment Rental             ₹250,000
├─ Logistics & Services         ₹50,000
└─ Total Revenue               ₹300,000

[Costs and Profit as above]
```

### Project List
- Column "Total Value" shows package cost amount (with GST)

### Client Balance Report
- "Client Inv" uses package cost revenue

### Dashboard KPI
- Revenue metric includes package cost projects

---

## Key Points

✅ **Package cost supersedes item allocations** - Use it for fixed-price contracts
✅ **GST is customizable** - Adjust per project if needed
✅ **Item allocation still works** - Keep it for operational tracking
✅ **Easy to edit** - Open project, modify package cost, save
✅ **Automatic in all reports** - No manual entries needed
✅ **Invoice integration** - Client invoices show package cost total

---

## When to Use Package Cost

### Use Package Cost When:
- Client has negotiated a fixed total fee
- You want a simplified revenue view
- Equipment allocations are complex but final price is fixed
- Creating fixed-price quotes

### Don't Need Package Cost When:
- Each item has separate rates (traditional rental)
- Logistics are billed separately
- You want detailed revenue breakdown
- Customer bills by items (not package)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Package cost not showing in report | Ensure package_cost > 0 in project |
| P&L shows old breakdown | If package_cost was just added, refresh page |
| Can't edit package cost | Open project in edit mode from project list |
| Package cost not in invoice | Confirm project status is "Completed" or "Closed" |
