package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Store struct {
	Root     string
	Limits   Limits
	mu       sync.Mutex
	reserved int64
}
type Artifact struct {
	ID       string              `json:"id"`
	Kind     string              `json:"kind"`
	Created  string              `json:"created"`
	Files    map[string]FileSeal `json:"files"`
	Complete bool                `json:"complete"`
	ExitCode *int                `json:"exitCode,omitempty"`
	Reason   string              `json:"reason,omitempty"`
	Summary  string              `json:"summary"`
}
type FileSeal struct {
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func newStore(root string, lim Limits) (*Store, error) {
	a, e := filepath.Abs(root)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(a, 0700); e != nil {
		return nil, e
	}
	a, e = filepath.EvalSymlinks(a)
	if e != nil {
		return nil, e
	}
	for _, d := range []string{"artifacts", "packets", "gates"} {
		if e = os.MkdirAll(filepath.Join(a, d), 0700); e != nil {
			return nil, e
		}
	}
	return &Store{Root: a, Limits: lim}, nil
}

// An atomic journal commit can rename .pending-* between WalkDir and Info.
// Restart the whole measurement: ignoring that entry could omit the committed
// replacement. Only this known temporary-file race is retryable; missing
// artifacts, permissions, symlinks and quota errors remain failures. This is
// bounded application accounting, not an OS-level storage quota.
func measureWithAtomicRenameRetry(scan func() (int64, error)) (int64, error) {
	for attempt := 0; attempt < 4; attempt++ {
		n, err := scan()
		if err == nil {
			return n, nil
		}
		var pathErr *os.PathError
		if !errors.Is(err, os.ErrNotExist) || !errors.As(err, &pathErr) ||
			!strings.HasPrefix(filepath.Base(pathErr.Path), ".pending-") {
			return 0, err
		}
	}
	return 0, errors.New("private store changed during size measurement; local admission unavailable")
}

func (s *Store) free(need int64) error {
	_, err := measureWithAtomicRenameRetry(func() (int64, error) {
		var total int64
		err := filepath.WalkDir(s.Root, func(p string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.Type()&os.ModeSymlink != 0 {
				return errors.New("symlink in private store")
			}
			if !d.IsDir() {
				i, e := d.Info()
				if e != nil {
					return e
				}
				total += i.Size()
			}
			if total+need+s.reserved > s.Limits.StoreBytes {
				return errors.New("private store limit reached; archive or remove explicitly")
			}
			return nil
		})
		return total, err
	})
	return err
}
func (s *Store) reserveDir() (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.free(4096); e != nil {
		return "", "", e
	}
	id := uid("a_")
	p := filepath.Join(s.Root, "artifacts", id)
	e := os.Mkdir(p, 0700)
	return id, p, e
}
func (s *Store) save(kind string, data []byte, summary string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.free(int64(len(data)) + 4096); e != nil {
		return "", e
	}
	id := uid("a_")
	dir := filepath.Join(s.Root, "artifacts", id)
	if e := os.Mkdir(dir, 0700); e != nil {
		return "", e
	}
	f, e := os.OpenFile(filepath.Join(dir, "data.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return "", e
	}
	_, e = f.Write(data)
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e != nil {
		return "", e
	}
	a := Artifact{ID: id, Kind: kind, Created: now(), Files: map[string]FileSeal{"data.json": {int64(len(data)), digest(data)}}, Complete: true, Summary: cut(summary, 4096)}
	if e = atomicJSON(filepath.Join(dir, "manifest.json"), a); e != nil {
		return "", e
	}
	return id, nil
}
func (s *Store) manifest(id string) (Artifact, error) {
	var a Artifact
	if e := checkID(id); e != nil {
		return a, e
	}
	p := filepath.Join(s.Root, "artifacts", id)
	real, e := filepath.EvalSymlinks(p)
	if e != nil || real != p {
		return a, errors.New("artifact path invalid")
	}
	e = loadJSON(filepath.Join(p, "manifest.json"), &a, 1<<20)
	if e == nil && a.ID != id {
		e = errors.New("artifact identity mismatch")
	}
	return a, e
}
func (s *Store) open(id, name string) (*os.File, Artifact, error) {
	a, e := s.manifest(id)
	if e != nil {
		return nil, a, e
	}
	if _, ok := a.Files[name]; !ok {
		return nil, a, errors.New("unknown artifact stream")
	}
	if strings.ContainsAny(name, "/\\") || name == ".." {
		return nil, a, errors.New("invalid stream")
	}
	p := filepath.Join(s.Root, "artifacts", id, name)
	st, e := os.Lstat(p)
	if e != nil || !st.Mode().IsRegular() {
		return nil, a, errors.New("artifact not a regular file")
	}
	f, e := os.Open(p)
	if e == nil {
		info, er := f.Stat()
		if er != nil || info.Size() != a.Files[name].Bytes {
			f.Close()
			return nil, a, errors.New("artifact changed; size differs")
		}
	}
	return f, a, e
}
func (s *Store) inspect(op Operation) (string, any, error) {
	name := op.Stream
	if name == "" {
		a, e := s.manifest(op.Artifact)
		if e != nil {
			return "", nil, e
		}
		if a.Kind == "capture" {
			name = "stdout.log"
		} else {
			name = "data.json"
		}
	}
	f, a, e := s.open(op.Artifact, name)
	if e != nil {
		return "", nil, e
	}
	defer f.Close()
	if op.Length > 0 || op.Offset != 0 {
		if op.Offset < 0 || op.Length <= 0 || op.Length > s.Limits.ReadBytes {
			return "", nil, errors.New("byte range requires nonnegative offset and 1..65536 length")
		}
		b := make([]byte, op.Length)
		n, err := f.ReadAt(b, op.Offset)
		if err != nil && err != io.EOF {
			return "", nil, err
		}
		v := map[string]any{"artifact": op.Artifact, "stream": name, "offset": op.Offset, "bytes": n, "base64": base64.StdEncoding.EncodeToString(b[:n]), "captureComplete": a.Complete, "integrity": "bounded read; full SHA-256 not rechecked"}
		return string(encoded(v)), v, nil
	}
	if op.Query != "" {
		rows, coverage, e := searchReader(f, op.Query, s.Limits.CaptureBytes, 16)
		v := map[string]any{"artifact": op.Artifact, "stream": name, "matches": rows, "coverage": coverage, "captureComplete": a.Complete, "integrity": "bounded read; full SHA-256 not rechecked"}
		return string(encoded(v)), v, e
	}
	v, e := readLines(f, op.StartLine, op.Lines, s.Limits.ReadBytes, s.Limits.ScanBytes)
	if e != nil {
		return "", nil, e
	}
	v["artifact"] = op.Artifact
	v["stream"] = name
	v["captureComplete"] = a.Complete
	v["integrity"] = "bounded read; full SHA-256 not rechecked"
	return string(encoded(v)), v, nil
}
func writeNew(p string, b []byte) error {
	f, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	return e
}
func fileJSON(path string, v any) error { return writeNew(path, encoded(v)) }
func loadPacket(path string) (Packet, error) {
	var p Packet
	f, e := os.Open(path)
	if e != nil {
		return p, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 256*1024+1))
	if e != nil {
		return p, e
	}
	if len(b) > 256*1024 {
		return p, fmt.Errorf("packet too large")
	}
	e = strictDecode(b, &p)
	return p, e
}

func (s *Store) reserve(n int64) (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.free(n); err != nil {
		return nil, err
	}
	s.reserved += n
	return func() { s.mu.Lock(); s.reserved -= n; s.mu.Unlock() }, nil
}
