import { doc, setDoc, addDoc, collection } from 'firebase/firestore';
import { getDistance } from './helpers';

// Continuous FOREGROUND location tracking while on duty. Uses the standard
// browser geolocation API, so it works in a mobile browser (real GPS), the
// installed PWA, and the native app's foreground alike. Writes are throttled
// (by time AND distance) to employee_locations/{empId} (latest, overwritten)
// plus an optional location_history trail. Background tracking (phone locked /
// app closed) is a separate native add-on — see MOBILE.md.

let watchId = null;
let lastWriteAt = 0;
let lastPos = null;

export const isTrackingSupported = () =>
  typeof navigator !== 'undefined' && 'geolocation' in navigator;

export const isTracking = () => watchId != null;

export const startTracking = ({ db, appId, emp, settings = {}, shift = {} }) => {
  if (!isTrackingSupported() || watchId != null || !db || !emp?.id) return false;
  const intervalMs = (Number(settings.interval_seconds) || 45) * 1000;
  const minDist = Number(settings.min_distance_m) || 50;
  const historyOn = settings.history_enabled !== false;
  lastWriteAt = 0; lastPos = null;

  const num = (v) => (v != null && !Number.isNaN(v) ? Math.round(v) : null);

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
      const now = Date.now();
      const movedFar = lastPos ? getDistance(lastPos.lat, lastPos.lng, lat, lng) >= minDist : true;
      const dueByTime = now - lastWriteAt >= intervalMs;
      if (!movedFar && !dueByTime) return; // throttle
      lastWriteAt = now; lastPos = { lat, lng };
      const at = new Date(now).toISOString();
      try {
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employee_locations', emp.id), {
          emp_id: emp.id, name: emp.name || '', lat, lng,
          accuracy: num(accuracy), heading: num(heading), speed: num(speed),
          on_duty: true, project_id: shift.project_id || '', project_name: shift.project_name || '', at,
        }, { merge: true });
        if (historyOn) {
          await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'location_history'),
            { emp_id: emp.id, lat, lng, at, project_id: shift.project_id || '' });
        }
      } catch { /* offline / transient — the next fix retries */ }
    },
    () => { /* permission denied or position error — silent */ },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  );
  return true;
};

export const stopTracking = async ({ db, appId, empId } = {}) => {
  if (watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null; lastPos = null; lastWriteAt = 0;
  if (db && appId && empId) {
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employee_locations', empId),
        { on_duty: false, ended_at: new Date().toISOString() }, { merge: true });
    } catch { /* ignore */ }
  }
};
