---
date: "2026-06-01"
status: done
implements: [FR-L37, FR-L39]
tags: [acp, transport, parity, runtime-error, retry, reliability]
related_tasks:
  - 2026/05/acp-transport-poc.md
  - 2026/05/runtime-error-handling.md
  - 2026/06/acp-surface-parity.md
---

# ACP Transport — Adapter Reliability Parity (Error Analysis + Retry)

## Goal

Bring `transport: "acp"` (FR-L39) reliability semantics in line with
the CLI invokers. Two coupled changes:

- Wire `analyzeRuntimeErrorSignal` (FR-L37) to ACP failure surfaces
  so consumers can branch on
  `RuntimeInvokeResult.runtime_error.kind` (`quota`, `rate_limit`,
  `auth`, `policy`, `context_window`, `token_budget`, `plan_limit`,
  `runtime_error`) the same way they do on CLI.
- Add an `invokeViaAcp` retry loop with exponential backoff
  symmetric to `invokeClaudeCli` / `invokeOpenCodeCli` /
  `invokeCursorCli` / `invokeCodexCli`, driven by the existing
  `maxRetries` / `retryDelaySeconds` fields on
  `RuntimeInvokeOptions`.

The two are paired because retry decisions are driven by the
classifier output: rate-limit and quota errors are retryable
with backoff; auth / policy / context_window / refusal are
terminal. Splitting them across two tasks would synthesize a
classifier-to-retry interface seam that disappears as soon as
both land.

## Overview

### Context

PoC for `transport: "acp"` shipped on `feat-acp-transport`
(commit `6281ae3`, 2026-05-31). Sibling task
`acp-surface-parity.md` (this session) closes the consumer
surface gaps (FR-L23 + capabilities). This task closes the
adapter-reliability gaps so workflow engines, benchmarks, and
retry-aware consumers see the same behavioural shape on
`"cli"` and `"acp"`.

The two gaps in this scope:

- **Gap 3 — No `runtime_error` for ACP failures.** ACP exposes
  failures via three distinct surfaces:
  - **(a) JSON-RPC `error: { code, message, data }` envelopes**
    on `client.request()`. The PoC throws `AcpRpcError(message,
    code, data?)` from `runtime/acp/client.ts`. `invokeViaAcp`
    catches and surfaces them as
    `error: "acp(<runtime>): <message>\nstderr tail:\n<…>"` with
    no `error_category` / `runtime_error`.
  - **(b) `PromptResponse.stopReason ∈ { refusal, cancelled,
    max_tokens, max_turn_requests }`.** PoC surfaces these as
    `is_error: true` for `refusal` / `cancelled` only, and
    drops `max_tokens` / `max_turn_requests` entirely (no
    error flag, no classification).
  - **(c) stderr from the spawned front.** PoC tail-captures 10
    lines on the failure path but does not feed them through
    `analyzeRuntimeErrorSignal`.
  Result: consumers cannot distinguish a quota exhaustion from a
  refusal from a token-budget overflow on the ACP path —
  everything looks like a generic adapter error string. On the
  CLI path the same kind of failure surfaces with
  `runtime_error: { kind: "quota", confidence: "high", … }`.

- **Gap 4 — `invokeViaAcp` has no retry loop.** The four CLI
  invokers share a retry pattern: spawn → run → on retryable
  failure, exponential-backoff sleep → respawn. Driven by
  `maxRetries: number` (default 0 per
  `runtime/adapter-types.ts`) and `retryDelaySeconds: number`
  (default 1) on `RuntimeInvokeOptions`. The PoC `invokeViaAcp`
  ignores both fields — every attempt is single-shot. Consumers
  that set `maxRetries: 3` on a `rate_limit`-prone runtime see
  exactly one attempt on ACP and four on CLI, asymmetrically.

### Current State

- `runtime/runtime-error-analysis.ts` — pure classifier;
  accepts `{ source, text?, event?, runtime?,
  assumeRuntimeError? }`. No ACP-specific patterns yet but the
  generic patterns cover most ACP messages
  (`rate limit`, `quota exceeded`, `invalid api key`, etc.).
- `runtime/acp/adapter.ts:invokeViaAcp` — 144 LOC of single-shot
  request/response with `try`/`catch` → `error: "acp(...): ..."`.
  No retry; no `runtime_error` field set; partial `is_error`
  handling for two of four `stopReason` values.
- `runtime/acp/client.ts:AcpRpcError` — exported error type with
  `code` (numeric) and `data?` fields. `message` already carries
  the wire `error.message`.
- `runtime/acp/adapter_test.ts` — covers happy path + abort
  contract. No retry-loop coverage; no `runtime_error` assertions.
- CLI invokers: `claude/process.ts` retry loop (lines 52-91) is
  the canonical shape — sleep is abortable, retries on exception
  OR `is_error: true`, max-retries default 0.

### Constraints

- **Pure classifier stays pure.** `analyzeRuntimeErrorSignal`
  must not gain ACP-specific call sites — only the adapter
  calls it. The adapter feeds `{ source: "error_string", text:
  err.message }` for `AcpRpcError`, `{ source: "stderr",
  text: stderrTail }` for the stderr tail, and synthesises a
  message for `stopReason` cases (no source change needed —
  reuse `"error_string"` with `assumeRuntimeError: true` for
  the synthetic `stopReason` → kind mapping).
- **`error` string remains human-readable and stable.** Adding
  `runtime_error` is purely additive; the existing `error: "acp(…)"`
  shape stays byte-for-byte for backwards compatibility with
  consumers that pattern-match on it.
- **No widening of public types.** `RuntimeInvokeResult.runtime_error`
  is already on the public type from FR-L37. No new fields.
- **Retry loop spawns a fresh client per attempt.** Each retry
  disposes the previous `AcpStdioClient` BEFORE spawning the
  next — no shared subprocess. Mirrors CLI loop's
  `Deno.Command` spawn-per-attempt semantics. The drain-race
  fix (`flushDrain`) runs inside each attempt.
- **`AbortSignal` is terminal.** A retry sleep that fires
  during abort rejects with `DOMException("Aborted",
  "AbortError")` and the loop exits with
  `error: "Aborted: <reason>"`. No further attempts. Mirrors
  FR-L15 contract.
- **Default `maxRetries: 0`** — single attempt unless the
  consumer opts in. No behavioural drift for callers that did
  not previously set `maxRetries`.
- **JSON-RPC `error.code` semantics.** ACP / JSON-RPC 2.0
  standard codes:
  - `-32700` parse error — terminal (programming bug).
  - `-32600` invalid request — terminal.
  - `-32601` method not found — terminal.
  - `-32602` invalid params — terminal.
  - `-32603` internal error — retryable (unspecified server
    issue).
  - Application range (`-32000` … `-32099`) — defer to message
    classifier; retryable iff classifier returns
    `rate_limit` / `quota` / `runtime_error`.
- **`stopReason` mapping**:
  - `end_turn` → `is_error: false`, no `runtime_error`.
  - `max_tokens` → `is_error: true`, `runtime_error: { kind:
    "token_budget", confidence: "high", message: "…" }`.
  - `max_turn_requests` → `is_error: true`, `runtime_error:
    { kind: "runtime_error", confidence: "medium", message:
    "max turn requests exceeded" }`.
  - `refusal` → `is_error: true`, `runtime_error: { kind:
    "policy", confidence: "high", message: "agent refused" }`.
  - `cancelled` → `is_error: true`, no `runtime_error` (this is
    consumer-initiated, not a runtime failure).
  - Unknown `stopReason` → `is_error: true`, `runtime_error:
    { kind: "runtime_error", confidence: "low", … }`.
- **TDD.** RED → GREEN → REFACTOR → CHECK on each commit. Two
  commits — error analysis first (Gap 3), then retry (Gap 4)
  consuming the classifier output.

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase
> creates them in the RED step. The plan fixes the test paths;
> nothing here claims existing coverage.

- [x] **Gap 3** — `invokeViaAcp` populates `RuntimeInvokeResult.runtime_error` for `AcpRpcError` failures: `error.code` -32xxx maps to retryability table (see Constraints); message is fed through `analyzeRuntimeErrorSignal({ source: "error_string", text: err.message, runtime })`. *(FR-L37. Test: `runtime/acp/error_analysis_test.ts::AcpRpcError surfaces runtime_error.kind on rpc failure path`. Evidence: `deno test -A --no-check runtime/acp/error_analysis_test.ts`.)*
- [x] **Gap 3** — `invokeViaAcp` populates `runtime_error` for `stopReason` ∈ {`max_tokens` → `token_budget`, `max_turn_requests` → `runtime_error`, `refusal` → `policy`}; `end_turn` and `cancelled` set `runtime_error: undefined`; unknown stop reasons fall through to `runtime_error: "runtime_error"` (low confidence). *(FR-L37. Test: `runtime/acp/error_analysis_test.ts::stopReason maps to runtime_error.kind table`. Evidence: `deno test -A --no-check runtime/acp/error_analysis_test.ts`.)*
- [x] **Gap 3** — stderr-tail failure path feeds `analyzeRuntimeErrorSignal({ source: "stderr", text: stderrTail })`; populated `runtime_error` does NOT overwrite an already-set classifier result from an `AcpRpcError` (RPC wins, stderr is the fallback). *(FR-L37. Test: `runtime/acp/error_analysis_test.ts::stderr tail used as fallback runtime_error source`. Evidence: `deno test -A --no-check runtime/acp/error_analysis_test.ts`.)*
- [x] **Gap 3** — Existing PoC adapter test (`runtime/acp/adapter_test.ts`) stays byte-for-byte green; new assertions live in `error_analysis_test.ts`. *(FR-L37. Test: `runtime/acp/adapter_test.ts` (regression). Evidence: `deno test -A --no-check runtime/acp/adapter_test.ts`.)*
- [x] **Gap 4** — `invokeViaAcp` honours `maxRetries` + `retryDelaySeconds` with exponential backoff (multiplier 2.0, matching `claude/process.ts`); retries iff (`AcpRpcError.code === -32603`) OR (`runtime_error.kind ∈ {rate_limit, quota, runtime_error}`) OR (unclassified spawn / drain exception); does NOT retry on `auth` / `policy` / `context_window` / `token_budget` / `plan_limit`. *(FR-L39. Test: `runtime/acp/retry_test.ts::invokeViaAcp retries on rate_limit and aborts on policy`. Evidence: `deno test -A --no-check runtime/acp/retry_test.ts`.)*
- [x] **Gap 4** — Retry sleep is abortable via `opts.signal`; abort during sleep returns `error: "Aborted: <reason>"` with no further attempts (mirrors FR-L15). *(FR-L39 + FR-L15. Test: `runtime/acp/retry_test.ts::retry sleep is abortable via external signal`. Evidence: `deno test -A --no-check runtime/acp/retry_test.ts`.)*
- [x] **Gap 4** — Each retry attempt spawns a fresh `AcpStdioClient`; the previous one is `dispose()`-d before the next spawn (no shared subprocess, no double-register on the supplied `ProcessRegistry`). Drain-race fix (`flushDrain`) runs inside every attempt. *(FR-L39. Test: `runtime/acp/retry_test.ts::each retry disposes previous client and re-runs flushDrain`. Evidence: `deno test -A --no-check runtime/acp/retry_test.ts`.)*
- [x] **Gap 4** — `error` string format for the final-failure path stays byte-for-byte the same as PoC for the unretried single-shot case (no behavioural drift for consumers with `maxRetries: 0`). *(FR-L39. Test: `runtime/acp/retry_test.ts::maxRetries 0 produces single-attempt error string identical to PoC shape`. Evidence: `deno test -A --no-check runtime/acp/retry_test.ts`.)*
- [ ] **SRS surgical updates.** FR-L37 gets one new Acceptance bullet for "Adapter integration boundary: ACP error envelopes routed through `analyzeRuntimeErrorSignal`"; FR-L39 gets one new Acceptance bullet for "Retry loop in `invokeViaAcp` with exponential backoff symmetric to CLI path". *(FR-L37 + FR-L39. Test: `grep -nE "ACP|invokeViaAcp.*retry" documents/requirements.md`. Evidence: `manual — korchasa`.)*
- [ ] **SRS back-pointers (FR-DOC-TASK-LINK).** Surgical `**Tasks:**` insert/extend under FR-L37 and FR-L39 in `documents/requirements.md` linking to this task. *(FR-L37 + FR-L39. Test: `grep -c "acp-reliability-parity" documents/requirements.md` returns 2. Evidence: `manual — korchasa`.)*
- [ ] **`deno task check` green** (fmt, lint, type check, full test suite, doc-lint, `deno publish --dry-run`). *(FR-L37 + FR-L39. Test: implicit — gates the entire pipeline. Evidence: `deno run -A scripts/check.ts`.)*

## Solution

Two commits, sequenced: Gap 3 first (the classifier output is the retry-decision input), Gap 4 second (consumes Gap 3's `runtime_error.kind`).

### Step 0 — Baseline gate

`deno task check` must be green on the parent revision. If red, stop and report.

### Step 1 — Gap 3 RED: error-analysis unit tests

Create `runtime/acp/error_analysis_test.ts` (stub-driven, no real binaries):

- **AcpRpcError path** — three fixtures: HTTP 429 wire message → `kind: "rate_limit", confidence: "high"`; "Invalid API key" → `kind: "auth"`; generic "Internal server error" with code -32603 → `kind: "runtime_error", confidence: "low"`.
- **stopReason path** — `max_tokens` / `max_turn_requests` / `refusal` / `end_turn` / `cancelled` / `unknown_reason` mapped per the table in Constraints.
- **stderr fallback** — RPC succeeds but exit-side stderr contains a quota-exhausted message → `kind: "quota"` populated from stderr tail.
- **Precedence — RPC over stderr** — RPC `runtime_error` wins over stderr `runtime_error` on the same call (RPC carries classified error; stderr also classifies; result keeps RPC).
- **Precedence — stderr fallback when RPC absent** — call succeeds at the RPC layer but stderr carries a classifiable quota / rate-limit message; result keeps stderr classification.
- **End-turn no-op** — `stopReason: "end_turn"` returns `runtime_error: undefined` and `is_error: false`.

Use the existing PoC bash-stub front pattern from `runtime/acp/adapter_test.ts` to inject crafted JSON-RPC responses.

Run `deno test -A --no-check runtime/acp/error_analysis_test.ts` — expect all assertions to fail (PoC produces no `runtime_error`).

### Step 2 — Gap 3 GREEN: implement classifier wiring

Refactor `invokeViaAcp` to thread `runtime_error` through the result path:

```ts
// runtime/acp/adapter.ts (sketch)
function classifyStopReason(
  stopReason: string,
  runtime: RuntimeId,
): RuntimeErrorAnalysis | undefined {
  switch (stopReason) {
    case "max_tokens":
      return analyzeRuntimeErrorSignal({
        runtime, source: "error_string",
        text: "max tokens exceeded",
        assumeRuntimeError: true,
      });
    case "max_turn_requests":
      return { runtime, source: "error_string", kind: "runtime_error",
               confidence: "medium", message: "max turn requests exceeded" };
    case "refusal":
      return { runtime, source: "error_string", kind: "policy",
               confidence: "high", message: "agent refused" };
    case "cancelled":
    case "end_turn":
      return undefined;
    default:
      return { runtime, source: "error_string", kind: "runtime_error",
               confidence: "low", message: `unknown stop reason: ${stopReason}` };
  }
}

function classifyRpcError(
  err: AcpRpcError,
  runtime: RuntimeId,
): RuntimeErrorAnalysis | undefined {
  return analyzeRuntimeErrorSignal({
    runtime, source: "error_string", text: err.message,
    assumeRuntimeError: true,
  });
}

function classifyStderrTail(
  text: string,
  runtime: RuntimeId,
): RuntimeErrorAnalysis | undefined {
  if (!text.trim()) return undefined;
  return analyzeRuntimeErrorSignal({ runtime, source: "stderr", text });
}
```

Wire into `invokeViaAcp` `try`/`catch`:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const stderrTail = client.stderr.trim().split("\n").slice(-10).join("\n");
  const rpcAnalysis = err instanceof AcpRpcError
    ? classifyRpcError(err, runtime) : undefined;
  const stderrAnalysis = rpcAnalysis ? undefined
    : classifyStderrTail(stderrTail, runtime);
  const runtimeError = rpcAnalysis ?? stderrAnalysis;
  const suffix = stderrTail ? `\nstderr tail:\n${stderrTail}` : "";
  if (abortedFor) return { error: `Aborted: ${abortedFor}` };
  return {
    error: `acp(${runtime}): ${message}${suffix}`,
    ...(runtimeError ? { runtime_error: runtimeError } : {}),
  };
}
```

Wire on the success path too — when `stopReason !== "end_turn"`, the result already exists; attach `runtime_error` next to `is_error: true`:

```ts
const stopReason = promptRes.stopReason ?? "end_turn";
const stopAnalysis = classifyStopReason(stopReason, runtime);
const isError = stopReason !== "end_turn" && stopReason !== "cancelled" ? true : stopReason === "cancelled";
const result = {
  runtime, result: collectedText.join(""), session_id: sessionId,
  duration_ms: durationMs, num_turns: turn, is_error: isError,
};
opts.hooks?.onResult?.(result);
return {
  output: result,
  ...(stopAnalysis ? { runtime_error: stopAnalysis } : {}),
};
```

Surface in SRS — append one Acceptance bullet to FR-L37:

> - [x] Adapter integration boundary: ACP JSON-RPC `AcpRpcError`, `PromptResponse.stopReason`, and stderr tail are funnelled through `analyzeRuntimeErrorSignal`; RPC wins over stderr; `runtime_error` is set on both success-with-`is_error` and failure-result paths of `invokeViaAcp`. Test: `runtime/acp/error_analysis_test.ts`.

Final check on this gap: `deno run -A scripts/check.ts`.

Commit: `feat(runtime): runtime_error analysis for ACP transport (FR-L37)`.

### Step 3 — Gap 4 RED: retry-loop tests

Create `runtime/acp/retry_test.ts` (stub-driven):

- **Retryable on rate_limit** — fixture front returns `AcpRpcError("rate limit exceeded", -32000)` on first attempt, success on second. `maxRetries: 1` → result is `is_error: false`, no `runtime_error`. Two `dispose()` calls observed.
- **Terminal on auth** — fixture returns `AcpRpcError("invalid api key", -32602)` repeatedly. `maxRetries: 3` → result has `runtime_error.kind === "auth"`, exactly one attempt.
- **Internal error retryable on -32603** — fixture returns `AcpRpcError("Internal server error", -32603)` twice, success on third. `maxRetries: 2` → three attempts, final success.
- **Abort during retry sleep** — fixture returns a transient error; consumer aborts during the backoff sleep. Result: `error: "Aborted: external abort"`, no further spawns.
- **Single-shot byte-stability** — `maxRetries: 0` (default) produces error string identical to PoC's existing assertion.
- **Drain-race re-run** — fixture emits delayed `agent_message_chunk` after `session/prompt` resolves on retry attempt. Both attempts observe the `flushDrain` budget; second attempt's `collectedText` non-empty.
- **`ProcessRegistry` accounting** — at the start of each attempt, the previous client is `dispose()`-d and unregistered from the supplied registry; the new client is registered fresh. Confirm zero leaked process refs after the loop exits.

### Step 4 — Gap 4 GREEN: implement retry loop

Hoist the existing single-shot body of `invokeViaAcp` into a private `attemptInvocation(...)` returning `RuntimeInvokeResult`. Wrap in a retry loop modelled on `claude/process.ts:invokeClaudeCli` (lines 52-91):

```ts
export async function invokeViaAcp(
  runtime: RuntimeId,
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  if (opts.signal?.aborted) return { error: "Aborted before start" };
  const maxRetries = opts.maxRetries ?? 0;
  const baseDelay = (opts.retryDelaySeconds ?? 1) * 1000;
  let lastResult: RuntimeInvokeResult | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await attemptInvocation(runtime, opts, attempt);
    if (!result.error && !result.output?.is_error) return result;
    if (!shouldRetry(result, attempt, maxRetries)) return result;
    lastResult = result;
    try {
      await abortableSleep(baseDelay * 2 ** attempt, opts.signal);
    } catch {
      return { error: "Aborted: retry sleep" };
    }
  }
  return lastResult ?? { error: `acp(${runtime}): exhausted retries` };
}

function shouldRetry(
  result: RuntimeInvokeResult,
  attempt: number,
  maxRetries: number,
): boolean {
  if (attempt >= maxRetries) return false;
  const kind = result.runtime_error?.kind;
  if (kind === "auth" || kind === "policy" || kind === "context_window" ||
      kind === "token_budget" || kind === "plan_limit") {
    return false;
  }
  if (kind === "rate_limit" || kind === "quota" || kind === "runtime_error") {
    return true;
  }
  // Unclassified error or no runtime_error — retry once like CLI loop.
  return !!result.error;
}
```

`abortableSleep` reuses the existing pattern from `claude/process.ts` — a rejecting `Promise` race between `setTimeout` and `signal.addEventListener("abort")` that throws `DOMException("Aborted", "AbortError")` on signal fire.

**Code-comment requirement (from critique #10):** the inline copy of `abortableSleep` in `runtime/acp/adapter.ts` must carry a one-line comment pointing at `claude/process.ts` as the original, so future readers can spot the duplication and trigger the "promote to shared helper" follow-up when a third caller appears.

`attemptInvocation` is the existing PoC body with one change: it must guarantee `client.dispose()` runs in the `finally` of EACH attempt so the next iteration sees a clean `ProcessRegistry`. The drain-race `flushDrain` stays inside the attempt body.

Surface in SRS — append one Acceptance bullet to FR-L39:

> - [x] `invokeViaAcp` retries on retryable failures (`rate_limit`, `quota`, `runtime_error`, JSON-RPC -32603, unclassified exception) with exponential backoff symmetric to CLI invokers. `maxRetries: 0` (default) preserves single-shot semantics. Abort during retry sleep is terminal. Test: `runtime/acp/retry_test.ts`.

Final check on this gap: `deno run -A scripts/check.ts`.

Commit: `feat(runtime): retry loop in invokeViaAcp (FR-L39)`.

### Step 5 — Final CHECK

`deno run -A scripts/check.ts`. The new error-analysis branch crosses no public API; the retry loop is internal to `runtime/acp/adapter.ts`. `deno publish --dry-run` should be a no-op delta.

### Files to create

- `runtime/acp/error_analysis_test.ts`
- `runtime/acp/retry_test.ts`

### Files to modify

- `runtime/acp/adapter.ts` — wire classifier on both success and failure paths; introduce `attemptInvocation` + retry loop; introduce `abortableSleep` helper (or reuse from `claude/process.ts` via re-export — verify cycle-safety with the `runtime/argv.ts` precedent).
- `documents/requirements.md` — surgical `**Tasks:**` back-pointer + new Acceptance bullets on FR-L37 and FR-L39.
- `documents/design.md` — surgical update under §3.3 (FR-L37 boundary list) and §3 ACP transport section.
- `documents/index.md` — verify FR-L37 / FR-L39 rows.

### Files NOT to touch

- `runtime/runtime-error-analysis.ts` — analyzer stays pure; no ACP-specific call sites inside it. Adapter feeds neutral strings.
- `runtime/acp/client.ts` — `AcpRpcError` already carries everything needed (`message`, `code`, `data`); no change.
- CLI invokers (`claude/process.ts`, `opencode/process.ts`, …) — retry loop pattern is COPIED conceptually, not refactored into a shared helper (premature; defer until at least two ACP-like transports exist).
- `mod.ts` — no new public types.

### Risks (named, with mitigations)

- **Abortable-sleep helper duplication.** `claude/process.ts` and `runtime/acp/adapter.ts` would both need an abortable sleep. Extracting to `runtime/abortable-sleep.ts` is tempting but risks cycle issues (the helper is leaf-pure but referenced from both CLI and ACP paths). Mitigation: copy the 8-line helper inline into `runtime/acp/adapter.ts` for now; promote to a shared module only if a third caller appears.
- **`shouldRetry` policy drift from CLI loop.** CLI loops use "retry on `is_error: true` OR exception". This task adds classifier-driven decisions on top. Document the new policy in `runtime/CLAUDE.md` so the asymmetry vs CLI is intentional, not accidental.
- **`runtime_error` source precedence (RPC wins over stderr).** A failure where the RPC carries a generic `"Internal error"` but stderr carries a specific `"Rate limit exceeded, retry in 30s"` would currently classify as `runtime_error: { kind: "runtime_error" }` and miss the `rate_limit`. Mitigation: if the empirical pass shows this is common, swap precedence (stderr wins iff `kind === "runtime_error"`); document the chosen rule.
- **Retry-loop subprocess accounting.** Each attempt registers a new `AcpStdioClient` with the supplied `ProcessRegistry`. If `dispose()` is racy on macOS (PoC saw `npx`-grandchild-holds-pipe issues), the registry may carry zombie refs through the retry loop. Mitigation: `attemptInvocation` `finally` block AWAITS `client.dispose()` before the loop iterates. The PoC already has `proc.stdout.cancel()` + 1-second drain race in dispose — sufficient.
- **Unclassified spawn-failure retries up to `maxRetries`.** When the binary is not on PATH or `npx` resolution fails, the spawn error is generic and the classifier returns `undefined`. `shouldRetry` then defaults to retrying (mirrors the CLI loop's "retry on exception" pattern). Consumers using `maxRetries: 3` with a misconfigured binary path see four spawn failures and four exponential-backoff sleeps. Mitigation: document the asymmetry in `runtime/CLAUDE.md` and recommend `maxRetries: 0` for binary-discovery-sensitive paths.
- **`max_turn_requests` classification weakness.** This is an ACP-specific budget signal with no neutral analog. Currently mapped to `kind: "runtime_error"` (low signal). If consumers actually want to branch on it (rare — engines usually just abort), a new `RuntimeErrorKind` value (`"max_turn_requests"`) would land in FR-L37. Out of scope here; document as a follow-up if it surfaces.

## Follow-ups

- Sibling task `acp-surface-parity.md` closes Gap 1 + Gap 2. Either task can land first — no code-level dependency between them. Default order: surface-parity first because the review surface is smaller.
- If `runtime_error.kind: "max_turn_requests"` becomes a real consumer need, extend FR-L37's `RuntimeErrorKind` union — new task.
- Promote `abortableSleep` to a shared `runtime/abortable-sleep.ts` once a third caller appears (FR-L38 retry?).
- E2E retry coverage: gated by `E2E=1` + per-runtime auth probe, exercises a real ACP front with a deliberately-broken first attempt (e.g. invalid api-key env on attempt 1, valid env on attempt 2). Out of scope here — write only after the live binary surfaces a deterministic retryable failure.
