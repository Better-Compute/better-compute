# bcd on an existing Kubernetes cluster

bcd runs as a DaemonSet on the nodes of a cluster a pool adopts. The manifests are not kept here: they
are rendered, validated, for your deployment by the CLI (`@better-compute/provider-kubernetes`'s
`bcdDaemonSetManifests`), so they cannot drift from what bcd and the control plane expect:

1. Build and push the image from [`daemon/Containerfile`](../../daemon/Containerfile), and note its digest:

   ```sh
   docker build -f daemon/Containerfile -t registry.example.com/better-compute/bcd:<version> daemon
   docker push registry.example.com/better-compute/bcd:<version>
   ```

2. Render the manifests and the join token Secret. The pins come from your PKI bundle (`better-compute pki show`
   on the control-plane host), never from the network:

   ```sh
   better-compute kubernetes manifest --pool <pool> --image registry.example.com/better-compute/bcd@sha256:<digest> \
     --serving-ca-pin <pin> --join-signing-pin <pin> --join-encryption-pin <pin> \
     --secret-out bcd-join-secret.json --out bcd.json
   ```

3. `kubectl apply -f bcd-join-secret.json`, then `kubectl apply -f bcd.json`.

4. Once every node has joined, delete the join token Secret (`kubectl -n bcd-system delete secret <name>`):
   the pods keep running without it, and a token left in the cluster is one more thing to leak. The token is
   minted `hosted: 'kubernetes'`, so its nodes land tenant-controlled unless the pool is platform-operated
   and the platform's own.

The DaemonSet sets `[host] units = false` by default (the cluster's GPU operator owns drivers, MIG and kernel
settings; bcd reports the host section as `HostManagedExternally`), takes no self-update (roll out a new
image instead) and never reboots a node. See the documentation's "bcd on Kubernetes" page.
