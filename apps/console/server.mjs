import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { createStack } from './console.config.mjs';

// The console's server: Next.js for pages and the APIs, plus the one thing route handlers cannot do, the
// WebSocket upgrade of `GET /api/compute/tunnels/{ticket}` (browser terminals and node consoles), handled by
// better-compute's `handleTunnel` and relayed to the node's gateway.
//
//   node server.mjs --dev      development: next dev, CONSOLE_DEV=1 (generated local secrets and keys)
//   node server.mjs --prod     after `next build`; every secret comes from the environment
//
// PORT (default 3100) and HOSTNAME (default localhost) choose where it listens.

const dir = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');
if (dev === process.argv.includes('--prod')) {
  console.error('Usage: node server.mjs --dev | --prod');
  process.exit(2);
}
if (dev) process.env.CONSOLE_DEV ??= '1';
else process.env.NODE_ENV ??= 'production';
const port = Number(process.env.PORT ?? 3100);
const hostname = process.env.HOSTNAME ?? 'localhost';

// The same process-wide stack the pages use (`src/lib/stack-core.ts` reads this global).
globalThis.__betterComputeConsole ??= createStack();
const stack = await globalThis.__betterComputeConsole;
const { handleTunnel } = await import('better-compute/server');

const app = next({ dev, dir, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

const server = createServer((req, res) => void handle(req, res));
server.on('upgrade', (req, socket, head) => {
  void (async () => {
    // handleTunnel answers every tunnel path itself (never rejects) and returns false for anything else.
    if (stack.tunnels && (await handleTunnel(req, socket, head, stack.tunnels))) return;
    await upgrade(req, socket, head);
  })().catch(() => socket.destroy());
});
server.listen(port, hostname, () => {
  console.info(
    `[console] http://${hostname}:${port} (${dev ? 'development' : 'production'}; tunnels ${stack.tunnels ? 'on' : 'off'})`,
  );
});

const shutdown = async () => {
  server.close();
  stack.tunnels?.relay.close();
  await stack.compute.stop?.();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
