import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { collection, onSnapshot, query, where, getDocs } from 'firebase/firestore';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation, Route as RouteIcon } from 'lucide-react';
import { can } from '../utils/permissions';
import { initials } from '../utils/chat';

const FRESH_MS = 5 * 60 * 1000; // "on duty & live" if a fix arrived within 5 min

const minsAgo = (iso) => {
  if (!iso) return 'never';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const isLive = (loc) => !!(loc.on_duty && loc.at && (Date.now() - new Date(loc.at).getTime()) < FRESH_MS);

const LiveMap = ({ role = 'user', db, appId, employees = [], hqSettings = {} }) => {
  const [params] = useSearchParams();
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState(() => params.get('emp') || null);
  const [trailOn, setTrailOn] = useState(false);
  const [tick, setTick] = useState(0);
  const mapRef = useRef(null);
  const mapEl = useRef(null);
  const markersRef = useRef({});
  const trailRef = useRef(null);
  const focusedRef = useRef(false);

  const empById = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);

  // Live positions
  useEffect(() => {
    if (!db) return undefined;
    const unsub = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'employee_locations'), (snap) => {
      setLocations(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => typeof l.lat === 'number' && typeof l.lng === 'number'));
    }, () => {});
    return () => unsub();
  }, [db, appId]);

  // Refresh staleness colours / "min ago" every 30s.
  useEffect(() => { const i = setInterval(() => setTick((t) => t + 1), 30000); return () => clearInterval(i); }, []);

  // Init map once.
  useEffect(() => {
    if (mapRef.current || !mapEl.current) return undefined;
    const center = (hqSettings.lat && hqSettings.lng) ? [hqSettings.lat, hqSettings.lng] : [20.5937, 78.9629];
    const map = L.map(mapEl.current).setView(center, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    if (hqSettings.lat && hqSettings.lng) {
      L.circle([hqSettings.lat, hqSettings.lng], { radius: hqSettings.geoRadiusMeters || 400, color: '#6366f1', weight: 1, fillColor: '#6366f1', fillOpacity: 0.06 }).addTo(map).bindPopup('HQ');
    }
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markersRef.current = {}; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync markers with live positions.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set();
    locations.forEach((loc) => {
      seen.add(loc.id);
      const emp = empById[loc.id] || {};
      const color = isLive(loc) ? '#059669' : '#94a3b8';
      const html = `<div style="width:32px;height:32px;border-radius:9999px;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">${initials(emp.name || loc.name || '?')}</div>`;
      const icon = L.divIcon({ html, className: '', iconSize: [32, 32], iconAnchor: [16, 16] });
      const popup = `<b>${emp.name || loc.name || 'Employee'}</b><br>${isLive(loc) ? 'On duty' : 'Off / stale'}${loc.project_name ? `<br>${loc.project_name}` : ''}<br>~${loc.accuracy ?? '?'}m · ${minsAgo(loc.at)}`;
      let m = markersRef.current[loc.id];
      if (!m) { m = L.marker([loc.lat, loc.lng], { icon }).addTo(map); markersRef.current[loc.id] = m; }
      else { m.setLatLng([loc.lat, loc.lng]); m.setIcon(icon); }
      m.bindPopup(popup);
    });
    Object.keys(markersRef.current).forEach((id) => {
      if (!seen.has(id)) { map.removeLayer(markersRef.current[id]); delete markersRef.current[id]; }
    });
  }, [locations, empById, tick]);

  // Deep-link: /tracking?emp=<id> focuses that employee once their position loads.
  useEffect(() => {
    if (focusedRef.current || !selected || !mapRef.current) return;
    const loc = locations.find((l) => l.id === selected);
    if (loc) {
      focusedRef.current = true;
      mapRef.current.setView([loc.lat, loc.lng], 15);
      markersRef.current[selected]?.openPopup();
    }
  }, [locations, selected]);

  // Draw / clear today's trail for the selected employee.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (trailRef.current) { map.removeLayer(trailRef.current); trailRef.current = null; }
    if (!trailOn || !selected || !db) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // Single-field query (no composite index); filter to today client-side.
        const snap = await getDocs(query(collection(db, 'artifacts', appId, 'public', 'data', 'location_history'), where('emp_id', '==', selected)));
        if (cancelled) return;
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const pts = snap.docs.map((d) => d.data())
          .filter((p) => typeof p.lat === 'number' && p.at && new Date(p.at) >= dayStart)
          .sort((a, b) => new Date(a.at) - new Date(b.at))
          .map((p) => [p.lat, p.lng]);
        if (pts.length > 1 && !cancelled) {
          trailRef.current = L.polyline(pts, { color: '#6366f1', weight: 3, opacity: 0.75 }).addTo(map);
          map.fitBounds(trailRef.current.getBounds(), { padding: [40, 40] });
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [trailOn, selected, db, appId]);

  const focus = (loc) => {
    setSelected(loc.id);
    const map = mapRef.current;
    if (map && typeof loc.lat === 'number') { map.setView([loc.lat, loc.lng], 15); markersRef.current[loc.id]?.openPopup(); }
  };

  if (!can(role, 'tracking', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to live tracking.</div>;

  const sorted = [...locations].sort((a, b) => (isLive(b) ? 1 : 0) - (isLive(a) ? 1 : 0) || new Date(b.at || 0) - new Date(a.at || 0));
  const liveCount = locations.filter(isLive).length;

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full shrink-0 flex-col border-b border-slate-100 md:w-72 md:border-b-0 md:border-r">
        <div className="border-b border-slate-100 p-3">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800"><MapPin size={18} className="text-indigo-600" /> Live Map</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">{liveCount} on duty · {locations.length} tracked</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sorted.length === 0 && <div className="px-2 py-6 text-center text-xs text-slate-400">No locations yet. Employees appear here when they check in (with tracking enabled).</div>}
          {sorted.map((loc) => {
            const emp = empById[loc.id] || {};
            const live = isLive(loc);
            return (
              <button key={loc.id} onClick={() => focus(loc)} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${selected === loc.id ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                <span className="relative">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white ${live ? 'bg-emerald-600' : 'bg-slate-400'}`}>{initials(emp.name || loc.name || '?')}</span>
                  {live && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-700">{emp.name || loc.name || 'Employee'}</span>
                  <span className="block truncate text-[11px] text-slate-400">{live ? (loc.project_name || 'On duty') : 'Off / stale'} · {minsAgo(loc.at)}</span>
                </span>
              </button>
            );
          })}
        </div>
        {selected && (
          <div className="border-t border-slate-100 p-2">
            <button onClick={() => setTrailOn((v) => !v)} className={`flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${trailOn ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              <RouteIcon size={14} /> {trailOn ? "Hide today's trail" : "Show today's trail"}
            </button>
          </div>
        )}
      </aside>

      {/* Map */}
      <div className="relative min-h-[300px] flex-1">
        <div ref={mapEl} className="absolute inset-0" />
        {locations.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2 text-xs text-slate-400 shadow"><Navigation size={14} /> Waiting for the first location…</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveMap;
