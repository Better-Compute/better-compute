import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import { systemClock, type CallContext, type ProviderContext } from '@better-compute/core';
import {
  baseFirewallName,
  deploymentTag,
  digitaloceanProvider,
  labels,
  networkHash,
  networkMemberTag,
  probeAccount,
  type DoCompute,
  type DoConfig,
} from '@better-compute/provider-digitalocean';

// provider-digitalocean against a real DigitalOcean account. It is OFF unless BC_DO_LIVE and
// BC_DO_TOKEN are both set: it creates (and always sweeps) billable Droplets.
//
//   BC_DO_LIVE=1 BC_DO_TOKEN=<token> BC_DO_SSH_KEY_FINGERPRINT=<md5 fingerprint of an account key> \
//     node node_modules/vitest/vitest.mjs run tests/live/digitalocean.live.test.ts
//
// Optional: BC_DO_REGION (nyc3), BC_DO_SIZE (s-1vcpu-512mb-10gb), BC_DO_IMAGE (ubuntu-24-04-x64),
// BC_DO_ATTACHABLE (the id of a hand-made Droplet that the claim and discover cases may tag and
// untag; without it they are skipped).
//
// Every resource carries this run's identity: Droplets the deployment tag of `live-<hex>`,
// networks, VPCs and rules the name prefix `bc-live-<hex>-`. The sweeper deletes only what carries
// it, then asserts nothing does.

const env = process.env;
const flag = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
const enabled = flag(env.BC_DO_LIVE) && Boolean(env.BC_DO_TOKEN);

const endpoint = 'https://api.digitalocean.com/v2';
const run = randomBytes(4).toString('hex');
const deployment = `live-${run}`;
const prefix = `bc-live-${run}`;
const deployTag = deploymentTag(deployment);
const managedTag = `${labels.managed}:true`;

const region = env.BC_DO_REGION || 'nyc3';
const size = env.BC_DO_SIZE || 's-1vcpu-512mb-10gb';
const image = env.BC_DO_IMAGE || 'ubuntu-24-04-x64';
const attachable = env.BC_DO_ATTACHABLE || undefined;

const networkName = `${prefix}-net`;
const subnetName = `${prefix}-sub`;
const ruleName = `${prefix}-rule`;
// A /24 inside 10.100.0.0/14, picked from the run so two runs rarely collide. DO's own default
// VPCs sit in 10.x ranges too: a clash is a clear 422 from the subnet call, not a silent reuse.
const subnetCidr = `10.${100 + (parseInt(run.slice(0, 2), 16) % 4)}.${parseInt(run.slice(2, 4), 16)}.0/24`;

const secretRef = 'secret://do/live';
const token = env.BC_DO_TOKEN ?? '';
const secrets = {
  resolve: async (ref: string): Promise<string> => {
    if (ref === secretRef) return token;
    throw new Error('the live suite has no such secret');
  },
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const account = { id: 'pacct_live', tenantId: 'root', platform: true };
const providerContext: ProviderContext = { clock: systemClock, secrets, log: quiet, account };

const call = (key: string): CallContext => ({
  idempotencyKey: key,
  signal: new AbortController().signal,
  clock: systemClock,
  secrets,
  log: quiet,
});

// ---------------------------------------------------------------------------------- accounting

let requests = 0;
let lowestRemaining: number | undefined;

/** Every request this suite makes (the provider's and the sweeper's) goes through here. */
const observedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  requests += 1;
  const remaining = Number(response.headers.get('ratelimit-remaining'));
  if (response.headers.get('ratelimit-remaining') !== null && Number.isFinite(remaining))
    lowestRemaining =
      lowestRemaining === undefined ? remaining : Math.min(lowestRemaining, remaining);
  return response;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `step` until `done` accepts what it returns, or `timeoutMs` of real time has passed. */
async function until<T>(
  what: string,
  step: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (done(value)) return value;
    if (Date.now() >= deadline)
      throw new Error(
        `${what}: not done after ${timeoutMs / 1000}s (last: ${JSON.stringify(value)})`,
      );
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------------- sweeper

interface Page {
  links?: { pages?: { next?: string } };
}

/** A plain call to the API with the run's token; only the sweeper and the checks use it. */
async function api<T = Record<string, unknown>>(
  method: 'GET' | 'DELETE',
  path: string,
  okStatuses: readonly number[] = [200, 204],
): Promise<{ status: number; body: T | undefined }> {
  const response = await observedFetch(`${endpoint}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await response.text();
  if (!okStatuses.includes(response.status))
    throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
  return { status: response.status, body: text ? (JSON.parse(text) as T) : undefined };
}

/** Every item of a list, 200 a page, by page number (the endpoint is fixed: no link is followed). */
async function listAll<T>(path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 50; page += 1) {
    const { body } = await api<Page & Record<string, T[] | undefined>>(
      'GET',
      `${path}${sep}per_page=200&page=${page}`,
    );
    out.push(...(body?.[key] ?? []));
    if (!body?.links?.pages?.next) break;
  }
  return out;
}

interface Droplet {
  id: number;
  name: string;
  tags?: string[];
}
interface Firewall {
  id: string;
  name: string;
}
interface Vpc {
  id: string;
  name: string;
}

const lower = (tags: readonly string[] | undefined) => (tags ?? []).map((t) => t.toLowerCase());

/**
 * This run's Droplets: those with its deployment tag, ordinary and GPU alike. `type=gpus` can't be
 * combined with `tag_name` (research S2), so the GPU list is filtered here.
 */
async function runDroplets(): Promise<Droplet[]> {
  const tagged = await listAll<Droplet>(
    `/droplets?tag_name=${encodeURIComponent(deployTag)}`,
    'droplets',
  );
  const gpus = (await listAll<Droplet>('/droplets?type=gpus', 'droplets')).filter((d) =>
    lower(d.tags).includes(deployTag),
  );
  const byId = new Map<number, Droplet>();
  for (const droplet of [...tagged, ...gpus]) byId.set(droplet.id, droplet);
  return [...byId.values()];
}

/** The rule firewalls and the base firewall of this run's network, by name. */
const isRunFirewall = (firewall: Firewall): boolean =>
  firewall.name.startsWith(prefix) ||
  firewall.name === baseFirewallName(networkName) ||
  firewall.name.includes(`.n${networkHash(networkName)}.`);

const runFirewalls = async () =>
  (await listAll<Firewall>('/firewalls', 'firewalls')).filter(isRunFirewall);
const runVpcs = async () =>
  (await listAll<Vpc>('/vpcs', 'vpcs')).filter((v) => v.name.startsWith(`${prefix}-`));

/** Tags only this run could have made: its deployment and network tags, and any naming its hex. */
const runTag = (tag: string): boolean => {
  const t = tag.toLowerCase();
  return t === deployTag || t === networkMemberTag(networkName) || t.includes(run);
};
/** Per-Droplet tags (its instance, its create key) are the Droplet's alone, so they go with it. */
const dropletOwnTag = (tag: string): boolean => {
  const t = tag.toLowerCase();
  return t.startsWith(`${labels.instance}:`) || t.startsWith(`${labels.key}:`);
};

async function runTags(extra: ReadonlySet<string>): Promise<string[]> {
  const names = (await listAll<{ name: string }>('/tags', 'tags')).map((t) => t.name);
  return names.filter((name) => runTag(name) || extra.has(name.toLowerCase()));
}

/** Deletes a tag if nothing carries it any more. */
async function deleteIfEmpty(name: string): Promise<void> {
  const found = await api<{ tag?: { resources?: { count?: number } } }>(
    'GET',
    `/tags/${encodeURIComponent(name)}`,
    [200, 404],
  );
  if (found.status === 404 || (found.body?.tag?.resources?.count ?? 0) > 0) return;
  await api('DELETE', `/tags/${encodeURIComponent(name)}`, [200, 204, 404]);
}

/**
 * Deletes everything that carries the run's identity: Droplets first (a VPC with members won't
 * go), then firewalls, VPCs and empty tags. Returns what is still there afterwards.
 */
async function sweep(): Promise<Record<'droplets' | 'firewalls' | 'vpcs' | 'tags', string[]>> {
  const ownTags = new Set<string>();
  for (const droplet of await runDroplets()) {
    // The attachable Droplet is the user's, and the claim case tags it with this deployment: if its
    // release failed it stays, and the final check reports it so the user can clean it up.
    if (String(droplet.id) === attachable) continue;
    if (!lower(droplet.tags).includes(managedTag)) continue;
    for (const tag of droplet.tags ?? []) if (dropletOwnTag(tag)) ownTags.add(tag.toLowerCase());
    await api('DELETE', `/droplets/${droplet.id}`, [204, 404]);
  }
  await until(
    'the run Droplets to disappear',
    async () => (await runDroplets()).filter((d) => String(d.id) !== attachable).length,
    (count) => count === 0,
    120_000,
  );

  for (const firewall of await runFirewalls())
    await api('DELETE', `/firewalls/${encodeURIComponent(firewall.id)}`, [204, 404]);

  // DO refuses a VPC while a Droplet is still in it, so a refusal is retried for a while.
  for (const vpc of await runVpcs()) {
    await until(
      `VPC ${vpc.name} to be deleted`,
      async () => {
        try {
          return (await api('DELETE', `/vpcs/${encodeURIComponent(vpc.id)}`, [204, 404])).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 204 || status === 404,
      120_000,
      5_000,
    );
  }

  for (const name of await runTags(ownTags)) await deleteIfEmpty(name);

  return {
    droplets: (await runDroplets()).map((d) => `${d.id} ${d.name}`),
    firewalls: (await runFirewalls()).map((f) => f.name),
    vpcs: (await runVpcs()).map((v) => v.name),
    tags: await runTags(ownTags),
  };
}

// ---------------------------------------------------------------------------------- the suite

describe.skipIf(!enabled)('provider-digitalocean live', () => {
  const sshKeyFingerprint = env.BC_DO_SSH_KEY_FINGERPRINT;
  const provider = digitaloceanProvider({ fetch: observedFetch, deployment });
  let config: DoConfig;

  beforeAll(() => {
    if (!sshKeyFingerprint)
      throw new Error(
        'BC_DO_SSH_KEY_FINGERPRINT is required for the live suite: the MD5 fingerprint of an SSH key that is already in the account (a Droplet create needs one)',
      );
    config = { token: secretRef, regions: [region], sshKeyFingerprint, monitoring: false };
  });

  afterAll(async () => {
    try {
      const left = await sweep();
      console.info(
        `DigitalOcean live run ${run}: ${requests} requests, lowest ratelimit-remaining ${lowestRemaining ?? 'not seen'}`,
      );
      expect(left).toEqual({ droplets: [], firewalls: [], vpcs: [], tags: [] });
    } catch (error) {
      console.error(
        `DigitalOcean live run ${run}: SWEEP FAILED. Find what is left by the tag ${deployTag} and the names ${prefix}-*. ${String(error)}`,
      );
      throw error;
    }
  }, 600_000);

  it('probeAccount sees every family with this token', { timeout: 60_000 }, async () => {
    const report = await probeAccount(config, providerContext, {
      fetch: observedFetch,
      deployment,
    });
    expect(report.families).toEqual({
      compute: 'ok',
      networks: 'ok',
      keys: 'ok',
      tags: 'ok',
    });
    expect(report.missing).toEqual([]);
  });

  it('passes every case of the ProviderImpl contract', { timeout: 900_000 }, async () => {
    const report = await runConformance(providerConformanceCases(), {
      provider,
      config,
      offerId: `${region}/${size}`,
      image,
      prefix,
      context: { secrets, account },
      ...(attachable ? { attachable } : {}),
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toHaveLength(providerConformanceCases().length);
  });

  it('round-trips a network, a subnet and a firewall', { timeout: 600_000 }, async () => {
    // Built the way vps builds one: the manifest validates (and defaults) the account first.
    const parsed = await provider.config['~standard'].validate(config);
    if ('issues' in parsed && parsed.issues) throw new Error(parsed.issues[0]!.message);
    const impl = (await provider.create(
      (parsed as { value: DoConfig }).value,
      providerContext,
    )) as DoCompute;
    const networks = impl.networks;
    if (!networks) throw new Error('the provider offers no networks');
    const ready = (value: { state: string }) => value.state === 'ready';
    const gone = (value: { state: string }) => value.state === 'deleted';

    await until(
      'the network',
      () => networks.ensureNetwork({ name: networkName }, call(`${prefix}-n`)),
      ready,
      120_000,
    );
    await until(
      'the subnet',
      () =>
        networks.ensureSubnet(
          { network: networkName, name: subnetName, region, cidr: subnetCidr },
          call(`${prefix}-s`),
        ),
      ready,
      120_000,
    );
    await until(
      'the firewall',
      () =>
        networks.ensureFirewall(
          {
            network: networkName,
            name: ruleName,
            direction: 'ingress',
            action: 'allow',
            priority: 1000,
            rules: [{ protocol: 'tcp', ports: ['22'] }],
            sources: ['10.0.0.0/8'],
          },
          call(`${prefix}-f`),
        ),
      ready,
      180_000,
    );
    // The rule and the base firewall exist in the account, with the names the sweeper looks for.
    expect((await runFirewalls()).map((f) => f.name).sort()).toEqual(
      expect.arrayContaining([baseFirewallName(networkName)]),
    );
    expect((await runVpcs()).map((v) => v.name)).toEqual([subnetName]);

    await until(
      'the firewall to go',
      () => networks.deleteFirewall(ruleName, call(`${prefix}-df`)),
      gone,
      120_000,
    );
    await until(
      'the subnet to go',
      () => networks.deleteSubnet(region, subnetName, call(`${prefix}-ds`)),
      gone,
      180_000,
    );
    await until(
      'the network to go',
      () => networks.deleteNetwork(networkName, call(`${prefix}-dn`)),
      gone,
      120_000,
    );
    expect(await runFirewalls()).toEqual([]);
    expect(await runVpcs()).toEqual([]);
  });
});
