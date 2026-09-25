import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// The server's input validators describe themselves as JSON Schema (`validate.jsonSchema`), for the
// generated API reference and tool schemas. Validation itself is unchanged; these checks keep the
// description and the validator in agreement on every registered method that has one.

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

describe('validate.jsonSchema', () => {
  it('describes most methods, and agrees with the validator on required and unknown fields', async () => {
    const { compute } = await computeFixture();
    const described = compute.registry.methods.filter(
      (method) => (method.definition.validate as { jsonSchema?: unknown }).jsonSchema !== undefined,
    );
    // The server's own groups (modules with their own validators document as before).
    expect(described.length).toBeGreaterThanOrEqual(25);
    for (const method of described) {
      const validate = method.definition.validate;
      const schema = (validate as unknown as { jsonSchema: ObjectSchema }).jsonSchema;
      expect(schema, method.path).toMatchObject({ type: 'object', additionalProperties: false });
      // `{}` is refused exactly for the required fields.
      const required = issuesOf(() => validate({}))
        .filter((issue) => issue.message === 'Required' && issue.path.length === 1)
        .map((issue) => issue.path[0]!);
      expect(required.sort(), method.path).toEqual([...schema.required].sort());
      for (const key of schema.required) expect(schema.properties, `${method.path} ${key}`).toHaveProperty(key);
      // additionalProperties: false.
      expect(
        issuesOf(() => validate({ zz_unknown: 1 })).some((issue) => issue.message === 'Unknown field zz_unknown'),
        method.path,
      ).toBe(true);
      // An enum refuses anything outside it; a string field refuses a number.
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
    }
  });

  it('describes string bounds and patterns, integer ranges and defaults', async () => {
    const { compute } = await computeFixture();
    const all = compute.registry.methods.map(
      (method) => (method.definition.validate as { jsonSchema?: ObjectSchema }).jsonSchema,
    );
    // Every schema node, nested ones included.
    const nodes: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (!Array.isArray(node)) nodes.push(node as Record<string, unknown>);
      for (const child of Object.values(node)) walk(child);
    };
    walk(all);
    expect(nodes.some((p) => p.type === 'string' && typeof p.maxLength === 'number' && typeof p.pattern === 'string')).toBe(true);
    expect(nodes.some((p) => p.type === 'integer' && typeof p.minimum === 'number' && typeof p.maximum === 'number')).toBe(true);
    // withDefault: optional in `required`, with its default.
    expect(nodes.some((p) => p.type === 'boolean' && p.default !== undefined)).toBe(true);
    // JSON all the way down: the reference writes it as generated/api.json.
    expect(() => JSON.stringify(all)).not.toThrow();
  });
});
