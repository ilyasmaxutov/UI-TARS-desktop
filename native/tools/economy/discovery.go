package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Resolve the official npm native distribution without executing a cmd shim,
// a package manager, or scanning unrelated files. An explicit path always wins.
func resolveCodex(explicit string) (string, error) {
	if explicit != "" {
		return validateExecutable(explicit, runtime.GOOS == "windows")
	}
	p, err := exec.LookPath("codex")
	if err != nil {
		return "", errors.New("Codex не найден. Укажите --codex <путь к codex.exe>. Установка и сеть не запускаются")
	}
	if runtime.GOOS != "windows" {
		return validateExecutable(p, false)
	}
	return resolveWindowsCodex(p)
}
func validateExecutable(p string, windows bool) (string, error) {
	a, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if windows && !strings.EqualFold(filepath.Ext(a), ".exe") {
		return "", errors.New("требуется нативный codex.exe, не PowerShell/CMD-обёртка")
	}
	st, err := os.Stat(a)
	if err != nil || !st.Mode().IsRegular() {
		return "", errors.New("исполняемый файл Codex не найден")
	}
	return a, nil
}
func resolveWindowsCodex(found string) (string, error) {
	if strings.EqualFold(filepath.Ext(found), ".exe") {
		return validateExecutable(found, true)
	}
	dir := filepath.Dir(found)
	// npm global shim: <prefix>/codex.cmd with node_modules alongside it.
	// npm local shim: <project>/node_modules/.bin/codex.cmd.
	bases := []string{filepath.Join(dir, "node_modules", "@openai"), filepath.Join(filepath.Dir(dir), "@openai")}
	matches := []string{}
	for _, base := range bases {
		patterns := []string{
			filepath.Join(base, "codex", "vendor", "*-pc-windows-msvc", "codex", "codex.exe"),
			filepath.Join(base, "codex", "node_modules", "@openai", "codex-win32-*", "vendor", "*-pc-windows-msvc", "codex", "codex.exe"),
			filepath.Join(base, "codex-win32-*", "vendor", "*-pc-windows-msvc", "codex", "codex.exe"),
		}
		for _, pattern := range patterns {
			rows, _ := filepath.Glob(pattern)
			matches = append(matches, rows...)
		}
	}
	seen := map[string]bool{}
	unique := []string{}
	target := "x86_64-pc-windows-msvc"
	if runtime.GOARCH == "arm64" {
		target = "aarch64-pc-windows-msvc"
	}
	for _, p := range matches {
		if !strings.Contains(p, target) {
			continue
		}
		a, err := validateExecutable(p, true)
		if err == nil && !seen[a] {
			seen[a] = true
			unique = append(unique, a)
		}
	}
	sort.Strings(unique)
	if len(unique) == 1 {
		return unique[0], nil
	}
	if len(unique) > 1 {
		return "", errors.New("найдено несколько нативных Codex: укажите --codex явно, версия не выбирается молча")
	}
	return "", errors.New("найдена только CMD-обёртка Codex; укажите нативный codex.exe через --codex. Пакетный менеджер не запускается")
}
