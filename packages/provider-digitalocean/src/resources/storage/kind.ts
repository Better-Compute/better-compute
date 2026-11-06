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
// desired-state handlers. The metadata mirrors the program plan's `ProviderResourceKind` (P7), so
// the cloud-resources dispatcher can serve them as they are once that contract lands in core;
// until then `doResources` is the dispatcher. Every `ensure`/`delete` is idempotent and
// non-blocking, like `ProviderNetworks`.

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
 * the `ensure` that created them.
 */
export interface DoResourceState extends ProviderResourceState {
  secretOutputs?: Readonly<Record<string, string>>;
}

export interface DoResourceKind<Spec = any> {
  /** Provider-prefixed, `[a-z0-9.-]`: `do.spaces-bucket`. */
  readonly kind: string;
  readonly family: DoResourceFamily;
  /** Validated before any provider call. */
  readonly spec: Manifest<Spec>;
  readonly outputs: readonly string[];
  readonly secretOutputs?: readonly string[];
  readonly regional: boolean;
  /** Spec fields `ensure` may change in place; a change to any other is refused (replace). */
  readonly updatable: readonly string[];
  readonly meters?: readonly { meter: string; unit: string }[];
  readonly preview?: boolean;
  ensure(name: string, spec: Spec, context: CallContext): Promise<DoResourceState>;
  get(id: string, context: CallContext): Promise<DoResourceState | undefined>;
  delete(id: string, context: CallContext): Promise<DoResourceState>;
  /** Resources of this kind in the account, managed or not (for adopt). */
  discover?(context: CallContext): AsyncIterable<{ id: string; name: string; managedBy?: string }>;
}

/** The plan's `ProviderResources`, served from a list of kinds. */
export interface DoResources {
  kinds(): readonly DoResourceKind[];
  ensure(kind: string, name: string, spec: unknown, context: CallContext): Promise<DoResourceState>;
  get(kind: string, id: string, context: CallContext): Promise<DoResourceState | undefined>;
  delete(kind: string, id: string, context: CallContext): Promise<DoResourceState>;
  discover(
    kind: string,
    context: CallContext,
  ): AsyncIterable<{ id: string; name: string; managedBy?: string }>;
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
    async ensure(kind, name, spec, context) {
      const handler = find(kind);
      const valid: unknown = await validateManifest(handler.spec, spec);
      return handler.ensure(name, valid, context);
    },
    get: (kind, id, context) => find(kind).get(id, context),
    delete: (kind, id, context) => find(kind).delete(id, context),
    discover(kind, context) {
      const handler = find(kind);
      if (!handler.discover)
        throw storageError('UNSUPPORTED', `${kind} has no discovery`, 'discover');
      return handler.discover(context);
    },
  };
}

/** Whether an error is a ComputeError with `code` (the DO client throws NOT_FOUND on 404). */
export function hasCode(error: unknown, code: string): boolean {
  return isComputeError(error) && error.code === code;
}
