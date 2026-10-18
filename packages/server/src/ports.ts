import {
  ComputeError,
  newId,
  type ComputeModule,
  type ModuleContext,
  type PkiPort,
  type SecretBroker,
  type SecretRef,
  type SecretResolveContext,
  type SecretStore,
  type SqlTx,
  type WorkflowEngine,
  type WorkloadIssuerPort,
} from '@better-compute/core';
import { defaultJoinTokenMinter, type JoinTokenMinter } from './api/join-tokens.js';

// The optional ModuleContext ports (PLAN.md §5.4) the host backs: `secrets` (the secret broker over
// the configured stores), `pki` (join tokens for agents a module brings up: provisioned installs,
// discovery ramdisks) and `workflows` (the provision module's engine, when it is hosted).

/**
 * The secret broker over the configured stores: `put` writes to the first store serving `secret://`
 * (or the first store), `resolve` and `delete` route by the ref's scheme. Values never reach logs.
 * A resolve context (the tenant a value is resolved for) reaches the store, which scopes by it.
 */
export function secretBroker(stores: readonly SecretStore[]): SecretBroker {
  if (!stores.length) throw new ComputeError('INVALID_CONFIG', 'The secret broker needs a store');
  const writer = stores.find((store) => store.schemes.includes('secret')) ?? stores[0]!;
  const storeFor = (ref: SecretRef): SecretStore => {
    const scheme = /^([a-z]+):\/\//.exec(ref)?.[1];
    const store = scheme
      ? stores.find((candidate) => candidate.schemes.includes(scheme))
      : undefined;
    if (!store) throw new ComputeError('INVALID_INPUT', 'No secret store serves this reference');
    return store;
  };
  return Object.freeze({
    put: (tenantId: string, value: string) => writer.put(tenantId, value),
    resolve: (ref: SecretRef, context?: SecretResolveContext) =>
      context ? storeFor(ref).resolve(ref, context) : storeFor(ref).resolve(ref),
    delete: (ref: SecretRef) => storeFor(ref).delete(ref),
  });
}

type IssueInput = Parameters<PkiPort['issueJoinToken']>[1];
const roles: ReadonlySet<string> = new Set(['node', 'site', 'provisioned', 'discovery']);
const macPattern = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/;

/**
 * `ctx.pki`: single-purpose join tokens minted in the caller's transaction (same bearer format and
 * `secret_hash` as `joinTokens.create`), optionally bound to one machine through `expect`; and, when
 * the host configures `pki.workloadIssuer`, that issuer as `workload`.
 */
export function pkiPort(
  minter: JoinTokenMinter = defaultJoinTokenMinter,
  workload?: WorkloadIssuerPort,
): PkiPort {
  return Object.freeze({
    ...(workload ? { workload } : {}),
    async issueJoinToken(tx: SqlTx, input: IssueInput) {
      if (!roles.has(input.role))
        throw new ComputeError(
          'INVALID_INPUT',
          `A join token cannot be for role ${String(input.role)}`,
        );
      if (
        !Number.isSafeInteger(input.ttlSeconds) ||
        input.ttlSeconds < 60 ||
        input.ttlSeconds > 86_400
      )
        throw new ComputeError('INVALID_INPUT', 'ttlSeconds must be between 60 and 86400');
      const maxUses = input.maxUses ?? 1;
      if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10_000)
        throw new ComputeError('INVALID_INPUT', 'maxUses must be between 1 and 10000');
      let expect: Record<string, string> | null = null;
      if (input.expect) {
        const entries = Object.entries(input.expect).filter(([, value]) => value !== undefined);
        if (!entries.length)
          throw new ComputeError('INVALID_INPUT', 'expect: name at least one identifier');
        expect = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<
          string,
          string
        >;
        if (expect.mac !== undefined) {
          if (!macPattern.test(expect.mac))
            throw new ComputeError('INVALID_INPUT', 'expect.mac is not a MAC');
          expect.mac = expect.mac.toLowerCase();
        }
      }
      const id = newId('jt');
      const { token, secretHash } = minter.mint(id);
      await tx.query(
        `INSERT INTO join_tokens (id, tenant_id, role, pool_id, site_id, secret_hash, uses_left, expect,
           allow_reclaim, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false, compute_now() + make_interval(secs => $9::int))`,
        [
          id,
          input.tenantId,
          input.role,
          input.poolId ?? null,
          input.siteId ?? null,
          secretHash,
          maxUses,
          expect ? JSON.stringify(expect) : null,
          input.ttlSeconds,
        ],
      );
      return { id, token };
    },
  });
}

/** A hosted module that runs workflows (`provisionModule()`): it exposes `workflowEngine(ctx)`. */
interface WorkflowHost extends ComputeModule {
  workflowEngine(context: Pick<ModuleContext, 'work' | 'events' | 'commands'>): WorkflowEngine;
}

/** The workflow engine of the one hosted module that offers it; two are a configuration error. */
export function workflowsOf(
  modules: readonly ComputeModule[],
  context: Pick<ModuleContext, 'work' | 'events' | 'commands'>,
): WorkflowEngine | undefined {
  const hosts = modules.filter(
    (module): module is WorkflowHost =>
      typeof (module as Partial<WorkflowHost>).workflowEngine === 'function',
  );
  if (hosts.length > 1)
    throw new ComputeError(
      'INVALID_CONFIG',
      `Only one module may run workflows: ${hosts.map((host) => host.name).join(', ')}`,
    );
  return hosts[0]?.workflowEngine(context);
}
