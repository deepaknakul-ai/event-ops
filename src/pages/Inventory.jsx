import React, { useState, useEffect, useMemo } from 'react';
import { notify } from '../utils/toast';
import {
  Box, Plus, Search, Edit, Trash2, Layers, Users, DollarSign,
  Truck, Settings, Hammer, CalendarDays, Printer, Tag, ChevronDown, X,
  Archive, ArchiveRestore
} from 'lucide-react';
import { collection, addDoc, updateDoc, doc, deleteDoc, setDoc } from 'firebase/firestore';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import InventoryCalendar from '../components/InventoryCalendar';
import { formatCurrency, validateGSTIN } from '../utils/helpers';
import { CATEGORIES } from '../utils/constants';
import { can } from '../utils/permissions';
import { generateAssetLabelsPDF } from '../utils/pdf/assetLabels';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const Inventory = ({ inventory, clients, projects = [], role, db, appId, logAction, categories: categoriesProp }) => { // version 3.3.0 vendors database addition: added clients prop
  const categories = categoriesProp || CATEGORIES;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [filterArchived, setFilterArchived] = useState('active');
  const [activeTab, setActiveTab] = useState('general');
  const [compForm, setCompForm] = useState({ item_id: '', qty: 1 });
  const [supplierForm, setSupplierForm] = useState({ vendor_id: '', brand: '', spec: '', rate: 0 });
  const [currentPage, setCurrentPage] = useState(1);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarItemId, setCalendarItemId] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  // Serial number management
  const [autoGen, setAutoGen] = useState({ visible: false, prefix: 'SN-', suffix: '', startFrom: 1 });
  const [removePickerModal, setRemovePickerModal] = useState({ isOpen: false, newQty: 0, pendingRemove: new Set() });
  const [selectedForPrint, setSelectedForPrint] = useState(new Set());
  const itemsPerPage = 20;

  const initialForm = {
    // General
    item_type: 'Equipment',
    asset_id: '', name: '', brand: '', category: '', sub_category: '',
    serial_number: '', status: 'Available', location: '', total: 0,
    is_composite: false, composition: [],
    vendor_id: '', // version 3.3.0 vendors database addition
    suppliers: [],
    serial_numbers: [],
    serial_details: [], // { serial, purchase_date, invoice_no, warranty_start, warranty_end }
    // Commercial
    purchase_date: '', purchase_cost: '', rate_per_day: 0, rate_per_week: 0,
    replacement_value: '', supplier: '',
    // Logistics
    weight: '', dimensions: '', power_watts: '', current_amps: '',
    connector_type: '', ip_rating: '',
    // Specs (Attributes)
    attributes: {},
    // LED Tile Model (for LED Wall category)
    tile_model: null,
    // Maintenance
    last_service_date: '', next_test_due: '', service_interval_days: '', service_notes: '',
    // Misc
    gst_rate: 18, is_external: false, hsn_code: '', remarks: '', specifications: '',
    // M-3: low-stock reorder threshold (alerts when available qty drops below this).
    reorder_level: 0
  };

  const [formData, setFormData] = useState(initialForm);

  const openAdd = () => {
    setEditingId(null);
    setFormData(initialForm);
    setActiveTab('general');
    setIsModalOpen(true);
    setSelectedForPrint(new Set());
    setAutoGen({ visible: false, prefix: 'SN-', suffix: '', startFrom: 1 });
  };

  const openEdit = (item) => {
    setEditingId(item.id);
    setActiveTab('general');
    setIsModalOpen(true);
    setSelectedForPrint(new Set());
    setAutoGen({ visible: false, prefix: 'SN-', suffix: '', startFrom: 1 });
    // Migrate: prefer serial_details if saved, else build from serial_numbers / serial_number
    let serial_details = item.serial_details || [];
    if (serial_details.length === 0) {
      const sns = (item.serial_numbers && item.serial_numbers.length > 0)
        ? item.serial_numbers
        : (item.serial_number ? [item.serial_number] : []);
      serial_details = sns.map(s => ({ serial: s, purchase_date: '', invoice_no: '', warranty_start: '', warranty_end: '' }));
    }
    setFormData({
      ...initialForm, ...item,
      attributes: item.attributes || {},
      serial_numbers: item.serial_numbers || (item.serial_number ? [item.serial_number] : []),
      serial_details
    });
  };

  const handleArchive = async (id, archive) => {
    if (!can(role, 'inventory', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    const item = inventory.find(i => i.id === id);
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id), {
      is_archived: archive,
      archived_at: archive ? new Date().toISOString() : null
    });
    logAction('inventory', archive ? 'archive' : 'unarchive', id, {}, item?.name);
  };

  const handleDelete = async (id) => {
    if (!can(role, 'inventory', 'delete')) return notify('Access denied: only Admin can delete inventory.', 'error');
    const itemName = inventory.find(i => i.id === id)?.name || 'this item';
    setDeleteConfirm({
      isOpen: true,
      title: 'Delete Inventory Item',
      message: `Permanently delete "${itemName}"? Removing it from inventory cannot be undone. Existing project allocations referencing this item will lose the link.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id));
        logAction('inventory', 'delete', id, {}, itemName);
      }
    });
  };

  const handleSave = async () => {
    if (editingId ? !can(role, 'inventory', 'edit') : !can(role, 'inventory', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    const totalQty = parseInt(formData.total) || 0;
    const serialDetails = formData.serial_details || [];

    if (serialDetails.length > totalQty) {
      notify(`Serial count (${serialDetails.length}) exceeds total qty (${totalQty}). Please remove extra entries first.`, 'error');
      return;
    }

    const finalSerialDetails = serialDetails.slice(0, totalQty);
    const finalSerialNumbers = finalSerialDetails.map(d => d.serial).filter(Boolean);
    const finalSerialNumber = finalSerialNumbers[0] || '';

    // Field-split slice 1: rate/cost fields (+ suppliers, which carry per-vendor
    // rates) live in the gated inventory_financials sibling, NOT the base doc which
    // every role reads operationally. Split them out here. gst_rate stays on base —
    // it is a tax % read operationally by challan/quote flows.
    const { rate_per_day: _rpd, rate_per_week: _rpw, purchase_cost: _pc, replacement_value: _rv, suppliers: _sup, ...opForm } = formData;
    const itemData = {
      ...opForm,
      total: totalQty,
      weight: parseFloat(formData.weight) || 0,
      power_watts: parseFloat(formData.power_watts) || 0,
      current_amps: parseFloat(formData.current_amps) || 0,
      gst_rate: Number.isFinite(parseFloat(formData.gst_rate)) ? parseFloat(formData.gst_rate) : 18, // 0% exempt must persist as 0, not fall back to 18
      reorder_level: parseInt(formData.reorder_level) || 0,
      is_composite: formData.is_composite || false,
      composition: formData.composition || [],
      vendor_id: formData.vendor_id || '', // version 3.3.0 vendors database addition
      serial_details: finalSerialDetails,
      serial_numbers: finalSerialNumbers,
      serial_number: finalSerialNumber,
      tile_model: formData.tile_model || null,
      updated_at: new Date().toISOString()
    };
    const financialsData = {
      rate_per_day: parseFloat(_rpd) || 0,
      rate_per_week: parseFloat(_rpw) || 0,
      purchase_cost: parseFloat(_pc) || 0,
      replacement_value: parseFloat(_rv) || 0,
      suppliers: _sup || [],
      updated_at: new Date().toISOString(),
    };

    try {
      if (editingId) {
        // Sibling money first, then base operational — money is never lost on a partial failure.
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory_financials', editingId), financialsData, { merge: true });
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', editingId), itemData);
        logAction('inventory', 'update', editingId, itemData, formData.name);
      } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), { ...itemData, gst_history: [], created_at: new Date().toISOString() });
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory_financials', docRef.id), financialsData, { merge: true });
        logAction('inventory', 'create', docRef.id, itemData, formData.name);
      }
    } catch (e) {
      notify(`Save failed: ${e.message || e}`, 'error');
      return;
    }
    setIsModalOpen(false);
  };

  const addComponent = () => {
      if (!compForm.item_id || !compForm.qty) return;
      if (compForm.item_id === editingId) return notify("Cannot add self as component", 'error');
      if (formData.composition && formData.composition.some(c => c.item_id === compForm.item_id)) return notify("Item already in composition", 'error');

      setFormData({
          ...formData,
          composition: [...(formData.composition || []), { item_id: compForm.item_id, qty: parseInt(compForm.qty) }]
      });
      setCompForm({ item_id: '', qty: 1 });
  };

  const addSupplier = () => {
      if (!supplierForm.vendor_id) return notify("Select a vendor", 'error');
      setFormData(prev => ({
          ...prev,
          suppliers: [...(prev.suppliers || []), { ...supplierForm }]
      }));
      setSupplierForm({ vendor_id: '', brand: '', spec: '', rate: 0 });
  };

  const removeSupplier = (index) => {
      setFormData(prev => ({
          ...prev,
          suppliers: (prev.suppliers || []).filter((_, i) => i !== index)
      }));
  };

  const removeComponent = (index) => {
      const newComp = [...(formData.composition || [])];
      newComp.splice(index, 1);
      setFormData({ ...formData, composition: newComp });
  };

  // --- Serial Detail Helpers ---
  const updateSerialDetail = (idx, field, value) => {
    const updated = [...(formData.serial_details || [])];
    updated[idx] = { ...updated[idx], [field]: value };
    setFormData({ ...formData, serial_details: updated });
  };

  const removeSerialDetail = (idx) => {
    const updated = (formData.serial_details || []).filter((_, i) => i !== idx);
    setFormData({ ...formData, serial_details: updated });
    const shifted = new Set();
    selectedForPrint.forEach(i => { if (i !== idx) shifted.add(i > idx ? i - 1 : i); });
    setSelectedForPrint(shifted);
  };

  const handleAutoGenerate = () => {
    const tQty = parseInt(formData.total) || 0;
    if (tQty === 0) { notify('Set Total Qty first.', 'error'); return; }
    const existing = [...(formData.serial_details || [])];
    let counter = parseInt(autoGen.startFrom) || 1;
    const result = [];
    for (let i = 0; i < existing.length; i++) {
      if (!existing[i].serial) {
        result.push({ ...existing[i], serial: `${autoGen.prefix}${counter}${autoGen.suffix}` });
        counter++;
      } else {
        result.push(existing[i]);
      }
    }
    while (result.length < tQty) {
      result.push({ serial: `${autoGen.prefix}${counter}${autoGen.suffix}`, purchase_date: '', invoice_no: '', warranty_start: '', warranty_end: '' });
      counter++;
    }
    setFormData({ ...formData, serial_details: result });
  };

  const printSerialLabels = (itemName, details) => {
    if (!details || details.length === 0) return;
    const pdfdoc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = 297, pageH = 210;
    const margin = 10;
    const cols = 2, rows = 5;
    const gapX = 6, gapY = 5;
    const labelW = (pageW - margin * 2 - gapX * (cols - 1)) / cols;
    const labelH = (pageH - margin * 2 - gapY * (rows - 1)) / rows;

    details.forEach((det, idx) => {
      if (idx > 0 && idx % (cols * rows) === 0) pdfdoc.addPage();
      const pageIdx = idx % (cols * rows);
      const col = pageIdx % cols;
      const row = Math.floor(pageIdx / cols);
      const x = margin + col * (labelW + gapX);
      const y = margin + row * (labelH + gapY);

      pdfdoc.setDrawColor(180, 180, 180);
      pdfdoc.roundedRect(x, y, labelW, labelH, 2, 2);

      pdfdoc.setFontSize(7);
      pdfdoc.setFont('helvetica', 'bold');
      pdfdoc.setTextColor(100, 100, 100);
      pdfdoc.text((itemName || 'Item').toUpperCase(), x + 3, y + 5, { maxWidth: labelW - 6 });

      pdfdoc.setFontSize(13);
      pdfdoc.setFont('helvetica', 'bold');
      pdfdoc.setTextColor(20, 20, 20);
      pdfdoc.text(det.serial || '—', x + 3, y + 13, { maxWidth: labelW - 6 });

      pdfdoc.setDrawColor(220, 220, 220);
      pdfdoc.line(x + 3, y + 16, x + labelW - 3, y + 16);

      pdfdoc.setFontSize(6.5);
      pdfdoc.setFont('helvetica', 'normal');
      pdfdoc.setTextColor(80, 80, 80);
      const line1 = [];
      if (det.purchase_date) line1.push(`Purchased: ${det.purchase_date}`);
      if (det.invoice_no) line1.push(`Invoice: ${det.invoice_no}`);
      if (line1.length > 0) pdfdoc.text(line1.join('   '), x + 3, y + 21, { maxWidth: labelW - 6 });
      if (det.warranty_start || det.warranty_end)
        pdfdoc.text(`Warranty: ${det.warranty_start || '—'} → ${det.warranty_end || '—'}`, x + 3, y + 26, { maxWidth: labelW - 6 });
    });
    pdfdoc.save(`${(itemName || 'inventory').replace(/\s+/g, '_')}-labels.pdf`);
  };

  const updateAttribute = (key, value) => {
    setFormData(prev => ({ ...prev, attributes: { ...prev.attributes, [key]: value } }));
  };

  const filteredInventory = inventory.filter(item => {
    const matchSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.brand && item.brand.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (item.asset_id && item.asset_id.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (item.serial_number && item.serial_number.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (item.serial_numbers && item.serial_numbers.some(sn => sn.toLowerCase().includes(searchTerm.toLowerCase())));
    const matchCategory = filterCategory === 'All' || filterCategory === 'Service'
      ? (filterCategory === 'Service' ? item.item_type === 'Service' : true)
      : item.category === filterCategory;
    const matchArchived = filterArchived === 'all'
      ? true
      : filterArchived === 'archived'
        ? !!item.is_archived
        : !item.is_archived;
    return matchSearch && matchCategory && matchArchived;
  });

  const paginatedInventory = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredInventory.slice(start, start + itemsPerPage);
  }, [filteredInventory, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, filterCategory, filterArchived]);

  const renderField = (label, key, type='text', placeholder='') => (
    <div>
      <label className="block text-xs font-bold text-slate-700 mb-1">{label}</label>
      <input
        type={type}
        className="w-full rounded border border-slate-300 p-2 text-sm bg-white text-slate-800 placeholder-slate-400"
        placeholder={placeholder}
        value={formData[key]}
        onChange={e => setFormData({...formData, [key]: e.target.value})}
      />
    </div>
  );


  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Inventory Manager</h2>
        <div className="flex gap-2 w-full md:w-auto">
          <div className="hidden md:flex items-center rounded border px-3 py-1 bg-white flex-1">
            <Search size={16} className="text-slate-400 mr-2" />
            <input placeholder="Search name, brand, tag..." className="text-sm outline-none text-black" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <select className="rounded border px-3 py-1 bg-white text-sm outline-none flex-1 md:flex-none" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
            <option value="All">All Categories</option>
            <option value="Service">Service</option>
            {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
          <select className="rounded border px-3 py-1 bg-white text-sm outline-none flex-1 md:flex-none" value={filterArchived} onChange={(e) => setFilterArchived(e.target.value)}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All Items</option>
          </select>
          <button
            onClick={() => { setCalendarItemId(''); setIsCalendarOpen(true); }}
            className="flex items-center justify-center gap-2 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 px-3 py-1 text-sm hover:bg-indigo-100 whitespace-nowrap flex-1 md:flex-none"
          >
            <CalendarDays size={16} /> Availability
          </button>
          <button
            onClick={async () => { const r = await generateAssetLabelsPDF(filteredInventory); notify(r && r.count ? `Generated ${r.count} QR label(s).` : 'No printable items in the current filter.', r && r.count ? 'success' : 'info'); }}
            title="Print QR labels for the filtered items"
            className="flex items-center justify-center gap-2 rounded border border-slate-200 bg-white text-slate-600 px-3 py-1 text-sm hover:bg-slate-50 whitespace-nowrap flex-1 md:flex-none"
          >
            <Printer size={16} /> QR Labels
          </button>
          {role === 'admin' && (
            <>
              <button onClick={openAdd} className="flex items-center justify-center gap-2 rounded bg-indigo-600 px-3 py-1 text-white text-sm hover:bg-indigo-700 whitespace-nowrap flex-1 md:flex-none">
                <Plus size={16} /> Add Item
              </button>
            </>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-700 font-semibold">
            <tr>
              <th className="p-4 font-medium">Asset / Model</th>
              <th className="p-4 font-medium hidden md:table-cell">Brand</th>
              <th className="p-4 font-medium hidden md:table-cell">Category</th>
              {can(role, 'inventory', 'view_rates') && <th className="p-4 font-medium text-right">Rate/Day</th>}
              <th className="p-4 font-medium text-center">Qty</th>
              <th className="p-4 font-medium hidden md:table-cell">Loc</th>
              <th className="p-4 font-medium text-center">Avail.</th>
              {role === 'admin' && <th className="p-4 font-medium text-center">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginatedInventory.map((item, idx) => (
              <tr key={idx} className={`hover:bg-slate-50 group ${item.is_archived ? 'opacity-60' : ''}`}>
                <td className="p-4 font-medium text-slate-800">
                  <div className="flex flex-col">
                    <span className="flex items-center gap-2">
                      {item.name}
                      {item.is_composite && <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 border border-indigo-200">Kit</span>}
                      {item.is_external && <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700 border border-purple-200">Ext</span>}
                      {item.is_archived && <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-500 border border-slate-300">Archived</span>}
                    </span>
                    {item.asset_id && <span className="text-xs text-slate-400 font-mono">ID: {item.asset_id}</span>}
                    {/* version 3.3.0 vendors database addition: Show vendor name */}
                    {item.is_external && item.vendor_id && (
                        <span className="text-[10px] text-slate-500">via {clients.find(c => c.id === item.vendor_id)?.name}</span>
                    )}
                  </div>
                </td>
                <td className="p-4 text-slate-500 hidden md:table-cell">{item.brand || '-'}</td>
                <td className="p-4 text-slate-500 hidden md:table-cell">{item.category}</td>
                {can(role, 'inventory', 'view_rates') && <td className="p-4 text-right text-slate-800 font-mono">{formatCurrency(item.rate_per_day || 0)}</td>}
                <td className="p-4 text-center text-slate-800">
                    {(() => {
                      const total = parseInt(item.total) || 0;
                      const reorder = parseInt(item.reorder_level) || 0;
                      // M-3: red when out of stock, amber when at/below reorder level, green otherwise.
                      const cls = total <= 0
                        ? 'bg-red-100 text-red-700'
                        : (reorder > 0 && total <= reorder ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700');
                      return (
                        <span className={`px-2 py-1 rounded text-xs font-bold ${cls}`}
                          title={reorder > 0 && total <= reorder && total > 0 ? `Low stock — at or below reorder level (${reorder})` : ''}>
                          {item.total}{reorder > 0 && total <= reorder && total > 0 ? ' ⚠' : ''}
                        </span>
                      );
                    })()}
                </td>
                <td className="p-4 text-slate-500 hidden md:table-cell">{item.location}</td>
                <td className="p-4 text-center">
                  <button
                    title="View availability calendar"
                    onClick={() => { setCalendarItemId(item.id); setIsCalendarOpen(true); }}
                    className="rounded p-1 text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700"
                  >
                    <CalendarDays size={15} />
                  </button>
                </td>
                {role === 'admin' && (
                  <td className="p-4 text-center">
                    <div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => openEdit(item)} className="rounded p-1 text-blue-600 hover:bg-blue-50"><Edit size={16} /></button>
                      {item.is_archived ? (
                        <button onClick={() => handleArchive(item.id, false)} title="Unarchive" className="rounded p-1 text-green-600 hover:bg-green-50"><ArchiveRestore size={16} /></button>
                      ) : (
                        <button onClick={() => handleArchive(item.id, true)} title="Archive item" className="rounded p-1 text-amber-600 hover:bg-amber-50"><Archive size={16} /></button>
                      )}
                      <button onClick={() => handleDelete(item.id)} className="rounded p-1 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredInventory.length > itemsPerPage && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-slate-500">Showing {Math.min((currentPage - 1) * itemsPerPage + 1, filteredInventory.length)} to {Math.min(currentPage * itemsPerPage, filteredInventory.length)} of {filteredInventory.length} items</div>
          <div className="flex gap-2">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
              <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(filteredInventory.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(filteredInventory.length / itemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
          </div>
        </div>
      )}

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Edit Inventory Item" : "Add Inventory Item"}>
        <div className="flex flex-col h-[70vh]">
            {/* Tabs */}
            <div className="flex border-b mb-4 overflow-x-auto">
                {[
                    { id: 'general', label: 'General', icon: Box },
                    { id: 'composition', label: 'Composition', icon: Layers },
                    { id: 'suppliers', label: 'Suppliers', icon: Users },
                    (can(role, 'inventory', 'view_rates') ? { id: 'commercial', label: 'Commercial', icon: DollarSign } : null),
                    { id: 'logistics', label: 'Logistics', icon: Truck },
                    { id: 'specs', label: 'Tech Specs', icon: Settings },
                    { id: 'maintenance', label: 'Maintenance', icon: Hammer },
                ].filter(Boolean).map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === tab.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                    >
                        <tab.icon size={16} /> {tab.label}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                {activeTab === 'general' && (() => {
                    const totalQty = parseInt(formData.total) || 0;
                    const serialCount = (formData.serial_details || []).length;
                    return (
                    <div className="space-y-4">
                        {/* Item Type Toggle */}
                        <div>
                            <label className="block text-xs font-bold text-slate-700 mb-1">Item Type</label>
                            <div className="flex gap-2">
                                {['Equipment', 'Service'].map(t => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => setFormData({...formData, item_type: t})}
                                        className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${formData.item_type === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:border-indigo-400'}`}
                                    >{t}</button>
                                ))}
                            </div>
                            {formData.item_type === 'Service' && (
                                <p className="text-xs text-slate-500 mt-1">Service items (internet, outsourced services) can be allocated to projects without physical tracking.</p>
                            )}
                        </div>
                        {/* Row 1: Asset ID + Item Name */}
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Asset ID / Barcode', 'asset_id', 'text', 'Scan Code')}
                            {renderField('Item Name / Model', 'name')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Brand / Manufacturer', 'brand')}
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1">Category</label>
                                <input className="w-full rounded border p-2 text-sm text-black bg-white" value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})} list="categories" />
                                <datalist id="categories">{categories.map(cat => <option key={cat} value={cat} />)}</datalist>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Sub-Category', 'sub_category')}
                            {renderField('Location', 'location')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-black mb-1">Total Qty</label>
                                <input
                                    type="number"
                                    min="0"
                                    className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800"
                                    value={formData.total}
                                    onChange={e => {
                                        const newQty = parseInt(e.target.value) || 0;
                                        if (newQty < serialCount && serialCount > 0) {
                                            setRemovePickerModal({ isOpen: true, newQty, pendingRemove: new Set() });
                                        } else {
                                            setFormData({ ...formData, total: e.target.value });
                                        }
                                    }}
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1">Status</label>
                                <select className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800" value={formData.status} onChange={e => setFormData({...formData, status: e.target.value})}>
                                    <option>Available</option><option>Rented</option><option>In Repair</option><option>Lost/Stolen</option><option>Retired</option>
                                </select>
                            </div>
                        </div>

                        {/* ===== SERIAL DETAILS MANAGER ===== */}
                        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                            {/* Header */}
                            <div className="flex items-center justify-between p-2.5 bg-slate-50 border-b border-slate-200">
                                <div className="flex items-center gap-2">
                                    <Tag size={13} className="text-indigo-600" />
                                    <span className="text-xs font-bold text-slate-700">Serial Details</span>
                                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${serialCount > 0 && totalQty > 0 && serialCount >= totalQty ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                                        {serialCount} / {totalQty}
                                    </span>
                                </div>
                                <div className="flex gap-1.5 flex-wrap justify-end">
                                    {selectedForPrint.size > 0 && (
                                        <button
                                            onClick={() => printSerialLabels(formData.name, (formData.serial_details || []).filter((_, i) => selectedForPrint.has(i)))}
                                            className="flex items-center gap-1 text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                                        >
                                            <Printer size={11} /> Print ({selectedForPrint.size})
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setAutoGen(a => ({ ...a, visible: !a.visible }))}
                                        className={`flex items-center gap-1 text-xs px-2 py-1 rounded border ${autoGen.visible ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'}`}
                                    >
                                        <ChevronDown size={11} /> Auto-Gen
                                    </button>
                                    <button
                                        disabled={totalQty > 0 && serialCount >= totalQty}
                                        onClick={() => {
                                            if (totalQty === 0) { notify('Set Total Qty first.', 'error'); return; }
                                            setFormData({ ...formData, serial_details: [...(formData.serial_details || []), { serial: '', purchase_date: '', invoice_no: '', warranty_start: '', warranty_end: '' }] });
                                        }}
                                        className="flex items-center gap-1 text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Plus size={11} /> Add
                                    </button>
                                </div>
                            </div>

                            {/* Auto-generate bar */}
                            {autoGen.visible && (
                                <div className="p-3 bg-indigo-50 border-b border-indigo-100">
                                    <div className="flex flex-wrap gap-3 items-end">
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Prefix</label>
                                            <input className="w-20 rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" value={autoGen.prefix} onChange={e => setAutoGen({ ...autoGen, prefix: e.target.value })} placeholder="SN-" />
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Suffix</label>
                                            <input className="w-20 rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" value={autoGen.suffix} onChange={e => setAutoGen({ ...autoGen, suffix: e.target.value })} placeholder="-26" />
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Start #</label>
                                            <input type="number" className="w-16 rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" value={autoGen.startFrom} onChange={e => setAutoGen({ ...autoGen, startFrom: parseInt(e.target.value) || 1 })} />
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-500 mb-0.5">Preview</label>
                                            <div className="text-xs text-indigo-700 font-mono bg-white border border-indigo-200 rounded px-2 py-1">{autoGen.prefix}{autoGen.startFrom}{autoGen.suffix}</div>
                                        </div>
                                        <button onClick={handleAutoGenerate} disabled={totalQty === 0} className="bg-indigo-600 text-white text-xs px-3 py-1.5 rounded hover:bg-indigo-700 disabled:opacity-40 font-medium">
                                            Generate All
                                        </button>
                                        <p className="text-[10px] text-slate-500 w-full mt-0">Fills empty slots up to Total Qty. Existing serials preserved.</p>
                                    </div>
                                </div>
                            )}

                            {/* Serial table */}
                            {serialCount > 0 ? (
                                <div className="overflow-x-auto max-h-56 overflow-y-auto">
                                    <table className="w-full text-xs min-w-[620px]">
                                        <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                                            <tr>
                                                <th className="p-2 w-8 text-center">
                                                    <input type="checkbox"
                                                        checked={selectedForPrint.size === serialCount && serialCount > 0}
                                                        onChange={e => setSelectedForPrint(e.target.checked ? new Set((formData.serial_details || []).map((_, i) => i)) : new Set())}
                                                        className="accent-indigo-600" title="Select all for print"
                                                    />
                                                </th>
                                                <th className="p-2 w-6 text-slate-400 font-medium text-center">#</th>
                                                <th className="p-2 text-left text-slate-500 font-medium">Serial No. *</th>
                                                <th className="p-2 text-left text-slate-500 font-medium">Purchase Date</th>
                                                <th className="p-2 text-left text-slate-500 font-medium">Invoice No.</th>
                                                <th className="p-2 text-left text-slate-500 font-medium">Warranty Start</th>
                                                <th className="p-2 text-left text-slate-500 font-medium">Warranty End</th>
                                                <th className="p-2 w-7"></th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {(formData.serial_details || []).map((det, idx) => (
                                                <tr key={idx} className="hover:bg-slate-50">
                                                    <td className="p-1 text-center">
                                                        <input type="checkbox"
                                                            checked={selectedForPrint.has(idx)}
                                                            onChange={e => {
                                                                const next = new Set(selectedForPrint);
                                                                e.target.checked ? next.add(idx) : next.delete(idx);
                                                                setSelectedForPrint(next);
                                                            }}
                                                            className="accent-indigo-600"
                                                        />
                                                    </td>
                                                    <td className="p-1 text-center text-slate-400 font-mono">{idx + 1}</td>
                                                    <td className="p-1">
                                                        <input
                                                            className={`w-full rounded border p-1 text-xs text-slate-800 bg-white ${!det.serial ? 'border-red-300 bg-red-50' : 'border-slate-300'}`}
                                                            placeholder="Serial No."
                                                            value={det.serial}
                                                            onChange={e => updateSerialDetail(idx, 'serial', e.target.value)}
                                                        />
                                                    </td>
                                                    <td className="p-1">
                                                        <input type="date" className="w-full rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" value={det.purchase_date} onChange={e => updateSerialDetail(idx, 'purchase_date', e.target.value)} />
                                                    </td>
                                                    <td className="p-1">
                                                        <input className="w-full rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" placeholder="INV-001" value={det.invoice_no} onChange={e => updateSerialDetail(idx, 'invoice_no', e.target.value)} />
                                                    </td>
                                                    <td className="p-1">
                                                        <input type="date" className="w-full rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" value={det.warranty_start} onChange={e => updateSerialDetail(idx, 'warranty_start', e.target.value)} />
                                                    </td>
                                                    <td className="p-1">
                                                        <input type="date" className="w-full rounded border border-slate-300 p-1 text-xs text-slate-800 bg-white" value={det.warranty_end} onChange={e => updateSerialDetail(idx, 'warranty_end', e.target.value)} />
                                                    </td>
                                                    <td className="p-1 text-center">
                                                        <button onClick={() => removeSerialDetail(idx)} className="text-red-400 hover:text-red-600 p-0.5 rounded hover:bg-red-50">
                                                            <X size={12} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <div className="p-5 text-center text-xs text-slate-400 italic">
                                    No serials added. Set Total Qty, then click <strong>+ Add</strong> or use <strong>Auto-Gen</strong>.
                                </div>
                            )}
                        </div>
                        {/* END SERIAL DETAILS MANAGER */}

                        {/* External / Cross-Hired */}
                        <div className="flex items-center gap-2 mt-2 p-3 bg-slate-50 rounded border border-slate-200">
                            <input type="checkbox" id="is-external-inventory" checked={formData.is_external} onChange={e => setFormData({...formData, is_external: e.target.checked})} className="w-4 h-4 cursor-pointer accent-indigo-600" />
                            <label htmlFor="is-external-inventory" className="text-sm font-bold text-slate-700 cursor-pointer">Is External / Cross-Hired Item</label>
                        </div>
                        {/* version 3.3.0 vendors database addition: Vendor Selection */}
                        {formData.is_external && (
                            <div className="mt-2 pl-3 border-l-2 border-purple-200">
                                <label className="block text-xs font-bold text-slate-700 mb-1">Select Vendor (Owner)</label>
                                <select
                                    className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800"
                                    value={formData.vendor_id}
                                    onChange={e => setFormData({...formData, vendor_id: e.target.value})}
                                >
                                    <option value="">-- Generic / Unknown --</option>
                                    {clients.filter(c => c.type === 'Vendor' || c.type === 'Both').map(v => (
                                        <option key={v.id} value={v.id}>{v.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>
                    );
                })()}

                {activeTab === 'composition' && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 p-3 bg-slate-50 rounded border border-slate-200">
                            <input type="checkbox" id="is-composite-inventory" checked={formData.is_composite} onChange={e => setFormData({...formData, is_composite: e.target.checked})} className="w-4 h-4 cursor-pointer accent-indigo-600" />
                            <label htmlFor="is-composite-inventory" className="text-sm font-bold text-slate-700 cursor-pointer">Is Composite Item (Kit/Bundle)</label>
                        </div>
                        {formData.is_composite && (
                            <div className="border rounded p-3 bg-white">
                              <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">Components</h4>
                                <div className="space-y-2 mb-3">
                                    {(formData.composition || []).map((comp, idx) => {
                                        const compItem = inventory.find(i => i.id === comp.item_id);
                                        return (
                                            <div key={idx} className="flex justify-between items-center bg-slate-50 p-2 rounded border border-slate-200">
                                                <div className="text-sm">
                                                    <span className="font-bold text-slate-800">{compItem?.name || 'Unknown'}</span>
                                                    <span className="text-slate-500 mx-2">x</span>
                                                    <span className="font-bold">{comp.qty}</span>
                                                </div>
                                                <button onClick={() => removeComponent(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14}/></button>
                                            </div>
                                        );
                                    })}
                                    {(formData.composition || []).length === 0 && <div className="text-sm text-slate-400 italic">No components added.</div>}
                                </div>
                                <div className="flex gap-2 items-end border-t pt-3">
                                    <div className="flex-1">
                                        <label className="text-xs font-bold text-slate-700">Add Item</label>
                                        <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800" value={compForm.item_id} onChange={e => setCompForm({...compForm, item_id: e.target.value})}>
                                            <option value="">-- Select --</option>
                                            {inventory.filter(i => i.id !== editingId && !i.is_composite).map(i => (
                                                <option key={i.id} value={i.id}>{i.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="w-20">
                                        <label className="text-xs font-bold text-slate-700">Qty</label>
                                        <input type="number" className="w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800" value={compForm.qty} onChange={e => setCompForm({...compForm, qty: e.target.value})} />
                                    </div>
                                    <button onClick={addComponent} className="bg-indigo-600 text-white px-3 py-1.5 rounded text-sm hover:bg-indigo-700">Add</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'suppliers' && (
                    <div className="space-y-4">
                        <div className="bg-blue-50 p-3 rounded text-xs text-blue-700 mb-2">
                            Manage approved vendors who supply this item (e.g. different brands/specs).
                        </div>
                        {/* List of suppliers */}
                        <div className="space-y-2">
                            {(formData.suppliers || []).map((sup, idx) => (
                                <div key={idx} className="flex justify-between items-center bg-slate-50 p-2 rounded border border-slate-200">
                                    <div className="text-sm">
                                        <div className="font-bold text-slate-800">
                                            {clients.find(c => c.id === sup.vendor_id)?.name || 'Unknown Vendor'}
                                        </div>
                                        <div className="text-xs text-slate-500">
                                            {sup.brand && <span>Brand: {sup.brand} | </span>}
                                            {sup.spec && <span>Spec: {sup.spec}</span>}
                                            {can(role, 'inventory', 'view_rates') && <span> | Rate: {sup.rate}</span>}
                                        </div>
                                    </div>
                                    <button onClick={() => removeSupplier(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14}/></button>
                                </div>
                            ))}
                            {(formData.suppliers || []).length === 0 && <div className="text-sm text-slate-400 italic">No suppliers linked.</div>}
                        </div>

                        {/* Add Supplier Form */}
                        <div className="border-t pt-3 mt-2">
                            <h4 className="text-xs font-bold text-slate-700 mb-2">Add Supplier Option</h4>
                            <div className="grid grid-cols-2 gap-2 mb-2">
                                <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800" value={supplierForm.vendor_id} onChange={e => setSupplierForm({...supplierForm, vendor_id: e.target.value})}>
                                    <option value="">-- Select Vendor --</option>
                                    {clients.filter(c => c.type === 'Vendor' || c.type === 'Both').map(v => (
                                        <option key={v.id} value={v.id}>{v.name}</option>
                                    ))}
                                </select>
                                <input className="w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800" placeholder="Brand / Model" value={supplierForm.brand} onChange={e => setSupplierForm({...supplierForm, brand: e.target.value})} />
                                <input className="w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800" placeholder="Size / Color / Spec" value={supplierForm.spec} onChange={e => setSupplierForm({...supplierForm, spec: e.target.value})} />
                                <input type="number" className="w-full rounded border border-slate-300 p-1.5 text-sm text-slate-800" placeholder="Rate" value={supplierForm.rate} onChange={e => setSupplierForm({...supplierForm, rate: e.target.value})} />
                            </div>
                            <button onClick={addSupplier} className="bg-indigo-600 text-white px-3 py-1.5 rounded text-sm hover:bg-indigo-700 w-full">Add Supplier Option</button>
                        </div>
                    </div>
                )}

                {activeTab === 'commercial' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Daily Rate', 'rate_per_day', 'number')}
                            {renderField('Weekly Rate', 'rate_per_week', 'number')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Purchase Cost', 'purchase_cost', 'number')}
                            {renderField('Purchase Date', 'purchase_date', 'date')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Replacement Value', 'replacement_value', 'number')}
                            {renderField('Supplier / Vendor', 'supplier')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('GST Rate %', 'gst_rate', 'number')}
                            {renderField('HSN Code', 'hsn_code')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Reorder Level (qty)', 'reorder_level', 'number')}
                            <div></div>
                        </div>
                    </div>
                )}

                {activeTab === 'logistics' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Weight (kg)', 'weight', 'number')}
                            {renderField('Dimensions (LxWxH)', 'dimensions')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Power (Watts)', 'power_watts', 'number')}
                            {renderField('Current (Amps)', 'current_amps', 'number')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Connector Type', 'connector_type')}
                            {renderField('IP Rating', 'ip_rating')}
                        </div>
                    </div>
                )}

                {activeTab === 'specs' && (
                    <div className="space-y-4">
                        <div className="bg-blue-50 p-3 rounded text-xs text-blue-700 mb-2">
                            Specific attributes for <strong>{formData.category || 'General'}</strong> items.
                        </div>

                        {/* Audio Fields */}
                        {(formData.category === 'Sound' || formData.category === 'Audio') && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-slate-700">Signal Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 placeholder-slate-400" value={formData.attributes.signal_type || ''} onChange={e => updateAttribute('signal_type', e.target.value)} placeholder="Analog, Dante..." /></div>
                                <div><label className="text-xs font-bold text-slate-700">Wireless Freq</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 placeholder-slate-400" value={formData.attributes.frequency || ''} onChange={e => updateAttribute('frequency', e.target.value)} placeholder="470-530 MHz" /></div>
                                <div><label className="text-xs font-bold text-slate-700">Channels</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 placeholder-slate-400" value={formData.attributes.channels || ''} onChange={e => updateAttribute('channels', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-slate-700">Mic Pattern</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 placeholder-slate-400" value={formData.attributes.pattern || ''} onChange={e => updateAttribute('pattern', e.target.value)} /></div>
                            </div>
                        )}

                        {/* Video Fields */}
                        {['Video', 'Projectors', 'LED', 'Camera'].includes(formData.category) && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-slate-700">Resolution</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 placeholder-slate-400" value={formData.attributes.resolution || ''} onChange={e => updateAttribute('resolution', e.target.value)} placeholder="1080p, 4K..." /></div>
                                <div><label className="text-xs font-bold text-slate-700">Lumens / Brightness</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 placeholder-slate-400" value={formData.attributes.lumens || ''} onChange={e => updateAttribute('lumens', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-slate-700">Inputs</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.inputs || ''} onChange={e => updateAttribute('inputs', e.target.value)} placeholder="HDMI, SDI..." /></div>
                                <div><label className="text-xs font-bold text-slate-700">Throw Ratio / Pitch</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.ratio || ''} onChange={e => updateAttribute('ratio', e.target.value)} /></div>
                            </div>
                        )}

                        {/* LED Tile Model Fields */}
                        {formData.category === 'LED' && (
                          <div className="border-t pt-4 mt-4">
                            <h4 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2"><Layers size={16} /> LED Tile Model Specifications</h4>
                            <div className="grid grid-cols-2 gap-3">
                              <div><label className="text-xs font-bold text-slate-700">Model Name</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.modelName || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), modelName: e.target.value}})} placeholder="e.g. P3.9-500x500" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Pixel Pitch (mm)</label><input type="number" step="0.1" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.pixelPitch || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), pixelPitch: parseFloat(e.target.value) || 0}})} placeholder="e.g. 3.9" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Width (mm)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.dimensions?.width_mm || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), dimensions: {...(formData.tile_model?.dimensions || {}), width_mm: parseInt(e.target.value) || 0}}})} placeholder="e.g. 500" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Height (mm)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.dimensions?.height_mm || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), dimensions: {...(formData.tile_model?.dimensions || {}), height_mm: parseInt(e.target.value) || 0}}})} placeholder="e.g. 500" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Depth (mm)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.dimensions?.depth_mm || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), dimensions: {...(formData.tile_model?.dimensions || {}), depth_mm: parseInt(e.target.value) || 0}}})} placeholder="e.g. 60" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Resolution Width (pixels)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.resolution?.pixelWidth || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), resolution: {...(formData.tile_model?.resolution || {}), pixelWidth: parseInt(e.target.value) || 0}}})} placeholder="e.g. 128" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Resolution Height (pixels)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.resolution?.pixelHeight || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), resolution: {...(formData.tile_model?.resolution || {}), pixelHeight: parseInt(e.target.value) || 0}}})} placeholder="e.g. 128" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Weight per Tile (kg)</label><input type="number" step="0.1" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.weight || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), weight: parseFloat(e.target.value) || 0}})} placeholder="e.g. 7.5" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Max Power (W)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.power?.maxPower || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), power: {...(formData.tile_model?.power || {}), maxPower: parseInt(e.target.value) || 0}}})} placeholder="e.g. 120" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Avg Power (W)</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.power?.avgPower || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), power: {...(formData.tile_model?.power || {}), avgPower: parseInt(e.target.value) || 0}}})} placeholder="e.g. 60" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Total Tiles Owned</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.inventory?.totalTiles || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), inventory: {...(formData.tile_model?.inventory || {}), totalTiles: parseInt(e.target.value) || 0}}})} placeholder="e.g. 200" /></div>
                              <div><label className="text-xs font-bold text-slate-700">Tiles per Flight Case</label><input type="number" className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800" value={formData.tile_model?.inventory?.tilesPerCase || ''} onChange={e => setFormData({...formData, tile_model: {...(formData.tile_model || {}), inventory: {...(formData.tile_model?.inventory || {}), tilesPerCase: parseInt(e.target.value) || 1}}})} placeholder="e.g. 4" /></div>
                            </div>
                          </div>
                        )}

                        {/* Lighting Fields */}
                        {formData.category === 'Lighting' && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-slate-700">Fixture Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.fixture_type || ''} onChange={e => updateAttribute('fixture_type', e.target.value)} placeholder="Spot, Wash..." /></div>
                                <div><label className="text-xs font-bold text-slate-700">DMX Mode</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.dmx_mode || ''} onChange={e => updateAttribute('dmx_mode', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-slate-700">Lamp Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.lamp_type || ''} onChange={e => updateAttribute('lamp_type', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-slate-700">Beam Angle</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.beam_angle || ''} onChange={e => updateAttribute('beam_angle', e.target.value)} /></div>
                            </div>
                        )}

                        {/* Rigging Fields */}
                        {['Trussing', 'Rigging'].includes(formData.category) && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-slate-700">Truss Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.truss_type || ''} onChange={e => updateAttribute('truss_type', e.target.value)} placeholder="Box, Triangle..." /></div>
                                <div><label className="text-xs font-bold text-slate-700">Length</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.length || ''} onChange={e => updateAttribute('length', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-slate-700">Connection</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.connection || ''} onChange={e => updateAttribute('connection', e.target.value)} placeholder="Spigot, Bolt..." /></div>
                                <div><label className="text-xs font-bold text-slate-700">Load Capacity</label><input className="w-full border border-slate-300 rounded p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" value={formData.attributes.load_capacity || ''} onChange={e => updateAttribute('load_capacity', e.target.value)} /></div>
                            </div>
                        )}

                        <div className="mt-4">
                            <label className="block text-xs font-bold text-slate-700 mb-1">Other Specifications</label>
                            <textarea className="w-full rounded border border-slate-300 p-2 text-sm bg-white text-slate-800 bg-slate-50 border-slate-200 placeholder-slate-400 placeholder-slate-4000" rows={3} value={formData.specifications} onChange={e => setFormData({...formData, specifications: e.target.value})} />
                        </div>
                    </div>
                )}

                {activeTab === 'maintenance' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-4">
                            {renderField('Last Service Date', 'last_service_date', 'date')}
                            {renderField('Next Test Due', 'next_test_due', 'date')}
                            {renderField('Service Interval (days)', 'service_interval_days', 'number')}
                        </div>
                        <p className="text-xs text-slate-400">Leave "Next Test Due" blank to auto-compute from Last Service Date + interval. Due/overdue items appear in the notification bell.</p>
                        <div>
                            <label className="block text-xs font-bold text-white text-slate-200 mb-1">Service History / Notes</label>
                            <textarea className="w-full rounded border border-slate-300 p-2 text-sm bg-white text-black bg-slate-50 border-slate-200 text-black placeholder-slate-400 placeholder-slate-4000" rows={4} value={formData.service_notes} onChange={e => setFormData({...formData, service_notes: e.target.value})} />
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 pt-4 border-t mt-2">
                <button onClick={() => setIsModalOpen(false)} className="rounded px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
                <button onClick={handleSave} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700">{editingId ? 'Update Item' : 'Create Item'}</button>
            </div>
        </div>
      </Modal>

      <InventoryCalendar
        isOpen={isCalendarOpen}
        onClose={() => setIsCalendarOpen(false)}
        inventory={inventory}
        projects={projects}
        clients={clients}
        initialItemId={calendarItemId}
      />

      {/* ===== REMOVE SERIAL PICKER MODAL ===== */}
      {removePickerModal.isOpen && (() => {
        const needToRemove = (formData.serial_details || []).length - removePickerModal.newQty;
        return (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
              <div className="p-4 border-b flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800">Select Serials to Remove</h3>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Reducing qty to <strong>{removePickerModal.newQty}</strong>.
                    Select exactly <strong className="text-red-600">{needToRemove}</strong> serial{needToRemove > 1 ? 's' : ''} to remove.
                  </p>
                </div>
                <button onClick={() => setRemovePickerModal({ isOpen: false, newQty: 0, pendingRemove: new Set() })} className="text-slate-400 hover:text-slate-600 p-1 rounded">
                  <X size={18} />
                </button>
              </div>
              <div className="p-4 max-h-64 overflow-y-auto space-y-2">
                {(formData.serial_details || []).map((det, idx) => (
                  <label key={idx} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${removePickerModal.pendingRemove.has(idx) ? 'bg-red-50 border-red-300' : 'bg-slate-50 border-slate-200 hover:border-slate-300'}`}>
                    <input
                      type="checkbox"
                      checked={removePickerModal.pendingRemove.has(idx)}
                      onChange={e => {
                        const next = new Set(removePickerModal.pendingRemove);
                        e.target.checked ? next.add(idx) : next.delete(idx);
                        setRemovePickerModal({ ...removePickerModal, pendingRemove: next });
                      }}
                      className="accent-red-500 w-4 h-4"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-800 truncate">{det.serial || <span className="italic text-slate-400">#{idx + 1} (no serial)</span>}</div>
                      <div className="text-xs text-slate-400 flex gap-3 flex-wrap">
                        {det.invoice_no && <span>Inv: {det.invoice_no}</span>}
                        {det.purchase_date && <span>{det.purchase_date}</span>}
                        {det.warranty_end && <span>Warranty till {det.warranty_end}</span>}
                      </div>
                    </div>
                    {removePickerModal.pendingRemove.has(idx) && <span className="text-xs text-red-500 font-bold shrink-0">REMOVE</span>}
                  </label>
                ))}
              </div>
              <div className="p-4 border-t flex items-center justify-between">
                <span className="text-xs text-slate-500">{removePickerModal.pendingRemove.size} of {needToRemove} selected</span>
                <div className="flex gap-2">
                  <button onClick={() => setRemovePickerModal({ isOpen: false, newQty: 0, pendingRemove: new Set() })} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded">
                    Cancel
                  </button>
                  <button
                    disabled={removePickerModal.pendingRemove.size !== needToRemove}
                    onClick={() => {
                      const remaining = (formData.serial_details || []).filter((_, i) => !removePickerModal.pendingRemove.has(i));
                      setFormData({ ...formData, total: removePickerModal.newQty, serial_details: remaining });
                      setRemovePickerModal({ isOpen: false, newQty: 0, pendingRemove: new Set() });
                      setSelectedForPrint(new Set());
                    }}
                    className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                  >
                    Confirm Remove
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm(prev => ({ ...prev, isOpen: false }))}
        onConfirm={deleteConfirm.onConfirm}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        requireTyped={true}
      />
    </div>
  );
};

const EditItemAllocationModal = ({ isOpen, onClose, item, onSave }) => {
  const [formData, setFormData] = useState(item || {});

  useEffect(() => {
    setFormData(item || {});
  }, [item]);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Allocated Item">
      <div className="space-y-4">
        <div>
          <label className="text-xs font-bold text-slate-700">Quantity</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-white"
            value={formData?.qty || ''}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Rate</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-black"
            value={formData?.rate || ''}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Days</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-black"
            value={formData?.days || ''}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Description</label>
          <input
            type="text"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-black"
            value={formData?.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
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

export default Inventory;
