import { createHash } from 'node:crypto';
import {
  ComputeError,
  isComputeError,
  type CallContext,
  type Clock,
  type ProviderCostRecord,
} from '@better-compute/core';
import type { JsonClient } from '@better-compute/aws-core';
import type { AccountCredentials } from './account.js';
import type { AwsConfig } from './config.js';
import { tags } from './ids.js';

// Provider costs (A11, D10) from Cost Explorer `GetCostAndUsage`, DAILY. Cost Explorer charges per request and
// allows two GroupBy keys, so one window is three queries, each filtered to the caller's own linked account
// (a payer role never reads its member accounts) and, in `region` scope, to the account's region and the Local Zone
// groups of its zones (Cost Explorer reports Local Zone usage under the group's own REGION, `us-west-2-lax-1`):
//
// 1. regular usage by the `better-compute:instance` tag and USAGE_TYPE;
// 2. regular usage without that tag, by the `better-compute:tenant` tag and USAGE_TYPE (provider-aws never writes
//    that tag: it attributes what an operator tagged, and the rest comes back untagged);
// 3. everything that is not regular usage (tax, credits, fees, Savings Plan negation) by RECORD_TYPE and SERVICE.
//
// The current UTC day is never read (it is incomplete), and a day read stays cached for `cacheMs`, so the vps
// worker's every-6-hours pass costs at most one read of each day per day.

/** Cost Explorer's record types that are usage at the price of the day (on demand, RI or Savings Plan covered). */
export const regularRecordTypes: readonly string[] = [
  'Usage',
  'DiscountedUsage',
  'SavingsPlanCoveredUsage',
];

const DAY = 86_400_000;
const compute = 'Amazon Elastic Compute Cloud - Compute';
const ec2Other = 'EC2 - Other';
const vpc = 'Amazon Virtual Private Cloud';

/** The labels vps reads from cost rows (`costLabels`), for the AWS tags provider-aws writes. */
const labelOf: Readonly<Record<string, string>> = {
  [tags.instance]: 'better-compute-instance',
  [tags.tenant]: 'better-compute-tenant',
};

/** Usage-type families that are EC2 instance hours (on demand, Spot, dedicated, hosts, Capacity Blocks). */
const instanceHours =
  /^(?:BoxUsage|SpotUsage|DedicatedUsage|HostUsage|HostBoxUsage|ReservedHostUsage|UnusedBox|UnusedDed|DedicatedRes|CapacityBlock)/i;
/** What compute meters besides instance hours: EBS volumes (capacity, IOPS, throughput) and public addresses. */
const meteredFamilies = /^(?:EBS:Volume|PublicIPv4:|ElasticIP:)/i;
const ec2OtherFamilies = /^(?:EBS:|EBSOptimized|NatGateway|ElasticIP:|DataTransfer|CW:)|-Bytes$/i;

/** Usage-type prefixes (`EUC1-`) and their regions; no prefix is us-east-1. */
const usageRegions: Readonly<Record<string, string>> = {
  USE1: 'us-east-1',
  USE2: 'us-east-2',
  USW1: 'us-west-1',
  USW2: 'us-west-2',
  CAN1: 'ca-central-1',
  CAN2: 'ca-west-1',
  SAE1: 'sa-east-1',
  MXC1: 'mx-central-1',
  EU: 'eu-west-1',
  EUW1: 'eu-west-1',
  EUW2: 'eu-west-2',
  EUW3: 'eu-west-3',
  EUC1: 'eu-central-1',
  EUC2: 'eu-central-2',
  EUN1: 'eu-north-1',
  EUS1: 'eu-south-1',
  EUS2: 'eu-south-2',
  APN1: 'ap-northeast-1',
  APN2: 'ap-northeast-2',
  APN3: 'ap-northeast-3',
  APS1: 'ap-southeast-1',
  APS2: 'ap-southeast-2',
  APS3: 'ap-south-1',
  APS4: 'ap-southeast-3',
  APS5: 'ap-south-2',
  APS6: 'ap-southeast-4',
  APE1: 'ap-east-1',
  MES1: 'me-south-1',
  MEC1: 'me-central-1',
  AFS1: 'af-south-1',
  ILC1: 'il-central-1',
  UGW1: 'us-gov-west-1',
  UGE1: 'us-gov-east-1',
  CNN1: 'cn-north-1',
  CNW1: 'cn-northwest-1',
};

const prefixPattern = /^([A-Z]{2,4}\d?)-(.+)$/;
/**
 * A Local Zone or Wavelength segment after the region prefix (`USW2-LAX1-BoxUsage`, `USE1-WL1-BOS1-BoxUsage`):
 * upper-case letters and digits, then `-` and an upper-case letter. A family (`BoxUsage`, `EBS:`, `PublicIPv4:`,
 * `DataTransfer-`) never has that shape.
 */
const zoneSegment = /^[A-Z]{2,4}\d{1,2}-(?=[A-Z])/;

/**
 * The usage type without its region prefix and any Local Zone or Wavelength segments
 * (`USE2-SpotUsage:g5.xlarge` → `SpotUsage:g5.xlarge`, `USW2-LAX1-BoxUsage:t3.medium` → `BoxUsage:t3.medium`).
 */
function usageFamily(usageType: string): string {
  const match = prefixPattern.exec(usageType);
  if (!match || !(match[1]! in usageRegions || /\d$/.test(match[1]!))) return usageType;
  let family = match[2]!;
  for (let segment = 0; segment < 3 && zoneSegment.test(family); segment++)
    family = family.replace(zoneSegment, '');
  return family;
}

/** The region a usage type's prefix names; no prefix is us-east-1, an unknown prefix none. */
export function usageTypeRegion(usageType: string): string | undefined {
  const match = prefixPattern.exec(usageType);
  if (!match || !(match[1]! in usageRegions || /\d$/.test(match[1]!))) return 'us-east-1';
  return usageRegions[match[1]!];
}

/** The Cost Explorer service a usage type belongs to, by its family; `AWS` when this mapping does not know it. */
export function usageTypeService(usageType: string): string {
  const family = usageFamily(usageType);
  if (instanceHours.test(family)) return compute;
  if (/^PublicIPv4:/i.test(family)) return vpc;
  if (ec2OtherFamilies.test(family)) return ec2Other;
  return 'AWS';
}

type SkuRecord = Pick<ProviderCostRecord, 'service' | 'sku' | 'skuDescription'>;

/**
 * How EC2 cost rows relate to compute's own meters (`ProviderDefinition.billing`): instance hours are compute
 * SKUs (never passed through; leak detection's hours), EBS volumes and public IPv4 addresses are metered by
 * compute. A pass-through rule's probe has an empty service and the pattern as its SKU, matched case-insensitively.
 */
export const awsBilling = Object.freeze({
  computeSku: (record: SkuRecord): boolean =>
    (!record.service || record.service === compute) &&
    [record.sku, record.skuDescription ?? ''].some((text) => instanceHours.test(usageFamily(text))),
  meteredSku: (record: SkuRecord): boolean =>
    (!record.service || record.service === ec2Other || record.service === vpc) &&
    [record.sku, record.skuDescription ?? ''].some((text) =>
      meteredFamilies.test(usageFamily(text)),
    ),
});

/**
 * A Cost Explorer decimal amount as integer micros, rounded half away from zero without float drift
 * (`0.0000005` → 1). Cost Explorer writes tiny amounts in scientific notation (`1.2E-5` → 12): the exponent moves
 * the decimal point in the digit string, never through a float. Anything that is not a decimal, or whose whole part
 * has more than 15 digits, is 0; so is a negative amount that rounds to nothing.
 */
export function costMicros(amount: string): number {
  const match = /^(-)?(\d{1,15})(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(
    typeof amount === 'string' ? amount.trim() : '',
  );
  if (!match) return 0;
  const [, sign, written, writtenFraction = '', exponent = '0'] = match;
  // The decimal point sits after `point` of the digits once the exponent has moved it.
  const all = written! + writtenFraction;
  const point = written!.length + Number(exponent);
  const padded = point < 1 ? '0'.repeat(1 - point) + all : all.padEnd(point, '0');
  const at = Math.max(point, 1);
  const whole = padded.slice(0, at).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(at);
  if (whole.length > 15) return 0;
  const digits = (fraction + '0000000').slice(0, 7);
  let value = Number(whole) * 1e6 + Number(digits.slice(0, 6));
  if (Number(digits[6]) >= 5) value += 1;
  return sign && value !== 0 ? -value : value;
}

const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const floorDay = (ms: number) => Math.floor(ms / DAY) * DAY;
const ceilDay = (ms: number) => Math.ceil(ms / DAY) * DAY;

/**
 * The REGION values of a region-scoped account: its region, then the Local Zone groups its zones name
 * (`us-west-2-lax-1a` → `us-west-2-lax-1`), each once.
 */
export function costRegions(config: Pick<AwsConfig, 'region' | 'zones'>): string[] {
  const localZone = new RegExp(`^${config.region.replace(/-/g, '\\-')}-[a-z]{2,10}-\\d{1,2}[a-z]$`);
  const out = [config.region];
  for (const zone of config.zones)
    if (localZone.test(zone) && !out.includes(zone.slice(0, -1))) out.push(zone.slice(0, -1));
  return out;
}

/** `Credit`, `Recurring reservation fee`, `SavingsPlanNegation` → `credit`, `recurring-reservation-fee`, … */
function costTypeOf(recordType: string): string {
  return (
    recordType
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'other'
  );
}

type Expression = Record<string, unknown>;
const dimension = (key: string, values: readonly string[]): Expression => ({
  Dimensions: { Key: key, Values: [...values] },
});
const and = (parts: Expression[]): Expression => (parts.length === 1 ? parts[0]! : { And: parts });

interface CeGroup {
  Keys?: string[];
  Metrics?: Record<string, { Amount?: string; Unit?: string }>;
}
interface CeResponse {
  ResultsByTime?: { TimePeriod?: { Start?: string; End?: string }; Groups?: CeGroup[] }[];
  NextPageToken?: string;
}

export interface CostExplorerOptions {
  /** How long a day read stays cached (default 24 h). */
  cacheMs?: number;
  /** Pages per query before the read is refused as runaway (default 200). */
  maxPages?: number;
}

/** Cost Explorer errors as vps's worker should treat them: throttling backs off a minute, an unready bill retries. */
function mapCostError(error: unknown): unknown {
  if (!isComputeError(error)) return error;
  const code = (error.details as { code?: string } | undefined)?.code;
  if (code === 'LimitExceededException' || error.code === 'RATE_LIMITED')
    return new ComputeError('RATE_LIMITED', error.message, undefined, {
      ...error.details,
      retryAfterMs: Math.max(60_000, error.retryAfterMs ?? 0),
    });
  if (
    code === 'DataUnavailableException' ||
    code === 'BillExpirationException' ||
    code === 'RequestChangedException'
  )
    return new ComputeError('UNAVAILABLE', error.message, undefined, {
      ...error.details,
      retryAfterMs: 15 * 60_000,
    });
  return error;
}

/**
 * The account's `costs` reader. Undefined when the account's `costs` is `off`: vps then never reads costs for it.
 */
export function costExplorerCosts(
  deps: { ce: JsonClient; account: AccountCredentials; config: AwsConfig; clock: Clock },
  options: CostExplorerOptions = {},
):
  | ((
      window: { from: number; to: number },
      context: CallContext,
    ) => AsyncIterable<ProviderCostRecord>)
  | undefined {
  const scope = deps.config.costs;
  if (scope === undefined || scope === 'off') return undefined;
  const cacheMs = options.cacheMs ?? DAY;
  const maxPages = options.maxPages ?? 200;
  const region = deps.config.region;
  const regions = costRegions(deps.config);
  /** Day start → the day's records and when they were read. */
  const days = new Map<number, { readAt: number; records: ProviderCostRecord[] }>();

  async function query(
    accountId: string,
    period: { start: number; end: number },
    groupBy: { Type: 'TAG' | 'DIMENSION'; Key: string }[],
    filter: Expression[],
    signal: AbortSignal,
  ): Promise<{ day: number; keys: string[]; group: CeGroup }[]> {
    const out: { day: number; keys: string[]; group: CeGroup }[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= maxPages)
        throw new ComputeError(
          'PROVIDER_ERROR',
          'Cost Explorer pagination did not end',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-limit',
          },
        );
      const base = [dimension('LINKED_ACCOUNT', [accountId])];
      if (scope === 'region') base.push(dimension('REGION', regions));
      let response: CeResponse;
      try {
        response = await deps.ce.call<CeResponse>(
          'GetCostAndUsage',
          {
            TimePeriod: { Start: dayText(period.start), End: dayText(period.end) },
            Granularity: 'DAILY',
            Metrics: ['UnblendedCost', 'UsageQuantity'],
            GroupBy: groupBy,
            Filter: and([...base, ...filter]),
            ...(token ? { NextPageToken: token } : {}),
          },
          { signal },
        );
      } catch (error) {
        throw mapCostError(error);
      }
      for (const result of response.ResultsByTime ?? []) {
        const start = Date.parse(`${result.TimePeriod?.Start ?? ''}T00:00:00Z`);
        if (!Number.isFinite(start)) continue;
        for (const group of result.Groups ?? [])
          out.push({ day: start, keys: group.Keys ?? [], group });
      }
      const next = response.NextPageToken || undefined;
      if (!next) return out;
      if (seen.has(next))
        throw new ComputeError(
          'PROVIDER_ERROR',
          'Cost Explorer returned a page token twice',
          undefined,
          {
            provider: 'aws',
            reason: 'pagination-loop',
          },
        );
      seen.add(next);
      token = next;
    }
  }

  function record(
    accountId: string,
    readAt: number,
    kind: 'instance' | 'tenant' | 'other',
    day: number,
    keys: string[],
    group: CeGroup,
  ): ProviderCostRecord | undefined {
    const cost = group.Metrics?.UnblendedCost;
    const usage = group.Metrics?.UsageQuantity;
    const amount = costMicros(cost?.Amount ?? '');
    const quantity = Number(usage?.Amount ?? '0');
    const labels: Record<string, string> = {};
    let service: string;
    let sku: string;
    let costType: string | undefined;
    let rowRegion: string | undefined;
    if (kind === 'other') {
      sku = keys[0] ?? '';
      service = keys[1] ?? '';
      costType = costTypeOf(sku);
      rowRegion = scope === 'region' ? region : undefined;
    } else {
      const tag = kind === 'instance' ? tags.instance : tags.tenant;
      const prefix = `${tag}$`;
      const tagValue = keys[0]?.startsWith(prefix) ? keys[0].slice(prefix.length) : '';
      // Rows without the instance tag are read by the tenant query; dropping them here counts them once.
      if (kind === 'instance' && tagValue === '') return undefined;
      if (tagValue !== '') labels[labelOf[tag]!] = tagValue;
      sku = keys[1] ?? '';
      service = usageTypeService(sku);
      rowRegion = scope === 'region' ? region : usageTypeRegion(sku);
    }
    if (amount === 0 && !(quantity > 0)) return undefined;
    // The row's identity: what was grouped, never the amounts or the read time.
    const identity = [
      'aws-ce',
      accountId,
      scope === 'region' ? region : '*',
      dayText(day),
      kind,
      ...keys,
    ];
    return {
      sourceRowId: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      service,
      sku,
      ...(rowRegion ? { region: rowRegion } : {}),
      project: accountId,
      usageStart: day,
      usageEnd: day + DAY,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
      unit: kind === 'other' || !usage?.Unit || usage.Unit === 'N/A' ? '' : usage.Unit,
      costMicros: Math.max(0, amount),
      // Credits, refunds and discounts are negative amounts; never a positive credit.
      creditsMicros: Math.min(0, amount) || 0,
      currency: cost?.Unit ?? '',
      labels: Object.freeze(labels),
      exportTime: readAt,
      ...(costType ? { costType } : {}),
    };
  }

  async function read(
    accountId: string,
    period: { start: number; end: number },
    signal: AbortSignal,
  ): Promise<void> {
    const regular = dimension('RECORD_TYPE', regularRecordTypes);
    const usageType = { Type: 'DIMENSION' as const, Key: 'USAGE_TYPE' };
    const [byInstance, byTenant, other] = [
      await query(
        accountId,
        period,
        [{ Type: 'TAG', Key: tags.instance }, usageType],
        [regular],
        signal,
      ),
      await query(
        accountId,
        period,
        [{ Type: 'TAG', Key: tags.tenant }, usageType],
        [regular, { Tags: { Key: tags.instance, MatchOptions: ['ABSENT'] } }],
        signal,
      ),
      await query(
        accountId,
        period,
        [
          { Type: 'DIMENSION', Key: 'RECORD_TYPE' },
          { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
        [{ Not: regular }],
        signal,
      ),
    ];
    const readAt = deps.clock.now();
    const fresh = new Map<number, ProviderCostRecord[]>();
    for (let day = period.start; day < period.end; day += DAY) fresh.set(day, []);
    for (const [kind, rows] of [
      ['instance', byInstance],
      ['tenant', byTenant],
      ['other', other],
    ] as const)
      for (const row of rows) {
        const made = record(accountId, readAt, kind, row.day, row.keys, row.group);
        if (made) fresh.get(row.day)?.push(made);
      }
    for (const [day, records] of fresh) days.set(day, { readAt, records });
    for (const day of days.keys()) if (day < period.start - 40 * DAY) days.delete(day);
  }

  return async function* costs(window, context) {
    const now = deps.clock.now();
    const start = ceilDay(window.from);
    // The current UTC day is incomplete in Cost Explorer: never read.
    const end = Math.min(ceilDay(window.to), floorDay(now));
    if (end <= start) return;
    const stale = (day: number) => {
      const cached = days.get(day);
      return !cached || now - cached.readAt >= cacheMs;
    };
    let first: number | undefined;
    for (let day = start; day < end; day += DAY)
      if (stale(day)) {
        first = day;
        break;
      }
    if (first !== undefined) {
      const { account: accountId } = await deps.account.verify({
        signal: context.signal,
        clock: context.clock,
      });
      if (!/^\d{12}$/.test(accountId))
        throw new ComputeError('PROVIDER_ERROR', 'STS returned no AWS account id', undefined, {
          provider: 'aws',
          reason: 'caller-account',
        });
      await read(accountId, { start: first, end }, context.signal);
    }
    for (let day = start; day < end; day += DAY) yield* days.get(day)?.records ?? [];
  };
}
