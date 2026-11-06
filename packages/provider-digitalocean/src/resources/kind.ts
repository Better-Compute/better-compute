import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceKind,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { keyTag, labels, tagFor } from '../ids.js';

// What every DigitalOcean resource kind is made of: its definition (the provider-neutral ProviderResourceKind) and
// the calls behind it. Kinds share the ownership rules here: a taggable resource carries the managed tag, this
// deployment's tag, the idempotency key's tag and the module's ownership labels as `<key>:<value>` tags (DO-D5);
// a resource that cannot be tagged (a database user, a pool) is owned through the resource it lives in.

/** What a kind's calls get besides the call context. */
export interface DoKindEnv {
  client: DoClient;
  /** This deployment's tag (`better-compute-deployment:<h>`). */
  deploymentTag: string;
  /** The account enables previews (`previews: true`). */
  previews: boolean;
}

/** One DigitalOcean resource kind. */
export interface DoKind {
  readonly definition: ProviderResourceKind;
  ensure(
    env: DoKindEnv,
    request: ProviderResourceRequest,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  get(env: DoKindEnv, id: string, context: CallContext): Promise<ProviderResourceState | undefined>;
  delete(env: DoKindEnv, id: string, context: CallContext): Promise<ProviderResourceState>;
  discover?(env: DoKindEnv, context: CallContext): AsyncIterable<ProviderDiscoveredResource>;
  adopt?(
    env: DoKindEnv,
    id: string,
    labels: Readonly<Record<string, string>>,
    context: CallContext,
  ): Promise<ProviderResourceState>;
  release?(env: DoKindEnv, id: string, context: CallContext): Promise<void>;
}

export const managedTag = tagFor(labels.managed, 'true');
const managedPrefix = 'better-compute-';
const deploymentPrefix = `${labels.deployment}:`;

/** The tags a new resource carries: its ownership labels, this deployment, and the call's key. */
export function ownershipTags(
  env: DoKindEnv,
  requestLabels: Readonly<Record<string, string>> | undefined,
  context: CallContext,
): string[] {
  const tags = new Set<string>([managedTag, env.deploymentTag, keyTag(context.idempotencyKey)]);
  for (const [key, value] of Object.entries(requestLabels ?? {}))
    if (key.startsWith(managedPrefix)) tags.add(tagFor(key, value));
  return [...tags];
}

const hasTag = (tags: readonly string[] | null | undefined, tag: string) =>
  (tags ?? []).some((entry) => entry.toLowerCase() === tag);

/** `this` when the tags say this deployment manages it, `other` when another one does, else undefined. */
export function managedBy(
  env: DoKindEnv,
  tags: readonly string[] | null | undefined,
): 'this' | 'other' | undefined {
  const deployments = (tags ?? []).filter((tag) => tag.toLowerCase().startsWith(deploymentPrefix));
  if (hasTag(tags, managedTag) && hasTag(tags, env.deploymentTag)) return 'this';
  if (deployments.some((tag) => tag.toLowerCase() !== env.deploymentTag)) return 'other';
  return undefined;
}

/** Throws `INVALID_STATE` (`notManaged`) unless this deployment manages the resource. Nothing is sent then. */
export function assertOwned(
  env: DoKindEnv,
  tags: readonly string[] | null | undefined,
  what: string,
): void {
  if (managedBy(env, tags) !== 'this')
    throw new ComputeError(
      'INVALID_STATE',
      `${what} is not managed by this better-compute deployment; it is left alone`,
      undefined,
      { provider: 'digitalocean', reason: 'notManaged' },
    );
}

/** The better-compute tags of a resource (what `release` takes off). */
export const ownTags = (tags: readonly string[] | null | undefined): string[] =>
  (tags ?? []).filter((tag) => tag.toLowerCase().startsWith(managedPrefix));

/** `INVALID_STATE` with `replaceRequired`: the field cannot change in place. */
export function replaceRequired(kind: string, field: string, why?: string): ComputeError {
  return new ComputeError(
    'INVALID_STATE',
    `${kind}: ${field} cannot change in place${why ? ` (${why})` : ''}; create a new resource instead`,
    undefined,
    { provider: 'digitalocean', reason: 'replaceRequired', field },
  );
}

/**
 * Runs a call that carries resolved secrets. An error that echoes one of them (in its message, or anywhere in its
 * details, keys included) is rethrown with every occurrence replaced by `********` and no cause, so the value
 * never reaches a row, an event or a log. Any other error is rethrown as is.
 */
export async function scrubbing<T>(secrets: readonly string[], call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const values = secrets.filter((secret) => secret.length > 0);
    if (values.length === 0 || !(error instanceof Error)) throw error;
    const mask = (text: string) =>
      values.reduce((out, secret) => out.split(secret).join('********'), text);
    const leaks = (text: string) => values.some((secret) => text.includes(secret));
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') return mask(value);
      if (Array.isArray(value)) return value.map(scrub);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [mask(key), scrub(entry)]),
        );
      return value;
    };
    const details = error instanceof ComputeError ? error.details : undefined;
    const detailsLeak =
      details !== undefined && JSON.stringify(scrub(details)) !== JSON.stringify(details);
    if (!leaks(error.message) && !detailsLeak) throw error;
    if (error instanceof ComputeError)
      throw new ComputeError(
        error.code,
        mask(error.message),
        error.status,
        details === undefined ? undefined : (scrub(details) as Record<string, unknown>),
      );
    throw new Error(mask(error.message));
  }
}

/** A GET that answers undefined for a resource that is gone. */
export async function found<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isComputeError(error, 'NOT_FOUND')) return undefined;
    throw error;
  }
}

/** Puts tags on one resource of `type` (never a tag-scoped bulk call), making each tag object first. */
export async function tagResource(
  client: DoClient,
  type: 'database',
  id: string,
  tags: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const tag of tags) {
    try {
      await client.request('POST', '/tags', { body: { name: tag }, signal, budget: 'mutate' });
    } catch (error) {
      if (!isComputeError(error, 'CONFLICT')) throw error;
    }
    await client.request('POST', `/tags/${encodeURIComponent(tag)}/resources`, {
      body: { resources: [{ resource_id: id, resource_type: type }] },
      signal,
      budget: 'mutate',
    });
  }
}

/** Takes tags off one resource of `type`; a tag or resource that is gone counts as done. */
export async function untagResource(
  client: DoClient,
  type: 'database',
  id: string,
  tags: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const tag of tags)
    try {
      await client.request('DELETE', `/tags/${encodeURIComponent(tag)}/resources`, {
        body: { resources: [{ resource_id: id, resource_type: type }] },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
}

/** Only the outputs that have a value, as strings. */
export function strings(values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== '') out[name] = String(value);
  return out;
}

/** `region/…` ids of child resources: `<parent uuid>/<name>`. */
export function childId(parent: string, name: string): string {
  return `${parent}/${name}`;
}

/** Splits a child id; anything else is `INVALID_INPUT`. `parentPattern` is the parent's id (a uuid by default). */
export function parseChildId(
  kind: string,
  id: string,
  parentPattern: RegExp = /^[0-9a-f-]{8,64}$/,
): { parent: string; name: string } {
  const slash = id.indexOf('/');
  const parent = slash > 0 ? id.slice(0, slash) : '';
  const name = slash > 0 ? id.slice(slash + 1) : '';
  if (!parentPattern.test(parent) || !/^[A-Za-z0-9_.-]{1,128}$/.test(name))
    throw new ComputeError(
      'INVALID_INPUT',
      `${JSON.stringify(id)} is not a ${kind} id`,
      undefined,
      {
        provider: 'digitalocean',
        reason: 'resourceId',
      },
    );
  return { parent, name };
}
