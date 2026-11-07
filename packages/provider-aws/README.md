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

| Field                        | Default                 | Meaning                                                                                                                                         |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `region`                     | (required)              | The AWS region, `us-east-1`. Checked against the region grammar: it is the only config text that reaches a host name.                           |
| `zones`                      | (required)              | Availability Zone names as this account sees them (`us-east-1a`), or Local Zones (`us-west-2-lax-1a`). Offers and creates are limited to these. |
| `credentials`                | –                       | A secret reference to `{ "accessKeyId", "secretAccessKey" }`. Allowed, but a role is better.                                                    |
| `assumeRoleArn`              | –                       | The IAM role to assume, in the region's partition.                                                                                              |
| `subnetId`                   | –                       | The subnet create uses (else the zone's default subnet).                                                                                        |
| `securityGroupIds`           | –                       | The security groups create uses.                                                                                                                |
| `instanceProfile`            | –                       | The instance profile ARN passed to `RunInstances`.                                                                                              |
| `rootVolumeGiB`              | `100`                   | Root EBS volume size (8–16384).                                                                                                                 |
| `rootVolumeType`             | `gp3`                   | `gp3`, `gp2` or `io2`.                                                                                                                          |
| `kmsKeyId`                   | –                       | The KMS key for EBS encryption (else the account's default EBS key).                                                                            |
| `metadataHopLimit`           | `1`                     | The IMDSv2 hop limit (2 when containers on the instance need IMDS).                                                                             |
| `associatePublicIp`          | `true`                  | Give instances a public IPv4 address (with a subnet).                                                                                           |
| `discoverTag`                | –                       | `key=value`: discovery yields only instances carrying this tag.                                                                                 |
| `ipamPoolId`                 | –                       | Networks: allocate each VPC range from this Amazon VPC IPAM pool (the network's `cidr` gives the size).                                         |
| `securityGroupsPerInterface` | `5`                     | Networks: the account's security groups per network interface quota; network tags past it are `QUOTA_EXCEEDED`.                                 |
| `spot`                       | `false`                 | Offer and launch Spot capacity (`<zone>/<type>:spot`).                                                                                          |
| `quotas`                     | `true`                  | Cap offers at the EC2 vCPU quota headroom (Service Quotas).                                                                                     |
| `pricing`                    | `off`                   | `off`, `on-demand` (the AWS Price List) or `all` (adds Spot prices).                                                                            |
| `allowPurchases`             | `false`                 | Allow buying capacity (Capacity Blocks, new ODCRs) in this platform account. Spends money.                                                      |
| `efa`                        | `off`                   | `auto`: an EFA-capable type launches with one EFA interface per network card (needs `subnetId` or a network). See [ML fabric](#ml-fabric).      |
| `eventQueueUrl`              | –                       | The SQS intake queue the account's EventBridge rules feed (`aws event-rules`), in this account and region. See [Events](#events).               |
| `eventSources`               | `aws.ec2`, `aws.health` | The EventBridge sources taken from the queue; `aws.guardduty` is opt-in. Anything else is dropped.                                              |

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

Every instance, root volume and primary network interface better-compute creates is tagged `better-compute:managed=true` and `better-compute:instance=<instance id>`, plus `Name` and the instance's labels as `better-compute:<key>` (the ownership tags win). `delete` needs `better-compute:managed=true`; `power` and `reinstall` need `better-compute:instance` (`INVALID_STATE`, reasons `not-managed` and `not-claimed`). The policy from `aws iam-policy` makes AWS enforce the same rules on its side (ABAC): `TerminateInstances` only on instances tagged `better-compute:managed=true`, power and reinstall only on instances tagged `better-compute:instance`, and tag edits after launch only of those two keys (a request must name them, so a `DeleteTags` of every tag is refused). Attach is what writes the ownership tags on an existing instance, so the role can make any instance it may tag deletable: ABAC stops a stray terminate of an untagged instance, not a buggy attach. `--discover-tag key=value` (the account's `discoverTag`) limits attach tag edits, and so everything destructive outside better-compute's own launches, to instances carrying that tag.

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
- **Buying.** `listReservationOfferings` (a read) lists the ODCRs the account could create now and the Capacity Blocks on sale. `purchaseReservation` spends money: it is refused unless `allowPurchases` and the account is a platform account, a Capacity Block is bought only while it is on sale at no more than its listed price (the offering id carries both), and a retry with the same key returns what the first attempt bought (the reservation's `better-compute:purchase` tag, and an ODCR's `ClientToken`). `PurchaseCapacityBlock` has no `ClientToken` and EC2's reads lag, so after an attempt that may have bought (vps passes `uncertainSince`) a retry also looks for the block by type, zone, count, start and creation time, and buys again only once `purchasePropagationMs` (15 min) passed with nothing in sight. Without `allowPurchases` the client has no `purchaseReservation` at all. vps's `providerAccounts.purchaseReservation` is root-only, needs `confirm: true`, and buys exactly once.
- **Policy.** `aws iam-policy` always grants the reservation, offering and Spot price reads, the vCPU quota reads and launches into reservations (any owner's ARN, so RAM-shared ODCRs work with `--account`); `--spot`, `--pricing` and `--allow-purchases` add Spot launches, the Price List and buying (only tagged `better-compute:managed=true`).

The vCPU quota codes beyond standard, G/VT and P (and their Spot twins) are marked _verify_ in `src/markets/quotas.ts`, as are the resource types `PurchaseCapacityBlock` authorizes against.

## Discovery and attach

`discover` yields every instance that is not terminated (only those tagged `discoverTag`, when set). `claim` writes `better-compute:instance` (and `better-compute:managed` when deletion is handed over) and re-reads: EC2 tags have no compare-and-swap, so a re-read naming another instance is a lost race (`CONFLICT`). Tag reads lag behind writes too: a re-read that does not show the tag (or `managed`) yet is `UNAVAILABLE` (reason `tag-propagation`, retried), and so is a `delete` right after a managed claim that does not see `managed` yet. The vps unique index on the external id referees between control planes. `release` removes the tags only when they name the instance. Deleting an attached instance detaches it by default and leaves it running.

## Networks

`AwsCompute.networks` implements tenant networks (`ProviderNetworks`, AWS phase A2) with `subnetScope: 'zone'` and `denyRules: 'network-wide'`; `zoneRegion` maps `us-east-1a` and Local Zones to their region. Everything it makes is tagged `better-compute:managed=true` and `better-compute:network=<network>` and found again by tag:

- `ensureNetwork`: a VPC (the spec's `cidr`, default `10.64.0.0/16`, private /16 to /28; or an `ipamPoolId` allocation), DNS support and hostnames, an internet gateway and the main route table's `0.0.0.0/0` route. The default network ACL's allow-all moves from rule 100 to 32766 (added before the old one goes), so deny entries come first.
- `ensureSubnet`: needs a zone of the account; a range outside the VPC gets its /16 (or itself) associated first; `MapPublicIpOnLaunch` follows `associatePublicIp`; `privateGoogleAccess` adds S3 and DynamoDB gateway endpoints. A subnet that exists with another range or zone, or a range held by a subnet better-compute did not make, is `error`.
- `ensureFirewall`: allows go to `bc-net-<network>` (no targets) or to the group named after each target tag, with one `better-compute:firewall:<name>` tag per rule that wants a security group rule; the set is diffed and revoked by `SecurityGroupRuleId`, and a rule better-compute did not make is only tagged and untagged. Denies become entries on the VPC's ACL numbered `100 + priority/10` (shifted past taken ones, `INVALID_INPUT` at 32766), each owned through the ACL tag `better-compute:deny:<direction>:<n>`, written before the entry. A targeted deny, a deny on an adopted VPC, and destinations on ingress (or sources on egress) are `error`.
- `setTags`: the network's group and one group per tag on the primary interface, other groups kept; the instance must carry `better-compute:instance` naming it. Tags are `bc-…` but never `bc-net-…` (a network group's name), and the interface limit (`securityGroupsPerInterface`, default 5) is checked before any group is made (`QUOTA_EXCEEDED`). A tag group nothing uses any more (no interface has it, no firewall rule targets it) is deleted by a later `ensureNetwork`, `ensureFirewall` or `setTags` of its VPC, adopted VPCs included: at most one sweep per VPC every 10 minutes, and only after two sweeps a consistency window apart both saw it unused. `create` on a network launches in the network's subnet in the offer's zone (`INVALID_INPUT`, reason `subnet-zone`, otherwise) with those groups.
- Deletes go endpoints, subnets, security groups, gateway, VPC; `DependencyViolation` is `pending`. A VPC without the network tag is never deleted.

`aws iam-policy --phases A1,A2` adds the network statements (`networksIamStatements`): creates must carry `aws:RequestTag/better-compute:managed=true`, changes and deletes need the tag on the resource, rule and ACL tag edits are limited to their keys, and group swaps need `better-compute:instance` on the instance (or the primary interface: RunInstances tags it, and setTags tags a claimed multi-interface machine's with that key only). AWS creates a VPC's main route table and default ACL untagged, so ensureNetwork tags both `better-compute:network` before editing them, and route and ACL entry edits need that tag; a route may only name a managed internet gateway. (verify) whether `ec2:CreateAction` covers rule tags on `AuthorizeSecurityGroup*` and which resources `CreateVpcEndpoint` names, against the live suite.

## Events

`pollEvents` is the account's event intake (A4, AD12), read by vps's `vps.provider-events` worker. With `eventQueueUrl`, it long-polls the queue (`ReceiveMessage`, at most 10 messages, `WaitTimeSeconds` at most 10) and maps EventBridge envelopes:

| `detail-type`                                                 | Event                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `EC2 Instance State-change Notification`                      | `machine-changed`                                            |
| `EC2 Spot Instance Interruption Warning`                      | `interruption-warning`, deadline = event time + 2 minutes    |
| `EC2 Instance Rebalance Recommendation`                       | `rebalance-recommended`                                      |
| `AWS Health Event` (service `EC2`, naming instances)          | `maintenance-scheduled` per instance, deadline = `startTime` |
| Capacity Reservation, Capacity Block and ODCR types (by name) | `reservation-changed`                                        |
| `AWS API Call via CloudTrail` (succeeded EC2 instance calls)  | `api-call` per instance                                      |
| `GuardDuty Finding` (when `aws.guardduty` is allowed)         | `health`                                                     |

An envelope counts only when its `account` is the account's verified AWS id, its `region` the account's region and its `source` allowed. Everything else (and anything malformed) is dropped, with counts logged and no message content, and deleted with the batch, so a forged message is read once and never loops. Messages are deleted (`DeleteMessageBatch`) only when vps calls the batch's `ack()`, after its transaction commits; a queue in another AWS account than the identity is `INVALID_CONFIG`. Events only wake reconcilers early: polling stays the source of truth, so a forged event can at worst cause a harmless re-read. The Capacity Reservation detail-type names are matched by pattern until they are verified against AWS.

Without a queue, `pollEvents` reads scheduled events with `DescribeInstanceStatus` at most every 5 minutes and reports each as `maintenance-scheduled`; the event id carries its status, so a completed or canceled event is new.

`better-compute aws event-rules --queue-name <name> --account <id>` prints the CloudFormation stack to deploy in the account: the queue and its dead-letter queue (SSE-SQS, 14-day retention), the EventBridge rules (`--api-calls` adds CloudTrail EC2 calls, `--guardduty` GuardDuty findings), and a queue policy that lets only `events.amazonaws.com` send, only from those rule ARNs in the account, only over TLS, and denies `sqs:SendMessage` to every other sender (a same-account role with `sqs:SendMessage` on `*` included: its forged body could otherwise carry the right account, region and source). Its `QueueUrl` output is `eventQueueUrl`. `aws iam-policy` includes `ec2:DescribeInstanceStatus`, and `--event-queue <name>` adds `sqs:ReceiveMessage` and `sqs:DeleteMessage` on the queue. Add `awsEventRulesCommand()` to the CLI configuration next to the policy commands.

## ML fabric

Phase A10 (`src/placement.ts`, `src/topology.ts`, `src/filesystems.ts`):

- **Placement groups.** A create's `placement` (`{ group, strategy: 'cluster' | 'spread' | 'partition', partition? }`) sets `Placement.GroupName` (and `PartitionNumber`). The group is read with `DescribePlacementGroups` and made when absent with `CreatePlacementGroup`, tagged `better-compute:managed=true` (partition groups get 7 partitions); a group made or read is trusted for an hour. A `Duplicate` answer is read again, and a group EC2 does not show yet is `UNAVAILABLE` (`placement-group-propagating`), never launched into blind. A group better-compute did not make is `CONFLICT` (`placement-group-foreign`): it is never adopted. Another strategy is `CONFLICT` (`placement-strategy`), a deleting group `UNAVAILABLE` (`placement-group-deleting`), and a placement with a reservation offer (`@cr-…`) `INVALID_INPUT` (`placement-reservation`).
- **EFA.** With `efa: 'auto'`, a type whose `NetworkInfo` reports EFA launches with one `InterfaceType=efa` interface per network card, up to `MaximumEfaInterfaces`: card 0 as device 0, every other card as device 1, and no public address when there is more than one interface (EC2 refuses it), even with `associatePublicIp: true`: the provider warns once per type (`efa-public-ip`), so reach such machines over their private addresses or attach an Elastic IP yourself. EFA needs explicit interfaces, so a launch without a subnet is `INVALID_CONFIG` (`efa-subnet`) rather than a machine without its fabric. EFA traffic also needs the security group to allow all traffic from itself: with `efa: 'auto'`, `ensureNetwork` gives the network's group (`bc-net-<network>`, on every interface of its machines) an all-traffic ingress and egress rule naming the group itself, tagged `better-compute:efa` and no firewall key, so firewall changes never revoke it; with `efa: 'off'` the next `ensureNetwork` revokes the rules it made. Every machine of an EFA network can then reach every other one on any port. A launch on `subnetId` and `securityGroupIds` (no network) needs that rule in those groups already. (verify) whether the newer `efa-only` interface type should take the secondary cards on p5.
- **Topology.** `get`, `list` and `discover` of a running machine of an EFA family read `DescribeInstanceTopology` (once an hour per machine; `list` and `discover` ask for up to 100 machines in one read) and label it `topology.aws/network-node-1..N`, top to bottom, so every path shows the same labels. A malformed answer is no topology; a failed read warns once, leaves the labels out and is asked again after a minute (after the hour when the account may not read topology: `ACCESS_DENIED`, `UNAUTHENTICATED`, `UNSUPPORTED`); a tag never poses as one of these labels.
- **Neuron.** `NeuronInfo` devices are the machine's `gpus`: Trainium `TRN1`, Trainium2 `TRN2`, Inferentia `INF1`, Inferentia2 `INF2` (an unknown name is `other`), so flavors and `gpuModel` queries treat them like GPUs. (verify) bcd's inventory model strings for `/dev/neuron*`.
- **Graviton.** Offers carry `arch`, image aliases resolve the arm64 build on arm64 types, and an AMI whose `DescribeImages` architecture the type cannot run is `INVALID_INPUT` (`image-arch`) before `RunInstances`.
- **Shared filesystems.** `filesystems` (`ProviderFilesystems`, kinds `nfs` and `lustre`; sub-plan `docs/superpowers/plans/2026-11-05-aws-a10-shared-filesystems.md`). `nfs` is Amazon EFS: `CreationToken` = the filesystem name, general purpose, elastic throughput, always encrypted (`kmsKeyId` when set), and one mount target per zone in the network's subnet there (the first by name; a zone that gains a subnet gets one on the next ensure). `lustre` is FSx for Lustre in one zone (`zone`, default the account's first): `SCRATCH_2`, or `PERSISTENT_2` at 125 MB/s/TiB with `deployment: 'persistent'`; 1200 GiB or a multiple of 2400 GiB, refused before any call otherwise (`filesystem-size`). Both sit behind the filesystem's own group `bc-fs:<name>`, which allows NFS (2049) or Lustre (988, 1018-1023) from the network's group only, and Lustre also from itself; its rules carry `better-compute:filesystem` and no firewall key. The group names the network's group, so the network is not deleted before its filesystems. Only networks better-compute made take filesystems (an adopted VPC is `error`), and a file system without `better-compute:managed=true` is never adopted or deleted (`INVALID_STATE`, `filesystem-foreign`). `deleteFilesystem` deletes the mount targets, then the file system (persistent Lustre skips the final backup), then the group. The ready state's `mount` (`nfs4` `<fs>.efs.<region>.amazonaws.com:/`, or `lustre` `<dns>@tcp:/<mountName>`) is what a create's `mounts` takes: they are checked against those shapes, a plain absolute path outside the system directories, and plain options (`INVALID_INPUT`, `mount`), and packed as a `text/x-shellscript` part before the tenant's part (client install, an fstab line with `nofail`, `mount`). It is a shell part because cloud-config parts merge with replace, so a tenant `runcmd` would drop it. (verify) The Ubuntu Lustre client needs the FSx apt repository.
- **Capacity Block proposals.** vps's `vps.purchase-proposals` worker proposes a Capacity Block 48 hours before a `pending` capacity reservation of a provider pool on a platform account starts: `listReservationOfferings` for whole machines of the pool's GPU flavor covering the reservation (block lengths of whole days up to 14 days, whole weeks up to 182), the covering block that starts latest. Root reads them with `providerAccounts.purchaseProposals` and buys one with `purchaseReservation` (confirmed, `allowPurchases`); nothing is bought on its own. Instances on the vps filesystems group (`instances.create` `filesystems`) get the mounts above.

`aws iam-policy --phases A1,A10` adds `MlFabricRead` (`DescribePlacementGroups`, `DescribeInstanceTopology`), `CreatePlacementGroup` only with `aws:RequestTag/better-compute:managed=true` (and the tag on create), and `RunInstances` on `placement-group/*` only when the group carries that tag. For filesystems it adds `FilesystemRead` (EFS and FSx describes), `FilesystemCreate` (EFS and FSx creates only with `aws:RequestTag/better-compute:managed=true`), tag-on-create only (`elasticfilesystem:CreateAction`, `fsx:CreateAction`), `FilesystemManageOwned` (mount targets and deletes only on file systems carrying that tag), `FilesystemEc2Read` (`DescribeSubnets`, `DescribeNetworkInterfaces`, `DescribeSecurityGroups` on `*`: EC2 describes have no resource-level permissions), `FilesystemMountTargetInterfaces` (`ec2:CreateNetworkInterface` and `DeleteNetworkInterface` on the account's subnets, security groups and interfaces in the region, which EFS requires of the caller for a mount target; EFS does not set `aws:CalledVia` and its interfaces carry no tag of ours, so this cannot be narrowed further), and `FilesystemServiceRoles` (`iam:CreateServiceLinkedRole` for the EFS and FSx service-linked roles, which an account's first create makes). Their groups and rules come from A2, so filesystems need `--phases A2,A10`. (verify) `fsx:CreateAction` and the mount target statements against the live suite.

## What comes next

EBS volumes (A5), EC2 hosts joining as bcd nodes (A6), workload roles (A7), EKS (A9), and costs (A11), per `docs/superpowers/plans/2026-10-18-aws-integration-program.md`.

## Testing

`tests/support/aws-emulator` emulates STS, IMDS, EC2, VPC (`vpc.ts`, which wraps the EC2 emulator) and the SQS intake queue in process through `fetch`. `tests/provider-aws*.test.ts` cover the config, credentials, offers, compute, attach, networks, the CLI policies and the `providerConformanceCases()` suite; `tests/aws-end-to-end.test.ts`, `tests/aws-networks-end-to-end.test.ts` and `tests/aws-events-end-to-end.test.ts` (interruptions, forged events) drive the provider through vps on PGlite. No test calls AWS.

## License

Apache-2.0.
