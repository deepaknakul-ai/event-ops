// Platform console — SUPER ADMIN editor for a tenant's plan features + limits.
// Each entitlement is TRI-STATE: inherit the plan default, or explicitly override
// it. An override is represented as the key being PRESENT in the tenant's
// feature_overrides / limit_overrides map (a boolean, or a number|null); "inherit"
// is the key being ABSENT. Save sends BOTH maps in full (only the overridden keys)
// via updateTenant — because passing a map replaces it, an omitted key clears any
// previous override and falls back to the plan default. The backend re-resolves
// and mirrors the effective entitlements to the tenant's settings/entitlements doc.
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Check, Minus, ShieldCheck } from 'lucide-react';
import { Modal } from '../components/Shared';
import { notify } from '../utils/toast';
import { PrimaryButton, GhostButton, PlanBadge, TextInput } from './ui';
import { PLATFORM_FEATURES, PLATFORM_LIMITS, planDefaults, fmtLimit } from './constants';
import { updateTenant } from './api';

const hasKey = (map, key) => !!map && Object.prototype.hasOwnProperty.call(map, key);

// ── Tenant overrides → editor state ──────────────────────────────────────────
// Features: 'inherit' | 'on' | 'off'. Limits: { mode:'inherit'|'unlimited'|'custom', value:string }.
const initFeatures = (tenant) => {
  const ov = tenant?.feature_overrides;
  const out = {};
  PLATFORM_FEATURES.forEach(({ key }) => {
    out[key] = hasKey(ov, key) ? (ov[key] ? 'on' : 'off') : 'inherit';
  });
  return out;
};
const initLimits = (tenant) => {
  const ov = tenant?.limit_overrides;
  const out = {};
  PLATFORM_LIMITS.forEach(({ key }) => {
    if (!hasKey(ov, key)) { out[key] = { mode: 'inherit', value: '' }; return; }
    const v = ov[key];
    out[key] = v === null ? { mode: 'unlimited', value: '' } : { mode: 'custom', value: String(v) };
  });
  return out;
};

// ── Tiny segmented tri-state control ─────────────────────────────────────────
const Segmented = ({ value, options, onChange, disabled }) => (
  <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group">
    {options.map((o) => {
      const active = value === o.value;
      return (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition disabled:opacity-50 ${
            active ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
          }`}
        >{o.label}</button>
      );
    })}
  </div>
);

const OverriddenTag = () => (
  <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
    Overridden
  </span>
);
const InheritedTag = () => (
  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-400">
    Inherited
  </span>
);

// Effective ON/OFF badge for a boolean feature.
const EffectiveBool = ({ on }) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${
    on ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-100 text-slate-500'
  }`}>
    {on ? <Check size={12} /> : <Minus size={12} />} Effective: {on ? 'ON' : 'OFF'}
  </span>
);

const FEATURE_OPTS = [
  { value: 'inherit', label: 'Plan default' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
const LIMIT_OPTS = [
  { value: 'inherit', label: 'Plan default' },
  { value: 'unlimited', label: 'Unlimited' },
  { value: 'custom', label: 'Custom' },
];

const TenantEntitlementsModal = ({ open, tenant, onClose, onSaved }) => {
  const tenantId = tenant?.id || tenant?.code || '';
  const plan = tenant?.plan || 'trial';
  const [features, setFeatures] = useState({});
  const [limits, setLimits] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFeatures(initFeatures(tenant));
    setLimits(initLimits(tenant));
  }, [open, tenant]);

  const defs = useMemo(() => planDefaults(plan), [plan]);

  const featEffective = (key) => {
    const s = features[key];
    if (s === 'on') return true;
    if (s === 'off') return false;
    return !!defs.features[key];
  };
  const limitEffective = (key) => {
    const st = limits[key] || { mode: 'inherit', value: '' };
    if (st.mode === 'unlimited') return null;
    if (st.mode === 'custom') return st.value === '' ? null : Number(st.value);
    return hasKey(defs.limits, key) ? defs.limits[key] : null;
  };

  const submit = async (e) => {
    e.preventDefault();

    // Build the override maps from explicit overrides only; "inherit" keys are
    // omitted so they clear back to the plan default on the server.
    const feature_overrides = {};
    PLATFORM_FEATURES.forEach(({ key }) => {
      const s = features[key];
      if (s === 'on') feature_overrides[key] = true;
      else if (s === 'off') feature_overrides[key] = false;
    });

    let limitError = null;
    const limit_overrides = {};
    PLATFORM_LIMITS.forEach(({ key, label }) => {
      const st = limits[key] || { mode: 'inherit', value: '' };
      if (st.mode === 'unlimited') { limit_overrides[key] = null; return; }
      if (st.mode !== 'custom') return; // inherit → omit
      const n = Number(st.value);
      if (st.value === '' || !Number.isInteger(n) || n < 0) {
        limitError = limitError || `${label} must be a whole number (0 or more), or choose Unlimited / Plan default.`;
        return;
      }
      limit_overrides[key] = n;
    });
    if (limitError) return notify(limitError, 'error');

    setBusy(true);
    try {
      await updateTenant(tenantId, { feature_overrides, limit_overrides });
      notify('Plan features updated.', 'success');
      onSaved();
    } catch (err) {
      notify('Update failed: ' + (err?.message || 'error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Modal isOpen={open} onClose={busy ? () => {} : onClose} title={`Plan & features — ${tenant?.name || tenant?.code || ''}`}>
      <form onSubmit={submit} className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3">
          <ShieldCheck size={16} className="text-indigo-500" />
          <span className="text-sm text-slate-600">Current plan</span>
          <PlanBadge plan={plan} />
          <span className="ml-auto text-xs text-slate-400">Change the plan itself from Edit tenant. Overrides win per feature.</span>
        </div>

        {/* Features */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Features</p>
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {PLATFORM_FEATURES.map(({ key, label, desc }) => {
              const overridden = features[key] !== 'inherit';
              const planDefault = !!defs.features[key];
              return (
                <div key={key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-800">{label}</span>
                      {overridden ? <OverriddenTag /> : <InheritedTag />}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">{desc}</p>
                    <p className="mt-1 text-xs text-slate-400">Plan default: <span className="font-medium text-slate-500">{planDefault ? 'ON' : 'OFF'}</span></p>
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                    <Segmented
                      value={features[key]}
                      options={FEATURE_OPTS}
                      disabled={busy}
                      onChange={(v) => setFeatures((f) => ({ ...f, [key]: v }))}
                    />
                    <EffectiveBool on={featEffective(key)} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Limits */}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Limits</p>
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {PLATFORM_LIMITS.map(({ key, label, desc, unit }) => {
              const st = limits[key] || { mode: 'inherit', value: '' };
              const overridden = st.mode !== 'inherit';
              const planDefault = hasKey(defs.limits, key) ? defs.limits[key] : null;
              const eff = limitEffective(key);
              return (
                <div key={key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-800">{label}</span>
                      {overridden ? <OverriddenTag /> : <InheritedTag />}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">{desc}</p>
                    <p className="mt-1 text-xs text-slate-400">Plan default: <span className="font-medium text-slate-500">{fmtLimit(planDefault)}</span></p>
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                    <div className="flex items-center gap-2">
                      <Segmented
                        value={st.mode}
                        options={LIMIT_OPTS}
                        disabled={busy}
                        onChange={(v) => setLimits((l) => ({ ...l, [key]: { ...l[key], mode: v } }))}
                      />
                      {st.mode === 'custom' && (
                        <TextInput
                          type="number"
                          min="0"
                          step="1"
                          className="w-24"
                          value={st.value}
                          disabled={busy}
                          placeholder="0"
                          onChange={(ev) => setLimits((l) => ({ ...l, [key]: { ...l[key], value: ev.target.value } }))}
                        />
                      )}
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      Effective: {fmtLimit(eff)}{eff === null ? '' : ` ${unit}`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
          <GhostButton type="button" onClick={onClose} disabled={busy}>Cancel</GhostButton>
          <PrimaryButton type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? 'Saving…' : 'Save entitlements'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
};

export default TenantEntitlementsModal;
