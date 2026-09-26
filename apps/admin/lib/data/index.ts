// The admin's data layer. Every module reads through here; the domain files add one export line each.
export * from './core';
export * from './format';
export * from './topology';
export * from './platform';
// ── domain sources (one line each) ──
export * from './fleet';
export * from './capacity';
