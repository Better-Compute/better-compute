import { createComputeClient } from '@better-compute/client';
import { CliError, usageError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { parseEndpoint } from '../transport.js';
import { tenantFlag } from './capacity.js';
import { stopSignal } from './serve.js';

// The tenant's events (PLAN.md §9.3): `events list` pages through them (events.list), `events watch` follows the
// host's server-sent events route as they commit, one JSON line each, resuming after reconnects. Both are decided
// as compute:events:read on the tenant.

const typePattern = /^[a-z*][a-z0-9.*-]{0,127}$/;

/**
 * The event as one line of JSON that is safe on a terminal: JSON escapes C0 controls but not DEL, C1 (a CSI in a
 * label or a reason would reach the terminal) or the line and paragraph separators; those are escaped too.
 */
export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, escape).replace(/[\u2028\u2029]/g, escape);
}

function escape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

export const eventCommands = [
  defineCommand({
    name: 'events list',
    group: 'Events',
    summary: 'List the tenant’s events, newest first (events.list)',
    target: 'token',
    flags: {
      tenant: tenantFlag,
      type: { type: 'string', value: 'TYPE', description: 'Only events of this type (node.cordoned, reservation.placed, …)' },
      limit: { type: 'integer', value: 'N', min: 1, max: 500, description: 'Page size (at most 500)' },
      cursor: { type: 'string', value: 'CURSOR', description: 'The cursor of the previous page' },
    },
    examples: ['better-compute events list --type node.draining', 'better-compute events list --query "items[*].type"'],
    async run({ flags, api }) {
      return (await api()).call('events/list', {
        tenantId: flags.tenant,
        ...(flags.type ? { type: flags.type } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
        ...(flags.cursor ? { cursor: flags.cursor } : {}),
      });
    },
  }),
  defineCommand({
    name: 'events watch',
    group: 'Events',
    summary: 'Follow the tenant’s events as they happen, one JSON line each (GET /watch)',
    description:
      "events watch follows the host's server-sent events route (--path, default /watch; the console app serves /api/compute/watch) as BETTER_COMPUTE_TOKEN, so it needs --url. Each event is printed as one line of JSON with its `sequence`, the cursor: pass the last one to --since to resume where a previous run stopped. It reconnects after a broken connection, resuming from the last event, until Ctrl-C, --count events, or a refusal: a revoked session or a withdrawn compute:events:read ends it.",
    target: 'token',
    output: 'text',
    flags: {
      tenant: tenantFlag,
      types: {
        type: 'string',
        value: 'PATTERN,…',
        description: 'Event type patterns, comma-separated (node.*, reservation.placed); default all',
      },
      since: { type: 'string', value: 'CURSOR', description: 'Resume after this event (a printed sequence)' },
      count: { type: 'integer', value: 'N', min: 1, description: 'Stop after N events' },
      path: { type: 'string', value: 'PATH', default: '/watch', description: 'The watch route on the server' },
    },
    examples: [
      'better-compute events watch --url https://compute.example.com --types "node.*,reservation.*"',
      'better-compute events watch --url https://compute.example.com --since 184467.12 --count 100',
    ],
    async run(context) {
      const { flags, io } = context;
      if (!flags.url)
        throw new CliError(
          'UNSUPPORTED',
          'events watch needs --url: it follows a running server’s event stream',
          'Pass --url (or set BETTER_COMPUTE_URL) to a running better-compute serve or dev.',
        );
      const { origin } = parseEndpoint(flags.url);
      const types = (flags.types ?? '')
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean);
      if (types.length > 20 || types.some((type) => !typePattern.test(type)))
        throw usageError('--types takes up to 20 event type patterns like node.* or reservation.placed');
      // The outbox cursor as the stream writes it (<txid>.<seq>; events.list pages use their own <ms>:<seq>).
      if (flags.since !== undefined && !/^\d{1,20}\.\d{1,20}$/.test(flags.since))
        throw usageError('--since takes a printed sequence, like 184467.12');
      const path = flags.path ?? '/watch';
      if (!/^(?:\/[A-Za-z0-9_.-]+)+$/.test(path)) throw usageError('--path must be an absolute path like /watch');
      const client = createComputeClient<{ api: unknown }>({
        baseURL: origin,
        token: await context.token(),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      });
      const stop = stopSignal(io.signal);
      let seen = 0;
      try {
        for await (const event of client.$watch({
          path,
          tenantId: flags.tenant,
          ...(types.length ? { types } : {}),
          ...(flags.since ? { lastEventId: flags.since } : {}),
          signal: stop.signal,
        })) {
          // JSON escapes C0 controls but not DEL and C1 (a CSI in a label or reason would reach the terminal).
          io.out(terminalSafeJson(event));
          seen += 1;
          if (flags.count !== undefined && seen >= flags.count) break;
        }
      } finally {
        stop.dispose();
      }
    },
  }),
];
