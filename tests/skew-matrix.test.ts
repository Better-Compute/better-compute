import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  ConditionStatus,
  NodeSpecSchema,
  negotiateProtocolVersion,
  PROTOCOL_VERSION,
  SectionState,
  type ProtocolRange,
} from '@better-compute/protocol';
import {
  belowMinimumProfile,
  createDaemonHarness,
  createDevStack,
  daemonSkewProfiles,
  type DaemonProfile,
  type DevStack,
} from '@better-compute/testing';
import { vps } from '@better-compute/vps';

// The version-skew matrix (PLAN.md §7.6; N−2 daemons from v1.0). Each row runs a real control plane
// and gateway (the dev stack) at a protocol range, and joins one FakeDaemon built like an older bcd
// (`daemonSkewProfiles`). A daemon inside the window is welcomed at the highest shared version,
// adopted, and keeps working; what it lacks fails the way §7.6 says (unknown kinds UNSUPPORTED). One
// below the server's proto_min gets upgrade_required: no spec, and nothing but daemon.upgrade.
// A release adds a row to `daemonSkewProfiles` (and, when the protocol moves, a server below).

interface Server {
  name: string;
  protocol: ProtocolRange;
}
const thisBuild: Server = { name: `this build (${PROTOCOL_VERSION.min}..${PROTOCOL_VERSION.max})`, protocol: PROTOCOL_VERSION };
const newer: Server = { name: 'a newer server still speaking 1 (1..3)', protocol: { min: 1, max: 3 } };
const droppedOne: Server = { name: 'a server that dropped 1 (2..3)', protocol: { min: 2, max: 3 } };

const n2 = daemonSkewProfiles.at(-1)!;
const rows: { server: Server; daemon: DaemonProfile }[] = [
  ...daemonSkewProfiles.map((daemon) => ({ server: thisBuild, daemon })),
  { server: thisBuild, daemon: belowMinimumProfile },
  { server: newer, daemon: n2 },
  { server: droppedOne, daemon: daemonSkewProfiles[0]! },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function enqueue(stack: DevStack, nodeId: string, kind: string, payload: unknown, key: string): Promise<string> {
  const { id } = await stack.database.transaction((tx) =>
    stack.compute.context.commands.enqueue(tx, { nodeId, kind, payload, idempotencyKey: key, notAfter: Date.now() + 60_000 }),
  );
  stack.gateway.poke();
  return id;
}

async function settled(stack: DevStack, id: string, timeoutMs = 15_000): Promise<{ state: string; reason: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await stack.database.query<{ state: string; reason: string | null }>('SELECT state, reason FROM commands WHERE id = $1', [id]);
    const row = rows[0]!;
    if (['succeeded', 'failed', 'rejected', 'expired', 'cancelled'].includes(row.state) || Date.now() > deadline) return row;
    await sleep(50);
  }
}

describe('version skew (§7.6)', () => {
  for (const { server, daemon } of rows) {
    const version = negotiateProtocolVersion(daemon.protocol, server.protocol);
    const title = `${daemon.name} daemon against ${server.name}: ${version === undefined ? 'upgrade_required' : `welcomed at ${version}`}`;
    it(title, { timeout: 90_000 }, async () => {
      const stack = await createDevStack({ modules: [vps()], gateway: { protocol: server.protocol }, daemon: { profile: daemon } });
      try {
        const { poolId } = await stack.createPool();
        const [nodeId] = await stack.join({ poolId, count: 1, seed: `skew-${daemon.daemonVersion}` });
        const node = nodeId!;

        if (version === undefined) {
          // Below proto_min: welcomed only to upgrade. No desired state, and ordinary work waits.
          const deadline = Date.now() + 15_000;
          while (!stack.gateway.sessions().some((s) => s.nodeId === node) && Date.now() < deadline) await sleep(50);
          expect(stack.gateway.sessions().find((s) => s.nodeId === node)).toMatchObject({ upgradeRequired: true });
          const refresh = await enqueue(stack, node, 'inventory.refresh', { sections: ['gpus'] }, 'skew-refresh');
          await sleep(1_500);
          expect((await settled(stack, refresh, 0)).state).toBe('pending');
          const { rows: gen } = await stack.database.query<{ observed_generation: number }>('SELECT observed_generation FROM nodes WHERE id = $1', [node]);
          expect(Number(gen[0]!.observed_generation)).toBe(0);
          return;
        }

        // Inside the window: adopted and converged like any node.
        await stack.waitFor([node], { timeoutMs: 45_000 });
        expect(stack.gateway.sessions().find((s) => s.nodeId === node)).toMatchObject({ upgradeRequired: false });
        const { rows: sessions } = await stack.database.query<{ daemon_version: string; proto_max: number; capabilities: string[]; trust_version: number }>(
          'SELECT daemon_version, proto_max, capabilities, trust_version FROM node_sessions WHERE node_id = $1',
          [node],
        );
        expect(sessions[0]).toMatchObject({ daemon_version: daemon.daemonVersion, proto_max: daemon.protocol.max });
        if (daemon.capabilities) expect([...sessions[0]!.capabilities].sort()).toEqual([...daemon.capabilities].sort());
        if (daemon.withoutHello?.includes('trustVersion')) expect(Number(sessions[0]!.trust_version)).toBe(0);

        // What every supported build runs still works...
        const refresh = await enqueue(stack, node, 'inventory.refresh', { sections: ['gpus'] }, 'skew-refresh');
        expect(await settled(stack, refresh)).toMatchObject({ state: 'succeeded' });
        // ...and a kind this build predates is refused UNSUPPORTED, not lost or retried forever.
        for (const kind of daemon.withoutKinds ?? []) {
          expect(stack.compute.registry.commandKind(kind), `${kind} is registered here`).toBeDefined();
          const id = await enqueue(stack, node, kind, {}, `skew-${kind}`);
          expect(await settled(stack, id), kind).toMatchObject({ state: 'rejected', reason: 'unsupported' });
        }
        // Inventory sections it never collects are simply absent.
        if (daemon.withoutInventory?.length) {
          const { rows: stored } = await stack.database.query<{ section: string }>(
            'SELECT section FROM node_inventory_sections WHERE node_id = $1',
            [node],
          );
          for (const section of daemon.withoutInventory) expect(stored.map((row) => row.section)).not.toContain(section);
        }
      } finally {
        await stack.close();
      }
    });
  }

  it('a profile reports the sections it predates SectionUnsupported, and leaves out its missing Hello fields and kinds', async () => {
    const h = createDaemonHarness({
      nodeId: 'node_skew',
      profile: n2,
      selfUpdate: {},
      intent: { roots: [], version: 7n },
    });
    await h.advance(10);
    const hello = h.server.of('hello')[0]!;
    expect(hello).toMatchObject({ daemonVersion: n2.daemonVersion, protoMax: n2.protocol.max, trustVersion: 0n });
    expect([...hello.capabilities].sort()).toEqual([...n2.capabilities!].sort());
    // The current build would converge `daemon` (self-update); this one predates it.
    h.sendSpec(1, create(NodeSpecSchema, { daemon: { version: '0.5.0', url: 'https://downloads.example/bcd', sha256: new Uint8Array(32) } }));
    await h.advance(5);
    const status = h.server.of('status').at(-1)!;
    expect(status.sections.find((s) => s.section === 'daemon')).toMatchObject({ state: SectionState.UNSUPPORTED, reason: 'SectionUnsupported' });
    expect(status.conditions.map((c) => [c.type, c.status])).toContainEqual(['SectionUnsupported', ConditionStatus.TRUE]);
    // The same daemon without a profile converges it (the default stays the current build).
    const current = createDaemonHarness({ nodeId: 'node_now', selfUpdate: {} });
    await current.advance(10);
    current.sendSpec(1, create(NodeSpecSchema, { daemon: { version: '0.5.0', url: 'https://downloads.example/bcd', sha256: new Uint8Array(32) } }));
    await current.advance(5);
    expect(current.server.of('status').at(-1)!.sections.find((s) => s.section === 'daemon')?.state).not.toBe(SectionState.UNSUPPORTED);
  });

  it('keeps the window N−2 wide: three supported lines, newest first, one protocol range each', () => {
    expect(daemonSkewProfiles).toHaveLength(3);
    for (const profile of daemonSkewProfiles) expect(negotiateProtocolVersion(profile.protocol)).toBeDefined();
    expect(negotiateProtocolVersion(belowMinimumProfile.protocol)).toBeUndefined();
    const versions = daemonSkewProfiles.map((profile) => profile.daemonVersion);
    expect(versions).toEqual([...versions].sort().reverse());
  });
});
