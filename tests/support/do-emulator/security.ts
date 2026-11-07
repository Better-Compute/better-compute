import type { DoEmulator } from './index.js';
import type { Json } from './state.js';

// Security posture scans under `/v2/security` (DigitalOcean P9): the scan list and the latest scan with its
// findings. The shapes are the provider's best reading of DO's Security API (unverified against a live account);
// the provider parses them tolerantly. A test sets `securityOf(emulator).scans` (newest first).

export interface EmulatedSecurity {
  scans: Json[];
}

const all = new WeakMap<DoEmulator, EmulatedSecurity>();

export function securityOf(emulator: DoEmulator): EmulatedSecurity {
  let security = all.get(emulator);
  if (!security) {
    security = { scans: [] };
    all.set(emulator, security);
  }
  return security;
}

export function registerSecurity(emulator: DoEmulator): void {
  emulator.route('GET', /^\/security\/scans$/, (context) =>
    emulator.paged(
      context,
      'scans',
      securityOf(emulator).scans.map(({ findings: _findings, ...scan }) => scan),
    ),
  );
  emulator.route('GET', /^\/security\/scans\/latest$/, () => {
    const latest = securityOf(emulator).scans[0];
    if (!latest) return emulator.error('not-found');
    return { status: 200, body: { scan: structuredClone(latest) } };
  });
}
