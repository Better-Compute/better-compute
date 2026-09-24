import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  base32,
  createIdGenerator,
  draftId,
  idPrefixes,
  isComputeError,
  isId,
  manualClock,
  newId,
  parseId,
} from '@better-compute/core';

const ulidBody = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** A deterministic byte source for reproducible ids. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[index] = state >>> 24;
    }
  };
}

describe('base32', () => {
  it('encodes Crockford base32 in lower case', () => {
    expect(base32(new Uint8Array([]))).toBe('');
    expect(base32(new Uint8Array([0xff]))).toBe('zw');
    expect(base32(new Uint8Array(5))).toBe('00000000');
    expect(base32(new TextEncoder().encode('foobar'))).toBe('csqpyrk1e8');
  });
});

describe('id prefixes', () => {
  it('cover compute records with distinct, well-formed prefixes', () => {
    const values = Object.values(idPrefixes);
    expect(new Set(values).size).toBe(values.length);
    for (const prefix of values) expect(prefix).toMatch(/^[a-z][a-z0-9]{0,15}$/);
    for (const prefix of [
      'node',
      'pool',
      'site',
      'rsv',
      'alloc',
      'cmd',
      'wf',
      'img',
      'prof',
      'jt',
      'inst',
      'prj',
      'evt',
    ])
      expect(values).toContain(prefix);
  });
});

describe('newId', () => {
  it('makes prefixed ULIDs carrying their creation time', () => {
    const before = Date.now();
    const id = newId(idPrefixes.reservation);
    const after = Date.now();
    expect(id.startsWith('rsv_')).toBe(true);
    const parsed = parseId(id);
    expect(parsed?.prefix).toBe('rsv');
    expect(parsed?.body).toMatch(ulidBody);
    expect(parsed?.timestamp).toBeGreaterThanOrEqual(before);
    expect(parsed?.timestamp).toBeLessThanOrEqual(after);
    expect(isId(id)).toBe(true);
    expect(isId(id, 'rsv')).toBe(true);
    expect(isId(id, 'cmd')).toBe(false);
  });

  it('is strictly increasing within one millisecond and when the clock steps back', () => {
    const clock = manualClock(1_700_000_000_000);
    const next = createIdGenerator({ now: clock.now });
    const ids: string[] = [];
    for (let index = 0; index < 2000; index++) ids.push(next('cmd'));
    clock.set(1_700_000_000_005);
    ids.push(next('cmd'));
    const times = [10_000, 9_000, 9_500, 10_001];
    const backwards = createIdGenerator({ now: () => times.shift()! });
    const skewed = [backwards('cmd'), backwards('cmd'), backwards('cmd'), backwards('cmd')];
    expect(skewed.map((id) => parseId(id)?.timestamp)).toEqual([10_000, 10_000, 10_000, 10_001]);
    for (const list of [ids, skewed])
      for (let index = 1; index < list.length; index++)
        expect(list[index]! > list[index - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts by creation time across generators', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 48 - 2 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (time, gap) => {
          const later = Math.min(time + gap, 2 ** 48 - 1);
          const first = createIdGenerator({ now: () => time })('wf');
          const second = createIdGenerator({ now: () => later })('wf');
          expect(first < second).toBe(true);
          expect(parseId(first)?.timestamp).toBe(time);
          expect(parseId(second)?.timestamp).toBe(later);
        },
      ),
    );
  });

  it('is reproducible with an injected clock and byte source', () => {
    const make = () => createIdGenerator({ now: () => 42, random: seeded(7) });
    const one = make();
    const two = make();
    expect([one('node'), one('node')]).toEqual([two('node'), two('node')]);
  });

  it('rejects malformed prefixes and out-of-range times', () => {
    for (const prefix of ['', 'Rsv', 'rsv_x', '1abc', 'a'.repeat(17), 'rs-v']) {
      expect(() => newId(prefix)).toThrow();
      try {
        newId(prefix);
      } catch (error) {
        expect(isComputeError(error, 'INVALID_INPUT')).toBe(true);
      }
    }
    expect(() => createIdGenerator({ now: () => -1 })('rsv')).toThrow();
    expect(() => createIdGenerator({ now: () => 2 ** 48 })('rsv')).toThrow();
  });
});

describe('parseId', () => {
  it('rejects strings that are not compute ids', () => {
    for (const value of [
      '',
      'rsv',
      'rsv_',
      'RSV_01h',
      'rsv_01H00000000000000000000000',
      'rsv_0000000000000000000000000i',
    ])
      expect(parseId(value)).toBeUndefined();
    expect(isId(42)).toBe(false);
  });
});

describe('draftId', () => {
  it('derives the §3.4 draft id: prefix + base32(sha256(tenant ‖ identity ‖ key))', async () => {
    const id = await draftId('rsv', 'tnt_acme', 'idn_ada', 'reserve-1');
    // Frozen contract: this vector must never change (drafts are re-decided under the same id).
    expect(id).toBe('rsv_xhkyqqdmxbn262nmt9m9jk7m6624xq6gxb8jjp2x0p0st7a2jz30');
    const digest = createHash('sha256')
      .update(
        JSON.stringify(['better-compute/draft/v1', 'rsv', 'tnt_acme', 'idn_ada', 'reserve-1']),
      )
      .digest();
    expect(id).toBe(`rsv_${base32(new Uint8Array(digest))}`);
    expect(parseId(id)).toEqual({ prefix: 'rsv', body: id.slice(4) });
    expect(isId(id, 'rsv')).toBe(true);
  });

  it('is deterministic and separates every input', async () => {
    const base = await draftId('rsv', 't', 'i', 'k');
    expect(await draftId('rsv', 't', 'i', 'k')).toBe(base);
    expect(await draftId('inst', 't', 'i', 'k')).not.toBe(base.replace('rsv_', 'inst_'));
    expect(await draftId('rsv', 't2', 'i', 'k')).not.toBe(base);
    expect(await draftId('rsv', 't', 'i2', 'k')).not.toBe(base);
    expect(await draftId('rsv', 't', 'i', 'k2')).not.toBe(base);
    // Concatenation ambiguity: ('a', 'bc') and ('ab', 'c') must not collide.
    expect(await draftId('rsv', 'a', 'bc', 'd')).not.toBe(await draftId('rsv', 'ab', 'c', 'd'));
  });

  it('never collides for distinct triples', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
        ),
        fc.tuple(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
        ),
        async (left, right) => {
          fc.pre(left.join('\u0000') !== right.join('\u0000'));
          expect(await draftId('rsv', ...left)).not.toBe(await draftId('rsv', ...right));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('requires every input', async () => {
    await expect(draftId('rsv', '', 'i', 'k')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(draftId('rsv', 't', '', 'k')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(draftId('rsv', 't', 'i', '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(draftId('RSV', 't', 'i', 'k')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
