# 🧪 Testing Guide: Automatic Revenue Recognition

## Test 1: Historical Completed Projects

### **Setup**
Assume you have old projects that were completed BEFORE the accounting system was introduced.

### **Test Steps**

1. **Check existing completed projects**:
```
Projects Module:
  - Find projects with status = "Completed"
  - Note how many don't have invoices
```

2. **Go to Accounting Module**:
```
Accounting → Non-Invoiced Sales tab
```

3. **Expected Result**:
```
✅ Should show ALL completed projects without invoices
✅ Including old projects from before accounting was introduced
✅ Revenue calculated automatically
```

### **Example**

**Projects Data**:
```javascript
[
  {
    id: 'PROJ_001',
    project_name: 'Wedding - Taj Hotel',
    status: 'Completed',
    end_date: '2023-06-15',  // ← 6 months ago!
    client_id: 'CLIENT_123',
    items: [{ total: 100000 }]
    // NO invoice_status, NO tax invoice
  },
  {
    id: 'PROJ_002',
    project_name: 'Corporate Event',
    status: 'Completed',
    end_date: '2023-12-20',
    client_id: 'CLIENT_456',
    items: [{ total: 50000 }]
    // NO invoice_status, NO tax invoice
  }
]
```

**Expected in Non-Invoiced Sales Book**:
```
┌──────────┬─────────────────────────┬──────────────┬────────────────┬──────────┐
│ Date     │ Project Name            │ Client       │ Status         │ Total    │
├──────────┼─────────────────────────┼──────────────┼────────────────┼──────────┤
│ 06/15/23 │ Wedding - Taj Hotel     │ ABC Events   │ Pending Invoice│ 1,00,000 │
│ 12/20/23 │ Corporate Event         │ XYZ Corp     │ Pending Invoice│   50,000 │
└──────────┴─────────────────────────┴──────────────┴────────────────┴──────────┘

Total Non-Invoiced Revenue: ₹1,50,000
```

---

## Test 2: New Project Completion

### **Test Steps**

1. **Create and complete a new project today**:
```
1. Create Project: "Birthday Party - Radisson"
2. Add items (e.g., Projector, Sound System)
3. Mark status = "Completed"
4. Save
```

2. **Go to Accounting Module**:
```
Accounting → Non-Invoiced Sales tab
```

3. **Expected Result**:
```
✅ Project appears immediately
✅ Revenue calculated from items + logistics
✅ Shows as "Pending Invoice"
```

---

## Test 3: Invoice Creation (Movement)

### **Test Steps**

1. **Before Invoice**:
```
Accounting → Non-Invoiced Sales
  - Note project "Wedding - Taj Hotel" is there
  - Total: ₹1,00,000
```

2. **Create Tax Invoice**:
```javascript
// In Accounting Module → Sales Tab → Create Tax Invoice
{
  invoice_no: 'SI-0001-2024-25',
  invoice_date: '2024-01-15',
  project_id: 'PROJ_001',  // ← Link to "Wedding - Taj Hotel"
  taxable_amount: 84745.76,
  gst_amount: 15254.24,
  grand_total: 100000
}
```

3. **After Invoice - Check Non-Invoiced Sales**:
```
Accounting → Non-Invoiced Sales
Expected:
  ✅ "Wedding - Taj Hotel" is GONE
  ✅ Total reduced by ₹1,00,000
```

4. **Check Invoiced Sales**:
```
Accounting → Invoiced Sales
Expected:
  ✅ Invoice "SI-0001-2024-25" appears
  ✅ Shows client, invoice date, amounts
  ✅ Total: ₹1,00,000
```

---

## Test 4: Financial Year Filtering

### **Test Steps**

1. **Select FY 2023-24**:
```
Accounting → Select FY: 2023-24
```

2. **Expected Result**:
```
Non-Invoiced Sales:
  ✅ Shows only projects completed in FY 2023-24
  
Invoiced Sales:
  ✅ Shows only invoices dated in FY 2023-24
```

3. **Select "All FY"**:
```
Accounting → Select FY: All FY
```

4. **Expected Result**:
```
✅ Shows ALL completed projects across all FYs
✅ Shows ALL invoices across all FYs
```

---

## Test 5: P&L Impact

### **Test Steps**

1. **Check P&L Before Invoice**:
```
Accounting → P&L tab

Expected:
Revenue
  Non-Invoiced Sales Revenue: ₹1,50,000  ← From completed projects
  Sales Revenue: ₹0  ← No invoices yet
Total Revenue: ₹1,50,000
```

2. **Create Invoice for one project**

3. **Check P&L After Invoice**:
```
Accounting → P&L tab

Expected:
Revenue
  Non-Invoiced Sales Revenue: ₹50,000  ← Reduced
  Sales Revenue: ₹1,00,000  ← Increased
Total Revenue: ₹1,50,000  ← Same total!
```

**Key Point**: Total revenue stays the same, just moves between accounts.

---

## Test 6: Trial Balance Verification

### **Test Steps**

1. **Go to Trial Balance**:
```
Accounting → Trial Balance tab
```

2. **Expected Accounts**:
```
┌────────────────────────────────┬─────────┬─────────┬─────────┐
│ Account                         │ Debit   │ Credit  │ Balance │
├────────────────────────────────┼─────────┼─────────┼─────────┤
│ Accounts Receivable: ABC Events │ 100,000 │       0 │ 100,000 │
│ Non-Invoiced Sales Revenue      │       0 │  84,746 │ -84,746 │
│ Output GST Payable              │       0 │  15,254 │ -15,254 │
└────────────────────────────────┴─────────┴─────────┴─────────┘

Total Debits: 100,000
Total Credits: 100,000
✅ BALANCED
```

---

## ✅ Success Criteria

All tests should show:

- [ ] Historical completed projects appear in Non-Invoiced Sales
- [ ] New completed projects appear immediately
- [ ] Creating invoice moves project from Non-Invoiced to Invoiced
- [ ] P&L shows both revenue types
- [ ] Trial Balance always balanced
- [ ] FY filtering works correctly
- [ ] No manual journal entries needed

---

## 🐛 Troubleshooting

### Issue: Old projects not showing

**Check**:
```javascript
// 1. Project status
console.log(project.status);  // Must be "Completed" or "Closed"

// 2. Has invoice?
const hasInvoice = taxInvoices.some(inv => inv.project_id === project.id);
console.log('Has Invoice:', hasInvoice);  // Should be false

// 3. In selected FY?
const projectFY = getFYFromDate(project.end_date);
console.log('Project FY:', projectFY, 'Selected:', fyFilter);
```

**Solution**: Ensure project has `end_date` or `completion_date` field.

---

### Issue: Project showing in both books

**This should NEVER happen!**

If it does, there's a bug. Check:
```javascript
const invoicedIds = taxInvoices.map(inv => inv.project_id);
console.log('Invoiced IDs:', invoicedIds);
console.log('Project ID:', project.id);
console.log('Is invoiced?', invoicedIds.includes(project.id));
```

---

## 📝 Notes

1. **No Manual Entry Needed**: System automatically detects and shows completed projects
2. **Works for Old Data**: Historical projects before accounting system are included
3. **Real-time Updates**: Refresh accounting page to see latest data
4. **Automatic Movement**: Creating invoice automatically moves project
5. **Always Balanced**: Trial balance maintained automatically

---

**Status**: ✅ Ready for Testing  
**Expected Time**: 15-20 minutes  
**Prerequisites**: At least 1 completed project without invoice
