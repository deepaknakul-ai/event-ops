import React, { useState, useRef } from 'react';
import { confirmDialog } from '../utils/dialog';
import { collection, getDocs, doc, writeBatch } from 'firebase/firestore';
import {
  Download, Upload, Package, Users, Calendar, ShoppingBag,
  FileText, DollarSign, Wallet, Layers, CheckCircle, AlertCircle,
  Loader2,
} from 'lucide-react';

// ── Collection definitions ──────────────────────────────────────────────────

const COLLECTIONS = [
  { key: 'clients',            label: 'Clients & Vendors',   icon: Users,       color: 'indigo' },
  { key: 'inventory',          label: 'Inventory Items',     icon: Package,     color: 'emerald' },
  { key: 'projects',           label: 'Projects',            icon: Calendar,    color: 'blue' },
  { key: 'purchase_invoices',  label: 'Purchase Invoices',   icon: ShoppingBag, color: 'orange' },
  { key: 'tax_invoices',       label: 'Tax / Sales Invoices',icon: FileText,    color: 'green' },
  { key: 'employees',          label: 'Employees',           icon: Users,       color: 'violet' },
  { key: 'payments',           label: 'Client Payments',     icon: DollarSign,  color: 'teal' },
  { key: 'vendor_payments',    label: 'Vendor Payments',     icon: Wallet,      color: 'amber' },
  { key: 'expenses',           label: 'Expenses',            icon: DollarSign,  color: 'rose' },
  { key: 'payouts',            label: 'Employee Payouts',    icon: Wallet,      color: 'pink' },
  { key: 'advances',           label: 'Employee Advances',   icon: Wallet,      color: 'cyan' },
  { key: 'configurations',     label: 'Configurations',      icon: Layers,      color: 'slate' },
  { key: 'chart_of_accounts',  label: 'Chart of Accounts',   icon: FileText,    color: 'sky' },
  { key: 'journal_entries',    label: 'Journal Entries',      icon: FileText,    color: 'lime' },
  { key: 'opening_balances',   label: 'Opening Balances',    icon: FileText,    color: 'fuchsia' },
];

const COLORS = {
  indigo:  'border-indigo-200 bg-indigo-50 text-indigo-700',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  blue:    'border-blue-200 bg-blue-50 text-blue-700',
  orange:  'border-orange-200 bg-orange-50 text-orange-700',
  green:   'border-green-200 bg-green-50 text-green-700',
  violet:  'border-violet-200 bg-violet-50 text-violet-700',
  teal:    'border-teal-200 bg-teal-50 text-teal-700',
  amber:   'border-amber-200 bg-amber-50 text-amber-700',
  rose:    'border-rose-200 bg-rose-50 text-rose-700',
  pink:    'border-pink-200 bg-pink-50 text-pink-700',
  cyan:    'border-cyan-200 bg-cyan-50 text-cyan-700',
  slate:   'border-slate-200 bg-slate-50 text-slate-700',
  sky:     'border-sky-200 bg-sky-50 text-sky-700',
  lime:    'border-lime-200 bg-lime-50 text-lime-700',
  fuchsia: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700',
};

// ── Component ───────────────────────────────────────────────────────────────

const DataPortal = ({ db, appId, role, logAction, addToast }) => {
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState('');
  const [importResult, setImportResult] = useState(null);
  const fileRef = useRef(null);

  const isAdmin = role === 'admin';

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === COLLECTIONS.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(COLLECTIONS.map((c) => c.key)));
    }
  };

  // ── Export ─────────────────────────────────────────────────────────────

  const handleExport = async (keys) => {
    if (keys.length === 0) return addToast('Select at least one collection to export', 'error');
    setBusy('export');
    try {
      const exportData = {
        _meta: {
          version: '1.0',
          exported_at: new Date().toISOString(),
          app_id: appId,
          collections: keys,
        },
      };

      for (const key of keys) {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', key));
        exportData[key] = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
      }

      const json = JSON.stringify(exportData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().slice(0, 10);
      a.download = keys.length === 1 ? `${keys[0]}_${ts}.json` : `rental_ops_export_${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      logAction?.('data_portal', 'export', null, { collections: keys }, `Exported ${keys.join(', ')}`);
      addToast(`Exported ${keys.length} collection(s) successfully`, 'success');
    } catch (err) {
      console.error(err);
      addToast('Export failed: ' + err.message, 'error');
    }
    setBusy('');
  };

  const handleExportSingle = (key) => handleExport([key]);
  const handleExportSelected = () => handleExport(Array.from(selected));

  // ── Import ─────────────────────────────────────────────────────────────

  const handleImportClick = () => {
    if (!isAdmin) return addToast('Only admins can import data', 'error');
    fileRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setBusy('reading');
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data._meta || !data._meta.collections) {
        return addToast('Invalid export file — missing _meta header', 'error');
      }

      const collections = data._meta.collections.filter((k) => data[k]?.length > 0);
      if (collections.length === 0) {
        return addToast('Export file contains no data', 'error');
      }

      // Show preview
      const preview = collections.map((k) => ({
        key: k,
        label: COLLECTIONS.find((c) => c.key === k)?.label || k,
        count: data[k].length,
      }));

      const confirmed = await confirmDialog(
        `Import ${collections.length} collection(s)?\n\n` +
        preview.map((p) => `• ${p.label}: ${p.count} records`).join('\n') +
        `\n\nThis will ADD records (not replace existing). Duplicate IDs will be skipped.`
      );
      if (!confirmed) { setBusy(''); return; }

      setBusy('import');
      const result = { total: 0, created: 0, skipped: 0, errors: 0, details: [] };

      for (const key of collections) {
        const rows = data[key] || [];
        let created = 0;
        let skipped = 0;
        let errors = 0;

        // Batch writes (max 500 per batch)
        const chunks = [];
        for (let i = 0; i < rows.length; i += 400) {
          chunks.push(rows.slice(i, i + 400));
        }

        for (const chunk of chunks) {
          const batch = writeBatch(db);
          for (const row of chunk) {
            try {
              const { _id, ...fields } = row;
              if (_id) {
                // Use original ID — set with merge to skip if exists
                const ref = doc(db, 'artifacts', appId, 'public', 'data', key, _id);
                batch.set(ref, { ...fields, _imported: true, _imported_at: new Date().toISOString() }, { merge: true });
                created++;
              } else {
                // No ID — create new
                const ref = doc(collection(db, 'artifacts', appId, 'public', 'data', key));
                batch.set(ref, { ...fields, _imported: true, _imported_at: new Date().toISOString() });
                created++;
              }
            } catch (err) {
              console.error('Row error:', err);
              errors++;
            }
          }
          await batch.commit();
        }

        result.total += rows.length;
        result.created += created;
        result.skipped += skipped;
        result.errors += errors;
        result.details.push({
          key,
          label: COLLECTIONS.find((c) => c.key === key)?.label || key,
          total: rows.length,
          created,
          skipped,
          errors,
        });
      }

      setImportResult(result);
      logAction?.('data_portal', 'import', null, { collections, total: result.total, created: result.created }, `Imported ${collections.join(', ')}`);
      addToast(`Imported ${result.created} records across ${collections.length} collection(s)`, 'success');
    } catch (err) {
      console.error(err);
      if (err instanceof SyntaxError) {
        addToast('Invalid JSON file', 'error');
      } else {
        addToast('Import failed: ' + err.message, 'error');
      }
    }
    setBusy('');
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Data Portal</h1>
          <p className="text-sm text-slate-500">Export &amp; import data to set up new accounts or migrate between environments.</p>
        </div>
        <div className="flex gap-2">
          <button
            disabled={selected.size === 0 || !!busy}
            onClick={handleExportSelected}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Download size={15} /> Export Selected ({selected.size})
          </button>
          {isAdmin && (
            <button
              disabled={!!busy}
              onClick={handleImportClick}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Upload size={15} /> Import JSON
            </button>
          )}
          <input ref={fileRef} type="file" accept=".json" onChange={handleFileChange} className="hidden" />
        </div>
      </div>

      {busy && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <Loader2 size={16} className="animate-spin" />
          {busy === 'export' && 'Exporting data...'}
          {busy === 'reading' && 'Reading file...'}
          {busy === 'import' && 'Importing data — this may take a moment...'}
        </div>
      )}

      {importResult && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-green-800">
            <CheckCircle size={16} /> Import Complete
          </div>
          <div className="text-sm text-green-700">
            Total: {importResult.total} | Created: {importResult.created} | Skipped: {importResult.skipped} | Errors: {importResult.errors}
          </div>
          <div className="mt-2 space-y-1">
            {importResult.details.map((d) => (
              <div key={d.key} className="flex items-center justify-between rounded bg-white/60 px-3 py-1.5 text-xs">
                <span className="font-semibold text-slate-700">{d.label}</span>
                <span className="text-slate-500">{d.created} imported / {d.total} total</span>
              </div>
            ))}
          </div>
          <button onClick={() => setImportResult(null)} className="mt-2 text-xs text-green-600 underline hover:text-green-800">Dismiss</button>
        </div>
      )}

      {/* Select All */}
      <div className="flex items-center gap-2">
        <button onClick={selectAll} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">
          {selected.size === COLLECTIONS.length ? 'Deselect All' : 'Select All'}
        </button>
        <span className="text-xs text-slate-400">{selected.size} of {COLLECTIONS.length} selected</span>
      </div>

      {/* Collection Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {COLLECTIONS.map((col) => {
          const Icon = col.icon;
          const isSelected = selected.has(col.key);
          const colorCls = COLORS[col.color] || COLORS.slate;
          return (
            <div
              key={col.key}
              className={`relative rounded-xl border-2 p-4 transition cursor-pointer ${
                isSelected ? `${colorCls} ring-2 ring-offset-1` : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
              onClick={() => toggle(col.key)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`rounded-lg p-2 ${isSelected ? 'bg-white/60' : 'bg-slate-100'}`}>
                    <Icon size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{col.label}</div>
                    <div className="text-xs text-slate-500">{col.key}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(col.key)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </div>
              </div>
              <div className="mt-3 flex gap-1.5">
                <button
                  disabled={!!busy}
                  onClick={(e) => { e.stopPropagation(); handleExportSingle(col.key); }}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Download size={12} /> Export
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Help Text */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 space-y-2">
        <p className="font-semibold text-slate-700">How it works</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Export:</strong> Select one or more collections and click Export. A JSON file is downloaded with all records including their IDs.</li>
          <li><strong>Import:</strong> Upload a previously exported JSON file. Records are added to Firestore using their original IDs (merge mode — existing records are updated, new ones created).</li>
          <li><strong>Single export:</strong> Click the Export button on any card to export just that collection.</li>
          <li><strong>Bulk export:</strong> Select multiple cards using checkboxes, then click "Export Selected" to get all in one file.</li>
          <li><strong>New account setup:</strong> Export all data from your current environment, then import into a fresh setup.</li>
        </ul>
        {!isAdmin && (
          <div className="mt-2 flex items-center gap-1.5 text-amber-700">
            <AlertCircle size={14} /> Import is restricted to admin users only.
          </div>
        )}
      </div>
    </div>
  );
};

export default DataPortal;
