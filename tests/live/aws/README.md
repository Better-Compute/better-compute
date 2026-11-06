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
  crashed before their `afterAll`. Run it on a schedule in the sandbox account.
- **Account-level backstop:** give the sandbox account an AWS Budget with an action that denies
  `ec2:RunInstances` once it is exceeded.

`tests/aws-live-guards.test.ts` pins every guard on the emulator in the default suite.

## Files

| File | Covers | Creates |
| --- | --- | --- |
| `templates.live.test.ts` | CloudFormation `ValidateTemplate` on the three deployment templates | nothing |
