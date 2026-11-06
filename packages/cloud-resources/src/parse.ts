import { strictObject, type InputSchema, type ProviderResourceFamily } from '@better-compute/core';
import { bool, fail, id, key, object, tenant } from './input.js';
import type {
  AdoptResourceInput,
  CreateResourceInput,
  DiscoverInput,
  KindsInput,
  ListResourcesInput,
  ResourceRef,
  UpdateResourceInput,
} from './types.js';

// Input parsing and the JSON Schemas the generated reference shows for `cloudResources`. A spec is checked here only
// for its shape (an object, bounded); the kind's own manifest validates it once the pool's provider is known.

export const families = [
  'storage',
  'network',
  'edge',
  'data',
  'platform',
  'ai',
  'observability',
] as const satisfies readonly ProviderResourceFamily[];

/** A kind: provider-prefixed, `[a-z0-9.-]`, at most 64 characters (`do.database.pg`). */
export const kindPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** Resource names: 1-63 lower-case letters, digits and '-', a letter first, not ending with '-'. */
const namePattern = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** A provider's id of a resource (a uuid, a number, `cluster/user`). */
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
/** A spec is at most this large as JSON. */
export const maxSpecBytes = 64 * 1024;

function kind(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !kindPattern.test(value) ||
    !value.includes('.')
  )
    fail('kind must be a provider-prefixed kind such as do.database.pg');
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !namePattern.test(value))
    fail(
      "name must be 1-63 lower-case letters, digits or '-', start with a letter and not end with '-'",
    );
  return value;
}

function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256)
    fail('description must be at most 256 characters');
  return value;
}

function spec(value: unknown, what = 'spec'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${what} must be an object`);
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    fail(`${what} must be plain JSON`);
  }
  if (size > maxSpecBytes) fail(`${what} must be at most ${maxSpecBytes} bytes of JSON`);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function family(value: unknown): ProviderResourceFamily {
  if (typeof value !== 'string' || !(families as readonly string[]).includes(value))
    fail(`family must be one of ${families.join(', ')}`);
  return value as ProviderResourceFamily;
}

export function parseKinds(raw: unknown): KindsInput {
  const input = object(raw, ['tenantId', 'poolId']);
  return { tenantId: tenant(input.tenantId), poolId: id(input.poolId, 'pool', 'poolId') };
}

export function parseCreate(raw: unknown): CreateResourceInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'kind',
    'name',
    'description',
    'parentId',
    'spec',
    'idempotencyKey',
  ]);
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    kind: kind(input.kind),
    name: name(input.name),
    spec: spec(input.spec),
    idempotencyKey: key(input.idempotencyKey),
    ...(input.projectId !== undefined
      ? { projectId: id(input.projectId, 'prj', 'projectId') }
      : {}),
    ...(input.description !== undefined ? { description: description(input.description) } : {}),
    ...(input.parentId !== undefined ? { parentId: id(input.parentId, 'crs', 'parentId') } : {}),
  };
}

export function parseList(raw: unknown): ListResourcesInput {
  const input = object(raw, [
    'tenantId',
    'poolId',
    'projectId',
    'kind',
    'family',
    'includeDeleted',
  ]);
  return {
    tenantId: tenant(input.tenantId),
    ...(input.poolId !== undefined ? { poolId: id(input.poolId, 'pool', 'poolId') } : {}),
    ...(input.projectId !== undefined
      ? { projectId: id(input.projectId, 'prj', 'projectId') }
      : {}),
    ...(input.kind !== undefined ? { kind: kind(input.kind) } : {}),
    ...(input.family !== undefined ? { family: family(input.family) } : {}),
    ...(input.includeDeleted !== undefined
      ? { includeDeleted: bool(input.includeDeleted, 'includeDeleted') }
      : {}),
  };
}

export function parseRef(raw: unknown): ResourceRef {
  const input = object(raw, ['tenantId', 'resourceId']);
  return {
    tenantId: tenant(input.tenantId),
    resourceId: id(input.resourceId, 'crs', 'resourceId'),
  };
}

export function parseUpdate(raw: unknown): UpdateResourceInput {
  const input = object(raw, ['tenantId', 'resourceId', 'spec', 'description']);
  if (input.spec === undefined && input.description === undefined)
    fail('An update changes spec or description');
  return {
    tenantId: tenant(input.tenantId),
    resourceId: id(input.resourceId, 'crs', 'resourceId'),
    ...(input.spec !== undefined ? { spec: spec(input.spec) } : {}),
    ...(input.description !== undefined
      ? { description: input.description === null ? null : description(input.description) }
      : {}),
  };
}

export function parseDiscover(raw: unknown): DiscoverInput {
  const input = object(raw, ['tenantId', 'poolId', 'kind']);
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    kind: kind(input.kind),
  };
}

export function parseAdopt(raw: unknown): AdoptResourceInput {
  const input = object(raw, [
    'tenantId',
    'projectId',
    'poolId',
    'kind',
    'providerId',
    'name',
    'description',
    'idempotencyKey',
  ]);
  if (typeof input.providerId !== 'string' || !providerIdPattern.test(input.providerId))
    fail(
      'providerId must be the provider’s id of the resource, as cloudResources.discover lists it',
    );
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    kind: kind(input.kind),
    providerId: input.providerId,
    name: name(input.name),
    idempotencyKey: key(input.idempotencyKey),
    ...(input.projectId !== undefined
      ? { projectId: id(input.projectId, 'prj', 'projectId') }
      : {}),
    ...(input.description !== undefined ? { description: description(input.description) } : {}),
  };
}

// --- JSON Schemas ----------------------------------------------------------------------------

const idOf = (prefix: string, text: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description: text,
});
const tenantIdSchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const kindSchema = (text: string): InputSchema => ({
  type: 'string',
  pattern: '^[a-z0-9]+(?:[.-][a-z0-9]+)*$',
  maxLength: 64,
  description: text,
});
const nameSchema: InputSchema = {
  type: 'string',
  pattern: '^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$',
  maxLength: 63,
  description: 'The resource name, unique per kind in the tenant, e.g. orders-db',
};
const keySchema: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
};
const poolSchema = idOf(
  'pool',
  'A provider pool owned by or offered to the tenant, whose account serves cloud resources',
);
const ref = strictObject(
  { tenantId: tenantIdSchema, resourceId: idOf('crs', 'The cloud resource') },
  ['tenantId', 'resourceId'],
);

export const cloudResourcesSchemas = {
  kinds: strictObject({ tenantId: tenantIdSchema, poolId: poolSchema }, ['tenantId', 'poolId']),
  create: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the resource belongs to'),
      poolId: poolSchema,
      kind: kindSchema(
        'A kind the pool’s provider serves (cloudResources.kinds), e.g. do.database.pg',
      ),
      name: nameSchema,
      description: { type: 'string', maxLength: 256, description: 'What the resource is for' },
      parentId: idOf('crs', 'For a kind with a parent (a database user): the resource it lives in'),
      spec: {
        type: 'object',
        description: 'The kind’s spec, validated by its manifest (kinds lists its schema)',
      },
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'kind', 'name', 'spec', 'idempotencyKey'],
  ),
  list: strictObject(
    {
      tenantId: tenantIdSchema,
      poolId: idOf('pool', 'Only this pool’s resources'),
      projectId: idOf('prj', 'Only this project’s resources'),
      kind: kindSchema('Only this kind'),
      family: { enum: [...families], description: 'Only this family' },
      includeDeleted: {
        type: 'boolean',
        default: false,
        description: 'Include deleted and released resources',
      },
    },
    ['tenantId'],
  ),
  ref,
  update: strictObject(
    {
      tenantId: tenantIdSchema,
      resourceId: idOf('crs', 'The cloud resource'),
      spec: {
        type: 'object',
        description:
          'Merged onto the stored spec; a change to a field the kind cannot change in place is refused (replaceRequired)',
      },
      description: {
        type: ['string', 'null'],
        maxLength: 256,
        description: 'What the resource is for; null clears it',
      },
    },
    ['tenantId', 'resourceId'],
  ),
  discover: strictObject(
    {
      tenantId: tenantIdSchema,
      poolId: idOf('pool', 'A provider pool on the tenant’s own account'),
      kind: kindSchema('The kind to look for'),
    },
    ['tenantId', 'poolId', 'kind'],
  ),
  adopt: strictObject(
    {
      tenantId: tenantIdSchema,
      projectId: idOf('prj', 'The project the resource belongs to'),
      poolId: idOf('pool', 'A provider pool on the tenant’s own account'),
      kind: kindSchema('The resource’s kind'),
      providerId: {
        type: 'string',
        maxLength: 200,
        description: 'The provider’s id of the resource, as cloudResources.discover lists it',
      },
      name: nameSchema,
      description: { type: 'string', maxLength: 256, description: 'What the resource is for' },
      idempotencyKey: keySchema,
    },
    ['tenantId', 'poolId', 'kind', 'providerId', 'name', 'idempotencyKey'],
  ),
} satisfies Record<string, InputSchema>;
