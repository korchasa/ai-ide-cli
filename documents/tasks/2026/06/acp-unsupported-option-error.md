---
date: "2026-06-02"
status: done
implements: [FR-L39]
tags: [acp, transport, validation, fail-fast, ergonomics]
related_tasks:
  - 2026/05/acp-transport-poc.md
  - 2026/06/acp-surface-parity.md
  - 2026/06/acp-reliability-parity.md
  - 2026/06/acp-followups.md
  - 2026/06/acp-parity-closeouts.md
---

# ACP Transport — Explicit Error on Unsupported Option

## Goal

Make `transport: "acp"` fail fast and clearly when the caller sets an option
the ACP wire cannot honour. Today a subset of `RuntimeInvokeOptions` /
`RuntimeSessionOptions` is silently dropped on the ACP path; the consumer
sees a successful run with semantically different behaviour (resume that
didn't resume, `strictMcpConfig` that didn't strict-isolate, …). Replace
the silent drop with a synchronous typed throw at adapter entry, so the
mistake surfaces at the call site instead of as a hard-to-trace behavioural
drift.

## Overview

### Context

FR-L39 ships `transport: "acp"` as an opt-in alternate wire for three
pilot runtimes. Prior parity work (`acp-surface-parity`,
`acp-reliability-parity`) closed visible gaps: content extraction,
capability advertisement, runtime-error analysis, retry. One gap remains
unaddressed by design: **silent-drop options**.

Two existing mechanisms handle adjacent cases but do NOT cover this one:

- `collectDegradedOptions` (in `runtime/acp/mapping.ts`) emits warnings
  for four lossy options (`allowedTools`, `disallowedTools`,
  `settingSources`, `systemPrompt`) via `onCallbackError`. The contract
  is "we did something approximate" (e.g. `systemPrompt` is concatenated
  into the user prompt), so a warning is appropriate.
- `capabilitiesFor("acp")` downgrades `transcript`, `interactive`,
  `toolFilter`, `capabilityInventory` to `false`. A consumer that
  consults capabilities before setting the option avoids the problem.
  But the runtime check still trusts the caller — nothing throws.

The bug: a caller who does NOT consult capabilities first and passes
e.g. `resumeSessionId: "abc"` with `transport: "acp"` sees the run
succeed. The adapter calls `session/new` instead of `session/load`, so
no history is loaded. There is no warning, no error, no log line. The
consumer concludes "ACP resume works" until a downstream feature
inspects history and finds it empty. The same pattern applies to
`strictMcpConfig`, `agent`, `systemPromptFile`, `streamStallTimeoutSeconds`,
`streamLogPath`, `verbosity`, `onOutput`, `extraArgs`.

The fix is consistent with project rules ("fail fast, fail clearly", "do
not add fallbacks silently"). It is also consistent with how the CLI
adapters already behave for reserved flags — passing `--output-format`
in `extraArgs` to Claude throws synchronously.

### Current State

- `runtime/acp/adapter.ts:invokeViaAcp` / `openSessionViaAcp` —
  destructure only the fields the wire honours; the rest are read
  by-pass-through into the closure but never propagated to the wire.
  No validation step rejects unsupported fields.
- `runtime/acp/mapping.ts:collectDegradedOptions` — covers four lossy
  options with WARN semantics (not error). Returns
  `AcpDegradedOption[]`; routed via `OnCallbackError` (FR-L32) by the
  adapter.
- Silent-drop options that the adapter accepts but cannot honour:
  - `agent` — runtime-native agent selector; no ACP analog
  - `systemPromptFile` — Claude `--append-system-prompt-file` CLI flag
  - `resumeSessionId` — ACP has `session/load`; adapter only calls
    `session/new`
  - `extraArgs` — ACP has no CLI argv; the map has nowhere to land
  - `strictMcpConfig` — Claude `--strict-mcp-config` CLI flag
  - `streamStallTimeoutSeconds` — OpenCode CLI watchdog
  - `streamLogPath` — CLI stream dump path
  - `verbosity` — CLI formatter input
  - `onOutput` — terminal raw-line callback (not equivalent to
    `onEvent` / `onStderr`)

### Constraints

- **Default CLI transport stays byte-for-byte identical.** The new
  validation runs ONLY when `transport === "acp"`. Nothing on the CLI
  path changes.
- **Fail synchronously at the adapter entry**, before any subprocess is
  spawned. The error must surface as a thrown `Error` from
  `invokeViaAcp` / `openSessionViaAcp` (or as a rejected promise from
  the public dispatch `runtime/index.ts`) — NOT via `onCallbackError`,
  which is for non-fatal post-init callbacks.
- **Single error class with structured fields.** One thrown class
  (`AcpUnsupportedOptionError`) with `fields: string[]` so consumers
  can pattern-match programmatically. Re-export from `mod.ts` per JSR
  `private-type-ref` rule.
- **Preserve the existing `degradedOptions` contract** for the four
  lossy-but-handled fields. They continue to warn via
  `onCallbackError`, not throw. The new error covers strictly the
  silent-drop set.
- **Set membership is the source of truth, not heuristics.** A
  hardcoded `ACP_UNSUPPORTED_INVOKE_OPTIONS` / `…_SESSION_OPTIONS`
  array in `runtime/acp/mapping.ts` lists field names. Adding a new
  option to `RuntimeInvokeOptions` does NOT silently bypass the check
  — but a missing entry here would (intentional — additive nature of
  the options surface means each new field needs an explicit
  classify-and-mention decision).
- **Field detection is presence-based.** A field counts as "set" if
  its value is anything other than `undefined`. Empty arrays / empty
  strings / `0` / `false` all count as set — they encode caller
  intent. This is symmetric with how `collectDegradedOptions`
  treats them (`opts.allowedTools && opts.allowedTools.length > 0`
  for the lossy case — but lossy is exempt because it's a warning,
  not an error; for the error path, presence is the trigger).
- **`extraArgs` is the exception.** `validateReasoningEffort` and
  `validateToolFilter` already inspect it for reserved-key collision
  on the CLI path. On ACP the map has no destination at all — any
  non-empty `extraArgs` triggers the new error (no per-key inspection
  needed).
- **No breaking change to CLI path.** Field set on
  `RuntimeInvokeOptions` is unchanged; only ACP-dispatch behaviour
  shifts from silent-drop to throw.
- **TDD.** RED → GREEN → REFACTOR → CHECK on each commit.

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase creates
> them in the RED step. The plan fixes the test paths; nothing here
> claims existing coverage.

- [x] `runtime/acp/mapping.ts` exports
  `ACP_UNSUPPORTED_INVOKE_OPTIONS` and
  `ACP_UNSUPPORTED_SESSION_OPTIONS` — readonly tuples of field names
  on the two option types respectively. *(FR-L39. Test:
  `runtime/acp/mapping_test.ts::ACP_UNSUPPORTED_INVOKE_OPTIONS pins
  the invoke surface set` and
  `…::ACP_UNSUPPORTED_SESSION_OPTIONS pins the session surface set`.
  Evidence: `deno test -A --no-check runtime/acp/mapping_test.ts`.)*
- [x] `runtime/acp/mapping.ts` exports
  `collectUnsupportedOptions(kind, opts)` returning `string[]` —
  names of fields that are set on `opts` and listed in the relevant
  `ACP_UNSUPPORTED_*_OPTIONS` tuple. Pure, no side effects. Treats
  `undefined` and `null` as «unset»; for `extraArgs`, an empty map
  also counts as unset (matches engine cascade default). *(FR-L39.
  Test: `runtime/acp/mapping_test.ts::collectUnsupportedOptions
  returns [resumeSessionId, strictMcpConfig] when both are set on
  invoke` and `…::collectUnsupportedOptions treats null and empty
  extraArgs as unset` and `…::collectUnsupportedOptions surfaces
  empty-string systemPromptFile as set`. Evidence: `deno test -A
  --no-check runtime/acp/mapping_test.ts`.)*
- [x] `runtime/acp/errors.ts` exports `AcpUnsupportedOptionError
  extends Error` with `runtime: RuntimeId` and `fields: string[]`
  members; message reads `acp(<runtime>): unsupported option(s):
  <field1>, <field2> — drop them or use transport: "cli"`.
  *(FR-L39. Test:
  `runtime/acp/errors_test.ts::AcpUnsupportedOptionError carries
  runtime and field list`. Evidence: `deno test -A --no-check
  runtime/acp/errors_test.ts`.)*
- [x] `runtime/acp/adapter.ts:invokeViaAcp` calls
  `collectUnsupportedOptions(runtime, "invoke", opts)` at function
  entry, BEFORE spawning the front; throws
  `AcpUnsupportedOptionError` synchronously when the list is
  non-empty. The pre-existing `signal?.aborted` early-return check
  stays first. *(FR-L39. Test:
  `runtime/acp/adapter_test.ts::invokeViaAcp throws
  AcpUnsupportedOptionError when resumeSessionId is set` and `…::
  …extraArgs is non-empty`. Evidence: `deno test -A --no-check
  runtime/acp/adapter_test.ts`.)*
- [x] `runtime/acp/adapter.ts:openSessionViaAcp` mirrors the same
  check with the session field set. *(FR-L39. Test:
  `runtime/acp/adapter_test.ts::openSessionViaAcp throws
  AcpUnsupportedOptionError when strictMcpConfig is set`. Evidence:
  `deno test -A --no-check runtime/acp/adapter_test.ts`.)*
- [x] When BOTH unsupported AND degraded options are set, the throw
  wins (caller never sees the `degradedOptions` warning). Adapter
  validates BEFORE `reportDegradedOptions` is called, so the warn
  path is not triggered. *(FR-L39. Test:
  `runtime/acp/adapter_test.ts::invokeViaAcp throw precedes
  degraded-options warn`. Evidence: `deno test -A --no-check
  runtime/acp/adapter_test.ts`.)*
- [x] `mod.ts` re-exports `AcpUnsupportedOptionError`,
  `ACP_UNSUPPORTED_INVOKE_OPTIONS`, `ACP_UNSUPPORTED_SESSION_OPTIONS`
  so JSR `private-type-ref` stays clean — every public symbol
  reachable from `RuntimeAdapter.invoke` / `openSession` signature
  must be exported. *(FR-L39. Test: `deno publish --dry-run` clean.
  Evidence: `deno run -A scripts/check.ts`.)*
- [x] FR-L39 in `documents/requirements.md` gets one new Acceptance
  bullet for the error contract; surgical `**Tasks:**` back-pointer
  bullet appended to the existing FR-L39 list. *(FR-L39. Test:
  `grep -c "acp-unsupported-option-error" documents/requirements.md`
  returns `>= 1`. Evidence: `manual — korchasa`.)*
- [x] SDS §3.3 `runtime/acp/` summary lists `collectUnsupportedOptions`
  alongside `collectDegradedOptions`, noting "warn vs error split".
  *(FR-L39. Test: `grep -n "collectUnsupportedOptions"
  documents/design.md`. Evidence: `manual — korchasa`.)*
- [x] `runtime/CLAUDE.md` ACP transport bullet gains one line stating
  the synchronous-throw contract and naming
  `AcpUnsupportedOptionError`. *(FR-L39. Test: `grep -n
  "AcpUnsupportedOptionError" runtime/CLAUDE.md`. Evidence:
  `manual — korchasa`.)*
- [x] `documents/index.md` row for FR-L39 summary updated only if
  stale (idempotent). *(FR-L39. Test: `manual` — row check. Evidence:
  `manual — korchasa`.)*
- [x] `deno task check` green (fmt, lint, type check, full test
  suite, doc-lint, `deno publish --dry-run`). *(FR-L39. Test:
  implicit — pipeline gate. Evidence: `deno run -A scripts/check.ts`.)*

## Solution

Variant A — pure synchronous throw at adapter entry. Three commits,
each RED → GREEN → REFACTOR → CHECK.

### Step 0 — Baseline gate

`deno task check` must be green on the parent revision. If red, stop
and report (project rule: never layer on a red baseline).

### Step 1 — Pin the contract: type + helper + tests (RED)

Files created:

- `runtime/acp/errors.ts`:

  ```ts
  /**
   * Thrown synchronously by `invokeViaAcp` / `openSessionViaAcp`
   * when the caller set one or more options that the ACP wire cannot
   * carry. Carries the structured `fields` list so consumers can
   * pattern-match without parsing the message string.
   */
  export class AcpUnsupportedOptionError extends Error {
    readonly runtime: RuntimeId;
    readonly fields: readonly string[];
    constructor(runtime: RuntimeId, fields: readonly string[]) {
      super(
        `acp(${runtime}): unsupported option(s): ${fields.join(", ")} ` +
          `— drop them or use transport: "cli"`,
      );
      this.name = "AcpUnsupportedOptionError";
      this.runtime = runtime;
      this.fields = fields;
    }
  }
  ```

- `runtime/acp/errors_test.ts` — verifies constructor stores `runtime`
  / `fields`, message contains every field name and the
  `transport: "cli"` hint.

Files modified:

- `runtime/acp/mapping.ts` — append two pinned tuples and one pure
  helper:

  ```ts
  /**
   * Invoke-only options the ACP wire cannot carry. Adapter throws
   * `AcpUnsupportedOptionError` when any is set. Distinct from
   * `collectDegradedOptions` (warn-only, lossy-but-handled).
   *
   * Field notes:
   * - `agent` is a runtime-internal subagent selector (Claude
   *   `--agent`, OpenCode `--agent`). ACP fronts launch their own
   *   process and do not accept a sub-agent override on the wire.
   * - `resumeSessionId` could in principle map to ACP `session/load`
   *   when we implement it (see Follow-ups). Until then: throw.
   */
  export const ACP_UNSUPPORTED_INVOKE_OPTIONS = [
    "agent",
    "systemPromptFile",
    "resumeSessionId",
    "extraArgs",
    "strictMcpConfig",
    "streamStallTimeoutSeconds",
    "streamLogPath",
    "verbosity",
    "onOutput",
  ] as const;

  /**
   * Session-options counterpart. Subset of the invoke list — session
   * options omit one-shot fields (`streamLogPath`, `verbosity`,
   * `onOutput`, `streamStallTimeoutSeconds` are not on
   * `RuntimeSessionOptions`).
   */
  export const ACP_UNSUPPORTED_SESSION_OPTIONS = [
    "agent",
    "resumeSessionId",
    "extraArgs",
    "strictMcpConfig",
  ] as const;

  /**
   * Pure: return the names of fields that are set on `opts` and
   * listed in the relevant pinned tuple. Presence-based (anything
   * other than `undefined` counts as set); for `extraArgs`, a map
   * with zero entries does NOT count (empty map is the default).
   */
  export function collectUnsupportedOptions(
    kind: "invoke" | "session",
    opts: Record<string, unknown>,
  ): string[] {
    const set = kind === "invoke"
      ? ACP_UNSUPPORTED_INVOKE_OPTIONS
      : ACP_UNSUPPORTED_SESSION_OPTIONS;
    const out: string[] = [];
    for (const field of set) {
      const value = opts[field];
      if (value === undefined) continue;
      if (value === null) continue;
      if (
        field === "extraArgs" &&
        typeof value === "object" &&
        Object.keys(value as Record<string, unknown>).length === 0
      ) {
        continue;
      }
      out.push(field);
    }
    return out;
  }
  ```

- `runtime/acp/mapping_test.ts` — three new cases:
  1. Pins `ACP_UNSUPPORTED_INVOKE_OPTIONS` shape (snapshot the
     tuple to catch accidental additions / deletions).
  2. Pins `ACP_UNSUPPORTED_SESSION_OPTIONS` shape.
  3. `collectUnsupportedOptions("invoke", {resumeSessionId: "x",
     strictMcpConfig: true, extraArgs: {}})` → `["resumeSessionId",
     "strictMcpConfig"]` (empty `extraArgs` skipped; the two set
     fields surface in declaration order).
  4. `collectUnsupportedOptions("invoke", {extraArgs: {"--foo":
     "bar"}})` → `["extraArgs"]` (non-empty map IS unsupported).
  5. `collectUnsupportedOptions("session", {streamLogPath: "/tmp/x"})`
     → `[]` (field not on session list — session is a strict
     subset).

Error-handling strategy: helper is pure, never throws. Adapter
throws synchronously at entry — the throw IS the error-handling
mechanism (no try/catch needed in the adapter, the outer dispatch
in `runtime/index.ts` already lets typed errors propagate).

Commit: `feat(runtime/acp): collectUnsupportedOptions + error class (FR-L39)`.

### Step 2 — Wire into adapter entry points (GREEN)

Edit `runtime/acp/adapter.ts`:

- `invokeViaAcp` — insert the check IMMEDIATELY after the
  `signal?.aborted` early-return, BEFORE the retry loop. Casting
  `opts` to `Record<string, unknown>` is fine — `collectUnsupportedOptions`
  reads by name and the tuple membership is type-pinned by the
  `as const` declaration.

  ```ts
  if (opts.signal?.aborted) return { error: "Aborted before start" };
  const unsupported = collectUnsupportedOptions(
    "invoke",
    opts as unknown as Record<string, unknown>,
  );
  if (unsupported.length > 0) {
    throw new AcpUnsupportedOptionError(runtime, unsupported);
  }
  // …existing retry loop unchanged
  ```

- `openSessionViaAcp` — same shape, at the top of the function
  (before `spawnClient`). No early-abort symmetry needed; session
  open has no aborted-before-start branch today.

  ```ts
  // NOTE: throw lives at the factory entry, NOT in
  // `AcpRuntimeSession`'s constructor — the class is module-private,
  // so unit tests cannot bypass validation by constructing it
  // directly without also importing it (which they don't).
  const unsupported = collectUnsupportedOptions(
    "session",
    opts as unknown as Record<string, unknown>,
  );
  if (unsupported.length > 0) {
    throw new AcpUnsupportedOptionError(runtime, unsupported);
  }
  ```

New tests in `runtime/acp/adapter_test.ts`:

- `invokeViaAcp throws AcpUnsupportedOptionError when resumeSessionId is set` —
  builds minimal `RuntimeInvokeOptions` with `resumeSessionId: "x"`,
  expects `assertThrows` (sync) OR `assertRejects` with
  `AcpUnsupportedOptionError` (whichever matches the actual call
  shape — `invokeViaAcp` is `async`, so the throw becomes a rejection).
  Asserts `err.fields` contains `"resumeSessionId"` and only that.
- `invokeViaAcp throws … with multiple fields listed in declaration order` —
  set `resumeSessionId` + `strictMcpConfig` + `extraArgs`,
  expect `err.fields` `["resumeSessionId", "extraArgs",
  "strictMcpConfig"]` (declaration order, not alphabetical — pinned
  by tuple).
- `invokeViaAcp does NOT throw on empty extraArgs map` — the map-shape
  default the runtime registers shouldn't trip the check.
- `invokeViaAcp does NOT throw on degraded-but-handled options` —
  `allowedTools: ["Read"]`, `systemPrompt: "x"` set → no throw
  (those remain on the `degradedOptions` warn path).
- `invokeViaAcp throw precedes degraded-options warn` — set both
  `allowedTools: ["Read"]` (degraded) AND `resumeSessionId: "x"`
  (unsupported); spy on `onCallbackError`; assert it was NEVER
  called (the throw fired first, the warn loop never executed).
- `openSessionViaAcp throws AcpUnsupportedOptionError when strictMcpConfig is set` —
  parallel to invoke.
- `openSessionViaAcp accepts session-allowed surface unchanged` —
  no unsupported fields → returns `RuntimeSession` instance (stub
  client to avoid spawning).

No live binary needed; the existing `adapter_test.ts` already uses
stubbed `AcpStdioClient` patterns.

REFACTOR: none. The two adapter entry checks are 4 lines each;
extracting a shared inline helper would obscure the call site.

CHECK: `deno task check` — full pipeline. The throw lands BEFORE any
subprocess spawn so existing stub tests don't need to handle a
half-spawned client.

Commit: `feat(runtime/acp): throw AcpUnsupportedOptionError at adapter entry (FR-L39)`.

### Step 3 — Public re-export + docs

Edit `mod.ts`:

```ts
export { AcpUnsupportedOptionError } from "./runtime/acp/errors.ts";
export {
  ACP_UNSUPPORTED_INVOKE_OPTIONS,
  ACP_UNSUPPORTED_SESSION_OPTIONS,
  collectUnsupportedOptions,
} from "./runtime/acp/mapping.ts";
```

Rationale: `AcpUnsupportedOptionError` is reachable from
`RuntimeAdapter.invoke` (it can throw it) — JSR slow-types requires
the class to be exported. The two tuples + helper are not strictly
on a public signature, but exporting them is cheap and lets
consumers do their own pre-flight validation. Verify via
`deno publish --dry-run` as the last gate.

Edit `documents/requirements.md` — append one Acceptance bullet
under FR-L39:

```markdown
- [x] `transport: "acp"` adapters throw `AcpUnsupportedOptionError`
      synchronously when the caller sets any option from
      `ACP_UNSUPPORTED_INVOKE_OPTIONS` /
      `ACP_UNSUPPORTED_SESSION_OPTIONS` (silent-drop fields like
      `resumeSessionId`, `strictMcpConfig`, `extraArgs`,
      `streamStallTimeoutSeconds`, `verbosity`, `streamLogPath`,
      `onOutput`, `agent`, `systemPromptFile`). Distinct from the
      lossy `collectDegradedOptions` warn path which stays
      unchanged. Test: `runtime/acp/adapter_test.ts::invokeViaAcp
      throws AcpUnsupportedOptionError when resumeSessionId is set`.
```

Surgical `**Tasks:**` back-pointer: append
`, [acp-unsupported-option-error](tasks/2026/06/acp-unsupported-option-error.md)`
to the existing FR-L39 `**Tasks:**` line (handled by the plan-skill
during step 5c, NOT in this implementation step).

Edit `documents/design.md` §3.3 `runtime/acp/` summary — one
sentence after the existing `collectDegradedOptions` description:

> `collectUnsupportedOptions` mirrors the warn-only
> `collectDegradedOptions` but classifies fields the ACP wire
> cannot carry at all. Adapter entry throws
> `AcpUnsupportedOptionError` synchronously when its result is
> non-empty.

Edit `runtime/CLAUDE.md` — one line under the existing **`acp`
transport** bullet:

> Adapter entry validates options against
> `ACP_UNSUPPORTED_{INVOKE,SESSION}_OPTIONS` and throws
> `AcpUnsupportedOptionError` synchronously when any silent-drop
> field is set (`resumeSessionId`, `strictMcpConfig`, `extraArgs`,
> `streamStallTimeoutSeconds`, `verbosity`, `streamLogPath`,
> `onOutput`, `agent`, `systemPromptFile`). Lossy-but-handled fields
> (`allowedTools`, `disallowedTools`, `settingSources`,
> `systemPrompt`) remain on the warn path via
> `collectDegradedOptions` → `onCallbackError`.

CHECK: `deno run -A scripts/check.ts` — full pipeline. JSR slow-types
gate is the last step; failure here means a public type wasn't
re-exported.

Commit: `docs(runtime,srs): document ACP unsupported-option error (FR-L39)`.

### Files to create

- `runtime/acp/errors.ts`
- `runtime/acp/errors_test.ts`

### Files to modify

- `runtime/acp/mapping.ts` — add tuples + helper
- `runtime/acp/mapping_test.ts` — pin tuples, exercise helper
- `runtime/acp/adapter.ts` — throw at entry of `invokeViaAcp` /
  `openSessionViaAcp`
- `runtime/acp/adapter_test.ts` — 6 new throw / no-throw cases
- `mod.ts` — re-export class + tuples + helper
- `documents/requirements.md` — one Acceptance bullet + `**Tasks:**`
  back-pointer under FR-L39
- `documents/design.md` — one sentence under §3.3
- `runtime/CLAUDE.md` — one line under the ACP transport bullet
- `documents/index.md` — verify FR-L39 row (idempotent)

### Files NOT to touch

- Any per-runtime CLI subtree (`claude/`, `opencode/`, `cursor/`,
  `codex/`) — CLI path is unchanged
- `runtime/index.ts` — public dispatch is unchanged; the throw
  propagates naturally
- `collectDegradedOptions` and its four-field set — warn path stays
  byte-identical
- `runtime/capability-types.ts` — capability surface unchanged; this
  task is orthogonal to `capabilitiesFor`

### Verification commands

- `deno test -A --no-check runtime/acp/` — focused suite during TDD
- `deno task test` — full unit suite before each commit
- `deno run -A scripts/check.ts` — final gate (fmt, lint, type
  check, full tests, doc-lint, `deno publish --dry-run`)
- Manual sanity check: `grep -nE "ACP_UNSUPPORTED|AcpUnsupportedOptionError" mod.ts runtime/acp/mapping.ts runtime/acp/errors.ts` — all three references present

### Risks (named, with mitigations)

- **Downstream breakage on `flowai-workflow`** — if it currently
  proxies a single options blob into both CLI and ACP, a previously
  silent-dropped `resumeSessionId` becomes a sync throw. Mitigation:
  (a) `AcpUnsupportedOptionError` carries `fields[]` so downstream
  can pattern-match and filter; (b) `collectUnsupportedOptions` is
  exported, so they can pre-flight; (c) before the next downstream
  bump that picks this version up, run the workflow unit suite
  against a local link.
- **Tuple drift vs `RuntimeInvokeOptions` evolution** — adding a
  new option field without classifying it (degraded vs unsupported
  vs honoured) means it's silently dropped again. Mitigation: pinned
  tuple snapshot test (step 1, case 1) keeps the set explicit; a
  future PR adding a field to `RuntimeInvokeOptions` must touch
  either this tuple, `collectDegradedOptions`, or the wire mapper —
  one of the three.
- **`extraArgs` empty-map detection nuance** — engine `NodeConfig`
  cascade resolves to `{}` even when the user wrote nothing. Empty
  map MUST be allowed through (the cascade default). Pinned by the
  unit test "does NOT throw on empty extraArgs map" (step 2). Any
  refactor that changes the resolution default needs to revisit
  this case.

## Follow-ups

Non-blocking items deferred from critique triage:

- **Per-field JSDoc on `RuntimeInvokeOptions` / `RuntimeSessionOptions`.**
  A reader of the type doesn't see that e.g. `resumeSessionId` throws
  on ACP. One-line JSDoc addition per affected field would help, but
  spans ~9 fields across two files (`runtime/adapter-types.ts`,
  `runtime/session-types.ts`) and is better done as a documentation
  sweep, not bundled into the behavioural change. Schedule after the
  first downstream consumer hits the new throw and asks.
- **Public introspection pattern.** Consumers building UIs that gate
  controls per-transport may want to read
  `ACP_UNSUPPORTED_*_OPTIONS` or call `collectUnsupportedOptions`
  pre-flight. Both are exported but undocumented as a public
  pattern. Add a README section when the first consumer asks.
- **`resumeSessionId` promotion when `session/load` lands.** ACP
  spec defines `session/load` for resuming a persisted session.
  When we implement it: move `resumeSessionId` from
  `ACP_UNSUPPORTED_INVOKE_OPTIONS` to the handshake mapper (route
  to `session/load` instead of `session/new` when set). DoD on the
  promotion task: existing throw-tests flip to honoured-behaviour
  tests; the field stays mentioned in this section history.


