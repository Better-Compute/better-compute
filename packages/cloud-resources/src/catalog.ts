import { ComputeError, type MethodContext, type ProviderCatalogEntry } from '@better-compute/core';
import { poolResources, tenantSecrets, type CloudResourcesDeps } from './store.js';
import type { CatalogEntryView, CatalogInput } from './types.js';

// `cloudResources.catalog`: the installable applications (DigitalOcean 1-Click apps and the like) the pool's provider
// lists. Read-only: an entry is installed through another surface (an instance create's image, a managed cluster's
// add-on), never through `create`. The pool is resolved in a transaction; the provider is asked with none open.

/** At most this many entries are returned. */
export const maxCatalogEntries = 1000;
const slugPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const targets: ReadonlySet<string> = new Set(['instance', 'kubernetes']);

/** A provider's entry as the API shows it; a malformed one (a bad slug, an unknown target) is dropped. */
function entryView(entry: ProviderCatalogEntry): CatalogEntryView | undefined {
  if (typeof entry?.slug !== 'string' || !slugPattern.test(entry.slug)) return undefined;
  if (!targets.has(entry.installsOn)) return undefined;
  const name =
    typeof entry.name === 'string' && entry.name.length > 0 ? entry.name.slice(0, 200) : undefined;
  return { slug: entry.slug, installsOn: entry.installsOn, ...(name ? { name } : {}) };
}

export async function listCatalog(
  deps: CloudResourcesDeps,
  context: MethodContext,
  input: CatalogInput,
): Promise<{ items: CatalogEntryView[] }> {
  const provider = await context.sql.transaction((tx) =>
    poolResources(deps, tx, input.tenantId, input.poolId),
  );
  if (typeof provider.resources.catalog !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${provider.account.provider} lists no installable applications`,
      undefined,
      { reason: 'catalog' },
    );
  const entries = await provider.resources.catalog({
    idempotencyKey: `catalog:${provider.account.id}`,
    signal: context.signal ?? new AbortController().signal,
    clock: deps.clock,
    secrets: tenantSecrets(deps, input.tenantId),
    log: deps.log,
  });
  const items: CatalogEntryView[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const view = entryView(entry);
    if (!view || (input.installsOn !== undefined && view.installsOn !== input.installsOn)) continue;
    const id = `${view.installsOn}:${view.slug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(view);
    if (items.length >= maxCatalogEntries) break;
  }
  return { items };
}
