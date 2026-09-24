# @better-compute/inventory

Hardware inventory for better-compute: GPU naming, node condition types, and `inventoryModule`,
the always-on built-in module that the server registers before any injected module. It depends on
`@better-compute/core` and `@better-compute/protocol`.

**Status: P0 stub.** GPU naming works now. Section hashing, diffs, labels, health conditions and
the Inventory controller arrive in v0.1. Until then `inventory.get` rejects with
`NOT_IMPLEMENTED` naming v0.1, and `inventory.history` and `inventory.diff` name v0.2.

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
