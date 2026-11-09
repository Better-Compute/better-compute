import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  addressFamily,
  addressInRange,
  classifyAddress,
  embeddedV4,
  isComputeError,
  isInternalHostName,
  parseAddress,
  parseCidr,
} from '@better-compute/core';

// The shared egress classifier: what the provider endpoint policy (vps) and the webhook URL check (events)
// both judge addresses by.

describe('parseAddress', () => {
  const samples = [
    '0.0.0.0',
    '8.8.8.8',
    '255.255.255.255',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '1.2.3.4 ',
    '0x7f.0.0.1',
    '2130706433',
    '',
    '::',
    '::1',
    '1::',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '::FFFF:A00:1',
    '2001:db8::1',
    '2001:db8:0:0:0:0:0:1',
    '2001:db8:0:0:0:0:0:0:1',
    '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7::',
    '1:2:3:4:5:6:7:8::',
    '1::2::3',
    '1:2:3:4:5:6:1.2.3.4',
    '1:2:3:4:5:6:7:1.2.3.4',
    '::1.2.3.4',
    '1.2.3.4::',
    'fe80::1%eth0',
    'fe80::1%',
    '12345::1',
    'g::1',
    ':1',
    '1:',
    ':::',
    'localhost',
    'example.com',
  ];

  it('agrees with net.isIP on what is an address', () => {
    for (const sample of samples) expect(addressFamily(sample), JSON.stringify(sample)).toBe(isIP(sample));
  });

  it('reads the value whatever the textual form, brackets included', () => {
    expect(parseAddress('10.0.0.1')).toEqual({ family: 4, value: 0x0a000001n });
    expect(parseAddress('::ffff:10.0.0.1')).toEqual(parseAddress('::ffff:a00:1'));
    expect(parseAddress('[::1]')).toEqual({ family: 6, value: 1n });
    expect(parseAddress('2001:db8::1')).toEqual(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001'));
    expect(parseAddress('fe80::1%eth0')).toEqual(parseAddress('fe80::1'));
    expect(parseAddress('nope')).toBeUndefined();
  });
});

describe('classifyAddress', () => {
  it('names why an address is not public', () => {
    const cases: [string, string | undefined][] = [
      ['8.8.8.8', undefined],
      ['2606:4700:4700::1111', undefined],
      ['0.0.0.0', 'unspecified'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.32.0.1', undefined],
      ['192.168.0.1', 'private'],
      ['100.64.0.1', 'cgnat'],
      ['100.128.0.1', undefined],
      ['127.0.0.1', 'loopback'],
      ['169.254.169.254', 'link-local'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
      ['192.0.2.1', 'documentation'],
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['fc00::1', 'unique-local'],
      ['fd12:3456::1', 'unique-local'],
      ['fe80::1', 'link-local'],
      ['fec0::1', 'site-local'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['example.com', 'reserved'],
      ['', 'reserved'],
    ];
    for (const [address, category] of cases) expect(classifyAddress(address), address).toBe(category);
  });

  it('judges an IPv4 address carried inside an IPv6 one', () => {
    // Mapped (dotted and hex), NAT64 and 6to4, each around the metadata address and a public one.
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '2002:a9fe:a9fe::1',
    ])
      expect(classifyAddress(address), address).toBe('link-local');
    for (const address of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'])
      expect(classifyAddress(address), address).toBeUndefined();
    expect(embeddedV4(parseAddress('::ffff:a00:5')!)).toEqual({ family: 4, value: 0x0a000005n });
    expect(embeddedV4(parseAddress('2001:4860::1')!)).toBeUndefined();
    expect(embeddedV4(parseAddress('10.0.0.5')!)).toBeUndefined();
    // IPv4-compatible (::a.b.c.d) is reserved space of its own.
    expect(classifyAddress('::10.0.0.5')).toBe('reserved');
  });

  it('applies exemptions first and extra refusals before the built-in ranges', () => {
    const allow = [parseCidr('10.20.0.0/16', 'private')];
    const deny = [parseCidr('34.118.224.0/20', 'cluster'), parseCidr('2600:1900:4000::/44', 'cluster')];
    expect(classifyAddress('10.20.3.4', { allow })).toBeUndefined();
    expect(classifyAddress('10.21.3.4', { allow })).toBe('private');
    // An exemption for an IPv4 range covers the same address reached through a mapped one.
    expect(classifyAddress('::ffff:10.20.3.4', { allow })).toBeUndefined();
    expect(classifyAddress('::ffff:10.21.3.4', { allow })).toBe('private');
    expect(classifyAddress('34.118.225.1', { deny })).toBe('cluster');
    expect(classifyAddress('::ffff:34.118.225.1', { deny })).toBe('cluster');
    expect(classifyAddress('2600:1900:4000:1::1', { deny })).toBe('cluster');
    expect(classifyAddress('34.118.240.1', { deny })).toBeUndefined();
  });
});

describe('parseCidr and ranges', () => {
  it('masks the base and matches by prefix', () => {
    const range = parseCidr('10.1.2.3/8', 'private');
    expect(range).toMatchObject({ family: 4, bits: 8, base: 0x0a000000n });
    expect(addressInRange(range, parseAddress('10.255.255.255')!)).toBe(true);
    expect(addressInRange(range, parseAddress('11.0.0.0')!)).toBe(false);
    expect(addressInRange(range, parseAddress('::ffff:10.0.0.1')!)).toBe(false);
    expect(parseCidr('192.168.1.7', 'private').bits).toBe(32);
    expect(parseCidr('::/0', 'reserved').bits).toBe(0);
    expect(addressInRange(parseCidr('0.0.0.0/0', 'reserved'), parseAddress('8.8.8.8')!)).toBe(true);
  });

  it('refuses what is not a CIDR', () => {
    for (const bad of ['10.0.0.0/33', 'fc00::/129', '10.0.0.0/-1', '10.0.0.0/x', '10.0.0.0/', 'example.com/8', '/8']) {
      let caught: unknown;
      try {
        parseCidr(bad, 'private');
      } catch (error) {
        caught = error;
      }
      expect(isComputeError(caught, 'INVALID_CONFIG'), bad).toBe(true);
    }
  });
});

describe('isInternalHostName', () => {
  it('knows the names that only resolve inside a network', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'metadata',
      'kubernetes',
      'intranet',
      'db.internal',
      'metadata.google.internal',
      'api.svc',
      'api.default.svc.cluster.local',
      'printer.local',
      'nas.lan',
      'router.home.arpa',
      'app.localhost',
      'db.internal.',
    ])
      expect(isInternalHostName(host), host).toBe(true);
    for (const host of ['example.com', 'hooks.example.com.', 'internal.example.com', 'local.example.org', 'svc.io'])
      expect(isInternalHostName(host), host).toBe(false);
  });
});
