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

// The validator accepts upper-case hex in the pin and `-` in MACs (it normalizes them).
const bmc = strictObject(
  {
    address: text(512, 'The BMC address (host or URL)'),
    driver: {
      type: 'string',
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
      type: 'string',
      pattern: '^[0-9A-Fa-f]{64}$',
      description: "SHA-256 of the BMC certificate's SubjectPublicKeyInfo, 64 hex digits, to pin its TLS",
    },
    driverOptions: {
      type: 'object',
      description:
        'Options for the BMC driver, sent with every BMC operation (e.g. bcx-ipmi { "cipherSuite": 3 } for old BMCs): a JSON object of at most 1 KiB, never credentials. The driver validates its keys',
    },
  },
  ['address', 'driver', 'credentials'],
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
        // Strings only, refused by the validator itself ("… is not a MAC address").
        items: { pattern: '^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$' },
        description:
          "The node's PXE MAC addresses (':' or '-' separated). Required for a pool with an agent when the BMC driver cannot report them (IPMI)",
      },
      addresses: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', maxLength: 45 },
        description:
          "The machine's own IP addresses, the only hosts site.httpProxy may reach for it (agentless pools); out-of-band inspection replaces them when it reports some",
      },
      productUuid: {
        ...text(64),
        pattern: '^\\{?[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}\\}?$',
        description:
          'The SMBIOS product UUID (what the BMC reports). Without macs, PXE discovery fills the MAC from the site agent that sees this machine PXE-booting (metal.discovered)',
      },
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
  bulk: strictObject(
    {
      tenantId,
      poolId: text(128, 'The pool every node is in'),
      verb: { enum: ['manage', 'inspect', 'provide', 'undeploy', 'rescue', 'retire'], description: 'The verb every node gets' },
      nodeIds: { type: 'array', minItems: 1, maxItems: 10_000, uniqueItems: true, items: nodeId, description: 'The nodes, all in the tenant' },
      wipe: { enum: wipeModes, default: 'quick', description: 'undeploy: how the disks are wiped on release' },
      reason: text(512, 'What the batch is for: the approvers see it'),
    },
    ['tenantId', 'poolId', 'verb', 'nodeIds', 'reason'],
  ),
  discovered: strictObject({ tenantId, siteId: text(128, 'The site whose PXE discovery list to read') }, ['tenantId', 'siteId']),
} satisfies Record<string, InputSchema>;
