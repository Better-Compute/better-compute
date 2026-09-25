# Development: `better-compute dev --sim 8`

A control plane with every module on PGlite, and eight simulated HGX H100 machines that join it the way `bcd` does. Each machine gets a join token sealed to the control plane's JoinService key. It calls the Join RPC through a gateway, opens a Session stream, passes `diag.nvml` acceptance, and is adopted by the real runtime. Nothing is mocked above the daemon.

```sh
cd examples/dev
better-compute dev --memory --sim 8
```

`--memory` uses a throwaway database; leave it out to keep data in `.better-compute/example-db`. `--sim-variant l40s` gives 4×L40S machines, and `hgx-h100-gpu-missing` gives machines that fail acceptance and are never adopted. Standard error shows:

```
better-compute listening on http://127.0.0.1:3000/api/compute
Dev gateway (h2c, header auth, loopback only): http://127.0.0.1:52011
Embedded IAM root tenant ten_…; root token (dev only): biam_ses_…
Joined 8 simulated hgx-h100 node(s) into pool_…
8 simulated node(s) adopted
```

The embedded better-iam lives in memory for this run only. Its root token is a development credential.

## Look around

In a second terminal, as the root administrator:

```sh
export BETTER_COMPUTE_URL=http://127.0.0.1:3000
export BETTER_COMPUTE_TOKEN=biam_ses_…   # the root token dev printed
export BETTER_COMPUTE_TENANT=ten_…       # the root tenant dev printed
better-compute nodes list
better-compute pools list
source <(better-compute completion bash) # optional: tab completion for every command
```

Every API group has its commands (`better-compute help` lists them); anything else is `better-compute api GROUP.METHOD`.

## Reserve GPUs

Offer the pool to your own tenant with a quota, then reserve:

```sh
export POOL=pool_…                        # the pool dev created (pools list)
better-compute pools offer $POOL --to $BETTER_COMPUTE_TENANT --quota gpu=64
better-compute reserve --pool $POOL --gpus 4 --for 1h
better-compute capacity --pool $POOL
```

The reservation is placed on one machine. It binds through the node's desired state, and becomes `active` once the simulated daemon reports `AllocationBound`: its CDI devices are in the reservation's `binding`.

## Watch events

Server-sent events of your tenant, from the transactional outbox, one JSON line each:

```sh
better-compute events watch --types "node.*,reservation.*"
```

Cordon a node in another terminal (`better-compute nodes cordon node_… --reason demo`) and watch `node.cordoned` arrive. The stream is plain server-sent events at `GET /watch`, so `curl -N -H "Authorization: Bearer $BETTER_COMPUTE_TOKEN" "$BETTER_COMPUTE_URL/watch?types=node.*"` shows the same.

## Tunnels

`dev --sim` mounts the tunnel relay with a throwaway ticket issuer, so a simulated machine takes a console session:

```sh
better-compute console --node node_…
```

The simulated daemon answers with a line shell: `size` prints your terminal size, `exit` ends the session with status 0, `false` with 1, and Ctrl-] detaches. With a real `bcd`, the same command opens a root console on the node (`compute:nodes:console`), and `console --instance inst_…` opens a VM's serial console.
