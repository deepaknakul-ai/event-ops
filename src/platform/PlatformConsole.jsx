// Platform staff console — self-contained, lazy-loadable route root.
//
// The lead wires this in via React.lazy, e.g.:
//   const PlatformConsole = lazy(() => import('./platform/PlatformConsole'));
//   ... <Route path="/platform/*" element={<PlatformConsole />} />
// It owns its own auth (staff login), so it should be rendered BEFORE the host
// app's tenant-login gate (like the other public routes in App.jsx).
import React, { useEffect, useState } from 'react';
import { LoadingSpinner } from '../components/Shared';
import { loadSession, onPlatformAuth } from './api';
import PlatformLogin from './PlatformLogin';
import PlatformShell from './PlatformShell';

const PlatformConsole = () => {
  // `session` = staff identity (name/role/staffId) cached per tab.
  const [session, setSession] = useState(() => loadSession());
  // `booting` stays true until Firebase settles the persisted auth state.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    // A valid console session needs a live Firebase user that is a STAFF user
    // (carries the `staff` claim) — not merely any signed-in user. The tenant
    // app shares this Firebase auth instance, so a tenant login can occupy the
    // session; in that case isStaff is false and we drop back to the login
    // screen instead of letting staff callables fail with 403.
    const unsub = onPlatformAuth((user, isStaff) => {
      setSession((prev) => (user && isStaff ? (prev || loadSession()) : null));
      setBooting(false);
    });
    return unsub;
  }, []);

  if (booting) return <LoadingSpinner />;

  if (!session) return <PlatformLogin onSuccess={setSession} />;

  return <PlatformShell session={session} onSignedOut={() => setSession(null)} />;
};

export default PlatformConsole;
