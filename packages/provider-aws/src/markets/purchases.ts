import {
  ComputeError,
  type ReservationOffering,
  type ReservationOfferingQuery,
} from '@better-compute/core';

// Buying capacity (AWS A3, AD11 / AQ5): Capacity Blocks for ML (DescribeCapacityBlockOfferings,
// PurchaseCapacityBlock) and On-Demand Capacity Reservations to create (CreateCapacityReservation).
// Purchases are off by default (`allowPurchases`), only ever on a platform account, and vps calls
// them only for a root caller after confirmation, with a stable idempotency key.
//
// Offering ids are self-describing, so a purchase can re-check what was confirmed:
//   cb:<zone>/<type>/<count>/<hours>/<startEpochSeconds>/<upfrontCents>/<offering id>
//   odcr:<zone>/<type>/<count>/<hours>
// A block is bought only if EC2 still lists that offering at no more than the confirmed price.

export type ParsedOffering =
  | {
      kind: 'block';
      zone: string;
      instanceType: string;
      count: number;
      hours: number;
      startsAt: number;
      upfrontCents: number;
      offeringId: string;
    }
  | { kind: 'odcr'; zone: string; instanceType: string; count: number; hours: number };

/** Capacity Blocks run 1 to 64 instances; an ODCR at most this many. */
export const maxBlockInstances = 64;
export const maxOdcrInstances = 1_000;
/** 182 days. */
export const maxDurationHours = 182 * 24;

const zonePart = '[a-z]{2}(?:-gov)?-[a-z]+-\\d{1,2}(?:[a-z]|-[a-z]{2,10}-\\d{1,2}[a-z])';
const typePart = '[a-z][a-z0-9-]*\\.[a-z0-9-]+';
const blockPattern = new RegExp(
  `^cb:(${zonePart})/(${typePart})/(\\d{1,3})/(\\d{1,5})/(\\d{9,11})/(\\d{1,12})/([a-z]{2,4}-[0-9a-f]{8,17})$`,
);
const odcrPattern = new RegExp(`^odcr:(${zonePart})/(${typePart})/(\\d{1,4})/(\\d{1,5})$`);

function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message, undefined, {
    provider: 'aws',
    reason: 'offering',
  });
}

/** Checks a query: positive whole counts and hours within EC2's limits. */
export function checkOfferingQuery(query: ReservationOfferingQuery): void {
  if (!/^[a-z][a-z0-9-]*\.[a-z0-9-]+$/.test(query.instanceType ?? ''))
    throw invalid('instanceType is not an EC2 instance type');
  if (!Number.isSafeInteger(query.count) || query.count < 1 || query.count > maxOdcrInstances)
    throw invalid(`count must be a whole number from 1 to ${maxOdcrInstances}`);
  if (
    !Number.isSafeInteger(query.durationHours) ||
    query.durationHours < 1 ||
    query.durationHours > maxDurationHours
  )
    throw invalid(`durationHours must be a whole number from 1 to ${maxDurationHours}`);
  for (const bound of [query.earliestStart, query.latestStart])
    if (bound !== undefined && !Number.isSafeInteger(bound))
      throw invalid('start bounds are epoch ms');
}

export function blockOfferingId(offering: {
  zone: string;
  instanceType: string;
  count: number;
  hours: number;
  startsAt: number;
  upfrontPrice: number;
  offeringId: string;
}): string {
  const cents = Math.round(offering.upfrontPrice * 100);
  return `cb:${offering.zone}/${offering.instanceType}/${offering.count}/${offering.hours}/${Math.floor(offering.startsAt / 1000)}/${cents}/${offering.offeringId}`;
}

export function parseOfferingId(id: string, zones: readonly string[]): ParsedOffering {
  if (typeof id !== 'string') throw invalid('not an AWS reservation offering id');
  const block = blockPattern.exec(id);
  const odcr = block ? null : odcrPattern.exec(id);
  if (!block && !odcr)
    throw invalid(
      'not an AWS reservation offering id (cb:<zone>/<type>/<count>/<hours>/<start>/<cents>/<id> or odcr:<zone>/<type>/<count>/<hours>)',
    );
  const [, zone, instanceType, countText, hoursText] = (block ?? odcr)!;
  const count = Number(countText);
  const hours = Number(hoursText);
  if (!zones.includes(zone!)) throw invalid(`zone ${zone} is not one of this account's zones`);
  if (count < 1 || count > (block ? maxBlockInstances : maxOdcrInstances))
    throw invalid('the offering instance count is out of range');
  if (hours < 1 || hours > maxDurationHours) throw invalid('the offering duration is out of range');
  if (block)
    return {
      kind: 'block',
      zone: zone!,
      instanceType: instanceType!,
      count,
      hours,
      startsAt: Number(block[5]) * 1000,
      upfrontCents: Number(block[6]),
      offeringId: block[7]!,
    };
  return { kind: 'odcr', zone: zone!, instanceType: instanceType!, count, hours };
}

/** The ODCR offering for a query, in a zone that offers the type; only when it may start now. */
export function odcrOffering(
  query: ReservationOfferingQuery,
  zone: string,
  now: number,
  currency: string,
): ReservationOffering | undefined {
  if (query.earliestStart !== undefined && query.earliestStart > now) return undefined;
  if (query.latestStart !== undefined && query.latestStart < now) return undefined;
  return {
    id: `odcr:${zone}/${query.instanceType}/${query.count}/${query.durationHours}`,
    instanceType: query.instanceType,
    zone,
    count: query.count,
    startsAt: now,
    endsAt: now + query.durationHours * 3_600_000,
    // An ODCR is billed at on-demand rates while it is active, nothing up front.
    upfrontPrice: 0,
    currency,
  };
}
