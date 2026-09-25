import {
  ComputeError,
  parseDuration,
  shardOf,
  type Clock,
  type ComputeModule,
  type Lease,
  type LeaseProvider,
  type Logger,
  type ModuleContext,
  type ReconcileContext,
  type Reconciler,
  type SqlExecutor,
  type SqlTx,
  type TransactionOptions,
} from '@better-compute/core';
import {
  claimWork,
  enqueueKeys,
  isWorkKind,
  seedKeys,
  settleClaims,
  type ClaimedWork,
  type Settlement,
} from './work-queue.js';
import type { Membership, SingletonLease } from './workers.js';

// The reconciler runtime (PLAN.md §8.4). Each registered reconciler claims ready keys of its kind
// from the shards this worker holds (sharded by node or pool), or from every shard under its
// `singleton:<name>` lease (`shardBy: 'none'`). Runs are level-triggered: DONE removes the key at
// the claimed generation, SYNC_AGAIN brings it back shortly, a throw backs it off exponentially,
// and a periodic key is due again `every` after its last run. Every transaction a reconciler opens
// through `ctx.sql` is fenced by the lease it runs under. Owned keys are re-enqueued every 5-10
// minutes (level trigger) for node- and pool-sharded reconcilers.

/** Settings every reconciler runner shares. */
export interface ReconcilerSettings {
  batchSize: number;
  claimTtlMs: number;
  syncAgainMs: number;
  maxBackoffMs: number;
  resyncMs: number;
}

/** Validates the reconcilers of every module: well-formed, unique names that are work kinds. */
export function collectReconcilers(
  modules: readonly ComputeModule[],
  reserved: ReadonlySet<string>,
): { module: string; reconciler: Reconciler; periodic: Map<string, number> }[] {
  const seen = new Map<string, string>();
  const out: { module: string; reconciler: Reconciler; periodic: Map<string, number> }[] = [];
  for (const module of modules) {
    if (typeof module !== 'object' || module === null) continue;
    const list: unknown = module.reconcilers;
    if (list === undefined) continue;
    if (!Array.isArray(list))
      throw new ComputeError('INVALID_CONFIG', `${module.name}: reconcilers must be an array`);
    for (const reconciler of list as Reconciler[]) {
      const name = (reconciler as Partial<Reconciler> | null)?.name;
      if (!isWorkKind(name) || reserved.has(name))
        throw new ComputeError(
          'INVALID_CONFIG',
          `${module.name}: reconciler name ${JSON.stringify(name)} must match /^[a-z][a-z0-9._-]{0,63}$/ and not be a built-in job`,
        );
      if (seen.has(name))
        throw new ComputeError(
          'INVALID_CONFIG',
          `Reconciler ${name} is registered twice (by ${seen.get(name)} and ${module.name})`,
        );
      seen.set(name, module.name);
      if (!['node', 'pool', 'none'].includes(reconciler.shardBy))
        throw new ComputeError(
          'INVALID_CONFIG',
          `Reconciler ${name}: shardBy is node, pool or none`,
        );
      if (typeof reconciler.run !== 'function')
        throw new ComputeError('INVALID_CONFIG', `Reconciler ${name} has no run function`);
      const periodic = new Map<string, number>();
      const entries: unknown = reconciler.periodic ?? [];
      if (!Array.isArray(entries))
        throw new ComputeError('INVALID_CONFIG', `Reconciler ${name}: periodic must be an array`);
      for (const entry of entries as { key: unknown; every: unknown }[]) {
        const key = entry?.key;
        if (typeof key !== 'string' || key.length === 0 || key.length > 512 || periodic.has(key))
          throw new ComputeError(
            'INVALID_CONFIG',
            `Reconciler ${name}: periodic keys are unique non-empty strings`,
          );
        let every: number;
        try {
          every = parseDuration(entry.every as string);
        } catch {
          every = 0;
        }
        if (every < 1000)
          throw new ComputeError(
            'INVALID_CONFIG',
            `Reconciler ${name}: periodic key ${key} needs an every of at least 1s`,
          );
        periodic.set(key, every);
      }
      out.push({ module: module.name, reconciler, periodic });
    }
  }
  return out;
}

/** An executor whose transactions start with the lease fence (read-only ones skip it). */
export function fencedExecutor(
  database: SqlExecutor,
  leases: LeaseProvider,
  lease: Lease,
  inTransaction: () => boolean,
): SqlExecutor {
  const refuse = (what: string) => () =>
    Promise.reject(new ComputeError('INVALID_STATE', `${what} cannot run inside a reconciler`));
  return {
    dialect: database.dialect,
    kind: database.kind,
    query: (text, params) => database.query(text, params),
    transaction<T>(fn: (tx: SqlTx) => Promise<T>, options?: TransactionOptions): Promise<T> {
      // Nested transactions are savepoints of a transaction that was fenced when it began.
      if (options?.readOnly || inTransaction()) return database.transaction(fn, options);
      return database.transaction(async (tx) => {
        await leases.fence(tx, lease);
        return fn(tx);
      }, options);
    },
    migrate: refuse('migrate()'),
    close: refuse('close()'),
  };
}

/** Per-reconciler jitter in [0, span), stable for a given round so simulated runs replay. */
function jitter(name: string, round: number, span: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${name}:${round}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % Math.max(1, span);
}

export interface ReconcilerRunnerInput {
  reconciler: Reconciler;
  periodic: ReadonlyMap<string, number>;
  database: SqlExecutor;
  leases: LeaseProvider;
  inTransaction(): boolean;
  clock: Clock;
  log: Logger;
  context: () => ModuleContext;
  membership: Membership;
  singleton: SingletonLease;
  settings: ReconcilerSettings;
  signal: AbortSignal;
  /** Told about every finished run (metrics, spans); never awaited, and a throw is ignored. */
  onRun?: (run: ReconcileRun) => void;
}

/** One finished reconciler run, for `WorkerOptions.observe.onRun`. */
export interface ReconcileRun {
  reconciler: string;
  key: string;
  outcome: 'done' | 'sync-again' | 'error';
  durationMs: number;
  /** The ComputeError code of a failed run. */
  code?: string;
}

export interface ReconcilerRunner {
  readonly name: string;
  /** Claims one batch and runs it with at most `concurrency` keys at once; returns keys run. */
  tick(concurrency?: number): Promise<number>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Group commit for settlements: whatever lanes finish while one settle statement is in flight go
 * together in the next, so a busy runner pays one statement per wave, not one per key, and an idle
 * one settles each key at once.
 */
function settler(run: (batch: Settlement[]) => Promise<void>): (settlements: Settlement[]) => Promise<void> {
  let pending: { settlements: Settlement[]; resolve: () => void; reject: (error: unknown) => void }[] = [];
  let flushing = false;
  async function flush() {
    flushing = true;
    try {
      while (pending.length) {
        const wave = pending;
        pending = [];
        try {
          await run(wave.flatMap((entry) => entry.settlements));
          for (const entry of wave) entry.resolve();
        } catch (error) {
          for (const entry of wave) entry.reject(error);
        }
      }
    } finally {
      flushing = false;
    }
  }
  return (settlements) => {
    if (!settlements.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      pending.push({ settlements, resolve, reject });
      if (!flushing) void flush();
    });
  };
}

export function createReconcilerRunner(input: ReconcilerRunnerInput): ReconcilerRunner {
  const { reconciler, periodic, database, clock, log, settings } = input;
  const { name } = reconciler;
  const sharded = reconciler.shardBy !== 'none';
  /** Consecutive failures per key, for the back-off (reset by a successful run). */
  const failures = new Map<string, number>();
  let seeded = false;
  let resyncRound = 0;
  let nextResyncAt: number | undefined;
  const settle = settler((batch) => settleClaims(database, name, batch));
  const complete = (item: ClaimedWork) => settle([{ item, delayMs: null, always: false }]);
  const defer = (item: ClaimedWork, delayMs: number, always: boolean) =>
    settle([{ item, delayMs, always }]);

  async function resync(shards: readonly number[]): Promise<void> {
    if (!shards.length) return;
    if (reconciler.shardBy === 'node') {
      await database.query(
        `INSERT INTO work_queue (kind, key, shard, gen, not_before)
         SELECT $1, id, shard, 1, compute_now() FROM nodes WHERE shard = ANY($2::smallint[])
         ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + 1,
           not_before = LEAST(work_queue.not_before, EXCLUDED.not_before)`,
        [name, shards],
      );
      return;
    }
    const owned = new Set(shards);
    const pools = (await database.query<{ id: string }>('SELECT id FROM pools ORDER BY id')).rows
      .map((row) => row.id)
      .filter((id) => owned.has(shardOf(id)));
    await enqueueKeys(database, name, pools);
  }

  async function runOne(item: ClaimedWork, lease: Lease): Promise<void> {
    const context: ReconcileContext & { lease: Lease } = {
      ...input.context(),
      sql: fencedExecutor(database, input.leases, lease, input.inTransaction),
      ...(sharded ? { shard: item.shard } : {}),
      lease,
      signal: input.signal,
    };
    let outcome: 'DONE' | 'SYNC_AGAIN';
    const started = performance.now();
    const observe = (run: Pick<ReconcileRun, 'outcome' | 'code'>) => {
      if (!input.onRun) return;
      try {
        input.onRun({ reconciler: name, key: item.key, durationMs: performance.now() - started, ...run });
      } catch {
        // Observers never affect the work.
      }
    };
    try {
      outcome = await reconciler.run(context, item.key);
      if (outcome !== 'DONE' && outcome !== 'SYNC_AGAIN')
        throw new ComputeError(
          'INTERNAL_ERROR',
          `returned ${String(outcome)}, not DONE or SYNC_AGAIN`,
        );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      observe({ outcome: 'error', ...(typeof code === 'string' ? { code } : {}) });
      const attempts = (failures.get(item.key) ?? 0) + 1;
      failures.set(item.key, attempts);
      const delay = Math.min(1000 * 2 ** (attempts - 1), settings.maxBackoffMs);
      log.warn('A reconciler run failed; backing off', {
        reconciler: name,
        key: item.key,
        attempts,
        retryInMs: delay,
        error: message(error),
      });
      await defer(item, delay, true);
      return;
    }
    failures.delete(item.key);
    observe({ outcome: outcome === 'DONE' ? 'done' : 'sync-again' });
    const every = periodic.get(item.key);
    if (outcome === 'SYNC_AGAIN') await defer(item, settings.syncAgainMs, false);
    else if (every !== undefined) await defer(item, every, false);
    else await complete(item);
  }

  return {
    name,
    async tick(concurrency = 1) {
      if (input.signal.aborted) return 0;
      let leases: ReadonlyMap<number, Lease> | undefined;
      let singleton: Lease | undefined;
      if (sharded) {
        leases = await input.membership.ensure();
        if (!leases.size) return 0;
      } else {
        singleton = await input.singleton.ensure();
        if (!singleton) return 0;
      }
      if (!seeded) {
        await seedKeys(database, name, [...periodic.keys()]);
        seeded = true;
      }
      if (sharded) {
        const now = clock.now();
        const span = Math.max(1, settings.resyncMs);
        nextResyncAt ??= now + span + jitter(name, resyncRound, span);
        if (now >= nextResyncAt) {
          await resync([...leases!.keys()]);
          resyncRound += 1;
          nextResyncAt = now + span + jitter(name, resyncRound, span);
        }
      }
      const claimed = await claimWork(
        database,
        name,
        sharded ? [...leases!.keys()] : undefined,
        settings.batchSize,
        settings.claimTtlMs,
      );
      let next = 0;
      const worker = async () => {
        while (next < claimed.length && !input.signal.aborted) {
          const item = claimed[next++]!;
          const lease = sharded ? leases!.get(item.shard) : singleton;
          if (!lease) {
            // The shard moved between the claim and now: let its new owner have the key.
            await defer(item, 0, false);
            continue;
          }
          await runOne(item, lease);
        }
      };
      const lanes = Math.max(1, Math.min(concurrency, claimed.length));
      await Promise.all(Array.from({ length: lanes }, worker));
      // Stopped mid-batch: hand back what never ran instead of waiting out the claim.
      await settle(claimed.slice(next).map((item) => ({ item, delayMs: 0, always: false })));
      return Math.min(next, claimed.length);
    },
  };
}
