import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

/** Ownership tags (AD6). */
export const tags = {
  managed: 'better-compute:managed',
  instance: 'better-compute:instance',
  tenant: 'better-compute:tenant',
  pool: 'better-compute:pool',
  name: 'Name',
} as const;

/** The EC2 instance id; `INVALID_INPUT` otherwise. */
export function parseInstanceId(id: string): string {
  if (typeof id !== 'string' || !/^i-[0-9a-f]{8,17}$/.test(id))
    throw new ComputeError('INVALID_INPUT', 'not an EC2 instance id', undefined, { provider: 'aws' });
  return id;
}

export interface ParsedOffer {
  zone: string;
  instanceType: string;
  /** A capacity reservation id (`cr-…`). */
  reservation?: string;
  market: 'on-demand' | 'spot';
}

const offerPattern =
  /^([a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}(?:[a-z]|-[a-z]{2,10}-\d{1,2}[a-z]))\/([a-z][a-z0-9-]*\.[a-z0-9-]+)(?:@(cr-[0-9a-f]{8,17}))?(:spot)?$/;

/** `<zone>/<type>[@<cr-id>][:spot]` (AD5). */
export function offerId(offer: ParsedOffer): string {
  return `${offer.zone}/${offer.instanceType}${offer.reservation ? `@${offer.reservation}` : ''}${offer.market === 'spot' ? ':spot' : ''}`;
}

export function parseOfferId(id: string): ParsedOffer {
  const match = typeof id === 'string' ? offerPattern.exec(id) : null;
  if (!match)
    throw new ComputeError('INVALID_INPUT', 'not an AWS offer id (<zone>/<instanceType>[@<cr-id>][:spot])', undefined, {
      provider: 'aws',
    });
  const [, zone, instanceType, reservation, spot] = match;
  return {
    zone: zone!,
    instanceType: instanceType!,
    ...(reservation ? { reservation } : {}),
    market: spot ? 'spot' : 'on-demand',
  };
}

/** The idempotency ClientToken: `hex(sha256(key))[0:64]` (AD5). */
export function clientToken(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 64);
}

/** A tag value EC2 accepts: letters, digits, spaces and `_.:/=+-@`, at most 256 characters. */
export function tagValue(value: string): string {
  return Array.from(String(value).replace(/[^\p{L}\p{N} _.:/=+\-@]/gu, '')).slice(0, 256).join('');
}
