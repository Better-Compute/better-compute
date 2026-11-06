import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type CallContext, type ComputeError } from '@better-compute/core';
import {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/cloud-resources';
import { deploymentTag, digitaloceanProvider } from '@better-compute/provider-digitalocean';
import { seedAddon } from './support/do-emulator/addons.js';
import { seedApp } from './support/do-emulator/apps.js';
import { seedAttachment } from './support/do-emulator/partner.js';
import { seedNamespace } from './support/do-emulator/functions.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// provider-digitalocean's platform kinds (P7) against the emulator: App Platform apps (the App spec as the manifest,
// ownership as BETTER_COMPUTE_* envs, secrets as SecretRefs, deployments as read-only status, account-wide
// references refused on a shared account) and Functions namespaces and their scheduled triggers.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const labels = {
  'better-compute-managed': 'true',
  'better-compute-resource': 'crs_app',
  'better-compute-tenant': 'acme',
};
const deploymentHash = deploymentTag('default').split(':')[1]!;
const mutations = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));

const dbPassword = 'hunter2-plaintext-0042';
/** A call context whose resolver also knows the tenant's app secret. */
function call(key = 'crs_app'): CallContext {
  const base = ctx(key);
  return {
    ...base,
    secrets: {
      resolve: async (ref: string) =>
        ref === 'secret://acme/db-password' ? dbPassword : secrets.resolve(ref),
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const web = (instances = 1) => ({
  region: 'nyc',
  services: [
    {
      name: 'web',
      image: { registry_type: 'DOCKER_HUB', repository: 'nginx', tag: '1.27' },
      instance_count: instances,
      http_port: 8080,
    },
  ],
});

async function settle(
  resources: Awaited<ReturnType<typeof build>>['resources'],
  request: any,
  key = 'crs_app',
) {
  let state = await resources.ensure(request, call(key));
  for (let round = 0; round < 10 && state.state !== 'ready' && state.state !== 'error'; round++)
    state = await resources.ensure({ ...request, id: state.id }, call(key));
  return state;
}

const appEnvs = (body: any): Record<string, any> =>
  Object.fromEntries((body.spec.envs ?? []).map((env: any) => [env.key, env]));

beforeEach(freshBudgets);

describe('ProviderResources conformance: do.app', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedApp(emu.state, { name: 'by-hand' });
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.app',
      spec: web(1),
      updatedSpec: web(2),
      replaceSpec: { ...web(1), region: 'ams' },
      unmanaged: unmanaged.id,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('ProviderResources conformance: do.functions-namespace', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedNamespace(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.functions-namespace',
      spec: { region: 'nyc1' },
      replaceSpec: { region: 'ams3' },
      unmanaged: unmanaged.namespace,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.app: the App spec as the manifest', () => {
  it('is a platform kind, not regional, every field but region updatable, no secret outputs', async () => {
    const { resources } = await build(emulator());
    const app = resources.kinds().find((kind) => kind.kind === 'do.app')!;
    expect(app).toMatchObject({ family: 'platform', regional: false });
    expect(app.secretOutputs ?? []).toEqual([]);
    expect(app.updatable).toContain('services');
    expect(app.updatable).toContain('envs');
    expect(app.updatable).not.toContain('region');
    const schema = (app.spec as any).jsonSchema();
    expect(schema.type).toBe('object');
    expect(schema.properties.services.type).toBe('array');
  });

  it('refuses a plaintext secret, a reserved env, a name, an unknown field and an app without components', async () => {
    const { resources } = await build(emulator());
    const spec = resources.kinds().find((kind) => kind.kind === 'do.app')!.spec;
    const issues = async (value: unknown) =>
      ((await spec['~standard'].validate(value)).issues ?? [])
        .map((issue) => issue.message)
        .join('\n');
    expect(await issues(web())).toBe('');
    expect(
      await issues({ ...web(), envs: [{ key: 'DB_PASSWORD', type: 'SECRET', value: 'plain' }] }),
    ).toContain('SecretRef');
    expect(
      await issues({
        ...web(),
        envs: [{ key: 'DB_PASSWORD', type: 'SECRET', value: 'secret://acme/db-password' }],
      }),
    ).toBe('');
    expect(
      await issues({ ...web(), envs: [{ key: 'better_compute_managed', value: 'true' }] }),
    ).toContain('reserved');
    expect(
      await issues({
        region: 'nyc',
        services: [
          {
            name: 'web',
            image: {
              registry_type: 'GHCR',
              repository: 'acme/web',
              registry_credentials: 'user:tok',
            },
          },
        ],
      }),
    ).toContain('registry_credentials takes a SecretRef');
    expect(
      await issues({
        ...web(),
        services: [
          {
            name: 'web',
            git: { repo_clone_url: 'https://github.com/acme/web.git' },
            log_destinations: [{ name: 'dd', datadog: { api_key: 'abc123' } }],
          },
        ],
      }),
    ).toContain('api_key takes a SecretRef');
    expect(await issues({ ...web(), name: 'mine' })).toContain('provider name');
    expect(await issues({ ...web(), bogus: true })).toContain('bogus is not an App spec field');
    expect(await issues({ region: 'nyc' })).toContain('at least one');
    expect(
      await issues({
        services: [{ name: 'web', git: { repo_clone_url: 'http://u:p@host/repo.git' } }],
      }),
    ).toContain('https URL');
    expect(await issues({ ...web(), region: 'nyc3' })).toContain('region');
  });
});

describe('do.app: lifecycle', () => {
  const request = (spec: Record<string, unknown> = web(), extra: Record<string, unknown> = {}) => ({
    kind: 'do.app',
    name: 'bc-r-app1',
    spec,
    labels,
    ...extra,
  });

  it('creates with ownership envs and the SecretRef resolved; secrets and ciphertext never come back', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const spec = {
      ...web(),
      envs: [
        { key: 'DB_PASSWORD', type: 'SECRET', value: 'secret://acme/db-password' },
        { key: 'MODE', value: 'prod' },
      ],
    };
    const first = await resources.ensure(request(spec), call());
    expect(first.state).toBe('pending');
    const [create] = mutations(emu, 'POST', /^\/v2\/apps$/);
    const sent = create!.body as any;
    expect(sent.spec.name).toBe('bc-r-app1');
    const envs = appEnvs(sent);
    expect(envs.DB_PASSWORD.value).toBe(dbPassword);
    expect(envs.BETTER_COMPUTE_MANAGED.value).toBe('true');
    expect(envs.BETTER_COMPUTE_DEPLOYMENT.value).toBe(deploymentHash);
    expect(envs.BETTER_COMPUTE_RESOURCE.value).toBe('crs_app');
    expect(envs.BETTER_COMPUTE_TENANT.value).toBe('acme');
    expect(envs.BETTER_COMPUTE_KEY.value).toMatch(/^[0-9a-f]{24}$/);
    expect(envs.BETTER_COMPUTE_SPEC.value).toMatch(/^[0-9a-f]{32}$/);
    expect(envs.BETTER_COMPUTE_SPEC.scope).toBe('BUILD_TIME');
    const app = emu.state.apps.get(first.id)!;
    expect(app._secrets.DB_PASSWORD).toBe(dbPassword);

    const ready = await settle(resources, request(spec));
    expect(ready.state).toBe('ready');
    expect(ready.outputs).toMatchObject({
      liveUrl: expect.stringMatching(/^https:\/\/bc-r-app1-/),
      region: 'nyc',
      deploymentPhase: 'ACTIVE',
      urn: `do:app:${first.id}`,
      activeDeployment: expect.any(String),
    });
    // The observed spec is the tenant's shape: no name, no ownership envs, the secret's value gone.
    expect(ready.spec).toEqual({
      ...web(),
      envs: [
        { key: 'DB_PASSWORD', type: 'SECRET' },
        { key: 'MODE', value: 'prod' },
      ],
    });
    expect(JSON.stringify(ready)).not.toContain(dbPassword);
    expect(JSON.stringify(ready)).not.toContain('EV[');
    expect(ready.secretOutputs).toBeUndefined();
  });

  it('a DigitalOcean error echoing a resolved secret is scrubbed before it goes anywhere', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const spec = {
      ...web(),
      envs: [{ key: 'DB_PASSWORD', type: 'SECRET', value: 'secret://acme/db-password' }],
    };
    emu.failNext({ method: 'POST', path: /^\/apps$/ }, 422, {
      id: 'unprocessable_entity',
      message: `env DB_PASSWORD: invalid value "${dbPassword}"`,
    });
    const error = await failure(resources.ensure(request(spec), call()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('DB_PASSWORD');
    expect(JSON.stringify([error.message, error.details])).not.toContain(dbPassword);
  });

  it('a converged app is never redeployed; a spec change is one PUT; region is replaceRequired', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const ready = await settle(resources, request());
    for (let i = 0; i < 3; i++)
      expect((await resources.ensure(request(web(), { id: ready.id }), call())).state).toBe(
        'ready',
      );
    expect(mutations(emu, 'PUT', /^\/v2\/apps\//)).toEqual([]);
    const updating = await resources.ensure(request(web(3), { id: ready.id }), call());
    expect(updating.state).toBe('updating');
    const [put] = mutations(emu, 'PUT', /^\/v2\/apps\//);
    expect((put!.body as any).spec.services[0].instance_count).toBe(3);
    expect(appEnvs(put!.body).BETTER_COMPUTE_SPEC.value).not.toBe(
      appEnvs(mutations(emu, 'POST', /^\/v2\/apps$/)[0]!.body).BETTER_COMPUTE_SPEC.value,
    );
    expect((await settle(resources, request(web(3), { id: ready.id }))).state).toBe('ready');
    expect(mutations(emu, 'PUT', /^\/v2\/apps\//)).toHaveLength(1);
    const error = await failure(
      resources.ensure(request({ ...web(3), region: 'ams' }, { id: ready.id }), call()),
    );
    expect(error.details?.reason).toBe('replaceRequired');
  });

  it('a retried ensure without the id finds the app by its key env; a racing create converges on it', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const first = await resources.ensure(request(), call('crs_race'));
    const again = await resources.ensure(request(), call('crs_race'));
    expect(again.id).toBe(first.id);
    expect(mutations(emu, 'POST', /^\/v2\/apps$/)).toHaveLength(1);
    // The lookup missed a racing create of ours: DO refuses the name, and the key env finds it.
    const emu2 = emulator();
    const other = await build(emu2);
    emu2.beforeAction('POST /apps', (context) => {
      seedApp(context.state, {
        name: 'bc-r-app1',
        envs: [
          { key: 'BETTER_COMPUTE_MANAGED', value: 'true' },
          { key: 'BETTER_COMPUTE_DEPLOYMENT', value: deploymentHash },
          {
            key: 'BETTER_COMPUTE_KEY',
            value: appEnvs(mutations(emu, 'POST', /^\/v2\/apps$/)[0]!.body).BETTER_COMPUTE_KEY
              .value,
          },
        ],
      });
    });
    const raced = await other.resources.ensure(request(), call('crs_race'));
    expect(emu2.state.apps.size).toBe(1);
    expect(raced.id).toBe([...emu2.state.apps.keys()][0]);
  });

  it('a failed deployment is error, saying when the previous one still serves', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    emu.failDeployments = true;
    const failed = await settle(resources, request());
    expect(failed.state).toBe('error');
    expect(failed.message).toMatch(/ended ERROR$/);
    emu.failDeployments = false;
    const emu2 = emulator();
    const other = await build(emu2);
    const ready = await settle(other.resources, request());
    emu2.failDeployments = true;
    const broken = await settle(other.resources, request(web(2), { id: ready.id }));
    expect(broken.state).toBe('error');
    expect(broken.message).toContain('the previous deployment still serves');
  });

  it('on a shared account a spec reaching account-wide objects is refused before any write', async () => {
    const shared: Record<string, unknown>[] = [
      { services: [{ name: 'web', github: { repo: 'platform/private', branch: 'main' } }] },
      { services: [{ name: 'web', image: { registry_type: 'DOCR', repository: 'platform-api' } }] },
      {
        ...web(),
        databases: [
          { name: 'db', engine: 'PG', production: true, cluster_name: 'other-tenant-db' },
        ],
      },
      { ...web(), domains: [{ domain: 'www.example.com', zone: 'example.com' }] },
      { ...web(), vpc: { id: 'c22d8f48-4bc4-49f5-8ca0-58e7164427ac' } },
    ];
    for (const spec of shared) {
      const emu = emulator();
      const { resources } = await build(emu);
      for (const accountScope of [undefined, 'shared'] as const) {
        const error = await failure(
          resources.ensure(request(spec, accountScope ? { accountScope } : {}), call()),
        );
        expect(error.code).toBe('INVALID_INPUT');
        expect(error.details?.reason).toBe('accountWide');
      }
      expect(mutations(emu, 'POST', /^\/v2\/apps$/)).toEqual([]);
      // The tenant's own account may.
      await resources.ensure(request(spec, { accountScope: 'tenant' }), call());
      expect(mutations(emu, 'POST', /^\/v2\/apps$/)).toHaveLength(1);
    }
  });

  it('delete refuses an app made by hand or by another deployment, and sends no DELETE', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedApp(emu.state);
    const foreign = seedApp(emu.state, {
      envs: [
        { key: 'BETTER_COMPUTE_MANAGED', value: 'true' },
        { key: 'BETTER_COMPUTE_DEPLOYMENT', value: deploymentTag('another').split(':')[1] },
      ],
    });
    for (const app of [byHand, foreign]) {
      const error = await failure(resources.delete('do.app', app.id, call()));
      expect(error.details?.reason).toBe('notManaged');
    }
    expect(mutations(emu, 'DELETE', /^\/v2\/apps\//)).toEqual([]);
    const mine = await settle(resources, request());
    expect((await resources.delete('do.app', mine.id, call())).state).toBe('deleting');
    expect((await resources.delete('do.app', mine.id, call())).state).toBe('deleted');
    expect(emu.state.apps.has(mine.id)).toBe(false);
  });

  it('discover says who manages each; adopt writes the envs once, keeping secrets; release takes them off', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedApp(emu.state, {
      name: 'legacy',
      envs: [{ key: 'API_TOKEN', type: 'SECRET', value: 'legacy-secret-value' }],
    });
    seedApp(emu.state, {
      name: 'theirs',
      envs: [
        { key: 'BETTER_COMPUTE_MANAGED', value: 'true' },
        { key: 'BETTER_COMPUTE_DEPLOYMENT', value: deploymentTag('another').split(':')[1] },
      ],
    });
    const found = [];
    for await (const item of resources.discover('do.app', call())) found.push(item);
    expect(found.map((item) => item.name).sort()).toEqual(['legacy', 'theirs']);
    expect(found.find((item) => item.name === 'theirs')!.managedBy).toBe('other');
    const legacy = found.find((item) => item.name === 'legacy')!;
    expect(legacy.managedBy).toBeUndefined();
    expect(JSON.stringify(found)).not.toContain('EV[');
    expect(legacy.spec).toMatchObject({ envs: [{ key: 'API_TOKEN', type: 'SECRET' }] });

    const theirs = found.find((item) => item.name === 'theirs')!;
    expect(
      (await failure(resources.adopt('do.app', theirs.id, labels, call()))).details?.reason,
    ).toBe('managedByAnother');
    const adopted = await resources.adopt('do.app', byHand.id, labels, call('crs_adopt'));
    expect(adopted.spec).toEqual(legacy.spec);
    expect(byHand._secrets.API_TOKEN).toBe('legacy-secret-value');
    expect(appEnvs(byHand).BETTER_COMPUTE_RESOURCE.value).toBe('crs_app');
    // A retried adopt writes nothing again.
    await resources.adopt('do.app', byHand.id, labels, call('crs_adopt'));
    expect(mutations(emu, 'PUT', /^\/v2\/apps\//)).toHaveLength(1);
    // The fingerprint is the observed spec's: an unchanged spec is not redeployed.
    await resources.ensure(
      { kind: 'do.app', name: 'legacy', id: byHand.id, spec: adopted.spec, labels },
      call('crs_adopt'),
    );
    expect(mutations(emu, 'PUT', /^\/v2\/apps\//)).toHaveLength(1);

    await resources.release('do.app', byHand.id, call());
    expect(Object.keys(appEnvs(byHand))).toEqual(['API_TOKEN']);
    expect(byHand._secrets.API_TOKEN).toBe('legacy-secret-value');
    expect((await failure(resources.delete('do.app', byHand.id, call()))).details?.reason).toBe(
      'notManaged',
    );
  });
});

describe('do.functions-namespace and do.functions-trigger', () => {
  const namespaceRequest = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.functions-namespace',
    name: 'bc-r-fns1',
    spec: { region: 'nyc1' },
    labels,
    ...extra,
  });

  it('a namespace is labelled with this deployment; its key is only ever a secret output', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const kind = resources.kinds().find((entry) => entry.kind === 'do.functions-namespace')!;
    expect(kind).toMatchObject({ family: 'platform', regional: true, secretOutputs: ['key'] });
    const state = await resources.ensure(namespaceRequest(), call('crs_fn'));
    expect(state.state).toBe('ready');
    const [create] = mutations(emu, 'POST', /^\/v2\/functions\/namespaces$/);
    expect(create!.body).toEqual({ region: 'nyc1', label: `bc-r-fns1-bc${deploymentHash}` });
    const namespace = emu.state.functionsNamespaces.get(state.id)!;
    expect(state.secretOutputs).toEqual({ key: namespace.key });
    expect(JSON.stringify(state.outputs)).not.toContain(namespace.key);
    expect(state.outputs).toMatchObject({
      namespace: state.id,
      apiHost: namespace.api_host,
      region: 'nyc1',
    });
    // A retry without the id finds it by its label.
    expect((await resources.ensure(namespaceRequest(), call('crs_fn'))).id).toBe(state.id);
    expect(mutations(emu, 'POST', /^\/v2\/functions\/namespaces$/)).toHaveLength(1);
    const moved = await failure(
      resources.ensure(
        namespaceRequest({ id: state.id, spec: { region: 'ams3' } }),
        call('crs_fn'),
      ),
    );
    expect(moved.details?.reason).toBe('replaceRequired');
  });

  it('delete and discover: a namespace made by hand or by another deployment is left alone', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedNamespace(emu.state);
    const foreign = seedNamespace(emu.state, {
      label: `bc-r-x-bc${deploymentTag('another').split(':')[1]}`,
    });
    for (const namespace of [byHand, foreign])
      expect(
        (await failure(resources.delete('do.functions-namespace', namespace.namespace, call())))
          .details?.reason,
      ).toBe('notManaged');
    expect(mutations(emu, 'DELETE', /^\/v2\/functions\//)).toEqual([]);
    const mine = await resources.ensure(namespaceRequest(), call('crs_fn'));
    const found = [];
    for await (const item of resources.discover('do.functions-namespace', call())) found.push(item);
    expect(Object.fromEntries(found.map((item) => [item.id, item.managedBy ?? 'none']))).toEqual({
      [byHand.namespace]: 'none',
      [foreign.namespace]: 'other',
      [mine.id]: 'this',
    });
    expect(JSON.stringify(found)).not.toContain(byHand.key);
    expect(
      (await failure(resources.adopt('do.functions-namespace', byHand.namespace, labels, call())))
        .code,
    ).toBe('UNSUPPORTED');
    expect((await resources.delete('do.functions-namespace', mine.id, call())).state).toBe(
      'deleted',
    );
    expect(emu.state.functionsNamespaces.has(mine.id)).toBe(false);
  });

  it('triggers: created once, changed in place, function and name are replaceRequired', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const namespace = await resources.ensure(namespaceRequest(), call('crs_fn'));
    const spec = {
      name: 'nightly',
      function: 'jobs/cleanup',
      cron: '0 3 * * *',
      body: { dryRun: false },
    };
    const parsed = await resources
      .kinds()
      .find((kind) => kind.kind === 'do.functions-trigger')!
      .spec['~standard'].validate(spec);
    expect(parsed.issues).toBeUndefined();
    const value = (parsed as { value: any }).value;
    expect(value.enabled).toBe(true);
    const trigger = {
      kind: 'do.functions-trigger',
      name: 'bc-r-t',
      spec: value,
      parent: namespace.id,
    };
    const created = await resources.ensure(trigger, call('crs_t'));
    expect(created).toMatchObject({
      id: `${namespace.id}/nightly`,
      state: 'ready',
      outputs: { name: 'nightly', function: 'jobs/cleanup', enabled: 'true' },
    });
    expect(mutations(emu, 'POST', /\/triggers$/)[0]!.body).toEqual({
      name: 'nightly',
      function: 'jobs/cleanup',
      type: 'SCHEDULED',
      is_enabled: true,
      scheduled_details: { cron: '0 3 * * *', body: { dryRun: false } },
    });
    await resources.ensure({ ...trigger, id: created.id }, call('crs_t'));
    expect(mutations(emu, 'POST', /\/triggers$/)).toHaveLength(1);
    expect(mutations(emu, 'PUT', /\/triggers\//)).toEqual([]);
    const changed = await resources.ensure(
      { ...trigger, id: created.id, spec: { ...value, cron: '0 4 * * *', enabled: false } },
      call('crs_t'),
    );
    expect(changed.outputs!.enabled).toBe('false');
    expect(mutations(emu, 'PUT', /\/triggers\/nightly$/)[0]!.body).toEqual({
      is_enabled: false,
      scheduled_details: { cron: '0 4 * * *', body: { dryRun: false } },
    });
    for (const other of [{ function: 'jobs/other' }, { name: 'renamed' }]) {
      const error = await failure(
        resources.ensure(
          { ...trigger, id: created.id, spec: { ...value, ...other } },
          call('crs_t'),
        ),
      );
      expect(error.details?.reason).toBe('replaceRequired');
    }
    expect((await resources.delete('do.functions-trigger', created.id, call())).state).toBe(
      'deleted',
    );
    expect(await resources.get('do.functions-trigger', created.id, call())).toBeUndefined();
  });

  it('a trigger in a namespace this deployment does not manage is refused; bad specs are refused', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const theirs = seedNamespace(emu.state);
    const error = await failure(
      resources.ensure(
        {
          kind: 'do.functions-trigger',
          name: 'x',
          spec: { name: 'n', function: 'a/b', cron: '* * * * *', enabled: true },
          parent: theirs.namespace,
        },
        call(),
      ),
    );
    expect(error.details?.reason).toBe('notManaged');
    expect(mutations(emu, 'POST', /\/triggers$/)).toEqual([]);
    expect(
      (await failure(resources.delete('do.functions-trigger', `${theirs.namespace}/n`, call())))
        .details?.reason,
    ).toBe('notManaged');
    const spec = resources.kinds().find((kind) => kind.kind === 'do.functions-trigger')!.spec;
    for (const bad of [
      { name: 'n', function: 'a/b', cron: '* * *' },
      { name: 'n', function: '../x', cron: '* * * * *' },
      { name: 'n', function: 'a/b', cron: '* * * * *', body: 'text' },
      { name: 'n', function: 'a/b', cron: '* * * * *', type: 'HTTP' },
    ])
      expect((await spec['~standard'].validate(bad)).issues).toBeDefined();
    expect(
      (await failure(resources.get('do.functions-trigger', 'not-a-namespace/n', call()))).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('ProviderResources conformance: do.addon', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedAddon(emu.state);
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.addon',
      spec: { app: 'acme-mail', plan: 'free' },
      updatedSpec: { app: 'acme-mail', plan: 'pro' },
      replaceSpec: { app: 'acme-search', plan: 'starter' },
      unmanaged: unmanaged.uuid,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.addon', () => {
  const request = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    kind: 'do.addon',
    name: 'bc-r-mail',
    spec,
    labels,
    ...extra,
  });

  it('provisions under a name carrying this deployment; the plan changes in place, app and metadata do not', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const spec = { app: 'acme-mail', plan: 'free', metadata: { domain: 'mail.example.com' } };
    const first = await resources.ensure(request(spec), call('crs_mail'));
    expect(first.state).toBe('pending');
    expect(mutations(emu, 'POST', /^\/v2\/add-ons\/saas$/)[0]!.body).toEqual({
      app_slug: 'acme-mail',
      plan_slug: 'free',
      name: `bc-r-mail-bc${deploymentHash}`,
      metadata: [{ name: 'domain', value: 'mail.example.com' }],
    });
    // A retry without the id finds it by name.
    expect((await resources.ensure(request(spec), call('crs_mail'))).id).toBe(first.id);
    const ready = await resources.ensure(request(spec, { id: first.id }), call('crs_mail'));
    expect(ready).toMatchObject({
      state: 'ready',
      outputs: { app: 'acme-mail', plan: 'free', status: 'provisioned' },
      spec,
    });
    expect(JSON.stringify(ready)).not.toContain('sso');
    const upgraded = await resources.ensure(
      request({ ...spec, plan: 'pro' }, { id: first.id }),
      call('crs_mail'),
    );
    expect(upgraded.outputs!.plan).toBe('pro');
    expect(mutations(emu, 'PATCH', /\/plan$/)[0]!.body).toEqual({ plan_slug: 'pro' });
    for (const changed of [
      { ...spec, plan: 'pro', app: 'acme-search' },
      { ...spec, plan: 'pro', metadata: { domain: 'other.example.com' } },
    ]) {
      const error = await failure(
        resources.ensure(request(changed, { id: first.id }), call('crs_mail')),
      );
      expect(error.details?.reason).toBe('replaceRequired');
    }
    expect(mutations(emu, 'POST', /^\/v2\/add-ons\/saas$/)).toHaveLength(1);
  });

  it('refuses specs that are not an app on a plan', async () => {
    const { resources } = await build(emulator());
    const spec = resources.kinds().find((kind) => kind.kind === 'do.addon')!.spec;
    for (const bad of [
      { app: 'acme-mail' },
      { app: 'Acme Mail', plan: 'free' },
      { app: 'acme-mail', plan: 'free', metadata: { x: { nested: true } } },
      { app: 'acme-mail', plan: 'free', linked_droplet_id: 42 },
    ])
      expect((await spec['~standard'].validate(bad)).issues).toBeDefined();
  });

  it('delete, discover, adopt and release respect who manages each add-on', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedAddon(emu.state, { name: 'newsletter' });
    const foreign = seedAddon(emu.state, {
      name: `x-bc${deploymentTag('another').split(':')[1]}`,
    });
    for (const addon of [byHand, foreign])
      expect(
        (await failure(resources.delete('do.addon', addon.uuid, call()))).details?.reason,
      ).toBe('notManaged');
    expect(mutations(emu, 'DELETE', /^\/v2\/add-ons\//)).toEqual([]);
    const found = [];
    for await (const item of resources.discover('do.addon', call())) found.push(item);
    expect(Object.fromEntries(found.map((item) => [item.name, item.managedBy ?? 'none']))).toEqual({
      newsletter: 'none',
      [foreign.name]: 'other',
    });
    expect(JSON.stringify(found)).not.toContain('sso-secret');
    expect(
      (await failure(resources.adopt('do.addon', foreign.uuid, labels, call()))).details?.reason,
    ).toBe('managedByAnother');
    const adopted = await resources.adopt('do.addon', byHand.uuid, labels, call());
    expect(adopted.state).toBe('ready');
    expect(byHand.name).toBe(`newsletter-bc${deploymentHash}`);
    await resources.adopt('do.addon', byHand.uuid, labels, call());
    expect(mutations(emu, 'PATCH', /^\/v2\/add-ons\/saas\/[^/]+$/)).toHaveLength(1);
    await resources.release('do.addon', byHand.uuid, call());
    expect(byHand.name).toBe('newsletter');
    // Ours again, then deleted: deprovisioning, then gone.
    await resources.adopt('do.addon', byHand.uuid, labels, call());
    expect((await resources.delete('do.addon', byHand.uuid, call())).state).toBe('deleting');
    expect((await resources.delete('do.addon', byHand.uuid, call())).state).toBe('deleting');
    expect((await resources.delete('do.addon', byHand.uuid, call())).state).toBe('deleted');
    expect(mutations(emu, 'DELETE', /^\/v2\/add-ons\//)).toHaveLength(1);
  });
});

describe('ProviderResources conformance: do.partner-attachment (the tenant’s own account)', () => {
  const vpcA = '5a4981aa-9653-4bd1-bef5-d6bff52042e4';
  const vpcB = 'f2b1a3c4-0000-4000-8000-000000000001';
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedAttachment(emu.state);
    const spec = { region: 'nyc3', bandwidthMbps: '1000', naasProvider: 'MEGAPORT', vpcs: [vpcA] };
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.partner-attachment',
      accountScope: 'tenant',
      spec,
      updatedSpec: { ...spec, vpcs: [vpcA, vpcB] },
      replaceSpec: { ...spec, bandwidthMbps: '2000' },
      unmanaged: unmanaged.id,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('do.partner-attachment', () => {
  const vpc = '5a4981aa-9653-4bd1-bef5-d6bff52042e4';
  const bgpKey = 'bgp-chosen-by-tenant-9931';
  const spec = {
    region: 'nyc3',
    bandwidthMbps: '1000',
    naasProvider: 'MEGAPORT',
    vpcs: [vpc],
    localRouterIp: '169.254.0.1/29',
    peerRouterIp: '169.254.0.6/29',
    peerRouterAsn: 64532,
    bgpAuthKey: 'secret://acme/bgp',
  };
  const keyed = (key = 'crs_pnc'): CallContext => {
    const base = call(key);
    return {
      ...base,
      secrets: {
        resolve: async (ref: string) =>
          ref === 'secret://acme/bgp' ? bgpKey : base.secrets.resolve(ref as any),
      },
    };
  };
  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'do.partner-attachment',
    name: 'bc-r-pnc',
    spec,
    labels,
    accountScope: 'tenant' as const,
    ...extra,
  });

  it('exists only on the tenant’s own account; nothing is sent otherwise', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    for (const scope of [{ accountScope: undefined }, { accountScope: 'shared' }]) {
      const error = await failure(resources.ensure(request(scope), keyed()));
      expect(error.details?.reason).toBe('accountWide');
    }
    expect(mutations(emu, 'POST', /partner_network_connect/)).toEqual([]);
  });

  it('the chosen BGP key is resolved for the create only; service and BGP keys are secret outputs', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const first = await resources.ensure(request(), keyed());
    expect(first.state).toBe('pending');
    expect(first.secretOutputs).toBeUndefined();
    const [create] = mutations(emu, 'POST', /partner_network_connect\/attachments$/);
    expect(create!.body).toMatchObject({
      name: `bc-r-pnc-bc${deploymentHash}`,
      connection_bandwidth_in_mbps: 1000,
      naas_provider: 'MEGAPORT',
      vpc_ids: [vpc],
      bgp: { auth_key: bgpKey, peer_router_asn: 64532 },
    });
    let ready = await resources.ensure(request({ id: first.id }), keyed());
    for (let round = 0; round < 5 && ready.state !== 'ready'; round++)
      ready = await resources.ensure(request({ id: first.id }), keyed());
    const attachment = emu.state.partnerAttachments.get(first.id)!;
    expect(ready.state).toBe('ready');
    expect(ready.secretOutputs).toEqual({ serviceKey: attachment._serviceKey, bgpAuthKey: bgpKey });
    const { bgpAuthKey: _ref, ...plain } = spec;
    expect(ready.spec).toEqual(plain);
    expect(JSON.stringify([ready.outputs, ready.spec, ready.message])).not.toContain(bgpKey);
    // A retry without the id finds it by name; the VPCs change in place, the bandwidth does not.
    expect((await resources.ensure(request(), keyed())).id).toBe(first.id);
    const other = 'f2b1a3c4-0000-4000-8000-000000000001';
    await resources.ensure(
      request({ id: first.id, spec: { ...spec, vpcs: [vpc, other] } }),
      keyed(),
    );
    expect(mutations(emu, 'PATCH', /partner_network_connect/)[0]!.body).toEqual({
      vpc_ids: [vpc, other],
    });
    const error = await failure(
      resources.ensure(
        request({ id: first.id, spec: { ...spec, bandwidthMbps: '5000' } }),
        keyed(),
      ),
    );
    expect(error.details?.reason).toBe('replaceRequired');
  });

  it('an error echoing the chosen BGP key is scrubbed in its message and details', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    emu.failNext({ method: 'POST', path: /partner_network_connect\/attachments$/ }, 422, {
      id: `bad_key_${bgpKey}`,
      message: `bgp.auth_key "${bgpKey}" is too weak`,
    });
    const error = await failure(resources.ensure(request(), keyed()));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('auth_key');
    expect(JSON.stringify([error.message, error.details])).not.toContain(bgpKey);
  });

  it('delete leaves an attachment made by hand alone, and deletes its own', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedAttachment(emu.state);
    expect(
      (await failure(resources.delete('do.partner-attachment', byHand.id, keyed()))).details
        ?.reason,
    ).toBe('notManaged');
    const mine = await resources.ensure(request(), keyed());
    await resources.ensure(request({ id: mine.id }), keyed());
    expect((await resources.delete('do.partner-attachment', mine.id, keyed())).state).toBe(
      'deleting',
    );
    expect((await resources.delete('do.partner-attachment', mine.id, keyed())).state).toBe(
      'deleting',
    );
    expect((await resources.delete('do.partner-attachment', mine.id, keyed())).state).toBe(
      'deleted',
    );
    expect(mutations(emu, 'DELETE', /partner_network_connect/)).toHaveLength(1);
  });
});
