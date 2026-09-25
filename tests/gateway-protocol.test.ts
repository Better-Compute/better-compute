import { afterEach, describe, expect, it } from 'vitest';
import { gatewayFixture, type GatewayFixture } from './support/gateway.js';

// `createGateway({ protocol })`: the versions a gateway speaks, for version-skew tests (v1.0's N−2
// matrix) and staged protocol bumps (§7.6). The default stays the protocol package's own range.

let f: GatewayFixture | undefined;
afterEach(() => f?.close());

describe('protocol range', () => {
  it('welcomes an older daemon inside the range at its own version (N−2)', async () => {
    f = await gatewayFixture({ protocol: { min: 1, max: 3 } });
    const node = await f.addNode();
    const { stream } = await f.connect(node, { protoMin: 1, protoMax: 1 });
    expect(stream.of('welcome')[0]).toMatchObject({ protocolVersion: 1, upgradeRequired: false });
  });

  it('negotiates the highest shared version', async () => {
    f = await gatewayFixture({ protocol: { min: 1, max: 3 } });
    const node = await f.addNode();
    const { stream } = await f.connect(node, { protoMin: 1, protoMax: 2 });
    expect(stream.of('welcome')[0]).toMatchObject({ protocolVersion: 2, upgradeRequired: false });
  });

  it('restricts a daemon below a raised minimum to upgrade_required', async () => {
    f = await gatewayFixture({ protocol: { min: 2, max: 3 } });
    const node = await f.addNode();
    const { stream } = await f.connect(node, { protoMin: 1, protoMax: 1 });
    expect(stream.of('welcome')[0]).toMatchObject({ protocolVersion: 2, upgradeRequired: true });
  });

  it('refuses a malformed range at construction', async () => {
    await expect(gatewayFixture({ protocol: { min: 3, max: 2 } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(gatewayFixture({ protocol: { min: 0, max: 1 } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
