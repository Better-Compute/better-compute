import { strictObject, type InputSchema, type PowerAction, type WipeMode } from '@better-compute/core';

// JSON Schema descriptions of the metal group's method inputs (`validate.jsonSchema`), for the
// generated API reference and tool schemas. `describedBy(schema, validate)` (core) checks structure
// first (types, required and unknown fields, enums); the validators in api.ts then apply the domain
// rules (patterns, lengths, ranges) and keep their messages. Patterns and lengths here document them.

// --- Fields ------------------------------------------------------------------------------------

const tenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const nodeId: InputSchema = {
  type: 'string',
  pattern: '^node_[0-9a-hjkmnp-tv-z]{26,52}$',
  maxLength: 57,
  description: 'The node',
};
const text = (maxLength: number, description?: string): InputSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  ...(description ? { description } : {}),
});

const powerActions = ['on', 'off', 'graceful-off', 'reset', 'graceful-restart', 'cycle', 'nmi'] satisfies PowerAction[];
const wipeModes = ['none', 'quick', 'secure-erase', 'crypto-erase'] satisfies WipeMode[];

// The validator reads `driver` and `tlsSpkiSha256` through String(...) and accepts upper-case hex,
// so they carry no `type`; a missing `driver` is not refused by the validator either.
const bmc = strictObject(
  {
    address: text(512, 'The BMC address (host or URL)'),
    driver: {
      pattern: '^[a-z][a-z0-9-]{0,63}$',
      description: 'The BMC driver id, such as redfish',
    },
    credentials: {
      type: ['string', 'object'],
      pattern: '^(secret|vault|env)://\\S+$',
      maxLength: 2048,
      properties: { username: text(128), password: text(1024) },
      required: ['username', 'password'],
      additionalProperties: false,
      description:
        'A secret:// (or vault://, env://) reference, or inline { username, password } stored in the secret broker at once and never echoed',
    },
    tlsSpkiSha256: {
      pattern: '^[0-9A-Fa-f]{64}$',
      description: "SHA-256 of the BMC certificate's SubjectPublicKeyInfo, 64 hex digits, to pin its TLS",
    },
  },
  ['address', 'credentials'],
);

const node = strictObject({ tenantId, nodeId }, ['tenantId', 'nodeId']);

// --- Methods -----------------------------------------------------------------------------------

export const schemas = {
  enroll: strictObject(
    {
      tenantId,
      siteId: text(128, 'The site the node is in (the pool must be in it)'),
      poolId: text(128, 'The pool the node joins'),
      bmc: { ...bmc, description: 'How to reach the node\'s BMC' },
      macs: {
        type: 'array',
        maxItems: 16,
        items: { pattern: '^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$' },
        description: "The node's MAC addresses (':' or '-' separated), for PXE and matching",
      },
      productUuid: text(64, 'The SMBIOS product UUID'),
      arch: { enum: ['x86_64', 'arm64'], default: 'x86_64' },
      uefi: { type: 'boolean', default: true, description: 'Boots in UEFI mode (false: legacy BIOS)' },
      hardwareProfile: text(64, "Overrides the pool's policy.hardwareProfile"),
    },
    ['tenantId', 'siteId', 'poolId', 'bmc'],
  ),
  node,
  deploy: strictObject(
    {
      tenantId,
      nodeId,
      profileId: text(128, 'The provision profile to deploy'),
      profileVersion: { type: 'integer', minimum: 1, description: 'The profile version' },
    },
    ['tenantId', 'nodeId', 'profileId', 'profileVersion'],
  ),
  undeploy: strictObject(
    {
      tenantId,
      nodeId,
      wipe: { enum: wipeModes, default: 'quick', description: 'How the disks are wiped on release' },
    },
    ['tenantId', 'nodeId'],
  ),
  abort: strictObject(
    { tenantId, nodeId, reason: text(512, 'Recorded as the node\'s last error') },
    ['tenantId', 'nodeId'],
  ),
  power: strictObject(
    { tenantId, nodeId, action: { enum: powerActions, description: 'The BMC power action' } },
    ['tenantId', 'nodeId', 'action'],
  ),
} satisfies Record<string, InputSchema>;
