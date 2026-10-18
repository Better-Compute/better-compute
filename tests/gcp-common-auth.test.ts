import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as common from '@better-compute/gcp-common';
import * as gcp from '@better-compute/provider-gcp';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const evilKeyJson = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@p.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://evil.internal/token',
});

describe('gcp-common token sources', () => {
  it('provider-gcp re-exports the same token sources', () => {
    for (const name of [
      'serviceAccountTokenSource',
      'metadataTokenSource',
      'impersonatedTokenSource',
      'cachedTokenSource',
    ] as const)
      expect(gcp[name]).toBe(common[name]);
  });

  it('the token_uri pin holds through both packages', () => {
    const fetch = vi.fn();
    for (const make of [common.serviceAccountTokenSource, gcp.serviceAccountTokenSource]) {
      let caught: unknown;
      try {
        make(evilKeyJson, { fetch });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { provider: 'gcp', reason: 'tokenUri' },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
