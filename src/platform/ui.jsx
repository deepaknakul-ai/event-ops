// Platform console — small presentational primitives.
// Styling mirrors the host app: white cards, indigo primary, slate text.
import React, { useState } from 'react';
import { X } from 'lucide-react';
import { TENANT_STATUS, TENANT_PLAN, PLATFORM_ROLE, TENANT_USER_ROLE, TENANT_USER_STATUS } from './constants';

// ── Card ─────────────────────────────────────────────────────────────────────
export const Card = ({ className = '', children }) => (
  <div className={`bg-white p-6 rounded-xl border border-slate-200 shadow-sm ${className}`}>{children}</div>
);

// ── Form field wrapper ───────────────────────────────────────────────────────
export const Field = ({ label, hint, required, htmlFor, children }) => (
  <div>
    {label && (
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-slate-700 mb-1.5">
        {label}{required && <span className="text-rose-500"> *</span>}
      </label>
    )}
    {children}
    {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
  </div>
);

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-200 p-2.5 text-sm text-slate-800 bg-white outline-none ' +
  'focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all disabled:bg-slate-50 disabled:text-slate-400';

export const TextInput = ({ className = '', ...props }) => (
  <input className={`${INPUT_CLASS} ${className}`} {...props} />
);

export const TextArea = ({ className = '', rows = 3, ...props }) => (
  <textarea rows={rows} className={`${INPUT_CLASS} resize-y ${className}`} {...props} />
);

export const SelectInput = ({ className = '', children, ...props }) => (
  <select className={`${INPUT_CLASS} ${className}`} {...props}>{children}</select>
);

// ── Buttons ──────────────────────────────────────────────────────────────────
export const PrimaryButton = ({ className = '', children, ...props }) => (
  <button
    className={`inline-flex items-center justify-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-lg font-semibold text-sm ` +
      `hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed transition-all shadow-sm shadow-indigo-200 ${className}`}
    {...props}
  >{children}</button>
);

export const GhostButton = ({ className = '', children, ...props }) => (
  <button
    className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm text-slate-600 ` +
      `border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 transition ${className}`}
    {...props}
  >{children}</button>
);

// Compact square icon button for table row actions.
export const IconButton = ({ className = '', title, children, ...props }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 ` +
      `disabled:opacity-40 disabled:cursor-not-allowed transition ${className}`}
    {...props}
  >{children}</button>
);

// ── Badges ───────────────────────────────────────────────────────────────────
const Pill = ({ cls, children }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${cls}`}>{children}</span>
);

export const StatusBadge = ({ status }) => {
  const s = TENANT_STATUS[status] || { label: status || 'Unknown', badge: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' };
  return <Pill cls={s.badge}><span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}</Pill>;
};

export const PlanBadge = ({ plan }) => {
  const p = TENANT_PLAN[plan] || { label: plan || '—', badge: 'bg-slate-100 text-slate-600 border-slate-200' };
  return <Pill cls={p.badge}>{p.label}</Pill>;
};

export const RoleBadge = ({ role }) => {
  const r = PLATFORM_ROLE[role] || { label: role || '—', badge: 'bg-slate-100 text-slate-600 border-slate-200' };
  return <Pill cls={r.badge}>{r.label}</Pill>;
};

// In-tenant user role (admin/accountant/manager/tech/user) — used by the Tenant
// Users manager. Mirrors RoleBadge but keyed off TENANT_USER_ROLE.
export const TenantUserRoleBadge = ({ role }) => {
  const r = TENANT_USER_ROLE[role] || { label: role || '—', badge: 'bg-slate-100 text-slate-600 border-slate-200' };
  return <Pill cls={r.badge}>{r.label}</Pill>;
};

// Tenant user account status (active/disabled).
export const TenantUserStatusBadge = ({ status }) => {
  const s = TENANT_USER_STATUS[status] || { label: status || 'Unknown', badge: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' };
  return <Pill cls={s.badge}><span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}</Pill>;
};

// ── Stat card ────────────────────────────────────────────────────────────────
export const StatCard = ({ icon: Icon, label, value, sub, accent = 'text-indigo-600', iconBg = 'bg-indigo-50' }) => (
  <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <p className="mt-2 text-3xl font-bold text-slate-800">{value}</p>
        {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
      </div>
      {Icon && (
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
          <Icon size={20} className={accent} />
        </div>
      )}
    </div>
  </div>
);

// ── Empty / error state ──────────────────────────────────────────────────────
export const EmptyState = ({ icon: Icon, title, message, action }) => (
  <div className="flex flex-col items-center justify-center py-16 text-center">
    {Icon && <Icon size={38} className="text-slate-300 mb-3" />}
    <h3 className="text-base font-semibold text-slate-700">{title}</h3>
    {message && <p className="mt-1 max-w-sm text-sm text-slate-400">{message}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

// ── Chip / token input (used for assigned managers) ──────────────────────────
// Stores an array of plain string identifiers. `suggestions` powers a datalist.
export const ChipInput = ({ id, values = [], onChange, placeholder = 'Type and press Enter', suggestions = [] }) => {
  const [draft, setDraft] = useState('');
  const listId = `${id}-list`;

  const add = (raw) => {
    const v = (raw || '').trim();
    if (!v || values.includes(v)) { setDraft(''); return; }
    onChange([...values, v]);
    setDraft('');
  };
  const remove = (v) => onChange(values.filter((x) => x !== v));

  return (
    <div>
      <div className="flex gap-2">
        <input
          id={id}
          list={suggestions.length ? listId : undefined}
          className={INPUT_CLASS}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
            else if (e.key === 'Backspace' && !draft && values.length) remove(values[values.length - 1]);
          }}
        />
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </datalist>
        )}
      </div>
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
              {v}
              <button type="button" onClick={() => remove(v)} className="text-indigo-400 hover:text-rose-500"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
