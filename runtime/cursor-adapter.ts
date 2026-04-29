import { invokeCursorCli } from "../cursor/process.ts";
import {
  type CursorStreamEvent,
  openCursorSession,
} from "../cursor/session.ts";
import type {
  InteractiveResult,
  RuntimeAdapter,
  RuntimeInvokeOptions,
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
} from "./types.ts";
import { adaptEventCallback, adaptRuntimeSession } from "./session-adapter.ts";
import {
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";
import { validateToolFilter } from "./tool-filter.ts";
import { validateReasoningEffort } from "./reasoning-effort.ts";

// FR-L24: see runtime/opencode-adapter.ts for the shared rationale.
let warnedToolFilter = false;

function warnToolFilterOnce(
  opts: Pick<RuntimeInvokeOptions, "allowedTools" | "disallowedTools">,
): void {
  if (warnedToolFilter) return;
  if (opts.allowedTools === undefined && opts.disallowedTools === undefined) {
    return;
  }
  warnedToolFilter = true;
  console.warn(
    "[cursor] allowedTools/disallowedTools ignored — runtime does not support tool filtering (capabilities.toolFilter === false). See FR-L24.",
  );
}

/**
 * Test-only: reset the one-time warning latch.
 *
 * @internal
 */
export function _resetToolFilterWarning(): void {
  warnedToolFilter = false;
}

// FR-L25: Cursor CLI has no native reasoning-effort control. The typed
// field is accepted for uniformity (YAML consumers can target any runtime
// with the same config) but silently ignored; warn once per process.
let warnedReasoningEffort = false;

function warnReasoningEffortOnce(value: unknown): void {
  if (warnedReasoningEffort) return;
  if (value === undefined) return;
  warnedReasoningEffort = true;
  console.warn(
    "[cursor] reasoningEffort ignored — runtime does not support reasoning-effort control (capabilities.reasoningEffort === false). See FR-L25.",
  );
}

/**
 * Test-only: reset the one-time reasoning-effort warning latch.
 *
 * @internal
 */
export function _resetReasoningEffortWarning(): void {
  warnedReasoningEffort = false;
}

function cursorEventToRuntime(event: CursorStreamEvent): RuntimeSessionEvent {
  const raw = event as Record<string, unknown>;
  const typeField = raw["type"];
  return {
    runtime: "cursor",
    type: typeof typeField === "string" ? typeField : "unknown",
    raw,
  };
}

/**
 * Cursor emulates streaming by spawning a fresh `cursor agent -p --resume`
 * subprocess per send. Each subprocess terminates its stream-json output
 * with a `result` event — one per completed turn. Drives the neutral
 * {@link SYNTHETIC_TURN_END} emission. Synthetic errors from failed
 * subprocesses carry `type: "error"` and do not trip the turn-end check.
 */
function isCursorTurnEnd(event: CursorStreamEvent): boolean {
  return event?.type === "result";
}

export const cursorRuntimeAdapter: RuntimeAdapter = {
  id: "cursor",
  capabilities: {
    permissionMode: false,
    // Unsupported by design: Cursor reads `mcp.json` only from `~/.cursor/`
    // or `<workspace>/.cursor/` (the latter `chdir`s the agent), with no
    // per-invocation config flag. Delivering HITL would require mutating
    // user data or staging a sandbox workspace — both forbidden by root
    // AGENTS.md. See `cursor/AGENTS.md` for the full rationale.
    hitl: false,
    transcript: false,
    interactive: false,
    // FR-L30: Cursor's stream-json emits `tool_call/started` events,
    // surfaced via `onToolUseObserved` in `cursor/process.ts`.
    toolUseObservation: true,
    session: true,
    capabilityInventory: true,
    toolFilter: false,
    reasoningEffort: false,
  },
  invoke(opts) {
    validateToolFilter("cursor", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("cursor", opts);
    warnReasoningEffortOnce(opts.reasoningEffort);
    return invokeCursorCli(opts);
  },

  fetchCapabilitiesSlow(
    opts?: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    return fetchInventoryViaInvoke(
      "cursor",
      (inner) => this.invoke(inner),
      opts,
    );
  },

  async openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    validateToolFilter("cursor", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("cursor", opts);
    warnReasoningEffortOnce(opts.reasoningEffort);
    const inner = await openCursorSession({
      systemPrompt: opts.systemPrompt,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      cursorArgs: opts.extraArgs,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      onEvent: adaptEventCallback(
        opts.onEvent,
        cursorEventToRuntime,
        isCursorTurnEnd,
      ),
      onStderr: opts.onStderr,
      processRegistry: opts.processRegistry,
    });
    return adaptRuntimeSession(
      "cursor",
      inner,
      cursorEventToRuntime,
      isCursorTurnEnd,
    );
  },

  launchInteractive(): Promise<InteractiveResult> {
    throw new Error(
      "Cursor has no interactive CLI mode — use Cursor IDE directly",
    );
  },
};
