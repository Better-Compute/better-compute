import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import {
  defineAttestor,
  type AgentRole,
  type AttestationDeferral,
  type AttestationEvidence,
  type AttestationResult,
  type AttestorVerifier,
  type NodeAttestor,
  type SqlTx,
} from '@better-compute/core';
import { base64url, fromBase64url, sha256, timingSafeEqualBytes } from '../keys.js';
import { csrSha256Of, refuser, type AttestorBaseOptions } from './common.js';
import {
  activateCredential,
  isAttestationKey,
  makeCredential,
  parseQuote,
  parseTpmPublic,
  parseTpmSignature,
  pcrDigest,
  marshalQuote,
  signTpmAttest,
  TPM_ALG,
  tpmName,
  verifyTpmSignature,
  type PcrSelection,
  type TpmPublic,
} from './tpm2.js';

/**
 * The `tpm` attestor (v0.5, PLAN.md §13, §15; go-attestation's enrollment flow) as a stateless
 * two-round join on JoinService's challenge deferral:
 *
 * 1. The agent sends its EK (public area + manufacturer certificate) and an attestation key's
 *    public area. The attestor checks the EK certificate chain and the AK's attributes, then answers
 *    with a challenge: `MakeCredential(EK, name(AK), secret)` plus an opaque state sealed with the
 *    host's `challengeKey` (AES-256-GCM) holding sha256(secret), name(AK), sha256(EK), sha256(CSR)
 *    and a deadline (≤ 5 min). No row is written; any api replica can finish the join.
 * 2. The agent's TPM activates the credential (only the TPM holding that EK, with that AK loaded,
 *    can) and quotes the PCRs with `extraData = sha256(secret ‖ sha256(csr))`. The attestor opens
 *    the state, checks the secret, the quote signature by the AK, the nonce, the PCR values against
 *    the quote's digest and the host's PCR policy, then asks `resolve` where the machine joins,
 *    keyed by sha256(EK) — a hardware identity no disk swap or reinstall changes.
 *
 * Evidence (UTF-8 JSON, both rounds):
 * `{"v":1,"ek":"<b64url TPMT_PUBLIC>","ekCert":"<b64url DER>","ekChain":[…],"ak":"<b64url TPMT_PUBLIC>",
 *   "answer":{"state","secret","quote","signature","pcrs":{"<hash alg>":{"<pcr>":"<hex>"}}}}`.
 */

export interface TpmIdentity {
  /** sha256 of the EK's TPMT_PUBLIC: the machine's stable identity. */
  ekSha256: Uint8Array;
  ekCertificate?: X509Certificate;
  akName: Uint8Array;
  /** The verified PCR values, by bank (TPM_ALG hash id) and index. */
  pcrs: ReadonlyMap<number, ReadonlyMap<number, Uint8Array>>;
}

export interface TpmAttestorOptions extends AttestorBaseOptions {
  /** 32 bytes shared by the api replicas; seals the challenge state. */
  challengeKey: Uint8Array;
  /** Manufacturer EK CA certificates (PEM or DER). The EK certificate must chain to one. */
  ekRoots?: readonly (string | Uint8Array)[];
  /** Accept an EK without a certificate (swtpm, labs). Never in production. */
  allowUncertifiedEk?: boolean;
  /** PCRs the quote must cover (default SHA-256 bank, PCRs 0-7). */
  pcrSelection?: readonly PcrSelection[];
  /** Returns a refusal reason, or undefined when the PCR values are acceptable. */
  pcrPolicy?(pcrs: TpmIdentity['pcrs']): string | undefined;
  /** Where the machine joins; undefined refuses (an EK compute does not know). */
  resolve(
    tx: SqlTx,
    identity: TpmIdentity,
    request: { role: AgentRole },
  ): Promise<AttestationResult | undefined>;
  challengeTtlMs?: number;
  roles?: readonly AgentRole[];
}

export const tpmChallengeMaxTtlMs = 5 * 60_000;
const stateAad = new TextEncoder().encode('bettercompute.v1/tpm-challenge-state');

interface TpmEvidence {
  v: 1;
  ek: string;
  ekCert?: string;
  ekChain?: string[];
  ak: string;
  answer?: {
    state: string;
    secret: string;
    quote: string;
    signature: string;
    pcrs: Record<string, Record<string, string>>;
  };
}

interface ChallengeState {
  secretSha256: string;
  akName: string;
  ekSha256: string;
  csrSha256: string;
  notAfter: number;
}

class Refusal extends Error {}
const fail = (reason: string): never => {
  throw new Refusal(reason);
};

/** The nonce a quote must carry: sha256(secret ‖ sha256(csr)). */
export function tpmQuoteNonce(secret: Uint8Array, csrSha256: Uint8Array): Uint8Array {
  const joined = new Uint8Array(secret.length + csrSha256.length);
  joined.set(secret);
  joined.set(csrSha256, secret.length);
  return sha256(joined);
}

function seal(key: Uint8Array, state: ChallengeState): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(stateAad);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return base64url(new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()])));
}

function open(key: Uint8Array, sealed: string): ChallengeState {
  try {
    const bytes = Buffer.from(fromBase64url(sealed));
    if (bytes.length < 12 + 16 + 2) fail('state');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(stateAad);
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as ChallengeState;
  } catch {
    return fail('state');
  }
}

function parseEvidence(payload: Uint8Array): TpmEvidence {
  if (payload.length === 0 || payload.length > 256 * 1024) fail('size');
  let value: TpmEvidence;
  try {
    value = JSON.parse(new TextDecoder().decode(payload)) as TpmEvidence;
  } catch {
    return fail('malformed');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    value.v !== 1 ||
    typeof value.ek !== 'string' ||
    typeof value.ak !== 'string'
  )
    fail('malformed');
  return value;
}

function certificate(input: string | Uint8Array): X509Certificate {
  return new X509Certificate(
    typeof input === 'string' && input.includes('-----BEGIN')
      ? input
      : Buffer.from(input as Uint8Array),
  );
}

const spki = (key: KeyObject) => new Uint8Array(key.export({ type: 'spki', format: 'der' }));

/** Checks the EK certificate chain to a manufacturer root and that it certifies this EK. */
function verifyEk(
  ek: TpmPublic,
  evidence: TpmEvidence,
  options: TpmAttestorOptions,
  now: number,
): X509Certificate | undefined {
  if (!evidence.ekCert) {
    if (options.allowUncertifiedEk) return undefined;
    return fail('no-ek-certificate');
  }
  let leaf: X509Certificate;
  let chain: X509Certificate[];
  let roots: X509Certificate[];
  try {
    leaf = certificate(fromBase64url(evidence.ekCert));
    chain = (evidence.ekChain ?? []).slice(0, 4).map((c) => certificate(fromBase64url(c)));
    roots = (options.ekRoots ?? []).map(certificate);
  } catch {
    return fail('ek-certificate-malformed');
  }
  if (!timingSafeEqualBytes(spki(leaf.publicKey), spki(ek.publicKey))) fail('ek-certificate-key');
  const valid = (cert: X509Certificate) => Date.parse(cert.validFrom) <= now;
  let current = leaf;
  for (let depth = 0; depth <= chain.length; depth++) {
    if (!valid(current)) fail('ek-certificate-not-yet-valid');
    const anchor = roots.find(
      (root) => current.checkIssued(root) && current.verify(root.publicKey),
    );
    if (anchor) return leaf;
    const issuer = chain[depth];
    if (!issuer || !current.checkIssued(issuer) || !current.verify(issuer.publicKey) || !issuer.ca)
      fail('ek-certificate-chain');
    current = issuer!;
  }
  return fail('ek-certificate-chain');
}

function pcrValues(
  input: TpmEvidence['answer'] extends infer A ? (A extends { pcrs: infer P } ? P : never) : never,
) {
  const banks = new Map<number, Map<number, Uint8Array>>();
  if (typeof input !== 'object' || input === null) fail('pcrs');
  for (const [alg, values] of Object.entries(input)) {
    const bank = new Map<number, Uint8Array>();
    for (const [index, hex] of Object.entries(values ?? {})) {
      if (!/^[0-9a-f]+$/i.test(hex)) fail('pcrs');
      bank.set(Number(index), new Uint8Array(Buffer.from(hex, 'hex')));
    }
    banks.set(Number(alg), bank);
  }
  return banks;
}

/** The control-plane half of `tpm`. */
export function tpmAttestor(options: TpmAttestorOptions): AttestorVerifier {
  if (!(options.challengeKey instanceof Uint8Array) || options.challengeKey.length !== 32)
    throw new TypeError('tpmAttestor needs a 32-byte challengeKey');
  const ttl = Math.min(options.challengeTtlMs ?? tpmChallengeMaxTtlMs, tpmChallengeMaxTtlMs);
  const required = options.pcrSelection ?? [
    { hash: TPM_ALG.SHA256, pcrs: [0, 1, 2, 3, 4, 5, 6, 7] },
  ];
  return defineAttestor({
    id: 'tpm',
    version: '1.0.0',
    roles: options.roles ?? ['node'],
    async verify(evidence, context): Promise<AttestationResult | AttestationDeferral> {
      const refuse = refuser('tpm', options.onRefusal);
      const csrSha256 = csrSha256Of(context);
      if (!csrSha256) return refuse('no-csr-binding');
      const now = context.clock.now();
      try {
        const e = parseEvidence(evidence.payload);
        let ek: TpmPublic;
        let ak: TpmPublic;
        try {
          ek = parseTpmPublic(fromBase64url(e.ek));
          ak = parseTpmPublic(fromBase64url(e.ak));
        } catch {
          return fail('public-area');
        }
        if (!isAttestationKey(ak)) fail('ak-attributes');
        const ekCertificate = verifyEk(ek, e, options, now);
        const akName = tpmName(ak);
        const ekSha256 = sha256(ek.bytes);

        if (!e.answer) {
          // Round 1: challenge the EK holder to prove it also holds this AK.
          const secret = new Uint8Array(randomBytes(32));
          let made;
          try {
            made = makeCredential(ek, akName, secret);
          } catch {
            return fail('ek-unsupported');
          }
          const notAfter = now + ttl;
          const state = seal(options.challengeKey, {
            secretSha256: base64url(sha256(secret)),
            akName: base64url(akName),
            ekSha256: base64url(ekSha256),
            csrSha256: base64url(csrSha256),
            notAfter,
          });
          const challenge = new TextEncoder().encode(
            JSON.stringify({
              credentialBlob: base64url(made.credentialBlob),
              encryptedSecret: base64url(made.encryptedSecret),
              state,
              pcrSelection: required,
            }),
          );
          return { deferred: 'challenge', challenge, notAfter: new Date(notAfter) };
        }

        // Round 2: the activated secret and a fresh quote.
        const answer = e.answer;
        const state = open(options.challengeKey, answer.state);
        if (!(now <= state.notAfter)) fail('challenge-expired');
        if (state.csrSha256 !== base64url(csrSha256)) fail('challenge-for-another-csr');
        if (state.akName !== base64url(akName) || state.ekSha256 !== base64url(ekSha256))
          fail('challenge-for-another-key');
        let secret: Uint8Array;
        let attest: Uint8Array;
        let signature;
        try {
          secret = fromBase64url(answer.secret);
          attest = fromBase64url(answer.quote);
          signature = parseTpmSignature(fromBase64url(answer.signature));
        } catch {
          return fail('answer-malformed');
        }
        if (!timingSafeEqualBytes(sha256(secret), fromBase64url(state.secretSha256)))
          fail('credential');
        if (!verifyTpmSignature(ak, attest, signature)) fail('quote-signature');
        let quote;
        try {
          quote = parseQuote(attest);
        } catch {
          return fail('quote-malformed');
        }
        if (!timingSafeEqualBytes(quote.extraData, tpmQuoteNonce(secret, csrSha256)))
          fail('quote-nonce');
        for (const want of required) {
          const got = quote.selections.find((s) => s.hash === want.hash);
          if (!got || !want.pcrs.every((pcr) => got.pcrs.includes(pcr))) fail('quote-selection');
        }
        const pcrs = pcrValues(answer.pcrs);
        let digest: Uint8Array;
        try {
          digest = pcrDigest(quote.selections, pcrs, signature.hash);
        } catch {
          return fail('pcr-values');
        }
        if (!timingSafeEqualBytes(digest, quote.pcrDigest)) fail('pcr-digest');
        const policy = options.pcrPolicy?.(pcrs);
        if (policy) fail(`pcr-policy:${policy}`);

        const result = await options.resolve(
          context.tx,
          { ekSha256, ...(ekCertificate ? { ekCertificate } : {}), akName, pcrs },
          { role: context.role },
        );
        if (!result) fail('unknown-ek');
        if (result!.role !== context.role) fail('role');
        return result!;
      } catch (error) {
        if (error instanceof Refusal) return refuse(error.message);
        throw error;
      }
    },
  });
}

// --- A software TPM for FakeDaemon and tests (bcd uses the real TPM through go-attestation) --------

export interface SoftwareTpm {
  ekPrivateKey: KeyObject;
  /** TPMT_PUBLIC of the EK and the AK. */
  ekPublic: Uint8Array;
  akPrivateKey: KeyObject;
  akPublic: Uint8Array;
  ekCertificate?: Uint8Array;
  ekChain?: readonly Uint8Array[];
  /** Current PCR values by bank and index. */
  pcrs: Map<number, Map<number, Uint8Array>>;
}

/**
 * The agent half of `tpm` over a software TPM. `produce({ nonce })` needs `nonce = sha256(csr)`
 * (runAgentJoin passes it); with a `challenge` it activates the credential and quotes.
 */
export function tpmProducer(tpm: SoftwareTpm): NodeAttestor {
  const base = {
    v: 1 as const,
    ek: base64url(tpm.ekPublic),
    ak: base64url(tpm.akPublic),
    ...(tpm.ekCertificate ? { ekCert: base64url(tpm.ekCertificate) } : {}),
    ...(tpm.ekChain ? { ekChain: tpm.ekChain.map(base64url) } : {}),
  };
  return {
    id: 'tpm',
    async produce(input): Promise<AttestationEvidence> {
      const encode = (value: TpmEvidence) => ({
        attestor: 'tpm',
        payload: new TextEncoder().encode(JSON.stringify(value)),
      });
      if (!input.challenge) return encode(base);
      if (!input.nonce) throw new Error('tpmProducer needs nonce = sha256(csr)');
      const challenge = JSON.parse(new TextDecoder().decode(input.challenge)) as {
        credentialBlob: string;
        encryptedSecret: string;
        state: string;
        pcrSelection: PcrSelection[];
      };
      const ek = parseTpmPublic(tpm.ekPublic);
      const ak = parseTpmPublic(tpm.akPublic);
      const secret = activateCredential(tpm.ekPrivateKey, ek, tpmName(ak), {
        credentialBlob: fromBase64url(challenge.credentialBlob),
        encryptedSecret: fromBase64url(challenge.encryptedSecret),
      });
      const selections = challenge.pcrSelection;
      const attest = marshalQuote({
        qualifiedSigner: tpmName(ak),
        extraData: tpmQuoteNonce(secret, input.nonce),
        clock: 1n,
        resetCount: 0,
        restartCount: 0,
        firmwareVersion: 1n,
        selections,
        pcrDigest: pcrDigest(selections, tpm.pcrs, TPM_ALG.SHA256),
      });
      const pcrs: Record<string, Record<string, string>> = {};
      for (const selection of selections) {
        const bank = (pcrs[selection.hash] = {} as Record<string, string>);
        for (const pcr of selection.pcrs)
          bank[pcr] = Buffer.from(tpm.pcrs.get(selection.hash)!.get(pcr)!).toString('hex');
      }
      return encode({
        ...base,
        answer: {
          state: challenge.state,
          secret: base64url(secret),
          quote: base64url(attest),
          signature: base64url(signTpmAttest(tpm.akPrivateKey, attest)),
          pcrs,
        },
      });
    },
  };
}
