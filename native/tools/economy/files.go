package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type Engine struct {
	Root   string
	Store  *Store
	Checks map[string]CheckSpec
	Limits Limits
}
type CheckSpec struct {
	Program        string   `json:"program"`
	Args           []string `json:"args"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}

func newEngine(root, state string) (*Engine, error) {
	r, e := filepath.Abs(root)
	if e != nil {
		return nil, e
	}
	r, e = filepath.EvalSymlinks(r)
	if e != nil {
		return nil, e
	}
	st, e := os.Stat(r)
	if e != nil || !st.IsDir() {
		return nil, errors.New("project must be an existing directory")
	}
	lim := defaults()
	stateAbs, er := filepath.Abs(state)
	if er != nil || within(r, stateAbs) {
		return nil, errors.New("private state must be outside project")
	}
	s, e := newStore(state, lim)
	if e != nil {
		return nil, e
	}
	if within(r, s.Root) {
		return nil, errors.New("private state must be outside project (avoid indexing logs or model editing policy)")
	}
	return &Engine{Root: r, Store: s, Limits: lim, Checks: map[string]CheckSpec{}}, nil
}
func (e *Engine) path(rel string) (string, error) {
	if rel == "" {
		rel = "."
	}
	if filepath.IsAbs(rel) || strings.ContainsAny(rel, "\x00:") || strings.HasPrefix(rel, "\\") {
		return "", errors.New("relative project path required")
	}
	p := filepath.Join(e.Root, filepath.FromSlash(rel))
	if !within(e.Root, p) {
		return "", errors.New("path escapes project")
	}
	r, _ := filepath.Rel(e.Root, p)
	cur := e.Root
	for _, part := range strings.Split(r, string(filepath.Separator)) {
		if part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		i, err := os.Lstat(cur)
		if err != nil {
			return "", err
		}
		if i.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("symbolic link not allowed")
		}
	}
	real, er := filepath.EvalSymlinks(p)
	if er != nil || !within(e.Root, real) {
		return "", errors.New("resolved path escapes project")
	}
	return p, nil
}

var skipDirs = map[string]bool{".git": true, "node_modules": true, "target": true, "dist": true, "build": true, "vendor": true, ".next": true, ".venv": true}

func secretName(p string) bool {
	b := strings.ToLower(filepath.Base(p))
	return b == "auth.json" || b == ".env" || strings.HasPrefix(b, ".env.") || b == "id_rsa" || b == "id_ed25519" || strings.HasSuffix(b, ".key") || strings.HasSuffix(b, ".pfx") || strings.HasSuffix(b, ".p12")
}

type Coverage struct {
	Files    int      `json:"files"`
	Bytes    int64    `json:"bytes"`
	Skipped  int      `json:"skipped"`
	Complete bool     `json:"complete"`
	Reasons  []string `json:"reasons"`
}

func (e *Engine) paths(paths []string, generated bool) ([]string, Coverage, error) {
	if len(paths) == 0 {
		paths = []string{"."}
	}
	if len(paths) > 32 {
		return nil, Coverage{}, errors.New("too many roots")
	}
	out := []string{}
	seen := map[string]bool{}
	c := Coverage{Complete: true, Reasons: []string{}}
	stopped := false
	for _, root := range paths {
		p, er := e.path(root)
		if er != nil {
			return nil, c, er
		}
		er = filepath.WalkDir(p, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				c.Complete = false
				c.Skipped++
				return nil
			}
			if stopped {
				return filepath.SkipAll
			}
			if d.Type()&os.ModeSymlink != 0 {
				c.Skipped++
				c.Complete = false
				return nil
			}
			if d.IsDir() {
				if p != e.Root && !generated && skipDirs[d.Name()] {
					c.Skipped++
					return filepath.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() {
				c.Skipped++
				c.Complete = false
				return nil
			}
			rel, _ := filepath.Rel(e.Root, p)
			rel = filepath.ToSlash(rel)
			if secretName(rel) {
				c.Skipped++
				return nil
			}
			if !generated && (strings.HasSuffix(rel, ".lock") || filepath.Base(rel) == "package-lock.json") {
				c.Skipped++
				return nil
			}
			if !seen[rel] {
				if len(out) >= e.Limits.ScanFiles {
					c.Complete = false
					c.Reasons = append(c.Reasons, "file count limit")
					stopped = true
					return filepath.SkipAll
				}
				seen[rel] = true
				out = append(out, rel)
			}
			return nil
		})
		if er != nil {
			return nil, c, er
		}
	}
	sort.Strings(out)
	c.Files = len(out)
	if c.Skipped > 0 {
		c.Reasons = append(c.Reasons, "excluded/generated/secret/link paths are NOT searched")
	}
	return out, c, nil
}
func readLines(r io.Reader, start, n, maxOutput int, maxScan int64) (map[string]any, error) {
	if start < 1 {
		start = 1
	}
	if n < 1 {
		n = 60
	}
	if n > 250 {
		return nil, errors.New("at most 250 lines")
	}
	lr := &io.LimitedReader{R: r, N: maxScan + 1}
	sc := bufio.NewScanner(lr)
	sc.Buffer(make([]byte, 4096), 65536)
	rows := []map[string]any{}
	size := 0
	line := 0
	complete := true
	next := 0
	for sc.Scan() {
		line++
		if line < start {
			continue
		}
		text := sc.Text()
		if len(rows) >= n || size+len(text) > maxOutput {
			complete = false
			next = line
			break
		}
		rows = append(rows, map[string]any{"line": line, "text": text})
		size += len(text)
	}
	reason := ""
	if sc.Err() != nil {
		complete = false
		reason = "line too long or read error; use byte range"
	}
	if lr.N <= 0 {
		complete = false
		reason = "scan byte limit"
	}
	v := map[string]any{"lines": rows, "complete": complete, "nextLine": next, "reason": reason, "scannedBytesUpper": maxScan + 1 - lr.N}
	return v, nil
}
func searchReader(r io.Reader, q string, maxScan int64, limit int) ([]map[string]any, Coverage, error) {
	c := Coverage{Complete: true, Reasons: []string{}}
	out := []map[string]any{}
	if q == "" || len(q) > 256 {
		return out, c, errors.New("literal query 1..256 bytes required")
	}
	lr := &io.LimitedReader{R: r, N: maxScan + 1}
	sc := bufio.NewScanner(lr)
	sc.Buffer(make([]byte, 4096), 65536)
	line := 0
	needle := strings.ToLower(q)
	for sc.Scan() {
		line++
		s := sc.Text()
		if strings.Contains(strings.ToLower(s), needle) {
			out = append(out, map[string]any{"line": line, "text": cut(s, 1024), "lineTruncated": len(s) > 1024})
			if len(out) >= limit {
				c.Complete = false
				c.Reasons = append(c.Reasons, "match limit reached")
				break
			}
		}
	}
	c.Bytes = maxScan + 1 - lr.N
	if sc.Err() != nil {
		c.Complete = false
		c.Reasons = append(c.Reasons, "line too long or read error; inspect byte ranges")
	}
	if lr.N <= 0 {
		c.Complete = false
		c.Reasons = append(c.Reasons, "scan byte limit")
	}
	return out, c, nil
}
func (e *Engine) read(op Operation) (string, any, error) {
	if secretName(op.Path) {
		return "", nil, errors.New("secret-like filename excluded")
	}
	p, er := e.path(op.Path)
	if er != nil {
		return "", nil, er
	}
	f, er := os.Open(p)
	if er != nil {
		return "", nil, er
	}
	defer f.Close()
	before, er := f.Stat()
	if er != nil || !before.Mode().IsRegular() {
		return "", nil, errors.New("regular file required")
	}
	var v map[string]any
	if op.Length > 0 || op.Op == "read_bytes" {
		n := op.Length
		if n == 0 {
			n = 4096
		}
		if n > e.Limits.ReadBytes || n < 0 || op.Offset < 0 {
			return "", nil, errors.New("invalid bounded byte range")
		}
		buf := make([]byte, n)
		got, err := f.ReadAt(buf, op.Offset)
		if err != nil && err != io.EOF {
			return "", nil, err
		}
		buf = buf[:got]
		v = map[string]any{"offset": op.Offset, "bytes": got, "base64": base64.StdEncoding.EncodeToString(buf), "sliceSha256": digest(buf), "eof": err == io.EOF}
	} else {
		head := make([]byte, 4096)
		n, _ := f.Read(head)
		if strings.Contains(string(head[:n]), "\x00") {
			return "", nil, errors.New("binary file; request read_bytes explicitly")
		}
		f.Seek(0, io.SeekStart)
		v, er = readLines(f, op.StartLine, op.Lines, e.Limits.ReadBytes, e.Limits.ScanBytes)
		if er != nil {
			return "", nil, er
		}
		v["sliceSha256"] = digest(encoded(v["lines"]))
	}
	after, er := f.Stat()
	if er != nil {
		return "", nil, er
	}
	v["path"] = op.Path
	v["fileBytes"] = before.Size()
	v["modifiedNS"] = before.ModTime().UnixNano()
	v["sourceChangedDuringRead"] = before.Size() != after.Size() || before.ModTime() != after.ModTime()
	v["versionBasis"] = "stat+returned-slice hash; not full-file snapshot"
	return string(encoded(v)), v, nil
}
func (e *Engine) search(op Operation) (string, any, error) {
	if op.Query == "" || len(op.Query) > 256 {
		return "", nil, errors.New("literal query 1..256 bytes required")
	}
	lim := op.Limit
	if lim <= 0 {
		lim = 30
	}
	if lim > 100 {
		return "", nil, errors.New("match limit <=100")
	}
	paths, c, err := e.paths(op.Paths, op.IncludeGenerated)
	if err != nil {
		return "", nil, err
	}
	rows := []map[string]any{}
	remaining := e.Limits.ScanBytes
	readfiles := 0
	for _, rel := range paths {
		if remaining <= 0 || len(rows) >= lim {
			c.Complete = false
			c.Reasons = append(c.Reasons, "scan or result limit")
			break
		}
		p, er := e.path(rel)
		if er != nil {
			c.Complete = false
			c.Skipped++
			continue
		}
		f, er := os.Open(p)
		if er != nil {
			c.Complete = false
			c.Skipped++
			continue
		}
		st, er := f.Stat()
		if er != nil || !st.Mode().IsRegular() || st.Size() > e.Limits.FileBytes {
			f.Close()
			c.Skipped++
			c.Complete = false
			continue
		}
		head := make([]byte, 4096)
		n, _ := f.Read(head)
		if strings.Contains(string(head[:n]), "\x00") {
			f.Close()
			c.Skipped++
			continue
		}
		f.Seek(0, io.SeekStart)
		hits, cc, er := searchReader(f, op.Query, remaining, lim-len(rows))
		after, _ := f.Stat()
		f.Close()
		if after == nil || st.Size() != after.Size() || st.ModTime() != after.ModTime() {
			c.Complete = false
			c.Reasons = append(c.Reasons, "source changed during search")
		}
		readfiles++
		remaining -= cc.Bytes
		if er != nil {
			return "", nil, er
		}
		if !cc.Complete {
			c.Complete = false
			c.Reasons = append(c.Reasons, cc.Reasons...)
		}
		for _, row := range hits {
			row["path"] = rel
			row["modifiedNS"] = st.ModTime().UnixNano()
			row["sourceChangedDuringRead"] = after == nil || st.Size() != after.Size() || st.ModTime() != after.ModTime()
			rows = append(rows, row)
		}
	}
	c.Bytes = e.Limits.ScanBytes - remaining
	c.Files = readfiles
	v := map[string]any{"query": op.Query, "matches": rows, "coverage": c}
	return string(encoded(v)), v, nil
}
func (e *Engine) execute(ctx context.Context, op Operation, prior map[string]Result) (string, any, error) {
	switch op.Op {
	case "files":
		paths, c, er := e.paths(op.Paths, op.IncludeGenerated)
		v := map[string]any{"paths": paths, "coverage": c}
		return string(encoded(v)), v, er
	case "search":
		return e.search(op)
	case "read", "read_bytes":
		return e.read(op)
	case "read_matches":
		prev, ok := prior[op.From]
		if !ok || prev.State != "completed" {
			return "", nil, errors.New("search dependency unavailable")
		}
		if len(prev.Data) == 0 && prev.Artifact != "" {
			f, seal, er := e.Store.open(prev.Artifact, "data.json")
			if er != nil {
				return "", nil, er
			}
			b, er := io.ReadAll(io.LimitReader(f, 1<<20+1))
			f.Close()
			if er != nil || len(b) > 1<<20 || digest(b) != seal.Files["data.json"].SHA256 {
				return "", nil, errors.New("dependency snapshot too large or corrupted")
			}
			prev.Data = b
		}
		var d struct {
			Matches []struct {
				Path string `json:"path"`
				Line int    `json:"line"`
			} `json:"matches"`
		}
		if er := json.Unmarshal(prev.Data, &d); er != nil {
			return "", nil, er
		}
		n := op.Limit
		if n <= 0 {
			n = 6
		}
		if n > 12 || op.Before < 0 || op.After < 0 {
			return "", nil, errors.New("invalid match ranges")
		}
		rows := []any{}
		seen := map[string]bool{}
		for _, m := range d.Matches {
			if len(rows) >= n {
				break
			}
			start := m.Line - op.Before
			if start < 1 {
				start = 1
			}
			after := op.After
			if after == 0 {
				after = 12
			}
			key := fmt.Sprintf("%s:%d", m.Path, start)
			if seen[key] {
				continue
			}
			seen[key] = true
			_, v, er := e.read(Operation{Op: "read", Path: m.Path, StartLine: start, Lines: op.Before + after + 1})
			if er != nil {
				rows = append(rows, map[string]any{"path": m.Path, "error": er.Error()})
			} else {
				rows = append(rows, v)
			}
		}
		v := map[string]any{"ranges": rows, "selectionComplete": len(d.Matches) <= n}
		return string(encoded(v)), v, nil
	case "inspect":
		return e.Store.inspect(op)
	case "metadata", "hash":
		if secretName(op.Path) {
			return "", nil, errors.New("secret-like filename excluded")
		}
		p, er := e.path(op.Path)
		if er != nil {
			return "", nil, er
		}
		st, er := os.Stat(p)
		if er != nil || !st.Mode().IsRegular() {
			return "", nil, errors.New("regular file required")
		}
		v := map[string]any{"path": op.Path, "bytes": st.Size(), "modifiedNS": st.ModTime().UnixNano()}
		if op.Op == "hash" {
			if st.Size() > 256<<20 {
				return "", nil, errors.New("hash size limit")
			}
			f, er := os.Open(p)
			if er != nil {
				return "", nil, er
			}
			h := sha256.New()
			n, er := io.Copy(h, io.LimitReader(f, 256<<20+1))
			f.Close()
			if er != nil || n != st.Size() {
				return "", nil, errors.New("hash read changed or failed")
			}
			v["sha256"] = hex.EncodeToString(h.Sum(nil))
		}
		return string(encoded(v)), v, nil
	case "git_status", "git_diff":
		git, err := exec.LookPath("git")
		if err != nil {
			return "", nil, errors.New("Git unavailable; nothing installed")
		}
		git, err = filepath.Abs(git)
		if err != nil {
			return "", nil, err
		}
		args := []string{"--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + filepath.Join(e.Store.Root, "empty-hooks")}
		if op.Op == "git_status" {
			args = append(args, "status", "--short", "--untracked-files=normal", "--ignore-submodules=all")
		} else {
			args = append(args, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--relative", "--")
			for _, rel := range op.Paths {
				if filepath.IsAbs(rel) || strings.Contains(rel, "..") || strings.ContainsAny(rel, ":\\\x00") {
					return "", nil, errors.New("relative git path required")
				}
				args = append(args, rel)
			}
		}
		a, err := e.capture(ctx, CheckSpec{Program: git, Args: args, TimeoutSeconds: 60})
		if err != nil {
			return "", nil, err
		}
		return a.Summary, a, nil
	case "check":
		spec, ok := e.Checks[op.Check]
		if !ok {
			return "", nil, errors.New("check not owner-approved; no process started")
		}
		a, er := e.capture(ctx, spec)
		if er != nil {
			return "", nil, er
		}
		return a.Summary, a, nil
	default:
		return "", nil, errors.New("unsupported operation; no shell fallback")
	}
}
