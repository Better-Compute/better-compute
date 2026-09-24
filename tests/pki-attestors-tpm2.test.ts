import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activateCredential,
  akAttributes,
  ekAttributes,
  isAttestationKey,
  kdfa,
  makeCredential,
  marshalQuote,
  marshalTpmPublic,
  parseQuote,
  parseTpmPublic,
  parseTpmSignature,
  pcrDigest,
  signTpmAttest,
  TPM_ALG,
  tpmName,
  verifyTpmSignature,
} from '@better-compute/pki';

// TPM 2.0 structures for the `tpm` attestor, round-tripped against the software TPM side.

const ekPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ekPublic = parseTpmPublic(
  marshalTpmPublic({
    key: ekPair.publicKey,
    attributes: ekAttributes,
    authPolicy: new Uint8Array(32).fill(0x83),
    symmetric: { alg: TPM_ALG.AES, keyBits: 128, mode: TPM_ALG.CFB },
  }),
);
const akPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const akPublic = parseTpmPublic(
  marshalTpmPublic({
    key: akPair.publicKey,
    attributes: akAttributes,
    scheme: { alg: TPM_ALG.ECDSA, hash: TPM_ALG.SHA256 },
  }),
);

describe('TPMT_PUBLIC', () => {
  it('parses RSA EKs and ECC AKs into usable keys, and names them', () => {
    expect(ekPublic).toMatchObject({
      type: TPM_ALG.RSA,
      nameAlg: TPM_ALG.SHA256,
      rsa: { keyBits: 2048, exponent: 65537 },
    });
    expect(ekPublic.publicKey.export({ format: 'jwk' })).toEqual(
      ekPair.publicKey.export({ format: 'jwk' }),
    );
    expect(akPublic.publicKey.export({ format: 'jwk' })).toEqual(
      akPair.publicKey.export({ format: 'jwk' }),
    );
    const name = tpmName(akPublic);
    expect([...name.subarray(0, 2)]).toEqual([0x00, 0x0b]);
    expect(Buffer.from(name.subarray(2))).toEqual(
      createHash('sha256').update(akPublic.bytes).digest(),
    );
    expect(isAttestationKey(akPublic)).toBe(true);
    expect(isAttestationKey(ekPublic)).toBe(false); // decrypt, not sign
  });

  it('rejects truncated and trailing bytes', () => {
    expect(() => parseTpmPublic(akPublic.bytes.subarray(0, akPublic.bytes.length - 1))).toThrow(
      /truncated/,
    );
    expect(() => parseTpmPublic(new Uint8Array([...akPublic.bytes, 0]))).toThrow(/trailing/);
  });
});

describe('KDFa', () => {
  // go-tpm's published vectors (tpm2/test/testvectors/kdfa.json): interop, not just self-consistency.
  it.each([
    [
      'ff',
      'CFB',
      '86ed23c15d086e70a8eae700680e75d20cff',
      '51122c5879b277ff',
      140,
      '0d0be71c885d10eb61f2219000885c2d7658',
    ],
    [
      '',
      'IDENTITY',
      '4e462df0430f697bdb85c61a4ec7628943',
      'ff80c59598996ff148c6574472ece01c608a02',
      283,
      '04512482418b546925489d197cadb96768cfe9744a9142f1360de6021a94bc8dda277697',
    ],
    [
      '4599ec1b3c30340e8b4f2b5869',
      'STORAGE',
      'ff',
      '5a2b980322a96c6db49b15ff16ff',
      297,
      '00f47f8fdd0bdaf9f22ec614a8ccc370fb822fa3dd80758fddc0140a45443e4be4cbc41fe74d',
    ],
  ])('matches go-tpm vector (SHA-1, key %s, %s)', (key, label, u, v, bits, want) => {
    const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
    expect(
      Buffer.from(kdfa(TPM_ALG.SHA1, hex(key), label, hex(u), hex(v), bits)).toString('hex'),
    ).toBe(want);
  });

  it('is deterministic, length-exact and label-separated', () => {
    const key = new Uint8Array(32).fill(7);
    const a = kdfa(TPM_ALG.SHA256, key, 'STORAGE', new Uint8Array([1]), new Uint8Array(0), 128);
    expect(a).toHaveLength(16);
    expect(
      kdfa(TPM_ALG.SHA256, key, 'STORAGE', new Uint8Array([1]), new Uint8Array(0), 128),
    ).toEqual(a);
    expect(
      kdfa(TPM_ALG.SHA256, key, 'INTEGRITY', new Uint8Array([1]), new Uint8Array(0), 128),
    ).not.toEqual(a);
    expect(kdfa(TPM_ALG.SHA256, key, 'X', new Uint8Array(0), new Uint8Array(0), 520)).toHaveLength(
      65,
    );
    // The requested size is part of the input: a 256-bit output does not start with the 128-bit one.
    expect(
      kdfa(TPM_ALG.SHA256, key, 'STORAGE', new Uint8Array([1]), new Uint8Array(0), 256).subarray(
        0,
        16,
      ),
    ).not.toEqual(a);
  });
});

describe('credential activation', () => {
  it('only the EK holder, for the named AK, recovers the credential', () => {
    const secret = new Uint8Array(randomBytes(32));
    const akName = tpmName(akPublic);
    const made = makeCredential(ekPublic, akName, secret);
    expect(activateCredential(ekPair.privateKey, ekPublic, akName, made)).toEqual(secret);

    const otherAk = tpmName(
      parseTpmPublic(
        marshalTpmPublic({
          key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey,
          attributes: akAttributes,
        }),
      ),
    );
    expect(() => activateCredential(ekPair.privateKey, ekPublic, otherAk, made)).toThrow(
      /integrity/,
    );
    const otherEk = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => activateCredential(otherEk.privateKey, ekPublic, akName, made)).toThrow();
    const tampered = { ...made, credentialBlob: made.credentialBlob.slice() };
    tampered.credentialBlob[tampered.credentialBlob.length - 1]! ^= 1;
    expect(() => activateCredential(ekPair.privateKey, ekPublic, akName, tampered)).toThrow(
      /integrity/,
    );
  });

  it('refuses EKs that are not AES-CFB RSA storage keys', () => {
    expect(() => makeCredential(akPublic, tpmName(akPublic), new Uint8Array(32))).toThrow(/RSA/);
  });
});

describe('quotes', () => {
  const sha256Bank = new Map([
    [0, new Uint8Array(32).fill(1)],
    [7, new Uint8Array(32).fill(7)],
    [11, new Uint8Array(32).fill(11)],
  ]);
  const values = new Map([[TPM_ALG.SHA256 as number, sha256Bank]]);
  const selections = [{ hash: TPM_ALG.SHA256, pcrs: [11, 0, 7] }];

  function quote(nonce: Uint8Array) {
    return marshalQuote({
      qualifiedSigner: tpmName(akPublic),
      extraData: nonce,
      clock: 123456n,
      resetCount: 3,
      restartCount: 0,
      firmwareVersion: 0x2000_0001n,
      selections,
      pcrDigest: pcrDigest(selections, values, TPM_ALG.SHA256),
    });
  }

  it('round-trips a quote and verifies ECDSA and RSASSA signatures', () => {
    const nonce = new Uint8Array(32).fill(9);
    const attest = quote(nonce);
    const parsed = parseQuote(attest);
    expect(parsed).toMatchObject({
      extraData: nonce,
      resetCount: 3,
      safe: true,
      selections: [{ hash: TPM_ALG.SHA256, pcrs: [0, 7, 11] }],
    });
    expect(parsed.pcrDigest).toEqual(pcrDigest(parsed.selections, values, TPM_ALG.SHA256));

    const sig = parseTpmSignature(signTpmAttest(akPair.privateKey, attest));
    expect(verifyTpmSignature(akPublic, attest, sig)).toBe(true);
    const flipped = attest.slice();
    flipped[20]! ^= 1;
    expect(verifyTpmSignature(akPublic, flipped, sig)).toBe(false);

    const rsaAk = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaAkPublic = parseTpmPublic(
      marshalTpmPublic({
        key: rsaAk.publicKey,
        attributes: akAttributes,
        scheme: { alg: TPM_ALG.RSASSA, hash: TPM_ALG.SHA256 },
      }),
    );
    const rsaSig = parseTpmSignature(signTpmAttest(rsaAk.privateKey, attest));
    expect(rsaSig.alg).toBe(TPM_ALG.RSASSA);
    expect(verifyTpmSignature(rsaAkPublic, attest, rsaSig)).toBe(true);
    // An ECDSA signature never verifies against an RSA key (no algorithm confusion).
    expect(verifyTpmSignature(rsaAkPublic, attest, sig)).toBe(false);
  });

  it('changes the PCR digest when any selected PCR changes, and refuses what is not a quote', () => {
    const before = pcrDigest(selections, values, TPM_ALG.SHA256);
    const changed = new Map([
      [TPM_ALG.SHA256 as number, new Map([...sha256Bank, [7, new Uint8Array(32).fill(8)]])],
    ]);
    expect(pcrDigest(selections, changed, TPM_ALG.SHA256)).not.toEqual(before);
    expect(() => pcrDigest([{ hash: TPM_ALG.SHA256, pcrs: [4] }], values, TPM_ALG.SHA256)).toThrow(
      /PCR 4/,
    );
    const attest = quote(new Uint8Array(0));
    const notGenerated = attest.slice();
    notGenerated[0] = 0;
    expect(() => parseQuote(notGenerated)).toThrow(/TPM-generated/);
  });
});
