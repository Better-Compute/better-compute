// Deterministic building blocks for the simulated data sources. Every generator in lib/data is a pure function of
// (seed, time): the server render and the first client render agree, and a paused clock freezes every view.

/** mulberry32: a small, fast, seedable PRNG. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string: stable seeds from ids ("pool_h100_fra1" → number). */
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded value in [0, 1) for one key: `noise('pool_a', 42)` is the same everywhere, every time. */
export function noise(key: string, step = 0): number {
  return rng(hash(key) ^ Math.imul(step | 0, 0x9e3779b1))();
}

/**
 * Smooth value noise over time: interpolates seeded points `periodMs` apart, so series drift instead of jittering.
 * Returns [0, 1).
 */
export function drift(key: string, t: number, periodMs = 3_600_000): number {
  const x = t / periodMs;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return noise(key, i) * (1 - s) + noise(key, i + 1) * s;
}

/** A diurnal load curve in [0, 1]: quiet at 04:00 UTC, busiest mid-afternoon. */
export function diurnal(t: number, phaseHours = 0): number {
  const hours = ((t / 3_600_000 + phaseHours) % 24 + 24) % 24;
  return 0.5 - 0.5 * Math.cos(((hours - 4) / 24) * 2 * Math.PI);
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Pick one item deterministically. */
export function pick<T>(items: readonly T[], key: string, step = 0): T {
  return items[Math.floor(noise(key, step) * items.length)]!;
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Floors a time to a step, so ticking clocks produce stable buckets. */
export const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

/**
 * The epoch every simulated fleet is anchored to (first render on the server). Views derive "now" from the
 * workspace clock (components/shell/workspace.tsx), never from Date.now() inside a generator.
 */
export const SIM_SEED = 0x5eed_c0de;
