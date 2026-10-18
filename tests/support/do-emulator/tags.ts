import type { DoEmulator, RouteContext } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// Tags. DO creates a tag object the first time a Droplet create names it, and the spelling it
// first sees is canonical (tags match case-insensitively). `state.tags` holds the objects, keyed
// by the lowercased name; `GET /v2/tags/{name}` counts the Droplets that carry one. `POST /tags`
// makes a tag object (a second one with the same name is a 422), and `POST` / `DELETE
// /tags/{name}/resources` assign it to and unassign it from Droplets, as the spec's
// tags_resource.yml has them: the tag must exist, and both answer 204.

/** The shape of a `tag` body, from the fixture. */
const template = fixture('tags').tag as Json;

const tagPattern = /^[a-zA-Z0-9_:-]{1,255}$/;

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

/** A `tag` body: the fixture's shape, with the Droplets that carry the tag counted. */
function tagBody(state: DoState, name: string): Json {
  const droplets = [...state.droplets.values()].filter((d) => hasTag(d, name));
  const last = droplets.at(-1);
  const lastUri = last ? `/v2/droplets/${last.id}` : '';
  return {
    ...structuredClone(template),
    name,
    resources: {
      ...structuredClone(template.resources),
      count: droplets.length,
      last_tagged_uri: lastUri,
      droplets: { count: droplets.length, last_tagged_uri: lastUri },
    },
  };
}

/**
 * The Droplets a `resources` request names: undefined when the body is not valid, an empty list
 * when one of them is not in the account.
 */
function namedDroplets(context: RouteContext): Json[] | undefined {
  const resources = context.body?.resources;
  if (!Array.isArray(resources) || resources.length === 0) return undefined;
  const droplets: Json[] = [];
  for (const resource of resources) {
    if (resource?.resource_type !== 'droplet' || typeof resource.resource_id !== 'string')
      return undefined;
    const droplet = context.state.droplets.get(Number(resource.resource_id));
    if (!droplet) return [];
    droplets.push(droplet);
  }
  return droplets;
}

export function registerTags(emulator: DoEmulator): void {
  emulator.route('GET', /^\/tags\/([^/]+)$/, (context) => {
    const tag = context.state.tags.get(decodeURIComponent(context.match[1]!).toLowerCase());
    if (!tag) return emulator.error('not-found');
    return { status: 200, body: { tag: tagBody(context.state, tag.name) } };
  });

  emulator.route('POST', /^\/tags$/, (context) => {
    const name = context.body?.name;
    if (typeof name !== 'string' || !tagPattern.test(name)) return emulator.error('422-unknown');
    if (context.state.tags.has(name.toLowerCase())) return emulator.error('422-tag-exists');
    context.state.tags.set(name.toLowerCase(), { name });
    return { status: 201, body: { tag: tagBody(context.state, name) } };
  });

  emulator.route('POST', /^\/tags\/([^/]+)\/resources$/, (context) => {
    const tag = context.state.tags.get(decodeURIComponent(context.match[1]!).toLowerCase());
    if (!tag) return emulator.error('not-found');
    const droplets = namedDroplets(context);
    if (!droplets) return emulator.error('422-unknown');
    if (droplets.length === 0) return emulator.error('not-found');
    // The canonical spelling is the one the tag was made with.
    for (const droplet of droplets)
      if (!hasTag(droplet, tag.name)) (droplet.tags as string[]).push(tag.name);
    return { status: 204 };
  });

  emulator.route('DELETE', /^\/tags\/([^/]+)\/resources$/, (context) => {
    const tag = context.state.tags.get(decodeURIComponent(context.match[1]!).toLowerCase());
    if (!tag) return emulator.error('not-found');
    const droplets = namedDroplets(context);
    if (!droplets) return emulator.error('422-unknown');
    if (droplets.length === 0) return emulator.error('not-found');
    for (const droplet of droplets)
      droplet.tags = (droplet.tags as string[]).filter(
        (t) => t.toLowerCase() !== tag.name.toLowerCase(),
      );
    return { status: 204 };
  });
}
