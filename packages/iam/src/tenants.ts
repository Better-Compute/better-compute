// `iamTenantReader`: the tenant subtree with each tenant's effective status, for the server's tenancy reaction
// (`tenantStateHandler(compute, { readTenants })`, PLAN.md §12.8). better-iam cascades a deletion into every
// descendant's own status, but a suspension only into its decisions (an ancestor that is not active refuses them),
// so a tenant's effective status here is the worst of its own and its ancestors'.

import { ComputeError, type Credential } from '@better-compute/core';
import { fromIamError } from './embedded.js';
import { credentialHeaders } from './remote.js';

type CredentialInput = Pick<Credential, 'headers' | 'token'>;

interface IamTenant {
  id: string;
  status: string;
  parentId?: string | null;
}

/** The part of a better-iam instance the reader uses (embedded mode); `betterIam()`'s result satisfies it. */
export interface TenantReaderHost {
  api: {
    tenants: {
      get(credential: CredentialInput, input: { tenantId: string }): Promise<IamTenant>;
      listChildren(credential: CredentialInput, input: { tenantId: string }): Promise<IamTenant[]>;
    };
  };
}

/**
 * The part of a better-iam HTTP client the reader uses (remote mode): `createIamClient()`'s result satisfies it. The
 * credential goes in each call's headers.
 */
export interface TenantReaderClient {
  tenants: {
    get(input: { tenantId: string }, options?: { headers?: HeadersInit }): Promise<IamTenant>;
    listChildren(
      input: { tenantId: string },
      options?: { headers?: HeadersInit },
    ): Promise<IamTenant[]>;
  };
}

/** One tenant as IAM reports it (structurally the server's `IamTenantStatus`). */
export interface TenantStatus {
  tenantId: string;
  status: 'active' | 'pending' | 'suspended' | 'deleted' | 'missing';
}

export interface TenantReaderOptions {
  /**
   * A root credential (compute's service account in the IAM root tenant): only root reads suspended and deleted
   * tenants and every tenant's children.
   */
  credential: Credential | (() => Credential | Promise<Credential>);
  /** Refuses a subtree larger than this (default 10 000 tenants). */
  maxTenants?: number;
}

/** Worse wins: a suspended parent suspends an active or pending child; a deleted one deletes it. */
const rank: Record<TenantStatus['status'], number> = {
  active: 0,
  pending: 1,
  suspended: 2,
  deleted: 3,
  missing: 4,
};

const statusOf = (value: string): TenantStatus['status'] =>
  value === 'pending' || value === 'suspended' || value === 'deleted' ? value : 'active';

const worst = (a: TenantStatus['status'], b: TenantStatus['status']) => (rank[b] > rank[a] ? b : a);

const notFound = (error: unknown) => {
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === 'NOT_FOUND' || status === 404;
};

/**
 * `readTenants` for the tenancy reaction: the tenant and every tenant below it, each with its effective status
 * (its own, or an ancestor's when that is worse). A tenant IAM no longer knows is `missing`.
 */
export function iamTenantReader(
  iam: TenantReaderHost | TenantReaderClient,
  options: TenantReaderOptions,
): (tenantId: string) => Promise<TenantStatus[]> {
  const maxTenants = options.maxTenants ?? 10_000;
  const credential = async (): Promise<CredentialInput> => {
    const value =
      typeof options.credential === 'function' ? await options.credential() : options.credential;
    return {
      ...(value.headers === undefined ? {} : { headers: value.headers }),
      ...(value.token === undefined ? {} : { token: value.token }),
    };
  };
  // Embedded: the credential is the first argument; over HTTP: headers on each call.
  const calls = (input: CredentialInput) =>
    'api' in iam
      ? {
          get: (tenantId: string) => iam.api.tenants.get(input, { tenantId }),
          children: (tenantId: string) => iam.api.tenants.listChildren(input, { tenantId }),
        }
      : {
          get: (tenantId: string) =>
            iam.tenants.get({ tenantId }, { headers: credentialHeaders(input) }),
          children: (tenantId: string) =>
            iam.tenants.listChildren({ tenantId }, { headers: credentialHeaders(input) }),
        };
  return async (tenantId) => {
    const api = calls(await credential());
    const get = async (id: string): Promise<IamTenant | undefined> => {
      try {
        return await api.get(id);
      } catch (error) {
        if (notFound(error)) return undefined;
        throw fromIamError(error);
      }
    };
    const target = await get(tenantId);
    if (!target) return [{ tenantId, status: 'missing' }];

    // What the ancestors impose.
    let inherited: TenantStatus['status'] = 'active';
    const seen = new Set([target.id]);
    for (let parentId = target.parentId; parentId && !seen.has(parentId); ) {
      seen.add(parentId);
      const parent = await get(parentId);
      if (!parent) break;
      inherited = worst(inherited, statusOf(parent.status));
      parentId = parent.parentId;
    }

    const out: TenantStatus[] = [];
    const queue: { tenant: IamTenant; inherited: TenantStatus['status'] }[] = [
      { tenant: target, inherited },
    ];
    const visited = new Set<string>();
    while (queue.length) {
      const { tenant, inherited: above } = queue.shift()!;
      if (visited.has(tenant.id)) continue;
      visited.add(tenant.id);
      if (visited.size > maxTenants)
        throw new ComputeError(
          'INVALID_STATE',
          `Tenant ${tenantId} has more than ${maxTenants} descendants`,
        );
      const status = worst(statusOf(tenant.status), above);
      out.push({ tenantId: tenant.id, status });
      let children: IamTenant[];
      try {
        children = await api.children(tenant.id);
      } catch (error) {
        if (notFound(error)) continue;
        throw fromIamError(error);
      }
      for (const child of children) queue.push({ tenant: child, inherited: status });
    }
    return out;
  };
}
