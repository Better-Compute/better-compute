import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ModuleContext,
  type ProviderResourceKind,
  type ProviderResourceRequest,
  type ProviderResourceState,
  type Reconciler,
  type SecretRef,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ProviderAccount } from '@better-compute/vps';
import {
  accountResources,
  json,
  kindOf,
  publish,
  readResource,
  resourceLabels,
  resourcesWork,
  tenantSecrets,
  type CloudResourcesDeps,
  type ResourceRow,
  type ResourcesProvider,
} from './store.js';
import { markDeleted, networkIdsOf, networkNames } from './resources.js';
import type { CloudResourceState } from './types.js';
import { meterRates } from './usage.js';

// The `cloud.resources` reconciler: converges each resource at the provider through `ProviderImpl.resources`. Rows
// are read in one transaction, the provider is called with none open, and each result is written in its own short
// transaction guarded by the row version it was decided on (a change made meanwhile wakes the reconciler again
// instead of being overwritten). Secret outputs are sealed into the SecretStore in the same run that received
// them; only their refs are written, and a ref whose row write lost is destroyed again.

/** How soon a provider operation in flight is looked at again. */
export const resourcePollMs = 10_000;
/** How soon a rate-limited or unavailable provider is tried again. */
export const resourceRetryMs = 30_000;

const transientCodes = ['RATE_LIMITED', 'UNAVAILABLE'];
const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);

interface Snapshot {
  row: ResourceRow;
  account: ProviderAccount | undefined;
  parent?: ResourceRow;
  /** Resources living in this one that are not gone yet. */
  liveChildren: number;
}

async function loadSnapshot(tx: SqlTx, resourceId: string): Promise<Snapshot | undefined> {
  const row = await readResource(tx, { resourceId });
  if (!row) return undefined;
  const children = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM cloud_resources
      WHERE parent_id = $1 AND state NOT IN ('deleted', 'released')`,
    [resourceId],
  );
  const parent =
    row.parent_id !== null ? await readResource(tx, { resourceId: row.parent_id }) : undefined;
  return {
    row,
    account: await readAccount(tx, row.provider_account_id),
    ...(parent ? { parent } : {}),
    liveChildren: Number(children.rows[0]!.count),
  };
}

/** One step of one resource. Returns the next wake-up, or undefined when settled. */
export async function reconcileResource(
  deps: CloudResourcesDeps,
  sql: SqlExecutor,
  resourceId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const snapshot = await sql.transaction((tx) => loadSnapshot(tx, resourceId));
  if (!snapshot || snapshot.row.state === 'deleted' || snapshot.row.state === 'released')
    return undefined;
  const worker = new ResourceWorker(deps, sql, snapshot, signal);
  const { row } = snapshot;
  if (
    row.desired_state !== 'present' &&
    row.provider_id === null &&
    row.ensure_sent_at === null &&
    snapshot.liveChildren === 0
  )
    // The provider was never asked for it: nothing to delete or release there. (One whose ensure was sent but never
    // answered is looked up first: see recoverLost.)
    return worker.finish(row.desired_state === 'released' ? 'released' : 'deleted');
  if (row.desired_state !== 'present' && row.adopted && row.ready_at === null && snapshot.liveChildren === 0)
    // An adoption whose takeover never completed: the resource never became ours (a delete would be refused as not
    // managed here, and must not succeed either), so it is let go here, with no provider call.
    return worker.finish('released');
  const provider = await worker.provider();
  if (!provider) return undefined;
  if (row.desired_state === 'deleted') return worker.teardown(provider);
  if (row.desired_state === 'released') return worker.release(provider);
  return worker.converge(provider);
}

/** What recording a provider id came to. */
type Recorded = 'recorded' | 'conflict' | 'reopened';

/** What one provider call came to; `undefined` when the provider was busy (try later). */
type Sealed = { refs: Record<string, SecretRef>; created: SecretRef[]; superseded: SecretRef[] };
type Outcome = {
  state: ProviderResourceState['state'];
  message?: string;
  result?: ProviderResourceState;
};

class ResourceWorker {
  #inFlight = false;
  #backoff = false;
  #again = false;

  constructor(
    private readonly deps: CloudResourcesDeps,
    private readonly sql: SqlExecutor,
    private readonly snapshot: Snapshot,
    private readonly signal: AbortSignal,
  ) {}

  get #row() {
    return this.snapshot.row;
  }

  #next(): number | undefined {
    const now = this.deps.clock.now();
    if (this.#backoff) return now + resourceRetryMs;
    if (this.#again) return now;
    return this.#inFlight ? now + resourcePollMs : undefined;
  }

  #call(): CallContext {
    return {
      idempotencyKey: this.#row.id,
      signal: this.signal,
      clock: this.deps.clock,
      // A spec's SecretRefs resolve only within the resource's tenant.
      secrets: tenantSecrets(this.deps, this.#row.tenant_id),
      log: this.deps.log,
    };
  }

  /** The account's resources and the row's kind; otherwise the resource is in error. */
  async provider(): Promise<
    { provider: ResourcesProvider; kind: ProviderResourceKind } | undefined
  > {
    const { account } = this.snapshot;
    try {
      if (!account)
        throw new ComputeError(
          'NOT_FOUND',
          `Provider account ${this.#row.provider_account_id} not found`,
        );
      const provider = await accountResources(this.deps, account);
      return { provider, kind: kindOf(provider, this.#row.kind) };
    } catch (error) {
      await this.#set({ state: 'error', message: text(error) });
      return undefined;
    }
  }

  /** Runs a provider call; a throw is an `error` outcome unless the provider is only busy (then: later). */
  async #attempt(op: () => Promise<ProviderResourceState>): Promise<Outcome | undefined> {
    try {
      const result = await op();
      return {
        state: result.state,
        ...(result.message ? { message: result.message.slice(0, 500) } : {}),
        result,
      };
    } catch (error) {
      if (this.signal.aborted || (isComputeError(error) && transientCodes.includes(error.code))) {
        this.deps.log.warn('cloud-resources: provider busy, retrying', {
          resourceId: this.#row.id,
          error: text(error),
        });
        this.#backoff = true;
        return undefined;
      }
      return { state: 'error', message: text(error) };
    }
  }

  /**
   * The provider's id, recorded as soon as the provider answers one, whatever the row's version: it is a fact
   * about the provider, and a resource whose id was lost could not be deleted.
   */
  async #recordProviderId(id: string): Promise<Recorded> {
    const row = this.#row;
    if (row.provider_id !== null) return row.provider_id === id ? 'recorded' : 'conflict';
    let outcome: Recorded;
    try {
      outcome = await this.sql.transaction(async (tx): Promise<Recorded> => {
        const recorded = await tx.query(
          `UPDATE cloud_resources
              SET provider_id = $2, provisioned_at = coalesce(provisioned_at, compute_now())
            WHERE id = $1 AND provider_id IS NULL AND state NOT IN ('deleted', 'released')
            RETURNING id`,
          [row.id, id],
        );
        if (recorded.rows.length > 0) return 'recorded';
        const { rows } = await tx.query<{ provider_id: string | null }>(
          `SELECT provider_id FROM cloud_resources WHERE id = $1 FOR UPDATE`,
          [row.id],
        );
        const current = rows[0];
        if (!current) return 'conflict';
        if (current.provider_id !== null)
          return current.provider_id === id ? 'recorded' : 'conflict';
        // Another run finished the row (deleted or released, with no provider id) while this one's create was in
        // flight: the provider made it after all. The row is brought back to be deleted, never left unmanaged.
        await tx.query(
          `UPDATE cloud_resources
              SET provider_id = $2, provisioned_at = coalesce(provisioned_at, compute_now()),
                  desired_state = 'deleted', state = 'deleting', deleted_at = NULL, message = NULL,
                  version = version + 1, updated_at = compute_now()
            WHERE id = $1`,
          [row.id, id],
        );
        await this.deps.work.enqueue(tx, resourcesWork, row.id);
        await publish(this.deps, tx, row, 'deleting', { reason: 'late-create' });
        return 'reopened';
      });
    } catch (error) {
      // Another live row records that provider resource (cloud_resources_provider_id): this one never takes it.
      if ((error as { code?: string } | undefined)?.code !== '23505') throw error;
      return 'conflict';
    }
    if (outcome === 'conflict') return outcome;
    row.provider_id = id;
    if (outcome === 'reopened') {
      this.deps.log.warn('cloud-resources: a create answered after its row was finished; deleting it', {
        resourceId: row.id,
        providerId: id,
      });
      this.#again = true;
    }
    return outcome;
  }

  /**
   * A row being deleted or released whose `ensure` was sent but whose provider id was never recorded (the answer was
   * lost, or the claim expired mid-call): the provider is asked whether it made the resource (`find`). `gone`: it did
   * not, and the row can finish; `found`: the id is recorded and the teardown goes on; `wait`: the provider is busy or
   * cannot tell (the row is in error, retried on refresh: never forgotten on a guess).
   */
  async #recoverLost(provider: ResourcesProvider): Promise<'gone' | 'found' | 'wait'> {
    const row = this.#row;
    if (row.ensure_sent_at === null) return 'gone';
    const resources = provider.resources;
    if (typeof resources.find !== 'function') {
      await this.#set({
        state: 'error',
        message: `Provider ${row.provider} cannot look up a resource whose create was sent but never answered; it may exist there`,
      });
      return 'wait';
    }
    const looked = await this.#attempt(async (): Promise<ProviderResourceState> => {
      const id = await resources.find!(this.#request(), this.#call());
      return typeof id === 'string' && id.length > 0
        ? { id, state: 'ready' }
        : { id: '', state: 'deleted' };
    });
    if (!looked) return 'wait';
    if (looked.state === 'error') {
      await this.#set({ state: 'error', message: looked.message ?? 'The provider lookup failed' });
      return 'wait';
    }
    if (looked.state === 'deleted') return 'gone';
    // Another live row manages what it found: it is not this row's to delete.
    return (await this.#recordProviderId(looked.result!.id)) === 'conflict' ? 'gone' : 'found';
  }

  /** The request `ensure` (and `find`) is sent for the row. */
  #request(networks?: Record<string, string>): ProviderResourceRequest {
    const row = this.#row;
    const { parent, account } = this.snapshot;
    return {
      kind: row.kind,
      name: row.provider_name,
      spec: json(row.spec),
      ...(row.provider_id !== null ? { id: row.provider_id } : {}),
      ...(parent?.provider_id ? { parent: parent.provider_id } : {}),
      labels: this.#labels(),
      accountScope: account?.tenantId === row.tenant_id ? 'tenant' : 'shared',
      ...(networks ? { networks } : {}),
    };
  }

  /**
   * Records, and commits, that an ensure is about to be sent for a row with no provider id, unless the row stopped
   * being wanted since this run read it (then nothing is sent). False: do not send.
   */
  async #markEnsureSent(): Promise<boolean> {
    const row = this.#row;
    if (row.provider_id !== null) return true;
    const { rows } = await this.sql.transaction((tx) =>
      tx.query<{ ensure_sent_at: Date | string }>(
        `UPDATE cloud_resources SET ensure_sent_at = coalesce(ensure_sent_at, compute_now())
          WHERE id = $1 AND desired_state = 'present' AND state NOT IN ('deleted', 'released')
          RETURNING ensure_sent_at`,
        [row.id],
      ),
    );
    if (rows.length === 0) {
      await this.#changedMeanwhile();
      return false;
    }
    row.ensure_sent_at = rows[0]!.ensure_sent_at;
    return true;
  }

  /**
   * Seals the secret outputs the provider reported. A name already sealed keeps its ref when the value is the same
   * (it is compared by resolving the stored ref, never by keeping the value); a changed value is sealed anew and the
   * old ref is superseded. Undeclared names are dropped. Returns the refs to write, the refs made in this run and the
   * refs superseded.
   */
  async #seal(
    kind: ProviderResourceKind,
    secrets: Readonly<Record<string, string>> | undefined,
  ): Promise<Sealed> {
    const refs: Record<string, SecretRef> = { ...json(this.#row.secret_outputs) };
    const created: SecretRef[] = [];
    const superseded: SecretRef[] = [];
    const declared = kind.secretOutputs ?? [];
    for (const [name, value] of Object.entries(secrets ?? {})) {
      if (!declared.includes(name)) {
        this.deps.log.warn('cloud-resources: dropped an undeclared secret output', {
          resourceId: this.#row.id,
          kind: kind.kind,
          output: name,
        });
        continue;
      }
      if (typeof value !== 'string' || value.length === 0) continue;
      const broker = this.deps.secrets;
      if (!broker || typeof broker.put !== 'function')
        throw new ComputeError(
          'UNSUPPORTED',
          `${kind.kind} returned secrets, and this deployment has no secret store to seal them in`,
          undefined,
          { reason: 'secretStore' },
        );
      const existing = refs[name];
      if (existing !== undefined) {
        const current = await broker
          .resolve(existing, { tenantId: this.#row.tenant_id })
          .catch(() => undefined);
        if (current === value) continue;
        superseded.push(existing);
      }
      const ref = await broker.put(this.#row.tenant_id, value);
      created.push(ref);
      refs[name] = ref;
    }
    return { refs, created, superseded };
  }

  async #destroy(refs: readonly SecretRef[]): Promise<void> {
    for (const ref of refs)
      await this.deps.secrets?.delete?.(ref).catch((error: unknown) =>
        this.deps.log.warn('cloud-resources: could not destroy a superseded secret', {
          resourceId: this.#row.id,
          error: text(error),
        }),
      );
  }

  /**
   * Writes the resource's state and what the provider reported (guarded by the version this run read) and
   * publishes the transition: `ready` the first time, `updated` when it is ready again after a change, `failed`
   * when it goes to error or its message changes.
   */
  async #set(update: {
    state: CloudResourceState;
    message?: string;
    outputs?: Readonly<Record<string, string>>;
    secretRefs?: Record<string, SecretRef>;
    /** An adopted resource's spec, as the provider reports it. */
    spec?: Readonly<Record<string, unknown>>;
    /** The networks that spec names (written with it). */
    networkIds?: readonly string[];
    /** The rate of each of the kind's meters, when the provider reported its usage. */
    rates?: Readonly<Record<string, number>>;
  }): Promise<boolean> {
    const row = this.#row;
    const written = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE cloud_resources
            SET state = $3, message = $4,
                outputs = coalesce($5::jsonb, outputs),
                secret_outputs = coalesce($6::jsonb, secret_outputs),
                spec = coalesce($7::jsonb, spec),
                meter_rates = coalesce($8::jsonb, meter_rates),
                network_ids = coalesce($9::text[], network_ids),
                updated_at = compute_now(),
                ready_at = CASE WHEN $3 = 'ready' THEN coalesce(ready_at, compute_now()) ELSE ready_at END
          WHERE id = $1 AND version = $2
          RETURNING id`,
        [
          row.id,
          row.version,
          update.state,
          update.message ?? null,
          update.outputs ? JSON.stringify(update.outputs) : null,
          update.secretRefs ? JSON.stringify(update.secretRefs) : null,
          update.spec ? JSON.stringify(update.spec) : null,
          update.rates ? JSON.stringify(update.rates) : null,
          update.networkIds ? [...update.networkIds] : null,
        ],
      );
      if (rows.length === 0) return false;
      if (update.state === 'ready') {
        if (row.ready_at === null)
          await publish(this.deps, tx, row, 'ready', {
            outputs: Object.keys(update.outputs ?? {}),
            secretOutputs: Object.keys(update.secretRefs ?? {}),
          });
        else if (row.state !== 'ready') await publish(this.deps, tx, row, 'updated');
      } else if (
        update.state === 'error' &&
        (row.state !== 'error' || row.message !== (update.message ?? null))
      )
        await publish(this.deps, tx, row, 'failed', { message: update.message ?? '' });
      return true;
    });
    if (written) {
      row.state = update.state;
      row.message = update.message ?? null;
      return true;
    }
    await this.#changedMeanwhile();
    return false;
  }

  /** A write guarded by the version found a newer one (a change through the API): converge again at once. */
  async #changedMeanwhile(): Promise<void> {
    const { rows } = await this.sql.transaction((tx) =>
      tx.query<{ version: string | number }>(`SELECT version FROM cloud_resources WHERE id = $1`, [
        this.#row.id,
      ]),
    );
    if (rows[0] && Number(rows[0].version) !== Number(this.#row.version)) this.#again = true;
  }

  /** The state a resource still converging shows: `provisioning` until it was ready once, then `updating`. */
  #converging(): CloudResourceState {
    return this.#row.ready_at === null ? 'provisioning' : 'updating';
  }

  #labels(): Record<string, string> {
    return {
      [resourceLabels.managed]: 'true',
      [resourceLabels.resource]: this.#row.id,
      [resourceLabels.tenant]: this.#row.tenant_id,
    };
  }

  async converge({
    provider,
    kind,
  }: {
    provider: ResourcesProvider;
    kind: ProviderResourceKind;
  }): Promise<number | undefined> {
    const row = this.#row;
    const { parent } = this.snapshot;
    if (row.parent_id !== null) {
      if (!parent || parent.desired_state !== 'present') {
        await this.#set({ state: 'error', message: `Its ${kind.parent ?? 'parent'} is gone` });
        return this.#next();
      }
      if (parent.provider_id === null || parent.ready_at === null) {
        // The parent is still being created: wait for it.
        this.#inFlight = true;
        if (row.state !== 'pending') await this.#set({ state: 'pending' });
        return this.#next();
      }
    }
    // An adopted resource is taken over first, whatever its version (a description change does not count), and then
    // observed, not ensured, until the tenant changes its spec: until then its spec is the provider's.
    const observe = row.adopted && (row.ready_at === null || !row.spec_changed);
    // The tenant networks the spec names, by their provider-side names: only the tenant's own on this account (the
    // API checked them; this keeps a provider from ever being handed a network that is not).
    let networks: Record<string, string> | undefined;
    if (!observe && typeof kind.networks === 'function') {
      const named = [...kind.networks(json(row.spec))];
      if (named.length > 0) {
        networks = await this.sql.transaction((tx) =>
          networkNames(
            tx,
            {
              tenantId: row.tenant_id,
              accountId: provider.account.id,
              tenantAccount: provider.account.tenantId === row.tenant_id,
              live: false,
            },
            named,
          ),
        );
        const missing = named.find((id) => networks![id] === undefined);
        if (missing !== undefined) {
          await this.#set({
            state: 'error',
            message: `Network ${missing} is not a network of this tenant on the provider account`,
          });
          return this.#next();
        }
      }
    }
    if (!observe && !(await this.#markEnsureSent())) return this.#next();
    const ensured = await this.#attempt(() =>
      observe
        ? this.#observe(provider)
        : provider.resources.ensure(this.#request(networks), this.#call()),
    );
    if (!ensured) return this.#next();
    // The provider's id is recorded whatever state it answered: a resource it made and reports failed (a first
    // deployment that ended in error) still has to be deleted with the row. An answer with no id made nothing.
    const answeredId = ensured.result?.id;
    if (typeof answeredId === 'string' && answeredId.length > 0) {
      const recorded = await this.#recordProviderId(answeredId);
      if (recorded === 'conflict') {
        // Nothing of what it answered is kept (its secrets are the other resource's).
        await this.#set({
          state: 'error',
          message: `Another cloud resource already manages ${answeredId}`.slice(0, 500),
        });
        return this.#next();
      }
      // The row was finished meanwhile and is now being deleted: the next run tears it down.
      if (recorded === 'reopened') return this.#next();
    }
    if (ensured.state === 'error') {
      await this.#set({
        state: 'error',
        message: ensured.message ?? 'The provider refused the resource',
      });
      return this.#next();
    }
    const result = ensured.result!;
    const adoptedSpec =
      observe && result.spec !== undefined && Object.keys(json(row.spec)).length === 0
        ? result.spec
        : undefined;
    let sealed: Sealed;
    try {
      sealed = await this.#seal(kind, result.secretOutputs);
    } catch (error) {
      await this.#set({ state: 'error', message: text(error) });
      return this.#next();
    }
    const outputs = Object.fromEntries(
      Object.entries(result.outputs ?? {}).filter(([name]) => kind.outputs.includes(name)),
    );
    const ready = result.state === 'ready';
    if (!ready) this.#inFlight = true;
    // Taken over with a spec change already waiting: ensure it next.
    else if (observe && row.spec_changed) this.#again = true;
    const written = await this.#set({
      state: ready ? 'ready' : this.#converging(),
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      ...(sealed.created.length > 0 ? { secretRefs: sealed.refs } : {}),
      ...(adoptedSpec ? { spec: adoptedSpec, networkIds: networkIdsOf(kind, adoptedSpec) } : {}),
      // What it bills per hour from here (usage.ts); undeclared meters and bad rates are dropped.
      ...(result.usage !== undefined ? { rates: meterRates(kind.meters, result.usage) } : {}),
    });
    await this.#destroy(written ? sealed.superseded : sealed.created);
    return this.#next();
  }

  /**
   * An adopted resource: the first time, the provider writes the ownership labels (and refuses one another
   * deployment manages); afterwards it is read. One gone at the provider is an error, never re-created.
   */
  async #observe(provider: ResourcesProvider): Promise<ProviderResourceState> {
    const row = this.#row;
    if (row.ready_at === null)
      return provider.resources.adopt!(row.kind, row.provider_id!, this.#labels(), this.#call());
    const found = await provider.resources.get(row.kind, row.provider_id!, this.#call());
    if (!found)
      throw new ComputeError('NOT_FOUND', `${row.kind} ${row.provider_id} is gone at the provider`);
    return found;
  }

  /** Deletes the resource at the provider once nothing lives in it any more, then records it `deleted`. */
  async teardown({
    provider,
  }: {
    provider: ResourcesProvider;
    kind: ProviderResourceKind;
  }): Promise<number | undefined> {
    const row = this.#row;
    if (this.snapshot.liveChildren > 0) {
      // Its users, pools and firewall rules go first. One still wanted (a create that committed under this parent
      // after its delete marked the tree) is marked now, so the parent never waits on it forever.
      await this.sql.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string; tenant_id: string; kind: string }>(
          `SELECT id, tenant_id, kind FROM cloud_resources
            WHERE parent_id = $1 AND desired_state = 'present' AND state NOT IN ('deleted', 'released')
            ORDER BY id FOR UPDATE`,
          [row.id],
        );
        for (const child of rows) await markDeleted(this.deps, tx, child, 'parent-deleted');
      });
      this.#inFlight = true;
      if (row.state !== 'deleting') await this.#set({ state: 'deleting' });
      return this.#next();
    }
    if (row.provider_id === null) {
      const lost = await this.#recoverLost(provider);
      if (lost === 'wait') return this.#next();
      if (lost === 'gone') return this.finish('deleted');
    }
    const gone = await this.#attempt(async () => {
      try {
        return await provider.resources.delete(row.kind, row.provider_id!, this.#call());
      } catch (error) {
        if (isComputeError(error, 'NOT_FOUND')) return { id: row.provider_id!, state: 'deleted' };
        throw error;
      }
    });
    if (!gone) return this.#next();
    if (gone.state === 'error') {
      await this.#set({
        state: 'error',
        message: gone.message ?? 'The provider refused to delete it',
      });
      return this.#next();
    }
    if (gone.state !== 'deleted') {
      this.#inFlight = true;
      await this.#set({ state: 'deleting' });
      return this.#next();
    }
    return this.finish('deleted');
  }

  /** Removes the ownership labels at the provider and leaves the resource running, then records it `released`. */
  async release({
    provider,
  }: {
    provider: ResourcesProvider;
    kind: ProviderResourceKind;
  }): Promise<number | undefined> {
    const row = this.#row;
    if (this.snapshot.liveChildren > 0) {
      // A child created as the release was asked for: it is deleted (through this parent, still managed) first.
      await this.#set({
        state: 'error',
        message: 'Resources still live in it; delete them before it can be released',
      });
      return this.#next();
    }
    if (row.provider_id === null) {
      const lost = await this.#recoverLost(provider);
      if (lost === 'wait') return this.#next();
      if (lost === 'gone') return this.finish('released');
    }
    if (typeof provider.resources.release !== 'function') {
      await this.#set({
        state: 'error',
        message: `Provider ${row.provider} cannot release resources`,
      });
      return this.#next();
    }
    const released = await this.#attempt(async () => {
      await provider.resources.release!(row.kind, row.provider_id!, this.#call());
      return { id: row.provider_id!, state: 'deleted' };
    });
    if (!released) return this.#next();
    if (released.state === 'error') {
      await this.#set({
        state: 'error',
        message: released.message ?? 'The provider refused to release it',
      });
      return this.#next();
    }
    return this.finish('released');
  }

  /** The resource is gone (or let go): it is `deleted` or `released`, its authz row and sealed secrets go. */
  async finish(state: 'deleted' | 'released'): Promise<number | undefined> {
    const row = this.#row;
    const done = await this.sql.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE cloud_resources
            SET state = $3, message = NULL, deleted_at = compute_now(), updated_at = compute_now(),
                secret_outputs = '{}'::jsonb
          WHERE id = $1 AND version = $2 AND state NOT IN ('deleted', 'released') RETURNING id`,
        [row.id, row.version, state],
      );
      if (rows.length === 0) return false;
      await this.deps.authz.remove(tx, {
        type: 'cloud-resource',
        id: row.id,
        tenantId: row.tenant_id,
      });
      await publish(this.deps, tx, row, state);
      return true;
    });
    if (!done) {
      await this.#changedMeanwhile();
      return this.#next();
    }
    // The values belonged to the provider resource: nothing can use them any more.
    await this.#destroy(Object.values(json(row.secret_outputs)));
    if (row.parent_id !== null)
      // A parent waiting for its children to go is woken.
      await this.sql.transaction((tx) => this.deps.work.enqueue(tx, resourcesWork, row.parent_id!));
    return this.#next();
  }
}

async function enqueueAll(
  context: ModuleContext,
  tx: SqlTx,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  if (typeof context.work.enqueueMany === 'function')
    await context.work.enqueueMany(tx, resourcesWork, ids);
  else for (const id of ids) await context.work.enqueue(tx, resourcesWork, id);
}

/**
 * The `cloud.resources` reconciler (key: a resource id). `all` (every 30 s) queues the resources still converging,
 * being deleted or released; `refresh` (every 5 minutes) queues the settled ones, `ready` and `error`, so an error is
 * retried and what changed at the provider is seen.
 */
export function resourcesReconciler(
  depsOf: (context: ModuleContext) => CloudResourcesDeps,
): Reconciler {
  return {
    name: resourcesWork,
    shardBy: 'none',
    periodic: [
      { key: 'all', every: '30s' },
      { key: 'refresh', every: '5m' },
    ],
    async run(context, key) {
      if (key === 'all' || key === 'refresh') {
        await context.sql.transaction(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            key === 'all'
              ? `SELECT id FROM cloud_resources
                  WHERE state IN ('pending', 'provisioning', 'updating', 'deleting')
                     OR (desired_state <> 'present' AND state NOT IN ('deleted', 'released'))
                  ORDER BY id`
              : `SELECT id FROM cloud_resources WHERE state IN ('ready', 'error') ORDER BY id`,
          );
          await enqueueAll(
            context,
            tx,
            rows.map((row) => row.id),
          );
        });
        return 'DONE';
      }
      const next = await reconcileResource(depsOf(context), context.sql, key, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, resourcesWork, key, { notBefore: next }),
        );
      return 'DONE';
    },
  };
}
