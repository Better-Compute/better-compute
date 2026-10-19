import type { DoEmulator } from './index.js';
import { fixture, type Json } from './state.js';

// `GET /v2/account`: the account the token belongs to, shaped like the fixture. A test changes
// the account (its Droplet limit, its status) by editing `account`.

export function registerAccount(emulator: DoEmulator): void {
  emulator.account = structuredClone(fixture('account').account as Json);
  emulator.route('GET', /^\/account$/, () => ({
    status: 200,
    body: { account: structuredClone(emulator.account) },
  }));
}
