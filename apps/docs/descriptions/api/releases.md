Releases are signed bcd builds the platform may roll out to its nodes. A release is registered from a signed manifest, which must verify under the release key pins given to `rolloutModule`, and rollouts can then target its version. Both methods decide `compute:fleet:admin` on the fleet scope. See [Rollouts](/docs/guides/rollouts).

## register

Verifies a signed bcd release manifest under the configured release pins and records the release; returns it with its per-platform binaries.

- **Replay.** Registering a manifest whose version is already recorded with the same sequence returns the stored release; the same version with another sequence is `CONFLICT`.
- **Errors.** `INVALID_INPUT` when the manifest does not verify (`details.reason` says why), when its sequence is not above the latest registered one (a rollback of the release channel, `details.reason` is `rollback`), when it lists several binaries for one platform, or when it lists no Linux binary.

## list

Returns every registered release, highest sequence first.

The list is not filtered by tenant: releases belong to the platform.
