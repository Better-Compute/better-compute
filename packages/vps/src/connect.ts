import {
  ComputeError,
  type ProviderConnect,
  type ProviderDefinition,
} from '@better-compute/core';
import { providerOf, type CreateAccountInput } from './accounts.js';
import { name, object, tenant } from './input.js';

// OAuth-connected provider accounts (P9): `providerAccounts.connectSetup` answers the provider's authorization URL
// for a redirect URI and the caller's state, and `providerAccounts.connect` trades the code the redirect carried
// for a credential, seals it in the secret store and stores the account with the sealed ref in the provider's
// credential field. The anti-forgery state is the caller's to keep and compare (the console keeps it in the
// browser session): the API call itself is authenticated and decided like providerAccounts.create.

/** `providerAccounts.connectSetup`'s input. */
export interface ConnectSetupInput {
  tenantId: string;
  provider: string;
  redirectUri: string;
  state: string;
}

/** `providerAccounts.connect`'s input. */
export interface ConnectAccountInput {
  tenantId: string;
  provider: string;
  name: string;
  /** Single use: a retry needs the idempotency key (it replays) or a new code. */
  code: string;
  redirectUri: string;
  /** The rest of the account's config, without the credential field. */
  config: Record<string, unknown>;
  idempotencyKey?: string;
}

const statePattern = /^[A-Za-z0-9._~-]{16,256}$/;
const codePattern = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const keyPattern = /^[A-Za-z0-9._~:/+=-]{1,128}$/;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

const invalid = (message: string) => new ComputeError('INVALID_INPUT', message);

/** An absolute https URL (http only on a loopback host), without credentials or a fragment. */
function redirectUriOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw invalid('redirectUri must be a URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('redirectUri must be a URL');
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname));
  if (!secure || url.username || url.password || url.hash)
    throw invalid('redirectUri must be https, without credentials or a fragment');
  return value;
}

function providerIdOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    throw invalid('provider must be a provider id');
  return value;
}

export function parseConnectSetup(raw: unknown): ConnectSetupInput {
  const input = object(raw, ['tenantId', 'provider', 'redirectUri', 'state']);
  if (typeof input.state !== 'string' || !statePattern.test(input.state))
    throw invalid('state must be 16 to 256 characters of [A-Za-z0-9._~-]');
  return {
    tenantId: tenant(input.tenantId),
    provider: providerIdOf(input.provider),
    redirectUri: redirectUriOf(input.redirectUri),
    state: input.state,
  };
}

export function parseConnectAccount(raw: unknown): ConnectAccountInput {
  const input = object(raw, [
    'tenantId',
    'provider',
    'name',
    'code',
    'redirectUri',
    'config',
    'idempotencyKey',
  ]);
  if (typeof input.code !== 'string' || !codePattern.test(input.code))
    throw invalid('code is not an authorization code');
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' || !keyPattern.test(input.idempotencyKey))
  )
    throw invalid('idempotencyKey is invalid');
  const config = input.config ?? {};
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw invalid('config must be an object');
  return {
    tenantId: tenant(input.tenantId),
    provider: providerIdOf(input.provider),
    name: name(input.name),
    code: input.code,
    redirectUri: redirectUriOf(input.redirectUri),
    config: { ...(config as Record<string, unknown>) },
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey as string } : {}),
  };
}

/** The provider's connect flow; `UNSUPPORTED` when it has none (or none is configured). */
export function connectOf(
  providers: ReadonlyMap<string, ProviderDefinition>,
  id: string,
): ProviderConnect {
  const provider = providerOf(providers, id);
  if (!provider.connect)
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${id} has no connect flow configured`,
      undefined,
      { provider: id },
    );
  return provider.connect;
}

/** Refuses a config that already names the credential field: connect fills it in (before any exchange). */
export function assertConnectConfig(input: ConnectAccountInput, field: string): void {
  if (Object.hasOwn(input.config, field))
    throw invalid(`config must not name ${field}: connect fills it in`);
}

/** The create request a connect becomes once its credential is sealed (`config[field]` = the ref). */
export function connectedCreate(
  input: ConnectAccountInput,
  field: string,
  ref: string,
): CreateAccountInput {
  assertConnectConfig(input, field);
  return {
    tenantId: input.tenantId,
    provider: input.provider,
    name: input.name,
    config: { ...input.config, [field]: ref },
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}
