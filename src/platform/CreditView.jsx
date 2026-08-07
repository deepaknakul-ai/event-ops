// Platform console — cross-tenant credit intelligence (super_admin or a staff
// member the super_admin marked can_view_credit). Shows the NUMERIC scores + the
// per-tenant contribution breakdown that produced them. Tenants never see any of
// this — only the colour band, mirrored into their own settings/credit_labels.
// Drives platformListCreditScores (list + {pan} drill-down).
import React, { useState } from 'react';
import { RefreshCw, AlertTriangle, Gauge, ChevronRight, ChevronDown, Building2, Loader2 } from 'lucide-react';
import { Card, GhostButton, EmptyState } from './ui';
import { CREDIT_BAND, CREDIT_BAND_ORDER, fmtDate } from './constants';
import { creditScoreDetail } from './api';

const fmtINR = (v) => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(v) || 0));
const round = (v) => Math.round(Number(v) || 0);

const BandChip = ({ band }) => {
  const b = CREDIT_BAND[band] || CREDIT_BAND.gray;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${b.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${b.dot}`} />{b.label}
    </span>
  );
};

// A staff-only numeric score, colour-tinted by band.
const ScoreDot = ({ band, score }) => {
  const b = CREDIT_BAND[band] || CREDIT_BAND.gray;
  return (
    <span className={`inline-flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold tabular-nums ${b.badge}`}>
      {band === 'gray' ? '—' : round(score)}
    </span>
  );
};

const FACTOR_LABELS = {
  delay: 'Payment delay', overdueRatio: 'Overdue exposure', delinquency: '90+ delinquency',
  worstDelinquency: 'Worst-ever delinquency', trend: 'Payment trend',
  chronic: 'Chronic lateness', defaultRisk: 'Default risk', tenure: 'Relationship depth',
};

const OUTLOOK = {
  improving: { label: 'Improving', arrow: '↑', cls: 'text-emerald-600' },
  stable:    { label: 'Stable',    arrow: '→', cls: 'text-slate-500' },
  worsening: { label: 'Worsening', arrow: '↓', cls: 'text-rose-600' },
};

const OutlookTag = ({ outlook }) => {
  const o = OUTLOOK[outlook] || OUTLOOK.stable;
  return <span className={`inline-flex items-center gap-1 text-xs font-semibold ${o.cls}`} title="Payment-behaviour trend">{o.arrow} {o.label}</span>;
};

// A 0..100 sub-score as a small bar (higher = safer → greener).
const FactorBar = ({ label, value }) => {
  const v = Math.max(0, Math.min(100, round(value)));
  const tone = v >= 70 ? 'bg-emerald-500' : v >= 40 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 shrink-0 text-xs text-slate-500">{label}</div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </div>
      <div className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-600">{v}</div>
    </div>
  );
};

const Drilldown = ({ pan }) => {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setErr('');
    creditScoreDetail(pan)
      .then((r) => { if (alive) setDetail(r?.score || null); })
      .catch((e) => { if (alive) setErr(e?.message || 'Failed to load detail.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [pan]);

  if (loading) return <div className="flex items-center gap-2 px-5 py-6 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Loading breakdown…</div>;
  if (err) return <div className="px-5 py-6 text-sm text-rose-500">{err}</div>;
  if (!detail) return null;

  const factors = detail.factors || {};
  const agg = detail.aggregate || {};
  const reasons = Array.isArray(detail.reasons) ? detail.reasons : [];
  const contributions = detail.contributions || {};
  const contribRows = Object.entries(contributions);

  return (
    <div className="grid gap-6 bg-slate-50/60 px-5 py-5 lg:grid-cols-2">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Score factors (100 = safest)</p>
          <OutlookTag outlook={detail.outlook} />
        </div>
        <div className="space-y-2">
          {Object.keys(FACTOR_LABELS).map((k) => <FactorBar key={k} label={FACTOR_LABELS[k]} value={factors[k]} />)}
        </div>
        {reasons.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Why this band</p>
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-slate-600">
              {reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Worst-ever {Math.round(Number(agg.maxDaysLate) || 0)}d late
          {Number(agg.beyond45Amt) > 0 ? ` · ${fmtINR(agg.beyond45Amt)} past MSME 45-day limit` : ''}
          {Number(agg.timeBarredAmt) > 0 ? ` · ${fmtINR(agg.timeBarredAmt)} time-barred` : ''}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Sample: {detail.sample_size || 0} invoice(s) · confidence {detail.confidence || 'low'} · last computed {fmtDate(detail.computed_at)}
        </p>
      </div>
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Contributing tenants ({contribRows.length})</p>
        {contribRows.length ? (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2 text-right">Billed</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2 text-right">Avg days late</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {contribRows.map(([appId, c]) => (
                  <tr key={appId}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-700">{c.tenant_name || appId}</div>
                      <div className="text-[11px] text-slate-400">as “{c.party_name || '—'}”</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtINR(c.billed)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtINR(c.outstanding)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{round(c.avgDaysLate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-400">No tenant contributions recorded.</p>}
      </div>
    </div>
  );
};

const CreditView = ({ scores = [], loading, error, onReload }) => {
  const [openPan, setOpenPan] = useState(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">Cross-tenant credit-worthiness of parties, matched by PAN. Riskiest first.</p>
          <p className="mt-1 text-xs text-slate-400">Numeric scores are visible only here (staff). Tenants see only the colour label on their own clients &amp; vendors.</p>
        </div>
        <GhostButton type="button" onClick={onReload} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </GhostButton>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {CREDIT_BAND_ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-2 text-xs text-slate-500">
            <span className={`h-2.5 w-2.5 rounded-full ${CREDIT_BAND[k].dot}`} />
            <span className="font-semibold text-slate-600">{CREDIT_BAND[k].label}</span> — {CREDIT_BAND[k].desc}
          </span>
        ))}
      </div>

      <Card className="!p-0 overflow-hidden">
        {error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Credit scores unavailable"
            message={`${error}. Scores are produced by the nightly job once tenants on the credit-intelligence plan have billing history.`}
            action={<GhostButton onClick={onReload}><RefreshCw size={15} /> Try again</GhostButton>}
          />
        ) : loading && !scores.length ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-400">
            <RefreshCw size={16} className="animate-spin" /> Loading credit scores…
          </div>
        ) : !scores.length ? (
          <EmptyState
            icon={Gauge}
            title="No scores yet"
            message="The nightly bureau pass scores parties once participating tenants have invoices and payments. Check back after the next run."
            action={<GhostButton onClick={onReload}><RefreshCw size={15} /> Refresh</GhostButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-3">Party</th>
                  <th className="px-5 py-3">Band</th>
                  <th className="px-5 py-3 text-center">Score</th>
                  <th className="px-5 py-3 text-right">Outstanding</th>
                  <th className="px-5 py-3 text-center">Tenants</th>
                  <th className="px-5 py-3 text-center">Confidence</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {scores.map((s) => {
                  const open = openPan === s.pan;
                  const agg = s.aggregate || {};
                  return (
                    <React.Fragment key={s.pan}>
                      <tr
                        className="cursor-pointer hover:bg-slate-50/70"
                        onClick={() => setOpenPan(open ? null : s.pan)}
                      >
                        <td className="px-5 py-3">
                          <div className="font-semibold text-slate-800">{(s.names && s.names[0]) || s.pan}</div>
                          <div className="font-mono text-[11px] text-slate-400">
                            {s.pan}{s.names && s.names.length > 1 ? ` · +${s.names.length - 1} alias` : ''}
                          </div>
                        </td>
                        <td className="px-5 py-3"><div className="flex flex-col items-start gap-1"><BandChip band={s.band} /><OutlookTag outlook={s.outlook} /></div></td>
                        <td className="px-5 py-3 text-center"><ScoreDot band={s.band} score={s.score} /></td>
                        <td className="px-5 py-3 text-right tabular-nums text-slate-600">{fmtINR(agg.outstanding)}</td>
                        <td className="px-5 py-3 text-center tabular-nums text-slate-600">
                          <span className="inline-flex items-center gap-1"><Building2 size={13} className="text-slate-400" />{s.contributor_count || 0}</span>
                        </td>
                        <td className="px-5 py-3 text-center">
                          <span className={`text-xs font-medium ${s.confidence === 'high' ? 'text-slate-600' : 'text-slate-400'}`}>{s.confidence || 'low'}</span>
                        </td>
                        <td className="px-5 py-3 text-right text-slate-400">
                          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} className="p-0"><Drilldown pan={s.pan} /></td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default CreditView;
