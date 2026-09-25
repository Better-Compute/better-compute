/**
 * Observability for better-compute (PLAN.md §14), browser-safe: a bounded Prometheus registry with no tenant
 * labels, the named `better_compute_*` series, `ComputeSpan` observers shaped like better-iam's, a metered
 * IamPort, and W3C `traceparent` helpers.
 */
export * from './registry.js';
export * from './standard.js';
export * from './spans.js';
export * from './instrument.js';
export * from './database.js';
export * from './traceparent.js';
