import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  field,
  isComputeError,
  isSecretRef,
  manifest,
  maskedValue,
  validateManifest,
  type Manifest,
  type SecretRef,
  type StandardSchemaV1,
} from '@better-compute/core';

const networks = async () => ['net-a', { value: 'net-b', label: 'Backbone' }];

// The §5.3 example, verbatim apart from the suggestion source.
const hetznerCloudConfig = manifest({
  token: field.secret().describe('API token'),
  location: field.option(['fsn1', 'nbg1', 'hel1', 'ash', 'hil']).default('fsn1'),
  network: field
    .string()
    .optional()
    .suggest(async () => networks()),
  firewall: field
    .int()
    .optional()
    .disabledWhen({ location: ['ash', 'hil'] }),
  timeout: field.duration().default('10m'),
});
type HetznerCloudConfig = manifest.Infer<typeof hetznerCloudConfig>;

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isComputeError(error) ? error.code : 'not a ComputeError';
  }
  return undefined;
}

async function standard(value: unknown) {
  return hetznerCloudConfig['~standard'].validate(value);
}

describe('manifest: Standard Schema v1', () => {
  it('declares version 1 and vendor better-compute', () => {
    expect(hetznerCloudConfig['~standard'].version).toBe(1);
    expect(hetznerCloudConfig['~standard'].vendor).toBe('better-compute');
  });

  it('validates and applies defaults; durations become milliseconds', async () => {
    expect(await standard({ token: 'secret://tnt/hetzner' })).toEqual({
      value: { token: 'secret://tnt/hetzner', location: 'fsn1', timeout: 600_000 },
    });
    expect(
      await standard({
        token: 'vault://kv/hetzner',
        location: 'nbg1',
        network: 'n1',
        firewall: 7,
        timeout: '1h30m',
      }),
    ).toEqual({
      value: {
        token: 'vault://kv/hetzner',
        location: 'nbg1',
        network: 'n1',
        firewall: 7,
        timeout: 5_400_000,
      },
    });
    expect(await standard({ token: 'env://HCLOUD_TOKEN', timeout: 90_000 })).toMatchObject({
      value: { timeout: 90_000 },
    });
  });

  it('reports every issue with its path', async () => {
    const result = await standard({
      location: 'mars',
      network: 3,
      firewall: 1.5,
      timeout: '10 minutes',
      extra: true,
    });
    expect(result.issues).toBeDefined();
    const byPath = Object.fromEntries(
      (result.issues ?? []).map((entry) => [entry.path?.join('.'), entry.message]),
    );
    expect(Object.keys(byPath).sort()).toEqual([
      'extra',
      'firewall',
      'location',
      'network',
      'timeout',
      'token',
    ]);
    expect(byPath.token).toBe('Required');
    expect(byPath.extra).toBe('Unknown field extra');
    expect(byPath.location).toMatch(/one of fsn1, nbg1/);
    expect((await standard(null)).issues).toEqual([{ message: 'Expected an object' }]);
    expect((await standard([])).issues).toEqual([{ message: 'Expected an object' }]);
  });

  it('applies disabledWhen against the effective values', async () => {
    expect((await standard({ token: 'secret://t', location: 'ash', firewall: 1 })).issues).toEqual([
      { message: 'firewall is not available when location in (ash, hil)', path: ['firewall'] },
    ]);
    expect(await standard({ token: 'secret://t', location: 'hil' })).toMatchObject({
      value: { location: 'hil' },
    });
    expect(await standard({ token: 'secret://t', firewall: 2 })).toMatchObject({
      value: { firewall: 2 },
    });
    const withDefault = manifest({
      mode: field.option(['a', 'b']),
      level: field.int().default(3).disabledWhen({ mode: 'b' }),
    });
    expect(withDefault.parse({ mode: 'a' })).toEqual({ mode: 'a', level: 3 });
    expect(withDefault.parse({ mode: 'b' })).toEqual({ mode: 'b' });
  });

  it('parse() throws INVALID_INPUT with the issues attached', () => {
    let error: unknown;
    try {
      hetznerCloudConfig.parse({ token: 'plain-token' });
    } catch (caught) {
      error = caught;
    }
    expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
    expect((error as Error).message).toMatch(/^token: Expected a secret reference/);
    expect((error as { details: unknown }).details).toEqual({
      issues: [
        { message: 'Expected a secret reference (secret://, vault:// or env://)', path: ['token'] },
      ],
    });
  });
});

describe('manifest: secrets', () => {
  it('accepts only secret references', () => {
    for (const ref of ['secret://a', 'vault://kv/path#key', 'env://TOKEN'])
      expect(isSecretRef(ref)).toBe(true);
    for (const value of ['', 'secret://', 'secret:// x', 'https://x', 'hunter2', 42])
      expect(isSecretRef(value)).toBe(false);
  });

  it('masks secrets and masked fields', () => {
    expect(hetznerCloudConfig.fields.token.spec.masked).toBe(true);
    expect(hetznerCloudConfig.fields.network.spec.masked).toBe(false);
    const masked = manifest({ password: field.string().masked, user: field.string() });
    expect(masked.fields.password.spec.masked).toBe(true);
    expect(masked.redact({ password: 'p', user: 'u' })).toEqual({
      password: maskedValue,
      user: 'u',
    });
    expect(hetznerCloudConfig.redact({ token: 'secret://t', location: 'fsn1' })).toEqual({
      token: maskedValue,
      location: 'fsn1',
    });
    expect(hetznerCloudConfig.redact({ location: 'fsn1' })).toEqual({ location: 'fsn1' });
  });
});

describe('manifest: JSON Schema', () => {
  it('exports JSON Schema 2020-12 with x-bc hints', () => {
    expect(hetznerCloudConfig.jsonSchema()).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        token: {
          type: 'string',
          pattern: '^(secret|vault|env)://\\S+$',
          writeOnly: true,
          description: 'API token',
          'x-bc': { kind: 'secret', masked: true },
        },
        location: {
          type: 'string',
          enum: ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'],
          default: 'fsn1',
          'x-bc': { kind: 'option' },
        },
        network: { type: 'string', 'x-bc': { kind: 'string', suggest: true } },
        firewall: {
          type: 'integer',
          'x-bc': { kind: 'int', disabledWhen: { location: ['ash', 'hil'] } },
        },
        timeout: {
          type: ['string', 'integer'],
          pattern: '^(\\d+(\\.\\d+)?(ms|s|m|h|d))+$',
          minimum: 0,
          default: '10m',
          'x-bc': { kind: 'duration' },
        },
      },
      required: ['token'],
      additionalProperties: false,
    });
  });

  it('describes bounds, URLs, booleans, numbers and lists', () => {
    const schema = manifest({
      endpoint: field.url(),
      port: field.int({ min: 1, max: 65535 }).default(443),
      ratio: field.number({ min: 0 }),
      verify: field.boolean().default(true),
      name: field.string({ pattern: /^[a-z]+$/, maxLength: 8 }),
      tags: field.list(field.string(), { max: 4 }).optional(),
    }).jsonSchema();
    expect(schema.required).toEqual(['endpoint', 'ratio', 'name']);
    expect(schema.properties).toEqual({
      endpoint: { type: 'string', format: 'uri', 'x-bc': { kind: 'url' } },
      port: { type: 'integer', minimum: 1, maximum: 65535, default: 443, 'x-bc': { kind: 'int' } },
      ratio: { type: 'number', minimum: 0, 'x-bc': { kind: 'number' } },
      verify: { type: 'boolean', default: true, 'x-bc': { kind: 'boolean' } },
      name: { type: 'string', maxLength: 8, pattern: '^[a-z]+$', 'x-bc': { kind: 'string' } },
      tags: {
        type: 'array',
        items: { type: 'string', 'x-bc': { kind: 'string' } },
        maxItems: 4,
        'x-bc': { kind: 'list' },
      },
    });
  });
});

describe('manifest: fields', () => {
  it('validates every field kind', () => {
    const schema = manifest({
      endpoint: field.url(),
      port: field.int({ min: 1, max: 65535 }).default(443),
      ratio: field.number({ min: 0, max: 1 }).optional(),
      verify: field.boolean().default(true),
      name: field.string({ pattern: '^[a-z]+$', maxLength: 8 }).optional(),
      disks: field.list(field.int({ min: 1 }), { min: 1 }).optional(),
    });
    expect(schema.parse({ endpoint: 'https://api.example.com/v1' })).toEqual({
      endpoint: 'https://api.example.com/v1',
      port: 443,
      verify: true,
    });
    const issues = (value: Record<string, unknown>) => {
      const result = schema['~standard'].validate({
        endpoint: 'https://x.test',
        ...value,
      }) as StandardSchemaV1.Result<unknown>;
      return (result.issues ?? []).map((entry) => `${entry.path?.join('.')}: ${entry.message}`);
    };
    expect(issues({ endpoint: 'not a url' })).toEqual(['endpoint: Expected an absolute URL']);
    expect(issues({ port: 0 })).toEqual(['port: Must be at least 1']);
    expect(issues({ port: 70000 })).toEqual(['port: Must be at most 65535']);
    expect(issues({ port: 1.5 })).toEqual(['port: Expected an integer']);
    expect(issues({ ratio: Number.NaN })).toEqual(['ratio: Expected a number']);
    expect(issues({ verify: 'yes' })).toEqual(['verify: Expected true or false']);
    expect(issues({ name: 'Upper' })).toEqual(['name: Must match ^[a-z]+$']);
    expect(issues({ name: 'abcdefghij' })).toEqual(['name: Must be at most 8 characters']);
    expect(issues({ disks: [] })).toEqual(['disks: Must list at least 1 items']);
    expect(issues({ disks: [1, 0, 'x'] })).toEqual([
      'disks.1: Must be at least 1',
      'disks.2: Expected an integer',
    ]);
    expect(issues({ disks: 'sda' })).toEqual(['disks: Expected a list']);
  });

  it('treats an explicit undefined as absent', () => {
    expect(hetznerCloudConfig.parse({ token: 'secret://t', location: undefined })).toEqual({
      token: 'secret://t',
      location: 'fsn1',
      timeout: 600_000,
    });
  });

  it('returns fresh copies of defaults', () => {
    const schema = manifest({ zones: field.list(field.string()).default(['a']) });
    const first = schema.parse({});
    first.zones.push('b');
    expect(schema.parse({})).toEqual({ zones: ['a'] });
  });

  it('checks defaults and definitions eagerly with INVALID_CONFIG', () => {
    expect(codeOf(() => field.int().default('x' as never))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.option(['a', 'b']).default('c' as never))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.duration().default('soon'))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.option([] as never))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.option(['a', 'a']))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.int().disabledWhen({ x: 1 }).default(1))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.list(field.int().optional() as never))).toBe('INVALID_CONFIG');
    expect(codeOf(() => manifest({ a: field.int().disabledWhen({ b: 1 }) }))).toBe(
      'INVALID_CONFIG',
    );
    expect(codeOf(() => manifest({ a: field.int().disabledWhen({ a: 1 }) }))).toBe(
      'INVALID_CONFIG',
    );
    expect(
      codeOf(() =>
        manifest({
          a: field.int().disabledWhen({ b: 1 }),
          b: field.int().disabledWhen({ c: 1 }),
          c: field.int(),
        }),
      ),
    ).toBe('INVALID_CONFIG');
    expect(codeOf(() => manifest({ a: { spec: {} } as never }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => manifest({ 'bad key': field.int() }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => manifest(JSON.parse('{"__proto__": 1}')))).toBe('INVALID_CONFIG');
    expect(codeOf(() => manifest({ constructor: field.int() }))).toBe('INVALID_CONFIG');
    expect(codeOf(() => field.string({ pattern: '(' }))).toBe('INVALID_CONFIG');
  });

  it('keeps fields immutable', () => {
    const base = field.string();
    const described = base.describe('x');
    expect(base.spec.description).toBeUndefined();
    expect(described.spec.description).toBe('x');
    expect(Object.isFrozen(base)).toBe(true);
  });
});

describe('manifest: suggestions', () => {
  it('normalizes suggestions and knows which fields have them', async () => {
    expect(await hetznerCloudConfig.suggest('network', { values: {} })).toEqual([
      { value: 'net-a' },
      { value: 'net-b', label: 'Backbone' },
    ]);
    expect(await hetznerCloudConfig.suggest('location', { values: {} })).toEqual([]);
    await expect(hetznerCloudConfig.suggest('nope' as never, { values: {} })).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    );
  });
});

describe('validateManifest', () => {
  it('accepts any Standard Schema, sync or async', async () => {
    const foreign: Manifest<{ n: number }> = {
      '~standard': {
        version: 1,
        vendor: 'zod-like',
        validate: async (value) =>
          typeof (value as { n?: unknown })?.n === 'number'
            ? { value: { n: (value as { n: number }).n } }
            : { issues: [{ message: 'n must be a number', path: [{ key: 'n' }] }] },
      },
    };
    expect(await validateManifest(foreign, { n: 1 })).toEqual({ n: 1 });
    await expect(validateManifest(foreign, {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'n: n must be a number',
      details: { issues: [{ message: 'n must be a number', path: ['n'] }] },
    });
    expect(await validateManifest(hetznerCloudConfig, { token: 'env://T' })).toMatchObject({
      location: 'fsn1',
    });
  });
});

describe('manifest: types', () => {
  it('infers the validated and accepted types', () => {
    expectTypeOf<HetznerCloudConfig>().toEqualTypeOf<{
      token: SecretRef;
      location: 'fsn1' | 'nbg1' | 'hel1' | 'ash' | 'hil';
      timeout: number;
      network?: string;
      firewall?: number;
    }>();
    expectTypeOf<manifest.Input<typeof hetznerCloudConfig>>().toEqualTypeOf<{
      token: SecretRef;
      location?: 'fsn1' | 'nbg1' | 'hel1' | 'ash' | 'hil';
      timeout?: string | number;
      network?: string;
      firewall?: number;
    }>();
    expectTypeOf<
      StandardSchemaV1.InferOutput<typeof hetznerCloudConfig>
    >().toEqualTypeOf<HetznerCloudConfig>();
    expectTypeOf(hetznerCloudConfig.parse).returns.toEqualTypeOf<HetznerCloudConfig>();
    expectTypeOf(hetznerCloudConfig).toExtend<Manifest<HetznerCloudConfig>>();
    const lists = manifest({ ids: field.list(field.int()), mode: field.option(['a']).optional() });
    expectTypeOf<manifest.Infer<typeof lists>>().toEqualTypeOf<{ ids: number[]; mode?: 'a' }>();
  });
});
