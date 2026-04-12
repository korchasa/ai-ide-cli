# SRS: AI IDE CLI — Index

Functional requirements for `@korchasa/ai-ide-cli` — thin wrapper around
agent-CLI binaries. Split across section files in
[requirements/](requirements/) to fit within the `Read` tool's 10k-token
limit. FR-IDs use `FR-L<N>` prefix (L = library). IDs are stable — never
renumber on move.

## Sections

- [00-meta.md](requirements/00-meta.md) — Intro, general description, NFR,
  interfaces (CLI invocation contracts per runtime).
- [01-core.md](requirements/01-core.md) — Runtime adapter abstraction,
  normalized output, process registry, per-runtime wrappers (Claude,
  OpenCode, Cursor).

## FR-L ID → Section File

- FR-L1  (Runtime Adapter Abstraction) → 01-core
- FR-L2  (Normalized Output Shape)     → 01-core
- FR-L3  (Process Registry)            → 01-core
- FR-L4  (Claude CLI Wrapper)          → 01-core
- FR-L5  (OpenCode CLI Wrapper)        → 01-core
- FR-L6  (Cursor CLI Wrapper)          → 01-core
- FR-L7  (Stream Event Formatting)     → 01-core
- FR-L8  (Repeated File Read Warning)  → 01-core
- FR-L9  (Custom Subprocess Environment) → 01-core
- FR-L10 (Raw NDJSON Event Callback)     → 01-core
- FR-L11 (Skill Model)                  → 01-core
- FR-L12 (Interactive Mode)             → 01-core
