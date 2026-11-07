import { afterEach, describe, expect, it } from 'vitest';
import { awsProvider } from '@better-compute/provider-aws';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { instanceWork, interruptionCondition, providerEventsWork, vps } from '@better-compute/vps';
import { AwsEmulator, platformAccount } from './support/aws-emulator/index.js';
import { Ec2Emulator } from './support/aws-emulator/ec2.js';
import { SqsEmulator, type EmuQueue } from './support/aws-emulator/event-queue.js';
import { workRows } from './support/runtime.js';

// AWS A4 end to end: the real provider-aws against the AWS emulator (EC2, STS, SQS), wired through
// vps on the sim clock. EventBridge envelopes land on the account's intake queue; one
// `vps.provider-events` pass reads them. Exit criterion: an interruption warning taints the node its
// machine backs and drains it within one pass; forged events change nothing.

afterEach(closeFixtures);

type Api = any;
const ZONE = 'us-east-1a';
const queueName = 'bc-events';

async function world() {
  const emu = new AwsEmulator();
  const ec2 = new Ec2Emulator(emu);
  const sqs = new SqsEmulator(emu);
  const queue = sqs.createQueue(platformAccount, queueName);
  const aws = awsProvider({ fetch: emu.fetch, credentials: emu.ambient });
  const fixture: ComputeFixture = await computeFixture({
    clock: 'sim',
    modules: [vps({ providers: [aws] })],
  });
  emu.follow(fixture.clock);
  const { compute, tenants, iam } = fixture;
  (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'aws',
    name: 'aws-use1',
    config: {
      region: 'us-east-1',
      zones: [ZONE],
      eventQueueUrl: `https://sqs.us-east-1.amazonaws.com/${platformAccount}/${queueName}`,
    },
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-east-1',
    idempotencyKey: 'aws-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'aws-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { vcpu: 64, memoryGiB: 512, diskGiB: 1000 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'm7i.large',
    vcpu: 2,
    memoryGiB: 8,
    diskGiB: 100,
    offerId: `${ZONE}/m7i.large`,
  });

  // A GPU host pool whose node is a platform EC2 machine joined through a provider bootstrap.
  const hosts = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    idempotencyKey: 'host-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: hosts.id,
    toTenantId: tenants.acme.id,
    quota: { gpu: 8 },
  });
  const hostMachine = ec2.addInstance({ id: 'i-0aaaaaaaaaaaaaaa1', type: 'p5.48xlarge' });
  const nodeId = 'node_01jz00000000000000000000aw';
  const db = fixture.database;
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [nodeId, site.id, hosts.id, tenants.root.id],
  );
  for (let index = 0; index < 8; index++)
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","vramGiB":80}')`,
      [`GPU-aw-${index}`, nodeId],
    );
  await db.query(
    `INSERT INTO provider_bootstraps (id, tenant_id, account_id, pool_id, machine_id, state, node_id,
       owner_identity_id, idempotency_key, request_hash, version)
     VALUES ('pbs_aws', $1, $2, $3, $4, 'joined', $5, 'usr_root', 'b-1', 'h', 1)`,
    [tenants.root.id, account.id, pool.id, hostMachine.id, nodeId],
  );

  const tick = async (job: string, advanceMs = 1_000) => {
    await fixture.advance(advanceMs);
    for (let round = 0; round < 2; round++) await compute.jobs[job]!.tick();
  };
  return {
    emu,
    ec2,
    sqs,
    queue,
    fixture,
    api,
    root,
    acme,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    accountId: account.id,
    poolId: pool.id,
    hostsId: hosts.id,
    nodeId,
    hostMachine,
    tick,
    /** A running tenant VM and its EC2 instance id. */
    async vm(key: string) {
      const created = await api.instances.create(acme, {
        tenantId: tenants.acme.id,
        poolId: pool.id,
        flavor: 'm7i.large',
        imageId: 'ubuntu-24.04',
        sshKeys: [],
        idempotencyKey: key,
      });
      for (let round = 0; round < 8; round++) {
        ec2.tick();
        await tick('vps.instances', 15_000);
        const view = await api.instances.get(acme, { tenantId: tenants.acme.id, instanceId: created.id });
        if (view.state === 'running') break;
      }
      const machine = [...ec2.instances.values()].find(
        (instance) => instance.tags.get('better-compute:instance') === created.id,
      )!;
      return { id: created.id as string, machineId: machine.id };
    },
    /** Acme's 4-GPU reservation on the host node. */
    async reservation() {
      return api.reservations.create(acme, {
        tenantId: tenants.acme.id,
        poolId: hosts.id,
        devices: [{ class: 'gpu', count: 4 }],
        duration: '6h',
        idempotencyKey: 'r-1',
      });
    },
    async outbox(prefix: string) {
      const { rows } = await db.query<{ topic: string; payload: { data: any } }>(
        `SELECT topic, payload FROM outbox WHERE topic LIKE $1 ORDER BY seq`,
        [`${prefix}%`],
      );
      return rows.map((row) => ({ type: row.topic, data: row.payload.data }));
    },
    async taints() {
      const { rows } = await db.query<{ no_schedule_reasons: string[] }>(
        `SELECT no_schedule_reasons FROM nodes WHERE id = $1`,
        [nodeId],
      );
      return rows[0]!.no_schedule_reasons;
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

function send(w: World, queue: EmuQueue, detailType: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  w.sqs.send(queue, {
    version: '0',
    id: `evt-${Math.random().toString(16).slice(2, 12)}`,
    'detail-type': detailType,
    source: 'aws.ec2',
    account: platformAccount,
    time: new Date(w.fixture.clock.now()).toISOString(),
    region: 'us-east-1',
    resources: [],
    detail,
    ...extra,
  });
}

describe('AWS event intake through vps, end to end', () => {
  it('an interruption warning taints the node and drains it within one reconciler pass', async () => {
    const w = await world();
    const vm = await w.vm('vm-1');
    const reservation = await w.reservation();
    expect(reservation.state).toBe('placed');
    const sentAt = w.fixture.clock.now();
    for (const machineId of [w.hostMachine.id, vm.machineId])
      send(w, w.queue, 'EC2 Spot Instance Interruption Warning', {
        'instance-id': machineId,
        'instance-action': 'terminate',
      });
    await w.tick(providerEventsWork, 0);
    const deadline = Date.parse(new Date(sentAt).toISOString().replace(/\.\d{3}Z$/, 'Z')) + 120_000;

    expect(await w.taints()).toContain('taint:aws.spot/interruption');
    const after = await w.api.reservations.get(w.acme, {
      tenantId: w.acmeTenant,
      reservationId: reservation.id,
    });
    expect(after.during.end).toBeLessThanOrEqual(deadline);
    expect(after.conditions).toContainEqual(
      expect.objectContaining({ type: 'Preempted', reason: 'ProviderInterruption' }),
    );
    const view = await w.api.instances.get(w.acme, { tenantId: w.acmeTenant, instanceId: vm.id });
    expect(view.conditions).toContainEqual(
      expect.objectContaining({ type: interruptionCondition, reason: 'SpotInterruption' }),
    );
    expect((await w.outbox('instance.interruption')).map((event) => event.data.machineId)).toEqual([
      vm.machineId,
    ]);
    // Acked after the transaction: the queue is empty.
    expect(w.queue.messages).toEqual([]);
    expect(w.emu.calls('DeleteMessageBatch')).toHaveLength(1);
    // A new reservation does not land on the tainted node.
    const next = await w.api.reservations.create(w.acme, {
      tenantId: w.acmeTenant,
      poolId: w.hostsId,
      devices: [{ class: 'gpu', count: 4 }],
      duration: '1h',
      idempotencyKey: 'r-2',
    });
    expect(next.state).not.toBe('placed');
  });

  it('forged events change nothing', async () => {
    const w = await world();
    const vm = await w.vm('vm-1');
    const reservation = await w.reservation();
    const before = await w.api.reservations.get(w.acme, {
      tenantId: w.acmeTenant,
      reservationId: reservation.id,
    });
    const warning = (machineId: string) => ({ 'instance-id': machineId, 'instance-action': 'terminate' });
    for (const machineId of [w.hostMachine.id, vm.machineId]) {
      send(w, w.queue, 'EC2 Spot Instance Interruption Warning', warning(machineId), { account: '999999999999' });
      send(w, w.queue, 'EC2 Spot Instance Interruption Warning', warning(machineId), { source: 'custom.forged' });
      send(w, w.queue, 'EC2 Spot Instance Interruption Warning', warning(machineId), { region: 'eu-west-1' });
    }
    w.sqs.send(w.queue, '{"not": "an envelope"');
    await w.tick(providerEventsWork, 0);
    // A long poll returns at most 10 messages; the next pass reads the rest.
    await w.tick(providerEventsWork, 15_000);

    expect(w.queue.messages).toEqual([]);
    expect(await w.taints()).toEqual([]);
    expect(
      await w.api.reservations.get(w.acme, { tenantId: w.acmeTenant, reservationId: reservation.id }),
    ).toMatchObject({ state: before.state, during: before.during });
    const view = await w.api.instances.get(w.acme, { tenantId: w.acmeTenant, instanceId: vm.id });
    expect(view.conditions.map((condition: { type: string }) => condition.type)).not.toContain(
      interruptionCondition,
    );
    expect(await w.outbox('instance.interruption')).toEqual([]);
    expect(await w.outbox('node.tainted')).toEqual([]);
    const { rows } = await w.fixture.database.query(`SELECT 1 FROM provider_event_seen`);
    expect(rows).toEqual([]);
  });

  it('a state change wakes the instance reconcile before its poll is due', async () => {
    const w = await world();
    const vm = await w.vm('vm-1');
    const due = async () => {
      const now = w.fixture.clock.now();
      return (await workRows(w.fixture.database, instanceWork))
        .filter((row) => row.key === vm.id && row.not_before.getTime() <= now)
        .map((row) => row.key);
    };
    expect(await due()).toEqual([]);
    send(w, w.queue, 'EC2 Instance State-change Notification', { 'instance-id': vm.machineId, state: 'stopping' });
    await w.tick(providerEventsWork, 0);
    expect(await due()).toEqual([vm.id]);
  });
});
