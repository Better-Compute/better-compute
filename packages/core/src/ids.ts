import { ComputeError } from './errors.js';

/**
 * Id prefixes of compute's own records. Ids read `<prefix>_<body>`; generated bodies are 26-character
 * ULIDs in lower-case Crockford base32, so ids of one prefix sort by creation time.
 */
export const idPrefixes = {
  site: 'site',
  pool: 'pool',
  node: 'node',
  project: 'prj',
  reservation: 'rsv',
  allocation: 'alloc',
  instance: 'inst',
  command: 'cmd',
  workflow: 'wf',
  step: 'step',
  image: 'img',
  profile: 'prof',
  joinToken: 'jt',
  joinRequest: 'jreq',
  providerAccount: 'pacct',
  flavor: 'flv',
  gateway: 'gw',
  worker: 'wkr',
  webhook: 'whk',
  secret: 'sec',
  event: 'evt',
  audit: 'aud',
  operation: 'op',
  request: 'req',
} as const;
export type IdKind = keyof typeof idPrefixes;
export type IdPrefix = (typeof idPrefixes)[IdKind];

/** Crockford base32, lower case: no i, l, o or u, and lexical order equals numeric order. */
const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
const prefixPattern = /^[a-z][a-z0-9]{0,15}$/;
const ulidPattern = /^[0-9a-hjkmnp-tv-z]{26}$/;
const idPattern = /^([a-z][a-z0-9]{0,15})_([0-9a-hjkmnp-tv-z]{26,52})$/;
const maxTime = 2 ** 48 - 1;

/** Encodes bytes as unpadded lower-case Crockford base32 (big-endian bit order). */
export function base32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function checkPrefix(prefix: string): void {
  if (!prefixPattern.test(prefix))
    throw new ComputeError('INVALID_INPUT', `Invalid id prefix ${JSON.stringify(prefix)}`);
}

export interface IdGeneratorOptions {
  /** Milliseconds since the epoch (default `Date.now`); pass a sim clock for reproducible ids. */
  now?: () => number;
  /** Fills a buffer with random bytes (default `crypto.getRandomValues`); pass a seeded source in the sim. */
  random?: (bytes: Uint8Array) => void;
}

/** Makes ids like `rsv_<ulid>`. */
export type IdGenerator = <P extends string>(prefix: P) => `${P}_${string}`;

/**
 * Creates an id generator. Within one millisecond the random part is incremented, so ids from one
 * generator are strictly increasing (monotonic ULIDs) even when minted faster than the clock ticks.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? (() => Date.now());
  const random =
    options.random ?? ((bytes: Uint8Array) => void globalThis.crypto.getRandomValues(bytes));
  let lastTime = -1;
  const entropy = new Uint8Array(10);
  return <P extends string>(prefix: P): `${P}_${string}` => {
    checkPrefix(prefix);
    let time = Math.floor(now());
    if (!Number.isSafeInteger(time) || time < 0 || time > maxTime)
      throw new ComputeError('INVALID_INPUT', 'Id timestamps must fit in 48 bits');
    if (time <= lastTime) {
      time = lastTime;
      let index = entropy.length - 1;
      while (index >= 0 && entropy[index] === 255) entropy[index--] = 0;
      if (index < 0) {
        // 2^80 ids in one millisecond: borrow the next millisecond rather than repeat an id.
        time = lastTime + 1;
        random(entropy);
      } else entropy[index]! += 1;
    } else random(entropy);
    lastTime = time;
    let head = '';
    for (let rest = time, index = 0; index < 10; index++) {
      head = alphabet[rest % 32] + head;
      rest = Math.floor(rest / 32);
    }
    return `${prefix}_${head}${base32(entropy)}`;
  };
}

/** The process-wide generator: wall-clock time and WebCrypto randomness. */
export const newId: IdGenerator = createIdGenerator();

export interface ParsedId {
  prefix: string;
  body: string;
  /** Creation time for generated (ULID) ids; absent for derived ids such as drafts. */
  timestamp?: number;
}

/** Splits an id into prefix and body; undefined when it is not a compute id. */
export function parseId(id: string): ParsedId | undefined {
  const match = idPattern.exec(id);
  if (!match) return undefined;
  const prefix = match[1]!;
  const body = match[2]!;
  if (!ulidPattern.test(body)) return { prefix, body };
  let timestamp = 0;
  for (const char of body.slice(0, 10)) timestamp = timestamp * 32 + alphabet.indexOf(char);
  return timestamp > maxTime ? { prefix, body } : { prefix, body, timestamp };
}

/** Whether `value` is a compute id, optionally with the given prefix. */
export function isId(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string') return false;
  const parsed = parseId(value);
  return parsed !== undefined && (prefix === undefined || parsed.prefix === prefix);
}

/**
 * The deterministic id of a request-as-resource draft (PLAN.md §3.4 step 5):
 * `<prefix>_` + base32(sha256(tenant ‖ identity ‖ idempotency key)), 52 characters of body. The
 * inputs are JSON-encoded with a domain tag, so no two distinct triples (or prefixes) collide.
 */
export async function draftId<P extends string>(
  prefix: P,
  tenantId: string,
  identityId: string,
  idempotencyKey: string,
): Promise<`${P}_${string}`> {
  checkPrefix(prefix);
  for (const [name, value] of [
    ['tenantId', tenantId],
    ['identityId', identityId],
    ['idempotencyKey', idempotencyKey],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0)
      throw new ComputeError('INVALID_INPUT', `${name} is required for a draft id`);
  }
  const material = JSON.stringify([
    'better-compute/draft/v1',
    prefix,
    tenantId,
    identityId,
    idempotencyKey,
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  );
  return `${prefix}_${base32(new Uint8Array(digest))}`;
}
