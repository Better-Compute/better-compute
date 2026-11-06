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

/** The provider context of a subject; `seen` collects every secret value it resolves (for the never-secret checks). */
function contextOf(subject: ProviderConformanceSubject, seen?: string[]): ProviderContext {
  const secrets = subject.context?.secrets ?? {
    resolve: async () => {
      throw new ComputeError('INVALID_CONFIG', 'The conformance subject gave no secret resolver');
    },
  };
  return {
    clock: subject.context?.clock ?? systemClock,
    log: subject.context?.log ?? quiet,
    secrets: seen
      ? {
          resolve: async (ref, context) => {
            const value = await secrets.resolve(ref, context);
            if (typeof value === 'string' && value.length >= 4) seen.push(value);
            return value;
          },
        }
      : secrets,
    ...(subject.context?.account ? { account: subject.context.account } : {}),
  };
}

async function configOf(subject: ProviderConformanceSubject): Promise<unknown> {
  const parsed = await subject.provider.config['~standard'].validate(subject.config);
  if ('issues' in parsed && parsed.issues)
    throw new ComputeError(
      'INVALID_CONFIG',
      `The subject's config does not validate: ${parsed.issues[0]?.message}`,
    );
  return (parsed as { value: unknown }).value;
}

async function client(
  subject: ProviderConformanceSubject,
  seen?: string[],
): Promise<{
  impl: ProviderImpl;
  call: (key: string) => CallContext;
}> {
  const context = contextOf(subject, seen);
  const impl = await subject.provider.create(await configOf(subject), context);
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

/** That `value` carries none of the secret values the provider resolved (`seen`). */
function checkNoSecret(value: unknown, seen: readonly string[], what: string): void {
  const text = JSON.stringify(value) ?? '';
  for (const secret of seen) check(!text.includes(secret), `${what} carries a secret value`);
}

const isJson = (value: unknown): boolean => {
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value);
  } catch {
    return false;
  }
};

const metricName = /^[a-z][a-z0-9_]{0,63}$/;
const priceResources = ['vcpu', 'memory', 'gpu', 'disk', 'ip', 'instance'];
const severities = ['critical', 'warning', 'info'];

/** What `run` throws, or undefined. */
async function thrown(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
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
    {
      name: 'listPrices (when offered) answers well-formed list prices',
      async run(subject) {
        const seen: string[] = [];
        const { impl, call } = await client(subject, seen);
        if (!impl.listPrices) return;
        const prices = await impl.listPrices({}, call('list-prices'));
        check(Array.isArray(prices), 'listPrices returns a list');
        for (const price of prices) {
          const what = `price ${String(price.sku)}`;
          check(priceResources.includes(price.resource), `${what}: resource is in the contract`);
          check(typeof price.region === 'string' && price.region !== '', `${what}: region is set`);
          check(
            Number.isSafeInteger(price.unitPriceMicros) && price.unitPriceMicros >= 0,
            `${what}: unitPriceMicros is a non-negative integer`,
          );
          check(
            price.unit === 'hour' || price.unit === 'gib-hour',
            `${what}: unit is in the contract`,
          );
          check(
            typeof price.currency === 'string' && price.currency !== '',
            `${what}: currency is set`,
          );
          check(typeof price.sku === 'string' && price.sku !== '', `${what}: sku is set`);
          check(typeof price.spot === 'boolean', `${what}: spot is a boolean`);
          if (price.resource === 'instance')
            check(
              typeof price.offerId === 'string' && price.offerId !== '' && price.unit === 'hour',
              `${what}: an instance price names its offer, per hour`,
            );
        }
        checkNoSecret(prices, seen, 'listPrices');
      },
    },
    {
      name: 'readMetrics (when offered) answers well-formed samples of the machines asked only',
      async run(subject) {
        const seen: string[] = [];
        const { impl } = await client(subject, seen);
        if (!impl.readMetrics) return;
        const asked = [
          {
            instance: 'bc-conformance-inst-1',
            machineId: subject.attachable ?? 'bc-conformance-missing-0',
          },
          { instance: 'bc-conformance-inst-2', machineId: 'bc-conformance-missing-0' },
        ];
        // A machine or metric the provider cannot read is left out, never an error.
        const samples = await impl.readMetrics(asked, { signal: new AbortController().signal });
        check(Array.isArray(samples), 'readMetrics returns a list');
        const instances = new Set(asked.map((machine) => machine.instance));
        for (const sample of samples) {
          check(instances.has(sample.instance), 'a sample names only an instance it was asked for');
          check(metricName.test(sample.metric), `${String(sample.metric)} is a metric name`);
          check(
            Number.isFinite(sample.value) && Number.isFinite(sample.at),
            `${sample.metric}: value and at are finite`,
          );
        }
        checkNoSecret(samples, seen, 'readMetrics');
      },
    },
    {
      name: 'probeAccount (when offered) answers a well-formed probe that holds no secret',
      async run(subject) {
        if (!subject.provider.probeAccount) return;
        const seen: string[] = [];
        const probe = await subject.provider.probeAccount(await configOf(subject), {
          ...contextOf(subject, seen),
          signal: new AbortController().signal,
        });
        check(typeof probe.ok === 'boolean', 'probe.ok is a boolean');
        check(
          Array.isArray(probe.missing) && probe.missing.every((name) => typeof name === 'string'),
          'probe.missing is a list of names',
        );
        check(
          probe.ok === (probe.missing.length === 0),
          'probe.ok exactly when nothing is missing',
        );
        if (probe.optional !== undefined)
          check(
            Array.isArray(probe.optional) &&
              probe.optional.every((name) => typeof name === 'string'),
            'probe.optional is a list of names',
          );
        if (probe.details !== undefined) check(isJson(probe.details), 'probe.details is JSON');
        checkNoSecret(probe, seen, 'probeAccount');
      },
    },
    {
      name: 'findings (when offered) are well formed, uniquely named and hold no secret',
      async run(subject) {
        if (!subject.provider.findings) return;
        const seen: string[] = [];
        const findings = await subject.provider.findings(await configOf(subject), {
          ...contextOf(subject, seen),
          signal: new AbortController().signal,
        });
        check(Array.isArray(findings), 'findings returns a list');
        const ids = new Set<string>();
        for (const finding of findings) {
          const what = `finding ${String(finding.id)}`;
          check(typeof finding.id === 'string' && finding.id !== '', 'finding.id is set');
          check(!ids.has(finding.id), `${what} is answered once`);
          ids.add(finding.id);
          check(typeof finding.kind === 'string' && finding.kind !== '', `${what}: kind is set`);
          check(severities.includes(finding.severity), `${what}: severity is in the contract`);
          check(typeof finding.title === 'string' && finding.title !== '', `${what}: title is set`);
          if (finding.at !== undefined) check(Number.isFinite(finding.at), `${what}: at is finite`);
        }
        checkNoSecret(findings, seen, 'findings');
      },
    },
    {
      name: 'billingSummary (when offered) answers integer amounts in a currency and holds no secret',
      async run(subject) {
        if (!subject.provider.billingSummary) return;
        const seen: string[] = [];
        const bill = await subject.provider.billingSummary(await configOf(subject), {
          ...contextOf(subject, seen),
          signal: new AbortController().signal,
        });
        check(/^[A-Z]{3}$/.test(bill.currency), 'billing.currency is an ISO 4217 code');
        for (const key of ['monthToDateMicros', 'balanceMicros', 'monthToDateUsageMicros'] as const)
          if (bill[key] !== undefined)
            check(Number.isSafeInteger(bill[key]), `billing.${key} is integer micros`);
        check(
          Array.isArray(bill.invoices) && Array.isArray(bill.history),
          'invoices and history are lists',
        );
        for (const invoice of bill.invoices)
          check(
            typeof invoice.id === 'string' &&
              /^\d{4}-\d{2}$/.test(invoice.period) &&
              Number.isSafeInteger(invoice.amountMicros),
            `invoice ${String(invoice.id)}: an id, a YYYY-MM period and integer micros`,
          );
        for (const entry of bill.history)
          check(
            Number.isFinite(entry.at) &&
              typeof entry.type === 'string' &&
              typeof entry.description === 'string' &&
              Number.isSafeInteger(entry.amountMicros),
            'a history entry has a time, a type, a description and integer micros',
          );
        checkNoSecret(bill, seen, 'billingSummary');
      },
    },
    {
      name: 'connect (when offered) refuses a redirect URI the platform did not register',
      async run(subject) {
        const connect = subject.provider.connect;
        if (!connect) return;
        check(typeof connect.field === 'string' && connect.field !== '', 'connect.field is set');
        const redirectUri = 'https://bc-conformance.invalid/not-registered';
        const refused = (error: unknown) => isComputeError(error, 'INVALID_INPUT');
        check(
          refused(
            await thrown(() =>
              connect.authorizeUrl({ redirectUri, state: 'bc-conformance-state-0123' }),
            ),
          ),
          'authorizeUrl refuses an unregistered redirect URI with INVALID_INPUT',
        );
        check(
          refused(
            await thrown(() =>
              connect.exchange({
                code: 'bc-conformance-code',
                redirectUri,
                clock: subject.context?.clock ?? systemClock,
                signal: new AbortController().signal,
              }),
            ),
          ),
          'exchange refuses an unregistered redirect URI with INVALID_INPUT',
        );
      },
    },
    {
      name: 'the billing hints (when given) are well formed',
      async run(subject) {
        const billing = subject.provider.billing;
        if (!billing) return;
        const probe = { service: '', sku: 'bc-conformance-unknown-sku', skuDescription: '' };
        for (const key of ['computeSku', 'meteredSku'] as const) {
          const matcher = billing[key];
          if (matcher === undefined) continue;
          check(typeof matcher === 'function', `billing.${key} is a function`);
          check(typeof matcher(probe) === 'boolean', `billing.${key} answers a boolean`);
        }
        for (const key of ['periodRows', 'billsStopped'] as const)
          if (billing[key] !== undefined)
            check(typeof billing[key] === 'boolean', `billing.${key} is a boolean`);
      },
    },
  ];
}
