package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type PacketJournal struct {
	Version     string                     `json:"version"`
	ID          string                     `json:"id"`
	Fingerprint string                     `json:"fingerprint"`
	Results     map[string]Result          `json:"results"`
	Data        map[string]json.RawMessage `json:"-"`
	Started     string                     `json:"started"`
	Updated     string                     `json:"updated"`
}

func validatePacket(p Packet) error {
	if er := checkID(p.ID); er != nil {
		return er
	}
	if len(p.Operations) < 1 || len(p.Operations) > MaxOps {
		return errors.New("packet requires 1..32 operations")
	}
	ids := map[string]Operation{}
	for _, op := range p.Operations {
		if er := checkID(op.ID); er != nil {
			return er
		}
		if _, yes := ids[op.ID]; yes {
			return errors.New("duplicate operation id")
		}
		switch op.Op {
		case "files", "read", "read_bytes", "search", "read_matches", "inspect", "metadata", "hash", "check", "git_status", "git_diff":
		default:
			return errors.New("unsupported op")
		}
		if op.From != "" {
			op.Depends = append(op.Depends, op.From)
		}
		ids[op.ID] = op
	}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if visiting[id] {
			return errors.New("dependency cycle")
		}
		if done[id] {
			return nil
		}
		op, ok := ids[id]
		if !ok {
			return errors.New("missing dependency")
		}
		visiting[id] = true
		for _, dep := range op.Depends {
			if er := visit(dep); er != nil {
				return er
			}
		}
		visiting[id] = false
		done[id] = true
		return nil
	}
	for id := range ids {
		if er := visit(id); er != nil {
			return er
		}
	}
	return nil
}
func (e *Engine) batch(ctx context.Context, p Packet) (Envelope, error) {
	if err := validatePacket(p); err != nil {
		return Envelope{}, err
	}
	unlock, err := lockFile(filepath.Join(e.Store.Root, "operations.lock"))
	if err != nil {
		return Envelope{}, errors.New("another packet is executing; wait locally, do not launch a duplicate")
	}
	defer unlock()
	return e.batchLocked(ctx, p)
}

// Caller holds operations.lock, including snapshot boundaries for research.
func (e *Engine) batchLocked(ctx context.Context, p Packet) (Envelope, error) {
	var err error
	journalPath := filepath.Join(e.Store.Root, "packets", p.ID+".json")
	fp := digest(encoded(map[string]any{"packet": p, "root": e.Root, "checks": e.Checks, "version": Version}))
	j := PacketJournal{Version: Version, ID: p.ID, Fingerprint: fp, Results: map[string]Result{}, Data: map[string]json.RawMessage{}, Started: now()}
	existed := false
	if err = loadJSON(journalPath, &j, 8<<20); err == nil {
		existed = true
		if j.Data == nil {
			j.Data = map[string]json.RawMessage{}
		}
		if j.Version == "0.4.0" {
			priorFP := digest(encoded(map[string]any{"packet": p, "root": e.Root, "checks": e.Checks, "version": j.Version}))
			if j.Fingerprint != priorFP {
				return Envelope{}, errors.New("same packet ID with different input/root/policy")
			}
			// Preserve finished 0.4 snapshots. Never execute remaining operations
			// under changed code without a new explicitly authorized packet.
			if len(j.Results) != len(p.Operations) || hasRunning(j.Results) {
				return Envelope{}, errors.New("legacy packet unfinished: retained for read-only inspection; no automatic execution across upgrade")
			}
		} else if (j.Version != "" && j.Version != Version) || j.Fingerprint != fp {
			return Envelope{}, errors.New("same packet ID with different input/root/policy; use a new ID for a new operation")
		}
	} else if !os.IsNotExist(err) {
		return Envelope{}, err
	}
	save := func() error { j.Updated = now(); return atomicJSON(journalPath, j) }
	for id, r := range j.Results {
		r.Data = j.Data[id]
		if r.State == "running" {
			r.State = "unknown"
			r.Text = "Prior process stopped after dispatch. No automatic rerun; inspect artifacts or use a new explicit packet."
			j.Results[id] = r
		}
	}
	if err = save(); err != nil {
		return Envelope{}, err
	}
	for len(j.Results) < len(p.Operations) || hasRunning(j.Results) {
		ready := []Operation{}
		progress := false
		for _, op := range p.Operations {
			if _, ok := j.Results[op.ID]; ok {
				continue
			}
			deps := op.Depends
			if op.From != "" {
				deps = append(append([]string{}, deps...), op.From)
			}
			waiting, failed := false, false
			for _, id := range deps {
				r, ok := j.Results[id]
				if !ok || r.State == "running" {
					waiting = true
				} else if r.State != "completed" {
					failed = true
				}
			}
			if failed {
				j.Results[op.ID] = Result{ID: op.ID, Op: op.Op, State: "blocked", Text: "Dependency failed or its outcome is unknown; independent operations remain available."}
				progress = true
				continue
			}
			if !waiting && len(ready) < e.Limits.Parallel {
				if op.Op == "check" {
					if len(ready) == 0 {
						ready = append(ready, op)
					}
					break
				}
				ready = append(ready, op)
			}
		}
		if len(ready) == 0 {
			if progress {
				if err = save(); err != nil {
					return Envelope{}, err
				}
				continue
			}
			break
		}
		for _, op := range ready {
			j.Results[op.ID] = Result{ID: op.ID, Op: op.Op, State: "running", Text: "Dispatch persisted"}
		}
		if err = save(); err != nil {
			return Envelope{}, err
		}
		type done struct {
			r    Result
			data json.RawMessage
		}
		ch := make(chan done, len(ready))
		prior := map[string]Result{}
		for id, r := range j.Results {
			r.Data = j.Data[id]
			prior[id] = r
		}
		type promise struct {
			ready  chan struct{}
			result done
		}
		wave := map[string]*promise{}
		// No model between operations. Only finite independent I/O runs concurrently.
		for _, op := range ready {
			keyOp := op
			keyOp.ID = ""
			keyOp.Depends = nil
			key := string(encoded(keyOp))
			if cached, ok := wave[key]; ok && op.Op != "check" && op.Op != "git_status" && op.Op != "git_diff" {
				go func(op Operation, p *promise) {
					<-p.ready
					d := p.result
					d.r.ID = op.ID
					d.r.Reused = true
					d.r.DurationMS = 0
					ch <- d
				}(op, cached)
				continue
			}
			promiseValue := &promise{ready: make(chan struct{})}
			wave[key] = promiseValue
			go func(op Operation, promiseValue *promise) {
				start := time.Now()
				r := Result{ID: op.ID, Op: op.Op, State: "completed"}
				var data json.RawMessage
				if ctx.Err() != nil {
					r.State = "cancelled"
					r.Text = "Cancelled before execution"
				} else {
					text, v, er := e.execute(ctx, op, prior)
					if er != nil {
						r.State = "failed"
						r.Text = cut(er.Error(), 2048)
					} else {
						data = encoded(v)
						r.Text = cut(text, MaxItemBytes)
						r.OutputTruncated = len(text) > MaxItemBytes
						r.RawBytes = int64(len(data))
						if a, ok := v.(Artifact); ok {
							r.Artifact = a.ID
							if a.ExitCode == nil || *a.ExitCode != 0 || !a.Complete {
								r.State = "failed"
							}
						} else {
							id, se := e.Store.save(op.Op, data, text)
							if se != nil {
								r.State = "failed"
								r.Text = se.Error()
								data = nil
							} else {
								r.Artifact = id
							}
						}
					}
				}
				r.DurationMS = time.Since(start).Milliseconds()
				d := done{r, data}
				promiseValue.result = d
				close(promiseValue.ready)
				ch <- d
			}(op, promiseValue)
		}
		for range ready {
			d := <-ch
			j.Results[d.r.ID] = d.r
			j.Data[d.r.ID] = d.data
			if err = save(); err != nil {
				return Envelope{}, err
			}
		}
	}
	out := make([]Result, 0, len(p.Operations))
	for _, op := range p.Operations {
		r, ok := j.Results[op.ID]
		if !ok {
			return Envelope{}, fmt.Errorf("unresolved operation %s", op.ID)
		}
		out = append(out, r)
	}
	return envelope(p.ID, out, e.Limits.PacketBytes, existed)
}
func hasRunning(m map[string]Result) bool {
	for _, r := range m {
		if r.State == "running" {
			return true
		}
	}
	return false
}
