import { ComputeError } from '@better-compute/core';

/** One element of a parsed AWS response. Namespaces are ignored: names are local names. */
export interface XmlElement {
  /** Local name, namespace prefix stripped. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Concatenated, entity-decoded character data (trimmed). */
  readonly text: string;
  /** First direct child with that name. */
  child(name: string): XmlElement | undefined;
  /** Every direct child with that name. */
  all(name: string): XmlElement[];
  /** `child(name)?.text`. */
  textOf(name: string): string | undefined;
  /** `<name><item>…</item>…</name>` (EC2) or `<name><member>…</member>…</name>` (query). [] when absent. */
  items(name: string): XmlElement[];
}

export interface XmlLimits {
  /** Largest accepted document in UTF-8 bytes. Default 16 MiB. */
  maxBytes?: number;
  /** Deepest accepted element nesting. Default 64. */
  maxDepth?: number;
}

const defaultMaxBytes = 16 * 1024 * 1024;
const defaultMaxDepth = 64;

type Reason = 'doctype' | 'entity' | 'depth' | 'size' | 'syntax';

function malformed(reason: Reason): ComputeError {
  return new ComputeError('PROVIDER_ERROR', 'malformed XML from AWS', undefined, { reason });
}

class Node implements XmlElement {
  readonly children: XmlElement[] = [];
  readonly attributes: Readonly<Record<string, string>>;
  readonly parts: string[] = [];
  text = '';

  constructor(
    readonly name: string,
    attributes: Map<string, string>,
  ) {
    // fromEntries defines own properties, so an attribute called __proto__ stays data.
    this.attributes = Object.fromEntries(attributes);
  }

  child(name: string): XmlElement | undefined {
    return this.children.find((element) => element.name === name);
  }

  all(name: string): XmlElement[] {
    return this.children.filter((element) => element.name === name);
  }

  textOf(name: string): string | undefined {
    return this.child(name)?.text;
  }

  items(name: string): XmlElement[] {
    return (
      this.child(name)?.children.filter(
        (element) => element.name === 'item' || element.name === 'member',
      ) ?? []
    );
  }
}

const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// A reference is `&name;`, `&#digits;` or `&#xhex;`; anything else after `&` is malformed.
const reference = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z_][A-Za-z0-9_.-]{0,31}));/y;
const nameStart = /[A-Za-z_\u0080-￿][A-Za-z0-9_.:\u0080-￿-]*/y;
const whitespace = /[ \t\r\n]*/y;

/** Decodes the five predefined entities and numeric character references; refuses everything else. */
function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let last = 0;
  for (let at = raw.indexOf('&'); at !== -1; at = raw.indexOf('&', last)) {
    out += raw.slice(last, at);
    reference.lastIndex = at;
    const match = reference.exec(raw);
    if (!match) throw malformed('syntax');
    const [whole, hex, decimal, named] = match;
    if (named !== undefined) {
      if (!Object.hasOwn(predefined, named)) throw malformed('entity');
      out += predefined[named];
    } else {
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal!, 10);
      const legal =
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff);
      if (!legal) throw malformed('syntax');
      out += String.fromCodePoint(code);
    }
    last = at + whole.length;
  }
  return out + raw.slice(last);
}

/** Skips whitespace at `at`, returning the index after it. */
function skipSpace(text: string, at: number): number {
  whitespace.lastIndex = at;
  whitespace.exec(text);
  return whitespace.lastIndex;
}

function readName(text: string, at: number): string {
  nameStart.lastIndex = at;
  const match = nameStart.exec(text);
  if (!match) throw malformed('syntax');
  return match[0];
}

const localName = (qualified: string) => qualified.slice(qualified.lastIndexOf(':') + 1);

/**
 * Parses an AWS XML response. A single-pass reader for the data-only XML AWS returns: it accepts the
 * `<?xml?>` declaration, elements, attributes, comments, CDATA and the five predefined entities, and
 * refuses DOCTYPE, custom entities, other processing instructions, and documents deeper or larger than
 * the limits. Malformed input throws `PROVIDER_ERROR` with `details.reason`.
 */
export function parseXml(text: string, limits: XmlLimits = {}): XmlElement {
  const maxBytes = limits.maxBytes ?? defaultMaxBytes;
  const maxDepth = limits.maxDepth ?? defaultMaxDepth;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw malformed('size');

  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (text.startsWith('<?xml', at) && /[ \t\r\n?]/.test(text[at + 5] ?? '')) {
    const end = text.indexOf('?>', at);
    if (end === -1) throw malformed('syntax');
    at = end + 2;
  }

  const stack: { node: Node; qualified: string }[] = [];
  let root: Node | undefined;

  const open = (qualified: string, attributes: Map<string, string>, selfClosing: boolean) => {
    if (stack.length === 0 && root) throw malformed('syntax');
    if (stack.length + 1 > maxDepth) throw malformed('depth');
    const node = new Node(localName(qualified), attributes);
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else root = node;
    if (selfClosing) finish(node);
    else stack.push({ node, qualified });
  };
  const finish = (node: Node) => {
    node.text = node.parts.join('').trim();
  };

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    const end = lt === -1 ? text.length : lt;
    if (end > at) {
      const chunk = text.slice(at, end);
      const top = stack[stack.length - 1];
      if (top) top.node.parts.push(decode(chunk));
      else if (chunk.trim() !== '') throw malformed('syntax');
      at = end;
    }
    if (lt === -1) break;

    if (text.startsWith('<!--', at)) {
      const close = text.indexOf('-->', at + 4);
      if (close === -1) throw malformed('syntax');
      at = close + 3;
    } else if (text.startsWith('<![CDATA[', at)) {
      const close = text.indexOf(']]>', at + 9);
      const top = stack[stack.length - 1];
      if (close === -1 || !top) throw malformed('syntax');
      top.node.parts.push(text.slice(at + 9, close));
      at = close + 3;
    } else if (/^<!doctype/i.test(text.slice(at, at + 9))) {
      throw malformed('doctype');
    } else if (/^<!entity/i.test(text.slice(at, at + 8))) {
      throw malformed('entity');
    } else if (text.startsWith('<!', at) || text.startsWith('<?', at)) {
      throw malformed('syntax');
    } else if (text.startsWith('</', at)) {
      const qualified = readName(text, at + 2);
      const close = skipSpace(text, at + 2 + qualified.length);
      const top = stack.pop();
      if (text[close] !== '>' || !top || top.qualified !== qualified) throw malformed('syntax');
      finish(top.node);
      at = close + 1;
    } else {
      const qualified = readName(text, at + 1);
      at += 1 + qualified.length;
      const attributes = new Map<string, string>();
      for (;;) {
        const afterSpace = skipSpace(text, at);
        const next = text[afterSpace];
        if (next === '>' || next === '/') {
          if (next === '/' && text[afterSpace + 1] !== '>') throw malformed('syntax');
          at = afterSpace + (next === '/' ? 2 : 1);
          open(qualified, attributes, next === '/');
          break;
        }
        // Attributes must be separated from the name or each other by whitespace.
        if (afterSpace === at || next === undefined) throw malformed('syntax');
        const attribute = readName(text, afterSpace);
        const eq = skipSpace(text, afterSpace + attribute.length);
        if (text[eq] !== '=') throw malformed('syntax');
        const quoteAt = skipSpace(text, eq + 1);
        const quote = text[quoteAt];
        if (quote !== '"' && quote !== "'") throw malformed('syntax');
        const close = text.indexOf(quote, quoteAt + 1);
        if (close === -1) throw malformed('syntax');
        const raw = text.slice(quoteAt + 1, close);
        if (raw.includes('<')) throw malformed('syntax');
        // Namespace declarations keep their name; every other prefix is dropped.
        const key =
          attribute === 'xmlns' || attribute.startsWith('xmlns:')
            ? attribute
            : localName(attribute);
        if (key === '') throw malformed('syntax');
        attributes.set(key, decode(raw));
        at = close + 1;
      }
    }
  }

  if (!root || stack.length > 0) throw malformed('syntax');
  return root;
}
