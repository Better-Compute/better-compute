// Secret scanning for anything that leaves a machine for support (PLAN.md §6 "Support bundles are scanned for
// `bcjt_`/`biam_` tokens", §16 v0.1 security negative "support bundles hold no tokens"). One set of patterns for
// every producer: the CLI's control-plane bundle, FakeDaemon's `logs.collect`, and bcd (which mirrors them).

/** A kind of secret the scanner recognizes. */
export type SecretKind =
  | 'join-token'
  | 'iam-token'
  | 'jwt'
  | 'private-key'
  | 'url-password'
  | 'known-value';

interface SecretPattern {
  kind: SecretKind;
  /** Global regex; the match (or its `secret` group) is what gets replaced. */
  pattern: RegExp;
}

/**
 * The patterns, most specific first. Join/site tokens are `bcjt_<id>.<secret>`; IAM bearers are
 * `biam_ses_|key_|sts_|rol_|dlg_…`; JWS/JWE compact forms start with a base64url JSON header (`eyJ`); PEM
 * private keys of any algorithm; and the password of a `scheme://user:password@host` URL.
 */
const patterns: readonly SecretPattern[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  { kind: 'join-token', pattern: /\bbcjt_[A-Za-z0-9._-]+/g },
  { kind: 'iam-token', pattern: /\bbiam_[A-Za-z0-9._-]+/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){2,4}/g },
  // (Never its own replacement: a re-scan of redacted text must come back clean.)
  {
    kind: 'url-password',
    pattern: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)(?!\[redacted:)[^\s@/]+(?=@)/gi,
  },
];

export interface SecretScanOptions {
  /**
   * Exact values that must never appear (the deployment secret, tokens from the environment, database
   * passwords). Values shorter than 8 characters are ignored: they would match ordinary text.
   */
  known?: readonly (string | undefined)[];
}

export interface SecretFinding {
  kind: SecretKind;
  /** Offset of the match in the scanned text. */
  index: number;
  length: number;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function allPatterns(options: SecretScanOptions): SecretPattern[] {
  const known = [
    ...new Set((options.known ?? []).filter((value): value is string => !!value && value.length >= 8)),
  ].sort((a, b) => b.length - a.length);
  return known.length
    ? [{ kind: 'known-value', pattern: new RegExp(known.map(escape).join('|'), 'g') }, ...patterns]
    : [...patterns];
}

/**
 * Every secret in `text`, in order of position. Overlapping matches merge into one finding covering their
 * union (a known value inside a token must not leave the rest of the token behind); it keeps the kind of the
 * longest match.
 */
export function findSecrets(text: string, options: SecretScanOptions = {}): SecretFinding[] {
  const matches: SecretFinding[] = [];
  for (const { kind, pattern } of allPatterns(options)) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern))
      if (match[0].length > 0) matches.push({ kind, index: match.index ?? 0, length: match[0].length });
  }
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  const merged: (SecretFinding & { longest: number })[] = [];
  for (const match of matches) {
    const last = merged[merged.length - 1];
    if (last && match.index < last.index + last.length) {
      last.length = Math.max(last.length, match.index + match.length - last.index);
      // Ties go to the pattern that says what the secret is (`join-token` over `known-value`).
      if (match.length > last.longest || (match.length === last.longest && last.kind === 'known-value')) {
        last.kind = match.kind;
        last.longest = match.length;
      }
    } else merged.push({ ...match, longest: match.length });
  }
  return merged.map(({ kind, index, length }) => ({ kind, index, length }));
}

/**
 * `text` with every secret replaced by `[redacted:<kind>]`; a token keeps its prefix (`bcjt_[redacted]`) so a
 * reader still sees which kind of credential was there.
 */
export function redactSecrets(
  text: string,
  options: SecretScanOptions = {},
): { text: string; redacted: number } {
  const findings = findSecrets(text, options);
  if (!findings.length) return { text, redacted: 0 };
  let out = '';
  let at = 0;
  for (const finding of findings) {
    out += text.slice(at, finding.index);
    out +=
      finding.kind === 'join-token'
        ? 'bcjt_[redacted]'
        : finding.kind === 'iam-token'
          ? 'biam_[redacted]'
          : `[redacted:${finding.kind}]`;
    at = finding.index + finding.length;
  }
  return { text: out + text.slice(at), redacted: findings.length };
}
