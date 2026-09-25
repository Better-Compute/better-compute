import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineDriver, manifest, type SecretStore } from '@better-compute/core';
import { localSealedSecretStore, sealedSecretsMigration } from '@better-compute/pki';
import type { DriverInfo } from '../packages/server/src/api/drivers.js';
import type { SecretInfo } from '../packages/server/src/api/secrets.js';
import { secretsApi } from '../packages/server/src/api/secrets.js';
import { ACME, ROOT, SECRET } from './support/server.js';
import { ADMIN, OUTSIDER, START, USER, type Harness } from './support/server-api.js';
import { v02Harness } from './support/server-v02.js';

// `secrets` (PLAN.md §6, §9.2, §13): write-only, sealed at rest, never read back; events and audit
// rows carry only ref, name and version. `drivers.list` (§5.4): the registered drivers, no config.

const VALUE = 'bmc-password-Kx9#never-shown';
let h: Harness;
let store: SecretStore;

const redfish = defineDriver({
  id: 'redfish',
  version: '1.2.0',
  runsOn: 'site',
  config: manifest({}),
  capabilities: ['virtual-media', 'secure-boot'],
  implements: { power: () => ({}) as never, 'virtual-media': () => ({}) as never } as never,
  retrySafe: { power: ['getPower', 'setPower'] } as never,
});
const ipmi = defineDriver({
  id: 'ipmi',
  version: '0.9.0',
  runsOn: 'site',
  config: manifest({}),
  implements: { power: () => ({}) as never } as never,
});

beforeAll(async () => {
  h = await v02Harness({ drivers: () => [redfish, ipmi] });
  await h.store.migrate([sealedSecretsMigration]);
  // The server's default store seals under the deployment secret; this handle opens the same rows.
  store = localSealedSecretStore({ sql: h.store, keys: SECRET });
  h.iam.allow({ token: USER });
  h.iam.allow({ token: ADMIN });
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const put = (input: object, token = USER) =>
  h.call<SecretInfo>('secrets/put', token, { tenantId: ACME, name: 'bmc-rack1', value: VALUE, idempotencyKey: 'p1', ...input });

async function everywhere(): Promise<string> {
  const tables = await Promise.all(
    ['outbox', 'audit_events', 'secret_refs', 'sealed_secrets'].map(async (table) =>
      JSON.stringify((await h.store.query(`SELECT * FROM ${table}`)).rows, (_key, value: unknown) =>
        value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value,
      ),
    ),
  );
  return [...tables, JSON.stringify(h.iam.calls), JSON.stringify(h.ports.events.published), h.database.log.join('\n')].join('\n');
}

describe('secrets.put', () => {
  it('stores the value sealed, answers with ref and version, and never shows the value', async () => {
    const info = await put({});
    expect(info).toEqual({
      ref: expect.stringMatching(new RegExp(`^secret://${ACME}/sec_`)),
      tenantId: ACME,
      name: 'bmc-rack1',
      version: 1,
      createdAt: START,
      updatedAt: START,
    });
    expect(h.iam.calls.map((call) => call.decision).filter(Boolean)).toEqual([
      { tenantId: ACME, action: 'compute:secrets:manage', resource: { type: 'compute-tenant', id: ACME } },
    ]);
    expect(h.ports.events.published).toEqual([
      { type: 'security.secret.put', tenantId: ACME, subject: 'secret/bmc-rack1', data: { ref: info.ref, name: 'bmc-rack1', version: 1 } },
    ]);
    expect(await everywhere()).not.toContain(VALUE);
    // Only the broker's resolve opens it.
    expect(await store.resolve(info.ref)).toBe(VALUE);
  });

  it('versions each put under the same ref, and replays a retry without writing', async () => {
    const first = await h.call<SecretInfo>('secrets/put', USER, { tenantId: ACME, name: 'rotating', value: 'v1', idempotencyKey: 'r1' });
    const second = await h.call<SecretInfo>('secrets/put', USER, { tenantId: ACME, name: 'rotating', value: 'v2', idempotencyKey: 'r2' });
    expect(second).toMatchObject({ ref: first.ref, version: 2 });
    h.reset();
    expect(await h.call('secrets/put', USER, { tenantId: ACME, name: 'rotating', value: 'v2', idempotencyKey: 'r2' })).toEqual(second);
    expect(h.ports.events.published).toEqual([]);
    expect(h.iam.count('require')).toBe(1); // replays are still decided
    expect(await store.resolve(first.ref)).toBe('v2');
  });

  it('puts platform secrets under the fleet, from the root tenant only', async () => {
    const platform = await put({ tenantId: ROOT, name: 'shared-bmc', scope: 'fleet', idempotencyKey: 'f1' }, ADMIN);
    expect(platform.ref.startsWith(`secret://${ROOT}/`)).toBe(true);
    expect(h.iam.calls.map((call) => call.decision?.resource).filter(Boolean)).toEqual([
      { type: 'compute-fleet', id: 'global' },
    ]);
    const error = await h.failure('secrets/put', USER, { tenantId: ACME, name: 'x', value: 'y', scope: 'fleet', idempotencyKey: 'f2' });
    expect(['ACCESS_DENIED', 'INVALID_INPUT']).toContain(error.code);
    expect((await h.failure('secrets/put', OUTSIDER, { tenantId: ACME, name: 'x', value: 'y', idempotencyKey: 'o' })).code).toBe(
      'ACCESS_DENIED',
    );
  });

  it('validates exactly, without echoing the value', async () => {
    for (const input of [
      { value: '' },
      { value: 'x'.repeat(64 * 1024 + 1) },
      { name: '../etc' },
      { ref: 'secret://acme/other' },
    ]) {
      const error = await h.failure('secrets/put', USER, { tenantId: ACME, name: 'v', value: VALUE, idempotencyKey: 'v', ...input });
      expect(error.code).toBe('INVALID_INPUT');
      expect(JSON.stringify(error)).not.toContain(VALUE);
    }
  });
});

describe('secrets.delete', () => {
  it('deletes the value and its ref, idempotently', async () => {
    const info = await put({ name: 'doomed', idempotencyKey: 'd1' });
    h.reset();
    expect(await h.call('secrets/delete', USER, { tenantId: ACME, name: 'doomed' })).toEqual({ deleted: true });
    expect(h.ports.events.published).toEqual([
      { type: 'security.secret.deleted', tenantId: ACME, subject: 'secret/doomed', data: { ref: info.ref, name: 'doomed', version: 1 } },
    ]);
    await expect(store.resolve(info.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await h.call('secrets/delete', USER, { tenantId: ACME, name: 'doomed' })).toEqual({ deleted: false });
  });

  it('answers UNAVAILABLE without a store (a host that configured none)', async () => {
    // The server always resolves one (the sealed default); the group itself fails closed without.
    const put = secretsApi().secrets.put as unknown as { handler(context: unknown, input: unknown): Promise<unknown> };
    await expect(put.handler({ sql: h.store }, { tenantId: ACME, name: 'n', value: 'v', idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});

describe('drivers.list', () => {
  it('lists declarations only, sorted, filtered by kind, decided on the tenant', async () => {
    const all = await h.call<{ items: DriverInfo[] }>('drivers/list', USER, { tenantId: ACME });
    expect(all.items).toEqual([
      { id: 'ipmi', version: '0.9.0', runsOn: 'site', kinds: ['power'], capabilities: [], retrySafe: {} },
      {
        id: 'redfish',
        version: '1.2.0',
        runsOn: 'site',
        kinds: ['power', 'virtual-media'],
        capabilities: ['secure-boot', 'virtual-media'],
        retrySafe: { power: ['getPower', 'setPower'] },
      },
    ]);
    expect(h.iam.calls.map((call) => call.decision ?? call.authorize).filter(Boolean)).toHaveLength(1);
    const media = await h.call<{ items: DriverInfo[] }>('drivers/list', USER, { tenantId: ACME, kind: 'virtual-media' });
    expect(media.items.map((driver) => driver.id)).toEqual(['redfish']);
  });
});
