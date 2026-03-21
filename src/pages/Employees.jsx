import React, { useState } from 'react';
import {
  Plus, Edit, User, Key, Wallet, History, Camera, FileCheck, FileText, MapPin, Link2, Copy, ExternalLink
} from 'lucide-react';
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { Modal, ConfirmDeleteModal } from '../components/Shared';
import { formatCurrency, hashPassword } from '../utils/helpers';
import { ROLE_LABELS, ROLE_COLOR, can } from '../utils/permissions';

const Employees = ({ employees, role, db, appId, advances = [], logAction }) => {
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

  // Updated initial form state for photos
  const initialFormState = {
    name: '', email: '', role: 'tech', status: 'Active',
    mobile1: '', mobile2: '', alt_mobile: '', address: '',
    password: '', photo_url: '', id_proof_url: '', address_proof_url: ''
  };
  const [formData, setFormData] = useState(initialFormState);

  const openAdd = () => { setEditingId(null); setFormData(initialFormState); setIsModalOpen(true); };

  const openEdit = (emp) => {
    setEditingId(emp.id);
    setFormData({
      name: emp.name || '', email: emp.email || '', role: emp.role || 'tech',
      status: emp.status || 'Active', mobile1: emp.mobile1 || '', mobile2: emp.mobile2 || '',
      alt_mobile: emp.alt_mobile || '', address: emp.address || '', password: '',
      photo_url: emp.photo_url || '', id_proof_url: emp.id_proof_url || '', address_proof_url: emp.address_proof_url || ''
    });
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    if (editingId ? !can(role, 'employees', 'edit') : !can(role, 'employees', 'create')) return alert('Access denied: insufficient permissions.');
    // Only admin (Owner) can assign/change roles; non-admins always retain the employee's existing role
    const resolvedRole = can(role, 'employees', 'manage_roles')
      ? formData.role
      : (editingId ? (employees.find(e => e.id === editingId)?.role || 'user') : 'user');

    const empData = {
      name: formData.name, email: formData.email, username: formData.email,
      role: resolvedRole, status: formData.status,
      mobile1: formData.mobile1, mobile2: formData.mobile2, alt_mobile: formData.alt_mobile,
      address: formData.address,
      photo_url: formData.photo_url, id_proof_url: formData.id_proof_url, address_proof_url: formData.address_proof_url
    };
    if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', editingId), empData);
        logAction('employees', 'update', editingId, empData, formData.name);
    } else {
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'employees'), { ...empData, created_at: serverTimestamp() });
        logAction('employees', 'create', docRef.id, empData, formData.name);
    }
    setIsModalOpen(false);
  };

  const handlePasswordChange = async () => {
    if (!can(role, 'employees', 'edit')) return alert('Access denied: insufficient permissions.');
    if (!newPassword) return alert("Enter password");
    const hashedPw = await hashPassword(newPassword);
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', selectedEmp.id), {
      password: hashedPw,
      password_hashed: true,
      password_updated_at: serverTimestamp()
    });
    logAction('employees', 'password_change', selectedEmp.id, {}, selectedEmp.name);
    alert("Password updated"); setPasswordModalOpen(false); setNewPassword('');
  };

  const handleUnlock = async (id) => {
    if (!can(role, 'employees', 'edit')) return alert('Access denied: insufficient permissions.');
    if(!confirm("Unlock this account?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), {
        is_locked: false,
        failed_login_attempts: 0
    });
    logAction('employees', 'unlock', id, {}, 'Account Unlocked');
  };

  const updateStatus = async (id, status) => {
    if (!can(role, 'employees', 'edit')) return alert('Access denied: insufficient permissions.');
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), { status });
    logAction('employees', 'status_change', id, { status }, `Status: ${status}`);
  };

  const handleDelete = async (emp) => {
    if (!can(role, 'employees', 'delete')) return alert('Access denied: only Admin can delete employees.');
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
    if (!can(role, 'finance', 'create')) return alert('Access denied: insufficient permissions.');
    if(!advanceForm.amount) return alert("Enter amount");
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
      alert(`Advance of ${advanceForm.amount} recorded for ${selectedEmp.name}`);
      setIsAdvanceModalOpen(false);
      setAdvanceForm({ amount: '', date: new Date().toISOString().split('T')[0], remarks: '' });
    } catch (e) {
      console.error(e);
      alert("Error saving advance");
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

  const generateStatementToken = () => {
    if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  };

  const handleStatementLink = async (emp) => {
    if (!can(role, 'employees', 'edit')) return alert('Access denied: insufficient permissions.');
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

  const toggleStatementLink = async (emp, enabled) => {
    if (!can(role, 'employees', 'edit')) return alert('Access denied: insufficient permissions.');
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), {
      statement_link_enabled: enabled
    });
    logAction('employees', enabled ? 'enable_statement_link' : 'disable_statement_link', emp.id, {}, emp.name);
    setStatementLinkModal(prev => ({ ...prev, employee: { ...prev.employee, statement_link_enabled: enabled } }));
  };

  const setStatementExpiry = async (emp, days) => {
    if (!can(role, 'employees', 'edit')) return alert('Access denied: insufficient permissions.');
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), {
      statement_link_expires_at: expiresAt
    });
    logAction('employees', 'set_statement_expiry', emp.id, { days }, emp.name);
    alert(days ? `Link will expire in ${days} days.` : 'Expiry removed. Link is now permanent.');
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
            <div className="flex gap-2 pt-1">
              {emp.id_proof_url && <span title="ID Proof Attached" className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100">ID</span>}
              {emp.address_proof_url && <span title="Addr Proof Attached" className="text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded border border-purple-100">Addr</span>}
            </div>
          </div>
          <div className="mt-4 pt-2 flex gap-2">
            <button onClick={() => openEdit(emp)} className="flex-1 rounded border border-indigo-300 bg-indigo-50 text-indigo-700 py-1 text-xs font-medium hover:bg-indigo-100">Edit</button>
            <button onClick={() => { setSelectedEmp(emp); setPasswordModalOpen(true); }} className="flex-1 rounded border border-amber-300 bg-amber-50 text-amber-700 py-1 text-xs font-medium hover:bg-amber-100 flex justify-center gap-1"><Key size={12}/> Pass</button>
            {role === 'admin' && (
              <button onClick={() => handleDelete(emp)} className="flex-1 rounded border border-red-300 bg-red-50 text-red-600 py-1 text-xs font-medium hover:bg-red-100">Delete</button>
            )}
          </div>
          {(role === 'admin' || role === 'manager') && (
             <div className="flex gap-2 mt-2">
               <button onClick={() => { setSelectedEmp(emp); setIsAdvanceModalOpen(true); }} className="flex-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-100 py-1 text-xs font-medium hover:bg-emerald-100 flex items-center justify-center gap-1"><Wallet size={12} /> Advance</button>
               <button onClick={() => { setSelectedEmp(emp); setIsHistoryOpen(true); }} className="flex-1 rounded bg-slate-50 text-slate-700 border border-slate-100 py-1 text-xs font-medium hover:bg-slate-100 flex items-center justify-center gap-1"><History size={12} /> View</button>
             </div>
          )}
          {(role === 'admin' || role === 'manager') && (
             <div className="mt-2">
               <button onClick={() => handleStatementLink(emp)} className="w-full rounded bg-violet-50 text-violet-700 border border-violet-100 py-1 text-xs font-medium hover:bg-violet-100 flex items-center justify-center gap-1"><Link2 size={12} /> Payment Statement Link</button>
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
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-bold text-slate-700">Full Name</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Address</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div></div>
          <div className="grid grid-cols-3 gap-3">
             <div><label className="text-xs font-bold text-slate-700">Mobile 1</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.mobile1} onChange={e => setFormData({...formData, mobile1: e.target.value})} /></div>
             <div><label className="text-xs font-bold text-slate-700">Mobile 2</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.mobile2} onChange={e => setFormData({...formData, mobile2: e.target.value})} /></div>
             <div><label className="text-xs font-bold text-slate-700">Alt Mobile</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.alt_mobile} onChange={e => setFormData({...formData, alt_mobile: e.target.value})} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-bold text-slate-700">Email</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Role</label><select className="w-full rounded border border-slate-300 p-2 text-black" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})} disabled={role !== 'admin'}><option value="admin">Owner</option><option value="accountant">Accountant</option><option value="manager">Project Manager</option><option value="tech">Field Tech</option><option value="user">General User</option></select>{role !== 'admin' && <p className="text-xs text-slate-400 mt-1">Only the Owner can change roles.</p>}</div></div>

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
      {/* Statement Link Modal */}
      <Modal isOpen={statementLinkModal.isOpen} onClose={() => setStatementLinkModal({ isOpen: false, employee: null, link: '' })} title={`Payment Statement Link: ${statementLinkModal.employee?.name || ''}`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Share this link with the employee so they can view their payment statement (payouts &amp; advances) anytime.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={statementLinkModal.link} className="flex-1 rounded border border-slate-300 p-2 text-sm text-black bg-slate-50 truncate" />
            <button onClick={() => { navigator.clipboard.writeText(statementLinkModal.link); alert('Link copied!'); }} className="rounded bg-indigo-600 text-white px-3 py-2 text-sm hover:bg-indigo-700 flex items-center gap-1"><Copy size={14} /> Copy</button>
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
