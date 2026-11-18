package main

// Optional one-hop Responses admission gate. No inference loop, no routing, no model,
// no automatic retries, and no credentials discovery. Authentication is forwarded
// only to the explicitly configured HTTPS destination; it is never journalled.
import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type GatePolicy struct {
	MaxRequestBytes     int64 `json:"maxRequestBytes"`
	MaxClientUnits      int64 `json:"maxClientUnits"`
	MaxRequests         int   `json:"maxRequests"`
	MaxResponseBytes    int64 `json:"maxResponseBytes"`
	OverheadReserve     int64 `json:"overheadReserve"`
	AllowObservedOpaque bool  `json:"allowObservedOpaque"`
}

func gateDefaults() GatePolicy {
	return GatePolicy{MaxRequestBytes: 192 << 10, MaxClientUnits: 48000, MaxRequests: 8, MaxResponseBytes: 16 << 20, OverheadReserve: 4096}
}

type Attempt struct {
	ID            string `json:"id"`
	Fingerprint   string `json:"fingerprint"`
	State         string `json:"state"`
	Started       string `json:"started"`
	Finished      string `json:"finished,omitempty"`
	RequestBytes  int64  `json:"requestBytes"`
	ClientUnits   int64  `json:"clientUnits"`
	HTTPStatus    int    `json:"httpStatus,omitempty"`
	ResponseBytes int64  `json:"responseBytes,omitempty"`
	InputTokens   *int64 `json:"inputTokens,omitempty"`
	OutputTokens  *int64 `json:"outputTokens,omitempty"`
	CachedTokens  *int64 `json:"cachedInputTokens,omitempty"`
	Reason        string `json:"reason,omitempty"`
}
type GateJournal struct {
	Task        string             `json:"task"`
	Policy      GatePolicy         `json:"policy"`
	Upstream    string             `json:"upstream"`
	Attempts    map[string]Attempt `json:"attempts"`
	Opaque      map[string]int64   `json:"opaqueOutputBounds"`
	Quarantined bool               `json:"quarantined"`
}
type RequestGate struct {
	mu        sync.Mutex
	Store     *Store
	Journal   GateJournal
	Path      string
	Upstream  *url.URL
	Token     string
	Transport http.RoundTripper
	release   func()
	active    bool
}

func newGate(store *Store, task, upstream string, p GatePolicy, allowLoopback bool) (*RequestGate, error) {
	if er := checkID(task); er != nil {
		return nil, er
	}
	u, er := url.Parse(upstream)
	if er != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("explicit fixed upstream URL required")
	}
	test := false
	if ip := net.ParseIP(u.Hostname()); ip != nil {
		test = ip.IsLoopback()
	}
	if u.Scheme != "https" && !(allowLoopback && test && u.Scheme == "http") {
		return nil, errors.New("upstream must be HTTPS; HTTP only for explicit loopback fixture")
	}
	if p.MaxRequests < 1 || p.MaxRequests > 100 || p.MaxRequestBytes < 1024 || p.MaxClientUnits < 4096 || p.MaxResponseBytes < 1024 {
		return nil, errors.New("invalid gate policy")
	}
	release, er := lockFile(filepath.Join(store.Root, "gates", task+".lock"))
	if er != nil {
		return nil, errors.New("task gate already owned by another process")
	}
	g := &RequestGate{Store: store, Path: filepath.Join(store.Root, "gates", task+".json"), Upstream: u, Token: uid("gate_"), release: release}
	g.Transport = &http.Transport{Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true, DialContext: (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 90 * time.Second, IdleConnTimeout: 90 * time.Second, DisableCompression: true}
	g.Journal = GateJournal{Task: task, Policy: p, Upstream: upstream, Attempts: map[string]Attempt{}, Opaque: map[string]int64{}}
	er = loadJSON(g.Path, &g.Journal, 8<<20)
	if er != nil && !os.IsNotExist(er) {
		release()
		return nil, er
	}
	if g.Journal.Task != task || g.Journal.Upstream != upstream || string(encoded(g.Journal.Policy)) != string(encoded(p)) {
		release()
		return nil, errors.New("existing task has different policy/upstream; no silent budget reset")
	}
	for k, a := range g.Journal.Attempts {
		if a.State == "in_flight" {
			a.State = "unknown"
			a.Reason = "gate restarted during request; automatic replay forbidden"
			g.Journal.Attempts[k] = a
		}
	}
	if er = atomicJSON(g.Path, g.Journal); er != nil {
		release()
		return nil, er
	}
	return g, nil
}
func (g *RequestGate) Close() {
	if g.release != nil {
		g.release()
		g.release = nil
	}
	if t, ok := g.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
}

type Admission struct {
	Fingerprint string
	Units       int64
	Bytes       int64
	Canonical   []byte
}

func measureRequest(b []byte, p GatePolicy, opaque map[string]int64) (Admission, error) {
	a := Admission{Bytes: int64(len(b))}
	if int64(len(b)) > p.MaxRequestBytes {
		return a, errors.New("REQUEST_BYTES_LIMIT")
	}
	var v map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if er := dec.Decode(&v); er != nil {
		return a, errors.New("invalid JSON")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return a, errors.New("multiple JSON values")
	}
	for _, k := range []string{"previous_response_id", "conversation", "prompt"} {
		if x, ok := v[k]; ok && x != nil && x != "" {
			return a, fmt.Errorf("UNKNOWN_CONTEXT: %s is not a full client input", k)
		}
	}
	// Protocol additions require explicit review rather than silently excluding fields.
	allowed := map[string]bool{"model": true, "instructions": true, "input": true, "tools": true, "tool_choice": true, "parallel_tool_calls": true, "reasoning": true, "store": true, "stream": true, "stream_options": true, "include": true, "service_tier": true, "prompt_cache_key": true, "prompt_cache_options": true, "text": true, "metadata": true, "client_metadata": true, "max_output_tokens": true, "temperature": true, "top_p": true, "truncation": true, "user": true, "safety_identifier": true}
	for k := range v {
		if !allowed[k] {
			return a, fmt.Errorf("UNREVIEWED_FIELD: %s", k)
		}
	}
	if v["stream"] != true {
		return a, errors.New("stream=true required for observed completion")
	}
	if _, ok := v["model"].(string); !ok {
		return a, errors.New("model required")
	}
	var measure func(any) (int64, error)
	measure = func(x any) (int64, error) {
		switch y := x.(type) {
		case string:
			return int64(len([]byte(y))), nil
		case []any:
			var n int64 = 32
			for _, z := range y {
				m, e := measure(z)
				if e != nil {
					return 0, e
				}
				n += m + 32
			}
			return n, nil
		case map[string]any:
			var n int64 = 128
			if t, ok := y["type"].(string); ok {
				switch t {
				case "input_image", "input_audio", "input_file", "item_reference", "compaction":
					return 0, fmt.Errorf("UNKNOWN_CONTEXT: unsupported %s", t)
				}
			}
			for k, z := range y {
				if z == nil {
					continue
				}
				if k == "encrypted_content" {
					if !p.AllowObservedOpaque {
						return 0, errors.New("UNKNOWN_CONTEXT: opaque context cannot be measured under strict default policy")
					}
					s, ok := z.(string)
					if !ok {
						return 0, errors.New("invalid opaque context")
					}
					bound, ok := opaque[digest([]byte(s))]
					if !ok {
						return 0, errors.New("UNKNOWN_CONTEXT: encrypted item not observed by this task gate")
					}
					n += bound + 128
					continue
				}
				if k == "image_url" || k == "file_id" || k == "file_url" || k == "audio" {
					return 0, errors.New("UNKNOWN_CONTEXT: non-text source")
				}
				m, e := measure(z)
				if e != nil {
					return 0, e
				}
				n += int64(len(k)) + m
			}
			return n, nil
		default:
			return 32, nil
		}
	}
	for _, k := range []string{"instructions", "input", "tools", "text"} {
		if v[k] != nil {
			n, e := measure(v[k])
			if e != nil {
				return a, e
			}
			a.Units += n
		}
	}
	a.Units += p.OverheadReserve
	if a.Units > p.MaxClientUnits {
		return a, fmt.Errorf("CLIENT_INPUT_LIMIT: %d > %d conservative client units (not measured model tokens)", a.Units, p.MaxClientUnits)
	}
	if tools, ok := v["tools"].([]any); ok {
		for _, t := range tools {
			m, ok := t.(map[string]any)
			if !ok || m["type"] != "function" {
				return a, errors.New("NONLOCAL_TOOL: only client function schemas accepted")
			}
		}
	}
	// Volatile telemetry/cache identifiers cannot turn a transport retry into new work.
	a.Canonical = encoded(v)
	delete(v, "client_metadata")
	delete(v, "metadata")
	delete(v, "prompt_cache_key")
	a.Fingerprint = digest(encoded(v))
	return a, nil
}
func gateError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"type": "studio_economy_guard", "code": code, "message": code + ". No automatic provider retry; inspect the local task journal."}})
}
func (g *RequestGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		gateError(w, 403, "BROWSER_ORIGIN_DENIED")
		return
	}
	prefix := "/" + g.Token + "/"
	if !strings.HasPrefix(r.URL.Path, prefix) || subtle.ConstantTimeCompare([]byte(strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0]), []byte(g.Token)) != 1 {
		gateError(w, 403, "LOCAL_CAPABILITY_REQUIRED")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, prefix)
	if path == "status" && r.Method == http.MethodGet {
		g.mu.Lock()
		b := encoded(g.Journal)
		g.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
		return
	}
	if path != "responses" || r.Method != "POST" || r.Header.Get("Upgrade") != "" {
		gateError(w, 400, "UNREVIEWED_ENDPOINT")
		return
	}
	if r.URL.RawQuery != "" {
		gateError(w, 400, "QUERY_NOT_ALLOWED")
		return
	}
	var reader io.Reader = io.LimitReader(r.Body, g.Journal.Policy.MaxRequestBytes+1)
	ce := r.Header.Get("Content-Encoding")
	if ce != "" && ce != "identity" {
		if ce != "gzip" {
			gateError(w, 400, "UNSUPPORTED_COMPRESSION")
			return
		}
		gz, er := gzip.NewReader(reader)
		if er != nil {
			gateError(w, 400, "BAD_GZIP")
			return
		}
		defer gz.Close()
		reader = gz
	}
	b, er := io.ReadAll(io.LimitReader(reader, g.Journal.Policy.MaxRequestBytes+1))
	if er != nil {
		gateError(w, 400, "BODY_READ_FAILED")
		return
	}
	g.mu.Lock()
	ad, er := measureRequest(b, g.Journal.Policy, g.Journal.Opaque)
	if er != nil {
		g.mu.Unlock()
		gateError(w, 413, er.Error())
		return
	}
	if g.Journal.Quarantined {
		g.mu.Unlock()
		gateError(w, 409, "TASK_QUARANTINED")
		return
	}
	if _, ok := g.Journal.Attempts[ad.Fingerprint]; ok {
		g.mu.Unlock()
		gateError(w, 409, "DUPLICATE_OR_UNKNOWN_OUTCOME")
		return
	}
	if g.active {
		g.mu.Unlock()
		gateError(w, 409, "TASK_IN_FLIGHT")
		return
	}
	for _, old := range g.Journal.Attempts {
		if old.State == "unknown" || old.State == "in_flight" {
			g.mu.Unlock()
			gateError(w, 409, "PREVIOUS_OUTCOME_UNKNOWN")
			return
		}
	}
	if len(g.Journal.Attempts) >= g.Journal.Policy.MaxRequests {
		g.mu.Unlock()
		gateError(w, 409, "TASK_REQUEST_BUDGET")
		return
	}
	releaseStorage, reserveErr := g.Store.reserve(g.Journal.Policy.MaxResponseBytes)
	if reserveErr != nil {
		g.mu.Unlock()
		gateError(w, 507, "RESPONSE_STORAGE_BUDGET")
		return
	}
	defer releaseStorage()
	a := Attempt{ID: uid("req_"), Fingerprint: ad.Fingerprint, State: "in_flight", Started: now(), RequestBytes: ad.Bytes, ClientUnits: ad.Units}
	g.Journal.Attempts[ad.Fingerprint] = a
	if er = atomicJSON(g.Path, g.Journal); er != nil {
		delete(g.Journal.Attempts, ad.Fingerprint)
		g.mu.Unlock()
		gateError(w, 507, "JOURNAL_UNAVAILABLE")
		return
	}
	g.active = true
	g.mu.Unlock()
	defer func() { g.mu.Lock(); g.active = false; g.mu.Unlock() }()
	finish := func(state, reason string, status int, n int64, usage *responseObservation) {
		g.mu.Lock()
		defer g.mu.Unlock()
		a.State = state
		a.Finished = now()
		a.Reason = reason
		a.HTTPStatus = status
		a.ResponseBytes = n
		if usage != nil {
			a.InputTokens = usage.Input
			a.OutputTokens = usage.Output
			a.CachedTokens = usage.Cached
			if usage.Output != nil {
				for _, s := range usage.Opaque {
					g.Journal.Opaque[digest([]byte(s))] = *usage.Output
				}
			}
			if usage.Input != nil && *usage.Input > g.Journal.Policy.MaxClientUnits {
				g.Journal.Quarantined = true
				a.Reason = "server-reported input exceeded local estimate; quarantine"
			}
		}
		g.Journal.Attempts[ad.Fingerprint] = a
		if err := atomicJSON(g.Path, g.Journal); err != nil {
			g.Journal.Quarantined = true
		}
	}
	u := *g.Upstream
	u.Path = strings.TrimRight(u.Path, "/") + "/responses"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	req, er := http.NewRequestWithContext(ctx, "POST", u.String(), bytes.NewReader(ad.Canonical))
	if er != nil {
		finish("unknown", "local request build failure", 0, 0, nil)
		gateError(w, 502, "REQUEST_BUILD_FAILED")
		return
	}
	req.GetBody = nil // even the HTTP transport may not replay POST.
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Accept-Encoding", "identity")
	for _, k := range []string{"Authorization", "Chatgpt-Account-Id", "OpenAI-Organization", "OpenAI-Project", "OpenAI-Beta", "originator", "version", "session_id", "conversation_id", "x-codex-turn-state", "x-codex-turn-metadata", "x-codex-installation-id", "x-codex-routing-hint"} {
		if v := r.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, er := g.Transport.RoundTrip(req)
	if er != nil {
		finish("unknown", "transport failure; request may have reached provider", 0, 0, nil)
		gateError(w, 502, "UPSTREAM_OUTCOME_UNKNOWN")
		return
	}
	defer resp.Body.Close()
	// Never follow redirects: authentication must not leave the configured destination.
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		finish("rejected", "redirect refused", resp.StatusCode, 0, nil)
		gateError(w, 502, "REDIRECT_REFUSED")
		return
	}
	responsePath := filepath.Join(g.Store.Root, "gates", a.ID+".sse")
	f, er := os.OpenFile(responsePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if er != nil {
		finish("unknown", "cannot persist response", resp.StatusCode, 0, nil)
		gateError(w, 507, "RESPONSE_STORE_FAILED")
		return
	}
	defer f.Close()
	for _, k := range []string{"Content-Type", "x-request-id", "x-codex-turn-state", "Retry-After"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	obs := &responseObservation{}
	buf := make([]byte, 16384)
	var total int64
	writeOK := true
	reason := "stream ended without response.completed"
	state := "unknown"
	for {
		n, re := resp.Body.Read(buf)
		if n > 0 {
			if total+int64(n) > g.Journal.Policy.MaxResponseBytes {
				reason = "response storage limit"
				break
			}
			if _, e := f.Write(buf[:n]); e != nil {
				reason = "response write failed"
				break
			}
			total += int64(n)
			obs.Feed(buf[:n])
			if writeOK {
				if _, e := w.Write(buf[:n]); e != nil {
					writeOK = false
				} else if fl, ok := w.(http.Flusher); ok {
					fl.Flush()
				}
			}
		}
		if re != nil {
			if re == io.EOF {
				if resp.StatusCode >= 400 {
					state = "rejected"
					reason = "HTTP error, no automatic retry"
				} else if obs.Completed {
					state = "completed"
					reason = "terminal provider event saved"
				}
			} else {
				reason = "stream interrupted"
			}
			break
		}
	}
	if er = f.Sync(); er != nil {
		state = "unknown"
		reason = "response fsync failed"
	}
	finish(state, reason, resp.StatusCode, total, obs)
}

type responseObservation struct {
	carry                 []byte
	Completed             bool
	Input, Output, Cached *int64
	Opaque                []string
	Malformed             bool
}

func (o *responseObservation) Feed(b []byte) {
	o.carry = append(o.carry, b...)
	for {
		idx := bytes.IndexByte(o.carry, '\n')
		if idx < 0 {
			break
		}
		line := bytes.TrimSpace(o.carry[:idx])
		o.carry = o.carry[idx+1:]
		if bytes.HasPrefix(line, []byte("data:")) {
			o.frame(bytes.TrimSpace(line[5:]))
		}
	}
	if len(o.carry) > 1<<20 {
		o.Malformed = true
		o.carry = nil
	}
}
func (o *responseObservation) frame(b []byte) {
	var v struct {
		Type     string `json:"type"`
		Response struct {
			Status string `json:"status"`
			Usage  struct {
				Input   *int64 `json:"input_tokens"`
				Output  *int64 `json:"output_tokens"`
				Details struct {
					Cached *int64 `json:"cached_tokens"`
				} `json:"input_tokens_details"`
			} `json:"usage"`
			Output []struct {
				Encrypted string `json:"encrypted_content"`
			} `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(b, &v) != nil {
		return
	}
	if v.Type == "response.completed" && v.Response.Status == "completed" && !o.Malformed {
		o.Completed = true
		o.Input = v.Response.Usage.Input
		o.Output = v.Response.Usage.Output
		if o.Output != nil && (*o.Output < 0 || *o.Output > 10000000) {
			o.Output = nil
			o.Malformed = true
			o.Completed = false
		}
		o.Cached = v.Response.Usage.Details.Cached
		for _, x := range v.Response.Output {
			if x.Encrypted != "" {
				o.Opaque = append(o.Opaque, x.Encrypted)
			}
		}
	}
}
