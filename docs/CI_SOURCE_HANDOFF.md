# CI handoff: actual source versus toolchain-only GitHub branch

The linked GitHub repository `ilyasmaxutov/UI-TARS-desktop` is an older fork on `main`. At inspection, `studio/native-ci` contains only a toolchain probe and README. A successful run there does **not** compile Platform Studio.

The source archive contains the existing Studio 0.5 tree, diagnostic_sweep, TaskStore, Desk, Codex App Server adapter, and `.github/workflows/check.yml`. The CI workflow fails before build if required source paths or package identity are absent.

To enable CI, import this complete tree into a **new dedicated branch** (or replace the isolated `studio/native-ci` staging branch after verifying it contains no unrelated work). Do not overwrite `main`. Use Git credentials on the owner's machine or an authorized GitHub file-import mechanism. ZIP files placed in a repository are not automatically checked out as source.

Once imported, verify GitHub Actions jobs: `typescript`, `go-linux`, `go-windows`, `rust-windows`. Only mark `Windows native-built` when Rust and Go jobs finish successfully and their logs are inspected. A successful toolchain probe alone is insufficient. Do not run paid Codex tests automatically.
