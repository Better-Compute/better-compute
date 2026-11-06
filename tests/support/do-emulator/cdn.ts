import { randomUUID } from 'node:crypto';
import type { DoEmulator, Json } from './index.js';

// CDN Endpoints (`/v2/cdn/endpoints`) for the DigitalOcean emulator, registered by the storage
// tests (`registerCdn(emu)`). One endpoint per origin, as DigitalOcean enforces; purges are
// recorded.

const endpointsOf = new WeakMap<DoEmulator, Map<string, Json>>();
const purgesOf = new WeakMap<DoEmulator, { id: string; files: string[] }[]>();

export function cdnEndpoints(emu: DoEmulator): Map<string, Json> {
  let map = endpointsOf.get(emu);
  if (!map) endpointsOf.set(emu, (map = new Map()));
  return map;
}

export function cdnPurges(emu: DoEmulator): { id: string; files: string[] }[] {
  let list = purgesOf.get(emu);
  if (!list) purgesOf.set(emu, (list = []));
  return list;
}

const ttls = [60, 600, 3600, 86400, 604800];
const invalid = (message: string) => ({
  status: 422,
  body: { id: 'unprocessable_entity', message },
});

export function seedCdnEndpoint(emu: DoEmulator, endpoint: Json): Json {
  const origin = String(endpoint.origin);
  const entry = {
    id: randomUUID(),
    endpoint: origin.replace('.digitaloceanspaces.com', '.cdn.digitaloceanspaces.com'),
    ttl: 3600,
    created_at: new Date(emu.state.now()).toISOString(),
    ...endpoint,
  };
  cdnEndpoints(emu).set(entry.id, entry);
  return entry;
}

const registered = new WeakSet<DoEmulator>();

/** Adds the CDN routes to `emu`; a second call is a no-op. */
export function registerCdn(emu: DoEmulator): void {
  if (registered.has(emu)) return;
  registered.add(emu);
  const endpoints = cdnEndpoints(emu);
  emu.route('GET', /^\/cdn\/endpoints$/, (c) => emu.paged(c, 'endpoints', [...endpoints.values()]));
  emu.route('GET', /^\/cdn\/endpoints\/([^/]+)$/, (c) => {
    const endpoint = endpoints.get(c.match[1]!);
    return endpoint ? { status: 200, body: { endpoint } } : emu.error('not-found');
  });
  emu.route('POST', /^\/cdn\/endpoints$/, (c) => {
    const body = c.body ?? {};
    if (typeof body.origin !== 'string' || !body.origin.endsWith('.digitaloceanspaces.com'))
      return invalid('origin must be a Spaces bucket');
    if (body.ttl !== undefined && !ttls.includes(body.ttl)) return invalid('invalid ttl');
    if (body.custom_domain && !body.certificate_id)
      return invalid('a custom domain needs a certificate');
    if ([...endpoints.values()].some((e) => e.origin === body.origin))
      return { status: 409, body: { id: 'conflict', message: 'origin is already in use' } };
    const endpoint = seedCdnEndpoint(emu, {
      origin: body.origin,
      ttl: body.ttl ?? 3600,
      ...(body.custom_domain
        ? { custom_domain: body.custom_domain, certificate_id: body.certificate_id }
        : {}),
    });
    return { status: 201, body: { endpoint } };
  });
  emu.route('PUT', /^\/cdn\/endpoints\/([^/]+)$/, (c) => {
    const endpoint = endpoints.get(c.match[1]!);
    if (!endpoint) return emu.error('not-found');
    const body = c.body ?? {};
    if (body.ttl !== undefined && !ttls.includes(body.ttl)) return invalid('invalid ttl');
    if (body.ttl !== undefined) endpoint.ttl = body.ttl;
    if (body.custom_domain === '') {
      delete endpoint.custom_domain;
      delete endpoint.certificate_id;
    } else if (body.custom_domain !== undefined) {
      if (!body.certificate_id) return invalid('a custom domain needs a certificate');
      endpoint.custom_domain = body.custom_domain;
      endpoint.certificate_id = body.certificate_id;
    }
    return { status: 200, body: { endpoint } };
  });
  emu.route('DELETE', /^\/cdn\/endpoints\/([^/]+)\/cache$/, (c) => {
    if (!endpoints.has(c.match[1]!)) return emu.error('not-found');
    cdnPurges(emu).push({ id: c.match[1]!, files: (c.body?.files ?? []) as string[] });
    return { status: 204 };
  });
  emu.route('DELETE', /^\/cdn\/endpoints\/([^/]+)$/, (c) => {
    if (!endpoints.delete(c.match[1]!)) return emu.error('not-found');
    return { status: 204 };
  });
}
