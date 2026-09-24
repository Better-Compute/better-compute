import { describe, expect, it } from 'vitest';
import {
  createInstanceForm,
  validateInstance,
  type ComputeRequester,
} from '@better-compute/console-kit';

// The console's instance form: flavors per pool, vps-shaped validation, idempotent submit.

const POOL = 'pool_01jz00000000000000000000pa';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3 alice@laptop';

describe('instance form', () => {
  it('validates like instances.create', () => {
    expect(validateInstance({})).toMatchObject({
      poolId: expect.any(String),
      flavor: expect.any(String),
      imageId: expect.any(String),
    });
    expect(
      validateInstance({
        poolId: POOL,
        flavor: 'g1.small',
        imageId: 'ubuntu-24.04',
        sshKeys: [KEY],
      }),
    ).toEqual({});
    expect(
      validateInstance({ poolId: POOL, flavor: 'g1.small', imageId: 'u', sshKeys: ['nope'] }),
    ).toHaveProperty('sshKeys');
    expect(
      validateInstance({ poolId: POOL, flavor: 'g9.huge', imageId: 'u' }, [
        { name: 'g1.small', vcpu: 2, memoryGiB: 4, diskGiB: 40 },
      ]),
    ).toHaveProperty('flavor', 'This pool does not offer that size');
  });

  it('loads the pool’s flavors and submits the vps shape once per attempt', async () => {
    const calls: { path: string; input: any }[] = [];
    let confirm = true;
    let keys = 0;
    const api: ComputeRequester = {
      async $request<O>(path: string, input?: unknown) {
        calls.push({ path, input });
        if (path === 'flavors/list')
          return { items: [{ name: 'g1.small', vcpu: 2, memoryGiB: 4, diskGiB: 40 }] } as O;
        if (confirm)
          throw Object.assign(new Error('confirm'), {
            code: 'CONFIRMATION_REQUIRED',
            details: { confirmationId: 'c1' },
          });
        return { id: 'inst_1' } as O;
      },
    };
    const form = createInstanceForm(api, { tenantId: 'acme', newKey: () => `k${++keys}` });
    form.change({ poolId: POOL });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(form.get()).toMatchObject({ flavorsStatus: 'ready', flavors: [{ name: 'g1.small' }] });
    form.change({ flavor: 'g9.huge', imageId: 'ubuntu-24.04' });
    expect(form.get().errors.flavor).toBe('This pool does not offer that size');
    form.change({ flavor: 'g1.small', sshKeys: [KEY] });
    expect(form.get().errors).toEqual({});
    expect(await form.submit()).toMatchObject({
      status: 'awaiting-confirmation',
      confirmationId: 'c1',
    });
    confirm = false;
    expect(await form.submit()).toMatchObject({ status: 'done', instance: { id: 'inst_1' } });
    const creates = calls.filter((call) => call.path === 'instances/create');
    expect(creates.map((call) => call.input.idempotencyKey)).toEqual(['k1', 'k1']);
    expect(creates[0]!.input).toEqual({
      tenantId: 'acme',
      poolId: POOL,
      flavor: 'g1.small',
      imageId: 'ubuntu-24.04',
      sshKeys: [KEY],
      idempotencyKey: 'k1',
    });
    form.reset();
    expect(form.get().idempotencyKey).toBe('k2');
  });
});
