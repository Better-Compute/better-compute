import { describe, expect, it } from 'vitest';
import { mcpFindings } from '../packages/cli/src/host/findings.js';

// doctor's host.mcp check (review 14 L6): a gated endpoint answers an unauthenticated tools/list with 401; a handler
// that answers it serves MCP without a credential.

const gated = async (request: Request) =>
  request.headers.get('authorization')
    ? Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    : new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="/.well-known/oauth-protected-resource/mcp"' },
      });

describe('host.mcp findings', () => {
  it('passes a gated endpoint and flags one that answers without a credential', async () => {
    expect(await mcpFindings({})).toEqual([]);
    expect(await mcpFindings({ mcp: { handler: gated } })).toEqual([]);
    const seen: Request[] = [];
    const ungated = async (request: Request) => {
      seen.push(request);
      return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'list_pools' }] } });
    };
    expect(await mcpFindings({ mcp: { handler: ungated, path: '/agents/mcp' } })).toEqual([
      expect.objectContaining({ check: 'host.mcp.ungated', severity: 'error', message: expect.stringContaining('/agents/mcp') }),
    ]);
    // Read-only: one tools/list, no credential.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(await seen[0]!.json()).toMatchObject({ method: 'tools/list' });
  });

  it('says nothing when the probe fails or the path is not MCP', async () => {
    expect(await mcpFindings({ mcp: { handler: () => Promise.reject(new Error('boom')) } })).toEqual([]);
    expect(await mcpFindings({ mcp: { handler: () => new Response(null, { status: 404 }) } })).toEqual([]);
  });
});
