---
id: ADR-0003
status: accepted
date: 2026-05-03
tags: [scope, mcp, library-api]
---
# Generic Per-Invocation MCP-Server Registration

## Context

ADR-0002 removed HITL **semantics** but explicitly left the **transport**
layer (custom MCP server registration per invocation) as a generic
follow-up. Today consumers must hand-craft argv / env per runtime to
register an MCP server: `--mcp-config <path>` (Claude),
`OPENCODE_CONFIG_CONTENT` env var (OpenCode), or repeated
`-c mcp_servers.<name>.…` overrides (Codex). The library already owns
the wire knowledge — every adapter knows the native shape — but does
not expose a typed, runtime-neutral entry point.

`ExtraArgsMap = Record<string, string|null>` is single-valued and
cannot express Codex's repeated `--config` keys (N×2 tokens for N
servers); consumers therefore have no path at all on Codex without
re-implementing argv shaping outside the library.

The library already owns four equivalent abstractions where one
cross-runtime concept maps to runtime-specific native plumbing:
`permissionMode` (FR-L1), `allowedTools`/`disallowedTools` (FR-L24),
`reasoningEffort` (FR-L25), `settingSources` (FR-L18). All four follow
the same shape: typed field on `RuntimeInvokeOptions` /
`RuntimeSessionOptions`, shared validator in `runtime/<feature>.ts`,
per-adapter native mapping, capability flag, warn-once on unsupported
runtimes.

## Alternatives

- **A. Keep status quo — push consumers to hand-craft argv/env.**
  - Pros: zero library churn; no new public surface.
  - Cons: Codex impossible (no `ExtraArgsMap` shape for repeated keys);
    every consumer re-implements per-runtime wire knowledge the library
    already owns; HITL migration path from ADR-0002 stays incomplete
    for non-Claude runtimes.
  - Rejected because: ADR-0002 explicitly anticipated a generic
    `mcpServers` field; library owns the knowledge already; and Codex
    has no working path at all today.

- **B. Generic `extraEnv` / repeated-`extraArgs` extension.**
  - Pros: smaller, more general primitive (could solve future
    repeated-argv needs).
  - Cons: still pushes wire-shape knowledge (Claude tmp file lifecycle,
    OpenCode config-replacement semantics, Codex inline-table escaping)
    to every consumer; no shared validation; no warn-once on
    unsupported Cursor; no help with HTTP-vs-stdio runtime mismatch.
  - Rejected because: it solves the wrong abstraction layer — consumers
    don't want a more-general `extraArgs`, they want one MCP server
    field that just works.

- **C. (CHOSEN) Typed `mcpServers` field + capability flag, mirroring
  the FR-L24 / FR-L25 / FR-L18 pattern.**
  - Add `runtime/mcp-injection.ts` with `McpServerSpec` discriminated
    union (`stdio` / `http`), `McpServers` record type,
    `validateMcpServers` synchronous validator (shape + collision
    detection), and `renderMcpServersForJson` helper.
  - Add `mcpServers?: McpServers` to `RuntimeInvokeOptions` and
    `RuntimeSessionOptions`.
  - Add `mcpInjection: boolean` to `RuntimeCapabilities`. Claude /
    OpenCode / Codex `true`; Cursor `false`.
  - Per-adapter wiring:
    - Claude: write spec to a tmp file under
      `Deno.makeTempDir({prefix:"claude-mcp-"})`, emit
      `--mcp-config <path>`, cleanup in `finally` on every exit path.
      Optional `strictMcpConfig: true` additionally emits
      `--strict-mcp-config` to ignore `~/.claude.json` and project
      `.mcp.json`. Both flags live in
      `CLAUDE_INTENTIONALLY_OPEN_FLAGS` (legacy
      `extraArgs: { "--mcp-config": … }` keeps working when the
      typed field is unset; collision throws synchronously). Both
      stdio and HTTP server shapes accepted.
    - OpenCode: serialize spec into `OPENCODE_CONFIG_CONTENT` env var.
      Stdio shape `{mcp:{<name>:{type:"local",command:[cmd, …args],
      environment?, enabled:true}}}`; HTTP shape
      `{mcp:{<name>:{type:"remote", url, headers?, enabled:true}}}`.
      Collision with non-empty pre-existing env value throws. The
      env var is **merged** with the user's existing config sources
      per upstream — same-named entries override but siblings
      survive (auth, agents, model routing, user-defined MCP
      servers under different names).
    - Codex: emit `--config mcp_servers.<name>.command="…"` /
      `.args=[…]` / `.env={…}` for stdio, and
      `mcp_servers.<name>.url="…"` / `.http_headers={…}` for HTTP
      (codex-cli ≥ 0.124). Inline-table escaping via
      `JSON.stringify`. No explicit `type` discriminator upstream
      — presence of `command` vs `url` decides.
    - Cursor: validate, warn once per process, ignore.
  - Pros: aligns with established library pattern (4 prior typed
    options); restores transport ADR-0002 anticipated; closes Codex
    impossibility; uniform error messages; shared cleanup semantics
    for tmp files; HTTP transport available on every
    `mcpInjection: true` runtime (Claude / OpenCode / Codex ≥ 0.124).
  - Cons: new public surface (~4 types + 1 capability flag + 2 option
    fields); Cursor stays excluded until upstream lands a per-invocation
    flag.

## Decision

Adopt alternative **C**. Land FR-L35 in SRS, the `runtime/mcp-injection`
component in SDS, and the per-adapter wiring across Claude / OpenCode /
Codex / Cursor. Cursor remains capability-flagged off; HTTP support for
OpenCode and Codex is deferred to follow-ups.

## Consequences

- New SRS section `### 3.x FR-L35 Generic Per-Invocation MCP-Server
  Registration` with one acceptance criterion per per-runtime emission
  rule plus the shared validator rules.
- New SDS section `### 3.x runtime/mcp-injection.ts` plus per-adapter
  subsections describing rendering (Claude tmp-file lifecycle,
  OpenCode env-var replacement-not-merge semantics, Codex TOML
  inline-table escaping, Cursor warn-once).
- New `claude/mcp.ts` module (per-invocation tmp file + cleanup),
  mirroring `runtime/setting-sources.ts:prepareSettingSourcesDir`.
- `--mcp-config` added to `CLAUDE_RESERVED_FLAGS`; reserved-flag
  coverage test still green because the builder emits exactly when
  the typed field is set. Legacy `extraArgs` path preserved when the
  typed field is unset (collision is detected by the shared validator,
  not by the reserved-flag list).
- Public type surface grows: `McpServerSpec`, `McpStdioServer`,
  `McpHttpServer`, `McpServers` re-exported from `mod.ts`. JSR
  slow-types and JSDoc must cover them (caught by `deno publish
  --dry-run`).
- HITL migration path from ADR-0002 is now actionable for
  `@korchasa/flowai-workflow` on every runtime except Cursor:
  consumer registers its own MCP server through the typed field
  instead of hand-crafting argv per runtime.
- Follow-ups:
  - Cursor support once `cursor agent --mcp-config` (or equivalent)
    lands upstream — currently `capabilities.mcpInjection: false`,
    field is validated and dropped on the wire.
  - Real-binary E2E coverage (`e2e/mcp_injection_e2e_test.ts`) with a
    tiny stdio echo MCP server fixture.
  - Optional `bearer_token_env_var` field on `McpHttpServer` for
    Codex's auth-via-env-var convenience (currently consumers route
    bearer tokens via `headers: { Authorization: "Bearer …" }`).
- The implementation that follows this ADR adds
  `runtime/mcp-injection.ts` (validator + per-runtime renderers),
  `claude/mcp.ts` (tmp-file lifecycle), the `mcpInjection` capability
  flag on every adapter, and the `mcpServers` field on
  `RuntimeInvokeOptions` / `RuntimeSessionOptions`. SRS records the
  contract under FR-L35; SDS describes the per-adapter rendering rules
  and the validator. Public types
  (`McpServerSpec`, `McpStdioServer`, `McpHttpServer`, `McpServers`)
  are re-exported from `mod.ts` and `runtime/index.ts`.
