import type { DoEmulator, RouteContext, RouteResult } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// Domains and their records under `/v2/domains`. A new domain gets DigitalOcean's three NS records
// and an SOA at the apex (plus an A record when the create names `ip_address`); a domain that is
// already in the account is the 422 `already exists`. Records: list (paged, filtered by the full
// `name` and by `type`), create, read, replace (PUT) and delete. A record's `name` is relative to
// the zone (`@` is the apex). What DO validates: a known type, a name and data, a TTL of at least
// 30, `priority` for MX and SRV, `port` and `weight` for SRV, `flags` and `tag` for CAA. Deleting a
// domain deletes its records.

const templates = fixture('domains');
const domainTemplate = templates.domain as Json;
const recordTemplate = templates.domain_record as Json;
const nameServers = templates.name_servers as string[];
const types = new Set(['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'SOA', 'SRV', 'TXT']);

function unprocessable(message: string): RouteResult {
  return {
    status: 422,
    body: { id: 'unprocessable_entity', message, request_id: 'emulated-dns' },
  };
}

function zoneRecords(state: DoState, zone: string): Json[] {
  return [...state.domainRecords.values()].filter((r) => r.zone === zone);
}

/** A record as DO answers it: without the emulator's `zone`. */
function shown(record: Json): Json {
  const { zone: _zone, ...rest } = record;
  return structuredClone(rest);
}

function addRecord(state: DoState, zone: string, fields: Json): Json {
  const record: Json = {
    ...structuredClone(recordTemplate),
    priority: null,
    port: null,
    weight: null,
    flags: null,
    tag: null,
    ttl: 1800,
    ...fields,
    id: state.nextId(),
    zone,
  };
  state.domainRecords.set(record.id, record);
  return record;
}

/** Puts a domain in the account, as if added out of band; returns the stored resource. */
export function seedDomain(state: DoState, name: string, records: Json[] = []): Json {
  const domain = { ...structuredClone(domainTemplate), name };
  state.domains.set(name, domain);
  for (const ns of nameServers) addRecord(state, name, { type: 'NS', name: '@', data: ns });
  addRecord(state, name, { type: 'SOA', name: '@', data: '1800', ttl: 1800 });
  for (const record of records) addRecord(state, name, record);
  return domain;
}

/** Adds a record to a domain of the account, as if made out of band; returns it as stored. */
export function seedRecord(state: DoState, zone: string, record: Json): Json {
  return addRecord(state, zone, record);
}

function refusal(body: Json): RouteResult | undefined {
  if (!types.has(body.type) || body.type === 'SOA') return unprocessable('Type is invalid');
  if (typeof body.name !== 'string' || body.name === '') return unprocessable('Name is required');
  if (typeof body.data !== 'string' || body.data === '') return unprocessable('Data is required');
  if (body.ttl !== undefined && body.ttl !== null && body.ttl < 30)
    return unprocessable('TTL must be at least 30');
  if ((body.type === 'MX' || body.type === 'SRV') && !Number.isInteger(body.priority))
    return unprocessable('Priority is required');
  if (body.type === 'SRV' && (!Number.isInteger(body.port) || !Number.isInteger(body.weight)))
    return unprocessable('Port and weight are required');
  if (body.type === 'CAA' && (!Number.isInteger(body.flags) || !body.tag))
    return unprocessable('Flags and tag are required');
  return undefined;
}

function fqdn(zone: string, name: string): string {
  return name === '@' ? zone : `${name}.${zone}`;
}

function domainOr404(context: RouteContext): Json | RouteResult {
  const domain = context.state.domains.get(decodeURIComponent(context.match[1]!));
  return domain ?? context.emulator.error('not-found');
}

const isResult = (value: Json | RouteResult): value is RouteResult =>
  typeof (value as RouteResult).status === 'number';

export function registerDns(emulator: DoEmulator): void {
  emulator.route('GET', /^\/domains$/, (context) =>
    emulator.paged(context, 'domains', structuredClone([...context.state.domains.values()])),
  );
  emulator.route('POST', /^\/domains$/, (context) => {
    const { state } = context;
    const name = context.body?.name;
    if (typeof name !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name))
      return unprocessable('Name is invalid');
    if (state.domains.has(name)) return unprocessable(`Domain ${name} already exists`);
    const domain = seedDomain(state, name);
    if (typeof context.body?.ip_address === 'string')
      addRecord(state, name, { type: 'A', name: '@', data: context.body.ip_address });
    return { status: 201, body: { domain: structuredClone(domain) } };
  });
  emulator.route('GET', /^\/domains\/([^/]+)$/, (context) => {
    const domain = domainOr404(context);
    if (isResult(domain)) return domain;
    return { status: 200, body: { domain: structuredClone(domain) } };
  });
  emulator.route('DELETE', /^\/domains\/([^/]+)$/, (context) => {
    const domain = domainOr404(context);
    if (isResult(domain)) return domain;
    for (const record of zoneRecords(context.state, domain.name))
      context.state.domainRecords.delete(record.id);
    context.state.domains.delete(domain.name);
    return { status: 204 };
  });
  emulator.route('GET', /^\/domains\/([^/]+)\/records$/, (context) => {
    const domain = domainOr404(context);
    if (isResult(domain)) return domain;
    const name = context.url.searchParams.get('name');
    const type = context.url.searchParams.get('type');
    const records = zoneRecords(context.state, domain.name).filter(
      (r) =>
        (name === null || fqdn(domain.name, r.name) === name) && (type === null || r.type === type),
    );
    return emulator.paged(context, 'domain_records', records.map(shown));
  });
  emulator.route('POST', /^\/domains\/([^/]+)\/records$/, (context) => {
    const domain = domainOr404(context);
    if (isResult(domain)) return domain;
    const body = context.body ?? {};
    const refused = refusal(body);
    if (refused) return refused;
    const record = addRecord(context.state, domain.name, {
      type: body.type,
      name: body.name,
      data: body.data,
      priority: body.priority ?? null,
      port: body.port ?? null,
      weight: body.weight ?? null,
      flags: body.flags ?? null,
      tag: body.tag ?? null,
      ttl: body.ttl ?? 1800,
    });
    return { status: 201, body: { domain_record: shown(record) } };
  });
  const recordRoute = /^\/domains\/([^/]+)\/records\/(\d+)$/;
  const recordOf = (context: RouteContext): Json | RouteResult => {
    const domain = domainOr404(context);
    if (isResult(domain)) return domain;
    const record = context.state.domainRecords.get(Number(context.match[2]));
    if (!record || record.zone !== domain.name) return emulator.error('not-found');
    return record;
  };
  emulator.route('GET', recordRoute, (context) => {
    const record = recordOf(context);
    if (isResult(record)) return record;
    return { status: 200, body: { domain_record: shown(record) } };
  });
  emulator.route('PUT', recordRoute, (context) => {
    const record = recordOf(context);
    if (isResult(record)) return record;
    const body = { ...shown(record), ...(context.body ?? {}) };
    const refused = refusal(body);
    if (refused) return refused;
    if (body.type !== record.type) return unprocessable('Type cannot be changed');
    Object.assign(record, {
      name: body.name,
      data: body.data,
      priority: body.priority ?? null,
      port: body.port ?? null,
      weight: body.weight ?? null,
      flags: body.flags ?? null,
      tag: body.tag ?? null,
      ttl: body.ttl ?? 1800,
    });
    return { status: 200, body: { domain_record: shown(record) } };
  });
  emulator.route('DELETE', recordRoute, (context) => {
    const record = recordOf(context);
    if (isResult(record)) return record;
    context.state.domainRecords.delete(record.id);
    return { status: 204 };
  });
}
