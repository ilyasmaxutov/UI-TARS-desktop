package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
)

func toolSchemas() []map[string]any {
	str := map[string]any{"type": "string"}
	num := map[string]any{"type": "integer"}
	arr := map[string]any{"type": "array", "items": str}
	opProps := map[string]any{"id": str, "op": map[string]any{"type": "string", "enum": []string{"files", "search", "read", "read_bytes", "read_matches", "metadata", "hash", "inspect", "check", "git_status", "git_diff"}}, "path": str, "paths": arr, "query": str, "startLine": num, "lines": num, "offset": num, "length": num, "from": str, "dependsOn": arr, "limit": num, "before": num, "after": num, "artifact": str, "stream": str, "check": str, "includeGenerated": map[string]any{"type": "boolean"}}
	tools := []map[string]any{{"name": "local_batch", "description": "Run 1..32 LOCAL operations in one bounded reply; no model between steps. search is literal. read_matches uses from=<search id>. Stable id resumes the same packet, never retries unknown checks. Paths relative. Full outputs are local artifacts. check names require owner approval.", "inputSchema": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id", "operations"}, "properties": map[string]any{"id": str, "operations": map[string]any{"type": "array", "minItems": 1, "maxItems": 32, "items": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id", "op"}, "properties": opProps}}}}, "annotations": map[string]any{"destructiveHint": true, "openWorldHint": false}},
		{"name": "context_pack", "description": "Select exact local evidence plus original goal/rules. No model summarization. Fails rather than truncating mandatory material. Does not load a whole conversation.", "inputSchema": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"goal", "rules", "materials"}, "properties": map[string]any{"goal": str, "rules": arr, "materials": arr, "maxUtf8Bytes": num}}, "annotations": map[string]any{"destructiveHint": false, "openWorldHint": false}}}
	return append(tools, researchToolSchema())
}

type rpcFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func strictDecode(b []byte, v any) error {
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func serveMCP(ctx context.Context, e *Engine, r io.Reader, w io.Writer) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 4096), 256<<10)
	var outMu, mu sync.Mutex
	calls := map[string]context.CancelFunc{}
	var wg sync.WaitGroup
	initialized := false
	send := func(id json.RawMessage, result any, err error) {
		v := map[string]any{"jsonrpc": "2.0", "id": id}
		if err != nil {
			v["error"] = map[string]any{"code": -32602, "message": cut(err.Error(), 1024)}
		} else {
			v["result"] = result
		}
		b := encoded(v)
		if len(b)+1 > MaxPacketBytes {
			v["result"] = map[string]any{"isError": true, "content": []map[string]string{{"type": "text", "text": "Result exceeds total MCP wire budget. Original artifacts remain local; use the same packet ID with CLI run to retrieve references, then inspect smaller ranges. Do not rerun checks with a new ID. No model was called."}}}
			delete(v, "error")
			b = encoded(v)
		}
		outMu.Lock()
		defer outMu.Unlock()
		_, _ = w.Write(append(b, '\n'))
	}
	defer func() {
		mu.Lock()
		for _, c := range calls {
			c()
		}
		mu.Unlock()
		wg.Wait()
	}()
	for sc.Scan() {
		var q rpcFrame
		if er := json.Unmarshal(sc.Bytes(), &q); er != nil {
			send(json.RawMessage("null"), nil, er)
			continue
		}
		key := string(q.ID)
		if q.Method == "notifications/cancelled" {
			var p struct {
				ID json.RawMessage `json:"requestId"`
			}
			_ = json.Unmarshal(q.Params, &p)
			mu.Lock()
			if c := calls[string(p.ID)]; c != nil {
				c()
			}
			mu.Unlock()
			continue
		}
		if len(q.ID) == 0 {
			continue
		}
		if q.JSONRPC != "2.0" {
			send(q.ID, nil, errors.New("JSON-RPC 2.0 required"))
			continue
		}
		switch q.Method {
		case "initialize":
			initialized = true
			send(q.ID, map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}, "serverInfo": map[string]string{"name": "platform-studio-economy", "version": Version}, "instructions": diagnosisFirstSkill + "\nSource rootHash=" + digest([]byte(e.Root))}, nil)
		case "ping":
			send(q.ID, map[string]any{}, nil)
		case "tools/list":
			if !initialized {
				send(q.ID, nil, errors.New("initialize first"))
			} else {
				send(q.ID, map[string]any{"tools": toolSchemas()}, nil)
			}
		case "tools/call":
			if !initialized {
				send(q.ID, nil, errors.New("initialize first"))
				continue
			}
			mu.Lock()
			if len(calls) >= 4 {
				mu.Unlock()
				send(q.ID, nil, errors.New("local concurrency limit"))
				continue
			}
			if _, ok := calls[key]; ok {
				mu.Unlock()
				send(q.ID, nil, errors.New("duplicate live request ID"))
				continue
			}
			cctx, cancel := context.WithCancel(ctx)
			calls[key] = cancel
			mu.Unlock()
			wg.Add(1)
			go func(q rpcFrame, key string) {
				defer wg.Done()
				defer cancel()
				defer func() { mu.Lock(); delete(calls, key); mu.Unlock() }()
				var p struct {
					Name      string          `json:"name"`
					Arguments json.RawMessage `json:"arguments"`
					Meta      any             `json:"_meta,omitempty"`
				}
				er := strictDecode(q.Params, &p)
				var value any
				if er == nil {
					switch p.Name {
					case "local_batch":
						var packet Packet
						er = strictDecode(p.Arguments, &packet)
						if er == nil {
							value, er = e.batch(cctx, packet)
						}
					case "diagnostic_sweep":
						var request SweepRequest
						er = strictDecode(p.Arguments, &request)
						if er == nil {
							value, er = e.sweep(cctx, request)
						}
					case "context_pack":
						var spec ContextSpec
						er = strictDecode(p.Arguments, &spec)
						if er == nil {
							if spec.MaxBytes == 0 || spec.MaxBytes > 12000 {
								spec.MaxBytes = 12000
							}
							value, er = e.pack(spec)
						}
					default:
						er = errors.New("unknown tool; no fallback")
					}
				}
				// Bound the outer MCP JSON, not just the nested result. Quoting a
				// snippet can almost double its wire length. Keep artifact IDs/statuses.
				if env, ok := value.(Envelope); ok && er == nil {
					for budget := e.Limits.PacketBytes; budget >= 8192; budget -= 1024 {
						bounded, err := envelope(env.ID, env.Results, budget, env.Replayed)
						if err != nil {
							er = err
							break
						}
						value = bounded
						probe := map[string]any{"jsonrpc": "2.0", "id": q.ID, "result": map[string]any{"isError": false, "content": []map[string]string{{"type": "text", "text": string(encoded(value))}}}}
						if len(encoded(probe))+1 <= MaxPacketBytes {
							break
						}
					}
				}
				if report, ok := value.(SweepReport); ok && er == nil {
					for budget := report.Limit; budget >= 2048; budget -= 512 {
						bounded, be := fitSweep(report, budget)
						if be != nil {
							er = be
							break
						}
						value = bounded
						probe := map[string]any{"jsonrpc": "2.0", "id": q.ID, "result": map[string]any{"isError": false, "content": []map[string]string{{"type": "text", "text": string(encoded(value))}}}}
						if len(encoded(probe))+1 <= MaxPacketBytes {
							break
						}
					}
				}
				text := string(encoded(value))
				if er != nil {
					text = cut(er.Error(), 2048)
				}
				send(q.ID, map[string]any{"isError": er != nil, "content": []map[string]string{{"type": "text", "text": text}}}, nil)
			}(q, key)
		default:
			send(q.ID, nil, errors.New("unsupported method"))
		}
	}
	return sc.Err()
}
