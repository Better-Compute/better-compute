import {
  ComputeError,
  newId,
  type AdmissionContext,
  type Caller,
  type Credential,
  type Decision,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import type { ResolvedOptions } from './options.js';
import { rowResourceKinds, type RegisteredMethod } from './registry.js';

/** Per-call details the transport supplies. */
export interface CallOptions {
  /** The caller's valid `X-Request-Id`, or one the server generated. */
  requestId: string;
  signal?: AbortSignal;
}

export interface Operations {
  /**
   * Runs one method through the envelope (PLAN.md §3.4 steps 2, 3 and 6):
   * 1. public methods: validate and run, with the credential only when one was presented;
   * 2. otherwise: refuse a call without a credential (`UNAUTHENTICATED`, no IAM call), validate the
   *    input, authenticate once (`IamPort.authenticate`);
   * 3. the tenant pre-check: a caller outside the input's tenant and the root tenant gets
   *    `ACCESS_DENIED` before any read or write of compute's database or any IAM decision;
   * 4. one decision: `require` for mutations, `authorize` for reads;
   * 5. the handler in one transaction (read-only for reads); allowed mutations also write an
   *    `audit_events` row with the admission context in that transaction.
   * Idempotency and request-as-resource drafts (steps 4–5) arrive with the first `create`, in v0.1.
   */
  call(
    method: RegisteredMethod,
    credential: Credential | undefined,
    input: unknown,
    options: CallOptions,
  ): Promise<unknown>;
}

/** The one refusal for "outside your tenant" and "IAM said no", so neither reveals anything. */
const accessDenied = () => new ComputeError('ACCESS_DENIED', 'Access denied');

/**
 * The credential as compute passes it to IAM: the IAM cookie dropped unless `acceptIamCookie`.
 * `undefined` when nothing that could authenticate remains.
 */
export function presentedCredential(
  credential: Credential | undefined,
  acceptIamCookie: boolean,
): Credential | undefined {
  if (!credential || typeof credential !== 'object') return undefined;
  const token =
    typeof credential.token === 'string' && credential.token ? credential.token : undefined;
  let headers: Headers | undefined;
  if (credential.headers !== undefined) {
    headers = new Headers(credential.headers);
    if (!acceptIamCookie) headers.delete('cookie');
  }
  const present =
    token !== undefined ||
    headers?.has('authorization') === true ||
    headers?.has('cookie') === true;
  if (!present) return undefined;
  return { ...(headers ? { headers } : {}), ...(token !== undefined ? { token } : {}) };
}

/** The executor handlers see inside the envelope's transaction: statements run on `tx`. */
function withinTransaction(database: SqlExecutor, tx: SqlTx): SqlExecutor {
  const refuse = (what: string) => () =>
    Promise.reject(new ComputeError('INVALID_STATE', `${what} cannot run inside a method`));
  return {
    dialect: database.dialect,
    kind: database.kind,
    query: (text, params) => tx.query(text, params),
    // Nested transactions become savepoints of the method's transaction (the executors' contract).
    transaction: (fn, options) => database.transaction(fn, options),
    migrate: refuse('migrate()'),
    close: refuse('close()'),
  };
}

/** Records an allowed mutation with its admission context (`audit_events`, base schema). */
async function recordAudit(tx: SqlTx, admission: AdmissionContext): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, admission)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      newId('aud'),
      admission.tenantId,
      admission.action,
      admission.resource.type,
      admission.resource.id,
      JSON.stringify(admission),
    ],
  );
}

function tenantOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !Object.hasOwn(input, 'tenantId'))
    return undefined;
  const tenantId = (input as { tenantId: unknown }).tenantId;
  return typeof tenantId === 'string' && tenantId ? tenantId : undefined;
}

function admissionOf(
  caller: Caller,
  decision: Decision,
  requestId: string,
  decidedAt: number,
): AdmissionContext {
  const admission: AdmissionContext = {
    tenantId: decision.tenantId,
    identityId: caller.identityId,
    identityKind: caller.identityKind,
    sessionId: caller.sessionId,
    sessionKind: caller.sessionKind,
    requestId,
    action: decision.action,
    resource: { ...decision.resource },
    decidedAt,
  };
  if (caller.agentId !== undefined) admission.agentId = caller.agentId;
  if (caller.delegationId !== undefined) admission.delegationId = caller.delegationId;
  return admission;
}

export function createOperations(options: ResolvedOptions, context: ModuleContext): Operations {
  const { database, iam, rootTenantId, typePrefix, acceptIamCookie, clock } = options;

  return {
    async call(entry, raw, rawInput, { requestId, signal }) {
      const { definition, path } = entry;
      const credential = presentedCredential(raw, acceptIamCookie);
      const base = { ...context, requestId, ...(signal ? { signal } : {}) };

      if (definition.kind === 'public') {
        const input = definition.validate(rawInput ?? {});
        return definition.handler({ ...base, ...(credential ? { credential } : {}) }, input);
      }

      if (!credential) throw new ComputeError('UNAUTHENTICATED', 'A credential is required');
      const input = definition.validate(rawInput ?? {});
      const caller = await iam.authenticate(credential);

      const resource = definition.resource(input);
      if (!resource || typeof resource.type !== 'string' || typeof resource.id !== 'string')
        throw new ComputeError('INVALID_CONFIG', `${path} names no resource to decide on`);
      if (entry.row && !(rowResourceKinds(entry.row) as string[]).includes(resource.type))
        throw new ComputeError(
          'INVALID_CONFIG',
          `${path} decides on ${resource.type}, not its §9.2 resource`,
        );
      const tenantId = tenantOf(input) ?? (resource.type === 'fleet' ? rootTenantId : undefined);
      if (tenantId === undefined)
        throw new ComputeError('INVALID_CONFIG', `${path} names no tenant to decide in`);

      // §3.4 step 3: before compute's database or any decision, so an outsider learns nothing and
      // puts no traffic on the tenant's audit chain. Root callers go on to IAM (ROOT_OVERRIDE).
      if (caller.tenantId !== tenantId && caller.tenantId !== rootTenantId) throw accessDenied();

      const decision: Decision = {
        tenantId,
        action: entry.action!,
        resource: { type: `${typePrefix}${resource.type}`, id: resource.id },
      };
      const mutation = definition.kind === 'mutation';
      // Exactly one decision, outside any compute transaction (IAM holds its own lock meanwhile).
      if (mutation) await iam.require(credential, decision);
      else if (!(await iam.authorize(credential, decision))) throw accessDenied();
      const admission = mutation
        ? admissionOf(caller, decision, requestId, clock.now())
        : undefined;

      return database.transaction(
        async (tx) => {
          const methodContext: MethodContext = {
            ...base,
            sql: withinTransaction(database, tx),
            caller,
            credential,
            ...(admission ? { admission } : {}),
          };
          const value = await definition.handler(methodContext, input);
          if (admission) await recordAudit(tx, admission);
          return value;
        },
        mutation ? {} : { readOnly: true },
      );
    },
  };
}
