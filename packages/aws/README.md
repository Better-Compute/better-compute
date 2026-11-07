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
  keys: await kmsSealingKeys({ ...aws, keyId: process.env.BC_SEALING_KMS_KEY!, current: 'k1', wrapped: { k1: process.env.BC_SEALING_KEY_K1! } }),
});
const blob = s3BlobStore({ ...aws, bucket: 'bc-blobs', sse: { kind: 'aws:kms' } });
const snapshots = s3SnapshotStore({ ...aws, bucket: 'bc-snapshots', sse: { kind: 'aws:kms' } });
// Before serving: restores rendered without download credentials cannot be fetched (see s3SnapshotStore).
if (!(await snapshots.warm())) throw new Error('snapshot download credentials did not load');

betterCompute({
  // …
  secrets: [routeSecretStores({ routes: [{ prefix: 'secret://aws-sm/', store: secretsManager }], fallback: local, putTo: secretsManager })],
  sinks: { events: [eventBridgeSink(aws)], audit: [s3AuditSink({ ...aws, bucket: 'bc-audit', prefix: 'audit' })] },
  downloads: { blob },
  supportBundles: { blob },
  modules: [vps({ snapshots })],
});
```

`tests/aws-host-composition.test.ts` runs this composition against the emulator.

## Secrets

### `awsSecretsManagerStore(options)`

Refs are `secret://aws-sm/<tenantId>/<id>`; secrets are named `<prefix>/<tenantId>/<id>` (prefix `better-compute`) and tagged `better-compute:tenant`. Values are at most 64 KiB. `put` with `{ ref }` rotates in place (`PutSecretValue`), only for the ref's own tenant. `resolve(ref, { tenantId })` refuses another tenant's ref with `ACCESS_DENIED` before any AWS call; ref segments are `[A-Za-z0-9._-]` and never `.` or `..`, so no segment can reach another path. local-sealed also accepts tenant ids containing `:`, but `:` is not valid in Secrets Manager or SSM names, so such a tenant's `put` to these stores fails with `INVALID_INPUT`. `delete` uses `recoveryWindowDays` (default 7; 0 forces deletion). `cacheTtlMs` caches resolved values.

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

One `secret`-scheme store over several: refs route by the longest matching prefix, everything else goes to `fallback`, and new secrets go to `putTo`. A ref goes to a route only in the AWS stores' shape, with exactly `<tenant>/<id>` after the prefix. A local-sealed ref `secret://aws-sm/<id>` (a tenant whose id is `aws-sm`) therefore still goes to the fallback. Existing local-sealed refs keep resolving while new ones land in Secrets Manager.

### `kmsSealingKeys(options)` and `generateKmsSealingKey(options)`

Keep local-sealed's sealing keys wrapped by KMS. `better-compute aws kms-sealing-key --key-id <arn>` (`awsKmsSealingKeyCommand`) calls `GenerateDataKeyWithoutPlaintext` and prints only the ciphertext, so the plaintext never leaves KMS. At start, `kmsSealingKeys({ current, wrapped })` decrypts the wrapped keys (encryption context `purpose=better-compute-sealing`) into the `SealingKeys` local-sealed takes. Pass `keyId` (recommended): `Decrypt` is then pinned to that key, so a wrapped blob substituted from another key the role can use fails with `ACCESS_DENIED` instead of unwrapping. Rotation is local-sealed's own: add a key id, make it current, and `reseal()`.

```json
{ "Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": "<key arn>",
  "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": "better-compute-sealing" } } }
```

The operator who runs `kms-sealing-key` needs `kms:GenerateDataKeyWithoutPlaintext` on the key with the same condition.

## S3

### `s3BlobStore(options)`

`get` streams (a missing key, S3's `NoSuchKey`, is `undefined`); `put` sends one signed PUT up to `singlePutBytes` (64 MiB) and otherwise a multipart upload in `partBytes` parts (16 MiB, at least 5 MiB), aborted on any failure so no parts are orphaned; `delete` treats a missing key as success. A bucket that does not exist (`NoSuchBucket`) is never treated as a missing key: `get` and `delete` throw `INVALID_CONFIG`. `presign` lasts at most 7 days. Keys with `..`, `.` or empty segments, a leading `/` or control characters are refused. `sse` adds SSE-KMS or SSE-S3 headers. Virtual-hosted URLs unless the bucket has a dot or `pathStyle` is set. `timeoutMs` (default 20 s, every factory takes it) bounds only the time to response headers: a download streams for as long as it takes. Requests that send a body get `timeoutMs` plus the body at 256 KiB/s. A presigned PUT carries no SSE headers, so the bucket's default encryption applies to support bundle uploads.

```json
[
  { "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
    "Resource": "arn:aws:s3:::<bucket>/<prefix>/*" },
  { "Effect": "Allow",
    "Action": "s3:ListBucket",
    "Resource": "arn:aws:s3:::<bucket>",
    "Condition": { "StringLike": { "s3:prefix": "<prefix>/*" } } }
]
```

The second statement is required. Without `s3:ListBucket`, S3 answers a GET of a missing key with 403 `AccessDenied` instead of 404 `NoSuchKey`, because it will not reveal whether the key exists. `get` would then throw `ACCESS_DENIED` where the `BlobStore` contract says `undefined`, which breaks downloads and support-bundle reads. The condition limits the listing to the store's prefix.

### `s3SnapshotStore(options)`

Sandbox snapshots at `<prefix>/<tenantId>/<sandboxId>/<snapshotId>`. The stored url is the stable `s3://bucket/key`, an identifier rather than a link. Uploads are presigned PUTs with the SSE headers signed (returned as `uploadHeaders`). Restores call `downloadUrl` for a fresh presigned GET, only for the snapshot's own tenant, so a snapshot can be restored long after its upload URL expired. A download URL is signed at the start of its half-lifetime window, so the host's desired spec does not change on every render.

vps asks for a download URL only while a restore is pending (instance `provisioning` or `starting`). Once the host has restored the instance, its spec carries the stable `s3://` identifier, so the spec stops changing and no live presigned link stays in `nodes.spec`. bcd keeps the snapshot file by digest and fetches only for an instance it does not have yet. A presigned GET is in `nodes.spec` only while its restore is pending, and it expires after `downloadExpiresSeconds`.

`downloadUrl` runs inside NodeSpec's transaction, so it makes no network call. It signs with credentials held in memory: they load when the store is made, refresh in the background once less than one URL lifetime is left, and are never used within a minute of expiry. While no credentials are loaded, `downloadUrl` is `UNAVAILABLE`. vps then logs the code, keeps that restore on its stored url for this pass, and still renders the rest of the node. bcd cannot fetch an `s3://` url, reports the restore as an instance error, and vps fails the instance. So await `warm()` before the host serves, and refuse to start when it resolves `false` (credentials did not load), as the composition above does. A stored url that is not `s3://` (written before the host switched to this store) passes through unchanged. Same IAM as the blob store, including the prefix-scoped `s3:ListBucket` statement.

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
| `eventBridgeSink` | `PutEvents` | 10 entries, 256 KiB | `Source` (default `better-compute`; a source starting with `aws.` is `INVALID_CONFIG`, since PutEvents refuses it), `DetailType` = event type, `Detail` = the event |
| `snsSink` | `PublishBatch` | 10 entries, 256 KiB | `Message` = the event; attributes `type`, `tenantId`, `eventId` |
| `sqsSink` | `SendMessageBatch` | 10 entries, 256 KiB | `MessageBody` = the event; the same attributes |
| `kinesisSink` | `PutRecords` | 500 records, 5 MiB (1 MiB each) | a JSON line, partition key = tenant or subject |
| `firehoseSink`, `firehoseAuditSink` | `PutRecordBatch` | 500 records, 4 MiB (1000 KiB each) | a newline-terminated JSON record |

All of them are at least once. An event over the limit fails with `PAYLOAD_TOO_LARGE` (the dispatcher's bisection isolates it and dead-letters it). Any refused entry, or a response that does not account for every entry, throws after every chunk was attempted, so the dispatcher retries; consumers dedupe by the event id. SNS and SQS FIFO targets (`.fifo`) get `MessageGroupId` = tenant and `MessageDeduplicationId` = event id.

IAM: `events:PutEvents` on the bus, `sns:Publish` on the topic, `sqs:SendMessage` on the queue, `kinesis:PutRecords` on the stream, `firehose:PutRecordBatch` on the delivery stream (plus `kms:GenerateDataKey` where the target is encrypted with a customer managed key).

## Certificate authorities

### `acmPcaCertificateAuthority(options)`

AWS Private CA as a `CertificateAuthority`, one CA per job (`id` `node`, `serving` or `internal`). It issues from the API-passthrough blank end-entity template with the same subject (`O`, `OU=bc-role:<role>`, `CN`), SANs and EKU the local CAs build, waits up to `issueWaitMs` for issuance (then `UNAVAILABLE`, reason `pca-pending`), caches the CA certificates for an hour, and revokes by serial. Before any AWS call, `sign` applies the local CAs' profile rules for `kind` (default: `id` when it is `node`, `serving` or `internal`). A node certificate is client-only, has one SPIFFE node URI SAN, no DNS SANs and an agent role, and lives at most 1 day. A serving certificate is server-only with DNS SANs. `maxTtlSeconds` can lower the cap. AWS Private CA itself publishes revocations only through its CRL or OCSP, and the gateway checks node certificates against its own revocation set, not the CRL. So a `node` PCA must be given `revocations`, the set the gateway reads (`INVALID_CONFIG` otherwise). `revoke` writes the serial there first and then calls `RevokeCertificate`: if the AWS call fails or the process stops in between, the certificate is already refused locally, and the caller retries the revoke. A retry that AWS answers with `RequestAlreadyProcessedException` succeeds. Serving and internal PCAs may omit `revocations`. `sleep` replaces the timer between `GetCertificate` polls, so hosts and tests can drive the wait.

```json
{ "Effect": "Allow",
  "Action": ["acm-pca:IssueCertificate", "acm-pca:GetCertificate", "acm-pca:GetCertificateAuthorityCertificate", "acm-pca:RevokeCertificate"],
  "Resource": "<certificate authority arn>",
  "Condition": { "ArnLike": { "acm-pca:TemplateArn": "arn:aws:acm-pca:::template/BlankEndEntityCertificate_APIPassthrough/V*" } } }
```

### `kmsCertificateAuthority(options)` and `kmsCaCsr(options)`

A CA whose key never leaves KMS (an `ECC_NIST_P256` `SIGN_VERIFY` key). `better-compute aws kms-ca-csr --key-id <arn> --common-name <cn>` (`awsKmsCaCsrCommand`) prints a CSR signed by KMS; certify it as a CA with the operator root, then pass the certificate. `sign` applies the local CAs' profile rules for `kind` and has KMS sign the certificate's digest. On first use it checks that the certificate certifies the KMS key, and it verifies every issued certificate under the CA certificate's key. If `keyId` is an alias later pointed at another key, or KMS returns a bad signature, `sign` fails with `INVALID_STATE` and redoes the key check on the next call. `revoke` writes to `revocations`, which the CA also exposes, with `isRevoked`, as the local CAs do. Verifiers only see a revocation if they read that same set: pass it to the gateway (`createGateway({ revocations })`, `certificateAuthenticate`) and persist it if revocations must survive a restart. Every KMS CA must be given `revocations` (`INVALID_CONFIG` otherwise), so a revoke cannot succeed into a set nobody reads. IAM: `kms:Sign` and `kms:GetPublicKey` on the key. `pki`'s `buildCertificateWithSigner` is the seam.

## RDS IAM authentication

`rdsAuthTokenProvider({ region, credentials, hostname, port, username })` returns `() => Promise<string>` for `pg`'s `password`: a 15-minute token, refreshed three minutes before it expires, or three minutes before the temporary credentials that signed it expire if that comes first. The package never imports `pg`:

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

## Deployment templates

`deploymentTemplates(options)` renders the reference deployment of the control plane on AWS as three CloudFormation JSON templates, and `better-compute aws deploy-templates --out <dir>` (`awsDeployTemplatesCommand`) writes them as new files. The CLI does not build the `aws` commands in: export them from the configuration module (`export const commands = [awsDeployTemplatesCommand()]`). It makes no AWS call. Deploy them in order; each imports the stacks before it through `${NetworkStack}-…` and `${DataStack}-…` exports:

| Stack | Renderer | What it creates |
| --- | --- | --- |
| `network` | `networkTemplate` | A VPC across 2 or 3 zones, public and private subnets, NAT per zone (or one), the S3 gateway endpoint, interface endpoints for Secrets Manager, KMS, ECR, Logs and STS, flow logs |
| `data` | `dataTemplate` | Aurora PostgreSQL (16 or later) Serverless v2 with IAM database authentication, TLS forced, `btree_gist` allowed, its own KMS key, a Secrets Manager-managed master password, reachable only from the exported client security group |
| `control-plane` | `controlPlaneTemplate` | ECS Fargate `api`, `worker` and `gateway` services and a `migrate` task from one digest-pinned image; an ALB with an ACM certificate and WAF; an NLB in TCP passthrough for the gateway's mTLS; least-privilege task roles; the deployment secret and the sealed PKI bundle in Secrets Manager; one KMS key; S3 buckets for downloads (behind CloudFront), blobs, snapshots and the Object Lock audit archive; an EventBridge bus; log groups and alarms |

Options are structural only (`name`, `zones`, `natGateways`, `readers`); runtime values (image, domains, certificate, task counts) are stack parameters. Every rendered template passes `lintTemplate` (references resolve, limits hold, no `NoEcho` parameters: the templates take no secrets). The deployment guide is [`deploy/aws/README.md`](../../deploy/aws/README.md).

## Implementation note

SigV4 signing and the JSON and query protocol clients live in `src/internal/` for now, with the shapes `@better-compute/aws-core` takes on (A0). They move there once aws-core ships them.

## License

Apache-2.0.
