import { beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  probeAccount,
  readSecurityFindings,
  securityAttention,
  type DoConfig,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { securityOf } from './support/do-emulator/security.js';
import {
  doAccount,
  freshBudgets,
  noopLog,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// DigitalOcean P9 security: the latest posture scan's findings, read-only, as admin attention items.

beforeEach(freshBudgets);

const context = { clock: manualClock(1_000_000), secrets, log: noopLog, account: platformAccount };

function world() {
  const emu = new DoEmulator();
  securityOf(emu).scans = [
    {
      id: 'scan-2',
      status: 'COMPLETED',
      created_at: '2026-10-05T10:00:00Z',
      findings: [
        {
          rule_uuid: 'rule-ssh',
          name: 'SSH open to the internet',
          severity: 'HIGH',
          found_at: '2026-10-05T10:01:00Z',
          affected_resources_count: 3,
          details: 'Port 22 accepts connections from 0.0.0.0/0',
          mitigation_steps: [{ step: 1, title: 'Restrict SSH', description: 'Use a firewall' }],
        },
        {
          rule_uuid: 'rule-backups',
          name: 'Droplet backups disabled',
          severity: 'low',
          found_at: '2026-10-05T10:02:00Z',
          affected_resources_count: 1,
        },
        {
          rule_uuid: 'rule-odd',
          name: 'Something new',
          severity: 'EXTREME',
          affected_resources_count: 'x',
        },
        { name: 'no rule id' },
      ],
    },
    { id: 'scan-1', status: 'COMPLETED', created_at: '2026-10-01T10:00:00Z', findings: [] },
  ];
  return emu;
}

describe('readSecurityFindings', () => {
  it('reads the latest scan’s findings, normalised, most severe first', async () => {
    const emu = world();
    const report = await readSecurityFindings(doAccount as DoConfig, context, { fetch: emu.fetch });
    expect(report.scan).toEqual({
      id: 'scan-2',
      status: 'completed',
      createdAt: Date.parse('2026-10-05T10:00:00Z'),
    });
    expect(report.findings).toEqual([
      {
        rule: 'rule-ssh',
        title: 'SSH open to the internet',
        severity: 'high',
        foundAt: Date.parse('2026-10-05T10:01:00Z'),
        affectedResources: 3,
        detail: 'Port 22 accepts connections from 0.0.0.0/0',
        mitigation: ['Restrict SSH: Use a firewall'],
      },
      {
        rule: 'rule-backups',
        title: 'Droplet backups disabled',
        severity: 'low',
        foundAt: Date.parse('2026-10-05T10:02:00Z'),
        affectedResources: 1,
      },
      // A severity it does not know is `unknown`, never promoted; a finding with no rule id is left out.
      { rule: 'rule-odd', title: 'Something new', severity: 'unknown' },
    ]);
    expect(emu.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('answers no scan and no findings for an account that was never scanned', async () => {
    const emu = new DoEmulator();
    const report = await readSecurityFindings(doAccount as DoConfig, context, { fetch: emu.fetch });
    expect(report).toEqual({ findings: [] });
  });

  it('is ACCESS_DENIED without security:read', async () => {
    const emu = world();
    emu.failNext({ path: /^\/security\// }, 403, emu.error('forbidden').body);
    await expect(
      readSecurityFindings(doAccount as DoConfig, context, { fetch: emu.fetch }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('becomes admin attention items: high is a warning, low is info, grouped by rule', async () => {
    const emu = world();
    const report = await readSecurityFindings(doAccount as DoConfig, context, { fetch: emu.fetch });
    const items = securityAttention(report, {
      accountId: 'pacct_1',
      accountName: 'do-main',
      href: '/providers/pacct_1',
    });
    expect(items[0]).toEqual({
      id: 'do-security:pacct_1:rule-ssh',
      severity: 'warning',
      title: 'SSH open to the internet on do-main',
      detail: '3 resources affected. Port 22 accepts connections from 0.0.0.0/0',
      source: 'providers',
      href: '/providers/pacct_1',
      at: Date.parse('2026-10-05T10:01:00Z'),
      subject: 'provider-account/pacct_1',
      group: 'SSH open to the internet',
      action: { label: 'Open the account', href: '/providers/pacct_1' },
    });
    expect(items.map((item) => item.severity)).toEqual(['warning', 'info', 'info']);
    // A finding without a time takes the scan's.
    expect(items[2]!.at).toBe(Date.parse('2026-10-05T10:00:00Z'));
    expect(
      securityAttention(
        { findings: [{ rule: 'r', title: 'Root login', severity: 'critical' }] },
        { accountId: 'a', accountName: 'n', href: '/x', now: 7 },
      )[0],
    ).toMatchObject({ severity: 'critical', at: 7 });
  });

  it('adds security:read to the operations probe', async () => {
    const emu = world();
    const report = await probeAccount(
      doAccount as DoConfig,
      context,
      { fetch: emu.fetch },
      { operations: true },
    );
    expect(report.operations).toMatchObject({ security: 'ok' });
  });
});
