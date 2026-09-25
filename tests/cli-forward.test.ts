import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';
import { handleTunnel } from '@better-compute/server';
import { createDevStack, fakeIam, type DevStack, type TunnelProgramFactory } from '@better-compute/testing';

// `better-compute forward` (PLAN.md §7.6 `tcp` tunnels, like ssh -L): a local listener, one tunnels.open per
// connection, bytes both ways over the tunnel WebSocket, through the dev stack's gateway to a FakeDaemon whose
// tcp program stands in for the instance's port (it answers each chunk upper-cased).

const INSTANCE = 'inst_01k5w000000000000000000fwd';
const TOKEN = 'biam_ses_forward_test';
const ROOT = 'tenant-root';

/** The instance's port: echoes upper-cased, and remembers which port each tunnel asked for. */
const ports: number[] = [];
const upperEcho: TunnelProgramFactory = (context) => {
  ports.push(context.claims.port ?? 0);
  return {
    data: (bytes) => context.write(new TextDecoder().decode(bytes).toUpperCase()),
    hangup: () => context.exit(0, 'closed'),
  };
};

let stack: DevStack | undefined;
let host: Server | undefined;
afterEach(async () => {
  host?.close();
  host = undefined;
  await stack?.close();
  stack = undefined;
});

async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One TCP exchange through the forward: send `text`, read until `expected` arrives. */
async function exchange(port: number, text: string, expected: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (chunk) => (received += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(text);
  await waitFor(() => (received.includes(expected) ? true : undefined), `${expected} (got ${received})`);
  socket.destroy();
  return received;
}

describe('forward', () => {
  it('forwards each local connection through its own tcp tunnel to the instance', { timeout: 120_000 }, async () => {
    const iam = fakeIam({
      callers: {
        [TOKEN]: {
          identityId: 'idn_ops',
          identityKind: 'user',
          tenantId: ROOT,
          sessionId: 'ses_ops',
          sessionKind: 'user',
          mfa: true,
        },
      },
      allow: [{}],
    });
    stack = await createDevStack({
      iam: { port: iam, rootTenantId: ROOT, root: { token: TOKEN } },
      daemon: { tunnels: { program: upperEcho } },
    });
    const { poolId } = await stack.createPool();
    const [nodeId] = await stack.join({ poolId, seed: 'forward' });
    await stack.waitFor([nodeId!], { timeoutMs: 60_000 });
    // A running instance on the node (the vps module's table, reduced to what tunnels.open reads).
    const sql = stack.database;
    await sql.query(`CREATE TABLE IF NOT EXISTS instances (id text PRIMARY KEY, tenant_id text NOT NULL,
                       node_id text, state text NOT NULL, draft bool NOT NULL DEFAULT false)`);
    await sql.query(`INSERT INTO instances (id, tenant_id, node_id, state) VALUES ($1, $2, $3, 'running')`, [
      INSTANCE,
      stack.rootTenantId,
      nodeId,
    ]);
    await sql.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('instance', $1, $2, '{}')
       ON CONFLICT DO NOTHING`,
      [INSTANCE, stack.rootTenantId],
    );

    // The api host: HTTP by the control plane, tunnel upgrades relayed to the fleet's gateway.
    const compute = stack.compute;
    const relay = stack.tunnelRelay!;
    host = createServer((req, res) => void compute.nodeHandler(req, res));
    host.on('upgrade', (req, socket, head) => {
      void handleTunnel(req, socket, head, {
        sql: sql as never,
        issuer: stack!.tunnelIssuer,
        issuerName: compute.endpoint.origin,
        relay: relay as never,
        authorize: async () => true,
        basePath: compute.endpoint.basePath,
      }).then((handled) => {
        if (!handled) socket.destroy();
      });
    });
    await new Promise<void>((resolve) => host!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(host.address() as AddressInfo).port}${compute.endpoint.basePath}`;

    const controller = new AbortController();
    const notes: string[] = [];
    const running = createCli().run(
      ['forward', '--instance', INSTANCE, '--port', '5432', '--local-port', '0'],
      {
        out() {},
        err: (line) => notes.push(line),
        env: { BETTER_COMPUTE_URL: url, BETTER_COMPUTE_TOKEN: TOKEN, BETTER_COMPUTE_TENANT: stack.rootTenantId },
        cwd: process.cwd(),
        signal: controller.signal,
      },
    );
    let failure: unknown;
    running.catch((error) => (failure = error));
    const note = await waitFor(
      () => (failure ? `failed: ${String(failure)}` : notes.find((line) => line.startsWith('Forwarding'))),
      'the listener',
    );
    const port = Number(/127\.0\.0\.1:(\d+) to/.exec(note)?.[1]);
    expect(port).toBeGreaterThan(0);
    expect(note).toContain(`to ${INSTANCE} port 5432`);

    // Two connections at once, each its own tunnel.
    const [a, b] = await Promise.all([exchange(port, 'hello', 'HELLO'), exchange(port, 'world', 'WORLD')]).catch(
      (error: Error) => {
        throw new Error(`${error.message}; notes: ${notes.join(' | ')}`);
      },
    );
    expect(a).toBe('HELLO');
    expect(b).toBe('WORLD');
    expect(ports.slice(-2)).toEqual([5432, 5432]);

    controller.abort();
    await running;
    // The listener is gone.
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', reject);
      }),
    ).rejects.toThrow();
  });
});
