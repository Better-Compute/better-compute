import { createHash, verify, type KeyObject } from 'node:crypto';
import { create, fromBinary, fromJson, toBinary, type JsonValue } from '@bufbuild/protobuf';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  CommandBodySchema,
  CommandSchema,
  DesiredStateBodySchema,
  DesiredStateSchema,
  NodeSpecSchema,
  protocolRegistry,
  SignatureSchema,
  signingInput,
  type Command,
  type CommandBody,
  type DesiredState,
  type DesiredStateBody,
  type Signature,
  type SigningPurpose,
} from '@better-compute/protocol';
import {
  fromPem,
  generateP256KeyPair,
  privateKeyPem,
  randomBytesArray,
  toPem,
  toPrivateKey,
  toPublicKey,
} from './keys.js';
import { createSigningKey, type SigningKey } from './signing.js';
import {
  buildCertificate,
  distinguishedName,
  parseCertificate,
  subjectKeyId,
  verifyCertificateChain,
} from './x509.js';

// Signed intent (PLAN.md §7.7, §13, P14): commands and desired state are signed by short-lived
// worker keys that a long-lived root (KMS or Vault transit in production) certifies. Daemons trust
// the roots in the TrustBundle they received in their JoinResponse or a newer SignedTrustBundle, so
// a gateway relaying frames cannot forge intent.

const day = 86_400;

export interface WorkerSigningKey extends SigningKey {
  readonly workerId: string;
  readonly notAfter: number;
}

export interface CommandSigningAuthority {
  /** The root certificate (DER): what `TrustBundle.command_signing_roots` carries. */
  readonly certificate: Uint8Array;
  readonly publicKey: KeyObject;
  /** Certifies a fresh 24 h worker key (kid = its certificate's subject key id). */
  issueWorkerKey(options: { workerId: string; ttlSeconds?: number }): WorkerSigningKey;
  export(): { certificatePem: string; privateKeyPem: string };
}

function serial(): Uint8Array {
  const bytes = randomBytesArray(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01;
  return bytes;
}

/**
 * A command-signing root. In production the root key lives in KMS or Vault transit and only the
 * worker certificates are issued through it; this local form serves development, tests and small
 * deployments. Worker keys live at most 24 h and carry the command-signing extended key usage.
 */
export function createCommandSigningAuthority(
  options: {
    clock?: Clock;
    commonName?: string;
    /** Root lifetime (default 5 years). */
    validitySeconds?: number;
    existing?: { privateKey: KeyObject | Uint8Array | string; certificate: Uint8Array | string };
  } = {},
): CommandSigningAuthority {
  const clock = options.clock ?? systemClock;
  let privateKey: KeyObject;
  let certificate: Uint8Array;
  if (options.existing) {
    privateKey = toPrivateKey(options.existing.privateKey);
    const cert = options.existing.certificate;
    certificate = typeof cert === 'string' ? fromPem(cert)[0]! : cert;
  } else {
    privateKey = generateP256KeyPair().privateKey;
    const now = clock.now();
    const name = distinguishedName({
      organization: 'better-compute',
      commonName: options.commonName ?? 'better-compute command signing root',
    });
    certificate = buildCertificate(
      {
        serial: serial(),
        issuer: name,
        subject: name,
        notBefore: now - 60_000,
        notAfter: now + (options.validitySeconds ?? 5 * 365 * day) * 1000,
        publicKey: toPublicKey(privateKey),
        ca: { pathLength: 0 },
      },
      privateKey,
    );
  }
  const root = parseCertificate(certificate);
  const publicKey = toPublicKey(privateKey);
  if (!root.isCa || !root.publicKey.equals(publicKey))
    throw new ComputeError(
      'INVALID_CONFIG',
      'The command-signing root certificate does not match its key',
    );
  const rootKeyId = root.subjectKeyId ?? subjectKeyId(publicKey);
  return {
    certificate,
    publicKey,
    issueWorkerKey({ workerId, ttlSeconds = day }) {
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(workerId))
        throw new ComputeError('INVALID_INPUT', 'workerId must be 1 to 64 of A-Z a-z 0-9 . _ : -');
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > day)
        throw new ComputeError('INVALID_INPUT', 'Worker signing keys live at most 24 h');
      const now = clock.now();
      if (now > root.notAfter)
        throw new ComputeError('INVALID_STATE', 'The command-signing root has expired');
      const pair = generateP256KeyPair();
      const notAfter = Math.min(now + ttlSeconds * 1000, root.notAfter);
      const workerCert = buildCertificate(
        {
          serial: serial(),
          issuer: root.subject,
          subject: distinguishedName({
            organization: 'better-compute',
            commonName: `worker ${workerId}`,
          }),
          notBefore: now - 60_000,
          notAfter,
          publicKey: pair.publicKey,
          authorityKeyId: rootKeyId,
          // OU=bc-role:worker is the command-signing mark (no private-arc EKU: Go cannot parse it).
          role: 'worker',
        },
        privateKey,
      );
      const key = createSigningKey({ privateKey: pair.privateKey, certificate: workerCert });
      return { ...key, workerId, notAfter: parseCertificate(workerCert).notAfter };
    },
    export: () => ({
      certificatePem: toPem(certificate),
      privateKeyPem: privateKeyPem(privateKey),
    }),
  };
}

export interface VerifyIntentOptions {
  /** `TrustBundle.command_signing_roots` (DER). */
  roots: readonly Uint8Array[];
  /**
   * Server time in epoch milliseconds: the daemon adds its Welcome offset, and must never let a Welcome
   * move it back (beyond skew) from the latest it saw, or a gateway could make old signatures valid again.
   */
  now: number;
  /** The node this daemon is: a body for any other node is refused. */
  nodeId: string;
  /**
   * Whether a signature is mandatory for this body (the daemon's own kind table decides, never the
   * body). A signature that is present is always checked, required or not.
   */
  required: boolean;
}

function denyIntent(reason: string): ComputeError {
  return new ComputeError('ACCESS_DENIED', 'Signed intent rejected', undefined, { reason });
}

/** Verifies an intent signature: a worker certificate chaining to a trusted root, then ES256. */
export function verifyIntentSignature(
  purpose: SigningPurpose,
  body: Uint8Array,
  signature: Signature | undefined,
  roots: readonly Uint8Array[],
  now: number,
): void {
  if (!signature) throw denyIntent('unsigned');
  if (signature.sig.length !== 64 || signature.chain.length === 0)
    throw denyIntent('malformed signature');
  let leaf;
  try {
    [leaf] = verifyCertificateChain(signature.chain, roots, { now });
  } catch (error) {
    throw denyIntent(String((error as ComputeError).details?.reason ?? 'untrusted signer'));
  }
  // The roots are the command-signing roots only; under them, a signer is a worker (OU=bc-role:worker).
  if (leaf!.role !== 'worker') throw denyIntent('not a command-signing key');
  let valid = false;
  try {
    valid = verify(
      'sha256',
      signingInput(purpose, [body]),
      { key: leaf!.publicKey, dsaEncoding: 'ieee-p1363' },
      signature.sig,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw denyIntent('bad signature');
}

/** A `Command` for `body`, signed for purpose `command` by a worker key. */
export function signCommand(body: CommandBody, key: SigningKey): Command {
  const bytes = toBinary(CommandBodySchema, body);
  return create(CommandSchema, { body: bytes, signature: key.sign('command', [bytes]) });
}

/** The daemon's check of a `Command` (§6 "Checks before accepting"). Throws `ACCESS_DENIED`. */
export function verifyCommand(command: Command, options: VerifyIntentOptions): CommandBody {
  if (command.signature || options.required)
    verifyIntentSignature('command', command.body, command.signature, options.roots, options.now);
  let body: CommandBody;
  try {
    body = fromBinary(CommandBodySchema, command.body);
  } catch {
    throw denyIntent('unreadable body');
  }
  if (body.nodeId !== options.nodeId) throw denyIntent('command for another node');
  return body;
}

/** A `DesiredState` for `body`, signed for purpose `desired-state`. */
export function signDesiredState(body: DesiredStateBody, key: SigningKey): DesiredState {
  const bytes = toBinary(DesiredStateBodySchema, body);
  return create(DesiredStateSchema, { body: bytes, signature: key.sign('desired-state', [bytes]) });
}

export interface DesiredStateInput {
  nodeId: string;
  /** The generation the spec is written at (`nodes.generation` after the write that stores it). */
  generation: number | bigint;
  /** The full NodeSpec as protobuf JSON (`nodes.spec`). */
  spec: JsonValue;
  traceparent?: string;
}

/**
 * The `DesiredStateBody` of a full spec stored as protobuf JSON: the one encoding both the spec writer (which
 * signs it) and the gateway (which renders unsigned specs) use, so a stored signature always covers the
 * bytes the gateway would produce. `spec_hash` is sha256 of the encoded NodeSpec.
 */
export function desiredStateBodyFromJson(input: DesiredStateInput): DesiredStateBody {
  const spec = fromJson(NodeSpecSchema, input.spec, { registry: protocolRegistry });
  return create(DesiredStateBodySchema, {
    nodeId: input.nodeId,
    generation: BigInt(input.generation),
    baseGeneration: 0n,
    specHash: new Uint8Array(createHash('sha256').update(toBinary(NodeSpecSchema, spec)).digest()),
    spec: { case: 'full', value: spec },
    traceparent: input.traceparent ?? '',
  });
}

/**
 * What the spec writer stores beside `nodes.spec`: the encoded body and, with a worker key, the encoded
 * `Signature` over it (purpose `desired-state`). The gateway relays both verbatim (`desiredStateFromStored`).
 */
export function storedDesiredState(
  input: DesiredStateInput,
  key?: SigningKey,
): { body: Uint8Array; signature: Uint8Array | null } {
  const body = toBinary(DesiredStateBodySchema, desiredStateBodyFromJson(input));
  return {
    body,
    signature: key ? toBinary(SignatureSchema, key.sign('desired-state', [body])) : null,
  };
}

/** The `DesiredState` frame for stored bytes (`nodes.spec_body`, `nodes.spec_signature`). */
export function desiredStateFromStored(body: Uint8Array, signature?: Uint8Array | null): DesiredState {
  return create(DesiredStateSchema, {
    body,
    ...(signature?.byteLength ? { signature: fromBinary(SignatureSchema, signature) } : {}),
  });
}

/** The daemon's check of a `DesiredState`. Throws `ACCESS_DENIED`. */
export function verifyDesiredState(
  state: DesiredState,
  options: VerifyIntentOptions,
): DesiredStateBody {
  if (state.signature || options.required)
    verifyIntentSignature('desired-state', state.body, state.signature, options.roots, options.now);
  let body: DesiredStateBody;
  try {
    body = fromBinary(DesiredStateBodySchema, state.body);
  } catch {
    throw denyIntent('unreadable body');
  }
  if (body.nodeId !== options.nodeId) throw denyIntent('spec for another node');
  return body;
}

// --- Root rotation (§13: new key first, switch after 100% ack) ------------------------------------

export interface TrustRoots {
  version: bigint;
  roots: Uint8Array[];
}

/** Step 1: publish the new root beside the old ones (workers still sign under the old root). */
export function addTrustRoot(current: TrustRoots, root: Uint8Array): TrustRoots {
  parseCertificate(root);
  if (
    current.roots.some((existing) => Buffer.compare(Buffer.from(existing), Buffer.from(root)) === 0)
  )
    return current;
  return { version: current.version + 1n, roots: [...current.roots, root] };
}

/**
 * Step 2 gate: whether every daemon of the fleet acknowledged `version` or later. Only then may
 * workers switch to keys certified by the new root.
 */
export function trustVersionAcknowledged(
  version: bigint,
  acknowledged: Iterable<bigint>,
  fleetSize: number,
): boolean {
  let count = 0;
  for (const ack of acknowledged) if (ack >= version) count++;
  return count >= fleetSize;
}

/** Step 3: once nothing is signed under it any more, drop the old root. */
export function removeTrustRoot(current: TrustRoots, root: Uint8Array): TrustRoots {
  const roots = current.roots.filter(
    (existing) => Buffer.compare(Buffer.from(existing), Buffer.from(root)) !== 0,
  );
  if (roots.length === current.roots.length) return current;
  if (roots.length === 0)
    throw new ComputeError('INVALID_STATE', 'A trust bundle keeps at least one root');
  return { version: current.version + 1n, roots };
}
