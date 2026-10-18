import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComputeError,
  field,
  manifest,
  type ProviderContext,
  type SqlExecutor,
} from '@better-compute/core';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { accountSubject, defineProvider, vps } from '@better-compute/vps';

// GCP WS1 (keyless tenant accounts): each provider account has a workload identity whose subject vps
// alone fixes, `compute-account:<tenantId>/<provider>/<name>`, because a tenant's workload identity
// provider trusts exactly that subject: a provider choosing its own would let one tenant act as
// another. A provider's network checks of an account (`checkAccount`) run in admission with no
// transaction open, and a provider-declared key (the federation audience) is unique across tenants.

afterEach(closeFixtures);

/** The fixture's issuer: `<baseURL>{basePath}/workload`, where the server serves its discovery. */
const ISSUER = 'https://compute.example.test/api/compute/workload';

/** A JWT's claims (the payload is not verified here: the issuer's own tests verify signatures). */
function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

/**
 * Whether the calling code runs inside a transaction of `database`: a transaction-local setting
 * survives into the next statement only inside one (outside, each statement commits on its own).
 */
async function inTransaction(database: SqlExecutor): Promise<boolean> {
  await database.query(`SELECT set_config('bc_test.marker', 'set', true)`);
  const { rows } = await database.query<{ value: string | null }>(
    `SELECT current_setting('bc_test.marker', true) AS value`,
  );
  return rows[0]?.value === 'set';
}

type CheckContext = ProviderContext & { signal: AbortSignal };

async function world(options: { issuer?: boolean } = {}) {
  /** Every context a client was built with (account create/update checks and real clients). */
  const built: ProviderContext[] = [];
  const checkAccount = vi.fn(async (_config: { audience?: string }, _context: CheckContext) => {});
  const accountKey = vi.fn((config: { audience?: string }) => config.audience);
  const provider = defineProvider({
    id: 'test',
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({ audience: field.string().optional() }),
    checkAccount,
    accountKey,
    create: async (_config, context) => {
      built.push(context);
      return {
        async listOffers() {
          return [];
        },
        async create() {
          throw new ComputeError('UNIMPLEMENTED', 'test');
        },
        async get() {
          return undefined;
        },
        async delete() {},
      };
    },
  });
  const fixture = await computeFixture({
    modules: [vps({ providers: [provider] })],
    ...(options.issuer === false
      ? {}
      : {
          pki: {
            workloadIssuer: workloadIssuer({
              issuer: ISSUER,
              signingKey: generateP256KeyPair().privateKey,
            }),
          },
        }),
  });
  const { compute, tenants, iam } = fixture;
  for (const who of ['root', 'acme', 'other'] as const) iam.allow({ token: tenants[who].token });
  const api = compute.api as any;
  const as = (who: 'acme' | 'other') => ({ token: tenants[who].token });
  const create = (
    who: 'acme' | 'other',
    name: string,
    config: { audience?: string } = {},
    idempotencyKey?: string,
  ) =>
    api.providerAccounts.create(as(who), {
      tenantId: tenants[who].id,
      provider: 'test',
      name,
      config,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  const update = (who: 'acme' | 'other', accountId: string, config: { audience?: string }) =>
    api.providerAccounts.update(as(who), { tenantId: tenants[who].id, accountId, config });
  const list = async (who: 'acme' | 'other') =>
    (await api.providerAccounts.list(as(who), { tenantId: tenants[who].id })).items as unknown[];
  return { fixture, api, tenants, as, create, update, list, built, checkAccount, accountKey };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ code: 'resolved' }) as { code: string; message?: string; details?: unknown },
    (error: ComputeError) => ({ code: error.code, message: error.message, details: error.details }),
  );

describe('provider accounts: the workload identity vps fixes', () => {
  it('identity mints only the account’s subject', async () => {
    const { create, as, api, tenants, built, checkAccount } = await world();
    const subject = 'compute-account:tenant-acme/test/main';
    expect(accountSubject(tenants.acme.id, 'test', 'main')).toBe(subject);

    const account = await create('acme', 'main', { audience: 'aud-main' });
    // The admission check saw the identity of the account about to be stored, with its id.
    const [, checkContext] = checkAccount.mock.calls[0]!;
    expect(checkContext.identity?.subject).toBe(subject);
    expect(checkContext.account).toEqual({
      id: account.id,
      tenantId: tenants.acme.id,
      platform: false,
    });
    expect(checkContext.signal).toBeInstanceOf(AbortSignal);
    // The client built at create, and the one built for real use (offers), carry the same subject.
    await api.providerAccounts.offers(as('acme'), {
      tenantId: tenants.acme.id,
      accountId: account.id,
    });
    expect(built.length).toBeGreaterThanOrEqual(2);
    for (const context of built) expect(context.identity?.subject).toBe(subject);

    const identity = built.at(-1)!.identity!;
    const minted = await identity.mint({ audience: 'aud-main', ttlSeconds: 120 });
    expect(claims(minted.token)).toMatchObject({ iss: ISSUER, sub: subject, aud: 'aud-main' });
    expect(minted.expiresAt).toBe((claims(minted.token).exp as number) * 1000);
    // A subject smuggled into the input is ignored: the account mints only its own.
    const smuggled = await identity.mint({
      audience: 'aud-main',
      subject: 'compute-account:tenant-other/test/main',
    } as never);
    expect(claims(smuggled.token).sub).toBe(subject);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('probe subjects differ from the account’s in the documented way', async () => {
    const { create, built } = await world();
    await create('acme', 'main', { audience: 'aud-main' });
    const identity = built.at(-1)!.identity!;

    const siblings = new Set<string>();
    const strangers = new Set<string>();
    for (let round = 0; round < 5; round++) {
      // sibling: same tenant, a random name shaped like account names.
      const sibling = await identity.mintProbe('sibling', { audience: 'aud-main' });
      const name = /^compute-account:tenant-acme\/test\/([a-z0-9-]+)$/.exec(sibling.subject)?.[1];
      expect(name, sibling.subject).toBeDefined();
      expect(name).not.toBe('main');
      expect(name!.length).toBeGreaterThanOrEqual(8);
      expect(claims(sibling.token)).toMatchObject({ sub: sibling.subject, aud: 'aud-main' });
      siblings.add(sibling.subject);

      // stranger: a random tenant shaped like the real one (same `tenant-` prefix), same name.
      const stranger = await identity.mintProbe('stranger', { audience: 'aud-main' });
      const tenant = /^compute-account:(tenant-[a-z0-9]+)\/test\/main$/.exec(stranger.subject)?.[1];
      expect(tenant, stranger.subject).toBeDefined();
      expect(tenant).not.toBe('tenant-acme');
      expect(claims(stranger.token)).toMatchObject({ sub: stranger.subject, aud: 'aud-main' });
      strangers.add(stranger.subject);
    }
    // Random every time: nothing derived from the account a provider could predict.
    expect(siblings.size).toBe(5);
    expect(strangers.size).toBe(5);
    await expect(identity.mintProbe('self' as never, { audience: 'aud-main' })).rejects.toThrow();
  });
});

describe('provider accounts: checkAccount in admission', () => {
  it('checkAccount runs outside the transaction and its INVALID_CONFIG refuses create', async () => {
    const { fixture, create, list, checkAccount } = await world();
    // The detector itself: inside a transaction of the store, it says so.
    expect(await fixture.database.transaction(() => inTransaction(fixture.database))).toBe(true);
    expect(await inTransaction(fixture.database)).toBe(false);

    const seen: boolean[] = [];
    checkAccount.mockImplementation(async () => {
      seen.push(await inTransaction(fixture.database));
      throw new ComputeError('INVALID_CONFIG', 'The pool does not trust this issuer');
    });
    expect(await failure(create('acme', 'main', { audience: 'aud-main' }))).toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'The pool does not trust this issuer',
    });
    expect(seen).toEqual([false]);
    expect(checkAccount).toHaveBeenCalledTimes(1);
    expect(checkAccount.mock.calls[0]![0]).toEqual({ audience: 'aud-main' });
    expect(await list('acme')).toEqual([]);
  });

  it('checkAccount UNAVAILABLE refuses create; a retry with the same key succeeds', async () => {
    const { create, list, checkAccount } = await world();
    checkAccount.mockRejectedValueOnce(new ComputeError('UNAVAILABLE', 'STS is down'));
    expect(await failure(create('acme', 'main', { audience: 'aud-main' }, 'k-1'))).toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(await list('acme')).toEqual([]);
    const account = await create('acme', 'main', { audience: 'aud-main' }, 'k-1');
    expect(account).toMatchObject({ name: 'main', provider: 'test' });
    expect(checkAccount).toHaveBeenCalledTimes(2);
    // Both checks saw the id the keyed request derives, which is the stored one.
    expect(checkAccount.mock.calls.map(([, context]) => context.account?.id)).toEqual([
      account.id,
      account.id,
    ]);
    // A replay of the finished request decides nothing and checks nothing.
    expect(await create('acme', 'main', { audience: 'aud-main' }, 'k-1')).toEqual(account);
    expect(checkAccount).toHaveBeenCalledTimes(2);
  });

  it('update re-runs checkAccount and moves the exclusive key', async () => {
    const { create, update, checkAccount, api, as, tenants } = await world();
    const account = await create('acme', 'main', { audience: 'aud-1' });
    checkAccount.mockClear();

    const updated = await update('acme', account.id, { audience: 'aud-2' });
    expect(updated).toMatchObject({ version: 2, config: { audience: 'aud-2' } });
    expect(checkAccount).toHaveBeenCalledTimes(1);
    const [config, context] = checkAccount.mock.calls[0]!;
    expect(config).toEqual({ audience: 'aud-2' });
    // The name comes from the stored row.
    expect(context.identity?.subject).toBe('compute-account:tenant-acme/test/main');
    expect(context.account?.id).toBe(account.id);

    // The old key is free again, the new one is taken.
    await create('other', 'theirs', { audience: 'aud-1' });
    expect(await failure(create('other', 'second', { audience: 'aud-2' }))).toMatchObject({
      code: 'CONFLICT',
    });

    // A refusing check refuses the update; nothing changes.
    checkAccount.mockRejectedValueOnce(new ComputeError('INVALID_CONFIG', 'untrusted'));
    expect(await failure(update('acme', account.id, { audience: 'aud-3' }))).toMatchObject({
      code: 'INVALID_CONFIG',
    });
    // Moving onto a key another tenant's account holds is a conflict too.
    expect(await failure(update('acme', account.id, { audience: 'aud-1' }))).toMatchObject({
      code: 'CONFLICT',
      message: 'Another provider account already uses this test identity',
    });
    expect(
      await api.providerAccounts.get(as('acme'), {
        tenantId: tenants.acme.id,
        accountId: account.id,
      }),
    ).toMatchObject({ version: 2, config: { audience: 'aud-2' } });
  });
});

describe('provider accounts: exclusive keys', () => {
  it('two accounts with the same exclusive key conflict across tenants without naming the other', async () => {
    const { create, list, accountKey } = await world();
    const first = await create('acme', 'main', { audience: 'aud-shared' });
    expect(accountKey).toHaveBeenCalledWith({ audience: 'aud-shared' });

    const refused = await failure(create('other', 'theirs', { audience: 'aud-shared' }));
    expect(refused).toEqual({
      code: 'CONFLICT',
      message: 'Another provider account already uses this test identity',
      details: undefined,
    });
    for (const leak of ['acme', first.id, 'main']) expect(refused.message).not.toContain(leak);
    expect(await list('other')).toEqual([]);
    // Accounts without a key never conflict on it.
    await create('acme', 'keyless-a');
    await create('other', 'keyless-b');
    expect(await list('other')).toHaveLength(1);
  });

  it('no issuer configured → identity is undefined', async () => {
    const { create, as, api, tenants, built, checkAccount } = await world({ issuer: false });
    const account = await create('acme', 'main', { audience: 'aud-main' });
    await api.providerAccounts.offers(as('acme'), {
      tenantId: tenants.acme.id,
      accountId: account.id,
    });
    expect(checkAccount).toHaveBeenCalledTimes(1);
    expect(checkAccount.mock.calls[0]![1].identity).toBeUndefined();
    expect(built.length).toBeGreaterThanOrEqual(2);
    for (const context of built) expect(context.identity).toBeUndefined();
  });
});
