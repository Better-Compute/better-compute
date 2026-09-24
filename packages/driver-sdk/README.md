# @better-compute/driver-sdk

bcx, better-compute's out-of-process driver protocol (PLAN.md §5.5). A plugin serves
`bettercompute.driver.v1.DriverPlugin` (`Describe`, `Validate`, server-streaming `Invoke`, duplex
`Stream`, `Health`) over gRPC on HTTP/2 with auto-mTLS. The same protocol serves `bcd` and the
control plane. This package is the TypeScript SDK for both ends. It depends on
`@better-compute/core`, `protocol` and `pki`, runs on Node.js only, and is not part of the
`better-compute` umbrella.

**Status: v0.5 draft.** The proto is unstable until v0.5 ships.

## Plugin side

`serveDriver` runs **the same `defineDriver` object** you would register in process:

```ts
#!/usr/bin/env node
import { serveDriver } from '@better-compute/driver-sdk';
import { acmeBmc } from './driver.js'; // defineDriver({ id: 'acme-bmc', implements: { power }, … })

await serveDriver(acmeBmc); // or [acmeBmc, acmeMedia]; options: pluginVersion, streams, log, network
```

It exits with a human message (exit code 1) unless the host started it with the magic cookie. It
listens on a unix socket in `BCX_SOCKET_DIR`, or on `tcp` 127.0.0.1 on Windows, as go-plugin does
there. It prints one line on stdout:

```
bcx|1|unix|/tmp/bcx-Ab12/bcx-9f3e.sock|grpc|<base64url DER server certificate>
```

It logs JSON lines to stderr, which the host forwards to its own log. It shuts down gracefully on
SIGTERM or when stdin closes, and ignores SIGINT.

## Host side

```ts
import { externalDriver } from '@better-compute/driver-sdk';

const acme = externalDriver({ command: ['/opt/bc/plugins/acme-bmc'], sha256: '…' });
const compute = betterCompute({ drivers: [...builtins, ...(await acme.start())], … });
// on shutdown: await acme.close();
```

`start()` checks the pin, execs the plugin, reads the handshake within `startTimeoutMs`, dials, and
calls Describe. It returns one `DriverDefinition` per served driver:

- `implements[kind](config, ctx)` returns a proxy whose methods call `Invoke`;
- `config` is a Standard Schema over the plugin's JSON Schema;
- `validate` calls the plugin's `Validate`;
- `retrySafe` comes from the manifest.

`startExternalDrivers([a, b])` starts several hosts and returns all their drivers.

| Concern     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin         | `sha256` of `command[0]` (resolved against `cwd` or `PATH`). When `command[0]` is `node`, `nodejs` or `bun`, it pins the script: the first later argument that does not start with `-`, after `bun`'s optional `run`. Interpreter options must use the `--name=value` form. Only the entry file is pinned, so bundle a JS plugin into one file. The pin is checked before every start and restart; a mismatch is `INVALID_CONFIG`, and the host stops restarting. |
| mTLS        | Each side generates an ephemeral self-signed P-256 certificate with pki's `buildCertificate`. The host passes its own in `BCX_CLIENT_CERT`, and the plugin accepts exactly that certificate. The host trusts only the certificate in the handshake line.                                                                                                                                                                                                          |
| Environment | The plugin does not inherit the host's environment. It gets PATH, the temp dirs, HOME, a few OS basics, `env`, and the three `BCX_*` variables.                                                                                                                                                                                                                                                                                                                   |
| Arguments   | `args_json` is a JSON array of the positional arguments (`[]` for none). A non-array JSON value from another host is taken as the single argument. Results are JSON, and `undefined` travels as `null`.                                                                                                                                                                                                                                                           |
| Progress    | `ctx.emit` in the plugin becomes `Progress` frames. The host reports them through the caller's `ctx.emit`. If the caller iterates the call instead (`for await (const p of deploy(spec))`), the host yields them. Items that an `AsyncIterable` operation yields are progress too.                                                                                                                                                                                |
| Errors      | Exactly one `result_json` or `DriverError{code, message, retryable}` ends a call. Codes are kebab-case core codes (`invalid-config`, `conflict`, …). `driverError('unreachable', …)` sets a code of your choice, which comes back as `DRIVER_ERROR` with `details.driverCode`. `retryable` means the operation is listed in `retrySafe[kind]`.                                                                                                                    |
| Deadline    | The host sends `ctx.deadline` (epoch ms) when present, or `now + callTimeoutMs` otherwise. The plugin turns it into `ctx.signal` and ends the call with `timeout` even if the operation ignores the signal. Aborting the caller's `ctx.signal` cancels the call.                                                                                                                                                                                                  |
| Secrets     | The host resolves only the top-level config fields that the schema declares secret (`x-bc.kind: 'secret'` or `writeOnly`), and only when their value is a `SecretRef`. In the plugin, `ctx.secrets.resolve(ref)` resolves only refs that were delivered this way.                                                                                                                                                                                                 |
| Streams     | Declare byte-stream operations with `serveDriver(def, { streams: ['console.open'] })`. They are advertised as the capability `bcx.stream:console.open`, and the host proxy opens them with `Stream`. The first frame is `open`, and the plugin answers with an empty `data` frame once the stream is open. Then bytes flow both ways until `close`.                                                                                                               |
| Supervision | A crash, or a lost connection, fails the calls in flight with a retryable `DRIVER_ERROR` (`driverCode: 'unreachable'`). The host restarts the plugin with back-off (250 ms doubling to 30 s), and calls made meanwhile wait for the restart. `close()` closes the plugin's stdin, sends SIGTERM (except on Windows), and sends SIGKILL after `shutdownGraceMs`.                                                                                                   |

`connectPlugin(handshake, identity)` is the bare client, and `parseHandshake`, `formatHandshake` and
`createEphemeralIdentity` are the handshake pieces. Hosts in other processes, and tests, use these
directly.

Tests: `tests/driver-sdk-*.test.ts` run `tests/fixtures/bcx-echo-driver.mjs` as a real subprocess.
`tests/fixtures/bcx-loader.mjs` lets plain `node` load the workspace TypeScript sources.
