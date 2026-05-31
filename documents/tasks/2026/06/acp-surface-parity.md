---
date: "2026-06-01"
status: done
implements: [FR-L23, FR-L39]
tags: [acp, transport, parity, runtime, content, capabilities]
related_tasks:
  - 2026/05/acp-transport-poc.md
---

# ACP Transport — Consumer Surface Parity (Content + Capabilities)

## Goal

Make the runtime-neutral consumer surface honest about
`transport: "acp"` (FR-L39) for the two PoC-deferred follow-ups that
UI consumers see first: `extractSessionContent` (FR-L23) and
`RuntimeCapabilities` (advertised by every adapter).

Concrete payoff: a downstream UI (dashboard, IDE selector, replay
viewer) that already builds on `NormalizedContent` and
`adapter.capabilities` renders ACP turns at the same fidelity as
CLI turns — streaming text chunks, tool invocations, final reply —
and gates features (transcript copy, tool-filter UI, capability
inventory) correctly when the transport is opted-in.

## Overview

### Context

PoC for `transport: "acp"` shipped on `feat-acp-transport`
(commit `6281ae3`, 2026-05-31). Coverage analysis identified four
follow-up gaps; this task closes the two "consumer surface"
ones — i.e. what the consumer reads off the neutral types — and
the companion task `acp-reliability-parity.md` (sibling, this
session) closes the two "adapter reliability" ones.

The two gaps in this scope:

- **Gap 1 — `extractSessionContent` returns `[]` for ACP events.**
  `runtime/content.ts:extractSessionContent` dispatches on
  `event.runtime` and routes to one of four per-CLI extractors
  (`extractClaudeContent`, `extractCursorContent`,
  `extractCodexContent`, `extractOpenCodeContent`). ACP-shaped
  events carry the runtime id of the dispatch front (e.g.
  `"claude"`), so they route into `extractClaudeContent` — which
  expects stream-json shapes (`assistant` / `result`), not ACP's
  `session/update` wire shapes (`agent_message_chunk`,
  `tool_call_update`, `plan`, `current_mode_update`, …). Result:
  realistic ACP events normalize to `[]`. The PoC's
  `extractAgentChunkText` is a private projection inside
  `invokeViaAcp` feeding only `RuntimeInvokeResult.output.result`
  — it never reaches the FR-L23 surface.

- **Gap 2 — `RuntimeCapabilities` doesn't reflect transport.**
  Every `*-adapter.ts` exposes a single static `capabilities`
  field. When the consumer passes `transport: "acp"`, the
  capability values are still the CLI values — but ACP fronts
  honour `transcript: false` (no exported transcript file),
  `toolFilter: false` (no `--allowedTools` flag on the wire),
  `capabilityInventory: false` (`fetchCapabilitiesSlow` is
  unwired on the ACP path), and `interactive: false` (no
  TUI launcher). Consumers that read `adapter.capabilities` to
  gate features get the wrong answer silently.

### Current State

- `runtime/content.ts:107-125` — dispatcher switches on
  `event.runtime`. No transport awareness.
- `runtime/acp/mapping.ts:mapSessionUpdate` — returns
  `{ runtime, type: method, raw: params }` with no semantic
  projection. PoC comment at `runtime/acp/adapter.ts:308-312`
  explicitly notes "content-extractor dispatch (`runtime/content.ts`)
  for ACP is FR-L39 follow-up work".
- `runtime/capability-types.ts:4-72` — `RuntimeCapabilities` is a
  flat struct, no transport dimension.
- Each `*-adapter.ts` (claude / opencode / cursor / codex):
  `capabilities: { ... }` static field declared once at module
  load, returned as-is regardless of transport.
- `RuntimeAdapter` interface (`runtime/adapter-types.ts`) — only
  exposes `capabilities` field; no method that accepts a
  transport argument.

### Constraints

- **Backwards compatibility.** Default `transport === "cli"` must
  stay byte-for-byte identical for both extractor output and
  capability advertisement.
- **No new public ACP types.** Wire shapes stay private to
  `runtime/acp/`. The new extractor's public signature must use
  only existing neutral types (`NormalizedContent[]`,
  `RuntimeSessionEvent`, `RuntimeId`).
- **Aggregator rule.** `runtime/content.ts` is one of the two
  allowed `runtime/ → <runtime>/` aggregators (the other is
  `runtime/index.ts`). The new ACP-arm lives inside the
  dispatcher; it must import from `runtime/acp/content.ts`
  (new file), NOT from per-CLI subtrees.
- **`RuntimeSessionEvent` envelope stays at `{ runtime, type,
  raw, synthetic? }`** — no new fields. Transport is detected
  from `raw` shape ONLY (presence of ACP-specific keys like
  `update.sessionUpdate` / `sessionUpdate` at top level / method
  name `"session/update"` etc.).
- **Pilot list unchanged.** `cursor` stays `pilot: false`. The
  extractor must still work for any `RuntimeId` — the
  stub-based contract test (`runtime/acp/session_contract_test.ts`)
  exercises all four runtime ids.
- **Capability surface backward compat.** Adding
  `capabilitiesFor(transport)` on `RuntimeAdapter` is acceptable;
  removing or weakening the existing `capabilities` field is
  NOT. Consumers that currently read `adapter.capabilities`
  without a transport keep getting CLI capabilities (default).
- **JSR slow-types.** New types referenced in public signatures
  must be re-exported from `mod.ts` (the PoC's
  `AcpFrontLauncher` lesson applies here). Run
  `deno publish --dry-run` as the last gate.
- **No widening of `extractSessionContent` signature.** Stays
  `(event: RuntimeSessionEvent) => NormalizedContent[]`. The
  ACP-arm reads transport from `raw` shape only.
- **TDD.** RED → GREEN → REFACTOR → CHECK on each commit. Two
  commits — one per gap.
- **JSR slow-types.** `TransportOption` must be re-exported from
  `mod.ts` before Gap 2 ships — adding it to a public method
  signature on `RuntimeAdapter` triggers `private-type-ref`
  otherwise (PoC's `AcpFrontLauncher` lesson). Verify with
  `deno publish --dry-run` as part of every Gap 2 commit.

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase
> creates them in the RED step. The plan fixes the test paths;
> nothing here claims existing coverage.

- [x] **Gap 1** — `runtime/acp/content.ts:extractAcpContent(runtime, type, raw)` maps three ACP notification variants per pilot: `agent_message_chunk` → `NormalizedTextContent { cumulative: false }`; `tool_call_update` → `NormalizedToolContent`; unknown / synthetic → `[]`. *(FR-L23. Test: `runtime/acp/content_test.ts::extractAcpContent maps agent_message_chunk / tool_call_update for claude / codex / opencode`. Evidence: `deno test -A --no-check runtime/acp/content_test.ts`.)*
- [x] **Gap 1** — `runtime/content.ts:extractSessionContent` detects ACP-shaped events (`event.type === "session/update"` OR `raw.update.sessionUpdate` is string) and routes to `extractAcpContent`; CLI-shaped events continue to per-CLI extractors byte-for-byte. *(FR-L23. Test: `runtime/content_test.ts::extractSessionContent routes ACP-shaped events to ACP extractor and CLI-shaped events unchanged`. Evidence: `deno test -A --no-check runtime/content_test.ts`.)*
- [x] **Gap 1** — Documentation surgical edits: one bullet under "Per-runtime source events" in `runtime/CLAUDE.md`; one line under §3.3 `runtime/content.ts` in SDS describing the detection rule. *(FR-L23. Test: `grep -nE "ACP|session/update" runtime/CLAUDE.md documents/design.md`. Evidence: `manual — korchasa`.)*
- [x] **Gap 2** — `RuntimeAdapter.capabilitiesFor?(transport): RuntimeCapabilities` optional method. ACP path returns `transcript: false`, `interactive: false`, `toolFilter: false`, `capabilityInventory: false`, `mcpInjection: true`, `sessionFidelity: "native"`, preserving `permissionMode` / `toolUseObservation` / `session` / `reasoningEffort` from CLI baseline. Default (cli) returns `this.capabilities`. Cursor throws "not piloted yet" on `"acp"`. *(FR-L39. Test: `runtime/transport_capabilities_test.ts::capabilitiesFor downgrades transcript/interactive/toolFilter/capabilityInventory on ACP path for claude/codex/opencode`. Evidence: `deno test -A --no-check runtime/transport_capabilities_test.ts`.)*
- [x] **Gap 2** — Type signature `capabilitiesFor?(transport: TransportOption): RuntimeCapabilities` declared on `RuntimeAdapter` in `runtime/adapter-types.ts`; `deno publish --dry-run` clean (no slow-types / private-type-ref). *(FR-L39. Test: `runtime/adapter-types_test.ts::RuntimeAdapter.capabilitiesFor signature is callable on every registered adapter`. Evidence: `deno run -A scripts/check.ts`.)*
- [x] **Gap 2** — SRS FR-L39 gets one new Acceptance bullet for `capabilitiesFor("acp")`; SDS §3.3 lists the method on the `RuntimeAdapter` summary. *(FR-L39. Test: `grep -n "capabilitiesFor" documents/requirements.md documents/design.md`. Evidence: `manual — korchasa`.)*
- [x] **SRS back-pointers (FR-DOC-TASK-LINK).** Surgical `**Tasks:**` insert/extend under FR-L23 and FR-L39 in `documents/requirements.md` linking to this task. Other SRS lines stay byte-identical. *(FR-L23 + FR-L39. Test: `grep -c "acp-surface-parity" documents/requirements.md` returns 2. Evidence: `manual — korchasa`.)*
- [x] **`deno task check` green** (fmt, lint, type check, full test suite, doc-lint, `deno publish --dry-run`). *(FR-L23 + FR-L39. Test: implicit — gates the entire pipeline. Evidence: `deno run -A scripts/check.ts`.)*

## Solution

Two commits, each closing one gap end-to-end (RED → GREEN → REFACTOR → CHECK).

### Step 0 — Baseline gate

`deno task check` must be green on the parent revision. If red, stop and report.

### Step 1 — Gap 1 RED: ACP extractor unit tests

Create `runtime/acp/content.ts` with the signature
`extractAcpContent(runtime: RuntimeId, type: string, raw: Record<string, unknown>): NormalizedContent[]`.
Initial implementation: `return [];` (deliberate red).

Create `runtime/acp/content_test.ts` with per-pilot fixtures:

- claude / `session/update` agent_message_chunk → `[{kind:"text", text:"ok", cumulative:false}]`.
- codex / same shape → same.
- opencode / same shape → same.
- claude / `session/update` tool_call_update with `toolCallId`, `title`, `kind`, `rawInput` → `[{kind:"tool", id, name, input}]`.
- All / unknown `sessionUpdate` → `[]`.
- All / synthetic `SYNTHETIC_TURN_END` → `[]` (dispatcher short-circuits on `event.synthetic`).

Test data sourced from PoC `runtime/acp/mapping_test.ts` synthetic shapes plus wire captures documented in `acp-transport-poc.md#empirical-fixes`.

Run `deno test -A --no-check runtime/acp/content_test.ts` — expect failures.

### Step 2 — Gap 1 GREEN: implement `extractAcpContent`

Lift and generalize the projection logic from `runtime/acp/adapter.ts:extractAgentChunkText`.

**Code-comment requirement (from critique #9):** the new `extractAcpContent` and the legacy private `extractAgentChunkText` will coexist temporarily. The private projection feeds `result.output.result` inside `invokeViaAcp`; the public one feeds `extractSessionContent` consumers. Both reference the same wire shape. Add a one-line comment above `extractAgentChunkText` linking to `runtime/acp/content.ts` and listing the dedup as a follow-up so the parallel projection is intentional, not accidental.

Sketch:

```ts
// runtime/acp/content.ts
export function extractAcpContent(
  _runtime: RuntimeId,
  type: string,
  raw: Record<string, unknown>,
): NormalizedContent[] {
  if (type !== "session/update") return [];
  const update = (raw["update"] as Record<string, unknown>) ?? raw;
  const variant = update["sessionUpdate"];
  if (variant === "agent_message_chunk") {
    const content = update["content"] as Record<string, unknown>;
    if (content?.["type"] !== "text") return [];
    const text = content["text"];
    return typeof text === "string"
      ? [{ kind: "text", text, cumulative: false }]
      : [];
  }
  if (variant === "tool_call_update") {
    const id = update["toolCallId"];
    if (typeof id !== "string") return [];
    const name = (update["title"] ?? update["kind"]) as string;
    const input = update["rawInput"] as Record<string, unknown>;
    return [{ kind: "tool", id, name, ...(input ? { input } : {}) }];
  }
  return [];
}
```

Wire dispatcher detection in `runtime/content.ts` BEFORE the per-CLI switch:

```ts
export function extractSessionContent(
  event: RuntimeSessionEvent,
): NormalizedContent[] {
  if (event.synthetic) return [];
  if (isAcpShapedEvent(event)) {
    return extractAcpContent(event.runtime, event.type, event.raw);
  }
  switch (event.runtime) { /* existing arms unchanged */ }
}

function isAcpShapedEvent(event: RuntimeSessionEvent): boolean {
  // Primary signal: PoC's mapSessionUpdate stores the JSON-RPC method
  // verbatim in `event.type`. Defensive fallback: nested wrapper that
  // future ACP fronts may emit without the method-name prefix. Order
  // matters — the type check is the authoritative one.
  if (event.type === "session/update") return true;
  const update = event.raw?.["update"];
  return typeof (update as Record<string, unknown>)?.["sessionUpdate"] === "string";
}
```

Error-handling strategy: extractor is pure, returns `[]` on any malformed payload (no throws — mirrors every per-CLI extractor's contract). The dispatcher inherits the same contract; existing tests for per-CLI extractors stay green because CLI-shaped events lack `update.sessionUpdate` markers.

Surface in `runtime/CLAUDE.md` "Normalized content extraction" — one new bullet under "Per-runtime source events":

> - **ACP transport** (any pilot): `session/update` with `update.sessionUpdate === "agent_message_chunk"` → cumulative-false text; with `tool_call_update` → tool content. Dispatcher detects via `event.type === "session/update"` or `raw.update.sessionUpdate` string presence.

Commit: `feat(runtime): normalize ACP session/update content (FR-L23)`.

### Step 3 — Gap 2 RED: `capabilitiesFor` contract tests

Create `runtime/transport_capabilities_test.ts` parametrised over the four registered adapters:

- For each `RuntimeId` in `["claude", "opencode", "codex"]`:
  - `adapter.capabilitiesFor("cli")` returns `adapter.capabilities` byte-for-byte.
  - `adapter.capabilitiesFor("acp")` returns the downgraded struct.
- Cursor: `adapter.capabilitiesFor("acp")` throws with "not piloted yet" message; `"cli"` returns CLI capabilities unchanged.
- `adapter.capabilitiesFor("sdk")` delegates to `adapter.capabilities` (FR-L38 owns its own surface — out of scope here).

Run `deno test -A --no-check runtime/transport_capabilities_test.ts` — expect TypeScript-level failure (method not on interface).

### Step 4 — Gap 2 GREEN: implement `capabilitiesFor`

Add the optional method to `RuntimeAdapter` in `runtime/adapter-types.ts`:

```ts
/**
 * Return capabilities scoped to a specific transport. Defaults to
 * `capabilities` (the CLI baseline). Adapters that pilot a non-CLI
 * transport (FR-L39) override to reflect which CLI capabilities
 * round-trip under the chosen transport.
 */
capabilitiesFor?(transport: TransportOption): RuntimeCapabilities;
```

Implement on each pilot adapter as a per-runtime lookup constant:

```ts
// runtime/claude-adapter.ts
const CLAUDE_ACP_CAPABILITIES: RuntimeCapabilities = {
  permissionMode: true,        // session/set_mode
  transcript: false,           // no exported transcript
  interactive: false,          // no TUI passthrough
  toolUseObservation: true,    // session/request_permission
  session: true,               // openSessionViaAcp
  capabilityInventory: false,  // fetchCapabilitiesSlow unwired on ACP
  toolFilter: false,           // no client-side tool-policy
  reasoningEffort: true,       // session/set_config_option:thought_level
  mcpInjection: true,          // session/new.mcpServers[]
  sessionFidelity: "native",
};

capabilitiesFor(transport: TransportOption): RuntimeCapabilities {
  if (transport === "acp") return CLAUDE_ACP_CAPABILITIES;
  return this.capabilities;
}
```

Codex / OpenCode adapters: structurally identical, separate constant per adapter (no premature hoist — variances may surface during implementation, especially around `permissionMode` mode declarations).

Cursor adapter:

```ts
capabilitiesFor(transport: TransportOption): RuntimeCapabilities {
  if (transport === "acp") {
    throw new Error(
      `acp transport: cursor front is not piloted yet (FR-L39). ` +
      `Promote it in runtime/acp/fronts.ts after empirical validation.`,
    );
  }
  return this.capabilities;
}
```

Surface in SRS — append one Acceptance bullet to FR-L39:

> - [x] `RuntimeAdapter.capabilitiesFor("acp")` returns the transport-scoped capability struct for every piloted runtime (claude, codex, opencode); non-piloted (cursor) throws. Test: `runtime/transport_capabilities_test.ts`.

Surface in SDS §3.3: one line under `RuntimeAdapter` listing `capabilitiesFor?(transport): RuntimeCapabilities`.

Commit: `feat(runtime): transport-aware capabilities for ACP (FR-L39)`.

### Step 5 — Final CHECK

`deno run -A scripts/check.ts` — full pipeline including `deno publish --dry-run`. JSR slow-types tend to fire when adding optional methods to exported interfaces (the `TransportOption` reference must be re-exported from `mod.ts`; verify before committing).

### Files to create

- `runtime/acp/content.ts`
- `runtime/acp/content_test.ts`
- `runtime/transport_capabilities_test.ts`
- `runtime/adapter-types_test.ts` (type-level signature smoke; create only if no existing file covers it)

### Files to modify

- `runtime/content.ts` — add ACP detection branch.
- `runtime/adapter-types.ts` — add optional `capabilitiesFor` on `RuntimeAdapter`.
- `runtime/claude-adapter.ts` / `opencode-adapter.ts` / `codex-adapter.ts` / `cursor-adapter.ts` — implement `capabilitiesFor`.
- `runtime/CLAUDE.md` — surgical bullet under "Normalized content extraction".
- `documents/requirements.md` — surgical `**Tasks:**` back-pointer + new Acceptance bullets on FR-L23 and FR-L39.
- `documents/design.md` — surgical update under §3.3 `runtime/` description.
- `documents/index.md` — verify FR-L23 / FR-L39 rows (already exist; update summary only if stale).

### Files NOT to touch

- Per-runtime subtrees (`claude/`, `opencode/`, `cursor/`, `codex/`) — extractor changes live in `runtime/acp/` only; per-CLI `<runtime>/content.ts` stays byte-identical.
- `runtime/acp/adapter.ts` — `extractAgentChunkText` stays unchanged (private projection still feeds `collectedText`); deduplication with the public extractor is a non-blocking follow-up, not in scope.
- `mod.ts` — every type involved is already re-exported (verify with `deno publish --dry-run`).

### Risks (named, with mitigations)

- **Detection rule false positive.** A future per-CLI runtime that legitimately uses `update.sessionUpdate` as a key (very unlikely — string-literal collision) would be misrouted. Mitigation: the `event.type === "session/update"` check is the primary signal; the `raw.update.sessionUpdate` check is a defensive fallback for stubs / future ACP fronts that drop the method-name wrapper. Document the precedence in `runtime/CLAUDE.md`.
- **`capabilitiesFor` evolves into a full transport-axis rewrite.** Resist. Scope is exposing one optional method with a lookup table per pilot. FR-L38 (Codex SDK transport) will follow the same pattern when it lands.
- **Per-pilot ACP capability struct divergence.** The first empirical pass for each pilot may surface that e.g. `permissionMode` declared modes differ enough that a single shared `ACP_CAPABILITIES` constant would lie. If so, keep per-adapter — three nine-field structs is fine, premature hoisting would obscure the wire reality.

## Follow-ups

- Sibling task `acp-reliability-parity.md` closes Gap 3 (`runtime_error` analysis for ACP failure surfaces) + Gap 4 (retry loop in `invokeViaAcp`). Either task can land first — no code-level dependency between them. Default order: surface-parity first because the review surface is smaller.
- Deduplicate `extractAgentChunkText` (private in `invokeViaAcp`) with the new public `extractAcpContent` once both are stable. Non-blocking REFACTOR — defer until at least one consumer migrates off the private projection.
- Real-binary e2e assertion that `extractSessionContent(event)` returns non-empty during an ACP turn (deferred from critique #7). Stub coverage gives the contract guarantee; real-binary smoke is nice-to-have. Schedule after Gap 1 lands.
