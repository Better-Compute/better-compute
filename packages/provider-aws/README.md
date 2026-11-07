# @better-compute/provider-aws

The Amazon EC2 provider for better-compute. EC2 instances (GPU instances included) become the instances of provider pools, with the same API, reconcilers and guarantees as the other cloud providers: offers, create, get, delete, power, reinstall, list, and discovery and attach. It calls AWS over plain `fetch` through [`@better-compute/aws-core`](../aws-core) (SigV4, the EC2 protocol, credentials); there is no AWS SDK.

It is not in the `better-compute` umbrella: install it where you use it.

```sh
pnpm add @better-compute/provider-aws
```

```ts
import { vps } from '@better-compute/vps';
import { aws } from '@better-compute/provider-aws';

vps({ providers: [aws] });
```

`aws` is `awsProvider()` with default options. `awsProvider({ fetch, endpoints, credentials, externalIdPrefix, platformAccounts, rateLimit, consistencyWindowMs, ssmImagePrefixes })` takes host options: `credentials` is the host's own AWS identity (default: the ambient chain of environment, web identity, container and IMDSv2 credentials), `platformAccounts` lists the AWS account ids a tenant's role may never be in, `endpoints` (`ec2`, `sts`) is for emulators and VPC endpoints, and `ssmImagePrefixes` lists private SSM parameter prefixes raw images may name (see Images). None of them come from account config.

## Accounts

One provider account is one AWS account in one region. A fleet in several regions is several accounts with the same credentials.

| Field               | Default    | Meaning                                                                                                                                         |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `region`            | (required) | The AWS region, `us-east-1`. Checked against the region grammar: it is the only config text that reaches a host name.                           |
| `zones`             | (required) | Availability Zone names as this account sees them (`us-east-1a`), or Local Zones (`us-west-2-lax-1a`). Offers and creates are limited to these. |
| `credentials`       | –          | A secret reference to `{ "accessKeyId", "secretAccessKey" }`. Allowed, but a role is better.                                                    |
| `assumeRoleArn`     | –          | The IAM role to assume, in the region's partition.                                                                                              |
| `webIdentityRoleArn` | –         | Keyless: the IAM role the account's own workload identity assumes (AssumeRoleWithWebIdentity). Excludes `credentials` and `assumeRoleArn`.    |
| `subnetId`          | –          | The subnet create uses (else the zone's default subnet).                                                                                        |
| `securityGroupIds`  | –          | The security groups create uses.                                                                                                                |
| `instanceProfile`   | –          | The instance profile ARN passed to `RunInstances`.                                                                                              |
| `rootVolumeGiB`     | `100`      | Root EBS volume size (8–16384).                                                                                                                 |
| `rootVolumeType`    | `gp3`      | `gp3`, `gp2` or `io2`.                                                                                                                          |
| `kmsKeyId`          | –          | The KMS key for EBS encryption (else the account's default EBS key).                                                                            |
| `metadataHopLimit`  | `1`        | The IMDSv2 hop limit (2 when containers on the instance need IMDS).                                                                             |
| `associatePublicIp` | `true`     | Give instances a public IPv4 address (with a subnet).                                                                                           |
| `discoverTag`       | –          | `key=value`: discovery yields only instances carrying this tag.                                                                                 |

`awsConfig.parse` checks field shapes (`INVALID_INPUT`); the provider checks the region, that every zone is in it, and the role ARN's shape and partition (`INVALID_CONFIG`), so `providerAccounts.create` refuses a bad account before it is stored.

## Credentials

| Account                | `credentials` | `assumeRoleArn` | Signs as                                                |
| ---------------------- | ------------- | --------------- | ------------------------------------------------------- |
| platform (root tenant) | set           | –               | the static key                                          |
| platform               | –             | –               | the host's ambient identity                             |
| platform               | any           | set             | AssumeRole from one of the above                        |
| tenant                 | set           | –               | the static key                                          |
| tenant                 | set           | set             | AssumeRole from the static key                          |
| tenant                 | –             | set             | AssumeRole from the platform identity                   |
| tenant                 | –             | –               | refused (`INVALID_CONFIG`, reason `ambientCredentials`) |
| any                    | –             | – (`webIdentityRoleArn` set) | AssumeRoleWithWebIdentity with the account's workload identity |

Ambient credentials are the control plane's own identity, so only platform accounts may use them (ruling F1).

Every AssumeRole sends the ExternalId `<externalIdPrefix>:<providerAccountId>` (`better-compute:pa_…` by default). The platform assigns it; there is no config field for it, so a tenant naming another tenant's role gets `AccessDenied` from STS. A tenant role in a `platformAccounts` account is refused when the account is stored. Before the first EC2 call the provider checks, once, that the role is not in the platform identity's own account and that the assumed identity is the role's account (`ACCESS_DENIED`, reasons `platform-account-role` and `assumed-identity-mismatch`).

To onboard a tenant's AWS account:

1. Pick the role's name and create the provider account with `assumeRoleArn` set to its ARN (`arn:aws:iam::<tenant account>:role/<name>`). Storing the account makes no AWS call, so the role need not exist yet; the call returns the account's id (`pa_…`).
2. Create that role in the tenant's account with the permissions policy from `better-compute aws iam-policy` (narrow it with `--region`, `--account` and `--discover-tag`; with a customer-managed `kmsKeyId`, add `--kms-key <key ARN>` for the EBS grants on that key, through EC2 only). Root-volume replacement (reinstall) also names its new task, volume, snapshot and image, which the policy allows for that action alone; the instance itself still needs `better-compute:instance`. The KMS and reinstall resource lists follow the AWS documentation and are confirmed by the live suite.
3. Give it the trust policy from `better-compute aws trust-policy --platform-principal <the control plane's role ARN> --external-id better-compute:<the id from step 1>`.
4. The account's first EC2 call (its first reconcile) assumes the role and runs the identity checks above; it fails with `ACCESS_DENIED` until the role and its trust policy exist.

`providerAccounts.get` shows what the tenant still has to set up as the account's `onboarding`: `mode`
(`assume-role`, `web-identity`, `access-key` or `ambient`), and for a role the `externalId` and, when the host
passes `awsProvider({ platformPrincipalArn })`, the principal to trust. That option is display only and never
derived (reading the host's identity would be a network call on every read); a value that is not an IAM role or
user ARN fails `awsProvider` (`INVALID_CONFIG`, `platformPrincipalArn`), and without it tenants see the ExternalId
only and must get the principal from the operator. A keyless (`web-identity`) account shows the `subject` and
`audience` its role trusts and, when the host configures `pki.workloadIssuer`, the `issuer` URL that
`aws onboarding-template --issuer` takes. `better-compute aws onboarding-template
--account <pa_…> --platform-principal <arn>` renders steps 2 and 3 as one CloudFormation template (the role, its
trust and the ABAC policy; the same `--region`, `--instance-profile`, `--kms-key` and `--discover-tag` flags).

### Keyless accounts (workload identity federation)

As with provider-gcp's `federationAudience`, a tenant's AWS account can sign in with no key and without the
platform's own AWS identity: set `webIdentityRoleArn`. vps fixes the account's subject,
`compute-account:<tenantId>/aws/<name>`; the provider mints a token for it from the host's workload issuer
(`ComputeOptions.pki.workloadIssuer`, audience `sts.amazonaws.com`) and exchanges it, unsigned, with
`AssumeRoleWithWebIdentity`. Without an issuer the account is `INVALID_CONFIG` (`noWorkloadIssuer`); with
`credentials` or `assumeRoleArn` too, `webIdentityExclusive`; a tenant role in a `platformAccounts` account,
`platform-account-role`.

Before such an account is stored, `checkAccount` proves the role trusts exactly that subject: the account's own
subject must be accepted (`federationRefused`) as the role's account (`assumed-identity-mismatch`); then a
stranger's probe (another tenant, the same name) and a sibling's (this tenant, another name) must be refused by the
trust condition, `AccessDenied` (`federationTrustsAnySubject` if accepted); and it must read EC2 (`ec2Access`). A
probe answered with any other STS error, such as `InvalidIdentityToken` when STS cannot fetch the issuer's keys, is
`UNAVAILABLE` (`federationProbeInconclusive`), never a pass. That, throttling, 5xx and timeouts (`checkTimeoutMs`,
default 10 s) store nothing and a retry runs the check again.

`better-compute aws onboarding-template --issuer <issuer URL> --tenant <tenantId> --name <account name>` renders
the IAM OIDC provider for the issuer (client id `sts.amazonaws.com`; `--oidc-provider-arn` reuses one) and the role
trusting exactly that subject, with the ABAC policy.

### Workload roles

Instances of a hosted pool can assume an IAM role with no static keys. The pool turns workload identity on
(`policy.workloadIdentity: true`) and lists the roles its instances may name in `policy.workloadRoles.aws` (ARN
globs); an instance names one as `instances.create` `workloadIdentity.awsRoleArn`. vps sends it to the host as
`InstanceSpec.awsRole` while the pool allows it; bcd exchanges the instance's workload token (audience
`sts.amazonaws.com`, subject `t:<tenantId>:instance:<id>`, from the gateway's workload broker, which must list
that audience) for the role's credentials and serves them on the guest's AWS-compatible metadata paths.
`better-compute aws workload-role --tenant <tenantId> --issuer <issuer URL> [--role-name <name>] [--policy-arn <arn>]`
renders the OIDC provider and the role, trusting `aud` `sts.amazonaws.com`, `sub` like `t:<tenantId>:instance:*`
and the session tag `bc-role` equal to the role itself (`aws:RequestTag/bc-role` = its ARN without a path, with
`sts:TagSession` allowed; the `RoleTag` output shows the value).

The workload broker mints a token for `sts.amazonaws.com` (requested, or the issuer's default audience) only for
an instance that names a role its pool still allows (refusal `audience`, reason `aws-role-not-allowed`), decided
before anything is signed, and tags it with that role (`https://aws.amazon.com/tags` `principal_tags.bc-role`).
So a token minted for one workload role assumes no other role of the tenant, even when the guest fetches it
itself from `/latest/identity-token`. A role you write by hand needs the same trust: without the tag condition it
accepts any of the tenant's STS tokens. A role name with a comma cannot be a tag value; the broker refuses such a
role (`aws-role-untaggable`) and `aws workload-role` refuses the name.

When a pool's workload settings change, `pools.update` recomputes the specs of the hosts running its role-bearing
instances at once. Credentials bcd already obtained stay valid until they expire (at most an hour; bcd's cache
renews 5 minutes before expiry).

IAM Roles Anywhere for bcd nodes outside AWS (plan question AQ9) is deferred, as the plan's default: workloads get
AWS credentials only through this web identity exchange.

The commands ship with this package (the CLI never imports providers). Add them to your configuration:

```ts
import {
  awsIamPolicyCommand,
  awsOnboardingTemplateCommand,
  awsTrustPolicyCommand,
  awsWorkloadRoleCommand,
} from '@better-compute/provider-aws';
export const commands = [
  awsIamPolicyCommand(),
  awsTrustPolicyCommand(),
  awsOnboardingTemplateCommand(),
  awsWorkloadRoleCommand(),
];
```

## Tags and the guard

Every instance and root volume better-compute creates is tagged `better-compute:managed=true` and `better-compute:instance=<instance id>`, plus `Name` and the instance's labels as `better-compute:<key>` (the ownership tags win). `delete` needs `better-compute:managed=true`; `power` and `reinstall` need `better-compute:instance` (`INVALID_STATE`, reasons `not-managed` and `not-claimed`). The policy from `aws iam-policy` makes AWS enforce the same rules on its side (ABAC): `TerminateInstances` only on instances tagged `better-compute:managed=true`, power and reinstall only on instances tagged `better-compute:instance`, and tag edits after launch only of those two keys (a request must name them, so a `DeleteTags` of every tag is refused). Attach is what writes the ownership tags on an existing instance, so the role can make any instance it may tag deletable: ABAC stops a stray terminate of an untagged instance, not a buggy attach. `--discover-tag key=value` (the account's `discoverTag`) limits attach tag edits, and so everything destructive outside better-compute's own launches, to instances carrying that tag.

## Offers and ids

An offer id is `<zone>/<instanceType>`, as in `us-east-1a/p5.48xlarge`. `listOffers` lists the on-demand types offered in the account's zones, skipping bare metal, with vCPUs, memory and GPUs (NVIDIA H100, H200, B200, A100, L4, L40S, A10G and T4 by name; others are `other`). Capacity reservation (`@cr-…`) and Spot (`:spot`) offers parse, and are refused by `create` until AWS phase A3 (`UNSUPPORTED`, reason `phase-a3`). Instance types are cached for a day, offerings and zone ids for an hour. A machine id is the instance id `i-…`; its labels carry `topology.aws/zone-id`.

## Images

An image is an `ami-…` id, a `resolve:ssm:<parameter>` that EC2 resolves at launch, or an alias expanded for the instance type's architecture (Graviton gets arm64):

| Alias              | Public SSM parameter                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`     | `/aws/service/canonical/ubuntu/server/24.04/stable/current/{amd64,arm64}/hvm/ebs-gp3/ami-id`          |
| `ubuntu-22.04`     | `/aws/service/canonical/ubuntu/server/22.04/stable/current/{amd64,arm64}/hvm/ebs-gp2/ami-id`          |
| `al2023`           | `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-{x86_64,arm64}`                       |
| `dlami-gpu`        | `/aws/service/deeplearning/ami/{x86_64,arm64}/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id`  |
| `eks-al2023-<k8s>` | `/aws/service/eks/optimized-ami/<k8s>/amazon-linux-2023/{x86_64,arm64}/standard/recommended/image_id` |

For an alias the root device name is known; for a raw `ami-…` it is read with `DescribeImages` (cached a day). A raw `resolve:ssm:` image must name a public `/aws/service/` parameter, or one under the host's `ssmImagePrefixes` (`/my/team/`): the image comes from the tenant and EC2 reads the parameter as the account, so other private parameters are refused (`INVALID_INPUT`, reason `image`). A private prefix also needs `ssm:GetParameters` on it in the role's policy (`aws iam-policy` grants only `/aws/service/*`). For a raw `resolve:ssm:` parameter the root device cannot be known without reading SSM, so the root volume mapping is left out: the volume then has the AMI's size and type, and is encrypted only if the account encrypts EBS by default. The provider logs this once per image.

## Hardened defaults

- IMDSv2 only (`HttpTokens=required`), hop limit `metadataHopLimit`, instance metadata tags off.
- The root EBS volume is encrypted (the account default key, or `kmsKeyId`) and deleted with the instance.
- An instance-initiated shutdown stops the instance rather than terminating it.

## User data

EC2 takes at most 16 384 bytes of user data. With SSH keys, the user data is a MIME multipart: a `text/cloud-config` part with `ssh_authorized_keys` and the payload. Over 16 384 bytes it is gzipped; still over, `create` refuses it (`INVALID_INPUT`, reason `user-data-too-large`). The packing is byte-for-byte deterministic (the gzip header's time and OS bytes are fixed and the MIME boundary derives from the content), because EC2 refuses a retried `RunInstances` whose parameters differ.

## Creates, reads and deletes

`create` is one `RunInstances` with a `ClientToken` derived from the instance id, so a retried create returns the same instance and a retry with different parameters is `CONFLICT`. It does not wait. EC2 is eventually consistent right after a launch: `get` looks the instance up by id, then by its client token, and reports `pending` for up to `consistencyWindowMs` (2 minutes) so vps never marks a new instance lost. An instance EC2 terminates for capacity or volume limits after accepting it surfaces through `get` as `CAPACITY_UNAVAILABLE` or `QUOTA_EXCEEDED`, which ends the create. `delete` reads the same way (by id, then client token). An instance this client launched inside the window that neither read shows yet is still terminated (RunInstances tagged it managed), and a `TerminateInstances` that does not find it is `UNAVAILABLE` (reason `eventual-consistency`, retried), never success. Otherwise `delete` of a missing, terminating or terminated instance succeeds; termination protection is `INVALID_STATE` (reason `termination-protected`).

`power` maps `on` to `StartInstances`, `graceful-off` and `off` to `StopInstances` (`off` with `Force`), `reset`, `cycle` and `graceful-restart` to `RebootInstances`, and `nmi` to `SendDiagnosticInterrupt`. EC2 refuses a start while an instance is stopping and a stop or reboot while it is pending; `power` reports those states (and an `IncorrectInstanceState` from a state change between its read and its call) as `UNAVAILABLE` (reason `transitional-state`), which the reconciler retries, rather than `INVALID_STATE`, which would fail the instance. `reinstall` replaces the root volume (`CreateReplaceRootVolumeTask`) with the resolved image and does not block.

## Discovery and attach

`discover` yields every instance that is not terminated (only those tagged `discoverTag`, when set). `claim` writes `better-compute:instance` (and `better-compute:managed` when deletion is handed over) and re-reads: EC2 tags have no compare-and-swap, so a re-read naming another instance is a lost race (`CONFLICT`). Tag reads lag behind writes too: a re-read that does not show the tag (or `managed`) yet is `UNAVAILABLE` (reason `tag-propagation`, retried), and so is a `delete` right after a managed claim that does not see `managed` yet. The vps unique index on the external id referees between control planes. `release` removes the tags only when they name the instance. Deleting an attached instance detaches it by default and leaves it running.

## What comes next

Networks (A2), capacity reservations, Capacity Blocks, Spot and prices (A3), event intake and Spot interruptions (A4), EBS volumes (A5), EC2 hosts joining as bcd nodes (A6), bcd's AWS-compatible credential endpoints (the Go half of A7), EKS (A9), placement groups and EFA (A10), and costs (A11), per `docs/superpowers/plans/2026-10-18-aws-integration-program.md`.

## Testing

`tests/support/aws-emulator` emulates STS, IMDS and EC2 in process through `fetch`. `tests/provider-aws*.test.ts` cover the config, credentials, offers, compute, attach, the CLI policies and the `providerConformanceCases()` suite; `tests/aws-end-to-end.test.ts` drives the provider through vps on PGlite. No test calls AWS.

## License

Apache-2.0.
