Sites are boot and failure domains: every pool and node belongs to one site. Platform sites (`shared`, `dedicated`) belong to the root tenant; a tenant's own hardware lives on its `custom` sites. A tenant sees the sites the authorization projection holds for it. See [Sites](/docs/guides/bare-metal/sites).

## list

Lists the sites visible to the tenant in id order, filtered by `kind` or `region`.

The call is decided once on `compute-tenant/{tenantId}`, then each site is checked for `compute:sites:read`; sites the caller may not read are left out, so a page can hold fewer than `limit` items. Pages hold up to 50 sites.

## get

Returns one site: its kind, region, IAM region and version.

A site the tenant cannot see is `NOT_FOUND`.

## create

Creates a site and adds it to the authorization projection with its region and kind as IAM attributes.

A `custom` site is decided on `compute-tenant/{tenantId}`; a `shared` or `dedicated` site on `compute-fleet/global`, and its `tenantId` must be the root tenant, otherwise the call is `INVALID_INPUT`. `iamRegion` names the IAM region when it differs from `region`.

The site id derives from the tenant, the calling identity and `idempotencyKey`. A retry with the same key returns the site without a new IAM decision; the same key with a different kind, region or IAM region is `CONFLICT`. Publishes `site.created`.

## update

Changes a site's `region` or `iamRegion`, or clears `iamRegion` so IAM uses `region`, and returns the site.

Only the owner tenant can update a site; a deleted site is `NOT_FOUND`. Naming no change, or both `iamRegion` and `clearIamRegion`, is `INVALID_INPUT`, and a stale `version` is `CONFLICT`. An update that changes nothing returns the site unchanged. Otherwise the new attributes reach every tenant that sees the site, and `site.updated` is published.

## delete

Deletes a site that has no unarchived pool and no undeleted node.

Only the owner tenant can delete a site. A site with live pools or nodes is `INVALID_STATE`, and a stale `version` is `CONFLICT`. The call revokes the site's join and site tokens, expires its pending and approved join requests, drops its boot lease and removes it from the projection. The row is removed when nothing references it and tombstoned otherwise (`tombstoned: true`).

A retry after the delete returns `deleted: false`. Publishes `site.deleted`.
