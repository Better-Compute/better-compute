// The gateway side of a split gateway-streams run (`BENCH_GW_SPLIT=1`): this process owns the store
// and the gateway, so its RSS and event-loop delay are the gateway's alone; the bench process is the
// load generator and drives it over IPC. Needs built packages (tsc -b packages/gateway packages/postgres).
//
//   parent → { type: 'start', sessions, heartbeatMs, postgresUrl?, ids, siteId, tenantId, tls? }
//   parent → { type: 'enqueue', id: <request>, nodeId, notAfterMs }   → { type: 'enqueued', id, commandId, t0 }
//   parent → { type: 'measure', on }                                  → samples while on
//   parent → { type: 'takeover' }  (a fresh gateway)                  → { type: 'takeover-ready', port }
//   parent → { type: 'kill-old' }  (the previous one's transport dies) → { type: 'killed' }
//   parent → { type: 'sessions', id }                                 → { type: 'sessions', id, count }
//   parent → { type: 'query', id, sql }                               → { type: 'rows', id, rows }
//   parent → { type: 'stop' }                                         → { type: 'stopped', memory, loop }
//   child  → { type: 'ready', port } after start; { type: 'error', message } on failure

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (pkg, entry = 'index.js') => import(pathToFileURL(join(root, 'packages', pkg, 'dist', entry)).href);

const core = await load('core');
const { createGateway, serveGateway } = await load('gateway');
const { postgres } = await load('postgres');
const { pglite } = await load('postgres', 'pglite.js');
const protocol = await load('protocol');
const { create } = await import(
  pathToFileURL(join(root, 'packages', 'protocol', 'node_modules', '@bufbuild', 'protobuf', 'dist', 'esm', 'index.js')).href
);
const { timestampFromMs } = await import(
  pathToFileURL(join(root, 'packages', 'protocol', 'node_modules', '@bufbuild', 'protobuf', 'dist', 'esm', 'wkt', 'index.js')).href
);

const now = () => performance.timeOrigin + performance.now();
const send = (message) => process.send?.(message);
const services = {
  join: () => Promise.reject(new core.ComputeError('NOT_IMPLEMENTED', 'bench')),
  renew: () => Promise.reject(new core.ComputeError('NOT_IMPLEMENTED', 'bench')),
  secret: () => Promise.reject(new core.ComputeError('NOT_IMPLEMENTED', 'bench')),
};

let db;
let config;
let current;
const retired = [];
const loop = monitorEventLoopDelay({ resolution: 10 });
// `arrayBuffers` holds WebAssembly memory (PGlite's database lives there), apart from the JS heap.
const memory = { rss: [], heap: [], arrayBuffers: [] };
let sampler;

async function seed(ids) {
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'bench', 1)
     ON CONFLICT (id) DO NOTHING`,
    [config.siteId, config.tenantId],
  );
  for (let i = 0; i < ids.length; i += 1_000) {
    const chunk = ids.slice(i, i + 1_000);
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
         connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT v.id, $2, $3, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, v.shard, 1
       FROM unnest($1::text[], $4::smallint[]) AS v(id, shard)`,
      [chunk, config.siteId, config.tenantId, chunk.map(core.shardOf)],
    );
    await db.query('INSERT INTO node_sessions (node_id, session_epoch) SELECT unnest($1::text[]), 0', [chunk]);
  }
}

async function startGateway() {
  const gateway = createGateway({
    region: 'bench',
    database: db,
    services,
    maxStreams: config.sessions + 100,
    heartbeatIntervalMs: config.heartbeatMs,
  });
  await gateway.start();
  const tls = config.tls;
  const served = await serveGateway(
    gateway,
    tls
      ? {
          host: '127.0.0.1',
          tls: { key: tls.key, cert: tls.cert, ca: tls.caPem, minVersion: 'TLSv1.3' },
          nodeRoots: [Buffer.from(tls.nodeCaDer, 'base64')],
          trustDomain: tls.trustDomain,
        }
      : {
          insecure: true,
          authenticate: (peer) => {
            const nodeId = peer.headers['x-bench-node'];
            return typeof nodeId === 'string' ? { nodeId, role: 'node' } : undefined;
          },
        },
  );
  return { gateway, served };
}

async function enqueue(nodeId, notAfterMs) {
  const id = core.newId('cmd');
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      'UPDATE nodes SET next_cmd_seq = next_cmd_seq + 1 WHERE id = $1 RETURNING next_cmd_seq - 1 AS seq',
      [nodeId],
    );
    const seq = Number(rows[0].seq);
    const body = protocol.encodeMessage(
      protocol.CommandBodySchema,
      create(protocol.CommandBodySchema, {
        id,
        nodeId,
        seq: BigInt(seq),
        kind: 'diag.nvml',
        lane: protocol.Lane.CONTROL,
        notAfter: timestampFromMs(notAfterMs),
        retrySafe: true,
        idempotencyKey: id,
      }),
    );
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating,
         attested, idempotency_key)
       VALUES ($1, $2, $3, 'diag.nvml', $4, 'pending', $5, true, false, true, $1)`,
      [id, nodeId, seq, Buffer.from(body), new Date(notAfterMs)],
    );
  });
  return id;
}

const handlers = {
  async start(message) {
    config = message;
    db = message.postgresUrl ? postgres({ url: message.postgresUrl }) : pglite();
    await db.migrate();
    await seed(message.ids);
    current = await startGateway();
    send({ type: 'ready', port: current.served.port });
  },
  async enqueue(message) {
    const commandId = await enqueue(message.nodeId, message.notAfterMs);
    const t0 = now();
    current.gateway.poke();
    send({ type: 'enqueued', id: message.id, commandId, t0 });
  },
  async measure(message) {
    if (message.on) {
      loop.reset();
      loop.enable();
      sampler = setInterval(() => {
        const usage = process.memoryUsage();
        memory.rss.push(usage.rss);
        memory.heap.push(usage.heapUsed);
        memory.arrayBuffers.push(usage.arrayBuffers);
      }, 1_000);
    } else {
      loop.disable();
      clearInterval(sampler);
    }
  },
  async sessions(message) {
    send({ type: 'sessions', id: message.id, count: current.gateway.sessions().length });
  },
  async takeover() {
    retired.push(current);
    current = await startGateway();
    send({ type: 'takeover-ready', port: current.served.port });
  },
  async 'kill-old'() {
    const old = retired.at(-1);
    await old.served.close(0);
    await old.gateway.stop();
    send({ type: 'killed' });
  },
  async query(message) {
    const { rows } = await db.query(message.sql, message.params ?? []);
    send({ type: 'rows', id: message.id, rows });
  },
  async stop() {
    const result = {
      memory: {
        rssMax: Math.max(0, ...memory.rss),
        rssLast: memory.rss.at(-1) ?? 0,
        heapMax: Math.max(0, ...memory.heap),
        arrayBuffersFirst: memory.arrayBuffers[0] ?? 0,
        arrayBuffersMax: Math.max(0, ...memory.arrayBuffers),
        rssFirst: memory.rss[0] ?? 0,
      },
      loop: { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    };
    await current.gateway.stop().catch(() => {});
    await current.served.close(500).catch(() => {});
    await db.close().catch(() => {});
    send({ type: 'stopped', ...result });
    setTimeout(() => process.exit(0), 100);
  },
};

process.on('message', (message) => {
  const handler = handlers[message?.type];
  if (!handler) return;
  handler(message).catch((error) => send({ type: 'error', message: String(error?.stack ?? error) }));
});
send({ type: 'loaded' });
