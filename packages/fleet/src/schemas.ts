import { strictObject, type InputSchema } from '@better-compute/core';

// JSON Schema descriptions of the fleet group's method inputs (`validate.jsonSchema`), for the
// generated API reference and tool schemas. `describedBy(schema, validate)` (core) checks structure
// first (types, required and unknown fields, enums); the validators in module.ts (and
// `validateFleetConfig` for the document) then apply the domain rules and keep their messages.
// Patterns here document them.

// --- Fields ------------------------------------------------------------------------------------

const tenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
// The document is checked in full by validateFleetConfig (config.ts), which names the offending path.
const config: InputSchema = {
  type: 'object',
  description:
    'The FleetConfig document: { version: 1, sites, providerAccounts, pools, flavors }, as fleet.export writes it',
};
const prune: InputSchema = {
  type: 'boolean',
  default: false,
  description: 'Delete (archive) what the document no longer lists',
};
const planHash: InputSchema = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
  maxLength: 64,
  description:
    'The planHash of the plan you reviewed: apply refuses with CONFIG_DRIFT if the plan moved since',
};

// --- Methods -----------------------------------------------------------------------------------

export const schemas = {
  tenant: strictObject({ tenantId }, ['tenantId']),
  plan: strictObject({ tenantId, config, prune }, ['tenantId', 'config']),
  apply: strictObject({ tenantId, config, prune, planHash }, ['tenantId', 'config']),
} satisfies Record<string, InputSchema>;
