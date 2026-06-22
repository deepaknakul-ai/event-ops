import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { confirmDialog } from '../utils/dialog';
import { notify } from '../utils/toast';
import {
  Plus, Edit, User, Key, Wallet, History, Camera, FileCheck, FileText, MapPin, Link2, Copy, ExternalLink, Printer, TrendingUp
} from 'lucide-react';
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { useEmployeeLocations, isLocationLive, locationAge } from '../utils/useEmployeeLocations';
import jsPDF from 'jspdf';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import { formatCurrency, hashPassword, normalizeHourlyRateHistory, getHourlyRateForDate, generateSecureToken } from '../utils/helpers';
import { ROLE_LABELS, ROLE_COLOR, can } from '../utils/permissions';
import { upsertPartyAccount } from '../utils/partyAccounts';

const Employees = ({ employees, role, db, appId, advances = [], logAction }) => {
  const canTrack = can(role, 'tracking', 'view');
  const liveLocations = useEmployeeLocations(db, appId, canTrack);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAdvanceModalOpen, setIsAdvanceModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  const [advanceForm, setAdvanceForm] = useState({ amount: '', date: new Date().toISOString().split('T')[0], remarks: '' });
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [statementLinkModal, setStatementLinkModal] = useState({ isOpen: false, employee: null, link: '' });
  const [statementExpiryDays, setStatementExpiryDays] = useState('');
  const [isPromotionModalOpen, setIsPromotionModalOpen] = useState(false);
  const [promotionEmployee, setPromotionEmployee] = useState(null);
  const [promotionForm, setPromotionForm] = useState({
    effectiveFrom: new Date().toISOString().split('T')[0],
    hourlyRate: '',
    changeType: 'Promotion',
    notes: '',
  });

  // Updated initial form state for photos
  const initialFormState = {
    name: '', email: '', role: 'tech', status: 'Active',
    mobile1: '', mobile2: '', alt_mobile: '', address: '',
    password: '', photo_url: '', id_proof_url: '', address_proof_url: '',
    fatherName: '', emergencyContact: '', emergencyPhone: '',
    hourlyRate: '', monthlyTargetHours: ''
  };
  const [formData, setFormData] = useState(initialFormState);

  const buildRateTimeline = (entries = []) => {
    const sorted = [...entries]
      .filter((entry) => entry?.effectiveFrom && Number.isFinite(Number(entry?.hourlyRate)))
      .sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));

    return sorted.map((entry, index) => {
      const next = sorted[index + 1];
      let effectiveTo = null;
      if (next?.effectiveFrom) {
        const dt = new Date(next.effectiveFrom);
        dt.setDate(dt.getDate() - 1);
        effectiveTo = dt.toISOString().slice(0, 10);
      }
      return {
        ...entry,
        effectiveTo,
      };
    });
  };

  const openPromotionModal = (emp) => {
    setPromotionEmployee(emp);
    setPromotionForm({
      effectiveFrom: new Date().toISOString().split('T')[0],
      hourlyRate: String(emp?.hourlyRate || ''),
      changeType: 'Promotion',
      notes: '',
    });
    setIsPromotionModalOpen(true);
  };

  const openAdd = () => { setEditingId(null); setFormData(initialFormState); setIsModalOpen(true); };

  const openEdit = (emp) => {
    setEditingId(emp.id);
    setFormData({
      name: emp.name || '', email: emp.email || '', role: emp.role || 'tech',
      status: emp.status || 'Active', mobile1: emp.mobile1 || '', mobile2: emp.mobile2 || '',
      alt_mobile: emp.alt_mobile || '', address: emp.address || '', password: '',
      photo_url: emp.photo_url || '', id_proof_url: emp.id_proof_url || '', address_proof_url: emp.address_proof_url || '',
      fatherName: emp.fatherName || '', emergencyContact: emp.emergencyContact || '',
      emergencyPhone: emp.emergencyPhone || '', hourlyRate: emp.hourlyRate || '',
      monthlyTargetHours: emp.monthlyTargetHours || ''
    });
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    if (editingId ? !can(role, 'employees', 'edit') : !can(role, 'employees', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    // Only admin (Owner) can assign/change roles; non-admins always retain the employee's existing role
    const resolvedRole = can(role, 'employees', 'manage_roles')
      ? formData.role
      : (editingId ? (employees.find(e => e.id === editingId)?.role || 'user') : 'user');

    const existingEmployee = editingId ? employees.find((e) => e.id === editingId) : null;
    const parsedHourlyRate = formData.hourlyRate === '' ? null : parseFloat(formData.hourlyRate);
    const initialRateHistory = (!editingId && Number.isFinite(parsedHourlyRate))
      ? buildRateTimeline([{
          id: `initial_${Date.now()}`,
          effectiveFrom: new Date().toISOString().split('T')[0],
          effectiveTo: null,
          hourlyRate: parsedHourlyRate,
          changeType: 'Initial',
          notes: 'Initial hourly rate set during onboarding',
          createdAt: new Date().toISOString(),
          createdByRole: role,
        }])
      : [];

    const resolvedHourlyRate = editingId
      ? Number(existingEmployee?.hourlyRate ?? 0)
      : (Number.isFinite(parsedHourlyRate) ? parsedHourlyRate : null);

    const empData = {
      name: formData.name, email: formData.email, username: formData.email,
      role: resolvedRole, status: formData.status,
      mobile1: formData.mobile1, mobile2: formData.mobile2, alt_mobile: formData.alt_mobile,
      address: formData.address,
      photo_url: formData.photo_url, id_proof_url: formData.id_proof_url, address_proof_url: formData.address_proof_url,
      fatherName: formData.fatherName, emergencyContact: formData.emergencyContact,
      emergencyPhone: formData.emergencyPhone,
      hourlyRate: resolvedHourlyRate,
      hourlyRateHistory: editingId
        ? (Array.isArray(existingEmployee?.hourlyRateHistory) ? existingEmployee.hourlyRateHistory : [])
        : initialRateHistory,
      monthlyTargetHours: formData.monthlyTargetHours ? parseFloat(formData.monthlyTargetHours) : null
    };
    if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', editingId), empData);
        logAction('employees', 'update', editingId, empData, formData.name);
        upsertPartyAccount(db, appId, editingId, 'employee', formData.name);  // M-5
    } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'employees'), { ...empData, created_at: serverTimestamp() });
        logAction('employees', 'create', docRef.id, empData, formData.name);
        upsertPartyAccount(db, appId, docRef.id, 'employee', formData.name);  // M-5
    }
    setIsModalOpen(false);
  };

  const handlePasswordChange = async () => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if (!newPassword) return notify("Enter password", 'error');
    const hashedPw = await hashPassword(newPassword);
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', selectedEmp.id), {
      password: hashedPw,
      password_hashed: true,
      password_updated_at: serverTimestamp()
    });
    logAction('employees', 'password_change', selectedEmp.id, {}, selectedEmp.name);
    notify("Password updated", 'success'); setPasswordModalOpen(false); setNewPassword('');
  };

  const handleUnlock = async (id) => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if(!await confirmDialog("Unlock this account?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), {
        is_locked: false,
        failed_login_attempts: 0
    });
    logAction('employees', 'unlock', id, {}, 'Account Unlocked');
  };

  const updateStatus = async (id, status) => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), { status });
    logAction('employees', 'status_change', id, { status }, `Status: ${status}`);
  };

  const handleDelete = async (emp) => {
    if (!can(role, 'employees', 'delete')) return notify('Access denied: only Admin can delete employees.', 'error');
    setDeleteConfirm({
      isOpen: true,
      title: `Delete Employee: ${emp.name}`,
      message: `Permanently delete "${emp.name}"? All their records will be dissociated. This cannot be undone.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id));
        logAction('employees', 'delete', emp.id, {}, emp.name);
      }
    });
  };

  const submitAdvance = async () => {
    if (!can(role, 'finance', 'create')) return notify('Access denied: insufficient permissions.', 'error');
    if(!advanceForm.amount) return notify("Enter amount", 'error');
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'advances'), {
        employee_id: selectedEmp.id,
        employee_name: selectedEmp.name,
        amount: parseFloat(advanceForm.amount),
        date: advanceForm.date,
        remarks: advanceForm.remarks,
        created_at: new Date().toISOString()
      });
      logAction('advances', 'create', selectedEmp.id, { amount: advanceForm.amount }, `Advance to ${selectedEmp.name}`);
      notify(`Advance of ${advanceForm.amount} recorded for ${selectedEmp.name}`, 'success');
      setIsAdvanceModalOpen(false);
      setAdvanceForm({ amount: '', date: new Date().toISOString().split('T')[0], remarks: '' });
    } catch (e) {
      console.error(e);
      notify("Error saving advance", 'error');
    }
  };

  const submitPromotionUpdate = async () => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    if (!promotionEmployee?.id) return notify('Select an employee first.', 'error');

    const rateValue = parseFloat(promotionForm.hourlyRate);
    if (!promotionForm.effectiveFrom) return notify('Please select effective date.', 'error');
    if (!Number.isFinite(rateValue) || rateValue < 0) return notify('Please enter a valid hourly rate.', 'error');

    const existingHistory = normalizeHourlyRateHistory(promotionEmployee);
    const nextEntry = {
      id: `rate_${Date.now()}`,
      effectiveFrom: promotionForm.effectiveFrom,
      effectiveTo: null,
      hourlyRate: rateValue,
      changeType: promotionForm.changeType || 'Promotion',
      notes: promotionForm.notes || '',
      createdAt: new Date().toISOString(),
      createdByRole: role,
    };

    const merged = [...existingHistory.filter((entry) => entry.effectiveFrom !== nextEntry.effectiveFrom), nextEntry];
    const hourlyRateHistory = buildRateTimeline(merged);
    const latestApplicableRate = Number(getHourlyRateForDate({
      ...promotionEmployee,
      hourlyRateHistory,
    }, new Date()) || rateValue);

    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', promotionEmployee.id), {
        hourlyRate: latestApplicableRate,
        hourlyRateHistory,
        updated_at: serverTimestamp(),
      });

      logAction('employees', 'promotion_update', promotionEmployee.id, {
        effectiveFrom: nextEntry.effectiveFrom,
        hourlyRate: nextEntry.hourlyRate,
        changeType: nextEntry.changeType,
        notes: nextEntry.notes,
        historySize: hourlyRateHistory.length,
      }, promotionEmployee.name);

      notify(`Promotion/rate update saved for ${promotionEmployee.name}.`, 'success');
      setIsPromotionModalOpen(false);
      setPromotionEmployee(null);
      setPromotionForm({
        effectiveFrom: new Date().toISOString().split('T')[0],
        hourlyRate: '',
        changeType: 'Promotion',
        notes: '',
      });
    } catch (error) {
      console.error(error);
      notify('Failed to save promotion/rate update. Please try again.', 'error');
    }
  };

  // Simulated upload function for demo purposes
  const handleMockUpload = (field) => {
    const mockUrls = {
      photo: "https://via.placeholder.com/150",
      id: "https://via.placeholder.com/300x200?text=ID+Proof",
      addr: "https://via.placeholder.com/300x200?text=Address+Proof"
    };
    // Toggle between empty and mock URL
    const currentVal = formData[field];
    const newVal = currentVal ? '' : (field === 'photo_url' ? mockUrls.photo : field === 'id_proof_url' ? mockUrls.id : mockUrls.addr);
    setFormData({ ...formData, [field]: newVal });
  };

  const empAdvances = selectedEmp ? advances.filter(a => String(a.employee_id) === String(selectedEmp.id)) : [];
  const promotionHistory = promotionEmployee
    ? [...normalizeHourlyRateHistory(promotionEmployee)].sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
    : [];

  // --- Employee ID Card PDF Generator ---
  const toDataUrl = (url) => new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg'));
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });

  const printIdCard = async (emp) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const cardW = 86;
    const cardH = 54;
    const cardX = (pageW - cardW) / 2;
    const cardY = 20;

    // Card border
    doc.setDrawColor(80, 80, 180);
    doc.setLineWidth(0.5);
    doc.roundedRect(cardX, cardY, cardW, cardH, 3, 3, 'S');

    // Header bar
    doc.setFillColor(63, 81, 181);
    doc.roundedRect(cardX, cardY, cardW, 10, 3, 3, 'F');
    doc.rect(cardX, cardY + 7, cardW, 3, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('EMPLOYEE IDENTITY CARD', cardX + cardW / 2, cardY + 6.5, { align: 'center' });

    // Photo box (left)
    const photoX = cardX + 3;
    const photoY = cardY + 13;
    const photoW = 22;
    const photoH = 26;
    doc.setDrawColor(180, 180, 180);
    doc.rect(photoX, photoY, photoW, photoH);
    if (emp.photo_url) {
      try {
        const dataUrl = await toDataUrl(emp.photo_url);
        if (dataUrl) doc.addImage(dataUrl, 'JPEG', photoX, photoY, photoW, photoH);
        else {
          doc.setFontSize(7); doc.setTextColor(150, 150, 150);
          doc.text('No Photo', photoX + photoW / 2, photoY + photoH / 2, { align: 'center' });
        }
      } catch { /* skip image */ }
    } else {
      doc.setFontSize(7); doc.setTextColor(150, 150, 150);
      doc.text('No Photo', photoX + photoW / 2, photoY + photoH / 2, { align: 'center' });
    }
    doc.setFontSize(6.5); doc.setTextColor(100, 100, 100); doc.setFont('helvetica', 'normal');
    doc.text('Photo', photoX + photoW / 2, photoY + photoH + 3.5, { align: 'center' });

    // Text info (right of photo)
    const infoX = cardX + 28;
    const roles = { admin: 'Owner', accountant: 'Accountant', manager: 'Project Manager', tech: 'Field Tech', user: 'General User' };
    const infoLines = [
      { label: 'Name', value: emp.name || '-' },
      { label: 'Father', value: emp.fatherName || '-' },
      { label: 'Mobile', value: emp.mobile1 || '-' },
      { label: 'Role', value: roles[emp.role] || emp.role || '-' },
    ];
    let iy = cardY + 15;
    doc.setFont('helvetica', 'normal');
    infoLines.forEach(({ label, value }) => {
      doc.setFontSize(7); doc.setTextColor(100, 100, 100);
      doc.text(label + ':', infoX, iy);
      doc.setFontSize(8); doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'bold');
      doc.text(String(value), infoX + 14, iy);
      doc.setFont('helvetica', 'normal');
      iy += 5.5;
    });
    // Address (wrapped)
    doc.setFontSize(7); doc.setTextColor(100, 100, 100);
    doc.text('Address:', infoX, iy);
    const addrLines = doc.splitTextToSize(emp.address || '-', cardW - 28 - 5);
    doc.setFontSize(7); doc.setTextColor(30, 30, 30);
    doc.text(addrLines.slice(0, 2), infoX + 14, iy);

    // ID Proof section below the card
    const idY = cardY + cardH + 8;
    if (emp.id_proof_url) {
      doc.setFontSize(8); doc.setTextColor(63, 81, 181); doc.setFont('helvetica', 'bold');
      doc.text('ID PROOF', cardX, idY);
      doc.setDrawColor(180, 180, 180);
      doc.rect(cardX, idY + 2, cardW, 50);
      try {
        const idDataUrl = await toDataUrl(emp.id_proof_url);
        if (idDataUrl) doc.addImage(idDataUrl, 'JPEG', cardX, idY + 2, cardW, 50);
        else {
          doc.setFontSize(8); doc.setTextColor(150, 150, 150); doc.setFont('helvetica', 'normal');
          doc.text('ID proof image not available', cardX + cardW / 2, idY + 27, { align: 'center' });
        }
      } catch { /* skip */ }
    }

    doc.save(`ID_Card_${emp.name.replace(/\s+/g, '_')}.pdf`);
  };

  const generateStatementToken = () => generateSecureToken(16);

  const handleStatementLink = async (emp) => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    let token = emp.statement_link_token;
    if (!token) {
      token = generateStatementToken();
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), {
        statement_link_token: token,
        statement_link_enabled: true,
        statement_link_created_at: new Date().toISOString()
      });
      logAction('employees', 'create_statement_link', emp.id, { token }, emp.name);
    }
    const link = `${window.location.origin}/employee-statement/${token}`;
    setStatementLinkModal({ isOpen: true, employee: emp, link });
    setStatementExpiryDays('');
  };

  const ensureEmployeeLedgerToken = async (emp) => {
    let token = emp.statement_link_token;
    if (!token) {
      token = generateStatementToken();
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), {
        statement_link_token: token,
        statement_link_enabled: true,
        statement_link_created_at: new Date().toISOString()
      });
      logAction('employees', 'create_statement_link', emp.id, { token }, emp.name);
    }
    return token;
  };

  const openEmployeeLedger = async (emp) => {
    if (!can(role, 'employees', 'edit') && !emp.statement_link_token) {
      notify('Employee ledger link is not generated yet. Please ask admin/manager to generate it first.', 'error');
      return;
    }
    const token = await ensureEmployeeLedgerToken(emp);
    window.open(`${window.location.origin}/employee-statement/${token}`, '_blank', 'noopener,noreferrer');
  };

  const toggleStatementLink = async (emp, enabled) => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), {
      statement_link_enabled: enabled
    });
    logAction('employees', enabled ? 'enable_statement_link' : 'disable_statement_link', emp.id, {}, emp.name);
    setStatementLinkModal(prev => ({ ...prev, employee: { ...prev.employee, statement_link_enabled: enabled } }));
  };

  const setStatementExpiry = async (emp, days) => {
    if (!can(role, 'employees', 'edit')) return notify('Access denied: insufficient permissions.', 'error');
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), {
      statement_link_expires_at: expiresAt
    });
    logAction('employees', 'set_statement_expiry', emp.id, { days }, emp.name);
    notify(days ? `Link will expire in ${days} days.` : 'Expiry removed. Link is now permanent.', 'success');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Employee Management</h2>
        <button onClick={openAdd} className="flex items-center justify-center gap-2 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap w-full md:w-auto"><Plus size={18} /> Add Employee</button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{employees.map(emp => (
        <div key={emp.id} className={`rounded-xl border bg-white p-4 shadow-sm relative ${emp.status === 'Disabled' || emp.status === 'Deactivated' ? 'opacity-60 bg-slate-50' : ''}`}>
          {emp.is_locked && <div className="absolute top-2 left-2 bg-red-600 text-white text-[10px] px-2 py-1 rounded font-bold z-10 shadow-sm">LOCKED</div>}
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200">
                 {emp.photo_url ? (
                   <img src={emp.photo_url} alt={emp.name} className="h-full w-full object-cover" />
                 ) : (
                   <span className="text-slate-500 font-bold text-lg">{emp.name.charAt(0)}</span>
                 )}
              </div>
              <div><h3 className="font-bold text-slate-800">{emp.name}</h3><div className="text-xs text-slate-500">{emp.email}</div></div>
            </div>
            <div className={`px-2 py-0.5 text-xs rounded border ${emp.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-slate-100'}`}>{emp.status}</div>
          </div>
          <div className="mt-4 space-y-2 text-sm text-slate-600">
            <div className="flex justify-between border-b pb-1"><span className="text-slate-400">Role:</span><span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${ROLE_COLOR[emp.role] || 'bg-slate-400'}`}>{ROLE_LABELS[emp.role] || emp.role}</span></div>
            <div className="flex justify-between border-b pb-1"><span className="text-slate-400">Mobile:</span><span>{emp.mobile1 || '-'}</span></div>
            <div className="flex justify-between border-b pb-1"><span className="text-slate-400">Hourly Rate:</span><span>{Number.isFinite(Number(emp.hourlyRate)) ? `${formatCurrency(emp.hourlyRate)}/hr` : '-'}</span></div>
            <div className="flex justify-between border-b pb-1"><span className="text-slate-400">Rate History:</span><span>{Array.isArray(emp.hourlyRateHistory) ? emp.hourlyRateHistory.length : 0} entries</span></div>
            <div className="flex gap-2 pt-1">
              {emp.id_proof_url && <span title="ID Proof Attached" className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100">ID</span>}
              {emp.address_proof_url && <span title="Addr Proof Attached" className="text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded border border-purple-100">Addr</span>}
            </div>
          </div>
          {canTrack && liveLocations[emp.id] && (
            <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${isLocationLive(liveLocations[emp.id]) ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <span className="truncate text-slate-500">{isLocationLive(liveLocations[emp.id]) ? (liveLocations[emp.id].project_name || 'On duty') : 'Off duty'} · {locationAge(liveLocations[emp.id].at)}</span>
              </span>
              <Link to={`/tracking?emp=${emp.id}`} className="flex shrink-0 items-center gap-1 font-medium text-indigo-600 hover:underline"><MapPin size={12} /> Locate</Link>
            </div>
          )}
          <div className="mt-4 pt-2 flex gap-2">
            <button onClick={() => openEdit(emp)} className="flex-1 rounded border border-indigo-300 bg-indigo-50 text-indigo-700 py-1 text-xs font-medium hover:bg-indigo-100">Edit</button>
            <button onClick={() => { setSelectedEmp(emp); setPasswordModalOpen(true); }} className="flex-1 rounded border border-amber-300 bg-amber-50 text-amber-700 py-1 text-xs font-medium hover:bg-amber-100 flex justify-center gap-1"><Key size={12}/> Pass</button>
            <button onClick={() => printIdCard(emp)} title="Print ID Card" className="flex-1 rounded border border-teal-300 bg-teal-50 text-teal-700 py-1 text-xs font-medium hover:bg-teal-100 flex justify-center gap-1"><Printer size={12}/> ID</button>
            {role === 'admin' && (
              <button onClick={() => handleDelete(emp)} className="flex-1 rounded border border-red-300 bg-red-50 text-red-600 py-1 text-xs font-medium hover:bg-red-100">Delete</button>
            )}
          </div>
          {(role === 'admin' || role === 'manager') && (
             <div className="grid grid-cols-3 gap-2 mt-2">
               <button onClick={() => { setSelectedEmp(emp); setIsAdvanceModalOpen(true); }} className="flex-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-100 py-1 text-xs font-medium hover:bg-emerald-100 flex items-center justify-center gap-1"><Wallet size={12} /> Advance</button>
               <button onClick={() => { setSelectedEmp(emp); setIsHistoryOpen(true); }} className="flex-1 rounded bg-slate-50 text-slate-700 border border-slate-100 py-1 text-xs font-medium hover:bg-slate-100 flex items-center justify-center gap-1"><History size={12} /> View</button>
               <button onClick={() => openPromotionModal(emp)} className="flex-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 py-1 text-xs font-medium hover:bg-indigo-100 flex items-center justify-center gap-1"><TrendingUp size={12} /> Promote</button>
             </div>
          )}
          {(role === 'admin' || role === 'manager') && (
             <div className="mt-2">
               <div className="grid grid-cols-2 gap-2">
                 <button onClick={() => handleStatementLink(emp)} className="w-full rounded bg-violet-50 text-violet-700 border border-violet-100 py-1 text-xs font-medium hover:bg-violet-100 flex items-center justify-center gap-1"><Link2 size={12} /> Ledger Share</button>
                 <button onClick={() => openEmployeeLedger(emp)} className="w-full rounded bg-cyan-50 text-cyan-700 border border-cyan-100 py-1 text-xs font-medium hover:bg-cyan-100 flex items-center justify-center gap-1"><ExternalLink size={12} /> Open Ledger</button>
               </div>
             </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2 text-center border-t pt-2">
             {emp.status !== 'Active' && <button onClick={() => updateStatus(emp.id, 'Active')} className="text-xs text-green-600 hover:underline">Activate</button>}
             {emp.status === 'Active' && <button onClick={() => updateStatus(emp.id, 'Suspended')} className="text-xs text-orange-600 hover:underline">Suspend</button>}
             {emp.status !== 'Disabled' && <button onClick={() => updateStatus(emp.id, 'Disabled')} className="text-xs text-red-600 hover:underline">Disable</button>}
             {emp.status !== 'Deactivated' && <button onClick={() => updateStatus(emp.id, 'Deactivated')} className="text-xs text-gray-600 hover:underline">Deactivate</button>}
             {emp.is_locked && <button onClick={() => handleUnlock(emp.id)} className="col-span-2 text-xs text-purple-600 hover:underline font-bold bg-purple-50 py-1 rounded mt-1">Unlock Account</button>}
          </div>
        </div>
      ))}</div>
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Edit Employee" : "New Employee"}>
        <div className="space-y-4">
           <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><div><label className="text-xs font-bold text-slate-700">Full Name</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Address</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div></div>
           <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
             <div><label className="text-xs font-bold text-slate-700">Mobile 1</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.mobile1} onChange={e => setFormData({...formData, mobile1: e.target.value})} /></div>
             <div><label className="text-xs font-bold text-slate-700">Mobile 2</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.mobile2} onChange={e => setFormData({...formData, mobile2: e.target.value})} /></div>
             <div><label className="text-xs font-bold text-slate-700">Alt Mobile</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.alt_mobile} onChange={e => setFormData({...formData, alt_mobile: e.target.value})} /></div>
          </div>
           <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><div><label className="text-xs font-bold text-slate-700">Email</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Role</label><select className="w-full rounded border border-slate-300 p-2 text-black" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})} disabled={role !== 'admin'}><option value="admin">Owner</option><option value="accountant">Accountant</option><option value="manager">Project Manager</option><option value="tech">Field Tech</option><option value="user">General User</option></select>{role !== 'admin' && <p className="text-xs text-slate-400 mt-1">Only the Owner can change roles.</p>}</div></div>

          <div className="border-t pt-3">
             <h4 className="text-sm font-semibold mb-2 text-slate-800">Documents & Photos</h4>
             <div className="grid grid-cols-3 gap-3">
                <div className="text-center">
                   <div className="h-20 w-full rounded border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 mb-2 overflow-hidden bg-slate-50">
                      {formData.photo_url ? <img src={formData.photo_url} className="h-full w-full object-cover" /> : <Camera size={24} />}
                   </div>
                   <button onClick={() => handleMockUpload('photo_url')} className="text-xs text-indigo-600 hover:underline">{formData.photo_url ? 'Remove Photo' : 'Add Photo'}</button>
                </div>
                <div className="text-center">
                   <div className="h-20 w-full rounded border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 mb-2 overflow-hidden bg-slate-50">
                      {formData.id_proof_url ? <div className="text-green-600 font-bold text-xs"><FileCheck size={24} className="mx-auto mb-1"/>ID Attached</div> : <FileText size={24} />}
                   </div>
                   <button onClick={() => handleMockUpload('id_proof_url')} className="text-xs text-indigo-600 hover:underline">{formData.id_proof_url ? 'Remove ID' : 'Add ID Proof'}</button>
                </div>
                <div className="text-center">
                   <div className="h-20 w-full rounded border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 mb-2 overflow-hidden bg-slate-50">
                      {formData.address_proof_url ? <div className="text-purple-600 font-bold text-xs"><FileCheck size={24} className="mx-auto mb-1"/>Addr Attached</div> : <MapPin size={24} />}
                   </div>
                   <button onClick={() => handleMockUpload('address_proof_url')} className="text-xs text-indigo-600 hover:underline">{formData.address_proof_url ? 'Remove Addr' : 'Add Addr Proof'}</button>
                </div>
             </div>
          </div>

          <div className="border-t pt-3">
             <h4 className="text-sm font-semibold mb-2 text-slate-800">HR Details</h4>
             <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><label className="text-xs font-bold text-slate-700">Father's Name</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.fatherName} onChange={e => setFormData({...formData, fatherName: e.target.value})} /></div>
                <div><label className="text-xs font-bold text-slate-700">Emergency Contact</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.emergencyContact} onChange={e => setFormData({...formData, emergencyContact: e.target.value})} /></div>
                <div><label className="text-xs font-bold text-slate-700">Emergency Phone</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.emergencyPhone} onChange={e => setFormData({...formData, emergencyPhone: e.target.value})} /></div>
                <div>
                  <label className="text-xs font-bold text-slate-700">Hourly Rate (₹)</label>
                  <input
                    type="number"
                    className="w-full rounded border border-slate-300 p-2 text-black disabled:bg-slate-100 disabled:text-slate-500"
                    value={formData.hourlyRate}
                    onChange={e => setFormData({...formData, hourlyRate: e.target.value})}
                    disabled={!!editingId}
                  />
                  {editingId && <p className="text-[11px] text-slate-500 mt-1">Use Promote action to revise hourly rate with effective period.</p>}
                </div>
                 <div className="md:col-span-2"><label className="text-xs font-bold text-slate-700">Monthly Target Hours</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-black" value={formData.monthlyTargetHours} onChange={e => setFormData({...formData, monthlyTargetHours: e.target.value})} /></div>
             </div>
          </div>

          <div className="pt-4 flex justify-end"><button onClick={handleSave} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">Save Employee</button></div>
        </div>
      </Modal>
      <Modal isOpen={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} title={`Change Password: ${selectedEmp?.name}`}><div className="space-y-4"><div><label className="text-sm font-bold text-slate-700">New Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-black" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></div><button onClick={handlePasswordChange} className="w-full rounded bg-red-600 text-white py-2 hover:bg-red-700">Update Password</button></div></Modal>
      <Modal isOpen={isAdvanceModalOpen} onClose={() => setIsAdvanceModalOpen(false)} title={`Give Advance: ${selectedEmp?.name}`}>
         <div className="space-y-4">
            <div><label className="text-sm font-bold text-slate-700">Amount (INR)</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-black" value={advanceForm.amount} onChange={e => setAdvanceForm({...advanceForm, amount: e.target.value})} /></div>
            <div><label className="text-sm font-bold text-slate-700">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-black" value={advanceForm.date} onChange={e => setAdvanceForm({...advanceForm, date: e.target.value})} /></div>
            <div><label className="text-sm font-bold text-slate-700">Remarks</label><input className="w-full rounded border border-slate-300 p-2 text-black" placeholder="Reason for advance..." value={advanceForm.remarks} onChange={e => setAdvanceForm({...advanceForm, remarks: e.target.value})} /></div>
            <button onClick={submitAdvance} className="w-full rounded bg-emerald-600 text-white py-2 hover:bg-emerald-700">Record Advance</button>
         </div>
      </Modal>
      <Modal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title={`Advance History: ${selectedEmp?.name}`}>
         <div className="space-y-2 max-h-96 overflow-y-auto">
            {empAdvances.length === 0 ? <p className="text-slate-400 text-sm">No advances recorded.</p> : empAdvances.sort((a,b)=> new Date(b.date)-new Date(a.date)).map(adv => (
              <div key={adv.id} className="flex justify-between items-center p-2 bg-slate-50 rounded border">
                 <div><div className="font-medium text-slate-800">{formatCurrency(adv.amount)}</div><div className="text-xs text-slate-500">{new Date(adv.date).toLocaleDateString()}</div></div>
                 <div className="text-xs text-slate-500 italic max-w-[150px] truncate">{adv.remarks}</div>
              </div>
            ))}
         </div>
      </Modal>
      <Modal
        isOpen={isPromotionModalOpen}
        onClose={() => {
          setIsPromotionModalOpen(false);
          setPromotionEmployee(null);
        }}
        title={`Promotion / Rate Update: ${promotionEmployee?.name || ''}`}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-bold text-slate-700">Effective From</label>
              <input
                type="date"
                className="w-full rounded border border-slate-300 p-2 text-black"
                value={promotionForm.effectiveFrom}
                onChange={(e) => setPromotionForm({ ...promotionForm, effectiveFrom: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-bold text-slate-700">New Hourly Rate (INR)</label>
              <input
                type="number"
                className="w-full rounded border border-slate-300 p-2 text-black"
                value={promotionForm.hourlyRate}
                onChange={(e) => setPromotionForm({ ...promotionForm, hourlyRate: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-bold text-slate-700">Change Type</label>
              <select
                className="w-full rounded border border-slate-300 p-2 text-black"
                value={promotionForm.changeType}
                onChange={(e) => setPromotionForm({ ...promotionForm, changeType: e.target.value })}
              >
                <option value="Promotion">Promotion</option>
                <option value="Revision">Revision</option>
                <option value="Demotion">Demotion</option>
                <option value="Correction">Correction</option>
              </select>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
              Current effective rate: <span className="font-semibold text-slate-800">{promotionEmployee ? formatCurrency(getHourlyRateForDate(promotionEmployee, new Date())) : '-'}</span>
            </div>
          </div>

          <div>
            <label className="text-sm font-bold text-slate-700">Notes</label>
            <textarea
              rows={2}
              className="w-full rounded border border-slate-300 p-2 text-black"
              placeholder="Reason for promotion/rate change"
              value={promotionForm.notes}
              onChange={(e) => setPromotionForm({ ...promotionForm, notes: e.target.value })}
            />
          </div>

          <button onClick={submitPromotionUpdate} className="w-full rounded bg-indigo-600 text-white py-2 hover:bg-indigo-700">Save Promotion Update</button>

          <div className="border-t pt-3">
            <h4 className="text-sm font-semibold text-slate-800 mb-2">Hourly Rate Timeline</h4>
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {promotionHistory.length === 0 ? (
                <p className="text-slate-400 text-sm">No promotion/rate history recorded yet.</p>
              ) : promotionHistory.map((entry) => (
                <div key={entry.id} className="rounded border bg-slate-50 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-800">{formatCurrency(entry.hourlyRate)}/hr</div>
                    <div className="text-[11px] px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">{entry.changeType || 'Revision'}</div>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{entry.effectiveFrom} to {entry.effectiveTo || 'ongoing'}</div>
                  {entry.notes && <div className="text-xs text-slate-600 mt-1">{entry.notes}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
      {/* Statement Link Modal */}
      <Modal isOpen={statementLinkModal.isOpen} onClose={() => setStatementLinkModal({ isOpen: false, employee: null, link: '' })} title={`Employee Ledger Share: ${statementLinkModal.employee?.name || ''}`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Share this link with the employee so they can view their public ledger (payouts &amp; advances) anytime.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={statementLinkModal.link} className="flex-1 rounded border border-slate-300 p-2 text-sm text-black bg-slate-50 truncate" />
            <button onClick={() => { navigator.clipboard.writeText(statementLinkModal.link); notify('Link copied!', 'success'); }} className="rounded bg-indigo-600 text-white px-3 py-2 text-sm hover:bg-indigo-700 flex items-center gap-1"><Copy size={14} /> Copy</button>
            <a href={statementLinkModal.link} target="_blank" rel="noopener noreferrer" className="rounded bg-slate-100 text-slate-700 px-3 py-2 text-sm hover:bg-slate-200 flex items-center gap-1"><ExternalLink size={14} /></a>
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <span className="text-sm text-slate-600">Link Status</span>
            <button
              onClick={() => toggleStatementLink(statementLinkModal.employee, !(statementLinkModal.employee?.statement_link_enabled !== false))}
              className={`text-xs font-bold px-3 py-1 rounded-full ${statementLinkModal.employee?.statement_link_enabled !== false ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
            >
              {statementLinkModal.employee?.statement_link_enabled !== false ? 'Enabled — Click to Disable' : 'Disabled — Click to Enable'}
            </button>
          </div>
          <div className="flex items-center gap-2 border-t pt-3">
            <span className="text-sm text-slate-600 shrink-0">Auto-expire in</span>
            <input type="number" min="1" placeholder="days" className="w-20 rounded border border-slate-300 p-2 text-sm text-black" value={statementExpiryDays} onChange={e => setStatementExpiryDays(e.target.value)} />
            <button onClick={() => setStatementExpiry(statementLinkModal.employee, parseInt(statementExpiryDays) || 0)} className="rounded bg-amber-600 text-white px-3 py-1 text-sm hover:bg-amber-700">
              {statementExpiryDays ? 'Set Expiry' : 'Remove Expiry'}
            </button>
          </div>
        </div>
      </Modal>
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

export default Employees;
