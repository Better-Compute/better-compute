# @better-compute/aws-core

Shared AWS plumbing for better-compute providers, with no AWS SDK dependency: SigV4 signing and presigned URLs, partitions and endpoints, the `ec2`, `query`, `json` and `rest` protocol clients, AWS error mapping, redaction, pagination, credential sources, and a hardened XML reader. `@better-compute/provider-aws` and `@better-compute/aws` build on it (`docs/superpowers/plans/2026-10-18-aws-integration-program.md`). It does not implement SigV4a, event streams, CBOR or S3 Express session auth.

It depends only on `@better-compute/core`. It is not in the `better-compute` umbrella: install it where you use it.

```sh
pnpm add @better-compute/aws-core
```

## Query serializers

| Function                                     | Protocol                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `serializeEc2Query(action, version, params)` | EC2: lists flatten to `Name.1`, `Name.1.Sub`; booleans are `true`/`false`.        |
| `serializeAwsQuery(action, version, params)` | awsQuery (IAM, STS, …): lists flatten to `Name.member.1`, maps to `Name.entry.1`. |

Both return a form-encoded body with `Action` and `Version` and the keys sorted. `undefined` members are left out. A `Map` is an awsQuery map and has no EC2 form.

## XML reader

`parseXml(text, limits?)` parses an AWS XML response into an `XmlElement` tree. Namespaces are ignored (names are local names), entities are decoded, and `items(name)` reads both the EC2 `<item>` and the query `<member>` list forms. The reader refuses DTDs and entity declarations, and enforces `maxBytes` (default 16 MiB) and `maxDepth` (default 64). A refused or malformed document is a `ComputeError`.

## Signing

`signRequest(input)` returns the headers to add (`authorization`, `x-amz-date`, and `x-amz-security-token` / `x-amz-content-sha256` when they apply). Non-S3 services normalize the path and encode the wire path again; `normalizePath: false` (S3) keeps it. `presignUrl(input)` builds a query-signed URL that expires in 1 to 604 800 seconds. Signing is pinned to cases of the AWS SigV4 test suite (`tests/fixtures/aws-sigv4`) and the documented IAM and S3 examples.

## Endpoints

`assertRegion(region)` is the only path from config text to a host name: a region must match the AWS region grammar, so it can never carry a dot, slash or `@`. `endpointFor(service, region, { fips, dualStack, override })` knows the `aws`, `aws-cn` and `aws-us-gov` partitions and the global services (IAM, Pricing, Cost Explorer, Organizations); `signingRegionFor` gives their signing region. `override` is a host option (tests, VPC endpoints), never account config, and must be an http(s) URL without credentials. `parseArn` / `formatArn` handle every partition.

## Clients

| Function | Protocol |
| --- | --- |
| `ec2Client(options)` | EC2 (version 2016-11-15); returns the parsed `<ActionResponse>`. |
| `queryClient({ …, version })` | awsQuery (STS, IAM, SNS, …); returns the `<ActionResult>` element. |
| `jsonClient({ …, jsonVersion, targetPrefix })` | JSON 1.0/1.1 with `X-Amz-Target`. |
| `restClient({ …, s3? })` | rest-json and rest-xml; `s3` signs S3-style. |

Every client takes the injected `fetch`, a `clock` (business time; signing uses it), a `log`, a token-bucket `rateLimit` (default 20/s, burst 40) and a `timeoutMs` (default 20 s). There are exactly two retries: one after `RequestTimeTooSkewed`/`RequestExpired` with the offset from the server's `Date`, and one after `ExpiredToken` with the credentials invalidated. Everything else is the caller's (the reconciler owns backoff). Failures are `ComputeError`s mapped by `mapAwsError` (throttling → `RATE_LIMITED` with `retryAfterMs`, capacity → `CAPACITY_UNAVAILABLE`, limits → `QUOTA_EXCEEDED`, `*.NotFound` → `NOT_FOUND`, …), with `details: { provider: 'aws', service, status, code, requestId }`. `paginate` follows tokens and refuses a repeated one.

## Credentials

| Source | Kind |
| --- | --- |
| `staticCredentials(load)` | A secret's JSON `{ accessKeyId, secretAccessKey, sessionToken? }`. |
| `envCredentials(env)` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`. |
| `imdsCredentials()` | IMDSv2 only; no IMDSv1 fallback. |
| `containerCredentials()` | ECS and EKS Pod Identity. The full URI may only name loopback, `169.254.170.2` or `169.254.170.23`. |
| `webIdentityCredentials()` | `AssumeRoleWithWebIdentity`, sent unsigned. |
| `assumeRoleCredentials(base, …)` | `AssumeRole` with an ExternalId and a checked session name. |
| `ambientCredentials()` | env → web identity → container → IMDS; keeps the first that works. |
| `cachedCredentials(source)` | Single-flight; refreshes 5 minutes before expiry. |

Ambient credentials are the control plane's own identity: providers allow them for platform (root-tenant) accounts only (ruling F1).

## Security rules

- Credentials, session tokens, signatures, `Authorization` headers, presigned URLs and IMDS tokens are never logged or put in an error. `redactAws(text)` removes them from any string built from a response; every client error passes through it. Credential endpoints' bodies never reach an error.
- Logs are `debug` records of `{ service, operation, status, requestId, ms }` only.
- Header values with line breaks are refused before signing.

## Testing

`tests/support/aws-emulator` is an in-process emulator injected through `fetch`: it checks the SigV4 shape and clock of every signed request, and serves STS, IMDS and the container endpoints (`emu.ambient` is the platform identity). `failNext` queues AWS errors and `skewMs` moves its clock.

## License

Apache-2.0.
