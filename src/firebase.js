// c:\APP\temp\rental-ops\src\firebase.js
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAnalytics } from "firebase/analytics";

const defaultFirebaseConfig = {
  apiKey: "AIzaSyBjd7u6nS7FD2Xr4aRe0WBu7CgAvmeIjcQ",
  authDomain: "terms-a005e.firebaseapp.com",
  projectId: "terms-a005e",
  storageBucket: "terms-a005e.firebasestorage.app",
  messagingSenderId: "269962655904",
  appId: "1:269962655904:web:7a59b171cfd80ac4d6b1c5",
  measurementId: "G-D0HZ3NB682"
};

const envFirebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const firebaseConfig = envFirebaseConfig.apiKey ? envFirebaseConfig : defaultFirebaseConfig;


export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Persistent local cache: all Firestore data is mirrored to IndexedDB in the
// browser. The app works fully offline (reads from cache) and queued writes
// auto-sync the instant the connection is restored. Works across multiple tabs.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

export const storage = getStorage(app);
export const analytics = getAnalytics(app);
