import React, { useMemo } from 'react';
import { Sparkles, AlertTriangle, Lightbulb, Info, TrendingUp } from 'lucide-react';
import { analyzePostedEntries } from '../../utils/aiAccountant';

// Mirrors the predicate in Accounting.jsx — only AI-authored entries are analysed.
const isAiEntry = (e) => e?.origin === 'ai_chat' || e?.source === 'chat_entry' || e?.source === 'scheduled_post';

const SEV_PILL = {
  blocking: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  advisory: 'bg-blue-100 text-blue-700',
};
const CARD_TONE = {
  slate: 'border-slate-200 bg-slate-50 text-slate-800',
  indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  green: 'border-green-200 bg-green-50 text-green-800',
};

const StatCard = ({ label, value, sub, tone = 'slate' }) => (
  <div className={`rounded-xl border p-4 ${CARD_TONE[tone]}`}>
    <p className="text-xs font-semibold opacity-80">{label}</p>
    <p className="mt-1 text-2xl font-bold">{value}</p>
    {sub && <p className="text-xs opacity-70">{sub}</p>}
  </div>
);

const HotTable = ({ title, rows }) => (
  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</div>
    {rows.length === 0 ? (
      <div className="px-3 py-4 text-center text-xs text-slate-400">Nothing notable yet</div>
    ) : (
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-3 py-1.5 text-slate-700 truncate max-w-[160px]" title={r.key}>{r.key}</td>
              <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-500">{r.flagged}/{r.total}</td>
              <td className="px-3 py-1.5 w-24">
                <div className="h-1.5 w-full rounded-full bg-slate-100">
                  <div className="h-1.5 rounded-full bg-amber-400" style={{ width: `${Math.round(r.ratio * 100)}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

/**
 * Read-only Process-Analyst dashboard. Derives everything from the journal
 * entries already in memory — no Firestore reads, no writes.
 */
const AiInsightsPanel = ({ entries = [], fyFilter = 'all' }) => {
  const insights = useMemo(() => {
    const scoped = (entries || [])
      .filter(isAiEntry)
      .filter((e) => fyFilter === 'all' || e.fy === fyFilter);
    return analyzePostedEntries(scoped);
  }, [entries, fyFilter]);

  const h = insights.health;

  if (insights.sampleSize === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">
        No AI-created entries to analyse yet{fyFilter !== 'all' ? ' for this year' : ''}. Post a few from the Ask Assistant and insights will appear here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
        <h3 className="flex items-center gap-2 text-sm font-bold text-indigo-700"><TrendingUp size={16} /> AI Insights — Process Analyst</h3>
        <p className="mt-0.5 text-xs text-slate-500">Patterns the assistant is learning from your posted AI entries — audit health, weak spots, and rule ideas. Read-only; nothing is changed automatically.</p>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard tone="indigo" label="AI entries analysed" value={insights.sampleSize} sub={insights.untraced ? `${insights.untraced} pre-trace` : 'all traced'} />
        <StatCard tone="green" label="Avg audit score" value={h.avgAuditScore == null ? '—' : `${h.avgAuditScore}/100`} sub={`${h.clean} clean`} />
        <StatCard tone="amber" label="Posted below confidence bar" value={`${h.belowConfidencePct}%`} sub={`${h.belowConfidenceBar} of ${insights.sampleSize}`} />
        <StatCard tone="amber" label="Posted with warnings" value={h.withWarnings} sub={`${h.withAdvisories} with advisories`} />
      </div>

      {/* Top finding codes */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"><AlertTriangle size={13} /> Most common audit findings</p>
        {insights.topFindingCodes.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400">No findings — your AI entries are posting clean.</p>
        ) : (
          <div className="space-y-1.5">
            {insights.topFindingCodes.slice(0, 8).map((f) => (
              <div key={f.code} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${SEV_PILL[f.severity] || 'bg-slate-100 text-slate-600'}`}>{f.severity}</span>
                <span className="font-mono text-slate-700">{f.code}</span>
                <span className="text-slate-400">×{f.count} ({f.pct}%)</span>
                {f.fix && <span className="ml-auto max-w-[45%] text-right text-slate-400">{f.fix}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suggested rules */}
      {insights.suggestions.length > 0 && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-emerald-700"><Lightbulb size={13} /> Rule ideas</p>
          <ul className="space-y-1.5">
            {insights.suggestions.map((s) => (
              <li key={s.code + s.account} className="flex items-start gap-2 text-xs text-slate-700">
                <Lightbulb size={12} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>{s.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex items-center gap-1 text-[10px] text-slate-400"><Info size={10} /> Observed outcomes, not automatic rules — the assistant never changes a mapping on its own.</p>
        </div>
      )}

      {/* Hotspots */}
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Weak spots (flagged / total)</p>
        <div className="grid gap-3 lg:grid-cols-3">
          <HotTable title="By party" rows={insights.hotspots.byParty} />
          <HotTable title="By account" rows={insights.hotspots.byAccount} />
          <HotTable title="By prompt word" rows={insights.hotspots.byPromptToken} />
        </div>
      </div>

      {/* Alias trends */}
      {insights.aliasTrends.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Party name corrections</p>
          <div className="flex flex-wrap gap-2">
            {insights.aliasTrends.map((a) => (
              <span key={a.typed} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                “{a.typed}” → <span className="font-semibold text-slate-800">{a.party}</span> <span className="text-slate-400">×{a.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AiInsightsPanel;
