import type { AwsEmulator, EmulatorRequest } from './index.js';
import type { Ec2Emulator, EmuInstance } from './ec2.js';
import { ec2Error, ec2Response, el, items, jsonError, requestId } from './xml.js';

// EC2 capacity markets as provider-aws uses them (AWS A3): On-Demand Capacity Reservations and
// Capacity Blocks (DescribeCapacityReservations), launches into them (RunInstances with a
// reservation target consumes a slot; a block needs MarketType=capacity-block), and Spot launches.
// It plugs into Ec2Emulator through its `extra` operations and `runHooks`.

export interface EmuReservation {
  id: string;
  ownerId: string;
  type: string;
  zone: string;
  zoneId?: string;
  platform: string;
  tenancy: 'default' | 'dedicated';
  total: number;
  /** Slots held by instances the emulator does not model (another account's, a console launch). */
  usedElsewhere: number;
  state: string;
  start?: number;
  end?: number;
  match: 'open' | 'targeted';
  reservationType: 'default' | 'capacity-block';
  tags?: Map<string, string>;
  clientToken?: string;
}

/** A Capacity Block on sale. */
export interface EmuBlockOffering {
  id: string;
  type: string;
  zone: string;
  count: number;
  start: number;
  hours: number;
  upfrontFee: number;
}

/** TagSpecification.N with ResourceType `type` → its tags. */
function tagsOf(params: URLSearchParams, type: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (let n = 1; params.has(`TagSpecification.${n}.ResourceType`); n++) {
    if (params.get(`TagSpecification.${n}.ResourceType`) !== type) continue;
    for (let m = 1; params.has(`TagSpecification.${n}.Tag.${m}.Key`); m++)
      tags.set(
        params.get(`TagSpecification.${n}.Tag.${m}.Key`)!,
        params.get(`TagSpecification.${n}.Tag.${m}.Value`) ?? '',
      );
  }
  return tags;
}

/** Filter.N.Name / Filter.N.Value.M → name → values. */
function filtersOf(params: URLSearchParams): Map<string, string[]> {
  const filters = new Map<string, string[]>();
  for (let n = 1; params.has(`Filter.${n}.Name`); n++) {
    const values: string[] = [];
    for (let m = 1; params.has(`Filter.${n}.Value.${m}`); m++)
      values.push(params.get(`Filter.${n}.Value.${m}`)!);
    filters.set(params.get(`Filter.${n}.Name`)!, values);
  }
  return filters;
}

function listOf(params: URLSearchParams, prefix: string): string[] {
  const out: string[] = [];
  for (let n = 1; params.has(`${prefix}.${n}`); n++) out.push(params.get(`${prefix}.${n}`)!);
  return out;
}

const live = (instance: EmuInstance) =>
  instance.state !== 'terminated' && instance.state !== 'shutting-down';

export class CapacityEmulator {
  readonly reservations = new Map<string, EmuReservation>();
  /** Page size cap for DescribeCapacityReservations and DescribeSpotPriceHistory. */
  pageSize = 2;
  /** `<zone>/<type>` → the current Linux/UNIX Spot price in USD per hour. */
  readonly spotPrices = new Map<string, number>([
    ['us-east-1a/t3.micro', 0.0035],
    ['us-east-1b/t3.micro', 0.0037],
    ['us-east-1a/g6.xlarge', 0.3121],
  ]);
  #next = 0;

  constructor(
    private readonly emu: AwsEmulator,
    private readonly ec2: Ec2Emulator,
  ) {
    ec2.extra.set('DescribeCapacityReservations', (request) => this.#describe(request));
    ec2.extra.set('DescribeSpotPriceHistory', (request) => this.#spotPrices(request));
    ec2.extra.set('DescribeCapacityBlockOfferings', (request) => this.#blockOfferings(request));
    ec2.extra.set('PurchaseCapacityBlock', (request) => this.#purchaseBlock(request));
    ec2.extra.set('CreateCapacityReservation', (request) => this.#createReservation(request));
    ec2.runHooks.push({
      check: (params) => this.#check(params),
      launched: (instance, params) => this.#launched(instance, params),
    });
  }

  /** Adds a reservation (an ODCR by default, owned by the platform account, active, open). */
  add(options: Partial<EmuReservation> = {}): EmuReservation {
    const id = options.id ?? `cr-${(++this.#next).toString(16).padStart(17, '0')}`;
    const zone = options.zone ?? 'us-east-1a';
    const reservation: EmuReservation = {
      id,
      ownerId: '111111111111',
      type: 'p5.48xlarge',
      zone,
      zoneId: this.ec2.zones.get(zone),
      platform: 'Linux/UNIX',
      tenancy: 'default',
      total: 2,
      usedElsewhere: 0,
      state: 'active',
      match: 'targeted',
      reservationType: 'default',
      ...options,
    };
    this.reservations.set(id, reservation);
    return reservation;
  }

  /** Slots taken: by modeled live instances launched into it, plus `usedElsewhere`. */
  used(reservation: EmuReservation): number {
    let used = reservation.usedElsewhere;
    for (const instance of this.ec2.instances.values())
      if (instance.capacityReservationId === reservation.id && live(instance)) used++;
    return used;
  }

  #xml(r: EmuReservation): string {
    const available = Math.max(0, r.total - this.used(r));
    return [
      el('capacityReservationId', r.id),
      el('ownerId', r.ownerId),
      el(
        'capacityReservationArn',
        `arn:aws:ec2:us-east-1:${r.ownerId}:capacity-reservation/${r.id}`,
      ),
      el('availabilityZoneId', r.zoneId),
      el('instanceType', r.type),
      el('instancePlatform', r.platform),
      el('availabilityZone', r.zone),
      el('tenancy', r.tenancy),
      el('totalInstanceCount', r.total),
      el('availableInstanceCount', available),
      el('state', r.state),
      el('startDate', r.start === undefined ? undefined : new Date(r.start).toISOString()),
      el('endDate', r.end === undefined ? undefined : new Date(r.end).toISOString()),
      el('endDateType', r.end === undefined ? 'unlimited' : 'limited'),
      el('instanceMatchCriteria', r.match),
      el('reservationType', r.reservationType),
      items(
        'tagSet',
        [...(r.tags ?? [])].map(([key, value]) => `${el('key', key)}${el('value', value)}`),
      ),
    ].join('');
  }

  #describe(request: EmulatorRequest): Response {
    const p = request.params;
    const ids = listOf(p, 'CapacityReservationId');
    const filters = filtersOf(p);
    let found = [...this.reservations.values()];
    if (ids.length) {
      const missing = ids.find((id) => !this.reservations.has(id));
      if (missing)
        return ec2Error(
          'InvalidCapacityReservationId.NotFound',
          `The capacity reservation '${missing}' does not exist`,
        );
      found = ids.map((id) => this.reservations.get(id)!);
    }
    for (const [name, values] of filters) {
      if (name === 'state') found = found.filter((r) => values.includes(r.state));
      else if (name === 'instance-type') found = found.filter((r) => values.includes(r.type));
      else if (name.startsWith('tag:'))
        found = found.filter((r) => values.includes(r.tags?.get(name.slice(4)) ?? '\u0000'));
      else return ec2Error('InvalidParameterValue', `unknown filter ${name}`);
    }
    const start = Number(p.get('NextToken')?.replace(/^tok-/, '') ?? '0');
    const max = Math.min(Number(p.get('MaxResults') ?? Infinity), this.pageSize);
    const page = ids.length ? found : found.slice(start, start + max);
    const next = !ids.length && start + max < found.length ? `tok-${start + max}` : undefined;
    return ec2Response(
      'DescribeCapacityReservations',
      items(
        'capacityReservationSet',
        page.map((r) => this.#xml(r)),
      ) + el('nextToken', next),
    );
  }

  /** Capacity Blocks on sale; DescribeCapacityBlockOfferings filters them. */
  readonly blockOfferings: EmuBlockOffering[] = [];
  /** Every PurchaseCapacityBlock that bought something (a second buy of one offering is a second block). */
  readonly purchases: string[] = [];

  #blockOfferings(request: EmulatorRequest): Response {
    const p = request.params;
    const type = p.get('InstanceType');
    const count = Number(p.get('InstanceCount') ?? '0');
    const hours = Number(p.get('CapacityDurationHours') ?? '0');
    if (!type || !(count > 0) || !(hours > 0))
      return ec2Error('MissingParameter', 'InstanceType, InstanceCount and CapacityDurationHours');
    const from = Date.parse(p.get('StartDateRange') ?? '') || 0;
    const until = Date.parse(p.get('EndDateRange') ?? '') || Infinity;
    const found = this.blockOfferings.filter(
      (o) =>
        o.type === type &&
        o.count === count &&
        o.hours === hours &&
        o.start >= from &&
        o.start + o.hours * 3_600_000 <= until,
    );
    return ec2Response(
      'DescribeCapacityBlockOfferings',
      items(
        'capacityBlockOfferingSet',
        found.map((o) =>
          [
            el('capacityBlockOfferingId', o.id),
            el('instanceType', o.type),
            el('availabilityZone', o.zone),
            el('instanceCount', o.count),
            el('startDate', new Date(o.start).toISOString()),
            el('endDate', new Date(o.start + o.hours * 3_600_000).toISOString()),
            el('capacityBlockDurationHours', o.hours),
            el('upfrontFee', o.upfrontFee.toFixed(2)),
            el('currencyCode', 'USD'),
            el('tenancy', 'default'),
          ].join(''),
        ),
      ),
    );
  }

  #purchaseBlock(request: EmulatorRequest): Response {
    const p = request.params;
    const offering = this.blockOfferings.find((o) => o.id === p.get('CapacityBlockOfferingId'));
    if (!offering)
      return ec2Error('InvalidCapacityBlockOfferingId.NotFound', 'no such Capacity Block offering');
    if (p.get('InstancePlatform') !== 'Linux/UNIX')
      return ec2Error('InvalidParameterValue', 'InstancePlatform');
    this.purchases.push(offering.id);
    // Sold: the offering is not on sale any more.
    this.blockOfferings.splice(this.blockOfferings.indexOf(offering), 1);
    const reservation = this.add({
      type: offering.type,
      zone: offering.zone,
      total: offering.count,
      state: 'payment-pending',
      reservationType: 'capacity-block',
      start: offering.start,
      end: offering.start + offering.hours * 3_600_000,
      tags: tagsOf(p, 'capacity-reservation'),
    });
    return ec2Response(
      'PurchaseCapacityBlock',
      `<capacityReservation>${this.#xml(reservation)}</capacityReservation>`,
    );
  }

  #createReservation(request: EmulatorRequest): Response {
    const p = request.params;
    const token = p.get('ClientToken') ?? undefined;
    const existing = token
      ? [...this.reservations.values()].find((r) => r.clientToken === token)
      : undefined;
    const reservation =
      existing ??
      this.add({
        type: p.get('InstanceType') ?? '',
        zone: p.get('AvailabilityZone') ?? '',
        platform: p.get('InstancePlatform') ?? '',
        total: Number(p.get('InstanceCount') ?? '0'),
        state: 'pending',
        match: p.get('InstanceMatchCriteria') === 'targeted' ? 'targeted' : 'open',
        ...(p.get('EndDate') ? { end: Date.parse(p.get('EndDate')!) } : {}),
        tags: tagsOf(p, 'capacity-reservation'),
        ...(token ? { clientToken: token } : {}),
      });
    return ec2Response(
      'CreateCapacityReservation',
      `<capacityReservation>${this.#xml(reservation)}</capacityReservation>`,
    );
  }

  #spotPrices(request: EmulatorRequest): Response {
    const p = request.params;
    const products = listOf(p, 'ProductDescription');
    const types = listOf(p, 'InstanceType');
    const zones = filtersOf(p).get('availability-zone');
    if (!p.get('StartTime')) return ec2Error('MissingParameter', 'StartTime (latest prices only)');
    const all = [...this.spotPrices].filter(([key]) => {
      const [zone, type] = key.split('/');
      return (
        (products.length === 0 || products.includes('Linux/UNIX')) &&
        (types.length === 0 || types.includes(type!)) &&
        (!zones || zones.includes(zone!))
      );
    });
    const start = Number(p.get('NextToken')?.replace(/^tok-/, '') ?? '0');
    const max = Math.min(Number(p.get('MaxResults') ?? Infinity), this.pageSize);
    const page = all.slice(start, start + max);
    const next = start + max < all.length ? `tok-${start + max}` : undefined;
    const at = new Date(this.emu.now() - 3_600_000).toISOString();
    return ec2Response(
      'DescribeSpotPriceHistory',
      items(
        'spotPriceHistorySet',
        page.map(([key, price]) => {
          const [zone, type] = key.split('/');
          return [
            el('instanceType', type),
            el('productDescription', 'Linux/UNIX'),
            el('spotPrice', price.toFixed(6)),
            el('timestamp', at),
            el('availabilityZone', zone),
          ].join('');
        }),
      ) + el('nextToken', next),
    );
  }

  #check(p: URLSearchParams): Response | undefined {
    const target = p.get(
      'CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId',
    );
    const market = p.get('InstanceMarketOptions.MarketType');
    if (
      market === 'spot' &&
      (p.get('InstanceMarketOptions.SpotOptions.SpotInstanceType') ?? 'one-time') === 'one-time' &&
      p.get('InstanceInitiatedShutdownBehavior') === 'stop'
    )
      return ec2Error(
        'InvalidParameterCombination',
        'A one-time Spot Instance cannot stop on an instance-initiated shutdown',
      );
    if (!target) {
      if (market === 'capacity-block')
        return ec2Error(
          'InvalidParameterCombination',
          'A capacity-block launch must target a Capacity Block',
        );
      return undefined;
    }
    const reservation = this.reservations.get(target);
    if (!reservation)
      return ec2Error(
        'InvalidCapacityReservationId.NotFound',
        `The capacity reservation '${target}' does not exist`,
      );
    const block = reservation.reservationType === 'capacity-block';
    if (block !== (market === 'capacity-block'))
      return ec2Error(
        'InvalidParameterCombination',
        block
          ? 'Launching into a Capacity Block needs MarketType capacity-block'
          : 'MarketType capacity-block needs a Capacity Block',
      );
    if (market === 'spot')
      return ec2Error('InvalidParameterCombination', 'Spot cannot launch into a reservation');
    if (reservation.state !== 'active')
      return ec2Error(
        'InvalidCapacityReservationId.Malformed',
        `The capacity reservation is ${reservation.state}`,
      );
    if (
      p.get('InstanceType') !== reservation.type ||
      (p.get('Placement.AvailabilityZone') ?? 'us-east-1a') !== reservation.zone
    )
      return ec2Error(
        'InvalidParameterValue',
        'The instance does not match the capacity reservation',
      );
    if (this.used(reservation) >= reservation.total)
      return ec2Error(
        'ReservationCapacityExceeded',
        'There is no capacity left in the capacity reservation',
      );
    return undefined;
  }

  #launched(instance: EmuInstance, p: URLSearchParams): void {
    const target = p.get(
      'CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId',
    );
    if (target) instance.capacityReservationId = target;
    const market = p.get('InstanceMarketOptions.MarketType');
    if (market === 'spot' || market === 'capacity-block') instance.lifecycle = market;
  }

  /** The time the emulator sees (for reservations relative to now). */
  now(): number {
    return this.emu.now();
  }
}

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': requestId() },
  });

/** Service Quotas (JSON 1.1, `ServiceQuotasV20190624`): GetServiceQuota for `ec2` quota codes. */
export class ServiceQuotasEmulator {
  /** Quota code → value (vCPUs for the EC2 instance quotas). A code not here does not exist. */
  readonly quotas = new Map<string, number>();

  constructor(emu: AwsEmulator) {
    emu.register(/^servicequotas\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'servicequotas',
      protocol: 'json',
      handle: (request) => this.#handle(request),
    });
  }

  #handle(request: EmulatorRequest): Response {
    if (request.headers.get('x-amz-target')?.split('.')[0] !== 'ServiceQuotasV20190624')
      return jsonError('UnknownOperationException', 'wrong target prefix');
    const body = JSON.parse(request.body || '{}') as { ServiceCode?: string; QuotaCode?: string };
    if (request.operation !== 'GetServiceQuota')
      return jsonError('UnknownOperationException', request.operation);
    const value = body.ServiceCode === 'ec2' ? this.quotas.get(body.QuotaCode ?? '') : undefined;
    if (value === undefined)
      return jsonError('NoSuchResourceException', `no quota ${body.QuotaCode}`);
    return jsonOk({
      Quota: {
        ServiceCode: 'ec2',
        QuotaCode: body.QuotaCode,
        Value: value,
        Unit: 'None',
        Adjustable: true,
      },
    });
  }
}

/**
 * The Price List Query API (JSON 1.1, `AWSPriceListService`): GetProducts for AmazonEC2, paged,
 * answering only the Linux / Shared / no-software / Used filter set provider-aws sends.
 */
export class PricingEmulator {
  /** Instance type → on-demand USD per hour, for us-east-1. */
  readonly prices = new Map<string, number>([
    ['t3.micro', 0.0104],
    ['m7i.large', 0.1008],
    ['g6.xlarge', 0.8048],
    ['p5.48xlarge', 98.32],
    ['m7g.large', 0.0816],
  ]);
  pageSize = 2;

  constructor(emu: AwsEmulator) {
    emu.register(/^api\.pricing\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'pricing',
      protocol: 'json',
      handle: (request) => this.#handle(request),
    });
  }

  #handle(request: EmulatorRequest): Response {
    if (request.headers.get('x-amz-target')?.split('.')[0] !== 'AWSPriceListService')
      return jsonError('UnknownOperationException', 'wrong target prefix');
    if (request.operation !== 'GetProducts')
      return jsonError('UnknownOperationException', request.operation);
    const body = JSON.parse(request.body || '{}') as {
      ServiceCode?: string;
      Filters?: { Type: string; Field: string; Value: string }[];
      MaxResults?: number;
      NextToken?: string;
    };
    if (body.ServiceCode !== 'AmazonEC2') return jsonError('InvalidParameterException', 'service');
    const filters = new Map((body.Filters ?? []).map((f) => [f.Field, f.Value]));
    const wanted: Record<string, string> = {
      regionCode: 'us-east-1',
      operatingSystem: 'Linux',
      tenancy: 'Shared',
      preInstalledSw: 'NA',
      capacitystatus: 'Used',
    };
    let all = [...this.prices];
    for (const [field, value] of Object.entries(wanted)) if (filters.get(field) !== value) all = [];
    const type = filters.get('instanceType');
    if (type) all = all.filter(([name]) => name === type);
    const start = Number(body.NextToken?.replace(/^p-/, '') ?? '0');
    const max = Math.min(body.MaxResults ?? 100, this.pageSize);
    const page = all.slice(start, start + max);
    const next = start + max < all.length ? `p-${start + max}` : undefined;
    const product = ([name, usd]: [string, number], index: number) => {
      const sku = `SKU${String(start + index).padStart(6, '0')}`;
      return JSON.stringify({
        product: {
          productFamily: 'Compute Instance',
          attributes: {
            instanceType: name,
            regionCode: 'us-east-1',
            operatingSystem: 'Linux',
            tenancy: 'Shared',
            preInstalledSw: 'NA',
            capacitystatus: 'Used',
            marketoption: 'OnDemand',
          },
          sku,
        },
        serviceCode: 'AmazonEC2',
        terms: {
          OnDemand: {
            [`${sku}.JRTCKXETXF`]: {
              priceDimensions: {
                [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: {
                  unit: 'Hrs',
                  pricePerUnit: { USD: usd.toFixed(10) },
                  description: `On Demand Linux ${name} Instance Hour`,
                },
              },
              sku,
              offerTermCode: 'JRTCKXETXF',
            },
          },
        },
      });
    };
    return new Response(
      JSON.stringify({
        FormatVersion: 'aws_v1',
        PriceList: page.map(product),
        ...(next ? { NextToken: next } : {}),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': requestId() },
      },
    );
  }
}
