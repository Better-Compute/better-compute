import { type MeterSpec, type PriceSpecInput, type ProviderListPrice } from '@better-compute/core';

// Price proposals (platform compute billing, D14): what root could charge for the provider meters, from the
// provider's list prices and a margin. Pure: nothing here reads a database, calls a provider or sets a price. Root
// reads the proposals and publishes the ones it wants through `billing.setPrices`.

/** One proposed price: `per-unit` at the provider's price plus the margin, with the SKUs it came from. */
export interface PriceProposal {
  meter: string;
  spec: PriceSpecInput;
  basis: { sku: string; unitPriceMicros: number }[];
}

export interface PriceProposals {
  proposals: PriceProposal[];
  /** Provider meters the list prices give no basis for. */
  unpriced: string[];
  /** The currency of every proposal: the deployment currency the provider prices were matched to. */
  currency: string;
}

/** A flavor that carries a whole-shape meter, as far as proposals need it. */
export interface FlavorMeterBasis {
  meter: string;
  vcpu: number;
  memoryGiB: number;
  gpus: number;
  /** The catalog GPU family of the flavor's pool (`h100`), when it has GPUs and one is known. */
  gpuModel?: string;
  /** The flavor's offer id (`us-central1-a/n2-standard-4`). */
  offerId?: string;
}

/**
 * Machine families whose cheapest vCPU and memory prices are the basis of `vm.vcpu.hours` and
 * `vm.memory.gib.hours` (D4): general-purpose families only, so a specialised family never sets the base rate.
 * Per-family accuracy is what flavor meters are for.
 */
export const generalPurposeFamilies: ReadonlySet<string> = new Set([
  'e2',
  'n1',
  'n2',
  'n2d',
  'n4',
  't2d',
  'c3',
  'c3d',
  'c4',
]);

/** A GiB of memory is weighed this many times against a vCPU when choosing the cheapest family. */
const referenceGibPerVcpu = 4;

/** Meters whose price a provider's list could set; hosted, node and sandbox meters are the platform's own. */
export const isProviderMeter = (key: string): boolean =>
  /^(vm|disk|ip|network|snapshot|flavor)\./.test(key);

/**
 * The zone and machine family of an offer id spelled `zone/machine-type[@reservation]` (Compute Engine's):
 * `us-central1-a/n2-standard-4` is `{ region: 'us-central1', family: 'n2' }`. Any other spelling gives none, and the
 * flavor's meter is left unpriced.
 */
export function offerPlacement(
  offerId: string | undefined,
): { region: string; family: string } | undefined {
  const match = /^([a-z]+(?:-[a-z]+)*\d+)-([a-z])\/([a-z0-9]+)-[^@/]+(?:@.*)?$/.exec(offerId ?? '');
  return match ? { region: match[1]!, family: match[3]! } : undefined;
}

const cheapest = (prices: readonly ProviderListPrice[]): ProviderListPrice | undefined =>
  [...prices].sort(
    (a, b) =>
      a.unitPriceMicros - b.unitPriceMicros ||
      a.region.localeCompare(b.region) ||
      a.sku.localeCompare(b.sku),
  )[0];

const withMargin = (micros: number, marginPct: number): number =>
  Math.round((micros * (100 + marginPct)) / 100);

const proposalOf = (
  meter: string,
  basis: { sku: string; unitPriceMicros: number }[],
  baseMicros: number,
  marginPct: number,
): PriceProposal => ({
  meter,
  spec: { model: 'per-unit', unitAmountMicros: withMargin(baseMicros, marginPct) },
  basis,
});

export interface ProposeInput {
  catalog: readonly MeterSpec[];
  prices: readonly ProviderListPrice[];
  /** Flavors of the account's pools that carry a meter. */
  flavors: readonly FlavorMeterBasis[];
  marginPct: number;
  /** Only this region's prices; absent: the cheapest across every region the provider listed. */
  region?: string;
  /** The deployment currency: prices in another currency are not used (they are never mixed). */
  currency: string;
}

/**
 * A proposal for every provider meter of the catalog the list prices cover. `vm.vcpu.hours` and
 * `vm.memory.gib.hours` take the cheapest general-purpose family (by one vCPU and four GiB); GPU meters the cheapest
 * SKU of the model, on demand or Spot; ancillary meters the matching SKU; a flavor meter the sum of its family's vCPU,
 * memory and GPU SKUs for the flavor's shape. Meters with no basis (`vm.instance.hours`, reserved and grant meters,
 * managed VMs, networks, snapshots) are `unpriced`.
 */
export function proposePrices(input: ProposeInput): PriceProposals {
  const usable = input.prices.filter(
    (price) =>
      price.currency === input.currency &&
      (input.region === undefined || price.region === input.region),
  );
  const onDemand = usable.filter((price) => !price.spot);
  const spot = usable.filter((price) => price.spot);
  const proposals: PriceProposal[] = [];
  const unpriced: string[] = [];
  const basisOf = (...prices: ProviderListPrice[]) =>
    prices.map((price) => ({ sku: price.sku, unitPriceMicros: price.unitPriceMicros }));

  // D4: the region's cheapest general-purpose family, by its vCPU and memory SKUs together.
  const groups = new Map<string, { vcpu: ProviderListPrice[]; memory: ProviderListPrice[] }>();
  for (const price of onDemand) {
    if (!price.machineFamily || !generalPurposeFamilies.has(price.machineFamily)) continue;
    if (price.resource !== 'vcpu' && price.resource !== 'memory') continue;
    const key = `${price.region}\u0000${price.machineFamily}`;
    const group = groups.get(key) ?? { vcpu: [], memory: [] };
    group[price.resource === 'vcpu' ? 'vcpu' : 'memory'].push(price);
    groups.set(key, group);
  }
  let base: { vcpu: ProviderListPrice; memory: ProviderListPrice } | undefined;
  let baseScore = Number.POSITIVE_INFINITY;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const vcpu = cheapest(group.vcpu);
    const memory = cheapest(group.memory);
    if (!vcpu || !memory) continue;
    const score = vcpu.unitPriceMicros + referenceGibPerVcpu * memory.unitPriceMicros;
    if (score < baseScore) {
      base = { vcpu, memory };
      baseScore = score;
    }
  }

  const gpuMeter = /^vm\.gpu\.([a-z0-9-]+?)(\.spot)?\.hours$/;
  const disk = /^disk\.([a-z0-9-]+)\.gib\.hours$/;
  for (const meter of input.catalog) {
    const key = meter.key;
    if (!isProviderMeter(key)) continue;
    let proposal: PriceProposal | undefined;
    if (key === 'vm.vcpu.hours' && base)
      proposal = proposalOf(key, basisOf(base.vcpu), base.vcpu.unitPriceMicros, input.marginPct);
    else if (key === 'vm.memory.gib.hours' && base)
      proposal = proposalOf(
        key,
        basisOf(base.memory),
        base.memory.unitPriceMicros,
        input.marginPct,
      );
    else if (gpuMeter.test(key)) {
      const [, model, isSpot] = gpuMeter.exec(key)!;
      const found = cheapest(
        (isSpot ? spot : onDemand).filter(
          (price) => price.resource === 'gpu' && price.gpuModel === model,
        ),
      );
      if (found) proposal = proposalOf(key, basisOf(found), found.unitPriceMicros, input.marginPct);
    } else if (key === 'ip.public.hours') {
      const found = cheapest(onDemand.filter((price) => price.resource === 'ip'));
      if (found) proposal = proposalOf(key, basisOf(found), found.unitPriceMicros, input.marginPct);
    } else if (disk.test(key)) {
      const type = disk.exec(key)![1];
      const found = cheapest(
        onDemand.filter((price) => price.resource === 'disk' && price.diskType === type),
      );
      if (found) proposal = proposalOf(key, basisOf(found), found.unitPriceMicros, input.marginPct);
    } else if (key.startsWith('flavor.')) {
      proposal = flavorProposal(key, input, onDemand);
    }
    if (proposal) proposals.push(proposal);
    else unpriced.push(key);
  }
  return { proposals, unpriced, currency: input.currency };
}

/**
 * A flavor meter: the flavor's vCPUs, memory and GPUs at its family's SKUs in the offer's region. The flavors that
 * carry the meter must agree on shape and offer, else the meter is not priced (one meter, one price).
 */
function flavorProposal(
  meter: string,
  input: ProposeInput,
  onDemand: readonly ProviderListPrice[],
): PriceProposal | undefined {
  const flavors = input.flavors.filter((flavor) => flavor.meter === meter);
  const first = flavors[0];
  if (!first) return undefined;
  const same = flavors.every(
    (flavor) =>
      flavor.vcpu === first.vcpu &&
      flavor.memoryGiB === first.memoryGiB &&
      flavor.gpus === first.gpus &&
      flavor.gpuModel === first.gpuModel &&
      flavor.offerId === first.offerId,
  );
  const placement = offerPlacement(first.offerId);
  if (!same || !placement) return undefined;
  const inRegion = onDemand.filter((price) => price.region === placement.region);
  const family = inRegion.filter((price) => price.machineFamily === placement.family);
  const vcpu = cheapest(family.filter((price) => price.resource === 'vcpu'));
  const memory = cheapest(family.filter((price) => price.resource === 'memory'));
  if (!vcpu || !memory) return undefined;
  const parts: { price: ProviderListPrice; quantity: number }[] = [
    { price: vcpu, quantity: first.vcpu },
    { price: memory, quantity: first.memoryGiB },
  ];
  if (first.gpus > 0) {
    const gpu = first.gpuModel
      ? cheapest(
          inRegion.filter((price) => price.resource === 'gpu' && price.gpuModel === first.gpuModel),
        )
      : undefined;
    if (!gpu) return undefined;
    parts.push({ price: gpu, quantity: first.gpus });
  }
  const total = parts.reduce((sum, part) => sum + part.quantity * part.price.unitPriceMicros, 0);
  return proposalOf(
    meter,
    parts.map((part) => ({ sku: part.price.sku, unitPriceMicros: part.price.unitPriceMicros })),
    total,
    input.marginPct,
  );
}
