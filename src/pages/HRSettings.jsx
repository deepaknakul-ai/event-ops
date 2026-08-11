import React, { useState } from 'react';
import { Settings, MapPin, Shield, Clock, AlertTriangle, EyeOff } from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { appId } from '../utils/constants';
import { can } from '../utils/permissions';

const renderField = (label, field, form, setForm, type = 'text', suffix, min) => (
  <div>
    <label className="text-xs font-bold text-slate-700">{label}</label>
    <div className="flex items-center gap-2">
      <input
        type={type}
        min={min}
        className="w-full rounded border border-slate-300 p-2 text-sm text-black"
        value={form[field] ?? ''}
        onChange={e => setForm({ ...form, [field]: type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value })}
      />
      {suffix && <span className="text-xs text-slate-500 whitespace-nowrap">{suffix}</span>}
    </div>
  </div>
);

const renderToggle = (label, field, form, setForm, description) => (
  <div className="flex items-center justify-between py-2">
    <div>
      <div className="text-sm font-medium text-slate-800">{label}</div>
      {description && <div className="text-xs text-slate-500">{description}</div>}
    </div>
    <button
      onClick={() => setForm({ ...form, [field]: !form[field] })}
      className={`relative w-11 h-6 rounded-full transition-colors ${form[field] ? 'bg-indigo-600' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${form[field] ? 'translate-x-5' : ''}`} />
    </button>
  </div>
);

const HRSettings = ({ hqSettings, role, db, logAction, addToast }) => {
  const [form, setForm] = useState({ ...hqSettings });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!can(role, 'hr_settings', 'edit')) return addToast('Access denied.', 'error');
    setSaving(true);
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'hq'), form);
      logAction('settings', 'update_hq', 'hq', form, 'HQ settings updated');
      addToast('HQ settings saved successfully', 'success');
    } catch (e) {
      console.error(e);
      addToast('Error saving settings', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Settings size={24} /> HR Settings</h2>
        <button onClick={handleSave} disabled={saving} className="rounded bg-indigo-600 px-5 py-2 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* HQ Location */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2"><MapPin size={18} className="text-indigo-600" /> HQ Location</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {renderField("Latitude", "lat", form, setForm, "number")}
          {renderField("Longitude", "lng", form, setForm, "number")}
        </div>
        <p className="text-xs text-slate-500 mt-2">Default: New Delhi (28.6139, 77.2090). Update to your office coordinates.</p>
      </div>

      {/* Geofence Settings */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2"><Shield size={18} className="text-red-500" /> Geofencing</h3>
        {renderField("Geofence Radius", "geoRadiusMeters", form, setForm, "number", "meters", 50)}
        <div className="mt-3 space-y-1">
          {renderToggle("Strict Mode", "strictMode", form, setForm, "Block check-in outside geofence radius (vs. allow with penalty)")}
        </div>
        {renderField("Geo-Penalty Minutes", "geoPenaltyMinutes", form, setForm, "number", "minutes", 0)}
        <p className="text-xs text-slate-500 mt-2 flex items-center gap-1"><AlertTriangle size={12} /> Penalty deducted from shift hours when checking in outside geofence radius.</p>
      </div>

      {/* Time Window */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2"><Clock size={18} className="text-blue-500" /> Time Window & Shifts</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {renderField("Window Start", "windowStart", form, setForm, "time")}
          {renderField("Window End", "windowEnd", form, setForm, "time")}
        </div>
        <div className="mt-3 space-y-1">
          {renderToggle("Enforce Time Window", "enforceTime", form, setForm, "Require check-in within time window (±grace minutes)")}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
          {renderField("Grace Minutes", "graceMinutes", form, setForm, "number", "min", 0)}
          {renderField("Max Shift Hours", "maxShiftHours", form, setForm, "number", "hours", 1)}
          {renderField("Auto-Close Hours", "autoCloseHours", form, setForm, "number", "hours", 1)}
        </div>
        <p className="text-xs text-slate-500 mt-2">Shifts open longer than Auto-Close threshold will be automatically closed.</p>
      </div>

      {/* Shift Fraud Prevention */}
      <div className="rounded-xl border bg-white p-5 shadow-sm border-red-200">
        <h3 className="text-base font-semibold text-slate-800 mb-1 flex items-center gap-2"><EyeOff size={18} className="text-red-600" /> Shift Fraud Prevention</h3>
        <p className="text-xs text-slate-500 mb-4">Controls to detect and block intentional late check-outs used to inflate working hours.</p>
        <div className="space-y-1 divide-y divide-slate-100">
          {renderToggle("Block Checkout Beyond Max Hours", "enforceMaxShift", form, setForm, "If ON, employees CANNOT check out once shift exceeds Max Shift Hours — admin must force-close. Prevents staff from staying logged in all night.")}
          {renderToggle("Require Reason for Late Checkout", "requireLateReason", form, setForm, "If ON, a mandatory reason is required when checkout happens after Max Shift Hours threshold.")}
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {renderField("Suspicious Checkout Hour (24h)", "suspiciousCheckoutHour", form, setForm, "number", "e.g. 22 = 10 PM", 0)}
          <div>
            <label className="text-xs font-bold text-slate-700">Flag Description</label>
            <p className="text-xs text-slate-500 mt-1 p-2 rounded bg-slate-50">Checkouts recorded after this hour (e.g. 10 PM) will be flagged as night checkouts in the Working Hours Audit report and attendance log, even if hours are within limit.</p>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 flex gap-2">
          <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800">Example: Show ended at 1 PM but employee checks out 11 PM — system will flag this as a night checkout and (if Block is ON) will have prevented the checkout entirely after <strong>{form.maxShiftHours || 12} hours</strong> from check-in.</p>
        </div>
      </div>
    </div>
  );
};

export default HRSettings;
