Cloud resources are a provider's managed data and platform services (managed databases and what lives in them, App Platform apps, Functions, Marketplace add-ons, partner attachments), served by the `@better-compute/cloud-resources` module through the provider-neutral `ProviderResources` contract. One table, one reconciler and these calls serve every kind a provider lists: DigitalOcean today (`do.database.pg`, `do.app`, …), AWS and GCP kinds later under their own prefixes. A resource belongs to one provider pool, so to that pool's account. Two hosting models use the same calls: a platform account's pool offered to the tenant (the resource lives on the platform's account, which other tenants share), or a pool on the tenant's own account. The calls record what the tenant wants and return at once; the `cloud.resources` reconciler then creates the resource at the provider, applies changes in place and deletes what the tenant deleted. `state` shows where it is: `pending`, `provisioning`, `ready`, `updating`, `deleting`, `deleted`, `released` or `error` (with a `message`). Resources still converging are looked at every 30 seconds; ready and failed ones are refreshed every five minutes, which retries an error and picks up what changed at the provider.

A resource's provider-side name is `bc-r-` and 24 characters of its id, and it carries the ownership labels `better-compute-managed`, `better-compute-resource` and `better-compute-tenant` (as tags where the provider has no labels). Secret outputs (a database password, a connection URI that embeds it, a namespace key) are sealed into the secret store in the reconciler run that received them; a resource returns only their `SecretRef`s in `secretOutputs`, and the values never reach a row, an event or a log. A resource bills `cloud.resource.hours` (one per hour, to the tenant) from the moment the provider first accepted it (an adopted one from its first `ready`) until it is deleted or released, on pools whose billing mode is `metered` or `platform-fee`; a kind's own meters bill only when the operator names them in `cloudResources({ kindMeters })`.

Every call is decided on `compute-cloud-resource/{id}` (or the tenant, for listings) with the attributes `kind`, `family` (`data`, `platform`, `ai`, `storage`, `network`, `edge`, `observability`), `provider`, `providerAccountId`, `poolId`, `region` and `projectId`. One action set serves every family; a policy narrows it by attribute: `StringEquals: { 'resource.family': 'data' }` allows a team managed databases without allowing App Platform.

## kinds

Returns the kinds the pool's provider serves: for each its `family`, the JSON Schema of its `spec`, the plain `outputs` and `secretOutputs` it reports, whether it is `regional`, which spec fields are `updatable` in place, its `meters`, its `parent` kind (a database user lives in a cluster), whether it is a provider `preview` and `available` on this account (previews need `previews: true` on the account), and the tenant's `quota` of it. A pool that is not a provider pool, or whose provider serves no cloud resources, is `UNSUPPORTED` (`NOT_FOUND` for a pool the tenant cannot see). Decided as `compute:cloud-resources:read` on the tenant.

## catalog

Returns the installable applications the pool's provider lists (DigitalOcean's 1-Click apps), at most 1000, optionally only those with `installsOn` `instance` (the slug is the image of an instance create) or `kubernetes` (an add-on of a managed cluster). Read-only: they are installed through those surfaces, never through `create`. The provider is asked with no transaction open. A provider without a catalog is `UNSUPPORTED`. Decided as `compute:cloud-resources:read` on the tenant.

## create

Records a resource and returns it `pending`.

- The pool must be visible to the tenant and a `provider` pool whose provider serves the `kind`; otherwise `UNSUPPORTED` (`NOT_FOUND` for a pool the tenant cannot see). A preview kind on an account without previews, or a kind with secret outputs on a deployment without a secret store, is `UNSUPPORTED`.
- `spec` (at most 64 KiB of JSON) is validated by the kind's manifest (`INVALID_INPUT`, with the field under `spec.`). A regional kind's `spec.region` must be a region the account configures. A secret in a spec is a `SecretRef` to the tenant's own secret (`secret://<tenant>/…`), resolved only just before the provider call.
- On a shared (hosted) account, a spec that reaches account-wide objects (a VPC, a container registry, linked repositories, a database cluster by name, Droplet tags or ids as trusted sources) is `INVALID_INPUT` with `details.reason` `accountWide` and the fields; on the tenant's own account it may. A spec may instead name the tenant's instances (a database's trusted `instances`): each must be a live instance of the tenant on the pool's account, otherwise `INVALID_INPUT` with `details.reason` `instance` (the same for one that does not exist).
- A kind with a parent names it in `parentId`: a resource of the parent kind on the same account, not being deleted. A kind that declares an identity within its parent (a database user's name; a cluster's single firewall) allows one live resource of it per parent: a second is `CONFLICT` with `details.reason` `identity` and the `resourceId` that has it.
- `name` is 1 to 63 characters, `[a-z]([-a-z0-9]*[a-z0-9])?`, unique per kind among the tenant's resources that are not deleted or released (`CONFLICT` otherwise).
- A tenant that already has its quota of the kind (the module's `maxPerKind`, default 20, or a per-kind `quotas` entry; one being deleted still counts) is `QUOTA_EXCEEDED`, with the cap in `details.limit`.
- Decided as `compute:cloud-resources:create` on the resource it would create, with its kind and family as attributes. A refusal leaves nothing behind. After the decision the tenant's offer is checked (a suspended offer or an excluded region refuses), and the tenant's budgets unless the pool's billing mode is `none`.

The resource id derives from the tenant, the caller and `idempotencyKey`. A retry with the same key returns the same resource; the same key with any other field changed is `CONFLICT`. The caller owns the resource. Publishes `cloud.resource.created`, then `cloud.resource.ready` the first time it is ready (with the names of its outputs and secret outputs) or `cloud.resource.failed`.

## list

Returns the tenant's resources, oldest first; `poolId`, `projectId`, `kind` and `family` narrow it, and `includeDeleted: true` adds deleted and released ones. At most 500 are returned. Decided as `compute:cloud-resources:read` on the tenant.

## get

Returns one resource with its spec, `providerId` once the provider accepted it, `outputs`, `secretOutputs` (SecretRefs only) and state. A resource of another tenant is `NOT_FOUND` here, and is refused by the decision (`ACCESS_DENIED`) before that. Decided as `compute:cloud-resources:read` on the resource.

## update

Merges `spec` onto the stored spec and validates the result with the kind's manifest; `description` is better-compute's alone. A change to the kind's `updatable` fields is applied in place: a `ready` or failed resource goes `updating` and back to `ready` (`cloud.resource.updating`, then `cloud.resource.updated`). A change to any other field is `INVALID_STATE` with `details.reason` `replaceRequired` and the fields: create a new resource instead. An adopted resource's spec cannot change before its takeover completed (`INVALID_STATE`, `adopting`); its description can. A resource being deleted or released is `INVALID_STATE`. Every update bumps `version`. Decided as `compute:cloud-resources:update` on the resource.

## delete

Marks the resource and every resource living in it for deletion and returns it `deleting`. The reconciler deletes the children first (a child created while the parent was being deleted is deleted too), then the resource at the provider; it is then `deleted`, its authorization row is removed, its sealed secrets are destroyed and `cloud.resource.deleted` is published. A resource the provider never accepted is deleted without a provider call. A resource this deployment does not manage at the provider is never deleted there: it stays in `error`. An adopted resource whose takeover never completed is let go instead (`released`, with no provider call). Deleting a resource that is being deleted returns it unchanged. Publishes `cloud.resource.deleting`. Decided as `compute:cloud-resources:delete` on the resource.

## discover

Lists the kind's resources on the tenant's own account (at most 500): each with its `providerId`, `name`, `region`, `spec` as the provider reports it, `managedBy` (`this` deployment, an `other` one, or absent: none) and the `resourceId` of the cloud resource that records it, if any. A pool on an account of another tenant (a platform pool offered to the tenant) is `ACCESS_DENIED` with `details.reason` `notAccountOwner`. The provider is asked with no transaction open. Decided as `compute:cloud-resources:read` on the tenant.

## adopt

Takes over an unmanaged resource of the tenant's own account and returns it `pending`, `adopted: true`, with an empty spec. Before anything is recorded the provider is asked for that one resource: one that does not exist is `NOT_FOUND`, one another deployment manages is `INVALID_STATE` with `details.reason` `managedByAnother`. A kind that lives in a parent cannot be adopted (adopt the parent and create its children), and a resource already recorded, or a name taken, is `CONFLICT`. The reconciler writes the ownership labels in its first run (the provider refuses there too a resource another deployment took meanwhile) and records the spec the provider reports; from then on it is observed until the tenant changes its spec, then managed like any other. A platform account is `ACCESS_DENIED` as for `discover`. Publishes `cloud.resource.adopted`. Decided as `compute:cloud-resources:create`, as for `create`.

## release

Lets a resource go: the reconciler removes its ownership labels at the provider and leaves it running, and the resource is `released` (its authorization row removed, its sealed secrets destroyed, `cloud.resource.released` published). A resource the provider has not accepted yet is `INVALID_STATE` (delete it instead), as is one that lives in a parent (release that) or one that still has live children. Publishes `cloud.resource.releasing`. Decided as `compute:cloud-resources:delete` on the resource.
