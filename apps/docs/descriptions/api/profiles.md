The profiles group stores and checks the versioned recipes that provisioning workflows run: steps, drivers, an image, user data and host config. A version becomes immutable the first time a workflow uses it. Lookups see the tenant's own profiles, public ones, and the read-only profiles that modules ship under the tenant `builtin`. See [Profiles and images](/docs/guides/bare-metal/profiles-and-images).

## create

Stores a new profile version from a profile document, `private` unless `visibility` says `public`.

- Decided as `compute:profiles:manage` on the tenant.
- The document is checked like `defineProfile`; any problem is `INVALID_INPUT`, with `details.path` naming the first offending field.
- `CONFLICT` when that id and version already exist; create the next version instead.

## get

Returns one profile version, the latest when `profileVersion` is omitted.

The lookup prefers the tenant's own profile, then a public stored one, then one a module ships. `NOT_FOUND` when none matches.

## validate

Expands a profile version against the registered steps and returns `valid` with every issue found, such as a `use` that does not resolve or a `with` its step rejects.

Problems in the profile are returned as `issues` rather than thrown; an unknown profile is `NOT_FOUND`.

## render

Returns the profile document and the expanded steps a workflow of this version would run, with their phases.

`INVALID_INPUT` when the profile does not resolve, with the problems in `details.issues`; `NOT_FOUND` for an unknown profile.

## list

Returns a page of the tenant's stored profiles, public ones and those modules ship, ordered by id and version.

`limit` defaults to 50 and is at most 200; pass the returned `cursor` to read the next page.

## update

Replaces the document of one of the tenant's profile versions, or changes its visibility, and returns the profile.

- Pass `document`, `visibility` or both; neither is `INVALID_INPUT`.
- A version a workflow has used keeps its document: `INVALID_STATE`. Its visibility can still change.
- A new document must keep the profile's id and version (`INVALID_INPUT`).
- `expectedVersion` is the profile's row `version`; a mismatch is `CONFLICT`.
- `NOT_FOUND` when the tenant has no such version.

## delete

Hides one version, or every version when `profileVersion` is omitted, from new workflows and returns the number deleted.

Workflows already started keep the profile document they snapshotted. Profiles that modules ship are not stored, so deleting one is `NOT_FOUND`, as is a profile the tenant does not have.
