import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { awsInstanceIdentity, createCloudIidEvidence, type CloudIidEvidence } from '@better-compute/pki';

// AWS A6, cross-language: daemon/internal/cloud/aws/testdata/iid-evidence.json is exactly what bcd's
// aws.Client.Evidence() sends for testdata/iid-document.json and iid-signature.b64 (TestEvidenceGolden
// keeps it so). The control plane's verifier must accept those bytes with the test key, and refuse
// them changed.

const testdata = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../daemon/internal/cloud/aws/testdata/${name}`, import.meta.url)));
const evidenceBytes = new Uint8Array(testdata('iid-evidence.json'));
const pem = testdata('iid-public.pem').toString('utf8');
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as CloudIidEvidence;
const pendingTime = Date.parse('2026-11-05T10:00:00Z');

describe('bcd cloud-iid evidence', () => {
  it('verifies with awsInstanceIdentity', async () => {
    const provider = awsInstanceIdentity({ certificates: { 'us-east-1': pem }, accounts: ['123456789012'] });
    const identity = await provider.verify(parse(evidenceBytes), { now: pendingTime + 60_000 });
    expect(identity).toMatchObject({
      provider: 'aws',
      accountId: '123456789012',
      instanceId: 'i-0123456789abcdef0',
      region: 'us-east-1',
      zone: 'us-east-1a',
      createdAt: pendingTime,
    });
  });

  it('keeps the document byte for byte and the signature without line breaks', () => {
    const evidence = parse(evidenceBytes);
    expect(evidence.document).toBe(testdata('iid-document.json').toString('utf8'));
    expect(evidence.signature).toBe(testdata('iid-signature.b64').toString('utf8').replace(/\s+/g, ''));
    // The same bytes the TypeScript agent helper would send.
    expect(Buffer.from(createCloudIidEvidence(evidence)).equals(Buffer.from(evidenceBytes))).toBe(true);
  });

  it('is refused when the document is re-encoded or past the join window', async () => {
    const provider = awsInstanceIdentity({ certificates: { 'us-east-1': pem } });
    const evidence = parse(evidenceBytes);
    const compact = { ...evidence, document: JSON.stringify(JSON.parse(evidence.document)) };
    await expect(provider.verify(compact, { now: pendingTime + 60_000 })).rejects.toThrow('signature');
    await expect(provider.verify(evidence, { now: pendingTime + 31 * 60_000 })).rejects.toThrow('too-old');
  });
});
