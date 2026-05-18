# Rental-Ops Security Audit Report and Remediation Plan

Date: 2026-05-18
Scope: Application RBAC, Firestore and Storage rules, auth flow, public-link surfaces, role-based UI visibility, and external threat exposure.

## 1) Executive Summary

Current security posture is high risk. UI permission checks have improved in some areas (for example, project financial masking for non-finance roles), but backend authorization is still permissive enough that authenticated users can read or modify data far beyond intended role boundaries.

Top risks:
1. Firestore rules contain a broad collection wildcard that permits create/update for most collections to any authenticated user.
2. Role escalation is possible through self-writable role mirror documents.
3. Storage rules allow read and write for all authenticated users on all paths.
4. Sensitive secrets and database backups are present in the repository.
5. Data over-fetching in the app loads cross-role sensitive datasets into client memory.

Business impact:
- Confidential data leakage (employee PII, finance, tokens, proofs)
- Integrity loss (unauthorized edits to projects/settings/audit logs)
- Privilege escalation to owner-level actions
- Compliance and legal risk from exposed identity documents and credentials

## 2) Evidence Snapshot

Key evidence from current codebase:
1. Firestore broad authenticated read for all collections under app data: firestore.rules line 70.
2. Firestore broad create/update fallback to authenticated users for non-finance collections: firestore.rules lines 78 and 107.
3. Specific collection protections (audit logs, settings, employees, users) can be bypassed due overlapping broad rule scope:
   - audit logs: firestore.rules lines 122-125
   - settings: firestore.rules lines 138-140
   - employees: firestore.rules lines 145-150
   - users mirror self-write: firestore.rules lines 156-158
4. Role lookup prioritizes users mirror role data: firestore.rules lines 29-31.
5. Storage globally open to all authenticated users:
   - storage.rules lines 4-5.
6. Anonymous auth bootstrap enabled:
   - src/App.jsx line 2993
   - src/App.jsx line 3003
7. Client-side login verification with fallback defaults:
   - admin default fallback: src/App.jsx lines 3230 and 3235
   - employee default fallback: src/App.jsx line 3280
8. Broad cross-collection listeners loaded after login regardless of least privilege:
   - src/App.jsx lines 3024, 3033-3045.
9. Data Portal route protected by audit_logs permission, not admin_tools:
   - src/App.jsx line 3707
   - audit_logs includes accountant in RBAC matrix: src/utils/permissions.js line 134
10. Employees module currently visible to all defined roles in permissions matrix:
   - src/utils/permissions.js line 84
11. Employees page exposes broad identity details and administrative actions in one screen:
   - Add Employee button: src/pages/Employees.jsx line 460
   - Edit and password actions: src/pages/Employees.jsx lines 489-490
   - ID/Address proof indicators: src/pages/Employees.jsx lines 484-485
12. Profile page is present but does not include self-service photo or proof upload fields:
   - src/pages/ProfileSettings.jsx lines 6, 61-63, 69.
13. Default app landing redirects all users to dashboard, not profile-first for non-owner users:
   - src/App.jsx route root line 3688.
14. Public token pages are routed before authenticated app shell:
   - src/App.jsx lines 3374-3401.
15. Public ledger page loads full collections then filters client-side:
   - src/pages/PublicLedger.jsx lines 54-59.
16. Repository contains a service account credential and backup datasets:
   - service-account.json
   - firestore-backup-2026-05-01/*.json

## 3) Severity-Ranked Findings

### Critical

1. Authorization bypass via broad wildcard Firestore rule
- Root cause: overlapping broad match grants create/update for non-finance collections to any authenticated user.
- Risk: unauthorized changes to settings, users mirror, employees, clients, projects, and potentially audit logs.
- Priority: immediate.

2. Privilege escalation through role mirror self-write
- Root cause: users mirror allows self create/update without role field constraints.
- Combined with userRole precedence, this can grant elevated role decisions in rules.
- Priority: immediate.

3. Global Storage read/write for any authenticated user
- Root cause: all paths are open under one broad rule.
- Risk: unauthorized read, overwrite, deletion, and malicious file upload.
- Priority: immediate.

4. Secret exposure in repository
- Root cause: committed service account private key and exported database backups.
- Risk: full backend compromise if key is still active; offline PII exposure from backups.
- Priority: immediate.

### High

5. Client-side authentication checks with default fallback credentials
- Root cause: login validation performed in client against employee/settings data with default fallback strings.
- Risk: weak control boundary and credential attack surface.

6. Cross-role data over-fetching into client memory
- Root cause: listeners pull many collections for all logged roles.
- Risk: data exposure if UI checks fail or if user inspects local state/network payloads.

7. Data Portal route permission mismatch
- Root cause: route uses audit_logs permission while export is not owner-guarded.
- Risk: broader than intended dataset export access.

### Medium

8. Profile workflow incomplete for non-owner users
- Root cause: profile page lacks self-service photo and ID/address proof management.
- Risk: user confusion, overuse of employee-admin page, unnecessary data exposure.

9. Auditor role is requested but not operationally defined
- Root cause: no active auditor role in central permission model.
- Risk: inconsistent expectations and ad-hoc access grants.

## 4) Role Visibility and Access Target Model

Target role model requested:
1. Owner (admin): full access.
2. Management (manager): operations + controlled finance visibility, no owner-only security controls.
3. Accountant: finance/accounting/reporting, no HR identity document administration.
4. Field Tech: project operational details only, no costs/revenue, no all-employee view.
5. User (general): own profile and own submissions only.
6. Auditor: read-only compliance, finance reports and logs, no operational mutations.

Minimum section visibility target:
1. Owner and Management
- Full module menu with role-appropriate write controls.
2. Accountant
- Finance, accounting, tax/purchase invoices, reports, restricted audit views.
3. Field Tech and User
- Default landing to profile.
- Visible sections only: profile, own projects/tasks, own expenses, own HR portal, own docs.
- Hide admin, finance, employee directory, and non-required operational modules.
4. Auditor
- Read-only dashboards, audit logs, finance summaries, export-limited and time-scoped.

## 5) Non-Owner Profile-First UX Plan

Goal requested: for users other than owner/admin, show personal details page instead of admin-style sections.

Implementation direction:
1. Role-aware default route
- Non-owner users should land at /profile (or /hr/portal for tech if preferred).
- Keep /dashboard for owner/management/accountant/auditor.

2. Role-scoped navigation packs
- Build explicit nav bundles per role.
- Remove employees/admin modules from tech/user nav entirely.

3. Expand profile page to include self-service identity details
- Contact and password already present.
- Add photo upload, ID proof upload, address proof upload (self only).
- Add visibility for statement link or personal records where appropriate.

4. Employees page repurpose
- Keep full employees directory and role management for owner/management only.
- For non-owner roles, route away to profile.

## 6) External Threat Model

Threat categories and realistic paths:
1. Credential compromise
- Exposed service account key and client-side credential checks.
2. Authenticated insider misuse
- Overly broad Firestore and Storage permissions.
3. Token abuse
- Ledger and quote tokens stored in readable documents; token links can be reused if leaked.
4. Data exfiltration
- Large export surfaces and broad listener hydration.
5. Integrity tampering
- Unauthorized update pathways through permissive rules.

## 7) Phased Remediation Plan

### Phase 0 (Emergency, 0-24 hours)
1. Rotate and revoke exposed service account keys immediately.
2. Remove service-account.json and backup JSON datasets from repository history and working tree.
3. Disable broad Storage rule and replace with deny-all temporary fallback except emergency owner paths.
4. Tighten Firestore by removing or temporarily disabling broad authenticated create/update path.
5. Disable anonymous sign-in for internal app path unless absolutely needed for public pages.

### Phase 1 (Hardening, 1-3 days)
1. Rewrite Firestore rules with explicit collection-level least privilege, no broad fallback writes.
2. Constrain users mirror writes:
- Allow only controlled fields, deny role changes by self.
3. Restrict settings/security doc read/write to owner only.
4. Enforce immutable audit logs by removing overlapping permissive matches.
5. Lock employees read to owner/manager/accountant only, and self-read for individual employee profile.

### Phase 2 (Access model and data minimization, 3-7 days)
1. Split listeners by role and fetch only required collections.
2. Correct Data Portal route guard to admin_tools and enforce owner check for export/import actions.
3. Add auditor role in permissions model with read-only scope.
4. Make non-owner default route profile-first.
5. Restrict employee management UI to owner/management.

### Phase 3 (Profile self-service and document security, 1-2 weeks)
1. Add secure file upload in profile page for own photo/ID/address proofs.
2. Move proof storage into employee-scoped Storage paths.
3. Add path-based Storage rules to enforce self read/write and owner/manager read.
4. Add content-type and size validation for uploads.

### Phase 4 (Public-link and API security, 1-3 weeks)
1. Move public token validation to server-side callable/HTTP endpoints with narrow data projection.
2. Store hashed tokens and compare hashed incoming token values.
3. Add token rotation, expiry, revocation, and access logs.
4. Apply per-token rate limits and anti-automation controls.

## 8) Role-by-Role Controls Matrix (Target)

1. Owner
- Full read/write, user and security administration, rule and config governance.
2. Management
- Operational write access, limited finance writes, no owner-secret administration.
3. Accountant
- Finance and compliance write scopes only, no employee credential or role controls.
4. Field Tech
- Project operational read and own expense submit; no finance rates or HR-admin pages.
5. User
- Own profile, own records only.
6. Auditor
- Read-only compliance and finance reports, no writes.

## 9) Verification and Audit Test Plan

1. Rule-level tests
- Positive and negative Firestore rule tests for each role and collection action.
2. UI tests
- Route and nav visibility tests per role.
3. Data-minimization checks
- Verify network payload does not include unauthorized collections per role.
4. Public link tests
- Expired, revoked, malformed, replayed token behavior.
5. Storage tests
- Confirm unauthorized path reads and writes are denied.

## 10) Immediate Action Checklist for Leadership

1. Revoke service account keys and rotate all affected secrets.
2. Remove sensitive repository artifacts and force secret scanning.
3. Patch Firestore and Storage rules to least privilege.
4. Freeze risky export/share features until rule hardening is complete.
5. Approve profile-first UX rollout for non-owner roles.
6. Schedule independent rule validation before next production release.

## 11) Proposed Implementation File Touch List

1. firestore.rules
- Remove broad wildcard write fallback and redesign explicit per-collection policy.
2. storage.rules
- Replace global authenticated access with scoped path rules.
3. src/App.jsx
- Role-scoped data listeners, default route changes, route guard corrections.
4. src/utils/permissions.js
- Add auditor role and finalize role bundles.
5. src/pages/ProfileSettings.jsx
- Add photo and proof upload flows.
6. src/pages/Employees.jsx
- Restrict for owner/management and remove broad non-owner visibility.
7. src/pages/DataPortal.jsx
- Owner-only export/import enforcement.
8. functions/index.js
- Strengthen admin assertion using trusted claims and tenant constraints.

## 12) Notes on Current Good Direction

1. Project-level financial masking has been introduced in current project module updates.
2. Some owner-only and manager-only checks exist in UI handlers.
3. Password hashing migration logic exists, but boundary must move server-side for trust.

---

This report is an assessment and remediation plan only. No hardening patches were applied in this document step.
