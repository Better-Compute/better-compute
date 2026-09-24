/**
 * A seeded pseudo-random source for the simulator (PLAN.md §15: every failure reproducible from
 * its seed). `sfc32` seeded through `cyrb128`: fast, 128 bits of state, and identical on every
 * platform because it uses only 32-bit integer arithmetic.
 *
 * `fork(label)` derives an independent stream from the seed and the label, without consuming the
 * parent's stream, so adding a node or a fault in one place never shifts the draws of another.
 */
export interface Rng {
  /** The seed this stream was derived from (forks append `/<label>`). */
  readonly seed: string;
  /** A float in [0, 1). */
  next(): number;
  /** A uniformly distributed unsigned 32-bit integer. */
  uint32(): number;
  /** An integer in [0, maxExclusive); 0 when maxExclusive <= 1. */
  int(maxExclusive: number): number;
  /** An integer in [min, max], both inclusive. */
  range(min: number, max: number): number;
  /** True with probability `p` (clamped to [0, 1]); never draws when p <= 0 or p >= 1. */
  chance(p: number): boolean;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Shuffles `items` in place (Fisher–Yates) and returns it. */
  shuffle<T>(items: T[]): T[];
  /** Fills `bytes` with random bytes (the `random` of `createIdGenerator`). */
  fill(bytes: Uint8Array): void;
  /** `count` random bytes as lowercase hex. */
  hex(count: number): string;
  /** A random RFC 4122 version-4 UUID, lowercase (the shape of a kernel boot id). */
  uuid(): string;
  /** An independent stream for `label`, derived from this stream's seed only. */
  fork(label: string): Rng;
}

/** cyrb128: a 128-bit string hash, used only to spread a seed over sfc32's state. */
function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Creates a seeded stream. Equal seeds give equal streams on every platform. */
export function createRng(seed: number | bigint | string): Rng {
  const label = typeof seed === 'string' ? seed : String(seed);
  let [a, b, c, d] = cyrb128(label);
  const uint32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) uint32();
  const next = (): number => uint32() / 4294967296;
  const int = (maxExclusive: number): number =>
    maxExclusive <= 1 ? 0 : Math.floor(next() * Math.floor(maxExclusive));
  const rng: Rng = {
    seed: label,
    next,
    uint32,
    int,
    range: (min, max) => min + int(max - min + 1),
    chance: (p) => (p <= 0 ? false : p >= 1 ? true : next() < p),
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick() needs a non-empty array');
      return items[int(items.length)]!;
    },
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return items;
    },
    fill(bytes) {
      for (let i = 0; i < bytes.length; i += 4) {
        let word = uint32();
        for (let k = 0; k < 4 && i + k < bytes.length; k++) {
          bytes[i + k] = word & 0xff;
          word >>>= 8;
        }
      }
    },
    hex(count) {
      const bytes = new Uint8Array(count);
      rng.fill(bytes);
      let out = '';
      for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
      return out;
    },
    uuid() {
      const bytes = new Uint8Array(16);
      rng.fill(bytes);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      let h = '';
      for (const byte of bytes) h += byte.toString(16).padStart(2, '0');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    fork: (child) => createRng(`${label}/${child}`),
  };
  return rng;
}
