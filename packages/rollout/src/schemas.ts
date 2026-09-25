import { strictObject, type InputSchema } from '@better-compute/core';

// JSON Schema descriptions of the releases and rollouts groups' method inputs (`validate.jsonSchema`),
// for the generated API reference and tool schemas. `describedBy(schema, validate)` (core) checks
// structure first (types, required and unknown fields, enums); the validators in module.ts then apply
// the domain rules and keep their messages. Patterns, lengths and ranges here document them; the
// rollout gates' ranges (waves, maxFailureRatio, soakSeconds, upgradeTimeoutSeconds) are checked
// when the rollout is created (`checkGates`, rollout.ts).

// --- Fields ------------------------------------------------------------------------------------

const tenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const rolloutId: InputSchema = {
  type: 'string',
  pattern: '^rollout_[0-9a-hjkmnp-tv-z]{26,52}$',
  maxLength: 60,
  description: 'The rollout',
};
const reason: InputSchema = {
  type: 'string',
  maxLength: 500,
  description: 'Why, recorded on the rollout',
};

// --- Methods -----------------------------------------------------------------------------------

export const schemas = {
  tenant: strictObject({ tenantId }, ['tenantId']),
  registerRelease: strictObject(
    {
      tenantId,
      // Only `manifest` (a string) and `signatures` (an array) are checked here; the signatures are
      // verified against the release pins when the release is registered.
      manifest: {
        type: 'object',
        description:
          'The signed release manifest as published (manifest.json): { manifest: base64 canonical body, signatures: [{ kid, sig }] }',
      },
    },
    ['tenantId', 'manifest'],
  ),
  createRollout: strictObject(
    {
      tenantId,
      version: {
        type: 'string',
        pattern: '^v?\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$',
        description: 'The registered bcd release to roll out (semver)',
      },
      poolIds: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: { type: 'string', pattern: '^pool_[0-9a-z]{26,52}$', maxLength: 57 },
        description: 'The pools to upgrade (default: every pool the tenant owns); duplicates are dropped',
      },
      waves: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'number', minimum: 1, maximum: 100 },
        default: [1, 10, 50, 100],
        description: 'Cumulative percentages of nodes per wave: whole numbers, increasing, ending at 100',
      },
      maxFailureRatio: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.05,
        description: 'The share of failed nodes that pauses the rollout',
      },
      soakSeconds: {
        type: 'number',
        minimum: 0,
        maximum: 604_800,
        default: 600,
        description: 'Whole seconds each wave soaks before the next starts',
      },
      upgradeTimeoutSeconds: {
        type: 'number',
        minimum: 60,
        maximum: 86_400,
        default: 900,
        description: 'Whole seconds a node has to come back on the new version',
      },
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._~:/+=-]{1,128}$',
        maxLength: 128,
        description: 'A retry with the same key returns the same rollout',
      },
    },
    ['tenantId', 'version'],
  ),
  rollout: strictObject({ tenantId, rolloutId }, ['tenantId', 'rolloutId']),
  pause: strictObject({ tenantId, rolloutId, reason }, ['tenantId', 'rolloutId']),
  abort: strictObject(
    {
      tenantId,
      rolloutId,
      reason,
      rollback: {
        type: 'boolean',
        default: false,
        description:
          'Also return nodes whose upgrade is not confirmed yet to the version they ran before. Nodes that confirmed the release keep it (bcd refuses older binaries once confirmed): undo a bad release with a newer one',
      },
    },
    ['tenantId', 'rolloutId'],
  ),
} satisfies Record<string, InputSchema>;
