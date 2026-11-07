import { isIPv4, isIPv6 } from 'node:net';
import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Logger,
  type ProviderDns,
  type ProviderDnsRecordSpec,
  type ProviderDnsZoneSpec,
  type ProviderResourceState,
} from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { deploymentHash } from '../ids.js';

// DNS zones (DO domains) and records (P4). DO gives a domain and a record neither tags nor a
// description, so a zone better-compute makes carries a marker: the TXT record
// `_better-compute.<zone>` = `deployment=<hash12>`, written right after the create. A zone without
// a marker is someone else's: `ensureZone` refuses it (`CONFLICT`, fail closed) unless asked to
// `adopt` it, and `deleteZone` never deletes it. A zone with another deployment's marker is never
// taken, adopted or deleted. A new zone is never made inside or above an account domain without
// this deployment's marker (`CONFLICT`, `zoneNested`): DO's name servers serve every zone of the
// account, and that domain may be the operator's own. `deleteZone` also refuses a zone of ours that still holds records other
// than DO's apex NS and SOA and the marker: deleting a domain deletes every record in it, and those
// may be a tenant's own.
//
// Records are found by the id an earlier ensure returned, else by identical name, type and data
// (host names compared without the final dot, which DO may or may not hand back); a record changes
// its data, TTL and its type's fields in place (one PUT). The marker and the apex NS records are
// DO's and this provider's own: no call ever writes or deletes them. DNS changes are synchronous,
// so every state is `ready` or `deleted`.

/** The relative name of the marker record a zone better-compute made carries. */
export const dnsMarkerName = '_better-compute';
const markerTtl = 3600;
const minTtl = 30;

const zonePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const labelSource = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const recordNamePattern = new RegExp(`^(?:\\*|${labelSource})(?:\\.${labelSource})*$`);
const hostPattern =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;
const recordIdPattern = /^[1-9][0-9]{0,15}$/;
const recordTypes = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA', 'NS']);
const hostTypes = new Set(['CNAME', 'MX', 'SRV', 'NS']);
const caaTags = new Set(['issue', 'issuewild', 'iodef']);

/** A domain record (`GET /domains/{zone}/records/{id}`). */
export interface DoDomainRecord {
  id: number;
  type: string;
  name: string;
  data: string;
  priority?: number | null;
  port?: number | null;
  ttl?: number | null;
  weight?: number | null;
  flags?: number | null;
  tag?: string | null;
}

function fail(
  code: 'INVALID_INPUT' | 'INVALID_STATE' | 'CONFLICT' | 'NOT_FOUND',
  message: string,
  reason: string,
): ComputeError {
  return new ComputeError(code, message, undefined, { provider: 'digitalocean', reason });
}

/** A zone name, lowercased; anything that is not a domain is `INVALID_INPUT`. */
export function parseZoneName(name: string): string {
  const zone = typeof name === 'string' ? name.toLowerCase() : '';
  if (!zonePattern.test(zone))
    throw fail('INVALID_INPUT', `${JSON.stringify(name)} is not a DNS zone name`, 'zone');
  return zone;
}

function parseRecordId(id: string): number {
  if (!recordIdPattern.test(id))
    throw fail(
      'INVALID_INPUT',
      `${JSON.stringify(id)} is not a DigitalOcean record id`,
      'recordId',
    );
  return Number(id);
}

/** Whether a record is the provider's own or DO's: the marker, the apex NS or the SOA. */
function reserved(record: { name: string; type: string }): boolean {
  const name = record.name.toLowerCase();
  return (
    name === dnsMarkerName || (name === '@' && (record.type === 'NS' || record.type === 'SOA'))
  );
}

/** Data as compared: host names without the final dot and lowercased, TXT without quotes. */
function dataKey(type: string, data: string): string {
  if (hostTypes.has(type)) return data.toLowerCase().replace(/\.$/, '');
  if (type === 'TXT') return data.replace(/^"(.*)"$/s, '$1');
  if (type === 'AAAA') return data.toLowerCase();
  return data;
}

function fqdnOf(zone: string, name: string): string {
  return name === '@' ? zone : `${name}.${zone}`;
}

/** The body DO takes for a record spec. */
function recordBody(spec: ProviderDnsRecordSpec, name: string): Record<string, unknown> {
  return {
    type: spec.type,
    name,
    data: spec.data,
    ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
    ...(spec.port !== undefined ? { port: spec.port } : {}),
    ...(spec.weight !== undefined ? { weight: spec.weight } : {}),
    ...(spec.flags !== undefined ? { flags: spec.flags } : {}),
    ...(spec.tag !== undefined ? { tag: spec.tag } : {}),
    ...(spec.ttlSeconds !== undefined ? { ttl: spec.ttlSeconds } : {}),
  };
}

/** Whether a record differs from the spec in what the spec sets (besides name and type). */
function recordDiffers(record: DoDomainRecord, spec: ProviderDnsRecordSpec): boolean {
  if (dataKey(record.type, record.data) !== dataKey(spec.type, spec.data)) return true;
  const fields: [unknown, unknown][] = [
    [spec.ttlSeconds, record.ttl],
    [spec.priority, record.priority],
    [spec.port, record.port],
    [spec.weight, record.weight],
    [spec.flags, record.flags],
    [spec.tag, record.tag],
  ];
  return fields.some(([want, have]) => want !== undefined && want !== have);
}

const state = (
  id: string,
  value: ProviderResourceState['state'],
  outputs?: Record<string, string>,
): ProviderResourceState => ({ id, state: value, ...(outputs ? { outputs } : {}) });

function recordOutputs(zone: string, record: DoDomainRecord): Record<string, string> {
  const optional: [string, unknown][] = [
    ['priority', record.priority],
    ['port', record.port],
    ['weight', record.weight],
    ['flags', record.flags],
    ['tag', record.tag],
  ];
  return {
    name: record.name,
    type: record.type,
    data: record.data,
    fqdn: fqdnOf(zone, record.name),
    ...(typeof record.ttl === 'number' ? { ttlSeconds: String(record.ttl) } : {}),
    ...Object.fromEntries(
      optional
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ),
  };
}

type Marker = 'ours' | 'other' | 'none';

export class DoDns implements ProviderDns {
  protected readonly client: DoClient;
  protected readonly log: Logger;
  /** The marker record's data for this deployment. */
  protected readonly marker: string;

  constructor(client: DoClient, deployment: string, log: Logger) {
    this.client = client;
    this.log = log;
    this.marker = `deployment=${deploymentHash(deployment)}`;
  }

  protected zonePath(zone: string): string {
    return `/domains/${encodeURIComponent(zone)}`;
  }

  /** Whether the zone exists. */
  protected async exists(zone: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.client.request('GET', this.zonePath(zone), { signal, budget: 'observe' });
      return true;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return false;
      throw error;
    }
  }

  /** The zone's records, filtered by full name and type when given; a missing zone is `NOT_FOUND`. */
  protected async records(
    zone: string,
    signal: AbortSignal,
    filter: { name?: string; type?: string } = {},
  ): Promise<DoDomainRecord[]> {
    const out: DoDomainRecord[] = [];
    try {
      for await (const record of this.client.pages<DoDomainRecord>(
        `${this.zonePath(zone)}/records`,
        'domain_records',
        {
          query: {
            ...(filter.name !== undefined ? { name: filter.name } : {}),
            ...(filter.type !== undefined ? { type: filter.type } : {}),
          },
          signal,
          budget: 'observe',
        },
      ))
        out.push(record);
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND'))
        throw fail('NOT_FOUND', `DNS zone ${zone} does not exist`, 'zone');
      throw error;
    }
    return out;
  }

  /** Whose the zone is, by its marker records: any other deployment's marker makes it `other`. */
  protected async markerOf(zone: string, signal: AbortSignal): Promise<Marker> {
    const markers = await this.records(zone, signal, {
      name: fqdnOf(zone, dnsMarkerName),
      type: 'TXT',
    });
    const data = markers
      .filter((r) => r.name.toLowerCase() === dnsMarkerName)
      .map((r) => dataKey('TXT', r.data));
    if (data.some((d) => d !== this.marker)) return 'other';
    return data.length > 0 ? 'ours' : 'none';
  }

  protected async zoneState(
    zone: string,
    marker: Marker,
    signal: AbortSignal,
  ): Promise<ProviderResourceState> {
    const ns = (await this.records(zone, signal, { name: zone, type: 'NS' }))
      .filter((r) => r.name === '@')
      .map((r) => r.data.toLowerCase().replace(/\.$/, ''))
      .sort();
    return state(zone, 'ready', {
      nameServers: ns.join(','),
      adopted: marker === 'ours' ? 'false' : 'true',
    });
  }

  // ------------------------------------------------------------------------------------- zones

  /**
   * Refuses (`CONFLICT`, reason `zoneNested`) a new zone inside or above a domain of the account that is not this
   * deployment's: DO's name servers serve every zone of the account, so a zone nested in the operator's own domain (a
   * shared, root-issued account) would publish records under it. vps arbitrates nesting between its own (marked)
   * zones; anything unmarked, or marked by another deployment, is never nested in or wrapped.
   */
  protected async refuseNested(zone: string, signal: AbortSignal): Promise<void> {
    const related: string[] = [];
    for await (const domain of this.client.pages<{ name: string }>('/domains', 'domains', {
      signal,
      budget: 'observe',
    })) {
      const name =
        typeof domain.name === 'string' ? domain.name.toLowerCase().replace(/\.$/, '') : '';
      if (name && name !== zone && (zone.endsWith(`.${name}`) || name.endsWith(`.${zone}`)))
        related.push(name);
    }
    for (const name of related)
      if ((await this.markerOf(name, signal)) !== 'ours')
        throw fail(
          'CONFLICT',
          `DNS zone ${zone} would nest ${zone.endsWith(`.${name}`) ? 'inside' : 'above'} ${name}, a zone on the account that this better-compute deployment did not make`,
          'zoneNested',
        );
  }

  async ensureZone(spec: ProviderDnsZoneSpec, ctx: CallContext): Promise<ProviderResourceState> {
    const zone = parseZoneName(spec.name);
    const { signal } = ctx;
    if (await this.exists(zone, signal)) {
      const marker = await this.markerOf(zone, signal);
      if (marker === 'other')
        throw fail(
          'CONFLICT',
          `DNS zone ${zone} belongs to another better-compute deployment; it is never taken over`,
          'otherDeployment',
        );
      if (marker === 'none' && !spec.adopt)
        throw fail(
          'CONFLICT',
          `DNS zone ${zone} already exists and was not made by better-compute; adopt it to manage its records`,
          'zoneExists',
        );
      return this.zoneState(zone, marker, signal);
    }
    await this.refuseNested(zone, signal);
    try {
      await this.client.request('POST', '/domains', {
        body: { name: zone },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (isComputeError(error, 'CONFLICT'))
        throw fail('CONFLICT', `DNS zone ${zone} already exists at DigitalOcean`, 'zoneExists');
      throw error;
    }
    this.log.info('digitalocean.zoneCreated', { zone });
    try {
      await this.client.request('POST', `${this.zonePath(zone)}/records`, {
        body: { type: 'TXT', name: dnsMarkerName, data: this.marker, ttl: markerTtl },
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      // The zone is ours but carries no marker: the next ensure refuses it until it is adopted.
      this.log.warn('digitalocean.zoneMarkerMissing', { zone });
      throw error;
    }
    return this.zoneState(zone, 'ours', signal);
  }

  async getZone(zone: string, ctx: CallContext): Promise<ProviderResourceState | undefined> {
    const name = typeof zone === 'string' ? zone.toLowerCase() : '';
    if (!zonePattern.test(name)) return undefined;
    if (!(await this.exists(name, ctx.signal))) return undefined;
    return this.zoneState(name, await this.markerOf(name, ctx.signal), ctx.signal);
  }

  async deleteZone(zone: string, ctx: CallContext): Promise<ProviderResourceState> {
    const name = parseZoneName(zone);
    const { signal } = ctx;
    if (!(await this.exists(name, signal))) return state(name, 'deleted');
    if ((await this.markerOf(name, signal)) !== 'ours')
      throw fail(
        'INVALID_STATE',
        `DNS zone ${name} was not made by this better-compute deployment and is never deleted by it`,
        'notManaged',
      );
    const left = (await this.records(name, signal)).filter((r) => !reserved(r));
    if (left.length > 0)
      throw fail(
        'CONFLICT',
        `DNS zone ${name} still holds ${left.length} record(s) better-compute did not delete; delete them first`,
        'zoneNotEmpty',
      );
    try {
      await this.client.request('DELETE', this.zonePath(name), { signal, budget: 'mutate' });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log.info('digitalocean.zoneDeleted', { zone: name });
    return state(name, 'deleted');
  }

  // ----------------------------------------------------------------------------------- records

  /** Refuses what DO would refuse, and the records that are not vps's to write, before any request. */
  protected validateRecord(spec: ProviderDnsRecordSpec): string {
    const bad = (reason: string, message: string) => fail('INVALID_INPUT', message, reason);
    if (spec.id !== undefined) parseRecordId(spec.id);
    if (!recordTypes.has(spec.type))
      throw bad('type', `record type ${String(spec.type)} is not supported`);
    const name = typeof spec.name === 'string' ? spec.name.toLowerCase() : '';
    if (name !== '@' && !recordNamePattern.test(name))
      throw bad(
        'name',
        `${JSON.stringify(spec.name)} is not a record name relative to its zone ('@' for the apex)`,
      );
    if (reserved({ name, type: spec.type }))
      throw bad(
        'reservedRecord',
        `${spec.type} ${name} is DigitalOcean's or better-compute's own record`,
      );
    const data = typeof spec.data === 'string' ? spec.data : '';
    const dataOk =
      spec.type === 'A'
        ? isIPv4(data)
        : spec.type === 'AAAA'
          ? isIPv6(data)
          : hostTypes.has(spec.type)
            ? data === '@' || hostPattern.test(data)
            : data !== '' && data.length <= 4096;
    if (!dataOk) throw bad('data', `${JSON.stringify(spec.data)} is not ${spec.type} record data`);
    const int = (value: unknown, min: number, max: number) =>
      Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
    if (spec.ttlSeconds !== undefined && !int(spec.ttlSeconds, minTtl, 2_147_483_647))
      throw bad('ttl', `a record's TTL is at least ${minTtl} seconds`);
    if ((spec.type === 'MX' || spec.type === 'SRV') && !int(spec.priority, 0, 65535))
      throw bad('priority', `an ${spec.type} record takes a priority from 0 to 65535`);
    if (spec.type === 'SRV' && (!int(spec.port, 1, 65535) || !int(spec.weight, 0, 65535)))
      throw bad('port', 'an SRV record takes a port and a weight');
    if (spec.type === 'CAA' && (!int(spec.flags, 0, 255) || !caaTags.has(spec.tag ?? '')))
      throw bad('caa', 'a CAA record takes flags (0-255) and a tag: issue, issuewild or iodef');
    return name;
  }

  protected recordPath(zone: string, id: number): string {
    return `${this.zonePath(zone)}/records/${id}`;
  }

  protected async record(
    zone: string,
    id: number,
    signal: AbortSignal,
  ): Promise<DoDomainRecord | undefined> {
    try {
      const reply = await this.client.request<{ domain_record: DoDomainRecord }>(
        'GET',
        this.recordPath(zone, id),
        { signal, budget: 'observe' },
      );
      return reply.domain_record;
    } catch (error) {
      if (isComputeError(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
  }

  async ensureRecord(
    zone: string,
    spec: ProviderDnsRecordSpec,
    ctx: CallContext,
  ): Promise<ProviderResourceState> {
    const zoneName = parseZoneName(zone);
    const name = this.validateRecord(spec);
    const { signal } = ctx;
    const body = recordBody(spec, name);
    let found: DoDomainRecord | undefined;
    if (spec.id !== undefined) {
      found = await this.record(zoneName, parseRecordId(spec.id), signal);
      if (found && (found.name.toLowerCase() !== name || found.type !== spec.type))
        throw fail(
          'INVALID_STATE',
          `record ${spec.id} in ${zoneName} is ${found.type} ${found.name}, not ${spec.type} ${name}`,
          'notThisRecord',
        );
    }
    found ??= (
      await this.records(zoneName, signal, { name: fqdnOf(zoneName, name), type: spec.type })
    ).find(
      (r) =>
        r.name.toLowerCase() === name && dataKey(r.type, r.data) === dataKey(spec.type, spec.data),
    );
    if (!found) {
      const reply = await this.client.request<{ domain_record: DoDomainRecord }>(
        'POST',
        `${this.zonePath(zoneName)}/records`,
        { body, signal, budget: 'mutate' },
      );
      this.log.info('digitalocean.recordCreated', {
        zone: zoneName,
        record: reply.domain_record.id,
      });
      return state(
        String(reply.domain_record.id),
        'ready',
        recordOutputs(zoneName, reply.domain_record),
      );
    }
    if (!recordDiffers(found, spec))
      return state(String(found.id), 'ready', recordOutputs(zoneName, found));
    const reply = await this.client.request<{ domain_record: DoDomainRecord }>(
      'PUT',
      this.recordPath(zoneName, found.id),
      { body, signal, budget: 'mutate' },
    );
    this.log.info('digitalocean.recordUpdated', { zone: zoneName, record: found.id });
    return state(String(found.id), 'ready', recordOutputs(zoneName, reply.domain_record));
  }

  async getRecord(
    zone: string,
    id: string,
    ctx: CallContext,
  ): Promise<ProviderResourceState | undefined> {
    const zoneName = typeof zone === 'string' ? zone.toLowerCase() : '';
    if (!zonePattern.test(zoneName) || !recordIdPattern.test(id)) return undefined;
    const record = await this.record(zoneName, Number(id), ctx.signal);
    return record ? state(id, 'ready', recordOutputs(zoneName, record)) : undefined;
  }

  async deleteRecord(
    zone: string,
    id: string,
    ctx: CallContext,
    expected?: { name: string; type: ProviderDnsRecordSpec['type'] },
  ): Promise<ProviderResourceState> {
    const zoneName = parseZoneName(zone);
    const recordId = parseRecordId(id);
    const { signal } = ctx;
    const record = await this.record(zoneName, recordId, signal);
    if (!record) return state(id, 'deleted');
    if (reserved(record))
      throw fail(
        'INVALID_STATE',
        `${record.type} ${record.name} in ${zoneName} is DigitalOcean's or better-compute's own record; it is never deleted`,
        'reservedRecord',
      );
    if (
      expected &&
      (record.name.toLowerCase() !== expected.name.toLowerCase() || record.type !== expected.type)
    )
      throw fail(
        'INVALID_STATE',
        `record ${id} in ${zoneName} is ${record.type} ${record.name}, not ${expected.type} ${expected.name}; it is not deleted`,
        'notThisRecord',
      );
    try {
      await this.client.request('DELETE', this.recordPath(zoneName, recordId), {
        signal,
        budget: 'mutate',
      });
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    this.log.info('digitalocean.recordDeleted', { zone: zoneName, record: recordId });
    return state(id, 'deleted');
  }
}
