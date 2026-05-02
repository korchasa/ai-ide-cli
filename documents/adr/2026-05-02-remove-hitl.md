---
id: ADR-0002
status: accepted
date: 2026-05-02
tags: [scope, hitl, breaking-change]
---
# Remove HITL From ai-ide-cli; Push To Consumers

## Context

The library currently ships a HITL (human-in-the-loop) layer:
top-level `hitl-mcp.ts` (208 LOC NDJSON MCP runner), per-runtime
`opencode/hitl-mcp.ts` and `codex/hitl-mcp.ts` aliases, `HitlConfig` /
`HumanInputRequest` types in [types.ts](../../types.ts), a `hitl` flag in
`RuntimeCapabilities`, a `hitl_request` field on `CliRunOutput`,
`extractHitlRequestFromEvent` in `opencode/events.ts`,
`extractCodexHitlRequest` in `codex/run-state.ts`, MCP injection via
`OPENCODE_CONFIG_CONTENT` and `--config mcp_servers.hitl.*` overrides,
plus a consumer-supplied `hitlMcpCommandBuilder` self-spawn contract.

The project vision in [AGENTS.md](../../AGENTS.md) defines this package
as "Library-only. No engine, no workflow, no domain logic." HITL is
exactly workflow: it intercepts a tool call mid-stream, kills the
process, normalizes a question, and expects the caller to feed an
answer back on the next turn. That coordination loop belongs in the
orchestration layer (e.g. `@korchasa/flowai-workflow`), not in a thin
CLI wrapper.

## Alternatives

- **A. Keep HITL as-is** — preserve current `HitlConfig`,
  `hitlMcpCommandBuilder`, MCP servers, and extraction pipeline.
  - Pros: zero churn for current consumers; HITL "just works" out of
    the box.
  - Cons: violates stated library scope; ~300+ LOC of MCP plumbing
    inside a wrapper; the consumer already supplies the builder, so
    the abstraction leaks into them anyway; expanding HITL semantics
    later (multi-question, structured forms, async resume) drags this
    library into orchestration.
  - Rejected because: contradicts the library's own scope statement
    and conflates transport with policy.

- **B. Move HITL to an opt-in sub-export** —
  `jsr:@korchasa/ai-ide-cli/hitl` so core consumers ignore it.
  - Pros: smallest behavioural break; HITL stays available for
    consumers that don't want a separate dep.
  - Cons: still maintained here; capability matrix and `CliRunOutput`
    must keep `hitl_request` / `hitl` fields for the sub-export to
    interoperate, so the surface doesn't actually shrink; gives the
    illusion of separation while keeping the cost.
  - Rejected because: doesn't reduce maintenance surface; just hides
    it behind a different path.

- **C. Lower-level "tool-call interception" hook** — replace HITL with
  a generic `onToolCall(event)` callback so consumers build HITL on
  top.
  - Pros: aligns with library scope (transport-only); maximally
    flexible.
  - Cons: still requires the library to inject a custom MCP server
    into OpenCode/Codex configs, which is the bulk of the
    maintenance; the abstraction is HITL-shaped because the underlying
    MCP injection is HITL-shaped.
  - Rejected because: most of the cost is the MCP injection, not the
    callback shape; a generic hook over the same plumbing pays nearly
    the full price.

- **D. (CHOSEN) Remove HITL entirely** — delete `hitl-mcp.ts`,
  `opencode/hitl-mcp.ts`, `codex/hitl-mcp.ts`; drop `HitlConfig`,
  `HumanInputRequest`, `hitlConfig`, `hitlMcpCommandBuilder`,
  `hitl_request` field, `hitl` capability flag, and HITL extractors
  from event modules. Push the concern to consumers — primarily
  `@korchasa/flowai-workflow`, which already owns the orchestration
  loop. Document the removal and the migration path.
  - Pros: aligns library with its stated scope; removes ~300 LOC plus
    types/tests; simplifies `CliRunOutput`, `RuntimeCapabilities`, and
    each runtime's event pipeline; removes the consumer-side
    `hitlMcpCommandBuilder` contract that already leaks orchestration
    into callers; future HITL evolution happens in the orchestration
    layer where it belongs.
  - Cons: breaking change → major version bump (1.0.0 or 0.x major
    pattern); downstream `@korchasa/flowai-workflow` must absorb the
    HITL MCP server and injection logic before this ships;
    Claude's `AskUserQuestion`-based HITL becomes a consumer concern
    (no library detection, just raw stream events).

## Decision

Adopt alternative **D**. Remove all HITL-related code, types, config
inputs, output fields, capability flags, extractors, MCP servers, and
documentation from `@korchasa/ai-ide-cli`. The next release is a
breaking major. Migration: `@korchasa/flowai-workflow` (the only known
HITL consumer of this library) takes ownership of the MCP servers
(`runOpenCodeHitlMcpServer`, `runCodexHitlMcpServer`, shared NDJSON
runner) and injects them via the runtime-neutral knobs that survive
(`extraArgs`, env, `mcpServers` if exposed, or stream-event observers).

## Consequences

- ~300 LOC + ~20 type/field surface points removed from the library;
  the wrapper concern shrinks back to "spawn, stream, normalize".
- Breaking change: `HitlConfig`, `HumanInputRequest`, `hitlConfig`,
  `hitlMcpCommandBuilder`, `hitl_request` field, and `hitl`
  capability all disappear from the public API. Major version bump
  required.
- Downstream `@korchasa/flowai-workflow` must absorb the HITL pipeline
  before upgrading to the new version, otherwise its HITL feature
  regresses. Coordinate the cut-over.
- SDS § 3.9, § 3.13, § related Codex/OpenCode component descriptions,
  and the capability matrix in [documents/design.md](../design.md) need
  HITL rows / sections deleted.
- SRS in [documents/requirements.md](../requirements.md) needs the
  HITL MCP contract assumption removed, the "HITL" definition deleted,
  the `hitl` capability flag and `hitl_request` field acceptance
  criteria stripped, and any `[x]` rows that depended on HITL changed
  or removed; FR-Ls covering HITL extraction and config injection are
  deleted (or marked superseded).
- README.md "HITL MCP self-spawn contract" section, capability table
  row, and HITL bullet under "Per-runtime defaults" are deleted; a
  short migration note replaces them.
- Tests under `opencode/process_test.ts`, `codex/process_test.ts`,
  and any HITL-specific suites are deleted or trimmed.
- This ADR does not modify SRS / SDS / code itself — it only records
  the decision. Implementation is a separate task; run
  `flowai-skill-plan` (or the appropriate planning skill) to schedule
  the deletion across SRS → SDS → code in that order.
- If a future need re-introduces HITL into the library scope, this
  ADR must be superseded by a new ADR documenting the scope shift.
