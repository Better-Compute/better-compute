import type { DoEmulator } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// Tags. DO creates a tag object the first time a Droplet create names it, and the spelling it
// first sees is canonical (tags match case-insensitively). `state.tags` holds the objects, keyed
// by the lowercased name; `GET /v2/tags/{name}` counts the Droplets that carry one.

/** The shape of a `tag` body, from the fixture. */
const template = fixture('tags').tag as Json;

/** Creates the tag objects that don't exist yet, as a Droplet create that names them does. */
export function touchTags(state: DoState, names: readonly string[]): void {
  for (const name of names) {
    const key = name.toLowerCase();
    if (!state.tags.has(key)) state.tags.set(key, { name });
  }
}

/** Whether a Droplet carries the tag (case-insensitively). */
export function hasTag(droplet: Json, name: string): boolean {
  const wanted = name.toLowerCase();
  return ((droplet.tags as string[] | undefined) ?? []).some((tag) => tag.toLowerCase() === wanted);
}

export function registerTags(emulator: DoEmulator): void {
  emulator.route('GET', /^\/tags\/([^/]+)$/, (context) => {
    const tag = context.state.tags.get(decodeURIComponent(context.match[1]!).toLowerCase());
    if (!tag) return emulator.error('not-found');
    const droplets = [...context.state.droplets.values()].filter((d) => hasTag(d, tag.name));
    const last = droplets.at(-1);
    const lastUri = last ? `/v2/droplets/${last.id}` : '';
    return {
      status: 200,
      body: {
        tag: {
          ...structuredClone(template),
          name: tag.name,
          resources: {
            ...structuredClone(template.resources),
            count: droplets.length,
            last_tagged_uri: lastUri,
            droplets: { count: droplets.length, last_tagged_uri: lastUri },
          },
        },
      },
    };
  });
}
