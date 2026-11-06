// Fakes for the AWS live-suite guards and sweeper (STS identity, Cost Explorer month-to-date), on
// the platform emulator. The live suite itself never uses them: they pin the guards' behavior in
// the default suite so the guards are known to fail closed before anyone points them at AWS.
import { createHash } from 'node:crypto';
import { parseXml } from '@better-compute/aws-core';
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

export interface FakeBucket {
  owner: string;
  /** Object versions and delete markers, in listing order. */
  versions: { key: string; versionId: string; marker?: boolean }[];
}

/**
 * S3 bucket teardown for the sweeper: ListObjectVersions (`pageSize` per page), DeleteObjects
 * (checks Content-MD5) and DeleteBucket (BucketNotEmpty while versions remain). Every request must
 * name the bucket's owner in x-amz-expected-bucket-owner, as S3 enforces it (403 otherwise).
 * `failKeys` makes DeleteObjects report those keys as per-object errors.
 */
export function s3SweepFake(emu: AwsEmulator, state: { buckets: Map<string, FakeBucket>; pageSize?: number; failKeys?: Set<string> }) {
  const requests: { operation: string; bucket: string; headers: Record<string, string>; query: Record<string, string>; body: string }[] = [];
  const bucketOf = (request: Omit<EmuRequest, 'operation'>) => decodeURIComponent(request.url.pathname.split('/')[1] ?? '');
  emu.register('s3', {
    protocol: 'rest-xml',
    operation(request) {
      const q = request.url.searchParams;
      if (request.method === 'GET' && q.has('versions')) return 'ListObjectVersions';
      if (request.method === 'POST' && q.has('delete')) return 'DeleteObjects';
      if (request.method === 'DELETE' && request.url.pathname.split('/').filter(Boolean).length === 1) return 'DeleteBucket';
      return `${request.method}?`;
    },
    handle(request) {
      const name = bucketOf(request);
      const body = Buffer.from(request.body).toString('utf8');
      requests.push({ operation: request.operation, bucket: name, headers: request.headers, query: Object.fromEntries(request.url.searchParams), body });
      const bucket = state.buckets.get(name);
      if (!bucket) throw new EmuError('NoSuchBucket', 'The specified bucket does not exist', 404);
      if (request.headers['x-amz-expected-bucket-owner'] !== bucket.owner) throw new EmuError('AccessDenied', 'Access Denied', 403);
      switch (request.operation) {
        case 'ListObjectVersions': {
          const size = state.pageSize ?? 1000;
          const keyMarker = request.url.searchParams.get('key-marker');
          const versionMarker = request.url.searchParams.get('version-id-marker');
          let start = 0;
          if (keyMarker !== null) {
            const at = bucket.versions.findIndex((entry) => entry.key === keyMarker && entry.versionId === versionMarker);
            start = at + 1;
          }
          const page = bucket.versions.slice(start, start + size);
          const truncated = start + size < bucket.versions.length;
          const last = page.at(-1);
          const entries = page
            .map((entry) =>
              entry.marker
                ? `<DeleteMarker><Key>${escapeXml(entry.key)}</Key><VersionId>${entry.versionId}</VersionId><IsLatest>true</IsLatest></DeleteMarker>`
                : `<Version><Key>${escapeXml(entry.key)}</Key><VersionId>${entry.versionId}</VersionId><IsLatest>false</IsLatest><Size>1</Size></Version>`,
            )
            .join('');
          return xmlResponse(
            `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(name)}</Name><IsTruncated>${truncated}</IsTruncated>${
              truncated && last ? `<NextKeyMarker>${escapeXml(last.key)}</NextKeyMarker><NextVersionIdMarker>${last.versionId}</NextVersionIdMarker>` : ''
            }${entries}</ListVersionsResult>`,
          );
        }
        case 'DeleteObjects': {
          const md5 = createHash('md5').update(request.body).digest('base64');
          if (request.headers['content-md5'] !== md5) throw new EmuError('InvalidDigest', 'The Content-MD5 you specified was invalid');
          const doc = parseXml(body);
          const errors: string[] = [];
          for (const object of doc.all('Object')) {
            const key = object.textOf('Key') ?? '';
            const versionId = object.textOf('VersionId') ?? '';
            if (state.failKeys?.has(key)) {
              errors.push(`<Error><Key>${escapeXml(key)}</Key><VersionId>${versionId}</VersionId><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`);
              continue;
            }
            bucket.versions = bucket.versions.filter((entry) => !(entry.key === key && entry.versionId === versionId));
          }
          return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${errors.join('')}</DeleteResult>`);
        }
        case 'DeleteBucket':
          if (bucket.versions.length > 0) throw new EmuError('BucketNotEmpty', 'The bucket you tried to delete is not empty', 409);
          state.buckets.delete(name);
          return new Response(null, { status: 204 });
        default:
          throw new EmuError('NotImplemented', request.operation, 501);
      }
    },
  });
  return { requests };
}

/** FIS DeleteExperimentTemplate (rest-json DELETE /experimentTemplates/{id}), recorded in `log`. */
export function fisFake(emu: AwsEmulator, log: RecordedCall[]) {
  emu.register('fis', {
    protocol: 'json',
    operation: (request) =>
      request.method === 'DELETE' && /^\/experimentTemplates\/[^/]+$/.test(request.url.pathname) ? 'DeleteExperimentTemplate' : `${request.method}?`,
    handle(request) {
      const id = decodeURIComponent(request.url.pathname.split('/')[2] ?? '');
      log.push({ service: 'fis', operation: request.operation, params: { id } });
      if (request.operation !== 'DeleteExperimentTemplate') throw new EmuError('ValidationException', request.operation);
      return jsonResponse({ experimentTemplate: { id } });
    },
  });
}
