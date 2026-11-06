/**
 * DigitalOcean provider for better-compute: Droplets as VPS instances and offers, VPC networks,
 * power, reinstall and discovery. Plain fetch against the DigitalOcean API v2; no SDK.
 */
export * from './client/errors.js';
export * from './client/http.js';
export { RateBudget, budgetFor, budgetShares, resetBudgets, tokenHash } from './client/budget.js';
export * from './compute/droplets.js';
export * from './compute/keys.js';
export * from './compute/offers.js';
export * from './compute/types.js';
export * from './config.js';
export * from './ids.js';
export * from './inference/proxy.js';
export * from './networks/index.js';
export * from './probe.js';
export * from './provider.js';
export * from './resources/kind.js';
export * from './resources/registry.js';
export * from './resources/kinds/databases.js';
export { appInstanceHoursMeter, appInstances } from './resources/kinds/apps.js';
export { addonHoursMeter } from './resources/kinds/addons.js';
export { partnerHoursMeter } from './resources/kinds/partner.js';
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
