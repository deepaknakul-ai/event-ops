import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, X } from 'lucide-react';
import { notify } from '../utils/toast';

const DEFAULT_CENTER = [20.5937, 78.9629]; // India fallback

// Reusable site-location picker: tap the map (or drag the pin) to set a point,
// or capture the device's current GPS. Calls onChange({ lat, lng }) with rounded
// coords (or { lat: null, lng: null } when cleared).
const LocationPicker = ({ lat, lng, onChange }) => {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const [locating, setLocating] = useState(false);
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

  const clear = () => {
    if (markerRef.current && mapRef.current) { mapRef.current.removeLayer(markerRef.current); markerRef.current = null; }
    onChange({ lat: null, lng: null });
  };

  const has = typeof lat === 'number' && typeof lng === 'number';
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={useCurrent} disabled={locating} className="inline-flex items-center gap-1.5 rounded border border-indigo-300 bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
          <Crosshair size={13} /> {locating ? 'Locating…' : 'Use my current location'}
        </button>
        {has && <span className="text-xs text-slate-500">📍 {lat.toFixed(5)}, {lng.toFixed(5)}</span>}
        {has && <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700"><X size={12} /> Clear</button>}
      </div>
      <div ref={elRef} className="h-48 w-full overflow-hidden rounded-lg border border-slate-200" />
      <p className="mt-1 text-[11px] text-slate-400">Tap the map to drop or move the site pin, or use your current location while on site.</p>
    </div>
  );
};

export default LocationPicker;
