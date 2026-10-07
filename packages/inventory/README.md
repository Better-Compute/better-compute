# @better-compute/inventory

Hardware inventory for better-compute: GPU naming, inventory sections, snapshots and diffs, devices and atoms, labels, node conditions and GPU health, plus the always-on `inventoryModule`.

## Install

```sh
npm install @better-compute/inventory
```

It is also included in the umbrella package as `better-compute/inventory`:

```sh
npm install better-compute
```

## Usage

```ts
import { normalizeGpuProduct } from '@better-compute/inventory';

normalizeGpuProduct('NVIDIA H100 80GB HBM3'); // { gpuProduct: 'H100-SXM5-80GB', gpuModel: 'H100' }
normalizeGpuProduct('NVIDIA GH200 480GB'); // { gpuProduct: 'GH200-480GB', gpuModel: 'other' }
```

`inventoryModule` is the built-in module the server registers before any injected module, so a control plane built with `betterCompute()` already has it. The package depends on `@better-compute/core` and `@better-compute/protocol`.

Inventory reports come from `bcd`, the Go node daemon, through the gateway. `bcd` is built and tested against simulated and fake hardware but is not released as a binary yet, and nothing here has run against real GPU hardware.

## What it covers

- GPU naming, section verification, diffs, devices and atoms, labels, the hardware key, and the conditions.
- The Inventory reconciler.
- `inventory.get`, `inventory.history` (snapshots newest first, paged by snapshot id) and `inventory.diff` (any two snapshots by id or hash; by default the latest against the one before).
- **Health:** `xidPolicies` and `recordXid` (48 quarantines the GPU; 79 and 95 make the node NoSchedule for a reboot; 63 and 64 cover row remaps). Inventory findings (a failed or pending row remap, uncorrectable ECC, a degraded NVLink) are applied on every inventory. Device quarantines live in `device_health`: the atom leaves placement and the node does not. Remediation runs in provision (`health` work).
- **Fractional atoms:** `gpu.slot` atoms `<uuid>/s<k>` for `timeslice`/`mps` pools (from `policy.sharing.replicas`); MIG `gpu.mig` atoms; `partitionPending` freezes a GPU during a MIG mode change; `gpuAtomFamily` feeds the capacity atom rule.
- The **hygiene sweep** (`inventory.hygiene`, a periodic singleton in `inventoryModule`, every 5 minutes): `DriverMismatch` (a converged node whose GPU driver branch differs from its `nvidia-driver` unit), `CertExpiring` (the newest identity certificate has under a tenth of its life left, at least an hour: renewal is failing) and `DaemonOutdated` (an older protocol, or `minDaemonVersion`). Each is NoSchedule plus a `node.condition.changed` event, cleared with its cause.
- **Host pressure** from `StatusReport.pressure` (Linux PSI and CPU steal): `CpuPressure`, `MemoryPressure`, `DiskPressure` with hysteresis, NoSchedule on `vps-host` pools and alert-only elsewhere (`recordHostPressure`; the gateway's `xidStatusHandler` calls it).
- **Image caches:** a node's `images` section keeps `node_image_cache` in step for the `image-cached` scorer (`imageCacheNodes`).
- Atom health edges wake the node's started reservations (`wakeStartedReservations`, work kind `capacity.reservations`), so capacity's Degraded conditions follow at once.

## From Hello to devices

1. **Report.** In the Hello transaction, and on every heartbeat that carries hashes, the gateway calls `recordInventoryHashes(tx, work, nodeId, hashes)`. It stores the hashes in `node_inventory` and returns the sections to pull (`Welcome.request_sections`): those whose stored bytes have a different hash. `recordInventoryHashesMany` does a whole batch of reports in one statement (the gateway's group commit), one result slot per report.
2. **Pull.** For each `InventorySection` frame the gateway calls `ingestInventorySection(tx, work, nodeId, section)`. The section is checked against its own SHA-256 over the received bytes (`INVALID_INPUT` otherwise) and never re-encoded. It is stored in `node_inventory_sections`, and work kind `inventory` is queued for the node. `ingestInventorySections(tx, work, entries)` stores a batch of many nodes' sections in one statement, with one result slot per entry.
3. **Apply.** `inventoryReconciler` runs `applyInventory(sql, nodeId, { events })` in one transaction with the node row locked. Once every reported section's bytes are present and the digest differs from the last applied one, it:
   - appends an `inventory_snapshots` row (decoded sections as JSON, bigints as strings);
   - plans devices with `planDevices`. GPUs become `gpu` atoms, and a MIG GPU becomes a non-bookable parent of `gpu.mig` atoms. A vanished device that still has live bookings is kept with `healthy = false` and deleted once its bookings end. A device id another node owns is left alone and raises `DuplicateIdentity`;
   - replaces the `inventory`-sourced labels (`gpu.product`, `gpu.model`, `gpu.count`, `cuda.driver.major`, `mig.capable`, `fabric.domain`, …);
   - writes `GpuCountMismatch`, `GpuModelUnknown` and `DuplicateIdentity` into `node_conditions`, and mirrors the true ones into `nodes.no_schedule_reasons` as bare type names (keeping every entry it does not own);
   - sets `hardware_key`. It is trusted with two or more independent identifiers, and a clash on the unique index is caught in a savepoint and becomes `DuplicateIdentity`;
   - publishes `node.inventory.changed` plus one `node.<change>` event per diff entry.

   A `tenant-controlled` node (a dedicated-root lease: the lessee has root) is advisory. Its set is appended as a snapshot and announced as `node.inventory.changed` with `advisory: true`, and nothing else changes: devices, health, labels, conditions, the image cache and the hardware key keep the platform's last view, and `recordXid` and `recordHostPressure` ignore its reports. Otherwise a GPU the lessee reports missing or unhealthy would leave the lease's bill. The applied digest is stored as `advisory:<digest>`. When metal ends the lease it calls `endAdvisoryInventory`, so the next report applies the same set under platform trust.

Pure building blocks: `verifySection`, `sectionsToRequest`, `mergeSections`, `inventoryDigest`, `devicesFromGpus`, `gpuLinks` (undirected GPU pairs for placement), `planDevices`, `inventoryLabels`, `inventoryConditions`, `mergeNoScheduleReasons`, `diffInventory`, `hardwareKey` / `hardwareKeyFromClaims` (join claims hash exactly like inventory).

## GPU naming

- `normalizeGpuProduct(nvmlName)` returns `{ gpuProduct, gpuModel }`.
  - Before lookup the name is canonicalized: upper case, punctuation collapsed to `-`, and a leading `NVIDIA` dropped (older drivers omit it).
  - `gpuProduct` has the form `<MODEL>-<FORM>-<MEMORY>GB`.
  - `gpuModel` is the family that pools, policies and meters use.
  - A name missing from the table keeps its canonical form as `gpuProduct` and maps to `gpuModel: 'other'`, which raises `GpuModelUnknown`.
  - Product names normalize to themselves, so the function is idempotent.
- `gpuModels` is the versioned, JSON-serializable mapping table. Adding or renaming a product bumps `gpuModels.version`.
- `gpuModelFamilies`: `H100`, `H200`, `B200`, `GB200`, `A100`, `L40S`, `L4`, `RTX-PRO-6000`, and since version 2
  `GH200`, `L40`, `A40`, `A30`, `A10`, `RTX-6000-ADA`, `RTX-A6000`, `RTX-5090`, `RTX-5080`, `RTX-4090`.

| Family       | Products                                                                              |
| ------------ | ------------------------------------------------------------------------------------- |
| H100         | `H100-SXM5-80GB`, `H100-PCIE-80GB`, `H100-NVL-94GB`                                   |
| H200         | `H200-SXM5-141GB`, `H200-NVL-141GB`                                                   |
| B200         | `B200-SXM-180GB`                                                                      |
| GB200        | `GB200-SUPERCHIP-186GB`                                                               |
| A100         | `A100-SXM4-40GB`, `A100-SXM4-80GB`, `A100-PCIE-40GB`, `A100-PCIE-80GB`                |
| L40S, L4     | `L40S-PCIE-48GB`, `L4-PCIE-24GB`                                                      |
| RTX-PRO-6000 | `RTX-PRO-6000-SERVER-96GB`, `RTX-PRO-6000-WORKSTATION-96GB`, `RTX-PRO-6000-MAXQ-96GB` |
| GH200        | `GH200-SUPERCHIP-96GB`, `GH200-SUPERCHIP-144GB`                                       |
| L40, A40, A30, A10 | `L40-PCIE-48GB`, `A40-PCIE-48GB`, `A30-PCIE-24GB`, `A10-PCIE-24GB`              |
| RTX-6000-ADA, RTX-A6000 | `RTX-6000-ADA-PCIE-48GB`, `RTX-A6000-PCIE-48GB`                            |
| RTX-5090, RTX-5080, RTX-4090 | `RTX-5090-PCIE-32GB`, `RTX-5080-PCIE-16GB`, `RTX-4090-PCIE-24GB`      |

## Other exports

- **`inventoryModule`** is a `ComputeModule<'inventory', InventoryApi>` holding the `inventory` API group (`get`, `history`, `diff`), each authorized as `compute:nodes:read` on the node.
  - Its methods validate `{ tenantId, nodeId }` strictly.
  - It adds no catalog fragment, because its actions are already in compute's own catalog.
- **Condition types:**
  - `nodeConditionTypes` and `isNodeConditionType`: the node condition types.
  - `inventoryChangeTypes`: the events an inventory diff emits.
- **Protocol re-exports:** `NodeInventory` and its section types (`GpusSection`, `Gpu`, …), re-exported from `@better-compute/protocol` as types only.

## Documentation

- [Inventory and health](https://better-compute.com/docs/guides/nodes/inventory-and-health)
- [inventory API reference](https://better-compute.com/docs/reference/api/inventory)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
