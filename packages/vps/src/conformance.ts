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
  ];
}
