// Fakes for the AWS live-suite guards and sweeper (STS identity, Cost Explorer month-to-date), on
// the platform emulator. The live suite itself never uses them: they pin the guards' behavior in
// the default suite so the guards are known to fail closed before anyone points them at AWS.
import { AwsEmulator, EmuError, escapeXml, jsonResponse, xmlResponse, type EmuRequest } from './aws-platform-emulator/index.js';

const form = (request: EmuRequest) => new URLSearchParams(Buffer.from(request.body).toString('utf8'));
const json = (request: EmuRequest) => JSON.parse(Buffer.from(request.body).toString('utf8') || '{}') as Record<string, unknown>;

/** STS GetCallerIdentity answering as `state.account`. */
export function stsFake(emu: AwsEmulator, state: { account: string; arn?: string }) {
  emu.register('sts', {
    protocol: 'query',
    handle(request) {
      const action = form(request).get('Action');
      if (action !== 'GetCallerIdentity') throw new EmuError('InvalidAction', `no ${action}`);
      const arn = state.arn ?? `arn:aws:iam::${state.account}:user/live`;
      return xmlResponse(
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${escapeXml(arn)}</Arn><UserId>AIDATEST</UserId><Account>${state.account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>req</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
      );
    },
  });
}

/** Cost Explorer GetCostAndUsage: one result per entry of `state.results`, one per page. */
export function costExplorerFake(emu: AwsEmulator, state: { results: { amount: string; unit?: string }[] }) {
  const requests: Record<string, unknown>[] = [];
  emu.register('ce', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'GetCostAndUsage') throw new EmuError('UnknownOperationException', request.operation);
      const body = json(request);
      requests.push(body);
      const page = typeof body.NextPageToken === 'string' ? Number(body.NextPageToken) : 0;
      const result = state.results[page];
      const period = body.TimePeriod as { Start: string; End: string };
      return jsonResponse({
        ResultsByTime: result
          ? [{ TimePeriod: period, Total: { UnblendedCost: { Amount: result.amount, Unit: result.unit ?? 'USD' } }, Groups: [], Estimated: true }]
          : [],
        ...(page + 1 < state.results.length ? { NextPageToken: String(page + 1) } : {}),
      });
    },
  });
  return { requests };
}

/** Resource Groups Tagging API GetResources over `state.resources`, `pageSize` per page. */
export function taggingFake(emu: AwsEmulator, state: { resources: { arn: string; tags: Record<string, string> }[]; pageSize?: number }) {
  const requests: Record<string, unknown>[] = [];
  emu.register('tagging', {
    protocol: 'json',
    handle(request) {
      if (request.operation !== 'GetResources') throw new EmuError('UnknownOperationException', request.operation);
      const body = json(request);
      requests.push(body);
      const filters = (body.TagFilters ?? []) as { Key: string }[];
      const matching = state.resources.filter((resource) => filters.every((filter) => filter.Key in resource.tags));
      const size = state.pageSize ?? 100;
      const start = typeof body.PaginationToken === 'string' && body.PaginationToken !== '' ? Number(body.PaginationToken) : 0;
      const page = matching.slice(start, start + size);
      return jsonResponse({
        ResourceTagMappingList: page.map((resource) => ({
          ResourceARN: resource.arn,
          Tags: Object.entries(resource.tags).map(([Key, Value]) => ({ Key, Value })),
        })),
        PaginationToken: start + size < matching.length ? String(start + size) : '',
      });
    },
  });
  return { requests };
}

export interface RecordedCall {
  service: string;
  operation: string;
  params: Record<string, unknown>;
}

/**
 * A service that records every call (in one shared log, to check ordering) and answers success:
 * query services `<Op>Response`, json services `{}`; `answers` overrides one operation's body.
 */
export function recorderFake(
  emu: AwsEmulator,
  service: string,
  protocol: 'json' | 'query',
  log: RecordedCall[],
  answers: Record<string, (params: Record<string, unknown>) => string | Record<string, unknown>> = {},
) {
  emu.register(service, {
    protocol,
    handle(request) {
      const params: Record<string, unknown> = protocol === 'json' ? json(request) : Object.fromEntries(form(request));
      log.push({ service, operation: request.operation, params });
      const answer = answers[request.operation]?.(params);
      if (protocol === 'json') return jsonResponse(answer ?? {});
      return xmlResponse(
        typeof answer === 'string' ? answer : `<${request.operation}Response><return>true</return><requestId>req</requestId></${request.operation}Response>`,
      );
    },
  });
}
