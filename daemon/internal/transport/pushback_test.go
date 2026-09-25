package transport

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
)

func TestPushback(t *testing.T) {
	refused := func(value string) error {
		e := connect.NewError(connect.CodeResourceExhausted, errors.New("handshake bucket empty"))
		if value != "" {
			e.Meta().Set(PushbackHeader, value)
		}
		return e
	}
	if d, ok := Pushback(refused("2750")); !ok || d != 2750*time.Millisecond {
		t.Fatalf("pushback = %v, %v", d, ok)
	}
	// Wrapped errors still carry it; a capped value keeps a daemon from staying away for good.
	if d, ok := Pushback(fmt.Errorf("agent: join: %w", refused("86400000"))); !ok || d != maxPushback {
		t.Fatalf("wrapped/capped pushback = %v, %v", d, ok)
	}
	for _, value := range []string{"", "-1", "soon", "1.5"} {
		if _, ok := Pushback(refused(value)); ok {
			t.Errorf("pushback %q was honoured", value)
		}
	}
	if _, ok := Pushback(errors.New("dial tcp: refused")); ok {
		t.Fatal("a transport error has no pushback")
	}
}
