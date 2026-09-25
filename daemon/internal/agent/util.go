package agent

import (
	"fmt"

	"google.golang.org/protobuf/proto"
)

var deterministic = proto.MarshalOptions{Deterministic: true}

func marshal(m proto.Message) ([]byte, error) { return deterministic.Marshal(m) }

func unmarshal(b []byte, m proto.Message) error { return proto.Unmarshal(b, m) }

func fmtType(v any) string { return fmt.Sprintf("%T", v) }
