import { describe, expect, it } from 'vitest';
import { rdsAuthToken, rdsAuthTokenProvider } from '@better-compute/aws';
import { AwsEmulator } from './support/aws-platform-emulator/index.js';

function rdsOptions(emu: AwsEmulator) {
  return {
    region: 'eu-west-1',
    credentials: emu.credentials,
    clock: emu.clock,
    hostname: 'bc-db.cluster-abc.eu-west-1.rds.amazonaws.com',
    username: 'better_compute',
  };
}

describe('RDS IAM auth', () => {
  it('token is a presigned connect URL for rds-db without a scheme', async () => {
    const emu = new AwsEmulator();
    const token = await rdsAuthToken(rdsOptions(emu));
    expect(token.startsWith('https://')).toBe(false);
    expect(token.startsWith('bc-db.cluster-abc.eu-west-1.rds.amazonaws.com:5432/?')).toBe(true);
    const url = new URL(`https://${token}`);
    expect(url.searchParams.get('Action')).toBe('connect');
    expect(url.searchParams.get('DBUser')).toBe('better_compute');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/\/eu-west-1\/rds-db\/aws4_request$/);
    // The signature verifies (the emulator checks presigned URLs as RDS would).
    expect(emu.authenticate('GET', url, {}, new Uint8Array())).toMatchObject({ service: 'rds-db', presigned: true });
    emu.clock.advance(901_000);
    expect(emu.authenticate('GET', url, {}, new Uint8Array())).toHaveProperty('error');
    await expect(rdsAuthToken({ ...rdsOptions(emu), hostname: 'evil.com/x' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('provider caches and refreshes before expiry', async () => {
    const emu = new AwsEmulator();
    let resolved = 0;
    const provider = rdsAuthTokenProvider({
      ...rdsOptions(emu),
      credentials: { kind: 'counting', credentials: async (context) => (resolved++, emu.credentials.credentials(context)) },
    });
    const [a, b] = await Promise.all([provider(), provider()]);
    expect(a).toBe(b);
    expect(resolved).toBe(1);
    emu.clock.advance(11 * 60_000);
    expect(await provider()).toBe(a);
    emu.clock.advance(60_001);
    const fresh = await provider();
    expect(fresh).not.toBe(a);
    expect(resolved).toBe(2);
  });

  it('token never appears in logs', async () => {
    // The token path has no logger at all; the provider holds it only in memory.
    const emu = new AwsEmulator();
    const entries: unknown[] = [];
    const log = { debug: (...a: unknown[]) => entries.push(a), info: (...a: unknown[]) => entries.push(a), warn: (...a: unknown[]) => entries.push(a), error: (...a: unknown[]) => entries.push(a) };
    const token = await rdsAuthTokenProvider({ ...rdsOptions(emu), log })();
    expect(JSON.stringify(entries)).not.toContain(new URL(`https://${token}`).searchParams.get('X-Amz-Signature'));
  });
});
