// Platform console — manage a tenant company's own users (employees) from the
// console, without entering a support session. Opened from a tenant row in
// TenantsView. Every mutation goes through the single platformManageTenantUsers
// callable (see api.js): list / create / update / disable / resetPassword.
import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, Pencil, Ban, PlayCircle, KeyRound, RefreshCw, AlertTriangle, Users as UsersIcon, Loader2, ArrowLeft } from 'lucide-react';
import { notify } from '../utils/toast';
import { confirmDialog } from '../utils/dialog';
import { Modal } from '../components/Shared';
import { Field, TextInput, SelectInput, PrimaryButton, GhostButton, IconButton, EmptyState, TenantUserRoleBadge, TenantUserStatusBadge } from './ui';
import { TENANT_USER_ROLE, TENANT_USER_ROLE_OPTIONS, TENANT_USER_STATUS, TENANT_USER_STATUS_OPTIONS, isTenantUserActive, initials } from './constants';
import { listTenantUsers, createTenantUser, updateTenantUser, disableTenantUser, resetTenantUserPassword } from './api';

const MIN_TENANT_PW = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const blankForm = () => ({ name: '', username: '', email: '', role: 'user', status: 'Active', password: '' });

// ── Create / edit a single user ──────────────────────────────────────────────
const UserForm = ({ tenantId, mode, user, onCancel, onSaved }) => {
  const isEdit = mode === 'edit';
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(isEdit && user
      ? {
          name: user.name || '',
          username: user.username || '',
          email: user.email || '',
          role: user.role || 'user',
          status: user.status || 'Active',
          password: '',
        }
      : blankForm());
  }, [isEdit, user]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    const username = form.username.trim();
    const email = form.email.trim();
    if (!name) return notify('Name is required.', 'error');
    if (!email || !EMAIL_RE.test(email)) return notify('A valid email is required.', 'error');
    if (!isEdit && !username) return notify('Username is required.', 'error');
    if (!isEdit && (form.password || '').length < MIN_TENANT_PW) return notify(`Password must be at least ${MIN_TENANT_PW} characters.`, 'error');

    setBusy(true);
    try {
      if (isEdit) {
        await updateTenantUser(tenantId, user.id, { name, email, role: form.role, status: form.status });
        notify('User updated.', 'success');
      } else {
        await createTenantUser(tenantId, { name, username, email, role: form.role, password: form.password });
        notify('User added.', 'success');
      }
      onSaved();
    } catch (err) {
      notify((isEdit ? 'Update failed: ' : 'Create failed: ') + (err?.message || 'error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Username" required={!isEdit} htmlFor="tu-user" hint={isEdit ? 'Username cannot be changed.' : undefined}>
          <TextInput id="tu-user" value={form.username} onChange={set('username')} disabled={isEdit} placeholder="jsmith" autoComplete="off" />
        </Field>
        <Field label="Full name" required htmlFor="tu-name">
          <TextInput id="tu-name" value={form.name} onChange={set('name')} placeholder="Jane Smith" />
        </Field>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Email" required htmlFor="tu-email">
          <TextInput id="tu-email" type="email" value={form.email} onChange={set('email')} placeholder="jane@company.com" autoComplete="off" />
        </Field>
        <Field label="Role" htmlFor="tu-role" hint={TENANT_USER_ROLE[form.role]?.desc}>
          <SelectInput id="tu-role" value={form.role} onChange={set('role')}>
            {TENANT_USER_ROLE_OPTIONS.map((r) => <option key={r} value={r}>{TENANT_USER_ROLE[r].label}</option>)}
          </SelectInput>
        </Field>
      </div>

      {isEdit ? (
        <Field label="Status" htmlFor="tu-status" hint="Disabled users cannot sign in.">
          <SelectInput id="tu-status" value={form.status} onChange={set('status')}>
            {TENANT_USER_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{TENANT_USER_STATUS[s].label}</option>)}
          </SelectInput>
        </Field>
      ) : (
        <Field label="Initial password" required htmlFor="tu-pass" hint={`Minimum ${MIN_TENANT_PW} characters. The user can change it after first sign-in.`}>
          <TextInput id="tu-pass" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" placeholder={`At least ${MIN_TENANT_PW} characters`} />
        </Field>
      )}

      <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
        <GhostButton type="button" onClick={onCancel} disabled={busy}>Cancel</GhostButton>
        <PrimaryButton type="submit" disabled={busy}>
          {busy && <Loader2 size={16} className="animate-spin" />}{busy ? 'Saving…' : isEdit ? 'Save' : 'Add user'}
        </PrimaryButton>
      </div>
    </form>
  );
};

// ── Reset a user's password ──────────────────────────────────────────────────
const ResetForm = ({ tenantId, user, onCancel, onDone }) => {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < MIN_TENANT_PW) return notify(`Password must be at least ${MIN_TENANT_PW} characters.`, 'error');
    if (pw !== confirm) return notify('The two passwords do not match.', 'error');
    const ok = await confirmDialog(
      `Reset the password for ${user?.name || user?.username}? Their current password stops working immediately.`,
      { danger: true, confirmLabel: 'Reset password' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await resetTenantUserPassword(tenantId, user.id, pw);
      notify('Password reset.', 'success');
      onDone();
    } catch (err) {
      notify('Reset failed: ' + (err?.message || 'error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-slate-500">
        Set a new password for <span className="font-semibold text-slate-700">{user?.name || user?.username}</span>
        {user?.username ? <span className="text-slate-400"> (@{user.username})</span> : null}.
      </p>
      <Field label="New password" required htmlFor="tu-newpass" hint={`Minimum ${MIN_TENANT_PW} characters.`}>
        <TextInput id="tu-newpass" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder={`At least ${MIN_TENANT_PW} characters`} />
      </Field>
      <Field label="Confirm password" required htmlFor="tu-newpass2">
        <TextInput id="tu-newpass2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" placeholder="Re-enter the new password" />
        {confirm.length > 0 && (
          <p className={`mt-1 text-xs font-medium ${pw === confirm ? 'text-emerald-600' : 'text-amber-600'}`}>
            {pw === confirm ? 'Passwords match.' : 'Passwords do not match yet.'}
          </p>
        )}
      </Field>
      <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
        <GhostButton type="button" onClick={onCancel} disabled={busy}>Cancel</GhostButton>
        <PrimaryButton type="submit" disabled={busy}>
          {busy && <Loader2 size={16} className="animate-spin" />}{busy ? 'Resetting…' : 'Reset password'}
        </PrimaryButton>
      </div>
    </form>
  );
};

// ── Role legend ──────────────────────────────────────────────────────────────
const RoleLegend = () => (
  <div className="mt-4 border-t border-slate-100 pt-3">
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Roles</p>
    <div className="grid gap-y-1.5 sm:grid-cols-2">
      {TENANT_USER_ROLE_OPTIONS.map((r) => (
        <div key={r} className="flex items-center gap-2 text-xs text-slate-500">
          <TenantUserRoleBadge role={r} />
          <span className="truncate">{TENANT_USER_ROLE[r].desc}</span>
        </div>
      ))}
    </div>
  </div>
);

const TenantUsersModal = ({ open, tenant, onClose }) => {
  const tenantId = tenant?.id || tenant?.code || '';
  const tenantName = tenant?.name || tenant?.code || 'tenant';

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState(null);
  // null → list view; { kind:'form', mode, user }; { kind:'reset', user }
  const [panel, setPanel] = useState(null);

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError('');
    try {
      const { users: rows } = await listTenantUsers(tenantId);
      setUsers(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(e?.message || 'Failed to load users.');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (!open) return;
    setPanel(null);
    reload();
  }, [open, reload]);

  const backToList = () => setPanel(null);
  const afterMutation = async () => { setPanel(null); await reload(); };

  const toggleActive = async (u) => {
    const isActive = isTenantUserActive(u.status);
    const ok = await confirmDialog(
      isActive
        ? `Disable ${u.name || u.username}? They are signed out and blocked from signing in until re-enabled.`
        : `Reactivate ${u.name || u.username}?`,
      { danger: isActive, confirmLabel: isActive ? 'Disable' : 'Reactivate' },
    );
    if (!ok) return;
    setPendingId(u.id);
    try {
      if (isActive) await disableTenantUser(tenantId, u.id);
      else await updateTenantUser(tenantId, u.id, { status: 'Active' });
      notify(`User ${isActive ? 'disabled' : 'reactivated'}.`, 'success');
      await reload();
    } catch (e) {
      notify(`Could not update user: ${e?.message || 'error'}`, 'error');
    } finally {
      setPendingId(null);
    }
  };

  if (!open) return null;

  const headerTitle =
    panel?.kind === 'form'
      ? (panel.mode === 'edit' ? `Edit user — ${panel.user?.name || panel.user?.username || ''}` : 'Add user')
      : panel?.kind === 'reset'
        ? `Reset password — ${panel.user?.name || panel.user?.username || ''}`
        : `Users — ${tenantName}`;

  return (
    <Modal isOpen={open} onClose={onClose} title={headerTitle}>
      {panel ? (
        <div className="space-y-4">
          <button type="button" onClick={backToList} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 transition">
            <ArrowLeft size={14} /> Back to users
          </button>
          {panel.kind === 'form' ? (
            <UserForm tenantId={tenantId} mode={panel.mode} user={panel.user} onCancel={backToList} onSaved={afterMutation} />
          ) : (
            <ResetForm tenantId={tenantId} user={panel.user} onCancel={backToList} onDone={afterMutation} />
          )}
        </div>
      ) : (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">
              Employees of <span className="font-semibold text-slate-700">{tenantName}</span>
              <span className="ml-1 font-mono text-xs text-slate-400">{tenant?.code || tenantId}</span>
            </p>
            <div className="flex gap-2">
              <GhostButton type="button" onClick={reload} disabled={loading} className="!px-3 !py-2">
                <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
              </GhostButton>
              <PrimaryButton type="button" onClick={() => setPanel({ kind: 'form', mode: 'create', user: null })} className="!px-3 !py-2">
                <UserPlus size={16} /> Add user
              </PrimaryButton>
            </div>
          </div>

          {error ? (
            <EmptyState
              icon={AlertTriangle}
              title="Couldn't load users"
              message={error}
              action={<GhostButton onClick={reload}><RefreshCw size={15} /> Try again</GhostButton>}
            />
          ) : loading && !users.length ? (
            <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-400">
              <RefreshCw size={16} className="animate-spin" /> Loading users…
            </div>
          ) : !users.length ? (
            <EmptyState
              icon={UsersIcon}
              title="No users yet"
              message="Add this tenant's first user to get them into the workspace."
              action={<PrimaryButton onClick={() => setPanel({ kind: 'form', mode: 'create', user: null })}><UserPlus size={16} /> Add user</PrimaryButton>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    <th className="py-2.5 pr-3">User</th>
                    <th className="py-2.5 px-3">Role</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 pl-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {users.map((u) => {
                    const isActive = isTenantUserActive(u.status);
                    const rowBusy = pendingId === u.id;
                    return (
                      <tr key={u.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{initials(u.name || u.username)}</div>
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-slate-800">{u.name || '—'}</div>
                              <div className="truncate text-xs text-slate-400">{u.username ? `@${u.username}` : ''}{u.email ? ` · ${u.email}` : ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3"><TenantUserRoleBadge role={u.role} /></td>
                        <td className="py-2.5 px-3"><TenantUserStatusBadge status={u.status || 'Active'} /></td>
                        <td className="py-2.5 pl-3">
                          <div className="flex items-center justify-end gap-1">
                            <IconButton title="Edit" onClick={() => setPanel({ kind: 'form', mode: 'edit', user: u })} disabled={rowBusy}>
                              <Pencil size={15} />
                            </IconButton>
                            <IconButton title="Reset password" onClick={() => setPanel({ kind: 'reset', user: u })} disabled={rowBusy}>
                              <KeyRound size={15} />
                            </IconButton>
                            <IconButton
                              title={isActive ? 'Disable' : 'Reactivate'}
                              className={isActive ? 'hover:text-rose-600' : 'hover:text-emerald-600'}
                              onClick={() => toggleActive(u)}
                              disabled={rowBusy}
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

          {!error && <RoleLegend />}
        </div>
      )}
    </Modal>
  );
};

export default TenantUsersModal;
