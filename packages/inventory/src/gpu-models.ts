// GPU naming (PLAN.md §10.1). `gpuProduct` is the normalized NVML name; `gpuModel` is its family,
// which pools, policies and meters use. The table is data (JSON-serializable) and versioned: a
// release that adds or renames a product bumps `version`.

/** GPU families with a mapping. Pools hold exactly one; `other` never matches a pool. */
export const gpuModelFamilies = [
  'H100',
  'H200',
  'B200',
  'GB200',
  'A100',
  'L40S',
  'L4',
  'RTX-PRO-6000',
] as const;
/** A GPU family (`gpuModel`), or `other` for a name the table does not know. */
export type GpuModel = (typeof gpuModelFamilies)[number] | 'other';

/** One normalized product and the NVML names that report it. */
export interface GpuProductEntry {
  /** `<MODEL>-<FORM>-<MEMORY>GB`, e.g. `H100-SXM5-80GB`. */
  readonly product: string;
  readonly model: Exclude<GpuModel, 'other'>;
  /** Names as `nvmlDeviceGetName` returns them. */
  readonly nvmlNames: readonly string[];
}

/** The GPU mapping as data; `version` grows whenever a product is added or renamed. */
export interface GpuModelTable {
  readonly version: number;
  readonly families: readonly Exclude<GpuModel, 'other'>[];
  readonly products: readonly GpuProductEntry[];
}

/**
 * The shipped mapping (the plan's `gpu-models.json`). Forms: `SXM4`/`SXM5` (A100, Hopper), `SXM`
 * (Blackwell modules, named without a generation number), `PCIE`, `NVL` (NVLink-bridged PCIe
 * cards), `SUPERCHIP` (Grace Blackwell), and the RTX PRO 6000 editions `SERVER`, `WORKSTATION` and
 * `MAXQ`. Memory is the marketed capacity.
 */
export const gpuModels: GpuModelTable = deepFreeze({
  version: 1,
  families: [...gpuModelFamilies],
  products: [
    { product: 'H100-SXM5-80GB', model: 'H100', nvmlNames: ['NVIDIA H100 80GB HBM3'] },
    { product: 'H100-PCIE-80GB', model: 'H100', nvmlNames: ['NVIDIA H100 PCIe'] },
    { product: 'H100-NVL-94GB', model: 'H100', nvmlNames: ['NVIDIA H100 NVL'] },
    { product: 'H200-SXM5-141GB', model: 'H200', nvmlNames: ['NVIDIA H200'] },
    { product: 'H200-NVL-141GB', model: 'H200', nvmlNames: ['NVIDIA H200 NVL'] },
    { product: 'B200-SXM-180GB', model: 'B200', nvmlNames: ['NVIDIA B200'] },
    { product: 'GB200-SUPERCHIP-186GB', model: 'GB200', nvmlNames: ['NVIDIA GB200'] },
    { product: 'A100-SXM4-40GB', model: 'A100', nvmlNames: ['NVIDIA A100-SXM4-40GB'] },
    {
      product: 'A100-SXM4-80GB',
      model: 'A100',
      nvmlNames: ['NVIDIA A100-SXM4-80GB', 'NVIDIA A100-SXM-80GB'],
    },
    { product: 'A100-PCIE-40GB', model: 'A100', nvmlNames: ['NVIDIA A100-PCIE-40GB'] },
    { product: 'A100-PCIE-80GB', model: 'A100', nvmlNames: ['NVIDIA A100 80GB PCIe'] },
    { product: 'L40S-PCIE-48GB', model: 'L40S', nvmlNames: ['NVIDIA L40S'] },
    { product: 'L4-PCIE-24GB', model: 'L4', nvmlNames: ['NVIDIA L4'] },
    {
      product: 'RTX-PRO-6000-SERVER-96GB',
      model: 'RTX-PRO-6000',
      nvmlNames: ['NVIDIA RTX PRO 6000 Blackwell Server Edition'],
    },
    {
      product: 'RTX-PRO-6000-WORKSTATION-96GB',
      model: 'RTX-PRO-6000',
      nvmlNames: ['NVIDIA RTX PRO 6000 Blackwell Workstation Edition'],
    },
    {
      product: 'RTX-PRO-6000-MAXQ-96GB',
      model: 'RTX-PRO-6000',
      nvmlNames: ['NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition'],
    },
  ],
});

/** A normalized GPU name. */
export interface GpuProductInfo {
  gpuProduct: string;
  gpuModel: GpuModel;
}

/** The product an empty or unusable name normalizes to. */
export const unknownGpuProduct = 'UNKNOWN';
const maxProductLength = 63;

/**
 * The canonical form every name is compared in: upper case, runs of anything but letters and
 * digits collapsed to `-`, leading `NVIDIA` words dropped (older drivers omit them), at most 63
 * characters. Applying it twice changes nothing.
 */
function canonical(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(?:NVIDIA-)+/, '');
  return slug.slice(0, maxProductLength).replace(/-+$/, '');
}

const index = new Map<string, GpuProductInfo>();
for (const entry of gpuModels.products)
  for (const name of [entry.product, ...entry.nvmlNames])
    index.set(canonical(name), { gpuProduct: entry.product, gpuModel: entry.model });

/**
 * Normalizes an NVML device name: `'NVIDIA H100 80GB HBM3'` → `{ gpuProduct: 'H100-SXM5-80GB',
 * gpuModel: 'H100' }`. A name the table does not know keeps its canonical form as `gpuProduct` and
 * maps to `gpuModel: 'other'`, which raises `GpuModelUnknown`. A product name normalizes to itself.
 */
export function normalizeGpuProduct(nvmlName: string): GpuProductInfo {
  const key = canonical(typeof nvmlName === 'string' ? nvmlName : '');
  const known = index.get(key);
  if (known) return { ...known };
  return { gpuProduct: key || unknownGpuProduct, gpuModel: 'other' };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
