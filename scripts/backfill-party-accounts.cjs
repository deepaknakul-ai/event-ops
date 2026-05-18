#!/usr/bin/env node
/**
 * M-5 Phase 4 — Backfill party_accounts collection.
 *
 * What it does:
 *   1. Reads all clients / vendors / employees → upserts party_accounts/{id}
 *   2. Reads opening_balances → sets party_id on rows where account_name matches
 *      a known "Party: <name>" pattern (FY-rollover snapshots reference name only).
 *   3. Reads journal_entries (manual) → sets account_id on line items where the
 *      debit/credit account starts with "Party:" or "Employee:".
 *
 * Flags:
 *   --dry-run   Log what would be written without touching Firestore.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to service-account JSON, OR
 *     run from a machine already authenticated with ADC (gcloud auth application-default login).
 *   - firebase-admin must be installed at the project root (npm install firebase-admin).
 *
 * Usage:
 *   node scripts/backfill-party-accounts.js [--dry-run]
 */

'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ── CLI flags ──────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const APP_ID = 'TERMS 1.0.0';
const BATCH_LIMIT = 200;
const LOG_FILE = path.join(__dirname, `backfill-rollback-${new Date().toISOString().slice(0, 10)}.json`);

// ── Init ───────────────────────────────────────────────────────────────────────
if (admin.apps.length === 0) {
  admin.initializeApp();
}
const db = admin.firestore();

// ── Helpers ────────────────────────────────────────────────────────────────────
const colPath = (...segments) => ['artifacts', APP_ID, 'public', 'data', ...segments].join('/');

async function getDocs(collectionName) {
  const snap = await db.collection(colPath(collectionName)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const rollbackLog = [];
function logRollback(op) {
  rollbackLog.push(op);
}
function flushRollback() {
  if (rollbackLog.length === 0) return;
  fs.writeFileSync(LOG_FILE, JSON.stringify(rollbackLog, null, 2));
  console.log(`Rollback log written to ${LOG_FILE}`);
}

async function commitBatch(batch) {
  if (!DRY_RUN) await batch.commit();
}

// ── Phase 1: upsert party_accounts from clients + employees ───────────────────
async function backfillPartyAccounts(clients, employees) {
  console.log('\n── Phase 1: backfill party_accounts ──────────────────────────────────────');
  let batch = db.batch();
  let count = 0;
  let batchCount = 0;

  async function flush() {
    if (count === 0) return;
    console.log(`  committing batch of ${count} ops (${DRY_RUN ? 'DRY RUN' : 'WRITE'})`);
    await commitBatch(batch);
    batch = db.batch();
    batchCount += count;
    count = 0;
  }

  const rows = [
    ...clients.map((c) => ({ id: c.id, type: c.type === 'Vendor' ? 'vendor' : 'client', name: c.name })),
    ...employees.map((e) => ({ id: e.id, type: 'employee', name: e.name })),
  ].filter((r) => r.id && r.name);

  const partyCol = colPath('party_accounts');

  for (const row of rows) {
    const ref = db.doc(`${partyCol}/${row.id}`);
    const existing = await ref.get();

    if (!existing.exists) {
      const docData = {
        entity_id: row.id,
        entity_type: row.type,
        current_name: row.name,
        aliases: [],
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };
      console.log(`  [CREATE] party_accounts/${row.id}  name="${row.name}"  type=${row.type}`);
      logRollback({ op: 'delete', path: `${partyCol}/${row.id}` });
      if (!DRY_RUN) batch.set(ref, docData);
      count++;
    } else {
      const data = existing.data();
      if (data.current_name !== row.name) {
        console.log(`  [RENAME] party_accounts/${row.id}  "${data.current_name}" → "${row.name}"`);
        logRollback({ op: 'restore_name', path: `${partyCol}/${row.id}`, old: data.current_name });
        if (!DRY_RUN) {
          batch.update(ref, {
            current_name: row.name,
            aliases: admin.firestore.FieldValue.arrayUnion(data.current_name),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        count++;
      }
    }

    if (count >= BATCH_LIMIT) await flush();
  }
  await flush();
  console.log(`  total ${DRY_RUN ? '(dry-run) would write' : 'wrote'} ${batchCount} party_account docs`);
}

// ── Phase 2: patch opening_balances with party_id ────────────────────────────
async function backfillOpeningBalances(partyByName) {
  console.log('\n── Phase 2: patch opening_balances ───────────────────────────────────────');
  const docs = await getDocs('opening_balances');
  let batch = db.batch();
  let count = 0;
  let batchCount = 0;

  async function flush() {
    if (count === 0) return;
    console.log(`  committing batch of ${count} ops (${DRY_RUN ? 'DRY RUN' : 'WRITE'})`);
    await commitBatch(batch);
    batch = db.batch();
    batchCount += count;
    count = 0;
  }

  for (const docSnap of docs) {
    const lines = Array.isArray(docSnap.lines) ? docSnap.lines : [];
    let changed = false;
    const newLines = lines.map((line) => {
      // Only patch lines that lack party_id AND have a name-based account.
      if (line.party_id) return line;
      const account = line.account_name || line.account || '';
      const match = account.match(/^Party:\s*(.+)$/);
      if (!match) return line;
      const name = match[1].trim();
      const party = partyByName[name.toLowerCase()];
      if (!party) return line;
      changed = true;
      console.log(`  [PATCH] opening_balances/${docSnap.id} line "${account}" → party_id=${party.entity_id}`);
      return { ...line, party_id: party.entity_id };
    });

    if (changed) {
      const ref = db.doc(`${colPath('opening_balances')}/${docSnap.id}`);
      logRollback({ op: 'restore_lines', path: `${colPath('opening_balances')}/${docSnap.id}`, old: lines });
      if (!DRY_RUN) batch.update(ref, { lines: newLines });
      count++;
    }
    if (count >= BATCH_LIMIT) await flush();
  }
  await flush();
  console.log(`  total ${DRY_RUN ? '(dry-run) would write' : 'wrote'} ${batchCount} opening_balance docs`);
}

// ── Phase 3: patch manual journal_entries with account_id ────────────────────
async function backfillJournalEntries(partyByName) {
  console.log('\n── Phase 3: patch journal_entries ────────────────────────────────────────');
  const docs = await getDocs('journal_entries');
  let batch = db.batch();
  let count = 0;
  let batchCount = 0;

  async function flush() {
    if (count === 0) return;
    console.log(`  committing batch of ${count} ops (${DRY_RUN ? 'DRY RUN' : 'WRITE'})`);
    await commitBatch(batch);
    batch = db.batch();
    batchCount += count;
    count = 0;
  }

  function patchAccount(account, accountId) {
    if (accountId) return accountId; // already set
    const match = (account || '').match(/^Party:\s*(.+)$/i) || (account || '').match(/^Employee:\s*(.+)$/i);
    if (!match) return null;
    const name = match[1].trim();
    const party = partyByName[name.toLowerCase()];
    return party ? party.entity_id : null;
  }

  for (const docSnap of docs) {
    const lines = Array.isArray(docSnap.lines) ? docSnap.lines : [];
    let changed = false;
    const newLines = lines.map((line) => {
      const newDebitId = patchAccount(line.debit_account || line.debitAccount, line.debit_account_id || line.debitAccountId);
      const newCreditId = patchAccount(line.credit_account || line.creditAccount, line.credit_account_id || line.creditAccountId);
      if (!newDebitId && !newCreditId) return line;
      changed = true;
      return {
        ...line,
        ...(newDebitId ? { debit_account_id: newDebitId } : {}),
        ...(newCreditId ? { credit_account_id: newCreditId } : {}),
      };
    });

    if (changed) {
      console.log(`  [PATCH] journal_entries/${docSnap.id}`);
      const ref = db.doc(`${colPath('journal_entries')}/${docSnap.id}`);
      logRollback({ op: 'restore_lines', path: `${colPath('journal_entries')}/${docSnap.id}`, old: lines });
      if (!DRY_RUN) batch.update(ref, { lines: newLines });
      count++;
    }
    if (count >= BATCH_LIMIT) await flush();
  }
  await flush();
  console.log(`  total ${DRY_RUN ? '(dry-run) would write' : 'wrote'} ${batchCount} journal_entry docs`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nBackfill party_accounts — ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE WRITE'}`);
  console.log(`App ID: ${APP_ID}`);

  const [clients, employees] = await Promise.all([getDocs('clients'), getDocs('employees')]);
  console.log(`  Loaded ${clients.length} clients, ${employees.length} employees`);

  await backfillPartyAccounts(clients, employees);

  // Build name→party map for phase 2+3.
  const partySnap = await db.collection(colPath('party_accounts')).get();
  const partyByName = {};
  partySnap.docs.forEach((d) => {
    const data = d.data();
    if (data.current_name) partyByName[data.current_name.toLowerCase()] = data;
    (data.aliases || []).forEach((a) => {
      partyByName[a.toLowerCase()] = data;
    });
  });

  await backfillOpeningBalances(partyByName);
  await backfillJournalEntries(partyByName);

  flushRollback();
  console.log('\nDone.\n');
})().catch((err) => {
  console.error('Backfill failed:', err);
  flushRollback();
  process.exit(1);
});
