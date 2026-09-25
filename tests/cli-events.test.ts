import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// `events list` / `events watch` (PLAN.md §9.3). watch against a stubbed SSE stream (the request it makes, what it
// prints), then against the dev example's `GET /watch` with a node cordoned while it follows.

const env = {
  BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij',
  BETTER_COMPUTE_TENANT: 'org_acme',
};

function sse(blocks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(new TextEncoder().encode(block));
      // Left open, like a live stream: the command ends on --count.
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function wait<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 1800; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('events', () => {
  it('lists events through events.list', async () => {
    const bodies: unknown[] = [];
    await createCli().run(
      [
        'events',
        'list',
        '--type',
        'node.cordoned',
        '--limit',
        '5',
        '--url',
        'https://compute.test',
      ],
      {
        out() {},
        env,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          bodies.push({
            path: new URL(request.url).pathname,
            body: JSON.parse(await request.text()),
          });
          return Response.json({ data: { items: [] } });
        },
      },
    );
    expect(bodies).toEqual([
      {
        path: '/api/compute/events/list',
        body: { tenantId: 'org_acme', type: 'node.cordoned', limit: 5 },
      },
    ]);
  });

  it('follows the watch stream: one JSON line per event, terminal-safe, resumable', async () => {
    const requests: Request[] = [];
    const out: string[] = [];
    const io: CliIO = {
      out: (line) => out.push(line),
      env,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return sse([
          ': keep-alive\n\n',
          'id: 10.1\ndata: {"id":"evt_1","type":"node.cordoned","tenantId":"org_acme","subject":"node/n1","data":{"reason":"a\u009b2Jb"}}\n\n',
          'id: 10.2\ndata: {"id":"evt_2","type":"node.uncordoned","tenantId":"org_acme","subject":"node/n1"}\n\n',
        ]);
      },
    };
    await createCli().run(
      [
        'events',
        'watch',
        '--url',
        'https://compute.test',
        '--types',
        'node.*, reservation.placed',
        '--since',
        '9.4',
        '--count',
        '2',
      ],
      io,
    );
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe('/watch');
    expect(url.searchParams.get('types')).toBe('node.*,reservation.placed');
    expect(url.searchParams.get('tenantId')).toBe('org_acme');
    expect(requests[0]!.headers.get('last-event-id')).toBe('9.4');
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${env.BETTER_COMPUTE_TOKEN}`);
    expect(out).toHaveLength(2);
    // The C1 CSI is escaped, never written raw; the line stays JSON that parses back to the same event.
    expect(out[0]).not.toMatch(/[\u007f-\u009f]/);
    expect(out[0]).toContain('\\u009b');
    expect(JSON.parse(out[0]!)).toMatchObject({
      id: 'evt_1',
      sequence: '10.1',
      data: { reason: 'a\u009b2Jb' },
    });
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 'evt_2', sequence: '10.2' });
  });

  it('refuses what it cannot follow before connecting', async () => {
    const run = (argv: string[]) =>
      createCli()
        .run(['events', 'watch', ...argv], { out() {}, env, fetch: async () => sse([]) })
        .then(
          () => undefined,
          (error: { code?: string }) => error.code,
        );
    expect(await run([])).toBe('UNSUPPORTED');
    expect(await run(['--url', 'https://compute.test', '--types', 'Node;rm'])).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await run(['--url', 'https://compute.test', '--since', 'yesterday'])).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await run(['--url', 'https://compute.test', '--path', 'watch?x'])).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it(
    'follows the dev example’s /watch while a node is cordoned',
    { timeout: 180_000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'bc-events-'));
      const controller = new AbortController();
      const notes: string[] = [];
      const config = fileURLToPath(
        new URL('../examples/dev/better-compute.config.ts', import.meta.url),
      );
      const dev = createCli()
        .run(['dev', '--config', config, '--memory', '--sim', '1', '--port', '0'], {
          out() {},
          err: (line) => notes.push(line),
          env: {},
          cwd,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      const noted = (pattern: RegExp) =>
        wait(() => notes.find((line) => pattern.test(line)), `${pattern}: ${notes.join('\n')}`);
      try {
        const url = /listening on (\S+)/.exec(await noted(/listening on/))![1]!;
        const token = /root token \(dev only\): (\S+)/.exec(await noted(/root token/))![1]!;
        const tenant = /root tenant (\S+);/.exec(await noted(/root tenant/))![1]!;
        await noted(/1 simulated node\(s\) adopted/);
        const devEnv = {
          BETTER_COMPUTE_URL: url,
          BETTER_COMPUTE_TOKEN: token,
          BETTER_COMPUTE_TENANT: tenant,
        };
        const listed: string[] = [];
        await createCli().run(['nodes', 'list', '--format', 'json'], {
          out: (line) => listed.push(line),
          env: devEnv,
          cwd,
        });
        const nodeId = JSON.parse(listed.join('\n')).items[0].id as string;

        const lines: string[] = [];
        let connected = false;
        const watching = createCli().run(
          ['events', 'watch', '--types', 'node.cordoned', '--count', '1'],
          {
            out: (line) => lines.push(line),
            env: devEnv,
            cwd,
            fetch: async (input, init) => {
              const response = await fetch(input, init);
              connected = true;
              return response;
            },
          },
        );
        await wait(() => (connected ? true : undefined), 'the watch stream');
        await createCli().run(['nodes', 'cordon', nodeId, '--reason', 'watched'], {
          out() {},
          env: devEnv,
          cwd,
        });
        await watching;
        expect(lines).toHaveLength(1);
        const event = JSON.parse(lines[0]!);
        expect(event).toMatchObject({
          type: 'node.cordoned',
          subject: `node/${nodeId}`,
          tenantId: tenant,
        });
        // A real event's sequence is what --since takes (the stream's <txid>.<seq>).
        expect(event.sequence).toMatch(/^\d+\.\d+$/);
        const resumed: string[] = [];
        await createCli().run(
          ['events', 'watch', '--since', event.sequence, '--types', 'node.*', '--count', '1'],
          {
            out: (line) => resumed.push(line),
            env: devEnv,
            cwd,
            fetch: async (input, init) => {
              const response = await fetch(input, init);
              // Something newer than the resumed cursor, once the stream is open.
              void createCli().run(['nodes', 'uncordon', nodeId], { out() {}, env: devEnv, cwd });
              return response;
            },
          },
        );
        expect(JSON.parse(resumed[0]!)).toMatchObject({
          type: 'node.uncordoned',
          subject: `node/${nodeId}`,
        });
      } finally {
        controller.abort();
        const result = await dev;
        if (result) throw result;
      }
    },
  );
});
