package kube

import (
	"google.golang.org/protobuf/encoding/protowire"
)

// The kubelet's DRA messages, hand-encoded like wire.go: pluginregistration/v1 (the registrar the
// kubelet watches in plugins_registry) and dra/v1 (dra/v1beta1 is field-for-field the same, bar
// v1's share_id, which bcd never sets).

// PluginInfo types and the DRA services bcd implements (k8s.io/kubelet pluginregistration and
// dra/v1 constants).
const (
	pluginTypeDRA        = "DRAPlugin"
	draServiceV1         = "v1.DRAPlugin"
	draServiceV1beta1    = "v1beta1.DRAPlugin"
	procGetInfo          = "/pluginregistration.Registration/GetInfo"
	procNotifyRegistered = "/pluginregistration.Registration/NotifyRegistrationStatus"
	procPrepareV1        = "/k8s.io.kubelet.pkg.apis.dra.v1.DRAPlugin/NodePrepareResources"
	procUnprepareV1      = "/k8s.io.kubelet.pkg.apis.dra.v1.DRAPlugin/NodeUnprepareResources"
	procPrepareV1beta1   = "/k8s.io.kubelet.pkg.apis.dra.v1beta1.DRAPlugin/NodePrepareResources"
	procUnprepareV1beta1 = "/k8s.io.kubelet.pkg.apis.dra.v1beta1.DRAPlugin/NodeUnprepareResources"
)

// InfoRequest is pluginregistration.InfoRequest.
type InfoRequest struct{}

func (*InfoRequest) marshal() []byte        { return nil }
func (*InfoRequest) unmarshal([]byte) error { return nil }

// PluginInfo is pluginregistration.PluginInfo.
type PluginInfo struct {
	Type, Name, Endpoint string
	SupportedVersions    []string
}

func (m *PluginInfo) marshal() []byte {
	b := appendString(nil, 1, m.Type)
	b = appendString(b, 2, m.Name)
	b = appendString(b, 3, m.Endpoint)
	return appendStrings(b, 4, m.SupportedVersions)
}

func (m *PluginInfo) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		switch num {
		case 1:
			m.Type = string(raw)
		case 2:
			m.Name = string(raw)
		case 3:
			m.Endpoint = string(raw)
		case 4:
			m.SupportedVersions = append(m.SupportedVersions, string(raw))
		}
		return nil
	})
}

// RegistrationStatus is pluginregistration.RegistrationStatus.
type RegistrationStatus struct {
	PluginRegistered bool
	Error            string
}

func (m *RegistrationStatus) marshal() []byte {
	return appendString(appendBool(nil, 1, m.PluginRegistered), 2, m.Error)
}

func (m *RegistrationStatus) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, v uint64, raw []byte) error {
		switch num {
		case 1:
			m.PluginRegistered = v != 0
		case 2:
			m.Error = string(raw)
		}
		return nil
	})
}

// RegistrationStatusResponse is pluginregistration.RegistrationStatusResponse.
type RegistrationStatusResponse struct{}

func (*RegistrationStatusResponse) marshal() []byte        { return nil }
func (*RegistrationStatusResponse) unmarshal([]byte) error { return nil }

// Claim is dra.Claim.
type Claim struct{ Namespace, UID, Name string }

func (c Claim) marshal() []byte {
	return appendString(appendString(appendString(nil, 1, c.Namespace), 2, c.UID), 3, c.Name)
}

func unmarshalClaim(b []byte) (Claim, error) {
	var c Claim
	err := fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		switch num {
		case 1:
			c.Namespace = string(raw)
		case 2:
			c.UID = string(raw)
		case 3:
			c.Name = string(raw)
		}
		return nil
	})
	return c, err
}

// ClaimsRequest is dra.NodePrepareResourcesRequest and NodeUnprepareResourcesRequest.
type ClaimsRequest struct{ Claims []Claim }

func (m *ClaimsRequest) marshal() []byte {
	var b []byte
	for _, c := range m.Claims {
		b = appendMessage(b, 1, c.marshal())
	}
	return b
}

func (m *ClaimsRequest) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		c, err := unmarshalClaim(raw)
		m.Claims = append(m.Claims, c)
		return err
	})
}

// PreparedDevice is dra.Device.
type PreparedDevice struct {
	RequestNames         []string
	PoolName, DeviceName string
	CDIDeviceIDs         []string
}

func (d PreparedDevice) marshal() []byte {
	b := appendStrings(nil, 1, d.RequestNames)
	b = appendString(b, 2, d.PoolName)
	b = appendString(b, 3, d.DeviceName)
	return appendStrings(b, 4, d.CDIDeviceIDs)
}

// ClaimResult is dra.NodePrepareResourceResponse (and, with no devices, NodeUnprepareResourceResponse).
type ClaimResult struct {
	Devices []PreparedDevice
	Error   string
}

// PrepareResponse is dra.NodePrepareResourcesResponse: results by claim UID.
type PrepareResponse struct{ Claims map[string]ClaimResult }

func (m *PrepareResponse) marshal() []byte {
	var b []byte
	for _, uid := range keys(m.Claims) {
		r := m.Claims[uid]
		var v []byte
		for _, d := range r.Devices {
			v = appendMessage(v, 1, d.marshal())
		}
		v = appendString(v, 2, r.Error)
		b = appendMessage(b, 1, appendMessage(appendString(nil, 1, uid), 2, v))
	}
	return b
}

func (m *PrepareResponse) unmarshal(b []byte) error {
	m.Claims = map[string]ClaimResult{}
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, entry []byte) error {
		if num != 1 {
			return nil
		}
		var uid string
		var r ClaimResult
		err := fields(entry, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
			switch num {
			case 1:
				uid = string(raw)
			case 2:
				return fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
					switch num {
					case 1:
						var d PreparedDevice
						err := fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
							switch num {
							case 1:
								d.RequestNames = append(d.RequestNames, string(s))
							case 2:
								d.PoolName = string(s)
							case 3:
								d.DeviceName = string(s)
							case 4:
								d.CDIDeviceIDs = append(d.CDIDeviceIDs, string(s))
							}
							return nil
						})
						r.Devices = append(r.Devices, d)
						return err
					case 2:
						r.Error = string(raw)
					}
					return nil
				})
			}
			return nil
		})
		m.Claims[uid] = r
		return err
	})
}

// UnprepareResponse is dra.NodeUnprepareResourcesResponse: an error (or none) by claim UID.
type UnprepareResponse struct{ Claims map[string]string }

func (m *UnprepareResponse) marshal() []byte {
	var b []byte
	for _, uid := range keys(m.Claims) {
		b = appendMessage(b, 1, appendMessage(appendString(nil, 1, uid), 2, appendString(nil, 1, m.Claims[uid])))
	}
	return b
}

func (m *UnprepareResponse) unmarshal(b []byte) error {
	m.Claims = map[string]string{}
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, entry []byte) error {
		if num != 1 {
			return nil
		}
		var uid, msg string
		err := fields(entry, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
			switch num {
			case 1:
				uid = string(raw)
			case 2:
				return fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
					if num == 1 {
						msg = string(s)
					}
					return nil
				})
			}
			return nil
		})
		m.Claims[uid] = msg
		return err
	})
}
