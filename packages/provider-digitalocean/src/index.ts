/**
 * DigitalOcean provider for better-compute: Droplets as VPS instances and offers, VPC networks,
 * power, reinstall and discovery, Block Storage volumes and snapshots, reserved IPs and managed
 * Kubernetes (DOKS). Plain fetch against the DigitalOcean API v2; no SDK.
 */
export * from './client/errors.js';
export * from './client/http.js';
export { RateBudget, budgetFor, budgetShares, resetBudgets, tokenHash } from './client/budget.js';
export * from './compute/catalog.js';
export * from './compute/droplets.js';
export * from './compute/images.js';
export * from './compute/keys.js';
export * from './compute/offers.js';
export * from './compute/spot.js';
export * from './compute/types.js';
export * from './config.js';
export * from './edge/addresses.js';
export * from './doks/index.js';
export * from './edge/certificates.js';
export * from './edge/dns.js';
export * from './edge/load-balancers.js';
export * from './ids.js';
export * from './metal/bare-metal.js';
export * from './inference/proxy.js';
export * from './networks/index.js';
export * from './probe.js';
export * from './provider.js';
export * from './storage/types.js';
export * from './storage/nfs.js';
export * from './storage/volumes.js';
export * from './resources/kind.js';
export * from './resources/registry.js';
export * from './resources/kinds/databases.js';
export { appInstanceHoursMeter, appInstances } from './resources/kinds/apps.js';
export { addonHoursMeter } from './resources/kinds/addons.js';
export { partnerHoursMeter } from './resources/kinds/partner.js';
export * from './spaces/sigv4.js';
export * from './spaces/s3.js';
export * from './spaces/blob-store.js';
export * from './resources/storage/index.js';
export * from './registry/credentials.js';
export * from './registry/image-source.js';
export {
  dedicatedInferenceKindName,
  inferenceGpuSizes,
  type DedicatedInferenceSpec,
} from './resources/kinds/inference.js';
export {
  defaultInferenceEndpoint,
  inferenceKeyKindName,
  inferenceTokensMeter,
} from './resources/kinds/inference-keys.js';
export {
  knowledgeBaseHoursMeter,
  knowledgeBaseKindName,
  type KnowledgeBaseSpec,
} from './resources/kinds/knowledge-bases.js';
export { guardrailKindName, type GuardrailSpec } from './resources/kinds/guardrails.js';
export {
  actionGatewayHoursMeter,
  actionGatewayKindName,
  agentHarnessHoursMeter,
  agentHarnessKindName,
  type ActionGatewaySpec,
  type AgentHarnessSpec,
} from './resources/kinds/managed-agents.js';
export { maxSignals } from './resources/signals.js';
