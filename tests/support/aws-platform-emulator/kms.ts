// KMS fake: symmetric keys hold a real AES-256 key (GenerateDataKey[WithoutPlaintext], Encrypt,
// Decrypt with the encryption context bound as AAD); ECC_NIST_P256 keys sign digests (Sign,
// GetPublicKey).
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { AwsEmulator, EmuError, jsonResponse } from './index.js';

function contextAad(context: unknown): Buffer {
  const entries = Object.entries((context ?? {}) as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : 1));
  return Buffer.from(JSON.stringify(entries));
}

export function kmsFake(emu: AwsEmulator) {
  const symmetric = new Map<string, Buffer>();
  const ecc = new Map<string, { privateKey: KeyObject; publicDer: Buffer }>();
  /** Every data-key plaintext the fake minted (base64), for never-printed checks. */
  const minted: string[] = [];
  const signs: { keyId: string; messageType: string; algorithm: string }[] = [];

  function addSymmetricKey(keyId: string): void {
    symmetric.set(keyId, randomBytes(32));
  }
  function addEccKey(keyId: string, privateKeyPem?: string): void {
    const privateKey = privateKeyPem
      ? createPrivateKey(privateKeyPem)
      : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    ecc.set(keyId, { privateKey, publicDer });
  }

  function encrypt(keyId: string, plaintext: Buffer, context: unknown): string {
    const key = symmetric.get(keyId);
    if (!key) throw new EmuError('NotFoundException', `key ${keyId} not found`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(contextAad(context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const id = Buffer.from(keyId);
    return Buffer.concat([Buffer.from([id.length]), id, iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  function decrypt(blob: string, context: unknown): { keyId: string; plaintext: Buffer } {
    const raw = Buffer.from(blob, 'base64');
    const idLength = raw[0] ?? 0;
    const keyId = raw.subarray(1, 1 + idLength).toString();
    const key = symmetric.get(keyId);
    if (!key) throw new EmuError('InvalidCiphertextException', 'invalid ciphertext');
    const iv = raw.subarray(1 + idLength, 13 + idLength);
    const tag = raw.subarray(13 + idLength, 29 + idLength);
    const ct = raw.subarray(29 + idLength);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(contextAad(context));
      decipher.setAuthTag(tag);
      return { keyId, plaintext: Buffer.concat([decipher.update(ct), decipher.final()]) };
    } catch {
      throw new EmuError('InvalidCiphertextException', 'invalid ciphertext');
    }
  }

  emu.register('kms', {
    protocol: 'json',
    handle(request) {
      const body = JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, unknown>;
      const keyId = String(body.KeyId ?? '');
      switch (request.operation) {
        case 'GenerateDataKey':
        case 'GenerateDataKeyWithoutPlaintext': {
          if (body.KeySpec !== 'AES_256') throw new EmuError('ValidationException', 'KeySpec');
          const plaintext = randomBytes(32);
          minted.push(plaintext.toString('base64'));
          const blob = encrypt(keyId, plaintext, body.EncryptionContext);
          return jsonResponse({
            KeyId: `arn:aws:kms:us-east-1:111111111111:key/${keyId}`,
            CiphertextBlob: blob,
            ...(request.operation === 'GenerateDataKey' ? { Plaintext: plaintext.toString('base64') } : {}),
          });
        }
        case 'Decrypt': {
          const { keyId: owner, plaintext } = decrypt(String(body.CiphertextBlob), body.EncryptionContext);
          if (keyId && keyId !== owner) throw new EmuError('IncorrectKeyException', 'wrong key');
          return jsonResponse({ KeyId: owner, Plaintext: plaintext.toString('base64') });
        }
        case 'GetPublicKey': {
          const key = ecc.get(keyId);
          if (!key) throw new EmuError('NotFoundException', 'not found');
          return jsonResponse({ KeyId: keyId, KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', PublicKey: key.publicDer.toString('base64'), SigningAlgorithms: ['ECDSA_SHA_256'] });
        }
        case 'Sign': {
          const key = ecc.get(keyId);
          if (!key) throw new EmuError('NotFoundException', 'not found');
          if (body.SigningAlgorithm !== 'ECDSA_SHA_256') throw new EmuError('InvalidKeyUsageException', 'algorithm');
          signs.push({ keyId, messageType: String(body.MessageType), algorithm: String(body.SigningAlgorithm) });
          const message = Buffer.from(String(body.Message), 'base64');
          if (body.MessageType !== 'DIGEST' || message.length !== 32) throw new EmuError('ValidationException', 'digest');
          // Sign a precomputed SHA-256 digest: node's sign(null, …) hashes, so use the raw-digest path.
          const signature = signDigest(key.privateKey, message);
          return jsonResponse({ KeyId: keyId, Signature: signature.toString('base64'), SigningAlgorithm: 'ECDSA_SHA_256' });
        }
        default:
          throw new EmuError('UnsupportedOperationException', request.operation);
      }
    },
  });
  return { symmetric, ecc, minted, signs, addSymmetricKey, addEccKey };
}


/** ECDSA over an already-hashed SHA-256 digest (DER signature), as KMS MessageType DIGEST does. */
function signDigest(privateKey: KeyObject, digest: Buffer): Buffer {
  // node:crypto has no sign-digest API for ECDSA; derive it from the JWK and do the math with BigInt.
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const d = BigInt(`0x${Buffer.from(jwk.d, 'base64url').toString('hex')}`);
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const z = BigInt(`0x${digest.toString('hex')}`);
  for (;;) {
    const k = (BigInt(`0x${randomBytes(32).toString('hex')}`) % (n - 1n)) + 1n;
    const point = p256Multiply(k);
    const r = point.x % n;
    if (r === 0n) continue;
    const s = (modInverse(k, n) * (z + r * d)) % n;
    if (s === 0n) continue;
    return derSignature(r, s);
  }
}

const p = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const a = p - 3n;
const G = {
  x: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  y: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
};
type Point = { x: bigint; y: bigint } | null;
function mod(value: bigint, m: bigint): bigint {
  const r = value % m;
  return r < 0n ? r + m : r;
}
function modInverse(value: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(value, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}
function add(P: Point, Q: Point): Point {
  if (!P) return Q;
  if (!Q) return P;
  if (P.x === Q.x && mod(P.y + Q.y, p) === 0n) return null;
  const lambda =
    P.x === Q.x && P.y === Q.y
      ? mod((3n * P.x * P.x + a) * modInverse(2n * P.y, p), p)
      : mod((Q.y - P.y) * modInverse(Q.x - P.x, p), p);
  const x = mod(lambda * lambda - P.x - Q.x, p);
  return { x, y: mod(lambda * (P.x - x) - P.y, p) };
}
function p256Multiply(k: bigint): { x: bigint; y: bigint } {
  let result: Point = null;
  let addend: Point = G;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result!;
}
function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}
function derSignature(r: bigint, s: bigint): Buffer {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
