// (P3) Spot capacity in provider pools. A leaf module: admission, estimates and the lifecycle read it.

/**
 * Whether an offer id names Spot (preemptible) capacity: the provider convention is an `@spot`
 * suffix (`<region>/<size>@spot`, DigitalOcean DO-D8). It shares the `@` with reservation-backed
 * offers (`<zone>/<machineType>@<reservation>`): admission asks for a reservation row first, so a
 * reservation that is itself named `spot` still admits as one. Providers that sell preemptible
 * capacity under other offer ids are not recognised here.
 */
export function isSpotOffer(offerId: string | undefined): boolean {
  return offerId?.endsWith('@spot') === true;
}
