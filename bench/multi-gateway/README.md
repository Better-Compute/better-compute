# multi-gateway

The v0.4 gateway-kill exit (PLAN.md §16: "gateway-kill recovery < 60 s", §15), in simulation. N FakeDaemons joined through JoinService connect to 3 real gateways on manual jobs, with the real control plane behind them, all on the fleet simulator's clock. One gateway process dies without disconnect writes or a lease release. Its nodes redial and re-home to the other two. The suite measures, in simulated time, how long each node takes to hold a session on another gateway. It also checks I1, I2, I5 and I8 afterwards: in particular, no command ran twice.

```sh
BENCH_MG_NODES=10000 node node_modules/pnpm/bin/pnpm.mjs bench:scale
```

The suite is [`tests/bench/multi-gateway.bench.ts`](../../tests/bench/multi-gateway.bench.ts), built on `createControlPlaneSim({ gateways })`. The CI-sized scenarios (a kill mid-command, a zombie gateway, a certificate revocation) are in [`tests/sim/multi-gateway.test.ts`](../../tests/sim/multi-gateway.test.ts). Knobs: `BENCH_MG_NODES` (default 1000), `BENCH_MG_GATEWAYS` (3), and `BENCH_MG_GATE=1` to fail the run when the gate is missed.

## Results (2026-09-24, development machine, PGlite, one process)

| nodes | moved by the kill | re-home p50 | p90 | p99 | violations | heap per session (upper bound) | wall |
| ----- | ----------------- | ----------- | --- | --- | ---------- | ------------------------------ | ---- |
| 200 | 67 | 0.5 s | — | 1.25 s | 0 | 408 KiB | 21 s |
| 1000 | 334 | 0.5 s | 1.0 s | 1.0 s | 0 | 209 KiB | 81 s |
| 10000 | 3334 | 3.25 s | 8.5 s | 13.25 s | 0 | 102 KiB | 14.6 min |

The gate (p99 < 60 s) holds at 10k. Re-homing time grows with the fleet because a third of the nodes redial at once into two gateways, whose handshake bucket and Hello transactions pace them (§15 scale risk 3). The heap figure divides the whole process by the sessions it holds, simulator and control plane included, so the gateways' own share is smaller. Joining 10k nodes through JoinService took 97 s of wall time.
