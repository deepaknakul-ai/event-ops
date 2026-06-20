/* eslint-disable */
/* global importScripts, firebase, clients */
// Dedicated FCM background message worker (separate from the app's offline
// sw.js). Uses the compat SDK via importScripts because this file is served
// as-is from /public and is not processed by the bundler. The values below are
// public Firebase web config (safe to expose).
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBjd7u6nS7FD2Xr4aRe0WBu7CgAvmeIjcQ',
  authDomain: 'terms-a005e.firebaseapp.com',
  projectId: 'terms-a005e',
  storageBucket: 'terms-a005e.firebasestorage.app',
  messagingSenderId: '269962655904',
  appId: '1:269962655904:web:7a59b171cfd80ac4d6b1c5',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = (payload && payload.notification) || {};
  const data = (payload && payload.data) || {};
  self.registration.showNotification(n.title || 'TERMS', {
    body: n.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    tag: data.channel_id || 'chat',
    data,
  });
});

// Focus an existing window or open the chat when a notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = '/chat';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.indexOf(self.location.origin) === 0 && 'focus' in w) { w.focus(); if ('navigate' in w) w.navigate(target); return; }
      }
      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    }),
  );
});
