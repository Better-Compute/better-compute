import { describe, expect, it } from 'vitest';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  InstanceDesiredState,
  InstanceObservedState,
  RunsOn,
  SectionState,
  type InstanceSpecSchema,
  type StatusReport,
} from '@better-compute/protocol';
import {
  FakeHypervisor,
  createDaemonHarness,
  helperVpsHost,
  type FakeTelemetryExport,
} from '@better-compute/testing';

// A VPS host whose bcd runs under `bcd helper` (PLAN.md §3.8), as the FakeDaemon plays it: Hello advertises the
// runtimes it runs, root's checks refuse NICs off `[helper] instance_bridges` in the helper's words, and the telemetry
// section exports the instances' live usage (bcd.instance.*) read on the host.

const NODE = 'node_01jz00000000000000000000hv';
const START = Date.UTC(2026, 0, 1);
const SHA = new Uint8Array(32).fill(0xcd);

const spec = (
  instanceId: string,
  extra: Partial<MessageInitShape<typeof InstanceSpecSchema>> = {},
): MessageInitShape<typeof InstanceSpecSchema> => ({
  instanceId,
  desiredState: InstanceDesiredState.RUNNING,
  runtime: 'cloud-hypervisor',
  allocationId: `alloc_${instanceId}`,
  vcpu: 2,
  memoryBytes: 4n << 30n,
  diskBytes: 40n << 30n,
  image: { url: 'https://images.example/base.qcow2', sha256: SHA, format: 'qcow2' },
  nics: [{ network: 'br0', mac: '02:00:00:00:00:01', addresses: ['10.8.0.5/24'] }],
  ...extra,
});

function setup(options: { hypervisor?: FakeHypervisor; exports?: FakeTelemetryExport[] } = {}) {
  const hypervisor = options.hypervisor ?? new FakeHypervisor(helperVpsHost());
  const exports = options.exports ?? [];
  const harness = createDaemonHarness({
    nodeId: NODE,
    start: START,
    instances: hypervisor,
    daemonVersion: '0.9.0',
    telemetry: { export: (batch) => exports.push(batch) },
  });
  const last = () => {
    const statuses = harness.server.of('status') as StatusReport[];
    return statuses[statuses.length - 1]!;
  };
  const reported = (report: StatusReport) =>
    Object.fromEntries(report.instances.map((i) => [i.instanceId, InstanceObservedState[i.state]]));
  const message = (report: StatusReport, id: string) => report.instances.find((i) => i.instanceId === id)?.message;
  return { harness, hypervisor, exports, last, reported, message };
}

const points = (batch: FakeTelemetryExport, name: string) =>
  batch.metrics.find((metric) => metric.name === name)?.points ?? [];

describe('FakeDaemon: a VPS host under bcd helper', () => {
  it('advertises the runtimes it runs in Hello, as bcd does', async () => {
    const t = setup({ hypervisor: new FakeHypervisor(helperVpsHost({ runtimes: ['libvirt-kvm', 'cloud-hypervisor'] })) });
    await t.harness.advance(1_000);
    const hello = t.harness.server.of('hello')[0]!;
    expect(hello.drivers.filter((driver) => driver.kinds.includes('runtime'))).toEqual([
      expect.objectContaining({ id: 'libvirt-kvm', version: '0.9.0', kinds: ['runtime'], runsOn: RunsOn.NODE }),
      expect.objectContaining({ id: 'cloud-hypervisor', version: '0.9.0', kinds: ['runtime'], runsOn: RunsOn.NODE }),
    ]);
    expect(hello.capabilities).toEqual(expect.arrayContaining(['instance.placement', 'instance.volumes']));
  });

  it('refuses a NIC off [helper] instance_bridges in the helper’s words, per runtime', async () => {
    const t = setup({ hypervisor: new FakeHypervisor(helperVpsHost({ runtimes: ['libvirt-kvm', 'cloud-hypervisor'] })) });
    await t.harness.advance(1_000);
    const offBridge = [{ network: 'br-pool', mac: '02:00:00:00:00:02', addresses: [] }];
    t.harness.sendSpec(1, {
      instances: {
        instances: [
          spec('inst_ok'),
          spec('inst_ch', { nics: offBridge }),
          spec('inst_kvm', { runtime: 'libvirt-kvm', nics: offBridge }),
        ],
      },
    });
    await t.harness.advance(100);
    const report = t.last();
    expect(report.sections.find((s) => s.section === 'instances')?.state).toBe(SectionState.FAILED);
    expect(t.reported(report)).toEqual({ inst_ok: 'RUNNING', inst_ch: 'ERROR', inst_kvm: 'ERROR' });
    // cloud-hypervisor: the domain exists (its files are the node's); root's ch.taps refuses at the start.
    expect(t.message(report, 'inst_ch')).toBe(
      'ch.taps: "br-pool" is not an instance bridge of this host ([helper] instance_bridges)',
    );
    expect(t.hypervisor.domains.get('inst_ch')?.boots).toBe(0);
    // libvirt-kvm: root's check of the definition refuses it before the domain exists.
    expect(t.message(report, 'inst_kvm')).toBe('domain: bridge "br-pool" is not an instance network');
    expect(t.hypervisor.domains.has('inst_kvm')).toBe(false);
  });

  it('exports the instances’ live usage read on the host, every interval, until the section goes', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    const telemetry = {
      otlpEndpoint: 'https://otel.example.internal:4318',
      exportIntervalMs: 5_000,
      resourceAttributes: ['deployment.environment=test', 'service.name=not-bcd'],
    };
    t.harness.sendSpec(1, {
      instances: {
        instances: [
          spec('inst_a'),
          spec('inst_p', { desiredState: InstanceDesiredState.PAUSED, nics: [] }),
          spec('inst_s', { desiredState: InstanceDesiredState.STOPPED, nics: [] }),
        ],
      },
      telemetry,
    });
    await t.harness.advance(100);
    expect(t.exports).toHaveLength(1);
    let batch = t.exports[0]!;
    expect(batch).toMatchObject({ nodeId: NODE, endpoint: telemetry.otlpEndpoint });
    // bcd's own resource attributes win over the section's.
    expect(batch.resource).toEqual({
      'deployment.environment': 'test',
      'service.name': 'bcd',
      'service.version': '0.9.0',
      'bcd.node.id': NODE,
    });
    expect(points(batch, 'bcd.instances')).toEqual([
      { attributes: { runtime: 'cloud-hypervisor', state: 'paused' }, value: 1 },
      { attributes: { runtime: 'cloud-hypervisor', state: 'running' }, value: 1 },
      { attributes: { runtime: 'cloud-hypervisor', state: 'stopped' }, value: 1 },
    ]);
    expect(points(batch, 'bcd.instance.vcpu')).toHaveLength(3);
    // Live usage: cloud-hypervisor reads running and paused VMMs (their cgroups), never a stopped one.
    expect(points(batch, 'bcd.instance.cpu.time').map((p) => p.attributes['instance.id'])).toEqual(['inst_a', 'inst_p']);
    expect(points(batch, 'bcd.instance.memory.used')[0]).toEqual({
      attributes: { 'instance.id': 'inst_a', runtime: 'cloud-hypervisor' },
      value: 2 * 2 ** 30,
    });
    expect(batch.metrics.find((m) => m.name === 'bcd.instance.cpu.time')?.sum).toBe(true);

    // What the guest does shows up in the next export; its next boot starts the counters over.
    t.hypervisor.setUsage('inst_a', { cpuSeconds: 42.5, netRxBytes: 1_000n, ioWriteBytes: 4_096n });
    await t.harness.advance(5_000);
    expect(t.exports).toHaveLength(2);
    batch = t.exports[1]!;
    expect(points(batch, 'bcd.instance.cpu.time')[0]?.value).toBe(42.5);
    expect(points(batch, 'bcd.instance.network.receive')[0]?.value).toBe(1_000);
    expect(points(batch, 'bcd.instance.io.write')[0]?.value).toBe(4_096);
    t.hypervisor.powerLoss();
    t.harness.sendSpec(2, {
      instances: { instances: [spec('inst_a')] },
      telemetry,
    });
    await t.harness.advance(100);
    expect(t.exports).toHaveLength(2); // an unchanged section keeps its export and its interval
    await t.harness.advance(5_000);
    batch = t.exports.at(-1)!;
    expect(points(batch, 'bcd.instance.cpu.time')).toEqual([
      { attributes: { 'instance.id': 'inst_a', runtime: 'cloud-hypervisor' }, value: 2 },
    ]);

    // No endpoint: the export stops.
    t.harness.sendSpec(3, { instances: { instances: [spec('inst_a')] } });
    await t.harness.advance(100);
    const count = t.exports.length;
    await t.harness.advance(30_000);
    expect(t.exports).toHaveLength(count);
  });
});
