package kube

import (
	"errors"
	"fmt"

	"google.golang.org/protobuf/encoding/protowire"
)

// The kubelet's gRPC messages, encoded by hand with protowire so bcd needs no Kubernetes modules:
// k8s.io/kubelet/pkg/apis/deviceplugin/v1beta1 (api.proto) and podresources/v1 (the List call).
// Field numbers are the upstream ones; unknown fields are skipped, as protobuf requires.

// message is what codec marshals.
type message interface {
	marshal() []byte
	unmarshal([]byte) error
}

// codec is connect's "proto" codec for the messages here (gRPC's application/grpc).
type codec struct{}

func (codec) Name() string { return "proto" }

func (codec) Marshal(v any) ([]byte, error) {
	m, ok := v.(message)
	if !ok {
		return nil, fmt.Errorf("kube codec: %T is not a kubelet message", v)
	}
	return m.marshal(), nil
}

func (codec) Unmarshal(b []byte, v any) error {
	m, ok := v.(message)
	if !ok {
		return fmt.Errorf("kube codec: %T is not a kubelet message", v)
	}
	return m.unmarshal(b)
}

var errWire = errors.New("kube: malformed protobuf")

// fields walks a message's fields; each callback gets the field number, wire type and the value's
// bytes (varints decoded into v).
func fields(b []byte, each func(num protowire.Number, typ protowire.Type, v uint64, raw []byte) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return errWire
		}
		b = b[n:]
		var v uint64
		var raw []byte
		switch typ {
		case protowire.VarintType:
			v, n = protowire.ConsumeVarint(b)
		case protowire.BytesType:
			raw, n = protowire.ConsumeBytes(b)
		default:
			n = protowire.ConsumeFieldValue(num, typ, b)
		}
		if n < 0 {
			return errWire
		}
		b = b[n:]
		if err := each(num, typ, v, raw); err != nil {
			return err
		}
	}
	return nil
}

func appendString(b []byte, num protowire.Number, s string) []byte {
	if s == "" {
		return b
	}
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendString(b, s)
}

func appendStrings(b []byte, num protowire.Number, ss []string) []byte {
	for _, s := range ss {
		b = protowire.AppendTag(b, num, protowire.BytesType)
		b = protowire.AppendString(b, s)
	}
	return b
}

func appendBool(b []byte, num protowire.Number, v bool) []byte {
	if !v {
		return b
	}
	b = protowire.AppendTag(b, num, protowire.VarintType)
	return protowire.AppendVarint(b, 1)
}

func appendVarint(b []byte, num protowire.Number, v uint64) []byte {
	if v == 0 {
		return b
	}
	b = protowire.AppendTag(b, num, protowire.VarintType)
	return protowire.AppendVarint(b, v)
}

func appendMessage(b []byte, num protowire.Number, m []byte) []byte {
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendBytes(b, m)
}

func appendMap(b []byte, num protowire.Number, m map[string]string) []byte {
	for _, k := range keys(m) {
		entry := appendString(appendString(nil, 1, k), 2, m[k])
		b = appendMessage(b, num, entry)
	}
	return b
}

func decodeMapEntry(raw []byte) (k, v string, err error) {
	err = fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		switch num {
		case 1:
			k = string(raw)
		case 2:
			v = string(raw)
		}
		return nil
	})
	return k, v, err
}

// ---- deviceplugin/v1beta1 ------------------------------------------------------------------------

// Empty is v1beta1.Empty.
type Empty struct{}

func (*Empty) marshal() []byte        { return nil }
func (*Empty) unmarshal([]byte) error { return nil }

// DevicePluginOptions is v1beta1.DevicePluginOptions.
type DevicePluginOptions struct {
	PreStartRequired                bool
	GetPreferredAllocationAvailable bool
}

func (m *DevicePluginOptions) marshal() []byte {
	return appendBool(appendBool(nil, 1, m.PreStartRequired), 2, m.GetPreferredAllocationAvailable)
}

func (m *DevicePluginOptions) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, v uint64, _ []byte) error {
		switch num {
		case 1:
			m.PreStartRequired = v != 0
		case 2:
			m.GetPreferredAllocationAvailable = v != 0
		}
		return nil
	})
}

// RegisterRequest is v1beta1.RegisterRequest.
type RegisterRequest struct {
	Version      string
	Endpoint     string
	ResourceName string
	Options      *DevicePluginOptions
}

func (m *RegisterRequest) marshal() []byte {
	b := appendString(nil, 1, m.Version)
	b = appendString(b, 2, m.Endpoint)
	b = appendString(b, 3, m.ResourceName)
	if m.Options != nil {
		b = appendMessage(b, 4, m.Options.marshal())
	}
	return b
}

func (m *RegisterRequest) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		switch num {
		case 1:
			m.Version = string(raw)
		case 2:
			m.Endpoint = string(raw)
		case 3:
			m.ResourceName = string(raw)
		case 4:
			m.Options = &DevicePluginOptions{}
			return m.Options.unmarshal(raw)
		}
		return nil
	})
}

// Device is v1beta1.Device; NUMA lists TopologyInfo's nodes.
type Device struct {
	ID     string
	Health string
	NUMA   []int64
}

// Device health values.
const (
	Healthy   = "Healthy"
	Unhealthy = "Unhealthy"
)

func (m *Device) marshal() []byte {
	b := appendString(nil, 1, m.ID)
	b = appendString(b, 2, m.Health)
	if len(m.NUMA) > 0 {
		var topo []byte
		for _, n := range m.NUMA {
			// NUMANode{int64 ID = 1}; node 0 is the empty message.
			topo = appendMessage(topo, 1, appendVarint(nil, 1, uint64(n)))
		}
		b = appendMessage(b, 3, topo)
	}
	return b
}

func (m *Device) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		switch num {
		case 1:
			m.ID = string(raw)
		case 2:
			m.Health = string(raw)
		case 3:
			return fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, node []byte) error {
				if num != 1 {
					return nil
				}
				var id int64
				err := fields(node, func(num protowire.Number, _ protowire.Type, v uint64, _ []byte) error {
					if num == 1 {
						id = int64(v)
					}
					return nil
				})
				m.NUMA = append(m.NUMA, id)
				return err
			})
		}
		return nil
	})
}

// ListAndWatchResponse is v1beta1.ListAndWatchResponse.
type ListAndWatchResponse struct {
	Devices []*Device
}

func (m *ListAndWatchResponse) marshal() []byte {
	var b []byte
	for _, d := range m.Devices {
		b = appendMessage(b, 1, d.marshal())
	}
	return b
}

func (m *ListAndWatchResponse) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		d := &Device{}
		m.Devices = append(m.Devices, d)
		return d.unmarshal(raw)
	})
}

// ContainerPreferredAllocationRequest is one container's GetPreferredAllocation question.
type ContainerPreferredAllocationRequest struct {
	AvailableDeviceIDs   []string
	MustIncludeDeviceIDs []string
	AllocationSize       int32
}

// PreferredAllocationRequest is v1beta1.PreferredAllocationRequest.
type PreferredAllocationRequest struct {
	ContainerRequests []*ContainerPreferredAllocationRequest
}

func (m *PreferredAllocationRequest) marshal() []byte {
	var b []byte
	for _, r := range m.ContainerRequests {
		c := appendStrings(nil, 1, r.AvailableDeviceIDs)
		c = appendStrings(c, 2, r.MustIncludeDeviceIDs)
		c = appendVarint(c, 3, uint64(uint32(r.AllocationSize)))
		b = appendMessage(b, 1, c)
	}
	return b
}

func (m *PreferredAllocationRequest) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		r := &ContainerPreferredAllocationRequest{}
		m.ContainerRequests = append(m.ContainerRequests, r)
		return fields(raw, func(num protowire.Number, _ protowire.Type, v uint64, s []byte) error {
			switch num {
			case 1:
				r.AvailableDeviceIDs = append(r.AvailableDeviceIDs, string(s))
			case 2:
				r.MustIncludeDeviceIDs = append(r.MustIncludeDeviceIDs, string(s))
			case 3:
				r.AllocationSize = int32(v)
			}
			return nil
		})
	})
}

// PreferredAllocationResponse is v1beta1.PreferredAllocationResponse: one device list per container.
type PreferredAllocationResponse struct {
	ContainerResponses [][]string
}

func (m *PreferredAllocationResponse) marshal() []byte {
	var b []byte
	for _, ids := range m.ContainerResponses {
		b = appendMessage(b, 1, appendStrings(nil, 1, ids))
	}
	return b
}

func (m *PreferredAllocationResponse) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		var ids []string
		err := fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
			if num == 1 {
				ids = append(ids, string(s))
			}
			return nil
		})
		m.ContainerResponses = append(m.ContainerResponses, ids)
		return err
	})
}

// AllocateRequest is v1beta1.AllocateRequest: the device ids per container.
type AllocateRequest struct {
	ContainerRequests [][]string
}

func (m *AllocateRequest) marshal() []byte {
	var b []byte
	for _, ids := range m.ContainerRequests {
		b = appendMessage(b, 1, appendStrings(nil, 1, ids))
	}
	return b
}

func (m *AllocateRequest) unmarshal(b []byte) error {
	r := &PreferredAllocationResponse{}
	if err := r.unmarshal(b); err != nil {
		return err
	}
	m.ContainerRequests = r.ContainerResponses
	return nil
}

// ContainerAllocateResponse is v1beta1.ContainerAllocateResponse (no mounts or device nodes: bcd
// answers with CDI devices, environment and annotations).
type ContainerAllocateResponse struct {
	Envs        map[string]string
	Annotations map[string]string
	CDIDevices  []string
}

// AllocateResponse is v1beta1.AllocateResponse.
type AllocateResponse struct {
	ContainerResponses []*ContainerAllocateResponse
}

func (m *AllocateResponse) marshal() []byte {
	var b []byte
	for _, r := range m.ContainerResponses {
		c := appendMap(nil, 1, r.Envs)
		c = appendMap(c, 4, r.Annotations)
		for _, name := range r.CDIDevices {
			c = appendMessage(c, 5, appendString(nil, 1, name))
		}
		b = appendMessage(b, 1, c)
	}
	return b
}

func (m *AllocateResponse) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		r := &ContainerAllocateResponse{Envs: map[string]string{}, Annotations: map[string]string{}}
		m.ContainerResponses = append(m.ContainerResponses, r)
		return fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
			switch num {
			case 1, 4:
				k, v, err := decodeMapEntry(raw)
				if num == 1 {
					r.Envs[k] = v
				} else {
					r.Annotations[k] = v
				}
				return err
			case 5:
				return fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
					if num == 1 {
						r.CDIDevices = append(r.CDIDevices, string(s))
					}
					return nil
				})
			}
			return nil
		})
	})
}

// PreStartContainerRequest is v1beta1.PreStartContainerRequest (bcd does not ask for it).
type PreStartContainerRequest struct{ DevicesIDs []string }

func (m *PreStartContainerRequest) marshal() []byte { return appendStrings(nil, 1, m.DevicesIDs) }
func (m *PreStartContainerRequest) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
		if num == 1 {
			m.DevicesIDs = append(m.DevicesIDs, string(s))
		}
		return nil
	})
}

// PreStartContainerResponse is v1beta1.PreStartContainerResponse.
type PreStartContainerResponse struct{}

func (*PreStartContainerResponse) marshal() []byte        { return nil }
func (*PreStartContainerResponse) unmarshal([]byte) error { return nil }

// ---- podresources/v1 -----------------------------------------------------------------------------

// ListPodResourcesRequest is v1.ListPodResourcesRequest.
type ListPodResourcesRequest struct{}

func (*ListPodResourcesRequest) marshal() []byte        { return nil }
func (*ListPodResourcesRequest) unmarshal([]byte) error { return nil }

// PodResources is one pod: its containers' devices by resource.
type PodResources struct {
	Name, Namespace string
	Containers      []ContainerResources
}

// ContainerResources is one container's devices.
type ContainerResources struct {
	Name    string
	Devices []ContainerDevices
}

// ContainerDevices is v1.ContainerDevices.
type ContainerDevices struct {
	ResourceName string
	DeviceIDs    []string
}

// ListPodResourcesResponse is v1.ListPodResourcesResponse.
type ListPodResourcesResponse struct {
	Pods []PodResources
}

func (m *ListPodResourcesResponse) marshal() []byte {
	var b []byte
	for _, p := range m.Pods {
		pb := appendString(appendString(nil, 1, p.Name), 2, p.Namespace)
		for _, c := range p.Containers {
			cb := appendString(nil, 1, c.Name)
			for _, d := range c.Devices {
				cb = appendMessage(cb, 2, appendStrings(appendString(nil, 1, d.ResourceName), 2, d.DeviceIDs))
			}
			pb = appendMessage(pb, 3, cb)
		}
		b = appendMessage(b, 1, pb)
	}
	return b
}

func (m *ListPodResourcesResponse) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		var p PodResources
		err := fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
			switch num {
			case 1:
				p.Name = string(raw)
			case 2:
				p.Namespace = string(raw)
			case 3:
				var c ContainerResources
				err := fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
					switch num {
					case 1:
						c.Name = string(raw)
					case 2:
						var d ContainerDevices
						err := fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
							switch num {
							case 1:
								d.ResourceName = string(s)
							case 2:
								d.DeviceIDs = append(d.DeviceIDs, string(s))
							}
							return nil
						})
						c.Devices = append(c.Devices, d)
						return err
					}
					return nil
				})
				p.Containers = append(p.Containers, c)
				return err
			}
			return nil
		})
		m.Pods = append(m.Pods, p)
		return err
	})
}
