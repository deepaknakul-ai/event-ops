/**
 * RBACManager.jsx — Dynamic Roles & Permission Matrix
 *
 * Allows the admin to:
 *  - Toggle every permission (resource × action) for every role
 *  - Add custom roles with a chosen display name and badge color
 *  - Delete custom roles (built-in roles cannot be removed)
 *  - Save the matrix to Firestore (settings/rbac); changes apply instantly
 *    via setLiveConfig() — no page reload needed
 */
import React, { useState, useEffect } from 'react';
import { confirmDialog } from '../utils/dialog';
import { notify } from '../utils/toast';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import {
  Shield, Plus, Trash2, Save, RefreshCw, X,
  AlertTriangle, Info, Check, Users
} from 'lucide-react';
import {
  RESOURCE_DEFS,
  ACTION_LABELS,
  ROLE_LABELS,
  buildDefaultConfig,
  setLiveConfig,
} from '../utils/permissions';

// ── Color palette for custom role badges ──────────────────────────────────────
const COLOR_PALETTE = [
  { key: 'bg-red-500',     label: 'Red' },
  { key: 'bg-orange-500',  label: 'Orange' },
  { key: 'bg-amber-500',   label: 'Amber' },
  { key: 'bg-lime-600',    label: 'Lime' },
  { key: 'bg-emerald-600', label: 'Emerald' },
  { key: 'bg-teal-500',    label: 'Teal' },
  { key: 'bg-blue-500',    label: 'Blue' },
  { key: 'bg-indigo-500',  label: 'Indigo' },
  { key: 'bg-purple-500',  label: 'Purple' },
  { key: 'bg-pink-500',    label: 'Pink' },
  { key: 'bg-slate-500',   label: 'Gray' },
  { key: 'bg-slate-800',   label: 'Dark' },
];

// ── Roles that cannot be deleted ──────────────────────────────────────────────
const BUILT_IN_ROLES = ['admin', 'accountant', 'manager', 'tech', 'user'];

// ── tiny toggle switch ────────────────────────────────────────────────────────
const Toggle = ({ checked, onChange, title }) => (
  <button
    type="button"
    onClick={onChange}
    title={title}
    className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
      checked ? 'bg-emerald-500' : 'bg-slate-200'
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ease-in-out ${
        checked ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);

// ── Role badge ────────────────────────────────────────────────────────────────
const RoleBadge = ({ label, color, size = 'sm' }) => (
  <span
    className={`inline-block font-semibold text-white rounded-full px-2 py-0.5 ${color} ${
      size === 'xs' ? 'text-xs' : 'text-xs'
    }`}
  >
    {label}
  </span>
);

// ── Main component ────────────────────────────────────────────────────────────
const RBACManager = ({ db, appId, logAction }) => {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRole, setNewRole] = useState({ id: '', label: '', color: 'bg-blue-500' });
  const [savedOk, setSavedOk] = useState(false);
  // column hover highlight
  const [hoverCol, setHoverCol] = useState(null);

  // ── Load from Firestore ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const snap = await getDoc(
          doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'rbac')
        );
        if (snap.exists()) {
          // Merge: ensure any new resources/actions added since last save are present
          const saved = snap.data();
          const defaults = buildDefaultConfig();
          // Add missing resources/actions to saved data without overwriting existing choices
          const merged = { ...saved };
          Object.keys(defaults.permissions).forEach(role => {
            if (!merged.permissions[role]) merged.permissions[role] = {};
            Object.entries(RESOURCE_DEFS).forEach(([resource, def]) => {
              if (!merged.permissions[role][resource]) merged.permissions[role][resource] = {};
              def.actions.forEach(action => {
                if (merged.permissions[role][resource][action] === undefined) {
                  merged.permissions[role][resource][action] =
                    defaults.permissions[role]?.[resource]?.[action] ?? false;
                }
              });
            });
          });
          setConfig(merged);
        } else {
          setConfig(buildDefaultConfig());
        }
      } catch (e) {
        console.error('RBACManager load error:', e);
        setConfig(buildDefaultConfig());
      }
      setLoading(false);
    };
    load();
  }, [db, appId]);

  // ── Toggle a single permission ───────────────────────────────────────────────
  const togglePermission = (roleId, resource, action) => {
    setConfig(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [roleId]: {
          ...prev.permissions[roleId],
          [resource]: {
            ...prev.permissions[roleId]?.[resource],
            [action]: !prev.permissions[roleId]?.[resource]?.[action],
          },
        },
      },
    }));
    setIsDirty(true);
  };

  // ── Toggle entire column (all permissions for a role) ───────────────────────
  const toggleAllForRole = (roleId) => {
    // count current true values
    const perms = config.permissions[roleId] || {};
    let total = 0; let allowed = 0;
    Object.entries(RESOURCE_DEFS).forEach(([resource, def]) => {
      def.actions.forEach(action => {
        total++;
        if (perms[resource]?.[action]) allowed++;
      });
    });
    const setTo = allowed < total / 2; // if less than half are on, turn all on; otherwise turn all off
    const newPerms = {};
    Object.entries(RESOURCE_DEFS).forEach(([resource, def]) => {
      newPerms[resource] = {};
      def.actions.forEach(action => { newPerms[resource][action] = setTo; });
    });
    setConfig(prev => ({
      ...prev,
      permissions: { ...prev.permissions, [roleId]: newPerms },
    }));
    setIsDirty(true);
  };

  // ── Toggle entire row (all roles for a resource+action) ─────────────────────
  const toggleAllForAction = (resource, action) => {
    const roleIds = Object.keys(config.rolesMeta);
    const anyOn = roleIds.some(r => config.permissions[r]?.[resource]?.[action]);
    const setTo = !anyOn;
    setConfig(prev => {
      const next = { ...prev, permissions: { ...prev.permissions } };
      roleIds.forEach(roleId => {
        next.permissions[roleId] = {
          ...next.permissions[roleId],
          [resource]: {
            ...next.permissions[roleId]?.[resource],
            [action]: setTo,
          },
        };
      });
      return next;
    });
    setIsDirty(true);
  };

  // ── Save to Firestore ────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'rbac'),
        config
      );
      setLiveConfig(config);
      logAction('admin', 'update_rbac', 'settings', {}, 'Updated Role Permissions Matrix');
      setIsDirty(false);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
    } catch (e) {
      console.error(e);
      notify('Failed to save permissions. Check console.', 'error');
    }
    setSaving(false);
  };

  // ── Reset to system defaults ─────────────────────────────────────────────────
  const handleReset = async () => {
    if (!await confirmDialog('Reset ALL permissions to system defaults? Custom roles will be removed and all custom changes lost.'))
      return;
    setConfig(buildDefaultConfig());
    setIsDirty(true);
  };

  // ── Add custom role ──────────────────────────────────────────────────────────
  const handleAddRole = () => {
    const id = newRole.id.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!id || !newRole.label.trim()) return notify('Role ID and Display Name are required.', 'error');
    if (config.rolesMeta[id]) return notify(`Role ID "${id}" already exists.`, 'error');

    // New role starts with all permissions denied
    const emptyPerms = {};
    Object.entries(RESOURCE_DEFS).forEach(([resource, def]) => {
      emptyPerms[resource] = {};
      def.actions.forEach(action => { emptyPerms[resource][action] = false; });
    });

    setConfig(prev => ({
      ...prev,
      rolesMeta: {
        ...prev.rolesMeta,
        [id]: { label: newRole.label.trim(), color: newRole.color, isBuiltIn: false },
      },
      permissions: { ...prev.permissions, [id]: emptyPerms },
    }));
    setNewRole({ id: '', label: '', color: 'bg-blue-500' });
    setShowAddRole(false);
    setIsDirty(true);
  };

  // ── Delete custom role ───────────────────────────────────────────────────────
  const handleDeleteRole = async (roleId) => {
    const label = config.rolesMeta[roleId]?.label;
    if (!await confirmDialog(`Delete role "${label}"?\n\nEmployees assigned this role must be reassigned manually.`))
      return;
    const newMeta = { ...config.rolesMeta };
    const newPerms = { ...config.permissions };
    delete newMeta[roleId];
    delete newPerms[roleId];
    setConfig(prev => ({ ...prev, rolesMeta: newMeta, permissions: newPerms }));
    setIsDirty(true);
  };

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading)
    return (
      <div className="py-16 text-center text-slate-400 text-sm">
        Loading permissions matrix...
      </div>
    );

  const roleIds = Object.keys(config.rolesMeta);
  const resourceEntries = Object.entries(RESOURCE_DEFS);

  return (
    <div className="space-y-5">

      {/* ── Header bar ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Shield size={20} className="text-indigo-600" />
            Roles &amp; Permissions Matrix
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            Toggle each permission cell. Changes take effect <strong>instantly</strong> for all users after saving — no restart required.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 transition"
          >
            <RefreshCw size={13} /> Reset Defaults
          </button>
          <button
            onClick={() => setShowAddRole(v => !v)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-indigo-300 text-sm text-indigo-600 hover:bg-indigo-50 transition"
          >
            <Plus size={13} /> Add Custom Role
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition ${
              savedOk
                ? 'bg-emerald-600 text-white'
                : isDirty
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            }`}
          >
            {savedOk ? (
              <><Check size={13} /> Saved!</>
            ) : saving ? (
              'Saving...'
            ) : isDirty ? (
              <><Save size={13} /> Save &amp; Apply</>
            ) : (
              <><Save size={13} /> Up to date</>
            )}
          </button>
        </div>
      </div>

      {/* ── Unsaved changes banner ── */}
      {isDirty && !saving && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-amber-700 text-sm">
          <AlertTriangle size={15} className="flex-shrink-0" />
          <span>You have unsaved changes.</span>
          <button
            onClick={handleSave}
            className="ml-auto bg-amber-600 text-white px-3 py-1 rounded text-xs font-semibold hover:bg-amber-700"
          >
            Save &amp; Apply
          </button>
        </div>
      )}

      {/* ── Add custom role panel ── */}
      {showAddRole && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 font-semibold text-indigo-800">
            <Users size={16} /> Create Custom Role
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">
                Role ID &nbsp;<span className="font-normal text-slate-400">(lowercase, no spaces — used internally)</span>
              </label>
              <input
                className="w-full rounded border border-slate-300 p-2 text-sm bg-white text-black"
                placeholder="e.g. supervisor"
                value={newRole.id}
                onChange={e =>
                  setNewRole(p => ({
                    ...p,
                    id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
                  }))
                }
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700 block mb-1">Display Name</label>
              <input
                className="w-full rounded border border-slate-300 p-2 text-sm bg-white text-black"
                placeholder="e.g. Site Supervisor"
                value={newRole.label}
                onChange={e => setNewRole(p => ({ ...p, label: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-700 block mb-2">Badge Color</label>
            <div className="flex gap-2 flex-wrap">
              {COLOR_PALETTE.map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setNewRole(p => ({ ...p, color: c.key }))}
                  title={c.label}
                  className={`h-7 w-7 rounded-full ${c.key} border-2 transition-transform ${
                    newRole.color === c.key
                      ? 'border-slate-800 scale-125'
                      : 'border-transparent opacity-70 hover:opacity-100'
                  }`}
                />
              ))}
            </div>
            <div className="mt-2">
              Preview: <RoleBadge label={newRole.label || 'Role Name'} color={newRole.color} />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAddRole}
              className="bg-indigo-600 text-white px-4 py-1.5 rounded text-sm hover:bg-indigo-700"
            >
              Create Role
            </button>
            <button
              onClick={() => setShowAddRole(false)}
              className="border px-4 py-1.5 rounded text-sm text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Role legend strip ── */}
      <div className="flex items-center gap-3 flex-wrap p-3 bg-slate-50 rounded-lg border border-slate-200">
        <span className="text-xs font-bold text-slate-500 mr-1">ROLES:</span>
        {roleIds.map(roleId => {
          const meta = config.rolesMeta[roleId];
          return (
            <div key={roleId} className="flex items-center gap-1 group/role">
              <RoleBadge label={meta.label} color={meta.color} />
              {!meta.isBuiltIn && (
                <button
                  onClick={() => handleDeleteRole(roleId)}
                  title={`Delete "${meta.label}" role`}
                  className="text-red-400 hover:text-red-600 opacity-0 group-hover/role:opacity-100 transition"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}
        <span className="ml-auto text-xs text-slate-400 flex items-center gap-1">
          <Info size={12} /> Hover custom role to delete
        </span>
      </div>

      {/* ── Permission Matrix ── */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-sm">
        <table className="w-full text-xs border-collapse">
          <thead>
            {/* Role header row */}
            <tr className="bg-slate-800 text-white">
              <th className="sticky left-0 bg-slate-800 z-20 text-left px-4 py-3 font-semibold w-32 min-w-[120px] sm:w-52 sm:min-w-[200px] border-r border-slate-700">
                Resource / Action
              </th>
              {roleIds.map(roleId => {
                const meta = config.rolesMeta[roleId];
                return (
                  <th
                    key={roleId}
                    className="px-2 py-3 text-center min-w-[64px] sm:min-w-[96px] cursor-pointer select-none transition"
                    onMouseEnter={() => setHoverCol(roleId)}
                    onMouseLeave={() => setHoverCol(null)}
                    onClick={() => toggleAllForRole(roleId)}
                    title={`Click to toggle all permissions for ${meta.label}`}
                  >
                    <RoleBadge label={meta.label} color={meta.color} />
                    <div className="text-slate-400 text-[10px] mt-1 font-normal">click to toggle all</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {resourceEntries.map(([resource, def]) => (
              <React.Fragment key={resource}>
                {/* Resource section header */}
                <tr>
                  <td
                    colSpan={roleIds.length + 1}
                    className="sticky left-0 px-4 py-2 bg-slate-100 font-bold text-slate-600 uppercase tracking-wider text-[11px] border-y border-slate-200"
                  >
                    {def.label}
                  </td>
                </tr>
                {/* Action rows */}
                {def.actions.map((action, idx) => (
                  <tr
                    key={action}
                    className={`border-b border-slate-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'} hover:bg-blue-50/30 transition`}
                  >
                    {/* Action label — click to toggle all roles for this action */}
                    <td
                      className="sticky left-0 z-10 bg-white pl-8 pr-4 py-2.5 text-slate-600 font-medium border-r border-slate-100 cursor-pointer hover:text-indigo-700 select-none"
                      onClick={() => toggleAllForAction(resource, action)}
                      title="Click to toggle this permission for ALL roles"
                    >
                      {ACTION_LABELS[action] || action.replace(/_/g, ' ')}
                      <span className="block text-[10px] text-slate-400 font-normal">click = toggle all roles</span>
                    </td>
                    {/* Toggle cells */}
                    {roleIds.map(roleId => {
                      const allowed =
                        config.permissions[roleId]?.[resource]?.[action] ?? false;
                      return (
                        <td
                          key={roleId}
                          className={`px-2 py-2.5 text-center transition ${
                            hoverCol === roleId ? 'bg-indigo-50/50' : ''
                          }`}
                          onMouseEnter={() => setHoverCol(roleId)}
                          onMouseLeave={() => setHoverCol(null)}
                        >
                          <div className="flex flex-col items-center gap-0.5">
                            <Toggle
                              checked={allowed}
                              onChange={() => togglePermission(roleId, resource, action)}
                              title={`${config.rolesMeta[roleId]?.label}: ${allowed ? 'Allowed' : 'Denied'} — click to toggle`}
                            />
                            <span className={`text-[10px] font-semibold ${allowed ? 'text-emerald-600' : 'text-slate-300'}`}>
                              {allowed ? 'Yes' : 'No'}
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Footer hint ── */}
      <div className="text-xs text-slate-400 flex items-center gap-1.5">
        <Info size={12} />
        Click a <strong>role column header</strong> to toggle all its permissions at once.
        Click an <strong>action label</strong> to toggle that action for all roles at once.
        Changes only apply after clicking <strong>Save &amp; Apply</strong>.
      </div>

    </div>
  );
};

export default RBACManager;
