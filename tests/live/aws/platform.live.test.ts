import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeEvent } from '@better-compute/core';
import { awsSecretsManagerStore, eventBridgeSink, s3BlobStore, sqsSink } from '@better-compute/aws';
import { liveGate, livePreflight, newTestRunId } from './support/live.js';
import { liveAws, type LiveAws } from './support/resources.js';

// AWS live (A12): the platform-service adapters against real S3, Secrets Manager, EventBridge and
// SQS. Every fixture carries the run's tags and is deleted in afterAll; scripts/aws-live-sweep.mjs
// deletes what a crashed run left. It runs only behind the live gate and preflight
// (tests/live/aws/README.md). Cost: a few requests and a few MiB of S3 for minutes, well under a cent.
//
// Values (secret strings, presigned URLs) are never printed: assertions compare them without
// echoing them on failure.

const gate = liveGate();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readAll(stream: ReadableStream<Uint8Array> | undefined): Promise<Buffer | undefined> {
  if (!stream) return undefined;
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** Retries `step` while it throws, for AWS's eventual consistency on fresh resources. */
async function eventually<T>(what: string, step: () => Promise<T>, timeoutMs = 60_000, intervalMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await step();
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`${what}: still failing after ${timeoutMs / 1000}s (${error instanceof Error ? error.message : String(error)})`);
      await sleep(intervalMs);
    }
  }
}

describe.skipIf(!gate.enabled)('AWS live: platform services', () => {
  const config = gate.enabled ? gate.config : (undefined as never);
  const runId = newTestRunId();
  // Bucket, queue, bus and secret-name safe: lower case, digits and hyphens, under 63 characters.
  const name = `bc-live-${runId}`;
  let aws: LiveAws | undefined;

  const event = (type: string): ComputeEvent => ({
    id: `evt_${runId}_${randomBytes(4).toString('hex')}`,
    type,
    tenantId: 't_live',
    subject: `instance/${runId}`,
    time: new Date().toISOString(),
    sequence: '1',
    data: { run: runId },
  });

  beforeAll(async () => {
    await livePreflight(config);
    aws = liveAws(config, runId);
  });

  afterAll(async () => {
    if (!aws) return;
    const report = await aws.cleanUp();
    // Pending deletes stay tagged; the scheduled sweep retries them.
    expect(report.pending, 'resources left for the sweeper').toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it('S3 blob store: single and multipart put, get, presigned GET, delete', async () => {
    await aws!.createBucket(name);
    const store = s3BlobStore({
      region: config.region,
      credentials: config.credentials,
      bucket: name,
      prefix: 'live',
      sse: { kind: 'AES256' },
      // 6 MiB over a 5 MiB single-put limit: two parts.
      singlePutBytes: 5 * 1024 * 1024,
      partBytes: 5 * 1024 * 1024,
    });
    const small = randomBytes(1024);
    // A new bucket's virtual-hosted name can take a moment to resolve outside us-east-1.
    await eventually('first PUT to the new bucket', () => store.put('small.bin', small, { contentType: 'application/octet-stream' }));
    expect((await readAll(await store.get('small.bin')))?.equals(small)).toBe(true);

    const large = randomBytes(6 * 1024 * 1024);
    await store.put('large.bin', large);
    expect((await readAll(await store.get('large.bin')))?.equals(large)).toBe(true);

    const url = await store.presign!('small.bin', { method: 'GET', expiresInSeconds: 60 });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(small)).toBe(true);

    await store.delete('small.bin');
    await store.delete('large.bin');
    expect(await store.get('small.bin')).toBeUndefined();
  });

  it('Secrets Manager store: put, resolve, tenant check, rotate, delete', async () => {
    const store = awsSecretsManagerStore({
      region: config.region,
      credentials: config.credentials,
      prefix: name,
      recoveryWindowDays: 0,
    });
    const first = randomBytes(16).toString('hex');
    const ref = await store.put('t_live', first);
    const id = ref.split('/').at(-1)!;
    await aws!.tagSecret(`${name}/t_live/${id}`);

    expect((await store.resolve(ref)) === first).toBe(true);
    await expect(store.resolve(ref, { tenantId: 't_other' })).rejects.toSatisfy((error: unknown) => isComputeError(error, 'ACCESS_DENIED'));

    const second = randomBytes(16).toString('hex');
    expect(await store.put('t_live', second, { ref })).toBe(ref);
    expect((await store.resolve(ref)) === second).toBe(true);

    await store.delete(ref);
    await eventually('the deleted secret to be gone', async () => {
      const gone = await store.resolve(ref).then(
        () => false,
        (error: unknown) => isComputeError(error, 'NOT_FOUND'),
      );
      if (!gone) throw new Error('still resolvable');
    });
  });

  it('EventBridge sink delivers through a real rule to an SQS target', async () => {
    const source = 'better-compute.live';
    const queue = await aws!.createQueue(`${name}-bus`);
    await aws!.createBus(name);
    const rule = await aws!.createRule(name, `${name}-to-sqs`, { source: [source], 'detail-type': ['instance.created'] }, queue.arn);
    await aws!.allowEventBridge(queue, rule);
    const sink = eventBridgeSink({ region: config.region, credentials: config.credentials, eventBusName: name, source });
    const sent = event('instance.created');

    // A new rule and target take a moment to start matching: re-deliver (ids dedupe) until one arrives.
    const deadline = Date.now() + 3 * 60_000;
    let received: { 'detail-type'?: string; source?: string; detail?: { id?: string; data?: unknown } } | undefined;
    while (!received && Date.now() < deadline) {
      await sink.deliver([sent]);
      try {
        const message = await aws!.receive(
          queue,
          (m) => (JSON.parse(m.body) as { detail?: { id?: string } }).detail?.id === sent.id,
          20_000,
        );
        received = JSON.parse(message.body) as typeof received;
      } catch (error) {
        if (!isComputeError(error, 'UNAVAILABLE')) throw error;
      }
    }
    expect(received, 'an EventBridge delivery on the queue').toBeDefined();
    expect(received!['detail-type']).toBe('instance.created');
    expect(received!.source).toBe(source);
    expect(received!.detail).toMatchObject({ id: sent.id, tenantId: 't_live', data: { run: runId } });
  });

  it('SQS sink delivers with its message attributes', async () => {
    const queue = await aws!.createQueue(`${name}-direct`);
    const sink = sqsSink({ region: config.region, credentials: config.credentials, queueUrl: queue.url });
    const sent = event('instance.deleted');
    await eventually('the first send to the new queue', () => sink.deliver([sent]));
    const message = await aws!.receive(queue, (m) => (JSON.parse(m.body) as { id?: string }).id === sent.id, 60_000);
    expect(message.attributes).toEqual({ type: 'instance.deleted', tenantId: 't_live', eventId: sent.id });
  });
});
