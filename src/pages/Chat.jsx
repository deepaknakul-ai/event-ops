import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, where, orderBy, limit, onSnapshot, addDoc, setDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import {
  Hash, Megaphone, Send, Search, Plus, FolderKanban, MessageSquare, ArrowLeft, Lock,
  Paperclip, X, Check, CheckCheck, File as FileIcon, Download, Settings, Bell,
} from 'lucide-react';
import { storage } from '../firebase';
import { can } from '../utils/permissions';
import { notify } from '../utils/toast';
import { enablePush, refreshPushIfGranted } from '../utils/push';
import {
  BUILTIN_CHANNELS, dmChannelId, projectChannelId, channelMembers, isOpenType,
  fmtChatTime, dayLabel, initials, avatarColor, parseMentions, isOnline,
} from '../utils/chat';

const MENTION_RE = /(@[\p{L}\p{N}_]+)/u;
// Render message text with @mentions highlighted.
const renderText = (text = '') =>
  text.split(MENTION_RE).map((part, i) => (MENTION_RE.test(part)
    ? <span key={i} className="font-semibold text-indigo-500">{part}</span>
    : <React.Fragment key={i}>{part}</React.Fragment>));

// One row in the channel sidebar (a channel, project room or person).
const SidebarItem = ({ Icon, label, sub, onClick, activeItem, avatar, online, badge }) => (
  <button onClick={onClick} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${activeItem ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}>
    <span className="relative shrink-0">
      {avatar
        ? <span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white ${avatar.color}`}>{avatar.text}</span>
        : Icon ? React.createElement(Icon, { size: 16, className: 'text-slate-400' }) : null}
      {online && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />}
    </span>
    <span className="min-w-0 flex-1">
      <span className={`block truncate ${badge ? 'font-bold text-slate-800' : 'font-medium'}`}>{label}</span>
      {sub && <span className="block truncate text-[11px] text-slate-400">{sub}</span>}
    </span>
    {badge ? <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" /> : null}
  </button>
);

// Real-time team ↔ management chat: team channels, per-project rooms, 1:1 DMs and
// management announcements, with attachments, @mentions, read receipts, unread
// badges and online presence. Messages live in a per-channel subcollection
// (chat_channels/{id}/messages) so ordering needs no composite index.
const Chat = ({ role = 'user', db, appId, employees = [], projects = [], currentEmpId }) => {
  const [myChannels, setMyChannels] = useState({});   // id -> channel doc (dm + project rooms I'm in)
  const [builtinDocs, setBuiltinDocs] = useState({}); // builtin channel docs (for unread/preview)
  const [active, setActive] = useState(null);         // resolved channel {id,type,name,members,project_id}
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [pickDM, setPickDM] = useState(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [pending, setPending] = useState([]);         // staged attachments before send
  const [uploading, setUploading] = useState(false);
  const [mentionQ, setMentionQ] = useState(null);     // active @mention query (null = closed)
  const [reads, setReads] = useState({});             // my read cursors: channelId -> last_read_at
  const [channelReads, setChannelReads] = useState({}); // active channel: emp_id -> last_read_at
  const [presence, setPresence] = useState({});       // emp_id -> {last_seen}
  const [presenceEnabled, setPresenceEnabled] = useState(true);
  const [vapidKey, setVapidKey] = useState('');
  const [adminPanel, setAdminPanel] = useState(false);
  const [vapidInput, setVapidInput] = useState('');
  const [onlineSet, setOnlineSet] = useState(() => new Set());
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  const me = employees.find((e) => e.id === currentEmpId) || {};
  const meName = me.name || 'Me';
  const empById = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);

  const channelsCol = () => collection(db, 'artifacts', appId, 'public', 'data', 'chat_channels');
  const channelDoc = (cid) => doc(db, 'artifacts', appId, 'public', 'data', 'chat_channels', cid);
  const msgsCol = (cid) => collection(db, 'artifacts', appId, 'public', 'data', 'chat_channels', cid, 'messages');
  const readsCol = () => collection(db, 'artifacts', appId, 'public', 'data', 'chat_reads');
  const readDoc = (rid) => doc(db, 'artifacts', appId, 'public', 'data', 'chat_reads', rid);
  const presenceDoc = (eid) => doc(db, 'artifacts', appId, 'public', 'data', 'chat_presence', eid);

  // ── My channels (DMs + project rooms I'm a member of) ────────────────────────
  useEffect(() => {
    if (!db || !currentEmpId) return undefined;
    const unsub = onSnapshot(query(channelsCol(), where('members', 'array-contains', currentEmpId)), (snap) => {
      const m = {}; snap.forEach((d) => { m[d.id] = { id: d.id, ...d.data() }; }); setMyChannels(m);
    }, () => {});
    return () => unsub();
  }, [db, appId, currentEmpId]);

  // ── Built-in channel docs (General, Announcements) for unread/preview ────────
  useEffect(() => {
    if (!db) return undefined;
    const unsubs = BUILTIN_CHANNELS.map((b) => onSnapshot(channelDoc(b.id), (snap) => {
      setBuiltinDocs((prev) => ({ ...prev, [b.id]: snap.exists() ? { id: b.id, ...snap.data() } : null }));
    }, () => {}));
    return () => unsubs.forEach((u) => u());
  }, [db, appId]);

  // ── My read cursors (unread badges) ──────────────────────────────────────────
  useEffect(() => {
    if (!db || !currentEmpId) return undefined;
    const unsub = onSnapshot(query(readsCol(), where('emp_id', '==', currentEmpId)), (snap) => {
      const m = {}; snap.forEach((d) => { const v = d.data(); m[v.channel_id] = v.last_read_at; }); setReads(m);
    }, () => {});
    return () => unsub();
  }, [db, appId, currentEmpId]);

  // ── Presence (online dots) ───────────────────────────────────────────────────
  useEffect(() => {
    if (!db || !presenceEnabled) return undefined; // onlineOf() already gates on presenceEnabled
    const unsub = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'chat_presence'), (snap) => {
      const m = {}; snap.forEach((d) => { m[d.id] = d.data(); }); setPresence(m);
    }, () => {});
    return () => unsub();
  }, [db, appId, presenceEnabled]);

  // ── Presence on/off setting (admin toggle, cost control) ─────────────────────
  useEffect(() => {
    if (!db) return undefined;
    const unsub = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'chat'), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      setPresenceEnabled(d.presence_enabled !== false);
      setVapidKey(d.fcm_vapid_key || '');
    }, () => {});
    return () => unsub();
  }, [db, appId]);

  // If notifications were already granted, silently refresh this device's token.
  useEffect(() => {
    if (vapidKey && currentEmpId) refreshPushIfGranted({ appId, empId: currentEmpId, vapidKey });
  }, [vapidKey, currentEmpId, appId]);

  // ── Heartbeat: write my presence every ~45s while the tab is visible ─────────
  useEffect(() => {
    if (!db || !currentEmpId || !presenceEnabled) return undefined;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      setDoc(presenceDoc(currentEmpId), { emp_id: currentEmpId, name: meName, last_seen: new Date().toISOString() }, { merge: true }).catch(() => {});
    };
    beat();
    const id = setInterval(beat, 45000);
    document.addEventListener('visibilitychange', beat);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', beat); };
  }, [db, appId, currentEmpId, presenceEnabled, meName]);

  // ── Compute the online set off the render path so stale states expire ────────
  useEffect(() => {
    const recompute = () => {
      const t = Date.now();
      const s = new Set();
      Object.entries(presence).forEach(([eid, p]) => { if (isOnline(p, t)) s.add(eid); });
      setOnlineSet(s);
    };
    const t0 = setTimeout(recompute, 0);
    const id = setInterval(recompute, 15000);
    return () => { clearTimeout(t0); clearInterval(id); };
  }, [presence]);

  // ── Live messages + read cursors for the active channel ──────────────────────
  useEffect(() => {
    if (!db || !active) return undefined;
    const unsub = onSnapshot(query(msgsCol(active.id), orderBy('created_at', 'desc'), limit(100)), (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse());
    }, () => {});
    return () => unsub();
  }, [db, appId, active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!db || !active) return undefined;
    const unsub = onSnapshot(query(readsCol(), where('channel_id', '==', active.id)), (snap) => {
      const m = {}; snap.forEach((d) => { const v = d.data(); m[v.emp_id] = v.last_read_at; }); setChannelReads(m);
    }, () => {});
    return () => unsub();
  }, [db, appId, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mark active channel read (on open + on each new message while visible) ───
  useEffect(() => {
    if (!db || !active || !currentEmpId || document.visibilityState !== 'visible') return;
    setDoc(readDoc(`${active.id}__${currentEmpId}`), { channel_id: active.id, emp_id: currentEmpId, last_read_at: new Date().toISOString() }, { merge: true }).catch(() => {});
  }, [db, appId, active, currentEmpId, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const channelDocs = useMemo(() => {
    const m = {};
    Object.entries(builtinDocs).forEach(([k, v]) => { if (v) m[k] = v; });
    Object.entries(myChannels).forEach(([k, v]) => { m[k] = v; });
    return m;
  }, [builtinDocs, myChannels]);

  const unreadOf = (cid) => {
    const d = channelDocs[cid];
    if (!d || !d.last_message || d.last_message.sender_id === currentEmpId) return false;
    const lr = reads[cid];
    return !lr || new Date(d.updated_at || d.last_message.at) > new Date(lr);
  };
  const onlineOf = (eid) => presenceEnabled && eid !== currentEmpId && onlineSet.has(eid);

  const dmChannels = useMemo(() => Object.values(myChannels).filter((c) => c.type === 'dm'), [myChannels]);

  const visibleProjects = useMemo(() => {
    const all = projects.filter((p) => p.project_name && p.status !== 'Cancelled');
    const mgmt = role === 'admin' || role === 'manager' || role === 'accountant';
    const list = mgmt ? all : all.filter((p) => (p.assigned_employees || []).includes(currentEmpId));
    return list.sort((a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0));
  }, [projects, role, currentEmpId]);

  const openChannel = (ch) => { setMessages([]); setChannelReads({}); setPending([]); setMentionQ(null); setActive(ch); setMobileThread(true); setPickDM(false); };
  const openBuiltin = (b) => openChannel({ ...b, members: [], project_id: '' });
  const openProject = (p) => openChannel({ id: projectChannelId(p.id), type: 'project', name: p.project_name, project_id: p.id, members: channelMembers('project', { project: p, employees }) });
  const openDM = (otherId) => {
    if (otherId === currentEmpId) return;
    const other = empById[otherId];
    openChannel({ id: dmChannelId(currentEmpId, otherId), type: 'dm', name: other?.name || 'Direct message', members: [currentEmpId, otherId], other_id: otherId });
  };

  const canPost = active && (active.type === 'announcement' ? can(role, 'chat', 'announce') : can(role, 'chat', 'create'));

  // ── Composer: attachments + @mention autocomplete ────────────────────────────
  const addFiles = (list) => {
    const arr = Array.from(list || []).slice(0, 5);
    setPending((p) => [...p, ...arr.map((f) => ({ file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : '', isImage: f.type.startsWith('image/'), name: f.name }))]);
  };
  const removePending = (idx) => setPending((p) => { const x = p[idx]; if (x?.url) URL.revokeObjectURL(x.url); return p.filter((_, i) => i !== idx); });

  const onChangeText = (v) => {
    setText(v);
    const mm = /@([\p{L}\p{N}_]*)$/u.exec(v);
    setMentionQ(mm ? mm[1].toLowerCase() : null);
  };
  const mentionCandidates = useMemo(() => {
    if (mentionQ === null || !active) return [];
    const pool = isOpenType(active.type) ? employees : employees.filter((e) => (active.members || []).includes(e.id));
    return pool.filter((e) => e.id !== currentEmpId && (e.status || 'Active') === 'Active' && (e.name || '').toLowerCase().includes(mentionQ)).slice(0, 6);
  }, [mentionQ, active, employees, currentEmpId]);
  const pickMention = (e) => {
    setText((v) => v.replace(/@([\p{L}\p{N}_]*)$/u, '@' + (e.name || '').replace(/\s+/g, '') + ' '));
    setMentionQ(null);
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && pending.length === 0) || !active || !canPost || uploading) return;
    let attachments = [];
    if (pending.length) {
      setUploading(true);
      try {
        attachments = await Promise.all(pending.map(async (pf) => {
          const safe = pf.file.name.replace(/[^\w.-]+/g, '_');
          const path = `artifacts/${appId}/chat/${active.id}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safe}`;
          const r = ref(storage, path);
          await uploadBytes(r, pf.file);
          const url = await getDownloadURL(r);
          return { url, name: pf.file.name, type: pf.file.type, size: pf.file.size, path };
        }));
      } catch (e) { setUploading(false); notify(`Upload failed: ${e.message || e}`, 'error'); return; }
      setUploading(false);
    }
    const now2 = new Date().toISOString();
    const members = active.members || [];
    const mentions = parseMentions(body, employees);
    const preview = body || (attachments[0]?.type?.startsWith('image/') ? '📷 Photo' : `📎 ${attachments[0]?.name || 'Attachment'}`);
    setText(''); setMentionQ(null);
    pending.forEach((pf) => { if (pf.url) URL.revokeObjectURL(pf.url); });
    setPending([]);
    try {
      await addDoc(msgsCol(active.id), {
        channel_id: active.id, channel_type: active.type, members,
        text: body, sender_id: currentEmpId, sender_name: meName, sender_photo: me.photo_url || '',
        created_at: now2, attachments, mentions,
      });
      await setDoc(channelDoc(active.id), {
        id: active.id, type: active.type, name: active.name || '', project_id: active.project_id || '',
        members, last_message: { text: preview, sender_id: currentEmpId, sender_name: meName, at: now2 }, updated_at: now2,
      }, { merge: true });
    } catch (e) {
      setText(body);
      notify(`Could not send: ${e.message || e}`, 'error');
    }
  };

  const togglePresence = async () => {
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'chat'), { presence_enabled: !presenceEnabled }, { merge: true });
      notify(`Online presence ${!presenceEnabled ? 'enabled' : 'disabled'}.`, 'success');
    } catch { notify('Only an admin can change this.', 'error'); }
  };
  const saveVapid = async () => {
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'chat'), { fcm_vapid_key: vapidInput.trim() }, { merge: true });
      notify('Notification key saved. Team members can now enable push.', 'success');
      setAdminPanel(false);
    } catch { notify('Only an admin can change this.', 'error'); }
  };
  const handleEnablePush = () => enablePush({ appId, empId: currentEmpId, vapidKey });

  if (!can(role, 'chat', 'view')) return <div className="p-6 text-sm text-slate-500">You don't have access to chat.</div>;

  const sFilter = (s) => !search || (s || '').toLowerCase().includes(search.toLowerCase());
  const otherOf = (ch) => (ch.members || []).find((m) => m !== currentEmpId);

  // index of my most recent message (for the read-receipt line)
  let lastMineIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].sender_id === currentEmpId) { lastMineIdx = i; break; } }
  const receiptFor = (m) => {
    if (active.type === 'dm') {
      const o = active.other_id || otherOf(active);
      const seen = o && channelReads[o] && new Date(channelReads[o]) >= new Date(m.created_at);
      return seen ? <span className="text-sky-300"><CheckCheck size={13} className="inline" /> Seen</span> : <span><Check size={13} className="inline" /> Sent</span>;
    }
    if (active.type === 'project') {
      const others = (active.members || []).filter((x) => x !== currentEmpId);
      const seen = others.filter((x) => channelReads[x] && new Date(channelReads[x]) >= new Date(m.created_at)).length;
      return seen > 0 ? <span><CheckCheck size={13} className="inline" /> Seen by {seen}/{others.length}</span> : <span><Check size={13} className="inline" /> Sent</span>;
    }
    return null;
  };

  return (
    <div className="flex h-[calc(100vh-7rem)] overflow-hidden rounded-xl border border-slate-200 bg-white">
      {/* Sidebar */}
      <aside className={`${mobileThread ? 'hidden' : 'flex'} w-full flex-col border-r border-slate-100 md:flex md:w-72`}>
        <div className="border-b border-slate-100 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-bold text-slate-800"><MessageSquare size={18} className="text-indigo-600" /> Chat</h2>
            <div className="flex items-center gap-0.5">
              <button onClick={handleEnablePush} title="Enable notifications on this device" className="rounded-md p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600"><Bell size={15} /></button>
              {role === 'admin' && (
                <button onClick={() => { setVapidInput(vapidKey); setAdminPanel((v) => !v); }} title="Chat settings" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><Settings size={15} /></button>
              )}
            </div>
          </div>
          {role === 'admin' && adminPanel && (
            <div className="mb-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
              <button onClick={togglePresence} className="flex w-full items-center justify-between rounded-md bg-white px-2 py-1.5 font-medium text-slate-600 hover:bg-slate-100">
                <span>Online presence</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${presenceEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{presenceEnabled ? 'ON' : 'OFF'}</span>
              </button>
              <div>
                <label className="mb-1 block font-medium text-slate-500">FCM Web-Push key (VAPID)</label>
                <input value={vapidInput} onChange={(e) => setVapidInput(e.target.value)} placeholder="Paste the public VAPID key…" className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-[11px] focus:border-indigo-400 focus:outline-none" />
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">{vapidKey ? '✓ Push configured' : 'Firebase → Cloud Messaging → Web Push certs'}</span>
                  <button onClick={saveVapid} className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700">Save</button>
                </div>
              </div>
            </div>
          )}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-sm focus:border-indigo-400 focus:outline-none" />
          </div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-2">
          <div>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Channels</div>
            {BUILTIN_CHANNELS.filter((b) => sFilter(b.name)).map((b) => (
              <SidebarItem key={b.id} Icon={b.type === 'announcement' ? Megaphone : Hash} label={b.name} onClick={() => openBuiltin(b)} activeItem={active?.id === b.id} badge={unreadOf(b.id)} />
            ))}
          </div>
          <div>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Project rooms</div>
            {visibleProjects.filter((p) => sFilter(p.project_name)).slice(0, 60).map((p) => (
              <SidebarItem key={p.id} Icon={FolderKanban} label={p.project_name} sub={p.status} onClick={() => openProject(p)} activeItem={active?.id === projectChannelId(p.id)} badge={unreadOf(projectChannelId(p.id))} />
            ))}
            {visibleProjects.length === 0 && <div className="px-2 py-1 text-[11px] text-slate-400">No project rooms yet.</div>}
          </div>
          <div>
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Direct messages</span>
              <button onClick={() => setPickDM((v) => !v)} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600" title="New message"><Plus size={14} /></button>
            </div>
            {pickDM && (
              <div className="mb-1 max-h-48 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-1">
                {employees.filter((e) => e.id !== currentEmpId && (e.status || 'Active') === 'Active' && sFilter(e.name)).map((e) => (
                  <button key={e.id} onClick={() => openDM(e.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-slate-600 hover:bg-white">
                    <span className="relative"><span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ${avatarColor(e.id)}`}>{initials(e.name)}</span>{onlineOf(e.id) && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white bg-emerald-500" />}</span>
                    <span className="truncate">{e.name}</span>
                  </button>
                ))}
              </div>
            )}
            {dmChannels
              .map((ch) => ({ ch, oid: otherOf(ch) }))
              .filter(({ oid }) => sFilter(empById[oid]?.name))
              .sort((a, b) => new Date(b.ch.updated_at || 0) - new Date(a.ch.updated_at || 0))
              .map(({ ch, oid }) => (
                <SidebarItem
                  key={ch.id}
                  avatar={{ color: avatarColor(oid || ch.id), text: initials(empById[oid]?.name || '?') }}
                  online={onlineOf(oid)}
                  label={empById[oid]?.name || 'Unknown'}
                  sub={ch.last_message?.text}
                  onClick={() => openDM(oid)}
                  activeItem={active?.id === ch.id}
                  badge={unreadOf(ch.id)}
                />
              ))}
          </div>
        </div>
      </aside>

      {/* Thread */}
      <section className={`${mobileThread ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col md:flex`}>
        {!active ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-slate-400">
            <MessageSquare size={40} className="text-slate-200" />
            <div className="text-sm">Pick a channel, project room or person to start chatting.</div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
              <button onClick={() => setMobileThread(false)} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 md:hidden"><ArrowLeft size={16} /></button>
              {active.type === 'dm'
                ? <span className="relative"><span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white ${avatarColor(active.other_id || active.id)}`}>{initials(active.name)}</span>{onlineOf(active.other_id) && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />}</span>
                : active.type === 'announcement' ? <Megaphone size={16} className="text-indigo-600" />
                : active.type === 'project' ? <FolderKanban size={16} className="text-indigo-600" />
                : <Hash size={16} className="text-indigo-600" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-800">{active.name}</div>
                <div className="text-[11px] text-slate-400">
                  {active.type === 'project' ? `${(active.members || []).length} in room`
                    : active.type === 'dm' ? (onlineOf(active.other_id) ? 'Online' : 'Direct message')
                    : active.type === 'announcement' ? 'Read-only for team' : 'Everyone'}
                </div>
              </div>
              {!isOpenType(active.type) && <Lock size={13} className="text-slate-300" title="Private" />}
            </header>

            <div className="flex-1 space-y-1 overflow-y-auto bg-slate-50/60 p-3">
              {messages.length === 0 && <div className="py-10 text-center text-xs text-slate-400">No messages yet. Say hello 👋</div>}
              {messages.map((m, i) => {
                const mine = m.sender_id === currentEmpId;
                const prev = messages[i - 1];
                const newDay = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at);
                const grouped = prev && prev.sender_id === m.sender_id && !newDay;
                const mentioned = (m.mentions || []).includes(currentEmpId);
                return (
                  <React.Fragment key={m.id}>
                    {newDay && (
                      <div className="my-2 flex justify-center"><span className="rounded-full bg-white px-2.5 py-0.5 text-[10px] font-medium text-slate-400 shadow-sm">{dayLabel(m.created_at)}</span></div>
                    )}
                    <div className={`flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                      {!mine && !grouped
                        ? <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${avatarColor(m.sender_id)}`}>{initials(m.sender_name)}</span>
                        : <span className="w-7 shrink-0" />}
                      <div className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm ${mine ? 'rounded-br-sm bg-indigo-600 text-white' : `rounded-bl-sm bg-white text-slate-700 shadow-sm ${mentioned ? 'ring-2 ring-amber-300' : ''}`}`}>
                        {!mine && !grouped && <div className="mb-0.5 text-[11px] font-semibold text-indigo-500">{m.sender_name}</div>}
                        {m.text && <div className="whitespace-pre-wrap break-words">{renderText(m.text)}</div>}
                        {(m.attachments || []).map((a, idx) => (a.type || '').startsWith('image/')
                          ? <a key={idx} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} className="mt-1 max-h-52 rounded-lg" /></a>
                          : (
                            <a key={idx} href={a.url} target="_blank" rel="noreferrer" className={`mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${mine ? 'bg-white/15' : 'bg-slate-100'}`}>
                              <FileIcon size={14} /> <span className="max-w-[160px] truncate">{a.name}</span> <Download size={12} />
                            </a>
                          ))}
                        <div className={`mt-0.5 text-right text-[10px] ${mine ? 'text-indigo-200' : 'text-slate-400'}`}>{fmtChatTime(m.created_at)}</div>
                      </div>
                    </div>
                    {mine && i === lastMineIdx && receiptFor(m) && (
                      <div className="pr-1 text-right text-[10px] text-slate-400">{receiptFor(m)}</div>
                    )}
                  </React.Fragment>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {canPost ? (
              <div className="border-t border-slate-100 p-2.5">
                {pending.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {pending.map((pf, idx) => (
                      <div key={idx} className="relative flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1 pr-2 text-[11px] text-slate-600">
                        {pf.isImage ? <img src={pf.url} alt="" className="h-8 w-8 rounded object-cover" /> : <FileIcon size={16} className="text-slate-400" />}
                        <span className="max-w-[120px] truncate">{pf.name}</span>
                        <button onClick={() => removePending(idx)} className="text-slate-400 hover:text-red-500"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="relative flex items-end gap-2">
                  {mentionQ !== null && mentionCandidates.length > 0 && (
                    <div className="absolute bottom-12 left-0 z-10 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                      {mentionCandidates.map((e) => (
                        <button key={e.id} onClick={() => pickMention(e)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-slate-600 hover:bg-indigo-50">
                          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ${avatarColor(e.id)}`}>{initials(e.name)}</span>
                          <span className="truncate">{e.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <button onClick={() => fileRef.current?.click()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-indigo-600" title="Attach"><Paperclip size={18} /></button>
                  <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                  <textarea
                    value={text}
                    onChange={(e) => onChangeText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && mentionQ === null) { e.preventDefault(); send(); } }}
                    rows={1}
                    placeholder={active.type === 'announcement' ? 'Post an announcement…' : `Message ${active.name}`}
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
                  />
                  <button onClick={send} disabled={(!text.trim() && pending.length === 0) || uploading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">
                    {uploading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <Send size={16} />}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-1.5 border-t border-slate-100 p-3 text-xs text-slate-400">
                <Lock size={12} /> {active.type === 'announcement' ? 'Only management can post announcements.' : 'You can read but not post here.'}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
};

export default Chat;
