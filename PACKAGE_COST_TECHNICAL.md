# Package Cost Feature - Technical Implementation Details

## Files Modified

### 1. `src/utils/helpers.js`
**Modified:** `getProjectGrandTotal()` function

**Before:**
```javascript
export const getProjectGrandTotal = (project) => {
  if (!project) return 0;
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
```

**After:**
```javascript
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
```

**Impact:** All uses of `getProjectGrandTotal()` now automatically respect package cost

---

### 2. `src/App.jsx`
Multiple modifications to the Projects component:

#### 2.1 State Initialization (Line ~962)
**Modified:** `newProj` initial state

Added fields:
- `package_cost: 0` - The fixed cost amount (excluding GST)
- `package_cost_gst: 18` - The GST rate to apply (default 18%)

#### 2.2 openCreate() Function (Line ~1115)
**Modified:** Reset form when creating new project

Ensures new projects start with:
```javascript
package_cost: 0, 
package_cost_gst: 18
```

#### 2.3 openEdit() Function (Line ~1124)
**Modified:** Load existing package cost when editing

Loads from existing project:
```javascript
package_cost: proj.package_cost || 0, 
package_cost_gst: proj.package_cost_gst || 18
```

#### 2.4 handleDuplicate() Function (Line ~1188)
**Modified:** Copy package cost when duplicating

Preserves:
```javascript
package_cost: project.package_cost || 0, 
package_cost_gst: project.package_cost_gst || 18
```

#### 2.5 Project Creation Modal (Line ~2220)
**Added:** Package Cost UI Section

```jsx
{/* Package Cost Section */}
<div className="border-t pt-3 mt-3">
  <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-3">
    <p className="text-xs text-blue-700">
      <strong>Package Cost:</strong> If specified, this will be the final revenue 
      for P&L and client invoicing, superseding item allocations and logistics costs.
    </p>
  </div>
  <div className="grid grid-cols-2 gap-2">
    <div>
      <label className="text-sm font-bold text-slate-800">Package Cost (Excl. GST)</label>
      <input type="number" min="0" step="0.01" className="w-full rounded border p-2" 
        value={newProj.package_cost || 0} 
        onChange={e => setNewProj({...newProj, package_cost: parseFloat(e.target.value) || 0})} 
        placeholder="0.00" />
    </div>
    <div>
      <label className="text-sm font-bold text-slate-800">GST %</label>
      <input type="number" min="0" max="100" step="0.01" className="w-full rounded border p-2" 
        value={newProj.package_cost_gst || 18} 
        onChange={e => setNewProj({...newProj, package_cost_gst: parseFloat(e.target.value) || 18})} 
        placeholder="18" />
    </div>
  </div>
  {newProj.package_cost > 0 && (
    <div className="mt-2 p-2 bg-white rounded border border-blue-100 text-sm">
      <div className="flex justify-between">
        <span className="text-slate-600">Subtotal:</span>
        <span className="font-medium">{formatCurrency(newProj.package_cost)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-600">GST ({newProj.package_cost_gst}%):</span>
        <span className="font-medium">
          {formatCurrency((newProj.package_cost * newProj.package_cost_gst) / 100)}
        </span>
      </div>
      <div className="flex justify-between text-base font-bold text-blue-700 border-t mt-1 pt-1">
        <span>Total Revenue:</span>
        <span>
          {formatCurrency(newProj.package_cost * (1 + newProj.package_cost_gst / 100))}
        </span>
      </div>
    </div>
  )}
</div>
```

**Features:**
- Info banner explaining package cost purpose
- Input for package cost amount (excluding GST)
- Input for GST percentage (customizable)
- Real-time calculation display
- Only shows calculation preview when package_cost > 0
- All fields use proper currency formatting

#### 2.6 Project P&L Report (Line ~5645)
**Modified:** `reportType === 'project_pnl'` calculation

```javascript
// Check if package cost is specified
const hasPackageCost = selectedProject.package_cost && selectedProject.package_cost > 0;

let totalRevenue = 0;
let revenueItems = [];

if (hasPackageCost) {
    // Use package cost as the sole revenue
    const gstRate = selectedProject.package_cost_gst || 18;
    const gstAmount = (selectedProject.package_cost * gstRate) / 100;
    totalRevenue = selectedProject.package_cost + gstAmount;
    revenueItems = [
        { Section: 'REVENUE', Item: 'Package Cost (Excl. GST)', Amount: selectedProject.package_cost },
        { Section: 'REVENUE', Item: `GST (${gstRate}%)`, Amount: gstAmount }
    ];
} else {
    // Calculate from items and logistics
    const equipmentRevenue = (selectedProject.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
    let logisticsRevenue = 0;
    if (selectedProject.logistics_costs) {
        Object.values(selectedProject.logistics_costs).forEach(c => {
           const base = c.amount || 0;
           logisticsRevenue += base * (1 + (c.gst || 0)/100);
        });
    }
    totalRevenue = equipmentRevenue + logisticsRevenue;
    revenueItems = [
        { Section: 'REVENUE', Item: 'Equipment Rental', Amount: equipmentRevenue },
        { Section: 'REVENUE', Item: 'Logistics & Services', Amount: logisticsRevenue }
    ];
}
```

**Logic:**
- Checks if `package_cost > 0`
- If yes: Uses simplified revenue with GST breakdown
- If no: Uses traditional item + logistics breakdown
- Costs section unchanged
- Profit calculation same for both

---

## Data Flow Diagram

```
Project Creation/Edit
        ↓
[Form Input: package_cost, package_cost_gst]
        ↓
handleSaveProject() → Firestore (with new fields)
        ↓
getProjectGrandTotal(project)
        ├─ if (package_cost > 0) → return package_cost × (1 + gst%)
        └─ else → return items + logistics
        ↓
Used by:
├─ Client Ledger → Invoice amount
├─ Client Balance → Invoiced amount  
├─ Project Revenue Summary → Revenue column
├─ P&L Report → Total Revenue line
├─ Dashboard → Revenue KPI
└─ Project List Export → Total Value column
```

---

## Query Usage

All Firestore queries remain unchanged. New fields are stored in the project document:

```javascript
// When saving project
const data = { 
    ...newProj, 
    invoice_status: newProj.invoice_status || 'Not Invoiced',
    updated_at: serverTimestamp() 
};

await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);

// Firestore Document Structure
{
    project_name: "Event",
    client_id: "xyz",
    items: [...],
    logistics_costs: {...},
    package_cost: 100000,           // NEW
    package_cost_gst: 18,           // NEW
    invoice_status: "Not Invoiced",
    created_at: Timestamp,
    updated_at: Timestamp
}
```

---

## Backward Compatibility

✅ **Fully Backward Compatible:**
- Existing projects without `package_cost` field work as before
- `getProjectGrandTotal()` defaults to item + logistics calculation
- All new fields have fallback defaults (`|| 0`, `|| 18`)
- No database migration required
- Existing reports continue to work

---

## Performance Considerations

- No additional database queries
- Helper function adds negligible processing (one if check)
- Form calculation uses client-side only
- No impact on Firestore read/write performance

---

## Security & Validation

- Input validation on form (type="number", min="0")
- Firestore security rules unchanged
- No sensitive calculations exposed
- GST rate limited to 0-100%
- Package cost must be > 0 to be effective

---

## Testing Recommendations

### Unit Tests
```javascript
// Test getProjectGrandTotal with package cost
const project = { package_cost: 1000, package_cost_gst: 18 };
expect(getProjectGrandTotal(project)).toBe(1180);

// Test backward compatibility
const legacyProject = { items: [{total: 1000}], logistics_costs: {} };
expect(getProjectGrandTotal(legacyProject)).toBe(1000);
```

### Integration Tests
- Create project with package cost
- Edit project package cost
- Verify all reports use updated value
- Export project and verify data
- Client ledger shows correct invoice amount
- P&L report shows package cost breakdown

### User Acceptance Tests
- Create fixed-price quote
- Verify client invoice uses package cost
- Verify P&L shows package cost
- Verify can still allocate items
- Verify can still add logistics costs
- Verify switching to no package cost reverts to calculated
