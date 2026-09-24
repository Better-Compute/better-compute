import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

/**
 * The TPM 2.0 structures the `tpm` attestor needs (TCG TPM 2.0 Library, Part 2 "Structures" and
 * Part 1 §24 "Credential Protection"), in pure `node:crypto`: TPMT_PUBLIC (an AK's or EK's public
 * area) and its Name, TPMS_ATTEST quotes with TPMT_SIGNATURE, PCR digests, and the server side of
 * credential activation (`MakeCredential` for an RSA EK: RSA-OAEP seed with label "IDENTITY",
 * KDFa-derived AES-CFB key and HMAC). All integers are big-endian.
 *
 * Verify fit before production: cross-check with go-attestation / tpm2-tools vectors (PLAN §15).
 */

export const TPM_ALG = {
  RSA: 0x0001,
  SHA1: 0x0004,
  HMAC: 0x0005,
  AES: 0x0006,
  KEYEDHASH: 0x0008,
  SHA256: 0x000b,
  SHA384: 0x000c,
  SHA512: 0x000d,
  NULL: 0x0010,
  RSASSA: 0x0014,
  RSAES: 0x0015,
  RSAPSS: 0x0016,
  OAEP: 0x0017,
  ECDSA: 0x0018,
  ECDH: 0x0019,
  ECC: 0x0023,
  SYMCIPHER: 0x0025,
  CFB: 0x0043,
} as const;

export const TPM_ECC_CURVE = { NIST_P256: 0x0003, NIST_P384: 0x0004 } as const;

/** TPM_GENERATED_VALUE: only the TPM itself produces attestation structures that start with it. */
export const TPM_GENERATED_VALUE = 0xff544347;
export const TPM_ST_ATTEST_QUOTE = 0x8018;

/** TPMA_OBJECT bits (Part 2 §8.3). */
export const TPMA_OBJECT = {
  fixedTPM: 1 << 1,
  stClear: 1 << 2,
  fixedParent: 1 << 4,
  sensitiveDataOrigin: 1 << 5,
  userWithAuth: 1 << 6,
  adminWithPolicy: 1 << 7,
  noDA: 1 << 10,
  encryptedDuplication: 1 << 11,
  restricted: 1 << 16,
  decrypt: 1 << 17,
  sign: 1 << 18,
} as const;

const hashes: Readonly<Record<number, { name: string; size: number }>> = {
  [TPM_ALG.SHA1]: { name: 'sha1', size: 20 },
  [TPM_ALG.SHA256]: { name: 'sha256', size: 32 },
  [TPM_ALG.SHA384]: { name: 'sha384', size: 48 },
  [TPM_ALG.SHA512]: { name: 'sha512', size: 64 },
};

export class Tpm2Error extends Error {}
const bad = (what: string): never => {
  throw new Tpm2Error(what);
};

export function tpmHash(alg: number): { name: string; size: number } {
  return hashes[alg] ?? bad(`unsupported hash algorithm 0x${alg.toString(16)}`);
}

/** A bounds-checked big-endian reader. */
export class TpmReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  get position(): number {
    return this.offset;
  }
  private take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) bad('truncated structure');
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    const b = this.take(2);
    return (b[0]! << 8) | b[1]!;
  }
  u32(): number {
    const b = this.take(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }
  u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0);
  }
  bytesOf(n: number): Uint8Array {
    return this.take(n).slice();
  }
  /** TPM2B_*: a u16 size then that many bytes. */
  tpm2b(): Uint8Array {
    return this.bytesOf(this.u16());
  }
  end(what: string): void {
    if (this.remaining !== 0) bad(`trailing bytes after ${what}`);
  }
}

const u16be = (value: number): Uint8Array => new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
const u32be = (value: number): Uint8Array =>
  new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
const tpm2b = (value: Uint8Array): Uint8Array => concat(u16be(value.length), value);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- TPMT_PUBLIC ----------------------------------------------------------------------------------

export interface TpmPublic {
  type: number;
  nameAlg: number;
  attributes: number;
  authPolicy: Uint8Array;
  /** Symmetric algorithm of a storage key (EK), `NULL` otherwise; with key bits and mode. */
  symmetric: { alg: number; keyBits?: number; mode?: number };
  /** Signing scheme (RSASSA, RSAPSS, ECDSA or NULL) and its hash. */
  scheme: { alg: number; hash?: number };
  rsa?: { keyBits: number; exponent: number; modulus: Uint8Array };
  ecc?: { curve: number; x: Uint8Array; y: Uint8Array };
  /** The exact marshaled bytes (what the Name hashes). */
  bytes: Uint8Array;
  publicKey: KeyObject;
}

/** Parses a TPMT_PUBLIC (not the TPM2B wrapper) of an RSA or ECC key. */
export function parseTpmPublic(bytes: Uint8Array): TpmPublic {
  const r = new TpmReader(bytes);
  const type = r.u16();
  const nameAlg = r.u16();
  tpmHash(nameAlg);
  const attributes = r.u32();
  const authPolicy = r.tpm2b();
  const symAlg = r.u16();
  const symmetric: TpmPublic['symmetric'] =
    symAlg === TPM_ALG.NULL ? { alg: symAlg } : { alg: symAlg, keyBits: r.u16(), mode: r.u16() };
  const schemeAlg = r.u16();
  const scheme: TpmPublic['scheme'] =
    schemeAlg === TPM_ALG.NULL ? { alg: schemeAlg } : { alg: schemeAlg, hash: r.u16() };
  let parsed: Omit<TpmPublic, 'bytes' | 'publicKey'>;
  let publicKey: KeyObject;
  if (type === TPM_ALG.RSA) {
    const keyBits = r.u16();
    const exponent = r.u32() || 65537;
    const modulus = r.tpm2b();
    if (modulus.length * 8 !== keyBits) bad('RSA modulus size does not match keyBits');
    parsed = {
      type,
      nameAlg,
      attributes,
      authPolicy,
      symmetric,
      scheme,
      rsa: { keyBits, exponent, modulus },
    };
    publicKey = createPublicKey({
      key: { kty: 'RSA', n: b64u(modulus), e: b64u(uintBytes(exponent)) },
      format: 'jwk',
    });
  } else if (type === TPM_ALG.ECC) {
    const curve = r.u16();
    const kdf = r.u16();
    if (kdf !== TPM_ALG.NULL) r.u16();
    const x = r.tpm2b();
    const y = r.tpm2b();
    const crv =
      curve === TPM_ECC_CURVE.NIST_P256
        ? 'P-256'
        : curve === TPM_ECC_CURVE.NIST_P384
          ? 'P-384'
          : bad('unsupported curve');
    parsed = { type, nameAlg, attributes, authPolicy, symmetric, scheme, ecc: { curve, x, y } };
    publicKey = createPublicKey({ key: { kty: 'EC', crv, x: b64u(x), y: b64u(y) }, format: 'jwk' });
  } else return bad('unsupported key type');
  r.end('TPMT_PUBLIC');
  return { ...parsed, bytes: bytes.slice(), publicKey };
}

/** TPM2B_NAME of an object: `nameAlg ‖ H_nameAlg(TPMT_PUBLIC)`. */
export function tpmName(pub: Pick<TpmPublic, 'nameAlg' | 'bytes'>): Uint8Array {
  return concat(
    u16be(pub.nameAlg),
    new Uint8Array(createHash(tpmHash(pub.nameAlg).name).update(pub.bytes).digest()),
  );
}

/**
 * Whether a public area is an attestation key as go-attestation creates it: generated inside the
 * TPM (fixedTPM, fixedParent, sensitiveDataOrigin), restricted signing only, no decrypt.
 */
export function isAttestationKey(pub: TpmPublic): boolean {
  const must =
    TPMA_OBJECT.fixedTPM |
    TPMA_OBJECT.fixedParent |
    TPMA_OBJECT.sensitiveDataOrigin |
    TPMA_OBJECT.restricted |
    TPMA_OBJECT.sign;
  return (pub.attributes & must) === must && (pub.attributes & TPMA_OBJECT.decrypt) === 0;
}

// --- TPMS_ATTEST (quotes) -------------------------------------------------------------------------

export interface PcrSelection {
  hash: number;
  pcrs: number[];
}

export interface TpmQuote {
  qualifiedSigner: Uint8Array;
  extraData: Uint8Array;
  clock: bigint;
  resetCount: number;
  restartCount: number;
  safe: boolean;
  firmwareVersion: bigint;
  selections: PcrSelection[];
  pcrDigest: Uint8Array;
}

/** Parses a TPMS_ATTEST of type quote (`TPM2_Quote`'s `quoted`). */
export function parseQuote(bytes: Uint8Array): TpmQuote {
  const r = new TpmReader(bytes);
  if (r.u32() !== TPM_GENERATED_VALUE) bad('not TPM-generated');
  if (r.u16() !== TPM_ST_ATTEST_QUOTE) bad('not a quote');
  const qualifiedSigner = r.tpm2b();
  const extraData = r.tpm2b();
  const clock = r.u64();
  const resetCount = r.u32();
  const restartCount = r.u32();
  const safe = r.u8() === 1;
  const firmwareVersion = r.u64();
  const count = r.u32();
  if (count > 16) bad('too many PCR banks');
  const selections: PcrSelection[] = [];
  for (let i = 0; i < count; i++) {
    const hash = r.u16();
    const size = r.u8();
    if (size > 8) bad('PCR select too large');
    const select = r.bytesOf(size);
    const pcrs: number[] = [];
    for (let byte = 0; byte < size; byte++)
      for (let bit = 0; bit < 8; bit++) if (select[byte]! & (1 << bit)) pcrs.push(byte * 8 + bit);
    selections.push({ hash, pcrs });
  }
  const pcrDigest = r.tpm2b();
  r.end('TPMS_ATTEST');
  return {
    qualifiedSigner,
    extraData,
    clock,
    resetCount,
    restartCount,
    safe,
    firmwareVersion,
    selections,
    pcrDigest,
  };
}

/** Marshals a TPML_PCR_SELECTION (sizeofSelect 3, PCRs 0-23). */
export function marshalPcrSelection(selections: readonly PcrSelection[]): Uint8Array {
  const parts: Uint8Array[] = [u32be(selections.length)];
  for (const selection of selections) {
    const select = new Uint8Array(3);
    for (const pcr of selection.pcrs) {
      if (!Number.isInteger(pcr) || pcr < 0 || pcr > 23) bad('PCR index out of range');
      select[pcr >> 3]! |= 1 << (pcr & 7);
    }
    parts.push(u16be(selection.hash), new Uint8Array([3]), select);
  }
  return concat(...parts);
}

/**
 * The quote's `pcrDigest` for PCR values: `H(PCR[bank0][lowest] ‖ … )` in selection order, PCRs
 * ascending within a bank, hashed with the AK's scheme hash (go-attestation: the quote's hash).
 */
export function pcrDigest(
  selections: readonly PcrSelection[],
  values: ReadonlyMap<number, ReadonlyMap<number, Uint8Array>>,
  hashAlg: number,
): Uint8Array {
  const h = createHash(tpmHash(hashAlg).name);
  for (const selection of selections) {
    const bank =
      values.get(selection.hash) ?? bad(`no values for PCR bank 0x${selection.hash.toString(16)}`);
    for (const pcr of [...selection.pcrs].sort((a, b) => a - b)) {
      const value = bank.get(pcr) ?? bad(`no value for PCR ${pcr}`);
      if (value.length !== tpmHash(selection.hash).size) bad(`PCR ${pcr} has the wrong size`);
      h.update(value);
    }
  }
  return new Uint8Array(h.digest());
}

export interface TpmSignature {
  alg: number;
  hash: number;
  signature?: Uint8Array;
  r?: Uint8Array;
  s?: Uint8Array;
}

/** Parses a TPMT_SIGNATURE (RSASSA, RSAPSS or ECDSA). */
export function parseTpmSignature(bytes: Uint8Array): TpmSignature {
  const r = new TpmReader(bytes);
  const alg = r.u16();
  const hash = r.u16();
  tpmHash(hash);
  let out: TpmSignature;
  if (alg === TPM_ALG.RSASSA || alg === TPM_ALG.RSAPSS) out = { alg, hash, signature: r.tpm2b() };
  else if (alg === TPM_ALG.ECDSA) out = { alg, hash, r: r.tpm2b(), s: r.tpm2b() };
  else return bad('unsupported signature scheme');
  r.end('TPMT_SIGNATURE');
  return out;
}

/** Verifies `signature` by `key` (the AK) over `message` (the marshaled TPMS_ATTEST). */
export function verifyTpmSignature(
  key: TpmPublic,
  message: Uint8Array,
  signature: TpmSignature,
): boolean {
  const hash = tpmHash(signature.hash).name;
  try {
    if (signature.alg === TPM_ALG.RSASSA && key.type === TPM_ALG.RSA)
      return verify(
        hash,
        message,
        { key: key.publicKey, padding: constants.RSA_PKCS1_PADDING },
        signature.signature!,
      );
    if (signature.alg === TPM_ALG.RSAPSS && key.type === TPM_ALG.RSA)
      return verify(
        hash,
        message,
        {
          key: key.publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_AUTO,
        },
        signature.signature!,
      );
    if (signature.alg === TPM_ALG.ECDSA && key.type === TPM_ALG.ECC) {
      const size = key.ecc!.curve === TPM_ECC_CURVE.NIST_P256 ? 32 : 48;
      const pad = (v: Uint8Array) =>
        v.length > size
          ? bad('ECDSA component too large')
          : concat(new Uint8Array(size - v.length), v);
      return verify(
        hash,
        message,
        { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
        concat(pad(signature.r!), pad(signature.s!)),
      );
    }
  } catch (error) {
    if (error instanceof Tpm2Error) throw error;
    return false;
  }
  return false;
}

// --- Credential activation (server side) ----------------------------------------------------------

/** KDFa (Part 1 §11.4.10.2): counter-mode HMAC KDF, label NUL-terminated, output truncated to `bits`. */
export function kdfa(
  hashAlg: number,
  key: Uint8Array,
  label: string,
  contextU: Uint8Array,
  contextV: Uint8Array,
  bits: number,
): Uint8Array {
  const { name, size } = tpmHash(hashAlg);
  const bytes = Math.ceil(bits / 8);
  const labelBytes = concat(new TextEncoder().encode(label), new Uint8Array([0]));
  const out: Uint8Array[] = [];
  for (let counter = 1, produced = 0; produced < bytes; counter++, produced += size)
    out.push(
      new Uint8Array(
        createHmac(name, key)
          .update(concat(u32be(counter), labelBytes, contextU, contextV, u32be(bits)))
          .digest(),
      ),
    );
  const result = concat(...out).subarray(0, bytes);
  if (bits % 8) result[0]! &= 0xff >> (8 - (bits % 8));
  return result.slice();
}

export interface MadeCredential {
  /** TPM2B_ID_OBJECT's body: TPM2B(outer HMAC) ‖ encrypted TPM2B(credential). */
  credentialBlob: Uint8Array;
  /** TPM2B_ENCRYPTED_SECRET's body: the seed encrypted to the EK. */
  encryptedSecret: Uint8Array;
}

/**
 * `TPM2_MakeCredential` in software for an RSA storage EK (the default EK template: RSA 2048,
 * AES-128-CFB, SHA-256). Only a TPM holding the EK's private key AND the object named `akName`
 * can recover `credential` with `TPM2_ActivateCredential`.
 */
export function makeCredential(
  ek: TpmPublic,
  akName: Uint8Array,
  credential: Uint8Array,
  seed?: Uint8Array,
): MadeCredential {
  if (ek.type !== TPM_ALG.RSA) bad('only RSA endorsement keys are supported');
  if (
    ek.symmetric.alg !== TPM_ALG.AES ||
    ek.symmetric.mode !== TPM_ALG.CFB ||
    !ek.symmetric.keyBits
  )
    bad('the EK is not an AES-CFB storage key');
  const { name: hashName, size } = tpmHash(ek.nameAlg);
  if (credential.length > size) bad('credential longer than the EK name digest');
  const s = seed ?? new Uint8Array(randomBytes(size));
  const encryptedSecret = new Uint8Array(
    publicEncrypt(
      {
        key: ek.publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: hashName,
        oaepLabel: Buffer.from('IDENTITY\0', 'latin1'),
      },
      s,
    ),
  );
  const symKey = kdfa(ek.nameAlg, s, 'STORAGE', akName, new Uint8Array(0), ek.symmetric.keyBits!);
  const cipher = createCipheriv(`aes-${ek.symmetric.keyBits}-cfb`, symKey, Buffer.alloc(16));
  const encIdentity = new Uint8Array(
    Buffer.concat([cipher.update(tpm2b(credential)), cipher.final()]),
  );
  const hmacKey = kdfa(ek.nameAlg, s, 'INTEGRITY', new Uint8Array(0), new Uint8Array(0), size * 8);
  const outerHmac = new Uint8Array(
    createHmac(hashName, hmacKey).update(concat(encIdentity, akName)).digest(),
  );
  return { credentialBlob: concat(tpm2b(outerHmac), encIdentity), encryptedSecret };
}

// --- The TPM side, in software (FakeDaemon, tests; bcd uses the real TPM via go-attestation) -----

/** Marshals a TPMT_PUBLIC for an RSA or ECC public key. */
export function marshalTpmPublic(input: {
  key: KeyObject;
  nameAlg?: number;
  attributes: number;
  authPolicy?: Uint8Array;
  symmetric?: { alg: number; keyBits?: number; mode?: number };
  scheme?: { alg: number; hash?: number };
}): Uint8Array {
  const jwk = input.key.export({ format: 'jwk' });
  const symmetric = input.symmetric ?? { alg: TPM_ALG.NULL };
  const scheme = input.scheme ?? { alg: TPM_ALG.NULL };
  const head = concat(
    u16be(jwk.kty === 'RSA' ? TPM_ALG.RSA : TPM_ALG.ECC),
    u16be(input.nameAlg ?? TPM_ALG.SHA256),
    u32be(input.attributes),
    tpm2b(input.authPolicy ?? new Uint8Array(0)),
    u16be(symmetric.alg),
    symmetric.alg === TPM_ALG.NULL
      ? new Uint8Array(0)
      : concat(u16be(symmetric.keyBits!), u16be(symmetric.mode!)),
    u16be(scheme.alg),
    scheme.alg === TPM_ALG.NULL ? new Uint8Array(0) : u16be(scheme.hash!),
  );
  if (jwk.kty === 'RSA') {
    const modulus = new Uint8Array(Buffer.from(jwk.n!, 'base64url'));
    const exponent = Buffer.from(jwk.e!, 'base64url').readUIntBE(
      0,
      Buffer.from(jwk.e!, 'base64url').length,
    );
    return concat(
      head,
      u16be(modulus.length * 8),
      u32be(exponent === 65537 ? 0 : exponent),
      tpm2b(modulus),
    );
  }
  const curve =
    jwk.crv === 'P-256'
      ? TPM_ECC_CURVE.NIST_P256
      : jwk.crv === 'P-384'
        ? TPM_ECC_CURVE.NIST_P384
        : bad('unsupported curve');
  return concat(
    head,
    u16be(curve),
    u16be(TPM_ALG.NULL),
    tpm2b(new Uint8Array(Buffer.from(jwk.x!, 'base64url'))),
    tpm2b(new Uint8Array(Buffer.from(jwk.y!, 'base64url'))),
  );
}

/** The default EK template's attributes (TCG EK Credential Profile, template L-1). */
export const ekAttributes =
  TPMA_OBJECT.fixedTPM |
  TPMA_OBJECT.fixedParent |
  TPMA_OBJECT.sensitiveDataOrigin |
  TPMA_OBJECT.adminWithPolicy |
  TPMA_OBJECT.restricted |
  TPMA_OBJECT.decrypt;
/** An attestation key's attributes, as go-attestation creates it. */
export const akAttributes =
  TPMA_OBJECT.fixedTPM |
  TPMA_OBJECT.fixedParent |
  TPMA_OBJECT.sensitiveDataOrigin |
  TPMA_OBJECT.userWithAuth |
  TPMA_OBJECT.noDA |
  TPMA_OBJECT.restricted |
  TPMA_OBJECT.sign;

/**
 * `TPM2_ActivateCredential` in software: recovers the credential with the EK's private key, after
 * checking the outer HMAC over the encrypted identity and the AK's Name.
 */
export function activateCredential(
  ekPrivateKey: KeyObject,
  ek: TpmPublic,
  akName: Uint8Array,
  made: MadeCredential,
): Uint8Array {
  const { name: hashName, size } = tpmHash(ek.nameAlg);
  const seed = new Uint8Array(
    privateDecrypt(
      {
        key: ekPrivateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: hashName,
        oaepLabel: Buffer.from('IDENTITY\0', 'latin1'),
      },
      made.encryptedSecret,
    ),
  );
  const r = new TpmReader(made.credentialBlob);
  const outerHmac = r.tpm2b();
  const encIdentity = r.bytesOf(r.remaining);
  const hmacKey = kdfa(
    ek.nameAlg,
    seed,
    'INTEGRITY',
    new Uint8Array(0),
    new Uint8Array(0),
    size * 8,
  );
  const expected = createHmac(hashName, hmacKey).update(concat(encIdentity, akName)).digest();
  if (expected.length !== outerHmac.length || !timingSafeEqual(expected, outerHmac))
    bad('integrity check failed');
  const symKey = kdfa(
    ek.nameAlg,
    seed,
    'STORAGE',
    akName,
    new Uint8Array(0),
    ek.symmetric.keyBits!,
  );
  const decipher = createDecipheriv(`aes-${ek.symmetric.keyBits}-cfb`, symKey, Buffer.alloc(16));
  const plain = new Uint8Array(Buffer.concat([decipher.update(encIdentity), decipher.final()]));
  const inner = new TpmReader(plain);
  const credential = inner.tpm2b();
  inner.end('credential');
  return credential;
}

/** Marshals a quote TPMS_ATTEST (what `TPM2_Quote` signs). */
export function marshalQuote(quote: Omit<TpmQuote, 'safe'> & { safe?: boolean }): Uint8Array {
  const clock = new Uint8Array(8);
  new DataView(clock.buffer).setBigUint64(0, quote.clock);
  const firmware = new Uint8Array(8);
  new DataView(firmware.buffer).setBigUint64(0, quote.firmwareVersion);
  return concat(
    u32be(TPM_GENERATED_VALUE),
    u16be(TPM_ST_ATTEST_QUOTE),
    tpm2b(quote.qualifiedSigner),
    tpm2b(quote.extraData),
    clock,
    u32be(quote.resetCount),
    u32be(quote.restartCount),
    new Uint8Array([quote.safe === false ? 0 : 1]),
    firmware,
    marshalPcrSelection(quote.selections),
    tpm2b(quote.pcrDigest),
  );
}

/** Signs a marshaled TPMS_ATTEST with an AK private key into a TPMT_SIGNATURE (ECDSA or RSASSA). */
export function signTpmAttest(
  akPrivateKey: KeyObject,
  attest: Uint8Array,
  hashAlg: number = TPM_ALG.SHA256,
): Uint8Array {
  const hash = tpmHash(hashAlg).name;
  if (akPrivateKey.asymmetricKeyType === 'ec') {
    const sig = new Uint8Array(
      nodeSign(hash, attest, { key: akPrivateKey, dsaEncoding: 'ieee-p1363' }),
    );
    const half = sig.length / 2;
    return concat(
      u16be(TPM_ALG.ECDSA),
      u16be(hashAlg),
      tpm2b(sig.subarray(0, half)),
      tpm2b(sig.subarray(half)),
    );
  }
  const sig = new Uint8Array(
    nodeSign(hash, attest, { key: akPrivateKey, padding: constants.RSA_PKCS1_PADDING }),
  );
  return concat(u16be(TPM_ALG.RSASSA), u16be(hashAlg), tpm2b(sig));
}

function uintBytes(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(out.length ? out : [0]);
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
