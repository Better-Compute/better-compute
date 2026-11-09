import { createHash } from 'node:crypto';
import {
  ComputeError,
  isComputeError,
  validateManifest,
  type ErrorCode,
  type CallContext,
  type Manifest,
  type ProviderDiscoveredResource,
  type ProviderResourceFamily,
  type ProviderResourceKind,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoKind } from '../kind.js';

// The DigitalOcean storage kinds (Spaces buckets and keys, CDN endpoints, Container Registry) as
// desired-state handlers of core's cloud-resources `ProviderResources` contract. The request, state,
// discovery and definition types are core's own (the names below are aliases kept for callers);
// what is particular to storage is the handler shape, `DoResourceKind`: a kind that carries its own
// clients (the API and the account's Spaces keys) and takes its spec already validated.
// `asDoKind` turns one into an entry of the provider-wide dispatcher (`DoKind`, `DoResources`),
// which is how the provider serves them; `storageDispatcher` serves them on their own. Every
// `ensure`/`delete` is idempotent and non-blocking, like `ProviderNetworks`.
//
// Refusals follow the contract: a resource this deployment does not manage is `INVALID_STATE`
// with reason `notManaged` (nothing is sent), one another deployment manages is `managedByAnother`,
// a spec change ensure cannot make in place is `replaceRequired`, and a spec that reaches an
// account-wide object on an account that is not the tenant's own is `INVALID_INPUT`, `accountWide`.

export type DoResourceFamily = ProviderResourceFamily;

/**
 * A resource's state (core's `ProviderResourceState`). `secretOutputs` carries values the caller
 * must seal into its SecretStore in the same run and never store or log in plain (a Spaces secret
 * key): they are returned once, by the `ensure` that created them. `spec` is the spec as
 * DigitalOcean reports it (from `get`, `adopt` and discovery), where it can be read back.
 */
export type DoResourceState = ProviderResourceState;

/** What `ensure` is asked for (core's `ProviderResourceRequest`). */
export type DoResourceRequest = ProviderResourceRequest;

/** What one kind's `ensure` (and `find`) gets: the request with its spec validated. */
export interface DoKindRequest<Spec> {
  name: string;
  spec: Spec;
  id?: string;
  parent?: string;
  labels?: Readonly<Record<string, string>>;
  /** Whose account it is (`ProviderResourceRequest.accountScope`); absent counts as `shared`. */
  accountScope?: 'tenant' | 'shared';
  /**
   * With `id`: the names of the secret outputs the caller holds sealed. A kind whose secret
   * DigitalOcean answers only once says so when its name is missing here, instead of reporting a
   * resource `ready` that nobody holds the secret of.
   */
  secretOutputs?: readonly string[];
}

/** A resource the account can see, managed by better-compute or not (core's own type). */
export type DoDiscoveredResource = ProviderDiscoveredResource;

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
  /**
   * (Pure.) The spec's fields that reach account-wide objects (`ProviderResourceKind.accountWide`):
   * the dispatcher refuses such a spec, before the kind is called, unless the account is the
   * tenant's own.
   */
  accountWide?(spec: Spec): readonly string[];
  ensure(request: DoKindRequest<Spec>, context: CallContext): Promise<DoResourceState>;
  /**
   * The id of what an earlier `ensure` of the request made, found as `ensure` finds it; read-only
   * (`ProviderResources.find`). The caller asks before it forgets a resource whose create was sent
   * but never answered.
   */
  find?(request: DoKindRequest<Spec>, context: CallContext): Promise<string | undefined>;
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

/**
 * Core's `ProviderResources`, served from a list of storage kinds. (Not `DoResources`: that name
 * is the provider-wide dispatcher of the cloud-resources lane, which `doStorageKinds` feeds.)
 */
export interface DoStorageResources {
  kinds(): readonly DoResourceKind[];
  ensure(request: DoResourceRequest, context: CallContext): Promise<DoResourceState>;
  find(request: DoResourceRequest, context: CallContext): Promise<string | undefined>;
  /** Whether `release` works for the kind (it has one), with nothing sent. */
  releasable(kind: string): boolean;
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

/** The contract's refusal of a resource another better-compute deployment manages. */
export function managedByAnother(message: string): ComputeError {
  return storageError('INVALID_STATE', message, 'managedByAnother');
}

/** The longest provider-side name of an untaggable resource (DO registry names: 63). */
const maxManagedName = 63;

/**
 * The names of one deployment's untaggable resources (Spaces keys, registries). Their owner is
 * their name, so the name carries the deployment: `bc-<deployment hash>-<rest>`.
 */
export interface ManagedNames {
  readonly prefix: string;
  /**
   * The provider-side name for a requested `bc-` name: the name itself when it already has this
   * deployment's prefix, else the prefix and the rest (hashed down to fit 63 characters).
   */
  provider(name: string, what: string): string;
  /** `this` for this deployment's names, `other` for another's `bc-` names, else undefined. */
  owner(name: string): 'this' | 'other' | undefined;
  /** Refuses (nothing sent) a name that is not this deployment's. */
  requireOwn(name: string, what: string): void;
}

export function managedNames(prefix: string): ManagedNames {
  if (!/^bc-[0-9a-f]{12}-$/.test(prefix))
    throw storageError('INVALID_CONFIG', 'Not a managed name prefix', 'namePrefix');
  const owner = (name: string): 'this' | 'other' | undefined =>
    !managedResourceName.test(name)
      ? undefined
      : name.startsWith(prefix) && name.length > prefix.length
        ? 'this'
        : 'other';
  return {
    prefix,
    provider(name, what) {
      checkManagedName(name, what);
      if (name.startsWith(prefix) && name.length > prefix.length) return name;
      const rest = name.slice('bc-'.length);
      const full = `${prefix}${rest}`;
      if (full.length <= maxManagedName) return full;
      const hash = createHash('sha256').update(rest).digest('hex').slice(0, 8);
      return `${prefix}${rest.slice(0, maxManagedName - prefix.length - 9)}-${hash}`;
    },
    owner,
    requireOwn(name, what) {
      const found = owner(name);
      if (found === 'this') return;
      if (found === 'other')
        throw managedByAnother(`${what} ${name} is managed by another better-compute deployment`);
      throw notManaged(`${what} ${name} is not one better-compute manages; it was left alone`);
    },
  };
}

/**
 * The request as a kind takes it: the spec validated (and defaulted) by the kind's manifest. A spec
 * that reaches account-wide objects is refused here, with nothing sent, unless the account is the
 * tenant's own (`find` is read-only and part of a teardown, so it does not refuse).
 */
async function kindRequest(
  handler: DoResourceKind,
  request: DoResourceRequest,
  use: 'ensure' | 'find',
): Promise<DoKindRequest<unknown>> {
  const spec: unknown = await validateManifest(handler.spec, request.spec);
  const reaching = use === 'ensure' ? (handler.accountWide?.(spec) ?? []) : [];
  if (reaching.length > 0 && request.accountScope !== 'tenant')
    throw storageError(
      'INVALID_INPUT',
      `${handler.kind}: ${reaching[0]} is account-wide; only a resource on the tenant's own account may name it`,
      'accountWide',
      { fields: [...reaching] },
    );
  return {
    name: request.name,
    spec,
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.parent !== undefined ? { parent: request.parent } : {}),
    ...(request.labels !== undefined ? { labels: request.labels } : {}),
    ...(request.accountScope !== undefined ? { accountScope: request.accountScope } : {}),
    ...(request.secretOutputs !== undefined ? { secretOutputs: request.secretOutputs } : {}),
  };
}

/** Validates (and defaults) the request's spec with the kind's manifest, then ensures. */
async function ensureValidated(
  handler: DoResourceKind,
  request: DoResourceRequest,
  context: CallContext,
): Promise<DoResourceState> {
  return handler.ensure(await kindRequest(handler, request, 'ensure'), context);
}

/** A kind's definition: core's `ProviderResourceKind` (the metadata, without the calls). */
export type DoStorageKindDefinition = ProviderResourceKind;

/**
 * A storage kind as an entry of the provider-wide DigitalOcean dispatcher (`DoKind`, served by
 * `DoResources`): its definition, and calls that take the dispatcher's env first. Storage kinds
 * carry their own clients (the API and the account's Spaces keys), so they ignore the env.
 */
export type DoStorageKindEntry = DoKind;

/** The definition of a kind: its metadata (and its pure `accountWide`), without its calls or extra helpers. */
export function kindDefinition(handler: DoResourceKind): DoStorageKindDefinition {
  const accountWide = handler.accountWide?.bind(handler);
  return {
    kind: handler.kind,
    family: handler.family,
    description: handler.description,
    spec: handler.spec as Manifest<unknown>,
    outputs: handler.outputs,
    ...(handler.secretOutputs ? { secretOutputs: handler.secretOutputs } : {}),
    regional: handler.regional,
    updatable: handler.updatable,
    ...(handler.meters ? { meters: handler.meters } : {}),
    ...(handler.preview !== undefined ? { preview: handler.preview } : {}),
    ...(handler.parent ? { parent: handler.parent } : {}),
    ...(accountWide ? { accountWide: (spec: unknown) => accountWide(spec) } : {}),
  };
}

/** A storage kind as a provider-wide `DoKind` entry (see `DoStorageKindEntry`). */
export function asDoKind(handler: DoResourceKind): DoStorageKindEntry {
  const handlerAdopt = handler.adopt?.bind(handler);
  const handlerRelease = handler.release?.bind(handler);
  const handlerDiscover = handler.discover?.bind(handler);
  const handlerFind = handler.find?.bind(handler);
  return {
    definition: kindDefinition(handler),
    ensure: (_env, request, context) => ensureValidated(handler, request, context),
    ...(handlerFind
      ? {
          find: async (_env: unknown, request: DoResourceRequest, context: CallContext) =>
            handlerFind(await kindRequest(handler, request, 'find'), context),
        }
      : {}),
    get: (_env, id, context) => handler.get(id, context),
    delete: (_env, id, context) => handler.delete(id, context),
    ...(handlerDiscover ? { discover: (_env: unknown, context: CallContext) => handlerDiscover(context) } : {}),
    ...(handlerAdopt
      ? {
          adopt: (
            _env: unknown,
            id: string,
            labels: Readonly<Record<string, string>>,
            context: CallContext,
          ) => handlerAdopt(id, labels, context),
        }
      : {}),
    ...(handlerRelease
      ? { release: (_env: unknown, id: string, context: CallContext) => handlerRelease(id, context) }
      : {}),
  };
}

export function storageDispatcher(kinds: readonly DoResourceKind[]): DoStorageResources {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
  const find = (kind: string): DoResourceKind => {
    const found = byKind.get(kind);
    if (!found)
      throw storageError('UNSUPPORTED', `DigitalOcean has no resource kind ${kind}`, 'kind');
    return found;
  };
  return {
    kinds: () => kinds,
    ensure: async (request, context) => ensureValidated(find(request.kind), request, context),
    async find(request, context) {
      const handler = find(request.kind);
      if (!handler.find)
        throw storageError('UNSUPPORTED', `${request.kind} cannot be looked up`, 'find');
      return handler.find(await kindRequest(handler, request, 'find'), context);
    },
    releasable: (kind) => typeof byKind.get(kind)?.release === 'function',
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
