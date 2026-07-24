// Platform console — staff sign-in card. Mirrors the host app login card.
import React, { useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { platformLogin } from './api';

const PlatformLogin = ({ onSuccess }) => {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.username.trim() || !form.password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await platformLogin({ username: form.username.trim(), password: form.password });
      onSuccess(session);
    } catch (err) {
      setError(err?.message || 'Sign in failed. Check your credentials and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-indigo-50/30 to-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl border border-slate-200/60">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-200 mb-4">
            <Building2 className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Platform Console</h1>
          <p className="mt-1 text-sm text-slate-500">Staff access only</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="pf-username" className="block text-sm font-semibold text-slate-700 mb-1.5">Username</label>
            <input
              id="pf-username"
              name="username"
              autoComplete="username"
              className="w-full rounded-lg border border-slate-200 p-3 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
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
              className="w-full rounded-lg border border-slate-200 p-3 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
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
        </form>
        <div className="mt-6 text-center text-[11px] text-slate-400">Restricted — platform operations staff</div>
      </div>
    </div>
  );
};

export default PlatformLogin;
