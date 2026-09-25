import { createServer, type AddressInfo, type Socket } from 'node:net';
import { connectTunnel, tunnelUrl } from '@better-compute/client';
import { CliError, RemoteExitError } from '../errors.js';
import { defineCommand, type CommandContext } from '../framework.js';
import { parseEndpoint } from '../transport.js';
import { tenantFlag } from './capacity.js';
import { stopSignal } from './serve.js';

// Interactive access from a terminal (PLAN.md §7.6, §13): `tunnels.open` as the token, then the
// tunnel's WebSocket on the same server, with the terminal in raw mode until the remote program
// exits. The process exits with the remote status, as ssh does. Ctrl-] detaches. `forward` listens
// locally instead and opens a `tcp` tunnel per connection, like ssh -L.

interface OpenedTunnel {
  tunnelId: string;
  nodeId: string;
  path: string;
}

/** Ctrl-]: ends the session from this side (telnet's escape; Ctrl-C belongs to the remote). */
const DETACH = 0x1d;
/** How long a hang-up waits for the node's exit status before the socket is closed from this side. */
const DETACH_GRACE_MS = 3_000;
/** At most this many forwarded connections (open or opening) at once; beyond it, connections are refused. */
const FORWARD_MAX_CONNECTIONS = 16;

/** The server's origin and API base path from --url; tunnels need a real server's WebSocket. */
export function tunnelEndpoint(context: CommandContext<any>): { origin: string; basePath: string } {
  const url = context.flags.url;
  if (!url)
    throw new CliError(
      'UNSUPPORTED',
      `${context.name} needs --url: tunnels run over the server's WebSocket, which an in-process call does not have`,
      'Pass --url (or set BETTER_COMPUTE_URL) to a running better-compute serve or dev.',
    );
  return parseEndpoint(url);
}

async function attach(
  context: CommandContext<any>,
  input: { tenantId: string; op: 'console' | 'exec'; nodeId?: string; instanceId?: string },
): Promise<void> {
  // Checked before the ticket is spent, so a bad --url fails without opening anything.
  const { origin, basePath } = tunnelEndpoint(context);
  const terminal = context.io.terminal;
  if (!terminal)
    throw new CliError('UNSUPPORTED', `${context.name} needs a terminal (CliIO.terminal)`);
  const opened = await (await context.api()).call<OpenedTunnel>('tunnels/open', input);
  const tunnel = connectTunnel({ url: tunnelUrl(origin, basePath, opened.path) });
  tunnel.onData((data, channel) => terminal.write(data, channel));
  try {
    await tunnel.ready;
  } catch (error) {
    throw new CliError(
      'UNAVAILABLE',
      `The tunnel to ${opened.nodeId} did not open: ${error instanceof Error ? error.message : String(error)}`,
      'Check that the node is connected (api nodes.get) and that the server relays tunnels (serve --roles api with tunnels configured).',
    );
  }
  context.note(`Connected to ${opened.nodeId} (tunnel ${opened.tunnelId}); Ctrl-] detaches.`);
  let detached = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  // The first Ctrl-] asks the node to end the program; if it does not answer within the grace period (a stuck
  // program, a node gone away), or on a second Ctrl-], the socket is closed from this side.
  const detach = () => {
    if (detached) return tunnel.terminate();
    detached = true;
    tunnel.close();
    grace = setTimeout(() => tunnel.terminate(), DETACH_GRACE_MS);
    grace.unref?.();
  };
  const restore = terminal.raw?.() ?? (() => undefined);
  const resize = () => {
    const size = terminal.size?.();
    if (size && size.rows > 0 && size.cols > 0) tunnel.resize(size.rows, size.cols);
  };
  resize();
  const stopResize = terminal.onResize?.(resize) ?? (() => undefined);
  const stopInput = terminal.onInput((data) => {
    const escape = data.indexOf(DETACH);
    if (escape < 0) return tunnel.write(data);
    if (escape > 0) tunnel.write(data.subarray(0, escape));
    detach();
  });
  context.io.signal?.addEventListener('abort', detach, { once: true });
  let exit: { exitCode: number; reason: string };
  try {
    exit = await tunnel.exited;
  } finally {
    if (grace) clearTimeout(grace);
    stopInput();
    stopResize();
    restore();
    context.io.signal?.removeEventListener('abort', detach);
  }
  if (detached) return context.note('Detached.');
  if (exit.exitCode !== 0) throw new RemoteExitError(exit.exitCode, exit.reason);
}

const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Listens on `listen` and forwards each accepted connection through its own `tcp` tunnel (a fresh ticket per
 * connection) to the instance's port, until the stop signal. Resolves once the listener is closed.
 */
async function forward(
  context: CommandContext<any>,
  input: { tenantId: string; instanceId: string; port: number },
  listen: { host: string; port: number },
): Promise<void> {
  const { origin, basePath } = tunnelEndpoint(context);
  // The token is resolved now, so a missing one fails before anything listens.
  const api = await context.api();
  const stop = stopSignal(context.io.signal);
  const sockets = new Set<Socket>();
  const tunnels = new Set<ReturnType<typeof connectTunnel>>();
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // Anything local can connect (other users, a web page's fetch to 127.0.0.1): each connection spends a
  // tunnels.open of YOUR identity, so connections are capped, a RATE_LIMITED answer pauses accepting for its
  // retryAfterMs, and refusals are noted at most every 5 s.
  let pausedUntil = 0;
  let lastNote = 0;
  const refuse = (socket: Socket, why: string) => {
    socket.destroy();
    const now = Date.now();
    if (now - lastNote >= 5_000) {
      lastNote = now;
      context.note(why);
    }
  };
  const server = createServer((socket) => {
    if (Date.now() < pausedUntil)
      return refuse(socket, 'Refusing connections while the server rate-limits tunnels for you.');
    if (sockets.size >= FORWARD_MAX_CONNECTIONS)
      return refuse(socket, `Refusing a connection: ${FORWARD_MAX_CONNECTIONS} are already forwarded.`);
    sockets.add(socket);
    socket.pause();
    let closed = false;
    let tunnel: ReturnType<typeof connectTunnel> | undefined;
    const hangUp = () => {
      if (closed) return;
      closed = true;
      if (!tunnel) return;
      tunnel.close();
      const opened = tunnel;
      setTimeout(() => opened.terminate(), DETACH_GRACE_MS).unref?.();
    };
    socket.on('close', () => {
      sockets.delete(socket);
      hangUp();
    });
    socket.on('error', hangUp);
    void (async () => {
      try {
        const opened = await api.call<OpenedTunnel>('tunnels/open', { ...input, op: 'tcp' });
        if (socket.destroyed) return;
        const current = connectTunnel({ url: tunnelUrl(origin, basePath, opened.path) });
        tunnel = current;
        tunnels.add(current);
        current.onData((data) => void (socket.destroyed || socket.write(data)));
        void current.exited.then(() => {
          tunnels.delete(current);
          closed = true;
          socket.end();
        });
        await current.ready;
      } catch (error) {
        const failure = error as { code?: string; details?: { retryAfterMs?: number } };
        if (failure.code === 'RATE_LIMITED')
          pausedUntil = Date.now() + Math.min(Math.max(failure.details?.retryAfterMs ?? 10_000, 1_000), 60_000);
        refuse(socket, `A connection could not be forwarded: ${describe(error)}`);
        return;
      }
      // The tunnel has no half-close: the client ending its side ends the connection.
      socket.on('data', (chunk: Buffer) => void (closed || tunnel!.write(new Uint8Array(chunk))));
      socket.on('end', hangUp);
      socket.resume();
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listen.port, listen.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    if (!loopback.has(listen.host))
      context.note(`Warning: ${listen.host} is not loopback; anyone who reaches it uses your access.`);
    context.note(
      `Forwarding ${shown}:${address.port} to ${input.instanceId} port ${input.port}; Ctrl-C stops.`,
    );
    if (!stop.signal.aborted)
      await new Promise<void>((resolve) => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
  } finally {
    stop.dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      // Nothing keeps the process alive after Ctrl-C: open tunnels close from this side at once.
      for (const tunnel of tunnels) tunnel.terminate();
    });
  }
}

const attachDescription =
  'The session runs over the server’s tunnel WebSocket, so it needs --url (or BETTER_COMPUTE_URL). The terminal is in raw mode until the remote program exits: every key, Ctrl-C included, goes to the remote, and Ctrl-] detaches. The command exits with the remote program’s status (255 when the tunnel breaks), like ssh. Tickets are single-use and the gateway and the node verify them again; revoking your session or the delegation closes the tunnel.';

export const tunnelCommands = [
  defineCommand({
    name: 'console',
    group: 'Access',
    summary: 'Open an interactive console on a node',
    description: `console opens a root console on one node through tunnels.open (compute:nodes:console on the node). ${attachDescription}`,
    target: 'token',
    output: 'text',
    flags: {
      tenant: tenantFlag,
      node: { type: 'string', value: 'ID', required: true, description: 'The node' },
    },
    examples: ['better-compute console --url https://compute.example.com --tenant org_acme --node node_01k5w…'],
    async run(context) {
      await attach(context, { tenantId: context.flags.tenant as string, op: 'console', nodeId: context.flags.node });
    },
  }),
  defineCommand({
    name: 'exec',
    group: 'Access',
    summary: 'Open an interactive shell in a running instance',
    description: `exec opens a shell in one running instance through tunnels.open (compute:instances:exec on the instance); its node's agent runs it. ${attachDescription}`,
    target: 'token',
    output: 'text',
    flags: {
      tenant: tenantFlag,
      instance: { type: 'string', value: 'ID', required: true, description: 'The instance' },
    },
    examples: ['better-compute exec --url https://compute.example.com --tenant org_acme --instance inst_01k5w…'],
    async run(context) {
      await attach(context, {
        tenantId: context.flags.tenant as string,
        op: 'exec',
        instanceId: context.flags.instance,
      });
    },
  }),
  defineCommand({
    name: 'forward',
    group: 'Access',
    summary: 'Forward a local port to a port of a running instance',
    description:
      'forward listens on --bind (default 127.0.0.1) at --local-port (default: the same as --port; 0 picks a free one) and forwards each connection to --port on the instance through its own tcp tunnel (tunnels.open, compute:instances:exec on the instance), like ssh -L. It runs until Ctrl-C. The tunnels run over the server’s WebSocket, so it needs --url (or BETTER_COMPUTE_URL). A connection is re-authorized like any tunnel: revoking your session or the delegation closes it. Binding anything but loopback lets whoever reaches that address use your access; even on loopback, other users of this machine and web pages open in your browser can reach the port, as with ssh -L. At most 16 connections are forwarded at once, and new ones are refused while the server rate-limits your tunnels.',
    target: 'token',
    output: 'text',
    flags: {
      tenant: tenantFlag,
      instance: { type: 'string', value: 'ID', required: true, description: 'The instance' },
      port: {
        type: 'integer',
        value: 'PORT',
        required: true,
        min: 1,
        max: 65535,
        description: 'The port on the instance',
      },
      'local-port': {
        type: 'integer',
        value: 'PORT',
        min: 0,
        max: 65535,
        description: 'The local port (default: --port; 0 picks a free one)',
      },
      bind: {
        type: 'string',
        value: 'HOST',
        default: '127.0.0.1',
        description: 'The local address to listen on',
      },
    },
    examples: [
      'better-compute forward --url https://compute.example.com --tenant org_acme --instance inst_01k5w… --port 5432',
      'better-compute forward --instance inst_01k5w… --port 8888 --local-port 0',
    ],
    async run(context) {
      const port = context.flags.port as number;
      await forward(
        context,
        { tenantId: context.flags.tenant as string, instanceId: context.flags.instance as string, port },
        { host: context.flags.bind ?? '127.0.0.1', port: context.flags['local-port'] ?? port },
      );
    },
  }),
];
