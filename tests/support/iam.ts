import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { sqliteAdapter } from '@better-iam/adapter-sqlite';
import {
  IamError,
  type IamPlugin,
  type IamStore,
  type PolicyDocument,
  type ResourceRef,
  type ResourceTypeDefinition,
} from '@better-iam/core';
import {
  betterIam,
  type BetterIamOptions,
  type SessionTokenSigningOptions,
} from '@better-iam/server';

/**
 * Fixtures for `tests/iam-contract.test.ts`: an embedded better-iam (the vendored packages, not its source) on an
 * in-memory SQLite store, bootstrapped like better-iam's own `organizationFixture` (a root administrator with TOTP
 * and one organization, "Acme", whose owner accepted the invitation), plus the pieces compute installs on every IAM
 * host: the §12.3 catalog as a plugin and a §12.4-style resolver over an in-memory projection.
 */

export const ORIGIN = 'http://localhost:3000';
/** The session JWT audience of the compute API (PLAN.md §12.1, §12.6). */
export const COMPUTE_AUDIENCE = 'https://compute.example.com';
const SECRET = 'better-compute-iam-contract-secret-32-characters';

export type Credential = { token: string };
type DeliveryMessage = Parameters<
  NonNullable<NonNullable<BetterIamOptions['authentication']>['sendEmail']>
>[0];
type Resolver = NonNullable<BetterIamOptions['resolveResource']>;

const action = (area: string, ...verbs: string[]) => verbs.map((verb) => `compute:${area}:${verb}`);

/**
 * The normative compute catalog of PLAN.md §12.3, copied verbatim. W4 moves it into the IAM bridge; this contract
 * test then imports the shipped catalog instead of this copy.
 */
export function computeCatalog(p = 'compute-'): Record<string, ResourceTypeDefinition> {
  return {
    [`${p}fleet`]: {
      actions: [
        ...action('fleet', 'admin'),
        ...action('sites', 'manage'),
        ...action('pools', 'create'),
        ...action('quotas', 'manage'),
        ...action('secrets', 'manage'),
        ...action('images', 'publish'),
        ...action('providers', 'manage'),
        ...action('drivers', 'read'),
        ...action('billing', 'read', 'manage'),
        ...action('usage', 'read', 'manage'),
      ],
    },
    [`${p}tenant`]: {
      actions: [
        ...action('sites', 'read', 'manage'),
        ...action('pools', 'read', 'create'),
        ...action('capacity', 'read'),
        ...action('nodes', 'read'),
        ...action('reservations', 'read'),
        ...action('instances', 'read'),
        ...action('projects', 'read', 'manage'),
        ...action('quotas', 'read'),
        ...action('usage', 'read'),
        ...action('events', 'read'),
        ...action('webhooks', 'manage'),
        ...action('drivers', 'read'),
        ...action('secrets', 'manage'),
        ...action('profiles', 'read', 'manage'),
        ...action('images', 'read', 'publish'),
        ...action('providers', 'read', 'manage'),
        ...action('sandboxes', 'read', 'manage'),
        // v1.0 tenant networks: `networks.list` is gated on the tenant.
        ...action('networks', 'read'),
        // §13 destructive-batch quorum (v1.0).
        ...action('batches', 'read', 'create', 'approve'),
      ],
    },
    [`${p}project`]: {
      actions: [...action('projects', 'read', 'manage'), ...action('usage', 'read')],
      relations: ['member', 'admin'],
    },
    [`${p}site`]: {
      actions: action('sites', 'read', 'manage'),
      attributes: { region: 'string', iamRegion: 'string', kind: 'string' },
    },
    [`${p}pool`]: {
      actions: [
        ...action('pools', 'read', 'manage', 'share'),
        ...action('capacity', 'read'),
        ...action('join-tokens', 'create', 'read', 'revoke'),
        ...action('flavors', 'read', 'manage'),
        ...action('nodes', 'provision'),
      ],
      relations: ['viewer', 'user', 'operator', 'admin'],
      attributes: {
        region: 'string',
        class: 'string',
        gpuModel: 'string',
        gpuMemoryGb: 'number',
        sharing: 'string',
      },
    },
    [`${p}node`]: {
      parent: `${p}pool`,
      relations: ['operator'],
      actions: [
        ...action(
          'nodes',
          'read',
          'update',
          'cordon',
          'drain',
          'provision',
          'power',
          'exec',
          'console',
          'ssh-root',
          'delete',
          'revoke-identity',
        ),
        ...action('workflows', 'read', 'manage'),
      ],
      attributes: {
        region: 'string',
        gpuModel: 'string',
        gpuCount: 'number',
        lifecycle: 'string',
        trust: 'string',
        dedicatedTo: 'string',
      },
    },
    [`${p}reservation`]: {
      parent: `${p}pool`,
      actions: action('reservations', 'create', 'read', 'extend', 'release'),
      attributes: {
        region: 'string',
        gpuModel: 'string',
        gpuCount: 'number',
        durationHours: 'number',
        binding: 'string',
        projectId: 'string',
        spot: 'boolean',
      },
    },
    [`${p}instance`]: {
      parent: `${p}pool`,
      actions: action('instances', 'create', 'read', 'update', 'exec', 'delete', 'attach'),
      attributes: {
        vcpu: 'number',
        memoryGiB: 'number',
        gpus: 'number',
        imageId: 'string',
        imageVerified: 'boolean',
        projectId: 'string',
      },
    },
    [`${p}image`]: {
      actions: action('images', 'read', 'publish'),
      attributes: { visibility: 'string', verified: 'boolean' },
    },
    [`${p}profile`]: { actions: action('profiles', 'read', 'manage') },
    [`${p}provider-account`]: { actions: action('providers', 'read', 'manage') },
    [`${p}sandbox`]: {
      parent: `${p}pool`,
      actions: action('sandboxes', 'create', 'read', 'update', 'exec', 'delete'),
      attributes: {
        templateId: 'string',
        vcpu: 'number',
        memoryGiB: 'number',
        gpus: 'number',
        ttlSeconds: 'number',
        fromSnapshot: 'string',
        warm: 'boolean',
      },
    },
    [`${p}sandbox-template`]: { actions: action('sandboxes', 'read', 'manage') },
    [`${p}sandbox-snapshot`]: {
      actions: action('sandboxes', 'read', 'delete'),
      attributes: { sandboxId: 'string', templateId: 'string', includeMemory: 'boolean' },
    },
    [`${p}sandbox-volume`]: {
      parent: `${p}pool`,
      actions: action('sandboxes', 'read', 'manage'),
      attributes: { sizeGiB: 'number' },
    },
    [`${p}network`]: {
      parent: `${p}tenant`,
      actions: action('networks', 'create', 'read', 'update', 'delete'),
      attributes: { providerAccountId: 'string', poolId: 'string', projectId: 'string' },
    },
  };
}

/** Compute's IAM plugin as far as better-iam can see it: id `better-compute`, the catalog, and optional hooks. */
export function computePlugin(extra: Omit<Partial<IamPlugin>, 'id'> = {}): IamPlugin {
  return { id: 'better-compute', resourceTypes: computeCatalog(), ...extra };
}

/** An in-memory stand-in for compute's `authz_projection`, resolved the way §12.4's `computeResolver` resolves it. */
export interface Projection {
  /** Every reference the resolver was asked for, in order. */
  readonly calls: ResourceRef[];
  /** Makes `{type}/{id}` visible in `tenantId` with these attributes (parentType/parentId included). */
  put(tenantId: string, type: string, id: string, attributes?: Record<string, unknown>): void;
  /** The `resolveResource` option: echoes the reference, adds the row's attributes, NOT_FOUND on a miss. */
  resolve: Resolver;
}

export function createProjection(): Projection {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: ResourceRef[] = [];
  const key = (tenantId: string, type: string, id: string) => `${tenantId}\u0000${type}\u0000${id}`;
  return {
    calls,
    put(tenantId, type, id, attributes = {}) {
      rows.set(key(tenantId, type, id), attributes);
    },
    async resolve(reference) {
      const { tenantId, type, id } = reference;
      calls.push({ tenantId, type, id });
      const attributes = rows.get(key(tenantId, type, id));
      if (!attributes) throw new IamError('NOT_FOUND', 'Resource not visible in this tenant', 404);
      return { tenantId, type, id, attributes: { ...attributes } };
    },
  };
}

/** A fresh Ed25519 private JWK usable as an `sts.jwt` signing key. */
export function sessionSigningKey(
  kid = `k-${randomUUID()}`,
): SessionTokenSigningOptions['signingKeys'][number] {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { ...privateKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' };
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps) for a base32 secret, as authenticator apps compute it. */
export function totp(secret: string, at: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid base32 secret');
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const open: IamStore[] = [];
/** Closes every store a fixture opened; register it with `afterEach`. */
export async function closeIamFixtures(): Promise<void> {
  for (const store of open.splice(0)) await store.close();
}

/**
 * A bootstrapped platform with one organization ("Acme"). The primary instance `iam` installs `computePlugin()` and
 * the projection resolver unless `overrides` replace them. `host(options)` builds another IAM instance on the same
 * store and clock with only the options given (no plugin, no resolver), as a second process would.
 */
export async function iamFixture(overrides: Partial<BetterIamOptions> = {}) {
  const database = sqliteAdapter({ filename: ':memory:' });
  open.push(database);
  const inbox: DeliveryMessage[] = [];
  const projection = createProjection();
  let clock = Date.now();
  const authentication: BetterIamOptions['authentication'] = {
    sendEmail: async (message) => {
      inbox.push(message);
    },
    sessionLifetimeMs: 7 * 86_400_000,
    sessionIdleTimeoutMs: 7 * 86_400_000,
    now: () => clock,
  };
  const host = (options: Partial<BetterIamOptions> = {}) =>
    betterIam({
      database,
      secret: SECRET,
      baseURL: ORIGIN,
      ...options,
      authentication: { ...authentication, ...options.authentication },
    });
  const iam = host({
    plugins: [computePlugin()],
    resolveResource: projection.resolve,
    ...overrides,
  });
  await iam.initialize();
  const root = await iam.bootstrap({
    email: 'root@example.test',
    name: 'Root',
    password: 'a strong root test password',
  });
  const rootTenantId = root.tenant.id;
  const challenge = await iam.api.auth.signIn({
    tenantId: rootTenantId,
    email: 'root@example.test',
    password: 'a strong root test password',
  });
  if (!('mfaRequired' in challenge)) throw new Error('Root must require MFA');
  const enrollment = await iam.api.auth.beginMfa({
    tenantId: rootTenantId,
    challenge: challenge.challenge,
  });
  const rootSession = await iam.api.auth.confirmMfa({
    credential: { tenantId: rootTenantId, challenge: challenge.challenge },
    code: totp(enrollment.secret, clock),
  });
  const rootCredential: Credential = { token: rootSession.token };
  const created = await iam.api.tenants.create(rootCredential, {
    parentId: rootTenantId,
    name: 'Acme',
    type: 'organization',
    ownerEmail: 'owner@acme.test',
  });
  await iam.auth.dispatchOutbox();
  const invitation = inbox.find(
    (message) => message.tenantId === created.tenant.id && message.template === 'owner-invitation',
  );
  if (!invitation?.payload.token) throw new Error('No owner invitation was sent');
  const owner = await iam.api.tenants.acceptInvitation({
    tenantId: created.tenant.id,
    token: invitation.payload.token,
    name: 'Owner',
    password: 'a strong tenant owner password',
  });
  if (!('token' in owner)) throw new Error('Unexpected owner MFA');
  const tenantId = created.tenant.id;
  const ownerCredential: Credential = { token: owner.token };
  const ownerId = (await iam.api.auth.getSession(ownerCredential)).identity.id;
  let names = 0;

  /** Stores a policy in Acme as the owner; `policies.create` validates it against the primary host's catalog. */
  const policy = (document: PolicyDocument, name = `policy-${++names}`) =>
    iam.api.policies.create(ownerCredential, { tenantId, name, document });
  /** Binds a new role holding `policyIds` to one identity of Acme. */
  const bind = async (identityId: string, policyIds: string[]) => {
    const role = await iam.api.roles.create(ownerCredential, {
      tenantId,
      name: `role-${++names}`,
      policyIds,
    });
    await iam.api.bindings.create(ownerCredential, {
      tenantId,
      roleId: role.id,
      subjectType: 'identity',
      subjectId: identityId,
    });
    return role;
  };

  return {
    iam,
    database,
    inbox,
    projection,
    root,
    rootTenantId,
    rootCredential,
    tenantId,
    ownerCredential,
    ownerId,
    host,
    policy,
    bind,
    /** Grants documents to an identity through one role (a policy per document). */
    grant: async (identityId: string, ...documents: PolicyDocument[]) => {
      const ids: string[] = [];
      for (const document of documents) ids.push((await policy(document)).id);
      return bind(identityId, ids);
    },
    /** Makes a compute resource visible to the resolver, in Acme unless `tenant` says otherwise. */
    project: (
      type: string,
      id: string,
      attributes: Record<string, unknown> = {},
      tenant: string = tenantId,
    ) => projection.put(tenant, type, id, attributes),
    /** Creates a person `{name}@acme.test` with a password, as the owner. */
    member: (name: string) =>
      iam.api.identities.create(ownerCredential, {
        tenantId,
        email: `${name}@acme.test`,
        name,
        password: `a strong ${name} password`,
      }),
    /** A fresh password session for a member created with `member`. */
    signIn: async (name: string): Promise<Credential> => {
      const result = await iam.api.auth.signIn({
        tenantId,
        email: `${name}@acme.test`,
        password: `a strong ${name} password`,
      });
      if (!('token' in result)) throw new Error('Unexpected MFA');
      return { token: result.token };
    },
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
export type IamFixture = Awaited<ReturnType<typeof iamFixture>>;
