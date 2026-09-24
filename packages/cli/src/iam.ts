import { ComputeError, type IamPort } from '@better-compute/core';

/** Marks the port across copies of this package (a configuration may import another install). */
const marker = Symbol.for('better-compute.cli.unconfiguredIam');

/**
 * The `IamPort` of a deployment that has no IAM yet, for P0 configurations and environment-only
 * mode until the IAM bridge (`bridge.embedded(iam)`) arrives in v0.1. No credential authenticates
 * (`UNAUTHENTICATED`), every decision is a denial and nothing is billed, so only public methods
 * answer: `system.version`, and `system.whoami` without a credential. `better-compute doctor`
 * reports a deployment that uses it.
 */
export function unconfiguredIam(): IamPort {
  const port: IamPort = {
    async authenticate() {
      throw new ComputeError(
        'UNAUTHENTICATED',
        'No IAM is configured, so no credential can be verified',
      );
    },
    async require() {
      throw new ComputeError('ACCESS_DENIED', 'Access denied');
    },
    authorize: async () => false,
    authorizeMany: async (_credential, _tenantId, checks) => checks.map(() => false),
    requestConfirmation: async () => 'not-held-back',
    billingCheck: async () => ({ allowed: false, budgets: [] }),
    async recordUsage() {
      throw new ComputeError('INVALID_CONFIG', 'No IAM is configured, so usage cannot be recorded');
    },
    featureEnabled: async () => false,
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  };
  Object.defineProperty(port, marker, { value: true });
  return Object.freeze(port);
}

/** Whether `port` came from `unconfiguredIam()`. */
export function isUnconfiguredIam(port: unknown): boolean {
  return (
    typeof port === 'object' && port !== null && (port as Record<symbol, unknown>)[marker] === true
  );
}
