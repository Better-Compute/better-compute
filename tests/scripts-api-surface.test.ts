import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareSurfaces, frozenPath, narrowings, surfaceOf } from '../scripts/api-surface.mjs';

// The API surface freeze (PLAN.md §16 v1.0): scripts/api-surface.mjs against generated/api-surface.json.

const object = (properties: Record<string, unknown>, required: string[] = [], extra: unknown = false) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: extra,
});
const tenant = { type: 'string', maxLength: 128 };

describe('narrowings', () => {
  it('accepts additions: an optional field, a wider type, a new enum value, looser bounds, a new branch', () => {
    const before = object({ tenantId: tenant, mode: { enum: ['a', 'b'] }, count: { type: 'integer', maximum: 10 } }, ['tenantId']);
    const after = object(
      {
        tenantId: { type: 'string', maxLength: 256 },
        mode: { enum: ['a', 'b', 'c'] },
        count: { type: ['number', 'null'], maximum: 100 },
        note: { type: 'string' },
      },
      ['tenantId'],
    );
    expect(narrowings(before, after)).toEqual([]);
    expect(narrowings({ type: 'string' }, { anyOf: [{ type: 'string' }, { type: 'integer' }] })).toEqual([]);
    expect(narrowings(before, {})).toEqual([]);
    // Documenting a method that had no schema is not a break.
    expect(compareSurfaces(frozen({ input: null }), frozen({ input: before })).breaking).toEqual([]);
  });

  it('reports every way a schema can reject what it accepted', () => {
    const before = object(
      {
        tenantId: tenant,
        mode: { enum: ['a', 'b'] },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        name: { type: 'string' },
        gone: { type: 'boolean' },
      },
      ['tenantId'],
    );
    const after = object(
      {
        tenantId: { type: 'string', maxLength: 64 },
        mode: { enum: ['a'] },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 4 },
        name: { type: 'integer' },
      },
      ['tenantId', 'mode'],
    );
    expect(narrowings(before, after)).toEqual([
      'mode: now required',
      'tenantId: maxLength 128 → 64',
      'mode: no longer accepts "b"',
      'count: minimum 0 → 1',
      'tags: maxItems 8 → 4',
      'tags.[]: pattern null → "^[a-z]+$"',
      'name: no longer accepts string',
      'gone: no longer accepted',
    ]);
  });

  it('treats closing an open object, and constraining an unconstrained value, as breaks', () => {
    expect(narrowings(object({ a: tenant }, [], true), object({ a: tenant }))).toEqual(['(input): no longer accepts other properties']);
    expect(narrowings(object({}, [], { type: 'string' }), object({ extra: { type: 'integer' } }, [], { type: 'string' }))).toEqual([
      'extra: no longer accepts string',
    ]);
    expect(narrowings(object({ a: {} }), object({ a: { type: 'string' } }))).toEqual(['a: was unconstrained, now constrained']);
    expect(narrowings({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, { type: 'string' })).toEqual(['(input): no longer accepts integer']);
    expect(narrowings({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, { anyOf: [{ type: 'string' }, { type: 'boolean' }] })).toEqual([
      '(input): alternative 2 is no longer accepted',
    ]);
  });
});

function frozen(overrides: Record<string, unknown> = {}, errors: Record<string, number> = { NOT_FOUND: 404 }) {
  return {
    methods: {
      'pools.get': {
        route: 'POST /api/compute/pools/get',
        kind: 'read',
        action: 'compute:pools:read',
        resource: 'compute-pool',
        alternatives: [],
        list: false,
        status: 'registered',
        phase: 'v0.1',
        input: object({ tenantId: tenant }, ['tenantId']),
        ...overrides,
      },
    },
    errors,
  };
}

describe('compareSurfaces', () => {
  it('breaks on a removed, unserved, re-routed or re-authorized method and on a removed or re-mapped error', () => {
    const base = frozen();
    expect(compareSurfaces(base, { methods: {}, errors: base.errors }).breaking).toEqual(['pools.get: removed']);
    expect(compareSurfaces(base, frozen({ status: 'planned' })).breaking).toEqual(['pools.get: no longer served (now planned)']);
    expect(compareSurfaces(base, frozen({ action: 'compute:pools:list' })).breaking).toEqual([
      'pools.get: action "compute:pools:read" → "compute:pools:list"',
    ]);
    expect(compareSurfaces(frozen({ alternatives: ['compute:x @ compute-y'] }), frozen()).breaking).toEqual([
      'pools.get: IAM alternative compute:x @ compute-y removed',
    ]);
    expect(compareSurfaces(base, frozen({}, {})).breaking).toEqual(['error NOT_FOUND: removed']);
    expect(compareSurfaces(base, frozen({}, { NOT_FOUND: 410 })).breaking).toEqual(['error NOT_FOUND: HTTP 404 → 410']);
  });

  it('lets planned methods change or go, and reports additions without failing', () => {
    const planned = frozen({ status: 'planned', input: null });
    expect(compareSurfaces(planned, { methods: {}, errors: planned.errors })).toEqual({ breaking: [], added: ['pools.get: dropped while planned'] });
    const grown = frozen();
    (grown.methods as Record<string, unknown>)['pools.archive'] = { ...grown.methods['pools.get'], route: 'POST /api/compute/pools/archive' };
    grown.errors = { ...grown.errors, GONE: 410 };
    expect(compareSurfaces(frozen(), grown)).toEqual({ breaking: [], added: ['pools.archive: new', 'error GONE: new'] });
  });
});

describe('the committed surface', () => {
  it('matches the docs generator output, with no breaking change since it was frozen', () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
    const current = surfaceOf(read('apps/docs/generated/api.json'), read('apps/docs/generated/errors.json'));
    const { breaking } = compareSurfaces(read(frozenPath), current);
    expect(breaking).toEqual([]);
    expect(Object.keys(read(frozenPath).methods).length).toBeGreaterThan(100);
  });
});
