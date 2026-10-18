---
date: "2026-10-18"
status: done
implements: [FR-L54, FR-L55, FR-L56, FR-L57, FR-L58, FR-L59, FR-L60, FR-L61]
tags: [acp, session, consumer]
related_tasks: []
---
# ACP session extensions for an acceptance-test harness

## Goal

Let a consumer drive an agent under test and an LLM judge over ACP sessions
with nothing of its own on the wire: the flowai acceptance runner and its
SWE-rebench benchmark replace their in-house ACP client with this library.

## Overview

### Context

The consumer needs, per session: permission requests auto-allowed, the
client filesystem served inside the sandbox, the Claude front's
`_meta.claudeCode.options`, and one front process per judge key serving
many short sessions.

### Current State

Permission answers were keyed on `type` (rejected by every front); sessions
could not pass `onToolUseObserved`; `fs` was always declined; `session/new`
carried no `_meta`; every `openSession` spawned its own front.

### Constraints

Additive only: unset options keep today's behaviour. Non-ACP transports
reject the new ACP-only options instead of ignoring them.

## Definition of Done

- [x] Permission answer in the protocol shape (FR-L54).
  - Test: `runtime/acp/permissions_test.ts::FR-L54 answers in the protocol's outcome shape`
  - Evidence: `deno test -A runtime/acp/permissions_test.ts runtime/acp/inbound_test.ts`
- [x] Session permission callback; non-ACP sessions refuse ACP-only options (FR-L55).
  - Test: `runtime/acp/session_options_test.ts::FR-L55 *`
  - Evidence: `deno test -A runtime/acp/session_options_test.ts`
- [x] Client filesystem with anchored reads and confined writes (FR-L56).
  - Test: `runtime/acp/session_options_test.ts::FR-L56 *`, `runtime/acp/client-fs_test.ts`
  - Evidence: `deno test -A runtime/acp/session_options_test.ts runtime/acp/client-fs_test.ts`
- [x] Session `_meta` (FR-L57).
  - Test: `runtime/acp/session_options_test.ts::FR-L57 session/new carries acpSessionMeta as _meta`
  - Evidence: `deno test -A runtime/acp/session_options_test.ts`
- [x] One front, many sessions (FR-L58).
  - Test: `runtime/acp/connection_test.ts::FR-L58 *`
  - Evidence: `deno test -A runtime/acp/connection_test.ts`
- [x] Turn-end never overtakes the turn's trailing chunks (FR-L59).
  - Test: `runtime/acp/session_options_test.ts::FR-L59 turn-end never overtakes the turn's last chunks`
  - Evidence: `deno test -A runtime/acp/session_options_test.ts --filter FR-L59`
- [x] Abort after the front died raises nothing uncaught (FR-L60).
  - Test: `runtime/acp/session_options_test.ts::FR-L60 abort after the front died raises nothing uncaught`
  - Evidence: `deno test -A runtime/acp/session_options_test.ts --filter FR-L60`
- [x] ACP usage carries the front's own total (FR-L61).
  - Test: `runtime/acp/mapping_test.ts::FR-L61 usageFromPromptResponse maps every ACP usage field, the total included`
  - Evidence: `deno test -A runtime/acp/mapping_test.ts runtime/acp/adapter_test.ts runtime/acp/session_contract_test.ts`

## Solution

`runtime/acp/permissions.ts` (shape), `runtime/session-types.ts` (three
options), `runtime/run-options.ts` (`ACP_ONLY_SESSION_OPTIONS`, used by the
four adapters), `runtime/acp/client-fs.ts` + `inbound.ts` (fs),
`mapping.ts` / `handshake.ts` (`_meta`, `initializeClient`,
`openSessionOnClient`), `adapter.ts` (`openAcpConnection`, session
lifecycle). Tests drive `runtime/acp/testdata/stub_front.ts`, a scriptable
front excluded from the published package.
