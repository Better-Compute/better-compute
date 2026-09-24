import { describe, expect, it } from 'vitest';
import { reservationStateTable } from '@better-compute/core';
import {
  capacityChart,
  createDetail,
  createPermissions,
  createReservationForm,
  validateReservation,
  type ComputeRequester,
} from '@better-compute/console-kit';

// console-kit view models: detail pages with state- and IAM-gated actions, the capacity chart
// model, and the reservation form (validation, preview, idempotent submit, confirmation).

function fakeApi(responses: Record<string, (input: any) => unknown>) {
  const calls: { path: string; input: any }[] = [];
  const api: ComputeRequester = {
    async $request<O>(path: string, input?: unknown) {
      calls.push({ path, input });
      const respond = responses[path];
      if (!respond) throw Object.assign(new Error(`no ${path}`), { code: 'NOT_FOUND' });
      return respond(input) as O;
    },
  };
  return { api, calls };
}

const fail = (code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, ...(details ? { details } : {}) });

describe('detail view models', () => {
  it('gates reservation actions by state and IAM, and reports confirmations', async () => {
    let state = 'active';
    const { api, calls } = fakeApi({
      'reservations/get': () => ({ id: 'rsv_1', state }),
      'reservations/release': () => {
        throw fail('CONFIRMATION_REQUIRED', { confirmationId: 'conf_1' });
      },
    });
    const permissions = createPermissions({
      authorize: async (checks) =>
        checks.map((check) => check.action !== 'compute:reservations:extend'),
    });
    const detail = createDetail(api, {
      tenantId: 'acme',
      kind: 'reservation',
      id: 'rsv_1',
      permissions,
    });
    await detail.refresh();
    const actions = Object.fromEntries(
      detail.get().actions.map((action) => [action.method, action]),
    );
    const exits = reservationStateTable.transitions.active;
    expect(actions.release!.applicable).toBe(Object.hasOwn(exits, 'release'));
    expect(actions.release!.applicable).toBe(true);
    expect(actions.cancel?.applicable ?? false).toBe(Object.hasOwn(exits, 'cancel'));
    expect(actions.release!.allowed).toBe(true);
    expect(actions.extend!.allowed).toBe(false);

    expect(await detail.run('reservations/release')).toEqual({
      status: 'confirmation-required',
      confirmationId: 'conf_1',
    });
    expect(calls.find((call) => call.path === 'reservations/release')!.input).toEqual({
      tenantId: 'acme',
      reservationId: 'rsv_1',
    });
    await expect(detail.run('nodes/cordon')).rejects.toThrow(/not an action/);

    // An event about it refreshes; a terminal state disables everything.
    state = 'released';
    await detail.applyEvent({
      id: '9',
      type: 'reservation.released',
      tenantId: 'acme',
      subject: 'reservation/rsv_1',
    });
    expect(detail.get().actions.every((action) => !action.applicable)).toBe(true);
  });

  it('gates cordon by the node flag and marks a vanished item gone', async () => {
    let exists = true;
    const { api } = fakeApi({
      'nodes/get': () => {
        if (!exists) throw fail('NOT_FOUND');
        return { id: 'node_1', cordoned: false, provisionState: 'adopted' };
      },
    });
    const detail = createDetail(api, { tenantId: 'acme', kind: 'node', id: 'node_1' });
    await detail.refresh();
    const byPath = (path: string) => detail.get().actions.find((action) => action.path === path)!;
    expect(byPath('nodes/cordon').applicable).toBe(true);
    expect(byPath('nodes/uncordon').applicable).toBe(false);
    expect(byPath('nodes/cordon').allowed).toBeUndefined();
    exists = false;
    await detail.refresh();
    expect(detail.get().status).toBe('gone');
  });
});

describe('capacity chart', () => {
  it('stacks buckets that add up, per pool and per GPU model', () => {
    const row = (
      total: number,
      allocatable: number,
      allocated: number,
      reserved: number,
      available: number,
    ) => ({
      resource: 'gpu',
      total,
      allocatable,
      allocated,
      reserved,
      available,
    });
    const chart = capacityChart({
      pools: [
        { poolId: 'pool_a', gpuModel: 'H100', owned: true, capacity: [row(16, 16, 8, 2, 6)] },
        { poolId: 'pool_b', gpuModel: 'H100', owned: false, capacity: [row(8, 6, 6, 0, 0)] },
        { poolId: 'pool_c', gpuModel: 'L40S', owned: true, capacity: [row(4, 4, 0, 0, 4)] },
        { poolId: 'pool_d', gpuModel: 'L40S', owned: true, capacity: [] },
      ],
    });
    expect(chart.bars.map((bar) => bar.poolId)).toEqual(['pool_b', 'pool_a', 'pool_c']);
    for (const bar of chart.bars)
      expect(bar.allocated + bar.reserved + bar.available + bar.unavailable).toBe(bar.total);
    expect(chart.bars[0]).toMatchObject({ unavailable: 2, utilization: 1 });
    expect(chart.byGpuModel[0]).toMatchObject({ gpuModel: 'H100', total: 24, allocated: 14 });
    expect(chart.totals).toMatchObject({ total: 28, allocated: 14, available: 10 });
    expect(chart.totals.utilization).toBeCloseTo(14 / 26);
  });
});

describe('reservation form', () => {
  it('validates like the server', () => {
    expect(validateReservation({})).toMatchObject({
      poolId: expect.any(String),
      gpus: expect.any(String),
      duration: expect.any(String),
    });
    expect(validateReservation({ poolId: 'p', gpus: 4, duration: '8h' })).toEqual({});
    expect(validateReservation({ poolId: 'p', gpus: 65, duration: '8 hours' })).toMatchObject({
      gpus: expect.any(String),
      duration: expect.any(String),
    });
    expect(
      validateReservation({
        poolId: 'p',
        gpus: 1,
        duration: '1h',
        selector: [{ key: 'vramGiB', op: 'Near' }],
      }),
    ).toHaveProperty('selector');
  });

  it('previews after edits and submits once per attempt, through a confirmation', async () => {
    const timers: (() => void)[] = [];
    let keys = 0;
    let confirm = true;
    const { api, calls } = fakeApi({
      'capacity/preview': () => ({ fits: false, reason: 'Only 2 GPUs free', candidates: [] }),
      'reservations/create': () => {
        if (confirm) throw fail('CONFIRMATION_REQUIRED', { confirmationId: 'conf_9' });
        return { id: 'rsv_9', state: 'placed' };
      },
    });
    const form = createReservationForm(api, {
      tenantId: 'acme',
      setTimer: (callback) => timers.push(callback),
      clearTimer: () => undefined,
      newKey: () => `key-${++keys}`,
    });
    form.change({ poolId: 'pool_a', gpus: 4, duration: '8h', gpuModel: 'H100', nvlink: true });
    timers.at(-1)!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(form.get().preview).toEqual({ fits: false, reason: 'Only 2 GPUs free', candidates: 0 });
    expect(calls[0]!.input).toMatchObject({
      tenantId: 'acme',
      poolId: 'pool_a',
      devices: [
        {
          class: 'gpu',
          count: 4,
          topology: 'nvlink-all',
          selector: { matchExpressions: [{ key: 'gpuModel', op: 'In', values: ['H100'] }] },
        },
      ],
    });

    const key = form.get().idempotencyKey;
    expect(await form.submit()).toMatchObject({
      status: 'awaiting-confirmation',
      confirmationId: 'conf_9',
    });
    confirm = false; // a person approved it
    expect(await form.submit()).toMatchObject({ status: 'done', reservation: { id: 'rsv_9' } });
    const creates = calls.filter((call) => call.path === 'reservations/create');
    expect(creates.map((call) => call.input.idempotencyKey)).toEqual([key, key]);
    // Done: another click does nothing; reset starts a new attempt with a new key.
    await form.submit();
    expect(calls.filter((call) => call.path === 'reservations/create')).toHaveLength(2);
    form.reset();
    expect(form.get().idempotencyKey).not.toBe(key);
    expect(form.get().status).toBe('editing');
  });

  it('does not submit an invalid form', async () => {
    const { api, calls } = fakeApi({});
    const form = createReservationForm(api, { tenantId: 'acme', setTimer: () => undefined });
    expect((await form.submit()).status).toBe('editing');
    expect(calls).toEqual([]);
  });
});
