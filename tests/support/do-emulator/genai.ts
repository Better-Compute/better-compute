import { randomBytes, randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// The AI platform's account-level objects under /v2/gen-ai: model access keys (what serverless inference and
// dedicated endpoints take as a bearer). Shapes follow the API reference (genai), not a recording: the live suite
// captures real bodies before release. A key's secret is answered by its create and by a regenerate only, as at
// DigitalOcean; listings and updates never carry it.

function keyBody(key: Json, withSecret = false): Json {
  const { _secret, ...rest } = key;
  return withSecret ? { ...structuredClone(rest), secret_key: _secret } : structuredClone(rest);
}

/** Seeds a model access key made outside better-compute. */
export function seedModelKey(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const key: Json = {
    uuid,
    name: `by-hand-${uuid.slice(0, 6)}`,
    created_at: new Date(state.now()).toISOString(),
    created_by: '12345',
    ...fields,
    _secret: `sk-do-${randomBytes(16).toString('hex')}`,
  };
  state.modelKeys.set(uuid, key);
  return key;
}

const keyOf = (context: RouteContext) =>
  context.state.modelKeys.get(decodeURIComponent(context.match[1]!));

export function registerGenai(emulator: DoEmulator): void {
  const keys = /^\/gen-ai\/models\/api_keys$/;
  const key = /^\/gen-ai\/models\/api_keys\/([^/]+)$/;
  const regenerate = /^\/gen-ai\/models\/api_keys\/([^/]+)\/regenerate$/;

  emulator.route('GET', keys, (context) =>
    emulator.paged(
      context,
      'api_key_infos',
      [...context.state.modelKeys.values()].map((entry) => keyBody(entry)),
    ),
  );

  emulator.route('POST', keys, (context) => {
    const name = context.body?.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > 255)
      return emulator.error('422-unknown');
    const created = seedModelKey(context.state, { name });
    return { status: 200, body: { api_key_info: keyBody(created, true) } };
  });

  emulator.route('PUT', regenerate, (context) => {
    const entry = keyOf(context);
    if (!entry) return emulator.error('not-found');
    entry._secret = `sk-do-${randomBytes(16).toString('hex')}`;
    return { status: 200, body: { api_key_info: keyBody(entry, true) } };
  });

  emulator.route('PUT', key, (context) => {
    const entry = keyOf(context);
    if (!entry) return emulator.error('not-found');
    const name = context.body?.name;
    if (typeof name !== 'string' || name.length === 0) return emulator.error('422-unknown');
    entry.name = name;
    return { status: 200, body: { api_key_info: keyBody(entry) } };
  });

  emulator.route('DELETE', key, (context) => {
    const entry = keyOf(context);
    if (!entry) return emulator.error('not-found');
    context.state.modelKeys.delete(entry.uuid);
    return { status: 200, body: { api_key_info: keyBody(entry) } };
  });
}
