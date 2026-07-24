// Build-time edition switch. `import.meta.env.VITE_EDITION` is statically
// replaced by Vite at build time, so `IS_SAAS` folds to a literal `false` in
// private builds — every `if (IS_SAAS)` / `IS_SAAS && ...` branch and the
// platform-console lazy import are dead-code-eliminated from the private bundle.
//
//   private build (default / --mode backup): VITE_EDITION undefined → 'private'
//   SaaS build     (--mode saas):             VITE_EDITION 'saas'    → 'saas'
//
// PRIVATE MUST NEVER SHIP SAAS CODE. Guard all tenant-platform features with
// IS_SAAS (or the inline `import.meta.env.VITE_EDITION === 'saas'` expression
// for lazy chunks). scripts/check-private-bundle.cjs enforces this on every
// private build.
export const EDITION = import.meta.env.VITE_EDITION === 'saas' ? 'saas' : 'private';
export const IS_SAAS = EDITION === 'saas';
export const IS_PRIVATE = !IS_SAAS;
