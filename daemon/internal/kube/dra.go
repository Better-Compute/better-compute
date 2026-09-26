package kube

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
)

// DRA: the follow-up to the device plugin (PLAN.md §3.8), for clusters with Dynamic Resource
// Allocation (resource.k8s.io, GA in 1.34). The same rule holds: only what compute bound with
// Binding.KUBERNETES. bcd publishes one ResourceSlice for the node (driver gpu.bcd.dev, pool = the
// Node's name) listing exactly those devices, with the kubelet's own credentials (NodeRestriction
// lets a node manage the slices of its node), and answers the kubelet's NodePrepareResources with
// CDI ids after checking, at that moment, that each allocated device is still bound here.
//
// A node runs either the device plugins or DRA, never both: the same GPU offered twice could be
// handed to two pods.

// DRADriverName is the DRA driver bcd registers.
const DRADriverName = "gpu.bcd.dev"

// GPU APIs a Manager can offer the kubelet.
const (
	APIDevicePlugin = "device-plugin"
	APIDRA          = "dra"
)

const (
	defaultRegistryDir  = "/var/lib/kubelet/plugins_registry"
	defaultDRAPluginDir = "/var/lib/kubelet/plugins/" + DRADriverName
	// sliceRefresh republishes an unchanged slice (a deleted one comes back).
	sliceRefresh = 10 * time.Minute
)

// draDeviceName makes a DRA device name (a DNS label, at most 63 characters) of an atom and the
// allocation it is bound to: GPU-5ab…/gi1/ci0 of alloc_x → gpu-5ab…-gi1-ci0-<8 hex of alloc_x>. The
// allocation is part of the name for the reason it is part of a device plugin id (deviceID).
func draDeviceName(atomID, allocation string) string {
	sum := sha256.Sum256([]byte(allocation))
	return strings.NewReplacer("/", "-", "_", "-").Replace(strings.ToLower(atomID)) + "-" + hex.EncodeToString(sum[:4])
}

// draDriver serves the kubelet's plugin registration and DRA services.
type draDriver struct {
	m *Manager

	regSrv, svcSrv   *http.Server
	regSock, svcSock os.FileInfo
	registered       atomic.Bool

	mu sync.Mutex
	// lastSlice is the published slice's content hash and when it was published.
	lastSlice   string
	publishedAt time.Time
	apiVersion  string
	// live: a slice with devices is out there (deleted once none are left).
	live bool
}

// lastPublished reports whether the node's slice offers devices now.
func (d *draDriver) lastPublished() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.live
}

func (d *draDriver) regPath() string {
	return filepath.Join(d.m.RegistryDir, DRADriverName+"-reg.sock")
}
func (d *draDriver) svcPath() string { return filepath.Join(d.m.DRAPluginDir, "dra.sock") }

func sameSocket(path string, want os.FileInfo) bool {
	st, err := os.Stat(path)
	return err == nil && want != nil && os.SameFile(st, want)
}

// serving reports whether both sockets are still the ones this driver listens on.
func (d *draDriver) serving() bool {
	return d.regSrv != nil && sameSocket(d.regPath(), d.regSock) && sameSocket(d.svcPath(), d.svcSock)
}

func listenUnix(path string) (net.Listener, os.FileInfo, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, nil, err
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, nil, err
	}
	st, err := os.Stat(path)
	if err != nil {
		ln.Close()
		return nil, nil, err
	}
	return ln, st, nil
}

// start serves the DRA service, then the registration socket the kubelet discovers.
func (d *draDriver) start() error {
	d.stop()
	svcLn, svcSock, err := listenUnix(d.svcPath())
	if err != nil {
		return err
	}
	regLn, regSock, err := listenUnix(d.regPath())
	if err != nil {
		svcLn.Close()
		return err
	}
	d.svcSrv = &http.Server{Handler: d.serviceHandler(), Protocols: h2c(), ReadHeaderTimeout: 10 * time.Second}
	d.regSrv = &http.Server{Handler: d.registrationHandler(), Protocols: h2c(), ReadHeaderTimeout: 10 * time.Second}
	d.svcSock, d.regSock = svcSock, regSock
	svc, reg := d.svcSrv, d.regSrv
	go func() { _ = svc.Serve(svcLn) }()
	go func() { _ = reg.Serve(regLn) }()
	d.m.Log.Info("DRA driver serving", "driver", DRADriverName, "registration", d.regPath())
	return nil
}

func (d *draDriver) stop() {
	for _, s := range []struct {
		srv  *http.Server
		path string
		sock os.FileInfo
	}{{d.regSrv, d.regPath(), d.regSock}, {d.svcSrv, d.svcPath(), d.svcSock}} {
		if s.srv == nil {
			continue
		}
		s.srv.Close()
		if sameSocket(s.path, s.sock) {
			os.Remove(s.path)
		}
	}
	d.regSrv, d.svcSrv, d.regSock, d.svcSock = nil, nil, nil, nil
	d.registered.Store(false)
}

func (d *draDriver) registrationHandler() http.Handler {
	opts := connect.WithCodec(codec{})
	mux := http.NewServeMux()
	mux.Handle(procGetInfo, connect.NewUnaryHandler(procGetInfo, func(context.Context, *connect.Request[InfoRequest]) (*connect.Response[PluginInfo], error) {
		return connect.NewResponse(&PluginInfo{
			Type: pluginTypeDRA, Name: DRADriverName, Endpoint: d.svcPath(),
			SupportedVersions: []string{draServiceV1, draServiceV1beta1},
		}), nil
	}, opts))
	mux.Handle(procNotifyRegistered, connect.NewUnaryHandler(procNotifyRegistered, func(_ context.Context, req *connect.Request[RegistrationStatus]) (*connect.Response[RegistrationStatusResponse], error) {
		d.registered.Store(req.Msg.PluginRegistered)
		if req.Msg.PluginRegistered {
			d.m.Log.Info("DRA driver registered with the kubelet", "driver", DRADriverName)
		} else {
			d.m.Log.Warn("the kubelet refused the DRA driver", "driver", DRADriverName, "error", req.Msg.Error)
		}
		return connect.NewResponse(&RegistrationStatusResponse{}), nil
	}, opts))
	return mux
}

func (d *draDriver) serviceHandler() http.Handler {
	opts := connect.WithCodec(codec{})
	prepare := func(ctx context.Context, req *connect.Request[ClaimsRequest]) (*connect.Response[PrepareResponse], error) {
		return connect.NewResponse(d.prepare(ctx, req.Msg.Claims)), nil
	}
	unprepare := func(_ context.Context, req *connect.Request[ClaimsRequest]) (*connect.Response[UnprepareResponse], error) {
		// Nothing to undo: preparing wrote nothing on the host (the CDI specs are the holds').
		out := &UnprepareResponse{Claims: map[string]string{}}
		for _, c := range req.Msg.Claims {
			out.Claims[c.UID] = ""
		}
		return connect.NewResponse(out), nil
	}
	mux := http.NewServeMux()
	for _, p := range []string{procPrepareV1, procPrepareV1beta1} {
		mux.Handle(p, connect.NewUnaryHandler(p, prepare, opts))
	}
	for _, p := range []string{procUnprepareV1, procUnprepareV1beta1} {
		mux.Handle(p, connect.NewUnaryHandler(p, unprepare, opts))
	}
	return mux
}

// claimObject is the part of a ResourceClaim prepare reads.
type claimObject struct {
	Metadata struct {
		UID string `json:"uid"`
	} `json:"metadata"`
	Status struct {
		Allocation *struct {
			Devices struct {
				Results []struct {
					Request string `json:"request"`
					Driver  string `json:"driver"`
					Pool    string `json:"pool"`
					Device  string `json:"device"`
				} `json:"results"`
			} `json:"devices"`
		} `json:"allocation"`
	} `json:"status"`
}

// prepare answers NodePrepareResources: each claim's gpu.bcd.dev devices as CDI ids, read from the
// claim's allocation (with the kubelet's credentials) and checked against the holds as they are now:
// a device compute no longer binds to Kubernetes here is refused, whatever the slice said.
func (d *draDriver) prepare(ctx context.Context, claims []Claim) *PrepareResponse {
	out := &PrepareResponse{Claims: map[string]ClaimResult{}}
	holds, err := ReadHolds(d.m.Sys)
	var devices map[string]atom
	if err == nil {
		devices = d.byDeviceName(d.m.atoms(holds))
	}
	node := d.m.nodeName()
	for _, c := range claims {
		if err != nil {
			out.Claims[c.UID] = ClaimResult{Error: fmt.Sprintf("read the holds: %v", err)}
			continue
		}
		out.Claims[c.UID] = d.prepareClaim(ctx, c, node, devices)
	}
	return out
}

func (d *draDriver) prepareClaim(ctx context.Context, c Claim, node string, devices map[string]atom) ClaimResult {
	raw, err := d.m.Sys.Run(ctx, kubectl("get", "resourceclaim", "--namespace", c.Namespace, c.Name, "-o", "json"))
	if err != nil {
		return ClaimResult{Error: fmt.Sprintf("read ResourceClaim %s/%s: %v", c.Namespace, c.Name, err)}
	}
	var claim claimObject
	if err := json.Unmarshal(raw, &claim); err != nil {
		return ClaimResult{Error: fmt.Sprintf("ResourceClaim %s/%s: %v", c.Namespace, c.Name, err)}
	}
	if claim.Metadata.UID != c.UID {
		return ClaimResult{Error: fmt.Sprintf("ResourceClaim %s/%s is not the claim %s the kubelet asked for", c.Namespace, c.Name, c.UID)}
	}
	if claim.Status.Allocation == nil {
		return ClaimResult{Error: fmt.Sprintf("ResourceClaim %s/%s is not allocated", c.Namespace, c.Name)}
	}
	byDevice := map[string]*PreparedDevice{}
	var order []string
	for _, r := range claim.Status.Allocation.Devices.Results {
		if r.Driver != DRADriverName {
			continue
		}
		a, ok := devices[r.Device]
		if r.Pool != node || !ok {
			return ClaimResult{Error: fmt.Sprintf("device %s/%s is not bound to Kubernetes on this node", r.Pool, r.Device)}
		}
		// Never hand a pod a GPU that went bad after the claim was allocated (it left the slice then).
		if !a.healthy {
			return ClaimResult{Error: fmt.Sprintf("device %s/%s is unhealthy", r.Pool, r.Device)}
		}
		p := byDevice[r.Device]
		if p == nil {
			p = &PreparedDevice{PoolName: r.Pool, DeviceName: r.Device, CDIDeviceIDs: append([]string(nil), a.cdi...)}
			byDevice[r.Device] = p
			order = append(order, r.Device)
		}
		p.RequestNames = append(p.RequestNames, r.Request)
	}
	res := ClaimResult{}
	for _, name := range order {
		res.Devices = append(res.Devices, *byDevice[name])
	}
	return res
}

// byDeviceName indexes the advertised devices (every resource) by their DRA device name.
func (d *draDriver) byDeviceName(want map[string]map[string]atom) map[string]atom {
	out := map[string]atom{}
	for _, atoms := range want {
		for _, a := range atoms {
			out[draDeviceName(a.id, a.allocation)] = a
		}
	}
	return out
}

// sliceAPI picks the newest resource.k8s.io version the API server serves.
func (d *draDriver) sliceAPI(ctx context.Context) (string, error) {
	d.mu.Lock()
	cached := d.apiVersion
	d.mu.Unlock()
	if cached != "" {
		return cached, nil
	}
	out, err := d.m.Sys.Run(ctx, kubectl("api-versions"))
	if err != nil {
		return "", fmt.Errorf("kubectl api-versions: %w", err)
	}
	served := map[string]bool{}
	for _, line := range strings.Fields(string(out)) {
		served[line] = true
	}
	for _, v := range []string{"resource.k8s.io/v1", "resource.k8s.io/v1beta2", "resource.k8s.io/v1beta1"} {
		if served[v] {
			d.mu.Lock()
			d.apiVersion = v
			d.mu.Unlock()
			return v, nil
		}
	}
	return "", errors.New("the API server serves no resource.k8s.io version: DRA is off in this cluster")
}

// resourceSlice renders the node's slice: every healthy bound device, with its GPU, class,
// allocation and NUMA node as attributes (v1beta1 nests them under "basic").
func resourceSlice(api, node string, generation int64, want map[string]map[string]atom) ([]byte, string) {
	type dev struct {
		name  string
		attrs map[string]map[string]any
	}
	var devs []dev
	for resource, atoms := range want {
		for _, a := range atoms {
			if !a.healthy {
				continue
			}
			attrs := map[string]map[string]any{
				"uuid":       {"string": GPUOf(a.id)},
				"class":      {"string": strings.TrimPrefix(resource, "bcd.dev/")},
				"allocation": {"string": a.allocation},
			}
			if a.visible != "" {
				attrs["visibleDevice"] = map[string]any{"string": a.visible}
			}
			if len(a.numa) > 0 {
				attrs["numaNode"] = map[string]any{"int": a.numa[0]}
			}
			devs = append(devs, dev{draDeviceName(a.id, a.allocation), attrs})
		}
	}
	sort.Slice(devs, func(i, j int) bool { return devs[i].name < devs[j].name })
	list := make([]map[string]any, 0, len(devs))
	for _, d := range devs {
		if api == "resource.k8s.io/v1beta1" {
			list = append(list, map[string]any{"name": d.name, "basic": map[string]any{"attributes": d.attrs}})
		} else {
			list = append(list, map[string]any{"name": d.name, "attributes": d.attrs})
		}
	}
	// The hash leaves the generation out: it says whether the devices changed.
	content, _ := json.Marshal(list)
	sum := sha256.Sum256(append([]byte(api+"\n"+node+"\n"), content...))
	body, _ := json.Marshal(map[string]any{
		"apiVersion": api,
		"kind":       "ResourceSlice",
		"metadata":   map[string]any{"name": sliceName(node)},
		"spec": map[string]any{
			"driver":   DRADriverName,
			"nodeName": node,
			"pool":     map[string]any{"name": node, "generation": generation, "resourceSliceCount": 1},
			"devices":  list,
		},
	})
	return body, hex.EncodeToString(sum[:])
}

func sliceName(node string) string { return node + "-" + DRADriverName }

// publish applies the node's slice when its devices changed (or every sliceRefresh), server-side
// with field manager bcd; with no devices it deletes the slice.
func (d *draDriver) publish(ctx context.Context, want map[string]map[string]atom) error {
	node := d.m.nodeName()
	if node == "" {
		return errors.New("the Node's name is unknown (no k8s-join record and no NODE_NAME)")
	}
	api, err := d.sliceAPI(ctx)
	if err != nil {
		return err
	}
	now := d.m.Now()
	body, hash := resourceSlice(api, node, now.Unix(), want)
	d.mu.Lock()
	unchanged := hash == d.lastSlice && now.Sub(d.publishedAt) < sliceRefresh
	d.mu.Unlock()
	if unchanged {
		return nil
	}
	empty := true
	for _, atoms := range want {
		for _, a := range atoms {
			if a.healthy {
				empty = false
			}
		}
	}
	if empty {
		_, err = d.m.Sys.Run(ctx, kubectl("delete", "resourceslice", sliceName(node), "--ignore-not-found", "--wait=false"))
	} else {
		cmd := kubectl("apply", "--server-side", "--field-manager=bcd", "--force-conflicts", "-f", "-")
		cmd.Stdin = body
		_, err = d.m.Sys.Run(ctx, cmd)
	}
	if err != nil {
		return fmt.Errorf("publish ResourceSlice %s: %w", sliceName(node), err)
	}
	d.mu.Lock()
	d.lastSlice, d.publishedAt, d.live = hash, now, !empty
	d.mu.Unlock()
	return nil
}

// nodeName is the Node this machine is: the k8s-join record's, or (hosted) NODE_NAME.
func (m *Manager) nodeName() string {
	if state, ok, err := ReadState(m.Sys); err == nil && ok && state.NodeName != "" {
		return state.NodeName
	}
	return m.NodeName
}
