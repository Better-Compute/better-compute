import { describe, expect, it } from 'vitest';
import {
  createWorkloadTokenRequest,
  generateP256KeyPair,
  openWorkloadTokenRequest,
  openWorkloadTokenResponse,
  p256PublicKeyFromPoint,
  refuseWorkloadTokenRequest,
  sealWorkloadTokenResponse,
  spkiSha256,
  type NodeCertLookup,
} from '@better-compute/pki';

// WorkloadTokenRequest / Response (§12.2, §13): node-signed, sealed to a one-time key, bound to the
// request and the instance, short-lived. The broker's placement checks are tested end to end in
// tests/e2e/imds.test.ts.

const NOW = Date.UTC(2026, 8, 24, 12);
const nodeKey = generateP256KeyPair().privateKey;

/** A lookup that knows nothing: the signature check fails before any other lookup. */
const nobody: NodeCertLookup = async () => undefined;

describe('workload token requests', () => {
  it('refuses a request whose node signature does not verify', async () => {
    const { request } = createWorkloadTokenRequest({ nodeKey, instanceId: 'inst_1' });
    await expect(
      openWorkloadTokenRequest(request, { nodeId: 'node_1', lookup: nobody, now: NOW }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'unknown node key' } });
    await expect(
      openWorkloadTokenRequest(
        { ...request, instanceId: '../etc' },
        { nodeId: 'node_1', lookup: nobody, now: NOW },
      ),
    ).rejects.toMatchObject({ details: { reason: 'missing or malformed request or instance id' } });
    expect(spkiSha256(nodeKey)).toHaveLength(32);
  });

  it('opens only the answer to the same request, for the same instance, before it expires', () => {
    const { request, ephemeralKey } = createWorkloadTokenRequest({
      nodeKey,
      instanceId: 'inst_1',
      audience: 'https://vault.example',
    });
    const opened = {
      requestId: request.requestId,
      instanceId: 'inst_1',
      audience: request.audience,
      recipient: generateP256KeyPair().publicKey,
      serial: '01',
      role: 'node',
    };
    // Sealed to another key: unreadable.
    const elsewhere = sealWorkloadTokenResponse(opened, 'jwt', NOW + 60_000);
    expect(() =>
      openWorkloadTokenResponse(elsewhere, ephemeralKey, {
        requestId: request.requestId,
        instanceId: 'inst_1',
        now: NOW,
      }),
    ).toThrow();
    // Sealed to the request's key: opens for that request and instance only, until it expires.
    const response = sealWorkloadTokenResponse(
      { ...opened, recipient: p256PublicKeyFromPoint(request.epk) },
      'jwt',
      NOW + 60_000,
    );
    expect(response.expiresAt).toBeDefined();
    expect(
      openWorkloadTokenResponse(response, ephemeralKey, {
        requestId: request.requestId,
        instanceId: 'inst_1',
        now: NOW,
      }),
    ).toBe('jwt');
    expect(() =>
      openWorkloadTokenResponse(response, ephemeralKey, {
        requestId: request.requestId,
        instanceId: 'inst_2',
        now: NOW,
      }),
    ).toThrow(/another request/);
    expect(() =>
      openWorkloadTokenResponse(response, ephemeralKey, {
        requestId: request.requestId,
        instanceId: 'inst_1',
        now: NOW + 120_000,
      }),
    ).toThrow(/expired/);
    const refusal = refuseWorkloadTokenRequest(request, 'not-bound');
    expect(() =>
      openWorkloadTokenResponse(refusal, ephemeralKey, {
        requestId: request.requestId,
        instanceId: 'inst_1',
        now: NOW,
      }),
    ).toThrow(/not-bound/);
  });
});
