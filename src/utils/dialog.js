// Promise-based global confirm / prompt dialogs — replaces native
// window.confirm / window.prompt with in-app modals.
//
// App mounts <DialogHost/> once and registers an opener. Callers do:
//   if (await confirmDialog('Delete this?')) { ... }
//   const name = await promptDialog('New name?', 'default');
//
// If no host is registered (e.g. a public page that doesn't mount the
// host, or a call before App mounts), we fall back to the native dialog
// so behaviour is never silently lost.
let opener = null;

export const registerDialog = (fn) => {
  opener = typeof fn === 'function' ? fn : null;
};

export const confirmDialog = (message, opts = {}) =>
  new Promise((resolve) => {
    if (!opener) {
      resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
      return;
    }
    opener({ kind: 'confirm', message, ...opts, resolve });
  });

export const promptDialog = (message, defaultValue = '', opts = {}) =>
  new Promise((resolve) => {
    if (!opener) {
      resolve(typeof window !== 'undefined' ? window.prompt(message, defaultValue) : null);
      return;
    }
    opener({ kind: 'prompt', message, defaultValue, ...opts, resolve });
  });
