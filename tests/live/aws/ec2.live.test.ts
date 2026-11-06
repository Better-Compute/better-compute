import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import {
  systemClock,
  type CallContext,
  type ExternalMachine,
  type Logger,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderImpl,
} from '@better-compute/core';
import { assertLiveInstanceType, liveGate, livePreflight, newTestRunId } from './support/live.js';
import { liveAws, type LiveAws, type LiveQueue } from './support/resources.js';

// AWS live (A12): provider-aws against real EC2 in the sandbox account. It covers the A1
// conformance cases, A2 tenant networks, A4 event intake through a real EventBridge rule, and a
// Spot interruption sent by AWS Fault Injection Service. It runs only behind the live gate and
// preflight (tests/live/aws/README.md), and only when @better-compute/provider-aws is installed.
//
// Spend guards: the provider's fetch is wrapped by `liveEc2Fetch` (fails closed: an EC2 action allow-list,
// t4g.nano / t3.micro only, one instance per launch and 20 per run, small gp3/gp2 volumes). Everything EC2
// creates is tagged with the run's tags the moment it exists and deleted in afterAll.
//
// Optional settings:
//   BETTER_COMPUTE_AWS_LIVE_ZONE            default `${region}a`
//   BETTER_COMPUTE_AWS_LIVE_INSTANCE_TYPE   t4g.nano (default) or t3.micro
//   BETTER_COMPUTE_AWS_LIVE_ATTACHABLE      an instance id the claim/discover cases may tag and untag
//   BETTER_COMPUTE_AWS_LIVE_FIS_ROLE_ARN    a role FIS assumes (ec2:SendSpotInstanceInterruptions,
//                                           ec2:DescribeInstances); without it the Spot case skips

/** The slice of @better-compute/provider-aws this file uses (the package is loaded dynamically). */
interface ProviderAwsModule {
  awsProvider(options?: { fetch?: typeof fetch; credentials?: unknown }): ProviderDefinition;
}

interface LiveNetworks {
  ensureNetwork(spec: { name: string; cidr?: string }, context: CallContext): Promise<{ id: string; state: string }>;
  ensureSubnet(spec: { network: string; name: string; region: string; cidr: string; zone?: string }, context: CallContext): Promise<{ id: string; state: string }>;
  ensureFirewall(
    spec: {
      network: string;
      name: string;
      direction: 'ingress' | 'egress';
      action: 'allow' | 'deny';
      priority: number;
      rules: { protocol: 'tcp' | 'udp' | 'icmp' | 'all'; ports?: string[] }[];
      sources?: string[];
    },
    context: CallContext,
  ): Promise<{ id: string; state: string }>;
  deleteNetwork(name: string, context: CallContext): Promise<{ id: string; state: string }>;
  deleteSubnet(region: string, name: string, context: CallContext): Promise<{ id: string; state: string }>;
  deleteFirewall(name: string, context: CallContext): Promise<{ id: string; state: string }>;
}

interface LiveProviderEvent {
  id: string;
  kind: string;
  machineId?: string;
  deadline?: number;
}

type LiveImpl = ProviderImpl & {
  networks?: LiveNetworks;
  pollEvents?(context: CallContext, options: { waitMs: number; max: number }): Promise<{ events: readonly LiveProviderEvent[]; ack(): Promise<void> }>;
};

const specifier = '@better-compute/provider-aws';

/** provider-aws, or undefined when it is not in this checkout (its lane has not landed). */
async function loadProviderAws(): Promise<ProviderAwsModule | undefined> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as ProviderAwsModule;
  } catch (error) {
    if (error instanceof Error && error.message.includes(specifier)) return undefined;
    throw error;
  }
}

const gate = liveGate();
const providerAws = gate.enabled ? await loadProviderAws() : undefined;
const env = process.env;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe.skipIf(!gate.enabled || !providerAws)('AWS live: EC2 through provider-aws', () => {
  const config = gate.enabled ? gate.config : (undefined as never);
  const runId = newTestRunId();
  const name = `bc-live-${runId}`;
  let aws: LiveAws | undefined;
  /** EC2 events on the default bus (state changes, Spot warnings, rebalance) reach this queue. */
  let eventQueue: LiveQueue | undefined;
  const launched: string[] = [];

  const secrets = {
    resolve: async (): Promise<string> => {
      // A platform account uses the host's (here: the sandbox) identity; it has no SecretRefs.
      throw new Error('the live suite has no secrets');
    },
  };
  const account = { id: 'pacct_live', tenantId: 'root', platform: true };
  const providerContext = (): ProviderContext => ({ clock: systemClock, secrets, log: quiet, account });
  const call = (key: string): CallContext => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    clock: systemClock,
    secrets,
    log: quiet,
  });

  const zone = () => env.BETTER_COMPUTE_AWS_LIVE_ZONE || `${config.region}a`;
  const instanceType = () => assertLiveInstanceType(env.BETTER_COMPUTE_AWS_LIVE_INSTANCE_TYPE || 't4g.nano');
  const instanceArn = (id: string) => `arn:aws:ec2:${config.region}:${config.account}:instance/${id}`;

  function definition(): ProviderDefinition {
    return providerAws!.awsProvider({ fetch: aws!.ec2Fetch(), credentials: config.credentials });
  }

  /** A client for `extra` account config, or undefined when this provider-aws does not know a key yet. */
  async function client(extra: Record<string, unknown> = {}): Promise<LiveImpl | undefined> {
    const provider = definition();
    const parsed = await provider.config['~standard'].validate({ region: config.region, zones: [zone()], ...extra });
    if ('issues' in parsed && parsed.issues) return undefined;
    return (await provider.create((parsed as { value: unknown }).value, providerContext())) as LiveImpl;
  }

  async function until<T>(what: string, step: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, intervalMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await step();
      if (done(value)) return value;
      if (Date.now() >= deadline) throw new Error(`${what}: not done after ${timeoutMs / 1000}s`);
      await sleep(intervalMs);
    }
  }

  async function launch(impl: LiveImpl, offerId: string, key: string): Promise<ExternalMachine> {
    const machine = await impl.create({ offerId, image: 'ubuntu-24.04', userData: '#cloud-config\n', name: key }, call(key));
    launched.push(machine.id);
    return until('the instance to run', () => impl.get(machine.id, call(`${key}-get`)), (m) => m?.state === 'running', 5 * 60_000) as Promise<ExternalMachine>;
  }

  async function remove(impl: LiveImpl, id: string, key: string): Promise<void> {
    await impl.delete(id, call(`${key}-delete`)).catch(() => undefined);
  }

  /** Provider events about `machineId` of `kind`, through the account's intake (A4). */
  async function awaitEvent(impl: LiveImpl, machineId: string, kind: string, timeoutMs: number): Promise<LiveProviderEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const batch = await impl.pollEvents!(call(`${name}-poll`), { waitMs: 10_000, max: 10 });
      const found = batch.events.find((event) => event.machineId === machineId && event.kind === kind);
      await batch.ack();
      if (found) return found;
    }
    throw new Error(`no ${kind} event for ${machineId} within ${timeoutMs / 1000}s`);
  }

  beforeAll(async () => {
    await livePreflight(config);
    aws = liveAws(config, runId);
    // The A4 rule: EC2's own notifications on the default bus, into a queue only this rule may use.
    eventQueue = await aws.createQueue(`${name}-ec2-events`);
    const rule = await aws.createRule(
      'default',
      `${name}-ec2-events`,
      {
        source: ['aws.ec2'],
        'detail-type': ['EC2 Instance State-change Notification', 'EC2 Spot Instance Interruption Warning', 'EC2 Instance Rebalance Recommendation'],
      },
      eventQueue.arn,
    );
    await aws.allowEventBridge(eventQueue, rule);
  });

  afterAll(async () => {
    if (!aws) return;
    // Instances the provider launched are terminated first (rank order), then networking.
    for (const id of launched) aws.track(instanceArn(id));
    const report = await aws.cleanUp();
    expect(report.pending, 'resources left for the sweeper').toEqual([]);
    // Untagged resources were still deleted above; a crash would have left them to find by hand.
    expect(aws.untagged, 'EC2 resources the run could not tag').toEqual([]);
  });

  it('A1: provider-aws passes the ProviderImpl conformance cases', async () => {
    const report = await runConformance(providerConformanceCases(), () => ({
      provider: definition(),
      config: { region: config.region, zones: [zone()] },
      offerId: `${zone()}/${instanceType()}`,
      image: 'ubuntu-24.04',
      context: { account, secrets, clock: systemClock, log: quiet },
      prefix: name,
      ...(env.BETTER_COMPUTE_AWS_LIVE_ATTACHABLE ? { attachable: env.BETTER_COMPUTE_AWS_LIVE_ATTACHABLE } : {}),
    }));
    expect(report.failed.map((failure) => `${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`)).toEqual([]);
    expect(report.passed.length).toBeGreaterThan(0);
  });

  it('A2: a tenant network, zone subnet and firewall, created and deleted', async (context) => {
    const impl = await client();
    const networks = impl?.networks;
    if (!networks) return context.skip();
    const network = `${name}-net`;
    const subnet = `${name}-sub`;
    const firewall = `${name}-ssh`;
    const ready = (state: { state: string }) => state.state === 'ready';
    const gone = (state: { state: string }) => state.state === 'deleted';
    const net = await until('the VPC', () => networks.ensureNetwork({ name: network, cidr: '10.77.0.0/16' }, call(`${network}-ensure`)), ready, 3 * 60_000);
    expect(net.id).toMatch(/^vpc-[0-9a-f]+$/);
    const sub = await until(
      'the subnet',
      () => networks.ensureSubnet({ network, name: subnet, region: config.region, cidr: '10.77.1.0/24', zone: zone() }, call(`${subnet}-ensure`)),
      ready,
      3 * 60_000,
    );
    expect(sub.id).toMatch(/^subnet-[0-9a-f]+$/);
    await until(
      'the firewall',
      () =>
        networks.ensureFirewall(
          { network, name: firewall, direction: 'ingress', action: 'allow', priority: 1000, rules: [{ protocol: 'tcp', ports: ['22'] }], sources: ['192.0.2.0/24'] },
          call(`${firewall}-ensure`),
        ),
      ready,
      3 * 60_000,
    );
    // Recorded by ec2Fetch as they were made; checked here so a missed create fails visibly.
    expect(aws!.created.some((arn) => arn.endsWith(`:vpc/${net.id}`))).toBe(true);
    expect(aws!.created.some((arn) => arn.endsWith(`:subnet/${sub.id}`))).toBe(true);

    await until('the firewall to go', () => networks.deleteFirewall(firewall, call(`${firewall}-delete`)), gone, 3 * 60_000);
    await until('the subnet to go', () => networks.deleteSubnet(config.region, subnet, call(`${subnet}-delete`)), gone, 3 * 60_000);
    await until('the VPC to go', () => networks.deleteNetwork(network, call(`${network}-delete`)), gone, 5 * 60_000);
  });

  it('A4: EC2 state changes reach the account through a real EventBridge rule', async () => {
    const intake = await client({ eventQueueUrl: eventQueue!.url });
    const impl = intake ?? (await client());
    const key = `${name}-events`;
    const machine = await launch(impl!, `${zone()}/${instanceType()}`, key);
    try {
      if (intake?.pollEvents) {
        // A4 landed: the provider reads the queue and maps the envelope itself.
        const event = await awaitEvent(intake, machine.id, 'machine-changed', 5 * 60_000);
        expect(event.id).toBeTruthy();
      } else {
        // Before A4: the rule and queue still prove EventBridge delivers EC2's notifications.
        const message = await aws!.receive(
          eventQueue!,
          (m) => (JSON.parse(m.body) as { detail?: { 'instance-id'?: string } }).detail?.['instance-id'] === machine.id,
          5 * 60_000,
        );
        expect((JSON.parse(message.body) as { 'detail-type'?: string })['detail-type']).toBe('EC2 Instance State-change Notification');
      }
    } finally {
      await remove(impl!, machine.id, key);
    }
  });

  it('A3/A4: a Spot interruption sent by FIS arrives as an interruption warning', async (context) => {
    const role = env.BETTER_COMPUTE_AWS_LIVE_FIS_ROLE_ARN;
    if (!role) return context.skip();
    const impl = await client({ spot: true, eventQueueUrl: eventQueue!.url });
    if (!impl?.pollEvents) return context.skip();
    const key = `${name}-spot`;
    let machine: ExternalMachine;
    try {
      machine = await launch(impl, `${zone()}/${instanceType()}:spot`, key);
    } catch (error) {
      // Spot offers arrive with A3; before it, the provider refuses them as UNSUPPORTED.
      if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'UNSUPPORTED') return context.skip();
      throw error;
    }
    try {
      const template = await aws!.createSpotInterruptionTemplate(instanceArn(machine.id), role);
      await aws!.startExperiment(template);
      const warning = await awaitEvent(impl, machine.id, 'interruption-warning', 6 * 60_000);
      // Two minutes' notice: the deadline is in the future of the warning, at most a few minutes out.
      expect(warning.deadline).toBeGreaterThan(Date.now() - 5 * 60_000);
    } finally {
      await remove(impl, machine.id, key);
    }
  });
});
