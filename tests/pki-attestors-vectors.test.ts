import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  cloudIidAudience,
  commandKindAllowed,
  marshalPcrSelection,
  pcrDigest,
  sha256,
  TPM_ALG,
  tpmQuoteNonce,
  x509popSigningInput,
} from '@better-compute/pki';
import { signingInput, site } from '@better-compute/protocol';

// Golden vectors for the agent half of the v0.2+ attestors: `bcd` (Go, W1) must produce these
// exact bytes. Inputs are fixed; if an output changes, the wire format changed.

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const csrSha256 = sha256(new TextEncoder().encode('csr'));
const nodeId = 'node_01k5w0000000000000000000aa';

export const vectors = {
  csrSha256: hex(csrSha256),
  x509popSigningInput: hex(
    x509popSigningInput({ csrSha256, nodeId, clientTime: Date.UTC(2026, 8, 24, 12, 0, 0, 250) }),
  ),
  discoveryAssertionBody: hex(
    toBinary(
      site.DiscoveryAssertionSchema,
      create(site.DiscoveryAssertionSchema, {
        siteId: 'site_fra1',
        siteAgentNodeId: nodeId,
        bootLeaseEpoch: 7n,
        mac: '3c:ec:ef:10:20:30',
        ip: '10.0.0.17',
        productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e32',
        workflowId: 'wf_1',
        issuedAt: timestampFromMs(Date.UTC(2026, 8, 24, 12)),
        notAfter: timestampFromMs(Date.UTC(2026, 8, 24, 12, 10)),
      }),
    ),
  ),
  tpmQuoteNonce: hex(tpmQuoteNonce(new Uint8Array(32).fill(0x11), csrSha256)),
  pcrSelection: hex(marshalPcrSelection([{ hash: TPM_ALG.SHA256, pcrs: [0, 7, 11] }])),
  pcrDigest: hex(
    pcrDigest(
      [{ hash: TPM_ALG.SHA256, pcrs: [7, 0] }],
      new Map([
        [
          TPM_ALG.SHA256 as number,
          new Map([
            [0, new Uint8Array(32).fill(0)],
            [7, new Uint8Array(32).fill(7)],
          ]),
        ],
      ]),
      TPM_ALG.SHA256,
    ),
  ),
  gcpAudience: cloudIidAudience('https://compute.example.com/join', csrSha256),
};

describe('attestor golden vectors (Go parity)', () => {
  it('matches the pinned bytes', () => {
    expect(vectors).toEqual({
      csrSha256: 'c27338c453067b437471afbce792704d816112c6031bb996b62c698ea599ef80',
      // "bettercompute.v1/x509pop" 00 | len sha256(csr) | len node_id | len(12) int64 s ‖ int32 ns
      x509popSigningInput:
        '626574746572636f6d707574652e76312f78353039706f700000000020c27338c453067b437471afbce792704d816112c6031bb996b62c698ea599ef800000001f6e6f64655f30316b35773030303030303030303030303030303030303061610000000c000000006ab510c00ee6b280',
      discoveryAssertionBody:
        '0a09736974655f66726131121f6e6f64655f30316b35773030303030303030303030303030303030303061611807221133633a65633a65663a31303a32303a33302a0931302e302e302e3137322434633463343534342d303034322d333531302d383035322d6237633034663465346533323a0477665f31420608c0a1d4d5064a060898a6d4d506',
      tpmQuoteNonce: 'd2e8fe216e3f76c3351f35b7d1f990c89f5f31b7dee144456a2f1639bfe49bc5',
      // TPML_PCR_SELECTION: count 1, SHA-256, sizeofSelect 3, PCRs 0, 7 | 11
      pcrSelection: '00000001000b03810800',
      pcrDigest: 'daf6d3e6ad66990aba2fae6e6c61f18b2d48f0ca6c29d2cfa19ab41f5a865231',
      gcpAudience: 'https://compute.example.com/join#wnM4xFMGe0N0ca-855JwTYFhEsYDG7mWtixpjqWZ74A',
    });
    const body = Buffer.from(vectors.discoveryAssertionBody, 'hex');
    expect(hex(signingInput('discovery-assertion', [body]))).toBe(
      '626574746572636f6d707574652e76312f646973636f766572792d617373657274696f6e0000000088' +
        vectors.discoveryAssertionBody,
    );
  });

  it('pins the allowed-kinds matcher bcd self-enforcement will mirror', () => {
    const allowed = ['inventory', 'diag.*', 'wipe', 'deploy.*', 'boot.kexec'];
    const cases: Array<[string, boolean]> = [
      ['inventory', true],
      ['inventory.full', false],
      ['diag.dcgm', true],
      ['diag', false],
      ['diagnose', false],
      ['deploy.image', true],
      ['boot.kexec', true],
      ['boot.prepareRamdisk', false],
      ['exec.run', false],
    ];
    for (const [kind, want] of cases)
      expect([kind, commandKindAllowed(kind, allowed)]).toEqual([kind, want]);
  });
});
