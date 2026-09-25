/**
 * `GatewayServices`: what a gateway process (`createGateway` in `@better-compute/gateway`) consumes
 * from the api (PLAN.md §7.7, §8.2 dependency inversion). The gateway holds no CA, signing or
 * encryption key (P14); it relays these three calls and returns the answers verbatim:
 *
 * - `join(JoinRequest)` → `JoinResponse`. Server-authenticated TLS only; the api opens the sealed
 *   token, runs the attestor chain, enrolls the node and signs `{body, sig}` with the pinned
 *   join-signing key.
 * - `renew(RenewRequest)` → `RenewResponse`. mTLS; the api verifies the current certificate against
 *   `node_certs` and the proof of possession (±60 s, 120 s replay cache) itself.
 * - `secret(SecretRequest)` → `SecretResponse` (v0.2): the secret broker (`secret-broker.ts`),
 *   given SecretStores; without any it answers `NOT_IMPLEMENTED`. Refusals are answers
 *   (`SecretResponse.error`), not errors.
 *
 * Errors are `ComputeError`s: `ACCESS_DENIED` (one generic refusal; `details.reason` is for logs),
 * `INVALID_INPUT`, `UNSUPPORTED`, `CONFLICT` (retry), `INVALID_CONFIG` (JoinService keys missing).
 * The optional `context` lets the gateway pass what it verified at the TLS layer; every proof
 * stands on its own without it. The shape is stable: new members only ever arrive optional.
 */
import {
  notImplemented,
  type AuthzWriter,
  type CertificateAuthority,
  type Clock,
  type EventPublisher,
  type Logger,
  type SecretStore,
  type SqlExecutor,
  type WorkQueue,
} from '@better-compute/core';
import { createSecretBroker, type SecretBrokerOptions } from './secret-broker.js';
import { createWorkloadBroker, type WorkloadIdentityOptions } from './workload-broker.js';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  SignedTrustBundleSchema,
  TrustBundleSchema,
  type JoinRequest,
  type JoinResponse,
  type RenewRequest,
  type RenewResponse,
  type SecretRequest,
  type SecretResponse,
  type SignedTrustBundle,
  type WorkloadTokenRequest,
  type WorkloadTokenResponse,
} from '@better-compute/protocol';
import type { JoinCrypto, JoinTrustBundle } from './crypto.js';
import { createJoinService, type GatewayCallContext, type JoinService } from './service.js';

export interface GatewayServices {
  join(request: JoinRequest, context?: GatewayCallContext): Promise<JoinResponse>;
  renew(request: RenewRequest, context?: GatewayCallContext): Promise<RenewResponse>;
  secret(request: SecretRequest, context?: GatewayCallContext): Promise<SecretResponse>;
  /**
   * `Welcome.trust` (v0.2 signed intent): the command-signing roots, signed by the JoinService key
   * (purpose `trust-bundle`) so a gateway relays it without holding a key (P14). Undefined without
   * `pki.commandSigning` or JoinService keys.
   */
  trustBundle?(): Promise<SignedTrustBundle | undefined>;
  /**
   * `WorkloadTokenRequest` → `WorkloadTokenResponse` (v0.5 workload identity, `workload-broker.ts`):
   * a VPS host's IMDS asks for one instance's token, sealed to the request's one-time key. Present
   * only with `ComputeOptions.workloadIdentity`. Refusals are answers (`error`), not errors.
   */
  workloadToken?(
    request: WorkloadTokenRequest,
    context?: GatewayCallContext,
  ): Promise<WorkloadTokenResponse>;
}

export interface GatewayServicesInput {
  database: SqlExecutor;
  clock: Clock;
  work: WorkQueue;
  events: EventPublisher;
  /**
   * `ComputeOptions.pki`: `join` carries the JoinService keys and node CA (`JoinCrypto`, satisfied
   * by `@better-compute/pki`); a bare `nodeCa` is not enough to join.
   */
  pki?: { join?: JoinCrypto; nodeCa?: CertificateAuthority } | undefined;
  /** Extensions to take attestors from (the registry's, which include `options.attestors`). */
  attestors?: readonly unknown[];
  /** Writes each joined node's authz projection row (`ctx.authz`). */
  authz?: AuthzWriter;
  log?: Logger;
  /** The IAM root tenant, for `security.join.refused` events no token attributes. */
  rootTenantId?: string;
  /**
   * `ComputeOptions.secrets`: the SecretStores behind the broker. Without any, `secret` answers
   * `NOT_IMPLEMENTED` (no broker configured).
   */
  secrets?: readonly SecretStore[];
  /** Allocation-bound refs a module knows about (see `SecretBrokerOptions.allocationRefs`). */
  allocationRefs?: SecretBrokerOptions['allocationRefs'];
  /** The command-signing trust bundle (`JoinResponse.trust`, and signed for `Welcome.trust`). */
  trustBundle?: JoinTrustBundle;
  /** Settles `trustBundle.version` against the deployment's record before it is first served. */
  trustBundleReady?: () => Promise<void>;
  /** `ComputeOptions.workloadIdentity`: turns on `workloadToken` (v0.5). */
  workloadIdentity?: WorkloadIdentityOptions;
}

/** JoinService behind the gateway-facing interface. */
export function createGatewayServices(input: GatewayServicesInput): GatewayServices {
  const service: JoinService = createJoinService({
    database: input.database,
    clock: input.clock,
    work: input.work,
    events: input.events,
    ...(input.pki?.join ? { crypto: input.pki.join } : {}),
    ...(input.attestors ? { attestors: input.attestors } : {}),
    ...(input.authz ? { authz: input.authz } : {}),
    ...(input.log ? { log: input.log } : {}),
    ...(input.rootTenantId ? { rootTenantId: input.rootTenantId } : {}),
    ...(input.trustBundle ? { trustBundle: input.trustBundle } : {}),
  });
  // Signed once per process (the roots change only with a restart or a new version).
  let signedBundle: Promise<SignedTrustBundle | undefined> | undefined;
  const trustBundle = async (): Promise<SignedTrustBundle | undefined> => {
    const bundle = input.trustBundle ?? input.pki?.join?.trustBundle;
    const crypto = input.pki?.join;
    if (!bundle || !crypto) return undefined;
    await input.trustBundleReady?.();
    const body = toBinary(
      TrustBundleSchema,
      create(TrustBundleSchema, {
        version: bundle.version,
        commandSigningRoots: [...bundle.commandSigningRoots],
        approverKeys: (bundle.approverKeys ?? []).map((key) => ({ ...key })),
        approverThreshold: bundle.approverThreshold ?? 0,
        quorumTiers: (bundle.quorumTiers ?? []).map((tier) => ({ ...tier })),
        unbatchedDestructivePerHour: bundle.unbatchedDestructivePerHour ?? 0,
        approverSetSignatures: (bundle.approverSetSignatures ?? []).map((signature) => ({
          kid: signature.kid,
          sig: signature.sig,
        })),
      }),
    );
    const signature = await crypto.sign('trust-bundle', [body]);
    return create(SignedTrustBundleSchema, {
      body,
      signature: { kid: signature.kid, sig: signature.sig, chain: [...(signature.chain ?? [])] },
    });
  };
  const broker = input.secrets?.length
    ? createSecretBroker({
        database: input.database,
        clock: input.clock,
        events: input.events,
        stores: input.secrets,
        ...(input.rootTenantId ? { rootTenantId: input.rootTenantId } : {}),
        ...(input.log ? { log: input.log } : {}),
        ...(input.allocationRefs ? { allocationRefs: input.allocationRefs } : {}),
      })
    : undefined;
  const workloadBroker = input.workloadIdentity
    ? createWorkloadBroker({
        ...input.workloadIdentity,
        database: input.database,
        clock: input.clock,
        events: input.events,
        ...(input.rootTenantId ? { rootTenantId: input.rootTenantId } : {}),
        ...(input.log ? { log: input.log } : {}),
      })
    : undefined;
  return Object.freeze({
    ...(workloadBroker ? { workloadToken: workloadBroker.workloadToken } : {}),
    join: async (request: JoinRequest, context?: GatewayCallContext) => {
      // JoinResponse.trust carries the bundle: its version must be settled first.
      await input.trustBundleReady?.();
      return service.join(request, context);
    },
    renew: (request: RenewRequest, context?: GatewayCallContext) => service.renew(request, context),
    secret: async (
      request: SecretRequest,
      context?: GatewayCallContext,
    ): Promise<SecretResponse> => {
      if (!broker) throw notImplemented('The secret broker', 'v0.2');
      return broker.secret(request, context);
    },
    trustBundle: () =>
      (signedBundle ??= trustBundle().catch((error: unknown) => {
        signedBundle = undefined; // retry on the next Welcome
        throw error;
      })),
  });
}
