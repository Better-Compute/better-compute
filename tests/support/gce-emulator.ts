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
  seq: number;
  /** Runs once when the operation turns DONE without an error. */
  complete?: () => void;
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

/** Machine types that only take Hyperdisk, for tests to add: an A3 Ultra (8 H200s) and a C4. */
export function hyperdiskMachineTypes(): EmulatedMachineType[] {
  const shapes: Omit<EmulatedMachineType, 'zone'>[] = [
    {
      name: 'a3-ultragpu-8g',
      guestCpus: 224,
      memoryMb: 2952 * 1024,
      accelerators: [{ guestAcceleratorType: 'nvidia-h200-141gb', guestAcceleratorCount: 8 }],
    },
    { name: 'c4-standard-8', guestCpus: 8, memoryMb: 30 * 1024 },
  ];
  return zones.flatMap((zone) => shapes.map((shape) => ({ ...shape, zone })));
}

/** The boot disk types every zone offers, with the sizes GCE takes. */
export function defaultDiskTypes(): Record<string, { validDiskSize: string }> {
  return {
    'pd-standard': { validDiskSize: '10GB-65536GB' },
    'pd-balanced': { validDiskSize: '10GB-65536GB' },
    'pd-ssd': { validDiskSize: '10GB-65536GB' },
    'hyperdisk-balanced': { validDiskSize: '4GB-65536GB' },
  };
}

/** Machine families that refuse Persistent Disk, as GCE does (`a3-ultragpu-8g`, `c4-…`). */
const hyperdiskOnlyFamily = /^(a3-ultragpu|a4|a4x|c4|c4a|c4d|n4|x4)-/;

/** A list filter GCE would refuse (HTTP 400 `invalid`). */
class InvalidFilter extends Error {}

export class GceEmulator {
  /** Keyed `zone/name`. Values are GCE `Instance` resources. */
  instances = new Map<string, Json>();
  machineTypes: EmulatedMachineType[] = defaultMachineTypes();
  /** Keyed `zone/diskType`; a zone without an entry does not offer that type. */
  diskTypes = new Map<string, { validDiskSize: string }>(
    zones.flatMap((zone) =>
      Object.entries(defaultDiskTypes()).map(([type, body]) => [`${zone}/${type}`, body] as const),
    ),
  );
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
  /** Runs before an instance action (`setLabels`, `setTags`, `start`, …) is checked and applied. */
  beforeAction?: (action: string, instance: Json) => void;
  /**
   * The next `times` POSTs of this instance action (`setLabels`, …) fail with this GCE error and
   * change nothing (e.g. 400 `resourceNotReady` while a VM is stopping).
   */
  failAction?: { action: string; status: number; reason: string; message?: string; times: number };
  /** New operations stay RUNNING for this many operation GETs. */
  operationDelayTicks = 0;
  /**
   * Instance inserts are RUNNING for at least this many operation GETs, as on GCE (the VM shows as
   * PROVISIONING meanwhile, and a failure such as a stockout only arrives on the operation).
   */
  insertDelayTicks = 1;
  /** The VM only appears once its insert operation is DONE (GCE can answer 404 until then). */
  deferInsert = false;
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
    // [P6 catalog] the Cloud Billing Catalog host (see the section at the end of the class)
    if (url.hostname === 'cloudbilling.googleapis.com') return this.#cloudBilling(method, url, headers);
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
    try {
      return this.#compute(method, url, body);
    } catch (error) {
      if (error instanceof InvalidFilter) return this.error(400, 'invalid', error.message);
      throw error;
    }
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

  /** Lets every running operation finish now (their effects complete; failed ones stay failed). */
  finishOperations(): void {
    for (const operation of this.operations.values()) {
      if (operation.remaining <= 0) continue;
      operation.remaining = 0;
      if (!operation.error) operation.complete?.();
    }
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
    extras: { delay?: number; complete?: () => void } = {},
  ): Response {
    if (requestId && this.#requestIds.has(requestId))
      return this.json(200, this.#operationBody(this.#requestIds.get(requestId)!));
    const operation: Operation = {
      name: `operation-${++this.#operationSeq}`,
      scope,
      scopeName,
      operationType,
      targetLink,
      remaining: extras.delay ?? this.operationDelayTicks,
      seq: this.#operationSeq,
      ...(extras.complete ? { complete: extras.complete } : {}),
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
      id: String(operation.seq),
      insertTime: new Date(Date.UTC(2026, 9, 1, 0, 0, operation.seq)).toISOString(),
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

  /**
   * GCE's two list-filter syntaxes, which do not mix: `=`/`!=` expressions (`labels.k=v`,
   * `labels.k:*`, `name=x`) joined by AND, or RE2 `eq`/`ne` expressions, each in parentheses and
   * joined by whitespace only (`(operationType eq insert) (name eq bc-.+)`), whose
   * literal must match the whole field. An `eq`/`ne` filter with an explicit AND or OR, or one
   * mixed with `=`, is refused as GCE refuses it (400 `invalid`).
   */
  #filter(url: URL, items: Json[]): Json[] {
    const filter = url.searchParams.get('filter');
    if (!filter) return items;
    if (/\s(eq|ne)\s/.test(filter)) {
      const clause = /\(\s*([\w.-]+)\s+(eq|ne)\s+(?:"([^"]*)"|([^\s()"]+))\s*\)/y;
      const clauses: { key: string; operator: string; pattern: RegExp }[] = [];
      let at = 0;
      const text = filter.trim();
      while (at < text.length) {
        clause.lastIndex = at;
        const match = clause.exec(text);
        if (!match)
          throw new InvalidFilter(
            `Invalid list filter expression: ${JSON.stringify(filter)} (eq/ne expressions are parenthesized, joined by spaces only)`,
          );
        clauses.push({
          key: match[1]!,
          operator: match[2]!,
          pattern: new RegExp(`^(?:${match[3] ?? match[4]})$`),
        });
        at = clause.lastIndex;
        while (text[at] === ' ') at++;
      }
      return items.filter((item) =>
        clauses.every(({ key, operator, pattern }) => {
          const actual = key.startsWith('labels.')
            ? item.labels?.[key.slice('labels.'.length)]
            : item[key];
          return pattern.test(String(actual)) === (operator === 'eq');
        }),
      );
    }
    return items.filter((item) =>
      filter.split(/\s+AND\s+/i).every((clause) => {
        const present = /^\(?\s*(labels\.[^\s:=]+)\s*:\s*\*\s*\)?$/.exec(clause.trim());
        if (present) return item.labels?.[present[1]!.slice('labels.'.length)] !== undefined;
        const equal = /^\(?\s*([\w.-]+)\s*(=|!=)\s*"?([^")]*)"?\s*\)?$/.exec(clause.trim());
        if (!equal)
          throw new InvalidFilter(`Invalid list filter expression: ${JSON.stringify(filter)}`);
        const [, key, operator, value] = equal;
        const actual = key!.startsWith('labels.')
          ? item.labels?.[key!.slice('labels.'.length)]
          : item[key!];
        return (String(actual) === value) === (operator === '=');
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

    // the project itself (`failNext` answers 403/404 instead)
    if (segments.length === 0 && method === 'GET') {
      const project = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return this.json(200, {
        kind: 'compute#project',
        id: '123456789',
        name: project,
        selfLink: `${origin}/projects/${project}`,
      });
    }

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
      if (!name) {
        const scoped = [...this.operations.values()].filter(
          (operation) =>
            operation.scope === first && (first === 'global' || operation.scopeName === second),
        );
        return this.#list(
          url,
          this.#filter(
            url,
            scoped.map((operation) => this.#operationBody(operation)),
          ),
        );
      }
      const operation = this.operations.get(name ?? '');
      if (!operation) return this.error(404, 'notFound', `Operation ${name} not found`);
      const body = this.#operationBody(operation);
      if (operation.remaining > 0) {
        operation.remaining -= 1;
        if (operation.remaining === 0 && !operation.error) operation.complete?.();
      }
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
    if (body.resourceStatus) instance.resourceStatus = body.resourceStatus;
    if (body.creationTimestamp) instance.creationTimestamp = body.creationTimestamp;
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
        const bootType = String(
          (body?.disks as Json[] | undefined)?.find((disk) => disk.boot)?.initializeParams
            ?.diskType ?? 'pd-standard',
        )
          .split('/')
          .pop()!;
        if (!this.diskTypes.has(`${zone}/${bootType}`))
          return this.error(400, 'invalid', `Invalid value for field 'diskType': ${bootType}`);
        if (bootType.startsWith('pd-') && hyperdiskOnlyFamily.test(String(typeName)))
          return this.error(
            400,
            'invalid',
            `[${bootType}] disk type cannot be used by [${typeName}] machine type.`,
          );
        const key = `${zone}/${instanceName}`;
        const delay = Math.max(this.operationDelayTicks, this.insertDelayTicks);
        const make = (status: string) => {
          const instance = this.#buildInstance(zone, body!);
          instance.status = status;
          this.instances.set(key, instance);
        };
        return this.#operation(
          'zones',
          zone,
          'insert',
          `${origin}/projects/p/zones/${zone}/instances/${instanceName}`,
          () => {
            if (delay === 0) make('RUNNING');
            else if (!this.deferInsert) make('PROVISIONING');
          },
          requestId,
          {
            delay,
            complete: () => {
              const existing = this.instances.get(key);
              if (existing) existing.status = 'RUNNING';
              else if (this.deferInsert) make('RUNNING');
            },
          },
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
            // Deleting a VM settles its insert (GCE finishes or cancels it).
            for (const operation of this.operations.values())
              if (operation.operationType === 'insert' && operation.targetLink === target)
                operation.remaining = 0;
          },
          url.searchParams.get('requestId'),
        );
      if (method === 'POST' && (action === 'start' || action === 'stop' || action === 'reset')) {
        return this.#operation('zones', zone, action, target, () => {
          instance.status = action === 'stop' ? 'TERMINATED' : 'RUNNING';
        });
      }
      if (method === 'POST' && action) this.beforeAction?.(action, instance);
      if (method === 'POST' && action && this.failAction?.action === action) {
        const failure = this.failAction;
        if (--failure.times <= 0) delete this.failAction;
        return this.error(failure.status, failure.reason, failure.message);
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
    if (collection === 'diskTypes' && method === 'GET' && name) {
      const type = this.diskTypes.get(`${zone}/${name}`);
      return type
        ? this.json(200, {
            kind: 'compute#diskType',
            name,
            zone: `${origin}/projects/p/zones/${zone}`,
            ...type,
            selfLink: `${origin}/projects/p/zones/${zone}/diskTypes/${name}`,
          })
        : this.error(404, 'notFound', `The resource 'projects/p/zones/${zone}/diskTypes/${name}' was not found`);
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
          store.set(
            created,
            this.#withDefaults(kind, {
              kind: `compute#${kind.slice(0, -1)}`,
              selfLink: target(created),
              ...body,
            }),
          ),
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
        store.set(name, this.#withDefaults(kind, { ...existing, ...body }));
      });
    return this.error(404, 'notFound', 'unsupported');
  }

  /** What GCE fills in: a firewall rule's default source and destination ranges. */
  #withDefaults(kind: 'networks' | 'firewalls', resource: Json): Json {
    if (kind !== 'firewalls') return resource;
    const rule: Json = { ...resource, direction: resource.direction ?? 'INGRESS' };
    if (rule.direction === 'INGRESS' && !rule.sourceRanges?.length && !rule.sourceTags?.length)
      rule.sourceRanges = ['0.0.0.0/0'];
    if (rule.direction === 'EGRESS' && !rule.destinationRanges?.length)
      rule.destinationRanges = ['0.0.0.0/0'];
    return rule;
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
    if (method === 'DELETE') {
      const inUse = [...this.instances.values()].some((i) =>
        (i.networkInterfaces as Json[]).some((nic) =>
          String(nic.subnetwork ?? '').endsWith(`/subnetworks/${name}`),
        ),
      );
      if (inUse)
        return this.error(
          400,
          'resourceInUseByAnotherResource',
          `The subnetwork resource '${target(name)}' is already being used`,
        );
    }
    if (method === 'DELETE')
      return this.#operation('regions', region, 'delete', target(name), () => {
        this.subnetworks.delete(`${region}/${name}`);
      });
    return this.error(404, 'notFound', 'unsupported');
  }

  // ======================================================================================================
  // [P6 catalog] Cloud Billing Catalog: GET /v1/services/6F81-5844-456A/skus (Compute Engine), paged by
  // `pageToken`. Tests set `skus` to `cloudbilling.googleapis.com` Sku resources.
  // ======================================================================================================

  /** Sku resources the Compute Engine service lists. */
  skus: Json[] = [];
  /** SKUs per page (a request's `pageSize` can only lower it). */
  skuPageSize = 2;
  /** Fails every catalog request with this GCE-shaped error. */
  catalogFailure?: { status: number; reason: string; message?: string };

  #cloudBilling(method: string, url: URL, headers: Headers): Response {
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    if (!bearer || !this.validTokens.has(bearer))
      return this.error(401, 'authError', 'Invalid Credentials');
    if (this.catalogFailure)
      return this.error(
        this.catalogFailure.status,
        this.catalogFailure.reason,
        this.catalogFailure.message,
      );
    if (method !== 'GET' || url.pathname !== '/v1/services/6F81-5844-456A/skus')
      return this.error(404, 'notFound', 'unsupported catalog request');
    const requested = Number(url.searchParams.get('pageSize') ?? this.skuPageSize);
    const size = Math.max(1, Math.min(requested, this.skuPageSize));
    const start = Number(url.searchParams.get('pageToken') ?? 0);
    const page = this.skus.slice(start, start + size);
    const next = start + size;
    return this.json(200, {
      skus: page,
      ...(next < this.skus.length ? { nextPageToken: String(next) } : {}),
    });
  }
  // ====================================================================================== [/P6 catalog]
}
