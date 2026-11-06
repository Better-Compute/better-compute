import type { DoConfig } from '../config.js';
import type { DoSize } from './types.js';

// Spot GPU Droplets (P3, DO-D14). DigitalOcean sells Spot GPU capacity (public preview since
// 2026-08-10): idle GPUs at a daily price at or below on-demand, which DO may reclaim with at
// least two hours' notice, sent by email only.
//
// UNVERIFIED: DO's public OpenAPI (checked 2026-11-05) names no Spot member, neither on a size
// nor on a Droplet create. Everything this provider assumes about the wire shape is the data
// below, in one place, so the opt-in live suite settles it by changing this file alone
// (decision D-P3-5). Until then the assumptions fail safe:
//
// - A size offers Spot only when its catalog entry carries a positive `spot_price_hourly`; a
//   catalog without it yields no Spot offer at all, whatever `allowSpot` says.
// - A Spot create sends `capacity_type: 'spot'`. A Droplet better-compute creates for a Spot offer
//   carries the tag `better-compute-capacity:spot`, so it reads back with its `@spot` offer id
//   whatever DO's own reply says.

export const spotShape = {
  /** The member of a size (`GET /sizes`) holding its Spot price per hour, in USD. */
  sizePriceField: 'spot_price_hourly',
  /** What a Spot create adds to the Droplet create body. */
  createBody: { capacity_type: 'spot' } as Readonly<Record<string, string>>,
  verified: false,
} as const;

/**
 * Whether the account may use Spot at all: `allowSpot`, and, while the wire shape above is a guess,
 * `previews` as well (Spot is a DigitalOcean preview). An unverified Spot create that DO ignored
 * would be an on-demand GPU Droplet at full price that better-compute tags and treats as Spot.
 */
export function spotEnabled(config: Pick<DoConfig, 'allowSpot' | 'previews'>): boolean {
  return config.allowSpot === true && (spotShape.verified || config.previews === true);
}

/** The Spot price per hour of a size, when DigitalOcean offers Spot capacity for it. */
export function spotPriceOf(size: DoSize): number | undefined {
  const price = (size as unknown as Record<string, unknown>)[spotShape.sizePriceField];
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : undefined;
}
