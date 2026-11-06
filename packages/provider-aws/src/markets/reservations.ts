import {
  ComputeError,
  type ExternalReservation,
  type Offer,
  type OfferQuery,
} from '@better-compute/core';
import type { XmlElement } from '@better-compute/aws-core';
import type { InstanceTypeInfo } from '../shapes.js';

// On-Demand Capacity Reservations and Capacity Blocks for ML (AWS A3, AD11). Both are EC2 capacity
// reservations (`DescribeCapacityReservations`); a block has `reservationType=capacity-block`. They
// become `ExternalReservation`s, and the ready ones with free slots become offers
// `<zone>/<type>@<cr-id>` that vps admits against (`claimReservationSlot`).

/** ODCR / block state → `ExternalReservation.state`; a state not listed is omitted (gone or unknown). */
const reservationStates: Readonly<Record<string, ExternalReservation['state']>> = {
  active: 'ready',
  scheduled: 'scheduled',
  'payment-pending': 'scheduled',
  assessing: 'scheduled',
  delayed: 'scheduled',
  pending: 'creating',
};

/** The states worth reading: everything else (expired, cancelled, failed, …) is omitted anyway. */
export const liveReservationStates = Object.keys(reservationStates);

/** The prefix of a Capacity Block's reservation id (`cb:cr-…`). */
export const blockPrefix = 'cb:';

export interface CapacityReservationInfo {
  /** `cr-…` */
  capacityReservationId: string;
  ownerId: string;
  instanceType: string;
  /** The zone name as this account sees it. */
  zone: string;
  platform: string;
  tenancy: string;
  total: number;
  available: number;
  state: string;
  startsAt?: number;
  endsAt?: number;
  targeted: boolean;
  block: boolean;
}

const count = (text: string | undefined): number => {
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const time = (text: string | undefined): number | undefined => {
  if (!text) return undefined;
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * One `capacityReservationSet` item. The zone comes from the zone id when EC2 gives one: a
 * reservation shared through RAM is named by its owner's AZ mapping, which differs between accounts.
 */
export function parseCapacityReservation(
  item: XmlElement,
  zoneNames: ReadonlyMap<string, string>,
): CapacityReservationInfo | undefined {
  const id = item.textOf('capacityReservationId');
  const type = item.textOf('instanceType');
  if (!id || !/^cr-[0-9a-f]{8,17}$/.test(id) || !type) return undefined;
  const zoneId = item.textOf('availabilityZoneId');
  const zone = (zoneId ? zoneNames.get(zoneId) : undefined) ?? item.textOf('availabilityZone');
  if (!zone) return undefined;
  const startsAt = time(item.textOf('startDate'));
  const endsAt = time(item.textOf('endDate'));
  return {
    capacityReservationId: id,
    ownerId: item.textOf('ownerId') ?? '',
    instanceType: type,
    zone,
    platform: item.textOf('instancePlatform') ?? '',
    tenancy: item.textOf('tenancy') ?? 'default',
    total: count(item.textOf('totalInstanceCount')),
    available: count(item.textOf('availableInstanceCount')),
    state: item.textOf('state') ?? '',
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    targeted: item.textOf('instanceMatchCriteria') === 'targeted',
    block: item.textOf('reservationType') === 'capacity-block',
  };
}

/** The reservation id vps knows a reservation by: `cr-…`, or `cb:cr-…` for a Capacity Block. */
export function reservationIdOf(
  info: Pick<CapacityReservationInfo, 'capacityReservationId' | 'block'>,
) {
  return info.block ? `${blockPrefix}${info.capacityReservationId}` : info.capacityReservationId;
}

/**
 * Whether better-compute can launch into the reservation at all: Linux/UNIX, default tenancy (create
 * launches neither Windows nor dedicated instances) and in one of the account's zones.
 */
export function usable(info: CapacityReservationInfo, zones: readonly string[]): boolean {
  return info.platform === 'Linux/UNIX' && info.tenancy === 'default' && zones.includes(info.zone);
}

/** The reservation as an `ExternalReservation`; undefined for a state that is gone or unknown. */
export function toReservation(
  info: CapacityReservationInfo,
  context: {
    region: string;
    /** The account's own AWS account id. */
    account: string;
    types: ReadonlyMap<string, InstanceTypeInfo>;
  },
): ExternalReservation | undefined {
  const state = Object.hasOwn(reservationStates, info.state)
    ? reservationStates[info.state]
    : undefined;
  if (!state) return undefined;
  const type = context.types.get(info.instanceType);
  const id = reservationIdOf(info);
  const total = info.total;
  return {
    id,
    name: info.block ? `cb-${info.capacityReservationId}` : info.capacityReservationId,
    zone: info.zone,
    region: context.region,
    state,
    machineType: info.instanceType,
    vcpu: type?.vcpu ?? 0,
    memoryGiB: type?.memoryGiB ?? 0,
    ...(type?.gpus ? { gpus: { ...type.gpus } } : {}),
    ...(type?.instanceStorageGiB ? { localSsdGiB: type.instanceStorageGiB } : {}),
    total,
    inUse: Math.max(0, total - Math.min(info.available, total)),
    // A Capacity Block only ever takes launches that target it.
    specificOnly: info.block || info.targeted,
    shared: info.ownerId !== context.account,
    ...(info.startsAt !== undefined ? { startsAt: info.startsAt } : {}),
    ...(info.endsAt !== undefined ? { endsAt: info.endsAt } : {}),
    offerId: `${info.zone}/${info.instanceType}@${info.capacityReservationId}`,
  };
}

/** Whether an offer passes the query's shape filters. */
export function matchesQuery(query: OfferQuery, offer: Offer): boolean {
  if (query.gpuModel !== undefined && offer.gpus?.model !== query.gpuModel) return false;
  if (query.minGpus !== undefined && (offer.gpus?.count ?? 0) < query.minGpus) return false;
  if (query.minVcpu !== undefined && offer.vcpu < query.minVcpu) return false;
  if (query.minMemoryGiB !== undefined && offer.memoryGiB < query.minMemoryGiB) return false;
  return true;
}

/** A ready reservation's offer: its free slots are `count`. */
export function reservationOffer(
  reservation: ExternalReservation,
  info: { diskGiB: number; arch?: 'x86_64' | 'arm64'; bareMetal?: boolean },
): Offer | undefined {
  if (reservation.state !== 'ready' || reservation.vcpu <= 0 || reservation.memoryGiB <= 0)
    return undefined;
  if (info.bareMetal) return undefined;
  const free = Math.max(0, reservation.total - reservation.inUse);
  return {
    id: reservation.offerId,
    kind: 'vps',
    region: reservation.region,
    vcpu: reservation.vcpu,
    memoryGiB: reservation.memoryGiB,
    diskGiB: info.diskGiB,
    ...(reservation.gpus ? { gpus: { ...reservation.gpus } } : {}),
    available: free > 0,
    market: reservation.id.startsWith(blockPrefix) ? 'capacity-block' : 'reserved',
    ...(info.arch ? { arch: info.arch } : {}),
    count: free,
  };
}

/** The error create raises for a reservation it cannot launch into. */
export function unusableReservation(id: string, why: string, reason: string): ComputeError {
  return new ComputeError('INVALID_INPUT', `capacity reservation ${id} ${why}`, undefined, {
    provider: 'aws',
    reason,
  });
}
