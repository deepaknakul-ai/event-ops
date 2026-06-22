import { useState, useEffect } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';

const FRESH_MS = 5 * 60 * 1000; // "live" if a fix arrived within 5 minutes

export const isLocationLive = (loc) =>
  !!(loc && loc.on_duty && loc.at && (Date.now() - new Date(loc.at).getTime() < FRESH_MS));

export const locationAge = (iso) => {
  if (!iso) return 'no fix';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// Live map of employee_locations keyed by employee id. Subscribes only when
// `enabled` (reads are management-only per firestore.rules — pass a tracking
// permission check so non-management never attempts a denied read).
export const useEmployeeLocations = (db, appId, enabled) => {
  const [locations, setLocations] = useState({});
  useEffect(() => {
    if (!db || !enabled) return undefined;
    const unsub = onSnapshot(
      collection(db, 'artifacts', appId, 'public', 'data', 'employee_locations'),
      (snap) => { const m = {}; snap.forEach((d) => { m[d.id] = d.data(); }); setLocations(m); },
      () => {},
    );
    return () => unsub();
  }, [db, appId, enabled]);
  return locations;
};
