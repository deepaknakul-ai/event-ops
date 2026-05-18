import React, { useState, useEffect } from 'react';
import { Download, Upload, Briefcase, Calendar, Shield, ImageIcon as Image, CreditCard, Plus, Trash2, Edit, CheckCircle, Lock, Users, LockKeyhole, Unlock, Tag, X } from 'lucide-react';
import { collection, getDocs, doc, getDoc, setDoc, addDoc } from 'firebase/firestore';
import { ConfirmDeleteModal } from '../components/Shared';
import { can } from '../utils/permissions';
import { getFinancialYear } from '../utils/helpers';
import { CATEGORIES, EXPENSE_CATS } from '../utils/constants';
import RBACManager from './RBACManager';

const DEFAULT_CALENDAR_STATUS_BG = {
  Quoted: '#e0e7ff',
  Confirmed: '#dbeafe',
  Ongoing: '#fef9c3',
  Completed: '#dcfce7',
  Closed: '#f3f4f6',
  Cancelled: '#fee2e2'
};

const DEFAULT_CALENDAR_INVOICE_TEXT = {
  Invoiced: '',
  'Not Invoiced': ''
};

const CALENDAR_STATUS_OPTIONS = ['Quoted', 'Confirmed', 'Ongoing', 'Completed', 'Closed', 'Cancelled'];
const CALENDAR_INVOICE_OPTIONS = ['Invoiced', 'Not Invoiced'];

const AdminTools = ({ db, appId, logAction, role }) => {
  if (!can(role, 'admin_tools', 'view')) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock size={40} className="text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-700 mb-2">Access Restricted</h2>
        <p className="text-slate-500 text-sm">Admin Tools are only accessible to the Owner.</p>
      </div>
    );
  }
  const [backupStatus, setBackupStatus] = useState('idle');
  const [restoreStatus, setRestoreStatus] = useState('idle');
  const [securityForm, setSecurityForm] = useState({ admin_password: '', recovery_key: '' });
  const [orgForm, setOrgForm] = useState({ name: '', address: '', pan: '', gstin: '', logo: '', currency: 'INR', email: '', phone: '', po_terms: '', challan_terms: '', payment_terms: '', invoice_terms: '', gst_api_key: '', expense_proof_threshold: 0, expense_proof_max_size_mb: 2 });
  const [bankAccounts, setBankAccounts] = useState([]);
  const [defaultBankId, setDefaultBankId] = useState('');
  const [bankForm, setBankForm] = useState({ bank_name: '', account_name: '', account_no: '', ifsc: '', branch: '', upi_id: '' });
  const [editingBankId, setEditingBankId] = useState(null);
  const [showBankForm, setShowBankForm] = useState(false);
  const [calendarColors, setCalendarColors] = useState({
    statusColors: { ...DEFAULT_CALENDAR_STATUS_BG },
    invoiceTextColors: { ...DEFAULT_CALENDAR_INVOICE_TEXT }
  });
  const [isSavingCalendarColors, setIsSavingCalendarColors] = useState(false);
  const [lockedFYs, setLockedFYs] = useState([]);
  const [isSavingFYLock, setIsSavingFYLock] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [activeTab, setActiveTab] = useState('system');
  // Categories state
  const [customInventoryCats, setCustomInventoryCats] = useState([]);
  const [customExpenseCats, setCustomExpenseCats] = useState([]);
  const [newInventoryCat, setNewInventoryCat] = useState('');
  const [newExpenseCat, setNewExpenseCat] = useState('');
  const [isSavingCats, setIsSavingCats] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
        try {
            const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'));
            if (docSnap.exists()) {
                setSecurityForm(docSnap.data());
            }
            const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
            if (orgSnap.exists()) {
                const orgData = orgSnap.data();
                setOrgForm({ name: orgData.name||'', address: orgData.address||'', pan: orgData.pan||'', gstin: orgData.gstin||'', logo: orgData.logo||'', currency: orgData.currency||'INR', email: orgData.email||'', phone: orgData.phone||'', po_terms: orgData.po_terms||'', challan_terms: orgData.challan_terms||'', payment_terms: orgData.payment_terms||'', invoice_terms: orgData.invoice_terms||'', gst_api_key: orgData.gst_api_key||'', expense_proof_threshold: orgData.expense_proof_threshold || 0, expense_proof_max_size_mb: orgData.expense_proof_max_size_mb || 2 });
                setBankAccounts(orgData.bank_accounts || []);
                setDefaultBankId(orgData.default_bank_id || '');
                const storedColors = orgData?.calendar_color_settings || {};
                setCalendarColors({
                  statusColors: { ...DEFAULT_CALENDAR_STATUS_BG, ...(storedColors.statusColors || {}) },
                  invoiceTextColors: { ...DEFAULT_CALENDAR_INVOICE_TEXT, ...(storedColors.invoiceTextColors || {}) }
                });
                setLockedFYs(orgData.locked_fys || []);
            }
            const catsSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'categories'));
            if (catsSnap.exists()) {
                setCustomInventoryCats(catsSnap.data().inventory_categories || []);
                setCustomExpenseCats(catsSnap.data().expense_categories || []);
            }
        } catch (e) { console.error(e); }
    };
    fetchSettings();
  }, [db, appId]);

  const collections = ['projects', 'clients', 'inventory', 'expenses', 'employees', 'advances', 'payments', 'payouts', 'audit_logs'];

  const handleBackup = async () => {
    setBackupStatus('loading');
    try {
      const backupData = {};
      for (const colName of collections) {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', colName));
        backupData[colName] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }

      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rental_ops_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setBackupStatus('success');
      logAction('admin', 'backup', 'system', {}, 'Full System Backup');
    } catch (error) {
      console.error(error);
      setBackupStatus('error');
    }
    setTimeout(() => setBackupStatus('idle'), 3000);
  };

  const handleRestore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm("WARNING: This will overwrite existing data with the same IDs. Continue?")) {
        e.target.value = null;
        return;
    }

    setRestoreStatus('loading');
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);

        for (const colName of Object.keys(data)) {
          if (!collections.includes(colName)) continue;

          const items = data[colName];
          for (const item of items) {
            const { id, ...docData } = item;
            if (id) {
               await setDoc(doc(db, 'artifacts', appId, 'public', 'data', colName, id), docData);
            } else {
               await addDoc(collection(db, 'artifacts', appId, 'public', 'data', colName), docData);
            }
          }
        }
        setRestoreStatus('success');
        alert("Restore completed successfully. Please refresh the page.");
        logAction('admin', 'restore', 'system', {}, 'Full System Restore');
      } catch (error) {
        console.error(error);
        setRestoreStatus('error');
        alert("Error during restore. Check console.");
      }
      e.target.value = null;
      setTimeout(() => setRestoreStatus('idle'), 3000);
    };
    reader.readAsText(file);
  };

  const handleUpdateSecurity = async () => {
    if (!securityForm.admin_password || !securityForm.recovery_key) return alert("Both Password and Recovery Key are required.");
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'), securityForm);
    logAction('admin', 'update_security', 'security', {}, 'Updated Admin Credentials');
    alert("Admin Security Settings Updated Successfully.");
  };

  const handleSaveOrgSettings = async () => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'), orgForm, { merge: true });
    logAction('admin', 'update_org', 'organization', {}, 'Updated Organization Details');
    alert("Organization Details Updated.");
  };

  const handleAddOrUpdateBank = () => {
    const { bank_name, account_name, account_no, ifsc } = bankForm;
    if (!bank_name || !account_name || !account_no || !ifsc) return alert('Bank Name, Account Name, Account Number, and IFSC are required.');
    if (editingBankId) {
      setBankAccounts(prev => prev.map(b => b.id === editingBankId ? { ...bankForm, id: editingBankId } : b));
      setEditingBankId(null);
    } else {
      const newBank = { ...bankForm, id: Date.now().toString() };
      setBankAccounts(prev => {
        const updated = [...prev, newBank];
        if (updated.length === 1) setDefaultBankId(newBank.id); // auto-default first bank
        return updated;
      });
    }
    setBankForm({ bank_name: '', account_name: '', account_no: '', ifsc: '', branch: '', upi_id: '' });
    setShowBankForm(false);
  };

  const handleDeleteBank = (bankId) => {
    const bank = bankAccounts.find(b => b.id === bankId);
    setDeleteConfirm({
      isOpen: true,
      title: 'Delete Bank Account',
      message: `Remove bank account "${bank?.bank_name || 'this account'}"? This will also unset it as default if selected.`,
      onConfirm: () => {
        setBankAccounts(prev => prev.filter(b => b.id !== bankId));
        if (defaultBankId === bankId) setDefaultBankId('');
      }
    });
  };

  const handleEditBank = (bank) => {
    setBankForm({ bank_name: bank.bank_name, account_name: bank.account_name, account_no: bank.account_no, ifsc: bank.ifsc, branch: bank.branch||'', upi_id: bank.upi_id||'' });
    setEditingBankId(bank.id);
    setShowBankForm(true);
  };

  const handleSaveBankSettings = async () => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'), { bank_accounts: bankAccounts, default_bank_id: defaultBankId }, { merge: true });
    logAction('admin', 'update_banks', 'organization', {}, 'Updated Bank Accounts');
    alert('Bank account settings saved.');
  };

  const handleSaveCalendarColors = async () => {
    try {
      setIsSavingCalendarColors(true);
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'),
        { calendar_color_settings: calendarColors },
        { merge: true }
      );
      logAction('admin', 'update_calendar_colors', 'organization', {}, 'Updated Calendar Colors');
      alert('Calendar colors saved.');
    } catch (error) {
      console.error(error);
      alert('Failed to save calendar colors.');
    } finally {
      setIsSavingCalendarColors(false);
    }
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
        if (file.size > 500000) return alert("File too large. Max 500KB.");
        const reader = new FileReader();
        reader.onloadend = () => {
            setOrgForm(prev => ({ ...prev, logo: reader.result }));
        };
        reader.readAsDataURL(file);
    }
  };

  // --- FY Lock helpers ---
  const generateFYOptions = () => {
    const currentFY = getFinancialYear();
    const [startYear] = currentFY.split('-').map(Number);
    const fys = [];
    for (let i = 0; i < 6; i++) {
      const yr = startYear - i;
      fys.push(`${yr}-${String(yr + 1).slice(-2)}`);
    }
    return fys;
  };

  const handleToggleFYLock = (fy) => {
    if (lockedFYs.includes(fy)) {
      setLockedFYs(prev => prev.filter(f => f !== fy));
    } else {
      if (fy === getFinancialYear()) {
        if (!confirm(`You are about to lock the CURRENT financial year (${fy}). This will prevent any new transactions until unlocked. Continue?`)) return;
      }
      setLockedFYs(prev => [...prev, fy]);
    }
  };

  const handleSaveFYLock = async () => {
    try {
      setIsSavingFYLock(true);
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'),
        { locked_fys: lockedFYs },
        { merge: true }
      );
      logAction('admin', 'update_fy_lock', 'organization', { locked_fys: lockedFYs }, 'Updated FY Lock settings');
      alert('FY Lock settings saved.');
    } catch (error) {
      console.error(error);
      alert('Failed to save FY Lock settings.');
    } finally {
      setIsSavingFYLock(false);
    }
  };

  const handleSaveCategories = async () => {
    try {
      setIsSavingCats(true);
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'categories'),
        { inventory_categories: customInventoryCats, expense_categories: customExpenseCats }
      );
      logAction('admin', 'update_categories', 'settings', {}, 'Updated custom categories');
      alert('Categories saved. Reload the app to see them everywhere.');
    } catch (error) {
      console.error(error);
      alert('Failed to save categories.');
    } finally {
      setIsSavingCats(false);
    }
  };

  return (
    <div className="space-y-6">
       <h2 className="text-2xl font-bold text-slate-800">Admin Tools</h2>

       {/* ── Tab navigation ── */}
       <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
         <button
           onClick={() => setActiveTab('system')}
           className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
             activeTab === 'system'
               ? 'bg-white text-slate-800 shadow-sm'
               : 'text-slate-500 hover:text-slate-700'
           }`}
         >
           <Briefcase size={15} /> System Settings
         </button>
         <button
           onClick={() => setActiveTab('rbac')}
           className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
             activeTab === 'rbac'
               ? 'bg-white text-slate-800 shadow-sm'
               : 'text-slate-500 hover:text-slate-700'
           }`}
         >
           <Users size={15} /> Roles &amp; Permissions
         </button>
         <button
           onClick={() => setActiveTab('categories')}
           className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
             activeTab === 'categories'
               ? 'bg-white text-slate-800 shadow-sm'
               : 'text-slate-500 hover:text-slate-700'
           }`}
         >
           <Tag size={15} /> Categories
         </button>
       </div>

       {/* ── Roles & Permissions Matrix tab ── */}
       {activeTab === 'rbac' && (
         <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
           <RBACManager db={db} appId={appId} logAction={logAction} />
         </div>
       )}

       {/* ── Categories tab ── */}
       {activeTab === 'categories' && (
         <div className="space-y-6">
           <div className="grid md:grid-cols-2 gap-6">
             {/* Inventory Categories */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
               <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Tag size={18} /> Inventory Categories</h3>
               <p className="text-xs text-slate-500 mb-4">Default categories are always present. Add custom categories for your specific equipment types.</p>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Defaults (read-only)</p>
                 <div className="flex flex-wrap gap-1.5">
                   {CATEGORIES.map(c => (
                     <span key={c} className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">{c}</span>
                   ))}
                 </div>
               </div>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Custom Categories</p>
                 {customInventoryCats.length === 0 && <p className="text-xs text-slate-400 italic">No custom categories yet.</p>}
                 <div className="flex flex-wrap gap-1.5">
                   {customInventoryCats.map(c => (
                     <span key={c} className="flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded text-xs font-medium">
                       {c}
                       <button type="button" onClick={() => setCustomInventoryCats(prev => prev.filter(x => x !== c))} className="text-indigo-400 hover:text-red-500 ml-1"><X size={11} /></button>
                     </span>
                   ))}
                 </div>
               </div>
               <div className="flex gap-2">
                 <input
                   type="text"
                   className="flex-1 rounded border border-slate-300 p-2 text-sm text-black bg-white"
                   placeholder="e.g. Drones, Rigging..."
                   value={newInventoryCat}
                   onChange={e => setNewInventoryCat(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && newInventoryCat.trim()) { const v = newInventoryCat.trim(); if (!CATEGORIES.includes(v) && !customInventoryCats.includes(v)) setCustomInventoryCats(prev => [...prev, v]); setNewInventoryCat(''); } }}
                 />
                 <button
                   type="button"
                   onClick={() => { const v = newInventoryCat.trim(); if (v && !CATEGORIES.includes(v) && !customInventoryCats.includes(v)) { setCustomInventoryCats(prev => [...prev, v]); setNewInventoryCat(''); } }}
                   className="flex items-center gap-1 px-3 py-2 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                 ><Plus size={14} /> Add</button>
               </div>
             </div>

             {/* Expense Categories */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
               <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Tag size={18} /> Expense Categories</h3>
               <p className="text-xs text-slate-500 mb-4">Default expense types are always present. Add custom categories to match your finance workflow.</p>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Defaults (read-only)</p>
                 <div className="flex flex-wrap gap-1.5">
                   {EXPENSE_CATS.map(c => (
                     <span key={c} className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">{c}</span>
                   ))}
                 </div>
               </div>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Custom Categories</p>
                 {customExpenseCats.length === 0 && <p className="text-xs text-slate-400 italic">No custom categories yet.</p>}
                 <div className="flex flex-wrap gap-1.5">
                   {customExpenseCats.map(c => (
                     <span key={c} className="flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-medium">
                       {c}
                       <button type="button" onClick={() => setCustomExpenseCats(prev => prev.filter(x => x !== c))} className="text-green-400 hover:text-red-500 ml-1"><X size={11} /></button>
                     </span>
                   ))}
                 </div>
               </div>
               <div className="flex gap-2">
                 <input
                   type="text"
                   className="flex-1 rounded border border-slate-300 p-2 text-sm text-black bg-white"
                   placeholder="e.g. Equipment Hire, Insurance..."
                   value={newExpenseCat}
                   onChange={e => setNewExpenseCat(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && newExpenseCat.trim()) { const v = newExpenseCat.trim(); if (!EXPENSE_CATS.includes(v) && !customExpenseCats.includes(v)) setCustomExpenseCats(prev => [...prev, v]); setNewExpenseCat(''); } }}
                 />
                 <button
                   type="button"
                   onClick={() => { const v = newExpenseCat.trim(); if (v && !EXPENSE_CATS.includes(v) && !customExpenseCats.includes(v)) { setCustomExpenseCats(prev => [...prev, v]); setNewExpenseCat(''); } }}
                   className="flex items-center gap-1 px-3 py-2 rounded bg-green-600 text-white text-sm hover:bg-green-700"
                 ><Plus size={14} /> Add</button>
               </div>
             </div>
           </div>
           <button
             onClick={handleSaveCategories}
             disabled={isSavingCats}
             className="bg-indigo-600 text-white px-8 py-2.5 rounded-lg hover:bg-indigo-700 disabled:bg-indigo-300 font-medium"
           >
             {isSavingCats ? 'Saving...' : 'Save All Categories'}
           </button>
         </div>
       )}

       {/* ── System Settings tab ── */}
       {activeTab === 'system' && <><div className="grid md:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><Download size={20} /> Backup Data</h3>
             <p className="text-slate-500 text-sm mb-4">Download a full JSON backup of all system data (Projects, Clients, Inventory, etc).</p>
             <button onClick={handleBackup} disabled={backupStatus === 'loading'} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {backupStatus === 'loading' ? 'Generating Backup...' : 'Download Backup'}
             </button>
             {backupStatus === 'success' && <span className="ml-3 text-green-600 text-sm font-medium">Backup Downloaded!</span>}
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><Upload size={20} /> Restore Data</h3>
             <p className="text-slate-500 text-sm mb-4">Upload a previously generated JSON backup file. Existing records with matching IDs will be updated.</p>
             <div className="relative">
                <input type="file" accept=".json" onChange={handleRestore} disabled={restoreStatus === 'loading'} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
             </div>
             {restoreStatus === 'loading' && <div className="mt-2 text-indigo-600 text-sm">Restoring data... please wait...</div>}
             {restoreStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Restore Complete!</div>}
          </div>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Briefcase size={20} /> Organization Settings</h3>
            <div className="grid md:grid-cols-2 gap-4">
                <div><label className="block text-sm font-bold text-slate-700 mb-1">Company Name</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.name} onChange={e => setOrgForm({...orgForm, name: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">GSTIN</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.gstin} onChange={e => setOrgForm({...orgForm, gstin: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">PAN</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.pan} onChange={e => setOrgForm({...orgForm, pan: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">Currency Symbol</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.currency} onChange={e => setOrgForm({...orgForm, currency: e.target.value})} /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Address</label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={2} value={orgForm.address} onChange={e => setOrgForm({...orgForm, address: e.target.value})} /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">PO Standard Terms</label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={3} value={orgForm.po_terms || ''} onChange={e => setOrgForm({...orgForm, po_terms: e.target.value})} placeholder="Default terms for Purchase Orders..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Challan Standard Terms</label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={3} value={orgForm.challan_terms || ''} onChange={e => setOrgForm({...orgForm, challan_terms: e.target.value})} placeholder="Default terms for Challans..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Default Payment Terms <span className="text-indigo-500 font-normal">(used in Proforma Invoices)</span></label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={3} value={orgForm.payment_terms || ''} onChange={e => setOrgForm({...orgForm, payment_terms: e.target.value})} placeholder="e.g. 50% advance on confirmation, balance before delivery..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Invoice Terms &amp; Conditions <span className="text-indigo-500 font-normal">(printed on every Tax Invoice)</span></label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={4} value={orgForm.invoice_terms || ''} onChange={e => setOrgForm({...orgForm, invoice_terms: e.target.value})} placeholder="e.g. Payment due within 30 days. Goods once sold are not returnable. Subject to local jurisdiction..." /></div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-700 mb-1">
                    GST Portal API Key
                    <span className="text-xs text-slate-400 font-normal ml-1">(from api.gst.gov.in — used for GSTIN auto-lookup)</span>
                  </label>
                  <input
                    className="w-full rounded border border-slate-300 p-2 bg-white text-black font-mono text-sm placeholder-slate-400 focus:ring-2 focus:ring-indigo-500"
                    value={orgForm.gst_api_key || ''}
                    onChange={e => setOrgForm({...orgForm, gst_api_key: e.target.value})}
                    placeholder="Paste your GST Portal auth-token here"
                    autoComplete="off"
                  />
                  <p className="mt-1 text-xs text-slate-400">Used in GSTIN Lookup button on client/vendor forms. Leave blank to disable auto-lookup.</p>
                </div>

                <div className="md:col-span-2 border-t pt-4 mt-2">
                    <h4 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2"><Shield size={16} className="text-amber-600" /> Expense Proof Policy</h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-bold text-slate-700 mb-1">
                          Proof Required Above (₹)
                          <span className="text-xs text-slate-400 font-normal ml-1">(0 = never required)</span>
                        </label>
                        <input type="number" min="0" step="1" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.expense_proof_threshold} onChange={e => setOrgForm({...orgForm, expense_proof_threshold: parseFloat(e.target.value) || 0})} placeholder="e.g. 500" />
                        <p className="mt-1 text-xs text-slate-400">Employees must attach proof (invoice/bill/receipt) for expenses above this amount.</p>
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-700 mb-1">
                          Max File Size (MB)
                          <span className="text-xs text-slate-400 font-normal ml-1">(per upload)</span>
                        </label>
                        <input type="number" min="0.1" max="10" step="0.1" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.expense_proof_max_size_mb} onChange={e => setOrgForm({...orgForm, expense_proof_max_size_mb: parseFloat(e.target.value) || 2})} placeholder="2" />
                        <p className="mt-1 text-xs text-slate-400">Maximum allowed file size for expense proof uploads. Recommended: 2 MB.</p>
                      </div>
                    </div>
                </div>

                <div className="md:col-span-2 border-t pt-4 mt-2">
                    <label className="block text-sm font-bold text-slate-700 mb-2">Company Logo (Image)</label>
                    <div className="flex items-center gap-4">
                        <div className="h-16 w-16 border rounded flex items-center justify-center bg-slate-50 overflow-hidden">
                            {orgForm.logo ? <img src={orgForm.logo} alt="Logo" className="h-full w-full object-contain" /> : <Image className="text-slate-300"/>}
                        </div>
                        <input type="file" accept="image/*" onChange={handleLogoUpload} className="text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                    </div>
                </div>
            </div>
            <button onClick={handleSaveOrgSettings} className="mt-4 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">Save Organization Details</button>
       </div>

       {/* ===== BANK ACCOUNTS SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><CreditCard size={20} /> Bank Account Details</h3>
            <p className="text-sm text-slate-500 mb-4">Add your company bank accounts. The default account will be shown on Proforma Invoices.</p>

            {bankAccounts.length > 0 ? (
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm border border-slate-200 rounded-lg overflow-hidden">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-left p-3 text-slate-600 font-semibold">Bank Name</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">Account Name</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">Account No.</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">IFSC</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">Branch</th>
                      <th className="text-center p-3 text-slate-600 font-semibold">Default</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {bankAccounts.map(bank => (
                      <tr key={bank.id} className={`hover:bg-slate-50 transition ${bank.id === defaultBankId ? 'bg-green-50' : ''}`}>
                        <td className="p-3 font-medium text-slate-800">{bank.bank_name}</td>
                        <td className="p-3 text-slate-700">{bank.account_name}</td>
                        <td className="p-3 font-mono text-slate-700">{bank.account_no}</td>
                        <td className="p-3 font-mono text-slate-700">{bank.ifsc}</td>
                        <td className="p-3 text-slate-600">{bank.branch || '—'}</td>
                        <td className="p-3 text-center">
                          {bank.id === defaultBankId ? (
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs font-semibold"><CheckCircle size={14}/> Default</span>
                          ) : (
                            <button onClick={() => setDefaultBankId(bank.id)} className="text-xs text-slate-500 hover:text-indigo-600 underline">Set Default</button>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => handleEditBank(bank)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500" title="Edit"><Edit size={14}/></button>
                            <button onClick={() => handleDeleteBank(bank.id)} className="p-1.5 rounded hover:bg-red-50 text-red-400" title="Delete"><Trash2 size={14}/></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-sm text-slate-400 italic mb-4 p-4 bg-slate-50 rounded-lg border border-dashed border-slate-200">No bank accounts added yet.</div>
            )}

            {showBankForm ? (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mt-2">
                <div className="font-semibold text-slate-700 mb-3">{editingBankId ? 'Edit Bank Account' : 'Add New Bank Account'}</div>
                <div className="grid md:grid-cols-2 gap-3">
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Bank Name *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.bank_name} onChange={e=>setBankForm({...bankForm,bank_name:e.target.value})} placeholder="e.g. HDFC Bank" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Account Name *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.account_name} onChange={e=>setBankForm({...bankForm,account_name:e.target.value})} placeholder="Name as per bank records" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Account Number *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm font-mono" value={bankForm.account_no} onChange={e=>setBankForm({...bankForm,account_no:e.target.value})} placeholder="Account number" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">IFSC Code *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm font-mono uppercase" value={bankForm.ifsc} onChange={e=>setBankForm({...bankForm,ifsc:e.target.value.toUpperCase()})} placeholder="e.g. HDFC0001234" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Branch</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.branch} onChange={e=>setBankForm({...bankForm,branch:e.target.value})} placeholder="Branch name" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">UPI ID <span className="text-slate-400 font-normal">(optional)</span></label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.upi_id} onChange={e=>setBankForm({...bankForm,upi_id:e.target.value})} placeholder="optional@upi" /></div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={handleAddOrUpdateBank} className="bg-indigo-600 text-white px-4 py-2 rounded text-sm hover:bg-indigo-700">{editingBankId ? 'Update Bank' : 'Add Bank'}</button>
                  <button onClick={() => { setShowBankForm(false); setEditingBankId(null); setBankForm({ bank_name:'',account_name:'',account_no:'',ifsc:'',branch:'',upi_id:'' }); }} className="px-4 py-2 rounded border text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowBankForm(true)} className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800 font-medium mb-2"><Plus size={15}/> Add Bank Account</button>
            )}

            <button onClick={handleSaveBankSettings} className="mt-4 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">Save Bank Settings</button>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Calendar size={20} /> Calendar Color Settings</h3>
            <div className="grid md:grid-cols-2 gap-4">
                {CALENDAR_STATUS_OPTIONS.map(status => (
                  <div key={status} className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-700">{status} band</div>
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-5 rounded border border-slate-200" style={{ backgroundColor: calendarColors.statusColors[status] }}></div>
                      <input
                        type="color"
                        className="h-8 w-10 rounded border border-slate-200"
                        value={calendarColors.statusColors[status]}
                        onChange={(e) =>
                          setCalendarColors(prev => ({
                            ...prev,
                            statusColors: { ...prev.statusColors, [status]: e.target.value }
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
            </div>
            <div className="mt-6">
              <div className="text-sm font-semibold text-slate-700 mb-2">Closed Invoice Text Color</div>
              <div className="grid md:grid-cols-2 gap-4">
                {CALENDAR_INVOICE_OPTIONS.map(status => (
                  <div key={status} className="flex items-center justify-between gap-3">
                    <div className="text-sm text-slate-700">{status}</div>
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-5 rounded border border-slate-200 bg-slate-100" style={{ color: calendarColors.invoiceTextColors[status] || '#ffffff' }}>A</div>
                      <input
                        type="text"
                        className="w-28 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700"
                        placeholder="#RRGGBB (optional)"
                        value={calendarColors.invoiceTextColors[status]}
                        onChange={(e) =>
                          setCalendarColors(prev => ({
                            ...prev,
                            invoiceTextColors: { ...prev.invoiceTextColors, [status]: e.target.value }
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-xs text-slate-500">Applied only when status is Closed. Leave blank to keep default text color.</div>
            </div>
            <div className="mt-4">
              <button onClick={handleSaveCalendarColors} disabled={isSavingCalendarColors} className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {isSavingCalendarColors ? 'Saving...' : 'Save Calendar Colors'}
              </button>
            </div>
       </div>

       {/* ===== FY LOCK SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><LockKeyhole size={20} /> Financial Year Lock</h3>
            <p className="text-sm text-slate-500 mb-4">Lock past financial years to prevent adding, editing, or deleting transactions. Locked FYs are enforced across Finance, Expenses, and other modules.</p>
            <div className="space-y-2">
              {generateFYOptions().map(fy => {
                const isLocked = lockedFYs.includes(fy);
                const isCurrent = fy === getFinancialYear();
                return (
                  <div key={fy} className={`flex items-center justify-between p-3 rounded-lg border ${isLocked ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="flex items-center gap-3">
                      {isLocked ? <Lock size={16} className="text-red-500" /> : <Unlock size={16} className="text-green-500" />}
                      <span className="font-medium text-slate-800">FY {fy}</span>
                      {isCurrent && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Current</span>}
                    </div>
                    <button
                      onClick={() => handleToggleFYLock(fy)}
                      className={`px-3 py-1.5 rounded text-xs font-bold transition ${isLocked ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-red-600 text-white hover:bg-red-700'}`}
                    >
                      {isLocked ? 'Unlock' : 'Lock'}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button onClick={handleSaveFYLock} disabled={isSavingFYLock} className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {isSavingFYLock ? 'Saving...' : 'Save FY Lock Settings'}
              </button>
              {lockedFYs.length > 0 && <span className="text-xs text-slate-500">{lockedFYs.length} FY(s) locked</span>}
            </div>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Shield size={20} /> Admin Security</h3>
            <div className="grid md:grid-cols-2 gap-4 max-w-2xl">
                <div><label className="block text-sm font-bold text-slate-700 mb-1">New Admin Password</label><input type="text" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={securityForm.admin_password} onChange={e => setSecurityForm({...securityForm, admin_password: e.target.value})} placeholder="Set new password" /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">Recovery Key</label><input type="text" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={securityForm.recovery_key} onChange={e => setSecurityForm({...securityForm, recovery_key: e.target.value})} placeholder="Key to reset password" /></div>
            </div>
            <button onClick={handleUpdateSecurity} className="mt-4 bg-slate-800 text-white px-6 py-2 rounded hover:bg-slate-700">Update Credentials</button>
       </div>
       </>}

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

export default AdminTools;
