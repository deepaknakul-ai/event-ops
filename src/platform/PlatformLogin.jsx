// Platform console — staff sign-in card. Mirrors the host app login card.
// Two modes:
//   'login' — username + password (default).
//   'setup' — first-time password setup: username + one-time setup key + a new
//             password. Reached either by clicking "First-time setup" or
//             automatically when platformLogin rejects with PASSWORD_SETUP_REQUIRED.
import React, { useState } from 'react';
import { Building2, Loader2, KeyRound, ArrowLeft, ShieldCheck } from 'lucide-react';
import { platformLogin, setupPassword } from './api';

const FIELD_CLASS =
  'w-full rounded-lg border border-slate-200 p-3 text-sm text-slate-800 outline-none ' +
  'focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all disabled:bg-slate-50 disabled:text-slate-400';

const MIN_PW = 10;

// The backend signals "this account has no password yet" by throwing an error
// whose message carries this token.
const isSetupRequired = (msg) => /PASSWORD_SETUP_REQUIRED/i.test(msg || '');

// Turn the locked backend error messages into something a human can act on,
// while still falling back to the raw message for anything unexpected.
const prettySetupError = (msg = '') => {
  const m = String(msg || '');
  if (/expire/i.test(m)) return 'That setup key has expired. Ask a super admin to reissue one.';
  if (/rate|too many|throttl|later/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
  if (/invalid|incorrect|mismatch|no match|not found|wrong/i.test(m)) return 'Username or setup key is incorrect.';
  return m || 'Could not complete setup. Check the details and try again.';
};

// 0..4 crude strength score for the hint meter.
const pwScore = (pw = '') => {
  let s = 0;
  if (pw.length >= MIN_PW) s += 1;
  if (pw.length >= 14) s += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s += 1;
  if (/\d/.test(pw)) s += 1;
  if (/[^A-Za-z0-9]/.test(pw)) s += 1;
  return Math.min(s, 4);
};
const STRENGTH = [
  { label: 'Too short', color: 'bg-rose-500', text: 'text-rose-600' },
  { label: 'Weak', color: 'bg-amber-500', text: 'text-amber-600' },
  { label: 'Fair', color: 'bg-amber-500', text: 'text-amber-600' },
  { label: 'Good', color: 'bg-emerald-500', text: 'text-emerald-600' },
  { label: 'Strong', color: 'bg-emerald-600', text: 'text-emerald-700' },
];

const PlatformLogin = ({ onSuccess }) => {
  const [mode, setMode] = useState('login');            // 'login' | 'setup'
  const [form, setForm] = useState({ username: '', password: '' });
  const [setup, setSetup] = useState({ username: '', setupKey: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');                 // non-error banner (e.g. setup prompt)
  const [busy, setBusy] = useState(false);

  const goSetup = (prefillUser = '') => {
    setSetup((s) => ({ ...s, username: prefillUser || s.username }));
    setError('');
    setMode('setup');
  };
  const goLogin = () => {
    setError('');
    setInfo('');
    setMode('login');
  };

  // ── Normal sign-in ──────────────────────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault();
    if (!form.username.trim() || !form.password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const session = await platformLogin({ username: form.username.trim(), password: form.password });
      onSuccess(session);
    } catch (err) {
      const msg = err?.message || '';
      if (isSetupRequired(msg)) {
        // Account exists but has never set a password — flip into setup mode and
        // carry the username across so the operator only enters the key + password.
        setInfo('This account still needs a password. Enter the one-time setup key you were given to finish.');
        goSetup(form.username.trim());
      } else {
        setError(msg || 'Sign in failed. Check your credentials and try again.');
      }
      setBusy(false);
    }
  };

  // ── First-time password setup ───────────────────────────────────────────────
  const handleSetup = async (e) => {
    e.preventDefault();
    const username = setup.username.trim();
    const setupKey = setup.setupKey.trim();
    if (!username) { setError('Enter your username.'); return; }
    if (!setupKey) { setError('Enter the setup key you were given.'); return; }
    if (setup.newPassword.length < MIN_PW) { setError(`New password must be at least ${MIN_PW} characters.`); return; }
    if (setup.newPassword !== setup.confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError('');
    try {
      const session = await setupPassword({ username, setupKey, newPassword: setup.newPassword });
      onSuccess(session); // same landing path as a normal login
    } catch (err) {
      setError(prettySetupError(err?.message));
      setBusy(false);
    }
  };

  const score = pwScore(setup.newPassword);
  const strength = STRENGTH[score] || STRENGTH[0];
  const pwTooShort = setup.newPassword.length > 0 && setup.newPassword.length < MIN_PW;
  const confirmTouched = setup.confirm.length > 0;
  const matches = confirmTouched && setup.newPassword === setup.confirm;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-indigo-50/30 to-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl border border-slate-200/60">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-200 mb-4">
            {mode === 'setup' ? <KeyRound className="h-7 w-7 text-white" /> : <Building2 className="h-7 w-7 text-white" />}
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Platform Console</h1>
          <p className="mt-1 text-sm text-slate-500">{mode === 'setup' ? 'First-time password setup' : 'Staff access only'}</p>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="pf-username" className="block text-sm font-semibold text-slate-700 mb-1.5">Username</label>
              <input
                id="pf-username"
                name="username"
                autoComplete="username"
                className={FIELD_CLASS}
                placeholder="staff username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                disabled={busy}
              />
            </div>
            <div>
              <label htmlFor="pf-password" className="block text-sm font-semibold text-slate-700 mb-1.5">Password</label>
              <input
                id="pf-password"
                name="password"
                type="password"
                autoComplete="current-password"
                className={FIELD_CLASS}
                placeholder="••••••••"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                disabled={busy}
              />
            </div>
            {error && (
              <div role="alert" aria-live="assertive" className="text-red-600 text-sm bg-red-50 p-2.5 rounded-lg text-center border border-red-200">{error}</div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 bg-indigo-600 text-white p-3 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-indigo-300 transition-all shadow-sm shadow-indigo-200 hover:shadow-md hover:shadow-indigo-200"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}{busy ? 'Signing in…' : 'Sign In'}
            </button>
            <button
              type="button"
              onClick={() => goSetup(form.username.trim())}
              disabled={busy}
              className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 transition"
            >
              <KeyRound size={14} /> First-time setup — set your password
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetup} className="space-y-4">
            {info && (
              <div role="status" className="flex items-start gap-2 text-indigo-700 text-sm bg-indigo-50 p-2.5 rounded-lg border border-indigo-200">
                <ShieldCheck size={16} className="mt-0.5 shrink-0" /> <span>{info}</span>
              </div>
            )}
            <div>
              <label htmlFor="su-username" className="block text-sm font-semibold text-slate-700 mb-1.5">Username</label>
              <input
                id="su-username"
                name="username"
                autoComplete="username"
                className={FIELD_CLASS}
                placeholder="staff username"
                value={setup.username}
                onChange={(e) => setSetup({ ...setup, username: e.target.value })}
                disabled={busy}
              />
            </div>
            <div>
              <label htmlFor="su-key" className="block text-sm font-semibold text-slate-700 mb-1.5">Setup key</label>
              <input
                id="su-key"
                name="setupKey"
                autoComplete="off"
                className={`${FIELD_CLASS} font-mono`}
                placeholder="one-time setup key"
                value={setup.setupKey}
                onChange={(e) => setSetup({ ...setup, setupKey: e.target.value })}
                disabled={busy}
              />
              <p className="mt-1 text-xs text-slate-400">The one-time key issued when your account was created.</p>
            </div>
            <div>
              <label htmlFor="su-pass" className="block text-sm font-semibold text-slate-700 mb-1.5">New password</label>
              <input
                id="su-pass"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                className={FIELD_CLASS}
                placeholder={`At least ${MIN_PW} characters`}
                value={setup.newPassword}
                onChange={(e) => setSetup({ ...setup, newPassword: e.target.value })}
                disabled={busy}
              />
              {setup.newPassword && (
                <div className="mt-2">
                  <div className="flex gap-1" aria-hidden="true">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} className={`h-1.5 flex-1 rounded-full ${i < score && !pwTooShort ? strength.color : 'bg-slate-100'}`} />
                    ))}
                  </div>
                  <p className={`mt-1 text-xs font-medium ${pwTooShort ? 'text-rose-600' : strength.text}`}>
                    {pwTooShort ? `Too short — ${MIN_PW - setup.newPassword.length} more character${MIN_PW - setup.newPassword.length === 1 ? '' : 's'}` : `Strength: ${strength.label}`}
                  </p>
                </div>
              )}
            </div>
            <div>
              <label htmlFor="su-confirm" className="block text-sm font-semibold text-slate-700 mb-1.5">Confirm password</label>
              <input
                id="su-confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                className={FIELD_CLASS}
                placeholder="Re-enter the new password"
                value={setup.confirm}
                onChange={(e) => setSetup({ ...setup, confirm: e.target.value })}
                disabled={busy}
              />
              {confirmTouched && (
                <p className={`mt-1 text-xs font-medium ${matches ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {matches ? 'Passwords match.' : 'Passwords do not match yet.'}
                </p>
              )}
            </div>
            {error && (
              <div role="alert" aria-live="assertive" className="text-red-600 text-sm bg-red-50 p-2.5 rounded-lg text-center border border-red-200">{error}</div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 bg-indigo-600 text-white p-3 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-indigo-300 transition-all shadow-sm shadow-indigo-200 hover:shadow-md hover:shadow-indigo-200"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}{busy ? 'Setting up…' : 'Set password & sign in'}
            </button>
            <button
              type="button"
              onClick={goLogin}
              disabled={busy}
              className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50 transition"
            >
              <ArrowLeft size={14} /> Back to sign in
            </button>
          </form>
        )}

        <div className="mt-6 text-center text-[11px] text-slate-400">Restricted — platform operations staff</div>
      </div>
    </div>
  );
};

export default PlatformLogin;
