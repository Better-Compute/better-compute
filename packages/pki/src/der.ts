import { ComputeError } from '@better-compute/core';

/**
 * A minimal DER (X.690) writer and strict reader: just what X.509 certificates, PKCS#10 requests
 * and their extensions need. The reader rejects indefinite and non-minimal lengths, so every value
 * has exactly one encoding and signed bytes can be sliced out of a parse.
 */

export const Tag = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', `Malformed DER: ${message}`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One tag-length-value. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), encodeLength(content.byteLength), content]);
}

/** Minimal two's-complement big-endian bytes of a non-negative integer. */
function unsignedIntegerContent(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = magnitude.subarray(start);
  if (trimmed.length === 0) return Uint8Array.of(0);
  return trimmed[0]! & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed.slice();
}

function bigintBytes(value: bigint): Uint8Array {
  if (value < 0n) throw invalid('negative integers are not supported');
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++)
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function encodeOid(dotted: string): Uint8Array {
  if (!/^[0-2](\.(0|[1-9]\d*))+$/.test(dotted)) throw invalid(`bad object identifier ${dotted}`);
  const arcs = dotted.split('.').map((arc) => BigInt(arc));
  const [first, second] = arcs as [bigint, bigint];
  if (first < 2n && second > 39n) throw invalid(`bad object identifier ${dotted}`);
  const out: number[] = [];
  for (const arc of [first * 40n + second, ...arcs.slice(2)]) {
    const chunk: number[] = [];
    let rest = arc;
    do {
      chunk.unshift(Number(rest & 0x7fn));
      rest >>= 7n;
    } while (rest > 0n);
    for (let index = 0; index < chunk.length - 1; index++) chunk[index]! |= 0x80;
    out.push(...chunk);
  }
  return Uint8Array.from(out);
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** DER writers. Every function returns one complete TLV. */
export const der = {
  sequence: (...items: readonly Uint8Array[]): Uint8Array => tlv(Tag.sequence, concat(items)),
  /** A SET OF, with elements sorted by their encodings as DER requires. */
  set: (...items: readonly Uint8Array[]): Uint8Array =>
    tlv(Tag.set, concat([...items].sort(compareBytes))),
  boolean: (value: boolean): Uint8Array => tlv(Tag.boolean, Uint8Array.of(value ? 0xff : 0)),
  /** A non-negative INTEGER from a number, a bigint or big-endian magnitude bytes. */
  integer: (value: number | bigint | Uint8Array): Uint8Array => {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) throw invalid(`bad integer ${value}`);
      value = BigInt(value);
    }
    const magnitude = typeof value === 'bigint' ? bigintBytes(value) : value;
    return tlv(Tag.integer, unsignedIntegerContent(magnitude));
  },
  null: (): Uint8Array => Uint8Array.of(Tag.null, 0),
  oid: (dotted: string): Uint8Array => tlv(Tag.oid, encodeOid(dotted)),
  octetString: (value: Uint8Array): Uint8Array => tlv(Tag.octetString, value),
  /** A BIT STRING of whole bytes (keys, signatures). */
  bitString: (value: Uint8Array, unusedBits = 0): Uint8Array =>
    tlv(Tag.bitString, concat([Uint8Array.of(unusedBits), value])),
  /** A named BIT STRING (KeyUsage): the set bit positions, trailing zero bits dropped per DER. */
  namedBits: (bits: readonly number[]): Uint8Array => {
    if (bits.length === 0) return tlv(Tag.bitString, Uint8Array.of(0));
    const highest = Math.max(...bits);
    const bytes = new Uint8Array(Math.floor(highest / 8) + 1);
    for (const bit of bits) bytes[bit >> 3]! |= 0x80 >> (bit & 7);
    return tlv(Tag.bitString, concat([Uint8Array.of(7 - (highest & 7)), bytes]));
  },
  utf8: (value: string): Uint8Array => tlv(Tag.utf8String, utf8.encode(value)),
  ia5: (value: string): Uint8Array => {
    if (!/^[\x00-\x7f]*$/.test(value)) throw invalid('IA5String must be ASCII');
    return tlv(Tag.ia5String, utf8.encode(value));
  },
  /** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050, always in seconds, Z. */
  time: (ms: number): Uint8Array => {
    const date = new Date(Math.floor(ms / 1000) * 1000);
    const year = date.getUTCFullYear();
    if (!Number.isFinite(date.getTime()) || year < 1950 || year > 9999)
      throw invalid('time out of range');
    const rest = `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
    return year < 2050
      ? tlv(Tag.utcTime, utf8.encode(`${two(year % 100)}${rest}`))
      : tlv(Tag.generalizedTime, utf8.encode(`${year}${rest}`));
  },
  /** `[n] EXPLICIT`: a constructed context tag wrapping one complete TLV. */
  explicit: (n: number, inner: Uint8Array): Uint8Array => tlv(0xa0 | n, inner),
  /** `[n] IMPLICIT`: replaces the tag of a primitive value's content. */
  implicit: (n: number, content: Uint8Array, constructed = false): Uint8Array =>
    tlv((constructed ? 0xa0 : 0x80) | n, content),
};

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

/** One parsed TLV. `bytes` is the whole encoding (for signed-bytes slices); `value` the content. */
export interface DerNode {
  tag: number;
  bytes: Uint8Array;
  value: Uint8Array;
}

/** Reads one TLV at `offset`; returns it and the offset just past it. */
export function readTlv(input: Uint8Array, offset = 0): { node: DerNode; next: number } {
  if (offset + 2 > input.length) throw invalid('truncated header');
  const tag = input[offset]!;
  if ((tag & 0x1f) === 0x1f) throw invalid('multi-byte tags are not supported');
  const lengthByte = input[offset + 1]!;
  let cursor = offset + 2;
  let length: number;
  if (lengthByte < 0x80) length = lengthByte;
  else {
    const count = lengthByte & 0x7f;
    if (count === 0) throw invalid('indefinite length');
    if (count > 4) throw invalid('length too large');
    if (cursor + count > input.length) throw invalid('truncated length');
    if (input[cursor] === 0) throw invalid('non-minimal length');
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + input[cursor + index]!;
    if (length < 0x80) throw invalid('non-minimal length');
    cursor += count;
  }
  const end = cursor + length;
  if (end > input.length) throw invalid('truncated value');
  return {
    node: { tag, bytes: input.subarray(offset, end), value: input.subarray(cursor, end) },
    next: end,
  };
}

/** Parses exactly one TLV spanning all of `input`. */
export function parseDer(input: Uint8Array): DerNode {
  const { node, next } = readTlv(input);
  if (next !== input.length) throw invalid('trailing bytes');
  return node;
}

/** The children of a constructed value. */
export function children(node: DerNode): DerNode[] {
  if (!(node.tag & 0x20)) throw invalid(`tag 0x${node.tag.toString(16)} is not constructed`);
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < node.value.length) {
    const { node: child, next } = readTlv(node.value, offset);
    out.push(child);
    offset = next;
  }
  return out;
}

/** Asserts a node's tag and returns it. */
export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (!node || node.tag !== tag)
    throw invalid(
      `${what}: expected tag 0x${tag.toString(16)}, got ${node ? `0x${node.tag.toString(16)}` : 'nothing'}`,
    );
  return node;
}

export function decodeOid(node: DerNode): string {
  expectTag(node, Tag.oid, 'object identifier');
  const bytes = node.value;
  if (bytes.length === 0 || bytes[bytes.length - 1]! & 0x80) throw invalid('bad object identifier');
  const arcs: bigint[] = [];
  let current = 0n;
  let started = false;
  for (const byte of bytes) {
    if (!started && byte === 0x80) throw invalid('non-minimal object identifier arc');
    started = true;
    current = (current << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(current);
      current = 0n;
      started = false;
    }
  }
  const head = arcs[0]!;
  const first = head < 40n ? 0n : head < 80n ? 1n : 2n;
  return [first, head - first * 40n, ...arcs.slice(1)].join('.');
}

/** A non-negative INTEGER as a bigint (negative encodings are rejected). */
export function decodeInteger(node: DerNode): bigint {
  expectTag(node, Tag.integer, 'integer');
  const bytes = node.value;
  if (bytes.length === 0) throw invalid('empty integer');
  if (bytes[0]! & 0x80) throw invalid('negative integer');
  if (bytes.length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80))
    throw invalid('non-minimal integer');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** The content bytes of a BIT STRING with no unused bits. */
export function decodeBitString(node: DerNode): Uint8Array {
  expectTag(node, Tag.bitString, 'bit string');
  if (node.value.length === 0 || node.value[0] !== 0) throw invalid('bit string with unused bits');
  return node.value.subarray(1);
}

/** The set bit positions of a named BIT STRING. */
export function decodeNamedBits(node: DerNode): number[] {
  expectTag(node, Tag.bitString, 'bit string');
  const unused = node.value[0];
  if (unused === undefined || unused > 7) throw invalid('bad bit string');
  const bytes = node.value.subarray(1);
  const bits: number[] = [];
  for (let index = 0; index < bytes.length * 8 - unused; index++)
    if (bytes[index >> 3]! & (0x80 >> (index & 7))) bits.push(index);
  return bits;
}

export function decodeString(node: DerNode): string {
  if (
    node.tag !== Tag.utf8String &&
    node.tag !== Tag.printableString &&
    node.tag !== Tag.ia5String &&
    node.tag !== (0x80 | 1) &&
    node.tag !== (0x80 | 2) &&
    node.tag !== (0x80 | 6)
  )
    throw invalid(`tag 0x${node.tag.toString(16)} is not a string`);
  try {
    return utf8Decoder.decode(node.value);
  } catch {
    throw invalid('string is not UTF-8');
  }
}

export function decodeBoolean(node: DerNode): boolean {
  expectTag(node, Tag.boolean, 'boolean');
  if (node.value.length !== 1 || (node.value[0] !== 0 && node.value[0] !== 0xff))
    throw invalid('bad boolean');
  return node.value[0] === 0xff;
}

/** UTCTime or GeneralizedTime (seconds precision, `Z`) as epoch milliseconds. */
export function decodeTime(node: DerNode): number {
  const text = decodeString({ ...node, tag: Tag.utf8String });
  let match: RegExpExecArray | null;
  let year: number;
  if (node.tag === Tag.utcTime) {
    match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) throw invalid('bad UTCTime');
    const yy = Number(match[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (node.tag === Tag.generalizedTime) {
    match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) throw invalid('bad GeneralizedTime');
    year = Number(match[1]);
  } else throw invalid('expected a time');
  const [, , month, day, hour, minute, second] = match.map(Number) as number[];
  const ms = Date.UTC(year, month! - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day)
    throw invalid('impossible date');
  return ms;
}

export { concat };
