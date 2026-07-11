/* Build stamp, injected by vite.config.js `define`. Falls back to dev values when
   the app is run without a build (e.g. `vite dev`, unit tests). */
/* global __APP_VERSION__, __GIT_SHA__, __BUILD_TIME__ */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const GIT_SHA = typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'local';
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

// Human-friendly one-liner, e.g. "v3.5.0 · a7bbaa2 · 2026-07-11"
export const VERSION_LABEL = `v${APP_VERSION}` +
  (GIT_SHA && GIT_SHA !== 'local' ? ` · ${GIT_SHA}` : '') +
  (BUILD_TIME ? ` · ${BUILD_TIME.slice(0, 10)}` : '');
