package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func reqBody(s string) []byte {
	return encoded(map[string]any{"model": "test-fixture", "stream": true, "input": []any{map[string]any{"role": "user", "content": s}}})
}
func completed() string {
	return "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":70,\"output_tokens\":20,\"input_tokens_details\":{\"cached_tokens\":30}},\"output\":[]}}\n\n"
}
func testGate(t *testing.T, handler http.HandlerFunc) (*RequestGate, *httptest.Server, *int32) {
	t.Helper()
	n := new(int32)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { atomic.AddInt32(n, 1); handler(w, r) }))
	t.Cleanup(up.Close)
	e := testEngine(t)
	g, err := newGate(e.Store, "task", up.URL, gateDefaults(), true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Close)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	return g, server, n
}
func post(t *testing.T, g *RequestGate, s *httptest.Server, b []byte) (int, []byte) {
	t.Helper()
	r, err := http.Post(s.URL+"/"+g.Token+"/responses", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	v, _ := io.ReadAll(r.Body)
	return r.StatusCode, v
}
func TestGateRejects300kBeforeNetwork(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, completed()) })
	code, _ := post(t, g, s, reqBody(strings.Repeat("x", 300000)))
	if code != 413 || *n != 0 {
		t.Fatal(code, *n)
	}
}
func TestGateCountsToolSchemasAndInstructions(t *testing.T) {
	p := gateDefaults()
	for _, key := range []string{"instructions", "tools", "text"} {
		v := map[string]any{"model": "x", "stream": true, "input": "ok", key: strings.Repeat("x", 50000)}
		if _, err := measureRequest(encoded(v), p, nil); err == nil {
			t.Fatal(key)
		}
	}
}
func TestGateRejectsUnknownContext(t *testing.T) {
	for _, kv := range []map[string]any{{"previous_response_id": "resp_unknown"}, {"conversation": "c1"}, {"prompt": map[string]any{"id": "server-prompt"}}, {"input": []any{map[string]any{"type": "input_image", "image_url": "anything"}}}, {"input": []any{map[string]any{"type": "reasoning", "encrypted_content": "opaque"}}}} {
		v := map[string]any{"model": "x", "stream": true, "input": "text"}
		for k, x := range kv {
			v[k] = x
		}
		if _, err := measureRequest(encoded(v), gateDefaults(), nil); err == nil {
			t.Fatal(v)
		}
	}
}
func TestGateRejectsRemoteTools(t *testing.T) {
	b := encoded(map[string]any{"model": "x", "stream": true, "input": "x", "tools": []any{map[string]any{"type": "web_search"}}})
	if _, err := measureRequest(b, gateDefaults(), nil); err == nil {
		t.Fatal("remote tool allowed")
	}
}
func TestGateFullRequestWithinLimit(t *testing.T) {
	a, err := measureRequest(reqBody("Hello мир"), gateDefaults(), nil)
	if err != nil || a.Units < 4096 || len(a.Canonical) == 0 {
		t.Fatal(a, err)
	}
}
func TestGateNoDoubleSendAfterSuccess(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, completed())
	})
	b := reqBody("one")
	c, _ := post(t, g, s, b)
	c2, _ := post(t, g, s, b)
	if c != 200 || c2 != 409 || *n != 1 {
		t.Fatal(c, c2, *n)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, a := range g.Journal.Attempts {
		if a.State != "completed" || a.InputTokens == nil || *a.InputTokens != 70 {
			t.Fatal(a)
		}
	}
}
func TestGateDisconnectCannotTriggerRetry(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
		w.(http.Flusher).Flush()
		h := w.(http.Hijacker)
		c, _, _ := h.Hijack()
		c.Close()
	})
	b := reqBody("lost")
	post(t, g, s, b)
	code, _ := post(t, g, s, b)
	next, _ := post(t, g, s, reqBody("different"))
	if code != 409 || next != 409 || *n != 1 {
		t.Fatal(code, next, *n)
	}
}
func TestGateBudgetPersistsAcrossRestart(t *testing.T) {
	n := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { n++; fmt.Fprint(w, completed()) }))
	defer up.Close()
	e := testEngine(t)
	p := gateDefaults()
	p.MaxRequests = 1
	g, er := newGate(e.Store, "persist", up.URL, p, true)
	if er != nil {
		t.Fatal(er)
	}
	s := httptest.NewServer(g)
	post(t, g, s, reqBody("one"))
	s.Close()
	g.Close()
	g, er = newGate(e.Store, "persist", up.URL, p, true)
	if er != nil {
		t.Fatal(er)
	}
	defer g.Close()
	s = httptest.NewServer(g)
	defer s.Close()
	code, _ := post(t, g, s, reqBody("two"))
	if code != 409 || n != 1 {
		t.Fatal(code, n)
	}
}
func TestGateVolatileMetadataNotNewRequest(t *testing.T) {
	a := map[string]any{"model": "x", "stream": true, "input": "x", "client_metadata": map[string]any{"attempt": 1}}
	b := map[string]any{"model": "x", "stream": true, "input": "x", "client_metadata": map[string]any{"attempt": 2}}
	x, _ := measureRequest(encoded(a), gateDefaults(), nil)
	y, _ := measureRequest(encoded(b), gateDefaults(), nil)
	if x.Fingerprint != y.Fingerprint {
		t.Fatal("retry identity differs")
	}
}
func TestGateCanonicalizesDuplicateJSONFields(t *testing.T) {
	b := []byte(`{"model":"x","stream":true,"input":"first","input":"last"}`)
	a, err := measureRequest(b, gateDefaults(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(a.Canonical, []byte("first")) {
		t.Fatal("ambiguous bytes would be forwarded")
	}
}
func TestGateUnexpectedEndpointDenied(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {})
	r, er := http.Post(s.URL+"/"+g.Token+"/responses/compact", "application/json", bytes.NewReader(reqBody("x")))
	if er != nil {
		t.Fatal(er)
	}
	r.Body.Close()
	if r.StatusCode != 400 || *n != 0 {
		t.Fatal(r.StatusCode, *n)
	}
}
func TestGateRejectsWrongCapabilityAndOrigin(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {})
	for _, origin := range []string{"", "https://evil.invalid"} {
		url := s.URL + "/wrong/responses"
		if origin != "" {
			url = s.URL + "/" + g.Token + "/responses"
		}
		req, _ := http.NewRequest("POST", url, bytes.NewReader(reqBody("x")))
		req.Header.Set("Origin", origin)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != 403 {
			t.Fatal(r.StatusCode)
		}
	}
	if *n != 0 {
		t.Fatal(*n)
	}
}
func TestGateGzipBombDenied(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {})
	var b bytes.Buffer
	z := gzip.NewWriter(&b)
	z.Write(reqBody(strings.Repeat("x", 400000)))
	z.Close()
	req, _ := http.NewRequest("POST", s.URL+"/"+g.Token+"/responses", &b)
	req.Header.Set("Content-Encoding", "gzip")
	r, er := http.DefaultClient.Do(req)
	if er != nil {
		t.Fatal(er)
	}
	r.Body.Close()
	if r.StatusCode != 413 || *n != 0 {
		t.Fatal(r.StatusCode, *n)
	}
}
func TestGateZstdNotSilentlyForwarded(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {})
	req, _ := http.NewRequest("POST", s.URL+"/"+g.Token+"/responses", bytes.NewReader([]byte("compressed")))
	req.Header.Set("Content-Encoding", "zstd")
	r, er := http.DefaultClient.Do(req)
	if er != nil {
		t.Fatal(er)
	}
	r.Body.Close()
	if r.StatusCode != 400 || *n != 0 {
		t.Fatal(r.StatusCode, *n)
	}
}
func TestGateAuthNotLoggedAndNoRedirect(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private_test_secret" {
			t.Error("header not forwarded")
		}
		http.Redirect(w, r, "https://example.invalid", 307)
	})
	req, _ := http.NewRequest("POST", s.URL+"/"+g.Token+"/responses", bytes.NewReader(reqBody("x")))
	req.Header.Set("Authorization", "Bearer private_test_secret")
	r, er := http.DefaultClient.Do(req)
	if er != nil {
		t.Fatal(er)
	}
	r.Body.Close()
	if r.StatusCode != 502 || *n != 1 {
		t.Fatal(r.StatusCode, *n)
	}
	b, _ := os.ReadFile(g.Path)
	if bytes.Contains(b, []byte("private_test_secret")) {
		t.Fatal("credential leaked")
	}
}
func TestGateConcurrentAdmissionsOneSend(t *testing.T) {
	started := make(chan struct{})
	finish := make(chan struct{})
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) { close(started); <-finish; fmt.Fprint(w, completed()) })
	done := make(chan int)
	go func() {
		r, err := http.Post(s.URL+"/"+g.Token+"/responses", "application/json", bytes.NewReader(reqBody("first")))
		if err != nil {
			done <- 0
			return
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		done <- r.StatusCode
	}()
	<-started
	code, _ := post(t, g, s, reqBody("second"))
	close(finish)
	first := <-done
	if code != 409 || first != 200 || *n != 1 {
		t.Fatal(code, first, *n)
	}
}
func TestGateNoRetryOn429(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(429)
		fmt.Fprint(w, `{"error":"quota"}`)
	})
	b := reqBody("x")
	code, _ := post(t, g, s, b)
	again, _ := post(t, g, s, b)
	if code != 429 || again != 409 || *n != 1 {
		t.Fatal(code, again, *n)
	}
}
func TestGateTerminalEventNotArbitraryText(t *testing.T) {
	g, s, _ := testGate(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "response.completed") })
	post(t, g, s, reqBody("x"))
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, a := range g.Journal.Attempts {
		if a.State != "unknown" {
			t.Fatal(a)
		}
	}
}
func TestGateRegistersUsageButOpaqueDefaultStillDenied(t *testing.T) {
	p := gateDefaults()
	body := encoded(map[string]any{"model": "x", "stream": true, "input": []any{map[string]any{"type": "reasoning", "encrypted_content": "trusted"}}})
	if _, e := measureRequest(body, p, map[string]int64{digest([]byte("trusted")): 100}); e == nil {
		t.Fatal("opaque silently permitted")
	}
	p.AllowObservedOpaque = true
	if _, e := measureRequest(body, p, map[string]int64{digest([]byte("trusted")): 100}); e != nil {
		t.Fatal(e)
	}
}
func TestGateServerUsageOverLocalLimitQuarantines(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, strings.Replace(completed(), `"input_tokens":70`, `"input_tokens":300000`, 1))
	})
	post(t, g, s, reqBody("x"))
	code, _ := post(t, g, s, reqBody("y"))
	if code != 409 || *n != 1 {
		t.Fatal(code, *n)
	}
}
func TestGateNoResponseBudgetNoDispatch(t *testing.T) {
	g, s, n := testGate(t, func(w http.ResponseWriter, r *http.Request) {})
	g.Store.Limits.StoreBytes = 1024
	code, _ := post(t, g, s, reqBody("x"))
	if code != 507 || *n != 0 {
		t.Fatal(code, *n)
	}
}
func TestGateResponseLimitMakesUnknown(t *testing.T) {
	g, s, _ := testGate(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, strings.Repeat("x", 3000)) })
	g.Journal.Policy.MaxResponseBytes = 1024
	post(t, g, s, reqBody("x"))
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, a := range g.Journal.Attempts {
		if a.State != "unknown" || a.ResponseBytes > 1024 {
			t.Fatal(a)
		}
	}
}
func TestGateRestartInFlightBecomesUnknown(t *testing.T) {
	e := testEngine(t)
	p := gateDefaults()
	up := "http://127.0.0.1:12345"
	g, err := newGate(e.Store, "crash", up, p, true)
	if err != nil {
		t.Fatal(err)
	}
	g.Journal.Attempts["one"] = Attempt{State: "in_flight"}
	atomicJSON(g.Path, g.Journal)
	g.Close()
	g, err = newGate(e.Store, "crash", up, p, true)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if g.Journal.Attempts["one"].State != "unknown" {
		t.Fatal(g.Journal)
	}
}
func TestGatePolicyCannotResetExistingTask(t *testing.T) {
	e := testEngine(t)
	p := gateDefaults()
	g, err := newGate(e.Store, "q", "http://127.0.0.1:1", p, true)
	if err != nil {
		t.Fatal(err)
	}
	g.Close()
	p.MaxRequests++
	if g, err = newGate(e.Store, "q", "http://127.0.0.1:1", p, true); err == nil {
		g.Close()
		t.Fatal("budget reset")
	}
}
func TestGateUnknownFieldDenied(t *testing.T) {
	if _, err := measureRequest([]byte(`{"model":"x","stream":true,"input":"x","external_context":"secret server state"}`), gateDefaults(), nil); err == nil {
		t.Fatal("unknown allowed")
	}
}
func TestGatePublicHTTPNotAllowed(t *testing.T) {
	e := testEngine(t)
	if g, err := newGate(e.Store, "p", "http://example.invalid", gateDefaults(), true); err == nil {
		g.Close()
		t.Fatal("plaintext upstream allowed")
	}
}
func TestGatePartialSSEFrame(t *testing.T) {
	o := &responseObservation{}
	b := []byte(completed())
	for _, x := range b {
		o.Feed([]byte{x})
	}
	if !o.Completed || o.Cached == nil || *o.Cached != 30 {
		t.Fatal(o)
	}
}
func TestGateNegativeUsageNotTrusted(t *testing.T) {
	o := &responseObservation{}
	o.Feed([]byte(strings.Replace(completed(), `"output_tokens":20`, `"output_tokens":-20`, 1)))
	if o.Completed || o.Output != nil {
		t.Fatal(o)
	}
}
func TestGateDoesNotChangePayloadSemantics(t *testing.T) {
	var got map[string]any
	g, s, _ := testGate(t, func(w http.ResponseWriter, r *http.Request) {
		if er := json.NewDecoder(r.Body).Decode(&got); er != nil {
			t.Error(er)
		}
		fmt.Fprint(w, completed())
	})
	post(t, g, s, reqBody("preserve this exact meaning"))
	if !strings.Contains(string(encoded(got)), "preserve this exact meaning") {
		t.Fatal(got)
	}
}
func TestGateResponseSavedLocally(t *testing.T) {
	g, s, _ := testGate(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, completed()) })
	post(t, g, s, reqBody("x"))
	for _, a := range g.Journal.Attempts {
		b, err := os.ReadFile(filepath.Join(g.Store.Root, "gates", a.ID+".sse"))
		if err != nil || !bytes.Contains(b, []byte("response.completed")) {
			t.Fatal(err)
		}
	}
}

var _ = context.Background
var _ = time.Second
