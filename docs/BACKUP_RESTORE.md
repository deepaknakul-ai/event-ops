# Backup & Restore

How full-system backup and restore works after the v2 overhaul, and the
infrastructure-level protection that should sit underneath it.

## Why it was rebuilt

The audit (July 2026) found three overlapping mechanisms — Admin > Backup
(9 collections), Data Portal (15), `scripts/backup-firestore.cjs` (18) — that
together covered 21 of 46 live collections, none of which could actually
restore: security rules deny client writes to `project_financials` (all the
project money) and `ai_usage` entirely, deny updates to `audit_logs` /
`inventory_movements` / `location_history`, self-scope the chat and location
collections, and deadlock role resolution on an empty database. All three
also corrupted every Firestore `Timestamp` through raw `JSON.stringify`.

## Architecture (v2)

Two admin-only callables in `functions/index.js`, codec in
`functions/backup.js`, UI in Admin > System > Backup/Restore
(`src/pages/AdminTools.jsx`):

- **`adminExportData`** — no `collection` arg: returns every collection name
  via `listCollections()` (auto-discovery — new collections can never be
  silently missing). With `collection` + `cursor`: returns one page of ≤500
  docs, codec-encoded, with configured subcollections embedded
  (`chat_channels/*/messages`).
- **`adminRestoreData`** — `{wipe: true}`: recursive-deletes one collection
  (exact-snapshot mode). `{docs: [...]}`: batch-writes ≤500 docs.
  `{registerApp: true}` (first call): re-registers the tenant in
  `meta/active_apps` so scheduled functions pick it up after a restore into a
  fresh project.

Both run with the Admin SDK, so every rules restriction that made client-side
restore impossible is bypassed; access is gated by `assertAdmin` instead.

### Codec

Firestore native types are tagged so they survive JSON:

| Type | Encoded |
|---|---|
| `Timestamp` | `{ "__t": "ts", "s": seconds, "n": nanoseconds }` |
| Bytes/Buffer | `{ "__t": "bytes", "b64": … }` |
| `DocumentReference` | `{ "__t": "ref", "p": path }` |

Untagged values pass through unchanged, which is how legacy backup files
(whose timestamps were already degraded to plain maps) still import.
Round-trip coverage: `tests/backup-codec.test.js`.

### File format (v2)

```json
{
  "_meta": { "format": "terms-backup", "version": 2, "exported_at": "…",
             "app_id": "…", "collections": [...], "counts": {...} },
  "data": { "<collection>": [ { "id": "…", "d": { …encoded fields… },
                                "s": { "messages": [ … ] } } ] }
}
```

The restore UI also accepts both legacy formats (old Admin backup keyed by
`id`, Data Portal export keyed by `_id`) — records without IDs are counted
and skipped, never duplicated.

### Restore modes

- **Overwrite** (default) — file docs replace matching IDs wholesale (no
  merge); records created after the backup are kept.
- **Exact snapshot** — each collection present in the file is recursively
  wiped first, then written. Records created after the backup are deleted.
  Collections *not* in the file are untouched.

Identity collections (`employees`, `users`, `userRoles`, `settings`) restore
first so logins and role checks work even if a later collection fails.
Failures are reported per collection; one failed collection doesn't abort the
rest.

### Push-notification guard

Restoring chat messages re-fires `onChatMessageCreated`. The trigger now
skips messages whose `created_at` is older than 10 minutes, so a restore
cannot blast historical push notifications at every employee.

## What is NOT covered

- **Storage files** — expense proofs, purchase-invoice scans, project
  attachments, chat uploads, org logo. The backup preserves only their URLs.
  Cover via bucket-level copy (below) until an app-level Storage manifest is
  built.
- **Cross-tenant data** — the backup is per `appId`. `meta/active_apps` is
  re-registered on restore but not exported.

## Infrastructure layer (do this once)

App-level backups guard against bad data; these guard against project loss.
Requires the Blaze plan and `gcloud` authenticated to project `terms-a005e`.

```bash
# 1. Point-in-time recovery (7-day version history)
gcloud firestore databases update --database='(default)' \
  --enable-pitr --project=terms-a005e

# 2. Daily managed backups with retention (server-side, no code)
gcloud firestore backups schedules create --database='(default)' \
  --recurrence=daily --retention=7d --project=terms-a005e

# 3. Storage bucket sync (run on a schedule, or manually before risky work)
#    Default bucket is terms-a005e.appspot.com or terms-a005e.firebasestorage.app
#    — check `firebase storage:bucket` or the console.
gsutil -m rsync -r gs://terms-a005e.appspot.com gs://YOUR-BACKUP-BUCKET
```

Restore from a managed backup:
`gcloud firestore databases restore --source-backup=... --destination-database=...`
(restores into a *new* database; see Firestore docs).

## Runbooks

**Routine backup:** Admin > System tab > Download Full Backup. Store the file
off-site; it contains credential hashes and all financial data.

**Undo bad data (same project):** Restore the file in *Overwrite* mode, or
*Exact snapshot* if unwanted new records must also disappear.

**Disaster recovery into a fresh Firebase project:**
1. Deploy the app, rules and functions to the new project.
2. Sign in — on an empty project use the bootstrap/owner flow; the restoring
   user must be able to pass `assertAdmin` (custom-token `role: admin` claim
   from `verifyLogin`, or a seeded `employees/{uid}`/`userRoles/{uid}` doc
   with `role: 'admin'`).
3. Restore the backup file (identity collections write first; the first call
   re-registers the tenant in `meta/active_apps`).
4. Copy Storage files back with `gsutil rsync` if you have a bucket copy.
5. Verify: invoice numbering (`counters`), locked FYs (`settings`), a project
   P&L (project_financials), and chat history.

**Deploying this feature:**
```bash
firebase deploy --only functions:adminExportData,functions:adminRestoreData,functions:onChatMessageCreated
```

## Legacy tools

- `scripts/backup-firestore.cjs` — still useful as an offline/emergency
  export (service-account auth, no deployed functions needed), but it has no
  restore path and no Timestamp codec. Prefer the Admin UI.
- Data Portal — kept for selective per-collection migration/seeding between
  environments. Its import is client-SDK and remains subject to rules; its
  dialog now states the real merge semantics.
