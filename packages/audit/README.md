# @better-compute/audit

Tamper-evident audit for better-compute: signed per-tenant Merkle checkpoints over `audit_events`, with inclusion proofs a third party can check offline.

## Install

```sh
npm install @better-compute/audit
```

It is also included in the umbrella package as `better-compute/audit`:

```sh
npm install better-compute
```

## Usage

```ts
import { auditModule, verifyAuditCheckpoints } from '@better-compute/audit';
import { betterCompute } from '@better-compute/server';

// The PKI bundle (`better-compute pki init`) carries the audit signing key.
const signer = pkiBundle.auditSigning!;

const compute = betterCompute({
  // ...database, secret, baseURL, iam
  modules: [auditModule({ signer })],
});

const report = await verifyAuditCheckpoints(compute.context.sql, {
  tenantId: 'org_…',
  trust: { publicKey: signer.publicKey },
});
if (!report.ok) console.error(report.problems);
```

## How it works

`audit_events` records every allowed mutation with its admission context, plus commands, steps, tickets and security events. This package seals those rows with signed per-tenant Merkle checkpoints. Writers never serialize on a chain head the way Better IAM's audit chain does: rows are appended freely and sealed afterwards.

- **Commit order, not clock order.** `occurred_at` is a transaction's start time, so a long transaction could commit a row into an hour that was already sealed. Checkpoints therefore follow the `(txid, seq)` commit cursor instead. They only read transactions older than the snapshot's xmin, the same rule the outbox uses, so no row can commit behind the cursor. `occurred_at` is hashed as data, in microseconds.
- **Per-tenant chains.** Each pass groups new rows by tenant and writes one checkpoint per tenant. A checkpoint holds an RFC 6962 root over the tenant's rows in the range, in commit order, and is signed with the audit key. Each one links to the tenant's previous checkpoint through the SHA-256 of that checkpoint's body.
- **Verification.** `verifyAuditCheckpoints(sql, { tenantId, trust })` recomputes the whole chain: sequence gaps, the hash links, signatures, and every root and size against the rows as they are now. It catches an edited, deleted or inserted row, a removed checkpoint, a rewritten body and the wrong key.
- **Inclusion proofs.** `proveAuditEvent(sql, { tenantId, eventId })` returns a JSON proof. A third party checks it offline with `verifyAuditProof(proof, trust)`.
- **Archived months.** `audit_events` is partitioned by UTC month. To archive a month, first call `markAuditArchived(sql, { month: 'YYYY-MM', partition?, by? })`. It refuses the current month, and any month with rows no checkpoint sealed yet. Then detach the partition with `detachHistoryPartition(tx, 'audit_events', 'audit_events_pYYYYMM')` from `@better-compute/postgres`, and export it. Verification lists a checkpoint wholly inside archived months under `report.archived` once its rows are gone; its body, chain and signature are still checked. While the rows are still attached, the checkpoint is verified as usual. A month detached without being marked shows as `size`/`root` problems, the same as deleted rows.

The hashing, canonical JSON and checkpoint signing are `@better-compute/pki`'s: `merkleLeafHash`, `merkleRoot`, `signCheckpoint` / `verifyCheckpoint` for the purpose `audit-checkpoint`, and `createAuditSigningKey`. The CLI's `better-compute audit checkpoint|verify|prove|check-proof` commands call this package.

## The module

`auditModule({ signer, every?, limit? })` owns `audit_checkpoints`, `audit_checkpoint_cursor` and `audit_archives` (migrations `audit/0001_checkpoints`, `audit/0002_archives`). It runs the `audit.checkpoint` reconciler every hour by default (`every`), sealing up to 50,000 rows per pass (`limit`), and its `selfCheck` warns when rows older than 3 hours are still unsealed. `checkpointAudit(sql, { signer })` runs one pass directly.

The tests run on PGlite, which serializes transactions. The xmin rule for concurrent long transactions uses the same query shape as the outbox, which runs under PostgreSQL.

## Documentation

- [Audit](https://better-compute.com/docs/guides/events/audit)
- [Retention](https://better-compute.com/docs/operations/retention)
- [CLI reference](https://better-compute.com/docs/reference/cli)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
