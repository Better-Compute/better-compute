# @better-compute/provider-aws

The Amazon EC2 provider for better-compute. EC2 instances (GPU instances included) become the instances of provider pools, with the same API, reconcilers and guarantees as the other cloud providers: offers, create, get, delete, power, reinstall, list, and discovery and attach; managed Kubernetes runs on EKS. It calls AWS over plain `fetch` through [`@better-compute/aws-core`](../aws-core) (SigV4, the EC2 protocol, credentials); there is no AWS SDK.

It is not in the `better-compute` umbrella: install it where you use it.

```sh
pnpm add @better-compute/provider-aws
```

```ts
import { vps } from '@better-compute/vps';
import { aws } from '@better-compute/provider-aws';

vps({ providers: [aws] });
```

`aws` is `awsProvider()` with default options. `awsProvider({ fetch, endpoints, credentials, externalIdPrefix, platformAccounts, rateLimit, consistencyWindowMs, ssmImagePrefixes, kubeTransport })` takes host options: `credentials` is the host's own AWS identity (default: the ambient chain of environment, web identity, container and IMDSv2 credentials), `platformAccounts` lists the AWS account ids a tenant's role may never be in, `endpoints` (`ec2`, `sts`, `eks`) is for emulators and VPC endpoints, and `ssmImagePrefixes` lists private SSM parameter prefixes raw images may name (see Images). None of them come from account config.

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
| `instanceProfile`   | –          | The instance profile ARN passed to every `RunInstances` of the account. Never give its role an EKS access entry: see `eksNodeInstanceProfile`.   |
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

## Managed Kubernetes (EKS)

The provider implements `ProviderImpl.kubernetes` on Amazon EKS, so [`@better-compute/kubernetes`](../kubernetes) (`kubernetesClusters`, `kubernetesNodePools`, short-lived kubeconfigs) works on an AWS account as it does on GKE. Clusters are regional: the location is the account's `region`. The account needs `eksClusterRoleArn`, `eksNodeRoleArn` and, unless a cluster names its subnets, `eksSubnetIds`.

| Field               | Meaning                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `eksClusterRoleArn` | The IAM role new clusters run as.                                                                         |
| `eksNodeRoleArn`    | The node IAM role of managed node groups and EKS Auto Mode nodes.                                         |
| `eksSubnetIds`      | Default subnets of new clusters (two or more, in two or more zones); node groups use the cluster subnets. |
| `eksNodeInstanceProfile` | The instance profile of EC2 machines that join an EKS cluster (`policy.kubernetes.eks`); its role holds the `EC2_LINUX` access entry. Only those launches get it, and they get nothing else. |

- **Clusters.** `standard` is a cluster whose nodes are managed node groups; `autopilot` is EKS Auto Mode (EKS runs the compute, block storage and load balancing; there are no node pools). Every cluster authenticates through access entries only (`authenticationMode: API`): there is no `aws-auth` ConfigMap, and the creator (the account's own principal) gets the cluster-admin access entry. The release channel maps to EKS's support policy (`extended` to `EXTENDED`, the others to `STANDARD`; EKS has no rapid, regular or stable channels and upgrades only when `version` asks). In place, one update at a time: the support policy, the version (one minor per `UpdateClusterVersion`, as EKS upgrades; never down) and the authorized networks (`publicAccessCidrs`; empty means `0.0.0.0/0`). The mode, VPC, subnets and private nodes are immutable (`INVALID_STATE`); with `privateNodes` no subnet may have `MapPublicIpOnLaunch`. A network's `subnet` may list several subnet ids, comma-separated. Deleting a cluster deletes its node groups first. Clusters and node groups carry `better-compute:managed=true`.
- **Node groups.** Counts are per zone, as on GKE: a node group's sizes are the pool's times the zones of its subnets (all of the cluster's, or those in `zones`). AL2023 AMIs follow the instance type: NVIDIA for GPU types (with the taint `nvidia.com/gpu=:NoSchedule`, as GKE's GPU pools have), arm64 for Graviton, Neuron for Inferentia and Trainium. `spot` is `capacityType: SPOT`. `accelerators` must match the type, since EKS attaches none (`nvidia-l4` x 1 on `g6.xlarge`). `diskType` is refused: managed node groups without a launch template use the AMI's. With `autoscaling` the bounds are the group's min and max size and a cluster autoscaler in the cluster owns the desired size. Only the size and the bounds change in place.
- **Credentials.** The account principal reaches a cluster's API with an `eksToken` (aws-core: a presigned STS `GetCallerIdentity` signed with the `x-k8s-aws-id` header) through its access entry, which the driver creates with `AmazonEKSClusterAdminPolicy` at cluster scope on a cluster another principal made. Each subject gets a service account in `bc-access` bound to the built-in `view` or `cluster-admin` ClusterRole, or for `edit` to `better-compute:edit`, and a TokenRequest token for the requested lifetime. `better-compute:edit` is `view` plus the built-in edit's writes without `impersonate` on service accounts and without `serviceaccounts/token`: the built-in edit would let an edit subject act as any service account of `bc-access`, an admin subject's included. Before the first token the driver also writes the ValidatingAdmissionPolicy `better-compute-access-guard`, which refuses every create, update, delete and connect (exec, attach, port-forward) in `bc-access` and `kube-system` by a `bc-access` subject that cannot escalate ClusterRoles (all but cluster-admin), so pods, token secrets and exec there cannot borrow another service account. A cluster without that API (before Kubernetes 1.30) gets no credentials (`INVALID_STATE`). Service accounts of other namespaces stay reachable to edit subjects, as Kubernetes' edit is designed. Nothing is stored and no token is logged. A cluster that authenticates through the ConfigMap only is `INVALID_STATE`.
- **Versions** come from `DescribeClusterVersions`: the `rapid`, `regular` and `stable` channels list the versions in standard support, and `extended` adds those in extended support.
- **Discovery.** `kubernetes.listClusters` lists every cluster of the region, with the nodeadm settings of the ready ones (`policy.kubernetes.eks`), so EC2 machines can join an EKS cluster through `k8s-join` mode `eks`. The vps method `providerAccounts.clusters` (`compute:providers:read` on the account) returns that list. A provider pool whose policy names one (`policy.kubernetes.eks`, with `platformOperated` on a platform site) launches every machine of the pool owner (a tenant the pool is offered to would get root on a cluster node, so its launches fail closed) with nodeadm's `NodeConfig` as the first part of its user data, the SSH keys and the tenant's user data as further parts of the same multipart; use an `eks-al2023-<k8s>` image. Those launches, and only those, carry the account's `eksNodeInstanceProfile`, whose role has the cluster's `EC2_LINUX` access entry (without it they fail closed, `INVALID_CONFIG`). Never give that entry to the role of `instanceProfile`: every machine of the account gets it, including those of pools offered to other tenants, whose root could then register a Node in the cluster.

`aws iam-policy --eks-cluster-role <arn> --eks-node-role <arn>` adds the EKS statements: reads; `CreateCluster` and `CreateNodegroup` only when they tag `better-compute:managed=true`; updates and deletes only of resources tagged so; an access entry only for the caller's own principal (`eks:principalArn` equal to `${aws:PrincipalArn}`) with only the cluster-admin access policy at cluster scope; `iam:PassRole` of the two roles to EKS; and the EKS service-linked roles. `--eks-node-instance-profile <arn>` adds `iam:PassRole` of that profile's role to EC2. Host options: `endpoints.eks` (emulators, VPC endpoints) and `kubeTransport` (the transport to a cluster's API; by default `node:https` trusting only the cluster's CA).

### Hosted mode and nodeadm

[`@better-compute/provider-kubernetes`](../provider-kubernetes) runs bcd as a DaemonSet in an existing EKS cluster: select a node group with `nodeSelector: { 'eks.amazonaws.com/nodegroup': '<name>' }` and tolerate `nvidia.com/gpu` `NoSchedule` on GPU node groups. Machines of a provider pool join an EKS cluster instead through `policy.kubernetes.eks` (`k8s-join` mode `eks`): provision's `eksUserData` puts nodeadm's `NodeConfig` (`node.eks.aws/v1alpha1`) into the user data of an AL2023 EKS AMI (alias `eks-al2023-<k8s>`), and the node authenticates as the role of the account's `eksNodeInstanceProfile`, which needs an `EC2_LINUX` access entry on the cluster.

## What comes next

Networks (A2), capacity reservations, Capacity Blocks, Spot and prices (A3), event intake and Spot interruptions (A4), EBS volumes (A5), EC2 hosts joining as bcd nodes (A6), workload roles (A7), placement groups and EFA (A10), and costs (A11), per `docs/superpowers/plans/2026-10-18-aws-integration-program.md`.

## Testing

`tests/support/aws-emulator` emulates STS, IMDS and EC2 in process through `fetch`, and `tests/support/eks-emulator.ts` EKS and the clusters' Kubernetes API (it verifies each eksToken's signature and the principal's access entry); `tests/provider-aws-eks.test.ts` and `tests/kubernetes-eks.test.ts` cover managed Kubernetes. `tests/provider-aws*.test.ts` cover the config, credentials, offers, compute, attach, the CLI policies and the `providerConformanceCases()` suite; `tests/aws-end-to-end.test.ts` drives the provider through vps on PGlite. No test calls AWS.

## License

Apache-2.0.
