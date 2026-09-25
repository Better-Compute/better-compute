import { writeFile } from 'node:fs/promises';
import { parseDuration } from '@better-compute/core';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { newIdempotencyKey, parseTime, tenantFlag } from './capacity.js';

// The tenant's catalog and bookkeeping (PLAN.md §9.3: commands mirror the API groups): sites, projects, images,
// flavors, quotas, usage and webhooks. Each is the API call as BETTER_COMPUTE_TOKEN, in process or with --url.

function id(args: string[], prefix: string, what: string): string {
  const value = args[0]!;
  if (!new RegExp(`^${prefix}_[0-9a-z]{26,52}$`).test(value))
    throw usageError(`${value} is not a ${what} id (${prefix}_…)`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Writes a one-time secret (or an export) to a new file, 0600, never over an existing one. */
export async function writeNewFile(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CliError('ALREADY_EXISTS', `${file} exists; it is never written over`);
    throw error;
  }
}

/** A usage time: ISO 8601, epoch ms, +DURATION from now, or -DURATION before now (`-7d`). */
function usageTime(value: string, now: number, flag: string): number {
  const text = value.trim();
  if (text.startsWith('-')) {
    try {
      return now - parseDuration(text.slice(1));
    } catch {
      throw usageError(`--${flag} ${value}: a past time looks like -7d or -12h`);
    }
  }
  return parseTime(text, now, flag);
}

const listFlags = {
  limit: { type: 'integer', value: 'N', min: 1, description: 'Page size' },
  cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
} as const;

const page = (flags: { limit?: number; cursor?: string }) => ({
  ...(flags.limit ? { limit: flags.limit } : {}),
  ...(flags.cursor ? { cursor: flags.cursor } : {}),
});

const flavorFlags = {
  tenant: tenantFlag,
  pool: { type: 'string', value: 'ID', required: true, description: 'The pool (pool_…)' },
  name: {
    type: 'string',
    value: 'NAME',
    required: true,
    description: 'The flavor name, e.g. g1.small',
  },
  vcpu: {
    type: 'integer',
    value: 'N',
    required: true,
    min: 1,
    max: 1024,
    description: 'Virtual CPUs',
  },
  'memory-gib': {
    type: 'integer',
    value: 'GIB',
    required: true,
    min: 1,
    max: 16384,
    description: 'Memory in GiB',
  },
  'disk-gib': {
    type: 'integer',
    value: 'GIB',
    required: true,
    min: 1,
    max: 65536,
    description: 'Root disk in GiB',
  },
  gpus: {
    type: 'integer',
    value: 'N',
    min: 0,
    max: 16,
    description: 'GPUs passed through (default 0)',
  },
  offer: {
    type: 'string',
    value: 'ID',
    description: 'Provider pools: the provider offer it creates',
  },
} as const;

function flavorBody(flags: {
  tenant?: string;
  pool?: string;
  name?: string;
  vcpu?: number;
  'memory-gib'?: number;
  'disk-gib'?: number;
  gpus?: number;
  offer?: string;
}) {
  return {
    tenantId: flags.tenant,
    poolId: flags.pool,
    name: flags.name,
    vcpu: flags.vcpu,
    memoryGiB: flags['memory-gib'],
    diskGiB: flags['disk-gib'],
    ...(flags.gpus !== undefined ? { gpus: flags.gpus } : {}),
    ...(flags.offer ? { offerId: flags.offer } : {}),
  };
}

/** Prints a revealed webhook secret, or writes it to --secret-out and leaves it out of the output. */
async function revealSecret(
  result: { secret?: unknown } & Record<string, unknown>,
  out: string | undefined,
  path: (value: string) => string,
  note: (message: string) => void,
) {
  if (!out) return result;
  const { secret, ...rest } = result;
  if (typeof secret !== 'string')
    throw new CliError('INVALID_RESPONSE', 'The answer carries no signing secret');
  const file = path(out);
  await writeNewFile(file, `${secret}\n`);
  note(`Wrote the signing secret to ${file} (0600).`);
  return { ...rest, secretFile: file };
}

const webhookArg = [{ name: 'webhook', description: 'The webhook id (whk_…)', required: true }];
const secretOut = {
  type: 'string',
  value: 'PATH',
  description: 'Write the signing secret to this new file instead of printing it',
} as const;

export const catalogCommands = [
  // Sites.
  defineCommand({
    name: 'sites list',
    group: 'Catalog',
    summary: 'List sites (sites.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      kind: {
        type: 'string',
        value: 'KIND',
        choices: ['shared', 'dedicated', 'custom'],
        description: 'Only this kind',
      },
      region: { type: 'string', value: 'REGION', description: 'Only this region' },
      ...listFlags,
    },
    examples: ['better-compute sites list --region eu-west'],
    async run({ flags, api }) {
      return (await api()).call('sites/list', {
        tenantId: flags.tenant,
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.region ? { region: flags.region } : {}),
        ...page(flags),
      });
    },
  }),
  defineCommand({
    name: 'sites get',
    group: 'Catalog',
    summary: 'Show a site (sites.get)',
    target: 'token',
    args: [{ name: 'site', description: 'The site id (site_…)', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute sites get site_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sites/get', {
        tenantId: flags.tenant,
        siteId: id(args, 'site', 'site'),
      });
    },
  }),
  defineCommand({
    name: 'sites create',
    group: 'Catalog',
    summary: 'Create a site (sites.create)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      kind: {
        type: 'string',
        value: 'KIND',
        required: true,
        choices: ['shared', 'dedicated', 'custom'],
        description: 'The site kind',
      },
      region: {
        type: 'string',
        value: 'REGION',
        required: true,
        description: 'Its region, e.g. eu-west',
      },
      'iam-region': {
        type: 'string',
        value: 'REGION',
        description: 'The IAM region it answers to',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry the same request',
      },
    },
    examples: ['better-compute sites create --kind dedicated --region eu-west'],
    async run({ flags, api }) {
      return (await api()).call('sites/create', {
        tenantId: flags.tenant,
        kind: flags.kind,
        region: flags.region,
        ...(flags['iam-region'] ? { iamRegion: flags['iam-region'] } : {}),
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'sites update',
    group: 'Catalog',
    summary: 'Change a site’s region or IAM region (sites.update)',
    target: 'token',
    args: [{ name: 'site', description: 'The site id (site_…)', required: true }],
    flags: {
      tenant: tenantFlag,
      region: { type: 'string', value: 'REGION', description: 'The new region' },
      'iam-region': { type: 'string', value: 'REGION', description: 'The new IAM region' },
      'clear-iam-region': { type: 'boolean', description: 'Remove the IAM region' },
      'if-version': {
        type: 'integer',
        value: 'N',
        min: 1,
        description: 'Only if the site is still at this version',
      },
    },
    examples: ['better-compute sites update site_01k5w… --iam-region eu'],
    async run({ flags, args, api }) {
      if (flags['iam-region'] && flags['clear-iam-region'])
        throw usageError('Pass --iam-region or --clear-iam-region, not both');
      if (!flags.region && !flags['iam-region'] && !flags['clear-iam-region'])
        throw usageError('Nothing to change');
      return (await api()).call('sites/update', {
        tenantId: flags.tenant,
        siteId: id(args, 'site', 'site'),
        ...(flags.region ? { region: flags.region } : {}),
        ...(flags['iam-region'] ? { iamRegion: flags['iam-region'] } : {}),
        ...(flags['clear-iam-region'] ? { clearIamRegion: true } : {}),
        ...(flags['if-version'] !== undefined ? { version: flags['if-version'] } : {}),
      });
    },
  }),
  defineCommand({
    name: 'sites delete',
    group: 'Catalog',
    summary: 'Delete a site (sites.delete)',
    target: 'token',
    args: [{ name: 'site', description: 'The site id (site_…)', required: true }],
    flags: {
      tenant: tenantFlag,
      'if-version': {
        type: 'integer',
        value: 'N',
        min: 1,
        description: 'Only if the site is still at this version',
      },
    },
    examples: ['better-compute sites delete site_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('sites/delete', {
        tenantId: flags.tenant,
        siteId: id(args, 'site', 'site'),
        ...(flags['if-version'] !== undefined ? { version: flags['if-version'] } : {}),
      });
    },
  }),
  // Projects.
  defineCommand({
    name: 'projects list',
    group: 'Catalog',
    summary: 'List the tenant’s projects (projects.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      state: {
        type: 'string',
        value: 'STATE',
        choices: ['active', 'archived'],
        description: 'Only this state',
      },
      ...listFlags,
    },
    examples: ['better-compute projects list'],
    async run({ flags, api }) {
      return (await api()).call('projects/list', {
        tenantId: flags.tenant,
        ...(flags.state ? { state: flags.state } : {}),
        ...page(flags),
      });
    },
  }),
  defineCommand({
    name: 'projects get',
    group: 'Catalog',
    summary: 'Show a project (projects.get)',
    target: 'token',
    args: [{ name: 'project', description: 'The project id (prj_…)', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute projects get prj_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('projects/get', {
        tenantId: flags.tenant,
        projectId: id(args, 'prj', 'project'),
      });
    },
  }),
  defineCommand({
    name: 'projects create',
    group: 'Catalog',
    summary: 'Create a project (projects.create)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      name: {
        type: 'string',
        value: 'NAME',
        required: true,
        description: 'Lowercase letters, digits and dashes',
      },
      key: {
        type: 'string',
        value: 'KEY',
        description: 'Idempotency key, to retry the same request',
      },
    },
    examples: ['better-compute projects create --name training'],
    async run({ flags, api }) {
      return (await api()).call('projects/create', {
        tenantId: flags.tenant,
        name: flags.name,
        idempotencyKey: flags.key ?? newIdempotencyKey(),
      });
    },
  }),
  defineCommand({
    name: 'projects archive',
    group: 'Catalog',
    summary: 'Archive a project (projects.archive)',
    target: 'token',
    args: [{ name: 'project', description: 'The project id (prj_…)', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute projects archive prj_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('projects/archive', {
        tenantId: flags.tenant,
        projectId: id(args, 'prj', 'project'),
      });
    },
  }),
  // Images.
  defineCommand({
    name: 'images list',
    group: 'Catalog',
    summary: 'List catalog images (images.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      kind: {
        type: 'string',
        value: 'KIND',
        choices: ['os', 'ramdisk'],
        description: 'Only this kind',
      },
      ...listFlags,
    },
    examples: ['better-compute images list --kind os'],
    async run({ flags, api }) {
      return (await api()).call('images/list', {
        tenantId: flags.tenant,
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...page(flags),
      });
    },
  }),
  defineCommand({
    name: 'images get',
    group: 'Catalog',
    summary: 'Show a catalog image (images.get)',
    target: 'token',
    args: [{ name: 'image', description: 'The image id (img_…)', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute images get img_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('images/get', {
        tenantId: flags.tenant,
        imageId: id(args, 'img', 'image'),
      });
    },
  }),
  defineCommand({
    name: 'images register',
    group: 'Catalog',
    summary: 'Register an image in the catalog by digest (images.register)',
    description:
      'images register records name@version (--ref), where it is fetched from (--source, https:// or oci://), its format and --sha256, and optionally a signature over its identity checked with a registered signer. Nodes verify the digest of what they fetch. Decided as compute:images:publish.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      ref: {
        type: 'string',
        value: 'NAME@VERSION',
        required: true,
        description: 'e.g. ubuntu-24.04@2026.09',
      },
      source: {
        type: 'string',
        value: 'URL',
        required: true,
        description: 'Where nodes fetch it: https:// or oci://',
      },
      'disk-format': {
        type: 'string',
        value: 'FORMAT',
        required: true,
        choices: ['raw', 'qcow2', 'iso'],
        description: 'The disk format',
      },
      sha256: {
        type: 'string',
        value: 'HEX',
        required: true,
        description: 'The image digest, 64 hex digits',
      },
      kind: {
        type: 'string',
        value: 'KIND',
        choices: ['os', 'ramdisk'],
        description: 'What it boots as (default os)',
      },
      compression: {
        type: 'string',
        value: 'ALG',
        choices: ['none', 'zstd', 'gzip'],
        description: 'Default none',
      },
      size: { type: 'integer', value: 'BYTES', min: 0, description: 'Its size in bytes' },
      signature: { type: 'string', value: 'BASE64', description: 'A signature over its identity' },
      signer: {
        type: 'string',
        value: 'ID',
        description: 'The registered signer that checks --signature',
      },
    },
    examples: [
      'better-compute images register --ref ubuntu-24.04@2026.09 --source https://images.example.com/u2404.qcow2 --disk-format qcow2 --sha256 3f…',
    ],
    async run({ flags, api }) {
      if (Boolean(flags.signature) !== Boolean(flags.signer))
        throw usageError('--signature and --signer go together');
      if (!/^[0-9A-Fa-f]{64}$/.test(flags.sha256!))
        throw usageError('--sha256 takes 64 hex digits');
      return (await api()).call('images/register', {
        tenantId: flags.tenant,
        ref: flags.ref,
        source: flags.source,
        format: flags['disk-format'],
        sha256: flags.sha256!.toLowerCase(),
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.compression ? { compression: flags.compression } : {}),
        ...(flags.size !== undefined ? { sizeBytes: flags.size } : {}),
        ...(flags.signature ? { signature: flags.signature, signerId: flags.signer } : {}),
      });
    },
  }),
  defineCommand({
    name: 'images promote',
    group: 'Catalog',
    summary: 'Promote a catalog image (images.promote)',
    target: 'token',
    args: [{ name: 'image', description: 'The image id (img_…)', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute images promote img_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('images/promote', {
        tenantId: flags.tenant,
        imageId: id(args, 'img', 'image'),
      });
    },
  }),
  // Flavors.
  defineCommand({
    name: 'flavors list',
    group: 'Catalog',
    summary: 'List a pool’s instance flavors (flavors.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool (pool_…)' },
    },
    examples: ['better-compute flavors list --pool pool_01k5w…'],
    async run({ flags, api }) {
      return (await api()).call('flavors/list', { tenantId: flags.tenant, poolId: flags.pool });
    },
  }),
  defineCommand({
    name: 'flavors create',
    group: 'Catalog',
    summary: 'Define an instance flavor in a pool (flavors.create)',
    target: 'token',
    flags: flavorFlags,
    examples: [
      'better-compute flavors create --pool pool_01k5w… --name g1.small --vcpu 4 --memory-gib 16 --disk-gib 80',
    ],
    async run({ flags, api }) {
      return (await api()).call('flavors/create', flavorBody(flags));
    },
  }),
  defineCommand({
    name: 'flavors update',
    group: 'Catalog',
    summary: 'Redefine an instance flavor; running instances keep theirs (flavors.update)',
    target: 'token',
    flags: flavorFlags,
    examples: [
      'better-compute flavors update --pool pool_01k5w… --name g1.small --vcpu 4 --memory-gib 32 --disk-gib 80',
    ],
    async run({ flags, api }) {
      return (await api()).call('flavors/update', flavorBody(flags));
    },
  }),
  defineCommand({
    name: 'flavors delete',
    group: 'Catalog',
    summary: 'Remove an instance flavor from a pool (flavors.delete)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: flavorFlags.pool,
      name: flavorFlags.name,
    },
    examples: ['better-compute flavors delete --pool pool_01k5w… --name g1.small'],
    async run({ flags, api }) {
      return (await api()).call('flavors/delete', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        name: flags.name,
      });
    },
  }),
  // Quotas.
  defineCommand({
    name: 'quotas get',
    group: 'Catalog',
    summary: 'Show the tenant’s quotas and what is used, per pool (quotas.get)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', description: 'Only this pool (pool_…)' },
    },
    examples: ['better-compute quotas get --pool pool_01k5w…'],
    async run({ flags, api }) {
      return (await api()).call('quotas/get', {
        tenantId: flags.tenant,
        ...(flags.pool ? { poolId: flags.pool } : {}),
      });
    },
  }),
  defineCommand({
    name: 'quotas set',
    group: 'Catalog',
    summary: 'Set one quota of the tenant in a pool (quotas.set)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      pool: { type: 'string', value: 'ID', required: true, description: 'The pool (pool_…)' },
      resource: {
        type: 'string',
        value: 'NAME',
        required: true,
        description: 'The quota resource, e.g. gpus',
      },
      max: { type: 'integer', value: 'N', required: true, min: 0, description: 'The new limit' },
    },
    examples: ['better-compute quotas set --pool pool_01k5w… --resource gpus --max 64'],
    async run({ flags, api }) {
      return (await api()).call('quotas/set', {
        tenantId: flags.tenant,
        poolId: flags.pool,
        resource: flags.resource,
        max: flags.max,
      });
    },
  }),
  // Usage.
  defineCommand({
    name: 'usage list',
    group: 'Usage',
    summary: 'List hourly usage windows (usage.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: {
      tenant: tenantFlag,
      project: { type: 'string', value: 'ID', description: 'Only this project’s (prj_…)' },
      meter: { type: 'string', value: 'METER', description: 'Only this meter (gpu.hours, …)' },
      from: {
        type: 'string',
        value: 'TIME',
        description: 'Windows ending after: ISO 8601, epoch ms, or -7d',
      },
      to: { type: 'string', value: 'TIME', description: 'Windows starting before' },
      ...listFlags,
    },
    examples: ['better-compute usage list --from -7d --meter gpu.hours'],
    async run({ flags, api }) {
      const now = Date.now();
      return (await api()).call('usage/list', {
        tenantId: flags.tenant,
        ...(flags.project ? { projectId: flags.project } : {}),
        ...(flags.meter ? { meter: flags.meter } : {}),
        ...(flags.from ? { from: usageTime(flags.from, now, 'from') } : {}),
        ...(flags.to ? { to: usageTime(flags.to, now, 'to') } : {}),
        ...page(flags),
      });
    },
  }),
  defineCommand({
    name: 'usage export',
    group: 'Usage',
    summary: 'Export usage for billing as CSV or JSON lines (usage.export)',
    description:
      'usage export returns every hourly window between --from and --to (at most 93 days apart) and the total per meter. With --out the CSV (or JSON lines) goes to a new file, never over one, and the output keeps the count, the totals and whether the export was truncated (too many windows: narrow the range or the meter).',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      from: {
        type: 'string',
        value: 'TIME',
        required: true,
        description: 'ISO 8601, epoch ms, or -30d',
      },
      to: {
        type: 'string',
        value: 'TIME',
        required: true,
        description: 'ISO 8601, epoch ms, -1d or +0s (now)',
      },
      project: { type: 'string', value: 'ID', description: 'Only this project’s (prj_…)' },
      meter: { type: 'string', value: 'METER', description: 'Only this meter' },
      'export-format': {
        type: 'string',
        value: 'FORMAT',
        choices: ['csv', 'jsonl'],
        description: 'Default csv',
      },
      out: { type: 'string', value: 'PATH', description: 'Write the export to this new file' },
    },
    examples: ['better-compute usage export --from 2026-09-01 --to 2026-10-01 --out september.csv'],
    async run({ flags, path, api, note }) {
      const now = Date.now();
      const from = usageTime(flags.from!, now, 'from');
      const to = usageTime(flags.to!, now, 'to');
      if (to <= from) throw usageError('--to must be after --from');
      const exported = await (
        await api()
      ).call<{ data: string } & Record<string, unknown>>('usage/export', {
        tenantId: flags.tenant,
        from,
        to,
        ...(flags.project ? { projectId: flags.project } : {}),
        ...(flags.meter ? { meter: flags.meter } : {}),
        ...(flags['export-format'] ? { format: flags['export-format'] } : {}),
      });
      if (!flags.out) return exported;
      const { data, ...summary } = exported;
      const file = path(flags.out);
      await writeNewFile(file, data);
      note(`Wrote ${String(summary.count)} window(s) to ${file}.`);
      if (summary.truncated) note('Truncated: narrow the range or the meter for the rest.');
      return { ...summary, file };
    },
  }),
  // Webhooks.
  defineCommand({
    name: 'webhooks list',
    group: 'Webhooks',
    summary: 'List the tenant’s webhooks (webhooks.list)',
    target: 'token',
    defaultFormat: 'table',
    flags: { tenant: tenantFlag },
    examples: ['better-compute webhooks list'],
    async run({ flags, api }) {
      return (await api()).call('webhooks/list', { tenantId: flags.tenant });
    },
  }),
  defineCommand({
    name: 'webhooks get',
    group: 'Webhooks',
    summary: 'Show a webhook (webhooks.get)',
    target: 'token',
    args: webhookArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute webhooks get whk_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('webhooks/get', {
        tenantId: flags.tenant,
        webhookId: id(args, 'whk', 'webhook'),
      });
    },
  }),
  defineCommand({
    name: 'webhooks create',
    group: 'Webhooks',
    summary: 'Send the tenant’s events to a URL, signed (webhooks.create)',
    description:
      'webhooks create posts every event matching --events (type patterns: node.*, reservation.placed, *) to --endpoint, signed with X-Better-Compute-Signature. The signing secret is shown once: with --secret-out it goes to a new 0600 file instead of the output.',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      endpoint: {
        type: 'string',
        value: 'URL',
        required: true,
        description: 'Where events are posted (https)',
      },
      events: {
        type: 'string',
        value: 'PATTERN,…',
        required: true,
        description: 'Event type patterns',
      },
      description: { type: 'string', value: 'TEXT', description: 'What it is for' },
      'secret-out': secretOut,
    },
    examples: [
      'better-compute webhooks create --endpoint https://hooks.example.com/compute --events "node.*,reservation.*" --secret-out ./whk.secret',
    ],
    async run({ flags, path, api, note }) {
      const events = list(flags.events);
      if (!events.length) throw usageError('--events needs at least one pattern');
      const created = await (
        await api()
      ).call<{ secret?: unknown } & Record<string, unknown>>('webhooks/create', {
        tenantId: flags.tenant,
        url: flags.endpoint,
        events,
        ...(flags.description ? { description: flags.description } : {}),
      });
      return revealSecret(created, flags['secret-out'], path, note);
    },
  }),
  defineCommand({
    name: 'webhooks update',
    group: 'Webhooks',
    summary: 'Change a webhook’s URL, events, description, or pause it (webhooks.update)',
    target: 'token',
    args: webhookArg,
    flags: {
      tenant: tenantFlag,
      endpoint: { type: 'string', value: 'URL', description: 'The new URL events are posted to' },
      events: { type: 'string', value: 'PATTERN,…', description: 'The new event type patterns' },
      description: { type: 'string', value: 'TEXT', description: 'The new description' },
      pause: { type: 'boolean', description: 'Stop delivering (active = false)' },
      resume: { type: 'boolean', description: 'Deliver again (active = true)' },
    },
    examples: ['better-compute webhooks update whk_01k5w… --pause'],
    async run({ flags, args, api }) {
      if (flags.pause && flags.resume) throw usageError('Pass --pause or --resume, not both');
      const events = list(flags.events);
      const body = {
        ...(flags.endpoint ? { url: flags.endpoint } : {}),
        ...(events.length ? { events } : {}),
        ...(flags.description ? { description: flags.description } : {}),
        ...(flags.pause ? { active: false } : flags.resume ? { active: true } : {}),
      };
      if (!Object.keys(body).length) throw usageError('Nothing to change');
      return (await api()).call('webhooks/update', {
        tenantId: flags.tenant,
        webhookId: id(args, 'whk', 'webhook'),
        ...body,
      });
    },
  }),
  defineCommand({
    name: 'webhooks delete',
    group: 'Webhooks',
    summary: 'Delete a webhook (webhooks.delete)',
    target: 'token',
    args: webhookArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute webhooks delete whk_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('webhooks/delete', {
        tenantId: flags.tenant,
        webhookId: id(args, 'whk', 'webhook'),
      });
    },
  }),
  defineCommand({
    name: 'webhooks ping',
    group: 'Webhooks',
    summary: 'Send a webhook a test delivery (webhooks.ping)',
    target: 'token',
    args: webhookArg,
    flags: { tenant: tenantFlag },
    examples: ['better-compute webhooks ping whk_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('webhooks/ping', {
        tenantId: flags.tenant,
        webhookId: id(args, 'whk', 'webhook'),
      });
    },
  }),
  defineCommand({
    name: 'webhooks rotate-secret',
    group: 'Webhooks',
    summary: 'Replace a webhook’s signing secret (webhooks.rotateSecret)',
    description:
      'webhooks rotate-secret issues a new signing secret, shown once (or written to --secret-out). --keep-previous signs with the old one too for that long (at most 24h), so the receiver can switch without dropping deliveries.',
    target: 'token',
    args: webhookArg,
    flags: {
      tenant: tenantFlag,
      'keep-previous': {
        type: 'string',
        value: 'DURATION',
        description: 'Keep signing with the old secret this long',
      },
      'secret-out': secretOut,
    },
    examples: [
      'better-compute webhooks rotate-secret whk_01k5w… --keep-previous 1h --secret-out ./whk.secret.new',
    ],
    async run({ flags, args, path, api, note }) {
      let keep: number | undefined;
      if (flags['keep-previous']) {
        let ms: number;
        try {
          ms = parseDuration(flags['keep-previous']);
        } catch {
          throw usageError(`--keep-previous ${flags['keep-previous']}: a duration like 30m or 2h`);
        }
        if (ms % 1000 !== 0 || ms > 86_400_000)
          throw usageError('--keep-previous must be whole seconds up to 24h');
        keep = ms / 1000;
      }
      const rotated = await (
        await api()
      ).call<{ secret?: unknown } & Record<string, unknown>>('webhooks/rotateSecret', {
        tenantId: flags.tenant,
        webhookId: id(args, 'whk', 'webhook'),
        ...(keep !== undefined ? { keepPreviousSeconds: keep } : {}),
      });
      return revealSecret(rotated, flags['secret-out'], path, note);
    },
  }),
  defineCommand({
    name: 'webhooks deliveries',
    group: 'Webhooks',
    summary: 'List a webhook’s deliveries (webhooks.deliveries)',
    target: 'token',
    defaultFormat: 'table',
    args: webhookArg,
    flags: {
      tenant: tenantFlag,
      state: {
        type: 'string',
        value: 'STATE',
        choices: ['pending', 'delivered', 'dead', 'cancelled'],
        description: 'Only deliveries in this state',
      },
      limit: { type: 'integer', value: 'N', min: 1, max: 200, description: 'At most this many' },
    },
    examples: ['better-compute webhooks deliveries whk_01k5w… --state dead'],
    async run({ flags, args, api }) {
      return (await api()).call('webhooks/deliveries', {
        tenantId: flags.tenant,
        webhookId: id(args, 'whk', 'webhook'),
        ...(flags.state ? { state: flags.state } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
      });
    },
  }),
  defineCommand({
    name: 'webhooks redeliver',
    group: 'Webhooks',
    summary: 'Deliver one event again (webhooks.redeliver)',
    target: 'token',
    args: [{ name: 'delivery', description: 'The delivery id (dlv_…)', required: true }],
    flags: { tenant: tenantFlag },
    examples: ['better-compute webhooks redeliver dlv_01k5w…'],
    async run({ flags, args, api }) {
      return (await api()).call('webhooks/redeliver', {
        tenantId: flags.tenant,
        deliveryId: id(args, 'dlv', 'delivery'),
      });
    },
  }),
  defineCommand({
    name: 'webhooks event-types',
    group: 'Webhooks',
    summary: 'List the event types a webhook can subscribe to (webhooks.eventTypes)',
    target: 'token',
    flags: { tenant: tenantFlag },
    examples: ['better-compute webhooks event-types'],
    async run({ flags, api }) {
      return (await api()).call('webhooks/eventTypes', { tenantId: flags.tenant });
    },
  }),
];
