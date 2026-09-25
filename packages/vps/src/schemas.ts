import { instanceStates, strictObject, type InputSchema } from '@better-compute/core';

// JSON Schema descriptions of the vps module's method inputs (`validate.jsonSchema`), for the
// generated API reference and tool schemas. `describedBy(schemas.x, parseX)` checks the structure
// (types, required and unknown fields, enums) first; the parsers in instances.ts, flavors.ts,
// accounts.ts and bootstraps.ts then apply the domain rules (patterns, ranges, "exactly one of") and
// keep their messages. Patterns and ranges here document those rules.

// --- Fields ------------------------------------------------------------------------------------

const idOf = (prefix: string, description: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
const tenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const idempotencyKey: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'Scoped to (tenant, caller identity): a retry with the same key replays',
};
/** Lower-case names: flavors (`g1.small`), provider accounts (`hetzner-main`), regions. */
const nameOf = (description: string): InputSchema => ({
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._-]{0,62}$',
  maxLength: 63,
  description,
});
const integer = (minimum: number, maximum: number, description?: string): InputSchema => ({
  type: 'integer',
  minimum,
  maximum,
  ...(description ? { description } : {}),
});
const poolId = idOf('pool', 'The pool');
const instanceId = idOf('inst', 'The instance');
const accountId = idOf('pacct', 'The provider account');
const flavor = nameOf('The flavor name, e.g. g1.small');
/** Provider-side refs (`machineId`, `offerId` of bootstraps). */
const machineRef = (description: string): InputSchema => ({
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description,
});
// Not typed: any JSON value reaches the provider's config manifest, which validates it.
const config = (description: string): InputSchema => ({ description });

const flavorShape = strictObject(
  {
    tenantId,
    poolId,
    name: nameOf('The flavor name, e.g. g1.small'),
    vcpu: integer(1, 1024),
    memoryGiB: integer(1, 16_384),
    diskGiB: integer(1, 65_536),
    gpus: { ...integer(0, 16), default: 0 },
    offerId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Provider pools: the provider offer this flavor creates (required there)',
    },
  },
  ['tenantId', 'poolId', 'name', 'vcpu', 'memoryGiB', 'diskGiB'],
);

// --- Methods -----------------------------------------------------------------------------------

export const schemas = {
  tenant: strictObject({ tenantId }, ['tenantId']),
  pool: strictObject({ tenantId, poolId }, ['tenantId', 'poolId']),
  instance: strictObject({ tenantId, instanceId }, ['tenantId', 'instanceId']),
  account: strictObject({ tenantId, accountId }, ['tenantId', 'accountId']),

  createInstance: strictObject(
    {
      tenantId,
      poolId,
      projectId: idOf('prj', 'The project it belongs to'),
      flavor,
      imageId: {
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$',
        maxLength: 200,
        description: 'The image to boot',
      },
      sshKeys: {
        type: 'array',
        maxItems: 32,
        default: [],
        description: 'OpenSSH public keys, one line each',
        items: { type: 'string', maxLength: 8192 },
      },
      userData: {
        type: 'string',
        maxLength: 32_768,
        description:
          'User data (at most 32 KiB), or secret://<tenantId>/<id> naming a secret of this tenant',
      },
      desiredState: { enum: ['running', 'stopped'], default: 'running' },
      idempotencyKey,
      wait: strictObject(
        {
          timeoutMs: integer(0, 30_000, 'How long to hold the answer until the instance settles'),
        },
        ['timeoutMs'],
      ),
    },
    ['tenantId', 'poolId', 'flavor', 'imageId', 'idempotencyKey'],
  ),
  listInstances: strictObject(
    {
      tenantId,
      scope: { enum: ['mine', 'all'], default: 'mine' },
      state: { enum: [...instanceStates] },
      poolId,
      limit: integer(1, 200),
      cursor: {
        type: 'string',
        pattern: '^inst_[0-9a-z]{26,52}$',
        maxLength: 57,
        description: 'The last instance id of the previous page',
      },
    },
    ['tenantId'],
  ),
  resizeInstance: strictObject(
    { tenantId, instanceId, flavor: { ...flavor, description: 'The new flavor' } },
    ['tenantId', 'instanceId', 'flavor'],
  ),

  flavor: flavorShape,
  deleteFlavor: strictObject({ tenantId, poolId, name: nameOf('The flavor name') }, [
    'tenantId',
    'poolId',
    'name',
  ]),

  createAccount: strictObject(
    {
      tenantId,
      provider: {
        type: 'string',
        pattern: '^[a-z][a-z0-9-]{0,63}$',
        maxLength: 64,
        description: 'The provider id, e.g. provider-hetzner',
      },
      name: nameOf('The account name, e.g. hetzner-main'),
      config: {
        ...config("The provider's account config; credentials as secret references only"),
        default: {},
      },
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._~:/+=-]{1,128}$',
        maxLength: 128,
        description: 'Makes the account id deterministic; a retry returns the account',
      },
    },
    ['tenantId', 'provider', 'name'],
  ),
  accountOffers: strictObject(
    {
      tenantId,
      accountId,
      query: strictObject({
        kind: { enum: ['metal', 'vps'] },
        region: nameOf('The provider region'),
        gpuModel: { type: 'string', pattern: '^[A-Za-z0-9-]{1,32}$', maxLength: 32 },
        minGpus: integer(0, 64),
        minVcpu: integer(0, 1024),
        minMemoryGiB: integer(0, 16_384),
      }),
    },
    ['tenantId', 'accountId'],
  ),
  updateAccount: strictObject(
    {
      tenantId,
      accountId,
      config: config(
        'The new account config (replaces the old one); credentials as secret references only',
      ),
    },
    ['tenantId', 'accountId'],
  ),
  bootstrap: strictObject(
    {
      tenantId,
      accountId,
      poolId: { ...poolId, description: 'The pool the machine joins' },
      machineId: machineRef('A machine the account already has (or offerId, not both)'),
      offerId: machineRef('An offer to claim or order a machine from (or machineId, not both)'),
      idempotencyKey,
    },
    ['tenantId', 'accountId', 'poolId', 'idempotencyKey'],
  ),
} satisfies Record<string, InputSchema>;
