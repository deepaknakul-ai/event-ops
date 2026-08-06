// Platform console — tenant directory with filters and lifecycle actions.
// All mutations go through platformUpdateTenant (there is no delete endpoint);
// suspend / reactivate / churn are just status patches.
import React, { useMemo, useState } from 'react';
import {
  Search, Plus, Pencil, PauseCircle, PlayCircle, UserX,
  Building2, RefreshCw, AlertTriangle, Users as UsersIcon, LifeBuoy, UserCog, SlidersHorizontal, PackagePlus,
} from 'lucide-react';
import { notify } from '../utils/toast';
import { confirmDialog } from '../utils/dialog';
import { Card, TextInput, SelectInput, PrimaryButton, GhostButton, IconButton, StatusBadge, PlanBadge, EmptyState } from './ui';
import { STATUS_ORDER, PLAN_ORDER, TENANT_STATUS, TENANT_PLAN, fmtDate, daysUntil } from './constants';
import { updateTenant, enterSupport, resyncCatalog } from './api';
import TenantFormModal from './TenantFormModal';
import TenantUsersModal from './TenantUsersModal';
import TenantEntitlementsModal from './TenantEntitlementsModal';

const TrialHint = ({ tenant }) => {
  if (tenant.plan !== 'trial' || !tenant.trial_expires_on) return null;
  const d = daysUntil(tenant.trial_expires_on);
  if (d === null) return null;
  const cls = d < 0 ? 'text-rose-600' : d <= 7 ? 'text-amber-600' : 'text-slate-400';
  const text = d < 0 ? `expired ${-d}d ago` : d === 0 ? 'expires today' : `in ${d}d`;
  return <span className={`ml-2 text-xs font-medium ${cls}`}>({text})</span>;
};

const TenantsView = ({ tenants, loading, error, onReload, staff, isSuperAdmin, canCreateTenant }) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [form, setForm] = useState({ open: false, mode: 'create', tenant: null });
  const [usersModal, setUsersModal] = useState({ open: false, tenant: null });
  const [entitlements, setEntitlements] = useState({ open: false, tenant: null });
  const [pendingId, setPendingId] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tenants || []).filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (planFilter !== 'all' && t.plan !== planFilter) return false;
      if (!q) return true;
      return [t.name, t.code, t.region, t.contact_name, t.contact_email]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
  }, [tenants, search, statusFilter, planFilter]);

  const changeStatus = async (tenant, status, verb, extraWarning = '') => {
    const ok = await confirmDialog(`${verb} tenant "${tenant.name}"?${extraWarning ? `\n\n${extraWarning}` : ''}`);
    if (!ok) return;
    setPendingId(tenant.id);
    try {
      await updateTenant(tenant.id, { status });
      notify(`Tenant ${status === 'active' ? 'reactivated' : status}.`, 'success');
      await onReload();
    } catch (e) {
      notify(`Could not update status: ${e?.message || 'error'}`, 'error');
    } finally {
      setPendingId(null);
    }
  };

  const handleSupport = async (tenant) => {
    const ok = await confirmDialog(
      `Open an AUDITED support session inside "${tenant.name}"?\n\n` +
      'You will act as a tenant admin. Every action you take is logged in the ' +
      'tenant’s audit trail and visible to their admins.',
    );
    if (!ok) return;
    setPendingId(tenant.id);
    try {
      await enterSupport(tenant.id); // navigates into the tenant app on success
    } catch (e) {
      notify(`Could not start support session: ${e?.message || 'error'}`, 'error');
      setPendingId(null);
    }
  };

  const handleResync = async (tenant) => {
    const ok = await confirmDialog(
      `Re-sync the equipment catalog for "${tenant.name}"?\n\n` +
      'Adds any catalog items this tenant is missing. Their existing items — ' +
      'quantities, prices, edits — are never touched.',
    );
    if (!ok) return;
    setPendingId(tenant.id);
    try {
      const r = await resyncCatalog(tenant.id);
      notify(r.added > 0 ? `Added ${r.added} catalog item(s).` : 'Catalog already up to date.', 'success');
    } catch (e) {
      notify(`Catalog re-sync failed: ${e?.message || 'error'}`, 'error');
    } finally {
      setPendingId(null);
    }
  };

  const hasFilters = search || statusFilter !== 'all' || planFilter !== 'all';

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <TextInput
            className="pl-9"
            placeholder="Search name, code, region or contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <SelectInput className="w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{TENANT_STATUS[s].label}</option>)}
        </SelectInput>
        <SelectInput className="w-auto" value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
          <option value="all">All plans</option>
          {PLAN_ORDER.map((p) => <option key={p} value={p}>{TENANT_PLAN[p].label}</option>)}
        </SelectInput>
        <GhostButton type="button" onClick={onReload} disabled={loading} title="Refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </GhostButton>
        {canCreateTenant && (
          <PrimaryButton type="button" onClick={() => setForm({ open: true, mode: 'create', tenant: null })}>
            <Plus size={16} /> New tenant
          </PrimaryButton>
        )}
      </div>

      {/* Content */}
      <Card className="!p-0 overflow-hidden">
        {error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load tenants"
            message={error}
            action={<GhostButton onClick={onReload}><RefreshCw size={15} /> Try again</GhostButton>}
          />
        ) : loading && !tenants.length ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-400">
            <RefreshCw size={16} className="animate-spin" /> Loading tenants…
          </div>
        ) : !filtered.length ? (
          <EmptyState
            icon={Building2}
            title={hasFilters ? 'No tenants match your filters' : 'No tenants yet'}
            message={hasFilters ? 'Try clearing the search or filters.' : canCreateTenant ? 'Create your first tenant to get started.' : 'Tenants assigned to you will appear here.'}
            action={hasFilters
              ? <GhostButton onClick={() => { setSearch(''); setStatusFilter('all'); setPlanFilter('all'); }}>Clear filters</GhostButton>
              : canCreateTenant ? <PrimaryButton onClick={() => setForm({ open: true, mode: 'create', tenant: null })}><Plus size={16} /> New tenant</PrimaryButton> : null}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-3">Tenant</th>
                  <th className="px-5 py-3">Region</th>
                  <th className="px-5 py-3">Plan</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Trial / Created</th>
                  <th className="px-5 py-3">Contact</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((t) => {
                  const busy = pendingId === t.id;
                  return (
                    <tr key={t.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <div className="font-semibold text-slate-800">{t.name || '—'}</div>
                        <div className="text-xs text-slate-400 font-mono">{t.code || t.id}</div>
                      </td>
                      <td className="px-5 py-3 text-slate-600">{t.region || '—'}</td>
                      <td className="px-5 py-3"><PlanBadge plan={t.plan} /></td>
                      <td className="px-5 py-3"><StatusBadge status={t.status} /></td>
                      <td className="px-5 py-3 text-slate-600 whitespace-nowrap">
                        {t.plan === 'trial'
                          ? <span>{fmtDate(t.trial_expires_on)}<TrialHint tenant={t} /></span>
                          : <span className="text-slate-400">{fmtDate(t.created_at)}</span>}
                      </td>
                      <td className="px-5 py-3">
                        {t.contact_name || t.contact_email
                          ? (<div>
                              <div className="text-slate-700">{t.contact_name || '—'}</div>
                              {t.contact_email && <div className="text-xs text-slate-400">{t.contact_email}</div>}
                            </div>)
                          : <span className="text-slate-300">—</span>}
                        {Array.isArray(t.assigned_managers) && t.assigned_managers.length > 0 && (
                          <div className="mt-1 inline-flex items-center gap-1 text-xs text-slate-400">
                            <UsersIcon size={12} /> {t.assigned_managers.length} manager{t.assigned_managers.length > 1 ? 's' : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <IconButton title="Manage users" className="hover:text-indigo-600" onClick={() => setUsersModal({ open: true, tenant: t })} disabled={busy}>
                            <UserCog size={15} />
                          </IconButton>
                          <IconButton title="Support access" className="hover:text-rose-600" onClick={() => handleSupport(t)} disabled={busy}>
                            <LifeBuoy size={15} />
                          </IconButton>
                          {isSuperAdmin && (
                            <IconButton title="Plan & features" className="hover:text-indigo-600" onClick={() => setEntitlements({ open: true, tenant: t })} disabled={busy}>
                              <SlidersHorizontal size={15} />
                            </IconButton>
                          )}
                          <IconButton title="Re-sync equipment catalog" className="hover:text-emerald-600" onClick={() => handleResync(t)} disabled={busy}>
                            <PackagePlus size={15} />
                          </IconButton>
                          <IconButton title="Edit" onClick={() => setForm({ open: true, mode: 'edit', tenant: t })} disabled={busy}>
                            <Pencil size={15} />
                          </IconButton>
                          {t.status === 'active' && (
                            <IconButton title="Suspend" className="hover:text-amber-600" onClick={() => changeStatus(t, 'suspended', 'Suspend', 'This immediately signs out all of the tenant’s users until reactivated.')} disabled={busy}>
                              <PauseCircle size={16} />
                            </IconButton>
                          )}
                          {t.status === 'suspended' && (
                            <IconButton title="Reactivate" className="hover:text-emerald-600" onClick={() => changeStatus(t, 'active', 'Reactivate')} disabled={busy}>
                              <PlayCircle size={16} />
                            </IconButton>
                          )}
                          {t.status !== 'churned' && (
                            <IconButton title="Mark churned" className="hover:text-rose-600" onClick={() => changeStatus(t, 'churned', 'Mark as churned', 'Churned tenants are blocked from signing in. Their data is retained.')} disabled={busy}>
                              <UserX size={16} />
                            </IconButton>
                          )}
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

      {(tenants?.length > 0) && (
        <p className="text-xs text-slate-400">
          Showing {filtered.length} of {tenants.length} tenant{tenants.length > 1 ? 's' : ''}.
        </p>
      )}

      <TenantFormModal
        open={form.open}
        mode={form.mode}
        initial={form.tenant}
        staff={staff}
        isSuperAdmin={isSuperAdmin}
        onClose={() => setForm((f) => ({ ...f, open: false }))}
        onSaved={async () => { setForm((f) => ({ ...f, open: false })); await onReload(); }}
      />

      <TenantUsersModal
        open={usersModal.open}
        tenant={usersModal.tenant}
        onClose={() => setUsersModal((s) => ({ ...s, open: false }))}
      />

      <TenantEntitlementsModal
        open={entitlements.open}
        tenant={entitlements.tenant}
        onClose={() => setEntitlements((s) => ({ ...s, open: false }))}
        onSaved={async () => { setEntitlements((s) => ({ ...s, open: false })); await onReload(); }}
      />
    </div>
  );
};

export default TenantsView;
