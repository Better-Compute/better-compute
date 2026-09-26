/**
 * Kubernetes as a capacity source for better-compute (PLAN.md §3.8): bcd as a DaemonSet adopts an existing
 * cluster's nodes and GPUs into a pool. Compute books the devices; it never schedules pods.
 */
export * from './daemonset.js';
