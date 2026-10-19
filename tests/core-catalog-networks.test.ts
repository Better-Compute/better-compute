import { describe, expect, it } from 'vitest';
import {
  apiSurface,
  computeResourceKinds,
  computeResourceTypes,
  resourceTypeLimits,
} from '@better-compute/core';

describe('network kind and rows', () => {
  it('network kind and rows exist', () => {
    expect(computeResourceKinds).toContain('network');
    const types = computeResourceTypes();
    const network = types['compute-network'];
    expect(network?.parent).toBe('compute-tenant');
    expect(network?.actions).toEqual([
      'compute:networks:create',
      'compute:networks:read',
      'compute:networks:update',
      'compute:networks:delete',
    ]);
    expect(network?.attributes).toEqual({
      providerAccountId: 'string',
      poolId: 'string',
      projectId: 'string',
    });
    expect(Object.keys(network?.attributes ?? {}).length).toBeLessThanOrEqual(
      resourceTypeLimits.attributes,
    );

    const rows = apiSurface.filter(
      (row) => row.group === 'networks' || row.group === 'firewallRules',
    );
    expect(rows.map((row) => `${row.group}.${row.method}`).sort()).toEqual(
      [
        'networks.create',
        'networks.list',
        'networks.get',
        'networks.update',
        'networks.delete',
        'networks.addSubnet',
        'networks.removeSubnet',
        'networks.adopt',
        'firewallRules.create',
        'firewallRules.list',
        'firewallRules.update',
        'firewallRules.delete',
      ].sort(),
    );
    for (const row of rows) {
      expect(row.phase).toBe('v1.0');
      expect(row.module).toBe('vps');
    }
    // networks.list follows the list recipe (each network checked); firewallRules.list is a read
    // decided on the network, whose rules are not authorization objects.
    expect(rows.find((row) => row.group === 'networks' && row.method === 'list')?.list).toBe(true);
    expect(
      rows.find((row) => row.group === 'firewallRules' && row.method === 'list')?.list,
    ).toBeUndefined();
    expect(rows.find((row) => row.group === 'networks' && row.method === 'list')?.resource).toBe(
      'tenant',
    );
    expect(
      rows.find((row) => row.group === 'firewallRules' && row.method === 'list')?.resource,
    ).toBe('network');
  });
});
