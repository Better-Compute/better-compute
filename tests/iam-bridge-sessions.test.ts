import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError, type Decision } from '@better-compute/core';
import {
  embeddedIam,
  remoteIam,
  tunnelAuthorizer,
  type RemoteIamClient,
} from '@better-compute/iam';
import { closeIamFixtures, iamFixture, type IamFixture } from './support/iam.js';

// `IamPort.authorizeSession` (core f3bfa70) on a real (vendored) better-iam: re-deciding for a recorded session
// without its credential, as tunnels do every 60 s (PLAN.md §7.6). It holds while the session is live, the
// identity active and the policy allows; revocation, deactivation or a lost grant make it false.

afterEach(closeIamFixtures);

async function setup() {
  const f = await iamFixture();
  // The reviewer is the deployment's root service account (a root administrator here).
  const port = embeddedIam(f.iam, { sessionReviewer: f.rootCredential });
  const alice = await f.member('alice');
  await f.grant(alice.id, {
    version: 1,
    statements: [
      { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
    ],
  });
  f.project('compute-pool', 'pool_1');
  const credential = await f.signIn('alice');
  const caller = await port.authenticate(credential);
  const read: Decision = {
    tenantId: f.tenantId,
    action: 'compute:pools:read',
    resource: { type: 'compute-pool', id: 'pool_1' },
  };
  return { f, port, alice, credential, caller, read };
}

const session = (caller: { identityId: string; sessionId: string }) => ({
  identityId: caller.identityId,
  sessionId: caller.sessionId,
});

describe('authorizeSession (embedded)', () => {
  it('allows while the session is live and the policy allows, and not beyond the grant', async () => {
    const { f, port, caller, read } = await setup();
    expect(await port.authorizeSession!(session(caller), read)).toBe(true);
    expect(
      await port.authorizeSession!(session(caller), {
        ...read,
        action: 'compute:reservations:create',
        resource: { type: 'compute-pool', id: 'pool_1' },
      }),
    ).toBe(false);
    // Another session id of the same identity, or an identity of another tenant, is not live here.
    expect(
      await port.authorizeSession!({ ...session(caller), sessionId: 'ses_missing' }, read),
    ).toBe(false);
    expect(
      await port.authorizeSession!(session(caller), { ...read, tenantId: f.rootTenantId }),
    ).toBe(false);
  });

  it('turns false once the session is revoked', async () => {
    const { f, port, alice, caller, read } = await setup();
    await f.iam.api.identities.revokeSessions(f.ownerCredential, {
      tenantId: f.tenantId,
      identityId: alice.id,
    });
    expect(await port.authorizeSession!(session(caller), read)).toBe(false);
  });

  it('turns false once the identity is deactivated', async () => {
    const { f, port, alice, read } = await setup();
    const again = await port.authenticate(await f.signIn('alice'));
    expect(await port.authorizeSession!(session(again), read)).toBe(true);
    await f.iam.api.identities.setStatus(f.ownerCredential, {
      tenantId: f.tenantId,
      identityId: alice.id,
      status: 'disabled',
    });
    expect(await port.authorizeSession!(session(again), read)).toBe(false);
  });

  it('throws when the reviewer lacks the rights to review (a configuration error, not a denial)', async () => {
    const { f, caller, read } = await setup();
    const narrow = embeddedIam(f.iam, { sessionReviewer: f.ownerCredential });
    await expect(
      narrow.authorizeSession!(session(caller), { ...read, tenantId: f.rootTenantId }),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'ACCESS_DENIED'));
  });

  it('is absent without a session reviewer', async () => {
    const f = await iamFixture();
    expect(embeddedIam(f.iam).authorizeSession).toBeUndefined();
  });
});

describe('Caller.sessionExpiresAt', () => {
  it('is the session expiry, or sooner its idle deadline when the host gives the idle timeout', async () => {
    const f = await iamFixture();
    await f.member('bob');
    const credential = await f.signIn('bob');
    const plain = await embeddedIam(f.iam).authenticate(credential);
    // The fixture's sessions last 7 days.
    expect(plain.sessionExpiresAt).toBeGreaterThan(f.now() + 6 * 86_400_000);
    expect(plain.sessionExpiresAt).toBeLessThanOrEqual(f.now() + 7 * 86_400_000);
    const idle = await embeddedIam(f.iam, { sessionIdleTimeoutMs: 15 * 60_000 }).authenticate(
      credential,
    );
    expect(idle.sessionExpiresAt).toBeGreaterThan(f.now());
    expect(idle.sessionExpiresAt).toBeLessThanOrEqual(f.now() + 15 * 60_000);
  });

  it('comes from sts.getCallerIdentity in remote mode', async () => {
    const client = {
      sts: {
        getCallerIdentity: async () => ({
          identityId: 'idn_1',
          identityKind: 'user',
          tenantId: 'ten_1',
          sessionId: 'ses_1',
          sessionKind: 'user',
          mfa: false,
          expiresAt: 1_900_000_000_000,
        }),
      },
    } as unknown as RemoteIamClient;
    const port = remoteIam({
      baseURL: 'https://iam.test',
      client,
      serviceToken: 't',
      rootTenantId: 'r',
    });
    expect((await port.authenticate({ token: 'x' })).sessionExpiresAt).toBe(1_900_000_000_000);
  });
});
describe('tunnelAuthorizer', () => {
  const claims = (
    f: IamFixture,
    caller: { identityId: string; sessionId: string },
    extra = {},
  ) => ({
    iss: 'compute',
    aud: 'node:node_1' as const,
    sub: caller.identityId,
    ses: caller.sessionId,
    sid: 'tun_1',
    op: 'exec' as const,
    jti: 'j1',
    iat: 0,
    exp: 0,
    tnt: f.tenantId,
    inst: 'inst_1',
    ...extra,
  });

  it('re-decides compute:instances:exec by session, or by the credential when the client sent one', async () => {
    const { f, port, alice, credential, caller } = await setup();
    f.project('compute-instance', 'inst_1');
    const authorize = tunnelAuthorizer(port);
    // Alice may read pools but not exec into instances.
    expect(await authorize({ claims: claims(f, caller) })).toBe(false);
    expect(await authorize({ claims: claims(f, caller), credential })).toBe(false);
    await f.grant(alice.id, {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:instances:exec'], resources: ['compute-instance/*'] },
      ],
    });
    expect(await authorize({ claims: claims(f, caller) })).toBe(true);
    expect(await authorize({ claims: claims(f, caller), credential })).toBe(true);
    // A ticket without a session or a tenant cannot be re-verified.
    expect(await authorize({ claims: claims(f, caller, { ses: undefined }) })).toBe(false);
    expect(await authorize({ claims: claims(f, caller, { tnt: undefined }) })).toBe(false);
    // A port that cannot re-decide by session is a configuration error, not a silent allow.
    await expect(
      tunnelAuthorizer(embeddedIam(f.iam))({ claims: claims(f, caller) }),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'INVALID_CONFIG'));
  });
});

describe('tunnelAuthorizer actions', () => {
  it('re-decides the action the ticket was issued for, failing closed on anything else', async () => {
    const { f, port, alice, caller } = await setup();
    f.project('compute-node', 'node_1');
    f.project('compute-instance', 'inst_1');
    f.project('compute-sandbox', 'sbx_1');
    await f.grant(alice.id, {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:nodes:console'], resources: ['compute-node/*'] },
        { effect: 'allow', actions: ['compute:sandboxes:exec'], resources: ['compute-sandbox/*'] },
      ],
    });
    const authorize = tunnelAuthorizer(port);
    const ticket = (extra: Record<string, unknown>) => ({
      aud: 'node:node_1',
      sub: caller.identityId,
      ses: caller.sessionId,
      op: 'console',
      tnt: f.tenantId,
      ...extra,
    });
    // A node ticket is the console of the node.
    expect(await authorize({ claims: ticket({}) })).toBe(true);
    expect(await authorize({ claims: ticket({ act: 'compute:nodes:console' }) })).toBe(true);
    // An instance ticket needs exec on the instance, which Alice lacks.
    expect(await authorize({ claims: ticket({ inst: 'inst_1', op: 'exec' }) })).toBe(false);
    // A stamped action that does not match the target, or is unknown, fails closed.
    expect(await authorize({ claims: ticket({ act: 'compute:instances:exec' }) })).toBe(false);
    expect(await authorize({ claims: ticket({ act: 'compute:nodes:delete' }) })).toBe(false);
    // A sandbox's exec ticket is decided on the sandbox (Alice may exec into it, not into its instance).
    const sandbox = { inst: 'inst_1', sbx: 'sbx_1', op: 'ssh', act: 'compute:sandboxes:exec' };
    expect(await authorize({ claims: ticket(sandbox) })).toBe(true);
    expect(await authorize({ claims: ticket({ ...sandbox, sbx: undefined }) })).toBe(false);
    expect(await authorize({ claims: ticket({ ...sandbox, inst: undefined }) })).toBe(false);
    expect(await authorize({ claims: ticket({ ...sandbox, act: 'compute:instances:exec' }) })).toBe(
      false,
    );
    expect(await authorize({ claims: ticket({ ...sandbox, act: undefined }) })).toBe(false);
  });
});
describe('authorizeSession (remote)', () => {
  it('uses the service credential for the administrator reads, only when enabled', async () => {
    const calls: { method: string; authorization: string | null }[] = [];
    const header = (options?: { headers?: HeadersInit }) =>
      new Headers(options?.headers).get('authorization');
    const client = {
      identities: {
        listSessions: async (_input: unknown, options?: { headers?: HeadersInit }) => {
          calls.push({ method: 'listSessions', authorization: header(options) });
          return [{ id: 'ses_1', kind: 'user', expiresAt: Date.now() + 60_000, mfa: false }];
        },
        get: async (_input: unknown, options?: { headers?: HeadersInit }) => {
          calls.push({ method: 'get', authorization: header(options) });
          return { status: 'active' };
        },
      },
      policies: {
        simulate: async (input: { action: string }, options?: { headers?: HeadersInit }) => {
          calls.push({ method: 'simulate', authorization: header(options) });
          return { allowed: input.action === 'compute:instances:exec' };
        },
      },
    } as unknown as RemoteIamClient;
    const base = {
      baseURL: 'https://iam.test',
      client,
      serviceToken: 'svc-token',
      rootTenantId: 'ten_root',
    };
    expect(remoteIam(base).authorizeSession).toBeUndefined();
    const port = remoteIam({ ...base, authorizeSessions: true });
    const decision: Decision = {
      tenantId: 'ten_1',
      action: 'compute:instances:exec',
      resource: { type: 'compute-instance', id: 'inst_1' },
    };
    expect(
      await port.authorizeSession!({ identityId: 'idn_1', sessionId: 'ses_1' }, decision),
    ).toBe(true);
    expect(
      await port.authorizeSession!({ identityId: 'idn_1', sessionId: 'ses_2' }, decision),
    ).toBe(false);
    expect(calls.every((call) => call.authorization === 'Bearer svc-token')).toBe(true);
    expect(calls.map((call) => call.method)).toEqual([
      'listSessions',
      'get',
      'simulate',
      'listSessions',
    ]);
  });
});
