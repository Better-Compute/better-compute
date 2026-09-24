import { describe, expect, it } from 'vitest';
import { ComputeError, manualClock } from '@better-compute/core';
import {
  createCsr,
  createNodeCa,
  createReplayCache,
  createRevocationSet,
  generateP256KeyPair,
  nodeSpiffeId,
  normalizeSerial,
  signRenewPop,
  verifyRenewPop,
  type RenewPopRequest,
} from '@better-compute/pki';

const start = Date.UTC(2026, 8, 24, 12);
const nodeId = 'node_01k5w0000000000000000000aa';
// P-256 group order: (r, n − s) is the other valid form of an ECDSA signature.
const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

async function setup() {
  const clock = manualClock(start);
  const revocations = createRevocationSet();
  const nodeCa = createNodeCa({ clock, revocations });
  const current = generateP256KeyPair();
  const issued = await nodeCa.sign(createCsr(current.privateKey), {
    usage: 'client',
    role: 'node',
    ttlSeconds: 86_400,
    uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_fra1', nodeId })],
  });
  const next = generateP256KeyPair();
  const csr = createCsr(next.privateKey);
  const request = (
    overrides: Partial<{
      clientTime: number;
      privateKey: typeof current.privateKey;
      nodeId: string;
    }> = {},
  ): RenewPopRequest => {
    const pop = signRenewPop({
      csr,
      nodeId: overrides.nodeId ?? nodeId,
      clientTime: overrides.clientTime ?? clock.now(),
      privateKey: overrides.privateKey ?? current.privateKey,
    });
    return {
      csr,
      chain: [issued.certificate, ...issued.chain],
      clientTime: pop.clientTime,
      popSig: pop.popSig,
    };
  };
  const options = () => ({
    now: clock.now(),
    nodeCaRoots: [nodeCa.certificate],
    replayCache: createReplayCache(),
    revocations,
  });
  return { clock, nodeCa, issued, request, options, next, revocations };
}

function reason(fn: () => unknown): string {
  try {
    fn();
    return 'accepted';
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeError);
    expect((error as ComputeError).code).toBe('ACCESS_DENIED');
    return String((error as ComputeError).details?.reason);
  }
}

describe('verifyRenewPop', () => {
  it('accepts a proof by the current key and reports the node from the SAN', async () => {
    const { request, options, next } = await setup();
    const result = verifyRenewPop(request(), options());
    expect(result).toMatchObject({
      nodeId,
      siteId: 'site_fra1',
      trustDomain: 'compute.test',
      role: 'node',
      sameKey: false,
    });
    expect(result.csr.publicKey.equals(next.publicKey)).toBe(true);
  });

  it('holds the ±60 s window on both sides', async () => {
    const { request, options, clock } = await setup();
    expect(
      reason(() => verifyRenewPop(request({ clientTime: clock.now() - 60_000 }), options())),
    ).toBe('accepted');
    expect(
      reason(() => verifyRenewPop(request({ clientTime: clock.now() + 60_001 }), options())),
    ).toBe('client time outside the window');
    expect(
      reason(() => verifyRenewPop(request({ clientTime: clock.now() - 61_000 }), options())),
    ).toBe('client time outside the window');
  });

  it('rejects a replay, including one with the signature’s other (r, n − s) form', async () => {
    const { request, options } = await setup();
    const shared = options();
    const first = request();
    verifyRenewPop(first, shared);
    expect(reason(() => verifyRenewPop(first, shared))).toBe('replayed proof');
    const r = first.popSig.slice(0, 32);
    const s = BigInt(`0x${Buffer.from(first.popSig.slice(32)).toString('hex')}`);
    const flipped = new Uint8Array([
      ...r,
      ...Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex'),
    ]);
    expect(reason(() => verifyRenewPop({ ...first, popSig: flipped }, shared))).toBe(
      'replayed proof',
    );
  });

  it('rejects a proof by any key but the current one, or for another node', async () => {
    const { request, options, next } = await setup();
    expect(reason(() => verifyRenewPop(request({ privateKey: next.privateKey }), options()))).toBe(
      'bad proof',
    );
    expect(reason(() => verifyRenewPop(request({ nodeId: 'node_other' }), options()))).toBe(
      'bad proof',
    );
    expect(
      reason(() => verifyRenewPop(request(), { ...options(), expectedNodeId: 'node_other' })),
    ).toBe('certificate is for another node');
  });

  it('rejects revoked, expired and foreign certificates and bad CSRs', async () => {
    const { request, options, clock, issued, revocations } = await setup();
    const valid = request();
    expect(
      reason(() =>
        verifyRenewPop(valid, { ...options(), nodeCaRoots: [createNodeCa().certificate] }),
      ),
    ).toMatch(/trusted root/);
    const csr = valid.csr.slice();
    csr[csr.length - 4]! ^= 1;
    expect(reason(() => verifyRenewPop({ ...valid, csr }, options()))).toBe('bad CSR');
    expect(
      reason(() => verifyRenewPop({ ...valid, popSig: valid.popSig.slice(1) }, options())),
    ).toBe('malformed proof');

    revocations.add(normalizeSerial(issued.serial), { reason: 'compromised' });
    expect(reason(() => verifyRenewPop(request(), options()))).toBe('certificate revoked');

    const later = await setup();
    later.clock.advance(86_400_000 + 1000);
    expect(reason(() => verifyRenewPop(later.request(), later.options()))).toMatch(/expired/);
    expect(clock.now()).toBe(start);
  });

  it('never burns a replay slot on a rejected request', async () => {
    const { request, options, next } = await setup();
    const shared = options();
    // Same statement (CSR, node, time), forged signature: refused without poisoning the cache.
    expect(reason(() => verifyRenewPop(request({ privateKey: next.privateKey }), shared))).toBe(
      'bad proof',
    );
    expect(verifyRenewPop(request(), shared).nodeId).toBe(nodeId);
  });
});

describe('replay cache', () => {
  it('forgets entries after they expire and stays bounded', () => {
    const cache = createReplayCache({ maxEntries: 3 });
    expect(cache.add('a', 100, 0)).toBe(true);
    expect(cache.add('a', 100, 50)).toBe(false);
    expect(cache.add('a', 200, 100)).toBe(true);
    for (const key of ['b', 'c', 'd', 'e']) cache.add(key, 1000, 150);
    expect(cache.size).toBeLessThanOrEqual(3);
  });
});
