import { useState, useEffect } from 'react';
import { collection, query, where, onSnapshot, doc } from 'firebase/firestore';
import { BUILTIN_CHANNELS } from './chat';

// Total unread chat messages for the current user across all channels, computed
// from each channel's monotonic `seq` (bumped on every message) minus this
// user's stored `read_seq`. Real-time; drives the Chat nav-item badge so it
// shows even when the Chat page isn't open.
export const useChatUnread = (db, appId, currentEmpId) => {
  const [channels, setChannels] = useState({}); // my dm / project rooms
  const [builtins, setBuiltins] = useState({}); // General / Announcements
  const [reads, setReads] = useState({});       // channelId -> read_seq

  useEffect(() => {
    if (!db || !appId || !currentEmpId) return undefined;
    const col = collection(db, 'artifacts', appId, 'public', 'data', 'chat_channels');
    const unsubCh = onSnapshot(query(col, where('members', 'array-contains', currentEmpId)), (snap) => {
      const m = {}; snap.forEach((d) => { m[d.id] = { id: d.id, ...d.data() }; }); setChannels(m);
    }, () => {});
    const unsubBuiltins = BUILTIN_CHANNELS.map((b) => onSnapshot(doc(col, b.id), (s) => {
      setBuiltins((prev) => ({ ...prev, [b.id]: s.exists() ? { id: b.id, ...s.data() } : null }));
    }, () => {}));
    const unsubReads = onSnapshot(query(collection(db, 'artifacts', appId, 'public', 'data', 'chat_reads'), where('emp_id', '==', currentEmpId)), (snap) => {
      const m = {}; snap.forEach((d) => { const v = d.data(); m[v.channel_id] = v.read_seq || 0; }); setReads(m);
    }, () => {});
    return () => { unsubCh(); unsubReads(); unsubBuiltins.forEach((u) => u()); };
  }, [db, appId, currentEmpId]);

  const all = { ...Object.fromEntries(Object.entries(builtins).filter(([, v]) => v)), ...channels };
  let unread = 0;
  Object.values(all).forEach((c) => {
    if (!c.last_message || c.last_message.sender_id === currentEmpId) return;
    const gap = (c.seq || 0) - (reads[c.id] || 0);
    if (gap > 0) unread += gap;
  });
  return unread;
};
