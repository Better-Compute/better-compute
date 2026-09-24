import {
  ComputeError,
  field,
  manifest,
  type CallContext,
  type ExternalMachine,
  type ImageRef,
  type Offer,
  type OfferQuery,
  type PowerAction,
  type ProviderContext,
  type ProviderImpl,
  type SecretRef,
} from '@better-compute/core';
import { defineProvider, type ProviderDefinition } from '@better-compute/vps';

// Hetzner Cloud (https://docs.hetzner.cloud): servers as VPS instances. The API has no idempotency
// keys, so every server carries the key as a label and `create` looks it up first; a racing
// duplicate loses on the unique server name and returns the winner.

export const hetznerLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin'] as const;

/** An account's configuration: the API token is a SecretRef, never a value. */
export const hetznerCloudConfig = manifest({
  token: field.secret().describe('Hetzner Cloud API token (read & write), as a secret reference'),
  location: field.option(hetznerLocations).default('fsn1').describe('Where servers are created'),
});

/** The validated account configuration. */
export interface HetznerCloudConfig {
  token: SecretRef;
  location: (typeof hetznerLocations)[number];
}

export interface HetznerCloudOptions {
  /** The fetch implementation (tests pass a recording or emulating one). */
  fetch?: typeof fetch;
  /** Default `https://api.hetzner.cloud/v1`. */
  endpoint?: string;
  /** Label key that carries the idempotency key. */
  labelKey?: string;
}

/** The label every server this provider creates carries (value: `true`). */
export const managedLabel = 'better-compute.io/managed';
const defaultKeyLabel = 'better-compute.io/idempotency-key';

interface HcloudServer {
  id: number;
  name: string;
  status: string;
  public_net?: {
    ipv4?: { ip: string } | null;
    ipv6?: { ip: string } | null;
  };
  private_net?: { ip: string }[];
  server_type?: { name: string };
  datacenter?: { location?: { name: string } };
  labels?: Record<string, string>;
}

interface HcloudServerType {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  deprecated?: boolean | null;
  deprecation?: unknown;
  architecture?: string;
  prices: { location: string; price_hourly: { net: string; gross: string } }[];
}

interface HcloudDatacenter {
  name: string;
  location: { name: string };
  server_types: { available: number[] };
}

const statusMap: Record<string, ExternalMachine['state']> = {
  initializing: 'pending',
  starting: 'pending',
  running: 'running',
  stopping: 'running',
  off: 'stopped',
  deleting: 'deleting',
  migrating: 'running',
  rebuilding: 'pending',
  unknown: 'unknown',
};

/** A Hetzner server as the contract's ExternalMachine. */
export function toMachine(server: HcloudServer): ExternalMachine {
  const addresses = [
    server.public_net?.ipv4?.ip,
    server.public_net?.ipv6?.ip,
    ...(server.private_net ?? []).map((network) => network.ip),
  ].filter((address): address is string => typeof address === 'string' && address !== '');
  const machine: ExternalMachine = {
    id: String(server.id),
    name: server.name,
    state: statusMap[server.status] ?? 'unknown',
    addresses,
  };
  if (server.server_type?.name) machine.offerId = server.server_type.name;
  const region = server.datacenter?.location?.name;
  if (region) machine.region = region;
  return machine;
}

/** Hetzner server names are hostnames: `inst_01…` becomes `inst-01…`, at most 63 characters. */
export function serverName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return cleaned || 'bc-server';
}

/** Label values: 1–63 of `[a-zA-Z0-9._-]`, alphanumeric at both ends. */
export function labelValue(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (!cleaned)
    throw new ComputeError('INVALID_INPUT', `Cannot use ${JSON.stringify(value)} as a label value`);
  return cleaned;
}

const powerActions: Partial<Record<PowerAction, string>> = {
  on: 'poweron',
  off: 'poweroff',
  'graceful-off': 'shutdown',
  reset: 'reset',
  'graceful-restart': 'reboot',
  cycle: 'reset',
};

class HetznerCloudClient implements ProviderImpl {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #keyLabel: string;
  readonly #config: HetznerCloudConfig;
  readonly #context: ProviderContext;

  constructor(config: HetznerCloudConfig, context: ProviderContext, options: HetznerCloudOptions) {
    this.#config = config;
    this.#context = context;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#endpoint = (options.endpoint ?? 'https://api.hetzner.cloud/v1').replace(/\/+$/, '');
    this.#keyLabel = options.labelKey ?? defaultKeyLabel;
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const token = await this.#context.secrets.resolve(this.#config.token);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ComputeError(
        'PROVIDER_ERROR',
        `Hetzner Cloud unreachable: ${(error as Error).message}`,
        undefined,
        {
          provider: 'hetzner-cloud',
        },
      );
    }
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (response.ok) return payload as T;
    if (response.status === 404) return undefined;
    const error = (payload.error ?? {}) as { code?: string; message?: string };
    const details: Record<string, unknown> = {
      provider: 'hetzner-cloud',
      status: response.status,
      code: error.code ?? 'unknown',
    };
    if (response.status === 429 || error.code === 'rate_limit_exceeded') {
      const reset = Number(response.headers.get('ratelimit-reset'));
      const retryAfterMs =
        Number.isFinite(reset) && reset > 0
          ? Math.max(0, reset * 1000 - this.#context.clock.now())
          : 1000;
      throw new ComputeError('RATE_LIMITED', 'Hetzner Cloud rate limit exceeded', undefined, {
        ...details,
        retryAfterMs,
      });
    }
    throw new ComputeError(
      'PROVIDER_ERROR',
      `Hetzner Cloud ${method} ${path.split('?')[0]}: ${error.message ?? response.statusText}`,
      undefined,
      details,
    );
  }

  async #all<T>(path: string, key: string, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    let page: number | null = 1;
    const separator = path.includes('?') ? '&' : '?';
    while (page !== null && page < 100) {
      const payload: Record<string, unknown> | undefined = await this.#request<
        Record<string, unknown>
      >('GET', `${path}${separator}page=${page}&per_page=50`, undefined, signal);
      items.push(...(((payload?.[key] as T[] | undefined) ?? []) as T[]));
      const meta = payload?.meta as { pagination?: { next_page?: number | null } } | undefined;
      const next: number | null | undefined = meta?.pagination?.next_page;
      page = typeof next === 'number' ? next : null;
    }
    return items;
  }

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (query.kind === 'metal' || (query.minGpus ?? 0) > 0 || query.gpuModel !== undefined)
      return [];
    const location = query.region ?? this.#config.location;
    const [types, datacenters] = await Promise.all([
      this.#all<HcloudServerType>('/server_types', 'server_types'),
      this.#all<HcloudDatacenter>('/datacenters', 'datacenters'),
    ]);
    const available = new Set(
      datacenters
        .filter((dc) => dc.location.name === location)
        .flatMap((dc) => dc.server_types.available),
    );
    return types
      .filter((type) => !type.deprecated && !type.deprecation)
      .filter((type) => type.prices.some((price) => price.location === location))
      .filter(
        (type) => type.cores >= (query.minVcpu ?? 0) && type.memory >= (query.minMemoryGiB ?? 0),
      )
      .map((type) => {
        const price = type.prices.find((entry) => entry.location === location)!;
        return {
          id: type.name,
          kind: 'vps' as const,
          region: location,
          vcpu: type.cores,
          memoryGiB: type.memory,
          diskGiB: type.disk,
          pricePerHour: Number(price.price_hourly.gross),
          currency: 'EUR',
          available: available.has(type.id),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async #byKey(key: string, signal: AbortSignal): Promise<HcloudServer | undefined> {
    const selector = encodeURIComponent(`${this.#keyLabel}==${labelValue(key)}`);
    const servers = await this.#all<HcloudServer>(
      `/servers?label_selector=${selector}`,
      'servers',
      signal,
    );
    return servers[0];
  }

  async create(
    request: { offerId: string; image: ImageRef; userData: string; name: string },
    context: CallContext,
  ): Promise<ExternalMachine> {
    const existing = await this.#byKey(context.idempotencyKey, context.signal);
    if (existing) return toMachine(existing);
    try {
      const created = await this.#request<{ server: HcloudServer }>(
        'POST',
        '/servers',
        {
          name: serverName(request.name),
          server_type: request.offerId,
          image: request.image,
          location: this.#config.location,
          user_data: request.userData,
          start_after_create: true,
          labels: { [managedLabel]: 'true', [this.#keyLabel]: labelValue(context.idempotencyKey) },
        },
        context.signal,
      );
      if (!created?.server)
        throw new ComputeError('PROVIDER_ERROR', 'Hetzner Cloud returned no server');
      return toMachine(created.server);
    } catch (error) {
      // A concurrent create with the same key won the unique name: return its server.
      const winner = await this.#byKey(context.idempotencyKey, context.signal);
      if (winner) return toMachine(winner);
      throw error;
    }
  }

  async get(id: string, context: CallContext): Promise<ExternalMachine | undefined> {
    if (!/^\d+$/.test(id)) return undefined;
    const payload = await this.#request<{ server: HcloudServer }>(
      'GET',
      `/servers/${id}`,
      undefined,
      context.signal,
    );
    return payload?.server ? toMachine(payload.server) : undefined;
  }

  async delete(id: string, context: CallContext): Promise<void> {
    if (!/^\d+$/.test(id)) throw new ComputeError('NOT_FOUND', `Server ${id} not found`);
    const payload = await this.#request('DELETE', `/servers/${id}`, undefined, context.signal);
    if (payload === undefined) throw new ComputeError('NOT_FOUND', `Server ${id} not found`);
  }

  async power(id: string, action: PowerAction, context: CallContext): Promise<void> {
    const verb = powerActions[action];
    if (!verb) throw new ComputeError('UNSUPPORTED', `Hetzner Cloud has no ${action} action`);
    const payload = await this.#request(
      'POST',
      `/servers/${id}/actions/${verb}`,
      undefined,
      context.signal,
    );
    if (payload === undefined) throw new ComputeError('NOT_FOUND', `Server ${id} not found`);
  }

  async reinstall(id: string, image: ImageRef, context: CallContext): Promise<void> {
    const payload = await this.#request(
      'POST',
      `/servers/${id}/actions/rebuild`,
      { image },
      context.signal,
    );
    if (payload === undefined) throw new ComputeError('NOT_FOUND', `Server ${id} not found`);
  }

  async *list(context: CallContext): AsyncIterable<ExternalMachine> {
    const selector = encodeURIComponent(`${managedLabel}==true`);
    for (const server of await this.#all<HcloudServer>(
      `/servers?label_selector=${selector}`,
      'servers',
      context.signal,
    ))
      yield toMachine(server);
  }
}

/** A Hetzner Cloud provider definition; pass `fetch` to record, replay or emulate the API. */
export function hetznerCloudProvider(
  options: HetznerCloudOptions = {},
): ProviderDefinition<HetznerCloudConfig> {
  return defineProvider<HetznerCloudConfig>({
    id: 'hetzner-cloud',
    version: '0.1.0',
    provides: ['vps'],
    config: hetznerCloudConfig as unknown as ProviderDefinition<HetznerCloudConfig>['config'],
    capabilities: ['power', 'reinstall', 'list'],
    create: (config, context) => new HetznerCloudClient(config, context, options),
  });
}

/** The Hetzner Cloud provider (`vps({ providers: [hetznerCloud] })`). */
export const hetznerCloud: ProviderDefinition<HetznerCloudConfig> = hetznerCloudProvider();
