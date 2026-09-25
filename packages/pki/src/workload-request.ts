import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ComputeError, newId } from '@better-compute/core';
import {
  WorkloadTokenRequestSchema,
  WorkloadTokenResponseSchema,
  workloadTokenRequestSigningInput,
  type WorkloadTokenRequest,
  type WorkloadTokenResponse,
} from '@better-compute/protocol';
import { openJwe, sealJwe } from './jwe.js';
import { p256Point, p256PublicKeyFromPoint } from './keys.js';
import {
  signNodeStatement,
  verifyNodeStatement,
  type VerifyNodeStatementOptions,
} from './node-signatures.js';

// Workload identity through a host's IMDS (PLAN.md §12.2, §13; v0.5). The host holds no signing
// key: for one instance it asks the control plane over its session (WorkloadTokenRequest, signed with
// the node key, with a one-time P-256 key), and the answer is the workload JWT sealed to that key, so
// a gateway relaying it never holds a usable token. This mirrors the SecretRequest half of secrets.ts.

/** `typ` of a WorkloadTokenResponse JWE: it never opens as anything else. */
export const workloadTokenResponseType = 'bcworkload+jwe';

/** The refusal codes `WorkloadTokenResponse.error` carries. */
export type WorkloadTokenRefusal =
  | 'not-bound'
  | 'disabled'
  | 'audience'
  | 'rate-limited'
  | 'access-denied'
  | 'unavailable';

export interface OpenedWorkloadTokenRequest {
  requestId: string;
  instanceId: string;
  /** Empty for the issuer's default audience. */
  audience: string;
  /** The one-time key the response is sealed to. */
  recipient: KeyObject;
  /** The node certificate that signed the request. */
  serial: string;
  role: string;
}

const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The broker's check of a `WorkloadTokenRequest`: well-formed ids, the node signature over every
 * field (against `node_certs`, for the session's node) and a valid one-time P-256 key. Binding to an
 * instance placed on the node is the broker's own check. Throws `ACCESS_DENIED` with
 * `details.refusal`.
 */
export async function openWorkloadTokenRequest(
  request: WorkloadTokenRequest,
  options: VerifyNodeStatementOptions,
): Promise<OpenedWorkloadTokenRequest> {
  const refuse = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Workload token request refused', undefined, {
      refusal: 'access-denied',
      reason,
    });
  if (!idPattern.test(request.requestId ?? '') || !idPattern.test(request.instanceId ?? ''))
    throw refuse('missing or malformed request or instance id');
  if (request.audience.length > 512) throw refuse('audience too long');
  let verified;
  try {
    verified = await verifyNodeStatement(
      workloadTokenRequestSigningInput(request),
      request.nodeSig,
      options,
    );
  } catch (error) {
    throw refuse(String((error as ComputeError).details?.reason ?? 'bad signature'));
  }
  let recipient: KeyObject;
  try {
    recipient = p256PublicKeyFromPoint(request.epk);
  } catch {
    throw refuse('epk is not a P-256 point');
  }
  return {
    requestId: request.requestId,
    instanceId: request.instanceId,
    audience: request.audience,
    recipient,
    serial: verified.serial,
    role: verified.role,
  };
}

/** A `WorkloadTokenResponse` carrying `token` as a JWE to the request's one-time key. */
export function sealWorkloadTokenResponse(
  request: OpenedWorkloadTokenRequest,
  token: string,
  expiresAt: number,
): WorkloadTokenResponse {
  return create(WorkloadTokenResponseSchema, {
    requestId: request.requestId,
    jwe: sealJwe(token, request.recipient, {
      typ: workloadTokenResponseType,
      rid: request.requestId,
      iid: request.instanceId,
      exp: Math.floor(expiresAt / 1000),
    }),
    expiresAt: timestampFromMs(expiresAt),
  });
}

/** A refusal `WorkloadTokenResponse` (no token, no hint beyond the code). */
export function refuseWorkloadTokenRequest(
  request: Pick<WorkloadTokenRequest, 'requestId'>,
  refusal: WorkloadTokenRefusal,
): WorkloadTokenResponse {
  return create(WorkloadTokenResponseSchema, {
    requestId: typeof request.requestId === 'string' ? request.requestId : '',
    error: refusal,
  });
}

/** The host side: a signed `WorkloadTokenRequest` with a fresh one-time key (keep the private half). */
export function createWorkloadTokenRequest(options: {
  nodeKey: KeyObject;
  instanceId: string;
  audience?: string;
  requestId?: string;
}): { request: WorkloadTokenRequest; ephemeralKey: KeyObject } {
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fields = {
    requestId: options.requestId ?? newId('wtr'),
    instanceId: options.instanceId,
    audience: options.audience ?? '',
    epk: p256Point(ephemeral.publicKey),
  };
  return {
    request: create(WorkloadTokenRequestSchema, {
      ...fields,
      nodeSig: signNodeStatement(options.nodeKey, workloadTokenRequestSigningInput(fields)),
    }),
    ephemeralKey: ephemeral.privateKey,
  };
}

/**
 * The host side: the workload token of a `WorkloadTokenResponse`, opened with the request's one-time
 * key. The JWE must answer the same request for the same instance and be unexpired. Throws
 * `ACCESS_DENIED` (with `details.refusal`) for a refusal.
 */
export function openWorkloadTokenResponse(
  response: WorkloadTokenResponse,
  ephemeralKey: KeyObject,
  expect: { requestId: string; instanceId: string; now?: number },
): string {
  if (response.error)
    throw new ComputeError(
      'ACCESS_DENIED',
      `Workload token refused: ${response.error}`,
      undefined,
      {
        refusal: response.error,
      },
    );
  const opened = openJwe(response.jwe, ephemeralKey, { typ: workloadTokenResponseType });
  if (opened.header.rid !== expect.requestId || opened.header.iid !== expect.instanceId)
    throw new ComputeError('ACCESS_DENIED', 'The workload token answers another request');
  const exp = opened.header.exp;
  if (typeof exp !== 'number' || (expect.now ?? Date.now()) > exp * 1000)
    throw new ComputeError('ACCESS_DENIED', 'The workload token response has expired');
  return new TextDecoder().decode(opened.plaintext);
}
