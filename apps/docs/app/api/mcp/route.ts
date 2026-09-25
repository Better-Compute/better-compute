import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { registerSearchTool, registerSourceTools } from 'fumadocs-core/mcp';
import { z } from 'zod';
import cli from '@/generated/cli.json';
import errors from '@/generated/errors.json';
import { apiGroups, authorizationText, referenceUrl } from '@/lib/api-catalog';
import { searchApi } from '@/lib/search';
import { docsLlms, source } from '@/lib/source';
import { siteUrl, version } from '@/lib/shared';

/**
 * A Model Context Protocol endpoint for these docs, so AI assistants can search and read them while writing code
 * against Better Compute: `search`, `list_pages`, and `get_page` over the whole site, plus `lookup_api_method`,
 * `lookup_error_code`, and `lookup_cli_command` for exact reference answers from the generated catalog. Connect a
 * client to `{site}/api/mcp` (Streamable HTTP).
 */

interface ErrorEntry {
  code: string;
  status: number;
  description: string;
}

interface CliFlag {
  flag: string;
  value?: string;
  optional?: boolean;
  description: string;
  default?: unknown;
  env?: string;
}

interface CliCommand {
  name: string;
  aliases?: string[];
  group?: string;
  summary: string;
  description?: string;
  usage?: string;
  flags?: CliFlag[];
  examples?: string[];
}

const errorList = errors as unknown as ErrorEntry[];
const commands = (cli as unknown as { commands: CliCommand[] }).commands;

/** Accepts `reservations.create`, `compute.api.reservations.create(...)`, `client.joinTokens.create`, a route, or a reference URL. */
function parseMethod(query: string): [string, string] {
  const text = query.trim().replace(/\(.*$/s, '');
  const route = text.match(/\/api\/compute\/([\w-]+)\/(\w+)/);
  if (route) return [route[1]!, route[2]!];
  const reference = text.match(/\/docs\/reference\/api\/([a-z0-9-]+)#(\w+)/);
  if (reference) {
    const group = apiGroups.find((entry) => entry.slug === reference[1]);
    return [group?.group ?? reference[1]!, reference[2]!];
  }
  const [group = '', method = ''] = text
    .replace(/^compute\.api\.|^client\./, '')
    .replace('/', '.')
    .split('.');
  return [group, method];
}

function lookupMethod(query: string): string {
  const [groupName, methodName] = parseMethod(query);
  const group = apiGroups.find((entry) => entry.group.toLowerCase() === groupName.toLowerCase());
  if (!group)
    return `Unknown API group "${groupName}". Groups: ${apiGroups.map((entry) => entry.group).join(', ')}.`;
  const method = group.methods.find(
    (entry) => entry.method.toLowerCase() === methodName.toLowerCase(),
  );
  if (!method)
    return `Unknown method "${methodName}" in ${group.group}. Methods: ${group.methods.map((entry) => entry.method).join(', ')}.`;
  return [
    `# compute.api.${group.group}.${method.method}`,
    '',
    method.description || method.summary || '',
    '',
    `- HTTP: \`${method.route}\` (JSON body, header \`X-Better-Compute: 1\`)`,
    `- Server: \`compute.api.${group.group}.${method.method}(credential, input)\``,
    `- Browser client: \`client.${group.group}.${method.method}(input)\``,
    `- Kind: ${method.kind}`,
    `- Authorization: \`${authorizationText(method)}\``,
    `- Module: \`${method.module}\``,
    method.status === 'planned'
      ? `- Status: planned for ${method.phase ?? 'a later phase'}; this release does not serve it`
      : `- Status: served by this release${method.phase ? ` (PLAN.md phase ${method.phase})` : ''}`,
    '',
    `Reference: ${siteUrl}${referenceUrl(`${group.group}.${method.method}`)}`,
  ].join('\n');
}

function lookupError(code: string): string {
  const entry = errorList.find((item) => item.code === code.trim().toUpperCase());
  if (!entry)
    return `Unknown error code "${code}". Codes: ${errorList.map((item) => item.code).join(', ')}. See ${siteUrl}/docs/reference/errors.`;
  return [
    `# ${entry.code} (HTTP ${entry.status})`,
    '',
    entry.description ||
      'Errors answer `{ "error": { "code", "message", "retryAfterMs"?, "details"? } }`; codes are stable, messages are not.',
    '',
    `Reference: ${siteUrl}/docs/reference/errors`,
  ].join('\n');
}

function lookupCommand(query: string): string {
  const name = query
    .trim()
    .replace(/^better-compute\s+/, '')
    .replace(/\s+--.*$/, '')
    .replace(/\s+/g, ' ');
  const command =
    commands.find((entry) => entry.name === name || entry.aliases?.includes(name)) ??
    // `fleet plan fleet.json` still finds `fleet plan`: the longest command name the query starts with.
    commands
      .filter((entry) => name.startsWith(`${entry.name} `))
      .sort((a, b) => b.name.length - a.name.length)[0];
  if (!command)
    return `Unknown command "${name}". Commands: ${commands.map((entry) => entry.name).join(', ')}.`;
  const flags = (command.flags ?? []).map(
    (flag) =>
      `- \`${flag.flag}${flag.value ? ` ${flag.value}` : ''}\`: ${flag.description}${flag.default === undefined ? '' : ` (default \`${String(flag.default)}\`)`}${flag.env ? ` (env \`${flag.env}\`)` : ''}`,
  );
  return [
    `# better-compute ${command.name}`,
    '',
    command.summary,
    '',
    command.usage ? `\`\`\`sh\n${command.usage}\n\`\`\`` : '',
    '',
    command.description ?? '',
    '',
    flags.length ? `Flags:\n${flags.join('\n')}` : '',
    '',
    command.examples?.length ? `Examples:\n\`\`\`sh\n${command.examples.join('\n')}\n\`\`\`` : '',
    '',
    `Reference: ${siteUrl}/docs/reference/cli`,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const handler = createMcpHandler(() => {
  const mcp = new McpServer(
    { name: 'better-compute-docs', version },
    {
      instructions:
        'Documentation for Better Compute, an embeddable TypeScript control plane for GPU and bare-metal capacity (nodes, reservations, provisioning, VPS instances), authorized by Better IAM. Use `search` to find pages, `get_page` to read one as Markdown, `lookup_api_method` for the route, authorization, and status of a `compute.api.{group}.{method}` call, `lookup_error_code` for what a ComputeError code means, and `lookup_cli_command` for a `better-compute` command and its flags.',
    },
  );
  registerSearchTool(mcp, searchApi);
  registerSourceTools(mcp, source, docsLlms);
  mcp.registerTool(
    'lookup_api_method',
    {
      title: 'Look up an API method',
      description:
        'HTTP route, server and client call, IAM action, and status (served or planned) of one API method, for example "reservations.create" or "compute.api.joinTokens.create".',
      inputSchema: z.object({
        method: z.string().describe('group.method, for example "reservations.create"'),
      }),
    },
    async ({ method }) => ({ content: [{ type: 'text', text: lookupMethod(method) }] }),
  );
  mcp.registerTool(
    'lookup_error_code',
    {
      title: 'Look up an error code',
      description:
        'What a ComputeError code (for example CAPACITY_UNAVAILABLE or ACCESS_DENIED) means and its HTTP status.',
      inputSchema: z.object({ code: z.string() }),
    },
    async ({ code }) => ({ content: [{ type: 'text', text: lookupError(code) }] }),
  );
  mcp.registerTool(
    'lookup_cli_command',
    {
      title: 'Look up a CLI command',
      description:
        'Usage, flags, environment variables, and examples of one `better-compute` command, for example "dev" or "fleet apply".',
      inputSchema: z.object({
        command: z.string().describe('The command name, for example "reservations list"'),
      }),
    },
    async ({ command }) => ({ content: [{ type: 'text', text: lookupCommand(command) }] }),
  );
  return mcp;
});

export const dynamic = 'force-dynamic';

export const POST = (request: Request) => handler.fetch(request);
export const GET = (request: Request) => handler.fetch(request);
export const DELETE = (request: Request) => handler.fetch(request);
