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
| `subnetId`          | –          | The subnet create uses (else the zone's default subnet).                                                                                        |
| `securityGroupIds`  | –          | The security groups create uses.                                                                                                                |
| `instanceProfile`   | –          | The instance profile ARN passed to `RunInstances`.                                                                                              |
| `rootVolumeGiB`     | `100`      | Root EBS volume size (8–16384).                                                                                                                 |
| `rootVolumeType`    | `gp3`      | `gp3`, `gp2` or `io2`.                                                                                                                          |
| `kmsKeyId`          | –          | The KMS key for EBS encryption (else the account's default EBS key).                                                                            |
| `metadataHopLimit`  | `1`        | The IMDSv2 hop limit (2 when containers on the instance need IMDS).                                                                             |
| `associatePublicIp` | `true`     | Give instances a public IPv4 address (with a subnet).                                                                                           |
| `discoverTag`       | –          | `key=value`: discovery yields only instances carrying this tag.                                                                                 |
| `spot`              | `false`    | Offer and launch Spot capacity (`<zone>/<type>:spot`).                                                                                          |
| `quotas`            | `true`     | Cap offers at the EC2 vCPU quota headroom (Service Quotas).                                                                                     |
| `pricing`           | `off`      | `off`, `on-demand` (the AWS Price List) or `all` (adds Spot prices).                                                                            |
| `allowPurchases`    | `false`    | Allow buying capacity (Capacity Blocks, new ODCRs) in this platform account. Spends money.                                                      |

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

Ambient credentials are the control plane's own identity, so only platform accounts may use them (ruling F1).

Every AssumeRole sends the ExternalId `<externalIdPrefix>:<providerAccountId>` (`better-compute:pa_…` by default). The platform assigns it; there is no config field for it, so a tenant naming another tenant's role gets `AccessDenied` from STS. A tenant role in a `platformAccounts` account is refused when the account is stored. Before the first EC2 call the provider checks, once, that the role is not in the platform identity's own account and that the assumed identity is the role's account (`ACCESS_DENIED`, reasons `platform-account-role` and `assumed-identity-mismatch`).

To onboard a tenant's AWS account:

1. Pick the role's name and create the provider account with `assumeRoleArn` set to its ARN (`arn:aws:iam::<tenant account>:role/<name>`). Storing the account makes no AWS call, so the role need not exist yet; the call returns the account's id (`pa_…`).
2. Create that role in the tenant's account with the permissions policy from `better-compute aws iam-policy` (narrow it with `--region`, `--account` and `--discover-tag`; with a customer-managed `kmsKeyId`, add `--kms-key <key ARN>` for the EBS grants on that key, through EC2 only). Root-volume replacement (reinstall) also names its new task, volume, snapshot and image, which the policy allows for that action alone; the instance itself still needs `better-compute:instance`. The KMS and reinstall resource lists follow the AWS documentation and are confirmed by the live suite.
3. Give it the trust policy from `better-compute aws trust-policy --platform-principal <the control plane's role ARN> --external-id better-compute:<the id from step 1>`.
4. The account's first EC2 call (its first reconcile) assumes the role and runs the identity checks above; it fails with `ACCESS_DENIED` until the role and its trust policy exist.

The commands ship with this package (the CLI never imports providers). Add them to your configuration:

```ts
import { awsIamPolicyCommand, awsTrustPolicyCommand } from '@better-compute/provider-aws';
export const commands = [awsIamPolicyCommand(), awsTrustPolicyCommand()];
```

## Tags and the guard

Every instance and root volume better-compute creates is tagged `better-compute:managed=true` and `better-compute:instance=<instance id>`, plus `Name` and the instance's labels as `better-compute:<key>` (the ownership tags win). `delete` needs `better-compute:managed=true`; `power` and `reinstall` need `better-compute:instance` (`INVALID_STATE`, reasons `not-managed` and `not-claimed`). The policy from `aws iam-policy` makes AWS enforce the same rules on its side (ABAC): `TerminateInstances` only on instances tagged `better-compute:managed=true`, power and reinstall only on instances tagged `better-compute:instance`, and tag edits after launch only of those two keys (a request must name them, so a `DeleteTags` of every tag is refused). Attach is what writes the ownership tags on an existing instance, so the role can make any instance it may tag deletable: ABAC stops a stray terminate of an untagged instance, not a buggy attach. `--discover-tag key=value` (the account's `discoverTag`) limits attach tag edits, and so everything destructive outside better-compute's own launches, to instances carrying that tag.

## Offers and ids

An offer id is `<zone>/<instanceType>`, as in `us-east-1a/p5.48xlarge`. `listOffers` lists the on-demand types offered in the account's zones, skipping bare metal, with vCPUs, memory and GPUs (NVIDIA H100, H200, B200, A100, L4, L40S, A10G and T4 by name; others are `other`). Every offer carries `arch`. Capacity reservation (`@cr-…`) and Spot (`:spot`) offers are described under [Capacity markets](#capacity-markets). Instance types are cached for a day, offerings and zone ids for an hour. A machine id is the instance id `i-…`; its labels carry `topology.aws/zone-id`.

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

## Capacity markets

- **Reservations.** `listReservations` reads On-Demand Capacity Reservations and Capacity Blocks for ML (`DescribeCapacityReservations`): an ODCR is reservation `cr-…`, a block `cb:cr-…`. `active` is `ready`; `scheduled`, `payment-pending`, `assessing` and `delayed` are `scheduled`; `pending` is `creating`; gone and unknown states are left out, and so are reservations create cannot launch into (not Linux/UNIX, dedicated tenancy, or outside the account's zones). A reservation another account shares through RAM is `shared`, its zone resolved from the zone id. Ready reservations are offered as `<zone>/<type>@<cr-id>` with their free slots as `count` (market `reserved` or `capacity-block`), and vps admits creates against them (`claimReservationSlot`). `create` on such an offer reads the reservation first (it must be active and hold that type in that zone), targets it, and adds `MarketType=capacity-block` for a block. Machines report `market` and `reservation`.
- **Spot.** With `spot`, every on-demand offer has a `:spot` twin. A Spot create is a one-time request that terminates on interruption (a shutdown from inside terminates it too). A reclaimed Spot Instance reads as `deleted` with `interruption { kind: 'spot', at, action }`.
- **Quotas.** With `quotas`, offers carry the EC2 vCPU quota headroom of their family as a machine `count` (`GetServiceQuota`; usage is the vCPUs of pending and running instances, Spot against the Spot quota), and an offer with none left is not available. Cached 5 minutes; an unreadable quota leaves `count` unset.
- **Prices.** `pricing: 'on-demand'` reads one region-wide Price List `GetProducts` (Linux, shared tenancy, no pre-installed software), cached a day; `'all'` adds `DescribeSpotPriceHistory` for Spot offers, cached 10 minutes. A failed read leaves prices unset and never fails `listOffers`.
- **Buying.** `listReservationOfferings` (a read) lists the ODCRs the account could create now and the Capacity Blocks on sale. `purchaseReservation` spends money: it is refused unless `allowPurchases` and the account is a platform account, a Capacity Block is bought only while it is on sale at no more than its listed price (the offering id carries both), and a retry with the same key returns what the first attempt bought (the reservation's `better-compute:purchase` tag, and an ODCR's `ClientToken`). vps's `providerAccounts.purchaseReservation` is root-only, needs `confirm: true`, and buys exactly once.
- **Policy.** `aws iam-policy` always grants the reservation, offering and Spot price reads, the vCPU quota reads and launches into reservations; `--spot`, `--pricing` and `--allow-purchases` add Spot launches, the Price List and buying (only tagged `better-compute:managed=true`).

The vCPU quota codes beyond standard, G/VT and P (and their Spot twins) are marked _verify_ in `src/markets/quotas.ts`, as are the resource types `PurchaseCapacityBlock` authorizes against.

## Discovery and attach

`discover` yields every instance that is not terminated (only those tagged `discoverTag`, when set). `claim` writes `better-compute:instance` (and `better-compute:managed` when deletion is handed over) and re-reads: EC2 tags have no compare-and-swap, so a re-read naming another instance is a lost race (`CONFLICT`). Tag reads lag behind writes too: a re-read that does not show the tag (or `managed`) yet is `UNAVAILABLE` (reason `tag-propagation`, retried), and so is a `delete` right after a managed claim that does not see `managed` yet. The vps unique index on the external id referees between control planes. `release` removes the tags only when they name the instance. Deleting an attached instance detaches it by default and leaves it running.

## What comes next

Networks (A2), event intake and Spot interruptions (A4), EBS volumes (A5), EC2 hosts joining as bcd nodes (A6), workload roles (A7), EKS (A9), placement groups and EFA (A10), and costs (A11), per `docs/superpowers/plans/2026-10-18-aws-integration-program.md`.

## Testing

`tests/support/aws-emulator` emulates STS, IMDS and EC2 in process through `fetch`. `tests/provider-aws*.test.ts` cover the config, credentials, offers, compute, attach, the CLI policies and the `providerConformanceCases()` suite; `tests/aws-end-to-end.test.ts` drives the provider through vps on PGlite. No test calls AWS.

## License

Apache-2.0.
