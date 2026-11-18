# Native delivery maintenance — actual checks and boundaries

Base: `8df259d92b4b30a9e0e0ff31cead52b18f50e12c`; original `3967b46` remains an ancestor.

## Actual work

- Restored the existing Git bundle and checked out its actual history.
- Baseline: Node 351/351; Go 107 top-level tests plus 10 nested cases.
- Changed desktop entrypoint from implicit `index.html` to `assistant.html`; fixed native version to 0.5.0.
- Windows script now builds all three required executables, checks generated inputs, invokes offline self-tests and records/verifies delivery hashes and x64 PE format.
- CI invokes the complete native script and retains compiler logs/lockfile even after failure.
- Implemented single-push publication using Git's existing authentication. Exact destination is `ilyasmaxutov/UI-TARS-desktop`, branch `studio/native-ci`. No `main`, force push or raw credentials.
- Added source for explicit local native selftest, entirely outside user data/profile, without Codex/API/IPC/GUI.

## Executed checks

- `npm run verify`: 367 tests passed; no failures/skips. Original test files unchanged.
- Seven new publisher tests use actual temporary Git repositories, commits, merges, pushes and readback; no GitHub network. Includes changed-remote race and preservation of main and owner edits.
- Nine new desktop-delivery checks include manifest corruption and missing-helper negative cases; synthetic PE fixtures test only byte/format validation, never executable behavior.
- `go test -race -count=1 -json ./...`: 107 top-level tests and 10 nested cases passed, no failure/skip.
- `go vet ./...`: successful.
- Fresh Go executable `selftest`: 20 real fixture operations, 11923 UTF-8 response bytes; 1048612 captured bytes, middle found, replay successful. Zero model calls.
- Windows Go test executable cross-compiled, not executed.
- Workflow YAML parsed, four jobs. Static checks are not a GitHub execution.

## Blocking observations

- GitHub connector in this session supplies read methods only; no create/update/push/dispatch write action is exposed.
- `git ls-remote` from the container: exit 128, cannot resolve github.com. No remote push attempted through that transport.
- Latest remotely observed branch still `07e246cd955472447b7e6bdc009310b51c50ab4e`. The sole observed Actions run is the old toolchain probe, not Studio.
- Rust toolchain and Windows unavailable in this container. Native code, PowerShell and real Windows binary startup not tested.
- No live model, user credentials, browser, GUI or dev server used. G1/G2/G3 remain open.

This is a real code correction and verified local Git publication implementation. It is NOT a published GitHub build or accepted native product.
