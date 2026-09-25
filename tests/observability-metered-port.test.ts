import { describe, expect, it } from 'vitest';
import type { IamPort } from '@better-compute/core';
import { createMetrics, meteredIamPort, standardMetrics } from '@better-compute/observability';

// meteredIamPort must keep IamPort's optional members: without authorizeSession a host refuses to
// mount tunnels, and without refreshResource admissions decide on stale projection rows (§12.4).

function port(extra: Partial<IamPort> = {}): IamPort {
  const never = async () => {
    throw new Error('not used');
  };
  return {
    authenticate: never,
    require: never,
    authorize: never,
    authorizeMany: never,
    requestConfirmation: never,
    billingCheck: never,
    recordUsage: never,
    featureEnabled: never,
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
    ...extra,
  };
}

describe('meteredIamPort', () => {
  it('passes authorizeSession and refreshResource through, and adds neither when absent', async () => {
    const metrics = standardMetrics(createMetrics());
    const refreshed: string[] = [];
    const wrapped = meteredIamPort(
      port({
        authorizeSession: async () => true,
        refreshResource: async (tenantId, resource) => {
          refreshed.push(`${tenantId}/${resource.type}/${resource.id}`);
        },
      }),
      metrics,
    );
    await expect(
      wrapped.authorizeSession!(
        { identityId: 'usr_1', sessionId: 'ses_1' },
        { tenantId: 't', action: 'a', resource: { type: 'x', id: 'y' } },
      ),
    ).resolves.toBe(true);
    await wrapped.refreshResource!('t', { type: 'compute-reservation', id: 'rsv_1' });
    expect(refreshed).toEqual(['t/compute-reservation/rsv_1']);

    const bare = meteredIamPort(port(), metrics);
    expect(bare).not.toHaveProperty('authorizeSession');
    expect(bare).not.toHaveProperty('refreshResource');
  });
});
