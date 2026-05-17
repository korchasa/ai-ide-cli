---
date: "2026-05-17"
status: done
implements: [FR-L37]
tags: [runtime, errors, telemetry, e2e]
related_tasks: []
---
# Runtime Error Handling

## Goal

Expose structured runtime failures without forcing consumers to parse
human-readable `error` strings. Known failures get precise subtypes; adapter-
confirmed unknown runtime failures get a generic `runtime_error`.

## Overview

### Context

The library already returns `RuntimeInvokeResult.error?: string` and has one
typed category, `error_category: "stream_stall"`, for OpenCode silent-stream
hangs. Runtime CLIs expose other failures through incompatible channels:
OpenCode logs upstream HTTP 401 / 402 / 403 / 429 internally; Cursor emits
Free-plan named-model failures on stderr after `system/init` and `user` but
before terminal `result`.

Earlier framing as "limit analysis" was too narrow. Cursor's observed
`Named models unavailable Free plans can only use Auto` is not quota, rate,
auth, context, or safety policy. It is a subscription / entitlement failure.
The public contract should therefore classify runtime problems, not only
limits.

### Current State

- `RuntimeInvokeResult.error` remains the stable human-readable surface.
- `RuntimeInvokeResult.runtime_error` is additive machine-readable metadata.
- `runtime/runtime-error-analysis.ts` is pure: no subprocesses, file access,
  environment mutation, or adapter calls.
- OpenCode upstream-fatal detections populate precise `runtime_error` facts.
- Cursor stderr process failures populate either `plan_limit` or generic
  `runtime_error`.

### Constraints

- Preserve old `error` strings.
- Do not add retry, wait, model-switch, or billing policy. Consumers decide.
- Do not classify ordinary prose as a runtime failure. Generic fallback is
  allowed only when an adapter already knows the process failed.
- Real-binary probes must be short, bounded, and avoid forced quota exhaustion.

## Definition of Done

- [x] FR-L37 SRS describes Runtime Error Analysis and the
      `RuntimeInvokeResult.runtime_error` contract.
- [x] Analyzer exports `analyzeRuntimeErrorSignal`, `RuntimeErrorAnalysis`,
      `RuntimeErrorAnalysisInput`, `RuntimeErrorKind`,
      `RuntimeErrorSource`, and `RuntimeErrorConfidence`.
- [x] Analyzer fixtures cover OpenCode quota/auth/policy/rate/context/token
      cases, Cursor `plan_limit`, generic adapter-confirmed `runtime_error`,
      and non-error false positives.
- [x] OpenCode upstream-fatal HTTP 401 / 402 / 403 / 429 preserves the
      existing `error` string and returns `runtime_error`.
- [x] Cursor stderr process failures preserve the existing `error` string and
      return either `plan_limit` or generic `runtime_error`.
- [x] Public API re-exports all analyzer symbols from root and runtime
      sub-paths.
- [x] SDS and README describe the narrow adapter integration boundary.
- [x] Full local verification passes with `NO_COLOR=1 deno task check`.

## Solution

Selected variant: one runtime-error analyzer plus adapter-confirmed
integration paths.

### Files

- `runtime/runtime-error-analysis.ts`
  - Exports `RuntimeErrorKind`:
    `"quota" | "rate_limit" | "context_window" | "token_budget" | "auth" |
    "policy" | "plan_limit" | "runtime_error"`.
  - Exports `RuntimeErrorSource`:
    `"stdout" | "stderr" | "event" | "log" | "error_string"`.
  - Exports `RuntimeErrorAnalysis` with `runtime?`, `source`, `kind`,
    `confidence`, `statusCode?`, `providerCode?`, `message`, `resetAt?`,
    `retryAfterSeconds?`.
  - `assumeRuntimeError` lets adapters get `kind: "runtime_error"` only after
    a confirmed runtime failure.
- `opencode/process.ts`
  - Wraps upstream-fatal detector output in an internal error carrying
    `runtime_error`.
- `cursor/process.ts`
  - Wraps non-zero stderr / missing-result process failures in an internal
    error carrying `runtime_error`.
- `mod.ts`, `runtime/index.ts`, `runtime/types.ts`, `deno.json`
  - Re-export the public analyzer types and sub-path entry.

### Verification

- `NO_COLOR=1 deno test -A --no-check runtime/runtime-error-analysis_test.ts cursor/process_test.ts opencode/process_upstream_fatal_test.ts e2e/runtime_error_analysis_e2e_test.ts`
- `NO_COLOR=1 deno doc --lint mod.ts`
- `NO_COLOR=1 deno doc --lint runtime/index.ts`
- `NO_COLOR=1 deno doc --lint runtime/types.ts`
- `NO_COLOR=1 deno task check`

### Follow-ups

- Add Claude / Codex wiring only after capturing real failure shapes.
- Consider mapping OpenCode stream stalls into `runtime_error` later; keep the
  existing `error_category` contract stable for now.
