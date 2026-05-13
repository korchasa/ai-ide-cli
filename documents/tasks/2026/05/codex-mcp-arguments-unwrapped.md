---
date: "2026-05-13"
status: done
implements: [FR-L16]
tags: [codex, mcp, hitl, tool-observation]
related_tasks: [2026/05/codex-mcp-hitl-input-contract.md]
---

# Codex MCP Arguments Unwrapped

## Goal

Fix Codex MCP tool observation so `RuntimeInvokeOptions.onToolUseObserved(info)`
receives the tool argument object directly in `info.input`, enabling HITL
interceptors to match `request_human_input` payloads without Codex-specific
wrapper handling.

## Overview

GitHub issue: <https://github.com/korchasa/ai-ide-cli/issues/4>.

Completion note:

- Implemented by the broader follow-up task
  `documents/tasks/2026/05/codex-mcp-hitl-input-contract.md`.
- Final scope unwraps MCP `arguments` for both Codex exec and app-server
  conceptual parsers.
- `documents/tasks/` is no longer ignored by `.gitignore`.

Observed failure:

- LumaTale autonomous SDLC run `20260513T161727` reached PM HITL.
- PM invoked injected MCP tool
  `flowai-workflow-hitl.request_human_input`.
- Codex surfaced the call as completed, but the workflow engine never entered
  waiting state, never wrote `hitl.jsonl`, and never ran Telegram ask/check
  scripts.
- The MCP call returned `{ok:true}`, PM continued, and selected
  `source: hitl-delegate` autonomously.

Current implementation:

- `codex/items.ts::parseExecItem()` handles `mcp_tool_call`.
- It builds conceptual item input as `{arguments: m.arguments, status: m.status}`.
- `codex/process.ts::codexItemToToolUseInfo()` passes that input through to
  `onToolUseObserved`.
- HITL code expects `RuntimeToolUseInfo.input` to be the actual tool arguments,
  e.g. `{question, options}`, not nested under `arguments`.

Relevant requirement:

- `FR-L16` requires `onToolUseObserved(info)` to fire for Codex
  `mcp_tool_call` items and deliver `{id, name, input, turn}`.

Planning constraints:

- Fix belongs in the Codex adapter normalization layer, not in HITL workflow
  code.
- Preserve runtime-neutral `RuntimeToolUseInfo` semantics.
- Preserve Codex item `status` metadata where useful, without leaking it into
  MCP argument payloads.
- Apply the same MCP argument contract to Codex exec snake_case items and
  app-server camelCase items.

## Definition of Done

- [x] `FR-L16`: Codex exec `mcp_tool_call` observations expose
  `m.arguments` directly as `RuntimeToolUseInfo.input`. Test:
  `codex/items_test.ts` covers `parseExecItem()` for MCP calls. Evidence:
  `deno test -A codex/items_test.ts`.
- [x] `FR-L16`: Codex `onToolUseObserved` receives direct HITL-shaped input and
  can abort based on it. Test: `codex/process_test.ts` covers an MCP
  observation with `{question, options}` input. Evidence:
  `deno test -A codex/process_test.ts`.
- [x] `FR-L16`: Codex app-server parser also exposes direct MCP arguments,
  matching the same contract. Test:
  `codex/items_test.ts` covers app-server MCP unwrapping. Evidence:
  `deno test -A codex/items_test.ts`.
- [x] `FR-L16`: Full project verification passes after the fix. Test:
  `deno task check`. Evidence: command output attached to implementation notes.

## Solution

Chosen variant: broader follow-up implementation in
`codex-mcp-hitl-input-contract.md` — unwrap MCP `arguments` for both Codex
exec and app-server conceptual parsers.

Implementation plan:

1. Add or update a RED test in `codex/items_test.ts` for a snake_case
   `mcp_tool_call` item whose `arguments` are `{question, options}`.
   Assert the conceptual item has:
   - `kind: "mcp_tool_call"`;
   - `name: "<server>.<tool>"`;
   - `input` equal to the argument object, not `{arguments: ...}`;
   - `status` preserved on `CodexConceptualItem.status`.
2. Change `parseExecItem()` for `mcp_tool_call`:
   - `input: recordOrEmpty(m.arguments)`;
   - keep `status: typeof m.status === "string" ? m.status : undefined`;
   - do not copy `status` into `input`.
3. Add or update RED tests for app-server MCP parsing and content extraction:
   - `parseAppServerItem()` exposes direct `arguments`;
   - `extractSessionContent()` emits tool content with direct MCP input;
   - malformed non-object `arguments` become `{}`.
4. Add or update a RED test in `codex/process_test.ts` proving
   `onToolUseObserved` receives direct HITL-shaped input and can return
   `"abort"` based on it.
5. Update SDS and runtime guidance so Codex MCP input is documented as direct
   `arguments` for both protocols.
6. Run targeted tests, then full check:
   - `deno test -A codex/items_test.ts`;
   - `deno test -A codex/process_test.ts`;
   - `deno test -A codex/content_test.ts`;
   - `deno task check`.

## Critique & Refinements

- The fix must stay in the Codex adapter boundary. Teaching HITL to accept
  `input.arguments` would preserve a leaked Codex wire shape in workflow code.
- This is a breaking shape change for any consumer that accidentally depended
  on the old `input.arguments` wrapper. That risk is acceptable because
  `FR-L16` defines the observed hook contract as `{id, name, input, turn}`;
  `input` should be the tool input, not adapter metadata.
- `status` must remain available on `CodexConceptualItem.status` so content
  extraction and diagnostics can keep using Codex execution state without
  polluting MCP tool arguments.
- `documents/tasks/` was removed from `.gitignore` so permanent task files can
  be committed normally.
