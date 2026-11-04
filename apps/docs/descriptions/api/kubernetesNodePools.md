Node pools are the groups of worker nodes of a `standard` Kubernetes cluster ([kubernetesClusters](/docs/reference/api/kubernetes-clusters)); an `autopilot` cluster has none, because the provider runs its nodes. A cluster's first node pools are created with it; these calls add, resize and remove pools later. Every call records what the tenant wants and returns at once: the node pool shows `pending`, `ready`, `updating`, `deleting`, `deleted` or `error` (with a `message`), and its cluster goes `updating` until the reconciler has converged the change, then `ready` again. A node pool the provider refuses is `error`, and so is its cluster, with the pool named in its `message`, until the pool is changed or deleted. The reconciler publishes `kubernetes.nodepool.ready`, `kubernetes.nodepool.error` and `kubernetes.nodepool.deleted` on the cluster's subject. A node pool's name is also its provider-side name.

## create

Adds a node pool to a `standard` cluster that is not being deleted and returns it `pending` (`INVALID_STATE` for an autopilot cluster or one being deleted).

- `name` is 1 to 40 characters, `[a-z]([-a-z0-9]*[a-z0-9])?`, unique among the cluster's node pools that are not deleted (`CONFLICT`); a deleted pool's name is free again.
- `machineType` is the provider's machine type (`e2-standard-4`). `nodeCount` (0 to 1000) is nodes per zone of the pool; with `autoscaling` (`minNodes` 0 to 1000 not above `maxNodes` 1 to 1000) it is the initial count.
- Optional: `diskGiB` (10 to 65536) and `diskType` (`pd-balanced`), `spot`, `accelerators` (`{ type: 'nvidia-l4', count }`, 1 to 16 per node), `zones` (at most 10, zones of the cluster's region and of the account), Kubernetes `labels` (at most 32) and `taints` (at most 32, effect `NoSchedule`, `PreferNoSchedule` or `NoExecute`).
- A cluster has at most 10 node pools that are not deleted (`QUOTA_EXCEEDED`).
- With an `idempotencyKey` (scoped to the tenant, the caller and the cluster) a retry returns the same node pool; the same key with another request is `CONFLICT`.

Publishes `kubernetes.nodepool.created`. Decided as `compute:kubernetes:update` on the cluster.

## list

Returns the cluster's node pools that are not deleted. Decided as `compute:kubernetes:read` on the cluster.

## update

Resizes a node pool in place: `nodeCount`, and `autoscaling` (`null` turns it off); name at least one. A `nodeCount` outside the pool's autoscaling bounds is `INVALID_INPUT`. The machine type, disks, accelerators, zones, labels and taints never change: delete the pool and create another. The pool goes `updating` (bumping its `version`) until the provider has resized it. A pool or cluster being deleted is `INVALID_STATE`. Decided as `compute:kubernetes:update` on the cluster.

## delete

Marks the node pool for deletion and returns it `deleting`; the reconciler deletes it at the provider, and it is then `deleted` and gone from `list`. Deleting a pool that is being deleted returns it unchanged. Decided as `compute:kubernetes:update` on the cluster.
