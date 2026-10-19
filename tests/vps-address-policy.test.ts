import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ComputeError, manifest, field, type ProviderContext } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import {
  createAddressPolicy,
  defineProvider,
  vps,
  type AddressPolicyOptions,
} from '@better-compute/vps';
import { proxmoxProvider } from '@better-compute/provider-proxmox';
import { hetznerCloudProvider, hetznerCloud } from '@better-compute/provider-hetzner';
import { gcpProvider } from '@better-compute/provider-gcp';

// The address policy (U-02) for provider endpoints an account chooses: private, link-local (metadata), loopback,
// CGNAT and cluster addresses are refused at account validation, and clients call through a fetch that checks the
// address again and connects to it (DNS pinning), never following redirects. Compute Engine declares no endpoints:
// its hosts stay pinned by host options.

afterEach(closeFixtures);

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: ComputeError) => error,
  );

/** A resolver from a fixed table; unknown names are ENOTFOUND. */
function table(
  entries: Record<string, string[] | (() => string[])>,
): AddressPolicyOptions['resolve'] {
  return async (host) => {
    const entry = entries[host];
    if (entry === undefined)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return typeof entry === 'function' ? entry() : entry;
  };
}

describe('address policy: classification', () => {
  const policy = createAddressPolicy();
  it.each([
    ['10.0.0.1', 'private'],
    ['172.20.1.1', 'private'],
    ['192.168.1.10', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['100.64.1.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.7', 'documentation'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00:ec2::254', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['64:ff9b::a00:1', 'private'],
    ['2002:a00:1::', 'private'],
    ['2001:db8::1', 'documentation'],
  ])('refuses %s as %s', (address, category) => {
    expect(policy.classify(address)).toBe(category);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:808:808::'])(
    'allows the public address %s',
    (address) => {
      expect(policy.classify(address)).toBeUndefined();
    },
  );

  it('adds the cluster ranges a host names, and exempts the ranges it allows', () => {
    const custom = createAddressPolicy({
      denyCidrs: ['34.118.224.0/20', '2600:1900:4000::/44'],
      allowCidrs: ['10.20.0.0/16'],
    });
    expect(custom.classify('34.118.230.5')).toBe('cluster');
    expect(custom.classify('2600:1900:4001::1')).toBe('cluster');
    expect(custom.classify('10.20.3.4')).toBeUndefined();
    expect(custom.classify('10.21.3.4')).toBe('private');
    expect(() => createAddressPolicy({ denyCidrs: ['10.0.0.0/33'] })).toThrow(ComputeError);
    expect(() => createAddressPolicy({ allowCidrs: ['not-a-cidr'] })).toThrow(ComputeError);
  });
});

describe('address policy: endpoint checks', () => {
  const policy = createAddressPolicy({
    resolve: table({
      'pve.example.com': ['203.0.114.10', '2606:4700::10'],
      'inside.example.com': ['203.0.114.11', '10.0.0.5'],
      'metadata.example.com': ['169.254.169.254'],
    }),
  });

  it('allows an https endpoint whose every address is public', async () => {
    expect(await policy.check('https://pve.example.com:8006')).toEqual([
      '203.0.114.10',
      '2606:4700::10',
    ]);
    expect(await policy.check('https://[2606:4700::1111]/api')).toEqual(['2606:4700::1111']);
  });

  it('refuses a name with any private address, without echoing the address', async () => {
    const error = await failure(policy.check('https://inside.example.com:8006'));
    expect(error).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'endpoint-address', category: 'private' },
    });
    expect(error!.message).not.toContain('10.0.0.5');
    expect(await failure(policy.check('https://metadata.example.com'))).toMatchObject({
      details: { category: 'link-local' },
    });
  });

  it.each([
    ['https://10.0.0.1:8006', 'private'],
    ['https://169.254.169.254/computeMetadata/v1/', 'link-local'],
    ['https://[::1]:8006', 'loopback'],
    ['https://[::ffff:127.0.0.1]/', 'loopback'],
    ['https://localhost:8006', 'internal-name'],
    ['https://metadata.google.internal/', 'internal-name'],
    ['https://kubernetes.default.svc/', 'internal-name'],
    ['https://api.default.svc.cluster.local/', 'internal-name'],
    ['https://pve/', 'internal-name'],
  ])('refuses %s (%s)', async (endpoint, category) => {
    expect(await failure(policy.check(endpoint))).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'endpoint-address', category },
    });
  });

  it('refuses plain http, credentials in the URL, and names that do not resolve', async () => {
    expect(await failure(policy.check('http://pve.example.com:8006'))).toMatchObject({
      details: { reason: 'endpoint-scheme' },
    });
    expect(await failure(policy.check('https://root:pw@pve.example.com'))).toMatchObject({
      details: { reason: 'endpoint-scheme' },
    });
    expect(await failure(policy.check('not a url'))).toMatchObject({
      details: { reason: 'endpoint-scheme' },
    });
    expect(await failure(policy.check('https://nowhere.example.com'))).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'endpoint-unresolved' },
    });
  });

  it('a resolver outage is UNAVAILABLE (retry), not a refusal', async () => {
    const flaky = createAddressPolicy({
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
      },
    });
    expect(await failure(flaky.check('https://pve.example.com'))).toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'endpoint-unresolved' },
    });
  });
});

describe('address policy: the pinned fetch', () => {
  let server: Server;
  let port: number;
  const seen: { host?: string; path?: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seen.push({ host: request.headers.host, path: request.url, body });
        if (request.url === '/redirect') {
          response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', 'x-twice': ['a', 'b'] });
        response.end(JSON.stringify({ ok: true, method: request.method }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('connects to the checked address under the URL host name, and returns the response', async () => {
    // pve.example.test resolves nowhere but in the policy's table: reaching the server proves the pin.
    const policy = createAddressPolicy({
      allowHttp: true,
      allowCidrs: ['127.0.0.0/8'],
      resolve: table({ 'pve.example.test': ['127.0.0.1'] }),
    });
    seen.length = 0;
    const response = await policy.fetch(`http://pve.example.test:${port}/api2/json/version?x=1`, {
      method: 'POST',
      headers: { authorization: 'PVEAPIToken=t' },
      body: 'a=1',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, method: 'POST' });
    expect(response.headers.get('x-twice')).toBe('a, b');
    expect(seen).toEqual([
      { host: `pve.example.test:${port}`, path: '/api2/json/version?x=1', body: 'a=1' },
    ]);
  });

  it('never follows a redirect', async () => {
    const policy = createAddressPolicy({
      allowHttp: true,
      allowCidrs: ['127.0.0.0/8'],
      resolve: table({ 'pve.example.test': ['127.0.0.1'] }),
    });
    const response = await policy.fetch(`http://pve.example.test:${port}/redirect`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it('a DNS answer that turns private after validation reaches nothing (rebinding)', async () => {
    let answers = 0;
    const policy = createAddressPolicy({
      allowHttp: true,
      resolve: table({
        'rebind.example.com': () => (answers++ === 0 ? ['203.0.114.20'] : ['127.0.0.1']),
      }),
    });
    expect(await policy.check(`http://rebind.example.com:${port}`)).toEqual(['203.0.114.20']);
    seen.length = 0;
    await expect(policy.fetch(`http://rebind.example.com:${port}/`)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      details: { category: 'loopback' },
    });
    expect(seen).toEqual([]);
  });

  it('refuses an IP literal in a private range at fetch time too', async () => {
    const policy = createAddressPolicy({ allowHttp: true });
    await expect(policy.fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });
});

describe('address policy: provider accounts', () => {
  const resolve = table({
    'pve.example.com': ['203.0.114.10'],
    'pve.inside.example.com': ['192.168.10.5'],
  });

  async function world(options: AddressPolicyOptions = {}, extra: Parameters<typeof vps>[0] = {}) {
    const fixture = await computeFixture({
      modules: [
        vps({
          providers: [
            proxmoxProvider({ fetch: async () => new Response('{}') }),
            ...(extra.providers ?? []),
          ],
          addressPolicy: { resolve, ...options },
        }),
      ],
    });
    fixture.iam.allow({ token: fixture.tenants.root.token });
    fixture.iam.allow({ token: fixture.tenants.acme.token });
    const api = fixture.compute.api as any;
    const create = (
      who: 'root' | 'acme',
      provider: string,
      name: string,
      config: Record<string, unknown>,
    ) =>
      api.providerAccounts.create(
        { token: fixture.tenants[who].token },
        { tenantId: fixture.tenants[who].id, provider, name, config },
      );
    return { fixture, api, create };
  }

  it('refuses a Proxmox account whose url is private, link-local or loopback, and stores a public one', async () => {
    const { fixture, create } = await world();
    const token = `secret://${fixture.tenants.acme.id}/pve`;
    for (const url of [
      'https://pve.inside.example.com:8006',
      'https://10.1.2.3:8006',
      'https://169.254.169.254',
      'https://[::1]:8006',
      'https://localhost:8006',
    ])
      expect(await failure(create('acme', 'proxmox', 'pve', { url, token })), url).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { reason: 'endpoint-address' },
      });
    const { rows } = await fixture.database.query(`SELECT 1 FROM provider_accounts`);
    expect(rows).toEqual([]);
    const stored = await create('acme', 'proxmox', 'pve', {
      url: 'https://pve.example.com:8006',
      token,
    });
    expect(stored).toMatchObject({ provider: 'proxmox', name: 'pve' });
  });

  it('holds platform accounts to it unless the host exempts them', async () => {
    const enforced = await world();
    const config = { url: 'https://pve.inside.example.com:8006', token: 'env://PVE_TOKEN' };
    expect(await failure(enforced.create('root', 'proxmox', 'pve', config))).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'endpoint-address' },
    });
    const exempt = await world({ platformAccounts: 'exempt' });
    expect(await exempt.create('root', 'proxmox', 'pve', config)).toMatchObject({
      provider: 'proxmox',
    });
    // A tenant is never exempt.
    expect(
      await failure(
        exempt.create('acme', 'proxmox', 'pve', {
          url: config.url,
          token: `secret://${exempt.fixture.tenants.acme.id}/pve`,
        }),
      ),
    ).toMatchObject({ code: 'INVALID_CONFIG', details: { reason: 'endpoint-address' } });
  });

  it('gives clients the pinned fetch (ProviderContext.fetch)', async () => {
    const contexts: ProviderContext[] = [];
    const probe = defineProvider({
      id: 'probe',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({ url: field.url() }) as never,
      endpoints: (config: { url: string }) => [config.url],
      create: (_config, context) => {
        contexts.push(context);
        return {
          async listOffers() {
            return [];
          },
          async create() {
            throw new ComputeError('UNSUPPORTED', 'unused');
          },
          async get() {
            return undefined;
          },
          async delete() {},
        };
      },
    });
    const { fixture, api, create } = await world({}, { providers: [probe] });
    const account = await create('acme', 'probe', 'probe', { url: 'https://pve.example.com' });
    await api.providerAccounts.offers(
      { token: fixture.tenants.acme.token },
      { tenantId: fixture.tenants.acme.id, accountId: account.id },
    );
    expect(contexts.length).toBeGreaterThan(0);
    expect(typeof contexts.at(-1)!.fetch).toBe('function');
    expect(contexts.at(-1)!.fetch).not.toBe(globalThis.fetch);
  });

  it('the Proxmox client calls through ProviderContext.fetch: a name that rebinds to loopback reaches nothing', async () => {
    let answers = 0;
    const policy = createAddressPolicy({
      resolve: table({
        'pve.rebind.example.com': () => (answers++ === 0 ? ['198.51.101.10'] : ['127.0.0.1']),
      }),
    });
    const config = { url: 'https://pve.rebind.example.com:8006', token: 'env://PVE_TOKEN' };
    // Account validation passes: the name resolves to a public address.
    expect(await policy.check(config.url)).toEqual(['198.51.101.10']);
    const urls: string[] = [];
    const definition = proxmoxProvider();
    const client = await definition.create(
      config as never,
      {
        clock: { now: () => 0 },
        secrets: { resolve: async () => 'root@pam!t=x' },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          urls.push(String(input));
          return policy.fetch(input, init);
        }) as typeof fetch,
      } as unknown as ProviderContext,
    );
    const refused = await failure(client.listOffers({ kind: 'vps' } as never));
    // The client used the context's fetch (no fetch option of its own), which re-resolved and refused.
    expect(urls[0]).toMatch(/^https:\/\/pve\.rebind\.example\.com:8006\/api2\/json\//);
    expect(answers).toBe(2);
    expect(refused).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(refused!.message).toContain('loopback');
  });

  it('checks a Hetzner API URL override, and only an override', async () => {
    expect(hetznerCloud.endpoints).toBeUndefined();
    const overridden = hetznerCloudProvider({ endpoint: 'https://10.9.8.7/v1' });
    expect(overridden.endpoints!({} as never)).toEqual(['https://10.9.8.7/v1']);
    const { fixture, create } = await world({}, { providers: [overridden] });
    expect(
      await failure(
        create('acme', 'hetzner-cloud', 'hc', { token: `secret://${fixture.tenants.acme.id}/hc` }),
      ),
    ).toMatchObject({
      code: 'INVALID_CONFIG',
      details: { reason: 'endpoint-address', category: 'private' },
    });
  });

  it('never applies to Compute Engine: its hosts come from host options (the universe pin)', () => {
    expect(gcpProvider().endpoints).toBeUndefined();
  });
});
