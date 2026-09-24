/**
 * `@better-compute/iam/plugin`: what a better-iam host on compute's IAM database installs (PLAN.md §12.1,
 * §12.3). In embedded mode that is `bridge.plugin()`; an IAM deployment compute does not run (remote mode,
 * v0.4) installs `computeIamHost({ projection: replicaProjection({ sql }), inbox: postgresInbox({ sql }) })`.
 */
export * from './catalog.js';
export * from './inbox.js';
export * from './iam-plugin.js';
export * from './host.js';
