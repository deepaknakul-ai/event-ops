import React, { useState, useEffect } from 'react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { hashPassword, verifyPassword } from '../utils/helpers';

const ProfileSettings = ({ employee, db, appId, logAction }) => {
  const [formData, setFormData] = useState({ name: '', mobile1: '', mobile2: '', address: '', email: '' });
  const [passForm, setPassForm] = useState({ current: '', new: '', confirm: '' });

  useEffect(() => {
    if (employee) {
      setFormData({
        name: employee.name || '', email: employee.email || '',
        mobile1: employee.mobile1 || '', mobile2: employee.mobile2 || '', address: employee.address || ''
      });
    }
  }, [employee]);

  const handleUpdateDetails = async () => {
    if (!employee) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', employee.id), {
        name: formData.name, mobile1: formData.mobile1, mobile2: formData.mobile2, address: formData.address, updated_at: serverTimestamp()
      });
      logAction('employees', 'profile_update', employee.id, formData, employee.name);
      alert("Profile updated successfully.");
    } catch (e) { console.error(e); alert("Error updating profile."); }
  };

  const handleChangePassword = async () => {
    if (!passForm.current || !passForm.new || !passForm.confirm) return alert("All fields required");
    if (passForm.new !== passForm.confirm) return alert("New passwords do not match");
    
    const storedPass = employee.password;
    if (!storedPass) return alert('No password on record. Ask admin to set your password first.');
    const currentMatch = await verifyPassword(passForm.current, storedPass);
    if (!currentMatch) return alert('Incorrect current password');

    try {
      const hashedNew = await hashPassword(passForm.new);
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', employee.id), {
        password: hashedNew, password_hashed: true, password_updated_at: serverTimestamp()
      });
      logAction('employees', 'password_change_self', employee.id, {}, employee.name);
      alert("Password changed successfully.");
      setPassForm({ current: '', new: '', confirm: '' });
    } catch (e) { console.error(e); alert("Error changing password."); }
  };

  if (!employee) return <div className="p-8 text-center text-slate-500">Profile not available. Please contact admin.</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">My Profile</h2>

      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h3 className="font-bold text-lg mb-4 text-slate-700">Personal Details</h3>
        <div className="space-y-4">
           <div><label className="block text-sm font-bold text-slate-700">Full Name</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
           <div><label className="block text-sm font-bold text-black">Email (Read-Only)</label><input className="w-full rounded border border-slate-300 p-2 bg-slate-50 text-slate-500" value={formData.email} disabled /></div>
           <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-bold text-slate-700">Mobile 1</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.mobile1} onChange={e => setFormData({...formData, mobile1: e.target.value})} /></div><div><label className="block text-sm font-bold text-slate-700">Mobile 2</label><input className="w-full rounded border border-slate-300 p-2 text-black" value={formData.mobile2} onChange={e => setFormData({...formData, mobile2: e.target.value})} /></div></div>
           <div><label className="block text-sm font-bold text-slate-700">Address</label><textarea className="w-full rounded border border-slate-300 p-2 text-black" rows={2} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
           <button onClick={handleUpdateDetails} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700">Save Changes</button>
        </div>
      </div>
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h3 className="font-bold text-lg mb-4 text-slate-700">Security</h3>
        <div className="space-y-4 max-w-md"><div><label className="block text-sm font-bold text-slate-700">Current Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-black" value={passForm.current} onChange={e => setPassForm({...passForm, current: e.target.value})} /></div><div><label className="block text-sm font-bold text-slate-700">New Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-black" value={passForm.new} onChange={e => setPassForm({...passForm, new: e.target.value})} /></div><div><label className="block text-sm font-bold text-slate-700">Confirm New Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-black" value={passForm.confirm} onChange={e => setPassForm({...passForm, confirm: e.target.value})} /></div><button onClick={handleChangePassword} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700">Update Password</button></div>
      </div>
    </div>
  );
};

export default ProfileSettings;
