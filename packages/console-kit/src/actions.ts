import {
  apiMethod,
  apiSurface,
  resourceType,
  type ApiSurfaceRow,
  type ComputeResourceKind,
} from '@better-compute/core';
import { createStore, type Store } from './store.js';

// Permission-aware actions (PLAN.md §9.2, §12): every button maps to one API method, and so to the
// IAM action and resource the server will decide. The console asks IAM ahead of time (batched,
// cached for a short while) whether to enable it; the server still decides every call, so a stale
// "allowed" only ever produces a clean ACCESS_DENIED.

export interface ActionDescriptor {
  group: string;
  method: string;
  /** The route: `${group}/${method}`. */
  path: string;
  /** `compute:reservations:release`. */
  action: string;
  /** The IAM resource, with the type prefix (`compute-reservation`). */
  resource: { type: string; id: string };
  kind: ApiSurfaceRow['kind'];
}

/** The descriptor of `group.method` on one resource. Throws for a method outside §9.2. */
export function describeAction(
  group: string,
  method: string,
  resourceId: string,
  options: { prefix?: string; resourceKind?: ComputeResourceKind } = {},
): ActionDescriptor {
  const row = apiMethod(group, method);
  if (!row || !row.action) throw new Error(`${group}.${method} is not a decided API method`);
  const target =
    options.resourceKind && options.resourceKind !== row.resource
      ? row.alternatives?.find((alternative) => alternative.resource === options.resourceKind)
      : { action: row.action, resource: row.resource! };
  if (!target) throw new Error(`${group}.${method} does not act on ${options.resourceKind}`);
  return {
    group,
    method,
    path: `${group}/${method}`,
    // Catalog actions are already `compute:<area>:<verb>`.
    action: target.action,
    resource: { type: resourceType(target.resource, options.prefix), id: resourceId },
    kind: row.kind,
  };
}

/**
 * Every mutation that acts on a resource of `kind` (its detail page's buttons), optionally limited
 * to methods of the phases the deployment runs.
 */
export function actionsFor(
  kind: ComputeResourceKind,
  resourceId: string,
  options: { prefix?: string; phases?: readonly string[]; modules?: readonly string[] } = {},
): ActionDescriptor[] {
  return apiSurface
    .filter(
      (row) =>
        row.kind === 'mutation' &&
        row.action !== null &&
        (row.resource === kind || row.alternatives?.some((alt) => alt.resource === kind)) &&
        (!options.phases || options.phases.includes(row.phase)) &&
        (!options.modules || options.modules.includes(row.module)),
    )
    .map((row) =>
      describeAction(row.group, row.method, resourceId, {
        ...(options.prefix ? { prefix: options.prefix } : {}),
        resourceKind: kind,
      }),
    );
}

export interface PermissionCheck {
  action: string;
  resource: { type: string; id: string };
}

export interface Permissions extends Store<ReadonlyMap<string, boolean>> {
  /** Whether the caller may do it (batched with other checks in the same tick, then cached). */
  can(check: PermissionCheck): Promise<boolean>;
  /** The cached answer, if any (render disabled until it arrives). */
  peek(check: PermissionCheck): boolean | undefined;
  /** Forgets every answer (sign-in change, `iam` inbox event). */
  clear(): void;
}

const keyOf = (check: PermissionCheck) =>
  `${check.action}\u0000${check.resource.type}\u0000${check.resource.id}`;

/**
 * Batches permission checks through `authorize` (better-iam's `authorizeMany` for the caller's
 * tenant: at most 50 per call) and caches answers for `ttlMs` (default 10 s, the server's own read
 * cache). A failed batch leaves its checks unanswered rather than denied (P11: never "all false").
 */
export function createPermissions(options: {
  authorize(checks: PermissionCheck[]): Promise<boolean[]>;
  ttlMs?: number;
  now?: () => number;
}): Permissions {
  const ttl = options.ttlMs ?? 10_000;
  const now = options.now ?? Date.now;
  const answers = createStore<ReadonlyMap<string, boolean>>(new Map());
  const expiry = new Map<string, number>();
  const waiting = new Map<
    string,
    {
      check: PermissionCheck;
      resolve: ((value: boolean) => void)[];
      reject: ((error: unknown) => void)[];
    }
  >();
  let flushing = false;

  const flush = async () => {
    flushing = false;
    const batch = [...waiting.values()];
    waiting.clear();
    for (let start = 0; start < batch.length; start += 50) {
      const chunk = batch.slice(start, start + 50);
      try {
        const results = await options.authorize(chunk.map((entry) => entry.check));
        if (results.length !== chunk.length)
          throw new Error('authorize answered the wrong number of checks');
        const next = new Map(answers.get());
        chunk.forEach((entry, index) => {
          const key = keyOf(entry.check);
          next.set(key, results[index] === true);
          expiry.set(key, now() + ttl);
          for (const resolve of entry.resolve) resolve(results[index] === true);
        });
        answers.set(next);
      } catch (error) {
        for (const entry of chunk) for (const reject of entry.reject) reject(error);
      }
    }
  };

  const fresh = (key: string) => (expiry.get(key) ?? 0) > now();

  return {
    get: answers.get,
    subscribe: answers.subscribe,
    can(check) {
      const key = keyOf(check);
      if (fresh(key)) return Promise.resolve(answers.get().get(key) === true);
      return new Promise<boolean>((resolve, reject) => {
        const entry = waiting.get(key) ?? { check, resolve: [], reject: [] };
        entry.resolve.push(resolve);
        entry.reject.push(reject);
        waiting.set(key, entry);
        if (!flushing) {
          flushing = true;
          queueMicrotask(() => void flush());
        }
      });
    },
    peek(check) {
      const key = keyOf(check);
      return fresh(key) ? answers.get().get(key) : undefined;
    },
    clear() {
      expiry.clear();
      answers.set(new Map());
    },
  };
}
