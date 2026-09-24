import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { betterCompute } from '@better-compute/server';
import type { AnyCompute } from '../config.js';
import { CliError, usageError } from '../errors.js';
import { defineCommand, type CommandContext, type FlagSpecs } from '../framework.js';
import { unconfiguredIam } from '../iam.js';
import { formatResult, type OutputFormat } from '../output.js';
import { isPublicRoute, listRoutes, parseEndpoint, routePath } from '../transport.js';

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Sets `a.b.c` (and `list[]` to append) on a plain object, refusing prototype keys. */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  if (parts.some((part) => !part || unsafeKeys.has(part.replace(/\[\]$/, ''))))
    throw usageError(`${key} is not a usable field name`);
  let current = target;
  for (const [index, raw] of parts.entries()) {
    const append = raw.endsWith('[]');
    const part = append ? raw.slice(0, -2) : raw;
    const last = index === parts.length - 1;
    if (last) {
      if (append) {
        const existing = current[part];
        if (existing !== undefined && !Array.isArray(existing))
          throw usageError(`${part} is already set to a non-list value`);
        current[part] = [...((existing as unknown[] | undefined) ?? []), value];
      } else current[part] = value;
      return;
    }
    if (append) throw usageError(`${key}: [] may only end a field name`);
    const next = current[part];
    if (next === undefined) current[part] = Object.create(null) as Record<string, unknown>;
    else if (!isRecord(next)) throw usageError(`${part} is already set to a non-object value`);
    current = current[part] as Record<string, unknown>;
  }
}

function readJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageError(`${source} is not valid JSON`);
  }
}

/**
 * Builds the request body from `--data` (JSON, `@file.json`, or `-` for stdin) and `key=value`
 * items, like HTTPie: `name=gpu-a` (string), `limit:=10` / `labels:='["a"]'` (JSON),
 * `spec:=@spec.json` (JSON file), `notes=@notes.md` (file text), `resource.type=pool` (nested),
 * `ids[]=a` (append).
 */
export async function requestBody(
  context: Pick<CommandContext<FlagSpecs>, 'io' | 'path'>,
  data: string | undefined,
  items: string[],
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (data !== undefined) {
    let parsed: unknown;
    if (data === '-') {
      if (!context.io.stdin) throw usageError('--data - needs standard input');
      parsed = readJson(await context.io.stdin(), 'Standard input');
    } else if (data.startsWith('@'))
      parsed = readJson(await readFile(context.path(data.slice(1)), 'utf8'), data.slice(1));
    else parsed = readJson(data, '--data');
    if (!isRecord(parsed)) throw usageError('--data must be a JSON object');
    body = JSON.parse(JSON.stringify(parsed), (key, value: unknown) =>
      unsafeKeys.has(key) ? undefined : value,
    ) as Record<string, unknown>;
  }
  for (const item of items) {
    const match = /^([^=:]+)(:=|=)(.*)$/s.exec(item);
    if (!match)
      throw usageError(
        `${item} is not key=value or key:=json`,
        'Quote values with spaces; see better-compute help api.',
      );
    const [, key, operator, raw] = match as unknown as [string, string, string, string];
    let value: unknown;
    if (operator === ':=')
      value = raw.startsWith('@')
        ? readJson(await readFile(context.path(raw.slice(1)), 'utf8'), raw.slice(1))
        : readJson(raw, `${key}:=`);
    else
      value =
        raw.startsWith('@') && raw.length > 1
          ? await readFile(context.path(raw.slice(1)), 'utf8')
          : raw;
    assign(body, key.trim(), value);
  }
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

/** The deployment whose routes `api --list` shows: the configuration's, else a throwaway one of this release. */
async function routeSource(
  context: CommandContext<FlagSpecs>,
): Promise<{ compute: AnyCompute; basePath: string; close?: () => Promise<void> }> {
  const { flags } = context;
  if (!flags.url && ((await context.configPath()) || context.env.BETTER_COMPUTE_DATABASE_URL)) {
    const compute = await context.compute();
    return { compute, basePath: compute.endpoint.basePath };
  }
  // The core routes are the same for every deployment of this release; a server's own modules and
  // plugins are not listed then. The database is never opened: listing runs no statement.
  const { pglite } = await import('@better-compute/postgres/pglite');
  const database = pglite();
  const compute = betterCompute({
    database,
    iam: unconfiguredIam(),
    secret: randomBytes(32).toString('base64url'),
    baseURL: 'http://localhost:3000',
    rootTenantId: 'root',
  });
  return {
    compute,
    basePath: flags.url ? parseEndpoint(flags.url).basePath : compute.endpoint.basePath,
    close: () => database.close(),
  };
}

export const apiCommands = [
  defineCommand({
    name: 'api',
    group: 'API',
    summary: 'Call any compute API method as the current token',
    description:
      'api calls any method of the HTTP API (the same routes, envelope and permission checks as POST {basePath}/{group}/{method}) as BETTER_COMPUTE_TOKEN, in process through the configuration or against --url, and prints the result. Public methods (system.version, system.whoami) need no token; system.whoami reports the token when one is set. Build the input with --data (JSON, @file.json, or - for standard input) and key=value items: name=gpu-a sets a string, limit:=10 or labels:=\'["a","b"]\' sets JSON, spec:=@spec.json reads a JSON file, notes=@notes.md reads a text file, resource.type=pool nests, and ids[]=a appends. Plugin methods are plugins.ID.GROUP.METHOD. api --list [GROUP] lists every route with whether it needs a token and the IAM action it is decided on.',
    usage:
      'better-compute api GROUP.METHOD [key=value ...] [--data JSON|@FILE|-] [--list] [--config PATH] [--url URL]',
    target: 'token',
    args: [
      {
        name: 'route',
        description: 'group.method (system.version) or plugins.id.group.method',
      },
      {
        name: 'fields',
        description: 'key=value, key:=json, key:=@file.json, key=@file.txt',
        variadic: true,
      },
    ],
    flags: {
      data: {
        type: 'string',
        value: 'JSON|@FILE|-',
        description: 'Request body as JSON, a JSON file, or standard input',
      },
      list: {
        type: 'boolean',
        description: 'List routes (optionally of one group) instead of calling one',
      },
    },
    examples: [
      'better-compute api --list',
      'better-compute api system.version',
      'better-compute api system.selfCheck --query "findings[].check"',
      'better-compute api system.whoami --url https://compute.example.com',
      'better-compute api inventory.get tenantId=tenant-acme nodeId=node_01jz0000000000000000000000',
      'echo \'{"tenantId":"tenant-acme","widgetId":"w1"}\' | better-compute api plugins.acme.widgets.get --data -',
    ],
    async run(context) {
      const { flags, args } = context;
      const [route, ...items] = args;
      if (flags.list || !route) {
        if (items.length) throw usageError('api --list takes at most a group name');
        const prefix = route === undefined ? undefined : routePrefix(route);
        const source = await routeSource(context);
        try {
          const routes = listRoutes(source.compute).filter(
            (entry) => !prefix || entry.route.startsWith(`${prefix}/`),
          );
          if (prefix && !routes.length)
            throw new CliError(
              'NOT_FOUND',
              `No API group named ${route}`,
              'Run better-compute api --list for all groups.',
            );
          // A table by default: this is for reading; --format json gives tools the same rows.
          context.io.out(
            formatResult(
              routes.map((entry) => ({
                method: entry.route.replaceAll('/', '.'),
                access: entry.access,
                action: entry.action ?? '',
                http: `POST ${source.basePath}/${entry.route}`,
              })),
              (flags.format as OutputFormat | undefined) ?? 'table',
              flags.query,
            ),
          );
        } finally {
          await source.close?.();
        }
        return;
      }
      const path = routePath(route);
      const body = await requestBody(context, flags.data, items);
      // A public route carries the token only when one is set (system.whoami reports it). In
      // process the deployment's own registry decides; remotely, this release's route table does.
      const local = flags.url ? undefined : await context.compute();
      const method = local?.registry.method(path);
      const needsToken = local
        ? method !== undefined && method.kind !== 'public'
        : !isPublicRoute(path);
      const transport = await context.api({
        authenticated: needsToken || Boolean(context.env.BETTER_COMPUTE_TOKEN),
      });
      return transport.call(path, body);
    },
  }),
];

/** `system`, `plugins.acme` or `plugins/acme/widgets` as a route prefix. */
function routePrefix(group: string): string {
  const parts = (group.includes('/') ? group : group.replaceAll('.', '/')).split('/');
  if (!parts.every((part) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(part)))
    throw usageError(`${group} is not an API group like system or plugins.acme`);
  return parts.join('/');
}
