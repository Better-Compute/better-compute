package aws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// DefaultSpotInterval is how often a spot instance polls for its interruption notice (AWS gives two
// minutes' warning).
const DefaultSpotInterval = 5 * time.Second

const spotActionPath = "/latest/meta-data/spot/instance-action"

// SpotNotice is a spot interruption notice: AWS will terminate, stop or hibernate the instance at
// Time.
type SpotNotice struct {
	Action string
	Time   time.Time
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

// SpotAction reads the interruption notice; nil when there is none (404).
func (c *Client) SpotAction(ctx context.Context) (*SpotNotice, error) {
	raw, err := c.Get(ctx, spotActionPath)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ParseSpotNotice(raw)
}

// WatchSpot polls the interruption notice every interval (DefaultSpotInterval when 0) until ctx
// ends, and calls notify when it changes: a notice when one appears (or its action or time
// changes), nil when it is withdrawn. A read that fails changes nothing (the last answer stands).
func (c *Client) WatchSpot(ctx context.Context, interval time.Duration, notify func(*SpotNotice)) {
	if interval <= 0 {
		interval = DefaultSpotInterval
	}
	var last *SpotNotice
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		n, err := c.SpotAction(ctx)
		if err == nil && !sameNotice(last, n) {
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

func sameNotice(a, b *SpotNotice) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Action == b.Action && a.Time.Equal(b.Time)
}
