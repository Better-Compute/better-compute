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
} from '@better-compute/core';
import { check, checkEqual, type ConformanceCase } from '@better-compute/core/conformance';

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
  ];
}
