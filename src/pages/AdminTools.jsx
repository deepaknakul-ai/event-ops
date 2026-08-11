import React, { useState, useEffect } from 'react';
import { confirmDialog } from '../utils/dialog';
import { notify } from '../utils/toast';
import { Download, Upload, Briefcase, Calendar, Shield, ImageIcon as Image, CreditCard, Plus, Trash2, Edit, CheckCircle, Lock, Users, LockKeyhole, Unlock, Tag, X, Mail, FileCheck, Bell, MapPin, Sparkles, Database } from 'lucide-react';
import { doc, getDoc, setDoc, writeBatch, deleteField } from 'firebase/firestore';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { ref, getBlob, uploadBytes } from 'firebase/storage';
import JSZip from 'jszip';
import { storage, app } from '../firebase';
import { ConfirmDeleteModal } from '../components/Shared';
import { can } from '../utils/permissions';
import { featureOn } from '../utils/entitlements';
import { getFinancialYear } from '../utils/helpers';
import { CATEGORIES, EXPENSE_CATS } from '../utils/constants';
import RBACManager from './RBACManager';

const DEFAULT_CALENDAR_STATUS_BG = {
  Quoted: '#e0e7ff',
  Confirmed: '#dbeafe',
  Ongoing: '#fef9c3',
  Completed: '#dcfce7',
  Closed: '#f3f4f6',
  Cancelled: '#fee2e2'
};

const DEFAULT_CALENDAR_INVOICE_TEXT = {
  Invoiced: '',
  'Not Invoiced': ''
};

const CALENDAR_STATUS_OPTIONS = ['Quoted', 'Confirmed', 'Ongoing', 'Completed', 'Closed', 'Cancelled'];
const CALENDAR_INVOICE_OPTIONS = ['Invoiced', 'Not Invoiced'];

// One-time zero-trust field-split migrations, relocated here from the Projects /
// Inventory / Employees pages. Backfill mirrors money into the gated *_financials
// sibling (safe + idempotent); Scrub then removes it from the base docs (leak
// closure). New records migrate automatically via triggers — these are only for
// re-running after a bulk import of old data.
const MIGRATIONS = [
  { key: 'proj', label: 'Projects', noun: 'money',
    backfill: { fn: 'backfillProjectFinancials', msg: "BACKFILL: mirror every project's money into the gated project_financials sibling (safe + idempotent). Proceed?", fmt: (d) => `Mirrored ${d.mirrored ?? 0} of ${d.projects ?? 0} project(s).` },
    scrub: { fn: 'scrubProjectEmbeddedMoney', msg: 'SCRUB project money from the base docs (closes the SDK leak). Only affects projects already mirrored to project_financials. Run AFTER Backfill + confirming money still displays. Proceed?', fmt: (d) => `Scrubbed ${d.scrubbed ?? 0} project(s); ${d.skipped ?? 0} skipped (no sibling yet).` } },
  { key: 'inv', label: 'Inventory', noun: 'rates',
    backfill: { fn: 'backfillInventoryFinancials', msg: 'BACKFILL: copy existing inventory rates/costs into the gated inventory_financials sibling. Safe and idempotent. Proceed?', fmt: (d) => `Mirrored ${d.mirrored ?? 0} of ${d.items ?? 0} item(s).` },
    scrub: { fn: 'scrubInventoryEmbeddedMoney', msg: 'SCRUB inventory rates/costs from the base docs. Only affects items already mirrored to inventory_financials. Run AFTER Backfill + confirming rates still display. Proceed?', fmt: (d) => `Scrubbed ${d.scrubbed ?? 0} item(s); ${d.skipped ?? 0} skipped (no sibling yet).` } },
  { key: 'emp', label: 'Employees', noun: 'pay',
    backfill: { fn: 'backfillEmployeePay', msg: 'BACKFILL: copy existing employee pay (rate/salary) into the gated employee_pay sibling. Safe and idempotent. Proceed?', fmt: (d) => `Mirrored ${d.mirrored ?? 0} of ${d.employees ?? 0} employee(s).` },
    scrub: { fn: 'scrubEmployeeEmbeddedPay', msg: 'SCRUB pay from the base employee docs. Only affects employees already mirrored to employee_pay. Run AFTER Backfill + confirming pay still displays for Owner/Accountant. Proceed?', fmt: (d) => `Scrubbed ${d.scrubbed ?? 0} employee(s); ${d.skipped ?? 0} skipped (no sibling yet).` } },
];

// Storage-SDK error codes that mean "the request never reached Google" rather
// than "this object is a problem". An ad/tracking blocker cancelling the XHR
// (net::ERR_BLOCKED_BY_CLIENT) surfaces as retry-limit-exceeded after the SDK
// exhausts its retry window; unknown covers the raw network failure.
const STORAGE_NETWORK_CODES = new Set(['storage/retry-limit-exceeded', 'storage/unknown']);

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

// Pull one file through the adminReadStorageFile callable, chunk by chunk.
const readFileViaServer = async (readCall, appId, path) => {
  const parts = [];
  let offset = 0;
  for (;;) {
    const res = (await readCall({ appId, path, offset })).data;
    if (res.b64) parts.push(b64ToBytes(res.b64));
    offset += res.bytes || 0;
    if (res.eof || !res.bytes) break;
  }
  return new Blob(parts);
};

const AdminTools = ({ db, appId, logAction, role }) => {
  // NOTE: the access-restricted return lives BELOW the hooks (rules-of-hooks —
  // an early return above useState/useEffect breaks hook ordering). The fetch
  // effect is gated on the same permission so restricted roles trigger no reads.
  const allowed = can(role, 'admin_tools', 'view');
  const [backupStatus, setBackupStatus] = useState('idle');
  const [restoreStatus, setRestoreStatus] = useState('idle');
  const [backupProgress, setBackupProgress] = useState('');
  const [restoreProgress, setRestoreProgress] = useState('');
  const [backupError, setBackupError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [restoreMode, setRestoreMode] = useState('replace'); // 'replace' | 'exact'
  const [restoreReport, setRestoreReport] = useState(null);
  const [storageBackupStatus, setStorageBackupStatus] = useState('idle');
  const [storageBackupProgress, setStorageBackupProgress] = useState('');
  const [storageBackupError, setStorageBackupError] = useState('');
  const [storageRestoreStatus, setStorageRestoreStatus] = useState('idle');
  const [storageRestoreProgress, setStorageRestoreProgress] = useState('');
  const [storageRestoreError, setStorageRestoreError] = useState('');
  const [waForm, setWaForm] = useState({ enabled: false, access_token: '', phone_number_id: '', verify_token: '', app_secret: '', allowed_numbers: '' });
  const [waStatus, setWaStatus] = useState('idle');

  // settings/whatsapp is admin-read (secret-bearing docs list in rules).
  useEffect(() => {
    if (!allowed || role !== 'admin') return;
    getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'whatsapp'))
      .then((snap) => { if (snap.exists()) setWaForm((f) => ({ ...f, ...snap.data() })); })
      .catch(() => { /* unconfigured */ });
  }, [db, appId, allowed, role]);

  const handleSaveWhatsapp = async () => {
    setWaStatus('saving');
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'whatsapp'),
        { ...waForm, qa_roles: ['admin', 'accountant'], updated_at: new Date().toISOString() }, { merge: true });
      setWaStatus('saved');
      logAction('admin', 'update', 'settings', {}, 'WhatsApp Copilot Settings');
    } catch (e) {
      console.error(e);
      notify(`Save failed: ${e.message}`, 'error');
      setWaStatus('idle');
      return;
    }
    setTimeout(() => setWaStatus('idle'), 3000);
  };
  const [migrating, setMigrating] = useState('');
  const [securityForm, setSecurityForm] = useState({ admin_password: '', recovery_key: '' });
  const [orgForm, setOrgForm] = useState({ name: '', address: '', pan: '', gstin: '', logo: '', currency: 'INR', email: '', phone: '', po_terms: '', challan_terms: '', payment_terms: '', invoice_terms: '', gst_api_key: '', expense_proof_threshold: 0, expense_proof_max_size_mb: 2, msme_reg: '', signature: '' });
  const [bankAccounts, setBankAccounts] = useState([]);
  const [defaultBankId, setDefaultBankId] = useState('');
  const [bankForm, setBankForm] = useState({ bank_name: '', account_name: '', account_no: '', ifsc: '', branch: '', upi_id: '' });
  const [editingBankId, setEditingBankId] = useState(null);
  const [showBankForm, setShowBankForm] = useState(false);
  const [calendarColors, setCalendarColors] = useState({
    statusColors: { ...DEFAULT_CALENDAR_STATUS_BG },
    invoiceTextColors: { ...DEFAULT_CALENDAR_INVOICE_TEXT }
  });
  const [isSavingCalendarColors, setIsSavingCalendarColors] = useState(false);
  const [lockedFYs, setLockedFYs] = useState([]);
  const [isSavingFYLock, setIsSavingFYLock] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [activeTab, setActiveTab] = useState('system');
  // Categories state
  const [customInventoryCats, setCustomInventoryCats] = useState([]);
  const [customExpenseCats, setCustomExpenseCats] = useState([]);
  const [newInventoryCat, setNewInventoryCat] = useState('');
  const [newExpenseCat, setNewExpenseCat] = useState('');
  const [isSavingCats, setIsSavingCats] = useState(false);
  const [commForm, setCommForm] = useState({ provider: 'smtp', from_name: '', from_email: '', smtp_host: '', smtp_port: 587, smtp_secure: false, smtp_user: '', smtp_pass: '', api_key: '', reminders_enabled: false, reminder_overdue_days: 7 });
  const [isSavingComm, setIsSavingComm] = useState(false);
  const [payForm, setPayForm] = useState({ provider: 'razorpay', key_id: '', key_secret: '', webhook_secret: '' });
  const [isSavingPay, setIsSavingPay] = useState(false);
  const [einvForm, setEinvForm] = useState({ enabled: false, gsp_base_url: '', client_id: '', client_secret: '', username: '', password: '', gstin: '' });
  const [isSavingEinv, setIsSavingEinv] = useState(false);
  const [chatForm, setChatForm] = useState({ presence_enabled: true, fcm_vapid_key: '' });
  const [isSavingChat, setIsSavingChat] = useState(false);
  const [trackForm, setTrackForm] = useState({ enabled: false, interval_seconds: 45, min_distance_m: 50, history_enabled: true, history_retention_days: 30 });
  const [isSavingTrack, setIsSavingTrack] = useState(false);
  // AI assistant: the API key lives in settings/ai which is READ-DENIED to all
  // clients (rules) — this form writes it blind; display state comes from the
  // non-secret settings/ai_public mirror (api_key_set boolean, never the key).
  const [aiForm, setAiForm] = useState({ enabled: false, api_key: '', model: 'claude-opus-4-8', monthly_token_budget: 2000000, per_user_rpm: 6, api_key_set: false });
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [aiUsage, setAiUsage] = useState(null);

  useEffect(() => {
    if (!allowed) return;
    const fetchSettings = async () => {
        try {
            const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'));
            if (docSnap.exists()) {
                setSecurityForm(docSnap.data());
            }
            const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
            if (orgSnap.exists()) {
                const orgData = orgSnap.data();
                setOrgForm({ name: orgData.name||'', address: orgData.address||'', pan: orgData.pan||'', gstin: orgData.gstin||'', logo: orgData.logo||'', currency: orgData.currency||'INR', email: orgData.email||'', phone: orgData.phone||'', po_terms: orgData.po_terms||'', challan_terms: orgData.challan_terms||'', payment_terms: orgData.payment_terms||'', invoice_terms: orgData.invoice_terms||'', gst_api_key: orgData.gst_api_key||'', expense_proof_threshold: orgData.expense_proof_threshold || 0, expense_proof_max_size_mb: orgData.expense_proof_max_size_mb || 2, msme_reg: orgData.msme_reg||'', signature: orgData.signature||'' });
                setBankAccounts(orgData.bank_accounts || []);
                setDefaultBankId(orgData.default_bank_id || '');
                const storedColors = orgData?.calendar_color_settings || {};
                setCalendarColors({
                  statusColors: { ...DEFAULT_CALENDAR_STATUS_BG, ...(storedColors.statusColors || {}) },
                  invoiceTextColors: { ...DEFAULT_CALENDAR_INVOICE_TEXT, ...(storedColors.invoiceTextColors || {}) }
                });
                setLockedFYs(orgData.locked_fys || []);
            }
            const catsSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'categories'));
            if (catsSnap.exists()) {
                setCustomInventoryCats(catsSnap.data().inventory_categories || []);
                setCustomExpenseCats(catsSnap.data().expense_categories || []);
            }
            const commSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'communication'));
            if (commSnap.exists()) {
                setCommForm(prev => ({ ...prev, ...commSnap.data() }));
            }
            const paySnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'payments'));
            if (paySnap.exists()) setPayForm(prev => ({ ...prev, ...paySnap.data() }));
            const einvSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'einvoice'));
            if (einvSnap.exists()) setEinvForm(prev => ({ ...prev, ...einvSnap.data() }));
            const chatSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'chat'));
            if (chatSnap.exists()) setChatForm(prev => ({ ...prev, ...chatSnap.data() }));
            const trackSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'tracking'));
            if (trackSnap.exists()) setTrackForm(prev => ({ ...prev, ...trackSnap.data() }));
            const aiPubSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'ai_public'));
            if (aiPubSnap.exists()) setAiForm(prev => ({ ...prev, ...aiPubSnap.data(), api_key: '' }));
            const aiMonth = new Date().toISOString().slice(0, 7);
            const aiUsageSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'ai_usage', `usage_${aiMonth}`));
            if (aiUsageSnap.exists()) setAiUsage(aiUsageSnap.data());
        } catch (e) { console.error(e); }
    };
    fetchSettings();
  }, [db, appId, allowed]);

  // Generic one-time migration runner (see MIGRATIONS). confirmMsg='' skips the
  // confirm (used by the non-destructive commission recalc).
  const runMigration = async (key, fnName, fmt, confirmMsg = '') => {
    if (confirmMsg && !(await confirmDialog(confirmMsg))) return;
    setMigrating(key);
    try {
      const res = await httpsCallable(getFunctions(), fnName)({ appId });
      notify(fmt(res?.data || {}), 'success');
    } catch (e) { notify(`Migration failed: ${e.message || e}`, 'error'); }
    finally { setMigrating(''); }
  };

  // ── Backup & Restore ──────────────────────────────────────────────────────
  // Server-side via the adminExportData/adminRestoreData callables (Admin SDK).
  // The old client-SDK version could neither read nor write the rule-gated
  // collections (project_financials, audit_logs updates, chat, …) and its raw
  // JSON.stringify degraded every Firestore Timestamp to a plain map. The
  // server codec tags native types ({ __t:'ts', s, n }) so they round-trip.

  const handleBackup = async () => {
    setBackupStatus('loading');
    setBackupError('');
    setBackupProgress('Discovering collections…');
    try {
      const exportCall = httpsCallable(getFunctions(), 'adminExportData');
      const { collections: cols } = (await exportCall({ appId })).data;
      const out = {
        _meta: {
          format: 'terms-backup',
          version: 2,
          exported_at: new Date().toISOString(),
          app_id: appId,
          collections: cols,
          counts: {},
        },
        data: {},
      };
      let total = 0;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const rows = [];
        let cursor = null;
        do {
          setBackupProgress(`${col} (${i + 1}/${cols.length}) — ${rows.length} docs…`);
          const res = (await exportCall({ appId, collection: col, cursor })).data;
          rows.push(...res.docs);
          cursor = res.nextCursor;
        } while (cursor);
        out.data[col] = rows;
        out._meta.counts[col] = rows.length;
        total += rows.length;
      }

      const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `full_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupStatus('success');
      setBackupProgress(`${total} docs across ${cols.length} collections`);
      logAction('admin', 'backup', 'system', { collections: cols.length, docs: total }, 'Full System Backup');
    } catch (error) {
      console.error(error);
      setBackupStatus('error');
      setBackupError(error.message || 'Backup failed');
    }
    setTimeout(() => { setBackupStatus('idle'); setBackupProgress(''); }, 6000);
  };

  // Accepts all three historical file formats and normalizes to
  // { collections: { name: [{id, d, s?}] }, legacy, dropped }.
  const normalizeBackupFile = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    let dropped = 0;
    // Native v2 (this tool): { _meta: {format:'terms-backup'}, data: {col: [{id, d}]} }
    if (raw._meta?.format === 'terms-backup' && raw.data) {
      const cols = {};
      for (const [k, rows] of Object.entries(raw.data)) {
        if (!Array.isArray(rows) || !rows.length) continue;
        const withId = rows.filter((r) => r && r.id);
        dropped += rows.length - withId.length;
        if (withId.length) cols[k] = withId;
      }
      return { collections: cols, legacy: false, dropped };
    }
    // Data Portal v1 export: { _meta: {collections:[...]}, col: [{_id, ...fields}] }
    if (raw._meta && Array.isArray(raw._meta.collections)) {
      const cols = {};
      for (const k of raw._meta.collections) {
        const rows = raw[k];
        if (!Array.isArray(rows) || !rows.length) continue;
        const withId = rows.filter((r) => r && r._id);
        dropped += rows.length - withId.length;
        if (withId.length) cols[k] = withId.map(({ _id, ...rest }) => ({ id: _id, d: rest }));
      }
      return { collections: cols, legacy: true, dropped };
    }
    // Legacy AdminTools backup: { col: [{id, ...fields}] } with no _meta.
    if (!raw._meta) {
      const cols = {};
      for (const [k, rows] of Object.entries(raw)) {
        if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object') continue;
        const withId = rows.filter((r) => r && r.id);
        dropped += rows.length - withId.length;
        if (withId.length) cols[k] = withId.map(({ id, ...rest }) => ({ id, d: rest }));
      }
      if (Object.keys(cols).length) return { collections: cols, legacy: true, dropped };
    }
    return null;
  };

  // Identity/bootstrap collections restore first so logins and role checks
  // work even if a later collection fails mid-restore.
  const RESTORE_FIRST = ['employees', 'users', 'userRoles', 'settings'];

  const handleRestore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = null;
    setRestoreError('');
    setRestoreReport(null);

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      notify('Invalid JSON file.', 'error');
      return;
    }
    const norm = normalizeBackupFile(parsed);
    if (!norm) { notify('Unrecognized backup format.', 'error'); return; }
    const colNames = Object.keys(norm.collections);
    if (!colNames.length) { notify('Backup file contains no data.', 'error'); return; }
    const totalDocs = Object.values(norm.collections).reduce((s, r) => s + r.length, 0);
    const exact = restoreMode === 'exact';

    const confirmLines = [
      `Restore ${totalDocs} docs across ${colNames.length} collection(s)?`,
      '',
      exact
        ? 'EXACT MODE: each collection in the file is WIPED first — anything created since this backup is DELETED.'
        : 'Overwrite mode: file docs replace matching IDs; records created since the backup are kept.',
      norm.legacy ? 'Legacy file: its timestamps were stored in degraded form and restore as-is.' : '',
      norm.dropped ? `${norm.dropped} record(s) without IDs will be skipped.` : '',
    ].filter(Boolean);
    if (!await confirmDialog(confirmLines.join('\n'))) return;

    setRestoreStatus('loading');
    const restoreCall = httpsCallable(getFunctions(), 'adminRestoreData');
    const ordered = [
      ...RESTORE_FIRST.filter((c) => c in norm.collections),
      ...colNames.filter((c) => !RESTORE_FIRST.includes(c)).sort(),
    ];
    const report = [];
    let firstCall = true; // first server call re-registers the tenant in meta/active_apps
    for (let i = 0; i < ordered.length; i++) {
      const col = ordered[i];
      const rows = norm.collections[col];
      try {
        let written = 0;
        if (exact) {
          setRestoreProgress(`Wiping ${col} (${i + 1}/${ordered.length})…`);
          await restoreCall({ appId, collection: col, wipe: true, registerApp: firstCall });
          firstCall = false;
        }
        for (let o = 0; o < rows.length; o += 300) {
          const chunk = rows.slice(o, o + 300);
          setRestoreProgress(`${col} (${i + 1}/${ordered.length}) — ${Math.min(o + 300, rows.length)}/${rows.length} docs`);
          const res = (await restoreCall({ appId, collection: col, docs: chunk, registerApp: firstCall })).data;
          firstCall = false;
          written += res.written || 0;
        }
        report.push({ col, written, ok: true });
      } catch (error) {
        console.error(`Restore failed for ${col}:`, error);
        report.push({ col, ok: false, error: error.message || 'failed' });
      }
    }
    const failed = report.filter((r) => !r.ok);
    setRestoreReport(report);
    setRestoreProgress('');
    if (failed.length) {
      setRestoreStatus('error');
      setRestoreError(`${failed.length} of ${report.length} collection(s) failed — see list below.`);
      notify(`Restore finished with errors in: ${failed.map((f) => f.col).join(', ')}`, 'error');
    } else {
      setRestoreStatus('success');
      notify('Restore completed successfully. Refresh the page to reload data.', 'success');
    }
    logAction('admin', 'restore', 'system', { mode: restoreMode, collections: report.length, failed: failed.length }, 'Full System Restore');
    setTimeout(() => setRestoreStatus('idle'), 6000);
  };

  // ── Storage backup & restore (file attachments) ───────────────────────────
  // The JSON backup covers Firestore only; uploaded files (expense proofs,
  // PI scans, chat attachments, draft attachments) live in Storage. The
  // adminListStorage callable produces the manifest; the files themselves
  // download through the Storage SDK — or, where a browser extension blocks
  // that, through adminReadStorageFile — and pack into a zip alongside it.

  const handleStorageBackup = async () => {
    setStorageBackupStatus('loading');
    setStorageBackupError('');
    setStorageBackupProgress('Listing files…');
    try {
      const listCall = httpsCallable(getFunctions(), 'adminListStorage');
      const plan = (await listCall({ appId })).data;
      const manifest = [];
      for (let i = 0; i < plan.prefixes.length; i++) {
        let token = null;
        do {
          const res = (await listCall({ appId, prefixIndex: i, pageToken: token })).data;
          manifest.push(...res.files);
          token = res.nextPageToken;
          setStorageBackupProgress(`Listing ${plan.prefixes[i]} — ${manifest.length} files`);
        } while (token);
      }
      const totalMB = manifest.reduce((s, f) => s + f.size, 0) / 1048576;
      const zip = new JSZip();
      zip.file('storage-manifest.json', JSON.stringify({
        format: 'terms-storage-backup', version: 1,
        exported_at: new Date().toISOString(), app_id: appId, bucket: plan.bucket,
        other_files_outside_prefixes: plan.otherFiles || 0, files: manifest,
      }, null, 2));
      const readCall = httpsCallable(getFunctions(), 'adminReadStorageFile', { timeout: 180000 });
      let done = 0;
      let viaServer = false;
      const failed = [];
      // Ad/tracking blockers cancel the direct requests to
      // firebasestorage.googleapis.com, and the SDK's default two-minute retry
      // window would then be spent per file before we ever learn that. Fail
      // fast, and once a network-level refusal appears treat it as permanent —
      // a blocker rejects every file alike — so the rest of the run goes
      // straight through the server without re-paying that wait.
      const prevRetryMs = storage.maxOperationRetryTime;
      storage.maxOperationRetryTime = 12000;
      try {
        for (const f of manifest) {
          try {
            let fileBlob = null;
            if (!viaServer) {
              try {
                fileBlob = await getBlob(ref(storage, f.path));
              } catch (err) {
                if (STORAGE_NETWORK_CODES.has(err?.code)) {
                  viaServer = true;
                  setStorageBackupProgress('Direct downloads blocked by this browser — routing through the server…');
                }
                console.warn('Storage backup: direct download failed, retrying server-side', f.path, err);
              }
            }
            // Also the retry for a one-off direct failure: the Admin SDK reads
            // the object regardless of what stopped the browser.
            if (!fileBlob) fileBlob = await readFileViaServer(readCall, appId, f.path);
            zip.file(f.path, fileBlob);
          } catch (err) {
            failed.push(f.path);
            console.error('Storage backup: download failed', f.path, err);
          }
          done += 1;
          if (done % 5 === 0 || done === manifest.length) {
            setStorageBackupProgress(`Downloading ${done}/${manifest.length} files (${totalMB.toFixed(1)} MB total)…`);
          }
        }
      } finally {
        storage.maxOperationRetryTime = prevRetryMs;
      }
      setStorageBackupProgress('Compressing…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `storage_backup_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStorageBackupStatus(failed.length ? 'error' : 'success');
      if (failed.length) setStorageBackupError(`${failed.length} file(s) failed to download and are missing from the zip.`);
      setStorageBackupProgress(
        `${manifest.length - failed.length} files, ${(blob.size / 1048576).toFixed(1)} MB` +
        (viaServer ? ' — a browser extension blocked direct downloads, so these came through the server' : '') +
        (plan.otherFiles ? ` — ${plan.otherFiles} file(s) outside known app prefixes NOT included` : ''),
      );
      logAction('admin', 'backup', 'storage', { files: manifest.length, failed: failed.length, via: viaServer ? 'server' : 'direct' }, 'Storage Backup');
    } catch (error) {
      console.error(error);
      setStorageBackupStatus('error');
      setStorageBackupError(error.message || 'Storage backup failed');
    }
    setTimeout(() => setStorageBackupStatus('idle'), 8000);
  };

  const handleStorageRestore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = null;
    setStorageRestoreError('');
    try {
      const zip = await JSZip.loadAsync(file);
      const manifestEntry = zip.file('storage-manifest.json');
      const manifest = manifestEntry ? JSON.parse(await manifestEntry.async('string')) : null;
      const entries = Object.values(zip.files).filter((f) => !f.dir && f.name !== 'storage-manifest.json');
      if (!entries.length) { notify('Zip contains no files.', 'error'); return; }
      const typeByPath = {};
      (manifest?.files || []).forEach((m) => { typeByPath[m.path] = m.contentType; });
      if (!await confirmDialog(`Upload ${entries.length} file(s) to Storage?\nExisting files at the same paths will be overwritten.`)) return;
      setStorageRestoreStatus('loading');
      let done = 0;
      const failed = [];
      for (const entry of entries) {
        try {
          const blob = await entry.async('blob');
          await uploadBytes(ref(storage, entry.name), blob,
            typeByPath[entry.name] ? { contentType: typeByPath[entry.name] } : undefined);
        } catch (err) {
          failed.push(entry.name);
          console.error('Storage restore: upload failed', entry.name, err);
        }
        done += 1;
        setStorageRestoreProgress(`Uploading ${done}/${entries.length}…`);
      }
      setStorageRestoreStatus(failed.length ? 'error' : 'success');
      setStorageRestoreProgress('');
      if (failed.length) {
        setStorageRestoreError(`${failed.length} file(s) failed to upload — see console.`);
        notify(`Storage restore finished with ${failed.length} failure(s).`, 'error');
      } else {
        notify('Storage restore complete.', 'success');
      }
      logAction('admin', 'restore', 'storage', { files: entries.length, failed: failed.length }, 'Storage Restore');
    } catch (error) {
      console.error(error);
      setStorageRestoreStatus('error');
      setStorageRestoreError(error.message || 'Invalid zip file');
      notify('Storage restore failed.', 'error');
    }
    setTimeout(() => setStorageRestoreStatus('idle'), 8000);
  };

  const handleUpdateSecurity = async () => {
    if (!securityForm.admin_password || !securityForm.recovery_key) return notify("Both Password and Recovery Key are required.", 'error');
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'), securityForm);
    logAction('admin', 'update_security', 'security', {}, 'Updated Admin Credentials');
    notify("Admin Security Settings Updated Successfully.", 'success');
  };

  const handleSaveOrgSettings = async () => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'), orgForm, { merge: true });
    logAction('admin', 'update_org', 'organization', {}, 'Updated Organization Details');
    notify("Organization Details Updated.", 'success');
  };

  const handleSaveCommunication = async () => {
    setIsSavingComm(true);
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'communication'), {
        ...commForm,
        smtp_port: Number(commForm.smtp_port) || 587,
        reminder_overdue_days: Number(commForm.reminder_overdue_days) || 7,
      }, { merge: true });
      logAction('admin', 'update_communication', 'communication', {}, 'Updated Communication Settings');
      notify('Communication settings saved.', 'success');
    } catch (e) {
      notify('Failed to save: ' + (e?.message || 'error'), 'error');
    } finally { setIsSavingComm(false); }
  };

  const handleSavePayments = async () => {
    setIsSavingPay(true);
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'payments'), payForm, { merge: true });
      logAction('admin', 'update_payments', 'payments', {}, 'Updated Payment Gateway Settings');
      notify('Payment settings saved.', 'success');
    } catch (e) { notify('Failed to save: ' + (e?.message || 'error'), 'error'); } finally { setIsSavingPay(false); }
  };

  const handleSaveEinvoice = async () => {
    setIsSavingEinv(true);
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'einvoice'), einvForm, { merge: true });
      logAction('admin', 'update_einvoice', 'einvoice', {}, 'Updated E-Invoice Settings');
      notify('E-invoice settings saved.', 'success');
    } catch (e) { notify('Failed to save: ' + (e?.message || 'error'), 'error'); } finally { setIsSavingEinv(false); }
  };

  const handleSaveChat = async () => {
    setIsSavingChat(true);
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'chat'), {
        presence_enabled: chatForm.presence_enabled !== false,
        fcm_vapid_key: (chatForm.fcm_vapid_key || '').trim(),
      }, { merge: true });
      logAction('admin', 'update_chat', 'chat', {}, 'Updated Chat / Notification Settings');
      notify('Chat settings saved.', 'success');
    } catch (e) { notify('Failed to save: ' + (e?.message || 'error'), 'error'); } finally { setIsSavingChat(false); }
  };

  const handleSaveTracking = async () => {
    setIsSavingTrack(true);
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'tracking'), {
        enabled: !!trackForm.enabled,
        interval_seconds: Math.max(15, Number(trackForm.interval_seconds) || 45),
        min_distance_m: Math.max(0, Number(trackForm.min_distance_m) || 50),
        history_enabled: trackForm.history_enabled !== false,
        history_retention_days: Math.max(1, Number(trackForm.history_retention_days) || 30),
      }, { merge: true });
      logAction('admin', 'update_tracking', 'tracking', {}, 'Updated Location Tracking Settings');
      notify('Location tracking settings saved.', 'success');
    } catch (e) { notify('Failed to save: ' + (e?.message || 'error'), 'error'); } finally { setIsSavingTrack(false); }
  };

  const handleSaveAi = async () => {
    setIsSavingAi(true);
    try {
      const enabled = !!aiForm.enabled;
      const model = (aiForm.model || '').trim() || 'claude-opus-4-8';
      const monthly_token_budget = Math.max(20000, Number(aiForm.monthly_token_budget) || 2000000);
      const per_user_rpm = Math.max(1, Number(aiForm.per_user_rpm) || 6);
      const keyEntered = (aiForm.api_key || '').trim();
      const api_key_set = keyEntered ? true : !!aiForm.api_key_set;
      // One atomic batch — the secret doc and its non-secret mirror must never
      // drift (a half-saved pair makes the feature look broken or misconfigured).
      const batch = writeBatch(db);
      // Secret doc — read-denied to every client role; written blind. The key is
      // only included when the admin actually typed one (leave blank to keep).
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'ai'), {
        enabled, model, monthly_token_budget, per_user_rpm,
        ...(keyEntered ? { api_key: keyEntered } : {}),
      }, { merge: true });
      // Non-secret mirror for UI display — never holds the key itself.
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'ai_public'), {
        enabled, model, monthly_token_budget, api_key_set,
      }, { merge: true });
      await batch.commit();
      setAiForm(prev => ({ ...prev, api_key: '', api_key_set }));
      // Audit log payload deliberately excludes the key.
      logAction('admin', 'update_ai', 'ai', {}, 'Updated AI Assistant Settings');
      notify('AI assistant settings saved.', 'success');
    } catch (e) { notify('Failed to save: ' + (e?.message || 'error'), 'error'); } finally { setIsSavingAi(false); }
  };

  // Remove the stored key entirely (compromised key / offboarding). Blank input
  // on save means "keep", so this is the only client-side way to purge it.
  const handleClearAiKey = async () => {
    const ok = await confirmDialog({
      title: 'Remove AI API key?',
      message: 'This deletes the stored Anthropic API key and disables AI assistance. You can add a new key any time.',
      confirmText: 'Remove key',
    });
    if (!ok) return;
    setIsSavingAi(true);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'ai'), {
        api_key: deleteField(), enabled: false,
      }, { merge: true });
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'ai_public'), {
        api_key_set: false, enabled: false,
      }, { merge: true });
      await batch.commit();
      setAiForm(prev => ({ ...prev, api_key: '', api_key_set: false, enabled: false }));
      logAction('admin', 'update_ai', 'ai', {}, 'Removed AI API key');
      notify('AI API key removed and assistant disabled.', 'success');
    } catch (e) { notify('Failed to remove key: ' + (e?.message || 'error'), 'error'); } finally { setIsSavingAi(false); }
  };

  const handleAddOrUpdateBank = () => {
    const { bank_name, account_name, account_no, ifsc } = bankForm;
    if (!bank_name || !account_name || !account_no || !ifsc) return notify('Bank Name, Account Name, Account Number, and IFSC are required.', 'error');
    if (editingBankId) {
      setBankAccounts(prev => prev.map(b => b.id === editingBankId ? { ...bankForm, id: editingBankId } : b));
      setEditingBankId(null);
    } else {
      const newBank = { ...bankForm, id: Date.now().toString() };
      setBankAccounts(prev => {
        const updated = [...prev, newBank];
        if (updated.length === 1) setDefaultBankId(newBank.id); // auto-default first bank
        return updated;
      });
    }
    setBankForm({ bank_name: '', account_name: '', account_no: '', ifsc: '', branch: '', upi_id: '' });
    setShowBankForm(false);
  };

  const handleDeleteBank = (bankId) => {
    const bank = bankAccounts.find(b => b.id === bankId);
    setDeleteConfirm({
      isOpen: true,
      title: 'Delete Bank Account',
      message: `Remove bank account "${bank?.bank_name || 'this account'}"? This will also unset it as default if selected.`,
      onConfirm: () => {
        setBankAccounts(prev => prev.filter(b => b.id !== bankId));
        if (defaultBankId === bankId) setDefaultBankId('');
      }
    });
  };

  const handleEditBank = (bank) => {
    setBankForm({ bank_name: bank.bank_name, account_name: bank.account_name, account_no: bank.account_no, ifsc: bank.ifsc, branch: bank.branch||'', upi_id: bank.upi_id||'' });
    setEditingBankId(bank.id);
    setShowBankForm(true);
  };

  const handleSaveBankSettings = async () => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'), { bank_accounts: bankAccounts, default_bank_id: defaultBankId }, { merge: true });
    logAction('admin', 'update_banks', 'organization', {}, 'Updated Bank Accounts');
    notify('Bank account settings saved.', 'success');
  };

  const handleSaveCalendarColors = async () => {
    try {
      setIsSavingCalendarColors(true);
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'),
        { calendar_color_settings: calendarColors },
        { merge: true }
      );
      logAction('admin', 'update_calendar_colors', 'organization', {}, 'Updated Calendar Colors');
      notify('Calendar colors saved.', 'success');
    } catch (error) {
      console.error(error);
      notify('Failed to save calendar colors.', 'error');
    } finally {
      setIsSavingCalendarColors(false);
    }
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
        if (file.size > 500000) return notify("File too large. Max 500KB.", 'info');
        const reader = new FileReader();
        reader.onloadend = () => {
            setOrgForm(prev => ({ ...prev, logo: reader.result }));
        };
        reader.readAsDataURL(file);
    }
  };

  const handleSignatureUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
        if (file.size > 500000) return notify("File too large. Max 500KB.", 'info');
        const reader = new FileReader();
        reader.onloadend = () => {
            setOrgForm(prev => ({ ...prev, signature: reader.result }));
        };
        reader.readAsDataURL(file);
    }
  };

  // --- FY Lock helpers ---
  const generateFYOptions = () => {
    const currentFY = getFinancialYear();
    const [startYear] = currentFY.split('-').map(Number);
    const fys = [];
    for (let i = 0; i < 6; i++) {
      const yr = startYear - i;
      fys.push(`${yr}-${String(yr + 1).slice(-2)}`);
    }
    return fys;
  };

  const handleToggleFYLock = async (fy) => {
    if (lockedFYs.includes(fy)) {
      setLockedFYs(prev => prev.filter(f => f !== fy));
    } else {
      if (fy === getFinancialYear()) {
        if (!await confirmDialog(`You are about to lock the CURRENT financial year (${fy}). This will prevent any new transactions until unlocked. Continue?`)) return;
      }
      setLockedFYs(prev => [...prev, fy]);
    }
  };

  const handleSaveFYLock = async () => {
    try {
      setIsSavingFYLock(true);
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'),
        { locked_fys: lockedFYs },
        { merge: true }
      );
      logAction('admin', 'update_fy_lock', 'organization', { locked_fys: lockedFYs }, 'Updated FY Lock settings');
      notify('FY Lock settings saved.', 'success');
    } catch (error) {
      console.error(error);
      notify('Failed to save FY Lock settings.', 'error');
    } finally {
      setIsSavingFYLock(false);
    }
  };

  const handleSaveCategories = async () => {
    try {
      setIsSavingCats(true);
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'categories'),
        { inventory_categories: customInventoryCats, expense_categories: customExpenseCats }
      );
      logAction('admin', 'update_categories', 'settings', {}, 'Updated custom categories');
      notify('Categories saved. Reload the app to see them everywhere.', 'success');
    } catch (error) {
      console.error(error);
      notify('Failed to save categories.', 'error');
    } finally {
      setIsSavingCats(false);
    }
  };

  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock size={40} className="text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-700 mb-2">Access Restricted</h2>
        <p className="text-slate-500 text-sm">Admin Tools are only accessible to the Owner.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
       <h2 className="text-2xl font-bold text-slate-800">Admin Tools</h2>

       {/* ── Tab navigation ── */}
       <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit max-w-full overflow-x-auto">
         <button
           onClick={() => setActiveTab('system')}
           className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
             activeTab === 'system'
               ? 'bg-white text-slate-800 shadow-sm'
               : 'text-slate-500 hover:text-slate-700'
           }`}
         >
           <Briefcase size={15} /> System Settings
         </button>
         <button
           onClick={() => setActiveTab('rbac')}
           className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
             activeTab === 'rbac'
               ? 'bg-white text-slate-800 shadow-sm'
               : 'text-slate-500 hover:text-slate-700'
           }`}
         >
           <Users size={15} /> Roles &amp; Permissions
         </button>
         <button
           onClick={() => setActiveTab('categories')}
           className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
             activeTab === 'categories'
               ? 'bg-white text-slate-800 shadow-sm'
               : 'text-slate-500 hover:text-slate-700'
           }`}
         >
           <Tag size={15} /> Categories
         </button>
       </div>

       {/* ── Roles & Permissions Matrix tab ── */}
       {activeTab === 'rbac' && (
         <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
           <RBACManager db={db} appId={appId} logAction={logAction} />
         </div>
       )}

       {/* ── Categories tab ── */}
       {activeTab === 'categories' && (
         <div className="space-y-6">
           <div className="grid md:grid-cols-2 gap-6">
             {/* Inventory Categories */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
               <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Tag size={18} /> Inventory Categories</h3>
               <p className="text-xs text-slate-500 mb-4">Default categories are always present. Add custom categories for your specific equipment types.</p>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Defaults (read-only)</p>
                 <div className="flex flex-wrap gap-1.5">
                   {CATEGORIES.map(c => (
                     <span key={c} className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">{c}</span>
                   ))}
                 </div>
               </div>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Custom Categories</p>
                 {customInventoryCats.length === 0 && <p className="text-xs text-slate-400 italic">No custom categories yet.</p>}
                 <div className="flex flex-wrap gap-1.5">
                   {customInventoryCats.map(c => (
                     <span key={c} className="flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded text-xs font-medium">
                       {c}
                       <button type="button" onClick={() => setCustomInventoryCats(prev => prev.filter(x => x !== c))} className="text-indigo-400 hover:text-red-500 ml-1"><X size={11} /></button>
                     </span>
                   ))}
                 </div>
               </div>
               <div className="flex gap-2">
                 <input
                   type="text"
                   className="flex-1 rounded border border-slate-300 p-2 text-sm text-black bg-white"
                   placeholder="e.g. Drones, Rigging..."
                   value={newInventoryCat}
                   onChange={e => setNewInventoryCat(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && newInventoryCat.trim()) { const v = newInventoryCat.trim(); if (!CATEGORIES.includes(v) && !customInventoryCats.includes(v)) setCustomInventoryCats(prev => [...prev, v]); setNewInventoryCat(''); } }}
                 />
                 <button
                   type="button"
                   onClick={() => { const v = newInventoryCat.trim(); if (v && !CATEGORIES.includes(v) && !customInventoryCats.includes(v)) { setCustomInventoryCats(prev => [...prev, v]); setNewInventoryCat(''); } }}
                   className="flex items-center gap-1 px-3 py-2 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                 ><Plus size={14} /> Add</button>
               </div>
             </div>

             {/* Expense Categories */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
               <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Tag size={18} /> Expense Categories</h3>
               <p className="text-xs text-slate-500 mb-4">Default expense types are always present. Add custom categories to match your finance workflow.</p>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Defaults (read-only)</p>
                 <div className="flex flex-wrap gap-1.5">
                   {EXPENSE_CATS.map(c => (
                     <span key={c} className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">{c}</span>
                   ))}
                 </div>
               </div>
               <div className="space-y-2 mb-4">
                 <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Custom Categories</p>
                 {customExpenseCats.length === 0 && <p className="text-xs text-slate-400 italic">No custom categories yet.</p>}
                 <div className="flex flex-wrap gap-1.5">
                   {customExpenseCats.map(c => (
                     <span key={c} className="flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-medium">
                       {c}
                       <button type="button" onClick={() => setCustomExpenseCats(prev => prev.filter(x => x !== c))} className="text-green-400 hover:text-red-500 ml-1"><X size={11} /></button>
                     </span>
                   ))}
                 </div>
               </div>
               <div className="flex gap-2">
                 <input
                   type="text"
                   className="flex-1 rounded border border-slate-300 p-2 text-sm text-black bg-white"
                   placeholder="e.g. Equipment Hire, Insurance..."
                   value={newExpenseCat}
                   onChange={e => setNewExpenseCat(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && newExpenseCat.trim()) { const v = newExpenseCat.trim(); if (!EXPENSE_CATS.includes(v) && !customExpenseCats.includes(v)) setCustomExpenseCats(prev => [...prev, v]); setNewExpenseCat(''); } }}
                 />
                 <button
                   type="button"
                   onClick={() => { const v = newExpenseCat.trim(); if (v && !EXPENSE_CATS.includes(v) && !customExpenseCats.includes(v)) { setCustomExpenseCats(prev => [...prev, v]); setNewExpenseCat(''); } }}
                   className="flex items-center gap-1 px-3 py-2 rounded bg-green-600 text-white text-sm hover:bg-green-700"
                 ><Plus size={14} /> Add</button>
               </div>
             </div>
           </div>
           <button
             onClick={handleSaveCategories}
             disabled={isSavingCats}
             className="bg-indigo-600 text-white px-8 py-2.5 rounded-lg hover:bg-indigo-700 disabled:bg-indigo-300 font-medium"
           >
             {isSavingCats ? 'Saving...' : 'Save All Categories'}
           </button>
         </div>
       )}

       {/* ── System Settings tab ── */}
       {activeTab === 'system' && <><div className="grid md:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><Download size={20} /> Backup Data</h3>
             <p className="text-slate-500 text-sm mb-4">Downloads a complete JSON snapshot of every Firestore collection — auto-discovered, including gated financials, settings, counters and chat history. Storage file attachments (receipts, scans, logos) are <span className="font-medium">not</span> included. The file contains credentials and financial data — store it securely.</p>
             <button onClick={handleBackup} disabled={backupStatus === 'loading'} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {backupStatus === 'loading' ? 'Backing up…' : 'Download Full Backup'}
             </button>
             {backupStatus === 'loading' && backupProgress && <div className="mt-2 text-indigo-600 text-sm">{backupProgress}</div>}
             {backupStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Backup downloaded — {backupProgress}</div>}
             {backupStatus === 'error' && <div className="mt-2 text-red-600 text-sm font-medium">Backup failed: {backupError}</div>}
             <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-slate-500 text-sm mb-3">File attachments (expense proofs, invoice scans, chat uploads) are backed up separately as a ZIP with a manifest.</p>
                <button onClick={handleStorageBackup} disabled={storageBackupStatus === 'loading'} className="bg-slate-700 text-white px-4 py-2 rounded hover:bg-slate-800 disabled:bg-slate-400">
                   {storageBackupStatus === 'loading' ? 'Backing up files…' : 'Download Storage Backup (ZIP)'}
                </button>
                {storageBackupStatus === 'loading' && storageBackupProgress && <div className="mt-2 text-indigo-600 text-sm">{storageBackupProgress}</div>}
                {storageBackupStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Storage backup downloaded — {storageBackupProgress}</div>}
                {storageBackupStatus === 'error' && <div className="mt-2 text-red-600 text-sm font-medium">{storageBackupError}</div>}
             </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><Upload size={20} /> Restore Data</h3>
             <p className="text-slate-500 text-sm mb-4">Restores server-side, so rule-gated collections (financials, audit logs, chat) restore too. Accepts full backups from this tool plus legacy Admin / Data Portal export files.</p>
             <div className="mb-3 space-y-1.5 text-sm text-slate-700">
                <label className="flex items-start gap-2 cursor-pointer">
                   <input type="radio" name="restoreMode" checked={restoreMode === 'replace'} onChange={() => setRestoreMode('replace')} className="mt-1" />
                   <span><span className="font-medium">Overwrite</span> — file docs replace matching IDs; records created since the backup are kept</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                   <input type="radio" name="restoreMode" checked={restoreMode === 'exact'} onChange={() => setRestoreMode('exact')} className="mt-1" />
                   <span><span className="font-medium text-rose-700">Exact snapshot</span> — wipes each collection in the file first; anything created after the backup is deleted</span>
                </label>
             </div>
             <div className="relative">
                <input type="file" accept=".json" onChange={handleRestore} disabled={restoreStatus === 'loading'} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
             </div>
             {restoreStatus === 'loading' && <div className="mt-2 text-indigo-600 text-sm">{restoreProgress || 'Restoring…'}</div>}
             {restoreStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Restore complete! Refresh the page to reload data.</div>}
             {restoreStatus === 'error' && <div className="mt-2 text-red-600 text-sm font-medium">{restoreError}</div>}
             {restoreReport && (
                <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5 text-xs">
                   {restoreReport.map((r) => (
                      <li key={r.col} className={r.ok ? 'text-slate-500' : 'text-rose-600 font-medium'}>
                         {r.ok ? `✓ ${r.col} — ${r.written} docs` : `✕ ${r.col} — ${r.error}`}
                      </li>
                   ))}
                </ul>
             )}
             <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-slate-500 text-sm mb-2">Restore file attachments from a Storage Backup ZIP. Files upload to their original paths.</p>
                <input type="file" accept=".zip" onChange={handleStorageRestore} disabled={storageRestoreStatus === 'loading'} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"/>
                {storageRestoreStatus === 'loading' && <div className="mt-2 text-indigo-600 text-sm">{storageRestoreProgress || 'Uploading…'}</div>}
                {storageRestoreStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Storage restore complete!</div>}
                {storageRestoreStatus === 'error' && <div className="mt-2 text-red-600 text-sm font-medium">{storageRestoreError}</div>}
             </div>
          </div>
       </div>

       {role === 'admin' && featureOn('whatsapp_copilot') && (
         <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Bell size={20} /> WhatsApp Copilot</h3>
            <p className="text-slate-500 text-sm mb-4">Registered team members can WhatsApp the books — ask questions in English/Hinglish ("Acme ka balance?") or send an invoice photo to create a draft entry. Uses the Meta WhatsApp Cloud API; needs the AI accountant enabled. Paste the webhook URL below into your Meta app's WhatsApp webhook config.</p>
            <div className="grid md:grid-cols-2 gap-3 mb-3">
               <label className="text-sm text-slate-600">Phone Number ID
                  <input type="text" value={waForm.phone_number_id} onChange={(e) => setWaForm({ ...waForm, phone_number_id: e.target.value })} className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm" placeholder="from Meta > WhatsApp > API Setup"/>
               </label>
               <label className="text-sm text-slate-600">Permanent Access Token
                  <input type="password" value={waForm.access_token} onChange={(e) => setWaForm({ ...waForm, access_token: e.target.value })} className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm" placeholder="System-user token with whatsapp_business_messaging"/>
               </label>
               <label className="text-sm text-slate-600">Verify Token (any secret string)
                  <input type="text" value={waForm.verify_token} onChange={(e) => setWaForm({ ...waForm, verify_token: e.target.value })} className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm"/>
               </label>
               <label className="text-sm text-slate-600">App Secret (for webhook signatures)
                  <input type="password" value={waForm.app_secret} onChange={(e) => setWaForm({ ...waForm, app_secret: e.target.value })} className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm"/>
               </label>
            </div>
            <label className="text-sm text-slate-600 block mb-3">Extra allowed numbers (optional — employees are matched by their profile mobile automatically). One per line: <code className="bg-slate-100 px-1 rounded">+919876543210 = EMPLOYEE_DOC_ID</code>
               <textarea value={waForm.allowed_numbers} onChange={(e) => setWaForm({ ...waForm, allowed_numbers: e.target.value })} rows={2} className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"/>
            </label>
            <div className="flex items-center gap-4 mb-3">
               <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={!!waForm.enabled} onChange={(e) => setWaForm({ ...waForm, enabled: e.target.checked })}/>
                  Enabled
               </label>
               <button onClick={handleSaveWhatsapp} disabled={waStatus === 'saving'} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300 text-sm">
                  {waStatus === 'saving' ? 'Saving…' : 'Save WhatsApp Settings'}
               </button>
               {waStatus === 'saved' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
            </div>
            <p className="text-xs text-slate-400 break-all">Webhook URL: https://us-central1-{app?.options?.projectId}.cloudfunctions.net/whatsappWebhook</p>
            <p className="text-xs text-slate-400 mt-1">Books answers over WhatsApp are limited to admin/accountant roles. All conversations are logged (admin-visible only).</p>
         </div>
       )}

       {role === 'admin' && (
         <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Database size={20} /> Data Migration</h3>
            <p className="text-slate-500 text-sm mb-4">One-time zero-trust field-split tools (moved here from the Projects / Inventory / Employees pages). New records migrate automatically via triggers — only re-run these after a bulk import of old data. <span className="text-rose-600 font-medium">Scrub removes money from the base docs — run it only after Backfill and confirming figures still display.</span></p>
            <div className="space-y-3">
              {MIGRATIONS.map(m => (
                <div key={m.key} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                  <span className="w-24 shrink-0 text-sm font-semibold text-slate-700">{m.label}</span>
                  <button onClick={() => runMigration(`${m.key}-b`, m.backfill.fn, m.backfill.fmt, m.backfill.msg)} disabled={!!migrating} className="rounded border border-amber-300 bg-amber-50 text-amber-700 px-3 py-1.5 text-sm hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap">
                    {migrating === `${m.key}-b` ? 'Backfilling…' : `Backfill ${m.noun}`}
                  </button>
                  <button onClick={() => runMigration(`${m.key}-s`, m.scrub.fn, m.scrub.fmt, m.scrub.msg)} disabled={!!migrating} className="rounded border border-rose-300 bg-rose-50 text-rose-700 px-3 py-1.5 text-sm hover:bg-rose-100 disabled:opacity-50 whitespace-nowrap">
                    {migrating === `${m.key}-s` ? 'Scrubbing…' : 'Scrub base'}
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="w-24 shrink-0 text-sm font-semibold text-slate-700">Commission</span>
                <button onClick={() => runMigration('exp', 'backfillProjectExpenseTotals', (d) => `Recalculated cost totals for ${d.stamped ?? 0} project(s).`)} disabled={!!migrating} className="rounded border border-slate-300 text-slate-600 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap">
                  {migrating === 'exp' ? 'Recalculating…' : 'Recalculate cost totals'}
                </button>
              </div>
            </div>
         </div>
       )}

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Briefcase size={20} /> Organization Settings</h3>
            <div className="grid md:grid-cols-2 gap-4">
                <div><label className="block text-sm font-bold text-slate-700 mb-1">Company Name</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.name} onChange={e => setOrgForm({...orgForm, name: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">GSTIN</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.gstin} onChange={e => setOrgForm({...orgForm, gstin: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">PAN</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.pan} onChange={e => setOrgForm({...orgForm, pan: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">Currency Symbol</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.currency} onChange={e => setOrgForm({...orgForm, currency: e.target.value})} /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Address</label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={2} value={orgForm.address} onChange={e => setOrgForm({...orgForm, address: e.target.value})} /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">PO Standard Terms</label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={3} value={orgForm.po_terms || ''} onChange={e => setOrgForm({...orgForm, po_terms: e.target.value})} placeholder="Default terms for Purchase Orders..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Challan Standard Terms</label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={3} value={orgForm.challan_terms || ''} onChange={e => setOrgForm({...orgForm, challan_terms: e.target.value})} placeholder="Default terms for Challans..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Default Payment Terms <span className="text-indigo-500 font-normal">(used in Proforma Invoices)</span></label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={3} value={orgForm.payment_terms || ''} onChange={e => setOrgForm({...orgForm, payment_terms: e.target.value})} placeholder="e.g. 50% advance on confirmation, balance before delivery..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Invoice Terms &amp; Conditions <span className="text-indigo-500 font-normal">(printed on every Tax Invoice)</span></label><textarea className="w-full rounded border border-slate-300 p-2 bg-white text-black" rows={4} value={orgForm.invoice_terms || ''} onChange={e => setOrgForm({...orgForm, invoice_terms: e.target.value})} placeholder="e.g. Payment due within 30 days. Goods once sold are not returnable. Subject to local jurisdiction..." /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">MSME / Udyam Reg. No. <span className="text-indigo-500 font-normal">(GST-format invoice)</span></label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.msme_reg || ''} onChange={e => setOrgForm({...orgForm, msme_reg: e.target.value})} placeholder="e.g. UDYAM-DL-09-0006473" /></div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Authorized Signature <span className="text-indigo-500 font-normal">(GST-format invoice, max 500KB)</span></label>
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-24 rounded border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden">
                      {orgForm.signature ? <img src={orgForm.signature} alt="Signature" className="h-full w-full object-contain" /> : <Image className="text-slate-300" size={18} />}
                    </div>
                    <input type="file" accept="image/*" onChange={handleSignatureUpload} className="text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                    {orgForm.signature && <button type="button" onClick={() => setOrgForm(prev => ({ ...prev, signature: '' }))} className="text-xs text-red-500 hover:underline">Remove</button>}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-700 mb-1">
                    GST Portal API Key
                    <span className="text-xs text-slate-400 font-normal ml-1">(from api.gst.gov.in — used for GSTIN auto-lookup)</span>
                  </label>
                  <input
                    className="w-full rounded border border-slate-300 p-2 bg-white text-black font-mono text-sm placeholder-slate-400 focus:ring-2 focus:ring-indigo-500"
                    value={orgForm.gst_api_key || ''}
                    onChange={e => setOrgForm({...orgForm, gst_api_key: e.target.value})}
                    placeholder="Paste your GST Portal auth-token here"
                    autoComplete="off"
                  />
                  <p className="mt-1 text-xs text-slate-400">Used in GSTIN Lookup button on client/vendor forms. Leave blank to disable auto-lookup.</p>
                </div>

                <div className="md:col-span-2 border-t pt-4 mt-2">
                    <h4 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2"><Shield size={16} className="text-amber-600" /> Expense Proof Policy</h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-bold text-slate-700 mb-1">
                          Proof Required Above (₹)
                          <span className="text-xs text-slate-400 font-normal ml-1">(0 = never required)</span>
                        </label>
                        <input type="number" min="0" step="1" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.expense_proof_threshold} onChange={e => setOrgForm({...orgForm, expense_proof_threshold: parseFloat(e.target.value) || 0})} placeholder="e.g. 500" />
                        <p className="mt-1 text-xs text-slate-400">Employees must attach proof (invoice/bill/receipt) for expenses above this amount.</p>
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-700 mb-1">
                          Max File Size (MB)
                          <span className="text-xs text-slate-400 font-normal ml-1">(per upload)</span>
                        </label>
                        <input type="number" min="0.1" max="10" step="0.1" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={orgForm.expense_proof_max_size_mb} onChange={e => setOrgForm({...orgForm, expense_proof_max_size_mb: parseFloat(e.target.value) || 2})} placeholder="2" />
                        <p className="mt-1 text-xs text-slate-400">Maximum allowed file size for expense proof uploads. Recommended: 2 MB.</p>
                      </div>
                    </div>
                </div>

                <div className="md:col-span-2 border-t pt-4 mt-2">
                    <label className="block text-sm font-bold text-slate-700 mb-2">Company Logo (Image)</label>
                    <div className="flex items-center gap-4">
                        <div className="h-16 w-16 border rounded flex items-center justify-center bg-slate-50 overflow-hidden">
                            {orgForm.logo ? <img src={orgForm.logo} alt="Logo" className="h-full w-full object-contain" /> : <Image className="text-slate-300"/>}
                        </div>
                        <input type="file" accept="image/*" onChange={handleLogoUpload} className="text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                    </div>
                </div>
            </div>
            <button onClick={handleSaveOrgSettings} className="mt-4 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">Save Organization Details</button>
       </div>

       {/* ===== COMMUNICATION (EMAIL / WHATSAPP) SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Mail size={20} /> Communication</h3>
            <p className="text-slate-500 text-sm mb-4">Configure outbound email so you can send invoices, quotes, payslips and reminders directly from the app. WhatsApp click-to-send works without any setup.</p>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Email Provider</label>
                <select className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.provider} onChange={e => setCommForm({ ...commForm, provider: e.target.value })}>
                  <option value="smtp">SMTP (Gmail / Zoho / any host)</option>
                  <option value="sendgrid">SendGrid (API key)</option>
                  <option value="resend">Resend (API key)</option>
                </select>
              </div>
              <div></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">From Name</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.from_name} onChange={e => setCommForm({ ...commForm, from_name: e.target.value })} placeholder="Your Company" /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">From Email</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.from_email} onChange={e => setCommForm({ ...commForm, from_email: e.target.value })} placeholder="billing@yourco.com" /></div>
              {commForm.provider === 'smtp' ? (
                <>
                  <div><label className="block text-sm font-bold text-slate-700 mb-1">SMTP Host</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.smtp_host} onChange={e => setCommForm({ ...commForm, smtp_host: e.target.value })} placeholder="smtp.gmail.com" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block text-sm font-bold text-slate-700 mb-1">Port</label><input type="number" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.smtp_port} onChange={e => setCommForm({ ...commForm, smtp_port: e.target.value })} placeholder="587" /></div>
                    <div className="flex items-end pb-2"><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={!!commForm.smtp_secure} onChange={e => setCommForm({ ...commForm, smtp_secure: e.target.checked })} /> SSL (465)</label></div>
                  </div>
                  <div><label className="block text-sm font-bold text-slate-700 mb-1">SMTP Username</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.smtp_user} onChange={e => setCommForm({ ...commForm, smtp_user: e.target.value })} placeholder="user@gmail.com" /></div>
                  <div><label className="block text-sm font-bold text-slate-700 mb-1">SMTP Password / App Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.smtp_pass} onChange={e => setCommForm({ ...commForm, smtp_pass: e.target.value })} placeholder="••••••••" autoComplete="new-password" /></div>
                </>
              ) : (
                <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">{commForm.provider === 'sendgrid' ? 'SendGrid' : 'Resend'} API Key</label><input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={commForm.api_key} onChange={e => setCommForm({ ...commForm, api_key: e.target.value })} placeholder="API key" autoComplete="new-password" /></div>
              )}
              <div className="md:col-span-2 mt-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700"><input type="checkbox" checked={!!commForm.reminders_enabled} onChange={e => setCommForm({ ...commForm, reminders_enabled: e.target.checked })} /> Send automatic overdue-invoice payment reminders</label>
                <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">Remind when an invoice is overdue by <input type="number" className="w-20 rounded border border-slate-300 p-1.5 bg-white text-black" value={commForm.reminder_overdue_days} onChange={e => setCommForm({ ...commForm, reminder_overdue_days: e.target.value })} /> days.</div>
              </div>
            </div>
            <button onClick={handleSaveCommunication} disabled={isSavingComm} className="mt-4 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:opacity-50">{isSavingComm ? 'Saving…' : 'Save Communication Settings'}</button>
       </div>

       {/* ===== PAYMENTS (RAZORPAY) SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><CreditCard size={20} /> Payment Gateway</h3>
            <p className="text-slate-500 text-sm mb-4">Generate Razorpay payment links from invoices; paid links auto-post a receipt via webhook. Keys live server-side only.</p>
            <div className="grid md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Provider</label><select className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={payForm.provider} onChange={e => setPayForm({ ...payForm, provider: e.target.value })}><option value="razorpay">Razorpay</option></select></div>
              <div></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Key ID</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={payForm.key_id} onChange={e => setPayForm({ ...payForm, key_id: e.target.value })} placeholder="rzp_live_..." /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Key Secret</label><input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={payForm.key_secret} onChange={e => setPayForm({ ...payForm, key_secret: e.target.value })} autoComplete="new-password" /></div>
              <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">Webhook Secret</label><input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={payForm.webhook_secret} onChange={e => setPayForm({ ...payForm, webhook_secret: e.target.value })} autoComplete="new-password" /></div>
            </div>
            <p className="mt-2 text-xs text-slate-400">Razorpay webhook URL: <code className="bg-slate-100 px-1 rounded">https://us-central1-{appId === 'TERMS 1.0.0' ? 'terms-a005e' : 'PROJECT'}.cloudfunctions.net/razorpayWebhook?appId={encodeURIComponent(appId)}</code> — subscribe to <b>payment_link.paid</b>.</p>
            <button onClick={handleSavePayments} disabled={isSavingPay} className="mt-3 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:opacity-50">{isSavingPay ? 'Saving…' : 'Save Payment Settings'}</button>
       </div>

       {/* ===== E-INVOICE (IRN) SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><FileCheck size={20} /> GST E-Invoice (IRN)</h3>
            <p className="text-slate-500 text-sm mb-4">Generate IRN + signed QR via your GSP once you cross the e-invoicing turnover threshold. Inert until enabled and credentials are set.</p>
            <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-3"><input type="checkbox" checked={!!einvForm.enabled} onChange={e => setEinvForm({ ...einvForm, enabled: e.target.checked })} /> Enable e-invoicing</label>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="md:col-span-2"><label className="block text-sm font-bold text-slate-700 mb-1">GSP Base URL</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={einvForm.gsp_base_url} onChange={e => setEinvForm({ ...einvForm, gsp_base_url: e.target.value })} placeholder="https://api.gsp-provider.com" /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Client ID</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={einvForm.client_id} onChange={e => setEinvForm({ ...einvForm, client_id: e.target.value })} /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Client Secret</label><input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={einvForm.client_secret} onChange={e => setEinvForm({ ...einvForm, client_secret: e.target.value })} autoComplete="new-password" /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">GST Portal Username</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={einvForm.username} onChange={e => setEinvForm({ ...einvForm, username: e.target.value })} /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">GST Portal Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={einvForm.password} onChange={e => setEinvForm({ ...einvForm, password: e.target.value })} autoComplete="new-password" /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">GSTIN</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={einvForm.gstin} onChange={e => setEinvForm({ ...einvForm, gstin: e.target.value })} /></div>
            </div>
            <button onClick={handleSaveEinvoice} disabled={isSavingEinv} className="mt-3 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:opacity-50">{isSavingEinv ? 'Saving…' : 'Save E-Invoice Settings'}</button>
       </div>

       {/* ===== CHAT / NOTIFICATIONS SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Bell size={20} /> Team Chat &amp; Notifications</h3>
            <p className="text-slate-500 text-sm mb-4">Turn on background push for Team Chat. Get the key from <span className="font-medium">Firebase Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair</span>, then paste the public key below. Chat works without it — only background notifications need it.</p>
            <div className="grid gap-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">FCM Web-Push key (VAPID public key)</label>
                <input className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={chatForm.fcm_vapid_key} onChange={e => setChatForm({ ...chatForm, fcm_vapid_key: e.target.value })} placeholder="BPx… long public key …" />
                <p className="text-xs text-slate-400 mt-1">{chatForm.fcm_vapid_key ? '✓ Configured — each person taps the 🔔 in Chat to enable it on their own device.' : 'Not set — background push is off (in-app chat still works).'}</p>
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700"><input type="checkbox" checked={chatForm.presence_enabled !== false} onChange={e => setChatForm({ ...chatForm, presence_enabled: e.target.checked })} /> Show online presence (green dots)</label>
                <p className="text-xs text-slate-400 mt-1 ml-6">Presence is the only thing that adds Firestore cost. Uncheck to run chat at near-zero cost.</p>
              </div>
            </div>
            <button onClick={handleSaveChat} disabled={isSavingChat} className="mt-3 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:opacity-50">{isSavingChat ? 'Saving…' : 'Save Chat Settings'}</button>
       </div>

       {/* ===== AI ASSISTANT SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><Sparkles size={20} /> AI Assistant (Virtual Accountant)</h3>
            <p className="text-slate-500 text-sm mb-4">Lets the accounting chat understand free-form and Hinglish messages the built-in rules can't. The AI only <span className="font-medium">drafts</span> entries — a person always reviews and posts. The API key is stored server-side and can never be read back from the app.</p>
            <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-3"><input type="checkbox" checked={!!aiForm.enabled} onChange={e => setAiForm({ ...aiForm, enabled: e.target.checked })} /> Enable AI assistance in the accounting chat</label>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Anthropic API key</label>
                <input type="password" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={aiForm.api_key} onChange={e => setAiForm({ ...aiForm, api_key: e.target.value })} placeholder={aiForm.api_key_set ? '•••• configured — type to replace' : 'sk-ant-…'} autoComplete="new-password" />
                <p className="text-xs text-slate-400 mt-1">
                  {aiForm.api_key_set ? '✓ A key is configured. Leave blank to keep it. ' : 'Get one from console.anthropic.com → API Keys.'}
                  {aiForm.api_key_set && (
                    <button onClick={handleClearAiKey} disabled={isSavingAi} className="text-red-500 hover:text-red-700 underline disabled:opacity-50">Remove key</button>
                  )}
                </p>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Model</label>
                <input list="ai-model-options" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={aiForm.model} onChange={e => setAiForm({ ...aiForm, model: e.target.value })} />
                <datalist id="ai-model-options">
                  <option value="claude-opus-4-8" />
                  <option value="claude-sonnet-4-6" />
                  <option value="claude-haiku-4-5" />
                </datalist>
                <p className="text-xs text-slate-400 mt-1">Default claude-opus-4-8 (most capable). Haiku is cheaper for simple entries.</p>
              </div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Monthly token budget</label><input type="number" min="20000" step="10000" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={aiForm.monthly_token_budget} onChange={e => setAiForm({ ...aiForm, monthly_token_budget: e.target.value })} /><p className="text-xs text-slate-400 mt-1">AI requests stop once this month's tokens are used up (simultaneous requests may overshoot slightly).</p></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Per-user requests / minute</label><input type="number" min="1" max="30" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={aiForm.per_user_rpm} onChange={e => setAiForm({ ...aiForm, per_user_rpm: e.target.value })} /></div>
            </div>
            {aiUsage && (
              <div className="mt-4 p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-sm font-semibold text-slate-700 mb-1">This month: {Number(aiUsage.tokens_total || 0).toLocaleString('en-IN')} / {Number(aiForm.monthly_token_budget || 0).toLocaleString('en-IN')} tokens · {Number(aiUsage.calls || 0)} requests</p>
                <div className="w-full h-2 bg-slate-200 rounded overflow-hidden">
                  <div className="h-2 bg-indigo-500" style={{ width: `${Math.min(100, Math.round((Number(aiUsage.tokens_total || 0) / Math.max(1, Number(aiForm.monthly_token_budget || 1))) * 100))}%` }} />
                </div>
              </div>
            )}
            <button onClick={handleSaveAi} disabled={isSavingAi} className="mt-3 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:opacity-50">{isSavingAi ? 'Saving…' : 'Save AI Settings'}</button>
       </div>

       {/* ===== LOCATION TRACKING SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-1 flex items-center gap-2 text-slate-800"><MapPin size={20} /> Location Tracking</h3>
            <p className="text-slate-500 text-sm mb-4">Track employees' live location <span className="font-medium">only while they are on duty</span> (checked in). Each person sees a "Sharing location" indicator while it's on. Works in the browser, the installed app, and the native app's foreground. Off by default.</p>
            <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-3"><input type="checkbox" checked={!!trackForm.enabled} onChange={e => setTrackForm({ ...trackForm, enabled: e.target.checked })} /> Enable location tracking (on-duty only)</label>
            <div className="grid md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Update every (seconds)</label><input type="number" min="15" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={trackForm.interval_seconds} onChange={e => setTrackForm({ ...trackForm, interval_seconds: e.target.value })} /></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">…or after moving (metres)</label><input type="number" min="0" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={trackForm.min_distance_m} onChange={e => setTrackForm({ ...trackForm, min_distance_m: e.target.value })} /></div>
              <div className="md:col-span-2"><label className="flex items-center gap-2 text-sm font-bold text-slate-700"><input type="checkbox" checked={trackForm.history_enabled !== false} onChange={e => setTrackForm({ ...trackForm, history_enabled: e.target.checked })} /> Keep location history / trails</label></div>
              <div><label className="block text-sm font-bold text-slate-700 mb-1">Delete history older than (days)</label><input type="number" min="1" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={trackForm.history_retention_days} onChange={e => setTrackForm({ ...trackForm, history_retention_days: e.target.value })} /></div>
            </div>
            <p className="text-xs text-slate-400 mt-2">Lower interval / distance = more frequent updates (more battery + cost). History is auto-pruned daily.</p>
            <button onClick={handleSaveTracking} disabled={isSavingTrack} className="mt-3 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:opacity-50">{isSavingTrack ? 'Saving…' : 'Save Tracking Settings'}</button>
       </div>

       {/* ===== BANK ACCOUNTS SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><CreditCard size={20} /> Bank Account Details</h3>
            <p className="text-sm text-slate-500 mb-4">Add your company bank accounts. The default account will be shown on Proforma Invoices.</p>

            {bankAccounts.length > 0 ? (
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm border border-slate-200 rounded-lg">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-left p-3 text-slate-600 font-semibold">Bank Name</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">Account Name</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">Account No.</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">IFSC</th>
                      <th className="text-left p-3 text-slate-600 font-semibold">Branch</th>
                      <th className="text-center p-3 text-slate-600 font-semibold">Default</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {bankAccounts.map(bank => (
                      <tr key={bank.id} className={`hover:bg-slate-50 transition ${bank.id === defaultBankId ? 'bg-green-50' : ''}`}>
                        <td className="p-3 font-medium text-slate-800">{bank.bank_name}</td>
                        <td className="p-3 text-slate-700">{bank.account_name}</td>
                        <td className="p-3 font-mono text-slate-700">{bank.account_no}</td>
                        <td className="p-3 font-mono text-slate-700">{bank.ifsc}</td>
                        <td className="p-3 text-slate-600">{bank.branch || '—'}</td>
                        <td className="p-3 text-center">
                          {bank.id === defaultBankId ? (
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs font-semibold"><CheckCircle size={14}/> Default</span>
                          ) : (
                            <button onClick={() => setDefaultBankId(bank.id)} className="text-xs text-slate-500 hover:text-indigo-600 underline">Set Default</button>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => handleEditBank(bank)} className="p-1.5 rounded hover:bg-blue-50 text-blue-500" title="Edit"><Edit size={14}/></button>
                            <button onClick={() => handleDeleteBank(bank.id)} className="p-1.5 rounded hover:bg-red-50 text-red-400" title="Delete"><Trash2 size={14}/></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-sm text-slate-400 italic mb-4 p-4 bg-slate-50 rounded-lg border border-dashed border-slate-200">No bank accounts added yet.</div>
            )}

            {showBankForm ? (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mt-2">
                <div className="font-semibold text-slate-700 mb-3">{editingBankId ? 'Edit Bank Account' : 'Add New Bank Account'}</div>
                <div className="grid md:grid-cols-2 gap-3">
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Bank Name *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.bank_name} onChange={e=>setBankForm({...bankForm,bank_name:e.target.value})} placeholder="e.g. HDFC Bank" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Account Name *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.account_name} onChange={e=>setBankForm({...bankForm,account_name:e.target.value})} placeholder="Name as per bank records" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Account Number *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm font-mono" value={bankForm.account_no} onChange={e=>setBankForm({...bankForm,account_no:e.target.value})} placeholder="Account number" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">IFSC Code *</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm font-mono uppercase" value={bankForm.ifsc} onChange={e=>setBankForm({...bankForm,ifsc:e.target.value.toUpperCase()})} placeholder="e.g. HDFC0001234" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">Branch</label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.branch} onChange={e=>setBankForm({...bankForm,branch:e.target.value})} placeholder="Branch name" /></div>
                  <div><label className="text-xs font-bold text-slate-600 mb-1 block">UPI ID <span className="text-slate-400 font-normal">(optional)</span></label><input className="w-full rounded border border-slate-300 p-2 bg-white text-black text-sm" value={bankForm.upi_id} onChange={e=>setBankForm({...bankForm,upi_id:e.target.value})} placeholder="optional@upi" /></div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={handleAddOrUpdateBank} className="bg-indigo-600 text-white px-4 py-2 rounded text-sm hover:bg-indigo-700">{editingBankId ? 'Update Bank' : 'Add Bank'}</button>
                  <button onClick={() => { setShowBankForm(false); setEditingBankId(null); setBankForm({ bank_name:'',account_name:'',account_no:'',ifsc:'',branch:'',upi_id:'' }); }} className="px-4 py-2 rounded border text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowBankForm(true)} className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800 font-medium mb-2"><Plus size={15}/> Add Bank Account</button>
            )}

            <button onClick={handleSaveBankSettings} className="mt-4 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">Save Bank Settings</button>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Calendar size={20} /> Calendar Color Settings</h3>
            <div className="grid md:grid-cols-2 gap-4">
                {CALENDAR_STATUS_OPTIONS.map(status => (
                  <div key={status} className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-slate-700">{status} band</div>
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-5 rounded border border-slate-200" style={{ backgroundColor: calendarColors.statusColors[status] }}></div>
                      <input
                        type="color"
                        className="h-8 w-10 rounded border border-slate-200"
                        value={calendarColors.statusColors[status]}
                        onChange={(e) =>
                          setCalendarColors(prev => ({
                            ...prev,
                            statusColors: { ...prev.statusColors, [status]: e.target.value }
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
            </div>
            <div className="mt-6">
              <div className="text-sm font-semibold text-slate-700 mb-2">Closed Invoice Text Color</div>
              <div className="grid md:grid-cols-2 gap-4">
                {CALENDAR_INVOICE_OPTIONS.map(status => (
                  <div key={status} className="flex items-center justify-between gap-3">
                    <div className="text-sm text-slate-700">{status}</div>
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-5 rounded border border-slate-200 bg-slate-100" style={{ color: calendarColors.invoiceTextColors[status] || '#ffffff' }}>A</div>
                      <input
                        type="text"
                        className="w-28 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700"
                        placeholder="#RRGGBB (optional)"
                        value={calendarColors.invoiceTextColors[status]}
                        onChange={(e) =>
                          setCalendarColors(prev => ({
                            ...prev,
                            invoiceTextColors: { ...prev.invoiceTextColors, [status]: e.target.value }
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-xs text-slate-500">Applied only when status is Closed. Leave blank to keep default text color.</div>
            </div>
            <div className="mt-4">
              <button onClick={handleSaveCalendarColors} disabled={isSavingCalendarColors} className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {isSavingCalendarColors ? 'Saving...' : 'Save Calendar Colors'}
              </button>
            </div>
       </div>

       {/* ===== FY LOCK SECTION ===== */}
       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><LockKeyhole size={20} /> Financial Year Lock</h3>
            <p className="text-sm text-slate-500 mb-4">Lock past financial years to prevent adding, editing, or deleting transactions. Locked FYs are enforced across Finance, Expenses, and other modules.</p>
            <div className="space-y-2">
              {generateFYOptions().map(fy => {
                const isLocked = lockedFYs.includes(fy);
                const isCurrent = fy === getFinancialYear();
                return (
                  <div key={fy} className={`flex items-center justify-between p-3 rounded-lg border ${isLocked ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="flex items-center gap-3">
                      {isLocked ? <Lock size={16} className="text-red-500" /> : <Unlock size={16} className="text-green-500" />}
                      <span className="font-medium text-slate-800">FY {fy}</span>
                      {isCurrent && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Current</span>}
                    </div>
                    <button
                      onClick={() => handleToggleFYLock(fy)}
                      className={`px-3 py-1.5 rounded text-xs font-bold transition ${isLocked ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-red-600 text-white hover:bg-red-700'}`}
                    >
                      {isLocked ? 'Unlock' : 'Lock'}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button onClick={handleSaveFYLock} disabled={isSavingFYLock} className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {isSavingFYLock ? 'Saving...' : 'Save FY Lock Settings'}
              </button>
              {lockedFYs.length > 0 && <span className="text-xs text-slate-500">{lockedFYs.length} FY(s) locked</span>}
            </div>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Shield size={20} /> Admin Security</h3>
            <div className="grid md:grid-cols-2 gap-4 max-w-2xl">
                <div><label className="block text-sm font-bold text-slate-700 mb-1">New Admin Password</label><input type="text" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={securityForm.admin_password} onChange={e => setSecurityForm({...securityForm, admin_password: e.target.value})} placeholder="Set new password" /></div>
                <div><label className="block text-sm font-bold text-slate-700 mb-1">Recovery Key</label><input type="text" className="w-full rounded border border-slate-300 p-2 bg-white text-black" value={securityForm.recovery_key} onChange={e => setSecurityForm({...securityForm, recovery_key: e.target.value})} placeholder="Key to reset password" /></div>
            </div>
            <button onClick={handleUpdateSecurity} className="mt-4 bg-slate-800 text-white px-6 py-2 rounded hover:bg-slate-700">Update Credentials</button>
       </div>
       </>}

      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm(prev => ({ ...prev, isOpen: false }))}
        onConfirm={deleteConfirm.onConfirm}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        requireTyped={false}
      />
    </div>
  );
};

export default AdminTools;
