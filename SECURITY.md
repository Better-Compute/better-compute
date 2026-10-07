# Security policy

better-compute schedules hardware, hands out machine identities and runs commands on hosts, so we treat security
reports as a priority. Thank you for helping keep its users safe.

## Supported versions

| Version | Supported                         |
| ------- | --------------------------------- |
| 0.1.x   | Yes: fixes ship as 0.1.x releases |
| < 0.1   | No                                |

Security fixes land on `main` and are released as a new patch version of every `better-compute` and
`@better-compute/*` package. The Go daemon `bcd` has no released binary yet; until it does, fixes to it land on `main`
and apply to builds from source.

## Reporting a vulnerability

Please do **not** open a public issue, pull request or discussion for a suspected vulnerability.

Report it privately through GitHub Security Advisories:
[github.com/better-compute/better-compute/security/advisories/new](https://github.com/better-compute/better-compute/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**).

A useful report includes:

- the affected package(s) and version, or the commit for `bcd` and anything built from source;
- the component (for example the gateway, the PKI, the IAM bridge, a daemon command kind) and the configuration
  needed to reach it;
- steps to reproduce, or a proof of concept, and the impact you expect (who can do what they should not);
- whether the issue is already public or known to others.

## What to expect

These are our targets; we will tell you if a report needs longer.

- **Acknowledgement** within 3 business days.
- **Initial assessment** (whether we can reproduce it, and its severity) within 10 business days.
- **Updates** at least every two weeks while we work on a fix.
- **Fix and disclosure** coordinated with you. We aim to release a fix within 90 days of the report, then publish a
  GitHub Security Advisory (with a CVE where appropriate) and note the fix in the release notes. We credit reporters
  who want to be credited.

Please give us a reasonable time to fix an issue before disclosing it, and avoid privacy violations, destruction of
data and disruption of systems you do not own while researching.

## Scope

In scope is everything in this repository, in particular:

- **The control plane packages** (`better-compute` and `@better-compute/*`): the API envelope, admission and
  authorization (every mutation's Better IAM decision), tenant isolation, placement and booking integrity, the event
  outbox, webhooks and the `/watch` stream, the MCP tools, and the audit checkpoints.
- **The gateway** (`@better-compute/gateway`): daemon sessions over gRPC on HTTP/2 mTLS, command dispatch, join,
  renew and secret forwarding, and tunnels.
- **The machine PKI** (`@better-compute/pki`): the local CAs, SPIFFE node certificates, sealed join tokens, signed
  join responses and renew proofs, attestors, command and release signing, and the destructive-batch approver quorum.
- **`bcd`**, the Go daemon in `daemon/`: joining, the node identity and its keys (including `bcd helper`), the
  commands it runs and their signatures, self-update and release verification, host configuration and device holds.
- **The CLI** (`@better-compute/cli`), including the generated daemon install script and key file handling.

Out of scope:

- vulnerabilities in Better IAM itself: report those to
  [Better IAM](https://github.com/Better-IAM/better-iam/security); tell us too if better-compute's use of it is
  affected;
- vulnerabilities in third-party dependencies, unless better-compute uses them in a way that makes the issue
  exploitable here;
- development-only modes working as documented, such as the loopback gateway of `better-compute dev --sim`
  (cleartext HTTP/2 with header authentication), `unconfiguredIam()`, or a PKI bundle written with `--plaintext`;
- attacks that need root on a node or control of the database, beyond what the documented threat model claims to
  withstand (see [security](https://better-compute.com/docs/operations/security));
- reports from automated scanners without a demonstrated impact.

If you are unsure whether something is in scope, report it privately anyway.
