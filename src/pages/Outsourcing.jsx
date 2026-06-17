import React, { useState, useEffect, useMemo } from 'react';
import { confirmDialog } from '../utils/dialog';
import {
  AlertCircle, Truck, FileText, Plus, Edit, Trash2,
  Printer, Download, Copy, Search, FileCheck, Paperclip, X, ReceiptText
} from 'lucide-react';
import { updateDoc, doc, arrayUnion, arrayRemove, runTransaction, getDoc, addDoc, collection } from 'firebase/firestore';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Modal } from '../components/Shared';
import { formatCurrency, formatCurrencyPDF, getDaysDifference, getEffectivePOCost } from '../utils/helpers';
import { generateBookInvoiceNumber } from '../utils/accounting';
import { assertFYNotLocked } from '../utils/fyLock';
import { can } from '../utils/permissions';

const Outsourcing = ({ projects, clients, inventory, role, db, appId, logAction, purchaseInvoices = [], lockedFYs = [], addToast }) => {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [activeTab, setActiveTab] = useState('allocations');

  // Allocation Wizard State
  const [isAllocWizardOpen, setIsAllocWizardOpen] = useState(false);
  const [vendorForm, setVendorForm] = useState({ vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18, description: '' });
  const [editingAlloc, setEditingAlloc] = useState(null);

  // PO States
  const [isPOModalOpen, setIsPOModalOpen] = useState(false);
  const [poVendorData, setPoVendorData] = useState(null);
  const [poForm, setPoForm] = useState({
    po_no: '',
    date: '',
    terms: '',
    subject: '',
    notes: '',
    equipment_cost: 0,
    labour_cost: 0,
    transport_cost: 0,
    fnb_cost: 0,
    travel_cost: 0,
    accommodation_cost: 0,
    misc_cost: 0,
    gst_rate: 18,
    is_package: false,
    package_cost: 0,
    package_cost_gst: 18,
    attachments: []
  });
  const [poSearch, setPoSearch] = useState('');
  const PO_STATUSES = ['Draft', 'Sent', 'Approved', 'Partial', 'Paid', 'Closed', 'Cancelled'];

  // Edit States
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingAllocation, setEditingAllocation] = useState(null);
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [showCancelledPOs, setShowCancelledPOs] = useState(false);
  const [poCurrentPage, setPoCurrentPage] = useState(1);
  const poItemsPerPage = 20;
  const [allocPage, setAllocPage] = useState(1);
  const allocItemsPerPage = 5;

  // Vendor Invoice States
  const [isInvoiceModalOpen, setIsInvoiceModalOpen] = useState(false);
  const [invoicingPO, setInvoicingPO] = useState(null);
  const [editingPIId, setEditingPIId] = useState(null); // id of the linked purchase_invoices doc when editing
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({
    invoice_no: '',
    invoice_date: new Date().toISOString().split('T')[0],
    base_amount: 0,
    gst_rate: 18,
    gst_amount: 0,
    total_amount: 0,
    notes: '',
  });

  // NEW STATES FOR EDITING PO
  const [editingPO, setEditingPO] = useState(null);
  const [poItems, setPoItems] = useState([]);

  const [allocWizardSelection, setAllocWizardSelection] = useState({}); // { itemId: { selected: true, qty, rate, days } }

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const vendors = clients.filter(c => c.type === 'Vendor' || c.type === 'Both'); // Ensure vendors are filtered correctly

  // ── PI linkage helpers ──────────────────────────────────────────────────────
  // FY string from an ISO date (Apr–Mar Indian financial year), e.g. "2026-27".
  const fyFromDate = (dateStr) => {
    const d = dateStr ? new Date(dateStr) : new Date();
    const y = d.getFullYear();
    return d.getMonth() < 3 ? `${y - 1}-${String(y).slice(-2)}` : `${y}-${String(y + 1).slice(-2)}`;
  };

  // Vendor company list (primary + branches) — mirrors PurchaseInvoices.getPartyCompanies.
  const getPartyCompanies = (party) => {
    if (!party) return [];
    const primary = { id: 'primary', name: party.name || 'Primary Company', gstin: party.gstin || '', address: party.address || '' };
    const extras = (party.companies || []).map(c => ({ id: c.id, name: c.name || 'Branch', gstin: c.gstin || '', address: c.address || '' }));
    return [primary, ...extras];
  };

  // Find the Service Purchase Invoice already linked to a PO (stable id or legacy composite key).
  const linkedPIForPO = (po, projectId) => {
    if (!po) return null;
    const composite = `${projectId || ''}::${po.po_no}`;
    return purchaseInvoices.find(pi =>
      pi.status !== 'Rejected' && (
        (po.id && pi.linked_po_id === po.id) || pi.linked_po_id === composite
      )
    ) || null;
  };

  const allProjectItems = useMemo(() => {
      if (!selectedProject?.items) return [];
      return selectedProject.items.filter(i => i.item_id);
  }, [selectedProject]);

  const externalItems = allProjectItems.filter(i => i.is_external);
  const internalItems = allProjectItems.filter(i => !i.is_external);

  const allocationsByVendor = useMemo(() => {
      if (!selectedProject?.vendor_allocations) return [];
      const groups = {};
      selectedProject.vendor_allocations.forEach(alloc => {
          if (!groups[alloc.vendor_id]) {
              groups[alloc.vendor_id] = {
                  id: alloc.vendor_id,
                  name: alloc.vendor_name,
                  items: [],
                  totalBase: 0,
                  totalGst: 0,
                  totalAmount: 0
              };
          }
          const base = parseFloat(alloc.amount || 0);
          const taxAmt = parseFloat(alloc.tax_amount || 0);
          groups[alloc.vendor_id].items.push(alloc);
          groups[alloc.vendor_id].totalBase += base;
          groups[alloc.vendor_id].totalGst += (taxAmt - base);
          groups[alloc.vendor_id].totalAmount += taxAmt;
      });
      return Object.values(groups);
  }, [selectedProject]);

  const paginatedAllocations = useMemo(() => {
    const start = (allocPage - 1) * allocItemsPerPage;
    return allocationsByVendor.slice(start, start + allocItemsPerPage);
  }, [allocationsByVendor, allocPage]);

  useEffect(() => {
    setAllocPage(1);
  }, [selectedProjectId]);

  // Helper: Remaining Qty
  const getRemainingQty = (itemId) => {
      if (!selectedProject) return 0;
      const totalRequired = (selectedProject.items || [])
          .filter(i => i.item_id === itemId)
          .reduce((sum, i) => sum + (parseInt(i.qty) || 0), 0);
      const allocated = (selectedProject.vendor_allocations || [])
          .filter(a => a.item_id === itemId)
          .reduce((sum, a) => sum + (parseInt(a.qty) || 0), 0);
      return Math.max(0, totalRequired - allocated);
  };

  const renderItemList = (items, title, colorClass) => (
    <div className="mb-4">
      <h4 className={`text-xs font-bold uppercase mb-2 ${colorClass}`}>{title}</h4>
      <div className="space-y-1">
        {items.map(item => {
           const remaining = getRemainingQty(item.item_id);
           if (remaining <= 0 && !showPendingOnly) return null;
           return (
             <div key={item.id} className="p-2 border rounded text-sm flex justify-between items-center bg-white">
                <div className="flex items-center gap-2">
                  <span className={remaining <= 0 ? 'text-slate-400 line-through' : 'text-slate-700'}>{item.item_name}</span>
                  {item.description && <span className="text-xs text-slate-500 italic">({item.description})</span>}
                </div>
                <div className="text-xs font-bold text-slate-500">Qty: {item.qty}</div>
             </div>
           );
        })}
        {items.length === 0 && <div className="text-xs text-slate-400 italic">No items.</div>}
      </div>
    </div>
  );

  // Handlers
  const handleSaveWizardAllocation = async () => {
      if (!can(role, 'outsourcing', 'create')) return addToast('Access denied: only Admin and Project Manager can create outsourcing allocations.', 'error');
      if (!vendorForm.vendor_id) return addToast("Select Vendor first", 'error');

      const selectedItemIds = Object.keys(allocWizardSelection).filter(id => allocWizardSelection[id]?.selected);
      if (selectedItemIds.length === 0) return addToast("Select at least one item to allocate", 'error');

      const vendor = clients.find(c => c.id === vendorForm.vendor_id);
      const newAllocations = [];

      selectedItemIds.forEach(itemId => {
          const item = allProjectItems.find(i => i.item_id === itemId);
          if (!item) return;

          const selection = allocWizardSelection[itemId];
          const qtyToAlloc = parseInt(selection.qty) || 0;

          if (qtyToAlloc <= 0) return;

          let rate = parseFloat(selection.rate) || 0;
          let days = parseInt(selection.days) || 1;
          let gst = 18; // Default GST

          // Try to find item gst from inventory if possible, else default
          const invItem = inventory.find(i => i.id === item.item_id);
          if (invItem) gst = invItem.gst_rate || 18;

          const amount = qtyToAlloc * rate * days;
          const tax = amount * (gst/100);

          newAllocations.push({
              id: Date.now().toString() + Math.random().toString().substr(2,5) + itemId,
              vendor_id: vendor.id,
              vendor_name: vendor.name,
              item_id: item.item_id, // This is the inventory ID
              item_name: item.item_name,
              qty: qtyToAlloc,
              rate: rate,
              days: days,
              gst: gst,
              amount: amount,
              tax_amount: amount + tax,
              description: item.description || '',
              allocated_at: new Date().toISOString()
          });
      });

      if (newAllocations.length === 0) return;

      try {
          const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId);
          await updateDoc(projectRef, { vendor_allocations: arrayUnion(...newAllocations) });
          logAction('projects', 'add_outsourcing', selectedProjectId, { count: newAllocations.length }, selectedProject.project_name);
          setIsAllocWizardOpen(false);
          setAllocWizardSelection({});
      } catch (e) {
          console.error(e);
          addToast("Failed to allocate", 'error');
      }
  };

  const handleUpdateAllocation = async (updatedAllocation) => {
    if (!can(role, 'outsourcing', 'edit')) return addToast('Access denied: insufficient permissions.', 'error');
    try {
      // Check if linked to PO
      if (updatedAllocation.po_id) {
          addToast("Notice: This item is linked to a PO. Please update the PO if necessary.", 'error');
      }

      // Recalculate totals
      const qty = parseInt(updatedAllocation.qty) || 0;
      const rate = parseFloat(updatedAllocation.rate) || 0;
      const days = parseInt(updatedAllocation.days) || 0;
      const gst = parseFloat(updatedAllocation.gst) || 0;
      const amount = qty * rate * days;
      const tax_amount = amount * (1 + gst/100);

      const finalAllocation = {
          ...updatedAllocation,
          qty, rate, days, gst, amount, tax_amount
      };

      const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId);
      await runTransaction(db, async (transaction) => {
        const pDoc = await transaction.get(projectRef);
        if (!pDoc.exists()) throw "Project not found";
        const pData = pDoc.data();
        const newAllocations = (pData.vendor_allocations || []).map(a => a.id === editingAllocation.id ? finalAllocation : a);
        transaction.update(projectRef, { vendor_allocations: newAllocations });
      });
      logAction('projects', 'update_outsourcing', selectedProjectId, { old: editingAllocation, new: finalAllocation }, selectedProject.project_name);
      setEditingAllocation(null);
      setIsEditModalOpen(false);
    } catch (err) {
      console.error(err);
      addToast("Failed to update allocation: " + err.message, 'error');
    }
  };

  const handleRemove = async (alloc) => {
    if (!can(role, 'outsourcing', 'delete')) return addToast('Access denied: only Admin can delete outsourcing allocations.', 'error');
    if(await confirmDialog("Remove this vendor allocation?")) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId), {
          vendor_allocations: arrayRemove(alloc)
        });
        logAction('projects', 'remove_outsourcing', selectedProjectId, alloc, selectedProject.project_name);
    }
  };

  // --- PO Logic ---
  const getOrgSettings = async () => {
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (docSnap.exists()) return docSnap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const pendingPOVendors = useMemo(() => {
      if (!selectedProject) return [];
      const groups = {};
      (selectedProject.vendor_allocations || []).forEach(alloc => {
          if (!alloc.po_id) {
              if (!groups[alloc.vendor_id]) {
                  groups[alloc.vendor_id] = {
                      vendor: clients.find(c => c.id === alloc.vendor_id) || { name: alloc.vendor_name, id: alloc.vendor_id },
                      items: [],
                      totalAmount: 0
                  };
              }
              groups[alloc.vendor_id].items.push(alloc);
              groups[alloc.vendor_id].totalAmount += (alloc.tax_amount || 0);
          }
      });
      return Object.values(groups);
  }, [selectedProject, clients]);

  const openPOModal = (vData, isEdit = false) => {
      if (isEdit) {
          setEditingPO(vData); // vData is the PO object here
          setPoVendorData({
              vendor: { name: vData.vendor_name, id: vData.vendor_id },
              items: vData.items,
              totalAmount: vData.amount,
              projectId: vData.projectId
          });
          setPoItems(vData.items.map(i => ({...i}))); // Deep copy for editing
          setPoForm({
              po_no: vData.po_no,
              date: vData.date.split('T')[0],
              terms: vData.terms || '',
              subject: vData.subject || '',
              notes: vData.notes || '',
              equipment_cost: vData.costs?.equipment || 0,
              labour_cost: vData.costs?.labour || 0,
              transport_cost: vData.costs?.transport || 0,
              fnb_cost: vData.costs?.fnb || 0,
              travel_cost: vData.costs?.travel || 0,
              accommodation_cost: vData.costs?.accommodation || 0,
              misc_cost: vData.costs?.misc || 0,
              gst_rate: vData.gst_rate || 18,
              is_package: vData.is_package || false,
              attachments: vData.attachments || []
          });
      } else {
          setEditingPO(null);
          const equipmentBase = vData.items.reduce((sum, item) => sum + (item.amount || 0), 0);
          setPoVendorData(vData);
          setPoItems(vData.items.map(i => ({...i})));
          setPoForm({
              po_no: `PO/${new Date().getFullYear()}/${Date.now().toString().substr(-5)}`,
              date: new Date().toISOString().split('T')[0],
              terms: vData.vendor.billing_terms || '',
              subject: `Purchase Order for ${selectedProject.project_name}`,
              notes: '',
              equipment_cost: equipmentBase,
              labour_cost: 0,
              transport_cost: 0,
              fnb_cost: 0,
              travel_cost: 0,
              accommodation_cost: 0,
              misc_cost: 0,
              gst_rate: 18,
              is_package: false,
              attachments: []
          });
      }
      setIsPOModalOpen(true);
  };

  const handleDuplicatePO = (po) => {
      // Use the edit logic but clear the editingPO ID to treat as new
      openPOModal(po, true);
      setEditingPO(null);
      setPoForm(prev => ({
          ...prev,
          po_no: `PO/${new Date().getFullYear()}/${Date.now().toString().substr(-5)}`,
          attachments: []
      }));
  };

  const openInvoiceModal = (po) => {
    const pId = selectedProjectId || po.projectId;
    const existingPI = linkedPIForPO(po, pId);
    setInvoicingPO(po);

    if (existingPI) {
      // Edit the already-linked Service Purchase Invoice.
      setEditingPIId(existingPI.id);
      const base = parseFloat(existingPI.amount) || 0;
      const gst = parseFloat(existingPI.gst_amount) || 0;
      setInvoiceForm({
        invoice_no: existingPI.invoice_ref || '',
        invoice_date: existingPI.invoice_date || new Date().toISOString().split('T')[0],
        base_amount: base,
        gst_rate: base > 0 ? Math.round((gst / base) * 100) : 18,
        gst_amount: gst,
        total_amount: base + gst,
        notes: existingPI.remarks || '',
      });
    } else {
      // New PI — prefill from the PO's effective cost (or legacy embedded vendor_invoice).
      setEditingPIId(null);
      const eff = getEffectivePOCost(po);
      const legacy = po.vendor_invoice || {};
      const base = parseFloat(legacy.base_amount) || eff.base || 0;
      const gst = parseFloat(legacy.gst_amount) || eff.gst || 0;
      setInvoiceForm({
        invoice_no: legacy.invoice_no || '',
        invoice_date: legacy.invoice_date || new Date().toISOString().split('T')[0],
        base_amount: base,
        gst_rate: base > 0 ? Math.round((gst / base) * 100) : 18,
        gst_amount: gst,
        total_amount: base + gst,
        notes: legacy.notes || '',
      });
    }
    setIsInvoiceModalOpen(true);
  };

  // Creates (or updates) a real Service Purchase Invoice in the purchase_invoices collection,
  // linked to the PO. Replaces the old embedded po.vendor_invoice flow so a single authoritative
  // document feeds the PI register, vendor ledger, ITC and P&L.
  const handleSaveVendorInvoice = async () => {
    const editing = !!editingPIId;
    if (!can(role, 'outsourcing', 'edit') || !can(role, 'purchase_invoices', editing ? 'edit' : 'create')) {
      return addToast('Access denied: insufficient permissions.', 'error');
    }
    if (!invoiceForm.invoice_no || !invoiceForm.invoice_date) return addToast('Vendor invoice number and date are required', 'error');
    const pId = selectedProjectId || invoicingPO?.projectId;
    if (!pId) return addToast('Project context missing', 'error');
    if (!assertFYNotLocked(invoiceForm.invoice_date, lockedFYs)) return;

    const base = parseFloat(invoiceForm.base_amount) || 0;
    const gstRate = parseFloat(invoiceForm.gst_rate) || 0;
    const gst = base * (gstRate / 100);
    const total = base + gst;

    const project = projects.find(p => p.id === pId);
    const vendor = clients.find(c => c.id === invoicingPO.vendor_id);
    const companies = getPartyCompanies(vendor);
    const companyId = invoicingPO.party_company_id || project?.party_company_id || 'primary';
    const company = companies.find(c => c.id === companyId) || companies[0] || null;

    setSavingInvoice(true);
    try {
      const piCol = collection(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices');
      const now = new Date().toISOString();
      let piNo;
      let piId = editingPIId;

      if (editing) {
        piNo = purchaseInvoices.find(p => p.id === editingPIId)?.pi_no;
      } else {
        const orgSettings = (await getOrgSettings()) || {};
        piNo = await generateBookInvoiceNumber({ db, appId, dateStr: invoiceForm.invoice_date, bookType: 'purchase', orgSettings });
      }

      const piData = {
        type: 'Service',
        invoice_date: invoiceForm.invoice_date,
        invoice_ref: invoiceForm.invoice_no,
        vendor_name: vendor?.name || invoicingPO.vendor_name || '',
        vendor_id: invoicingPO.vendor_id || '',
        vendor_company_id: company?.id || 'primary',
        vendor_company_name: company?.name || (vendor?.name || ''),
        vendor_company_gstin: company?.gstin || (vendor?.gstin || ''),
        vendor_company_address: company?.address || (vendor?.address || ''),
        description: invoicingPO.subject || `PO ${invoicingPO.po_no} — ${project?.project_name || ''}`,
        amount: base,
        gst_amount: gst,
        linked_inventory_id: '',
        linked_po_id: invoicingPO.id || `${pId}::${invoicingPO.po_no}`,
        linked_po_no: invoicingPO.po_no || '',
        include_in_ledger: true,
        purchase_mode: 'Credit',
        status: editing ? (purchaseInvoices.find(p => p.id === editingPIId)?.status || 'Pending') : 'Pending',
        images: editing ? (purchaseInvoices.find(p => p.id === editingPIId)?.images || []) : [],
        remarks: invoiceForm.notes || '',
        pi_no: piNo,
        fy: fyFromDate(invoiceForm.invoice_date),
        updated_at: now,
      };

      if (editing) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'purchase_invoices', editingPIId), piData);
      } else {
        piData.created_at = now;
        const ref = await addDoc(piCol, piData);
        piId = ref.id;
      }

      // Stamp the PO with a pointer + slim summary for quick table display; drop the legacy
      // embedded vendor_invoice so there is no divergent second copy going forward.
      const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
      await runTransaction(db, async (transaction) => {
        const pDoc = await transaction.get(projectRef);
        if (!pDoc.exists()) throw new Error('Project not found');
        const pData = pDoc.data();
        const updatedPOs = (pData.purchase_orders || []).map(p => {
          if (p.id !== invoicingPO.id) return p;
          const { vendor_invoice, ...rest } = p;
          return {
            ...rest,
            purchase_invoice_id: piId,
            purchase_invoice_no: piNo,
            purchase_invoice_summary: { invoice_ref: piData.invoice_ref, total, status: piData.status },
          };
        });
        transaction.update(projectRef, { purchase_orders: updatedPOs });
      });

      logAction('purchase_invoices', editing ? 'update' : 'create', piId, { pi_no: piNo, po_no: invoicingPO.po_no, total }, piNo);
      addToast?.(editing ? `Purchase Invoice ${piNo} updated` : `Purchase Invoice ${piNo} created from ${invoicingPO.po_no}`, 'success');
      setIsInvoiceModalOpen(false);
      setInvoicingPO(null);
      setEditingPIId(null);
    } catch (e) {
      console.error(e);
      addToast('Error saving purchase invoice: ' + e.message, 'error');
    }
    setSavingInvoice(false);
  };

  const PI_STATUS_COLORS = {
    Pending:  'bg-amber-100 text-amber-800 border-amber-200',
    Verified: 'bg-green-100 text-green-800 border-green-200',
    Rejected: 'bg-red-100 text-red-800 border-red-200',
  };

  // Renders the "Purchase Invoice" cell for a PO row: a linked Service PI (preferred),
  // a legacy embedded vendor_invoice (with a Convert-to-PI action), or a Create button.
  const renderInvoiceCell = (po, projectId) => {
    const pi = linkedPIForPO(po, projectId);
    if (pi) {
      const total = (parseFloat(pi.amount) || 0) + (parseFloat(pi.gst_amount) || 0);
      return (
        <div className="flex flex-col items-center gap-1">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${PI_STATUS_COLORS[pi.status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{pi.status || 'Pending'}</span>
          <span className="text-xs font-mono text-indigo-700 truncate max-w-[110px]" title={pi.pi_no}>{pi.pi_no}</span>
          <span className="text-xs text-slate-500">{formatCurrency(total)}</span>
          <button onClick={() => openInvoiceModal(po)} className="text-xs text-purple-600 hover:underline flex items-center gap-1 mt-0.5"><Edit size={12}/> Edit PI</button>
        </div>
      );
    }
    const legacy = po.vendor_invoice;
    if (legacy && legacy.invoice_no) {
      return (
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-slate-100 text-slate-600 border-slate-200">Legacy</span>
          <span className="text-xs text-slate-500 truncate max-w-[110px]" title={legacy.invoice_no}>{legacy.invoice_no}</span>
          <span className="text-xs text-slate-500">{formatCurrency(legacy.total_amount || 0)}</span>
          <button onClick={() => openInvoiceModal(po)} className="text-xs text-purple-600 hover:underline flex items-center gap-1 mt-0.5"><ReceiptText size={12}/> Convert to PI</button>
        </div>
      );
    }
    return (
      <button onClick={() => openInvoiceModal(po)} className="text-xs text-purple-600 hover:underline flex items-center gap-1 justify-center"><ReceiptText size={12}/> Create Invoice (PI)</button>
    );
  };

  const handleCreatePO = async () => {
      if (!can(role, 'outsourcing', 'create')) return addToast('Access denied: only Admin and Project Manager can create Purchase Orders.', 'error');
      if (!poForm.po_no || !poForm.date) return addToast("PO Number and Date required", 'error');
      const pId = selectedProjectId || poVendorData?.projectId;
      if (!pId) return addToast("Project context missing", 'error');

      // Use package cost if specified, otherwise sum all costs
      let subtotal = 0;
      let finalGstRate = poForm.gst_rate || 0;
      if (poForm.package_cost && poForm.package_cost > 0) {
        subtotal = poForm.package_cost;
        finalGstRate = poForm.package_cost_gst || 18;
      } else {
        subtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
      }
      const gstAmount = subtotal * (finalGstRate / 100);
      const grandTotal = subtotal + gstAmount;

      const poId = Date.now().toString();
      const newPO = {
          id: poId,
          po_no: poForm.po_no,
          date: poForm.date,
          vendor_id: poVendorData.vendor.id,
          vendor_name: poVendorData.vendor.name,
          subject: poForm.subject,
          terms: poForm.terms,
          notes: poForm.notes,
          status: 'Draft',
          amount: grandTotal,
          costs: {
            equipment: poForm.equipment_cost || 0,
            labour: poForm.labour_cost || 0,
            transport: poForm.transport_cost || 0,
            fnb: poForm.fnb_cost || 0,
            travel: poForm.travel_cost || 0,
            accommodation: poForm.accommodation_cost || 0,
            misc: poForm.misc_cost || 0,
          },
          subtotal: subtotal,
          gst_rate: poForm.gst_rate,
          gst_rate_applied: finalGstRate,
          is_package: poForm.is_package,
          package_cost: poForm.package_cost || 0,
          package_cost_gst: poForm.package_cost_gst || 18,
          gst_amount: gstAmount,
          created_at: new Date().toISOString(),
          items: poItems, // Use edited items
          attachments: poForm.attachments
      };

      try {
          await runTransaction(db, async (transaction) => {
              const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";

              const pData = pDoc.data();
              const updatedAllocations = (pData.vendor_allocations || []).map(alloc => {
                  if (poVendorData.items.find(i => i.id === alloc.id)) {
                      // Update allocation with PO details including package cost if specified
                      const updatedAlloc = { ...alloc, po_id: poId, po_no: newPO.po_no };
                      if (newPO.package_cost && newPO.package_cost > 0) {
                          // If PO has package cost, sync it to allocation
                          updatedAlloc.package_cost = newPO.package_cost;
                          updatedAlloc.package_cost_gst = newPO.package_cost_gst || 18;
                          updatedAlloc.gst_rate_applied = newPO.gst_rate_applied;
                          updatedAlloc.amount = newPO.amount; // Store the calculated total
                      }
                      return updatedAlloc;
                  }
                  return alloc;
              });

              const updatedPOs = [...(pData.purchase_orders || []), newPO];

              transaction.update(projectRef, {
                  vendor_allocations: updatedAllocations,
                  purchase_orders: updatedPOs
              });
          });

          logAction('projects', 'create_po', pId, { po_no: newPO.po_no }, selectedProject?.project_name || 'Unknown Project');
          setIsPOModalOpen(false);
          if(await confirmDialog("PO Created. Print now?")) generatePOPDF(newPO, 'print');
      } catch (e) {
          console.error(e);
          addToast("Error creating PO: " + e.message, 'error');
      }
  };

  const handleUpdatePO = async () => {
      if (!can(role, 'outsourcing', 'edit')) return addToast('Access denied: only Admin and Project Manager can update Purchase Orders.', 'error');
      if (!poForm.po_no || !poForm.date) return addToast("PO Number and Date required", 'error');
      const pId = selectedProjectId || editingPO?.projectId;
      if (!pId) return addToast("Project context missing", 'error');

      // Use package cost if specified, otherwise sum all costs
      let subtotal = 0;
      let finalGstRate = poForm.gst_rate || 0;
      if (poForm.package_cost && poForm.package_cost > 0) {
        subtotal = poForm.package_cost;
        finalGstRate = poForm.package_cost_gst || 18;
      } else {
        subtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
      }
      const gstAmount = subtotal * (finalGstRate / 100);
      const grandTotal = subtotal + gstAmount;

      const updatedPO = {
          ...editingPO,
          po_no: poForm.po_no,
          date: poForm.date,
          subject: poForm.subject,
          terms: poForm.terms,
          notes: poForm.notes,
          amount: grandTotal,
          costs: {
            equipment: poForm.equipment_cost || 0,
            labour: poForm.labour_cost || 0,
            transport: poForm.transport_cost || 0,
            fnb: poForm.fnb_cost || 0,
            travel: poForm.travel_cost || 0,
            accommodation: poForm.accommodation_cost || 0,
            misc: poForm.misc_cost || 0,
          },
          subtotal: subtotal,
          gst_rate: poForm.gst_rate,
          gst_rate_applied: finalGstRate,
          is_package: poForm.is_package,
          package_cost: poForm.package_cost || 0,
          package_cost_gst: poForm.package_cost_gst || 18,
          gst_amount: gstAmount,
          items: poItems, // Updated items
          attachments: poForm.attachments
      };

      try {
          await runTransaction(db, async (transaction) => {
              const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";

              const pData = pDoc.data();

              // Update PO in purchase_orders
              const updatedPOs = (pData.purchase_orders || []).map(p => p.id === editingPO.id ? updatedPO : p);

              // Update linked allocations with PO cost information
              const updatedAllocations = (pData.vendor_allocations || []).map(alloc => {
                  if (alloc.po_id === editingPO.id) {
                      // Update allocation with PO details including package cost if specified
                      const updatedAlloc = { ...alloc, description: poItems.find(i => i.id === alloc.id)?.description || alloc.description };
                      if (updatedPO.package_cost && updatedPO.package_cost > 0) {
                          // If PO has package cost, sync it to allocation
                          updatedAlloc.package_cost = updatedPO.package_cost;
                          updatedAlloc.package_cost_gst = updatedPO.package_cost_gst || 18;
                          updatedAlloc.gst_rate_applied = updatedPO.gst_rate_applied;
                          updatedAlloc.amount = updatedPO.amount; // Store the calculated total
                      } else {
                          // Remove package cost fields if switching back to itemized
                          delete updatedAlloc.package_cost;
                          delete updatedAlloc.package_cost_gst;
                          delete updatedAlloc.gst_rate_applied;
                      }
                      return updatedAlloc;
                  }
                  return alloc;
              });

              transaction.update(projectRef, {
                  purchase_orders: updatedPOs,
                  vendor_allocations: updatedAllocations
              });
          });

          logAction('projects', 'update_po', pId, { po_no: updatedPO.po_no }, selectedProject?.project_name || 'Unknown Project');
          setIsPOModalOpen(false);
          if(await confirmDialog("PO Updated. Print now?")) generatePOPDF(updatedPO, 'print');
      } catch (e) {
          console.error(e);
          addToast("Error updating PO: " + e.message, 'error');
      }
  };

  const handleFileUpload = (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => {
          if (file.size > 1024 * 1024) { // 1MB limit per file
              addToast(`File ${file.name} is too large (max 1MB)`, 'info');
              return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
              setPoForm(prev => ({
                  ...prev,
                  attachments: [...prev.attachments, { name: file.name, type: file.type, data: reader.result }]
              }));
          };
          reader.readAsDataURL(file);
      });
  };

  const removeAttachment = (index) => {
      setPoForm(prev => ({
          ...prev,
          attachments: prev.attachments.filter((_, i) => i !== index)
      }));
  };

  const updatePOStatus = async (po, newStatus) => {
      if (!can(role, 'outsourcing', 'edit')) return addToast('Access denied: insufficient permissions.', 'error');
      const pId = selectedProjectId || po.projectId;
      if (!pId) return;

      if (newStatus === 'Cancelled') {
          if (!await confirmDialog("Are you sure you want to cancel this PO? This will release the allocated inventory for re-allocation.")) return;
      }

      try {
          const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
          await runTransaction(db, async (transaction) => {
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";

              const pData = pDoc.data();
              const updatedPOs = (pData.purchase_orders || []).map(p => {
                  if (p.id === po.id) {
                      return { ...p, status: newStatus };
                  }
                  return p;
              });

              let updatedAllocations = pData.vendor_allocations || [];
              if (newStatus === 'Cancelled') {
                  updatedAllocations = updatedAllocations.filter(alloc => alloc.po_id !== po.id);
              }

              transaction.update(projectRef, { purchase_orders: updatedPOs, vendor_allocations: updatedAllocations });
          });
          logAction('projects', 'update_po_status', pId, { po_no: po.po_no, status: newStatus }, "PO Status Update");
      } catch (e) {
          console.error(e);
          addToast("Error updating status: " + e.message, 'error');
      }
  };

  const generatePOPDF = async (po, mode = 'print') => {
      try {
      const doc = new jsPDF();
      const org = await getOrgSettings();
      const vendor = clients.find(c => c.id === po.vendor_id) || { name: po.vendor_name || 'Vendor', address: '' };
      const vendorHasGST = !!(vendor.gstin && vendor.gstin.trim());
      const pageWidth = doc.internal.pageSize.width;
      const pageHeight = doc.internal.pageSize.height;
      const margin = 10;

      // Find project details if not selected
      let projectDetails = selectedProject;
      if (!projectDetails) {
          projectDetails = projects.find(p => (p.purchase_orders || []).some(order => order.id === po.id));
      }

      if (org?.logo) {
          try {
              doc.addImage(org.logo, 'JPEG', margin, 10, 25, 25);
          } catch (e) { console.warn("Logo add failed", e); }
      }

      doc.setFontSize(14); doc.text("PURCHASE ORDER", pageWidth - margin, 20, { align: 'right' });
      doc.setFontSize(8); doc.text(`PO No: ${po.po_no}`, pageWidth - margin, 30, { align: 'right' });
      doc.text(`Date: ${new Date(po.date).toLocaleDateString()}`, pageWidth - margin, 35, { align: 'right' });

      doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.text("Buyer:", margin, 50);
      doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.text(org?.name || "Company Name", margin, 55);
      const orgAddr = doc.splitTextToSize(org?.address || "", 80); doc.text(orgAddr, margin, 60);
      if(org?.gstin) doc.text(`GSTIN: ${org.gstin}`, margin, 60 + (orgAddr.length * 5));

      doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.text("Vendor:", 110, 50);
      doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.text(vendor.name, 110, 55);
      const vendAddr = doc.splitTextToSize(vendor.address || "", 80); doc.text(vendAddr, 110, 60);
      if(vendor.gstin) doc.text(`GSTIN: ${vendor.gstin}`, 110, 60 + (vendAddr.length * 5));
      if(!vendorHasGST) { doc.setTextColor(180,80,0); doc.text("(No GST / Unregistered Vendor)", 110, 60 + (vendAddr.length * 5)); doc.setTextColor(0,0,0); }

      let y = Math.max(60 + (orgAddr.length * 5), 60 + (vendAddr.length * 5)) + 10;

      // --- Added Project Details ---
      if (projectDetails) {
          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text("Project Details:", margin, y);
          y += 5;
          doc.setFont("helvetica", "normal");
          doc.text(`Project: ${projectDetails.project_name}`, margin, y);

          const venueText = `Venue: ${projectDetails.venue || '-'}`;
          const venueLines = doc.splitTextToSize(venueText, pageWidth - 120);
          doc.text(venueLines, 110, y);

          y += Math.max(5, venueLines.length * 5);

          let dateStr = `Dates: ${projectDetails.start_date} to ${projectDetails.end_date}`;
          if (projectDetails.setup_date) dateStr += ` | Setup: ${projectDetails.setup_date}`;
          doc.text(dateStr, margin, y);
          y += 10;
      }
      // -----------------------------

      doc.text(`Subject: ${po.subject || '-'}`, margin, y); y += 10;

      const rows = vendorHasGST
        ? (po.items || []).map((item) => [
            item.item_name + (item.description ? `\n(${item.description})` : ''),
            item.qty,
            item.days,
            formatCurrencyPDF(item.rate),
            formatCurrencyPDF(item.amount),
            `${item.gst}%`,
            formatCurrencyPDF(item.tax_amount)
          ])
        : (po.items || []).map((item) => [
            item.item_name + (item.description ? `\n(${item.description})` : ''),
            item.qty,
            item.days,
            formatCurrencyPDF(item.rate),
            formatCurrencyPDF(item.amount)
          ]);

      autoTable(doc, {
          startY: y,
          head: [vendorHasGST
            ? ['Item', 'Qty', 'Days', 'Rate', 'Base Amt', 'GST %', 'Total Amt']
            : ['Item', 'Qty', 'Days', 'Rate', 'Amount']
          ],
          body: rows,
          theme: 'grid',
          headStyles: { fillColor: [50, 50, 50] },
          styles: { cellPadding: 2, fontSize: 7, valign: 'middle' },
          columnStyles: vendorHasGST ? {
              0: { cellWidth: 'auto' },
              1: { cellWidth: 12, halign: 'center' },
              2: { cellWidth: 12, halign: 'center' },
              3: { cellWidth: 25, halign: 'right' },
              4: { cellWidth: 28, halign: 'right' },
              5: { cellWidth: 12, halign: 'center' },
              6: { cellWidth: 32, halign: 'right' }
          } : {
              0: { cellWidth: 'auto' },
              1: { cellWidth: 14, halign: 'center' },
              2: { cellWidth: 14, halign: 'center' },
              3: { cellWidth: 30, halign: 'right' },
              4: { cellWidth: 35, halign: 'right' }
          },
          margin: { top: 20, bottom: 20, left: margin, right: margin }
      });

      let finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + 10;

      // Pagination Helper
      const checkAddPage = (heightNeeded) => {
          if (finalY + heightNeeded > pageHeight - 20) {
              doc.addPage();
              finalY = 20;
              return true;
          }
          return false;
      };

      // Cost Breakdown for POs with costs object
      if (po.costs) {
        checkAddPage(40);
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.text("Cost Breakdown:", margin, finalY);
        finalY += 5;
        doc.setFont("helvetica", "normal");

        const costItems = [
            { label: po.is_package ? "Package Cost" : "Equipment Cost", value: po.costs.equipment },
            { label: "Labour Cost", value: po.costs.labour },
            { label: "Transport Cost", value: po.costs.transport },
            { label: "Travel Cost", value: po.costs.travel },
            { label: "F&B Cost", value: po.costs.fnb },
            { label: "Accommodation Cost", value: po.costs.accommodation },
            { label: "Misc Cost", value: po.costs.misc },
        ].filter(c => c.value > 0);

        costItems.forEach(c => {
            doc.text(c.label, margin, finalY);
            doc.text(formatCurrencyPDF(c.value), margin + 50, finalY, { align: 'right' });
            finalY += 4;
        });
        finalY += 5;
      }

      // Calculate Totals
      const totalBase = po.subtotal !== undefined ? po.subtotal : (po.items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      const totalGST = po.gst_amount !== undefined ? po.gst_amount : (po.items || []).reduce((sum, item) => sum + ((parseFloat(item.tax_amount) || 0) - (parseFloat(item.amount) || 0)), 0);
      const grandTotal = vendorHasGST
        ? (po.amount !== undefined ? po.amount : (po.items || []).reduce((sum, item) => sum + (parseFloat(item.tax_amount) || 0), 0))
        : totalBase;

      checkAddPage(vendorHasGST ? 35 : 25);

      const boxX = pageWidth - margin - 60;

      doc.setDrawColor(200);

      if (vendorHasGST) {
        // Base Amount
        doc.setFillColor(250, 250, 250);
        doc.rect(boxX, finalY, 60, 8, 'FD');
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.text("Total Base Amount:", boxX + 2, finalY + 5.5);
        doc.setFont("helvetica", "bold");
        doc.text(formatCurrencyPDF(totalBase), boxX + 58, finalY + 5.5, { align: 'right' });

        // GST
        doc.setFillColor(240, 240, 240);
        doc.rect(boxX, finalY + 8, 60, 8, 'FD');
        doc.setFont("helvetica", "normal");
        doc.text("Total GST:", boxX + 2, finalY + 13.5);
        doc.setFont("helvetica", "bold");
        doc.text(formatCurrencyPDF(totalGST), boxX + 58, finalY + 13.5, { align: 'right' });

        // Grand Total
        doc.setFillColor(230, 230, 230);
        doc.rect(boxX, finalY + 16, 60, 10, 'FD');
        doc.setFontSize(9);
        doc.setTextColor(0, 0, 0);
        doc.text("Grand Total:", boxX + 2, finalY + 22.5);
        doc.text(formatCurrencyPDF(grandTotal), boxX + 58, finalY + 22.5, { align: 'right' });

        finalY += 35;
      } else {
        // No GST — show only Grand Total
        doc.setFillColor(230, 230, 230);
        doc.rect(boxX, finalY, 60, 10, 'FD');
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(0, 0, 0);
        doc.text("Total Amount:", boxX + 2, finalY + 6.5);
        doc.text(formatCurrencyPDF(grandTotal), boxX + 58, finalY + 6.5, { align: 'right' });

        finalY += 18;
      }

      checkAddPage(10);
      doc.setFontSize(8);
      doc.text("Terms & Conditions:", margin, finalY);
      finalY += 5;
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");

      const terms = doc.splitTextToSize(po.terms || '-', pageWidth - (margin * 2));
      if (checkAddPage(terms.length * 5)) {
          doc.text("Terms & Conditions (Cont.):", margin, finalY - 5);
      }
      doc.text(terms, margin, finalY);
      finalY += (terms.length * 5) + 5;

      if (po.notes) {
          checkAddPage(15);
          doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.text("Notes:", margin, finalY);
          finalY += 5;
          doc.setFontSize(9); doc.setFont("helvetica", "normal");
          const notes = doc.splitTextToSize(po.notes, pageWidth - (margin * 2));
          checkAddPage(notes.length * 5);
          doc.text(notes, margin, finalY);
          finalY += (notes.length * 5) + 5;
      }

      if (org?.po_terms) {
          checkAddPage(15);
          doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.text("Standard Terms:", margin, finalY);
          doc.setFontSize(9);
          doc.setFont("helvetica", "normal");
          const stdTerms = doc.splitTextToSize(org.po_terms, pageWidth - (margin * 2));

          if (finalY + (stdTerms.length * 5) > pageHeight - 20) {
              doc.addPage();
              finalY = 20;
          }
          doc.text(stdTerms, margin, finalY);
          finalY += (stdTerms.length * 5) + 10;
      }

      // Signatures
      if (finalY + 40 > pageHeight - 20) {
          doc.addPage();
          finalY = 20;
      }

      doc.setLineWidth(0.5);
      doc.line(margin, finalY + 25, 80, finalY + 25);
      doc.setFontSize(7); doc.setFont("helvetica", "bold");
      doc.text("Authorized Signatory", margin, finalY + 30);
      doc.setFont("helvetica", "normal");
      doc.text(org?.name || "Company", margin, finalY + 35);

      doc.line(pageWidth - 90, finalY + 25, pageWidth - margin, finalY + 25);
      doc.setFont("helvetica", "bold");
      doc.text("Vendor Acceptance", pageWidth - 90, finalY + 30);
      doc.setFont("helvetica", "normal");
      doc.text("Signature & Stamp", pageWidth - 90, finalY + 35);

      if (mode === 'print') {
          doc.autoPrint();
          window.open(doc.output('bloburl'), '_blank');
      } else {
          doc.save(`PO_${po.po_no.replace(/\//g, '-')}.pdf`);
      }
      } catch (e) {
          console.error("PDF Generation Error", e);
          addToast("Failed to generate PDF. Check console for details.", 'error');
      }
  };

  const allPOs = useMemo(() => {
      if (selectedProjectId) return [];
      const list = [];
      projects.forEach(p => {
          if (p.purchase_orders) {
              p.purchase_orders.forEach(po => list.push({ ...po, projectName: p.project_name, projectId: p.id }));
          }
      });
      return list.sort((a, b) => {
          const dateDiff = new Date(b.date) - new Date(a.date);
          if (dateDiff !== 0) return dateDiff;
          return (b.po_no || '').localeCompare(a.po_no || '');
      });
  }, [projects, selectedProjectId]);

  const exportAllocationSummary = async () => {
      try {
        const doc = new jsPDF();
        const org = await getOrgSettings();
        const pageWidth = doc.internal.pageSize.width;
        const pageHeight = doc.internal.pageSize.height;

        let isFirst = true;

        for (const group of allocationsByVendor) {
            if (!isFirst) doc.addPage();
            isFirst = false;

            // Header (Org)
            let y = 15;
            if (org?.logo) {
                try { doc.addImage(org.logo, 'JPEG', 14, 10, 25, 25); } catch (e) { console.warn('Logo error', e); }
            }
            doc.setFontSize(16); doc.setFont("helvetica", "bold"); doc.text(org?.name || "RENTAL OPS", 45, 18);
            doc.setFontSize(9); doc.setFont("helvetica", "normal");
            const addrLines = doc.splitTextToSize(org?.address || "", 100); doc.text(addrLines, 45, 24);

            let headerY = 24 + (addrLines.length * 4);
            if (org?.gstin) doc.text(`GSTIN: ${org.gstin}`, 45, headerY);

            // Title
            doc.setFontSize(14); doc.setFont("helvetica", "bold");
            doc.text("VENDOR ALLOCATION SUMMARY", pageWidth - 14, 20, { align: 'right' });
            doc.setFontSize(10); doc.setFont("helvetica", "normal");
            doc.text(`Date: ${new Date().toLocaleDateString()}`, pageWidth - 14, 26, { align: 'right' });

            y = Math.max(y + 25, headerY + 10);
            doc.setLineWidth(0.5); doc.line(14, y, pageWidth - 14, y); y += 10;

            // Project & Vendor Info
            doc.setFontSize(11); doc.setFont("helvetica", "bold");
            doc.text("Project Details:", 14, y);
            doc.text("Vendor Details:", 110, y);
            y += 6;

            doc.setFontSize(10); doc.setFont("helvetica", "normal");
            doc.text(`Project: ${selectedProject.project_name}`, 14, y);
            doc.text(`Vendor: ${group.name}`, 110, y);
            y += 5;
            doc.text(`Venue: ${selectedProject.venue}`, 14, y);

            const vendorDetails = clients.find(c => c.id === group.id);
            if (vendorDetails?.address) {
                const vAddr = doc.splitTextToSize(vendorDetails.address, 80);
                doc.text(vAddr, 110, y);
            }
            y += 5;
            doc.text(`Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, 14, y);
            y += 10;

            // Table
            const rows = group.items.map((item, i) => [
                i + 1,
                item.item_name + (item.description ? `\n(${item.description})` : ''),
                item.qty,
                item.days,
                role !== 'tech' ? formatCurrencyPDF(item.rate) : '-',
                role !== 'tech' ? formatCurrencyPDF(item.amount) : '-'
            ]);

            autoTable(doc, {
                startY: y,
                head: [['#', 'Item', 'Qty', 'Days', 'Rate', 'Amount']],
                body: rows,
                theme: 'grid',
                headStyles: { fillColor: [70, 70, 70] },
                styles: { fontSize: 9, cellPadding: 3 },
                columnStyles: {
                    4: { halign: 'right' },
                    5: { halign: 'right' }
                }
            });

            y = doc.lastAutoTable.finalY + 10;

            // Totals
            if (role !== 'tech') {
                doc.setFontSize(10); doc.setFont("helvetica", "bold");
                doc.text(`Total Base: ${formatCurrencyPDF(group.totalBase)}`, pageWidth - 14, y, { align: 'right' });
                y += 5;
                doc.text(`Total GST: ${formatCurrencyPDF(group.totalGst)}`, pageWidth - 14, y, { align: 'right' });
                y += 5;
                doc.text(`Grand Total: ${formatCurrencyPDF(group.totalAmount)}`, pageWidth - 14, y, { align: 'right' });
                y += 10;
            }

            // Terms
            if (org?.po_terms) {
                if (y + 30 > pageHeight) { doc.addPage(); y = 20; }
                doc.setFontSize(10); doc.setFont("helvetica", "bold");
                doc.text("Terms & Conditions:", 14, y);
                y += 5;
                doc.setFontSize(8); doc.setFont("helvetica", "normal");
                const terms = doc.splitTextToSize(org.po_terms, pageWidth - 28);
                doc.text(terms, 14, y);
                y += (terms.length * 3.5) + 10;
            }

            // Signatures
            if (y + 40 > pageHeight) { doc.addPage(); y = 20; }

            doc.setLineWidth(0.5);
            doc.line(14, y + 25, 80, y + 25);
            doc.setFontSize(9); doc.setFont("helvetica", "bold");
            doc.text("Authorized Signatory", 14, y + 30);
            doc.setFont("helvetica", "normal");
            doc.text(org?.name || "Company", 14, y + 35);

            doc.line(110, y + 25, 180, y + 25);
            doc.setFont("helvetica", "bold");
            doc.text("Supplier Acknowledgement", 110, y + 30);
            doc.setFont("helvetica", "normal");
            doc.text("Signature & Stamp", 110, y + 35);
        }

        doc.save(`Outsourcing_Summary_${selectedProject.project_name.replace(/\s+/g, '_')}.pdf`);
      } catch (e) {
          console.error(e);
          addToast("Failed to generate PDF", 'error');
      }
  };

  const filteredAllPOs = useMemo(() => {
      return allPOs.filter(po =>
          ((po.vendor_name || '').toLowerCase().includes(poSearch.toLowerCase()) ||
          (po.po_no || '').toLowerCase().includes(poSearch.toLowerCase())) &&
          (showCancelledPOs || po.status !== 'Cancelled')
      );
  }, [allPOs, poSearch, showCancelledPOs]);

  const paginatedAllPOs = useMemo(() => {
    const start = (poCurrentPage - 1) * poItemsPerPage;
    return filteredAllPOs.slice(start, start + poItemsPerPage);
  }, [filteredAllPOs, poCurrentPage]);

  const poSubtotal = poForm.package_cost > 0
    ? poForm.package_cost
    : ((poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0));
  const poGstAmount = poForm.package_cost > 0
    ? (poForm.package_cost * ((poForm.package_cost_gst || 0) / 100))
    : (poSubtotal * ((poForm.gst_rate || 0) / 100));
  const poGrandTotal = poSubtotal + poGstAmount;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Outsourcing Manager</h2>
        <div className="flex gap-2 w-full md:w-auto">
          <div className="flex bg-white rounded-lg border p-1">
             <button onClick={() => setActiveTab('allocations')} className={`px-3 py-1 text-sm rounded flex-1 ${activeTab === 'allocations' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Allocations</button>
             <button onClick={() => setActiveTab('pos')} className={`px-3 py-1 text-sm rounded flex-1 ${activeTab === 'pos' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Purchase Orders</button>
          </div>
          <select
            className="rounded border p-2 text-sm w-full md:w-64 text-black"
            value={selectedProjectId}
            onChange={(e) => { setSelectedProjectId(e.target.value); setEditingAlloc(null); setVendorForm({ vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18, description: '' }); setActiveTab('allocations'); setAllocWizardSelection({}); }}
          >
            <option value="">-- Select Project --</option>
            {projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).map(p => (
              <option key={p.id} value={p.id}>{p.project_name}</option>
            ))}
          </select>
        </div>
      </div>

      {selectedProject ? (
        activeTab === 'allocations' ? (
        <div className="grid gap-6 md:grid-cols-2 h-[calc(100vh-200px)]">
          {/* Left: Requirements */}
          <div className="rounded-xl border bg-slate-50 p-4 shadow-sm flex flex-col overflow-y-auto bg-slate-50 border-slate-200">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-slate-700 flex items-center gap-2">
                    <AlertCircle size={18} className="text-indigo-500" /> Project Requirements
                </h3>
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none bg-white px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 bg-slate-50 border-slate-200 hover:bg-slate-50">
                    <input type="checkbox" checked={showPendingOnly} onChange={e => setShowPendingOnly(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="text-slate-600 font-medium">Pending Only</span>
                </label>
            </div>
            {renderItemList(externalItems, "External Items (Priority)", "text-orange-600")}
            {renderItemList(internalItems, "Internal Items (Can Outsource)", "text-slate-500")}
          </div>

          {/* Right: Vendor Allocation */}
          <div className="rounded-xl border bg-white p-4 shadow-sm flex flex-col overflow-hidden bg-slate-50 border-slate-200">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-slate-700 flex items-center gap-2">
                  <Truck size={18} className="text-indigo-500" />
                  Vendor Allocations
                </h3>
                <button onClick={exportAllocationSummary} className="text-xs flex items-center gap-1 bg-white border border-slate-200 rounded px-2 py-1 hover:bg-slate-50 text-slate-600"><FileText size={14} /> Export PDF</button>
            </div>

            {/* New Allocation Button */}
            <div className="mb-4">
                <button onClick={() => setIsAllocWizardOpen(true)} className="w-full py-3 rounded-lg bg-indigo-600 text-white font-bold hover:bg-indigo-700 flex items-center justify-center gap-2">
                    <Plus size={20} /> Create New Allocation
                </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto space-y-4">
              {paginatedAllocations.map(group => (
                <div key={group.id} className="border rounded-lg overflow-hidden bg-white bg-slate-50 border-slate-200">
                    <div className="bg-slate-100 p-2 px-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50">
                        <div className="font-bold text-slate-700">{group.name}</div>
                        {role !== 'tech' && (
                        <div className="text-xs text-slate-600 flex gap-3 bg-white px-2 py-1 rounded border">
                            <span>Base: <span className="font-semibold">{formatCurrency(group.totalBase)}</span></span>
                            <span className="text-slate-300">|</span>
                            <span>GST: <span className="font-semibold">{formatCurrency(group.totalGst)}</span></span>
                            <span className="text-slate-300">|</span>
                            <span className="text-indigo-700 font-bold">Total: {formatCurrency(group.totalAmount)}</span>
                        </div>
                        )}
                    </div>
                    <div className="divide-y divide-slate-100 divide-slate-100">
                        {group.items.map((alloc, idx) => (
                            <div key={idx} className="p-3 hover:bg-slate-50 flex justify-between items-center text-sm hover:bg-slate-50">
                                <div>
                                    <div className="font-medium text-slate-800">{alloc.item_name} {alloc.description && <span className="text-xs font-normal text-slate-500 italic">- {alloc.description}</span>}</div>
                                    <div className="text-xs text-slate-500 text-slate-400"><span className="bg-slate-100 px-1 rounded bg-slate-600 text-slate-200">x{alloc.qty}</span> {role !== 'tech' ? `| Rate: ${alloc.rate} | Days: ${alloc.days} | GST: ${alloc.gst}%` : `| Days: ${alloc.days}`}</div>
                                </div>
                                <div className="text-right">
                                    {role !== 'tech' && <div className="font-bold text-slate-800">{formatCurrency(alloc.tax_amount)}</div>}
                                    <div className="flex justify-end gap-2 mt-1">
                                        <button onClick={() => {
                                            setEditingAllocation(alloc);
                                            setIsEditModalOpen(true);
                                        }} className="text-blue-500 text-xs hover:underline">Edit</button>
                                        <button onClick={() => handleRemove(alloc)} className="text-red-500 text-xs hover:underline">Remove</button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
              ))}
              {allocationsByVendor.length === 0 && <div className="text-center text-slate-400 italic mt-4">No allocations yet.</div>}
            </div>
            {allocationsByVendor.length > allocItemsPerPage && (
                <div className="flex items-center justify-between pt-4 border-t mt-2">
                    <div className="text-xs text-slate-500">Page {allocPage} of {Math.ceil(allocationsByVendor.length / allocItemsPerPage)}</div>
                    <div className="flex gap-2">
                        <button onClick={() => setAllocPage(p => Math.max(1, p - 1))} disabled={allocPage === 1} className="px-2 py-1 rounded border bg-white hover:bg-slate-50 disabled:opacity-50 text-xs">Prev</button>
                        <button onClick={() => setAllocPage(p => Math.min(Math.ceil(allocationsByVendor.length / allocItemsPerPage), p + 1))} disabled={allocPage === Math.ceil(allocationsByVendor.length / allocItemsPerPage)} className="px-2 py-1 rounded border bg-white hover:bg-slate-50 disabled:opacity-50 text-xs">Next</button>
                    </div>
                </div>
            )}
          </div>
        </div>
        ) : (
          <div className="space-y-6">
             {/* Pending POs */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2"><AlertCircle size={18} className="text-orange-500"/> Pending Purchase Orders</h3>
                <div className="grid md:grid-cols-3 gap-4">
                   {pendingPOVendors.map((group, idx) => (
                      <div key={idx} className="border rounded-lg p-4 hover:shadow-md transition-shadow border-slate-200">
                         <div className="flex justify-between items-start mb-2">
                            <div className="font-bold text-slate-800">{group.vendor.name}</div>
                            <div className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded">{group.items.length} Items</div>
                         </div>
                         <div className="text-sm text-slate-500 mb-3">Total Value: {formatCurrency(group.totalAmount)}</div>
                         <button onClick={() => openPOModal(group)} className="w-full py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Create PO</button>
                      </div>
                   ))}
                   {pendingPOVendors.length === 0 && <div className="col-span-3 text-center text-slate-400 py-4">No pending items for PO.</div>}
                </div>
             </div>

             {/* Issued POs */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2"><FileCheck size={18} className="text-green-600"/> Issued Purchase Orders</h3>
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                        <input type="checkbox" checked={showCancelledPOs} onChange={e => setShowCancelledPOs(e.target.checked)} className="w-4 h-4 cursor-pointer accent-indigo-600 rounded border-slate-300" />
                        <span className="text-slate-600 font-medium">Show Cancelled</span>
                    </label>
                </div>
                <div className="overflow-x-auto">
                   <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-slate-700 font-semibold"><tr><th className="p-3">PO No</th><th className="p-3">Date</th><th className="p-3">Vendor</th><th className="p-3">Subject</th><th className="p-3 text-right">PO Amount</th><th className="p-3">Status</th><th className="p-3 text-center">Vendor Invoice</th><th className="p-3 text-center">Action</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                         {(selectedProject.purchase_orders || []).filter(po => showCancelledPOs || po.status !== 'Cancelled').map((po, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                               <td className="p-3 font-medium text-slate-800">{po.po_no}</td><td className="p-3">{new Date(po.date).toLocaleDateString()}</td><td className="p-3">{po.vendor_name}</td><td className="p-3 text-slate-500 truncate max-w-[200px]">{po.subject}</td><td className="p-3 text-right font-bold">{formatCurrency((po.package_cost && po.package_cost > 0) ? po.package_cost * (1 + (po.package_cost_gst || 0) / 100) : po.amount)}</td>
                               <td className="p-3">
                                   <select className={`text-xs border rounded p-1 text-black ${po.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50'}`} value={po.status || 'Draft'} onChange={(e) => updatePOStatus(po, e.target.value)}>
                                       {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                   </select>
                               </td>
                               <td className="p-3 text-center">
                                 {renderInvoiceCell(po, selectedProjectId || po.projectId)}
                               </td>
                               <td className="p-3 text-center flex justify-center gap-2">
                                   <button onClick={() => generatePOPDF(po, 'print')} className="text-indigo-600 hover:underline flex items-center gap-1"><Printer size={14}/> Print</button>
                                   <button onClick={() => generatePOPDF(po, 'download')} className="text-blue-600 hover:underline flex items-center gap-1"><Download size={14}/> PDF</button>
                                   <button onClick={() => openPOModal(po, true)} className="text-orange-600 hover:underline flex items-center gap-1"><Edit size={14}/> Edit</button>
                                   <button onClick={() => handleDuplicatePO(po)} className="text-green-600 hover:underline flex items-center gap-1"><Copy size={14}/> Copy</button>
                               </td>
                            </tr>
                         ))}
                         {(selectedProject.purchase_orders || []).filter(po => showCancelledPOs || po.status !== 'Cancelled').length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-400">No POs to display.</td></tr>}
                      </tbody>
                   </table>
                </div>
             </div>
          </div>
        )
      ) : (
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2"><FileCheck size={18} className="text-green-600"/> Recent Purchase Orders</h3>
                    <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                            <input type="checkbox" checked={showCancelledPOs} onChange={e => setShowCancelledPOs(e.target.checked)} className="w-4 h-4 cursor-pointer accent-indigo-600 rounded border-slate-300" />
                            <span className="text-slate-600 font-medium">Show Cancelled</span>
                        </label>
                        <div className="flex items-center rounded border px-3 py-1 bg-white">
                            <Search size={16} className="text-slate-400 mr-2" />
                            <input placeholder="Search Vendor or PO..." className="text-sm outline-none text-black bg-transparent" value={poSearch} onChange={(e) => setPoSearch(e.target.value)} />
                        </div>
                    </div>
                </div>
                <div className="overflow-x-auto">
                     <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-slate-700 font-semibold"><tr><th className="p-3">PO No</th><th className="p-3">Date</th><th className="p-3">Project</th><th className="p-3">Vendor</th><th className="p-3 text-right">PO Amount</th><th className="p-3">Status</th><th className="p-3 text-center">Vendor Invoice</th><th className="p-3 text-center">Actions</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                           {paginatedAllPOs.map((po, idx) => (
                              <tr key={idx} className="hover:bg-slate-50">
                                 <td className="p-3 font-medium text-slate-800">{po.po_no}</td>
                                 <td className="p-3">{new Date(po.date).toLocaleDateString()}</td>
                                 <td className="p-3">{po.projectName}</td>
                                 <td className="p-3">{po.vendor_name}</td>
                                 <td className="p-3 text-right font-bold">{formatCurrency(po.amount)}</td>
                                 <td className="p-3">
                                     <select className={`text-xs border rounded p-1 text-black ${po.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50'}`} value={po.status || 'Draft'} onChange={(e) => updatePOStatus(po, e.target.value)}>
                                         {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                     </select>
                                 </td>
                                 <td className="p-3 text-center">
                                   {renderInvoiceCell(po, selectedProjectId || po.projectId)}
                                 </td>
                                 <td className="p-3 text-center flex justify-center gap-2">
                                     <button onClick={() => generatePOPDF(po, 'print')} className="text-indigo-600 hover:underline flex items-center gap-1"><Printer size={14}/> Print</button>
                                     <button onClick={() => generatePOPDF(po, 'download')} className="text-blue-600 hover:underline flex items-center gap-1"><Download size={14}/> PDF</button>
                                      <button onClick={() => openPOModal(po, true)} className="text-orange-600 hover:underline flex items-center gap-1"><Edit size={14}/> Edit</button>
                                      <button onClick={() => handleDuplicatePO(po)} className="text-green-600 hover:underline flex items-center gap-1"><Copy size={14}/> Copy</button>
                                 </td>
                              </tr>
                           ))}
                           {filteredAllPOs.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">No POs found.</td></tr>}
                        </tbody>
                     </table>
                </div>
                {filteredAllPOs.length > poItemsPerPage && (
                  <div className="flex items-center justify-between p-4 border-t bg-white bg-slate-50 border-slate-200">
                      <div className="text-sm text-slate-500">
                          Showing {Math.min((poCurrentPage - 1) * poItemsPerPage + 1, filteredAllPOs.length)} to {Math.min(poCurrentPage * poItemsPerPage, filteredAllPOs.length)} of {filteredAllPOs.length} results
                      </div>
                      <div className="flex gap-2">
                          <button onClick={() => setPoCurrentPage(p => Math.max(1, p - 1))} disabled={poCurrentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                          <button onClick={() => setPoCurrentPage(p => Math.min(Math.ceil(filteredAllPOs.length / poItemsPerPage), p + 1))} disabled={poCurrentPage === Math.ceil(filteredAllPOs.length / poItemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
                      </div>
                  </div>
                )}
             </div>
          )}
      <EditAllocationModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        allocation={editingAllocation}
        onSave={handleUpdateAllocation}
      />

      {/* Purchase Invoice (Service) Modal — creates/updates a purchase_invoices doc linked to the PO */}
      <Modal isOpen={isInvoiceModalOpen} onClose={() => { setIsInvoiceModalOpen(false); setEditingPIId(null); }} title={`${editingPIId ? 'Edit' : 'Create'} Purchase Invoice (Service) — PO ${invoicingPO?.po_no || ''}`}>
        <div className="space-y-4">
          {/* PO Reference */}
          <div className="bg-slate-50 p-3 rounded text-sm border border-slate-200 text-slate-800">
            <div className="flex justify-between">
              <div><strong>Vendor:</strong> {invoicingPO?.vendor_name}</div>
              <div><strong>PO Amount:</strong> {formatCurrency((invoicingPO?.package_cost && invoicingPO?.package_cost > 0) ? invoicingPO?.package_cost * (1 + (invoicingPO?.package_cost_gst || 0) / 100) : (invoicingPO?.amount || 0))}</div>
            </div>
          </div>

          {/* Invoice Details */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-700">Vendor Invoice No. *</label>
              <input className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.invoice_no} onChange={e => setInvoiceForm({...invoiceForm, invoice_no: e.target.value})} placeholder="INV/2025-26/001" />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Invoice Date *</label>
              <input type="date" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.invoice_date} onChange={e => setInvoiceForm({...invoiceForm, invoice_date: e.target.value})} />
            </div>
          </div>

          {/* Amounts */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-700">Base Amount (excl. GST) ₹</label>
              <input type="number" step="0.01" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.base_amount} onChange={e => {
                const base = parseFloat(e.target.value) || 0;
                const gst = base * ((invoiceForm.gst_rate || 0) / 100);
                setInvoiceForm({...invoiceForm, base_amount: base, gst_amount: gst, total_amount: base + gst});
              }} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">GST Rate %</label>
              <select className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.gst_rate} onChange={e => {
                const rate = parseFloat(e.target.value) || 0;
                const gst = (invoiceForm.base_amount || 0) * (rate / 100);
                setInvoiceForm({...invoiceForm, gst_rate: rate, gst_amount: gst, total_amount: (invoiceForm.base_amount || 0) + gst});
              }}>
                <option value="0">0% (Unregistered / Exempt)</option>
                <option value="5">5%</option>
                <option value="12">12%</option>
                <option value="18">18%</option>
                <option value="28">28%</option>
              </select>
            </div>
            <div className="bg-indigo-50 p-3 rounded-lg border border-indigo-200">
              <div className="text-xs text-slate-500">GST: {formatCurrency(invoiceForm.gst_amount)}</div>
              <div className="text-base font-bold text-indigo-700">Total: {formatCurrency(invoiceForm.total_amount)}</div>
              {(() => {
                const poAmt = invoicingPO ? ((invoicingPO.package_cost && invoicingPO.package_cost > 0)
                  ? invoicingPO.package_cost * (1 + (invoicingPO.package_cost_gst || 0) / 100)
                  : (invoicingPO.amount || 0)) : 0;
                const variance = (invoiceForm.total_amount || 0) - poAmt;
                if (Math.abs(variance) < 0.01) return null;
                return (
                  <div className={`text-xs font-semibold mt-1 ${variance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {variance > 0 ? '▲ Overage' : '▼ Saving'}: {formatCurrency(Math.abs(variance))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Accounting note */}
          <div className="rounded-lg p-3 bg-amber-50 border border-amber-200 text-xs text-amber-800">
            <strong>Creates a Service Purchase Invoice.</strong> A numbered PI is added to the Purchase Invoices register (status <strong>Pending</strong>), linked to this PO. It is included in the vendor ledger and replaces the PO's committed amount in the ledger, P&amp;L and GST Input Credit. If GST Rate is 0%, no ITC is claimed (unregistered vendor).
          </div>

          <div>
            <label className="text-xs font-bold text-slate-700">Notes</label>
            <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={invoiceForm.notes} onChange={e => setInvoiceForm({...invoiceForm, notes: e.target.value})} placeholder="Payment terms, reference numbers..." />
          </div>

          <button onClick={handleSaveVendorInvoice} disabled={savingInvoice} className="w-full rounded bg-indigo-600 text-white py-2 font-bold hover:bg-indigo-700 disabled:opacity-50">
            {savingInvoice ? 'Saving…' : editingPIId ? 'Update Purchase Invoice' : 'Create Purchase Invoice'}
          </button>
        </div>
      </Modal>

      {/* Allocation Wizard Modal */}
      <Modal isOpen={isAllocWizardOpen} onClose={() => setIsAllocWizardOpen(false)} title="New Allocation">
          <div className="space-y-4 h-[70vh] flex flex-col">
              <div className="grid grid-cols-2 gap-4">
                  <div>
                      <label className="text-xs font-bold text-slate-700">Project</label>
                      <input className="w-full rounded border border-slate-300 p-2 bg-slate-50 text-slate-500" value={selectedProject?.project_name || ''} disabled />
                  </div>
                  <div>
                      <label className="text-xs font-bold text-slate-700">Vendor</label>
                      <select className="w-full rounded border border-slate-300 p-2 text-black" value={vendorForm.vendor_id} onChange={e => setVendorForm({...vendorForm, vendor_id: e.target.value})}>
                          <option value="">-- Select Vendor --</option>
                          {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                  </div>
              </div>

              <div className="flex-1 overflow-y-auto border rounded-lg">
                  <table className="w-full text-sm text-left">
                      <thead className="bg-slate-100 text-slate-500 font-bold sticky top-0"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Req</th><th className="p-2 text-center">Rem</th><th className="p-2 w-20">Qty</th><th className="p-2 w-24">Rate</th><th className="p-2 w-16">Days</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                          {allProjectItems.map(item => {
                              const remaining = getRemainingQty(item.item_id);
                              const isSelected = allocWizardSelection[item.item_id]?.selected;
                              return (
                                  <tr key={item.item_id} className={isSelected ? 'bg-indigo-50' : ''}>
                                      <td className="p-2"><input type="checkbox" checked={!!isSelected} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], selected: e.target.checked, qty: prev[item.item_id]?.qty || remaining, rate: prev[item.item_id]?.rate || 0, days: prev[item.item_id]?.days || getDaysDifference(selectedProject.start_date, selectedProject.end_date) } }))} className="w-4 h-4 cursor-pointer accent-indigo-600" /></td>
                                      <td className="p-2"><div className="font-medium text-slate-800">{item.item_name}</div>{item.is_external && <span className="text-[10px] bg-purple-100 text-purple-700 px-1 rounded">Ext</span>}</td>
                                      <td className="p-2 text-center text-slate-500">{item.qty}</td>
                                      <td className="p-2 text-center font-bold text-slate-800">{remaining}</td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800 bg-white" value={allocWizardSelection[item.item_id]?.qty || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], qty: e.target.value } }))} disabled={!isSelected} /></td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800 bg-white" value={allocWizardSelection[item.item_id]?.rate || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], rate: e.target.value } }))} disabled={!isSelected} /></td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800 bg-white" value={allocWizardSelection[item.item_id]?.days || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], days: e.target.value } }))} disabled={!isSelected} /></td>
                                  </tr>
                              );
                          })}
                      </tbody>
                  </table>
              </div>
              <button onClick={handleSaveWizardAllocation} className="w-full rounded bg-indigo-600 py-3 text-white font-bold hover:bg-indigo-700">Save Allocation</button>
          </div>
      </Modal>

      <Modal isOpen={isPOModalOpen} onClose={() => setIsPOModalOpen(false)} title={editingPO ? "Edit Purchase Order" : "Create Purchase Order"}>
         <div className="space-y-4">
            <div className="bg-slate-50 p-3 rounded text-sm border text-slate-800"><strong>Vendor:</strong> {poVendorData?.vendor.name} <br/> <strong>Items:</strong> {poItems.length}</div>
            <div className="grid grid-cols-2 gap-4"><div><label className="text-xs font-bold text-slate-700">PO Number</label><input className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.po_no} onChange={e => setPoForm({...poForm, po_no: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.date} onChange={e => setPoForm({...poForm, date: e.target.value})} /></div></div>
            <div><label className="text-xs font-bold text-slate-700">Subject</label><input className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.subject} onChange={e => setPoForm({...poForm, subject: e.target.value})} /></div>

            <div className="border rounded overflow-hidden max-h-40 overflow-y-auto">
                <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-800 font-bold sticky top-0">
                        <tr>
                            <th className="p-2">Item</th>
                            <th className="p-2 w-16">Qty</th>
                            <th className="p-2">Description</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {poItems.map((item, idx) => (
                            <tr key={idx}>
                                <td className="p-2 text-slate-800">{item.item_name}</td>
                                <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800" value={item.qty} onChange={(e) => {
                                    const newItems = [...poItems];
                                    newItems[idx].qty = parseInt(e.target.value) || 0;
                                    setPoItems(newItems);
                                }} /></td>
                                <td className="p-2"><input type="text" className="w-full border border-slate-300 rounded p-1 text-slate-800" value={item.description || ''} onChange={(e) => {
                                    const newItems = [...poItems];
                                    newItems[idx].description = e.target.value;
                                    setPoItems(newItems);
                                }} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="border-t border-slate-200 pt-4 mt-4">
              <h4 className="text-sm font-bold text-slate-800 mb-2">Cost Breakdown</h4>
              <div className="flex items-center gap-2 mb-4 p-3 bg-slate-50 rounded border border-slate-200">
                  <input type="checkbox" id="isPackageCost" checked={poForm.package_cost > 0} onChange={e => {
                    if (e.target.checked) {
                      setPoForm({...poForm, package_cost: 1000, package_cost_gst: parseFloat(poForm.gst_rate) || 18});
                    } else {
                      setPoForm({...poForm, package_cost: 0, package_cost_gst: 18});
                    }
                  }} className="w-4 h-4 cursor-pointer accent-indigo-600 accent-indigo-500 rounded border-slate-300 border-slate-200" />
                  <label htmlFor="isPackageCost" className="text-xs font-bold text-slate-700 cursor-pointer">Use Package Cost (Lump Sum)</label>
              </div>

              {poForm.package_cost > 0 ? (
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div>
                    <label className="text-xs font-bold text-slate-700">Package Cost (excl. GST)</label>
                    <input type="number" step="0.01" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.package_cost} onChange={e => setPoForm({...poForm, package_cost: parseFloat(e.target.value) || 0})} />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700">GST Rate (%)</label>
                    <select className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.package_cost_gst || 18} onChange={e => setPoForm({...poForm, package_cost_gst: parseFloat(e.target.value) || 18})}>
                        <option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option>
                    </select>
                  </div>
                  <div className="bg-indigo-50 p-3 rounded-lg text-right border border-indigo-200">
                    <div className="text-xs text-slate-600 font-semibold">Package Total</div>
                    <div className="text-lg font-bold text-indigo-700">{formatCurrency(poForm.package_cost * (1 + (poForm.package_cost_gst || 18) / 100))}</div>
                    <div className="text-xs text-slate-500">GST: {formatCurrency(poForm.package_cost * ((poForm.package_cost_gst || 18) / 100))}</div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div><label className="text-xs font-bold text-slate-700">Equipment Cost</label><input type="number" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.equipment_cost} onChange={e => setPoForm({...poForm, equipment_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Labour Cost</label><input type="number" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.labour_cost} onChange={e => setPoForm({...poForm, labour_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Transport Cost</label><input type="number" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.transport_cost} onChange={e => setPoForm({...poForm, transport_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">F&B Cost</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.fnb_cost} onChange={e => setPoForm({...poForm, fnb_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Travel Cost</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.travel_cost} onChange={e => setPoForm({...poForm, travel_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Accommodation</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.accommodation_cost} onChange={e => setPoForm({...poForm, accommodation_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Misc Cost</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.misc_cost} onChange={e => setPoForm({...poForm, misc_cost: parseFloat(e.target.value) || 0})} /></div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="col-span-1">
                      <label className="text-xs font-bold text-slate-700">GST Rate</label>
                      <select className="w-full rounded border border-slate-300 p-2 text-slate-800 bg-slate-50" value={poForm.gst_rate} onChange={e => setPoForm({...poForm, gst_rate: parseFloat(e.target.value) || 0})}>
                          <option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option>
                      </select>
                  </div>
                  <div className="col-span-2 bg-slate-100 p-3 rounded-lg text-right">
                      <div className="text-xs text-slate-500">Subtotal: {formatCurrency(poSubtotal)}</div>
                      <div className="text-xs text-slate-500">GST ({poForm.package_cost > 0 ? poForm.package_cost_gst : poForm.gst_rate}%): {formatCurrency(poGstAmount)}</div>
                      <div className="text-lg font-bold text-indigo-700">Total: {formatCurrency(poGrandTotal)}</div>
                  </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-bold text-slate-800 mb-2 flex items-center gap-2"><Paperclip size={16}/> Attachments</h4>
                <div className="space-y-2 mb-2">
                    {poForm.attachments.map((file, idx) => (
                        <div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border text-xs">
                            <div className="flex items-center gap-2 truncate">
                                <FileText size={14} className="text-slate-400"/>
                                <span className="truncate max-w-[200px] text-slate-700" title={file.name}>{file.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <a href={file.data} download={file.name} className="text-blue-600 hover:underline">Download</a>
                                <button onClick={() => removeAttachment(idx)} className="text-red-500 hover:text-red-700"><X size={14}/></button>
                            </div>
                        </div>
                    ))}
                    {poForm.attachments.length === 0 && <div className="text-xs text-slate-400 italic">No attachments.</div>}
                </div>
                <div className="relative">
                    <input type="file" multiple onChange={handleFileUpload} className="block w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
                </div>
            </div>

            <div><label className="text-xs font-bold text-slate-700">Terms & Conditions</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={3} value={poForm.terms} onChange={e => setPoForm({...poForm, terms: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-slate-700">Internal Notes</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={poForm.notes} onChange={e => setPoForm({...poForm, notes: e.target.value})} /></div>
            <button onClick={editingPO ? handleUpdatePO : handleCreatePO} className="w-full rounded bg-indigo-600 text-white py-2 font-bold hover:bg-indigo-700">{editingPO ? 'Update PO' : 'Generate & Save PO'}</button>
         </div>
      </Modal>
    </div>
  );
};

const EditAllocationModal = ({ isOpen, onClose, allocation, onSave }) => {
  const [formData, setFormData] = useState(allocation || {});

  useEffect(() => {
    setFormData(allocation || {});
  }, [allocation]);

  if (!isOpen || !formData?.id) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Outsourced Item">
      <div className="space-y-4">
        <div>
          <label className="text-xs font-bold text-slate-700">Quantity</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.qty}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Rate</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.rate}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Days</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.days}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">GST %</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.gst}
            onChange={(e) => setFormData({ ...formData, gst: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Description</label>
          <input
            type="text"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
        </div>
        <div className="flex justify-end pt-2">
          <button
            onClick={() => onSave(formData)}
            className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default Outsourcing;
