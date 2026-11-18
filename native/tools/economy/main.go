package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func defaultState(root string) string {
	base, e := os.UserCacheDir()
	if e != nil {
		base = os.TempDir()
	}
	abs, _ := filepath.Abs(root)
	return filepath.Join(base, "PlatformStudio", "economy", digest([]byte(abs))[:24])
}
func printJSON(v any) { fmt.Println(string(encoded(v))) }
func main() {
	if er := run(os.Args[1:]); er != nil {
		fmt.Fprintln(os.Stderr, er)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		fmt.Println("Platform Studio Economy " + Version + "\nCommands: selftest, demo, research-demo, run, sweep, sweep-preflight, research-source, mcp, pack, capture, profile, launch, gate, inspect-request.\nNo command silently calls a model. launch explicitly starts your installed Codex. gate forwards only explicitly routed requests.\nUse --project <directory>. State/logs are private and outside the project.")
		return nil
	}
	if args[0] == "__fixture" {
		return fixture(args[1:])
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	project := fs.String("project", ".", "project root")
	state := fs.String("state", "", "private state outside project")
	input := fs.String("input", "", "JSON input path")
	output := fs.String("output", "", "new report directory/file")
	policy := fs.String("checks", "", "owner-approved checks JSON (outside project)")
	program := fs.String("program", "", "absolute trusted executable for manual capture")
	codex := fs.String("codex", "", "native installed Codex executable")
	upstream := fs.String("upstream", "", "fixed HTTPS Responses base URL for optional gate; no default")
	task := fs.String("task", "default", "persistent gate task ID")
	maxReq := fs.Int("max-requests", 8, "provider request cap per task (not tokens)")
	listen := fs.String("listen", "127.0.0.1:0", "loopback address only")
	model := fs.String("model", "", "optional already-available model")
	if er := fs.Parse(args[1:]); er != nil {
		return er
	}
	if args[0] == "research-demo" {
		return researchDemo(*output, true)
	}
	if args[0] == "selftest" || args[0] == "demo" {
		return demo(*output, args[0] == "demo")
	}
	if *state == "" {
		*state = defaultState(*project)
	}
	e, er := newEngine(*project, *state)
	if er != nil {
		return er
	}
	checksPath := ""
	if *policy != "" {
		abs, err := filepath.EvalSymlinks(*policy)
		if err == nil {
			abs, err = filepath.Abs(abs)
		}
		if err != nil || within(e.Root, abs) {
			return errors.New("approved checks manifest must be outside project")
		}
		if er = loadJSON(abs, &e.Checks, 64<<10); er != nil {
			return er
		}
		checksPath = abs
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	switch args[0] {
	case "mcp":
		return serveMCP(ctx, e, os.Stdin, os.Stdout)
	case "research-source":
		printJSON(map[string]any{"rootHash": digest([]byte(e.Root)), "profile": "read-only local diagnostic tool; not an OS sandbox", "localModelCalls": 0})
		return nil
	case "sweep", "sweep-preflight":
		f, err := os.Open(*input)
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(f, (256<<10)+1))
		f.Close()
		if err != nil {
			return err
		}
		if len(b) > 256<<10 {
			return errors.New("research request exceeds 256 KiB")
		}
		var req SweepRequest
		if err = strictDecode(b, &req); err != nil {
			return err
		}
		if args[0] == "sweep-preflight" {
			packet, er := validateResearch(req, digest([]byte(e.Root)))
			if er != nil {
				return er
			}
			printJSON(map[string]any{"valid": true, "operations": len(packet.Operations), "questions": orderedQuestions(req.Plan), "localModelCalls": 0})
			return nil
		}
		report, err := e.sweep(ctx, req)
		if err == nil {
			printJSON(report)
		}
		return err
	case "run":
		p, err := loadPacket(*input)
		if err != nil {
			return err
		}
		v, err := e.batch(ctx, p)
		if err == nil {
			printJSON(v)
		}
		return err
	case "pack":
		var p ContextSpec
		if err := loadJSON(*input, &p, 128<<10); err != nil {
			return err
		}
		v, err := e.pack(p)
		if err == nil {
			printJSON(v)
		}
		return err
	case "capture":
		a, err := e.capture(ctx, CheckSpec{Program: *program, Args: fs.Args(), TimeoutSeconds: 120})
		if err == nil {
			printJSON(a)
		}
		return err
	case "profile":
		ex, _ := os.Executable()
		mcpArgs := []string{"mcp", "--project", e.Root, "--state", e.Store.Root}
		if checksPath != "" {
			mcpArgs = append(mcpArgs, "--checks", checksPath)
		}
		v := map[string]any{"command": ex, "args": mcpArgs, "scope": "local tools; not a full Codex request ceiling", "codexConfigOverrides": profileOverrides(ex, e.Root, e.Store.Root, checksPath), "effectiveCodexConfiguration": "must be checked on your installed version"}
		if *output != "" {
			return fileJSON(*output, v)
		}
		printJSON(v)
		return nil
	case "launch":
		if *upstream != "" {
			return errors.New("guarded launch not silently enabled: use explicit gate and reviewed provider config; existing subscription route is not auto-replaced")
		}
		ex, _ := os.Executable()
		bin, err := resolveCodex(*codex)
		if err != nil {
			return err
		}
		over := profileOverrides(ex, e.Root, e.Store.Root, checksPath)
		a := []string{}
		for _, v := range over {
			a = append(a, "-c", v)
		}
		a = append(a, "--cd", e.Root)
		if *model != "" {
			a = append(a, "--model", *model)
		}
		a = append(a, fs.Args()...)
		fmt.Fprintln(os.Stderr, "Local tools profile: outputs are bounded; whole Codex context is NOT hard-capped by these config hints. Existing ambient hooks/config require review. No global files changed.")
		c := exec.CommandContext(ctx, bin, a...)
		c.Stdin = os.Stdin
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		return c.Run()
	case "inspect-request":
		b, err := os.ReadFile(*input)
		if err != nil {
			return err
		}
		p := gateDefaults()
		ad, err := measureRequest(b, p, map[string]int64{})
		v := map[string]any{"accepted": err == nil, "clientUnits": ad.Units, "requestBytes": ad.Bytes, "actualModelTokens": nil, "networkSends": 0}
		if err != nil {
			v["reason"] = err.Error()
		}
		printJSON(v)
		return nil
	case "gate":
		host, _, err := net.SplitHostPort(*listen)
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return errors.New("gate can bind only numeric loopback")
		}
		p := gateDefaults()
		p.MaxRequests = *maxReq
		g, err := newGate(e.Store, *task, *upstream, p, false)
		if err != nil {
			return err
		}
		defer g.Close()
		ln, err := net.Listen("tcp", *listen)
		if err != nil {
			return err
		}
		s := &http.Server{Handler: g, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
		printJSON(map[string]any{"baseUrl": "http://" + ln.Addr().String() + "/" + g.Token, "upstream": g.Upstream.String(), "task": *task, "policy": p, "note": "one-hop gate; HTTP/SSE only; no automatic retries. Do not share the local capability URL. This does not intercept processes not configured to use it."})
		go func() {
			<-ctx.Done()
			c, cc := context.WithTimeout(context.Background(), 5*time.Second)
			defer cc()
			_ = s.Shutdown(c)
		}()
		err = s.Serve(ln)
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	default:
		return errors.New("unknown command")
	}
}
func profileOverrides(ex, root, state, checks string) []string {
	q := func(s string) string { return string(encoded(s)) }
	args := []string{"mcp", "--project", root, "--state", state}
	if checks != "" {
		args = append(args, "--checks", checks)
	}
	return []string{
		"mcp_servers.studio_economy={command=" + q(ex) + ",args=" + string(encoded(args)) + ",startup_timeout_sec=15,tool_timeout_sec=660}",
		"tool_output_token_limit=6000", "model_context_window=48000", "model_auto_compact_token_limit=36000", "model_post_turn_compact_threshold_percent=0", "features.memories=false", "memories.generate_memories=false", "memories.use_memories=false", "features.multi_agent=false", "agents.enabled=false", "features.goals=false", "web_search=\"disabled\"", "features.computer_use=false", "computer_use.default_app_access=\"deny\"", "features.shell_tool=false", "features.view_image=false", "tui.auto_recap=false",
	}

}
func fixture(args []string) error {
	n := 1 << 20
	if len(args) > 0 {
		_, _ = fmt.Sscan(args[0], &n)
	}
	if n < 0 || n > 160<<20 {
		return errors.New("fixture size limit")
	}
	row := []byte(strings.Repeat("x", 1023) + "\n")
	written := 0
	middle := false
	for written < n {
		if !middle && written >= n/2 {
			fmt.Fprintln(os.Stdout, "ERROR DISTINCT_MIDDLE_EVIDENCE_4821")
			middle = true
		}
		b := row
		if n-written < len(b) {
			b = b[:n-written]
		}
		m, err := os.Stdout.Write(b)
		if err != nil {
			return err
		}
		written += m
	}
	fmt.Fprintln(os.Stderr, "fixture stderr completed")
	return nil
}
func demo(out string, large bool) error {
	if out == "" {
		dir, err := os.MkdirTemp("", "studio-economy-selftest-")
		if err != nil {
			return err
		}
		out = dir
	} else {
		if err := os.Mkdir(out, 0700); err != nil {
			return err
		}
	}
	root := filepath.Join(out, "project")
	state := filepath.Join(out, "private")
	os.Mkdir(root, 0700)
	for i := 0; i < 20; i++ {
		_ = writeNew(filepath.Join(root, fmt.Sprintf("f%02d.txt", i)), []byte(fmt.Sprintf("source %d\nsaveSettings special_%d\n", i, i)))
	}
	e, er := newEngine(root, state)
	if er != nil {
		return er
	}
	ops := []Operation{}
	for i := 0; i < 20; i++ {
		ops = append(ops, Operation{ID: fmt.Sprintf("r%d", i), Op: "read", Path: fmt.Sprintf("f%02d.txt", i)})
	}
	env, er := e.batch(context.Background(), Packet{ID: "twenty", Operations: ops})
	if er != nil {
		return er
	}
	replay, er := e.batch(context.Background(), Packet{ID: "twenty", Operations: ops})
	if er != nil {
		return er
	}
	bytes := 1 << 20
	if large {
		bytes = 100 << 20
	}
	ex, _ := os.Executable()
	a, er := e.capture(context.Background(), CheckSpec{Program: ex, Args: []string{"__fixture", fmt.Sprint(bytes)}, TimeoutSeconds: 120})
	if er != nil {
		return er
	}
	text, _, er := e.Store.inspect(Operation{Artifact: a.ID, Stream: "stdout.log", Query: "DISTINCT_MIDDLE_EVIDENCE"})
	if er != nil {
		return er
	}
	bad := []byte(`{"model":"fixture","stream":true,"input":[{"role":"user","content":"` + strings.Repeat("x", 300000) + `"}]}`)
	_, block := measureRequest(bad, gateDefaults(), nil)
	report := map[string]any{"version": Version, "platform": runtime.GOOS + "/" + runtime.GOARCH, "localModelCalls": 0, "operations": len(env.Results), "packetUtf8Bytes": len(encoded(env)), "packetLimitUtf8Bytes": env.Limit, "replay": replay.Replayed, "captureArtifact": a.ID, "capturedStdoutBytes": a.Files["stdout.log"].Bytes, "captureComplete": a.Complete, "captureExitCode": a.ExitCode, "middleFound": strings.Contains(text, "DISTINCT_MIDDLE_EVIDENCE"), "oversizedRequestBlocked": block != nil, "source": "local generated fixtures; not real Codex/quota measurement"}
	if er = fileJSON(filepath.Join(out, "report.json"), report); er != nil {
		return er
	}
	printJSON(map[string]any{"report": filepath.Join(out, "report.json"), "results": report})
	return nil
}

var _ = io.EOF
var _ = json.Valid
