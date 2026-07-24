// Platform console — the single backend contract surface.
//
// Every Cloud Function the console talks to is declared here and nowhere else,
// so when the backend lands the lead has exactly one file to reconcile.
//
// Names + payloads verified against functions/platform.js (createPlatform
// factory) — the backend handlers this console drives. functions/index.js wires
// each factory key as an onCall of the SAME name, so the callable ids below are
// exact. Handlers are data-gated: on a non-SaaS deployment they throw
// failed-precondition, so callers degrade gracefully.
//
// Auth model: platformLogin returns a Firebase custom token. We sign the shared
// Firebase app in with it so subsequent httpsCallable() calls carry the staff
// auth context (the other callables take no token param). NOTE: this uses the
// app's default `auth` instance — signing in/out here affects the shared session
// in this browser, which is expected for the dedicated /platform route.

import { httpsCallable, getFunctions } from 'firebase/functions';
import { signInWithCustomToken, signOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase';
import { setAppId } from '../utils/constants';

const call = (name, payload = {}) =>
  httpsCallable(getFunctions(), name)(payload).then((r) => r.data);

// ── Session identity cache (per-tab) ─────────────────────────────────────────
const SESSION_KEY = 'platform_session';

export const loadSession = () => {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
};
const saveSession = (s) => {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
};
const clearSession = () => {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
};

// Subscribe to the underlying Firebase auth state. cb receives the user (or null).
export const onPlatformAuth = (cb) => onAuthStateChanged(auth, cb);

// ── Auth ─────────────────────────────────────────────────────────────────────
export const platformLogin = async ({ username, password }) => {
  const data = await call('platformLogin', { username, password }); // {token, staffId, role, name}
  if (data?.token) {
    try {
      await signInWithCustomToken(auth, data.token);
    } catch (e) {
      throw new Error('Session could not be established: ' + (e?.message || e));
    }
  }
  const session = { staffId: data?.staffId || null, role: data?.role || 'business_manager', name: data?.name || username };
  saveSession(session);
  return session;
};

export const platformLogout = async () => {
  clearSession();
  try { await signOut(auth); } catch { /* ignore */ }
};

// ── Tenants ──────────────────────────────────────────────────────────────────
// listTenants -> {tenants:[{id(=code), name, code, region, status, plan,
//   trial_expires_on, assigned_managers[], contact_*, notes, created_at, ...}]}
export const listTenants  = () => call('platformListTenants', {});
// create -> {ok, tenant, ownerLogin:{username:'admin', note}}. Requires ownerPassword.
export const createTenant = (payload) => call('platformCreateTenant', payload);
// update -> {ok, tenant}. Status/suspend/churn all go through here as patch.status.
// patch keys: name, region, status, plan, trial_expires_on, assigned_managers,
// contact_name, contact_email, contact_phone, notes (region & assigned_managers
// are super_admin-only; the backend rejects them otherwise). There is no delete.
export const updateTenant = (tenantId, patch) => call('platformUpdateTenant', { tenantId, patch });
// Mint a time-boxed support (tenant-admin) token.
export const supportAccess = (tenantId) => call('platformSupportAccess', { tenantId });

// Enter a tenant's workspace as audited support: mint the token, point the app
// at that tenant, sign in with the token, and hard-navigate to the tenant app.
// A full reload guarantees clean re-hydration of the host app under the new
// appId; App.jsx then shows the red "SUPPORT SESSION" banner from the claim.
export const enterSupport = async (tenantId) => {
  const { token, tenant } = await supportAccess(tenantId);
  setAppId(tenant?.id || tenantId);
  await signInWithCustomToken(auth, token);
  window.location.assign('/dashboard');
};

// ── Staff (single multiplexed callable; super_admin only) ────────────────────
export const listStaff    = () => call('platformManageStaff', { op: 'list' });                        // -> {staff:[...]}
export const createStaff  = (data) => call('platformManageStaff', { op: 'create', data });            // {name,username,email,role,regions,assigned_tenants,password} -> {ok, staff}
export const updateStaff  = (staffId, data) => call('platformManageStaff', { op: 'update', staffId, data }); // {name,email,role,regions,assigned_tenants,status,password?} -> {ok}
export const disableStaff = (staffId) => call('platformManageStaff', { op: 'disable', staffId });      // -> {ok}
