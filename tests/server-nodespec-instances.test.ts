import { describe, expect, it } from 'vitest';
import { fromJson } from '@bufbuild/protobuf';
import type { InstanceSpec, SqlTx } from '@better-compute/core';
import { Binding, InstanceNetworkPolicy, NodeSpecSchema } from '@better-compute/protocol';
import { specHash, wireNodeSpec } from '../packages/server/src/controllers/nodespec.js';

// The instances section on the wire (v0.5 sandboxes §3.7): restore_from and network_policy decode
// as the daemon reads them, and a spec that sets neither hashes as before.

const tx = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as SqlTx;

const instance = (extra: Partial<InstanceSpec> = {}): InstanceSpec => ({
  id: 'inst_a',
  desiredState: 'running',
  runtime: 'cloud-hypervisor',
  flavor: { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
  image: { url: 'https://images.example/u.raw', sha256: 'ab'.repeat(32), format: 'raw' },
  ...extra,
});

describe('NodeSpec instances section (v0.5)', () => {
  it('carries restore_from and a non-default network policy; egress is the wire default', async () => {
    const wire = await wireNodeSpec(tx, {
      instances: [
        instance({
          desiredState: 'paused',
          restoreFrom: {
            url: 'https://objects.example/snap',
            sha256: 'cd'.repeat(32),
            imageId: 'snap_1',
          },
          networkPolicy: 'none',
        }),
      ],
    });
    const spec = fromJson(NodeSpecSchema, wire as never);
    const decoded = spec.instances!.instances[0]!;
    expect(decoded.networkPolicy).toBe(InstanceNetworkPolicy.NONE);
    expect(decoded.restoreFrom).toMatchObject({
      ref: 'snap_1',
      url: 'https://objects.example/snap',
    });
    expect(Buffer.from(decoded.restoreFrom!.sha256).toString('hex')).toBe('cd'.repeat(32));

    const plain = await wireNodeSpec(tx, { instances: [instance()] });
    const egress = await wireNodeSpec(tx, { instances: [instance({ networkPolicy: 'egress' })] });
    expect(specHash(egress)).toBe(specHash(plain));
    expect(fromJson(NodeSpecSchema, plain as never).instances!.instances[0]!.networkPolicy).toBe(
      InstanceNetworkPolicy.UNSPECIFIED,
    );
  });

  it('carries the post-restore identity rebind and host-only SSH, only when set (review 13)', async () => {
    const wire = await wireNodeSpec(tx, {
      instances: [instance({ identityRebindRef: 'secret://vps/rebind/inst_a/1', sshFromHostOnly: true })],
    });
    expect(fromJson(NodeSpecSchema, wire as never).instances!.instances[0]).toMatchObject({
      identityRebindRef: 'secret://vps/rebind/inst_a/1',
      sshFromHostOnly: true,
    });
    const plain = await wireNodeSpec(tx, { instances: [instance()] });
    expect(specHash(await wireNodeSpec(tx, { instances: [instance({ sshFromHostOnly: false })] }))).toBe(
      specHash(plain),
    );
  });

  it('carries a NIC’s gateway and nameservers for the guest’s network-config (v1.1)', async () => {
    const nic = { network: 'br0', mac: '02:00:00:00:00:01', addresses: ['10.0.0.2/24'] };
    const wire = await wireNodeSpec(tx, {
      instances: [instance({ nics: [{ ...nic, gateway: '10.0.0.1', nameservers: ['1.1.1.1'] }] })],
    });
    expect(fromJson(NodeSpecSchema, wire as never).instances!.instances[0]!.nics[0]).toMatchObject({
      gateway: '10.0.0.1',
      nameservers: ['1.1.1.1'],
    });
    // Unset: hashes as before.
    const bare = await wireNodeSpec(tx, { instances: [instance({ nics: [nic] })] });
    expect(specHash(await wireNodeSpec(tx, { instances: [instance({ nics: [{ ...nic, nameservers: [] }] })] }))).toBe(
      specHash(bare),
    );
  });
});

describe('NodeSpec persistent volumes (v1.1, agent memory)', () => {
  it('lists the host’s volumes sorted and each instance’s attachments in order', async () => {
    const wire = await wireNodeSpec(tx, {
      volumes: [
        { id: 'vol_b', sizeBytes: 20 * 2 ** 30, serial: 'bcv-b' },
        { id: 'vol_a', sizeBytes: 10 * 2 ** 30, serial: 'bcv-a' },
      ],
      instances: [
        instance({ volumes: [{ volumeId: 'vol_b' }, { volumeId: 'vol_a', readOnly: true }] }),
      ],
    });
    const decoded = fromJson(NodeSpecSchema, wire as never).instances!;
    expect(decoded.volumes.map((volume) => [volume.volumeId, volume.sizeBytes, volume.serial])).toEqual([
      ['vol_a', 10n * 2n ** 30n, 'bcv-a'],
      ['vol_b', 20n * 2n ** 30n, 'bcv-b'],
    ]);
    expect(decoded.instances[0]!.volumes.map((volume) => [volume.volumeId, volume.readOnly])).toEqual([
      ['vol_b', false],
      ['vol_a', true],
    ]);
    // A host with volumes and no instances still gets the section (bcd keeps them).
    const only = await wireNodeSpec(tx, { volumes: [{ id: 'vol_a', sizeBytes: 2 ** 30, serial: 'bcv-a' }] });
    expect(fromJson(NodeSpecSchema, only as never).instances!.volumes).toHaveLength(1);
  });
});

describe('NodeSpec telemetry (v1.1)', () => {
  it('carries the headers ref and sorted resource attributes', async () => {
    const wire = await wireNodeSpec(tx, {
      telemetry: {
        otlpEndpoint: 'https://otel.example:4318',
        intervalSeconds: 15,
        headersRef: 'secret://otel/headers',
        resourceAttributes: { 'site.region': 'eu', 'deployment.environment': 'prod' },
      },
    });
    expect(fromJson(NodeSpecSchema, wire as never).telemetry).toMatchObject({
      otlpEndpoint: 'https://otel.example:4318',
      exportIntervalMs: 15_000,
      headersRef: 'secret://otel/headers',
      resourceAttributes: ['deployment.environment=prod', 'site.region=eu'],
    });
    const plain = await wireNodeSpec(tx, { telemetry: { otlpEndpoint: 'https://otel.example:4318' } });
    expect(
      specHash(
        await wireNodeSpec(tx, { telemetry: { otlpEndpoint: 'https://otel.example:4318', resourceAttributes: {} } }),
      ),
    ).toBe(specHash(plain));
  });
});

describe('NodeSpec resources on the wire (v1.1 §3.8)', () => {
  it('carries an instance placement and decodes it as bcd reads it', async () => {
    const wire = await wireNodeSpec(tx, {
      instances: [
        instance({
          placement: { cpus: '8-9', mems: '1', hugepageSizeBytes: 1_073_741_824, balloon: false },
        }),
      ],
    });
    const decoded = fromJson(NodeSpecSchema, wire as never).instances!.instances[0]!;
    expect(decoded.placement).toMatchObject({ cpus: '8-9', mems: '1', hugepageSizeBytes: 1_073_741_824n, balloon: false });
    // No placement: nothing on the wire, so the spec hashes as before.
    const plain = await wireNodeSpec(tx, { instances: [instance()] });
    expect(specHash(await wireNodeSpec(tx, { instances: [instance({ placement: {} })] }))).toBe(specHash(plain));
  });

  it("carries a hold's limits and the kubernetes binding", async () => {
    const rows = {
      devices: [{ id: 'GPU-1', class: 'gpu' }],
      allocations: [{ id: 'alc_1', owner_kind: 'reservation', owner_id: 'rsv_1', binding: 'kubernetes' }],
    };
    const store = {
      query: async (sql: string) => ({ rows: sql.includes('FROM devices') ? rows.devices : rows.allocations, rowCount: 1 }),
    } as unknown as SqlTx;
    const wire = await wireNodeSpec(store, {
      devices: {
        assignments: [
          {
            allocationId: 'alc_1',
            deviceIds: ['GPU-1'],
            limits: { cpus: '0-7', mems: '0', cpuMillis: 8000, memoryBytes: 64 * 2 ** 30, hugepages1Gi: 4 },
          },
        ],
      },
    });
    const assignment = fromJson(NodeSpecSchema, wire as never).devices!.assignments[0]!;
    expect(assignment.binding).toBe(Binding.KUBERNETES);
    expect(assignment.limits).toMatchObject({
      cpus: '0-7',
      mems: '0',
      cpuMillis: 8000,
      memoryBytes: 68_719_476_736n,
      hugepages1gi: 4n,
    });
  });
});

describe('NodeSpec site section: proxy targets (review 7 HIGH-1)', () => {
  it('lists the machines site.httpProxy may reach, sorted, and none when nothing contributes', async () => {
    const wire = await wireNodeSpec(tx, {
      site: {
        boot: { active: true, epoch: 2 },
        proxyTargets: [
          { nodeId: 'node_b', addresses: ['10.1.0.9', 'talos-b.site.internal', '10.1.0.9'] },
          { nodeId: 'node_a', addresses: ['10.1.0.7'] },
        ],
      },
    });
    const site = fromJson(NodeSpecSchema, wire as never).site!;
    expect(site.proxyTargets.map((target) => [target.nodeId, target.addresses])).toEqual([
      ['node_a', ['10.1.0.7']],
      ['node_b', ['10.1.0.9', 'talos-b.site.internal']],
    ]);
    const bare = await wireNodeSpec(tx, { site: { boot: { active: true, epoch: 2 } } });
    expect(fromJson(NodeSpecSchema, bare as never).site!.proxyTargets).toEqual([]);
    expect((bare.site as Record<string, unknown>).proxyTargets).toBeUndefined();
  });
});
