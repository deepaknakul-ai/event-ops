// Platform console — authenticated layout: header, tab nav, data loading.
import React, { useCallback, useEffect, useState } from 'react';
import { LayoutDashboard, Building2, Users, LogOut, Building } from 'lucide-react';
import { confirmDialog } from '../utils/dialog';
import { RoleBadge } from './ui';
import { initials } from './constants';
import { listTenants, listStaff, platformLogout } from './api';
import OverviewView from './OverviewView';
import TenantsView from './TenantsView';
import StaffView from './StaffView';

const PlatformShell = ({ session, onSignedOut }) => {
  const role = session?.role;
  const isSuperAdmin = role === 'super_admin';                 // may manage staff + region/managers
  const canCreateTenant = role === 'super_admin' || role === 'regional_admin'; // business_manager cannot
  const [tab, setTab] = useState('overview');

  // ── Tenants (shared by Overview + Tenants tabs) ─────────────────────────────
  const [tenants, setTenants] = useState([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState('');

  const reloadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError('');
    try {
      const { tenants: rows } = await listTenants();
      setTenants(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setTenantsError(e?.message || 'Failed to load tenants.');
    } finally {
      setTenantsLoading(false);
    }
  }, []);

  // ── Staff (admin tab + manager autocomplete). Best-effort. ──────────────────
  const [staff, setStaff] = useState([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffError, setStaffError] = useState('');

  const reloadStaff = useCallback(async () => {
    setStaffLoading(true);
    setStaffError('');
    try {
      const res = await listStaff();
      setStaff(Array.isArray(res?.staff) ? res.staff : Array.isArray(res) ? res : []);
    } catch (e) {
      setStaffError(e?.message || 'Failed to load staff.');
      setStaff([]);
    } finally {
      setStaffLoading(false);
    }
  }, []);

  useEffect(() => { reloadTenants(); }, [reloadTenants]);
  // Only super_admins can call platformManageStaff('list'); skip for others.
  useEffect(() => { if (isSuperAdmin) reloadStaff(); else setStaffLoading(false); }, [isSuperAdmin, reloadStaff]);

  const handleSignOut = async () => {
    if (!(await confirmDialog('Sign out of the platform console?'))) return;
    await platformLogout();
    onSignedOut();
  };

  const NAV = [
    { key: 'overview', label: 'Overview', icon: LayoutDashboard },
    { key: 'tenants', label: 'Tenants', icon: Building2 },
    ...(isSuperAdmin ? [{ key: 'staff', label: 'Staff', icon: Users }] : []),
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 shadow-sm shadow-indigo-200">
              <Building className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight text-slate-800">Platform Console</h1>
              <p className="text-[11px] leading-tight text-slate-400">Tenant operations</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-semibold text-slate-700">{session?.name || 'Staff'}</div>
              <div className="mt-0.5"><RoleBadge role={session?.role} /></div>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
              {initials(session?.name)}
            </div>
            <button
              onClick={handleSignOut}
              title="Sign out"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition"
            >
              <LogOut size={15} /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>

        {/* Tab nav */}
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <nav className="-mb-px flex gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                  tab === item.key
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <item.icon size={16} /> {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {tab === 'overview' && (
          <OverviewView
            tenants={tenants}
            loading={tenantsLoading}
            error={tenantsError}
            onReload={reloadTenants}
            onGotoTenants={() => setTab('tenants')}
          />
        )}
        {tab === 'tenants' && (
          <TenantsView
            tenants={tenants}
            loading={tenantsLoading}
            error={tenantsError}
            onReload={reloadTenants}
            staff={staff}
            isSuperAdmin={isSuperAdmin}
            canCreateTenant={canCreateTenant}
          />
        )}
        {tab === 'staff' && isSuperAdmin && (
          <StaffView
            staff={staff}
            loading={staffLoading}
            error={staffError}
            onReload={reloadStaff}
            session={session}
            tenants={tenants}
          />
        )}
      </main>
    </div>
  );
};

export default PlatformShell;
