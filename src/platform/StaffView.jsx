// Platform console — staff administration (super_admin only).
// Drives platformManageStaff ops (list/create/update/disable). Fields and roles
// match functions/platform.js exactly.
import React, { useState, useEffect } from 'react';
import { Plus, Pencil, Ban, PlayCircle, RefreshCw, AlertTriangle, UserCog, Loader2 } from 'lucide-react';
import { notify } from '../utils/toast';
import { confirmDialog } from '../utils/dialog';
import { Modal } from '../components/Shared';
import { Card, TextInput, SelectInput, PrimaryButton, GhostButton, IconButton, RoleBadge, EmptyState, Field, ChipInput } from './ui';
import { STAFF_ROLE_OPTIONS, PLATFORM_ROLE, STAFF_STATUS, REGION_SUGGESTIONS, initials } from './constants';
import { createStaff, updateStaff, disableStaff } from './api';

const StaffModal = ({ open, mode, initial, tenants, onClose, onSaved }) => {
  const isEdit = mode === 'edit';
  const blankForm = { username: '', name: '', email: '', role: 'business_manager', regions: [], assigned_tenants: [], password: '', can_view_credit: false };
  const [form, setForm] = useState(blankForm);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(isEdit && initial
      ? {
          username: initial.username || '',
          name: initial.name || '',
          email: initial.email || '',
          role: initial.role || 'business_manager',
          regions: Array.isArray(initial.regions) ? initial.regions : [],
          assigned_tenants: Array.isArray(initial.assigned_tenants) ? initial.assigned_tenants : [],
          password: '',
          can_view_credit: initial.can_view_credit === true,
        }
      : blankForm);
  }, [open, isEdit, initial]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const tenantSuggestions = (tenants || []).map((t) => ({ value: t.code || t.id, label: `${t.name} (${t.code || t.id})` }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return notify('Name is required.', 'error');
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return notify('A valid email is required.', 'error');
    if (!isEdit && !form.username.trim()) return notify('Username is required.', 'error');
    if (!isEdit && (form.password || '').length < 8) return notify('Initial password must be at least 8 characters.', 'error');
    if (isEdit && form.password && form.password.length < 8) return notify('New password must be at least 8 characters.', 'error');

    setBusy(true);
    try {
      // A super_admin sees every credit score inherently; the flag only matters
      // for the other roles, so don't send a stray true for super_admins.
      const canViewCredit = form.role !== 'super_admin' && form.can_view_credit === true;
      if (isEdit) {
        const data = {
          name: form.name.trim(),
          email: form.email.trim(),
          role: form.role,
          regions: form.regions,
          assigned_tenants: form.assigned_tenants,
          can_view_credit: canViewCredit,
        };
        if (form.password) data.password = form.password;
        await updateStaff(initial.id, data);
        notify('Staff member updated.', 'success');
      } else {
        await createStaff({
          name: form.name.trim(),
          username: form.username.trim(),
          email: form.email.trim(),
          role: form.role,
          regions: form.regions,
          assigned_tenants: form.assigned_tenants,
          can_view_credit: canViewCredit,
          password: form.password,
        });
        notify('Staff member added.', 'success');
      }
      onSaved();
    } catch (err) {
      notify((isEdit ? 'Update failed: ' : 'Create failed: ') + (err?.message || 'error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Modal isOpen={open} onClose={busy ? () => {} : onClose} title={isEdit ? `Edit ${initial?.name || 'staff'}` : 'Add staff member'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Username" required={!isEdit} htmlFor="sf-user" hint={isEdit ? 'Username cannot be changed.' : undefined}>
            <TextInput id="sf-user" value={form.username} onChange={set('username')} disabled={isEdit} placeholder="jsmith" autoComplete="off" />
          </Field>
          <Field label="Full name" required htmlFor="sf-name">
            <TextInput id="sf-name" value={form.name} onChange={set('name')} placeholder="Jane Smith" />
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Email" required htmlFor="sf-email">
            <TextInput id="sf-email" type="email" value={form.email} onChange={set('email')} placeholder="jane@platform.com" autoComplete="off" />
          </Field>
          <Field label="Role" htmlFor="sf-role">
            <SelectInput id="sf-role" value={form.role} onChange={set('role')}>
              {STAFF_ROLE_OPTIONS.map((r) => <option key={r} value={r}>{PLATFORM_ROLE[r].label}</option>)}
            </SelectInput>
          </Field>
        </div>

        {form.role === 'regional_admin' && (
          <Field label="Regions" htmlFor="sf-regions" hint="Regions this admin governs. Type a region and press Enter.">
            <ChipInput id="sf-regions" values={form.regions} onChange={(v) => setForm((f) => ({ ...f, regions: v }))} suggestions={REGION_SUGGESTIONS.map((r) => ({ value: r, label: r }))} placeholder="Add a region…" />
          </Field>
        )}

        {form.role === 'business_manager' && (
          <Field label="Assigned tenants" htmlFor="sf-tenants" hint="Tenant codes this manager owns. Pick from the list or type a code.">
            <ChipInput id="sf-tenants" values={form.assigned_tenants} onChange={(v) => setForm((f) => ({ ...f, assigned_tenants: v }))} suggestions={tenantSuggestions} placeholder="Add a tenant code…" />
          </Field>
        )}

        {form.role === 'super_admin' ? (
          <p className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Super admins can view every party’s numeric credit score by default.
          </p>
        ) : (
          <label htmlFor="sf-credit" className="flex items-start gap-2.5 rounded-lg border border-slate-200 p-3 cursor-pointer">
            <input
              id="sf-credit"
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
              checked={form.can_view_credit}
              onChange={(e) => setForm((f) => ({ ...f, can_view_credit: e.target.checked }))}
            />
            <span className="text-sm">
              <span className="font-semibold text-slate-700">Trusted for credit intelligence</span>
              <span className="block text-xs text-slate-400">May view the numeric cross-tenant credit scores. Tenants only ever see colour labels.</span>
            </span>
          </label>
        )}

        <Field
          label={isEdit ? 'Reset password' : 'Initial password'}
          required={!isEdit}
          htmlFor="sf-pass"
          hint={isEdit ? 'Leave blank to keep the current password.' : 'Minimum 8 characters. The staff member can change it after first sign-in.'}
        >
          <TextInput id="sf-pass" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" placeholder={isEdit ? '••••••••' : 'At least 8 characters'} />
        </Field>

        <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
          <GhostButton type="button" onClick={onClose} disabled={busy}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}{busy ? 'Saving…' : isEdit ? 'Save' : 'Add staff'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
};

const scopeLabel = (m) => {
  if (m.role === 'super_admin') return 'All tenants';
  if (m.role === 'regional_admin') return (m.regions || []).length ? (m.regions || []).join(', ') : 'No regions';
  const n = (m.assigned_tenants || []).length;
  return n ? `${n} tenant${n > 1 ? 's' : ''}` : 'No tenants';
};

const StaffView = ({ staff, loading, error, onReload, session, tenants }) => {
  const [modal, setModal] = useState({ open: false, mode: 'create', member: null });
  const [pendingId, setPendingId] = useState(null);

  const toggleActive = async (m) => {
    const isActive = (m.status || 'active') === 'active';
    if (!(await confirmDialog(`${isActive ? 'Disable' : 'Reactivate'} ${m.name || m.username}?`))) return;
    setPendingId(m.id);
    try {
      if (isActive) await disableStaff(m.id);
      else await updateStaff(m.id, { status: 'active' });
      notify(`Staff ${isActive ? 'disabled' : 'reactivated'}.`, 'success');
      await onReload();
    } catch (e) {
      notify(`Could not update: ${e?.message || 'error'}`, 'error');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">Control-plane operators who can access this console.</p>
        <div className="flex gap-3">
          <GhostButton type="button" onClick={onReload} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </GhostButton>
          <PrimaryButton type="button" onClick={() => setModal({ open: true, mode: 'create', member: null })}>
            <Plus size={16} /> Add staff
          </PrimaryButton>
        </div>
      </div>

      <Card className="!p-0 overflow-hidden">
        {error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Staff list unavailable"
            message={`${error}. You can still add staff — actions take effect once the backend endpoints are deployed.`}
            action={<GhostButton onClick={onReload}><RefreshCw size={15} /> Try again</GhostButton>}
          />
        ) : loading && !staff.length ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-400">
            <RefreshCw size={16} className="animate-spin" /> Loading staff…
          </div>
        ) : !staff.length ? (
          <EmptyState
            icon={UserCog}
            title="No staff yet"
            message="Add platform operators and account managers here."
            action={<PrimaryButton onClick={() => setModal({ open: true, mode: 'create', member: null })}><Plus size={16} /> Add staff</PrimaryButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-3">Staff</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Scope</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {staff.map((m) => {
                  const isActive = (m.status || 'active') === 'active';
                  const isSelf = session?.staffId && m.id === session.staffId;
                  const busy = pendingId === m.id;
                  const st = STAFF_STATUS[isActive ? 'active' : 'disabled'];
                  return (
                    <tr key={m.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{initials(m.name || m.username)}</div>
                          <div>
                            <div className="font-semibold text-slate-800">{m.name || '—'}{isSelf && <span className="ml-2 text-xs font-normal text-slate-400">(you)</span>}</div>
                            <div className="text-xs text-slate-400">{m.username ? `@${m.username}` : ''}{m.email ? ` · ${m.email}` : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3"><RoleBadge role={m.role} /></td>
                      <td className="px-5 py-3 text-slate-600">{scopeLabel(m)}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${st.badge}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />{st.label}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <IconButton title="Edit" onClick={() => setModal({ open: true, mode: 'edit', member: m })} disabled={busy}>
                            <Pencil size={15} />
                          </IconButton>
                          <IconButton
                            title={isSelf ? 'You cannot disable yourself' : isActive ? 'Disable' : 'Reactivate'}
                            className={isActive ? 'hover:text-rose-600' : 'hover:text-emerald-600'}
                            onClick={() => toggleActive(m)}
                            disabled={busy || isSelf}
                          >
                            {isActive ? <Ban size={15} /> : <PlayCircle size={16} />}
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <StaffModal
        open={modal.open}
        mode={modal.mode}
        initial={modal.member}
        tenants={tenants}
        onClose={() => setModal((s) => ({ ...s, open: false }))}
        onSaved={async () => { setModal((s) => ({ ...s, open: false })); await onReload(); }}
      />
    </div>
  );
};

export default StaffView;
