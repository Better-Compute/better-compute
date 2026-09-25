import { describe, expect, it } from 'vitest';
import {
  bcdHostCloudInit,
  bcdHostIgnition,
  bcdJoinArgv,
  bcdNodeArgv,
  provisionModule,
  renderTemplate,
  userDataStep,
} from '@better-compute/provision';

/** A well-formed SPKI pin (sha256/ + base64 of 32 bytes). */
const pin = (fill: string) => `sha256/${Buffer.alloc(32, fill).toString('base64')}`;

// User data templates (PLAN.md §11.4): placeholders, and values that cannot inject lines.

describe('renderTemplate', () => {
  const vars = {
    nodeId: 'node_1',
    hostname: 'node-1',
    joinToken: 'bcj_abc',
    controlPlaneUrl: 'https://gw',
    bcdUrl: 'https://dl/bcd',
    bcdSha256: 'ab'.repeat(32),
  };

  it('fills every placeholder of the built-in cloud-init', () => {
    const rendered = renderTemplate(bcdHostCloudInit, vars);
    expect(rendered).toContain('hostname: node-1');
    expect(rendered).toContain('content: bcj_abc');
    expect(rendered).not.toMatch(/\{\{/);
  });

  it("runs exactly the bcd command lines bcd accepts: join with the token file, then the node agent", () => {
    // The Go contract (scripts/daemon-fixtures.mjs dumps these for bcd's own test).
    expect(bcdJoinArgv(vars)).toEqual([
      '/usr/local/bin/bcd',
      'join',
      '--server',
      'https://gw',
      '--token-file',
      '/etc/bcd/join-token',
      '--node-id',
      'node_1',
    ]);
    expect(bcdNodeArgv()).toEqual(['/usr/local/bin/bcd', 'node']);
    const rendered = renderTemplate(bcdHostCloudInit, vars);
    const runcmd = rendered.slice(rendered.indexOf('runcmd:'));
    expect(runcmd).toContain(`- [${bcdJoinArgv(vars).join(', ')}]`);
    expect(runcmd.indexOf('bcd, join')).toBeLessThan(runcmd.indexOf('[systemctl, enable, --now, bcd.service]'));
    expect(rendered).toContain('path: /etc/systemd/system/bcd.service');
    expect(rendered).toContain('      ExecStart=/usr/local/bin/bcd node');
  });

  it('refuses URLs that would not stay one argument, and a malformed digest or pin, when configured', () => {
    const good = { controlPlaneUrl: 'https://gw.example:8443/', bcdUrl: 'https://dl/bcd', bcdSha256: 'ab'.repeat(32) };
    expect(() => userDataStep(good)).not.toThrow();
    expect(() => userDataStep({})).not.toThrow();
    // A presigned download URL is fine: it is single-quoted for sh -c.
    expect(() => userDataStep({ ...good, bcdUrl: 'https://s3.example/bcd?X-Amz-Credential=a%2Fb&X-Amz-Signature=c' })).not.toThrow();
    for (const bad of [
      { ...good, controlPlaneUrl: 'https://gw, --evil' },
      { ...good, controlPlaneUrl: 'https://gw --server x' },
      { ...good, controlPlaneUrl: 'https://gw/%n' },
      { ...good, controlPlaneUrl: 'https://gw/a&b' },
      { ...good, bcdUrl: "https://dl/bcd' ; rm -rf / ; '" },
      { ...good, bcdUrl: 'ftp://dl/bcd' },
      { ...good, bcdSha256: 'xyz' },
      { ...good, pins: { servingCaPin: 'sha256/short=', joinSigningPin: pin('b'), joinEncryptionPin: pin('c') } },
      { ...good, pins: { servingCaPin: pin('a'), joinSigningPin: pin('b') } as never },
    ])
      expect(() => userDataStep(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('quotes the download URL for sh -c', () => {
    const presigned = 'https://s3.example/bcd?a=1&b=2';
    const rendered = renderTemplate(bcdHostCloudInit, { ...vars, bcdUrl: presigned });
    expect(rendered).toContain(`curl -fsSL '${presigned}' -o /usr/local/bin/bcd`);
  });

  it('renders the bootstrap pins into bcd join, in both templates, when the host has them', () => {
    const pins = { servingCaPin: pin('a'), joinSigningPin: pin('b'), joinEncryptionPin: pin('c') };
    const pinned = [
      ...bcdJoinArgv(vars),
      '--serving-ca-pin',
      pins.servingCaPin,
      '--join-signing-pin',
      pins.joinSigningPin,
      '--join-encryption-pin',
      pins.joinEncryptionPin,
    ];
    expect(bcdJoinArgv({ ...vars, pins })).toEqual(pinned);
    const withPins = { ...vars, ...pins };
    expect(renderTemplate(bcdHostCloudInit, withPins)).toContain(`- [${pinned.join(', ')}]`);
    const ignition = JSON.parse(renderTemplate(bcdHostIgnition, withPins));
    const join = ignition.systemd.units.find((unit: { name: string }) => unit.name === 'bcd-join.service').contents;
    expect(join).toContain(`ExecStart=${pinned.join(' ')}`);
    // Without them, the unpinned form (dev stacks without a PKI bundle); a partial set is refused.
    expect(renderTemplate(bcdHostCloudInit, vars)).not.toContain('--serving-ca-pin');
    expect(() => renderTemplate(bcdHostCloudInit, { ...vars, servingCaPin: pins.servingCaPin })).toThrow(/together/);
  });

  it('refuses unknown placeholders and values that would add lines', () => {
    expect(() => renderTemplate('{{missing}}', vars)).toThrow(/missing/);
    expect(() => renderTemplate('{{joinToken}}', { ...vars, joinToken: 'x\nruncmd: [rm -rf /]' })).toThrow(/single line/);
    expect(() => renderTemplate('{{joinToken}}', { ...vars, joinToken: '{{nodeId}}' })).toThrow(/single line/);
  });

  it('accepts function templates', () => {
    expect(renderTemplate((v) => `id=${v.nodeId}`, vars)).toBe('id=node_1');
  });

  it('registers userdata.render with the module', () => {
    expect(provisionModule().engineOptions.steps.get('userdata.render')).toMatchObject({ runsOn: 'control-plane', retrySafe: false });
  });
});
