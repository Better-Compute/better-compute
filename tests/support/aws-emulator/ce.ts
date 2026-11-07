import type { AwsEmulator, EmulatorRequest } from './index.js';
import { jsonError } from './xml.js';

/** One line of the emulated bill: a day of one usage type of one resource. */
export interface CeLine {
  /** `YYYY-MM-DD`. */
  day: string;
  account: string;
  region: string;
  service: string;
  usageType: string;
  /** `Usage`, `Credit`, `Tax`, `SavingsPlanCoveredUsage`, … */
  recordType?: string;
  tags?: Readonly<Record<string, string>>;
  /** Decimal text in `currency`. */
  cost: string;
  quantity?: string;
  unit?: string;
  currency?: string;
}

type Expression = {
  And?: Expression[];
  Or?: Expression[];
  Not?: Expression;
  Dimensions?: { Key: string; Values?: string[]; MatchOptions?: string[] };
  Tags?: { Key: string; Values?: string[]; MatchOptions?: string[] };
};

const dimensionOf = (line: CeLine, key: string): string | undefined => {
  switch (key) {
    case 'LINKED_ACCOUNT':
      return line.account;
    case 'REGION':
      return line.region;
    case 'SERVICE':
      return line.service;
    case 'USAGE_TYPE':
      return line.usageType;
    case 'RECORD_TYPE':
      return line.recordType ?? 'Usage';
    default:
      return undefined;
  }
};

export interface CostAllocationTag {
  TagKey: string;
  Type: 'UserDefined' | 'AWSGenerated';
  Status: 'Active' | 'Inactive';
}

/**
 * Cost Explorer (`AWSInsightsIndexService`, JSON 1.1): GetCostAndUsage over `lines` (DAILY,
 * UnblendedCost and UsageQuantity, GroupBy up to two keys, And/Or/Not filters on dimensions and
 * tags), paged by `pageSize` groups; ListCostAllocationTags and UpdateCostAllocationTagsStatus.
 */
export class CeEmulator {
  readonly lines: CeLine[] = [];
  readonly tags: CostAllocationTag[] = [];
  /** The account's billing currency: lines without their own `currency`, and days without usage. */
  currency = 'USD';
  /** Groups per page (AWS pages by its own size; tests make it small). */
  pageSize = 1000;
  /** Every GetCostAndUsage request body. */
  readonly queries: Record<string, unknown>[] = [];

  constructor(private readonly emu: AwsEmulator) {
    emu.register(/^ce\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'ce',
      protocol: 'json',
      handle: (request) => this.#handle(request),
    });
  }

  #handle(request: EmulatorRequest): Response {
    if (request.headers.get('content-type') !== 'application/x-amz-json-1.1')
      return jsonError('SerializationException', 'wrong content type');
    if (!request.headers.get('x-amz-target')?.startsWith('AWSInsightsIndexService.'))
      return jsonError('UnknownOperationException', 'wrong target prefix');
    const body = JSON.parse(request.body || '{}') as Record<string, unknown>;
    switch (request.operation) {
      case 'GetCostAndUsage':
        return this.#costAndUsage(body);
      case 'ListCostAllocationTags': {
        const keys = body.TagKeys as string[] | undefined;
        const status = body.Status as string | undefined;
        return json({
          CostAllocationTags: this.tags.filter(
            (tag) =>
              (keys === undefined || keys.includes(tag.TagKey)) &&
              (status === undefined || tag.Status === status),
          ),
        });
      }
      case 'UpdateCostAllocationTagsStatus': {
        const errors: unknown[] = [];
        for (const entry of (body.CostAllocationTagsStatus ?? []) as {
          TagKey: string;
          Status: 'Active' | 'Inactive';
        }[]) {
          const tag = this.tags.find((candidate) => candidate.TagKey === entry.TagKey);
          if (!tag) errors.push({ TagKey: entry.TagKey, Code: 'TagKeysNotFoundException' });
          else tag.Status = entry.Status;
        }
        return json({ Errors: errors });
      }
      default:
        return jsonError('UnknownOperationException', `no operation ${request.operation}`);
    }
  }

  #matches(line: CeLine, expression: Expression | undefined): boolean {
    if (!expression) return true;
    if (expression.And) return expression.And.every((part) => this.#matches(line, part));
    if (expression.Or) return expression.Or.some((part) => this.#matches(line, part));
    if (expression.Not) return !this.#matches(line, expression.Not);
    if (expression.Dimensions) {
      const value = dimensionOf(line, expression.Dimensions.Key);
      return value !== undefined && (expression.Dimensions.Values ?? []).includes(value);
    }
    if (expression.Tags) {
      const value = line.tags?.[expression.Tags.Key];
      if (expression.Tags.MatchOptions?.includes('ABSENT')) return value === undefined;
      return value !== undefined && (expression.Tags.Values ?? []).includes(value);
    }
    throw new Error('empty expression');
  }

  #costAndUsage(body: Record<string, unknown>): Response {
    this.queries.push(body);
    const period = body.TimePeriod as { Start?: string; End?: string } | undefined;
    if (!period?.Start || !period.End || !/^\d{4}-\d{2}-\d{2}$/.test(period.Start))
      return jsonError('ValidationException', 'TimePeriod is required');
    if (body.Granularity !== 'DAILY')
      return jsonError('ValidationException', 'only DAILY is emulated');
    const groupBy = (body.GroupBy ?? []) as { Type: string; Key: string }[];
    if (groupBy.length > 2) return jsonError('ValidationException', 'at most two GroupBy keys');
    const filter = body.Filter as Expression | undefined;
    for (const expression of [filter, ...(filter?.And ?? [])])
      if (expression?.And && expression.And.length < 2)
        return jsonError('ValidationException', 'And takes at least two expressions');
    const metrics = (body.Metrics ?? []) as string[];
    const days: string[] = [];
    for (
      let at = Date.parse(`${period.Start}T00:00:00Z`);
      at < Date.parse(`${period.End}T00:00:00Z`);
      at += 86_400_000
    )
      days.push(new Date(at).toISOString().slice(0, 10));
    // Every (day, group) in order; pages cut across days.
    const all: { day: string; keys: string[]; cost: number; quantity: number; line: CeLine }[] = [];
    for (const day of days) {
      const groups = new Map<string, (typeof all)[number]>();
      for (const line of this.lines) {
        if (line.day !== day || !this.#matches(line, filter)) continue;
        const keys = groupBy.map((group) =>
          group.Type === 'TAG'
            ? `${group.Key}$${line.tags?.[group.Key] ?? ''}`
            : (dimensionOf(line, group.Key) ?? ''),
        );
        const id = keys.join('\u0000');
        const seen = groups.get(id) ?? { day, keys, cost: 0, quantity: 0, line };
        seen.cost += Number(line.cost);
        seen.quantity += Number(line.quantity ?? '0');
        groups.set(id, seen);
      }
      // Without GroupBy, AWS answers every day of the period, a day without usage as a zero Total.
      if (groupBy.length === 0 && groups.size === 0)
        groups.set('', {
          day,
          keys: [],
          cost: 0,
          quantity: 0,
          line: { day, account: '', region: '', service: '', usageType: '', cost: '0' },
        });
      all.push(...groups.values());
    }
    const metricsOf = (group: (typeof all)[number]) =>
      Object.fromEntries(
        metrics.map((metric) => [
          metric,
          metric === 'UsageQuantity'
            ? { Amount: group.quantity.toFixed(10), Unit: group.line.unit ?? 'N/A' }
            : { Amount: group.cost.toFixed(10), Unit: group.line.currency ?? this.currency },
        ]),
      );
    const start = Number(body.NextPageToken ?? '0');
    const page = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
    const results = days
      .filter((day) => page.some((group) => group.day === day))
      .map((day) => ({
        TimePeriod: {
          Start: day,
          End: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
        },
        Estimated: true,
        // Without GroupBy, AWS answers the day's Total and no groups.
        ...(groupBy.length === 0
          ? {
              Total: metricsOf(page.find((group) => group.day === day)!),
              Groups: [],
            }
          : {
              Total: {},
              Groups: page
                .filter((group) => group.day === day)
                .map((group) => ({ Keys: group.keys, Metrics: metricsOf(group) })),
            }),
      }));
    return json({
      ResultsByTime: results,
      GroupDefinitions: groupBy,
      ...(next ? { NextPageToken: next } : {}),
    });
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/x-amz-json-1.1' },
  });
}
