# Admin Password — Setup & Recovery Guide

## Overview

Admin credentials are stored in the Firestore document:
```
artifacts/TERMS 1.0.0/public/data/settings/security
```

| Field | Description |
|-------|-------------|
| `admin_password` | PBKDF2-hashed password (`v2:saltHex:hashHex`) |
| `password_hashed` | `true` once the password has been hashed (set automatically) |
| `recovery_key` | Plain-text secret used to authorise a password reset |

Passwords are hashed with **PBKDF2-SHA-256** (200,000 iterations, 16-byte random salt). Legacy SHA-256 and plaintext passwords are accepted on login and automatically upgraded to PBKDF2 on the first successful sign-in.

---

## 1. First-Time Setup (fresh installation)

1. Open the app in a browser and go to the login screen.
2. Click **Admin Recovery** (bottom-right of the login form).
3. The app checks Firestore. Because no security document exists yet, the modal opens in **bootstrap mode** (amber banner: *"No admin account found"*).
4. Enter:
   - **New Admin Password** — choose a strong password.
   - **Recovery Key** — a separate secret phrase used only to reset the password. **Store this somewhere safe** (password manager, printed note in a secure location). It cannot be recovered if lost.
5. Click **Initialise Admin Account**.
6. Log in with username `admin` and the password you just set.

> If the Firestore check fails (network error), bootstrap mode will not trigger. Follow [Section 4 — Emergency Access](#4-emergency-access-firebase-console) instead.

---

## 2. Forgotten Admin Password (recovery key known)

1. Click **Admin Recovery** on the login screen.
2. The modal opens in normal recovery mode.
3. Enter:
   - **Recovery Key** — the secret set during initial setup.
   - **New Password** — the replacement password.
4. Click **Reset Password**.
5. Log in immediately with the new password.

---

## 3. Forgotten Recovery Key (recovery key lost)

Access Firestore directly to reset the recovery key, then use the normal recovery flow.

1. Open [Firebase Console → Firestore](https://console.firebase.google.com/project/terms-a005e/firestore).
2. Navigate to:
   `artifacts → TERMS 1.0.0 → public → data → settings → security`
3. Edit the `recovery_key` field and set it to a new known value.
4. Follow **Section 2** above using the new recovery key.

---

## 4. Emergency Access (Firebase Console)

Use this when both the password and recovery key are unknown, or when the app cannot be reached.

1. Open [Firebase Console → Firestore](https://console.firebase.google.com/project/terms-a005e/firestore).
2. Navigate to:
   `artifacts → TERMS 1.0.0 → public → data → settings → security`
3. Set `admin_password` to any **plaintext** string (e.g. `TempPass2026`).
   - The login system accepts plaintext as a fallback and automatically upgrades it to PBKDF2 on the next successful login.
4. Log in with username `admin` and the plaintext value you entered.
5. After logging in, immediately change the password via **Settings → Security** (or log out and reset it via the recovery flow).

---

## 5. Employee Password Reset (admin action)

Employees cannot use the recovery flow. Only an admin can reset an employee password.

1. Log in as admin.
2. Go to **HR → Employees**.
3. Open the employee record and use the **Reset Password** option to set a new password.
4. Notify the employee of their new password. They can change it themselves via **Profile Settings**.

---

## Security Notes

- The **recovery key** is stored as plaintext in Firestore. Protect it with Firestore security rules (admin-only read on `settings/security`) and treat it like a master password.
- Do **not** share the recovery key with regular users.
- After any emergency access (Section 4), change the password and recovery key immediately.
- Firebase Console access is protected by Google account credentials and project IAM roles — ensure only trusted people have `Editor` or `Owner` roles on the Firebase project.
