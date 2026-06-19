import React, { useState, useRef, useMemo } from 'react';
import { collection, addDoc } from 'firebase/firestore';
import { Camera, CameraOff, PackageCheck, PackageX, Trash2, Check, Search, Plus } from 'lucide-react';
import QrScanner from '../components/QrScanner';
import { notify } from '../utils/toast';
import { can } from '../utils/permissions';

// Warehouse scan: pick a project + direction, scan asset QR labels (or add
// manually), then record append-only inventory_movements. Standalone from the
// challan modal so it can't destabilise that flow.
const WarehouseScan = ({ projects = [], inventory = [], clients = [], role = 'tech', db, appId, currentEmpId, addToast, logAction }) => {
  const toast = addToast || notify;
  const [projectId, setProjectId] = useState('');
  const [direction, setDirection] = useState('out'); // out = dispatch, in = return
  const [scanning, setScanning] = useState(false);
  const [lines, setLines] = useState([]); // { code, item_id, item_name, serial, qty }
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const lastScanRef = useRef({ code: '', at: 0 });

  const canEdit = can(role, 'inventory', 'edit') || can(role, 'projects', 'allocation');
  const activeProjects = useMemo(
    () => projects.filter((p) => !['Cancelled', 'Closed'].includes(p.status)).sort((a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0)),
    [projects],
  );
  const project = projects.find((p) => p.id === projectId);

  const resolveItem = (code) => {
    const [id, serial] = String(code).split('|');
    let item = inventory.find((i) => i.id === id);
    if (!item) item = inventory.find((i) => i.serial_number === code || i.asset_id === code || (Array.isArray(i.serial_numbers) && i.serial_numbers.includes(code)));
    return item ? { item, serial: serial || '' } : null;
  };

  const addLine = (code) => {
    const resolved = resolveItem(code);
    if (!resolved) { toast(`Unknown code: ${code}`, 'error'); return; }
    const { item, serial } = resolved;
    setLines((prev) => {
      const key = serial ? `${item.id}|${serial}` : item.id;
      const existing = prev.find((l) => l.code === key);
      if (existing) {
        if (serial) { toast(`${item.name} (${serial}) already scanned`, 'info'); return prev; }
        return prev.map((l) => (l.code === key ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { code: key, item_id: item.id, item_name: item.name, serial, qty: 1 }];
    });
  };

  const handleScan = (code) => {
    const now = Date.now();
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 2500) return; // debounce
    lastScanRef.current = { code, at: now };
    addLine(code);
  };

  const setQty = (code, qty) => setLines((prev) => prev.map((l) => (l.code === code ? { ...l, qty: Math.max(1, parseInt(qty) || 1) } : l)));
  const removeLine = (code) => setLines((prev) => prev.filter((l) => l.code !== code));

  const handleRecord = async () => {
    if (!projectId) { toast('Select a project first.', 'error'); return; }
    if (!lines.length) { toast('Scan or add at least one item.', 'error'); return; }
    setSaving(true);
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    try {
      await Promise.all(lines.map((l) => addDoc(
        collection(db, 'artifacts', appId, 'public', 'data', 'inventory_movements'),
        {
          item_id: l.item_id, item_name: l.item_name, qty: l.qty,
          direction, source: 'scan', scanned_serial: l.serial || null,
          project_id: projectId, project_name: project?.project_name || '',
          client_id: project?.client_id || null,
          date, recorded_at: ts, recorded_by: currentEmpId || null,
        },
      )));
      if (logAction) logAction('inventory_movements', direction === 'out' ? 'scan_dispatch' : 'scan_return', projectId, { count: lines.length }, project?.project_name || '');
      toast(`Recorded ${lines.length} ${direction === 'out' ? 'dispatch' : 'return'} movement(s).`, 'success');
      setLines([]);
    } catch (e) {
      toast('Failed to record: ' + (e?.message || 'error'), 'error');
    } finally { setSaving(false); }
  };

  const searchResults = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return inventory.filter((i) => !i.is_composite && ((i.name || '').toLowerCase().includes(s) || (i.asset_id || '').toLowerCase().includes(s) || (i.serial_number || '').toLowerCase().includes(s))).slice(0, 8);
  }, [search, inventory]);

  if (!canEdit) {
    return <div className="p-6 text-sm text-slate-500">You don't have permission to record stock movements.</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold text-slate-800">Warehouse Scan</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Dispatch / Return</span>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">Project</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full rounded-lg border border-slate-300 p-2 text-sm">
            <option value="">— Select project —</option>
            {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setDirection('out')} className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${direction === 'out' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-500'}`}><PackageX size={15} /> Dispatch (out)</button>
          <button onClick={() => setDirection('in')} className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${direction === 'in' ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500'}`}><PackageCheck size={15} /> Return (in)</button>
        </div>
        <button onClick={() => setScanning((s) => !s)} className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white ${scanning ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
          {scanning ? <><CameraOff size={16} /> Stop camera</> : <><Camera size={16} /> Start scanning</>}
        </button>
        {scanning && <QrScanner onScan={handleScan} onError={() => toast('Camera unavailable — use manual add below, or check permissions.', 'error')} />}
      </div>

      {/* Manual add */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="mb-1 block text-xs font-semibold text-slate-500">Add manually (no scanner)</label>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item / asset id / serial" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm" />
        </div>
        {searchResults.length > 0 && (
          <div className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-100">
            {searchResults.map((i) => (
              <button key={i.id} onClick={() => { addLine(i.id); setSearch(''); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50">
                <span className="text-slate-700">{i.name} {i.asset_id ? <span className="text-xs text-slate-400">· {i.asset_id}</span> : null}</span>
                <Plus size={14} className="text-indigo-500" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scanned lines */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">Scanned items ({lines.length})</h3>
          {lines.length > 0 && <button onClick={() => setLines([])} className="text-xs text-slate-400 hover:text-red-500">Clear all</button>}
        </div>
        {lines.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">Scan a label or add an item to begin.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {lines.map((l) => (
              <div key={l.code} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-700">{l.item_name}</div>
                  {l.serial && <div className="text-xs text-slate-400">SN: {l.serial}</div>}
                </div>
                {l.serial ? (
                  <span className="text-sm text-slate-500">1</span>
                ) : (
                  <input type="number" min="1" value={l.qty} onChange={(e) => setQty(l.code, e.target.value)} className="w-16 rounded border border-slate-300 p-1.5 text-center text-sm" />
                )}
                <button onClick={() => removeLine(l.code)} className="text-slate-300 hover:text-red-500"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        )}
        {lines.length > 0 && (
          <div className="border-t border-slate-100 p-3">
            <button onClick={handleRecord} disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              <Check size={16} /> {saving ? 'Recording…' : `Record ${direction === 'out' ? 'Dispatch' : 'Return'} (${lines.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default WarehouseScan;
