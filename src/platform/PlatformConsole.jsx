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
    // A valid console session needs BOTH a cached identity and a live Firebase
    // auth user (the custom-token sign-in). If Firebase reports no user, any
    // stale identity is void — drop back to the login screen.
    const unsub = onPlatformAuth((user) => {
      setSession((prev) => (user ? prev : null));
      setBooting(false);
    });
    return unsub;
  }, []);

  if (booting) return <LoadingSpinner />;

  if (!session) return <PlatformLogin onSuccess={setSession} />;

  return <PlatformShell session={session} onSignedOut={() => setSession(null)} />;
};

export default PlatformConsole;
