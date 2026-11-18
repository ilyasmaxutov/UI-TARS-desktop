package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type preview struct {
	First     []string
	Last      []string
	Findings  []string
	carry     string
	Lines     int
	LongLines int
}

func (p *preview) add(line string) {
	p.Lines++
	s := cut(line, 512)
	if len(p.First) < 5 {
		p.First = append(p.First, s)
	}
	p.Last = append(p.Last, s)
	if len(p.Last) > 7 {
		p.Last = p.Last[1:]
	}
	lower := strings.ToLower(line)
	if strings.Contains(lower, "error") || strings.Contains(lower, "fail") || strings.Contains(lower, "exception") {
		if len(p.Findings) < 12 {
			p.Findings = append(p.Findings, fmt.Sprintf("L%d %s", p.Lines, s))
		}
	}
}
func (p *preview) write(b []byte) {
	for len(b) > 0 {
		i := bytes.IndexByte(b, '\n')
		if i < 0 {
			p.carry += string(b)
			if len(p.carry) > 4096 {
				p.add(p.carry[:4096] + " [long line fragment]")
				p.carry = ""
				p.LongLines++
			}
			return
		}
		p.add(p.carry + string(b[:i]))
		p.carry = ""
		b = b[i+1:]
	}
}
func (p *preview) end() {
	if p.carry != "" {
		p.add(p.carry)
		p.carry = ""
	}
}

type captureSink struct {
	mu           sync.Mutex
	f            map[string]*os.File
	hashes       map[string]hash.Hash
	size         map[string]int64
	previews     map[string]*preview
	limit, total int64
	limited      bool
	writeErr     error
	cancel       context.CancelFunc
}
type streamSink struct {
	c    *captureSink
	name string
}

func (w streamSink) Write(b []byte) (int, error) {
	c := w.c
	c.mu.Lock()
	defer c.mu.Unlock()
	original := len(b)
	if c.limited || c.writeErr != nil {
		return original, nil
	}
	if c.total+int64(len(b)) > c.limit {
		b = b[:c.limit-c.total]
		c.limited = true
	}
	if len(b) > 0 {
		n, e := c.f[w.name].Write(b)
		c.hashes[w.name].Write(b[:n])
		c.previews[w.name].write(b[:n])
		c.size[w.name] += int64(n)
		c.total += int64(n)
		if e != nil {
			c.writeErr = e
		}
	}
	if c.limited || c.writeErr != nil {
		c.cancel()
	}
	return original, nil
}
func (e *Engine) capture(ctx context.Context, spec CheckSpec) (Artifact, error) {
	var a Artifact
	if !filepath.IsAbs(spec.Program) {
		return a, errors.New("approved executable must be an absolute path")
	}
	st, err := os.Stat(spec.Program)
	if err != nil || !st.Mode().IsRegular() {
		return a, errors.New("approved executable not found")
	}
	if spec.TimeoutSeconds <= 0 {
		spec.TimeoutSeconds = 60
	}
	if spec.TimeoutSeconds > 600 {
		return a, errors.New("check timeout >600s denied")
	}
	if len(spec.Args) > 64 || len(encoded(spec.Args)) > 16384 {
		return a, errors.New("arguments exceed limit")
	}
	id, dir, err := e.Store.reserveDir()
	if err != nil {
		return a, err
	}
	a = Artifact{ID: id, Kind: "capture", Created: now(), Files: map[string]FileSeal{}}
	// Reserve the maximum capture before executing; other artifacts cannot silently consume it.
	release, err := e.Store.reserve(e.Limits.CaptureBytes)
	if err != nil {
		return a, err
	}
	defer release()
	runctx, cancel := context.WithTimeout(ctx, time.Duration(spec.TimeoutSeconds)*time.Second)
	defer cancel()
	c := &captureSink{f: map[string]*os.File{}, hashes: map[string]hash.Hash{}, size: map[string]int64{}, previews: map[string]*preview{}, limit: e.Limits.CaptureBytes, cancel: cancel}
	for _, name := range []string{"stdout.log", "stderr.log"} {
		f, er := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if er != nil {
			for _, ff := range c.f {
				ff.Close()
			}
			return a, er
		}
		c.f[name] = f
		c.hashes[name] = sha256.New()
		c.previews[name] = &preview{}
	}
	cmd := exec.CommandContext(runctx, spec.Program, spec.Args...)
	cmd.Dir = e.Root
	cmd.Stdin = nil
	cmd.Stdout = streamSink{c, "stdout.log"}
	cmd.Stderr = streamSink{c, "stderr.log"}
	cmd.WaitDelay = 2 * time.Second
	configureProcess(cmd)
	start := time.Now()
	err = cmd.Run()
	reason := ""
	if err != nil {
		reason = cut(err.Error(), 256)
	}
	if c.limited {
		reason = "capture_limit; process cancellation requested"
	}
	if c.writeErr != nil {
		reason = "capture_write_failed"
	}
	if runctx.Err() != nil && !c.limited {
		reason = "cancelled_or_timed_out"
	}
	var exit *int
	if cmd.ProcessState != nil {
		x := cmd.ProcessState.ExitCode()
		exit = &x
	}
	a.Complete = !c.limited && c.writeErr == nil && runctx.Err() == nil && !errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState != nil
	a.ExitCode = exit
	a.Reason = reason
	summaries := []string{}
	for _, name := range []string{"stdout.log", "stderr.log"} {
		f := c.f[name]
		if er := f.Sync(); er != nil {
			a.Complete = false
			a.Reason = "capture_sync_failed"
		}
		f.Close()
		p := c.previews[name]
		p.end()
		a.Files[name] = FileSeal{c.size[name], hex.EncodeToString(c.hashes[name].Sum(nil))}
		summaries = append(summaries, fmt.Sprintf("%s: %d bytes; head=%q; findings=%q; tail=%q; longLineFragments=%d", name, c.size[name], p.First, p.Findings, p.Last, p.LongLines))
	}
	a.Summary = fmt.Sprintf("artifact=%s exit=%v captureComplete=%t reason=%s durationMs=%d\n%s", id, exitText(exit), a.Complete, reason, time.Since(start).Milliseconds(), strings.Join(summaries, "\n"))
	a.Summary = cut(a.Summary, MaxItemBytes)
	if er := atomicJSON(filepath.Join(dir, "manifest.json"), a); er != nil {
		return a, er
	}
	return a, nil
}
func exitText(x *int) any {
	if x == nil {
		return "unknown"
	}
	return *x
}

var _ io.Writer = streamSink{}
