import type { CallContext, ProviderCatalogEntry } from '@better-compute/core';
import type { DoClient } from '../client/http.js';

// 1-Click applications (`GET /v2/1-clicks`): the catalog `cloudResources.catalog` lists. A Droplet 1-Click installs
// as the image of a Droplet create (its slug is the image slug); a Kubernetes one as an add-on of a DOKS cluster
// (P5). One `sweep` call, unpaged. The body shape (`{ "1_clicks": [{ slug, type }] }`) follows the API reference,
// not a recording: the live suite captures it before release. An entry of a type this provider does not know is
// dropped.

const installsOn: Readonly<Record<string, ProviderCatalogEntry['installsOn']>> = {
  droplet: 'instance',
  kubernetes: 'kubernetes',
};

export async function oneClickCatalog(
  client: DoClient,
  context: CallContext,
): Promise<ProviderCatalogEntry[]> {
  const reply = await client.request<{ '1_clicks'?: { slug?: unknown; type?: unknown }[] | null }>(
    'GET',
    '/1-clicks',
    { signal: context.signal, budget: 'sweep' },
  );
  const entries: ProviderCatalogEntry[] = [];
  for (const entry of Array.isArray(reply?.['1_clicks']) ? reply['1_clicks'] : []) {
    const target = typeof entry?.type === 'string' ? installsOn[entry.type] : undefined;
    if (typeof entry?.slug === 'string' && entry.slug.length > 0 && target)
      entries.push({ slug: entry.slug, installsOn: target });
  }
  return entries;
}
