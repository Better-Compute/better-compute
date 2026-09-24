# Reference hardware

Benchmark numbers and the phase gates in [PLAN.md](../PLAN.md) §16 are quoted on these machines. A result from any other hardware is indicative only and says so next to the number.

| Role     | CPU     | Memory | Storage | Software                                                                      |
| -------- | ------- | ------ | ------- | ----------------------------------------------------------------------------- |
| Gateway  | 8 vCPU  | 32 GiB | —       | one better-compute `gateway` process on the newest Node.js line CI tests (24) |
| Postgres | 16 vCPU | 64 GiB | NVMe    | PostgreSQL 17, the same major version as the CI `postgres` job                |

Not fixed yet, and recorded here when the machines are provisioned (PLAN.md D15): the instance type or CPU model, the network between hosts, the hosts for `api`, `worker` and the load generators (FakeDaemons, admission clients), PgBouncer placement, and the Postgres configuration. Load generators never share a host with the process they measure.

## Benchmarks and gates

`pnpm bench:scale` runs the suites (`vitest.bench.config.ts`); they land in `bench/gateway-streams`, `bench/iam-lane` and `bench/placements` from v0.1.

| Suite           | Measures                                                                                                   | Gate                                                                                                                                                      | Phase |
| --------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| gateway-streams | mTLS sessions one gateway process holds at 10 s heartbeats, dispatch latency, RSS                          | ≥5,000 sessions for 30 min with dispatch p99 <500 ms and RSS <2 GiB; otherwise decide D20 (a Go gateway) before v0.2                                      | v0.1  |
| iam-lane        | Embedded better-iam on adapter-postgres, in lock acquisitions/s (list denials count as audit-chain writes) | ≥50 admissions/s (authenticate + require, ≈150 acquisitions/s) with lock wait <50%; record the ceiling. Below G5's 200 admissions/s, R1 is proposed (D18) | v0.1  |
| placements      | Placements/s through the placer, command latency                                                           | v0.1: recorded. v0.4: ≥200 placements/s, command p99 <1.5 s with polling only, Postgres CPU <50% at 10k nodes / 100k GPUs                                 | v0.1  |

## Recording a result

Each result records the commit, the date, the machines (instance type and CPU model), the Node.js and PostgreSQL versions, the configuration that differs from the defaults, the duration, and the numbers above with their percentiles. A run on other hardware keeps the same fields and is labeled as not on the reference hardware.
