import { ComputeError, manifest, type Json, type SecretRef, type StepDefinition } from '@better-compute/core';
import { workflowProfile } from './command-step.js';
import { defineStep } from './step.js';

// User data renderers (PLAN.md §3.5 step 4, §11.4). A deploy writes cloud-init (or ignition, or a
// Talos config) that embeds a single-use `provisioned` join token, so the installed OS joins as the
// same node. The rendered document is a secret: it is stored through the secret broker and only
// its reference travels in the deploy command; the ramdisk fetches it with SecretRequest.

/** A template: text with `{{name}}` placeholders, or a function of the variables. */
export type UserDataTemplate = string | ((variables: Readonly<Record<string, string>>) => string);

/** The variables every template may use. */
export interface UserDataVariables {
  nodeId: string;
  hostname: string;
  /** The single-use `provisioned` join token. */
  joinToken: string;
  /** Where bcd joins (the gateway URL) and where its binary comes from. */
  controlPlaneUrl: string;
  bcdUrl: string;
  bcdSha256: string;
  [name: string]: string;
}

const placeholder = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Substitutes `{{name}}` placeholders. Every placeholder must have a value, and values may not
 * contain line breaks or `{{`, so a value can never add lines (keys, commands) to the document.
 */
export function renderTemplate(template: UserDataTemplate, variables: Readonly<Record<string, string>>): string {
  for (const [name, value] of Object.entries(variables))
    if (typeof value !== 'string' || /[\r\n]/.test(value) || value.includes('{{'))
      throw new ComputeError('INVALID_INPUT', `User data variable ${name} must be a single line without {{`);
  if (typeof template === 'function') return template(variables);
  return template.replace(placeholder, (_, name: string) => {
    if (!Object.hasOwn(variables, name)) throw new ComputeError('INVALID_CONFIG', `The user data template uses {{${name}}}, which has no value`);
    return variables[name]!;
  });
}

/** Where the built-in user data puts bcd and the embedded join token. */
export const bcdPaths = Object.freeze({ binary: '/usr/local/bin/bcd', joinToken: '/etc/bcd/join-token' });

/**
 * The `bcd join` an installed OS runs (the Go contract; scripts/daemon-fixtures.mjs dumps it for
 * bcd's tests): the control plane URL (its well-known join keys), the token file (bcd removes it once
 * joined) and the node the OS was installed for (a `provisioned` token; bcd refuses another identity).
 * bcd writes its config.toml; `bcdNodeArgv` then runs the agent.
 */
export function bcdJoinArgv(variables: Pick<UserDataVariables, 'controlPlaneUrl' | 'nodeId'>): string[] {
  return [bcdPaths.binary, 'join', '--server', variables.controlPlaneUrl, '--token-file', bcdPaths.joinToken, '--node-id', variables.nodeId];
}

/** The node agent the installed OS runs after joining (default config, written by `bcd join`). */
export function bcdNodeArgv(): string[] {
  return [bcdPaths.binary, 'node'];
}

/** The systemd unit that keeps the node agent running. */
const bcdServiceUnit = [
  '[Unit]',
  'Description=better-compute node agent',
  'After=network-online.target bcd-join.service',
  'Wants=network-online.target',
  '[Service]',
  `ExecStart=${bcdNodeArgv().join(' ')}`,
  'Restart=always',
  'RestartSec=5',
  '[Install]',
  'WantedBy=multi-user.target',
];

const yamlFlow = (argv: readonly string[]) => `[${argv.join(', ')}]`;

/**
 * The built-in cloud-init: installs bcd (sha256 checked), joins with the embedded token, then enables
 * the node agent as `bcd.service`.
 */
export const bcdHostCloudInit = `#cloud-config
hostname: {{hostname}}
write_files:
  - path: ${bcdPaths.joinToken}
    permissions: '0600'
    content: {{joinToken}}
  - path: /etc/systemd/system/bcd.service
    permissions: '0644'
    content: |
${bcdServiceUnit.map((line) => `      ${line}`).join('\n')}
runcmd:
  - [sh, -c, "curl -fsSL {{bcdUrl}} -o ${bcdPaths.binary} && echo '{{bcdSha256}}  ${bcdPaths.binary}' | sha256sum -c - && chmod 0755 ${bcdPaths.binary}"]
  - ${yamlFlow(bcdJoinArgv({ controlPlaneUrl: '{{controlPlaneUrl}}', nodeId: '{{nodeId}}' }))}
  - [systemctl, enable, --now, bcd.service]
`;

/**
 * The built-in Ignition (spec 3.4) config: the token as a 0600 file, bcd downloaded with its
 * sha256 verified by Ignition, a oneshot unit that joins while the token file exists (bcd removes it),
 * and `bcd.service` running the node agent after it. Built as JSON, so values cannot change its
 * structure.
 */
export const bcdHostIgnition: UserDataTemplate = (v) =>
  JSON.stringify({
    ignition: { version: '3.4.0' },
    storage: {
      files: [
        { path: bcdPaths.joinToken, mode: 0o600, contents: { source: `data:,${encodeURIComponent(v.joinToken!)}` } },
        {
          path: bcdPaths.binary,
          mode: 0o755,
          contents: { source: v.bcdUrl, verification: { hash: `sha256-${v.bcdSha256}` } },
        },
        { path: '/etc/hostname', mode: 0o644, contents: { source: `data:,${encodeURIComponent(v.hostname!)}` } },
      ],
    },
    systemd: {
      units: [
        {
          name: 'bcd-join.service',
          enabled: true,
          contents: [
            '[Unit]',
            'Description=Join better-compute',
            'After=network-online.target',
            'Wants=network-online.target',
            `ConditionPathExists=${bcdPaths.joinToken}`,
            '[Service]',
            'Type=oneshot',
            'RemainAfterExit=yes',
            // One token per argument: userDataStep refuses URLs with spaces, quotes or `%` (a systemd specifier).
            `ExecStart=${bcdJoinArgv({ controlPlaneUrl: v.controlPlaneUrl!, nodeId: v.nodeId! }).join(' ')}`,
            '[Install]',
            'WantedBy=multi-user.target',
          ].join('\n'),
        },
        { name: 'bcd.service', enabled: true, contents: bcdServiceUnit.join('\n') },
      ],
    },
  });

/** Templates `provisionModule` knows unless told otherwise. */
export const builtinUserDataTemplates: Readonly<Record<string, UserDataTemplate>> = Object.freeze({
  'bcd-host.yaml.hbs': bcdHostCloudInit,
  'bcd-host.ign': bcdHostIgnition,
});

export interface UserDataOptions {
  templates?: Readonly<Record<string, UserDataTemplate>>;
  /** Where the installed bcd joins and downloads from; required to render. */
  controlPlaneUrl?: string;
  bcdUrl?: string;
  bcdSha256?: string;
  /** How long the embedded join token stays valid (default 2 h). */
  tokenTtlSeconds?: number;
}

/**
 * `userdata.render`: renders the pinned profile's `userData` for the workflow's node, with a fresh
 * single-use `provisioned` token, stores it through the secret broker, and returns
 * `{ userDataRef, kind }` for `deploy.deploy`. A re-run after a crash mints a new token; the unused
 * one is single-use and expires with its TTL, so it never becomes a second way in.
 */
export function userDataStep(options: UserDataOptions = {}): StepDefinition {
  const templates = { ...builtinUserDataTemplates, ...(options.templates ?? {}) };
  // They land in argv lists (a YAML flow sequence, a systemd ExecStart): one plain token each.
  for (const [name, url] of [['controlPlaneUrl', options.controlPlaneUrl], ['bcdUrl', options.bcdUrl]] as const)
    if (url !== undefined && !/^https?:\/\/[^\s,[\]{}'"`\\%]+$/.test(url))
      throw new ComputeError('INVALID_CONFIG', `userdata.render: ${name} must be an http(s) URL without spaces, quotes, commas, brackets or %`);
  if (options.bcdSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.bcdSha256))
    throw new ComputeError('INVALID_CONFIG', 'userdata.render: bcdSha256 must be 64 lower-case hex digits');
  return defineStep({
    id: 'userdata.render',
    runsOn: 'control-plane',
    timeout: '2m',
    retrySafe: false,
    input: manifest({}),
    async run(_input, context): Promise<Json> {
      const nodeId = context.node?.id;
      if (!nodeId) throw new ComputeError('INVALID_STATE', 'userdata.render needs a node');
      const pinned = await workflowProfile(context.sql, context.workflowId);
      const userData = pinned?.profile.userData;
      if (!userData) return { kind: 'none' };
      const template = templates[userData.template];
      if (template === undefined) throw new ComputeError('INVALID_CONFIG', `No user data template ${userData.template}`);
      if (!context.pki) throw new ComputeError('INVALID_CONFIG', 'userdata.render needs the PKI port to mint a provisioned join token');
      if (!context.secrets) throw new ComputeError('INVALID_CONFIG', 'userdata.render needs the secret broker to store the rendered user data');
      if (!options.controlPlaneUrl || !options.bcdUrl || !options.bcdSha256)
        throw new ComputeError('INVALID_CONFIG', 'userdata.render needs controlPlaneUrl, bcdUrl and bcdSha256');
      const nodes = await context.sql.query<{ site_id: string; pool_id: string | null; owner_tenant_id: string }>(
        'SELECT site_id, pool_id, owner_tenant_id FROM nodes WHERE id = $1',
        [nodeId],
      );
      const node = nodes.rows[0];
      if (!node) throw new ComputeError('NOT_FOUND', `Node ${nodeId} does not exist`);
      const token = await context.sql.transaction((tx) =>
        context.pki!.issueJoinToken(tx, {
          tenantId: node.owner_tenant_id,
          role: 'provisioned',
          siteId: node.site_id,
          ...(node.pool_id ? { poolId: node.pool_id } : {}),
          ttlSeconds: options.tokenTtlSeconds ?? 2 * 3600,
          maxUses: 1,
        }),
      );
      const rendered = renderTemplate(template, {
        nodeId,
        hostname: nodeId.replace(/_/g, '-'),
        joinToken: token.token,
        controlPlaneUrl: options.controlPlaneUrl,
        bcdUrl: options.bcdUrl,
        bcdSha256: options.bcdSha256,
      });
      const ref: SecretRef = await context.secrets.put(node.owner_tenant_id, rendered);
      return { userDataRef: ref, kind: userData.kind, joinTokenId: token.id };
    },
  });
}

/** The user data a workflow rendered (`userdata.render`'s result), if any. */
export async function renderedUserData(
  sql: { query: <R>(text: string, params?: readonly unknown[]) => Promise<{ rows: R[] }> },
  workflowId: string,
): Promise<{ userDataRef: string; kind: string } | undefined> {
  const { rows } = await sql.query<{ result: { userDataRef?: string; kind?: string } | null }>(
    `SELECT result FROM workflow_steps WHERE workflow_id = $1 AND action = 'userdata.render' AND state = 'succeeded'
      ORDER BY index DESC LIMIT 1`,
    [workflowId],
  );
  const result = rows[0]?.result;
  return result?.userDataRef && result.kind ? { userDataRef: result.userDataRef, kind: result.kind } : undefined;
}
