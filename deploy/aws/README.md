# The control plane on AWS

Three CloudFormation stacks, rendered (not kept here) by `@better-compute/aws` so they cannot drift from the code
that tests them. The docs page "Deploying on AWS" (`apps/docs/content/docs/operations/deploy-aws.mdx`) explains
what each stack creates and why; this file is the runbook.

| Stack | Template | Depends on |
| --- | --- | --- |
| `<name>-network` | `network.json`: VPC, subnets, NAT, VPC endpoints, flow logs | none |
| `<name>-data` | `data.json`: Aurora PostgreSQL Serverless v2, IAM auth, KMS | network |
| `<name>-control-plane` | `control-plane.json`: ECS Fargate api/worker/gateway, ALB + WAF, NLB, S3, KMS, alarms | network, data |

The commands below use the AWS CLI v2 and `NAME=better-compute`, `REGION=us-east-1`. Nothing in this repository
runs them.

## 0. Render

```sh
better-compute aws deploy-templates --out cfn --name "$NAME"      # --zones 2 --nat single --readers 0 for staging
```

`control-plane.json` is over CloudFormation's 51,200-byte inline limit: pass `--s3-bucket <bucket>` to
`aws cloudformation deploy` (as below), or render with `--compact`.

## 1. Image and certificate

Build an image whose entrypoint is the `better-compute` CLI, with your `better-compute.config.mjs` (see the docs
page for an AWS configuration) and the RDS certificate bundle in it, push it to ECR and note the digest:

```sh
IMAGE=<account>.dkr.ecr.$REGION.amazonaws.com/better-compute@sha256:<digest>
```

Request an ACM certificate (DNS validation) for the API domain in `$REGION` and note its ARN as `CERT`.

## 2. Network and data

```sh
aws cloudformation deploy --stack-name "$NAME-network" --template-file cfn/network.json --capabilities CAPABILITY_IAM
aws cloudformation deploy --stack-name "$NAME-data" --template-file cfn/data.json \
  --parameter-overrides NetworkStack="$NAME-network" DataApi=Enabled
```

## 3. The database user (once)

The processes connect as an IAM-authenticated user; the master password stays in Secrets Manager.

```sh
CLUSTER=$(aws cloudformation describe-stacks --stack-name "$NAME-data" --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)
MASTER=$(aws cloudformation describe-stacks --stack-name "$NAME-data" --query "Stacks[0].Outputs[?OutputKey=='MasterUserSecretArn'].OutputValue" --output text)
for sql in "CREATE ROLE bc_app LOGIN" "GRANT rds_iam TO bc_app" \
           "GRANT CONNECT, CREATE ON DATABASE better_compute TO bc_app" "GRANT CREATE, USAGE ON SCHEMA public TO bc_app"; do
  aws rds-data execute-statement --resource-arn "$CLUSTER" --secret-arn "$MASTER" --database better_compute --sql "$sql"
done
aws cloudformation deploy --stack-name "$NAME-data" --template-file cfn/data.json \
  --parameter-overrides NetworkStack="$NAME-network" DataApi=Disabled
```

`btree_gist` is a trusted extension: the first migration creates it as `bc_app`.

## 4. The control plane, at zero tasks

```sh
aws cloudformation deploy --stack-name "$NAME-control-plane" --template-file cfn/control-plane.json \
  --s3-bucket <a bucket for templates> --capabilities CAPABILITY_IAM \
  --parameter-overrides NetworkStack="$NAME-network" DataStack="$NAME-data" Image="$IMAGE" \
    ApiDomainName=compute.example.com GatewayDomainName=gw.example.com CertificateArn="$CERT" \
    ApiCount=0 WorkerCount=0 GatewayCount=0   # HostedZoneId=Z… writes the DNS aliases, AlarmEmail=… subscribes,
                                              # AccessLogsBucket=… (prepared for log delivery) turns on access logs
```

## 5. The PKI bundle

Create the bundle with `better-compute pki init` on an operator machine, sealed with the deployment secret
(`aws secretsmanager get-secret-value --secret-id <DeploymentSecretArn>`), and put it:

```sh
aws secretsmanager put-secret-value --secret-id <PkiBundleSecretArn> --secret-string file://.better-compute/pki.json
```

Then delete the local copy, or keep it offline. The gateway's serving certificate must name `GatewayDomainName`.

## 6. Migrate, then scale up

```sh
aws ecs run-task --cluster "$NAME" --launch-type FARGATE --task-definition <MigrateTaskDefinitionArn> \
  --network-configuration "awsvpcConfiguration={subnets=[<TaskSubnetIds>],securityGroups=[<MigrateSecurityGroupIds>],assignPublicIp=DISABLED}"
aws ecs wait tasks-stopped --cluster "$NAME" --tasks <task arn>     # exit code 0 in describe-tasks
aws cloudformation deploy --stack-name "$NAME-control-plane" --template-file cfn/control-plane.json \
  --s3-bucket <bucket> --capabilities CAPABILITY_IAM --use-previous-template \
  --parameter-overrides ApiCount=3 WorkerCount=2 GatewayCount=3
```

Without `HostedZoneId`, point the API domain at `ApiLoadBalancerDnsName` and the gateway domain at
`GatewayLoadBalancerDnsName`. Publish bcd binaries to `DownloadsBucketName`; they are served at `DownloadsUrl`.

## Upgrades

A release is a new image digest, and its expand migrations run before any process of it:

1. Update the stack with `MigrateImage=<new digest>` and every other parameter unchanged
   (`UsePreviousValue`). Only the migrate task definition changes.
2. Run the migrate task (step 6) and wait for exit code 0.
3. Update with `Image=<new digest>` and `MigrateImage=` (empty). The services roll with the deployment circuit
   breaker, which rolls back a release whose tasks do not become healthy.

## Deleting

The database and both load balancers have deletion protection, and the keys, secrets, log groups and the blobs,
snapshots and audit buckets are retained. Audit objects stay under Object Lock until their retention ends.

Redeploying under the same `NAME` collides with what was retained under fixed names: the secrets
`bc-deploy/$NAME/secret` and `bc-deploy/$NAME/pki-bundle`, and the log groups
`/better-compute/$NAME/{api,worker,gateway,migrate}`. The bucket names are generated, and the key alias goes with
the stack.

To restore a retained database (or its snapshot) under a new control-plane stack, the processes need the old
`BETTER_COMPUTE_SECRET`: everything sealed with it, the PKI bundle included, is unreadable under a new one. Adopt
it instead of generating one:

1. Note the old stack's `DeploymentSecretArn` and `PlatformKeyArn` outputs (the key encrypts the secret).
2. Copy the sealed bundle out of the old `bc-deploy/$NAME/pki-bundle` into a file only you can read, export the old
   log groups if you need them, then delete that secret and those log groups (or deploy under a new `NAME`).
3. Deploy the control plane (step 4) with `ExistingDeploymentSecretArn=<old DeploymentSecretArn>
   ExistingDeploymentSecretKeyArn=<old PlatformKeyArn>`. The stack then creates no deployment secret, and ECS
   injects the old one.
4. In step 5, put the old sealed bundle instead of running `pki init`.

Leave both parameters as they are on every later update. The stack never regenerates either secret by itself: the
templates pin how they are generated, because CloudFormation would generate a new value if that ever changed.

## The live suite

`tests/live/aws/` runs against a dedicated sandbox account only; see its README. It never runs in CI or by default.
