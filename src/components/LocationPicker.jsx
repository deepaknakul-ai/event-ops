import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, X, Search, MapPin } from 'lucide-react';
import { notify } from '../utils/toast';

const DEFAULT_CENTER = [20.5937, 78.9629]; // India fallback

// Reusable site-location picker. Set a point by: searching a place/address
// (OpenStreetMap/Nominatim — free, no key), typing GPS coordinates, tapping/
// dragging the map pin, or capturing the device GPS. Calls onChange({lat,lng})
// with rounded coords (or { lat:null, lng:null } when cleared).
const LocationPicker = ({ lat, lng, onChange }) => {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const place = (la, ln, recenter) => {
    const map = mapRef.current;
    if (!map) return;
    if (!markerRef.current) {
      markerRef.current = L.marker([la, ln], { draggable: true }).addTo(map)
        .on('dragend', (e) => { const p = e.target.getLatLng(); onChangeRef.current({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) }); });
    } else {
      markerRef.current.setLatLng([la, ln]);
    }
    if (recenter) map.setView([la, ln], 15);
  };

  useEffect(() => {
    if (mapRef.current || !elRef.current) return undefined;
    const has = typeof lat === 'number' && typeof lng === 'number';
    const map = L.map(elRef.current).setView(has ? [lat, lng] : DEFAULT_CENTER, has ? 15 : 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    map.on('click', (e) => { const la = +e.latlng.lat.toFixed(6); const ln = +e.latlng.lng.toFixed(6); place(la, ln, false); onChangeRef.current({ lat: la, lng: ln }); });
    mapRef.current = map;
    if (has) place(lat, lng, false);
    setTimeout(() => map.invalidateSize(), 0);
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const useCurrent = () => {
    if (!navigator.geolocation) { notify('Geolocation is not supported on this device.', 'error'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); const la = +pos.coords.latitude.toFixed(6); const ln = +pos.coords.longitude.toFixed(6); place(la, ln, true); onChange({ lat: la, lng: ln }); },
      () => { setLocating(false); notify('Could not get your location (check permission).', 'error'); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true); setResults([]);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const json = await res.json();
      const rows = (Array.isArray(json) ? json : []).map((r) => ({ name: r.display_name, lat: parseFloat(r.lat), lng: parseFloat(r.lon) })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
      if (rows.length === 0) notify('No matches found for that place.', 'info');
      setResults(rows);
    } catch { notify('Location search failed — check your connection.', 'error'); }
    setSearching(false);
  };

  const pickResult = (r) => {
    place(r.lat, r.lng, true);
    onChange({ lat: +r.lat.toFixed(6), lng: +r.lng.toFixed(6) });
    setResults([]); setQuery('');
  };

  const applyManual = () => {
    const la = parseFloat(manualLat); const ln = parseFloat(manualLng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) {
      notify('Enter valid coordinates — latitude −90…90, longitude −180…180.', 'error'); return;
    }
    place(+la.toFixed(6), +ln.toFixed(6), true);
    onChange({ lat: +la.toFixed(6), lng: +ln.toFixed(6) });
  };

  const clear = () => {
    if (markerRef.current && mapRef.current) { mapRef.current.removeLayer(markerRef.current); markerRef.current = null; }
    onChange({ lat: null, lng: null });
    setResults([]);
  };

  const has = typeof lat === 'number' && typeof lng === 'number';
  return (
    <div>
      {/* Search a place / address */}
      <div className="mb-2 flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
            placeholder="Search a place or address…"
            className="w-full rounded border border-slate-300 py-1.5 pl-8 pr-2 text-sm text-black"
          />
        </div>
        <button type="button" onClick={runSearch} disabled={searching} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{searching ? '…' : 'Search'}</button>
      </div>
      {results.length > 0 && (
        <div className="mb-2 max-h-40 overflow-y-auto rounded border border-slate-200 bg-white">
          {results.map((r, i) => (
            <button type="button" key={i} onClick={() => pickResult(r)} className="flex w-full items-start gap-1.5 px-2.5 py-1.5 text-left text-xs text-slate-600 hover:bg-indigo-50">
              <MapPin size={12} className="mt-0.5 shrink-0 text-indigo-500" /> <span className="truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Current location + manual coordinates */}
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <button type="button" onClick={useCurrent} disabled={locating} className="inline-flex items-center gap-1.5 rounded border border-indigo-300 bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
          <Crosshair size={13} /> {locating ? 'Locating…' : 'Current location'}
        </button>
        <div>
          <label className="block text-[10px] font-semibold uppercase text-slate-400">Latitude</label>
          <input type="number" step="any" value={manualLat} onChange={(e) => setManualLat(e.target.value)} placeholder={has ? String(lat) : 'e.g. 28.6139'} className="w-24 rounded border border-slate-300 px-2 py-1 text-sm text-black" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase text-slate-400">Longitude</label>
          <input type="number" step="any" value={manualLng} onChange={(e) => setManualLng(e.target.value)} placeholder={has ? String(lng) : 'e.g. 77.2090'} className="w-24 rounded border border-slate-300 px-2 py-1 text-sm text-black" />
        </div>
        <button type="button" onClick={applyManual} className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Set</button>
        {has && <span className="text-xs text-slate-500">📍 {lat.toFixed(5)}, {lng.toFixed(5)}</span>}
        {has && <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700"><X size={12} /> Clear</button>}
      </div>

      <div ref={elRef} className="h-48 w-full overflow-hidden rounded-lg border border-slate-200" />
      <p className="mt-1 text-[11px] text-slate-400">Search a place, type GPS coordinates, tap the map, or use your current location.</p>
    </div>
  );
};

export default LocationPicker;
