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

/** The built-in cloud-init that installs bcd and joins with the embedded token. */
export const bcdHostCloudInit = `#cloud-config
hostname: {{hostname}}
write_files:
  - path: /etc/bcd/join-token
    permissions: '0600'
    content: {{joinToken}}
runcmd:
  - [sh, -c, "curl -fsSL {{bcdUrl}} -o /usr/local/bin/bcd && echo '{{bcdSha256}}  /usr/local/bin/bcd' | sha256sum -c - && chmod 0755 /usr/local/bin/bcd"]
  - [/usr/local/bin/bcd, join, --server, {{controlPlaneUrl}}, --node-id, {{nodeId}}, --token-file, /etc/bcd/join-token]
`;

/** Templates `provisionModule` knows unless told otherwise. */
export const builtinUserDataTemplates: Readonly<Record<string, UserDataTemplate>> = Object.freeze({
  'bcd-host.yaml.hbs': bcdHostCloudInit,
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
