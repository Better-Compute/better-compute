// The v0.2+ node attestors (PLAN.md §3.3, §15): control-plane verifiers for JoinService and the
// agent-side producers FakeDaemon uses. `join-token` stays in ../attestor.ts.
export type { AttestorBaseOptions, AttestorRefusalHook } from './common.js';
export * from './x509pop.js';
export * from './provisioned.js';
export * from './discovery.js';
export * from './cloud-iid.js';
