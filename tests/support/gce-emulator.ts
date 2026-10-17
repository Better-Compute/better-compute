import { randomUUID } from 'node:crypto';

// An in-memory emulator of the Compute Engine REST v1 endpoints provider-gcp uses, plus the three
// token endpoints. Plug `emulator.fetch` into `gcpProvider({ fetch })`. It keeps real GCE's shapes
// (full resource URLs, operations, label fingerprints, aggregated lists) but none of its timing.

export type Json = Record<string, any>;

export interface EmulatedMachineType {
  name: string;
  zone: string;
  guestCpus: number;
  memoryMb: number;
  accelerators?: { guestAcceleratorType: string; guestAcceleratorCount: number }[];
}

interface Operation {
  name: string;
  scope: 'zones' | 'regions' | 'global';
  scopeName?: string;
  operationType: string;
  targetLink: string;
  /** GETs that still answer RUNNING before the operation turns DONE. */
  remaining: number;
  error?: { errors: { code: string; message: string }[] };
  httpErrorStatusCode?: number;
}

export interface RecordedRequest {
  method: string;
  /** Path and query, without the origin. */
  path: string;
  url: URL;
  headers: Headers;
  body?: Json;
}

const origin = 'https://compute.googleapis.com/compute/v1';

export const zones = ['us-central1-a', 'us-central1-b', 'europe-west4-a'];

/** The machine types every zone serves. a3-highgpu-8g is 208 vCPU and 1872 GiB with 8 H100s. */
export function defaultMachineTypes(): EmulatedMachineType[] {
  const shapes: Omit<EmulatedMachineType, 'zone'>[] = [
    { name: 'e2-standard-2', guestCpus: 2, memoryMb: 8192 },
    { name: 'n2-standard-4', guestCpus: 4, memoryMb: 16384 },
    {
      name: 'g2-standard-4',
      guestCpus: 4,
      memoryMb: 16384,
      accelerators: [{ guestAcceleratorType: 'nvidia-l4', guestAcceleratorCount: 1 }],
    },
    {
      name: 'a2-highgpu-1g',
      guestCpus: 12,
      memoryMb: 87040,
      accelerators: [{ guestAcceleratorType: 'nvidia-tesla-a100', guestAcceleratorCount: 1 }],
    },
    {
      name: 'a3-highgpu-8g',
      guestCpus: 208,
      memoryMb: 1872 * 1024,
      accelerators: [{ guestAcceleratorType: 'nvidia-h100-80gb', guestAcceleratorCount: 8 }],
    },
  ];
  return zones.flatMap((zone) => shapes.map((shape) => ({ ...shape, zone })));
}

export class GceEmulator {
  /** Keyed `zone/name`. Values are GCE `Instance` resources. */
  instances = new Map<string, Json>();
  machineTypes: EmulatedMachineType[] = defaultMachineTypes();
  /** GCE `Reservation` resources, each with its `zone` URL. */
  reservations: Json[] = [];
  /** GCE `FutureReservation` resources. */
  futureReservations: Json[] = [];
  /** Keyed by name. */
  instanceTemplates = new Map<string, Json>();
  networks = new Map<string, Json>();
  /** Keyed `region/name`. */
  subnetworks = new Map<string, Json>();
  firewalls = new Map<string, Json>();
  operations = new Map<string, Operation>();
  requests: RecordedRequest[] = [];

  /** Fails the next compute request (not token requests) with this GCE error. */
  failNext?: { status: number; reason: string; message?: string; headers?: Record<string, string> };
  /** The next operation finishes DONE with this error and its effect is not applied. */
  failNextOperation?: { code: string; message?: string; httpErrorStatusCode?: number };
  /** New operations stay RUNNING for this many operation GETs. */
  operationDelayTicks = 0;
  /** Upper bound of a page; a request's `maxResults` can only lower it. */
  maxResults = 2;

  /** Every token this emulator handed out, in order. */
  mintedTokens: string[] = [];
  /** The `Authorization` bearer tokens it accepts on compute requests. */
  validTokens = new Set<string>();
  /** Claims of the JWTs presented to the OAuth token endpoint. */
  jwtClaims: Json[] = [];
  /** Metadata-Flavor header values seen by the metadata endpoint. */
  metadataFlavors: (string | null)[] = [];
  /** `expires_in` the OAuth and metadata endpoints answer with. */
  tokenLifetimeSeconds = 3600;

  #operationSeq = 0;
  #instanceSeq = 1000;
  #requestIds = new Map<string, Operation>();

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: Json | undefined;
    if (typeof init?.body === 'string' && headers.get('content-type')?.includes('json'))
      body = JSON.parse(init.body) as Json;
    this.requests.push({ method, path: url.pathname + url.search, url, headers, body });

    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token')
      return this.#oauthToken(init);
    if (url.hostname === 'metadata.google.internal') return this.#metadataToken(url, headers);
    if (url.hostname === 'iamcredentials.googleapis.com')
      return this.#generateAccessToken(url, headers, body);
    if (url.hostname !== 'compute.googleapis.com')
      return this.error(404, 'notFound', `No emulated host ${url.hostname}`);

    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    if (!bearer || !this.validTokens.has(bearer))
      return this.error(401, 'authError', 'Invalid Credentials');
    if (this.failNext) {
      const failure = this.failNext;
      delete this.failNext;
      return this.error(failure.status, failure.reason, failure.message, failure.headers);
    }
    return this.#compute(method, url, body);
  };

  // ---------------------------------------------------------------------------------- helpers

  json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  error(
    status: number,
    reason: string,
    message = reason,
    headers: Record<string, string> = {},
  ): Response {
    return this.json(
      status,
      { error: { code: status, message, errors: [{ reason, message }] } },
      headers,
    );
  }

  /** Adds an instance as GCE would return it; shorthand for tests that seed machines. */
  addInstance(zone: string, name: string, extra: Json = {}): Json {
    const type = extra.machineType ?? 'n2-standard-4';
    const instance = this.#buildInstance(zone, {
      name,
      machineType: `zones/${zone}/machineTypes/${String(type).split('/').pop()}`,
      ...extra,
    });
    instance.status = extra.status ?? 'RUNNING';
    this.instances.set(`${zone}/${name}`, instance);
    return instance;
  }

  #mintToken(prefix: string): string {
    const token = `ya29.${prefix}-${this.mintedTokens.length + 1}-${randomUUID().slice(0, 8)}`;
    this.mintedTokens.push(token);
    this.validTokens.add(token);
    return token;
  }

  async #oauthToken(init?: RequestInit): Promise<Response> {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      return this.json(400, { error: 'unsupported_grant_type' });
    const parts = (form.get('assertion') ?? '').split('.');
    if (parts.length !== 3) return this.json(400, { error: 'invalid_grant' });
    this.jwtClaims.push(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Json);
    return this.json(200, {
      access_token: this.#mintToken('sa'),
      expires_in: this.tokenLifetimeSeconds,
      token_type: 'Bearer',
    });
  }

  #metadataToken(url: URL, headers: Headers): Response {
    this.metadataFlavors.push(headers.get('metadata-flavor'));
    if (headers.get('metadata-flavor') !== 'Google')
      return this.json(403, { error: 'Missing Metadata-Flavor:Google header.' });
    if (!url.pathname.endsWith('/service-accounts/default/token'))
      return this.json(404, { error: 'not found' });
    return this.json(200, {
      access_token: this.#mintToken('md'),
      expires_in: this.tokenLifetimeSeconds,
      token_type: 'Bearer',
    });
  }

  #generateAccessToken(url: URL, headers: Headers, body?: Json): Response {
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    if (!bearer || !this.validTokens.has(bearer))
      return this.json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    const match = /\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(url.pathname);
    if (!match || !Array.isArray(body?.scope))
      return this.json(400, { error: { code: 400, message: 'bad request' } });
    return this.json(200, {
      accessToken: this.#mintToken('imp'),
      expireTime: new Date(Date.now() + 3600_000).toISOString(),
    });
  }

  // -------------------------------------------------------------------------------- operations

  #operation(
    scope: Operation['scope'],
    scopeName: string | undefined,
    operationType: string,
    targetLink: string,
    apply: () => void,
    requestId?: string | null,
  ): Response {
    if (requestId && this.#requestIds.has(requestId))
      return this.json(200, this.#operationBody(this.#requestIds.get(requestId)!));
    const operation: Operation = {
      name: `operation-${++this.#operationSeq}`,
      scope,
      scopeName,
      operationType,
      targetLink,
      remaining: this.operationDelayTicks,
    };
    if (this.failNextOperation) {
      const failure = this.failNextOperation;
      delete this.failNextOperation;
      operation.error = {
        errors: [{ code: failure.code, message: failure.message ?? failure.code }],
      };
      operation.httpErrorStatusCode = failure.httpErrorStatusCode ?? 400;
    } else apply();
    this.operations.set(operation.name, operation);
    if (requestId) this.#requestIds.set(requestId, operation);
    return this.json(200, this.#operationBody(operation));
  }

  #operationBody(operation: Operation): Json {
    const scopePath =
      operation.scope === 'global' ? 'global' : `${operation.scope}/${operation.scopeName}`;
    const body: Json = {
      kind: 'compute#operation',
      name: operation.name,
      operationType: operation.operationType,
      targetLink: operation.targetLink,
      selfLink: `${origin}/projects/p/${scopePath}/operations/${operation.name}`,
      status: operation.remaining > 0 ? 'RUNNING' : 'DONE',
    };
    if (operation.scope === 'zones')
      body.zone = `${origin}/projects/p/zones/${operation.scopeName}`;
    if (operation.scope === 'regions')
      body.region = `${origin}/projects/p/regions/${operation.scopeName}`;
    if (body.status === 'DONE' && operation.error) {
      body.error = operation.error;
      body.httpErrorStatusCode = operation.httpErrorStatusCode;
    }
    return body;
  }

  // ----------------------------------------------------------------------------------- compute

  #page<T>(url: URL, items: T[]): { slice: T[]; next?: string } {
    const requested = Number(url.searchParams.get('maxResults') ?? this.maxResults);
    const size = Math.max(1, Math.min(requested, this.maxResults));
    const start = Number(url.searchParams.get('pageToken') ?? 0);
    const slice = items.slice(start, start + size);
    return start + size < items.length ? { slice, next: String(start + size) } : { slice };
  }

  /** `labels.k=v`, `labels.k:*`, `name=x` clauses joined by AND. */
  #filter(url: URL, items: Json[]): Json[] {
    const filter = url.searchParams.get('filter');
    if (!filter) return items;
    return items.filter((item) =>
      filter.split(/\s+AND\s+/i).every((clause) => {
        const present = /^\(?\s*(labels\.[^\s:=]+)\s*:\s*\*\s*\)?$/.exec(clause.trim());
        if (present) return item.labels?.[present[1]!.slice('labels.'.length)] !== undefined;
        const equal = /^\(?\s*([\w.-]+)\s*(=|!=)\s*"?([^")]*)"?\s*\)?$/.exec(clause.trim());
        if (!equal) return true;
        const [, key, operator, value] = equal;
        const actual = key!.startsWith('labels.')
          ? item.labels?.[key!.slice('labels.'.length)]
          : item[key!];
        return operator === '=' ? String(actual) === value : String(actual) !== value;
      }),
    );
  }

  #aggregated(url: URL, field: string, items: { scope: string; item: Json }[]): Response {
    const { slice, next } = this.#page(url, items);
    const grouped: Record<string, Json> = {};
    for (const { scope, item } of slice) (grouped[scope] ??= { [field]: [] })[field].push(item);
    return this.json(200, { id: 'agg', items: grouped, ...(next ? { nextPageToken: next } : {}) });
  }

  #list(url: URL, items: Json[]): Response {
    const { slice, next } = this.#page(url, items);
    return this.json(200, { items: slice, ...(next ? { nextPageToken: next } : {}) });
  }

  #compute(method: string, url: URL, body?: Json): Response {
    const path = url.pathname.replace(/^\/compute\/v1\/projects\/[^/]+/, '');
    const segments = path.split('/').filter(Boolean);
    const [first, second, third, fourth, fifth, sixth] = segments;

    // aggregated lists
    if (first === 'aggregated' && method === 'GET') {
      if (second === 'instances')
        return this.#aggregated(
          url,
          'instances',
          this.#filter(url, [...this.instances.values()]).map((item) => ({
            scope: `zones/${String(item.zone).split('/').pop()}`,
            item,
          })),
        );
      if (second === 'machineTypes')
        return this.#aggregated(
          url,
          'machineTypes',
          this.machineTypes.map((type) => ({
            scope: `zones/${type.zone}`,
            item: this.#machineTypeBody(type),
          })),
        );
      if (second === 'reservations')
        return this.#aggregated(
          url,
          'reservations',
          this.reservations.map((item) => ({
            scope: `zones/${String(item.zone).split('/').pop()}`,
            item,
          })),
        );
      if (second === 'futureReservations')
        return this.#aggregated(
          url,
          'futureReservations',
          this.futureReservations.map((item) => ({
            scope: `zones/${String(item.zone).split('/').pop()}`,
            item,
          })),
        );
    }

    // operations
    if (
      method === 'GET' &&
      ((first === 'global' && second === 'operations') ||
        ((first === 'zones' || first === 'regions') && third === 'operations'))
    ) {
      const name = first === 'global' ? third : fourth;
      const operation = this.operations.get(name ?? '');
      if (!operation) return this.error(404, 'notFound', `Operation ${name} not found`);
      const body = this.#operationBody(operation);
      if (operation.remaining > 0) operation.remaining -= 1;
      return this.json(200, body);
    }

    if (first === 'zones' && second)
      return this.#zonal(method, url, second, segments.slice(2), body);
    if (first === 'regions' && second && third === 'subnetworks')
      return this.#subnetworks(method, url, second, fourth, body);
    if (first === 'global' && second === 'networks')
      return this.#networks(method, url, third, body);
    if (first === 'global' && second === 'firewalls')
      return this.#firewalls(method, url, third, body);
    if (first === 'global' && second === 'instanceTemplates' && method === 'GET') {
      const template = this.instanceTemplates.get(third ?? '');
      return template
        ? this.json(200, template)
        : this.error(404, 'notFound', 'template not found');
    }
    void fifth;
    void sixth;
    return this.error(404, 'notFound', `The emulator does not serve ${method} ${path}`);
  }

  #machineTypeBody(type: EmulatedMachineType): Json {
    return {
      kind: 'compute#machineType',
      name: type.name,
      zone: type.zone,
      guestCpus: type.guestCpus,
      memoryMb: type.memoryMb,
      ...(type.accelerators ? { accelerators: type.accelerators } : {}),
      selfLink: `${origin}/projects/p/zones/${type.zone}/machineTypes/${type.name}`,
    };
  }

  #buildInstance(zone: string, body: Json): Json {
    const typeName = String(body.machineType).split('/').pop()!;
    const type = this.machineTypes.find((entry) => entry.zone === zone && entry.name === typeName);
    const id = String(++this.#instanceSeq);
    const labels: Record<string, string> = { ...(body.labels ?? {}) };
    const interfaces = ((body.networkInterfaces as Json[] | undefined) ?? [{}]).map(
      (nic, index) => ({
        name: `nic${index}`,
        network: nic.network ?? `${origin}/projects/p/global/networks/default`,
        ...(nic.subnetwork ? { subnetwork: nic.subnetwork } : {}),
        networkIP: `10.128.0.${Number(id) % 250}`,
        ...(nic.accessConfigs
          ? {
              accessConfigs: (nic.accessConfigs as Json[]).map(() => ({
                type: 'ONE_TO_ONE_NAT',
                natIP: `203.0.113.${Number(id) % 250}`,
              })),
            }
          : {}),
      }),
    );
    const instance: Json = {
      kind: 'compute#instance',
      id,
      creationTimestamp: '2026-10-01T00:00:00.000-07:00',
      name: body.name,
      zone: `${origin}/projects/p/zones/${zone}`,
      machineType: `${origin}/projects/p/zones/${zone}/machineTypes/${typeName}`,
      status: 'RUNNING',
      labels,
      labelFingerprint: randomUUID().slice(0, 8),
      metadata: body.metadata ?? { items: [] },
      disks: body.disks ?? [],
      networkInterfaces: interfaces,
      tags: { items: [...(body.tags?.items ?? [])], fingerprint: randomUUID().slice(0, 8) },
      scheduling: body.scheduling ?? {},
      selfLink: `${origin}/projects/p/zones/${zone}/instances/${body.name}`,
    };
    if (type?.accelerators)
      instance.guestAccelerators = type.accelerators.map((accelerator) => ({
        acceleratorType: `${origin}/projects/p/zones/${zone}/acceleratorTypes/${accelerator.guestAcceleratorType}`,
        acceleratorCount: accelerator.guestAcceleratorCount,
      }));
    if (body.reservationAffinity) instance.reservationAffinity = body.reservationAffinity;
    return instance;
  }

  #zonal(method: string, url: URL, zone: string, rest: string[], body?: Json): Response {
    const [collection, name, action] = rest;
    if (!zones.includes(zone)) return this.error(404, 'notFound', `Zone ${zone} not found`);
    if (collection === 'instances') {
      const target = `${origin}/projects/p/zones/${zone}/instances/${name}`;
      if (!name && method === 'GET')
        return this.#list(
          url,
          this.#filter(
            url,
            [...this.instances.values()].filter((i) => String(i.zone).endsWith(`/${zone}`)),
          ),
        );
      if (!name && method === 'POST') {
        const instanceName = String(body?.name);
        const requestId = url.searchParams.get('requestId');
        if (
          this.instances.has(`${zone}/${instanceName}`) &&
          !(requestId && this.#requestIds.has(requestId))
        )
          return this.error(409, 'alreadyExists', `The resource '${target}' already exists`);
        const typeName = String(body?.machineType).split('/').pop();
        if (!this.machineTypes.some((t) => t.zone === zone && t.name === typeName))
          return this.error(400, 'invalid', `Invalid value for field 'machineType': ${typeName}`);
        return this.#operation(
          'zones',
          zone,
          'insert',
          `${origin}/projects/p/zones/${zone}/instances/${instanceName}`,
          () => {
            const instance = this.#buildInstance(zone, body!);
            instance.status = 'RUNNING';
            this.instances.set(`${zone}/${instanceName}`, instance);
          },
          requestId,
        );
      }
      const instance = this.instances.get(`${zone}/${name}`);
      if (!instance) return this.error(404, 'notFound', `The resource '${target}' was not found`);
      if (method === 'GET' && !action) return this.json(200, instance);
      if (method === 'DELETE' && !action)
        return this.#operation(
          'zones',
          zone,
          'delete',
          target,
          () => {
            this.instances.delete(`${zone}/${name}`);
          },
          url.searchParams.get('requestId'),
        );
      if (method === 'POST' && (action === 'start' || action === 'stop' || action === 'reset')) {
        return this.#operation('zones', zone, action, target, () => {
          instance.status = action === 'stop' ? 'TERMINATED' : 'RUNNING';
        });
      }
      if (method === 'POST' && action === 'setLabels') {
        if (body?.labelFingerprint !== instance.labelFingerprint)
          return this.error(
            412,
            'conditionNotMet',
            'Labels fingerprint either invalid or resource labels have changed',
          );
        return this.#operation('zones', zone, 'setLabels', target, () => {
          instance.labels = { ...(body!.labels ?? {}) };
          instance.labelFingerprint = randomUUID().slice(0, 8);
        });
      }
      if (method === 'POST' && action === 'setTags') {
        if (body?.fingerprint !== instance.tags.fingerprint)
          return this.error(
            412,
            'conditionNotMet',
            'Supplied fingerprint does not match current metadata fingerprint.',
          );
        return this.#operation('zones', zone, 'setTags', target, () => {
          instance.tags = {
            items: [...(body!.items ?? [])],
            fingerprint: randomUUID().slice(0, 8),
          };
        });
      }
    }
    if (collection === 'machineTypes' && method === 'GET' && !name)
      return this.#list(
        url,
        this.machineTypes.filter((t) => t.zone === zone).map((t) => this.#machineTypeBody(t)),
      );
    if (collection === 'machineTypes' && method === 'GET' && name) {
      const type = this.machineTypes.find((t) => t.zone === zone && t.name === name);
      return type
        ? this.json(200, this.#machineTypeBody(type))
        : this.error(404, 'notFound', 'machine type not found');
    }
    return this.error(
      404,
      'notFound',
      `The emulator does not serve zones/${zone}/${rest.join('/')}`,
    );
  }

  #global(
    store: Map<string, Json>,
    kind: 'networks' | 'firewalls',
    method: string,
    url: URL,
    name: string | undefined,
    body: Json | undefined,
  ): Response {
    const target = (n: string) => `${origin}/projects/p/global/${kind}/${n}`;
    if (!name && method === 'GET') return this.#list(url, [...store.values()]);
    if (!name && method === 'POST') {
      const created = String(body?.name);
      if (store.has(created))
        return this.error(409, 'alreadyExists', `The resource '${target(created)}' already exists`);
      return this.#operation(
        'global',
        undefined,
        'insert',
        target(created),
        () =>
          store.set(created, {
            kind: `compute#${kind.slice(0, -1)}`,
            selfLink: target(created),
            ...body,
          }),
        url.searchParams.get('requestId'),
      );
    }
    const existing = name ? store.get(name) : undefined;
    if (!name || !existing)
      return this.error(404, 'notFound', `The resource '${target(String(name))}' was not found`);
    if (method === 'GET') return this.json(200, existing);
    if (method === 'DELETE') {
      if (kind === 'networks') {
        const inUse =
          [...this.subnetworks.values()].some((s) =>
            String(s.network).endsWith(`/networks/${name}`),
          ) ||
          [...this.instances.values()].some((i) =>
            (i.networkInterfaces as Json[]).some((nic) =>
              String(nic.network).endsWith(`/networks/${name}`),
            ),
          );
        if (inUse)
          return this.error(
            400,
            'resourceInUseByAnotherResource',
            `The network resource '${target(name)}' is already being used`,
          );
      }
      return this.#operation('global', undefined, 'delete', target(name), () => {
        store.delete(name);
      });
    }
    if (method === 'PATCH')
      return this.#operation('global', undefined, 'patch', target(name), () => {
        store.set(name, { ...existing, ...body });
      });
    return this.error(404, 'notFound', 'unsupported');
  }

  #networks(method: string, url: URL, name: string | undefined, body?: Json): Response {
    return this.#global(this.networks, 'networks', method, url, name, body);
  }

  #firewalls(method: string, url: URL, name: string | undefined, body?: Json): Response {
    return this.#global(this.firewalls, 'firewalls', method, url, name, body);
  }

  #subnetworks(
    method: string,
    url: URL,
    region: string,
    name: string | undefined,
    body?: Json,
  ): Response {
    const target = (n: string) => `${origin}/projects/p/regions/${region}/subnetworks/${n}`;
    if (!name && method === 'POST') {
      const created = String(body?.name);
      if (this.subnetworks.has(`${region}/${created}`))
        return this.error(409, 'alreadyExists', `The resource '${target(created)}' already exists`);
      return this.#operation(
        'regions',
        region,
        'insert',
        target(created),
        () =>
          this.subnetworks.set(`${region}/${created}`, {
            kind: 'compute#subnetwork',
            region: `${origin}/projects/p/regions/${region}`,
            selfLink: target(created),
            ...body,
          }),
        url.searchParams.get('requestId'),
      );
    }
    const existing = name ? this.subnetworks.get(`${region}/${name}`) : undefined;
    if (!name || !existing)
      return this.error(404, 'notFound', `The resource '${target(String(name))}' was not found`);
    if (method === 'GET') return this.json(200, existing);
    if (method === 'DELETE')
      return this.#operation('regions', region, 'delete', target(name), () => {
        this.subnetworks.delete(`${region}/${name}`);
      });
    return this.error(404, 'notFound', 'unsupported');
  }
}
