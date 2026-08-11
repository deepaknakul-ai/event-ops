import React, { useEffect, useState, useRef } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { MapPin } from 'lucide-react';
import { startTracking, stopTracking, isTrackingSupported } from '../utils/tracking';

// Headless controller mounted once in the authed shell. Starts/stops foreground
// location tracking based on the current user's active shift (on duty) and the
// admin tracking setting, and shows a persistent "Sharing location" pill so the
// employee always knows when tracking is on (consent transparency).
const LocationTracker = ({ db, appId, currentEmpId, employees = [], timeLogs = [] }) => {
  const [settings, setSettings] = useState({ enabled: false });
  const startedRef = useRef(false);

  useEffect(() => {
    if (!db) return undefined;
    const unsub = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'tracking'), (snap) => {
      setSettings(snap.exists() ? snap.data() : { enabled: false });
    }, () => {});
    return () => unsub();
  }, [db, appId]);

  const activeShift = timeLogs.find((l) => l.employeeId === currentEmpId && l.checkIn && !l.checkOut);
  const shouldTrack = !!(db && currentEmpId && settings.enabled && activeShift && isTrackingSupported());

  useEffect(() => {
    if (shouldTrack && !startedRef.current) {
      const emp = employees.find((e) => e.id === currentEmpId);
      startedRef.current = startTracking({
        db, appId,
        emp: { id: currentEmpId, name: emp?.name || '' },
        settings,
        shift: { project_id: activeShift?.project_id, project_name: activeShift?.project_name },
      });
    } else if (!shouldTrack && startedRef.current) {
      stopTracking({ db, appId, empId: currentEmpId });
      startedRef.current = false;
    }
  }, [shouldTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release the watch + flip on_duty:false if the app unmounts mid-shift.
  useEffect(() => () => {
    if (startedRef.current) { stopTracking({ db, appId, empId: currentEmpId }); startedRef.current = false; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shouldTrack) return null;
  return (
    <div className="fixed bottom-3 left-3 z-[150] mb-[env(safe-area-inset-bottom)] flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg">
      <MapPin size={13} /> Sharing location — on duty
    </div>
  );
};

export default LocationTracker;
