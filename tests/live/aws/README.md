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

| `ec2.live.test.ts` | provider-aws: the A1 `providerConformanceCases`, A2 network/subnet/firewall create and delete, A4 EC2 state changes through a real EventBridge rule on the default bus, and a Spot interruption sent by FIS (`aws:ec2:send-spot-instance-interruptions`) | `t4g.nano`/`t3.micro` instances for minutes, a VPC, an SQS queue and a rule, a FIS template |

`ec2.live.test.ts` skips when `@better-compute/provider-aws` is not in the checkout, and each case skips when the
provider has no such feature yet (`networks`, `pollEvents`, Spot offers). It takes these optional settings:

| Variable | Meaning |
| --- | --- |
| `BETTER_COMPUTE_AWS_LIVE_ZONE` | Default `<region>a` |
| `BETTER_COMPUTE_AWS_LIVE_INSTANCE_TYPE` | `t4g.nano` (default) or `t3.micro`; nothing else is accepted |
| `BETTER_COMPUTE_AWS_LIVE_ATTACHABLE` | An instance id the conformance claim and discover cases may tag and untag |
| `BETTER_COMPUTE_AWS_LIVE_FIS_ROLE_ARN` | A role FIS can assume, with `ec2:SendSpotInstanceInterruptions` and `ec2:DescribeInstances`; without it the Spot case skips |

The provider's fetch goes through `liveEc2Fetch` (`support/live.ts`). It answers a refused call the way EC2 would
(403 `UnauthorizedOperation`), so nothing is sent: an instance type off the allow-list in any `…InstanceType`
parameter, a launch of more than one instance, or any purchase, dedicated host, capacity reservation, NAT gateway or
fleet. Every instance, VPC, subnet, security group, internet gateway, gateway endpoint, route table, network ACL, volume and
Elastic IP that EC2
creates is recorded at once and tagged with the run's tags.

Files create their fixtures through `support/resources.ts` (`liveAws`): each is tagged with the run's tags and its
ARN is recorded as soon as it exists, so `afterAll` (`cleanUp`, the sweeper's deleters by ARN) deletes it even when
a later step failed. What `cleanUp` cannot delete stays tagged for the sweeper. `tests/aws-live-resources.test.ts`
pins those requests on the emulator.
