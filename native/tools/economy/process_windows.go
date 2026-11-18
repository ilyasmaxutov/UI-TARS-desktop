//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

// For owner-approved trusted checks only. This is cancellation, NOT a sandbox.
func configureProcess(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	c.Cancel = func() error {
		if c.Process == nil {
			return nil
		}
		system := os.Getenv("SystemRoot")
		if filepath.IsAbs(system) {
			k := exec.Command(filepath.Join(system, "System32", "taskkill.exe"), "/PID", strconv.Itoa(c.Process.Pid), "/T", "/F")
			k.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
			_ = k.Run()
		}
		return c.Process.Kill()
	}
}
