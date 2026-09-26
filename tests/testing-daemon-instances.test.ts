import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { refuseSecretRequest, sealSecretResponse } from '@better-compute/pki';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import {
  InstanceDesiredState,
  InstanceObservedState,
  InstancesSectionSchema,
  SectionState,
  type InstanceSpecSchema,
  type StatusReport,
} from '@better-compute/protocol';
import {
  FakeHypervisor,
  createDaemonHarness,
  overlayPath,
  seedPath,
  tapName,
} from '@better-compute/testing';

// The FakeDaemon as a VPS host (v0.3): the `instances` converger over a fake hypervisor, user data
// fetched with SecretRequests, and StatusReports that list the runtimes' whole inventory.

const NODE = 'node_01jz00000000000000000000vh';
const START = Date.UTC(2026, 0, 1);
const SHA = new Uint8Array(32).fill(0xcd);

const spec = (
  instanceId: string,
  extra: Partial<MessageInitShape<typeof InstanceSpecSchema>> = {},
): MessageInitShape<typeof InstanceSpecSchema> => ({
  instanceId,
  desiredState: InstanceDesiredState.RUNNING,
  runtime: 'libvirt-kvm',
  allocationId: `alloc_${instanceId}`,
  vcpu: 2,
  memoryBytes: 4n << 30n,
  diskBytes: 40n << 30n,
  image: { url: 'https://images.example/base.qcow2', sha256: SHA, format: 'qcow2' },
  nics: [{ network: 'br-pool', mac: '02:00:00:00:00:01', addresses: ['10.8.0.5/24'] }],
  ...extra,
});

function setup(options: { nodeKey?: boolean; hypervisor?: FakeHypervisor } = {}) {
  const hypervisor = options.hypervisor ?? new FakeHypervisor({ runtimes: ['libvirt-kvm'] });
  const harness = createDaemonHarness({
    nodeId: NODE,
    start: START,
    instances: hypervisor,
    ...(options.nodeKey
      ? { nodeKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }
      : {}),
  });
  const statuses = () => harness.server.of('status') as StatusReport[];
  const last = () => statuses()[statuses().length - 1]!;
  const section = (report: StatusReport) => report.sections.find((s) => s.section === 'instances')!;
  const reported = (report: StatusReport) =>
    Object.fromEntries(report.instances.map((i) => [i.instanceId, InstanceObservedState[i.state]]));
  return { harness, hypervisor, last, section, reported };
}

describe('FakeDaemon VPS host (instances converger)', () => {
  it('creates, stops and deletes domains with their disks and taps, reporting the whole inventory', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.harness.sendSpec(1, {
      instances: {
        instances: [spec('inst_a'), spec('inst_b', { desiredState: InstanceDesiredState.STOPPED })],
      },
    });
    await t.harness.advance(100);
    let report = t.last();
    expect(t.section(report).state).toBe(SectionState.CONVERGED);
    expect(report.instancesComplete).toBe(true);
    expect(t.reported(report)).toEqual({ inst_a: 'RUNNING', inst_b: 'STOPPED' });
    expect(report.instances.find((i) => i.instanceId === 'inst_a')?.addresses).toEqual([
      '10.8.0.5/24',
    ]);
    expect(t.hypervisor.files.get(overlayPath('inst_a'))).toBe('inst_a');
    expect(t.hypervisor.files.get(seedPath('inst_b'))).toBe('inst_b');
    expect(t.hypervisor.taps.get(tapName('inst_a', 0))).toBe('inst_a');
    expect(tapName('inst_a', 0).length).toBeLessThanOrEqual(15);
    expect([...t.hypervisor.imageCache.keys()]).toEqual(['cd'.repeat(32)]);
    expect(Number(report.observedGeneration)).toBe(1);

    // inst_a deleted explicitly, inst_b dropped from the spec: both go, with everything they own.
    t.harness.sendSpec(2, {
      instances: { instances: [spec('inst_a', { desiredState: InstanceDesiredState.DELETED })] },
    });
    await t.harness.advance(100);
    report = t.last();
    expect(t.reported(report)).toEqual({});
    expect(report.instancesComplete).toBe(true);
    expect(t.hypervisor.files.size).toBe(0);
    expect(t.hypervisor.taps.size).toBe(0);
  });

  it('reports a domain it did not create and never touches it', async () => {
    const t = setup();
    t.hypervisor.leakDomain('stray-vm');
    await t.harness.advance(1_000);
    t.harness.sendSpec(1, { instances: { instances: [spec('inst_a')] } });
    await t.harness.advance(100);
    expect(t.reported(t.last())).toEqual({ inst_a: 'RUNNING', 'stray-vm': 'RUNNING' });
    t.harness.sendSpec(2, { instances: { instances: [] } });
    await t.harness.advance(100);
    expect(t.reported(t.last())).toEqual({ 'stray-vm': 'RUNNING' });
    expect(t.hypervisor.domains.get('stray-vm')?.managed).toBe(false);
  });

  it('fails an instance whose runtime is missing, and a guest the test crashes', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.hypervisor.failInstance('inst_b', 'kernel panic');
    t.harness.sendSpec(1, {
      instances: { instances: [spec('inst_a', { runtime: 'cloud-hypervisor' }), spec('inst_b')] },
    });
    await t.harness.advance(100);
    const report = t.last();
    expect(t.section(report)).toMatchObject({
      state: SectionState.FAILED,
      reason: 'InstanceFailed',
    });
    expect(t.reported(report)).toEqual({ inst_a: 'ERROR', inst_b: 'ERROR' });
    expect(report.instances.find((i) => i.instanceId === 'inst_a')?.message).toMatch(
      /cloud-hypervisor is not installed/,
    );
    expect(report.instances.find((i) => i.instanceId === 'inst_b')?.message).toBe('kernel panic');
  });

  it('stops every domain on a host reboot and starts the ones that should run', async () => {
    const t = setup();
    await t.harness.advance(1_000);
    t.harness.sendSpec(1, {
      instances: {
        instances: [spec('inst_a'), spec('inst_b', { desiredState: InstanceDesiredState.STOPPED })],
      },
    });
    await t.harness.advance(100);
    expect(t.hypervisor.domains.get('inst_a')?.boots).toBe(1);
    t.harness.daemon.reboot({ durationMs: 5_000 });
    expect(t.hypervisor.domains.get('inst_a')?.state).toBe('stopped');
    await t.harness.advance(10_000);
    expect(t.hypervisor.domains.get('inst_a')).toMatchObject({ state: 'running', boots: 2 });
    expect(t.hypervisor.domains.get('inst_b')?.state).toBe('stopped');
  });

  it('fetches user data with a signed SecretRequest for the allocation before defining the domain', async () => {
    const t = setup({ nodeKey: true });
    await t.harness.advance(1_000);
    t.harness.sendSpec(1, {
      instances: {
        instances: [
          spec('inst_a', { userDataRef: 'secret://acme/ud1' }),
          spec('inst_b', { userDataRef: 'secret://acme/ud2' }),
        ],
      },
    });
    await t.harness.advance(100);
    expect(t.section(t.last()).state).toBe(SectionState.PROGRESSING);
    expect(t.hypervisor.domains.size).toBe(0);
    const requests = t.harness.server.of('secretRequest');
    expect(requests.map((r) => [r.ref, r.allocationId])).toEqual([
      ['secret://acme/ud1', 'alloc_inst_a'],
      ['secret://acme/ud2', 'alloc_inst_b'],
    ]);
    expect(requests[0]!.nodeSig?.sig.length).toBe(64);
    const recipient = (epk: Uint8Array) =>
      createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: Buffer.from(epk.slice(1, 33)).toString('base64url'),
          y: Buffer.from(epk.slice(33, 65)).toString('base64url'),
        },
        format: 'jwk',
      });
    const [first, second] = requests;
    t.harness.server.send({
      case: 'secret',
      value: sealSecretResponse(
        {
          ref: first!.ref,
          requestId: first!.requestId,
          workflowId: '',
          stepId: '',
          allocationId: first!.allocationId,
          recipient: recipient(first!.epk),
          serial: '01',
        },
        '#cloud-config\nhostname: a\n',
        { expiresAt: START + 60_000 },
      ),
    });
    t.harness.server.send({ case: 'secret', value: refuseSecretRequest(second!, 'not-bound') });
    await t.harness.advance(100);
    const report = t.last();
    expect(t.hypervisor.domains.get('inst_a')?.userData).toBe('#cloud-config\nhostname: a\n');
    expect(t.reported(report)).toEqual({ inst_a: 'RUNNING', inst_b: 'ERROR' });
    expect(report.instances.find((i) => i.instanceId === 'inst_b')?.message).toMatch(/not-bound/);
  });

  it('waits for a session before asking, and asks again on a new one', async () => {
    const t = setup({ nodeKey: true });
    await t.harness.advance(1_000);
    t.harness.sendSpec(1, {
      instances: { instances: [spec('inst_a', { userDataRef: 'secret://acme/ud1' })] },
    });
    await t.harness.advance(100);
    expect(t.harness.server.of('secretRequest')).toHaveLength(1);
    // The session drops before the answer: the next session asks again.
    t.harness.daemon.disconnect('test');
    await t.harness.advance(10_000);
    expect(t.harness.servers.length).toBeGreaterThan(1);
    expect(t.harness.server.of('secretRequest').map((r) => r.ref)).toEqual(['secret://acme/ud1']);
  });

  it('keeps the domains through a daemon crash (the hypervisor outlives the process)', async () => {
    const hypervisor = new FakeHypervisor();
    const t = setup({ hypervisor });
    await t.harness.advance(1_000);
    t.harness.sendSpec(1, { instances: { instances: [spec('inst_a')] } });
    await t.harness.advance(100);
    t.harness.daemon.crash();
    expect(hypervisor.domains.get('inst_a')?.state).toBe('running');
    t.harness.daemon.restart();
    await t.harness.advance(5_000);
    expect(hypervisor.domains.get('inst_a')).toMatchObject({ state: 'running', boots: 1 });
    expect(t.reported(t.last())).toEqual({ inst_a: 'RUNNING' });
  });
});

describe('FakeHypervisor: paused instances, restores and snapshots (v0.5 sandboxes)', () => {
  const section = (...specs: MessageInitShape<typeof InstanceSpecSchema>[]) =>
    create(InstancesSectionSchema, { instances: specs });

  it('boots then pauses, resumes without a new boot, and counts paused domains against the host', () => {
    const hypervisor = new FakeHypervisor({ capacity: { vcpu: 3 } });
    const paused = spec('inst_w', { desiredState: InstanceDesiredState.PAUSED });
    expect(hypervisor.converge(section(paused)).state).toBe(SectionState.CONVERGED);
    expect(hypervisor.domains.get('inst_w')).toMatchObject({ state: 'paused', boots: 1 });
    expect(hypervisor.statuses()).toMatchObject([
      { instanceId: 'inst_w', state: InstanceObservedState.PAUSED },
    ]);
    // Memory stays resident: a second 2-vCPU instance does not fit next to it.
    const other = spec('inst_x', { nics: [] });
    expect(hypervisor.converge(section(paused, other)).state).toBe(SectionState.FAILED);
    // Resumed in place: running, still one boot.
    hypervisor.converge(section(spec('inst_w')));
    expect(hypervisor.domains.get('inst_w')).toMatchObject({ state: 'running', boots: 1 });
    hypervisor.powerLoss();
    expect(hypervisor.domains.get('inst_w')!.state).toBe('stopped');
  });

  it('restores from a snapshot it verifies, and snapshots deterministically', () => {
    const hypervisor = new FakeHypervisor();
    hypervisor.converge(section(spec('inst_s')));
    const first = hypervisor.snapshot('inst_s');
    expect(first).toMatchObject({ runtime: 'libvirt-kvm', includeMemory: true });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hypervisor.snapshot('inst_s').sha256).not.toBe(first.sha256);
    expect(() => hypervisor.snapshot('inst_none')).toThrow(/no instance/);

    const digest = Uint8Array.from(Buffer.from(first.sha256, 'hex'));
    const restoreFrom = {
      ref: 'img_snap',
      url: 'https://objects.example/snap',
      sha256: digest,
      format: 'raw',
    };
    hypervisor.converge(section(spec('inst_s'), spec('inst_r', { restoreFrom, nics: [] })));
    expect(hypervisor.domains.get('inst_r')).toMatchObject({
      state: 'running',
      restoredFrom: first.sha256,
    });
    const unverified = { ...restoreFrom, sha256: new Uint8Array(0) };
    expect(
      hypervisor.converge(section(spec('inst_u', { restoreFrom: unverified }))).message,
    ).toMatch(/no sha256/);
  });
});

describe('FakeHypervisor host volumes (v1.1)', () => {
  const GiB = 1n << 30n;
  const volume = (volumeId: string, sizeGiB: bigint) => ({
    volumeId,
    sizeBytes: sizeGiB * GiB,
    serial: `bcv-${volumeId}`,
  });
  const section = (
    instances: MessageInitShape<typeof InstanceSpecSchema>[],
    volumes: ReturnType<typeof volume>[],
  ) => create(InstancesSectionSchema, { instances, volumes });

  it('keeps volumes across instances and power loss, one writer at a time, stops before starts', () => {
    const hypervisor = new FakeHypervisor({
      runtimes: ['libvirt-kvm'],
      volumeStore: { totalBytes: 100n * GiB, reservedBytes: 10n * GiB },
    });
    const rw = (id: string, desiredState = InstanceDesiredState.RUNNING) =>
      spec(id, { desiredState, volumes: [{ volumeId: 'v1', readOnly: false }] });
    const ro = (id: string) => spec(id, { volumes: [{ volumeId: 'v1', readOnly: true }] });
    hypervisor.converge(section([rw('a')], [volume('v1', 20n)]));
    expect(hypervisor.openBy('v1')).toEqual([{ domainId: 'a', readOnly: false }]);
    hypervisor.writeVolume('a', 'v1', 'notes-1');
    // A second writer, or a reader beside the writer, fails to start.
    const second = hypervisor.converge(section([rw('a'), rw('b'), ro('c')], [volume('v1', 20n)]));
    expect(second.state).toBe(SectionState.FAILED);
    expect(hypervisor.domains.get('b')!.state).toBe('error');
    expect(hypervisor.domains.get('c')!.state).toBe('error');
    // The handoff in one pass: a stops first, then b opens it (whatever the spec order).
    hypervisor.converge(
      section([rw('b'), rw('a', InstanceDesiredState.STOPPED)], [volume('v1', 20n)]),
    );
    expect(hypervisor.openBy('v1')).toEqual([{ domainId: 'b', readOnly: false }]);
    expect(hypervisor.volumeContent('v1')).toBe('notes-1');
    // Power loss closes it; the data stays. Growth takes effect, and the store reports what it promised.
    hypervisor.powerLoss();
    expect(hypervisor.openBy('v1')).toEqual([]);
    hypervisor.converge(section([rw('b')], [volume('v1', 30n)]));
    expect(hypervisor.volumes.get('v1')).toMatchObject({
      sizeBytes: 30n * GiB,
      content: 'notes-1',
    });
    expect(hypervisor.volumeStorage()).toMatchObject({
      committedBytes: 30n * GiB,
      outstandingBytes: 30n * GiB - (1n << 20n),
    });
    // No room: bcd refuses the create, and the instance naming it fails.
    const full = hypervisor.converge(
      section(
        [rw('b'), spec('d', { volumes: [{ volumeId: 'v2', readOnly: false }] })],
        [volume('v1', 30n), volume('v2', 80n)],
      ),
    );
    expect(full.state).toBe(SectionState.FAILED);
    expect(hypervisor.volumes.has('v2')).toBe(false);
    expect(hypervisor.domains.get('d')!.message).toMatch(/no room/);
    // Unlisted: it goes only once nothing has it open.
    hypervisor.converge(section([rw('b')], []));
    expect(hypervisor.volumes.has('v1')).toBe(true);
    hypervisor.converge(section([], []));
    expect(hypervisor.volumes.size).toBe(0);
  });
});
