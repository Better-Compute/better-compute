# @better-compute/aws

AWS platform services behind the seams better-compute already has, with no AWS SDK. Each export is a factory that returns an object implementing an existing interface (`SecretStore`, `BlobStore`, `SnapshotStore`, `EventSink`, `AuditSink`, `CertificateAuthority`), so a host that runs on or next to AWS plugs them in without changing `@better-compute/core`. None of them is required, and each works on its own.

It depends on `@better-compute/core`, `@better-compute/aws-core`, `@better-compute/pki` and `@better-compute/vps`. It is not in the `better-compute` umbrella, and nothing in `packages/` depends on it.

The factories are documented as they land; see `docs/superpowers/plans/2026-10-18-aws-a8-platform-services.md`.

## License

Apache-2.0.
