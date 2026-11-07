import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { CloudSectionSchema, CpuSectionSchema } from '@better-compute/protocol';
import { cloudLabels, inventoryLabelKeys, inventoryLabels } from '@better-compute/inventory';

// AWS A6: the cloud.* labels and the EFA count from bcd's "cloud" inventory section. The section is
// derived here already; the control plane stores it once "cloud" is registered (INVENTORY_SECTIONS,
// the node_inventory_sections CHECK), which is the A6 TypeScript half.

const p5 = create(CloudSectionSchema, {
  provider: 'aws',
  instanceId: 'i-0123456789abcdef0',
  instanceType: 'p5.48xlarge',
  region: 'us-east-1',
  zone: 'us-east-1a',
  zoneId: 'use1-az4',
  lifecycle: 'spot',
  efaDevices: 32,
});

describe('cloud labels', () => {
  it('derives provider, instance type, region, zone, zone id, lifecycle and the EFA count', () => {
    expect(cloudLabels(p5)).toEqual([
      { key: 'cloud.instance-type', value: 'p5.48xlarge', source: 'inventory' },
      { key: 'cloud.lifecycle', value: 'spot', source: 'inventory' },
      { key: 'cloud.provider', value: 'aws', source: 'inventory' },
      { key: 'cloud.region', value: 'us-east-1', source: 'inventory' },
      { key: 'cloud.zone', value: 'us-east-1a', source: 'inventory' },
      { key: 'cloud.zone-id', value: 'use1-az4', source: 'inventory' },
      { key: 'efa.count', value: '32', source: 'inventory' },
    ]);
  });

  it('omits what the metadata did not say, but always counts EFA devices', () => {
    const bare = create(CloudSectionSchema, { provider: 'aws', instanceType: 'c7i.metal-48xl', region: 'eu-west-1' });
    expect(cloudLabels(bare).map((label) => `${label.key}=${label.value}`)).toEqual([
      'cloud.instance-type=c7i.metal-48xl',
      'cloud.provider=aws',
      'cloud.region=eu-west-1',
      'efa.count=0',
    ]);
    expect(cloudLabels(undefined)).toEqual([]);
  });

  it('joins the other inventory labels in key order once a node has the section', () => {
    const cpu = create(CpuSectionSchema, { architecture: 'x86_64', threads: 192 });
    const labels = inventoryLabels({ cpu, cloud: p5 });
    expect(labels.map((label) => label.key)).toEqual([...labels.map((label) => label.key)].sort());
    expect(labels).toContainEqual({ key: 'cloud.zone-id', value: 'use1-az4', source: 'inventory' });
    expect(labels).toContainEqual({ key: 'cpu.arch', value: 'x86_64', source: 'inventory' });
    expect(inventoryLabels({ cpu }).some((label) => label.key.startsWith('cloud.') || label.key === 'efa.count')).toBe(false);
  });

  it('owns the keys', () => {
    for (const key of cloudLabels(p5).map((label) => label.key))
      expect(inventoryLabelKeys as readonly string[]).toContain(key);
  });
});
