import {
  ComputeError,
  defineMethod,
  describedBy,
  fleetResourceId,
  type CommandKindSpec,
  type ComputeModule,
  type Duration,
  type MethodContext,
  type MethodDefinition,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import type { ReleaseTrust, SignedReleaseManifest } from '@better-compute/pki';
import { DaemonSectionSchema } from '@better-compute/protocol';
import { rolloutMigrations } from './migrations.js';
import {
  advanceRollout,
  changeRollout,
  createRollout,
  daemonSpecFor,
  listReleases,
  listRollouts,
  readRollout,
  readRolloutNodes,
  registerRelease,
  type DaemonRelease,
  type Rollout,
  type RolloutNode,
} from './rollout.js';
import { schemas } from './schemas.js';

export interface RolloutModuleOptions {
  /** `sha256/…` pins of the offline release keys, and how many must sign (default 1). */
  release: ReleaseTrust;
  /** Where `bcd` binaries are served: `{downloadsUrl}/bcd/{version}/linux-{arch}`. */
  downloadsUrl: string;
  /** How often active rollouts advance (default 30s). */
  every?: Duration;
}

type TenantInput = { tenantId: string };
type RolloutRef = TenantInput & { rolloutId: string };

export type RolloutApi = {
  releases: {
    register: MethodDefinition<TenantInput & { manifest: SignedReleaseManifest }, DaemonRelease>;
    list: MethodDefinition<TenantInput, { items: DaemonRelease[] }>;
  };
  rollouts: {
    create: MethodDefinition<
      TenantInput & {
        version: string;
        poolIds?: string[];
        waves?: number[];
        maxFailureRatio?: number;
        soakSeconds?: number;
        upgradeTimeoutSeconds?: number;
        idempotencyKey?: string;
      },
      Rollout
    >;
    list: MethodDefinition<TenantInput, { items: Rollout[] }>;
    get: MethodDefinition<RolloutRef, Rollout & { nodeList: RolloutNode[] }>;
    pause: MethodDefinition<RolloutRef & { reason?: string }, Rollout>;
    resume: MethodDefinition<RolloutRef, Rollout>;
    abort: MethodDefinition<RolloutRef & { reason?: string; rollback?: boolean }, Rollout>;
  };
};

export const rolloutWork = 'rollout';

/**
 * `daemon.upgrade` (§6): an out-of-band nudge carrying the same `DaemonSection` as NodeSpec, for a
 * session restricted to upgrades (`Welcome.upgrade_required`). Self-terminating: it completes on
 * rejoin with the new version.
 */
export const daemonUpgradeKind: CommandKindSpec = {
  kind: 'daemon.upgrade',
  lane: 'control',
  retrySafe: true,
  selfTerminating: true,
  timeout: '15m',
  roles: ['node', 'site'],
  payload: DaemonSectionSchema,
};

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const rolloutIdPattern = /^rollout_[0-9a-hjkmnp-tv-z]{26,52}$/;
const poolIdPattern = /^pool_[0-9a-z]{26,52}$/;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputeError('INVALID_INPUT', 'input must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!keys.includes(key)) throw new ComputeError('INVALID_INPUT', `${key} is not a known field`);
  if (typeof input.tenantId !== 'string' || !tenantPattern.test(input.tenantId))
    throw new ComputeError('INVALID_INPUT', 'tenantId is invalid');
  return input;
}

function ref(value: unknown, extra: readonly string[] = []): RolloutRef & Record<string, unknown> {
  const input = object(value, ['tenantId', 'rolloutId', ...extra]);
  if (typeof input.rolloutId !== 'string' || !rolloutIdPattern.test(input.rolloutId))
    throw new ComputeError('INVALID_INPUT', 'rolloutId is invalid');
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500))
    throw new ComputeError('INVALID_INPUT', 'reason must be a string of at most 500 characters');
  return input as RolloutRef & Record<string, unknown>;
}

const optionalNumber = (input: Record<string, unknown>, key: string) => {
  const value = input[key];
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ComputeError('INVALID_INPUT', `${key} must be a number`);
  return { [key]: value };
};

const identityOf = (context: MethodContext) => {
  if (!context.caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  return context.caller.identityId;
};

/**
 * The rollout module (§6 "Self-update", v0.4): signed bcd releases, wave rollouts within each
 * pool's disruption budget, and `NodeSpec.daemon`. Every method decides `compute:fleet:admin` on
 * the fleet scope. Register it with the release pins and the downloads URL:
 *
 * ```ts
 * rolloutModule({ release: { pins: ['sha256/…'], threshold: 1 }, downloadsUrl: 'https://compute.example.com/api/compute/downloads' })
 * ```
 */
export function rolloutModule(options: RolloutModuleOptions): ComputeModule<'rollout', RolloutApi> {
  if (!options.release?.pins?.length)
    throw new ComputeError('INVALID_CONFIG', 'rolloutModule needs release.pins');
  if (!/^https:\/\//.test(options.downloadsUrl))
    throw new ComputeError('INVALID_CONFIG', 'rolloutModule needs an https downloadsUrl');
  const resource = () => ({ type: 'fleet', id: fleetResourceId });
  const common = { action: 'compute:fleet:admin' as const, resource };
  const inTx = <T>(context: MethodContext, fn: (tx: SqlTx) => Promise<T>) =>
    context.sql.transaction(fn);

  const api = (): RolloutApi => ({
    releases: {
      register: defineMethod({
        ...common,
        kind: 'mutation',
        validate: describedBy(schemas.registerRelease, (value) => {
          const input = object(value, ['tenantId', 'manifest']);
          const manifest = input.manifest as SignedReleaseManifest | undefined;
          if (
            !manifest ||
            typeof manifest.manifest !== 'string' ||
            !Array.isArray(manifest.signatures)
          )
            throw new ComputeError('INVALID_INPUT', 'manifest must be a signed release manifest');
          return { tenantId: input.tenantId as string, manifest };
        }),
        handler: (context, input) =>
          inTx(context, async (tx) => {
            const { rows } = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
            return registerRelease(tx, input.manifest, {
              trust: options.release,
              identityId: identityOf(context),
              now: rows[0]!.now.getTime(),
            });
          }),
      }),
      list: defineMethod({
        ...common,
        kind: 'read',
        validate: describedBy(schemas.tenant, (value) => ({
          tenantId: object(value, ['tenantId']).tenantId as string,
        })),
        handler: (context) => inTx(context, async (tx) => ({ items: await listReleases(tx) })),
      }),
    },
    rollouts: {
      create: defineMethod({
        ...common,
        kind: 'mutation',
        validate: describedBy(schemas.createRollout, (value) => {
          const input = object(value, [
            'tenantId',
            'version',
            'poolIds',
            'waves',
            'maxFailureRatio',
            'soakSeconds',
            'upgradeTimeoutSeconds',
            'idempotencyKey',
          ]);
          if (
            typeof input.version !== 'string' ||
            !/^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(input.version)
          )
            throw new ComputeError('INVALID_INPUT', 'version must be semver');
          if (
            input.poolIds !== undefined &&
            (!Array.isArray(input.poolIds) ||
              input.poolIds.length === 0 ||
              input.poolIds.length > 1000 ||
              !input.poolIds.every((id) => typeof id === 'string' && poolIdPattern.test(id)))
          )
            throw new ComputeError('INVALID_INPUT', 'poolIds must be pool ids');
          if (
            input.waves !== undefined &&
            (!Array.isArray(input.waves) || !input.waves.every((wave) => typeof wave === 'number'))
          )
            throw new ComputeError('INVALID_INPUT', 'waves must be numbers');
          if (
            input.idempotencyKey !== undefined &&
            (typeof input.idempotencyKey !== 'string' ||
              !/^[A-Za-z0-9._~:/+=-]{1,128}$/.test(input.idempotencyKey))
          )
            throw new ComputeError('INVALID_INPUT', 'idempotencyKey is invalid');
          return {
            tenantId: input.tenantId as string,
            version: input.version,
            ...(input.poolIds ? { poolIds: [...new Set(input.poolIds as string[])] } : {}),
            ...(input.waves ? { waves: input.waves as number[] } : {}),
            ...optionalNumber(input, 'maxFailureRatio'),
            ...optionalNumber(input, 'soakSeconds'),
            ...optionalNumber(input, 'upgradeTimeoutSeconds'),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey as string } : {}),
          };
        }),
        handler: (context, input) =>
          inTx(context, (tx) => createRollout(context, tx, input, identityOf(context))),
      }),
      list: defineMethod({
        ...common,
        kind: 'read',
        validate: describedBy(schemas.tenant, (value) => ({
          tenantId: object(value, ['tenantId']).tenantId as string,
        })),
        handler: (context, input) =>
          inTx(context, async (tx) => ({ items: await listRollouts(tx, input.tenantId) })),
      }),
      get: defineMethod({
        ...common,
        kind: 'read',
        validate: describedBy(schemas.rollout, (value) => {
          const input = ref(value);
          return { tenantId: input.tenantId, rolloutId: input.rolloutId };
        }),
        handler: (context, input) =>
          inTx(context, async (tx) => {
            const rollout = await readRollout(tx, input.tenantId, input.rolloutId);
            if (!rollout)
              throw new ComputeError('NOT_FOUND', `Rollout ${input.rolloutId} not found`);
            return { ...rollout, nodeList: await readRolloutNodes(tx, rollout.id) };
          }),
      }),
      pause: defineMethod({
        ...common,
        kind: 'mutation',
        validate: describedBy(schemas.pause, (value) => {
          const input = ref(value, ['reason']);
          return {
            tenantId: input.tenantId,
            rolloutId: input.rolloutId,
            ...(input.reason ? { reason: input.reason as string } : {}),
          };
        }),
        handler: (context, input) =>
          inTx(context, (tx) => changeRollout(context, tx, { ...input, action: 'pause' })),
      }),
      resume: defineMethod({
        ...common,
        kind: 'mutation',
        validate: describedBy(schemas.rollout, (value) => {
          const input = ref(value);
          return { tenantId: input.tenantId, rolloutId: input.rolloutId };
        }),
        handler: (context, input) =>
          inTx(context, async (tx) => {
            const rollout = await changeRollout(context, tx, { ...input, action: 'resume' });
            await context.work.enqueue(tx, rolloutWork, rollout.id);
            return rollout;
          }),
      }),
      abort: defineMethod({
        ...common,
        kind: 'mutation',
        validate: describedBy(schemas.abort, (value) => {
          const input = ref(value, ['reason', 'rollback']);
          if (input.rollback !== undefined && typeof input.rollback !== 'boolean')
            throw new ComputeError('INVALID_INPUT', 'rollback must be true or false');
          return {
            tenantId: input.tenantId,
            rolloutId: input.rolloutId,
            ...(input.reason ? { reason: input.reason as string } : {}),
            ...(input.rollback !== undefined ? { rollback: input.rollback as boolean } : {}),
          };
        }),
        handler: (context, input) =>
          inTx(context, async (tx) => {
            const rollout = await changeRollout(context, tx, { ...input, action: 'abort' });
            await context.work.enqueue(tx, rolloutWork, rollout.id);
            return rollout;
          }),
      }),
    },
  });

  const reconciler: Reconciler = {
    name: rolloutWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.every ?? '30s' }],
    async run(context, key) {
      if (key === 'all') {
        // Running and paused rollouts (paused ones still settle nodes in flight), and aborted ones
        // with rollbacks outstanding.
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT r.id FROM rollouts r WHERE r.state IN ('running', 'paused')
                OR (r.state = 'aborted' AND EXISTS (SELECT 1 FROM rollout_nodes rn
                     WHERE rn.rollout_id = r.id AND rn.state = 'rolling-back'))
              ORDER BY r.id`,
          );
          for (const row of rows) await context.work.enqueue(tx, rolloutWork, row.id);
        });
        return 'DONE';
      }
      await context.sql.transaction((tx) =>
        advanceRollout(context, tx, key, { downloadsUrl: options.downloadsUrl }),
      );
      return 'DONE';
    },
  };

  return {
    name: 'rollout',
    migrations: [...rolloutMigrations],
    api,
    reconcilers: [reconciler],
    commandKinds: [daemonUpgradeKind],
    async nodeSpec(context, node) {
      const daemon = await context.sql.transaction((tx) =>
        daemonSpecFor(tx, node, options.downloadsUrl),
      );
      return daemon ? { daemon } : {};
    },
  };
}
