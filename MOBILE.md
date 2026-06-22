# TERMS on mobile — Install & Publish runbook

TERMS is a **PWA** (installable web app) and is **Capacitor-ready** so the same
code can be shipped as a native Android app on the Play Store. Nothing here
needs a rewrite — the chat, push, camera and offline features are the same web
app under the hood.

---

## 1. Install now as a PWA (no tooling, $0)

On an **Android phone (Chrome)**:
1. Open **https://terms-a005e.web.app** and sign in.
2. Tap the **Install** banner at the bottom — or Chrome menu (⋮) → **Install app / Add to Home screen**.
3. TERMS now has its own home-screen icon and opens full-screen (no browser bar).

Desktop Chrome/Edge shows an **install icon** in the address bar.

**Enable push:** open **Chat → 🔔 (top-right of the channel list) → Allow**. (An
admin must first paste the FCM Web-Push key once — see below.)

---

## 2. One-time admin setup for background push

Background notifications need a free **VAPID** key:

1. Firebase Console → **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**.
2. Copy the **public key** (a long `B…` string).
3. In TERMS: **Chat → ⚙ (admin only) → FCM Web-Push key (VAPID) → paste → Save**.

That's it — sending uses the project's service account (no extra secret). Until
this is set, chat works fully; only background push stays off. The value lives
in `settings/chat.fcm_vapid_key` (a public, non-secret key — safe to store).

> **Cost knob:** the same ⚙ panel has an **Online presence** toggle. Presence is
> the only usage-cost driver (a small heartbeat per active user). Turn it off to
> run chat at near-zero Firestore cost.

---

## 3. Publish to the Google Play Store (Capacitor)

This produces a real `.aab` for Google Play. It runs **on your machine** (needs
Android Studio + a Google Play Console account, $25 one-time). The repo already
ships `capacitor.config.json`.

### Approach A — thin shell over the hosted PWA (recommended, simplest)
`capacitor.config.json` already points `server.url` at the live site, so the
native app always loads the latest deployed PWA (no re-publish on every change).

```bash
# 1. Install Capacitor (one-time)
npm install @capacitor/core @capacitor/android
npm install -D @capacitor/cli

# 2. Add the Android platform
npx cap add android

# 3. Open in Android Studio
npx cap open android
```
In Android Studio: set the app icon (use `public/icons/icon-512.png`), then
**Build → Generate Signed Bundle/APK → Android App Bundle**, create/keep a
**keystore** (back it up — losing it blocks future updates), and upload the
`.aab` to the Play Console.

### Approach B — bundle the web build inside the app (works offline-first)
Remove `server.url` from `capacitor.config.json`, then:
```bash
npm run build:app      # builds dist/ with relative asset paths for the webview
npx cap sync android
npx cap open android
```
> Note: with a bundled build, in-app routing must not rely on server rewrites.
> If deep links misbehave, switch the router to `HashRouter`, or use Approach A.

### For true native push (optional upgrade)
Approach A/B use **web push** (already wired). To use Android's native FCM
channel instead, add `@capacitor/push-notifications`, register the device token,
and write it to `chat_push_tokens` with the same `{ token, emp_id }` shape — the
existing `onChatMessageCreated` function will deliver to it unchanged.

---

## 4. Replacing the placeholder app icon

The icons in `public/icons/` are a generated "T" lettermark. To use your logo:
- Drop in your own `icon-192.png`, `icon-512.png`, `maskable-512.png` (and
  `apple-touch-icon.png`, `favicon-32.png`), **or**
- Edit the colours/letters in `scripts/generate-pwa-icons.mjs` and run
  `node scripts/generate-pwa-icons.mjs`.

Then redeploy hosting. For the Android app, set the launcher icon in Android
Studio (Image Asset) from the 512px PNG.

---

## 5. Employee location tracking

Live location tracking (Admin → **Live Map**) runs **only while an employee is on
duty** (checked in) and only when an admin enables it in **Admin Tools → Location
Tracking**. Each person sees a "Sharing location" indicator while it's on.

**Works now — no native build required.** Tracking uses the standard browser
geolocation API, so it runs in a mobile browser (real GPS), the installed PWA,
and the native app's foreground. On first use the OS shows a location-permission
prompt; the employee must **Allow**.

### Foreground in the native app
With Approach A/B above, foreground GPS works once the app has location
permission. Add to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```
(For sharper fixes you can also `npm install @capacitor/geolocation`, but the
webview's `navigator.geolocation` already works.)

### Background tracking (phone locked / app closed) — later upgrade
True background tracking is **not** built in (you chose foreground-only). To add
it later:
1. `npm install @capacitor-community/background-geolocation` and start/stop it
   from the same on-duty logic as `src/components/LocationTracker.jsx`, writing to
   the same `employee_locations` / `location_history` collections.
2. Add `ACCESS_BACKGROUND_LOCATION` + a foreground-service entry to the manifest
   (a persistent "TERMS is tracking your location" notification is mandatory).
3. **Google Play approval:** background location triggers a policy review — you must
   submit a justification video and publish a **privacy policy URL** describing what
   you collect, why (workforce attendance/dispatch), and retention. Without this,
   Play will reject the app.

### Privacy notes
- Data: latest position per employee (`employee_locations`) + an optional trail
  (`location_history`), pruned automatically after the retention window (Admin
  Tools). Only **admin/manager** can read others' locations (enforced in
  `firestore.rules`); an employee can read only their own.
- Tell your team in writing that on-duty location is tracked. For the background
  upgrade this disclosure + a privacy policy become a Play Store requirement.
