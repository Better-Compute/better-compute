import { randomBytes } from 'node:crypto';
import { parseSelector } from '@better-compute/capacity';
import {
  ComputeError,
  parseDuration,
  type DeviceRequest,
  type MatchExpression,
} from '@better-compute/core';
import { usageError } from '../errors.js';
import { defineCommand, type FlagSpec } from '../framework.js';

/**
 * Shortcuts for the capacity groups (PLAN.md §9.3 "Commands mirror the API groups"): each builds
 * the request body and calls the route as BETTER_COMPUTE_TOKEN, in process or with --url, exactly
 * like `better-compute api GROUP.METHOD`.
 */

export const tenantFlag: FlagSpec = {
  type: 'string',
  value: 'ID',
  required: true,
  env: 'BETTER_COMPUTE_TENANT',
  description: 'The tenant acting (the caller’s organization)',
};

/** A fresh idempotency key for one command invocation; pass --key to retry the same request. */
export function newIdempotencyKey(): string {
  return `cli-${randomBytes(12).toString('hex')}`;
}

/**
 * An absolute time: an ISO 8601 timestamp, epoch milliseconds, or `+DURATION` from now
 * (`+2h`). Throws a usage error naming the flag.
 */
export function parseTime(value: string, now: number, flag: string): number {
  const text = value.trim();
  if (text.startsWith('+')) {
    try {
      return now + parseDuration(text.slice(1));
    } catch {
      throw usageError(`--${flag} ${value}: a relative time looks like +30m, +2h or +1d`);
    }
  }
  if (/^\d{10,16}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(parsed))
    throw usageError(`--${flag} ${value}: use an ISO 8601 time, epoch milliseconds or +DURATION`);
  return parsed;
}

/** Host resources and the binding a reservation books with its GPUs (§3.8). */
const hostFlags = {
  cpus: {
    type: 'integer',
    value: 'N',
    min: 0,
    max: 4096,
    description: "Host CPUs to book with the GPUs (default: the pool's per-GPU share)",
  },
  memory: {
    type: 'integer',
    value: 'GIB',
    min: 0,
    max: 65_536,
    description: "Host memory in GiB to book with the GPUs (default: the pool's per-GPU share)",
  },
  kubernetes: {
    type: 'boolean',
    description: "Give the GPUs to the node's kubelet (pools that join a Kubernetes cluster)",
  },
} as const satisfies Record<string, FlagSpec>;

function hostFields(flags: { cpus?: number | undefined; memory?: number | undefined; kubernetes?: boolean | undefined }) {
  const resources: Record<string, number> = {};
  if (typeof flags.cpus === 'number') resources.vcpu = flags.cpus;
  if (typeof flags.memory === 'number') resources.memoryGiB = flags.memory;
  return {
    binding: flags.kubernetes === true ? 'kubernetes' : 'hold',
    ...(Object.keys(resources).length ? { resources } : {}),
  };
}

function checkDuration(value: string, flag: string): string {
  try {
    parseDuration(value);
  } catch {
    throw usageError(`--${flag} ${value}: a duration looks like 30m, 8h or 7d`);
  }
  return value;
}

interface QueuedReservation {
  id: string;
  state: string;
  conditions?: { type: string; status: string }[];
}

/** Waiting for the pool-lease placer: `pending` with a true `Queued` condition. */
export const isQueued = (reservation: QueuedReservation): boolean =>
  reservation.state === 'pending' &&
  (reservation.conditions ?? []).some(
    (condition) => condition.type === 'Queued' && condition.status === 'true',
  );

/** The device request `reserve` sends: a GPU count, and a selector from the shorthand and --model. */
export function gpuRequest(options: {
  gpus: number;
  selector?: string;
  model?: string;
  product?: string;
  nvlink?: boolean;
}): DeviceRequest {
  const expressions: MatchExpression[] = [];
  if (options.selector) {
    try {
      expressions.push(...parseSelector(options.selector).matchExpressions);
    } catch (error) {
      if (error instanceof ComputeError) throw usageError(`--selector: ${error.message}`);
      throw error;
    }
  }
  if (options.model) expressions.push({ key: 'gpuModel', op: 'In', values: [options.model] });
  if (options.product) expressions.push({ key: 'gpuProduct', op: 'In', values: [options.product] });
  const request: DeviceRequest = { class: 'gpu', count: options.gpus };
  if (expressions.length) request.selector = { matchExpressions: expressions };
  if (options.nvlink) request.topology = 'nvlink-all';
  return request;
}

const reservationArg = [
  { name: 'reservation', description: 'The reservation id (rsv_…)', required: true },
];

function reservationId(args: string[]): string {
  const id = args[0]!;
  if (!/^rsv_[0-9a-z]{26,52}$/.test(id)) throw usageError(`${id} is not a reservation id (rsv_…)`);
  return id;
}

export const capacityCommands = [
  defineCommand({
    name: 'reserve',
    group: 'Capacity',
    summary: 'Reserve GPUs from a pool (reservations.create)',
    description:
      "reserve asks for --gpus whole GPUs from --pool for --for, decided by better-iam as compute:reservations:create on the reservation draft and placed by the pool's placer (PLAN.md §3.4, §10.3). --selector takes the shorthand `gpuProduct in (H100-SXM5-80GB), vramGiB >= 80`; --model and --product add a gpuModel or gpuProduct match. It waits up to --wait seconds for the placement and prints the reservation, whose binding lists the booked GPU UUIDs once active. Every run sends a new idempotency key unless --key is given: repeat the command with the same --key to retry safely.",
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: {
        type: 'string',
        value: 'ID',
        required: true,
        description: 'The pool to reserve from (pool_…)',
      },
      gpus: {
        type: 'integer',
        value: 'N',
        required: true,
        min: 1,
        max: 64,
        description: 'Whole GPUs to reserve',
      },
      for: {
        type: 'string',
        value: 'DURATION',
        required: true,
        description: 'How long: 30m, 8h, 7d',
      },
      selector: {
        type: 'string',
        value: 'EXPR',
        description: 'Device selector shorthand, e.g. "vramGiB >= 80"',
      },
      model: { type: 'string', value: 'MODEL', description: 'GPU model family, e.g. H100' },
      product: {
        type: 'string',
        value: 'PRODUCT',
        description: 'GPU product, e.g. H100-SXM5-80GB',
      },
      nvlink: { type: 'boolean', description: 'All GPUs must share one NVLink domain' },
      project: {
        type: 'string',
        value: 'ID',
        description: 'Project to account the reservation to (prj_…)',
      },
      start: {
        type: 'string',
        value: 'TIME',
        description: 'Start later: ISO 8601 time or +DURATION (default now)',
      },
      lease: {
        type: 'integer',
        value: 'SECONDS',
        min: 30,
        max: 86_400,
        description: 'Renewable lease: released unless renewed within this many seconds',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry an earlier request',
      },
      wait: {
        type: 'integer',
        value: 'SECONDS',
        min: 0,
        max: 30,
        default: 20,
        description: 'How long to wait for the placement',
      },
      ...hostFlags,
    },
    examples: [
      'better-compute reserve --pool pool_01k… --gpus 4 --for 8h',
      'better-compute reserve --pool pool_01k… --gpus 2 --for 8h --cpus 32 --memory 256 --kubernetes',
      'better-compute reserve --pool pool_01k… --gpus 8 --for 3d --model H100 --nvlink --selector "vramGiB >= 80"',
      'better-compute reserve --pool pool_01k… --gpus 2 --for 1h --start +2h --key nightly-2026-09-24',
    ],
    async run({ flags, api, note }) {
      const idempotencyKey = flags.key ?? newIdempotencyKey();
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
        throw usageError('--key may use letters, digits and . _ : - (at most 128)');
      const body: Record<string, unknown> = {
        tenantId: flags.tenant!,
        poolId: flags.pool!,
        devices: [
          gpuRequest({
            gpus: flags.gpus!,
            ...(flags.selector ? { selector: flags.selector } : {}),
            ...(flags.model ? { model: flags.model } : {}),
            ...(flags.product ? { product: flags.product } : {}),
            nvlink: flags.nvlink,
          }),
        ],
        duration: checkDuration(flags.for!, 'for'),
        ...hostFields(flags),
        idempotencyKey,
        wait: { timeoutMs: (flags.wait ?? 20) * 1000 },
      };
      if (flags.project) body.projectId = flags.project;
      if (flags.start) body.start = parseTime(flags.start, Date.now(), 'start');
      if (flags.lease !== undefined) body.leaseSeconds = flags.lease;
      if (!flags.key)
        note(
          `Idempotency key ${idempotencyKey} (pass --key ${idempotencyKey} to retry this request).`,
        );
      const transport = await api();
      const deadline = Date.now() + (flags.wait ?? 20) * 1000;
      let reservation = (await transport.call('reservations/create', body)) as QueuedReservation;
      // The pool-lease placer (v0.4) answers `pending` with a `Queued` condition and places in a batch:
      // keep reading until it is placed (or fails), within --wait.
      while (isQueued(reservation) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        reservation = (await transport.call('reservations/get', {
          tenantId: flags.tenant!,
          reservationId: reservation.id,
        })) as QueuedReservation;
      }
      if (isQueued(reservation))
        note(
          `Still queued for placement; check with: better-compute reservations get ${reservation.id} --tenant ${flags.tenant!}`,
        );
      return reservation;
    },
  }),
  defineCommand({
    name: 'release',
    group: 'Capacity',
    summary: 'Release a reservation early (reservations.release)',
    description:
      'release ends an active or placed reservation now: its bookings are truncated, the GPUs return to the pool and billing stops at the release time. A reservation that has not started yet can be withdrawn with --cancel instead (reservations.cancel).',
    target: 'token',
    args: reservationArg,
    flags: {
      tenant: tenantFlag,
      cancel: { type: 'boolean', description: 'Withdraw a reservation that has not started' },
    },
    examples: ['better-compute release rsv_01k…', 'better-compute release rsv_01k… --cancel'],
    async run({ flags, args, api }) {
      return (await api()).call(flags.cancel ? 'reservations/cancel' : 'reservations/release', {
        tenantId: flags.tenant!,
        reservationId: reservationId(args),
      });
    },
  }),
  defineCommand({
    name: 'extend',
    group: 'Capacity',
    summary: 'Extend a reservation (reservations.extend)',
    description:
      'extend moves the end of a reservation later, by --by or to --until. It is admitted like a new reservation: better-iam decides compute:reservations:extend on the total duration after the change, so policy caps also bound extensions, and the booking must still be free. With --renew it instead renews a leased reservation (reservations.renew).',
    target: 'token',
    args: reservationArg,
    flags: {
      tenant: tenantFlag,
      by: { type: 'string', value: 'DURATION', description: 'Extend by this much: 30m, 4h, 1d' },
      until: {
        type: 'string',
        value: 'TIME',
        description: 'Extend to this time: ISO 8601 or +DURATION',
      },
      renew: { type: 'boolean', description: 'Renew the lease of a renewable reservation instead' },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry an earlier request',
      },
    },
    validate(flags) {
      const given = [flags.by, flags.until, flags.renew || undefined].filter(
        (value) => value !== undefined,
      );
      if (given.length !== 1) throw usageError('Give exactly one of --by, --until or --renew');
    },
    examples: ['better-compute extend rsv_01k… --by 4h', 'better-compute extend rsv_01k… --renew'],
    async run({ flags, args, api, note }) {
      const base = { tenantId: flags.tenant!, reservationId: reservationId(args) };
      if (flags.renew) return (await api()).call('reservations/renew', base);
      const idempotencyKey = flags.key ?? newIdempotencyKey();
      if (!flags.key)
        note(`Idempotency key ${idempotencyKey} (pass --key ${idempotencyKey} to retry).`);
      return (await api()).call('reservations/extend', {
        ...base,
        idempotencyKey,
        ...(flags.by ? { by: checkDuration(flags.by, 'by') } : {}),
        ...(flags.until ? { until: parseTime(flags.until, Date.now(), 'until') } : {}),
      });
    },
  }),
  defineCommand({
    name: 'reservations list',
    group: 'Capacity',
    summary: 'List the tenant’s reservations (reservations.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      state: {
        type: 'string',
        value: 'STATE',
        description: 'Only this state: active, placed, pending, …',
      },
      pool: { type: 'string', value: 'ID', description: 'Only this pool' },
      limit: { type: 'integer', value: 'N', min: 1, max: 200, description: 'Page size' },
      cursor: { type: 'string', value: 'ID', description: 'Continue after this reservation' },
    },
    examples: [
      'better-compute reservations list --state active',
      'better-compute reservations list --format json',
    ],
    async run({ flags, api }) {
      return (await api()).call('reservations/list', {
        tenantId: flags.tenant!,
        ...(flags.state ? { state: flags.state } : {}),
        ...(flags.pool ? { poolId: flags.pool } : {}),
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'reservations get',
    group: 'Capacity',
    summary: 'Show one reservation, with its binding (reservations.get)',
    target: 'token',
    args: reservationArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute reservations get rsv_01k… --query binding'],
    async run({ flags, args, api }) {
      return (await api()).call('reservations/get', {
        tenantId: flags.tenant!,
        reservationId: reservationId(args),
      });
    },
  }),
  defineCommand({
    name: 'pools list',
    group: 'Capacity',
    summary: 'List the pools the tenant owns or is offered (pools.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: { tenant: tenantFlag },
    examples: ['better-compute pools list'],
    async run({ flags, api }) {
      return (await api()).call('pools/list', { tenantId: flags.tenant! });
    },
  }),
  defineCommand({
    name: 'capacity',
    group: 'Capacity',
    summary:
      'Show free and allocated capacity: a summary, or one pool (capacity.summary, capacity.byPool)',
    description:
      "capacity prints what the tenant can see: per pool and per GPU model, total, allocatable, allocated, reserved and available. With --pool it prints that pool's rollup. With --preview and a --gpus request it asks where such a reservation would fit right now (capacity.preview) without booking anything.",
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', description: 'One pool' },
      preview: {
        type: 'boolean',
        description: 'Preview a placement (needs --pool, --gpus and --for)',
      },
      gpus: { type: 'integer', value: 'N', min: 1, max: 64, description: 'GPUs for --preview' },
      for: { type: 'string', value: 'DURATION', description: 'Duration for --preview' },
      selector: { type: 'string', value: 'EXPR', description: 'Selector shorthand for --preview' },
      ...hostFlags,
    },
    validate(flags) {
      if (flags.preview && (!flags.pool || flags.gpus === undefined || !flags.for))
        throw usageError('--preview needs --pool, --gpus and --for');
    },
    examples: [
      'better-compute capacity',
      'better-compute capacity --pool pool_01k…',
      'better-compute capacity --preview --pool pool_01k… --gpus 8 --for 1d --selector "vramGiB >= 80"',
    ],
    async run({ flags, api }) {
      const tenantId = flags.tenant!;
      if (flags.preview)
        return (await api()).call('capacity/preview', {
          tenantId,
          poolId: flags.pool!,
          devices: [
            gpuRequest({
              gpus: flags.gpus!,
              ...(flags.selector ? { selector: flags.selector } : {}),
            }),
          ],
          duration: checkDuration(flags.for!, 'for'),
          ...hostFields(flags),
          idempotencyKey: newIdempotencyKey(),
        });
      if (flags.pool)
        return (await api()).call('capacity/byPool', { tenantId, poolId: flags.pool });
      return (await api()).call('capacity/summary', { tenantId });
    },
  }),
];
