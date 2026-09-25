# @better-compute/inventory

Hardware inventory for better-compute: GPU naming, node condition types, and `inventoryModule`,
the always-on built-in module that the server registers before any injected module. It depends on
`@better-compute/core` and `@better-compute/protocol`.

**Status: v0.2.** Everything below works:

- GPU naming, section verification, diffs, devices and atoms, labels, the hardware key, and the
  conditions;
- the Inventory reconciler;
- `inventory.get`, `inventory.history` (snapshots newest first, paged by snapshot id) and
  `inventory.diff` (any two snapshots by id or hash; by default the latest against the one before);
- Health (§10.1): `xidPolicies` and `recordXid` (48 quarantines the GPU; 79 and 95 make the node
  NoSchedule for a reboot; 63 and 64 cover row remaps). Inventory findings (a failed or pending row
  remap, uncorrectable ECC, a degraded NVLink) are applied on every inventory. Device quarantines
  live in `device_health`: the atom leaves placement and the node does not. Remediation runs in
  provision (`health` work);
- v0.5 fractional atoms: `gpu.slot` atoms `<uuid>/s<k>` for `timeslice`/`mps` pools (from
  `policy.sharing.replicas`); MIG `gpu.mig` atoms; `partitionPending` freezes a GPU during a MIG
  mode change; `gpuAtomFamily` feeds the capacity atom rule.
- The **hygiene sweep** (`inventory.hygiene`, a periodic singleton in `inventoryModule`, every 5
  minutes): `DriverMismatch` (a converged node whose GPU driver branch differs from its
  `nvidia-driver` unit), `CertExpiring` (the newest identity certificate has under a tenth of its
  life left, at least an hour: renewal is failing) and `DaemonOutdated` (an older protocol, or
  `minDaemonVersion`). Each is NoSchedule plus a `node.condition.changed` event, cleared with its
  cause.
- **Host pressure** from `StatusReport.pressure` (Linux PSI and CPU steal): `CpuPressure`,
  `MemoryPressure`, `DiskPressure` with hysteresis, NoSchedule on `vps-host` pools and alert-only
  elsewhere (`recordHostPressure`; the gateway's `xidStatusHandler` calls it).
- **Image caches**: a node's `images` section keeps `node_image_cache` in step for the
  `image-cached` scorer (`imageCacheNodes`).
- Atom health edges wake the node's started reservations (`wakeStartedReservations`, work kind
  `capacity.reservations`), so capacity's Degraded conditions follow at once.

## From Hello to devices (PLAN.md §10.1)

1. **Report.** In the Hello transaction, and on every heartbeat that carries hashes, the gateway
   calls `recordInventoryHashes(tx, work, nodeId, hashes)`. It stores the hashes in
   `node_inventory` and returns the sections to pull (`Welcome.request_sections`): those whose
   stored bytes have a different hash. `recordInventoryHashesMany` does a whole batch of reports
   in one statement (the gateway's group commit), one result slot per report.
2. **Pull.** For each `InventorySection` frame the gateway calls
   `ingestInventorySection(tx, work, nodeId, section)`. The section is checked against its own
   SHA-256 over the received bytes (`INVALID_INPUT` otherwise) and never re-encoded. It is stored in
   `node_inventory_sections`, and work kind `inventory` is queued for the node.
   `ingestInventorySections(tx, work, entries)` stores a batch of many nodes' sections in one
   statement, with one result slot per entry.
3. **Apply.** `inventoryReconciler` runs `applyInventory(sql, nodeId, { events })` in one
   transaction with the node row locked. Once every reported section's bytes are present and the
   digest differs from the last applied one, it:
   - appends an `inventory_snapshots` row (decoded sections as JSON, bigints as strings);
   - plans devices with `planDevices`. GPUs become `gpu` atoms, and a MIG GPU becomes a non-bookable
     parent of `gpu.mig` atoms. A vanished device that still has live bookings is kept with
     `healthy = false` and deleted once its bookings end. A device id another node owns is left
     alone and raises `DuplicateIdentity`;
   - replaces the `inventory`-sourced labels (`gpu.product`, `gpu.model`, `gpu.count`,
     `cuda.driver.major`, `mig.capable`, `fabric.domain`, …);
   - writes `GpuCountMismatch`, `GpuModelUnknown` and `DuplicateIdentity` into `node_conditions`, and
     mirrors the true ones into `nodes.no_schedule_reasons` as bare type names (keeping every entry
     it does not own);
   - sets `hardware_key`. It is trusted with two or more independent identifiers, and a clash on the
     unique index is caught in a savepoint and becomes `DuplicateIdentity`;
   - publishes `node.inventory.changed` plus one `node.<change>` event per diff entry.

   A `tenant-controlled` node (a dedicated-root lease: the lessee has root) is advisory (PLAN.md
   §10.1 Trust). Its set is appended as a snapshot and announced as `node.inventory.changed` with
   `advisory: true`, and nothing else changes: devices, health, labels, conditions, the image cache
   and the hardware key keep the platform's last view, and `recordXid` and `recordHostPressure`
   ignore its reports. Otherwise a
   GPU the lessee reports missing or unhealthy would leave the lease's bill. The applied digest is
   stored as `advisory:<digest>`. When metal ends the lease it calls `endAdvisoryInventory`, so the
   next report applies the same set under platform trust.

Pure building blocks: `verifySection`, `sectionsToRequest`, `mergeSections`, `inventoryDigest`,
`devicesFromGpus`, `gpuLinks` (undirected GPU pairs for placement), `planDevices`,
`inventoryLabels`, `inventoryConditions`, `mergeNoScheduleReasons`, `diffInventory`,
`hardwareKey` / `hardwareKeyFromClaims` (join claims hash exactly like inventory).

```ts
import { inventoryModule, normalizeGpuProduct } from 'better-compute/inventory';

normalizeGpuProduct('NVIDIA H100 80GB HBM3'); // { gpuProduct: 'H100-SXM5-80GB', gpuModel: 'H100' }
normalizeGpuProduct('NVIDIA GH200 480GB'); // { gpuProduct: 'GH200-480GB', gpuModel: 'other' }
```

## GPU naming (PLAN.md §10.1)

- `normalizeGpuProduct(nvmlName)` returns `{ gpuProduct, gpuModel }`.
  - Before lookup the name is canonicalized: upper case, punctuation collapsed to `-`, and a
    leading `NVIDIA` dropped (older drivers omit it).
  - `gpuProduct` has the form `<MODEL>-<FORM>-<MEMORY>GB`.
  - `gpuModel` is the family that pools, policies and meters use.
  - A name missing from the table keeps its canonical form as `gpuProduct` and maps to
    `gpuModel: 'other'`, which raises `GpuModelUnknown`.
  - Product names normalize to themselves, so the function is idempotent.
- `gpuModels` is the versioned, JSON-serializable mapping table (the plan's `gpu-models.json`).
  Adding or renaming a product bumps `gpuModels.version`.
- `gpuModelFamilies`: `H100`, `H200`, `B200`, `GB200`, `A100`, `L40S`, `L4`, `RTX-PRO-6000`.

| Family       | Products                                                                              |
| ------------ | ------------------------------------------------------------------------------------- |
| H100         | `H100-SXM5-80GB`, `H100-PCIE-80GB`, `H100-NVL-94GB`                                   |
| H200         | `H200-SXM5-141GB`, `H200-NVL-141GB`                                                   |
| B200         | `B200-SXM-180GB`                                                                      |
| GB200        | `GB200-SUPERCHIP-186GB`                                                               |
| A100         | `A100-SXM4-40GB`, `A100-SXM4-80GB`, `A100-PCIE-40GB`, `A100-PCIE-80GB`                |
| L40S, L4     | `L40S-PCIE-48GB`, `L4-PCIE-24GB`                                                      |
| RTX-PRO-6000 | `RTX-PRO-6000-SERVER-96GB`, `RTX-PRO-6000-WORKSTATION-96GB`, `RTX-PRO-6000-MAXQ-96GB` |

## Other exports

- **`inventoryModule`** is a `ComputeModule<'inventory', InventoryApi>` holding the `inventory`
  API group (`get`, `history`, `diff`), each authorized as `compute:nodes:read` on the node.
  - Its methods validate `{ tenantId, nodeId }` strictly.
  - It adds no catalog fragment, because its actions are already in compute's own catalog.
- **Condition types:**
  - `nodeConditionTypes` and `isNodeConditionType`: the §10.1 condition table.
  - `inventoryChangeTypes`: the events an inventory diff emits.
- **Protocol re-exports:** `NodeInventory` and its section types (`GpusSection`, `Gpu`, …),
  re-exported from `@better-compute/protocol` as types only.

License: Apache-2.0.
