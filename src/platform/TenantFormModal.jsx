// Platform console — create / edit a tenant. Reuses the host app's Modal shell.
// Payloads match functions/platform.js: create requires an owner password and
// ignores notes/assigned_managers; update sends {tenantId, patch} where
// region + assigned_managers are super_admin-only keys.
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, KeyRound } from 'lucide-react';
import { Modal } from '../components/Shared';
import { notify } from '../utils/toast';
import { Field, TextInput, TextArea, SelectInput, ChipInput, PrimaryButton, GhostButton } from './ui';
import { PLAN_ORDER, TENANT_PLAN, REGION_SUGGESTIONS, TENANT_CODE_RE } from './constants';
import { createTenant, updateTenant } from './api';

const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// Normalise any stored value to yyyy-mm-dd for <input type="date">.
const toDateInput = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const blank = () => ({
  code: '', name: '', region: '', plan: 'trial',
  trial_expires_on: plusDays(14),
  contact_name: '', contact_email: '', contact_phone: '',
  ownerPassword: '', notes: '', assigned_managers: [],
});

const TenantFormModal = ({ open, mode, initial, staff = [], isSuperAdmin = false, onClose, onSaved }) => {
  const isEdit = mode === 'edit';
  const [form, setForm] = useState(blank());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (isEdit && initial) {
      setForm({
        code: initial.code || '',
        name: initial.name || '',
        region: initial.region || '',
        plan: initial.plan || 'trial',
        trial_expires_on: toDateInput(initial.trial_expires_on),
        contact_name: initial.contact_name || '',
        contact_email: initial.contact_email || '',
        contact_phone: initial.contact_phone || '',
        ownerPassword: '',
        notes: initial.notes || '',
        assigned_managers: Array.isArray(initial.assigned_managers) ? initial.assigned_managers : [],
      });
    } else {
      setForm(blank());
    }
  }, [open, isEdit, initial]);

  // assigned_managers stores platform_staff doc IDs (that's what the backend
  // scope check compares against), so the datalist maps id -> friendly label.
  const managerSuggestions = useMemo(
    () => (staff || []).map((s) => ({
      value: s.id || s.staffId || '',
      label: s.name ? `${s.name}${s.username ? ` (${s.username})` : ''}` : (s.username || s.id || ''),
    })).filter((s) => s.value),
    [staff],
  );

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const canEditRegion = !isEdit || isSuperAdmin;      // region is create-time or super_admin-only on patch
  const canEditManagers = isEdit && isSuperAdmin;     // not a create field; super_admin-only on patch

  const submit = async (e) => {
    e.preventDefault();
    const code = form.code.trim().toLowerCase();
    const name = form.name.trim();
    if (!isEdit && !TENANT_CODE_RE.test(code)) {
      return notify('Tenant code must be a 3–30 char slug (a–z, 0–9, hyphen).', 'error');
    }
    if (!name) return notify('Tenant name is required.', 'error');
    if (!isEdit && (form.ownerPassword || '').length < 8) {
      return notify('Owner password must be at least 8 characters.', 'error');
    }
    if (form.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email.trim())) {
      return notify('Enter a valid contact email or leave it blank.', 'error');
    }

    const trial = form.plan === 'trial' ? (form.trial_expires_on || null) : null;

    setBusy(true);
    try {
      if (isEdit) {
        // Build a whitelist patch. Omit super_admin-only keys unless allowed so
        // the backend never rejects the whole call with permission-denied.
        const patch = {
          name,
          plan: form.plan,
          trial_expires_on: trial,
          contact_name: form.contact_name.trim(),
          contact_email: form.contact_email.trim(),
          contact_phone: form.contact_phone.trim(),
          notes: form.notes.trim(),
        };
        if (isSuperAdmin) {
          patch.region = form.region.trim();
          patch.assigned_managers = form.assigned_managers;
        }
        await updateTenant(initial.id, patch);
        notify('Tenant updated.', 'success');
      } else {
        await createTenant({
          code,
          name,
          region: form.region.trim(),
          plan: form.plan,
          trial_expires_on: trial,
          contact_name: form.contact_name.trim(),
          contact_email: form.contact_email.trim(),
          contact_phone: form.contact_phone.trim(),
          ownerPassword: form.ownerPassword,
        });
        notify(`Tenant "${name}" created. The owner signs in with username "admin" and the password you set.`, 'success');
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
    <Modal isOpen={open} onClose={busy ? () => {} : onClose} title={isEdit ? `Edit tenant — ${initial?.name || ''}` : 'New tenant'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Tenant code" required={!isEdit} htmlFor="tf-code" hint={isEdit ? 'Code is fixed after creation.' : 'Workspace id — 3–30 chars, a–z 0–9 and hyphens.'}>
            <TextInput id="tf-code" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toLowerCase() }))} disabled={isEdit} placeholder="acme-in" className="font-mono" />
          </Field>
          <Field label="Tenant name" required htmlFor="tf-name">
            <TextInput id="tf-name" value={form.name} onChange={set('name')} placeholder="Acme Productions" />
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Region" htmlFor="tf-region" hint={!canEditRegion ? 'Only a super admin can change region.' : undefined}>
            <SelectInput id="tf-region" value={form.region} onChange={set('region')} disabled={!canEditRegion}>
              <option value="">Select a region…</option>
              {REGION_SUGGESTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectInput>
          </Field>
          <Field label="Plan" htmlFor="tf-plan">
            <SelectInput id="tf-plan" value={form.plan} onChange={set('plan')}>
              {PLAN_ORDER.map((p) => <option key={p} value={p}>{TENANT_PLAN[p].label}</option>)}
            </SelectInput>
          </Field>
        </div>

        {form.plan === 'trial' && (
          <Field label="Trial expires on" htmlFor="tf-trial" hint="Only applies while the tenant is on the trial plan.">
            <TextInput id="tf-trial" type="date" value={form.trial_expires_on} onChange={set('trial_expires_on')} />
          </Field>
        )}

        {!isEdit && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
            <Field
              label={<span className="inline-flex items-center gap-1.5"><KeyRound size={14} /> Owner password</span>}
              required
              htmlFor="tf-owner"
              hint="Sets the tenant owner's first admin password (min 8 chars). They sign in as “admin” and can change it later."
            >
              <TextInput id="tf-owner" type="password" autoComplete="new-password" value={form.ownerPassword} onChange={set('ownerPassword')} placeholder="At least 8 characters" />
            </Field>
          </div>
        )}

        <div className="border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Primary contact</p>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Name" htmlFor="tf-cname">
              <TextInput id="tf-cname" value={form.contact_name} onChange={set('contact_name')} placeholder="Jane Doe" />
            </Field>
            <Field label="Email" htmlFor="tf-cemail">
              <TextInput id="tf-cemail" type="email" value={form.contact_email} onChange={set('contact_email')} placeholder="jane@acme.com" />
            </Field>
            <Field label="Phone" htmlFor="tf-cphone">
              <TextInput id="tf-cphone" value={form.contact_phone} onChange={set('contact_phone')} placeholder="+91 98765 43210" />
            </Field>
          </div>
        </div>

        {isEdit && (
          <>
            <Field label="Assigned managers" htmlFor="tf-managers" hint={canEditManagers ? 'Business managers who own this account (super admin only). Pick from staff or type a staff ID.' : 'Only a super admin can change assigned managers.'}>
              {canEditManagers ? (
                <ChipInput
                  id="tf-managers"
                  values={form.assigned_managers}
                  onChange={(v) => setForm((f) => ({ ...f, assigned_managers: v }))}
                  suggestions={managerSuggestions}
                  placeholder="Add a manager…"
                />
              ) : form.assigned_managers.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {form.assigned_managers.map((m) => (
                    <span key={m} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600">{m}</span>
                  ))}
                </div>
              ) : <p className="text-sm text-slate-400">None assigned.</p>}
            </Field>

            <Field label="Notes" htmlFor="tf-notes">
              <TextArea id="tf-notes" value={form.notes} onChange={set('notes')} placeholder="Internal notes about this tenant…" />
            </Field>
          </>
        )}

        <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
          <GhostButton type="button" onClick={onClose} disabled={busy}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create tenant'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
};

export default TenantFormModal;
