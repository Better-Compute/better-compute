// (P3) Spot capacity in provider pools. A leaf module: admission, estimates and the lifecycle read it.

/**
 * The capability a provider declares (`defineProvider({ capabilities })`) when its `...@spot` offer
 * ids name Spot (preemptible) capacity (DigitalOcean DO-D8).
 */
export const spotOffersCapability = 'spot-offers';

/** Whether the provider declares the `@spot` offer convention (`spotOffersCapability`). */
export function declaresSpotOffers(
  provider: { capabilities?: readonly string[] | undefined } | undefined,
): boolean {
  return provider?.capabilities?.includes(spotOffersCapability) === true;
}

/**
 * Whether an offer id names Spot capacity: an `@spot` suffix (`<region>/<size>@spot`), and only on
 * a provider that declares the convention. The suffix shares the `@` with reservation-backed offers
 * (`<zone>/<machineType>@<reservation>`): on any other provider `...@spot` names a reservation
 * called `spot`, which admission requires to exist, and a loss there is never a preemption.
 */
export function isSpotOffer(
  offerId: string | undefined,
  provider: { capabilities?: readonly string[] | undefined } | undefined,
): boolean {
  return offerId?.endsWith('@spot') === true && declaresSpotOffers(provider);
}
