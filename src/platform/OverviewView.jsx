// Platform console — at-a-glance KPIs derived purely from the tenant list.
import React, { useMemo } from 'react';
import {
  Building2, CheckCircle, PauseCircle, UserX, Clock, AlertTriangle, RefreshCw, ArrowRight,
} from 'lucide-react';
import { Card, StatCard, StatusBadge, PlanBadge, GhostButton, EmptyState } from './ui';
import { TENANT_PLAN, PLAN_ORDER, fmtDate, daysUntil } from './constants';

const OverviewView = ({ tenants, loading, error, onReload, onGotoTenants }) => {
  const stats = useMemo(() => {
    const list = tenants || [];
    const by = (s) => list.filter((t) => t.status === s).length;
    const trials = list.filter((t) => t.plan === 'trial');
    const expiringSoon = trials
      .map((t) => ({ t, d: daysUntil(t.trial_expires_on) }))
      .filter((x) => x.d !== null && x.d <= 7)
      .sort((a, b) => a.d - b.d);
    const planCounts = PLAN_ORDER.map((p) => ({ plan: p, count: list.filter((t) => t.plan === p).length }));
    const recent = [...list]
      .filter((t) => t.created_at)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);
    return {
      total: list.length,
      active: by('active'),
      suspended: by('suspended'),
      churned: by('churned'),
      trials: trials.length,
      expiringSoon,
      planCounts,
      recent,
    };
  }, [tenants]);

  if (error) {
    return (
      <Card>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load data"
          message={error}
          action={<GhostButton onClick={onReload}><RefreshCw size={15} /> Try again</GhostButton>}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Building2} label="Total tenants" value={stats.total} accent="text-indigo-600" iconBg="bg-indigo-50" sub={loading ? 'refreshing…' : undefined} />
        <StatCard icon={CheckCircle} label="Active" value={stats.active} accent="text-emerald-600" iconBg="bg-emerald-50" />
        <StatCard icon={PauseCircle} label="Suspended" value={stats.suspended} accent="text-amber-600" iconBg="bg-amber-50" />
        <StatCard icon={UserX} label="Churned" value={stats.churned} accent="text-rose-600" iconBg="bg-rose-50" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Trials expiring soon */}
        <Card className="lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-base font-bold text-slate-800">
              <Clock size={18} className="text-amber-500" /> Trials expiring soon
            </h3>
            <span className="text-xs font-medium text-slate-400">{stats.trials} on trial</span>
          </div>
          {stats.expiringSoon.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No trials expiring within 7 days.</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {stats.expiringSoon.map(({ t, d }) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-700">{t.name}</div>
                    <div className="truncate text-xs text-slate-400">{t.code} · {fmtDate(t.trial_expires_on)}</div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                    d < 0 ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : d === 0 ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                    {d < 0 ? `expired ${-d}d ago` : d === 0 ? 'expires today' : `${d}d left`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Plan mix */}
        <Card>
          <h3 className="mb-4 text-base font-bold text-slate-800">Plan mix</h3>
          <div className="space-y-3">
            {stats.planCounts.map(({ plan, count }) => {
              const pct = stats.total ? Math.round((count / stats.total) * 100) : 0;
              return (
                <div key={plan}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <PlanBadge plan={plan} />
                    <span className="font-semibold text-slate-700">{count} <span className="text-slate-400 font-normal">· {pct}%</span></span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
            {stats.total === 0 && <p className="py-4 text-center text-sm text-slate-400">No tenants yet.</p>}
          </div>
        </Card>
      </div>

      {/* Recently added */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">Recently added</h3>
          <button onClick={onGotoTenants} className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700">
            View all tenants <ArrowRight size={14} />
          </button>
        </div>
        {stats.recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Nothing to show yet.</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {stats.recent.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <span className="min-w-[140px] flex-1 font-semibold text-slate-700">{t.name}</span>
                <PlanBadge plan={t.plan} />
                <StatusBadge status={t.status} />
                <span className="text-xs text-slate-400">{fmtDate(t.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};

export default OverviewView;
