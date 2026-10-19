import { randomInt } from 'node:crypto';
import {
  ComputeError,
  isComputeError,
  isSecretRef,
  newId,
  type Clock,
  type Json,
  type Logger,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderImpl,
  type SecretResolver,
  type SqlTx,
  type WorkloadIssuerPort,
} from '@better-compute/core';
import { name, object, tenant } from './input.js';

// Provider accounts (§5.1 "code registers kinds; data configures instances"): a row per account,
// validated by its provider's manifest. Secrets are stored as SecretRefs, never as values, and
// clients are built on demand and cached by (account, version).

/** A stored provider account; `config` holds SecretRefs, never secret values. */
export interface ProviderAccount {
  id: string;
  tenantId: string;
  provider: string;
  name: string;
  config: Record<string, Json>;
  version: number;
  /** (D11) Pass-through rules; present only when the account has some (platform accounts only). */
  billing?: AccountBilling;
}

/** One pass-through rule (D11): cost rows whose SKU contains `skuPattern` bill `meter` at cost × `multiplier`. */
export interface PassThroughRule {
  /** A case-insensitive substring of the row's SKU id or description. */
  skuPattern: string;
  /** A better-iam `reported` meter on the root tenant. */
  meter: string;
  /** 1 to 10. */
  multiplier: number;
}

/** `providerAccounts.create/update` `billing` (D11): root accounts only. */
export interface AccountBilling {
  passThrough?: PassThroughRule[];
}

interface RawAccount {
  id: string;
  tenant_id: string;
  provider: string;
  name: string;
  config: Record<string, Json> | string;
  version: string | number;
  billing?: AccountBilling | string | null;
}

function toAccount(row: RawAccount): ProviderAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    name: row.name,
    config:
      typeof row.config === 'string'
        ? (JSON.parse(row.config) as Record<string, Json>)
        : row.config,
    version: Number(row.version),
    ...billingOf(row.billing),
  };
}

/** The stored billing column as the account shows it: absent unless it holds rules. */
function billingOf(raw: AccountBilling | string | null | undefined): { billing?: AccountBilling } {
  const billing = typeof raw === 'string' ? (JSON.parse(raw) as AccountBilling) : raw;
  return billing?.passThrough?.length ? { billing: { passThrough: billing.passThrough } } : {};
}

export async function readAccount(
  tx: SqlTx,
  accountId: string,
  tenantId?: string,
): Promise<ProviderAccount | undefined> {
  const { rows } = await tx.query<RawAccount>(
    `SELECT id, tenant_id, provider, name, config, version, billing FROM provider_accounts
      WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)`,
    [accountId, tenantId ?? null],
  );
  return rows[0] ? toAccount(rows[0]) : undefined;
}

/**
 * The provider account an instance of `poolId` runs on, when the pool's owner tenant owns it (R1):
 * a pool row naming another tenant's account never drives that account.
 */
export async function readPoolAccount(
  tx: SqlTx,
  accountId: string,
  poolId: string,
): Promise<ProviderAccount | undefined> {
  const { rows } = await tx.query<RawAccount>(
    `SELECT a.id, a.tenant_id, a.provider, a.name, a.config, a.version, a.billing
       FROM provider_accounts a JOIN pools p ON p.id = $2 AND p.owner_tenant_id = a.tenant_id
      WHERE a.id = $1`,
    [accountId, poolId],
  );
  return rows[0] ? toAccount(rows[0]) : undefined;
}

export async function listAccounts(tx: SqlTx, tenantId: string): Promise<ProviderAccount[]> {
  const { rows } = await tx.query<RawAccount>(
    `SELECT id, tenant_id, provider, name, config, version, billing FROM provider_accounts
      WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return rows.map(toAccount);
}

/** Validates `config` with the provider's manifest (Standard Schema v1); `INVALID_INPUT` with issues. */
export async function validateConfig(
  provider: ProviderDefinition,
  config: unknown,
): Promise<Record<string, Json>> {
  const result = await provider.config['~standard'].validate(config);
  if ('issues' in result && result.issues)
    throw new ComputeError('INVALID_INPUT', `Invalid ${provider.id} account config`, undefined, {
      issues: result.issues.map((issue) => ({
        message: issue.message,
        path: (issue.path ?? []).map((segment) =>
          typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment),
        ),
      })),
    });
  const value = (result as { value: unknown }).value;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputeError('INVALID_INPUT', `Invalid ${provider.id} account config`);
  return value as Record<string, Json>;
}

/** Strings that look like credentials but are not SecretRefs are refused (defence in depth). */
export function assertNoInlineSecrets(config: Record<string, Json>, path = 'config'): void {
  for (const [field, value] of Object.entries(config)) {
    const here = `${path}.${field}`;
    if (
      typeof value === 'string' &&
      /(token|secret|password|key)$/i.test(field) &&
      !isSecretRef(value)
    )
      throw new ComputeError(
        'INVALID_INPUT',
        `${here} must be a secret reference (secret://, vault:// or env://), never a raw value`,
      );
    if (value && typeof value === 'object' && !Array.isArray(value))
      assertNoInlineSecrets(value as Record<string, Json>, here);
  }
}

/**
 * `vps({ tenantVaultPaths })`: the `vault://` paths each tenant's provider accounts may name, by
 * tenant id. An entry ending in `/` allows every path under it; any other entry allows that path.
 */
export type TenantVaultPaths = Readonly<Record<string, readonly string[]>>;

/** Validates `vps({ tenantVaultPaths })`; `INVALID_CONFIG` names the bad entry. */
export function parseTenantVaultPaths(raw: unknown): TenantVaultPaths {
  const bad = (message: string) =>
    new ComputeError('INVALID_CONFIG', `vps({ tenantVaultPaths }): ${message}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw bad('expected { [tenantId]: paths[] }');
  const out: Record<string, readonly string[]> = {};
  for (const [tenantId, paths] of Object.entries(raw)) {
    if (!Array.isArray(paths)) throw bad(`${tenantId} must list vault paths`);
    for (const path of paths)
      if (typeof path !== 'string' || !cleanVaultPath(path.replace(/\/$/, '')))
        throw bad(`${tenantId} lists ${JSON.stringify(path)}, not a vault path`);
    out[tenantId] = Object.freeze([...(paths as string[])]);
  }
  return Object.freeze(out);
}

/**
 * A path of plain segments: no empty, `.` or `..` segment, and no `%` (an encoded `..` a store might
 * decode), `?`, backslash or space; nothing that could leave a prefix.
 */
function cleanVaultPath(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\s\\?%]/.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/** What decides which refs an account may name: the root tenant and the vault allow-list. */
export interface AccountSecretScope {
  rootTenantId?: string;
  tenantVaultPaths?: TenantVaultPaths;
}

/**
 * Why `account` may not name `ref`, or undefined when it may. A platform (root-tenant) account may
 * name any ref. A tenant's account may name only `secret://<its tenant>/…`, and `vault://` paths
 * `tenantVaultPaths` allows that tenant; never `env://` (the control plane's own environment) nor
 * another tenant's or the platform's secrets, which the account would otherwise run as.
 */
export function accountRefRefusal(
  ref: string,
  account: Pick<ProviderAccount, 'tenantId'>,
  scope: AccountSecretScope,
): string | undefined {
  if (scope.rootTenantId !== undefined && account.tenantId === scope.rootTenantId) return undefined;
  if (ref.startsWith('secret://'))
    return parseSecretRefTenant(ref) === account.tenantId
      ? undefined
      : `a tenant's account may only use secret://${account.tenantId}/… refs`;
  if (ref.startsWith('vault://')) {
    const path = ref.slice('vault://'.length);
    const allowed = scope.tenantVaultPaths?.[account.tenantId] ?? [];
    const match =
      cleanVaultPath(path) &&
      allowed.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
    return match ? undefined : `vault://${path} is not allowed for tenant ${account.tenantId}`;
  }
  const scheme = /^([a-z]+):\/\//.exec(ref)?.[1];
  return scheme
    ? `a tenant's account may not use ${scheme}:// refs`
    : `a tenant's account may only use secret references`;
}

/** The tenant of a `secret://<tenant>/<id>` ref (undefined when it is not one); as pki's `parseSecretRef`. */
function parseSecretRefTenant(ref: string): string | undefined {
  return /^secret:\/\/([A-Za-z0-9._:-]{1,128})\/[A-Za-z0-9._-]{1,128}$/.exec(ref)?.[1];
}

/** Every SecretRef in `config` with where it is (objects and arrays, at any depth). */
function secretRefsOf(value: Json, path: string, out: Array<[string, string]> = []) {
  if (typeof value === 'string') {
    if (isSecretRef(value)) out.push([path, value]);
  } else if (Array.isArray(value))
    value.forEach((item, index) => secretRefsOf(item, `${path}[${index}]`, out));
  else if (value && typeof value === 'object')
    for (const [field, item] of Object.entries(value)) secretRefsOf(item, `${path}.${field}`, out);
  return out;
}

/**
 * Refuses (`INVALID_CONFIG`) an account config naming a ref its tenant may not use
 * (`accountRefRefusal`), so a tenant's account never runs on the platform's credentials.
 */
export function assertAccountSecretRefs(
  config: Record<string, Json>,
  account: Pick<ProviderAccount, 'tenantId'>,
  scope: AccountSecretScope,
): void {
  for (const [path, ref] of secretRefsOf(config, 'config')) {
    const refusal = accountRefRefusal(ref, account, scope);
    if (refusal)
      throw new ComputeError('INVALID_CONFIG', `${path}: ${refusal}`, undefined, {
        path,
        reason: 'secretRefScope',
      });
  }
}

/**
 * The resolver a provider client gets: refs the account may not name are refused at resolve time
 * too (an account stored before the check, or written around the API), and a tenant's refs are
 * resolved with its tenant as the context, so the store checks the secret is that tenant's.
 */
export function accountSecrets(
  secrets: SecretResolver,
  account: Pick<ProviderAccount, 'id' | 'tenantId'>,
  scope: AccountSecretScope,
): SecretResolver {
  const platform = scope.rootTenantId !== undefined && account.tenantId === scope.rootTenantId;
  return {
    resolve: async (ref) => {
      const refusal = accountRefRefusal(ref, account, scope);
      if (refusal)
        throw new ComputeError(
          'ACCESS_DENIED',
          `Provider account ${account.id} may not use this secret: ${refusal}`,
          undefined,
          { reason: 'secretRefScope' },
        );
      return platform ? secrets.resolve(ref) : secrets.resolve(ref, { tenantId: account.tenantId });
    },
  };
}

export interface CreateAccountInput {
  tenantId: string;
  provider: string;
  name: string;
  config: unknown;
  /**
   * Makes the account id deterministic (`draftId('pacct', tenant, caller, key)`): a retry returns
   * the account, a different request under the key is `CONFLICT` (FleetConfig computes ids up front).
   */
  idempotencyKey?: string;
  /** (D11) Pass-through rules; root (platform) accounts only. */
  billing?: AccountBilling;
}

/** The most pass-through rules one account holds. */
export const passThroughLimit = 50;
const meterKeyPattern = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * The shape of `billing` (D11). The platform-only rule and the SKU check are `assertPassThrough`, the meter
 * check `passThroughMeterCheck`.
 */
export function parseAccountBilling(raw: unknown): AccountBilling {
  const input = object(raw, ['passThrough']);
  if (input.passThrough === undefined) return {};
  if (!Array.isArray(input.passThrough) || input.passThrough.length > passThroughLimit)
    throw new ComputeError(
      'INVALID_INPUT',
      `billing.passThrough must list at most ${passThroughLimit} rules`,
    );
  return {
    passThrough: input.passThrough.map((entry: unknown, index: number) => {
      const rule = object(entry, ['skuPattern', 'meter', 'multiplier']);
      const at = `billing.passThrough[${index}]`;
      if (
        typeof rule.skuPattern !== 'string' ||
        rule.skuPattern.trim().length < 2 ||
        rule.skuPattern.length > 128
      )
        throw new ComputeError('INVALID_INPUT', `${at}.skuPattern must be 2 to 128 characters`);
      if (typeof rule.meter !== 'string' || !meterKeyPattern.test(rule.meter))
        throw new ComputeError('INVALID_INPUT', `${at}.meter must be a meter key`);
      if (
        typeof rule.multiplier !== 'number' ||
        !Number.isFinite(rule.multiplier) ||
        rule.multiplier < 1 ||
        rule.multiplier > 10
      )
        throw new ComputeError('INVALID_INPUT', `${at}.multiplier must be from 1 to 10`);
      return { skuPattern: rule.skuPattern, meter: rule.meter, multiplier: rule.multiplier };
    }),
  };
}

/**
 * Whether `pattern` would pass through a SKU compute meters itself (D11): the provider's matchers are asked
 * about a probe whose SKU id and description are the pattern and whose service is unknown.
 */
function meteredPattern(provider: ProviderDefinition, pattern: string): boolean {
  const probe = { service: '', sku: pattern, skuDescription: pattern };
  return (
    provider.billing?.computeSku?.(probe) === true || provider.billing?.meteredSku?.(probe) === true
  );
}

/**
 * The checks of `billing` that need no I/O: rules only on the platform's own accounts (a tenant's account is the
 * tenant's cost, never passed through), only for providers that say which SKUs compute meters, and never a pattern
 * that matches one of those SKU families (`INVALID_CONFIG`: billed twice).
 */
export function assertPassThrough(
  provider: ProviderDefinition,
  account: Pick<ProviderAccount, 'tenantId'>,
  billing: AccountBilling | undefined,
  rootTenantId: string | undefined,
): void {
  const rules = billing?.passThrough ?? [];
  if (rules.length === 0) return;
  if (rootTenantId === undefined || account.tenantId !== rootTenantId)
    throw new ComputeError(
      'INVALID_INPUT',
      "billing.passThrough is for the platform's own provider accounts only",
      undefined,
      { reason: 'notPlatformAccount' },
    );
  if (typeof provider.billing?.computeSku !== 'function')
    throw new ComputeError(
      'INVALID_CONFIG',
      `Provider ${provider.id} does not say which of its SKUs compute meters (billing.computeSku), so nothing ` +
        'can be passed through without risking billing it twice',
      undefined,
      { reason: 'computeSkuUnknown' },
    );
  rules.forEach((rule, index) => {
    if (meteredPattern(provider, rule.skuPattern))
      throw new ComputeError(
        'INVALID_CONFIG',
        `billing.passThrough[${index}].skuPattern ${JSON.stringify(rule.skuPattern)} matches SKUs compute ` +
          'already meters (compute, disks or addresses): they would be billed twice',
        undefined,
        { reason: 'meteredSku', index },
      );
  });
}

/**
 * Every rule's meter is a `reported` meter on the IAM root tenant (D11). Asks IAM, so it runs with no transaction
 * open (the admission check); without `listMeters` the rules cannot be checked and are refused.
 */
export async function passThroughMeterCheck(
  iam: { listMeters?: () => Promise<{ key: string; pricing: string; archived?: boolean }[]> },
  billing: AccountBilling | undefined,
): Promise<void> {
  const rules = billing?.passThrough ?? [];
  if (rules.length === 0) return;
  if (typeof iam.listMeters !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      'The IAM port has no listMeters, so pass-through meters cannot be checked. Configure it with ' +
        'bridge.embedded(iam, { rootTenantId, serviceCredential }) (remote: bridge.remote with a serviceToken).',
      undefined,
      { reason: 'billing-port-missing', member: 'listMeters' },
    );
  const meters = new Map((await iam.listMeters()).map((meter) => [meter.key, meter]));
  rules.forEach((rule, index) => {
    const meter = meters.get(rule.meter);
    if (!meter || meter.pricing !== 'reported' || meter.archived === true)
      throw new ComputeError(
        'INVALID_INPUT',
        `billing.passThrough[${index}].meter ${rule.meter} is not a reported meter on the root tenant: ` +
          "create it with ensureMeters and pricing: 'reported'",
        undefined,
        { reason: 'meterNotReported', index },
      );
  });
}

export function parseCreateAccount(raw: unknown): CreateAccountInput {
  const input = object(raw, [
    'tenantId',
    'provider',
    'name',
    'config',
    'idempotencyKey',
    'billing',
  ]);
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._~:/+=-]{1,128}$/.test(input.idempotencyKey))
  )
    throw new ComputeError('INVALID_INPUT', 'idempotencyKey is invalid');
  const provider = providerId(input.provider);
  return {
    tenantId: tenant(input.tenantId),
    provider,
    name: name(input.name),
    config: input.config ?? {},
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey as string }
      : {}),
    ...(input.billing !== undefined ? { billing: parseAccountBilling(input.billing) } : {}),
  };
}

function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    throw new ComputeError('INVALID_INPUT', 'provider must be a provider id');
  return value;
}

export interface FederationSetupInput {
  tenantId: string;
  provider: string;
  name: string;
}

/** What `providerAccounts.federationSetup` returns: what a tenant sets up at its cloud (GCP WIF). */
export interface FederationSetup {
  /** The control plane's workload issuer, the OIDC provider the cloud is told to trust. */
  issuer: string;
  jwksUri: string;
  /** The one subject `create` gives the account, as `accountSubject` builds it. */
  subject: string;
  /** The CEL condition that makes the cloud trust that subject alone: `assertion.sub == "<subject>"`. */
  attributeCondition: string;
  /** The shape of the `federationAudience` the tenant passes to `create`, with placeholders. */
  allowedAudienceHint: string;
}

/** `providerAccounts.federationSetup`'s input: the tenant and the provider and name `create` will get. */
export function parseFederationSetup(raw: unknown): FederationSetupInput {
  const input = object(raw, ['tenantId', 'provider', 'name']);
  return {
    tenantId: tenant(input.tenantId),
    provider: providerId(input.provider),
    name: name(input.name),
  };
}

/** Whether a stored account was created by this request (config may change through `update`). */
export function sameAccountRequest(account: ProviderAccount, input: CreateAccountInput): boolean {
  return account.provider === input.provider && account.name === input.name;
}

const keyReused = () =>
  new ComputeError('CONFLICT', 'This idempotency key was used for a different request');

export function providerOf(
  providers: ReadonlyMap<string, ProviderDefinition>,
  id: string,
): ProviderDefinition {
  const provider = providers.get(id);
  if (!provider)
    throw new ComputeError('INVALID_INPUT', `Unknown provider ${id}`, undefined, {
      known: [...providers.keys()],
    });
  return provider;
}

export async function createAccount(
  tx: SqlTx,
  providers: ReadonlyMap<string, ProviderDefinition>,
  input: CreateAccountInput,
  /** The derived id of a keyed request; a fresh id otherwise. */
  accountId: string = newId('pacct'),
  /** When given, the provider builds a client for the account first, so it refuses a bad one now. */
  check?: ClientDeps,
): Promise<ProviderAccount> {
  if (input.idempotencyKey !== undefined) {
    const existing = await readAccount(tx, accountId, input.tenantId);
    if (existing) {
      if (!sameAccountRequest(existing, input)) throw keyReused();
      return existing;
    }
  }
  const provider = providerOf(providers, input.provider);
  const config = await validateConfig(provider, input.config);
  assertNoInlineSecrets(config);
  assertAccountSecretRefs(config, input, check ?? {});
  assertPassThrough(provider, input, input.billing, check?.rootTenantId);
  if (check)
    await checkClient(
      provider,
      config,
      { id: accountId, tenantId: input.tenantId, name: input.name },
      check,
    );
  const exclusiveKey = exclusiveKeyOf(provider, config);
  // Untargeted: a conflict on any unique index (the id, (tenant_id, name), the exclusive key)
  // inserts nothing rather than raising, and is told apart below. A conflict target would make the
  // other indexes hard errors, so two overlapping creates with one key would fail as a CONFLICT
  // instead of replaying.
  const { rowCount } = await tx.query(
    `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version, exclusive_key, billing)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6, $7::jsonb) ON CONFLICT DO NOTHING`,
    [
      accountId,
      input.tenantId,
      provider.id,
      input.name,
      JSON.stringify(config),
      exclusiveKey,
      JSON.stringify(input.billing ?? {}),
    ],
  );
  if (rowCount === 0) {
    // The row that won committed first; under READ COMMITTED each statement below sees it.
    const winner = await readAccount(tx, accountId, input.tenantId);
    if (winner) {
      // A concurrent request with the same key: a replay when it was this request.
      if (sameAccountRequest(winner, input)) return winner;
      throw keyReused();
    }
    if (exclusiveKey !== null) {
      const holder = await tx.query(
        `SELECT 1 FROM provider_accounts WHERE provider = $1 AND exclusive_key = $2`,
        [provider.id, exclusiveKey],
      );
      if (holder.rows.length > 0) throw identityTaken(provider);
    }
    throw new ComputeError('CONFLICT', `Provider account ${input.name} already exists`);
  }
  return (await readAccount(tx, accountId))!;
}

export async function updateAccount(
  tx: SqlTx,
  providers: ReadonlyMap<string, ProviderDefinition>,
  /** `billing` absent keeps the stored rules; `{}` or `{ passThrough: [] }` clears them. */
  input: { tenantId: string; accountId: string; config: unknown; billing?: AccountBilling },
  /** When given, the provider builds a client for the new config first (see `createAccount`). */
  check?: ClientDeps,
): Promise<ProviderAccount> {
  const account = await readAccount(tx, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  const provider = providerOf(providers, account.provider);
  const config = await validateConfig(provider, input.config);
  assertNoInlineSecrets(config);
  assertAccountSecretRefs(config, account, check ?? {});
  assertPassThrough(provider, account, input.billing, check?.rootTenantId);
  if (check) await checkClient(provider, config, account, check);
  try {
    await tx.query(
      `UPDATE provider_accounts SET config = $2::jsonb, version = version + 1, exclusive_key = $3,
              billing = COALESCE($4::jsonb, billing)
        WHERE id = $1`,
      [
        account.id,
        JSON.stringify(config),
        exclusiveKeyOf(provider, config),
        input.billing === undefined ? null : JSON.stringify(input.billing),
      ],
    );
  } catch (error) {
    if (exclusiveKeyTaken(error)) throw identityTaken(provider);
    throw error;
  }
  return (await readAccount(tx, account.id))!;
}

/** `vps/0027_account_exclusive_key`: the unique index over (provider, exclusive_key). */
const exclusiveKeyIndex = 'provider_accounts_exclusive_key';

/** The SQLSTATE of a database error, from `pg` and PGlite alike (as postgres' `sqlState`). */
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A unique violation of the exclusive key index: another account of the provider holds the key. */
function exclusiveKeyTaken(error: unknown): boolean {
  return (
    sqlState(error) === '23505' &&
    (error as { constraint?: unknown }).constraint === exclusiveKeyIndex
  );
}

/**
 * The refusal of a key another account holds. It names neither that account nor its tenant, which
 * may be another tenant's: only that the identity is taken.
 */
const identityTaken = (provider: ProviderDefinition) =>
  new ComputeError(
    'CONFLICT',
    `Another provider account already uses this ${provider.id} identity`,
  );

/** `provider.accountKey(config)`, stored as `exclusive_key` (NULL: no key, no uniqueness). */
function exclusiveKeyOf(provider: ProviderDefinition, config: Record<string, Json>): string | null {
  const key: unknown = provider.accountKey?.(config);
  if (key === undefined) return null;
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024)
    throw new ComputeError(
      'INVALID_CONFIG',
      `Provider ${provider.id}: accountKey must return a string of 1 to 1024 characters, or undefined`,
    );
  return key;
}

/**
 * Deletes an account that no live pool, no live instance and no network that is not deleted uses.
 * Archived pools do not pin it, deleted instances keep their history but drop the reference, and
 * deleted networks (with their subnets and rules, all gone at the provider) are removed with it.
 */
export async function deleteAccount(
  tx: SqlTx,
  input: { tenantId: string; accountId: string },
): Promise<void> {
  const account = await readAccount(tx, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  const pools = await tx.query(
    `SELECT id FROM pools WHERE provider_account_id = $1 AND archived_at IS NULL LIMIT 1`,
    [account.id],
  );
  const live = await tx.query(
    `SELECT id FROM instances WHERE provider_account_id = $1 AND state <> 'deleted' LIMIT 1`,
    [account.id],
  );
  if (pools.rows.length > 0 || live.rows.length > 0)
    throw new ComputeError('INVALID_STATE', `Provider account ${account.name} is in use`);
  // Reservation grants (F10-4): live ones are commitments still billed; ended ones go with the account.
  const grants = await tx.query<{ id: string }>(
    `SELECT id FROM reservation_grants WHERE account_id = $1 AND state IN ('scheduled', 'active')
      ORDER BY id LIMIT 50`,
    [account.id],
  );
  if (grants.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${account.name} has live reservation grants: end them first`,
      undefined,
      { grantIds: grants.rows.map((row) => row.id) },
    );
  // An ended grant whose committed slot-hours are not all written would lose them with the account (F10-7).
  const unmetered = await tx.query<{ id: string }>(
    `SELECT id FROM reservation_grants WHERE account_id = $1 AND state = 'ended' AND metered_until < ends_at
      ORDER BY id LIMIT 50`,
    [account.id],
  );
  if (unmetered.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${account.name} has ended reservation grants whose slot-hours are not metered yet: retry after the vps.grants reconciler meters them (within an hour of their end)`,
      undefined,
      { grantIds: unmetered.rows.map((row) => row.id) },
    );
  const networks = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM networks WHERE provider_account_id = $1 AND state <> 'deleted'
      ORDER BY name LIMIT 50`,
    [account.id],
  );
  if (networks.rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Provider account ${account.name} is in use by networks ${networks.rows
        .map((row) => row.name)
        .join(', ')}: delete them first`,
      undefined,
      { networkIds: networks.rows.map((row) => row.id) },
    );
  await tx.query(`UPDATE instances SET provider_account_id = NULL WHERE provider_account_id = $1`, [
    account.id,
  ]);
  // Deleted networks: history that would pin the account (networks.provider_account_id).
  const deleted = `SELECT id FROM networks WHERE provider_account_id = $1`;
  await tx.query(
    `UPDATE instances SET network_id = NULL, subnet_id = NULL WHERE network_id IN (${deleted})`,
    [account.id],
  );
  await tx.query(`DELETE FROM network_firewall_rules WHERE network_id IN (${deleted})`, [
    account.id,
  ]);
  await tx.query(`DELETE FROM network_subnets WHERE network_id IN (${deleted})`, [account.id]);
  await tx.query(`DELETE FROM networks WHERE provider_account_id = $1`, [account.id]);
  await tx.query(`DELETE FROM provider_accounts WHERE id = $1`, [account.id]);
}

export interface ClientDeps {
  clock: Clock;
  secrets: SecretResolver;
  log: Logger;
  /** The IAM root tenant (`iam.rootTenantId`): its accounts are the platform's (`ProviderContext.account`). */
  rootTenantId?: string;
  /** `vps({ tenantVaultPaths })`, for the ref check of an account about to be stored. */
  tenantVaultPaths?: TenantVaultPaths;
  /** The host's workload issuer (`context.pki.workload`): with it, accounts get `ProviderContext.identity`. */
  workload?: WorkloadIssuerPort;
}

/**
 * What a provider is told about the account it builds a client for: a root-tenant account is the
 * platform's, and may use the host's ambient credentials (ruling F1). Without a known root tenant
 * no account is the platform's.
 */
export function accountContext(
  account: Pick<ProviderAccount, 'id' | 'tenantId'>,
  rootTenantId: string | undefined,
): NonNullable<ProviderContext['account']> {
  return {
    id: account.id,
    tenantId: account.tenantId,
    platform: rootTenantId !== undefined && account.tenantId === rootTenantId,
  };
}

/**
 * The workload-identity subject of a provider account (GCP WS1), the one place it is built: a
 * tenant's workload identity provider trusts exactly this subject, so vps alone derives it from the
 * account row and no provider ever chooses one.
 */
export function accountSubject(tenantId: string, provider: string, name: string): string {
  return `compute-account:${tenantId}/${provider}/${name}`;
}

const lowerAlnum = 'abcdefghijklmnopqrstuvwxyz0123456789';
const upperAlnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const mixedAlnum = `${lowerAlnum}ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
/** The fewest random characters in a probe's name or tenant (36^8, about 2.8e12 values). */
const probeRandomMin = 8;
/**
 * The lifetime of every token an account mints unless its provider asks for another (the issuer's
 * default), probes included: a probe token then cannot be told from a real one by `exp - iat`.
 */
const accountTokenTtlSeconds = 300;

/** `length` characters of `alphabet`, drawn with the CSPRNG (`randomInt` is unbiased). */
function randomText(alphabet: string, length: number): string {
  let out = '';
  for (let index = 0; index < length; index++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/**
 * A random account name shaped like account names (`[a-z0-9]`, as long as `name`, at least 8 and
 * at most 63 characters), never `name` itself and never derived from it.
 */
function probeName(name: string): string {
  const length = Math.min(63, Math.max(probeRandomMin, name.length));
  for (;;) {
    const candidate = randomText(lowerAlnum, length);
    if (candidate !== name) return candidate;
  }
}

/**
 * A random tenant id shaped like `tenantId`: its prefix style kept (the leading letters and their
 * separator, as `tenant-`, `ten_` or `org:`) and a random body from the character classes the
 * real body uses, as long (at least 8 characters), never `tenantId` itself. A provider whose
 * attribute condition admits a prefix of tenants (`compute-account:tenant-…`) is caught by it.
 */
function probeTenant(tenantId: string): string {
  const match = /^([A-Za-z]{1,32}[-_:])(.+)$/.exec(tenantId);
  const prefix = match?.[1] ?? '';
  const body = match?.[2] ?? tenantId;
  const lower = /[a-z]/.test(body);
  const upper = /[A-Z]/.test(body);
  const alphabet = lower && upper ? mixedAlnum : upper ? upperAlnum : lowerAlnum;
  const length = Math.min(128 - prefix.length, Math.max(probeRandomMin, body.length));
  for (;;) {
    const candidate = prefix + randomText(alphabet, length);
    if (candidate !== tenantId) return candidate;
  }
}

/**
 * An account's workload identity (`ProviderContext.identity`): `mint` mints only the account's own
 * subject (`accountSubject`), whatever else its input carries, and `mintProbe` only the two probe
 * subjects, random every time. Tokens are never logged.
 */
export function accountIdentity(
  workload: WorkloadIssuerPort,
  account: Pick<ProviderAccount, 'tenantId' | 'provider' | 'name'>,
): NonNullable<ProviderContext['identity']> {
  const subject = accountSubject(account.tenantId, account.provider, account.name);
  return Object.freeze({
    subject,
    async mint(input: { audience: string; ttlSeconds?: number }) {
      // Only the audience and the lifetime are the provider's to choose.
      const { audience, ttlSeconds } = input ?? ({} as Partial<typeof input>);
      return workload.mint({
        subject,
        audience: audience as string,
        ttlSeconds: ttlSeconds ?? accountTokenTtlSeconds,
      });
    },
    async mintProbe(kind: 'sibling' | 'stranger', input: { audience: string }) {
      let probe: string;
      if (kind === 'sibling')
        probe = accountSubject(account.tenantId, account.provider, probeName(account.name));
      else if (kind === 'stranger')
        probe = accountSubject(probeTenant(account.tenantId), account.provider, account.name);
      else throw new ComputeError('INVALID_INPUT', "mintProbe takes 'sibling' or 'stranger'");
      const { token } = await workload.mint({
        subject: probe,
        audience: input?.audience as string,
        ttlSeconds: accountTokenTtlSeconds,
      });
      return { token, subject: probe };
    },
  });
}

/**
 * The context a provider builds a client (or checks an account) with: secrets scoped to what the
 * account may name, whatever its config says, and, when the host has an issuer, its identity.
 */
function providerContext(
  provider: ProviderDefinition,
  account: Pick<ProviderAccount, 'id' | 'tenantId' | 'name'>,
  deps: ClientDeps,
  scope: AccountSecretScope,
): ProviderContext {
  return {
    clock: deps.clock,
    secrets: accountSecrets(deps.secrets, account, scope),
    log: deps.log,
    account: accountContext(account, deps.rootTenantId),
    ...(deps.workload
      ? {
          identity: accountIdentity(deps.workload, {
            tenantId: account.tenantId,
            provider: provider.id,
            name: account.name,
          }),
        }
      : {}),
  };
}

/**
 * Builds (and drops) a client for an account about to be stored, so what the provider refuses when
 * it builds one (`INVALID_CONFIG`: a tenant account relying on the platform's credentials) is
 * refused up front rather than on first use. Building a client makes no provider call.
 */
async function checkClient(
  provider: ProviderDefinition,
  config: Record<string, Json>,
  account: Pick<ProviderAccount, 'id' | 'tenantId' | 'name'>,
  deps: ClientDeps,
): Promise<void> {
  try {
    await provider.create(config, providerContext(provider, account, deps, deps));
  } catch (error) {
    // Only a refusal of the config itself refuses the account; anything else is met on first use.
    if (isComputeError(error, 'INVALID_CONFIG')) throw error;
  }
}

/**
 * The provider's network checks of an account about to be stored (`ProviderInput.checkAccount`),
 * which the admission of `providerAccounts.create/update` runs with no transaction open, so no lock
 * is held while the provider waits on the network. The config is validated and its refs checked
 * first, as `createAccount` does, so the provider only sees a config the account may store. Errors
 * propagate with their code: `INVALID_CONFIG` refuses; after `UNAVAILABLE` nothing is stored, so a
 * retry with the same key decides again.
 */
export async function checkAccountConfig(
  providers: ReadonlyMap<string, ProviderDefinition>,
  input: { provider: string; config: unknown },
  /** The account as it will be stored (its id is the one `createAccount` will write). */
  account: Pick<ProviderAccount, 'id' | 'tenantId' | 'name'>,
  deps: ClientDeps,
  signal: AbortSignal,
): Promise<void> {
  const provider = providerOf(providers, input.provider);
  const config = await validateConfig(provider, input.config);
  assertNoInlineSecrets(config);
  assertAccountSecretRefs(config, account, deps);
  exclusiveKeyOf(provider, config);
  if (!provider.checkAccount) return;
  await provider.checkAccount(config, {
    ...providerContext(provider, account, deps, deps),
    signal,
  });
}

/** Builds provider clients from accounts, cached per (account id, version). */
export class ProviderClients {
  readonly #providers: ReadonlyMap<string, ProviderDefinition>;
  readonly #cache = new Map<string, Promise<ProviderImpl>>();
  readonly #tenantVaultPaths: TenantVaultPaths | undefined;

  constructor(
    providers: ReadonlyMap<string, ProviderDefinition>,
    /** `vps({ tenantVaultPaths })`: which `vault://` refs tenants' accounts resolve. */
    tenantVaultPaths?: TenantVaultPaths,
  ) {
    this.#providers = providers;
    this.#tenantVaultPaths = tenantVaultPaths;
  }

  /**
   * Drops every cached client of the account, whatever its version. A deleted account must not
   * leave one behind: a same-tenant re-create with the same idempotency key gets the same id and
   * version 1 again, and would otherwise reuse the old client (its config and cached tokens).
   */
  evict(accountId: string): void {
    for (const key of this.#cache.keys())
      if (key.startsWith(`${accountId}@`)) this.#cache.delete(key);
  }

  client(account: ProviderAccount, deps: ClientDeps): Promise<ProviderImpl> {
    const cacheKey = `${account.id}@${account.version}`;
    let client = this.#cache.get(cacheKey);
    if (!client) {
      const provider = providerOf(this.#providers, account.provider);
      client = validateConfig(provider, account.config).then((config) =>
        provider.create(
          config,
          // Scoped to what the account may name, whatever its stored config says.
          providerContext(provider, account, deps, {
            ...(deps.rootTenantId !== undefined ? { rootTenantId: deps.rootTenantId } : {}),
            ...(this.#tenantVaultPaths ? { tenantVaultPaths: this.#tenantVaultPaths } : {}),
          }),
        ),
      );
      client.catch(() => this.#cache.delete(cacheKey));
      this.evict(account.id);
      this.#cache.set(cacheKey, client);
    }
    return client;
  }
}
