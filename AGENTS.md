# Platform Studio

The user's source requirements are authoritative. Read `docs/STATUS.md`, `docs/REQUIREMENTS.json`, and `docs/DECISIONS.md` before editing.

- Complete the assigned user outcome. Fix failures; do not substitute a status, mocked handler, or prose for an observable result.
- Write public responses in Russian and worker assignments in English. Preserve the user's original Russian goal. Never claim access to hidden reasoning.
- Do not launch applications, browsers, development servers, GUI automation, or Computer Use. Use compilation, CLI/API and static checks only. No paid/provider calls or weight downloads without explicit authorization.
- Production target: native Windows 11, Rust. No required Python, Java, PHP, Docker, WSL, or VM. Node is a build/CLI development tool, not a native runtime dependency.
- Isolated Platform remains behind accepted containment gates. The owner-approved separate Codex Direct profile may use an explicitly selected native Codex with read-only sandbox, no approval escalation, and explicit activation. It is not accepted platform isolation. No bypass flags or permissive fallback; no provider calls during this development session.
- Browser workbench is a built-in-only execution profile. It is NOT OS isolation. Native sources are UNBUILT until real target logs prove otherwise.
- Keep GUI, semantic graph, frozen run, artifacts, verification and publication distinct. UI must not authoritatively approve native runs by editing cached state.
- Preserve all PF001–PF096 and F01–F46 as open/partial obligations until their actual criteria pass. Unit tests do not close Windows gates or UX acceptance.
- Before parallel work, record owned paths, branch and task in `docs/WORK_QUEUE.json`. Never overwrite another agent's work. Use expected revisions for document writes.
- Append factual changes, checks and remaining gaps to `CHANGELOG.md` and update the queue. Keep untested claims explicit.
- Run `npm run verify` for TypeScript changes. Native checks use the pinned toolchain, reviewed Cargo.lock and CLI tests; no automatic app launch.
- The initial renderer is dependency-free DOM/SVG, not React Flow. A replacement must preserve contracts, import compatibility and user state.
