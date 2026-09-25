import { ComputeError } from '@better-compute/core';

// JSON Schema descriptions of capacity's method inputs (`validate.jsonSchema`), for the generated
// API reference and tool schemas, in the server's convention (packages/server/src/api/input.ts):
// strict objects, `INVALID_INPUT` with `details.issues: { message, path }[]`.
//
// `describedBy(schema, validate)` checks the input's structure against the schema first (the type
// of every field, required and unknown fields, enums), reporting every structural issue at once;
// the method's own validator then applies the domain rules (patterns, ranges, "exactly one of") and
// keeps its messages.

export type JsonSchema = { readonly [keyword: string]: unknown };

interface Issue {
  message: string;
  path: string[];
}

const typeNames: Record<string, string> = {
  string: 'a string',
  integer: 'an integer',
  number: 'a number',
  boolean: 'true or false',
  object: 'an object',
  array: 'an array',
};

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

function walk(schema: JsonSchema, value: unknown, path: string[], issues: Issue[]): void {
  const types = schema.type === undefined ? [] : [schema.type].flat().map(String);
  if (types.length > 0 && !types.some((type) => hasType(type, value))) {
    issues.push({
      message: `Expected ${types.map((type) => typeNames[type] ?? type).join(' or ')}`,
      path,
    });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ message: `Must be one of ${schema.enum.join(', ')}`, path });
    return;
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, index) =>
      walk(schema.items as JsonSchema, item, [...path, String(index)], issues),
    );
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? undefined) as Record<string, JsonSchema> | undefined;
  if (properties) {
    if (schema.additionalProperties === false)
      for (const key of Object.keys(record))
        if (!Object.hasOwn(properties, key))
          issues.push({ message: `Unknown field ${key}`, path: [...path, key] });
    for (const key of (schema.required ?? []) as string[])
      if (record[key] === undefined) issues.push({ message: 'Required', path: [...path, key] });
    for (const [key, property] of Object.entries(properties))
      if (record[key] !== undefined) walk(property, record[key], [...path, key], issues);
  } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const [key, item] of Object.entries(record))
      walk(schema.additionalProperties as JsonSchema, item, [...path, key], issues);
  }
}

/** `validate` with its input described by `schema`: structural issues first, all at once. */
export function describedBy<I>(
  schema: JsonSchema,
  validate: (raw: unknown) => I,
): ((raw: unknown) => I) & { readonly jsonSchema: JsonSchema } {
  return Object.assign(
    (raw: unknown) => {
      const issues: Issue[] = [];
      walk(schema, raw, [], issues);
      if (issues.length > 0) {
        const first = issues[0]!;
        const where = first.path.length ? `${first.path.join('.')}: ` : '';
        throw new ComputeError('INVALID_INPUT', `${where}${first.message}`, undefined, { issues });
      }
      return validate(raw);
    },
    { jsonSchema: schema },
  );
}

// --- Fields ------------------------------------------------------------------------------------

const idOf = (prefix: string, description: string): JsonSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
const tenantId: JsonSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const idempotencyKey: JsonSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
};
const poolId = idOf('pool', 'The pool');
const reservationId = idOf('rsv', 'The reservation');
const quotaMap = (description: string): JsonSchema => ({
  type: 'object',
  description,
  propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' },
  additionalProperties: { type: 'integer', minimum: 0 },
});
const strict = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const durationField = (description: string): JsonSchema => ({
  type: ['string', 'integer'],
  description: `${description}: "30m", "8h", "7d", or milliseconds`,
});

const deviceRequest = strict(
  {
    class: {
      enum: ['gpu', 'gpu.mig', 'gpu.slot', 'nic.vf', 'disk', 'node'],
      description: 'The device class to book',
    },
    count: { type: 'integer', minimum: 1, maximum: 64 },
    selector: {
      type: 'object',
      description: 'matchExpressions over device attributes, then node labels',
    },
    topology: { enum: ['any', 'nvlink-all'] },
    sharing: { enum: ['exclusive', 'mig', 'timeslice', 'mps'] },
  },
  ['class', 'count'],
);

// --- Methods -----------------------------------------------------------------------------------

export const schemas = {
  tenant: strict({ tenantId }, ['tenantId']),
  pool: strict({ tenantId, poolId }, ['tenantId', 'poolId']),
  reservation: strict({ tenantId, reservationId }, ['tenantId', 'reservationId']),
  createPool: strict(
    {
      tenantId,
      siteId: idOf('site', 'The site the pool lives in'),
      class: { enum: ['metal-host', 'metal-dedicated', 'vps-host', 'provider'] },
      gpuModel: { type: 'string', pattern: '^[A-Za-z0-9-]{1,32}$', maxLength: 32 },
      sharing: { enum: ['exclusive', 'mig', 'timeslice', 'mps'], default: 'exclusive' },
      agent: { enum: ['bcd', 'none'], description: 'bcd (default), or none for provider pools' },
      policy: { type: 'object', description: 'PoolPolicy' },
      ownerQuota: quotaMap("The owner's limits per resource (default: unlimited GPUs)"),
      providerAccountId: idOf('pacct', 'Provider pools: the provider account behind them'),
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._~:/+=-]{1,128}$',
        maxLength: 128,
        description: 'Makes the pool id deterministic; a retry returns the pool',
      },
    },
    ['tenantId', 'siteId', 'class'],
  ),
  offerPool: strict(
    {
      tenantId,
      poolId,
      toTenantId: { ...tenantId, description: 'The tenant the pool is offered to' },
      quota: quotaMap("That tenant's limits per resource"),
      includeDescendants: { type: 'boolean', default: false },
      priority: { type: 'integer', minimum: -1000, maximum: 1000 },
    },
    ['tenantId', 'poolId', 'toTenantId', 'quota'],
  ),
  unofferPool: strict(
    { tenantId, poolId, toTenantId: { ...tenantId, description: 'The tenant to withdraw from' } },
    ['tenantId', 'poolId', 'toTenantId'],
  ),
  updatePool: strict(
    {
      tenantId,
      poolId,
      policy: { type: 'object', description: 'The new PoolPolicy (replaces the old one)' },
      gpuModel: { type: 'string', pattern: '^[A-Za-z0-9-]{1,32}$', maxLength: 32 },
    },
    ['tenantId', 'poolId'],
  ),
  timeline: strict(
    {
      tenantId,
      poolId,
      from: { type: 'integer', minimum: 0, maximum: 2 ** 47, description: 'Epoch ms' },
      to: { type: 'integer', minimum: 0, maximum: 2 ** 47, description: 'Epoch ms' },
      stepMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
    },
    ['tenantId', 'poolId'],
  ),
  quotasGet: strict({ tenantId, poolId }, ['tenantId']),
  setQuota: strict(
    {
      tenantId,
      poolId,
      resource: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$', maxLength: 64 },
      max: { type: 'integer', minimum: 0 },
    },
    ['tenantId', 'poolId', 'resource', 'max'],
  ),
  listReservations: strict(
    {
      tenantId,
      scope: { enum: ['mine', 'all'], default: 'mine' },
      state: {
        enum: [
          'draft',
          'denied',
          'awaiting-confirmation',
          'pending',
          'placed',
          'binding',
          'active',
          'releasing',
          'released',
          'failed',
          'cancelled',
          'expired',
        ],
      },
      poolId,
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: reservationId,
    },
    ['tenantId'],
  ),
  createReservation: strict(
    {
      tenantId,
      poolId,
      projectId: idOf('prj', 'The project it belongs to'),
      devices: { type: 'array', minItems: 1, maxItems: 8, items: deviceRequest },
      topology: { enum: ['any', 'nvlink-all'] },
      start: {
        type: 'integer',
        minimum: 0,
        maximum: 2 ** 47,
        description: 'Epoch ms (default now)',
      },
      duration: durationField('How long'),
      // Not an enum: `instance` is refused as UNSUPPORTED (vps.instances.create), not as bad input.
      binding: {
        type: 'string',
        default: 'hold',
        description: 'hold (CDI devices) or node (a whole-node lease in a tenantRoot pool)',
      },
      node: strict(
        {
          profileId: { type: 'string', pattern: '^[A-Za-z0-9._:/-]{1,128}$', maxLength: 128 },
          profileVersion: { type: 'integer', minimum: 1 },
        },
        ['profileId'],
      ),
      leaseSeconds: { type: 'integer', minimum: 30, maximum: 86_400 },
      spot: { type: 'boolean' },
      idempotencyKey,
      wait: strict({ timeoutMs: { type: 'integer', minimum: 0, maximum: 30_000 } }, ['timeoutMs']),
      gang: strict(
        {
          size: { type: 'integer', minimum: 2, maximum: 64 },
          topologyKey: { type: 'string', maxLength: 128 },
        },
        ['size'],
      ),
    },
    ['tenantId', 'poolId', 'devices', 'duration', 'idempotencyKey'],
  ),
  extendReservation: strict(
    {
      tenantId,
      reservationId,
      until: {
        type: 'integer',
        minimum: 0,
        maximum: 2 ** 47,
        description: 'The new end, epoch ms',
      },
      by: durationField('How much longer'),
      idempotencyKey,
    },
    ['tenantId', 'reservationId', 'idempotencyKey'],
  ),
} satisfies Record<string, JsonSchema>;
