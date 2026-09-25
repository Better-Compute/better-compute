# @better-compute/provider-hetzner

Hetzner providers for better-compute (PLAN.md D8, §3.6). **`hetznerCloud`** serves Hetzner Cloud
servers as the instances of `class: 'provider'` pools. **`hetznerRobotProvider({ ssh })`** turns
dedicated servers into bcd nodes of `metal-host` or `vps-host` pools through vps's
`providerAccounts.bootstrap`.

The package sits outside the umbrella, so install it directly. It depends on
`@better-compute/core` and `@better-compute/vps`.

```ts
import { vps } from 'better-compute/vps';
import { hetznerCloud } from '@better-compute/provider-hetzner';

betterCompute({ modules: [vps({ providers: [hetznerCloud] })] });

// An account is data, validated by the provider's manifest. The token is a SecretRef, never a value.
await client.providerAccounts.create({
  tenantId,
  provider: 'hetzner-cloud',
  name: 'main',
  config: { token: 'vault://kv/hcloud', location: 'fsn1' },
});
```

## Behaviour

- **Config** is `{ token: SecretRef, location: 'fsn1' | 'nbg1' | 'hel1' | 'ash' | 'hil' | 'sin' }`.
  The token is resolved through the host's secret resolver on each request.
- **Idempotent create.** The Hetzner API has no idempotency keys. Instead, each server carries
  `better-compute.io/idempotency-key=<instance id>` and `better-compute.io/managed=true` labels.
  `create` first looks the key up. If a concurrent create wins the unique server name, it returns
  the winner.
- **Server names** are hostname-safe (`inst_01…` → `inst-01…`, at most 63 characters).
- **Offers** come from `/server_types` and `/datacenters`, both paginated.
  - They include gross hourly prices in EUR for the account's location, or the queried `region`.
  - `available` comes from that location's datacenters.
  - Deprecated types are skipped.
  - GPU and metal queries return nothing, since Hetzner Cloud has neither.
- **Power:** `on` → `poweron`, `off` → `poweroff`, `graceful-off` → `shutdown`,
  `reset`/`cycle` → `reset`, `graceful-restart` → `reboot`.
- **Other operations:** `reinstall` → `rebuild`. `list` yields only the servers this provider
  manages.
- **Errors**
  - A 404 is absent: `get` answers `undefined`, and `delete` and `power` throw `NOT_FOUND`.
  - A 429 is `RATE_LIMITED`, with `retryAfterMs` taken from `RateLimit-Reset`.
  - Everything else is `PROVIDER_ERROR`, with `details: { status, code }` holding Hetzner's
    error code.
- **Transport:** `hetznerCloudProvider({ fetch, endpoint })` swaps the transport. The tests use an
  in-memory emulator of the API, and the same hook can record or replay real traffic.

The package passes `providerConformanceCases()` from `@better-compute/vps`
(`tests/provider-hetzner.test.ts`).

## Hetzner Robot

`hetznerRobotProvider({ ssh })` (`provides: ['metal']`) turns the dedicated servers an account
already has into `metal-host` nodes that run bcd (§3.6, "platform-owned provider machines").

- **Config:**
  `{ user, password: SecretRef, rescueKeyFingerprint, rescueKey: SecretRef, image }`. The
  fingerprint names an SSH key stored in Robot, and `rescueKey` is its private key.
- **Offers** are the servers with an empty name that are not cancelled.
  - Specs come from `robotProducts` (GEX44, GEX130, AX41-NVMe, AX52, AX102, EX44) or
    `options.products`, because Robot's API reports only product names. An unknown product reports
    1 vCPU and 1 GiB until you configure it.
  - `available` means Robot says the server is `ready`.
- **`create` claims instead of ordering.** It names the server `bc-<idempotency key>`, and a retry
  finds the same claim. A server someone has named for another use is never offered or claimed
  (`CONFLICT`).
- **`delete` releases the claim** (clears the name and deactivates rescue).
  - Ordering and cancelling servers are contractual actions, left to people.
  - `get` treats unclaimed servers as absent.
- **Power** maps to Robot resets: `reset`/`cycle` → `hw`, `graceful-restart` → `sw`,
  `graceful-off`/`on` → `power`, `off` → `power_long`. Robot cannot report power state.
- **`rescue`** activates Linux rescue with the account's key, then hardware-resets into it.
- **`identify(machine)`** boots rescue (unless it already answers) and reads
  `/sys/class/dmi/id/product_uuid` over SSH, so the bootstrap token can be bound to the machine
  (`expect.productUuid`; the `provisioned` attestor refuses unbound tokens). It leaves the server in
  rescue for `bootstrap`.
- **`bootstrap(machine, { joinToken, bcdUrl, sha256 })`** runs in these steps:
  1. It reuses a rescue system that already answers, else activates rescue and waits for SSH,
     through the injected `SshExecutor` (one hardware reset for identify + bootstrap).
  2. It writes the single-use `provisioned` join token over SSH stdin into a `umask 077` file.
  3. It runs `bootstrapScript`, which calls `installimage` with software RAID 1 over the NVMe
     disks, else the SATA disks.
  4. The post-install script, built in rescue, places the token at
     `/etc/better-compute/join-token` (0600). It downloads bcd over https, checks its sha256 and
     enables it under systemd, then shreds itself.
  5. The server reboots and rescue is deactivated.

  The token never appears in user data, in argv or in the script sent over SSH.
  (`tests/provider-hetzner-robot.test.ts`; set `BC_SH` to a POSIX shell to also syntax-check the
  script.)
