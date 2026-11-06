# @better-compute/aws

AWS platform services behind the seams better-compute already has, with no AWS SDK. Each export is a factory that returns an object implementing an existing interface (`SecretStore`, `BlobStore`, `SnapshotStore`, `EventSink`, `AuditSink`, `CertificateAuthority`), so a host that runs on or next to AWS plugs them in without changing `@better-compute/core`.

None of this is required. Each piece is independent: use Secrets Manager without S3, EventBridge without KMS, and so on.

It depends on `@better-compute/core`, `@better-compute/aws-core`, `@better-compute/pki` and `@better-compute/vps`. It is not in the `better-compute` umbrella, and nothing in `packages/` depends on it.

```sh
pnpm add @better-compute/aws
```

## Common options

Every factory takes `AwsServiceOptions`:

| Option        | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `region`      | The AWS region. It is validated strictly, and is the only config text that reaches a host name.          |
| `credentials` | A `CredentialSource` (`{ kind, credentials(context), invalidate? }`): an ambient chain on ECS/EKS/EC2, a static secret, or a test stub. |
| `endpoint`    | Optional base URL (VPC endpoints, tests). A host option, never tenant config.                            |
| `fetch`, `clock`, `log` | Injected for tests. Logs carry only service, operation, status, request id and duration.       |

Requests are SigV4-signed, retried once on clock skew or an expired session token, and AWS errors map to `ComputeError` codes (throttling is `RATE_LIMITED`, missing resources `NOT_FOUND`, and so on). Messages are redacted of key ids, secrets, tokens and signatures.

## Composition

```ts
import { localSealedSecretStore } from '@better-compute/pki';
import {
  awsSecretsManagerStore, eventBridgeSink, kmsSealingKeys, routeSecretStores,
  s3AuditSink, s3BlobStore, s3SnapshotStore,
} from '@better-compute/aws';

const aws = { region: 'us-east-1', credentials };
const secretsManager = awsSecretsManagerStore(aws);
const local = localSealedSecretStore({
  sql: database,
  keys: await kmsSealingKeys({ ...aws, current: 'k1', wrapped: { k1: process.env.BC_SEALING_KEY_K1! } }),
});
const blob = s3BlobStore({ ...aws, bucket: 'bc-blobs', sse: { kind: 'aws:kms' } });

betterCompute({
  // …
  secrets: [routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: secretsManager }], fallback: local, putTo: secretsManager })],
  sinks: { events: [eventBridgeSink(aws)], audit: [s3AuditSink({ ...aws, bucket: 'bc-audit', prefix: 'audit' })] },
  downloads: { blob },
  supportBundles: { blob },
  modules: [vps({ snapshots: s3SnapshotStore({ ...aws, bucket: 'bc-snapshots', sse: { kind: 'aws:kms' } }) })],
});
```

`tests/aws-host-composition.test.ts` runs this composition against the emulator.

## Secrets

### `awsSecretsManagerStore(options)`

Refs are `secret://aws-sm/<tenantId>/<id>`; secrets are named `<prefix>/<tenantId>/<id>` (prefix `better-compute`) and tagged `better-compute:tenant`. Values are at most 64 KiB. `put` with `{ ref }` rotates in place (`PutSecretValue`), only for the ref's own tenant. `resolve(ref, { tenantId })` refuses another tenant's ref with `ACCESS_DENIED` before any AWS call; ref segments are `[A-Za-z0-9_-]`, so `..` and `/` cannot reach another path. `delete` uses `recoveryWindowDays` (default 7; 0 forces deletion). `cacheTtlMs` caches resolved values.

```json
{ "Effect": "Allow",
  "Action": ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue",
             "secretsmanager:DeleteSecret", "secretsmanager:TagResource"],
  "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:better-compute/*" }
```

Add `kms:GenerateDataKey` and `kms:Decrypt` on `kmsKeyId` when it is a customer managed key.

### `awsParameterStore(options)`

Refs are `secret://aws-ssm/<tenantId>/<id>`, stored as `SecureString` parameters under `/better-compute/<tenantId>/<id>`. Values are at most 4 KiB on the Standard tier and 8 KiB on Advanced. Tenant and path checks are as above.

```json
{ "Effect": "Allow",
  "Action": ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter", "ssm:AddTagsToResource"],
  "Resource": "arn:aws:ssm:<region>:<account>:parameter/better-compute/*" }
```

### `routeSecretStores({ routes, fallback, putTo })`

One `secret`-scheme store over several: refs route by the longest matching prefix, everything else goes to `fallback`, and new secrets go to `putTo`. Existing local-sealed refs keep resolving while new ones land in Secrets Manager.

### `kmsSealingKeys(options)` and `generateKmsSealingKey(options)`

Keep local-sealed's sealing keys wrapped by KMS. `better-compute aws kms-sealing-key --key-id <arn>` (`awsKmsSealingKeyCommand`) calls `GenerateDataKeyWithoutPlaintext` and prints only the ciphertext, so the plaintext never leaves KMS. At start, `kmsSealingKeys({ current, wrapped })` decrypts the wrapped keys (encryption context `purpose=better-compute-sealing`) into the `SealingKeys` local-sealed takes. Rotation is local-sealed's own: add a key id, make it current, and `reseal()`.

```json
{ "Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": "<key arn>",
  "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": "better-compute-sealing" } } }
```

The operator who runs `kms-sealing-key` needs `kms:GenerateDataKeyWithoutPlaintext` on the key with the same condition.

## S3

### `s3BlobStore(options)`

`get` streams (a missing key is `undefined`); `put` sends one signed PUT up to `singlePutBytes` (64 MiB) and otherwise a multipart upload in `partBytes` parts (16 MiB, at least 5 MiB), aborted on any failure so no parts are orphaned; `delete` treats a missing key as success; `presign` lasts at most 7 days. Keys with `..`, `.` or empty segments, a leading `/` or control characters are refused. `sse` adds SSE-KMS or SSE-S3 headers. Virtual-hosted URLs unless the bucket has a dot or `pathStyle` is set. A presigned PUT carries no SSE headers, so the bucket's default encryption applies to support bundle uploads.

```json
{ "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
  "Resource": "arn:aws:s3:::<bucket>/<prefix>/*" }
```

### `s3SnapshotStore(options)`

Sandbox snapshots at `<prefix>/<tenantId>/<sandboxId>/<snapshotId>`. The stored url is the stable `s3://bucket/key`, an identifier rather than a link. Uploads are presigned PUTs with the SSE headers signed (returned as `uploadHeaders`). Restores call `downloadUrl` for a fresh presigned GET, only for the snapshot's own tenant, so a snapshot can be restored long after its upload URL expired. A download URL is signed at the start of its half-lifetime window, so the host's desired spec does not change on every render. Same IAM as the blob store.

### `s3AuditSink(options)`

One gzipped JSON Lines object per batch at `<prefix>/year=YYYY/month=MM/day=DD/<first>_<last>_<n>.jsonl.gz`, with an SHA-256 checksum and, with `objectLock`, Object Lock retention (the bucket must have Object Lock enabled). The same batch writes the same key, so redelivery is idempotent. Use lifecycle rules to move old partitions to Glacier storage classes. IAM: `s3:PutObject` (and `s3:PutObjectRetention` with Object Lock) on the prefix.

Query it with Athena (partition projection, no crawler):

```sql
CREATE EXTERNAL TABLE better_compute_audit (
  id string, tenantId string, time bigint, action string,
  resource struct<type:string, id:string>, admission string, details string)
PARTITIONED BY (year string, month string, day string)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
LOCATION 's3://<bucket>/audit/'
TBLPROPERTIES (
  'projection.enabled' = 'true',
  'projection.year.type' = 'integer', 'projection.year.range' = '2024,2100',
  'projection.month.type' = 'integer', 'projection.month.range' = '1,12', 'projection.month.digits' = '2',
  'projection.day.type' = 'integer', 'projection.day.range' = '1,31', 'projection.day.digits' = '2',
  'storage.location.template' = 's3://<bucket>/audit/year=${year}/month=${month}/day=${day}/');
```

## Event and audit streams

| Factory | Call | Per call | Entry |
| --- | --- | --- | --- |
| `eventBridgeSink` | `PutEvents` | 10 entries, 256 KiB | `Source` (default `better-compute`), `DetailType` = event type, `Detail` = the event |
| `snsSink` | `PublishBatch` | 10 entries, 256 KiB | `Message` = the event; attributes `type`, `tenantId`, `eventId` |
| `sqsSink` | `SendMessageBatch` | 10 entries, 256 KiB | `MessageBody` = the event; the same attributes |
| `kinesisSink` | `PutRecords` | 500 records, 5 MiB (1 MiB each) | a JSON line, partition key = tenant or subject |
| `firehoseSink`, `firehoseAuditSink` | `PutRecordBatch` | 500 records, 4 MiB (1000 KiB each) | a newline-terminated JSON record |

All of them are at least once. An event over the limit fails with `PAYLOAD_TOO_LARGE` (the dispatcher's bisection isolates it and dead-letters it). Any refused entry, or a response that does not account for every entry, throws after every chunk was attempted, so the dispatcher retries; consumers dedupe by the event id. SNS and SQS FIFO targets (`.fifo`) get `MessageGroupId` = tenant and `MessageDeduplicationId` = event id.

IAM: `events:PutEvents` on the bus, `sns:Publish` on the topic, `sqs:SendMessage` on the queue, `kinesis:PutRecords` on the stream, `firehose:PutRecordBatch` on the delivery stream (plus `kms:GenerateDataKey` where the target is encrypted with a customer managed key).

## Certificate authorities

### `acmPcaCertificateAuthority(options)`

AWS Private CA as a `CertificateAuthority`, one CA per job (`id` `node`, `serving` or `internal`). It issues from the API-passthrough blank end-entity template with the same subject (`O`, `OU=bc-role:<role>`, `CN`), SANs and EKU the local CAs build, waits up to `issueWaitMs` for issuance (then `UNAVAILABLE`, reason `pca-pending`), caches the CA certificates for an hour, and revokes by serial.

```json
{ "Effect": "Allow",
  "Action": ["acm-pca:IssueCertificate", "acm-pca:GetCertificate", "acm-pca:GetCertificateAuthorityCertificate", "acm-pca:RevokeCertificate"],
  "Resource": "<certificate authority arn>",
  "Condition": { "ArnLike": { "acm-pca:TemplateArn": "arn:aws:acm-pca:::template/BlankEndEntityCertificate_APIPassthrough/V*" } } }
```

### `kmsCertificateAuthority(options)` and `kmsCaCsr(options)`

A CA whose key never leaves KMS (an `ECC_NIST_P256` `SIGN_VERIFY` key). `better-compute aws kms-ca-csr --key-id <arn> --common-name <cn>` (`awsKmsCaCsrCommand`) prints a CSR signed by KMS; certify it as a CA with the operator root, then pass the certificate. `sign` applies the local CAs' profile rules for `kind` and has KMS sign the certificate's digest. On first use it checks that the certificate certifies the KMS key. IAM: `kms:Sign` and `kms:GetPublicKey` on the key. `pki`'s `buildCertificateWithSigner` is the seam.

## RDS IAM authentication

`rdsAuthTokenProvider({ region, credentials, hostname, port, username })` returns `() => Promise<string>` for `pg`'s `password`: a 15-minute token, refreshed three minutes before it expires. The package never imports `pg`:

```ts
postgres({
  pool: new pg.Pool({
    host, user, database,
    ssl: { ca: rdsGlobalBundlePem, rejectUnauthorized: true },
    password: rdsAuthTokenProvider({ region, credentials, hostname: host, username: user }),
  }),
});
```

The token is a password: it is never logged. IAM: `rds-db:connect` on `arn:aws:rds-db:<region>:<account>:dbuser:<resource id>/<user>`.

## CloudWatch metrics

`emfMetricsExporter({ registry })` writes the metrics registry as CloudWatch Embedded Metric Format lines on standard output (the `awslogs` driver ships them): counter deltas, gauge values, only the dimension labels. See the docs page "Operating on AWS" for EMF, ADOT, Amazon Managed Service for Prometheus and X-Ray.

## Implementation note

SigV4 signing and the JSON and query protocol clients live in `src/internal/` for now, with the shapes `@better-compute/aws-core` takes on (A0). They move there once aws-core ships them.

## License

Apache-2.0.
