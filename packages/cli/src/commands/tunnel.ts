import { connectTunnel, tunnelUrl } from '@better-compute/client';
import { CliError, RemoteExitError } from '../errors.js';
import { defineCommand, type CommandContext } from '../framework.js';
import { parseEndpoint } from '../transport.js';
import { tenantFlag } from './capacity.js';

// Interactive access from a terminal (PLAN.md §7.6, §13): `tunnels.open` as the token, then the
// tunnel's WebSocket on the same server, with the terminal in raw mode until the remote program
// exits. The process exits with the remote status, as ssh does. Ctrl-] detaches.

interface OpenedTunnel {
  tunnelId: string;
  nodeId: string;
  path: string;
}

/** Ctrl-]: ends the session from this side (telnet's escape; Ctrl-C belongs to the remote). */
const DETACH = 0x1d;

async function attach(
  context: CommandContext<any>,
  input: { tenantId: string; op: 'console' | 'exec'; nodeId?: string; instanceId?: string },
): Promise<void> {
  const url = context.flags.url;
  if (!url)
    throw new CliError(
      'UNSUPPORTED',
      `${context.name} needs --url: tunnels run over the server's WebSocket, which an in-process call does not have`,
      'Pass --url (or set BETTER_COMPUTE_URL) to a running better-compute serve or dev.',
    );
  const terminal = context.io.terminal;
  if (!terminal)
    throw new CliError('UNSUPPORTED', `${context.name} needs a terminal (CliIO.terminal)`);
  // Checked before the ticket is spent, so a bad --url fails without opening anything.
  const { origin, basePath } = parseEndpoint(url);
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
  const detach = () => {
    detached = true;
    tunnel.close();
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
    stopInput();
    stopResize();
    restore();
    context.io.signal?.removeEventListener('abort', detach);
  }
  if (detached) return context.note('Detached.');
  if (exit.exitCode !== 0) throw new RemoteExitError(exit.exitCode, exit.reason);
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
];
