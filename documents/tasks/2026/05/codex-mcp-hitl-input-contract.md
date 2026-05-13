---
date: "2026-05-13"
status: done
implements: [FR-L16, FR-L23]
tags: [codex, mcp, hitl, tool-observation]
related_tasks: [2026/05/codex-mcp-arguments-unwrapped.md]
---

# Codex MCP HITL Input Contract

## Goal

Make Codex MCP tool observation honor the runtime-neutral
`RuntimeToolUseInfo.input` contract so HITL interceptors receive the actual
tool argument object, not a Codex-specific wrapper.

## Overview

### Context

GitHub issue: <https://github.com/korchasa/ai-ide-cli/issues/4>.

During LumaTale run `20260513T161727`, Codex invoked the injected MCP tool
`flowai-workflow-hitl.request_human_input`. The MCP server returned
`{ok:true}`, but `flowai-workflow` did not enter waiting state, did not write
`hitl.jsonl`, and did not run Telegram ask/check scripts. The PM continued
autonomously and chose `source: hitl-delegate`.

The issue evidence shows Codex emitted a `mcp_tool_call` item whose
`arguments` field contained the HITL request JSON. The current conceptual lift
keeps that wrapper under `RuntimeToolUseInfo.input.arguments`, while the
engine expects `info.input.question` and `info.input.options`.

### Current State

- `FR-L16` defines `onToolUseObserved(info)` for Claude, Codex, and OpenCode.
- `codex/items.ts::parseExecItem()` lifts snake_case Codex exec items into
  `CodexConceptualItem`.
- For `mcp_tool_call`, `parseExecItem()` currently sets
  `input: { arguments: m.arguments, status: m.status }`.
- `codex/items.ts::parseAppServerItem()` lifts camelCase app-server items and
  currently preserves every key except `id` / `type`, including `arguments`
  and `status`, under `input`.
- `codex/run-state.ts::codexItemToToolUseInfo()` passes conceptual `input`
  through unchanged to `onToolUseObserved`.
- `codex/items_test.ts` currently asserts only input key presence, so it does
  not catch the nested MCP argument wrapper.
- `codex/process_test.ts` checks MCP name mapping but not HITL-shaped input or
  abort behavior.
- Existing related task:
  `documents/tasks/2026/05/codex-mcp-arguments-unwrapped.md`.
- `documents/requirements.md` links this task from `FR-L16` and `FR-L23`.
- `documents/index.md` lists `FR-L16` and `FR-L23`.

### Constraints

- HITL orchestration remains out of library scope per ADR-0002.
- The fix must stay in Codex adapter normalization, not in workflow-specific
  HITL code.
- `RuntimeToolUseInfo.input` must mean tool arguments across runtimes.
- Preserve Codex lifecycle metadata outside `input` when possible.
- App-server content extraction (`FR-L23`) depends on `parseAppServerItem()`;
  changing app-server MCP input requires explicit coverage that content
  extraction still exposes the intended tool payload.
- Follow TDD in the develop phase: baseline, RED, GREEN, REFACTOR, CHECK.

## Definition of Done

- [x] `FR-L16`: Codex exec `mcp_tool_call` observations expose
  `m.arguments` directly as `RuntimeToolUseInfo.input`. Test:
  `codex/items_test.ts::parseExecItem — mcp_tool_call unwraps arguments for runtime-neutral input`.
  Evidence: `NO_COLOR=1 deno test -A codex/items_test.ts`.
- [x] `FR-L16`: Codex `onToolUseObserved` receives direct HITL-shaped input
  and can return `abort` from a normalized request. Test:
  `codex/process_test.ts::invokeCodexCli — onToolUseObserved aborts Codex MCP HITL request`.
  Evidence: `NO_COLOR=1 deno test -A codex/process_test.ts`.
- [x] `FR-L16`: Codex app-server `mcpToolCall` parsing also exposes direct
  arguments as conceptual `input`. Test:
  `codex/items_test.ts::parseAppServerItem — mcpToolCall unwraps arguments for runtime-neutral input`.
  Evidence: `NO_COLOR=1 deno test -A codex/items_test.ts`.
- [x] `FR-L23`: Codex content extraction keeps a coherent MCP tool payload
  after app-server unwrapping. Test:
  `codex/content_test.ts::extractSessionContent — codex mcpToolCall unwraps arguments`.
  Evidence: `NO_COLOR=1 deno test -A codex/content_test.ts`.
- [x] `FR-L16` / `FR-L23`: SDS describes the final Codex MCP input contract
  if the implementation changes documented behavior. Test:
  `documents/design.md` manual — korchasa. Evidence:
  `manual — korchasa`.
- [x] `FR-L16`: Full verification passes after implementation. Test:
  `deno task check`. Evidence: `NO_COLOR=1 deno task check`.

## Solution

Chosen variant: 2 — unify MCP argument unwrapping for both Codex exec and
app-server conceptual parsers.

Implementation plan:

1. Baseline:
   - run `NO_COLOR=1 deno task check` before edits;
   - if baseline fails, stop and report the pre-existing failure before
     changing code.
2. RED tests for exec MCP:
   - update `codex/items_test.ts`;
   - add
     `parseExecItem — mcp_tool_call unwraps arguments for runtime-neutral input`;
   - use a `mcp_tool_call` with `server: "flowai-workflow-hitl"`,
     `tool: "request_human_input"`, `status: "completed"`, and
     `arguments: {question: "Pick?", options: [{label: "A"}]}`;
   - assert `input` equals `{question, options}`;
   - assert `input.arguments` and `input.status` are absent;
   - assert `name === "flowai-workflow-hitl.request_human_input"`;
   - assert `status` remains available as `CodexConceptualItem.status`.
3. RED tests for app-server MCP:
   - update `codex/items_test.ts`;
   - add
     `parseAppServerItem — mcpToolCall unwraps arguments for runtime-neutral input`;
   - use the camelCase equivalent item;
   - assert `input` equals the tool argument object and lifecycle `status`
     remains on `CodexConceptualItem.status`;
   - assert `name === "flowai-workflow-hitl.request_human_input"`;
   - add a malformed-arguments case proving missing, null, array, or string
     `arguments` becomes `{}` as parser tolerance for upstream wire drift.
4. RED test for observer abort:
   - update `codex/process_test.ts`;
   - add a stubbed Codex process scenario emitting `thread.started` and an
     `item.completed` with `mcp_tool_call`;
   - pass `onToolUseObserved` that checks `info.name ===
     "flowai-workflow-hitl.request_human_input"` plus
     `info.input.question` / `info.input.options`, then returns `"abort"`;
   - assert returned output has `is_error: true`, result
     `"Aborted by onToolUseObserved callback"`, and one
     `permission_denials[]` entry.
5. RED test for app-server content:
   - update `codex/content_test.ts`;
   - change or add the MCP case so `extractSessionContent(event)` yields a
     tool item whose `input` is the direct arguments object.
6. GREEN implementation:
   - in `codex/items.ts::parseExecItem()`, for `mcp_tool_call`, set
     `input` to `recordOrEmpty(m.arguments)` instead of
     `{arguments: m.arguments, status: m.status}`;
   - in `codex/items.ts::parseAppServerItem()`, special-case
     `mcpToolCall` so `input` is `recordOrEmpty(item["arguments"])` instead
     of the generic payload-minus-id-type map;
   - add a small local helper such as `recordOrEmpty(value)` that returns
     `value` only when it is a non-array object, otherwise `{}`.
7. Metadata and error handling:
   - keep lifecycle metadata on `CodexConceptualItem.status`;
   - do not put `status`, `server`, or `tool` into `input` for MCP calls;
   - keep `name` as `<server>.<tool>`;
   - if `arguments` is missing, null, a string, or an array, return `{}` as a
     deliberate parser-tolerance boundary; consumer validators remain
     responsible for rejecting malformed HITL payloads clearly.
8. Documentation:
   - update `documents/design.md` section `3.10.2` to state that MCP
     conceptual input is the direct tool argument object for both Codex
     protocols, while non-MCP app-server tools still preserve payload minus
     `id` / `type`;
   - update any wording in `runtime/AGENTS.md` only if implementation changes
     contradict its local guidance.
9. Verification:
   - run `NO_COLOR=1 deno test -A codex/items_test.ts`;
   - run `NO_COLOR=1 deno test -A codex/process_test.ts`;
   - run `NO_COLOR=1 deno test -A codex/content_test.ts`;
   - run cheap gates if docs or JSDoc changed:
     `NO_COLOR=1 deno fmt --check`, `NO_COLOR=1 deno lint .`,
     `NO_COLOR=1 deno doc --lint mod.ts`;
   - run final `NO_COLOR=1 deno task check`.

## Critique & Refinements

- Applied: add `FR-L23` to the task because variant 2 changes app-server
  content extraction behavior through `parseAppServerItem()`.
- Applied: reword malformed `arguments` handling as parser tolerance, not
  fail-fast validation.
- Applied: require tests to preserve MCP diagnostic identity through
  `name === "<server>.<tool>"`.
- Discarded: real HITL e2e coverage. The workflow HITL transport is outside
  this library; unit and stubbed process tests cover the library contract.

## Follow-ups

- None.
