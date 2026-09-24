import { describe, expect, it } from 'vitest';
import { bcdHostCloudInit, provisionModule, renderTemplate } from '@better-compute/provision';

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
