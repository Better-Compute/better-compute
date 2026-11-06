import { randomBytes } from 'node:crypto';
import type { SpacesEmulator } from '../spaces-emulator.js';
import type { DoEmulator, Json } from './index.js';

// Spaces Keys (`/v2/spaces/keys`) for the DigitalOcean emulator. Registered by the storage tests
// (`registerSpacesKeys(emu, spaces?)`), not by the core emulator. With a SpacesEmulator, a created
// key pair is accepted there too, and a deleted one stops working.

const keysOf = new WeakMap<DoEmulator, Map<string, Json>>();

/** The emulator's Spaces keys, by access key (the secret is not kept). */
export function spacesKeys(emu: DoEmulator): Map<string, Json> {
  let keys = keysOf.get(emu);
  if (!keys) {
    keys = new Map();
    keysOf.set(emu, keys);
  }
  return keys;
}

const grantsValid = (grants: unknown): grants is Json[] =>
  Array.isArray(grants) &&
  grants.every(
    (g) =>
      g &&
      typeof g.bucket === 'string' &&
      ['read', 'readwrite', 'fullaccess'].includes(g.permission) &&
      (g.permission === 'fullaccess') === (g.bucket === ''),
  );

export function seedSpacesKey(emu: DoEmulator, key: Json): Json {
  const entry = {
    name: 'key',
    grants: [],
    access_key: `DO${randomBytes(8).toString('hex').toUpperCase()}`,
    created_at: new Date(emu.state.now()).toISOString(),
    ...key,
  };
  spacesKeys(emu).set(entry.access_key, entry);
  return entry;
}

export function registerSpacesKeys(emu: DoEmulator, spaces?: SpacesEmulator): void {
  const keys = spacesKeys(emu);
  emu.route('GET', /^\/spaces\/keys$/, (c) => emu.paged(c, 'keys', [...keys.values()]));
  emu.route('GET', /^\/spaces\/keys\/([^/]+)$/, (c) => {
    const key = keys.get(c.match[1]!);
    return key ? { status: 200, body: { key } } : emu.error('not-found');
  });
  emu.route('POST', /^\/spaces\/keys$/, (c) => {
    const body = c.body ?? {};
    if (typeof body.name !== 'string' || !body.name || !grantsValid(body.grants))
      return {
        status: 422,
        body: { id: 'unprocessable_entity', message: 'invalid name or grants' },
      };
    const secret = randomBytes(24).toString('base64');
    const key = seedSpacesKey(emu, { name: body.name, grants: body.grants });
    spaces?.keys.set(key.access_key, secret);
    return { status: 201, body: { key: { ...key, secret_key: secret } } };
  });
  emu.route('PUT', /^\/spaces\/keys\/([^/]+)$/, (c) => {
    const key = keys.get(c.match[1]!);
    if (!key) return emu.error('not-found');
    const body = c.body ?? {};
    if (typeof body.name !== 'string' || !grantsValid(body.grants))
      return {
        status: 422,
        body: { id: 'unprocessable_entity', message: 'invalid name or grants' },
      };
    key.name = body.name;
    key.grants = body.grants;
    return { status: 200, body: { key } };
  });
  emu.route('DELETE', /^\/spaces\/keys\/([^/]+)$/, (c) => {
    if (!keys.delete(c.match[1]!)) return emu.error('not-found');
    spaces?.keys.delete(c.match[1]!);
    return { status: 204 };
  });
}
