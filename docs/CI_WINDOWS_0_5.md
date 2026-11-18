# Windows CI · Studio 0.5

This workflow is a source-level verification path, not a Windows 11 product acceptance test.

- `typescript`: existing TypeScript/SQL/UI-stub tests on Linux.
- `go-linux`: local_batch/diagnostic_sweep tests on Linux.
- `go-windows`: same Go tests and an unsigned Windows executable artifact.
- `rust-windows`: actual Rust core/host compilation and tests on Windows Server 2025.

## Cargo.lock bootstrap

The supplied 0.5 source archive has **no `native/Cargo.lock`**. The previous CI
stopped before compilation. CI now resolves a candidate lockfile, runs the
actual Rust tests, and uploads the candidate even if compilation fails. This
is intentionally **not** called a reproducible build: dependency resolution
can change between runs. After reviewing the dependency graph, commit the
accepted lockfile and switch the workflow to `cargo test --locked` without
`generate-lockfile`.

## Safety and interpretation

No model calls, secrets, GUI automation, browser tests, dev servers or privileged
Windows isolation are part of this workflow. Windows Server 2025 runner success
does not certify Windows 11, Tauri GUI, named-pipe ACLs, or a live Codex session.
The workflow intentionally does not run `studio-economy.exe launch`.

## Publishing

Do not apply this workflow to the old UI-TARS `main`. Upload the **complete**
Studio 0.5 tree to a dedicated `studio/*` branch and check the GitHub Actions
run for that commit. The existing `studio/native-ci` branch currently contains
only a toolchain probe, not the Studio source tree.
