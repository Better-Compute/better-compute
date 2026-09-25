import { afterEach, describe, expect, it } from 'vitest';
import { createDeployment, unconfiguredIam, type Deployment } from '@better-compute/cli';
import { approverSetDigest, createApproverKey } from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import { publishedTrust, quorumFindings, quorumLag } from '../packages/cli/src/commands/pki.js';

// Review 10 M5: a daemon can take a bundle's version while refusing its quorum part, so doctor compares the
// approver set each connected daemon reports (node_sessions.approver_set_epoch / _sha256) with the published one.

let deployment: Deployment | undefined;
afterEach(async () => {
  await deployment?.close();
  deployment = undefined;
});

describe('quorum lag', () => {
  it('lists connected daemons enforcing another approver set than the published one', async () => {
    deployment = createDeployment(
      {
        database: pglite(),
        iam: unconfiguredIam(),
        secret: 'better-compute-quorum-lag-secret-0123456789',
        baseURL: 'http://127.0.0.1:3000',
        rootTenantId: 'root',
      },
      'test',
    );
    await deployment.compute.initialize();
    const sql = deployment.compute.context.sql;
    const [a, b] = [createApproverKey(), createApproverKey()];
    const set = { approverKeys: [a.key, b.key], approverThreshold: 2, quorumTiers: [], unbatchedDestructivePerHour: 0 };
    await sql.query(
      `INSERT INTO trust_bundle_state (id, version, digest, approver_set) VALUES ('current', 4, '\\x00', $1::jsonb)`,
      [
        JSON.stringify({
          keys: set.approverKeys.map((key) => ({ kid: key.kid, spki: Buffer.from(key.spkiDer).toString('base64') })),
          threshold: 2,
          tiers: [],
          unbatched: 0,
          epoch: '3',
        }),
      ],
    );
    const published = (await publishedTrust(sql))!;
    // Before the columns exist: nothing to compare.
    expect(await quorumLag(sql, published)).toBeUndefined();
    await sql.query(
      `ALTER TABLE node_sessions ADD COLUMN approver_set_epoch numeric(20, 0), ADD COLUMN approver_set_sha256 bytea`,
    );
    await sql.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_q', 'root', 'shared', 'eu', 1)`);
    const node = async (id: string, epoch: number | null, sha: Uint8Array | null, connected = true) => {
      await sql.query(
        `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
           trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, 'site_q', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
        [id],
      );
      await sql.query(
        `INSERT INTO node_sessions (node_id, session_epoch, gateway_id, approver_set_epoch, approver_set_sha256, disconnected_at, last_seen)
         VALUES ($1, 1, 'gw', $2, $3, CASE WHEN $4 THEN NULL ELSE compute_now() END, compute_now())`,
        [id, epoch, sha === null ? null : Buffer.from(sha), connected],
      );
    };
    const digest = approverSetDigest(set);
    await node('node_ok', 3, digest);
    await node('node_old', 2, digest);
    await node('node_keyless', 3, new Uint8Array());
    await node('node_away', 1, digest, false);
    await node('node_unreported', null, null);
    expect(await quorumLag(sql, published)).toEqual({
      connected: 3,
      behind: 2,
      sample: [
        { nodeId: 'node_keyless', epoch: 3 },
        { nodeId: 'node_old', epoch: 2 },
      ],
    });
    const options = { pki: { approvers: { keys: set.approverKeys.map((key) => key.spkiDer), threshold: 2 } } } as never;
    const findings = await quorumFindings(sql, options);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'pki.quorum-lag', severity: 'warning' });
    expect(findings[0]!.message).toMatch(/2 of 3 connected node\(s\).*node_keyless at epoch 3, node_old at epoch 2/);
  });
});
