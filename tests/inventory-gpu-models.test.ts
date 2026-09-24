import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  gpuModelFamilies,
  gpuModels,
  normalizeGpuProduct,
  unknownGpuProduct,
  type GpuModel,
} from '@better-compute/inventory';

// The naming contract (PLAN.md §10.1): NVML name → gpuProduct → gpuModel.
const known: [nvmlName: string, gpuProduct: string, gpuModel: GpuModel][] = [
  ['NVIDIA H100 80GB HBM3', 'H100-SXM5-80GB', 'H100'],
  ['NVIDIA H100 PCIe', 'H100-PCIE-80GB', 'H100'],
  ['NVIDIA H100 NVL', 'H100-NVL-94GB', 'H100'],
  ['NVIDIA H200', 'H200-SXM5-141GB', 'H200'],
  ['NVIDIA H200 NVL', 'H200-NVL-141GB', 'H200'],
  ['NVIDIA B200', 'B200-SXM-180GB', 'B200'],
  ['NVIDIA GB200', 'GB200-SUPERCHIP-186GB', 'GB200'],
  ['NVIDIA A100-SXM4-40GB', 'A100-SXM4-40GB', 'A100'],
  ['NVIDIA A100-SXM4-80GB', 'A100-SXM4-80GB', 'A100'],
  ['NVIDIA A100-SXM-80GB', 'A100-SXM4-80GB', 'A100'],
  ['NVIDIA A100-PCIE-40GB', 'A100-PCIE-40GB', 'A100'],
  ['NVIDIA A100 80GB PCIe', 'A100-PCIE-80GB', 'A100'],
  ['NVIDIA L40S', 'L40S-PCIE-48GB', 'L40S'],
  ['NVIDIA L4', 'L4-PCIE-24GB', 'L4'],
  ['NVIDIA RTX PRO 6000 Blackwell Server Edition', 'RTX-PRO-6000-SERVER-96GB', 'RTX-PRO-6000'],
  [
    'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
    'RTX-PRO-6000-WORKSTATION-96GB',
    'RTX-PRO-6000',
  ],
  [
    'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition',
    'RTX-PRO-6000-MAXQ-96GB',
    'RTX-PRO-6000',
  ],
];

const productPattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

describe('normalizeGpuProduct', () => {
  it.each(known)('maps %s to %s (%s)', (nvmlName, gpuProduct, gpuModel) => {
    expect(normalizeGpuProduct(nvmlName)).toEqual({ gpuProduct, gpuModel });
  });

  it('covers every family the plan names', () => {
    expect(new Set(known.map(([, , model]) => model))).toEqual(new Set(gpuModelFamilies));
  });

  it('ignores case, spacing, punctuation and the NVIDIA prefix older drivers omit', () => {
    for (const name of [
      'A100-SXM4-40GB',
      'nvidia a100-sxm4-40gb',
      '  NVIDIA   A100 SXM4 40GB  ',
      'NVIDIA_A100_SXM4_40GB',
    ])
      expect(normalizeGpuProduct(name)).toEqual({
        gpuProduct: 'A100-SXM4-40GB',
        gpuModel: 'A100',
      });
    expect(normalizeGpuProduct('H100 80GB HBM3').gpuProduct).toBe('H100-SXM5-80GB');
  });

  it('maps every product name to itself', () => {
    for (const entry of gpuModels.products)
      expect(normalizeGpuProduct(entry.product)).toEqual({
        gpuProduct: entry.product,
        gpuModel: entry.model,
      });
  });

  it('maps names outside the table to other, keeping the canonical name', () => {
    const near: [string, string][] = [
      ['NVIDIA GH200 480GB', 'GH200-480GB'],
      ['NVIDIA L40', 'L40'],
      ['NVIDIA H800', 'H800'],
      ['NVIDIA H20', 'H20'],
      ['NVIDIA A800-SXM4-80GB', 'A800-SXM4-80GB'],
      ['NVIDIA RTX 6000 Ada Generation', 'RTX-6000-ADA-GENERATION'],
      ['Quadro RTX 6000', 'QUADRO-RTX-6000'],
      ['Tesla V100-SXM2-32GB', 'TESLA-V100-SXM2-32GB'],
      ['NVIDIA H100', 'H100'],
      ['NVIDIA B200 NVL', 'B200-NVL'],
      ['NVIDIA', 'NVIDIA'],
    ];
    for (const [name, gpuProduct] of near)
      expect(normalizeGpuProduct(name), name).toEqual({ gpuProduct, gpuModel: 'other' });
  });

  it('gives empty and unusable names a placeholder product', () => {
    for (const name of ['', '   ', '---', '™', undefined as unknown as string])
      expect(normalizeGpuProduct(name)).toEqual({
        gpuProduct: unknownGpuProduct,
        gpuModel: 'other',
      });
    expect(normalizeGpuProduct(unknownGpuProduct)).toEqual({
      gpuProduct: unknownGpuProduct,
      gpuModel: 'other',
    });
  });

  it('caps products at 63 characters without a trailing hyphen', () => {
    expect(normalizeGpuProduct(`NVIDIA ${'X'.repeat(62)} Y`).gpuProduct).toBe('X'.repeat(62));
    expect(normalizeGpuProduct('A '.repeat(80)).gpuProduct).toHaveLength(63);
  });

  it('returns a fresh result each time', () => {
    const first = normalizeGpuProduct('NVIDIA L4');
    first.gpuProduct = 'changed';
    expect(normalizeGpuProduct('NVIDIA L4').gpuProduct).toBe('L4-PCIE-24GB');
  });

  it('is total, bounded and idempotent on arbitrary input', () => {
    const families = new Set<string>([...gpuModelFamilies, 'other']);
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 120 }),
          fc.constantFrom(...known.map(([name]) => name)).map((name) => `  ${name.toLowerCase()} `),
        ),
        (name) => {
          const result = normalizeGpuProduct(name);
          expect(families.has(result.gpuModel)).toBe(true);
          expect(result.gpuProduct.length).toBeLessThanOrEqual(63);
          expect(result.gpuProduct).toMatch(productPattern);
          expect(normalizeGpuProduct(result.gpuProduct)).toEqual(result);
        },
      ),
    );
  });
});

describe('gpuModels', () => {
  it('is versioned, frozen data', () => {
    expect(gpuModels.version).toBe(1);
    expect(Object.isFrozen(gpuModels)).toBe(true);
    expect(Object.isFrozen(gpuModels.products)).toBe(true);
    expect(Object.isFrozen(gpuModels.products[0]!.nvmlNames)).toBe(true);
    expect(JSON.parse(JSON.stringify(gpuModels))).toEqual(gpuModels);
  });

  it('names each product <MODEL>-<FORM>-<MEMORY>GB once, in a known family', () => {
    const products = gpuModels.products.map((entry) => entry.product);
    expect(new Set(products).size).toBe(products.length);
    expect(gpuModels.families).toEqual([...gpuModelFamilies]);
    for (const entry of gpuModels.products) {
      expect(gpuModels.families).toContain(entry.model);
      expect(entry.product).toMatch(productPattern);
      expect(entry.product.startsWith(`${entry.model}-`)).toBe(true);
      expect(entry.product).toMatch(/^.+-[A-Z0-9]+-\d+GB$/);
      expect(entry.nvmlNames.length).toBeGreaterThan(0);
    }
    for (const family of gpuModels.families)
      expect(gpuModels.products.some((entry) => entry.model === family)).toBe(true);
  });

  it('maps every listed name to its own entry, so no name is claimed twice', () => {
    for (const entry of gpuModels.products)
      for (const name of [entry.product, ...entry.nvmlNames])
        expect(normalizeGpuProduct(name), name).toEqual({
          gpuProduct: entry.product,
          gpuModel: entry.model,
        });
    expect(known.map(([name]) => name).sort()).toEqual(
      gpuModels.products.flatMap((entry) => entry.nvmlNames).sort(),
    );
  });
});
