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
}

interface RawAccount {
  id: string;
  tenant_id: string;
  provider: string;
  name: string;
  config: Record<string, Json> | string;
  version: string | number;
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
  };
}

export async function readAccount(
  tx: SqlTx,
  accountId: string,
  tenantId?: string,
): Promise<ProviderAccount | undefined> {
  const { rows } = await tx.query<RawAccount>(
    `SELECT id, tenant_id, provider, name, config, version FROM provider_accounts
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
    `SELECT a.id, a.tenant_id, a.provider, a.name, a.config, a.version
       FROM provider_accounts a JOIN pools p ON p.id = $2 AND p.owner_tenant_id = a.tenant_id
      WHERE a.id = $1`,
    [accountId, poolId],
  );
  return rows[0] ? toAccount(rows[0]) : undefined;
}

export async function listAccounts(tx: SqlTx, tenantId: string): Promise<ProviderAccount[]> {
  const { rows } = await tx.query<RawAccount>(
    `SELECT id, tenant_id, provider, name, config, version FROM provider_accounts
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
}

export function parseCreateAccount(raw: unknown): CreateAccountInput {
  const input = object(raw, ['tenantId', 'provider', 'name', 'config', 'idempotencyKey']);
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._~:/+=-]{1,128}$/.test(input.idempotencyKey))
  )
    throw new ComputeError('INVALID_INPUT', 'idempotencyKey is invalid');
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.provider))
    throw new ComputeError('INVALID_INPUT', 'provider must be a provider id');
  return {
    tenantId: tenant(input.tenantId),
    provider: input.provider,
    name: name(input.name),
    config: input.config ?? {},
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey as string }
      : {}),
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
  if (check)
    await checkClient(provider, config, { id: accountId, tenantId: input.tenantId }, check);
  const { rowCount } = await tx.query(
    `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1) ON CONFLICT DO NOTHING`,
    [accountId, input.tenantId, provider.id, input.name, JSON.stringify(config)],
  );
  if (rowCount === 0 && input.idempotencyKey !== undefined) {
    // A concurrent request with the same key committed first.
    const winner = await readAccount(tx, accountId, input.tenantId);
    if (winner && sameAccountRequest(winner, input)) return winner;
  }
  if (rowCount === 0)
    throw new ComputeError('CONFLICT', `Provider account ${input.name} already exists`);
  return (await readAccount(tx, accountId))!;
}

export async function updateAccount(
  tx: SqlTx,
  providers: ReadonlyMap<string, ProviderDefinition>,
  input: { tenantId: string; accountId: string; config: unknown },
  /** When given, the provider builds a client for the new config first (see `createAccount`). */
  check?: ClientDeps,
): Promise<ProviderAccount> {
  const account = await readAccount(tx, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  const provider = providerOf(providers, account.provider);
  const config = await validateConfig(provider, input.config);
  assertNoInlineSecrets(config);
  if (check) await checkClient(provider, config, account, check);
  await tx.query(
    `UPDATE provider_accounts SET config = $2::jsonb, version = version + 1 WHERE id = $1`,
    [account.id, JSON.stringify(config)],
  );
  return (await readAccount(tx, account.id))!;
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
 * Builds (and drops) a client for an account about to be stored, so what the provider refuses when
 * it builds one (`INVALID_CONFIG`: a tenant account relying on the platform's credentials) is
 * refused up front rather than on first use. Building a client makes no provider call.
 */
async function checkClient(
  provider: ProviderDefinition,
  config: Record<string, Json>,
  account: Pick<ProviderAccount, 'id' | 'tenantId'>,
  deps: ClientDeps,
): Promise<void> {
  try {
    await provider.create(config, {
      clock: deps.clock,
      secrets: deps.secrets,
      log: deps.log,
      account: accountContext(account, deps.rootTenantId),
    });
  } catch (error) {
    // Only a refusal of the config itself refuses the account; anything else is met on first use.
    if (isComputeError(error, 'INVALID_CONFIG')) throw error;
  }
}

/** Builds provider clients from accounts, cached per (account id, version). */
export class ProviderClients {
  readonly #providers: ReadonlyMap<string, ProviderDefinition>;
  readonly #cache = new Map<string, Promise<ProviderImpl>>();

  constructor(providers: ReadonlyMap<string, ProviderDefinition>) {
    this.#providers = providers;
  }

  client(account: ProviderAccount, deps: ClientDeps): Promise<ProviderImpl> {
    const cacheKey = `${account.id}@${account.version}`;
    let client = this.#cache.get(cacheKey);
    if (!client) {
      const provider = providerOf(this.#providers, account.provider);
      client = validateConfig(provider, account.config).then((config) =>
        provider.create(config, {
          clock: deps.clock,
          secrets: deps.secrets,
          log: deps.log,
          account: accountContext(account, deps.rootTenantId),
        }),
      );
      client.catch(() => this.#cache.delete(cacheKey));
      for (const existing of this.#cache.keys())
        if (existing.startsWith(`${account.id}@`)) this.#cache.delete(existing);
      this.#cache.set(cacheKey, client);
    }
    return client;
  }
}
