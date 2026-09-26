package kube

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
)

// deviceplugin/v1beta1 procedures.
const (
	apiVersion1beta1         = "v1beta1"
	procRegister             = "/v1beta1.Registration/Register"
	procGetDevicePluginOpts  = "/v1beta1.DevicePlugin/GetDevicePluginOptions"
	procListAndWatch         = "/v1beta1.DevicePlugin/ListAndWatch"
	procGetPreferredAlloc    = "/v1beta1.DevicePlugin/GetPreferredAllocation"
	procAllocate             = "/v1beta1.DevicePlugin/Allocate"
	procPreStartContainer    = "/v1beta1.DevicePlugin/PreStartContainer"
	procListPodResources     = "/v1.PodResourcesLister/List"
	kubeletSocketName        = "kubelet.sock"
	defaultDevicePluginsDir  = "/var/lib/kubelet/device-plugins"
	defaultPodResourcesSock  = "/var/lib/kubelet/pod-resources/kubelet.sock"
	allocationIDsAnnotation  = "bcd.dev/allocation-ids"
	allocationIDsEnvironment = "BCD_ALLOCATION_IDS"
)

// atom is one advertised device. It is keyed by its kubelet id, deviceID(id, allocation): the same GPU
// bound to another allocation is another device, so a pod the kubelet gave it under the old
// allocation holds an id nobody advertises any more, and is reaped (review round 5 #3).
type atom struct {
	// id is the atom id (GPU-…, <gpu>_gi1_ci0, <gpu>_s2): the CDI device name.
	id         string
	allocation string
	// cdi are the CDI names Allocate answers for it.
	cdi []string
	// visible is what NVIDIA_VISIBLE_DEVICES names (the GPU or MIG UUID).
	visible string
	numa    []int64
	healthy bool
}

// plugin serves one kubelet resource on its own socket in the device-plugins directory.
type plugin struct {
	resource string
	dir      string
	socket   string // file name in dir
	log      func(msg string, args ...any)

	mu      sync.Mutex
	atoms   map[string]atom
	changed chan struct{} // closed and replaced when atoms change

	srv     *http.Server
	ln      net.Listener
	sock    os.FileInfo // our socket as created
	kubelet os.FileInfo // kubelet.sock as registered with
}

// deviceID is a device's kubelet id: the atom and the allocation it is bound to.
func deviceID(atomID, allocation string) string { return atomID + "@" + allocation }

func socketName(resource string) string {
	// bcd.dev/gpu.mig → bcd-gpu.mig.sock
	return "bcd-" + strings.TrimPrefix(resource, "bcd.dev/") + ".sock"
}

func newPlugin(resource, dir string, log func(string, ...any)) *plugin {
	return &plugin{resource: resource, dir: dir, socket: socketName(resource), log: log, atoms: map[string]atom{}, changed: make(chan struct{})}
}

// set replaces the advertised devices, waking ListAndWatch when they changed.
func (p *plugin) set(atoms map[string]atom) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if sameAtoms(p.atoms, atoms) {
		return
	}
	p.atoms = atoms
	close(p.changed)
	p.changed = make(chan struct{})
}

func sameAtoms(a, b map[string]atom) bool {
	if len(a) != len(b) {
		return false
	}
	for id, x := range a {
		y, ok := b[id]
		if !ok || x.allocation != y.allocation || x.healthy != y.healthy || x.visible != y.visible ||
			strings.Join(x.cdi, ",") != strings.Join(y.cdi, ",") || fmt.Sprint(x.numa) != fmt.Sprint(y.numa) {
			return false
		}
	}
	return true
}

func (p *plugin) snapshot() (map[string]atom, <-chan struct{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.atoms, p.changed
}

func (p *plugin) list() *ListAndWatchResponse {
	atoms, _ := p.snapshot()
	resp := &ListAndWatchResponse{}
	for _, id := range keys(atoms) {
		a := atoms[id]
		health := Healthy
		if !a.healthy {
			health = Unhealthy
		}
		resp.Devices = append(resp.Devices, &Device{ID: id, Health: health, NUMA: a.numa})
	}
	return resp
}

// serving reports whether the plugin's socket is still the one it created and the kubelet it
// registered with is still the one running (a kubelet restart removes every plugin socket and
// recreates its own).
func (p *plugin) serving() bool {
	if p.srv == nil {
		return false
	}
	st, err := os.Stat(filepath.Join(p.dir, p.socket))
	if err != nil || !os.SameFile(st, p.sock) {
		return false
	}
	k, err := os.Stat(filepath.Join(p.dir, kubeletSocketName))
	return err == nil && os.SameFile(k, p.kubelet) && k.ModTime().Equal(p.kubelet.ModTime())
}

// start serves the plugin's socket and registers it with the kubelet.
func (p *plugin) start(ctx context.Context) error {
	p.stop()
	path := filepath.Join(p.dir, p.socket)
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	st, err := os.Stat(path)
	if err != nil {
		ln.Close()
		return err
	}
	p.ln, p.sock = ln, st
	p.srv = &http.Server{Handler: p.handler(), Protocols: h2c(), ReadHeaderTimeout: 10 * time.Second}
	srv := p.srv
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			p.log("device plugin stopped", "resource", p.resource, "error", err.Error())
		}
	}()
	kubelet := filepath.Join(p.dir, kubeletSocketName)
	k, err := os.Stat(kubelet)
	if err != nil {
		p.stop()
		return err
	}
	client := connect.NewClient[RegisterRequest, Empty](unixClient(kubelet), "http://localhost"+procRegister, connect.WithGRPC(), connect.WithCodec(codec{}))
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err = client.CallUnary(rctx, connect.NewRequest(&RegisterRequest{
		Version:      apiVersion1beta1,
		Endpoint:     p.socket,
		ResourceName: p.resource,
		Options:      &DevicePluginOptions{GetPreferredAllocationAvailable: true},
	}))
	if err != nil {
		p.stop()
		return fmt.Errorf("register %s with the kubelet: %w", p.resource, err)
	}
	p.kubelet = k
	p.log("device plugin registered", "resource", p.resource, "socket", p.socket)
	return nil
}

func (p *plugin) stop() {
	if p.srv != nil {
		p.srv.Close()
		p.srv = nil
		// Only our own socket: a restarted kubelet may already have removed it.
		if st, err := os.Stat(filepath.Join(p.dir, p.socket)); err == nil && os.SameFile(st, p.sock) {
			os.Remove(filepath.Join(p.dir, p.socket))
		}
	}
	p.ln, p.sock, p.kubelet = nil, nil, nil
}

// h2c is HTTP/2 without TLS, prior knowledge only: the kubelet's gRPC over unix sockets.
func h2c() *http.Protocols {
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	return &p
}

func unixClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		Protocols: h2c(),
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}}
}

func (p *plugin) handler() http.Handler {
	opts := []connect.HandlerOption{connect.WithCodec(codec{})}
	mux := http.NewServeMux()
	mux.Handle(procGetDevicePluginOpts, connect.NewUnaryHandler(procGetDevicePluginOpts,
		func(context.Context, *connect.Request[Empty]) (*connect.Response[DevicePluginOptions], error) {
			return connect.NewResponse(&DevicePluginOptions{GetPreferredAllocationAvailable: true}), nil
		}, opts...))
	mux.Handle(procListAndWatch, connect.NewServerStreamHandler(procListAndWatch,
		func(ctx context.Context, _ *connect.Request[Empty], stream *connect.ServerStream[ListAndWatchResponse]) error {
			for {
				_, changed := p.snapshot()
				if err := stream.Send(p.list()); err != nil {
					return err
				}
				select {
				case <-ctx.Done():
					return nil
				case <-changed:
				}
			}
		}, opts...))
	mux.Handle(procGetPreferredAlloc, connect.NewUnaryHandler(procGetPreferredAlloc,
		func(_ context.Context, req *connect.Request[PreferredAllocationRequest]) (*connect.Response[PreferredAllocationResponse], error) {
			atoms, _ := p.snapshot()
			resp := &PreferredAllocationResponse{}
			for _, r := range req.Msg.ContainerRequests {
				resp.ContainerResponses = append(resp.ContainerResponses, preferred(atoms, r))
			}
			return connect.NewResponse(resp), nil
		}, opts...))
	mux.Handle(procAllocate, connect.NewUnaryHandler(procAllocate,
		func(_ context.Context, req *connect.Request[AllocateRequest]) (*connect.Response[AllocateResponse], error) {
			atoms, _ := p.snapshot()
			resp := &AllocateResponse{}
			for _, ids := range req.Msg.ContainerRequests {
				c, err := allocate(atoms, ids)
				if err != nil {
					return nil, connect.NewError(connect.CodeFailedPrecondition, err)
				}
				resp.ContainerResponses = append(resp.ContainerResponses, c)
			}
			return connect.NewResponse(resp), nil
		}, opts...))
	mux.Handle(procPreStartContainer, connect.NewUnaryHandler(procPreStartContainer,
		func(context.Context, *connect.Request[PreStartContainerRequest]) (*connect.Response[PreStartContainerResponse], error) {
			return connect.NewResponse(&PreStartContainerResponse{}), nil
		}, opts...))
	return mux
}

// allocate answers one container: bcd's CDI devices (and NVIDIA's, when generated), the visible
// devices and the allocations they belong to. A device compute no longer binds to Kubernetes is
// refused, so the kubelet cannot start a container on a released GPU.
func allocate(atoms map[string]atom, ids []string) (*ContainerAllocateResponse, error) {
	c := &ContainerAllocateResponse{Envs: map[string]string{}, Annotations: map[string]string{}}
	allocations := map[string]bool{}
	var visible []string
	for _, id := range ids {
		a, ok := atoms[id]
		if !ok {
			return nil, fmt.Errorf("device %s is not bound to Kubernetes on this node", id)
		}
		c.CDIDevices = append(c.CDIDevices, a.cdi...)
		allocations[a.allocation] = true
		if a.visible != "" {
			visible = append(visible, a.visible)
		}
	}
	sort.Strings(visible)
	if len(visible) > 0 {
		c.Envs["NVIDIA_VISIBLE_DEVICES"] = strings.Join(visible, ",")
	}
	ids = keys(allocations)
	c.Envs[allocationIDsEnvironment] = strings.Join(ids, ",")
	c.Annotations[allocationIDsAnnotation] = strings.Join(ids, ",")
	return c, nil
}

// preferred picks size devices for one container: the ones it must include, then devices of the
// same allocation and NUMA node as those, then the allocation with the most free devices.
func preferred(atoms map[string]atom, r *ContainerPreferredAllocationRequest) []string {
	size := int(r.AllocationSize)
	chosen := map[string]bool{}
	var out []string
	take := func(id string) {
		if len(out) < size && !chosen[id] {
			if _, ok := atoms[id]; ok {
				chosen[id] = true
				out = append(out, id)
			}
		}
	}
	for _, id := range r.MustIncludeDeviceIDs {
		take(id)
	}
	available := append([]string(nil), r.AvailableDeviceIDs...)
	sort.Strings(available)
	byAllocation := map[string][]string{}
	for _, id := range available {
		if a, ok := atoms[id]; ok {
			byAllocation[a.allocation] = append(byAllocation[a.allocation], id)
		}
	}
	numaOf := func(id string) string { return fmt.Sprint(atoms[id].numa) }
	if len(out) > 0 {
		anchor := atoms[out[0]]
		for _, id := range byAllocation[anchor.allocation] {
			if numaOf(id) == fmt.Sprint(anchor.numa) {
				take(id)
			}
		}
		for _, id := range byAllocation[anchor.allocation] {
			take(id)
		}
	}
	groups := keys(byAllocation)
	sort.SliceStable(groups, func(i, j int) bool { return len(byAllocation[groups[i]]) > len(byAllocation[groups[j]]) })
	for _, g := range groups {
		for _, id := range byAllocation[g] {
			take(id)
		}
	}
	return out
}
