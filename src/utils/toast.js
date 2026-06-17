// Global toast bridge.
//
// Most page components receive App's `addToast` as a prop, but some pages
// (and non-React util modules like fyLock / pdf generators) cannot. This
// bridge lets any module emit a toast without prop threading: App registers
// its real `addToast` once on mount, and `notify(msg, type)` forwards to it.
//
// Falls back to console if no handler is registered yet (e.g. a util fires
// before App mounts), so a missing handler can never throw.
let handler = null;

export const registerToast = (fn) => {
  handler = typeof fn === 'function' ? fn : null;
};

export const notify = (msg, type = 'info') => {
  if (handler) {
    handler(msg, type);
  } else if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.warn('[toast:' + type + ']', msg);
  }
};
