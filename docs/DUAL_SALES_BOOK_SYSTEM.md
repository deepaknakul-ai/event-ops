# 📊 Dual Sales Book System - Complete Guide

## 🎯 Overview

The accounting system now has **TWO separate Sales Books**:

1. **Invoiced Sales Book** - Tax invoices with invoice numbers (fully documented)
2. **Non-Invoiced Sales Book** - Completed projects pending invoice (revenue recognized but not yet invoiced)

---

## 🔄 How It Works

### **Revenue Recognition Flow**

```
PROJECT CREATED
    ↓
PROJECT STATUS = "Completed"
invoice_status = null OR "Not Invoiced"
    ↓
┌─────────────────────────────────────────────────┐
│ APPEARS IN: Non-Invoiced Sales Book             │
├─────────────────────────────────────────────────┤
│ Shows:                                          │
│  - Project Name (instead of invoice number)     │
│  - Client Name                                  │
│  - Taxable Amount                               │
│  - GST Amount                                   │
│  - Total Amount                                 │
│  - Status: "Pending Invoice"                    │
│                                                 │
│ Journal Entry:                                  │
│  Dr: Accounts Receivable: [Client]              │
│  Cr: Non-Invoiced Sales Revenue                 │
│  Cr: Output GST Payable                         │
└─────────────────────────────────────────────────┘
                    ↓
          Invoice is Raised
    (Tax Invoice created in system)
                    ↓
┌─────────────────────────────────────────────────┐
│ MOVES TO: Invoiced Sales Book                   │
├─────────────────────────────────────────────────┤
│ Shows:                                          │
│  - Invoice Number                               │
│  - Invoice Date                                 │
│  - Client Name                                  │
│  - Payment Mode (Cash/Credit)                   │
│  - Taxable Amount                               │
│  - GST Amount                                   │
│  - Total Amount                                 │
│                                                 │
│ Journal Entry:                                  │
│  Dr: Cash/Bank OR Accounts Receivable           │
│  Cr: Sales Revenue                              │
│  Cr: Output GST Payable                         │
│                                                 │
│ Previous Entry:                                 │
│  AUTOMATICALLY EXCLUDED from Non-Invoiced Book  │
│  (because project_id now has invoice)           │
└─────────────────────────────────────────────────┘
```

---

## 📋 Data Structure

### **Invoiced Sales Book Entry**
```javascript
{
  id: 'TAX_INV_001',
  date: '2024-01-15',
  fy: '2024-25',
  invoiceNo: 'SI-0001-2024-25',  // ← Has invoice number
  clientId: 'CLIENT_123',
  clientName: 'ABC Events Pvt Ltd',
  mode: 'Credit',  // Cash or Credit
  taxable: 84745.76,
  gst: 15254.24,
  total: 100000,
  remarks: 'Wedding event - Invoice raised'
}
```

### **Non-Invoiced Sales Book Entry**
```javascript
{
  id: 'PROJ_001',
  date: '2024-01-15',  // Project end date
  fy: '2024-25',
  projectName: 'Wedding Event - Taj Hotel',  // ← Project name instead
  clientId: 'CLIENT_123',
  clientName: 'ABC Events Pvt Ltd',
  mode: 'Credit',  // Always credit for non-invoiced
  taxable: 84745.76,
  gst: 15254.24,
  total: 100000,
  status: 'Non-Invoiced',
  remarks: 'Pending Invoice - Project: Wedding Event - Taj Hotel'
}
```

---

## 🎨 UI Components

### **Dashboard KPI Cards**

```
┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
│ Invoiced Sales   │ Non-Invoiced     │ Purchase Book    │ Journal Value    │
│ ₹5,00,000        │ ₹1,50,000        │ ₹3,00,000        │ ₹8,50,000        │
│ (Green)          │ (Teal)           │ (Amber)          │ (Indigo)         │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

### **Tab Navigation**

```
[Invoiced Sales] [Non-Invoiced Sales] [Purchase Book] [Journal] [Ledger] ...
```

### **Invoiced Sales Book Table**
```
┌──────────┬─────────────────┬──────────────┬──────┬──────────┬────────┬──────────┐
│ Date     │ Invoice No      │ Client       │ Mode │ Taxable  │ GST    │ Total    │
├──────────┼─────────────────┼──────────────┼──────┼──────────┼────────┼──────────┤
│ 01/15/24 │ SI-0001-2024-25 │ ABC Events   │ Cr   │ 84,745   │ 15,254 │ 1,00,000 │
│ 01/20/24 │ SI-0002-2024-25 │ XYZ Corp     │ Cash │ 42,372   │  7,627 │   50,000 │
└──────────┴─────────────────┴──────────────┴──────┴──────────┴────────┴──────────┘
```

### **Non-Invoiced Sales Book Table**
```
┌──────────┬─────────────────────────┬──────────────┬────────────────┬──────────┬────────┬──────────┐
│ Date     │ Project Name            │ Client       │ Status         │ Taxable  │ GST    │ Total    │
├──────────┼─────────────────────────┼──────────────┼────────────────┼──────────┼────────┼──────────┤
│ 01/18/24 │ Wedding Event - Taj     │ ABC Events   │ Pending Invoice│ 84,745   │ 15,254 │ 1,00,000 │
│ 01/22/24 │ Corporate Conf - Leela  │ XYZ Corp     │ Pending Invoice│ 42,372   │  7,627 │   50,000 │
└──────────┴─────────────────────────┴──────────────┴────────────────┴──────────┴────────┴──────────┘
```

**Visual Cue**: Non-invoiced rows have teal background highlight

---

## 💼 Accounting Treatment

### **Chart of Accounts**

| Code | Account Name | Type | Purpose |
|------|-------------|------|---------|
| 4000 | Sales Revenue | Income | Invoiced sales (with invoice number) |
| 4010 | Non-Invoiced Sales Revenue | Income | Completed projects pending invoice |

### **P&L Impact**

```
PROFIT & LOSS STATEMENT
────────────────────────────────────────
REVENUE
  Sales Revenue (Invoiced)          ₹5,00,000
  Non-Invoiced Sales Revenue        ₹1,50,000
────────────────────────────────────────
Total Revenue                       ₹6,50,000  ← TRUE REVENUE!

EXPENSES
  Cost of Goods Sold                ₹3,00,000
  Operating Expenses                ₹1,00,000
────────────────────────────────────────
Total Expenses                      ₹4,00,000

NET PROFIT                          ₹2,50,000
```

**Why This Matters**:
- Shows **actual revenue** (not just invoiced)
- Separates **invoiced vs pending invoice**
- Better **cash flow forecasting**
- Compliance with **accrual accounting**

---

## 🔍 Filtering Logic

### **Projects Appear in Non-Invoiced Sales Book When**:

```javascript
// Conditions (ALL must be true):
1. project.status === 'Completed' OR 'Closed'
2. project.invoice_status !== 'Invoiced'  // null, undefined, or "Not Invoiced"
3. No tax_invoice with project_id matching this project
4. project.end_date is in selected FY (or all FYs)
```

### **Projects Move to Invoiced Sales Book When**:

```javascript
// Any ONE of these happens:
1. Tax Invoice created with project_id = project.id
2. project.invoice_status changed to 'Invoiced'

// Result:
- Project automatically excluded from Non-Invoiced Book
- Tax Invoice appears in Invoiced Sales Book
```

---

## 🧪 Testing Scenarios

### **Scenario 1: Complete Project Without Invoice**

**Step 1: Mark Project as Completed**
```javascript
// Project: Wedding Event
{
  id: 'PROJ_001',
  project_name: 'Wedding Event - Taj Hotel',
  client_id: 'CLIENT_123',
  status: 'Completed',  // ← Changed to Completed
  end_date: '2024-01-15',
  items: [
    { item_name: 'Projector', qty: 2, total: 30000 }
  ]
}
```

**Step 2: Check Non-Invoiced Sales Book**
```
Accounting → Non-Invoiced Sales tab

Expected Result:
- Shows "Wedding Event - Taj Hotel"
- Taxable: ₹25,423.73
- GST: ₹4,576.27
- Total: ₹30,000
- Status: "Pending Invoice"
```

**Step 3: Verify Accounting Entries**
```
Ledger → "Non-Invoiced Sales Revenue"
Credit: ₹25,423.73

Ledger → "Accounts Receivable: ABC Events"
Debit: ₹30,000

Ledger → "Output GST Payable"
Credit: ₹4,576.27
```

---

### **Scenario 2: Raise Invoice for Completed Project**

**Step 1: Create Tax Invoice**
```javascript
// In Accounting module
{
  invoice_no: 'SI-0001-2024-25',
  invoice_date: '2024-01-20',
  project_id: 'PROJ_001',  // ← Links to project
  taxable_amount: 25423.73,
  gst_amount: 4576.27,
  grand_total: 30000
}
```

**Step 2: Check Non-Invoiced Sales Book**
```
Accounting → Non-Invoiced Sales tab

Expected Result:
- "Wedding Event - Taj Hotel" is GONE
- Total is now ₹0 (if it was the only project)
```

**Step 3: Check Invoiced Sales Book**
```
Accounting → Invoiced Sales tab

Expected Result:
- Shows invoice "SI-0001-2024-25"
- Client: ABC Events
- Total: ₹30,000
```

**Step 4: Verify Accounting Entries**
```
Ledger → "Sales Revenue" (NEW)
Credit: ₹25,423.73

Ledger → "Non-Invoiced Sales Revenue"
Credit: ₹0 (entry auto-excluded)

Trial Balance:
- Debits = Credits (still balanced)
```

---

## 📊 Reports Impact

### **1. Trial Balance**
```
TRIAL BALANCE (FY 2024-25)
──────────────────────────────────────────────
Account                          Debit    Credit
──────────────────────────────────────────────
Accounts Receivable: ABC Events  30,000        -
Sales Revenue                         -   25,424
Non-Invoiced Sales Revenue            -        0  ← Now zero!
Output GST Payable                    -    4,576
──────────────────────────────────────────────
TOTALS                          30,000   30,000  ✅ Balanced
```

### **2. Profit & Loss**
```
BEFORE INVOICE:
Revenue
  Non-Invoiced Sales Revenue    ₹25,424
Total Revenue                   ₹25,424

AFTER INVOICE:
Revenue
  Sales Revenue                 ₹25,424
  Non-Invoiced Sales Revenue          ₹0
Total Revenue                   ₹25,424  ← Same total!
```

**Key Point**: Total revenue **stays the same**, just moves between accounts.

---

## 🚨 Important Notes

### **1. GST Calculation**

Currently assumes **18% GST**. To make configurable:

```javascript
// In src/utils/accounting.js (line ~310)

// Current:
const taxable = round2(grandTotal / 1.18);

// Make Configurable:
const gstRate = project.gst_rate || 18;
const taxable = round2(grandTotal / (1 + (gstRate / 100)));
const gst = round2(grandTotal - taxable);
```

### **2. Completion Date**

Uses `project.end_date` or `project.completion_date`. Ensure projects have one of these fields.

### **3. Auto-Movement**

The movement from Non-Invoiced to Invoiced is **AUTOMATIC**:
- No manual journal entry needed
- No data migration required
- System handles it via filtering logic

### **4. No Double-Counting**

The system ensures:
```javascript
// If project has invoice → Excluded from non-invoiced
const invoicedProjectIds = new Set(
  taxInvoices.map(inv => inv.project_id).filter(Boolean)
);

nonInvoicedSalesBook = projects.filter(p => 
  !invoicedProjectIds.has(p.id)  // ← Prevents double-counting
);
```

---

## 🎯 Benefits

### **For Accountants**
✅ Clear separation of invoiced vs non-invoiced revenue  
✅ Automatic movement between books (zero manual work)  
✅ Accurate revenue recognition (accrual basis)  
✅ Easy tracking of pending invoices  

### **For Management**
✅ True revenue visibility (not just invoiced amounts)  
✅ Better cash flow forecasting  
✅ Know exactly what's pending invoice  
✅ Compliance with accounting standards  

### **For Auditors**
✅ Complete audit trail  
✅ Proper revenue recognition  
✅ Clear documentation  
✅ Trial balance always balanced  

---

## 📝 Migration Steps

### **For Existing Users**

**Step 1: Seed Chart of Accounts**
```
1. Go to Accounting module
2. Click "Chart of Accounts" tab
3. Click "Seed Default COA" button
4. Verify "Non-Invoiced Sales Revenue" (4010) is added
```

**Step 2: Verify Existing Data**
```
1. Check completed projects
2. Count how many don't have invoices
3. Go to Non-Invoiced Sales Book
4. Verify count matches
```

**Step 3: Test Invoice Creation**
```
1. Select a non-invoiced project
2. Create tax invoice for it
3. Check it appears in Invoiced Sales
4. Check it's removed from Non-Invoiced Sales
```

---

## 🐛 Troubleshooting

### **Issue: Project Not Showing in Non-Invoiced Sales**

**Check**:
```javascript
// 1. Project status
console.log(project.status);  // Should be "Completed" or "Closed"

// 2. Invoice status
console.log(project.invoice_status);  // Should be null or "Not Invoiced"

// 3. Has tax invoice?
const hasInvoice = taxInvoices.some(inv => inv.project_id === project.id);
console.log(hasInvoice);  // Should be false

// 4. In selected FY?
const projectFY = getFYFromDate(project.end_date);
console.log(projectFY, fyFilter);  // Should match or fyFilter = 'all'
```

### **Issue: Project Showing in BOTH Books**

**This should NEVER happen!** If it does:
```javascript
// Check for data corruption
const invoicedProjectIds = new Set(
  taxInvoices.map(inv => inv.project_id).filter(Boolean)
);

console.log('Invoiced Project IDs:', invoicedProjectIds);
console.log('Project ID:', project.id);
console.log('Is in set?', invoicedProjectIds.has(project.id));

// If true, but still showing in non-invoiced → BUG
// Refresh page and check again
```

---

## 📚 API Reference

### **Accounting Snapshot Object**

```javascript
const snapshot = buildAccountingSnapshot({
  clients,
  projects,  // ← Required for non-invoiced sales
  taxInvoices,
  purchaseInvoices,
  // ... other params
});

// Returns:
{
  salesBook: [
    {
      id, date, fy, invoiceNo, clientName, 
      taxable, gst, total, mode, remarks
    }
  ],
  nonInvoicedSalesBook: [
    {
      id, date, fy, projectName, clientName,
      taxable, gst, total, status, remarks
    }
  ],
  // ... other books
}
```

### **Helper Functions**

```javascript
// Check if project is invoiced
const isProjectInvoiced = (projectId, taxInvoices) => {
  return taxInvoices.some(inv => inv.project_id === projectId);
};

// Get non-invoiced revenue total
const getNonInvoicedTotal = (snapshot) => {
  return (snapshot.nonInvoicedSalesBook || [])
    .reduce((sum, row) => sum + row.total, 0);
};

// Get combined revenue
const getTotalRevenue = (snapshot) => {
  const invoiced = snapshot.salesBook.reduce((s, r) => s + r.total, 0);
  const nonInvoiced = (snapshot.nonInvoicedSalesBook || [])
    .reduce((s, r) => s + r.total, 0);
  return invoiced + nonInvoiced;
};
```

---

## 🎉 Summary

The **Dual Sales Book System** provides:

1. ✅ **Automatic Revenue Recognition** - Completed = Revenue (even without invoice)
2. ✅ **Clear Separation** - Invoiced vs Non-Invoiced
3. ✅ **Auto-Movement** - Invoice created → Moves to Invoiced Book
4. ✅ **Zero Manual Work** - System handles all journal entries
5. ✅ **Accurate P&L** - True revenue visibility
6. ✅ **Better Forecasting** - Know what's pending invoice
7. ✅ **Audit Compliance** - Proper accrual accounting

**Status**: ✅ **IMPLEMENTED & READY FOR TESTING**

---

**Document Version**: 1.0  
**Date**: 2024  
**Testing Required**: Yes (with real data)  
**Production Ready**: After testing
