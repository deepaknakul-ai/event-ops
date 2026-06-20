// Chat helpers — channel identity, membership, and time formatting.
//
// Identity note: throughout the app a person's id is their employee doc id,
// which (via verifyLogin's createCustomToken(emp.id, …)) is ALSO their Firebase
// Auth uid. So `currentEmpId` === `request.auth.uid`, and chat membership arrays
// hold employee ids that the Firestore rules can match against `userEmpId()`.

// Built-in, always-present channels (no doc needed until the first message).
export const BUILTIN_CHANNELS = [
  { id: 'team__general', type: 'team', name: 'General' },
  { id: 'announce__all', type: 'announcement', name: 'Announcements' },
];

export const dmChannelId = (a, b) => 'dm__' + [a, b].sort().join('__');
export const projectChannelId = (projectId) => 'project__' + projectId;

export const isOpenType = (type) => type === 'team' || type === 'announcement';

export const managementIds = (employees = []) =>
  employees.filter((e) => e.role === 'admin' || e.role === 'manager').map((e) => e.id);

// The `members` array stored on a channel + denormalised onto each message so
// the security rules can authorise reads without a cross-doc lookup. Open
// (team/announcement) channels carry an empty array — the rule lets everyone in.
export const channelMembers = (type, { a, b, project, employees } = {}) => {
  if (type === 'dm') return [a, b].filter(Boolean);
  if (type === 'project') {
    return Array.from(new Set([...(project?.assigned_employees || []), ...managementIds(employees)]));
  }
  return [];
};

export const fmtChatTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', opts);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday ' + d.toLocaleTimeString('en-IN', opts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

export const dayLabel = (iso) => {
  const d = new Date(iso); const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

// Deterministic avatar tint from an id.
export const avatarColor = (id = '') => {
  const colors = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-sky-500', 'bg-violet-500', 'bg-teal-500'];
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
};

// ── @mentions (slice 3) ──────────────────────────────────────────────────────
// Match "@Full Name" or "@FullName" against the employee list, longest first.
export const parseMentions = (text = '', employees = []) => {
  if (!text.includes('@')) return [];
  const ids = [];
  [...employees].filter((e) => e.name).sort((a, b) => b.name.length - a.name.length).forEach((e) => {
    if (text.includes('@' + e.name) || text.includes('@' + e.name.replace(/\s+/g, ''))) ids.push(e.id);
  });
  return Array.from(new Set(ids));
};

// ── presence (slice 3) ───────────────────────────────────────────────────────
export const PRESENCE_WINDOW_MS = 90 * 1000;
// nowMs lets a periodic re-render expire stale "online" states deterministically.
export const isOnline = (p, nowMs = Date.now()) =>
  !!(p && p.last_seen && (nowMs - new Date(p.last_seen).getTime()) < PRESENCE_WINDOW_MS);
