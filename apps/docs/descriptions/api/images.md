The images group is the catalog of OS images and ramdisks that deploys write to disk. An image is registered by its digest and source URL, never uploaded, and a signature from a signer on the tenant's or the platform's allowlist marks it verified. Unsigned images stay private to their tenant; only verified images can be made public. See [Profiles and images](/docs/guides/bare-metal/profiles-and-images).

## register

Records an image by `ref` (`name@version`), format, digest and `https://` or `oci://` source in the tenant's catalog; with a valid signature it is marked verified.

- Decided as `compute:images:publish` on the tenant.
- `signature` and `signerId` go together. The signature must verify against that signer on the tenant's allowlist or the platform's, else `INVALID_INPUT`.
- A `ramdisk` must be signed by a platform signer (`INVALID_INPUT` otherwise).
- `CONFLICT` when the tenant already has that `ref`, so a repeated call does not create a second image.

The new image is private. Site agents whose pools pre-warm this ref (`policy.prewarmImages`) get their desired state refreshed.

## get

Returns one image the tenant owns, or a public one, by its `img_` id.

`NOT_FOUND` when the image does not exist, is deleted, or belongs to another tenant and is not public.

## list

Returns a page of the tenant's own images and public ones, ordered by `ref`, optionally filtered by `kind` (`os` or `ramdisk`).

`limit` defaults to 50 and is at most 200; pass the returned `cursor` to read the next page.

## promote

Makes a verified image the tenant owns public, so every tenant can read and deploy it.

Decided as `compute:images:publish` on the image. An unsigned image is `INVALID_STATE`; an image the tenant does not own is `NOT_FOUND`. Promoting an image that is already public returns it unchanged. Site agents whose pools pre-warm this ref get their desired state refreshed.
