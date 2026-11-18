package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateStoreRenameRestartsWholeMeasurement(t *testing.T) {
	calls := 0
	size, err := measureWithAtomicRenameRetry(func() (int64, error) {
		calls++
		if calls < 3 {
			return 150, &os.PathError{Op: "lstat", Path: filepath.Join("packets", ".pending-314"), Err: os.ErrNotExist}
		}
		return 450, nil
	})
	if err != nil || size != 450 || calls != 3 {
		t.Fatal(size, calls, err)
	}
}
func TestPrivateStoreMissingCommittedFileNeverRetried(t *testing.T) {
	calls := 0
	want := &os.PathError{Op: "lstat", Path: filepath.Join("artifacts", "data.json"), Err: os.ErrNotExist}
	_, err := measureWithAtomicRenameRetry(func() (int64, error) { calls++; return 0, want })
	if !errors.Is(err, want) || calls != 1 {
		t.Fatal(calls, err)
	}
}
func TestPrivateStoreRenameRetryIsBoundedAndDoesNotIgnorePermission(t *testing.T) {
	calls := 0
	_, err := measureWithAtomicRenameRetry(func() (int64, error) {
		calls++
		return 0, &os.PathError{Op: "lstat", Path: ".pending-1", Err: os.ErrNotExist}
	})
	if calls != 4 || err == nil || !strings.Contains(err.Error(), "admission unavailable") {
		t.Fatal(calls, err)
	}
	calls = 0
	_, err = measureWithAtomicRenameRetry(func() (int64, error) {
		calls++
		return 0, &os.PathError{Op: "lstat", Path: ".pending-1", Err: os.ErrPermission}
	})
	if calls != 1 || !errors.Is(err, os.ErrPermission) {
		t.Fatal(calls, err)
	}
}
