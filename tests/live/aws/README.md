# The AWS live suite

Real calls into a **dedicated sandbox AWS account**, to catch drift between AWS and the emulator in
`tests/support/`. It is excluded from the default run (`vitest.config.ts`) and the nightly matrix, and every file
skips unless it is explicitly enabled. Never point it at an account that holds anything else.

```sh
eval "$(aws configure export-credentials --profile <sandbox> --format env)"
BETTER_COMPUTE_AWS_LIVE=1 \
BETTER_COMPUTE_AWS_LIVE_ACCOUNT=<12-digit sandbox account id> \
BETTER_COMPUTE_AWS_LIVE_BUDGET_USD=25 \
  node node_modules/vitest/vitest.mjs run --config vitest.aws-live.config.ts
```

| Variable | Meaning |
| --- | --- |
| `BETTER_COMPUTE_AWS_LIVE` | Must be exactly `1`; anything else skips the suite |
| `BETTER_COMPUTE_AWS_LIVE_ACCOUNT` | The sandbox account id. The credentials must belong to it (`GetCallerIdentity`), or nothing runs |
| `BETTER_COMPUTE_AWS_LIVE_BUDGET_USD` | Nothing runs while Cost Explorer's month-to-date unblended cost is over this (it lags by up to a day) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | The sandbox credentials |
| `BETTER_COMPUTE_AWS_LIVE_REGION` | Default `AWS_REGION`, then `us-east-1` |

Enabled but misconfigured is an error, not a skip.

## Guards

- **Account pin and budget:** `livePreflight` (in `support/live.ts`) runs in every file's `beforeAll`.
- **Instance types:** only `t4g.nano` and `t3.micro` (`assertLiveInstanceType`).
- **Tags:** everything a run creates carries `better-compute:test-run=r<unix seconds>-<hex>` and
  `better-compute:managed=true` (`liveTags`). Files clean up in `afterAll`.
- **Sweeper:** `scripts/aws-live-sweep.mjs` deletes what carries a test-run tag older than two hours, for runs that
  crashed before their `afterAll`. Run it on a schedule in the sandbox account. It knows EC2 networking, instances
  and volumes, CloudFormation stacks, S3 buckets (every version and delete marker first; S3 requests name the sandbox
  as the expected bucket owner), SQS, SNS, EventBridge rules and buses, Secrets Manager, log groups, KMS keys and FIS
  experiment templates. Anything else it reports as skipped, to delete by hand.
- **Account-level backstop:** give the sandbox account an AWS Budget with an action that denies
  `ec2:RunInstances` once it is exceeded.

`tests/aws-live-guards.test.ts` pins every guard on the emulator in the default suite.

## Files

| File | Covers | Creates |
| --- | --- | --- |
| `templates.live.test.ts` | CloudFormation `ValidateTemplate` on the three deployment templates | nothing |
| `platform.live.test.ts` | `s3BlobStore` (single and multipart put, get, presigned GET, delete), `awsSecretsManagerStore` (put, resolve, tenant check, rotate, delete), `eventBridgeSink` through a real rule to SQS, `sqsSink` | an S3 bucket, a secret, an event bus and rule, two SQS queues, for minutes |

Files create their fixtures through `support/resources.ts` (`liveAws`): each is tagged with the run's tags and its
ARN is recorded as soon as it exists, so `afterAll` (`cleanUp`, the sweeper's deleters by ARN) deletes it even when
a later step failed. What `cleanUp` cannot delete stays tagged for the sweeper. `tests/aws-live-resources.test.ts`
pins those requests on the emulator.
