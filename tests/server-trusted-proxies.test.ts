import { describe, expect, it } from 'vitest';
import { sourceAddressResolver } from '../packages/server/src/proxy.js';

// trustedProxies: X-Forwarded-For counts only when the socket peer is a configured proxy, and then
// right to left up to the first hop that is not itself a proxy.

const xff = (value?: string) => new Headers(value === undefined ? {} : { 'x-forwarded-for': value });

describe('trustedProxies', () => {
  it('ignores forwarding headers from a peer that is not a trusted proxy', () => {
    const none = sourceAddressResolver();
    expect(none('203.0.113.9', xff('10.0.0.5'))).toBe('203.0.113.9');
    const lb = sourceAddressResolver(['10.0.0.0/8']);
    expect(lb('203.0.113.9', xff('10.0.0.5'))).toBe('203.0.113.9');
    expect(lb(undefined, xff('1.2.3.4'))).toBeUndefined();
  });

  it('reads the caller from the right, skipping trusted hops, never the client’s own claims', () => {
    const lb = sourceAddressResolver(['10.0.0.0/8', '2001:db8::/32']);
    expect(lb('10.1.2.3', xff('198.51.100.7'))).toBe('198.51.100.7');
    // The client prepended a spoofed address; the proxies appended what they saw.
    expect(lb('10.1.2.3', xff('127.0.0.1, 198.51.100.7, 10.9.9.9'))).toBe('198.51.100.7');
    expect(lb('::ffff:10.1.2.3', xff('198.51.100.7'))).toBe('198.51.100.7');
    expect(lb('2001:db8::1', xff('2001:db8::2, 2606:4700::1111'))).toBe('2606:4700::1111');
    // Every hop internal: the leftmost.
    expect(lb('10.1.2.3', xff('10.4.4.4, 10.5.5.5'))).toBe('10.4.4.4');
  });

  it('leaves the caller unknown when a trusted proxy sends nothing usable', () => {
    const lb = sourceAddressResolver(['10.0.0.1']);
    expect(lb('10.0.0.1', xff())).toBeUndefined();
    expect(lb('10.0.0.1', xff('198.51.100.7, not-an-ip'))).toBeUndefined();
  });

  it('refuses entries that are not addresses or CIDR ranges', () => {
    for (const bad of ['10.0.0.0/33', 'example.com', '10.0.0.0/8/1', '::/129', '10.0.0.0/x'])
      expect(() => sourceAddressResolver([bad])).toThrow(/trustedProxies/);
  });
});
