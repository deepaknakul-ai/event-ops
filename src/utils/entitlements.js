// Client-side plan-entitlements gate. Mirrors the permissions.js live-config
// pattern: App.jsx loads the tenant's settings/entitlements doc (SaaS only) and
// calls setEntitlements; components import featureOn()/getLimit() to gate UI.
//
// DEFAULT-ON is the safety contract: if no entitlements are loaded — the PRIVATE
// edition (never loads them) or the brief window before load on SaaS — every
// feature reads as ON. So this can never hide a feature in the private app, and
// a load failure degrades to "show everything" rather than locking a tenant out.
// The SERVER still enforces (WhatsApp gate, user cap); this is UX only.
let _entitlements = null;

export function setEntitlements(ent) {
  _entitlements = ent && typeof ent === 'object' ? ent : null;
}

export function getEntitlements() {
  return _entitlements;
}

// A feature is ON unless the loaded entitlements explicitly set it to false.
export function featureOn(feature) {
  if (!_entitlements || !_entitlements.features) return true;
  return _entitlements.features[feature] !== false;
}

// Numeric limit for a key (e.g. 'max_users'); null = unlimited / unknown.
export function getLimit(key) {
  if (!_entitlements || !_entitlements.limits) return null;
  const v = _entitlements.limits[key];
  return v === undefined ? null : v;
}
