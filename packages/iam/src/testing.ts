/**
 * `@better-compute/iam/testing`: a real, embedded better-iam for compute's tests. better-iam runs on
 * in-memory SQLite and carries compute's plugin, resolver and inbox (bound to a compute executor when one is
 * given). It is bootstrapped like better-iam's own fixtures: a root administrator with TOTP MFA, and the
 * organizations "Acme" and "Other", whose owners accepted their invitations. Never use it in production:
 * the secret is fixed and public.
 */
import { createHmac } from 'node:crypto';
import { sqliteAdapter } from '@better-iam/adapter-sqlite';
import type { PolicyDocument } from '@better-iam/core';
import { betterIam, type BetterIam, type BetterIamOptions } from '@better-iam/server';
import type { Credential, SqlExecutor } from '@better-compute/core';
import { createComputeIamBridge, type ComputeIamBridge } from './bridge.js';
import type { ComputeCatalogOptions } from './catalog.js';
import type { EmbeddedIam } from './embedded.js';
import { createRefreshHandler } from './host.js';
import { iamJobReconcilers, type IamJobsHost } from './jobs.js';
import type { ComputeIamPlugin } from './iam-plugin.js';
import { memoryInbox, type MemoryInbox } from './inbox.js';

type DeliveryMessage = Parameters<
  NonNullable<NonNullable<BetterIamOptions['authentication']>['sendEmail']>
>[0];

export const TEST_IAM_ORIGIN = 'http://localhost:3000';
export const TEST_COMPUTE_AUDIENCE = 'https://compute.test';
const secret = 'better-compute-embedded-test-iam-secret-not-for-production';
const passwordOf = (name: string) => `a strong ${name} test password`;

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps) for a base32 secret. */
export function totpCode(base32: string, at: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of base32.replace(/=+$/, '').toUpperCase()) {
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

export interface TestMember {
  identityId: string;
  email: string;
  /** A fresh password session. */
  credential: Credential;
}

/** An organization of the test IAM, managed by its owner. */
export interface TestTenant {
  tenantId: string;
  name: string;
  ownerId: string;
  owner: Credential;
  /** Creates `{name}@{tenant}.test` with a password, and signs it in. */
  member(name: string): Promise<TestMember>;
  /** A new password session for a member created with `member`. */
  signIn(name: string): Promise<Credential>;
  /** Stores a policy (validated against the host's catalog, so compute actions need the plugin). */
  policy(document: PolicyDocument, name?: string): Promise<{ id: string }>;
  /** Grants documents to an identity through one role, a policy per document. */
  grant(identityId: string, ...documents: PolicyDocument[]): Promise<{ id: string }>;
  /** Shares a compute resource with an identity or group (`relationships.create`, relation e.g. `user`). */
  share(
    type: string,
    id: string,
    relation: string,
    subject: { identityId?: string; groupId?: string },
  ): Promise<void>;
}

export interface EmbeddedTestIamOptions
  extends Pick<ComputeCatalogOptions, 'modules' | 'plugins' | 'extra' | 'typePrefix'> {
  /** IAM's authentication clock (sessions, TOTP); default a manual clock starting now. */
  now?: () => number;
  /** A compute executor to bind the bridge to (projection + inbox); `bind(sql)` does it later. */
  sql?: SqlExecutor;
  /** Enables session JWTs with compute's audience (§12.2). */
  sessionJwts?: boolean;
  /** Adds better-iam's scheduler jobs to the iam module. */
  runIamJobs?: boolean;
  /**
   * Where the plugin writes: the bound store (default; events spill until `bind`) or an in-memory inbox
   * that tests can read without a compute database.
   */
  inbox?: 'store' | 'memory';
  /** Extra betterIam() options (merged last; `plugins` are appended after compute's). */
  iamOptions?: Partial<BetterIamOptions>;
  /**
   * How compute reaches IAM (PLAN.md §12.1): `embedded` (in process, `bridge.embedded`) or `remote`
   * (`bridge.remote` over better-iam's HTTP API, with the admission refresh), both on the same better-iam, whose
   * plugin, resolver and projection play the IAM host. Default: `BETTER_COMPUTE_IAM_MODE`, else `embedded`, so a
   * suite runs in both modes unchanged (v0.4 "suites green in both IAM modes").
   */
  mode?: 'embedded' | 'remote';
}

export interface EmbeddedTestIam {
  iam: BetterIam;
  bridge: ComputeIamBridge;
  plugin: ComputeIamPlugin;
  /** The IamPort compute uses (`betterCompute({ iam: port })`): embedded or remote, per `mode`. */
  port: EmbeddedIam;
  readonly mode: 'embedded' | 'remote';
  /** Set with `inbox: 'memory'`. */
  inbox: MemoryInbox | undefined;
  root: { tenantId: string; identityId: string; credential: Credential };
  acme: TestTenant;
  other: TestTenant;
  /** Creates and activates another organization. */
  tenant(name: string): Promise<TestTenant>;
  /** Emails IAM sent (invitations, resets). */
  readonly emails: readonly DeliveryMessage[];
  /** Delivers queued audit events to the plugin (`iam.events.dispatch()`). */
  dispatch(): Promise<number>;
  now(): number;
  /** Moves IAM's authentication clock (only when the default manual clock is in use). */
  advance(ms: number): void;
  /** Binds the bridge (projection + inbox) to a compute executor and loads the projection. */
  bind(sql: SqlExecutor): Promise<void>;
  close(): Promise<void>;
}

export async function createEmbeddedTestIam(
  options: EmbeddedTestIamOptions = {},
): Promise<EmbeddedTestIam> {
  const store = sqliteAdapter({ filename: ':memory:' });
  let manual = Date.now();
  const now = options.now ?? (() => manual);
  const emails: DeliveryMessage[] = [];
  const bridge = createComputeIamBridge({
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(options.extra ? { extra: options.extra } : {}),
    ...(options.typePrefix ? { typePrefix: options.typePrefix } : {}),
  });
  const inbox = options.inbox === 'memory' ? memoryInbox() : undefined;
  const plugin = bridge.plugin(inbox ? { inbox } : {});
  const extra = options.iamOptions ?? {};
  let sts: BetterIamOptions['sts'] | undefined;
  if (options.sessionJwts) {
    const { generateKeyPairSync, randomUUID } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519');
    sts = {
      jwt: {
        signingKeys: [
          { ...privateKey.export({ format: 'jwk' }), kid: `k-${randomUUID()}`, alg: 'EdDSA' },
        ],
        audiences: [TEST_COMPUTE_AUDIENCE],
      },
    } as BetterIamOptions['sts'];
  }
  const iam = betterIam({
    database: store,
    secret,
    baseURL: TEST_IAM_ORIGIN,
    ...(sts ? { sts } : {}),
    ...extra,
    plugins: [plugin, ...(extra.plugins ?? [])],
    resolveResource: extra.resolveResource ?? bridge.resolveResource(),
    authentication: {
      sendEmail: async (message) => {
        emails.push(message);
      },
      sessionLifetimeMs: 7 * 86_400_000,
      sessionIdleTimeoutMs: 7 * 86_400_000,
      now,
      ...extra.authentication,
    },
  });
  await iam.initialize();

  const rootEmail = 'root@root.test';
  const bootstrapped = await iam.bootstrap({
    email: rootEmail,
    name: 'Root',
    password: passwordOf('root'),
  });
  const rootTenantId = bootstrapped.tenant.id;
  const challenge = await iam.api.auth.signIn({
    tenantId: rootTenantId,
    email: rootEmail,
    password: passwordOf('root'),
  });
  if (!('mfaRequired' in challenge)) throw new Error('The root administrator must require MFA');
  const enrollment = await iam.api.auth.beginMfa({
    tenantId: rootTenantId,
    challenge: challenge.challenge,
  });
  const rootSession = await iam.api.auth.confirmMfa({
    credential: { tenantId: rootTenantId, challenge: challenge.challenge },
    code: totpCode(enrollment.secret, now()),
  });
  const root = {
    tenantId: rootTenantId,
    identityId: bootstrapped.identity.id,
    credential: { token: rootSession.token } as Credential,
  };
  const mode =
    options.mode ?? (process.env.BETTER_COMPUTE_IAM_MODE === 'remote' ? 'remote' : 'embedded');
  let port: EmbeddedIam;
  if (mode === 'remote') {
    // The IAM host is this better-iam: its HTTP handler, compute's plugin and resolver, and the bridge's
    // projection (bound to compute's store, as `replicaProjection` would be) behind the admission refresh.
    const refreshSecret = 'better-compute-test-iam-refresh-secret-0123456789';
    const refresh = createRefreshHandler({ projection: bridge.projection, secret: refreshSecret });
    port = bridge.remote({
      baseURL: TEST_IAM_ORIGIN,
      fetch: async (input, init) => iam.handler(new Request(input, init)),
      serviceToken: () => root.credential.token!,
      rootTenantId,
      authorizeSessions: true,
      refresh: {
        url: `${TEST_IAM_ORIGIN}/compute/refresh`,
        secret: refreshSecret,
        fetch: async (input, init) => refresh(new Request(input, init)),
      },
    });
    // The IAM host's own scheduler (audit hook dispatch, outbox, budgets), run here as the host would run it.
    if (options.runIamJobs)
      bridge.modules[0].reconcilers!.push(...iamJobReconcilers(iam as unknown as IamJobsHost));
  } else
    port = bridge.embedded(iam, {
      rootTenantId,
      // The root administrator doubles as compute's service account for the billing members.
      serviceCredential: root.credential,
      ...(options.runIamJobs ? { runIamJobs: true } : {}),
    });

  let names = 0;
  const tenant = async (name: string): Promise<TestTenant> => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const ownerEmail = `owner@${slug}.test`;
    const created = await iam.api.tenants.create(root.credential, {
      parentId: rootTenantId,
      name,
      type: 'organization',
      ownerEmail,
    });
    const tenantId = created.tenant.id;
    await iam.auth.dispatchOutbox();
    const invitation = emails.find(
      (message) => message.tenantId === tenantId && message.template === 'owner-invitation',
    );
    if (!invitation?.payload.token) throw new Error(`No owner invitation was sent for ${name}`);
    const accepted = await iam.api.tenants.acceptInvitation({
      tenantId,
      token: invitation.payload.token,
      name: `${name} owner`,
      password: passwordOf(`${slug} owner`),
    });
    if (!('token' in accepted)) throw new Error('Unexpected owner MFA');
    const owner: Credential = { token: accepted.token };
    const ownerId = (await iam.api.auth.getSession(owner)).identity.id;
    const emailOf = (member: string) => `${member}@${slug}.test`;
    const signIn = async (member: string): Promise<Credential> => {
      const result = await iam.api.auth.signIn({
        tenantId,
        email: emailOf(member),
        password: passwordOf(member),
      });
      if (!('token' in result)) throw new Error('Unexpected MFA');
      return { token: result.token };
    };
    const policy = (document: PolicyDocument, policyName = `policy-${++names}`) =>
      iam.api.policies.create(owner, { tenantId, name: policyName, document });
    return {
      tenantId,
      name,
      ownerId,
      owner,
      async member(member) {
        const identity = await iam.api.identities.create(owner, {
          tenantId,
          email: emailOf(member),
          name: member,
          password: passwordOf(member),
        });
        return {
          identityId: identity.id,
          email: emailOf(member),
          credential: await signIn(member),
        };
      },
      signIn,
      policy,
      async grant(identityId, ...documents) {
        const policyIds: string[] = [];
        for (const document of documents) policyIds.push((await policy(document)).id);
        const role = await iam.api.roles.create(owner, {
          tenantId,
          name: `role-${++names}`,
          policyIds,
        });
        await iam.api.bindings.create(owner, {
          tenantId,
          roleId: role.id,
          subjectType: 'identity',
          subjectId: identityId,
        });
        return { id: role.id };
      },
      async share(type, id, relation, subject) {
        const subjectType = subject.groupId ? 'group' : 'identity';
        const subjectId = subject.groupId ?? subject.identityId;
        if (!subjectId) throw new Error('share() needs an identityId or a groupId');
        await iam.api.relationships.create(owner, {
          tenantId,
          type,
          id,
          relation,
          subjectType,
          subjectId,
        });
      },
    };
  };

  const acme = await tenant('Acme');
  const other = await tenant('Other');
  if (options.sql) await bridge.bind({ sql: options.sql });

  return {
    iam,
    bridge,
    plugin,
    port,
    mode,
    inbox,
    root,
    acme,
    other,
    tenant,
    get emails() {
      return emails;
    },
    async dispatch() {
      return (await iam.events.dispatch()).dispatched;
    },
    now,
    advance(ms) {
      if (options.now) throw new Error('advance() works only with the default clock');
      manual += ms;
    },
    bind: (sql) => bridge.bind({ sql }),
    async close() {
      await bridge.stop();
      await store.close();
    },
  };
}
