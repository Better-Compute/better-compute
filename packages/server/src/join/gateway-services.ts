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
 * - `secret(SecretRequest)` → `SecretResponse` (v0.2; answers `NOT_IMPLEMENTED` in v0.1).
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
  type SqlExecutor,
  type WorkQueue,
} from '@better-compute/core';
import type {
  JoinRequest,
  JoinResponse,
  RenewRequest,
  RenewResponse,
  SecretRequest,
  SecretResponse,
} from '@better-compute/protocol';
import type { JoinCrypto } from './crypto.js';
import { createJoinService, type GatewayCallContext, type JoinService } from './service.js';

export interface GatewayServices {
  join(request: JoinRequest, context?: GatewayCallContext): Promise<JoinResponse>;
  renew(request: RenewRequest, context?: GatewayCallContext): Promise<RenewResponse>;
  secret(request: SecretRequest, context?: GatewayCallContext): Promise<SecretResponse>;
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
  });
  return Object.freeze({
    join: (request: JoinRequest, context?: GatewayCallContext) => service.join(request, context),
    renew: (request: RenewRequest, context?: GatewayCallContext) => service.renew(request, context),
    secret: async (): Promise<SecretResponse> => {
      throw notImplemented('The secret broker', 'v0.2');
    },
  });
}
