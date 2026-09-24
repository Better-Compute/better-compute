import { describe, expect, it } from 'vitest';
import { isComputeError, type CallContext, type ProviderImpl } from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { providerConformanceCases } from '@better-compute/vps';
import {
  hetznerCloud,
  hetznerCloudProvider,
  labelValue,
  serverName,
  toMachine,
} from '@better-compute/provider-hetzner';

// Hetzner Cloud against an in-memory emulator of the endpoints the provider uses (servers, server
// types, datacenters, actions), plugged in through the provider's `fetch` option: the generic
// providerConformance suite plus Hetzner specifics (labels, races, errors, rate limits, offers).

interface Emulated {
  id: number;
  name: string;
  status: string;
  server_type: { name: string };
  image: string;
  user_data: string;
  labels: Record<string, string>;
  public_net: { ipv4: { ip: string }; ipv6: { ip: string } };
  datacenter: { location: { name: string } };
}

class HetznerEmulator {
  servers = new Map<number, Emulated>();
  next = 100;
  requests: { method: string; path: string; authorization: string | null }[] = [];
  /** Hooks for failure injection. */
  failNext?: { status: number; code: string; message: string; headers?: Record<string, string> };
  /** Runs before POST /servers is answered (race injection). */
  beforeCreate?: (body: Record<string, unknown>) => void;
  pageSize = 2;

  serverTypes = [
    {
      id: 1,
      name: 'cx22',
      cores: 2,
      memory: 4,
      disk: 40,
      deprecated: false,
      prices: [{ location: 'fsn1', price_hourly: { net: '0.0060', gross: '0.0071' } }],
    },
    {
      id: 2,
      name: 'cx32',
      cores: 4,
      memory: 8,
      disk: 80,
      deprecated: false,
      prices: [{ location: 'fsn1', price_hourly: { net: '0.0113', gross: '0.0134' } }],
    },
    {
      id: 3,
      name: 'cx11',
      cores: 1,
      memory: 2,
      disk: 20,
      deprecated: true,
      prices: [{ location: 'fsn1', price_hourly: { net: '0.005', gross: '0.006' } }],
    },
    {
      id: 4,
      name: 'ccx13',
      cores: 2,
      memory: 8,
      disk: 80,
      deprecated: false,
      prices: [
        { location: 'fsn1', price_hourly: { net: '0.02', gross: '0.024' } },
        { location: 'ash', price_hourly: { net: '0.02', gross: '0.024' } },
      ],
    },
  ];
  datacenters = [
    { name: 'fsn1-dc14', location: { name: 'fsn1' }, server_types: { available: [1, 2] } },
    { name: 'ash-dc1', location: { name: 'ash' }, server_types: { available: [4] } },
  ];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.requests.push({
      method,
      path: url.pathname + url.search,
      authorization: headers.get('authorization'),
    });
    if (headers.get('authorization') !== 'Bearer hc-secret-token')
      return this.error(401, 'unauthorized', 'unable to authenticate');
    if (this.failNext) {
      const failure = this.failNext;
      delete this.failNext;
      return this.error(failure.status, failure.code, failure.message, failure.headers);
    }
    const path = url.pathname.replace(/^\/v1/, '');
    const page = Number(url.searchParams.get('page') ?? 1);
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 25), this.pageSize);
    const paged = <T>(key: string, items: T[]) => {
      const slice = items.slice((page - 1) * perPage, page * perPage);
      const next = page * perPage < items.length ? page + 1 : null;
      return this.json(200, {
        [key]: slice,
        meta: { pagination: { page, per_page: perPage, next_page: next } },
      });
    };
    if (method === 'GET' && path === '/server_types')
      return paged('server_types', this.serverTypes);
    if (method === 'GET' && path === '/datacenters') return paged('datacenters', this.datacenters);
    if (method === 'GET' && path === '/servers') {
      const selector = url.searchParams.get('label_selector');
      const [key, value] = (selector ?? '').split('==');
      const matching = [...this.servers.values()].filter(
        (server) => !selector || server.labels[key!] === value,
      );
      return paged('servers', matching);
    }
    if (method === 'POST' && path === '/servers') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.beforeCreate?.(body);
      if ([...this.servers.values()].some((server) => server.name === body.name))
        return this.error(409, 'uniqueness_error', 'server name is already used');
      if (!this.serverTypes.some((type) => type.name === body.server_type))
        return this.error(422, 'invalid_input', 'server type not found');
      const id = this.next++;
      const server: Emulated = {
        id,
        name: String(body.name),
        status: 'initializing',
        server_type: { name: String(body.server_type) },
        image: String(body.image),
        user_data: String(body.user_data),
        labels: body.labels as Record<string, string>,
        public_net: { ipv4: { ip: `198.51.100.${id % 250}` }, ipv6: { ip: '2001:db8::/64' } },
        datacenter: { location: { name: String(body.location) } },
      };
      this.servers.set(id, server);
      return this.json(201, {
        server,
        action: { id: 1, command: 'create_server' },
        root_password: null,
      });
    }
    const match = /^\/servers\/(\d+)(?:\/actions\/(\w+))?$/.exec(path);
    const server = match ? this.servers.get(Number(match[1])) : undefined;
    if (match && !server) return this.error(404, 'not_found', 'server not found');
    if (server && method === 'GET' && !match![2]) return this.json(200, { server });
    if (server && method === 'DELETE') {
      this.servers.delete(server.id);
      return this.json(200, { action: { id: 2, command: 'delete_server' } });
    }
    if (server && method === 'POST' && match![2]) {
      const action = match![2];
      if (action === 'poweron') server.status = 'running';
      else if (action === 'poweroff' || action === 'shutdown') server.status = 'off';
      else if (action === 'rebuild')
        server.image = String((JSON.parse(String(init?.body)) as { image: string }).image);
      else if (action !== 'reset' && action !== 'reboot')
        return this.error(404, 'not_found', 'no such action');
      return this.json(201, { action: { id: 3, command: action } });
    }
    return this.error(404, 'not_found', `no route ${method} ${path}`);
  };

  json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  error(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
  ): Response {
    return this.json(status, { error: { code, message } }, headers);
  }
}

const secrets = {
  resolve: async (ref: string) => {
    if (ref !== 'env://HCLOUD_TOKEN') throw new Error(`unexpected secret ${ref}`);
    return 'hc-secret-token';
  },
};
const clock = { now: () => Date.UTC(2026, 8, 24, 12) };

function setup(config: Record<string, unknown> = { token: 'env://HCLOUD_TOKEN' }) {
  const api = new HetznerEmulator();
  const provider = hetznerCloudProvider({ fetch: api.fetch, endpoint: 'https://hcloud.test/v1' });
  return { api, provider, config };
}

async function client(api: HetznerEmulator): Promise<ProviderImpl> {
  const provider = hetznerCloudProvider({ fetch: api.fetch, endpoint: 'https://hcloud.test/v1' });
  return provider.create(
    { token: 'env://HCLOUD_TOKEN', location: 'fsn1' },
    { clock, secrets, log: console },
  );
}

const call = (key: string): CallContext => ({
  idempotencyKey: key,
  signal: new AbortController().signal,
  clock,
  secrets,
  log: console,
});

describe('hetznerCloud: providerConformance', () => {
  it('passes every case of the ProviderImpl contract', async () => {
    const report = await runConformance(providerConformanceCases(), () => {
      const { provider, config } = setup();
      return {
        provider,
        config,
        offerId: 'cx22',
        image: 'ubuntu-24.04',
        context: { secrets, clock },
      };
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toHaveLength(providerConformanceCases().length);
  });

  it('is a well-formed definition whose config demands a secret reference', async () => {
    expect(hetznerCloud).toMatchObject({
      id: 'hetzner-cloud',
      provides: ['vps'],
      extension: 'provider',
    });
    const bad = await hetznerCloud.config['~standard'].validate({ token: 'raw-token' });
    expect('issues' in bad && bad.issues?.length).toBeTruthy();
    const good = await hetznerCloud.config['~standard'].validate({ token: 'vault://kv/hcloud' });
    expect(good).toMatchObject({ value: { token: 'vault://kv/hcloud', location: 'fsn1' } });
  });
});

describe('hetznerCloud specifics', () => {
  it('creates with labels, a hostname-safe name, the account location and the user data', async () => {
    const api = new HetznerEmulator();
    const impl = await client(api);
    const machine = await impl.create(
      { offerId: 'cx22', image: 'ubuntu-24.04', userData: '#cloud-config\n', name: 'inst_01ABC' },
      call('inst_01abc'),
    );
    expect(machine).toMatchObject({
      state: 'pending',
      offerId: 'cx22',
      region: 'fsn1',
      addresses: ['198.51.100.100', '2001:db8::/64'],
    });
    const server = api.servers.get(Number(machine.id))!;
    expect(server).toMatchObject({
      name: 'inst-01abc',
      user_data: '#cloud-config\n',
      labels: {
        'better-compute.io/managed': 'true',
        'better-compute.io/idempotency-key': 'inst_01abc',
      },
    });
    expect(
      api.requests.every((request) => request.authorization === 'Bearer hc-secret-token'),
    ).toBe(true);
  });

  it('returns the winner when a concurrent create took the name first', async () => {
    const api = new HetznerEmulator();
    const impl = await client(api);
    api.beforeCreate = (body) => {
      api.beforeCreate = undefined;
      // Another worker's retry of the same key lands between our lookup and our POST.
      api.servers.set(7, {
        id: 7,
        name: String(body.name),
        status: 'running',
        server_type: { name: 'cx22' },
        image: 'ubuntu-24.04',
        user_data: '',
        labels: body.labels as Record<string, string>,
        public_net: { ipv4: { ip: '198.51.100.7' }, ipv6: { ip: '2001:db8::/64' } },
        datacenter: { location: { name: 'fsn1' } },
      });
    };
    const machine = await impl.create(
      { offerId: 'cx22', image: 'ubuntu-24.04', userData: '', name: 'inst_race' },
      call('inst_race'),
    );
    expect(machine.id).toBe('7');
    expect(api.servers.size).toBe(1);
  });

  it('maps errors: rate limits with retryAfterMs, auth and validation as PROVIDER_ERROR, 404 as absent', async () => {
    const api = new HetznerEmulator();
    const impl = await client(api);
    api.failNext = {
      status: 429,
      code: 'rate_limit_exceeded',
      message: 'slow down',
      headers: { 'ratelimit-reset': String(clock.now() / 1000 + 12) },
    };
    await expect(impl.listOffers({})).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 12_000,
    });
    await expect(
      impl.create({ offerId: 'nope', image: 'x', userData: '', name: 'bad' }, call('bad')),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { status: 422, code: 'invalid_input' },
    });
    expect(await impl.get('999999', call('g'))).toBeUndefined();
    expect(await impl.get('not-a-number', call('g'))).toBeUndefined();
    const error = await impl.delete('999999', call('d')).catch((failure: unknown) => failure);
    expect(isComputeError(error, 'NOT_FOUND')).toBe(true);
    await expect(impl.power!('1', 'nmi', call('p'))).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const denied = await hetznerCloudProvider({ fetch: api.fetch }).create(
      { token: 'env://HCLOUD_TOKEN', location: 'fsn1' },
      { clock, secrets: { resolve: async () => 'wrong' }, log: console },
    );
    await expect(denied.listOffers({})).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { status: 401 },
    });
  });

  it('lists offers across pages with gross hourly prices and datacenter availability', async () => {
    const api = new HetznerEmulator();
    const impl = await client(api);
    expect(await impl.listOffers({})).toEqual([
      {
        id: 'ccx13',
        kind: 'vps',
        region: 'fsn1',
        vcpu: 2,
        memoryGiB: 8,
        diskGiB: 80,
        pricePerHour: 0.024,
        currency: 'EUR',
        available: false,
      },
      {
        id: 'cx22',
        kind: 'vps',
        region: 'fsn1',
        vcpu: 2,
        memoryGiB: 4,
        diskGiB: 40,
        pricePerHour: 0.0071,
        currency: 'EUR',
        available: true,
      },
      {
        id: 'cx32',
        kind: 'vps',
        region: 'fsn1',
        vcpu: 4,
        memoryGiB: 8,
        diskGiB: 80,
        pricePerHour: 0.0134,
        currency: 'EUR',
        available: true,
      },
    ]);
    expect(
      (await impl.listOffers({ region: 'ash' })).map((offer) => [offer.id, offer.available]),
    ).toEqual([['ccx13', true]]);
    expect((await impl.listOffers({ minVcpu: 4 })).map((offer) => offer.id)).toEqual(['cx32']);
    expect(await impl.listOffers({ minGpus: 1 })).toEqual([]);
    expect(await impl.listOffers({ kind: 'metal' })).toEqual([]);
    expect(
      api.requests.filter((request) => request.path.startsWith('/v1/server_types')).length,
    ).toBeGreaterThan(1);
  });

  it('powers, rebuilds and lists only the servers it manages', async () => {
    const api = new HetznerEmulator();
    const impl = await client(api);
    const machine = await impl.create(
      { offerId: 'cx22', image: 'ubuntu-24.04', userData: '', name: 'a' },
      call('a'),
    );
    await impl.power!(machine.id, 'graceful-off', call('off'));
    expect((await impl.get(machine.id, call('g')))!.state).toBe('stopped');
    await impl.power!(machine.id, 'on', call('on'));
    expect((await impl.get(machine.id, call('g')))!.state).toBe('running');
    await impl.reinstall!(machine.id, 'debian-12', call('r'));
    expect(api.servers.get(Number(machine.id))!.image).toBe('debian-12');
    api.servers.set(1, {
      ...api.servers.get(Number(machine.id))!,
      id: 1,
      name: 'unmanaged',
      labels: {},
    });
    const listed: string[] = [];
    for await (const entry of impl.list!(call('l'))) listed.push(entry.id);
    expect(listed).toEqual([machine.id]);
  });

  it('normalizes names, label values and statuses', () => {
    expect(serverName('inst_01JZ__abc')).toBe('inst-01jz-abc');
    expect(serverName('___')).toBe('bc-server');
    expect(serverName('x'.repeat(80))).toHaveLength(63);
    expect(labelValue('rsv_01abc')).toBe('rsv_01abc');
    expect(labelValue('a b/c')).toBe('a-b-c');
    expect(() => labelValue('///')).toThrow(/label value/);
    expect(toMachine({ id: 5, name: 'n', status: 'off' }).state).toBe('stopped');
    expect(toMachine({ id: 5, name: 'n', status: 'weird' }).state).toBe('unknown');
  });
});
