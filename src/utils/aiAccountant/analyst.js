// ─────────────────────────────────────────────────────────────────────────────
// Process-Analyst Agent (Phase 1) — PURE, deterministic. Mines the ai_* fields
// already persisted on posted journal_entries (ai_decision_trace, ai_issues,
// ai_confidence, ai_prompt, ai_party_alias, entries) and returns a structured
// "insights" object for a read-only dashboard. It COMPLEMENTS learnFromEntries
// (which answers "which account does token/party map to"); the Analyst adds the
// audit/quality dimension: advisory recurrence, low-confidence/high-flag hotspots,
// audit-score trend, and alias-correction trends.
//
// Honest limitation: only the FINAL posted account is stored, never the AI's
// pre-edit draft — so a "suggestion" reports an OBSERVED outcome ("you booked X
// to Y N times"), not a proven correction. The UI copy reflects that.
// ─────────────────────────────────────────────────────────────────────────────
import { round2 } from './schema.js';
import { normalizeAliasKey } from './party.js';

// validateTransaction issue.level → the audit severity taxonomy (mirrors
// orchestrator.js; re-declared to keep this module dependency-light).
const SEVERITY_BY_LEVEL = { error: 'blocking', warning: 'warning', info: 'advisory' };
const CONTROL_RE = /^cash\b|^bank\b|^party:/i;

/** The audit findings for an entry: the trace's if present, else derived from ai_issues. */
function findingsOf(entry) {
  const traceFindings = entry?.ai_decision_trace?.audit?.findings;
  if (Array.isArray(traceFindings)) return traceFindings;
  const issues = Array.isArray(entry?.ai_issues) ? entry.ai_issues : [];
  return issues.map((i) => ({ severity: SEVERITY_BY_LEVEL[i.level] || 'advisory', code: i.code, message: i.message }));
}

/** The "interesting" account of an entry: first non-control debit, else first debit. */
export function primaryAccount(entry) {
  const legs = Array.isArray(entry?.entries) ? entry.entries : [];
  const hit = legs.find((l) => l.debitAccount && !CONTROL_RE.test(l.debitAccount));
  return hit ? hit.debitAccount : (legs[0]?.debitAccount || null);
}

/** An entry is "flagged" if it carries a warning finding or was posted below the confidence bar. */
export function isFlagged(entry, bar = 0.55) {
  const findings = findingsOf(entry);
  const conf = entry?.ai_confidence;
  return findings.some((f) => f.severity === 'warning') || (typeof conf === 'number' && conf < bar);
}

function tokensOf(prompt) {
  const toks = String(prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  return Array.from(new Set(toks)); // once per entry
}

function bump(map, key, flagged) {
  if (!map[key]) map[key] = { flagged: 0, total: 0 };
  map[key].total++;
  if (flagged) map[key].flagged++;
}

const pct = (n, d) => (d ? round2((100 * n) / d) : 0);

/**
 * @param {object[]} entries  posted journal_entries carrying the ai_* fields
 * @param {{ confidenceBar?:number, minRecurrence?:number, dominantRatio?:number, minHotspotSample?:number, topN?:number }} [opts]
 * @returns {object} insights
 */
export function analyzePostedEntries(entries, opts = {}) {
  const bar = opts.confidenceBar ?? 0.55;
  const minRecurrence = opts.minRecurrence ?? 3;
  const dominantRatio = opts.dominantRatio ?? 0.6;
  const minHotspotSample = opts.minHotspotSample ?? 2;
  const topN = opts.topN ?? 5;

  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.source !== 'fy_closing');

  let untraced = 0;
  let withWarnings = 0, withAdvisories = 0, clean = 0;
  let scoreSum = 0, scored = 0;
  let belowBar = 0, withConf = 0;
  const byModel = {}, byIntent = {};
  const codeCount = {};   // code -> { severity, fix, count }
  const codeAccount = {}; // code -> { accounts:{acct->count}, total }
  const hotParty = {}, hotAccount = {}, hotToken = {};
  const aliasMap = {};    // normKey -> { typed, party, count }

  for (const e of list) {
    const findings = findingsOf(e);
    if (!e.ai_decision_trace) untraced++;

    const hasWarn = findings.some((f) => f.severity === 'warning');
    const hasAdv = findings.some((f) => f.severity === 'advisory');
    if (hasWarn) withWarnings++;
    if (hasAdv) withAdvisories++;
    if (!findings.length) clean++;

    const score = e?.ai_decision_trace?.audit?.auditScore;
    if (typeof score === 'number') { scoreSum += score; scored++; }
    const conf = e.ai_confidence;
    if (typeof conf === 'number') { withConf++; if (conf < bar) belowBar++; }
    byModel[e.ai_model || 'rule-v1'] = (byModel[e.ai_model || 'rule-v1'] || 0) + 1;
    byIntent[e.ai_intent || 'unknown'] = (byIntent[e.ai_intent || 'unknown'] || 0) + 1;

    const acct = primaryAccount(e);
    const flagged = isFlagged(e, bar);

    for (const f of findings) {
      if (!f.code) continue;
      if (!codeCount[f.code]) codeCount[f.code] = { severity: f.severity, fix: f.fix, count: 0 };
      codeCount[f.code].count++;
      // Recurring advisory/warning + a dominant account → suggest a rule. Skip
      // missing_narration (not actionable as an account rule).
      if (f.code !== 'missing_narration' && acct) {
        if (!codeAccount[f.code]) codeAccount[f.code] = { accounts: {}, total: 0 };
        codeAccount[f.code].accounts[acct] = (codeAccount[f.code].accounts[acct] || 0) + 1;
        codeAccount[f.code].total++;
      }
    }

    const partyKey = e.party_name || e?.ai_party_alias?.party;
    if (partyKey) bump(hotParty, partyKey, flagged);
    if (acct) bump(hotAccount, acct, flagged);
    for (const tok of tokensOf(e.ai_prompt)) bump(hotToken, tok, flagged);

    const alias = e.ai_party_alias;
    if (alias && alias.alias && alias.party) {
      const k = normalizeAliasKey(alias.alias);
      if (!aliasMap[k]) aliasMap[k] = { typed: alias.alias, party: alias.party, count: 0 };
      aliasMap[k].count++;
    }
  }

  const total = list.length;

  const topFindingCodes = Object.entries(codeCount)
    .map(([code, v]) => ({ code, severity: v.severity, count: v.count, pct: pct(v.count, total), ...(v.fix ? { fix: v.fix } : {}) }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const suggestions = Object.entries(codeAccount)
    .map(([code, v]) => {
      const [account, hits] = Object.entries(v.accounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return { type: 'rule', code, account, hits, total: v.total, ratio: round2(hits / v.total) };
    })
    .filter((s) => s.total >= minRecurrence && s.ratio >= dominantRatio && s.account)
    .sort((a, b) => b.hits - a.hits || b.ratio - a.ratio)
    .map((s) => ({ ...s, message: `You booked entries flagged "${s.code}" to ${s.account} ${s.hits}/${s.total} times — add a rule?` }));

  const rankHot = (map) => Object.entries(map)
    .map(([key, v]) => ({ key, flagged: v.flagged, total: v.total, ratio: round2(v.flagged / v.total) }))
    .filter((h) => h.total >= minHotspotSample)
    .sort((a, b) => b.flagged - a.flagged || b.ratio - a.ratio || a.key.localeCompare(b.key))
    .slice(0, topN);

  const aliasTrends = Object.values(aliasMap)
    .sort((a, b) => b.count - a.count || a.typed.localeCompare(b.typed))
    .slice(0, topN);

  return {
    sampleSize: total,
    untraced,
    health: {
      total,
      withWarnings,
      withAdvisories,
      clean,
      avgAuditScore: scored ? round2(scoreSum / scored) : null,
      belowConfidenceBar: belowBar,
      belowConfidencePct: withConf ? round2((100 * belowBar) / withConf) : 0,
      byModel,
      byIntent,
    },
    topFindingCodes,
    suggestions,
    hotspots: {
      byParty: rankHot(hotParty),
      byAccount: rankHot(hotAccount),
      byPromptToken: rankHot(hotToken),
    },
    aliasTrends,
  };
}
