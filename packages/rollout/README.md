# @better-compute/rollout

Signed `bcd` releases and wave rollouts for better-compute: it registers offline-signed daemon releases and upgrades nodes wave by wave within each pool's disruption budget.

## Install

```sh
npm install @better-compute/rollout
```

It is also included in the umbrella package as `better-compute/rollout`:

```sh
npm install better-compute
```

## Usage

```ts
import { betterCompute } from '@better-compute/server';
import { rolloutModule } from '@better-compute/rollout';

const compute = betterCompute({
  // database, secret, baseURL, iam, ...
  modules: [
    rolloutModule({
      release: { pins: ['sha256/…'], threshold: 1 },
      downloadsUrl: 'https://compute.example.com/api/compute/downloads',
    }),
  ],
});
```

`rolloutModule(options)` needs `release.pins` (the `sha256/<base64>` SPKI pins of the offline release keys; `threshold`, default 1, is how many of them must sign) and an `https` `downloadsUrl`, where `bcd` binaries are served as `{downloadsUrl}/bcd/{version}/linux-{arch}`. `every` (default `30s`) sets how often active rollouts advance.

bcd, the Go node agent this package upgrades, is built and tested against simulated and fake hardware, but is not released as a binary yet.

## How it works

- **Releases.** `releases.register` accepts a manifest signed offline (`better-compute release sign`). It must be signed by `release.threshold` of the pinned keys and be for product `bcd`. Its `sequence` must move past every registered release, so the release channel never rolls back. Registering the same manifest again does nothing. The bare `linux-<arch>` binaries are recorded per platform. `releases.list` lists them.
- **Rollouts.** `rollouts.create { version, poolIds?, waves?, maxFailureRatio?, soakSeconds?, upgradeTimeoutSeconds? }` works as follows:
  - It snapshots every node with desired state in the tenant's pools, in an order shuffled by the rollout id.
  - It splits them into waves of cumulative percentages (default 1/10/50/100).
  - A node that is already in an active rollout makes the call fail with `CONFLICT`, so each node has one writer.
- **The controller** (reconciler `rollout`, periodic key `all` every 30 s) runs these steps:
  1. **Starts nodes.** It starts pending nodes of the current wave within each pool's disruption budget. The budget is `policy.disruptionBudget`, default 5%, and is shared with provision's remediation. A node counts as disrupted while it has an active workflow or a rollout upgrade in flight. Starting a node sets `NodeSpec.daemon = { version, url, sha256 }`.
  2. **Settles nodes.** A node succeeds when it rejoins reporting that version (`node_sessions.daemon_version`). It fails after `upgradeTimeoutSeconds`, and then goes back to its previous version.
  3. **Pauses on failures.** It pauses the rollout (`rollout.paused`) when a wave's failed / (succeeded + failed) exceeds `maxFailureRatio`.
  4. **Soaks.** It waits `soakSeconds` from the last node of a wave before starting the next wave (`rollout.wave`), then completes (`rollout.completed`).
  5. **Skips offline nodes.** Offline nodes are skipped. After completion, every node of the covered pools gets the version as its default.
- **Pause, resume, abort.** `rollouts.pause|resume|abort`. `abort { rollback: true }` sends nodes whose upgrade is still in flight back to the version they ran before, when that release is registered. A node that already confirmed the new release refuses older binaries, so a bad confirmed release is undone by rolling forward to a release with a higher sequence.
- **`daemon.upgrade`** is a self-terminating command kind whose payload is the same `DaemonSection`. It is meant for sessions restricted to upgrades: daemons below the server's minimum protocol version get it as a command, since they would not apply `NodeSpec.daemon`.

Every method decides `compute:fleet:admin` on the fleet scope. Migration: `rollout/0001_rollouts`.

## Documentation

- [Rollouts](https://better-compute.com/docs/guides/rollouts)
- [Daemon delivery](https://better-compute.com/docs/daemon/delivery)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
