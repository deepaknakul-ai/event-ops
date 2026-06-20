// FCM web-push client. Inert until an admin sets the public VAPID key
// (settings/chat.fcm_vapid_key). Registers the dedicated messaging service
// worker (separate from the app's offline sw.js) and stores the device token in
// chat_push_tokens so the onChatMessageCreated function can target this device.
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { doc, setDoc } from 'firebase/firestore';
import { app, db } from '../firebase';
import { notify } from './toast';

let messaging = null;
let foregroundBound = false;

const ensureMessaging = async () => {
  if (messaging) return messaging;
  try { if (!(await isSupported())) return null; } catch { return null; }
  messaging = getMessaging(app);
  return messaging;
};

// Show a toast for messages that arrive while the app is foregrounded (FCM does
// not raise a system notification in that case).
const bindForeground = (m) => {
  if (foregroundBound || !m) return;
  foregroundBound = true;
  onMessage(m, (payload) => {
    const n = payload?.notification || {};
    if (n.title || n.body) notify(`${n.title || 'New message'}${n.body ? ': ' + n.body : ''}`, 'info');
  });
};

export const pushSupported = async () => {
  try { return (await isSupported()) && 'serviceWorker' in navigator && 'Notification' in window; }
  catch { return false; }
};

// Ask for permission, fetch a token, and register it. Returns the token or null.
export const enablePush = async ({ appId, empId, vapidKey }) => {
  const m = await ensureMessaging();
  if (!m) { notify('Notifications are not supported on this browser.', 'error'); return null; }
  if (!vapidKey) { notify('Push is not configured yet — ask an admin to add the notification key.', 'error'); return null; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { notify('Notifications were not allowed for this site.', 'info'); return null; }

  // No explicit registration: getToken() auto-registers /firebase-messaging-sw.js
  // at scope /firebase-cloud-messaging-push-scope, so it never clobbers the app's
  // offline sw.js (which controls the root scope).
  let token;
  try {
    token = await getToken(m, { vapidKey });
  } catch (e) { notify(`Could not enable notifications: ${e.message || e}`, 'error'); return null; }
  if (!token) { notify('Could not get a notification token.', 'error'); return null; }

  try {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'chat_push_tokens', token), {
      token, emp_id: empId, ua: (navigator.userAgent || '').slice(0, 200), updated_at: new Date().toISOString(),
    }, { merge: true });
  } catch (e) { notify(`Could not save the token: ${e.message || e}`, 'error'); return null; }

  bindForeground(m);
  notify('Notifications enabled on this device.', 'success');
  return token;
};

// If the user already granted permission, silently refresh/register the token
// and bind the foreground listener (called on Chat mount).
export const refreshPushIfGranted = async ({ appId, empId, vapidKey }) => {
  if (!vapidKey || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const m = await ensureMessaging();
  if (!m) return;
  try {
    const token = await getToken(m, { vapidKey });
    if (token) {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'chat_push_tokens', token), {
        token, emp_id: empId, ua: (navigator.userAgent || '').slice(0, 200), updated_at: new Date().toISOString(),
      }, { merge: true });
    }
    bindForeground(m);
  } catch { /* ignore */ }
};
