A sandbox template belongs to one tenant and fixes what its sandboxes run: a hosted pool, a flavor, an image, the pool's runtime, optional user data, TTL bounds and a warm pool. For each live template the `vps.sandboxes` reconciler keeps `warm.min` instances with `desiredState` `paused`, or `stopped` when the runtime cannot pause, creating at most 4 per template in one pass and deleting those beyond `warm.max`, newest first. Warm instances are owned by the template's author, placed and charged to quota when they are created, and a refill that fails is logged and tried again on a later pass. See [Sandboxes](/docs/guides/vps/sandboxes).

## create

Checks the pool, flavor, image and runtime once and stores a template under a name unique in the tenant; returns the template.

- **Checks.** The pool must be owned by or offered to the tenant and not archived (`NOT_FOUND`), and be a hosted `vps-host` pool: a provider pool is `INVALID_INPUT`. A missing or archived flavor and an image that does not resolve are `NOT_FOUND`; `INVALID_CONFIG` when `vps()` has no `images`. The pool's runtime must boot the image's format and pass through the flavor's GPUs (`INVALID_INPUT`), and `runtime`, when given, must equal the pool's runtime (`INVALID_INPUT`). The template stores the pool's runtime.
- **Lifetime.** `defaultTtlSeconds` defaults to 3,600 and `maxTtlSeconds` to 86,400 or the default TTL, whichever is larger; both lie between 60 seconds and 30 days, and a default above the maximum is `INVALID_INPUT`.
- **Warm pool.** `warm.min` and `warm.max` are 0 to 64; `max` defaults to `min`, and a `max` below `min` is `INVALID_INPUT`.
- **User data.** At most 32 KiB. A URI must be a `secret://` reference to a secret of the same tenant, otherwise `INVALID_INPUT`.
- **Volumes.** `volumes` lists up to 8 sandbox volumes (`sandboxVolumes`) that each sandbox of the template attaches:
  - each entry names a volume by `volumeId` or by `name` (one of them), with a `mountPath` and an optional `readOnly`;
  - each volume must be the tenant's, `ready` and in the template's pool (`NOT_FOUND`, `INVALID_STATE`, `INVALID_INPUT`), and named once;
  - a mount path is absolute, without `.` or `..`, never over a system directory (`/`, `/etc`, `/usr`, `/proc`, …), and never inside another entry's (`INVALID_INPUT`);
  - a template with volumes keeps no warm pool (`warm.max` must be 0), since a warm instance would hold the volumes;
  - every sandbox of the template reads the volume, and unless it is `readOnly` writes it, so each volume is also decided on the caller's own credential: `compute:sandboxes:manage` on `compute-sandbox-volume` for a read-write mount, `compute:sandboxes:read` for a read-only one (`ACCESS_DENIED` otherwise).

  Its sandboxes run on the volumes' host only. A read-write attachment needs the volume to itself, so a second sandbox of a template that attaches a volume read-write is `CONFLICT` (`details.reason: 'volume-in-use'`) while the first lives.

A live template with the same name is `CONFLICT`. The caller becomes the template's owner in the authorization projection. Publishes no event.

## list

Returns every live template of the tenant, ordered by name, in one answer.

Each template is checked for `compute:sandboxes:read` on `compute-sandbox-template`; those the caller may not read are left out. Deleted templates are never listed.

## get

Returns one live template of the tenant.

A deleted template, or one of another tenant, is `NOT_FOUND`.

## update

Changes a template's flavor, image, user data, TTL bounds, warm pool or volumes; returns the template with its version raised.

The pool, name and runtime stay. A new `flavor` or `imageId` is checked against the pool as on `create`, and the pool must still run the template's runtime (`INVALID_INPUT`). Omitted fields keep their values, `userData: null` removes the user data, and `warm` replaces the warm pool, `max` again defaulting to `min`. A `defaultTtlSeconds` above `maxTtlSeconds` after the change is `INVALID_INPUT`. A deleted or missing template is `NOT_FOUND`. The secrets the template references are decided with the update; if another change added secret references while this one was decided, it is `CONFLICT` with `details.reason: 'secrets-changed'`: retry, and the new references are decided too. The volumes are decided the same way, each on its own resource as on `create`: a new `volumes` list, and the current one when the update changes what the guest runs (flavor, image, user data, env or network). If a volume name now points at another volume, or a mount became writable, since the decision, it is `CONFLICT` with `details.reason: 'volumes-changed'`: retry.

Sandboxes that exist keep their instances, and warm instances already created stay claimable with the shape they were created with; new sandboxes and warm refills use the new values. A lower `warm.max` makes the reconciler delete the excess. Publishes no event.

## delete

Deletes a template so that `get`, `list`, `update` and `sandboxes.create` no longer find it; returns `deleted: true`.

The template leaves the authorization projection and its name is free for a new template. Its sandboxes live on until they are deleted or expire, and the `vps.sandboxes` reconciler deletes all of its warm instances. A template already deleted is `NOT_FOUND`. Publishes no event.
