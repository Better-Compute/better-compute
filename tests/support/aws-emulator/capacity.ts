import type { AwsEmulator, EmulatorRequest } from './index.js';
import type { Ec2Emulator, EmuInstance } from './ec2.js';
import { ec2Error, ec2Response, el, items } from './xml.js';

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
  /** Page size cap for DescribeCapacityReservations. */
  pageSize = 2;
  #next = 0;

  constructor(
    private readonly emu: AwsEmulator,
    private readonly ec2: Ec2Emulator,
  ) {
    ec2.extra.set('DescribeCapacityReservations', (request) => this.#describe(request));
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
      items('tagSet', []),
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

  #check(p: URLSearchParams): Response | undefined {
    const target = p.get(
      'CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId',
    );
    const market = p.get('InstanceMarketOptions.MarketType');
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
