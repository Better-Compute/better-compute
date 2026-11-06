package aws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// DefaultSpotInterval is how often a spot instance polls for its interruption notice (AWS gives two
// minutes' warning).
const DefaultSpotInterval = 5 * time.Second

// SpotWarning is the warning AWS gives before it interrupts a spot instance: the deadline of a
// notice whose time does not parse.
const SpotWarning = 2 * time.Minute

// UnknownSpotAction is the Action of a notice whose action is not terminate, stop or hibernate.
const UnknownSpotAction = "unknown"

const spotActionPath = "/latest/meta-data/spot/instance-action"

// SpotNotice is a spot interruption notice: AWS will terminate, stop or hibernate the instance at
// Time.
type SpotNotice struct {
	Action string
	Time   time.Time
	// Unparsed is why the served notice did not parse; nil for a well-formed one. The path exists
	// only once AWS has scheduled an interruption, so a notice that does not parse is still one:
	// Action is UnknownSpotAction when the action is not known, and Time is SpotWarning after the
	// notice was first seen when the time is not RFC 3339.
	Unparsed error
	// estimated: Time is SpotWarning after first sight, not AWS's.
	estimated bool
}

// ParseSpotNotice parses /latest/meta-data/spot/instance-action
// ({"action":"terminate","time":"2026-11-05T10:02:00Z"}).
func ParseSpotNotice(raw []byte) (*SpotNotice, error) {
	var v struct {
		Action string `json:"action"`
		Time   string `json:"time"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, errors.New("aws: the spot instance-action is not JSON")
	}
	switch v.Action {
	case "terminate", "stop", "hibernate":
	default:
		return nil, fmt.Errorf("aws: unknown spot action %.32q", v.Action)
	}
	at, err := time.Parse(time.RFC3339, v.Time)
	if err != nil {
		return nil, errors.New("aws: the spot instance-action has no time")
	}
	return &SpotNotice{Action: v.Action, Time: at.UTC()}, nil
}

// salvageSpotNotice is the notice a served body that ParseSpotNotice refused stands for: what of
// it parses, an unknown action and a deadline SpotWarning from now for the rest.
func salvageSpotNotice(raw []byte, now time.Time, why error) *SpotNotice {
	var v struct {
		Action string `json:"action"`
		Time   string `json:"time"`
	}
	_ = json.Unmarshal(raw, &v)
	n := &SpotNotice{Action: UnknownSpotAction, Unparsed: why}
	switch v.Action {
	case "terminate", "stop", "hibernate":
		n.Action = v.Action
	}
	if at, err := time.Parse(time.RFC3339, v.Time); err == nil {
		n.Time = at.UTC()
	} else {
		n.Time, n.estimated = now.Add(SpotWarning).UTC(), true
	}
	return n
}

// SpotAction reads the interruption notice; nil when there is none (404). An error is a failed
// read only: a served notice that does not parse is returned with Unparsed set (fail closed).
func (c *Client) SpotAction(ctx context.Context) (*SpotNotice, error) {
	raw, err := c.Get(ctx, spotActionPath)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n, err := ParseSpotNotice(raw)
	if err != nil {
		return salvageSpotNotice(raw, c.now(), err), nil
	}
	return n, nil
}

// WatchSpot polls the interruption notice every interval (DefaultSpotInterval when 0) until ctx
// ends, and calls notify when it changes: a notice when one appears (or its action or time
// changes), nil when it is withdrawn. A read that fails changes nothing (the last answer stands); a
// notice that does not parse is reported (see SpotNotice.Unparsed), its estimated deadline kept
// from first sight while it stays so.
func (c *Client) WatchSpot(ctx context.Context, interval time.Duration, notify func(*SpotNotice)) {
	if interval <= 0 {
		interval = DefaultSpotInterval
	}
	var last *SpotNotice
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		n, err := c.SpotAction(ctx)
		if err == nil && n != nil && n.estimated && last != nil && last.estimated && last.Action == n.Action {
			n.Time = last.Time
		}
		if err == nil && !sameNotice(last, n) {
			if n != nil && n.Unparsed != nil {
				c.logger().Warn("the spot interruption notice does not parse; reporting it anyway",
					"error", n.Unparsed.Error(), "action", n.Action, "deadline", n.Time.Format(time.RFC3339))
			}
			last = n
			notify(n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (c *Client) logger() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}

func sameNotice(a, b *SpotNotice) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Action == b.Action && a.Time.Equal(b.Time)
}
