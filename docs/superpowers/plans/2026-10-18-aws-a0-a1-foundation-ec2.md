# AWS A0 + A1: `aws-core` foundation and the EC2 provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator registers an AWS account and region as a better-compute provider account. Tenants can then
create, control, attach, detach and delete EC2 instances through provider pools, with the same API, reconcilers and
guarantees as GCP. Everything runs on a zero-dependency AWS client foundation (`@better-compute/aws-core`) that the
later AWS phases reuse.

**Architecture:**
- **`@better-compute/aws-core`** (new, depends only on `@better-compute/core`) implements:
  - SigV4 header signing and presigned URLs;
  - credential sources and their cache;
  - partitions and endpoints;
  - the `ec2`, `query`, `json` and `rest` protocols over injected `fetch`;
  - a safe XML reader, AWS → `ComputeError` mapping, and redaction.
- **`@better-compute/provider-aws`** (new, depends on `core`, `vps`, `aws-core`) implements `ProviderImpl` for EC2:
  `listOffers`, `create`, `get`, `delete`, `power`, `reinstall`, `list`, `discover`, `claim`, `release`. It reuses
  the GCP-era vps machinery unchanged: provider pools, attach/detach, discovery and conformance.
- **No core or vps changes in this plan.**

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), `node:crypto` (`createHash`, `createHmac`), `node:zlib`
(`gzipSync`), vitest, PGlite. EC2 API version `2016-11-15`, STS `2011-06-15`. No new npm dependencies.

**Spec:** [`2026-10-18-aws-integration-program.md`](2026-10-18-aws-integration-program.md) §0–§9. This plan
implements phases **A0** and **A1**. Decisions AD1–AD9 and AD16–AD18 bind here.

---

## Global Constraints

- Node ≥ 22.12, ESM only. Every package imports its own `.js` paths.
- **No new npm dependencies.** `aws-core` depends on `@better-compute/core` only; `provider-aws` on `core`, `vps`,
  `aws-core`.
- **Dependency rules** (`scripts/check-deps.mjs`): rules 1–4 unchanged, plus **rule 5** (Task 1):
  - only `provider-aws` and `aws` may depend on `aws-core`;
  - nothing in `packages/` depends on `aws` or `provider-aws`;
  - neither package goes in `packages/better-compute/umbrella.json`.
- **Registration:** one-line inserts only, in the root `tsconfig.json` references and the `vitest.config.ts`
  `scoped` map. `pnpm install` (`node node_modules/pnpm/bin/pnpm.mjs install --offline`) links new packages; ask the
  orchestrating session first if other agents are active.
- **Core is frozen.** This plan changes nothing in `@better-compute/core`, `vps` or `server`.
- **No provider calls inside a transaction.** No call blocks longer than 20 s (`timeoutMs` default 20 000).
  Retries: exactly one for clock skew and one for an expired session token; no other retry loops (the reconciler
  owns backoff).
- **Secrets:** account credentials are `SecretRef`s only (`field.secret()`). Never log or put in an error message:
  - an access key id;
  - a secret key or session token;
  - a signature, `Authorization` header or presigned URL;
  - an IMDS token.

  Use `redactAws()` on any string built from a response.
- **Partitions:** `aws`, `aws-cn` and `aws-us-gov` are recognised everywhere ARNs and endpoints are built (AD18).
- **Determinism:** `RunInstances` parameters for the same `idempotencyKey` and request are byte-identical across
  retries and hosts. That covers user data, gzip bytes, the MIME boundary and tag order; otherwise EC2 answers
  `IdempotentParameterMismatch`.
- **Tests:**
  - Root `tests/*.test.ts`. Inject a clock (`manualClock`) wherever time matters; never pair fixed dates with the
    wall clock.
  - The emulator is fetch-injected; no network.
- **Formatting:** only files you touched (`prettier --write <files>`, after checking HEAD's copy is prettier-clean).
- **Commits:** `node scripts/private-commit.mjs -F <new msg file> -- <paths>`. Messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **EC2 eventual consistency right after `RunInstances`.** `DescribeInstances` answers
   `InvalidInstanceID.NotFound` for a few seconds. `get` must report `pending`, never `undefined`, or vps marks the
   instance `lost`. *Test: Task 10, `get finds a just-created instance through its client token` and
   `get reports pending inside the consistency window`.*
2. **Retried create after a timeout.** The same instance comes back via the ClientToken. A retry with *different*
   parameters is `CONFLICT`, never a second instance. *Test: Task 10, `create is idempotent by client token` and
   `IdempotentParameterMismatch is CONFLICT`.*
3. **Confused deputy.** A tenant account's `assumeRoleArn` names a role in a platform AWS account, or AssumeRole
   returns an identity in another account. Both are refused, and the ExternalId never comes from config. *Test:
   Task 8, `refuses an assumeRoleArn in a platform account`, `refuses when the assumed identity is another account`,
   `external id is platform-assigned`.*
4. **User data too big for EC2.** A bootstrap payload with SSH keys crosses 16 384 bytes: it is gzipped, and refused
   with reason `user-data-too-large` if it is still too big. Packing is byte-for-byte deterministic. *Test: Task 10,
   `gzips user data over 16 KiB`, `refuses user data that stays too large`, `user data packing is deterministic`.*
5. **Credentials leaking.** No log record, error message or error `details` from any aws-core or provider-aws test
   contains the test access key id, secret, session token, IMDS token or a `Signature=`. *Test: Task 5, `never logs
   credentials`, and Task 11, `provider never logs credentials`.*

---

## File structure

**New package `packages/aws-core/`.** Copy `packages/provider-gcp/{tsconfig.json,LICENSE}`; `package.json` is
modelled on provider-gcp's with the name `@better-compute/aws-core`, version `0.1.0`, and only
`@better-compute/core` as a dependency.

| File | Responsibility |
|---|---|
| `src/index.ts` | Re-exports. |
| `src/xml.ts` | `parseXml`, `XmlElement`: a hardened, non-validating reader for AWS responses. |
| `src/query.ts` | `QueryValue`, `serializeEc2Query`, `serializeAwsQuery`. |
| `src/sigv4.ts` | `signRequest`, `presignUrl`, canonical request, signing-key cache. |
| `src/endpoints.ts` | `assertRegion`, `partitionOf`, `endpointFor`, `signingRegionFor`, `parseArn`, `formatArn`. |
| `src/errors.ts` | `parseAwsError`, `mapAwsError`, `awsErrorCodes`. |
| `src/redact.ts` | `redactAws`. |
| `src/client.ts` | `ServiceClientOptions`, `ec2Client`, `queryClient`, `jsonClient`, `restClient`, the shared `send()` with clock-skew and expired-token retries, the token-bucket limiter. |
| `src/paginate.ts` | `paginate`. |
| `src/credentials.ts` | `AwsCredentials`, `CredentialSource`, `staticCredentials`, `envCredentials`, `imdsCredentials`, `containerCredentials`, `webIdentityCredentials`, `assumeRoleCredentials`, `ambientCredentials`, `cachedCredentials`, `getCallerIdentity`. |
| `README.md` | Scope, protocols, credential chain, security rules. |

**New package `packages/provider-aws/`.** Same skeleton; depends on `core`, `vps`, `aws-core`.

| File | Responsibility |
|---|---|
| `src/index.ts` | Re-exports. |
| `src/config.ts` | `awsConfig` manifest, `AwsConfig`, `AwsProviderOptions`. |
| `src/ids.ts` | Tag keys, `parseInstanceId`, `offerId`/`parseOfferId`, `clientToken`, `tagValue`. |
| `src/account.ts` | `accountCredentials()`: the AD4 credential selection, ExternalId and identity checks. |
| `src/shapes.ts` | `InstanceTypeInfo`, `parseInstanceTypes`, `gpuModel`, `machineState`, `toMachine`, `instanceTypeCache`, `zoneCache`. |
| `src/images.ts` | `resolveImage`, `sshUserOf`, `imageAliases`. |
| `src/userdata.ts` | `packUserData`. |
| `src/compute.ts` | `class AwsCompute implements ProviderImpl`. |
| `src/provider.ts` | `awsProvider(options)`, `export const aws = awsProvider()`. |
| `src/cli.ts` | `iamPolicy`, `trustPolicy`, `awsIamPolicyCommand`, `awsTrustPolicyCommand`. |
| `README.md` | Configuration, IAM, tags, attach semantics, AWS-specific behaviors. |

**Tests (root `tests/`):**

| File | Covers |
|---|---|
| `support/aws-emulator/index.ts` | `AwsEmulator`: the fetch router, SigV4 shape check, `failNext`, request log. |
| `support/aws-emulator/xml.ts` | Response builders (`ec2Response`, `queryResponse`, `ec2Error`, `queryError`). |
| `support/aws-emulator/sts.ts` | `GetCallerIdentity`, `AssumeRole`, `AssumeRoleWithWebIdentity`. |
| `support/aws-emulator/imds.ts` | IMDSv2 token and role credentials; container credentials endpoint. |
| `support/aws-emulator/ec2.ts` | Instances, types, offerings, AZs, tags, ClientToken, eventual consistency, replace-root-volume. |
| `fixtures/aws-sigv4/**` | Vendored AWS SigV4 test-suite cases (Apache-2.0; add a NOTICE line). |
| `aws-core-xml-query.test.ts` | Task 1. |
| `aws-core-sigv4.test.ts` | Task 2. |
| `aws-core-endpoints.test.ts` | Task 3. |
| `aws-core-client.test.ts` | Task 4. |
| `aws-core-credentials.test.ts` | Task 5. |
| `provider-aws-credentials.test.ts` | Task 8. |
| `provider-aws.test.ts` | Tasks 7, 9–11 (config, offers, compute, conformance). |
| `provider-aws-attach.test.ts` | Task 12. |
| `aws-end-to-end.test.ts` | Task 13 (vps + provider-aws on PGlite + emulator). |
| `provider-aws-cli.test.ts` | Task 14. |

**Docs:**
- `packages/{aws-core,provider-aws}/README.md`
- `apps/docs/content/docs/guides/vps/providers.mdx` (new AWS section)
- `CHANGELOG.md`
- `apps/docs/content/docs/reference/roadmap.mdx`
- `PLAN.md` §16 "Provider depth"

---

## Phase A0 — `aws-core`

### Task 0: Branch, claim, baseline

**Files:**
- Modify: `.claude/coordination.md` (one claim row)

- [ ] **Step 1:** Create branch `feat/aws-a0-a1` from `main` (or confirm you are on it).
- [ ] **Step 2:** Add a claim row to `.claude/coordination.md` for:
  - `packages/aws-core/**`, `packages/provider-aws/**`;
  - `tests/support/aws-emulator/**`, `tests/fixtures/aws-sigv4/**`, `tests/aws-*.test.ts`,
    `tests/provider-aws*.test.ts`;
  - check-deps rule 5;
  - the one-line registry inserts.

  Message the orchestrator about the installs and the check-deps edit.
- [ ] **Step 3: Baseline.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-gcp.test.ts tests/gcp-end-to-end.test.ts`.
  Expected: PASS. Record any failures that already exist.
- [ ] **Step 4: Commit:** `chore: claim the AWS foundation and EC2 provider area`.

### Task 1: Package scaffold, safe XML reader, query serializers, dependency rule 5

**Files:**
- Create: `packages/aws-core/{package.json,tsconfig.json,LICENSE}`, `src/{index,xml,query}.ts`
- Modify: root `tsconfig.json` (+`{ "path": "./packages/aws-core" }`), `vitest.config.ts` `scoped`
  (+`'@better-compute/aws-core': 'aws-core/src/index.ts'`), `scripts/check-deps.mjs` (rule 5)
- Test: `tests/aws-core-xml-query.test.ts`, `tests/check-deps-aws.test.ts`

**Interfaces — Produces:**
```ts
// xml.ts
export interface XmlElement {
  readonly name: string;                          // local name, namespace prefix stripped
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;                          // concatenated, entity-decoded character data (trimmed)
  child(name: string): XmlElement | undefined;    // first direct child
  all(name: string): XmlElement[];                // every direct child with that name
  textOf(name: string): string | undefined;       // child(name)?.text
  /** `<name><item>…</item>…</name>` (EC2) or `<name><member>…</member>…</name>` (query). [] when absent. */
  items(name: string): XmlElement[];
}
export interface XmlLimits { maxBytes?: number /* 16 MiB */; maxDepth?: number /* 64 */ }
export function parseXml(text: string, limits?: XmlLimits): XmlElement;

// query.ts
export type QueryValue = string | number | boolean | undefined | readonly QueryValue[] | { readonly [key: string]: QueryValue };
export type QueryParams = { readonly [key: string]: QueryValue };
/** EC2 flattening: lists are `Name.1`, `Name.1.Sub`; booleans `true`/`false`; undefined omitted. Sorted keys. */
export function serializeEc2Query(action: string, version: string, params: QueryParams): string;
/** awsQuery flattening: lists are `Name.member.1`; maps `Name.entry.1.key`/`.value`. Sorted keys. */
export function serializeAwsQuery(action: string, version: string, params: QueryParams): string;
```
Parsing errors are `ComputeError('PROVIDER_ERROR', 'malformed XML from AWS', undefined, { reason })`. The reasons are
`doctype`, `entity`, `depth`, `size` and `syntax`.

- [ ] **Step 1: Write the failing tests** in `tests/aws-core-xml-query.test.ts`:
  - `parses an EC2 DescribeInstances response`: given a captured shape (namespace
    `http://ec2.amazonaws.com/doc/2016-11-15/`, `reservationSet/item/instancesSet/item`), assert
    `doc.items('reservationSet')[0].items('instancesSet')[0].textOf('instanceId') === 'i-0abc12345678def01'`.
  - `decodes the five predefined entities and numeric references`: `&amp;&lt;&gt;&quot;&apos;&#65;&#x42;` →
    `&<>"'AB`.
  - `refuses DOCTYPE`: a body with `<!DOCTYPE x [<!ENTITY a "b">]>` throws, and its `details.reason` is `'doctype'`.
  - `refuses depth beyond the limit`: 65 nested elements throws, reason `'depth'`.
  - `refuses documents over maxBytes`: reason `'size'`.
  - `items reads both item and member lists`.
  - `serializes EC2 lists, nested structures and booleans`:
    `serializeEc2Query('DescribeInstances','2016-11-15',{ Filter: [{ Name: 'tag:a', Value: ['x','y'] }], DryRun: false })`
    equals `Action=DescribeInstances&DryRun=false&Filter.1.Name=tag%3Aa&Filter.1.Value.1=x&Filter.1.Value.2=y&Version=2016-11-15`.
  - `serializes awsQuery members`: `{ Tags: [{ Key: 'k', Value: 'v' }] }` gives `Tags.member.1.Key=k&Tags.member.1.Value=v`.
  - `percent-encodes per RFC 3986`: space → `%20`, `~` unescaped, `*` → `%2A`.
- [ ] **Step 2: Write the failing check-deps test** in `tests/check-deps-aws.test.ts`:
  `rule 5 refuses a package that depends on aws-core`. Run `checkAwsDeps` (exported from `scripts/check-deps.mjs`)
  on a fixture manifest `{ name: '@better-compute/vps', dependencies: { '@better-compute/aws-core': 'workspace:*' } }`
  and assert one violation. `@better-compute/provider-aws` passes.
- [ ] **Step 3: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-core-xml-query.test.ts tests/check-deps-aws.test.ts`.
  Expected: FAIL (module not found).
- [ ] **Step 4: Implement.**
  - Scaffold the package and add the registry one-liners.
  - **XML reader:** a single-pass tokenizer.
    - Accept the `<?xml …?>` declaration only.
    - Refuse `<!DOCTYPE` and `<!ENTITY`. Skip comments and CDATA, keeping the CDATA text.
    - Strip namespace prefixes, and track depth.
  - **Query serializers:** recursive flatten, then sort by key, then
    `encodeURIComponent` + `!'()*` escaping.
  - **check-deps rule 5:** export `checkAwsDeps(manifests)` and call it from the existing `main` alongside
    `checkProviders`.
- [ ] **Step 5: Run to pass.** Run the same command. Expected: PASS. Then run `node scripts/check-deps.mjs`.
  Expected: exit 0.
- [ ] **Step 6: Run `pnpm install`** (`node node_modules/pnpm/bin/pnpm.mjs install --offline`), through the
  orchestrator if others are active. Expected: `@better-compute/aws-core` linked.
- [ ] **Step 7: Commit:** `aws-core: package, hardened XML reader, query serializers; check-deps rule 5`.

### Task 2: SigV4 signing and presigned URLs

**Files:**
- Create: `packages/aws-core/src/sigv4.ts`
- Create: `packages/aws-core/src/credentials.ts`. It holds only the `AwsCredentials` type in this task. Task 4 adds
  `CredentialSource`/`CredentialContext`, and Task 5 adds the sources.
- Create: `tests/fixtures/aws-sigv4/<case>/{<case>.req,<case>.creq,<case>.sts,<case>.authz}`. Vendor these cases
  from the AWS SigV4 test suite (Apache-2.0):
  - `get-vanilla`
  - `get-vanilla-query-order-key-case`
  - `get-vanilla-query-unreserved`
  - `get-header-value-trim`
  - `get-header-key-duplicate`
  - `get-utf8`
  - `get-space`
  - `normalize-path/get-relative-relative`
  - `normalize-path/get-slashes`
  - `post-x-www-form-urlencoded`
  - `post-sts-token/post-sts-header-after`

  Add a `NOTICE` line.
- Test: `tests/aws-core-sigv4.test.ts`

**Interfaces — Produces:**
```ts
// credentials.ts
export interface AwsCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; readonly expiresAt?: number }
// sigv4.ts
export interface SigningInput {
  method: string;
  url: URL;
  headers: Readonly<Record<string, string>>;      // must include host-independent headers to sign; `host` is derived from url
  body?: Uint8Array | string;                      // '' when absent
  service: string;                                 // signing name
  region: string;                                  // signing region
  credentials: AwsCredentials;
  now: number;                                     // epoch ms
  /** S3: add x-amz-content-sha256 (the payload hash, or UNSIGNED-PAYLOAD when unsignedPayload). */
  contentSha256Header?: boolean;
  unsignedPayload?: boolean;
  /** RFC 3986 path normalization and double encoding; false for S3. Default true. */
  normalizePath?: boolean;
}
/** Headers to add: authorization, x-amz-date, [x-amz-security-token], [x-amz-content-sha256]. */
export function signRequest(input: SigningInput): Record<string, string>;
export interface PresignInput extends Omit<SigningInput, 'body' | 'contentSha256Header'> { expiresInSeconds: number /* 1..604800 */ }
/** A URL carrying X-Amz-Algorithm/Credential/Date/Expires/SignedHeaders/[Security-Token]/Signature. */
export function presignUrl(input: PresignInput): string;
/** Exposed for tests: the canonical request and string to sign. */
export function canonicalRequest(input: SigningInput): { canonical: string; signedHeaders: string; payloadHash: string };
```

- [ ] **Step 1: Write the failing tests:**
  - `matches the AWS test suite: <case>` (one `it` per vendored case, through `it.each`):
    - Parse `.req` into method, URL and headers.
    - Sign with `credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }`,
      `region 'us-east-1'`, `service 'service'`, `now = Date.UTC(2015, 7, 30, 12, 36, 0)`. The suite's own fixed
      date is input data, not wall clock.
    - Assert `canonicalRequest(...).canonical === <.creq>` and `signRequest(...).authorization === <.authz>`.
  - `adds x-amz-security-token for session credentials` (`post-sts-header-after`).
  - `S3 mode does not double-encode or normalize the path`: path `/a%20b//c` keeps its slashes, and
    `x-amz-content-sha256` is present.
  - `presigned URL carries the query auth fields and expires bound`: `expiresInSeconds: 604801` throws
    `INVALID_INPUT`. The URL has `X-Amz-Expires=900` and no `authorization` header.
  - `signing-key cache is keyed by date, region and service`: two signs on the same day reuse the key (spy on
    `createHmac`).
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-core-sigv4.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** SigV4 per the AWS spec:
  - lower-cased, sorted, value-trimmed headers;
  - repeated headers joined with `,`;
  - sorted, encoded query;
  - payload SHA-256 hex;
  - scope `<yyyymmdd>/<region>/<service>/aws4_request`;
  - HMAC chain `AWS4<secret>` → date → region → service → `aws4_request`.

  Cache signing keys in a `Map` capped at 64 entries.
- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `aws-core: SigV4 signing and presigned URLs pinned to the AWS test suite`.

### Task 3: Partitions, regions, endpoints, ARNs

**Files:**
- Create: `packages/aws-core/src/endpoints.ts`
- Test: `tests/aws-core-endpoints.test.ts`

**Interfaces — Produces:**
```ts
export type AwsPartition = 'aws' | 'aws-cn' | 'aws-us-gov';
export interface PartitionInfo { partition: AwsPartition; dnsSuffix: string /* amazonaws.com | amazonaws.com.cn */ }
/** Returns the region or throws INVALID_CONFIG; the only path from config text to an endpoint host. */
export function assertRegion(region: string): string;
export function partitionOf(region: string): PartitionInfo;
export type AwsService = 'ec2' | 'sts' | 'iam' | 'ssm' | 'sqs' | 'servicequotas' | 'pricing' | 'ce' | 'organizations'
  | 'kms' | 'secretsmanager' | 's3' | 'events' | 'sns' | 'kinesis' | 'firehose' | 'acm-pca' | 'rds' | 'eks' | 'logs' | 'monitoring';
export function endpointFor(service: AwsService, region: string, options?: { fips?: boolean; dualStack?: boolean; override?: string }): URL;
/** The signing region: the region itself, or the partition's global region for global services. */
export function signingRegionFor(service: AwsService, region: string): string;
export interface Arn { partition: AwsPartition; service: string; region: string; account: string; resource: string }
export function parseArn(arn: string): Arn;                 // INVALID_INPUT on malformed
export function formatArn(arn: Arn): string;
```
The region pattern is `^(us|eu|ap|sa|ca|me|af|il|mx|cn)(-gov)?-(north|south|east|west|central|northeast|northwest|southeast|southwest)-\d{1,2}$`.

The global services and their endpoints are:

| Service | Endpoint (aws) | Signing region |
|---|---|---|
| `iam` | `iam.amazonaws.com` | `us-east-1` (aws-cn: `cn-north-1`, aws-us-gov: `us-gov-west-1`) |
| `pricing` | `api.pricing.us-east-1.amazonaws.com` | `us-east-1` |
| `ce` | `ce.us-east-1.amazonaws.com` | `us-east-1` |
| `organizations` | `organizations.us-east-1.amazonaws.com` | `us-east-1` |

STS is always regional: `sts.<region>.<suffix>`. FIPS uses `<svc>-fips.<region>…`, and dual-stack uses
`<svc>.<region>.api.aws` (EC2) or `<svc>.dualstack.<region>…`.

- [ ] **Step 1: Write the failing tests:**
  - `accepts real regions`: `us-east-1`, `eu-central-2`, `ap-southeast-5`, `us-gov-west-1`, `cn-northwest-1`,
    `il-central-1`, `mx-central-1`.
  - `refuses host injection`: `us-east-1.evil.com`, `us-east-1/`, `US-EAST-1` and `us-east-1@x` each throw
    `INVALID_CONFIG`.
  - `builds regional and global endpoints`: `endpointFor('ec2','us-east-1').host === 'ec2.us-east-1.amazonaws.com'`;
    `endpointFor('ec2','cn-north-1').host` ends with `.amazonaws.com.cn`;
    `signingRegionFor('iam','us-gov-east-1') === 'us-gov-west-1'`.
  - `override wins but only as a URL`: `override: 'http://localhost:4566'` is used verbatim; `override: 'nope'`
    throws.
  - `parses and formats ARNs in every partition`.
- [ ] **Step 2: Run to fail**, then **Step 3: implement**, then **Step 4: run to pass:**
  `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-core-endpoints.test.ts`.
- [ ] **Step 5: Commit:** `aws-core: partitions, strict regions, endpoints and ARNs`.

### Task 4: Service clients, error mapping, redaction, pagination, emulator core

**Files:**
- Create: `packages/aws-core/src/{client,errors,redact,paginate}.ts`
- Create: `tests/support/aws-emulator/{index,xml}.ts`
- Test: `tests/aws-core-client.test.ts`

**Interfaces — Consumes:** `signRequest` (Task 2), `endpointFor`/`signingRegionFor` (Task 3),
`serializeEc2Query`/`serializeAwsQuery`/`parseXml` (Task 1). `CredentialSource` is declared here as a type only;
Task 5 implements the sources.

**Interfaces — Produces:**
```ts
// credentials.ts (type only in this task)
export interface CredentialContext { signal: AbortSignal; clock: Clock }
export interface CredentialSource { readonly kind: string; credentials(context: CredentialContext): Promise<AwsCredentials>; invalidate?(): void }

// client.ts
export interface ServiceClientOptions {
  service: AwsService;
  region: string;
  credentials: CredentialSource;
  fetch?: typeof fetch;
  clock?: Clock;
  log?: Logger;
  endpoint?: string;                 // host option only (tests, VPC endpoints); never from account config
  fips?: boolean;
  rateLimit?: { perSecond: number; burst: number };   // default 20 / 40
  timeoutMs?: number;                // default 20_000
}
export interface RequestOptions { signal: AbortSignal }
export interface QueryClient { call(action: string, params: QueryParams, options: RequestOptions): Promise<XmlElement> }
export function ec2Client(options: Omit<ServiceClientOptions, 'service'>): QueryClient;           // service 'ec2', Version 2016-11-15
export function queryClient(options: ServiceClientOptions & { version: string }): QueryClient;   // awsQuery (sts, iam, sns…)
export interface JsonClient { call<T = unknown>(operation: string, body: Readonly<Record<string, unknown>>, options: RequestOptions): Promise<T> }
export function jsonClient(options: ServiceClientOptions & { jsonVersion: '1.0' | '1.1'; targetPrefix: string }): JsonClient;
export interface RestResponse { status: number; headers: Headers; body: Uint8Array }
export interface RestClient {
  request(method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD', path: string, options: RequestOptions & {
    query?: Readonly<Record<string, string>>; headers?: Readonly<Record<string, string>>;
    body?: Uint8Array | string; unsignedPayload?: boolean; protocol: 'rest-json' | 'rest-xml' }): Promise<RestResponse>;
}
export function restClient(options: ServiceClientOptions & { s3?: boolean }): RestClient;

// errors.ts
export interface AwsErrorInput { status: number; code?: string; message?: string; requestId?: string; service: string; retryAfter?: string | null }
export function mapAwsError(input: AwsErrorInput): ComputeError;
/** Reads the code/message/request id from an EC2, awsQuery, JSON, rest-json or rest-xml error body. */
export function parseAwsError(protocol: 'ec2' | 'query' | 'json' | 'rest-json' | 'rest-xml', status: number, headers: Headers, body: string): Omit<AwsErrorInput, 'service'>;

// redact.ts
export function redactAws(text: string): string;

// paginate.ts
export function paginate<T>(page: (token: string | undefined) => Promise<{ items: readonly T[]; next?: string }>, options?: { maxPages?: number /* 10_000 */ }): AsyncIterable<T>;
```

**Error mapping table** (`mapAwsError`; `details = { provider: 'aws', service, status, code, requestId }`; messages
pass through `redactAws`):

| AWS code(s) | ComputeError |
|---|---|
| `Throttling`, `ThrottlingException`, `RequestLimitExceeded`, `TooManyRequestsException`, `SlowDown`, `RequestThrottled`, `PriorRequestNotComplete`, `ProvisionedThroughputExceededException` | `RATE_LIMITED` (`retryAfterMs` from `Retry-After`, else 2000) |
| `InsufficientInstanceCapacity`, `InsufficientHostCapacity`, `InsufficientReservedInstanceCapacity`, `InsufficientCapacityOnOutpost`, `ReservationCapacityExceeded`, `InsufficientCapacity` | `CAPACITY_UNAVAILABLE` |
| `InstanceLimitExceeded`, `VcpuLimitExceeded`, `MaxSpotInstanceCountExceeded`, `VolumeLimitExceeded`, `VpcLimitExceeded`, `RulesPerSecurityGroupLimitExceeded`, `SecurityGroupsPerInstanceLimitExceeded`, `SecurityGroupsPerInterfaceLimitExceeded`, `AddressLimitExceeded`, `LimitExceededException`, `ServiceQuotaExceededException` | `QUOTA_EXCEEDED` |
| `*.NotFound`, `ResourceNotFoundException`, `NotFoundException`, `NoSuchKey`, `NoSuchBucket`, `NoSuchEntity` | `NOT_FOUND` |
| `IdempotentParameterMismatch`, `*.Duplicate`, `ResourceExistsException`, `AlreadyExistsException`, `ConflictException`, `BucketAlreadyOwnedByYou` | `CONFLICT` |
| `DependencyViolation`, `IncorrectState`, `IncorrectInstanceState`, `InvalidStateException`, `ResourceInUseException`, `OperationNotPermitted`, `InvalidInstanceState` | `INVALID_STATE` |
| `UnauthorizedOperation`, `AccessDenied`, `AccessDeniedException`, `UnauthorizedException` | `ACCESS_DENIED` |
| `OptInRequired` | `ACCESS_DENIED` (`details.reason = 'region-opt-in'`) |
| `AuthFailure`, `InvalidClientTokenId`, `SignatureDoesNotMatch`, `IncompleteSignature`, `MissingAuthenticationToken`, `ExpiredToken`, `ExpiredTokenException`, `RequestExpired`, `RequestTimeTooSkewed` | `UNAUTHENTICATED` |
| `UnsupportedOperation`, `Unsupported` | `UNSUPPORTED` |
| `*.Malformed`, `InvalidParameterValue`, `InvalidParameterCombination`, `InvalidParameter`, `ValidationError`, `ValidationException`, `MissingParameter`, `InvalidAMIID.*` (except `.NotFound`), `InvalidInput` | `INVALID_INPUT` |
| status ≥ 500, `InternalError`, `InternalFailure`, `ServiceUnavailable`, `Unavailable` | `UNAVAILABLE` |
| network failure or timeout | `UNAVAILABLE` (`reason: 'network'`/`'timeout'`) |
| anything else | `PROVIDER_ERROR` |

`*.NotFound` is matched before the `InvalidAMIID.*` rule.

**`send()` contract:**
1. Take a limiter token. Await, honoring `signal`.
2. Resolve credentials, sign with `now = clock.now() + skewOffset`, then `fetch` with
   `AbortSignal.any([signal, timeout])`.
3. On `RequestTimeTooSkewed`, `RequestExpired`, or `InvalidSignatureException` whose message contains "expired":
   set `skewOffset = Date(response.date) − clock.now()` and retry **once**.
4. On `ExpiredToken*`: call `credentials.invalidate?.()` and retry **once**.
5. Log at `debug`: `{ service, operation, status, requestId, ms }` only.

- [ ] **Step 1: Build the emulator core** (`tests/support/aws-emulator/index.ts`):
  - `class AwsEmulator { fetch: typeof fetch; requests: { service; operation; headers; body }[]; failNext(operation: string, code: string, status?: number, times?: number): void; register(host: RegExp, handler: ServiceHandler): void; skewMs: number }`.
  - Every request must carry an `authorization` of the form
    `AWS4-HMAC-SHA256 Credential=<id>/<date>/<region>/<service>/aws4_request, SignedHeaders=…, Signature=<64 hex>`
    and an `x-amz-date` within 15 min of the emulator clock (`skewMs` lets a test move that clock). Otherwise it
    answers 403 `SignatureDoesNotMatch` / 400 `RequestTimeTooSkewed`.
  - `xml.ts` exports `ec2Response(action, inner)`, `ec2Error(code, message)`, `queryResponse(action, ns, inner)`
    and `queryError(code, message, type)`.
- [ ] **Step 2: Write the failing tests** in `tests/aws-core-client.test.ts`, using a stub
  `CredentialSource { kind:'test', credentials: async () => ({ accessKeyId:'AKIATESTKEY0000000001', secretAccessKey:'testsecret' }) }`:
  - `ec2 client posts a signed form and returns the parsed body`.
  - `maps every code in the error table` (`it.each` over the table above, through `ec2Error`): assert `code` and
    `details.code`.
  - `parses JSON errors from __type and x-amzn-ErrorType`: `{"__type":"com.amazon.coral.service#ThrottlingException"}`
    → `RATE_LIMITED`.
  - `parses rest-xml errors` (an S3 `<Error><Code>NoSuchKey</Code>`).
  - `RATE_LIMITED carries retryAfterMs from Retry-After`.
  - `retries once on clock skew with the server's offset`: emulator `skewMs = 20 min`. The first request is
    refused; the second succeeds with a corrected `x-amz-date`; exactly 2 requests are made.
  - `does not retry twice on skew`: still skewed after correction gives `UNAUTHENTICATED`, 2 requests.
  - `refreshes once on ExpiredToken`: `invalidate` is called once and 2 requests are made.
  - `times out as UNAVAILABLE with reason timeout`: a fetch that never resolves, with `timeoutMs: 50`, under fake
    timers.
  - `rate limiter spaces requests`: with `{ perSecond: 2, burst: 1 }` on a manual clock, the third call waits.
  - `paginate follows tokens and stops on a repeated token`: a repeated token throws `PROVIDER_ERROR` (reason
    `pagination-loop`).
  - `redactAws removes keys, secrets, tokens and signatures`, using inputs containing `AKIA…`/`ASIA…`, `Signature=…`,
    `X-Amz-Signature=…`, `X-Amz-Security-Token=…`, `"SecretAccessKey":"…"` and `"Token":"…"`.
- [ ] **Step 3: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-core-client.test.ts`.
  Expected: FAIL.
- [ ] **Step 4: Implement** the clients, errors, redaction, pagination and limiter as specified. The JSON client sends
  `Content-Type: application/x-amz-json-<v>` and `X-Amz-Target: <targetPrefix>.<operation>`.
- [ ] **Step 5: Run to pass.** Expected: PASS.
- [ ] **Step 6: Commit:** `aws-core: protocol clients, AWS error mapping, redaction, pagination, emulator core`.

### Task 5: Credential sources and the ambient chain

**Files:**
- Create: `packages/aws-core/src/credentials.ts` (implement the sources)
- Create: `tests/support/aws-emulator/{sts,imds}.ts`
- Test: `tests/aws-core-credentials.test.ts`

**Interfaces — Consumes:** `queryClient` (Task 4) for STS.

**Interfaces — Produces:**
```ts
/** `load()` returns JSON `{ "accessKeyId", "secretAccessKey", "sessionToken"? }` (e.g. from SecretResolver.resolve). */
export function staticCredentials(load: () => Promise<string>): CredentialSource;                    // kind 'static'
export function envCredentials(env?: Readonly<Record<string, string | undefined>>): CredentialSource; // AWS_ACCESS_KEY_ID/…; kind 'env'
export function imdsCredentials(options?: { fetch?: typeof fetch; endpoint?: string /* http://169.254.169.254 */; timeoutMs?: number /* 1000 */ }): CredentialSource; // IMDSv2 only; kind 'imds'
export function containerCredentials(options?: { fetch?: typeof fetch; env?: Readonly<Record<string, string | undefined>>; readFile?: (path: string) => Promise<string> }): CredentialSource; // kind 'container'
export function webIdentityCredentials(options: { roleArn: string; sessionName: string; token: () => Promise<string>; region: string;
  fetch?: typeof fetch; endpoint?: string; durationSeconds?: number }): CredentialSource;          // kind 'web-identity'
export function assumeRoleCredentials(base: CredentialSource, options: { roleArn: string; sessionName: string; region: string;
  externalId?: string; durationSeconds?: number /* 3600 */; sourceIdentity?: string; fetch?: typeof fetch; endpoint?: string }): CredentialSource; // kind 'assume-role'
/** env → web identity (AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN) → container → IMDS; sticks to the first that works. */
export function ambientCredentials(options?: { env?: Readonly<Record<string, string | undefined>>; fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>; region?: string }): CredentialSource;              // kind 'ambient:<winner>'
/** Single-flight; refreshes `refreshBeforeMs` before expiresAt; static credentials are cached forever until invalidate(). */
export function cachedCredentials(source: CredentialSource, options?: { refreshBeforeMs?: number /* 300_000 */ }): CredentialSource;
export function getCallerIdentity(credentials: CredentialSource, options: { region: string; fetch?: typeof fetch; endpoint?: string;
  signal: AbortSignal; clock: Clock }): Promise<{ account: string; arn: string; userId: string }>;
```

**Rules:**
- `containerCredentials` uses `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` against `http://169.254.170.2`, or
  `AWS_CONTAINER_CREDENTIALS_FULL_URI`. The full URI's host must be `127.0.0.0/8`, `[::1]`, `169.254.170.2` or
  `169.254.170.23`; anything else is `INVALID_CONFIG` (SSRF).
- The authorization header comes from `AWS_CONTAINER_AUTHORIZATION_TOKEN` or the file at
  `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`; the token itself must not contain `\r` or `\n`.
- IMDS is IMDSv2 only: `PUT /latest/api/token` (`X-aws-ec2-metadata-token-ttl-seconds: 21600`), then the role list,
  then the role JSON. A 403 or 404 on the token is `UNAUTHENTICATED` (reason `imds-unavailable`); there is no
  IMDSv1 fallback.
- Session names must match `[\w+=,.@-]{2,64}`.
- Errors never include response bodies from credential endpoints.

- [ ] **Step 1: Emulator.**
  - `sts.ts`: `GetCallerIdentity` (by access key id → configured `{account, arn}`), `AssumeRole` (it checks
    `ExternalId` against the role's configured external id, refuses `AccessDenied` otherwise, and mints `ASIA…`
    keys with `Expiration` = emulator clock + duration), and `AssumeRoleWithWebIdentity` (accepts configured
    tokens; the request is **unsigned**).
  - `imds.ts`: IMDSv2 token, role credentials, and the container endpoint with an authorization check.
  - `index.ts`: `emu.ambient: CredentialSource` yields the platform account's (`111111111111`) keys. Later tasks pass
    it as `awsProvider({ credentials: emu.ambient })`.
- [ ] **Step 2: Write the failing tests:**
  - `static credentials parse the secret JSON and refuse missing fields` (`INVALID_CONFIG`; the message names the
    field, not the value).
  - `env credentials read the three variables`.
  - `IMDS requires a token and never falls back to v1`: an emulator with IMDSv1-only gives `UNAUTHENTICATED`.
  - `container credentials refuse a non-allowed full URI`: `http://10.0.0.5/creds` gives `INVALID_CONFIG`; the EKS
    Pod Identity URI `http://169.254.170.23/v1/credentials` plus a token file works.
  - `web identity exchanges the token without signing`.
  - `assume role passes the external id and session name`.
  - `ambient chain picks web identity before container before IMDS and sticks to the winner`.
  - `cache is single-flight and refreshes before expiry`: 10 concurrent calls give 1 STS request; at
    `expiresAt − 4 min` there is a new request.
  - `getCallerIdentity returns the account`.
  - `never logs credentials`: run every test above with a recording logger. Join all log records, every thrown
    error's `message`, and its `JSON.stringify(details)`. Assert none contains `AKIATESTKEY`, `ASIA`, `testsecret`,
    the IMDS token, the session token, or `Signature=`.
- [ ] **Step 3: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-core-credentials.test.ts`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to pass.** Expected: PASS.
- [ ] **Step 6: Commit:** `aws-core: credential sources, ambient chain and cache`.

### Task 6: A0 exit gate

**Files:**
- Create: `packages/aws-core/README.md`
- Modify: `generated/api-surface.json` (via the script)

- [ ] **Step 1:** Write the README: purpose (AD2), protocols supported and not supported, the credential chain and
  the F1 rule, the security rules (redaction, region regex, container URI allow-list), testing with the emulator.
- [ ] **Step 2:** Run `node node_modules/typescript/bin/tsc -b packages/aws-core`. Expected: exit 0.
- [ ] **Step 3:** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-core-*.test.ts tests/check-deps-aws.test.ts`.
  Expected: all PASS.
- [ ] **Step 4:** Run `node scripts/check-deps.mjs`, then `node scripts/api-surface.mjs --update`, and check that
  only `aws-core` entries were added.
- [ ] **Step 5: Commit:** `aws-core: README and API surface`.

---

## Phase A1 — EC2 provider

### Task 7: provider-aws scaffold, config manifest, ids

**Files:**
- Create: `packages/provider-aws/{package.json,tsconfig.json,LICENSE}`, `src/{index,config,ids}.ts`
- Modify: root `tsconfig.json` (+`{ "path": "./packages/provider-aws" }`), `vitest.config.ts` `scoped`
  (+`'@better-compute/provider-aws': 'provider-aws/src/index.ts'`)
- Test: `tests/provider-aws.test.ts` (section `config & ids`)

**Interfaces — Produces:**
```ts
// config.ts — awsConfig = manifest({...}); each field's .describe() text is user-facing documentation.
export interface AwsConfig {
  region: string;                          // field.string() — assertRegion
  zones: string[];                         // field.list(field.string(), { min: 1 }) — AZ names; each `${region}[a-z]` or a Local Zone `${region}-<group>-<n>[a-z]`
  credentials?: SecretRef;                 // field.secret().optional() — JSON { accessKeyId, secretAccessKey }
  assumeRoleArn?: string;                  // field.string().optional() — arn:<partition>:iam::<12 digits>:role/<path+name>
  subnetId?: string;                       // field.string().optional() — default subnet for create (else the AZ's default subnet)
  securityGroupIds?: string[];             // field.list(field.string()).optional() — default SGs for create
  instanceProfile?: string;                // field.string().optional() — instance profile ARN passed to RunInstances
  rootVolumeGiB: number;                   // field.int({ min: 8, max: 16384 }).default(100)
  rootVolumeType: 'gp3' | 'gp2' | 'io2';   // field.option(['gp3', 'gp2', 'io2']).default('gp3')
  kmsKeyId?: string;                       // field.string().optional() — EBS encryption key (else the account default)
  metadataHopLimit: number;                // field.int({ min: 1, max: 64 }).default(1)
  associatePublicIp: boolean;              // field.boolean().default(true)
  discoverTag?: string;                    // field.string().optional() — "key=value": discover() yields only matching instances
}
export interface AwsProviderOptions {
  fetch?: typeof fetch;
  endpoints?: Partial<Record<'ec2' | 'sts', string>>;   // tests and VPC endpoints
  /** Ambient identity for platform accounts (default ambientCredentials()). */
  credentials?: CredentialSource;
  /** ExternalId prefix: `${externalIdPrefix}:${providerAccountId}` (default 'better-compute'). */
  externalIdPrefix?: string;
  /** AWS account ids a tenant account's assumeRoleArn may never name (the ambient identity's own account is always included). */
  platformAccounts?: readonly string[];
  rateLimit?: { perSecond: number; burst: number };
  /** How long `get` treats a just-created, not-yet-visible instance as pending (default 120_000). */
  consistencyWindowMs?: number;
}

// ids.ts
export const tags = { managed: 'better-compute:managed', instance: 'better-compute:instance', tenant: 'better-compute:tenant',
  pool: 'better-compute:pool', name: 'Name' } as const;
export function parseInstanceId(id: string): string;            // /^i-[0-9a-f]{8,17}$/ else INVALID_INPUT
export interface ParsedOffer { zone: string; instanceType: string; reservation?: string; market: 'on-demand' | 'spot' }
export function offerId(offer: ParsedOffer): string;             // `${zone}/${type}` + (`@${cr}`) + (':spot')
export function parseOfferId(id: string): ParsedOffer;           // INVALID_INPUT on anything else; cr must match /^cr-[0-9a-f]{8,17}$/
export function clientToken(key: string): string;                // createHash('sha256').update(key).digest('hex').slice(0, 64)
export function tagValue(value: string): string;                 // keeps [\p{L}\p{N} _.:/=+\-@], truncates to 256
```

Two layers of validation:
- `awsConfig.parse` checks field shapes; a failure throws `INVALID_INPUT`, with issues in `details.issues`.
- `awsProvider().create(config, context)` (Task 10 `provider.ts`) runs the semantic checks and throws
  `INVALID_CONFIG`. vps `checkClient` therefore reports them at `providerAccounts.create`. The checks are
  `assertRegion(region)`, every zone matching the region, and the `assumeRoleArn` ARN shape and partition matching
  the region's partition.

Export them now as `validateAwsConfig(config: AwsConfig): void` in `config.ts`, so Task 10 only calls it.

- [ ] **Step 1: Write the failing tests:**
  - `config parses with defaults`: `{ region: 'us-east-1', zones: ['us-east-1a'] }` gives `rootVolumeGiB 100`,
    `gp3`, `metadataHopLimit 1`, `associatePublicIp true`.
  - `semantic validation refuses foreign zones and bad regions`: `validateAwsConfig` with `zones: ['us-west-2a']`
    and `region: 'us-east-1'` gives `INVALID_CONFIG`, and the message names the zone. `region: 'us-east-1.evil'`
    gives `INVALID_CONFIG`. The Local Zone `us-west-2-lax-1a` with `region: 'us-west-2'` passes.
  - `config refuses a malformed assumeRoleArn`: `INVALID_CONFIG`; an `arn:aws-cn:` role with a commercial region is
    refused too.
  - `config redacts nothing but credentials`: `awsConfig.redact(cfg)` hides `credentials` only.
  - `offer ids round-trip`: `us-east-1a/p5.48xlarge`, `us-east-1a/p5.48xlarge@cr-0123456789abcdef0`,
    `us-east-1b/g6.xlarge:spot`. `us-east-1a/` and `a/b@x` give `INVALID_INPUT`.
  - `client token is stable and 64 hex chars`.
  - `instance ids are validated`.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws.test.ts -t "config & ids"`.
- [ ] **Step 3: Implement**, add the registry one-liners, then run `pnpm install --offline` (through the orchestrator
  if others are active).
- [ ] **Step 4: Run to pass**, then `node scripts/check-deps.mjs`. Expected: exit 0.
- [ ] **Step 5: Commit:** `provider-aws: package, config manifest and ids`.

### Task 8: Account credentials (AD4: F1, ExternalId, confused-deputy guards)

**Files:**
- Create: `packages/provider-aws/src/account.ts`
- Test: `tests/provider-aws-credentials.test.ts`

**Interfaces — Consumes:** `staticCredentials`, `assumeRoleCredentials`, `ambientCredentials`, `cachedCredentials`,
`getCallerIdentity`, `parseArn` (A0).

**Interfaces — Produces:**
```ts
export interface AccountCredentials {
  /** Credentials for EC2 calls (already cached). */
  source: CredentialSource;
  /** The ExternalId sent on AssumeRole, when a role is assumed. */
  externalId?: string;
  /** Runs once before the first EC2 call; memoized. Throws ACCESS_DENIED on a guard failure. */
  verify(context: CredentialContext): Promise<{ account: string }>;
}
export function accountCredentials(config: AwsConfig, context: ProviderContext, options: AwsProviderOptions): AccountCredentials;
```

**Rules (in order):**

| Account | `credentials` | `assumeRoleArn` | Result |
|---|---|---|---|
| platform | set | – | static |
| platform | – | – | `options.credentials ?? ambientCredentials()` |
| platform | any | set | AssumeRole from the above, ExternalId `${prefix}:${account.id}` |
| tenant | set | – | static |
| tenant | set | set | AssumeRole from static, ExternalId |
| tenant | – | set | AssumeRole **from the platform ambient identity**, ExternalId **required** |
| tenant | – | – | `INVALID_CONFIG`, reason `ambientCredentials` (F1) |

**`verify()` checks:**
- **Synchronous** (at `accountCredentials`): a role ARN whose account is in `options.platformAccounts` fails with
  `INVALID_CONFIG`, reason `platform-account-role`. vps `checkClient` therefore surfaces it at
  `providerAccounts.create`.
- **On first use, for a tenant role hop:**
  - `getCallerIdentity(base)`: if the role's account equals the base identity's account, fail `ACCESS_DENIED`, reason
    `platform-account-role`.
  - After AssumeRole, `getCallerIdentity(assumed)`: if the account is not the role ARN's account, fail
    `ACCESS_DENIED`, reason `assumed-identity-mismatch`.
- **Missing account context:** if `context.account` is undefined and a role is configured, fail `INVALID_CONFIG`,
  reason `account-context-required`.
- **Session names:** `bc-${account.id}` truncated to 64 characters.

- [ ] **Step 1: Write the failing tests** (STS emulator with accounts `111111111111` platform, `222222222222` tenant
  A, `333333333333` tenant B):
  - `platform account without credentials uses the ambient source`.
  - `tenant account without credentials or role is refused (F1)`.
  - `external id is platform-assigned`: the manifest has no `externalId` field (assert
    `'externalId' in awsConfig.fields === false`), and the STS emulator saw `ExternalId === 'better-compute:pa_tenantA'`.
  - `refuses an assumeRoleArn in a platform account`: two cases.
    - `platformAccounts: ['111111111111']` with role `arn:aws:iam::111111111111:role/admin` gives `INVALID_CONFIG`
      at construction.
    - With `platformAccounts` empty, the same role gives `ACCESS_DENIED` at `verify` (the base identity is
      `111111111111`).
  - `refuses when the assumed identity is another account`: the emulator's AssumeRole for B's ARN returns
    credentials whose `GetCallerIdentity` is `444444444444`. Result: `ACCESS_DENIED`, reason
    `assumed-identity-mismatch`.
  - `tenant A cannot use tenant B's role`: B's role in the emulator requires ExternalId
    `better-compute:pa_tenantB`. Account `pa_tenantA` configured with B's ARN gets `ACCESS_DENIED` from STS (mapped).
  - `verify runs once`: 3 EC2-path calls give 1 `GetCallerIdentity` pair.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws-credentials.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `provider-aws: account credentials with F1, platform-assigned ExternalId and identity checks`.

### Task 9: Instance shapes and `listOffers`

**Files:**
- Create: `packages/provider-aws/src/shapes.ts`
- Create: `tests/support/aws-emulator/ec2.ts` (the first part: `DescribeInstanceTypes`,
  `DescribeInstanceTypeOfferings`, `DescribeAvailabilityZones`)
- Test: `tests/provider-aws.test.ts` (section `offers`)

**Interfaces — Produces:**
```ts
export interface InstanceTypeInfo {
  type: string; vcpu: number; memoryGiB: number; arch: readonly ('x86_64' | 'arm64')[];
  gpus?: { model: string; count: number }; bareMetal: boolean; instanceStorageGiB?: number;
  efa: boolean; maxEfaInterfaces?: number;
}
export function parseInstanceTypes(items: readonly XmlElement[]): InstanceTypeInfo[];
/** NVIDIA/AMD names from GpuInfo → pool model strings; unknown → 'other'. */
export function gpuModel(manufacturer: string, name: string): string;
export interface InstanceTypeCache { get(types: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, InstanceTypeInfo>> }
export function instanceTypeCache(ec2: QueryClient, options: { clock: Clock; ttlMs?: number /* 86_400_000 */ }): InstanceTypeCache;   // batches of 100
export interface ZoneCache { zoneId(zone: string, signal: AbortSignal): Promise<string | undefined> }
export function zoneCache(ec2: QueryClient, options: { clock: Clock; ttlMs?: number /* 3_600_000 */ }): ZoneCache;
```

**GPU map** (`gpuModel`; manufacturer `NVIDIA` unless noted). These are inputs from `DescribeInstanceTypes` `GpuInfo`
and use the same output taxonomy as `provider-gcp/src/shapes.ts:60`. **(verify)** with the capacity owner whether
the extra names are acceptable pool strings; if not, map them to `'other'`.

| `GpuInfo.Name` | model |
|---|---|
| `H100` | `H100` |
| `H200` | `H200` |
| `B200` | `B200` |
| `A100` | `A100` |
| `L4` | `L4` |
| `L40S` | `L40S` |
| `A10G` | `A10G` |
| `T4`, `T4g` | `T4` |
| anything else | `other` |

**`listOffers(query)` algorithm:**
1. If `query.region` is set and is not `config.region`, return `[]`. If `query.kind === 'metal'`, return `[]` (A1
   provides `vps` only).
2. Page `DescribeInstanceTypeOfferings` (`LocationType=availability-zone`, `Filter location=<zones>`,
   `MaxResults=1000`) to get the (zone, type) pairs.
3. Load `InstanceTypeInfo` for the distinct types through the cache. Skip bare-metal types.
4. Emit `{ id: offerId({zone, instanceType, market:'on-demand'}), kind:'vps', region, vcpu, memoryGiB, diskGiB:
   config.rootVolumeGiB, gpus, available: true }`, then filter by `gpuModel`, `minGpus`, `minVcpu` and
   `minMemoryGiB`.

The (zone, type) offerings are cached for 1 h.

- [ ] **Step 1: Emulator:** the defaults are zones `us-east-1a/b/c` (ids `use1-az1/2/4`) and types `t3.micro`,
  `m7i.large`, `g6.xlarge` (1×L4), `p5.48xlarge` (8×H100, EFA, 32 interfaces), `m7g.large` (arm64) and
  `c7i.metal-24xl`. `p5.48xlarge` is offered only in `us-east-1a`. `MaxResults` is honored with a small default
  page size of 2.
- [ ] **Step 2: Write the failing tests:**
  - `parses vcpu, memory, gpus, arch, metal and EFA`.
  - `lists offers in configured zones only`: p5 appears only as `us-east-1a/p5.48xlarge`.
  - `filters by gpu model and count`: `{ gpuModel: 'H100', minGpus: 8 }` gives exactly 1 offer.
  - `skips bare metal`.
  - `another region yields nothing`.
  - `caches instance types for a day`: two `listOffers` calls make 1 `DescribeInstanceTypes`; after the clock
    advances 25 h, 2.
  - `zone ids resolve from DescribeAvailabilityZones`.
- [ ] **Step 3: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws.test.ts -t offers`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run to pass.**
- [ ] **Step 6: Commit:** `provider-aws: instance shapes and offers`.

### Task 10: `create`, `get`, `delete` (images, user data, eventual consistency, tag guard)

**Files:**
- Create: `packages/provider-aws/src/{images,userdata,compute,provider}.ts`
- Modify: `tests/support/aws-emulator/ec2.ts`, adding:
  - `RunInstances` with ClientToken dedupe and `IdempotentParameterMismatch` on different parameters;
  - `DescribeInstances` with `InstanceId.N`, the filters `tag:*`, `tag-key`, `client-token` and
    `instance-state-name`, plus `MaxResults`/`NextToken`;
  - `TerminateInstances`;
  - the knobs `notFoundReads` (eventual consistency), `asyncFailure(id, stateReasonCode)`, `tick()` (state
    transitions) and `disableApiTermination(id)`.
- Test: `tests/provider-aws.test.ts` (section `compute`)

**Interfaces — Consumes:** `accountCredentials` (Task 8), `instanceTypeCache`/`zoneCache` (Task 9), `ec2Client` (A0).

**Interfaces — Produces:**
```ts
// images.ts
export const imageAliases: Readonly<Record<string, (arch: 'x86_64' | 'arm64') => string>>;   // see table
/** `ami-…` and `resolve:ssm:…` pass through; aliases expand per arch; anything else is INVALID_INPUT. */
export function resolveImage(image: ImageRef, arch: 'x86_64' | 'arm64'): string;
export function sshUserOf(image: ImageRef): string;   // ubuntu-* → 'ubuntu', al2023/eks-* → 'ec2-user', dlami-* → 'ubuntu', else 'ec2-user'

// userdata.ts
/** MIME multipart only when sshKeys are given; gzip when > 16_384 bytes; INVALID_INPUT reason 'user-data-too-large' after. */
export function packUserData(userData: string, sshKeys?: readonly string[]): { base64: string; gzipped: boolean; bytes: number };

// provider.ts
export function awsProvider(options?: AwsProviderOptions): ProviderDefinition<AwsConfig>;   // id 'aws', version '0.1.0', provides ['vps']
export const aws: ProviderDefinition<AwsConfig>;

// compute.ts
export class AwsCompute implements ProviderImpl {
  constructor(config: AwsConfig, context: ProviderContext, options: AwsProviderOptions, deps: {
    ec2: QueryClient; account: AccountCredentials; types: InstanceTypeCache; zones: ZoneCache });
  listOffers(query: OfferQuery): Promise<Offer[]>;
  create(request: { offerId: string; image: ImageRef; userData: string; name: string; network?: NetworkRef;
    labels?: Readonly<Record<string, string>>; sshKeys?: readonly string[] }, context: CallContext): Promise<ExternalMachine>;
  get(id: string, context: CallContext): Promise<ExternalMachine | undefined>;
  delete(id: string, context: CallContext): Promise<void>;
}
// shapes.ts additions
export function machineState(state: string | undefined): ExternalMachine['state'];
export function toMachine(instance: XmlElement, info: { region: string; types: ReadonlyMap<string, InstanceTypeInfo>; zoneIds: ReadonlyMap<string, string> }): ExternalMachine;
```

**Image aliases** (every SSM path **(verify)**, program Appendix C):

| Alias | x86_64 / arm64 parameter (prefixed `resolve:ssm:`) |
|---|---|
| `ubuntu-24.04` | `/aws/service/canonical/ubuntu/server/24.04/stable/current/{amd64\|arm64}/hvm/ebs-gp3/ami-id` |
| `ubuntu-22.04` | `/aws/service/canonical/ubuntu/server/22.04/stable/current/{amd64\|arm64}/hvm/ebs-gp2/ami-id` |
| `al2023` | `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-{x86_64\|arm64}` |
| `dlami-gpu` | `/aws/service/deeplearning/ami/{x86_64\|arm64}/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id` |

**State map** (`machineState`):

| EC2 state | `ExternalMachine.state` |
|---|---|
| `pending` | `pending` |
| `running` | `running` |
| `stopping` | `stopped` (as GCP's `STOPPING`) |
| `stopped` | `stopped` |
| `shutting-down` | `deleting` |
| `terminated` | `deleted` |
| other | `unknown` |

**`toMachine`** sets:
- `id` (`instanceId`), `name` (from the `Name` tag), `state`;
- `offerId` (`<az>/<type>`, plus `@<capacityReservationId>`, plus `:spot` when `instanceLifecycle=spot`);
- `region`, `zone`, `machineType`, `vcpu`, `memoryGiB`, `gpus`;
- `addresses` (private, public, IPv6);
- `networks` (one per ENI: `vpcId`, `subnetId`, private address, public address, and the names of SGs that start
  with `bc-` as `tags`);
- `labels` (all tags, plus `topology.aws/zone-id`);
- `reservation` (`capacityReservationId`), `createdAt` (`launchTime`), `claimedBy` (the `better-compute:instance`
  tag).

**`create` (one `RunInstances`):**
1. `parseOfferId(request.offerId)`. A `reservation` or `:spot` offer is `UNSUPPORTED` in A1 (reason `phase-a3`).
   The zone must be in `config.zones` (`INVALID_INPUT`).
2. Look up the type's `arch[0]` from the cache, then `ImageId = resolveImage(request.image, arch)`.
3. Build the parameters:
   - `ClientToken = clientToken(context.idempotencyKey)`
   - `MinCount = MaxCount = 1`, `InstanceType`, `Placement.AvailabilityZone`
   - `UserData = packUserData(request.userData, request.sshKeys).base64`
   - `MetadataOptions = { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: config.metadataHopLimit, InstanceMetadataTags: 'disabled' }`
   - `BlockDeviceMapping.1 = { DeviceName: <root device name>, Ebs: { VolumeSize: rootVolumeGiB, VolumeType: rootVolumeType, Encrypted: true, KmsKeyId?: kmsKeyId, DeleteOnTermination: true } }`.
     The root device name comes from one of three sources:
     - **An alias:** the alias table's fixed name (`/dev/sda1` for Ubuntu and DLAMI, `/dev/xvda` for AL2023 and
       EKS).
     - **A raw `ami-…`:** `RootDeviceName` from `DescribeImages ImageId.1=<ami>`, cached 24 h. `ec2:DescribeImages`
       is in the IAM policy.
     - **A raw `resolve:ssm:…`:** the root device cannot be known without an SSM read, so the mapping is
       **omitted**. The volume then gets the AMI's size and type, and is encrypted only if the account has EBS
       encryption by default. The README documents this, and `create` logs it once per image at `info`.

     **(verify)** the alias device names in the live suite.
   - `NetworkInterface.1 = { DeviceIndex: 0, SubnetId: request.network?.subnet ?? config.subnetId, Groups: config.securityGroupIds, AssociatePublicIpAddress: config.associatePublicIp }`
     only when a subnet is known; otherwise use top-level `SecurityGroupId.N`.
   - `IamInstanceProfile.Arn = config.instanceProfile`
   - `InstanceInitiatedShutdownBehavior = 'stop'`
   - `TagSpecification.1` (instance) and `.2` (volume), with sorted tags: `Name = tagValue(request.name)`,
     `better-compute:managed = 'true'`, `better-compute:instance = tagValue(context.idempotencyKey)`, and every
     `request.labels` entry renamed `better-compute:<key>`.
4. Record `#created.set(instanceId, clock.now())` and return `toMachine(…)` (state `pending`). Do not wait.
5. On `IdempotentParameterMismatch`, throw `CONFLICT`.

**`get`:**
1. `parseInstanceId(id)`; a malformed id returns `undefined`.
2. `DescribeInstances InstanceId.1=id`.
3. On `NOT_FOUND`, run `DescribeInstances Filter client-token=clientToken(context.idempotencyKey)`. If an instance
   with this id is found, map it.
4. If still not found and `clock.now() − #created.get(id) < consistencyWindowMs`, return
   `{ id, state: 'pending', addresses: [] }`. Otherwise return `undefined`.
5. A `terminated` instance with `stateReason.code` set:

   | `stateReason.code` | Result |
   |---|---|
   | `Server.InsufficientInstanceCapacity` | throw `CAPACITY_UNAVAILABLE` (`details.reason` = the code) |
   | `Client.VolumeLimitExceeded` | throw `QUOTA_EXCEEDED` |
   | `Server.InternalError` | `state: 'error'` |
   | anything else | `state: 'deleted'` |

   vps already fails a create permanently on the first two (`lifecycle.ts:610-628`).

**`delete`:**
1. `get`-like read. Not found means success.
2. The instance needs `better-compute:managed=true`, else `INVALID_STATE` (reason `not-managed`).
3. Call `TerminateInstances`. `OperationNotPermitted` gives `INVALID_STATE` (reason `termination-protected`).
4. `shutting-down` and `terminated` count as success.

- [ ] **Step 1: Write the failing tests:**
  - `create sends a hardened RunInstances`. The recorded params include:
    - `MetadataOptions.HttpTokens=required` and `HttpPutResponseHopLimit=1`;
    - `BlockDeviceMapping.1.Ebs.Encrypted=true`;
    - `ClientToken` = `clientToken('ins_test1')` (the context idempotencyKey);
    - `ImageId=resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`;
    - instance and volume `TagSpecification`s with `better-compute:managed=true` and
      `better-compute:instance=ins_test1`.
  - `arm64 types get arm64 images`: `m7g.large` resolves the arm64 parameter.
  - `create is idempotent by client token`: create twice with the same context gives the same id, and the emulator
    has 1 instance.
  - `IdempotentParameterMismatch is CONFLICT`: the same key with a different offer.
  - `create refuses zones outside config` and `reservation and spot offers are UNSUPPORTED until A3`.
  - `user data packing is deterministic`: `packUserData(x, keys)` twice is byte-identical, the gzip header MTIME is 0
    and the OS byte is fixed to `0xff`, and the boundary derives from the content hash.
  - `gzips user data over 16 KiB` (`gzipped: true`, decompresses to the input) and `refuses user data that stays too
    large` (random 40 KiB gives `INVALID_INPUT` with reason `user-data-too-large`).
  - `ssh keys are delivered as a cloud-config part`: the decoded multipart contains `ssh_authorized_keys:` and the
    original payload part.
  - `get finds a just-created instance through its client token`: `notFoundReads: 1` on `InstanceId` lookups only.
    The result is `pending` and the `client-token` filter request was made.
  - `get reports pending inside the consistency window`: `notFoundReads: 3` on both lookups. At +60 s it is
    `pending`; at +121 s it is `undefined`.
  - `async stockout surfaces through get`: `asyncFailure(id, 'Server.InsufficientInstanceCapacity')` gives
    `CAPACITY_UNAVAILABLE`.
  - `maps states` (an `it.each` over the state table).
  - `delete refuses unmanaged instances`, `delete treats missing instances as deleted`, `delete reports termination
    protection as INVALID_STATE`.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws.test.ts -t compute`.
- [ ] **Step 3: Implement.** In `provider.ts`:
  - `create(config, context)`: `validateAwsConfig` (Task 7), `accountCredentials`, build `ec2Client` (with
    `options.endpoints?.ec2`), the caches, and `new AwsCompute`.
  - `capabilities: ['power','reinstall','list','discover','claim']`.

  Every EC2 call awaits `account.verify()` first (memoized).
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `provider-aws: create, get and delete with ClientToken idempotency, hardened defaults and eventual-consistency handling`.

### Task 11: `power`, `reinstall`, `list`, and the conformance suite

**Files:**
- Modify: `packages/provider-aws/src/compute.ts`
- Modify: `tests/support/aws-emulator/ec2.ts` (`StartInstances`, `StopInstances` with `Force`, `RebootInstances`,
  `SendDiagnosticInterrupt`, `CreateReplaceRootVolumeTask`)
- Test: `tests/provider-aws.test.ts` (sections `power & reinstall` and `conformance`)

**Interfaces — Produces** (methods on `AwsCompute`):
```ts
power(id: string, action: PowerAction, context: CallContext): Promise<void>;
reinstall(id: string, image: ImageRef, context: CallContext): Promise<void>;
list(context: CallContext): AsyncIterable<ExternalMachine>;
```

**Power map:**

| `PowerAction` | EC2 call |
|---|---|
| `on` | `StartInstances` |
| `graceful-off` | `StopInstances` |
| `off` | `StopInstances Force=true` |
| `reset`, `cycle`, `graceful-restart` | `RebootInstances` |
| `nmi` | `SendDiagnosticInterrupt` |

Any other action is `UNSUPPORTED`. `power` and `reinstall` require the `better-compute:instance` tag (else
`INVALID_STATE`, reason `not-claimed`), as GCP does.

**`reinstall`:** `CreateReplaceRootVolumeTask { InstanceId, ImageId: resolveImage(image, arch), DeleteReplacedRootVolume: true, ClientToken: clientToken(`${key}:reinstall:${image}`) }`.
It does not block.

**`list`:** `DescribeInstances` with `Filter tag:better-compute:managed=true` and
`instance-state-name ∈ {pending,running,stopping,stopped,shutting-down}`, `MaxResults=1000`, paged.

- [ ] **Step 1: Write the failing tests:**
  - `maps power actions` (`it.each`).
  - `power refuses an unclaimed instance`.
  - `nmi sends a diagnostic interrupt`.
  - `reinstall replaces the root volume with the resolved image`.
  - `list pages managed instances only`.
  - `passes every case of the ProviderImpl contract`: `runConformance(providerConformanceCases(), { provider: awsProvider({ fetch: emu.fetch, credentials: emu.ambient }), config, offerId: 'us-east-1a/t3.micro', image: 'ubuntu-24.04', context: { account: platformAccount, clock, secrets }, attachable: 'i-0attach0000000001', prefix: 'aws-conf' })`.
    Every case passes or is skipped, and `claim`/`discover` are **not** skipped (Task 12 makes them pass; until
    then they fail, as they should).
  - `provider never logs credentials`: the sweep from Task 5, run over this whole file's logs and errors.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws.test.ts -t "power|conformance|never logs"`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass**, except the two attach conformance cases (Task 12).
- [ ] **Step 5: Commit:** `provider-aws: power, reinstall via replace-root-volume, list; conformance`.

### Task 12: Attach primitives (`discover`, `claim`, `release`)

**Files:**
- Modify: `packages/provider-aws/src/compute.ts`
- Modify: `tests/support/aws-emulator/ec2.ts` (`CreateTags`, `DeleteTags`, `addInstance(…)` for foreign instances)
- Test: `tests/provider-aws-attach.test.ts`

**Interfaces — Produces** (on `AwsCompute`):
```ts
discover(context: CallContext): AsyncIterable<ExternalMachine>;   // all non-terminated instances, filtered by discoverTag
claim(id: string, instanceId: string, context: CallContext, options?: { managed?: boolean }): Promise<ExternalMachine>;
release(id: string, instanceId: string, context: CallContext): Promise<void>;
```

**`claim` algorithm.** EC2 tags have no compare-and-swap; the vps partial unique index on
`(provider_account_id, external_id)` referees between control planes (GCP D5), and the re-read narrows the window
between two writers.
1. Read the instance. Missing → `NOT_FOUND`.
2. If the `better-compute:instance` tag is set and not equal to `instanceId`, throw `CONFLICT`.
3. `CreateTags { better-compute:instance: instanceId, [better-compute:managed: 'true' if options.managed] }`.
4. Read it again. If the tag is no longer `instanceId`, throw `CONFLICT` (lost race).
5. Return `toMachine`.

**`release`:** read the instance; if it is missing, return. If the tag equals `instanceId`, `DeleteTags` both
`better-compute:instance` and `better-compute:managed`. Otherwise do nothing.

**`discover`:** like `list`, but without the `managed` filter. With `discoverTag` `k=v`, it adds `Filter tag:k=v`.

- [ ] **Step 1: Write the failing tests:**
  - `discover yields foreign instances and honors discoverTag`.
  - `claim writes the ownership tag and returns claimedBy`.
  - `claim with managed hands deletion to better-compute`: after claim with `managed`, `delete` terminates.
  - `claim refuses an instance another instance holds` (`CONFLICT`).
  - `claim detects a lost race on re-read`: the emulator's `beforeAction('CreateTags')` hook writes another owner
    after our write lands. Result: `CONFLICT`.
  - `release removes only its own tag`.
  - `release of a vanished instance succeeds`.
  - Re-run the conformance suite from Task 11: `claim then release round-trips the label` and `discover yields the
    attachable machine` now pass.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws-attach.test.ts tests/provider-aws.test.ts -t "attach|conformance"`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `provider-aws: discover, claim and release (attach primitives)`.

### Task 13: End to end through vps on PGlite

**Files:**
- Test: `tests/aws-end-to-end.test.ts` (modelled on `tests/gcp-end-to-end.test.ts`)

**Interfaces — Consumes:**
- `vps({ providers: [awsProvider({ fetch, credentials, endpoints })] })`;
- `providerAccounts.create`, `pools.create({ class: 'provider', agent: 'none', providerAccountId })`, flavors with
  `offerId`;
- `instances.create/attach/detach/delete/reboot`;
- `compute.jobs['vps.discovery'].tick()`, the provider reconciler, `manualClock` + `useSimClock`.

- [ ] **Step 1: Write the failing tests:**
  - `a tenant creates an EC2 instance through a provider pool`: create → the reconciler runs → the instance row has
    `external_id` `i-…` and becomes `active` after the emulator `tick()` gives `running`.
  - `the instance survives EC2 eventual consistency`: `notFoundReads: 2` → the reconciler never marks it `lost`.
  - `discovery lists account instances and attach adopts one without recreating it`: `addInstance` foreign →
    discovery tick → `providerAccounts.machines` lists it → `instances.attach` → reconcile → the tag is written and
    there is no `RunInstances` in `emu.requests`.
  - `delete of an attached instance detaches by default and leaves it running`.
  - `a tenant account without a role is refused at providerAccounts.create` (F1 via `checkClient`).
  - `async stockout fails the instance permanently with CAPACITY_UNAVAILABLE`.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-end-to-end.test.ts`.
- [ ] **Step 3: Fix anything the tests expose,** in `provider-aws` only. If a vps change looks necessary, stop and
  raise it with the orchestrator: this plan promises none.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `test: EC2 end to end through provider pools, discovery and attach`.

### Task 14: CLI policy generators (ABAC IAM policy, cross-account trust policy)

**Files:**
- Create: `packages/provider-aws/src/cli.ts`
- Test: `tests/provider-aws-cli.test.ts` (modelled on `tests/provider-kubernetes-cli.test.ts`)

**Interfaces — Produces:**
```ts
export interface IamPolicyDocument { Version: '2012-10-17'; Statement: readonly IamStatement[] }
export interface IamStatement { Sid: string; Effect: 'Allow' | 'Deny'; Action: string | readonly string[]; Resource: string | readonly string[];
  Condition?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>; Principal?: unknown }
export function iamPolicy(options?: { partition?: AwsPartition; region?: string; account?: string; instanceProfileArn?: string }): IamPolicyDocument;
export function trustPolicy(options: { platformPrincipalArn: string; externalId: string }): IamPolicyDocument;
/** `better-compute aws iam-policy` — prints the policy JSON (or --out <file>). */
export function awsIamPolicyCommand(): { name: 'aws iam-policy'; group: 'Providers'; summary: string; description: string; flags: Record<string, unknown>; run(context: AwsCommandContext): Promise<void> };
/** `better-compute aws trust-policy --platform-principal <arn> --external-id <id>`. */
export function awsTrustPolicyCommand(): { name: 'aws trust-policy'; group: 'Providers'; summary: string; description: string; flags: Record<string, unknown>; run(context: AwsCommandContext): Promise<void> };
export interface AwsCommandContext { flags: Record<string, string | number | boolean | undefined>; io: { out(message: string): void }; note(message: string): void; path(value: string): string }
```
Match the exact command-object shape of `kubernetesManifestCommand()` (`provider-kubernetes/src/cli.ts:122-…`),
including `flags` entries `{ type, value, required, description }`.

**`iamPolicy` statements** (A1 row of program Appendix B):

| Sid | Effect / actions | Scope |
|---|---|---|
| `Describe` | `ec2:DescribeInstances`, `DescribeInstanceTypes`, `DescribeInstanceTypeOfferings`, `DescribeAvailabilityZones`, `DescribeImages` | `*` |
| `RunTagged` | `ec2:RunInstances` | instance and volume resources with `aws:RequestTag/better-compute:managed = 'true'`; the AMI, subnet, SG, ENI and key resources unconditioned |
| `TagOnCreate` | `ec2:CreateTags` | `ec2:CreateAction = 'RunInstances'` |
| `ManageOwned` | `ec2:StartInstances`, `StopInstances`, `RebootInstances`, `TerminateInstances`, `SendDiagnosticInterrupt`, `CreateReplaceRootVolumeTask` | `ec2:ResourceTag/better-compute:managed = 'true'` (power/reinstall: `ec2:ResourceTag/better-compute:instance` exists, via the `Null` condition `false`) |
| `Attach` | `ec2:CreateTags`, `ec2:DeleteTags` | `aws:TagKeys ForAllValues:StringEquals ['better-compute:instance','better-compute:managed']` |
| `PublicImages` | `ssm:GetParameters` | `arn:<p>:ssm:*::parameter/aws/service/*` |
| `Identity` | `sts:GetCallerIdentity` | `*` |
| `PassProfile` | `iam:PassRole` | the instance profile's role (only when `instanceProfileArn`) |

- [ ] **Step 1: Write the failing tests:**
  - `iam policy scopes destructive actions to managed tags`: `TerminateInstances` appears only in a statement whose
    `Condition.StringEquals['ec2:ResourceTag/better-compute:managed'] === 'true'`.
  - `tag edits are limited to better-compute keys`.
  - `partition flows into ARNs` (`aws-us-gov`).
  - `trust policy requires the external id`: `Condition.StringEquals['sts:ExternalId']` equals the input, and the
    principal is the platform ARN.
  - `commands print JSON and honor --out` (fake `io`, temp dir).
  - `commands have the CLI shape`: name, group, summary and flags are well formed, and the name does not collide
    with the reserved flags `url/format/config/query`.
- [ ] **Step 2: Run to fail.** Run `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/provider-aws-cli.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit:** `provider-aws: ABAC IAM policy and cross-account trust policy commands`.

### Task 15: Docs, roadmap, API surface, security review (A1 exit gate)

**Files:**
- Create: `packages/provider-aws/README.md`
- Modify: `apps/docs/content/docs/guides/vps/providers.mdx` (AWS section), `CHANGELOG.md`,
  `apps/docs/content/docs/reference/roadmap.mdx` (a `provider-aws` row), `PLAN.md` §16 "Provider depth" (AWS
  A0/A1), `generated/api-surface.json`

- [ ] **Step 1:** Write the provider-aws README:
  - configuration fields and defaults;
  - one account = one region (AD3);
  - credentials: F1, the role hop and ExternalId, and how to onboard a tenant account with `aws trust-policy`;
  - tags and the guard, and the ABAC policy (`aws iam-policy`);
  - images and aliases;
  - IMDSv2 and encrypted EBS defaults;
  - user-data limits;
  - attach semantics;
  - what comes in A2–A12.
- [ ] **Step 2:** Add the AWS section to the providers guide, using a FleetConfig example with
  `providerAccounts: [{ name: 'aws-use1', provider: 'aws', config: { region: 'us-east-1', zones: ['us-east-1a','us-east-1b'], assumeRoleArn: '…' } }]`.
  Add the CHANGELOG entry and the roadmap row.
- [ ] **Step 3:** Run the full gate:
  - `node node_modules/typescript/bin/tsc -b packages/aws-core packages/provider-aws` → exit 0
  - `node node_modules/pnpm/bin/pnpm.mjs vitest run tests/aws-*.test.ts tests/provider-aws*.test.ts tests/check-deps-aws.test.ts tests/provider-gcp.test.ts tests/provider-hetzner.test.ts` → PASS
  - `node scripts/check-deps.mjs` → exit 0
  - `node scripts/api-surface.mjs --update` → only provider-aws/aws-core entries
  - `node scripts/head-check.mjs --run apps/docs/scripts/sync-from-head.mjs .` if the docs generator picks up the
    new package
- [ ] **Step 4:** Dispatch a **security-review subagent** over `git log main..HEAD` for this branch. It focuses on
  the §5 threat table of the program plan: credentials, SSRF, XML, the confused deputy, the tag guard, and
  determinism. Fix every HIGH and MEDIUM finding, each with a test, before closing.
- [ ] **Step 5: Commit:** `docs: AWS provider guide, README, roadmap and changelog`.

---

## Self-review notes (for the executor)

- **Spec coverage:** this plan implements program R1 (Tasks 9–11, 13) and R2 (Tasks 12–13). It covers the R7
  onboarding prerequisites (Tasks 8, 14). Everything else is in later phases by design.
- **Type consistency:** names and types are shared across tasks and must stay as written:
  - Task 5 → 8, 10: `CredentialSource`, `AccountCredentials`.
  - Task 9 → 10: `InstanceTypeCache`, `ZoneCache`, `InstanceTypeInfo`.
  - Task 7 → 10–12: `ParsedOffer`/`offerId`/`parseOfferId`, `tags`, `clientToken`.
  - Task 10 → 11–12: `toMachine`, `machineState`.

  A rename in one task is a bug in the others.
- **Out of scope here, owned by later phases:**
  - reservations, Spot and pricing (A3);
  - networks (A2);
  - events (A4);
  - volumes (A5);
  - host join (A6);
  - workload roles (A7);
  - platform services (A8);
  - EKS (A9);
  - placement and EFA (A10);
  - costs and Organizations (A11);
  - deployment and the live suite (A12).

  `create` refuses reservation and spot offers with reason `phase-a3`, so nothing half-works.
