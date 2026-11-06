import { createHash, randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// App Platform: apps with their spec and deployments. Shapes follow the API reference (apps.yml), not a recording:
// the live suite captures real bodies before release. A SECRET env's value is kept in plain text inside the
// emulator (`_secrets`, so a test can check what DO received) and answered as `EV[1:…]` ciphertext, as DO does; a
// spec sent back with that ciphertext keeps the value. Every create or spec update starts a deployment that is
// `PENDING_BUILD` for `emulator.appReads` reads (of the app or its deployments), then `ACTIVE` — or `ERROR` when
// `emulator.failDeployments` is set — superseding the previous active one.

const appName = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const componentTypes = ['services', 'static_sites', 'workers', 'jobs', 'functions'];

const cipher = (value: string) =>
  `EV[1:${createHash('sha256').update(value).digest('base64').slice(0, 24)}]`;

/** Walks every envs list of a spec (app level and per component). */
function eachEnvs(spec: Json, fn: (envs: Json[], where: string) => void): void {
  if (Array.isArray(spec.envs)) fn(spec.envs, '');
  for (const type of componentTypes)
    for (const component of (spec[type] as Json[] | undefined) ?? [])
      if (Array.isArray(component.envs)) fn(component.envs, `${type}/${component.name}/`);
}

/** Takes the SECRET values out of a spec into `secrets` (ciphertext sent back keeps the old value). */
function absorbSecrets(spec: Json, previous: Record<string, string>): Record<string, string> {
  const secrets: Record<string, string> = {};
  eachEnvs(spec, (envs, where) => {
    for (const env of envs)
      if (env.type === 'SECRET' && typeof env.value === 'string') {
        const slot = `${where}${env.key}`;
        secrets[slot] = env.value.startsWith('EV[') ? (previous[slot] ?? '') : env.value;
        env.value = '';
      }
  });
  return secrets;
}

function body(app: Json): Json {
  const { _secrets, _deployments, _reads, ...rest } = app;
  const out = structuredClone(rest);
  eachEnvs(out.spec, (envs, where) => {
    for (const env of envs)
      if (env.type === 'SECRET') env.value = cipher(_secrets[`${where}${env.key}`] ?? '');
  });
  return out;
}

/** Counts a read; the deployment in progress completes after `appReads` reads. */
function observe(emulator: DoEmulator, app: Json): void {
  const latest = (app._deployments as Json[])[0];
  if (!latest || latest.phase !== 'PENDING_BUILD') return;
  app._reads = (app._reads ?? 0) + 1;
  if (app._reads <= emulator.appReads) return;
  app._reads = 0;
  if (emulator.failDeployments) {
    latest.phase = 'ERROR';
    return;
  }
  for (const deployment of app._deployments as Json[])
    if (deployment.phase === 'ACTIVE') deployment.phase = 'SUPERSEDED';
  latest.phase = 'ACTIVE';
  app.active_deployment = { id: latest.id, phase: 'ACTIVE' };
  const host = `${app.spec.name}-${app.id.slice(0, 5)}.ondigitalocean.app`;
  app.live_url = `https://${host}`;
  app.default_ingress = `https://${host}`;
  app.live_domain = host;
}

function deploy(state: DoState, app: Json, cause: string): void {
  (app._deployments as Json[]).unshift({
    id: randomUUID(),
    phase: 'PENDING_BUILD',
    cause,
    created_at: new Date(state.now()).toISOString(),
  });
  app._reads = 0;
}

/** Seeds an app made outside better-compute (deployed), with the given spec fields. */
export function seedApp(state: DoState, spec: Json = {}): Json {
  const id = randomUUID();
  const fullSpec: Json = {
    name: `seeded-${id.slice(0, 8)}`,
    region: 'nyc',
    services: [{ name: 'web', image: { registry_type: 'DOCKER_HUB', repository: 'nginx' } }],
    ...structuredClone(spec),
  };
  const deployment = {
    id: randomUUID(),
    phase: 'ACTIVE',
    cause: 'seeded',
    created_at: new Date(state.now()).toISOString(),
  };
  const host = `${fullSpec.name}.ondigitalocean.app`;
  const app: Json = {
    id,
    owner_uuid: 'owner-1',
    spec: fullSpec,
    region: { slug: fullSpec.region ?? 'nyc' },
    active_deployment: { id: deployment.id, phase: 'ACTIVE' },
    live_url: `https://${host}`,
    default_ingress: `https://${host}`,
    live_domain: host,
    created_at: new Date(state.now()).toISOString(),
    updated_at: new Date(state.now()).toISOString(),
    _deployments: [deployment],
  };
  app._secrets = absorbSecrets(app.spec, {});
  state.apps.set(id, app);
  return app;
}

const appOf = (context: RouteContext) =>
  context.state.apps.get(decodeURIComponent(context.match[1]!));

export function registerApps(emulator: DoEmulator): void {
  emulator.route('GET', /^\/apps$/, (context) => {
    const apps = [...context.state.apps.values()];
    for (const app of apps) observe(emulator, app);
    return emulator.paged(context, 'apps', apps.map(body));
  });

  emulator.route('POST', /^\/apps$/, (context) => {
    const spec = structuredClone(context.body?.spec);
    if (!spec || typeof spec.name !== 'string' || !appName.test(spec.name))
      return emulator.error('422-unknown');
    if ([...context.state.apps.values()].some((app) => app.spec.name === spec.name))
      return emulator.error('422-name-in-use');
    const id = randomUUID();
    const app: Json = {
      id,
      owner_uuid: 'owner-1',
      spec,
      region: { slug: spec.region ?? 'nyc' },
      created_at: new Date(context.state.now()).toISOString(),
      updated_at: new Date(context.state.now()).toISOString(),
      _deployments: [],
    };
    app._secrets = absorbSecrets(app.spec, {});
    deploy(context.state, app, 'app created');
    context.state.apps.set(id, app);
    return { status: 200, body: { app: body(app) } };
  });

  emulator.route('GET', /^\/apps\/([^/]+)$/, (context) => {
    const app = appOf(context);
    if (!app) return emulator.error('not-found');
    observe(emulator, app);
    return { status: 200, body: { app: body(app) } };
  });

  emulator.route('PUT', /^\/apps\/([^/]+)$/, (context) => {
    const app = appOf(context);
    if (!app) return emulator.error('not-found');
    const spec = structuredClone(context.body?.spec);
    if (!spec || spec.name !== app.spec.name) return emulator.error('422-unknown');
    app._secrets = absorbSecrets(spec, app._secrets);
    app.spec = spec;
    app.updated_at = new Date(context.state.now()).toISOString();
    deploy(context.state, app, 'app spec updated');
    return { status: 200, body: { app: body(app) } };
  });

  emulator.route('DELETE', /^\/apps\/([^/]+)$/, (context) => {
    const app = appOf(context);
    if (!app) return emulator.error('not-found');
    context.state.apps.delete(app.id);
    return { status: 200, body: { id: app.id } };
  });

  emulator.route('GET', /^\/apps\/([^/]+)\/deployments$/, (context) => {
    const app = appOf(context);
    if (!app) return emulator.error('not-found');
    observe(emulator, app);
    return emulator.paged(context, 'deployments', structuredClone(app._deployments));
  });
}
