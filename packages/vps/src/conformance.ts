import {
  ComputeError,
  isComputeError,
  systemClock,
  type CallContext,
  type ExternalMachine,
  type Logger,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderImpl,
  type ProviderResourceState,
  type SecretRef,
} from '@better-compute/core';
import {
  check,
  checkEqual,
  checkRejects,
  type ConformanceCase,
} from '@better-compute/core/conformance';

// providerConformance (PLAN.md §5.6 walkthrough 2): behavioural cases every ProviderImpl must pass,
// run from any test runner against a live account, a record/replay transport or an emulator.

/** What the cases run against: a provider, an account config, and something cheap to create. */
export interface ProviderConformanceSubject {
  provider: ProviderDefinition;
  /** Account config, validated by the provider's manifest. */
  config: unknown;
  /** An offer id `create` accepts. */
  offerId: string;
  /** An image `create` accepts. */
  image: string;
  /** Context overrides (secrets for the account's SecretRefs, a clock, a logger, the account). */
  context?: Partial<ProviderContext>;
  /** A per-run prefix so concurrent runs never share idempotency keys. */
  prefix?: string;
  /**
   * `false` for providers that can act on power but not observe it (Hetzner Robot): the power case
   * then checks only that the actions succeed.
   */
  powerObservable?: boolean;
  /**
   * A machine id the subject can claim and release (an existing machine the provider can see).
   * The claim and discover cases are skipped without it.
   */
  attachable?: string;
  /** The size of the volumes the volume cases make (default 10 GiB: the floor of some providers). */
  volumeGiB?: number;
  /** The region volumes and addresses live in; absent: the region of the machine the case creates. */
  region?: string;
  /**
   * An offer id `create` accepts in another region than the volumes and addresses: the case that attaches and
   * assigns across regions (`INVALID_INPUT`) is skipped without it (a subject that offers one region).
   */
  otherRegionOfferId?: string;
  /**
   * How the volume and address cases wait for a non-blocking call to settle: they call again up to
   * `attempts` times (default 30), `intervalMs` apart (default 0; a live run sets a few seconds).
   */
  settle?: { attempts?: number; intervalMs?: number };
  /**
   * (DO P6) Run the shared-volume case: on a provider whose `volumes.kinds` lists `shared` and that has
   * `networks`, it makes a tenant network and subnet in the offer's region, two machines on it, and a shared volume
   * of `sharedVolumeGiB` (default 50 GiB: DigitalOcean's smallest share) reached over it. Opt-in: it makes a
   * network, two machines and a share.
   */
  sharedVolumes?: boolean;
  sharedVolumeGiB?: number;
  /** The subnet range the shared-volume case makes (default `10.200.0.0/24`). */
  sharedVolumeCidr?: string;
  /**
   * A volume and a volume snapshot at the provider that this deployment did not make (another deployment's, or the
   * account owner's): the ownership case checks a delete refuses each (`INVALID_STATE`) and leaves it. Each check is
   * skipped without its id; the address check needs none.
   */
  foreign?: { volumeId?: string; snapshotId?: string };
  /**
   * `true` when `reinstall` may run on a machine the cases create (it reinstalls the subject image).
   * The reinstall case is skipped without it: on real hardware it can take many minutes.
   */
  reinstallable?: boolean;
  /**
   * (edge) A DNS zone the subject may create and delete (a test domain the account can host). The DNS case is
   * skipped without it.
   */
  dnsZone?: string;
  /**
   * (edge) Secret references to a PEM certificate and key `context.secrets` resolves, for the custom certificate
   * case; it is skipped without them.
   */
  certificate?: { certificate: SecretRef; privateKey: SecretRef; chain?: SecretRef };
  /** (edge) The CIDR of the subnet the NAT gateway case makes (default `10.250.0.0/24`). */
  natCidr?: string;
  /** (edge) The CIDRs of the two subnets the peering case makes (default `10.251.0.0/24`, `10.252.0.0/24`). */
  peeringCidrs?: readonly [string, string];
  /**
   * (edge) The subnet the route case makes and the private address in it the route points at (default
   * `10.253.0.0/24` and `10.253.0.10`).
   */
  route?: { cidr: string; nextHop: string };
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const states: readonly ExternalMachine['state'][] = [
  'pending',
  'running',
  'stopped',
  'rescue',
  'deleting',
  'deleted',
  'error',
  'unknown',
];

async function client(subject: ProviderConformanceSubject): Promise<{
  impl: ProviderImpl;
  call: (key: string) => CallContext;
}> {
  const context: ProviderContext = {
    clock: subject.context?.clock ?? systemClock,
    log: subject.context?.log ?? quiet,
    secrets: subject.context?.secrets ?? {
      resolve: async () => {
        throw new ComputeError('INVALID_CONFIG', 'The conformance subject gave no secret resolver');
      },
    },
    ...(subject.context?.account ? { account: subject.context.account } : {}),
  };
  const parsed = await subject.provider.config['~standard'].validate(subject.config);
  if ('issues' in parsed && parsed.issues)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The subject's config does not validate: ${parsed.issues[0]?.message}`,
    );
  const impl = await subject.provider.create((parsed as { value: unknown }).value, context);
  const call = (key: string): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: context.clock,
    secrets: context.secrets,
    log: context.log,
  });
  return { impl, call };
}

function checkMachine(
  machine: ExternalMachine | undefined,
  what: string,
): asserts machine is ExternalMachine {
  check(machine !== undefined, `${what}: expected a machine`);
  check(
    typeof machine.id === 'string' && machine.id.length > 0,
    `${what}: machine.id must be a non-empty string`,
  );
  check(
    states.includes(machine.state),
    `${what}: state ${String(machine.state)} is not in the contract`,
  );
  check(Array.isArray(machine.addresses), `${what}: addresses must be a list`);
}

async function create(subject: ProviderConformanceSubject, key: string) {
  const { impl, call } = await client(subject);
  const machine = await impl.create(
    { offerId: subject.offerId, image: subject.image, userData: '#cloud-config\n', name: key },
    call(key),
  );
  return { impl, call, machine };
}

async function cleanUp(
  impl: ProviderImpl,
  call: (key: string) => CallContext,
  id: string,
): Promise<void> {
  try {
    await impl.delete(id, call(`cleanup-${id}`));
  } catch (error) {
    if (!isComputeError(error, 'NOT_FOUND')) throw error;
  }
}

const resourceStates: readonly ProviderResourceState['state'][] = [
  'pending',
  'ready',
  'updating',
  'deleting',
  'deleted',
  'error',
];

function checkResource(state: ProviderResourceState | undefined, what: string): void {
  check(state !== undefined, `${what}: expected a state`);
  check(typeof state.id === 'string' && state.id !== '', `${what}: id must be a non-empty string`);
  check(
    resourceStates.includes(state.state),
    `${what}: state ${String(state.state)} is not in the contract`,
  );
}

/**
 * Calls `step` until its state is one of `until` (a non-blocking provider call settles on a later
 * call), at most `settle.attempts` times, and returns that state.
 */
async function settle(
  subject: ProviderConformanceSubject,
  step: () => Promise<ProviderResourceState>,
  until: readonly ProviderResourceState['state'][],
  what: string,
): Promise<ProviderResourceState> {
  const attempts = subject.settle?.attempts ?? 30;
  const intervalMs = subject.settle?.intervalMs ?? 0;
  let last: ProviderResourceState | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await step();
    checkResource(last, what);
    check(last.state !== 'error', `${what}: the provider reports an error: ${last.message ?? ''}`);
    if (until.includes(last.state)) return last;
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new ComputeError(
    'INVALID_STATE',
    `${what}: still ${String(last?.state)} after ${attempts} calls, expected ${until.join(' or ')}`,
  );
}

/** The region the volume and address cases use: the subject's, else the created machine's. */
function regionOf(subject: ProviderConformanceSubject, machine: ExternalMachine): string {
  const region = subject.region ?? machine.region;
  check(region !== undefined, 'the subject names no region and the created machine reports none');
  return region;
}

/** The ProviderImpl contract (§5.4) as conformance cases. */
export function providerConformanceCases(): ConformanceCase<ProviderConformanceSubject>[] {
  const key = (subject: ProviderConformanceSubject, name: string) =>
    `${subject.prefix ?? 'bc-conformance'}-${name}`;
  return [
    {
      name: 'the definition is well formed and builds a client from a valid config',
      async run(subject) {
        check(
          subject.provider.extension === 'provider',
          'the definition comes from defineProvider',
        );
        check(subject.provider.provides.length > 0, 'provides lists metal and/or vps');
        const { impl } = await client(subject);
        for (const method of ['listOffers', 'create', 'get', 'delete'] as const)
          check(typeof impl[method] === 'function', `ProviderImpl.${method} is a function`);
      },
    },
    {
      name: 'listOffers returns well-formed offers, including the subject offer',
      async run(subject) {
        const { impl } = await client(subject);
        const offers = await impl.listOffers({});
        check(Array.isArray(offers), 'listOffers returns a list');
        for (const offer of offers) {
          check(typeof offer.id === 'string' && offer.id !== '', 'offer.id is a non-empty string');
          check(
            offer.kind === 'metal' || offer.kind === 'vps',
            `offer ${offer.id}: kind is metal or vps`,
          );
          check(
            offer.vcpu > 0 && offer.memoryGiB > 0,
            `offer ${offer.id}: vcpu and memoryGiB are positive`,
          );
          check(typeof offer.available === 'boolean', `offer ${offer.id}: available is a boolean`);
        }
        check(
          offers.some((offer) => offer.id === subject.offerId),
          `offer ${subject.offerId} is listed`,
        );
        const none = await impl.listOffers({ minVcpu: 1_000_000 });
        checkEqual(none, [], 'an impossible query matches nothing');
      },
    },
    {
      name: 'create is idempotent by idempotencyKey: a retried create returns the same machine',
      async run(subject) {
        const name = key(subject, 'idempotent');
        const first = await create(subject, name);
        try {
          checkMachine(first.machine, 'create');
          const again = await create(subject, name);
          checkEqual(again.machine.id, first.machine.id, 'a retried create names the same machine');
        } finally {
          await cleanUp(first.impl, first.call, first.machine.id);
        }
      },
    },
    {
      name: 'get follows the machine; delete removes it; deleting again counts as deleted',
      async run(subject) {
        const { impl, call, machine } = await create(subject, key(subject, 'lifecycle'));
        checkMachine(await impl.get(machine.id, call('get')), 'get after create');
        await impl.delete(machine.id, call('delete'));
        const after = await impl.get(machine.id, call('get-after-delete'));
        check(
          after === undefined || after.state === 'deleting' || after.state === 'deleted',
          'get after delete finds nothing live',
        );
        try {
          await impl.delete(machine.id, call('delete-again'));
        } catch (error) {
          check(
            isComputeError(error, 'NOT_FOUND'),
            `a second delete fails only with NOT_FOUND, not ${String(error)}`,
          );
        }
        check(
          (await impl.get('bc-conformance-missing-0', call('get-missing'))) === undefined,
          'get of an unknown id is undefined',
        );
      },
    },
    {
      name: 'power (when offered) stops and starts the machine',
      async run(subject) {
        const { impl, call, machine } = await create(subject, key(subject, 'power'));
        try {
          if (!impl.power) return;
          const observable = subject.powerObservable !== false;
          await impl.power(machine.id, 'off', call('off'));
          const off = await impl.get(machine.id, call('get-off'));
          checkMachine(off, 'get after power off');
          if (observable)
            check(
              off.state === 'stopped' || off.state === 'pending',
              `power off leaves it stopped, not ${off.state}`,
            );
          await impl.power(machine.id, 'on', call('on'));
          const on = await impl.get(machine.id, call('get-on'));
          checkMachine(on, 'get after power on');
          if (observable)
            check(
              on.state === 'running' || on.state === 'pending',
              `power on leaves it running, not ${on.state}`,
            );
        } finally {
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      // (DO P3) The catalog-image identity is additive: a host sends it only for a catalog ref
      // (`name@version`), so a reinstall without it, or with options that hold none, must behave as
      // before the options existed.
      name: 'reinstall (when offered) needs no options: the catalog-image identity is optional',
      async run(subject) {
        if (!subject.reinstallable) return;
        check(
          !subject.image.includes('@'),
          'the subject image is a provider image, not a catalog ref (a host sends catalogImage only for those)',
        );
        const { impl, call, machine } = await create(subject, key(subject, 'reinstall'));
        try {
          if (!impl.reinstall) return;
          await impl.reinstall(machine.id, subject.image, call('reinstall'));
          await impl.reinstall(machine.id, subject.image, call('reinstall-empty'), {});
          checkMachine(await impl.get(machine.id, call('get-reinstalled')), 'get after reinstall');
        } finally {
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'claim then release round-trips the label',
      async run(subject) {
        const id = subject.attachable;
        const { impl, call } = await client(subject);
        if (!impl.claim || !impl.release || id === undefined) return;
        const instanceId = key(subject, 'claim');
        try {
          const claimed = await impl.claim(id, instanceId, call('claim'));
          checkMachine(claimed, 'claim');
          checkEqual(claimed.claimedBy, instanceId, 'claim names the instance');
          const seen = await impl.get(id, call('get-claimed'));
          checkMachine(seen, 'get after claim');
          checkEqual(seen.claimedBy, instanceId, 'get after claim names the instance');
          await impl.release(id, `${instanceId}-other`, call('release-other'));
          const kept = await impl.get(id, call('get-kept'));
          checkEqual(kept?.claimedBy, instanceId, 'release for another instance keeps the label');
          await impl.release(id, instanceId, call('release'));
          const released = await impl.get(id, call('get-released'));
          checkMachine(released, 'get after release');
          check(released.claimedBy === undefined, 'release removes the label');
        } finally {
          await impl.release(id, instanceId, call('release-cleanup'));
        }
      },
    },
    {
      name: 'discover yields the attachable machine',
      async run(subject) {
        const id = subject.attachable;
        const { impl, call } = await client(subject);
        if (!impl.discover || id === undefined) return;
        let found: ExternalMachine | undefined;
        for await (const machine of impl.discover(call('discover'))) {
          checkMachine(machine, 'discover');
          if (machine.id === id) found = machine;
        }
        check(found !== undefined, `discover yields machine ${id}`);
      },
    },
    {
      name: 'volumes (when offered): ensure by name, attach, grow-only resize, delete',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.volumes) return;
        const { impl, call, machine } = await create(subject, key(subject, 'volume-host'));
        const volumes = impl.volumes!;
        let volumeId: string | undefined;
        try {
          const region = regionOf(subject, machine);
          const sizeGiB = subject.volumeGiB ?? 10;
          const spec = { name: key(subject, 'vol'), region, sizeGiB, kind: 'block' as const };
          const first = await settle(
            subject,
            () => volumes.ensureVolume(spec, call('vol-ensure')),
            ['ready'],
            'ensureVolume',
          );
          const id = first.id;
          volumeId = id;
          const again = await volumes.ensureVolume(spec, call('vol-ensure-again'));
          checkEqual(again.id, id, 'a second ensure of the same name returns the same volume');
          checkEqual(first.outputs?.region, region, 'the volume reports its region');
          checkEqual(first.outputs?.sizeGiB, String(sizeGiB), 'the volume reports its size');
          await checkRejects(
            () => volumes.resizeVolume(id, sizeGiB - 1, call('vol-shrink')),
            'INVALID_INPUT',
            'resizing to a smaller size',
          );
          await settle(
            subject,
            () => volumes.attachVolume(id, machine.id, call('vol-attach')),
            ['ready'],
            'attachVolume',
          );
          const attached = await volumes.getVolume(id, call('vol-get-attached'));
          checkResource(attached, 'getVolume after attach');
          checkEqual(attached?.outputs?.attachedTo, machine.id, 'the volume names its machine');
          await checkRejects(
            () => volumes.deleteVolume(id, call('vol-delete-attached')),
            'INVALID_STATE',
            'deleting an attached volume',
          );
          await settle(
            subject,
            () => volumes.resizeVolume(id, sizeGiB + 1, call('vol-grow')),
            ['ready'],
            'resizeVolume',
          );
          checkEqual(
            (await volumes.getVolume(id, call('vol-get-grown')))?.outputs?.sizeGiB,
            String(sizeGiB + 1),
            'the volume reports its new size',
          );
          await settle(
            subject,
            () => volumes.detachVolume(id, machine.id, call('vol-detach')),
            ['deleted'],
            'detachVolume',
          );
          const detached = await volumes.getVolume(id, call('vol-get-detached'));
          check(detached?.outputs?.attachedTo === undefined, 'a detached volume names no machine');
          await settle(
            subject,
            () => volumes.deleteVolume(id, call('vol-delete')),
            ['deleted'],
            'deleteVolume',
          );
          volumeId = undefined;
          checkEqual(
            (await volumes.deleteVolume(id, call('vol-delete-again'))).state,
            'deleted',
            'deleting a deleted volume counts as deleted',
          );
          const gone = await volumes.getVolume(id, call('vol-get-deleted'));
          check(
            gone === undefined || gone.state === 'deleting' || gone.state === 'deleted',
            'getVolume after delete finds nothing live',
          );
        } finally {
          if (volumeId !== undefined) {
            await volumes
              .detachVolume(volumeId, machine.id, call('vol-cleanup-detach'))
              .catch(() => {});
            await volumes.deleteVolume(volumeId, call('vol-cleanup')).catch(() => {});
          }
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'volume snapshots (when offered): snapshot by name, delete idempotently',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.volumes) return;
        const { impl, call, machine } = await create(subject, key(subject, 'snapshot-host'));
        const volumes = impl.volumes!;
        let volumeId: string | undefined;
        try {
          const volume = await settle(
            subject,
            () =>
              volumes.ensureVolume(
                {
                  name: key(subject, 'snapvol'),
                  region: regionOf(subject, machine),
                  sizeGiB: subject.volumeGiB ?? 10,
                  kind: 'block',
                },
                call('snapvol-ensure'),
              ),
            ['ready'],
            'ensureVolume',
          );
          volumeId = volume.id;
          const name = key(subject, 'snap');
          const snapshot = await settle(
            subject,
            () => volumes.snapshotVolume(volume.id, name, call('snap')),
            ['ready'],
            'snapshotVolume',
          );
          const again = await volumes.snapshotVolume(volume.id, name, call('snap-again'));
          checkEqual(again.id, snapshot.id, 'a second snapshot of the same name is the same one');
          checkResource(await volumes.getSnapshot(snapshot.id, call('snap-get')), 'getSnapshot');
          await settle(
            subject,
            () => volumes.deleteSnapshot(snapshot.id, call('snap-delete')),
            ['deleted'],
            'deleteSnapshot',
          );
          checkEqual(
            (await volumes.deleteSnapshot(snapshot.id, call('snap-delete-again'))).state,
            'deleted',
            'deleting a deleted snapshot counts as deleted',
          );
        } finally {
          if (volumeId !== undefined)
            await volumes.deleteVolume(volumeId, call('snapvol-cleanup')).catch(() => {});
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'shared volumes (when offered, opt-in): many machines of a network attach one, delete waits for all',
      async run(subject) {
        const probe = await client(subject);
        const offered =
          subject.sharedVolumes === true &&
          probe.impl.networks !== undefined &&
          (probe.impl.volumes?.kinds ?? []).includes('shared');
        if (!offered) return;
        const { impl, call } = probe;
        const volumes = impl.volumes!;
        const networks = impl.networks!;
        const slash = subject.offerId.indexOf('/');
        const region = subject.region ?? (slash > 0 ? subject.offerId.slice(0, slash) : undefined);
        check(region !== undefined, 'the subject names no region and its offer id none');
        const network = key(subject, 'share-net');
        const subnet = key(subject, 'share-subnet');
        const networkSettle = (
          step: () => Promise<{ id: string; state: string; message?: string }>,
          what: string,
        ) => settle(subject, step as () => Promise<ProviderResourceState>, ['ready'], what);
        const machines: ExternalMachine[] = [];
        let volumeId: string | undefined;
        try {
          await networkSettle(
            () => networks.ensureNetwork({ name: network }, call('share-net')),
            'ensureNetwork',
          );
          await networkSettle(
            () =>
              networks.ensureSubnet(
                {
                  network,
                  name: subnet,
                  region,
                  cidr: subject.sharedVolumeCidr ?? '10.200.0.0/24',
                },
                call('share-subnet'),
              ),
            'ensureSubnet',
          );
          for (const which of ['a', 'b']) {
            const name = key(subject, `share-host-${which}`);
            machines.push(
              await impl.create(
                {
                  offerId: subject.offerId,
                  image: subject.image,
                  userData: '#cloud-config\n',
                  name,
                  network: { network, subnet },
                },
                call(name),
              ),
            );
          }
          const spec = {
            name: key(subject, 'share'),
            region,
            sizeGiB: subject.sharedVolumeGiB ?? 50,
            kind: 'shared' as const,
            network: { network },
          };
          const ensured = await settle(
            subject,
            () => volumes.ensureVolume(spec, call('share-ensure')),
            ['ready'],
            'ensureVolume (shared)',
          );
          volumeId = ensured.id;
          const id = ensured.id;
          checkEqual(ensured.outputs?.kind, 'shared', 'a shared volume reports its kind');
          checkEqual(
            (await volumes.ensureVolume(spec, call('share-ensure-again'))).id,
            id,
            'a second ensure of the same shared volume returns it',
          );
          if (volumes.findVolume)
            checkEqual(
              (await volumes.findVolume(spec.name, region, call('share-find'), 'shared'))?.id,
              id,
              'findVolume with kind shared finds the share',
            );
          for (const machine of machines) {
            const attached = await settle(
              subject,
              () => volumes.attachVolume(id, machine.id, call(`share-attach-${machine.id}`)),
              ['ready'],
              'attachVolume (shared)',
            );
            checkEqual(
              attached.outputs?.attachedTo,
              machine.id,
              'a shared attach names the machine it made it reachable from',
            );
          }
          const both = await volumes.getVolume(id, call('share-get'));
          checkResource(both, 'getVolume (shared)');
          check(
            both?.outputs?.attachedTo === undefined,
            'a shared volume on many machines names none of them',
          );
          check(
            typeof both?.outputs?.device === 'string' && both.outputs.device.includes(':/'),
            'a shared volume reports its NFS source as device (<host>:<path>)',
          );
          await checkRejects(
            () => volumes.deleteVolume(id, call('share-delete-attached')),
            'INVALID_STATE',
            'deleting a shared volume a machine still has attached',
          );
          for (const machine of machines)
            await settle(
              subject,
              () => volumes.detachVolume(id, machine.id, call(`share-detach-${machine.id}`)),
              ['deleted'],
              'detachVolume (shared)',
            );
          await settle(
            subject,
            () => volumes.deleteVolume(id, call('share-delete')),
            ['deleted'],
            'deleteVolume (shared)',
          );
          volumeId = undefined;
        } finally {
          if (volumeId !== undefined) {
            for (const machine of machines)
              await volumes
                .detachVolume(volumeId, machine.id, call(`share-cleanup-detach-${machine.id}`))
                .catch(() => {});
            await volumes.deleteVolume(volumeId, call('share-cleanup')).catch(() => {});
          }
          for (const machine of machines) await cleanUp(impl, call, machine.id);
          await networks.deleteSubnet(region, subnet, call('share-subnet-cleanup')).catch(() => {});
          await networks.deleteNetwork(network, call('share-net-cleanup')).catch(() => {});
        }
      },
    },
    {
      name: 'volumes and addresses (when offered): a second machine is CONFLICT while on the first',
      async run(subject) {
        const probe = await client(subject);
        const offered = probe.impl.volumes ?? probe.impl.addresses;
        if (!offered) return;
        const { impl, call, machine } = await create(subject, key(subject, 'conflict-host'));
        const other = await impl.create(
          { offerId: subject.offerId, image: subject.image, userData: '#cloud-config\n', name: key(subject, 'conflict-other') },
          call(key(subject, 'conflict-other')),
        );
        const volumes = impl.volumes;
        const addresses = impl.addresses;
        let volumeId: string | undefined;
        let addressId: string | undefined;
        try {
          const region = regionOf(subject, machine);
          if (volumes) {
            const volume = await settle(
              subject,
              () =>
                volumes.ensureVolume(
                  { name: key(subject, 'conflict-vol'), region, sizeGiB: subject.volumeGiB ?? 10, kind: 'block' },
                  call('conflict-vol'),
                ),
              ['ready'],
              'ensureVolume',
            );
            volumeId = volume.id;
            await settle(
              subject,
              () => volumes.attachVolume(volume.id, machine.id, call('conflict-attach')),
              ['ready'],
              'attachVolume',
            );
            await checkRejects(
              () => volumes.attachVolume(volume.id, other.id, call('conflict-attach-other')),
              'CONFLICT',
              'attaching a volume attached to another machine',
            );
            checkEqual(
              (await volumes.getVolume(volume.id, call('conflict-get')))?.outputs?.attachedTo,
              machine.id,
              'a refused attach leaves the volume on its machine',
            );
          }
          if (addresses) {
            const address = await settle(
              subject,
              () =>
                addresses.ensureAddress(
                  { name: key(subject, 'conflict-addr'), region, family: 'ipv4' },
                  call('conflict-addr'),
                ),
              ['ready'],
              'ensureAddress',
            );
            addressId = address.id;
            await settle(
              subject,
              () => addresses.assignAddress(address.id, machine.id, call('conflict-assign')),
              ['ready'],
              'assignAddress',
            );
            await checkRejects(
              () => addresses.assignAddress(address.id, other.id, call('conflict-assign-other')),
              'CONFLICT',
              'assigning an address assigned to another machine',
            );
            checkEqual(
              (await addresses.getAddress(address.id, call('conflict-get-addr')))?.outputs?.assignedTo,
              machine.id,
              'a refused assign leaves the address on its machine',
            );
          }
        } finally {
          if (volumes && volumeId !== undefined) {
            await settle(
              subject,
              () => volumes.detachVolume(volumeId!, machine.id, call('conflict-detach')),
              ['deleted'],
              'detachVolume',
            ).catch(() => {});
            await volumes.deleteVolume(volumeId, call('conflict-vol-cleanup')).catch(() => {});
          }
          if (addresses && addressId !== undefined) {
            await settle(
              subject,
              () => addresses.unassignAddress(addressId!, call('conflict-unassign')),
              ['deleted'],
              'unassignAddress',
            ).catch(() => {});
            await addresses.deleteAddress(addressId, call('conflict-addr-cleanup')).catch(() => {});
          }
          await cleanUp(impl, call, other.id);
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'volumes and addresses (when offered): a machine in another region is INVALID_INPUT',
      async run(subject) {
        const probe = await client(subject);
        const offered = probe.impl.volumes ?? probe.impl.addresses;
        if (!offered || subject.otherRegionOfferId === undefined) return;
        const { impl, call, machine } = await create(subject, key(subject, 'region-host'));
        const foreign = await impl.create(
          {
            offerId: subject.otherRegionOfferId,
            image: subject.image,
            userData: '#cloud-config\n',
            name: key(subject, 'region-foreign'),
          },
          call(key(subject, 'region-foreign')),
        );
        const volumes = impl.volumes;
        const addresses = impl.addresses;
        let volumeId: string | undefined;
        let addressId: string | undefined;
        try {
          const region = regionOf(subject, machine);
          check(
            foreign.region === undefined || foreign.region !== region,
            `otherRegionOfferId made a machine in ${String(foreign.region)}, the volumes' own region`,
          );
          if (volumes) {
            const volume = await settle(
              subject,
              () =>
                volumes.ensureVolume(
                  { name: key(subject, 'region-vol'), region, sizeGiB: subject.volumeGiB ?? 10, kind: 'block' },
                  call('region-vol'),
                ),
              ['ready'],
              'ensureVolume',
            );
            volumeId = volume.id;
            await checkRejects(
              () => volumes.attachVolume(volume.id, foreign.id, call('region-attach')),
              'INVALID_INPUT',
              'attaching a volume to a machine in another region',
            );
            check(
              (await volumes.getVolume(volume.id, call('region-get')))?.outputs?.attachedTo === undefined,
              'a refused attach attaches nothing',
            );
          }
          if (addresses) {
            const address = await settle(
              subject,
              () =>
                addresses.ensureAddress(
                  { name: key(subject, 'region-addr'), region, family: 'ipv4' },
                  call('region-addr'),
                ),
              ['ready'],
              'ensureAddress',
            );
            addressId = address.id;
            await checkRejects(
              () => addresses.assignAddress(address.id, foreign.id, call('region-assign')),
              'INVALID_INPUT',
              'assigning an address to a machine in another region',
            );
            check(
              (await addresses.getAddress(address.id, call('region-get-addr')))?.outputs?.assignedTo ===
                undefined,
              'a refused assign assigns nothing',
            );
          }
        } finally {
          if (volumes && volumeId !== undefined)
            await volumes.deleteVolume(volumeId, call('region-vol-cleanup')).catch(() => {});
          if (addresses && addressId !== undefined)
            await addresses.deleteAddress(addressId, call('region-addr-cleanup')).catch(() => {});
          await cleanUp(impl, call, foreign.id);
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'volumes and addresses (when offered): a delete refuses what this deployment did not make',
      async run(subject) {
        const { impl, call } = await client(subject);
        const volumes = impl.volumes;
        const addresses = impl.addresses;
        if (!volumes && !addresses) return;
        const foreign = subject.foreign ?? {};
        if (volumes && foreign.volumeId !== undefined) {
          const id = foreign.volumeId;
          checkResource(await volumes.getVolume(id, call('foreign-vol-get')), "the subject's foreign volume");
          await checkRejects(
            () => volumes.deleteVolume(id, call('foreign-vol-delete')),
            'INVALID_STATE',
            'deleting a volume this deployment did not make',
          );
          const after = await volumes.getVolume(id, call('foreign-vol-after'));
          check(
            after !== undefined && after.state !== 'deleting' && after.state !== 'deleted',
            'a refused delete leaves the volume',
          );
        }
        if (volumes && foreign.snapshotId !== undefined) {
          const id = foreign.snapshotId;
          checkResource(await volumes.getSnapshot(id, call('foreign-snap-get')), "the subject's foreign snapshot");
          await checkRejects(
            () => volumes.deleteSnapshot(id, call('foreign-snap-delete')),
            'INVALID_STATE',
            'deleting a snapshot this deployment did not make',
          );
          const after = await volumes.getSnapshot(id, call('foreign-snap-after'));
          check(
            after !== undefined && after.state !== 'deleting' && after.state !== 'deleted',
            'a refused delete leaves the snapshot',
          );
        }
        if (!addresses) return;
        // An address that does not match what was recorded (here: its region) is another reservation: never released.
        const region =
          subject.region ?? (await impl.listOffers({})).find((offer) => offer.id === subject.offerId)?.region;
        if (region === undefined) return;
        let addressId: string | undefined;
        try {
          const address = await settle(
            subject,
            () =>
              addresses.ensureAddress(
                { name: key(subject, 'owner-addr'), region, family: 'ipv4' },
                call('owner-addr'),
              ),
            ['ready'],
            'ensureAddress',
          );
          addressId = address.id;
          await checkRejects(
            () =>
              addresses.deleteAddress(address.id, call('owner-addr-delete'), {
                region: `${region}-elsewhere`,
              }),
            'INVALID_STATE',
            'releasing an address that does not match what this deployment recorded',
          );
          const after = await addresses.getAddress(address.id, call('owner-addr-after'));
          check(
            after !== undefined && after.state !== 'deleting' && after.state !== 'deleted',
            'a refused release leaves the address',
          );
        } finally {
          if (addressId !== undefined)
            await addresses
              .deleteAddress(addressId, call('owner-addr-cleanup'), { region })
              .catch(() => {});
        }
      },
    },
    {
      name: 'addresses (when offered): reserve, assign, unassign, delete',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.addresses) return;
        const { impl, call, machine } = await create(subject, key(subject, 'address-host'));
        const addresses = impl.addresses!;
        let addressId: string | undefined;
        try {
          const spec = {
            name: key(subject, 'addr'),
            region: regionOf(subject, machine),
            family: 'ipv4' as const,
          };
          const reserved = await settle(
            subject,
            () => addresses.ensureAddress(spec, call('addr-ensure')),
            ['ready'],
            'ensureAddress',
          );
          const id = reserved.id;
          addressId = id;
          check(
            typeof reserved.outputs?.address === 'string' && reserved.outputs.address !== '',
            'a reserved address reports its address',
          );
          const again = await addresses.ensureAddress({ ...spec, id }, call('addr-ensure-again'));
          checkEqual(again.id, id, 'ensuring with the returned id returns the same address');
          await settle(
            subject,
            () => addresses.assignAddress(id, machine.id, call('addr-assign')),
            ['ready'],
            'assignAddress',
          );
          checkEqual(
            (await addresses.getAddress(id, call('addr-get')))?.outputs?.assignedTo,
            machine.id,
            'the address names its machine',
          );
          await checkRejects(
            () => addresses.deleteAddress(id, call('addr-delete-assigned')),
            'INVALID_STATE',
            'deleting an assigned address',
          );
          await settle(
            subject,
            () => addresses.unassignAddress(id, call('addr-unassign')),
            ['deleted'],
            'unassignAddress',
          );
          await settle(
            subject,
            () => addresses.deleteAddress(id, call('addr-delete')),
            ['deleted'],
            'deleteAddress',
          );
          addressId = undefined;
          checkEqual(
            (await addresses.deleteAddress(id, call('addr-delete-again'))).state,
            'deleted',
            'deleting a deleted address counts as deleted',
          );
        } finally {
          if (addressId !== undefined) {
            await addresses
              .unassignAddress(addressId, call('addr-cleanup-unassign'))
              .catch(() => {});
            await addresses.deleteAddress(addressId, call('addr-cleanup')).catch(() => {});
          }
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'load balancers (when offered): a regional one in front of a machine, changed in place, deleted',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.loadBalancers) return;
        const { impl, call, machine } = await create(subject, key(subject, 'lb-host'));
        const lbs = impl.loadBalancers!;
        let lbId: string | undefined;
        try {
          const region = regionOf(subject, machine);
          const spec = {
            name: key(subject, 'lb'),
            scope: 'regional' as const,
            region,
            forwarding: [
              { entryProtocol: 'http', entryPort: 80, targetProtocol: 'http', targetPort: 80 },
            ] as const,
            healthCheck: { protocol: 'tcp' as const, port: 80 },
            targets: { machines: [machine.id] },
          };
          const made = await settle(
            subject,
            () => lbs.ensureLoadBalancer(spec, call('lb-ensure')),
            ['ready'],
            'ensureLoadBalancer',
          );
          const id = made.id;
          lbId = id;
          checkEqual(made.outputs?.scope, 'regional', 'a load balancer reports its scope');
          checkEqual(made.outputs?.region, region, 'a regional load balancer reports its region');
          const again = await lbs.ensureLoadBalancer({ ...spec, id }, call('lb-ensure-again'));
          checkEqual(again.id, id, 'ensuring again returns the same load balancer');
          const byName = await lbs.ensureLoadBalancer(spec, call('lb-ensure-by-name'));
          checkEqual(byName.id, id, 'ensuring by name alone returns the same load balancer');
          const changed = await settle(
            subject,
            () =>
              lbs.ensureLoadBalancer(
                {
                  ...spec,
                  id,
                  forwarding: [
                    {
                      entryProtocol: 'http',
                      entryPort: 8080,
                      targetProtocol: 'http',
                      targetPort: 80,
                    },
                  ],
                },
                call('lb-change'),
              ),
            ['ready'],
            'ensureLoadBalancer (changed forwarding)',
          );
          checkEqual(changed.id, id, 'a forwarding change keeps the load balancer');
          await checkRejects(
            () =>
              lbs.ensureLoadBalancer(
                { ...spec, id, internal: true },
                call('lb-change-internal'),
              ),
            'INVALID_STATE',
            'making a public load balancer internal in place',
          );
          checkResource(await lbs.getLoadBalancer(id, call('lb-get')), 'getLoadBalancer');
          await settle(
            subject,
            () => lbs.deleteLoadBalancer(id, call('lb-delete')),
            ['deleted'],
            'deleteLoadBalancer',
          );
          lbId = undefined;
          checkEqual(
            (await lbs.deleteLoadBalancer(id, call('lb-delete-again'))).state,
            'deleted',
            'deleting a deleted load balancer counts as deleted',
          );
          const gone = await lbs.getLoadBalancer(id, call('lb-get-deleted'));
          check(
            gone === undefined || gone.state === 'deleting' || gone.state === 'deleted',
            'getLoadBalancer after delete finds nothing live',
          );
        } finally {
          if (lbId !== undefined)
            await lbs.deleteLoadBalancer(lbId, call('lb-cleanup')).catch(() => {});
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'load balancers (when offered): a target machine in another region is INVALID_INPUT',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.loadBalancers || subject.otherRegionOfferId === undefined) return;
        const { impl, call, machine } = await create(subject, key(subject, 'lb-region-host'));
        const lbs = impl.loadBalancers!;
        let foreign: ExternalMachine | undefined;
        try {
          foreign = await impl.create(
            {
              offerId: subject.otherRegionOfferId,
              image: subject.image,
              userData: '#cloud-config\n',
              name: key(subject, 'lb-region-foreign'),
            },
            call(key(subject, 'lb-region-foreign')),
          );
          const region = regionOf(subject, machine);
          const other = foreign;
          check(
            other.region === undefined || other.region !== region,
            'the other-region offer made a machine in another region',
          );
          await checkRejects(
            () =>
              lbs.ensureLoadBalancer(
                {
                  name: key(subject, 'lb-region'),
                  scope: 'regional',
                  region,
                  forwarding: [
                    { entryProtocol: 'tcp', entryPort: 80, targetProtocol: 'tcp', targetPort: 80 },
                  ],
                  targets: { machines: [other.id] },
                },
                call('lb-region-ensure'),
              ),
            'INVALID_INPUT',
            'a load balancer targeting a machine in another region',
          );
        } finally {
          if (foreign) await cleanUp(impl, call, foreign.id);
          await cleanUp(impl, call, machine.id);
        }
      },
    },
    {
      name: 'dns (when offered): a zone, a record found by name, type and data, changed in place, deleted',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.dns || subject.dnsZone === undefined) return;
        const { impl, call } = probe;
        const dns = impl.dns!;
        const zoneName = subject.dnsZone;
        let zone: string | undefined;
        let recordId: string | undefined;
        try {
          const made = await dns.ensureZone({ name: zoneName }, call('dns-zone'));
          checkResource(made, 'ensureZone');
          checkEqual(made.state, 'ready', 'a zone is ready when ensureZone returns');
          zone = made.id;
          checkEqual(
            (await dns.ensureZone({ name: zoneName }, call('dns-zone-again'))).id,
            zone,
            'ensuring a zone again returns the same zone',
          );
          const spec = {
            name: key(subject, 'rec'),
            type: 'A' as const,
            data: '192.0.2.10',
            ttlSeconds: 300,
          };
          const record = await dns.ensureRecord(zone, spec, call('dns-record'));
          checkResource(record, 'ensureRecord');
          checkEqual(record.state, 'ready', 'a record is ready when ensureRecord returns');
          const id = record.id;
          recordId = id;
          checkEqual(record.outputs?.data, '192.0.2.10', 'a record reports its data');
          checkEqual(
            (await dns.ensureRecord(zone, spec, call('dns-record-again'))).id,
            id,
            'ensuring the same name, type and data again returns the same record',
          );
          const changed = await dns.ensureRecord(
            zone,
            { ...spec, id, data: '192.0.2.11' },
            call('dns-record-change'),
          );
          checkEqual(changed.id, id, 'a data change keeps the record');
          checkEqual(
            (await dns.getRecord(zone, id, call('dns-record-get')))?.outputs?.data,
            '192.0.2.11',
            'the record reports its new data',
          );
          await checkRejects(
            () =>
              dns.ensureRecord(
                zone!,
                { ...spec, id, name: key(subject, 'rec-other') },
                call('dns-record-rename'),
              ),
            'INVALID_STATE',
            'ensuring a record id under another name',
          );
          await checkRejects(
            () =>
              dns.deleteRecord(zone!, id, call('dns-record-delete-other'), {
                name: spec.name,
                type: 'AAAA',
              }),
            'INVALID_STATE',
            'deleting a record that is not the one expected',
          );
          checkEqual(
            (
              await dns.deleteRecord(zone, id, call('dns-record-delete'), {
                name: spec.name,
                type: 'A',
              })
            ).state,
            'deleted',
            'deleteRecord',
          );
          recordId = undefined;
          checkEqual(
            (await dns.deleteRecord(zone, id, call('dns-record-delete-again'))).state,
            'deleted',
            'deleting a deleted record counts as deleted',
          );
          checkEqual(
            (await dns.deleteZone(zone, call('dns-zone-delete'))).state,
            'deleted',
            'deleteZone',
          );
          zone = undefined;
          checkEqual(
            (await dns.deleteZone(zoneName, call('dns-zone-delete-again'))).state,
            'deleted',
            'deleting a deleted zone counts as deleted',
          );
        } finally {
          if (zone !== undefined) {
            if (recordId !== undefined)
              await dns.deleteRecord(zone, recordId, call('dns-cleanup-record')).catch(() => {});
            await dns.deleteZone(zone, call('dns-cleanup-zone')).catch(() => {});
          }
        }
      },
    },
    {
      name: 'nat gateways (when offered): one per subnet by name; the subnet goes only after its gateway',
      async run(subject) {
        const probe = await client(subject);
        const networks = probe.impl.networks;
        if (!networks?.ensureNatGateway || !networks.deleteNatGateway) return;
        const { impl, call } = probe;
        const region =
          subject.region ??
          (await impl.listOffers({})).find((offer) => offer.id === subject.offerId)?.region;
        check(region !== undefined, 'the subject names no region and its offer reports none');
        const network = key(subject, 'nat-net');
        const subnet = key(subject, 'nat-sub');
        const name = key(subject, 'nat');
        const asResource = (step: () => Promise<{ id: string; state: string; message?: string }>) =>
          step as () => Promise<ProviderResourceState>;
        let made = false;
        try {
          await settle(
            subject,
            asResource(() => networks.ensureNetwork({ name: network }, call('nat-network'))),
            ['ready'],
            'ensureNetwork',
          );
          await settle(
            subject,
            asResource(() =>
              networks.ensureSubnet(
                { network, name: subnet, region, cidr: subject.natCidr ?? '10.250.0.0/24' },
                call('nat-subnet'),
              ),
            ),
            ['ready'],
            'ensureSubnet',
          );
          const spec = { name, network, subnet, region };
          const gateway = await settle(
            subject,
            () => networks.ensureNatGateway!(spec, call('nat-ensure')),
            ['ready'],
            'ensureNatGateway',
          );
          made = true;
          check(
            typeof gateway.outputs?.address === 'string' && gateway.outputs.address !== '',
            'a NAT gateway reports its egress address',
          );
          checkEqual(
            (await networks.ensureNatGateway!(spec, call('nat-ensure-again'))).id,
            gateway.id,
            'ensuring the gateway again returns the same gateway',
          );
          const early = await networks.deleteSubnet(region, subnet, call('nat-subnet-early'));
          check(early.state !== 'deleted', 'a subnet is not deleted while its NAT gateway exists');
          await settle(
            subject,
            () => networks.deleteNatGateway!(region, name, call('nat-delete')),
            ['deleted'],
            'deleteNatGateway',
          );
          made = false;
          checkEqual(
            (await networks.deleteNatGateway!(region, name, call('nat-delete-again'))).state,
            'deleted',
            'deleting a deleted gateway counts as deleted',
          );
          await settle(
            subject,
            asResource(() => networks.deleteSubnet(region, subnet, call('nat-subnet-delete'))),
            ['deleted'],
            'deleteSubnet',
          );
          await settle(
            subject,
            asResource(() => networks.deleteNetwork(network, call('nat-network-delete'))),
            ['deleted'],
            'deleteNetwork',
          );
        } finally {
          if (made) await networks.deleteNatGateway!(region, name, call('nat-cleanup')).catch(() => {});
          await networks.deleteSubnet(region, subnet, call('nat-cleanup-subnet')).catch(() => {});
          await networks.deleteNetwork(network, call('nat-cleanup-network')).catch(() => {});
        }
      },
    },
    {
      name: 'peerings (when offered): two subnets peered by name, deleted idempotently',
      async run(subject) {
        const probe = await client(subject);
        const networks = probe.impl.networks;
        if (!networks?.ensurePeering || !networks.deletePeering) return;
        const { impl, call } = probe;
        const region =
          subject.region ??
          (await impl.listOffers({})).find((offer) => offer.id === subject.offerId)?.region;
        check(region !== undefined, 'the subject names no region and its offer reports none');
        const network = key(subject, 'peer-net');
        const left = key(subject, 'peer-a');
        const right = key(subject, 'peer-b');
        const name = key(subject, 'peering');
        const asResource = (step: () => Promise<{ id: string; state: string; message?: string }>) =>
          step as () => Promise<ProviderResourceState>;
        let made = false;
        try {
          await settle(
            subject,
            asResource(() => networks.ensureNetwork({ name: network }, call('peer-network'))),
            ['ready'],
            'ensureNetwork',
          );
          for (const [subnet, cidr] of [
            [left, subject.peeringCidrs?.[0] ?? '10.251.0.0/24'],
            [right, subject.peeringCidrs?.[1] ?? '10.252.0.0/24'],
          ] as const)
            await settle(
              subject,
              asResource(() =>
                networks.ensureSubnet({ network, name: subnet, region, cidr }, call(`peer-${subnet}`)),
              ),
              ['ready'],
              'ensureSubnet',
            );
          const spec = {
            name,
            network,
            subnet: left,
            region,
            peer: { network, subnet: right, region },
          };
          const peering = await settle(
            subject,
            () => networks.ensurePeering!(spec, call('peer-ensure')),
            ['ready'],
            'ensurePeering',
          );
          made = true;
          checkEqual(
            (await networks.ensurePeering!(spec, call('peer-ensure-again'))).id,
            peering.id,
            'ensuring the peering again returns the same peering',
          );
          await settle(
            subject,
            () => networks.deletePeering!(name, call('peer-delete')),
            ['deleted'],
            'deletePeering',
          );
          made = false;
          checkEqual(
            (await networks.deletePeering!(name, call('peer-delete-again'))).state,
            'deleted',
            'deleting a deleted peering counts as deleted',
          );
        } finally {
          if (made) await networks.deletePeering!(name, call('peer-cleanup')).catch(() => {});
          for (const subnet of [left, right])
            await networks.deleteSubnet(region, subnet, call(`peer-cleanup-${subnet}`)).catch(() => {});
          await networks.deleteNetwork(network, call('peer-cleanup-network')).catch(() => {});
        }
      },
    },
    {
      name: 'routes (when offered): a subnet route by name, refused when changed, deleted before its subnet',
      async run(subject) {
        const probe = await client(subject);
        const networks = probe.impl.networks;
        if (!networks?.ensureRoute || !networks.deleteRoute) return;
        const { impl, call } = probe;
        const region =
          subject.region ??
          (await impl.listOffers({})).find((offer) => offer.id === subject.offerId)?.region;
        check(region !== undefined, 'the subject names no region and its offer reports none');
        const network = key(subject, 'route-net');
        const subnet = key(subject, 'route-sub');
        const name = key(subject, 'route');
        const cidr = subject.route?.cidr ?? '10.253.0.0/24';
        const hop = subject.route?.nextHop ?? '10.253.0.10';
        const asResource = (step: () => Promise<{ id: string; state: string; message?: string }>) =>
          step as () => Promise<ProviderResourceState>;
        const ref = { name, network, subnet, region };
        let made = false;
        try {
          await settle(
            subject,
            asResource(() => networks.ensureNetwork({ name: network }, call('route-network'))),
            ['ready'],
            'ensureNetwork',
          );
          await settle(
            subject,
            asResource(() =>
              networks.ensureSubnet({ network, name: subnet, region, cidr }, call('route-subnet')),
            ),
            ['ready'],
            'ensureSubnet',
          );
          const spec = {
            ...ref,
            destination: '192.0.2.0/24',
            nextHop: { kind: 'address' as const, id: hop },
          };
          const route = await settle(
            subject,
            () => networks.ensureRoute!(spec, call('route-ensure')),
            ['ready'],
            'ensureRoute',
          );
          made = true;
          checkEqual(
            (await networks.ensureRoute!(spec, call('route-ensure-again'))).id,
            route.id,
            'ensuring the route again returns the same route',
          );
          await checkRejects(
            () =>
              networks.ensureRoute!(
                { ...spec, destination: '198.51.100.0/24' },
                call('route-change'),
              ),
            'INVALID_STATE',
            'changing a route in place',
          );
          const early = await networks.deleteSubnet(region, subnet, call('route-subnet-early'));
          check(early.state !== 'deleted', 'a subnet is not deleted while a route of ours is in it');
          await settle(
            subject,
            () => networks.deleteRoute!(ref, call('route-delete')),
            ['deleted'],
            'deleteRoute',
          );
          made = false;
          checkEqual(
            (await networks.deleteRoute!(ref, call('route-delete-again'))).state,
            'deleted',
            'deleting a deleted route counts as deleted',
          );
          await settle(
            subject,
            asResource(() => networks.deleteSubnet(region, subnet, call('route-subnet-delete'))),
            ['deleted'],
            'deleteSubnet',
          );
        } finally {
          if (made) await networks.deleteRoute!(ref, call('route-cleanup')).catch(() => {});
          await networks.deleteSubnet(region, subnet, call('route-cleanup-subnet')).catch(() => {});
          await networks.deleteNetwork(network, call('route-cleanup-network')).catch(() => {});
        }
      },
    },
    {
      name: 'certificates (when offered): a custom certificate by name, deleted idempotently',
      async run(subject) {
        const probe = await client(subject);
        if (!probe.impl.certificates || subject.certificate === undefined) return;
        const { impl, call } = probe;
        const certificates = impl.certificates!;
        const spec = {
          name: key(subject, 'cert'),
          kind: 'custom' as const,
          certificate: subject.certificate.certificate,
          privateKey: subject.certificate.privateKey,
          ...(subject.certificate.chain !== undefined ? { chain: subject.certificate.chain } : {}),
        };
        let certId: string | undefined;
        try {
          const made = await settle(
            subject,
            () => certificates.ensureCertificate(spec, call('cert-ensure')),
            ['ready'],
            'ensureCertificate',
          );
          certId = made.id;
          checkEqual(made.outputs?.kind, 'custom', 'a certificate reports its kind');
          check(
            typeof made.outputs?.fingerprint === 'string' && made.outputs.fingerprint !== '',
            'a certificate reports its fingerprint',
          );
          check(
            !Object.values(made.outputs ?? {}).some((value) => value.includes('PRIVATE KEY')),
            'a certificate never reports its key',
          );
          checkEqual(
            (await certificates.ensureCertificate(spec, call('cert-ensure-again'))).id,
            made.id,
            'ensuring the same certificate again returns it',
          );
          await settle(
            subject,
            () => certificates.deleteCertificate(made.id, call('cert-delete')),
            ['deleted'],
            'deleteCertificate',
          );
          certId = undefined;
          checkEqual(
            (await certificates.deleteCertificate(made.id, call('cert-delete-again'))).state,
            'deleted',
            'deleting a deleted certificate counts as deleted',
          );
        } finally {
          if (certId !== undefined)
            await certificates.deleteCertificate(certId, call('cert-cleanup')).catch(() => {});
        }
      },
    },
  ];
}
