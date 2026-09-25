import { readFile, stat } from 'node:fs/promises';
import { createSecureContext, type SecureContextOptions } from 'node:tls';
import { ComputeError } from '@better-compute/core';

// Serving certificate hot reload (PLAN.md §7.1: 30-day gateway certificates, hot-reloaded). New
// handshakes get the new certificate; connections already open keep theirs, so daemons are not
// disconnected by a rotation. `pki issue-gateway` replaces its files atomically for this.

/** What a reload changes: the key pair, and optionally the client CA roots. */
export type TlsMaterial = Pick<SecureContextOptions, 'key' | 'cert' | 'ca'>;

/**
 * Swaps a TLS listener's secure context: `base` (the listener's original options: protocol
 * versions, ciphers, …) with `material` on top. The new context is built first, so a key that does
 * not match its certificate throws and leaves the listener as it was.
 */
export function swapSecureContext(
  server: { setSecureContext?(options: SecureContextOptions): void },
  base: SecureContextOptions | undefined,
  material: TlsMaterial,
): void {
  if (!base || typeof server.setSecureContext !== 'function')
    throw new ComputeError('INVALID_STATE', 'This listener has no TLS to reload');
  const options = { ...base, ...material };
  try {
    createSecureContext(options);
  } catch (error) {
    throw new ComputeError('INVALID_CONFIG', `The new TLS material does not load: ${(error as Error).message}`);
  }
  server.setSecureContext(options);
}

export interface TlsFiles {
  /** PEM private key. */
  key: string;
  /** PEM certificate followed by its chain. */
  cert: string;
  /** PEM CA roots (client verification), when the listener has them. */
  ca?: string;
}

export interface TlsFileWatch {
  /** Reads the files now if any changed since the last load; resolves whether it applied them. */
  check(): Promise<boolean>;
  close(): void;
}

/**
 * Polls `files` (mtime and size, every `intervalMs`, default 60 s) and calls `apply` with their
 * contents when any changed, e.g. `(tls) => served.setTls(tls)` for each listener. A read or
 * `apply` failure (a half-written pair, a key that does not match) goes to `onError` and the
 * listener keeps its certificate; the next change is tried again.
 */
export function watchTlsFiles(
  files: TlsFiles,
  apply: (material: TlsMaterial) => void,
  options: { intervalMs?: number; onError?: (error: unknown) => void; onReload?: () => void } = {},
): TlsFileWatch {
  const paths = [files.key, files.cert, ...(files.ca ? [files.ca] : [])];
  let last: string | undefined;
  let checking: Promise<boolean> | undefined;
  const fingerprint = async () =>
    (await Promise.all(paths.map(async (path) => {
      const info = await stat(path);
      return `${path}:${info.mtimeMs}:${info.size}`;
    }))).join('|');

  async function check(): Promise<boolean> {
    try {
      const current = await fingerprint();
      if (current === last) return false;
      const [key, cert, ca] = await Promise.all(paths.map((path) => readFile(path)));
      apply({ key: key!, cert: cert!, ...(ca ? { ca } : {}) });
      last = current;
      options.onReload?.();
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  }

  // The first check records what is loaded now (the listener was started with these files).
  const initial = fingerprint().then(
    (value) => void (last ??= value),
    () => undefined,
  );
  const timer = setInterval(() => {
    checking ??= initial.then(check).finally(() => {
      checking = undefined;
    });
  }, options.intervalMs ?? 60_000);
  timer.unref?.();
  return {
    check: () => initial.then(check),
    close: () => clearInterval(timer),
  };
}
