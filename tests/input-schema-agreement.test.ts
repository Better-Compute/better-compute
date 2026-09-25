import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, describedBy, isComputeError, strictObject } from '@better-compute/core';
import { eventsModule } from '@better-compute/events';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// Every module's method inputs describe themselves as JSON Schema (`validate.jsonSchema`, core's
// `describedBy` or a `manifest`), for the generated API reference. The description and the validator
// must agree: `{}` is refused for exactly the required fields, unknown fields are refused, enums and
// string types hold. Groups listed in `fullyDescribed` must describe every method.

afterEach(closeFixtures);

interface ObjectSchema {
  type: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: boolean;
}

const issuesOf = (run: () => unknown): { message: string; path: string[] }[] => {
  try {
    run();
    return [];
  } catch (error) {
    if (!isComputeError(error, 'INVALID_INPUT')) throw error;
    return (error.details?.issues as { message: string; path: string[] }[] | undefined) ?? [];
  }
};

const fullyDescribed = ['webhooks'];

async function everyModule() {
  const { compute } = await computeFixture({
    modules: [eventsModule({ secret: 'input-schema-agreement-secret-0123456789' })],
  });
  return compute.registry.methods.filter((method) => !method.plugin);
}

describe('describedBy', () => {
  const validate = describedBy(
    strictObject(
      { name: { type: 'string' }, size: { type: 'integer' }, mode: { enum: ['a', 'b'] } },
      ['name'],
    ),
    (raw) => {
      const input = raw as { name: string };
      if (input.name.length > 3) throw new ComputeError('INVALID_INPUT', 'name: too long');
      return input;
    },
  );

  it('reports every structural issue at once, then runs the validator', () => {
    expect(issuesOf(() => validate({ size: 1.5, mode: 'c', extra: true }))).toEqual([
      { message: 'Unknown field extra', path: ['extra'] },
      { message: 'Required', path: ['name'] },
      { message: 'Expected an integer', path: ['size'] },
      { message: 'Must be one of a, b', path: ['mode'] },
    ]);
    expect(() => validate({ name: 'long' })).toThrow('name: too long');
    expect(validate({ name: 'ok', mode: 'a' })).toEqual({ name: 'ok', mode: 'a' });
    expect(validate.jsonSchema).toMatchObject({ type: 'object', required: ['name'], additionalProperties: false });
  });
});

describe('validate.jsonSchema across modules', () => {
  it('agrees with the validator on required, unknown, enum and string fields', async () => {
    const methods = await everyModule();
    const described = methods.filter(
      (method) => (method.definition.validate as { jsonSchema?: unknown }).jsonSchema !== undefined,
    );
    for (const method of described) {
      const validate = method.definition.validate;
      const schema = (validate as unknown as { jsonSchema: ObjectSchema }).jsonSchema;
      expect(schema, method.path).toMatchObject({ type: 'object', additionalProperties: false });
      const required = issuesOf(() => validate({}))
        .filter((issue) => issue.message === 'Required' && issue.path.length === 1)
        .map((issue) => issue.path[0]!);
      expect(required.sort(), method.path).toEqual([...schema.required].sort());
      for (const key of schema.required) expect(schema.properties, `${method.path} ${key}`).toHaveProperty(key);
      expect(
        issuesOf(() => validate({ zz_unknown: 1 })).some((issue) => issue.message === 'Unknown field zz_unknown'),
        method.path,
      ).toBe(true);
      for (const [key, property] of Object.entries(schema.properties)) {
        if (Array.isArray(property.enum))
          expect(
            issuesOf(() => validate({ [key]: '__not_an_option__' })).some((issue) => issue.path.join('.') === key),
            `${method.path} ${key}`,
          ).toBe(true);
        if (property.type === 'string')
          expect(
            issuesOf(() => validate({ [key]: 42 })).some((issue) => issue.path.join('.') === key),
            `${method.path} ${key}`,
          ).toBe(true);
      }
      expect(() => JSON.stringify(schema), method.path).not.toThrow();
    }
  });

  it('describes every method of the fully described groups', async () => {
    const methods = await everyModule();
    const missing = methods
      .filter((method) => fullyDescribed.includes(method.group))
      .filter((method) => (method.definition.validate as { jsonSchema?: unknown }).jsonSchema === undefined)
      .map((method) => method.path);
    expect(missing).toEqual([]);
  });
});
