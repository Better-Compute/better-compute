import {
  isComputeError,
  type CallContext,
  type ExternalMachine,
  type Logger,
  type ProviderImpl,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';

// Projects per tenant (DigitalOcean P9, DO-D22). With the account's `projectPerTenant`, every Droplet a create
// makes is assigned to the project `bc-<tenantId>`, made on first use, so a platform account's resources are
// grouped by tenant in DigitalOcean's own console and invoices (`project_name`). It is grouping, never authority:
// ownership stays in the tags. Off by default (tenants on their own accounts keep their own projects).
//
// Best effort (D-ops-4): the Droplet exists once create has it, so a failed lookup, create or assignment is logged
// (`digitalocean.projectAssignFailed`, with the error code, never the token) and the create still succeeds. A
// project id is cached per client once found or made; a failure is not cached. Two processes that make the same
// project race on DO's unique name: the loser's 409 (or 422) re-reads the list and takes the winner's.

/** DigitalOcean's limit on a project name. */
const maxNameLength = 175;
const tenantPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The project a tenant's resources go to. */
export function tenantProjectName(tenantId: string): string {
  return `bc-${tenantId}`;
}

interface DoProject {
  id: string;
  name: string;
}

/** Project ids by name, per client: a second account (or test) never sees another's. */
const caches = new WeakMap<DoClient, Map<string, Promise<string>>>();

async function findProject(
  client: DoClient,
  name: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  for await (const project of client.pages<DoProject>('/projects', 'projects', {
    signal,
    budget: 'observe',
  }))
    if (project.name === name && typeof project.id === 'string') return project.id;
  return undefined;
}

async function ensureProject(
  client: DoClient,
  tenantId: string,
  signal: AbortSignal,
): Promise<string> {
  const name = tenantProjectName(tenantId);
  const found = await findProject(client, name, signal);
  if (found) return found;
  try {
    const reply = await client.request<{ project?: DoProject }>('POST', '/projects', {
      body: {
        name,
        description: `better-compute resources of tenant ${tenantId}`,
        purpose: 'better-compute tenant resources',
        environment: 'Production',
      },
      signal,
      budget: 'mutate',
    });
    if (reply.project?.id) return reply.project.id;
  } catch (error) {
    if (!isComputeError(error, 'CONFLICT') && !isComputeError(error, 'INVALID_INPUT')) throw error;
  }
  // A racing create won, or the answer had no id: the list has it now.
  const raced = await findProject(client, name, signal);
  if (raced) return raced;
  throw new Error(`project ${name} was neither found nor made`);
}

/** The tenant's project id: cached per client once known; a failed lookup is dropped so the next call retries. */
function projectOf(client: DoClient, tenantId: string, signal: AbortSignal): Promise<string> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  const cached = cache.get(tenantId);
  if (cached) return cached;
  const pending = ensureProject(client, tenantId, signal);
  cache.set(tenantId, pending);
  pending.catch(() => {
    if (cache.get(tenantId) === pending) cache.delete(tenantId);
  });
  return pending;
}

/** Assigns a Droplet to its tenant's project; logs and returns on any failure. */
export async function assignTenantProject(
  client: DoClient,
  tenantId: string | undefined,
  machine: ExternalMachine,
  context: Pick<CallContext, 'signal'>,
  log: Logger,
): Promise<void> {
  if (tenantId === undefined) return;
  if (!tenantPattern.test(tenantId) || tenantProjectName(tenantId).length > maxNameLength) {
    log.warn('digitalocean.projectTenantInvalid', { droplet: machine.id });
    return;
  }
  try {
    const project = await projectOf(client, tenantId, context.signal);
    await client.request('POST', `/projects/${encodeURIComponent(project)}/resources`, {
      body: { resources: [`do:droplet:${machine.id}`] },
      signal: context.signal,
      budget: 'mutate',
    });
  } catch (error) {
    if (context.signal.aborted) return;
    log.warn('digitalocean.projectAssignFailed', {
      droplet: machine.id,
      tenantId,
      code: isComputeError(error) ? error.code : 'INTERNAL_ERROR',
    });
  }
}

/** Wraps `compute.create` so each Droplet it returns is assigned to the request's tenant's project. */
export function withTenantProjects<T extends Pick<ProviderImpl, 'create'>>(
  compute: T,
  client: DoClient,
  log: Logger,
): T {
  const create = compute.create.bind(compute);
  compute.create = async (request, context) => {
    const machine = await create(request, context);
    await assignTenantProject(client, request.tenantId, machine, context, log);
    return machine;
  };
  return compute;
}
