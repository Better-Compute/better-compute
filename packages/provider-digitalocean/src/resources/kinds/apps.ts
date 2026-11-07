import {
  ComputeError,
  isComputeError,
  isSecretRef,
  type CallContext,
  type JsonSchema,
  type ProviderDiscoveredResource,
  type ProviderResourceRequest,
  type ProviderResourceState,
  type SecretRef,
} from '@better-compute/core';
import { keyTag } from '../../ids.js';
import {
  assertOwned,
  found,
  managedBy,
  ownershipTags,
  replaceRequired,
  scrubbing,
  strings,
  type DoKind,
  type DoKindEnv,
} from '../kind.js';
import { fingerprint, isJson, isObject, objectManifest, type Issue } from '../spec.js';

// App Platform (`do.app`): the App spec is the manifest, minus its `name` (the resource's provider name). An app
// cannot be tagged, so ownership travels as app-level build-time env vars `BETTER_COMPUTE_*` carrying the same
// values as the tags of the other kinds (managed, deployment, key, resource, tenant), plus `BETTER_COMPUTE_SPEC`,
// the fingerprint of the spec last applied: an ensure sends the spec again only when the fingerprint differs, so a
// converged app is never redeployed. Tenants cannot set `BETTER_COMPUTE_*` envs.
//
// Secrets never sit in the spec: a SECRET env's value, registry credentials and log-destination keys are SecretRefs,
// resolved just before the call (DO encrypts them; a read returns ciphertext, which is never copied back into a
// spec better-compute reports). On a shared (hosted) account a spec may not reach account-wide objects: linked
// repositories, the account's registry, a database cluster by name, a VPC or a DNS zone.
//
// Deployments are read-only status: the latest one decides `pending`/`updating`/`ready`, and one that failed is
// `error` (an app whose previous deployment still serves says so).

export const appKindName = 'do.app';

const componentTypes = ['services', 'static_sites', 'workers', 'jobs', 'functions'] as const;
const updatableFields = [
  ...componentTypes,
  'databases',
  'domains',
  'envs',
  'ingress',
  'egress',
  'alerts',
  'features',
  'maintenance',
  'disable_edge_cache',
  'disable_email_obfuscation',
  'enhanced_threat_control_enabled',
  'vpc',
];
const topLevel = new Set(['region', ...updatableFields]);
/** Keys whose value is a secret wherever they appear: they must be SecretRefs. */
const sensitiveKeys = new Set([
  'registry_credentials',
  'api_key',
  'token',
  'password',
  'secret',
  'private_key',
  'client_secret',
  'access_key',
  'secret_key',
]);
const linkedSources = ['github', 'gitlab', 'bitbucket'] as const;
const componentName = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ownPrefix = 'BETTER_COMPUTE_';
const printKey = 'BETTER_COMPUTE_SPEC';
const maxSpecBytes = 64 * 1024;
const terminal = new Set(['ACTIVE', 'SUPERSEDED', 'ERROR', 'CANCELED']);

type Json = Record<string, any>;
export type AppSpecInput = Json;

interface DoEnv {
  key: string;
  value?: string;
  scope?: string;
  type?: string;
}

export interface DoApp {
  id: string;
  spec: Json & { name: string; envs?: DoEnv[] };
  default_ingress?: string;
  live_url?: string;
  live_domain?: string;
  region?: { slug?: string };
  active_deployment?: { id?: string; phase?: string };
  created_at: string;
}

interface DoDeployment {
  id: string;
  phase: string;
}

// --- the manifest ------------------------------------------------------------------------------------------------

function checkEnvs(envs: unknown, path: (string | number)[], issues: Issue[]): void {
  if (!Array.isArray(envs)) {
    issues.push({ message: 'envs is a list', path });
    return;
  }
  envs.forEach((entry, index) => {
    const at = [...path, index];
    if (!isObject(entry) || typeof entry.key !== 'string' || !envKey.test(entry.key)) {
      issues.push({ message: 'an env has a key of letters, digits and _', path: [...at, 'key'] });
      return;
    }
    if (entry.key.toUpperCase().startsWith(ownPrefix))
      issues.push({ message: `${ownPrefix}* envs are reserved for better-compute`, path: at });
    if (entry.type !== undefined && entry.type !== 'GENERAL' && entry.type !== 'SECRET')
      issues.push({ message: 'an env type is GENERAL or SECRET', path: [...at, 'type'] });
    if (entry.type === 'SECRET' && !isSecretRef(entry.value))
      issues.push({
        message: 'a SECRET env takes a SecretRef (secret://…), never the value',
        path: [...at, 'value'],
      });
    if (entry.type !== 'SECRET' && entry.value !== undefined && typeof entry.value !== 'string')
      issues.push({ message: 'an env value is a string', path: [...at, 'value'] });
  });
}

function checkSensitive(value: unknown, path: (string | number)[], issues: Issue[]): void {
  if (Array.isArray(value))
    value.forEach((entry, i) => checkSensitive(entry, [...path, i], issues));
  else if (isObject(value))
    for (const [key, entry] of Object.entries(value)) {
      if (sensitiveKeys.has(key) && !isSecretRef(entry))
        issues.push({
          message: `${key} takes a SecretRef (secret://…), never the value`,
          path: [...path, key],
        });
      else checkSensitive(entry, [...path, key], issues);
    }
}

function checkComponent(component: Json, path: (string | number)[], issues: Issue[]): void {
  if (component.git !== undefined) {
    const url = component.git?.repo_clone_url;
    if (typeof url !== 'string' || !/^https:\/\/[^\s@]+$/.test(url))
      issues.push({
        message: 'git.repo_clone_url is an https URL without credentials',
        path: [...path, 'git', 'repo_clone_url'],
      });
  }
  if (component.image !== undefined) {
    const image = component.image;
    if (!isObject(image) || !['DOCKER_HUB', 'GHCR', 'DOCR'].includes(image.registry_type as string))
      issues.push({
        message: 'image.registry_type is DOCKER_HUB, GHCR or DOCR',
        path: [...path, 'image', 'registry_type'],
      });
    else if (typeof image.repository !== 'string' || image.repository.length === 0)
      issues.push({
        message: 'image.repository is required',
        path: [...path, 'image', 'repository'],
      });
  }
  if (component.envs !== undefined) checkEnvs(component.envs, [...path, 'envs'], issues);
}

function checkAppSpec(value: unknown, issues: Issue[]): AppSpecInput {
  if (!isObject(value)) {
    issues.push({ message: 'an App Platform spec is an object', path: [] });
    return {};
  }
  if (!isJson(value, 24)) {
    issues.push({ message: 'the spec is plain JSON', path: [] });
    return value;
  }
  if (JSON.stringify(value).length > maxSpecBytes)
    issues.push({ message: 'the spec is at most 64 KiB', path: [] });
  for (const key of Object.keys(value)) {
    if (key === 'name')
      issues.push({
        message: "the app's name is the resource's provider name; leave name out",
        path: ['name'],
      });
    else if (!topLevel.has(key))
      issues.push({ message: `${key} is not an App spec field`, path: [key] });
  }
  if (
    value.region !== undefined &&
    (typeof value.region !== 'string' || !/^[a-z]{3}$/.test(value.region))
  )
    issues.push({ message: 'region is an App Platform region slug, e.g. nyc', path: ['region'] });
  const names = new Set<string>();
  let components = 0;
  for (const type of componentTypes) {
    const list = value[type];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 50) {
      issues.push({ message: `${type} is a list of at most 50 components`, path: [type] });
      continue;
    }
    list.forEach((component, index) => {
      if (
        !isObject(component) ||
        typeof component.name !== 'string' ||
        !componentName.test(component.name)
      ) {
        issues.push({
          message: 'a component has a name of 2-32 lowercase letters, digits and -',
          path: [type, index, 'name'],
        });
        return;
      }
      if (names.has(component.name))
        issues.push({
          message: `component name ${component.name} is used twice`,
          path: [type, index, 'name'],
        });
      names.add(component.name);
      components++;
      checkComponent(component, [type, index], issues);
    });
  }
  if (components === 0)
    issues.push({
      message: 'an app has at least one service, static site, worker, job or functions component',
      path: [],
    });
  if (value.envs !== undefined) checkEnvs(value.envs, ['envs'], issues);
  for (const key of ['databases', 'domains', 'alerts', 'features'] as const)
    if (value[key] !== undefined && !Array.isArray(value[key]))
      issues.push({ message: `${key} is a list`, path: [key] });
  checkSensitive(value, [], issues);
  return value;
}

const componentSchema: JsonSchema = {
  type: 'array',
  maxItems: 50,
  items: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', pattern: componentName.source } },
  },
};

const appSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  description:
    'A DigitalOcean App Platform app spec without its name. SECRET env values, registry credentials and API keys are SecretRefs.',
  additionalProperties: false,
  properties: {
    region: {
      type: 'string',
      pattern: '^[a-z]{3}$',
      description: 'App Platform region slug, e.g. nyc',
    },
    ...Object.fromEntries(componentTypes.map((type) => [type, componentSchema])),
    envs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', pattern: envKey.source },
          value: { type: 'string' },
          scope: { type: 'string' },
          type: { enum: ['GENERAL', 'SECRET'] },
        },
      },
    },
    databases: { type: 'array' },
    domains: { type: 'array' },
    ingress: { type: 'object' },
    egress: { type: 'object' },
    alerts: { type: 'array' },
    features: { type: 'array' },
    maintenance: { type: 'object' },
    vpc: { type: 'object', description: 'Only on the tenant’s own account' },
    disable_edge_cache: { type: 'boolean' },
    disable_email_obfuscation: { type: 'boolean' },
    enhanced_threat_control_enabled: { type: 'boolean' },
  },
};

export const appSpecManifest = objectManifest<AppSpecInput>(appSchema, checkAppSpec);

// --- what a spec reaches -----------------------------------------------------------------------------------------

/** The account-wide objects a spec reaches, as paths: refused on a shared account. */
export function accountWide(spec: AppSpecInput): string[] {
  const found: string[] = [];
  for (const type of componentTypes)
    (Array.isArray(spec[type]) ? (spec[type] as Json[]) : []).forEach((component, index) => {
      for (const source of linkedSources)
        if (component[source] !== undefined)
          found.push(`${type}[${index}].${source} (a repository linked to the account)`);
      if (component.image?.registry_type === 'DOCR')
        found.push(`${type}[${index}].image (the account's container registry)`);
    });
  (Array.isArray(spec.databases) ? (spec.databases as Json[]) : []).forEach((database, index) => {
    if (isObject(database) && database.cluster_name !== undefined)
      found.push(`databases[${index}].cluster_name (a database cluster of the account)`);
  });
  (Array.isArray(spec.domains) ? (spec.domains as Json[]) : []).forEach((domain, index) => {
    if (isObject(domain) && domain.zone !== undefined)
      found.push(`domains[${index}].zone (a DNS zone of the account)`);
  });
  if (spec.vpc !== undefined) found.push('vpc (a VPC of the account)');
  return found;
}

/** A copy with every SecretRef in a secret slot resolved through the call's resolver; the values go to `seen`. */
async function resolveSecrets(
  value: unknown,
  context: CallContext,
  seen: string[],
  key?: string,
): Promise<unknown> {
  const resolve = async (ref: SecretRef) => {
    const secret = await context.secrets.resolve(ref);
    if (secret.length > 0) seen.push(secret);
    return secret;
  };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      if (key === 'envs' && isObject(entry) && entry.type === 'SECRET' && isSecretRef(entry.value))
        out.push({ ...entry, value: await resolve(entry.value) });
      else out.push(await resolveSecrets(entry, context, seen));
    }
    return out;
  }
  if (isObject(value)) {
    const out: Json = {};
    for (const [name, entry] of Object.entries(value))
      out[name] =
        sensitiveKeys.has(name) && isSecretRef(entry)
          ? await resolve(entry)
          : await resolveSecrets(entry, context, seen, name);
    return out;
  }
  return value;
}

/** Sends a spec with resolved secrets; an error that echoes one of them has it masked before it goes anywhere. */
async function sendSpec(
  env: DoKindEnv,
  method: 'POST' | 'PUT',
  path: string,
  sending: { spec: Json; secrets: readonly string[] },
  signal: AbortSignal,
): Promise<DoApp> {
  const reply = await scrubbing(sending.secrets, () =>
    env.client.request<{ app: DoApp }>(method, path, {
      body: { spec: sending.spec },
      signal,
      budget: 'mutate',
    }),
  );
  return reply.app;
}

/** The spec DO reports, as a tenant spec: no name, no ownership envs, no secret values (not even ciphertext). */
export function observedSpec(app: DoApp): AppSpecInput {
  const strip = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value))
      return value
        .filter(
          (entry) => !(key === 'envs' && isObject(entry) && isOwnEnv(entry as unknown as DoEnv)),
        )
        .map((entry) => {
          if (key === 'envs' && isObject(entry) && entry.type === 'SECRET') {
            const { value: _secret, ...rest } = entry;
            return rest;
          }
          return strip(entry);
        });
    if (isObject(value)) {
      const out: Json = {};
      for (const [name, entry] of Object.entries(value))
        if (!sensitiveKeys.has(name)) out[name] = strip(entry, name);
      return out;
    }
    return value;
  };
  const { name: _name, ...rest } = structuredClone(app.spec);
  const spec = strip(rest) as Json;
  if (Array.isArray(spec.envs) && spec.envs.length === 0) delete spec.envs;
  return spec;
}

// --- ownership -----------------------------------------------------------------------------------------------------

const isOwnEnv = (entry: DoEnv) =>
  typeof entry.key === 'string' && entry.key.toUpperCase().startsWith(ownPrefix);

/** `better-compute-x:v` tag -> `BETTER_COMPUTE_X=v` env. */
function tagEnv(tag: string): DoEnv {
  const colon = tag.indexOf(':');
  return {
    key: tag.slice(0, colon).toUpperCase().replace(/-/g, '_'),
    value: tag.slice(colon + 1),
    scope: 'BUILD_TIME',
    type: 'GENERAL',
  };
}

/** The ownership envs read back as the tags the shared ownership rules understand. */
export function envTags(envs: readonly DoEnv[] | null | undefined): string[] {
  return (envs ?? [])
    .filter((entry) => isOwnEnv(entry) && entry.key.toUpperCase() !== printKey)
    .map(
      (entry) =>
        `${entry.key.toLowerCase().replace(/_/g, '-')}:${String(entry.value ?? '').toLowerCase()}`,
    );
}

const printOf = (app: DoApp) =>
  (app.spec.envs ?? []).find((entry) => entry.key.toUpperCase() === printKey)?.value;

function ownEnvs(tags: readonly string[], print: string): DoEnv[] {
  return [
    ...tags.map(tagEnv),
    { key: printKey, value: print, scope: 'BUILD_TIME', type: 'GENERAL' },
  ];
}

// --- calls ---------------------------------------------------------------------------------------------------------

const what = (id: string) => `App ${id}`;

async function readApp(
  env: DoKindEnv,
  id: string,
  signal: AbortSignal,
): Promise<DoApp | undefined> {
  const reply = await found(() =>
    env.client.request<{ app: DoApp }>('GET', `/apps/${encodeURIComponent(id)}`, {
      signal,
      budget: 'observe',
    }),
  );
  return reply?.app;
}

/** The oldest app of this deployment carrying the key's env. */
async function byKey(env: DoKindEnv, context: CallContext): Promise<DoApp | undefined> {
  const key = keyTag(context.idempotencyKey);
  const mine: DoApp[] = [];
  for await (const app of env.client.pages<DoApp>('/apps', 'apps', {
    signal: context.signal,
    budget: 'observe',
  })) {
    const tags = envTags(app.spec?.envs);
    if (tags.includes(key) && managedBy(env, tags) === 'this') mine.push(app);
  }
  return mine.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )[0];
}

async function latestDeployment(
  env: DoKindEnv,
  id: string,
  signal: AbortSignal,
): Promise<DoDeployment | undefined> {
  const reply = await env.client.request<{ deployments?: DoDeployment[] | null }>(
    'GET',
    `/apps/${encodeURIComponent(id)}/deployments`,
    { query: { page: '1', per_page: '1' }, signal, budget: 'observe' },
  );
  return (reply.deployments ?? [])[0];
}

/** An app's instance hours: one per running service or worker instance per hour (static sites run none). */
export const appInstanceHoursMeter = 'do.app.instance.hours';

/** The instances an app runs: its services' and workers' counts (an autoscaled one: its minimum). */
export function appInstances(spec: Json): number {
  let count = 0;
  const record = spec as Record<string, unknown>;
  for (const group of ['services', 'workers'])
    for (const component of Array.isArray(record[group]) ? (record[group] as unknown[]) : []) {
      const entry = (component ?? {}) as {
        instance_count?: unknown;
        autoscaling?: { min_instance_count?: unknown } | null;
      };
      const value = entry.autoscaling?.min_instance_count ?? entry.instance_count ?? 1;
      count += typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }
  return count;
}

async function appState(
  env: DoKindEnv,
  app: DoApp,
  signal: AbortSignal,
): Promise<ProviderResourceState> {
  const latest = await latestDeployment(env, app.id, signal);
  const active = app.active_deployment?.id;
  let state: ProviderResourceState['state'] = 'ready';
  let message: string | undefined;
  if (!latest) state = 'pending';
  else if (!terminal.has(latest.phase)) state = active ? 'updating' : 'pending';
  else if (latest.phase === 'ERROR' || latest.phase === 'CANCELED') {
    state = 'error';
    message = `Deployment ${latest.id} ended ${latest.phase}${active ? '; the previous deployment still serves' : ''}`;
  }
  return {
    id: app.id,
    state,
    ...(message ? { message } : {}),
    outputs: strings({
      liveUrl: app.live_url,
      defaultIngress: app.default_ingress,
      liveDomain: app.live_domain,
      region: app.region?.slug ?? app.spec.region,
      activeDeployment: active,
      deploymentPhase: latest?.phase,
      urn: `do:app:${app.id}`,
    }),
    usage: { [appInstanceHoursMeter]: appInstances(app.spec) },
    spec: observedSpec(app),
  };
}

/** The spec DO is sent: the tenant's, named, secrets resolved, with the ownership envs. */
async function desired(
  env: DoKindEnv,
  request: ProviderResourceRequest,
  context: CallContext,
): Promise<{ spec: Json; secrets: string[] }> {
  const spec = request.spec as AppSpecInput;
  if (request.accountScope !== 'tenant') {
    const wide = accountWide(spec);
    if (wide.length > 0)
      throw new ComputeError(
        'INVALID_INPUT',
        `${appKindName}: ${wide[0]} is account-wide; only an app on the tenant's own account may use it`,
        undefined,
        { provider: 'digitalocean', reason: 'accountWide', fields: wide },
      );
  }
  const secrets: string[] = [];
  const resolved = (await resolveSecrets(spec, context, secrets)) as Json;
  return {
    spec: {
      ...resolved,
      name: request.name,
      envs: [
        ...((resolved.envs as DoEnv[] | undefined) ?? []),
        ...ownEnvs(ownershipTags(env, request.labels, context), fingerprint(spec)),
      ],
    },
    secrets,
  };
}

export function appKind(): DoKind {
  return {
    definition: {
      kind: appKindName,
      family: 'platform',
      description:
        'A DigitalOcean App Platform app; its App spec is the manifest, deployments are read-only status',
      spec: appSpecManifest,
      outputs: [
        'liveUrl',
        'defaultIngress',
        'liveDomain',
        'region',
        'activeDeployment',
        'deploymentPhase',
        'urn',
      ],
      // App Platform regions (nyc, ams) are not the account's datacenter regions (nyc3): not regional.
      regional: false,
      updatable: updatableFields,
      meters: [{ meter: appInstanceHoursMeter, unit: 'hour' }],
      // Linked repositories, DOCR, a database cluster by name, a VPC or a DNS zone: the tenant's own account only.
      accountWide: (spec: unknown) => accountWide(spec as AppSpecInput),
    },

    async ensure(env, request, context) {
      const wanted = request.spec as AppSpecInput;
      let app: DoApp | undefined;
      if (request.id !== undefined) {
        app = await readApp(env, request.id, context.signal);
        if (!app)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        assertOwned(env, envTags(app.spec.envs), what(app.id));
      } else app = await byKey(env, context);
      if (!app) {
        const sending = await desired(env, request, context);
        try {
          const created = await sendSpec(env, 'POST', '/apps', sending, context.signal);
          return await appState(env, created, context.signal);
        } catch (error) {
          // The name is taken: a racing create of ours made it (its key env finds it), or it is someone else's.
          if (!isComputeError(error, 'CONFLICT')) throw error;
          app = await byKey(env, context);
          if (!app) throw error;
        }
      }
      const region = app.region?.slug ?? app.spec.region;
      if (wanted.region !== undefined && region !== undefined && wanted.region !== region)
        throw replaceRequired(appKindName, 'region');
      if (printOf(app) === fingerprint(wanted)) return appState(env, app, context.signal);
      const sending = await desired(env, request, context);
      const updated = await sendSpec(
        env,
        'PUT',
        `/apps/${encodeURIComponent(app.id)}`,
        sending,
        context.signal,
      );
      const state = await appState(env, updated, context.signal);
      return state.state === 'ready' ? { ...state, state: 'updating' } : state;
    },

    // A create whose answer was lost: the app of this deployment carrying the key's env, as ensure finds it.
    async find(env, _request, context) {
      return (await byKey(env, context))?.id;
    },

    async get(env, id, context) {
      const app = await readApp(env, id, context.signal);
      return app ? appState(env, app, context.signal) : undefined;
    },

    async delete(env, id, context) {
      const app = await readApp(env, id, context.signal);
      if (!app) return { id, state: 'deleted' };
      assertOwned(env, envTags(app.spec.envs), what(id));
      await found(() =>
        env.client.request('DELETE', `/apps/${encodeURIComponent(id)}`, {
          signal: context.signal,
          budget: 'mutate',
        }),
      );
      return { id, state: 'deleting' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const app of env.client.pages<DoApp>('/apps', 'apps', {
        signal: context.signal,
        budget: 'sweep',
      })) {
        const owner = managedBy(env, envTags(app.spec?.envs));
        const region = app.region?.slug ?? app.spec?.region;
        yield {
          id: app.id,
          name: app.spec.name,
          ...(region ? { region } : {}),
          ...(owner !== undefined ? { managedBy: owner } : {}),
          spec: observedSpec(app),
        };
      }
    },

    async adopt(env, id, labels, context) {
      const app = await readApp(env, id, context.signal);
      if (!app) throw new ComputeError('NOT_FOUND', `${what(id)} not found`);
      const owner = managedBy(env, envTags(app.spec.envs));
      if (owner === 'other')
        throw new ComputeError(
          'INVALID_STATE',
          `${what(id)} is managed by another deployment`,
          undefined,
          {
            provider: 'digitalocean',
            reason: 'managedByAnother',
          },
        );
      // Adopted already (a retried adopt): nothing to write again.
      if (owner === 'this') return appState(env, app, context.signal);
      const envs = [
        ...(app.spec.envs ?? []).filter((entry) => !isOwnEnv(entry)),
        ...ownEnvs(ownershipTags(env, labels, context), fingerprint(observedSpec(app))),
      ];
      // The spec goes back as DO gave it: SECRET values are its ciphertext, which it keeps.
      const updated = await env.client.request<{ app: DoApp }>(
        'PUT',
        `/apps/${encodeURIComponent(id)}`,
        {
          body: { spec: { ...app.spec, envs } },
          signal: context.signal,
          budget: 'mutate',
        },
      );
      return appState(env, updated.app, context.signal);
    },

    async release(env, id, context) {
      const app = await readApp(env, id, context.signal);
      if (!app) return;
      assertOwned(env, envTags(app.spec.envs), what(id));
      const envs = (app.spec.envs ?? []).filter((entry) => !isOwnEnv(entry));
      await env.client.request('PUT', `/apps/${encodeURIComponent(id)}`, {
        body: { spec: { ...app.spec, envs } },
        signal: context.signal,
        budget: 'mutate',
      });
    },
  };
}
