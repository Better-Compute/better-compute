# AWS A8: platform services behind existing seams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host that runs better-compute on or next to AWS can plug in AWS services wherever better-compute already
has a seam:
- Secrets Manager or SSM Parameter Store for secrets, with KMS protecting local-sealed's keys.
- S3 for downloads, support bundles, sandbox snapshots and the audit archive.
- EventBridge, SNS, SQS, Kinesis or Firehose for the event stream.
- ACM Private CA or a KMS key as a certificate authority.
- RDS IAM authentication for the database.
- CloudWatch EMF for metrics.

Each needs no change to `@better-compute/core`.

**Architecture:**
- A new leaf package `@better-compute/aws` depends on `core`, `aws-core` (A0), `pki` (CA tasks) and `vps` (the
  `SnapshotStore` type).
- Each export is a factory that returns an object implementing an existing interface:
  - `SecretStore` (`core/src/extension.ts:518`)
  - `BlobStore` (502)
  - `SnapshotStore` (`vps/src/snapshots.ts:30`)
  - `EventSink` and `AuditSink` (445-456)
  - `CertificateAuthority` (549)
- Two small **additive** edits outside the package, each coordinated with its owner:
  - `SnapshotStore.downloadUrl?` in vps, because a stored presigned GET expires.
  - An async-signer variant of `buildCertificate` in pki, because KMS signs remotely.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), `aws-core` clients (`jsonClient` for KMS, Secrets Manager, SSM,
EventBridge, SQS, Kinesis and Firehose; `queryClient` for SNS; `restClient({ s3: true })` for S3; `jsonClient` for
ACM PCA), `node:zlib` (`gzipSync`), vitest. No new npm dependencies.

**Spec:** [`2026-10-18-aws-integration-program.md`](2026-10-18-aws-integration-program.md): R8, AD15 and the A8
section. This plan needs A0 (`aws-core`) merged. It does **not** need A1, so it runs in parallel with the EC2
provider (lane L2).

---

## Global Constraints

- Everything in the A0/A1 plan's Global Constraints applies, including no new npm deps, secret redaction, the
  determinism rule for idempotent calls, the commit rule and injected clocks.
- **Dependency rules:**
  - `@better-compute/aws` may depend on `core`, `aws-core`, `pki` and `vps`.
  - Nothing in `packages/` may depend on `@better-compute/aws` (check-deps rule 5, added in A0 Task 1).
  - Not in the umbrella.
- **Seams are used as declared.** No new members on `core` interfaces. The only edits outside the package are the
  vps `SnapshotStore.downloadUrl?` and the pki `buildCertificateWithSigner` export. Each needs the owning session's
  OK in `.claude/coordination.md` first.
- **Sinks are at-least-once.** A partial batch failure must **throw**, never return. The dispatcher's
  bisect/retry/dead-letter logic (`server/src/runtime/events.ts:328`) is the only retry policy. Consumers dedupe by
  event id; every sink puts the id where the AWS service can use it (FIFO dedupe ids) or where consumers can read it.
- **Tenancy:** secret refs embed the tenant id. `resolve(ref, { tenantId })` refuses refs of another tenant with
  `ACCESS_DENIED` before any AWS call. Ref paths are validated (`^[A-Za-z0-9_-]+$` segments), so `..` and `/`
  injection are impossible.
- **Never log** secret values, KMS plaintext data keys, presigned URLs or RDS auth tokens. Plaintext key buffers are
  `fill(0)`'d after use (best effort).

## Review Focus

1. **A partial batch failure in an event sink.** EventBridge `FailedEntryCount > 0`, a Kinesis `FailedRecordCount`,
   an SNS/SQS `Failed[]`. The sink throws, the dispatcher retries, and no event is dropped. *Test: Task 7, `throws
   on a partially failed batch so the dispatcher retries`, and Task 8, the same for Kinesis and Firehose.*
2. **An event larger than the service limit** (EventBridge 256 KiB). It is isolated into a single-event batch that
   fails with `PAYLOAD_TOO_LARGE`, so the dispatcher dead-letters it instead of retrying forever. *Test: Task 7,
   `an oversized event fails alone with PAYLOAD_TOO_LARGE`.*
3. **Cross-tenant secret resolution or path injection.** `resolve('secret://aws-sm/t2/x', { tenantId: 't1' })`, or
   `secret://aws-sm/t1/../t2/x`, is refused before any AWS call. *Test: Task 1, `refuses another tenant's ref
   without calling AWS` and `refuses path injection`.*
4. **Restoring a sandbox snapshot after its presigned URL has expired.** The restore gets a freshly minted URL.
   *Test: Task 5, `restore after 8 days gets a fresh download URL`.*
5. **An interrupted S3 multipart upload.** No orphaned parts: `AbortMultipartUpload` runs on any failure. *Test:
   Task 4, `aborts the multipart upload when a part fails`.*

---

## File structure

**New package `packages/aws/`.** Same skeleton as `provider-aws`; `package.json` name `@better-compute/aws`, version
`0.1.0`.

| File | Responsibility |
|---|---|
| `src/index.ts` | Re-exports. |
| `src/common.ts` | `AwsServiceOptions` (shared factory options), `chunkBy(items, { maxCount, maxBytes, size })`. |
| `src/secrets-manager.ts` | `awsSecretsManagerStore`. |
| `src/parameter-store.ts` | `awsParameterStore`. |
| `src/route-secrets.ts` | `routeSecretStores`: one `secret`-scheme store that routes by ref prefix. |
| `src/kms-sealing.ts` | `kmsSealingKeys`, `generateKmsSealingKey`. |
| `src/s3.ts` | `s3BlobStore`, the S3 request helpers (virtual-hosted vs. path style, SSE, multipart). |
| `src/s3-snapshots.ts` | `s3SnapshotStore`. |
| `src/s3-audit.ts` | `s3AuditSink`. |
| `src/event-sinks.ts` | `eventBridgeSink`, `snsSink`, `sqsSink`. |
| `src/stream-sinks.ts` | `kinesisSink`, `firehoseSink`, `firehoseAuditSink`. |
| `src/acm-pca.ts` | `acmPcaCertificateAuthority`. |
| `src/kms-ca.ts` | `kmsCertificateAuthority`, `kmsCaCsr`. |
| `src/rds.ts` | `rdsAuthToken`, `rdsAuthTokenProvider`. |
| `src/emf.ts` | `emfMetricsExporter`, `parsePrometheusText`. |
| `src/cli.ts` | `awsKmsSealingKeyCommand`, `awsKmsCaCsrCommand`. |
| `README.md` | Composition examples and required IAM per factory. |

**Modified outside the package (coordinated):**
- `packages/vps/src/snapshots.ts` (+ the restore call site): the optional `downloadUrl?`.
- `packages/pki/src/x509.ts`: an exported `buildCertificateWithSigner`.

**Tests:**

| File | Covers |
|---|---|
| `support/aws-emulator/{kms,secretsmanager,ssm,s3,eventbridge,sns,sqs,kinesis,firehose,acmpca}.ts` | Service fakes on the A0 emulator router. |
| `aws-secrets.test.ts` | Tasks 1–3. |
| `aws-s3.test.ts` | Tasks 4–6. |
| `aws-event-sinks.test.ts` | Tasks 7–8. |
| `aws-certificate-authorities.test.ts` | Tasks 9–10. |
| `aws-rds-emf.test.ts` | Tasks 11–12. |
| `aws-host-composition.test.ts` | Task 13. |

**Shared factory options** (`common.ts`), used by every factory below:
```ts
export interface AwsServiceOptions {
  region: string;
  credentials: CredentialSource;         // from aws-core (ambientCredentials() on ECS/EKS/EC2)
  fetch?: typeof fetch;
  endpoint?: string;                     // tests, VPC endpoints
  clock?: Clock;
  log?: Logger;
}
export function chunkBy<T>(items: readonly T[], limits: { maxCount: number; maxBytes: number; size: (item: T) => number }): T[][];
```

---

### Task 0: Claim and baseline

- [ ] **Step 1:** Create branch `feat/aws-a8` from `main`, which must contain A0. Add a coordination claim for:
  - `packages/aws/**`;
  - `tests/aws-{secrets,s3,event-sinks,certificate-authorities,rds-emf,host-composition}.test.ts`;
  - the emulator files listed above.

  Ask the vps owner about `SnapshotStore.downloadUrl?` and the pki owner about `buildCertificateWithSigner`.
- [ ] **Step 2:** Scaffold `packages/aws/{package.json,tsconfig.json,LICENSE}` and `src/{index,common}.ts`. Add the
  one-line registry inserts (root `tsconfig.json`, `vitest.config.ts` `scoped`
  `'@better-compute/aws': 'aws/src/index.ts'`), then run `pnpm install --offline` (through the orchestrator if
  others are active).
- [ ] **Step 3:** Write `chunkBy` with a test in `tests/aws-event-sinks.test.ts`:
  - `chunkBy respects count and byte limits and keeps order`;
  - `an item over maxBytes is its own chunk`.

  Run it and see it pass.
- [ ] **Step 4:** Run `node scripts/check-deps.mjs`. Expected: exit 0.
- [ ] **Step 5: Commit:** `aws: package scaffold and batching helper`.

### Task 1: Secrets Manager store and prefix routing

**Files:**
- Create: `src/secrets-manager.ts`, `src/route-secrets.ts`, `tests/support/aws-emulator/secretsmanager.ts`
- Test: `tests/aws-secrets.test.ts`

**Interfaces — Produces:**
```ts
export interface AwsSecretsManagerStoreOptions extends AwsServiceOptions {
  /** Secret name prefix (default 'better-compute'); names are `${prefix}/${tenantId}/${id}`. */
  prefix?: string;
  kmsKeyId?: string;
  /** DeleteSecret recovery window (default 7, min 7, max 30); 0 = ForceDeleteWithoutRecovery. */
  recoveryWindowDays?: number;
  /** Cache resolved values for this long (default 0 = no cache). */
  cacheTtlMs?: number;
}
/** id 'aws-secrets-manager', schemes ['secret']; refs look like `secret://aws-sm/<tenantId>/<id>`. */
export function awsSecretsManagerStore(options: AwsSecretsManagerStoreOptions): SecretStore;

/** One `secret`-scheme store over several: refs route by path prefix; `put` goes to `putTo`. */
export function routeSecretStores(options: { routes: readonly { prefix: string; store: SecretStore }[]; fallback: SecretStore; putTo: SecretStore }): SecretStore;
```

**Behavior:**
- **`put(tenantId, value, { ref? })`:** `CreateSecret { Name, SecretString: value, KmsKeyId?, ClientRequestToken: uuidv5(tenantId+':'+ref?) or random UUID, Tags: [{Key:'better-compute:tenant',Value:tenantId}] }`.
  - With `options.ref` (the rotate-in-place form), use `PutSecretValue` on the existing name.
  - Values over 64 KiB fail `PAYLOAD_TOO_LARGE`.
- **`resolve(ref, context?)`:** parse and validate the ref, then check the tenant (`context.tenantId` must equal the
  ref's tenant; mismatch → `ACCESS_DENIED`, no AWS call), then `GetSecretValue { SecretId: name }`. A
  `SecretBinary`-only secret is `INVALID_STATE`.
- **`delete(ref)`:** `DeleteSecret` with the recovery window. `ResourceNotFoundException` counts as success.
- **Routing:** `routeSecretStores` picks the longest matching `prefix` (e.g. `secret://aws-sm/`) and otherwise uses
  `fallback`. Typical use: `routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: sm }], fallback: localSealed, putTo: sm })`.
  This lets existing local-sealed refs keep working while new ones go to Secrets Manager.

- [ ] **Step 1: Write the failing tests:**
  - `put creates a tagged secret and returns a tenant-scoped ref`
  - `resolve returns the value`
  - `refuses another tenant's ref without calling AWS` (assert `emu.requests.length` unchanged)
  - `refuses path injection` (`secret://aws-sm/t1/../t2/x`, `secret://aws-sm/t1/a/b`, `secret://aws-sm//x` → `INVALID_INPUT`)
  - `delete uses the recovery window and tolerates a missing secret`
  - `values over 64 KiB are refused`
  - `routing sends aws-sm refs to Secrets Manager and others to the fallback`
  - `never logs secret values` (recording logger sweep)
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-secrets.test.ts -t "Secrets Manager|routing"`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `aws: Secrets Manager secret store and prefix routing`.

### Task 2: SSM Parameter Store

**Interfaces — Produces:**
```ts
export interface AwsParameterStoreOptions extends AwsServiceOptions { prefix?: string /* '/better-compute' */; kmsKeyId?: string; tier?: 'Standard' | 'Advanced' }
/** id 'aws-parameter-store', schemes ['secret']; refs `secret://aws-ssm/<tenantId>/<id>`; SecureString parameters. */
export function awsParameterStore(options: AwsParameterStoreOptions): SecretStore;
```
**Behavior:**
- `put` calls `PutParameter { Name: `${prefix}/${tenantId}/${id}`, Type: 'SecureString', Overwrite: false, KeyId?, Tier, Tags }`.
  Values are limited to 4 KiB on the Standard tier and 8 KiB on Advanced; over the limit is `PAYLOAD_TOO_LARGE`.
- `resolve` calls `GetParameter WithDecryption=true`; `delete` calls `DeleteParameter`. Tenant and path checks are
  as in Task 1.

- [ ] **Step 1: Write the failing tests:**
  - `stores SecureString parameters under the tenant path`
  - `respects tier size limits`
  - `refuses another tenant's ref without calling AWS`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass:**
  `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-secrets.test.ts -t "Parameter Store"`.
- [ ] **Step 5: Commit:** `aws: SSM Parameter Store secret store`.

### Task 3: KMS-protected sealing keys for local-sealed

**Files:**
- Create: `src/kms-sealing.ts`, `src/cli.ts` (`awsKmsSealingKeyCommand`), `tests/support/aws-emulator/kms.ts`
- Test: `tests/aws-secrets.test.ts` (section `KMS sealing`)

**Interfaces — Produces:**
```ts
/** Decrypts KMS-wrapped data keys into the SealingKeys shape localSealedSecretStore accepts (pki/secrets.ts:78). */
export function kmsSealingKeys(options: AwsServiceOptions & {
  current: string;
  /** key id → base64 CiphertextBlob from GenerateDataKey (AES_256). */
  wrapped: Readonly<Record<string, string>>;
  /** Must match the context used at generation (default { purpose: 'better-compute-sealing' }). */
  encryptionContext?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<SealingKeys>;
/** GenerateDataKey AES_256 under `keyId`; returns ONLY the ciphertext (base64); the plaintext is zeroed. */
export function generateKmsSealingKey(options: AwsServiceOptions & { keyId: string; encryptionContext?: Readonly<Record<string, string>>; signal?: AbortSignal }): Promise<string>;
/** `better-compute aws kms-sealing-key --key-id <arn> [--out file]`: prints the wrapped key, never the plaintext. */
export function awsKmsSealingKeyCommand(): { name: 'aws kms-sealing-key'; group: 'Security'; summary: string; description: string; flags: Record<string, unknown>; run(context: AwsCommandContext): Promise<void> };
```
`AwsCommandContext` has the same shape as in A1 Task 14. Define it in `aws` too; it is a structural type.

**Host use:** `localSealedSecretStore({ sql, keys: await kmsSealingKeys({ region, credentials, current: 'k2', wrapped: { k1: '…', k2: '…' } }) })`.
Rotation needs no new code: it is local-sealed's existing `keys` set.

- [ ] **Step 1: Write the failing tests** (the emulator KMS holds a real AES key per key id and implements
  `GenerateDataKey`/`Decrypt` with the encryption context checked):
  - `round-trips a wrapped key into SealingKeys` (the result feeds `localSealedSecretStore`, and put/resolve work)
  - `wrong encryption context is ACCESS_DENIED`
  - `generate returns only ciphertext`
  - `the CLI never prints plaintext` (the plaintext is not in `io.out`)
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass.**
- [ ] **Step 5: Commit:** `aws: KMS-wrapped sealing keys for local-sealed and the kms-sealing-key command`.

### Task 4: S3 `BlobStore`

**Files:**
- Create: `src/s3.ts`, `tests/support/aws-emulator/s3.ts`
- Create: `tests/fixtures/aws-sigv4/s3-presign-example.json`, the presigned-URL example from the S3 SigV4
  documentation ("Authenticating Requests: Using Query Parameters"), with the expected signature **(verify)** against
  the docs page.
- Test: `tests/aws-s3.test.ts`

**Interfaces — Produces:**
```ts
export interface S3Location { bucket: string; prefix?: string }
export interface S3StoreOptions extends AwsServiceOptions, S3Location {
  sse?: { kind: 'aws:kms'; keyId?: string } | { kind: 'AES256' };
  /** Bodies up to this size go in one PUT (default 64 MiB); larger ones use multipart with `partBytes` parts (default 16 MiB). */
  singlePutBytes?: number;
  partBytes?: number;
  /** Force path-style URLs (buckets with dots; tests). Default: virtual-hosted unless the bucket has a dot. */
  pathStyle?: boolean;
}
export function s3BlobStore(options: S3StoreOptions): BlobStore;
```
**Behavior:**
- **Keys:** `${prefix}/${key}`, refusing keys with `..` segments, a leading `/` or control characters.
- **`get`:** a streaming `ReadableStream`; 404 → `undefined`.
- **`put`:**
  - Collects the stream into ≤ `singlePutBytes` and does one `PUT` with `x-amz-content-sha256` = the payload hash.
  - Otherwise: `CreateMultipartUpload`, `UploadPart` (each part hashed and signed), `CompleteMultipartUpload`.
  - **Any failure → `AbortMultipartUpload`**, then rethrow.
  - SSE headers on create/put.
- **`delete`:** a 404 is success.
- **`presign(key, { method, expiresInSeconds })`:** `presignUrl` with S3 mode, max 7 days.

- [ ] **Step 1: Write the failing tests:**
  - `matches the S3 documentation presign example`
  - `put and get round-trip a small object with SSE-KMS headers`
  - `large bodies use multipart and complete in order`
  - `aborts the multipart upload when a part fails` (`failNext('UploadPart', 'InternalError', 500)`; the emulator records `AbortMultipartUpload` and has no pending uploads)
  - `get of a missing key is undefined`
  - `refuses unsafe keys`
  - `virtual-hosted style unless the bucket has a dot`
  - `presign never appears in logs`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass:**
  `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-s3.test.ts -t BlobStore`.
- [ ] **Step 5: Commit:** `aws: S3 BlobStore with multipart, SSE and presigned URLs`.

### Task 5: S3 `SnapshotStore` (with the additive vps `downloadUrl?`)

**Files:**
- Create: `src/s3-snapshots.ts`
- Modify (coordinated): `packages/vps/src/snapshots.ts`:
  - add to `SnapshotStore`:
    ```ts
    /** A fresh URL to fetch a stored snapshot; restores call it when present (stored URLs may expire). */
    downloadUrl?(input: { tenantId: string; snapshotId: string; url: string }): Promise<string>;
    ```
  - the restore path (where the stored `url` is sent to the host) calls `store.downloadUrl?.(…) ?? row.url`.
- Test: `tests/aws-s3.test.ts` (section `SnapshotStore`), plus a vps test `tests/vps-snapshot-download-url.test.ts`

**Interfaces — Produces:**
```ts
/** Keys `${prefix}/${tenantId}/${sandboxId}/${snapshotId}`; url is `s3://${bucket}/${key}` (stable); uploads/downloads presigned. */
export function s3SnapshotStore(options: S3StoreOptions & { uploadExpiresSeconds?: number /* 3600 */; downloadExpiresSeconds?: number /* 3600 */ }): SnapshotStore;
```
- `presign` returns:
  - `uploadUrl` = presigned PUT;
  - `uploadHeaders` = the SSE headers the presign signed;
  - `url` = `s3://bucket/key`. This is a stable identifier, not a download link.
- `downloadUrl` parses the `s3://` url, checks that the key's tenant segment equals `input.tenantId`, and presigns a
  GET.
- `delete` removes the object.

- [ ] **Step 1: Write the failing tests:**
  - `presign returns a stable s3 url and a presigned upload`
  - `downloadUrl refuses another tenant's snapshot`
  - in vps: `restore uses downloadUrl when the store provides one` and `stores without downloadUrl keep the stored url`
  - `restore after 8 days gets a fresh download URL` (manual clock +8 d; the URL the host receives verifies under the emulator's presign check at that time)
- [ ] **Step 2: Run to fail**, then **Step 3: implement** (the vps edit is limited to the interface member and the
  one call site), then **Step 4: run to pass**, plus `tests/vps-sandboxes*.test.ts` to check for regressions.
- [ ] **Step 5: Commit:** `vps: optional SnapshotStore.downloadUrl; aws: S3 SnapshotStore`. Commit the vps file with
  `private-commit.mjs --use` if it has foreign hunks.

### Task 6: S3 audit archive sink

**Interfaces — Produces:**
```ts
export function s3AuditSink(options: S3StoreOptions & {
  id?: string;                                   // default 's3-audit'
  /** S3 Object Lock retention per object (bucket must have Object Lock enabled). */
  objectLock?: { mode: 'GOVERNANCE' | 'COMPLIANCE'; retainDays: number };
}): AuditSink;
```
**Behavior:**
- `write(records)` → a gzipped JSONL object at
  `${prefix}/year=YYYY/month=MM/day=DD/${records[0].id}_${records.at(-1).id}_${records.length}.jsonl.gz`, using the
  first record's UTC day.
- It sets `x-amz-checksum-sha256` and, with `objectLock`, the retention headers.
- **Idempotent:** the same batch maps to the same key.
- **Errors:** an empty `records` array is a no-op; S3 errors throw.
- **Docs:** Athena `CREATE EXTERNAL TABLE` DDL (partition projection on year/month/day) in the README.

- [ ] **Step 1: Write the failing tests:**
  - `writes one gzipped JSONL object per batch under a date partition`
  - `the same batch writes the same key`
  - `object lock headers are set`
  - `empty batches write nothing`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass.**
- [ ] **Step 5: Commit:** `aws: S3 audit archive sink`.

### Task 7: EventBridge, SNS and SQS event sinks

**Files:**
- Create: `src/event-sinks.ts`, `tests/support/aws-emulator/{eventbridge,sns,sqs}.ts`
- Test: `tests/aws-event-sinks.test.ts`

**Interfaces — Produces:**
```ts
export function eventBridgeSink(options: AwsServiceOptions & { id?: string; eventBusName?: string /* 'default' */; source?: string /* 'better-compute' */ }): EventSink;
export function snsSink(options: AwsServiceOptions & { id?: string; topicArn: string }): EventSink;            // FIFO when the ARN ends in .fifo
export function sqsSink(options: AwsServiceOptions & { id?: string; queueUrl: string }): EventSink;            // FIFO when the URL ends in .fifo
```

**Mapping and limits** (AWS limits **(verify)**, program Appendix C):

| Sink | Call | Per-batch limits | Entry |
|---|---|---|---|
| EventBridge | `PutEvents` (json1.1 `AWSEvents.PutEvents`) | 10 entries, 256 KiB | `{ Source, DetailType: event.type, Detail: JSON.stringify(event), EventBusName, Time: event.time, Resources: [] }` |
| SNS | `PublishBatch` (query) | 10 entries, 256 KiB | `Id: <index>`, `Message: JSON(event)`, `MessageAttributes { type, tenantId }`; FIFO adds `MessageGroupId: event.tenantId`, `MessageDeduplicationId: event.id` |
| SQS | `SendMessageBatch` (json1.0 `AmazonSQS.SendMessageBatch`) | 10 entries, 256 KiB | as SNS, with `MessageBody` |

**Failure rules (all three):**
1. Chunk with `chunkBy`.
2. A single event over the byte limit throws `ComputeError('PAYLOAD_TOO_LARGE', …, undefined, { eventId })`. The
   dispatcher's bisection isolates it and dead-letters it.
3. Any failed entry in a response (`FailedEntryCount>0` / `Failed[]`) throws `PROVIDER_ERROR` with
   `details.failed = [eventId…]` after every chunk has been attempted. Successful entries may then be redelivered
   (at-least-once).
4. Throttling throws `RATE_LIMITED`; the dispatcher backs off.

- [ ] **Step 1: Write the failing tests** (`it.each` over the three sinks where shapes match):
  - `delivers events in batches of at most 10`
  - `throws on a partially failed batch so the dispatcher retries`
  - `an oversized event fails alone with PAYLOAD_TOO_LARGE`
  - `FIFO targets get group and dedupe ids`
  - `entries carry the event id for consumer dedupe`
  - `works under createSinkDispatch`: wire the sink into `createSinkDispatch` (`server/src/runtime/events.ts:328`) with a seeded outbox. One poisoned oversized event ends in `outbox_dead_letters`, and the other 24 are delivered.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-event-sinks.test.ts -t "EventBridge|SNS|SQS|dispatch"`.
- [ ] **Step 3: Implement**, then **Step 4: run to pass.**
- [ ] **Step 5: Commit:** `aws: EventBridge, SNS and SQS event sinks`.

### Task 8: Kinesis and Firehose sinks

**Interfaces — Produces:**
```ts
export function kinesisSink(options: AwsServiceOptions & { id?: string; streamName?: string; streamArn?: string; partitionKey?: 'tenant' | 'subject' /* 'tenant' */ }): EventSink;
export function firehoseSink(options: AwsServiceOptions & { id?: string; deliveryStreamName: string }): EventSink;
export function firehoseAuditSink(options: AwsServiceOptions & { id?: string; deliveryStreamName: string }): AuditSink;
```
**Behavior:**

| Sink | Call | Per-batch limits | Record |
|---|---|---|---|
| Kinesis | `PutRecords` | 500 records, 5 MiB, 1 MiB each | `Data` = JSON line, `PartitionKey` = tenantId or subject |
| Firehose (both sinks) | `PutRecordBatch` | 500 records, 4 MiB, 1000 KiB each | newline-terminated JSON |

`FailedRecordCount`/`FailedPutCount > 0` throws, as in Task 7.

- [ ] **Step 1: Write the failing tests:**
  - `kinesis partitions by tenant`
  - `firehose records are newline-terminated`
  - `throws on a partially failed batch` (each)
  - `audit records go through firehoseAuditSink`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass.**
- [ ] **Step 5: Commit:** `aws: Kinesis and Firehose sinks`.

### Task 9: ACM Private CA as a `CertificateAuthority`

**Files:**
- Create: `src/acm-pca.ts`, `tests/support/aws-emulator/acmpca.ts` (it signs with a pki `createLocalCa` so the
  certificates are real)
- Test: `tests/aws-certificate-authorities.test.ts`

**Interfaces — Consumes:** `CertificateProfile`, `IssuedCertificate` (`core/extension.ts`); pki's `rolePrefix`
(`'bc-role:'`, `x509.ts:66`) and `parseCertificate` (for tests).

**Interfaces — Produces:**
```ts
export function acmPcaCertificateAuthority(options: AwsServiceOptions & {
  id: string;                             // e.g. 'node' | 'serving' | 'internal' (one CA per job; no key does two jobs)
  certificateAuthorityArn: string;
  /** In-call wait for GetCertificate (default 10_000; polled every 250 ms). */
  issueWaitMs?: number;
}): CertificateAuthority;
```
**Behavior:**
- **`sign(csr, profile)`:** `IssueCertificate` with:
  - `Csr` (PEM of the DER) and `SigningAlgorithm: 'SHA256WITHECDSA'`;
  - `Validity { Type: 'ABSOLUTE', Value: notAfterEpochSeconds }`, from `profile.ttlSeconds` on the injected clock;
  - `TemplateArn: arn:<p>:acm-pca:::template/BlankEndEntityCertificate_APIPassthrough/V1`;
  - `ApiPassthrough`:
    - `Subject.CustomAttributes` with OU `bc-role:<role>` when `profile.role`;
    - `Extensions.SubjectAlternativeNames` (URI/DNS from `uriSans`/`dnsSans`);
    - `KeyUsage { DigitalSignature: true }`;
    - `ExtendedKeyUsage` (`CLIENT_AUTH` | `SERVER_AUTH` per `usage`);
  - `IdempotencyToken` = sha256(csr)[0:36].

  Then it polls `GetCertificate` until issued or `issueWaitMs` runs out (then `UNAVAILABLE`, reason `pca-pending`).
  It returns DER `certificate`, `chain`, `serial` (hex), `notBefore` and `notAfter`, parsed from the certificate.
- **`certificates()`:** `GetCertificateAuthorityCertificate` (certificate + chain, PEM → DER), cached for 1 h.
- **`revoke(serial, reason)`:** `RevokeCertificate { CertificateSerial: <colon-hex>, RevocationReason: map(reason) ?? 'UNSPECIFIED' }`.

- [ ] **Step 1: Write the failing tests:**
  - `issues a node certificate the local verifier accepts`: build a CSR with pki, `sign` with role `node` and a SPIFFE URI SAN, then:
    - `parseCertificate` shows OU `bc-role:node`, the URI SAN and EKU clientAuth;
    - `verifyCertificateChain` against `certificates()` passes.
  - `the same CSR is idempotent`
  - `pending issuance past the wait is UNAVAILABLE`
  - `revoke maps the serial format`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass:**
  `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-certificate-authorities.test.ts -t "Private CA"`.
- [ ] **Step 5: Commit:** `aws: ACM Private CA certificate authority`.

### Task 10: KMS-key `CertificateAuthority` (with the additive pki signer export)

**Files:**
- Modify (coordinated): `packages/pki/src/x509.ts`, adding:
  ```ts
  export interface CertificateSigner { readonly algorithm: 'ecdsa-sha256'; sign(tbs: Uint8Array): Promise<Uint8Array> /* DER ECDSA-Sig-Value */ }
  export function buildCertificateWithSigner(template: CertificateTemplate, signer: CertificateSigner): Promise<Uint8Array>;
  ```
  `buildCertificate(template, keyObject)` keeps its current behavior; refactor it internally to share the
  TBS-building code.
- Create: `src/kms-ca.ts`; extend `tests/support/aws-emulator/kms.ts` with an ECC_NIST_P256 key and `Sign`
  (MessageType DIGEST) + `GetPublicKey`.
- Test: `tests/aws-certificate-authorities.test.ts` (section `KMS CA`) and `tests/pki-certificate-signer.test.ts`

**Interfaces — Produces:**
```ts
export function kmsCertificateAuthority(options: AwsServiceOptions & {
  id: string; keyId: string;
  /** DER CA certificate whose public key is the KMS key's (issued by the operator's root over kmsCaCsr). */
  certificate: Uint8Array; chain?: Uint8Array[];
  maxTtlSeconds?: number;
}): CertificateAuthority;
/** A PKCS#10 CSR for the KMS key, signed by KMS, for the operator's root to certify. */
export function kmsCaCsr(options: AwsServiceOptions & { keyId: string; subject: { commonName: string; organization?: string } }): Promise<Uint8Array>;
export function awsKmsCaCsrCommand(): { name: 'aws kms-ca-csr'; group: 'Security'; summary: string; description: string; flags: Record<string, unknown>; run(context: AwsCommandContext): Promise<void> };
```
**Behavior:**
- `sign` builds the same template pki's local CA builds for the profile (same subject/OU, SAN and EKU rules; TTL
  capped by `maxTtlSeconds`), then calls `buildCertificateWithSigner` with a signer that does
  `KMS Sign { KeyId, Message: sha256(tbs), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }`.
- At construction (lazily, on first sign) it checks that the CA certificate's public key equals
  `GetPublicKey(keyId)`. A mismatch is `INVALID_CONFIG`.

- [ ] **Step 1: Write the failing tests:**
  - `buildCertificateWithSigner matches buildCertificate for the same key` (pki test: same TBS bytes; both verify)
  - `KMS CA issues certificates that verify against its certificate`
  - `refuses a CA certificate for a different key`
  - `kmsCaCsr produces a CSR whose signature verifies`
- [ ] **Step 2: Run to fail**, then **Step 3: implement** (the pki edit is additive only), then **Step 4: run to
  pass**, plus `tests/pki-*.test.ts` to check for regressions.
- [ ] **Step 5: Commit:** `pki: buildCertificateWithSigner; aws: KMS-key certificate authority and kms-ca-csr`.
  Commit pki with `--use` if needed.

### Task 11: RDS IAM authentication tokens

**Interfaces — Produces:**
```ts
/** A 15-minute RDS IAM auth token: a SigV4 presigned `connect` URL without the scheme (service 'rds-db'). */
export function rdsAuthToken(options: AwsServiceOptions & { hostname: string; port?: number /* 5432 */; username: string }): Promise<string>;
/** Memoizing provider for `pg` `password: () => …`; refreshes 3 minutes before expiry. */
export function rdsAuthTokenProvider(options: AwsServiceOptions & { hostname: string; port?: number; username: string }): () => Promise<string>;
```
**README:** shows `postgres({ pool: new pg.Pool({ host, user, database, ssl: { ca: <RDS global bundle>, rejectUnauthorized: true }, password: rdsAuthTokenProvider({ … }) }) })`.
The aws package never imports `pg`.

- [ ] **Step 1: Write the failing tests:**
  - `token is a presigned connect URL for rds-db without a scheme` (contains `Action=connect`, `DBUser=<user>`, `X-Amz-Expires=900`; does not start with `https://`)
  - `provider caches and refreshes before expiry` (manual clock)
  - `token never appears in logs`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass:**
  `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-rds-emf.test.ts -t RDS`.
- [ ] **Step 5: Commit:** `aws: RDS IAM auth tokens`.

### Task 12: CloudWatch EMF metrics exporter and the ADOT guide

**Interfaces — Consumes:** `MetricsRegistry.expose()` (`observability/src/registry.ts:91`), which returns the
Prometheus text format 0.0.4.

**Interfaces — Produces:**
```ts
export interface PromSample { name: string; labels: Readonly<Record<string, string>>; value: number; type: 'counter' | 'gauge' | 'histogram' | 'untyped' }
export function parsePrometheusText(text: string): PromSample[];
export function emfMetricsExporter(options: {
  registry: { expose(): string };
  namespace?: string;                                // 'BetterCompute'
  /** Labels kept as EMF dimensions (default ['module','method','code','pool','kind']); all others dropped (cardinality). */
  dimensions?: readonly string[];
  intervalMs?: number;                               // 60_000
  out?: (line: string) => void;                      // default process.stdout.write(line + '\n')
  clock?: Clock;
}): { flush(): void; start(): void; stop(): void };
```
**Behavior:**
- Counters emit **deltas** since the last flush, and the first flush only records a baseline. Gauges emit values.
- Histograms emit `_sum` and `_count` deltas only.
- Each EMF document holds ≤ 100 metrics and ≤ 30 dimensions; extra metrics go to more documents.
- Metric names drop the registry prefix.
- `forbiddenLabels` from the registry never appear (they are already absent from `expose()`).

**Docs:** `apps/docs/content/docs/operations/aws.mdx` (new). It covers:
- EMF on ECS (`awslogs` driver);
- bcd OTLP → an ADOT collector (`TelemetrySpec.otlpEndpoint`, with headers via `headersRef`);
- an ADOT collector scraping `/metrics` (bearer token) and remote-writing to Amazon Managed Service for Prometheus;
- control-plane spans → ADOT through `onSpan`.

- [ ] **Step 1: Write the failing tests:**
  - `parses counters, gauges and histograms`
  - `first flush is a baseline, then deltas`
  - `drops non-dimension labels`
  - `splits documents at 100 metrics`
  - `EMF shape has _aws.CloudWatchMetrics with namespace and dimensions`
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass.**
- [ ] **Step 5: Commit:** `aws: CloudWatch EMF metrics exporter; docs: operating on AWS`.

### Task 13: Host composition test, README, security review (A8 exit gate)

**Files:**
- Test: `tests/aws-host-composition.test.ts`
- Create: `packages/aws/README.md`
- Modify: `CHANGELOG.md`, `apps/docs/content/docs/reference/roadmap.mdx`, `generated/api-surface.json`

- [ ] **Step 1: Write the composition test.** It runs `betterCompute({ … })` on PGlite with these wired to one
  emulator:
  - `secrets: [routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: awsSecretsManagerStore(…) }], fallback: localSealedSecretStore({ sql, keys: await kmsSealingKeys(…) }), putTo: … })]`;
  - `sinks: { events: [eventBridgeSink(…)], audit: [s3AuditSink(…)] }`;
  - `blob` for downloads = `s3BlobStore(…)`;
  - `vps({ snapshots: s3SnapshotStore(…) })`.

  Then assert:
  - `a provider account secret round-trips through Secrets Manager`;
  - `an instance event reaches EventBridge`;
  - `audit records land in S3`;
  - `a support bundle uploads through the presigned S3 URL`.
- [ ] **Step 2: Run it**, and fix only `aws` code.
- [ ] **Step 3: Write the README.** It gives every factory with its IAM statement (least privilege, resource-scoped)
  and the composition snippet from the test. It also says that none of this is required: each piece is independent.
- [ ] **Step 4: Run the gate:**
  - `node node_modules/typescript/bin/tsc -b packages/aws packages/pki packages/vps`
  - `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-*.test.ts tests/pki-*.test.ts tests/vps-sandboxes*.test.ts tests/vps-snapshot-download-url.test.ts`
  - `node scripts/check-deps.mjs`
  - `node scripts/api-surface.mjs --update`
- [ ] **Step 5:** Run a **security-review subagent** over this branch's commits. It focuses on tenant isolation in
  the secret stores, plaintext key handling, presigned URL exposure, and sink at-least-once/no-drop. Fix HIGH and
  MEDIUM findings, each with a test.
- [ ] **Step 6: Commit:** `docs: AWS platform services README, roadmap and changelog`.

---

## Self-review notes (for the executor)

- **Coverage of the program's A8 list:** each factory has a task.
  - Secrets Manager: T1. Parameter Store: T2. KMS sealing: T3.
  - S3 blob: T4. S3 snapshots: T5. S3 audit: T6.
  - EventBridge/SNS/SQS: T7. Kinesis/Firehose: T8.
  - ACM PCA: T9. KMS CA: T10.
  - RDS: T11. EMF and ADOT docs: T12.
- **Deferred, not dropped:**
  - a KMS signer for command signing (PLAN D17, "a KMS root certifying 24 h worker keys") reuses Task 10's
    `CertificateSigner`, but needs a pki `SigningKey` seam; it is its own follow-up;
  - Security Lake (OCSF) export;
  - Marketplace metering (AQ6).
- **Type consistency:** `AwsServiceOptions` and `S3StoreOptions` are defined once (common.ts, s3.ts) and reused;
  `AwsCommandContext` is structurally the same as in provider-aws.
