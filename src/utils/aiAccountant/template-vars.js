// Template variable expansion for journal templates.
//
// Variables are written as `{{name}}` or `{{name:default}}` or
// `{{name|type}}` (e.g. `{{rent|amount}}`). Built-ins resolve automatically:
//   - {{today}}    → ISO date for today (YYYY-MM-DD)
//   - {{month}}    → e.g. "April 2026"
//   - {{year}}     → e.g. "2026"
//   - {{fy}}       → fiscal year string (Apr–Mar) e.g. "2026-27"
//
// extractVariables(tpl) returns a deduplicated array of user-supplied vars
// (built-ins excluded), each `{ name, type, default }`.
//
// applyVariables(tpl, values) returns a new template object with all
// `{{var}}` occurrences in `narration`, `party_name`, and entry strings
// replaced. Entry `amount` fields are coerced to Number after substitution.

const BUILTINS = new Set(['today', 'month', 'year', 'fy']);
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\|\s*([a-zA-Z]+))?(?:\s*:\s*([^}]*))?\s*\}\}/g;

function fyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based; FY starts April (3)
  const start = m >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function builtinValues(now = new Date()) {
  const iso = now.toISOString().slice(0, 10);
  const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return {
    today: iso,
    month: monthName,
    year: String(now.getFullYear()),
    fy: fyOf(now),
  };
}

function* iterStrings(tpl) {
  if (!tpl) return;
  if (tpl.narration) yield tpl.narration;
  if (tpl.party_name) yield tpl.party_name;
  for (const e of tpl.entries || []) {
    if (e?.debitAccount) yield e.debitAccount;
    if (e?.creditAccount) yield e.creditAccount;
    if (typeof e?.amount === 'string') yield e.amount;
  }
}

export function extractVariables(tpl) {
  const seen = new Map();
  for (const s of iterStrings(tpl)) {
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(s)) !== null) {
      const [, name, type, def] = m;
      if (BUILTINS.has(name)) continue;
      if (!seen.has(name)) {
        seen.set(name, {
          name,
          type: type || (name.toLowerCase().includes('amount') || name.toLowerCase().includes('rent') ? 'amount' : 'text'),
          default: def != null ? def.trim() : '',
        });
      }
    }
  }
  return Array.from(seen.values());
}

function substitute(str, lookup) {
  if (typeof str !== 'string') return str;
  return str.replace(VAR_RE, (full, name, _type, def) => {
    if (lookup[name] !== undefined && lookup[name] !== '') return String(lookup[name]);
    if (def != null) return def.trim();
    return full; // leave unknown vars in place so caller can flag them
  });
}

export function applyVariables(tpl, values = {}, now = new Date()) {
  const lookup = { ...builtinValues(now), ...values };
  const out = {
    ...tpl,
    narration: substitute(tpl.narration || '', lookup),
    party_name: substitute(tpl.party_name || '', lookup),
    entries: (tpl.entries || []).map((e) => {
      const debitAccount = substitute(e.debitAccount || '', lookup);
      const creditAccount = substitute(e.creditAccount || '', lookup);
      let amount = e.amount;
      if (typeof amount === 'string') {
        const sub = substitute(amount, lookup);
        const n = Number(sub);
        amount = Number.isFinite(n) ? n : 0;
      } else if (typeof amount !== 'number') {
        amount = 0;
      }
      return { debitAccount, creditAccount, amount };
    }),
  };
  return out;
}

export function hasUnresolvedVariables(tpl) {
  for (const s of iterStrings(tpl)) {
    VAR_RE.lastIndex = 0;
    if (VAR_RE.test(s)) return true;
  }
  return false;
}
