import React, { useState, useEffect, useMemo } from 'react';
import { notify } from '../utils/toast';
import { Search, Printer, Edit, Trash2, Truck } from 'lucide-react';
import { updateDoc, doc, arrayRemove, arrayUnion, addDoc, collection, getDoc, runTransaction } from 'firebase/firestore';
import { formatCurrency, formatCurrencyPDF } from '../utils/helpers';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import { can } from '../utils/permissions';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const ChallanManager = ({ projects, clients, inventory, db, appId, logAction, user, role, currentEmpId = null }) => {
  // Challan pricing (Rate/Amount on the doc + PDF) is view_amounts-gated
  // (admin/accountant/manager); a manager additionally sees only their OWN
  // projects' challans — never another manager's client's priced challan.
  const canViewAmounts = can(role, 'challans', 'view_amounts');
  const scopedProjects = useMemo(
    () => (role === 'manager'
      ? (projects || []).filter(p => p.client_owner_id === currentEmpId || p.created_by === currentEmpId)
      : (projects || [])),
    [projects, role, currentEmpId],
  );
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' or 'desc'
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingChallan, setEditingChallan] = useState(null);
  const [challanForm, setChallanForm] = useState({});
  const [challanSelection, setChallanSelection] = useState({});
  const [challanSerials, setChallanSerials] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  const allChallans = useMemo(() => {
    const list = [];
    scopedProjects.forEach(p => {
      if (p.challans && p.challans.length > 0) {
        p.challans.forEach(c => {
          list.push({
            ...c,
            projectId: p.id,
            projectName: p.project_name,
            clientId: p.client_id,
            clientName: clients.find(cl => cl.id === p.client_id)?.name || 'Unknown'
          });
        });
      }
    });
    return list.filter(c =>
      (c.challan_no || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.clientName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.projectName || '').toLowerCase().includes(searchTerm.toLowerCase())
    ).sort((a, b) => {
      const valA = a.challan_no || '';
      const valB = b.challan_no || '';
      return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });
  }, [scopedProjects, clients, sortOrder, searchTerm]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, sortOrder]);

  const paginatedChallans = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return allChallans.slice(start, start + itemsPerPage);
  }, [allChallans, currentPage]);

  const targetProject = useMemo(() =>
    editingChallan ? projects.find(p => p.id === editingChallan.projectId) : null
  , [projects, editingChallan]);

  const getOrgSettings = async () => {
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (docSnap.exists()) return docSnap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const getChallanedQty = (project, allocationId, type, excludeChallanId = null) => {
    return (project.challans || [])
        .filter(c => c.type === type && c.id !== excludeChallanId)
        .reduce((acc, c) => {
            const item = c.items.find(i => i.id === allocationId);
            return acc + (item ? (parseInt(item.qty) || 0) : 0);
        }, 0);
  };

  const handleDelete = async (challan) => {
    if (!can(role, 'challans', 'delete')) return notify('Access denied: only Admin can delete challans.', 'error');
    setDeleteConfirm({
      isOpen: true,
      title: `Delete Challan ${challan.challan_no}`,
      message: `Are you sure you want to delete Challan ${challan.challan_no} for project "${challan.projectName}"? This cannot be undone.`,
      onConfirm: async () => {
        try {
            const project = projects.find(p => p.id === challan.projectId);
            if (!project) return;

            // H-14: read-modify-write under transaction so concurrent edits
            // can't undo the deletion silently.
            const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', challan.projectId);
            await runTransaction(db, async (transaction) => {
                const projectDoc = await transaction.get(projectRef);
                if (!projectDoc.exists()) throw new Error('Project not found');
                const existing = Array.isArray(projectDoc.data().challans) ? projectDoc.data().challans : [];
                const next = existing.filter(c => c.id !== challan.id);
                transaction.update(projectRef, { challans: next });
            });
            logAction('projects', 'delete_challan', challan.projectId, { challan_no: challan.challan_no }, project.project_name);

            // H-3: reversal inventory_movements rows.
            try {
                const reverseDir = challan.type === 'delivery' ? 'in' : 'out';
                const ts = new Date().toISOString();
                await Promise.all(
                    (challan.items || [])
                        .filter(i => i.item_id)
                        .map(i => addDoc(
                            collection(db, 'artifacts', appId, 'public', 'data', 'inventory_movements'),
                            {
                                item_id: i.item_id,
                                item_name: i.item_name || '',
                                qty: parseInt(i.qty) || 0,
                                direction: reverseDir,
                                challan_id: challan.id,
                                challan_no: challan.challan_no,
                                challan_type: challan.type,
                                project_id: challan.projectId,
                                project_name: project.project_name,
                                client_id: project.client_id || null,
                                date: challan.date,
                                reversal: true,
                                recorded_at: ts,
                            }
                        ))
                );
            } catch (mvErr) {
                console.warn('inventory_movements reversal write failed (non-fatal):', mvErr.message);
            }
        } catch(e) {
            console.error(e);
            notify("Failed to delete challan", 'error');
        }
      }
    });
  };

  const openEditModal = (challan) => {
    setEditingChallan(challan);
    setChallanForm({
        ...(challan.transport || {}),
        date: challan.date ? new Date(challan.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
    });

    const initialSelection = {};
    const project = projects.find(p => p.id === challan.projectId);
    if (project) {
        (project.items || []).forEach(item => {
            const existing = challan.items.find(i => i.id === item.id);
            initialSelection[item.id] = existing ? existing.qty : 0;
        });
    }
    setChallanSelection(initialSelection);
    setIsEditOpen(true);
  };

  const handleSaveChallan = async () => {
    if (!can(role, 'challans', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if (!targetProject) return;
    const itemsToShip = [];

    for (const item of (targetProject.items || [])) {
        const qty = parseInt(challanSelection[item.id] || 0);
        if (qty > 0) {
            const excludeId = editingChallan.id;
            const alreadyChallaned = getChallanedQty(targetProject, item.id, editingChallan.type, excludeId);

            let maxQty = 0;
            if (editingChallan.type === 'delivery') {
                maxQty = item.qty - alreadyChallaned;
            } else {
                const delivered = getChallanedQty(targetProject, item.id, 'delivery');
                const returned = getChallanedQty(targetProject, item.id, 'return', excludeId);
                maxQty = delivered - returned;
            }

            if (qty > maxQty) {
                notify(`Error: Item "${item.item_name}" exceeds available quantity. Max: ${maxQty}, Requested: ${qty}`, 'error');
                return;
            }
            itemsToShip.push({ ...item, qty, serial_numbers: challanSerials[item.id] || [] });
        }
    }

    if (itemsToShip.length === 0) return notify("Please select at least one item.", 'error');

    try {
        const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', targetProject.id);

        // H-14: single-transaction read-modify-write over the challans array.
        const updatedChallan = await runTransaction(db, async (transaction) => {
            const projectDoc = await transaction.get(projectRef);
            if (!projectDoc.exists()) throw new Error('Project not found');
            const existing = Array.isArray(projectDoc.data().challans) ? projectDoc.data().challans : [];
            const original = existing.find(c => c.id === editingChallan.id);
            if (!original) throw new Error('Challan no longer exists. Reload and try again.');
            const record = {
                ...original,
                items: itemsToShip,
                transport: challanForm,
                date: new Date(challanForm.date).toISOString(),
                updated_at: new Date().toISOString(),
            };
            const next = existing.map(c => c.id === editingChallan.id ? record : c);
            transaction.update(projectRef, { challans: next });
            return record;
        });

        logAction('projects', 'update_challan', targetProject.id, { challan_no: updatedChallan.challan_no }, targetProject.project_name);

        // H-3: edit-event inventory_movements row (final qty replaces prior).
        try {
            const direction = updatedChallan.type === 'delivery' ? 'out' : 'in';
            const ts = new Date().toISOString();
            await Promise.all(
                itemsToShip
                    .filter(i => i.item_id)
                    .map(i => addDoc(
                        collection(db, 'artifacts', appId, 'public', 'data', 'inventory_movements'),
                        {
                            item_id: i.item_id,
                            item_name: i.item_name || '',
                            qty: parseInt(i.qty) || 0,
                            direction,
                            challan_id: updatedChallan.id,
                            challan_no: updatedChallan.challan_no,
                            challan_type: updatedChallan.type,
                            project_id: targetProject.id,
                            project_name: targetProject.project_name,
                            client_id: targetProject.client_id || null,
                            date: updatedChallan.date,
                            edit: true,
                            recorded_at: ts,
                        }
                    ))
            );
        } catch (mvErr) {
            console.warn('inventory_movements edit write failed (non-fatal):', mvErr.message);
        }

        setIsEditOpen(false);
        setEditingChallan(null);
    } catch (e) {
        console.error(e);
        notify(`Error saving challan: ${e.message}`, 'error');
    }
  };

  const printChallanPDF = async (challanData) => {
    try {
        const pdfDoc = new jsPDF();
        const pageWidth = pdfDoc.internal.pageSize.width;
        const orgSettings = await getOrgSettings();
        const isReturn = challanData.type === 'return';
        const displayChallanNo = isReturn ? `RET/${challanData.challan_no}` : challanData.challan_no;
        const todayStr = new Date(challanData.date).toLocaleDateString('en-IN');

        let y = 15;
        if (orgSettings?.logo) {
            try {
                pdfDoc.addImage(orgSettings.logo, 'JPEG', 14, 10, 25, 25);
            } catch (e) { console.warn("Logo add failed", e); }
        }

        pdfDoc.setFontSize(16);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(orgSettings?.name || "RENTAL OPS", 45, 18);

        pdfDoc.setFontSize(9);
        pdfDoc.setFont("helvetica", "normal");
        const addrLines = pdfDoc.splitTextToSize(orgSettings?.address || "", 100);
        pdfDoc.text(addrLines, 45, 24);

        let headerY = 24 + (addrLines.length * 4);
        if (orgSettings?.gstin) pdfDoc.text(`GSTIN: ${orgSettings.gstin}`, 45, headerY);
        if (orgSettings?.pan) pdfDoc.text(`PAN: ${orgSettings.pan}`, 100, headerY);

        y = Math.max(y + 25, headerY + 10);

        pdfDoc.setFontSize(14);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "RETURN CHALLAN" : "DELIVERY CHALLAN", pageWidth - 14, 20, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(isReturn ? "(Material Returning from Project)" : "(Authority to carry inventory for Project Execution)", pageWidth - 14, 25, { align: 'right' });

        pdfDoc.setFontSize(10);
        pdfDoc.text(`Challan No: ${displayChallanNo}`, pageWidth - 14, 32, { align: 'right' });
        pdfDoc.text(`Date: ${todayStr}`, pageWidth - 14, 37, { align: 'right' });

        pdfDoc.setLineWidth(0.5); pdfDoc.line(14, y, pageWidth - 14, y);
        y += 5;

        let client = null;
        let project = null;

        if (challanData.clientId) {
             client = clients.find(c => c.id === challanData.clientId);
             const p = projects.find(p => p.id === challanData.projectId);
             if (p) project = p;
             else project = { project_name: challanData.projectName, venue: 'Unknown' };
        } else if (targetProject) {
             client = clients.find(c => c.id === targetProject.client_id);
             project = targetProject;
        }

        pdfDoc.setFontSize(10);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "Received From (Client):" : "Consignee (Client):", 14, y);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(client?.name || '-', 14, y + 5);
        const clientAddr = pdfDoc.splitTextToSize(client?.address || "Address not available", 80);
        pdfDoc.text(clientAddr, 14, y + 10);
        if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, 14, y + 10 + (clientAddr.length * 4) + 2);

        pdfDoc.text(`Project: ${project?.project_name || '-'}`, 110, y);
        pdfDoc.text(`Venue: ${project?.venue || '-'}`, 110, y + 5);
        pdfDoc.text(isReturn ? `Return To: ${orgSettings?.address ? 'Warehouse / Office' : 'Warehouse'}` : `Dispatch To: ${challanData.transport?.dispatch_address || project?.venue || '-'}`, 110, y + 10);

        y = Math.max(y + 25, y + 10 + (clientAddr.length * 4) + 10);

        const transport = challanData.transport || {};
        pdfDoc.rect(14, y, pageWidth - 28, 18);
        pdfDoc.setFontSize(9);
        pdfDoc.text(`Transport Mode: ${transport.mode || '-'}`, 16, y + 6);
        pdfDoc.text(`Vehicle No: ${transport.vehicle_no || '-'}`, 80, y + 6);
        pdfDoc.text(`E-Way Bill: ${transport.eway_bill || '-'}`, 150, y + 6);
        pdfDoc.text(`Driver: ${transport.driver_name || '-'} (${transport.driver_mobile || '-'})`, 16, y + 12);

        y += 25;
        const items = (challanData.items || []).map((i, idx) => {
            const invItem = inventory.find(inv => inv.id === i.item_id);
            let snText = invItem?.serial_number || '-';
            if (i.serial_numbers && i.serial_numbers.length > 0) {
                snText = i.serial_numbers.join(', ');
            }
            const base = [
                idx + 1,
                `${i.item_name}\nSN: ${snText}`,
                invItem?.hsn_code || '-',
                i.qty,
                `${i.days} Days`,
            ];
            // Pricing columns only for roles allowed to see challan amounts.
            return canViewAmounts ? [...base, formatCurrencyPDF(i.rate), formatCurrencyPDF(i.total)] : base;
        });

        autoTable(pdfDoc, {
            startY: y,
            head: [canViewAmounts
                ? ['#', 'Description of Goods', 'HSN/SAC', 'Qty', 'Duration', 'Rate', 'Amount']
                : ['#', 'Description of Goods', 'HSN/SAC', 'Qty', 'Duration']],
            body: items,
            theme: 'grid',
            margin: { left: 14, right: 14 },
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
            headStyles: { fillColor: [50, 50, 50], textColor: 255 },
            columnStyles: {
                0: { cellWidth: 8 },
                1: { cellWidth: 58 },
                2: { cellWidth: 14 },
                3: { cellWidth: 10, halign: 'center' },
                4: { cellWidth: 14, halign: 'center' },
                5: { cellWidth: 18, halign: 'right' },
                6: { cellWidth: 54, halign: 'right', cellPadding: { top: 2, bottom: 2, left: 2, right: 10 } }
            }
        });

        let finalY = ((pdfDoc.lastAutoTable && pdfDoc.lastAutoTable.finalY) || y + 50) + 10;

        if (orgSettings?.challan_terms) {
            pdfDoc.setFontSize(9);
            pdfDoc.setFont("helvetica", "bold");
            pdfDoc.text("Terms & Conditions:", 14, finalY);
            pdfDoc.setFont("helvetica", "normal");
            pdfDoc.setFontSize(8);
            const terms = pdfDoc.splitTextToSize(orgSettings.challan_terms, pageWidth - 28);
            pdfDoc.text(terms, 14, finalY + 5);
            finalY += 10 + (terms.length * 3.5);
        }

        pdfDoc.setFontSize(8);
        pdfDoc.text("Declaration:", 14, finalY);
        pdfDoc.text(isReturn ? "1. Material returning from project site to warehouse." : "1. The goods are being transported for project execution purpose only and not for sale.", 14, finalY + 5);
        pdfDoc.text(isReturn ? "2. Not for sale." : "2. The goods will be returned to the consignor after completion of the project.", 14, finalY + 9);

        pdfDoc.setLineWidth(0.5);
        pdfDoc.line(14, finalY + 25, 80, finalY + 25);
        pdfDoc.text("Authorized Signatory", 14, finalY + 30);
        pdfDoc.text(`For ${orgSettings?.name || 'Company'}`, 14, finalY + 34);

        pdfDoc.line(pageWidth - 90, finalY + 25, pageWidth - 14, finalY + 25);
        pdfDoc.text(isReturn ? "Sender's Signature (Client)" : "Receiver's Signature & Stamp", pageWidth - 90, finalY + 30);

        pdfDoc.save(`${isReturn ? 'Return' : 'Delivery'}_Challan_${displayChallanNo.replace('/','-')}.pdf`);
    } catch (error) {
        console.error("Challan PDF Error:", error);
        notify("Failed to generate Challan PDF. See console for details.", 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Challan Manager</h2>
        <div className="flex gap-2 w-full md:w-auto">
            <div className="flex items-center rounded border px-3 py-1 bg-white flex-1">
                <Search size={16} className="text-slate-400 mr-2" />
                <input placeholder="Search challans..." className="text-sm outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
            <button onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')} className="flex items-center justify-center gap-2 rounded border px-3 py-1 bg-white text-sm hover:bg-slate-50 whitespace-nowrap">
                Sort: {sortOrder === 'asc' ? 'Ascending' : 'Descending'}
            </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-700 font-semibold">
            <tr>
              <th className="p-4 font-medium">Challan No</th>
              <th className="p-4 font-medium">Date</th>
              <th className="p-4 font-medium">Type</th>
              <th className="p-4 font-medium">Project</th>
              <th className="p-4 font-medium">Client</th>
              <th className="p-4 font-medium text-center">Items</th>
              <th className="p-4 font-medium text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginatedChallans.map((c, idx) => (
              <tr key={idx} className="hover:bg-slate-50">
                <td className="p-4 font-bold text-slate-800">{c.challan_no}</td>
                <td className="p-4 text-slate-600">{new Date(c.date).toLocaleDateString()}</td>
                <td className="p-4"><span className={`px-2 py-1 rounded text-xs font-bold ${c.type === 'return' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>{c.type.toUpperCase()}</span></td>
                <td className="p-4 text-slate-800">{c.projectName}</td>
                <td className="p-4 text-slate-600">{c.clientName}</td>
                <td className="p-4 text-center">{c.items?.length || 0}</td>
                <td className="p-4 text-center">
                    <div className="flex items-center justify-center gap-2">
                        <button onClick={() => printChallanPDF(c)} className="p-1 text-indigo-600 hover:bg-indigo-50 rounded" title="Print"><Printer size={16}/></button>
                        <button onClick={() => openEditModal(c)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit"><Edit size={16}/></button>
                        <button onClick={() => handleDelete(c)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 size={16}/></button>
                    </div>
                </td>
              </tr>
            ))}
            {paginatedChallans.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-slate-400">No challans found.</td></tr>}
          </tbody>
        </table>
        {allChallans.length > 0 && (
          <div className="flex items-center justify-between p-4 border-t bg-slate-50">
            <div className="text-sm text-slate-500">
              Showing {Math.min((currentPage - 1) * itemsPerPage + 1, allChallans.length)} to {Math.min(currentPage * itemsPerPage, allChallans.length)} of {allChallans.length} results
            </div>
            <div className="flex gap-2">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
              <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(allChallans.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(allChallans.length / itemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} title={`Edit ${editingChallan?.type === 'return' ? 'Return' : 'Delivery'} Challan`}>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs font-bold text-slate-700">Transport Mode</label><select className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.mode} onChange={e => setChallanForm({ ...challanForm, mode: e.target.value })}><option>Road</option><option>Air</option><option>Train</option><option>Hand Carry</option></select></div>
                <div><label className="text-xs font-bold text-slate-700">Vehicle No</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.vehicle_no} onChange={e => setChallanForm({ ...challanForm, vehicle_no: e.target.value })} placeholder="MH-01-AB-1234" /></div>
                <div><label className="text-xs font-bold text-slate-700">Driver Name</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.driver_name} onChange={e => setChallanForm({ ...challanForm, driver_name: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-700">Driver Mobile</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.driver_mobile} onChange={e => setChallanForm({ ...challanForm, driver_mobile: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-700">E-Way Bill No</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.eway_bill} onChange={e => setChallanForm({ ...challanForm, eway_bill: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-700">Dispatch Address</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.dispatch_address} onChange={e => setChallanForm({ ...challanForm, dispatch_address: e.target.value })} placeholder="Leave empty for Venue" /></div>
                <div><label className="text-xs font-bold text-slate-700">Challan Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-black" value={challanForm.date} onChange={e => setChallanForm({ ...challanForm, date: e.target.value })} /></div>
              </div>

              <div className="border-t pt-4">
                <h4 className="text-sm font-bold text-slate-700 mb-2">Select Items to Include</h4>
                <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs text-left text-slate-600">
                        <thead className="bg-slate-50 text-slate-500"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Total</th><th className="p-2 text-center">{editingChallan?.type === 'delivery' ? 'Sent' : 'Returned'}</th><th className="p-2 text-center">Avail</th><th className="p-2 w-20">Current</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                            {(targetProject?.items || []).map(item => {
                                const excludeId = editingChallan ? editingChallan.id : null;
                                const invItem = inventory.find(inv => inv.id === item.item_id);
                                const availableSerials = invItem?.serial_numbers || [];
                                const alreadyChallaned = getChallanedQty(targetProject, item.id, editingChallan?.type, excludeId);
                                let maxQty = 0;
                                if (editingChallan?.type === 'delivery') maxQty = item.qty - alreadyChallaned;
                                else {
                                    const delivered = getChallanedQty(targetProject, item.id, 'delivery');
                                    const returned = getChallanedQty(targetProject, item.id, 'return', excludeId);
                                    maxQty = delivered - returned;
                                }
                                return (
                                    <React.Fragment key={item.id}>
                                    <tr className={challanSelection[item.id] > 0 ? 'bg-indigo-50' : ''}>
                                        <td className="p-2"><input type="checkbox" checked={challanSelection[item.id] > 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: e.target.checked ? maxQty : 0})} disabled={maxQty <= 0 && !challanSelection[item.id]} /></td>
                                        <td className="p-2">{item.item_name}</td>
                                        <td className="p-2 text-center">{item.qty}</td>
                                        <td className="p-2 text-center">{alreadyChallaned}</td>
                                        <td className="p-2 text-center font-bold">{maxQty}</td>
                                        <td className="p-2"><input type="number" min="0" max={maxQty} className="w-full border rounded p-1" value={challanSelection[item.id] || 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: parseInt(e.target.value) || 0})} /></td>
                                    </tr>
                                    {availableSerials.length > 0 && challanSelection[item.id] > 0 && (
                                        <tr className="bg-indigo-50/50">
                                            <td colSpan={6} className="p-2 pl-10">
                                                <div className="text-[10px] font-bold text-slate-500 mb-1">Select Serial Numbers to Print:</div>
                                                <div className="flex flex-wrap gap-2">
                                                    {availableSerials.map(sn => (
                                                        <label key={sn} className="flex items-center gap-1 text-[10px] bg-white px-2 py-1 rounded border cursor-pointer hover:border-indigo-300">
                                                            <input
                                                                type="checkbox"
                                                                checked={(challanSerials[item.id] || []).includes(sn)}
                                                                onChange={(e) => {
                                                                    const current = challanSerials[item.id] || [];
                                                                    const newSerials = e.target.checked ? [...current, sn] : current.filter(s => s !== sn);
                                                                    setChallanSerials({...challanSerials, [item.id]: newSerials});
                                                                    if(newSerials.length > 0) setChallanSelection({...challanSelection, [item.id]: newSerials.length});
                                                                }}
                                                            />
                                                            {sn}
                                                        </label>
                                                    ))}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={handleSaveChallan} className="w-full rounded bg-indigo-600 py-2 text-white font-bold hover:bg-indigo-700">Update Challan</button>
              </div>
            </div>
        </Modal>
      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm(prev => ({ ...prev, isOpen: false }))}
        onConfirm={deleteConfirm.onConfirm}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        requireTyped={false}
      />
    </div>
  );
};

export default ChallanManager;
