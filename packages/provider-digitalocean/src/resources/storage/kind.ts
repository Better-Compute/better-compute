import {
  ComputeError,
  isComputeError,
  validateManifest,
  type ErrorCode,
  type CallContext,
  type Manifest,
  type ProviderResourceState,
} from '@better-compute/core';

// The DigitalOcean storage kinds (Spaces buckets and keys, CDN endpoints, Container Registry) as
// desired-state handlers. The shapes are those of core's cloud-resources `ProviderResources`
// contract (kinds, a request-shaped `ensure`, `get`, `delete`, `discover`, `adopt`, `release`),
// restated here until that contract is on this base, so `doStorageResources(...)` plugs into the
// cloud-resources dispatcher as it is. Every `ensure`/`delete` is idempotent and non-blocking,
// like `ProviderNetworks`.
//
// Refusals follow the contract: a resource this deployment does not manage is `INVALID_STATE`
// with reason `notManaged` (nothing is sent), one another deployment manages is `managedByAnother`,
// and a spec change ensure cannot make in place is `replaceRequired`.

export type DoResourceFamily =
  | 'storage'
  | 'network'
  | 'edge'
  | 'data'
  | 'platform'
  | 'ai'
  | 'observability';

/**
 * A resource's state. `secretOutputs` carries values the caller must seal into its SecretStore in
 * the same run and never store or log in plain (a Spaces secret key): they are returned once, by
 * the `ensure` that created them. `spec` is the spec as DigitalOcean reports it (from `get`,
 * `adopt` and discovery), in the kind's spec shape, where it can be read back.
 */
export interface DoResourceState extends ProviderResourceState {
  secretOutputs?: Readonly<Record<string, string>>;
  spec?: Readonly<Record<string, unknown>>;
}

/** What `ensure` is asked for (core's `ProviderResourceRequest`). */
export interface DoResourceRequest {
  kind: string;
  /** The provider-side name the caller derives (`bc-r-…`); stable across calls. */
  name: string;
  /** The spec; the dispatcher validates it with the kind's manifest. */
  spec: unknown;
  /** The provider id an earlier `ensure` (or an adopt) answered: it wins over `name`. */
  id?: string;
  /** For a kind with a `parent`: the provider id of the resource it lives in. */
  parent?: string;
  /** Ownership labels (`better-compute-managed`, `-resource`, `-tenant`). */
  labels?: Readonly<Record<string, string>>;
}

/** What one kind's `ensure` gets: the request with its spec validated. */
export interface DoKindRequest<Spec> {
  name: string;
  spec: Spec;
  id?: string;
  parent?: string;
  labels?: Readonly<Record<string, string>>;
}

/** A resource the account can see, managed by better-compute or not. */
export interface DoDiscoveredResource {
  id: string;
  name: string;
  region?: string;
  /** `this`: this deployment manages it; `other`: another deployment does; absent: no one does. */
  managedBy?: 'this' | 'other';
  outputs?: Readonly<Record<string, string>>;
  spec?: Readonly<Record<string, unknown>>;
}

export interface DoResourceKind<Spec = any> {
  /** Provider-prefixed, `[a-z0-9.-]`: `do.spaces-bucket`. */
  readonly kind: string;
  readonly family: DoResourceFamily;
  readonly description: string;
  /** Validated before any provider call. */
  readonly spec: Manifest<Spec>;
  readonly outputs: readonly string[];
  readonly secretOutputs?: readonly string[];
  readonly regional: boolean;
  /** Spec fields `ensure` may change in place; a change to any other is refused (replace). */
  readonly updatable: readonly string[];
  readonly meters?: readonly { meter: string; unit: string }[];
  readonly preview?: boolean;
  /** Another kind this one lives in. */
  readonly parent?: string;
  ensure(request: DoKindRequest<Spec>, context: CallContext): Promise<DoResourceState>;
  get(id: string, context: CallContext): Promise<DoResourceState | undefined>;
  delete(id: string, context: CallContext): Promise<DoResourceState>;
  /** Resources of this kind in the account, managed or not (for adopt). */
  discover?(context: CallContext): AsyncIterable<DoDiscoveredResource>;
  /** Takes over an unmanaged resource (`managedByAnother` for another deployment's). */
  adopt?(
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<DoResourceState>;
  /** Gives the resource up and leaves it running. */
  release?(id: string, context: CallContext): Promise<void>;
}

/** Core's `ProviderResources`, served from a list of kinds. */
export interface DoResources {
  kinds(): readonly DoResourceKind[];
  ensure(request: DoResourceRequest, context: CallContext): Promise<DoResourceState>;
  get(kind: string, id: string, context: CallContext): Promise<DoResourceState | undefined>;
  delete(kind: string, id: string, context: CallContext): Promise<DoResourceState>;
  discover(kind: string, context: CallContext): AsyncIterable<DoDiscoveredResource>;
  adopt(
    kind: string,
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<DoResourceState>;
  release(kind: string, id: string, context: CallContext): Promise<void>;
}

/** The provider-side name of a managed resource that cannot carry tags: `bc-` + `[a-z0-9-]`. */
export const managedResourceName = /^bc-[a-z0-9][a-z0-9-]{0,60}$/;

export function storageError(
  code: ErrorCode,
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason, ...extra });
}

/** Refuses a name that is not a managed (`bc-`) resource name. */
export function checkManagedName(name: string, what: string): void {
  if (!managedResourceName.test(name))
    throw storageError(
      'INVALID_INPUT',
      `${what} name ${JSON.stringify(name)} must be bc- followed by 1 to 61 lower-case letters, digits and dashes`,
      'name',
    );
}

/** The contract's refusal of a resource this deployment does not manage. */
export function notManaged(message: string): ComputeError {
  return storageError('INVALID_STATE', message, 'notManaged');
}

export function doResources(kinds: readonly DoResourceKind[]): DoResources {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
  const find = (kind: string): DoResourceKind => {
    const found = byKind.get(kind);
    if (!found)
      throw storageError('UNSUPPORTED', `DigitalOcean has no resource kind ${kind}`, 'kind');
    return found;
  };
  return {
    kinds: () => kinds,
    async ensure(request, context) {
      const handler = find(request.kind);
      const spec: unknown = await validateManifest(handler.spec, request.spec);
      return handler.ensure(
        {
          name: request.name,
          spec,
          ...(request.id !== undefined ? { id: request.id } : {}),
          ...(request.parent !== undefined ? { parent: request.parent } : {}),
          ...(request.labels !== undefined ? { labels: request.labels } : {}),
        },
        context,
      );
    },
    get: async (kind, id, context) => find(kind).get(id, context),
    delete: async (kind, id, context) => find(kind).delete(id, context),
    discover(kind, context) {
      const handler = find(kind);
      if (!handler.discover)
        throw storageError('UNSUPPORTED', `${kind} has no discovery`, 'discover');
      return handler.discover(context);
    },
    async adopt(kind, id, labels, context) {
      const handler = find(kind);
      if (!handler.adopt)
        throw storageError(
          'UNSUPPORTED',
          `${kind} is owned by its name; it cannot be adopted`,
          'adopt',
        );
      return handler.adopt(id, labels, context);
    },
    async release(kind, id, context) {
      const handler = find(kind);
      if (!handler.release)
        throw storageError(
          'UNSUPPORTED',
          `${kind} is owned by its name; it cannot be released`,
          'adopt',
        );
      return handler.release(id, context);
    },
  };
}

/** Whether an error is a ComputeError with `code` (the DO client throws NOT_FOUND on 404). */
export function hasCode(error: unknown, code: string): boolean {
  return isComputeError(error) && error.code === code;
}
