import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  CloudInstanceSchema,
  CloudInterfaceSchema,
  decodeInventorySection,
  SystemSectionSchema,
} from '@better-compute/protocol';
import { cloudInstanceOf } from '@better-compute/inventory';

// The system section's `cloud` (bcd reads DigitalOcean's metadata service on a Droplet): decoded
// for inventory only. It is node-reported and unsigned, so it is normalized defensively and never
// used as an identity.

const droplet = create(SystemSectionSchema, {
  vendor: 'DigitalOcean',
  product: 'Droplet',
  cloud: create(CloudInstanceSchema, {
    provider: 'digitalocean',
    instanceId: '2756294',
    region: 'nyc3',
    tags: ['better-compute-managed:true', 'pool-a'],
    interfaces: [
      create(CloudInterfaceSchema, { network: 'private', mac: '04:01:2a:0f:2a:02', ipv4Address: '10.132.255.113', ipv4Netmask: '255.255.0.0' }),
      create(CloudInterfaceSchema, {
        network: 'public',
        mac: '04:01:2a:0f:2a:01',
        ipv4Address: '104.131.20.105',
        ipv4Netmask: '255.255.192.0',
        ipv4Gateway: '104.131.0.1',
        ipv6Address: '2604:a880:800:10::17d:2001',
        ipv6PrefixLength: 64,
        ipv6Gateway: '2604:a880:800:10::1',
      }),
    ],
  }),
});

describe('cloudInstanceOf', () => {
  it('decodes a Droplet from the system section bytes bcd sends', () => {
    const system = decodeInventorySection('system', toBinary(SystemSectionSchema, droplet));
    expect(cloudInstanceOf(system)).toEqual({
      provider: 'digitalocean',
      instanceId: '2756294',
      region: 'nyc3',
      tags: ['better-compute-managed:true', 'pool-a'],
      interfaces: [
        { network: 'private', mac: '04:01:2a:0f:2a:02', ipv4: { address: '10.132.255.113', netmask: '255.255.0.0' } },
        {
          network: 'public',
          mac: '04:01:2a:0f:2a:01',
          ipv4: { address: '104.131.20.105', netmask: '255.255.192.0', gateway: '104.131.0.1' },
          ipv6: { address: '2604:a880:800:10::17d:2001', prefixLength: 64, gateway: '2604:a880:800:10::1' },
        },
      ],
    });
  });

  it('is undefined off a cloud and for an older daemon', () => {
    expect(cloudInstanceOf(undefined)).toBeUndefined();
    expect(cloudInstanceOf(create(SystemSectionSchema, { vendor: 'Supermicro' }))).toBeUndefined();
  });

  it('refuses an instance it cannot name', () => {
    for (const cloud of [
      { provider: '', instanceId: '1', region: 'nyc3' },
      { provider: 'Digital Ocean', instanceId: '1', region: 'nyc3' },
      { provider: 'digitalocean', instanceId: '', region: 'nyc3' },
      { provider: 'digitalocean', instanceId: '0', region: 'nyc3' },
      { provider: 'digitalocean', instanceId: '12a', region: 'nyc3' },
      { provider: 'digitalocean', instanceId: '1', region: 'NYC 3' },
    ]) {
      const system = create(SystemSectionSchema, { cloud: create(CloudInstanceSchema, cloud) });
      expect(cloudInstanceOf(system), JSON.stringify(cloud)).toBeUndefined();
    }
  });

  it('drops malformed tags and interfaces, sorts and caps what is left', () => {
    const tags = [...Array.from({ length: 200 }, (_, i) => `t${String(i).padStart(3, '0')}`), 'bad tag', 'x'.repeat(256), 't000'];
    const system = create(SystemSectionSchema, {
      cloud: create(CloudInstanceSchema, {
        provider: 'digitalocean',
        instanceId: '9',
        region: 'ams3',
        tags: tags.reverse(),
        interfaces: [
          create(CloudInterfaceSchema, { network: 'public', mac: 'not-a-mac' }),
          create(CloudInterfaceSchema, { network: 'weird', mac: '04:01:2a:0f:2a:09' }),
          create(CloudInterfaceSchema, {
            network: 'public',
            mac: '04:01:2A:0F:2A:01',
            ipv4Address: '999.1.1.1',
            ipv6Address: 'nope',
            ipv6PrefixLength: 300,
          }),
          ...Array.from({ length: 30 }, (_, i) =>
            create(CloudInterfaceSchema, { network: 'private', mac: `04:01:2a:0f:3a:${i.toString(16).padStart(2, '0')}` }),
          ),
        ],
      }),
    });
    const cloud = cloudInstanceOf(system)!;
    expect(cloud.tags).toHaveLength(128);
    expect(cloud.tags[0]).toBe('t000');
    expect(cloud.tags).toEqual([...cloud.tags].sort());
    expect(cloud.interfaces).toHaveLength(16);
    expect(cloud.interfaces.every((nic) => nic.network === 'private')).toBe(true);
    expect(cloud.interfaces[0]).toEqual({ network: 'private', mac: '04:01:2a:0f:3a:00' });

    const one = cloudInstanceOf(
      create(SystemSectionSchema, {
        cloud: create(CloudInstanceSchema, {
          provider: 'digitalocean',
          instanceId: '9',
          region: 'ams3',
          interfaces: [system.cloud!.interfaces[2]!],
        }),
      }),
    )!;
    expect(one.interfaces).toEqual([{ network: 'public', mac: '04:01:2a:0f:2a:01' }]);
  });
});
